// Suíte de limites (A16 e borda HTTP) contra o container real: token, corpo e cabeçalho recusados na borda; memória (WASM, numpy e
// ataque por ArrayBuffer fora do WASM) e tempo (laço infinito, laço que tenta engolir a interrupção e chamada C longa) encerram só a
// chamada, com o código certo, e o serviço segue atendendo; a terceira chamada simultânea espera vaga; cancelar encerra o processo na
// hora, executando ou esperando.
import { request as httpRequest } from 'node:http';
import { beforeEach, describe, expect, it } from 'vitest';
import { LIMITS, encodeFrame } from '../src/protocol.js';
import { asRun, health, postRun, runPython, sandboxToken, sandboxUrl, waitHealth } from './client.js';

/**
 * Envia um corpo acima do limite em pedaços de 1 MiB até a resposta chegar e devolve o status. Com `declared`, o Content-Length já
 * anuncia o excesso (o servidor recusa antes de ler); sem ele, o corpo vai em chunked e a recusa vem ao passar de 60 MiB lidos.
 */
function oversizedUpload(declared: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const total = LIMITS.requestMaxBytes + 1024 * 1024;
    const headers: Record<string, string> = { authorization: `Bearer ${sandboxToken}` };
    if (declared) headers['content-length'] = String(total);
    const request = httpRequest(`${sandboxUrl}/run`, { method: 'POST', headers });
    let answered = false;
    request.on('response', (response) => {
      answered = true;
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on('error', (error) => {
      if (!answered) reject(error);
    });
    const chunk = Buffer.alloc(1024 * 1024);
    let sent = 0;
    const pump = (): void => {
      while (!answered && sent < total) {
        sent += chunk.length;
        if (!request.write(chunk)) return void request.once('drain', pump);
      }
      if (!answered) request.end();
    };
    pump();
  });
}

/** Confirma que o serviço continua de pé e executando depois de uma chamada encerrada à força. */
async function expectServiceAlive(): Promise<void> {
  await waitHealth((body) => body.ready === 2);
  const result = asRun(await runPython('print(6 * 7)'));
  expect(result.outcome).toBe('ok');
  expect(result.output.trim()).toBe('42');
}

describe('borda HTTP do sandbox', () => {
  it('recusa pedido sem token, com token errado do mesmo tamanho e com token curto', async () => {
    const wrong = sandboxToken.replace(/.$/, (last) => (last === 'a' ? 'b' : 'a'));
    for (const token of ['', wrong, 'curto']) {
      const run = await runPython('print(1)', [], { token });
      expect(run.status).toBe(401);
      expect((run as { code: string }).code).toBe('SANDBOX_UNAUTHORIZED');
      expect((await health(token)).status).toBe(401);
    }
    const anonymous = await fetch(`${sandboxUrl}/health`);
    expect(anonymous.status).toBe(401);
  });

  it('recusa corpo acima de 60 MiB, declarado no Content-Length ou enviado em pedaços', async () => {
    expect(await oversizedUpload(true)).toBe(413);
    expect(await oversizedUpload(false)).toBe(413);
  });

  it('recusa cabeçalho com campo extra, código longo, arquivos demais, nome inseguro e bytes divergentes', async () => {
    const bad = [
      encodeFrame({ code: 'print(1)', files: [], extra: true }, []),
      encodeFrame({ code: 'x'.repeat(LIMITS.codeMaxChars + 1), files: [] }, []),
      encodeFrame({ code: 'print(1)', files: Array.from({ length: 6 }, (_, i) => ({ name: `a${i}.txt`, size: 0 })) }, []),
      encodeFrame({ code: 'print(1)', files: [{ name: '../fuga.txt', size: 1 }] }, [Buffer.from('x')]),
      encodeFrame({ code: 'print(1)', files: [{ name: 'a.txt', size: 1 }, { name: 'a.txt', size: 1 }] }, [Buffer.from('xy')]),
      encodeFrame({ code: 'print(1)', files: [{ name: 'a.txt', size: 5 }] }, [Buffer.from('x')]),
      Buffer.from('não é um quadro'),
    ];
    for (const body of bad) {
      const response = await postRun(body);
      expect(response.status).toBe(400);
      expect((response as { code: string }).code).toBe('SANDBOX_INPUT_INVALID');
    }
  });
});

describe('limites de memória (512 MB por chamada)', () => {
  beforeEach(async () => {
    await waitHealth((body) => body.ready === 2);
  });

  it('alocação grande no Python esbarra na trava de crescimento do WASM', async () => {
    const result = asRun(await runPython('x = bytearray(700 * 1024 * 1024)\nprint(len(x))'));
    expect(result.outcome).toBe('PYTHON_MEMORY_LIMIT');
    await expectServiceAlive();
  });

  it('array numpy acima do limite também', async () => {
    const result = asRun(await runPython('import numpy as np\na = np.ones((1024, 1024, 90))\nprint(a.nbytes)'));
    expect(result.outcome).toBe('PYTHON_MEMORY_LIMIT');
  });

  it('uso dentro do limite continua permitido', async () => {
    const result = asRun(await runPython('x = bytearray(300 * 1024 * 1024)\nprint(len(x) // (1024 * 1024))'));
    expect(result.outcome).toBe('ok');
    expect(result.output.trim()).toBe('300');
  });

  it('ataque por ArrayBuffer fora do WASM (arquivos em memória) é encerrado pela vigilância de memória', async () => {
    const result = asRun(await runPython(
      'chunk = b"x" * (32 * 1024 * 1024)\nfor i in range(400):\n    with open(f"/tmp/f{i}", "wb") as f:\n        f.write(chunk)\nprint("escreveu tudo")',
    ));
    expect(result.outcome).toBe('PYTHON_MEMORY_LIMIT');
    expect(result.output).not.toContain('escreveu tudo');
    await expectServiceAlive();
  });

  it('ataque por ArrayBuffer com objetos JavaScript criados pelo Python é encerrado', async () => {
    const result = asRun(await runPython(
      'import sys\ncore = sys.modules["_pyodide_core"]\nkeep = []\nblock = bytes(64 * 1024 * 1024)\nfor i in range(200):\n    keep.append(core.to_js(block))\nprint("alocou tudo")',
    ));
    expect(result.outcome).toBe('PYTHON_MEMORY_LIMIT');
    expect(result.output).not.toContain('alocou tudo');
    await expectServiceAlive();
  });
});

describe('limites de tempo, fila e cancelamento', () => {
  beforeEach(async () => {
    await waitHealth((body) => body.ready === 2);
  });

  it('laço infinito para por interrupção no prazo, engolir a interrupção não adianta e código C longo morre 1 s depois', async () => {
    // Três desfechos de tempo, rodando juntos (o terceiro espera vaga; `durationMs` só conta a execução):
    // - laço simples: para pela interrupção cooperativa, entre 60 s e 61 s;
    // - laço que tenta engolir a interrupção: depois do prazo a interrupção se repete a cada checagem do interpretador e acaba levantada
    //   fora do `try` (no salto do laço externo), então ele também para de forma cooperativa antes de 61 s;
    // - multiplicação de matrizes 5000 x 5000 (minutos de BLAS em WebAssembly, 400 MB): uma única chamada em C que não confere
    //   interrupção; só o encerramento forçado do pai a para, em 61 s.
    const [plain, swallowing, nativeCall] = await Promise.all([
      runPython('while True:\n    pass'),
      runPython('while True:\n    try:\n        while True:\n            pass\n    except BaseException:\n        pass'),
      runPython('import numpy as np\na = np.ones((5000, 5000))\na @ a\nprint("terminou")'),
    ]);
    for (const response of [plain, swallowing]) {
      const cooperative = asRun(response);
      expect(cooperative.outcome).toBe('PYTHON_TIMEOUT');
      expect(cooperative.durationMs).toBeGreaterThanOrEqual(LIMITS.runTimeoutMs);
      expect(cooperative.durationMs).toBeLessThan(LIMITS.runTimeoutMs + LIMITS.killGraceMs);
    }
    const forced = asRun(nativeCall);
    expect(forced.output).not.toContain('terminou');
    expect(forced.outcome).toBe('PYTHON_TIMEOUT');
    expect(forced.durationMs).toBeGreaterThanOrEqual(LIMITS.runTimeoutMs + LIMITS.killGraceMs);
    expect(forced.durationMs).toBeLessThan(LIMITS.runTimeoutMs + LIMITS.killGraceMs + 1_000);
    await expectServiceAlive();
  });

  it('a terceira chamada simultânea espera vaga e termina depois das duas primeiras', async () => {
    // A terceira só sai depois que as duas primeiras ocuparam as vagas (observado na saúde): disparadas juntas, a ordem de chegada ao
    // servidor não segue o índice e qualquer uma das três podia ser a que espera.
    const finished: number[] = [];
    const call = async (index: number): Promise<ReturnType<typeof asRun>> => {
      const result = asRun(await runPython('import time\ntime.sleep(4)\nprint("pronto")'));
      finished[index] = Date.now();
      return result;
    };
    const first = [call(0), call(1)];
    await waitHealth((body) => body.busy === 2, 10_000);
    const third = call(2);
    const during = await waitHealth((body) => body.busy === 2 && body.waiting === 1, 10_000);
    expect(during).toMatchObject({ busy: 2, waiting: 1 });
    const results = await Promise.all([...first, third]);
    for (const result of results) expect(result.outcome).toBe('ok');
    expect(Math.min(...finished.slice(0, 2)) + 2_000).toBeLessThan(finished[2] as number);
  });

  it('cancelar durante a execução mata o processo na hora e libera a vaga', async () => {
    const controller = new AbortController();
    const call = runPython('while True:\n    pass', [], { signal: controller.signal }).catch((error: unknown) => error);
    await waitHealth((body) => body.busy === 1, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const abortedAt = Date.now();
    controller.abort();
    expect(await call).toBeInstanceOf(Error);
    await waitHealth((body) => body.busy === 0, 1_000);
    expect(Date.now() - abortedAt).toBeLessThan(1_000);
    await expectServiceAlive();
  });

  it('cancelar enquanto espera vaga tira o pedido da fila', async () => {
    const busy = [0, 1].map(() => runPython('import time\ntime.sleep(5)'));
    await waitHealth((body) => body.busy === 2, 10_000);
    const controller = new AbortController();
    const waiting = runPython('print("nunca")', [], { signal: controller.signal }).catch((error: unknown) => error);
    await waitHealth((body) => body.waiting === 1, 5_000);
    controller.abort();
    expect(await waiting).toBeInstanceOf(Error);
    await waitHealth((body) => body.waiting === 0, 1_000);
    for (const result of await Promise.all(busy)) expect(asRun(result).outcome).toBe('ok');
  });
});

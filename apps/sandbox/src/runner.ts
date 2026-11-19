// Processo filho do sandbox: carrega o Pyodide com os pacotes embutidos, endurece o realm JavaScript, confere o próprio isolamento e
// executa UMA chamada de Python; depois o servidor o descarta (CODE-02).
//
// Camadas de isolamento (spec, Suposição 22):
// (a) permissões do Node (`--permission`, leitura só da pasta do runtime, sem escrita, rede, processo, worker, addon, WASI nem
//     inspetor) e `--disallow-code-generation-from-strings`: impostas pelo pai ao criar este processo (pool.ts) e conferidas aqui no
//     autoteste, que recusa ficar pronto se faltar alguma (falha fechada);
// (b) endurecimento do realm, feito aqui depois da carga: globais de rede, processo e buffer removidos (o `fetch` vira um bloqueio
//     instrumentado que conta tentativas), ponte `js` vazia e módulos `js`/`pyodide_js` desregistrados, importação de módulos
//     JavaScript travada por gancho de resolução, `Error.prepareStackTrace` travado, API do Pyodide que carrega pacote, monta disco ou
//     roda código desligada e sistemas de arquivos do host removidos;
// (c) ambiente de variáveis vazio: imposto pelo pai (sem o canal `ipc` do Node, que poria NODE_CHANNEL_* no ambiente inicial do
//     processo; o canal é o fd 3 de protocol.ts) e conferido aqui.
// Limites próprios deste arquivo: trava de crescimento da memória WebAssembly (512 MiB por chamada) e interrupção cooperativa no prazo
// (KeyboardInterrupt); o encerramento forçado e a vigilância de memória residente ficam no pai, porque não dependem deste processo.
import { createReadStream, constants as fsConstants, writeSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { loadPyodide, type PyodideAPI } from 'pyodide';
import {
  IPC_FD, IPC_TO_CHILD_MAX_BYTES, IpcDecoder, LIMITS, encodeIpc, isSafeFileName, type IpcChildMessage, type IpcRunMessage, type RunOutcome,
} from './protocol.js';

// --- Referências capturadas antes do endurecimento ---
// O global `process` é removido no endurecimento; o IPC com o pai continua por esta referência, que o Python não alcança.
const proc = process;
const RUNTIME_DIR = path.dirname(fileURLToPath(import.meta.url));
const PYODIDE_DIR = path.join(RUNTIME_DIR, 'node_modules', 'pyodide') + path.sep;
const WHEELS_DIR = path.join(RUNTIME_DIR, 'wheels') + path.sep;
/** Pacotes carregados no aquecimento; sqlite3 é da biblioteca padrão e não precisa de carga. */
const PACKAGES = ['numpy', 'scipy', 'pandas', 'matplotlib', 'openpyxl'];
/** Globais removidos no endurecimento: rede, processo, buffer e o `require` que o Pyodide cria no Node (expõe fs e child_process). */
const REMOVED_GLOBALS = [
  'process', 'require', 'module', 'global', 'Buffer', 'WebSocket', 'EventSource', 'XMLHttpRequest',
  'Request', 'Response', 'Headers', 'FormData', 'loadPyodide',
];
/** Módulos Python que dão acesso ao lado JavaScript, à rede ou à instalação de pacotes; a importação deles é recusada. */
const BLOCKED_PY_MODULES = ['js', 'pyodide_js', 'pyodide.http', 'pyodide.code', 'pyodide.ffi', 'pyodide.webloop', 'micropip', 'pyodide_http'];

// --- Canal com o pai (fd 3, protocol.ts) ---
// Não é o canal `ipc` do Node, que exigiria variáveis de ambiente no processo (camada c). O fd 3 é um socket herdado e bloqueante:
// a escrita síncrona entrega o quadro inteiro antes de seguir, e a leitura vai pela fila de fs do Node (`net.Socket` sobre o fd é
// negado pelo `--permission`, que bloqueia rede). As referências ficam neste escopo de módulo, fora do alcance do Python.

/** Envia ao pai; a falha de escrita (pai já foi embora) encerra o processo, que não tem mais função. */
function send(message: IpcChildMessage): void {
  const frame = encodeIpc(message);
  try {
    let written = 0;
    while (written < frame.length) written += writeSync(IPC_FD, frame, written);
  } catch {
    proc.exit(1);
  }
}

/** Escuta o pai: cada quadro completo vai para `onMessage`; fim do canal (pai encerrado) ou quadro inválido encerram o processo. */
function listen(onMessage: (message: unknown) => void): void {
  const decoder = new IpcDecoder(IPC_TO_CHILD_MAX_BYTES);
  // O caminho é ignorado quando `fd` é dado; `autoClose: false` mantém o fd para as escritas de `send`.
  const channel = createReadStream(null as unknown as string, { fd: IPC_FD, autoClose: false });
  channel.on('data', (chunk) => {
    try {
      for (const message of decoder.push(chunk as Buffer)) onMessage(message);
    } catch {
      proc.exit(1);
    }
  });
  channel.on('end', () => proc.exit(0));
  channel.on('error', () => proc.exit(1));
}

// --- process.binding para a carga do Emscripten ---
// Com `--permission`, `process.binding` é negado; o NODEFS do Emscripten só o usa na carga para ler as constantes de flags de arquivo.
// Este substituto entrega só essas constantes (sem acesso a nada) e some com o `process` no endurecimento; o NODEFS é removido depois.
Object.defineProperty(proc, 'binding', {
  value: (name: string) => {
    if (name === 'constants') return { fs: fsConstants };
    throw new Error('process.binding bloqueado no sandbox');
  },
  configurable: true,
});

// --- Trava de importação (camada b) ---
// Gancho síncrono de resolução: depois do aquecimento, nenhum módulo novo (node:fs, node:net, ws, arquivo local) pode ser carregado,
// nem por `import()` dinâmico nem por `require`. O Pyodide importa o que precisa durante a carga, antes da trava.
let importsLocked = false;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (importsLocked) throw new Error('importação bloqueada no sandbox');
    return nextResolve(specifier, context);
  },
});

// --- Trava de crescimento da memória WebAssembly ---
// O Emscripten do Pyodide cresce a memória pelo `WebAssembly.Memory.prototype.grow` (via `emscripten_resize_heap`). Acima do teto, o
// crescimento é recusado e o malloc falha, o que vira MemoryError no Python. O teto é fixado no início da chamada (tamanho atual +
// 512 MiB); no aquecimento ele não existe (código confiável).
const WASM_PAGE = 65_536;
let growthCeilingBytes = Number.POSITIVE_INFINITY;
let growthRefused = false;
// Os tipos do Node não descrevem `WebAssembly.Memory` sem a lib DOM; esta é a forma mínima usada aqui.
interface WasmMemory {
  readonly buffer: ArrayBuffer;
  grow(delta: number): number;
}
const memoryPrototype = (globalThis as unknown as { WebAssembly: { Memory: { prototype: WasmMemory } } }).WebAssembly.Memory.prototype;
const originalGrow = memoryPrototype.grow;
Object.defineProperty(memoryPrototype, 'grow', {
  value: function grow(this: WasmMemory, delta: number): number {
    if (this.buffer.byteLength + delta * WASM_PAGE > growthCeilingBytes) {
      growthRefused = true;
      throw new RangeError('limite de memória do sandbox');
    }
    return originalGrow.call(this, delta);
  },
  writable: false,
  configurable: false,
});

// --- fetch instrumentado (A14) ---
// Conta toda tentativa e sempre recusa. Fica no lugar do `fetch` real da carga até o fim do processo; o total vai ao pai no "pronto" e
// no resultado, e precisa ser zero no roteiro normal.
let networkCalls = 0;
const blockedFetch = function fetch(): Promise<never> {
  networkCalls += 1;
  return Promise.reject(new TypeError('rede bloqueada no sandbox'));
};
Object.defineProperty(globalThis, 'fetch', { value: blockedFetch, writable: false, configurable: false });

// --- Prazo cooperativo ---
// O CPython do Pyodide lê `Py_EmscriptenSignalBuffer[0]` periodicamente entre bytecodes. Em vez de um buffer compartilhado (que exigiria
// outra thread, proibida aqui), o "buffer" é um objeto cujo índice 0 devolve SIGINT (2) depois do prazo: o Python recebe
// KeyboardInterrupt sem depender de timer. Como a interrupção se repete a cada checagem, um `try/except` (ou tratador de SIGINT) não a
// segura; o que escapa dela é código C longo que não volta ao interpretador (ex.: BLAS), e esse o pai encerra 1 s depois.
const SIGINT = 2;
let deadline = Number.POSITIVE_INFINITY;
const interruptSignal = {
  get 0(): number {
    return performance.now() >= deadline ? SIGINT : 0;
  },
  set 0(_value: number) {
    // A escrita de limpeza do CPython é ignorada: depois do prazo a interrupção se repete até o código parar.
  },
};

// --- Coleta da saída do Python ---
// Saída padrão e de erro juntas, cortadas no limite; fora de uma chamada (aquecimento) tudo é descartado.
let collecting = false;
let output = '';
let outputTruncated = false;
function sink(decoder: TextDecoder): { write: (buffer: Uint8Array) => number } {
  return {
    write(buffer: Uint8Array): number {
      if (collecting && !outputTruncated) {
        output += decoder.decode(buffer, { stream: true });
        if (output.length > LIMITS.outputMaxChars) {
          output = output.slice(0, LIMITS.outputMaxChars);
          outputTruncated = true;
        }
      }
      return buffer.length;
    },
  };
}

// --- Código Python do aquecimento e do executor ---
// Pré-importa os pacotes (o tempo de carga não conta no prazo da chamada), cria /data e /out e devolve a função que executa o código
// do usuário num namespace limpo, com /out como diretório atual, devolvendo (tipo, traceback) sem o quadro deste executor.
const PY_WARMUP = `
import os, sys, traceback
import numpy, pandas, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot, openpyxl, sqlite3
os.makedirs("/data", exist_ok=True)
os.makedirs("/out", exist_ok=True)

def _aion_format(exc):
    tb = exc.__traceback__.tb_next if exc.__traceback__ is not None else None
    return "".join(traceback.format_exception(type(exc), exc, tb))

def _aion_run(code):
    os.chdir("/out")
    namespace = {"__name__": "__main__", "__builtins__": __builtins__}
    try:
        exec(compile(code, "<python>", "exec"), namespace)
    except SystemExit as exc:
        if exc.code in (None, 0):
            return None
        return ("SystemExit", _aion_format(exc))
    except BaseException as exc:
        return (type(exc).__name__, _aion_format(exc))
    return None

_aion_run
`;

// Endurecimento do lado Python: remove dos módulos carregados as pontes para o JavaScript, a rede e a instalação de pacotes e recusa
// importá-las de novo. É uma camada de conveniência (o Python consegue contornar import hooks); as barreiras reais são o realm vazio e
// as permissões do Node, provadas pela suíte de fuga.
const PY_HARDEN = `
import sys

class _AionImportBlock:
    BLOCKED = tuple(${JSON.stringify(BLOCKED_PY_MODULES)})

    @classmethod
    def blocked(cls, name):
        return any(name == b or name.startswith(b + ".") for b in cls.BLOCKED)

    def find_spec(self, name, path=None, target=None):
        if self.blocked(name):
            raise ImportError(f"módulo bloqueado no sandbox: {name}")
        return None

for _name in list(sys.modules):
    if _AionImportBlock.blocked(_name):
        del sys.modules[_name]
sys.meta_path.insert(0, _AionImportBlock())
del _name, _AionImportBlock
`;

/** Autoteste do isolamento: qualquer falha impede o processo de ficar pronto (o pai registra o código e tenta de novo). */
async function selfCheck(pyodide: PyodideAPI): Promise<string | null> {
  const permission = proc.permission;
  if (!permission) return 'permission_model_off';
  const denied: [string, string?][] = [
    ['fs.write'], ['fs.write', RUNTIME_DIR], ['fs.read', '/etc/passwd'], ['fs.read', '/proc/self/environ'], ['net'],
    ['child'], ['worker'], ['wasi'], ['addon'], ['inspector'],
  ];
  for (const [scope, reference] of denied) {
    if (permission.has(scope as never, reference)) return `permission_${scope}`;
  }
  if (!permission.has('fs.read', path.join(PYODIDE_DIR, 'pyodide.mjs'))) return 'permission_runtime_read';
  if (Object.keys(proc.env).length > 0) return 'env_not_empty';
  for (const name of REMOVED_GLOBALS) if (name in globalThis) return `global_${name}`;
  if (globalThis.fetch !== blockedFetch) return 'fetch_not_blocked';
  try {
    (Error as { prepareStackTrace?: unknown }).prepareStackTrace = () => '';
  } catch { /* esperado: propriedade travada */ }
  if ((Error as { prepareStackTrace?: unknown }).prepareStackTrace !== undefined) return 'stack_trace_hook_writable';
  try {
    (0, eval)('1');
    return 'eval_allowed';
  } catch { /* esperado: geração de código bloqueada */ }
  try {
    new Function('return 1')();
    return 'function_allowed';
  } catch { /* esperado */ }
  try {
    await import('node:fs');
    return 'import_allowed';
  } catch { /* esperado: trava de importação */ }
  const pyBridge = pyodide.runPython(`
_found = []
for _m in ("js", "pyodide_js", "pyodide.ffi", "pyodide.http", "micropip"):
    try:
        __import__(_m)
        _found.append(_m)
    except ImportError:
        pass
",".join(_found)
`) as string;
  if (pyBridge) return 'python_bridge_importable';
  return null;
}

/** Desliga um método da API do Pyodide que o código do usuário nunca deve alcançar (defesa em profundidade, caso alcance o objeto). */
function disable(target: object, name: string): void {
  Object.defineProperty(target, name, {
    value: () => {
      throw new Error('operação bloqueada no sandbox');
    },
    writable: false,
    configurable: false,
  });
}

/** Aquece, endurece e confere; devolve o executor Python e o sistema de arquivos em memória, guardados só neste escopo. */
async function warmUp(): Promise<{ run: (code: string) => unknown; pyodide: PyodideAPI }> {
  const pyodide = await loadPyodide({
    indexURL: PYODIDE_DIR,
    lockFileURL: path.join(WHEELS_DIR, 'pyodide-lock.json'),
    packageBaseUrl: WHEELS_DIR,
    // A ponte `js` do Python passa a ser um objeto vazio: mesmo um contorno do bloqueio de importação não alcança os globais.
    jsglobals: Object.freeze(Object.create(null) as object),
    env: { HOME: '/home/pyodide', MPLBACKEND: 'Agg' },
    checkAPIVersion: true,
  });
  pyodide.setStdout(sink(new TextDecoder()));
  pyodide.setStderr(sink(new TextDecoder()));
  await pyodide.loadPackage(PACKAGES, { messageCallback: () => {}, errorCallback: () => {}, checkIntegrity: true });
  const run = pyodide.runPython(PY_WARMUP) as (code: string) => unknown;
  pyodide.setInterruptBuffer(interruptSignal as unknown as Int32Array);

  // Endurecimento (camada b).
  pyodide.unregisterJsModule('js');
  pyodide.unregisterJsModule('pyodide_js');
  pyodide.runPython(PY_HARDEN);
  const filesystems = (pyodide.FS as unknown as { filesystems: Record<string, unknown> }).filesystems;
  for (const name of Object.keys(filesystems)) if (name !== 'MEMFS') delete filesystems[name];
  for (const name of ['loadPackage', 'loadPackagesFromImports', 'mountNodeFS', 'mountNativeFS', 'registerJsModule', 'runPythonAsync',
    'pyimport', 'setStdout', 'setStderr', 'setStdin', 'setInterruptBuffer']) {
    disable(pyodide, name);
  }
  for (const name of REMOVED_GLOBALS) Reflect.deleteProperty(globalThis, name);
  // Captura de pilha travada: com `Error.prepareStackTrace` livre, o Python (que cria objetos JS por `_pyodide_core.to_js`) recebe os
  // CallSites e o `this` dos quadros, que nos quadros WASM é a instância do Pyodide. O V8 passa a usar sempre o formato padrão.
  Object.defineProperty(Error, 'prepareStackTrace', { value: undefined, writable: false, configurable: false });
  importsLocked = true;

  const failure = await selfCheck(pyodide);
  if (failure) throw new SelfCheckError(failure);
  disable(pyodide, 'runPython');
  return { run, pyodide };
}

class SelfCheckError extends Error {}

/** Converte o resultado do executor Python ([tipo, traceback] ou None) para valores JavaScript simples. */
function readPyResult(result: unknown): [string, string] | null {
  if (result === undefined || result === null) return null;
  const proxy = result as { toJs: () => unknown; destroy: () => void };
  const value = proxy.toJs() as [string, string];
  proxy.destroy();
  return [String(value[0]), String(value[1])];
}

/** Lê os arquivos regulares de /out/ dentro do orçamento da resposta; o pai revalida nomes e tamanhos. */
function collectOutputs(pyodide: PyodideAPI): Pick<Extract<IpcChildMessage, { type: 'result' }>, 'files' | 'filesOmitted'> {
  const FS = pyodide.FS;
  // Reserva para o cabeçalho JSON (saída e traceback em UTF-8, lista de arquivos) dentro do limite total da resposta.
  let budget = LIMITS.responseMaxBytes - 256 * 1024;
  const files: Extract<IpcChildMessage, { type: 'result' }>['files'] = [];
  let filesOmitted = 0;
  const names = (FS.readdir('/out') as string[]).filter((name) => name !== '.' && name !== '..').sort();
  for (const name of names) {
    const stat = FS.lstat(`/out/${name}`) as { mode: number; size: number };
    if (!FS.isFile(stat.mode) || !isSafeFileName(name) || files.length >= LIMITS.outputFilesListMax) {
      filesOmitted += 1;
      continue;
    }
    const fits = stat.size <= budget;
    if (fits) budget -= stat.size;
    files.push({ name, size: stat.size, data: fits ? (FS.readFile(`/out/${name}`) as Uint8Array) : null });
  }
  return { files, filesOmitted };
}

/** Executa a chamada: grava /data somente leitura, arma o teto de memória e o prazo, roda o código e classifica o desfecho. */
async function handleRun(message: IpcRunMessage, run: (code: string) => unknown, pyodide: PyodideAPI): Promise<void> {
  const FS = pyodide.FS;
  for (const file of message.files) {
    FS.writeFile(`/data/${file.name}`, file.data);
    FS.chmod(`/data/${file.name}`, 0o444);
  }
  FS.chmod('/data', 0o555);

  const heap = (pyodide as unknown as { _module: { HEAPU8: Uint8Array } })._module.HEAPU8;
  growthCeilingBytes = heap.byteLength + LIMITS.wasmGrowthMaxBytes;
  collecting = true;
  deadline = performance.now() + LIMITS.runTimeoutMs;

  let failure: [string, string] | null = null;
  let internalFailure = false;
  try {
    failure = readPyResult(run(message.code));
  } catch {
    // O executor Python não deixa exceção escapar; chegar aqui é erro fatal do runtime (ex.: malloc falhou dentro de código C).
    internalFailure = true;
  }
  const timedOut = performance.now() >= deadline;
  deadline = Number.POSITIVE_INFINITY;
  collecting = false;

  let outcome: RunOutcome = 'ok';
  let error: string | null = null;
  if (timedOut && (internalFailure || failure !== null)) {
    outcome = 'PYTHON_TIMEOUT';
    error = 'Tempo esgotado (60 s).';
  } else if (failure?.[0] === 'MemoryError' || (growthRefused && (internalFailure || failure !== null))) {
    outcome = 'PYTHON_MEMORY_LIMIT';
    error = 'Memória esgotada (512 MB).';
  } else if (internalFailure) {
    outcome = 'PYTHON_ERROR';
    error = 'O Python sofreu um erro interno e foi encerrado.';
  } else if (failure) {
    outcome = 'PYTHON_ERROR';
    error = failure[1].slice(0, LIMITS.errorMaxChars);
  }
  const outputs = outcome === 'ok' ? collectOutputs(pyodide) : { files: [], filesOmitted: 0 };
  send({ type: 'result', outcome, output, outputTruncated, error, networkCalls, ...outputs });
}

// --- Ciclo de vida: aquecer, avisar "pronto", aceitar um único pedido ---
// Depois do resultado o processo fica parado até o pai o matar (SIGKILL); ele nunca sai sozinho com uma leitura pendente no fd.
try {
  const { run, pyodide } = await warmUp();
  let used = false;
  listen((raw) => {
    const message = raw as IpcRunMessage | null;
    if (used || message?.type !== 'run') return;
    used = true;
    void handleRun(message, run, pyodide);
  });
  send({ type: 'ready', networkCalls });
} catch (error) {
  // O aquecimento não envolve dado do usuário; a mensagem curta só ajuda a diagnosticar a imagem.
  const reason = error instanceof SelfCheckError ? error.message : `warmup_failed: ${String(error).slice(-300)}`;
  send({ type: 'fatal', reason });
  proc.exit(1);
}

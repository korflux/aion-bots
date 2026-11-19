// Cliente do serviço sandbox (phase 4, CODE-01 e CODE-02, Suposição 22b): o ÚNICO caminho do Aion até o Python. Usado pelo worker (ferramenta
// `run_python`) e pela API (conferência de saúde de Configurações → Python). Não existe execução de Python fora do sandbox.
//
// Contrato HTTP (fonte: `apps/sandbox/src/protocol.ts` e `server.ts`, provado contra o container real em `python-sandbox.test.ts`):
// - toda rota exige `Authorization: Bearer <token>`;
// - `GET /health`: 200 com vagas prontas, 503 aquecendo;
// - `POST /run`: corpo e resposta num quadro binário (`uint32 BE` do tamanho do cabeçalho JSON, o cabeçalho e os bytes dos arquivos concatenados,
//   sem base64). O pedido leva `{ code, files: [{ name, size }] }`; a resposta, desfecho, saída, erro, duração e os arquivos de `/out/` (só no
//   desfecho `ok`). Fechar a conexão antes da resposta cancela a espera ou mata o processo do Python na hora ("Parar").
// O codec do quadro é repetido aqui (são poucas linhas) porque o sandbox é um serviço à parte, com imagem própria construída só de `apps/sandbox`:
// importar o código dele faria o worker depender de um app. A compatibilidade é provada pelo teste worker → sandbox real.
//
// Tudo o que volta é dado NÃO CONFIÁVEL (o sandbox executou código do modelo): o cabeçalho é validado por schema estrito, a resposta é lida com
// teto de bytes e os arquivos precisam somar exatamente o que veio. O worker revalida formato e limites de cada arquivo antes de gravar.
//
// Vagas (CODE-02): no máximo 2 chamadas de Python ao mesmo tempo por processo; as demais esperam numa fila FIFO cancelável pelo sinal da execução
// (a espera conta no limite de tempo da execução e "Parar" a interrompe). O prazo do pedido começa só depois da vaga: 60 s do código, 1 s do
// encerramento forçado e folga para transferência e reaquecimento.
// ponytail: as vagas são por processo do worker; com mais de um worker, a fila do próprio sandbox (até 8, depois SANDBOX_BUSY) é quem segura o
//   excesso. Trocar por um semáforo no banco se o worker passar a rodar em mais de uma instância.
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import type { Logger } from '../logging';

const MIB = 1024 * 1024;

/** Limites do lado do worker (os do sandbox são a segunda barreira). */
export const PYTHON_LIMITS = {
  /** Código por chamada, em caracteres (o mesmo do sandbox). */
  codeMaxChars: 20_000,
  /** Anexos de entrada por chamada e bytes somados (Suposição 23). */
  inputFilesMax: 5,
  inputMaxBytes: 50 * MIB,
  /** Saída padrão e de erro juntas devolvidas ao modelo, em caracteres (Suposição 25). */
  outputMaxChars: 20_000,
  /** Arquivos de /out/ aceitos por chamada, bytes de cada um e somados (Suposição 24). */
  outputFilesMax: 5,
  outputFileMaxBytes: 5 * MIB,
  outputTotalMaxBytes: 10 * MIB,
  /** Chamadas simultâneas por processo (vagas). */
  slots: 2,
  /** Prazo de um /run depois da vaga: 60 s do código, 1 s do encerramento forçado e 14 s de folga (transferência e reaquecimento). */
  requestTimeoutMs: 75_000,
  /** Conferência de saúde de Configurações → Python (F11). */
  healthTimeoutMs: 3_000,
  /** Resposta inteira e cabeçalho JSON dela (os do sandbox). */
  responseMaxBytes: 15 * MIB,
  responseHeaderMaxBytes: 256 * 1024,
} as const;

/** O sandbox não respondeu, recusou o token, está cheio ou aquecendo: a chamada devolve `PYTHON_UNAVAILABLE` ao modelo e a execução segue. */
export class PythonUnavailableError extends Error {
  constructor(readonly reason: string) {
    super('Python indisponível');
    this.name = 'PythonUnavailableError';
  }
}

/** A chamada foi cancelada pelo sinal da execução ("Parar", prazo da execução ou worker encerrando), esperando vaga ou executando. */
export class PythonCancelledError extends Error {
  constructor() {
    super('Python cancelado');
    this.name = 'PythonCancelledError';
  }
}

/** Cabeçalho da resposta de /run, estrito: campo extra ou fora do limite é resposta inválida (falha fechada). */
const responseHeaderSchema = z.strictObject({
  outcome: z.enum(['ok', 'PYTHON_ERROR', 'PYTHON_TIMEOUT', 'PYTHON_MEMORY_LIMIT']),
  output: z.string().max(PYTHON_LIMITS.outputMaxChars),
  outputTruncated: z.boolean(),
  error: z.string().max(PYTHON_LIMITS.outputMaxChars).nullable(),
  durationMs: z.number().int().nonnegative(),
  networkCalls: z.number().int().nonnegative(),
  files: z.array(z.strictObject({ name: z.string().min(1).max(255), size: z.number().int().nonnegative(), omitted: z.boolean() })).max(20),
  filesOmitted: z.number().int().nonnegative(),
});

/** Arquivo de /out/ como o sandbox o devolveu; `data` nulo quando ele não coube na resposta (o worker o recusa por limite). */
export interface SandboxOutputFile {
  name: string;
  size: number;
  data: Buffer | null;
}

/** Resultado de uma chamada que chegou a executar no sandbox. */
export interface SandboxRunResult {
  outcome: 'ok' | 'PYTHON_ERROR' | 'PYTHON_TIMEOUT' | 'PYTHON_MEMORY_LIMIT';
  output: string;
  outputTruncated: boolean;
  error: string | null;
  durationMs: number;
  files: SandboxOutputFile[];
  /** Arquivos de /out/ além dos 20 listados (só contados). */
  filesOmitted: number;
}

export interface SandboxRunInput {
  code: string;
  /** Arquivos de /data/, com nomes já seguros e únicos (o sandbox recusa o pedido inteiro se não forem). */
  files: { name: string; data: Uint8Array }[];
}

/**
 * Fila FIFO das vagas do processo. `acquire` resolve com a função que devolve a vaga; rejeita com `PythonCancelledError` se o sinal disparar
 * enquanto espera (a posição na fila é liberada na hora).
 */
class SlotQueue {
  private busy = 0;
  private readonly waiting: { grant: () => void }[] = [];

  constructor(private readonly slots: number) {}

  /** Há vaga livre agora? (o chamador mostra "aguardando vaga" quando não há). */
  hasFreeSlot(): boolean {
    return this.busy < this.slots;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new PythonCancelledError());
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next.grant();
      else this.busy -= 1;
    };
    if (this.busy < this.slots) {
      this.busy += 1;
      return Promise.resolve(release);
    }
    return new Promise((resolve, reject) => {
      const entry = {
        grant: () => {
          signal.removeEventListener('abort', onAbort);
          resolve(release);
        },
      };
      const onAbort = () => {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new PythonCancelledError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(entry);
    });
  }
}

/** Monta o quadro binário do pedido (ver o cabeçalho do arquivo). */
function encodeFrame(header: object, blobs: readonly Uint8Array[]): Buffer {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(json.length, 0);
  return Buffer.concat([prefix, json, ...blobs]);
}

/** Lê o corpo da resposta com teto de bytes: recusa pelo Content-Length declarado e, sem ele, ao passar do teto durante a leitura. */
async function readCapped(response: Response, max: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > max) throw new PythonUnavailableError('resposta acima do limite');
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > max) throw new PythonUnavailableError('resposta acima do limite');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

/** Valida e separa o quadro da resposta; qualquer inconsistência é resposta inválida do sandbox (tratada como indisponível). */
function decodeRunResponse(frame: Buffer): SandboxRunResult {
  if (frame.length < 4) throw new PythonUnavailableError('resposta malformada');
  const headerLength = frame.readUInt32BE(0);
  if (headerLength > PYTHON_LIMITS.responseHeaderMaxBytes || 4 + headerLength > frame.length) throw new PythonUnavailableError('resposta malformada');
  let raw: unknown;
  try {
    raw = JSON.parse(frame.subarray(4, 4 + headerLength).toString('utf8'));
  } catch {
    throw new PythonUnavailableError('resposta malformada');
  }
  const parsed = responseHeaderSchema.safeParse(raw);
  if (!parsed.success) throw new PythonUnavailableError('resposta malformada');
  const header = parsed.data;
  const body = frame.subarray(4 + headerLength);
  let offset = 0;
  const files: SandboxOutputFile[] = header.files.map((file) => {
    if (file.omitted) return { name: file.name, size: file.size, data: null };
    if (offset + file.size > body.length) throw new PythonUnavailableError('resposta malformada');
    // Cópia: o arquivo gravado não segura o quadro inteiro da resposta na memória.
    const data = Buffer.from(body.subarray(offset, offset + file.size));
    offset += file.size;
    return { name: file.name, size: file.size, data };
  });
  if (offset !== body.length) throw new PythonUnavailableError('resposta malformada');
  return { outcome: header.outcome, output: header.output, outputTruncated: header.outputTruncated, error: header.error, durationMs: header.durationMs, files, filesOmitted: header.filesOmitted };
}

export interface PythonSandboxClientOptions {
  /** Origem do sandbox na rede interna (`config.sandbox.url`). */
  url: string;
  /** Token próprio do sandbox (`config.sandbox.token`); vai só no cabeçalho de autorização, nunca em log. */
  token: string;
  logger?: Logger;
  /** Os testes encurtam o prazo do pedido e mudam as vagas; em produção valem os de `PYTHON_LIMITS`. */
  requestTimeoutMs?: number;
  slots?: number;
}

export class PythonSandboxClient {
  private readonly slots: SlotQueue;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: PythonSandboxClientOptions) {
    this.slots = new SlotQueue(options.slots ?? PYTHON_LIMITS.slots);
    this.requestTimeoutMs = options.requestTimeoutMs ?? PYTHON_LIMITS.requestTimeoutMs;
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.options.token}` };
  }

  /** Conferência de saúde (F11): disponível só com 200 em até 3 s; qualquer outra coisa (aquecendo, token errado, fora do ar) é indisponível. */
  async health(): Promise<'available' | 'unavailable'> {
    try {
      const response = await fetch(`${this.options.url}/health`, { headers: this.headers(), signal: AbortSignal.timeout(PYTHON_LIMITS.healthTimeoutMs), redirect: 'error' });
      await response.body?.cancel().catch(() => undefined);
      return response.status === 200 ? 'available' : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  /** Há vaga livre agora? A ferramenta usa para mostrar "aguardando vaga" antes de esperar. */
  hasFreeSlot(): boolean {
    return this.slots.hasFreeSlot();
  }

  /**
   * Espera uma vaga e executa o código no sandbox. Lança `PythonCancelledError` se o sinal disparar (esperando ou executando: abortar o `fetch`
   * fecha a conexão e o sandbox mata o processo), `PythonUnavailableError` se o sandbox não serve. `onStart` avisa quando a vaga saiu.
   */
  async run(input: SandboxRunInput, signal: AbortSignal, onStart?: () => Promise<void>): Promise<SandboxRunResult> {
    const release = await this.slots.acquire(signal);
    try {
      await onStart?.();
      const body = encodeFrame({ code: input.code, files: input.files.map(({ name, data }) => ({ name, size: data.byteLength })) }, input.files.map((file) => file.data));
      const deadline = AbortSignal.timeout(this.requestTimeoutMs);
      let response: Response;
      try {
        response = await fetch(`${this.options.url}/run`, {
          method: 'POST',
          headers: { ...this.headers(), 'content-type': 'application/octet-stream' },
          body,
          signal: AbortSignal.any([signal, deadline]),
          redirect: 'error',
        });
      } catch {
        if (signal.aborted) throw new PythonCancelledError();
        throw new PythonUnavailableError(deadline.aborted ? 'prazo do pedido' : 'conexão');
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        // Só o status vai ao log: o corpo de erro do sandbox é um envelope fixo, mas não é preciso.
        this.options.logger?.warn({ status: response.status }, 'sandbox recusou o pedido de Python');
        throw new PythonUnavailableError(`status ${response.status}`);
      }
      try {
        return decodeRunResponse(await readCapped(response, PYTHON_LIMITS.responseMaxBytes));
      } catch (error) {
        if (signal.aborted) throw new PythonCancelledError();
        if (error instanceof PythonUnavailableError) throw error;
        throw new PythonUnavailableError(deadline.aborted ? 'prazo do pedido' : 'leitura da resposta');
      }
    } finally {
      release();
    }
  }
}

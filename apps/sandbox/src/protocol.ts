// Contrato do serviço sandbox (spec, Suposições 22b e 26; CODE-02): limites, formato binário do HTTP worker -> sandbox e mensagens
// IPC entre o servidor e o processo filho. Fonte única desses valores para server.ts, pool.ts, runner.ts e os testes em container.
// Não depende de nada específico do Node 26: a T7 pode reutilizar `encodeFrame`/`decodeFrame` no cliente do worker.
// `Buffer` importado (não o global): o processo filho apaga o global `Buffer` no endurecimento e continua usando o codec do canal.
import { Buffer } from 'node:buffer';
import { deserialize, serialize } from 'node:v8';

/** 1 MiB; os limites de bytes seguem a mesma unidade dos anexos (`ATTACHMENT_UPLOAD_MAX`). */
const MIB = 1024 * 1024;

// --- Limites (CODE-02 e contratos de segurança da spec) ---
export const LIMITS = {
  /** Código Python aceito por chamada, em caracteres. */
  codeMaxChars: 20_000,
  /** Arquivos de entrada por chamada (os anexos indicados pelo modelo). */
  filesMax: 5,
  /** Nome de arquivo de entrada ou saída, em caracteres. */
  fileNameMaxChars: 255,
  /** Corpo do pedido HTTP inteiro (cabeçalho + arquivos). */
  requestMaxBytes: 60 * MIB,
  /** Cabeçalho JSON do pedido (código e metadados dos arquivos). */
  requestHeaderMaxBytes: 256 * 1024,
  /** Resposta HTTP inteira (cabeçalho + arquivos de /out/). */
  responseMaxBytes: 15 * MIB,
  /** Arquivos de /out/ listados na resposta; o excedente só é contado em `filesOmitted`. */
  outputFilesListMax: 20,
  /** Saída padrão + erro juntas devolvidas, em caracteres (o worker repete o corte com aviso, Suposição 25). */
  outputMaxChars: 20_000,
  /** Traceback devolvido, em caracteres. */
  errorMaxChars: 20_000,
  /** Prazo do código por chamada; ao vencer, interrupção cooperativa (KeyboardInterrupt). */
  runTimeoutMs: 60_000,
  /** Folga depois do prazo antes do encerramento forçado do processo. */
  killGraceMs: 1_000,
  /** Crescimento máximo da memória WebAssembly durante a chamada (trava no `grow`). */
  wasmGrowthMaxBytes: 512 * MIB,
  /**
   * Crescimento máximo da memória residente do processo filho sobre a base aquecida (vigilância do pai). Cobre os 512 MiB do WASM e a
   * memória JavaScript fora dele (arquivos do sistema de arquivos em memória, ArrayBuffers), que a trava do WASM não enxerga.
   */
  rssGrowthMaxBytes: 768 * MIB,
  /** Intervalo da vigilância de memória do pai. */
  rssPollMs: 50,
  /** Processos de Python simultâneos (vagas); cada vaga tem um processo aquecido. */
  slots: 2,
  /** Pedidos esperando vaga; acima disso o sandbox recusa com SANDBOX_BUSY. */
  waitingMax: 8,
  /** Prazo para um processo filho carregar o Pyodide, os pacotes e passar no autoteste. */
  warmupTimeoutMs: 120_000,
  /** Espera antes de tentar aquecer de novo depois de uma falha de aquecimento. */
  warmupRetryMs: 5_000,
} as const;

// --- Desfechos e erros públicos ---

/** Desfecho de uma chamada que chegou a executar. Os códigos de erro são os da spec (F8), devolvidos ao modelo pelo worker. */
export type RunOutcome = 'ok' | 'PYTHON_ERROR' | 'PYTHON_TIMEOUT' | 'PYTHON_MEMORY_LIMIT';

/** Códigos estáveis do envelope de erro HTTP do sandbox (`{ code, message }`). */
export type SandboxErrorCode =
  | 'SANDBOX_UNAUTHORIZED'
  | 'SANDBOX_INPUT_INVALID'
  | 'SANDBOX_BODY_TOO_LARGE'
  | 'SANDBOX_BUSY'
  | 'SANDBOX_UNAVAILABLE'
  | 'SANDBOX_NOT_FOUND'
  | 'SANDBOX_INTERNAL';

// --- Formato HTTP: POST /run ---

/** Cabeçalho do pedido: código e a lista ordenada dos arquivos cujos bytes seguem o cabeçalho, na mesma ordem. */
export interface RunRequestHeader {
  code: string;
  files: { name: string; size: number }[];
}

/** Arquivo de /out/ na resposta; `omitted` indica que os bytes não couberam no limite da resposta (o worker o recusa). */
export interface RunResponseFile {
  name: string;
  size: number;
  omitted: boolean;
}

/** Cabeçalho da resposta; os bytes dos arquivos não omitidos seguem o cabeçalho, na ordem da lista. */
export interface RunResponseHeader {
  outcome: RunOutcome;
  output: string;
  outputTruncated: boolean;
  /** Traceback do Python (sem o quadro interno do executor) ou mensagem do desfecho; `null` no sucesso. */
  error: string | null;
  durationMs: number;
  /** Chamadas ao `fetch` instrumentado do processo, da carga ao fim da chamada (A14: precisa ser 0). */
  networkCalls: number;
  files: RunResponseFile[];
  filesOmitted: number;
}

/**
 * Quadro binário usado nos dois sentidos de /run: `uint32 BE` com o tamanho do cabeçalho, o cabeçalho JSON em UTF-8 e os bytes dos
 * arquivos concatenados. Evita base64 (que inflaria 50 MiB de anexos para ~67 MiB e estouraria o corpo de 60 MiB).
 */
export function encodeFrame(header: object, blobs: readonly Uint8Array[]): Buffer {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(json.length, 0);
  return Buffer.concat([prefix, json, ...blobs]);
}

/** Separa cabeçalho e bytes de um quadro; lança em quadro malformado. O cabeçalho volta como `unknown` para validação na borda. */
export function decodeFrame(frame: Buffer, headerMaxBytes: number): { header: unknown; body: Buffer } {
  if (frame.length < 4) throw new Error('quadro curto');
  const headerLength = frame.readUInt32BE(0);
  if (headerLength > headerMaxBytes || 4 + headerLength > frame.length) throw new Error('cabeçalho inválido');
  const header: unknown = JSON.parse(frame.subarray(4, 4 + headerLength).toString('utf8'));
  return { header, body: frame.subarray(4 + headerLength) };
}

/**
 * Nome aceitável para /data/ e /out/: um único componente de caminho, sem separadores, controles, `.` ou `..`. O worker já sanitiza os
 * nomes dos anexos; esta conferência é a do sandbox, que não confia no chamador (nem no Python, para os nomes de /out/).
 */
export function isSafeFileName(name: string): boolean {
  return (
    name.length >= 1 &&
    name.length <= LIMITS.fileNameMaxChars &&
    name !== '.' &&
    name !== '..' &&
    !/[/\\]/.test(name) &&
    !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(name)
  );
}

// --- IPC servidor <-> processo filho ---

/** Pedido do servidor ao filho; cada filho recebe exatamente um. */
export interface IpcRunMessage {
  type: 'run';
  code: string;
  files: { name: string; data: Uint8Array }[];
}

/** Filho aquecido, endurecido e aprovado no autoteste. */
export interface IpcReadyMessage {
  type: 'ready';
  networkCalls: number;
}

/** Resultado da chamada, produzido pelo filho; o servidor revalida tudo (o filho executou código não confiável). */
export interface IpcResultMessage {
  type: 'result';
  outcome: RunOutcome;
  output: string;
  outputTruncated: boolean;
  error: string | null;
  networkCalls: number;
  files: { name: string; size: number; data: Uint8Array | null }[];
  filesOmitted: number;
}

/** Falha de aquecimento ou do autoteste; `reason` é um código curto, sem dado do usuário. */
export interface IpcFatalMessage {
  type: 'fatal';
  reason: string;
}

export type IpcChildMessage = IpcReadyMessage | IpcResultMessage | IpcFatalMessage;

// --- Canal IPC próprio (fd 3) ---
// O canal `ipc` do `child_process` é anunciado ao filho por variáveis de ambiente (`NODE_CHANNEL_FD` e
// `NODE_CHANNEL_SERIALIZATION_MODE`), que ficam no ambiente inicial do processo (/proc/<pid>/environ) mesmo depois que o Node as apaga
// de `process.env`; a camada (c) exige ambiente vazio. Por isso o pai abre um par de sockets comum no fd 3 (`stdio: 'pipe'`, sem
// variável nenhuma) e os dois lados trocam quadros `uint32 BE` de tamanho + mensagem serializada pelo V8 (o mesmo formato da
// serialização `advanced` do IPC do Node, que transporta Uint8Array sem base64).

/** Descritor do canal no filho: o quarto item de `stdio` do `spawn`. */
export const IPC_FD = 3;
/** Maior quadro que o filho aceita do pai: o pedido inteiro mais folga para a serialização. */
export const IPC_TO_CHILD_MAX_BYTES = LIMITS.requestMaxBytes + MIB;
/** Maior quadro que o pai aceita do filho (não confiável): a resposta inteira mais folga para saída e traceback serializados. */
export const IPC_FROM_CHILD_MAX_BYTES = LIMITS.responseMaxBytes + MIB;

/** Monta um quadro IPC. */
export function encodeIpc(message: unknown): Buffer {
  const payload = serialize(message);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length, 0);
  return Buffer.concat([prefix, payload]);
}

/**
 * Remonta quadros IPC a partir dos pedaços lidos do socket. Lança quando um quadro anuncia mais que `maxBytes` (o lado que recebe
 * trata como canal corrompido) ou quando a serialização é inválida.
 */
export class IpcDecoder {
  // Pedaços guardados sem concatenar a cada leitura (um pedido de 60 MiB chega em milhares de pedaços); junta só quando o quadro fecha.
  private chunks: Buffer[] = [];
  private buffered = 0;

  constructor(private readonly maxBytes: number) {}

  /** Acrescenta um pedaço e devolve as mensagens completas, na ordem. */
  push(chunk: Buffer): unknown[] {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    const messages: unknown[] = [];
    for (;;) {
      if (this.buffered < 4) break;
      if (this.chunks[0] && this.chunks[0].length < 4) this.chunks = [Buffer.concat(this.chunks)];
      const length = (this.chunks[0] as Buffer).readUInt32BE(0);
      if (length > this.maxBytes) throw new Error('quadro IPC acima do limite');
      if (this.buffered < 4 + length) break;
      const all = this.chunks.length === 1 ? (this.chunks[0] as Buffer) : Buffer.concat(this.chunks, this.buffered);
      messages.push(deserialize(all.subarray(4, 4 + length)));
      const rest = all.subarray(4 + length);
      this.chunks = rest.length > 0 ? [rest] : [];
      this.buffered = rest.length;
    }
    return messages;
  }
}

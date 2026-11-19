// Vagas de execução do sandbox (CODE-02): 2 processos filhos aquecidos, um por vaga; cada chamada usa um processo e o descarta, e a vaga
// aquece outro em seguida. Pedidos acima das vagas esperam em fila FIFO (limitada) e podem ser cancelados enquanto esperam.
//
// Camadas de isolamento impostas aqui, na criação do filho (spec, Suposição 22):
// (a) `--permission` com leitura só da pasta do runtime (sem escrita, rede, processo filho, worker, addon, WASI e inspetor, que o modelo
//     de permissões nega por padrão) e `--disallow-code-generation-from-strings`;
// (c) ambiente de variáveis vazio (`env: {}` e canal próprio no fd 3 em vez do `ipc` do Node, que injeta NODE_CHANNEL_*): o token do
//     sandbox, qualquer variável do container e qualquer variável do Node não chegam ao ambiente inicial do filho;
// e os limites que não podem depender do filho: encerramento forçado 1 s depois do prazo cooperativo, vigilância da memória residente
// (/proc/<pid>/status) e encerramento imediato no cancelamento. O filho executou código não confiável, então tudo o que ele manda é
// revalidado aqui.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import path from 'node:path';
import {
  IPC_FD, IPC_FROM_CHILD_MAX_BYTES, IpcDecoder, LIMITS, encodeIpc, isSafeFileName, type IpcChildMessage, type IpcRunMessage,
  type RunOutcome, type RunResponseFile,
} from './protocol.js';

/** Arquivo de entrada já validado pela borda HTTP. */
export interface RunInput {
  code: string;
  files: { name: string; data: Uint8Array }[];
}

/** Resultado revalidado de uma chamada, pronto para virar o quadro de resposta. */
export interface RunResult {
  outcome: RunOutcome;
  output: string;
  outputTruncated: boolean;
  error: string | null;
  durationMs: number;
  networkCalls: number;
  files: (RunResponseFile & { data: Uint8Array | null })[];
  filesOmitted: number;
}

/** Erros de domínio do pool; server.ts converte cada um no envelope HTTP. */
export class SandboxBusyError extends Error {}
export class SandboxUnavailableError extends Error {}
export class RunCancelledError extends Error {}

/** Processo filho aquecido e aprovado no autoteste, com a memória residente medida no momento em que ficou pronto. */
interface WarmChild {
  child: ChildProcess;
  baselineRss: number;
  networkCalls: number;
}

/** Uma vaga: o processo aquecido (ou o aquecimento em curso) e se está reservada por um pedido. */
interface Slot {
  warm: Promise<WarmChild | null>;
  ready: boolean;
  busy: boolean;
  lastWarmFailed: boolean;
}

/** Log estruturado do pool: só eventos, códigos e números, nunca código, saída ou nomes de arquivo (Suposição 29). */
export type Logger = (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;

/** Memória residente de um processo em bytes, lida de /proc (o serviço só roda em Linux). `null` se o processo já sumiu. */
export function readRss(pid: number): number | null {
  try {
    const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return match?.[1] ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

/** Socket do canal com o filho (fd 3 do `spawn`). */
function channelOf(child: ChildProcess): Socket {
  return child.stdio[IPC_FD] as Socket;
}

/**
 * Liga o canal do filho (protocol.ts) aos eventos `message` do próprio ChildProcess, para o aquecimento e a execução escutarem como
 * no IPC do Node. Quadro acima do limite ou malformado (o filho é não confiável) vira uma única mensagem `null`, que os dois
 * consumidores tratam como resposta inválida, e o resto do canal é ignorado. Erro de escrita (filho já morto) é absorvido: quem
 * decide o desfecho é o evento `exit`.
 */
function attachChannel(child: ChildProcess): void {
  const channel = channelOf(child);
  const decoder = new IpcDecoder(IPC_FROM_CHILD_MAX_BYTES);
  let broken = false;
  channel.on('error', () => {});
  channel.on('data', (chunk: Buffer) => {
    if (broken) return;
    try {
      for (const message of decoder.push(chunk)) child.emit('message', message);
    } catch {
      broken = true;
      child.emit('message', null);
    }
  });
}

/** Mata o processo de imediato; usado ao fim de toda chamada, no prazo, na memória e no cancelamento. */
function kill(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

export class SandboxPool {
  private readonly slots: Slot[] = [];
  private readonly waiters: { resolve: (slot: Slot) => void }[] = [];
  private closed = false;

  constructor(
    private readonly runtimeDir: string,
    private readonly log: Logger,
  ) {
    for (let index = 0; index < LIMITS.slots; index += 1) {
      const slot: Slot = { warm: Promise.resolve(null), ready: false, busy: false, lastWarmFailed: false };
      this.slots.push(slot);
      this.rewarm(slot);
    }
  }

  /** Estado para a rota de saúde: vagas, prontas, ocupadas e pedidos esperando. */
  status(): { slots: number; ready: number; busy: number; waiting: number } {
    return {
      slots: this.slots.length,
      ready: this.slots.filter((slot) => slot.ready && !slot.busy).length,
      busy: this.slots.filter((slot) => slot.busy).length,
      waiting: this.waiters.length,
    };
  }

  /** Executa uma chamada numa vaga: espera a vez (cancelável), usa o processo aquecido e o descarta ao fim, aconteça o que acontecer. */
  async run(input: RunInput, signal: AbortSignal): Promise<RunResult> {
    const slot = await this.acquire(signal);
    let consumed = false;
    try {
      const warm = await slot.warm;
      if (!warm) throw new SandboxUnavailableError('processo de Python indisponível');
      if (signal.aborted) throw new RunCancelledError('cancelado');
      consumed = true;
      slot.ready = false;
      return await this.execute(warm, input, signal);
    } finally {
      this.release(slot, consumed);
    }
  }

  /** Encerra todos os processos (desligamento do serviço). */
  close(): void {
    this.closed = true;
    for (const slot of this.slots) void slot.warm.then((warm) => warm && kill(warm.child));
  }

  // --- Fila de vagas ---

  private acquire(signal: AbortSignal): Promise<Slot> {
    const free = this.slots.find((slot) => !slot.busy);
    if (free) {
      free.busy = true;
      return Promise.resolve(free);
    }
    if (this.waiters.length >= LIMITS.waitingMax) return Promise.reject(new SandboxBusyError('fila cheia'));
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (slot: Slot) => {
          signal.removeEventListener('abort', onAbort);
          resolve(slot);
        },
      };
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new RunCancelledError('cancelado na espera'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  /**
   * Devolve a vaga. Processo usado (ou aquecimento que falhou) é descartado e outro começa a aquecer; o próximo da fila recebe a vaga e
   * espera o aquecimento, que não conta no prazo do código. Pedido cancelado antes de usar o processo o deixa aquecido para o próximo.
   */
  private release(slot: Slot, consumed: boolean): void {
    if (consumed || slot.lastWarmFailed) {
      void slot.warm.then((warm) => warm && kill(warm.child));
      this.rewarm(slot);
    }
    const next = this.waiters.shift();
    if (next) next.resolve(slot);
    else slot.busy = false;
  }

  // --- Aquecimento ---

  private rewarm(slot: Slot): void {
    if (this.closed) return;
    slot.ready = false;
    const delay = slot.lastWarmFailed ? LIMITS.warmupRetryMs : 0;
    slot.warm = new Promise<void>((resolve) => setTimeout(resolve, delay))
      .then(() => this.spawnWarm())
      .then(
        (warm) => {
          slot.lastWarmFailed = false;
          slot.ready = true;
          return warm;
        },
        (error: unknown) => {
          slot.lastWarmFailed = true;
          this.log('error', 'aquecimento do Python falhou', { reason: error instanceof Error ? error.message : 'desconhecido' });
          // A vaga não pode ficar morta: tenta de novo (com espera) se ninguém a reservou; quem a reservou recebe indisponível.
          if (!slot.busy) setImmediate(() => this.rewarm(slot));
          return null;
        },
      );
  }

  /** Cria o processo filho com as camadas (a) e (c) e espera o "pronto" do autoteste dentro do prazo de aquecimento. */
  private spawnWarm(): Promise<WarmChild> {
    const child = spawn(
      process.execPath,
      [
        '--permission',
        `--allow-fs-read=${this.runtimeDir}${path.sep}`,
        '--disallow-code-generation-from-strings',
        path.join(this.runtimeDir, 'runner.js'),
      ],
      // Sem stdout/stderr: a saída do Python chega só pelo canal, já cortada; nada do usuário vai para o log do container. O canal é um
      // `pipe` comum no fd 3, não `ipc`: o `ipc` do Node grava NODE_CHANNEL_FD e NODE_CHANNEL_SERIALIZATION_MODE no ambiente do filho.
      { env: {}, stdio: ['ignore', 'ignore', 'ignore', 'pipe'] },
    );
    attachChannel(child);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail('warmup_timeout'), LIMITS.warmupTimeoutMs);
      const fail = (reason: string): void => {
        clearTimeout(timer);
        child.removeAllListeners();
        kill(child);
        reject(new Error(reason));
      };
      child.once('error', () => fail('spawn_failed'));
      child.once('exit', () => fail('exited_during_warmup'));
      child.once('message', (raw: unknown) => {
        const message = raw as IpcChildMessage;
        if (message?.type === 'ready' && Number.isSafeInteger(message.networkCalls)) {
          const baselineRss = readRss(child.pid ?? -1);
          if (baselineRss === null) return fail('rss_unreadable');
          clearTimeout(timer);
          child.removeAllListeners();
          resolve({ child, baselineRss, networkCalls: message.networkCalls });
          return;
        }
        fail(message?.type === 'fatal' && typeof message.reason === 'string' ? message.reason.slice(0, 300) : 'unexpected_message');
      });
    });
  }

  // --- Execução de uma chamada ---

  private execute(warm: WarmChild, input: RunInput, signal: AbortSignal): Promise<RunResult> {
    const { child } = warm;
    const started = performance.now();
    return new Promise((resolve, reject) => {
      let stopReason: 'timeout' | 'memory' | 'cancelled' | null = null;
      const finish = (result: RunResult | Error): void => {
        clearTimeout(hardTimer);
        clearInterval(watchdog);
        signal.removeEventListener('abort', onAbort);
        child.removeAllListeners();
        kill(child);
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const stop = (reason: NonNullable<typeof stopReason>): void => {
        stopReason = reason;
        kill(child);
      };
      const failed = (outcome: RunOutcome, error: string): RunResult => ({
        outcome, error, output: '', outputTruncated: false, durationMs: Math.round(performance.now() - started),
        networkCalls: warm.networkCalls, files: [], filesOmitted: 0,
      });

      // Encerramento forçado: o prazo cooperativo do filho é 60 s; 1 s depois o processo morre, mesmo que o código engula a interrupção.
      const hardTimer = setTimeout(() => stop('timeout'), LIMITS.runTimeoutMs + LIMITS.killGraceMs);
      // Vigilância de memória residente: cobre o que a trava do WASM não vê (ArrayBuffers e arquivos em memória do lado JavaScript).
      const watchdog = setInterval(() => {
        const rss = readRss(child.pid ?? -1);
        if (rss !== null && rss - warm.baselineRss > LIMITS.rssGrowthMaxBytes) stop('memory');
      }, LIMITS.rssPollMs);
      // "Parar" no worker fecha a conexão: o processo morre na hora.
      const onAbort = (): void => stop('cancelled');
      signal.addEventListener('abort', onAbort, { once: true });

      child.once('exit', (code, exitSignal) => {
        if (stopReason === 'cancelled') return finish(new RunCancelledError('cancelado'));
        if (stopReason === 'timeout') return finish(failed('PYTHON_TIMEOUT', 'Tempo esgotado (60 s).'));
        if (stopReason === 'memory') return finish(failed('PYTHON_MEMORY_LIMIT', 'Memória esgotada (512 MB).'));
        // Saída inesperada: SIGKILL alheio (OOM do container) ou aborto do V8 por falta de heap contam como memória.
        if (exitSignal === 'SIGKILL' || exitSignal === 'SIGABRT' || code === 134) {
          return finish(failed('PYTHON_MEMORY_LIMIT', 'Memória esgotada (512 MB).'));
        }
        finish(failed('PYTHON_ERROR', 'O Python sofreu um erro interno e foi encerrado.'));
      });
      child.once('message', (raw: unknown) => {
        const result = validateResult(raw);
        if (!result) return finish(failed('PYTHON_ERROR', 'O Python devolveu um resultado inválido.'));
        finish({ ...result, durationMs: Math.round(performance.now() - started) });
      });
      channelOf(child).write(encodeIpc({ type: 'run', code: input.code, files: input.files } satisfies IpcRunMessage));
    });
  }
}

/** Revalida a mensagem de resultado do filho (dado não confiável): tipos, desfecho, limites de texto, nomes e tamanhos. */
function validateResult(raw: unknown): Omit<RunResult, 'durationMs'> | null {
  const message = raw as Partial<Extract<IpcChildMessage, { type: 'result' }>> | null;
  const outcomes: RunOutcome[] = ['ok', 'PYTHON_ERROR', 'PYTHON_TIMEOUT', 'PYTHON_MEMORY_LIMIT'];
  if (
    message?.type !== 'result' ||
    !outcomes.includes(message.outcome as RunOutcome) ||
    typeof message.output !== 'string' ||
    message.output.length > LIMITS.outputMaxChars ||
    typeof message.outputTruncated !== 'boolean' ||
    !(message.error === null || (typeof message.error === 'string' && message.error.length <= LIMITS.errorMaxChars)) ||
    !Number.isSafeInteger(message.networkCalls) ||
    !Number.isSafeInteger(message.filesOmitted) ||
    !Array.isArray(message.files) ||
    message.files.length > LIMITS.outputFilesListMax
  ) {
    return null;
  }
  const names = new Set<string>();
  let bytes = 0;
  const files: RunResult['files'] = [];
  for (const file of message.files as unknown[]) {
    const entry = file as { name?: unknown; size?: unknown; data?: unknown };
    if (typeof entry.name !== 'string' || !isSafeFileName(entry.name) || names.has(entry.name)) return null;
    if (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0) return null;
    const data = entry.data === null ? null : entry.data instanceof Uint8Array ? entry.data : undefined;
    if (data === undefined || (data !== null && data.byteLength !== entry.size)) return null;
    bytes += data?.byteLength ?? 0;
    names.add(entry.name);
    files.push({ name: entry.name, size: entry.size as number, omitted: data === null, data });
  }
  if (bytes > LIMITS.responseMaxBytes - 256 * 1024) return null;
  return {
    outcome: message.outcome as RunOutcome,
    output: message.output,
    outputTruncated: message.outputTruncated,
    error: message.error ?? null,
    networkCalls: message.networkCalls as number,
    files,
    filesOmitted: message.filesOmitted as number,
  };
}

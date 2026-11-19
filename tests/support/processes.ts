// Ajudantes para subir e observar processos Node reais (api, worker, Next) nos testes que cruzam serviços.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';

export interface ManagedProcess {
  /** Tudo que o processo escreveu em stdout e stderr até agora. */
  output(): string;
  /** Resolve quando o padrão aparece na saída; rejeita no timeout ou se o processo morrer antes. */
  waitForOutput(pattern: RegExp, timeoutMs?: number): Promise<void>;
  /** Resolve com o código de saída quando o processo termina. */
  exited: Promise<number | null>;
  stop(): Promise<void>;
}

/** Sobe `node <args>` com o ambiente dado (herda o do processo atual e sobrescreve com `env`). */
export function spawnNode(
  args: string[],
  options: { cwd: string; env: Record<string, string>; /** Espelha a saída no stdout com este prefixo (depuração). */ echoPrefix?: string },
): ManagedProcess {
  const child: ChildProcess = spawn(process.execPath, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let buffer = '';
  const listeners = new Set<() => void>();
  const onData = (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    if (options.echoPrefix) process.stdout.write(chunk.toString('utf8').replace(/^(?=.)/gm, options.echoPrefix));
    for (const listener of listeners) listener();
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      resolve(code);
      for (const listener of listeners) listener();
    });
  });

  return {
    output: () => buffer,
    exited,
    waitForOutput(pattern, timeoutMs = 30_000) {
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`timeout esperando ${pattern} na saída:\n${buffer}`));
        }, timeoutMs);
        const check = () => {
          if (pattern.test(buffer)) {
            clearTimeout(timer);
            listeners.delete(check);
            resolve();
          } else if (child.exitCode !== null) {
            clearTimeout(timer);
            listeners.delete(check);
            reject(new Error(`processo terminou antes de ${pattern}:\n${buffer}`));
          }
        };
        listeners.add(check);
        check();
      });
    },
    async stop() {
      if (child.exitCode === null) child.kill('SIGTERM');
      // Se não encerrar sozinho em 10 s (no Windows SIGTERM equivale a kill), força.
      const force = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(force);
    },
  };
}

/** Espera uma condição assíncrona ficar verdadeira, tentando a cada `intervalMs`. */
export async function waitUntil(
  condition: () => Promise<boolean>,
  { timeoutMs = 30_000, intervalMs = 250, description = 'condição' } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await condition()) return;
    } catch {
      // Ainda subindo: tenta de novo até o prazo.
    }
    if (Date.now() >= deadline) throw new Error(`timeout esperando ${description}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Roda o pnpm que iniciou o processo atual (`npm_execpath`), sem depender do PATH nem de shell. Em falha,
 * o erro carrega a saída do comando (o build quebrado precisa aparecer no relatório do teste).
 */
export function runPnpm(args: string[], cwd: string): void {
  const pnpm = process.env.npm_execpath;
  try {
    if (pnpm) execFileSync(process.execPath, [pnpm, ...args], { cwd, stdio: 'pipe' });
    else execFileSync('pnpm', args, { cwd, stdio: 'pipe', shell: true });
  } catch (error) {
    const failure = error as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(`pnpm ${args.join(' ')} falhou:
${failure.stdout?.toString() ?? ''}
${failure.stderr?.toString() ?? ''}`);
  }
}

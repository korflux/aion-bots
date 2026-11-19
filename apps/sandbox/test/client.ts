// Cliente HTTP mínimo das suítes em container: monta o quadro binário de /run, decodifica a resposta e expõe o container, o token e o
// canário de rede que scripts/test-container.ts colocou no ambiente. Não é o cliente do worker (T7), só o do teste.
import { execFileSync } from 'node:child_process';
import { LIMITS, decodeFrame, encodeFrame, type RunResponseHeader } from '../src/protocol.js';

/** Variável obrigatória do ambiente montado pelo orquestrador; sem ela a suíte não sabe onde está o container. */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} ausente: rode as suítes por "pnpm --filter @aion/sandbox test:container"`);
  return value;
}

export const sandboxUrl = required('AION_SANDBOX_URL');
export const sandboxToken = required('AION_SANDBOX_TOKEN');
export const containerName = required('AION_SANDBOX_CONTAINER');
/** Canário fora do sandbox: URL vista de dentro da rede do container e URL de contagem vista do host. */
export const canaryInnerUrl = required('AION_SANDBOX_CANARY_INNER_URL');
const canaryCountUrl = required('AION_SANDBOX_CANARY_COUNT_URL');

export interface RunResponse extends RunResponseHeader {
  status: 200;
  contents: Map<string, Buffer>;
}
export interface ErrorResponse {
  status: number;
  code: string;
}

/** Envia código e arquivos ao /run e devolve o cabeçalho decodificado com os bytes de cada arquivo de /out/ incluído. */
export async function runPython(
  code: string,
  files: { name: string; data: Uint8Array }[] = [],
  options: { token?: string; signal?: AbortSignal } = {},
): Promise<RunResponse | ErrorResponse> {
  const body = encodeFrame({ code, files: files.map(({ name, data }) => ({ name, size: data.byteLength })) }, files.map((file) => file.data));
  return postRun(body, options);
}

/** POST /run com corpo arbitrário (usado também para provar a recusa de corpo grande ou malformado). */
export async function postRun(body: Uint8Array, options: { token?: string; signal?: AbortSignal } = {}): Promise<RunResponse | ErrorResponse> {
  const response = await fetch(`${sandboxUrl}/run`, {
    method: 'POST',
    headers: { authorization: `Bearer ${options.token ?? sandboxToken}`, 'content-type': 'application/octet-stream' },
    body,
    signal: options.signal,
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (response.status !== 200) return { status: response.status, code: (JSON.parse(bytes.toString('utf8')) as { code: string }).code };
  const { header, body: rest } = decodeFrame(bytes, LIMITS.responseMaxBytes);
  const parsed = header as RunResponseHeader;
  const contents = new Map<string, Buffer>();
  let offset = 0;
  for (const file of parsed.files) {
    if (file.omitted) continue;
    contents.set(file.name, rest.subarray(offset, offset + file.size));
    offset += file.size;
  }
  return { ...parsed, status: 200, contents };
}

/** Estado das vagas pela rota de saúde. */
export async function health(token = sandboxToken): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${sandboxUrl}/health`, { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Espera a condição sobre a rota de saúde (ex.: duas vagas prontas depois de chamadas que reaquecem processos). */
export async function waitHealth(predicate: (body: Record<string, unknown>) => boolean, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await health();
    if (predicate(body)) return body;
    if (Date.now() > until) throw new Error(`saúde não chegou ao estado esperado: ${JSON.stringify(body)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Pedidos que o canário recebeu de qualquer origem que não o próprio teste (contagem e prova de alcance ficam fora). */
export async function canaryHits(): Promise<number> {
  const response = await fetch(canaryCountUrl);
  return ((await response.json()) as { hits: number }).hits;
}

/** Executa um comando dentro do container do sandbox (inspeção de disco, ambiente e rede, nunca do processo filho). */
export function dockerExec(args: string[]): { ok: boolean; stdout: string } {
  try {
    return { ok: true, stdout: execFileSync('docker', ['exec', containerName, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    return { ok: false, stdout: String((error as { stdout?: string }).stdout ?? '') };
  }
}

/** Afirma resposta 200 e devolve o tipo estreitado para os asserts. */
export function asRun(response: RunResponse | ErrorResponse): RunResponse {
  if (response.status !== 200) throw new Error(`esperava 200, veio ${response.status} ${(response as ErrorResponse).code}`);
  return response as RunResponse;
}

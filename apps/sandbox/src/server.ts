// Borda HTTP do serviço sandbox (spec, Suposição 22b): só a rede interna do Easypanel o alcança (sem domínio público), e toda rota exige
// o token próprio do sandbox, comparado em tempo constante. Rotas:
// - GET /health: estado das vagas (o worker confere em até 3 s para Configurações -> Python);
// - POST /run: quadro binário (protocol.ts) com código e arquivos de /data/; responde com desfecho, saída e arquivos de /out/.
// Limites na borda: corpo até 60 MiB, cabeçalho estrito (campos extras recusados), resposta até 15 MiB. Erros em envelope
// `{ code, message }` com códigos estáveis; o log leva só eventos, desfechos, durações e tamanhos, nunca código, saída ou nomes.
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunCancelledError, SandboxBusyError, SandboxPool, SandboxUnavailableError, readRss, type Logger, type RunInput } from './pool.js';
import { LIMITS, decodeFrame, encodeFrame, isSafeFileName, type RunResponseHeader, type SandboxErrorCode } from './protocol.js';

/** Erro de validação da borda, convertido em 400/413 pelo handler central. */
class InputError extends Error {
  constructor(
    readonly code: SandboxErrorCode,
    readonly status: number,
  ) {
    super(code);
  }
}

/** Log em JSON por linha no stdout do container (o pino dos outros serviços seria dependência demais para este). */
const log: Logger = (level, message, fields = {}) => {
  process.stdout.write(`${JSON.stringify({ level, time: new Date().toISOString(), msg: message, ...fields })}\n`);
};

// --- Configuração (só variáveis de ambiente; nenhum segredo do Aion existe neste container) ---
const rawToken = process.env.AION_SANDBOX_TOKEN ?? '';
if (rawToken.length < 32) {
  log('error', 'AION_SANDBOX_TOKEN ausente ou curto (mínimo 32 caracteres); o sandbox não sobe sem token');
  process.exit(1);
}
// O token sai do ambiente do processo assim que lido; o hash é o que fica para a comparação.
delete process.env.AION_SANDBOX_TOKEN;
const tokenHash = createHash('sha256').update(rawToken).digest();
const port = Number(process.env.PORT ?? 8080);
const runtimeDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runtime');
// A vigilância de memória lê /proc; sem ele o limite de memória não valeria, então o serviço recusa subir (falha fechada).
if (readRss(process.pid) === null) {
  log('error', '/proc indisponível: a vigilância de memória não funcionaria');
  process.exit(1);
}

/** Compara o Bearer recebido com o token em tempo constante (hash de tamanho fixo dos dois lados, qualquer que seja o tamanho). */
function authorized(request: IncomingMessage): boolean {
  const match = /^Bearer (.+)$/.exec(request.headers.authorization ?? '');
  if (!match?.[1]) return false;
  return timingSafeEqual(createHash('sha256').update(match[1]).digest(), tokenHash);
}

/** Envelope de erro padronizado; `Connection: close` evita reaproveitar uma conexão cujo corpo não foi lido. */
function sendError(response: ServerResponse, status: number, code: SandboxErrorCode, message: string): void {
  if (response.headersSent) return void response.destroy();
  response.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
  response.end(JSON.stringify({ code, message }));
}

/** Lê o corpo inteiro com teto: recusa pelo Content-Length declarado e, sem ele, ao passar do limite durante a leitura. */
async function readBody(request: IncomingMessage): Promise<Buffer> {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (declared > LIMITS.requestMaxBytes) throw new InputError('SANDBOX_BODY_TOO_LARGE', 413);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > LIMITS.requestMaxBytes) throw new InputError('SANDBOX_BODY_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

/** Valida o quadro do pedido: cabeçalho estrito, código e arquivos nos limites, nomes seguros e únicos, bytes exatamente declarados. */
function parseRunRequest(body: Buffer): RunInput {
  let decoded: ReturnType<typeof decodeFrame>;
  try {
    decoded = decodeFrame(body, LIMITS.requestHeaderMaxBytes);
  } catch {
    throw new InputError('SANDBOX_INPUT_INVALID', 400);
  }
  const header = decoded.header as Record<string, unknown> | null;
  const invalid = (): never => {
    throw new InputError('SANDBOX_INPUT_INVALID', 400);
  };
  if (typeof header !== 'object' || header === null || Array.isArray(header)) invalid();
  if (Object.keys(header as object).sort().join() !== 'code,files') invalid();
  const { code, files } = header as { code: unknown; files: unknown };
  if (typeof code !== 'string' || code.length < 1 || code.length > LIMITS.codeMaxChars) invalid();
  if (!Array.isArray(files) || files.length > LIMITS.filesMax) invalid();
  const names = new Set<string>();
  const result: RunInput = { code: code as string, files: [] };
  let offset = 0;
  for (const raw of files as unknown[]) {
    const entry = raw as Record<string, unknown> | null;
    if (typeof entry !== 'object' || entry === null || Object.keys(entry).sort().join() !== 'name,size') invalid();
    const { name, size } = entry as { name: unknown; size: unknown };
    if (typeof name !== 'string' || !isSafeFileName(name) || names.has(name)) invalid();
    if (!Number.isSafeInteger(size) || (size as number) < 0 || offset + (size as number) > decoded.body.length) invalid();
    names.add(name as string);
    result.files.push({ name: name as string, data: decoded.body.subarray(offset, offset + (size as number)) });
    offset += size as number;
  }
  if (offset !== decoded.body.length) invalid();
  return result;
}

/** POST /run: valida, executa no pool (cancelado se o cliente fechar a conexão) e responde com o quadro binário. */
async function handleRun(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const input = parseRunRequest(await readBody(request));
  const controller = new AbortController();
  // Cliente que fecha a conexão antes da resposta ("Parar" no worker) cancela a espera ou mata o processo na hora.
  response.once('close', () => {
    if (!response.writableFinished) controller.abort();
  });
  const inputBytes = input.files.reduce((total, file) => total + file.data.byteLength, 0);
  const result = await pool.run(input, controller.signal);
  const included = result.files.filter((file) => file.data !== null).map((file) => file.data as Uint8Array);
  const header: RunResponseHeader = {
    outcome: result.outcome,
    output: result.output,
    outputTruncated: result.outputTruncated,
    error: result.error,
    durationMs: result.durationMs,
    networkCalls: result.networkCalls,
    files: result.files.map(({ name, size, omitted }) => ({ name, size, omitted })),
    filesOmitted: result.filesOmitted,
  };
  const frame = encodeFrame(header, included);
  if (frame.length > LIMITS.responseMaxBytes) throw new Error('resposta acima do limite');
  log('info', 'python executado', {
    outcome: result.outcome, durationMs: result.durationMs, inputFiles: input.files.length, inputBytes,
    outputFiles: included.length, responseBytes: frame.length, networkCalls: result.networkCalls,
  });
  response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': frame.length });
  response.end(frame);
}

/** Handler central: autenticação antes de tudo, roteamento e conversão dos erros de domínio no envelope público. */
async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!authorized(request)) return sendError(response, 401, 'SANDBOX_UNAUTHORIZED', 'Token do sandbox ausente ou inválido.');
  const route = `${request.method} ${request.url}`;
  try {
    if (route === 'GET /health') {
      const status = pool.status();
      response.writeHead(status.ready + status.busy > 0 ? 200 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: status.ready + status.busy > 0 ? 'ok' : 'warming', ...status }));
      return;
    }
    if (route === 'POST /run') return await handleRun(request, response);
    sendError(response, 404, 'SANDBOX_NOT_FOUND', 'Rota inexistente.');
  } catch (error) {
    if (error instanceof InputError) return sendError(response, error.status, error.code, 'Pedido inválido para o sandbox.');
    if (error instanceof SandboxBusyError) return sendError(response, 503, 'SANDBOX_BUSY', 'Fila do sandbox cheia.');
    if (error instanceof SandboxUnavailableError) return sendError(response, 503, 'SANDBOX_UNAVAILABLE', 'Python indisponível agora.');
    if (error instanceof RunCancelledError) return void response.destroy();
    log('error', 'falha interna do sandbox', { kind: error instanceof Error ? error.name : 'desconhecido' });
    sendError(response, 500, 'SANDBOX_INTERNAL', 'Falha interna do sandbox.');
  }
}

// --- Inicialização ---
const pool = new SandboxPool(runtimeDir, log);
const server = createServer((request, response) => void handle(request, response));
// Prazos de recepção do pedido (não da execução, que tem os próprios limites).
server.headersTimeout = 30_000;
server.requestTimeout = 120_000;
server.listen(port, () => log('info', 'sandbox no ar', { port, slots: LIMITS.slots }));

// Desligamento do container: para de aceitar pedidos e encerra os processos de Python.
process.once('SIGTERM', () => {
  pool.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
});

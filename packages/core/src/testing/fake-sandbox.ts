// Sandbox FALSO do Python para os testes (phase 4, T7): fala o mesmo HTTP do serviço real (`apps/sandbox`: token Bearer, `GET /health`, `POST /run`
// com o quadro binário nos dois sentidos) sem executar nada. Prova o lado do worker (cliente, vagas, cancelamento, validação da resposta, gravação dos
// arquivos) sem Docker; o comportamento do Python de verdade é provado contra o container em `python-sandbox.test.ts`.
//
// Cada pedido passa pelo `handler` que o teste define (padrão: desfecho ok, saída com os nomes e tamanhos de /data/ e nenhum arquivo). O handler
// recebe o sinal que dispara quando o cliente fecha a conexão (o "Parar" do worker), para segurar a resposta até ele. `active` e `maxActive`
// contam os pedidos em andamento; `cancelled`, os que o cliente abandonou.
// Import de `@aion/core/testing`; nunca entra em bundle de produção.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Pedido recebido em /run, já decodificado. */
export interface FakeSandboxRequest {
  code: string;
  files: { name: string; data: Buffer }[];
}

/** Resposta que o handler devolve: o status (200 por padrão) e, no 200, o cabeçalho e os arquivos de /out/. */
export interface FakeSandboxResponse {
  status?: number;
  outcome?: 'ok' | 'PYTHON_ERROR' | 'PYTHON_TIMEOUT' | 'PYTHON_MEMORY_LIMIT';
  output?: string;
  outputTruncated?: boolean;
  error?: string | null;
  durationMs?: number;
  /** Arquivos de /out/; `omitted` manda só o nome e o tamanho (não coube na resposta). */
  files?: { name: string; data: Buffer; omitted?: boolean }[];
  filesOmitted?: number;
  /** Corpo cru no lugar do quadro (prova que o worker recusa resposta malformada). */
  raw?: Buffer;
}

export type FakeSandboxHandler = (request: FakeSandboxRequest, signal: AbortSignal) => Promise<FakeSandboxResponse> | FakeSandboxResponse;

export interface FakeSandbox {
  url: string;
  token: string;
  requests: FakeSandboxRequest[];
  /** Pedidos com o token errado ou sem token (recusados com 401). */
  unauthorized: number;
  active: number;
  maxActive: number;
  cancelled: number;
  handler: FakeSandboxHandler;
  /** Status da rota de saúde (200 pronto; 503 aquecendo). */
  healthStatus: number;
  stop(): Promise<void>;
}

const frame = (header: object, blobs: readonly Buffer[]): Buffer => {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(json.length, 0);
  return Buffer.concat([prefix, json, ...blobs]);
};

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Decodifica o quadro do pedido (o mesmo formato do serviço real). */
function decodeRequest(body: Buffer): FakeSandboxRequest {
  const length = body.readUInt32BE(0);
  const header = JSON.parse(body.subarray(4, 4 + length).toString('utf8')) as { code: string; files: { name: string; size: number }[] };
  let offset = 4 + length;
  const files = header.files.map(({ name, size }) => {
    const data = body.subarray(offset, offset + size);
    offset += size;
    return { name, data: Buffer.from(data) };
  });
  return { code: header.code, files };
}

/** Sobe o sandbox falso numa porta livre de 127.0.0.1 com um token gerado pelo teste. */
export async function startFakeSandbox(token = 'fake-sandbox-token-0123456789abcdef0123456789'): Promise<FakeSandbox> {
  const state: FakeSandbox = {
    url: '',
    token,
    requests: [],
    unauthorized: 0,
    active: 0,
    maxActive: 0,
    cancelled: 0,
    healthStatus: 200,
    handler: ({ files }) => ({ output: files.map((file) => `${file.name}:${file.data.length}`).join('\n') }),
    stop: async () => undefined,
  };
  const server: Server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      state.unauthorized += 1;
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 'SANDBOX_UNAUTHORIZED', message: 'Token do sandbox ausente ou inválido.' }));
      return;
    }
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(state.healthStatus, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: state.healthStatus === 200 ? 'ok' : 'warming' }));
      return;
    }
    void (async () => {
      const input = decodeRequest(await readBody(request));
      state.requests.push(input);
      const controller = new AbortController();
      response.once('close', () => {
        if (!response.writableFinished) {
          state.cancelled += 1;
          controller.abort();
        }
      });
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      try {
        const answer = await state.handler(input, controller.signal);
        if (controller.signal.aborted) return;
        if (answer.status && answer.status !== 200) {
          response.writeHead(answer.status, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ code: 'SANDBOX_BUSY', message: 'falso' }));
          return;
        }
        const files = answer.files ?? [];
        const body = answer.raw ?? frame(
          {
            outcome: answer.outcome ?? 'ok',
            output: answer.output ?? '',
            outputTruncated: answer.outputTruncated ?? false,
            error: answer.error ?? null,
            durationMs: answer.durationMs ?? 12,
            networkCalls: 0,
            files: files.map((file) => ({ name: file.name, size: file.data.length, omitted: file.omitted === true })),
            filesOmitted: answer.filesOmitted ?? 0,
          },
          files.filter((file) => !file.omitted).map((file) => file.data),
        );
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
        response.end(body);
      } finally {
        state.active -= 1;
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.stop = () => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return state;
}

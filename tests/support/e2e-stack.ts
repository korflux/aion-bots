// Pilha completa para o E2E da web, no formato de produção:
//   PostgreSQL embarcado -> API (bundle tsup) -> worker (bundle tsup, executa os bots) -> web (Next standalone) -> proxy reverso.
// Fora dela, os destinos falsos: OpenCode Go, Composio, Parallel e FCM (`startFakeUpstreams`) e o sandbox do Python (`e2e-sandbox.ts`, phase 4).
// O proxy imita o Traefik do Easypanel: `/api/*` vai à API, o resto à web, e o IP do cliente segue em
// X-Forwarded-For (o teste escolhe esse IP pelo cabeçalho x-e2e-client-ip, para não compartilhar bloqueios).
//
// Uso: o Playwright sobe este script como `webServer` e o encerra ao final. Com AION_E2E_SKIP_BUILD=1 pula os builds.
import { generateKeyPairSync } from 'node:crypto';
import { cpSync, existsSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { ApprovalService, GeneralChatService, createPool } from '@aion/core';
import { createTestDatabase, seedLegacyChatApproval, startFakeUpstreams, startTestPostgres, type FakeSandbox, type FakeUpstreams } from '@aion/core/testing';
import {
  E2E_CLIENT_IP_HEADER,
  E2E_FIREBASE_WEB_CONFIG,
  E2E_MASTER_KEY,
  E2E_ORIGIN,
  E2E_OWNER,
  E2E_PORTS,
  E2E_VAPID_KEY,
} from './e2e-env';
import { startE2eSandbox } from './e2e-sandbox';
import { runPnpm, spawnNode, waitUntil, type ManagedProcess } from './processes';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Mesmo destino no build, rastreamento standalone e cópia de assets; nunca recebe caminho externo.
const NEXT_BUILD_DIR = '.next-e2e';
process.env.AION_E2E_ISOLATED_BUILD = '1';
const children: ManagedProcess[] = [];
// AION_E2E_VERBOSE=1 espelha a saída de api e web no stdout do stack (o Playwright a mostra com DEBUG=pw:webserver).
const verbose = process.env.AION_E2E_VERBOSE === '1';
let stopPostgres: (() => Promise<void>) | null = null;
let stopUpstreams: (() => Promise<void>) | null = null;
let stopControl: (() => Promise<void>) | null = null;
let stopSandbox: (() => Promise<void>) | null = null;

/** Encaminha a requisição ao serviço certo, acrescentando o IP do cliente como faria o Traefik. */
function startProxy(): Promise<ReturnType<typeof createServer>> {
  const server = createServer((req, res) => {
    const toApi = req.url === '/api' || req.url?.startsWith('/api/');
    const headers = { ...req.headers };
    headers['x-forwarded-for'] = String(headers[E2E_CLIENT_IP_HEADER] ?? req.socket.remoteAddress ?? '');
    delete headers[E2E_CLIENT_IP_HEADER];
    const upstream = request(
      { host: '127.0.0.1', port: toApi ? E2E_PORTS.api : E2E_PORTS.web, method: req.method, path: req.url, headers },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  return new Promise((resolve) => server.listen(E2E_PORTS.proxy, '127.0.0.1', () => resolve(server)));
}

/** Formato de uuid que as ações de controle aceitam como identificador (nada vindo da query vai ao SQL fora de parâmetro). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Controle de teste, só desta pilha descartável (escuta só em 127.0.0.1):
 * - `POST /chat-retention` roda a retenção do chat geral com o relógio 8 dias adiante e devolve quantas sessões apagou. É a MESMA função
 *   que o job diário do worker chama (`GeneralChatService.purgeExpired`); o E2E não tem como esperar 7 dias nem o horário do job, e o
 *   agendamento do job é provado em `apps/worker`.
 * - `POST /reset-bots` apaga TODOS os bots e tudo o que depende deles (conversas, execuções, aprovações, rotinas, memórias, avisos). O
 *   produto já tem exclusão definitiva, provada pelos próprios testes; este reset prepara o cenário sem atravessar autenticação ou limites
 *   de exclusão da API. Permite repetir o spec que parte da lista vazia com `--repeat-each` no mesmo banco (E29). O `TRUNCATE ... CASCADE` leva junto, por inteiro, o que
 *   referencia bots (inclusive as sessões do chat geral e as versões da memória global), por isso só se chama NO COMEÇO do spec de bots, que
 *   roda antes dos demais que criam esse estado e quando nada está em execução no worker.
 *   ponytail: reset amplo exclusivo de testes, isolar por banco ou cenário se os specs passarem a compartilhar esta pilha em paralelo.
 * - `GET /push-events?botId=<uuid>` (phase 3, T4) lê, para o spec de notificações, o desfecho dos avisos do bot na caixa de saída (`push_events`:
 *   id, tipo, situação e motivo do descarte) e a posição de leitura da conversa dele. É o que prova, pelo banco, que um aviso terminou descartado
 *   por presença e que abrir o app não marca a conversa como lida; a API não expõe nenhum dos dois. Só ids, códigos e situação: nada da conversa.
 * - `POST /mark-all-read` (phase 3, T5) leva a leitura de TODAS as conversas até a mensagem mais recente de cada uma, pela mesma regra monotônica
 *   da presença (GREATEST). É o ponto de partida "sem novidade" da prova da bolinha: os specs anteriores deixam conversas com respostas nunca
 *   abertas, e ler cada uma pela tela ou pela presença custaria dezenas de escritas. A leitura que a prova exercita (presença do navegador) não
 *   passa por aqui.
 * - `POST /sandbox-health?status=200|503` (phase 4, T8) troca a resposta da saúde do sandbox falso do Python: 503 é o sandbox configurado que não
 *   respondeu pronto ("Indisponível agora" em Configurações → Python), 200 o devolve a "Disponível". É a única forma de o E2E ver o estado sem
 *   derrubar o sandbox, que o worker da pilha usa nos outros specs. O spec sempre o devolve a 200.
 * - `POST /seed-legacy-connector-approval?sessionId=<uuid>[&input=<texto>]` (phase 13, A6 e A7) deixa numa sessão do Chat geral uma aprovação PENDENTE de ação do conector, como a phase 12 a
 *   gravava: a execução espera, a atividade está "aguardando" e o pedido e o cartão nascem pelo `ApprovalService`, o mesmo código de produção. A semeadura é `seedLegacyChatApproval`
 *   (`@aion/core/testing`), a MESMA fonte dos testes do núcleo e da API: os specs rodam no navegador e não a importam, então a chamam por esta rota. O conector saiu do Chat geral, então nenhuma
 *   mensagem a cria mais; o E2E não tem outro jeito de ter a pendência antiga (a que o dono ainda pode responder depois do deploy). Não enfileira aviso push (o que o E2E prova não depende
 *   dele). Devolve `{ runId, approvalId }`.
 * - `GET /composio-executions` (phase 13, A7) devolve quantas execuções de ação o Composio falso recebeu desde o início da pilha: é o que prova, de fora do processo, que a recusa da pendência
 *   antiga do Chat geral não chegou ao Composio. Só um número: nada dos argumentos nem da chave.
 */
function startControl(databaseUrl: string, sandbox: FakeSandbox, upstreams: FakeUpstreams): Promise<{ stop: () => Promise<void> }> {
  const pool = createPool(databaseUrl, { applicationName: 'e2e-control', max: 2 });
  const chat = new GeneralChatService({ pool, now: () => new Date(Date.now() + 8 * 86_400_000) });
  const approvals = new ApprovalService({ pool });
  const actions: Record<string, (query: URLSearchParams) => Promise<unknown>> = {
    'POST /chat-retention': async () => ({ removed: await chat.purgeExpired() }),
    'POST /reset-bots': async () => {
      await pool.query('TRUNCATE bots CASCADE');
      return { reset: true };
    },
    'POST /mark-all-read': async () => {
      const updated = await pool.query(
        `UPDATE conversations c SET read_through_message_id = GREATEST(c.read_through_message_id, last.id)
           FROM (SELECT conversation_id, max(id) AS id FROM messages GROUP BY conversation_id) last
          WHERE last.conversation_id = c.id`,
      );
      return { updated: updated.rowCount };
    },
    'POST /sandbox-health': async (query) => {
      const status = Number(query.get('status'));
      if (status !== 200 && status !== 503) throw new Error('status inválido');
      sandbox.healthStatus = status;
      return { healthStatus: status };
    },
    'POST /seed-legacy-connector-approval': async (query) => {
      const sessionId = query.get('sessionId') ?? '';
      if (!UUID.test(sessionId)) throw new Error('sessionId inválido');
      const input = query.get('input') ?? '[gmail] envie o relatório';
      if (input.length < 1 || input.length > 200) throw new Error('input inválido');
      return seedLegacyChatApproval({ pool, approvals, sessionId, input });
    },
    'GET /composio-executions': async () => ({
      executions: upstreams.requests.filter((recorded) => recorded.service === 'composio' && recorded.path.includes('/tools/execute/')).length,
    }),
    'GET /push-events': async (query) => {
      const botId = query.get('botId') ?? '';
      if (!UUID.test(botId)) throw new Error('botId inválido');
      const events = await pool.query(
        `SELECT id::text AS id, kind, status, drop_reason AS "dropReason" FROM push_events WHERE bot_id = $1 ORDER BY id`,
        [botId],
      );
      const read = await pool.query<{ readThrough: string | null }>(
        'SELECT read_through_message_id::text AS "readThrough" FROM conversations WHERE bot_id = $1',
        [botId],
      );
      return { events: events.rows, readThrough: read.rows[0]?.readThrough ?? null };
    },
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const action = actions[`${req.method} ${url.pathname}`];
    if (!action) {
      res.writeHead(404).end();
      return;
    }
    action(url.searchParams).then(
      (body) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body)),
      (error: unknown) => res.writeHead(500).end(String(error)),
    );
  });
  return new Promise((resolve) =>
    server.listen(E2E_PORTS.control, '127.0.0.1', () =>
      resolve({
        stop: async () => {
          server.close();
          await pool.end();
        },
      }),
    ),
  );
}

async function shutdown(code: number): Promise<never> {
  await Promise.all(children.map((child) => child.stop().catch(() => undefined)));
  await stopControl?.().catch(() => undefined);
  await stopSandbox?.().catch(() => undefined);
  await stopUpstreams?.().catch(() => undefined);
  await stopPostgres?.().catch(() => undefined);
  process.exit(code);
}

async function main(): Promise<void> {
  if (process.env.AION_E2E_SKIP_BUILD !== '1') {
    runPnpm(['--filter', '@aion/api', '--filter', '@aion/worker', '--filter', '@aion/web', 'build'], ROOT);
  }

  // O standalone do Next não copia estáticos: mesmo passo que o Dockerfile da web faz.
  const standalone = `${ROOT}apps/web/${NEXT_BUILD_DIR}/standalone/apps/web`;
  cpSync(`${ROOT}apps/web/${NEXT_BUILD_DIR}/static`, `${standalone}/${NEXT_BUILD_DIR}/static`, { recursive: true });
  if (existsSync(`${ROOT}apps/web/public`)) cpSync(`${ROOT}apps/web/public`, `${standalone}/public`, { recursive: true });

  const postgres = await startTestPostgres();
  stopPostgres = postgres.stop;
  const database = await createTestDatabase(postgres.adminUrl);
  // OpenCode Go, Composio, Parallel e FCM falsos: o comportamento depende do prefixo da chave (ou do token de push) digitada (ver fake-upstreams.ts).
  // Porta fixa: os specs de notificações leem as mensagens que o FCM falso recebeu.
  const upstreams = await startFakeUpstreams({ port: E2E_PORTS.fakes });
  stopUpstreams = upstreams.stop;
  // Sandbox do Python falso (phase 4, T8): endereço e token de TESTE vão à API (estado em Configurações) e ao worker (a ferramenta `run_python`).
  const sandbox = await startE2eSandbox();
  stopSandbox = sandbox.stop;

  const api = spawnNode(['dist/main.js'], {
    echoPrefix: verbose ? '[api] ' : undefined,
    cwd: `${ROOT}apps/api`,
    env: {
      NODE_ENV: 'production',
      PORT: String(E2E_PORTS.api),
      DATABASE_URL: database.url,
      AION_OWNER_EMAIL: E2E_OWNER.email,
      AION_OWNER_PASSWORD: E2E_OWNER.password,
      AION_MASTER_KEY: E2E_MASTER_KEY,
      AION_PUBLIC_ORIGIN: E2E_ORIGIN,
      // Banco descartável precisa do schema final: liga a permissão da migration destrutiva 0028 (remove `bots.mascot`). O padrão de produção continua `false`.
      AION_ALLOW_DESTRUCTIVE_MIGRATIONS: 'true',
      AION_OPENCODE_GO_BASE_URL: upstreams.opencodeGoBaseUrl,
      AION_ANTHROPIC_BASE_URL: upstreams.anthropicBaseUrl,
      AION_COMPOSIO_BASE_URL: upstreams.composioBaseUrl,
      // Pesquisa na web (phase 1, T8): a API só valida a chave opcional da Parallel falsa ao salvá-la.
      AION_PARALLEL_BASE_URL: upstreams.parallelBaseUrl,
      // Web push (T10): a API só entrega ao navegador a configuração PÚBLICA do Firebase e a chave VAPID.
      AION_FCM_WEB_CONFIG: JSON.stringify(E2E_FIREBASE_WEB_CONFIG),
      AION_FCM_VAPID_KEY: E2E_VAPID_KEY,
      AION_SANDBOX_URL: sandbox.url,
      AION_SANDBOX_TOKEN: sandbox.token,
    },
  });
  // O worker executa os bots (T6). Só recebe o que precisa: banco, chave mestra e os destinos de saída (o provedor falso).
  const worker = spawnNode(['dist/main.js'], {
    echoPrefix: verbose ? '[worker] ' : undefined,
    cwd: `${ROOT}apps/worker`,
    env: {
      NODE_ENV: 'production',
      DATABASE_URL: database.url,
      AION_MASTER_KEY: E2E_MASTER_KEY,
      AION_OPENCODE_GO_BASE_URL: upstreams.opencodeGoBaseUrl,
      AION_ANTHROPIC_BASE_URL: upstreams.anthropicBaseUrl,
      AION_COMPOSIO_BASE_URL: upstreams.composioBaseUrl,
      AION_PARALLEL_BASE_URL: upstreams.parallelBaseUrl,
      // Web push (T10): conta de serviço de TESTE (chave RSA gerada agora, nunca gravada) e o FCM falso como destino.
      AION_FCM_SERVICE_ACCOUNT: JSON.stringify({
        project_id: E2E_FIREBASE_WEB_CONFIG.projectId,
        client_email: 'push@aion-e2e.iam.gserviceaccount.com',
        private_key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      }),
      AION_FCM_BASE_URL: upstreams.fcmBaseUrl,
      AION_FCM_TOKEN_URL: upstreams.fcmTokenUrl,
      AION_SANDBOX_URL: sandbox.url,
      AION_SANDBOX_TOKEN: sandbox.token,
    },
  });
  const web = spawnNode(['server.js'], {
    echoPrefix: verbose ? '[web] ' : undefined,
    cwd: standalone,
    env: {
      NODE_ENV: 'production',
      PORT: String(E2E_PORTS.web),
      HOSTNAME: '127.0.0.1',
      AION_API_INTERNAL_URL: `http://127.0.0.1:${E2E_PORTS.api}`,
      AION_PUBLIC_ORIGIN: E2E_ORIGIN,
    },
  });
  children.push(api, worker, web);
  void worker.exited.then((code) => {
    process.stderr.write(`[e2e-stack] worker encerrou (${code}):\n${worker.output()}\n`);
    return shutdown(1);
  });
  void api.exited.then((code) => {
    process.stderr.write(`[e2e-stack] api encerrou (${code}):\n${api.output()}\n`);
    return shutdown(1);
  });
  void web.exited.then((code) => {
    process.stderr.write(`[e2e-stack] web encerrou (${code}):\n${web.output()}\n`);
    return shutdown(1);
  });

  await api.waitForOutput(/api no ar/, 60_000);
  await worker.waitForOutput(/worker conectado à fila/, 60_000);
  await startProxy();
  stopControl = (await startControl(database.url, sandbox, upstreams)).stop;
  await waitUntil(async () => (await fetch(`http://127.0.0.1:${E2E_PORTS.proxy}/login`)).ok, {
    description: 'a web responder em /login',
    timeoutMs: 60_000,
  });
  process.stdout.write(`E2E_STACK_READY ${E2E_ORIGIN}\n`);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
main().catch((error: unknown) => {
  process.stderr.write(`[e2e-stack] falha ao subir: ${String(error)}\n`);
  void shutdown(1);
});

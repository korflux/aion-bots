// Apoio dos testes das execuções (T6): um mundo completo e descartável com PostgreSQL real, o provedor falso e os serviços de
// verdade (bots, modelos, conversa e motor de execução), com tempos curtos no motor para provar cada limite sem esperar.
// Só testes importam este arquivo; ele não sai no bundle de produção (nada em `src/index.ts` o exporta).
import type { Bot, BotCreate, ContextWindowTokens } from '@aion/shared';
import { inject } from 'vitest';
import { ApprovalService } from '../approvals/service';
import { BotService } from '../bots/service';
import { ConversationService } from '../conversation/service';
import { ConnectorAccountService } from '../credentials/accounts';
import { DomainError } from '../errors';
import { createComposioClient } from '../credentials/composio';
import { createParallelClient } from '../credentials/parallel';
import { createAnthropicClient } from '../credentials/anthropic';
import { createCreditsState } from '../credentials/credits-state';
import { createOpenCodeGoClient, type ProviderClient } from '../credentials/opencode-go';
import { CredentialService } from '../credentials/service';
import { sealSecret } from '../crypto/secret-box';
import { migrateTestDatabase } from '../testing/migrate';
import { createPool, withTransaction, type Pool } from '../db/pool';
import { queueRun } from '../conversation/run-queue';
import { createLogger, type Logger } from '../logging';
import { MemoryService } from '../memory/service';
import { ModelService, createProviderRouter } from '../models/service';
import { PythonSandboxClient } from '../python/client';
import { RoutineScheduler } from '../routines/scheduler';
import { RoutineService } from '../routines/service';
import { startFakeUpstreams, type FakeUpstreams } from '../testing/fake-upstreams';
import { createTestDatabase, type TestDatabase } from '../testing/postgres';
import { RunEngine } from './engine';
import type { RunEngineConfig } from './executor';
import type { ToolHandler } from './tools';

/** Tempos curtos: o motor reage em dezenas de milissegundos e uma posse abandonada vence em meio segundo. */
export const FAST_ENGINE: Partial<RunEngineConfig> = { pollMs: 20, heartbeatMs: 40, flushMs: 15, leaseMs: 600 };

/**
 * Tempos do motor com o modelo REAL (phase 15, passo 3, banco de testes): uma chamada de chat leva segundos, então a posse de 600 ms de `FAST_ENGINE` venceria no meio dela e outro
 * motor a roubaria. O despacho continua rápido; a posse e o pulso de renovação seguem a escala de produção. O prazo da chamada de chat (15 s no provedor falso) é do cliente que o
 * chamador passa em `RunsWorldOptions.realModel.provider` (`createOpenCodeGoClient({ chatTimeoutMs })`), então o padrão dos testes comuns não muda.
 */
export const REAL_MODEL_ENGINE: Partial<RunEngineConfig> = { pollMs: 50, heartbeatMs: 5_000, flushMs: 50, leaseMs: 60_000 };

export const ORIGIN = { ip: '127.0.0.1', userAgent: 'teste' };

/** Espera a condição (a cada 15 ms) com prazo monotônico: relógios de domínio simulados não podem congelar a espera de uma prova. */
export async function waitFor<T>(description: string, probe: () => Promise<T | null | false | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (performance.now() >= deadline) throw new Error(`prazo estourado esperando: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/**
 * Provedor REAL no mundo de teste (phase 15, passo 3): o cliente já montado pelo chamador (com o prazo de chamada que ele escolher e, no banco de testes com modelo real, o
 * guarda de gasto por cima), a chave e o modelo. A chave é gravada cifrada SEM a validação do serviço de credenciais (que faria uma chamada de chat paga por mundo) e o
 * perfil do modelo é gravado como testado no protocolo `chat_completions`, o que o `deepseek-v4.1-flash` usa; a listagem de modelos (GET /models) continua real e gratuita.
 */
export interface RealModelOptions {
  provider: ProviderClient;
  apiKey: string;
  model: string;
}

export interface RunsWorldOptions {
  /** PostgreSQL de teste (URL de administração). Padrão: o do `globalSetup` do vitest (`inject`); quem roda fora do vitest (o banco de testes com modelo real) passa o seu. */
  adminDatabaseUrl?: string;
  /** Provedor real no lugar do falso (ver `RealModelOptions`). O Composio, a Parallel e o sandbox seguem falsos. */
  realModel?: RealModelOptions;
  engine?: Partial<RunEngineConfig>;
  tools?: readonly ToolHandler[];
  now?: () => Date;
  /**
   * O motor recebe a Parallel falsa e oferece `web_search` e `web_fetch` (T9; com o interruptor ligado, que é o padrão do banco). O PADRÃO É FALSO: a
   * pesquisa vem ligada em produção, e os testes das demais tasks, que afirmam a lista EXATA de ferramentas, rodam sem ela. Quem testa a pesquisa na web
   * liga aqui (e pode encurtar o prazo de uma chamada com `callTimeoutMs`).
   */
  webSearch?: boolean | { callTimeoutMs: number };
  /**
   * Sandbox do Python (phase 4, T7): com ele o motor oferece `run_python` (o sandbox falso de `testing/fake-sandbox.ts` ou o container real). O PADRÃO É
   * SEM, como em produção sem a configuração. `maxTotalBytes` é o espaço global de anexos (padrão 1 GiB).
   */
  python?: { url: string; token: string; requestTimeoutMs?: number; maxTotalBytes?: number };
  /**
   * Catálogo fixo (`RunEngineOptions.coreCatalog`): as mais usadas na lista do bot (`DEFAULT_MOST_USED`) e as core do Chat geral. O PADRÃO É FALSO nos testes (o bot publica só as portas): com ele o catálogo base passa de 20k bytes e, na janela
   * pequena (64k) sem calibração dos mundos de teste, as provas de pressão de contexto deixariam de medir o que se propõem. Quem testa o catálogo core liga aqui
   * (e escolhe a janela do bot).
   */
  coreCatalog?: boolean;
  /**
   * Janela de contexto global (bots e Chat geral) do mundo. O PADRÃO DO MUNDO DE TESTE É 64k (`TEST_WORLD_CONTEXT_WINDOW`), NÃO o do produto (256k desde a migration
   * 0046, `DEFAULT_CONTEXT_WINDOW`): as provas de pressão de contexto (compactação, resumo, orçamento) foram calibradas para uma janela pequena, onde o limiar de
   * 90% se alcança com poucos KB de histórico sintético, e o padrão do produto já mudou mais de uma vez. Quem precisa de outra janela a fixa aqui;
   * `'product'` não grava nada e deixa o padrão real do banco (a prova do próprio padrão e da migration). 64k é a menor opção do produto (o 32k saiu na phase 11).
   */
  contextWindow?: ContextWindowTokens | 'product';
  /** Logger do motor e das ferramentas (padrão: silencioso). Os testes de log passam um que captura as linhas. */
  logger?: Logger;
}

/** Linha da conversa reduzida ao que os testes afirmam. */
export interface TimelineEntry {
  id: string;
  runId: string | null;
  role: string;
  kind: string;
  status: string;
  content: string;
  data: Record<string, unknown>;
}

/** A primeira conta ATIVA de cada app do Composio falso: a que os bots usavam antes de as contas serem liberadas por bot (Gmail `ca_1`, GitHub `ca_3`; `ca_6` é o segundo Gmail ativo). */
export const FAKE_FIRST_ACTIVE_ACCOUNTS: readonly string[] = ['ca_1', 'ca_3'];

/** Chave mestra dos mundos de teste (a mesma do `CredentialService`): os testes que gravam uma credencial sem validar a cifram com ela. */
const MASTER_KEY = Buffer.alloc(32, 7);

/** Janela global dos mundos de teste que não pedem outra: a menor opção do produto (ver `RunsWorldOptions.contextWindow`). */
export const TEST_WORLD_CONTEXT_WINDOW: ContextWindowTokens = 65536;

export async function createRunsWorld({ adminDatabaseUrl, realModel, engine: engineConfig = {}, tools, now, webSearch: withWebSearch = false, python: withPython, coreCatalog = false, contextWindow = TEST_WORLD_CONTEXT_WINDOW, logger: customLogger }: RunsWorldOptions = {}) {
  const database: TestDatabase = await createTestDatabase(adminDatabaseUrl ?? inject('adminDatabaseUrl'));
  const pool: Pool = createPool(database.url, { applicationName: 'runs-test', max: 20 });
  await migrateTestDatabase(pool);
  if (contextWindow !== 'product') await pool.query('UPDATE app_settings SET bot_context_window_tokens = $1, general_chat_context_window_tokens = $1', [contextWindow]);
  const upstreams: FakeUpstreams = await startFakeUpstreams();
  const logger = customLogger ?? createLogger({ level: 'silent', name: 'runs-test' });
  // O cliente de chat é o roteador por provedor (como no worker): `opencode/...` vai ao OpenCode Go (o falso, ou o real do `realModel`) e `anthropic/...` à Anthropic falsa.
  const opencode: ProviderClient = realModel?.provider ?? createOpenCodeGoClient({ baseUrl: upstreams.opencodeGoBaseUrl, chatTimeoutMs: 15_000 });
  const anthropic = createAnthropicClient({ baseUrl: upstreams.anthropicBaseUrl, chatTimeoutMs: 15_000 });
  const provider: ProviderClient = createProviderRouter({ opencode, anthropic, creditsState: createCreditsState(pool, logger) });
  const connector = createComposioClient({ baseUrl: upstreams.composioBaseUrl });
  const webSearch = createParallelClient({ baseUrl: upstreams.parallelBaseUrl, ...(typeof withWebSearch === 'object' ? withWebSearch : {}) });
  const credentials = new CredentialService({ pool, masterKey: MASTER_KEY, provider: opencode, anthropic, connector, webSearch, logger });
  // A Parallel só vai ao motor quando o teste a pede (ver `RunsWorldOptions.webSearch`).
  const engineWebSearch = withWebSearch === false ? {} : { webSearch };
  // Um cliente só (dono das vagas) para todos os motores do mundo, como um processo do worker.
  const python = withPython
    ? { client: new PythonSandboxClient({ url: withPython.url, token: withPython.token, logger, ...(withPython.requestTimeoutMs ? { requestTimeoutMs: withPython.requestTimeoutMs } : {}) }), maxTotalBytes: withPython.maxTotalBytes ?? 1024 * 1024 * 1024 }
    : undefined;
  const enginePython = python ? { python } : {};
  const models = new ModelService({ pool, credentials, provider, anthropic, logger });
  const bots = new BotService({ pool, models });
  const conversations = new ConversationService({ pool, credentials, models, now });
  const engine = new RunEngine({ pool, credentials, provider, models, logger, tools, coreCatalog, connector, ...engineWebSearch, ...enginePython, now, config: { ...FAST_ENGINE, ...engineConfig } });
  const approvals = new ApprovalService({ pool, now });
  // Serviço das contas do conector (phase 13): o banco do teste nasce sem nenhuma liberação (A15) e quem cria bots precisa liberar a conta que o bot usa (`releaseConnectorAccounts`).
  const accounts = new ConnectorAccountService({ pool, source: credentials, now });
  const memory = new MemoryService({ pool, now });
  const routines = new RoutineService({ pool, credentials, now });
  // Agendador sem `start()`: os testes o acionam à mão (`tickOnce`) com o relógio que controlam.
  const scheduler = new RoutineScheduler({ pool, logger, now });
  if (realModel) {
    // Sem `credentials.save`: a validação do serviço faz uma chamada de chat paga por mundo. A chave entra cifrada como o serviço a gravaria, e o perfil nasce testado.
    await pool.query(
      `INSERT INTO credentials (kind, secret_sealed, masked, created_at, updated_at) VALUES ('provider', $1, $2, now(), now())`,
      [sealSecret(MASTER_KEY, 'provider-key', realModel.apiKey), `••••${realModel.apiKey.slice(-4)}`],
    );
    await pool.query(
      `INSERT INTO model_profiles (model_id, test_status, test_protocol, effort_levels, tested_at, created_at, updated_at) VALUES ($1, 'ok', 'chat_completions', '{}', now(), now(), now())`,
      [realModel.model],
    );
  } else {
    await credentials.save('provider', 'valid-key-1111', ORIGIN);
  }

  let created = 0;
  return {
    pool,
    upstreams,
    credentials,
    accounts,
    models,
    approvals,
    memory,
    routines,
    scheduler,
    bots,
    conversations,
    engine,
    provider,
    logger,
    /** Cliente compartilhado de Python: permite ocupar vagas sem associar o prazo dos ocupantes ao da execução sob prova. */
    pythonClient: python?.client,

    /** Outro motor sobre o mesmo mundo (o primeiro, depois de `stop()`, não reinicia): simula outro worker. */
    createEngine(config: Partial<RunEngineConfig> = {}): RunEngine {
      return new RunEngine({ pool, credentials, provider, models, logger, tools, coreCatalog, connector, ...engineWebSearch, ...enginePython, now, config: { ...FAST_ENGINE, ...engineConfig, ...config } });
    },

    /**
     * Grava a chave da pesquisa na web SEM validá-la (cifrada como o serviço faz). As chaves de cenário da Parallel falsa (`limited...`, `invalid...`,
     * `slow...`) fariam a validação recusar a chave, então os testes das falhas da chamada a gravam por aqui.
     */
    async setWebSearchKeyUnvalidated(key: string): Promise<void> {
      await pool.query(
        `INSERT INTO credentials (kind, secret_sealed, masked, created_at, updated_at) VALUES ('web_search', $1, $2, now(), now())
         ON CONFLICT (kind) DO UPDATE SET secret_sealed = EXCLUDED.secret_sealed, masked = EXCLUDED.masked, updated_at = now()`,
        [sealSecret(MASTER_KEY, 'web-search-key', key), `••••${key.slice(-4)}`],
      );
    },

    /** As chamadas `tools/call` que a Parallel falsa recebeu, na ordem (a pesquisa de validação da chave também entra, com a ferramenta `web_search`). */
    parallelCalls() {
      return upstreams.requests.filter((request) => request.service === 'parallel' && request.body !== undefined);
    },

    /** Bot novo com o modelo `opencode/glm-5.1` (chat/completions, com ferramenta) por padrão; `overrides` sobrescreve qualquer campo. */
    async createBot(overrides: Partial<BotCreate> = {}): Promise<Bot> {
      created += 1;
      return bots.create(
        { name: `Bot ${created}`, color: '#60A5FA', instructions: '', model: 'opencode/glm-5.1', effort: null, stepLimit: 25, ...overrides },
        ORIGIN,
      );
    },

    /** A linha do tempo completa do bot (inclusive descartadas), em ordem. */
    async timeline(bot: Bot): Promise<TimelineEntry[]> {
      const rows = await pool.query<TimelineEntry & { run_id: string | null }>(
        `SELECT m.id::text AS id, m.run_id::text AS "runId", m.role, m.kind, m.status, m.content, m.data
         FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.bot_id = $1 ORDER BY m.id`,
        [bot.id],
      );
      return rows.rows;
    },

    /** Estado de uma execução direto do banco. */
    async runRow(id: string) {
      const row = await pool.query<{ status: string; failure_code: string | null; tool_calls: number; active_ms: number; lease_until: Date | null }>(
        'SELECT status, failure_code, tool_calls, active_ms, lease_until FROM runs WHERE id = $1',
        [id],
      );
      return row.rows[0]!;
    },

    /** Conecta a Anthropic (chave válida do fake): os modelos `anthropic/...` entram no catálogo e passam a ser chamados com a chave dela (phase 17). */
    async connectAnthropic(): Promise<void> {
      await credentials.save('anthropic', 'valid-anthropic-QRST', ORIGIN);
    },

    /** Conecta o Composio (chave válida do fake): as ações dos apps conectados passam a ser oferecidas aos bots (T7). */
    async connectComposio(): Promise<void> {
      await credentials.save('connector', 'valid-key-2222', ORIGIN);
    },

    /**
     * Libera contas do conector ao bot (phase 13, CONN-02), ACRESCENTANDO às que o bot já tem. É o que todo teste que executa uma ação do conector por um bot faz explicitamente, porque o banco
     * do teste nasce sem liberação (A15) e o bot novo, sem nenhuma conta (A16). O padrão é a conta que os bots usavam antes da phase, a primeira ATIVA de cada app do Composio falso
     * (`FAKE_FIRST_ACTIVE_ACCOUNTS`: Gmail `ca_1` e GitHub `ca_3`). Exige `connectComposio()` antes (a leitura das contas usa a chave). Testes que preparam bots em paralelo disputam a
     * versão da conta (`CONNECTOR_ACCOUNT_CONFLICT`): a liberação relê e tenta de novo, como a tela de Conexões faria depois de recarregar.
     */
    async releaseConnectorAccounts(bot: Pick<Bot, 'id'>, accountIds: readonly string[] = FAKE_FIRST_ACTIVE_ACCOUNTS): Promise<void> {
      for (const accountId of accountIds) {
        for (let attempt = 1; ; attempt += 1) {
          const view = await accounts.get(accountId);
          if (view.botIds.includes(bot.id)) break;
          try {
            await accounts.release(accountId, { botIds: [...view.botIds, bot.id], expectedVersion: view.version }, ORIGIN);
            break;
          } catch (error) {
            if (!(error instanceof DomainError && error.code === 'CONNECTOR_ACCOUNT_CONFLICT') || attempt >= 10) throw error;
          }
        }
      }
    },

    /** Execuções de ação recebidas pelo Composio falso (corpo com a conta e os argumentos), na ordem em que chegaram. */
    composioExecutions() {
      return upstreams.requests.filter((request) => request.service === 'composio' && request.path.includes('/tools/execute/'));
    },

    /** O pedido de aprovação mais recente de uma execução (estado direto do banco). */
    async approvalOf(runId: string) {
      const row = await pool.query<{ id: string; status: string; decision: string | null; consumed: boolean }>(
        'SELECT id::text AS id, status, decision, consumed_at IS NOT NULL AS consumed FROM approvals WHERE run_id = $1 ORDER BY approvals.id DESC LIMIT 1',
        [runId],
      );
      return row.rows[0] ?? null;
    },

    /** Espera a execução chegar ao estado dado. */
    waitForStatus(id: string, status: string, timeoutMs?: number) {
      return waitFor(`execução ${id} em ${status}`, async () => ((await this.runRow(id)).status === status ? true : null), timeoutMs);
    },

    /** Envia uma mensagem e devolve o id da execução criada (ou do complemento, se a conversa já tinha execução ativa: CONV-03). */
    async send(bot: Bot, text: string): Promise<string> {
      return (await conversations.send(bot.id, text)).id;
    },

    /**
     * Põe uma mensagem do dono na FILA da conversa mesmo com uma execução ativa, pela mesma `queueRun` do envio (trava, teto de 20 e evento). Desde a
     * phase 4 o envio de verdade, com execução ativa, vira complemento (CONV-03); a fila atrás da ativa continua existindo (rotinas, mensagens
     * enviadas antes de a anterior começar), e os testes da fila a montam por aqui sem depender do instante em que o motor reivindica a anterior.
     */
    async enqueue(owner: Bot | { sessionId: string }, text: string): Promise<string> {
      const botId = 'sessionId' in owner ? null : owner.id;
      const conversationId = 'sessionId' in owner ? owner.sessionId : await conversations.conversationIdOf(owner.id);
      return (await withTransaction(pool, (tx) => queueRun(tx, { botId, conversationId, input: text, at: (now ?? (() => new Date()))(), enforceLimit: true }))).id;
    },

    /** Corpos das chamadas de chat do motor (as que trazem instruções de sistema), na ordem em que chegaram. */
    conversationRequests() {
      return upstreams.requests.filter((request) => request.body !== undefined && request.path.endsWith('/chat/completions') && hasSystemTurn(request.body));
    },

    async cleanup() {
      await engine.stop().catch(() => undefined);
      await upstreams.stop();
      await pool.end().catch(() => undefined);
      await database.drop();
    },
  };
}

export type RunsWorld = Awaited<ReturnType<typeof createRunsWorld>>;

/** A chamada de chat/completions é do motor (o primeiro turno é de sistema)? */
function hasSystemTurn(body: Record<string, unknown>): boolean {
  return (body.messages as { role?: string }[] | undefined)?.[0]?.role === 'system';
}

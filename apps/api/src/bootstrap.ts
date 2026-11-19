// Sequência de subida da API, na ordem que garante um estado seguro antes de aceitar tráfego:
//   configuração válida -> banco disponível -> migrations -> credencial do dono (impressão) -> reset do TOTP
//   (se AION_TOTP_RESET=true) -> app -> listen.
//
// Qualquer falha antes do `listen` aborta a subida. A senha do dono só existe aqui para gerar o verificador
// (hash Argon2id em memória) e a impressão; depois disso nada mais no processo a referencia.
import {
  ActivityService,
  ApprovalService,
  AuthService,
  ComposioToolSource,
  ConnectorAccountService,
  ConversationService,
  CredentialService,
  GeneralChatService,
  createAnthropicClient,
  createComposioClient,
  createCreditsState,
  createCredentialVerifier,
  createLogger,
  createOpenCodeGoClient,
  createParallelClient,
  createPool,
  createProviderRouter,
  MemoryService,
  ModelService,
  PushService,
  PythonSandboxClient,
  RoutineService,
  SettingsService,
  loadApiConfig,
  runMigrations,
  assertUtf8Database,
  waitForDatabase,
  type Env,
  type LogDestination,
  type Logger,
  type Pool,
} from '@aion/core';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppOptions } from './app';

export interface ApiRuntime {
  app: FastifyInstance;
  pool: Pool;
  auth: AuthService;
  credentials: CredentialService;
  models: ModelService;
  conversations: ConversationService;
  chat: GeneralChatService;
  approvals: ApprovalService;
  activities: ActivityService;
  memory: MemoryService;
  routines: RoutineService;
  push: PushService;
  logger: Logger;
  port: number;
  /** Encerra servidor e pool de forma ordenada. */
  close(): Promise<void>;
}

export interface CreateApiOptions {
  /** Destino alternativo dos logs (os testes capturam aqui para provar que não vazam segredos). */
  logDestination?: LogDestination;
  /** Tempos do SSE da conversa (os testes encurtam; em produção valem os padrões). */
  sse?: AppOptions['sse'];
}

/** Tudo da subida, exceto abrir a porta. Testes usam `app.inject` sobre o resultado. */
export async function createApi(env: Env, { logDestination, sse }: CreateApiOptions = {}): Promise<ApiRuntime> {
  const { ownerPassword, ownerEmail, masterKey, ...config } = loadApiConfig(env);
  const logger = createLogger({ level: config.logLevel, name: 'api', destination: logDestination });
  // Variável OPCIONAL inválida (hoje só as do push) não impede a subida: o erro vai para o log, só com o nome da variável e a dica de formato.
  for (const issue of config.warnings) logger.error({ variable: issue.variable, problem: issue.problem }, 'configuração opcional ignorada');
  const pool = createPool(config.databaseUrl, { applicationName: 'aion-api', logger });

  try {
    await waitForDatabase(pool, { logger });
    await assertUtf8Database(pool);
    await runMigrations(pool, { allowDestructive: config.allowDestructiveMigrations, logger });

    const verifier = await createCredentialVerifier({ email: ownerEmail, password: ownerPassword }, masterKey);
    const auth = new AuthService({ pool, verifier, masterKey, logger });
    await auth.syncCredentialFingerprint();
    // Recuperação de acesso: com a variável ligada, o autenticador é desativado antes de aceitar qualquer login.
    if (config.totpReset) await auth.resetTotp();

    // Chaves de terceiros (T3). Os destinos de rede são fixos na configuração do servidor.
    const opencode = createOpenCodeGoClient({ baseUrl: config.opencodeGoBaseUrl, logger });
    // Anthropic (phase 17): a chave dela só é provada ao salvar; o chat roda no worker. O roteador escolhe o provedor pelo prefixo do modelo (`opencode/`, `anthropic/`).
    const anthropic = createAnthropicClient({ baseUrl: config.anthropicBaseUrl, logger });
    const provider = createProviderRouter({ opencode, anthropic, creditsState: createCreditsState(pool, logger) });
    const connector = createComposioClient({ baseUrl: config.composioBaseUrl, logger });
    // Pesquisa na web (phase 1, T8): a Parallel só valida a chave opcional ao salvá-la; as ferramentas de pesquisa rodam no worker (T9).
    const webSearch = createParallelClient({ baseUrl: config.parallelBaseUrl, logger });
    const credentials = new CredentialService({ pool, masterKey, provider: opencode, anthropic, connector, webSearch, logger });
    // Modelos (T5): lista, teste da primeira seleção e favoritos, com a mesma chave do provedor e o mesmo destino fixo.
    const models = new ModelService({ pool, credentials, provider, anthropic, logger });
    // A capacidade confirmada dos modelos da Anthropic alimenta a janela de contexto que a API mostra; aquece o cache sem atrasar a subida nem derrubá-la (a falha só vai ao log).
    void models.warmCapacity();
    // Conversa do bot (T6): a API só enfileira, lê e transmite; quem chama o modelo é o worker.
    const conversations = new ConversationService({ pool, credentials, models });
    // Chat geral (T12): sessões temporárias (conversa sem bot). A conversa dentro delas usa o serviço acima; a retenção de 7 dias roda no worker.
    const chat = new GeneralChatService({ pool });
    // Aprovações (T7): a API só registra a decisão do dono e edita regras; quem retoma a execução é o worker.
    const approvals = new ApprovalService({ pool });
    // Catálogo da tela Aprovações: a MESMA fonte do conector que o worker usa (um cache próprio de 60 s por processo). A tela pré-registra as ações
    // "importantes" de cada app conectado, antes de qualquer uso, para o dono definir a regra de antemão; o bot alcança todas pela busca (T29).
    // O serviço de contas (phase 13) serve à fonte só para gravar as contas lidas e concluir a semeadura da liberação na primeira leitura boa; o catálogo em si não depende de conta nem de bot.
    const composioTools = new ComposioToolSource({ credentials, connector, accounts: new ConnectorAccountService({ pool, source: credentials }), logger });
    const toolCatalog = () => composioTools.catalog();
    // Atividades (T11): índice de leitura sobre aprovações pendentes e execuções de todos os bots; não escreve nada.
    const activities = new ActivityService({ pool });
    // Memória global e por bot (T8): telas de edição, histórico e restauração. A edição feita pelo bot roda no worker.
    const memory = new MemoryService({ pool });
    // Rotinas (T9): a API cria, edita e gere; quem dispara as execuções agendadas é o agendador do worker.
    const routines = new RoutineService({ pool, credentials });
    // Preferências gerais (T28): idioma das respostas dos bots e fuso horário do dono; o worker as lê a cada etapa direto do banco.
    const settings = new SettingsService({ pool });
    // Web push (T10): a API registra os dispositivos e entrega a configuração pública do Firebase; quem envia os avisos é o worker.
    const push = new PushService({ pool, config: config.push });

    const app = await buildApp({
      pool,
      auth,
      credentials,
      models,
      conversations,
      chat,
      approvals,
      toolCatalog,
      activities,
      memory,
      routines,
      settings,
      // Python (phase 4, F11): a API só confere a saúde do sandbox para Configurações → Python; quem executa é o worker.
      python: config.sandbox ? new PythonSandboxClient({ url: config.sandbox.url, token: config.sandbox.token, logger }) : null,
      push,
      logger,
      isProduction: config.isProduction,
      publicOrigin: config.publicOrigin,
      trustedProxies: config.trustedProxies,
      attachmentsMaxTotalBytes: config.attachmentsMaxTotalBytes,
      sse,
    });
    return {
      app,
      pool,
      auth,
      credentials,
      models,
      conversations,
      chat,
      approvals,
      activities,
      memory,
      routines,
      push,
      logger,
      port: config.port,
      async close() {
        await app.close();
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}

/** Sobe a API de ponta a ponta e passa a escutar na porta configurada. */
export async function startApi(env: Env, options: CreateApiOptions = {}): Promise<ApiRuntime> {
  const runtime = await createApi(env, options);
  try {
    await runtime.app.listen({ port: runtime.port, host: '0.0.0.0' });
  } catch (error) {
    await runtime.close();
    throw error;
  }
  return runtime;
}

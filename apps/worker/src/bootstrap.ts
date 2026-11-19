// Sequência de subida do worker: configuração -> banco disponível -> schema migrado pela API -> fila (pg-boss) -> motor de
// execução dos bots -> agendador das rotinas -> limpeza e compactação frias das conversas -> despachante dos pushes.
//
// Menor privilégio: o worker não recebe a credencial do dono. Desde a T6 ele executa os bots, então recebe a chave mestra
// (para decifrar a chave do provedor guardada no banco) e os destinos de saída fixos, os mesmos da API. Desde a T10 ele também
// recebe a conta de serviço do Firebase (única peça que envia push). Desde a phase 4 (T7), opcionalmente, o endereço e o token do sandbox do
// Python (`AION_SANDBOX_URL` e `AION_SANDBOX_TOKEN`): só com os dois o motor oferece `run_python`. Quem migra o banco é só a API; o worker espera o schema pronto
// antes de ler qualquer tabela do app.
import {
  ColdMaintenance,
  CredentialService,
  DocService,
  GeneralChatService,
  MemoryService,
  ModelService,
  createProviderRouter,
  PushDispatcher,
  PythonSandboxClient,
  RoutineScheduler,
  RunEngine,
  createBoss,
  createComposioClient,
  createCreditsState,
  createFcmClient,
  createLogger,
  createAnthropicClient,
  createOpenCodeGoClient,
  createParallelClient,
  createPool,
  loadWorkerConfig,
  startChatRetention,
  startAttachmentRetention,
  startDocRetention,
  startMemoryRetention,
  startWorkerQueue,
  assertUtf8Database,
  waitForDatabase,
  waitForSchema,
  type ColdMaintenanceConfig,
  type Env,
  type LogDestination,
  type Logger,
  type PgBoss,
  type PushDispatcherConfig,
  type RoutineSchedulerConfig,
  type RunEngineConfig,
} from '@aion/core';

export interface WorkerRuntime {
  boss: PgBoss;
  engine: RunEngine;
  scheduler: RoutineScheduler;
  /** Limpeza e compactação frias (phase 11, T7 e T8): mascara os resultados antigos das conversas que esfriaram e enfileira a compactação das que continuam pesadas. */
  coldMaintenance: ColdMaintenance;
  pushDispatcher: PushDispatcher;
  logger: Logger;
  /** Para de iniciar execuções, devolve as em andamento para outro worker retomar e fecha as conexões. */
  close(): Promise<void>;
}

export interface StartWorkerOptions {
  logDestination?: LogDestination;
  /** Tempos do motor (os testes encurtam; em produção valem os padrões da spec). */
  engineConfig?: Partial<RunEngineConfig>;
  /** Tempos do agendador de rotinas (idem). */
  schedulerConfig?: Partial<RoutineSchedulerConfig>;
  /** Tempos do laço da limpeza fria (idem). */
  coldConfig?: Partial<ColdMaintenanceConfig>;
  /** Tempos do despachante de push (idem). */
  pushConfig?: Partial<PushDispatcherConfig>;
  /** Quanto esperar a API migrar o banco. */
  schemaTimeoutMs?: number;
}

export async function startWorker(
  env: Env,
  { logDestination, engineConfig, schedulerConfig, coldConfig, pushConfig, schemaTimeoutMs }: StartWorkerOptions = {},
): Promise<WorkerRuntime> {
  const config = loadWorkerConfig(env);
  const logger = createLogger({ level: config.logLevel, name: 'worker', destination: logDestination });
  // Variável OPCIONAL inválida (hoje só as do push) não impede a subida: o worker executa os bots mesmo sem push. O erro vai para o log,
  // só com o nome da variável e a dica de formato.
  for (const issue of config.warnings) logger.error({ variable: issue.variable, problem: issue.problem }, 'configuração opcional ignorada');

  // Execuções simultâneas (um por bot) mais o batimento de cada uma disputam o pool: folga acima do padrão.
  const pool = createPool(config.databaseUrl, { applicationName: 'aion-worker', max: 20, logger });
  try {
    // Espera o PostgreSQL aceitar conexões e a API migrar o banco (serviços sobem em paralelo no Easypanel).
    await waitForDatabase(pool, { logger });
    await assertUtf8Database(pool);
    await waitForSchema(pool, { logger, timeoutMs: schemaTimeoutMs });
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }

  const boss = createBoss(config.databaseUrl, 'aion-worker');
  try {
    await startWorkerQueue(boss, logger);
    // Retenção diária das versões da memória (T8): 90 dias, no mínimo as 50 mais recentes de cada memória.
    await startMemoryRetention(boss, new MemoryService({ pool }), logger);
    // Retenção diária das versões dos docs (phase 14): a mesma regra da memória (90 dias, no mínimo as 50 mais recentes de cada doc).
    await startDocRetention(boss, new DocService({ pool }), logger);
    // Retenção diária das sessões do chat geral (T12): apaga as não salvas cuja última mensagem passou de 7 dias.
    await startChatRetention(boss, new GeneralChatService({ pool }), logger);
    // Pendentes abandonados por mais de 24 horas liberam quota sem apagar mensagens.
    await startAttachmentRetention(boss, pool, logger);
  } catch (error) {
    await boss.stop({ graceful: false, timeout: 2_000 }).catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw error;
  }

  // Provedor e conector com os destinos fixos da configuração do servidor (nenhuma entrada do usuário escolhe destino).
  // O prazo de uma chamada de chat aqui é o teto da execução inteira; o limite real é o tempo ativo do motor.
  const opencode = createOpenCodeGoClient({ baseUrl: config.opencodeGoBaseUrl, chatTimeoutMs: 15 * 60_000, logger });
  // Anthropic (phase 17): o mesmo prazo de chat; o roteador escolhe o provedor pelo prefixo do modelo, e a chave de cada um vem do `CredentialService` por quem chama.
  const anthropic = createAnthropicClient({ baseUrl: config.anthropicBaseUrl, chatTimeoutMs: 15 * 60_000, logger });
  const provider = createProviderRouter({ opencode, anthropic, creditsState: createCreditsState(pool, logger) });
  const connector = createComposioClient({ baseUrl: config.composioBaseUrl, logger });
  // A Parallel (pesquisa na web) com o destino fixo da configuração: o CredentialService a exige e o motor a usa nas ferramentas `web_search` e `web_fetch`
  // dos bots e do Chat geral (T9), enquanto a pesquisa estiver ligada em Configurações.
  const webSearch = createParallelClient({ baseUrl: config.parallelBaseUrl, logger });
  const credentials = new CredentialService({ pool, masterKey: config.masterKey, provider: opencode, anthropic, connector, webSearch, logger });
  const models = new ModelService({ pool, credentials, provider, anthropic, logger });
  // Aquece a capacidade confirmada dos modelos da Anthropic (a falha só vai ao log): o motor também a recarrega a cada preparação.
  void models.warmCapacity();
  // O conector também alimenta o motor: as ações dos apps conectados entram como ferramentas, sempre sob a regra de aprovação (T7).
  // Python (phase 4, F8): opcional. Sem a configuração do sandbox, `run_python` não é oferecida e nada mais muda; com ela, as 2 vagas são deste processo.
  const python = config.sandbox
    ? { client: new PythonSandboxClient({ url: config.sandbox.url, token: config.sandbox.token, logger }), maxTotalBytes: config.attachmentsMaxTotalBytes }
    : undefined;
  logger.info({ python: python !== undefined }, 'python no worker');
  const engine = new RunEngine({ pool, credentials, provider, models, logger, connector, webSearch, ...(python ? { python } : {}), config: engineConfig });
  engine.start();
  // Rotinas (T9): a cada ciclo dispara, na fila do bot, as execuções cujo horário previsto chegou (e trata as perdidas). Só enfileira;
  // quem executa é o motor acima. Como a fila é uma tabela, uma execução disparada antes de um reinício sobrevive a ele.
  const scheduler = new RoutineScheduler({ pool, logger, config: schedulerConfig });
  scheduler.start();
  // Limpeza e compactação frias (phase 11, T7 e T8): a cada ciclo, mascara os resultados antigos de ferramenta das conversas sem nenhuma chamada ao modelo há mais de T e sem
  // execução ativa ou na fila, quando o cache do provedor provavelmente já se perdeu (T fica acima do maior intervalo medido com cache válido, 30 minutos, e o cache estava morto em 60: `COLD_AFTER_MS`). O mascaramento só grava (sem chamar o modelo); com a conversa quente nada muda, e a abertura de uma execução
  // faz o mesmo se este laço ainda não passou. Depois dele o laço enfileira a compactação fria das conversas que continuam pesadas: uma manutenção de contexto sem sessão do dono, que
  // quem executa é o motor acima (este laço só enfileira) e que não aparece ao dono (sem cartão, push nem bolinha, e fora do estado do bot na lista).
  const coldMaintenance = new ColdMaintenance({ pool, logger, config: coldConfig });
  coldMaintenance.start();
  // Push (T10): lê a caixa de saída que o executor e as aprovações alimentam e envia os avisos pelo FCM. Sem a conta de serviço
  // configurada, o despachante só descarta os avisos (com um aviso no log) em vez de deixá-los acumular.
  const fcm = config.fcmServiceAccount
    ? createFcmClient({ serviceAccount: config.fcmServiceAccount, baseUrl: config.fcmBaseUrl, tokenUrl: config.fcmTokenUrl, logger })
    : null;
  // Sem a conta de serviço o push fica desligado em silêncio para o dono: a API, com as variáveis públicas, ainda mostra "Ativadas" e
  // registra dispositivos, e cada aviso seria descartado (R19). Então a subida avisa uma vez, citando só o NOME da variável.
  if (fcm === null) {
    logger.warn({ variable: 'AION_FCM_SERVICE_ACCOUNT' }, 'push desativado no worker: a conta de serviço do FCM não está configurada, então os avisos serão descartados');
  }
  const pushDispatcher = new PushDispatcher({ pool, fcm, logger, config: pushConfig });
  pushDispatcher.start();

  return {
    boss,
    engine,
    scheduler,
    coldMaintenance,
    pushDispatcher,
    logger,
    async close() {
      await pushDispatcher.stop();
      await coldMaintenance.stop();
      await scheduler.stop();
      await engine.stop();
      await boss.stop({ graceful: true, timeout: 10_000 });
      await pool.end();
    },
  };
}

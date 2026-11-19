// Montagem da instância Fastify da API: única composição de plugins, hooks e rotas.
// Separada do bootstrap (banco, migrations, listen) para que os testes usem `app.inject` sem abrir porta.
import fastifyCookie from '@fastify/cookie';
import type { ActivityService, ApprovalService, AuthService, ConversationService, CredentialService, GeneralChatService, Logger, MemoryService, ModelService, Pool, PushService, PythonSandboxClient, RoutineService, SettingsService } from '@aion/core';
import { AttachmentService, ConnectorAccountService, DocService, ObjectiveService, BotService, PresenceService, TableService } from '@aion/core';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { registerErrorHandling } from './plugins/error-handler';
import { registerSecurity } from './plugins/security';
import { activityRoutes } from './routes/activities';
import { attachmentRoutes } from './routes/attachments';
import { approvalRoutes, type ToolCatalog } from './routes/approvals';
import { authRoutes } from './routes/auth';
import { botRoutes } from './routes/bots';
import { chatRoutes } from './routes/chat';
import { connectorAccountRoutes } from './routes/connector-accounts';
import { conversationRoutes, type ConversationRoutesOptions } from './routes/conversation';
import { credentialsRoutes } from './routes/credentials';
import { docRoutes } from './routes/docs';
import { healthRoutes } from './routes/health';
import { memoryRoutes } from './routes/memory';
import { modelRoutes } from './routes/models';
import { pushRoutes } from './routes/push';
import { presenceRoutes } from './routes/presence';
import { routineRoutes } from './routes/routines';
import { settingsRoutes } from './routes/settings';
import { totpRoutes } from './routes/totp';
import { tableRoutes } from './routes/tables';
import './types';

/** Corpo máximo aceito por requisição (spec: 256 KB). */
export const BODY_LIMIT_BYTES = 256 * 1024;

export interface AppOptions {
  /** Teto global validado na configuração; testes podem usar limite reduzido. */
  attachmentsMaxTotalBytes?: number;
  pool: Pool;
  auth: AuthService;
  credentials: CredentialService;
  models: ModelService;
  conversations: ConversationService;
  chat: GeneralChatService;
  approvals: ApprovalService;
  /** Catálogo de ações do Composio que a tela Aprovações pré-registra; omitido, a tela lista só as ações já usadas. */
  toolCatalog?: ToolCatalog;
  activities: ActivityService;
  memory: MemoryService;
  routines: RoutineService;
  settings: SettingsService;
  /**
   * Cliente do sandbox do Python, só para a conferência de saúde de Configurações → Python (F11); nulo ou omitido sem a configuração
   * (`AION_SANDBOX_URL` e `AION_SANDBOX_TOKEN`), e a rota responde "não instalado".
   */
  python?: Pick<PythonSandboxClient, 'health'> | null;
  push: PushService;
  logger: Logger;
  isProduction: boolean;
  publicOrigin: string;
  trustedProxies: string[];
  /** Tempos do SSE da conversa; os testes encurtam, em produção valem os padrões. */
  sse?: ConversationRoutesOptions['sse'];
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    // O pino do core é aceito pelo Fastify; o cast só alinha o tipo genérico do logger com FastifyInstance.
    loggerInstance: options.logger as FastifyBaseLogger,
    bodyLimit: BODY_LIMIT_BYTES,
    // O padrão do Fastify (100) recusaria com 414 um slug de ação válido (a spec aceita até 128 caracteres): com este teto, quem decide
    // o tamanho de cada parâmetro é o schema da rota, que responde 422 no envelope padrão.
    routerOptions: { maxParamLength: 256 },
    // O IP do cliente só é lido de X-Forwarded-For se o par da conexão for um proxy confiável (Traefik na rede
    // interna). Sem isso o cliente forjaria o próprio IP para fugir do bloqueio por IP.
    trustProxy: options.trustedProxies.length > 0 ? options.trustedProxies : false,
  });

  // Validação e serialização pelos schemas Zod de @aion/shared; campos extras são recusados (strictObject).
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(fastifyCookie);
  registerErrorHandling(app);
  registerSecurity(app, { auth: options.auth, publicOrigin: options.publicOrigin });

  // Toda a API vive sob /api: o Easypanel roteia esse caminho ao serviço e não remove o prefixo.
  await app.register(
    async (api) => {
      await api.register(healthRoutes, { pool: options.pool });
      await api.register(authRoutes, { auth: options.auth, secureCookies: options.isProduction });
      await api.register(totpRoutes, { auth: options.auth });
      await api.register(credentialsRoutes, { credentials: options.credentials });
      // Contas do conector liberadas por bot (phase 13): o serviço não guarda estado (só o pool e a leitura das contas pelo `CredentialService`, que é quem tem a chave), então esta
      // instância equivale à da fonte das ferramentas do conector montada no bootstrap, como `BotService` e `TableService` acima.
      await api.register(connectorAccountRoutes, { accounts: new ConnectorAccountService({ pool: options.pool, source: options.credentials }) });
      await api.register(modelRoutes, { models: options.models });
      await api.register(botRoutes, { bots: new BotService({ pool: options.pool, models: options.models }), objectives: new ObjectiveService(options.pool) });
      await api.register(tableRoutes, { tables: new TableService({ pool: options.pool }) });
      // Docs em Markdown (phase 14): o serviço não guarda estado (só o pool; sem `execution` nem coletor de evidência, que são das ferramentas do bot), então esta instância equivale à das
      // ferramentas `doc_*` montadas no worker. A trava de escrita é de BANCO (`DOC_MUTATION_LOCK`), por isso API e worker se serializam mesmo em processos diferentes.
      await api.register(docRoutes, { docs: new DocService({ pool: options.pool }) });
      await api.register(conversationRoutes, { conversations: options.conversations, sse: options.sse });
      await api.register(chatRoutes, { chat: options.chat, conversations: options.conversations });
      await api.register(attachmentRoutes, { attachments: new AttachmentService({ pool: options.pool, conversations: options.conversations, maxTotalBytes: options.attachmentsMaxTotalBytes }) });
      await api.register(approvalRoutes, { approvals: options.approvals, toolCatalog: options.toolCatalog });
      await api.register(activityRoutes, { activities: options.activities });
      await api.register(memoryRoutes, { memory: options.memory });
      await api.register(routineRoutes, { routines: options.routines });
      await api.register(settingsRoutes, { settings: options.settings, credentials: options.credentials, python: options.python ?? null });
      await api.register(pushRoutes, { push: options.push });
      await api.register(presenceRoutes, { presence: new PresenceService({ pool: options.pool }) });
    },
    { prefix: '/api' },
  );

  return app;
}

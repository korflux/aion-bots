// Rotas das aprovações das ações do Composio (F9 e F10; T7): responder ao cartão, o número de pendências do badge, as regras globais
// (tela Aprovações), as regras de um bot (editor do bot) e os lotes "tudo" das duas telas (F12). Casca fina: a regra vive em ApprovalService (core) e o formato dos
// dados (allowlist, slug da ação, valores permitidos, campos extras recusados) nos schemas de @aion/shared, aplicados na borda.
//
// Segurança: nenhuma rota é pública, então o hook de segurança exige sessão válida e, nas que alteram estado, Origin e token CSRF.
// Ids da URL são validados antes de chegar ao serviço (dígitos para a aprovação, UUID para o bot, slug restrito para a ação) e o
// serviço confere que o recurso existe, nunca confiando no que veio do cliente. Responder a uma aprovação é idempotente; a
// retomada da execução é do worker (a API só registra a decisão).
import type { ActionInfo, ApprovalService } from '@aion/core';
import { TABLE_ACTIONS } from '@aion/core';
import {
  DOC_ACTIONS,
  actionParamsSchema,
  approvalOutcomeSchema,
  approvalParamsSchema,
  approvalRulesSchema,
  botActionParamsSchema,
  botIdParamsSchema,
  botRulesSchema,
  pendingApprovalsSchema,
  respondApprovalRequestSchema,
  setBotRuleRequestSchema,
  setGlobalRuleRequestSchema,
} from '@aion/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { originOf } from './origin';

/** As ações que o bot pode chamar agora (o catálogo de ferramentas do Composio); lista vazia se o conector não está configurado ou fora do ar. */
export type ToolCatalog = () => Promise<ActionInfo[]>;

export interface ApprovalRoutesOptions {
  approvals: ApprovalService;
  /** Fonte do catálogo que a tela Aprovações lista antes de qualquer uso; sem ela a tela mostra só as ações já usadas. */
  toolCatalog?: ToolCatalog;
}

export const approvalRoutes: FastifyPluginAsyncZod<ApprovalRoutesOptions> = async (app, { approvals, toolCatalog }) => {
  /**
   * Pré-registra o catálogo para a tela listar as ações antes do primeiro uso. Falha do catálogo NÃO derruba a tela: ela segue com o que já
   * está registrado (o Composio fora do ar não pode esconder as regras que o dono já tem) e o erro vai ao log.
   */
  async function registerCatalog(log: { warn: (fields: object, message: string) => void }): Promise<void> {
    // As categorias LOCAIS (tabelas e a exclusão de doc, phase 14) não vêm do conector: a tela lista a regra delas antes do primeiro uso, e o executor usa as mesmas identidades.
    await approvals.registerCatalog([...Object.values(DOC_ACTIONS), ...Object.values(TABLE_ACTIONS)]);
    if (!toolCatalog) return;
    try {
      await approvals.registerCatalog(await toolCatalog());
    } catch (error) {
      log.warn({ err: error }, 'catálogo de ações indisponível; a tela Aprovações lista só o que já está registrado');
    }
  }

  // Pendências respondíveis (não expiradas): o número do badge da barra.
  app.get('/approvals/pending-count', { schema: { response: { 200: pendingApprovalsSchema } } }, async () => ({
    count: await approvals.pendingCount(),
  }));

  // Resposta do dono ao cartão: permitir uma vez, negar, sempre permitir ou negar sempre. `source` (allowlist: `screen`, o padrão, ou `notification`, phase 16) diz de onde veio; da
  // notificação o serviço recusa a decisão permanente. Sessão, Origin e CSRF pelo hook de segurança, igual nas duas origens: o service worker leva o cookie e o token de GET /api/auth/session.
  app.post(
    '/approvals/:id/respond',
    { schema: { params: approvalParamsSchema, body: respondApprovalRequestSchema, response: { 200: approvalOutcomeSchema } } },
    async (request) => approvals.respond(request.params.id, request.body.decision, originOf(request), request.body.source ?? 'screen'),
  );

  // Tela Aprovações: as ações que o bot pode chamar (pré-registradas do catálogo) e as já usadas, por app, com a regra global e os bots
  // que têm regra própria.
  app.get('/approval-rules', { schema: { response: { 200: approvalRulesSchema } } }, async (request) => {
    await registerCatalog(request.log);
    return approvals.listRules();
  });

  // Regra global de uma ação (permitir, negar, perguntar ou neutro): vale na próxima chamada. Devolve a lista atualizada.
  app.put(
    '/approval-rules/:action',
    { schema: { params: actionParamsSchema, body: setGlobalRuleRequestSchema, response: { 200: approvalRulesSchema } } },
    async (request) => {
      await approvals.setGlobalRule(request.params.action, request.body.value, originOf(request));
      return approvals.listRules();
    },
  );

  // "Permitir tudo", "Perguntar tudo", "Negar tudo" e "Neutro tudo" da tela Aprovações (F12): a regra global de TODAS as ações conhecidas, numa
  // transação. O catálogo é registrado antes (como ao abrir a tela) para o lote cobrir também as ações que nenhuma tela chegou a listar.
  app.put('/approval-rules', { schema: { body: setGlobalRuleRequestSchema, response: { 200: approvalRulesSchema } } }, async (request) => {
    await registerCatalog(request.log);
    await approvals.setAllGlobalRules(request.body.value, originOf(request));
    return approvals.listRules();
  });

  // Editor do bot: as regras próprias do bot, a alteração de uma e a remoção (volta a valer o global).
  app.get(
    '/bots/:id/approval-rules',
    { schema: { params: botIdParamsSchema, response: { 200: botRulesSchema } } },
    async (request) => approvals.listBotRules(request.params.id),
  );

  // Lote do bot (F12): a regra própria em TODAS as ações conhecidas ("Permitir/Perguntar/Negar tudo", mesmo com a lista do bot vazia) e a remoção de todas
  // as regras próprias ("Neutro tudo"). Mesmas garantias do lote global.
  app.put(
    '/bots/:id/approval-rules',
    { schema: { params: botIdParamsSchema, body: setBotRuleRequestSchema, response: { 200: botRulesSchema } } },
    async (request) => {
      await registerCatalog(request.log);
      await approvals.setAllBotRules(request.params.id, request.body.value, originOf(request));
      return approvals.listBotRules(request.params.id);
    },
  );

  app.delete('/bots/:id/approval-rules', { schema: { params: botIdParamsSchema, response: { 200: botRulesSchema } } }, async (request) => {
    await approvals.removeAllBotRules(request.params.id, originOf(request));
    return approvals.listBotRules(request.params.id);
  });

  app.put(
    '/bots/:id/approval-rules/:action',
    { schema: { params: botActionParamsSchema, body: setBotRuleRequestSchema, response: { 200: botRulesSchema } } },
    async (request) => {
      await approvals.setBotRule(request.params.id, request.params.action, request.body.value, originOf(request));
      return approvals.listBotRules(request.params.id);
    },
  );

  app.delete(
    '/bots/:id/approval-rules/:action',
    { schema: { params: botActionParamsSchema, response: { 200: botRulesSchema } } },
    async (request) => {
      await approvals.removeBotRule(request.params.id, request.params.action, originOf(request));
      return approvals.listBotRules(request.params.id);
    },
  );
};

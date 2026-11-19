import { docIdSchema } from './docs';
import { tableImpactSchema, type TableImpact } from './tables';
// Contratos das aprovações de ações externas e categorias destrutivas de tabelas e docs, compartilhados entre API, core e
// web.
//
// Vocabulário (spec decisões 7, 8 e 9):
// - AÇÃO: uma ferramenta do Composio, identificada pelo slug dela (ex.: `GMAIL_SEND_EMAIL`). Ferramentas internas do bot (buscar
//   histórico, editar memória, propor rotina) são isentas; categorias destrutivas locais usam o mesmo portão de regras.
// - REGRA GLOBAL de uma ação: `allow`, `deny`, `ask` ou `neutral` (neutro deixa cada bot decidir). REGRA DO BOT: `allow`, `deny` ou
//   `ask`, e vale mais que a global. Resolução: regra do bot; senão global se não for neutra; senão PERGUNTA.
// - APROVAÇÃO: o pedido de permissão gerado quando a regra resolvida é perguntar. Vive 24 horas; a resposta é idempotente.
// Identificadores de aprovação são inteiros grandes do banco, trafegados como texto de dígitos (como mensagens e execuções).
import { z } from 'zod';

/** Validade de uma aprovação pendente (spec F9 passo 5). */
export const APPROVAL_TTL_HOURS = 24;
export const APPROVAL_TTL_MS = APPROVAL_TTL_HOURS * 60 * 60 * 1000;

/** Identificador de aprovação serializado como texto (mesmo formato dos ids de mensagem e execução). */
export const approvalIdSchema = z.string().regex(/^\d{1,18}$/);

/**
 * Slug de uma ação do Composio: letras, dígitos, sublinhado e hífen, de 1 a 128 caracteres (spec F10). Vem do catálogo do
 * Composio e da URL, então o formato é conferido na borda: nada fora dele chega ao banco nem a uma consulta.
 */
export const ACTION_SLUG_MAX = 128;
export const actionSlugSchema = z
  .string()
  .min(1)
  .max(ACTION_SLUG_MAX)
  .regex(/^[A-Za-z0-9_-]+$/);

// ---------------------------------------------------------------------------------------------
// Regras
// ---------------------------------------------------------------------------------------------

/**
 * Regra global: `neutral` deixa a decisão com cada bot (e, sem regra do bot, a ação pergunta). A ORDEM é a das opções do controle
 * segmentado do design (Permitir, Perguntar, Negar, Neutro): as telas montam as opções percorrendo esta lista.
 */
export const GLOBAL_RULE_VALUES = ['allow', 'ask', 'deny', 'neutral'] as const;
export const globalRuleSchema = z.enum(GLOBAL_RULE_VALUES);
export type GlobalRule = z.infer<typeof globalRuleSchema>;

/** Regra de um bot para uma ação (não existe "neutro": remover a regra é o que devolve a decisão ao global), na ordem do design. */
export const BOT_RULE_VALUES = ['allow', 'ask', 'deny'] as const;
export const botRuleSchema = z.enum(BOT_RULE_VALUES);
export type BotRule = z.infer<typeof botRuleSchema>;

/** O que a resolução decide para uma chamada concreta: executar, recusar ou pausar e perguntar ao dono. */
export type ResolvedRule = BotRule;

/** Rótulos do controle segmentado (design: Permitir, Perguntar, Negar, Neutro). */
export const RULE_LABELS: Record<GlobalRule, string> = { allow: 'Permitir', ask: 'Perguntar', deny: 'Negar', neutral: 'Neutro' };

/** Uma ação conhecida (do catálogo que o bot pode chamar, ou já usada) com a regra global e os bots que têm regra própria (tela Aprovações). */
export const actionRuleViewSchema = z.object({
  action: actionSlugSchema,
  /** Nome legível da ação ("Send Email") e do app ("Gmail"), como o Composio os informa. */
  label: z.string(),
  appSlug: z.string(),
  appName: z.string(),
  globalRule: globalRuleSchema,
  /** Bots com regra própria nesta ação; nome e cor são o que a tela precisa para desenhar o avatar (a Faísca) de cada um. */
  botRules: z.array(z.object({ botId: z.uuid(), botName: z.string(), botColor: z.string(), value: botRuleSchema })),
});
export type ActionRuleView = z.infer<typeof actionRuleViewSchema>;

export const approvalRulesSchema = z.object({ actions: z.array(actionRuleViewSchema) });
export type ApprovalRules = z.infer<typeof approvalRulesSchema>;

export const setGlobalRuleRequestSchema = z.strictObject({ value: globalRuleSchema });
export const actionParamsSchema = z.strictObject({ action: actionSlugSchema });

/** Regra própria de um bot, com os nomes legíveis da ação (seção "Aprovações do bot" do editor). */
export const botRuleViewSchema = z.object({
  action: actionSlugSchema,
  label: z.string(),
  appName: z.string(),
  value: botRuleSchema,
});
export type BotRuleView = z.infer<typeof botRuleViewSchema>;

export const botRulesSchema = z.object({ rules: z.array(botRuleViewSchema) });
export type BotRules = z.infer<typeof botRulesSchema>;

export const setBotRuleRequestSchema = z.strictObject({ value: botRuleSchema });
export const botActionParamsSchema = z.strictObject({ id: z.uuid(), action: actionSlugSchema });

// ---------------------------------------------------------------------------------------------
// Aprovações
// ---------------------------------------------------------------------------------------------

/**
 * Estados de uma aprovação: pendente, aprovada, negada ou expirada (spec F9) e `cancelled`, que a spec não nomeia mas é
 * necessário: o dono parou a execução enquanto o pedido esperava, e ele não pode seguir respondível.
 */
export const APPROVAL_STATUSES = ['pending', 'approved', 'denied', 'expired', 'cancelled'] as const;
export const approvalStatusSchema = z.enum(APPROVAL_STATUSES);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

export const APPROVAL_STATUS_LABELS: Record<ApprovalStatus, string> = {
  pending: 'Pendente',
  approved: 'Aprovada',
  denied: 'Negada',
  expired: 'Expirada',
  cancelled: 'Cancelada',
};

/** Respostas do dono ao cartão: permitir uma vez, negar, sempre permitir (grava regra no bot) e negar sempre (idem). */
export const APPROVAL_DECISIONS = ['allow_once', 'deny', 'allow_always', 'deny_always'] as const;
export const approvalDecisionSchema = z.enum(APPROVAL_DECISIONS);
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

/** A decisão libera a ação (permitir uma vez ou sempre)? */
export const decisionAllows = (decision: ApprovalDecision): boolean => decision === 'allow_once' || decision === 'allow_always';

/**
 * De onde veio a resposta (phase 16, SEC-07): `screen` (o cartão do app, o padrão) ou `notification` (os botões Aprovar e Recusar da notificação). Allowlist fechada; só entra na
 * auditoria (`approval.respond`, campo `source`) e na regra abaixo: da notificação valem só `allow_once` e `deny`, a decisão permanente é do app.
 */
export const APPROVAL_RESPONSE_SOURCES = ['screen', 'notification'] as const;
export const approvalResponseSourceSchema = z.enum(APPROVAL_RESPONSE_SOURCES);
export type ApprovalResponseSource = z.infer<typeof approvalResponseSourceSchema>;

export const approvalParamsSchema = z.strictObject({ id: approvalIdSchema });
export const respondApprovalRequestSchema = z.strictObject({ decision: approvalDecisionSchema, source: approvalResponseSourceSchema.optional() });

/** Estado de uma aprovação depois da resposta (e o que a tela mostra no selo do cartão). */
export const approvalOutcomeSchema = z.object({
  id: approvalIdSchema,
  status: approvalStatusSchema,
  decision: approvalDecisionSchema.nullable(),
  /**
   * Phase 16: `true` quando a MESMA decisão já estava aplicada antes deste pedido (a resposta idempotente, 200 sem efeito novo). Ausente na resposta que de fato decidiu. Aditivo: a tela
   * ignora o campo; o service worker o usa para NÃO tratar como sucesso o toque num botão de uma aprovação já decidida (explica e abre o cartão).
   */
  alreadyApplied: z.boolean().optional(),
});
export type ApprovalOutcome = z.infer<typeof approvalOutcomeSchema>;

/** Pendências abertas (não expiradas): o número do badge da barra. */
export const pendingApprovalsSchema = z.object({ count: z.number().int().nonnegative() });
export type PendingApprovals = z.infer<typeof pendingApprovalsSchema>;

/** Um parâmetro da ação resumido para o cartão (nome e valor curtos, já truncados pelo servidor). */
export const approvalParamSchema = z.object({ name: z.string(), value: z.string() });

/**
 * Parâmetros que o cartão NÃO mostra: o total e os primeiros nomes. A ação executa com todos os argumentos, então o dono precisa
 * saber que existem (um `bcc` escondido na 7ª posição seria aprovado sem ser visto).
 */
export const approvalOmittedSchema = z.object({ count: z.number().int().nonnegative(), names: z.array(z.string()) });

/**
 * Impacto do cartão de aprovação de uma exclusão de doc (decisão 23, A35): o id e o TÍTULO do doc, lidos no servidor pelo `inspect` de `doc_delete` depois da checagem de acesso do bot, nunca
 * dos argumentos do modelo. É o que o dono lê para saber qual doc aprova apagar (a única ação sem volta dos docs). Só metadado: nenhum texto do doc. O impacto das tabelas (`TableImpact`)
 * tem `kind` de exclusão ou conversão de tabela; este é `delete_doc`, e a tela discrimina por esse campo.
 */
export const docImpactSchema = z.strictObject({ kind: z.literal('delete_doc'), docId: docIdSchema, docTitle: z.string() });
export type DocImpact = z.infer<typeof docImpactSchema>;

/** O que o servidor mostra no cartão de uma aprovação local: a tabela ou o doc que a ação atingiria. Ações do conector não têm impacto. */
export type ApprovalImpact = TableImpact | DocImpact;

/**
 * Cartão de aprovação na conversa (membro de `systemCardSchema`). Guarda uma CÓPIA do estado da aprovação para a tela: a fonte da
 * verdade é a tabela `approvals`, e quem a altera atualiza o cartão na mesma transação.
 */
export const approvalCardSchema = z.object({
  impact: z.lazy(() => z.union([tableImpactSchema, docImpactSchema])).optional(),
  type: z.literal('approval'),
  approvalId: approvalIdSchema,
  status: approvalStatusSchema,
  decision: approvalDecisionSchema.nullable(),
  action: actionSlugSchema,
  actionLabel: z.string(),
  appName: z.string(),
  /**
   * Phase 13 (CONN-02): conta do conector em que a ação executa, pelo nome que o dono deu a ela ou pelo rótulo automático ("Gmail · ca_…1a2b"). Opcional: ações sem conta (as
   * categorias destrutivas de tabelas) não a têm, e os cartões gravados antes da phase também não, e continuam válidos.
   */
  accountLabel: z.string().optional(),
  params: z.array(approvalParamSchema),
  /** O que o resumo deixou de fora (vazio quando todos os parâmetros cabem). */
  omitted: approvalOmittedSchema,
  /** Quando a aprovação expira (a tela mostra o tempo restante). */
  expiresAt: z.iso.datetime(),
});
export type ApprovalCard = z.infer<typeof approvalCardSchema>;

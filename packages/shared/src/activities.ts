// Contratos da tela Atividades (F15, A14; T11), compartilhados entre a API, o core e a web.
//
// A tela é um ÍNDICE de leitura sobre o que já existe, sem estado próprio (decisão do dono: "a aba Atividades apenas indexa os cartões"):
// - PENDENTES ("Aguardando você"): os pedidos de aprovação ainda respondíveis (pendentes e dentro do prazo, como o badge da barra), de
//   todos os bots e das sessões do chat geral. A resposta NÃO é dada aqui: o item leva ao cartão na conversa, onde o dono vê o contexto
//   antes de decidir.
// - RECENTES: as execuções de todos os bots e do chat geral, da mais nova para a mais antiga, com a origem (mensagem do dono ou rotina) e o estado. As
//   execuções `cancelled` (rotina tirada da fila antes de começar) ficam de fora: nunca começaram, não há o que mostrar nem cartão.
// Paginação por cursor (o id da última execução da página), 50 itens por página. As pendências só vêm na primeira página (sem cursor).
import { z } from 'zod';
import { bigintIdSchema, runStatusSchema } from './conversation';

/** Execuções por página da lista Recentes (spec F15). */
export const ACTIVITIES_PAGE_SIZE = 50;

/**
 * O bot de um item, o suficiente para o avatar (a Faísca na cor do bot) e o nome (o bot pode estar arquivado: o histórico continua visível).
 */
export const activityBotSchema = z.object({ id: z.uuid(), name: z.string(), color: z.string(), archived: z.boolean() });
export type ActivityBot = z.infer<typeof activityBotSchema>;

/**
 * Dono de uma execução ou de um pedido: um bot (`bot` preenchido, `sessionId` nulo) ou uma sessão do chat geral (`bot` nulo e
 * `sessionId` preenchido). Nunca os dois: é o que decide o destino do clique (`/bots/:id` ou `/chat/:sessionId`) e a rota de "Parar".
 */
export const activityOwnerShape = {
  bot: activityBotSchema.nullable(),
  sessionId: z.uuid().nullable(),
};

/** Aprovação pendente: o dono, a ação, quanto falta e o cartão da conversa para onde o clique leva. */
export const pendingActivitySchema = z.object({
  approvalId: bigintIdSchema,
  runId: bigintIdSchema,
  ...activityOwnerShape,
  /** Nome legível da ação já com o app, como o Composio o informa ("Send Email · Gmail"). */
  actionLabel: z.string(),
  /** Phase 13 (CONN-02): a conta do conector da ação, do mesmo jeito que o cartão de aprovação a mostra (nome do dono ou rótulo automático); ausente quando a ação não tem conta. */
  accountLabel: z.string().optional(),
  /**
   * Decisão 23 (A35, phase 14): o título do doc que a exclusão pedida apagaria, lido no servidor e gravado no impacto do cartão da aprovação (a mesma fonte do cartão da conversa), para o dono saber
   * qual doc aprova apagar sem abrir a conversa. Ausente nas demais ações (conector, tabelas) e na pendência gravada antes da decisão.
   */
  docTitle: z.string().optional(),
  expiresAt: z.iso.datetime(),
  /** Cartão da aprovação na conversa do dono (`?mensagem=` leva até ele). */
  messageId: bigintIdSchema.nullable(),
});
export type PendingActivity = z.infer<typeof pendingActivitySchema>;

/** Execução recente. `routineName` nulo = disparada por mensagem do dono; preenchido = "Rotina: <nome>". */
export const recentActivitySchema = z.object({
  runId: bigintIdSchema,
  ...activityOwnerShape,
  routineName: z.string().nullable(),
  status: runStatusSchema,
  createdAt: z.iso.datetime(),
  /**
   * Para onde o clique leva na conversa do dono: a última mensagem visível da execução (o cartão de desfecho ou a resposta do bot, a
   * mesma que o toque do push abre) ou, sem nenhuma ainda, a que abriu a rodada. Nulo só enquanto a execução ainda espera na fila.
   */
  messageId: bigintIdSchema.nullable(),
  /**
   * Phase 4 (Suposição 12): a execução é de uma sessão do Chat geral e está fora do caminho ativo (outra versão, ou rodada retrocedida); o link
   * abre a sessão e a tela avisa "Esta atividade está em outra versão da conversa.". Falso no bot e na fila. Opcional como os campos novos.
   */
  offPath: z.boolean().default(false).optional(),
});
export type RecentActivity = z.infer<typeof recentActivitySchema>;

export const activitiesPageSchema = z.object({
  /** Só na primeira página (sem cursor); nas seguintes vem vazio. */
  pending: z.array(pendingActivitySchema),
  items: z.array(recentActivitySchema),
  /** Cursor da próxima página, ou nulo na última. */
  nextCursor: bigintIdSchema.nullable(),
});
export type ActivitiesPage = z.infer<typeof activitiesPageSchema>;

export const activitiesQuerySchema = z.strictObject({ cursor: bigintIdSchema.optional() });

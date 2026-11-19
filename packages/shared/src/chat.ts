// Contratos do chat geral temporário (F16, A15; T12), compartilhados entre a API, o core e a web.
//
// Uma SESSÃO do chat geral é uma conversa SEM bot (PROD-03): funciona como a conversa do bot (mesmo motor, mesmas mensagens, mesmo SSE),
// com três diferenças (spec F16): não tem memória própria (lê só a global), a busca no histórico vale só para a sessão e a aprovação
// usa só a regra global. A sessão é TEMPORÁRIA: uma sessão não salva é apagada, com mensagens e execuções, 7 dias depois da última
// mensagem; "salvar" suspende a exclusão, e desativar volta a contar 7 dias a partir da última mensagem.
//
// O identificador da sessão é o da própria conversa (UUID). As rotas da conversa são as mesmas do bot sob `/api/chat/sessions/:id`.
import { z } from 'zod';
import { effortLevelSchema, modelIdSchema } from './models';

/** Dias que uma sessão não salva vive depois da última mensagem (spec decisão 17). */
export const CHAT_SESSION_RETENTION_DAYS = 7;
export const CHAT_SESSION_RETENTION_MS = CHAT_SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** Tamanho máximo do título gerado a partir da primeira mensagem (spec F16: "até 80 caracteres"). */
export const CHAT_SESSION_TITLE_MAX = 80;

/** Sessões devolvidas na lista do painel (as mais recentes). */
export const CHAT_SESSIONS_LIST_LIMIT = 200;

/** Uma sessão como o painel e o cabeçalho a veem. */
export const chatSessionSchema = z.object({
  id: z.uuid(),
  /** Gerado pela primeira mensagem; nulo numa sessão que ainda não recebeu nenhuma ("Novo chat" na tela). */
  title: z.string().nullable(),
  saved: z.boolean(),
  createdAt: z.iso.datetime(),
  /** Hora da última mensagem (ou a da criação, se não houver): é daqui que contam os 7 dias. */
  lastActivityAt: z.iso.datetime(),
  /** Quando a sessão será apagada (última mensagem mais 7 dias). Nulo quando salva: não expira. */
  expiresAt: z.iso.datetime().nullable(),
  /** Novidade não lida na sessão (phase 3, F4/A7), pela mesma regra da lista de bots (`hasUnreadSql` do core). */
  unread: z.boolean(),
});
export type ChatSession = z.infer<typeof chatSessionSchema>;

export const chatSessionListSchema = z.object({ items: z.array(chatSessionSchema) });
export type ChatSessionList = z.infer<typeof chatSessionListSchema>;

/**
 * Filtro opcional da lista (phase 5, T10): `?saved=true` devolve só as sessões salvas, para a vista "Salvos" de `/chats`. Allowlist de UM valor (`false` e qualquer outro
 * texto são recusados): o filtro vale no servidor porque a lista é limitada às `CHAT_SESSIONS_LIST_LIMIT` mais recentes, e uma sessão salva antiga ficaria de fora de
 * um filtro feito no navegador.
 */
export const chatSessionListQuerySchema = z.strictObject({ saved: z.literal('true').optional() });
export type ChatSessionListQuery = z.infer<typeof chatSessionListQuerySchema>;

/** Liga ou desliga "salvar" (única alteração que o dono faz numa sessão). */
export const chatSessionSaveRequestSchema = z.strictObject({ saved: z.boolean() });

export const chatSessionParamsSchema = z.strictObject({ id: z.uuid() });

/**
 * Modelo e effort padrão do Chat geral (T23): é com eles que toda sessão nova começa, e sem eles o chat geral não deixa conversar. O
 * modelo é obrigatório ao salvar (não existe "sem modelo"); a resposta de leitura (`modelChoiceSchema`) traz `model` nulo enquanto o
 * dono não definiu. O servidor só aceita um modelo que conste na lista do provedor e um effort que o modelo aceite.
 */
export const chatSettingsUpdateSchema = z.strictObject({ model: modelIdSchema, effort: effortLevelSchema.nullable() });
export type ChatSettingsUpdate = z.infer<typeof chatSettingsUpdateSchema>;

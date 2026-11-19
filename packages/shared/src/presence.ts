// Contrato de presença e leitura por conversa (phase 3, F1/A2; NOTIF-01; T2), compartilhado entre a web (quem informa), a API (borda) e o
// core (quem grava e quem consulta na hora de avisar).
//
// Presença = "o dono está olhando esta conversa agora neste aparelho" (Suposição 3): a página está visível e com foco. É guardada no servidor
// POR SESSÃO DE LOGIN (a do cookie, nunca um id enviado pelo navegador), renovada a cada 20 s e vencida 45 s depois da última renovação
// (Suposição 4). Leitura = até onde a conversa foi vista, por conversa e monotônica (Suposição 5). Os números abaixo são a fonte única deles.
import { z } from 'zod';
import { bigintIdSchema } from './conversation';

/** Intervalo em que a conversa aberta, visível e em foco renova a presença (e a leitura). */
export const PRESENCE_RENEW_MS = 20_000;
/** Sem renovação, a presença deixa de valer este tempo depois da última (cobre a mensagem de término perdida). */
export const PRESENCE_TTL_MS = 45_000;
/** Escritas de presença e leitura aceitas por minuto e por sessão; acima, `RATE_LIMITED`. */
export const PRESENCE_WRITES_PER_MINUTE = 30;
/** Corpo máximo da escrita de presença (o contrato cabe com folga em poucas centenas de bytes). */
export const PRESENCE_BODY_MAX_BYTES = 1024;

/**
 * De quem é a conversa informada: `bot` (o id é o do BOT, a conversa única dele) ou `chat` (o id é o da sessão do Chat geral). É o mesmo
 * endereçamento das rotas da conversa (`/api/bots/:id` e `/api/chat/sessions/:id`), então a web não precisa conhecer o id interno da conversa.
 */
export const presenceConversationKindSchema = z.enum(['bot', 'chat']);
export type PresenceConversationKind = z.infer<typeof presenceConversationKindSchema>;

/**
 * Escrita de presença e leitura. `present: true` inicia ou renova a presença desta sessão nesta conversa; `false` a encerra (só se ela ainda
 * aponta para esta conversa). `readThrough` é o id da mensagem mais recente que a tela mostrou (pertence à conversa; só avança); nulo ou
 * ausente não mexe na leitura.
 */
export const presenceUpdateSchema = z.strictObject({
  conversationKind: presenceConversationKindSchema,
  conversationId: z.uuid(),
  readThrough: bigintIdSchema.nullable().optional(),
  present: z.boolean(),
});
export type PresenceUpdate = z.infer<typeof presenceUpdateSchema>;

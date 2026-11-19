// Contratos do web push (F14, T10; NOTIF-01) compartilhados entre a API, o core (outbox e despachante) e a web.
//
// O push que viaja pelo FCM é só um AVISO: leva o nome do bot e o tipo do evento, nunca conteúdo da conversa (spec decisão 18, "Never" da spec). O
// toque na notificação abre o cartão correspondente por um caminho relativo da própria web (`url`). Desde a phase 16 o aparelho pode mostrar o CONTEÚDO (começo da
// resposta, ação da aprovação, desfecho da rotina), mas ele chega só pela resposta da conferência do service worker (`pushEventCheckSchema`), com sessão, para o evento
// válido e com a chave "Mostrar conteúdo" da origem ligada: nunca pelo FCM.
//
// Quem fala com o FCM é o servidor (token do dispositivo + conta de serviço no worker). O navegador só obtém o token com a
// configuração PÚBLICA do app web do Firebase e a chave VAPID, que a API entrega em `GET /api/push/config`.
import { z } from 'zod';
import { bigintIdSchema } from './conversation';

/** Tipos de evento que geram push (spec F14: allowlist). Fonte única para o outbox, o despachante e a futura matriz de silenciar (T13). */
export const PUSH_EVENT_KINDS = ['run_completed', 'run_failed', 'approval_pending', 'approval_expired'] as const;
export type PushEventKind = (typeof PUSH_EVENT_KINDS)[number];
export const pushEventKindSchema = z.enum(PUSH_EVENT_KINDS);

/** Texto do tipo no corpo do aviso genérico (o que o FCM leva e o que vale com a chave "Mostrar conteúdo" desligada ou sem resposta da conferência). É só o tipo: o conteúdo da execução nunca entra no push. */
export const PUSH_EVENT_LABELS: Record<PushEventKind, string> = {
  run_completed: 'Execução concluída',
  run_failed: 'Execução com falha',
  approval_pending: 'Aprovação pendente',
  approval_expired: 'Aprovação expirada',
};

/**
 * Matriz de silenciar (F14 passo 4, T13; A13): UMA linha por origem de aviso e, em cada uma, os tipos silenciados. Ausência = recebe (o
 * padrão de um bot novo é receber tudo). `botId: null` é o Chat geral, a outra origem de push (título "Chat geral"). `name` vem do servidor,
 * para a web não repetir a regra de quais bots aparecem (arquivados ficam de fora).
 */
export const pushMuteTargetSchema = z.object({
  botId: z.uuid().nullable(),
  name: z.string(),
  muted: z.array(pushEventKindSchema),
});
export type PushMuteTarget = z.infer<typeof pushMuteTargetSchema>;

export const pushPreferencesSchema = z.object({ targets: z.array(pushMuteTargetSchema) });
export type PushPreferences = z.infer<typeof pushPreferencesSchema>;

/** Liga ou desliga o silêncio de UM tipo numa origem. Idempotente: o corpo descreve o estado final, não uma alternância. */
export const pushMuteSetSchema = z.strictObject({
  botId: z.uuid().nullable(),
  kind: pushEventKindSchema,
  muted: z.boolean(),
});
export type PushMuteSet = z.infer<typeof pushMuteSetSchema>;

/**
 * Tamanho máximo do token de dispositivo (spec F14). Tokens reais do FCM têm cerca de 150 a 200 caracteres; 2048 sobra e fica abaixo do
 * que o índice único do PostgreSQL aceita (cerca de 2.700 bytes): com 4096 um token entre os dois passava na borda e falhava no INSERT
 * com erro interno (R20). O CHECK da migration 0011 (4096) é mais largo, mas o limite da borda vem antes e o protege.
 */
export const PUSH_TOKEN_MAX = 2048;

/** Quantos dispositivos o dono pode ter registrados ao mesmo tempo; cada um multiplica os envios por evento (R16). */
export const PUSH_DEVICES_MAX = 20;

/** Registro de um dispositivo: o token do FCM, em ASCII imprimível sem espaços (o formato real do FCM é opaco, então só se recusa o que não cabe num JSON seguro). */
export const pushDeviceCreateSchema = z.strictObject({
  token: z
    .string()
    .min(1)
    .max(PUSH_TOKEN_MAX)
    .regex(/^[\x21-\x7E]+$/),
});
export type PushDeviceCreate = z.infer<typeof pushDeviceCreateSchema>;

/** Um dispositivo como aparece em Configurações → Notificações. O token NUNCA volta ao navegador. */
export const pushDeviceSchema = z.object({
  id: z.uuid(),
  label: z.string(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
});
export type PushDevice = z.infer<typeof pushDeviceSchema>;

export const pushDeviceListSchema = z.object({ devices: z.array(pushDeviceSchema) });
export const pushDeviceIdParamsSchema = z.strictObject({ id: z.uuid() });

/**
 * Configuração PÚBLICA do app web do Firebase (a mesma que o console mostra para colar no código do site) e a chave VAPID pública.
 * Nada aqui é segredo; a credencial de serviço que ENVIA os pushes fica só no worker.
 */
export const firebaseWebConfigSchema = z.object({
  apiKey: z.string().min(1).max(256),
  projectId: z.string().min(1).max(128),
  messagingSenderId: z.string().min(1).max(64),
  appId: z.string().min(1).max(256),
});
export type FirebaseWebConfig = z.infer<typeof firebaseWebConfigSchema>;

/** `enabled: false` quando o servidor não tem o Firebase configurado: a web esconde o aviso de ativação. */
export const pushConfigSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }),
  z.object({ enabled: z.literal(true), firebase: firebaseWebConfigSchema, vapidKey: z.string().min(1).max(256) }),
]);
export type PushConfig = z.infer<typeof pushConfigSchema>;

// ---------------------------------------------------------------------------------------------
// Validade do aviso (phase 3, T3; F1/F3; NOTIF-01): descarte no envio, abertura do app e conferência do service worker
// ---------------------------------------------------------------------------------------------

/**
 * Por que um evento terminou `dropped` sem ser enviado, o código fechado gravado em `push_events.drop_reason`. Sem conteúdo nenhum.
 * Os seis primeiros são da regra de validade (Suposições 6 e 12; NOTIF-01): presença válida na conversa em qualquer sessão, anterior à última
 * abertura do app, conversa já lida até a mensagem do evento, aprovação que já não está pendente, tipo silenciado, ou mais de 24 horas.
 * Os quatro seguintes (phase 16) são desfechos do envio que antes ficavam sem motivo ou disfarçados de `sent`, e o funil precisa separá-los
 * de um envio de verdade: `no_fcm_account` (o worker não tem a conta de serviço do FCM), `no_device` (nenhum dispositivo registrado no
 * envio), `no_destination` (o bot ou a sessão do evento já não existe) e `attempts_exhausted` (falhas transitórias do FCM esgotaram as
 * tentativas).
 */
export const PUSH_DROP_REASONS = [
  'presence',
  'opened',
  'read',
  'resolved',
  'muted',
  'expired',
  'no_fcm_account',
  'no_device',
  'no_destination',
  'attempts_exhausted',
] as const;
export type PushDropReason = (typeof PUSH_DROP_REASONS)[number];

/**
 * Resultado do envio de UM evento a UM dispositivo (`push_deliveries.outcome`, phase 16): `accepted` (o FCM aceitou, HTTP 2xx),
 * `rejected_token` (o FCM disse que o token nunca mais serve, e o dispositivo foi removido) ou `failed` (rede, 5xx, 429 ou credencial: pode
 * ser repetido).
 */
export const PUSH_DELIVERY_OUTCOMES = ['accepted', 'rejected_token', 'failed'] as const;
export type PushDeliveryOutcome = (typeof PUSH_DELIVERY_OUTCOMES)[number];

/**
 * O que o service worker viu de um aviso no aparelho (`push_receipts.state`, phase 16): `received` (o push chegou), `shown` (a notificação
 * foi exibida), `suppressed` (não foi exibida, com motivo) e `clicked` (o dono tocou). No máximo um registro por evento, dispositivo e estado.
 */
export const PUSH_RECEIPT_STATES = ['received', 'shown', 'suppressed', 'clicked'] as const;
export type PushReceiptState = (typeof PUSH_RECEIPT_STATES)[number];

/**
 * Motivo registrado no aparelho (`push_receipts.reason`): `invalid` (a conferência disse que o aviso não vale mais), `owner_looking` (a
 * conversa estava aberta e visível) e `check_timeout` (a conferência não respondeu a tempo; o aviso é exibido mesmo assim, então este motivo
 * acompanha `shown` e nunca `suppressed`). Só `shown` e `suppressed` levam motivo, e `suppressed` sempre leva.
 */
export const PUSH_RECEIPT_REASONS = ['invalid', 'owner_looking', 'check_timeout'] as const;
export type PushReceiptReason = (typeof PUSH_RECEIPT_REASONS)[number];

/** Idade a partir da qual um aviso não vale mais (Suposição 12), a mesma do TTL do FCM: nem enviado, nem mostrado se chegar atrasado. */
export const PUSH_EVENT_MAX_AGE_MS = 24 * 3600_000;

/** Registros de "app aberto" aceitos por minuto e por sessão; acima, `RATE_LIMITED` (Contratos). */
export const PUSH_APP_OPENS_PER_MINUTE = 10;
/** Conferências do service worker aceitas por minuto e por sessão; acima, `RATE_LIMITED` (Contratos). */
export const PUSH_CHECKS_PER_MINUTE = 60;
/** Ids por conferência: o push que chegou mais as notificações do Aion já exibidas no aparelho (até 20, Suposição 8). */
export const PUSH_CHECK_IDS_MAX = 21;

/**
 * Conferência: `GET /api/push/events/check?ids=1,2,3`. Os ids são os de `push_events` (`eventId` do push), em texto de dígitos, separados por
 * vírgula; de 1 a `PUSH_CHECK_IDS_MAX`. Qualquer outro parâmetro é recusado.
 */
export const pushEventCheckQuerySchema = z.strictObject({
  ids: z
    .string()
    .max(PUSH_CHECK_IDS_MAX * 19)
    .transform((value) => value.split(','))
    .pipe(z.array(bigintIdSchema).min(1).max(PUSH_CHECK_IDS_MAX)),
});
export type PushEventCheckQuery = z.infer<typeof pushEventCheckQuerySchema>;

/** Limite, em caracteres (pontos de código), do título e do corpo do aviso com conteúdo (NOTIF-02; A3). */
export const PUSH_CONTENT_MAX = 160;

/**
 * Resposta da conferência: se cada evento ainda vale, na ordem pedida. Id desconhecido (inexistente ou já apagado) volta inválido.
 * Phase 16 (NOTIF-02, SEC-07): o evento VÁLIDO de uma origem com "Mostrar conteúdo" ligado traz também `title` e `body` (texto puro, até `PUSH_CONTENT_MAX`) e,
 * se é um `approval_pending` ainda pendente, o `approvalId` que habilita Aprovar e Recusar. Os três são opcionais e ausentes quando a chave está desligada, o evento
 * é inválido ou o conteúdo não se monta, então o service worker anterior, que lê só `id` e `valid`, segue funcionando. É o ÚNICO canal do texto: nunca vai ao FCM.
 */
export const pushEventCheckSchema = z.object({
  events: z.array(
    z.object({
      id: bigintIdSchema,
      valid: z.boolean(),
      title: z.string().max(PUSH_CONTENT_MAX * 4).optional(),
      body: z.string().max(PUSH_CONTENT_MAX * 4).optional(),
      approvalId: bigintIdSchema.optional(),
    }),
  ),
});
export type PushEventCheck = z.infer<typeof pushEventCheckSchema>;

// ---------------------------------------------------------------------------------------------
// Interruptores "Mostrar conteúdo" (phase 16, passo 4; NOTIF-02; A3, A4, A13)
// ---------------------------------------------------------------------------------------------

/** As duas origens de aviso que têm interruptor próprio: os bots (todos juntos) e o Chat geral. */
export const PUSH_CONTENT_ORIGINS = ['bots', 'general_chat'] as const;
export type PushContentOrigin = (typeof PUSH_CONTENT_ORIGINS)[number];

/** Estado dos interruptores, ligados por padrão. Desligado vale o aviso genérico (nome e tipo) e sem os botões de aprovação. */
export const pushContentSettingsSchema = z.object({ bots: z.boolean(), generalChat: z.boolean() });
export type PushContentSettings = z.infer<typeof pushContentSettingsSchema>;

/** Liga ou desliga UMA origem. Idempotente: o corpo descreve o estado final, não uma alternância. */
export const pushContentSetSchema = z.strictObject({ origin: z.enum(PUSH_CONTENT_ORIGINS), enabled: z.boolean() });
export type PushContentSet = z.infer<typeof pushContentSetSchema>;

// ---------------------------------------------------------------------------------------------
// Registro do service worker (phase 16, passo 2; A1 e A9): o aparelho reporta o que fez com o aviso
// ---------------------------------------------------------------------------------------------

/** Registros do service worker aceitos por minuto e por sessão; acima, `RATE_LIMITED` (Contratos). Cada aviso gera até 3 (recebido, exibido ou suprimido, tocado). */
export const PUSH_RECEIPTS_PER_MINUTE = 120;
/** Tamanho máximo do corpo do registro, em bytes; acima, `PAYLOAD_TOO_LARGE`. O corpo legítimo tem cerca de 130. */
export const PUSH_RECEIPT_BODY_LIMIT = 1024;

/**
 * Registro do service worker: `POST /api/push/receipts`. Só quatro campos, todos em allowlist (`eventId` de `push_events`, `deviceId` devolvido pelo
 * registro do dispositivo, `state` e `reason`), qualquer outro é recusado e NENHUM conteúdo cabe aqui. O motivo segue a mesma regra do CHECK de
 * `push_receipts`: `suppressed` leva `invalid` ou `owner_looking`; `shown` leva no máximo `check_timeout`; `received` e `clicked` não levam motivo.
 */
export const pushReceiptCreateSchema = z
  .strictObject({
    eventId: bigintIdSchema,
    deviceId: z.uuid(),
    state: z.enum(PUSH_RECEIPT_STATES),
    reason: z.enum(PUSH_RECEIPT_REASONS).optional(),
  })
  .refine(
    ({ state, reason }) => {
      if (state === 'suppressed') return reason === 'invalid' || reason === 'owner_looking';
      if (state === 'shown') return reason === undefined || reason === 'check_timeout';
      return reason === undefined;
    },
    { message: 'O motivo não combina com o estado.', path: ['reason'] },
  );
export type PushReceiptCreate = z.infer<typeof pushReceiptCreateSchema>;

// Contratos da conversa do bot e das execuções (F6, F7; T6) compartilhados entre a API, o core e a web.
//
// Modelo da conversa (PROD-02): UMA conversa contínua por bot, uma linha do tempo de `messages` de três tipos:
// - `text`: mensagem do dono (`user`) ou texto que o bot produziu (`assistant`), gravado aos poucos enquanto `streaming` (a tela só o mostra quando fica `done`);
// - `activity`: uma chamada de ferramenta do bot (nome legível, estado, resultado);
// - `card`: cartão de sistema (parada, limite, falha; T7 acrescenta a aprovação, T8 a memória e T9 a rotina).
// Uma mensagem do dono só entra na linha do tempo quando a execução dela COMEÇA; enquanto espera a vez do bot ela vive
// em `runs` (estado `queued`) e a tela a mostra como "Na fila". Enviada com uma execução ativa, ela vira COMPLEMENTO pendente dela (phase 4,
// CONV-03): também fora da linha do tempo até o executor lê-lo na próxima fronteira entre etapas (ver `complements.ts` no core).
//
// Identificadores de mensagem, execução e evento são inteiros grandes do banco; trafegam como texto (string de dígitos)
// para não perder precisão e comparam-se como BigInt no cliente.
import { z } from 'zod';
import { contextStateSchema } from './context-status';
import { approvalCardSchema } from './approvals';
import { objectiveCardSchema, objectiveViewSchema } from './objectives';
import { memoryCardSchema } from './memory';
import { effortLevelSchema, modelIdSchema } from './models';
import { routineChangeCardSchema, routineConfirmedCardSchema, routineEditedCardSchema, routineMissedCardSchema, routineProposalCardSchema, routineRefusedCardSchema, routineRunCardSchema } from './routines';

/** Tamanho máximo de uma mensagem do dono (spec F6). */
export const MESSAGE_MAX = 32_000;
/** Mensagens na fila de um bot, contando as que ainda não começaram (spec F6). */
export const QUEUE_LIMIT_PER_BOT = 20;
/** Mensagens por minuto (spec: rate limit). */
export const MESSAGES_PER_MINUTE = 60;
/** Rodadas enviadas ao modelo em cada chamada, contando a rodada em andamento (spec, decisão 10). */
export const ROUNDS_IN_CONTEXT = 5;
/** Rodadas por página do histórico da conversa na tela (padrão do parâmetro `rounds`; independe das 5 enviadas ao modelo). */
export const CONVERSATION_PAGE_ROUNDS = 10;
/** Máximo aceito no parâmetro `rounds` de uma página. */
export const CONVERSATION_PAGE_MAX_ROUNDS = 50;
/**
 * Teto de itens de uma página, em qualquer número de rodadas: uma rodada pode ter dezenas de chamadas de ferramenta com resultados grandes, e
 * sem o teto 50 rodadas viram uma resposta gigante. Acima dele a página corta as rodadas mais antigas (o `before` seguinte continua dali).
 */
export const CONVERSATION_PAGE_MAX_ITEMS = 300;

/** Identificador inteiro do banco serializado como texto. */
export const bigintIdSchema = z.string().regex(/^\d{1,18}$/);

/** Teto único dos arquivos pendentes e enviados em uma mensagem. */
export const ATTACHMENT_LIMIT = 5;
/**
 * Tipos de anexo guardados (fonte única do enum em todas as views). `document` guarda só o texto extraído (PDF, DOCX, TXT, MD, CSV, JSON);
 * `image` guarda o JPEG; `spreadsheet` (phase 4, ATT-01) guarda o `.xlsx` original, sem texto extraído, para o código ler; `generated` (phase 4,
 * T7) é o arquivo que o `run_python` gravou em `/out/` (origem "gerado pelo Python"), com os bytes como vieram e o formato em `format`.
 */
export const ATTACHMENT_KINDS = ['image', 'document', 'spreadsheet', 'generated'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];
/**
 * Formatos aceitos de um arquivo gerado pelo Python (Suposição 24), conferidos pelo conteúdo real antes de gravar. Fonte única do enum do banco
 * (CHECK da migration 0027), da validação no worker, do tipo de mídia no download e da tela (PNG inline, os demais como cartão).
 */
export const GENERATED_FORMATS = ['png', 'csv', 'json', 'txt', 'md', 'xlsx'] as const;
export type GeneratedFormat = (typeof GENERATED_FORMATS)[number];
/** Referência pública na conversa, sem bytes nem texto do documento. `format` só existe no arquivo gerado pelo Python. */
export const conversationAttachmentSchema = z.object({
  id: bigintIdSchema,
  name: z.string(),
  kind: z.enum(ATTACHMENT_KINDS),
  sizeBytes: z.number().int().nonnegative(),
  removed: z.boolean(),
  format: z.enum(GENERATED_FORMATS).optional(),
});
export type ConversationAttachment = z.infer<typeof conversationAttachmentSchema>;

/**
 * Estados de uma execução. `waiting_approval` e `expired` entram em uso na T7 (aprovações). `cancelled` (T9) é a execução de rotina
 * que saiu da fila sem nunca começar, porque a rotina foi pausada, excluída ou o bot foi arquivado (spec F12 passo 4).
 */
export const RUN_STATUSES = [
  'queued',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'interrupted',
  'limit_reached',
  'expired',
  'cancelled',
] as const;
export const runStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof runStatusSchema>;

/** Execução que ocupa o bot: só uma por bot (índice único no banco). */
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['running', 'waiting_approval'];
/** Execução que ainda não terminou (na fila ou ocupando o bot). */
export const OPEN_RUN_STATUSES: readonly RunStatus[] = ['queued', ...ACTIVE_RUN_STATUSES];

// ---------------------------------------------------------------------------------------------
// Complemento durante a execução (phase 4, F5, CONV-03)
// ---------------------------------------------------------------------------------------------

/** Complementos pendentes por execução (Suposição 19): acima disso o envio é recusado com COMPLEMENT_LIMIT_REACHED. */
export const COMPLEMENT_LIMIT_PER_RUN = 20;

/**
 * Complemento ainda não lido pelo assistente: a mensagem que o dono enviou com a execução ativa. Não é linha da conversa (Suposição 15); a tela o
 * mostra como bolha "Complemento · aguardando", dentro da execução ativa (`RunView.complements`).
 */
export const complementViewSchema = z.object({
  id: bigintIdSchema,
  content: z.string(),
  attachments: z.array(conversationAttachmentSchema),
  createdAt: z.iso.datetime(),
});
export type ComplementView = z.infer<typeof complementViewSchema>;

/**
 * Rascunho devolvido da conversa (Suposição 18): complementos que a parada ou o "Cancelar" tiraram da execução, com texto e anexos. Um por
 * conversa (devoluções seguidas se juntam nele); entregue uma vez a um composer e vence em 24 horas. `content` pode vir vazio quando só sobraram
 * anexos (excedente de uma promoção).
 */
export const draftViewSchema = z.object({
  id: bigintIdSchema,
  content: z.string(),
  attachments: z.array(conversationAttachmentSchema),
  returnedAt: z.iso.datetime(),
});
export type DraftView = z.infer<typeof draftViewSchema>;

/**
 * Evento `draft` do SSE: o estado atual do rascunho `id`, ou `draft: null` quando ele deixou de existir (usado, descartado ou vencido). Assim um
 * aparelho que mostra a linha "Rascunho devolvido" a tira quando outro aparelho o usa.
 */
export const draftEventSchema = z.object({ id: bigintIdSchema, draft: draftViewSchema.nullable() });
export type DraftEvent = z.infer<typeof draftEventSchema>;

/** Rótulos do selo de estado da execução (design: "Trabalhando", "Aguardando aprovação"). */
export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  queued: 'Na fila',
  running: 'Trabalhando',
  waiting_approval: 'Aguardando aprovação',
  completed: 'Concluída',
  failed: 'Falhou',
  interrupted: 'Interrompida',
  limit_reached: 'Limite atingido',
  expired: 'Expirada',
  cancelled: 'Cancelada',
};

/**
 * Execução como a tela a vê. `input` só vai enquanto está `queued` (é o texto que aparece na bolha "Na fila"); depois
 * o texto já é uma mensagem da linha do tempo.
 */
export const runViewSchema = z.object({
  id: bigintIdSchema,
  /** O parse normaliza resposta antiga para []; optional mantém produtores tipados anteriores compatíveis. */
  attachments: z.array(conversationAttachmentSchema).default([]).optional(),
  status: runStatusSchema,
  input: z.string().nullable(),
  /** Nome da rotina que disparou a execução (nulo quando foi uma mensagem do dono): a fila mostra "Rotina <nome>" no lugar da bolha. */
  routineName: z.string().nullable(),
  toolCalls: z.number().int().nonnegative(),
  /** Código de erro seguro (registro de `ERROR_CODES`) quando `failed`. */
  failureCode: z.string().nullable(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  /** Complementos pendentes da execução ativa, na ordem de envio (phase 4, F5); vazio em qualquer outra. Opcional como `attachments`. */
  complements: z.array(complementViewSchema).default([]).optional(),
});
export type RunView = z.infer<typeof runViewSchema>;

// ---------------------------------------------------------------------------------------------
// Linha do tempo
// ---------------------------------------------------------------------------------------------

const messageBase = {
  id: bigintIdSchema,
  /** Normalizado para [] pelo parser e emitido sempre pelo core, inclusive sem arquivos. */
  attachments: z.array(conversationAttachmentSchema).default([]).optional(),
  runId: bigintIdSchema.nullable(),
  createdAt: z.iso.datetime(),
};

/** Trecho achado pela busca no histórico (F6 passo 3): data de origem e a mensagem para o link "ver na conversa". */
export const historyHitSchema = z.object({
  messageId: bigintIdSchema,
  createdAt: z.iso.datetime(),
  snippet: z.string(),
});
export type HistoryHit = z.infer<typeof historyHitSchema>;

/**
 * Resultado de uma pesquisa na web como a atividade o mostra (F7, T9): o título e a URL COMPLETA, para o dono auditar o que o bot achou. As duas
 * strings vêm da internet (dado não confiável): a tela só faz link se a URL for `http` ou `https` e nunca interpreta o título como HTML.
 */
export const webResultSchema = z.object({ title: z.string(), url: z.string() });
export type WebResult = z.infer<typeof webResultSchema>;

/** Página que o bot pediu para ler (F7, T9): a URL completa pedida e se a leitura devolveu conteúdo. */
export const webPageSchema = z.object({ url: z.string(), read: z.boolean() });
export type WebPage = z.infer<typeof webPageSchema>;

/**
 * Desfecho de uma chamada de `run_python` (F8): `ok` ou o código devolvido ao modelo. Os erros do Python vêm do sandbox (`PYTHON_ERROR`,
 * `PYTHON_TIMEOUT`, `PYTHON_MEMORY_LIMIT`); os demais são do worker (sandbox fora do ar, anexo de entrada recusado, sem espaço para os arquivos
 * gerados). Não são códigos HTTP: nenhum sai de uma rota, por isso não entram em `ERROR_CODES`.
 */
export const PYTHON_OUTCOMES = ['ok', 'PYTHON_ERROR', 'PYTHON_TIMEOUT', 'PYTHON_MEMORY_LIMIT', 'PYTHON_UNAVAILABLE', 'PYTHON_INPUT_INVALID', 'ATTACHMENT_QUOTA_EXCEEDED'] as const;
export type PythonOutcome = (typeof PYTHON_OUTCOMES)[number];

/**
 * Detalhe da atividade `run_python` para a tela (view autorizada do dono: código, saída e nomes aparecem por desenho, Suposição 29). `state` acompanha
 * a chamada ao vivo: `waiting` (esperando uma das 2 vagas), `running` (no sandbox) e `done` (com desfecho, saída, erro e duração). Os arquivos aceitos
 * são os anexos da própria atividade (`attachments` da mensagem, com `format`); `rejected` lista os de `/out/` recusados por formato ou limite.
 */
export const pythonDetailSchema = z.object({
  type: z.literal('python'),
  state: z.enum(['waiting', 'running', 'done']),
  code: z.string(),
  outcome: z.enum(PYTHON_OUTCOMES).nullable(),
  output: z.string(),
  outputTruncated: z.boolean(),
  error: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  rejected: z.array(z.object({ name: z.string(), reason: z.enum(['format', 'limit']) })),
});
export type PythonDetail = z.infer<typeof pythonDetailSchema>;

/**
 * Detalhe específico de uma ferramenta para a tela (T7 acrescenta o das ações do Composio). Os dois da web (T9) entram no contrato ANTES de o worker
 * os gravar: um tipo que a tela não conhece derrubaria a leitura da conversa inteira, por isso api, worker e web publicam juntos.
 */
export const activityDetailSchema = z.discriminatedUnion('type', [
  /** Vínculo para reler imagens e para apagar o texto copiado na atividade junto com o arquivo. */
  z.object({ type: z.literal('attachment_read'), attachmentId: bigintIdSchema, kind: z.enum(ATTACHMENT_KINDS), offset: z.number().int().nonnegative() }),
  z.object({ type: z.literal('history_search'), query: z.string(), hits: z.array(historyHitSchema) }),
  /** `web_search`: o objetivo e as consultas enviadas e os resultados devolvidos (até 5, título e URL). */
  z.object({ type: z.literal('web_search'), objective: z.string(), queries: z.array(z.string()), results: z.array(webResultSchema) }),
  /** `web_fetch`: as URLs pedidas (até 5) e se cada uma foi lida. */
  z.object({ type: z.literal('web_fetch'), pages: z.array(webPageSchema) }),
  /** `run_python` (phase 4, F8): ver `pythonDetailSchema`. */
  pythonDetailSchema,
]);
export type ActivityDetail = z.infer<typeof activityDetailSchema>;

export const textMessageSchema = z.object({
  ...messageBase,
  kind: z.literal('text'),
  role: z.enum(['user', 'assistant']),
  status: z.enum(['streaming', 'done', 'discarded']),
  content: z.string(),
  /** Texto conservado de uma etapa truncada, sem representar resposta final completa. */
  incomplete: z.boolean().optional(),
  /**
   * Só na resposta do assistente (phase 4, F7): ID do modelo da última chamada ao provedor da execução que a escreveu. Nulo em resposta de
   * execução anterior ao registro (a tela não mostra modelo); ausente na mensagem do dono.
   */
  model: z.string().nullable().optional(),
  /** Só na mensagem do dono lida como complemento durante a execução (phase 4, F5): a tela mostra a legenda "complemento". */
  complement: z.boolean().optional(),
});

/**
 * Referência de um artefato (phase 14, ART-01: a tabela ou o doc) que uma chamada de ferramenta criou ou alterou (A4): tipo, id e título, LIDOS NO SERVIDOR (nunca vindos do argumento do
 * modelo). É o que a conversa usa para mostrar um cartão por artefato por resposta, com o link que o abre. O título é o do momento do fechamento da atividade: uma renomeação posterior não
 * reescreve o que ficou gravado.
 */
export const artifactRefSchema = z.object({ type: z.enum(['table', 'doc']), id: z.uuid(), title: z.string() });
export type ArtifactRef = z.infer<typeof artifactRefSchema>;

export const activityMessageSchema = z.object({
  ...messageBase,
  kind: z.literal('activity'),
  status: z.enum(['running', 'completed', 'failed', 'discarded']),
  /** Etapa do modelo dentro da execução: chamadas da mesma etapa se agrupam na tela. */
  step: z.number().int(),
  /** Nome técnico da ferramenta (slug). */
  tool: z.string(),
  /** Nome legível ("Pesquisou no histórico: contrato"). */
  label: z.string(),
  /** Argumentos como o modelo os enviou (texto, já truncado). */
  arguments: z.string(),
  /** Resultado resumido (texto, truncado); nulo enquanto executa. */
  result: z.string().nullable(),
  detail: activityDetailSchema.nullable(),
  /** A ação espera a resposta do dono (aprovação pendente): a tela mostra "aguardando aprovação" em vez de "executando". */
  awaitingApproval: z.boolean(),
  /**
   * Phase 14 (A4): os artefatos que esta chamada criou ou alterou, ausente em toda chamada que não mexe em tabela nem em doc (leitura, busca, exclusão, falha). Uma chamada pode alterar
   * várias tabelas (a importação por anexo refere todas as da importação, no máximo 20), por isso é uma lista. Gravado no dado da atividade, não em cartão de sistema: por construção não acende
   * a bolinha de não lido nem o push (só contam a resposta do bot e os cartões, `VISIBLE_NEWS_SQL`). Os cartões da conversa agrupam por execução e artefato.
   */
  artifacts: z.array(artifactRefSchema).optional(),
});

/** Cartões de sistema (T6: desfecho da execução; T7: aprovação; T8: memória atualizada; T9: rotina); as próximas tasks acrescentam os seus como novos membros. */
export const systemCardSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('run_interrupted'),
    /** Etapas concluídas (nomes legíveis). */
    steps: z.array(z.string()),
    /** Ações externas em andamento na hora da parada: "podem ter sido concluídas" (spec decisão 13). */
    maybeCompleted: z.array(z.string()),
  }),
  z.object({ type: z.literal('run_limit'), limit: z.enum(['steps', 'time', 'tokens']), steps: z.array(z.string()), continuedManually: z.boolean().optional(), continuation: z.object({ automatic: z.boolean(), count: z.number().int().min(0).max(3), consecutiveCuts: z.number().int().min(1), confirmedTools: z.number().int().min(0) }).optional() }),
  z.object({ type: z.literal('run_failed'), code: z.string() }),
  approvalCardSchema,
  memoryCardSchema,
  objectiveCardSchema,
  routineRunCardSchema,
  routineMissedCardSchema,
  routineProposalCardSchema,
  routineChangeCardSchema,
  routineConfirmedCardSchema,
  routineRefusedCardSchema,
  routineEditedCardSchema,
  /** O modelo da execução não chama ferramentas (selo "Sem ferramentas"): ela segue sem as ações do Composio (spec F8). */
  z.object({ type: z.literal('model_without_tools'), model: z.string() }),
]);
export type SystemCard = z.infer<typeof systemCardSchema>;

export const cardMessageSchema = z.object({
  ...messageBase,
  kind: z.literal('card'),
  status: z.literal('done'),
  content: z.string(),
  card: systemCardSchema,
});

export const messageViewSchema = z.discriminatedUnion('kind', [textMessageSchema, activityMessageSchema, cardMessageSchema]);
export type MessageView = z.infer<typeof messageViewSchema>;
export type ActivityView = z.infer<typeof activityMessageSchema>;
export type CardView = z.infer<typeof cardMessageSchema>;
export type TextMessageView = z.infer<typeof textMessageSchema>;

// ---------------------------------------------------------------------------------------------
// Consultas e comandos
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Versões e caminho ativo do Chat geral (phase 4, F1 a F4, CONV-01; o bot é linear, CONV-02, e nunca recebe estes campos)
// ---------------------------------------------------------------------------------------------

/**
 * Uma rodada do caminho ativo de uma sessão: a mensagem do dono e a resposta (execução) em vigor, e as versões de cada uma em ordem de criação
 * (a ordem do seletor "‹ k/n ›"). A posição exibida é o índice do id em vigor mais 1 e o total é o tamanho da lista; os ids vizinhos são os que a
 * troca de versão recebe. `runId` nulo só numa rodada sem execução (não acontece no Chat geral).
 */
export const pathRoundSchema = z.object({
  messageId: bigintIdSchema,
  runId: bigintIdSchema.nullable(),
  messageVersions: z.array(bigintIdSchema),
  runVersions: z.array(bigintIdSchema),
});
export type PathRound = z.infer<typeof pathRoundSchema>;

/** Retrocesso em vigor (F3): o caminho para na resposta `runId` e `rounds` rodadas ficaram abaixo dela, recuperáveis por "Restaurar". */
export const rewoundSchema = z.object({ runId: bigintIdSchema, rounds: z.number().int().positive() });
export type Rewound = z.infer<typeof rewoundSchema>;

/** Evento `path` do SSE: o caminho ativo da sessão mudou (troca de versão, edição, nova resposta, retrocesso ou restauração); a tela relê o snapshot. */
export const pathEventSchema = z.strictObject({});
export type PathEvent = z.infer<typeof pathEventSchema>;

/** Modelo e effort em uso na conversa, já resolvidos (preferência da conversa, padrão do bot ou primeiro favorito). */
export const modelChoiceSchema = z.object({
  model: z.string().nullable(),
  effort: effortLevelSchema.nullable(),
  /** Níveis conhecidos do modelo em uso; consumidores antigos podem omitir e recebem a lista vazia. */
  effortLevels: z.array(effortLevelSchema).default([]).optional(),
});
export type ModelChoiceView = z.infer<typeof modelChoiceSchema>;

/** Estado inicial da tela: a última página da linha do tempo, as execuções abertas e o ponto de retomada do SSE. */
export const conversationSnapshotSchema = z.object({
  context: contextStateSchema.optional(),
  objective: objectiveViewSchema.nullable().optional(),
  items: z.array(messageViewSchema),
  /** Há mensagens mais antigas que as da página. */
  hasMore: z.boolean(),
  /** Execuções na fila e ocupando o bot, da mais antiga à mais nova. */
  runs: z.array(runViewSchema),
  /** Último evento já refletido no snapshot: o SSE retoma a partir dele. */
  lastEventId: z.string(),
  model: modelChoiceSchema,
  providerConfigured: z.boolean(),
  /** Rascunho devolvido ainda não entregue (phase 4, F5), ou nulo. Opcional para quem monta snapshot sem ele (normalizado para nulo). */
  draft: draftViewSchema.nullable().default(null).optional(),
  /** Só na sessão do Chat geral (phase 4): as rodadas do caminho ativo presentes em `items`, com as versões de cada uma. Ausente no bot. */
  rounds: z.array(pathRoundSchema).optional(),
  /** Só na sessão do Chat geral: o retrocesso em vigor (linha "N rodadas retrocedidas · Restaurar"), nulo sem ele ou com execução aberta. */
  rewound: rewoundSchema.nullable().optional(),
});
export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;

/** Página da conversa; `rounds` só na sessão do Chat geral (as rodadas do caminho ativo presentes em `items`, ver o snapshot). */
export const conversationPageSchema = z.object({ items: z.array(messageViewSchema), hasMore: z.boolean(), rounds: z.array(pathRoundSchema).optional() });
export type ConversationPage = z.infer<typeof conversationPageSchema>;

/**
 * Consulta de uma página da conversa: `before` é o id da mensagem mais antiga que a tela já tem (a página traz as rodadas anteriores a ela) e
 * `rounds` é o tamanho da página em RODADAS (inteiro de 1 a 50). Estrito: o antigo `limit`, em itens, deixou de existir e é recusado.
 */
export const conversationPageQuerySchema = z.strictObject({
  before: bigintIdSchema.optional(),
  rounds: z.coerce.number().int().min(1).max(CONVERSATION_PAGE_MAX_ROUNDS).default(CONVERSATION_PAGE_ROUNDS),
});

/** Conteúdo livre sem caracteres de controle (exceto tabulação e quebras), que o PostgreSQL recusa ou que quebram a tela. */
const CONTROL_CHARS_EXCEPT_WHITESPACE = /(?![\t\n\r])\p{Cc}/u;

export const sendMessageRequestSchema = z.strictObject({
  attachmentIds: z.array(bigintIdSchema).max(ATTACHMENT_LIMIT).refine((ids) => new Set(ids).size === ids.length, {
    params: { domainCode: 'ATTACHMENT_NOT_FOUND' },
  }).optional(),
  content: z
    .string()
    .trim()
    .min(1)
    .max(MESSAGE_MAX)
    .refine((value) => !CONTROL_CHARS_EXCEPT_WHITESPACE.test(value)),
});

/**
 * Resposta do envio (phase 4, F5): sem execução ativa, a mensagem criou uma execução na fila (`kind: 'run'`, como antes); com execução ativa
 * (rodando ou aguardando aprovação, sem parada pedida), virou complemento pendente dela (`kind: 'complement'`).
 */
export const sendResultSchema = z.discriminatedUnion('kind', [
  runViewSchema.extend({ kind: z.literal('run') }),
  complementViewSchema.extend({ kind: z.literal('complement') }),
]);
export type SendResult = z.infer<typeof sendResultSchema>;

/**
 * Editar uma mensagem do dono no Chat geral (F1): a mensagem do caminho ativo, o texto novo e os anexos da versão nova (até 5: pendentes do
 * composer ou já ligados a versões desta sessão). Estrito como o envio; a resposta é a execução criada para a versão nova.
 */
export const editMessageRequestSchema = sendMessageRequestSchema.extend({ messageId: bigintIdSchema });

/** Gerar outra resposta e retroceder até uma resposta do caminho ativo (F2, F3): estrito, só o id da execução. */
/** A continuação confirma o cartão terminal que o dono viu; cliques antigos não podem autorizar outro trecho. */
export const continueRunRequestSchema = z.strictObject({ limitMessageId: bigintIdSchema });

export const versionRunRequestSchema = z.strictObject({ runId: bigintIdSchema });

/** Escolher versão (F4): a versão de mensagem OU a versão de resposta a exibir, nunca as duas; estrito. */
export const chooseVersionRequestSchema = z.union([z.strictObject({ messageId: bigintIdSchema }), z.strictObject({ runId: bigintIdSchema })]);
export type ChooseVersionRequest = z.infer<typeof chooseVersionRequestSchema>;

/** Cancelar um complemento pendente (botão "Cancelar" da bolha): estrito, só o id; a resposta é o rascunho devolvido. */
export const cancelComplementRequestSchema = z.strictObject({ complementId: bigintIdSchema });

/** Usar (consumir) o rascunho devolvido: o id do dono da conversa e o do rascunho, sem corpo. */
export const draftParamsSchema = z.strictObject({ id: z.uuid(), draftId: bigintIdSchema });

/** Preferência de modelo e effort da conversa (decisão 14): vale até nova troca e não altera o padrão do bot. */
export const conversationPreferenceRequestSchema = z.strictObject({
  model: modelIdSchema,
  effort: effortLevelSchema.nullable(),
});

export const conversationEventsQuerySchema = z.strictObject({ after: bigintIdSchema.optional() });

export const botRunParamsSchema = z.strictObject({ id: z.uuid(), runId: bigintIdSchema });

/**
 * Parar a execução ativa do bot. `runId` é opcional e serve a telas que listam execuções (Atividades): com ele, a parada só vale se
 * AQUELA execução ainda for a ativa do bot; se ela já terminou e a próxima da fila começou, a resposta é RUN_NOT_ACTIVE e a execução
 * nova não é tocada. A conversa, que sempre mostra a execução ativa de verdade, não precisa informá-lo.
 */
export const stopRunQuerySchema = z.strictObject({ runId: bigintIdSchema.optional() });

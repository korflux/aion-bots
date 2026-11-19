// Contratos de bots (F5) compartilhados entre a API (validação e serialização), o core e a web (formulário e tipos).
//
// Limites vêm da spec F5: nome de 1 a 60 caracteres, instruções até 8.000, cor `#RRGGBB`, limite de etapas
// inteiro de 1 a 100. Campos extras são recusados (`strictObject`), o que também barra mass assignment
// (`id`, `archivedAt`, `nameKey`... nunca entram por esta porta).
import { z } from 'zod';
import { modelContextCapacitySchema, contextWindowTokensSchema } from './context-window';
import { objectiveViewSchema } from './objectives';
import { botRunStateSchema } from './live-state';
import { effortLevelSchema, modelIdSchema } from './models';

export const BOT_NAME_MAX = 60;
export const BOT_INSTRUCTIONS_MAX = 8000;
export const BOT_STEP_LIMIT_MIN = 1;
export const BOT_STEP_LIMIT_MAX = 100;
// Padrão de 50 chamadas de ferramenta por execução (T30; era 25). Com o Composio por níveis, cada ação nova custa uma busca e uma execução (2 chamadas),
// então 25 cabia em poucas ações. É também o limite do chat geral, que não tem bot. Vale para bots NOVOS: o serviço sempre grava o valor no INSERT,
// então o DEFAULT 25 da coluna (migration 0004) nunca é usado; os bots que já existem guardam o limite que tinham e o dono edita no bot.
export const BOT_STEP_LIMIT_DEFAULT = 50;

/**
 * 12 cores pré-definidas (design). Todas passam de 4,5:1 sobre o fundo do app, acima do mínimo de 3:1 exigido
 * para cores de bot, para que o nome destacado no cabeçalho também seja legível (verificado em bots.test.ts).
 */
export const BOT_COLORS = [
  { name: 'Vermelho', hex: '#F87171' },
  { name: 'Laranja', hex: '#FB923C' },
  { name: 'Âmbar', hex: '#FBBF24' },
  { name: 'Lima', hex: '#A3E635' },
  { name: 'Verde', hex: '#4ADE80' },
  { name: 'Turquesa', hex: '#2DD4BF' },
  { name: 'Ciano', hex: '#22D3EE' },
  { name: 'Azul', hex: '#60A5FA' },
  { name: 'Índigo', hex: '#818CF8' },
  { name: 'Violeta', hex: '#A78BFA' },
  { name: 'Rosa', hex: '#F472B6' },
  { name: 'Cinza', hex: '#9CA3AF' },
] as const;

/** Cor de um bot novo no editor (Azul). */
export const BOT_DEFAULT_COLOR = '#60A5FA';

/** Tamanho máximo (em caracteres, reticências incluídas) da prévia da última novidade do bot na lista (phase 5, spec F4, Suposição 12). */
export const BOT_PREVIEW_MAX = 120;

/** A prévia de um bot sem nenhuma resposta final nem cartão visível na conversa (a conversa vazia, ou só com mensagens do dono). */
export const BOT_PREVIEW_EMPTY = 'Nenhuma mensagem ainda';

/**
 * Quantidade de caracteres como o dono os vê, por pontos de código (um emoji conta 1). É a mesma contagem do
 * `.min()`/`.max()` de string do Zod 4 e do `char_length` do PostgreSQL, então contador, schema e banco concordam.
 */
export const countChars = (value: string): number => Array.from(value).length;

/** Caracteres de controle (exceto tabulação e quebras de linha) que o PostgreSQL recusa ou que quebram a tela. */
export const CONTROL_CHARS_EXCEPT_WHITESPACE = /(?![\t\n\r])\p{Cc}/u;

/**
 * Texto de nome de bot: 1 a `max` caracteres após o `trim` e a normalização NFC, sem caracteres de controle. A normalização vem
 * antes da contagem porque a forma final (a que o banco guarda) é a que precisa caber no limite. É a fonte única dessa forma
 * canônica: o nome gravado na criação e o `confirmName` da exclusão (F6) passam por ela, e por isso a comparação exata do
 * servidor só tem sentido entre textos que saíram daqui.
 */
const botNameText = (max: number) =>
  z
    .string()
    .trim()
    .normalize('NFC')
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}]*$/u);

/** Nome do bot: até `BOT_NAME_MAX` caracteres. A unicidade é regra do core. */
const nameSchema = botNameText(BOT_NAME_MAX);

/** Instruções livres até 8.000 caracteres (NUL e outros controles são recusados; tabulação e quebras valem). */
const instructionsSchema = z
  .string()
  .max(BOT_INSTRUCTIONS_MAX)
  .refine((value) => !CONTROL_CHARS_EXCEPT_WHITESPACE.test(value));

/** Cor `#RRGGBB`, gravada sempre em maiúsculas (a comparação e o banco assumem essa forma). */
const colorSchema = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/)
  .transform((value) => value.toUpperCase());

const stepLimitSchema = z.number().int().min(BOT_STEP_LIMIT_MIN).max(BOT_STEP_LIMIT_MAX);

// Modelo e effort: aqui só o formato (id do provedor ou nulo; um dos níveis conhecidos ou nulo). Que o modelo conste na
// lista atual do provedor e que o effort seja um dos níveis gravados para ele depende de estado, então é regra do core
// (`BotService`, via `ModelService.validateSelection`), não do schema.
const modelSchema = modelIdSchema.nullable();
const effortSchema = effortLevelSchema.nullable();

/** Criação: nome e cor são obrigatórios; o resto assume os padrões do editor. Campo desconhecido (inclusive o antigo `mascot`) é recusado pelo `strictObject`. */
export const botCreateSchema = z.strictObject({
  name: nameSchema,
  color: colorSchema,
  instructions: instructionsSchema.default(''),
  model: modelSchema.default(null),
  effort: effortSchema.default(null),
  stepLimit: stepLimitSchema.default(BOT_STEP_LIMIT_DEFAULT),
  contextWindowTokens: contextWindowTokensSchema.nullable().default(null),
});
// Chamadores internos legados podem omitir a nova escolha; o schema e o serviço normalizam para herança.
export type BotCreate = Omit<z.output<typeof botCreateSchema>, 'contextWindowTokens'> & { contextWindowTokens?: z.output<typeof contextWindowTokensSchema> | null };

/**
 * Edição parcial: só os campos enviados mudam. Os campos são declarados de novo, sem `.default()`, porque no Zod 4
 * um padrão dentro de `.partial()` seria aplicado a um campo ausente e sobrescreveria o valor salvo.
 */
export const botUpdateSchema = z.strictObject({
  name: nameSchema.optional(),
  color: colorSchema.optional(),
  instructions: instructionsSchema.optional(),
  model: modelSchema.optional(),
  effort: effortSchema.optional(),
  stepLimit: stepLimitSchema.optional(),
  contextWindowTokens: contextWindowTokensSchema.nullable().optional(),
});
export type BotUpdate = z.output<typeof botUpdateSchema>;

export const botIdParamsSchema = z.strictObject({ id: z.uuid() });

/** Folga do campo de confirmação da exclusão (F6): o nome tem até 60, o limite de 80 só barra lixo grande antes da comparação. */
const BOT_CONFIRM_NAME_MAX = 80;

/**
 * Corpo da exclusão definitiva (F6): um único campo, `confirmName`, o nome do bot digitado pelo dono. Passa pela mesma forma canônica do
 * nome (trim e NFC). Que o texto seja IGUAL ao nome gravado depende do bot e é conferido pelo core (`BotService.deleteArchived`).
 */
export const botDeleteSchema = z.strictObject({ confirmName: botNameText(BOT_CONFIRM_NAME_MAX) });

/** O que identifica um bot na tela (avatar e navegação): a base comum do item da lista e do bot completo. */
const botIdentitySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  color: z.string(),
  archivedAt: z.iso.datetime().nullable(),
});

/**
 * Item da lista (painel Bots e Início): o suficiente para o avatar (a Faísca na cor do bot) e a navegação, sem as instruções, mais o estado ao vivo (`runState`,
 * F10): o que o bot está fazendo agora, calculado pelo servidor a cada leitura (ver `botRunStateOf`). O estado e a prévia só existem na lista: o bot
 * completo (`botSchema`) e as respostas de criação e edição não os trazem, porque mudam por conta da execução e não por ação do dono.
 */
export const botSummarySchema = botIdentitySchema.extend({
  runState: botRunStateSchema,
  /**
   * Novidade não lida na conversa do bot (phase 3, F4/A7): resposta concluída do bot ou cartão de sistema posterior à leitura sincronizada no
   * servidor. Calculado a cada leitura da lista (regra única `hasUnreadSql` do core); o silenciamento de avisos não interfere.
   */
  unread: z.boolean(),
  /**
   * Última novidade visível da conversa, para a linha do bot no Início (phase 5, T5; spec F4, Suposição 12): a primeira linha, sem Markdown, da última resposta
   * final do bot ou o título do último cartão de sistema (o que for mais recente), de até `BOT_PREVIEW_MAX` caracteres; `BOT_PREVIEW_EMPTY` quando não há.
   * Derivada a cada leitura pelo servidor (nunca gravada) e fora dos logs: é conteúdo da conversa.
   */
  preview: z.string().min(1).max(BOT_PREVIEW_MAX),
});
export type BotSummary = z.infer<typeof botSummarySchema>;

/** Bot completo, como o editor e a conversa o leem (sem o estado ao vivo, que é do item da lista). */
export const botSchema = botIdentitySchema.extend({
  /** Escolha efetiva na edição; a preferência da conversa continua tendo precedência sobre o formulário. */
  objective: objectiveViewSchema.optional(),
  contextModel: z.object({ model: z.string().nullable(), fromConversation: z.boolean(), capacity: modelContextCapacitySchema.nullable() }).optional(),
  instructions: z.string(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  stepLimit: z.number().int(),
  contextWindowTokens: contextWindowTokensSchema.nullable().default(null),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Bot = z.infer<typeof botSchema>;

export const botListSchema = z.object({ bots: z.array(botSummarySchema) });
export type BotList = z.infer<typeof botListSchema>;

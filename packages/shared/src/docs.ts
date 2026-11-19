// Contratos dos docs (phase 14, passo 2; DOC-01 a DOC-04): texto em Markdown que o dono e os bots escrevem em conjunto, compartilhados entre a API, o core, as
// ferramentas `doc_*` e a web.
//
// Modelo:
// - O doc tem um TÍTULO (1 a 120 caracteres, uma linha) e um TEXTO de até 100.000 caracteres. Os dois contam caracteres de verdade (pontos de código, como o `char_length`
//   do banco e `countChars`), nunca unidades UTF-16: um emoji vale 1.
// - Toda alteração do TEXTO, do dono ou do bot, cria uma VERSÃO imutável (número crescente por doc, autor `owner` ou `bot`); a criação grava a versão 1. Restaurar cria uma
//   versão nova com o texto da escolhida (nunca reescreve o histórico). O título não é versionado: mudá-lo não cria versão nem é desfeito por restauração.
// - Toda escrita leva a VERSÃO ESPERADA: se o texto mudou desde que o autor o leu, é `DOC_CONFLICT` e nada é gravado. Toda escrita leva também uma `operationId` (UUID novo por
//   intenção): repetir a mesma operação, como o replay de uma execução abandonada, devolve o resultado gravado em vez de gravar de novo.
// - O acesso do bot é uma lista de bots escolhida SÓ pelo dono, com uma REVISÃO DE ACESSO (`accessVersion`) que sobe a cada mudança da lista: é o que torna uma leitura antiga
//   do bot inválida quando o dono revoga (proveniência, A33) e o que o compartilhamento confere para não gravar por cima de uma lista que mudou (`expectedAccessVersion`).
//
// O texto NUNCA é normalizado (Markdown canônico, caractere por caractere, A17): só o título é aparado e normalizado em NFC. Quem decide o limite de 100.000 e o erro
// `DOC_TOO_LARGE` é o serviço (como a memória): estes schemas só garantem o FORMATO (texto bem formado e sem caracteres de controle fora do espaço em branco).
import { z } from 'zod';
import { CONTROL_CHARS_EXCEPT_WHITESPACE, countChars } from './bots';
import { MEMORY_MIN_VERSIONS, MEMORY_RETENTION_DAYS } from './memory';

export const DOC_LIMITS = { titleChars: 120, contentChars: 100_000, docs: 100, botIds: 100 } as const;

/** Retenção das versões: a de MEM-01 (versões com mais de 90 dias saem, as 50 mais recentes de cada doc ficam sempre), com a mesma fonte para não divergirem. */
export const DOC_RETENTION_DAYS = MEMORY_RETENTION_DAYS;
export const DOC_MIN_VERSIONS = MEMORY_MIN_VERSIONS;
/** Quantas versões o histórico devolve (as mais recentes). ponytail: sem paginação, paginar se um doc passar de algumas centenas de versões dentro da retenção. */
export const DOC_HISTORY_LIMIT = 200;
/** Tamanho padrão de uma página de leitura em caracteres; o teto do resultado que chega ao modelo (12.000, com a moldura) é de quem monta a ferramenta. */
export const DOC_READ_PAGE_CHARS = 10_000;
/**
 * Teto do corpo das rotas de docs: comporta um texto de 100.000 caracteres no pior caso de JSON legal (cada caractere astral escapado como par substituto,
 * 12 bytes, ou 4 bytes em UTF-8 cru) mais folga para os demais campos. O limite global da API (256 KiB) recusaria um texto válido não ASCII.
 */
export const DOC_BODY_LIMIT = 12 * DOC_LIMITS.contentChars + 16 * 1024;

/**
 * Identidade da exclusão para a regra de aprovação, no molde de `TABLE_ACTIONS`: o navegador e o executor usam a mesma categoria local, sem consultar o conector.
 * É a única ação de doc que pede aprovação (restaurar e editar são reversíveis pelo histórico).
 */
export const DOC_ACTIONS = {
  delete: { slug: 'aion_doc_delete', label: 'Excluir doc', appSlug: 'aion_docs', appName: 'Docs do Aion' },
} as const;

/** Maior número de versão aceito (o `integer` do PostgreSQL). */
const VERSION_MAX = 2_147_483_647;

export const docIdSchema = z.uuid();
/** Identidade de UMA intenção de escrita: o cliente (ou a ferramenta) gera um UUID novo por tentativa lógica e o reaproveita nas repetições. */
export const docOperationIdSchema = z.uuid();
export const docVersionSchema = z.number().int().min(1).max(VERSION_MAX);
export const docAccessVersionSchema = z.number().int().min(1).max(VERSION_MAX);

/** Texto vindo de fora: bem formado (sem surrogate solto, que o banco trocaria em silêncio) e sem caractere de controle além de tabulação e quebras de linha. */
const text = (min: number) =>
  z
    .string()
    .min(min)
    .refine((value) => !/\p{Surrogate}/u.test(value))
    .refine((value) => !CONTROL_CHARS_EXCEPT_WHITESPACE.test(value));

/** Título: aparado, NFC, 1 a 120 caracteres de verdade, uma linha só e sem controle. O teto em unidades UTF-16 vem antes da contagem para o custo ficar limitado. */
export const docTitleSchema = z
  .string()
  .trim()
  .normalize('NFC')
  .refine((value) => value.length <= DOC_LIMITS.titleChars * 2 && countChars(value) >= 1 && countChars(value) <= DOC_LIMITS.titleChars)
  .refine((value) => !/\p{Surrogate}/u.test(value) && !/\p{Cc}/u.test(value));

/** Texto do doc (pode ser vazio). O limite de 100.000 caracteres é do serviço (`DOC_TOO_LARGE`). */
export const docContentSchema = text(0);

const botIds = z
  .array(z.uuid())
  .max(DOC_LIMITS.botIds)
  .refine((ids) => new Set(ids).size === ids.length);

/** Criação feita pela ferramenta do bot: o doc nasce associado ao próprio bot (o servidor decide; o modelo nunca escolhe bots). */
export const docCreateSchema = z.strictObject({ title: docTitleSchema, content: docContentSchema.default(''), operationId: docOperationIdSchema });
/** Criação feita pelo dono: escolhe os bots que acessam o doc (nenhum é permitido, como "Sem bot" nas tabelas). */
export const docCreateRequestSchema = docCreateSchema.extend({ botIds: botIds.default([]) });

/**
 * As três edições do texto (decisão 13), sempre sobre a versão esperada:
 * - `append`: junta `text` ao fim; se o texto atual não está vazio nem termina em quebra de linha, entra uma quebra antes (como a memória), nunca duas;
 * - `replace`: troca o trecho EXATO `find` (literal, diferencia maiúsculas, sem padrões) por `replacement`, que pode ser vazio; o trecho tem de aparecer UMA vez só;
 * - `rewrite`: troca o texto inteiro.
 */
export const docEditSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('append'), text: text(1) }),
  z.strictObject({ operation: z.literal('replace'), find: text(1), replacement: docContentSchema }),
  z.strictObject({ operation: z.literal('rewrite'), content: docContentSchema }),
]);
export type DocEdit = z.infer<typeof docEditSchema>;

/**
 * Alteração do doc: o texto por uma das edições e/ou o título (só o dono renomeia; o serviço recusa o título vindo de um bot). A versão esperada confere o TEXTO; o título
 * sozinho não cria versão.
 */
export const docUpdateSchema = z
  .strictObject({ expectedVersion: docVersionSchema, operationId: docOperationIdSchema, title: docTitleSchema.optional(), edit: docEditSchema.optional() })
  .refine((input) => input.title !== undefined || input.edit !== undefined);
export const docRestoreSchema = z.strictObject({ version: docVersionSchema, expectedVersion: docVersionSchema, operationId: docOperationIdSchema });
/** Compartilhamento (só o dono): a lista COMPLETA de bots, conferida pela revisão de acesso que a tela leu. */
export const docShareSchema = z.strictObject({ botIds, expectedAccessVersion: docAccessVersionSchema, operationId: docOperationIdSchema });
export const docDeleteSchema = z.strictObject({ operationId: docOperationIdSchema });
/** Leitura paginada por caractere; `expectedVersion` garante que as páginas em sequência são do mesmo texto. */
export const docReadSchema = z.strictObject({
  offset: z.number().int().min(0).max(DOC_LIMITS.contentChars).default(0),
  limit: z.number().int().min(1).max(DOC_LIMITS.contentChars).default(DOC_READ_PAGE_CHARS),
  expectedVersion: docVersionSchema.optional(),
});
export const docListQuerySchema = z.strictObject({ botId: z.uuid().optional() });
export const docParamsSchema = z.strictObject({ docId: docIdSchema });
export const docVersionParamsSchema = docParamsSchema.extend({ version: z.coerce.number().int().min(1).max(VERSION_MAX) });

export type DocCreateInput = z.input<typeof docCreateRequestSchema>;
export type DocUpdateInput = z.input<typeof docUpdateSchema>;
export type DocRestoreInput = z.input<typeof docRestoreSchema>;
export type DocShareInput = z.input<typeof docShareSchema>;
export type DocDeleteInput = z.input<typeof docDeleteSchema>;
export type DocReadInput = z.input<typeof docReadSchema>;
export type DocListInput = z.input<typeof docListQuerySchema>;

/** Quem gravou a versão (ou o último ato do doc): o dono (tela, restauração) ou o bot (ferramenta). */
export const docAuthorSchema = z.enum(['owner', 'bot']);
export type DocAuthor = z.infer<typeof docAuthorSchema>;

/**
 * O doc sem o texto (lista, resultado de escrita). `botIds` é a lista de bots só para o dono; o bot recebe sempre `[]` (não descobre quem mais acessa o doc, como nas tabelas).
 * `size` é o tamanho do texto em caracteres.
 */
export const docSummarySchema = z.object({
  id: docIdSchema,
  title: z.string(),
  version: docVersionSchema,
  accessVersion: docAccessVersionSchema,
  size: z.number().int().nonnegative(),
  botIds: z.array(z.uuid()),
  updatedBy: docAuthorSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type DocSummary = z.infer<typeof docSummarySchema>;

export const docSchema = docSummarySchema.extend({ content: z.string() });
export type Doc = z.infer<typeof docSchema>;

export const docListSchema = z.object({ docs: z.array(docSummarySchema) });
export type DocList = z.infer<typeof docListSchema>;

/** Resultado de `update` e `restore`: o doc depois da operação e se algo mudou (texto igual ao atual ou título igual não cria versão: `changed: false`). */
export const docWriteResultSchema = z.object({ doc: docSummarySchema, changed: z.boolean() });
export type DocWriteResult = z.infer<typeof docWriteResultSchema>;

/**
 * Resultado da exclusão: só o id. O título NÃO volta (nem no resultado gravado no recibo): o dono exclui esperando que o nome saia, e quem mostra o título do que vai ser apagado é o cartão de
 * aprovação, antes (`DocService.peek`).
 */
export const docDeleteResultSchema = z.object({ id: docIdSchema, deleted: z.literal(true) });
export type DocDeleteResult = z.infer<typeof docDeleteResultSchema>;

/** Uma página do texto: `offset` e `nextOffset` contam caracteres; `nextOffset` nulo é o fim. `size` é o tamanho total do texto. */
export const docPageSchema = z.object({
  id: docIdSchema,
  title: z.string(),
  version: docVersionSchema,
  size: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  content: z.string(),
  nextOffset: z.number().int().positive().nullable(),
});
export type DocPage = z.infer<typeof docPageSchema>;

/** Item do histórico: a versão, quem gravou, quando, o tamanho do texto e (se for restauração) de qual versão veio. */
export const docVersionSummarySchema = z.object({
  version: docVersionSchema,
  author: docAuthorSchema,
  createdAt: z.iso.datetime(),
  size: z.number().int().nonnegative(),
  restoredFrom: docVersionSchema.nullable(),
});
export type DocVersionSummary = z.infer<typeof docVersionSummarySchema>;

export const docVersionListSchema = z.object({ versions: z.array(docVersionSummarySchema) });
export type DocVersionList = z.infer<typeof docVersionListSchema>;

export const docVersionDetailSchema = docVersionSummarySchema.extend({ content: z.string() });
export type DocVersionDetail = z.infer<typeof docVersionDetailSchema>;

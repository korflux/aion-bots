// Contratos da memória global e por bot (F11, T8) compartilhados entre a API, o core e a web.
//
// Modelo (MEM-01, MEM-02): a memória é UM texto em Markdown por bot e UM texto global, de até 8.000 caracteres. Cada gravação cria
// uma VERSÃO imutável (número crescente por memória, com autor `owner` ou `bot`); restaurar ou desfazer nunca altera uma versão
// antiga, cria uma nova. O salvamento leva a versão esperada: se a memória mudou desde que a tela a carregou, é MEMORY_CONFLICT
// (a tela preserva o texto digitado). O bot só escreve na PRÓPRIA memória; a global é do dono.
//
// Este arquivo também é a FONTE ÚNICA do diff de linhas: o core o usa para o resumo do cartão e o histórico, e a web para
// desenhá-lo (prefixos `+`/`−` e fundo por estado, em `memory-diff.tsx`; o desenho não altera o cálculo).
import { z } from 'zod';
import { CONTROL_CHARS_EXCEPT_WHITESPACE } from './bots';

/** Limite de caracteres de cada memória (spec decisão 11). */
export const MEMORY_MAX_CHARS = 8000;
/** A partir daqui o contador da tela vira aviso (design: acima de 7.200). */
export const MEMORY_WARN_CHARS = 7200;
/** Retenção das versões: 90 dias, mas nunca menos que as 50 mais recentes (MEM-01). */
export const MEMORY_RETENTION_DAYS = 90;
export const MEMORY_MIN_VERSIONS = 50;
/** Teto do corpo aceito na borda (bem acima do limite): quem decide `MEMORY_TOO_LARGE` é o core, com a mensagem do contrato. */
export const MEMORY_INPUT_MAX = 100_000;
/** Linhas do diff mostradas no cartão "Memória atualizada" (design: diff resumido em 3 linhas). */
export const MEMORY_CARD_PREVIEW_LINES = 3;

/** Maior número de versão aceito nos parâmetros (o `integer` do PostgreSQL). */
const VERSION_MAX = 2_147_483_647;

// ---------------------------------------------------------------------------------------------
// Diff de linhas
// ---------------------------------------------------------------------------------------------

export const diffLineSchema = z.object({ kind: z.enum(['add', 'remove', 'same']), text: z.string() });
export type DiffLine = z.infer<typeof diffLineSchema>;

/** Acima deste produto de linhas (do trecho que mudou) o diff exato custaria memória demais e o trecho vira "tudo trocado". */
const DIFF_CELL_LIMIT = 1_000_000;

const linesOf = (text: string): string[] => (text === '' ? [] : text.split('\n'));

/**
 * Diff por linhas entre dois textos: o prefixo e o sufixo iguais são separados e o miolo usa a maior subsequência comum.
 * Determinístico (em empate, a remoção vem antes da adição). ponytail: miolo com mais de 1.000.000 de pares de linhas
 * (cerca de 1.000 x 1.000) é tratado como troca total, o que na prática não ocorre com 8.000 caracteres; trocar por Myers
 * se o limite da memória subir muito.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = linesOf(before);
  const b = linesOf(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  const middle: DiffLine[] = [];
  if (midA.length * midB.length > DIFF_CELL_LIMIT) {
    for (const text of midA) middle.push({ kind: 'remove', text });
    for (const text of midB) middle.push({ kind: 'add', text });
  } else {
    // lcs[i][j] = tamanho da maior subsequência comum de midA[i..] e midB[j..].
    const width = midB.length + 1;
    const lcs = new Uint32Array((midA.length + 1) * width);
    for (let i = midA.length - 1; i >= 0; i -= 1) {
      for (let j = midB.length - 1; j >= 0; j -= 1) {
        lcs[i * width + j] =
          midA[i] === midB[j] ? (lcs[(i + 1) * width + j + 1] as number) + 1 : Math.max(lcs[(i + 1) * width + j] as number, lcs[i * width + j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        middle.push({ kind: 'same', text: midA[i] as string });
        i += 1;
        j += 1;
      } else if ((lcs[(i + 1) * width + j] as number) >= (lcs[i * width + j + 1] as number)) {
        middle.push({ kind: 'remove', text: midA[i] as string });
        i += 1;
      } else {
        middle.push({ kind: 'add', text: midB[j] as string });
        j += 1;
      }
    }
    for (; i < midA.length; i += 1) middle.push({ kind: 'remove', text: midA[i] as string });
    for (; j < midB.length; j += 1) middle.push({ kind: 'add', text: midB[j] as string });
  }

  return [
    ...a.slice(0, start).map((text): DiffLine => ({ kind: 'same', text })),
    ...middle,
    ...a.slice(endA).map((text): DiffLine => ({ kind: 'same', text })),
  ];
}

/** Linhas adicionadas e removidas de um diff (o "+3 −1 linhas" do histórico). */
export function countDiff(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === 'add') added += 1;
    else if (line.kind === 'remove') removed += 1;
  }
  return { added, removed };
}

/** As primeiras linhas que mudaram (sem as iguais), para o cartão resumido. */
export const previewDiff = (lines: readonly DiffLine[], max = MEMORY_CARD_PREVIEW_LINES): DiffLine[] =>
  lines.filter((line) => line.kind !== 'same').slice(0, max);

// ---------------------------------------------------------------------------------------------
// Visões e comandos
// ---------------------------------------------------------------------------------------------

/** Quem gravou a versão: o dono (tela, restauração, desfazer) ou o bot (ferramenta). */
export const memoryAuthorSchema = z.enum(['owner', 'bot']);
export type MemoryAuthor = z.infer<typeof memoryAuthorSchema>;

const versionNumberSchema = z.number().int().min(0).max(VERSION_MAX);
const positiveVersionSchema = z.number().int().min(1).max(VERSION_MAX);

/** Texto vindo de fora: só o formato e um teto generoso (o limite de 8.000 e o erro `MEMORY_TOO_LARGE` são do core). */
export const memoryContentInputSchema = z
  .string()
  .max(MEMORY_INPUT_MAX)
  .refine((value) => !CONTROL_CHARS_EXCEPT_WHITESPACE.test(value));

/** A memória atual. `version` 0 é a memória que nunca foi gravada (vazia). */
export const memoryViewSchema = z.object({
  content: z.string(),
  version: versionNumberSchema,
  limit: z.literal(MEMORY_MAX_CHARS),
  updatedAt: z.iso.datetime().nullable(),
  updatedBy: memoryAuthorSchema.nullable(),
});
export type MemoryView = z.infer<typeof memoryViewSchema>;

export const saveMemoryRequestSchema = z.strictObject({ content: memoryContentInputSchema, expectedVersion: versionNumberSchema });
export const restoreMemoryRequestSchema = z.strictObject({ version: positiveVersionSchema, expectedVersion: versionNumberSchema });

/** Item do histórico: a versão, quem gravou, quando, o tamanho da mudança e (se for restauração) de qual versão veio. */
export const memoryVersionSummarySchema = z.object({
  version: positiveVersionSchema,
  author: memoryAuthorSchema,
  createdAt: z.iso.datetime(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  restoredFrom: positiveVersionSchema.nullable(),
});
export type MemoryVersionSummary = z.infer<typeof memoryVersionSummarySchema>;

export const memoryVersionListSchema = z.object({ versions: z.array(memoryVersionSummarySchema) });
export type MemoryVersionList = z.infer<typeof memoryVersionListSchema>;

/** Uma versão com o texto dela e o diff em relação à anterior (a primeira, em relação ao vazio). */
export const memoryVersionDetailSchema = memoryVersionSummarySchema.extend({
  content: z.string(),
  diff: z.array(diffLineSchema),
});
export type MemoryVersionDetail = z.infer<typeof memoryVersionDetailSchema>;

export const memoryVersionParamsSchema = z.strictObject({ version: z.coerce.number().int().min(1).max(VERSION_MAX) });
export const botMemoryVersionParamsSchema = memoryVersionParamsSchema.extend({ id: z.uuid() });

/** Desfazer pelo cartão: o id do cartão (mensagem) na conversa do bot, inteiro grande em texto como os demais ids. */
export const undoMemoryRequestSchema = z.strictObject({ cardId: z.string().regex(/^\d{1,18}$/) });

/**
 * Cartão "Memória atualizada" na conversa (membro de `systemCardSchema`): o bot gravou a versão `version` sobre
 * `previousVersion`. `status` passa a `undone` quando o dono desfaz.
 */
export const memoryCardSchema = z.object({
  type: z.literal('memory_updated'),
  version: positiveVersionSchema,
  previousVersion: versionNumberSchema,
  status: z.enum(['applied', 'undone']),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  /** Tamanho da memória depois da edição, para o dono ver a folga (junto do limite). */
  size: z.number().int().nonnegative(),
  limit: z.literal(MEMORY_MAX_CHARS),
  preview: z.array(diffLineSchema),
});
export type MemoryCard = z.infer<typeof memoryCardSchema>;

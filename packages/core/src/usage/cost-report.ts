// Relatório de custo de tokens (P0 de docs/estudo-custo-tokens.md): lê o ledger `model_call_usage`, classifica cada chamada pela posição em que
// aconteceu e calcula o custo em US$ dividido em entrada sem cache, entrada em cache (leitura), gravação de cache (só o protocolo `messages`, migration 0049) e saída. Serve para medir onde o cache de prefixo do provedor
// se perde (abertura de rodada, retomada após aprovação, abertura de grupo por `abrir_grupo` ou seleção por `discover_tools`, compactação) antes de mudar o motor.
//
// Só lê: identificadores, números e datas. Nenhum conteúdo de conversa, nome de bot ou argumento de ferramenta sai daqui, como no log do worker.
// O ledger nasceu na migration 0036 e some em cascata com a conversa (sessão do Chat geral vencida, bot excluído), então o período coberto é o
// que ainda existe no banco.
import type { Queryable } from '../db/pool';
import { SUMMARY_TARGET_MAX_CHARS, SUMMARY_TARGET_MIN_CHARS } from '../runs/compaction';
import { SUMMARY_MAX_CHARS } from '../runs/context-checkpoint';
import { ABRIR_GRUPO, DISCOVER_TOOLS } from '../runs/tool-discovery';
import type { ModelPrice } from '../models/prices';

// --- Preços ---------------------------------------------------------------------------------------------------------------------------------

// A tabela (`MODEL_PRICES`, por `provedor/modelo`) e o tipo `ModelPrice` moraram aqui até a phase 17; hoje são de `models/prices.ts`, também lidos pelo selo de preço do seletor (A23).
// O relatório separa o mesmo Claude por provedor porque cada id carrega o prefixo (A24).

// --- Classificação das chamadas ----------------------------------------------------------------------------------------------------------------

/**
 * Posição da chamada, que é o que decide o cache:
 * - `abertura_quente`: primeira chamada principal da execução com a conversa usada há menos de `HOT_GAP_MINUTES` (o cache ainda deveria existir);
 * - `abertura_fria`: primeira chamada da execução numa conversa parada (perda de cache esperada pelo tempo);
 * - `apos_compactacao`: primeira chamada principal depois de um resumo da mesma execução (prefixo novo por desenho);
 * - `apos_aprovacao`: primeira chamada depois de uma aprovação decidida (posse nova, hora relida);
 * - `apos_abrir_grupo`: chamada seguinte a uma etapa do bot que chamou `abrir_grupo` (phase 15, A23): o campo `tools` NÃO muda, o esquema da ferramenta chega como resultado no fim do histórico, e
 *   a fração de cache dessa etapa mostra se a abertura preservou o prefixo;
 * - `apos_discover_tools`: chamada seguinte a uma etapa que chamou `discover_tools`, a porta do Chat geral (campo `tools` mudou);
 * - `continuacao`: demais etapas do laço, que deveriam vir quase todas do cache;
 * - `resumo`: a própria chamada de resumo da compactação.
 */
export const CALL_CATEGORIES = ['abertura_quente', 'abertura_fria', 'apos_compactacao', 'apos_aprovacao', 'apos_abrir_grupo', 'apos_discover_tools', 'continuacao', 'resumo'] as const;
export type CallCategory = (typeof CALL_CATEGORIES)[number];

/** Rótulo legível de cada categoria na saída em texto. */
const CATEGORY_LABELS: Record<CallCategory, string> = {
  abertura_quente: 'Abertura, conversa ativa',
  abertura_fria: 'Abertura, conversa parada',
  apos_compactacao: 'Após compactação',
  apos_aprovacao: 'Após aprovação',
  apos_abrir_grupo: 'Após abrir_grupo',
  apos_discover_tools: 'Após discover_tools',
  continuacao: 'Continuação do laço',
  resumo: 'Resumo (compactação)',
};

/** Intervalo até o qual uma abertura conta como conversa ativa. Abaixo dele, cache baixo na abertura aponta para o prompt, não para o tempo. */
export const HOT_GAP_MINUTES = 30;

/** De onde veio a execução. */
export type CallOrigin = 'bot' | 'chat_geral' | 'rotina';

/**
 * Uma chamada ao modelo com uso informado pelo provedor. `cachedTokens` nulo = o provedor não informou cache. `cacheWriteTokens` é a gravação de cache (migration 0049, só o
 * protocolo `messages`), uma fatia de `inputTokens` separada da leitura; nulo = o provedor não informou ou a chamada é anterior à migration. `reasoningTokens` é a fatia de `outputTokens`
 * gasta em raciocínio (já cobrada como saída, nunca somada a ela); nulo = o provedor não informou (protocolo messages, campo omitido, chamada anterior à migration 0045).
 */
export interface UsageCall {
  runId: string;
  conversationId: string;
  origin: CallOrigin;
  model: string;
  category: CallCategory;
  inputTokens: number;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number;
  reasoningTokens: number | null;
  createdAt: Date;
  /** Dia no fuso pedido (AAAA-MM-DD). */
  day: string;
}

/**
 * Lê as chamadas concluídas do período e classifica cada uma no banco. As janelas (`lag`) rodam sobre o ledger inteiro antes do filtro de data, para
 * que a primeira chamada do período enxergue a anterior. Chamadas sem usage (`unknown`) ficam de fora e são contadas à parte em `readSkippedCalls`.
 */
export async function readUsageCalls(db: Queryable, { since, until, timeZone }: { since: Date; until: Date; timeZone: string }): Promise<UsageCall[]> {
  const { rows } = await db.query<{
    run_id: string; conversation_id: string; origin: CallOrigin; model: string; category: CallCategory;
    input_tokens: string; cached_tokens: string | null; cache_write_tokens: string | null; output_tokens: string | null; reasoning_tokens: string | null; created_at: Date; day: string;
  }>(
    `WITH ordered AS (
       SELECT u.*,
              lag(u.created_at) OVER (PARTITION BY u.run_id, u.purpose ORDER BY u.created_at, u.id) AS prev_main_at,
              lag(u.created_at) OVER (PARTITION BY u.conversation_id ORDER BY u.created_at, u.id) AS prev_conv_at
         FROM model_call_usage u
     )
     SELECT o.run_id::text, o.conversation_id::text, o.model, o.input_tokens::text, o.cached_tokens::text, o.cache_write_tokens::text, o.output_tokens::text, o.reasoning_tokens::text, o.created_at,
            to_char(o.created_at AT TIME ZONE $3, 'YYYY-MM-DD') AS day,
            CASE WHEN r.routine_id IS NOT NULL OR r.routine_name IS NOT NULL THEN 'rotina' WHEN c.bot_id IS NULL THEN 'chat_geral' ELSE 'bot' END AS origin,
            CASE
              WHEN o.purpose = 'summary' THEN 'resumo'
              WHEN EXISTS (SELECT 1 FROM model_call_usage s WHERE s.run_id = o.run_id AND s.purpose = 'summary'
                             AND s.created_at < o.created_at AND (o.prev_main_at IS NULL OR s.created_at > o.prev_main_at)) THEN 'apos_compactacao'
              WHEN o.prev_main_at IS NULL THEN
                CASE WHEN o.prev_conv_at IS NOT NULL AND o.created_at - o.prev_conv_at < make_interval(mins => $4) THEN 'abertura_quente' ELSE 'abertura_fria' END
              WHEN EXISTS (SELECT 1 FROM approvals a WHERE a.run_id = o.run_id AND a.decided_at > o.prev_main_at AND a.decided_at <= o.created_at) THEN 'apos_aprovacao'
              WHEN EXISTS (SELECT 1 FROM messages m WHERE m.run_id = o.run_id AND m.kind = 'activity' AND m.data->>'tool' = $5
                             AND m.created_at > o.prev_main_at AND m.created_at <= o.created_at) THEN 'apos_abrir_grupo'
              WHEN EXISTS (SELECT 1 FROM messages m WHERE m.run_id = o.run_id AND m.kind = 'activity' AND m.data->>'tool' = $6
                             AND m.created_at > o.prev_main_at AND m.created_at <= o.created_at) THEN 'apos_discover_tools'
              ELSE 'continuacao'
            END AS category
       FROM ordered o
       JOIN runs r ON r.id = o.run_id
       JOIN conversations c ON c.id = o.conversation_id
      WHERE o.state = 'completed' AND o.input_tokens IS NOT NULL AND o.created_at >= $1 AND o.created_at < $2
      ORDER BY o.created_at, o.id`,
    [since, until, timeZone, HOT_GAP_MINUTES, ABRIR_GRUPO, DISCOVER_TOOLS],
  );
  return rows.map((row) => ({
    runId: row.run_id, conversationId: row.conversation_id, origin: row.origin, model: row.model, category: row.category,
    inputTokens: Number(row.input_tokens), cachedTokens: row.cached_tokens === null ? null : Number(row.cached_tokens),
    cacheWriteTokens: row.cache_write_tokens === null ? null : Number(row.cache_write_tokens),
    outputTokens: row.output_tokens === null ? 0 : Number(row.output_tokens), reasoningTokens: row.reasoning_tokens === null ? null : Number(row.reasoning_tokens),
    createdAt: row.created_at, day: row.day,
  }));
}

/** Chamadas do período sem usage confirmado (falha, interrupção, provedor sem telemetria): pagas ou não, ficam fora das contas. */
export async function readSkippedCalls(db: Queryable, { since, until }: { since: Date; until: Date }): Promise<number> {
  const { rows } = await db.query<{ total: number }>(
    "SELECT count(*)::int AS total FROM model_call_usage WHERE created_at >= $1 AND created_at < $2 AND (state <> 'completed' OR input_tokens IS NULL)",
    [since, until],
  );
  return rows[0]?.total ?? 0;
}

/**
 * Tamanho, em caracteres, dos checkpoints vigentes (um por conversa compactada; `conversation_context.summary`). Só o comprimento sai do banco, nunca o
 * texto. O checkpoint entra em todo pedido seguinte da conversa, e o resumo que o produz é cobrado como saída, a etapa mais cara por token.
 */
export async function readCheckpointSizes(db: Queryable): Promise<number[]> {
  const { rows } = await db.query<{ chars: number }>("SELECT char_length(summary) AS chars FROM conversation_context WHERE summary <> '' ORDER BY 1");
  return rows.map((row) => row.chars);
}

// --- Contas ------------------------------------------------------------------------------------------------------------------------------------

/** Soma de tokens e custo de um grupo de chamadas. Custos ficam nulos quando alguma chamada do grupo não tem preço. */
export interface CostTotals {
  calls: number;
  inputTokens: number;
  cachedTokens: number;
  /** Gravação de cache (só o `messages`): fatia da entrada contada à parte da leitura. Chamada sem dado conta como 0. */
  cacheWriteTokens: number;
  outputTokens: number;
  /** Chamadas em que o provedor não informou cache (contadas como 0 em cache). */
  callsWithoutCacheData: number;
  /**
   * Raciocínio: soma só do que o provedor informou, e é uma FATIA de `outputTokens` (não acresce nada, e o custo em US$ não muda). Chamada sem dado não conta como 0:
   * entra em `callsWithoutReasoningData`, e `reportedOutputTokens` guarda a saída só das que informaram, a base honesta do percentual quando o grupo é misto.
   */
  reasoningTokens: number;
  reportedOutputTokens: number;
  callsWithoutReasoningData: number;
  uncachedUsd: number | null;
  cachedUsd: number | null;
  /** Gravação de cache cobrada pelo `cacheWrite` do modelo, ou pelo preço de entrada quando ele não o declara. */
  cacheWriteUsd: number | null;
  outputUsd: number | null;
  totalUsd: number | null;
  /**
   * Quanto se economizaria se toda a entrada que não veio do cache (sem cache e gravada) tivesse vindo dele: o teto do ganho de qualquer correção de cache no grupo.
   * A gravação entra porque, como a entrada sem cache, é token que não foi lido; parte dela é inevitável (todo conteúdo novo é gravado uma vez), então o teto é folgado.
   */
  missedCacheUsd: number | null;
}

/** Totais vazios, ponto de partida de cada grupo. */
const emptyTotals = (): CostTotals => ({ calls: 0, inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, callsWithoutCacheData: 0, reasoningTokens: 0, reportedOutputTokens: 0, callsWithoutReasoningData: 0, uncachedUsd: 0, cachedUsd: 0, cacheWriteUsd: 0, outputUsd: 0, totalUsd: 0, missedCacheUsd: 0 });

/** Soma um valor em US$ preservando a nulidade: um grupo com uma chamada sem preço não tem custo confiável. */
const addUsd = (sum: number | null, value: number | null): number | null => (sum === null || value === null ? null : sum + value);

/**
 * Acrescenta uma chamada aos totais. A entrada se reparte em três: lida do cache, gravada no cache e sem cache (o resto); leitura e gravação nunca passam da entrada
 * (provedor incoerente não gera custo negativo). A gravação é cobrada pelo `cacheWrite` do modelo, ou pelo preço de entrada quando ele não o declara. O raciocínio nunca
 * passa da saída e só alimenta os contadores de tokens: o custo da saída continua `outputTokens` inteiro, que já o contém.
 */
export function addCall(totals: CostTotals, call: UsageCall, price: ModelPrice | undefined): void {
  const cached = Math.min(call.cachedTokens ?? 0, call.inputTokens);
  const written = Math.min(call.cacheWriteTokens ?? 0, call.inputTokens - cached);
  const uncached = call.inputTokens - cached - written;
  totals.calls += 1;
  totals.inputTokens += call.inputTokens;
  totals.cachedTokens += cached;
  totals.cacheWriteTokens += written;
  totals.outputTokens += call.outputTokens;
  if (call.cachedTokens === null) totals.callsWithoutCacheData += 1;
  if (call.reasoningTokens === null) totals.callsWithoutReasoningData += 1;
  else {
    totals.reasoningTokens += Math.min(call.reasoningTokens, call.outputTokens);
    totals.reportedOutputTokens += call.outputTokens;
  }
  const writePrice = price ? price.cacheWrite ?? price.input : 0;
  const usd = price ? {
    uncached: (uncached * price.input) / 1e6,
    cached: (cached * price.cached) / 1e6,
    written: (written * writePrice) / 1e6,
    output: (call.outputTokens * price.output) / 1e6,
    missed: (uncached * (price.input - price.cached) + written * (writePrice - price.cached)) / 1e6,
  } : null;
  totals.uncachedUsd = addUsd(totals.uncachedUsd, usd?.uncached ?? null);
  totals.cachedUsd = addUsd(totals.cachedUsd, usd?.cached ?? null);
  totals.cacheWriteUsd = addUsd(totals.cacheWriteUsd, usd?.written ?? null);
  totals.outputUsd = addUsd(totals.outputUsd, usd?.output ?? null);
  totals.totalUsd = addUsd(totals.totalUsd, usd ? usd.uncached + usd.cached + usd.written + usd.output : null);
  totals.missedCacheUsd = addUsd(totals.missedCacheUsd, usd?.missed ?? null);
}

/** Relatório agregado: total, por modelo, por categoria, por origem, por dia e as execuções mais caras. */
export interface CostReport {
  total: CostTotals;
  byModel: Map<string, CostTotals>;
  byCategory: Map<CallCategory, CostTotals>;
  byOrigin: Map<CallOrigin, CostTotals>;
  byDay: Map<string, CostTotals>;
  topRuns: { runId: string; origin: CallOrigin; day: string; totals: CostTotals }[];
  modelsWithoutPrice: string[];
}

/** Agrega as chamadas. `topRuns` ordena por custo (ou por entrada sem cache quando não há preço) e guarda as `topRunCount` primeiras. */
export function buildCostReport(calls: readonly UsageCall[], prices: Readonly<Record<string, ModelPrice>>, topRunCount = 10): CostReport {
  const total = emptyTotals();
  const byModel = new Map<string, CostTotals>(), byCategory = new Map<CallCategory, CostTotals>(), byOrigin = new Map<CallOrigin, CostTotals>(), byDay = new Map<string, CostTotals>();
  const runs = new Map<string, { runId: string; origin: CallOrigin; day: string; totals: CostTotals }>();
  const group = <K>(map: Map<K, CostTotals>, key: K): CostTotals => map.get(key) ?? map.set(key, emptyTotals()).get(key)!;
  for (const call of calls) {
    const price = prices[call.model];
    for (const totals of [total, group(byModel, call.model), group(byCategory, call.category), group(byOrigin, call.origin), group(byDay, call.day)]) addCall(totals, call, price);
    const run = runs.get(call.runId) ?? runs.set(call.runId, { runId: call.runId, origin: call.origin, day: call.day, totals: emptyTotals() }).get(call.runId)!;
    addCall(run.totals, call, price);
  }
  const weight = (totals: CostTotals) => totals.totalUsd ?? totals.inputTokens - totals.cachedTokens;
  const topRuns = [...runs.values()].sort((a, b) => weight(b.totals) - weight(a.totals)).slice(0, topRunCount);
  const modelsWithoutPrice = [...byModel.keys()].filter((model) => !prices[model]).sort();
  return { total, byModel, byCategory, byOrigin, byDay, topRuns, modelsWithoutPrice };
}

// --- Saída em texto ----------------------------------------------------------------------------------------------------------------------------

const usd = (value: number | null) => (value === null ? 'sem preço' : `US$ ${value.toFixed(4)}`);
const pct = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '-');
const int = (value: number) => value.toLocaleString('pt-BR');

/**
 * Raciocínio de um grupo, como célula e como frase: "sem dado" quando nenhuma chamada informou (nunca 0 por omissão); senão os tokens informados e o percentual da
 * saída DAS CHAMADAS QUE INFORMARAM, mais quantas chamadas do grupo ficaram sem dado quando ele é misto.
 */
const reasoningText = (t: CostTotals): string => {
  if (t.calls === t.callsWithoutReasoningData) return 'sem dado';
  const missing = t.callsWithoutReasoningData > 0 ? `; ${int(t.callsWithoutReasoningData)} sem dado` : '';
  return `${int(t.reasoningTokens)} (${pct(t.reasoningTokens, t.reportedOutputTokens)}${missing})`;
};

/** Uma tabela em Markdown com as colunas comuns de custo; `label` nomeia a primeira coluna. */
function totalsTable(label: string, rows: [string, CostTotals][], grandTotal: CostTotals): string {
  const header = `| ${label} | Chamadas | Entrada | Cache | Gravação | Saída | Raciocínio | Sem cache | Em cache | Gravação US$ | Saída US$ | Total | % do custo | Perda por falta de cache |`;
  const lines = rows.map(([name, t]) => `| ${name} | ${int(t.calls)} | ${int(t.inputTokens)} | ${pct(t.cachedTokens, t.inputTokens)} | ${int(t.cacheWriteTokens)} | ${int(t.outputTokens)} | ${reasoningText(t)} | ${usd(t.uncachedUsd)} | ${usd(t.cachedUsd)} | ${usd(t.cacheWriteUsd)} | ${usd(t.outputUsd)} | ${usd(t.totalUsd)} | ${t.totalUsd !== null && grandTotal.totalUsd ? pct(t.totalUsd, grandTotal.totalUsd) : '-'} | ${usd(t.missedCacheUsd)} |`);
  return [header, `|${'---|'.repeat(14)}`, ...lines].join('\n');
}

/** Média, mediana e máximo de uma lista de números (vazia = nulo). */
function spread(values: readonly number[]): { avg: number; median: number; max: number } | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { avg: sorted.reduce((sum, value) => sum + value, 0) / sorted.length, median: sorted[Math.floor((sorted.length - 1) / 2)]!, max: sorted[sorted.length - 1]! };
}

/**
 * Seção do tamanho da compactação: saída das chamadas de resumo do período (ledger) e tamanho dos checkpoints vigentes. A saída do resumo inclui o raciocínio
 * (o provedor cobra os dois juntos); o quanto dela foi raciocínio vem das mesmas contas do resto do relatório (`addCall`), pela regra única de "sem dado".
 * O teto e o alvo do checkpoint que a linha cita vêm das constantes do motor (`SUMMARY_MAX_CHARS`; `SUMMARY_TARGET_MIN_CHARS` e `SUMMARY_TARGET_MAX_CHARS`, que o prompt do resumo
 * mostra já na primeira tentativa), para o texto do relatório nunca divergir do que o modelo lê.
 */
function summarySection(calls: readonly UsageCall[], checkpointChars: readonly number[]): string {
  const summaryCalls = calls.filter((call) => call.category === 'resumo');
  const output = spread(summaryCalls.map((call) => call.outputTokens));
  const reasoning = emptyTotals();
  for (const call of summaryCalls) addCall(reasoning, call, undefined);
  const chars = spread(checkpointChars);
  const describe = (s: ReturnType<typeof spread>, unit: string) => (s ? `média ${int(Math.round(s.avg))}, mediana ${int(s.median)}, máximo ${int(s.max)} ${unit}` : 'nenhum');
  return [
    `## Tamanho da compactação`,
    `Saída das chamadas de resumo no período: ${describe(output, 'tokens')}. A saída inclui o raciocínio; informado pelo provedor nessas chamadas: ${reasoningText(reasoning)}.`,
    `Checkpoints vigentes (${int(checkpointChars.length)}): ${describe(chars, 'caracteres')}. Teto do produto: ${int(SUMMARY_MAX_CHARS)} caracteres; alvo no prompt do resumo, já na primeira tentativa: ${int(SUMMARY_TARGET_MIN_CHARS)} a ${int(SUMMARY_TARGET_MAX_CHARS)}.`,
  ].join('\n\n');
}

/** Formata o relatório em Markdown, legível no terminal e colável num documento. `calls` e `checkpointChars` alimentam a seção da compactação. */
export function formatCostReport(report: CostReport, meta: { since: Date; until: Date; timeZone: string; skippedCalls: number; calls?: readonly UsageCall[]; checkpointChars?: readonly number[] }): string {
  const t = report.total;
  const parts = [
    `# Custo de tokens do Aion`,
    `Período: ${meta.since.toISOString()} a ${meta.until.toISOString()} (dias no fuso ${meta.timeZone}).`,
    `Chamadas com uso: ${int(t.calls)}. Sem uso confirmado (fora das contas): ${int(meta.skippedCalls)}. Sem dado de cache do provedor: ${int(t.callsWithoutCacheData)}. Sem dado de raciocínio do provedor: ${int(t.callsWithoutReasoningData)}.`,
    report.modelsWithoutPrice.length ? `Modelos sem preço (só tokens; informe com --price modelo=entrada,cache,saída): ${report.modelsWithoutPrice.join(', ')}.` : '',
    `Total: ${usd(t.totalUsd)}; entrada sem cache ${usd(t.uncachedUsd)}, cache ${usd(t.cachedUsd)}, gravação de cache ${usd(t.cacheWriteUsd)}, saída ${usd(t.outputUsd)}. Cache sobre a entrada: ${pct(t.cachedTokens, t.inputTokens)}.`,
    `"Gravação" é a fatia da entrada que o provedor gravou no cache nessas chamadas (só o protocolo messages, cache explícito; migration 0049): já está em "Entrada", não entra em "Cache" (a leitura) e é cobrada pelo preço de gravação do modelo (ou pelo de entrada, se o modelo não o declara).`,
    `"Perda por falta de cache" é quanto o grupo economizaria se toda a entrada que não veio do cache (sem cache e gravada) viesse dele: o teto do ganho de corrigir o cache ali.`,
    `"Raciocínio" é a fatia da saída que o provedor informou ter gasto raciocinando: já está em "Saída" e no custo, não soma ao total. O percentual vale só para as chamadas que informaram; "sem dado" é o grupo em que nenhuma informou, e "N sem dado" conta as chamadas do grupo sem o campo.`,
    `## Por posição da chamada`,
    totalsTable('Posição', CALL_CATEGORIES.filter((key) => report.byCategory.has(key)).map((key) => [CATEGORY_LABELS[key], report.byCategory.get(key)!]), t),
    summarySection(meta.calls ?? [], meta.checkpointChars ?? []),
    `## Por modelo`,
    totalsTable('Modelo', [...report.byModel.entries()].sort(([a], [b]) => a.localeCompare(b)), t),
    `## Por origem`,
    totalsTable('Origem', [...report.byOrigin.entries()].sort(([a], [b]) => a.localeCompare(b)), t),
    `## Por dia`,
    totalsTable('Dia', [...report.byDay.entries()].sort(([a], [b]) => a.localeCompare(b)), t),
    `## Execuções mais caras`,
    totalsTable('Execução (dia, origem)', report.topRuns.map((run) => [`${run.runId} (${run.day}, ${run.origin})`, run.totals]), t),
  ];
  return parts.filter(Boolean).join('\n\n') + '\n';
}

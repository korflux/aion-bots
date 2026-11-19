// Sonda curta da Anthropic (phase 17, passo 1): confirma, contra a API real, os fatos em que o adaptador do provedor (passos 4 a 6) se apoia, antes de qualquer código dele.
// Restrição do dono: toda chamada real usa só `claude-haiku-5-5` (modelo fixo, sem `--model`), chamadas curtas e contadas, teto de US$ 3 para a phase inteira. A sonda usa 3 chamadas ao
// `/messages` (custo na casa de US$ 0,005) e as páginas de `/models` (gratuitas), e recusa continuar se o gasto da própria execução passar de `RUN_COST_CAP_USD`.
//   models   `GET /v1/models` paginado (`limit`, `after_id`, `has_more`, `last_id`): campos do objeto e `max_input_tokens`/`max_tokens` dos modelos Claude (ids do Sonnet e do Opus saem daqui,
//            nunca de memória).
//   call 1   streaming, só `x-api-key` e `anthropic-version` (sem Bearer), `cache_control` nas ferramentas, no sistema e na última mensagem, `output_config.effort`, uma ferramenta de eco que o
//            modelo é instruído a chamar; guarda os blocos que vieram (inclusive `thinking`).
//   call 2   a mesma conversa com o histórico REEDITADO como o produto o reenvia: a chamada da ferramenta e o resultado, SEM nenhum bloco `thinking` (os do passo anterior são descartados).
//            Responde: a API aceita (sem 400) e o prefixo da chamada 1 foi lido do cache? (A17 e A19)
//   call 3   mais uma mensagem do dono sobre o histórico da chamada 2 (também sem `thinking`): confirma que o cache continua sendo lido numa conversa que cresce.
// O saldo esgotado NÃO é provocado (a sonda real não o consegue sem zerar crédito): a forma do erro vem da documentação oficial (https://platform.claude.com/docs/en/api/errors), em que
// "402 `billing_error`" é a falha de cobrança; a sonda só registra o status e o `type` de qualquer recusa que receba, para o passo 7 comparar.
// A chave entra só no ambiente (`AION_VALIDATE_ANTHROPIC_KEY`, carregada de `.env.anthropic` pelo script do `package.json`, arquivo fora do Git). A saída contém exclusivamente identificadores e
// números, como as outras sondas, e a falha sai como envelope `{ code, message, exitCode }`; a chave e o texto da conversa nunca chegam à saída.
//   pnpm validate:anthropic                  # effort low (padrão)
//   pnpm validate:anthropic --effort high    # o modelo tende a pensar: prova o descarte do `thinking` quando há bloco
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Parâmetros
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Único modelo que a sonda chama (restrição do dono): não há opção de linha de comando para trocá-lo. */
export const PROBE_MODEL = 'claude-haiku-5-5';
/** Base da Anthropic; `AION_ANTHROPIC_BASE_URL` (só do ambiente do operador) a substitui, como será no produto. */
const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
/** Preços do Haiku 5.5 até 100 mil tokens de entrada (US$ por milhão): entrada, saída, leitura de cache (0,1x) e gravação de cache de 5 minutos (1,25x). */
const PRICE = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 } as const;
/** Teto de gasto de UMA execução da sonda (o da phase é US$ 3; a sonda gasta cerca de 0,5% dele). */
const RUN_COST_CAP_USD = 0.05;
/** Níveis de effort que a CLI aceita em `--effort` (allowlist; padrão `low`, o mais barato). Com `high` o modelo costuma pensar antes da ferramenta, o que exercita o descarte do `thinking`. */
const EFFORTS = ['low', 'medium', 'high'] as const;
export type ProbeEffort = (typeof EFFORTS)[number];
/** Saída por chamada: o modelo pensa por padrão e o raciocínio conta no limite. */
const MAX_OUTPUT_TOKENS = 2048;
/** Itens por página de `/models` pedida à API: pequena de propósito, para exercitar `has_more`, `last_id` e `after_id` com poucos modelos. */
const MODELS_PAGE_LIMIT = 5;
/** Teto de páginas lidas de `/models` (rede de segurança contra cursor que não avança). */
const MODELS_MAX_PAGES = 20;
/** Notas do sistema sintético: deixam o prefixo acima do piso de cache da família Haiku (~4.096 tokens) com folga, sem dado real. */
const SYSTEM_NOTES = 300;
const TOOL = { name: 'eco', description: 'Devolve o texto recebido. Use quando pedirem para chamar a ferramenta eco.', input_schema: { type: 'object', properties: { texto: { type: 'string' } }, required: ['texto'], additionalProperties: false } } as const;

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Resultado
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/** O uso de uma chamada, nos campos da Anthropic: `inputTokens` NÃO inclui o cache (a leitura e a gravação vêm à parte). */
export interface CallUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }

export interface CallReport {
  call: 1 | 2 | 3;
  /** 200 quando a chamada correu; o status HTTP da recusa quando a API recusou o pedido. */
  status: number;
  /** `type` do erro da API (identificador), só numa recusa. */
  errorType: string | null;
  stopReason: string | null;
  /** Tipos dos blocos de conteúdo recebidos, na ordem (`thinking`, `text`, `tool_use`...). */
  blocks: string[];
  usage: CallUsage | null;
  costUsd: number;
}

export interface ModelsReport {
  pages: number;
  total: number;
  /** A última página veio com `has_more: false`: a paginação por `last_id` -> `after_id` fecha. */
  endedByHasMore: boolean;
  /** Campos do primeiro objeto de modelo (nomes, como a API os devolve). */
  fields: string[];
  /** Cada modelo Claude visto, com a capacidade confirmada (nula quando a API não informa). */
  claude: { id: string; maxInputTokens: number | null; maxTokens: number | null }[];
  haikuFound: boolean;
}

export interface AnthropicReport {
  model: typeof PROBE_MODEL;
  models: ModelsReport;
  calls: CallReport[];
  /** A API aceitou o histórico reeditado sem nenhum bloco `thinking` (chamadas 2 e 3 sem 400). */
  historyWithoutThinkingAccepted: boolean;
  /** A chamada 1 trouxe bloco `thinking`: sem ele, aceitar o histórico sem `thinking` não prova nada. */
  thinkingBlocksSeen: boolean;
  /** Tokens lidos do cache na chamada 2 (A17: acima de zero). */
  cacheReadOnSecondCall: number;
  providerCalls: number;
  costUsd: number;
  passed: boolean;
}

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Chamadas à API
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Cabeçalhos do adaptador da Anthropic: só `x-api-key` e `anthropic-version`, sem `Authorization: Bearer` e sem `x-opencode-session`. */
const headers = (apiKey: string): Record<string, string> => ({ 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' });

/** Identificador seguro de um valor vindo da API (tipo de erro, id de modelo): fora do formato, vira `unknown` e nunca chega à saída como texto livre. */
const safeId = (value: unknown): string => (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : 'unknown');
const numberOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Custo em US$ do uso informado. */
export function costOf(usage: CallUsage): number {
  return (usage.inputTokens * PRICE.input + usage.outputTokens * PRICE.output + usage.cacheReadTokens * PRICE.cacheRead + usage.cacheWriteTokens * PRICE.cacheWrite) / 1_000_000;
}

/** Lê `/models` página a página pelo cursor (`last_id` vira `after_id`) até `has_more: false`. */
async function readModels(fetchImpl: FetchLike, baseUrl: string, apiKey: string): Promise<ModelsReport> {
  const claude: ModelsReport['claude'] = [];
  let fields: string[] = [];
  let pages = 0;
  let total = 0;
  let afterId: string | null = null;
  let endedByHasMore = false;
  while (pages < MODELS_MAX_PAGES) {
    const query = new URLSearchParams({ limit: String(MODELS_PAGE_LIMIT), ...(afterId ? { after_id: afterId } : {}) });
    const response = await fetchImpl(`${baseUrl}/models?${query.toString()}`, { headers: headers(apiKey) });
    if (!response.ok) throw new ProbeError('ANTHROPIC_PROBE_REQUEST_REFUSED', response.status);
    const body = (await response.json()) as { data?: Record<string, unknown>[]; has_more?: boolean; last_id?: string | null };
    pages += 1;
    const data = body.data ?? [];
    total += data.length;
    if (fields.length === 0 && data[0]) fields = Object.keys(data[0]).map(safeId);
    for (const item of data) {
      const id = safeId(item.id);
      if (id.startsWith('claude-')) claude.push({ id, maxInputTokens: numberOrNull(item.max_input_tokens), maxTokens: numberOrNull(item.max_tokens) });
    }
    if (!body.has_more) { endedByHasMore = true; break; }
    if (!body.last_id || body.last_id === afterId) break;
    afterId = body.last_id;
  }
  return { pages, total, endedByHasMore, fields, claude, haikuFound: claude.some((entry) => entry.id === PROBE_MODEL) };
}

/** Sistema sintético sem dado real, grande o bastante para o cache do Haiku. */
const systemText = (): string => `Você é a sonda de validação do Aion. Responda sempre em uma frase curta.\n${Array.from({ length: SYSTEM_NOTES }, (_, index) => `- Nota sintética ${index + 1} da sonda: preferir respostas curtas, objetivas e sem rodeios.`).join('\n')}`;

type Block = Record<string, unknown>;
type Message = { role: 'user' | 'assistant'; content: Block[] };

/** Lista com a marca de cache no último item (como o adaptador do produto fará). */
const markLast = <T extends Record<string, unknown>>(items: T[]): T[] => [...items.slice(0, -1), { ...items.at(-1)!, cache_control: { type: 'ephemeral' } }];

/** Corpo do pedido: ferramentas, sistema e última mensagem com `cache_control`; effort em `output_config`; sem temperature/top_p/top_k nem `tool_choice`. */
function requestBody(messages: Message[], effort: ProbeEffort): Record<string, unknown> {
  const last = messages.at(-1)!;
  return {
    model: PROBE_MODEL,
    stream: true,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: markLast([{ type: 'text', text: systemText() }]),
    messages: [...messages.slice(0, -1), { ...last, content: markLast(last.content) }],
    tools: markLast([TOOL as unknown as Record<string, unknown>]),
    output_config: { effort },
  };
}

interface StreamResult { report: CallReport; text: string; toolUse: { id: string; name: string; input: unknown } | null }

/** Faz uma chamada com streaming e reduz os eventos a tipos de bloco, motivo de parada e uso; o texto livre fica só em memória (nunca emitido). */
async function callMessages(fetchImpl: FetchLike, baseUrl: string, apiKey: string, call: 1 | 2 | 3, messages: Message[], effort: ProbeEffort): Promise<StreamResult> {
  const response = await fetchImpl(`${baseUrl}/messages`, { method: 'POST', headers: headers(apiKey), body: JSON.stringify(requestBody(messages, effort)) });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: { type?: unknown } };
    return { report: { call, status: response.status, errorType: safeId(body.error?.type), stopReason: null, blocks: [], usage: null, costUsd: 0 }, text: '', toolUse: null };
  }
  const blocks: string[] = [];
  const tool = new Map<number, { id: string; name: string; json: string }>();
  let text = '';
  let toolUse: StreamResult['toolUse'] = null;
  let stopReason: string | null = null;
  const usage: CallUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const handle = (data: string): void => {
    const event = JSON.parse(data) as { type?: string; index?: number; message?: { usage?: Record<string, unknown> }; usage?: Record<string, unknown>; content_block?: { type?: string; id?: string; name?: string }; delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string } };
    if (event.type === 'error') throw new ProbeError('ANTHROPIC_PROBE_STREAM_ERROR');
    if (event.type === 'message_start') {
      const start = event.message?.usage ?? {};
      usage.inputTokens = numberOrNull(start.input_tokens) ?? 0;
      usage.cacheReadTokens = numberOrNull(start.cache_read_input_tokens) ?? 0;
      usage.cacheWriteTokens = numberOrNull(start.cache_creation_input_tokens) ?? 0;
      usage.outputTokens = numberOrNull(start.output_tokens) ?? 0;
    } else if (event.type === 'message_delta') {
      // `usage` do evento final é cumulativo na saída; os campos de entrada e cache só mudam se vierem informados.
      const end = event.usage ?? {};
      usage.outputTokens = numberOrNull(end.output_tokens) ?? usage.outputTokens;
      usage.inputTokens = numberOrNull(end.input_tokens) ?? usage.inputTokens;
      usage.cacheReadTokens = numberOrNull(end.cache_read_input_tokens) ?? usage.cacheReadTokens;
      usage.cacheWriteTokens = numberOrNull(end.cache_creation_input_tokens) ?? usage.cacheWriteTokens;
      stopReason = event.delta?.stop_reason ?? stopReason;
    } else if (event.type === 'content_block_start') {
      blocks.push(safeId(event.content_block?.type));
      if (event.content_block?.type === 'tool_use') tool.set(event.index ?? 0, { id: event.content_block.id ?? '', name: event.content_block.name ?? '', json: '' });
    } else if (event.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta') text += event.delta.text ?? '';
      const open = tool.get(event.index ?? 0);
      if (event.delta?.type === 'input_json_delta' && open) open.json += event.delta.partial_json ?? '';
    } else if (event.type === 'content_block_stop') {
      const open = tool.get(event.index ?? 0);
      if (open) toolUse = { id: open.id, name: open.name, input: open.json ? JSON.parse(open.json) : {} };
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut = buffer.indexOf('\n\n');
    while (cut >= 0) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
      if (data) handle(data);
      cut = buffer.indexOf('\n\n');
    }
  }
  return { report: { call, status: 200, errorType: null, stopReason: safeId(stopReason), blocks, usage: { ...usage }, costUsd: costOf(usage) }, text, toolUse };
}

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Sonda
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Roda as três etapas contra `baseUrl` e devolve o relatório; `emit` recebe uma linha por modelo, por chamada e o `result` final. `fetchImpl` é injetável para o teste offline. A chamada 2 só
 * existe se a 1 trouxe uma chamada de ferramenta (sem ela a sonda reprova antes de gastar mais), e nenhum bloco `thinking` da chamada 1 entra no histórico reenviado.
 */
export async function runAnthropicProbe({ fetchImpl = fetch, baseUrl = DEFAULT_BASE_URL, apiKey, emit, effort = 'low' }: { fetchImpl?: FetchLike; baseUrl?: string; apiKey: string; emit: (line: Record<string, unknown>) => void; effort?: ProbeEffort }): Promise<AnthropicReport> {
  const models = await readModels(fetchImpl, baseUrl, apiKey);
  emit({ event: 'models', pages: models.pages, total: models.total, endedByHasMore: models.endedByHasMore, fields: models.fields, claudeModels: models.claude.length });
  for (const entry of models.claude) emit({ event: 'model', id: entry.id, maxInputTokens: entry.maxInputTokens, maxTokens: entry.maxTokens });
  const calls: CallReport[] = [];
  let costUsd = 0;
  const run = async (call: 1 | 2 | 3, messages: Message[]): Promise<StreamResult> => {
    if (costUsd > RUN_COST_CAP_USD) throw new ProbeError('ANTHROPIC_PROBE_COST_CAP');
    const result = await callMessages(fetchImpl, baseUrl, apiKey, call, messages, effort);
    calls.push(result.report);
    costUsd += result.report.costUsd;
    const { usage, ...line } = result.report;
    emit({ event: 'call', ...line, ...(usage ?? {}) });
    return result;
  };
  const finish = (historyOk: boolean, thinkingSeen: boolean, cacheRead: number): AnthropicReport => {
    const report: AnthropicReport = { model: PROBE_MODEL, models, calls, historyWithoutThinkingAccepted: historyOk, thinkingBlocksSeen: thinkingSeen, cacheReadOnSecondCall: cacheRead, providerCalls: calls.length, costUsd, passed: models.haikuFound && historyOk && cacheRead > 0 };
    emit({ event: 'result', model: PROBE_MODEL, providerCalls: report.providerCalls, costUsd, historyWithoutThinkingAccepted: historyOk, thinkingBlocksSeen: thinkingSeen, cacheReadOnSecondCall: cacheRead, passed: report.passed });
    return report;
  };

  const user1: Message = { role: 'user', content: [{ type: 'text', text: 'Calcule mentalmente 17 vezes 23 e confira a conta. Depois chame a ferramenta eco com o texto "ok" e responda apenas com a palavra pronto.' }] };
  const first = await run(1, [user1]);
  const thinkingSeen = first.report.blocks.includes('thinking');
  if (first.report.status !== 200 || !first.toolUse) return finish(false, thinkingSeen, 0);

  // Histórico como o produto o reenvia: a chamada da ferramenta (sem `thinking`) e o resultado, com a marca de cache no fim.
  const assistant1: Message = { role: 'assistant', content: [...(first.text ? [{ type: 'text', text: first.text }] : []), { type: 'tool_use', id: first.toolUse.id, name: first.toolUse.name, input: first.toolUse.input }] };
  const result1: Message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: first.toolUse.id, content: 'ok' }] };
  const second = await run(2, [user1, assistant1, result1]);
  if (second.report.status !== 200) return finish(false, thinkingSeen, 0);

  const assistant2: Message = { role: 'assistant', content: [{ type: 'text', text: second.text.trim() || 'pronto' }] };
  const user2: Message = { role: 'user', content: [{ type: 'text', text: 'Agora responda apenas com a palavra fim.' }] };
  const third = await run(3, [user1, assistant1, result1, assistant2, user2]);
  return finish(third.report.status === 200, thinkingSeen, second.report.usage?.cacheReadTokens ?? 0);
}

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Borda da CLI
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Mensagens seguras por código estável: a causa externa (corpo da API, rede, chave) nunca atravessa esta borda. */
const MESSAGES = {
  ANTHROPIC_PROBE_NO_KEY: 'Falta a chave da sonda. Defina AION_VALIDATE_ANTHROPIC_KEY no ambiente ou em .env.anthropic (arquivo fora do Git).',
  ANTHROPIC_PROBE_REQUEST_REFUSED: 'A Anthropic recusou um pedido da sonda. O status HTTP segue no envelope; confira a chave e a disponibilidade do serviço.',
  ANTHROPIC_PROBE_STREAM_ERROR: 'A Anthropic encerrou o stream com erro no meio da resposta.',
  ANTHROPIC_PROBE_COST_CAP: 'O gasto da execução passou do teto da sonda; nada mais foi chamado.',
  ANTHROPIC_PROBE_FAILED: 'Não foi possível concluir a sonda. Confira a chave no ambiente e a rede.',
  ANTHROPIC_PROBE_INVALID_ARGUMENT: 'Argumento inválido. Use --effort low (padrão), medium ou high; nenhum outro argumento é aceito.',
  ANTHROPIC_PROBE_NOT_CONFIRMED: 'A sonda não confirmou algum fato exigido (histórico sem thinking aceito, leitura de cache na segunda chamada ou o modelo na lista). Veja a linha result.',
} as const;

export class ProbeError extends Error {
  constructor(readonly code: keyof typeof MESSAGES, readonly status?: number) { super(code); }
}

/** Imprime uma linha JSON no stdout: o único canal de saída dos dados da sonda (só identificadores e números). */
const write = (line: Record<string, unknown>): void => { process.stdout.write(`${JSON.stringify(line)}\n`); };

/** Lê `--effort` na borda: só os níveis de `EFFORTS` passam, e a recusa acontece antes de qualquer chamada. */
export function parseEffort(argv: readonly string[]): ProbeEffort {
  let effort: string | undefined;
  try { effort = parseArgs({ args: [...argv], strict: true, options: { effort: { type: 'string' } } }).values.effort; } catch { throw new ProbeError('ANTHROPIC_PROBE_INVALID_ARGUMENT'); }
  if (effort === undefined) return 'low';
  if (!(EFFORTS as readonly string[]).includes(effort)) throw new ProbeError('ANTHROPIC_PROBE_INVALID_ARGUMENT');
  return effort as ProbeEffort;
}

/** Ponto de entrada da CLI: exige a chave antes de qualquer chamada, roda a sonda e fixa o código de saída (1 quando algo falha ou um fato exigido não se confirma). */
async function main(): Promise<void> {
  try {
    const effort = parseEffort(process.argv.slice(2));
    const apiKey = process.env.AION_VALIDATE_ANTHROPIC_KEY?.trim();
    if (!apiKey) throw new ProbeError('ANTHROPIC_PROBE_NO_KEY');
    const report = await runAnthropicProbe({ apiKey, baseUrl: process.env.AION_ANTHROPIC_BASE_URL?.trim() || DEFAULT_BASE_URL, emit: write, effort });
    if (!report.passed) throw new ProbeError('ANTHROPIC_PROBE_NOT_CONFIRMED');
  } catch (error) {
    const code = error instanceof ProbeError ? error.code : 'ANTHROPIC_PROBE_FAILED';
    const status = error instanceof ProbeError && error.status !== undefined ? { status: error.status } : {};
    process.stderr.write(`${JSON.stringify({ code, message: MESSAGES[code], exitCode: 1, ...status })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();

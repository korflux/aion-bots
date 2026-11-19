// Sonda curta do cache automático do provedor (C1 e C4 da phase 10; a versão da phase 3 só media duas execuções seguidas). Com o contexto e o cliente reais, uma conversa
// de um bot é montada pela regra da phase 10 (PERF-01): o bloco `# Dados` de cada rodada nasce na primeira preparação da execução, fica gravado e é reenviado igual em toda
// etapa, retomada e rodada seguinte, então o pedido anterior é sempre o começo exato do próximo e o provedor o reaproveita do cache. Três medições, todas contra o
// `inputTokens` do pedido anterior:
//   next_round     primeira etapa da segunda rodada                                  (C1, exigida: >= 90%)
//   resume         etapa de retomada (mesma execução, nova posse, mesmo bloco)       (C1, exigida: >= 90%)
//   effort_change  primeira etapa de uma rodada com effort diferente da anterior     (C4, só reportada: decide como nasce "Ajustar raciocínio" do Jev)
//   effort_steady  segunda etapa dessa rodada, no mesmo effort                        (controle de C4, só reportada: o cache volta a funcionar no effort novo?)
// No modelo padrão são 6 chamadas curtas ao `deepseek-v4.1-flash` (o teto, restrição do dono). A conversa é roteirizada: a ferramenta de eco é chamada pela própria sonda (o que o modelo
// responde nessas etapas é descartado), então o número de chamadas e a forma dos pedidos não dependem de o modelo obedecer a um enunciado.
// Modo `--model claude-haiku-5-5` (phase 12, T3, C3): o mesmo montador de pedido, agora pelo protocolo `messages`, em que o cache é EXPLÍCITO (`cache_control` no fim das ferramentas, do
// sistema e da última mensagem). Só confirma se o OpenCode Go repassa a marcação à Anthropic: são no máximo 3 chamadas curtas (etapa 1 da rodada 1, etapa 2 depois do eco e etapa 1 da rodada 2),
// com a entrada, a leitura e a gravação de cache de cada uma. Repassou quando alguma chamada gravou ou leu cache (`cacheControlForwarded`); não repassar não reprova (o cache só não aparece, e
// nada quebra), então as medições desse modo são só reportadas. O modelo é uma lista fixa (nunca o `mimo-v2.6-pro`, caro; restrição do dono): outro valor de `--model` é recusado antes de qualquer chamada.
// A chave entra só no ambiente. A saída contém exclusivamente identificadores e números, como o log do worker, e a falha sai como envelope `{ code, message, exitCode }`.
//   node --env-file=.env.provider --import tsx tests/support/validate-prompt-cache.ts                           # real, deepseek-v4.1-flash (o arquivo local está fora do Git)
//   node --env-file=.env.provider --import tsx tests/support/validate-prompt-cache.ts --model claude-haiku-5-5  # real, protocolo messages (até 3 chamadas)
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { buildSystemText, buildTurns, ChatRejected, ChatStreamError, createOpenCodeGoClient, currentDataBlock, TEST_TOOL, type ChatEvent, type ChatProtocol, type ChatRequest, type ChatTurn, type ChatUsage, type ContextRow, type ProviderClient } from '@aion/core';

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Parâmetros da sonda
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Modelos que a sonda aceita (restrição do dono, 16/10/2026, ampliada em 18/10/2026 só para o Haiku): trocar o modelo muda o que ela prova e exige novo pedido, então a lista é fixa e qualquer
 * outro valor de `--model` é recusado. `maxCalls` é o teto de chamadas reais (restrição do dono para sondas curtas): o deepseek usa 6 e o haiku 3. `memoryNotes` é o tamanho da memória
 * sintética do bot: o Haiku só guarda em cache prefixos a partir de ~4.096 tokens (piso da família Haiku 4.5, que o 5.5 deve manter), então o pedido dele é maior para ficar folgado acima do piso.
 */
const PROBE_MODELS = {
  'deepseek-v4.1-flash': { protocol: 'chat_completions', maxCalls: 6, memoryNotes: 90 },
  'claude-haiku-5-5': { protocol: 'messages', maxCalls: 3, memoryNotes: 220 },
} as const satisfies Record<string, { protocol: ChatProtocol; maxCalls: number; memoryNotes: number }>;
export type ProbeModel = keyof typeof PROBE_MODELS;
const DEFAULT_MODEL: ProbeModel = 'deepseek-v4.1-flash';
/** Endereço do OpenCode Go; `AION_OPENCODE_GO_BASE_URL` (só do ambiente do operador) o substitui, como nos outros scripts de validação. */
const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1';
/** Fração mínima do `inputTokens` do pedido anterior que precisa voltar como `cachedTokens` (C1). */
const MIN_CACHED_FRACTION = 0.9;
/** Saída curta por chamada: só o `usage` importa, e o modelo raciocina por padrão (parte do limite é gasta pensando). */
const MAX_OUTPUT_TOKENS = 512;
/** Effort da rodada de C4. A rodada anterior é Padrão (sem o parâmetro); `low` é o nível mais distante dele que o Jev escolheria numa pergunta simples. */
const EFFORT_PROBED = 'low';
/** Idioma e fuso das Configurações do dono simulado (padrões do produto). */
const SETTINGS = { language: 'pt-BR' as const, timeZone: 'America/Sao_Paulo' };
/**
 * Memória sintética do bot da sonda, sem dado real: no deepseek, 90 notas, perto do limite de 8.000 caracteres da memória (MEM-02). O provedor só guarda em cache prefixos a partir de
 * 1.024 tokens e em blocos de 64 (medido na phase 3: sistema mínimo ficou abaixo do piso e não mostrou cache), e a medição compara com o pedido anterior inteiro, então a
 * sonda simula um bot com memória cheia para que os blocos de borda pesem pouco (~4 mil tokens por pedido, perda de até uns 3%). No haiku (`PROBE_MODELS`) são mais notas, só para o pedido ficar acima do piso dele.
 */
const syntheticMemory = (notes: number): string => Array.from({ length: notes }, (_, index) => `- Nota sintética ${index + 1} da sonda: preferir respostas curtas, objetivas e sem rodeios.`).join('\n');
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Resultado
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Uma medição de cache: o que a etapa leu do cache contra o `inputTokens` do pedido anterior. Só identificadores e números. */
export interface CacheMeasurement {
  /** `same_round` só existe no modo messages (etapa 2 depois do eco, a primeira que deveria ler o que a etapa 1 gravou). */
  name: 'same_round' | 'next_round' | 'resume' | 'effort_change' | 'effort_steady';
  /** `true`: reprova a sonda abaixo de 90% (C1). `false`: só reportada (C4, e todas as do modo messages). */
  required: boolean;
  execution: number;
  step: number;
  effort: string;
  /** `false` quando o provedor recusou o pedido (ex.: nível de effort não aceito) ou não informou o uso: não há número para comparar. */
  measured: boolean;
  /** Status HTTP da recusa, só quando o provedor recusou o pedido. */
  status: number | null;
  previousInputTokens: number | null;
  inputTokens: number | null;
  cachedTokens: number | null;
  /** Gravação de cache da etapa (só o protocolo messages informa; nulo nos outros). */
  cacheWriteTokens: number | null;
  /** `cachedTokens / previousInputTokens`: a definição de C1 e C4. */
  cachedOfPrevious: number | null;
  /** `cachedOfPrevious >= 0,9`. */
  passed: boolean;
}

export interface CacheReport {
  conversationId: string;
  model: ProbeModel;
  providerCalls: number;
  measurements: CacheMeasurement[];
  /** As duas medições exigidas passaram (no modo messages não há medição exigida, então passa sempre). É o que decide o código de saída. */
  passed: boolean;
  /** Modo messages (C3): alguma chamada gravou ou leu cache, ou seja, o gateway repassou o `cache_control`. `null` nos outros modelos, onde o cache é automático. */
  cacheControlForwarded: boolean | null;
  /** C4: `true` se a troca de effort manteve o cache, `false` se o perdeu, `null` se não houve número (recusa do nível). */
  effortKeptCache: boolean | null;
  /** Controle de C4: `true` se a etapa seguinte, já no effort novo, leu do cache (a perda é só da troca); `false` se o effort novo segue sem cache; `null` sem número. */
  effortSteadyKeptCache: boolean | null;
}

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Sonda
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Roda as quatro medições contra `provider` e devolve o relatório; `emit` recebe uma linha por chamada (`call`), uma por medição (`measurement`) e o `result` final. A
 * conversa é uma só (a sessão do provedor é o id dela, como no executor):
 *   rodada 1 (execução 1): etapa 1 e etapa 2, com a ferramenta de eco chamada pela sonda entre elas;
 *   rodada 2 (execução 2, uma hora depois): etapa 1 mede `next_round`; a etapa 2 vem depois do eco e de uma nova posse (a hora lida na posse é ignorada, o bloco gravado
 *     vale) e mede `resume`;
 *   rodada 3 (execução 3, com `EFFORT_PROBED`): etapa 1 mede `effort_change`; a etapa 2, depois do eco, mede `effort_steady` (se o provedor recusou o nível, não há etapa 2).
 * No modelo do protocolo messages (`claude-haiku-5-5`) a sonda para depois da etapa 1 da rodada 2, com 3 chamadas: `same_round` (etapa 2 contra a 1) e `next_round` (rodada 2 contra a etapa 2) são
 * só reportadas, e `cacheControlForwarded` diz se o gateway repassou o `cache_control` (C3).
 * ponytail: uma amostra por caso, e o cache do provedor é de melhor esforço e em blocos de 64 tokens; se uma medição exigida ficar perto de 90%, repetir a sonda antes de
 * concluir que a regra do bloco quebrou o cache.
 */
export async function runCacheProbe({ provider, apiKey, emit, model = DEFAULT_MODEL }: { provider: ProviderClient; apiKey: string; emit: (line: Record<string, unknown>) => void; model?: ProbeModel }): Promise<CacheReport> {
  const { protocol, maxCalls, memoryNotes } = PROBE_MODELS[model];
  /** Cache explícito (messages): a sonda mede só o repasse do `cache_control` e para antes das etapas de retomada e de effort. */
  const explicit = protocol === 'messages';
  const memory = syntheticMemory(memoryNotes);
  /** O uso de cada chamada, na ordem: dele sai `cacheControlForwarded`. */
  const observed: ChatUsage[] = [];
  // Uma conversa estável: o executor usa o id da conversa como sessão do provedor em todas as execuções dela.
  const conversationId = randomUUID();
  const start = Date.now();
  /** Hora de cada leitura do relógio: a sonda anda uma hora por rodada para que o bloco de cada execução seja diferente do da anterior, como numa conversa real. */
  const clock = (hours: number): Date => new Date(start + hours * 3_600_000);
  /** Espelha `runs.request_data`: o bloco `# Dados` de cada execução, gravado uma única vez. */
  const requestData = new Map<string, string>();
  let providerCalls = 0;

  /** Turno de sistema do bot da sonda, remontado a cada preparação como o executor o remonta a cada posse: o texto é o mesmo enquanto memória e Configurações não mudam. */
  const systemTurn = (): ChatTurn => ({
    role: 'system',
    text: buildSystemText({ botName: 'Validação de cache', botInstructions: 'Responda em uma palavra.', botMemory: memory, globalMemory: '', ...SETTINGS }),
  });

  /**
   * Uma etapa: prepara o pedido como `RunExecutor` (`ensureRequestData` e `loadRequestData`) e chama o provedor. A primeira preparação da execução grava o bloco com a hora
   * `at`; qualquer outra, de outra posse ou não, relê o texto gravado e ignora `at`. Devolve o texto e o uso; imprime só números e identificadores.
   */
  async function step(execution: number, index: number, rows: readonly ContextRow[], at: Date, effort?: string): Promise<{ text: string; usage: ChatUsage }> {
    if (providerCalls >= maxCalls) throw new Error('Limite de chamadas ao provedor da sonda excedido.');
    providerCalls += 1;
    const runId = String(execution);
    if (!requestData.has(runId)) requestData.set(runId, currentDataBlock({ model, now: at, ...SETTINGS }));
    const loaded = rows.map((row) => (row.opens_round ? { ...row, request_data: requestData.get(row.run_id!) ?? null } : row));
    const request: ChatRequest = { model, sessionId: conversationId, turns: [systemTurn(), ...buildTurns(loaded)], tools: [TEST_TOOL], maxTokens: MAX_OUTPUT_TOKENS, ...(effort ? { effort } : {}) };
    let usage: ChatUsage = {};
    let text = '';
    for await (const event of provider.streamChat(apiKey, protocol, request)) {
      if (event.type === 'usage') usage = event.usage;
      else if (event.type === 'text') text += event.text;
    }
    observed.push(usage);
    // `...usage` leva entrada, leitura, gravação (só no messages) e saída: todos números.
    emit({ event: 'call', conversationId, execution, step: index, model, protocol, effort: effort ?? 'default', ...usage, ...(usage.inputTokens && usage.cachedTokens !== undefined ? { cachedFraction: usage.cachedTokens / usage.inputTokens } : {}) });
    return { text, usage };
  }

  /** Compara o cache da etapa com o `inputTokens` do pedido anterior e imprime a medição. Sem uso informado, ou com o provedor tendo recusado o pedido, não há número e a medição não passa. */
  const measure = (name: CacheMeasurement['name'], required: boolean, execution: number, index: number, effort: string, previous: ChatUsage, usage: ChatUsage | null, status: number | null = null): CacheMeasurement => {
    const previousInputTokens = previous.inputTokens ?? null;
    const inputTokens = usage?.inputTokens ?? null;
    const cachedTokens = usage?.cachedTokens ?? null;
    const cacheWriteTokens = usage?.cacheWriteTokens ?? null;
    const cachedOfPrevious = previousInputTokens && cachedTokens !== null ? cachedTokens / previousInputTokens : null;
    const measurement: CacheMeasurement = { name, required, execution, step: index, effort, measured: cachedOfPrevious !== null, status, previousInputTokens, inputTokens, cachedTokens, cacheWriteTokens, cachedOfPrevious, passed: cachedOfPrevious !== null && cachedOfPrevious >= MIN_CACHED_FRACTION };
    emit({ event: 'measurement', ...measurement });
    return measurement;
  };

  const opening = (execution: number, content: string): ContextRow => ({ id: String(execution), run_id: String(execution), role: 'user', kind: 'text', status: 'done', opens_round: true, step: null, content, data: {} });
  /** A chamada da ferramenta de eco que a sonda faz no lugar do modelo, já concluída: o que o executor grava depois de executar uma etapa com ferramenta. */
  const echo = (execution: number, index: number): ContextRow => ({ run_id: String(execution), role: 'assistant', kind: 'activity', status: 'completed', opens_round: false, step: index, content: 'ok', data: { callId: `call_probe_${execution}`, tool: TEST_TOOL.name, label: TEST_TOOL.name, arguments: JSON.stringify({ text: 'ok' }), detail: null } });
  const answer = (execution: number, index: number, text: string): ContextRow => ({ run_id: String(execution), role: 'assistant', kind: 'text', status: 'done', opens_round: false, step: index, content: text.trim() || 'ok', data: {} });

  // Rodada 1: abre a conversa e grava o bloco da execução 1. O que o modelo responde na etapa 1 é descartado (o eco é da sonda).
  const rows: ContextRow[] = [opening(1, 'Sonda de cache, rodada 1: responda apenas ok.')];
  const first = await step(1, 1, rows, clock(0));
  rows.push(echo(1, 1));
  const closing = await step(1, 2, rows, clock(0));
  rows.push(answer(1, 2, closing.text));
  const measurements: CacheMeasurement[] = [];
  // Messages: a etapa 2 deveria ler o que a etapa 1 gravou (prefixo marcado por `cache_control` no fim da última mensagem).
  if (explicit) measurements.push(measure('same_round', false, 1, 2, 'default', first.usage, closing.usage));

  // Rodada 2: nova execução, bloco novo. A rodada 1 continua com o bloco dela, byte a byte, e é isso que mantém o prefixo.
  rows.push(opening(2, 'Sonda de cache, rodada 2: responda apenas ok.'));
  const nextRound = await step(2, 1, rows, clock(1));
  measurements.push(measure('next_round', !explicit, 2, 1, 'default', closing.usage, nextRound.usage));

  if (!explicit) {
    // Retomada: mesma execução, outra posse (aprovação decidida ou reinício). O sistema é remontado e a hora lida agora (`clock(2)`) não reescreve o bloco da execução 2.
    rows.push(echo(2, 1));
    const resumed = await step(2, 2, rows, clock(2));
    measurements.push(measure('resume', true, 2, 2, 'default', nextRound.usage, resumed.usage));
    rows.push(answer(2, 2, resumed.text));

    // Rodada 3: effort diferente do da rodada anterior (Padrão). Um nível que o provedor recusa não reprova a sonda: é o resultado de C4 (não medido) e o status fica no relatório.
    rows.push(opening(3, 'Sonda de cache, rodada 3: responda apenas ok.'));
    let changed: ChatUsage | null = null;
    try {
      changed = (await step(3, 1, rows, clock(3), EFFORT_PROBED)).usage;
      measurements.push(measure('effort_change', false, 3, 1, EFFORT_PROBED, resumed.usage, changed));
    } catch (error) {
      if (!(error instanceof ChatRejected)) throw error;
      measurements.push(measure('effort_change', false, 3, 1, EFFORT_PROBED, resumed.usage, null, error.status));
    }
    // Controle de C4: se a troca zerou o cache, a etapa seguinte (mesmo effort, mesma execução) diz se ele é só frio no effort novo ou se o effort impede o cache.
    if (changed) {
      rows.push(echo(3, 1));
      measurements.push(measure('effort_steady', false, 3, 2, EFFORT_PROBED, changed, (await step(3, 2, rows, clock(3), EFFORT_PROBED)).usage));
    }
  }

  const kept = (name: CacheMeasurement['name']): boolean | null => { const entry = measurements.find((candidate) => candidate.name === name); return entry?.measured ? entry.passed : null; };
  const report: CacheReport = {
    conversationId,
    model,
    providerCalls,
    measurements,
    passed: measurements.filter((entry) => entry.required).every((entry) => entry.passed),
    cacheControlForwarded: explicit ? observed.some((usage) => (usage.cachedTokens ?? 0) > 0 || (usage.cacheWriteTokens ?? 0) > 0) : null,
    effortKeptCache: kept('effort_change'),
    effortSteadyKeptCache: kept('effort_steady'),
  };
  emit({
    event: 'result', conversationId, model, minCachedFraction: MIN_CACHED_FRACTION, providerCalls, passed: report.passed,
    ...(explicit ? { cacheControlForwarded: report.cacheControlForwarded } : { effortKeptCache: report.effortKeptCache, effortSteadyKeptCache: report.effortSteadyKeptCache }),
  });
  return report;
}

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Provedor roteirizado (offline)
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Razão tokens por byte do corpo e piso e bloco de prefixo do cache do provedor roteirizado, no modelo do provedor real (medido: 1.024 tokens de piso, blocos de 64). */
const FAKE_TOKENS_PER_BYTE = 0.3;
const FAKE_MIN_CACHED_PREFIX = 1_024;
const FAKE_CACHE_BLOCK = 64;
/** Piso do cache explícito do messages no roteirizado: o da família Haiku 4.5 (4.096 tokens), abaixo dele a Anthropic nem grava. */
const FAKE_MIN_EXPLICIT_PREFIX = 4_096;

/**
 * Provedor roteirizado que o teste offline injeta no lugar do OpenCode Go: responde `ok` e informa o uso no modelo do provedor real, com entrada proporcional ao corpo e o
 * cache sendo o prefixo comum (ferramentas e turnos, segmento a segmento) com o pedido ANTERIOR, em blocos de 64 tokens e a partir de 1.024. O nível de effort não entra
 * no prefixo: é a hipótese que só a medição real de C4 confirma. Existe porque o falso compartilhado (`@aion/core/testing`) devolve 80% fixo e nunca passaria o gate de 90%.
 * No protocolo messages simula o cache EXPLÍCITO da Anthropic: lê o prefixo anterior inteiro (sem blocos de 64, a leitura vai até a marca do pedido anterior), grava o que é novo
 * e só faz as duas coisas a partir de 4.096 tokens, informando `cacheWriteTokens` à parte; a entrada segue o total.
 */
export function createPrefixCacheProvider(): ProviderClient {
  let previous: string[] = [];
  return {
    listModels: () => Promise.resolve([{ id: DEFAULT_MODEL }]),
    async *streamChat(_apiKey, protocol, request): AsyncGenerator<ChatEvent> {
      const segments = [JSON.stringify(request.tools ?? []), ...request.turns.map((turn) => JSON.stringify(turn))];
      let commonBytes = 0;
      for (let index = 0; index < Math.min(previous.length, segments.length) && previous[index] === segments[index]; index += 1) commonBytes += Buffer.byteLength(segments[index]!, 'utf8');
      previous = segments;
      const inputTokens = Math.ceil(segments.reduce((sum, segment) => sum + Buffer.byteLength(segment, 'utf8'), 0) * FAKE_TOKENS_PER_BYTE);
      const prefixTokens = Math.floor(commonBytes * FAKE_TOKENS_PER_BYTE);
      yield { type: 'text', text: 'ok' };
      if (protocol === 'messages') {
        const cachedTokens = prefixTokens >= FAKE_MIN_EXPLICIT_PREFIX ? Math.min(prefixTokens, inputTokens) : 0;
        const cacheWriteTokens = inputTokens >= FAKE_MIN_EXPLICIT_PREFIX ? inputTokens - cachedTokens : 0;
        yield { type: 'usage', usage: { inputTokens, cachedTokens, cacheWriteTokens, outputTokens: 2 } };
      } else {
        const cachedTokens = prefixTokens >= FAKE_MIN_CACHED_PREFIX ? Math.min(Math.floor(prefixTokens / FAKE_CACHE_BLOCK) * FAKE_CACHE_BLOCK, inputTokens) : 0;
        yield { type: 'usage', usage: { inputTokens, cachedTokens, outputTokens: 2 } };
      }
      yield { type: 'done', reason: 'stop' };
    },
  };
}

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Borda da CLI
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Mensagens seguras por código estável: a causa externa (provedor, rede) nunca atravessa esta borda. */
const MESSAGES = {
  PROVIDER_CACHE_INVALID_ARGUMENT: 'Argumento inválido. Use --model deepseek-v4.1-flash (padrão) ou --model claude-haiku-5-5; nenhum outro modelo é aceito.',
  PROVIDER_CACHE_VALIDATION_FAILED: 'Não foi possível confirmar o cache do provedor. Confira a chave no ambiente e a disponibilidade do serviço.',
  PROVIDER_CACHE_BELOW_THRESHOLD: 'O cache ficou abaixo de 90% do pedido anterior em uma medição exigida (C1). Veja a linha result e as linhas measurement.',
} as const;

class ProbeError extends Error {
  constructor(readonly code: keyof typeof MESSAGES) { super(code); }
}

/** Imprime uma linha JSON no stdout: o único canal de saída dos dados da sonda (só identificadores e números). */
const write = (line: Record<string, unknown>): void => { process.stdout.write(`${JSON.stringify(line)}\n`); };

/**
 * Lê `--model` na borda: só os modelos de `PROBE_MODELS` passam (allowlist; opção desconhecida e valor fora da lista são recusados antes de qualquer chamada ao provedor), e sem a
 * opção vale o deepseek de sempre.
 */
export function parseProbeModel(argv: readonly string[]): ProbeModel {
  let model: string | undefined;
  try { model = parseArgs({ args: [...argv], strict: true, options: { model: { type: 'string' } } }).values.model; } catch { throw new ProbeError('PROVIDER_CACHE_INVALID_ARGUMENT'); }
  if (model === undefined) return DEFAULT_MODEL;
  if (!Object.hasOwn(PROBE_MODELS, model)) throw new ProbeError('PROVIDER_CACHE_INVALID_ARGUMENT');
  return model as ProbeModel;
}

/**
 * Ponto de entrada da CLI: valida o modelo e exige a chave no ambiente antes de qualquer chamada, roda a sonda e fixa o código de saída (1 quando uma medição exigida não passa ou quando algo
 * falha). Uma recusa do provedor (`ChatRejected`) ou um stream fora do formato acrescenta ao envelope só o status HTTP ou o nome da classe do erro, que são número e identificador: permite
 * entender a falha de uma chamada real única sem repeti-la e sem vazar corpo, chave nem conversa.
 */
async function main(): Promise<void> {
  try {
    const model = parseProbeModel(process.argv.slice(2));
    const apiKey = process.env.AION_VALIDATE_PROVIDER_KEY?.trim();
    if (!apiKey) throw new ProbeError('PROVIDER_CACHE_VALIDATION_FAILED');
    const provider = createOpenCodeGoClient({ baseUrl: process.env.AION_OPENCODE_GO_BASE_URL ?? DEFAULT_BASE_URL, chatTimeoutMs: 60_000 });
    const report = await runCacheProbe({ provider, apiKey, emit: write, model });
    if (!report.passed) throw new ProbeError('PROVIDER_CACHE_BELOW_THRESHOLD');
  } catch (error) {
    const code = error instanceof ProbeError ? error.code : 'PROVIDER_CACHE_VALIDATION_FAILED';
    const detail = error instanceof ChatRejected ? { status: error.status } : error instanceof ChatStreamError ? { errorName: error.name } : {};
    process.stderr.write(`${JSON.stringify({ code, message: MESSAGES[code], exitCode: 1, ...detail })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();

// Sonda de compactação de contexto (phase 9, T8: critérios C1 e C4 da spec; phase 11, T6: critério C8, checkpoint menor). Roda UMA rodada longa de um bot com o motor
// de execução REAL (`RunEngine`, PostgreSQL embarcado e migrations como nos testes do core), em janela de 64k e com o `deepseek-v4.1-flash` (nunca o `mimo-v2.6-pro`, que
// é caro): o bot chama 40 vezes uma ferramenta sintética de eco, cujo resultado é um bloco de enchimento (sem dado real) grande o bastante para cruzar o limiar de
// compactação DENTRO da rodada. A saída conta o que o provedor informou, lido do ledger `model_call_usage` do próprio motor: por chamada, entrada, cache e saída; e, no
// fim, as chamadas de resumo, os totais (resumos incluídos), o tamanho em caracteres de cada revisão do checkpoint (só números) e os critérios.
//
// Dois modos, mesma montagem de motor e mesma contabilidade:
//   real           provedor OpenCode Go de verdade; a chave vem SÓ do ambiente (`AION_VALIDATE_PROVIDER_KEY`, que o script do package.json carrega de `.env.validate.local`
//                  quando o arquivo existe) e nunca é impressa nem gravada fora do banco efêmero (cifrada, com chave mestra aleatória que morre com o processo).
//   deterministic  offline: o `deepseek-v4.1-flash` é o falso de `@aion/core/testing` (listagem e teste de modelo) e a conversa é de um provedor roteirizado que informa
//                  usage e cache coerentes com o prefixo dos pedidos. É o que `tests/validate-compaction.test.ts` prova; nenhuma chamada sai da máquina.
//
// Uso (a partir da raiz):
//   corepack pnpm validate:compaction                                       # real; erro claro e saída não-zero sem chave
//   corepack pnpm validate:compaction --mode deterministic                  # offline
//   ... --baseline-uncached <n>   confere C4: entrada não lida do cache + saída (resumos incluídos) menor ou igual à da referência `790481c`
//   ... --calls <n> --result-chars <n>                                       # volume da sonda (padrão 40 chamadas; ver RESULT_CHARS_DEFAULT)
// Comparação C4: a MESMA sonda roda numa worktree de `790481c` (a API do motor usada aqui existe nos dois estados), e o `uncachedTokens` dela vira `--baseline-uncached`. O total bruto (`tokens`, cache incluído) continua na saída só como informação.
//
// Privacidade (Never da spec): a saída só tem identificadores gerados e números. Texto da conversa, do resumo e dos resultados nunca é lido para impressão, e o logger do
// motor fica silencioso. Falha vira o envelope `{ code, message, exitCode }` com código estável, sem causa externa.
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ConversationService, BotService, CredentialService, ModelService, RunEngine, ToolFailure,
  createComposioClient, createLogger, createOpenCodeGoClient, createParallelClient, createPool,
  type ChatEvent, type ChatRequest, type ProviderClient, type ToolHandler,
} from '@aion/core';
import { qualifyModelId } from '@aion/shared';
import { createTestDatabase, migrateTestDatabase, startFakeUpstreams, startTestPostgres } from '@aion/core/testing';

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Parâmetros da sonda
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Modelo e janela fixos da reprodução (C1): trocar um dos dois muda o que a sonda prova e exige novo pedido ao dono. */
const MODEL = 'deepseek-v4.1-flash';
/** O id do modelo para o motor (bots, teste de modelo): `provedor/modelo`. A saída da sonda e o provedor seguem com o id local (`MODEL`). */
const ENGINE_MODEL = qualifyModelId('opencode', MODEL);
/** Janela de contexto do bot da sonda, em tokens (64k, a menor opção do produto; o padrão do produto é 256k desde a phase 11, e a sonda fixa 64k para as 40 chamadas cruzarem o limiar de compactação, ver `RESULT_CHARS_DEFAULT`). */
const WINDOW_TOKENS = 65_536;
/** Endereço do OpenCode Go no modo real; `AION_OPENCODE_GO_BASE_URL` (só do ambiente do operador) o substitui, como nos outros scripts de validação. */
const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1';
/** Nome da ferramenta sintética de eco que o bot da sonda chama. */
const ECHO_TOOL = 'probe_echo';
/** Chamadas de ferramenta da rodada (C1 pede 40) e o teto aceito em `--calls`. */
const DEFAULT_CALLS = 40;
const MAX_CALLS = 50;
/**
 * Tamanho do bloco de enchimento de cada resultado, em caracteres. Fica abaixo de 8.000, que era o corte que o modelo via em `790481c` (a referência de C4): assim o volume
 * por etapa é o mesmo nas medições dos dois estados, sem marcador de corte de um lado e do outro. No motor atual o corte do pedido é de 12.000 (phase 11, T5), então 7.100
 * entra inteiro nos dois. Calibração com o provedor real (3 etapas medidas em 15/10/2026): 5.500 caracteres somaram ~1.700 tokens por etapa, ~0,31 token por caractere. Com 7.100
 * (~2.200 tokens por etapa, orçamento de entrada de ~55 mil tokens e limiar de 90%) as 40 chamadas cruzam o limiar duas vezes (perto da etapa 22 e da 35); a sonda é inválida
 * sem compactação e três resumos já reprovam C1.
 */
const RESULT_CHARS_DEFAULT = 7_100;
/**
 * Limites aceitos em `--result-chars`. O máximo segue em 8.000 de propósito, e não no teto de 12.000 do pedido do motor atual: acima de 8.000 o resultado seria cortado em
 * `790481c` e a comparação de C4 deixaria de medir o mesmo volume. ponytail: subir o máximo para o teto do pedido (12.000) quando a referência `790481c` deixar de ser comparada.
 */
const RESULT_CHARS_MIN = 200;
const RESULT_CHARS_MAX = 8_000;
/**
 * Alvo máximo do checkpoint em caracteres (phase 11, C8): o `SUMMARY_TARGET_MAX_CHARS` de `packages/core/src/runs/compaction.ts`. É repetido aqui porque o core só publica
 * `SUMMARY_MAX_CALLS` desse módulo (o resto é interno ao motor), e a sonda usa só a API pública que também existe em `790481c`; mudar o alvo no motor exige mudar este número.
 */
const CHECKPOINT_TARGET_MAX_CHARS = 6_000;
/** Teto de chamadas de ferramenta do bot da sonda: folga sobre o pedido, para um modelo que se perca não gastar sem limite. */
const BOT_STEP_LIMIT = 60;
/** Prazo total da rodada, acima do tempo ativo máximo do motor (que é elevado abaixo): a sonda não fica pendurada se a execução travar. */
const RUN_DEADLINE_MS = 40 * 60_000;
/** O produto limita a execução a 15 minutos ativos; a medição não pode morrer por relógio, então a sonda dobra esse teto (vale para as duas versões comparadas). */
const ENGINE_MAX_ACTIVE_MS = 30 * 60_000;
/** Intervalo com que a sonda lê o ledger e o estado da execução enquanto espera o fim da rodada. */
const POLL_MS = 1_000;

/** Enunciado da rodada. Vai como mensagem do dono: é o pedido que precisa sobreviver, íntegro, a toda compactação da rodada (C2). Sem dado real. */
const PROBE_PROMPT = `Esta é uma sonda técnica de contexto, sem dados reais. Chame a ferramenta ${ECHO_TOOL} em sequência, uma única chamada por vez e sem chamadas em paralelo, com n = 1, depois n = 2, e assim por diante até n = CALLS. Cada resultado traz um bloco de texto de enchimento sem significado: ignore o bloco e use só o n eco. Depois da chamada com n = CALLS, responda apenas a palavra: concluído.`;

/**
 * Falha esperada da sonda (argumento inválido, chave ausente, modelo indisponível, prazo): carrega só o código estável, que a borda da CLI converte no envelope
 * `{ code, message, exitCode }`. A mensagem é o próprio código, para nenhuma causa externa (argumento recebido, chave) viajar numa exceção.
 */
export class ProbeError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ProbeError'; }
}

/** Parâmetros validados de uma rodada da sonda (saída de `parseOptions`); `runProbe` e `buildReport` só leem daqui. */
export interface ProbeOptions {
  /** `real` fala com o provedor de verdade; `deterministic` roda offline com o provedor roteirizado. */
  mode: 'real' | 'deterministic';
  /** Chamadas de ferramenta pedidas ao bot (o critério `callsDone` exige ao menos isso). */
  calls: number;
  /** Tamanho do bloco de enchimento de cada resultado do eco, em caracteres. */
  resultChars: number;
  /** Entrada não cacheada + saída da referência `790481c`, quando já medida: ativa a conferência de C4 (decisão do dono em 15/10/2026). */
  baselineUncached: number | null;
}

/** Allowlist dos argumentos da CLI (valores validados; o erro nunca ecoa o argumento recebido). */
export function parseOptions(args: string[]): ProbeOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!key || !['--mode', '--calls', '--result-chars', '--baseline-uncached'].includes(key) || value === undefined || values.has(key)) throw new ProbeError('COMPACTION_ARGUMENT_INVALID');
    values.set(key, value);
  }
  /** Lê uma opção inteira (só dígitos, sem sinal nem decimal) dentro de [min, max]; ausente devolve `fallback`; fora do formato ou do intervalo é argumento inválido. */
  const integer = (key: string, fallback: number | null, min: number, max: number): number | null => {
    const raw = values.get(key);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!/^\d{1,9}$/.test(raw) || value < min || value > max) throw new ProbeError('COMPACTION_ARGUMENT_INVALID');
    return value;
  };
  const mode = values.get('--mode') ?? 'real';
  if (mode !== 'real' && mode !== 'deterministic') throw new ProbeError('COMPACTION_ARGUMENT_INVALID');
  return {
    mode,
    calls: integer('--calls', DEFAULT_CALLS, 1, MAX_CALLS)!,
    resultChars: integer('--result-chars', RESULT_CHARS_DEFAULT, RESULT_CHARS_MIN, RESULT_CHARS_MAX)!,
    baselineUncached: integer('--baseline-uncached', null, 1, 999_999_999),
  };
}

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Ferramenta sintética de eco
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Palavras neutras do enchimento: texto corrido de aparência natural, para a contagem de tokens do provedor ser a de um resultado verdadeiro. */
const WORDS = ['mesa', 'rio', 'livro', 'porta', 'janela', 'campo', 'pedra', 'vento', 'lago', 'folha', 'ponte', 'nuvem', 'casa', 'estrada', 'monte', 'barco', 'relógio', 'chave',
  'jardim', 'parede', 'cadeira', 'quadro', 'tinta', 'papel', 'corda', 'vidro', 'fogo', 'areia', 'sombra', 'torre', 'caminho', 'cesta', 'lâmpada', 'floresta', 'degrau', 'tapete'];

/** PRNG determinístico (mulberry32): o mesmo `n` gera o mesmo enchimento em qualquer execução e em qualquer versão do motor. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Resultado da chamada `n`: o eco do número e um bloco de enchimento sem significado, com exatamente `chars` caracteres. Sem dado real nem instrução. */
export function echoResult(n: number, chars: number): string {
  const next = prng(n * 7919 + 13);
  const words: string[] = [];
  let length = 0;
  const header = `eco n=${n}\n`;
  while (length < chars - header.length) {
    const word = WORDS[Math.floor(next() * WORDS.length)]!;
    words.push(word);
    length += word.length + 1;
  }
  return (header + words.join(' ')).slice(0, chars);
}

/**
 * A ferramenta que o bot da sonda chama. Interna, sem efeito externo e sem aprovação (como as ferramentas internas do produto); `core: true` a publica no catálogo
 * do modelo sem `discover_tools`. Validação manual dos argumentos (o pacote `tests` não depende de zod): o modelo manda o `n` como número ou texto de dígitos.
 */
function echoTool(resultChars: number): ToolHandler {
  return {
    definition: {
      name: ECHO_TOOL,
      description: 'Eco sintético da sonda de contexto: devolve o número da chamada e um bloco de texto de enchimento sem significado. Não tem efeito algum.',
      parameters: { type: 'object', properties: { n: { type: 'integer', minimum: 1, description: 'Número desta chamada, a partir de 1.' } }, required: ['n'], additionalProperties: false },
    },
    external: false,
    core: true,
    prepare(rawArguments) {
      let parsed: unknown;
      try { parsed = JSON.parse(rawArguments); } catch { throw new ToolFailure('Os argumentos não são um JSON válido.'); }
      const raw = (parsed as { n?: unknown } | null)?.n;
      const n = typeof raw === 'string' && /^\d{1,6}$/.test(raw) ? Number(raw) : raw;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw new ToolFailure('Informe n como um inteiro a partir de 1.');
      return { label: `Eco ${n}`, execute: async () => ({ result: echoResult(n, resultChars) }) };
    },
  };
}

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Provedor roteirizado (modo deterministic)
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/** O que o provedor roteirizado informou em cada chamada de conversa (principal ou resumo): a verdade contra a qual o teste confere a contabilidade da sonda. */
export interface ObservedCall { purpose: 'main' | 'summary'; inputTokens: number; cachedTokens: number; outputTokens: number }

/** Razão tokens por byte do corpo e piso de prefixo do cache, como no provedor real (que só guarda prefixos a partir de 1.024 tokens; ver `validate-prompt-cache.ts`). */
const FAKE_TOKENS_PER_BYTE = 0.3;
/** Piso de prefixo do cache do provedor roteirizado, em tokens (o do provedor real). */
const FAKE_MIN_CACHED_PREFIX = 1_024;

/**
 * Provedor roteirizado: a listagem e o teste de modelo passam ao `real` (o OpenCode Go falso do `@aion/core/testing`); as conversas do motor (a primeira linha é o turno
 * de sistema) são atendidas aqui. A principal chama o eco até completar `calls` chamadas e então responde texto; a de resumo (sem ferramentas) devolve um checkpoint
 * válido, com as seções que o próprio prompt lista. O usage é proporcional ao corpo e o cache é o prefixo comum com o pedido anterior do mesmo tipo, então a sonda
 * offline enxerga o mesmo comportamento de cache que o real: constante dentro de um intervalo e quebrado pela compactação.
 */
export function createScriptedProvider(real: ProviderClient, calls: number): { provider: ProviderClient; observed: ObservedCall[] } {
  const observed: ObservedCall[] = [];
  const previous = new Map<'main' | 'summary', string[]>();
  let done = 0;

  /** Usage do pedido: entrada ∝ bytes, cache = prefixo comum (segmento a segmento) com o pedido anterior do mesmo tipo, a partir do piso do provedor. */
  const usageOf = (purpose: 'main' | 'summary', request: ChatRequest, outputChars: number): ObservedCall => {
    const segments = [JSON.stringify(request.tools ?? []), ...request.turns.map((turn) => JSON.stringify(turn))];
    const before = previous.get(purpose) ?? [];
    let common = 0;
    for (let index = 0; index < Math.min(before.length, segments.length) && before[index] === segments[index]; index += 1) common += Buffer.byteLength(segments[index]!, 'utf8');
    previous.set(purpose, segments);
    const inputTokens = Math.ceil(segments.reduce((sum, segment) => sum + Buffer.byteLength(segment, 'utf8'), 0) * FAKE_TOKENS_PER_BYTE);
    const prefixTokens = Math.floor(common * FAKE_TOKENS_PER_BYTE);
    return { purpose, inputTokens, cachedTokens: prefixTokens >= FAKE_MIN_CACHED_PREFIX ? Math.min(prefixTokens, inputTokens) : 0, outputTokens: Math.max(1, Math.ceil(outputChars / 3.5)) };
  };

  const provider: ProviderClient = {
    listModels: (apiKey) => real.listModels(apiKey),
    async *streamChat(apiKey, protocol, request, signal): AsyncGenerator<ChatEvent> {
      if (request.turns[0]?.role !== 'system') { yield* real.streamChat(apiKey, protocol, request, signal); return; }
      if (!request.tools?.length) {
        const system = request.turns[0].text;
        const headings = [...system.matchAll(/^## .+$/gm)].map((match) => match[0]);
        const text = (headings.length ? headings : ['## Estado']).map((heading, index) => `${heading}\n${index === 0 ? 'Checkpoint sintético do histórico antigo.' : 'Nada.'}`).join('\n\n');
        const usage = usageOf('summary', request, text.length);
        observed.push(usage);
        yield { type: 'text', text };
        yield { type: 'usage', usage: { inputTokens: usage.inputTokens, cachedTokens: usage.cachedTokens, outputTokens: usage.outputTokens } };
        yield { type: 'done', reason: 'stop' };
        return;
      }
      const calling = done < calls;
      const usage = usageOf('main', request, calling ? 40 : 10);
      observed.push(usage);
      if (calling) { done += 1; yield { type: 'tool_call', id: `call_probe_${done}`, name: ECHO_TOOL, arguments: JSON.stringify({ n: done }) }; }
      else yield { type: 'text', text: 'concluído' };
      yield { type: 'usage', usage: { inputTokens: usage.inputTokens, cachedTokens: usage.cachedTokens, outputTokens: usage.outputTokens } };
      yield { type: 'done', reason: 'stop' };
    },
  };
  return { provider, observed };
}

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Contabilidade (pura: só números e identificadores)
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Linha do ledger `model_call_usage` reduzida ao que a sonda conta. Existe em `790481c` com estas colunas. */
export interface UsageRow {
  purpose: 'main' | 'summary';
  state: string;
  outcome: string | null;
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
}

/**
 * Uma chamada ao modelo na ordem do ledger. `compactedBefore` (só nas principais): um resumo foi APLICADO desde a principal anterior, ou seja, o prefixo do pedido
 * mudou de forma e o cache da etapa pode recomeçar do prefixo de sistema.
 */
export interface CallRecord extends UsageRow { seq: number; step: number | null; summaryIndex: number | null; compactedBefore: boolean }

/**
 * Numera as chamadas e marca, em cada etapa principal, se uma compactação foi aplicada logo antes dela. Só o resumo `applied` troca o histórico por um checkpoint e
 * quebra o prefixo; um resumo recusado (vazio, limite de saída, formato) ou incerto deixa o pedido como estava, então a etapa seguinte continua sujeita à regra de cache.
 * A marca de uma linha só depende das linhas anteriores.
 */
export function annotateCalls(rows: readonly UsageRow[]): CallRecord[] {
  let step = 0, summaries = 0, pending = false;
  return rows.map((row, index) => {
    if (row.purpose === 'summary') { summaries += 1; pending ||= row.outcome === 'applied'; return { ...row, seq: index + 1, step: null, summaryIndex: summaries, compactedBefore: false }; }
    step += 1;
    const record = { ...row, seq: index + 1, step, summaryIndex: null, compactedBefore: pending };
    pending = false;
    return record;
  });
}

/** O que a sonda lê da execução no fim da rodada (tabela `runs`): estado final, código de falha estável (nulo no sucesso) e chamadas de ferramenta feitas. */
export interface RunFacts { id: string; status: string; failureCode: string | null; toolCalls: number }

/** Soma de tokens de um conjunto de chamadas; a entrada já inclui os lidos do cache, como o provedor informa. */
interface Totals { inputTokens: number; cachedTokens: number; outputTokens: number }

/** Totaliza entrada, cache e saída das chamadas; valor que o provedor não informou (nulo) conta como zero. */
const sum = (calls: readonly CallRecord[]): Totals => ({
  inputTokens: calls.reduce((total, call) => total + (call.inputTokens ?? 0), 0),
  cachedTokens: calls.reduce((total, call) => total + (call.cachedTokens ?? 0), 0),
  outputTokens: calls.reduce((total, call) => total + (call.outputTokens ?? 0), 0),
});

/**
 * Contabilidade fechada de uma rodada: as chamadas na ordem do ledger, as contagens (`summaryCalls` conta toda tentativa de resumo; `summaryApplied`, só as que
 * trocaram o histórico por um checkpoint), os totais das principais, dos resumos e do conjunto, e os critérios C1 e C4. Só identificadores e números.
 */
export interface ProbeReport {
  mode: ProbeOptions['mode'];
  model: string;
  window: number;
  run: RunFacts;
  calls: CallRecord[];
  mainCalls: number;
  summaryCalls: number;
  summaryApplied: number;
  /** Tamanho em caracteres de cada revisão do checkpoint lida durante a rodada, da mais antiga para a mais nova (só números; vazio quando a leitura não foi feita). */
  checkpointChars: number[];
  main: Totals;
  summary: Totals;
  /** `uncachedTokens` = entrada não lida do cache + saída, a métrica de C4; `tokens` é o total bruto (cache incluído), só informativo. */
  total: Totals & { uncachedInputTokens: number; uncachedTokens: number; tokens: number };
  criteria: {
    /** C1: a execução terminou com sucesso. */
    runCompleted: boolean;
    /** A rodada fez as chamadas de ferramenta pedidas. */
    callsDone: boolean;
    /** A sonda forçou ao menos uma compactação APLICADA dentro da rodada (resumo recusado não conta; sem compactação ela não prova C1). */
    compacted: boolean;
    /** C1: no máximo duas chamadas de resumo (cada tentativa conta, aplicada ou não). */
    summaryCallsAtMost2: boolean;
    /** C1: toda etapa principal sem compactação aplicada logo antes (e depois da primeira) informou cached_tokens maior que zero. */
    cachedBetweenCompactions: boolean;
    /** Etapas conferidas por `cachedBetweenCompactions` e quantas falharam. */
    cachedChecked: number;
    cachedMissing: number;
    /** C4: entrada não cacheada + saída (resumos incluídos) menor ou igual à da referência; nulo sem `--baseline-uncached`. */
    uncachedAtMostBaseline: boolean | null;
    baselineUncached: number | null;
    /** C8 (phase 11): toda revisão do checkpoint lida tem no máximo `CHECKPOINT_TARGET_MAX_CHARS` caracteres; nulo quando a rodada não leu os checkpoints. */
    checkpointAtMostTarget: boolean | null;
    /** C8 (phase 11): nenhuma segunda tentativa nem escada, ou seja, toda chamada de resumo foi aplicada de primeira; nulo quando a rodada não leu os checkpoints. */
    noSecondAttempt: boolean | null;
    passed: boolean;
  };
}

/**
 * Fecha a contabilidade da rodada e avalia C1 (e C4, quando há referência; e C8, quando há leitura dos checkpoints em `checkpointChars`). Pura: testada com linhas de
 * ledger sintéticas e com a rodada offline. `checkpointChars` ausente deixa os critérios de C8 nulos e fora de `passed`, que é o comportamento das contas puras de C1.
 */
export function buildReport({ mode, rows, run, options, checkpointChars }: { mode: ProbeOptions['mode']; rows: readonly UsageRow[]; run: RunFacts; options: ProbeOptions; checkpointChars?: readonly number[] }): ProbeReport {
  const calls = annotateCalls(rows);
  const main = calls.filter((call) => call.purpose === 'main');
  const summaries = calls.filter((call) => call.purpose === 'summary');
  const mainTotals = sum(main), summaryTotals = sum(summaries);
  const inputTokens = mainTotals.inputTokens + summaryTotals.inputTokens;
  const cachedTokens = mainTotals.cachedTokens + summaryTotals.cachedTokens;
  const outputTokens = mainTotals.outputTokens + summaryTotals.outputTokens;
  const total = { inputTokens, cachedTokens, outputTokens, uncachedInputTokens: inputTokens - cachedTokens, uncachedTokens: inputTokens - cachedTokens + outputTokens, tokens: inputTokens + outputTokens };
  const between = main.filter((call) => call.step! > 1 && !call.compactedBefore);
  const missing = between.filter((call) => !((call.cachedTokens ?? 0) > 0));
  const summaryApplied = summaries.filter((call) => call.outcome === 'applied').length;
  const criteria = {
    runCompleted: run.status === 'completed',
    callsDone: run.toolCalls >= options.calls,
    compacted: summaryApplied >= 1,
    summaryCallsAtMost2: summaries.length <= 2,
    cachedBetweenCompactions: between.length > 0 && missing.length === 0,
    cachedChecked: between.length,
    cachedMissing: missing.length,
    uncachedAtMostBaseline: options.baselineUncached === null ? null : total.uncachedTokens <= options.baselineUncached,
    baselineUncached: options.baselineUncached,
    // Sem nenhuma revisão lida, "no alvo" não está provado (false); só a ausência da leitura inteira deixa C8 de fora.
    checkpointAtMostTarget: checkpointChars === undefined ? null : checkpointChars.length > 0 && checkpointChars.every((chars) => chars <= CHECKPOINT_TARGET_MAX_CHARS),
    noSecondAttempt: checkpointChars === undefined ? null : summaries.length === summaryApplied,
    passed: false,
  };
  criteria.passed = criteria.runCompleted && criteria.callsDone && criteria.compacted && criteria.summaryCallsAtMost2 && criteria.cachedBetweenCompactions && criteria.uncachedAtMostBaseline !== false
    && criteria.checkpointAtMostTarget !== false && criteria.noSecondAttempt !== false;
  return {
    mode, model: MODEL, window: WINDOW_TOKENS, run, calls, mainCalls: main.length, summaryCalls: summaries.length,
    summaryApplied, checkpointChars: [...(checkpointChars ?? [])], main: mainTotals, summary: summaryTotals, total, criteria,
  };
}

/** Linha de uma chamada, só identificadores e números. */
export function callLine(runId: string, call: CallRecord): Record<string, unknown> {
  return {
    event: 'call', runId, seq: call.seq, purpose: call.purpose, ...(call.step !== null ? { step: call.step, compactedBefore: call.compactedBefore } : { summaryIndex: call.summaryIndex }),
    state: call.state, ...(call.outcome ? { outcome: call.outcome } : {}), inputTokens: call.inputTokens, cachedTokens: call.cachedTokens, outputTokens: call.outputTokens,
    ...(call.inputTokens && call.cachedTokens !== null ? { cachedFraction: Math.round((call.cachedTokens / call.inputTokens) * 1000) / 1000 } : {}),
  };
}

/** Linha final com os totais e os critérios (as chamadas já saíram uma a uma). */
export function resultLine(report: ProbeReport): Record<string, unknown> {
  const { calls: _calls, ...rest } = report;
  return { event: 'result', ...rest };
}

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Execução
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Resultado de `runProbe`: a contabilidade fechada e, no modo offline, a contraprova independente do banco. */
export interface ProbeRun {
  report: ProbeReport;
  /** Só no modo deterministic: o que o provedor roteirizado informou, para o teste conferir a contabilidade contra uma fonte independente do banco. */
  observed: ObservedCall[] | null;
}

/** Linha de `model_call_usage` como o driver a devolve: os contadores bigint chegam como texto (a consulta os converte com `::text`) e nulos quando o provedor não informou. */
interface LedgerRow { purpose: 'main' | 'summary'; state: string; outcome: string | null; input_tokens: string | null; cached_tokens: string | null; output_tokens: string | null }

/** Converte a linha do banco em `UsageRow` (contadores numéricos, nulo preservado como "não informado"). */
const toRow = (row: LedgerRow): UsageRow => ({
  purpose: row.purpose, state: row.state, outcome: row.outcome,
  inputTokens: row.input_tokens === null ? null : Number(row.input_tokens), cachedTokens: row.cached_tokens === null ? null : Number(row.cached_tokens), outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
});

/**
 * Monta o mundo (banco efêmero, serviços e motor reais), executa a rodada e devolve a contabilidade. `emit` recebe cada linha assim que a chamada fecha no ledger, para
 * a rodada real mostrar progresso. `adminUrl` é o PostgreSQL de teste (embarcado ou externo); o banco da sonda é criado e removido aqui.
 */
export async function runProbe(options: ProbeOptions, { adminUrl, apiKey, emit = () => undefined }: { adminUrl: string; apiKey: string; emit?: (line: Record<string, unknown>) => void }): Promise<ProbeRun> {
  const database = await createTestDatabase(adminUrl);
  const pool = createPool(database.url, { applicationName: 'validate-compaction', max: 10 });
  const logger = createLogger({ level: 'silent', name: 'validate-compaction' });
  const upstreams = options.mode === 'deterministic' ? await startFakeUpstreams() : null;
  let engine: RunEngine | null = null;
  try {
    await migrateTestDatabase(pool);
    await pool.query('UPDATE app_settings SET bot_context_window_tokens = $1, general_chat_context_window_tokens = $1', [WINDOW_TOKENS]);
    const baseUrl = upstreams?.opencodeGoBaseUrl ?? (process.env.AION_OPENCODE_GO_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const realProvider = createOpenCodeGoClient({ baseUrl, chatTimeoutMs: 180_000, logger });
    const scripted = upstreams ? createScriptedProvider(realProvider, options.calls) : null;
    const provider = scripted?.provider ?? realProvider;
    // Os clientes do Composio e da Parallel só servem a outras credenciais; o endereço de loopback fechado garante que nada saia por eles.
    const credentials = new CredentialService({
      pool, masterKey: randomBytes(32), provider, logger,
      connector: createComposioClient({ baseUrl: 'http://127.0.0.1:9' }), webSearch: createParallelClient({ baseUrl: 'http://127.0.0.1:9/mcp' }),
    });
    const models = new ModelService({ pool, credentials, provider, logger, testDeadlineMs: 180_000 });
    const bots = new BotService({ pool, models });
    const conversations = new ConversationService({ pool, credentials, models });
    // A chave é validada pelo provedor (chat de ~1 token) e guardada cifrada no banco efêmero: é por aí que o motor a lê, como em produção.
    await credentials.save('provider', apiKey, { ip: '127.0.0.1', userAgent: 'validate-compaction' });
    const tested = await models.test(ENGINE_MODEL);
    if (tested.test?.status !== 'ok') throw new ProbeError('COMPACTION_MODEL_UNAVAILABLE');
    const bot = await bots.create({ name: 'Sonda de compactação', color: '#60A5FA', instructions: '', model: ENGINE_MODEL, effort: null, stepLimit: BOT_STEP_LIMIT }, { ip: '127.0.0.1', userAgent: 'validate-compaction' });
    // Tempos curtos de despacho; o teto de tempo ativo é elevado (ver ENGINE_MAX_ACTIVE_MS). O catálogo é só o eco (mais as portas reservadas do motor).
    engine = new RunEngine({ pool, credentials, provider, models, logger, tools: [echoTool(options.resultChars)], coreCatalog: false, config: { pollMs: 100, maxActiveMs: ENGINE_MAX_ACTIVE_MS } });
    const runId = (await conversations.send(bot.id, PROBE_PROMPT.replaceAll('CALLS', String(options.calls)))).id;
    const conversationId = await conversations.conversationIdOf(bot.id);
    engine.start();

    /** O ledger da execução em ordem cronológica: uma linha por chamada ao modelo (principal ou resumo), a fonte única de toda a contabilidade da sonda. */
    const ledger = async (): Promise<UsageRow[]> => (await pool.query<LedgerRow>(
      'SELECT purpose, state, summary_outcome AS outcome, input_tokens::text, cached_tokens::text, output_tokens::text FROM model_call_usage WHERE run_id = $1 ORDER BY created_at, id', [runId],
    )).rows.map(toRow);
    /**
     * Tamanho (caracteres) de cada revisão do checkpoint da conversa, por número de revisão. O banco só guarda a revisão vigente, então a leitura acontece a cada ciclo de
     * `drain` (a cada `POLL_MS`) e uma última vez depois do fim da rodada: só o comprimento sai do banco, nunca o texto. C8 (phase 11) confere o maior deles.
     * ponytail: duas revisões aplicadas dentro do mesmo intervalo de leitura deixam a intermediária sem medida (a última é sempre lida); com o provedor real cada etapa leva
     * segundos e não ocorre, e se ocorrer o ledger mostra o resumo a mais, então trocar por uma coluna de tamanho no ledger se a sonda passar a rodar com provedor mais rápido.
     */
    const checkpointSizes = new Map<number, number>();
    const readCheckpointSize = async (): Promise<void> => {
      const row = (await pool.query<{ revision: number; chars: number }>('SELECT revision, char_length(summary) AS chars FROM conversation_context WHERE conversation_id = $1', [conversationId])).rows[0];
      if (row && row.revision > 0) checkpointSizes.set(row.revision, row.chars);
    };
    let printed = 0;
    /** Imprime as chamadas fechadas ainda não impressas, em ordem (uma chamada aberta segura as seguintes: o motor é sequencial dentro da execução), e amostra o checkpoint. */
    const drain = async (): Promise<void> => {
      await readCheckpointSize();
      const rows = await ledger();
      const closed = rows.findIndex((row) => row.state === 'started');
      const annotated = annotateCalls(rows).slice(printed, closed === -1 ? rows.length : closed);
      for (const call of annotated) emit(callLine(runId, call));
      printed += annotated.length;
    };
    /** Estado atual da execução da sonda (status, código de falha e chamadas de ferramenta), lido da tabela `runs`; é o que decide o fim da espera e alimenta C1. */
    const runOf = async (): Promise<RunFacts> => {
      const row = (await pool.query<{ status: string; failure_code: string | null; tool_calls: number }>('SELECT status, failure_code, tool_calls FROM runs WHERE id = $1', [runId])).rows[0]!;
      return { id: runId, status: row.status, failureCode: row.failure_code, toolCalls: row.tool_calls };
    };
    const deadline = performance.now() + RUN_DEADLINE_MS;
    for (;;) {
      await drain();
      const facts = await runOf();
      if (!['queued', 'running', 'waiting_approval'].includes(facts.status)) break;
      if (performance.now() >= deadline) throw new ProbeError('COMPACTION_RUN_TIMEOUT');
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    await engine.stop();
    engine = null;
    await drain();
    const checkpointChars = [...checkpointSizes.entries()].sort(([a], [b]) => a - b).map(([, chars]) => chars);
    return { report: buildReport({ mode: options.mode, rows: await ledger(), run: await runOf(), options, checkpointChars }), observed: scripted?.observed ?? null };
  } finally {
    await engine?.stop().catch(() => undefined);
    await upstreams?.stop();
    await pool.end().catch(() => undefined);
    await database.drop().catch(() => undefined);
  }
}

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Borda da CLI
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Mensagens seguras por código estável: a causa externa (provedor, banco) nunca atravessa esta borda. */
const MESSAGES: Record<string, string> = {
  COMPACTION_KEY_MISSING: 'Defina AION_VALIDATE_PROVIDER_KEY no ambiente ou em .env.validate.local (arquivo ignorado pelo Git) antes da rodada real.',
  COMPACTION_ARGUMENT_INVALID: 'Argumento inválido. Use --mode real|deterministic, --calls, --result-chars e --baseline-uncached (números inteiros dentro dos limites).',
  COMPACTION_MODEL_UNAVAILABLE: 'O modelo da sonda não passou no teste do provedor.',
  COMPACTION_RUN_TIMEOUT: 'A execução não terminou dentro do prazo da sonda.',
  COMPACTION_VALIDATION_FAILED: 'Não foi possível concluir a sonda. Confira a chave no ambiente e a disponibilidade do provedor.',
};

/** Imprime uma linha JSON no stdout: o único canal de saída dos dados da sonda (só identificadores e números). */
const write = (line: Record<string, unknown>): void => { process.stdout.write(`${JSON.stringify(line)}\n`); };

/**
 * Ponto de entrada da CLI: valida os argumentos, exige a chave no modo real, sobe o PostgreSQL de teste, roda a sonda imprimindo uma linha por chamada e o resultado
 * no fim, e fixa o código de saída (1 quando os critérios não passam ou quando algo falha). Toda falha sai como envelope com código estável, nunca com a causa externa.
 * O código de saída é só `process.exitCode = 1`, sem `process.exit()` (que derruba o Node no Windows com conexões do fetch ainda fechando): o gancho de saída do
 * `embedded-postgres`, que zeraria esse código, é neutralizado em `@aion/core/testing` (`postgres.ts`, seção "Código de saída do processo").
 */
async function main(): Promise<void> {
  try {
    const options = parseOptions(process.argv.slice(2));
    const apiKey = options.mode === 'real' ? process.env.AION_VALIDATE_PROVIDER_KEY?.trim() : `valid-compaction-${randomUUID()}`;
    if (!apiKey) throw new ProbeError('COMPACTION_KEY_MISSING');
    const postgres = await startTestPostgres();
    try {
      const { report } = await runProbe(options, { adminUrl: postgres.adminUrl, apiKey, emit: write });
      write(resultLine(report));
      if (!report.criteria.passed) process.exitCode = 1;
    } finally { await postgres.stop(); }
  } catch (error) {
    // Código estável: o da própria sonda ou o de um erro de domínio do motor (ex.: PROVIDER_KEY_INVALID); qualquer outra causa vira o código genérico.
    const code = error instanceof ProbeError ? error.code : (error as { code?: unknown } | null)?.code;
    const stable = typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : 'COMPACTION_VALIDATION_FAILED';
    process.stderr.write(`${JSON.stringify({ code: stable, message: MESSAGES[stable] ?? MESSAGES.COMPACTION_VALIDATION_FAILED, exitCode: 1 })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();

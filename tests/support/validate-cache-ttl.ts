// Sonda do tempo de vida do cache de prompt do OpenCode Go (F9 e A18 da phase 11, T1). A phase 10 provou que o cache funciona entre pedidos seguidos (`validate:cache`);
// esta sonda mede por quanto tempo ele sobrevive PARADO, porque é esse valor (T) que decide quando a conversa passa a ser fria e o mascaramento e a compactação frios
// (T7 e T8) podem reescrever o prefixo sem perder um cache ainda vivo. Sem intervalo válido, T fica no padrão de 60 minutos (`DEFAULT_TTL_MINUTES`); a medição de 18/10/2026 (cache válido até 30 minutos, morto em 60) o fixou em 40 (`COLD_AFTER_MS`).
//
// Método: uma cadeia independente por intervalo (5, 15, 30 e 60 minutos). Cada cadeia escreve um prefixo só dela e o relê UMA única vez depois do intervalo. Sem releitura
// no meio, um tempo de vida deslizante (cada leitura renovando o prazo) não contamina a medição; e cada cadeia tem sessão do provedor e prefixo próprios (um marcador único
// na primeira linha do sistema), então nenhuma cadeia lê o cache que outra escreveu nem o renova. As cadeias correm ao mesmo tempo, e o relógio da execução é o do maior
// intervalo medido: cerca de 60 minutos sem as extras e até cerca de 180 com elas (60 até a releitura da cadeia de 60, mais 120 da maior extra). O cache de um intervalo
// é VÁLIDO quando a releitura leu do cache pelo menos 90% da entrada do pedido anterior da cadeia (a mesma definição de C1 da phase 10). Se o cache ainda vale em
// 60 minutos, só então abrem as cadeias extras de 90 e 120 minutos (também ao mesmo tempo, depois da releitura de 60), porque
// o dono limitou as chamadas: sem a escrita especulativa, uma medição que acaba em 60 minutos custa 8 chamadas, e a estendida custa 12.
//
// T fixado = maior intervalo com cache válido + folga (`SLACK_MINUTES`), nunca abaixo dele. Nenhum intervalo válido não é "T pequeno": pode ser prefixo abaixo do piso de
// cache ou sonda quebrada, então T não é fixado e continua em 60 minutos (a execução sai com erro e o arquivo de resultado ainda registra os números).
//
// Só o `deepseek-v4.1-flash`, chamadas curtas, e a saída tem exclusivamente identificadores e números (a falha sai como envelope `{ code, message, exitCode }`). A chave
// entra só no ambiente e nunca é impressa nem gravada. A execução real grava o resultado por intervalo e o T fixado em `--out` (padrão:
// `.vibeflow/phases/phase-11-contexto-enxuto/cache-ttl.md`); falha do provedor reprova a sonda sem gravar nada e sem fixar T.
//   pnpm validate:cache-ttl [--out <arquivo.md>]    # real, 60 a 180 minutos de relógio; o script carrega a chave de `.env.provider` (fora do Git)
import { randomUUID } from 'node:crypto';
import { access, constants, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { buildSystemText, buildTurns, createOpenCodeGoClient, currentDataBlock, TEST_TOOL, type ChatRequest, type ChatTurn, type ChatUsage, type ContextRow, type ProviderClient } from '@aion/core';

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Parâmetros da sonda
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Modelo fixo da sonda (restrição do dono): trocar o modelo muda o que ela prova e exige novo pedido. */
const MODEL = 'deepseek-v4.1-flash';
/** Protocolo do OpenCode Go usado pelo `deepseek-v4.1-flash` nas sondas; é o que devolve `prompt_tokens_details.cached_tokens` no uso. */
const PROTOCOL = 'chat_completions';
/** Endereço do OpenCode Go; `AION_OPENCODE_GO_BASE_URL` (só do ambiente do operador) o substitui, como nos outros scripts de validação. */
const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1';
/** Intervalos das cadeias sempre medidas, em minutos. O maior deles (60) decide se as extras abrem. */
const BASE_INTERVALS_MINUTES: readonly number[] = [5, 15, 30, 60];
/** Cadeias extras, só se o cache ainda valer no maior intervalo base (decisão 14 da spec): sem elas, T nunca passaria de 60 minutos + folga numa medição que ainda via cache vivo. */
const EXTRA_INTERVALS_MINUTES: readonly number[] = [90, 120];
/** Cada cadeia faz exatamente duas chamadas ao provedor: a escrita do prefixo e a única releitura. */
const CALLS_PER_CHAIN = 2;
/** Teto de chamadas declarado (restrição do dono): 8 nas quatro cadeias base. */
const BASE_PROVIDER_CALLS = BASE_INTERVALS_MINUTES.length * CALLS_PER_CHAIN;
/** Teto com as cadeias extras abertas: 8 mais 4. O contador sobe de BASE para este valor só quando o cache vale no maior intervalo base. */
const MAX_PROVIDER_CALLS = BASE_PROVIDER_CALLS + EXTRA_INTERVALS_MINUTES.length * CALLS_PER_CHAIN;
/** T enquanto a sonda não o fixa (spec, decisão 13): vale também quando a sonda reprova ou não acha intervalo válido. */
const DEFAULT_TTL_MINUTES = 60;
/**
 * Folga somada ao maior intervalo válido para fixar T (regra do plan: T = maior intervalo válido + folga, nunca abaixo dele). 10 minutos porque a medição só prova o cache vivo
 * nos intervalos amostrados, uma amostra cada, num cache de melhor esforço: o tempo de vida real está em algum ponto entre o maior válido e o próximo intervalo, e a folga
 * cobre a incerteza de amostragem sem alongar demais a espera (em nenhum degrau da grade a folga passa do intervalo seguinte: 5+10 = 15, e nos demais fica aquém). Errar para
 * cima só adia o mascaramento e perde economia; errar para baixo mascara com o cache ainda vivo e paga o prefixo de novo, e é por isso que o piso é o maior intervalo válido.
 * ponytail: a folga fixa não cobre o trecho entre o maior intervalo válido e o primeiro inválido; se o relatório de custo mostrar mascaramento com cache vivo, trocar por
 * uma folga que alcance o primeiro intervalo inválido.
 */
const SLACK_MINUTES = 10;
/** Fração mínima do `inputTokens` do pedido anterior da cadeia que a releitura precisa ler do cache para o intervalo ser válido (a mesma definição de C1 da phase 10). */
const MIN_CACHED_FRACTION = 0.9;
/** Saída curta por chamada: só o `usage` importa, e o modelo raciocina por padrão (parte do limite é gasta pensando). */
const MAX_OUTPUT_TOKENS = 512;
/** Idioma e fuso do dono simulado (padrões do produto); o fuso também fixa a data do arquivo de resultado. */
const SETTINGS = { language: 'pt-BR' as const, timeZone: 'America/Sao_Paulo' };
/** Raiz do repositório (este arquivo está em `tests/support/`): âncora do caminho padrão do resultado, para a sonda não depender do diretório de onde é chamada. */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** Onde a execução real grava o resultado por intervalo e o T fixado; é o arquivo que a T7 lê. `--out` o substitui (os testes gravam numa pasta temporária). */
const DEFAULT_OUT = resolve(ROOT, '.vibeflow/phases/phase-11-contexto-enxuto/cache-ttl.md');
/**
 * Memória sintética do bot da sonda, sem dado real: 90 notas. O provedor só guarda em cache prefixos a partir de 1.024 tokens e em blocos de 64 (medido na phase 3), e a
 * medição compara com o pedido anterior inteiro, então o prefixo precisa ser grande (~4 mil tokens) para os blocos de borda pesarem pouco. Igual à da sonda `validate:cache`.
 */
const SYNTHETIC_MEMORY = Array.from({ length: 90 }, (_, index) => `- Nota sintética ${index + 1} da sonda: preferir respostas curtas, objetivas e sem rodeios.`).join('\n');

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Resultado
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Espera abortável: `signal` acorda a espera com erro quando outra cadeia falha, para a sonda não ficar presa (nem chamar o provedor) depois de reprovar. Injetável nos testes. */
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;
/** Espera real da CLI: o tempo corre de verdade (de 5 a 120 minutos) e o `signal` a interrompe se outra cadeia falhar. */
const defaultSleep: Sleep = (ms, signal) => delay(ms, undefined, { signal });

/** O que uma cadeia mediu. Só identificadores e números. */
export interface IntervalResult {
  intervalMinutes: number;
  /** Espera real entre o fim da escrita e o início da releitura, em segundos (nunca abaixo do intervalo nominal: a espera só alonga). */
  gapSeconds: number;
  /** Entrada do pedido de escrita: o denominador da fração (pedido anterior da cadeia). */
  previousInputTokens: number;
  inputTokens: number;
  cachedTokens: number;
  /** `cachedTokens / previousInputTokens`: a definição de C1. */
  cachedOfPrevious: number;
  /** `cachedOfPrevious >= 0,9`. */
  valid: boolean;
}

export interface TtlDecision {
  /** Maior intervalo com cache válido; nulo quando nenhum foi. */
  largestValidMinutes: number | null;
  /** T efetivo: o fixado, ou o padrão de 60 minutos quando não há intervalo válido. */
  ttlMinutes: number;
  /** `true` quando T foi fixado por esta medição. */
  fixed: boolean;
  /** Há intervalo inválido MENOR que o maior válido: o cache de melhor esforço não foi monótono. O T já usa o maior válido, o aviso só chama a atenção do dono. */
  nonMonotonic: boolean;
}

export interface TtlReport extends TtlDecision {
  /** Uma entrada por cadeia, em ordem crescente de intervalo. */
  intervals: IntervalResult[];
  providerCalls: number;
  /** As cadeias extras de 90 e 120 minutos foram abertas (o cache valia em 60 minutos). */
  extended: boolean;
}

/**
 * Regra que fixa T a partir dos intervalos medidos (função pura, provada exaustivamente no teste): o maior intervalo com cache válido mais `SLACK_MINUTES`, nunca abaixo dele.
 * Sem nenhum intervalo válido não há base para T: ele não é fixado e continua em `DEFAULT_TTL_MINUTES`.
 */
export function computeTtl(intervals: ReadonlyArray<{ intervalMinutes: number; valid: boolean }>): TtlDecision {
  const validMinutes = intervals.filter((entry) => entry.valid).map((entry) => entry.intervalMinutes);
  if (validMinutes.length === 0) return { largestValidMinutes: null, ttlMinutes: DEFAULT_TTL_MINUTES, fixed: false, nonMonotonic: false };
  const largestValidMinutes = Math.max(...validMinutes);
  return {
    largestValidMinutes,
    ttlMinutes: largestValidMinutes + SLACK_MINUTES,
    fixed: true,
    nonMonotonic: intervals.some((entry) => !entry.valid && entry.intervalMinutes < largestValidMinutes),
  };
}

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Sonda
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Falha esperada da sonda: carrega só o código estável, que a borda da CLI converte no envelope. A mensagem é o próprio código, para nenhuma causa externa viajar numa exceção. */
export class ProbeError extends Error {
  constructor(readonly code: keyof typeof MESSAGES) { super(code); this.name = 'ProbeError'; }
}

export interface TtlProbeInput {
  provider: ProviderClient;
  apiKey: string;
  /** Recebe uma linha por chamada (`call`), uma por cadeia concluída (`measurement`) e o `result` final; só identificadores e números. */
  emit: (line: Record<string, unknown>) => void;
  /** Espera entre a escrita e a releitura; os testes injetam um relógio virtual, a CLI usa o tempo real. */
  sleep?: Sleep;
  /** Relógio em milissegundos (para a espera real registrada e para a hora do bloco `# Dados`). */
  now?: () => number;
}

/** Lê um número que o provedor tinha de informar: a ausência dele (que não é zero) reprova a sonda em vez de virar um intervalo "inválido" que baixaria T. */
const need = (value: number | undefined): number => {
  if (value === undefined) throw new ProbeError('PROVIDER_CACHE_TTL_UNMEASURED');
  return value;
};

/**
 * Roda as cadeias contra `provider` e devolve o relatório. Cadeias base ao mesmo tempo; se a de 60 minutos for válida, as extras ao mesmo tempo depois dela. Qualquer falha
 * (provedor, número ausente, teto de chamadas) aborta as demais cadeias, que acordam e param sem chamar o provedor, e a primeira falha é a que sobe: nenhum T é fixado.
 * ponytail: sem retentativa de chamada transitória, então uma falha de rede no meio da espera reprova a execução inteira (a saída já impressa guarda os intervalos que
 * terminaram); acrescentar uma retentativa só da releitura se a execução real reprovar por isso.
 * ponytail: uma amostra por intervalo, e o cache do provedor é de melhor esforço; se T fixado for usar uma margem apertada, repetir a sonda antes de confiar nele.
 */
export async function runTtlProbe({ provider, apiKey, emit, sleep = defaultSleep, now = Date.now }: TtlProbeInput): Promise<TtlReport> {
  const abort = new AbortController();
  let providerCalls = 0;
  let callLimit = BASE_PROVIDER_CALLS;
  let failure: { error: unknown } | null = null;

  /** Uma chamada curta ao provedor: respeita o teto declarado, consome o stream até o uso e imprime só números. Devolve o uso que o provedor informou. */
  async function call(intervalMinutes: number, phase: 'write' | 'reread', sessionId: string, system: ChatTurn, rows: readonly ContextRow[]): Promise<ChatUsage> {
    if (providerCalls >= callLimit) throw new ProbeError('PROVIDER_CACHE_TTL_CALL_LIMIT');
    providerCalls += 1;
    const request: ChatRequest = { model: MODEL, sessionId, turns: [system, ...buildTurns(rows)], tools: [TEST_TOOL], maxTokens: MAX_OUTPUT_TOKENS };
    let usage: ChatUsage = {};
    for await (const event of provider.streamChat(apiKey, PROTOCOL, request, abort.signal)) {
      if (event.type === 'usage') usage = event.usage;
    }
    emit({ event: 'call', intervalMinutes, phase, model: MODEL, protocol: PROTOCOL, ...usage, ...(usage.inputTokens && usage.cachedTokens !== undefined ? { cachedFraction: usage.cachedTokens / usage.inputTokens } : {}) });
    return usage;
  }

  /**
   * Uma cadeia independente: sessão e prefixo só dela, escrita, espera de `intervalMinutes` e uma única releitura. A releitura é o pedido da escrita seguido de uma resposta fixa e de
   * uma nova rodada, a forma de uma conversa que continua (o bloco `# Dados` da rodada de escrita é reenviado byte a byte, como no motor).
   */
  async function runChain(intervalMinutes: number): Promise<IntervalResult> {
    const sessionId = randomUUID();
    // O marcador na primeira linha do sistema faz o prefixo divergir de qualquer outra cadeia logo no começo: nada do que ela escreve ou renova no cache serve a outra.
    const system: ChatTurn = { role: 'system', text: `Sonda de TTL ${randomUUID()}\n\n${buildSystemText({ botName: 'Validação de TTL do cache', botInstructions: 'Responda em uma palavra.', botMemory: SYNTHETIC_MEMORY, globalMemory: '', ...SETTINGS })}` };
    const opening = (round: number, content: string): ContextRow => ({ id: String(round), run_id: String(round), role: 'user', kind: 'text', status: 'done', opens_round: true, step: null, content, data: {}, request_data: currentDataBlock({ model: MODEL, now: new Date(now()), ...SETTINGS }) });
    const answer: ContextRow = { run_id: '1', role: 'assistant', kind: 'text', status: 'done', opens_round: false, step: 1, content: 'ok', data: {} };

    const first = opening(1, 'Sonda de TTL do cache, escrita: responda apenas ok.');
    const written = await call(intervalMinutes, 'write', sessionId, system, [first]);
    const previousInputTokens = need(written.inputTokens);
    const wroteAt = now();
    await sleep(intervalMinutes * 60_000, abort.signal);
    const rereadAt = now();
    const reread = await call(intervalMinutes, 'reread', sessionId, system, [first, answer, opening(2, 'Sonda de TTL do cache, releitura: responda apenas ok.')]);

    const inputTokens = need(reread.inputTokens);
    const cachedTokens = need(reread.cachedTokens);
    const cachedOfPrevious = cachedTokens / previousInputTokens;
    const result: IntervalResult = { intervalMinutes, gapSeconds: Math.round((rereadAt - wroteAt) / 1000), previousInputTokens, inputTokens, cachedTokens, cachedOfPrevious, valid: cachedOfPrevious >= MIN_CACHED_FRACTION };
    emit({ event: 'measurement', ...result });
    return result;
  }

  /** Roda uma cadeia e, se ela falhar, derruba as outras (espera e chamadas em voo) e repete a primeira falha, para o erro original ser o que o chamador vê. */
  const guarded = async (intervalMinutes: number): Promise<IntervalResult> => {
    try {
      return await runChain(intervalMinutes);
    } catch (error) {
      failure ??= { error };
      abort.abort();
      throw failure.error;
    }
  };

  const base = await Promise.all(BASE_INTERVALS_MINUTES.map(guarded));
  // A decisão de abrir as extras é do maior intervalo base, que por construção é o último a terminar: aqui todas as cadeias base já mediram.
  const longestBase = base.find((entry) => entry.intervalMinutes === Math.max(...BASE_INTERVALS_MINUTES));
  const extended = longestBase?.valid === true;
  let extra: IntervalResult[] = [];
  if (extended) {
    callLimit = MAX_PROVIDER_CALLS;
    extra = await Promise.all(EXTRA_INTERVALS_MINUTES.map(guarded));
  }

  const intervals = [...base, ...extra].sort((left, right) => left.intervalMinutes - right.intervalMinutes);
  const report: TtlReport = { intervals, providerCalls, extended, ...computeTtl(intervals) };
  emit({ event: 'result', model: MODEL, providerCalls, maxProviderCalls: callLimit, minCachedFraction: MIN_CACHED_FRACTION, extended, slackMinutes: SLACK_MINUTES, largestValidMinutes: report.largestValidMinutes, ttlMinutes: report.ttlMinutes, fixed: report.fixed, nonMonotonic: report.nonMonotonic });
  return report;
}

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Arquivo de resultado
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Texto do arquivo de resultado da phase (`cache-ttl.md`): uma linha por intervalo com os tokens de entrada e em cache da releitura, e o T fixado. É a fonte que a T7 lê para
 * gravar a constante de T. Só números e rótulos fixos: nada da conversa, do prefixo nem da chave.
 */
export function renderTtlReport(report: TtlReport, date: string): string {
  const count = (value: number): string => value.toLocaleString('pt-BR');
  const fraction = (value: number): string => value.toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  const rows = report.intervals.map((entry) => `| ${entry.intervalMinutes} | ${count(entry.gapSeconds)} | ${count(entry.previousInputTokens)} | ${count(entry.inputTokens)} | ${count(entry.cachedTokens)} | ${fraction(entry.cachedOfPrevious)} | ${entry.valid ? 'sim' : 'não'} |`);
  return [
    '# Tempo de vida do cache do OpenCode Go (F9, A18)',
    '',
    `Medido em ${date} por \`pnpm validate:cache-ttl\` com o \`${MODEL}\`: uma cadeia independente por intervalo (escrita do prefixo e uma única releitura depois do intervalo), ${report.providerCalls} chamadas curtas.`,
    '',
    '| Intervalo (min) | Espera real (s) | Entrada da escrita | Entrada da releitura | Em cache na releitura | Cache / escrita | Válido |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
    `Um intervalo é válido quando a releitura leu do cache pelo menos ${MIN_CACHED_FRACTION * 100}% da entrada da escrita (a definição de C1 da phase 10).`,
    '',
    `- Cadeias extras de ${EXTRA_INTERVALS_MINUTES.join(' e ')} minutos: ${report.extended ? 'executadas (o cache valia em 60 minutos)' : 'não executadas (o cache não valia em 60 minutos)'}.`,
    `- Maior intervalo com cache válido: ${report.largestValidMinutes === null ? 'nenhum' : `${report.largestValidMinutes} minutos`}.`,
    `- Folga: ${SLACK_MINUTES} minutos.`,
    report.fixed ? `- **T fixado: ${report.ttlMinutes} minutos.**` : `- **T não fixado: nenhum intervalo manteve o cache; T continua em ${DEFAULT_TTL_MINUTES} minutos.**`,
    ...(report.nonMonotonic ? ['- Atenção: algum intervalo menor que o maior válido ficou sem cache. O T usa o maior intervalo válido; vale repetir a sonda antes de confiar nele.'] : []),
    '',
  ].join('\n');
}

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Borda da CLI
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Mensagens seguras por código estável: a causa externa (provedor, rede) nunca atravessa esta borda. */
const MESSAGES = {
  PROVIDER_CACHE_TTL_FAILED: `Não foi possível medir o cache do provedor. Confira a chave no ambiente e a disponibilidade do serviço. T não foi fixado e continua em ${DEFAULT_TTL_MINUTES} minutos.`,
  PROVIDER_CACHE_TTL_UNMEASURED: `O provedor não informou os tokens de entrada ou de cache de uma chamada. T não foi fixado e continua em ${DEFAULT_TTL_MINUTES} minutos.`,
  PROVIDER_CACHE_TTL_CALL_LIMIT: `A sonda atingiu o teto de chamadas declarado. T não foi fixado e continua em ${DEFAULT_TTL_MINUTES} minutos.`,
  PROVIDER_CACHE_TTL_INCONCLUSIVE: `Nenhum intervalo manteve o cache. T não foi fixado e continua em ${DEFAULT_TTL_MINUTES} minutos; veja a linha result e o arquivo de resultado.`,
  PROVIDER_CACHE_TTL_INVALID_ARGUMENT: 'Argumento inválido ou arquivo de saída não gravável. Uso: pnpm validate:cache-ttl [--out <arquivo.md>].',
} as const;

/** Dependências substituíveis da CLI: os testes injetam provedor, espera e relógio para correr horas em milissegundos e capturar as saídas. */
export interface CliDeps {
  provider?: ProviderClient;
  sleep?: Sleep;
  now?: () => number;
  write?: (line: Record<string, unknown>) => void;
  writeError?: (line: Record<string, unknown>) => void;
}

/** Imprime uma linha JSON no canal indicado: o único meio de saída dos dados da sonda (só identificadores e números). */
const stdoutLine = (line: Record<string, unknown>): void => { process.stdout.write(`${JSON.stringify(line)}\n`); };
/** Saída de erro: só o envelope `{ code, message, exitCode }` com mensagem segura; a causa externa e a chave nunca chegam aqui. */
const stderrLine = (line: Record<string, unknown>): void => { process.stderr.write(`${JSON.stringify(line)}\n`); };

/** Caminho do resultado: `--out` (relativo ao diretório de trabalho) ou o padrão da phase. Argumento desconhecido ou valor ausente é argumento inválido. */
function outputPath(argv: readonly string[]): string {
  try {
    const { values } = parseArgs({ args: [...argv], options: { out: { type: 'string' } }, strict: true, allowPositionals: false });
    return values.out === undefined ? DEFAULT_OUT : resolve(values.out);
  } catch {
    throw new ProbeError('PROVIDER_CACHE_TTL_INVALID_ARGUMENT');
  }
}

/**
 * Executa a sonda inteira e devolve o código de saída. Confere o caminho de saída e a chave ANTES de qualquer chamada (a execução custa chamadas e de 1 a 3 horas, então um
 * erro bobo no fim não pode jogar fora a medição). Grava o arquivo de resultado quando a sonda termina, com T fixado ou não; falha do provedor não grava nada. Sai com 1 quando
 * T não foi fixado, por falha ou por nenhum intervalo válido.
 */
export async function runCli(argv: readonly string[], env: NodeJS.ProcessEnv, deps: CliDeps = {}): Promise<number> {
  const write = deps.write ?? stdoutLine;
  const writeError = deps.writeError ?? stderrLine;
  try {
    const out = outputPath(argv);
    const apiKey = env.AION_VALIDATE_PROVIDER_KEY?.trim();
    if (!apiKey) throw new ProbeError('PROVIDER_CACHE_TTL_FAILED');
    try {
      await mkdir(dirname(out), { recursive: true });
      await access(dirname(out), constants.W_OK);
    } catch {
      throw new ProbeError('PROVIDER_CACHE_TTL_INVALID_ARGUMENT');
    }
    const now = deps.now ?? Date.now;
    const provider = deps.provider ?? createOpenCodeGoClient({ baseUrl: env.AION_OPENCODE_GO_BASE_URL ?? DEFAULT_BASE_URL, chatTimeoutMs: 60_000 });
    const report = await runTtlProbe({ provider, apiKey, emit: write, sleep: deps.sleep, now });
    await writeFile(out, renderTtlReport(report, new Date(now()).toLocaleDateString('sv-SE', { timeZone: SETTINGS.timeZone })), 'utf8');
    if (!report.fixed) throw new ProbeError('PROVIDER_CACHE_TTL_INCONCLUSIVE');
    return 0;
  } catch (error) {
    const code = error instanceof ProbeError ? error.code : 'PROVIDER_CACHE_TTL_FAILED';
    writeError({ code, message: MESSAGES[code], exitCode: 1 });
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void runCli(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; });

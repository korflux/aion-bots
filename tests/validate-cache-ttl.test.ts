// Prova da sonda `validate:cache-ttl` (phase 11, T1) sem chamar o provedor real nem esperar horas: a lógica roda em processo contra um provedor falso que EXPIRA o cache
// (prefixo guardado por conteúdo, vivo por `ttlMinutes`, com TTL deslizante: toda leitura renova a entrada que usou, o caso mais duro para a independência das cadeias) e
// contra um relógio virtual que pula direto para o próximo `sleep` quando todas as cadeias estão paradas esperando. A medição real (60 a 180 minutos, com a chave do dono em
// `.env.provider`) é a segunda metade da prova e roda à parte, por ordem do líder; este teste nunca lê esse arquivo nem fala com o provedor de verdade.
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_TOOL, type ChatRequest, type ChatUsage, type ProviderClient } from '@aion/core';
import { startFakeUpstreams } from '@aion/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeTtl, ProbeError, runCli, runTtlProbe, type TtlReport } from './support/validate-cache-ttl';

/** Raiz do repositório: diretório de trabalho do processo real da CLI, para o caminho de `tests/support/...` valer de qualquer lugar. */
const ROOT = fileURLToPath(new URL('../', import.meta.url));
/** Chave FALSA do teste: só prova que a chave nunca aparece na saída nem no arquivo; o provedor falso não a valida. */
const KEY = 'valid-cache-ttl-chave-XYZ9';
/** Um minuto em milissegundos: os intervalos da sonda são em minutos e o relógio virtual anda em milissegundos. */
const MINUTE = 60_000;
/** Texto da conversa e do prefixo que a sonda nunca pode deixar chegar à saída. */
const FORBIDDEN = ['Sonda de TTL', 'Nota sintética', 'Responda', 'Validação de TTL'];

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Relógio virtual e provedor falso com cache que expira
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Relógio e `sleep` virtuais. `drive` deixa as cadeias trabalharem até todas pararem em `sleep` e então pula o relógio para o timer mais próximo: as cadeias correm ao mesmo tempo,
 * cada uma com a sua espera exata, sem relógio real. `sleep` obedece ao `signal` como o real (acorda com erro e some da fila quando a sonda aborta).
 */
function createVirtualClock() {
  let current = Date.UTC(2026, 9, 18, 15, 0, 0);
  const start = current;
  const timers = new Set<{ at: number; wake: () => void }>();
  const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new Error('espera abortada')); return; }
    const timer = { at: current + ms, wake: resolve };
    timers.add(timer);
    signal.addEventListener('abort', () => { timers.delete(timer); reject(new Error('espera abortada')); }, { once: true });
  });
  async function drive<T>(promise: Promise<T>): Promise<T> {
    let done = false;
    const watched = promise.finally(() => { done = true; });
    watched.catch(() => undefined); // a rejeição é entregue pelo `return watched`; aqui só evita rejeição não tratada enquanto o laço gira
    for (let turns = 0; !done; turns += 1) {
      if (turns > 2_000) throw new Error('relógio virtual sem progresso');
      await new Promise((resolve) => setImmediate(resolve)); // drena as microtarefas e as chamadas do provedor falso
      if (done) break;
      const next = [...timers].sort((left, right) => left.at - right.at)[0];
      // Sem timer e sem fim: há E/S real em andamento (a CLI cria a pasta e grava o arquivo), então espera um instante de relógio real em vez de girar.
      if (!next) { await new Promise((resolve) => setTimeout(resolve, 5)); continue; }
      timers.delete(next);
      current = Math.max(current, next.at);
      next.wake();
    }
    return watched;
  }
  return { now: () => current, start, sleep, drive, pending: () => timers.size };
}

/**
 * O que o provedor falso recebeu: a hora virtual, a sessão e uma cópia do pedido (a sonda reaproveita objetos). `usage` é o uso que ele informou para a chamada, já depois de
 * `mutate`: a fonte do denominador e do numerador que a sonda deve ter usado em cada intervalo.
 */
interface Call { at: number; sessionId: string; request: ChatRequest; usage?: ChatUsage }

/** Razão tokens por byte do corpo e piso e bloco de prefixo do cache, no modelo do provedor real (medido: 1.024 tokens de piso, blocos de 64). */
const TOKENS_PER_BYTE = 0.3;
const MIN_CACHED_PREFIX = 1_024;
const CACHE_BLOCK = 64;

/**
 * Provedor falso que informa o uso no modelo do provedor real e guarda cada pedido (ferramentas e turnos, segmento a segmento) por `ttlMinutes`. O cache NÃO é por sessão:
 * qualquer pedido pode ler o prefixo que outro escreveu, e toda leitura renova o prazo da entrada usada (TTL deslizante). Assim uma cadeia que compartilhasse prefixo com outra
 * apareceria contaminada. `before` (lança para simular falha) e `mutate` (reescreve o uso informado) recebem o número da chamada, a partir de 1.
 */
function expiringProvider({ ttlMinutes, now, before, mutate }: { ttlMinutes: number; now: () => number; before?: (call: number) => void; mutate?: (usage: ChatUsage, call: number) => ChatUsage }): { provider: ProviderClient; calls: Call[] } {
  const calls: Call[] = [];
  const entries: { segments: string[]; at: number }[] = [];
  const provider: ProviderClient = {
    listModels: () => Promise.resolve([{ id: 'deepseek-v4.1-flash' }]),
    async *streamChat(_apiKey, _protocol, request) {
      const at = now();
      calls.push({ at, sessionId: request.sessionId, request: structuredClone(request) });
      const number = calls.length; // as escritas saem juntas: o número da chamada é fixado aqui, antes de qualquer espera
      before?.(number);
      const segments = [JSON.stringify(request.tools ?? []), ...request.turns.map((turn) => JSON.stringify(turn))];
      let commonBytes = 0;
      let used: { segments: string[]; at: number } | null = null;
      for (const entry of entries) {
        if (at - entry.at > ttlMinutes * MINUTE) continue; // expirada
        let bytes = 0;
        for (let index = 0; index < Math.min(entry.segments.length, segments.length) && entry.segments[index] === segments[index]; index += 1) bytes += Buffer.byteLength(segments[index]!, 'utf8');
        if (bytes > commonBytes) { commonBytes = bytes; used = entry; }
      }
      if (used) used.at = at;
      entries.push({ segments, at });
      const inputTokens = Math.ceil(segments.reduce((sum, segment) => sum + Buffer.byteLength(segment, 'utf8'), 0) * TOKENS_PER_BYTE);
      const prefixTokens = Math.floor(commonBytes * TOKENS_PER_BYTE);
      const cachedTokens = prefixTokens >= MIN_CACHED_PREFIX ? Math.min(Math.floor(prefixTokens / CACHE_BLOCK) * CACHE_BLOCK, inputTokens) : 0;
      const usage: ChatUsage = { inputTokens, cachedTokens, outputTokens: 2 };
      yield { type: 'text', text: 'ok' };
      const reported = mutate ? mutate(usage, number) : usage;
      calls[number - 1]!.usage = reported;
      yield { type: 'usage', usage: reported };
      yield { type: 'done', reason: 'stop' };
    },
  };
  return { provider, calls };
}

/** As cadeias que o provedor falso viu: uma entrada por sessão, com a escrita e a releitura na ordem em que chegaram. */
function chainsOf(calls: Call[]): [Call, Call][] {
  const bySession = new Map<string, Call[]>();
  for (const call of calls) bySession.set(call.sessionId, [...(bySession.get(call.sessionId) ?? []), call]);
  return [...bySession.values()].map(([write, reread]) => [write!, reread!]);
}

/**
 * G1: o denominador de C1 de cada intervalo é a entrada que o provedor informou para a escrita da MESMA cadeia, e não a de outra cadeia nem a da própria releitura. A cadeia é a
 * sessão no provedor falso; na saída ela é o intervalo (a espera entre as duas chamadas da sessão). Confere a medição contra o evento `call` de fase `write` do mesmo intervalo.
 */
function expectDenominatorIsOwnWrite(calls: Call[], lines: Record<string, unknown>[]): void {
  for (const [write, reread] of chainsOf(calls)) {
    const interval = (reread.at - write.at) / MINUTE;
    const measurement = lines.find((line) => line.event === 'measurement' && line.intervalMinutes === interval);
    const writeLine = lines.find((line) => line.event === 'call' && line.phase === 'write' && line.intervalMinutes === interval);
    expect(measurement, `medição de ${interval} min`).toBeDefined();
    expect(writeLine, `escrita de ${interval} min`).toBeDefined();
    expect(measurement!.previousInputTokens, `denominador de ${interval} min`).toBe(write.usage!.inputTokens);
    expect(writeLine!.inputTokens, `entrada da escrita de ${interval} min`).toBe(write.usage!.inputTokens);
    expect(measurement!.inputTokens, `entrada da releitura de ${interval} min`).toBe(reread.usage!.inputTokens);
    expect(measurement!.cachedTokens, `cache da releitura de ${interval} min`).toBe(reread.usage!.cachedTokens);
  }
}

/** Monta a sonda com relógio virtual e provedor que expira o cache; `run` a dispara e `lines` acumula a saída. */
function setup(ttlMinutes: number, hooks: { before?: (call: number) => void; mutate?: (usage: ChatUsage, call: number) => ChatUsage } = {}) {
  const clock = createVirtualClock();
  const { provider, calls } = expiringProvider({ ttlMinutes, now: clock.now, ...hooks });
  const lines: Record<string, unknown>[] = [];
  const run = (): Promise<TtlReport> => clock.drive(runTtlProbe({ provider, apiKey: KEY, emit: (line) => lines.push(line), sleep: clock.sleep, now: clock.now }));
  return { clock, provider, calls, lines, run };
}

/** Toda linha de saída é só identificador ou número: nenhum texto livre (espaços, frases) passa por este formato. */
function expectOnlyIdsAndNumbers(lines: Record<string, unknown>[]): void {
  const walk = (value: unknown, path: string): void => {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return;
    if (typeof value === 'string') { expect(value, path).toMatch(/^[A-Za-z0-9_.:-]{1,64}$/); return; }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) walk(item, `${path}.${key}`);
  };
  lines.forEach((line, index) => walk(line, `linha ${index}`));
}

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Lógica da sonda
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

describe('sonda de TTL do cache (lógica, provedor que expira o cache)', () => {
  // [tempo de vida do cache no provedor falso (min), intervalos válidos esperados, chamadas esperadas, maior válido, T esperado]. O caso 60 é a borda: a espera igual ao TTL ainda lê.
  const GRID: [number, number[], number, number | null, number][] = [
    [2, [], 8, null, 60],
    [7, [5], 8, 5, 15],
    [20, [5, 15], 8, 15, 25],
    [45, [5, 15, 30], 8, 30, 40],
    [60, [5, 15, 30, 60], 12, 60, 70],
    [100, [5, 15, 30, 60, 90], 12, 90, 100],
    [400, [5, 15, 30, 60, 90, 120], 12, 120, 130],
  ];

  it.each(GRID)('cache de %i min: cadeias independentes, uma releitura cada, teto de chamadas e T nunca abaixo do maior intervalo válido', async (ttlMinutes, validIntervals, expectedCalls, largestValid, expectedTtl) => {
    const { clock, calls, lines, run } = setup(ttlMinutes);
    const report = await run();

    // Cadeias: as quatro base e, só quando o cache vale em 60 minutos, as duas extras; cada intervalo vale pelo que o cache vivo no provedor falso permite.
    const measured = ttlMinutes >= 60 ? [5, 15, 30, 60, 90, 120] : [5, 15, 30, 60];
    expect(report.extended).toBe(ttlMinutes >= 60);
    expect(report.intervals.map((entry) => [entry.intervalMinutes, entry.valid])).toEqual(measured.map((interval) => [interval, validIntervals.includes(interval)]));
    expect(report.intervals.map((entry) => entry.gapSeconds)).toEqual(measured.map((interval) => interval * 60));

    // Teto de chamadas: 8 sem as extras, 12 com elas, e o que o provedor recebeu é exatamente o que a sonda contou.
    expect(report.providerCalls).toBe(expectedCalls);
    expect(calls).toHaveLength(expectedCalls);
    expect(lines.filter((line) => line.event === 'call')).toHaveLength(expectedCalls);

    // T: o maior intervalo válido mais a folga de 10 minutos, nunca abaixo dele; sem intervalo válido, T não é fixado e fica em 60.
    expect(report.largestValidMinutes).toBe(largestValid);
    expect(report.ttlMinutes).toBe(expectedTtl);
    expect(report.fixed).toBe(largestValid !== null);
    if (largestValid !== null) expect(report.ttlMinutes).toBeGreaterThanOrEqual(largestValid);
    expect(report.nonMonotonic).toBe(false);

    // Independência: uma sessão e um prefixo por cadeia, duas chamadas por sessão (escrita e uma única releitura), a releitura estende a escrita byte a byte e vem depois da espera exata.
    const chains = chainsOf(calls);
    expect(new Set(calls.map((call) => call.sessionId)).size).toBe(measured.length);
    expect(chains).toHaveLength(measured.length);
    expect(chains.length * 2).toBe(calls.length); // exatamente duas chamadas por sessão
    const firstLines = chains.map(([write]) => (write.request.turns[0] as { text: string }).text.split('\n')[0]);
    expect(new Set(firstLines).size).toBe(measured.length);
    for (const [write, reread] of chains) {
      expect(reread.request.tools).toEqual(write.request.tools);
      expect(reread.request.turns.length).toBeGreaterThan(write.request.turns.length);
      expect(reread.request.turns.slice(0, write.request.turns.length)).toEqual(write.request.turns);
    }
    const gaps = chains.map(([write, reread]) => reread.at - write.at).sort((left, right) => left - right);
    expect(gaps).toEqual(measured.map((interval) => interval * MINUTE));
    // As quatro escritas base saem juntas; as extras só depois da releitura de 60 minutos (sem escrita especulativa).
    const writes = chains.map(([write, reread]) => ({ at: write.at, gap: reread.at - write.at }));
    expect(writes.filter((write) => write.gap <= 60 * MINUTE).every((write) => write.at === clock.start)).toBe(true);
    expect(writes.filter((write) => write.gap > 60 * MINUTE).every((write) => write.at === clock.start + 60 * MINUTE)).toBe(true);

    // Só o modelo da restrição do dono, só a ferramenta de eco, chamadas curtas.
    expect(new Set(calls.map((call) => call.request.model))).toEqual(new Set(['deepseek-v4.1-flash']));
    expect(calls.every((call) => call.request.tools?.map((tool) => tool.name).join() === TEST_TOOL.name && call.request.maxTokens <= 512)).toBe(true);

    // Cada medição é o cache da releitura contra a entrada da escrita da MESMA cadeia (a definição de C1; G1).
    const measurements = lines.filter((line) => line.event === 'measurement');
    expect(measurements).toHaveLength(measured.length);
    expectDenominatorIsOwnWrite(calls, lines);
    for (const line of measurements) {
      expect(line.cachedOfPrevious).toBe((line.cachedTokens as number) / (line.previousInputTokens as number));
      expect(line.valid).toBe((line.cachedOfPrevious as number) >= 0.9);
    }
    expect(lines.at(-1)).toEqual({ event: 'result', model: 'deepseek-v4.1-flash', providerCalls: expectedCalls, maxProviderCalls: ttlMinutes >= 60 ? 12 : 8, minCachedFraction: 0.9, extended: ttlMinutes >= 60, slackMinutes: 10, largestValidMinutes: largestValid, ttlMinutes: expectedTtl, fixed: largestValid !== null, nonMonotonic: false });

    // Saída só com números e identificadores: nem a chave nem o texto da conversa passam.
    expectOnlyIdsAndNumbers(lines);
    const text = JSON.stringify(lines);
    for (const forbidden of [KEY, ...FORBIDDEN]) expect(text).not.toContain(forbidden);
  });

  it('G1: o denominador de C1 é a entrada da escrita da MESMA cadeia (cada escrita informa uma entrada diferente, então misturar cadeias seria visível)', async () => {
    // Escritas: chamadas 1 a 4 (cadeias base, juntas) e 9 e 10 (extras). Somar o número da chamada dá a cada cadeia uma entrada própria sem tirar nenhuma da faixa válida (~98,6%).
    const writeCalls = new Set([1, 2, 3, 4, 9, 10]);
    const { run, calls, lines } = setup(400, { mutate: (usage, call) => (writeCalls.has(call) ? { ...usage, inputTokens: usage.inputTokens! + call } : usage) });
    const report = await run();
    expect(report.intervals.map((entry) => entry.valid)).toEqual([true, true, true, true, true, true]);
    expect(new Set(report.intervals.map((entry) => entry.previousInputTokens)).size).toBe(6); // seis cadeias, seis denominadores distintos
    expectDenominatorIsOwnWrite(calls, lines);
    for (const entry of report.intervals) expect(entry.cachedOfPrevious).toBe(entry.cachedTokens / entry.previousInputTokens);
  });

  it('G2: a fronteira de 90% vale com >= (exatamente 0,9 é válido, logo abaixo não é)', async () => {
    // A escrita da cadeia de 5 minutos (chamada 1) informa 4.010 de entrada e a releitura (chamada 5) informa o cache; 3.609 / 4.010 é exatamente 9/10, o mesmo double de 0,9.
    const boundary = (cachedTokens: number) => setup(400, { mutate: (usage, call) => (call === 1 ? { ...usage, inputTokens: 4_010 } : call === 5 ? { ...usage, cachedTokens } : usage) });
    const exact = boundary(3_609);
    const exactReport = await exact.run();
    expect(exactReport.intervals[0]).toMatchObject({ intervalMinutes: 5, previousInputTokens: 4_010, cachedTokens: 3_609, cachedOfPrevious: 0.9, valid: true });
    expect(exact.lines.find((line) => line.event === 'measurement' && line.intervalMinutes === 5)).toMatchObject({ cachedOfPrevious: 0.9, valid: true });
    const below = boundary(3_608);
    const belowReport = await below.run();
    expect(belowReport.intervals[0]).toMatchObject({ intervalMinutes: 5, previousInputTokens: 4_010, cachedTokens: 3_608, valid: false });
    expect(belowReport.intervals[0]!.cachedOfPrevious).toBeLessThan(0.9);
    expect(below.lines.find((line) => line.event === 'measurement' && line.intervalMinutes === 5)).toMatchObject({ valid: false });
  });

  it('avisa quando o cache não foi monótono (um intervalo menor sem cache e um maior com) e mesmo assim usa o maior válido', async () => {
    // A releitura de 15 minutos (chamada 6) perde o cache; as de 30 e 60 leem. É o cache de melhor esforço: o T segue o maior válido, nunca o primeiro que falhou.
    const { run, lines } = setup(400, { mutate: (usage, call) => (call === 6 ? { ...usage, cachedTokens: 0 } : usage) });
    const report = await run();
    expect(report.intervals.map((entry) => [entry.intervalMinutes, entry.valid])).toEqual([[5, true], [15, false], [30, true], [60, true], [90, true], [120, true]]);
    expect(report).toMatchObject({ largestValidMinutes: 120, ttlMinutes: 130, fixed: true, nonMonotonic: true });
    expect(lines.at(-1)).toMatchObject({ event: 'result', nonMonotonic: true });
  });

  it('falha do provedor reprova sem fixar T: a primeira falha sobe, as outras cadeias param sem novas chamadas e nenhum resultado é emitido', async () => {
    // Chamadas 1 a 4 são as escritas (juntas); a 5ª é a releitura de 5 minutos.
    const early = setup(400, { before: (call) => { if (call === 5) throw new Error('queda de rede'); } });
    await expect(early.run()).rejects.toThrow('queda de rede');
    expect(early.calls).toHaveLength(5);
    expect(early.clock.pending()).toBe(0); // as esperas das outras cadeias foram desfeitas, nada fica pendurado
    expect(early.lines.some((line) => line.event === 'result' || line.event === 'measurement')).toBe(false);

    // Falha na releitura de 60 minutos (8ª chamada): os intervalos que já terminaram ficam na saída, as cadeias extras nunca abrem e T não é fixado.
    const late = setup(400, { before: (call) => { if (call === 8) throw new Error('queda de rede'); } });
    await expect(late.run()).rejects.toThrow('queda de rede');
    expect(late.calls).toHaveLength(8);
    expect(late.lines.filter((line) => line.event === 'measurement').map((line) => line.intervalMinutes)).toEqual([5, 15, 30]);
    expect(late.lines.some((line) => line.event === 'result')).toBe(false);
  });

  it('número que o provedor não informou reprova a sonda em vez de virar intervalo inválido que baixaria T', async () => {
    const withoutCache = setup(400, { mutate: (usage, call) => (call === 5 ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : usage) });
    await expect(withoutCache.run()).rejects.toMatchObject({ code: 'PROVIDER_CACHE_TTL_UNMEASURED' });
    const withoutUsage = setup(400, { mutate: (usage, call) => (call === 1 ? {} : usage) });
    await expect(withoutUsage.run()).rejects.toBeInstanceOf(ProbeError);
    expect(withoutUsage.lines.some((line) => line.event === 'result')).toBe(false);
  });

  it('regra de T provada em todas as combinações de intervalos válidos: nunca abaixo do maior válido, sempre com a folga, sem válido não fixa', () => {
    const grid = [5, 15, 30, 60, 90, 120];
    for (let mask = 0; mask < 1 << grid.length; mask += 1) {
      const intervals = grid.map((intervalMinutes, index) => ({ intervalMinutes, valid: (mask & (1 << index)) !== 0 }));
      const valid = intervals.filter((entry) => entry.valid).map((entry) => entry.intervalMinutes);
      const decision = computeTtl(intervals);
      if (valid.length === 0) {
        expect(decision, `máscara ${mask}`).toEqual({ largestValidMinutes: null, ttlMinutes: 60, fixed: false, nonMonotonic: false });
        continue;
      }
      const largest = Math.max(...valid);
      expect(decision.fixed, `máscara ${mask}`).toBe(true);
      expect(decision.largestValidMinutes).toBe(largest);
      expect(decision.ttlMinutes).toBe(largest + 10);
      expect(decision.ttlMinutes).toBeGreaterThanOrEqual(largest);
      expect(decision.nonMonotonic).toBe(intervals.some((entry) => !entry.valid && entry.intervalMinutes < largest));
    }
  });
});

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// CLI e arquivo de resultado (em processo, com provedor falso e relógio virtual)
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

describe('CLI da sonda e arquivo de resultado (em processo)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'aion-cache-ttl-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  /** Roda a CLI em processo com provedor falso e relógio virtual, capturando a saída e o código de saída. */
  async function cli(args: string[], ttlMinutes: number, env: Record<string, string | undefined> = { AION_VALIDATE_PROVIDER_KEY: KEY }, hooks: Parameters<typeof setup>[1] = {}) {
    const { clock, provider, calls } = setup(ttlMinutes, hooks);
    const lines: Record<string, unknown>[] = [];
    const errors: Record<string, unknown>[] = [];
    const exit = clock.drive(runCli(args, env, { provider, sleep: clock.sleep, now: clock.now, write: (line) => lines.push(line), writeError: (line) => errors.push(line) }));
    return { code: await exit, lines, errors, calls };
  }
  /** O arquivo de resultado existe? Falha ou argumento inválido não pode deixar arquivo nenhum. */
  const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

  it('com T fixado grava o resultado por intervalo e o T no arquivo, sai com 0 e não vaza chave nem conversa', async () => {
    const out = join(dir, 'cache-ttl.md');
    const result = await cli(['--out', out], 100);
    expect(result.code).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.calls).toHaveLength(12);
    const file = await readFile(out, 'utf8');
    // Uma linha por intervalo com os tokens de entrada e em cache da releitura (os mesmos números que a saída emitiu), a data da medição e o T fixado.
    const measurements = result.lines.filter((line) => line.event === 'measurement');
    expect(measurements).toHaveLength(6);
    for (const line of measurements) {
      const row = file.split('\n').find((candidate) => candidate.startsWith(`| ${line.intervalMinutes} |`));
      expect(row, `intervalo ${String(line.intervalMinutes)}`).toBeDefined();
      const cells = row!.split('|').map((cell) => cell.trim());
      expect(cells[3]).toBe((line.previousInputTokens as number).toLocaleString('pt-BR'));
      expect(cells[4]).toBe((line.inputTokens as number).toLocaleString('pt-BR'));
      expect(cells[5]).toBe((line.cachedTokens as number).toLocaleString('pt-BR'));
      expect(cells[7]).toBe(line.valid ? 'sim' : 'não');
    }
    expect(file).toContain('2026-10-18');
    expect(file).toContain('T fixado: 100 minutos');
    expectOnlyIdsAndNumbers(result.lines);
    for (const forbidden of [KEY, ...FORBIDDEN]) expect(JSON.stringify(result.lines) + file).not.toContain(forbidden);
  });

  it('sem intervalo válido grava os números, não fixa T (continua em 60) e sai com 1', async () => {
    const out = join(dir, 'cache-ttl.md');
    const result = await cli(['--out', out], 2);
    expect(result.code).toBe(1);
    expect(result.errors).toEqual([{ code: 'PROVIDER_CACHE_TTL_INCONCLUSIVE', message: expect.any(String), exitCode: 1 }]);
    expect(result.calls).toHaveLength(8);
    expect(result.lines.at(-1)).toMatchObject({ event: 'result', fixed: false, ttlMinutes: 60, largestValidMinutes: null });
    const file = await readFile(out, 'utf8');
    expect(file).toContain('T não fixado');
    expect(file).not.toContain('T fixado');
  });

  it('falha do provedor sai com 1 e não grava arquivo nenhum', async () => {
    const out = join(dir, 'cache-ttl.md');
    const result = await cli(['--out', out], 400, undefined, { before: (call) => { if (call === 6) throw new Error('queda de rede'); } });
    expect(result.code).toBe(1);
    expect(result.errors).toEqual([{ code: 'PROVIDER_CACHE_TTL_FAILED', message: expect.any(String), exitCode: 1 }]);
    expect(await exists(out)).toBe(false);
  });

  it('confere argumentos, chave e caminho de saída ANTES de qualquer chamada ao provedor', async () => {
    const blocker = join(dir, 'arquivo.txt');
    await writeFile(blocker, 'não é diretório');
    const cases: [string, string[], Record<string, string | undefined>, string][] = [
      ['opção desconhecida', ['--rapido'], { AION_VALIDATE_PROVIDER_KEY: KEY }, 'PROVIDER_CACHE_TTL_INVALID_ARGUMENT'],
      ['--out sem valor', ['--out'], { AION_VALIDATE_PROVIDER_KEY: KEY }, 'PROVIDER_CACHE_TTL_INVALID_ARGUMENT'],
      ['saída sob um arquivo', ['--out', join(blocker, 'cache-ttl.md')], { AION_VALIDATE_PROVIDER_KEY: KEY }, 'PROVIDER_CACHE_TTL_INVALID_ARGUMENT'],
      ['sem chave', ['--out', join(dir, 'cache-ttl.md')], {}, 'PROVIDER_CACHE_TTL_FAILED'],
      ['chave em branco', ['--out', join(dir, 'cache-ttl.md')], { AION_VALIDATE_PROVIDER_KEY: '   ' }, 'PROVIDER_CACHE_TTL_FAILED'],
    ];
    for (const [name, args, env, code] of cases) {
      const result = await cli(args, 400, env);
      expect(result.code, name).toBe(1);
      expect(result.errors, name).toEqual([{ code, message: expect.any(String), exitCode: 1 }]);
      expect(result.calls, name).toHaveLength(0);
      expect(result.lines, name).toEqual([]);
    }
    expect(await exists(join(dir, 'cache-ttl.md'))).toBe(false);
  });
});

describe('CLI da sonda (processo real)', () => {
  /** Executa a CLI como processo, com a chave só no ambiente do processo (nunca de `.env.provider`: sem `--env-file`). */
  const run = (args: string[], env: Record<string, string | undefined>): Promise<{ code: number; stdout: string; stderr: string }> => new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', 'tests/support/validate-cache-ttl.ts', ...args], {
      cwd: ROOT, timeout: 60_000,
      env: { ...process.env, AION_VALIDATE_PROVIDER_KEY: undefined, AION_OPENCODE_GO_BASE_URL: undefined, ...env },
    }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }));
  });

  it('falha sem chave, com chave em branco e com argumento inválido antes de chamar o provedor, com código estável, saída vazia e sem segredo', async () => {
    const upstreams = await startFakeUpstreams();
    try {
      const base = { AION_OPENCODE_GO_BASE_URL: upstreams.opencodeGoBaseUrl };
      const cases: [Record<string, string | undefined>, string[], string][] = [
        [{ ...base, AION_VALIDATE_PROVIDER_KEY: undefined }, [], 'PROVIDER_CACHE_TTL_FAILED'],
        [{ ...base, AION_VALIDATE_PROVIDER_KEY: '   ' }, [], 'PROVIDER_CACHE_TTL_FAILED'],
        [{ ...base, AION_VALIDATE_PROVIDER_KEY: KEY }, ['--rapido'], 'PROVIDER_CACHE_TTL_INVALID_ARGUMENT'],
      ];
      for (const [env, args, code] of cases) {
        const result = await run(args, env);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        // O texto bruto do stderr entra na comparação quando não é JSON, para uma falha de carga do processo aparecer na mensagem do teste.
        expect(result.stderr.startsWith('{') ? JSON.parse(result.stderr) : result.stderr).toEqual({ code, message: expect.any(String), exitCode: 1 });
        expect(result.stdout + result.stderr).not.toContain(KEY);
      }
      expect(upstreams.requests).toHaveLength(0);
    } finally { await upstreams.stop(); }
  });
});

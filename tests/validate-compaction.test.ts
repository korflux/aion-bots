// Prova da sonda de compactação (phase 9, T8) no modo offline: o motor, o PostgreSQL e a contabilidade são os reais; só o provedor é roteirizado (cache coerente com o
// prefixo dos pedidos) ou o falso de `@aion/core/testing`. Nenhuma chamada sai da máquina. A rodada real com o DeepSeek é a segunda metade da prova da T8 e roda à parte
// (`corepack pnpm validate:compaction`, com a chave do dono).
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFakeUpstreams } from '@aion/core/testing';
import { describe, expect, inject, it } from 'vitest';
import { buildReport, callLine, parseOptions, resultLine, runProbe, type ProbeOptions, type RunFacts, type UsageRow } from './support/validate-compaction';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OPTIONS: ProbeOptions = { mode: 'deterministic', calls: 40, resultChars: 8_000, baselineUncached: null };
const RUN: RunFacts = { id: '1', status: 'completed', failureCode: null, toolCalls: 40 };

/** Linha de ledger sintética: `cached` em branco = o provedor não informou cache. */
const row = (purpose: UsageRow['purpose'], input: number, cached: number | null, output = 10, outcome: string | null = null): UsageRow => ({ purpose, state: 'completed', outcome, inputTokens: input, cachedTokens: cached, outputTokens: output });

/** Texto que a sonda nunca pode deixar chegar à saída: o enunciado da rodada, o enchimento e o checkpoint roteirizado. */
const FORBIDDEN = ['sonda técnica', 'ferramenta probe_echo', 'eco n=', 'Checkpoint sintético', 'Nada.'];

/** Toda linha de saída é só identificadores e números: nenhum valor de texto livre (espaços, frases) passa por este formato. */
function expectOnlyIdsAndNumbers(lines: Record<string, unknown>[]): void {
  const walk = (value: unknown, path: string): void => {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return;
    if (typeof value === 'string') { expect(value, path).toMatch(/^[A-Za-z0-9_.:-]{1,64}$/); return; }
    if (Array.isArray(value)) { value.forEach((item, index) => walk(item, `${path}[${index}]`)); return; }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) walk(item, `${path}.${key}`);
  };
  lines.forEach((line, index) => walk(line, `linha ${index}`));
}

describe('contabilidade da sonda', () => {
  it('conta as chamadas de resumo, soma entrada e saída com os resumos e confere cache só entre compactações', () => {
    // 1: etapa inicial (sem cache, isento). 2 e 3: intervalo sem compactação. Resumo. 4: primeira depois da compactação (isenta). 5: intervalo.
    const rows = [row('main', 1000, 0), row('main', 1500, 900), row('main', 2000, 1400), row('summary', 2100, 1000, 300, 'applied'), row('main', 1200, 0), row('main', 1500, 1100, 20)];
    const report = buildReport({ mode: 'deterministic', rows, run: RUN, options: { ...OPTIONS, baselineUncached: 5_260 } });
    expect(report.calls.map((call) => [call.purpose, call.step, call.summaryIndex, call.compactedBefore])).toEqual([
      ['main', 1, null, false], ['main', 2, null, false], ['main', 3, null, false], ['summary', null, 1, false], ['main', 4, null, true], ['main', 5, null, false],
    ]);
    expect([report.mainCalls, report.summaryCalls, report.summaryApplied]).toEqual([5, 1, 1]);
    expect(report.main).toEqual({ inputTokens: 7200, cachedTokens: 3400, outputTokens: 60 });
    expect(report.summary).toEqual({ inputTokens: 2100, cachedTokens: 1000, outputTokens: 300 });
    expect(report.total).toEqual({ inputTokens: 9300, cachedTokens: 4400, outputTokens: 360, uncachedInputTokens: 4900, uncachedTokens: 5260, tokens: 9660 });
    expect(report.criteria).toMatchObject({ runCompleted: true, callsDone: true, compacted: true, summaryCallsAtMost2: true, cachedBetweenCompactions: true, cachedChecked: 3, cachedMissing: 0, uncachedAtMostBaseline: true, passed: true });
    // C4 mede entrada não cacheada + saída (4.900 + 360 = 5.260); o total bruto (9.660) é só informativo. Referência 1 token abaixo reprova; sem referência, C4 não se aplica.
    expect(buildReport({ mode: 'deterministic', rows, run: RUN, options: { ...OPTIONS, baselineUncached: 5_259 } }).criteria).toMatchObject({ uncachedAtMostBaseline: false, passed: false });
    expect(buildReport({ mode: 'deterministic', rows, run: RUN, options: OPTIONS }).criteria.uncachedAtMostBaseline).toBeNull();
  });

  it('reprova cache ausente dentro de um intervalo, três resumos, ausência de compactação, execução sem sucesso e rodada incompleta', () => {
    const base = [row('main', 1000, 0), row('main', 1500, 900), row('summary', 2000, 0, 200, 'applied'), row('main', 1200, 0), row('main', 1500, 1100)];
    const verdict = (rows: UsageRow[], run = RUN) => buildReport({ mode: 'deterministic', rows, run, options: OPTIONS }).criteria;
    expect(verdict(base).passed).toBe(true);
    // O intervalo perdeu o cache (e o provedor que não informa cache também reprova: ausente não é maior que zero).
    expect(verdict([...base.slice(0, 4), row('main', 1500, 0)])).toMatchObject({ cachedBetweenCompactions: false, cachedMissing: 1, passed: false });
    expect(verdict([...base.slice(0, 4), row('main', 1500, null)])).toMatchObject({ cachedBetweenCompactions: false, passed: false });
    // Três chamadas de resumo, mesmo com tentativas recusadas, passam do máximo de C1.
    expect(verdict([...base, row('summary', 1, 0, 1, 'empty'), row('summary', 1, 0, 1, 'applied')])).toMatchObject({ summaryCallsAtMost2: false, passed: false });
    // Sem nenhum resumo a sonda não forçou a compactação e não prova C1.
    expect(verdict(base.filter((entry) => entry.purpose === 'main'))).toMatchObject({ compacted: false, passed: false });
    expect(verdict(base, { ...RUN, status: 'failed', failureCode: 'CONTEXT_TOO_LARGE' })).toMatchObject({ runCompleted: false, passed: false });
    expect(verdict(base, { ...RUN, toolCalls: 39 })).toMatchObject({ callsDone: false, passed: false });
  });

  it('um resumo recusado não é compactação: reprova a sonda e não isenta a etapa seguinte da regra de cache', () => {
    const report = (rows: UsageRow[]) => buildReport({ mode: 'deterministic', rows, run: RUN, options: OPTIONS });
    // Só um resumo `empty`, nenhum aplicado: o histórico não mudou, então a sonda não forçou compactação mesmo com uma chamada de resumo registrada.
    const refused = report([row('main', 1000, 0), row('main', 1500, 900), row('summary', 2000, 0, 200, 'empty'), row('main', 1700, 1400)]);
    expect([refused.summaryCalls, refused.summaryApplied]).toEqual([1, 0]);
    expect(refused.calls.map((call) => call.compactedBefore)).toEqual([false, false, false, false]);
    expect(refused.criteria).toMatchObject({ compacted: false, summaryCallsAtMost2: true, cachedBetweenCompactions: true, cachedChecked: 2, passed: false });
    // A etapa depois do resumo recusado segue conferida: sem cache nela, o prefixo mudou sem compactação e C1 reprova pelo cache também.
    expect(report([row('main', 1000, 0), row('main', 1500, 900), row('summary', 2000, 0, 200, 'output_limit'), row('main', 1700, 0)]).criteria).toMatchObject({ compacted: false, cachedBetweenCompactions: false, cachedMissing: 1, passed: false });
    // Recusado seguido de aplicado (duas tentativas, no máximo): conta como compactada, e a isenção de cache é só da etapa depois do resumo aplicado.
    const retried = report([row('main', 1000, 0), row('main', 1500, 900), row('summary', 2000, 0, 200, 'empty'), row('summary', 2000, 0, 300, 'applied'), row('main', 1200, 0), row('main', 1500, 1100)]);
    expect([retried.summaryCalls, retried.summaryApplied]).toEqual([2, 1]);
    expect(retried.calls.filter((call) => call.purpose === 'main').map((call) => call.compactedBefore)).toEqual([false, false, true, false]);
    expect(retried.criteria).toMatchObject({ compacted: true, summaryCallsAtMost2: true, cachedBetweenCompactions: true, passed: true });
    // Sem leitura dos checkpoints, C8 não se aplica: fica nulo e fora de `passed` (as contas puras de C1 acima seguem como eram).
    expect(retried.criteria).toMatchObject({ checkpointAtMostTarget: null, noSecondAttempt: null });
    expect(retried.checkpointChars).toEqual([]);
  });

  it('C8 (phase 11): o checkpoint de no máximo 6.000 caracteres e sem segunda tentativa aprova; acima do alvo, sem leitura ou com tentativa extra reprova', () => {
    const applied = [row('main', 1000, 0), row('main', 1500, 900), row('summary', 2000, 0, 200, 'applied'), row('main', 1200, 0), row('main', 1500, 1100), row('summary', 2400, 1000, 220, 'applied'), row('main', 1300, 0), row('main', 1600, 1200)];
    const verdict = (rows: UsageRow[], checkpointChars: number[]) => buildReport({ mode: 'deterministic', rows, run: RUN, options: OPTIONS, checkpointChars });
    // As duas revisões (a segunda em modo atualizar) dentro do alvo: aprova, e o relatório carrega os tamanhos na ordem recebida.
    const approved = verdict(applied, [4_800, 5_900]);
    expect(approved.checkpointChars).toEqual([4_800, 5_900]);
    expect(approved.criteria).toMatchObject({ checkpointAtMostTarget: true, noSecondAttempt: true, passed: true });
    // O limite é inclusivo (6.000 passa) e um caractere a mais reprova só C8: os demais critérios seguem verdes.
    expect(verdict(applied, [6_000]).criteria).toMatchObject({ checkpointAtMostTarget: true, passed: true });
    expect(verdict(applied, [5_000, 6_001]).criteria).toMatchObject({ checkpointAtMostTarget: false, noSecondAttempt: true, runCompleted: true, compacted: true, cachedBetweenCompactions: true, passed: false });
    // Leitura feita sem nenhuma revisão não prova o tamanho.
    expect(verdict(applied, []).criteria).toMatchObject({ checkpointAtMostTarget: false, passed: false });
    // Um resumo recusado antes do aplicado é a segunda tentativa que C8 não aceita, mesmo dentro dos dois resumos de C1 e com o checkpoint pequeno.
    const retried = verdict([row('main', 1000, 0), row('main', 1500, 900), row('summary', 2000, 0, 200, 'empty'), row('summary', 2000, 0, 300, 'applied'), row('main', 1200, 0), row('main', 1500, 1100)], [4_000]);
    expect(retried.criteria).toMatchObject({ summaryCallsAtMost2: true, checkpointAtMostTarget: true, noSecondAttempt: false, passed: false });
  });
});

describe('rodada offline', () => {
  it('40 chamadas de eco passam do limiar dentro da rodada, o motor compacta no máximo duas vezes e a contabilidade bate com o que o provedor informou', async () => {
    const emitted: Record<string, unknown>[] = [];
    const { report, observed } = await runProbe(OPTIONS, { adminUrl: inject('adminDatabaseUrl'), apiKey: 'valid-compaction-chave-QWE7', emit: (line) => emitted.push(line) });
    expect(report.run).toMatchObject({ status: 'completed', failureCode: null, toolCalls: 40 });
    expect(report.summaryCalls).toBeGreaterThanOrEqual(1);
    expect(report.summaryCalls).toBeLessThanOrEqual(2);
    expect(report.criteria).toMatchObject({ runCompleted: true, callsDone: true, compacted: true, summaryCallsAtMost2: true, cachedBetweenCompactions: true, cachedMissing: 0, checkpointAtMostTarget: true, noSecondAttempt: true, passed: true });
    // C8: o tamanho de cada revisão do checkpoint chega só como número, e o da última bate com o texto que o provedor roteirizado devolveu (a saída dele é `ceil(caracteres / 3,5)` tokens).
    expect(report.checkpointChars.length).toBeGreaterThanOrEqual(1);
    expect(report.checkpointChars.length).toBeLessThanOrEqual(report.summaryApplied);
    expect(report.checkpointChars.every((chars) => chars > 0 && chars <= 6_000)).toBe(true);
    expect(Math.ceil(report.checkpointChars.at(-1)! / 3.5)).toBe(observed!.filter((call) => call.purpose === 'summary').at(-1)!.outputTokens);

    // Fonte independente do banco: o provedor roteirizado. As chamadas, as somas e a contagem de resumos precisam ser as mesmas do ledger do motor.
    expect(observed).not.toBeNull();
    const told = (purpose: 'main' | 'summary') => observed!.filter((call) => call.purpose === purpose);
    const totalOf = (calls: typeof observed, key: 'inputTokens' | 'cachedTokens' | 'outputTokens') => calls!.reduce((sum, call) => sum + call[key], 0);
    expect(report.mainCalls).toBe(told('main').length);
    expect(report.mainCalls).toBe(41); // 40 chamadas de ferramenta e a resposta final
    expect(report.summaryCalls).toBe(told('summary').length);
    expect(report.main).toEqual({ inputTokens: totalOf(told('main'), 'inputTokens'), cachedTokens: totalOf(told('main'), 'cachedTokens'), outputTokens: totalOf(told('main'), 'outputTokens') });
    expect(report.summary).toEqual({ inputTokens: totalOf(told('summary'), 'inputTokens'), cachedTokens: totalOf(told('summary'), 'cachedTokens'), outputTokens: totalOf(told('summary'), 'outputTokens') });
    expect(report.total.tokens).toBe(totalOf(observed, 'inputTokens') + totalOf(observed, 'outputTokens'));
    expect(report.total.uncachedInputTokens).toBe(totalOf(observed, 'inputTokens') - totalOf(observed, 'cachedTokens'));
    // C4 (decisão do dono): entrada não cacheada + saída, resumos incluídos; o total bruto acima fica só como informação.
    expect(report.total.uncachedTokens).toBe(totalOf(observed, 'inputTokens') - totalOf(observed, 'cachedTokens') + totalOf(observed, 'outputTokens'));
    // Etapa a etapa, na ordem: o que o ledger registrou é o que o provedor disse.
    expect(report.calls.map((call) => [call.purpose, call.inputTokens, call.cachedTokens, call.outputTokens])).toEqual(observed!.map((call) => [call.purpose, call.inputTokens, call.cachedTokens, call.outputTokens]));

    // O cache aparece em toda etapa dentro de um intervalo e cai na primeira depois de uma compactação (o prefixo muda).
    const main = report.calls.filter((call) => call.purpose === 'main');
    expect(main.filter((call) => call.step! > 1 && !call.compactedBefore).every((call) => call.cachedTokens! > 0)).toBe(true);
    expect(main.filter((call) => call.compactedBefore).every((call) => call.cachedTokens! < call.inputTokens! * 0.5)).toBe(true);
    expect(main.filter((call) => call.compactedBefore)).toHaveLength(report.summaryCalls);

    // Saída: uma linha por chamada fechada e, só no fim, o resultado; tudo identificador ou número, e nada da conversa nem a chave.
    expect(emitted.map((line) => line.event)).toEqual(report.calls.map(() => 'call'));
    const lines = [...emitted, resultLine(report)];
    expect(emitted).toEqual(report.calls.map((call) => callLine(report.run.id, call)));
    expectOnlyIdsAndNumbers(lines);
    const text = JSON.stringify(lines);
    for (const forbidden of [...FORBIDDEN, 'valid-compaction-chave-QWE7']) expect(text).not.toContain(forbidden);
  }, 120_000);
});

describe('CLI da sonda', () => {
  /** Executa a CLI como processo, com o PostgreSQL de teste do projeto e o ambiente controlado pelo teste. */
  const run = (args: string[], env: Record<string, string | undefined>): Promise<{ code: number; stdout: string; stderr: string }> => new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', 'tests/support/validate-compaction.ts', ...args], {
      cwd: ROOT, timeout: 100_000,
      env: { ...process.env, AION_TEST_DATABASE_URL: inject('adminDatabaseUrl'), AION_VALIDATE_PROVIDER_KEY: undefined, AION_OPENCODE_GO_BASE_URL: undefined, ...env },
    }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }));
  });

  it('modo real sem chave e argumento inválido falham antes de qualquer banco ou provedor, com código estável e saída não-zero', async () => {
    const missing = await run([], {});
    expect(missing.code).toBe(1);
    expect(missing.stdout).toBe('');
    expect(JSON.parse(missing.stderr)).toEqual({ code: 'COMPACTION_KEY_MISSING', message: expect.stringContaining('AION_VALIDATE_PROVIDER_KEY'), exitCode: 1 });
    const blank = await run(['--mode', 'real'], { AION_VALIDATE_PROVIDER_KEY: '   ' });
    expect(JSON.parse(blank.stderr).code).toBe('COMPACTION_KEY_MISSING');
    for (const args of [['--mode', 'paired'], ['--calls', '0'], ['--calls', '51'], ['--result-chars', '9000'], ['--baseline-uncached', 'abc'], ['--baseline-total', '500'], ['--mode'], ['--outra', '1'], ['--calls', '5', '--calls', '6']]) {
      const invalid = await run(args, { AION_VALIDATE_PROVIDER_KEY: 'chave-que-nao-deve-aparecer' });
      expect(invalid.code, args.join(' ')).toBe(1);
      expect(JSON.parse(invalid.stderr).code).toBe('COMPACTION_ARGUMENT_INVALID');
      expect(invalid.stdout + invalid.stderr).not.toContain('chave-que-nao-deve-aparecer');
    }
    expect(parseOptions(['--mode', 'deterministic', '--calls', '12', '--result-chars', '1000', '--baseline-uncached', '500'])).toEqual({ mode: 'deterministic', calls: 12, resultChars: 1000, baselineUncached: 500 });
    expect(parseOptions([])).toMatchObject({ mode: 'real', calls: 40 });
  });

  it('modo real contra o provedor falso: lê a chave do ambiente, grava só no banco efêmero e nunca a imprime; a rodada curta não força compactação e reprova', async () => {
    const upstreams = await startFakeUpstreams();
    const key = 'valid-sonda-chave-ABC123';
    try {
      const result = await run(['--calls', '1'], { AION_VALIDATE_PROVIDER_KEY: key, AION_OPENCODE_GO_BASE_URL: upstreams.opencodeGoBaseUrl });
      // O provedor falso responde texto na primeira chamada (sem eco): rodada completa, uma etapa, nenhum resumo; a sonda não prova C1 e sai com 1.
      expect(result.code, result.stderr).toBe(1);
      const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines.map((line) => line.event)).toEqual(['call', 'result']);
      expect(lines[1]).toMatchObject({ mode: 'real', mainCalls: 1, summaryCalls: 0, run: { status: 'completed', failureCode: null }, criteria: { runCompleted: true, compacted: false, passed: false } });
      expectOnlyIdsAndNumbers(lines);
      expect(result.stdout + result.stderr).not.toContain(key);
      // O pedido da conversa chegou ao provedor com a chave só no cabeçalho de autorização (nunca no corpo).
      const chat = upstreams.requests.filter((request) => request.body !== undefined && request.path.endsWith('/chat/completions') && (request.body.messages as { role?: string }[])[0]?.role === 'system');
      expect(chat).toHaveLength(1);
      expect(JSON.stringify(chat[0]!.body)).not.toContain(key);
    } finally { await upstreams.stop(); }
  });

  it('modo deterministic pela CLI conclui com sucesso, uma linha por chamada e o resultado no fim', async () => {
    const result = await run(['--mode', 'deterministic'], {});
    expect(result.code, result.stderr).toBe(0);
    const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.slice(0, -1).every((line) => line.event === 'call')).toBe(true);
    expect(lines.at(-1)).toMatchObject({ event: 'result', mode: 'deterministic', model: 'deepseek-v4.1-flash', window: 65536, run: { status: 'completed', toolCalls: 40 }, checkpointChars: expect.any(Array), criteria: { checkpointAtMostTarget: true, noSecondAttempt: true, passed: true } });
    expectOnlyIdsAndNumbers(lines);
    for (const forbidden of FORBIDDEN) expect(result.stdout + result.stderr).not.toContain(forbidden);
  }, 120_000);
});

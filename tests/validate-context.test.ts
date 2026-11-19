// Provas comportamentais do harness público: fixtures pequenas, sem serviço, credencial ou modelo real.
import { spawnSync } from 'node:child_process';
import { SUMMARY_MAX_CALLS } from '@aion/core';
import { describe, expect, it } from 'vitest';
import { BEHAVIORS, LIMITS, WINDOWS, checkObservedBudgets, compareCampaign, manifestHash, runDeterministic, summarizeLedger, type ArmEvidence, type CallEvent, type CampaignEvidence, type Manifest, type PairEvidence, type PartialNegativeEvidence } from './support/context-validation';
import { parseOptions, runValidation } from './support/validate-context';

/** Manifesto sintético congelado permite variar somente o runtime e a janela entre braços. */
function manifest(): Manifest {
  return { sourceHash: 'a'.repeat(64), promptHash: 'b'.repeat(64), initialStateHash: 'c'.repeat(64), baselineRuntimeHash: 'd'.repeat(64), afterRuntimeHash: 'e'.repeat(64), pythonParityHash: 'f'.repeat(64), preservationHash: '1'.repeat(64), frozenAt: 0, principalScenario: 'synthetic-sequential-tools' };
}

/** Uma inferência completa inclui identidade em ambos eventos e cache já contido na entrada. */
function call(executionId: string, arm: 'baseline' | 'after', index: number, at: number, input: number, kind: 'main' | 'summary' | 'retry' | 'recall' = 'main'): CallEvent[] {
  const identity = { executionId, arm, callId: `${executionId}-${index}`, kind, phase: 'execution' as const, ...(kind === 'summary' ? { preparationId: `${executionId}-prepare` } : {}), ...(kind === 'retry' ? { retryOf: 'main' as const } : {}) };
  return [{ ...identity, type: 'start', at }, { ...identity, type: 'end', at: at + 1, status: 200, complete: true, usage: { input, output: 10, cached: 20 } }];
}

/** Snapshot exato conserva células decimais, IDs, versões e estrutura; replay não cria registros novos. */
function arm(pairId: string, name: 'baseline' | 'after', window: typeof WINDOWS[number], at: number): ArmEvidence {
  const source = manifest(), armId = `${pairId}-${name}`, executionId = `${armId}-run`;
  const snapshot = { records: [{ id: `${executionId}-record`, version: 3, cells: { amount: '1.01', paid: false } }], schemas: ['amount', 'paid'], relations: [], formulas: { total: 'SUM(amount)' }, views: ['unpaid'] };
  return {
    armId, executions: [{ executionId, phase: 'execution', startedAt: at, endedAt: at + 4 }], window: name === 'baseline' ? null : window, effectiveWindow: window, capacityConfirmed: true,
    manifestHash: manifestHash(source), sourceHash: source.sourceHash, promptHash: source.promptHash, initialStateHash: source.initialStateHash, pythonParityHash: source.pythonParityHash,
    runtimeHash: name === 'baseline' ? source.baselineRuntimeHash : source.afterRuntimeHash, preservationBeforeHash: source.preservationHash, preservationAfterHash: source.preservationHash,
    startedAt: at, endedAt: at + 4,
    completed: true, ledger: name === 'baseline' ? call(executionId, name, 0, at, 300) : [...call(executionId, name, 0, at, 100), ...call(executionId, name, 1, at + 2, 50, 'summary')],
    expected: structuredClone(snapshot), final: structuredClone(snapshot), replay: structuredClone(snapshot),
    result: { expected: { digest: 'synthetic-exact', count: 1 }, observed: { digest: 'synthetic-exact', count: 1 } },
    quality: BEHAVIORS.map((behavior) => ({ behavior, expected: 'same-direction', observed: 'same-direction' })), duplicatedEffects: false,
  };
}

/** Par usa destinos novos e o mesmo oracle lógico, sem exigir endpoint de objetivo inexistente no baseline. */
function pair(id: string, window: typeof WINDOWS[number], at: number): PairEvidence {
  return { pairId: id, baseline: arm(id, 'baseline', window, at), after: arm(id, 'after', window, at + 4) };
}

/** Piloto serve como primeira amostra 32k, sem repetir IDs no agregado/campanha. */
function campaign(full = false): CampaignEvidence & { pilot: PairEvidence } {
  return {
    manifest: manifest(), guard: { artifactHash: '2'.repeat(64), preDispatch: true, externalDispatcher: true }, pilot: pair('pilot', 32768, 0),
    repetitions: full ? [pair('32k-2', 32768, 10), pair('32k-3', 32768, 20), ...[65536, 131072].flatMap((window, wi) => [1, 2, 3].map((n) => pair(`${window}-${n}`, window as typeof WINDOWS[number], 30 + wi * 30 + n * 10)))] : [], negatives: [],
  };
}

describe('validate-context offline', () => {
  /** Retira dados não observados: um baseline interrompido não finge snapshot/oracle/replay nem braço novo. */
  const partial = (): PartialNegativeEvidence => {
    const { completed: _completed, expected: _expected, final: _final, replay: _replay, result: _result, quality: _quality, duplicatedEffects: _duplicated, ...observed } = arm('negative', 'baseline', 32768, 100);
    return { kind: 'partial', pairId: 'negative', requestedWindow: 32768, baseline: { ...observed, outcome: 'failed' }, after: null };
  };

  /** Intervalo anterior realista: amostras novas começam depois do encerramento do negativo sintético. */
  const withHistoricalNegative = () => {
    const evidence = campaign(true);
    for (const pair of [evidence.pilot, ...evidence.repetitions]) for (const arm of [pair.baseline, pair.after]) {
      arm.startedAt += 200; arm.endedAt += 200;
      arm.executions.forEach((run) => { run.startedAt += 200; run.endedAt += 200; });
      arm.ledger.forEach((event) => { event.at += 200; });
    }
    const negative = partial(); negative.historical = true;
    const end = negative.baseline!.ledger[1]!;
    if (end.type === 'end') end.usage.input = LIMITS.input + 1;
    evidence.negatives.push(negative);
    return { evidence, negative };
  };

  it('excesso de negativo histórico encerrado permanece diagnosticado e cobrado sem bloquear amostras novas válidas', () => {
    const { evidence, negative } = withHistoricalNegative();
    const report = compareCampaign(evidence);
    expect(report).toMatchObject({ pilotPassed: true, status: 'principal-complete', principalScenarioPassed: true, c3: false, budgetCode: null });
    expect(report.historicalBudgetDiagnostics).toEqual([{ pairId: negative.pairId, executionId: negative.baseline!.executions[0]!.executionId, code: 'EXECUTION_BUDGET_EXCEEDED' }]);
    expect(report.campaign.total).toBe(4320 + LIMITS.input + 1 + 10);
    expect(report.presets.map((preset) => preset.valid)).toEqual([3, 3, 3]);
    expect(() => checkObservedBudgets(negative.baseline!.ledger)).toThrow('EXECUTION_BUDGET_EXCEEDED');
    expect(compareCampaign({ ...evidence, pilot: null, repetitions: [] })).toMatchObject({ status: 'stopped', budgetCode: 'EXECUTION_BUDGET_EXCEEDED', c3: false });
  });

  it('excesso do piloto novo continua bloqueado e negativo rotulado histórico após seu início também bloqueia', () => {
    const current = withHistoricalNegative();
    const end = current.evidence.pilot.after.ledger[1]!; if (end.type === 'end') end.usage.input = LIMITS.input + 1;
    expect(() => compareCampaign(current.evidence)).toThrow('PILOT_EXPANSION_FORBIDDEN');
    current.evidence.repetitions = [];
    expect(compareCampaign(current.evidence)).toMatchObject({ status: 'stopped', budgetCode: 'EXECUTION_BUDGET_EXCEEDED', c3: false });
    const mislabeled = withHistoricalNegative();
    const arm = mislabeled.negative.baseline!;
    arm.startedAt += 200; arm.endedAt += 200;
    arm.executions.forEach((run) => { run.startedAt += 200; run.endedAt += 200; });
    arm.ledger.forEach((event) => { event.at += 200; });
    expect(compareCampaign(mislabeled.evidence)).toMatchObject({ status: 'stopped', budgetCode: 'EXECUTION_BUDGET_EXCEEDED', historicalBudgetDiagnostics: [], c3: false });
  });

  it('histórico não dispensa uso desconhecido, estado incerto nem teto total da campanha', () => {
    const unknown = withHistoricalNegative(), unknownEnd = unknown.negative.baseline!.ledger[1]!;
    if (unknownEnd.type === 'end') unknownEnd.usage.input = null;
    expect(compareCampaign(unknown.evidence)).toMatchObject({ status: 'stopped', principalScenarioPassed: true, budgetCode: 'CAMPAIGN_USAGE_UNKNOWN', campaign: { usageComplete: false, total: null }, c3: false });
    const unresolved = withHistoricalNegative(); unresolved.negative.baseline!.outcome = 'unknown';
    expect(compareCampaign(unresolved.evidence)).toMatchObject({ status: 'stopped', budgetCode: 'EXECUTION_BUDGET_EXCEEDED', historicalBudgetDiagnostics: [], c3: false });
    const total = withHistoricalNegative(), totalEnd = total.negative.baseline!.ledger[1]!;
    if (totalEnd.type === 'end') totalEnd.usage.input = LIMITS.campaignTotal;
    expect(compareCampaign(total.evidence)).toMatchObject({ status: 'stopped', principalScenarioPassed: true, budgetCode: 'CAMPAIGN_BUDGET_EXCEEDED', c3: false });
  });

  it('baseline negativo sem after contabiliza chamadas reais sem inventar amostra comparável', async () => {
    const negative = partial();
    const evidence: CampaignEvidence = { ...campaign(), pilot: null, negatives: [negative] };
    const report = compareCampaign(evidence);
    expect(report).toMatchObject({ status: 'stopped', pilotPassed: false, c3: false, negativeAttempts: 1, campaign: { calls: 1, total: 310 }, pairs: [{ comparable: false, valid: false, reduced: false, after: null }] });
    expect(report.presets.every((preset) => preset.attempted === 0 && preset.valid === 0)).toBe(true);
    const adapter = { async executePaired({ onCallLedger }: { onCallLedger: (event: CallEvent) => void }) { negative.baseline!.ledger.forEach(onCallLedger); return evidence; } };
    expect(await runValidation(['--mode', 'paired'], {}, adapter)).toMatchObject({ status: 'stopped', campaign: { total: 310 }, newPairIds: ['negative'] });
    await expect(runValidation(['--mode', 'paired'], {}, { async executePaired() { return evidence; } })).rejects.toThrow('ADAPTER_LEDGER_DIVERGENT');
    negative.requestedWindow = 65536;
    await expect(runValidation(['--mode', 'paired'], {}, adapter)).rejects.toThrow('ADAPTER_WINDOW_DIVERGENT');
  });

  it('parcial nunca serve como piloto/repetição e mantém manifesto, escopo, preservação e ledger obrigatórios', () => {
    const negative = partial();
    const evidence: CampaignEvidence = { ...campaign(), pilot: null, negatives: [negative] };
    evidence.pilot = negative as unknown as PairEvidence;
    expect(() => compareCampaign(evidence)).toThrow('PARTIAL_SAMPLE_FORBIDDEN');
    evidence.pilot = pair('pilot-current', 32768, 200);
    evidence.repetitions = [negative as unknown as PairEvidence];
    expect(() => compareCampaign(evidence)).toThrow('PARTIAL_SAMPLE_FORBIDDEN');
    evidence.pilot = null; evidence.repetitions = [pair('illegal', 32768, 200)];
    expect(() => compareCampaign(evidence)).toThrow('PAIR_INCOMPLETE');
    evidence.repetitions = [];
    negative.baseline!.pythonParityHash = '0'.repeat(64);
    expect(() => compareCampaign(evidence)).toThrow('MANIFEST_DIVERGENT');
    negative.baseline = partial().baseline;
    negative.baseline!.preservationAfterHash = '0'.repeat(64);
    expect(() => compareCampaign(evidence)).toThrow('PRESERVATION_DIVERGENT');
    negative.baseline = partial().baseline;
    negative.baseline!.ledger = negative.baseline!.ledger.map((event) => ({ ...event, arm: 'after' }));
    expect(() => compareCampaign(evidence)).toThrow('LEDGER_SCOPE_INVALID');
    negative.baseline = partial().baseline;
    negative.baseline!.ledger = [];
    expect(() => compareCampaign(evidence)).toThrow('PARTIAL_OBSERVATION_REQUIRED');
    negative.baseline = null;
    expect(() => compareCampaign(evidence)).toThrow('PAIR_INCOMPLETE');
  });

  it('negativo parcial com uso pendente permanece desconhecido e entra no teto integral de campanha', () => {
    const negative = partial();
    const evidence: CampaignEvidence = { ...campaign(), pilot: null, negatives: [negative] };
    negative.baseline!.ledger.pop();
    expect(compareCampaign(evidence)).toMatchObject({ budgetCode: 'CAMPAIGN_USAGE_UNKNOWN', campaign: { calls: 1, total: null } });
    negative.baseline = partial().baseline;
    const own = negative.baseline!;
    own.executions = Array.from({ length: 13 }, (_, index) => ({ executionId: `partial-${index}`, phase: 'execution', startedAt: 100 + index * 2, endedAt: 101 + index * 2 }));
    own.endedAt = own.executions.at(-1)!.endedAt;
    own.ledger = own.executions.flatMap((run) => call(run.executionId, 'baseline', 0, run.startedAt, 240_000));
    expect(compareCampaign(evidence)).toMatchObject({ budgetCode: 'CAMPAIGN_BUDGET_EXCEEDED', c3: false, campaign: { calls: 13 } });
  });

  it('executa contador real nos três protocolos/presets e mantém estimativa distinta do usage', () => {
    const result = runDeterministic();
    expect(result.envelopes).toHaveLength(9);
    expect(result.envelopes.every((item) => item.estimatedInputTokens <= item.inputBudget)).toBe(true);
    expect(result.usage).toMatchObject({ total: 110, cached: 40 });
    expect(result.realReductionProven).toBe(false);
    expect(result.comparator).toEqual({ status: 'principal-complete', c3: false });
  });

  it('soma main, resumo, recall e retry integralmente e não subtrai cache', () => {
    const events = ['main', 'summary', 'recall', 'retry'].flatMap((kind, index) => call('ledger', 'after', index, index * 2, 100, kind as 'main'));
    const result = summarizeLedger(events);
    expect(result).toMatchObject({ calls: 4, input: 400, output: 40, total: 440, cached: 80, latencyMs: 4 });
    expect(result.breakdown.summary).toMatchObject({ calls: 1, observedInput: 100, observedOutput: 10 });
  });

  it('um par32k basta para o cenário principal e matriz opcional nunca substitui financeiro', () => {
    expect(compareCampaign(campaign())).toMatchObject({ pilotPassed: true, principalScenarioPassed: true, status: 'principal-complete', c3: false, financialRegression: { status: 'not-provided' }, expandedMatrix: { status: 'deferred' } });
    const result = compareCampaign(campaign(true));
    expect(result).toMatchObject({ status: 'principal-complete', principalScenarioPassed: true, c3: false, semanticOwnerReviewRequired: true });
    expect(result.presets.map((preset) => [preset.valid, preset.baselineTotal, preset.afterTotal])).toEqual([[3, 930, 510], [3, 930, 510], [3, 930, 510]]);
    expect(result.campaign.total).toBe(4320);
  });

  it('tentativa negativa aumenta campanha sem entrar nas amostras válidas', () => {
    const evidence = campaign(true), negative = pair('failed', 32768, 200);
    negative.after.replay.records[0]!.version++;
    evidence.negatives.push(negative);
    const result = compareCampaign(evidence);
    expect(result.negativeAttempts).toBe(1);
    expect(result.pairs.at(-1)!.valid).toBe(false);
    expect(result.presets[0]!.valid).toBe(3);
    expect(result.campaign.total).toBe(4800);
  });

  it.each(['version', 'cell', 'id', 'relation', 'formula', 'view'] as const)('rejeita divergência de replay %s', (field) => {
    const evidence = campaign(), snapshot = evidence.pilot.after.replay;
    if (field === 'version') snapshot.records[0]!.version++;
    if (field === 'cell') snapshot.records[0]!.cells.amount = '1.02';
    if (field === 'id') snapshot.records[0]!.id = 'different';
    if (field === 'relation') snapshot.relations = ['different'];
    if (field === 'formula') snapshot.formulas = ['different'];
    if (field === 'view') snapshot.views = ['different'];
    expect(compareCampaign(evidence)).toMatchObject({ pilotPassed: false, status: 'stopped', c3: false });
  });

  it('não usa baseline incompleto/barato nem oracle divergente para alegar redução', () => {
    const evidence = campaign();
    evidence.pilot.baseline.completed = false;
    expect(compareCampaign(evidence).pilotPassed).toBe(false);
    evidence.pilot.baseline.completed = true;
    evidence.pilot.after.quality[0]!.observed = 'lost-owner-restriction';
    expect(compareCampaign(evidence).pilotPassed).toBe(false);
    evidence.repetitions.push(pair('forbidden', 32768, 10));
    expect(() => compareCampaign(evidence)).toThrow('PILOT_EXPANSION_FORBIDDEN');
  });

  it('custo total regressivo para piloto e preset permanece sem redução mesmo com muito cache', () => {
    const evidence = campaign();
    const end = evidence.pilot.after.ledger[1]!;
    if (end.type === 'end') end.usage = { input: 1000, output: 10, cached: 1000 };
    expect(compareCampaign(evidence)).toMatchObject({ pilotPassed: false, c3: false });
    const matrix = campaign(true);
    const trial = matrix.repetitions.find((item) => item.after.window === 65536)!;
    const trialEnd = trial.after.ledger[1]!;
    if (trialEnd.type === 'end') trialEnd.usage = { input: 1000, output: 10, cached: 1000 };
    const report = compareCampaign(matrix);
    expect(report.c3).toBe(false);
    expect(report.presets[1]!.reduced).toBe(false);
  });

  it('uso ausente, resposta incompleta e 429 não viram sucesso ou zero conhecido', () => {
    const evidence = campaign(), end = evidence.pilot.after.ledger[1]!;
    if (end.type !== 'end') throw new Error('fixture');
    end.usage.input = null;
    expect(compareCampaign(evidence)).toMatchObject({ status: 'stopped', budgetCode: 'CAMPAIGN_USAGE_UNKNOWN' });
    expect(summarizeLedger(evidence.pilot.after.ledger).total).toBeNull();
    end.usage.input = 100; end.status = 429;
    expect(compareCampaign(evidence)).toMatchObject({ status: 'stopped', budgetCode: 'CAMPAIGN_RATE_LIMITED' });
    end.status = 200; end.complete = false;
    expect(compareCampaign(evidence).pilotPassed).toBe(false);
  });

  it('rejeita IDs repetidos, par incompleto, manifesto divergente e janela baseline falsa', () => {
    const duplicate = campaign();
    duplicate.pilot.after.ledger.push(...duplicate.pilot.after.ledger);
    expect(() => compareCampaign(duplicate)).toThrow('LEDGER_DUPLICATE_ID');
    const divergent = campaign(); divergent.pilot.after.sourceHash = '3'.repeat(64);
    expect(() => compareCampaign(divergent)).toThrow('MANIFEST_DIVERGENT');
    const baseline = campaign(); baseline.pilot.baseline.window = 32768;
    expect(() => compareCampaign(baseline)).toThrow('WINDOW_INVALID');
    const incomplete = campaign(); incomplete.pilot.after.quality.pop();
    expect(() => compareCampaign(incomplete)).toThrow('QUALITY_ORACLE_INCOMPLETE');
    const preservation = campaign(); preservation.pilot.after.preservationAfterHash = '3'.repeat(64);
    expect(() => compareCampaign(preservation)).toThrow('PRESERVATION_DIVERGENT');
    const oracle = campaign(); oracle.pilot.after.result.expected = { count: 2 };
    expect(() => compareCampaign(oracle)).toThrow('PAIR_ORACLE_DIVERGENT');
  });

  it('valida teto de chamadas, entrada, replay, resumo, campanha e tempo incluindo negativos', () => {
    const tooMany = Array.from({ length: LIMITS.calls + 1 }, (_, index) => call('many', 'after', index, index * 2, 100)).flat();
    expect(() => checkObservedBudgets(tooMany)).toThrow('EXECUTION_BUDGET_EXCEEDED');
    const input = call('input', 'after', 0, 0, LIMITS.input + 1);
    expect(() => checkObservedBudgets(input)).toThrow('EXECUTION_BUDGET_EXCEEDED');
    const replay = call('replay', 'after', 0, 0, LIMITS.replayInput + 1).map((event) => ({ ...event, phase: 'replay' as const }));
    expect(() => checkObservedBudgets(replay)).toThrow('EXECUTION_BUDGET_EXCEEDED');
    // Teto de resumos por preparação = teto da escada do motor (spec F3 passo 6, `SUMMARY_MAX_CALLS`): exatamente o teto passa e um a mais reprova, tanto com resumos
    // quanto com a repetição marcada como retry de resumo (que conta na mesma preparação). Passar o teto do motor é comportamento legítimo, não excesso.
    expect(LIMITS.summariesPerPreparation).toBe(SUMMARY_MAX_CALLS);
    const summaries = (count: number) => Array.from({ length: count }, (_, index) => call('summary', 'after', index, index * 2, 100, 'summary')).flat();
    const summariesEndingInRetry = (count: number) => [...summaries(count - 1), ...call('summary', 'after', count - 1, (count - 1) * 2, 100, 'retry').map((event) => ({ ...event, retryOf: 'summary' as const, preparationId: 'summary-prepare' }))];
    expect(() => checkObservedBudgets(summaries(LIMITS.summariesPerPreparation))).not.toThrow();
    expect(() => checkObservedBudgets(summaries(LIMITS.summariesPerPreparation + 1))).toThrow('SUMMARY_LIMIT_EXCEEDED');
    expect(() => checkObservedBudgets(summariesEndingInRetry(LIMITS.summariesPerPreparation))).not.toThrow();
    expect(() => checkObservedBudgets(summariesEndingInRetry(LIMITS.summariesPerPreparation + 1))).toThrow('SUMMARY_LIMIT_EXCEEDED');
    const time = call('time', 'after', 0, 0, 100); time[1]!.at = LIMITS.elapsedMs + 1;
    expect(() => checkObservedBudgets(time)).toThrow('EXECUTION_TIME_EXCEEDED');
    const campaignEvents = Array.from({ length: 13 }, (_, index) => call(`campaign-${index}`, 'after', 0, index * 2, 240_000)).flat();
    expect(() => checkObservedBudgets(campaignEvents)).toThrow('CAMPAIGN_BUDGET_EXCEEDED');
  });

  it('64/128 exigem capacidade confirmada e seleção explícita do braço novo', () => {
    const evidence = campaign(true);
    evidence.repetitions.find((item) => item.after.window === 131072)!.after.capacityConfirmed = false;
    expect(compareCampaign(evidence).presets[2]!.valid).toBe(2);
    expect(() => parseOptions(['--mode', 'paired', '--model', 'other'])).toThrow('CLI_ARGUMENT_INVALID');
    expect(() => parseOptions(['--window', '32768', '--window', '65536'])).toThrow('CLI_ARGUMENT_INVALID');
  });

  it('sete runs reais por braço podem ultrapassar 15 minutos na jornada sem aumentar tetos individuais', () => {
    const evidence = campaign();
    for (const name of ['baseline', 'after'] as const) {
      const arm = evidence.pilot[name];
      arm.startedAt = name === 'baseline' ? 0 : 8_000_000;
      arm.executions = Array.from({ length: 7 }, (_, index) => {
        const startedAt = arm.startedAt + index * 1_000_000;
        return { executionId: `${arm.armId}-real-run-${index}`, phase: 'execution' as const, startedAt, endedAt: startedAt + 4 };
      });
      arm.endedAt = arm.executions.at(-1)!.endedAt;
      arm.ledger = arm.executions.flatMap((run) => call(run.executionId, name, 0, run.startedAt, name === 'baseline' ? 300 : 100));
      const replayRun = { executionId: `${arm.armId}-real-replay-run`, phase: 'replay' as const, startedAt: arm.endedAt + 1, endedAt: arm.endedAt + 3 };
      arm.executions.push(replayRun);
      arm.ledger.push(...call(replayRun.executionId, name, 0, replayRun.startedAt, 100).map((event) => ({ ...event, phase: 'replay' as const })));
      arm.endedAt = replayRun.endedAt;
    }
    expect(compareCampaign(evidence)).toMatchObject({ pilotPassed: true, status: 'principal-complete', budgetCode: null });
    // Um único run longo falha mesmo com consumo agregado baixo e intervalos legítimos no braço.
    evidence.pilot.after.executions[0]!.endedAt += LIMITS.elapsedMs;
    expect(compareCampaign(evidence).pilotPassed).toBe(false);
  });

  it('recusa um run com chamadas demais e identidade real compartilhada entre amostras', () => {
    const evidence = campaign();
    const arm = evidence.pilot.after, run = arm.executions[0]!;
    run.endedAt = 100; arm.endedAt = 100;
    arm.ledger = Array.from({ length: LIMITS.calls + 1 }, (_, index) => call(run.executionId, 'after', index, 10 + index * 2, 100)).flat();
    expect(compareCampaign(evidence)).toMatchObject({ status: 'stopped', budgetCode: 'EXECUTION_BUDGET_EXCEEDED' });
    const shared = campaign(true);
    shared.repetitions[0]!.after.executions[0]!.executionId = shared.pilot.after.executions[0]!.executionId;
    expect(() => compareCampaign(shared)).toThrow('EXECUTION_DUPLICATE_ID');
    const unadmitted = campaign();
    unadmitted.pilot.after.ledger[0]!.executionId = 'real-but-not-admitted';
    expect(() => compareCampaign(unadmitted)).toThrow('LEDGER_UNMATCHED_END');
    const wrongPhase = campaign();
    wrongPhase.pilot.after.ledger = wrongPhase.pilot.after.ledger.map((event) => ({ ...event, phase: 'replay' as const }));
    expect(() => compareCampaign(wrongPhase)).toThrow('LEDGER_SCOPE_INVALID');
  });

  it('CLI deterministic executa sem adaptador e paired falta-adaptador falha antes de rede', async () => {
    expect((await runValidation(['--mode', 'deterministic'], {})).mode).toBe('deterministic');
    await expect(runValidation(['--mode', 'paired'], {})).rejects.toThrow('CONTEXT_ADAPTER_REQUIRED');
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'tests/support/validate-context.ts', '--mode', 'deterministic'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'deterministic', realReductionProven: false });
    const environment = { ...process.env }; delete environment.AION_CONTEXT_ADAPTER_MODULE;
    const missing = spawnSync(process.execPath, ['--import', 'tsx', 'tests/support/validate-context.ts', '--mode', 'paired'], { encoding: 'utf8', env: environment });
    expect(missing.status).toBe(1);
    expect(JSON.parse(missing.stderr)).toMatchObject({ code: 'CONTEXT_ADAPTER_REQUIRED' });
    const refused = spawnSync(process.execPath, ['--import', 'tsx', 'tests/support/validate-context.ts', '--mode', 'paired', '--model', 'other'], { encoding: 'utf8', env: environment });
    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stderr)).toMatchObject({ code: 'CLI_ARGUMENT_INVALID' });
  });

  it('adaptador observado reconcilia chamadas integralmente e recusa omissão', async () => {
    const evidence = campaign();
    const adapter = { async executePaired({ onCallLedger }: { onCallLedger: (event: CallEvent) => void }) {
      [...evidence.pilot.baseline.ledger, ...evidence.pilot.after.ledger].forEach(onCallLedger);
      return evidence;
    } };
    expect(await runValidation(['--mode', 'paired'], {}, adapter)).toMatchObject({ status: 'principal-complete', c3: false });
    await expect(runValidation(['--mode', 'paired'], {}, { async executePaired() { return evidence; } })).rejects.toThrow('ADAPTER_LEDGER_DIVERGENT');
  });

  it('CLI32k conserva histórico e recusa novas chamadas64/128 antes do adaptador', async () => {
    const evidence = campaign(true);
    evidence.repetitions.forEach((item) => { item.historical = true; });
    let dispatches = 0;
    const adapter = { async executePaired({ onCallLedger }: { onCallLedger: (event: CallEvent) => void }) {
      dispatches++;
      [evidence.pilot, ...evidence.repetitions].flatMap((item) => [...item.baseline.ledger, ...item.after.ledger]).sort((a, b) => a.at - b.at).forEach(onCallLedger);
      return evidence;
    } };
    const report = await runValidation(['--mode', 'paired', '--window', '32768'], {}, adapter);
    if (report.mode !== 'paired') throw new Error('PAIRED_REPORT_REQUIRED');
    expect(report).toMatchObject({ status: 'principal-complete', principalScenarioPassed: true, c3: false, requestedExecutionWindow: 32768, newPairIds: ['pilot'], expandedMatrix: { status: 'deferred', requiredForCurrentAcceptance: false }, financialRegression: { status: 'not-provided', requiredRecurrences: 33, requiredPayments: 59, exactReplayRequired: true } });
    expect(report.historicalPairIds).toHaveLength(8);
    expect(report.campaign.total).toBe(4320);
    for (const window of ['65536', '131072']) {
      await expect(runValidation(['--mode', 'paired', '--window', window], {}, adapter)).rejects.toThrow('CLI_WINDOW_OUT_OF_SCOPE');
      expect((await runValidation(['--mode', 'deterministic', '--window', window], {})).mode).toBe('deterministic');
    }
    expect(dispatches).toBe(1);
    evidence.repetitions.find((item) => item.after.window === 65536)!.historical = false;
    await expect(runValidation(['--mode', 'paired'], {}, adapter)).rejects.toThrow('ADAPTER_WINDOW_DIVERGENT');
  });
});

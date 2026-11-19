// Comparação offline de T5: contabiliza chamadas completas sem reduzir cache do consumo nem publicar fontes privadas.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { SUMMARY_MAX_CALLS } from '@aion/core';
import { CHAT_PROTOCOLS, PROTOCOLS, type ChatRequest } from '../../packages/core/src/models/chat-protocols';
import { contextEnvelope, estimateChatPayload } from '../../packages/core/src/runs/context-budget';

export const WINDOWS = [32768, 65536, 131072] as const;
export type Window = typeof WINDOWS[number];
/**
 * Tetos por execução e da campanha. `summariesPerPreparation` NÃO é um número do harness: é o teto da escada de resumo do motor (`SUMMARY_MAX_CALLS` de `@aion/core`:
 * a primeira chamada, a segunda com lembrete de formato e as repetições a 70%, 50% e 35%). Um valor próprio aqui divergiria do motor e reprovaria à toa uma campanha
 * que só fez o que a spec F3 passo 6 permite; acima do teto do motor continua reprovado (`SUMMARY_LIMIT_EXCEEDED`).
 */
export const LIMITS = Object.freeze({ calls: 20, input: 250_000, total: 300_000, elapsedMs: 900_000, replayCalls: 8, replayInput: 80_000, campaignTotal: 3_000_000, summariesPerPreparation: SUMMARY_MAX_CALLS });
export const BEHAVIORS = ['continuous-direction', 'one-off-request', 'direction-change', 'old-evidence-recall', 'external-injection'] as const;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Só códigos estáveis atravessam a CLI; nunca incorporar mensagem do adaptador ou conteúdo observado. */
export class ValidationError extends Error {
  constructor(readonly code: string) { super(code); }
}

/** Asserção de contrato compartilhada por parse, comparador e observer, sempre com erro seguro. */
function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new ValidationError(code);
}

/** Manifesto congelado antes da chamada: hashes distintos de runtime são esperados entre braços. */
export interface Manifest {
  sourceHash: string; promptHash: string; initialStateHash: string;
  baselineRuntimeHash: string; afterRuntimeHash: string; pythonParityHash: string; preservationHash: string;
  frozenAt: number; principalScenario: string;
}

/** Snapshot read-only mantém identidade/revisões e dados exatos, incluindo estrutura das tabelas. */
export interface Snapshot {
  records: { id: string; version: number; cells: Record<string, Json> }[];
  schemas: Json; relations: Json; formulas: Json; views: Json;
}

/** Metadados completos por tentativa de inferência; resumo, recuperação e retry não são descartados. */
export interface CallIdentity {
  callId: string; executionId: string; arm: 'baseline' | 'after';
  kind: 'main' | 'summary' | 'recall' | 'retry'; phase: 'execution' | 'replay'; preparationId?: string;
  retryOf?: 'main' | 'summary' | 'recall';
}
export type CallEvent = CallIdentity & ({ type: 'start'; at: number } | {
  type: 'end'; at: number; status: number; complete: boolean;
  usage: { input: number | null; output: number | null; cached: number | null };
});

/** Identidade e duração do run real, separadas da jornada; replay admite seus próprios runs e limites. */
export interface ExecutionEvidence {
  executionId: string; phase: 'execution' | 'replay'; startedAt: number; endedAt: number;
}

/** Um braço contém runs reais independentes; intervalos entre pedidos não aumentam o teto de nenhum run. */
export interface ArmEvidence {
  armId: string; executions: ExecutionEvidence[]; window: Window | null; effectiveWindow: number | null; capacityConfirmed: boolean;
  manifestHash: string; sourceHash: string; promptHash: string; initialStateHash: string; pythonParityHash: string;
  runtimeHash: string; preservationBeforeHash: string; preservationAfterHash: string;
  startedAt: number; endedAt: number;
  completed: boolean; ledger: CallEvent[];
  expected: Snapshot; final: Snapshot; replay: Snapshot;
  result: { expected: Json; observed: Json };
  quality: { behavior: typeof BEHAVIORS[number]; expected: Json; observed: Json }[];
  duplicatedEffects: boolean;
}
/** Histórico agregado é explícito: não representa nova autorização para executar outra janela nesta invocação. */
export interface PairEvidence { pairId: string; baseline: ArmEvidence; after: ArmEvidence; historical?: boolean }
/** Uma tentativa interrompida conserva somente fatos realmente observados, sem inventar oracle ou replay. */
export type ObservedArmEvidence = Pick<ArmEvidence, 'armId' | 'executions' | 'window' | 'effectiveWindow' | 'capacityConfirmed' | 'manifestHash' | 'sourceHash' | 'promptHash' | 'initialStateHash' | 'pythonParityHash' | 'runtimeHash' | 'preservationBeforeHash' | 'preservationAfterHash' | 'startedAt' | 'endedAt' | 'ledger'> & {
  outcome: 'failed' | 'interrupted' | 'unknown' | 'completed-uncompared';
};
/** null significa braço não executado; essa tentativa nunca é uma amostra comparável de redução. */
export interface PartialNegativeEvidence {
  kind: 'partial'; pairId: string; requestedWindow: Window;
  baseline: ObservedArmEvidence | null; after: ObservedArmEvidence | null; historical?: boolean; manifest?: Manifest;
}
export type NegativeEvidence = (PairEvidence & { manifest?: Manifest }) | PartialNegativeEvidence;
/** Tentativas negativas ficam presentes mesmo quando não servem como amostra válida de economia. */
export interface CampaignEvidence {
  manifest: Manifest;
  guard: { artifactHash: string; preDispatch: true; externalDispatcher: true };
  pilot: PairEvidence | null;
  repetitions: PairEvidence[];
  negatives: NegativeEvidence[];
}

/** Inventário único de tentativas para comparar e reconciliar o observer, incluindo braços não executados. */
export function campaignAttempts(evidence: CampaignEvidence): (PairEvidence | NegativeEvidence)[] {
  return [...(evidence.pilot ? [evidence.pilot] : []), ...evidence.repetitions, ...evidence.negatives];
}

/** O discriminante parcial é aceito somente na lista de negativos, nunca em piloto/repetições. */
export function isPartialNegative(attempt: PairEvidence | NegativeEvidence): attempt is PartialNegativeEvidence {
  return 'kind' in attempt && attempt.kind === 'partial';
}

/** Contrato operacional: o dispatcher externo deve guardar ANTES da rede; callback é apenas observação/reconciliação. */
export interface AdapterInput {
  model: 'deepseek-v4.1-flash'; effort: 'default'; window: Window; limits: typeof LIMITS;
  onCallLedger: (event: CallEvent) => void;
}
export interface ContextAdapter { executePaired(input: AdapterInput): Promise<CampaignEvidence> }

/** Hash público identifica condições privadas sem incluir seus corpos no relatório. */
export function manifestHash(manifest: Manifest): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

/** Conta cada chamada uma vez; uso ausente permanece desconhecido e impede comparação exata. */
export function summarizeLedger(events: readonly CallEvent[]) {
  const starts = new Map<string, Extract<CallEvent, { type: 'start' }>>();
  const ends = new Map<string, Extract<CallEvent, { type: 'end' }>>();
  let lastAt = -Infinity;
  for (const event of events) {
    check(event && typeof event.callId === 'string' && /^[a-zA-Z0-9._:-]{1,200}$/.test(event.callId) && typeof event.executionId === 'string' && /^[a-zA-Z0-9._:-]{1,200}$/.test(event.executionId), 'LEDGER_ID_INVALID');
    check(['baseline', 'after'].includes(event.arm) && ['main', 'summary', 'recall', 'retry'].includes(event.kind) && ['execution', 'replay'].includes(event.phase), 'LEDGER_KIND_INVALID');
    check(event.kind === 'retry' ? ['main', 'summary', 'recall'].includes(event.retryOf ?? '') : event.retryOf === undefined, 'LEDGER_RETRY_INVALID');
    check(Number.isSafeInteger(event.at) && event.at >= lastAt, 'LEDGER_ORDER_INVALID');
    lastAt = event.at;
    if (event.type === 'start') {
      check(!starts.has(event.callId), 'LEDGER_DUPLICATE_ID');
      starts.set(event.callId, event);
    } else {
      check(event.type === 'end' && !ends.has(event.callId), 'LEDGER_DUPLICATE_ID');
      const start = starts.get(event.callId);
      check(start && start.executionId === event.executionId && start.arm === event.arm && start.phase === event.phase && start.kind === event.kind && start.preparationId === event.preparationId && start.retryOf === event.retryOf, 'LEDGER_UNMATCHED_END');
      check(Number.isInteger(event.status) && event.status >= 100 && event.status <= 599 && typeof event.complete === 'boolean', 'LEDGER_STATUS_INVALID');
      check(event.usage && ['input', 'output', 'cached'].every((key) => {
        const value = event.usage[key as keyof typeof event.usage];
        return value === null || (Number.isSafeInteger(value) && value >= 0);
      }), 'LEDGER_USAGE_INVALID');
      check(event.usage.cached === null || event.usage.input === null || event.usage.cached <= event.usage.input, 'LEDGER_CACHE_INVALID');
      ends.set(event.callId, event);
    }
  }
  const completed = [...ends.values()];
  const usageComplete = ends.size === starts.size && completed.every((event) => event.usage.input !== null && event.usage.output !== null);
  const observedInput = completed.reduce((sum, event) => sum + (event.usage.input ?? 0), 0);
  const observedOutput = completed.reduce((sum, event) => sum + (event.usage.output ?? 0), 0);
  check(Number.isSafeInteger(observedInput + observedOutput), 'LEDGER_USAGE_INVALID');
  const breakdown = Object.fromEntries(['main', 'summary', 'recall', 'retry'].map((kind) => {
    const calls = completed.filter((event) => event.kind === kind);
    return [kind, { calls: calls.length, observedInput: calls.reduce((sum, event) => sum + (event.usage.input ?? 0), 0), observedOutput: calls.reduce((sum, event) => sum + (event.usage.output ?? 0), 0) }];
  }));
  return {
    calls: starts.size, usageComplete, observedInput, observedOutput, observedTotal: observedInput + observedOutput,
    input: usageComplete ? observedInput : null, output: usageComplete ? observedOutput : null,
    total: usageComplete ? observedInput + observedOutput : null,
    cached: usageComplete && completed.every((event) => event.usage.cached !== null) ? completed.reduce((sum, event) => sum + event.usage.cached!, 0) : null,
    latencyMs: completed.reduce((sum, event) => sum + event.at - starts.get(event.callId)!.at, 0), breakdown,
    successful: usageComplete && starts.size > 0 && completed.every((event) => event.complete && event.status >= 200 && event.status < 300),
    rateLimited: completed.some((event) => event.status === 429),
  };
}

/** Teto total e uso incerto sempre consideram toda a campanha, inclusive tentativas antigas. */
function checkCampaignBudget(campaign: ReturnType<typeof summarizeLedger>) {
  check(!campaign.rateLimited, 'CAMPAIGN_RATE_LIMITED');
  check(campaign.usageComplete, 'CAMPAIGN_USAGE_UNKNOWN');
  check(campaign.observedTotal <= LIMITS.campaignTotal, 'CAMPAIGN_BUDGET_EXCEEDED');
}

/** Diagnóstico por run preserva os excessos observados mesmo quando pertencem a um negativo encerrado. */
function executionBudgetDiagnostics(events: readonly CallEvent[]) {
  const diagnostics: { executionId: string; code: string }[] = [];
  const executions = new Set(events.map((event) => event.executionId));
  for (const executionId of executions) {
    const own = events.filter((event) => event.executionId === executionId);
    for (const phase of ['execution', 'replay'] as const) {
      const phaseEvents = own.filter((event) => event.phase === phase);
      const usage = summarizeLedger(phaseEvents);
      if (usage.calls > (phase === 'replay' ? LIMITS.replayCalls : LIMITS.calls) || usage.observedInput > (phase === 'replay' ? LIMITS.replayInput : LIMITS.input) || usage.observedTotal > LIMITS.total) diagnostics.push({ executionId, code: 'EXECUTION_BUDGET_EXCEEDED' });
      if (phaseEvents.length && phaseEvents.at(-1)!.at - phaseEvents[0]!.at > LIMITS.elapsedMs) diagnostics.push({ executionId, code: 'EXECUTION_TIME_EXCEEDED' });
    }
    const preparations = new Map<string, number>();
    for (const event of own.filter((event) => event.type === 'start' && (event.kind === 'summary' || event.retryOf === 'summary'))) {
      check(event.preparationId, 'SUMMARY_PREPARATION_REQUIRED');
      preparations.set(event.preparationId, (preparations.get(event.preparationId) ?? 0) + 1);
    }
    if ([...preparations.values()].some((count) => count > LIMITS.summariesPerPreparation)) diagnostics.push({ executionId, code: 'SUMMARY_LIMIT_EXCEEDED' });
  }
  return diagnostics;
}

/** Guarda estrita reutilizável: nenhum caller desta função pode dispensar limites por run. */
export function checkObservedBudgets(events: readonly CallEvent[]) {
  const campaign = summarizeLedger(events);
  checkCampaignBudget(campaign);
  const diagnostics = executionBudgetDiagnostics(events);
  check(diagnostics.length === 0, diagnostics[0]?.code ?? 'EXECUTION_BUDGET_EXCEEDED');
  return campaign;
}

/** Rejeita snapshots ambíguos antes da igualdade: IDs únicos e versões exatas fazem parte do replay. */
function validateSnapshot(snapshot: Snapshot) {
  check(snapshot && Array.isArray(snapshot.records) && ['schemas', 'relations', 'formulas', 'views'].every((key) => Object.hasOwn(snapshot, key)), 'SNAPSHOT_INVALID');
  const ids = new Set<string>();
  for (const record of snapshot.records) {
    check(record && typeof record.id === 'string' && record.id.length && !ids.has(record.id) && Number.isSafeInteger(record.version) && record.version >= 0 && record.cells && typeof record.cells === 'object' && !Array.isArray(record.cells), 'SNAPSHOT_INVALID');
    ids.add(record.id);
  }
}

/** Mesmas guardas de identidade, fonte, runtime, posse e preservação para sucesso ou tentativa interrompida. */
function validateObservedArm(arm: ArmEvidence | ObservedArmEvidence, name: 'baseline' | 'after', manifest: Manifest) {
  check(arm && typeof arm.armId === 'string' && /^[a-zA-Z0-9._:-]{1,200}$/.test(arm.armId) && Array.isArray(arm.executions) && arm.executions.length > 0 && Array.isArray(arm.ledger), 'PAIR_INCOMPLETE');
  check(name === 'baseline' ? arm.window === null : WINDOWS.includes(arm.window as Window), 'WINDOW_INVALID');
  check(arm.manifestHash === manifestHash(manifest) && arm.sourceHash === manifest.sourceHash && arm.promptHash === manifest.promptHash && arm.initialStateHash === manifest.initialStateHash && arm.pythonParityHash === manifest.pythonParityHash && arm.runtimeHash === (name === 'baseline' ? manifest.baselineRuntimeHash : manifest.afterRuntimeHash), 'MANIFEST_DIVERGENT');
  check(Number.isSafeInteger(arm.startedAt) && Number.isSafeInteger(arm.endedAt) && arm.startedAt >= manifest.frozenAt && arm.endedAt >= arm.startedAt, 'EXECUTION_TIME_INVALID');
  const executions = new Map<string, ExecutionEvidence>();
  for (const execution of arm.executions) {
    check(execution && typeof execution.executionId === 'string' && /^[a-zA-Z0-9._:-]{1,200}$/.test(execution.executionId) && !executions.has(execution.executionId) && ['execution', 'replay'].includes(execution.phase), 'EXECUTION_ID_INVALID');
    check(Number.isSafeInteger(execution.startedAt) && Number.isSafeInteger(execution.endedAt) && execution.startedAt >= arm.startedAt && execution.endedAt <= arm.endedAt && execution.endedAt >= execution.startedAt, 'EXECUTION_TIME_INVALID');
    executions.set(execution.executionId, execution);
  }
  check(arm.ledger.every((event) => {
    const execution = executions.get(event.executionId);
    return execution && event.arm === name && event.phase === execution.phase && event.at >= execution.startedAt && event.at <= execution.endedAt;
  }), 'LEDGER_SCOPE_INVALID');
  check(arm.preservationBeforeHash === manifest.preservationHash && arm.preservationAfterHash === manifest.preservationHash, 'PRESERVATION_DIVERGENT');
}

/** Aceite comparável continua exigindo conclusão, oracle completo, dados exatos e replay sem efeitos duplicados. */
function compareArm(arm: ArmEvidence, name: 'baseline' | 'after', manifest: Manifest) {
  validateObservedArm(arm, name, manifest);
  check(Array.isArray(arm.quality), 'PAIR_INCOMPLETE');
  for (const snapshot of [arm.expected, arm.final, arm.replay]) validateSnapshot(snapshot);
  const exact = isDeepStrictEqual(arm.final, arm.expected) && isDeepStrictEqual(arm.replay, arm.final);
  check(arm.quality.length === BEHAVIORS.length && new Set(arm.quality.map((item) => item.behavior)).size === BEHAVIORS.length && BEHAVIORS.every((behavior) => arm.quality.some((item) => item.behavior === behavior)), 'QUALITY_ORACLE_INCOMPLETE');
  check(arm.result && Object.hasOwn(arm.result, 'expected') && Object.hasOwn(arm.result, 'observed'), 'RESULT_ORACLE_REQUIRED');
  const quality = isDeepStrictEqual(arm.result.expected, arm.result.observed) && arm.quality.every((item) => Object.hasOwn(item, 'expected') && Object.hasOwn(item, 'observed') && isDeepStrictEqual(item.expected, item.observed));
  const capacity = name === 'baseline' || (Number.isSafeInteger(arm.effectiveWindow) && arm.effectiveWindow! >= arm.window! && (arm.window === 32768 || arm.capacityConfirmed === true));
  const usage = summarizeLedger(arm.ledger);
  const timeValid = arm.executions.every((execution) => execution.endedAt - execution.startedAt <= LIMITS.elapsedMs);
  return { usage, exact, quality, valid: arm.completed === true && arm.duplicatedEffects === false && exact && quality && capacity && usage.successful && timeValid };
}

/** Exige identificação verificável das condições antes de aceitar chamadas de qualquer manifesto. */
function validateManifest(manifest: Manifest) {
  check(manifest && ['sourceHash', 'promptHash', 'initialStateHash', 'baselineRuntimeHash', 'afterRuntimeHash', 'pythonParityHash', 'preservationHash'].every((key) => /^[a-f0-9]{64}$/.test(manifest[key as keyof Manifest] as string)) && Number.isSafeInteger(manifest.frozenAt) && typeof manifest.principalScenario === 'string' && manifest.principalScenario.length, 'MANIFEST_INVALID');
}

/** Tentativas de manifestos anteriores contam na campanha, mas nunca viram amostra da condição atual. */
export function compareCampaign(evidence: CampaignEvidence) {
  const manifest = evidence?.manifest;
  validateManifest(manifest);
  check(evidence.guard?.preDispatch === true && evidence.guard.externalDispatcher === true && /^[a-f0-9]{64}$/.test(evidence.guard.artifactHash), 'DISPATCH_GUARD_REQUIRED');
  check(evidence.pilot !== undefined && Array.isArray(evidence.repetitions) && Array.isArray(evidence.negatives), 'PAIR_INCOMPLETE');
  check(evidence.pilot !== null || (evidence.repetitions.length === 0 && evidence.negatives.some(isPartialNegative)), 'PAIR_INCOMPLETE');
  check((!evidence.pilot || !isPartialNegative(evidence.pilot)) && evidence.repetitions.every((pair) => !isPartialNegative(pair)), 'PARTIAL_SAMPLE_FORBIDDEN');
  const pairs = campaignAttempts(evidence);
  check(new Set(pairs.map((pair) => pair.pairId)).size === pairs.length && pairs.every((pair) => typeof pair.pairId === 'string' && /^[a-zA-Z0-9._:-]{1,200}$/.test(pair.pairId) && (isPartialNegative(pair) ? pair.baseline !== undefined && pair.after !== undefined && (pair.baseline || pair.after) : pair.baseline && pair.after) && (pair.historical === undefined || typeof pair.historical === 'boolean')), 'PAIR_INCOMPLETE');
  const arms = pairs.flatMap((pair) => [pair.baseline, pair.after]).filter((arm) => arm !== null);
  check(new Set(arms.map((arm) => arm.armId)).size === arms.length, 'ARM_DUPLICATE_ID');
  check(arms.every((arm) => Array.isArray(arm.executions)), 'PAIR_INCOMPLETE');
  const executionIds = arms.flatMap((arm) => arm.executions.map((execution) => execution.executionId));
  check(new Set(executionIds).size === executionIds.length, 'EXECUTION_DUPLICATE_ID');
  const events = arms.flatMap((arm) => arm.ledger).sort((a, b) => a.at - b.at || (a.type === b.type ? 0 : a.type === 'start' ? -1 : 1));
  const campaign = summarizeLedger(events);
  const results = pairs.map((pair) => {
    const ownManifest = evidence.negatives.find((negative) => negative === pair)?.manifest ?? manifest;
    validateManifest(ownManifest);
    if (isPartialNegative(pair)) {
      check(WINDOWS.includes(pair.requestedWindow), 'WINDOW_INVALID');
      const observe = (arm: ObservedArmEvidence | null, name: 'baseline' | 'after') => {
        if (arm === null) return null;
        validateObservedArm(arm, name, ownManifest);
        check(['failed', 'interrupted', 'unknown', 'completed-uncompared'].includes(arm.outcome) && arm.ledger.length > 0, 'PARTIAL_OBSERVATION_REQUIRED');
        if (name === 'after') check(arm.window === pair.requestedWindow, 'WINDOW_INVALID');
        return { usage: summarizeLedger(arm.ledger), exact: false, quality: false, valid: false };
      };
      return { pairId: pair.pairId, window: pair.requestedWindow, baseline: observe(pair.baseline, 'baseline'), after: observe(pair.after, 'after'), comparable: false, valid: false, reduced: false };
    }
    const baseline = compareArm(pair.baseline, 'baseline', ownManifest), after = compareArm(pair.after, 'after', ownManifest);
    check(isDeepStrictEqual(pair.baseline.result.expected, pair.after.result.expected) && BEHAVIORS.every((behavior) => isDeepStrictEqual(pair.baseline.quality.find((item) => item.behavior === behavior)!.expected, pair.after.quality.find((item) => item.behavior === behavior)!.expected)), 'PAIR_ORACLE_DIVERGENT');
    const valid = baseline.valid && after.valid;
    return { pairId: pair.pairId, window: pair.after.window, baseline, after, comparable: true, valid, reduced: valid && after.usage.total! < baseline.usage.total! };
  });
  check(!evidence.pilot || evidence.pilot.after.window === 32768, 'PILOT_WINDOW_INVALID');
  const pilotPassed = evidence.pilot !== null && results[0]!.reduced;
  check(pilotPassed || evidence.repetitions.length === 0, 'PILOT_EXPANSION_FORBIDDEN');
  if (evidence.repetitions.length) {
    const pilotEnd = Math.max(evidence.pilot!.baseline.endedAt, evidence.pilot!.after.endedAt);
    check(evidence.repetitions.every((pair) => [...pair.baseline.ledger, ...pair.after.ledger].every((event) => event.at > pilotEnd)), 'PILOT_ORDER_INVALID');
  }
  let budgetCode: string | null = null;
  let historicalBudgetDiagnostics: { pairId: string; executionId: string; code: string }[] = [];
  // Somente negativos declarados históricos e encerrados antes das novas amostras recebem diagnóstico.
  // Piloto/repetições permanecem sujeitos ao gate estrito, mesmo quando agregados como histórico.
  const samples = [...(evidence.pilot ? [evidence.pilot] : []), ...evidence.repetitions];
  const freshPairs = samples.filter((pair) => pair.historical !== true);
  const referencePairs = freshPairs.length ? freshPairs : samples;
  // Sem piloto, a tentativa negativa continua sendo o resultado avaliado e conserva seu budgetCode original.
  const freshStartedAt = referencePairs.length ? Math.min(...referencePairs.flatMap((pair) => [pair.baseline.startedAt, pair.after.startedAt])) : -Infinity;
  const historicalExecutions = new Map<string, string>();
  for (const negative of evidence.negatives) if (negative.historical === true) {
    for (const arm of [negative.baseline, negative.after]) if (arm && arm.endedAt <= freshStartedAt && (!isPartialNegative(negative) || !('outcome' in arm) || arm.outcome !== 'unknown')) {
      for (const execution of arm.executions) historicalExecutions.set(execution.executionId, negative.pairId);
    }
  }
  try {
    const diagnostics = executionBudgetDiagnostics(events);
    historicalBudgetDiagnostics = diagnostics.filter((diagnostic) => historicalExecutions.has(diagnostic.executionId)).map((diagnostic) => ({ ...diagnostic, pairId: historicalExecutions.get(diagnostic.executionId)! }));
    checkCampaignBudget(campaign);
    const current = diagnostics.find((diagnostic) => !historicalExecutions.has(diagnostic.executionId));
    check(!current, current?.code ?? 'EXECUTION_BUDGET_EXCEEDED');
  } catch (error) { if (!(error instanceof ValidationError)) throw error; budgetCode = error.code; }
  const candidates = results.slice(0, (evidence.pilot ? 1 : 0) + evidence.repetitions.length);
  const presets = WINDOWS.map((window) => {
    const all = candidates.filter((pair) => pair.window === window);
    const valid = all.filter((pair) => pair.valid);
    const baselineTotal = valid.reduce((sum, pair) => sum + pair.baseline!.usage.total!, 0);
    const afterTotal = valid.reduce((sum, pair) => sum + pair.after!.usage.total!, 0);
    return { window, attempted: all.length, valid: valid.length, baselineTotal, afterTotal, reduced: valid.length >= 3 && afterTotal < baselineTotal };
  });
  // O aceite da campanha original (phase 8) exige um par 32k; a janela de 32k saiu do produto na phase 11 e esta CLI (`validate-context.ts`) ficou como o registro dessa campanha, como diz o README.
  // Custos históricos desconhecidos bloqueiam a campanha,
  // mas não apagam a prova conhecida do próprio par; nunca promovem essa prova ao C3 financeiro.
  let principalScenarioPassed = pilotPassed;
  if (evidence.pilot) {
    try { checkObservedBudgets([...evidence.pilot.baseline.ledger, ...evidence.pilot.after.ledger]); }
    catch (error) { if (!(error instanceof ValidationError)) throw error; principalScenarioPassed = false; }
  }
  return {
    mode: 'paired' as const, evaluationScope: 'principal-32k-and-finance-92' as const,
    pilotPassed, principalScenarioPassed,
    status: !principalScenarioPassed || budgetCode ? 'stopped' as const : 'principal-complete' as const,
    // CampaignEvidence ainda não contém a certificação financeira: nenhum boolean externo substitui sua prova.
    c3: false, financialRegression: { status: 'not-provided' as const, requiredRecurrences: 33, requiredPayments: 59, exactReplayRequired: true },
    expandedMatrix: { status: 'deferred' as const, requiredForCurrentAcceptance: false },
    semanticOwnerReviewRequired: true, budgetCode, historicalBudgetDiagnostics, campaign, presets, pairs: results,
    negativeAttempts: evidence.negatives.length, monetaryCost: 'unavailable' as const,
  };
}

/** Exercita o contador real dos três adaptadores, sem rede e sem chamar estimativa de usage. */
export function runDeterministic() {
  const request: ChatRequest = { model: 'deepseek-v4.1-flash', sessionId: 'synthetic-offline', maxTokens: 8192, turns: [
    { role: 'system', text: 'Preserve a restrição do dono.' }, { role: 'user', text: '漢字 á 😀\\\n"'.repeat(80) },
    { role: 'assistant', text: '', toolCalls: [{ id: 'synthetic-call', name: 'read_table', arguments: '{"offset":0}' }] },
    { role: 'tool', callId: 'synthetic-call', name: 'read_table', text: '{"rows":[{"value":"1.01"}]}' },
  ], tools: [{ name: 'read_table', description: 'Evidência sintética', parameters: { type: 'object', properties: { offset: { type: 'integer' } } } }] };
  const envelopes = WINDOWS.flatMap((window) => CHAT_PROTOCOLS.map((protocol) => {
    const count = estimateChatPayload(request, protocol), envelope = contextEnvelope(window, request.maxTokens);
    check(count.payloadBytes === Buffer.byteLength(JSON.stringify(PROTOCOLS[protocol].body(request)), 'utf8') && count.reliable && count.estimatedInputTokens <= envelope.inputBudget, 'DETERMINISTIC_ENVELOPE_FAILED');
    return { protocol, ...count, ...envelope };
  }));
  const identity: CallIdentity = { callId: 'offline-call', executionId: 'offline-execution', arm: 'after', kind: 'summary', phase: 'execution', preparationId: 'offline-preparation' };
  const usage = checkObservedBudgets([{ ...identity, type: 'start', at: 0 }, { ...identity, type: 'end', at: 1, status: 200, complete: true, usage: { input: 100, output: 10, cached: 40 } }]);
  check(usage.total === 110 && usage.cached === 40, 'DETERMINISTIC_LEDGER_FAILED');
  const hash = createHash('sha256').update('synthetic-offline-fixture').digest('hex');
  const manifest: Manifest = { sourceHash: hash, promptHash: hash, initialStateHash: hash, baselineRuntimeHash: hash, afterRuntimeHash: hash, pythonParityHash: hash, preservationHash: hash, frozenAt: 0, principalScenario: 'synthetic-offline' };
  const snapshot: Snapshot = { records: [{ id: 'synthetic-record', version: 1, cells: { exact: '1.01' } }], schemas: [], relations: [], formulas: [], views: [] };
  /** Dois braços sintéticos exercitam o comparador; esses números não são uma medição do produto. */
  const makeArm = (arm: 'baseline' | 'after'): ArmEvidence => {
    const armId = `synthetic-${arm}`, executionId = `${armId}-run`, callId = `call-${arm}`, at = arm === 'baseline' ? 0 : 2;
    const call: CallIdentity = { callId, executionId, arm, kind: 'main', phase: 'execution' };
    return { armId, executions: [{ executionId, phase: 'execution', startedAt: at, endedAt: at + 1 }], window: arm === 'baseline' ? null : 32768, effectiveWindow: 32768, capacityConfirmed: true, manifestHash: manifestHash(manifest), sourceHash: hash, promptHash: hash, initialStateHash: hash, pythonParityHash: hash, runtimeHash: hash, preservationBeforeHash: hash, preservationAfterHash: hash,
      startedAt: at, endedAt: at + 1, completed: true, duplicatedEffects: false, expected: snapshot, final: structuredClone(snapshot), replay: structuredClone(snapshot), result: { expected: 1, observed: 1 }, quality: BEHAVIORS.map((behavior) => ({ behavior, expected: true, observed: true })),
      ledger: [{ ...call, type: 'start', at }, { ...call, type: 'end', at: at + 1, status: 200, complete: true, usage: { input: arm === 'baseline' ? 100 : 50, output: 10, cached: null } }] };
  };
  const comparison = compareCampaign({ manifest, guard: { artifactHash: hash, preDispatch: true, externalDispatcher: true }, pilot: { pairId: 'synthetic-pair', baseline: makeArm('baseline'), after: makeArm('after') }, repetitions: [], negatives: [] });
  check(comparison.principalScenarioPassed && !comparison.c3 && comparison.status === 'principal-complete' && comparison.financialRegression.status === 'not-provided', 'DETERMINISTIC_COMPARATOR_FAILED');
  return { mode: 'deterministic' as const, status: 'offline-only', envelopes, usage, comparator: { status: comparison.status, c3: comparison.c3 }, realReductionProven: false };
}

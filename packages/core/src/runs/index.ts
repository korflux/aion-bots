// Módulo de execução dos bots (T6): motor, executor, contexto do modelo e ferramentas internas.
// Limpeza fria (phase 11, T7): o laço que o worker liga e o T da conversa fria. A regra e o mascaramento (`maskColdResults`) são internos ao motor.
export { ColdMaintenance, COLD_AFTER_MS, DEFAULT_COLD_CONFIG, type ColdMaintenanceConfig, type ColdMaintenanceOptions } from './cold-maintenance';
export * from './composio-tools';
// Só o teto de chamadas de resumo por preparação (fonte única que o harness `tests/support/context-validation.ts` aplica); o resto de `compaction.ts` é interno ao motor.
export { SUMMARY_MAX_CALLS } from './compaction';
export * from './context';
export * from './engine';
export * from './edit-memory';
export * from './executor';
export * from './lease';
export * from './propose-routine';
export * from './routine-tools';
export * from './run-python';
export * from './search-history';
export * from './text-writer';
export * from './tools';
export * from './table-tools';
export * from './web-tools';

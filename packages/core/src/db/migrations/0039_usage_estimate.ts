// Estimativa local de cada chamada principal, ao lado do usage real do provedor: base da calibração do orçamento (`runs/token-calibration.ts`).
// É dado derivado e recalculável; o rollback pode descartá-lo sem perder consumo, checkpoint ou conversa.
import type { Migration } from '../migrator';
export const usageEstimateMigration: Migration = {
  id: '0039_usage_estimate', description: 'Estimativa local por chamada para calibrar o orçamento pelo usage real',
  up: `ALTER TABLE model_call_usage ADD COLUMN estimated_input_tokens bigint CHECK(estimated_input_tokens > 0);
    CREATE INDEX model_call_usage_calibration ON model_call_usage(model, completed_at DESC) WHERE purpose='main' AND state='completed' AND estimated_input_tokens IS NOT NULL;`,
  rollback: `DROP INDEX model_call_usage_calibration; ALTER TABLE model_call_usage DROP COLUMN estimated_input_tokens;`,
};

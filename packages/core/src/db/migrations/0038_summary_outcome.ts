// Distingue resposta paga definitiva de checkpoint aplicado, sem inventar custo desconhecido.
import type { Migration } from '../migrator';
export const summaryOutcomeMigration: Migration = {
  id: '0038_summary_outcome', description: 'Desfecho definitivo da chamada de resumo',
  up: `ALTER TABLE model_call_usage ADD COLUMN summary_outcome text CHECK(summary_outcome IN ('applied','output_limit','empty'));
    ALTER TABLE model_call_usage ADD CONSTRAINT model_call_usage_summary_outcome_state_check CHECK(summary_outcome IS NULL OR (purpose='summary' AND state='completed'));`,
  // Motivo definitivo impede repeticao paga; rollback de aplicativo preserva esse recibo.
  rollback: `DO $$ BEGIN IF EXISTS(SELECT 1 FROM model_call_usage WHERE summary_outcome IS NOT NULL)
    THEN RAISE EXCEPTION 'Preserve desfechos de resumo no rollback de aplicacao'; END IF; END $$;
    ALTER TABLE model_call_usage DROP CONSTRAINT model_call_usage_summary_outcome_state_check;
    ALTER TABLE model_call_usage DROP COLUMN summary_outcome;`,
};


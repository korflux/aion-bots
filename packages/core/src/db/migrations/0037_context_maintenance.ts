// Manutenção usa runs/lease existentes; o registro separado guarda somente intenção e resultado recuperável.
import type { Migration } from '../migrator';
export const contextMaintenanceMigration: Migration = {
  id: '0037_context_maintenance', description: 'Medição autorizada e manutenção na fila existente',
  up: `ALTER TABLE conversation_context ADD COLUMN measurement jsonb, ADD COLUMN measurement_revision bigint, ADD COLUMN measurement_provenance jsonb,
    ADD COLUMN elision boolean NOT NULL DEFAULT false,
    ADD COLUMN phase text NOT NULL DEFAULT 'not_measured' CHECK(phase IN ('not_measured','ready','reducing','summarizing','failed'));
    ALTER TABLE model_call_usage ADD COLUMN preparation_id uuid;
    ALTER TABLE runs ADD COLUMN context_operation_id uuid;
    CREATE UNIQUE INDEX runs_context_operation ON runs(context_operation_id) WHERE context_operation_id IS NOT NULL;
    CREATE TABLE context_maintenance (
      request_id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      run_id bigint NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
      session_id uuid NOT NULL, mode text NOT NULL CHECK(mode IN ('elision','summarize')),
      expected_revision bigint NOT NULL CHECK(expected_revision>=0),
      outcome text CHECK(outcome IN ('completed','cancelled','failed','unknown')),
      result jsonb, error_code text, created_at timestamptz NOT NULL
    );
    CREATE INDEX context_maintenance_conversation ON context_maintenance(conversation_id,created_at);
    CREATE INDEX context_maintenance_session ON context_maintenance(session_id,created_at);
    ALTER TABLE conversation_events DROP CONSTRAINT conversation_events_kind_check;
    ALTER TABLE conversation_events ADD CONSTRAINT conversation_events_kind_check CHECK(kind IN ('message','run','draft','path','objective','context'));`,
  // Dados operacionais não podem ser descartados para viabilizar retorno do app anterior.
  rollback: `DO $$ BEGIN IF EXISTS(SELECT 1 FROM context_maintenance) OR EXISTS(SELECT 1 FROM conversation_context WHERE measurement IS NOT NULL OR elision) OR EXISTS(SELECT 1 FROM conversation_events WHERE kind='context') OR EXISTS(SELECT 1 FROM model_call_usage WHERE preparation_id IS NOT NULL)
    THEN RAISE EXCEPTION 'Preserve manutenção e medições no rollback de aplicação'; END IF; END $$;
    ALTER TABLE conversation_events DROP CONSTRAINT conversation_events_kind_check;
    ALTER TABLE conversation_events ADD CONSTRAINT conversation_events_kind_check CHECK(kind IN ('message','run','draft','path','objective'));
    DROP TABLE context_maintenance; ALTER TABLE runs DROP COLUMN context_operation_id;
    ALTER TABLE model_call_usage DROP COLUMN preparation_id;
    ALTER TABLE conversation_context DROP COLUMN measurement, DROP COLUMN measurement_revision, DROP COLUMN measurement_provenance, DROP COLUMN elision, DROP COLUMN phase;`,
};

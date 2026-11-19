// Derivados substituíveis e ledger preservado: nenhuma compactação altera messages/originais.
import type { Migration } from '../migrator';
export const contextCheckpointsMigration: Migration = {
  id: '0036_context_checkpoints', description: 'Cobertura contínua, resumo revisado e uso por chamada',
  up: `CREATE TABLE conversation_context (
    conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
    coverage_start bigint NOT NULL CHECK(coverage_start>=0),
    covered_message_ids bigint[] NOT NULL DEFAULT '{}',
    summary text NOT NULL DEFAULT '' CHECK(char_length(summary)<=16000),
    configuration_fingerprint text NOT NULL DEFAULT '', coverage_fingerprint text NOT NULL DEFAULT '',
    evidence_provenance jsonb NOT NULL DEFAULT '{"attachments":[],"tables":[]}',
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE model_call_usage (
    id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    run_id bigint NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    purpose text NOT NULL CHECK(purpose IN ('main','summary')),
    model text NOT NULL, protocol text NOT NULL, request_fingerprint text, evidence_provenance jsonb,
    state text NOT NULL DEFAULT 'started' CHECK(state IN ('started','completed','unknown')),
    input_tokens bigint CHECK(input_tokens>=0), output_tokens bigint CHECK(output_tokens>=0), cached_tokens bigint CHECK(cached_tokens>=0),
    created_at timestamptz NOT NULL, completed_at timestamptz
  );
  CREATE INDEX model_call_usage_conversation ON model_call_usage(conversation_id,created_at);
  CREATE INDEX model_call_usage_run ON model_call_usage(run_id);
  CREATE UNIQUE INDEX model_call_usage_pending_summary ON model_call_usage(run_id,request_fingerprint) WHERE purpose='summary' AND state<>'completed';`,
  // Chamadas/coverage são dados reais: rollback do app deixa as tabelas, rollback de schema exige vazio.
  rollback: `DO $$ BEGIN IF EXISTS(SELECT 1 FROM model_call_usage) OR EXISTS(SELECT 1 FROM conversation_context WHERE revision>0 OR summary<>'')
    THEN RAISE EXCEPTION 'Preserve uso e checkpoints no rollback de aplicação'; END IF; END $$;
    DROP TABLE model_call_usage; DROP TABLE conversation_context;`,
};

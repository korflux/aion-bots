// Dependências dos derivados são metadata interna; NULL preserva a distinção de legado desconhecido.
import type { Migration } from '../migrator';

export const evidenceProvenanceMigration: Migration = {
  id: '0035_evidence_provenance', description: 'Proveniência transitiva e revisão independente de acesso',
  up: `ALTER TABLE data_tables ADD COLUMN access_version integer NOT NULL DEFAULT 1 CHECK(access_version > 0);
    ALTER TABLE messages ADD COLUMN evidence_provenance jsonb;
    ALTER TABLE attachments ADD COLUMN source_provenance jsonb;
    ALTER TABLE messages ADD CONSTRAINT messages_evidence_object CHECK(evidence_provenance IS NULL OR jsonb_typeof(evidence_provenance)='object');
    ALTER TABLE attachments ADD CONSTRAINT attachments_source_object CHECK(source_provenance IS NULL OR jsonb_typeof(source_provenance)='object');`,
  rollback: `DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM messages WHERE evidence_provenance IS NOT NULL)
      OR EXISTS(SELECT 1 FROM attachments WHERE source_provenance IS NOT NULL)
      OR EXISTS(SELECT 1 FROM data_tables WHERE access_version <> 1) THEN
      RAISE EXCEPTION 'Preserve proveniência e revisões de acesso no rollback de aplicação';
    END IF;
  END $$;
  ALTER TABLE messages DROP COLUMN evidence_provenance;
  ALTER TABLE attachments DROP COLUMN source_provenance;
  ALTER TABLE data_tables DROP COLUMN access_version;`,
};

// Objetivo e revisões próprios; campos derivados de apresentação nunca viram rodada ou push.
import type { Migration } from '../migrator';
export const botObjectivesMigration: Migration = {
  id: '0034_bot_objectives', description: 'Objetivo versionado, evidências e convite dos bots',
  up: `CREATE TABLE bot_objectives (
    bot_id uuid PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
    content text NOT NULL DEFAULT '' CHECK (char_length(content) <= 2000),
    version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
    invitation_presented_at timestamptz, updated_at timestamptz,
    undo_barrier_message_id bigint NOT NULL DEFAULT 0 CHECK (undo_barrier_message_id >= 0)
  );
  CREATE TABLE objective_versions (
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    version integer NOT NULL CHECK (version > 0), content text NOT NULL CHECK (char_length(content) <= 2000),
    source_message_ids bigint[] NOT NULL, author text NOT NULL CHECK (author IN ('bot','owner')),
    created_at timestamptz NOT NULL, PRIMARY KEY(bot_id,version)
  );
  INSERT INTO bot_objectives(bot_id) SELECT id FROM bots;
  ALTER TABLE conversation_events DROP CONSTRAINT conversation_events_kind_check;
  ALTER TABLE conversation_events ADD CONSTRAINT conversation_events_kind_check CHECK(kind IN ('message','run','draft','path','objective'));`,
  rollback: `DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM objective_versions) OR EXISTS(SELECT 1 FROM bot_objectives WHERE content <> '' OR invitation_presented_at IS NOT NULL)
      OR EXISTS(SELECT 1 FROM conversation_events WHERE kind='objective') THEN
      RAISE EXCEPTION 'Preserve objetivos, convites e revisões no rollback de aplicação';
    END IF;
  END $$;
  DROP TABLE objective_versions; DROP TABLE bot_objectives;
  ALTER TABLE conversation_events DROP CONSTRAINT conversation_events_kind_check;
  ALTER TABLE conversation_events ADD CONSTRAINT conversation_events_kind_check CHECK(kind IN ('message','run','draft','path'));`,
};

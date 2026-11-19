// Armazenamento aditivo de anexos: documentos retêm somente texto; imagens retêm JPEG.
import type { Migration } from '../migrator';

export const attachmentsMigration: Migration = {
  id: '0019_attachments',
  description: 'Anexos isolados por conversa, com vínculos opcionais à execução e mensagem',
  up: `
    CREATE TABLE attachments (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
      run_id bigint REFERENCES runs(id) ON DELETE RESTRICT,
      message_id bigint REFERENCES messages(id) ON DELETE RESTRICT,
      kind text NOT NULL CHECK (kind IN ('image', 'document')),
      name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
      original_bytes integer NOT NULL CHECK (original_bytes > 0),
      stored_bytes integer NOT NULL CHECK (stored_bytes >= 0),
      image_bytes bytea,
      extracted_text text,
      truncated boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      removed_at timestamptz,
      CHECK (removed_at IS NOT NULL OR
        (kind = 'image' AND image_bytes IS NOT NULL AND extracted_text IS NULL) OR
        (kind = 'document' AND image_bytes IS NULL AND extracted_text IS NOT NULL)),
      CHECK (removed_at IS NULL OR (image_bytes IS NULL AND extracted_text IS NULL AND stored_bytes = 0))
    );
    CREATE INDEX attachments_conversation ON attachments(conversation_id, id);
    CREATE INDEX attachments_run ON attachments(run_id);
    CREATE INDEX attachments_message ON attachments(message_id);
    CREATE INDEX attachments_pending ON attachments(created_at) WHERE run_id IS NULL AND removed_at IS NULL;
  `,
  // Remove somente anexos novos; dados prévios de bots, mensagens e execuções permanecem.
  rollback: 'DROP TABLE IF EXISTS attachments;',
};

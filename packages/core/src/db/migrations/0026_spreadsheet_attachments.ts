// Migration 0026: planilhas `.xlsx` como anexos com o original guardado (phase 4, T5; F9, ATT-01, A19).
//
// Modelagem:
// - attachments.file_bytes: os bytes originais de um arquivo guardado como veio (a planilha; na T7 também os arquivos gerados pelo Python).
//   `image_bytes` continua só do JPEG e `extracted_text` só do texto de documento, então o CHECK por tipo segue dizendo qual coluna cada
//   tipo preenche. `stored_bytes` da planilha é o tamanho do original, e a soma de `stored_bytes` (o espaço `AION_ATTACHMENTS_MAX_TOTAL_MB`)
//   passa a contá-lo sem mudar a consulta da cota.
// - kind ganha `spreadsheet`.
// - O CHECK de exclusão passa a exigir também `file_bytes` nulo: excluir zera o original como já zerava imagem e texto.
//
// Aditiva: só cria uma coluna anulável e amplia três CHECKs (os nomes são os gerados pelo PostgreSQL na 0019); nada existente muda, então
// roda no deploy sem pedido explícito do dono. A API antiga, durante o deploy, nunca grava `spreadsheet` nem lê a coluna nova.
import type { Migration } from '../migrator';

export const spreadsheetAttachmentsMigration: Migration = {
  id: '0026_spreadsheet_attachments',
  description: 'Anexos de planilha com o arquivo original guardado',
  up: `
    ALTER TABLE attachments ADD COLUMN file_bytes bytea;
    ALTER TABLE attachments DROP CONSTRAINT attachments_kind_check;
    ALTER TABLE attachments ADD CONSTRAINT attachments_kind_check CHECK (kind IN ('image', 'document', 'spreadsheet'));
    ALTER TABLE attachments DROP CONSTRAINT attachments_check;
    ALTER TABLE attachments ADD CONSTRAINT attachments_check CHECK (removed_at IS NOT NULL OR
      (kind = 'image' AND image_bytes IS NOT NULL AND extracted_text IS NULL AND file_bytes IS NULL) OR
      (kind = 'document' AND image_bytes IS NULL AND extracted_text IS NOT NULL AND file_bytes IS NULL) OR
      (kind = 'spreadsheet' AND image_bytes IS NULL AND extracted_text IS NULL AND file_bytes IS NOT NULL));
    ALTER TABLE attachments DROP CONSTRAINT attachments_check1;
    ALTER TABLE attachments ADD CONSTRAINT attachments_check1 CHECK (removed_at IS NULL OR
      (image_bytes IS NULL AND extracted_text IS NULL AND file_bytes IS NULL AND stored_bytes = 0));
  `,
  // Rollback: o código anterior não sabe ler planilha, então cada planilha vira um documento REMOVIDO (original zerado, `removed_at` preenchido):
  // as mensagens seguem mostrando "Arquivo removido" com o nome, os vínculos (mensagem, execução, complemento, versões) ficam e o espaço é
  // liberado. A releitura gravada de uma planilha passa a dizer `document`, o tipo que o schema anterior aceita. Planilhas saem ANTES de os
  // CHECKs antigos voltarem (eles as recusariam). Perde só os originais das planilhas; nenhuma linha é apagada. Idempotente.
  rollback: `
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'attachments' AND column_name = 'file_bytes') THEN
        UPDATE attachments SET kind = 'document', file_bytes = NULL, stored_bytes = 0, removed_at = coalesce(removed_at, now()) WHERE kind = 'spreadsheet';
      END IF;
    END $$;
    UPDATE messages SET data = jsonb_set(data, '{detail,kind}', '"document"'::jsonb)
      WHERE kind = 'activity' AND data->'detail'->>'type' = 'attachment_read' AND data->'detail'->>'kind' = 'spreadsheet';
    ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_check1;
    ALTER TABLE attachments ADD CONSTRAINT attachments_check1 CHECK (removed_at IS NULL OR (image_bytes IS NULL AND extracted_text IS NULL AND stored_bytes = 0));
    ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_check;
    ALTER TABLE attachments ADD CONSTRAINT attachments_check CHECK (removed_at IS NOT NULL OR
      (kind = 'image' AND image_bytes IS NOT NULL AND extracted_text IS NULL) OR
      (kind = 'document' AND image_bytes IS NULL AND extracted_text IS NOT NULL));
    ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_kind_check;
    ALTER TABLE attachments ADD CONSTRAINT attachments_kind_check CHECK (kind IN ('image', 'document'));
    ALTER TABLE attachments DROP COLUMN IF EXISTS file_bytes;
  `,
};

// Migration 0027: arquivos gerados pelo Python como anexos da conversa (phase 4, T7; F8, ATT-01, A18).
//
// Modelagem:
// - kind ganha `generated`: o arquivo que o `run_python` gravou em `/out/` (origem "gerado pelo Python"). Guarda os bytes como vieram em
//   `file_bytes` (a coluna da 0026), sem imagem nem texto extraído, e conta inteiro em `stored_bytes` (o espaço `AION_ATTACHMENTS_MAX_TOTAL_MB`).
// - attachments.format: o formato conferido pelo conteúdo real (png, csv, json, txt, md, xlsx), que decide o tipo de mídia do download e se a
//   tela mostra a imagem inline. Existe se e só se o arquivo é gerado, inclusive depois de removido (o cartão segue sabendo o tipo).
// - Vínculos: o arquivo gerado nasce com `run_id` (a execução que o gerou, então fica "em uso" enquanto ela está ativa) e `message_id` (a atividade
//   do `run_python`, a parte da resposta onde ele aparece). Nenhuma coluna nova para isso.
//
// Aditiva: só cria uma coluna anulável e amplia os CHECKs de tipo e de colunas por tipo (nomes da 0019/0026), mais um CHECK novo do formato; nada
// existente muda, então roda no deploy sem pedido explícito do dono. A API anterior nunca grava `generated` nem lê a coluna nova.
import type { Migration } from '../migrator';

export const generatedAttachmentsMigration: Migration = {
  id: '0027_generated_attachments',
  description: 'Arquivos gerados pelo Python como anexos com formato conferido',
  up: `
    ALTER TABLE attachments ADD COLUMN format text CHECK (format IN ('png', 'csv', 'json', 'txt', 'md', 'xlsx'));
    ALTER TABLE attachments ADD CONSTRAINT attachments_generated_format_check CHECK ((kind = 'generated') = (format IS NOT NULL));
    ALTER TABLE attachments DROP CONSTRAINT attachments_kind_check;
    ALTER TABLE attachments ADD CONSTRAINT attachments_kind_check CHECK (kind IN ('image', 'document', 'spreadsheet', 'generated'));
    ALTER TABLE attachments DROP CONSTRAINT attachments_check;
    ALTER TABLE attachments ADD CONSTRAINT attachments_check CHECK (removed_at IS NOT NULL OR
      (kind = 'image' AND image_bytes IS NOT NULL AND extracted_text IS NULL AND file_bytes IS NULL) OR
      (kind = 'document' AND image_bytes IS NULL AND extracted_text IS NOT NULL AND file_bytes IS NULL) OR
      (kind IN ('spreadsheet', 'generated') AND image_bytes IS NULL AND extracted_text IS NULL AND file_bytes IS NOT NULL));
  `,
  // Rollback: o código anterior não conhece arquivo gerado nem o detalhe `python` da atividade (um detalhe de tipo desconhecido derrubaria a leitura
  // da conversa inteira). Então: (1) cada arquivo gerado vira documento REMOVIDO (bytes zerados, `removed_at` preenchido), como a 0026 faz com a
  // planilha: a atividade segue mostrando "Arquivo removido" com o nome, os vínculos ficam e o espaço é liberado; (2) o detalhe `python` das
  // atividades vira nulo (o resultado textual em `content` fica). Os dois saem ANTES de os CHECKs antigos voltarem. Perde só os bytes dos arquivos
  // gerados e o detalhe estruturado; nenhuma linha é apagada. Idempotente.
  rollback: `
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'attachments' AND column_name = 'format') THEN
        ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_generated_format_check;
        UPDATE attachments SET kind = 'document', format = NULL, file_bytes = NULL, stored_bytes = 0, removed_at = coalesce(removed_at, now()) WHERE kind = 'generated';
      END IF;
    END $$;
    UPDATE messages SET data = jsonb_set(data, '{detail}', 'null'::jsonb) WHERE kind = 'activity' AND data->'detail'->>'type' = 'python';
    ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_check;
    ALTER TABLE attachments ADD CONSTRAINT attachments_check CHECK (removed_at IS NOT NULL OR
      (kind = 'image' AND image_bytes IS NOT NULL AND extracted_text IS NULL AND file_bytes IS NULL) OR
      (kind = 'document' AND image_bytes IS NULL AND extracted_text IS NOT NULL AND file_bytes IS NULL) OR
      (kind = 'spreadsheet' AND image_bytes IS NULL AND extracted_text IS NULL AND file_bytes IS NOT NULL));
    ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_kind_check;
    ALTER TABLE attachments ADD CONSTRAINT attachments_kind_check CHECK (kind IN ('image', 'document', 'spreadsheet'));
    ALTER TABLE attachments DROP COLUMN IF EXISTS format;
  `,
};

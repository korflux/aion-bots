// Migration 0024: complemento durante a execução e rascunho devolvido (phase 4, T2; F5, CONV-03, A8 a A11).
//
// Modelagem:
// - complements: a mensagem que o dono enviou com uma execução ativa. Dois estados, e a linha só existe enquanto está num deles:
//   - `pending`: pertence a uma execução ativa (`run_id`) e espera a próxima fronteira entre etapas. Sai do estado APAGANDO a linha, numa
//     transação sob a trava da execução: absorvido (vira mensagem do dono com a marca "complemento"), promovido (vira execução na fila, no
//     desfecho) ou devolvido (vira o rascunho abaixo). Por apagar, "nunca dois desses" é garantido pelo próprio banco.
//   - `returned`: o RASCUNHO DEVOLVIDO da conversa (parada, "Cancelar" ou excedente de uma promoção), sem execução. Um por conversa
//     (`complements_one_draft`): devoluções seguidas se juntam nele. É entregue uma vez (o consumo apaga a linha) e vence em 24 horas
//     (`returned_at`, limpo pelo job de retenção dos anexos pendentes).
// - attachments.complement_id: anexos do complemento ou do rascunho. Enquanto ligado, o arquivo não é "pendente" do composer (não conta
//   no teto de 5, não é descartável nem vence) e fica "em uso" (não pode ser excluído em Arquivos).
// - conversation_events.kind ganha `draft` (o rascunho mudou ou deixou de existir); o complemento pendente viaja no evento `run` da
//   execução dele, sem tipo novo.
// Aditiva: cria tabela, coluna anulável, índices e amplia um CHECK; nada é removido nem reescrito, então roda no deploy sem pedido explícito
// do dono. Durante o deploy, a API e o worker antigos ignoram a tabela nova (enviar com execução ativa volta a enfileirar).
import type { Migration } from '../migrator';

export const complementsMigration: Migration = {
  id: '0024_complements',
  description: 'Complementos pendentes de execuções ativas e rascunho devolvido da conversa',
  up: `
    CREATE TABLE complements (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      conversation_id uuid NOT NULL REFERENCES conversations (id),
      run_id bigint REFERENCES runs (id),
      state text NOT NULL CHECK (state IN ('pending', 'returned')),
      content text NOT NULL,
      created_at timestamptz NOT NULL,
      returned_at timestamptz,
      CHECK (
        (state = 'pending' AND run_id IS NOT NULL AND returned_at IS NULL AND char_length(content) BETWEEN 1 AND 32000)
        OR (state = 'returned' AND run_id IS NULL AND returned_at IS NOT NULL)
      )
    );
    CREATE INDEX complements_by_run ON complements (run_id, id);
    CREATE INDEX complements_by_conversation ON complements (conversation_id);
    CREATE UNIQUE INDEX complements_one_draft ON complements (conversation_id) WHERE state = 'returned';
    CREATE INDEX complements_draft_expiry ON complements (returned_at) WHERE state = 'returned';

    ALTER TABLE attachments ADD COLUMN complement_id bigint REFERENCES complements (id);
    CREATE INDEX attachments_complement ON attachments (complement_id) WHERE complement_id IS NOT NULL;

    ALTER TABLE conversation_events DROP CONSTRAINT conversation_events_kind_check;
    ALTER TABLE conversation_events ADD CONSTRAINT conversation_events_kind_check CHECK (kind IN ('message', 'run', 'draft'));
  `,
  // Rollback: perde os complementos pendentes e o rascunho devolvido (texto); os anexos deles ficam como pendentes soltos da conversa (a
  // coluna do vínculo sai) e vencem pelo job de 24 horas. Os eventos `draft` saem ANTES de o CHECK antigo voltar (ele os recusaria).
  // Mensagens, execuções, conversas e os demais anexos ficam intactos. Idempotente.
  rollback: `
    DELETE FROM conversation_events WHERE kind = 'draft';
    ALTER TABLE conversation_events DROP CONSTRAINT IF EXISTS conversation_events_kind_check;
    ALTER TABLE conversation_events ADD CONSTRAINT conversation_events_kind_check CHECK (kind IN ('message', 'run'));
    ALTER TABLE attachments DROP COLUMN IF EXISTS complement_id;
    DROP TABLE IF EXISTS complements;
  `,
};

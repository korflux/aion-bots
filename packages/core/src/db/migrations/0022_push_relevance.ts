// Migration 0022: o que o envio de avisos precisa para descartar o evento obsoleto (phase 3, T3; F1/F3; NOTIF-01).
//
// Modelagem:
// - app_opened: UMA linha (dono único, chave booleana presa em `true`, como `app_settings`) com o instante da última abertura do app em
//   qualquer aparelho, na hora do SERVIDOR. Só avança (a escrita usa GREATEST). Nasce na primeira abertura: sem linha, nenhum evento é
//   anterior a uma abertura. Quem grava é a API (`PushService.recordAppOpen`); quem consulta é a regra de validade do aviso
//   (`pushDropReasonOf`), no envio pelo worker e na conferência do service worker.
// - push_events.drop_reason: por que o evento foi descartado, só como código fechado (`presence`, `opened`, `read`, `resolved`, `muted`,
//   `expired`), sem conteúdo. Só existe em evento `dropped`; os descartes antigos (worker sem conta de serviço, tentativas esgotadas) seguem
//   sem motivo, e o log explica esses.
// Aditiva: só cria uma tabela e uma coluna anulável, então roda no deploy sem pedido explícito do dono. Durante o deploy, o worker antigo
// ignora as duas e envia tudo como antes.
import type { Migration } from '../migrator';

export const pushRelevanceMigration: Migration = {
  id: '0022_push_relevance',
  description: 'Última abertura do app e motivo do descarte do aviso',
  up: `
    CREATE TABLE app_opened (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      opened_at timestamptz NOT NULL
    );

    ALTER TABLE push_events ADD COLUMN drop_reason text
      CHECK (drop_reason IS NULL OR (status = 'dropped' AND drop_reason IN ('presence', 'opened', 'read', 'resolved', 'muted', 'expired')));
  `,
  // Rollback: perde só o instante da última abertura e os motivos dos descartes (os eventos continuam `dropped`); dispositivos, eventos,
  // conversas e silêncios ficam intactos.
  rollback: `
    DROP TABLE IF EXISTS app_opened;
    ALTER TABLE push_events DROP COLUMN IF EXISTS drop_reason;
  `,
};

// Migration 0013: matriz de silenciar notificações por bot e por tipo (T13, F14 passo 4; A13).
//
// Modelagem: `push_mutes` guarda só os pares SILENCIADOS (origem do aviso, tipo). Ausência de linha significa "recebe", então um bot novo
// já nasce recebendo tudo e nenhuma linha precisa ser criada por bot ou por tipo.
// - bot_id: o bot de origem do aviso; NULL é o Chat geral (a outra origem de push, `push_events.bot_id` nulo desde a migration 0012).
//   O PostgreSQL trata NULL como distinto em índice único, então a unicidade vale por dois índices parciais: um para os bots e outro para
//   o Chat geral. O índice parcial dos bots também serve de índice da chave estrangeira.
// - kind: a mesma allowlist de `push_events.kind` (spec F14).
// Quem consulta é o despachante do worker (`PushDispatcher.deliver`), no momento do envio: o que o dono silencia vale para o que ainda não
// foi enviado. Quem altera é só o dono, pela API (`PushService.setMute`).
// Aditiva: só cria uma tabela e índices, então roda no deploy sem pedido explícito do dono. Durante o deploy, o worker antigo ignora a
// tabela (envia tudo, como antes da T13), e nada quebra.
import type { Migration } from '../migrator';

export const pushMutesMigration: Migration = {
  id: '0013_push_mutes',
  description: 'Matriz de silenciar notificações por bot e por tipo',
  up: `
    CREATE TABLE push_mutes (
      bot_id uuid REFERENCES bots (id) ON DELETE CASCADE,
      kind text NOT NULL CHECK (kind IN ('run_completed', 'run_failed', 'approval_pending', 'approval_expired')),
      created_at timestamptz NOT NULL
    );
    CREATE UNIQUE INDEX push_mutes_bot_kind ON push_mutes (bot_id, kind) WHERE bot_id IS NOT NULL;
    CREATE UNIQUE INDEX push_mutes_general_kind ON push_mutes (kind) WHERE bot_id IS NULL;
  `,
  // Rollback: apaga as preferências de silenciar (todos os avisos voltam a ser enviados). Nada de bots, execuções, avisos ou dispositivos
  // é tocado.
  rollback: `
    DROP TABLE push_mutes;
  `,
};

// Migration 0011: dispositivos de web push e a caixa de saída (outbox) dos eventos a notificar (T10, F14; NOTIF-01).
//
// Modelagem:
// - push_devices: um dispositivo (navegador ou PWA) registrado para receber push. `token` é o token de registro do FCM, único (registrar o
//   mesmo token de novo só renova `last_seen_at`) e NUNCA volta ao navegador nem vai para log. `label` é o rótulo legível ("Chrome no
//   Windows"). Dono único, então não há coluna de dono. Um token que o FCM recusa como inválido apaga a linha (spec F14).
// - push_events: caixa de saída. Quem muda o estado de uma execução ou de uma aprovação (executor e serviço de aprovações) grava a linha NA
//   MESMA TRANSAÇÃO que registra o desfecho, então o aviso nunca se perde se o processo cair entre os dois, e nunca avisa de um desfecho
//   que não foi gravado. O despachante do worker lê as pendentes, envia e marca. `status`: `pending` (a enviar), `sent` (entregue ao FCM
//   ou sem dispositivo que o receba) ou `dropped` (desistência: FCM sem credencial no worker, ou tentativas esgotadas). `claimed_at` é a
//   posse temporária de quem está enviando (vence e outro retoma), e `attempts` conta as tentativas com falha transitória do FCM. A linha
//   guarda só ids (bot, execução, mensagem do cartão): o título e o corpo do push saem do nome do bot e do tipo na hora do envio, e o
//   conteúdo da conversa nunca é copiado para cá.
// Aditiva: só cria tabelas e índices, então roda no deploy sem pedido explícito do dono.
import type { Migration } from '../migrator';

export const pushMigration: Migration = {
  id: '0011_push',
  description: 'Dispositivos de web push e a caixa de saída dos eventos a notificar',
  up: `
    CREATE TABLE push_devices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      token text NOT NULL UNIQUE CHECK (char_length(token) BETWEEN 1 AND 4096),
      label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
      created_at timestamptz NOT NULL,
      last_seen_at timestamptz NOT NULL
    );

    CREATE TABLE push_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      kind text NOT NULL CHECK (kind IN ('run_completed', 'run_failed', 'approval_pending', 'approval_expired')),
      bot_id uuid NOT NULL REFERENCES bots (id),
      run_id bigint REFERENCES runs (id) ON DELETE CASCADE,
      message_id bigint REFERENCES messages (id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'dropped')),
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      claimed_at timestamptz,
      created_at timestamptz NOT NULL,
      finished_at timestamptz
    );
    CREATE INDEX push_events_pending ON push_events (id) WHERE status = 'pending';
    CREATE INDEX push_events_by_bot ON push_events (bot_id);
    CREATE INDEX push_events_by_run ON push_events (run_id);
    CREATE INDEX push_events_by_message ON push_events (message_id);
  `,
  // Rollback: apaga a caixa de saída (avisos ainda não enviados se perdem) e a lista de dispositivos (o dono precisa ativar de novo). Nada
  // das execuções, aprovações ou conversas é tocado.
  rollback: `
    DROP TABLE push_events;
    DROP TABLE push_devices;
  `,
};

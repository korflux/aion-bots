// Migration 0053: entrega do push por dispositivo, registro do service worker por evento e aparelho, e os motivos de descarte novos (phase 16, passo 1; NOTIF-01; spec A1 e A14).
//
// Para que serve: hoje o funil do push só tem o desfecho do EVENTO (`push_events.status`), e "o aviso não chegou" não se separa entre servidor, FCM, aparelho e Android. As duas tabelas
// novas guardam o destino de cada aviso por dispositivo: o que o FCM respondeu (servidor) e o que o service worker viu (aparelho). Só metadados: ids, estado, status HTTP e instante;
// NENHUM token, título, corpo nem texto da conversa entra aqui.
//
// O que modela:
// - `push_deliveries`: uma linha por tentativa de envio de um evento a um dispositivo. `attempt` é a tentativa do EVENTO (1 a N, como `push_events.attempts + 1`), `http_status` o status
//   HTTP do FCM (nulo quando não houve resposta: rede ou prazo) e `outcome` o desfecho (`accepted`, `rejected_token`, `failed`). Sem UNIQUE: uma queda entre o envio e a gravação repete a
//   tentativa com o mesmo número, e a linha repetida é fato (o envio houve), não conflito.
// - `push_receipts`: o que o service worker reportou, uma linha por evento, dispositivo e estado (`received`, `shown`, `suppressed`, `clicked`; UNIQUE é a idempotência da rota). `reason`
//   só acompanha `shown` (`check_timeout`, opcional: a conferência não respondeu e o aviso saiu por falha aberta) e `suppressed` (`invalid` ou `owner_looking`, obrigatório); `received` e `clicked` não o levam.
// - `device_id` nas duas tabelas é um uuid SEM chave estrangeira para `push_devices`, de propósito: o FCM recusar o token apaga o dispositivo (`DELETE FROM push_devices`), e a entrega
//   `rejected_token` dele precisa ficar para o funil contar o recusado. Uma cascata a apagaria junto, e `SET NULL` perderia o id que liga a entrega ao recibo do aparelho. O custo é que a
//   existência do dispositivo é conferida pelo código (a rota dos recibos), não pelo banco; o id de um dispositivo removido não é reaproveitado (uuid aleatório).
// - `event_id` nas duas tem `ON DELETE CASCADE` para `push_events`: a exclusão do bot apaga os eventos (`bots/service.ts`) e a entrega e o recibo vão junto, sem sobra com id de bot.
// - Retenção: as linhas novas dependem do evento, então saem com ele. O despachante apaga `push_events` tratados há mais de 30 dias (antes 7): a janela de medição do diagnóstico é de 7
//   dias e o descarte com motivo (que mora em `push_events`) não pode sumir na borda dela.
// - `push_events.drop_reason` ganha os códigos `no_fcm_account`, `no_device`, `no_destination` e `attempts_exhausted` (o CHECK da 0022 só aceita os seis da regra de validade; como ele cobre duas colunas, o PostgreSQL o nomeou `push_events_check`, e o nome é mantido). Os eventos
//   antigos nesses desfechos seguem como estão (sem motivo, ou `sent`); não há preenchimento retroativo, que seria palpite.
//
// Aditiva: só cria tabelas e índices e alarga um CHECK, então roda no deploy sem pedido explícito do dono. O worker antigo, durante o deploy, não grava as tabelas novas e segue gravando
// só os seis códigos antigos, que o CHECK novo continua aceitando.
//
// Rollback: apaga as duas tabelas novas (telemetria derivada; entregas e recibos feitos depois do deploy se perdem, nada anterior é tocado) e, ANTES de restaurar o CHECK da 0022, devolve
// as linhas de código novo ao estado anterior: `no_device` e `no_destination` voltam a `sent` (como o código antigo gravava) e `no_fcm_account` e `attempts_exhausted` voltam a `dropped`
// sem motivo. Sem isso o CHECK antigo recusaria as linhas e o rollback falharia. Idempotente (`IF EXISTS`), como pede a prova de rollback das migrations.
import type { Migration } from '../migrator';

/** Os seis códigos da 0022 (regra de validade); o rollback restaura o CHECK só com eles. */
const OLD_DROP_REASONS = "'presence', 'opened', 'read', 'resolved', 'muted', 'expired'";
const NEW_DROP_REASONS = "'no_fcm_account', 'no_device', 'no_destination', 'attempts_exhausted'";

export const pushDeliveryMigration: Migration = {
  id: '0053_push_delivery',
  description: 'Entrega do push por dispositivo, registro do service worker por evento e aparelho, e motivos de descarte novos',
  up: `
    CREATE TABLE IF NOT EXISTS push_deliveries (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      event_id bigint NOT NULL REFERENCES push_events (id) ON DELETE CASCADE,
      device_id uuid NOT NULL,
      attempt integer NOT NULL CHECK (attempt >= 1),
      http_status integer CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
      outcome text NOT NULL CHECK (outcome IN ('accepted', 'rejected_token', 'failed')),
      created_at timestamptz NOT NULL
    );
    CREATE INDEX IF NOT EXISTS push_deliveries_by_event ON push_deliveries (event_id);

    CREATE TABLE IF NOT EXISTS push_receipts (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      event_id bigint NOT NULL REFERENCES push_events (id) ON DELETE CASCADE,
      device_id uuid NOT NULL,
      state text NOT NULL CHECK (state IN ('received', 'shown', 'suppressed', 'clicked')),
      reason text CHECK (reason IN ('invalid', 'owner_looking', 'check_timeout')),
      created_at timestamptz NOT NULL,
      UNIQUE (event_id, device_id, state),
      CHECK (CASE state WHEN 'suppressed' THEN COALESCE(reason IN ('invalid', 'owner_looking'), false) WHEN 'shown' THEN reason IS NULL OR reason = 'check_timeout' ELSE reason IS NULL END)
    );

    ALTER TABLE push_events DROP CONSTRAINT IF EXISTS push_events_check;
    ALTER TABLE push_events ADD CONSTRAINT push_events_check
      CHECK (drop_reason IS NULL OR (status = 'dropped' AND drop_reason IN (${OLD_DROP_REASONS}, ${NEW_DROP_REASONS})));
  `,
  rollback: `
    DROP TABLE IF EXISTS push_receipts;
    DROP TABLE IF EXISTS push_deliveries;

    UPDATE push_events SET status = 'sent', drop_reason = NULL WHERE drop_reason IN ('no_device', 'no_destination');
    UPDATE push_events SET drop_reason = NULL WHERE drop_reason IN ('no_fcm_account', 'attempts_exhausted');
    ALTER TABLE push_events DROP CONSTRAINT IF EXISTS push_events_check;
    ALTER TABLE push_events ADD CONSTRAINT push_events_check
      CHECK (drop_reason IS NULL OR (status = 'dropped' AND drop_reason IN (${OLD_DROP_REASONS})));
  `,
};

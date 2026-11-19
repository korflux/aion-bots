// Migration 0010: rotinas agendadas e o histórico de cada horário previsto (T9, F12 e F13; SCHED-01).
//
// Modelagem:
// - routines: a rotina. `schedule` é a DEFINIÇÃO ESTRUTURADA da agenda (tipo e campos, o que o editor monta); o core gera dela as
//   datas. Início e fim (`starts_local`, `ends_local`) e as horas da agenda são HORÁRIO DE PAREDE no fuso `timezone`, que é como uma
//   recorrência se descreve ("todo dia às 07:00 em Brasília") e o que não muda se o banco de fusos mudar; por isso são texto, e os
//   instantes calculados (`next_run_at` e todo o histórico) são `timestamptz`. `trigger_kind` é o campo de tipo de disparo da
//   spec (hoje só `schedule`; o gatilho por evento do Composio, fase 2, entra como outro valor sem retrabalho). `anchor_at` é de
//   onde "a cada N minutos" conta (início da rotina ou o momento em que a agenda foi criada/editada). `next_run_at` é o próximo
//   horário previsto: nulo se está pausada ou concluída; o índice parcial `routines_due` é o que o agendador consulta.
// - routine_occurrences: UMA linha por horário previsto já tratado, e a garantia de "uma execução por horário previsto, mesmo com
//   reinícios": o índice único (rotina, horário previsto) impede o segundo tratamento do mesmo horário. `outcome`: `fired` (gerou uma
//   execução), `missed` (perdida: o serviço esteve parado por mais de 60 minutos) ou `skipped` (pulada: a execução anterior da
//   rotina ainda esperava na fila, ou a rotina foi pausada/excluída antes de começar). `manual` marca "Executar agora", que fica
//   fora do índice único (dois cliques no mesmo milissegundo não são o mesmo horário previsto). `message_id` é o cartão "perdida".
//   Excluir a rotina apaga o histórico (CASCADE); os cartões já gerados ficam na conversa.
// - runs ganha `routine_id` (zerado à mão quando a rotina é excluída com a execução em andamento) e `routine_name` (o nome na hora do
//   disparo: a tela da fila e o cartão não dependem de a rotina existir). `runs.routine_id` NÃO é chave estrangeira de propósito:
//   o motor atualiza a linha da execução mais de uma vez na transação em que a reivindica, e o PostgreSQL reconfere uma FK a cada
//   atualização de uma linha criada na própria transação; com a FK, excluir a rotina nesse instante travava a transação do motor
//   na linha da rotina e a exclusão na linha da execução (impasse, medido nos testes). A exclusão da rotina zera o campo à mão.
//   `runs.status` ganha `cancelled`: a execução de rotina que saiu da fila sem começar.
// Aditiva para dados existentes: só cria tabelas, colunas anuláveis e índices e amplia a lista de estados aceitos, então roda no
// deploy sem pedido explícito do dono.
import type { Migration } from '../migrator';

export const routinesMigration: Migration = {
  id: '0010_routines',
  description: 'Rotinas agendadas, histórico de horários previstos e a origem de rotina nas execuções',
  up: `
    CREATE TABLE routines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      bot_id uuid NOT NULL REFERENCES bots (id),
      name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
      instruction text NOT NULL CHECK (char_length(instruction) BETWEEN 1 AND 4000),
      trigger_kind text NOT NULL DEFAULT 'schedule' CHECK (trigger_kind IN ('schedule')),
      schedule jsonb NOT NULL,
      timezone text NOT NULL CHECK (char_length(timezone) BETWEEN 1 AND 64),
      starts_local text CHECK (starts_local IS NULL OR starts_local ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$'),
      ends_local text CHECK (ends_local IS NULL OR ends_local ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$'),
      max_runs integer CHECK (max_runs IS NULL OR max_runs BETWEEN 1 AND 10000),
      anchor_at timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed')),
      run_count integer NOT NULL DEFAULT 0 CHECK (run_count >= 0),
      next_run_at timestamptz,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      CHECK (status = 'active' OR next_run_at IS NULL)
    );
    CREATE INDEX routines_by_bot ON routines (bot_id);
    CREATE INDEX routines_due ON routines (next_run_at) WHERE status = 'active';

    ALTER TABLE runs
      ADD COLUMN routine_id uuid,
      ADD COLUMN routine_name text CHECK (routine_name IS NULL OR char_length(routine_name) BETWEEN 1 AND 80);
    CREATE INDEX runs_by_routine ON runs (routine_id);
    ALTER TABLE runs DROP CONSTRAINT runs_status_check;
    ALTER TABLE runs ADD CONSTRAINT runs_status_check CHECK (status IN
      ('queued', 'running', 'waiting_approval', 'completed', 'failed', 'interrupted', 'limit_reached', 'expired', 'cancelled'));

    CREATE TABLE routine_occurrences (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      routine_id uuid NOT NULL REFERENCES routines (id) ON DELETE CASCADE,
      scheduled_for timestamptz NOT NULL,
      outcome text NOT NULL CHECK (outcome IN ('fired', 'missed', 'skipped')),
      manual boolean NOT NULL DEFAULT false,
      run_id bigint REFERENCES runs (id) ON DELETE SET NULL,
      message_id bigint REFERENCES messages (id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL
    );
    CREATE UNIQUE INDEX routine_occurrences_one_per_time ON routine_occurrences (routine_id, scheduled_for) WHERE NOT manual;
    CREATE INDEX routine_occurrences_by_run ON routine_occurrences (run_id);
    CREATE INDEX routine_occurrences_by_message ON routine_occurrences (message_id);
    CREATE INDEX routine_occurrences_history ON routine_occurrences (routine_id, id DESC);
  `,
  // Rollback: apaga as rotinas e o histórico (os dados delas se perdem) e as colunas novas de runs; execuções `cancelled` voltam a
  // `interrupted` (único estado terminal que a lista antiga aceita para uma execução que não chegou a rodar). Os cartões de rotina já
  // gravados em `messages` continuam na conversa, mas a tela antiga não sabe desenhá-los. Bots e conversas não são tocados.
  rollback: `
    DROP TABLE routine_occurrences;
    UPDATE runs SET status = 'interrupted' WHERE status = 'cancelled';
    ALTER TABLE runs DROP CONSTRAINT runs_status_check;
    ALTER TABLE runs ADD CONSTRAINT runs_status_check CHECK (status IN
      ('queued', 'running', 'waiting_approval', 'completed', 'failed', 'interrupted', 'limit_reached', 'expired'));
    DROP INDEX runs_by_routine;
    ALTER TABLE runs DROP COLUMN routine_name, DROP COLUMN routine_id;
    DROP TABLE routines;
  `,
};

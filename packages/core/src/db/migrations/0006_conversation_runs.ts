// Migration 0006: linha do tempo da conversa, execuções e log de eventos (T6, F6 e F7).
//
// Modelagem:
// - conversations ganha a PREFERÊNCIA de modelo e effort da conversa (spec decisão 14): a troca no composer vale até
//   nova troca e não altera o padrão do bot. Nulo = sem preferência (vale o padrão do bot ou o primeiro favorito).
// - runs: uma execução por mensagem (depois também por rotina). É a FILA: a execução nasce `queued` e o worker a reivindica
//   respeitando FIFO por bot. O índice único parcial `runs_one_active_per_bot` é a invariante "uma execução ativa por
//   bot" garantida pelo banco, mesmo com mais de um worker. `trigger_message_id` só é preenchido quando a mensagem do dono
//   entra na linha do tempo (início da execução); `active_ms` é o tempo ativo acumulado (limite de 15 min, persistido para
//   sobreviver a um reinício); `lease_until` é a posse do worker (uma execução `running` com lease vencido perdeu o dono
//   e é retomada) e `lease_owner` é o token de quem a detém (troca a cada reivindicação, então um worker que só travou não
//   continua escrevendo ao lado do novo dono); `stop_requested_at` é o pedido de parada do dono, lido pelo worker.
// - messages: a linha do tempo. `kind` = `text` (dono ou bot), `activity` (chamada de ferramenta) ou `card` (cartão de
//   sistema). `opens_round` marca o início de uma rodada (spec decisão 10: mensagem do dono ou cartão que inicia uma
//   execução); o contexto do modelo é formado pelas últimas 5 rodadas. `step` agrupa o que saiu da mesma chamada do
//   modelo. `content` é o texto (ou, na atividade, o resultado) e `data` os campos específicos do tipo. Texto em
//   `streaming` está sendo escrito; `discarded` é texto ou atividade abandonados por um reinício (ficam invisíveis).
//   O índice GIN é a busca no histórico em português (só texto concluído: atividades não entram).
// - conversation_events: log de INVALIDAÇÃO para o SSE. Guarda só "a linha X mudou"; quem transmite lê o estado atual da
//   linha, então reenviar ou retomar por `Last-Event-ID` é idempotente e nenhum conteúdo é duplicado no log.
// Aditiva: só cria tabelas, colunas e índices, então roda no deploy sem pedido explícito do dono.
import type { Migration } from '../migrator';

export const conversationRunsMigration: Migration = {
  id: '0006_conversation_runs',
  description: 'Mensagens, execuções (fila por bot), eventos da conversa e preferência de modelo da conversa',
  up: `
    ALTER TABLE conversations
      ADD COLUMN preferred_model text CHECK (preferred_model IS NULL OR char_length(preferred_model) BETWEEN 1 AND 200),
      ADD COLUMN preferred_effort text CHECK (preferred_effort IS NULL OR char_length(preferred_effort) BETWEEN 1 AND 32);

    CREATE TABLE runs (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      conversation_id uuid NOT NULL REFERENCES conversations (id),
      bot_id uuid NOT NULL REFERENCES bots (id),
      status text NOT NULL DEFAULT 'queued' CHECK (status IN
        ('queued', 'running', 'waiting_approval', 'completed', 'failed', 'interrupted', 'limit_reached', 'expired')),
      input text NOT NULL CHECK (char_length(input) BETWEEN 1 AND 32000),
      trigger_message_id bigint,
      tool_calls integer NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
      active_ms integer NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
      lease_until timestamptz,
      lease_owner uuid,
      stop_requested_at timestamptz,
      failure_code text CHECK (failure_code IS NULL OR char_length(failure_code) <= 64),
      created_at timestamptz NOT NULL,
      started_at timestamptz,
      finished_at timestamptz
    );
    CREATE UNIQUE INDEX runs_one_active_per_bot ON runs (bot_id) WHERE status IN ('running', 'waiting_approval');
    CREATE INDEX runs_queued ON runs (id) WHERE status = 'queued';
    CREATE INDEX runs_resumable ON runs (lease_until) WHERE status = 'running';
    CREATE INDEX runs_by_conversation ON runs (conversation_id, id);

    CREATE TABLE messages (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      conversation_id uuid NOT NULL REFERENCES conversations (id),
      run_id bigint REFERENCES runs (id),
      role text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      kind text NOT NULL CHECK (kind IN ('text', 'activity', 'card')),
      status text NOT NULL DEFAULT 'done' CHECK (status IN ('streaming', 'done', 'running', 'completed', 'failed', 'discarded')),
      opens_round boolean NOT NULL DEFAULT false,
      step integer,
      content text NOT NULL DEFAULT '',
      data jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL,
      CHECK (
        (kind = 'text' AND role = 'user' AND status IN ('done', 'discarded') AND step IS NULL)
        OR (kind = 'text' AND role = 'assistant' AND status IN ('streaming', 'done', 'discarded') AND step IS NOT NULL)
        OR (kind = 'activity' AND role = 'assistant' AND status IN ('running', 'completed', 'failed', 'discarded') AND step IS NOT NULL)
        OR (kind = 'card' AND role = 'system' AND status = 'done' AND step IS NULL)
      )
    );
    ALTER TABLE runs ADD CONSTRAINT runs_trigger_message_fk FOREIGN KEY (trigger_message_id) REFERENCES messages (id);
    CREATE INDEX messages_timeline ON messages (conversation_id, id);
    CREATE INDEX messages_by_run ON messages (run_id) WHERE run_id IS NOT NULL;
    CREATE INDEX messages_search ON messages USING gin (to_tsvector('portuguese', content))
      WHERE kind <> 'activity' AND status = 'done';

    CREATE TABLE conversation_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      conversation_id uuid NOT NULL REFERENCES conversations (id),
      kind text NOT NULL CHECK (kind IN ('message', 'run')),
      ref bigint NOT NULL,
      created_at timestamptz NOT NULL
    );
    CREATE INDEX conversation_events_cursor ON conversation_events (conversation_id, id);
  `,
  // Rollback: remove eventos, mensagens e execuções (o histórico de conversas se perde) e a preferência da conversa. Só é
  // seguro sem nada que dependa delas; as tasks seguintes (T7 a T14) referenciam estas tabelas, então a ordem de volta
  // desfaz primeiro as migrations posteriores. Bots, memória e modelos não são tocados.
  rollback: `
    DROP TABLE conversation_events;
    ALTER TABLE runs DROP CONSTRAINT runs_trigger_message_fk;
    DROP TABLE messages;
    DROP TABLE runs;
    ALTER TABLE conversations DROP COLUMN preferred_effort, DROP COLUMN preferred_model;
  `,
};

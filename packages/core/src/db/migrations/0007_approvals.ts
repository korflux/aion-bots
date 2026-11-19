// Migration 0007: regras e pedidos de aprovação das ações do Composio (T7, F9 e F10).
//
// Modelagem:
// - approval_actions: as AÇÕES JÁ VISTAS (usadas ou pedidas ao menos uma vez; spec F10 passo 1) e a REGRA GLOBAL de cada uma.
//   A chave é o slug do Composio. `label` e `app_*` são os nomes legíveis que o Composio informa e a tela mostra. A regra global
//   mora na própria linha (e não em outra tabela) porque nasce e some junto da ação: `neutral` é o valor de uma ação sem regra.
// - bot_approval_rules: a regra PRÓPRIA de um bot para uma ação (`allow`, `deny` ou `ask`); ausência de linha = vale o global.
//   Sem exclusão de bot na v1 (spec decisão 16), então a chave estrangeira nunca precisa de cascata.
// - approvals: o PEDIDO gerado quando a regra resolvida é perguntar. Guarda o que a execução precisa para retomar do ponto exato
//   sem nenhum estado em memória: a chamada barrada (`call`), as chamadas que o modelo pediu DEPOIS dela na mesma etapa
//   (`remaining`), a etapa e a atividade que a representa. `consumed_at` marca que o executor já tratou a decisão (o índice
//   único garante UM pedido aberto por execução: pendente, ou decidido e ainda não consumido). `card_id` é a mensagem do cartão
//   na conversa, atualizada na mesma transação de cada mudança de estado. `status` acrescenta `cancelled` aos quatro da spec:
//   o dono parou a execução enquanto o pedido esperava.
// Aditiva: só cria tabelas e índices, então roda no deploy sem pedido explícito do dono.
import type { Migration } from '../migrator';

export const approvalsMigration: Migration = {
  id: '0007_approvals',
  description: 'Ações vistas com regra global, regras por bot e pedidos de aprovação das ações do Composio',
  up: `
    CREATE TABLE approval_actions (
      slug text PRIMARY KEY CHECK (char_length(slug) BETWEEN 1 AND 128),
      app_slug text NOT NULL CHECK (char_length(app_slug) BETWEEN 1 AND 100),
      app_name text NOT NULL CHECK (char_length(app_name) BETWEEN 1 AND 100),
      label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200),
      global_rule text NOT NULL DEFAULT 'neutral' CHECK (global_rule IN ('allow', 'deny', 'ask', 'neutral')),
      first_seen_at timestamptz NOT NULL,
      last_seen_at timestamptz NOT NULL
    );

    CREATE TABLE bot_approval_rules (
      bot_id uuid NOT NULL REFERENCES bots (id),
      action_slug text NOT NULL REFERENCES approval_actions (slug),
      value text NOT NULL CHECK (value IN ('allow', 'deny', 'ask')),
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (bot_id, action_slug)
    );

    CREATE TABLE approvals (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      run_id bigint NOT NULL REFERENCES runs (id),
      bot_id uuid NOT NULL REFERENCES bots (id),
      conversation_id uuid NOT NULL REFERENCES conversations (id),
      action_slug text NOT NULL REFERENCES approval_actions (slug),
      step integer NOT NULL,
      activity_id bigint NOT NULL REFERENCES messages (id),
      card_id bigint REFERENCES messages (id),
      call jsonb NOT NULL,
      remaining jsonb NOT NULL DEFAULT '[]',
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'cancelled')),
      decision text CHECK (decision IS NULL OR decision IN ('allow_once', 'deny', 'allow_always', 'deny_always')),
      created_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      decided_at timestamptz,
      consumed_at timestamptz
    );
    CREATE INDEX approvals_pending ON approvals (expires_at) WHERE status = 'pending';
    CREATE INDEX approvals_by_run ON approvals (run_id);
    CREATE UNIQUE INDEX approvals_one_open_per_run ON approvals (run_id)
      WHERE status = 'pending' OR (status IN ('approved', 'denied') AND consumed_at IS NULL);
  `,
  // Rollback: remove os pedidos, as regras por bot e as ações vistas (as regras que o dono definiu se perdem). Cartões de aprovação
  // já gravados em `messages` continuam na conversa como histórico, mas deixam de ser respondíveis; execuções que esperavam
  // aprovação precisam ser encerradas manualmente (status `interrupted`) antes de voltar o código.
  rollback: `
    DROP TABLE approvals;
    DROP TABLE bot_approval_rules;
    DROP TABLE approval_actions;
  `,
};

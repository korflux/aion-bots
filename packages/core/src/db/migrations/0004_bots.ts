// Migration 0004: bots, conversa única e memória inicial (T4, F5).
//
// Modelagem (PROD-02: uma conversa contínua por bot):
// - bots: os campos editáveis do F5 mais `archived_at` (arquivar não apaga nada, spec decisão 16).
//   `name_key` é o nome sem distinção de maiúsculas, calculado no core (`nameKeyOf`), e o índice único PARCIAL
//   sobre ele garante "nome único entre bots não arquivados" mesmo com criações concorrentes. Fica no core, e
//   não em `lower(name)` do banco, porque `lower()` depende do locale do cluster (ASCII só em `C`) e a regra
//   precisa valer igual em qualquer ambiente.
// - conversations: registro 1:1 do bot (`bot_id` único), criado junto com ele. Só a identidade da conversa existe
//   aqui; T6 acrescenta as mensagens e execuções apontando para `conversations.id`.
// - bot_memories: a memória do bot, nasce vazia com o bot. T8 acrescenta a versão esperada e a tabela de
//   versões em cima desta linha (ALTER TABLE ... ADD COLUMN, sem reescrever o que existe).
// Não há exclusão de bot na v1, por isso as chaves estrangeiras não têm ON DELETE (o padrão recusa apagar).
//
// Plano de rollback (registrado em `rollback`): apaga as três tabelas na ordem inversa das dependências. Só é
// seguro antes de existirem mensagens, execuções ou versões de memória apontando para elas (T6, T8), pois
// essas tasks dependem destas tabelas; depois delas, o rollback precisa desfazer as migrations posteriores antes.
import type { Migration } from '../migrator';

export const botsMigration: Migration = {
  id: '0004_bots',
  description: 'Bots, conversa única por bot e memória inicial vazia',
  up: `
    CREATE TABLE bots (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
      name_key text NOT NULL CHECK (char_length(name_key) >= 1),
      color text NOT NULL CHECK (color ~ '^#[0-9A-F]{6}$'),
      instructions text NOT NULL DEFAULT '' CHECK (char_length(instructions) <= 8000),
      model text CHECK (model IS NULL OR char_length(model) BETWEEN 1 AND 200),
      effort text CHECK (effort IS NULL OR char_length(effort) BETWEEN 1 AND 32),
      step_limit integer NOT NULL DEFAULT 25 CHECK (step_limit BETWEEN 1 AND 100),
      archived_at timestamptz,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    CREATE UNIQUE INDEX bots_active_name_key ON bots (name_key) WHERE archived_at IS NULL;

    CREATE TABLE conversations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      bot_id uuid NOT NULL UNIQUE REFERENCES bots (id),
      created_at timestamptz NOT NULL
    );

    CREATE TABLE bot_memories (
      bot_id uuid PRIMARY KEY REFERENCES bots (id),
      content text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL
    );
  `,
  rollback: `
    DROP TABLE bot_memories;
    DROP TABLE conversations;
    DROP TABLE bots;
  `,
};

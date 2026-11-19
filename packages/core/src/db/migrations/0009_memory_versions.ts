// Migration 0009: memória global e versões da memória (T8, F11; MEM-01 e MEM-02).
//
// Modelagem:
// - bot_memories (criada na 0004): ganha a VERSÃO ATUAL (`version`, 0 = nunca gravada) e quem/quando gravou por último. O texto
//   atual continua na própria linha, para o contexto do modelo ler com uma consulta simples; o histórico fica em memory_versions.
// - global_memory: a memória global, uma linha só (`id = 1`, garantido por CHECK) criada aqui mesmo, vazia. Dono único, sem
//   multi-tenant; a linha existir desde a migration evita "criar na primeira vez" com corrida.
// - memory_versions: uma linha IMUTÁVEL por gravação (versão, texto inteiro, autor, de qual versão veio se foi restauração e o
//   tamanho da mudança em linhas). `bot_id` nulo é a memória global. O texto inteiro é guardado (e não só o diff) porque restaurar
//   precisa dele e a memória é pequena (até 8.000 caracteres). Os dois índices únicos parciais garantem versões sem repetição por
//   memória mesmo com gravações concorrentes; o de `bot_id` também atende a chave estrangeira (a conferência da FK procura só
//   valores não nulos). O índice por data serve ao job diário de retenção.
// - O limite de 8.000 caracteres é também CHECK no banco (`char_length` conta pontos de código, igual ao contador da tela), como
//   última defesa se algum caminho esquecer a regra do core.
// Aditiva: acrescenta colunas com padrão, tabelas e índices, então roda no deploy sem pedido explícito do dono.
import type { Migration } from '../migrator';

export const memoryVersionsMigration: Migration = {
  id: '0009_memory_versions',
  description: 'Versão atual das memórias, memória global e histórico imutável de versões',
  up: `
    ALTER TABLE bot_memories
      ADD COLUMN version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
      ADD COLUMN updated_at timestamptz,
      ADD COLUMN updated_by text CHECK (updated_by IS NULL OR updated_by IN ('owner', 'bot')),
      ADD CONSTRAINT bot_memories_content_size CHECK (char_length(content) <= 8000);

    CREATE TABLE global_memory (
      id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      content text NOT NULL DEFAULT '' CHECK (char_length(content) <= 8000),
      version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
      updated_at timestamptz,
      updated_by text CHECK (updated_by IS NULL OR updated_by IN ('owner', 'bot'))
    );
    INSERT INTO global_memory (id) VALUES (1);

    CREATE TABLE memory_versions (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      bot_id uuid REFERENCES bots (id),
      version integer NOT NULL CHECK (version >= 1),
      content text NOT NULL CHECK (char_length(content) <= 8000),
      author text NOT NULL CHECK (author IN ('owner', 'bot')),
      restored_from integer CHECK (restored_from IS NULL OR restored_from >= 1),
      added integer NOT NULL CHECK (added >= 0),
      removed integer NOT NULL CHECK (removed >= 0),
      created_at timestamptz NOT NULL
    );
    CREATE UNIQUE INDEX memory_versions_bot_version ON memory_versions (bot_id, version) WHERE bot_id IS NOT NULL;
    CREATE UNIQUE INDEX memory_versions_global_version ON memory_versions (version) WHERE bot_id IS NULL;
    CREATE INDEX memory_versions_by_age ON memory_versions (created_at);
  `,
  // Rollback: apaga o histórico de versões e a memória global (o texto da memória global se perde; o texto atual de cada bot
  // continua em bot_memories.content) e remove as colunas novas de bot_memories. Cartões "Memória atualizada" já gravados em
  // `messages` continuam na conversa, mas o desfazer deles deixa de funcionar.
  rollback: `
    DROP TABLE memory_versions;
    DROP TABLE global_memory;
    ALTER TABLE bot_memories
      DROP CONSTRAINT bot_memories_content_size,
      DROP COLUMN updated_by,
      DROP COLUMN updated_at,
      DROP COLUMN version;
  `,
};

// Migration 0005: perfil por modelo do provedor, com favorito e resultado do teste da primeira seleção (T5, F8).
//
// Tabela `model_profiles`: uma linha por modelo que o dono favoritou ou testou; o catálogo em si (quais modelos existem)
// NÃO é gravado, vem do provedor a cada consulta. Modelo sem linha = nunca testado e não favorito.
// - `favorited_at`: nulo = não é favorito. A ordem dos favoritos é a de quando foram marcados (o "primeiro favorito"
//   da spec F5 é o mais antigo).
// - `test_*`: o último teste. `test_status` e `tested_at` andam juntos (ambos nulos = nunca testado). `test_protocol` é o
//   formato de API em que o modelo respondeu (o motor de execução da T6 chama o modelo nesse formato); nulo quando o
//   teste falhou em todos. `effort_levels` são os níveis que o provedor aceitou, descobertos no teste.
// Aditiva: só cria tabela, então roda no deploy sem pedido explícito do dono.
import type { Migration } from '../migrator';

export const modelsMigration: Migration = {
  id: '0005_models',
  description: 'Perfil por modelo: favorito e resultado do teste (status, protocolo e níveis de effort)',
  up: `
    CREATE TABLE model_profiles (
      model_id text PRIMARY KEY CHECK (char_length(model_id) BETWEEN 1 AND 200),
      favorited_at timestamptz,
      test_status text CHECK (test_status IN ('ok', 'no_tools', 'failed')),
      test_reason text CHECK (test_reason IN ('unsupported', 'bad_stream', 'empty_response', 'no_tool_call')),
      test_protocol text CHECK (test_protocol IN ('chat_completions', 'messages', 'responses')),
      effort_levels text[] NOT NULL DEFAULT '{}',
      tested_at timestamptz,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      CHECK ((test_status IS NULL) = (tested_at IS NULL)),
      CHECK (test_status IS NOT NULL OR (test_reason IS NULL AND test_protocol IS NULL AND effort_levels = '{}'))
    );
  `,
  // Rollback: remove a tabela. Favoritos e resultados de teste somem; os modelos voltam a ser testados na primeira
  // seleção. Bots guardam só o id do modelo (texto), então nenhuma outra tabela depende desta.
  rollback: `
    DROP TABLE model_profiles;
  `,
};

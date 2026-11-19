// Migration 0003: chaves de terceiros (T3), a do provedor OpenCode Go e a do conector Composio.
//
// Tabela `credentials`: no máximo uma linha por `kind` (dono único, uma conta de cada serviço, CONN-01).
// - `secret_sealed`: a chave cifrada com AES-256-GCM (`sealSecret`, formato `v1.iv.tag.texto`). A chave em
//   texto claro NUNCA é gravada; sem a AION_MASTER_KEY o banco sozinho não a revela (OPS-01).
// - `masked`: versão exibível ("••••a1b2"), calculada ao salvar para a tela de estado não precisar decifrar.
// - `model_count`: modelos vistos na última validação do provedor (a tela mostra o total); nulo no conector.
// Aditiva: só cria tabela, então roda no deploy sem pedido explícito do dono.
import type { Migration } from '../migrator';

export const credentials: Migration = {
  id: '0003_credentials',
  description: 'Chaves do OpenCode Go e do Composio, cifradas, com versão mascarada',
  up: `
    CREATE TABLE credentials (
      kind text PRIMARY KEY CHECK (kind IN ('provider', 'connector')),
      secret_sealed text NOT NULL CHECK (char_length(secret_sealed) <= 2048),
      masked text NOT NULL CHECK (char_length(masked) <= 16),
      model_count integer CHECK (model_count >= 0),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
  `,
  // Rollback: remove a tabela. As chaves somem e precisam ser inseridas de novo pela tela de Configurações.
  rollback: `
    DROP TABLE credentials;
  `,
};

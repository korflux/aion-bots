// Migration 0028: remove a coluna `bots.mascot` (phase 5, T2, DATA-01). O dono não escolhe mais personagem para o bot: a identidade visual
// é a Faísca, uma só, na cor do bot (a 0018 tinha criado a coluna, com seis personagens). Nada relevante se perde: o que a coluna guardava era
// só essa escolha, e a escolha deixou de existir.
//
// DESTRUTIVA (`destructive: true`): remove uma coluna com dados, então o migrator só a aplica com `AION_ALLOW_DESTRUCTIVE_MIGRATIONS=true`
// (o dono liga a variável no Easypanel antes do push que publica a migration e a desliga depois do deploy confirmado). Sem a variável a API
// recusa subir, com a mensagem do migrator citando esta migration. Durante o deploy, um worker ou API antigo ainda em pé lê/escreve `mascot` e
// falha até ser substituído; a janela é a troca de contêiner, e o worker novo espera o schema (`waitForSchema`) antes de rodar.
//
// ROLLBACK (manual, pelo dono): recria a coluna como a 0018 a criou (texto obrigatório, DEFAULT 'circle', CHECK com os seis ids) e refaz o
// MESMO preenchimento determinístico dos bots que existem, pelo id (fórmula da 0018: 7 primeiros dígitos hex do id, módulo 6, indexando a lista
// fixa). O personagem que cada bot tinha antes da 0028 NÃO volta: a 0028 o descartou, e o rollback devolve o valor calculado do id, o mesmo que
// a 0018 daria a um bot novo no banco. Depois dele, o código anterior à phase 5 volta a funcionar (ele lê e grava `mascot`).
// Os seis ids ficam aqui, e só aqui (além da 0018 e dos testes das duas), porque recriar a coluna exige o CHECK com a lista antiga.
import type { Migration } from '../migrator';

export const dropBotMascotMigration: Migration = {
  id: '0028_drop_bot_mascot',
  description: 'Remove bots.mascot (o personagem do bot deixa de existir; a identidade é a Faísca)',
  destructive: true,
  up: `
    ALTER TABLE bots DROP COLUMN IF EXISTS mascot;
  `,
  // Idempotente: só recria e preenche se a coluna não existe. Rodar o rollback de novo (ou depois de a coluna já ter sido recriada, com valores
  // que o dono possa ter editado pelo código antigo) não recalcula nada. `DO` porque o `IF` precisa da conferência do catálogo.
  rollback: `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'bots' AND column_name = 'mascot'
      ) THEN
        ALTER TABLE bots ADD COLUMN mascot text NOT NULL DEFAULT 'circle'
          CHECK (mascot IN ('circle', 'square', 'triangle', 'diamond', 'hexagon', 'pill'));
        UPDATE bots
          SET mascot = (ARRAY['circle', 'square', 'triangle', 'diamond', 'hexagon', 'pill'])[1 + (('x' || substr(id::text, 1, 7))::bit(28)::int % 6)];
      END IF;
    END
    $$;
  `,
};

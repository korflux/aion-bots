// Migration 0018: personagem do mascote de cada bot (phase 1, T10, F9): a coluna `bots.mascot`.
//
// O que muda:
// - `bots.mascot`: texto OBRIGATÓRIO restrito por CHECK aos seis ids da lista fixa `BOT_MASCOTS` de @aion/shared (circle, square, triangle, diamond,
//   hexagon, pill), com DEFAULT 'circle' (a Bolinha, o personagem padrão de bot novo). O serviço sempre grava o valor no INSERT; o DEFAULT cobre quem
//   escreve sem informá-lo (testes e o deploy em andamento, em que um `api` antigo ainda cria bots sem o campo). A lista é uma constante no código e
//   no CHECK, e não uma tabela: personagem novo exige desenho novo no app, então vem junto com uma migration que alarga o CHECK.
// - PREENCHIMENTO DETERMINÍSTICO dos bots que já existem, a partir do id: personagem = `BOT_MASCOTS[ int(7 primeiros dígitos hex do id) mod 6 ]`, ou seja,
//   `('x' || substr(id::text, 1, 7))::bit(28)::int % 6` indexando a lista. É estável e permanente: depende só do id, que nunca muda, então o mesmo bot
//   sempre dá o mesmo personagem (inclusive se a migration for revertida e reaplicada), e bots diferentes se espalham pelos seis (o id é um UUID v4
//   aleatório). 28 bits (7 dígitos) mantêm o número não negativo dentro de `int`, sem `abs()`. Depois do preenchimento o valor é só dado: o dono troca
//   o personagem no editor e nada mais recalcula.
//
// Aditiva: acrescenta uma coluna com padrão e escreve só nessa coluna nova, então nenhum outro dado é tocado e roda no deploy sem pedido explícito do
// dono. Durante o deploy, a API e o worker antigos ignoram a coluna.
import type { Migration } from '../migrator';

export const botMascotMigration: Migration = {
  id: '0018_bot_mascot',
  description: 'Personagem do mascote de cada bot (bots.mascot), com preenchimento determinístico a partir do id',
  up: `
    ALTER TABLE bots ADD COLUMN mascot text NOT NULL DEFAULT 'circle'
      CHECK (mascot IN ('circle', 'square', 'triangle', 'diamond', 'hexagon', 'pill'));
    UPDATE bots
      SET mascot = (ARRAY['circle', 'square', 'triangle', 'diamond', 'hexagon', 'pill'])[1 + (('x' || substr(id::text, 1, 7))::bit(28)::int % 6)];
  `,
  // Rollback: remove só a coluna `mascot` (o personagem escolhido se perde; ao reaplicar a migration, cada bot volta ao personagem calculado do
  // id). Idempotente (`IF EXISTS`). Bots, conversas, memórias, rotinas, nome, cor e demais campos não são tocados. O CHECK da coluna sai com ela.
  rollback: `
    ALTER TABLE bots DROP COLUMN IF EXISTS mascot;
  `,
};

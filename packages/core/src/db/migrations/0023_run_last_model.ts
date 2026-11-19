// Migration 0023: o modelo que gerou cada resposta (phase 4, T1; F7, A13).
//
// Modelagem: `runs.last_model` guarda o ID do modelo da ÚLTIMA chamada ao provedor da execução. O executor grava a coluna antes de cada
// chamada (o modelo pode mudar entre etapas, `resolveModelChoice` é relido a cada uma), então ao fim ela tem o da chamada que produziu a
// resposta final. A view da resposta do assistente (`readMessageViews`) lê a coluna pela execução da mensagem.
// Execuções anteriores a esta migration ficam com NULL: as respostas antigas não mostram modelo (decisão da spec, sem preenchimento
// retroativo, que seria um palpite).
// Aditiva: só cria uma coluna anulável, então roda no deploy sem pedido explícito do dono; o worker antigo, durante o deploy, a ignora.
import type { Migration } from '../migrator';

export const runLastModelMigration: Migration = {
  id: '0023_run_last_model',
  description: 'Modelo da última chamada ao provedor de cada execução',
  up: 'ALTER TABLE runs ADD COLUMN last_model text CHECK (last_model IS NULL OR char_length(last_model) BETWEEN 1 AND 200);',
  // Rollback: perde só o registro do modelo das respostas (elas voltam a não mostrá-lo); execuções, mensagens e conversas ficam intactas.
  rollback: 'ALTER TABLE runs DROP COLUMN IF EXISTS last_model;',
};

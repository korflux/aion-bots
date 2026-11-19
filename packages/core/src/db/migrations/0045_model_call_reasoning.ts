// Migration 0045: tokens de raciocínio por chamada ao modelo (phase 10, T8; spec A16).
//
// Modelagem: `model_call_usage.reasoning_tokens` guarda a FATIA da saída que o provedor informou ter gasto em raciocínio
// (`completion_tokens_details.reasoning_tokens` no chat_completions, `output_tokens_details.reasoning_tokens` no responses). É uma parte de `output_tokens`, não um
// acréscimo: o total de saída continua sendo `output_tokens`, que o provedor já cobra por inteiro, então nenhum cálculo de custo muda.
// NULL significa "o provedor não informou" (protocolo messages, provedor que omite o campo ou valor inválido) e NÃO equivale a 0; o relatório de custo
// (`usage/cost-report.ts`) distingue os dois. As linhas anteriores a esta migration ficam NULL, sem preenchimento retroativo (seria um palpite).
//
// Aditiva: só cria uma coluna anulável, então roda no deploy sem pedido explícito do dono; o worker antigo, durante o deploy, não a escreve e a linha fica NULL.
// Rollback: remove só a coluna. É telemetria derivada (não é consumo faturado nem conteúdo da conversa), então descartá-la só perde a separação
// do raciocínio no relatório; chamadas, checkpoints e conversas ficam intactos. Idempotente (`IF [NOT] EXISTS`), como pede a prova de rollback das migrations.
import type { Migration } from '../migrator';

export const modelCallReasoningMigration: Migration = {
  id: '0045_model_call_reasoning',
  description: 'Tokens de raciocínio informados pelo provedor por chamada ao modelo (fatia da saída, anulável)',
  up: 'ALTER TABLE model_call_usage ADD COLUMN IF NOT EXISTS reasoning_tokens bigint CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0);',
  rollback: 'ALTER TABLE model_call_usage DROP COLUMN IF EXISTS reasoning_tokens;',
};

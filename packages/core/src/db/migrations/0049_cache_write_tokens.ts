// Migration 0049: tokens de GRAVAÇÃO de cache por chamada ao modelo (phase 12, T3; spec A10 e A11).
//
// Modelagem: `model_call_usage.cache_write_tokens` guarda a fatia da entrada que o provedor gravou no cache nesta chamada (`cache_creation_input_tokens` do protocolo
// `messages`, onde o cache é explícito por `cache_control`). É uma PARTE de `input_tokens`, que continua o total do pedido (leitura e gravação incluídas, CTX-08), e fica
// separada de `cached_tokens` (a leitura) porque a gravação custa mais que a entrada comum (1,25 vez no cache de 5 minutos) e o relatório de custo (`usage/cost-report.ts`)
// precisa cobrá-la pelo preço próprio. NULL significa "o provedor não informou" (chat_completions e responses, onde o cache é automático, ou provedor que omite o campo) e NÃO
// equivale a 0. As linhas anteriores a esta migration ficam NULL, sem preenchimento retroativo (seria um palpite).
//
// Aditiva: só cria uma coluna anulável, então roda no deploy sem pedido explícito do dono; o worker antigo, durante o deploy, não a escreve e a linha fica NULL.
// Rollback: remove só a coluna. É telemetria derivada (não é conteúdo da conversa), então descartá-la só perde a separação da gravação no relatório; chamadas, checkpoints
// e conversas ficam intactos. Idempotente (`IF [NOT] EXISTS`), como pede a prova de rollback das migrations.
import type { Migration } from '../migrator';

export const cacheWriteTokensMigration: Migration = {
  id: '0049_cache_write_tokens',
  description: 'Tokens de gravação de cache informados pelo provedor por chamada ao modelo (fatia da entrada, anulável)',
  up: 'ALTER TABLE model_call_usage ADD COLUMN IF NOT EXISTS cache_write_tokens integer CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0);',
  rollback: 'ALTER TABLE model_call_usage DROP COLUMN IF EXISTS cache_write_tokens;',
};

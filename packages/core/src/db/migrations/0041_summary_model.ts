// Modelo do resumo da compactação de contexto (phase 9, T4; spec Decisão 6 e A13).
//
// O que muda: `app_settings.summary_model`, coluna opcional com o id do modelo que o dono escolheu em Configurações → Preferências para
// resumir conversas longas. Nulo (o padrão de toda linha existente) significa "o modelo da conversa", exatamente o comportamento de antes,
// então a migration é aditiva: nenhum dado é reescrito e o código antigo, que não conhece a coluna, segue funcionando durante o deploy.
//
// O CHECK limita o tamanho (1 a 200 caracteres, o mesmo teto de `model_profiles.model_id`); que o id seja um modelo validado NÃO é checado aqui:
// é regra do serviço de configurações, que consulta `model_profiles` na gravação e de novo no uso (um modelo validado hoje pode ser invalidado
// por um novo teste amanhã, e uma constraint de banco não acompanharia isso).
//
// Rollback: remove só a coluna. A escolha do dono se perde (é uma preferência de um clique, nenhum conteúdo some) e o resumo volta a usar o
// modelo da conversa. Idempotente (`IF EXISTS`), como pede a prova de rollback das migrations.
import type { Migration } from '../migrator';

export const summaryModelMigration: Migration = {
  id: '0041_summary_model',
  description: 'Modelo opcional do resumo de contexto em app_settings (nulo = modelo da conversa)',
  up: `ALTER TABLE app_settings
      ADD COLUMN IF NOT EXISTS summary_model text CHECK (summary_model IS NULL OR char_length(summary_model) BETWEEN 1 AND 200);`,
  rollback: 'ALTER TABLE app_settings DROP COLUMN IF EXISTS summary_model;',
};

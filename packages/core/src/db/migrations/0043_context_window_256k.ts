// Janela de contexto de 256k (262144 tokens) como quarta opção, ao lado de 32k, 64k e 128k (decisão do dono em 16/10/2026, phase 9).
//
// O que muda: só os três CHECKs de presets criados pela 0033 (os dois globais de `app_settings` e o override de `bots`), que passam a aceitar 262144.
// Nenhum valor nem DEFAULT é tocado. Os nomes `<tabela>_<coluna>_check` são os que o PostgreSQL gerou para os CHECKs de coluna da 0033.
// Aditiva: o código antigo nunca grava 262144, então API, web e worker antigos seguem funcionando durante o deploy.
//
// Rollback: quem escolheu 256k volta para 128k (o maior preset anterior; é uma preferência de um clique, nenhum conteúdo se perde), e os CHECKs
// voltam aos três presets. Sem esse UPDATE o CHECK antigo não poderia ser recriado com uma linha em 262144.
import type { Migration } from '../migrator';

export const contextWindow256kMigration: Migration = {
  id: '0043_context_window_256k',
  description: 'Janela de contexto de 256k como opção dos globais e do override por bot',
  up: `ALTER TABLE app_settings
      DROP CONSTRAINT IF EXISTS app_settings_bot_context_window_tokens_check,
      DROP CONSTRAINT IF EXISTS app_settings_general_chat_context_window_tokens_check,
      ADD CONSTRAINT app_settings_bot_context_window_tokens_check CHECK (bot_context_window_tokens IN (32768,65536,131072,262144)),
      ADD CONSTRAINT app_settings_general_chat_context_window_tokens_check CHECK (general_chat_context_window_tokens IN (32768,65536,131072,262144));
    ALTER TABLE bots
      DROP CONSTRAINT IF EXISTS bots_context_window_tokens_check,
      ADD CONSTRAINT bots_context_window_tokens_check CHECK (context_window_tokens IN (32768,65536,131072,262144));`,
  rollback: `UPDATE app_settings
      SET bot_context_window_tokens = CASE WHEN bot_context_window_tokens = 262144 THEN 131072 ELSE bot_context_window_tokens END,
          general_chat_context_window_tokens = CASE WHEN general_chat_context_window_tokens = 262144 THEN 131072 ELSE general_chat_context_window_tokens END
      WHERE bot_context_window_tokens = 262144 OR general_chat_context_window_tokens = 262144;
    UPDATE bots SET context_window_tokens = 131072 WHERE context_window_tokens = 262144;
    ALTER TABLE app_settings
      DROP CONSTRAINT IF EXISTS app_settings_bot_context_window_tokens_check,
      DROP CONSTRAINT IF EXISTS app_settings_general_chat_context_window_tokens_check,
      ADD CONSTRAINT app_settings_bot_context_window_tokens_check CHECK (bot_context_window_tokens IN (32768,65536,131072)),
      ADD CONSTRAINT app_settings_general_chat_context_window_tokens_check CHECK (general_chat_context_window_tokens IN (32768,65536,131072));
    ALTER TABLE bots
      DROP CONSTRAINT IF EXISTS bots_context_window_tokens_check,
      ADD CONSTRAINT bots_context_window_tokens_check CHECK (context_window_tokens IN (32768,65536,131072));`,
};

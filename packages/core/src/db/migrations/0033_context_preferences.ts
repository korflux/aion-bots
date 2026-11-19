// Aditiva: globals independentes e override por bot. Rollback de aplicação conserva escolhas.
import type { Migration } from '../migrator';
export const contextPreferencesMigration: Migration = {
  id: '0033_context_preferences', description: 'Preferências de janela de contexto por escopo e bot',
  up: `ALTER TABLE app_settings
    ADD COLUMN bot_context_window_tokens integer NOT NULL DEFAULT 32768 CHECK (bot_context_window_tokens IN (32768,65536,131072)),
    ADD COLUMN general_chat_context_window_tokens integer NOT NULL DEFAULT 32768 CHECK (general_chat_context_window_tokens IN (32768,65536,131072));
    ALTER TABLE bots ADD COLUMN context_window_tokens integer CHECK (context_window_tokens IN (32768,65536,131072));`,
  rollback: `DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM app_settings WHERE bot_context_window_tokens <> 32768 OR general_chat_context_window_tokens <> 32768)
       OR EXISTS (SELECT 1 FROM bots WHERE context_window_tokens IS NOT NULL) THEN
      RAISE EXCEPTION 'Preserve preferências de contexto no rollback de aplicação';
    END IF;
  END $$;
  ALTER TABLE bots DROP COLUMN IF EXISTS context_window_tokens;
  ALTER TABLE app_settings DROP COLUMN IF EXISTS bot_context_window_tokens, DROP COLUMN IF EXISTS general_chat_context_window_tokens;`,
};

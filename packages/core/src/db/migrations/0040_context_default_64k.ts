// Padrão da janela de contexto passa de 32k para 64k (decisão do dono em 12/10/2026, phase 8).
//
// O que muda: só os dois globais de `app_settings` (bots e Chat geral), que a 0033 criou com DEFAULT 32768.
// - O DEFAULT das colunas vira 65536, para qualquer linha futura de `app_settings` (hoje é singleton, então vale como rede de segurança).
// - Os valores globais que ainda estão em 32768 viram 65536: eram o padrão antigo e, por decisão do dono, nunca foram uma escolha dele.
// - Nada em `bots.context_window_tokens` é tocado: um override explícito por bot (inclusive 32k) continua valendo exatamente como estava.
// O CHECK dos presets (32768, 65536, 131072) não muda; 64k já era uma opção válida, então API, web e worker antigos seguem funcionando durante o deploy.
//
// Limitação conhecida, sem pendência: o UPDATE não distingue um 32k escolhido de propósito pelo dono do 32k que veio do padrão antigo (a coluna não guarda proveniência).
// O padrão voltou a mudar na 0046 (256k, phase 11), que fez o mesmo UPDATE incondicional nos globais por decisão do dono (ver a "Nota" dela), então a distinção não chegou a importar.
//
// Rollback: devolve o DEFAULT a 32768 e é o inverso exato do `up` nos globais (65536 volta a 32768). Pelo mesmo motivo acima, um 64k escolhido
// pelo dono depois do deploy volta a 32k (é uma preferência de um clique, nenhum conteúdo se perde). Sem essa volta, a guarda do rollback da 0033
// ("Preserve preferências de contexto") recusaria desfazer a cadeia, porque o 64k migrado pareceria uma escolha do dono. Overrides por bot ficam intactos.
import type { Migration } from '../migrator';

export const contextDefault64kMigration: Migration = {
  id: '0040_context_default_64k',
  description: 'Padrão da janela de contexto dos globais passa de 32k para 64k',
  up: `ALTER TABLE app_settings
      ALTER COLUMN bot_context_window_tokens SET DEFAULT 65536,
      ALTER COLUMN general_chat_context_window_tokens SET DEFAULT 65536;
    UPDATE app_settings
      SET bot_context_window_tokens = CASE WHEN bot_context_window_tokens = 32768 THEN 65536 ELSE bot_context_window_tokens END,
          general_chat_context_window_tokens = CASE WHEN general_chat_context_window_tokens = 32768 THEN 65536 ELSE general_chat_context_window_tokens END
      WHERE bot_context_window_tokens = 32768 OR general_chat_context_window_tokens = 32768;`,
  rollback: `ALTER TABLE app_settings
      ALTER COLUMN bot_context_window_tokens SET DEFAULT 32768,
      ALTER COLUMN general_chat_context_window_tokens SET DEFAULT 32768;
    UPDATE app_settings
      SET bot_context_window_tokens = CASE WHEN bot_context_window_tokens = 65536 THEN 32768 ELSE bot_context_window_tokens END,
          general_chat_context_window_tokens = CASE WHEN general_chat_context_window_tokens = 65536 THEN 32768 ELSE general_chat_context_window_tokens END
      WHERE bot_context_window_tokens = 65536 OR general_chat_context_window_tokens = 65536;`,
};

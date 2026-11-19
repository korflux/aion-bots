// Janelas de contexto de 64k a 512k com padrão 256k (phase 11, F8; decisão do dono em 17/10/2026; substitui os presets e o padrão de CTX-04).
//
// O que muda, nos três CHECKs de presets (os dois globais de `app_settings` e o override de `bots`; nomes `<tabela>_<coluna>_check` como na 0043):
// - A lista passa de (32768, 65536, 131072, 262144) para (65536, 131072, 262144, 524288): 512k entra e 32k sai.
// - Os dois globais de `app_settings` (bots e Chat geral) vão a 262144 e o DEFAULT das colunas globais vira 262144. Os valores de hoje são o que o
//   dono deixou antes do padrão novo (bots em 128k e Chat geral em 64k); a decisão 25 da spec os leva a 256k.
// - Qualquer bot com override em 32768 vai a 65536 (a menor opção que sobrou). Overrides em 64k, 128k e 256k ficam como estão.
// Não destrutiva: só troca valores de preferência de um clique e constraints; nenhum conteúdo, tabela ou coluna é removido. Os UPDATEs rodam ANTES da troca
// dos CHECKs porque os valores novos (262144 e 65536) já são aceitos pelo CHECK antigo, e o CHECK novo recusaria uma linha que ainda estivesse em 32768.
//
// Compatibilidade durante o deploy: o código antigo nunca grava 524288, e o 32768 que ele ainda pudesse gravar entre a migration e a troca do serviço
// seria recusado pelo CHECK novo (a API antiga responderia erro interno por um instante, só nessa janela de deploy; nenhum dado se perde).
//
// Nota: o UPDATE dos globais é incondicional (a coluna não guarda proveniência, então não há como separar "escolha do dono" de "padrão antigo"). O migrador
// aplica o `up` uma única vez; reexecutá-lo à mão devolveria os globais a 256k.
//
// Rollback (só para desfazer esta migration, por exemplo voltar à versão anterior depois de um deploy com problema; no uso normal 512k segue válido e
// nada é rebaixado): devolve 128k ao global dos bots e 64k ao do Chat geral (os valores de antes da migration), o DEFAULT volta a 65536 (0040) e o CHECK
// volta a aceitar 32768 e a recusar 524288. Como a versão anterior do banco só aceita até 256k, um bot que o dono tenha colocado em 512k depois do
// deploy desce para 256k, senão recriar o CHECK antigo falharia. Bots levados de 32k para 64k continuam em 64k (a coluna não guarda o 32k original).
// Nada é apagado.
import type { Migration } from '../migrator';

export const contextWindow512kMigration: Migration = {
  id: '0046_context_window_512k',
  description: 'Janelas de contexto de 64k a 512k com padrão 256k; 32k sai e vira 64k',
  up: `UPDATE app_settings SET bot_context_window_tokens = 262144, general_chat_context_window_tokens = 262144;
    UPDATE bots SET context_window_tokens = 65536 WHERE context_window_tokens = 32768;
    ALTER TABLE app_settings
      DROP CONSTRAINT IF EXISTS app_settings_bot_context_window_tokens_check,
      DROP CONSTRAINT IF EXISTS app_settings_general_chat_context_window_tokens_check,
      ALTER COLUMN bot_context_window_tokens SET DEFAULT 262144,
      ALTER COLUMN general_chat_context_window_tokens SET DEFAULT 262144,
      ADD CONSTRAINT app_settings_bot_context_window_tokens_check CHECK (bot_context_window_tokens IN (65536,131072,262144,524288)),
      ADD CONSTRAINT app_settings_general_chat_context_window_tokens_check CHECK (general_chat_context_window_tokens IN (65536,131072,262144,524288));
    ALTER TABLE bots
      DROP CONSTRAINT IF EXISTS bots_context_window_tokens_check,
      ADD CONSTRAINT bots_context_window_tokens_check CHECK (context_window_tokens IN (65536,131072,262144,524288));`,
  rollback: `UPDATE app_settings SET bot_context_window_tokens = 131072, general_chat_context_window_tokens = 65536;
    UPDATE bots SET context_window_tokens = 262144 WHERE context_window_tokens = 524288;
    ALTER TABLE app_settings
      DROP CONSTRAINT IF EXISTS app_settings_bot_context_window_tokens_check,
      DROP CONSTRAINT IF EXISTS app_settings_general_chat_context_window_tokens_check,
      ALTER COLUMN bot_context_window_tokens SET DEFAULT 65536,
      ALTER COLUMN general_chat_context_window_tokens SET DEFAULT 65536,
      ADD CONSTRAINT app_settings_bot_context_window_tokens_check CHECK (bot_context_window_tokens IN (32768,65536,131072,262144)),
      ADD CONSTRAINT app_settings_general_chat_context_window_tokens_check CHECK (general_chat_context_window_tokens IN (32768,65536,131072,262144));
    ALTER TABLE bots
      DROP CONSTRAINT IF EXISTS bots_context_window_tokens_check,
      ADD CONSTRAINT bots_context_window_tokens_check CHECK (context_window_tokens IN (32768,65536,131072,262144));`,
};

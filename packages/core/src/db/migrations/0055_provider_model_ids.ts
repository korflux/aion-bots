// Migration 0055: ids de modelo `provedor/modelo` e a base da chave da Anthropic (phase 17, passo 2; DATA-02; spec A11, A12 e A13).
//
// O que muda:
// - Todo id de modelo gravado passa a ter o provedor na frente (`opencode/<modelo>`; `anthropic/<modelo>` nasce depois, pelo catálogo da Anthropic). Os 9 lugares onde o id vive:
//   `bots.model`, `general_chat_settings.model`, `conversations.preferred_model`, `app_settings.summary_model`, `context_summary_refusals.model`, `model_profiles.model_id` (a chave
//   primária), `model_call_usage.model`, `runs.last_model` e o JSON do cartão `model_without_tools` em `messages.data` (`data->>'model'`). O UPDATE só toca linha cujo id ainda não
//   tem um dos dois provedores na frente (`NOT LIKE 'opencode/%' AND NOT LIKE 'anthropic/%'`), então a migration é idempotente e um id que já traga outra barra (de um catálogo
//   futuro) é prefixado como qualquer outro. Valores nulos ficam nulos. Nenhuma linha é apagada, duplicada nem perdida: é UPDATE no lugar, e `model_profiles` não tem chave
//   estrangeira apontando para ele.
// - Os CHECKs de tamanho do id sobem de 200 para 209 caracteres (200 do id local mais os 9 de `opencode/`); `MODEL_ID_MAX` de `@aion/shared` acompanha. Nomes `<tabela>_<coluna>_check`,
//   os que o PostgreSQL deu aos CHECKs inline das migrations 0004, 0005, 0006, 0014, 0023, 0041 e 0042 (o teste confere cada definição depois da subida).
// - `model_profiles.hidden_at` (timestamptz, nulo = visível): o modelo que o dono oculta do seletor (passo 9), sem apagar o perfil nem o histórico do modelo.
// - `credentials.kind` passa a aceitar `anthropic` (a chave do segundo provedor, mesmo molde da 0017) e `credentials.credits_exhausted_at` (timestamptz, nulo = sem aviso) guarda o
//   momento da última recusa por saldo esgotado, que a chamada boa seguinte limpa (passo 7). A chave continua cifrada (`secret_sealed`) e mascarada (`masked`), como as demais.
//
// Não destrutiva (o padrão `DROP COLUMN`/`DELETE FROM` só aparece no rollback): as colunas e a restrição são aditivas, os UPDATEs mantêm o conteúdo e o `up` roda sozinho no deploy.
// Janela de deploy: a API roda esta migration ao subir. Entre a migration e a troca do worker e da web, o código anterior grava e lê o id sem prefixo, que o catálogo novo não
// reconhece (o modelo aparece como indisponível até o serviço subir de novo); nada se perde, e o id sem prefixo que o código anterior ainda gravasse nessa janela é recusado pelo
// código novo como `MODEL_UNAVAILABLE` até o dono escolher de novo. A janela é registrada em docs/operacao.md (passo 12).
//
// Rollback (só para voltar à versão anterior depois de um deploy com problema):
// 1. RECUSA antes de alterar qualquer linha se houver id `anthropic/...` em qualquer das 9 colunas (o código anterior não sabe chamar a Anthropic, então esses ids ficariam presos a
//    um provedor inexistente) OU se houver a chave `anthropic` gravada (decisão do dono: o rollback recusa em vez de perder dado, e a chave cifrada só sai por escolha dele). O dono troca o
//    modelo desses bots, chat e resumo para um do OpenCode Go, remove o `anthropic/` do perfil de modelos e remove a chave em Configurações → Conexões antes de repetir.
// 2. Tira o prefixo `opencode/` das 9 colunas (os ids voltam aos de antes: `opencode/deepseek-v4.1-flash` -> `deepseek-v4.1-flash`), volta os CHECKs a 200 caracteres e remove
//    `model_profiles.hidden_at` (os modelos ocultos voltam a aparecer; a escolha de ocultar se perde).
// 3. Volta o CHECK de `credentials.kind` a ('provider', 'connector', 'web_search') e remove `credits_exhausted_at` (nada de credencial é apagado: a chave `anthropic` já saiu antes, ou
//    o passo 1 recusou).
// Nada de bots, conversas, memórias, rotinas, uso, cartões ou credenciais é apagado, e rodar de novo é idempotente.
import type { Migration } from '../migrator';

/** Onde o id mora: `[tabela, coluna]`. Fonte única do `up` e do `rollback` (o teste de rollback do passo percorre a mesma lista). */
const MODEL_COLUMNS = [
  ['bots', 'model'],
  ['general_chat_settings', 'model'],
  ['conversations', 'preferred_model'],
  ['app_settings', 'summary_model'],
  ['context_summary_refusals', 'model'],
  ['model_profiles', 'model_id'],
  ['model_call_usage', 'model'],
  ['runs', 'last_model'],
] as const;

/** CHECKs de tamanho do id que sobem de 200 para 209 (nomes `<tabela>_<coluna>_check`; `model_call_usage.model` nunca teve CHECK). `nullable`: o CHECK antigo aceita nulo (as outras colunas são NOT NULL). */
const SIZED_COLUMNS = [
  { table: 'bots', column: 'model', nullable: true },
  { table: 'general_chat_settings', column: 'model', nullable: false },
  { table: 'conversations', column: 'preferred_model', nullable: true },
  { table: 'app_settings', column: 'summary_model', nullable: true },
  { table: 'context_summary_refusals', column: 'model', nullable: false },
  { table: 'model_profiles', column: 'model_id', nullable: false },
  { table: 'runs', column: 'last_model', nullable: true },
] as const;

const dropSizeChecks = SIZED_COLUMNS.map(({ table, column }) => `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_${column}_check;`).join('\n    ');
const addSizeChecks = (max: number): string => SIZED_COLUMNS.map(({ table, column, nullable }) => `ALTER TABLE ${table} ADD CONSTRAINT ${table}_${column}_check CHECK (${nullable ? `${column} IS NULL OR ` : ''}char_length(${column}) BETWEEN 1 AND ${max});`).join('\n    ');

const WITHOUT_PROVIDER = (column: string): string => `${column} NOT LIKE 'opencode/%' AND ${column} NOT LIKE 'anthropic/%'`;

/** Recusa o rollback com qualquer `anthropic/` gravado ou com a chave `anthropic` gravada, antes de tocar em linha alguma. */
const ROLLBACK_GUARD = `DO $$
BEGIN
  IF ${[
    ...MODEL_COLUMNS.map(([table, column]) => `EXISTS (SELECT 1 FROM ${table} WHERE ${column} LIKE 'anthropic/%')`),
    "EXISTS (SELECT 1 FROM messages WHERE kind = 'card' AND data->>'type' = 'model_without_tools' AND data->>'model' LIKE 'anthropic/%')",
    "EXISTS (SELECT 1 FROM credentials WHERE kind = 'anthropic')",
  ].join('\n     OR ')}
  THEN
    RAISE EXCEPTION 'Rollback da 0055 recusado: há modelo anthropic/ ou a chave da Anthropic gravados. Troque o modelo desses bots, chats e resumo para um do OpenCode Go, remova os perfis anthropic/ e a chave da Anthropic antes de repetir';
  END IF;
END
$$;`;

export const providerModelIdsMigration: Migration = {
  id: '0055_provider_model_ids',
  description: 'Ids de modelo no formato provedor/modelo (opencode/), CHECKs de 209, model_profiles.hidden_at e a chave anthropic em credentials',
  // Ordem do `up`: os CHECKs de 200 caem ANTES dos UPDATEs (um id de 200 caracteres passa a ter 209 com o prefixo) e os de 209 entram DEPOIS.
  up: `
    ${dropSizeChecks}
    ${MODEL_COLUMNS.map(([table, column]) => `UPDATE ${table} SET ${column} = 'opencode/' || ${column} WHERE ${column} IS NOT NULL AND ${WITHOUT_PROVIDER(column)};`).join('\n    ')}
    UPDATE messages SET data = jsonb_set(data, '{model}', to_jsonb('opencode/' || (data->>'model')))
      WHERE kind = 'card' AND data->>'type' = 'model_without_tools' AND data->>'model' IS NOT NULL AND ${WITHOUT_PROVIDER("(data->>'model')")};
    ${addSizeChecks(209)}
    ALTER TABLE model_profiles ADD COLUMN IF NOT EXISTS hidden_at timestamptz;
    ALTER TABLE credentials
      ADD COLUMN IF NOT EXISTS credits_exhausted_at timestamptz,
      DROP CONSTRAINT IF EXISTS credentials_kind_check,
      ADD CONSTRAINT credentials_kind_check CHECK (kind IN ('provider', 'connector', 'web_search', 'anthropic'));
  `,
  rollback: `
    ${ROLLBACK_GUARD}
    ${MODEL_COLUMNS.map(([table, column]) => `UPDATE ${table} SET ${column} = substr(${column}, length('opencode/') + 1) WHERE ${column} LIKE 'opencode/%';`).join('\n    ')}
    UPDATE messages SET data = jsonb_set(data, '{model}', to_jsonb(substr(data->>'model', length('opencode/') + 1)))
      WHERE kind = 'card' AND data->>'type' = 'model_without_tools' AND data->>'model' LIKE 'opencode/%';
    ${dropSizeChecks}
    ${addSizeChecks(200)}
    ALTER TABLE model_profiles DROP COLUMN IF EXISTS hidden_at;
    ALTER TABLE credentials
      DROP CONSTRAINT IF EXISTS credentials_kind_check,
      ADD CONSTRAINT credentials_kind_check CHECK (kind IN ('provider', 'connector', 'web_search')),
      DROP COLUMN IF EXISTS credits_exhausted_at;
  `,
};

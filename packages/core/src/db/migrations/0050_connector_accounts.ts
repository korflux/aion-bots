// Migration 0050: contas conectadas do Composio com nome do dono, liberação por bot e o instantâneo da semeadura (phase 13, passo 2; CONN-02; spec decisões 5, 6, 9; A14, A15, A20).
//
// O que modela:
// - `connector_accounts`: uma linha por conta conhecida do Composio (o Aion não faz OAuth: a conta é conectada no painel do Composio e entra aqui na primeira leitura do estado dela).
//   Guarda só o que a leitura ao vivo não pode dar quando a conta some do Composio: o app (slug e nome legível, para o rótulo da conta desconectada), o NOME que o dono deu a ela
//   (1 a 40 caracteres, valor do parâmetro de conta do modelo) e a VERSÃO, que sobe a cada renomeação e a cada troca dos bots liberados (conflito por versão esperada, como as tabelas).
//   O estado (ativa, pendente, desconectada) NÃO é gravado: vem da leitura ao vivo, e a conta ausente nela é "desconectada" mantendo nome e liberações (A17). A CHAVE DO COMPOSIO NÃO
//   ENTRA em nenhuma tabela daqui (SEC-01): o id da conta (`ca_...`) e o app não a revelam.
// - `connector_accounts.name_key` é o nome sem diferenciar maiúsculas (NFC e minúsculas, calculado pelo serviço, independente do locale do banco); o índice único parcial é a rede de
//   segurança de "nome único dentro do mesmo app" (a regra completa, que também considera o rótulo automático das outras contas, é do serviço: `credentials/accounts.ts`).
// - `connector_account_bots`: a LIBERAÇÃO, uma linha por par conta e bot. Só ela depende do bot (cascata na exclusão, como `table_bot_access`); a conta é do dono e fica. Conta nova e bot
//   novo nascem sem linha aqui (A15): toda liberação é escolha do dono, exceto a semeada abaixo.
// - `connector_seed`: uma única linha (`id` fixo em verdadeiro) com o INSTANTÂNEO dos bots que existiam quando a migration rodou e o instante em que a semeadura foi concluída. A semeadura
//   (decisão 5) libera a conta que cada app já usava (a primeira ativa, regra anterior do conector) a esses bots, e só a primeira leitura bem-sucedida do Composio sabe quais são as contas;
//   por isso a migration só grava o instantâneo e deixa a semeadura PENDENTE (`completed_at` nulo). Quem a conclui é o serviço de contas, numa transação com trava de banco, uma única vez
//   (`ConnectorAccountService.sync`). Com o Composio fora do ar no deploy ela fica pendente e o bot segue sem conector até a primeira leitura boa.
//
// Aditiva: só cria tabelas, índices e a linha do instantâneo; nenhuma tabela existente é alterada, então roda no deploy sem pedido explícito do dono. O worker antigo, durante o deploy,
// ignora as tabelas novas e segue usando a primeira conta ativa para todos os bots (comportamento anterior).
//
// Rollback (decisão do dono, spec 9): apaga as três tabelas MESMO com dados, sem a recusa com dados das 0030, 0047 e 0048. O código anterior volta à primeira conta ativa para todos os bots e
// para o Chat geral, e os nomes e as liberações feitos depois do deploy se perdem; nada anterior ao deploy é tocado. Idempotente (`IF EXISTS`). Subir de novo regrava o instantâneo com os bots de
// então. Reverter é decisão do dono.
import type { Migration } from '../migrator';

export const connectorAccountsMigration: Migration = {
  id: '0050_connector_accounts',
  description: 'Contas conectadas do Composio com nome do dono, liberação de cada conta por bot e instantâneo da semeadura inicial',
  up: `CREATE TABLE IF NOT EXISTS connector_accounts (
      id text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 200),
      app_slug text NOT NULL CHECK (char_length(app_slug) BETWEEN 1 AND 100),
      app_name text NOT NULL CHECK (char_length(app_name) BETWEEN 1 AND 100),
      name text CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 40),
      name_key text,
      version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
      CHECK ((name IS NULL) = (name_key IS NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS connector_accounts_app_name_key ON connector_accounts(app_slug, name_key) WHERE name_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS connector_account_bots (
      account_id text NOT NULL REFERENCES connector_accounts(id) ON DELETE CASCADE,
      bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      PRIMARY KEY (account_id, bot_id)
    );
    CREATE INDEX IF NOT EXISTS connector_account_bots_bot ON connector_account_bots(bot_id);
    CREATE TABLE IF NOT EXISTS connector_seed (
      id boolean PRIMARY KEY DEFAULT true CHECK (id),
      bot_ids uuid[] NOT NULL DEFAULT '{}',
      completed_at timestamptz
    );
    INSERT INTO connector_seed (id, bot_ids) SELECT true, COALESCE(array_agg(id), '{}'::uuid[]) FROM bots ON CONFLICT (id) DO NOTHING;`,
  rollback: 'DROP TABLE IF EXISTS connector_account_bots, connector_seed, connector_accounts;',
};

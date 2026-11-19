// Migration 0017: pesquisa na web pela Parallel (phase 1, T8): o interruptor e a chave opcional.
//
// O que muda:
// - `app_settings.web_search_enabled`: o interruptor global de Configurações → Pesquisa na web. Booleano, NOT NULL e LIGADO por padrão (spec,
//   Suposição 17): quem não mexer em nada tem a pesquisa ligada, e a linha única que a 0015 criou já nasce ligada pelo DEFAULT. Quem lê é a tela
//   e, a cada execução, o motor dos bots e do Chat geral (T9); quem altera é só o dono, por `SettingsService.setWebSearchEnabled`.
// - `credentials.kind` passa a aceitar `web_search`: a chave OPCIONAL da Parallel (nível anônimo sem ela). A restrição da 0003 é uma lista fixa
//   (`provider`, `connector`); troca-se por uma lista com o tipo novo, como a 0010 fez com `runs_status_check`. A chave continua cifrada
//   (`secret_sealed`) e mascarada (`masked`) como as demais, e `model_count` fica nulo.
//
// Aditiva: só acrescenta uma coluna com padrão e alarga uma restrição, então nenhuma linha existente é tocada e roda no deploy sem pedido
// explícito do dono. Durante o deploy, a API e o worker antigos ignoram a coluna nova e nunca gravam o tipo novo.
import type { Migration } from '../migrator';

export const webSearchSettingsMigration: Migration = {
  id: '0017_web_search_settings',
  description: 'Interruptor da pesquisa na web em app_settings e tipo web_search nas credenciais',
  up: `
    ALTER TABLE app_settings ADD COLUMN web_search_enabled boolean NOT NULL DEFAULT true;
    ALTER TABLE credentials DROP CONSTRAINT credentials_kind_check;
    ALTER TABLE credentials ADD CONSTRAINT credentials_kind_check CHECK (kind IN ('provider', 'connector', 'web_search'));
  `,
  // Rollback: REMOVE a chave da Parallel gravada ANTES de restaurar a restrição anterior (com a linha `web_search` ainda lá, o ADD CONSTRAINT
  // falharia contra o dado novo); a pesquisa volta ao uso anônimo e o dono pode informar a chave de novo depois de reaplicar a migration.
  // Depois remove a coluna do interruptor (a escolha de ligar ou desligar se perde e o padrão volta a ser ligada ao reaplicar). Idempotente.
  // A chave do provedor e a do Composio, as demais preferências (idioma e fuso), bots, conversas, memórias e rotinas não são tocados.
  rollback: `
    DELETE FROM credentials WHERE kind = 'web_search';
    ALTER TABLE credentials DROP CONSTRAINT IF EXISTS credentials_kind_check;
    ALTER TABLE credentials ADD CONSTRAINT credentials_kind_check CHECK (kind IN ('provider', 'connector'));
    ALTER TABLE app_settings DROP COLUMN IF EXISTS web_search_enabled;
  `,
};

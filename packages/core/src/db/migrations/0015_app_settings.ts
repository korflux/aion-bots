// Migration 0015: preferências gerais do dono, idioma e fuso horário (T28).
//
// Modelagem: `app_settings` guarda UMA linha (o dono é único): o idioma em que os bots respondem e o fuso horário do dono. A linha nasce aqui
// mesmo, com os valores que o Aion já usava antes (português do Brasil e America/Sao_Paulo), então quem não mexer em nada não nota diferença.
// - singleton: chave primária booleana presa em `true` (CHECK), o jeito de o banco garantir "no máximo uma linha" sem uma coluna de id.
// - language: só o tamanho é limitado aqui; a lista de idiomas aceitos mora no código (`LANGUAGE_CODES`), para acrescentar um idioma sem migration.
// - time_zone: identificador IANA; a existência dele no banco de fusos é conferida pelo serviço na hora de gravar (`isValidTimeZone`).
// Quem lê é o contexto do modelo (cabeçalho "Idioma" e "Agora"), a proposta de rotina do bot e o cartão da rotina; quem altera é só o dono, pela API.
// Aditiva: só cria uma tabela e a linha única, então roda no deploy sem pedido explícito do dono. Durante o deploy, a API e o worker antigos
// ignoram a tabela e seguem com português do Brasil e America/Sao_Paulo.
import type { Migration } from '../migrator';

export const appSettingsMigration: Migration = {
  id: '0015_app_settings',
  description: 'Idioma e fuso horário do dono',
  up: `
    CREATE TABLE app_settings (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      language text NOT NULL DEFAULT 'pt-BR' CHECK (char_length(language) BETWEEN 2 AND 16),
      time_zone text NOT NULL DEFAULT 'America/Sao_Paulo' CHECK (char_length(time_zone) BETWEEN 1 AND 64),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO app_settings (singleton) VALUES (true);
  `,
  // Rollback: apaga as preferências (o Aion volta ao português do Brasil e a America/Sao_Paulo, que eram o padrão fixo). Nada de bots, rotinas
  // (cada uma guarda o próprio fuso), mensagens ou memórias é tocado.
  rollback: `
    DROP TABLE app_settings;
  `,
};

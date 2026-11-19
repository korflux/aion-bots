// Migration 0029: "Como te chamar", o nome do dono nas preferências gerais (phase 5, T4).
//
// O que muda: `app_settings.owner_name`, o nome que a saudação do Início usa ("Boa tarde, Marco"). Texto, NOT NULL e vazio por padrão (vazio = sem
// nome, a saudação fica sem ele): a linha única que a 0015 criou já nasce sem nome pelo DEFAULT. O limite de 40 caracteres (`OWNER_NAME_MAX_CHARS`
// em @aion/shared) também é do banco (CHECK), como segunda barreira atrás da validação da API e do core; `char_length` conta pontos de código, o
// mesmo que a validação. Quem lê é só a tela (preferências e, na T5, o Início), por `SettingsService.read`: o nome NUNCA entra no contexto do
// modelo, em log nem na auditoria (que registra só que mudou). Quem altera é só o dono, por `SettingsService.update`.
//
// Aditiva: só acrescenta uma coluna com padrão, então nenhuma linha existente é tocada e roda no deploy sem pedido explícito do dono. Durante o
// deploy, a API e o worker antigos ignoram a coluna nova (as consultas deles nomeiam só `language` e `time_zone`).
import type { Migration } from '../migrator';

export const ownerNameMigration: Migration = {
  id: '0029_owner_name',
  description: 'Como te chamar: nome do dono em app_settings',
  up: `
    ALTER TABLE app_settings ADD COLUMN owner_name text NOT NULL DEFAULT '' CHECK (char_length(owner_name) <= 40);
  `,
  // Rollback: remove a coluna (o nome digitado se perde, e a saudação volta a ficar sem nome ao reaplicar). Idempotente. Idioma, fuso e o
  // interruptor da pesquisa na web, bots, conversas e memórias não são tocados.
  rollback: `
    ALTER TABLE app_settings DROP COLUMN IF EXISTS owner_name;
  `,
};

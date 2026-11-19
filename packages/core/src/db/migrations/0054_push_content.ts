// Migration 0054: interruptores "Mostrar conteúdo" dos avisos de bots e do Chat geral (phase 16, passo 4; NOTIF-02, SEC-07; spec A3, A4 e A14).
//
// O que muda: duas colunas booleanas em `app_settings` (a linha única do dono, como `web_search_enabled` da 0017): `push_content_bots` (todos os bots juntos) e
// `push_content_general_chat`. Ambas NOT NULL e LIGADAS por padrão (decisão 2 da spec): a linha que já existe nasce ligada pelo DEFAULT, sem preenchimento. Desligada vale o
// aviso genérico de hoje (nome e tipo) e sem os botões de aprovação. Quem lê é a conferência do service worker (`PushService.checkEvents`) e a tela de Notificações; quem altera é só
// o dono, por `PushService.setContent`, com auditoria. Nenhuma coluna guarda texto de conversa: é só o estado dos interruptores.
//
// Aditiva: só acrescenta duas colunas com padrão, então nenhuma linha existente é tocada e roda no deploy sem pedido explícito do dono. Durante o deploy, a API e o worker
// anteriores ignoram as colunas e seguem mandando o aviso genérico.
//
// Rollback: remove só as duas colunas (a escolha de ligar ou desligar se perde e o padrão volta a ser ligado ao reaplicar). Nada mais é tocado: preferências de idioma, fuso,
// pesquisa na web, nome do dono, silêncios, dispositivos, eventos e as entregas e os registros da 0053 ficam como estão. Idempotente (`IF EXISTS`).
import type { Migration } from '../migrator';

export const pushContentMigration: Migration = {
  id: '0054_push_content',
  description: 'Interruptores "Mostrar conteúdo" dos avisos de bots e do Chat geral em app_settings',
  up: `
    ALTER TABLE app_settings
      ADD COLUMN IF NOT EXISTS push_content_bots boolean NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS push_content_general_chat boolean NOT NULL DEFAULT true;
  `,
  rollback: `
    ALTER TABLE app_settings
      DROP COLUMN IF EXISTS push_content_bots,
      DROP COLUMN IF EXISTS push_content_general_chat;
  `,
};

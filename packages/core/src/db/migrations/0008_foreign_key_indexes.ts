// Migration 0008: índices nas chaves estrangeiras que as migrations 0006 e 0007 deixaram sem índice (achado R3 do checkpoint de review).
//
// Por quê: o PostgreSQL NÃO cria índice em coluna de chave estrangeira. Apagar uma linha-pai (mensagem, conversa, execução, bot,
// ação) obriga o banco a conferir a tabela filha, e sem índice isso é uma varredura inteira por linha apagada. O job de retenção do
// chat geral (T12) apagará exatamente essas linhas. O impacto hoje é pequeno (dono único, tabelas pequenas); o índice evita que
// vire problema sem aviso.
//
// Colunas cobertas: runs.bot_id (o índice parcial `runs_one_active_per_bot` só atende execuções ativas), runs.trigger_message_id,
// approvals.{bot_id, conversation_id, action_slug, activity_id, card_id} e bot_approval_rules.action_slug (a chave primária já cobre
// `bot_id`). `approvals.run_id` já tem `approvals_by_run`. O teste do migrator consulta o catálogo e falha se uma FK nova nascer sem índice.
//
// Aditiva: só cria índices, então roda no deploy sem pedido explícito do dono. CREATE INDEX comum trava a escrita da tabela
// enquanto cria; com as tabelas deste tamanho o tempo é desprezível (CONCURRENTLY não roda dentro da transação do migrator).
import type { Migration } from '../migrator';

export const foreignKeyIndexesMigration: Migration = {
  id: '0008_foreign_key_indexes',
  description: 'Índices nas chaves estrangeiras de execuções, aprovações e regras de aprovação',
  up: `
    CREATE INDEX runs_by_bot ON runs (bot_id);
    CREATE INDEX runs_by_trigger_message ON runs (trigger_message_id);
    CREATE INDEX approvals_by_bot ON approvals (bot_id);
    CREATE INDEX approvals_by_conversation ON approvals (conversation_id);
    CREATE INDEX approvals_by_action ON approvals (action_slug);
    CREATE INDEX approvals_by_activity ON approvals (activity_id);
    CREATE INDEX approvals_by_card ON approvals (card_id);
    CREATE INDEX bot_approval_rules_by_action ON bot_approval_rules (action_slug);
  `,
  // Rollback: remove só os índices; nenhum dado nem restrição é tocado.
  rollback: `
    DROP INDEX bot_approval_rules_by_action;
    DROP INDEX approvals_by_card;
    DROP INDEX approvals_by_activity;
    DROP INDEX approvals_by_action;
    DROP INDEX approvals_by_conversation;
    DROP INDEX approvals_by_bot;
    DROP INDEX runs_by_trigger_message;
    DROP INDEX runs_by_bot;
  `,
};

// Migration 0012: sessões do chat geral temporário (T12, F16; PROD-03).
//
// Modelagem: uma SESSÃO é uma conversa sem bot. Em vez de uma tabela nova, `conversations` passa a aceitar `bot_id` nulo, e o motor, as
// mensagens, o SSE e as aprovações a tratam como tratam a conversa de um bot (uma única fonte de verdade dessas regras).
// - conversations: `bot_id` anulável (a unicidade continua valendo: o PostgreSQL aceita várias linhas nulas num índice único). `title`
//   é o título gerado pela primeira mensagem (até 80 caracteres) e `saved` suspende a exclusão por retenção. Um CHECK garante que só
//   sessão tem título e "salva": a conversa de um bot nunca os carrega.
// - runs, approvals, push_events: `bot_id` anulável (nulo = a execução, o pedido ou o aviso são de uma sessão; o título do push vira
//   "Chat geral"). A fila FIFO e a regra "uma execução ativa" passam a valer por CONVERSA no motor; para um bot isso é igual a "por bot"
//   (a conversa é 1:1), e o índice existente `runs_one_active_per_bot` segue garantindo o bot. O índice novo
//   `runs_one_active_per_session` garante o mesmo para cada sessão (bots diferentes e sessões diferentes rodam em paralelo).
// Aditiva: relaxa NOT NULL, acrescenta colunas com padrão e um índice; nada é removido nem reescrito, então roda no deploy sem pedido
// explícito do dono. Durante o deploy, o worker e a API antigos continuam corretos para bots (as execuções de sessão têm `bot_id` nulo e
// o motor antigo nunca as reivindica, porque compara por `bot_id`).
import type { Migration } from '../migrator';

export const generalChatMigration: Migration = {
  id: '0012_general_chat',
  description: 'Sessões do chat geral: conversa sem bot, título, salvar e execuções, aprovações e avisos sem bot',
  up: `
    ALTER TABLE conversations
      ALTER COLUMN bot_id DROP NOT NULL,
      ADD COLUMN title text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 80),
      ADD COLUMN saved boolean NOT NULL DEFAULT false,
      ADD CONSTRAINT conversations_session_fields CHECK (bot_id IS NULL OR (title IS NULL AND NOT saved));

    ALTER TABLE runs ALTER COLUMN bot_id DROP NOT NULL;
    CREATE UNIQUE INDEX runs_one_active_per_session ON runs (conversation_id)
      WHERE bot_id IS NULL AND status IN ('running', 'waiting_approval');

    ALTER TABLE approvals ALTER COLUMN bot_id DROP NOT NULL;
    ALTER TABLE push_events ALTER COLUMN bot_id DROP NOT NULL;
  `,
  // Rollback: APAGA todas as sessões do chat geral (aprovações, avisos, mensagens, execuções, eventos e a própria conversa), porque as
  // colunas voltam a ser NOT NULL e uma linha sem bot não caberia mais. Conversas, execuções e aprovações dos bots não são tocadas. A
  // ordem respeita as chaves: aprovações e avisos primeiro, a referência execução -> mensagem de gatilho é desfeita antes de apagar as
  // mensagens, e só então vêm as execuções e a conversa.
  rollback: `
    DELETE FROM approvals WHERE bot_id IS NULL;
    DELETE FROM push_events WHERE bot_id IS NULL;
    UPDATE runs SET trigger_message_id = NULL WHERE bot_id IS NULL;
    DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE bot_id IS NULL);
    DELETE FROM runs WHERE bot_id IS NULL;
    DELETE FROM conversation_events WHERE conversation_id IN (SELECT id FROM conversations WHERE bot_id IS NULL);
    DELETE FROM conversations WHERE bot_id IS NULL;

    ALTER TABLE push_events ALTER COLUMN bot_id SET NOT NULL;
    ALTER TABLE approvals ALTER COLUMN bot_id SET NOT NULL;
    DROP INDEX runs_one_active_per_session;
    ALTER TABLE runs ALTER COLUMN bot_id SET NOT NULL;
    ALTER TABLE conversations
      DROP CONSTRAINT conversations_session_fields,
      DROP COLUMN saved,
      DROP COLUMN title,
      ALTER COLUMN bot_id SET NOT NULL;
  `,
};

// Migration 0021: presença por sessão e posição de leitura por conversa (phase 3, T2; F1/A2; NOTIF-01).
//
// Modelagem:
// - conversation_presence: UMA linha por sessão de login (cada aparelho é uma sessão, AUTH-03), apontando a conversa que ele mostra agora e o
//   instante da última renovação. Fica no PostgreSQL porque a API grava e o worker consulta (processos separados). Some com a sessão
//   (`ON DELETE CASCADE`: sair, encerrar a sessão em Conta ou trocar a credencial apagam a linha) e com a conversa (excluir o bot ou a retenção
//   do Chat geral). A validade (45 s sem renovação, sessão não vencida) é calculada na consulta, nunca gravada.
// - conversations.read_through_message_id: id da mensagem mais recente que o dono viu nesta conversa, monotônico (a escrita usa GREATEST).
//   Sem chave estrangeira para `messages` de propósito: a exclusão do bot apaga as mensagens ANTES da conversa (ver `eraseBotData`) e uma
//   referência aqui travaria essa ordem; a posição só é comparada com ids, então uma mensagem que deixou de existir não a invalida.
// Aditiva: só cria tabela, índice e coluna, então roda no deploy sem pedido explícito do dono.
import type { Migration } from '../migrator';

export const presenceReadMigration: Migration = {
  id: '0021_presence_read',
  description: 'Presença por sessão de login e posição de leitura monotônica por conversa',
  up: `
    CREATE TABLE conversation_presence (
      session_id uuid PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
      conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
      renewed_at timestamptz NOT NULL
    );
    CREATE INDEX conversation_presence_by_conversation ON conversation_presence (conversation_id, renewed_at);

    ALTER TABLE conversations ADD COLUMN read_through_message_id bigint CHECK (read_through_message_id IS NULL OR read_through_message_id > 0);
  `,
  // Rollback: perde só presenças (efêmeras, vencem em 45 s) e posições de leitura; conversas, mensagens e sessões ficam intactas.
  rollback: `
    DROP TABLE IF EXISTS conversation_presence;
    ALTER TABLE conversations DROP COLUMN IF EXISTS read_through_message_id;
  `,
};

// Migration 0025: árvore de versões e caminho ativo do Chat geral (phase 4, T3; F1 a F4, CONV-01, CONV-02, ATT-01, A1 a A7, C2).
//
// Modelagem (fonte única da leitura em `conversation/path.ts`):
// - messages.parent_run_id: de qual VERSÃO DA RESPOSTA anterior (execução) a mensagem do dono que abre a rodada pende; nulo = início da sessão.
//   Só as aberturas do Chat geral o usam; o bot é linear (CONV-02) e fica sempre nulo. Versões da mensagem são as aberturas com o mesmo pai.
// - Versões da resposta são as execuções com o mesmo `trigger_message_id` (vínculo que já existia: o "Tentar novamente" sempre criou uma
//   execução nova sobre a mesma mensagem).
// - messages.version_seq e runs.version_seq: ordem de ESCOLHA dentro de cada grupo de irmãs. A versão ativa de cada nível é a de maior valor;
//   criar uma versão ou escolhê-la no seletor a leva ao topo (`nextval`). Como cada nível guarda o próprio valor, trocar uma versão de cima
//   reencontra, abaixo dela, a última escolha feita naquele ramo (Suposição 9) sem tabela de escolhas.
// - conversations.rewound_run_id e rewound_message_id: "Retroceder até aqui" (F3). O caminho visível termina na resposta `rewound_run_id`
//   enquanto a mensagem ativa logo abaixo dela continuar sendo `rewound_message_id` (a primeira rodada retrocedida); enviar uma mensagem nova
//   cria outra versão ao lado dela e o corte deixa de valer sozinho, sem o worker precisar travar a conversa. "Restaurar" e as demais
//   trocas de caminho limpam os dois.
// - message_attachment_links: um anexo ligado a mais de uma versão da mensagem (edição que mantém o arquivo, ATT-01). O dono original segue em
//   `attachments.message_id`; aqui ficam só os vínculos extras, então o espaço é contado uma vez (a linha do anexo é uma só). Sem chave
//   estrangeira para `attachments` de propósito: o rollback da 0019 (DROP TABLE attachments, provado com dados) continua possível sem
//   depender desta; o vínculo órfão de um anexo apagado nunca aparece, porque toda leitura faz JOIN com `attachments`.
// - conversation_events.kind ganha `path`: o caminho ativo mudou (a tela relê o snapshot). Não é novidade nem aviso: não grava mensagem nem push.
//
// Backfill (Suposição 11): cada sessão existente ganha o caminho linear que já tinha. Cada abertura pende da execução MAIS RECENTE da abertura
// anterior (o "Tentar novamente" antigo só valia para a última execução, então as repetições vêm antes da mensagem seguinte) e a ordem de
// escolha é o próprio id, de modo que a repetição mais recente fica ativa. A sequência começa acima de todos os ids preenchidos.
// Aditiva: só cria colunas anuláveis, tabela, sequência e índices, amplia um CHECK e preenche as colunas novas; nada existente é alterado nem
// removido, então roda no deploy sem pedido explícito do dono. Durante o deploy, a API e o worker antigos ignoram as colunas novas.
import type { Migration } from '../migrator';

export const conversationVersionsMigration: Migration = {
  id: '0025_conversation_versions',
  description: 'Árvore de versões (mensagem e resposta) e caminho ativo do Chat geral',
  up: `
    CREATE SEQUENCE conversation_version_seq AS bigint;
    ALTER TABLE messages
      ADD COLUMN parent_run_id bigint REFERENCES runs (id),
      ADD COLUMN version_seq bigint;
    ALTER TABLE runs ADD COLUMN version_seq bigint;
    ALTER TABLE conversations
      ADD COLUMN rewound_run_id bigint REFERENCES runs (id) ON DELETE SET NULL,
      ADD COLUMN rewound_message_id bigint REFERENCES messages (id) ON DELETE SET NULL;
    CREATE INDEX messages_by_parent_run ON messages (parent_run_id);
    CREATE INDEX messages_version_root ON messages (conversation_id) WHERE opens_round AND parent_run_id IS NULL;
    CREATE INDEX conversations_rewound_run ON conversations (rewound_run_id) WHERE rewound_run_id IS NOT NULL;
    CREATE INDEX conversations_rewound_message ON conversations (rewound_message_id) WHERE rewound_message_id IS NOT NULL;

    CREATE TABLE message_attachment_links (
      message_id bigint NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
      attachment_id bigint NOT NULL,
      PRIMARY KEY (message_id, attachment_id)
    );
    CREATE INDEX message_attachment_links_by_attachment ON message_attachment_links (attachment_id);

    WITH openings AS (
      SELECT m.id, lag(m.id) OVER (PARTITION BY m.conversation_id ORDER BY m.id) AS previous
      FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE c.bot_id IS NULL AND m.opens_round AND m.status <> 'discarded'
    )
    UPDATE messages m SET parent_run_id = (SELECT max(r.id) FROM runs r WHERE r.trigger_message_id = o.previous)
    FROM openings o WHERE o.id = m.id AND o.previous IS NOT NULL;
    UPDATE messages m SET version_seq = m.id
    FROM conversations c WHERE c.id = m.conversation_id AND c.bot_id IS NULL AND m.opens_round;
    UPDATE runs SET version_seq = id WHERE bot_id IS NULL;
    SELECT setval('conversation_version_seq', greatest((SELECT max(id) FROM messages), (SELECT max(id) FROM runs), 0) + 1, false);
    ALTER TABLE messages ALTER COLUMN version_seq SET DEFAULT nextval('conversation_version_seq');
    ALTER TABLE runs ALTER COLUMN version_seq SET DEFAULT nextval('conversation_version_seq');

    ALTER TABLE conversation_events DROP CONSTRAINT conversation_events_kind_check;
    ALTER TABLE conversation_events ADD CONSTRAINT conversation_events_kind_check CHECK (kind IN ('message', 'run', 'draft', 'path'));
  `,
  // Rollback: perde só os vínculos de versão, a ordem de escolha, o corte do retrocesso e os vínculos extras de anexo. Todas as mensagens e
  // execuções de todos os ramos ficam no banco (a sessão volta a ser lida como linha do tempo linear, com os ramos intercalados por id) e os
  // anexos continuam ligados ao dono original. Os eventos `path` saem ANTES de o CHECK antigo voltar (ele os recusaria). Idempotente.
  rollback: `
    DELETE FROM conversation_events WHERE kind = 'path';
    ALTER TABLE conversation_events DROP CONSTRAINT IF EXISTS conversation_events_kind_check;
    ALTER TABLE conversation_events ADD CONSTRAINT conversation_events_kind_check CHECK (kind IN ('message', 'run', 'draft'));
    DROP TABLE IF EXISTS message_attachment_links;
    ALTER TABLE conversations DROP COLUMN IF EXISTS rewound_message_id, DROP COLUMN IF EXISTS rewound_run_id;
    ALTER TABLE runs DROP COLUMN IF EXISTS version_seq;
    ALTER TABLE messages DROP COLUMN IF EXISTS version_seq, DROP COLUMN IF EXISTS parent_run_id;
    DROP SEQUENCE IF EXISTS conversation_version_seq;
  `,
};

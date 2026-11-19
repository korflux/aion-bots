// Migration 0047: limpeza fria gravada (phase 11, T7; F4 e F6; spec decisões 15 a 17; CTX-07 substituída parcialmente).
//
// O que modela: `context_cold_masks` guarda, uma linha por resultado de ferramenta (`messages.id`), que aquele resultado deixou de ir ao modelo com o conteúdo e passou a
// ir como o marcador "[resultado de <ferramenta>, N caracteres, #id; releia com read_activity]" (`coldMaskMarker`, `runs/context.ts`). Só o motivo e o instante ficam aqui:
// o resultado íntegro continua em `messages.content` (nunca apagado nem reescrito), e `read_activity`, `search_history` e a tela leem `messages`, não esta tabela.
// A gravação acontece só com a conversa fria (nenhuma chamada ao modelo há mais de T e nenhuma execução ativa ou na fila), pelo worker (`ColdMaintenance`) ou, como rede de
// segurança, pela abertura da execução (`RunExecutor`); as duas passam por `maskColdResults` (`runs/cold-maintenance.ts`), a fonte única da regra.
//
// Idempotente por resultado e só cresce: a chave primária é `message_id`, e quem grava usa `INSERT ... ON CONFLICT DO NOTHING` de resultados que ainda não têm linha, então a
// mesma limpeza nunca é gravada duas vezes e nada é atualizado nem removido por código. Isso é o que mantém o pedido estável depois da limpeza: o pedido seguinte começa igual
// ao último pedido limpo e só cresce no fim (o cache do provedor volta a valer). As linhas só somem junto com a conversa ou a mensagem (`ON DELETE CASCADE`, como os demais
// derivados do contexto). O `masked_at` é o instante do domínio da gravação: a âncora de ocupação (`readContextAnchor`) é descartada por uma limpeza posterior a ela (CTX-08).
//
// Aditiva: só cria uma tabela e um índice, então roda no deploy sem pedido explícito do dono; o worker antigo, durante o deploy, a ignora. As conversas existentes ficam sem
// nenhuma linha e entram no pedido como sempre.
//
// Rollback: remove a tabela SÓ se ela estiver vazia, no padrão de guarda das migrations 0036 a 0038. Com limpeza gravada o rollback recusa: apagar as linhas faria os
// resultados voltarem inteiros ao pedido e o dono pagaria de novo o prefixo que a limpeza enxugou, e o contrato é "só cresce". Quem precisa voltar o código mantém a tabela
// (o código anterior a ignora). Nada é apagado, e o rollback é repetível (a segunda execução não encontra a tabela).
import type { Migration } from '../migrator';

export const coldMaintenanceMigration: Migration = {
  id: '0047_cold_maintenance',
  description: 'Resultados de ferramenta mascarados com a conversa fria: limpeza gravada, idempotente por resultado e só cresce',
  up: `CREATE TABLE IF NOT EXISTS context_cold_masks (
      message_id bigint PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      masked_at timestamptz NOT NULL
    );
    CREATE INDEX IF NOT EXISTS context_cold_masks_conversation ON context_cold_masks(conversation_id, masked_at);`,
  rollback: `DO $$ BEGIN
      IF to_regclass('public.context_cold_masks') IS NOT NULL THEN
        IF EXISTS(SELECT 1 FROM context_cold_masks) THEN RAISE EXCEPTION 'Preserve a limpeza fria gravada no rollback de aplicacao'; END IF;
      END IF;
    END $$;
    DROP TABLE IF EXISTS context_cold_masks;`,
};

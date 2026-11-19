// Recusa durável do resumo e índice dos resultados de ferramenta (phase 9, T5; spec Decisão 13, F3 passo 6 e F5 passo 3).
//
// 1) `context_summary_refusals`: quando a compactação esgota as tentativas de resumir um conjunto de linhas (saída vazia, limite de saída, formato inválido, recusa de
//    contexto do provedor em todos os alvos), grava-se a IMPRESSÃO desse conjunto (hash dos ids e do conteúdo das linhas a cobrir, mais o modelo do resumo). Toda
//    execução consulta a tabela antes de pagar um resumo: o mesmo conjunto com o mesmo modelo não gera nova chamada até o conteúdo ou o modelo mudar. Antes, a
//    recusa só existia no ledger da execução, e a execução seguinte, com o mesmo histórico, pagava outro resumo que falharia igual. `run_id` diz em que execução a
//    desistência aconteceu (a própria execução também não tenta de novo, mesmo para um conjunto diferente). É dado derivado de custo, não histórico: nenhuma
//    conversa, mensagem ou checkpoint depende dele, então o rollback pode descartá-lo.
//
// 2) `messages_result_search`: índice GIN PARCIAL dos resultados de ferramenta concluídos, para `search_history` (runs/search-history.ts) achar um termo que só
//    existe num resultado sem varrer a conversa. Mesma regra do `messages_search` da 0016: a expressão e o predicado são os que a consulta escreve, é o que deixa
//    o planner usá-lo. A configuração de texto acompanha a 0016: `portuguese_unaccent` quando ela existe (a busca tolerante a acento) e `portuguese` quando a
//    extensão `unaccent` não pôde ser criada (a busca de recuo). Só os primeiros 100.000 caracteres de cada resultado entram no índice: a gravação chega a 256 KiB
//    e um `tsvector` não pode passar de 1 MB; com o corte o tamanho do vetor fica folgado, e uma falha na gravação do resultado por causa do índice seria pior
//    que não achar um termo depois do centésimo milésimo caractere (esse trecho continua legível por `read_activity`).
//    Interação com a 0016: este índice depende da configuração `portuguese_unaccent`, e o PostgreSQL não deixa derrubá-la enquanto ele existir. Por isso o rollback
//    e o `up` da 0016 trocam a configuração DESTE índice (`swapResultIndexConfig` em 0016_history_search_unaccent.ts) em vez de falhar: o rollback da 0016
//    o devolve a `portuguese` (a busca de recuo), o procedimento "rollback, apagar a linha, reiniciar a API" da 0016 o leva de volta a `portuguese_unaccent`, e os
//    rollbacks das duas migrations rodam em qualquer ordem. Nada aqui precisa ser refeito à mão depois de mexer na 0016.
//    ponytail: o `CREATE INDEX` é sem `CONCURRENTLY` porque as migrations rodam dentro de uma transação na subida da API (`CONCURRENTLY` não roda em transação) e o
//    volume atual de `messages` é pequeno (uso pessoal, um dono): a construção do índice bloqueia escritas em `messages` só durante a subida. Se `messages` crescer a
//    ponto de a construção demorar segundos, criar o índice fora do migrator, com `CREATE INDEX CONCURRENTLY IF NOT EXISTS` antes da subida, e deixar esta migration só
//    como verificação (o `IF NOT EXISTS` já a torna inofensiva).
//
// Aditiva: cria uma tabela e um índice, não toca em dado existente; o código antigo ignora ambos. Rollback: remove os dois (idempotente), sem perda de histórico;
// `DROP INDEX IF EXISTS` serve em qualquer estado do índice (com `portuguese_unaccent`, com `portuguese` depois do rollback da 0016, ou ausente).
import type { Migration } from '../migrator';

/** Caracteres de cada resultado que o índice cobre; a consulta (`RESULT_INDEX_CHARS` em runs/search-history.ts) usa o MESMO número, senão o planner não usa o índice. */
const INDEX_CHARS = 100_000;

/** Predicado parcial: só resultados de ferramenta concluídos. Idêntico ao WHERE da consulta de resultados. */
const INDEXED_ROWS = "kind = 'activity' AND status = 'completed'";

export const summaryRefusalMigration: Migration = {
  id: '0042_summary_refusal',
  description: 'Recusa do resumo por impressão do conjunto coberto e índice GIN dos resultados de ferramenta para search_history',
  up: `
    CREATE TABLE IF NOT EXISTS context_summary_refusals (
      conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      impression text NOT NULL CHECK (char_length(impression) BETWEEN 1 AND 128),
      run_id bigint REFERENCES runs(id) ON DELETE SET NULL,
      model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 200),
      outcome text NOT NULL CHECK (outcome IN ('empty', 'output_limit', 'format', 'context', 'rejected')),
      created_at timestamptz NOT NULL,
      PRIMARY KEY (conversation_id, impression)
    );
    CREATE INDEX IF NOT EXISTS context_summary_refusals_run ON context_summary_refusals (run_id) WHERE run_id IS NOT NULL;
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'portuguese_unaccent' AND pg_ts_config_is_visible(oid)) THEN
        CREATE INDEX IF NOT EXISTS messages_result_search ON messages USING gin (to_tsvector('portuguese_unaccent', left(content, ${INDEX_CHARS})))
          WHERE ${INDEXED_ROWS};
      ELSE
        CREATE INDEX IF NOT EXISTS messages_result_search ON messages USING gin (to_tsvector('portuguese', left(content, ${INDEX_CHARS})))
          WHERE ${INDEXED_ROWS};
      END IF;
    END
    $$;
  `,
  rollback: `
    DROP INDEX IF EXISTS messages_result_search;
    DROP TABLE IF EXISTS context_summary_refusals;
  `,
};

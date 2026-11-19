// Migration 0016: busca no histórico tolerante a acento (T4, F3 da phase 1).
//
// O que cria: a configuração de busca de texto `portuguese_unaccent` (cópia da `portuguese` em que as palavras passam antes pelo dicionário
// `unaccent`, da extensão de mesmo nome, e só então pelo radical em português) e recria o índice `messages_search` com ela. Quem consulta é
// `runs/search-history.ts`: a consulta usa a MESMA expressão `to_tsvector('portuguese_unaccent', content)` e o MESMO predicado do índice, que é
// a condição para o planner usar o índice. "reunião", "reuniao" e "orçamento"/"orcamento" passam a dar o mesmo radical dos dois lados; o plural em
// -ões/-ães continua sendo tratado pela ferramenta (o radical do português não junta "reunioes" com "reuniao"), não por esta migration.
//
// Degradação segura: este SQL roda a cada deploy e uma falha aqui derrubaria a API. Se o PostgreSQL não tem a extensão `unaccent` (pacote contrib
// ausente: SQLSTATE 0A000) ou o usuário do banco não pode criá-la (42501), o bloco interno desfaz TUDO o que tentou (um bloco com EXCEPTION é uma
// subtransação, então a extensão, a configuração e o índice só valem juntos), emite um WARNING e a migration termina normalmente: o índice
// antigo segue valendo e a busca continua como era (`search-history.ts` detecta a falta da configuração a cada consulta). O migrador repassa o
// WARNING ao log do serviço. A migration fica registrada como aplicada mesmo assim; para ativar a busca tolerante depois de instalar a extensão,
// rode o rollback abaixo, apague a linha desta migration em `schema_migrations` e reinicie a API.
//
// Dependência inversa com a 0042 (phase 9): o índice parcial `messages_result_search` (resultados de ferramenta, `search_history`) nasce DEPOIS desta migration e
// usa a MESMA configuração que ela cria quando existe. O PostgreSQL recusa derrubar uma configuração enquanto um índice depende dela, então o rollback daqui
// (e o procedimento acima, que roda este rollback com a 0042 já aplicada) falharia com "cannot drop text search configuration ... other objects depend on
// it". Por isso o `up` e o rollback desta migration TROCAM a configuração desse índice junto com a do `messages_search` (`swapResultIndexConfig`): o rollback o
// devolve a `portuguese` antes de remover a configuração, e o `up` reaplicado o leva de volta a `portuguese_unaccent`. A definição do índice é lida do catálogo
// (`pg_get_indexdef`) e só a configuração muda, então esta migration não repete a expressão, o corte nem o predicado da 0042, e os rollbacks das duas rodam em
// qualquer ordem. No primeiro deploy o índice ainda não existe (a 0042 vem depois) e a troca não faz nada.
//
// Aditiva: só cria uma extensão, uma configuração e troca um índice por outro (índice é dado derivado, nenhum dado é tocado), então roda no
// deploy sem pedido explícito do dono. Durante o deploy, a API e o worker antigos consultam com a configuração `portuguese`: continua correto, só
// sem usar o índice até a versão nova subir.
// ponytail: DROP INDEX e CREATE INDEX comuns travam a escrita em `messages` enquanto o índice é montado (CONCURRENTLY não roda dentro da transação do
// migrador); com o histórico de um dono só o tempo é desprezível, trocar por criação em duas etapas se a tabela chegar a milhões de linhas.
// ponytail: só o índice da 0042 é conhecido aqui; um índice futuro que use `portuguese_unaccent` precisa entrar em `swapResultIndexConfig` (ou em uma troca
// equivalente) senão volta a travar este rollback, tratar quando uma migration nova criar outro índice com essa configuração.
import type { Migration } from '../migrator';

/** Predicado parcial do índice: só texto concluído, nunca atividades. Idêntico ao WHERE da consulta de `search-history.ts`. */
const INDEXED_ROWS = "kind <> 'activity' AND status = 'done'";

/** Índice parcial dos resultados de ferramenta concluídos, criado pela migration 0042 com a configuração de texto vigente na época. */
const RESULT_INDEX = 'messages_result_search';

/**
 * Trecho PL/pgSQL que, se `messages_result_search` existir com a configuração `from`, o recria idêntico (mesma expressão, corte e predicado, lidos de
 * `pg_get_indexdef`) com a configuração `to`; se o índice não existe ou já usa outra configuração, não faz nada (por isso é idempotente). Exige a variável
 * `result_index text` declarada no bloco que o inclui. A busca pelo texto `'<from>'::regconfig` casa a configuração inteira: `'portuguese'::regconfig` não
 * casa `'portuguese_unaccent'::regconfig`, porque a aspa de fechamento vem logo depois do nome. As duas configurações já existem no momento da troca (o `up`
 * a chama depois de criar `portuguese_unaccent`; o rollback, antes de removê-la), então o índice nunca fica sem configuração. Roda dentro da transação da
 * migration (o `up`) ou do script do rollback: a troca é atômica com o resto.
 */
const swapResultIndexConfig = (from: string, to: string): string => `
        SELECT pg_get_indexdef(oid) INTO result_index FROM pg_class WHERE oid = to_regclass('${RESULT_INDEX}');
        IF strpos(result_index, '''${from}''::regconfig') > 0 THEN
          DROP INDEX ${RESULT_INDEX};
          EXECUTE replace(result_index, '''${from}''::regconfig', '''${to}''::regconfig');
        END IF;`;

export const historySearchUnaccentMigration: Migration = {
  id: '0016_history_search_unaccent',
  description: 'Configuração de busca com unaccent e índice do histórico recriado com ela (sem a extensão, só avisa)',
  up: `
    DO $$
    DECLARE
      result_index text;
    BEGIN
      BEGIN
        CREATE EXTENSION IF NOT EXISTS unaccent;
        CREATE TEXT SEARCH CONFIGURATION portuguese_unaccent (COPY = portuguese);
        ALTER TEXT SEARCH CONFIGURATION portuguese_unaccent
          ALTER MAPPING FOR hword, hword_part, word WITH unaccent, portuguese_stem;
        DROP INDEX messages_search;
        CREATE INDEX messages_search ON messages USING gin (to_tsvector('portuguese_unaccent', content))
          WHERE ${INDEXED_ROWS};${swapResultIndexConfig('portuguese', 'portuguese_unaccent')}
      EXCEPTION WHEN feature_not_supported OR insufficient_privilege THEN
        RAISE WARNING 'Extensão unaccent indisponível (%). A busca no histórico segue sem tolerância a acento e plural.', SQLERRM;
      END;
    END
    $$;
  `,
  // Rollback: devolve o índice e a busca ao que eram na 0006 e remove a configuração. Idempotente (roda de novo sem erro, inclusive se o `up` só
  // avisou e nunca criou a configuração). A extensão `unaccent` NÃO é removida: pode ter sido instalada pelo dono antes desta migration, e sem a
  // configuração ela é inerte. Nenhuma mensagem, bot ou rotina é tocada; os índices são refeitos sobre as mensagens existentes. Se a 0042 está aplicada,
  // o índice dos resultados passa antes para `portuguese` (senão a remoção da configuração falha) e segue existindo, coerente com a busca de recuo.
  rollback: `
    DO $$
    DECLARE
      result_index text;
    BEGIN${swapResultIndexConfig('portuguese_unaccent', 'portuguese')}
    END
    $$;
    DROP INDEX IF EXISTS messages_search;
    DROP TEXT SEARCH CONFIGURATION IF EXISTS portuguese_unaccent;
    CREATE INDEX messages_search ON messages USING gin (to_tsvector('portuguese', content))
      WHERE ${INDEXED_ROWS};
  `,
};

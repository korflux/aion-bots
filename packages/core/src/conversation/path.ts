// Caminho ativo do Chat geral (phase 4, CONV-01; Suposições 2, 4, 7 e 9): a FONTE ÚNICA de "quais rodadas estão em vigor" numa sessão, lida
// pelo contexto do modelo (`loadContextRows`), pela paginação e pelo snapshot da tela (`ConversationService`), pelo `search_history`, por
// Atividades (cartão fora do caminho) e pelo motor, que pendura cada mensagem nova na ponta do caminho. Nada fora daqui decide o caminho.
//
// A árvore (migration 0025): a mensagem do dono que abre uma rodada pende de uma versão da resposta anterior (`messages.parent_run_id`, nulo no
// início da sessão); as versões da resposta são as execuções sobre a mesma mensagem (`runs.trigger_message_id`). Em cada nível vale a irmã de
// maior `version_seq` (a criada ou escolhida por último), então descer pela árvore a partir da raiz dá um caminho único. O retrocesso corta o
// caminho visível numa resposta enquanto a mensagem logo abaixo dela ainda for a que estava lá (ver a migration).
//
// Linhas de uma rodada: a mensagem do caminho e todas as linhas da execução escolhida que não abrem rodada (texto, atividades, cartões e
// complementos lidos). Linhas das outras versões ficam no banco e nunca entram. Os ids crescem ao longo de um caminho (a rodada seguinte só nasce
// depois de a anterior terminar), então "ordem por id" continua sendo a ordem da conversa e a paginação por `before` continua valendo.
//
// O bot é linear (CONV-02): nada aqui é usado para ele; quem chama mantém a leitura da phase 3.
// ponytail: o caminho é recalculado do banco a cada leitura (consulta recursiva, um passo por rodada); guardar o caminho materializado se
// sessões passarem de algumas centenas de rodadas e a consulta pesar no contexto de cada etapa.
import type { Queryable } from '../db/pool';

/** Uma rodada do caminho: a mensagem e a resposta em vigor, e as irmãs de cada uma (ids na ordem de criação, que é a ordem do seletor). */
export interface PathRound {
  messageId: string;
  /** Nula só se a mensagem ainda não tem execução (não acontece no Chat geral: a execução nasce junto da mensagem ou antes dela). */
  runId: string | null;
  messageVersions: string[];
  runVersions: string[];
}

export interface ActivePath {
  /** O caminho VISÍVEL (com o corte do retrocesso aplicado), da primeira rodada à última. */
  rounds: PathRound[];
  /** Retrocesso em vigor: a resposta onde o caminho para e quantas rodadas ficaram abaixo dela. Nulo sem corte. */
  rewound: { runId: string; rounds: number } | null;
  /** O caminho inteiro, sem o corte (usado para validar a troca de versão e contar as rodadas retrocedidas). */
  full: PathRound[];
}

/** Ordem de escolha entre irmãs: a de maior `version_seq` vale; o id desempata (e cobre linha antiga sem valor). */
const CHOSEN_FIRST = 'version_seq DESC NULLS LAST, id DESC';

/**
 * Descida recursiva da raiz até a ponta, escolhendo em cada nível a mensagem e a resposta em vigor (parâmetro: $1 conversa). As irmãs de cada
 * nível saem na mesma consulta. Mensagem descartada (dado perdido na recuperação) nunca é versão.
 */
const PATH_SQL = `
  WITH RECURSIVE path AS (
    SELECT 1 AS depth, root.id AS message_id,
      (SELECT r.id FROM runs r WHERE r.trigger_message_id = root.id ORDER BY r.${CHOSEN_FIRST} LIMIT 1) AS run_id
    FROM (SELECT m.id FROM messages m
          WHERE m.conversation_id = $1 AND m.opens_round AND m.parent_run_id IS NULL AND m.status <> 'discarded'
          ORDER BY m.${CHOSEN_FIRST} LIMIT 1) root
    UNION ALL
    SELECT p.depth + 1, child.id,
      (SELECT r.id FROM runs r WHERE r.trigger_message_id = child.id ORDER BY r.${CHOSEN_FIRST} LIMIT 1)
    FROM path p
    CROSS JOIN LATERAL (SELECT m.id FROM messages m
                        WHERE m.parent_run_id = p.run_id AND m.opens_round AND m.status <> 'discarded'
                        ORDER BY m.${CHOSEN_FIRST} LIMIT 1) child
  )
  SELECT p.message_id::text AS message_id, p.run_id::text AS run_id,
    (SELECT array_agg(s.id::text ORDER BY s.id) FROM messages me JOIN messages s
       ON s.conversation_id = me.conversation_id AND s.opens_round AND s.status <> 'discarded' AND s.parent_run_id IS NOT DISTINCT FROM me.parent_run_id
     WHERE me.id = p.message_id) AS message_versions,
    coalesce((SELECT array_agg(r.id::text ORDER BY r.id) FROM runs r WHERE r.trigger_message_id = p.message_id), '{}') AS run_versions
  FROM path p ORDER BY p.depth`;

interface PathRow {
  message_id: string;
  run_id: string | null;
  message_versions: string[];
  run_versions: string[];
}

/**
 * Lê o caminho ativo de uma sessão: o inteiro e o visível. O corte do retrocesso só vale enquanto a resposta dele estiver no caminho e a
 * mensagem logo abaixo ainda for a primeira rodada retrocedida; senão (uma mensagem nova virou versão ao lado dela, ou a resposta saiu do
 * caminho) o caminho visível é o inteiro.
 */
export async function readActivePath(db: Queryable, conversationId: string): Promise<ActivePath> {
  const [found, cut] = await Promise.all([
    db.query<PathRow>(PATH_SQL, [conversationId]),
    db.query<{ run_id: string | null; message_id: string | null }>(
      'SELECT rewound_run_id::text AS run_id, rewound_message_id::text AS message_id FROM conversations WHERE id = $1',
      [conversationId],
    ),
  ]);
  const full: PathRound[] = found.rows.map((row) => ({ messageId: row.message_id, runId: row.run_id, messageVersions: row.message_versions, runVersions: row.run_versions }));
  const { run_id: cutRun = null, message_id: cutMessage = null } = cut.rows[0] ?? {};
  const at = full.findIndex((round) => round.runId !== null && round.runId === cutRun);
  if (at === -1 || full[at + 1]?.messageId !== cutMessage) return { rounds: full, rewound: null, full };
  return { rounds: full.slice(0, at + 1), rewound: { runId: cutRun as string, rounds: full.length - at - 1 }, full };
}

/** Ids das mensagens e das execuções das rodadas dadas, nos dois parâmetros que `onPathSql` espera. */
export function pathIds(rounds: readonly PathRound[]): { messageIds: string[]; runIds: string[] } {
  return { messageIds: rounds.map((round) => round.messageId), runIds: rounds.flatMap((round) => (round.runId === null ? [] : [round.runId])) };
}

/**
 * Predicado SQL "a linha `alias` está no caminho": é a mensagem de uma rodada, ou uma linha da execução escolhida que não abre rodada.
 * `messages` e `runs` são os números dos parâmetros (`bigint[]`) com os ids de `pathIds`; o alias é escrito pelo código, nunca vem de fora.
 */
export const onPathSql = (alias: string, messages: number, runs: number): string =>
  `(${alias}.id = ANY($${messages}::bigint[]) OR (${alias}.run_id = ANY($${runs}::bigint[]) AND NOT ${alias}.opens_round))`;

/** A resposta em que a próxima mensagem nova pende: a da última rodada do caminho visível (nula numa sessão vazia, o início). */
export function tipOf(path: ActivePath): string | null {
  return path.rounds.at(-1)?.runId ?? null;
}

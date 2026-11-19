// Semeia rodadas numa conversa pelo banco (testes da API): o histórico da tela é paginado em rodadas, e provar a janela (10 por padrão, o teto de
// 300 itens, a fronteira de cada rodada) com o motor de execução real levaria segundos por rodada. As linhas seguem o formato que o motor grava
// (mensagem do dono abre a rodada; as chamadas de ferramenta e a resposta do bot vêm depois, com o mesmo `step` de uma execução), então
// `toMessageView` e a paginação as tratam como as de verdade. Cada rodada tem a execução concluída que a respondeu (`run_id` nas linhas e a mensagem
// como gatilho), e a abertura pende da execução da rodada anterior: numa sessão do Chat geral (phase 4) é por esses vínculos que o caminho ativo
// encontra as rodadas; no bot eles não mudam nada.
import type { TestApi } from './harness';

/** Uma rodada semeada: os ids em ordem (abertura, chamadas de ferramenta, resposta), com cada parte à parte para o teste apontar uma. */
export interface SeededRound {
  ids: string[];
  opener: string;
  activities: string[];
  reply: string;
}

/** Campos de `messages.data` de uma chamada de ferramenta (ver `ActivityData` em @aion/core). */
const ACTIVITY_DATA = JSON.stringify({ callId: 'call-seed', tool: 'search_history', label: 'Pesquisou no histórico: semente', arguments: '{}', detail: null });

const byId = (a: string, b: string): number => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);

/**
 * Cria uma rodada por item de `activitiesPerRound`, da mais antiga para a mais nova, com esse número de chamadas de ferramenta entre a pergunta
 * ("pergunta N") e a resposta ("resposta N"). Devolve os ids de cada rodada, na ordem em que foram criados.
 */
export async function seedRounds(pool: TestApi['pool'], conversationId: string, activitiesPerRound: readonly number[]): Promise<SeededRound[]> {
  const rounds: SeededRound[] = [];
  let parent: string | null = null;
  for (const [index, count] of activitiesPerRound.entries()) {
    const number = index + 1;
    const run = await pool.query<{ id: string }>(
      `INSERT INTO runs (conversation_id, bot_id, status, input, created_at)
       SELECT id, bot_id, 'completed', $2, now() FROM conversations WHERE id = $1 RETURNING id::text`,
      [conversationId, `pergunta ${number}`],
    );
    const runId = run.rows[0]!.id;
    const opener = await pool.query<{ id: string }>(
      `INSERT INTO messages (conversation_id, run_id, role, kind, status, opens_round, step, content, data, parent_run_id, created_at)
       VALUES ($1, $2, 'user', 'text', 'done', true, NULL, $3, '{}', $4, now()) RETURNING id::text`,
      [conversationId, runId, `pergunta ${number}`, parent],
    );
    await pool.query('UPDATE runs SET trigger_message_id = $2 WHERE id = $1', [runId, opener.rows[0]!.id]);
    const activities = await pool.query<{ id: string }>(
      `INSERT INTO messages (conversation_id, run_id, role, kind, status, opens_round, step, content, data, created_at)
       SELECT $1, $4, 'assistant', 'activity', 'completed', false, 1, 'resultado', $2::jsonb, now() FROM generate_series(1, $3::int) RETURNING id::text`,
      [conversationId, ACTIVITY_DATA, count, runId],
    );
    const reply = await pool.query<{ id: string }>(
      `INSERT INTO messages (conversation_id, run_id, role, kind, status, opens_round, step, content, data, created_at)
       VALUES ($1, $3, 'assistant', 'text', 'done', false, 2, $2, '{}', now()) RETURNING id::text`,
      [conversationId, `resposta ${number}`, runId],
    );
    const activityIds = activities.rows.map((row) => row.id).sort(byId);
    rounds.push({ ids: [opener.rows[0]!.id, ...activityIds, reply.rows[0]!.id], opener: opener.rows[0]!.id, activities: activityIds, reply: reply.rows[0]!.id });
    // Só a sessão encadeia (no bot a abertura nunca tem pai, como o motor grava).
    parent = (await pool.query<{ session: boolean }>('SELECT bot_id IS NULL AS session FROM conversations WHERE id = $1', [conversationId])).rows[0]?.session ? runId : null;
  }
  return rounds;
}

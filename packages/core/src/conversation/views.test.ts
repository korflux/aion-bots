// Prova do limite de exibição do resultado de ferramenta na tela (phase 9, CTX-10): o resultado genérico é gravado íntegro (até 256 KiB) e a visão da
// atividade mostra só o começo, com o aviso de que o íntegro está guardado. Ferramenta com limite próprio e linha antiga (sem a marca) seguem inteiras.
// Prova pura de `toMessageView`: é a conversão única de linha para visão usada pelo snapshot, pela paginação e pelo SSE.
// Também prova, com o produtor real, que o cartão de rotina chega à tela sem o instantâneo interno de recusa (`restore`, T5 da phase 10) por essas três vias.
import { messageViewSchema } from '@aion/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORIGIN, createRunsWorld, type RunsWorld } from '../runs/test-support';
import { RESULT_VIEW_MAX_CHARS, toMessageView, type ActivityData, type MessageRow } from './views';

/** Linha de atividade (resultado de uma ferramenta do conector) com o conteúdo gravado dado; `data` ajusta a marca `genericResult` e o resto do dado da atividade, e `status` o estado da linha. */
const activity = (content: string, data: Partial<ActivityData> = {}, status: MessageRow['status'] = 'completed'): MessageRow => ({
  id: '7', run_id: '3', role: 'assistant', kind: 'activity', status, opens_round: false, step: 1, content, created_at: new Date('2026-10-14T12:00:00Z'),
  data: { callId: 'c1', tool: 'composio_action', label: 'Ação', arguments: '{}', detail: null, ...data },
});
/** O resultado que a tela recebe de uma linha de atividade, por `toMessageView` (nulo enquanto a chamada está em andamento); falha se a linha não vira atividade. */
const resultOf = (row: MessageRow): string | null => {
  const view = toMessageView(row);
  if (view.kind !== 'activity') throw new Error('esperava uma atividade');
  return view.result;
};

describe('resultado de ferramenta na tela (CTX-10)', () => {
  const big = 'abcdefghij'.repeat(5000); // 50.000 caracteres

  it('resultado genérico acima de 8.000 mostra o começo e o aviso de que o íntegro está guardado; a linha de entrada não muda', () => {
    const row = activity(big, { genericResult: true });
    const snapshot = JSON.stringify(row);
    expect(RESULT_VIEW_MAX_CHARS).toBe(8000);
    expect(resultOf(row)).toBe(`${big.slice(0, 8000)}\n[mostrando 8.000 de 50.000 caracteres; o resultado completo está guardado na conversa]`);
    expect(JSON.stringify(row)).toBe(snapshot);
    // Também o resultado que falhou (genérico) segue a mesma regra.
    expect(resultOf(activity(big, { genericResult: true }, 'failed'))).toContain('[mostrando 8.000 de 50.000 caracteres');
  });

  it('o que cabe no teto, a ferramenta de limite próprio e a linha antiga (sem a marca) passam inteiros', () => {
    expect(resultOf(activity('x'.repeat(8000), { genericResult: true }))).toBe('x'.repeat(8000));
    expect(resultOf(activity(big))).toBe(big);
    expect(resultOf(activity(big, { genericResult: false }))).toBe(big);
  });

  it('não parte um emoji na fronteira e a atividade em andamento não tem resultado', () => {
    const text = `${'a'.repeat(7999)}😀${'b'.repeat(50)}`;
    const shown = resultOf(activity(text, { genericResult: true }))!;
    expect(Buffer.from(shown, 'utf8').toString('utf8')).toBe(shown); // ida e volta em UTF-8 igual = sem metade solta
    expect(shown).toBe(`${'a'.repeat(7999)}\n[mostrando 7.999 de 8.051 caracteres; o resultado completo está guardado na conversa]`);
    expect(resultOf(activity(big, { genericResult: true }, 'running'))).toBeNull();
  });
});

describe('o que a web usa para a linha de trabalho da conversa (phase 18, A31)', () => {
  const at = (id: string, iso: string, tool: string, args: string, extra: Partial<ActivityData> = {}): MessageRow => ({
    ...activity('ok', { tool, arguments: args, ...extra }), id, created_at: new Date(iso),
  });

  it('cada item da rodada leva o próprio `createdAt` em ISO, de onde a web tira o início e o fim de "Trabalhou por"', () => {
    const first = toMessageView(at('1', '2026-11-14T10:00:00Z', 'edit_memory', '{}'));
    const last = toMessageView(at('2', '2026-11-14T10:00:42Z', 'edit_memory', '{}'));
    expect(first.createdAt).toBe('2026-11-14T10:00:00.000Z');
    expect(last.createdAt).toBe('2026-11-14T10:00:42.000Z');
    expect(Date.parse(last.createdAt) - Date.parse(first.createdAt)).toBe(42_000);
  });

  it('o slug da ação do Composio e o alvo do `use_tool` chegam em `activity.tool`, com a porta só em `via` (fora da visão)', () => {
    const composio = toMessageView(at('3', '2026-11-14T10:00:00Z', 'GMAIL_FETCH_EMAILS', '{"query":"x"}', { via: 'composio_execute_action' }));
    const viaUseTool = toMessageView(at('4', '2026-11-14T10:00:01Z', 'doc_read', '{"docId":"d"}', { via: 'use_tool' }));
    expect(composio).toMatchObject({ kind: 'activity', tool: 'GMAIL_FETCH_EMAILS' });
    expect(viaUseTool).toMatchObject({ kind: 'activity', tool: 'doc_read' });
    expect(JSON.stringify([composio, viaUseTool])).not.toMatch(/composio_execute_action|use_tool/);
  });

  it('`doc_read` leva o `docId` nos argumentos, que a web resolve contra a lista de docs', () => {
    const docId = '3f2b8f0e-5b7a-4a43-9d2e-0a1f6c1d9e11';
    const view = toMessageView(at('5', '2026-11-14T10:00:02Z', 'doc_read', JSON.stringify({ docId, offset: 0 })));
    if (view.kind !== 'activity') throw new Error('esperava uma atividade');
    expect(JSON.parse(view.arguments)).toMatchObject({ docId });
  });
});

/** Linha de cartão com o `data` dado (o que o serviço de rotinas grava em `messages.data`, instantâneo interno incluído). */
const card = (data: Record<string, unknown>): MessageRow => ({
  id: '9', run_id: '3', role: 'system', kind: 'card', status: 'done', opens_round: false, step: null, content: 'Rotina excluída', created_at: new Date('2026-10-17T12:00:00Z'), data,
});

describe('cartão de rotina na tela: o instantâneo interno de recusa não vai ao navegador (T5, A14)', () => {
  const ROUTINE_ID = '3f2b8f0e-5b7a-4a43-9d2e-0a1f6c1d9e11';
  const restore = { routine: { id: ROUTINE_ID, name: 'Ciclo', instruction: 'instrução privada da rotina' }, occurrences: [], occurrencesTruncated: false, runIds: ['1'], cardIds: ['2'] };
  const deletion = { type: 'routine_change', routineId: null, routineName: 'Ciclo', change: { action: 'delete' }, status: 'applied' };

  it('o cartão da exclusão sai sem `restore` e mantém tudo o que a tela usa; a linha gravada não é alterada', () => {
    const row = card({ ...deletion, restore });
    const snapshot = JSON.stringify(row);
    const view = toMessageView(row);
    expect(view).toEqual({ id: '9', runId: '3', attachments: [], createdAt: '2026-10-17T12:00:00.000Z', kind: 'card', status: 'done', content: 'Rotina excluída', card: deletion });
    expect(JSON.stringify(view)).not.toMatch(/restore|instrução privada/);
    expect(messageViewSchema.safeParse(view).success).toBe(true); // o contrato que a web valida continua aceitando a visão
    expect(JSON.stringify(row)).toBe(snapshot); // o instantâneo continua na linha para a recusa o ler
  });

  it('cartão sem `restore` passa igual, de qualquer tipo', () => {
    const confirmed = { type: 'routine_confirmed', routineId: ROUTINE_ID, routineName: 'Ciclo', action: 'create' };
    expect(toMessageView(card(confirmed))).toMatchObject({ kind: 'card', card: confirmed });
    expect(toMessageView(card(deletion))).toMatchObject({ kind: 'card', card: deletion });
  });

  describe('com o produtor real (exclusão feita pelo bot) e as três vias que levam o cartão à tela', () => {
    let world: RunsWorld;
    beforeAll(async () => { world = await createRunsWorld(); world.engine.start(); });
    afterAll(async () => { await world.cleanup(); });

    it('snapshot, paginação e SSE entregam o cartão sem `restore`, e a linha gravada o guarda para a recusa', async () => {
      const bot = await world.createBot();
      const routine = await world.routines.create({ name: 'Ciclo', botId: bot.id, instruction: 'Executar Ciclo', schedule: { type: 'daily', times: ['07:00'] }, timezone: 'America/Sao_Paulo', startsAt: null, endsAt: null, maxRuns: null }, ORIGIN);
      await world.waitForStatus(await world.send(bot, '[rotina-excluir:Ciclo]'), 'completed');
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      const stored = await world.pool.query<{ id: string; data: Record<string, unknown> }>("SELECT id::text AS id, data FROM messages WHERE conversation_id = $1 AND kind = 'card' AND data->>'type' = 'routine_change'", [conversationId]);
      expect(stored.rows).toHaveLength(1);
      const { id, data } = stored.rows[0]!;
      expect(data.restore).toMatchObject({ routine: { id: routine.id, name: 'Ciclo' } });

      const updates = (await world.conversations.updatesSince(conversationId, '0')).updates;
      const viaSse = updates.flatMap((update) => (update.event === 'message' && update.data.id === id ? [update.data] : []));
      const viaSnapshot = (await world.conversations.snapshot(bot.id)).items.filter((item) => item.id === id);
      const viaPage = (await world.conversations.page(bot.id, undefined)).items.filter((item) => item.id === id);
      for (const views of [viaSnapshot, viaPage, viaSse]) {
        expect(views).toHaveLength(1);
        expect(views[0]).toMatchObject({ kind: 'card', status: 'done', card: { type: 'routine_change', routineId: null, routineName: 'Ciclo', change: { action: 'delete' }, status: 'applied' } });
        expect(JSON.stringify(views[0])).not.toMatch(/restore|Executar Ciclo/);
      }
      const after = (await world.pool.query<{ data: Record<string, unknown> }>('SELECT data FROM messages WHERE id = $1', [id])).rows[0]!.data;
      expect(after.restore).toMatchObject({ routine: { id: routine.id } }); // ler a visão não consome nem altera o instantâneo
    });
  });
});

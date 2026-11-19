// Prova das funções puras da tela Atividades: a combinação das páginas (atualização periódica e "Carregar mais") sem repetir, perder
// nem ressuscitar execuções, o texto da origem, o destino do clique e o que permite parar.
import type { ActivitiesPage, RecentActivity, RunStatus } from '@aion/shared';
import { describe, expect, it } from 'vitest';
import { appendPage, canStop, conversationHref, conversationSourceOf, hasOpenWork, mergeFirstPage, originLabel, ownerName, type Recents } from './activities-state';

const BOT = { id: '8f0c2f4e-5f5f-4f7a-9d7e-1f8a6a1d0001', name: 'Alfa', color: '#60A5FA', archived: false };
const run = (id: number, status: RunStatus = 'completed', routineName: string | null = null): RecentActivity => ({
  runId: String(id),
  bot: BOT,
  sessionId: null,
  routineName,
  status,
  createdAt: '2026-10-02T12:00:00.000Z',
  messageId: String(id * 10),
});
const page = (ids: number[], nextCursor: string | null, overrides: Partial<Record<number, RunStatus>> = {}): ActivitiesPage => ({
  pending: [],
  items: ids.map((id) => run(id, overrides[id])),
  nextCursor,
});
const ids = (recents: Recents) => recents.items.map((item) => item.runId);

describe('combinar páginas da lista', () => {
  it('a atualização substitui a faixa que a página nova cobre e mantém o que foi carregado além dela, com o cursor que já valia', () => {
    // A tela tinha as páginas 1 e 2 (ids 120 a 21); chega uma atualização da primeira página, com duas execuções novas no topo.
    const loaded: Recents = { items: Array.from({ length: 100 }, (_, index) => run(120 - index, 'running')), nextCursor: '21' };
    const fresh = page(Array.from({ length: 50 }, (_, index) => 122 - index), '73', { 120: 'completed' });
    const merged = mergeFirstPage(loaded, fresh);
    expect(merged.items).toHaveLength(102); // 50 novas + as 52 mais antigas que já estavam
    expect(ids(merged).slice(0, 3)).toEqual(['122', '121', '120']);
    expect(merged.items.find((item) => item.runId === '120')?.status).toBe('completed'); // estado atualizado
    expect(merged.items.find((item) => item.runId === '71')?.status).toBe('running'); // além da faixa nova: mantido
    expect(new Set(ids(merged)).size).toBe(102); // sem repetir
    expect(merged.nextCursor).toBe('21'); // o cursor das páginas já carregadas continua valendo
  });

  it('sem nada carregado além da faixa nova, o cursor é o da página nova; sem próxima página, a página nova é a lista inteira', () => {
    const loaded: Recents = { items: [run(5, 'queued'), run(4)], nextCursor: null };
    // Uma execução cancelada (id 5) sumiu da lista nova: não é ressuscitada pela lista antiga.
    expect(mergeFirstPage(loaded, page([6, 4, 3], null))).toEqual({ items: [run(6), run(4), run(3)], nextCursor: null });
    // A lista tinha só 2 execuções e agora passa de uma página: nada do que estava carregado fica além da faixa nova, então o cursor é o
    // da página nova.
    const grown = Array.from({ length: 50 }, (_, index) => 90 - index);
    const afterNewRuns = mergeFirstPage({ items: [run(80), run(79)], nextCursor: null }, page(grown, '41'));
    expect(afterNewRuns.nextCursor).toBe('41');
    expect(ids(afterNewRuns)).toEqual(grown.map(String));
    expect(mergeFirstPage({ items: [], nextCursor: null }, page([], null))).toEqual({ items: [], nextCursor: null });
  });

  it('"Carregar mais" acrescenta a página seguinte e não repete o que uma atualização já trouxe', () => {
    const loaded: Recents = { items: [run(9), run(8), run(7)], nextCursor: '7' };
    const next = appendPage(loaded, page([7, 6, 5], '5')); // o 7 já estava (uma atualização o trouxe antes)
    expect(ids(next)).toEqual(['9', '8', '7', '6', '5']);
    expect(next.nextCursor).toBe('5');
    expect(appendPage(next, page([4], null)).nextCursor).toBeNull();
  });
});

describe('origem, destino do clique, parada e atividade em andamento', () => {
  it('a origem é "Mensagem" ou "Rotina: <nome>"', () => {
    expect(originLabel({ routineName: null })).toBe('Mensagem');
    expect(originLabel({ routineName: 'Resumo diário' })).toBe('Rotina: Resumo diário');
  });

  it('o clique leva ao cartão na conversa; sem mensagem (ainda na fila) abre a conversa', () => {
    expect(conversationHref({ bot: BOT, sessionId: null }, '42')).toBe(`/bots/${BOT.id}?mensagem=42`);
    expect(conversationHref({ bot: BOT, sessionId: null }, null)).toBe(`/bots/${BOT.id}`);
  });

  it('uma execução do chat geral tem o nome "Chat geral", abre a sessão dela e para pela rota da sessão (nunca a de um bot)', () => {
    const session = { bot: null, sessionId: '0b6d4b8e-7d63-4a54-9f55-3a2a0c1e0002' };
    expect(ownerName(session)).toBe('Chat geral');
    expect(ownerName({ bot: BOT })).toBe('Alfa');
    expect(conversationHref(session, '42')).toBe(`/chat/${session.sessionId}?mensagem=42`);
    expect(conversationHref(session, null)).toBe(`/chat/${session.sessionId}`);
    // Phase 4 (Suposição 12): execução fora do caminho ativo abre a sessão com o aviso, sem apontar para uma mensagem que a tela não mostra.
    expect(conversationHref(session, '42', true)).toBe(`/chat/${session.sessionId}?versao=outra`);
    expect(conversationHref({ bot: BOT, sessionId: null }, '42', false)).toBe(`/bots/${BOT.id}?mensagem=42`);
    expect(conversationSourceOf(session)).toEqual({ kind: 'session', id: session.sessionId });
    expect(conversationSourceOf({ bot: BOT, sessionId: null })).toEqual({ kind: 'bot', id: BOT.id });
  });

  it('só a execução que ocupa o bot pode ser parada', () => {
    const stoppable: RunStatus[] = ['running', 'waiting_approval'];
    const all: RunStatus[] = ['queued', 'running', 'waiting_approval', 'completed', 'failed', 'interrupted', 'limit_reached', 'expired', 'cancelled'];
    expect(all.filter(canStop)).toEqual(stoppable);
  });

  // As pendências ("Aguardando você") saíram desta tela na phase 5 (T4): quem as lê e as atualiza é `usePendingActivities`, em Aprovações.
  it('há trabalho em andamento com execução aberta; histórico só de terminadas, não', () => {
    expect(hasOpenWork({ items: [run(1), run(2, 'interrupted')], nextCursor: null })).toBe(false);
    expect(hasOpenWork({ items: [run(1), run(2, 'queued')], nextCursor: null })).toBe(true);
    expect(hasOpenWork({ items: [run(1, 'waiting_approval')], nextCursor: null })).toBe(true);
  });
});

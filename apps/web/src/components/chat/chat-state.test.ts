// Prova das funções puras do chat geral: o texto do vencimento ("apaga em N dias", sempre arredondando os dias que faltam para cima, com o
// relógio por parâmetro), o título da sessão ainda sem mensagem e a ordem da lista.
import type { ChatSession } from '@aion/shared';
import { describe, expect, it } from 'vitest';
import { NEW_SESSION_TITLE, byRecentActivity, chatsViewOf, expiryLabel, sectionsOf, sessionTitle, showsExpiryClock } from './chat-state';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const inMs = (ms: number): string => new Date(NOW + ms).toISOString();

describe('vencimento da sessão temporária', () => {
  it('conta os dias que faltam arredondando para cima: recém-criada "7 dias", e "1 dia" nas últimas 24 horas', () => {
    expect(expiryLabel(inMs(7 * DAY), NOW)).toBe('apaga em 7 dias');
    expect(expiryLabel(inMs(7 * DAY - 1), NOW)).toBe('apaga em 7 dias'); // um instante depois da última mensagem
    expect(expiryLabel(inMs(6 * DAY), NOW)).toBe('apaga em 6 dias');
    expect(expiryLabel(inMs(3 * DAY - 60_000), NOW)).toBe('apaga em 3 dias');
    expect(expiryLabel(inMs(2 * DAY + 1), NOW)).toBe('apaga em 3 dias');
    expect(expiryLabel(inMs(DAY), NOW)).toBe('apaga em 1 dia');
    expect(expiryLabel(inMs(60_000), NOW)).toBe('apaga em 1 dia'); // singular: nunca "1 dias"
  });

  it('nunca passa de 7 dias: o relógio da tela pode estar atrás de uma sessão criada agora', () => {
    expect(expiryLabel(inMs(7 * DAY + 5_000), NOW)).toBe('apaga em 7 dias'); // a sessão nasceu 5 s depois do último relógio da tela
    expect(expiryLabel(inMs(7 * DAY + 3_600_000), NOW)).toBe('apaga em 7 dias'); // até uma diferença maior de relógios
  });

  it('prazo já vencido e ainda não apagado (o job roda de madrugada) vira "apaga hoje"', () => {
    expect(expiryLabel(inMs(0), NOW)).toBe('apaga hoje');
    expect(expiryLabel(inMs(-5 * DAY), NOW)).toBe('apaga hoje');
  });
});

describe('título e ordem', () => {
  const session = (id: string, lastActivityAt: string, title: string | null = null): ChatSession => ({
    id,
    title,
    saved: false,
    createdAt: lastActivityAt,
    lastActivityAt,
    expiresAt: null,
    unread: false,
  });

  it('sem mensagem a sessão se chama "Novo chat"; com mensagem, o título gerado', () => {
    expect(NEW_SESSION_TITLE).toBe('Novo chat');
    expect(sessionTitle({ title: null })).toBe('Novo chat');
    expect(sessionTitle({ title: 'Resumo da semana' })).toBe('Resumo da semana');
  });

  it('a lista vai da atividade mais recente para a mais antiga', () => {
    const old = session('a', '2026-10-01T10:00:00.000Z');
    const recent = session('b', '2026-10-02T10:00:00.000Z');
    const middle = session('c', '2026-10-01T23:00:00.000Z');
    expect([old, recent, middle].sort(byRecentActivity).map((item) => item.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('vista de /chats pela URL (phase 5, T10)', () => {
  it('só o valor exato `salvos` abre os salvos; ausente, vazio, outra caixa ou desconhecido cai em "Todos"', () => {
    expect(chatsViewOf('salvos')).toBe('salvos');
    expect(chatsViewOf(null)).toBe('todos'); // sem `?vista=`
    for (const value of ['', 'todos', 'Salvos', 'SALVOS', 'salvo', 'salvos ', 'true', '1', 'qualquer-coisa']) expect(chatsViewOf(value), value).toBe('todos');
  });
});

describe('relógio da linha e seções da lista (phase 18, A22 e A24)', () => {
  const unsaved = (ms: number) => ({ saved: false, expiresAt: inMs(ms) });

  it.each([
    ['faltam 2 dias', unsaved(2 * DAY), false],
    ['faltam 1 dia e 1 minuto', unsaved(DAY + 60_000), false],
    ['falta 1 dia', unsaved(DAY), true],
    ['falta 1 hora', unsaved(60 * 60_000), true],
    ['o prazo já passou e o job ainda não apagou', unsaved(-60_000), true],
    ['salva', { saved: true, expiresAt: null }, false],
    ['sem data de expiração', { saved: false, expiresAt: null }, false],
  ] as const)('%s: relógio %s', (_name, session, expected) => {
    expect(showsExpiryClock(session, NOW)).toBe(expected);
  });

  it('as seções separam as salvas das recentes (as não salvas) sem mudar a ordem recebida', () => {
    const session = (id: string, saved: boolean) => ({ id, saved }) as ChatSession;
    const { saved, recent } = sectionsOf([session('a', false), session('b', true), session('c', false), session('d', true)]);
    expect(saved.map((item) => item.id)).toEqual(['b', 'd']);
    expect(recent.map((item) => item.id)).toEqual(['a', 'c']);
  });
});

// Prova das funções puras da tela Aprovações e do cartão de aprovação: busca ignorando acentos e maiúsculas, agrupamento por app, o
// tempo restante exibido no cartão e o número do badge.
import type { ActionRuleView } from '@aion/shared';
import { describe, expect, it } from 'vitest';
import { describeWork } from '../conversation/timeline';
import { badgeText, filterActions, formatTimeLeft, groupByApp } from './approvals-state';

const action = (slug: string, label: string, appSlug: string, appName: string): ActionRuleView => ({
  action: slug,
  label,
  appSlug,
  appName,
  globalRule: 'neutral',
  botRules: [],
});

const ACTIONS = [
  action('GMAIL_FETCH_EMAILS', 'Fetch Emails · Gmail', 'gmail', 'Gmail'),
  action('GMAIL_SEND_EMAIL', 'Send Email · Gmail', 'gmail', 'Gmail'),
  action('GOOGLECALENDAR_CRIAR_EVENTO', 'Criar evento · Google Agenda', 'googlecalendar', 'Google Agenda'),
];

describe('busca e agrupamento das ações', () => {
  it('a busca exige todas as palavras e ignora maiúsculas e acentos; vazia devolve tudo', () => {
    expect(filterActions(ACTIONS, '')).toHaveLength(3);
    expect(filterActions(ACTIONS, '   ')).toHaveLength(3);
    expect(filterActions(ACTIONS, 'send').map((item) => item.action)).toEqual(['GMAIL_SEND_EMAIL']);
    expect(filterActions(ACTIONS, 'GMAIL fetch').map((item) => item.action)).toEqual(['GMAIL_FETCH_EMAILS']);
    expect(filterActions(ACTIONS, 'AGENDA criar')).toHaveLength(1);
    expect(filterActions(ACTIONS, 'criár evênto')).toHaveLength(1); // acentos não atrapalham
    expect(filterActions(ACTIONS, 'google gmail')).toEqual([]); // todas as palavras precisam casar
  });

  it('agrupa por app mantendo a ordem de chegada', () => {
    expect(groupByApp(ACTIONS).map((group) => [group.appName, group.actions.length])).toEqual([
      ['Gmail', 2],
      ['Google Agenda', 1],
    ]);
    expect(groupByApp([])).toEqual([]);
  });
});

describe('tempo restante e badge', () => {
  const NOW = Date.parse('2026-10-01T12:00:00.000Z');
  const inMs = (ms: number) => new Date(NOW + ms).toISOString();

  it('mostra horas cheias, depois minutos, e "expirada" passado o prazo', () => {
    expect(formatTimeLeft(inMs(24 * 3_600_000), NOW)).toBe('24 h');
    expect(formatTimeLeft(inMs(23 * 3_600_000 + 59 * 60_000), NOW)).toBe('23 h');
    expect(formatTimeLeft(inMs(60 * 60_000), NOW)).toBe('1 h');
    expect(formatTimeLeft(inMs(59 * 60_000 + 1), NOW)).toBe('1 h'); // 59 min e 1 ms arredonda para 60 min
    expect(formatTimeLeft(inMs(45 * 60_000), NOW)).toBe('45 min');
    expect(formatTimeLeft(inMs(5_000), NOW)).toBe('1 min');
    expect(formatTimeLeft(inMs(0), NOW)).toBe('expirada');
    expect(formatTimeLeft(inMs(-1), NOW)).toBe('expirada');
    expect(formatTimeLeft('data inválida', NOW)).toBe('expirada');
  });

  it('o badge some em zero e vira "9+" acima de 9', () => {
    expect([0, -1].map(badgeText)).toEqual([null, null]);
    expect([1, 3, 9].map(badgeText)).toEqual(['1', '3', '9']);
    expect([10, 99].map(badgeText)).toEqual(['9+', '9+']);
  });
});

describe('resumo de atividades com aprovação pendente', () => {
  const activity = (id: string, status: 'running' | 'completed', awaitingApproval: boolean) => ({
    id,
    runId: '1',
    createdAt: '2026-10-01T12:00:00.000Z',
    kind: 'activity' as const,
    status,
    step: 1,
    tool: 'GMAIL_SEND_EMAIL',
    label: 'Send Email · Gmail',
    arguments: '{}',
    result: null,
    detail: null,
    awaitingApproval,
  });

  const lineOf = (...activities: ReturnType<typeof activity>[]) => ({ activities, startedAt: '2026-10-01T12:00:00.000Z', endedAt: '2026-10-01T12:00:09.000Z' });

  it('a linha de trabalho com uma ação esperando o dono diz "Aguardando aprovação" em vez de "Executando"', () => {
    expect(describeWork(lineOf(activity('1', 'completed', false), activity('2', 'running', true)), true)).toBe('Aguardando aprovação');
    expect(describeWork(lineOf(activity('1', 'running', false)), true)).toBe('Executando 1 ação');
    expect(describeWork(lineOf(activity('1', 'completed', false)), false)).toBe('Trabalhou por 9 s · 1 ação');
  });
});

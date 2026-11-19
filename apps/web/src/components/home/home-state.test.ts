// Prova das regras do Início (phase 5, T5; spec F4, Suposições 9, 10, 13 e 14) com o relógio e o fuso por parâmetro: as três faixas da saudação e as fronteiras
// (4h59, 5h, 11h59, 12h, 17h59, 18h), o fuso do dono (não o do navegador nem o UTC), o nome, o resumo do momento sem a parte zerada, o selo de cada estado e a linha
// de tempo dos chats recentes.
import { describe, expect, it } from 'vitest';
import { countWorking, greetingText, greetingWord, hourInZone, momentSummary, stateBadgeOf } from './home-state';

const SAO_PAULO = 'America/Sao_Paulo'; // UTC-3 o ano todo (sem horário de verão desde 2019)

/** Instante UTC que é a hora local dada em São Paulo, num dia qualquer (UTC-3: soma 3 horas). */
const atSaoPaulo = (hour: number, minute = 0): Date => new Date(Date.UTC(2026, 9, 10, hour + 3, minute));

describe('saudação pelo fuso do dono', () => {
  it('muda nas fronteiras: 4h59 é noite, 5h é dia, 11h59 é dia, 12h é tarde, 17h59 é tarde e 18h é noite', () => {
    const cases: [number, number, string][] = [
      [0, 0, 'Boa noite'],
      [4, 59, 'Boa noite'],
      [5, 0, 'Bom dia'],
      [11, 59, 'Bom dia'],
      [12, 0, 'Boa tarde'],
      [17, 59, 'Boa tarde'],
      [18, 0, 'Boa noite'],
      [23, 59, 'Boa noite'],
    ];
    for (const [hour, minute, word] of cases) expect(greetingText(atSaoPaulo(hour, minute), SAO_PAULO, ''), `${hour}:${minute}`).toBe(word);
    expect([5, 11, 12, 17, 18, 4].map(greetingWord)).toEqual(['Bom dia', 'Bom dia', 'Boa tarde', 'Boa tarde', 'Boa noite', 'Boa noite']);
  });

  it('vale a hora do fuso configurado, não a do UTC: o mesmo instante é tarde em São Paulo e noite em Tóquio', () => {
    const instant = new Date('2026-10-10T17:00:00Z'); // 14h em São Paulo, 2h do dia seguinte em Tóquio
    expect(hourInZone(instant, SAO_PAULO)).toBe(14);
    expect(hourInZone(instant, 'Asia/Tokyo')).toBe(2);
    expect(greetingText(instant, SAO_PAULO, '')).toBe('Boa tarde');
    expect(greetingText(instant, 'Asia/Tokyo', '')).toBe('Boa noite');
    expect(greetingText(instant, 'UTC', '')).toBe('Boa tarde');
  });

  it('meia-noite é hora 0, não 24, em qualquer fuso', () => {
    expect(hourInZone(new Date('2026-10-10T03:00:00Z'), SAO_PAULO)).toBe(0);
    expect(hourInZone(new Date('2026-10-10T00:00:00Z'), 'UTC')).toBe(0);
  });

  it('mostra o nome quando há, aparado, e fica sem nome quando vazio ou só espaços', () => {
    const instant = atSaoPaulo(14);
    expect(greetingText(instant, SAO_PAULO, 'Marco')).toBe('Boa tarde, Marco');
    expect(greetingText(instant, SAO_PAULO, '  Marco  ')).toBe('Boa tarde, Marco');
    expect(greetingText(instant, SAO_PAULO, '')).toBe('Boa tarde');
    expect(greetingText(instant, SAO_PAULO, '   ')).toBe('Boa tarde');
  });

  it('um fuso inválido não derruba a saudação: cai no fuso do navegador ou no UTC e devolve uma das três', () => {
    expect(['Bom dia', 'Boa tarde', 'Boa noite']).toContain(greetingText(atSaoPaulo(14), 'Nao/Existe', ''));
    expect(hourInZone(new Date('2026-10-10T15:00:00Z'), '')).toBeGreaterThanOrEqual(0);
  });
});

describe('resumo do momento', () => {
  it('junta bots trabalhando e aprovações com " · ", no singular e no plural', () => {
    expect(momentSummary({ working: 2, approvals: 1 })).toBe('2 bots trabalhando · 1 aprovação');
    expect(momentSummary({ working: 1, approvals: 3 })).toBe('1 bot trabalhando · 3 aprovações');
  });

  it('omite a parte zerada e, sem nenhuma, diz "Tudo em dia"', () => {
    expect(momentSummary({ working: 0, approvals: 2 })).toBe('2 aprovações');
    expect(momentSummary({ working: 3, approvals: 0 })).toBe('3 bots trabalhando');
    expect(momentSummary({ working: 0, approvals: 0 })).toBe('Tudo em dia');
  });

  it('conta como trabalhando só o bot ativo em `working`: arquivado e os outros estados não entram', () => {
    const bots = [
      { runState: 'working', archivedAt: null },
      { runState: 'working', archivedAt: '2026-10-01T00:00:00.000Z' },
      { runState: 'waiting', archivedAt: null },
      { runState: 'idle', archivedAt: null },
      { runState: 'working', archivedAt: null },
    ] as const;
    expect(countWorking(bots)).toBe(2);
    expect(countWorking([])).toBe(0);
  });
});

describe('selo de estado do bot', () => {
  it('só trabalhando, aguardando e erro têm selo; livre, concluído e dormindo ficam sem', () => {
    expect(stateBadgeOf('working')).toEqual({ label: 'Trabalhando', tone: 'neutral' });
    expect(stateBadgeOf('waiting')).toEqual({ label: 'Aguardando', tone: 'warning' });
    expect(stateBadgeOf('error')).toEqual({ label: 'Erro', tone: 'danger' });
    for (const state of ['idle', 'done', 'sleep'] as const) expect(stateBadgeOf(state), state).toBeNull();
  });
});

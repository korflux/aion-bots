// Prova do motor de agenda (T9, aceite A12): a prévia das próximas execuções para cada tipo de agenda, com fuso diferente do
// navegador e nos saltos do horário de verão de OUTRO fuso, mais os limites (início, fim) e as validações com motivo legível.
// Funções puras: sem banco. Os instantes esperados são calculados à mão (UTC) a partir do deslocamento do fuso em cada data.
import type { ScheduleDefinition } from '@aion/shared';
import { describe, expect, it } from 'vitest';
import { describeSchedule } from './describe';
import { datePatternOf, nextOccurrence, occurrencesAfter, scheduleProblem, windowTimes, type SchedulePlan } from './schedule';
import { daysInMonth, isValidTimeZone, localDateTimeToInstant, zonedTimeToInstant } from './zoned-time';
import { addCivilMonths, businessDayOfMonth } from './civil-date';

const SP = 'America/Sao_Paulo';
const NY = 'America/New_York';
const iso = (dates: Date[]) => dates.map((date) => date.toISOString());
const plan = (schedule: ScheduleDefinition, timezone = SP, extra: Partial<SchedulePlan> = {}): SchedulePlan => ({
  schedule,
  timezone,
  startsAt: null,
  endsAt: null,
  anchorAt: new Date('2026-10-01T13:03:27Z'),
  ...extra,
});
const after = new Date('2026-10-01T12:00:00Z'); // 09:00 em Brasília (UTC-3, sem horário de verão desde 2019)

describe('calendário civil compartilhado com fórmulas', () => {
  it('desloca cada mês desde a origem, nos dois sentidos, com bissextos gregorianos e sem deriva de dia', () => {
    const origin = { year: 2027, month: 1, day: 31 };
    expect(addCivilMonths(origin, 1)).toEqual({ year: 2027, month: 2, day: 28 });
    expect(addCivilMonths(origin, 2)).toEqual({ year: 2027, month: 3, day: 31 });
    expect(addCivilMonths(origin, -1)).toEqual({ year: 2026, month: 12, day: 31 });
    expect(addCivilMonths({ year: 2028, month: 1, day: 31 }, 1)).toEqual({ year: 2028, month: 2, day: 29 });
    expect(addCivilMonths({ year: 2100, month: 1, day: 31 }, 1)).toEqual({ year: 2100, month: 2, day: 28 });
    expect(businessDayOfMonth(2027, 1, 1)).toEqual({ year: 2027, month: 1, day: 1 });
    expect(businessDayOfMonth(2027, 2, 20)).toEqual({ year: 2027, month: 2, day: 26 });
    expect(businessDayOfMonth(2028, 2, 'last')).toEqual({ year: 2028, month: 2, day: 29 });
    expect(() => addCivilMonths({ year: 2027, month: 2, day: 29 }, 1)).toThrow(RangeError);
    expect(() => addCivilMonths(origin, 0.5)).toThrow(RangeError);
    expect(() => businessDayOfMonth(2027, 2, 21)).toThrow(RangeError);
  });
});

describe('hora local -> instante', () => {
  it('converte pelo deslocamento do dia e segue a RFC 5545 nos saltos do horário de verão', () => {
    expect(new Date(zonedTimeToInstant({ year: 2026, month: 10, day: 1 }, 9, 0, SP)).toISOString()).toBe('2026-10-01T12:00:00.000Z');
    // Nova York, antes do salto da primavera (EST, UTC-5) e depois (EDT, UTC-4): a mesma hora local, instantes diferentes.
    expect(new Date(zonedTimeToInstant({ year: 2027, month: 3, day: 13 }, 9, 0, NY)).toISOString()).toBe('2027-03-13T14:00:00.000Z');
    expect(new Date(zonedTimeToInstant({ year: 2027, month: 3, day: 15 }, 9, 0, NY)).toISOString()).toBe('2027-03-15T13:00:00.000Z');
    // 14/03/2027 02:30 não existe em Nova York: usa o deslocamento de ANTES do salto (UTC-5) e vira 03:30 EDT = 07:30Z.
    expect(new Date(zonedTimeToInstant({ year: 2027, month: 3, day: 14 }, 2, 30, NY)).toISOString()).toBe('2027-03-14T07:30:00.000Z');
    // 07/11/2027 01:30 ocorre duas vezes (EDT e depois EST): vale a primeira, 05:30Z.
    expect(new Date(zonedTimeToInstant({ year: 2027, month: 11, day: 7 }, 1, 30, NY)).toISOString()).toBe('2027-11-07T05:30:00.000Z');
  });

  it('lê data e hora locais em texto, conhece os dias do mês e recusa fuso que não é IANA', () => {
    expect(new Date(localDateTimeToInstant('2026-12-25T10:30', SP)).toISOString()).toBe('2026-12-25T13:30:00.000Z');
    expect(daysInMonth(2, true)).toBe(29);
    expect(daysInMonth(2, false)).toBe(28);
    expect(daysInMonth(4, false)).toBe(30);
    expect(isValidTimeZone('America/Sao_Paulo')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    for (const bad of ['Marte/Olimpo', '+03:00', 'America/', '', 'America Sao_Paulo']) expect(isValidTimeZone(bad)).toBe(false);
  });
});

describe('prévia por tipo de agenda', () => {
  it('única: uma execução só, e nenhuma depois dela', () => {
    const once = plan({ type: 'once', at: '2026-12-25T10:30' });
    expect(iso(occurrencesAfter(once, after, 5))).toEqual(['2026-12-25T13:30:00.000Z']);
    expect(occurrencesAfter(once, new Date('2026-12-25T13:30:00Z'), 5)).toEqual([]);
  });

  it('intervalo sem janela: a cada N minutos a partir da âncora (criação), e a cada N horas', () => {
    const everyFifteen = plan({ type: 'interval', every: 15, unit: 'minutes', window: null }); // âncora 10:03 (BRT)
    const justCreated = new Date('2026-10-01T13:03:27Z');
    expect(iso(occurrencesAfter(everyFifteen, justCreated, 3))).toEqual(['2026-10-01T13:18:00.000Z', '2026-10-01T13:33:00.000Z', '2026-10-01T13:48:00.000Z']);
    // Estritamente depois: em cima de uma ocorrência ela não se repete.
    expect(iso(occurrencesAfter(everyFifteen, new Date('2026-10-01T13:18:00Z'), 1))).toEqual(['2026-10-01T13:33:00.000Z']);
    const everyTwoHours = plan({ type: 'interval', every: 2, unit: 'hours', window: null }, SP, { startsAt: '2026-10-01T10:00' });
    // Com início, a primeira execução é o próprio início.
    expect(iso(occurrencesAfter(everyTwoHours, after, 3))).toEqual(['2026-10-01T13:00:00.000Z', '2026-10-01T15:00:00.000Z', '2026-10-01T17:00:00.000Z']);
  });

  it('intervalo com janela: recomeça em cada dia no início da janela e termina no fim dela (inclusive)', () => {
    const windowed = plan({ type: 'interval', every: 90, unit: 'minutes', window: { from: '09:00', to: '12:00' } });
    expect(windowTimes('09:00', '12:00', 90)).toEqual(['09:00', '10:30', '12:00']);
    expect(iso(occurrencesAfter(windowed, new Date('2026-10-01T13:00:00Z'), 5))).toEqual([
      '2026-10-01T13:30:00.000Z', // 10:30
      '2026-10-01T15:00:00.000Z', // 12:00
      '2026-10-02T12:00:00.000Z', // 09:00 do dia seguinte: a contagem recomeça
      '2026-10-02T13:30:00.000Z',
      '2026-10-02T15:00:00.000Z',
    ]);
  });

  it('diária com vários horários', () => {
    const daily = plan({ type: 'daily', times: ['18:30', '07:00'] });
    expect(iso(occurrencesAfter(daily, after, 4))).toEqual([
      '2026-10-01T21:30:00.000Z',
      '2026-10-02T10:00:00.000Z',
      '2026-10-02T21:30:00.000Z',
      '2026-10-03T10:00:00.000Z',
    ]);
  });

  it('semanal com vários dias e horários', () => {
    const weekly = plan({ type: 'weekly', days: ['MO', 'WE', 'FR'], times: ['09:00', '15:00'] });
    // 01/10/2026 é quinta-feira: a próxima é sexta 02/10, depois segunda 05/10.
    expect(iso(occurrencesAfter(weekly, after, 5))).toEqual([
      '2026-10-02T12:00:00.000Z',
      '2026-10-02T18:00:00.000Z',
      '2026-10-05T12:00:00.000Z',
      '2026-10-05T18:00:00.000Z',
      '2026-10-07T12:00:00.000Z',
    ]);
  });

  it('mensal por dia ajusta meses curtos, mantendo o dia-base nos meses seguintes', () => {
    const day15 = plan({ type: 'monthly_day', day: 15, time: '08:00' });
    expect(iso(occurrencesAfter(day15, after, 2))).toEqual(['2026-10-15T11:00:00.000Z', '2026-11-15T11:00:00.000Z']);
    const last = plan({ type: 'monthly_day', day: 'last', time: '08:00' });
    expect(iso(occurrencesAfter(last, after, 3))).toEqual(['2026-10-31T11:00:00.000Z', '2026-11-30T11:00:00.000Z', '2026-12-31T11:00:00.000Z']);
    const day31 = plan({ type: 'monthly_day', day: 31, time: '08:00' });
    expect(iso(occurrencesAfter(day31, after, 3))).toEqual(['2026-10-31T11:00:00.000Z', '2026-11-30T11:00:00.000Z', '2026-12-31T11:00:00.000Z']);
    expect(iso(occurrencesAfter(day31, new Date('2028-01-31T12:00:00Z'), 3))).toEqual(['2028-02-29T11:00:00.000Z', '2028-03-31T11:00:00.000Z', '2028-04-30T11:00:00.000Z']);
    for (const day of [29, 30, 31]) {
      const monthly = plan({ type: 'monthly_day', day, time: '08:00' });
      expect(iso(occurrencesAfter(monthly, new Date('2027-01-31T12:00:00Z'), 2))).toEqual(['2027-02-28T11:00:00.000Z', `2027-03-${day}T11:00:00.000Z`]);
    }
  });

  it('mensal por dia útil usa segunda a sexta incluindo feriados, com fuso e limites do período', () => {
    const first = plan({ type: 'monthly_business_day', position: 1, time: '09:00' });
    expect(iso(occurrencesAfter(first, new Date('2026-12-31T12:00:00Z'), 5))).toEqual([
      '2027-01-01T12:00:00.000Z', '2027-02-01T12:00:00.000Z', '2027-03-01T12:00:00.000Z', '2027-04-01T12:00:00.000Z', '2027-05-03T12:00:00.000Z',
    ]);
    const last = plan({ type: 'monthly_business_day', position: 'last', time: '09:00' }, NY);
    expect(iso(occurrencesAfter(last, new Date('2027-01-01T00:00:00Z'), 3))).toEqual(['2027-01-29T14:00:00.000Z', '2027-02-26T14:00:00.000Z', '2027-03-31T13:00:00.000Z']);
    const bounded = plan({ type: 'monthly_business_day', position: 20, time: '09:00' }, 'Asia/Tokyo', { startsAt: '2027-02-01T00:00', endsAt: '2027-02-28T23:59' });
    expect(iso(occurrencesAfter(bounded, new Date('2027-01-01T00:00:00Z'), 5))).toEqual(['2027-02-26T00:00:00.000Z']);
    expect(occurrencesAfter(bounded, new Date('2027-02-26T00:00:00Z'), 5)).toEqual([]);
  });

  it('mensal por posição: segunda terça-feira e última sexta-feira', () => {
    const secondTuesday = plan({ type: 'monthly_position', position: 'second', weekday: 'TU', time: '09:00' });
    expect(iso(occurrencesAfter(secondTuesday, after, 3))).toEqual(['2026-10-13T12:00:00.000Z', '2026-11-10T12:00:00.000Z', '2026-12-08T12:00:00.000Z']);
    const lastFriday = plan({ type: 'monthly_position', position: 'last', weekday: 'FR', time: '09:00' });
    expect(iso(occurrencesAfter(lastFriday, after, 3))).toEqual(['2026-10-30T12:00:00.000Z', '2026-11-27T12:00:00.000Z', '2026-12-25T12:00:00.000Z']);
  });

  it('anual: 29 de fevereiro só nos anos bissextos', () => {
    const leap = plan({ type: 'yearly', month: 2, day: 29, time: '09:00' });
    expect(iso(occurrencesAfter(leap, after, 2))).toEqual(['2028-02-29T12:00:00.000Z', '2032-02-29T12:00:00.000Z']);
    const christmas = plan({ type: 'yearly', month: 12, day: 25, time: '10:00' });
    expect(iso(occurrencesAfter(christmas, after, 2))).toEqual(['2026-12-25T13:00:00.000Z', '2027-12-25T13:00:00.000Z']);
  });

  it('cron de 5 campos avaliado no fuso da rotina, sempre estritamente depois de `after`', () => {
    const weekdays = plan({ type: 'cron', expression: '0 7 * * 1-5' });
    expect(iso(occurrencesAfter(weekdays, new Date('2026-10-02T12:00:00Z'), 3))).toEqual([
      '2026-10-05T10:00:00.000Z', // segunda 07:00 BRT
      '2026-10-06T10:00:00.000Z',
      '2026-10-07T10:00:00.000Z',
    ]);
    // Exatamente em cima de uma ocorrência: ela NÃO se repete.
    expect(iso(occurrencesAfter(weekdays, new Date('2026-10-05T10:00:00Z'), 1))).toEqual(['2026-10-06T10:00:00.000Z']);
  });
});

describe('fuso diferente do navegador e horário de verão de outro fuso', () => {
  it('a mesma hora local cai em instantes diferentes antes e depois do salto (Nova York, 09:00 diária)', () => {
    const daily = plan({ type: 'daily', times: ['09:00'] }, NY);
    expect(iso(occurrencesAfter(daily, new Date('2027-03-12T20:00:00Z'), 4))).toEqual([
      '2027-03-13T14:00:00.000Z', // sábado, EST (UTC-5)
      '2027-03-14T13:00:00.000Z', // domingo, depois do salto: EDT (UTC-4)
      '2027-03-15T13:00:00.000Z',
      '2027-03-16T13:00:00.000Z',
    ]);
  });

  it('uma hora que não existe no salto da primavera roda uma hora depois, em vez de perder o dia', () => {
    const daily = plan({ type: 'daily', times: ['02:30'] }, NY);
    expect(iso(occurrencesAfter(daily, new Date('2027-03-12T12:00:00Z'), 4))).toEqual([
      '2027-03-13T07:30:00.000Z',
      '2027-03-14T07:30:00.000Z', // 02:30 não existe; 03:30 EDT
      '2027-03-15T06:30:00.000Z',
      '2027-03-16T06:30:00.000Z',
    ]);
  });

  it('no fim do horário de verão a hora repetida roda uma vez só', () => {
    const daily = plan({ type: 'daily', times: ['01:30'] }, NY);
    expect(iso(occurrencesAfter(daily, new Date('2027-11-05T12:00:00Z'), 4))).toEqual([
      '2027-11-06T05:30:00.000Z',
      '2027-11-07T05:30:00.000Z', // a primeira das duas 01:30
      '2027-11-08T06:30:00.000Z',
      '2027-11-09T06:30:00.000Z',
    ]);
  });

  it('o cron também respeita o fuso e o salto', () => {
    const cron = plan({ type: 'cron', expression: '0 9 * * *' }, NY);
    expect(iso(occurrencesAfter(cron, new Date('2027-03-12T20:00:00Z'), 3))).toEqual(['2027-03-13T14:00:00.000Z', '2027-03-14T13:00:00.000Z', '2027-03-15T13:00:00.000Z']);
  });

  it('mensal por posição em outro fuso (Tóquio, sem horário de verão)', () => {
    const tokyo = plan({ type: 'monthly_position', position: 'first', weekday: 'MO', time: '09:00' }, 'Asia/Tokyo');
    expect(iso(occurrencesAfter(tokyo, after, 2))).toEqual(['2026-10-05T00:00:00.000Z', '2026-11-02T00:00:00.000Z']);
  });
});

describe('período (início e fim) e próxima execução', () => {
  it('só executa a partir do início e até o fim, no fuso da rotina', () => {
    const daily = plan({ type: 'daily', times: ['07:00'] }, SP, { startsAt: '2026-10-05T00:00', endsAt: '2026-10-07T07:00' });
    expect(iso(occurrencesAfter(daily, after, 10))).toEqual(['2026-10-05T10:00:00.000Z', '2026-10-06T10:00:00.000Z', '2026-10-07T10:00:00.000Z']);
    expect(nextOccurrence(daily, new Date('2026-10-07T10:00:00Z'))).toBeNull();
  });

  it('o intervalo conta a partir do início quando ele existe', () => {
    const everyTen = plan({ type: 'interval', every: 10, unit: 'minutes', window: null }, SP, { startsAt: '2026-10-02T08:00' });
    expect(iso(occurrencesAfter(everyTen, after, 2))).toEqual(['2026-10-02T11:00:00.000Z', '2026-10-02T11:10:00.000Z']);
  });
});

describe('validação com motivo legível', () => {
  const now = new Date('2026-10-01T12:00:00Z');
  const reason = (value: SchedulePlan) => scheduleProblem(value, now);

  it('aceita uma agenda correta', () => {
    expect(reason(plan({ type: 'daily', times: ['07:00'] }))).toBeNull();
  });

  it('recusa o intervalo abaixo de 5 minutos, a janela invertida, o cron quebrado e o dia que não existe', () => {
    expect(reason(plan({ type: 'interval', every: 4, unit: 'minutes', window: null }))?.reason).toBe('O intervalo mínimo é de 5 minutos.');
    expect(reason(plan({ type: 'interval', every: 5, unit: 'minutes', window: null }))).toBeNull();
    expect(reason(plan({ type: 'interval', every: 200, unit: 'hours', window: null }))?.reason).toMatch(/máximo/);
    expect(reason(plan({ type: 'interval', every: 30, unit: 'minutes', window: { from: '18:00', to: '09:00' } }))?.reason).toMatch(/janela/);
    expect(reason(plan({ type: 'cron', expression: '99 7 * * *' }))?.reason).toMatch(/cron inválida/);
    expect(reason(plan({ type: 'cron', expression: '0 7 * * 1-5 2026' }))?.reason).toMatch(/cron inválida/);
    expect(reason(plan({ type: 'cron', expression: '@daily' }))?.reason).toMatch(/cron inválida/);
    // O cron também respeita o intervalo mínimo (R16): sem isso `* * * * *` roda a cada minuto e contorna o limite dos intervalos.
    expect(reason(plan({ type: 'cron', expression: '* * * * *' }))?.reason).toMatch(/intervalo mínimo é de 5 minutos/);
    expect(reason(plan({ type: 'cron', expression: '*/2 * * * *' }))?.reason).toMatch(/intervalo mínimo/);
    expect(reason(plan({ type: 'cron', expression: '0,3 * * * *' }))?.reason).toMatch(/intervalo mínimo/); // 3 minutos entre a primeira e a segunda
    expect(reason(plan({ type: 'cron', expression: '*/5 * * * *' }))).toBeNull();
    expect(reason(plan({ type: 'cron', expression: '0 7 * * 1-5' }))).toBeNull();
    expect(reason(plan({ type: 'yearly', month: 4, day: 31, time: '09:00' }))?.code).toBe('SCHEDULE_INVALID');
    expect(reason(plan({ type: 'yearly', month: 2, day: 29, time: '09:00' }))).toBeNull();
  });

  it('recusa o fuso desconhecido, o fim antes do início e o período sem nenhuma execução futura', () => {
    expect(reason(plan({ type: 'daily', times: ['07:00'] }, 'Marte/Olimpo'))?.reason).toBe('Fuso horário desconhecido.');
    expect(reason(plan({ type: 'daily', times: ['07:00'] }, SP, { startsAt: '2026-10-10T00:00', endsAt: '2026-10-09T00:00' }))?.reason).toMatch(/fim/);
    expect(reason(plan({ type: 'daily', times: ['07:00'] }, SP, { endsAt: '2026-09-30T00:00' }))?.reason).toMatch(/Nenhuma execução/);
  });

  it('a execução única no passado é SCHEDULE_IN_PAST; no futuro, mas fora do período, é inválida', () => {
    expect(reason(plan({ type: 'once', at: '2026-09-01T10:00' }))?.code).toBe('SCHEDULE_IN_PAST');
    expect(reason(plan({ type: 'once', at: '2026-12-01T10:00' }))).toBeNull();
    expect(reason(plan({ type: 'once', at: '2026-12-01T10:00' }, SP, { endsAt: '2026-11-01T00:00' }))?.reason).toMatch(/fora do período/);
  });
});

describe('RRULE gerado e descrição em português', () => {
  it('gera só a parte dos dias; as horas ficam fora do RRULE', () => {
    expect(datePatternOf({ type: 'weekly', days: ['MO', 'FR'], times: ['09:00'] })).toBe('FREQ=WEEKLY;BYDAY=MO,FR');
    expect(datePatternOf({ type: 'monthly_position', position: 'last', weekday: 'FR', time: '09:00' })).toBe('FREQ=MONTHLY;BYDAY=-1FR');
    expect(datePatternOf({ type: 'monthly_day', day: 'last', time: '09:00' })).toBeNull(); // calendário civil com ajuste, não RRULE que omite mês
    expect(datePatternOf({ type: 'monthly_business_day', position: 1, time: '09:00' })).toBeNull();
    expect(datePatternOf({ type: 'yearly', month: 12, day: 25, time: '09:00' })).toBe('FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25');
    expect(datePatternOf({ type: 'cron', expression: '* * * * *' })).toBeNull();
    expect(datePatternOf({ type: 'interval', every: 5, unit: 'minutes', window: null })).toBeNull();
  });

  it('descreve cada tipo em frases curtas', () => {
    const described = (schedule: ScheduleDefinition) => describeSchedule(schedule);
    expect(described({ type: 'once', at: '2026-12-25T10:30' })).toBe('Uma vez, em 25/12/2026 às 10:30');
    expect(described({ type: 'interval', every: 30, unit: 'minutes', window: null })).toBe('A cada 30 minutos');
    expect(described({ type: 'interval', every: 1, unit: 'hours', window: null })).toBe('A cada hora');
    expect(described({ type: 'interval', every: 30, unit: 'minutes', window: { from: '09:00', to: '18:00' } })).toBe('A cada 30 minutos, das 09:00 às 18:00');
    expect(described({ type: 'daily', times: ['18:30', '07:00'] })).toBe('Todos os dias às 07:00 e 18:30');
    expect(described({ type: 'weekly', days: ['FR', 'MO', 'TU', 'WE', 'TH'], times: ['07:00'] })).toBe('Dias úteis às 07:00');
    expect(described({ type: 'weekly', days: ['SA', 'SU'], times: ['10:00'] })).toBe('Fins de semana às 10:00');
    expect(described({ type: 'weekly', days: ['WE', 'MO'], times: ['09:00', '15:00'] })).toBe('Segundas e quartas às 09:00 e 15:00');
    expect(described({ type: 'monthly_day', day: 15, time: '08:00' })).toBe('Todo dia 15 do mês às 08:00');
    expect(described({ type: 'monthly_day', day: 'last', time: '08:00' })).toBe('No último dia do mês às 08:00');
    expect(described({ type: 'monthly_position', position: 'second', weekday: 'TU', time: '09:00' })).toBe('Na segunda terça-feira do mês às 09:00');
    expect(described({ type: 'monthly_position', position: 'last', weekday: 'SA', time: '09:00' })).toBe('No último sábado do mês às 09:00');
    expect(described({ type: 'yearly', month: 12, day: 25, time: '10:00' })).toBe('Todo ano, em 25 de dezembro, às 10:00');
    expect(described({ type: 'cron', expression: '0 7 * * 1-5' })).toContain('07:00');
  });
});

// Prova do formulário da rotina (T9, F12): cada tipo vira a definição certa da agenda, a validação aponta o campo, e uma rotina salva
// (ou a proposta de um bot) volta ao formulário igual a como foi montada.
import type { RoutineView, ScheduleDefinition } from '@aion/shared';
import { describe, expect, it } from 'vitest';
import { emptyRoutineForm, errorsFromApi, formFromProposal, formFromRoutine, settingsOf, validateRoutineForm, type RoutineFormValues } from './schedule-form';

const NOW = new Date(2026, 9, 1, 15, 30); // 01/10/2026 15:30 no fuso da máquina
const base = (overrides: Partial<RoutineFormValues> = {}): RoutineFormValues => ({ ...emptyRoutineForm('bot-1', NOW), name: 'Resumo', instruction: 'Resuma o dia', ...overrides });

describe('agenda montada a partir dos campos', () => {
  it('cada tipo produz a definição da API', () => {
    expect(settingsOf(base())?.schedule).toEqual({ type: 'daily', times: ['07:00'] });
    expect(settingsOf(base({ kind: 'once', onceAt: '2026-12-25T10:30' }))?.schedule).toEqual({ type: 'once', at: '2026-12-25T10:30' });
    expect(settingsOf(base({ kind: 'interval', everyText: '15', unit: 'minutes', windowOn: true, windowFrom: '09:00', windowTo: '17:30' }))?.schedule).toEqual({
      type: 'interval',
      every: 15,
      unit: 'minutes',
      window: { from: '09:00', to: '17:30' },
    });
    expect(settingsOf(base({ kind: 'interval', everyText: '2', unit: 'hours', windowOn: false }))?.schedule).toEqual({ type: 'interval', every: 2, unit: 'hours', window: null });
    // Os dias saem na ordem da semana, qualquer que seja a ordem dos cliques.
    expect(settingsOf(base({ kind: 'weekly', days: ['FR', 'MO', 'WE'], times: ['09:00', '15:00'] }))?.schedule).toEqual({ type: 'weekly', days: ['MO', 'WE', 'FR'], times: ['09:00', '15:00'] });
    expect(settingsOf(base({ kind: 'monthly', monthlyMode: 'day', monthDay: 'last', monthTime: '08:00' }))?.schedule).toEqual({ type: 'monthly_day', day: 'last', time: '08:00' });
    expect(settingsOf(base({ kind: 'monthly', monthlyMode: 'day', monthDay: '15', monthTime: '08:00' }))?.schedule).toEqual({ type: 'monthly_day', day: 15, time: '08:00' });
    expect(settingsOf(base({ kind: 'monthly', monthlyMode: 'position', position: 'second', positionWeekday: 'TU', monthTime: '09:00' }))?.schedule).toEqual({
      type: 'monthly_position',
      position: 'second',
      weekday: 'TU',
      time: '09:00',
    });
    expect(settingsOf(base({ kind: 'yearly', yearMonth: '12', yearDay: '25', yearTime: '10:00' }))?.schedule).toEqual({ type: 'yearly', month: 12, day: 25, time: '10:00' });
    expect(settingsOf(base({ kind: 'cron', cron: '  0 7 * * 1-5 ' }))?.schedule).toEqual({ type: 'cron', expression: '0 7 * * 1-5' });
  });

  it('o período e o limite entram como nulos quando vazios, e uma agenda incompleta não vira envio', () => {
    expect(settingsOf(base())).toMatchObject({ timezone: 'America/Sao_Paulo', startsAt: null, endsAt: null, maxRuns: null });
    expect(settingsOf(base({ startsAt: '2026-10-05T00:00', endsAt: '2026-10-09T18:00', maxRunsText: '10' }))).toMatchObject({ startsAt: '2026-10-05T00:00', endsAt: '2026-10-09T18:00', maxRuns: 10 });
    for (const incomplete of [
      base({ kind: 'daily', times: [] }),
      base({ kind: 'daily', times: [''] }),
      base({ kind: 'daily', times: ['07:00', '07:00'] }),
      base({ kind: 'weekly', days: [] }),
      base({ kind: 'interval', everyText: '' }),
      base({ kind: 'interval', everyText: 'abc' }),
      base({ kind: 'cron', cron: '' }),
      base({ kind: 'once', onceAt: '' }),
      base({ timezone: '' }),
      base({ maxRunsText: '0' }),
    ]) {
      expect(settingsOf(incomplete)).toBeNull();
    }
  });
});

describe('validação do formulário inteiro', () => {
  it('aceita o formulário correto e monta o corpo da API', () => {
    const { draft, errors } = validateRoutineForm(base({ name: '  Resumo  ' }));
    expect(errors).toEqual({});
    expect(draft).toEqual({
      name: 'Resumo',
      botId: 'bot-1',
      instruction: 'Resuma o dia',
      schedule: { type: 'daily', times: ['07:00'] },
      timezone: 'America/Sao_Paulo',
      startsAt: null,
      endsAt: null,
      maxRuns: null,
    });
  });

  it('aponta o campo de cada problema', () => {
    const { draft, errors } = validateRoutineForm(base({ name: ' ', botId: '', instruction: '', maxRunsText: '99999', timezone: '' }));
    expect(draft).toBeNull();
    expect(errors).toEqual({
      name: 'Informe o nome.',
      botId: 'Escolha o bot.',
      instruction: 'Informe a instrução.',
      maxRuns: 'Informe um número de 1 a 10.000.',
      timezone: 'Informe o fuso horário.',
    });
    expect(validateRoutineForm(base({ name: 'x'.repeat(81) })).errors.name).toBe('Use até 80 caracteres.');
    expect(validateRoutineForm(base({ instruction: 'x'.repeat(4001) })).errors.instruction).toBe('Use até 4.000 caracteres.');
    expect(validateRoutineForm(base({ kind: 'cron', cron: '' })).errors.schedule).toBe('Complete a agenda.');
  });
});

describe('de volta ao formulário', () => {
  const view = (schedule: ScheduleDefinition, overrides: Partial<RoutineView> = {}): RoutineView => ({
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Resumo',
    bot: { id: '22222222-2222-4222-8222-222222222222', name: 'Bot', color: '#60A5FA', archived: false },
    instruction: 'Resuma o dia',
    schedule,
    timezone: 'America/New_York',
    startsAt: '2026-10-05T00:00',
    endsAt: null,
    maxRuns: 5,
    runCount: 0,
    status: 'active',
    summary: '',
    nextRunAt: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  });

  it('uma rotina salva volta ao formulário e gera exatamente a mesma agenda', () => {
    const schedules: ScheduleDefinition[] = [
      { type: 'once', at: '2026-12-25T10:30' },
      { type: 'interval', every: 90, unit: 'minutes', window: { from: '09:00', to: '12:00' } },
      { type: 'interval', every: 2, unit: 'hours', window: null },
      { type: 'daily', times: ['07:00', '18:30'] },
      { type: 'weekly', days: ['MO', 'WE'], times: ['09:00'] },
      { type: 'monthly_day', day: 'last', time: '08:00' },
      { type: 'monthly_day', day: 15, time: '08:00' },
      { type: 'monthly_position', position: 'last', weekday: 'FR', time: '09:00' },
      { type: 'monthly_business_day', position: 1, time: '09:00' },
      { type: 'monthly_business_day', position: 5, time: '09:00' },
      { type: 'monthly_business_day', position: 20, time: '09:00' },
      { type: 'monthly_business_day', position: 'last', time: '09:00' },
      { type: 'yearly', month: 12, day: 25, time: '10:00' },
      { type: 'cron', expression: '*/15 9-17 * * 1-5' },
    ];
    for (const schedule of schedules) {
      const form = formFromRoutine(view(schedule), NOW);
      expect(form).toMatchObject({ name: 'Resumo', botId: '22222222-2222-4222-8222-222222222222', timezone: 'America/New_York', startsAt: '2026-10-05T00:00', maxRunsText: '5' });
      expect(settingsOf(form)).toEqual({ schedule, timezone: 'America/New_York', startsAt: '2026-10-05T00:00', endsAt: null, maxRuns: 5 });
    }
  });

  it('a proposta do bot preenche o formulário no bot que a propôs', () => {
    const form = formFromProposal(
      { name: 'Resumo diário', instruction: 'Resuma', schedule: { type: 'daily', times: ['07:30'] }, timezone: 'America/Sao_Paulo', startsAt: null, endsAt: null, maxRuns: null },
      'bot-9',
      NOW,
    );
    expect(form).toMatchObject({ name: 'Resumo diário', instruction: 'Resuma', botId: 'bot-9', kind: 'daily', times: ['07:30'] });
  });

  it('os erros da API caem no campo certo, e o motivo legível da agenda é mantido', () => {
    expect(errorsFromApi([{ field: 'name', reason: 'Valor curto demais.' }, { field: 'schedule.times', reason: 'Valor inválido.' }])).toEqual({
      name: 'Nome inválido.',
      schedule: 'Complete a agenda.',
    });
    expect(errorsFromApi([{ field: 'schedule', reason: 'O intervalo mínimo é de 5 minutos.' }])).toEqual({ schedule: 'O intervalo mínimo é de 5 minutos.' });
    expect(errorsFromApi(undefined)).toEqual({});
  });
});
describe('agenda mensal por dia útil recebida do servidor', () => {
  it('reabrir, editar posição e trocar modalidade preserva o contrato sem ponte temporária', () => {
    const settings = { schedule: { type: 'monthly_business_day', position: 'last', time: '08:30' }, timezone: 'Asia/Tokyo', startsAt: null, endsAt: null, maxRuns: null } as const;
    const form = formFromProposal({ name: 'Fechamento', instruction: 'Executar fechamento', ...settings }, '00000000-0000-4000-8000-000000000001');
    expect(settingsOf(form)).toEqual(settings);
    expect(form).toMatchObject({ monthlyMode: 'business', businessPosition: 'last' });
    expect(settingsOf({ ...form, businessPosition: '5' })?.schedule).toEqual({ type: 'monthly_business_day', position: 5, time: '08:30' });
    expect(settingsOf({ ...form, monthlyMode: 'day', monthDay: '31' })?.schedule).toEqual({ type: 'monthly_day', day: 31, time: '08:30' });
    expect(settingsOf({ ...form, businessPosition: '21' })).toBeNull();
    expect(validateRoutineForm({ ...form, name: 'Nome editado' }).draft?.schedule).toEqual(settings.schedule);
  });
});

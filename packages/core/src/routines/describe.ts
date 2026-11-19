// Agenda legível em PT-BR (F12: lista de rotinas, prévia, cartões). Texto curto e factual, sempre derivado da MESMA definição que o
// motor de agenda usa, então a frase nunca discorda do que roda. O cron é descrito pelo `cronstrue`; se ele não souber, a lista
// mostra a própria expressão.
import type { MonthPosition, ScheduleDefinition, Weekday } from '@aion/shared';
import { WEEKDAYS } from '@aion/shared';
import cronstrue from 'cronstrue/i18n.js';
import { windowTimes } from './schedule';

const WEEKDAY_PLURAL: Record<Weekday, string> = {
  MO: 'segundas',
  TU: 'terças',
  WE: 'quartas',
  TH: 'quintas',
  FR: 'sextas',
  SA: 'sábados',
  SU: 'domingos',
};

/** "segunda-feira"... "domingo" e o gênero, que decide o ordinal ("segunda" vs "primeiro"). */
const WEEKDAY_LONG: Record<Weekday, { name: string; feminine: boolean }> = {
  MO: { name: 'segunda-feira', feminine: true },
  TU: { name: 'terça-feira', feminine: true },
  WE: { name: 'quarta-feira', feminine: true },
  TH: { name: 'quinta-feira', feminine: true },
  FR: { name: 'sexta-feira', feminine: true },
  SA: { name: 'sábado', feminine: false },
  SU: { name: 'domingo', feminine: false },
};

const ORDINAL: Record<MonthPosition, { feminine: string; masculine: string }> = {
  first: { feminine: 'primeira', masculine: 'primeiro' },
  second: { feminine: 'segunda', masculine: 'segundo' },
  third: { feminine: 'terceira', masculine: 'terceiro' },
  fourth: { feminine: 'quarta', masculine: 'quarto' },
  last: { feminine: 'última', masculine: 'último' },
};

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/** "a", "a e b", "a, b e c". */
function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} e ${items.at(-1)}`;
}

const atTimes = (times: readonly string[]): string => `às ${joinList([...times].sort())}`;

/** Dias da semana: os conjuntos conhecidos têm nome próprio. */
function describeDays(days: readonly Weekday[]): string {
  const sorted = WEEKDAYS.filter((day) => days.includes(day));
  const same = (expected: readonly Weekday[]) => sorted.length === expected.length && expected.every((day, index) => day === sorted[index]);
  if (sorted.length === 7) return 'Todos os dias';
  if (same(['MO', 'TU', 'WE', 'TH', 'FR'])) return 'Dias úteis';
  if (same(['SA', 'SU'])) return 'Fins de semana';
  const names = joinList(sorted.map((day) => WEEKDAY_PLURAL[day]));
  return names.charAt(0).toUpperCase() + names.slice(1);
}

/** `2026-10-12T14:30` -> `12/10/2026 às 14:30`. */
function describeLocalDateTime(local: string): string {
  const [date = '', time = ''] = local.split('T');
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year} às ${time}`;
}

/** Descrição de uma agenda. Não inclui o fuso (a tela o mostra à parte). */
export function describeSchedule(schedule: ScheduleDefinition): string {
  switch (schedule.type) {
    case 'once':
      return `Uma vez, em ${describeLocalDateTime(schedule.at)}`;
    case 'interval': {
      const every =
        schedule.unit === 'hours'
          ? schedule.every === 1
            ? 'A cada hora'
            : `A cada ${schedule.every} horas`
          : schedule.every === 1
            ? 'A cada minuto'
            : `A cada ${schedule.every} minutos`;
      if (!schedule.window) return every;
      const times = windowTimes(schedule.window.from, schedule.window.to, schedule.unit === 'hours' ? schedule.every * 60 : schedule.every);
      return `${every}, das ${times[0]} às ${times.at(-1)}`;
    }
    case 'daily':
      return `Todos os dias ${atTimes(schedule.times)}`;
    case 'weekly':
      return `${describeDays(schedule.days)} ${atTimes(schedule.times)}`;
    case 'monthly_day':
      return schedule.day === 'last' ? `No último dia do mês ${atTimes([schedule.time])}` : `Todo dia ${schedule.day} do mês ${atTimes([schedule.time])}${schedule.day > 28 ? ' (no último dia em meses curtos)' : ''}`;
    case 'monthly_business_day':
      return `${schedule.position === 'last' ? 'No último' : `No ${schedule.position}º`} dia útil do mês ${atTimes([schedule.time])}. Dias úteis: segunda a sexta, incluindo feriados`;
    case 'monthly_position': {
      const weekday = WEEKDAY_LONG[schedule.weekday];
      const ordinal = ORDINAL[schedule.position][weekday.feminine ? 'feminine' : 'masculine'];
      return `${weekday.feminine ? 'Na' : 'No'} ${ordinal} ${weekday.name} do mês ${atTimes([schedule.time])}`;
    }
    case 'yearly':
      return `Todo ano, em ${schedule.day} de ${MONTHS[schedule.month - 1]}, ${atTimes([schedule.time])}`;
    case 'cron':
      try {
        return cronstrue.toString(schedule.expression, { locale: 'pt_BR', use24HourTimeFormat: true });
      } catch {
        return `Cron ${schedule.expression}`;
      }
  }
}

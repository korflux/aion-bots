// Motor de agenda das rotinas (F12; SCHED-01): dada a definição estruturada de uma agenda, calcula as próximas execuções e acusa os
// problemas com um motivo legível. Funções puras (sem banco, sem relógio próprio): é a fonte única usada pela prévia do editor, pelo
// cartão de proposta, pela validação ao salvar e pelo agendador do worker, então "o que a prévia mostra" é "o que vai rodar".
//
// Como cada tipo vira datas:
// - calendário (diária, semanal, mensal por posição, anual e o intervalo COM janela): as DATAS vêm do `rrule-temporal`, que
//   implementa a RFC 5545 (primeira sexta do mês, último dia, fevereiro bissexto...), e as HORAS de cada data vêm de
//   `zonedTimeToInstant`, que aplica a regra da RFC para o horário de verão (ver `zoned-time.ts`);
// - mensal por dia ou dia útil: o calendário civil ajusta meses curtos preservando o dia-base, sem a omissão de datas do RRULE;
// - intervalo SEM janela: aritmética de instantes a partir da âncora (não depende de calendário nem de fuso);
// - única: um instante; cron: `cron-parser`, que avalia os 5 campos no fuso da rotina.
//
// Contrato de `occurrencesAfter`: instantes ESTRITAMENTE depois de `after`, no período [início, fim] da rotina, em ordem.
import { ROUTINE_MIN_INTERVAL_MINUTES, type MonthPosition, type ScheduleDefinition } from '@aion/shared';
import { CronExpressionParser } from 'cron-parser';
import { RRuleTemporal } from 'rrule-temporal';
import { daysInMonth, isValidTimeZone, localDateOf, localDateTimeToInstant, zonedTimeToInstant, type LocalDate } from './zoned-time';
import { addCivilMonths, businessDayOfMonth, isLeapYear } from './civil-date';

/** Tudo que o cálculo precisa saber de uma rotina. Início e fim são hora de parede no fuso (ver `@aion/shared/routines`). */
export interface SchedulePlan {
  schedule: ScheduleDefinition;
  timezone: string;
  startsAt: string | null;
  endsAt: string | null;
  /** De onde "a cada N minutos/horas" (sem janela) conta quando não há início: a criação ou a última edição da agenda. */
  anchorAt: Date;
}

export interface ScheduleProblem {
  code: 'SCHEDULE_INVALID' | 'SCHEDULE_IN_PAST';
  /** Frase pronta para a tela ("Agenda inválida: <motivo>"). */
  reason: string;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** Maior intervalo em horas aceito (uma semana). */
const INTERVAL_MAX_HOURS = 168;
/** Quantas execuções futuras de um cron entram na medida do menor intervalo entre duas delas (R16). */
const CRON_GAP_SAMPLE = 25;

/** Problema de agenda recusado pela validação, com o motivo que a tela mostra. */
const invalid = (reason: string): ScheduleProblem => ({ code: 'SCHEDULE_INVALID', reason });
/** Número com dois dígitos ("7" vira "07"), para montar "HH:mm". */
const pad2 = (value: number): string => String(value).padStart(2, '0');

/** "HH:mm" em minutos desde a meia-noite. */
const minutesOf = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
/** Minutos desde a meia-noite como "HH:mm" (o inverso de `minutesOf`). */
const timeOf = (minutes: number): string => `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;

/** Horários da janela de um intervalo: de `from` até `to`, de `every` em `every`, recomeçando em `from` a cada dia. */
export function windowTimes(from: string, to: string, stepMinutes: number): string[] {
  const times: string[] = [];
  for (let minute = minutesOf(from); minute <= minutesOf(to); minute += stepMinutes) times.push(timeOf(minute));
  return times;
}

/** Horas do dia de um tipo de calendário, em ordem crescente (`HH:mm` com zeros à esquerda ordena como texto). */
function timesOfDay(schedule: ScheduleDefinition): string[] {
  switch (schedule.type) {
    case 'daily':
    case 'weekly':
      return [...schedule.times].sort();
    case 'monthly_day':
    case 'monthly_business_day':
    case 'monthly_position':
    case 'yearly':
      return [schedule.time];
    case 'interval':
      return schedule.window ? windowTimes(schedule.window.from, schedule.window.to, schedule.unit === 'hours' ? schedule.every * 60 : schedule.every) : [];
    default:
      return [];
  }
}

const ORDINAL_BY_POSITION: Record<MonthPosition, number> = { first: 1, second: 2, third: 3, fourth: 4, last: -1 };

/**
 * A parte RRULE que escolhe os DIAS de um tipo de calendário (as horas ficam de fora, ver o cabeçalho). `null` nos tipos que não
 * são de calendário (única, intervalo sem janela, cron). Exportada para os testes provarem o texto gerado.
 */
export function datePatternOf(schedule: ScheduleDefinition): string | null {
  switch (schedule.type) {
    case 'daily':
      return 'FREQ=DAILY';
    case 'interval':
      return schedule.window ? 'FREQ=DAILY' : null;
    case 'weekly':
      return `FREQ=WEEKLY;BYDAY=${schedule.days.join(',')}`;
    case 'monthly_position':
      return `FREQ=MONTHLY;BYDAY=${ORDINAL_BY_POSITION[schedule.position]}${schedule.weekday}`;
    case 'yearly':
      return `FREQ=YEARLY;BYMONTH=${schedule.month};BYMONTHDAY=${schedule.day}`;
    default:
      return null;
  }
}

/** As primeiras `limit` datas do padrão a partir de `from` (inclusive). As datas são conceitos de calendário: o rrule roda em UTC. */
function calendarDates(pattern: string, from: LocalDate, limit: number): LocalDate[] {
  const start = `${String(from.year).padStart(4, '0')}${pad2(from.month)}${pad2(from.day)}T120000Z`;
  const rule = new RRuleTemporal({ rruleString: `DTSTART:${start}\nRRULE:${pattern}`, tzid: 'UTC' });
  return rule.all((_, index) => index < limit).map((date) => ({ year: date.year, month: date.month, day: date.day }));
}

/** O texto de cron tem exatamente os 5 campos e o `cron-parser` o aceita? */
function parseCron(expression: string, timezone: string, currentDate: Date) {
  if (expression.trim().split(/\s+/).length !== 5) throw new Error('campos');
  return CronExpressionParser.parse(expression, { currentDate, tz: timezone });
}

/**
 * As próximas `count` execuções estritamente depois de `after`, dentro do período da rotina. Não confere a validade da agenda: um
 * plano inválido (fuso desconhecido, cron quebrado) pode lançar, e quem precisa disso chama `scheduleProblem` antes.
 */
export function occurrencesAfter(plan: SchedulePlan, after: Date, count: number): Date[] {
  const { schedule, timezone } = plan;
  const start = plan.startsAt === null ? null : localDateTimeToInstant(plan.startsAt, timezone);
  const end = plan.endsAt === null ? Infinity : localDateTimeToInstant(plan.endsAt, timezone);
  // Estritamente depois de `after` e, com início, a partir dele (inclusive): "depois de start - 1 ms".
  const floor = Math.max(after.getTime(), start === null ? -Infinity : start - 1);
  const found: number[] = [];
  const take = (instant: number): boolean => {
    if (instant > end) return false;
    if (instant > floor) found.push(instant);
    return found.length < count;
  };

  if (schedule.type === 'once') {
    take(localDateTimeToInstant(schedule.at, timezone));
  } else if (schedule.type === 'cron') {
    const cursor = parseCron(schedule.expression, timezone, new Date(Math.max(floor, 0)));
    try {
      while (take(cursor.next().toDate().getTime())) {
        // `take` já acumula; o laço só para quando o limite ou o fim do período chega.
      }
    } catch {
      // O `cron-parser` lança quando não existe próxima data (ex.: 30 de fevereiro): nada mais a acrescentar.
    }
  } else if (schedule.type === 'interval' && schedule.window === null) {
    // ponytail: "a cada N horas" conta em horas corridas, sem acompanhar o salto do horário de verão (a rotina desliza uma hora no salto);
    // contar em hora de parede só se alguém precisar que o horário local se mantenha.
    const step = schedule.every * (schedule.unit === 'hours' ? HOUR_MS : MINUTE_MS);
    const anchor = start ?? Math.floor(plan.anchorAt.getTime() / MINUTE_MS) * MINUTE_MS;
    // O primeiro `k` com anchor + k * step > floor.
    let k = floor < anchor ? 0 : Math.floor((floor - anchor) / step) + 1;
    while (take(anchor + k * step)) k += 1;
  } else {
    const times = timesOfDay(schedule).map((time) => [Number(time.slice(0, 2)), Number(time.slice(3))] as const);
    // Cada data traz pelo menos uma execução depois da primeira, então `count + 2` datas bastam para `count` execuções.
    const from = localDateOf(Math.max(floor, 0), timezone);
    const dates = schedule.type === 'monthly_day' || schedule.type === 'monthly_business_day'
      ? Array.from({ length: count + 2 }, (_, index) => {
        const month = addCivilMonths({ ...from, day: 1 }, index);
        return schedule.type === 'monthly_business_day' ? businessDayOfMonth(month.year, month.month, schedule.position)
          : { ...month, day: schedule.day === 'last' ? daysInMonth(month.month, isLeapYear(month.year)) : Math.min(schedule.day, daysInMonth(month.month, isLeapYear(month.year))) };
      })
      : calendarDates(datePatternOf(schedule) as string, from, count + 2);
    scan: for (const date of dates) {
      const instants = [...new Set(times.map(([hour, minute]) => zonedTimeToInstant(date, hour, minute, timezone)))].sort((a, b) => a - b);
      for (const instant of instants) {
        if (instant > end) break scan;
        if (!take(instant)) break scan;
      }
    }
  }
  return found.map((instant) => new Date(instant));
}

/** A próxima execução depois de `after`, ou `null` se a agenda acabou (fim do período, execução única já passada). */
export function nextOccurrence(plan: SchedulePlan, after: Date): Date | null {
  return occurrencesAfter(plan, after, 1)[0] ?? null;
}

/**
 * Em que pé a rotina fica depois de `after`: ativa com a próxima execução, ou concluída (limite de execuções atingido, ou a agenda
 * acabou: fim do período, execução única já disparada). Usado ao criar, editar, retomar e a cada disparo do agendador.
 */
export function schedulingState(
  plan: SchedulePlan,
  { runCount, maxRuns }: { runCount: number; maxRuns: number | null },
  after: Date,
): { status: 'active'; nextRunAt: Date } | { status: 'completed'; nextRunAt: null } {
  if (maxRuns !== null && runCount >= maxRuns) return { status: 'completed', nextRunAt: null };
  const next = nextOccurrence(plan, after);
  return next ? { status: 'active', nextRunAt: next } : { status: 'completed', nextRunAt: null };
}

/**
 * Valida a agenda e devolve o primeiro problema com o motivo legível (`SCHEDULE_INVALID`), ou `SCHEDULE_IN_PAST` para uma execução
 * única que já passou. `null` = agenda aceita. Confere também que sobra ao menos uma execução futura dentro do período.
 */
export function scheduleProblem(plan: SchedulePlan, now: Date): ScheduleProblem | null {
  const { schedule, timezone } = plan;
  if (!isValidTimeZone(timezone)) return invalid('Fuso horário desconhecido.');
  const start = plan.startsAt === null ? null : localDateTimeToInstant(plan.startsAt, timezone);
  const end = plan.endsAt === null ? null : localDateTimeToInstant(plan.endsAt, timezone);
  if (start !== null && end !== null && end <= start) return invalid('O fim precisa ser depois do início.');

  switch (schedule.type) {
    case 'once': {
      const at = localDateTimeToInstant(schedule.at, timezone);
      if (at <= now.getTime()) return { code: 'SCHEDULE_IN_PAST', reason: 'A data e a hora da execução já passaram.' };
      if ((start !== null && at < start) || (end !== null && at > end)) return invalid('A execução única fica fora do período de início e fim.');
      return null;
    }
    case 'interval':
      if (schedule.unit === 'minutes' && schedule.every < ROUTINE_MIN_INTERVAL_MINUTES) {
        return invalid(`O intervalo mínimo é de ${ROUTINE_MIN_INTERVAL_MINUTES} minutos.`);
      }
      if (schedule.unit === 'hours' && schedule.every > INTERVAL_MAX_HOURS) return invalid(`O intervalo máximo é de ${INTERVAL_MAX_HOURS} horas.`);
      if (schedule.window && minutesOf(schedule.window.from) >= minutesOf(schedule.window.to)) {
        return invalid('Na janela, o horário de início precisa ser antes do fim.');
      }
      break;
    case 'yearly':
      if (schedule.day > daysInMonth(schedule.month, true)) return invalid('Esse dia não existe no mês escolhido.');
      break;
    case 'cron': {
      try {
        parseCron(schedule.expression, timezone, now);
      } catch {
        return invalid('Expressão cron inválida. Use 5 campos: minuto (0-59), hora (0-23), dia do mês (1-31), mês (1-12) e dia da semana (0-7).');
      }
      // O cron só tinha a sintaxe validada: `* * * * *` rodaria a cada minuto e contornaria o mínimo dos intervalos, que existe para
      // limitar o custo do provedor (R16). O menor espaço entre as próximas execuções precisa respeitar o mesmo mínimo.
      // ponytail: só as próximas 25 execuções são medidas, então uma expressão que só fica rápida demais depois delas passa; medir mais se aparecer.
      const sample = occurrencesAfter(plan, now, CRON_GAP_SAMPLE);
      for (let index = 1; index < sample.length; index += 1) {
        const gap = (sample[index] as Date).getTime() - (sample[index - 1] as Date).getTime();
        if (gap < ROUTINE_MIN_INTERVAL_MINUTES * 60_000) return invalid(`O intervalo mínimo é de ${ROUTINE_MIN_INTERVAL_MINUTES} minutos: esta expressão dispara com menos que isso entre duas execuções.`);
      }
      break;
    }
    default:
      break;
  }

  if (occurrencesAfter(plan, now, 1).length === 0) return invalid('Nenhuma execução cai dentro do período de início e fim.');
  return null;
}

// Hora de parede <-> instante em um fuso IANA, sem biblioteca de datas: só `Intl.DateTimeFormat`, que o Node já traz com o banco de
// fusos. É a base da agenda das rotinas ("todo dia às 07:00 em Brasília" é uma HORA DE PAREDE, não um instante).
//
// Por que existe (e não o rrule): o `rrule-temporal` OMITE uma ocorrência cuja hora local não existe (o salto da primavera do
// horário de verão, ex.: 02:30 em Nova York em 14/03/2027). A RFC 5545 (§3.3.5) manda usar o deslocamento de ANTES do salto, então
// 02:30 vira 03:30 e a rotina diária não perde o dia. Aqui as datas vêm do rrule e as HORAS vêm desta conversão, que segue a RFC:
// hora inexistente -> deslocamento de antes do salto (a hora avança); hora repetida (fim do horário de verão) -> a primeira.

import type { LocalDate } from './civil-date';
// Reexporta o contrato existente, agora compartilhado também pelas operações civis de fórmulas.
export { daysInMonth, type LocalDate } from './civil-date';

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Formatador por fuso (criar um `Intl.DateTimeFormat` é caro; o fuso inválido lança `RangeError`). */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}
/** Fuso IANA que o Node conhece? Recusa deslocamentos soltos como `+03:00`, que o `Intl` aceita mas não são fusos IANA. */
export function isValidTimeZone(timeZone: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(timeZone)) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

export interface LocalParts extends LocalDate {
  hour: number;
  minute: number;
  second: number;
}

/** Os campos da hora de parede de um instante no fuso. */
export function localPartsOf(instantMs: number, timeZone: string): LocalParts {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year as number,
    month: parts.month as number,
    day: parts.day as number,
    hour: parts.hour as number,
    minute: parts.minute as number,
    second: parts.second as number,
  };
}

/** A data local (no fuso) do instante. */
export function localDateOf(instantMs: number, timeZone: string): LocalDate {
  const { year, month, day } = localPartsOf(instantMs, timeZone);
  return { year, month, day };
}

/** Deslocamento do fuso no instante, em ms (hora de parede tratada como UTC menos o próprio instante, no segundo inteiro). */
function offsetAt(instantMs: number, timeZone: string): number {
  const whole = Math.floor(instantMs / 1000) * 1000;
  const p = localPartsOf(whole, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole;
}

const DAY_MS = 86_400_000;

/**
 * O instante (ms desde a época) em que o relógio do fuso marca `hour:minute` na data dada. Com salto de horário de verão no dia:
 * hora que não existe usa o deslocamento de antes do salto (02:30 vira 03:30); hora que ocorre duas vezes usa a primeira.
 */
export function zonedTimeToInstant(date: LocalDate, hour: number, minute: number, timeZone: string): number {
  const wall = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  // O deslocamento muda no máximo uma vez perto do dia: os dois lados (véspera e dia seguinte) cobrem as duas possibilidades.
  const offsetBefore = offsetAt(wall - DAY_MS, timeZone);
  const offsetAfter = offsetAt(wall + DAY_MS, timeZone);
  const matches = [...new Set([offsetBefore, offsetAfter])]
    .map((offset) => wall - offset)
    .filter((candidate) => {
      const p = localPartsOf(candidate, timeZone);
      return p.year === date.year && p.month === date.month && p.day === date.day && p.hour === hour && p.minute === minute;
    });
  if (matches.length > 0) return Math.min(...matches);
  return wall - offsetBefore;
}

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** Converte `YYYY-MM-DDTHH:mm` (hora de parede no fuso) em instante. O texto já passou pelo schema da borda. */
export function localDateTimeToInstant(local: string, timeZone: string): number {
  const match = LOCAL_DATE_TIME.exec(local);
  if (!match) throw new Error('data e hora local inválidas');
  const [, year, month, day, hour, minute] = match;
  return zonedTimeToInstant({ year: Number(year), month: Number(month), day: Number(day) }, Number(hour), Number(minute), timeZone);
}

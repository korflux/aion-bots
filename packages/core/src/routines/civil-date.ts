// Calendário gregoriano civil compartilhado por rotinas e fórmulas. Datas aqui são campos de calendário,
// nunca instantes UTC: só zoned-time converte uma data + hora + fuso em instante para executar uma rotina.
export interface LocalDate { year: number; month: number; day: number }

/** Regra gregoriana de fevereiro, inclusive séculos que não são bissextos. */
export const isLeapYear = (year: number): boolean => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

/** Dias do mês; mantém a assinatura usada pela validação anual existente. */
export function daysInMonth(month: number, leap: boolean): number {
  if (month === 2) return leap ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Borda civil para callers de fórmulas: não aceita data impossível nem saída fora de YYYY-MM-DD. */
export function assertCivilDate(date: LocalDate): void {
  if (!Number.isInteger(date.year) || date.year < 1 || date.year > 9999 || !Number.isInteger(date.month) || date.month < 1 || date.month > 12 || !Number.isInteger(date.day) || date.day < 1 || date.day > daysInMonth(date.month, isLeapYear(date.year))) throw new RangeError('data civil inválida');
}

/** Data textual civil para bordas compartilhadas, sem normalização silenciosa nem mudança de fuso. */
export function parseCivilDate(value: string): LocalDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError('data civil inválida');
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = { year, month, day };
  assertCivilDate(date);
  return date;
}

/** Serialização mantém dia civil e largura ISO de quatro dígitos. */
export function formatCivilDate(date: LocalDate): string {
  assertCivilDate(date);
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

/** Número ordinal gregoriano: permite somar/comparar dias sem transformar datas em instantes. */
export function civilOrdinal(date: LocalDate): number {
  assertCivilDate(date);
  const year = date.year - 1;
  let ordinal = year * 365 + Math.floor(year / 4) - Math.floor(year / 100) + Math.floor(year / 400) + date.day;
  for (let month = 1; month < date.month; month++) ordinal += daysInMonth(month, isLeapYear(date.year));
  return ordinal;
}

/** Desloca dias civis dentro de 0001..9999 usando ordinal, com busca limitada do ano. */
export function addCivilDays(origin: LocalDate, days: number): LocalDate {
  if (!Number.isSafeInteger(days)) throw new RangeError('deslocamento de dia inválido');
  let ordinal = civilOrdinal(origin) + days;
  if (ordinal < 1 || ordinal > civilOrdinal({ year: 9999, month: 12, day: 31 })) throw new RangeError('data civil fora do limite');
  let low = 1; let high = 9999;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (civilOrdinal({ year: middle, month: 1, day: 1 }) <= ordinal) low = middle; else high = middle - 1;
  }
  ordinal -= civilOrdinal({ year: low, month: 1, day: 1 }) - 1;
  let month = 1;
  while (ordinal > daysInMonth(month, isLeapYear(low))) ordinal -= daysInMonth(month++, isLeapYear(low));
  return { year: low, month, day: ordinal };
}

/** Desloca meses desde a ORIGEM e limita o dia ao último existente; não encadear datas já ajustadas em séries. */
export function addCivilMonths(origin: LocalDate, months: number): LocalDate {
  assertCivilDate(origin);
  if (!Number.isSafeInteger(months)) throw new RangeError('deslocamento de mês inválido');
  const monthIndex = origin.year * 12 + origin.month - 1 + months;
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex - year * 12 + 1;
  const date = { year, month, day: Math.min(origin.day, daysInMonth(month, isLeapYear(year))) };
  assertCivilDate(date);
  return date;
}

/** Dia da semana gregoriano (0 domingo, 6 sábado), por aritmética civil sem Date/fuso. */
function weekdayOf(date: LocalDate): number {
  const offsets = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  const year = date.year - (date.month < 3 ? 1 : 0);
  return (year + Math.floor(year / 4) - Math.floor(year / 100) + Math.floor(year / 400) + offsets[date.month - 1]! + date.day) % 7;
}

/** Primeiro ao vigésimo ou último dia útil: segunda a sexta, incluindo feriados, sem calendário externo. */
export function businessDayOfMonth(year: number, month: number, position: number | 'last'): LocalDate {
  assertCivilDate({ year, month, day: 1 });
  if (position !== 'last' && (!Number.isInteger(position) || position < 1 || position > 20)) throw new RangeError('posição de dia útil inválida');
  const last = daysInMonth(month, isLeapYear(year));
  let found = 0;
  for (let day = position === 'last' ? last : 1; day >= 1 && day <= last; day += position === 'last' ? -1 : 1) {
    const date = { year, month, day };
    const weekday = weekdayOf(date);
    if (weekday !== 0 && weekday !== 6 && (position === 'last' || ++found === position)) return date;
  }
  throw new RangeError('dia útil inexistente');
}

// Formatação de datas para a interface, em PT-BR. Funções puras (o relógio entra por parâmetro) para
// serem testáveis e para o SSR e o cliente concordarem quando o mesmo `now` é usado.

const relative = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto', style: 'short' });

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** "agora", "há 5 min", "há 2 h", "ontem"... a partir de uma data ISO e do instante de referência. */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const diff = new Date(iso).getTime() - now.getTime();
  const abs = Math.abs(diff);
  if (abs < 45_000) return 'agora';
  for (const [unit, size] of STEPS) {
    if (abs >= size || unit === 'minute') return relative.format(Math.round(diff / size), unit);
  }
  return 'agora';
}

/** Fuso do navegador (o do dono neste momento), ou `null` se o navegador não informa. */
export function browserTimeZone(): string | null {
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
}

/**
 * Data e hora de um instante num fuso IANA, em PT-BR com o dia da semana ("seg., 05/10/2026, 07:00"). É o formato da prévia das
 * rotinas e dos cartões: o horário aparece no fuso da rotina, não no do navegador. Fuso desconhecido cai no fuso do navegador.
 */
export function formatDateTimeInZone(iso: string, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' };
  try {
    return new Intl.DateTimeFormat('pt-BR', { ...options, timeZone }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat('pt-BR', options).format(new Date(iso));
  }
}

/** Só hora e minuto de um instante num fuso ("07:00"). */
export function formatTimeInZone(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('pt-BR', { timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  }
}

/** `AAAA-MM-DD` do instante no fuso (a data de calendário dele, não a do UTC). */
function dayKeyInZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/**
 * Próxima execução de uma rotina em poucas palavras ("hoje 07:00", "amanhã 07:00", "05/10 07:00"), no fuso da rotina. O relógio entra
 * por parâmetro (função pura).
 */
export function formatNextRun(iso: string, timeZone: string, now: Date = new Date()): string {
  const target = new Date(iso);
  let zone = timeZone;
  try {
    dayKeyInZone(target, zone);
  } catch {
    zone = browserTimeZone() ?? 'UTC';
  }
  const time = formatTimeInZone(iso, zone);
  const targetDay = dayKeyInZone(target, zone);
  const today = dayKeyInZone(now, zone);
  const tomorrow = dayKeyInZone(new Date(now.getTime() + 86_400_000), zone);
  if (targetDay === today) return `hoje ${time}`;
  if (targetDay === tomorrow) return `amanhã ${time}`;
  const [, month, day] = targetDay.split('-');
  return `${day}/${month} ${time}`;
}

// Fusos horários no navegador: a lista que alimenta os campos de fuso (agenda da rotina e Configurações → Idioma e fuso) e a conferência
// de um fuso digitado. Fonte única, para os dois campos não divergirem. O servidor continua sendo a autoridade: ele recusa um fuso que o
// runtime dele não conhece.

/** Fusos do navegador para o `datalist`; sem `Intl.supportedValuesOf` (navegador antigo) a lista fica vazia e o campo aceita digitação livre. */
export function timeZoneOptions(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}

/** O navegador conhece este fuso? (conferência rápida para mostrar o erro antes de enviar; vale também para `UTC`, que a lista não traz). */
export function isKnownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** O instante dado, escrito no fuso: "domingo, 1 de março de 2026 às 12:00 (GMT-03:00)". Só para mostrar ao dono como o fuso escolhido fica. */
export function describeNowIn(zone: string, now: Date): string {
  const when = new Intl.DateTimeFormat('pt-BR', { timeZone: zone, dateStyle: 'full', timeStyle: 'short' }).format(now);
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(now).find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  return `${when} (${offset})`;
}

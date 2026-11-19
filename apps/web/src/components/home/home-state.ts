// Regras do Início que não dependem de React (phase 5, T5; spec F4, Suposições 9, 10, 13 e 14): a saudação pela hora do fuso do dono, o resumo do momento, o selo
// de estado de cada bot. Funções PURAS com o relógio por parâmetro, provadas em `home-state.test.ts` sem navegador.
import type { BotSummary } from '@aion/shared';
import { browserTimeZone } from '@/lib/format';

/** A saudação de cada faixa do dia (Suposição 9): 5h às 11h59, 12h às 17h59 e 18h às 4h59. */
export type GreetingWord = 'Bom dia' | 'Boa tarde' | 'Boa noite';

/** Hora cheia (0 a 23) de um instante num fuso IANA; fuso desconhecido cai no do navegador e, sem ele, em UTC (o Início nunca cai por causa do fuso). */
export function hourInZone(at: number | Date, timeZone: string): number {
  const read = (zone: string): number => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).formatToParts(at);
    return Number(parts.find((part) => part.type === 'hour')?.value);
  };
  for (const zone of [timeZone, browserTimeZone(), 'UTC']) {
    if (zone === null) continue;
    try {
      const hour = read(zone);
      if (Number.isInteger(hour)) return hour;
    } catch {
      // Fuso inválido: tenta o próximo.
    }
  }
  return 0;
}

/** A saudação da hora dada (0 a 23). */
export function greetingWord(hour: number): GreetingWord {
  if (hour >= 5 && hour < 12) return 'Bom dia';
  if (hour >= 12 && hour < 18) return 'Boa tarde';
  return 'Boa noite';
}

/** "Boa tarde, Marco": a saudação no fuso do dono, com ", {nome}" quando ele preencheu "Como te chamar" (vazio: sem nome). */
export function greetingText(at: number | Date, timeZone: string, ownerName: string): string {
  const word = greetingWord(hourInZone(at, timeZone));
  const name = ownerName.trim();
  return name === '' ? word : `${word}, ${name}`;
}

/** "1 bot trabalhando" ou "2 bots trabalhando" (nunca "0 ..."; quem chama só pergunta com n > 0). */
const workingText = (count: number): string => `${count} ${count === 1 ? 'bot trabalhando' : 'bots trabalhando'}`;
/** "1 aprovação" ou "3 aprovações". */
const approvalsText = (count: number): string => `${count} ${count === 1 ? 'aprovação' : 'aprovações'}`;

/**
 * O resumo do momento (Suposição 10): bots em `working` e aprovações pendentes, separados por " · " e sem a parte zerada; sem nenhuma das duas, "Tudo em dia".
 * Os bots arquivados não contam (quem chama passa só os ativos).
 */
export function momentSummary({ working, approvals }: { working: number; approvals: number }): string {
  const parts = [working > 0 ? workingText(working) : null, approvals > 0 ? approvalsText(approvals) : null].filter((part): part is string => part !== null);
  return parts.length === 0 ? 'Tudo em dia' : parts.join(' · ');
}

/** Quantos bots ativos estão trabalhando agora (o `runState` ao vivo da lista). */
export const countWorking = (bots: readonly Pick<BotSummary, 'runState' | 'archivedAt'>[]): number =>
  bots.filter((bot) => bot.archivedAt === null && bot.runState === 'working').length;

/** Os estados que ganham selo na linha do bot (Suposição 13): o texto do selo e o tom do `StatusBadge`. Os demais (livre, concluído, dormindo) ficam sem selo. */
const STATE_BADGES: Partial<Record<BotSummary['runState'], { label: string; tone: 'neutral' | 'warning' | 'danger' }>> = {
  working: { label: 'Trabalhando', tone: 'neutral' },
  waiting: { label: 'Aguardando', tone: 'warning' },
  error: { label: 'Erro', tone: 'danger' },
};

/** O selo de estado da linha do bot, ou nulo quando o estado não tem selo (o texto do estado fica só para o leitor de tela). */
export const stateBadgeOf = (runState: BotSummary['runState']): { label: string; tone: 'neutral' | 'warning' | 'danger' } | null => STATE_BADGES[runState] ?? null;

// Resumo dos parâmetros de uma ação para o cartão de aprovação (F9: "parâmetros resumidos"). Quem decide precisa ver o suficiente
// para entender o efeito (destinatário, assunto, trecho do corpo) sem a tela virar um despejo de JSON: poucos parâmetros, cada
// valor truncado. Os argumentos vêm do modelo (dado não confiável); só viram texto, nunca são interpretados.
//
// Fidelidade do que se aprova: a ação executa com os argumentos COMPLETOS, então o que o cartão não mostra nunca pode ficar
// invisível. Os parâmetros além do limite não somem em silêncio: o resumo informa quantos foram omitidos e os nomes deles (um texto
// injetado em um e-mail lido pelo bot poderia pôr um `bcc` na 7ª posição). Valor cortado ganha reticências.
import type { ApprovalCard } from '@aion/shared';

/** Parâmetros mostrados no cartão e tamanho máximo do valor de cada um. */
export const SUMMARY_MAX_PARAMS = 6;
export const SUMMARY_VALUE_MAX = 120;
/** Nomes dos parâmetros omitidos listados no cartão (a contagem total vai sempre inteira). */
export const SUMMARY_OMITTED_NAMES_MAX = 20;

const CONTROL_CHARS = /\p{Cc}/gu;

/** Texto curto de um valor: strings como estão, o resto como JSON; controles viram espaço e o excesso é cortado com reticências. */
function shortText(value: unknown): string {
  const raw = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  const clean = raw.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  // Corte por pontos de código: cortar no meio de um par substituto (emoji) geraria texto que o jsonb do PostgreSQL recusa.
  const points = Array.from(clean);
  return points.length > SUMMARY_VALUE_MAX ? `${points.slice(0, SUMMARY_VALUE_MAX - 1).join('')}…` : clean;
}

export interface ArgumentSummary {
  /** Os primeiros parâmetros, com valores curtos. */
  params: ApprovalCard['params'];
  /** O que ficou de fora: total e nomes (até `SUMMARY_OMITTED_NAMES_MAX`). */
  omitted: ApprovalCard['omitted'];
}

/** Resumo dos argumentos; JSON inválido ou que não é objeto resulta em nada a mostrar (a chamada nem chega a executar). */
export function summarizeArguments(rawArguments: string): ArgumentSummary {
  const empty: ArgumentSummary = { params: [], omitted: { count: 0, names: [] } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments === '' ? '{}' : rawArguments);
  } catch {
    return empty;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return empty;
  const entries = Object.entries(parsed as Record<string, unknown>).filter(([, value]) => value !== null && value !== undefined && value !== '');
  return {
    params: entries.slice(0, SUMMARY_MAX_PARAMS).map(([name, value]) => ({ name: shortText(name), value: shortText(value) })),
    omitted: {
      count: Math.max(0, entries.length - SUMMARY_MAX_PARAMS),
      names: entries.slice(SUMMARY_MAX_PARAMS, SUMMARY_MAX_PARAMS + SUMMARY_OMITTED_NAMES_MAX).map(([name]) => shortText(name)),
    },
  };
}

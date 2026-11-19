// Prévia da última novidade da conversa de um bot, para a linha dele na lista (phase 5, T5; spec F4, Suposição 12). Funções PURAS, sem banco: o SQL de
// `BotService.list` traz a última novidade visível (ver `VISIBLE_NEWS_SQL`) e este módulo a transforma no texto de uma linha.
//
// Regras:
// - Resposta final do bot (texto concluído): a PRIMEIRA linha com texto, sem Markdown (títulos, listas, citações, ênfase, código, links e HTML saem), cortada em
//   `BOT_PREVIEW_MAX` caracteres.
// - Cartão de sistema: o título dele ("Aprovação pendente", "Rotina “X” concluída"...), cortado igual.
// - Sem novidade (conversa vazia, só mensagens do dono ou só texto em escrita): `BOT_PREVIEW_EMPTY`.
// A prévia é conteúdo da conversa: este módulo não escreve em log e quem o chama também não.
import { BOT_PREVIEW_EMPTY, BOT_PREVIEW_MAX, type SystemCard } from '@aion/shared';

/** Quantos caracteres do início de cada linha entram no tratamento de Markdown: a prévia tem 120, o resto nunca aparece (e limita o custo das expressões). */
const LINE_SCAN_MAX = 600;

/** Abreviação do estado da rotina no título do cartão da execução, igual à do cartão na conversa (`routine-card.tsx`, `RUN_TITLE`). */
const ROUTINE_RUN_TITLE = {
  running: 'iniciada',
  completed: 'concluída',
  failed: 'falhou',
  interrupted: 'interrompida',
  limit_reached: 'atingiu o limite',
  expired: 'expirou',
} as const satisfies Record<Extract<SystemCard, { type: 'routine_run' }>['state'], string>;

/** Título do cartão de alteração de rotina PENDENTE (proposta antiga), igual ao do cartão na conversa (`routine-card.tsx`, `CHANGE_TITLE`). */
const ROUTINE_CHANGE_TITLE = {
  update: 'Alterar a rotina',
  pause: 'Pausar a rotina',
  resume: 'Retomar a rotina',
  delete: 'Excluir a rotina',
} as const satisfies Record<Extract<SystemCard, { type: 'routine_change' }>['change']['action'], string>;

/** Título do cartão de alteração já APLICADA pelo bot (phase 10): "Rotina “X” alterada pelo bot", e o mesmo para pausada, retomada e excluída. */
const ROUTINE_CHANGE_APPLIED_TITLE = {
  update: 'alterada',
  pause: 'pausada',
  resume: 'retomada',
  delete: 'excluída',
} as const satisfies Record<Extract<SystemCard, { type: 'routine_change' }>['change']['action'], string>;

/** O cartão ainda aguarda o dono (proposta antiga) ou já foi decidido por ele? Só os estados novos (`applied`, `refused`, `edited`, `superseded`) são da rotina aplicada pelo bot. */
const isLegacyRoutineCard = (status: Extract<SystemCard, { type: 'routine_proposal' | 'routine_change' }>['status']): boolean =>
  status === 'pending' || status === 'confirmed' || status === 'stale';

/**
 * O título de um cartão de sistema como a conversa o mostra. Espelha os títulos dos componentes de cartão da web (a regra de exibição mora lá; aqui só o
 * texto da prévia). Total de propósito: um tipo de cartão que este código ainda não conhece vira um título genérico em vez de derrubar a lista inteira.
 * ponytail: os títulos duplicam os da web, mover para @aion/shared (e os cartões da web passarem a lê-los de lá) quando surgir um terceiro consumidor.
 */
export function cardTitleOf(card: SystemCard): string {
  switch (card.type) {
    case 'run_interrupted':
      return 'Execução interrompida';
    case 'run_limit':
      return 'Limite atingido';
    case 'run_failed':
      return 'A execução falhou';
    case 'approval':
      return card.status === 'pending' ? 'Aprovação pendente' : 'Aprovação';
    case 'memory_updated':
      return 'Memória atualizada';
    case 'objective_updated':
      return 'Objetivo atualizado';
    case 'routine_run':
      return `Rotina “${card.routineName}” ${ROUTINE_RUN_TITLE[card.state]}`;
    case 'routine_missed':
      return `Rotina “${card.routineName}” perdida`;
    case 'routine_proposal':
      return isLegacyRoutineCard(card.status) ? 'Proposta de rotina' : 'Rotina criada pelo bot';
    case 'routine_change':
      return isLegacyRoutineCard(card.status)
        ? `${ROUTINE_CHANGE_TITLE[card.change.action]} “${card.routineName}”`
        : `Rotina “${card.routineName}” ${ROUTINE_CHANGE_APPLIED_TITLE[card.change.action]} pelo bot`;
    case 'routine_confirmed':
      return `Rotina “${card.routineName}” confirmada`;
    case 'routine_refused':
      return `Rotina “${card.routineName}” recusada`;
    case 'routine_edited':
      return `Rotina “${card.routineName}” editada`;
    case 'model_without_tools':
      return 'Modelo sem ferramentas';
    default:
      return 'Atualização do sistema';
  }
}

/** Marcadores de bloco que não são texto: cerca de código (a linha só abre ou fecha o bloco). */
const FENCE = /^(```|~~~)/;
/** Linha só de traços, asteriscos ou sublinhados (régua horizontal) ou só de barras, traços e dois-pontos (separador de tabela). */
const RULE_OR_TABLE_SEPARATOR = /^(?:([-*_])(?:\s*\1){2,}|[|:\-\s]+)$/;

/** Tira o Markdown de BLOCO do começo da linha (título, citação, item de lista, caixa de tarefa) e as barras de tabela. */
function stripBlock(line: string): string {
  if (RULE_OR_TABLE_SEPARATOR.test(line)) return '';
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^(?:>\s?)+/, '')
    .replace(/^(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/, '')
    .replace(/^\||\|$/g, '')
    .replace(/\s*\|\s*/g, ' ');
}

/** Caractere escapado com barra (`\*`): o Markdown o trata como texto comum, então ele é protegido da ênfase (vira `<código>`) e volta sem a barra no fim. */
const ESCAPED = /\\([\\`*_{}[\]()#+\-.!|>~])/g;
const SHIELDED = /(\d+)/g;

/** Tira o Markdown EM LINHA: imagem e link ficam com o texto, código e ênfase ficam com o conteúdo, tags HTML saem e os escapes viram o caractere puro. */
function stripInline(text: string): string {
  return text
    .replace(ESCAPED, (_match, char: string) => `${char.charCodeAt(0)}`)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?=[^\w*]|$)/g, '$1$2')
    .replace(/(^|[^\w])_(?!\s)(.+?)_(?=[^\w]|$)/g, '$1$2')
    .replace(SHIELDED, (_match, code: string) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** A primeira linha da resposta que sobra com texto depois de tirar o Markdown ('' se nenhuma sobra). */
export function firstPlainLine(markdown: string): string {
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim().slice(0, LINE_SCAN_MAX);
    if (line === '' || FENCE.test(line)) continue;
    const plain = stripInline(stripBlock(line));
    if (plain !== '') return plain;
  }
  return '';
}

/** Corta em `BOT_PREVIEW_MAX` caracteres (pontos de código, reticências incluídas): o texto cortado termina em "…" e nunca passa do limite. */
export function clipPreview(text: string): string {
  const chars = Array.from(text);
  return chars.length <= BOT_PREVIEW_MAX ? text : `${chars.slice(0, BOT_PREVIEW_MAX - 1).join('').trimEnd()}…`;
}

/** A última novidade visível como o SQL a entrega: um texto concluído do bot (`text`), um cartão (`card`) ou nada (os dois nulos). */
export interface LastNews {
  text: string | null;
  card: SystemCard | null;
}

/** A prévia da linha do bot: o título do cartão ou a primeira linha limpa da resposta; `BOT_PREVIEW_EMPTY` sem novidade (ou com uma resposta só de marcação). */
export function previewOf({ text, card }: LastNews): string {
  const line = card !== null ? cardTitleOf(card) : text !== null ? firstPlainLine(text) : '';
  return line === '' ? BOT_PREVIEW_EMPTY : clipPreview(line);
}

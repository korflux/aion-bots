// Funções puras da tela Atividades (sem React): combinar páginas da lista de execuções, quem é o dono de um item (um bot ou o chat geral),
// texto da origem, destino do clique, o que permite parar e o tom do selo de estado. Separadas do componente para serem provadas por
// teste unitário.
import { ACTIVE_RUN_STATUSES, OPEN_RUN_STATUSES, type ActivitiesPage, type ActivityBot, type RecentActivity, type RunStatus } from '@aion/shared';
import type { ConversationSource } from '@/components/conversation/conversation-api';
import type { BadgeTone } from '@/components/settings/status-badge';

/** A lista Recentes como a tela a guarda: as execuções já carregadas e o cursor da próxima página (nulo = não há mais). */
export interface Recents {
  items: RecentActivity[];
  nextCursor: string | null;
}

/**
 * Atualização periódica: recebe a PRIMEIRA página nova e a combina com o que a tela já carregou (inclusive páginas pedidas em
 * "Carregar mais"). A faixa que a página nova cobre é substituída por inteiro (estados mudam e execuções somem, como a cancelada que
 * sai da fila); o que estava além dela é mantido, com o cursor que já valia. Sem `nextCursor`, a página nova é a lista inteira.
 */
export function mergeFirstPage(current: Recents, fresh: ActivitiesPage): Recents {
  if (fresh.nextCursor === null) return { items: fresh.items, nextCursor: null };
  const lowest = BigInt(fresh.items.at(-1)?.runId ?? '0');
  const older = current.items.filter((item) => BigInt(item.runId) < lowest);
  return { items: [...fresh.items, ...older], nextCursor: older.length > 0 ? current.nextCursor : fresh.nextCursor };
}

/** "Carregar mais": acrescenta a página seguinte sem repetir uma execução que uma atualização já trouxe. */
export function appendPage(current: Recents, page: ActivitiesPage): Recents {
  const known = new Set(current.items.map((item) => item.runId));
  return { items: [...current.items, ...page.items.filter((item) => !known.has(item.runId))], nextCursor: page.nextCursor };
}

/** Origem mostrada na linha: mensagem do dono ou "Rotina: <nome>". */
export const originLabel = (item: Pick<RecentActivity, 'routineName'>): string => (item.routineName === null ? 'Mensagem' : `Rotina: ${item.routineName}`);

/** O dono de um item da lista: um bot (`bot` preenchido) ou uma sessão do chat geral (`bot` nulo e `sessionId` preenchido). */
export interface ActivityOwner {
  bot: ActivityBot | null;
  sessionId: string | null;
}

/** Nome do dono na linha: o do bot ou "Chat geral". */
export const ownerName = (owner: Pick<ActivityOwner, 'bot'>): string => owner.bot?.name ?? 'Chat geral';

/** A conversa do dono, para as chamadas de parar (as mesmas rotas do bot e da sessão). */
export const conversationSourceOf = ({ bot, sessionId }: ActivityOwner): ConversationSource =>
  bot ? { kind: 'bot', id: bot.id } : { kind: 'session', id: sessionId ?? '' };

/**
 * Conversa do dono (o bot ou a sessão do chat geral), já apontando para o cartão (`?mensagem=` rola até ele); sem mensagem (ainda na
 * fila), abre a conversa no fim. Uma execução da sessão fora do caminho ativo (phase 4, `offPath`: outra versão ou rodada retrocedida) não está
 * na tela da sessão: o link a abre com `?versao=outra`, e a sessão avisa "Esta atividade está em outra versão da conversa." (Suposição 12).
 */
export const conversationHref = (owner: ActivityOwner, messageId: string | null, offPath = false): string => {
  const { kind, id } = conversationSourceOf(owner);
  if (offPath && kind === 'session') return `/chat/${id}?versao=outra`;
  return `${kind === 'bot' ? '/bots' : '/chat'}/${id}${messageId === null ? '' : `?mensagem=${messageId}`}`;
};

/** Só a execução que está ocupando o bot (trabalhando ou esperando aprovação) pode ser parada. */
export const canStop = (status: RunStatus): boolean => ACTIVE_RUN_STATUSES.includes(status);

/** Há alguma execução aberta? A tela então se atualiza mais depressa. */
export const hasOpenWork = ({ items }: Recents): boolean => items.some((item) => OPEN_RUN_STATUSES.includes(item.status));

/** Tom do selo de cada estado de execução (o mesmo vocabulário do histórico da rotina e dos cartões). */
export const STATUS_TONE: Record<RunStatus, BadgeTone> = {
  queued: 'neutral',
  running: 'neutral',
  waiting_approval: 'warning',
  completed: 'success',
  failed: 'danger',
  interrupted: 'warning',
  limit_reached: 'warning',
  expired: 'warning',
  cancelled: 'neutral',
};

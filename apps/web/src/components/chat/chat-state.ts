// Funções puras do chat geral (sem React): o texto do vencimento de uma sessão, o título que a tela mostra, a ordem da lista e a vista de `/chats` que a URL pede. Separadas
// do componente para serem provadas por teste unitário, com o relógio entrando por parâmetro.
import { CHAT_SESSION_RETENTION_DAYS, type ChatSession } from '@aion/shared';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Título de uma sessão que ainda não recebeu mensagem (o título nasce da primeira). */
export const NEW_SESSION_TITLE = 'Novo chat';

/** Título para mostrar: o gerado pela primeira mensagem ou, sem ele, "Novo chat". */
export const sessionTitle = (session: Pick<ChatSession, 'title'>): string => session.title ?? NEW_SESSION_TITLE;

/**
 * Texto do vencimento de uma sessão NÃO salva ("apaga em 3 dias"). Conta os dias que faltam arredondando para CIMA: uma sessão recém-criada
 * mostra "apaga em 7 dias" e a última contagem, "apaga em 1 dia", vale para as últimas 24 horas. Prazo já vencido e sessão ainda não apagada
 * (o job roda de madrugada, então pode haver até um dia de folga): "apaga hoje". O resultado nunca passa dos 7 dias do prazo: o relógio
 * da tela pode estar alguns segundos ATRÁS de uma sessão criada agora (ele só avança de minuto em minuto), e sem o teto uma sessão
 * recém-criada diria "apaga em 8 dias".
 */
export function expiryLabel(expiresAt: string, now: number): string {
  const days = Math.min(CHAT_SESSION_RETENTION_DAYS, Math.ceil((Date.parse(expiresAt) - now) / DAY_MS));
  if (days <= 0) return 'apaga hoje';
  return days === 1 ? 'apaga em 1 dia' : `apaga em ${days} dias`;
}

/** O aviso único da retenção, fixo sob "Recentes" quando há sessão não salva (phase 18, A23). */
export const RETENTION_NOTICE = 'Apagados 7 dias após a última mensagem';

/**
 * O relógio na linha da sessão (phase 18, A24): só a sessão NÃO salva a que falta 1 dia (24 h) ou menos para ser apagada, vencida inclusive (o job roda de madrugada). Com 1 dia e 1 minuto
 * ainda não; salva nunca. A data exata do apagamento é do ícone, não da linha.
 */
export const showsExpiryClock = (session: Pick<ChatSession, 'saved' | 'expiresAt'>, now: number): boolean =>
  !session.saved && session.expiresAt !== null && Date.parse(session.expiresAt) - now <= DAY_MS;

/** As duas seções da lista (phase 18, A22): "Salvos" e "Recentes" (as não salvas), cada uma na ordem recebida. */
export const sectionsOf = (sessions: readonly ChatSession[]): { saved: ChatSession[]; recent: ChatSession[] } => ({
  saved: sessions.filter((session) => session.saved),
  recent: sessions.filter((session) => !session.saved),
});

/** Ordem da lista: a sessão com a atividade mais recente primeiro (a mesma que a API devolve). */
export const byRecentActivity = (a: ChatSession, b: ChatSession): number => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);

/** As duas vistas de `/chats` (phase 5, T10): todas as sessões ou só as salvas. */
export type ChatsView = 'todos' | 'salvos';

/** O valor de `?vista=` que pede a vista dos salvos; qualquer outro valor (ou nenhum) é "Todos". */
export const SAVED_VIEW_PARAM = 'salvos';

/**
 * A vista que a URL pede: só o valor exato `salvos` abre os salvos; ausente, vazio, outra caixa ou desconhecido cai em "Todos" (uma URL editada à mão nunca quebra a página nem
 * esconde as sessões). Aceita o que `searchParams.get` devolve.
 */
export const chatsViewOf = (param: string | null): ChatsView => (param === SAVED_VIEW_PARAM ? 'salvos' : 'todos');

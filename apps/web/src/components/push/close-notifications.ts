// Fechamento das notificações do Aion pela página (phase 16, passo 5; NOTIF-01, A10): o ponto ÚNICO que fecha, neste aparelho, as notificações que o service worker
// exibiu. Todas são do Aion (só o `sw.js` do app as cria), então fechar é varrer `registration.getNotifications()` e fechar as que casam com um critério.
// Quem usa: o provedor do push (abrir o app fecha todas), `respondApproval` (decidir uma aprovação na tela fecha a notificação dela) e `usePresence` (abrir e olhar
// uma conversa fecha as dela). Melhor esforço e NUNCA lança: sem service worker, sem registro ou com o navegador recusando não há o que fechar, e fechar não
// pode atrapalhar quem decidiu a aprovação nem a abertura da tela.
//
// Como as notificações são achadas: a APROVAÇÃO pela tag (`aion-approval-<id da aprovação>`, a mesma forma de `approvalTagOf` no despachante do servidor, repetida aqui
// porque a web não importa o core), e a CONVERSA pelo caminho de abertura guardado em `data.url` (`/bots/<id>` ou `/chat/<id>`, com a consulta `?mensagem=` ignorada),
// que vale para resposta, rotina e aprovação da mesma conversa.
import type { ConversationSource } from '@/components/conversation/conversation-api';

/** Prefixo da tag de UMA aprovação (o servidor gera `aion-approval-<id>`; ver `approvalTagOf` em `push/dispatcher.ts`). */
const APPROVAL_TAG_PREFIX = 'aion-approval-';

/** Fecha as notificações exibidas que casam com `match`. Melhor esforço: qualquer falha do navegador é engolida. */
async function closeNotifications(match: (notification: Notification) => boolean): Promise<void> {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    for (const notification of (await registration?.getNotifications()) ?? []) {
      if (match(notification)) notification.close();
    }
  } catch {
    // Sem service worker ou sem permissão não há o que fechar.
  }
}

/** Caminho (sem consulta) para onde o toque na notificação leva, ou `null` se o dado guardado não é um caminho legível. */
function openPathOf(notification: Notification): string | null {
  const url = (notification.data as { url?: unknown } | null)?.url;
  if (typeof url !== 'string') return null;
  try {
    return new URL(url, 'https://aion.invalid').pathname;
  } catch {
    return null;
  }
}

/** Fecha todas as notificações do Aion deste aparelho (abrir o app). */
export const closeAllNotifications = (): Promise<void> => closeNotifications(() => true);

/** Fecha a notificação de UMA aprovação (o dono a decidiu na tela). A tag é comparada inteira: a aprovação 50 não fecha a 501. */
export const closeApprovalNotification = (approvalId: string): Promise<void> => closeNotifications((notification) => notification.tag === `${APPROVAL_TAG_PREFIX}${approvalId}`);

/** Fecha as notificações de uma conversa (o dono a abriu e está olhando): respostas, rotinas e aprovações dela, pelo caminho de abertura. */
export function closeConversationNotifications(source: ConversationSource): Promise<void> {
  const path = `${source.kind === 'bot' ? '/bots' : '/chat'}/${source.id}`;
  return closeNotifications((notification) => openPathOf(notification) === path);
}

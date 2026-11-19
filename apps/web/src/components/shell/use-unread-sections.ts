'use client';

// Quais seções da navegação acendem a bolinha de não lido (phase 3, F4/A7; spec Suposição 13): Bots quando algum bot ATIVO tem novidade (o arquivado
// mostra a bolinha só dentro de Arquivados, sem acender Bots) e Chat geral quando alguma sessão tem. Usado pela barra de ícones do desktop (Bots e Chat geral) e
// pela barra inferior do celular (`TabBar`, phase 5 T6: Bots acende a aba Início, onde os bots são listados, e Chat geral acende a aba Chats); os dados vêm dos stores
// compartilhados, com a releitura periódica de cada um (um relógio por store, não um por componente).
//
// A conversa aberta não acende a seção: a presença a marca lida, e o item aberto também não mostra a bolinha (design), então a navegação não pisca entre
// a chegada de uma resposta e a próxima renovação da leitura.
import { usePathname } from 'next/navigation';
import { botIsOpen, useLiveBots } from '@/components/bots/bots-store';
import { sessionIsOpen, useLiveChatSessions } from '@/components/chat/chat-store';

export interface UnreadSections {
  bots: boolean;
  chat: boolean;
}

/** Bots e Chat geral têm novidade fora da conversa aberta? */
export function useUnreadSections(): UnreadSections {
  const pathname = usePathname();
  const { bots } = useLiveBots();
  const { sessions } = useLiveChatSessions();
  return {
    bots: bots.some((bot) => bot.unread && bot.archivedAt === null && !botIsOpen(pathname, bot.id)),
    chat: sessions.some((session) => session.unread && !sessionIsOpen(pathname, session.id)),
  };
}

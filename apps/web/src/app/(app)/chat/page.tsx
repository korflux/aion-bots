// Seção Chat geral (F16): entrar em /chat abre sozinho um "Novo chat" (T16); as sessões temporárias ficam no painel da seção.
import type { Metadata } from 'next';
import { ChatHome } from '@/components/chat/chat-home';

export const metadata: Metadata = { title: 'Chat geral' };

export default function GeneralChatPage() {
  return <ChatHome />;
}

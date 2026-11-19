// /chats: a lista de sessões do Chat geral como página (phase 5, T6 e T10; spec Suposição 19), a aba "Chats" da barra inferior do celular e o destino de "Ver todos" do Início.
// Tem o campo "Pergunte ao Aion" no rodapé e a escolha "Todos | Salvos" (`?vista=salvos`). `/chat` continua sendo a porta do "Novo chat" (abre uma sessão nova).
import type { Metadata } from 'next';
import { ChatsHome } from '@/components/chat/chats-home';

export const metadata: Metadata = { title: 'Chats' };

export default function ChatsPage() {
  return <ChatsHome />;
}

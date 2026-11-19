// /chat/[sessaoId]: uma sessão do chat geral. Um id que não é UUID nem chega à API: cai no "Não encontrado" do app.
import { chatSessionParamsSchema } from '@aion/shared';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ChatSessionView } from '@/components/chat/chat-session';

export const metadata: Metadata = { title: 'Chat geral' };

export default async function ChatSessionPage({ params }: { params: Promise<{ sessaoId: string }> }) {
  const parsed = chatSessionParamsSchema.safeParse({ id: (await params).sessaoId });
  if (!parsed.success) notFound();
  // `key` reinicia o estado de carregamento ao navegar de uma sessão para outra.
  return <ChatSessionView key={parsed.data.id} id={parsed.data.id} />;
}

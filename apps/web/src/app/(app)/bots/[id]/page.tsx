// /bots/[id]: conversa do bot. Um id que não é UUID nem chega à API: cai no "Não encontrado" do app.
import { botIdParamsSchema } from '@aion/shared';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BotConversation } from '@/components/bots/bot-conversation';

export const metadata: Metadata = { title: 'Conversa' };

export default async function BotConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = botIdParamsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  // `key` reinicia o estado de carregamento ao navegar de um bot para outro.
  return <BotConversation key={parsed.data.id} id={parsed.data.id} />;
}

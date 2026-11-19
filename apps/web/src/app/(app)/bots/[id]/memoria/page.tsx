// /bots/[id]/memoria: editor da memória do bot, com contador e histórico de versões (F11).
import { botIdParamsSchema } from '@aion/shared';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BotMemory } from '@/components/memory/memory-editor';

export const metadata: Metadata = { title: 'Memória do bot' };

export default async function BotMemoryPage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = botIdParamsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  return <BotMemory key={parsed.data.id} botId={parsed.data.id} />;
}

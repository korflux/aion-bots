// /bots/[id]/editar: editor em modo de edição (F5), com a zona de arquivamento.
import { botIdParamsSchema } from '@aion/shared';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BotEditor } from '@/components/bots/bot-editor';

export const metadata: Metadata = { title: 'Editar bot' };

export default async function EditBotPage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = botIdParamsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  return <BotEditor botId={parsed.data.id} />;
}

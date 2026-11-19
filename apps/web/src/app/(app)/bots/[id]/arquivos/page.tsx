// Página dos arquivos do bot: UUID validado antes de carregar a identidade e a gestão compartilhada.
import { botIdParamsSchema } from '@aion/shared';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BotFiles } from '@/components/files/bot-files';

export const metadata: Metadata = { title: 'Arquivos do bot' };

/** Rejeita parâmetros inválidos e reinicia os estados cliente quando a navegação troca o bot. */
export default async function BotFilesPage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = botIdParamsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  return <BotFiles key={parsed.data.id} botId={parsed.data.id} />;
}

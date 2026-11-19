// /rotinas/nova: editor de rotina em modo de criação (F12). Com `?proposta=<id do cartão>&bot=<id>` abre preenchido com a proposta de um
// bot (botão Editar do cartão); valores que não têm o formato de id são ignorados.
import { botIdParamsSchema } from '@aion/shared';
import type { Metadata } from 'next';
import { RoutineEditor } from '@/components/routines/routine-editor';

export const metadata: Metadata = { title: 'Nova rotina' };

export default async function NewRoutinePage({ searchParams }: { searchParams: Promise<{ proposta?: string; bot?: string }> }) {
  const { proposta, bot } = await searchParams;
  const botId = botIdParamsSchema.shape.id.safeParse(bot);
  const proposal = proposta !== undefined && /^\d{1,18}$/.test(proposta) && botId.success ? { messageId: proposta, botId: botId.data } : undefined;
  return <RoutineEditor key={proposal?.messageId ?? 'nova'} proposal={proposal} />;
}

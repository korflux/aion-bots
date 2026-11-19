// /rotinas/[id]/historico: execuções da rotina com data prevista, data real, estado e o link para o cartão na conversa (F12 passo 5).
import { routineIdParamsSchema } from '@aion/shared';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { RoutineHistoryView } from '@/components/routines/routine-history';

export const metadata: Metadata = { title: 'Histórico da rotina' };

export default async function RoutineHistoryPage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = routineIdParamsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  return <RoutineHistoryView key={parsed.data.id} routineId={parsed.data.id} />;
}

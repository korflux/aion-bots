// /rotinas/[id]: editor de rotina em modo de edição (F12). Um id que não é UUID nem chega à API: cai no "Não encontrado" do app.
// Com `?cartao=<id da mensagem>` (o "Editar" do cartão de uma rotina que o bot criou ou alterou, phase 10) o editor liga a gravação ao cartão; valor que
// não tem o formato de id é ignorado e a tela vira a edição comum (o servidor ainda confere que o cartão é desta rotina).
import { routineChangeParamsSchema, routineIdParamsSchema } from '@aion/shared';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { RoutineEditor } from '@/components/routines/routine-editor';

export const metadata: Metadata = { title: 'Editar rotina' };

export default async function EditRoutinePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ cartao?: string | string[] }> }) {
  const parsed = routineIdParamsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  const card = routineChangeParamsSchema.safeParse({ messageId: (await searchParams).cartao });
  return <RoutineEditor routineId={parsed.data.id} cardId={card.success ? card.data.messageId : undefined} />;
}

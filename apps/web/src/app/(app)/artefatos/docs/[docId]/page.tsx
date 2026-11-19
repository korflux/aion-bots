// /artefatos/docs/[docId]: a página própria do doc (phase 14, passo 5), alcançável por link direto. A mesma tela abre ao lado da conversa no painel do passo 7. O id da URL é
// validado aqui antes de virar caminho de API; quem pode ver o doc é decidido pela API autenticada, e um id de doc que não existe mostra "Doc não encontrado".
import { docIdSchema } from '@aion/shared';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DocView } from '@/components/docs/doc-view';

export const metadata: Metadata = { title: 'Doc' };

export default async function DocPage({ params }: { params: Promise<{ docId: string }> }) {
  const { docId } = await params;
  if (!docIdSchema.safeParse(docId).success) notFound();
  return <DocView key={docId} docId={docId} />;
}

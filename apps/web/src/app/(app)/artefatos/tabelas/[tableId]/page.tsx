// /artefatos/tabelas/[tableId]: a página própria da tabela (phase 14, passo 6; A7 e A31), a rota canônica que a lista de Artefatos e o "Abrir em tela inteira" do painel usam, alcançável
// por link direto. É o mesmo editor das páginas antigas (`/bots/[id]/tabelas/[tableId]` e `/configuracoes/tabelas/[tableId]`, que continuam), com o pai fixo em Artefatos. O id da URL é
// validado aqui antes de virar caminho de API; quem pode ver a tabela é decidido pela API autenticada.
import { tableIdSchema } from '@aion/shared';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { TableEditor } from '@/components/tables/table-editor';

export const metadata: Metadata = { title: 'Tabela' };

export default async function TablePage({ params }: { params: Promise<{ tableId: string }> }) {
  const { tableId } = await params;
  if (!tableIdSchema.safeParse(tableId).success) notFound();
  return <TableEditor key={tableId} tableId={tableId} parentHref="/artefatos" />;
}

// Página própria antiga da tabela, em Configurações (continua existindo para links salvos e para os links de relação e de impedimento dos editores, A31): reutiliza o editor da rota
// canônica `/artefatos/tabelas/[tableId]`; acesso é sempre conferido pela API autenticada.
import { tableIdSchema } from '@aion/shared';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { TableEditor } from '@/components/tables/table-editor';

export const metadata: Metadata = { title: 'Tabela' };
/** Pai fixo (a área Artefatos, que substituiu a lista de Tabelas de Configurações) independe do histórico de navegação. */
export default async function Page({ params }: { params: Promise<{ tableId: string }> }) {
  const { tableId } = await params;
  if (!tableIdSchema.safeParse(tableId).success) notFound();
  return <TableEditor key={tableId} tableId={tableId} parentHref="/artefatos" />;
}

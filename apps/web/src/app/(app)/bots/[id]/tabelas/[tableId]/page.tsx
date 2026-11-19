// Página própria antiga da tabela, por bot (continua existindo para links salvos, A31): reutiliza o editor da rota canônica `/artefatos/tabelas/[tableId]`, e o pai fixo é a área
// Artefatos, porque a lista por bot que ficava acima dela passou a redirecionar para lá.
import { botIdParamsSchema, tableIdSchema } from '@aion/shared';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { TableEditor } from '@/components/tables/table-editor';

export const metadata: Metadata = { title: 'Tabela' };
/** Não aceita IDs arbitrários como caminho de API. */
export default async function Page({ params }: { params: Promise<{ id: string; tableId: string }> }) {
  const value = await params;
  if (!botIdParamsSchema.safeParse({ id: value.id }).success || !tableIdSchema.safeParse(value.tableId).success) notFound();
  return <TableEditor key={value.tableId} tableId={value.tableId} parentHref="/artefatos" />;
}

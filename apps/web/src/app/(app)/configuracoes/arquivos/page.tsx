// Entrada da gestão global de anexos; o servidor continua sendo a autoridade de exclusão.
import type { Metadata } from 'next';
import { FilesView } from '@/components/files/files-view';
export const metadata: Metadata = { title: 'Arquivos' };
/** Apresenta a lista autenticada e suas ações na coluna de Configurações. */
export default function FilesPage() { return <FilesView />; }

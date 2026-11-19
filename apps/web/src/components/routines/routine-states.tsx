// Estado compartilhado das telas de rotina: "Não encontrado" (ROUTINE_NOT_FOUND) com o caminho de volta à seção. O carregando e o erro de
// carga reaproveitam os das telas de bot (`bot-states`), que são genéricos.
import { SearchX } from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '@/components/page';
import { BackLink } from '@/components/shell/back-link';
import { Button } from '@/components/ui/button';

/** A rotina não existe (id antigo, digitado à mão, ou excluída em outra aba). Mantém um <h1> para a página não ficar sem título. */
export function RoutineNotFound() {
  return (
    <>
      <header className="flex h-[52px] items-center gap-2 px-4 md:px-6">
        <BackLink />
        <h1 className="text-[18px]/[26px] font-semibold text-fg">Não encontrado</h1>
      </header>
      <EmptyState
        icon={SearchX}
        action={
          <Button asChild variant="secondary">
            <Link href="/rotinas">Ir para Rotinas</Link>
          </Button>
        }
      >
        Esta rotina não existe ou foi excluída.
      </EmptyState>
    </>
  );
}

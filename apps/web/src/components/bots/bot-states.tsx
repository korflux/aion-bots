// Estados compartilhados das telas de bot (design: "Responsivo e estados"): carregando (skeleton), erro de
// carga com "Tentar novamente" e "Não encontrado" com o caminho de volta à seção.
import { SearchX } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/page';
import { BackLink } from '@/components/shell/back-link';

/** Esqueleto de carregamento; `aria-busy` e o rótulo anunciam o estado a leitores de tela. */
export function BotLoading({ label = 'Carregando bot' }: { label?: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="mx-auto flex w-full max-w-[640px] flex-col gap-3 px-4 py-6 md:px-6">
      {[0, 1, 2].map((row) => (
        <div key={row} className="h-11 animate-pulse rounded-md bg-surface" />
      ))}
    </div>
  );
}

/** `BOT_NOT_FOUND`: o bot não existe (id antigo, digitado à mão). Mantém um <h1> para a página não ficar sem título. */
export function BotNotFound() {
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
            <Link href="/bots">Ir para Bots</Link>
          </Button>
        }
      >
        Este bot não existe ou foi removido.
      </EmptyState>
    </>
  );
}

/** Falha de rede ou do servidor ao carregar: mensagem segura e nova tentativa. */
export function BotLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <>
      <header className="flex h-[52px] items-center gap-2 px-4 md:px-6">
        <BackLink />
        <h1 className="text-[18px]/[26px] font-semibold text-fg">Não foi possível carregar</h1>
      </header>
      <EmptyState
        icon={SearchX}
        action={
          <Button variant="secondary" onClick={onRetry}>
            Tentar novamente
          </Button>
        }
      >
        {message}
      </EmptyState>
    </>
  );
}

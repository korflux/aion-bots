'use client';

// Entrada da seção Chat geral (/chat): não é uma tela para ficar, é a porta do "Novo chat". Ao montar, pede o rascunho vazio e troca a
// URL por /chat/<id> (sem passo extra para o dono começar a conversar). Se a abertura falha, mostra "Tentar de novo" em vez de ficar presa.
// O efeito roda uma vez por montagem (`started`), porque o React em desenvolvimento executa efeitos duas vezes e a API já devolve o mesmo
// rascunho nas duas, mas uma tentativa a mais é ruído à toa.
import { MessageSquare } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { EmptyState, PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { useNewSession } from './use-new-session';

export function ChatHome() {
  const { open, busy, failed } = useNewSession({ replace: true });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void open();
  }, [open]);

  return (
    <>
      <PageHeader title="Chat geral" />
      {failed ? (
        <EmptyState
          icon={MessageSquare}
          action={
            <Button variant="primary" disabled={busy} onClick={() => void open()}>
              Tentar de novo
            </Button>
          }
        >
          Não foi possível abrir um novo chat.
        </EmptyState>
      ) : (
        <div role="status" aria-busy="true" aria-label="Abrindo novo chat" className="mx-auto flex w-full max-w-[760px] flex-col gap-3 px-4 pt-4 md:px-6">
          <div className="h-10 w-2/3 animate-pulse rounded-lg bg-surface" />
          <div className="h-10 w-1/2 animate-pulse rounded-lg bg-surface" />
        </div>
      )}
    </>
  );
}

'use client';

// Aviso "Ativar notificações" (F14 passo 1): uma faixa fina no topo do conteúdo do shell, oferecida enquanto o push não está ativo neste
// navegador e o servidor tem o Firebase configurado. O dono pode dispensá-la ("Agora não"); a escolha fica só neste navegador. Em Configurações
// → Notificações o aviso é a própria tela, então a faixa some ali. A permissão negada NÃO aparece aqui (insistir não adianta: só o dono libera
// nas configurações do navegador), só em Configurações.
import { Bell, LoaderCircle } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { dismissNotice, isNoticeDismissed } from './push-state';
import { usePush } from './push-provider';

export function NotificationNotice() {
  const { status, enable } = usePush();
  const pathname = usePathname();
  // Lido uma vez na montagem: até o servidor responder o estado é `loading` e nada é desenhado, então não há divergência de hidratação.
  const [dismissed, setDismissed] = useState(isNoticeDismissed);

  const offered = status === 'off' || status === 'error' || status === 'enabling';
  if (!offered || dismissed || pathname.startsWith('/configuracoes/notificacoes')) return null;

  const busy = status === 'enabling';
  return (
    <section aria-label="Aviso de notificações" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface grad-sheen px-4 py-2 md:px-6">
      <Bell className="size-4 shrink-0 text-muted" strokeWidth={1.5} aria-hidden />
      {/* `basis-56` faz o texto pedir pelo menos 14rem: em tela estreita os botões descem para a linha de baixo em vez de espremê-lo. */}
      <p className="min-w-0 grow basis-56 text-sm text-fg">
        {status === 'error'
          ? 'Não foi possível ativar as notificações. Tente de novo.'
          : 'Receba um aviso quando um bot terminar, falhar ou pedir a sua aprovação.'}
      </p>
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => void enable()}>
          {busy ? <LoaderCircle data-icon="LoaderCircle" className="size-4 animate-spin" aria-hidden /> : null}
          Ativar notificações
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            dismissNotice();
            setDismissed(true);
          }}
        >
          Agora não
        </Button>
      </div>
    </section>
  );
}

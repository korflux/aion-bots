'use client';

// Chaves "Mostrar conteúdo nos avisos" de Configurações → Notificações (phase 16, passo 7; NOTIF-02, SEC-07; A13): uma para os bots e outra para o Chat geral, ligadas por
// padrão, acima da matriz de silenciar. Ligada, o aviso diz o que aconteceu (começo da resposta, ação que espera aprovação com Aprovar e Recusar, resultado da rotina); desligada,
// vale o aviso genérico (nome e tipo) e SEM os botões de aprovação. O texto só chega ao aparelho por uma consulta ao Aion feita pelo service worker, nunca pelo serviço de push
// (a regra e a privacidade estão em `push/content.ts`, no core); esta tela só liga e desliga.
//
// Comportamento: salva NA HORA (sem botão), com o valor novo na tela antes da resposta e o anterior de volta se o servidor falhar (toast de erro), como o interruptor da Pesquisa
// na web. Enquanto grava, as chaves ignoram cliques e ficam com `aria-busy` e `aria-disabled` (e não `disabled`, que tiraria o foco do teclado no meio de um uso por Espaço);
// uma gravação por vez nas duas, porque a resposta traz o estado das DUAS e uma resposta atrasada não pode sobrescrever a outra chave. A área de toque é de 44 px e o desenho
// do interruptor é o do kit (`SwitchTrack`, tokens da identidade); nenhuma cor nova.
import type { PushContentOrigin, PushContentSettings } from '@aion/shared';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { SwitchTrack } from '@/components/ui/switch-track';
import { apiErrorMessage } from '@/lib/api-client';
import { useSession } from '@/lib/session-context';
import { fetchPushContent, setPushContent } from './push-api';

/** Estados da seção: esqueleto, falha de carga (com "Tentar novamente") e pronta com o estado das duas chaves. */
type Load = { status: 'loading' } | { status: 'error' } | { status: 'ready'; content: PushContentSettings };

/** As duas chaves: a origem na API, o campo no estado e o rótulo (que é também o nome acessível). */
const SWITCHES: ReadonlyArray<{ origin: PushContentOrigin; field: keyof PushContentSettings; label: string; short: string }> = [
  { origin: 'bots', field: 'bots', label: 'Mostrar conteúdo nos avisos dos bots', short: 'dos bots' },
  { origin: 'general_chat', field: 'generalChat', label: 'Mostrar conteúdo nos avisos do Chat geral', short: 'do Chat geral' },
];

export function ContentSwitches() {
  const { csrfToken } = useSession();
  const headingId = useId();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  // Incrementar força uma nova carga (botão "Tentar novamente").
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchPushContent().then(
      (content) => {
        if (!cancelled) setLoad({ status: 'ready', content });
      },
      () => {
        if (!cancelled) setLoad({ status: 'error' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  /** Liga ou desliga uma origem: valor novo na tela de imediato, gravação no servidor e, se falhar, o valor anterior de volta com um toast de erro. */
  async function toggle(item: (typeof SWITCHES)[number]) {
    if (load.status !== 'ready' || saving) return;
    const next = !load.content[item.field];
    const previous = load.content;
    setSaving(true);
    setLoad({ status: 'ready', content: { ...previous, [item.field]: next } });
    try {
      const saved = await setPushContent({ origin: item.origin, enabled: next }, csrfToken);
      setLoad({ status: 'ready', content: saved });
      toast(`Conteúdo nos avisos ${item.short} ${next ? 'ligado' : 'desligado'}`);
    } catch (error) {
      setLoad({ status: 'ready', content: previous });
      toast.error(apiErrorMessage(error), { duration: Infinity });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="mb-2 text-xs font-medium uppercase tracking-wide text-subtle">
        Conteúdo dos avisos
      </h2>
      {load.status === 'error' ? (
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-sm text-danger">
            Não foi possível carregar as chaves de conteúdo dos avisos.
          </p>
          <Button
            onClick={() => {
              setLoad({ status: 'loading' });
              setAttempt((value) => value + 1);
            }}
          >
            Tentar novamente
          </Button>
        </div>
      ) : load.status === 'loading' ? (
        <div aria-busy="true" aria-label="Carregando o conteúdo dos avisos" className="h-28 animate-pulse rounded-md border border-line bg-surface" />
      ) : (
        <div className="rounded-md border border-line bg-surface grad-sheen p-4 md:p-5">
          <ul className="divide-y divide-line">
            {SWITCHES.map((item) => (
              <li key={item.origin} className="flex min-h-11 items-center justify-between gap-4 py-1 first:pt-0 last:pb-0">
                <span className="text-sm font-medium text-fg">{item.label}</span>
                {/* `aria-disabled` em vez de `disabled` durante a gravação: o botão desabilitado perderia o foco do teclado no meio de um uso por Espaço. */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={load.content[item.field]}
                  aria-label={item.label}
                  aria-busy={saving || undefined}
                  aria-disabled={saving || undefined}
                  onClick={() => void toggle(item)}
                  className="-mr-1 flex h-11 min-w-11 shrink-0 items-center justify-center rounded-md aria-disabled:opacity-60"
                >
                  <SwitchTrack on={load.content[item.field]} />
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted">Ligada, o aviso mostra o começo da resposta do bot, a ação que espera a sua aprovação, com os botões Aprovar e Recusar, e o resultado da rotina.</p>
          <p className="mt-1 text-xs text-muted">Desligada, o aviso fica genérico: só o nome e o tipo, sem os botões Aprovar e Recusar.</p>
          <p className="mt-1 text-xs text-muted">O que aparece com a tela bloqueada é ajustado no Android, nas configurações de notificação do app.</p>
        </div>
      )}
    </section>
  );
}

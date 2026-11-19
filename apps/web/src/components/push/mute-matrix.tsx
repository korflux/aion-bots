'use client';

// Matriz de silenciar (F14 passo 4, T13; design "Tela: Configurações → Notificações"): bots nas linhas (mais o Chat geral, a outra origem de
// aviso) e os quatro tipos de evento nas colunas, cada célula um toggle. Toggle LIGADO = o dono recebe aquele aviso (o padrão); desligar
// silencia. A escolha vale no servidor: o worker consulta a mesma matriz na hora de enviar, então nenhum dispositivo precisa ser
// reconfigurado.
//
// Layout responsivo com uma única árvore de elementos (sem versão duplicada para o mobile): a partir de `md` é uma tabela, com os
// rótulos dos tipos no cabeçalho; abaixo disso cada bot vira um bloco com os quatro tipos em 2 × 2, cada toggle com o próprio rótulo
// visível. A semântica de tabela vem dos `role`, então não depende do `display` que o CSS dá a cada peça.
import { PUSH_EVENT_KINDS, type PushEventKind, type PushMuteTarget } from '@aion/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { SwitchTrack } from '@/components/ui/switch-track';
import { apiErrorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/session-context';
import { fetchPushPreferences, setPushMute } from './push-api';

/** Rótulo curto de cada tipo (cabeçalho da coluna e rótulo do toggle no mobile). O `Record` obriga a cobrir todo tipo novo da allowlist. */
const KIND_LABELS: Record<PushEventKind, string> = {
  run_completed: 'Concluída',
  run_failed: 'Falha',
  approval_pending: 'Aprovação pendente',
  approval_expired: 'Aprovação expirada',
};

/** Colunas da tabela a partir de `md`: o nome do bot e uma coluna fixa por tipo. Compartilhada pelo cabeçalho e pelas linhas. */
const DESKTOP_COLUMNS = 'md:grid-cols-[minmax(0,1fr)_repeat(4,6rem)]';

/** Chave de uma linha (o bot, ou o Chat geral), para marcar quais estão com uma gravação em andamento. */
const rowKey = (botId: string | null): string => botId ?? 'chat-geral';

export function MuteMatrix() {
  const { csrfToken } = useSession();
  const [targets, setTargets] = useState<PushMuteTarget[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    fetchPushPreferences().then(
      (list) => {
        if (!cancelled) setTargets(list);
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(apiErrorMessage(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Liga ou desliga um tipo e troca a linha inteira pela resposta do servidor (a fonte da verdade). A LINHA fica travada enquanto grava, e
   * não só a célula: duas gravações em tipos diferentes da mesma linha poderiam responder fora de ordem, e a resposta mais antiga, sem a
   * mudança da outra, sobrescreveria a tela com um estado velho.
   */
  async function toggle(target: PushMuteTarget, kind: PushEventKind) {
    const key = rowKey(target.botId);
    setBusy((current) => new Set(current).add(key));
    try {
      const updated = await setPushMute({ botId: target.botId, kind, muted: !target.muted.includes(kind) }, csrfToken);
      setTargets((current) => current?.map((row) => (row.botId === updated.botId ? updated : row)) ?? null);
    } catch (error) {
      toast.error(apiErrorMessage(error), { duration: Infinity });
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }

  if (loadError) {
    return (
      <p role="alert" className="text-sm text-danger">
        {loadError}
      </p>
    );
  }
  if (targets === null) {
    return (
      <div aria-busy="true" aria-label="Carregando os avisos por bot" className="flex flex-col gap-2">
        {[0, 1].map((row) => (
          <div key={row} className="h-14 animate-pulse rounded-md bg-surface" />
        ))}
      </div>
    );
  }

  return (
    <div role="table" aria-label="Avisos por bot e por tipo" className="border-y border-line">
      <div role="row" className={cn('hidden gap-0 border-b border-line py-2 text-xs text-subtle md:grid', DESKTOP_COLUMNS)}>
        <span role="columnheader">Bot</span>
        {PUSH_EVENT_KINDS.map((kind) => (
          <span key={kind} role="columnheader" className="px-1 text-center">
            {KIND_LABELS[kind]}
          </span>
        ))}
      </div>
      <div role="rowgroup" className="divide-y divide-line">
        {targets.map((target) => (
          <div key={target.botId ?? 'chat-geral'} role="row" className={cn('grid grid-cols-2 gap-2 py-3 md:items-center md:gap-0 md:py-1', DESKTOP_COLUMNS)}>
            <span role="rowheader" className="col-span-2 truncate text-sm font-medium text-fg md:col-span-1" title={target.name}>
              {target.name}
            </span>
            {PUSH_EVENT_KINDS.map((kind) => {
              const receiving = !target.muted.includes(kind);
              const saving = busy.has(rowKey(target.botId));
              return (
                <div key={kind} role="cell" className="flex">
                  {/* `aria-disabled` em vez de `disabled` durante a gravação: o botão desabilitado perderia o foco do teclado no meio de uma sequência de toggles. */}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={receiving}
                    aria-disabled={saving || undefined}
                    onClick={() => {
                      if (!saving) void toggle(target, kind);
                    }}
                    className="flex h-11 w-full items-center justify-between gap-2 rounded-md border border-line px-3 text-sm text-fg transition-colors hover:bg-surface-hover aria-disabled:opacity-60 md:justify-center md:border-0 md:px-0"
                  >
                    {/* O rótulo fica visível só no mobile (na tabela, quem diz o tipo é o cabeçalho), mas o nome acessível é sempre "<tipo> de <bot>". */}
                    <span className="text-left leading-tight md:sr-only">{KIND_LABELS[kind]}</span>
                    <span className="sr-only">{` de ${target.name}`}</span>
                    <SwitchTrack on={receiving} />
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

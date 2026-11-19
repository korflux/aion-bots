'use client';

// Configurações → Conexões → Pesquisa na web (phase 1, F8; phase 5, T4): o interruptor global da pesquisa (ligado por padrão) e a chave OPCIONAL da Parallel, em
// dois cartões. É um bloco da área Conexões: a moldura e o título ficam na página. Sem chave a pesquisa usa o nível anônimo da Parallel; com chave, o limite é o da conta do dono.
//
// Interruptor: salva NA HORA (sem botão) e vale a partir da próxima execução dos bots e do Chat geral. A tela troca o valor antes da resposta e o
// devolve se o servidor falhar (toast de erro); enquanto grava, o interruptor ignora cliques e fica com `aria-busy`.
//
// Chave: `SecretKeyField` (a mesma de Provedores e Conectores) salva, substitui e desconecta pelas rotas de credenciais (tipo `web_search`), com o
// limite de 10 validações por minuto compartilhado com as outras chaves. A chave digitada nunca é guardada fora do estado desse campo, e a API só
// devolve a versão mascarada. O estado da chave (anônimo ou conectada) vem junto do interruptor, na mesma leitura (`fetchWebSearchSettings`).
import type { CredentialStatus } from '@aion/shared';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { SwitchTrack } from '@/components/ui/switch-track';
import { apiErrorMessage } from '@/lib/api-client';
import { useSession } from '@/lib/session-context';
import { SecretKeyField, type SecretKeyMessages } from './secret-key-field';
import { fetchWebSearchSettings, saveWebSearchEnabled } from './settings-api';
import { StatusBadge } from './status-badge';

/** Estados da seção: esqueleto, falha de carga (com "Tentar novamente") e pronta (interruptor e estado da chave). */
type Load = { status: 'loading' } | { status: 'error' } | { status: 'ready'; enabled: boolean; key: CredentialStatus };

/** Textos de gênero feminino ("a Parallel") que o padrão do campo de chave não acerta. */
const KEY_MESSAGES: SecretKeyMessages = {
  saved: 'Chave da Parallel salva',
  disconnected: 'Chave da Parallel desconectada',
  disconnectTitle: 'Desconectar a chave da Parallel?',
};

export function WebSearchSettings() {
  const { csrfToken } = useSession();
  const baseId = useId();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  // Incrementar força uma nova carga (botão "Tentar novamente").
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchWebSearchSettings().then(
      (settings) => {
        if (!cancelled) setLoad({ status: 'ready', enabled: settings.enabled, key: settings.key });
      },
      () => {
        if (!cancelled) setLoad({ status: 'error' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  /** Troca só o interruptor no estado pronto; a chave e o resto ficam como estão (uma resposta atrasada nunca sobrescreve a outra metade da tela). */
  const patch = (changes: { enabled?: boolean; key?: CredentialStatus }) =>
    setLoad((current) => (current.status === 'ready' ? { ...current, ...changes } : current));

  /** Liga ou desliga: valor novo na tela de imediato, gravação no servidor e, se falhar, o valor anterior de volta com um toast de erro. */
  async function toggle() {
    if (load.status !== 'ready' || saving) return;
    const next = !load.enabled;
    setSaving(true);
    patch({ enabled: next });
    try {
      const saved = await saveWebSearchEnabled(next, csrfToken);
      patch({ enabled: saved.enabled });
      toast(saved.enabled ? 'Pesquisa na web ligada' : 'Pesquisa na web desligada');
    } catch (error) {
      patch({ enabled: !next });
      toast.error(apiErrorMessage(error), { duration: Infinity });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {load.status === 'error' ? (
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-sm text-danger">
            Não foi possível carregar a pesquisa na web.
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
        <div aria-busy="true" aria-label="Carregando pesquisa na web" className="flex flex-col gap-4">
          <div className="h-28 animate-pulse rounded-md border border-line bg-surface" />
          <div className="h-44 animate-pulse rounded-md border border-line bg-surface" />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <section aria-labelledby={`${baseId}-pesquisa`} className="rounded-md border border-line bg-surface grad-sheen p-4 md:p-5">
            <div className="flex min-h-11 items-center justify-between gap-4">
              <h2 id={`${baseId}-pesquisa`} className="text-sm font-medium text-fg">
                Pesquisa na web
              </h2>
              {/* `aria-disabled` em vez de `disabled` durante a gravação: o botão desabilitado perderia o foco do teclado no meio de um uso por Espaço. */}
              <button
                type="button"
                role="switch"
                aria-checked={load.enabled}
                aria-label="Pesquisa na web"
                aria-busy={saving || undefined}
                aria-disabled={saving || undefined}
                onClick={() => void toggle()}
                className="-mr-1 flex h-11 min-w-11 shrink-0 items-center justify-center rounded-md aria-disabled:opacity-60"
              >
                <SwitchTrack on={load.enabled} />
              </button>
            </div>
            <p className="text-xs text-muted">Os bots e o Chat geral podem pesquisar e ler páginas da internet.</p>
            <p className="mt-1 text-xs text-muted">As consultas e as URLs são enviadas à Parallel. Memória, regras e conversas não saem do Aion.</p>
            {load.enabled ? null : <p className="mt-3 text-xs text-muted">Desligada: os bots não pesquisam na web.</p>}
          </section>

          <section aria-labelledby={`${baseId}-chave`} className="rounded-md border border-line bg-surface grad-sheen p-4 md:p-5">
            <div className="flex min-h-7 flex-wrap items-center justify-between gap-2">
              <h2 id={`${baseId}-chave`} className="text-sm font-medium text-fg">
                Chave da Parallel (opcional)
              </h2>
              {load.key.configured ? <StatusBadge tone="success">Conectada</StatusBadge> : <StatusBadge tone="neutral">Uso anônimo</StatusBadge>}
            </div>
            <p className="mb-4 mt-1 text-xs text-muted">Sem chave, a pesquisa usa o limite do nível anônimo da Parallel.</p>
            <SecretKeyField
              kind="web_search"
              serviceName="Parallel"
              status={load.key}
              onStatusChange={(key) => patch({ key })}
              disconnectEffect="A pesquisa continua funcionando no uso anônimo, com o limite do provedor."
              messages={KEY_MESSAGES}
              showBadge={false}
            />
          </section>
        </div>
      )}
    </>
  );
}

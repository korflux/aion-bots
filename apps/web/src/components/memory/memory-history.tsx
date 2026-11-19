'use client';

// Drawer "Histórico de versões" da memória (F11 passo 4; design: Memória → Drawer). Entra pela direita com 420 px e ocupa a tela
// inteira no celular, com o botão voltar. Dois momentos no mesmo painel: a LISTA das versões (data, autor e "+3 −1 linhas") e, ao
// escolher uma, o DETALHE com o diff rico (fundo por estado e prefixos) e o botão "Restaurar esta versão".
//
// Restaurar cria uma versão nova (nunca reescreve a antiga) e usa a versão atual da tela como "versão esperada": se a memória mudou
// enquanto o drawer estava aberto, o conflito é entregue à tela (`onConflict`), que mostra o mesmo modal do salvamento. Com texto
// não salvo no editor, restaurar fica desabilitado (a restauração trocaria o texto digitado).
import { MEMORY_MAX_CHARS, type MemoryAuthor, type MemoryVersionDetail, type MemoryVersionSummary, type MemoryView } from '@aion/shared';
import { ArrowLeft, LoaderCircle, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerContent } from '@/components/ui/drawer';
import { ApiError, apiErrorMessage } from '@/lib/api-client';
import { formatRelativeTime } from '@/lib/format';
import { useSession } from '@/lib/session-context';
import { fetchMemoryVersion, fetchMemoryVersions, restoreMemoryVersion, type MemoryScope } from './memory-api';
import { MemoryDiff } from './memory-diff';

export interface MemoryHistoryProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: MemoryScope;
  /** Versão que a tela mostra agora (a "versão esperada" da restauração). */
  currentVersion: number;
  /** Há texto digitado e não salvo no editor. */
  dirty: boolean;
  /** Como mostrar o autor de cada versão ("Você" ou o nome do bot). */
  authorLabel: (author: MemoryAuthor) => string;
  onRestored: (view: MemoryView) => void;
  onConflict: () => void;
}

type ListState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; versions: MemoryVersionSummary[] };
type DetailState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; detail: MemoryVersionDetail };

const formatDateTime = (iso: string): string => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

/** "+3 −1 linhas" do resumo de uma versão. */
const changeSummary = ({ added, removed }: Pick<MemoryVersionSummary, 'added' | 'removed'>): string => `+${added} −${removed} ${added + removed === 1 ? 'linha' : 'linhas'}`;

function Skeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Carregando versões" className="flex flex-col gap-2">
      {[0, 1, 2].map((row) => (
        <div key={row} className="h-14 animate-pulse rounded-md bg-surface" />
      ))}
    </div>
  );
}

export function MemoryHistory({ open, onOpenChange, scope, currentVersion, dirty, authorLabel, onRestored, onConflict }: MemoryHistoryProps) {
  const { csrfToken } = useSession();
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<DetailState>({ status: 'loading' });
  const [restoring, setRestoring] = useState(false);
  /** Incrementar refaz a busca (tentar de novo, ou a memória mudou). */
  const [attempt, setAttempt] = useState(0);

  // A lista é buscada a cada abertura: a memória pode ter mudado (o bot também grava versões).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchMemoryVersions(scope).then(
      (result) => {
        if (!cancelled) setList({ status: 'ready', versions: result.versions });
      },
      (error: unknown) => {
        if (!cancelled) setList({ status: 'error', message: apiErrorMessage(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, scope, attempt, currentVersion]);

  useEffect(() => {
    if (!open || selected === null) return;
    let cancelled = false;
    fetchMemoryVersion(scope, selected).then(
      (result) => {
        if (!cancelled) setDetail({ status: 'ready', detail: result });
      },
      (error: unknown) => {
        if (!cancelled) setDetail({ status: 'error', message: apiErrorMessage(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, scope, selected, attempt]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setSelected(null);
        setList({ status: 'loading' });
      }
      onOpenChange(next);
    },
    [onOpenChange],
  );

  function select(version: number) {
    setDetail({ status: 'loading' });
    setSelected(version);
  }

  async function restore(version: number) {
    if (restoring) return;
    setRestoring(true);
    try {
      const view = await restoreMemoryVersion(scope, version, currentVersion, csrfToken);
      toast('Versão restaurada');
      onRestored(view);
      handleOpenChange(false);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'MEMORY_CONFLICT') {
        handleOpenChange(false);
        onConflict();
      } else {
        toast.error(apiErrorMessage(error), { duration: Infinity });
      }
    } finally {
      setRestoring(false);
    }
  }

  const shown = detail.status === 'ready' && detail.detail.version === selected ? detail.detail : null;

  return (
    <Drawer open={open} onOpenChange={handleOpenChange}>
      <DrawerContent title="Histórico de versões" className="w-full max-w-full border-l border-line md:w-[420px]">
        <div className="flex min-h-0 w-full flex-col">
          <header className="flex h-[52px] shrink-0 items-center gap-2 px-4">
            {selected !== null ? (
              <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
                <ArrowLeft className="size-4" strokeWidth={1.5} aria-hidden />
                Versões
              </Button>
            ) : (
              <h2 className="text-[16px]/6 font-semibold text-fg">Histórico de versões</h2>
            )}
            <Button variant="ghost" size="icon" className="ml-auto" aria-label="Fechar histórico" onClick={() => handleOpenChange(false)}>
              <X className="size-4" strokeWidth={1.5} aria-hidden />
            </Button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
            {selected === null ? (
              list.status === 'loading' ? (
                <Skeleton />
              ) : list.status === 'error' ? (
                <div className="flex flex-col items-start gap-3">
                  <p role="alert" className="text-sm text-danger">
                    {list.message}
                  </p>
                  <Button onClick={() => setAttempt((value) => value + 1)}>Tentar novamente</Button>
                </div>
              ) : list.versions.length === 0 ? (
                <p className="text-sm text-muted">Nenhuma versão ainda. Cada salvamento cria uma.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {list.versions.map((item) => (
                    <li key={item.version}>
                      <button
                        type="button"
                        onClick={() => select(item.version)}
                        className="flex min-h-14 w-full flex-col gap-0.5 rounded-md border border-line bg-surface px-3 py-2 text-left hover:bg-surface-hover"
                      >
                        <span className="flex items-center justify-between gap-2 text-sm text-fg">
                          <span className="font-medium">
                            Versão {item.version}
                            {item.version === currentVersion ? <span className="ml-2 text-xs font-normal text-subtle">atual</span> : null}
                          </span>
                          <span className="font-mono text-xs text-muted">{changeSummary(item)}</span>
                        </span>
                        <span className="text-xs text-subtle">
                          {authorLabel(item.author)} · {formatRelativeTime(item.createdAt)}
                          {item.restoredFrom !== null ? ` · restaurada da versão ${item.restoredFrom}` : ''}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : detail.status === 'error' ? (
              <div className="flex flex-col items-start gap-3">
                <p role="alert" className="text-sm text-danger">
                  {detail.message}
                </p>
                <Button onClick={() => setAttempt((value) => value + 1)}>Tentar novamente</Button>
              </div>
            ) : shown === null ? (
              <Skeleton />
            ) : (
              <div className="flex flex-col gap-4">
                <div>
                  <h3 className="text-sm font-medium text-fg">Versão {shown.version}</h3>
                  <p className="text-xs text-subtle">
                    {authorLabel(shown.author)} · {formatDateTime(shown.createdAt)} · {changeSummary(shown)}
                    {shown.restoredFrom !== null ? ` · restaurada da versão ${shown.restoredFrom}` : ''}
                  </p>
                </div>
                {shown.diff.length === 0 ? (
                  <p className="text-sm text-muted">Memória vazia nesta versão.</p>
                ) : (
                  <div className="rounded-md border border-line bg-surface grad-sheen p-3">
                    <MemoryDiff lines={shown.diff} label={`Mudanças da versão ${shown.version}`} />
                  </div>
                )}
                {shown.version === currentVersion ? (
                  <p className="text-sm text-muted">Esta é a versão atual.</p>
                ) : (
                  <>
                    <Button variant="primary" disabled={dirty || restoring} onClick={() => void restore(shown.version)} className="self-start">
                      {restoring ? <LoaderCircle data-icon="LoaderCircle" className="size-4 animate-spin" strokeWidth={1.5} aria-hidden /> : null}
                      Restaurar esta versão
                    </Button>
                    {dirty ? <p className="text-xs text-subtle">Salve ou descarte o texto digitado no editor para restaurar uma versão.</p> : null}
                    <p className="text-xs text-subtle">Restaurar cria uma versão nova e mantém o histórico. Limite de {MEMORY_MAX_CHARS.toLocaleString('pt-BR')} caracteres.</p>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

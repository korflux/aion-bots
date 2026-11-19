'use client';

// Drawer "Histórico de versões" do doc (phase 14, passo 5; DOC-02, A15), irmão do histórico da memória: entra pela direita com 420 px e ocupa a tela inteira no celular. Dois
// momentos no mesmo painel: a LISTA das versões (número, autor, data e tamanho) e, ao escolher uma, o DETALHE com o texto daquela versão formatado e "Restaurar esta versão".
//
// Restaurar cria uma versão NOVA com o texto da escolhida (as posteriores continuam no histórico) e usa a versão atual da tela como "versão esperada": se o doc mudou enquanto
// o drawer estava aberto (o bot também grava), o servidor responde `DOC_CONFLICT` e o conflito vai à tela (`onConflict`), que o mostra no aviso comum e não grava nada. O
// texto de uma versão antiga vem de um bot que lê conteúdo externo, então o detalhe passa pela mesma leitura segura do doc (`Markdown`: sem HTML cru, sem imagem, link com noopener).
//
// O botão "Histórico" só existe na leitura do doc (`doc-view.tsx`): com uma edição em andamento não há o que restaurar por cima, então este drawer nunca disputa o texto digitado.
import type { DocVersionDetail, DocVersionSummary, DocWriteResult } from '@aion/shared';
import { ArrowLeft, LoaderCircle, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Markdown } from '@/components/conversation/markdown';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerContent } from '@/components/ui/drawer';
import { ApiError, apiErrorMessage } from '@/lib/api-client';
import { formatRelativeTime } from '@/lib/format';
import { useSession } from '@/lib/session-context';
import { fetchDocVersion, fetchDocVersions, restoreDocVersion } from './api';
import { IntentLedger, authorLabel, sizeLabel } from './doc-state';

export interface DocHistoryProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  docId: string;
  /** A versão que a tela mostra agora: a "versão esperada" da restauração. */
  currentVersion: number;
  /** A restauração deu certo (o doc mudou, ou já tinha aquele texto): a tela recarrega o doc. */
  onRestored: (result: DocWriteResult) => void;
  /** O doc mudou depois que a tela o leu: quem usa mostra o aviso de conflito. */
  onConflict: () => void;
}

type ListState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; versions: DocVersionSummary[] };
type DetailState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; detail: DocVersionDetail };

const formatDateTime = (iso: string): string => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

function Skeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Carregando versões" className="flex flex-col gap-2">
      {[0, 1, 2].map((row) => (
        <div key={row} className="h-14 animate-pulse rounded-md bg-surface" />
      ))}
    </div>
  );
}

function RetryMessage({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <p role="alert" className="text-sm text-danger">
        {message}
      </p>
      <Button onClick={onRetry}>Tentar novamente</Button>
    </div>
  );
}

export function DocHistory({ open, onOpenChange, docId, currentVersion, onRestored, onConflict }: DocHistoryProps) {
  const { csrfToken } = useSession();
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<DetailState>({ status: 'loading' });
  const [restoring, setRestoring] = useState(false);
  /** Incrementar refaz a busca (tentar de novo). */
  const [attempt, setAttempt] = useState(0);
  const [ledger] = useState(() => new IntentLedger());

  // A lista é buscada a cada abertura (e quando a versão atual muda): o bot também grava versões.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchDocVersions(docId).then(
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
  }, [open, docId, attempt, currentVersion]);

  useEffect(() => {
    if (!open || selected === null) return;
    let cancelled = false;
    fetchDocVersion(docId, selected).then(
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
  }, [open, docId, selected, attempt]);

  function handleOpenChange(next: boolean) {
    if (!next) {
      setSelected(null);
      setList({ status: 'loading' });
    }
    onOpenChange(next);
  }

  function select(version: number) {
    setDetail({ status: 'loading' });
    setSelected(version);
  }

  /** Restaura a versão escolhida sobre a versão atual da tela. A repetição depois de uma falha de rede reaproveita a `operationId`. */
  async function restore(version: number) {
    if (restoring) return;
    setRestoring(true);
    try {
      const result = await restoreDocVersion(docId, ledger.stamp({ version, expectedVersion: currentVersion }), csrfToken);
      ledger.clear();
      toast(result.changed ? 'Versão restaurada' : 'O doc já tinha o texto dessa versão');
      onRestored(result);
      handleOpenChange(false);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'DOC_CONFLICT') {
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
                <RetryMessage message={list.message} onRetry={() => setAttempt((value) => value + 1)} />
              ) : list.versions.length === 0 ? (
                <p className="text-sm text-muted">Nenhuma versão ainda. Cada alteração do texto cria uma.</p>
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
                          <span className="font-mono text-xs text-muted">{sizeLabel(item.size)}</span>
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
              <RetryMessage message={detail.message} onRetry={() => setAttempt((value) => value + 1)} />
            ) : shown === null ? (
              <Skeleton />
            ) : (
              <div className="flex flex-col gap-4">
                <div>
                  <h3 className="text-sm font-medium text-fg">Versão {shown.version}</h3>
                  <p className="text-xs text-subtle">
                    {authorLabel(shown.author)} · {formatDateTime(shown.createdAt)} · {sizeLabel(shown.size)}
                    {shown.restoredFrom !== null ? ` · restaurada da versão ${shown.restoredFrom}` : ''}
                  </p>
                </div>
                <div className="rounded-md border border-line bg-surface grad-sheen p-3">
                  {shown.content === '' ? <p className="text-sm text-muted">Doc vazio nesta versão.</p> : <Markdown>{shown.content}</Markdown>}
                </div>
                {shown.version === currentVersion ? (
                  <p className="text-sm text-muted">Esta é a versão atual.</p>
                ) : (
                  <>
                    <Button variant="primary" disabled={restoring} onClick={() => void restore(shown.version)} className="self-start">
                      {restoring ? <LoaderCircle data-icon="LoaderCircle" className="size-4 animate-spin" strokeWidth={1.5} aria-hidden /> : null}
                      Restaurar esta versão
                    </Button>
                    <p className="text-xs text-subtle">Restaurar cria uma versão nova com este texto e mantém o histórico.</p>
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

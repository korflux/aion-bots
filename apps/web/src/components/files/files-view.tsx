'use client';
// Gestão dos arquivos do dono: filtros invalidam respostas antigas; exclusões usam resultados autoritativos por lote.
import type { AttachmentPage, AttachmentListQuery, Bot } from '@aion/shared';
import Link from 'next/link';
import { ArrowLeft, Paperclip } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { SegmentedControl } from '@/components/approvals/segmented-control';
import { BotAvatar } from '@/components/bots/bot-avatar';
import { readableNameColor } from '@/components/bots/bot-display';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useBots } from '@/components/bots/bots-store';
import { attachmentSize } from '@/components/conversation/attachment-list';
import { EmptyState, PageHeader } from '@/components/page';
import { ConfirmDialog } from '@/components/settings/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { apiErrorMessage, ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session-context';
import { useNow } from '@/lib/use-now';
import { deleteFile, deleteFiles, fetchFiles } from './files-api';
import { FileRow } from './file-row';
import { QuotaBar } from './quota-bar';
import { appendFiles, eligibleSelection, quotaState, type FileItem } from './files-state';
type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; page: AttachmentPage };
/** Gestão compartilhada: o contexto do bot fixa a origem em toda consulta, independente dos filtros locais. */
export function FilesView({ bot }: { bot?: Bot } = {}) {
  const { csrfToken } = useSession(); const { bots } = useBots(); const now = useNow(30_000);
  const [origin, setOrigin] = useState('all'); const [kind, setKind] = useState<'all' | 'image' | 'document'>('all');
  const [load, setLoad] = useState<Load>({ status: 'loading' }); const [selected, setSelected] = useState<Set<string>>(new Set());
  const [more, setMore] = useState(false); const [pending, setPending] = useState(false); const [target, setTarget] = useState<FileItem[] | null>(null);
  const generation = useRef(0); const mounted = useRef(false); const returnFocus = useRef<HTMLElement | null>(null); const selectAll = useRef<HTMLInputElement>(null); const originSelect = useRef<HTMLSelectElement>(null);
  const scopeOrigin = bot?.id ?? origin;
  const filters = useRef<HTMLDivElement>(null);
  const query = useMemo<AttachmentListQuery>(() => ({ ...(scopeOrigin === 'chat' ? { origin: 'chat' } : scopeOrigin !== 'all' ? { origin: 'bot', botId: scopeOrigin } : {}), ...(kind !== 'all' ? { kind } : {}) }), [scopeOrigin, kind]);
  /** A releitura substitui a lista carregada inteira para nunca ressuscitar referências excluídas em outra aba. */
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setMore(false);
    try { const page = await fetchFiles(query);
      if (!mounted.current || request !== generation.current) return;
      setLoad({ status: 'ready', page }); setSelected((current) => eligibleSelection(page.items, current));
    } catch (error) { if (mounted.current && request === generation.current) setLoad((current) => current.status === 'ready' ? current : { status: 'error', message: apiErrorMessage(error) }); }
  }, [query]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setLoad({ status: 'loading' }); setSelected(new Set()); setMore(false); void refresh(); }, [refresh]);
  useEffect(() => { /** Revalida o estado em uso quando o dono volta à aba. */ const focus = () => { if (!pending) void refresh(); }; window.addEventListener('focus', focus); return () => window.removeEventListener('focus', focus); }, [refresh, pending]);
  /** Cursor mantém filtros e ignora respostas de uma geração anterior. */
  async function loadMore() { if (load.status !== 'ready' || !load.page.nextCursor || more) return; const request = generation.current; setMore(true);
    try { const page = await fetchFiles({ ...query, cursor: load.page.nextCursor }); if (mounted.current && request === generation.current) setLoad((current) => current.status === 'ready' ? { status: 'ready', page: appendFiles(current.page, page) } : current); }
    catch (error) { if (mounted.current && request === generation.current) toast.error(apiErrorMessage(error), { duration: Infinity }); }
    finally { if (mounted.current && request === generation.current) setMore(false); }
  }
  /** Aplica apenas ids confirmados pelo servidor, preservando progresso parcial se um lote posterior falhar. */
  function applyRemoved(ids: string[], inUse: string[], freedBytes: number) { const removed = new Set(ids); const busy = new Set(inUse);
    setLoad((current) => current.status !== 'ready' ? current : { status: 'ready', page: { ...current.page, count: Math.max(0, current.page.count - ids.length), usedBytes: Math.max(0, current.page.usedBytes - freedBytes), items: current.page.items.filter((item) => !removed.has(item.id)).map((item) => busy.has(item.id) ? { ...item, inUse: true } : item) } });
    setSelected((current) => new Set([...current].filter((id) => !removed.has(id) && !busy.has(id))));
  }
  /** Lotes de até cem respeitam o contrato; uma falha conserva a lista e os resultados já recebidos. */
  async function confirmDelete() { if (!target || pending) return; generation.current++; setPending(true); const files = target; let deleted = 0; let freed = 0; let busy = 0;
    try { if (files.length === 1) { const file = files[0]!; await deleteFile(file.id, csrfToken); if (!mounted.current) return; applyRemoved([file.id], [], file.storedBytes); toast.success('Arquivo excluído.', { duration: 4000 }); }
      else { for (let start = 0; start < files.length; start += 100) { const result = await deleteFiles(files.slice(start, start + 100).map((file) => file.id), csrfToken); if (!mounted.current) return; applyRemoved([...result.deleted, ...result.alreadyRemoved], result.inUse, result.freedBytes); deleted += result.deleted.length; freed += result.freedBytes; busy += result.inUse.length; }
        toast.success(`${deleted} arquivos excluídos, ${attachmentSize(freed, true)} liberados.${busy ? ` ${busy} arquivos em uso foram mantidos.` : ''}`, { duration: 4000 }); }
    } catch (error) { if (mounted.current) { if (error instanceof ApiError && error.code === 'ATTACHMENT_IN_USE') applyRemoved([], files.map((file) => file.id), 0); toast.error(apiErrorMessage(error), { duration: Infinity }); } }
    finally { if (mounted.current) { setPending(false); setMore(false); setTarget(null); void refresh(); } }
  }
  /** Guarda o gatilho para devolver foco, inclusive se a exclusão retirar a linha. */
  function askDelete(files: FileItem[], opener: HTMLElement | null = document.activeElement as HTMLElement) { returnFocus.current = opener; setTarget(files); }
  const page = load.status === 'ready' ? load.page : null; const selectedFiles = page?.items.filter((item) => selected.has(item.id)) ?? []; const selectedBytes = selectedFiles.reduce((sum, file) => sum + file.originalBytes, 0);
  const eligible = page?.items.filter((item) => !item.inUse) ?? []; const quota = page ? quotaState(page.usedBytes, page.maxBytes) : null;
  return <div className="mx-auto w-full max-w-[760px] px-4 pb-10 md:px-6">{bot ? <header className="flex min-h-[52px] items-center gap-3 py-2">
      <Tooltip><TooltipTrigger asChild><Button asChild variant="ghost" size="icon"><Link href={`/bots/${bot.id}`} aria-label="Voltar à conversa"><ArrowLeft className="size-4" strokeWidth={1.5} aria-hidden /></Link></Button></TooltipTrigger><TooltipContent side="bottom">Voltar à conversa</TooltipContent></Tooltip>
      <BotAvatar owner={bot} size={32} still state={bot.archivedAt ? 'sleep' : 'idle'} />
      <div className="min-w-0 flex-1"><h1 className="truncate text-[18px]/[26px] font-semibold" style={{ color: readableNameColor(bot.color) }} title={`Arquivos de ${bot.name}`}>Arquivos de {bot.name}</h1>{bot.archivedAt ? <p className="text-xs text-muted">Bot arquivado</p> : null}</div>
    </header> : <PageHeader title="Arquivos" padded={false} />}
    {page && quota ? <section aria-label="Armazenamento de arquivos" className="mb-4 rounded-md border border-line bg-surface grad-sheen p-4"><div className="flex flex-wrap justify-between gap-1"><span className="text-sm font-medium">{attachmentSize(page.usedBytes, true)} de {attachmentSize(page.maxBytes, true)} usados</span><span className="text-xs text-muted">{page.count} arquivos{bot ? ' no Aion' : ''}</span></div><QuotaBar quota={quota} className="my-2" /><p className="text-xs text-muted">{bot ? 'Armazenamento global do Aion, compartilhado entre todos os bots e o Chat geral. ' : ''}{quota.text}. Imagens, planilhas e texto de documentos. O arquivo original de PDF e DOCX não é guardado.</p></section> : null}
    <div ref={filters} className="mb-4 flex flex-col gap-2 md:flex-row">{bot ? null : <Select ref={originSelect} aria-label="Origem" value={origin} disabled={pending} onChange={(event) => setOrigin(event.target.value)}><option value="all">Todas as origens</option><option value="chat">Chat geral</option>{bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}{bot.archivedAt ? ' (arquivado)' : ''}</option>)}</Select>}<SegmentedControl label="Tipo" value={kind} onChange={setKind} disabled={pending} options={[{ value: 'all', label: 'Todos' }, { value: 'image', label: 'Imagens' }, { value: 'document', label: 'Documentos' }]} /></div>
    {load.status === 'loading' ? <div role="status" aria-busy="true" aria-label="Carregando arquivos" className="flex flex-col gap-2">{[0, 1, 2].map((row) => <div key={row} className="h-14 animate-pulse rounded-md bg-surface" />)}</div> : load.status === 'error' ? <EmptyState icon={Paperclip} action={<Button variant="secondary" onClick={() => { setLoad({ status: 'loading' }); void refresh(); }}>Tentar novamente</Button>}><span role="alert">{load.message}</span></EmptyState> : page?.items.length === 0 ? <EmptyState icon={Paperclip} action={(!bot && origin !== 'all') || kind !== 'all' ? <Button variant="ghost" onClick={() => { if (!bot) setOrigin('all'); setKind('all'); }}>Limpar filtros</Button> : undefined}>{(!bot && origin !== 'all') || kind !== 'all' ? 'Nenhum arquivo com esses filtros.' : 'Nenhum arquivo anexado ainda.'}</EmptyState> : page ? <>
      {selectedFiles.length ? <div role="status" className="mb-3 flex flex-wrap items-center gap-2 rounded-md bg-surface-hover p-3"><span className="flex-1 text-sm">{selectedFiles.length} selecionados · {attachmentSize(selectedBytes)}</span><div className="flex w-full gap-2 md:w-auto"><Button variant="ghost" size="sm" disabled={pending} onClick={() => setSelected(new Set())}>Limpar seleção</Button><Button variant="danger" size="sm" disabled={pending} onClick={() => askDelete(selectedFiles)}>Excluir selecionados</Button></div></div> : null}
      <label className="mb-2 flex min-h-11 items-center gap-2 text-xs text-muted"><input ref={selectAll} type="checkbox" className="size-4 accent-action" aria-label="Selecionar todos os arquivos carregados" checked={eligible.length > 0 && eligible.every((file) => selected.has(file.id))} disabled={pending || eligible.length === 0} onChange={(event) => setSelected(event.target.checked ? new Set(eligible.map((file) => file.id)) : new Set())} />Selecionar todos os arquivos carregados</label>
      <ul aria-label="Arquivos anexados" aria-busy={pending} className="overflow-hidden rounded-md border border-line">{page.items.map((file) => <FileRow key={file.id} file={file} pending={pending} now={now} selected={selected.has(file.id)} onSelect={() => setSelected((current) => { const next = new Set(current); if (next.has(file.id)) next.delete(file.id); else next.add(file.id); return next; })} onDelete={(opener) => askDelete([file], opener)} />)}</ul>
      {page.nextCursor ? <div className="mt-4 flex justify-center"><Button variant="secondary" disabled={more || pending} onClick={() => void loadMore()}>Carregar mais</Button></div> : null}
    </> : null}
    <ConfirmDialog open={target !== null} onOpenChange={(open) => { if (!open) setTarget(null); }} title={target?.length === 1 ? 'Excluir este arquivo?' : `Excluir ${target?.length ?? 0} arquivos?`} description={target?.length === 1 ? `"${target[0]!.name}" será apagado do Aion. Nas conversas, a mensagem continua e mostra "Arquivo removido". Não há como desfazer.` : `${target?.length ?? 0} arquivos (${attachmentSize(target?.reduce((sum, file) => sum + file.originalBytes, 0) ?? 0)}) serão apagados do Aion. Nas conversas, as mensagens continuam e mostram "Arquivo removido". Não há como desfazer.`} confirmLabel={target?.length === 1 ? 'Excluir' : `Excluir ${target?.length ?? 0} arquivos`} pending={pending} onConfirm={() => void confirmDelete()} onCloseAutoFocus={(event) => { event.preventDefault(); if (returnFocus.current?.isConnected) returnFocus.current.focus(); else if (selectAll.current && !selectAll.current.disabled) selectAll.current.focus(); else if (originSelect.current) originSelect.current.focus(); else filters.current?.querySelector<HTMLButtonElement>('[role=radio][aria-checked=true]')?.focus(); }} />
  </div>;
}

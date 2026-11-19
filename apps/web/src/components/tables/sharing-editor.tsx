'use client';

// Compartilhamento só altera a associação escolhida pelo dono. Relações exibem destinos, sem conceder acesso a eles.
import type { BotList, DataTable } from '@aion/shared';
import Link from 'next/link';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { toast } from 'sonner';
import { BotAvatar } from '@/components/bots/bot-avatar';
import { Button } from '@/components/ui/button';
import { ApiError, apiErrorMessage, apiFetch } from '@/lib/api-client';
import { useSession } from '@/lib/session-context';
import { loadTableCatalog } from './api';
import { ConfigurationPanel } from './configuration-panel';

/** Seleção local permanece depois de conflito. Recarregar revisão é explícito e conserva a seleção, sem repetir a gravação. */
export function SharingEditor({ table, onClose, onSaved }: { table: DataTable; onClose: () => void; onSaved: (table: DataTable) => void }) {
  const { csrfToken } = useSession(); const [selected, setSelected] = useState(table.botIds); const [revision, setRevision] = useState(table.version);
  const [bots, setBots] = useState<BotList['bots']>([]); const [catalog, setCatalog] = useState<DataTable[]>([]);
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [conflict, setConflict] = useState(false); const [saving, setSaving] = useState(false); const [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const attempt = useRef<{ signature: string; id: string } | null>(null); const busy = useRef(false);
  useEffect(() => { let cancelled = false;
    async function load() { setLoading(true); setLoaded(false); try { const [list, tables] = await Promise.all([apiFetch<BotList>('/api/bots'), loadTableCatalog()]); if (!cancelled) { setBots(list.bots); setCatalog(tables); setLoaded(true); setError(''); } } catch (cause) { if (!cancelled) setError(apiErrorMessage(cause)); } finally { if (!cancelled) setLoading(false); } }
    void load(); return () => { cancelled = true; };
  }, [retry]);
  /** Mesmo conjunto/revisão reutiliza o recibo; rede perdida nunca adiciona associações duplicadas. */
  async function save() { if (busy.current) return; busy.current = true; setSaving(true); setError('');
    const body = { botIds: selected, expectedVersion: revision }; const signature = JSON.stringify(body); if (attempt.current?.signature !== signature) attempt.current = { signature, id: crypto.randomUUID() };
    try { const updated = await apiFetch<DataTable>(`/api/tables/${table.id}/access`, { method: 'PUT', csrfToken, body: { ...body, operationId: attempt.current.id } }); onSaved(updated); toast('Compartilhamento atualizado'); onClose(); }
    catch (cause) { setError(apiErrorMessage(cause)); setConflict(cause instanceof ApiError && cause.code === 'TABLE_CONFLICT'); } finally { busy.current = false; setSaving(false); }
  }
  /** Revê o acesso atual antes de permitir nova tentativa, preservando o rascunho escolhido pelo dono. */
  async function reload() { setSaving(true); setLoaded(false); try { const [latest, list, tables] = await Promise.all([apiFetch<DataTable>(`/api/tables/${table.id}`), apiFetch<BotList>("/api/bots"), loadTableCatalog()]); setBots(list.bots); setCatalog(tables); setLoaded(true); setRevision(latest.version); setConflict(false); setError('Revise sua seleção e salve para aplicar sobre os acessos atuais.'); } catch (cause) { setError(apiErrorMessage(cause)); } finally { setSaving(false); } }
  const missing = loaded ? selected.filter((id) => !bots.some((bot) => bot.id === id)) : [];
  /** Navegação por uma relação não pode contornar a confirmação de descarte do drawer. */
  function followRelation(event: MouseEvent<HTMLAnchorElement>) { if (JSON.stringify(selected) !== JSON.stringify(table.botIds)) { event.preventDefault(); setError('Sua seleção foi preservada. Salve ou feche o compartilhamento antes de abrir uma tabela relacionada.'); } }
  const relations = catalog.flatMap((item) => item.columns.filter((column) => column.type === 'relation' && (item.id === table.id || column.targetTableId === table.id)).map((column) => ({ source: item, column })));
  return <ConfigurationPanel title={`Compartilhar · ${table.name}`} dirty={JSON.stringify(selected) !== JSON.stringify(table.botIds)} busy={saving} onClose={onClose} footer={<Button disabled={loading || saving || conflict || !loaded || missing.length > 0} onClick={() => void save()}>{saving ? 'Salvando…' : 'Salvar compartilhamento'}</Button>}>
    <p className="text-sm">Os bots selecionados podem consultar e editar esta tabela. As regras de aprovação continuam valendo para ações destrutivas.</p><p className="text-sm text-muted">Remover o último bot mantém a tabela em Artefatos, em Sem bot.</p>
    {loading ? <p role="status">Carregando bots…</p> : <ul className="space-y-3">{bots.map((bot) => <li key={bot.id}><label className="flex cursor-pointer items-start gap-3 rounded border border-line p-3"><input type="checkbox" className="mt-1 size-4 shrink-0 accent-faisca" checked={selected.includes(bot.id)} onChange={(event) => setSelected((ids) => event.target.checked ? [...ids, bot.id] : ids.filter((id) => id !== bot.id))} /><BotAvatar owner={bot} size={24} still /><span className="min-w-0 break-words text-sm">{bot.name}{bot.archivedAt ? ' · Arquivado' : ''}</span></label></li>)}</ul>}
    {missing.length > 0 && <section className="space-y-2 text-sm"><p role="alert">Há bots removidos na sua seleção. Remova somente essas seleções para continuar; as demais foram preservadas.</p>{missing.map((id, index) => <Button key={id} variant="secondary" onClick={() => setSelected((ids) => ids.filter((item) => item !== id))}>Remover seleção indisponível {index + 1}</Button>)}</section>}
    {relations.length > 0 && <section className="space-y-2 text-sm"><h3 className="font-semibold">Tabelas relacionadas</h3><p className="text-muted">Os destinos têm compartilhamento próprio. Nenhum acesso será concedido automaticamente.</p><ul className="space-y-2">{relations.map(({ source, column }) => { const target = column.type === 'relation' ? catalog.find((item) => item.id === column.targetTableId) : undefined; return <li key={`${source.id}:${column.id}`} className="break-words"><Link onClick={followRelation} className="underline" href={`/configuracoes/tabelas/${source.id}`}>{source.name}</Link> · {column.name} → {target ? <Link onClick={followRelation} className="underline" href={`/configuracoes/tabelas/${target.id}`}>{target.name}</Link> : 'Destino indisponível'}</li>; })}</ul></section>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}{conflict && <><p className="text-sm">Sua seleção foi preservada. Confira a revisão atual antes de salvar novamente.</p><Button variant="secondary" onClick={() => void reload()}>Recarregar revisão</Button></>}{error && loaded && !conflict && <Button variant="secondary" onClick={() => void reload()}>Recarregar revisão</Button>}{!loading && !loaded && !!error && <Button variant="secondary" onClick={() => setRetry((value) => value + 1)}>Tentar novamente</Button>}
  </ConfigurationPanel>;
}

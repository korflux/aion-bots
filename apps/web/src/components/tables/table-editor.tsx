'use client';

// Editor único das rotas por bot e geral: grade compacta com edição direta na célula (estilo planilha/Notion), primeira coluna fixa,
// vistas como atalhos visíveis, paginação independente de rascunhos e gravações por revisão.
//
// Fluxo de edição de célula:
//   - um clique (ou Enter/F2, ou começar a digitar) abre o editor dentro da própria célula, sem botão de salvar;
//   - escalares salvam ao confirmar (Enter, Tab, ou sair da célula); seleção e Sim/Não salvam na escolha; seleção múltipla salva a cada
//     marcação; relação salva ao aplicar o seletor; Escape descarta;
//   - a gravação usa a revisão do registro (`expectedVersion`) e atualiza a linha no lugar com o registro devolvido (mesma página);
//   - conflito (`TABLE_CONFLICT`) mantém o texto digitado e oferece recarregar.
//
// Variante embutida (phase 14, passo 7; `embedded`): a mesma tela dentro do painel ao lado da conversa (`artifacts/artifact-panel.tsx`), sem lógica duplicada. O painel é dono do controle
// de sair (Voltar ou Fechar painel e "Abrir em tela inteira"), então aqui some o "Voltar" de página e o título vira `h2` (a conversa já tem o `h1`); a célula em edição é avisada ao
// painel (`onDirtyChange`) para ele perguntar antes de fechar; excluir a tabela fecha o painel (`onDeleted`) em vez de navegar. O layout muda de régua: a página usa os breakpoints do
// viewport (`md:`) e o painel usa a largura DELE (container query `panel`, `PANEL_LAYOUT`), porque um painel de 26 a 44 rem numa janela larga é estreito demais para a grade: abaixo de
// 42 rem vale a lista de registros do celular, e o "Abrir em tela inteira" leva à grade inteira.
import type { DataTable, TableCell, TableColumn, TableRecord, TableQueryDefinition, TableView } from '@aion/shared';
import { ArrowLeft, CircleAlert, Columns3, Maximize2, Plus, Share2, SlidersHorizontal, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { EmbeddedArtifact } from '@/components/artifacts/artifact-panel';
import { Button } from '@/components/ui/button';
import { Modal, ModalActions, ModalContent } from '@/components/ui/modal';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ApiError, apiErrorMessage, apiFetch } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/session-context';
import { loadRecord, loadTable, type RecordPage } from './api';
import { CellEditor } from './cell-editor';
import { RecordForm } from './record-form';
import { RelationPicker } from './relation-picker';
import { cellLabel, fieldInput, parseField } from './values';
import { ViewEditor } from './view-editor';
import { StructureEditor } from './structure-editor';
import { FormulaExpression } from './formula-editor';
import { queryDefinition } from './configuration';
import { SharingEditor } from './sharing-editor';
import { DestructiveAction } from './destructive-action';

type CellEdit = { row: number; col: number; value: TableCell; initial: TableCell; operationId: string; error: string; conflict: boolean };
type TableData = { table: DataTable; page: RecordPage };

/** Lista mobile usa o primeiro campo visível e mais dois, distinguindo ausência de falso/zero. */
function MobileRecord({ table, record, zone, onOpen }: { table: DataTable; record: TableRecord; zone: string; onOpen: () => void }) {
  const first = table.columns[0];
  const title = first && record.values[first.id] !== null && record.values[first.id] !== undefined && record.values[first.id] !== '' ? cellLabel(first, record.values[first.id], zone) : `Registro #${record.id}`;
  return <Button variant="ghost" className="h-auto w-full flex-col items-start gap-1 rounded-none border-b border-line px-0 py-3 text-left" onClick={onOpen}>
    <span className="w-full whitespace-pre-wrap break-words font-medium">{title}</span>
    {table.columns.slice(1, 3).map((column) => <span key={column.id} className="w-full whitespace-pre-wrap break-words text-sm"><span className="text-muted">{column.name}: </span>{record.errors?.[column.id] ? 'Erro de cálculo' : cellLabel(column, record.values[column.id], zone)}</span>)}
    <span className="text-xs text-muted">Abrir registro</span>
  </Button>;
}

/** Botão só de ícone com nome acessível e dica, padrão da barra da tabela (mesmo nome do antigo botão com texto). */
function IconAction({ label, onClick, disabled, variant = 'ghost', id, children }: { label: string; onClick: () => void; disabled?: boolean; variant?: 'ghost' | 'primary' | 'danger'; id?: string; children: ReactNode }) {
  return <Tooltip><TooltipTrigger asChild><Button id={id} size="icon" variant={variant} aria-label={label} disabled={disabled} onClick={onClick}>{children}</Button></TooltipTrigger><TooltipContent side="bottom">{label}</TooltipContent></Tooltip>;
}

/**
 * Réguas de layout da tela: a PÁGINA usa os breakpoints do viewport (`md:`); o PAINEL embutido usa a largura do próprio painel (container query nomeada `panel`, posta pelo corpo do
 * painel): a grade (`grid`) só aparece com 42 rem ou mais e, abaixo disso, vale a lista de registros (`list`), a mesma do celular. São literais (e não montadas por prefixo) para o
 * Tailwind enxergar cada classe.
 */
const PAGE_LAYOUT = { pad: 'p-4 md:p-6', toolbar: 'md:flex-nowrap', chips: 'md:order-none md:w-auto md:flex-1', grid: 'md:block', list: 'md:hidden' } as const;
const PANEL_LAYOUT = { pad: 'p-3 @2xl/panel:p-4', toolbar: '@2xl/panel:flex-nowrap', chips: '@2xl/panel:order-none @2xl/panel:w-auto @2xl/panel:flex-1', grid: '@2xl/panel:block', list: '@2xl/panel:hidden' } as const;

/** Tela compartilhada; o pai é explícito para funcionar também em links diretos. `embedded`: dentro do painel da conversa (ver o cabeçalho do arquivo); o `parentHref` só vale na página. */
export function TableEditor({ tableId, parentHref, embedded }: { tableId: string; parentHref: string; embedded?: EmbeddedArtifact }) {
  const { csrfToken } = useSession();
  const router = useRouter();
  const [data, setDataState] = useState<TableData | null>(null);
  // Cópia síncrona para gravações encadeadas (ex.: várias marcações na seleção múltipla) usarem a revisão mais recente, não a do render.
  const dataRef = useRef<TableData | null>(null);
  const setData = (next: TableData) => { dataRef.current = next; setDataState(next); };
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [zone, setZone] = useState('America/Sao_Paulo');
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [refresh, setRefresh] = useState(0);
  // A releitura direta já carrega a primeira página; evita duplicar o efeito de paginação e perder o foco ao remontar a grade.
  const refreshedFirstPage = useRef<string | null>(null);
  const [record, setRecord] = useState<TableRecord | null | undefined>(undefined);
  const [active, setActive] = useState({ row: 0, col: 0 });
  const [edit, setEditState] = useState<CellEdit | null>(null);
  // Fonte síncrona do rascunho: blur, Tab e Enter podem disparar na mesma volta do evento e não podem salvar duas vezes.
  const editRef = useRef<CellEdit | null>(null);
  const setEdit = (next: CellEdit | null) => { editRef.current = next; setEditState(next); };
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const busy = useRef(false);
  /** Clique em outra célula durante a gravação da anterior: abre depois que ela termina, sem perder o gesto do dono. */
  const pendingStart = useRef<{ row: number; col: number } | null>(null);
  /** Foco pedido antes de a grade ser substituída: aplicado depois do commit do React (ver efeito abaixo). */
  const pendingFocus = useRef<{ row: number; col: number } | null>(null);
  /** Escape descarta: o blur que se segue não pode salvar o rascunho. */
  const skipBlur = useRef(false);
  const grid = useRef<HTMLTableElement>(null);
  /** Faixa rolável dos atalhos de vista: a vista ativa é trazida à área visível no celular. */
  const chips = useRef<HTMLDivElement>(null);
  const [formula, setFormula] = useState<TableColumn | null>(null);
  const [columnOpen, setColumnOpen] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);
  const [sharingOpen, setSharingOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [views, setViews] = useState<TableView[]>([]);
  const [view, setView] = useState<TableView | undefined>();
  const [definition, setDefinition] = useState<TableQueryDefinition | undefined>();
  const visibleColumns = data ? (definition?.columns ?? data.table.columns.map((column) => column.id)).flatMap((id) => data.table.columns.filter((column) => column.id === id)) : [];
  const visibleTable = data ? { ...data.table, columns: visibleColumns } : null;
  const [discardAction, setDiscardAction] = useState<(() => void) | null>(null);
  const dirty = edit !== null && JSON.stringify(edit.value) !== JSON.stringify(edit.initial);
  /** Vistas têm revisão própria e são relidas após suas mutações, sem modificar registros. */
  async function loadViews() { const result = await apiFetch<{ views: TableView[] }>(`/api/tables/${tableId}/views`); setViews(result.views); }
  useEffect(() => {
    let cancelled = false;
    async function load() { try { const result = await apiFetch<{ views: TableView[] }>(`/api/tables/${tableId}/views`); if (!cancelled) setViews(result.views); } catch (cause) { if (!cancelled) setError(apiErrorMessage(cause)); } }
    void load(); return () => { cancelled = true; };
  }, [tableId]);
  /** Valida antes de trocar a consulta; erro mantém a configuração anterior e o drawer aberto. */
  async function applyView(next: TableQueryDefinition, selected?: TableView) {
    const nextData = await loadTable(tableId, undefined, next, csrfToken);
    setData(nextData); setZone(nextData.zone); setCursors([undefined]); setDefinition(next); setView(selected); setActive({ row: 0, col: 0 });
  }
  /** Atalho de vista: aplica a definição salva (ou todos os registros) a partir da primeira página. */
  function chooseView(next: TableView | undefined) { guarded(() => { setView(next); setDefinition(next ? queryDefinition(next) : undefined); setCursors([undefined]); }); }
  /** A projeção afeta somente a listagem; o formulário recebe todos os campos atuais do registro. */
  async function openRecord(row: TableRecord) {
    try { setRecord(await loadRecord(tableId, row.id)); }
    catch (cause) { setError(apiErrorMessage(cause)); }
  }
  useEffect(() => {
    const refreshed = refreshedFirstPage.current; refreshedFirstPage.current = null;
    if (cursors.length === 1 && refreshed === JSON.stringify([tableId, definition, csrfToken, refresh])) return;
    let cancelled = false;
    async function load() {
      setLoading(true); setError('');
      try { const next = await loadTable(tableId, cursors.at(-1), definition, csrfToken); if (!cancelled) { setData(next); setZone(next.zone); setActive({ row: 0, col: 0 }); } }
      catch (cause) { if (!cancelled) setError(apiErrorMessage(cause)); }
      finally { if (!cancelled) setLoading(false); }
    }
    void load();
    return () => { cancelled = true; };
  }, [tableId, cursors, refresh, definition, csrfToken]);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);
  // Embutido no painel: avisa a célula em edição (e que ela acabou quando a tela sai), para o painel perguntar antes de fechar ou trocar de artefato.
  const reportDirty = embedded?.onDirtyChange;
  useEffect(() => { reportDirty?.(dirty); }, [reportDirty, dirty]);
  useEffect(() => () => reportDirty?.(false), [reportDirty]);
  // Foco depois do commit que substitui as linhas: requestAnimationFrame logo após setData podia rodar antes da troca dos nós e o foco se
  // perdia (registro `.erros-encontrados/2026-10-12-foco-tabela-apos-releitura-paginada.md`). Sem dependências: roda a cada render, barato.
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    const cell = grid.current?.querySelector<HTMLElement>(`[data-cell="${target.row}:${target.col}"]`);
    if (cell) { pendingFocus.current = null; cell.focus(); }
  });
  useEffect(() => { chips.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [view, views]);
  /** Mutações de estrutura e do formulário podem mudar ordem/filtro e invalidam cursores: releitura começa na primeira página. Erro preserva o rascunho. */
  async function reload() {
    const next = await loadTable(tableId, undefined, definition, csrfToken);
    if (cursors.length > 1) refreshedFirstPage.current = JSON.stringify([tableId, definition, csrfToken, refresh]);
    setData(next); setZone(next.zone); setCursors((current) => current.length === 1 ? current : [undefined]); setActive({ row: 0, col: 0 });
  }
  /**
   * Edição de célula atualiza só a linha gravada com o registro que a própria gravação devolve (nova revisão e calculadas), para o dono seguir
   * na mesma página: o cursor da consulta é invalidado por qualquer mutação, então reler a página atual não é possível. Numa vista filtrada,
   * a linha que deixou de atender ao filtro continua visível até a próxima releitura (troca de página ou de vista), como numa planilha.
   */
  function patchRow(updated: TableRecord) {
    const current = dataRef.current;
    if (!current) return;
    setData({ ...current, page: { ...current.page, records: current.page.records.map((row) => row.id === updated.id ? { ...row, ...updated, values: { ...row.values, ...updated.values } } : row) } });
  }
  /** Confirma a gravação somente depois de reler o resultado, inclusive para leitores de tela. */
  async function saved() { await reload(); setNotice('Alterações salvas.'); }
  /** Trocas de página e navegação não podem descartar uma célula em edição. */
  function guarded(action: () => void) { if (busy.current) return; setNotice(''); if (dirty) setDiscardAction(() => action); else { setEdit(null); action(); } }
  /** Um ponto de foco por grade, com coordenadas limitadas às linhas/colunas presentes; aplicado após o próximo commit. */
  function focusCell(row: number, col: number) {
    const current = dataRef.current;
    if (!current?.page.records.length || !visibleColumns.length) return;
    const next = { row: Math.max(0, Math.min(row, current.page.records.length - 1)), col: Math.max(0, Math.min(col, visibleColumns.length - 1)) };
    setActive(next);
    pendingFocus.current = next;
  }
  /** Abre o editor na célula. `seed` substitui o valor quando o dono começa a digitar sobre a célula selecionada. */
  function startEdit(row: number, col: number, seed?: string) {
    const current = dataRef.current;
    if (!current) return;
    if (busy.current) { pendingStart.current = { row, col }; return; }
    setNotice('');
    const column = visibleColumns[col];
    if (!column) return;
    setActive({ row, col });
    if (column.type === 'calculated') { setFormula(column); return; }
    const value = current.page.records[row]?.values[column.id] ?? null;
    const input = column.type === 'relation' || column.type === 'multiselect' ? value : fieldInput(column, value, zone);
    skipBlur.current = false;
    setEdit({ row, col, value: seed !== undefined && column.type !== 'select' && column.type !== 'boolean' ? seed : input, initial: input, operationId: crypto.randomUUID(), error: '', conflict: false });
  }
  /**
   * Grava somente esta célula. `override` é o valor escolhido na hora (seleção, Sim/Não, relação, seleção múltipla), sem esperar o estado.
   * `advance` move o foco (Tab = ±1) depois do sucesso; `keepOpen` mantém o editor (marcações sucessivas da seleção múltipla).
   */
  async function saveCell(advance = 0, override?: TableCell, keepOpen = false) {
    const current = editRef.current;
    const page = dataRef.current;
    if (!current || !page || busy.current || current.conflict) return;
    const column = visibleColumns[current.col]!;
    const row = page.page.records[current.row]!;
    const raw = override !== undefined ? override : current.value;
    let value: TableCell;
    try { value = column.type === 'relation' || column.type === 'multiselect' ? raw : parseField(column, String(raw ?? ''), zone); }
    catch (cause) { setEdit({ ...current, value: raw, error: cause instanceof Error ? cause.message : 'Confira o campo.' }); return; }
    busy.current = true; setSaving(true);
    try {
      if (JSON.stringify(raw) !== JSON.stringify(current.initial)) {
        const result = await apiFetch<{ records: TableRecord[] }>(`/api/tables/${tableId}/records`, { method: 'POST', csrfToken, body: { operationId: current.operationId, expectedSchemaVersion: page.table.schemaVersion, updates: [{ id: row.id, expectedVersion: row.version, values: { [column.id]: value } }] } });
        const updated = result.records.find((item) => item.id === row.id);
        if (updated) patchRow(updated); else await reload();
        setNotice('Alterações salvas.');
      }
      if (keepOpen) { setEdit({ ...current, value: raw, initial: raw, operationId: crypto.randomUUID(), error: '' }); return; }
      setEdit(null);
      const columns = visibleColumns.length;
      const total = current.row * columns + current.col + advance;
      const last = (dataRef.current?.page.records.length ?? 1) * columns - 1;
      const target = Math.max(0, Math.min(total, last));
      // Sem `pendingStart`, o foco volta à grade; com ele, a próxima célula clicada abre logo abaixo.
      if (!pendingStart.current) focusCell(Math.floor(target / columns), target % columns);
    } catch (cause) { setEdit({ ...current, value: raw, error: apiErrorMessage(cause), conflict: cause instanceof ApiError && cause.code === 'TABLE_CONFLICT' }); pendingStart.current = null; }
    finally {
      busy.current = false; setSaving(false);
      const next = pendingStart.current; pendingStart.current = null;
      if (next && !editRef.current) startEdit(next.row, next.col);
    }
  }
  /** Descarta o rascunho da célula e devolve o foco a ela. */
  function cancelEdit(row: number, col: number) { if (busy.current) return; skipBlur.current = true; setEdit(null); focusCell(row, col); }
  /** Teclado da grade: setas navegam, Enter/F2 ou digitar editam; no editor, Enter confirma (Shift+Enter quebra linha no texto), Tab avança e Escape descarta. */
  function cellKey(event: KeyboardEvent<HTMLTableCellElement>, row: number, col: number) {
    const editing = editRef.current;
    if (editing) {
      if (event.key === 'Escape') { event.preventDefault(); cancelEdit(row, col); }
      else if (event.key === 'Tab') { event.preventDefault(); void saveCell(event.shiftKey ? -1 : 1); }
      else if (event.key === 'Enter' && !event.shiftKey && (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) { event.preventDefault(); void saveCell(0); }
      return;
    }
    if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); startEdit(row, col); return; }
    const delta: Record<string, [number, number]> = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
    if (delta[event.key]) { event.preventDefault(); focusCell(row + delta[event.key]![0], col + delta[event.key]![1]); return; }
    // Digitar sobre a célula selecionada começa a edição com o caractere, como numa planilha.
    const column = visibleColumns[col];
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && column && !['calculated', 'relation', 'multiselect', 'select', 'boolean'].includes(column.type)) { event.preventDefault(); startEdit(row, col, event.key); }
  }
  /** Conteúdo da célula em edição, conforme o tipo; erro e conflito aparecem logo abaixo, sem botão de salvar. */
  function editorFor(column: TableColumn, current: CellEdit, rowIndex: number, colIndex: number): ReactNode {
    const id = `cell-edit-${column.id}`;
    const feedback = <>{current.error ? <p role="alert" className="mt-1 text-left text-xs text-danger">{current.error}</p> : null}{current.conflict ? <Button size="sm" variant="secondary" className="mt-1" onClick={() => setDiscardAction(() => () => { void reload(); })}>Recarregar dados</Button> : null}</>;
    if (column.type === 'relation') {
      return <>{cellLabel(column, current.value, zone)}<RelationPicker column={column} value={current.value} zone={zone} onApply={(value) => { setEdit({ ...current, value }); void saveCell(0, value); }} onClose={() => { if (!busy.current && editRef.current?.row === rowIndex && editRef.current.col === colIndex && JSON.stringify(editRef.current.value) === JSON.stringify(editRef.current.initial)) cancelEdit(rowIndex, colIndex); }} />{feedback}</>;
    }
    if (column.type === 'multiselect') {
      const selected = Array.isArray(current.value) ? current.value : [];
      return <fieldset id={id} aria-label={column.name} disabled={saving || current.conflict} className="space-y-1 rounded-sm border border-line-strong bg-surface p-2"
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null) && !busy.current) cancelEdit(rowIndex, colIndex); }}>
        {column.options.map((option, index) => <label key={option.id} className="flex min-h-7 items-center gap-2 text-sm"><input type="checkbox" autoFocus={index === 0} className="size-4 accent-primary" checked={selected.includes(option.id)}
          onChange={(event) => { const next = event.target.checked ? [...selected, option.id] : selected.filter((item) => item !== option.id); void saveCell(0, next.length ? next : null, true); }} />{option.label}</label>)}
        {feedback}
      </fieldset>;
    }
    return <>
      <div onBlur={() => { if (skipBlur.current) { skipBlur.current = false; return; } if (column.type !== 'select' && column.type !== 'boolean') void saveCell(0); }}>
        <CellEditor id={id} column={column} value={current.value} zone={zone} disabled={saving || current.conflict}
          onChange={(value) => setEdit({ ...current, value, operationId: crypto.randomUUID(), error: '' })}
          onCommit={(value) => { setEdit({ ...current, value }); void saveCell(0, value); }} />
      </div>
      {feedback}
    </>;
  }
  /** O título da tela é o `h1` da página; embutido no painel, a conversa já tem o `h1` e ele é um `h2`. */
  const Title = embedded ? 'h2' : 'h1';
  const layout = embedded ? PANEL_LAYOUT : PAGE_LAYOUT;
  return <section className={cn('mx-auto flex w-full min-w-0 max-w-[1600px] flex-col gap-3', layout.pad)}>
    <header className="flex min-w-0 items-start gap-3">{embedded ? null : <Button asChild variant="ghost" size="icon" className="-ml-2 shrink-0"><Link href={parentHref} prefetch={false} aria-label="Voltar" onClick={(event) => { if (dirty) { event.preventDefault(); guarded(() => router.push(parentHref)); } }}><ArrowLeft className="size-[18px]" aria-hidden /></Link></Button>}<div className="min-w-0"><Title className="break-words text-xl font-semibold">{data?.table.name ?? 'Tabela'}</Title>{data?.table.description ? <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-muted">{data.table.description}</p> : null}</div></header>
    {loading ? <p role="status" className="text-muted">Carregando tabela…</p> : error ? <div className="space-y-3"><p role="alert" className="text-danger">{error}</p><Button variant="secondary" onClick={() => setRefresh((current) => current + 1)}>Tentar novamente</Button>{data && <><Button variant="secondary" onClick={() => setViewOpen(true)}>Ajustar consulta</Button><Button variant="secondary" onClick={() => { setView(undefined); setDefinition(undefined); setCursors([undefined]); setRefresh((current) => current + 1); }}>Todos os registros</Button></>}</div> : data ? <>
      {/* Barra: atalhos de vistas (presets salvos pelo dono ou pela IA) à esquerda e ações só com ícone à direita. */}
      <div className={cn('flex min-w-0 flex-wrap items-center gap-2', layout.toolbar)}>
        <div role="group" aria-label="Vistas" ref={chips} className={cn('order-2 flex w-full min-w-0 items-center gap-1 overflow-x-auto pb-0.5', layout.chips)}>
          {[undefined, ...views].map((item) => {
            const selected = item ? view?.id === item.id : !view;
            return <button key={item?.id ?? 'todos'} type="button" aria-pressed={selected} disabled={saving} onClick={() => chooseView(item)}
              className={cn('h-8 shrink-0 rounded-md border px-2.5 text-sm whitespace-nowrap transition-colors disabled:opacity-50', selected ? 'border-line-strong bg-selected font-medium text-fg' : 'border-transparent text-muted hover:bg-surface-hover hover:text-fg')}>
              {item?.name ?? 'Todos'}
            </button>;
          })}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <IconAction label="Filtrar e organizar" onClick={() => guarded(() => setViewOpen(true))}><SlidersHorizontal className="size-4" aria-hidden /></IconAction>
          <IconAction label="Estrutura" disabled={saving} onClick={() => guarded(() => setColumnOpen(true))}><Columns3 className="size-4" aria-hidden /></IconAction>
          <IconAction label="Compartilhar" disabled={saving} onClick={() => guarded(() => setSharingOpen(true))}><Share2 className="size-4" aria-hidden /></IconAction>
          <IconAction label="Excluir tabela" disabled={saving} onClick={() => guarded(() => setDeleting(true))}><Trash2 className="size-4" aria-hidden /></IconAction>
          <IconAction id="table-new-record" label="Novo registro" variant="primary" disabled={saving || !data.table.columns.length} onClick={() => guarded(() => setRecord(null))}><Plus className="size-4" aria-hidden /></IconAction>
        </div>
      </div>
      {definition && !view ? <p className="text-xs text-muted">Consulta aplicada · {definition.filter ? 'Com filtros' : 'Sem filtros'} · {definition.sort?.length ?? 0} ordenação(ões) · {visibleColumns.length} coluna(s)</p> : null}
      {!data.table.columns.length ? <div className="rounded-lg border border-line bg-panel p-6"><h2 className="font-medium">Esta tabela ainda não tem colunas.</h2><p className="mt-2 text-sm text-muted">Adicione uma coluna para começar a organizar seus registros.</p><Button className="mt-4" onClick={() => setColumnOpen(true)}>Adicionar primeira coluna</Button></div> : !visibleColumns.length ? <p className="rounded-lg border border-line p-4 text-sm">Nenhuma coluna selecionada. Abra Filtrar e organizar para escolher os campos.</p> : !data.page.records.length ? <p className="rounded-lg border border-line bg-panel p-6 text-muted">{definition?.filter ? 'Nenhum registro encontrado para estes filtros.' : 'Esta tabela ainda não tem registros.'}</p> : <>
        <div className={cn('hidden max-h-[calc(100dvh-14rem)] min-w-0 overflow-auto rounded-lg border border-line', layout.grid)} data-testid="table-grid-scroll">
          <table ref={grid} role="grid" aria-label={`Registros de ${data.table.name}`} aria-rowcount={data.page.records.length + 1} aria-colcount={visibleColumns.length} className="w-max min-w-full border-separate border-spacing-0 text-sm">
            <thead className="sticky top-0 z-20"><tr>{visibleColumns.map((column, colIndex) => <th key={column.id} scope="col" className={cn('border-b border-line bg-panel px-2 py-2 text-left text-xs font-medium text-muted', (column.type === 'number' || column.type === 'money') && 'text-right', colIndex === 0 && 'sticky left-0 z-30 border-r')}><span className="block max-w-72 truncate" title={column.name}>{column.name}{column.type === 'calculated' ? <span className="ml-1 font-normal text-subtle">· Calculado</span> : null}</span></th>)}</tr></thead>
            <tbody>{data.page.records.map((row, rowIndex) => <tr key={row.id} className="group">{visibleColumns.map((column, colIndex) => {
              const editing = edit?.row === rowIndex && edit.col === colIndex ? edit : null;
              const pinned = colIndex === 0;
              return <td key={column.id} role="gridcell" tabIndex={active.row === rowIndex && active.col === colIndex ? 0 : -1} data-cell={`${rowIndex}:${colIndex}`}
                aria-label={`${column.name}, registro ${rowIndex + 1}: ${row.errors?.[column.id] ? 'Erro de cálculo' : cellLabel(column, row.values[column.id], zone)}`} aria-readonly={column.type === 'calculated'}
                onFocus={() => { if (!editRef.current) setActive({ row: rowIndex, col: colIndex }); }} onKeyDown={(event) => cellKey(event, rowIndex, colIndex)}
                onClick={(event) => { if (editing || (event.target as HTMLElement).closest('button, a')) return; startEdit(rowIndex, colIndex); }}
                className={cn('border-b border-line px-2 py-1 align-top outline-offset-[-2px] cursor-text', column.type === 'calculated' && 'cursor-pointer', column.type === 'number' || column.type === 'money' ? 'text-right tabular-nums' : '', pinned ? 'sticky left-0 z-10 border-r bg-app font-medium group-hover:bg-surface-hover' : 'bg-app group-hover:bg-surface-hover', editing && 'bg-surface')}>
                <div className={cn(pinned ? 'flex w-56 items-start gap-1' : column.type === 'text' ? 'w-56' : 'w-36')}>
                  <div className="min-w-0 flex-1">
                    {editing ? editorFor(column, editing, rowIndex, colIndex) : <span className={cn('block py-0.5', column.type === 'text' ? 'line-clamp-2 break-words' : 'truncate')} title={cellLabel(column, row.values[column.id], zone)}>{row.errors?.[column.id] ? <span className="inline-flex items-center gap-1 text-danger"><CircleAlert className="size-4" aria-hidden />Erro de cálculo</span> : row.values[column.id] === null || row.values[column.id] === undefined ? <span className="text-subtle">—</span> : cellLabel(column, row.values[column.id], zone)}</span>}
                  </div>
                  {/* Abrir o registro completo fica na coluna fixa, sempre ao alcance mesmo com a grade rolada para a direita. */}
                  {pinned && !editing ? <Button size="icon" variant="ghost" className="size-6 shrink-0 opacity-60 group-hover:opacity-100 focus-visible:opacity-100" aria-label="Abrir registro" title="Abrir registro" onClick={() => guarded(() => void openRecord(row))}><Maximize2 className="size-3.5" aria-hidden /></Button> : null}
                </div>
              </td>;
            })}</tr>)}</tbody>
          </table>
        </div>
        <div className={layout.list}>{data.page.records.map((row) => <MobileRecord key={row.id} table={visibleTable!} record={row} zone={zone} onOpen={() => void openRecord(row)} />)}</div>
      </>}
      {visibleColumns.length ? <footer className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted">{data.page.records.length} registro(s) nesta página</p><div className="flex gap-2"><Button size="sm" variant="secondary" disabled={saving || cursors.length === 1} onClick={() => guarded(() => setCursors((current) => current.slice(0, -1)))}>Anterior</Button><Button size="sm" variant="secondary" disabled={saving || !data.page.nextCursor} onClick={() => guarded(() => setCursors((current) => [...current, data.page.nextCursor!]))}>Próxima</Button></div></footer> : null}
      {notice ? <p role="status" className="text-xs text-muted">{notice}</p> : null}
      {record !== undefined ? <RecordForm table={data.table} record={record} zone={zone} onClose={() => setRecord(undefined)} onSaved={saved} onReload={reload} /> : null}
      {sharingOpen ? <SharingEditor table={data.table} onClose={() => setSharingOpen(false)} onSaved={(table) => setData({ ...data, table })} /> : null}
      {deleting ? <DestructiveAction table={data.table} target={{ kind: "delete_table" }} verb="Excluir tabela" onClose={() => setDeleting(false)} onDone={async () => { if (embedded) embedded.onDeleted(); else router.push(parentHref); }} /> : null}
      {columnOpen ? <StructureEditor table={data.table} zone={zone} onClose={() => setColumnOpen(false)} onSaved={saved} /> : null}

    </> : null}
    {data && viewOpen ? <ViewEditor table={data.table} zone={zone} definition={definition ?? {}} view={view} onApply={applyView} onViewsChanged={loadViews} onClose={() => setViewOpen(false)} /> : null}
    <Modal open={formula !== null} onOpenChange={(open) => { if (!open) setFormula(null); }}><ModalContent title={formula?.name ?? 'Fórmula'} description="Campo calculado, somente leitura."><div className="mt-4 whitespace-pre-wrap break-words text-sm">{formula?.type === 'calculated' && data ? <FormulaExpression value={formula.formula} columns={data.table.columns} /> : ''}</div><ModalActions><Button onClick={() => setFormula(null)}>Fechar</Button></ModalActions></ModalContent></Modal>
    <Modal open={discardAction !== null} onOpenChange={(open) => { if (!open) setDiscardAction(null); }}><ModalContent title="Descartar alterações?" description="A edição da célula ainda não foi salva."><ModalActions><Button variant="secondary" onClick={() => setDiscardAction(null)}>Continuar editando</Button><Button variant="danger" onClick={() => { setEdit(null); const action = discardAction; setDiscardAction(null); action?.(); }}>Descartar alterações</Button></ModalActions></ModalContent></Modal>
  </section>;
}

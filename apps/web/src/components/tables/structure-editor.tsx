'use client';

// Estrutura inteira e edição de coluna compartilham um único drawer; operações com perda passam pelo portão central.
import { FORMULA_TYPES, tableColumnInputSchema, type DataTable, type TableColumn, type TableColumnInput, type TablePreparation, type TableRecord, type TableCell, type TableView, type TableCellError } from '@aion/shared';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Modal, ModalActions, ModalContent } from '@/components/ui/modal';
import { apiErrorMessage, apiFetch } from '@/lib/api-client';
import { useSession } from '@/lib/session-context';
import { ConfigurationPanel } from './configuration-panel';
import { COLUMN_LABELS, filterReferences, formulaReferences, formulaSize, moveItem, serializeFormula } from './configuration';
import { DestructiveConfirmation } from './destructive-confirmation';
import { DestructiveAction } from './destructive-action';
import { FormulaEditor, FormulaExpression } from './formula-editor';
import { cellLabel, recordLabel } from './values';
import { pagePath, type RecordPage, type TablePage } from './api';

const calculationErrors: Record<TableCellError, string> = { DIVISION_BY_ZERO: 'Divisão por zero. Confira o divisor.', OVERFLOW: 'O resultado excede os limites do tipo.', INVALID_DATE: 'A expressão produziu uma data inválida.', DEPENDENCY_ERROR: 'Uma coluna usada pela expressão tem erro.' };

/** Só a configuração pertinente ao tipo entra no contrato, sem campos antigos ocultos. */
export function changeColumnType(column: TableColumnInput, type: TableColumnInput['type']): TableColumnInput {
  const identity = { ...(column.id ? { id: column.id } : {}), name: column.name };
  return type === 'money' ? { ...identity, type, currency: 'BRL' } : type === 'select' || type === 'multiselect' ? { ...identity, type, options: [{ id: crypto.randomUUID(), label: 'Opção 1' }] } : type === 'relation' ? { ...identity, type, targetTableId: '', cardinality: 'one' } : type === 'calculated' ? { ...identity, type, resultType: 'number', formula: { kind: 'literal', type: 'number', value: '0' } } : { ...identity, type };
}

/** Estado local é preservado em conflito/dependência; salvar coluna usa a revisão do schema original. */
export function StructureEditor({ table, zone, onSaved, onClose }: { table: DataTable; zone: string; onSaved: () => Promise<void>; onClose: () => void }) {
  const { csrfToken } = useSession();
  const [name, setName] = useState(table.name); const [description, setDescription] = useState(table.description); const [columns, setColumns] = useState(table.columns);
  const [column, setColumn] = useState<TableColumnInput | null>(null); const [original, setOriginal] = useState<TableColumn | null>(null);
  const [error, setError] = useState(''); const [saving, setSaving] = useState(false); const busy = useRef(false);
  const [targets, setTargets] = useState<DataTable[]>([]); const [records, setRecords] = useState<TableRecord[]>([]); const [recordCursor, setRecordCursor] = useState<string | null>(null); const [previewRecord, setPreviewRecord] = useState('');
  const [views, setViews] = useState<TableView[]>([]);
  const [preview, setPreview] = useState<{ value: TableCell; error?: string } | null>(null); const [previewBusy, setPreviewBusy] = useState(false);
  const [preparation, setPreparation] = useState<TablePreparation | null>(null); const [confirmationError, setConfirmationError] = useState('');
  const [deletingColumn, setDeletingColumn] = useState(false);
  const [discardColumn, setDiscardColumn] = useState(false);
  const attempt = useRef<{ signature: string; id: string } | null>(null);
  const dirty = JSON.stringify({ name, description, columns }) !== JSON.stringify({ name: table.name, description: table.description, columns: table.columns }) || !!column && JSON.stringify(column) !== JSON.stringify(original);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const options: DataTable[] = []; let cursor: string | null = null;
        do { const page: TablePage = await apiFetch<TablePage>(pagePath('/api/tables', cursor ?? undefined, 100)); options.push(...page.tables); cursor = page.nextCursor; } while (cursor);
        const page = await apiFetch<RecordPage>(pagePath(`/api/tables/${table.id}/records`));
        const savedViews = await apiFetch<{ views: TableView[] }>(`/api/tables/${table.id}/views`);
        if (!cancelled) { setTargets(options); setRecords(page.records); setRecordCursor(page.nextCursor); setViews(savedViews.views); }
      } catch (cause) { if (!cancelled) setError(apiErrorMessage(cause)); }
    }
    void load(); return () => { cancelled = true; };
  }, [table.id]);
  /** Reutiliza a paginação real dos registros da prévia, sem listar a tabela inteira. */
  async function moreRecords() { try { const page = await apiFetch<RecordPage>(pagePath(`/api/tables/${table.id}/records`, recordCursor!)); setRecords((current) => [...current, ...page.records]); setRecordCursor(page.nextCursor); } catch (cause) { setError(apiErrorMessage(cause)); } }
  /** Prévia nunca avalia AST no navegador e erro de célula jamais vira zero. */
  async function validateFormula() {
    if (column?.type !== 'calculated') return;
    setPreviewBusy(true); setError(''); setPreview(null);
    try { const values = records.find((item) => item.id === previewRecord)?.values ?? {}; const stored = Object.fromEntries(Object.entries(values).filter(([id]) => table.columns.find((item) => item.id === id)?.type !== 'calculated')); const result = await apiFetch<{ value: TableCell; error?: string }>(`/api/tables/${table.id}/formula-preview`, { method: 'POST', csrfToken, body: { ...(original ? { columnId: original.id } : {}), formula: serializeFormula(column.formula), resultType: column.resultType, ...(column.currency ? { currency: column.currency } : {}), values: stored } }); setPreview(result); }
    catch (cause) { setError(apiErrorMessage(cause)); }
    finally { setPreviewBusy(false); }
  }
  /** Tipos/configurações alterados em coluna existente exigem impacto; renomear/fórmula calculada continuam no PATCH validado. */
  async function save() {
    if (busy.current) return;
    busy.current = true; setSaving(true); setError('');
    try {
      const parsed = column ? tableColumnInputSchema.parse(column.type === "calculated" ? { ...column, formula: serializeFormula(column.formula) } : column) : null;
      const configChanged = parsed && original && (parsed.type !== original.type || ['money', 'select', 'multiselect', 'relation'].includes(parsed.type) && JSON.stringify({ ...parsed, name: '' }) !== JSON.stringify({ ...original, name: '' }) || parsed.type === 'calculated' && original.type === 'calculated' && (parsed.resultType !== original.resultType || parsed.currency !== original.currency));
      if (configChanged) {
        if (JSON.stringify({ name, description, columns }) !== JSON.stringify({ name: table.name, description: table.description, columns: table.columns })) throw new Error('Salve primeiro as alterações da tabela antes de preparar a conversão desta coluna.');
        setPreparation(await apiFetch<TablePreparation>(`/api/tables/${table.id}/operations/prepare`, { method: 'POST', csrfToken, body: { kind: 'convert_column', expectedVersion: table.version, column: parsed } })); setConfirmationError(''); return;
      }
      const next = parsed ? original ? columns.map((item) => item.id === original.id ? parsed : item) : [...columns, parsed] : columns;
      const body = { name, description, columns: next, expectedSchemaVersion: table.schemaVersion };
      const signature = JSON.stringify(body); if (attempt.current?.signature !== signature) attempt.current = { signature, id: crypto.randomUUID() };
      await apiFetch(`/api/tables/${table.id}`, { method: 'PATCH', csrfToken, body: { ...body, operationId: attempt.current.id } }); await onSaved(); onClose();
    } catch (cause) { setError(apiErrorMessage(cause)); }
    finally { busy.current = false; setSaving(false); }
  }
  /** Confirma apenas a preparação visível; conflito mantém o formulário e exige nova preparação explícita. */
  async function confirm() {
    if (!preparation || busy.current) return;
    busy.current = true; setSaving(true);
    const signature = preparation.preparationId; if (attempt.current?.signature !== signature) attempt.current = { signature, id: crypto.randomUUID() };
    try { await apiFetch(`/api/tables/${table.id}/operations/confirm`, { method: 'POST', csrfToken, body: { preparationId: preparation.preparationId, operationId: attempt.current.id, confirmation: true } }); await onSaved(); onClose(); }
    catch (cause) { setConfirmationError(apiErrorMessage(cause)); }
    finally { busy.current = false; setSaving(false); }
  }
  return <><ConfigurationPanel title={column ? original ? `Editar coluna · ${original.name}` : 'Adicionar coluna' : 'Estrutura'} dirty={dirty} busy={saving || previewBusy} wide onClose={onClose} footer={<Button disabled={saving || previewBusy} onClick={() => void save()}>{saving ? 'Salvando…' : 'Salvar estrutura'}</Button>}>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {!column ? <><div><label htmlFor="structure-name" className="mb-1 block text-sm">Nome da tabela</label><Input id="structure-name" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></div><div><label htmlFor="structure-description" className="mb-1 block text-sm">Descrição</label><Textarea id="structure-description" maxLength={1000} value={description} onChange={(event) => setDescription(event.target.value)} /></div><section className="space-y-3"><h3 className="font-semibold">Colunas</h3>{columns.map((item, index) => <div key={item.id} className="flex flex-wrap items-center gap-2 rounded border border-line p-3"><Button className="h-auto min-w-0 flex-1 justify-start whitespace-normal break-words text-left" variant="ghost" onClick={() => { setOriginal(item); setColumn(item); setPreview(null); }}>{item.name} · {COLUMN_LABELS[item.type]}</Button><Button size="sm" variant="ghost" disabled={index === 0} aria-label={`Subir ${item.name}`} onClick={() => setColumns(moveItem(columns, index, -1))}>Subir</Button><Button size="sm" variant="ghost" disabled={index === columns.length - 1} aria-label={`Descer ${item.name}`} onClick={() => setColumns(moveItem(columns, index, 1))}>Descer</Button></div>)}<Button variant="secondary" disabled={columns.length >= 50} onClick={() => { setOriginal(null); setColumn({ name: '', type: 'text' }); setPreview(null); }}>Adicionar coluna</Button><p className="text-xs text-muted">Até 50 colunas. Reordenar mantém os registros e suas referências.</p></section></> : <>
      <Button variant="ghost" onClick={() => { if (JSON.stringify(column) !== JSON.stringify(original)) setDiscardColumn(true); else { setColumn(null); setOriginal(null); setError(''); setPreview(null); } }}>Voltar à estrutura</Button>
      <div><label htmlFor="column-name" className="mb-1 block text-sm">Nome</label><Input id="column-name" maxLength={80} value={column.name} onChange={(event) => setColumn({ ...column, name: event.target.value })} /></div><div><label htmlFor="column-type" className="mb-1 block text-sm">Tipo</label><Select id="column-type" value={column.type} onChange={(event) => { setColumn(changeColumnType(column, event.target.value as typeof column.type)); setPreview(null); }}>{Object.entries(COLUMN_LABELS).map(([type, label]) => <option key={type} value={type}>{label}</option>)}</Select></div>
      {(column.type === 'money' || column.type === 'calculated' && column.resultType === 'money') && <div><label htmlFor="column-currency" className="mb-1 block text-sm">Moeda</label><Select id="column-currency" value={column.currency} onChange={(event) => setColumn({ ...column, currency: event.target.value })}>{Intl.supportedValuesOf('currency').map((code) => <option key={code}>{code}</option>)}</Select></div>}
      {(column.type === 'select' || column.type === 'multiselect') && <section className="space-y-3"><h3 className="font-semibold">Opções</h3>{column.options.map((option, index) => <div key={option.id} className="space-y-2"><label htmlFor={`option-${option.id}`} className="block text-sm">Opção {index + 1}</label><Input id={`option-${option.id}`} maxLength={80} value={option.label} onChange={(event) => setColumn({ ...column, options: column.options.map((item) => item.id === option.id ? { ...item, label: event.target.value } : item) })} /><Button size="sm" variant="ghost" onClick={() => setColumn({ ...column, options: column.options.filter((item) => item.id !== option.id) })}>Remover opção {index + 1}</Button></div>)}<Button variant="secondary" disabled={column.options.length >= 100} onClick={() => setColumn({ ...column, options: [...column.options, { id: crypto.randomUUID(), label: '' }] })}>Adicionar opção</Button></section>}
      {column.type === 'relation' && <><div><label htmlFor="relation-table" className="mb-1 block text-sm">Tabela relacionada</label><Select id="relation-table" value={column.targetTableId} onChange={(event) => setColumn({ ...column, targetTableId: event.target.value })}><option value="">Selecione uma tabela</option>{targets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></div><div><label htmlFor="relation-cardinality" className="mb-1 block text-sm">Quantidade relacionada</label><Select id="relation-cardinality" value={column.cardinality} onChange={(event) => setColumn({ ...column, cardinality: event.target.value as 'one' | 'many' })}><option value="one">Um registro</option><option value="many">Vários registros</option></Select></div></>}
      {column.type === 'calculated' && <><div><label htmlFor="formula-result" className="mb-1 block text-sm">Tipo do resultado</label><Select id="formula-result" value={column.resultType} onChange={(event) => { const { currency: ignoredCurrency, ...rest } = column; void ignoredCurrency; const resultType = event.target.value as typeof column.resultType; setColumn({ ...rest, resultType, ...(resultType === 'money' ? { currency: 'BRL' } : {}) }); setPreview(null); }}>{FORMULA_TYPES.map((type) => <option key={type} value={type}>{COLUMN_LABELS[type]}</option>)}</Select></div><FormulaEditor value={column.formula} columns={table.columns} onChange={(formula) => { const size = formulaSize(formula); if (size.nodes > 100 || size.characters > 4000) { setError('A fórmula aceita até 100 elementos e 4.000 caracteres. Simplifique a expressão.'); return; } setColumn({ ...column, formula }); setError(''); setPreview(null); }} /><p className="text-xs text-muted">Até 100 elementos e 4.000 caracteres · {formulaSize(column.formula).nodes} elemento(s)</p><FormulaExpression value={column.formula} columns={table.columns} /><section className="space-y-3"><h3 className="font-semibold">Prévia no servidor</h3><label htmlFor="formula-record" className="block text-sm">Registro para prévia</label><Select id="formula-record" value={previewRecord} onChange={(event) => { setPreviewRecord(event.target.value); setPreview(null); }}><option value="">Validar sem registro</option>{records.map((item) => <option key={item.id} value={item.id}>{recordLabel(table.columns, item, zone)}</option>)}</Select>{recordCursor && <Button variant="secondary" onClick={() => void moreRecords()}>Carregar mais registros</Button>}<Button variant="secondary" disabled={previewBusy} onClick={() => void validateFormula()}>{previewBusy ? 'Validando…' : 'Validar fórmula'}</Button>{preview && <p role={preview.error ? 'alert' : 'status'} className="whitespace-pre-wrap break-words text-sm">{preview.error ? `Erro na expressão: ${calculationErrors[preview.error as TableCellError] ?? "Não foi possível calcular este registro."}` : !records.length ? 'Fórmula válida. Adicione um registro para ver o resultado.' : `Resultado: ${cellLabel({ ...column, id: column.id ?? table.id }, preview.value, zone)}`}</p>}</section></>}
      {original && <Button variant="danger" disabled={dirty} onClick={() => setDeletingColumn(true)}>Excluir coluna</Button>}
      {original && <section className="space-y-2"><h3 className="font-semibold">Dependências desta coluna</h3><ul className="space-y-2 text-sm">{table.columns.filter((item) => item.type === "calculated" && item.id !== original.id && formulaReferences(item.formula, original.id)).map((item) => <li key={item.id}>Coluna: {item.name}</li>)}{views.filter((item) => item.columns?.includes(original.id) || item.sort?.some((sort) => sort.columnId === original.id) || filterReferences(item.filter, original.id)).map((item) => <li key={item.id}>Vista: {item.name}</li>)}</ul></section>}<p className="text-xs text-muted">Dependências são verificadas pelo servidor. Nenhuma coluna, vista ou registro será removido para resolver um impedimento.</p>
    </>}
  </ConfigurationPanel><Modal open={discardColumn} onOpenChange={setDiscardColumn}><ModalContent title="Descartar alterações da coluna?"><ModalActions><Button variant="secondary" onClick={() => setDiscardColumn(false)}>Continuar editando</Button><Button variant="danger" onClick={() => { setColumn(null); setOriginal(null); setPreview(null); setDiscardColumn(false); }}>Descartar alterações</Button></ModalActions></ModalContent></Modal>{deletingColumn && original && <DestructiveAction table={table} target={{ kind: "delete_column", columnId: original.id }} verb="Excluir coluna" onClose={() => setDeletingColumn(false)} onDone={async () => { await onSaved(); onClose(); }} />}{preparation && <DestructiveConfirmation preparation={preparation} busy={saving} error={confirmationError} verb="Converter coluna" onCancel={() => setPreparation(null)} onConfirm={() => void confirm()} />}</>;
}

'use client';

// Campo compartilhado pelo drawer e pela edição de célula. Valores calculados nunca viram entrada gravável.
import type { TableCell, TableColumn } from '@aion/shared';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal, ModalActions, ModalContent } from '@/components/ui/modal';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { RelationPicker } from './relation-picker';
import { FormulaExpression } from './formula-editor';
import { cellLabel, fieldInput } from './values';

/** Entradas escalares são strings até salvar; seleções e relações já carregam IDs tipados. */
export function TableField({ column, columns = [column], value, zone, onChange, disabled, compact = false, id }: { column: TableColumn; columns?: TableColumn[]; value: TableCell | undefined; zone: string; onChange: (value: TableCell) => void; disabled?: boolean; compact?: boolean; id: string }) {
  const [picker, setPicker] = useState(false);
  const [showFormula, setShowFormula] = useState(false);
  const string = typeof value === 'string' ? value : fieldInput(column, value, zone);
  if (column.type === 'calculated') return <><p id={id} className="whitespace-pre-wrap break-words text-sm">{cellLabel(column, value, zone)}<span className="block text-xs text-muted">Somente leitura</span></p><Button size="sm" variant="ghost" onClick={() => setShowFormula(true)}>Ver fórmula de {column.name}</Button><Modal open={showFormula} onOpenChange={setShowFormula}><ModalContent title={column.name} description="Campo calculado, somente leitura."><div className="mt-4"><FormulaExpression value={column.formula} columns={columns} /></div><ModalActions><Button onClick={() => setShowFormula(false)}>Fechar</Button></ModalActions></ModalContent></Modal></>;
  if (column.type === 'relation') return <><Button id={id} className="h-auto min-h-10 w-full justify-start whitespace-normal break-words text-left" variant="secondary" disabled={disabled} onClick={() => setPicker(true)}>{value === null || value === undefined ? 'Selecionar registros' : cellLabel(column, value, zone)}</Button>{picker ? <RelationPicker column={column} value={value} zone={zone} onApply={onChange} onClose={() => setPicker(false)} /> : null}</>;
  if (column.type === 'multiselect') {
    const selected = Array.isArray(value) ? value : [];
    return <fieldset id={id} disabled={disabled} className="max-h-60 space-y-2 overflow-y-auto rounded-md border border-line p-3" aria-label={column.name}>{column.options.map((option) => <label key={option.id} className="flex min-h-8 items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-primary" checked={selected.includes(option.id)} onChange={(event) => onChange(event.target.checked ? [...selected, option.id] : selected.filter((item) => item !== option.id))} />{option.label}</label>)}<Button size="sm" variant="ghost" onClick={() => onChange(null)}>Limpar seleção</Button></fieldset>;
  }
  if (column.type === 'boolean' || column.type === 'select') return <Select id={id} aria-label={column.name} disabled={disabled} value={typeof value === 'boolean' ? String(value) : string} onChange={(event) => onChange(event.target.value)}><option value="">Vazio</option>{column.type === 'boolean' ? <><option value="true">Sim</option><option value="false">Não</option></> : column.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</Select>;
  if (column.type === 'text' && !compact) return <Textarea id={id} aria-label={column.name} disabled={disabled} value={string} maxLength={8000} onChange={(event) => onChange(event.target.value)} />;
  return <><Input id={id} aria-label={column.name} disabled={disabled} value={string} type={column.type === 'date' ? 'date' : column.type === 'time' ? 'time' : column.type === 'datetime' ? 'datetime-local' : 'text'} step={column.type === 'datetime' ? 0.001 : undefined} inputMode={column.type === 'number' || column.type === 'money' ? 'decimal' : undefined} maxLength={column.type === 'text' ? 8000 : undefined} onChange={(event) => onChange(event.target.value)} />{column.type === 'money' ? <p className="mt-1 text-xs text-muted">Moeda: {column.currency}. Sem separador de milhares.</p> : column.type === 'datetime' ? <p className="mt-1 text-xs text-muted">Fuso: {zone}</p> : null}</>;
}

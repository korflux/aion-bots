'use client';

// Construtor recursivo da AST restrita. O navegador só monta dados; validação e cálculo pertencem ao servidor.
import { FORMULA_OPERATORS, FORMULA_TYPES, type FormulaNode, type TableColumn } from '@aion/shared';
import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { formulaLabel } from './values';
import { COLUMN_LABELS, operationNode } from './configuration';

const operationLabels: Record<typeof FORMULA_OPERATORS[number], string> = { ADD: 'Somar', SUBTRACT: 'Subtrair', MULTIPLY: 'Multiplicar', DIVIDE: 'Dividir', EQ: 'Igual', NE: 'Diferente', LT: 'Menor', LTE: 'Menor ou igual', GT: 'Maior', GTE: 'Maior ou igual', AND: 'Todas as condições', OR: 'Qualquer condição', NOT: 'Negar condição', IF: 'Se · condição e alternativas', COALESCE: 'Primeiro valor preenchido', ROUND: 'Arredondar', TODAY: 'Hoje no fuso do dono', ADD_DAYS: 'Adicionar dias', ADD_MONTHS: 'Adicionar meses', DAYS_BETWEEN: 'Dias entre datas', BUSINESS_DAY_OF_MONTH: 'Dia útil do mês' };

/** Expressão legível única usada no editor e nas superfícies de somente leitura. */
export function FormulaExpression({ value, columns }: { value: FormulaNode; columns: TableColumn[] }) {
  return <p className="whitespace-pre-wrap break-words rounded border border-line p-3 font-mono text-sm">{formulaLabel(value, columns)}</p>;
}
/** Cada subexpressão é recolhível e tem controles próprios identificados para teclado/leitores de tela. */
export function FormulaEditor({ value, columns, onChange, depth = 1 }: { value: FormulaNode; columns: TableColumn[]; onChange: (value: FormulaNode) => void; depth?: number }) {
  const id = useId();
  return <details open className={depth === 1 ? 'min-w-0 rounded border border-line p-3' : 'min-w-0 rounded border-y border-line py-2'}>
    <summary className="cursor-pointer break-words text-sm">Expressão: {formulaLabel(value, columns)}</summary>
    <div className="mt-3 space-y-3">
      <label className="block text-sm" htmlFor={`${id}-kind`}>Expressão</label>
      <Select id={`${id}-kind`} value={value.kind} onChange={(event) => onChange(event.target.value === 'call' ? operationNode('ADD') : event.target.value === 'ref' && columns[0] ? { kind: 'ref', columnId: columns[0].id } : { kind: 'literal', type: 'number', value: '0' })}><option value="literal">Valor literal</option><option value="ref" disabled={!columns.length}>Referência de coluna</option><option value="call" disabled={depth >= 10}>Operação</option></Select>
      {value.kind === 'ref' ? <><label className="block text-sm" htmlFor={`${id}-ref`}>Coluna referenciada</label><Select id={`${id}-ref`} value={value.columnId} onChange={(event) => onChange({ ...value, columnId: event.target.value })}>{columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</Select></> : value.kind === 'literal' ? <>
        <label className="block text-sm" htmlFor={`${id}-type`}>Tipo do literal</label><Select id={`${id}-type`} value={value.type} onChange={(event) => { const type = event.target.value as typeof value.type; onChange({ kind: 'literal', type, value: type === 'boolean' ? false : '', ...(type === 'money' ? { currency: 'BRL' } : {}) }); }}>{FORMULA_TYPES.map((type) => <option key={type} value={type}>{COLUMN_LABELS[type]}</option>)}</Select>
        {value.type === 'money' && <><label className="block text-sm" htmlFor={`${id}-currency`}>Moeda do literal</label><Select id={`${id}-currency`} value={value.currency} onChange={(event) => onChange({ ...value, currency: event.target.value })}>{Intl.supportedValuesOf('currency').map((currency) => <option key={currency}>{currency}</option>)}</Select></>}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.value === null} onChange={(event) => onChange({ ...value, value: event.target.checked ? null : value.type === 'boolean' ? false : '' })} />Valor vazio</label>
        {value.value !== null && <><label className="block text-sm" htmlFor={`${id}-value`}>Valor literal</label>{value.type === 'boolean' ? <Select id={`${id}-value`} value={String(value.value)} onChange={(event) => onChange({ ...value, value: event.target.value === 'true' })}><option value="false">Não</option><option value="true">Sim</option></Select> : <Input id={`${id}-value`} value={String(value.value)} onChange={(event) => onChange({ ...value, value: event.target.value })} />}</>}
      </> : <>
        <label className="block text-sm" htmlFor={`${id}-op`}>Operação</label><Select id={`${id}-op`} value={value.op} onChange={(event) => onChange(operationNode(event.target.value as typeof value.op))}>{FORMULA_OPERATORS.map((op) => <option key={op} value={op}>{operationLabels[op]}</option>)}</Select>
        {value.args.map((arg, index) => <div key={index} className="space-y-2"><span className="text-xs text-muted">Argumento {index + 1}</span><FormulaEditor depth={depth + 1} value={arg} columns={columns} onChange={(next) => onChange({ ...value, args: value.args.map((item, position) => position === index ? next : item) })} />{['AND', 'OR', 'COALESCE'].includes(value.op) && value.args.length > 2 && <Button size="sm" variant="ghost" onClick={() => onChange({ ...value, args: value.args.filter((_, position) => position !== index) })}>Remover argumento {index + 1}</Button>}</div>)}
        {['AND', 'OR', 'COALESCE'].includes(value.op) && <Button size="sm" variant="secondary" onClick={() => onChange({ ...value, args: [...value.args, { kind: 'literal', type: 'number', value: '0' }] })}>Adicionar argumento</Button>}
      </>}
    </div>
  </details>;
}

// Transformações do editor de tabelas: apresentação legível e entradas escalares sem float.
import type { FormulaNode, TableCell, TableColumn, TableRecord } from '@aion/shared';

/** Decimal digitado admite vírgula, mas o transporte usa representação canônica exata. */
export function decimalInput(input: string): string {
  const value = input.trim().replace(',', '.');
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error('Informe um número decimal, sem separador de milhares.');
  const negative = value.startsWith('-');
  const [integer = '0', fraction = ''] = value.replace(/^-/, '').split('.');
  const whole = integer.replace(/^0+(?=\d)/, '');
  const decimal = fraction.replace(/0+$/, '');
  return `${negative && (whole !== '0' || decimal) ? '-' : ''}${whole}${decimal ? `.${decimal}` : ''}`;
}

/** Data/hora local no fuso do dono, independente do fuso do aparelho. */
export function localDateTime(iso: string, zone: string): string {
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)!.value;
  const fraction = date.getUTCMilliseconds() ? `.${String(date.getUTCMilliseconds()).padStart(3, '0').replace(/0+$/, '')}` : '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}${fraction}`;
}

/** Resolve o offset por Intl; horários inexistentes na mudança de fuso são recusados, nunca deslocados silenciosamente. */
export function dateTimeInput(local: string, zone: string): string {
  const normalized = local.length === 16 ? `${local}:00` : local;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(normalized)) throw new Error('Informe data e horário completos.');
  const civil = Date.parse(`${normalized}Z`);
  let instant = civil;
  for (let index = 0; index < 3; index++) instant += civil - Date.parse(`${localDateTime(new Date(instant).toISOString(), zone)}Z`);
  const result = new Date(instant).toISOString();
  if (localDateTime(result, zone) !== normalized.replace(/\.0+$/, '').replace(/(\.\d*?[1-9])0+$/, '$1')) throw new Error('Esse horário não existe no fuso selecionado.');
  return result;
}

/** Texto de edição: nulo é vazio; zero e falso continuam explícitos. */
export function fieldInput(column: TableColumn, value: TableCell | undefined, zone: string): string {
  if (value === undefined || value === null) return '';
  if (column.type === 'datetime' && typeof value === 'string') return localDateTime(value, zone);
  return Array.isArray(value) ? '' : String(value);
}

/** Converte apenas o tipo declarado; validações dependentes da tabela continuam no servidor. */
export function parseField(column: TableColumn, input: string, zone: string): TableCell {
  if (input === '') return null;
  switch (column.type) {
    case 'number': case 'money': return decimalInput(input);
    case 'boolean': return input === 'true';
    case 'datetime': return dateTimeInput(input, zone);
    default: return input;
  }
}

/** Apresentação completa, sem truncar texto nem converter números exatos. */
export function cellLabel(column: TableColumn, value: TableCell | undefined, zone: string): string {
  if (value === null || value === undefined) return 'Vazio';
  if (typeof value === 'boolean') return value ? 'Sim' : 'Não';
  if (column.type === 'select' || column.type === 'multiselect') {
    const ids = Array.isArray(value) ? value : [String(value)];
    return ids.map((id) => column.options.find((option) => option.id === id)?.label ?? 'Opção removida').join(', ') || 'Vazio';
  }
  if (column.type === 'relation') return (Array.isArray(value) ? value : [String(value)]).map((id) => `Registro #${id}`).join(', ') || 'Vazio';
  if ((column.type === 'money' || column.type === 'calculated' && column.resultType === 'money') && typeof value === 'string') {
    const [whole, fraction = ''] = value.split('.');
    return `${column.currency} ${whole},${fraction.padEnd(2, '0')}`;
  }
  if ((column.type === 'datetime' || column.type === 'calculated' && column.resultType === 'datetime') && typeof value === 'string') return `${localDateTime(value, zone).replace('T', ' ')} (${zone})`;
  return Array.isArray(value) ? value.join(', ') : String(value);
}

/** Nome de registro usado na lista e no seletor de relações, com fallback estável. */
export function recordLabel(columns: TableColumn[], record: TableRecord, zone: string): string {
  const column = columns.find((item) => item.type === 'text' && typeof record.values[item.id] === 'string' && record.values[item.id] !== '');
  return column ? cellLabel(column, record.values[column.id], zone) : `Registro #${record.id}`;
}

/** Fórmula legível usa nomes atuais, preservando as referências por ID no contrato. */
export function formulaLabel(node: FormulaNode, columns: TableColumn[]): string {
  if (node.kind === 'ref') return columns.find((column) => column.id === node.columnId)?.name ?? 'Coluna removida';
  if (node.kind === 'literal') return node.value === null ? 'Vazio' : typeof node.value === 'boolean' ? node.value ? 'Sim' : 'Não' : `${node.currency ? `${node.currency} ` : ''}${node.value}`;
  return `${node.op}(${node.args.map((arg) => formulaLabel(arg, columns)).join('; ')})`;
}

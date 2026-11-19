// Regras escalares comuns à escrita, literais, filtros e resultados calculados.
import { CONTROL_CHARS_EXCEPT_WHITESPACE, type TableCell, type TableColumn, type FormulaType } from '@aion/shared';
import { DomainError } from '../errors';
import { parseCivilDate } from '../routines/civil-date';

/** Decimal canônico conferido por dígitos, sem conversão intermediária para float. */
export function validDecimal(value: unknown, precision: number, scale: number): value is string {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/.test(value) || value === '-0') return false;
  const [integer = '', fraction = ''] = value.replace(/^-/, '').split('.');
  return fraction.length <= scale && (integer === '0' ? 0 : integer.length) + fraction.length <= precision;
}

/** Data civil usa a fonte gregoriana das rotinas e fórmulas. */
export function validDate(value: string): boolean {
  try { parseCivilDate(value); return true; } catch { return false; }
}

/** Tipos calculados expõem o mesmo domínio escalar dos campos armazenados. */
export function scalarType(column: TableColumn): FormulaType | 'multiselect' | 'relation' {
  return column.type === 'calculated' ? column.resultType : column.type === 'select' ? 'text' : column.type;
}

/** Valida valor escalar sem coerção; links e permissões continuam responsabilidade transacional do serviço. */
export function validateScalar(column: TableColumn, value: TableCell, calculated = false): void {
  if (column.type === 'calculated' && !calculated) throw new DomainError('TABLE_INVALID_VALUE');
  if (value === null) return;
  const type = scalarType(column);
  let valid = false;
  switch (type) {
    case 'text': valid = typeof value === 'string' && value.length <= 8000 && !CONTROL_CHARS_EXCEPT_WHITESPACE.test(value); break;
    case 'number': valid = validDecimal(value, 18, 6); break;
    case 'money': valid = validDecimal(value, 14, 2); break;
    case 'boolean': valid = typeof value === 'boolean'; break;
    case 'multiselect': valid = column.type === 'multiselect' && Array.isArray(value) && new Set(value).size === value.length && value.every((id) => column.options.some((option) => option.id === id)); break;
    case 'date': valid = typeof value === 'string' && validDate(value); break;
    case 'time': valid = typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value); break;
    case 'datetime': valid = typeof value === 'string' && validDate(value.slice(0, 10)) && /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value) && Number.isFinite(Date.parse(value)); break;
    case 'relation': valid = column.type === 'relation' && (column.cardinality === 'one' ? typeof value === 'string' : Array.isArray(value) && new Set(value).size === value.length); break;
  }
  if (column.type === 'select') valid = typeof value === 'string' && column.options.some((option) => option.id === value);
  if (!valid) throw new DomainError('TABLE_INVALID_VALUE');
}

/** Tipagem SQL por allowlist; nomes de colunas/dados nunca viram identificadores ou código SQL. */
export function sqlType(column: TableColumn): string {
  const type = scalarType(column);
  return ({ number: 'numeric', money: 'numeric', boolean: 'boolean', date: 'date', time: 'time', datetime: 'timestamptz', text: 'text', multiselect: 'jsonb', relation: column.type === 'relation' && column.cardinality === 'many' ? 'jsonb' : 'text' })[type];
}

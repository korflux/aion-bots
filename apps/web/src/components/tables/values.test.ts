// Provas das transformações que o formulário e a grade compartilham, com valores extremos e patches parciais.
import type { DataTable, TableColumn } from '@aion/shared';
import { describe, expect, it } from 'vitest';
import { draftPatch, recordDraft } from './record-form';
import { cellLabel, dateTimeInput, decimalInput, fieldInput, parseField, recordLabel } from './values';

const text: TableColumn = { id: '11111111-1111-4111-8111-111111111111', name: 'Nome', type: 'text' };
const number: TableColumn = { ...text, id: '22222222-2222-4222-8222-222222222222', name: 'Quantidade', type: 'number' };
const boolean: TableColumn = { ...text, id: '33333333-3333-4333-8333-333333333333', name: 'Ativo', type: 'boolean' };
const money: TableColumn = { ...text, id: '44444444-4444-4444-8444-444444444444', name: 'Valor', type: 'money', currency: 'BRL' };
const table: DataTable = { id: text.id, name: 'Produtos', description: '', version: 1, schemaVersion: 1, botIds: [], columns: [text, number, boolean, money] };

describe('tabelas: transformações do editor', () => {
  it('usa o primeiro texto preenchido para identificar relações', () => {
    const other: TableColumn = { ...text, id: money.id, name: 'Nome alternativo' };
    expect(recordLabel([text, other], { id: number.id, version: 1, values: { [text.id]: null, [other.id]: 'Cliente nomeado' } }, 'UTC')).toBe('Cliente nomeado');
  });
  it('canoniza por dígitos sem arredondar decimais ou confundir zero e sinal', () => {
    expect(decimalInput('999999999999,99')).toBe('999999999999.99');
    expect(decimalInput('-00012,3400')).toBe('-12.34');
    expect(decimalInput('-0.000')).toBe('0');
    expect(() => decimalInput('1.234,56')).toThrow();
    expect(() => decimalInput('1e6')).toThrow();
    expect(cellLabel(money, '999999999999.99', 'America/Sao_Paulo')).toBe('BRL 999999999999,99');
  });
  it('mantém nulo, falso, zero e texto íntegro distintos', () => {
    expect(cellLabel(boolean, false, 'UTC')).toBe('Não');
    expect(cellLabel(boolean, null, 'UTC')).toBe('Vazio');
    expect(cellLabel(number, '0', 'UTC')).toBe('0');
    expect(parseField(boolean, 'false', 'UTC')).toBe(false);
    expect(parseField(boolean, '', 'UTC')).toBeNull();
    expect(fieldInput(text, 'linha\n' + 'é'.repeat(7994), 'UTC')).toHaveLength(8000);
  });
  it('patch da edição contém só o campo alterado e não apaga vazio existente', () => {
    const record = { id: text.id, version: 3, values: { [text.id]: '', [number.id]: '0', [boolean.id]: false, [money.id]: null } };
    const baseline = recordDraft(table, record, 'UTC');
    expect(draftPatch(table, baseline, baseline, 'UTC', false)).toEqual({});
    expect(draftPatch(table, { ...baseline, [money.id]: '0012,30' }, baseline, 'UTC', false)).toEqual({ [money.id]: '12.3' });
  });
  it('converte datetime no fuso do dono e recusa hora inexistente por DST', () => {
    expect(dateTimeInput('2026-10-10T12:30', 'America/Sao_Paulo')).toBe('2026-10-10T15:30:00.000Z');
    expect(dateTimeInput('2026-01-15T12:30:40', 'Asia/Kolkata')).toBe('2026-01-15T07:00:40.000Z');
    expect(dateTimeInput('2026-10-10T12:30:40.120', 'America/Sao_Paulo')).toBe('2026-10-10T15:30:40.120Z');
    expect(() => dateTimeInput('2026-03-08T02:30', 'America/New_York')).toThrow('não existe');
  });
});

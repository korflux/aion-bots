// Prova dos contratos externos: tipo/configuração, mass assignment e limites antes de qualquer efeito.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { tableColumnInputSchema, tableCreateSchema, tableUpdateSchema, tableWriteSchema, tableFilterSchema, tableFormulaSchema, type FormulaNode } from './tables';

describe('tables contratos', () => {
  it('publica as árvores reais e mantém guardas antes de processar recursão hostil', () => {
    const columnId = randomUUID();
    const filter = { op: 'and', filters: [{ op: 'eq', columnId, value: 'Aberto' }, { op: 'lt', columnId, value: '2026-11-01' }] };
    const formula: FormulaNode = { kind: 'call', op: 'ADD_MONTHS', args: [{ kind: 'literal', type: 'date', value: '2026-10-31' }, { kind: 'literal', type: 'number', value: '1' }] };
    expect(tableFilterSchema.parse(filter)).toEqual(filter);
    expect(tableFormulaSchema.parse(formula)).toEqual(formula);
    for (const schema of [tableFilterSchema, tableFormulaSchema]) {
      const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
      // As variantes ficam no $defs para recursão; não podem virar o antigo objeto vazio de z.custom.
      expect(Object.values(json.$defs ?? {}).some((node) => Array.isArray(node.anyOf) && node.anyOf.length >= 3)).toBe(true);
      /** Cada referência emitida precisa resolver no documento oferecido, inclusive quando a árvore é aninhada. */
      const checkReferences = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        const item = node as Record<string, unknown>;
        if (typeof item.$ref === 'string') {
          expect(item.$ref.startsWith('#/')).toBe(true);
          const resolved = item.$ref.slice(2).split('/').reduce<unknown>((current, key) => (current as Record<string, unknown> | undefined)?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], json);
          expect(resolved).toBeDefined();
        }
        Object.values(item).forEach(checkReferences);
      };
      checkReferences(json);
    }
    expect(tableFilterSchema.safeParse({ kind: 'call', op: 'EQ', args: [] }).success).toBe(false);
    expect(tableFormulaSchema.safeParse({ kind: 'literal', type: 'number', value: 1 }).success).toBe(false);
    expect(tableFilterSchema.safeParse({ op: 'empty', columnId, value: null }).success).toBe(false);
    expect(tableFilterSchema.safeParse({ op: 'and', filters: Array.from({ length: 21 }, () => ({ op: 'eq', columnId, value: 'x' })) }).success).toBe(false);
    let deep: unknown = formula;
    for (let i = 0; i < 20_000; i++) deep = { kind: 'call', op: 'NOT', args: [deep] };
    expect(tableFormulaSchema.safeParse(deep).success).toBe(false);
    const cyclic = { kind: 'call', op: 'NOT', args: [] as unknown[] }; cyclic.args.push(cyclic);
    expect(tableFormulaSchema.safeParse(cyclic).success).toBe(false);
    let deepFilter: unknown = filter;
    for (let i = 0; i < 20_000; i++) deepFilter = { op: 'and', filters: [deepFilter] };
    expect(tableFilterSchema.safeParse(deepFilter).success).toBe(false);
    expect(tableFormulaSchema.safeParse({ kind: 'literal', type: 'text', value: 'x'.repeat(4000) }).success).toBe(false);
  });
  it('aceita somente configuração pertinente ao tipo e recusa campos internos, controles e lotes excessivos', () => {
    const column = randomUUID();
    expect(tableColumnInputSchema.safeParse({ name: 'Preço', type: 'money', currency: 'BRL' }).success).toBe(true);
    for (const input of [
      { name: 'Preço', type: 'money', currency: 'XYZ' },
      { name: 'Texto', type: 'text', currency: 'BRL' },
      { name: 'Nome\u0000', type: 'text' },
      { name: 'Escolha', type: 'select', options: [{ id: column, label: 'A' }, { id: column, label: 'B' }] },
    ]) expect(tableColumnInputSchema.safeParse(input).success).toBe(false);
    const table = { operationId: randomUUID(), name: 'Teste', columns: [{ name: 'A', type: 'text' }] };
    expect(tableCreateSchema.safeParse(table).success).toBe(true);
    const identified = { id: column, name: 'A', type: 'text' };
    expect(tableCreateSchema.safeParse({ ...table, columns: [identified] }).success).toBe(false);
    expect(tableUpdateSchema.safeParse({ operationId: randomUUID(), expectedSchemaVersion: 1, columns: [identified] }).success).toBe(true);
    // IDs de opções são dados da seleção, e não identidades de colunas novas.
    expect(tableCreateSchema.safeParse({ ...table, columns: [{ name: 'Escolha', type: 'select', options: [{ id: column, label: 'A' }] }] }).success).toBe(true);
    expect(tableCreateSchema.safeParse({ ...table, botId: randomUUID() }).success).toBe(false);
    expect(tableCreateSchema.safeParse({ ...table, columns: [{ name: 'A', type: 'text' }, { name: 'a', type: 'text' }] }).success).toBe(false);
    const batch = { operationId: randomUUID(), expectedSchemaVersion: 1, creates: [{ values: { [column]: 'valor' } }] };
    expect(tableWriteSchema.safeParse(batch).success).toBe(true);
    expect(tableWriteSchema.safeParse({ ...batch, creates: Array.from({ length: 101 }, () => ({ values: {} })) }).success).toBe(false);
    expect(tableWriteSchema.safeParse({ ...batch, creates: [{ values: { [column]: { html: 'x' } } }] }).success).toBe(false);
  });
});

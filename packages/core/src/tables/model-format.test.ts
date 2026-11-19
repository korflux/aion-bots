// Forma markdown do `table_query` para o modelo (TAB-03): função pura do resultado gravado, provada sobre fixtures anonimizadas com a estrutura dos dados reais.
// O que cada prova garante: (1) metadados, legenda, cabeçalho, ids curtos únicos, rótulos, nulos vazios e escapes; (2) proporção de tamanho contra o JSON atual;
// (3) a forma é sempre a INTEIRA (o corte no teto e o marcador são de runs/context.ts, provados em context.test.ts); (4) resultado sem os dados da forma (anterior à phase 11, falha) sai como "sem forma".
import { describe, expect, it } from 'vitest';
import type { TableColumn, TableQueryResult } from '@aion/shared';
import { cellDisplay, escapeCell, formatTableQueryForModel, modelColumns, withModelColumns, type StoredTableQuery } from './model-format';
import { isRecordRef, shortRecordIds } from './record-prefix';
import { bigQueryFixture, queryFixtures, uuidOf } from './table-query-fixtures';

/** Teto do pedido ao modelo (CTX-10, phase 11): a forma passa por ele em runs/context.ts, não aqui. */
const LIMIT = 12_000;
const text = (stored: unknown): string => formatTableQueryForModel(JSON.stringify(stored))!;

describe('forma ao modelo sobre as fixtures anonimizadas', () => {
  const [bills] = queryFixtures();

  it('traz metadados, legenda "nome = id", cabeçalho pelos nomes e uma linha por registro, com id curto único, v, rótulos, vazios e escapes', () => {
    const form = formatTableQueryForModel(JSON.stringify(bills!.stored))!;
    const lines = form.split('\n');
    expect(lines[0]).toBe(`totalCount=214 hasMore=true nextCursor=${bills!.legacy.nextCursor}`);
    expect(lines[1]).toBe(`colunas: ${bills!.columns.map((column) => `${column.name} = ${column.id}`).join('; ')}`);
    expect(lines[2]).toBe(`| id | v | ${bills!.columns.map((column) => column.name).join(' | ')} |`);
    expect(lines[3]).toBe(`|${Array(bills!.columns.length + 2).fill('---').join('|')}|`);
    expect(lines).toHaveLength(4 + 56);
    // Id curto: único dentro do resultado, prefixo do id completo, nunca menos de 8 caracteres.
    const shown = lines.slice(4).map((line) => line.split(' | ')[0]!.slice(2));
    expect(new Set(shown).size).toBe(56);
    shown.forEach((id, index) => {
      expect(bills!.legacy.records[index]!.id.startsWith(id)).toBe(true);
      expect(id.length).toBeGreaterThanOrEqual(8);
      expect(isRecordRef(id)).toBe(true);
    });
    // Linha de dados: versão, rótulo no lugar do id da opção, nulo vazio e relação como UUID completo.
    const first = bills!.legacy.records[0]!;
    const cells = lines[4]!.slice(2, -2).split(' | ');
    expect(cells[1]).toBe(String(first.version));
    const status = bills!.columns.find((column) => column.name === 'Situação')!;
    expect(status.type === 'select' && status.options.map((option) => option.label)).toContain(cells[2 + bills!.columns.indexOf(status)]);
    expect(lines.slice(4).some((line) => / \| {2}\| /.test(line))).toBe(true);
    expect(lines.slice(4).some((line) => /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/.test(line.split(' | ').slice(2).join(' | ')))).toBe(true);
    // O texto da observação com "|" aparece escapado e a linha segue com o mesmo número de células.
    const noted = lines.slice(4).find((line) => line.includes('Pago em duas vezes'))!;
    expect(noted).toContain('Pago em duas vezes \\| confirmar com o setor');
    expect(noted.replace(/\\\|/g, '').split(' | ')).toHaveLength(bills!.columns.length + 2);
  });

  it('a soma da forma nova fica em no máximo 30% do JSON atual, pela proporção de caracteres (C1)', () => {
    const sizes = queryFixtures().map((fixture) => ({ name: fixture.name, old: JSON.stringify(fixture.legacy).length, form: formatTableQueryForModel(JSON.stringify(fixture.stored))!.length }));
    const old = sizes.reduce((sum, item) => sum + item.old, 0);
    const form = sizes.reduce((sum, item) => sum + item.form, 0);
    expect(old).toBeGreaterThan(50_000);
    // O resultado mais parecido com os reais (dez colunas) fica bem abaixo da média; o estreito é o pior caso.
    const ratio = (name: string) => { const item = sizes.find((size) => size.name === name)!; return item.form / item.old; };
    expect(ratio('contas')).toBeLessThan(0.3);
    expect(form / old).toBeLessThanOrEqual(0.3);
  });

  it('nomes e rótulos ficam congelados no resultado gravado: renomear coluna ou opção depois só aparece numa consulta nova, e a forma é determinística', () => {
    const stored = JSON.stringify(bills!.stored);
    const first = formatTableQueryForModel(stored)!;
    expect(formatTableQueryForModel(stored)!).toBe(first);
    expect(formatTableQueryForModel(JSON.stringify(JSON.parse(stored)))!).toBe(first);
    // A tabela é renomeada depois da gravação (a coluna "Situação" e todas as opções dela): a forma lê só o texto gravado, então o resultado antigo segue com os
    // nomes e rótulos de quando foi gravado.
    const renamed = bills!.columns.map((column) => (column.name !== 'Situação' || column.type !== 'select' ? column : { ...column, name: 'Situação (nova)', options: column.options.map((option) => ({ ...option, label: `${option.label} (novo)` })) }));
    expect(first).toContain('Situação = ');
    expect(first).not.toContain('(nova)');
    expect(first).toContain('Aberta');
    expect(first).not.toContain('Aberta (novo)');
    // Uma consulta NOVA da mesma tabela, já renomeada, grava e mostra os nomes novos: a mudança só entra por uma gravação nova, nunca reescreve a antiga.
    const after = formatTableQueryForModel(JSON.stringify(withModelColumns(bills!.legacy, renamed)))!;
    expect(after).not.toBe(first);
    expect(after).toContain('Situação (nova) = ');
    expect(after).toContain('Aberta (novo)');
    expect(formatTableQueryForModel(stored)!).toBe(first);
  });
});

describe('forma inteira, sem corte', () => {
  it('uma página cheia (100 registros de dez colunas) passa do teto de 12.000 e mesmo assim volta inteira, com metadados, legenda e as 100 linhas: o corte é de runs/context.ts', () => {
    const big = bigQueryFixture();
    const form = formatTableQueryForModel(JSON.stringify(big.stored))!;
    expect(form.length).toBeGreaterThan(LIMIT);
    const lines = form.split('\n');
    expect(lines[0]).toBe(`totalCount=214 hasMore=true nextCursor=${big.legacy.nextCursor}`);
    expect(lines[1]).toBe(`colunas: ${big.columns.map((column) => `${column.name} = ${column.id}`).join('; ')}`);
    expect(lines[2]).toBe(`| id | v | ${big.columns.map((column) => column.name).join(' | ')} |`);
    expect(lines[3]).toBe(`|${Array(big.columns.length + 2).fill('---').join('|')}|`);
    expect(lines).toHaveLength(4 + 100);
    expect(form).not.toContain('[mostrando');
  });

  it('uma consulta estreita mantém a legenda inteira', () => {
    const narrow = queryFixtures()[2]!;
    const form = formatTableQueryForModel(JSON.stringify(narrow.stored))!;
    expect(form.startsWith('totalCount=1873 hasMore=true nextCursor=')).toBe(true);
    expect(form.split('\n')[1]).toMatch(/^colunas: Título = [0-9a-f-]{36}; Natureza = [0-9a-f-]{36}$/);
  });
});

describe('formas do resultado', () => {
  const columns: TableColumn[] = [
    { id: uuidOf('c:nome'), name: 'Nome | completo', type: 'text' },
    { id: uuidOf('c:fase'), name: 'Fase', type: 'select', options: [{ id: uuidOf('o:a'), label: 'Em análise' }, { id: uuidOf('o:b'), label: 'Concluída' }, { id: uuidOf('o:c'), label: 'Nunca usada' }] },
    { id: uuidOf('c:tags'), name: 'Tags', type: 'multiselect', options: [{ id: uuidOf('t:a'), label: 'urgente' }, { id: uuidOf('t:b'), label: 'revisar' }] },
    { id: uuidOf('c:ok'), name: 'Ok', type: 'boolean' },
    { id: uuidOf('c:calc'), name: 'Calculada', type: 'calculated', formula: { kind: 'literal', type: 'number', value: '1' }, resultType: 'number' },
  ];
  const [name, phase, tags, ok, calc] = columns.map((column) => column.id) as [string, string, string, string, string];

  it('escapa barra, "|" e quebra de linha de forma reversível e mostra rótulos, booleanos, listas e erro de cálculo', () => {
    const result: TableQueryResult = { records: [
      { id: uuidOf('r:1'), version: 3, values: { [name]: 'a|b\nc\\d\r\ne', [phase]: uuidOf('o:a'), [tags]: [uuidOf('t:a'), uuidOf('t:b')], [ok]: true, [calc]: null }, errors: { [calc]: 'DIVISION_BY_ZERO' } },
      { id: uuidOf('r:2'), version: 1, values: { [name]: '', [phase]: uuidOf('o:z'), [tags]: null, [ok]: false, [calc]: '7' } },
    ], nextCursor: null, hasMore: false, totalCount: 2 };
    const lines = text(withModelColumns(result, columns)).split('\n');
    expect(lines[0]).toBe('totalCount=2 hasMore=false');
    expect(lines[2]).toBe('| id | v | Nome \\| completo | Fase | Tags | Ok | Calculada |');
    expect(lines[4]).toBe(`| ${uuidOf('r:1').slice(0, 8)} | 3 | a\\|b\\nc\\\\d\\ne | Em análise | urgente, revisar | true | #DIVISION_BY_ZERO |`);
    // Opção que não existe mais fica como o id gravado; vazio e nulo são células em branco.
    expect(lines[5]).toBe(`| ${uuidOf('r:2').slice(0, 8)} | 1 |  | ${uuidOf('o:z')} |  | false | 7 |`);
    // Só as opções que aparecem nas células vão para o resultado gravado.
    const shown = withModelColumns(result, columns).columns;
    expect(shown.find((column) => column.id === phase)!.labels).toEqual({ [uuidOf('o:a')]: 'Em análise' });
    expect(escapeCell('x|y\\|z\n')).toBe('x\\|y\\\\\\|z\\n');
  });

  it('agregados entram na linha de metadados e o agrupamento vira tabela de grupos sem id nem v', () => {
    const aggregate: TableQueryResult = { records: [], aggregate: { Total: '0.3', Qtd: '2' }, nextCursor: null, hasMore: false, totalCount: 2 };
    expect(text(withModelColumns(aggregate, columns))).toBe('totalCount=2 hasMore=false aggregate={"Total":"0.3","Qtd":"2"}');
    const grouped: TableQueryResult = { records: [], groups: [
      { values: { [phase]: uuidOf('o:a') }, aggregate: { Soma: '10' } },
      { values: { [phase]: null }, aggregate: { Soma: null } },
    ], nextCursor: 'abc', hasMore: true, totalCount: 9 };
    expect(text(withModelColumns(grouped, columns)).split('\n')).toEqual([
      'totalCount=9 hasMore=true nextCursor=abc',
      `colunas: Fase = ${phase}`,
      '| Fase | Soma |',
      '|---|---|',
      '| Em análise | 10 |',
      '|  |  |',
    ]);
  });

  it('só as colunas que o resultado mostra vão para a gravação, com nome; coluna desconhecida cai no id', () => {
    const result: TableQueryResult = { records: [{ id: uuidOf('r:1'), version: 1, values: { [name]: 'x', [uuidOf('c:fora')]: 'y' } }], nextCursor: null, hasMore: false, totalCount: 1 };
    expect(modelColumns(result, columns)).toEqual([{ id: name, name: 'Nome | completo' }, { id: uuidOf('c:fora'), name: uuidOf('c:fora') }]);
    expect(modelColumns({ records: [], nextCursor: null, hasMore: false, totalCount: 0 }, columns)).toEqual([]);
  });

  it('célula: nulo vazio, booleano, lista, rótulo e id desconhecido; nome de propriedade herdada não vira rótulo', () => {
    expect(cellDisplay(null)).toBe('');
    expect(cellDisplay(undefined)).toBe('');
    expect(cellDisplay(false)).toBe('false');
    expect(cellDisplay(['a', 'b'], { a: 'Alfa' })).toBe('Alfa, b');
    expect(cellDisplay('constructor', { a: 'Alfa' })).toBe('constructor');
  });
});

describe('resultado sem a forma', () => {
  const [bills] = queryFixtures();

  it('resultado gravado antes da phase 11 (sem columns), falha da ferramenta e texto que não é o resultado saem como "sem forma"', () => {
    expect(formatTableQueryForModel(JSON.stringify(bills!.legacy))).toBeNull();
    expect(formatTableQueryForModel(JSON.stringify({ code: 'TABLE_ACCESS_DENIED', message: 'Acesso à tabela não permitido.' }))).toBeNull();
    expect(formatTableQueryForModel('Argumentos inválidos (tableId: obrigatório).')).toBeNull();
    expect(formatTableQueryForModel(`${JSON.stringify(bills!.stored)}\n[truncado] gravação cortada em 256 KiB`)).toBeNull();
    expect(formatTableQueryForModel('')).toBeNull();
    const broken = { ...bills!.stored, records: 'não é lista' } as unknown as StoredTableQuery;
    expect(formatTableQueryForModel(JSON.stringify(broken))).toBeNull();
  });
});

describe('id curto', () => {
  it('tem o menor tamanho, a partir de 8, que torna cada id único no conjunto (caractere a caractere, só com o conjunto)', () => {
    const base = 'a1b2c3d4-e5f6-4789-8abc-def012345678';
    const ids = [base, 'a1b2c3d4-e5f6-4789-8abc-def012345679', 'a1b2c3d4-e5f6-4789-9000-000000000000', 'a1b2c3d4-0000-4000-8000-000000000000', 'ffffffff-0000-4000-8000-000000000000'];
    const shown = shortRecordIds(ids);
    // Os dois primeiros só diferem no último caractere: precisam dos 36; o terceiro difere na 20ª posição; o quarto no 10º; o último já difere no 1º.
    expect(shown).toEqual([ids[0], ids[1], ids[2]!.slice(0, 20), ids[3]!.slice(0, 10), 'ffffffff']);
    expect(shortRecordIds([base])).toEqual(['a1b2c3d4']);
    expect(shortRecordIds([])).toEqual([]);
    expect(shortRecordIds(ids.map((id) => id.toUpperCase()))).toEqual(shown);
    // Com os ids das fixtures: único, prefixo e mínimo (um caractere a menos deixaria de ser único ou passaria de 8).
    for (const fixture of queryFixtures()) {
      const full = fixture.legacy.records.map((record) => record.id);
      const prefixes = shortRecordIds(full);
      prefixes.forEach((prefix, index) => {
        expect(full.filter((id) => id.startsWith(prefix))).toEqual([full[index]]);
        if (prefix.length > 8) expect(full.filter((id) => id.startsWith(prefix.slice(0, -1))).length).toBeGreaterThan(1);
      });
    }
  });
});

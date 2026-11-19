// Fixtures sintéticas e anonimizadas de resultados do `table_query`, só para os testes da forma ao modelo (`model-format.test.ts`) e do id curto.
//
// Origem: a ESTRUTURA e a proporção dos resultados reais medidos no estudo de 17/10/2026 (`docs/estudo-reducao-tokens-compactacao.md`: registros de cerca de dez
// colunas, UUID de coluna repetido em todo registro, colunas vazias como `null`, relações como UUID e seleções pelo id da opção). Nenhum dado real entra aqui: os
// ids saem de um hash determinístico de um rótulo sintético e os textos de um léxico genérico, então as fixtures são idênticas em toda execução e sem dado pessoal.
import { createHash } from 'node:crypto';
import type { TableCell, TableColumn, TableQueryResult } from '@aion/shared';
import { withModelColumns, type StoredTableQuery } from './model-format';

/** Um resultado nos dois formatos: o JSON atual do serviço (`legacy`, a referência de tamanho) e o que a ferramenta passa a gravar (`stored`). */
export interface QueryFixture { name: string; columns: TableColumn[]; legacy: TableQueryResult; stored: StoredTableQuery }

/** UUID v4 válido e estável derivado de um rótulo: a fixture nunca depende de `randomUUID`. */
export function uuidOf(label: string): string {
  const hex = createHash('sha256').update(label).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${'89ab'[Number.parseInt(hex[16]!, 16) % 4]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Gerador pseudoaleatório pequeno (mulberry32): variedade estável entre registros sem aleatoriedade real. */
function sequence(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Coluna de seleção com ids de opção estáveis, um por rótulo. */
const select = (table: string, name: string, labels: string[]): TableColumn => ({ id: uuidOf(`col:${table}:${name}`), name, type: 'select', options: labels.map((label) => ({ id: uuidOf(`opt:${table}:${name}:${label}`), label })) });
/** Coluna escalar simples (sem opções nem configuração). */
const plain = (table: string, name: string, type: 'text' | 'number' | 'boolean' | 'date'): TableColumn => ({ id: uuidOf(`col:${table}:${name}`), name, type });
/** Id da opção de um rótulo, como a célula de seleção o guarda. */
const optionId = (column: TableColumn, label: string): string => (column.type === 'select' || column.type === 'multiselect' ? column.options.find((option) => option.label === label)!.id : '');
/** Cursor no formato real do serviço (identidade da consulta e deslocamento em base64url), só para o tamanho e o texto serem fiéis. */
const cursorOf = (table: string, offset: number): string => Buffer.from(JSON.stringify({ query: createHash('sha256').update(`query:${table}`).digest('hex'), offset })).toString('base64url');

/** Monta o resultado cru do serviço (todas as colunas projetadas, `null` onde vazio) e o envelope gravado pela ferramenta. */
function assemble(name: string, columns: TableColumn[], rows: Record<string, TableCell>[], totalCount: number): QueryFixture {
  const records = rows.map((cells, index) => ({ id: uuidOf(`record:${name}:${index}`), version: 1 + (index % 4), values: Object.fromEntries(columns.map((column) => [column.id, cells[column.id] ?? null])) }));
  const legacy: TableQueryResult = { records, nextCursor: totalCount > rows.length ? cursorOf(name, rows.length) : null, hasMore: totalCount > rows.length, totalCount };
  return { name, columns, legacy, stored: withModelColumns(legacy, columns) };
}

/**
 * Contas a pagar: dez colunas (texto, dinheiro, data, booleano, três seleções, relação, observação quase sempre vazia e multisseleção), 56 registros por padrão.
 * `count` maior reaproveita a mesma sequência (os 56 primeiros são idênticos), para a prova do corte ter uma página grande com a estrutura real.
 */
function bills(count = 56): QueryFixture {
  const table = 'contas';
  const next = sequence(11);
  const description = plain(table, 'Descrição', 'text');
  const amount: TableColumn = { id: uuidOf(`col:${table}:Valor`), name: 'Valor', type: 'money', currency: 'BRL' };
  const due = plain(table, 'Vencimento', 'date');
  const paid = plain(table, 'Pago', 'boolean');
  const category = select(table, 'Categoria', ['Moradia', 'Transporte', 'Saúde', 'Lazer', 'Educação', 'Serviços']);
  const status = select(table, 'Situação', ['Aberta', 'Paga', 'Atrasada', 'Cancelada']);
  const method = select(table, 'Forma', ['Boleto', 'Cartão', 'Débito', 'Pix']);
  const supplier: TableColumn = { id: uuidOf(`col:${table}:Fornecedor`), name: 'Fornecedor', type: 'relation', targetTableId: uuidOf('table:fornecedores'), cardinality: 'one' };
  const note = plain(table, 'Observação', 'text');
  const tags: TableColumn = { id: uuidOf(`col:${table}:Etiquetas`), name: 'Etiquetas', type: 'multiselect', options: ['fixa', 'variável', 'parcelada', 'renegociada'].map((label) => ({ id: uuidOf(`opt:${table}:Etiquetas:${label}`), label })) };
  const columns = [description, amount, due, paid, category, status, method, supplier, note, tags];
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const rows = Array.from({ length: count }, (_, index) => {
    const label = pick(['Mensalidade', 'Parcela', 'Fatura', 'Assinatura', 'Taxa']);
    return {
      [description.id]: `${label} do serviço ${String(index + 1).padStart(2, '0')}`,
      [amount.id]: `${Math.floor(next() * 900) + 20}.${pick(['0', '5', '9', '99', '25'])}`.replace(/\.0$/, ''),
      [due.id]: `2026-${String((index % 12) + 1).padStart(2, '0')}-${String((index % 27) + 1).padStart(2, '0')}`,
      [paid.id]: next() > 0.5,
      [category.id]: optionId(category, pick(['Moradia', 'Transporte', 'Saúde', 'Lazer', 'Educação', 'Serviços'])),
      [status.id]: optionId(status, pick(['Aberta', 'Paga', 'Atrasada', 'Cancelada'])),
      [method.id]: next() > 0.3 ? optionId(method, pick(['Boleto', 'Cartão', 'Débito', 'Pix'])) : null,
      [supplier.id]: next() > 0.4 ? uuidOf(`supplier:${Math.floor(next() * 12)}`) : null,
      [note.id]: index % 13 === 4 ? 'Pago em duas vezes | confirmar com o setor' : null,
      [tags.id]: next() > 0.5 ? [optionId(tags, pick(['fixa', 'variável', 'parcelada', 'renegociada']))] : null,
    } satisfies Record<string, TableCell>;
  });
  return assemble(table, columns, rows, 214);
}

/** Cadastro de contatos fictícios: seis colunas, metade delas vazia em boa parte dos registros, 40 registros. */
function contacts(): QueryFixture {
  const table = 'contatos';
  const next = sequence(23);
  const name = plain(table, 'Nome', 'text');
  const kind = select(table, 'Tipo', ['Cliente', 'Parceiro', 'Fornecedor']);
  const phone = plain(table, 'Telefone', 'text');
  const mail = plain(table, 'E-mail', 'text');
  const active = plain(table, 'Ativo', 'boolean');
  const since = plain(table, 'Desde', 'date');
  const columns = [name, kind, phone, mail, active, since];
  const rows = Array.from({ length: 40 }, (_, index) => ({
    [name.id]: `Contato ${String(index + 1).padStart(3, '0')}`,
    [kind.id]: optionId(kind, ['Cliente', 'Parceiro', 'Fornecedor'][Math.floor(next() * 3)]!),
    [phone.id]: next() > 0.5 ? `(00) 0000-${String(1000 + index)}` : null,
    [mail.id]: next() > 0.6 ? `contato${index + 1}@example.com` : null,
    [active.id]: next() > 0.2,
    [since.id]: next() > 0.5 ? `2025-0${(index % 9) + 1}-15` : null,
  }));
  return assemble(table, columns, rows, 40);
}

/** Consulta estreita (duas colunas) de uma tabela grande: o caso de menor ganho, em que o id do registro pesa mais que as chaves repetidas. */
function narrow(): QueryFixture {
  const table = 'lancamentos';
  const next = sequence(37);
  const title = plain(table, 'Título', 'text');
  const kind = select(table, 'Natureza', ['Receita', 'Despesa']);
  const rows = Array.from({ length: 100 }, (_, index) => ({ [title.id]: `Lançamento ${String(index + 1).padStart(4, '0')}`, [kind.id]: optionId(kind, next() > 0.5 ? 'Receita' : 'Despesa') }));
  return assemble(table, [title, kind], rows, 1873);
}

/** Todas as fixtures, na ordem estável usada pelas provas de proporção. */
export const queryFixtures = (): QueryFixture[] => [bills(), contacts(), narrow()];

/** Página cheia (100 registros, o máximo do `table_query`) de dez colunas: a forma passa de 12.000 caracteres, então é a fixture que de fato exercita o corte do teto. Fora de `queryFixtures` para não mudar a proporção da C1. */
export const bigQueryFixture = (): QueryFixture => bills(100);

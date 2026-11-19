// Forma do resultado de `table_query` que o MODELO lê (TAB-03, phase 11): uma tabela markdown no lugar do JSON `records[].values`, em que o id de cada coluna
// se repetia como chave em todo registro (o UUID era 74% do texto). O serviço, a API e a web continuam com o JSON atual; só a apresentação ao modelo muda.
//
// Duas metades, de propósito no mesmo arquivo para o formato ter uma fonte só:
//   1. GRAVAÇÃO (`withModelColumns`): a ferramenta acrescenta ao resultado gravado `columns`, com o nome de cada coluna mostrada e o rótulo das opções de seleção
//      realmente usadas. É o que torna a forma uma função apenas do resultado gravado (decisão 4 da spec): rótulos e nomes de hoje ficam congelados na linha,
//      então renomear uma coluna ou uma opção depois não reescreve o pedido nem quebra o cache do provedor.
//   2. LEITURA (`formatTableQueryForModel`): função pura do texto gravado, sempre a forma INTEIRA. Quem a liga ao pedido, a põe na moldura de dado não confiável
//      (`tableResultBlock`, `runs/untrusted-content.ts`) e aplica o teto de 12.000 caracteres com o marcador de corte e o `messageId` (`runs/context.ts`) é a camada de contexto;
//      `read_activity` pagina esta mesma forma a partir do `offset` do marcador. Por isso aqui não há corte por linhas: um corte próprio faria o `N` do marcador deixar de ser um
//      deslocamento nesta forma. Aqui nada depende de hora, banco ou configuração.
//
// Resultado gravado antes do deploy não tem `columns`: não é reconvertido (a conversão dependeria do estado atual da tabela), e `formatTableQueryForModel`
// devolve `null` ("sem forma") para ele, que então só passa pelo teto de caracteres.
import { z } from 'zod';
import type { TableCell, TableColumn, TableQueryResult } from '@aion/shared';
import { shortRecordIds } from './record-prefix';

/** Coluna mostrada no resultado: nome para o cabeçalho e, nas seleções, o rótulo das opções que aparecem nas células (id da opção -> rótulo). */
export interface ModelColumn { id: string; name: string; labels?: Record<string, string> }
/** Resultado gravado do `table_query`: o envelope do serviço mais as colunas mostradas. */
export type StoredTableQuery = TableQueryResult & { columns: ModelColumn[] };

// ---------------------------------------------------------------------------------------------
// Gravação
// ---------------------------------------------------------------------------------------------

/**
 * Colunas que o resultado realmente mostra (as chaves de `values` da primeira linha ou do primeiro grupo, que são as mesmas em todas), com o nome e, nas
 * seleções, só os rótulos das opções que aparecem nas células. `visible` são as colunas visíveis ao bot no MESMO snapshot da consulta, então nome e rótulo
 * nunca vazam coluna oculta nem divergem do resultado. Sem linhas não há o que mostrar e a lista fica vazia.
 */
export function modelColumns(result: TableQueryResult, visible: readonly TableColumn[]): ModelColumn[] {
  const shown = [...new Set([result.records[0]?.values, result.groups?.[0]?.values].flatMap((values) => (values ? Object.keys(values) : [])))];
  const byId = new Map(visible.map((column) => [column.id, column]));
  const cells = (id: string): TableCell[] => [...result.records.map((record) => record.values[id] ?? null), ...(result.groups ?? []).map((group) => group.values[id] ?? null)];
  return shown.map((id) => {
    const column = byId.get(id);
    if (!column) return { id, name: id };
    if (column.type !== 'select' && column.type !== 'multiselect') return { id, name: column.name };
    const options = new Map(column.options.map((option) => [option.id, option.label]));
    const labels: Record<string, string> = {};
    for (const cell of cells(id)) {
      for (const optionId of Array.isArray(cell) ? cell : typeof cell === 'string' ? [cell] : []) {
        const label = options.get(optionId);
        if (label !== undefined) labels[optionId] = label;
      }
    }
    return Object.keys(labels).length ? { id, name: column.name, labels } : { id, name: column.name };
  });
}

/** O envelope que a ferramenta grava: o resultado do serviço, sem alterá-lo, mais `columns`. */
export function withModelColumns(result: TableQueryResult, visible: readonly TableColumn[]): StoredTableQuery {
  return { ...result, columns: modelColumns(result, visible) };
}

// ---------------------------------------------------------------------------------------------
// Células
// ---------------------------------------------------------------------------------------------

/**
 * Texto de uma célula como o modelo a lê, ainda sem escape: vazio para nulo, `true`/`false` para booleano, rótulo no lugar do id da opção (id desconhecido
 * fica como veio) e listas separadas por vírgula. Também nomeia os candidatos de uma ambiguidade de id curto.
 */
export function cellDisplay(cell: TableCell | undefined, labels?: Readonly<Record<string, string>>): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'boolean') return cell ? 'true' : 'false';
  const label = (value: string): string => (labels && Object.hasOwn(labels, value) ? labels[value]! : value);
  return Array.isArray(cell) ? cell.map(label).join(', ') : label(cell);
}

/**
 * Escape reversível para a célula caber numa linha de tabela markdown: `\` vira `\\`, `|` vira `\|` e a quebra de linha (`\n`, `\r\n` ou `\r`) vira o par
 * `\n`. Escapar a própria barra mantém `\|` e `\n` literais da célula distinguíveis dos escapes.
 */
export const escapeCell = (text: string): string => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '\\n');

// ---------------------------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------------------------

/** O que a leitura espera do resultado gravado; célula como escalar, lista de textos ou nulo (o JSON do serviço), sem os limites de escrita. */
const cellSchema = z.union([z.string(), z.boolean(), z.array(z.string()), z.null()]);
const storedSchema = z.object({
  records: z.array(z.object({ id: z.string(), version: z.number(), values: z.record(z.string(), cellSchema), errors: z.record(z.string(), z.string()).optional() })),
  aggregate: z.record(z.string(), cellSchema).optional(),
  groups: z.array(z.object({ values: z.record(z.string(), cellSchema), aggregate: z.record(z.string(), cellSchema) })).optional(),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  totalCount: z.number(),
  columns: z.array(z.object({ id: z.string(), name: z.string(), labels: z.record(z.string(), z.string()).optional() })),
});

/** Corta em `max` unidades UTF-16 sem deixar a metade de um emoji. */
export function clipUnits(text: string, max: number): string {
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** Linha de tabela markdown; o escape é de quem monta as células. */
const tableRow = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;

/**
 * A forma markdown INTEIRA do resultado gravado de `table_query`, ou `null` ("sem forma") quando o texto não é um resultado com os dados desta forma (resultado anterior à phase 11,
 * falha da ferramenta ou texto cortado): quem chama então aplica só o teto genérico. Função pura do texto, idêntica em toda etapa, retomada e rodada. Não leva moldura nem marcador de
 * corte: ambos são de `runs/context.ts`, que corta no teto por linha (o `N` do marcador é um deslocamento NESTA forma, o mesmo que `read_activity` aceita em `offset`).
 *
 * Linhas, nesta ordem: metadados (`totalCount`, `hasMore`, `nextCursor` quando houver e `aggregate` em JSON); legenda "nome = id" das colunas (o id completo,
 * que `table_write` e os filtros exigem); cabeçalho pelos nomes, com `id` e `v` (versão para `expectedVersion`) à frente nas linhas de registro; as linhas.
 * Registro: `id` curto, o menor prefixo, a partir de 8 caracteres, que o torna único entre os registros do resultado. Agrupamento (`groupBy`): colunas de grupo
 * e agregados, sem `id` nem `v`. Célula com erro de cálculo mostra `#CÓDIGO` (ex.: `#DIVISION_BY_ZERO`); relações seguem como UUID completo (a escrita da
 * célula de relação também aceita o id curto do destino, `TableService.resolveRelationRefs`, mas o que já está gravado não é encurtado aqui).
 * ponytail: ids de relação seguem como UUID completo na tabela; como a escrita já aceita o id curto do destino, encurtá-los aqui seria só uma decisão de custo (precisaria
 * de um tamanho único no DESTINO, que o resultado desta tabela não conhece); avaliar se o relatório de custo mostrar relações dominando o tamanho do resultado.
 */
export function formatTableQueryForModel(stored: string): string | null {
  let json: unknown;
  try { json = JSON.parse(stored); } catch { return null; }
  const parsed = storedSchema.safeParse(json);
  if (!parsed.success) return null;
  const result = parsed.data;
  const columns = result.columns;
  const byGroup = Boolean(result.groups?.length);
  const labelsOf = new Map(columns.map((column) => [column.id, column.labels]));

  const metadata = [`totalCount=${result.totalCount}`, `hasMore=${result.hasMore}`, ...(result.nextCursor ? [`nextCursor=${result.nextCursor}`] : []), ...(result.aggregate ? [`aggregate=${JSON.stringify(result.aggregate)}`] : [])].join(' ');
  let headerCells: string[] = [];
  const rows: string[] = [];
  if (byGroup) {
    const aliases = [...new Set(result.groups!.flatMap((group) => Object.keys(group.aggregate)))];
    headerCells = [...columns.map((column) => escapeCell(column.name)), ...aliases.map(escapeCell)];
    for (const group of result.groups!) {
      rows.push(tableRow([...columns.map((column) => escapeCell(cellDisplay(group.values[column.id], labelsOf.get(column.id)))), ...aliases.map((alias) => escapeCell(cellDisplay(group.aggregate[alias])))]));
    }
  } else if (result.records.length) {
    headerCells = ['id', 'v', ...columns.map((column) => escapeCell(column.name))];
    const ids = shortRecordIds(result.records.map((record) => record.id));
    result.records.forEach((record, index) => {
      rows.push(tableRow([escapeCell(ids[index]!), String(record.version), ...columns.map((column) => {
        const error = record.errors?.[column.id];
        return error ? `#${escapeCell(error)}` : escapeCell(cellDisplay(record.values[column.id], labelsOf.get(column.id)));
      })]));
    });
  }
  const header = headerCells.length ? [tableRow(headerCells), `|${headerCells.map(() => '---').join('|')}|`] : [];
  const legend = columns.length && rows.length ? `colunas: ${columns.map((column) => `${column.name} = ${column.id}`).join('; ')}` : null;
  return [metadata, ...(legend ? [legend] : []), ...header, ...rows].join('\n');
}

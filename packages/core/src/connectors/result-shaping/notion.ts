// Regras do Notion para a limpeza dos resultados de conector (CTX-12, phase 11, T4). Reconhece as ações pelo prefixo `NOTION_` do slug.
//
// O Notion devolve cada página com um envelope grande: um objeto por propriedade com id e tipo, textos como listas de trechos com anotações de estilo, usuários,
// pai, ícone e capa. O que o modelo usa é o valor de cada propriedade. Aqui cada página vira UMA LINHA PLANA (`{ Nome: valor, ..., id, url }`); como todas as
// linhas de uma consulta têm as mesmas colunas, a camada genérica (`generic.ts`) as escreve como tabela markdown. Blocos e outros objetos só perdem o ruído e têm
// os trechos de texto formatado juntados.
//
// O que identifica uma página não é o campo `object` (pode faltar), e sim ter uma propriedade `title` com a lista de trechos: o esquema de um banco de dados
// também tem `properties`, mas a propriedade de título dele tem `title: {}`, e esse não é linha.
//
// Ponto de extensão: um tipo de propriedade novo entra no `switch` de `propertyValue`; o que ele não conhece vira JSON compacto (nada se perde em silêncio).
import { MAX_DEPTH, collapseLine, isPlainObject } from './generic';
import type { ConnectorShaper } from './types';

/** Campos que só descrevem estilo, autoria ou envelope e que o modelo não usa. */
const NOISE_KEYS: ReadonlySet<string> = new Set(['created_by', 'last_edited_by', 'request_id', 'public_url', 'color']);

/** Sinalizadores que só importam quando verdadeiros (`has_children: true` avisa que há blocos filhos a buscar). */
const DROP_WHEN_FALSE: ReadonlySet<string> = new Set(['archived', 'in_trash', 'has_children']);

/** Lista de trechos de texto formatado do Notion: todos com `plain_text`. */
const isRichText = (list: readonly unknown[]): boolean => list.length > 0 && list.every((item) => isPlainObject(item) && typeof item.plain_text === 'string');

/** Trechos juntados em um texto; o destino de um link entra entre parênteses quando o texto não o mostra. */
function richText(list: readonly unknown[]): string {
  return list
    .map((item) => {
      if (!isPlainObject(item) || typeof item.plain_text !== 'string') return '';
      return typeof item.href === 'string' && item.href !== '' && !item.plain_text.includes(item.href) ? `${item.plain_text} (${item.href})` : item.plain_text;
    })
    .join('');
}

/** Lista de objetos do Notion (pessoas, opções, relações, arquivos) reduzida ao campo escolhido por `pick`, em texto separado por vírgula; o que não for texto some e lista inválida dá `''`. */
const names = (list: unknown, pick: (item: Record<string, unknown>) => unknown): string =>
  Array.isArray(list)
    ? list
        .map((item) => (isPlainObject(item) ? pick(item) : undefined))
        .filter((value): value is string => typeof value === 'string' && value !== '')
        .join(', ')
    : '';

/** Como identificar um usuário do Notion para o modelo: o nome, senão o e-mail da pessoa, senão o id (`undefined` se faltarem os três, e quem chama o descarta); o avatar e o resto do envelope não entram. */
const userName = (user: Record<string, unknown>): unknown => user.name ?? (isPlainObject(user.person) ? user.person.email : undefined) ?? user.id;

/**
 * O valor de uma propriedade de página como texto, número ou booleano de uma linha (a célula da tabela). `undefined` quando a propriedade está vazia.
 * Tipos desconhecidos com objeto dentro viram JSON compacto.
 */
function propertyValue(property: unknown): string | number | boolean | undefined {
  if (!isPlainObject(property) || typeof property.type !== 'string') return undefined;
  const type = property.type;
  const raw = property[type];
  switch (type) {
    case 'title':
    case 'rich_text':
      return Array.isArray(raw) ? collapseLine(richText(raw)) : undefined;
    case 'select':
    case 'status':
      return isPlainObject(raw) && typeof raw.name === 'string' ? raw.name : undefined;
    case 'multi_select':
      return names(raw, (item) => item.name);
    case 'date': {
      if (!isPlainObject(raw) || typeof raw.start !== 'string') return undefined;
      return typeof raw.end === 'string' && raw.end !== '' ? `${raw.start} → ${raw.end}` : raw.start;
    }
    case 'people':
      return names(raw, userName);
    case 'created_by':
    case 'last_edited_by': {
      const label = isPlainObject(raw) ? userName(raw) : undefined;
      return typeof label === 'string' ? label : undefined;
    }
    case 'relation':
      return names(raw, (item) => item.id);
    case 'files':
      return names(raw, (item) => item.name);
    case 'unique_id':
      return isPlainObject(raw) && typeof raw.number === 'number' ? `${typeof raw.prefix === 'string' && raw.prefix !== '' ? `${raw.prefix}-` : ''}${raw.number}` : undefined;
    case 'formula':
    case 'rollup':
      return propertyValue(raw);
    case 'array':
      return Array.isArray(raw) ? raw.map(propertyValue).filter((value) => value !== undefined && value !== '').join(', ') : undefined;
    case 'button':
    case 'verification':
      return undefined;
    default:
      if (typeof raw === 'string') return collapseLine(raw);
      if (typeof raw === 'number' || typeof raw === 'boolean') return raw;
      return raw === null || raw === undefined ? undefined : JSON.stringify(raw);
  }
}

/** É uma página (linha de banco ou página avulsa)? Ver o comentário do arquivo. */
function isPage(value: Record<string, unknown>): boolean {
  if (value.object === 'database' || !isPlainObject(value.properties)) return false;
  return Object.values(value.properties).some((property) => isPlainObject(property) && property.type === 'title' && Array.isArray(property.title));
}

/** Nome livre para uma coluna do sistema (`id`, `url`) quando uma propriedade do usuário já usa o nome. */
const freeKey = (taken: ReadonlySet<string>, wanted: string): string => (taken.has(wanted) ? `${wanted} (página)` : wanted);

/** A página como uma linha plana: o título primeiro, depois as outras propriedades na ordem em que vieram e, no fim, `id`, `url` e a última edição. */
function pageToRow(page: Record<string, unknown>): Record<string, unknown> {
  const properties = isPlainObject(page.properties) ? page.properties : {};
  const titleName = Object.keys(properties).find((key) => {
    const property = properties[key];
    return isPlainObject(property) && property.type === 'title';
  });
  const order = titleName === undefined ? Object.keys(properties) : [titleName, ...Object.keys(properties).filter((key) => key !== titleName)];
  const entries: [string, unknown][] = [];
  for (const name of order) {
    const value = propertyValue(properties[name]);
    if (value !== undefined && value !== '') entries.push([collapseLine(name) || '_', value]);
  }
  const taken = new Set(entries.map(([key]) => key));
  for (const [source, label] of [['id', 'id'], ['url', 'url'], ['last_edited_time', 'last_edited_time']] as const) {
    const value = page[source];
    if (typeof value === 'string' && value !== '') entries.push([freeKey(taken, label), value]);
  }
  return Object.fromEntries(entries);
}

/** Percorre o resultado: páginas viram linhas, listas de trechos viram texto e o ruído de envelope sai. */
function walk(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) return isRichText(value) ? richText(value) : value.map((item) => walk(item, depth + 1));
  if (!isPlainObject(value)) return value;
  if (isPage(value)) return pageToRow(value);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, item]) => !NOISE_KEYS.has(key) && !(DROP_WHEN_FALSE.has(key) && item === false))
      .map(([key, item]) => [key, walk(item, depth + 1)]),
  );
}

/** O Notion no índice: reconhece as ações pelo prefixo `NOTION_`. */
export const notionShaper: ConnectorShaper = {
  connector: 'notion',
  actionPrefixes: ['NOTION_'],
  shape: (_actionSlug, data) => walk(data, 0),
};

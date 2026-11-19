// Camada GENÉRICA da limpeza dos resultados de conector (CTX-12, phase 11, T4): vale para qualquer conector, com ou sem arquivo próprio.
//
// Entrada: o resultado gravado já lido como JSON (ou o texto cru, quando não é JSON). Saída: o texto que o modelo lê. A limpeza é só TEXTUAL e PURA:
// nada é executado, nada depende de hora, rede ou estado do conector. Isso garante a forma estável que o cache de prefixo exige (spec, decisão 4).
//
// Fluxo de `renderGeneric(valor)`:
//   1. `cleanTree`: texto a texto (base64 longo vira marcador do tamanho, HTML vira texto, invisíveis e linhas em branco sobrando saem), depois remove
//      nulos, textos vazios, listas vazias e objetos vazios.
//   2. `dedupeRepeatedText`: texto longo que repete (ou já está contido em) outro texto longo do mesmo resultado sai, com marcador do tamanho.
//   3. `renderValue`: escreve em linhas `chave: valor` com recuo; lista uniforme de objetos rasos vira tabela markdown; URLs nunca são tocadas.
// Para texto que não é JSON (ou JSON truncado pelos 256 KiB da gravação) vale só `cleanString`.
//
// Pontos de extensão: os arquivos de conector (`gmail.ts`, `notion.ts`) reduzem o JSON ANTES desta camada e reutilizam `isPlainObject`, `collapseLine` e
// `MAX_DEPTH`; nada aqui conhece um conector específico.

/** Profundidade máxima percorrida; abaixo disso o ramo vira um aviso, para uma entrada aninhada ao extremo nunca estourar a pilha. */
export const MAX_DEPTH = 64;

const DEPTH_MARKER = '[estrutura muito aninhada omitida]';
const BASE64_MIN_CHARS = 200;
const REPEAT_MIN_CHARS = 200;
const REPEAT_COMPARE_MAX = 200;
const TABLE_MIN_ROWS = 2;
const TABLE_MAX_COLUMNS = 25;
const TABLE_MIN_FILL = 0.4;
const INLINE_LIST_MAX_ITEMS = 30;
const INLINE_LIST_MAX_CHARS = 240;
const LINK_STACK_MAX = 20;
const LINK_TEXT_MAX = 2_000;

/** Objeto simples do JSON (nem nulo, nem lista). Compartilhado com os arquivos de conector. */
export const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Texto numa linha só: qualquer sequência de espaços e quebras vira um espaço. */
export const collapseLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Valor que cabe numa célula ou linha só (texto, número ou booleano); é o que separa uma lista de objetos rasos (tabela) de uma estrutura aninhada (blocos). */
const isScalar = (value: unknown): value is string | number | boolean => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Leitura do JSON gravado
// ---------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Inteiro de 16 dígitos ou mais volta como TEXTO com os dígitos originais: o número do JavaScript perde precisão acima de 2^53, e um id (de mensagem, de
 * usuário) alterado levaria o bot a agir sobre o registro errado. `context.source` é o texto original do número (Node 21 ou superior).
 */
const keepLongIntegers = (_key: string, value: unknown, context?: { source?: string }): unknown =>
  typeof value === 'number' && context?.source !== undefined && /^-?\d{16,}$/.test(context.source) ? context.source : value;

/** Lê o resultado gravado como JSON; `undefined` quando não é JSON válido (texto livre ou JSON truncado pela gravação), sem lançar. */
export function parseStoredJson(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text, keepLongIntegers) as unknown };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Texto: base64, HTML, espaços
// ---------------------------------------------------------------------------------------------------------------------------------------------

const BASE64_BODY = /^[A-Za-z0-9+/_-]+={0,2}$/;
const DATA_URI_BASE64 = /(data:[\w.+-]+\/[\w.+-]+;base64,)[A-Za-z0-9+/_=-]{200,}/g;
const INVISIBLE = new RegExp(`[${[0x00ad, 0x034f, 0x200b, 0x200c, 0x2060, 0xfeff].map((code) => String.fromCodePoint(code)).join('')}]`, 'g');

/** Marcador que substitui um blob base64 omitido, com o tamanho para o modelo saber o que havia. */
export const base64Marker = (chars: number): string => `[base64 omitido: ${chars} caracteres]`;

/** Marcador que substitui um texto longo repetido (ou já contido em outro texto do mesmo resultado), com o tamanho, como `base64Marker` faz com um blob. */
const repeatMarker = (chars: number): string => `[texto repetido omitido: ${chars} caracteres]`;

/**
 * O texto inteiro é um blob base64 (padrão ou URL-safe, com ou sem quebras de linha MIME)? Exige tamanho mínimo, nenhum espaço e ao menos duas das três classes
 * (maiúsculas, minúsculas, dígitos), para um texto corrido ou um identificador comprido de uma classe só não ser confundido com binário.
 * ponytail: um blob de uma classe só (por exemplo, só "A" de um binário zerado) não é reconhecido; o teto do pedido o corta de qualquer forma, tratar se aparecer.
 */
function isBase64Blob(text: string): boolean {
  if (text.length < BASE64_MIN_CHARS) return false;
  const body = text.replace(/[\r\n]+/g, '');
  if (body.length < BASE64_MIN_CHARS || !BASE64_BODY.test(body)) return false;
  return [/[A-Z]/, /[a-z]/, /\d/].filter((kind) => kind.test(body)).length >= 2;
}

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map(
  Object.entries({
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
    copy: '©', reg: '®', trade: '™', bull: '•', middot: '·', euro: '€', deg: '°', ordm: 'º', ordf: 'ª',
    aacute: 'á', Aacute: 'Á', agrave: 'à', Agrave: 'À', acirc: 'â', Acirc: 'Â', atilde: 'ã', Atilde: 'Ã', ccedil: 'ç', Ccedil: 'Ç', eacute: 'é', Eacute: 'É', ecirc: 'ê',
    Ecirc: 'Ê', iacute: 'í', Iacute: 'Í', oacute: 'ó', Oacute: 'Ó', ocirc: 'ô', Ocirc: 'Ô', otilde: 'õ', Otilde: 'Õ', uacute: 'ú', Uacute: 'Ú', uuml: 'ü', Uuml: 'Ü',
  }),
);

/** Entidades HTML nomeadas (as comuns em e-mail em português) e numéricas; as desconhecidas ficam como vieram. */
function decodeEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      const printable = code === 9 || code === 10 || (code >= 32 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff));
      return printable ? String.fromCodePoint(code) : '';
    }
    return NAMED_ENTITIES.get(body) ?? match;
  });
}

const HTML_TAG =
  /<\/?(?:html|head|body|div|p|span|table|tbody|thead|tr|td|th|a|br|hr|img|style|script|ul|ol|li|h[1-6]|font|center|strong|em|b|i|u|blockquote|section|article|header|footer|meta|title|link)\b[^<>]*>/gi;

/**
 * O texto é HTML? Começa com doctype ou traz ao menos duas tags conhecidas (um `<b>` isolado numa frase não conta). Pega também o HTML solto no meio de uma frase,
 * como a descrição de um evento de agenda ("Sala azul<br>Levar <b>notebook</b>").
 * ponytail: um trecho de código HTML dentro de um texto comum (e-mail de desenvolvedor, bloco de código do Notion) também é convertido em texto; o original segue
 * íntegro em `read_activity`. Exigir mais indícios de documento HTML se isso atrapalhar um caso real.
 */
function looksLikeHtml(text: string): boolean {
  if (/^\s*<!doctype html/i.test(text)) return true;
  let count = 0;
  for (const _ of text.matchAll(HTML_TAG)) if (++count >= 2) return true;
  return false;
}

/** Remove os blocos `<tag ...>...</tag>` (estilo, script, cabeçalho) sem regex de retrocesso; bloco sem fechamento fica, e suas tags saem depois. */
function removeBlocks(html: string, tag: string): string {
  const open = new RegExp(`<${tag}(?=[\\s>/])`, 'gi');
  const close = new RegExp(`</${tag}\\s*>`, 'gi');
  let out = '';
  let position = 0;
  for (;;) {
    open.lastIndex = position;
    const start = open.exec(html);
    if (start === null) break;
    close.lastIndex = start.index;
    const end = close.exec(html);
    if (end === null) break;
    out += html.slice(position, start.index);
    position = end.index + end[0].length;
  }
  return out + html.slice(position);
}

/** Remove os comentários `<!-- ... -->` (inclusive os condicionais do Outlook); comentário sem fechamento vale até o fim, como no navegador. */
function removeComments(html: string): string {
  let out = '';
  let position = 0;
  for (;;) {
    const start = html.indexOf('<!--', position);
    if (start === -1) break;
    out += html.slice(position, start);
    const end = html.indexOf('-->', start + 4);
    if (end === -1) return out;
    position = end + 3;
  }
  return out + html.slice(position);
}

/** Valor de um atributo (`href`, `alt`) já decodificado, ou `undefined`. */
function attributeValue(attributes: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attributes);
  const raw = match?.[1] ?? match?.[2] ?? match?.[3];
  return raw === undefined ? undefined : decodeEntities(raw).trim();
}

/** Blocos que só pedem uma quebra de linha; `PARAGRAPH_TAGS` fecham com uma linha em branco. */
const BLOCK_TAGS: ReadonlySet<string> = new Set(['div', 'tr', 'table', 'ul', 'ol', 'li', 'section', 'article', 'header', 'footer', 'pre']);
const PARAGRAPH_TAGS: ReadonlySet<string> = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote']);
const LINK_SCHEME = /^(?:https?:|mailto:|tel:)/i;

/** Garante que o texto termina no começo de uma linha (sem acrescentar quebra se já está lá). */
const startNewLine = (text: string): string => (text === '' || text.endsWith('\n') ? text : `${text}\n`);

/** Garante uma linha em branco no fim do texto (parágrafo e títulos). */
const endParagraph = (text: string): string => (text === '' || text.endsWith('\n\n') ? text : text.endsWith('\n') ? `${text}\n` : `${text}\n\n`);

/**
 * HTML em texto: tira estilo, script, cabeçalho e comentários, troca quebras e blocos por linhas, mantém o destino dos links (`rótulo (URL)`, sem repetir quando
 * o rótulo já é a URL) e o texto alternativo das imagens, decodifica as entidades e junta os espaços. É varredura por tags, não um parser: nada é executado.
 * Como no navegador, o espaço em branco do código-fonte (quebras e recuos entre tags) vale um espaço só; as quebras do texto vêm das tags.
 * As entidades são decodificadas UMA ÚNICA vez, no ponto em que cada pedaço entra em `out` (texto entre tags e `tail` aqui; `href` e `alt` em `attributeValue`):
 * `out` só guarda texto já decodificado e nunca é decodificado de novo. Decodificar o resultado final duplicava a decodificação de `href` e `alt` e transformava
 * `&amp;amp;copy;` (o texto literal `&amp;copy;`) em `&copy;` e depois em `©`.
 * ponytail: HTML muito malformado (atributo com ">" dentro de aspas) pode deixar fragmento de tag no texto, e `<pre>` perde a formatação; trocar por um parser de HTML se aparecer lixo recorrente.
 */
function htmlToText(html: string): string {
  let source = removeComments(html);
  for (const tag of ['head', 'style', 'script', 'title']) source = removeBlocks(source, tag);
  source = source.replace(/<[!?][^<>]*>/g, '').replace(/\s+/g, ' ');
  let out = '';
  let last = 0;
  const links: { href: string | undefined; at: number }[] = [];
  for (const match of source.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^<>]*)>/g)) {
    const between = decodeEntities(source.slice(last, match.index));
    out += out === '' || out.endsWith('\n') ? between.trimStart() : between;
    last = match.index + match[0].length;
    const closing = match[1] === '/';
    const name = (match[2] ?? '').toLowerCase();
    const attributes = match[3] ?? '';
    if (name === 'a') {
      if (!closing) {
        if (links.length < LINK_STACK_MAX) links.push({ href: attributeValue(attributes, 'href'), at: out.length });
      } else {
        const link = links.pop();
        // Link comprido demais para ser um rótulo (âncora esquecida aberta) não acrescenta destino: evita varredura quadrática.
        if (link?.href !== undefined && LINK_SCHEME.test(link.href) && out.length - link.at <= LINK_TEXT_MAX && !out.slice(link.at).includes(link.href)) out += ` (${link.href})`;
      }
    } else if (name === 'img') {
      const alt = attributeValue(attributes, 'alt');
      if (alt) out += alt;
    } else if (name === 'br' || name === 'hr') out += '\n';
    else if (name === 'li' && !closing) out = `${startNewLine(out)}- `;
    else if ((name === 'td' || name === 'th') && closing) out += ' ';
    else if (PARAGRAPH_TAGS.has(name)) out = closing ? endParagraph(out) : startNewLine(out);
    else if (BLOCK_TAGS.has(name)) out = startNewLine(out);
  }
  const tail = decodeEntities(source.slice(last));
  out += out === '' || out.endsWith('\n') ? tail.trimStart() : tail;
  return out
    .replaceAll(String.fromCodePoint(0xa0), ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .join('\n');
}

/** Quebras de linha padronizadas, invisíveis (largura zero e hífen suave, usados como enchimento em e-mail de marketing) fora, espaço no fim das linhas fora e no máximo uma linha em branco seguida. */
function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Limpa UM texto: blob base64 inteiro vira marcador; base64 embutido em `data:...;base64,` também; HTML vira texto; o resto só tem os espaços normalizados.
 * URLs passam intactas por todos os passos. Texto sem nada a limpar sai igual (salvo espaços no fim das linhas).
 */
export function cleanString(raw: string): string {
  const whole = raw.trim();
  if (isBase64Blob(whole)) return base64Marker(whole.replace(/[\r\n]+/g, '').length);
  let text = raw.replace(DATA_URI_BASE64, (match, prefix: string) => `${prefix}${base64Marker(match.length - prefix.length)}`);
  if (looksLikeHtml(text)) text = htmlToText(text);
  return normalizeText(text);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Árvore: limpeza e repetição
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** Limpa os textos e remove tudo o que ficou vazio; `undefined` significa "não há nada aqui". `false` e `0` são dados e ficam. */
function cleanTree(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const text = cleanString(value);
    return text === '' ? undefined : text;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth > MAX_DEPTH) return DEPTH_MARKER;
  if (Array.isArray(value)) {
    const items = value.map((item) => cleanTree(item, depth + 1)).filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
      .map(([key, item]) => [key, cleanTree(item, depth + 1)] as const)
      .filter(([, item]) => item !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }
  return String(value);
}

/** Reconstrói a árvore aplicando `fn` a cada texto na ordem do documento (objeto na ordem das chaves, lista na ordem dos itens). */
function mapStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, fn)]));
  return value;
}

/**
 * Quais textos longos são redundantes: aquele que já aparece inteiro dentro de outro texto longo (a prévia que repete o início do corpo, o mesmo corpo em dois
 * campos). Entre iguais fica o primeiro do documento.
 * ponytail: a comparação por inclusão é quadrática e só roda até `REPEAT_COMPARE_MAX` textos longos; acima disso vale só a igualdade exata, que é linear. Revisar se
 * um conector devolver centenas de textos longos que repetem partes uns dos outros.
 */
function redundantTexts(longs: readonly string[]): boolean[] {
  if (longs.length <= REPEAT_COMPARE_MAX) {
    return longs.map((text, index) => longs.some((other, otherIndex) => otherIndex !== index && other.length >= text.length && (other.length > text.length || otherIndex < index) && other.includes(text)));
  }
  const seen = new Set<string>();
  return longs.map((text) => {
    const repeated = seen.has(text);
    seen.add(text);
    return repeated;
  });
}

/** Troca por marcador os textos longos redundantes (ver `redundantTexts`); a árvore sem repetição volta a mesma. */
function dedupeRepeatedText(value: unknown): unknown {
  const longs: string[] = [];
  mapStrings(value, (text) => {
    if (text.length >= REPEAT_MIN_CHARS) longs.push(text);
    return text;
  });
  if (longs.length < 2) return value;
  const redundant = redundantTexts(longs);
  if (!redundant.includes(true)) return value;
  let index = 0;
  return mapStrings(value, (text) => {
    if (text.length < REPEAT_MIN_CHARS) return text;
    const omit = redundant[index] === true;
    index += 1;
    return omit ? repeatMarker(text.length) : text;
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Escrita em texto
// ---------------------------------------------------------------------------------------------------------------------------------------------

interface Table {
  columns: string[];
  rows: Record<string, unknown>[];
}

/**
 * A lista é uma tabela? Pede ao menos 2 itens, todos objetos rasos (só texto de uma linha, número ou booleano), no máximo 25 colunas no conjunto e as células
 * preenchidas em pelo menos 40% da grade: uma lista esparsa ou com texto de várias linhas lê melhor como blocos.
 */
function asTable(list: readonly unknown[]): Table | undefined {
  if (list.length < TABLE_MIN_ROWS) return undefined;
  const columns: string[] = [];
  const known = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  let filled = 0;
  for (const item of list) {
    if (!isPlainObject(item)) return undefined;
    for (const [key, value] of Object.entries(item)) {
      if (!isScalar(value) || (typeof value === 'string' && value.includes('\n'))) return undefined;
      if (!known.has(key)) {
        known.add(key);
        columns.push(key);
        if (columns.length > TABLE_MAX_COLUMNS) return undefined;
      }
      filled += 1;
    }
    rows.push(item);
  }
  return columns.length > 0 && filled / (rows.length * columns.length) >= TABLE_MIN_FILL ? { columns, rows } : undefined;
}

/** Célula em markdown: uma linha só e `|` escapado (a única razão para uma URL com `|` mudar, o padrão do markdown). */
const cell = (value: unknown): string => (value === undefined ? '' : collapseLine(String(value)).replaceAll('|', '\\|'));

/** A tabela como linhas markdown: cabeçalho, separador e uma linha por item (célula ausente fica vazia); as colunas seguem a ordem em que apareceram. */
const tableLines = ({ columns, rows }: Table): string[] => [
  `| ${columns.map(cell).join(' | ')} |`,
  `|${columns.map(() => '---').join('|')}|`,
  ...rows.map((row) => `| ${columns.map((column) => cell(row[column])).join(' | ')} |`),
];

/** Lista curta de textos de uma linha sem vírgula, que cabe numa linha só (`labelIds: INBOX, UNREAD`), ou `undefined`. */
function inlineList(list: readonly unknown[]): string | undefined {
  if (list.length > INLINE_LIST_MAX_ITEMS) return undefined;
  const parts: string[] = [];
  for (const item of list) {
    if (!isScalar(item)) return undefined;
    const text = String(item);
    if (text.includes('\n') || text.includes(',')) return undefined;
    parts.push(text);
  }
  const joined = parts.join(', ');
  return joined.length <= INLINE_LIST_MAX_CHARS ? joined : undefined;
}

/** `cabeça valor` numa linha; texto de várias linhas vira `cabeça |` e as linhas recuadas por baixo (como o bloco literal do YAML). */
function scalarLines(head: string, text: string, pad: string): string[] {
  if (!text.includes('\n')) return [`${head} ${text}`];
  return [`${head} |`, ...text.split('\n').map((line) => (line === '' ? '' : `${pad}  ${line}`))];
}

/** Uma entrada `chave` de um objeto: valor simples na linha, lista em linha/tabela/itens e objeto recuado. */
function entryLines(key: string, value: unknown, pad: string): string[] {
  if (isScalar(value)) return scalarLines(`${pad}${key}:`, String(value), pad);
  if (Array.isArray(value)) {
    const inline = inlineList(value);
    if (inline !== undefined) return [`${pad}${key}: ${inline}`];
    const table = asTable(value);
    if (table) return [`${pad}${key} (${value.length}):`, ...tableLines(table).map((line) => `${pad}  ${line}`)];
    return [`${pad}${key} (${value.length}):`, ...arrayLines(value, `${pad}  `)];
  }
  if (isPlainObject(value)) return [`${pad}${key}:`, ...objectLines(value, `${pad}  `)];
  return [`${pad}${key}: ${String(value)}`];
}

/** Um objeto como linhas `chave: valor` no recuo `pad`, uma entrada após a outra (par recursivo de `entryLines`); chave vazia vira `_` para a linha nunca ficar sem rótulo. */
function objectLines(object: Record<string, unknown>, pad: string): string[] {
  return Object.entries(object).flatMap(([key, value]) => entryLines(collapseLine(key) || '_', value, pad));
}

/** Itens de uma lista como `- valor`; item objeto ou lista abre com `- ` na primeira linha e segue recuado (como o YAML). */
function arrayLines(list: readonly unknown[], pad: string): string[] {
  const lines: string[] = [];
  for (const item of list) {
    if (isScalar(item)) {
      lines.push(...scalarLines(`${pad}-`, String(item), pad));
      continue;
    }
    const child = Array.isArray(item) ? arrayLines(item, `${pad}  `) : isPlainObject(item) ? objectLines(item, `${pad}  `) : [`${pad}  ${String(item)}`];
    const [first, ...rest] = child;
    if (first !== undefined) lines.push(`${pad}- ${first.slice(pad.length + 2)}`, ...rest);
  }
  return lines;
}

/** O valor limpo como texto: tabela quando a raiz é uma lista uniforme, linhas `chave: valor` para objetos e itens para listas. */
function renderValue(value: unknown): string {
  if (isScalar(value)) return String(value);
  if (Array.isArray(value)) {
    const table = asTable(value);
    return (table ? tableLines(table) : arrayLines(value, '')).join('\n');
  }
  if (isPlainObject(value)) return objectLines(value, '').join('\n');
  return '';
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Entradas da camada
// ---------------------------------------------------------------------------------------------------------------------------------------------

/**
 * A camada genérica sobre um valor JSON: limpa, tira o texto longo repetido e escreve o texto final. Devolve texto vazio quando não sobra nada (resultado só de nulos
 * e vazios); quem chama decide o que mostrar nesse caso.
 */
export function renderGeneric(value: unknown): string {
  const cleaned = cleanTree(value, 0);
  return cleaned === undefined ? '' : renderValue(dedupeRepeatedText(cleaned));
}

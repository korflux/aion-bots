// Entrada isolada para documentos e planilhas não confiáveis. Não escreve logs nem abre rede.
import { parentPort, workerData } from 'node:worker_threads';
import { Unzip, UnzipInflate } from 'fflate';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { definePDFJSModule, getDocumentProxy } from 'unpdf';

const EXPANDED_LIMIT = 50 * 1024 * 1024;
const TEXT_LIMIT = 500_000;
/** Orçamento da planilha (phase 4, ATT-01, Suposição 31): descompactada até 100 MB e até 10.000 entradas, contra zip bomb. */
const SPREADSHEET_EXPANDED_LIMIT = 100 * 1024 * 1024;
const SPREADSHEET_ENTRY_LIMIT = 10_000;
/** `[Content_Types].xml` real tem poucos KB; o teto evita acumular uma entrada inflada inteira na memória da thread. */
const CONTENT_TYPES_LIMIT = 1024 * 1024;
const SPREADSHEET_MAIN = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
const END_RECORD = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

/** Recusa por tipo (não é planilha ou tem macro): vira `ATTACHMENT_TYPE_UNSUPPORTED`; qualquer outro erro vira `ATTACHMENT_UNREADABLE`. */
class TypeRefusal extends Error {}

/** Posição do registro final do ZIP; um ZIP completo precisa dele, não só de cabeçalhos locais fabricados. */
function endRecord(bytes: Uint8Array): number {
  const start = Math.max(0, bytes.length - 65557);
  const found = Buffer.from(bytes.subarray(start)).lastIndexOf(END_RECORD);
  if (found < 0) throw new Error('zip');
  return start + found;
}

/** Decodificação fatal: bytes inválidos e NUL não podem chegar ao PostgreSQL. */
function utf8(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\0')) throw new Error('invalid');
  return text;
}

/** Descompacta incrementalmente, medindo a saída real de TODAS as entradas, sem extrair no disco. */
function docx(bytes: Uint8Array): string {
  endRecord(bytes);
  let expanded = 0;
  let document: Uint8Array[] | null = null;
  let contentTypes: Uint8Array[] | null = null;
  let completedDocument = false;
  const unzip = new Unzip((file) => {
    if ((file.originalSize ?? 0) > EXPANDED_LIMIT) throw new Error('limit');
    const chunks: Uint8Array[] = [];
    const isDocument = file.name === 'word/document.xml';
    const isTypes = file.name === '[Content_Types].xml';
    if (isDocument && document !== null) throw new Error('duplicate');
    if (isDocument) document = chunks;
    if (isTypes) { if (contentTypes !== null) throw new Error('duplicate'); contentTypes = chunks; }
    file.ondata = (error, data, final) => {
      if (error) throw new Error('zip');
      expanded += data.length;
      if (expanded > EXPANDED_LIMIT) { file.terminate(); throw new Error('limit'); }
      if (isDocument || isTypes) chunks.push(data);
      if (isDocument && final) completedDocument = true;
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  // Pequenos blocos limitam a alocação de um inflate malicioso antes da conferência de orçamento.
  for (let at = 0; at < bytes.length; at += 1024) unzip.push(bytes.subarray(at, at + 1024), at + 1024 >= bytes.length);
  if (!document || !completedDocument || !contentTypes) throw new Error('docx');
  const types = utf8(Buffer.concat(contentTypes));
  if (!types.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')) throw new Error('docx');
  const xml = utf8(Buffer.concat(document));
  if (!xml.includes('http://schemas.openxmlformats.org/wordprocessingml/2006/main')) throw new Error('docx');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('xml');
  const tree: unknown = new XMLParser({ preserveOrder: true, ignoreAttributes: true, processEntities: false, trimValues: false, parseTagValue: false }).parse(xml);
  const output: string[] = [];
  /** Percorre a ordem XML, conservando texto de runs e divisores de parágrafos/tabelas. */
  const walk = (node: unknown, inText = false): void => {
    if (Array.isArray(node)) { for (const child of node) walk(child, inText); return; }
    if (!node || typeof node !== 'object') return;
    for (const [tag, value] of Object.entries(node)) {
      if (tag === '#text' && inText) output.push(String(value));
      else if (tag === 'w:tab') output.push('\t');
      else if (tag === 'w:br') output.push('\n');
      else { walk(value, tag === 'w:t'); if (tag === 'w:p' || tag === 'w:tr') output.push('\n'); }
    }
  };
  walk(tree);
  // Apenas entidades XML predefinidas e numéricas; DTD e expansão personalizada foram recusados acima.
  return output.join('').replace(/&(?:amp|lt|gt|quot|apos);|&#(?:x[0-9a-f]+|[0-9]+);/gi, (entity) => {
    const fixed: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
    if (fixed[entity]) return fixed[entity];
    const code = entity.startsWith('&#x') ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  });
}

/**
 * Diretório central da planilha: é o índice que o leitor do Python (`zipfile`/openpyxl) usa, então o número de entradas e a soma dos tamanhos
 * descompactados declarados nele precisam caber no orçamento, e o total precisa bater com as entradas locais percorridas (um diretório que
 * aponta várias vezes para os mesmos bytes, a zip bomb sobreposta, não passa). ZIP64 é recusado: planilha de até 15 MB não precisa dele.
 */
function centralEntries(bytes: Uint8Array): number {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = endRecord(bytes);
  if (end + 22 > view.length) throw new Error('zip');
  const count = view.readUInt16LE(end + 10);
  const size = view.readUInt32LE(end + 12);
  const offset = view.readUInt32LE(end + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff || offset + size > end) throw new Error('zip');
  if (count > SPREADSHEET_ENTRY_LIMIT) throw new Error('limit');
  let at = offset; let declared = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > offset + size || view.readUInt32LE(at) !== 0x02014b50) throw new Error('zip');
    const compressed = view.readUInt32LE(at + 20); const expanded = view.readUInt32LE(at + 24);
    if (compressed === 0xffffffff || expanded === 0xffffffff) throw new Error('zip');
    declared += expanded;
    if (declared > SPREADSHEET_EXPANDED_LIMIT) throw new Error('limit');
    at += 46 + view.readUInt16LE(at + 28) + view.readUInt16LE(at + 30) + view.readUInt16LE(at + 32);
  }
  return count;
}

/**
 * Valida uma planilha `.xlsx` sem extrair texto (phase 4, ATT-01). Descompacta incrementalmente TODAS as entradas medindo a saída real (o
 * tamanho declarado pode mentir), conta as entradas locais, exige o tipo de conteúdo da pasta de trabalho `spreadsheetml` e recusa macros
 * (`.xlsm` renomeado: tipo `macroEnabled` ou `vbaProject.bin`). Nada é gravado em disco; só `[Content_Types].xml` é guardado em memória.
 */
function spreadsheet(bytes: Uint8Array): void {
  const declaredEntries = centralEntries(bytes);
  let expanded = 0; let entries = 0;
  let contentTypes: Uint8Array[] | null = null; let typesBytes = 0; let typesComplete = false;
  const unzip = new Unzip((file) => {
    if (++entries > SPREADSHEET_ENTRY_LIMIT) throw new Error('limit');
    if ((file.originalSize ?? 0) > SPREADSHEET_EXPANDED_LIMIT) throw new Error('limit');
    if (/(^|\/)vbaProject\.bin$/i.test(file.name)) throw new TypeRefusal('macro');
    const isTypes = file.name === '[Content_Types].xml';
    const chunks: Uint8Array[] = [];
    if (isTypes) { if (contentTypes !== null) throw new Error('duplicate'); contentTypes = chunks; }
    file.ondata = (error, data, final) => {
      if (error) throw new Error('zip');
      expanded += data.length;
      if (expanded > SPREADSHEET_EXPANDED_LIMIT) { file.terminate(); throw new Error('limit'); }
      if (isTypes) {
        typesBytes += data.length;
        if (typesBytes > CONTENT_TYPES_LIMIT) throw new Error('limit');
        chunks.push(data);
        if (final) typesComplete = true;
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  // Pequenos blocos limitam a alocação de um inflate malicioso antes da conferência de orçamento.
  for (let at = 0; at < bytes.length; at += 1024) unzip.push(bytes.subarray(at, at + 1024), at + 1024 >= bytes.length);
  if (entries !== declaredEntries) throw new Error('zip');
  if (!contentTypes || !typesComplete) throw new TypeRefusal('types');
  const types = utf8(Buffer.concat(contentTypes));
  if (/macroEnabled/i.test(types)) throw new TypeRefusal('macro');
  if (!types.includes(SPREADSHEET_MAIN)) throw new TypeRefusal('types');
}

/** PDF.js serverless embutido: sem eval, fontes remotas, rendering ou código JavaScript do PDF. */
async function pdf(bytes: Uint8Array): Promise<string> {
  await definePDFJSModule(() => import('unpdf/pdfjs'));
  const options = { isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0, cMapUrl: undefined, standardFontDataUrl: undefined, useWorkerFetch: false };
  const document = await getDocumentProxy(bytes, options);
  try {
    if (document.numPages > 300) throw new Error('pages');
    let text = '';
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      text += content.items.map((item) => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('') + '\n';
      page.cleanup();
      if (text.length > TEXT_LIMIT) break;
    }
    return text;
  } finally { await document.loadingTask.destroy(); }
}

/** Retorna apenas resultado limitado ou código fixo, nunca exceções dos leitores. */
async function main(): Promise<void> {
  const { bytes, format } = workerData as { bytes: Uint8Array; format: 'pdf' | 'docx' | 'text' | 'xlsx' };
  if (format === 'xlsx') { spreadsheet(bytes); parentPort?.postMessage({ valid: true }); return; }
  const text = (format === 'pdf' ? await pdf(bytes) : format === 'docx' ? docx(bytes) : utf8(bytes)).trim();
  if (!text) { parentPort?.postMessage({ error: 'ATTACHMENT_NO_TEXT' }); return; }
  if (text.includes('\0')) throw new Error('invalid');
  parentPort?.postMessage({ text: text.slice(0, TEXT_LIMIT), truncated: text.length > TEXT_LIMIT });
}
void main().catch((error: unknown) => parentPort?.postMessage({ error: error instanceof TypeRefusal ? 'ATTACHMENT_TYPE_UNSUPPORTED' : 'ATTACHMENT_UNREADABLE' }));

// Documentos sintéticos sem dados externos, reutilizados nas provas unitárias e do bundle real.
import { crc32, deflateSync } from 'node:zlib';
import { zipSync, strToU8 } from 'fflate';

/** DOCX mínimo com o XML de conteúdo do Word, e entrada extra para provar orçamento de expansão. */
export function docxFixture(text = 'Documento de teste', extraBytes = 0): Buffer {
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    'word/document.xml': strToU8(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`),
    ...(extraBytes ? { 'word/large.bin': new Uint8Array(extraBytes) } : {}),
  }));
}

/** Tipo de conteúdo da pasta de trabalho `.xlsx`; `.xlsm` usa `application/vnd.ms-excel.sheet.macroEnabled.main+xml`. */
export const XLSX_MAIN_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';

/**
 * Planilha `.xlsx` mínima e real (uma aba, uma célula), gerada em memória (phase 4, ATT-01). `mainType` troca o tipo da pasta de trabalho
 * (macro ou outro formato) e `extra` acrescenta entradas para provar macro (`xl/vbaProject.bin`), zip bomb e número de entradas.
 */
export function xlsxFixture({ mainType = XLSX_MAIN_CONTENT_TYPE, extra = {} }: { mainType?: string; extra?: Record<string, Uint8Array> } = {}): Buffer {
  const packageNs = 'http://schemas.openxmlformats.org/package/2006';
  const officeNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${packageNs}/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${mainType}"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${packageNs}/relationships"><Relationship Id="rId1" Type="${officeNs}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${officeNs}"><sheets><sheet name="Vendas" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${packageNs}/relationships"><Relationship Id="rId1" Type="${officeNs}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    'xl/worksheets/sheet1.xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData></worksheet>'),
    ...extra,
  }));
}

/** PDF válido, sem fonte embutida nem script; xref deriva dos bytes reais. */
export function pdfFixture(text = 'Documento PDF de teste', pages = 1): Buffer {
  const stream = `BT /F1 12 Tf 10 50 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, () => '3 0 R').join(' ')}] /Count ${pages} >>`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let result = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(result));
    result += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = Buffer.byteLength(result);
  result += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(result);
}

/** JPEG de um pixel, sem EXIF, usado para conferir armazenamento e download binário. */
export const JPEG_FIXTURE = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCeAAD/2Q==', 'base64');

/**
 * PNG real e mínimo (phase 4, T7): assinatura, IHDR, IDAT comprimido e IEND com CRC de verdade, como o matplotlib gravaria (em tamanho de teste).
 * `padding` acrescenta bytes ao pixel comprimido para provar os limites de tamanho dos arquivos gerados.
 */
export function pngFixture(width = 1, height = 1, padding = 0): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits por canal, RGB, sem entrelaçamento
  const rows = Buffer.alloc(height * (1 + width * 3) + padding);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}

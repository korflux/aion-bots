// Contrato explícito do arquivo de importação: dados tipados, sem executar workflow, URLs ou instruções do anexo.
import { z } from 'zod';
import { bigintIdSchema } from './conversation';
import { tableCellSchema, tableColumnInputSchema, tableIdSchema, tableVersionSchema } from './tables';

export const TABLE_IMPORT_FORMATS = ['aion-table-import-v1', 'aion-finance-import-v1'] as const;
/** Exemplo tipado de documento, reutilizado pela descrição da ferramenta e pelas provas do importador. */
export const TABLE_IMPORT_DOCUMENT_EXAMPLE = {
  format: 'aion-table-import-v1', tables: [{
    originId: '00000000-0000-4000-8000-000000000001', name: 'Exemplo',
    columns: [{ id: '00000000-0000-4000-8000-000000000002', name: 'Campo', type: 'text' }],
    records: [{ id: '00000000-0000-4000-8000-000000000003', values: { '00000000-0000-4000-8000-000000000002': null } }],
  }],
} as const;
/** Só o marcador explícito habilita o caminho compacto; um JSON comum continua um documento normal. */
export function isTableImportDocument(text: string): boolean {
  try { const value: unknown = JSON.parse(text); return typeof value === 'object' && value !== null && TABLE_IMPORT_FORMATS.includes((value as { format: typeof TABLE_IMPORT_FORMATS[number] }).format); }
  catch { return false; }
}
/** Matrizes e registros por objeto compartilham o mesmo modelo interno, sem coerção dos valores. */
export const tableImportDocumentSchema = z.object({
  format: z.enum(TABLE_IMPORT_FORMATS),
  tables: z.array(z.object({
    originId: tableIdSchema, name: z.string().min(1).max(100), description: z.string().max(1000).default(''),
    columns: z.array(tableColumnInputSchema).min(1).max(50),
    rowColumns: z.array(tableIdSchema).max(50).optional(),
    rows: z.array(z.array(z.union([tableCellSchema, tableIdSchema])).max(51)).max(5000).optional(),
    records: z.array(z.strictObject({ id: tableIdSchema, values: z.record(tableIdSchema, tableCellSchema) })).max(5000).optional(),
    views: z.array(z.object({ name: z.string().min(1).max(100) }).passthrough()).max(20).default([]),
  }).passthrough()).min(1).max(20),
}).passthrough();
export type TableImportDocument = z.output<typeof tableImportDocumentSchema>;
/** Apenas referências/metadados chegam ao modelo; células nunca são argumentos desta ferramenta. */
const source = { attachmentId: bigintIdSchema, sourceHash: z.string().regex(/^[a-f0-9]{64}$/) };
const bindings = z.array(z.strictObject({ sourceTableId: tableIdSchema, tableId: tableIdSchema, expectedSchemaVersion: tableVersionSchema.optional() })).max(20);
const inspect = z.strictObject({ operation: z.literal('inspect'), attachmentId: bigintIdSchema });
const apply = z.strictObject({ operation: z.literal('apply'), ...source, phase: z.enum(['create', 'schema', 'records', 'relations', 'view']), sourceTableId: tableIdSchema.optional(), bindings, operationId: tableIdSchema,
  expectedSchemaVersion: tableVersionSchema.optional(), offset: z.number().int().min(0).max(100_000).default(0), limit: z.number().int().min(1).max(100).default(100) });
const verify = z.strictObject({ operation: z.literal('verify'), ...source, bindings });
/** Validação autoritativa continua discriminada/estrita: campos de outra operação nunca são aceitos silenciosamente. */
export const tableImportToolSchema = z.discriminatedUnion('operation', [inspect, apply, verify]);
/** Provedores exigem parameters com objeto na raiz. Reutiliza os campos reais, sem publicar oneOf na raiz nem relaxar o servidor. */
export const tableImportToolParametersSchema = z.strictObject({
  operation: z.enum(['inspect', 'apply', 'verify']), attachmentId: inspect.shape.attachmentId,
  sourceHash: source.sourceHash.optional().describe('Obrigatório em apply/verify; omitido em inspect.'),
  bindings: bindings.optional().describe('Obrigatório em apply/verify; omitido em inspect.'),
  phase: apply.shape.phase.optional().describe('Somente apply; obrigatório.'),
  sourceTableId: apply.shape.sourceTableId.describe('Somente apply; omita para operar a fase em todas as tabelas, com offset global e limit total até 100.'),
  operationId: apply.shape.operationId.optional().describe('Somente apply; obrigatório.'),
  expectedSchemaVersion: apply.shape.expectedSchemaVersion.describe('Somente apply; obrigatório após create.'),
  offset: apply.shape.offset.optional().describe('Somente apply.'), limit: apply.shape.limit.optional().describe('Somente apply.'),
});
export type TableImportToolInput = z.output<typeof tableImportToolSchema>;

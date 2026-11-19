// Jornada de importação real no PostgreSQL: anexos autorizados, valores intactos, fases/recibos e replay sem retranscrição pelo modelo.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TABLE_IMPORT_DOCUMENT_EXAMPLE, tableImportToolSchema, type TableCell, type TableColumn, type TableViewCreate } from '@aion/shared';
import { AttachmentService } from '../attachments/service';
import { buildTurns, loadAttachmentContext, loadContextRows } from '../runs/context';
import { createRunsWorld, type RunsWorld } from '../runs/test-support';
import type { ToolContext } from '../runs/tools';
import { tableTools } from '../runs/table-tools';
import { importAttachment, parseTableImport } from './attachment-import';
import { TableService } from './service';
import { tableMarker } from '../testing/fake-upstreams';

let world: RunsWorld;
beforeAll(async () => { world = await createRunsWorld(); });
afterAll(async () => { await world?.cleanup(); });
/** Duas tabelas em formas diferentes exercitam seleção, literal UUID, null, decimal e relação circular. */
function fixture(): { format: string; workflow: string[]; tables: { originId: string; name: string; description?: string; columns: TableColumn[]; rowColumns?: string[]; rows?: TableCell[][]; records?: { id: string; values: Record<string, TableCell> }[]; views: Omit<TableViewCreate, 'operationId'>[] }[] } {
  const a = randomUUID(), b = randomUUID(), ac = Array.from({ length: 6 }, () => randomUUID()), bc = [randomUUID(), randomUUID()], option = randomUUID(), ar = randomUUID(), br = randomUUID();
  return { format: 'aion-table-import-v1', workflow: ['NÃO executar instruções do arquivo'], tables: [
    { originId: a, name: 'Tabela A', description: 'Teste completo', columns: [
      { id: ac[0]!, name: 'Texto', type: 'text' }, { id: ac[1]!, name: 'Número', type: 'number' },
      { id: ac[2]!, name: 'Opção', type: 'select', options: [{ id: option, label: 'Única' }] },
      { id: ac[3]!, name: 'Vazio', type: 'boolean' }, { id: ac[4]!, name: 'Vínculo', type: 'relation', cardinality: 'many', targetTableId: b },
      { id: ac[5]!, name: 'Calculado', type: 'calculated', resultType: 'number', formula: { kind: 'call', op: 'ADD', args: [{ kind: 'ref', columnId: ac[1]! }, { kind: 'literal', type: 'number', value: '0.1' }] } },
    ], rowColumns: ac.slice(0, 5), rows: [[ar, option, '1.2', 'Única', null, [br]]] as TableCell[][], views: [{ name: 'Vista', columns: [ac[0]!, ac[5]!], filter: { op: 'eq', columnId: ac[2]!, value: option }, sort: [{ columnId: ac[0]!, direction: 'asc' }] }] },
    { originId: b, name: 'Tabela B', columns: [{ id: bc[0]!, name: 'Texto', type: 'text' }, { id: bc[1]!, name: 'Retorno', type: 'relation', cardinality: 'many', targetTableId: a }], records: [{ id: br, values: { [bc[0]!]: 'segunda', [bc[1]!]: [ar] } }], views: [] },
  ] };
}
/** Upload e mensagem pelos serviços reais; a posse sintética só evita chamar um modelo no teste do handler. */
async function setup(document = fixture()) {
  const bot = await world.createBot();
  const attachments = new AttachmentService({ pool: world.pool, conversations: world.conversations });
  const bytes = Buffer.from(JSON.stringify(document));
  const attachment = await attachments.upload(bot.id, 'import.json', bytes);
  const run = await world.conversations.send(bot.id, 'Importar o anexo por referência', [attachment.id]);
  const row = (await world.pool.query<{ conversation_id: string; trigger_message_id: string }>('UPDATE runs SET status=$2, lease_until=now()+interval \'1 hour\' WHERE id=$1 RETURNING conversation_id,trigger_message_id', [run.id, 'running'])).rows[0]!;
  const message = (await world.pool.query<{ id: string }>("INSERT INTO messages (conversation_id,run_id,role,kind,status,opens_round,content,created_at) VALUES ($1,$2,'user','text','done',true,'Importar anexo',now()) RETURNING id::text", [row.conversation_id, run.id])).rows[0]!;
  row.trigger_message_id = message.id;
  await world.pool.query('UPDATE runs SET trigger_message_id=$2 WHERE id=$1', [run.id, message.id]);
  await world.pool.query('UPDATE attachments SET message_id=$2 WHERE id=$1', [attachment.id, message.id]);
  const context: ToolContext = { pool: world.pool, botId: bot.id, conversationId: row.conversation_id, runId: run.id, now: () => new Date(), signal: new AbortController().signal };
  return { bot, document, bytes, attachment, context, messageId: row.trigger_message_id };
}
/** Passa pelo mesmo schema estrito que a descoberta oferece ao modelo. */
const execute = (input: unknown, context: ToolContext) => importAttachment(tableImportToolSchema.parse(input), context);

describe('importação por referência a anexo', () => {
  it('o exemplo publicado é importável pelas ferramentas reais e replay não altera o resultado', async () => {
    const document = JSON.parse(JSON.stringify(TABLE_IMPORT_DOCUMENT_EXAMPLE)) as ReturnType<typeof fixture>;
    document.tables.forEach((table) => { table.views ??= []; });
    expect(parseTableImport(Buffer.from(JSON.stringify(document))).tables).toHaveLength(1);
    const { attachment, context } = await setup(document);
    const inspection = await execute({ operation: 'inspect', attachmentId: attachment.id }, context) as { sourceHash: string };
    const input = { operation: 'apply', attachmentId: attachment.id, sourceHash: inspection.sourceHash, operationId: randomUUID(), bindings: [], phase: 'create' };
    const created = await execute(input, context) as { bindings: { sourceTableId: string; tableId: string; expectedSchemaVersion: number }[] };
    const records = { ...input, phase: 'records', bindings: created.bindings };
    await execute(records, context);
    const verify = { operation: 'verify', attachmentId: attachment.id, sourceHash: inspection.sourceHash, bindings: created.bindings };
    expect(await execute(verify, context)).toMatchObject({ passed: true, tables: [{ actual: 1, differentCells: 0, schemaExact: true }] });
    const service = new TableService({ pool: world.pool }), actor = { kind: 'bot', botId: context.botId! } as const;
    const before = await service.importSnapshot(created.bindings[0]!.tableId, actor);
    await execute(records, context);
    expect(await service.importSnapshot(created.bindings[0]!.tableId, actor)).toEqual(before);
  });
  it('importa matrizes/objetos, AST/vistas/vínculos; replay integral conserva IDs, versões e valores', async () => {
    const setupResult = await setup(); const { document, attachment, context } = setupResult;
    const inspection = await execute({ operation: 'inspect', attachmentId: attachment.id }, context) as { sourceHash: string; tables: unknown[] };
    expect(inspection.tables).toHaveLength(2); expect(JSON.stringify(inspection)).not.toContain(document.tables[0]!.rows![0]![1]);
    const bindings: { sourceTableId: string; tableId: string }[] = [];
    const service = new TableService({ pool: world.pool }), actor = { kind: 'bot', botId: setupResult.bot.id } as const;
    const apply = async (phase: string, index: number, extra: object = {}) => {
      const sourceTableId = document.tables[index]!.originId;
      const binding = bindings.find((item) => item.sourceTableId === sourceTableId);
      const revision = binding ? (await service.get(binding.tableId, actor)).schemaVersion : undefined;
      return execute({ operation: 'apply', attachmentId: attachment.id, sourceHash: inspection.sourceHash, sourceTableId, phase, bindings, operationId: randomUUID(), ...(revision ? { expectedSchemaVersion: revision } : {}), ...extra }, context) as Promise<{ tableId?: string; skipped?: boolean }>;
    };
    for (let index = 0; index < 2; index++) { const result = await apply('create', index); bindings.push({ sourceTableId: document.tables[index]!.originId, tableId: result.tableId! }); }
    for (let index = 0; index < 2; index++) await apply('schema', index);
    for (let index = 0; index < 2; index++) await apply('records', index);
    for (let index = 0; index < 2; index++) await apply('relations', index);
    await apply('view', 0);
    expect(await execute({ operation: 'verify', attachmentId: attachment.id, sourceHash: inspection.sourceHash, bindings }, context)).toMatchObject({ passed: true, tables: [{ missing: 0, extra: 0, differentCells: 0, schemaExact: true, viewsExact: true }, { missing: 0, extra: 0 }] });
    const before = await Promise.all(bindings.map(async ({ tableId }) => ({ table: await service.get(tableId, actor), records: await service.importSnapshot(tableId, actor), views: await service.views(tableId, actor) })));
    for (let index = 0; index < 2; index++) for (const phase of ['create', 'schema', 'records', 'relations']) await apply(phase, index);
    await apply('view', 0);
    const after = await Promise.all(bindings.map(async ({ tableId }) => ({ table: await service.get(tableId, actor), records: await service.importSnapshot(tableId, actor), views: await service.views(tableId, actor) })));
    expect(after).toEqual(before);
    const text = before[0]!.table.columns.find((column) => column.name === 'Texto')!, number = before[0]!.table.columns.find((column) => column.name === 'Número')!;
    expect(before[0]!.records.records[0]!.values[text.id]).toBe(document.tables[0]!.rows![0]![1]);
    expect(before[0]!.records.records[0]!.values[number.id]).toBe('1.2');
    // Contexto conserva o arquivo no banco, mas transmite só referência; documentos comuns continuam completos.
    const rows = await loadContextRows(world.pool, context.conversationId); await loadAttachmentContext(world.pool, rows, context.conversationId, context.runId);
    const turns = buildTurns(rows); expect(turns[0]!.text).not.toContain('1.2'); expect(turns[0]!.text).toContain('table_import_attachment');
    expect(buildTurns(rows, { generalChat: true })[1]!.text).toContain('1.2');
    expect((await world.pool.query('SELECT extracted_text FROM attachments WHERE id=$1', [attachment.id])).rows[0].extracted_text).toBe(setupResult.bytes.toString());
    await service.write(bindings[0]!.tableId, { operationId: randomUUID(), expectedSchemaVersion: before[0]!.table.schemaVersion, creates: [{ values: {} }], updates: [] }, actor);
    expect(await execute({ operation: 'verify', attachmentId: attachment.id, sourceHash: inspection.sourceHash, bindings }, context)).toMatchObject({ passed: false, tables: [{ extra: 1 }, { extra: 0 }] });
    // Exclusão autorizada de uma ocorrência sem vínculos ativos: verify deve detectar ausente, não certificar ou despejar células.
    for (let index = 0; index < 2; index++) {
      const item = before[index]!, relation = item.table.columns.find((column) => column.type === 'relation')!, record = item.records.records[0]!;
      await service.write(item.table.id, { operationId: randomUUID(), expectedSchemaVersion: item.table.schemaVersion, creates: [], updates: [{ id: record.id, expectedVersion: record.version, values: { [relation.id]: null } }] }, actor);
    }
    const currentB = await service.get(bindings[1]!.tableId, actor), removed = (await service.importSnapshot(currentB.id, actor)).records[0]!;
    const prepared = await service.prepareDestructive(currentB.id, { kind: 'delete_records', expectedVersion: currentB.version, records: [{ id: removed.id, expectedVersion: removed.version }] }, { kind: 'owner' });
    await service.confirmDestructive(currentB.id, { preparationId: prepared.preparationId, operationId: randomUUID(), confirmation: true }, { kind: 'owner' });
    expect(await execute({ operation: 'verify', attachmentId: attachment.id, sourceHash: inspection.sourceHash, bindings }, context)).toMatchObject({ passed: false, tables: [{ differentCells: 1 }, { missing: 1 }] });
  });

  it('recusa fonte cruzada/removida/malformada, hash/revisão/posse inválidos; lote inválido é atômico', async () => {
    const { document, attachment, context } = await setup();
    const inspected = await execute({ operation: 'inspect', attachmentId: attachment.id }, context) as { sourceHash: string };
    const other = await setup();
    await expect(execute({ operation: 'inspect', attachmentId: attachment.id }, other.context)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
    const base = { operation: 'apply', attachmentId: attachment.id, sourceHash: inspected.sourceHash, phase: 'create', sourceTableId: document.tables[0]!.originId, bindings: [], operationId: randomUUID() };
    await expect(execute({ ...base, sourceHash: '0'.repeat(64) }, context)).rejects.toMatchObject({ code: 'TABLE_IMPORT_SOURCE_CHANGED' });
    const create = await execute(base, context) as { tableId: string };
    expect(await execute(base, context)).toEqual(create);
    const service = new TableService({ pool: world.pool }), actor = { kind: 'bot', botId: context.botId! } as const;
    const second = await execute({ ...base, sourceTableId: document.tables[1]!.originId, operationId: randomUUID() }, context) as { tableId: string };
    await expect(execute({ ...base, bindings: [{ sourceTableId: document.tables[0]!.originId, tableId: create.tableId }, { sourceTableId: document.tables[1]!.originId, tableId: second.tableId }], phase: 'schema', expectedSchemaVersion: 999 }, context)).rejects.toMatchObject({ code: 'TABLE_CONFLICT' });
    await world.pool.query('UPDATE attachments SET removed_at=now(),extracted_text=NULL,stored_bytes=0 WHERE id=$1', [attachment.id]);
    await expect(execute({ operation: 'inspect', attachmentId: attachment.id }, context)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
    await world.pool.query('UPDATE attachments SET removed_at=NULL,extracted_text=$2 WHERE id=$1', [attachment.id, '{bad']);
    await expect(execute({ operation: 'inspect', attachmentId: attachment.id }, context)).rejects.toMatchObject({ code: 'TABLE_IMPORT_INVALID' });
    expect((await service.importSnapshot(create.tableId, actor)).records).toHaveLength(0);
    const invalid = fixture(); invalid.tables = [invalid.tables[0]!]; invalid.tables[0]!.columns = invalid.tables[0]!.columns!.filter((column) => !['relation', 'calculated'].includes(column.type)); invalid.tables[0]!.rowColumns = invalid.tables[0]!.rowColumns!.slice(0, 4); invalid.tables[0]!.rows = [[randomUUID(), 'ok', '1', 'Única', false], [randomUUID(), 'bad', 'not-decimal', 'Única', false]]; invalid.tables[0]!.views = [];
    const bad = await setup(invalid); const info = await execute({ operation: 'inspect', attachmentId: bad.attachment.id }, bad.context) as { sourceHash: string };
    const b = { operation: 'apply', attachmentId: bad.attachment.id, sourceHash: info.sourceHash, sourceTableId: invalid.tables[0]!.originId, operationId: randomUUID(), phase: 'create', bindings: [] };
    const created = await execute(b, bad.context) as { tableId: string; schemaVersion: number };
    const write = { ...b, phase: 'records', operationId: randomUUID(), bindings: [{ sourceTableId: invalid.tables[0]!.originId, tableId: created.tableId }], expectedSchemaVersion: created.schemaVersion };
    await expect(execute(write, bad.context)).rejects.toMatchObject({ code: 'TABLE_INVALID_VALUE' });
    expect((await service.importSnapshot(created.tableId, { kind: 'bot', botId: bad.bot.id })).records).toHaveLength(0);
    const stopped = new AbortController(); stopped.abort(); await expect(execute({ ...b, operationId: randomUUID(), bindings: [] }, { ...bad.context, signal: stopped.signal })).rejects.toMatchObject({ code: 'TABLE_CONFLICT' });
  });

  it('generated JSON segue mesmo parser e rejeita UTF8 inválido/colisões; schema de descoberta permanece compacto', async () => {
    const { bytes, attachment, context, document } = await setup();
    await world.pool.query('UPDATE attachments SET kind=$2,format=$3,file_bytes=$4,extracted_text=NULL,source_provenance=$5::jsonb WHERE id=$1', [attachment.id, 'generated', 'json', bytes, JSON.stringify({ attachments: [], tables: [] })]);
    expect(await execute({ operation: 'inspect', attachmentId: attachment.id }, context)).toMatchObject({ tables: [{ records: 1 }, { records: 1 }] });
    await world.pool.query('UPDATE attachments SET file_bytes=$2 WHERE id=$1', [attachment.id, Buffer.from([0xff])]);
    await expect(execute({ operation: 'inspect', attachmentId: attachment.id }, context)).rejects.toMatchObject({ code: 'TABLE_IMPORT_INVALID' });
    const duplicated = structuredClone(document); duplicated.tables[0]!.columns![1]!.name = duplicated.tables[0]!.columns![0]!.name;
    expect(() => parseTableImport(Buffer.from(JSON.stringify(duplicated)))).toThrow();
    const collision = structuredClone(document); const selected = collision.tables[0]!.columns![2]!; if ('options' in selected) selected.options![0]!.id = collision.tables[0]!.columns![0]!.id!;
    expect(() => parseTableImport(Buffer.from(JSON.stringify(collision)))).toThrow();
    const handler = tableTools.find((tool) => tool.definition.name === 'table_import_attachment')!;
    expect(Buffer.byteLength(JSON.stringify(handler.definition))).toBeLessThan(8000);
    expect(handler.definition.parameters).toMatchObject({ type: 'object', required: ['operation', 'attachmentId'], additionalProperties: false, properties: { operation: { enum: ['inspect', 'apply', 'verify'] } } });
    expect(handler.definition.parameters).not.toHaveProperty('oneOf');
    expect(handler.definition.parameters).not.toHaveProperty('anyOf');
    expect(() => handler.prepare(JSON.stringify({ operation: 'inspect', attachmentId: attachment.id, values: {} }))).toThrow();
    expect(() => handler.prepare(JSON.stringify({ operation: 'inspect', attachmentId: attachment.id, bindings: [] }))).toThrow();
    expect(() => handler.prepare(JSON.stringify({ operation: 'apply', attachmentId: attachment.id }))).toThrow();
    expect(() => handler.prepare(JSON.stringify({ operation: 'verify', attachmentId: attachment.id, sourceHash: '0'.repeat(64), bindings: [], operationId: randomUUID() }))).toThrow();
    const normal = { ...document, format: 'ordinary-json' };
    const row = { role: 'user' as const, kind: 'text' as const, run_id: null, status: 'completed', opens_round: true, step: null, content: 'Documento comum', data: {}, attachments: [{ id: '1', message_id: '1', kind: 'document' as const, name: 'normal.json', original_bytes: 100, total_chars: 100, removed: false, extracted_text: JSON.stringify(normal), image_bytes: null }] };
    expect(buildTurns([row])[0]!.text).toContain('1.2');
  });

  it('vistas remapeiam includes multiselect/many e eq one sem remapear literais UUID de texto', async () => {
    const document = fixture(), a = document.tables[0]!, b = document.tables[1]!;
    const multi = randomUUID(), option = randomUUID();
    a.columns!.push({ id: multi, name: 'Múltipla', type: 'multiselect', options: [{ id: option, label: 'Marcada' }] });
    a.rowColumns!.push(multi); a.rows![0]!.push(['Marcada']);
    if (b.columns[1]!.type === 'relation') b.columns[1]!.cardinality = 'one';
    const ar = a.rows![0]![0] as string, br = b.records![0]!.id;
    (b.records![0]!.values as Record<string, TableCell>)[b.columns![1]!.id!] = ar;
    a.views!.push({ name: 'Multi', columns: [multi], filter: { op: 'includes', columnId: multi, value: option }, sort: [] });
    a.views!.push({ name: 'Relacionada', columns: [a.columns![4]!.id], filter: { op: 'includes', columnId: a.columns![4]!.id, value: br }, sort: [] });
    b.views = [{ name: 'Uma', columns: [b.columns![1]!.id], filter: { op: 'eq', columnId: b.columns![1]!.id, value: ar }, sort: [] }];
    const fixtureWorld = await setup(document), { context, attachment } = fixtureWorld;
    const info = await execute({ operation: 'inspect', attachmentId: attachment.id }, context) as { sourceHash: string };
    const bindings: { sourceTableId: string; tableId: string }[] = [], service = new TableService({ pool: world.pool }), actor = { kind: 'bot', botId: fixtureWorld.bot.id } as const;
    const apply = async (phase: string, index: number, offset = 0) => {
      const sourceTableId = document.tables[index]!.originId, binding = bindings.find((item) => item.sourceTableId === sourceTableId), expectedSchemaVersion = binding ? (await service.get(binding.tableId, actor)).schemaVersion : undefined;
      return execute({ operation: 'apply', attachmentId: attachment.id, sourceHash: info.sourceHash, sourceTableId, phase, bindings, operationId: randomUUID(), offset, ...(expectedSchemaVersion ? { expectedSchemaVersion } : {}) }, context) as Promise<{ tableId: string }>;
    };
    for (let index = 0; index < 2; index++) bindings.push({ sourceTableId: document.tables[index]!.originId, tableId: (await apply('create', index)).tableId });
    for (const phase of ['schema', 'records', 'relations']) for (let index = 0; index < 2; index++) await apply(phase, index);
    for (let index = 0; index < 2; index++) for (let offset = 0; offset < document.tables[index]!.views!.length; offset++) await apply('view', index, offset);
    expect(await apply('view', 0, 0)).toMatchObject({ skipped: true, nextOffset: 1 });
    const targetA = await service.get(bindings[0]!.tableId, actor), targetB = await service.get(bindings[1]!.tableId, actor);
    const recordsA = await service.importSnapshot(targetA.id, actor), recordsB = await service.importSnapshot(targetB.id, actor);
    const viewsA = (await service.views(targetA.id, actor)).views, viewsB = (await service.views(targetB.id, actor)).views;
    const actualMulti = targetA.columns.find((column) => column.name === 'Múltipla')!;
    expect(actualMulti.type).toBe('multiselect');
    if (actualMulti.type === 'multiselect') expect(viewsA.find((view) => view.name === 'Multi')!.filter).toEqual({ op: 'includes', columnId: actualMulti.id, value: actualMulti.options[0]!.id });
    expect(viewsA.find((view) => view.name === 'Relacionada')!.filter).toEqual({ op: 'includes', columnId: targetA.columns.find((column) => column.name === 'Vínculo')!.id, value: recordsB.records[0]!.id });
    expect(viewsB[0]!.filter).toEqual({ op: 'eq', columnId: targetB.columns.find((column) => column.name === 'Retorno')!.id, value: recordsA.records[0]!.id });
    expect(await execute({ operation: 'verify', attachmentId: attachment.id, sourceHash: info.sourceHash, bindings }, context)).toMatchObject({ passed: true });
    await expect(service.update(targetA.id, { expectedSchemaVersion: targetA.schemaVersion, operationId: randomUUID(), columns: [...targetA.columns, { id: randomUUID(), name: 'ID forjado', type: 'text' }] }, actor)).rejects.toMatchObject({ code: 'TABLE_INVALID_SCHEMA' });
  });

  it('fórmula que compara seleção com ID de opção é remapeada e calcula no destino; UUID de texto sem relação permanece intacto', async () => {
    const document = fixture(), a = document.tables[0]!;
    const select = a.columns.find((column) => column.name === 'Opção')!, option = select.type === 'select' ? select.options[0]!.id : '';
    const unrelated = randomUUID();
    a.columns.push({ id: randomUUID(), name: 'É única', type: 'calculated', resultType: 'number', formula: { kind: 'call', op: 'IF', args: [
      { kind: 'call', op: 'EQ', args: [{ kind: 'ref', columnId: select.id }, { kind: 'literal', type: 'text', value: option }] },
      { kind: 'literal', type: 'number', value: '1' }, { kind: 'literal', type: 'number', value: '0' }] } });
    a.columns.push({ id: randomUUID(), name: 'Texto fixo', type: 'calculated', resultType: 'text', formula: { kind: 'call', op: 'IF', args: [
      { kind: 'call', op: 'EQ', args: [{ kind: 'ref', columnId: a.columns[0]!.id }, { kind: 'literal', type: 'text', value: unrelated }] },
      { kind: 'literal', type: 'text', value: unrelated }, { kind: 'literal', type: 'text', value: 'não' }] } });
    const { context, attachment, bot } = await setup(document);
    const info = await execute({ operation: 'inspect', attachmentId: attachment.id }, context) as { sourceHash: string };
    let bindings: { sourceTableId: string; tableId: string; expectedSchemaVersion?: number }[] = [];
    const created = await execute({ operation: 'apply', attachmentId: attachment.id, sourceHash: info.sourceHash, phase: 'create', bindings, operationId: randomUUID(), offset: 0 }, context) as { bindings: typeof bindings };
    bindings = created.bindings;
    for (const phase of ['schema', 'records', 'relations', 'view']) {
      const result = await execute({ operation: 'apply', attachmentId: attachment.id, sourceHash: info.sourceHash, phase, bindings, operationId: randomUUID(), offset: 0 }, context) as { bindings?: typeof bindings };
      if (result.bindings) bindings = result.bindings;
    }
    const service = new TableService({ pool: world.pool }), actor = { kind: 'bot', botId: bot.id } as const;
    const target = await service.get(bindings.find((item) => item.sourceTableId === a.originId)!.tableId, actor);
    const actualSelect = target.columns.find((column) => column.name === 'Opção')!;
    const flag = target.columns.find((column) => column.name === 'É única')!, fixed = target.columns.find((column) => column.name === 'Texto fixo')!;
    const literalOf = (column: TableColumn) => JSON.stringify(column.type === 'calculated' ? column.formula : null);
    if (actualSelect.type === 'select') expect(literalOf(flag)).toContain(actualSelect.options[0]!.id);
    expect(literalOf(flag)).not.toContain(option);
    expect(literalOf(fixed)).toContain(unrelated);
    // O valor calculado no destino reconhece a opção do registro importado.
    const page = await service.records(target.id, actor, {});
    expect(page.records[0]!.values[flag.id]).toBe('1');
  });

  it('worker real oferece/importa pela ferramenta e não envia células do anexo ao provedor falso', async () => {
    const bot = await world.createBot(), attachments = new AttachmentService({ pool: world.pool, conversations: world.conversations });
    const document = fixture(), attachment = await attachments.upload(bot.id, 'referencia.json', Buffer.from(JSON.stringify(document)));
    world.engine.start();
    const run = await world.conversations.send(bot.id, tableMarker('table_import_attachment', { operation: 'inspect', attachmentId: attachment.id }), [attachment.id]);
    await world.waitForStatus(run.id, 'completed');
    const activity = (await world.pool.query<{ content: string }>("SELECT content FROM messages WHERE run_id=$1 AND kind='activity'", [run.id])).rows[0]!;
    expect(JSON.parse(activity.content)).toMatchObject({ tables: [{ records: 1, columns: 6 }, { records: 1, columns: 2 }] });
    const requests = world.conversationRequests().filter((request) => JSON.stringify(request.body).includes(attachment.id));
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.some((request) => JSON.stringify(request.body).includes(document.tables[0]!.rows![0]![1] as string))).toBe(false);
    expect(requests.some((request) => JSON.stringify(request.body).includes('"name":"table_import_attachment"'))).toBe(true);
    for (const request of requests) {
      const body = request.body as { tools: { function: { name: string; parameters: Record<string, unknown> } }[] };
      const selected = body.tools.find((tool) => tool.function.name === 'table_import_attachment');
      // Bootstrap não contém schemas ainda; comprova o contrato na etapa que realmente os publica.
      if (!selected) continue;
      const parameters = selected.function.parameters;
      expect(parameters.type).toBe('object'); expect(parameters.properties).toBeDefined();
      expect(parameters).not.toHaveProperty('oneOf'); expect(parameters).not.toHaveProperty('anyOf');
    }
    await world.engine.stop();
  });

  it('fases globais retomam create parcial sem bindings; paginação somada e replay mantêm todas versões', async () => {
    const document = fixture(); document.tables[0]!.views.push({ ...document.tables[0]!.views[0]!, name: 'Vista2' });
    const { attachment, context, bot } = await setup(document), service = new TableService({ pool: world.pool }), actor = { kind: 'bot', botId: bot.id } as const;
    const inspection = await execute({ operation: 'inspect', attachmentId: attachment.id }, context) as { sourceHash: string };
    const createInput = { operation: 'apply', phase: 'create', attachmentId: attachment.id, sourceHash: inspection.sourceHash, operationId: randomUUID(), bindings: [] };
    const interrupted = new AbortController(), original = TableService.prototype.create;
    const spy = vi.spyOn(TableService.prototype, 'create').mockImplementationOnce(async function (this: TableService, ...args) { const result = await original.apply(this, args); interrupted.abort(); return result; });
    try { await expect(execute(createInput, { ...context, signal: interrupted.signal })).rejects.toMatchObject({ code: 'TABLE_IMPORT_PARTIAL' }); }
    finally { spy.mockRestore(); }
    const first = (await service.list(actor)).tables[0]!;
    expect((await service.list(actor)).tables).toHaveLength(1);
    const created = await execute(createInput, context) as { bindings: { sourceTableId: string; tableId: string; expectedSchemaVersion: number }[]; processed: number; nextOffset: number | null };
    expect(created).toMatchObject({ processed: 2, nextOffset: null });
    expect(created.bindings.find((binding) => binding.sourceTableId === document.tables[0]!.originId)!.tableId).toBe(first.id);
    expect(await service.get(first.id, actor)).toEqual(first);
    let bindings = created.bindings;
    const apply = async (phase: string, offset = 0, limit = 100, operationId = randomUUID()) => {
      const result = await execute({ operation: 'apply', phase, offset, limit, operationId, attachmentId: attachment.id, sourceHash: inspection.sourceHash, bindings }, context) as { bindings: typeof bindings; applied: number; skipped: number; processed: number; nextOffset: number | null };
      bindings = result.bindings; return result;
    };
    const schemaOperation = randomUUID(), previousBindings = structuredClone(bindings);
    await apply('schema', 0, 100, schemaOperation);
    // Retomada recebe revisões antigas, mas ambas definições já corretas são somente lidas/puladas.
    expect(await execute({ operation: 'apply', phase: 'schema', operationId: schemaOperation, attachmentId: attachment.id, sourceHash: inspection.sourceHash, bindings: previousBindings }, context)).toMatchObject({ skipped: 2, applied: 0 });
    expect(await apply('records', 0, 1)).toMatchObject({ processed: 1, applied: 1, nextOffset: 1 });
    expect(await apply('records', 1, 1)).toMatchObject({ processed: 1, applied: 1, nextOffset: null });
    const relationOperation = randomUUID(), relationAbort = new AbortController(), originalWrite = TableService.prototype.write;
    const writeSpy = vi.spyOn(TableService.prototype, 'write').mockImplementationOnce(async function (this: TableService, ...args) { const result = await originalWrite.apply(this, args); relationAbort.abort(); return result; });
    try { await expect(execute({ operation: 'apply', phase: 'relations', operationId: relationOperation, attachmentId: attachment.id, sourceHash: inspection.sourceHash, bindings }, { ...context, signal: relationAbort.signal })).rejects.toMatchObject({ code: 'TABLE_IMPORT_PARTIAL' }); }
    finally { writeSpy.mockRestore(); }
    const firstConfirmed = await service.importSnapshot(bindings[0]!.tableId, actor);
    expect(await apply('relations', 0, 100, relationOperation)).toMatchObject({ skipped: 1, applied: 1 });
    expect(await service.importSnapshot(bindings[0]!.tableId, actor)).toEqual(firstConfirmed);
    const viewOperation = randomUUID(), viewAbort = new AbortController(), originalView = TableService.prototype.saveView;
    const viewSpy = vi.spyOn(TableService.prototype, 'saveView').mockImplementationOnce(async function (this: TableService, ...args) { const result = await originalView.apply(this, args); viewAbort.abort(); return result; });
    try { await expect(execute({ operation: 'apply', phase: 'view', operationId: viewOperation, attachmentId: attachment.id, sourceHash: inspection.sourceHash, bindings }, { ...context, signal: viewAbort.signal })).rejects.toMatchObject({ code: 'TABLE_IMPORT_PARTIAL' }); }
    finally { viewSpy.mockRestore(); }
    const firstView = (await service.views(bindings[0]!.tableId, actor)).views[0]!;
    expect(await apply('view', 0, 100, viewOperation)).toMatchObject({ skipped: 1, applied: 1, atomicity: 'per-operation' });
    expect((await service.views(bindings[0]!.tableId, actor)).views.find((view) => view.id === firstView.id)).toEqual(firstView);
    expect(await execute({ operation: 'verify', attachmentId: attachment.id, sourceHash: inspection.sourceHash, bindings }, context)).toMatchObject({ passed: true });
    const snapshot = async () => Promise.all(bindings.map(async (binding) => ({ table: await service.get(binding.tableId, actor), records: await service.importSnapshot(binding.tableId, actor), views: await service.views(binding.tableId, actor) })));
    const before = await snapshot();
    for (const phase of ['create', 'schema', 'records', 'relations', 'view']) await apply(phase);
    expect(await snapshot()).toEqual(before);
    expect(await apply('view')).toMatchObject({ skipped: 2, applied: 0, nextOffset: null });
  });

  it('expansão global acima de 1 MiB recusa ambos sublotes antes de qualquer escrita', async () => {
    const { attachment, context, bot } = await setup();
    const tables = Array.from({ length: 2 }, (_, table) => {
      const columns = Array.from({ length: 50 }, (_, index) => ({ id: randomUUID(), name: `Coluna ${index}`, type: 'text' }));
      return { originId: randomUUID(), name: `Volume ${table}`, columns, rowColumns: columns.map((column) => column.id), rows: Array.from({ length: 50 }, () => [randomUUID(), ...columns.map(() => 'x'.repeat(170))]), views: [] };
    });
    const bytes = Buffer.from(JSON.stringify({ format: 'aion-table-import-v1', tables }));
    expect(bytes.byteLength).toBeLessThan(1024 * 1024);
    // JSON gerado não sofre o corte do leitor de documentos; consumidor aplica de novo seu teto/parsing.
    await world.pool.query('UPDATE attachments SET kind=$2,format=$3,file_bytes=$4,extracted_text=NULL,source_provenance=$5::jsonb WHERE id=$1', [attachment.id, 'generated', 'json', bytes, JSON.stringify({ attachments: [], tables: [] })]);
    const info = await execute({ operation: 'inspect', attachmentId: attachment.id }, context) as { sourceHash: string };
    const input = { operation: 'apply', phase: 'create', operationId: randomUUID(), attachmentId: attachment.id, sourceHash: info.sourceHash, bindings: [] };
    const created = await execute(input, context) as { bindings: { sourceTableId: string; tableId: string; expectedSchemaVersion: number }[] };
    await expect(execute({ ...input, phase: 'records', operationId: randomUUID(), bindings: created.bindings }, context)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    const service = new TableService({ pool: world.pool });
    for (const binding of created.bindings) expect((await service.importSnapshot(binding.tableId, { kind: 'bot', botId: bot.id })).records).toHaveLength(0);
  });
});

// Prova da leitura tolerante dos argumentos das ferramentas (fonte única: `tool-arguments.ts`), do catálogo core sempre publicado
// (`tool-discovery.ts`) e do guia de uso. Três níveis:
//   1. a função pura: campo de objeto/lista que chega como TEXTO com JSON é decodificado e revalidado pelo schema; o que não é JSON do tipo
//      esperado, o texto legítimo, o limite de tamanho e a profundidade seguem como erro ou intactos;
//   2. as ferramentas reais (`table_create`, `table_write`, `propose_routine`, `discover_tools`): o formato que o modelo errou na conversa real
//      agora passa, e o erro que sobra diz o que se esperava, sem ecoar o valor;
//   3. o motor real com o provedor falso: a mesma chamada com texto no lugar de objeto executa (tabela, escrita, ação do conector) e o catálogo
//      core vai ao modelo sem `discover_tools`.
import { randomUUID } from 'node:crypto';
import { tableCreateSchema, tableWriteSchema } from '@aion/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TableService } from '../tables/service';
import { tableMarker } from '../testing/fake-upstreams';
import { activityReadTool } from './activity-read';
import { docTools } from './doc-tools';
import { editMemoryTool } from './edit-memory';
import { proposeRoutineTool } from './propose-routine';
import { readAttachmentTool } from './read-attachment';
import { getRoutineTool, listRoutinesTool, proposeRoutineChangeTool } from './routine-tools';
import { searchHistoryTool } from './search-history';
import { updateObjectiveTool } from './update-objective';
import { RUN_PYTHON_TOOL } from './run-python';
import { GeneralChatService } from '../general-chat/service';
import { createRunsWorld, type RunsWorld } from './test-support';
import { describeArgumentIssues, modelJsonSchema, parseToolArguments, TOOL_ARGUMENTS_MAX_BYTES } from './tool-arguments';
import { ABRIR_GRUPO, CORE_TOOLS, DEFAULT_MOST_USED, DISCOVER_TOOLS, READ_ACTIVITY, USE_TOOL, readToolSelectionHistory } from './tool-discovery';

/** Teto de regressão, em caracteres, das definições que o bot publica no pedido inicial (portas e mais usadas, ~20,7 mil medidos em 07/11/2026 sem conector; o catálogo core de antes pesava até 29.000). */
const TOOLS_CHARS_CEILING = 22_000;
import { tableTools } from './table-tools';
import { ToolFailure, type ToolHandler } from './tools';

const owner = { kind: 'owner' } as const;
const tool = (name: string): ToolHandler => tableTools.find((handler) => handler.definition.name === name)!;
/** A mensagem de falha de `prepare` (texto seguro que o modelo recebe), ou nulo se os argumentos passaram. */
function failureOf(handler: ToolHandler, args: unknown): string | null {
  try {
    handler.prepare(typeof args === 'string' ? args : JSON.stringify(args));
    return null;
  } catch (error) {
    if (error instanceof ToolFailure) return error.message;
    throw error;
  }
}

/** O texto da mensagem dentro do envelope {code, message} que toda recusa de argumentos usa (A21), ou nulo se os argumentos passaram. */
function plainOf(handler: ToolHandler, args: unknown): string | null {
  const raw = failureOf(handler, args);
  return raw === null ? null : (JSON.parse(raw) as { message: string }).message;
}

describe('parseToolArguments: JSON dentro de texto', () => {
  const schema = z.strictObject({
    name: z.string(),
    items: z.array(z.strictObject({ id: z.number() })),
    settings: z.record(z.string(), z.unknown()).default({}),
    note: z.union([z.string(), z.array(z.string())]).optional(),
  });
  const native = { name: 'a', items: [{ id: 1 }], settings: { x: [1, 2] } };

  it('objeto e lista enviados como texto com o JSON válido dão o MESMO resultado da forma nativa', () => {
    const expected = parseToolArguments(schema, JSON.stringify(native));
    expect(expected).toMatchObject({ ok: true, data: native });
    const text = parseToolArguments(schema, JSON.stringify({ ...native, items: JSON.stringify(native.items), settings: JSON.stringify(native.settings) }));
    expect(text).toEqual(expected);
    // Argumentos vazios continuam valendo como objeto vazio (ferramenta sem parâmetros).
    expect(parseToolArguments(z.strictObject({}), '')).toMatchObject({ ok: true });
  });

  it('várias camadas são desfeitas até o limite (3); a quarta camada segue recusada', () => {
    const nested = z.strictObject({ a: z.strictObject({ b: z.strictObject({ c: z.strictObject({ d: z.array(z.number()) }) }) }) });
    expect(parseToolArguments(nested, JSON.stringify({ a: { b: { c: { d: [1] } } } })).ok).toBe(true);
    // a, b e c como texto: três camadas, uma por rodada.
    const threeLayers = JSON.stringify({ a: JSON.stringify({ b: JSON.stringify({ c: { d: [1] } }) }) });
    expect(parseToolArguments(nested, threeLayers)).toMatchObject({ ok: true, data: { a: { b: { c: { d: [1] } } } } });
    // Quatro camadas (d também como texto, dentro de c, dentro de b, dentro de a): excede o limite de rodadas.
    const fourLayers = JSON.stringify({ a: JSON.stringify({ b: JSON.stringify({ c: JSON.stringify({ d: '[1]' }) }) }) });
    expect(parseToolArguments(nested, fourLayers)).toMatchObject({ ok: false, reason: 'invalid_arguments' });
  });

  it('o próprio objeto inteiro enviado como texto (camada raiz) também é decodificado', () => {
    expect(parseToolArguments(schema, JSON.stringify(JSON.stringify(native)))).toMatchObject({ ok: true, data: native });
  });

  it('texto que não é JSON do tipo esperado continua erro: não-JSON, tipo trocado, escalar', () => {
    for (const items of ['abc', '{"id":1}', '"[]"', '5', 'null', '[{"id":"x"}]', '[{"id":1},']) {
      expect(parseToolArguments(schema, JSON.stringify({ ...native, items })), items).toMatchObject({ ok: false, reason: 'invalid_arguments' });
    }
    for (const settings of ['[1]', 'texto', '7']) {
      expect(parseToolArguments(schema, JSON.stringify({ ...native, settings })), settings).toMatchObject({ ok: false, reason: 'invalid_arguments' });
    }
    expect(parseToolArguments(schema, '{')).toEqual({ ok: false, reason: 'invalid_json' });
  });

  it('texto que o schema aceita como texto nunca é decodificado (uma célula pode ser "[\\"a\\"]" de verdade)', () => {
    expect(parseToolArguments(schema, JSON.stringify({ ...native, note: '["a"]' }))).toMatchObject({ ok: true, data: { note: '["a"]' } });
  });

  it('decodificar não afrouxa o schema: campos extras e valores inválidos dentro do JSON decodificado seguem recusados', () => {
    expect(parseToolArguments(schema, JSON.stringify({ ...native, items: JSON.stringify([{ id: 1, extra: true }]) }))).toMatchObject({ ok: false, reason: 'invalid_arguments' });
    expect(parseToolArguments(schema, JSON.stringify({ ...native, items: '[]', outro: 1 }))).toMatchObject({ ok: false, reason: 'invalid_arguments' });
  });

  it('o limite de corpo vale antes de qualquer parse e protege também o que está dentro do texto', () => {
    const big = JSON.stringify({ ...native, items: JSON.stringify([{ id: 1 }]), name: 'x'.repeat(TOOL_ARGUMENTS_MAX_BYTES) });
    expect(parseToolArguments(schema, big)).toEqual({ ok: false, reason: 'too_large' });
    const huge = `{"name":"a","items":${JSON.stringify(JSON.stringify(Array.from({ length: 40_000 }, () => ({ id: 1 }))))},"settings":{}}`;
    expect(Buffer.byteLength(huge)).toBeLessThan(TOOL_ARGUMENTS_MAX_BYTES);
    expect(parseToolArguments(schema, huge)).toMatchObject({ ok: true });
  });

  it('um JSON hostil dentro do texto não altera protótipos', () => {
    const result = parseToolArguments(schema, JSON.stringify({ ...native, settings: '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}' }));
    expect((({}) as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(Object.create(null) as object)).toBeNull();
    if (result.ok) expect(Object.getPrototypeOf(result.data.settings)).toBe(Object.prototype);
  });
});

describe('mensagem de erro: o que se esperava, sem ecoar o valor', () => {
  const routine = { name: 'Lembrete', instruction: 'Lembrar do evento.' };

  it('agenda em texto livre ou cron solto (os dois erros da conversa real) apontam o formato esperado', () => {
    const message = 'Argumentos inválidos (schedule: esperado objeto com type = once|interval|daily|weekly|monthly_day|monthly_business_day|monthly_position|yearly|cron).';
    expect(plainOf(proposeRoutineTool, { ...routine, schedule: 'Todos os dias às 09:00' })).toBe(message);
    expect(plainOf(proposeRoutineTool, { ...routine, schedule: '0 9 * * *' })).toBe(message);
    expect(plainOf(proposeRoutineTool, { ...routine, schedule: { type: 'diario', times: ['09:00'] } })).toBe('Argumentos inválidos (schedule.type: esperado um de once|interval|daily|weekly|monthly_day|monthly_business_day|monthly_position|yearly|cron).');
    // A forma certa, nativa ou como texto JSON, passa.
    expect(failureOf(proposeRoutineTool, { ...routine, schedule: { type: 'daily', times: ['09:00'] } })).toBeNull();
    expect(failureOf(proposeRoutineTool, { ...routine, schedule: '{"type":"daily","times":["09:00"]}' })).toBeNull();
    expect(failureOf(proposeRoutineTool, { ...routine, schedule: '{"type":"cron","expression":"0 9 * * *"}' })).toBeNull();
  });

  it('campo obrigatório ausente, tipo errado e valor fora das opções dizem o que faltou', () => {
    expect(plainOf(proposeRoutineTool, { instruction: 'x', schedule: { type: 'daily', times: ['09:00'] } })).toBe('Argumentos inválidos (name: obrigatório).');
    expect(plainOf(proposeRoutineTool, { ...routine, schedule: { type: 'daily', times: ['09:00'] }, maxRuns: 'muitas' })).toBe('Argumentos inválidos (maxRuns: esperado número).');
    const envelope = JSON.parse(failureOf(tool('table_create'), { name: 'Tarefas', columns: 'não é json', operationId: randomUUID() })!) as { code: string; message: string };
    expect(envelope).toEqual({ code: 'VALIDATION_FAILED', message: 'Argumentos inválidos (columns: esperado lista).' });
  });

  it('A21: toda recusa de argumentos, de qualquer ferramenta, usa o mesmo envelope {code, message}, com o mesmo código para JSON quebrado, campo errado e corpo grande', () => {
    // propose_routine e search_history não declaravam envelope: a recusa saía em texto puro, e só as ferramentas de tabela e doc a davam em JSON.
    const envelope = (handler: ToolHandler, args: unknown) => JSON.parse(failureOf(handler, args)!) as { code: string; message: string };
    expect(envelope(proposeRoutineTool, { ...routine, schedule: 'Todos os dias' })).toEqual({ code: 'VALIDATION_FAILED', message: expect.stringContaining('Argumentos inválidos (schedule') });
    expect(envelope(searchHistoryTool, '{quebrado')).toEqual({ code: 'VALIDATION_FAILED', message: 'Os argumentos não são um JSON válido.' });
    expect(envelope(searchHistoryTool, { query: 'x'.repeat(2 * 1024 * 1024) })).toEqual({ code: 'PAYLOAD_TOO_LARGE', message: 'Os argumentos excedem o limite permitido.' });
    expect(envelope(tool('table_get'), {})).toEqual({ code: 'VALIDATION_FAILED', message: 'Argumentos inválidos (tableId: obrigatório).' });
  });

  it('A21: o catálogo interno tem uma só forma de paginação (offset, limit e nextOffset) e um só nome para o id de anexo; cursor opaco fica só nas ferramentas de tabela', () => {
    const catalog = [searchHistoryTool, readAttachmentTool, editMemoryTool, updateObjectiveTool, proposeRoutineTool, listRoutinesTool, getRoutineTool, proposeRoutineChangeTool, activityReadTool, ...tableTools, ...docTools];
    const params = (handler: ToolHandler) => Object.keys((handler.definition.parameters.properties as Record<string, unknown> | undefined) ?? {});
    // Nenhuma outra forma de continuar uma página existe: before/nextBefore, page, after e afins foram trocados por offset.
    const foreign = catalog.filter((handler) => params(handler).some((name) => /^(before|after|page|pageToken|startAfter|since|from|nextBefore)$/u.test(name)));
    expect(foreign.map((handler) => handler.definition.name)).toEqual([]);
    // Cursor opaco é do serviço compartilhado de tabelas (o contrato da API de tabelas não muda; `table_query` o leva aninhado em `query`): no topo são exatamente estas.
    const cursors = catalog.filter((handler) => params(handler).some((name) => /cursor/iu.test(name))).map((handler) => handler.definition.name);
    expect(cursors.sort()).toEqual(['table_get', 'table_list'].sort());
    // Quem tem limit por página (fora as de cursor) tem também offset.
    const limited = catalog.filter((handler) => params(handler).includes('limit') && !cursors.includes(handler.definition.name));
    expect(limited.length).toBeGreaterThanOrEqual(3);
    for (const handler of limited) expect(params(handler), handler.definition.name).toContain('offset');
    // O id do anexo se chama attachmentId em toda ferramenta (attachment_id, em snake_case, não existe mais no que o modelo recebe).
    expect(catalog.filter((handler) => params(handler).includes('attachment_id')).map((handler) => handler.definition.name)).toEqual([]);
    expect(catalog.filter((handler) => params(handler).includes('attachmentId')).map((handler) => handler.definition.name)).toEqual(['read_attachment', 'table_import_attachment']);
  });

  it('nunca ecoa o valor recebido e respeita o teto de 640 caracteres, mesmo com 100 campos inválidos', () => {
    const secret = 'SEGREDO-DO-DONO-123';
    expect(failureOf(proposeRoutineTool, { ...routine, schedule: secret })).not.toContain(secret);
    const many = z.strictObject(Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`campo_com_nome_comprido_${index}`, z.object({ valor: z.string() })])));
    const parsed = parseToolArguments(many, JSON.stringify(Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`campo_com_nome_comprido_${index}`, secret]))));
    expect(parsed.ok).toBe(false);
    if (parsed.ok || parsed.reason !== 'invalid_arguments') throw new Error('esperava erro de schema');
    const message = describeArgumentIssues(parsed.issues, parsed.value);
    expect(message.length).toBeLessThanOrEqual(640);
    expect(message).toMatch(/^Argumentos inválidos \(campo_com_nome_comprido_0: esperado objeto, .*; mais \d+ campos, 100 no total\)\.$/);
    expect(message).not.toContain(secret);
  });
});

describe('schema publicado ao modelo (modelJsonSchema)', () => {
  it('tira só o que repete a validação do servidor (regex de uuid, de texto sem controles e $schema) e mantém o que o modelo segue', () => {
    const schema = z.strictObject({ id: z.uuid(), name: z.string().trim().min(1).max(80).regex(/^[^\p{Cc}]*$/u), at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), kind: z.enum(['a', 'b']) });
    const raw = z.toJSONSchema(schema, { io: 'input' });
    const compact = modelJsonSchema(schema) as { $schema?: string; properties: Record<string, Record<string, unknown>> };
    expect(JSON.stringify(raw)).toContain('"pattern":"^([0-9a-fA-F]');
    expect(compact.$schema).toBeUndefined();
    expect(compact.properties.id).toEqual({ type: 'string', format: 'uuid' });
    expect(compact.properties.name).toEqual({ type: 'string', minLength: 1, maxLength: 80 });
    expect(compact.properties.at).toMatchObject({ pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }); // HH:mm é formato que o modelo precisa seguir
    expect(compact.properties.kind).toMatchObject({ enum: ['a', 'b'] });
    // Descrição longa idêntica (um schema reutilizado em dois lugares) aparece uma vez; a curta e a diferente ficam onde estão.
    const long = 'Descrição longa que se repete porque o mesmo schema é usado em dois campos do mesmo objeto. '.repeat(2);
    const reused = z.strictObject({ first: z.string().describe(long), second: z.string().describe(long), third: z.string().describe('curta') , fourth: z.string().describe('curta') });
    const properties = (modelJsonSchema(reused) as { properties: Record<string, { description?: string }> }).properties;
    expect([properties.first!.description, properties.second!.description, properties.third!.description, properties.fourth!.description]).toEqual([long, undefined, 'curta', 'curta']);
    // Nas ferramentas de tabela o efeito é grande: cada campo de id carregava ~190 caracteres de regex.
    const write = JSON.stringify(tool('table_write').definition.parameters);
    expect(write).not.toContain('0-9a-fA-F');
    expect(write).toContain('"format":"uuid"');
    expect(write.length).toBeLessThan(JSON.stringify(z.toJSONSchema(z.strictObject({ tableId: z.uuid(), input: tableWriteSchema }), { io: 'input', unrepresentable: 'any' })).length * 0.8);
  });
});

describe('ferramentas reais aceitam o formato que o modelo errou na conversa real', () => {
  const operationId = randomUUID();
  const columns = [{ name: 'Tarefa', type: 'text' }, { name: 'Prazo', type: 'date' }];

  it('table_create com columns em texto e table_write com input (e creates) em texto passam e equivalem à forma nativa', () => {
    expect(failureOf(tool('table_create'), { name: 'Tarefas', columns: JSON.stringify(columns), operationId })).toBeNull();
    const write = { operationId, expectedSchemaVersion: 1, creates: [{ values: { [randomUUID()]: 'Comprar presente' } }] };
    const tableId = randomUUID();
    expect(failureOf(tool('table_write'), { tableId, input: JSON.stringify(write) })).toBeNull();
    expect(failureOf(tool('table_write'), { tableId, input: JSON.stringify({ ...write, creates: JSON.stringify(write.creates) }) })).toBeNull();
    // A leitura compartilhada devolve exatamente o objeto da forma nativa (o que a execução, o recibo e a retomada enxergam).
    const text = parseToolArguments(tableCreateSchema, JSON.stringify({ name: 'Tarefas', columns: JSON.stringify(columns), operationId }));
    const nativeForm = parseToolArguments(tableCreateSchema, JSON.stringify({ name: 'Tarefas', columns, operationId }));
    expect(text).toEqual(nativeForm);
    expect(nativeForm.ok).toBe(true);
    expect(parseToolArguments(tableWriteSchema, JSON.stringify(write)).ok).toBe(true);
  });

  it('id de registro aceita o id curto de table_query e recusa o que não é prefixo de UUID, sem mexer no contrato compartilhado', () => {
    const tableId = randomUUID(); const operationId = randomUUID();
    const write = (id: string) => ({ tableId, input: { operationId, expectedSchemaVersion: 1, updates: [{ id, expectedVersion: 1, values: {} }] } });
    for (const id of ['a1b2c3d4', 'A1B2C3D4', 'a1b2c3d4-e5', randomUUID()]) expect(failureOf(tool('table_write'), write(id)), id).toBeNull();
    for (const id of ['a1b2c3d', '', 'a1b2c3d4e5f6', "a1b2c3d4'; DROP TABLE x;--", `${randomUUID()}0`, 'g1b2c3d4']) expect(JSON.parse(failureOf(tool('table_write'), write(id))!), id).toMatchObject({ code: 'VALIDATION_FAILED' });
    // O mesmo registro por duas grafias é lista repetida, também na escrita.
    expect(JSON.parse(failureOf(tool('table_write'), { tableId, input: { operationId, expectedSchemaVersion: 1, updates: [{ id: 'a1b2c3d4', expectedVersion: 1, values: {} }, { id: 'A1B2C3D4', expectedVersion: 1, values: {} }] } })!)).toMatchObject({ code: 'VALIDATION_FAILED' });
    // table_query (recordIds) e table_prepare_operation (delete_records) aceitam o prefixo; as demais categorias de preparação continuam como eram.
    expect(failureOf(tool('table_query'), { tableId, query: { recordIds: ['a1b2c3d4'] } })).toBeNull();
    expect(failureOf(tool('table_query'), { tableId, query: { recordIds: ['a1b2c3d'] } })).not.toBeNull();
    const prepare = (operation: unknown) => failureOf(tool('table_prepare_operation'), { tableId, operation });
    expect(prepare({ kind: 'delete_records', expectedVersion: 1, records: [{ id: 'a1b2c3d4', expectedVersion: 1 }] })).toBeNull();
    expect(prepare({ kind: 'delete_records', expectedVersion: 1, records: [{ id: 'a1b2c3d', expectedVersion: 1 }] })).not.toBeNull();
    expect(prepare({ kind: 'delete_table', expectedVersion: 1 })).toBeNull();
    expect(prepare({ kind: 'delete_column', expectedVersion: 1, columnId: randomUUID() })).toBeNull();
    expect(prepare({ kind: 'convert_column', expectedVersion: 1, column: { id: randomUUID(), name: 'C', type: 'text' } })).toBeNull();
    // O contrato compartilhado (API e serviço) continua exigindo o UUID completo.
    expect(tableWriteSchema.safeParse({ operationId, expectedSchemaVersion: 1, updates: [{ id: 'a1b2c3d4', expectedVersion: 1, values: {} }] }).success).toBe(false);
    // O schema publicado ao modelo trata o id como texto de 8 a 36 caracteres, não como uuid.
    for (const name of ['table_write', 'table_query', 'table_prepare_operation']) {
      const published = JSON.stringify(tool(name).definition.parameters);
      expect(published, name).toContain('"minLength":8,"maxLength":36');
    }
  });

  it('a seleção de discover_tools com names em texto vale também na releitura do catálogo da conversa', async () => {
    const db = (toolArguments: string | null) => ({ query: async () => ({ rows: [{ tool_arguments: toolArguments }], rowCount: 1 }) }) as never;
    expect((await readToolSelectionHistory(db(JSON.stringify({ names: JSON.stringify(['table_update', 'get_routine']) })), '1')).names).toEqual(['table_update', 'get_routine']);
    expect((await readToolSelectionHistory(db(JSON.stringify({ names: ['table_update'] })), '1')).names).toEqual(['table_update']);
    expect((await readToolSelectionHistory(db(JSON.stringify({ names: 'table_update' })), '1')).names).toEqual([]);
    expect((await readToolSelectionHistory(db(null), '1')).names).toEqual([]);
  });
});

describe('motor real: chamada com texto no lugar de objeto executa; catálogo core sem discover_tools', () => {
  /** Resultado (texto) da atividade da execução. */
  const activityOf = async (world: RunsWorld, runId: string) =>
    (await world.pool.query<{ status: string; content: string }>("SELECT status, content FROM messages WHERE run_id=$1 AND kind='activity' ORDER BY id", [runId])).rows;

  it('table_create com columns em texto cria a tabela; table_write com input e creates em texto grava o registro; a ação do conector com arguments em texto executa com o objeto', async () => {
    const world = await createRunsWorld();
    try {
      await world.connectComposio();
      await world.pool.query("INSERT INTO approval_actions (slug, app_slug, app_name, label, global_rule, first_seen_at, last_seen_at) VALUES ('GMAIL_SEND_EMAIL', 'gmail', 'Gmail', 'GMAIL_SEND_EMAIL', 'allow', now(), now()) ON CONFLICT (slug) DO UPDATE SET global_rule = 'allow'");
      world.engine.start();
      const bot = await world.createBot();
      await world.releaseConnectorAccounts(bot);
      const service = new TableService({ pool: world.pool });
      const run = async (name: string, args: unknown) => {
        const id = await world.send(bot, tableMarker(name, args));
        await world.waitForStatus(id, 'completed');
        return activityOf(world, id);
      };

      const created = await run('table_create', { name: 'Tarefas em texto', columns: JSON.stringify([{ name: 'Tarefa', type: 'text' }, { name: 'Prazo', type: 'date' }]), operationId: randomUUID() });
      expect(created[0]).toMatchObject({ status: 'completed' });
      const { id: tableId, schemaVersion, columns } = JSON.parse(created[0]!.content) as { id: string; schemaVersion: number; columns: { id: string; name: string }[] };
      expect(columns.map((column) => column.name)).toEqual(['Tarefa', 'Prazo']);
      expect((await service.list({ kind: 'bot', botId: bot.id })).tables.map((table) => table.id)).toContain(tableId);

      const [taskColumn, dueColumn] = columns.map((column) => column.id) as [string, string];
      const records = JSON.stringify([{ values: { [taskColumn]: 'Comprar presente', [dueColumn]: '2026-11-07' } }]);
      const written = await run('table_write', { tableId, input: JSON.stringify({ operationId: randomUUID(), expectedSchemaVersion: schemaVersion, creates: records }) });
      expect(written[0]).toMatchObject({ status: 'completed' });
      const stored = await service.query(tableId, { columns: [taskColumn, dueColumn] }, owner);
      expect(stored.records.map((record) => record.values)).toEqual([{ [taskColumn]: 'Comprar presente', [dueColumn]: '2026-11-07' }]);

      const before = world.composioExecutions().length;
      const sent = await run('composio_execute_action', { action: 'GMAIL_SEND_EMAIL', arguments: JSON.stringify({ to: 'dono@example.com', subject: 'Relatório', body: 'Olá' }) });
      expect(sent[0]).toMatchObject({ status: 'completed' });
      const executions = world.composioExecutions().slice(before);
      expect(executions).toHaveLength(1);
      expect((executions[0]!.body as { arguments: unknown }).arguments).toEqual({ to: 'dono@example.com', subject: 'Relatório', body: 'Olá' });

      // Argumentos do conector que não são um objeto JSON: a falha diz o que se esperava e nada executa.
      const refused = await run('composio_execute_action', { action: 'GMAIL_SEND_EMAIL', arguments: 'para=dono@example.com' });
      expect(refused[0]).toMatchObject({ status: 'failed', content: JSON.stringify({ code: 'VALIDATION_FAILED', message: 'Argumentos inválidos (arguments: esperado objeto).' }) });
      expect(world.composioExecutions().slice(before)).toHaveLength(1);

      // A chamada pela porta use_tool com arguments em texto (o JSON do objeto) é decodificada como em qualquer ferramenta: o alvo recebe o objeto e executa.
      const viaPort = await run('use_tool', { name: 'table_get', arguments: JSON.stringify({ tableId }) });
      expect(viaPort[0]).toMatchObject({ status: 'completed' });
      expect(JSON.parse(viaPort[0]!.content)).toMatchObject({ id: tableId });
    } finally {
      await world.cleanup();
    }
  });

  it('com o catálogo core ligado, o bot publica as portas e as mais usadas (tabelas, memória e rotinas) e o resto mora na árvore de grupos; o Chat geral segue com as core e discover_tools', async () => {
    const world = await createRunsWorld({ coreCatalog: true });
    try {
      world.engine.start();
      // Janela de 128k: o assunto é o catálogo; o peso dele (estimativa sem calibração, 1 byte por token) é medido abaixo, em caracteres.
      const bot = await world.createBot({ contextWindowTokens: 131072 });
      await world.waitForStatus(await world.send(bot, 'oi'), 'completed');
      const request = world.conversationRequests().at(-1)!.body as { tools: { function: { name: string; description: string } }[]; messages: { content: string }[] };
      const offered = request.tools.map((entry) => entry.function.name);
      // Bot (phase 15, passo 11): as portas, depois a lista padrão das mais usadas (DEFAULT_MOST_USED, a parte que o passo 12 recalcula por bot).
      expect(offered).toEqual([ABRIR_GRUPO, USE_TOOL, READ_ACTIVITY, ...DEFAULT_MOST_USED]);
      // O índice da árvore (seção "Ferramentas fora da sua lista" do turno de sistema, phase 15, passo 12) lista o catálogo inteiro por galho, sem marcar o que já está na lista: estrutura de tabela, importação, exclusões, gestão de rotinas, docs.
      const index = request.messages[0]!.content;
      for (const name of ['table_update', 'get_routine', 'table_delete_table', 'doc_list', 'table_import_attachment', 'update_objective', 'search_history', ...DEFAULT_MOST_USED]) expect(index).toContain(name);
      // Nenhuma core do Chat geral se perde por deriva de nome: cada uma está na lista ou no índice do bot (run_python só com o sandbox, que este mundo não tem).
      for (const name of [...CORE_TOOLS].filter((item) => item !== RUN_PYTHON_TOOL)) expect(offered.includes(name) || index.includes(name), name).toBe(true);

      // Custo do catálogo base publicado (reenviado a cada etapa; estável, então fica em cache): teto de regressão em caracteres (o catálogo core de antes pesava até 29.000).
      const toolsChars = JSON.stringify(request.tools.map((entry) => entry.function)).length;
      expect(toolsChars).toBeLessThan(TOOLS_CHARS_CEILING);

      // Uma ferramenta fora da lista, chamada direto pelo nome, executa (o executor resolve pelo registry da execução; a porta use_tool é o caminho oficial).
      const run = await world.send(bot, tableMarker('table_list', {}));
      await world.waitForStatus(run, 'completed');
      expect((await activityOf(world, run))[0]).toMatchObject({ status: 'completed' });

      // Chat geral: só as core que existem lá (sem memória, objetivo, rotinas nem tabelas).
      await world.pool.query('UPDATE app_settings SET general_chat_context_window_tokens = 131072');
      const session = await new GeneralChatService({ pool: world.pool }).create();
      await world.conversations.setPreference({ sessionId: session.id }, 'opencode/glm-5.1', null);
      await world.waitForStatus((await world.conversations.send({ sessionId: session.id }, 'oi')).id, 'completed');
      const general = (world.conversationRequests().at(-1)!.body as { tools: { function: { name: string } }[] }).tools.map((entry) => entry.function.name);
      expect(general).toEqual([DISCOVER_TOOLS, READ_ACTIVITY, 'search_history', 'read_attachment']);
    } finally {
      await world.cleanup();
    }
  });
});

// A12 (phase 15, passo 4, Q1): a recusa de argumentos diz o MOTIVO de cada campo. Antes, `table_write`, `table_query`, `table_update` e `table_formula_preview` falhavam com só o caminho
// ("Argumentos inválidos (input.creates.0.values.Nome)") e o modelo repetia o mesmo erro; os casos abaixo são os formatos que o modelo errou no banco de testes com o modelo real.
describe('A12: a recusa de argumentos diz o motivo (tabelas e conector)', () => {
  const id = randomUUID();
  const write = (input: Record<string, unknown>) => failureOf(tool('table_write'), { tableId: id, input: { operationId: id, expectedSchemaVersion: 1, ...input } });
  const query = (queryBody: Record<string, unknown>) => failureOf(tool('table_query'), { tableId: id, query: queryBody });
  const messageOf = (raw: string | null): string => (JSON.parse(raw!) as { message: string }).message;

  it('A12: texto com número ou booleano no lugar do número ou booleano do schema é aceito; texto que não é o literal, não', () => {
    const schema = z.strictObject({ limit: z.number().int(), flag: z.boolean(), label: z.string() });
    expect(parseToolArguments(schema, JSON.stringify({ limit: '10', flag: 'true', label: '5' }))).toEqual({ ok: true, data: { limit: 10, flag: true, label: '5' } });
    expect(parseToolArguments(schema, JSON.stringify({ limit: ' 7 ', flag: 'FALSE', label: 'x' }))).toEqual({ ok: true, data: { limit: 7, flag: false, label: 'x' } });
    for (const bad of [{ limit: 'dez' }, { limit: '1e3' }, { limit: '' }, { flag: 'sim' }, { limit: '10.5' }]) expect(parseToolArguments(schema, JSON.stringify({ limit: 1, flag: true, label: 'x', ...bad })).ok, JSON.stringify(bad)).toBe(false);
    // O contrário nunca acontece: número JSON não vira texto (decimais exatos de tabela perderiam dígitos).
    expect(parseToolArguments(schema, JSON.stringify({ limit: 1, flag: true, label: 5 })).ok).toBe(false);
  });

  it('A12: table_write — chave com o nome da coluna, número JSON na célula, operationId fora do formato e campo extra dizem o que corrigir, sem ecoar o valor', () => {
    const byName = messageOf(write({ creates: [{ values: { Nome: 'Ana Privada' } }] }));
    expect(byName).toContain('input.creates.0.values.Nome: chave não é UUID');
    expect(byName).toContain('Chave = UUID da coluna, nunca o nome');
    expect(byName).not.toContain('Ana Privada');
    const asNumber = messageOf(write({ creates: [{ values: { [id]: 12.5 } }] }));
    expect(asNumber).toContain(`input.creates.0.values.${id}: esperado texto`);
    expect(asNumber).toContain('número e dinheiro como texto');
    expect(messageOf(write({ operationId: 'op-1', creates: [] }))).toContain('input.operationId: esperado UUID v4 (3º grupo começa com 4; 4º com 8, 9, a ou b)');
    expect(messageOf(write({ creates: [{ values: { [id]: 'x' }, extra: 1 }] }))).toContain('input.creates.0: campo não aceito: extra (aceitos: values, deduplicationKey)');
    // A mesma célula em updates também traz a dica (a descrição vale para as duas listas).
    expect(messageOf(write({ updates: [{ id, expectedVersion: 1, values: { Nome: 'x' } }] }))).toContain('Chave = UUID da coluna, nunca o nome');
  });

  it('A12: table_query e vistas — operador em maiúsculas, nome no lugar do UUID, número JSON, filtro plural e campo desconhecido dizem o motivo', () => {
    expect(messageOf(query({ filter: { op: 'EQ', columnId: id, value: 'a' } }))).toContain('query.filter: op deve ser um de eq|ne|lt|lte|gt|gte|contains|includes|empty|not_empty|and|or, em minúsculas');
    expect(messageOf(query({ filter: { op: 'eq', columnId: 'Nome', value: 'a' } }))).toContain('columnId deve ser o UUID da coluna (de table_get), não o nome');
    expect(messageOf(query({ filter: { op: 'gt', columnId: id, value: 100 } }))).toContain('value não pode ser número JSON');
    expect(messageOf(query({ filter: { op: 'and', filters: [] } }))).toContain('filters é uma lista de 1 a 20 filtros');
    expect(messageOf(query({ filter: { op: 'eq', columnId: id } }))).toContain('falta value');
    expect(messageOf(query({ filters: [{ op: 'eq', columnId: id, value: 'a' }] }))).toContain('query: campo não aceito: filters (aceitos: columns, filter, sort');
    expect(query({ filter: { op: 'and', filters: [{ op: 'eq', columnId: id, value: 'a' }, { op: 'lt', columnId: id, value: '2026-11-01' }] }, limit: '10' })).toBeNull();
    expect(messageOf(failureOf(tool('table_view_create'), { tableId: id, input: { name: 'V', operationId: id, filter: { op: 'gt', columnId: id, value: 5 } } }))).toContain('input.filter: value não pode ser número JSON');
  });

  it('A12: table_formula_preview e table_update — operador em minúsculas, número JSON no literal, ref sem columnId, fórmula em texto e versão fora de input dizem o motivo', () => {
    const preview = (formula: unknown) => messageOf(failureOf(tool('table_formula_preview'), { tableId: id, input: { resultType: 'number', formula } }));
    expect(preview({ kind: 'literal', type: 'number', value: 1 })).toContain('literal.value não pode ser número JSON');
    expect(preview({ kind: 'call', op: 'subtract', args: [] })).toContain('op deve ser um de ADD|SUBTRACT');
    expect(preview({ kind: 'ref', column: id })).toContain('ref leva columnId com o UUID da coluna');
    expect(preview('Realizado - Previsto')).toContain('fórmula escrita como texto não vale');
    expect(failureOf(tool('table_formula_preview'), { tableId: id, input: { resultType: 'number', formula: { kind: 'call', op: 'ADD', args: [{ kind: 'ref', columnId: id }, { kind: 'literal', type: 'number', value: '1' }] } } })).toBeNull();
    const misplaced = messageOf(failureOf(tool('table_update'), { tableId: id, expectedSchemaVersion: 1, operationId: id, input: { columns: [] } }));
    expect(misplaced).toContain('input.expectedSchemaVersion: obrigatório');
    expect(misplaced).toContain('argumentos: campo não aceito: expectedSchemaVersion, operationId (aceitos: tableId, input)');
  });
});

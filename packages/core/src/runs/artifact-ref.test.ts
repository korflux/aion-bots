// Referência do artefato na atividade das ferramentas que criam ou alteram uma tabela ou um doc (phase 14, passo 4; A4). Motor real, PostgreSQL real e o provedor falso, que só
// roteiriza as chamadas de ferramenta. O que o dono e a conversa observam:
//   - a atividade de criação e de alteração fecha com `artifacts` (tipo, id e título lido no servidor); a de leitura, a que falha e a que não mudou nada não trazem o campo;
//   - a referência nunca vira linha `kind = 'card'` (a bolinha de não lido e o push só contam cartões de sistema e a resposta do bot, `VISIBLE_NEWS_SQL`);
//   - a visão da mensagem (`toMessageView`, a conversão única do snapshot, da paginação e do SSE) leva o campo e passa pelo contrato `activityMessageSchema`.
// A importação por anexo tem a prova própria no nível do handler (a mesma fixture do importador): uma chamada pode alterar várias tabelas.
import { randomUUID } from 'node:crypto';
import { activityMessageSchema, tableCreateSchema, type ArtifactRef, type Bot } from '@aion/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AttachmentService } from '../attachments/service';
import { DocService } from '../docs';
import { MESSAGE_COLUMNS, toMessageView, type MessageRow } from '../conversation/views';
import { VISIBLE_NEWS_SQL } from '../presence/service';
import type { ChatEvent } from '../models/chat-protocols';
import { TableService } from '../tables/service';
import { tableMarker } from '../testing/fake-upstreams';
import { tableTools } from './table-tools';
import { ORIGIN, createRunsWorld, type RunsWorld } from './test-support';
import type { ToolContext } from './tools';

const owner = { kind: 'owner' } as const;
let world: RunsWorld;
let docs: DocService;
let tables: TableService;
beforeAll(async () => {
  world = await createRunsWorld();
  docs = new DocService({ pool: world.pool });
  tables = new TableService({ pool: world.pool });
  await world.models.test('opencode/glm-5.1');
  world.engine.start();
}, 60_000);
afterAll(async () => { await world.cleanup(); });
afterEach(() => { vi.restoreAllMocks(); });

/** Tabela do dono já compartilhada com o bot, com uma coluna de texto (o id dela entra nas escritas). */
async function sharedTable(bot: Bot, name = 'Tarefas') {
  const table = await tables.create(tableCreateSchema.parse({ name, operationId: randomUUID(), columns: [{ name: 'Tarefa', type: 'text' }] }), owner, bot.id);
  return { table, column: table.columns[0]!.id };
}
/** Escrita de um registro na tabela, como o modelo a manda (cada chamada com a própria operação). */
const writeOf = (tableId: string, column: string, text: string) => ({ tableId, input: { operationId: randomUUID(), expectedSchemaVersion: 1, creates: [{ values: { [column]: text } }] } });

/** Roteiriza o modelo: `calls` são as chamadas de ferramenta, uma por etapa, e a última etapa responde em texto. */
function script(calls: { name: string; args: unknown }[]): void {
  vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request): AsyncGenerator<ChatEvent> {
    const step = request.turns.filter((turn) => turn.role === 'tool').length;
    const next = calls[step];
    if (next) yield { type: 'tool_call', id: `call-${step}`, name: next.name, arguments: JSON.stringify(next.args) };
    else yield { type: 'text', text: 'Pronto.' };
    yield { type: 'done', reason: 'stop' };
  });
}

interface ActivityRow { id: string; status: string; content: string; data: { tool: string; artifacts?: ArtifactRef[] } }
/** As atividades da execução, em ordem, como ficaram gravadas. */
const activitiesOf = async (run: string) => (await world.pool.query<ActivityRow>("SELECT id::text AS id, status, content, data FROM messages WHERE run_id = $1 AND kind = 'activity' ORDER BY id", [run])).rows;
/** Roda uma única chamada pelo motor e devolve a atividade dela. */
async function callOnce(bot: Bot, name: string, args: unknown): Promise<ActivityRow> {
  const run = await world.send(bot, tableMarker(name, args));
  await world.waitForStatus(run, 'completed');
  return (await activitiesOf(run))[0]!;
}

describe('referência do artefato na atividade (A4)', () => {
  it('a resposta que cria o doc "Plano" e altera duas vezes a tabela "Tarefas" deixa uma referência por criação e por alteração, nenhuma por leitura e nenhuma linha de cartão', async () => {
    const bot = await world.createBot();
    const { table, column } = await sharedTable(bot);
    const existing = await docs.create({ title: 'Existente', content: 'texto', botIds: [bot.id], operationId: randomUUID() }, owner);
    script([
      { name: 'doc_create', args: { title: 'Plano', content: '# Plano', operationId: randomUUID() } },
      { name: 'table_write', args: writeOf(table.id, column, 'primeira') },
      { name: 'doc_read', args: { docId: existing.id } },
      { name: 'table_write', args: writeOf(table.id, column, 'segunda') },
      { name: 'table_query', args: { tableId: table.id, query: { limit: 5 } } },
      { name: 'table_get', args: { tableId: table.id } },
    ]);
    const run = await world.send(bot, 'monte o plano e anote as tarefas');
    await world.waitForStatus(run, 'completed');

    const activities = await activitiesOf(run);
    expect(activities.map((activity) => [activity.data.tool, activity.status])).toEqual([
      ['doc_create', 'completed'], ['table_write', 'completed'], ['doc_read', 'completed'], ['table_write', 'completed'], ['table_query', 'completed'], ['table_get', 'completed'],
    ]);
    const planId = (JSON.parse(activities[0]!.content) as { id: string }).id;
    const planRef: ArtifactRef = { type: 'doc', id: planId, title: 'Plano' };
    const tableRef: ArtifactRef = { type: 'table', id: table.id, title: 'Tarefas' };
    expect(activities.map((activity) => activity.data.artifacts)).toEqual([[planRef], [tableRef], undefined, [tableRef], undefined, undefined]);
    // Dois artefatos distintos na resposta: é o que a conversa agrupa em dois cartões (um por artefato por resposta).
    const distinct = new Set(activities.flatMap((activity) => activity.data.artifacts ?? []).map((ref) => `${ref.type}:${ref.id}`));
    expect(distinct.size).toBe(2);

    // Sem cartão novo: nenhuma linha `kind = 'card'` na execução, e a única novidade visível (bolinha e push) é a resposta do bot.
    expect((await world.pool.query("SELECT 1 FROM messages WHERE run_id = $1 AND kind = 'card'", [run])).rowCount).toBe(0);
    const news = await world.pool.query<{ kind: string; role: string }>(`SELECT m.kind, m.role FROM messages m WHERE m.run_id = $1 AND ${VISIBLE_NEWS_SQL}`, [run]);
    expect(news.rows).toEqual([{ kind: 'text', role: 'assistant' }]);

    // A visão da mensagem leva a referência só na atividade que a tem, e passa pelo contrato.
    const rows = (await world.pool.query<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE run_id = $1 AND kind = 'activity' ORDER BY id`, [run])).rows;
    const views = rows.map((row) => activityMessageSchema.parse(toMessageView(row)));
    expect(views.map((view) => view.artifacts)).toEqual([[planRef], [tableRef], undefined, [tableRef], undefined, undefined]);
  }, 60_000);
});

describe('doc_* (A4)', () => {
  it('criar, acrescentar, substituir, reescrever e restaurar trazem a referência com o título gravado; ler, listar, ver versões, repetir sem mudança e excluir não trazem', async () => {
    const bot = await world.createBot();
    const created = await callOnce(bot, 'doc_create', { title: 'Do bot', content: 'v1', operationId: randomUUID() });
    const { id } = JSON.parse(created.content) as { id: string };
    const ref: ArtifactRef = { type: 'doc', id, title: 'Do bot' };
    expect(created.data.artifacts).toEqual([ref]);

    const append = await callOnce(bot, 'doc_append', { docId: id, expectedVersion: 1, text: 'v2', operationId: randomUUID() });
    expect(append.data.artifacts).toEqual([ref]);
    const replace = await callOnce(bot, 'doc_replace', { docId: id, expectedVersion: 2, find: 'v1', replacement: 'um', operationId: randomUUID() });
    expect(replace.data.artifacts).toEqual([ref]);
    const rewrite = await callOnce(bot, 'doc_rewrite', { docId: id, expectedVersion: 3, content: 'texto novo', operationId: randomUUID() });
    expect(rewrite.data.artifacts).toEqual([ref]);
    const restore = await callOnce(bot, 'doc_restore', { docId: id, version: 1, expectedVersion: 4, operationId: randomUUID() });
    expect(restore.data.artifacts).toEqual([ref]);

    // O título vem do servidor: o dono renomeia o doc e a próxima alteração do bot já traz o título atual.
    await docs.update(id, { expectedVersion: 5, title: 'Renomeado pelo dono', operationId: randomUUID() }, owner);
    const afterRename = await callOnce(bot, 'doc_append', { docId: id, expectedVersion: 5, text: 'v6', operationId: randomUUID() });
    expect(afterRename.data.artifacts).toEqual([{ ...ref, title: 'Renomeado pelo dono' }]);

    // Sem mudança (texto igual): nada foi alterado, nenhuma referência.
    const unchanged = await callOnce(bot, 'doc_restore', { docId: id, version: 6, expectedVersion: 6, operationId: randomUUID() });
    expect(JSON.parse(unchanged.content)).toMatchObject({ changed: false });
    expect(unchanged.data.artifacts).toBeUndefined();

    for (const [name, args] of [['doc_read', { docId: id }], ['doc_list', {}], ['doc_versions', { docId: id }]] as const) {
      expect((await callOnce(bot, name, args)).data.artifacts, name).toBeUndefined();
    }
    // A que falha (versão esperada antiga) também não traz: o doc não mudou.
    const stale = await callOnce(bot, 'doc_append', { docId: id, expectedVersion: 1, text: 'x', operationId: randomUUID() });
    expect(stale.status).toBe('failed');
    expect(stale.data.artifacts).toBeUndefined();
    // Excluir (com a aprovação do dono) não deixa referência: o doc deixou de existir, e o cartão apontaria para o nada.
    const run = await world.send(bot, tableMarker('doc_delete', { docId: id, operationId: randomUUID() }));
    await world.waitForStatus(run, 'waiting_approval');
    await world.approvals.respond((await world.approvalOf(run))!.id, 'allow_once', ORIGIN);
    await world.waitForStatus(run, 'completed');
    const removal = (await activitiesOf(run))[0]!;
    expect(removal).toMatchObject({ status: 'completed', content: JSON.stringify({ id, deleted: true }) });
    expect(removal.data.artifacts).toBeUndefined();
  }, 90_000);

  it('o bot sem acesso ao doc recebe a recusa de um id inexistente e nenhuma referência', async () => {
    const [x, y] = [await world.createBot(), await world.createBot()];
    const doc = await docs.create({ title: 'Do X', content: 'a', botIds: [x.id], operationId: randomUUID() }, owner);
    const denied = await callOnce(y, 'doc_append', { docId: doc.id, expectedVersion: 1, text: 'invasão', operationId: randomUUID() });
    expect(denied.status).toBe('failed');
    expect(denied.data.artifacts).toBeUndefined();
  });
});

describe('table_* (A4, A29)', () => {
  it('criar, atualizar, gravar e mexer nas vistas trazem a referência com o nome da tabela; ler, listar e a escrita recusada não trazem', async () => {
    const bot = await world.createBot();
    const created = await callOnce(bot, 'table_create', { name: 'Financeiro', operationId: randomUUID(), columns: [{ name: 'Descrição', type: 'text' }] });
    const { id, columns } = JSON.parse(created.content) as { id: string; columns: { id: string }[] };
    const ref: ArtifactRef = { type: 'table', id, title: 'Financeiro' };
    expect(created.data.artifacts).toEqual([ref]);

    const write = await callOnce(bot, 'table_write', writeOf(id, columns[0]!.id, 'conta de luz'));
    expect(write.data.artifacts).toEqual([ref]);

    const view = await callOnce(bot, 'table_view_create', { tableId: id, input: { operationId: randomUUID(), name: 'Todas', columns: [columns[0]!.id] } });
    expect(view.status).toBe('completed');
    expect(view.data.artifacts).toEqual([ref]);
    const viewId = (JSON.parse(view.content) as { id: string; version: number }).id;
    const viewUpdate = await callOnce(bot, 'table_view_update', { tableId: id, viewId, input: { operationId: randomUUID(), expectedVersion: 1, name: 'Todas as contas' } });
    expect(viewUpdate.status).toBe('completed');
    expect(viewUpdate.data.artifacts).toEqual([ref]);
    const viewRemove = await callOnce(bot, 'table_view_remove', { tableId: id, viewId, input: { operationId: randomUUID(), expectedVersion: 2 } });
    expect(viewRemove.status).toBe('completed');
    expect(viewRemove.data.artifacts).toEqual([ref]);

    // O nome vem do servidor: renomear pela atualização de estrutura traz o nome novo.
    const table = await tables.get(id, owner);
    const renamed = await callOnce(bot, 'table_update', { tableId: id, input: { operationId: randomUUID(), expectedSchemaVersion: table.schemaVersion, name: 'Financeiro 2026', columns: table.columns } });
    expect(renamed.status).toBe('completed');
    expect(renamed.data.artifacts).toEqual([{ ...ref, title: 'Financeiro 2026' }]);

    for (const [name, args] of [['table_get', { tableId: id }], ['table_query', { tableId: id, query: { limit: 5 } }], ['table_list', {}], ['table_views', { tableId: id }]] as const) {
      expect((await callOnce(bot, name, args)).data.artifacts, name).toBeUndefined();
    }
    // Tabela que o bot não acessa: recusada, sem referência.
    const other = await world.createBot();
    const foreign = await callOnce(other, 'table_write', writeOf(id, columns[0]!.id, 'invasão'));
    expect(foreign.status).toBe('failed');
    expect(foreign.data.artifacts).toBeUndefined();
  }, 120_000);
});

describe('table_import_attachment (A4)', () => {
  /** Duas tabelas pequenas e independentes (ids próprios), como um anexo de importação as traz. */
  function document() {
    const table = (name: string) => {
      const [origin, column, record] = [randomUUID(), randomUUID(), randomUUID()];
      return { originId: origin, name, columns: [{ id: column, name: 'Campo', type: 'text' }], records: [{ id: record, values: { [column]: 'valor' } }], views: [] };
    };
    return { format: 'aion-table-import-v1', tables: [table('Alfa'), table('Beta')] };
  }
  /** Anexo e contexto de ferramenta pelos serviços reais; a posse sintética só evita chamar um modelo (como em `attachment-import.test.ts`). */
  async function setup() {
    const bot = await world.createBot();
    const source = document();
    const attachment = await new AttachmentService({ pool: world.pool, conversations: world.conversations }).upload(bot.id, 'import.json', Buffer.from(JSON.stringify(source)));
    const run = await world.conversations.send(bot.id, 'Importar o anexo por referência', [attachment.id]);
    const row = (await world.pool.query<{ conversation_id: string }>("UPDATE runs SET status = 'running', lease_until = now() + interval '1 hour' WHERE id = $1 RETURNING conversation_id", [run.id])).rows[0]!;
    const message = (await world.pool.query<{ id: string }>("INSERT INTO messages (conversation_id, run_id, role, kind, status, opens_round, content, created_at) VALUES ($1, $2, 'user', 'text', 'done', true, 'Importar anexo', now()) RETURNING id::text", [row.conversation_id, run.id])).rows[0]!;
    await world.pool.query('UPDATE runs SET trigger_message_id = $2 WHERE id = $1', [run.id, message.id]);
    await world.pool.query('UPDATE attachments SET message_id = $2 WHERE id = $1', [attachment.id, message.id]);
    const context: ToolContext = { pool: world.pool, botId: bot.id, conversationId: row.conversation_id, runId: run.id, now: () => new Date(), signal: new AbortController().signal };
    const importer = tableTools.find((tool) => tool.definition.name === 'table_import_attachment')!;
    const execute = async (input: object) => importer.prepare(JSON.stringify({ attachmentId: attachment.id, ...input })).execute(context);
    const { sourceHash } = JSON.parse((await execute({ operation: 'inspect' })).result) as { sourceHash: string };
    return { source, execute, sourceHash };
  }

  it('a fase global que cria ou grava refere todas as tabelas da importação; inspecionar, verificar e repetir sem efeito não referem nenhuma', async () => {
    const { execute, sourceHash, source } = await setup();
    expect((await execute({ operation: 'inspect' })).artifacts).toBeUndefined();
    const created = await execute({ operation: 'apply', sourceHash, phase: 'create', bindings: [], operationId: randomUUID() });
    const { bindings } = JSON.parse(created.result) as { bindings: { sourceTableId: string; tableId: string; expectedSchemaVersion: number }[] };
    expect(created.artifacts).toEqual(source.tables.map(({ name }, index) => ({ type: 'table', id: bindings[index]!.tableId, title: name })));

    const records = { operation: 'apply', sourceHash, phase: 'records', bindings, operationId: randomUUID() };
    const first = await execute(records);
    expect(first.artifacts?.map((ref) => ref.title)).toEqual(['Alfa', 'Beta']);
    // O mesmo lote de novo: tudo é pulado, nada mudou.
    expect((await execute(records)).artifacts).toBeUndefined();
    expect((await execute({ operation: 'verify', sourceHash, bindings })).artifacts).toBeUndefined();
  }, 60_000);

  it('a operação individual (com sourceTableId) refere só a tabela dela, e o que já estava aplicado não refere', async () => {
    const { execute, sourceHash, source } = await setup();
    const alfa = source.tables[0]!;
    const created = await execute({ operation: 'apply', sourceHash, phase: 'create', sourceTableId: alfa.originId, bindings: [], operationId: randomUUID() });
    const { tableId, schemaVersion } = JSON.parse(created.result) as { tableId: string; schemaVersion: number };
    expect(created.artifacts).toEqual([{ type: 'table', id: tableId, title: 'Alfa' }]);

    const bindings = [{ sourceTableId: alfa.originId, tableId, expectedSchemaVersion: schemaVersion }];
    const again = await execute({ operation: 'apply', sourceHash, phase: 'create', sourceTableId: alfa.originId, bindings, operationId: randomUUID() });
    expect(JSON.parse(again.result)).toMatchObject({ skipped: true });
    expect(again.artifacts).toBeUndefined();

    const records = { operation: 'apply', sourceHash, phase: 'records', sourceTableId: alfa.originId, bindings, expectedSchemaVersion: schemaVersion, operationId: randomUUID() };
    expect((await execute(records)).artifacts).toEqual([{ type: 'table', id: tableId, title: 'Alfa' }]);
    expect((await execute(records)).artifacts).toBeUndefined();
  }, 60_000);
});

// Persistência/ACL reais: derivados transitivos deixam de ser elegíveis sem apagar os arquivos originais.
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { createDocsWorld, botActor, operation, type DocsWorld } from '../docs/test-support';
import { TableService } from '../tables/service';
import { createTablesWorld, owner } from '../tables/test-support';
import { evidenceProvenanceMigration } from '../db/migrations/0035_evidence_provenance';
import { attachmentEvidence, mergeEvidence, parseEvidence, validateEvidence, type EvidenceProvenance } from './evidence-provenance';

let world: Awaited<ReturnType<typeof createTablesWorld>>;
// Cada teste cria o próprio mundo; limpar e esquecer evita encerrar o mesmo pool de novo num teste que não usa o mundo de tabelas (os de docs, mais abaixo, têm o deles).
afterEach(async () => { await world?.cleanup(); world = undefined as never; });

/** Fixture autorizada na conversa do bot, com conteúdo sintético e metadata de origem opcional. */
async function attachment(kind: 'document' | 'generated', evidence: EvidenceProvenance | null = null): Promise<string> {
  const conversationId = (await world.pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id=$1', [world.bot.id])).rows[0]!.id;
  const message = (await world.pool.query<{ id: string }>("INSERT INTO messages(conversation_id,role,kind,status,content,created_at) VALUES($1,'user','text','done','fixture',now()) RETURNING id::text", [conversationId])).rows[0]!.id;
  return (await world.pool.query<{ id: string }>(`INSERT INTO attachments(conversation_id,message_id,kind,name,original_bytes,stored_bytes,extracted_text,file_bytes,format,source_provenance)
    VALUES($1,$2,$3,'fixture.txt',1,1,$4,$5,$6,$7) RETURNING id::text`, [conversationId, message, kind, kind === 'document' ? 'x' : null, kind === 'generated' ? Buffer.from('x') : null, kind === 'generated' ? 'txt' : null, evidence])).rows[0]!.id;
}

it('captura ACL no snapshot; escrita preserva evidência, share igual é no-op e revoke/regrant não revive', async () => {
  world = await createTablesWorld();
  const conversationId = (await world.pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id=$1', [world.bot.id])).rows[0]!.id;
  const table = await world.create([{ name: 'Descrição', type: 'text' }]);
  let captured = mergeEvidence();
  const reader = new TableService({ pool: world.pool, onEvidence: (evidence) => { captured = mergeEvidence(captured, evidence); } });
  await reader.get(table.id, { kind: 'bot', botId: world.bot.id });
  expect(captured.tables).toEqual([{ tableId: table.id, botId: world.bot.id, accessVersion: 1 }]);
  await world.write(table, [{ [table.columns[0]!.id]: 'novo' }]);
  expect(await validateEvidence(world.pool, conversationId, world.bot.id, captured)).toBe(true);
  const current = await world.tables.get(table.id, owner);
  const same = await world.tables.share(table.id, { operationId: randomUUID(), expectedVersion: current.version, botIds: [world.bot.id] }, owner);
  expect(same.version).toBe(current.version);
  expect(await validateEvidence(world.pool, conversationId, world.bot.id, captured)).toBe(true);
  const revoked = await world.tables.share(table.id, { operationId: randomUUID(), expectedVersion: same.version, botIds: [] }, owner);
  expect(await validateEvidence(world.pool, conversationId, world.bot.id, captured)).toBe(false);
  await world.tables.share(table.id, { operationId: randomUUID(), expectedVersion: revoked.version, botIds: [world.bot.id] }, owner);
  expect(await validateEvidence(world.pool, conversationId, world.bot.id, captured)).toBe(false);
});

it('conserva closure generated→generated, recusa legado/IDOR e invalida toda cópia sem apagar saída', async () => {
  world = await createTablesWorld();
  const conversationId = (await world.pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id=$1', [world.bot.id])).rows[0]!.id;
  const source = await attachment('document');
  const first = await attachment('generated', { attachments: [source], tables: [], docs: [] });
  const second = await attachment('generated', { attachments: [source, first], tables: [], docs: [] });
  const legacy = await attachment('generated');
  const closure = await attachmentEvidence(world.pool, conversationId, world.bot.id, [second]);
  expect(closure).toEqual(mergeEvidence({ attachments: [source, first, second], tables: [], docs: [] }));
  expect(await attachmentEvidence(world.pool, conversationId, world.bot.id, [legacy])).toBeNull();
  expect(await validateEvidence(world.pool, randomUUID(), world.bot.id, closure!)).toBe(false);
  expect(await validateEvidence(world.pool, conversationId, null, closure!)).toBe(false);
  expect(await validateEvidence(world.pool, conversationId, world.bot.id, { attachments: [second], tables: [], docs: [] })).toBe(false);
  await world.pool.query('UPDATE attachments SET removed_at=now(),extracted_text=NULL,stored_bytes=0 WHERE id=$1', [source]);
  expect(await validateEvidence(world.pool, conversationId, world.bot.id, closure!)).toBe(false);
  expect(await attachmentEvidence(world.pool, conversationId, world.bot.id, [second])).toBeNull();
  expect((await world.pool.query('SELECT file_bytes FROM attachments WHERE id=$1', [second])).rows[0]!.file_bytes).toEqual(Buffer.from('x'));
  await expect(world.pool.query(evidenceProvenanceMigration.rollback)).rejects.toThrow(/Preserve proveniência/);
});

it('não mascara versões conflitantes e invalida saída Python derivada de tabela revogada', async () => {
  world = await createTablesWorld();
  const table = await world.create();
  const conversationId = (await world.pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id=$1', [world.bot.id])).rows[0]!.id;
  const source = { attachments: [], tables: [{ tableId: table.id, botId: world.bot.id, accessVersion: 1 }], docs: [] };
  const output = await attachment('generated', source);
  const closure = await attachmentEvidence(world.pool, conversationId, world.bot.id, [output]);
  expect(closure?.tables).toEqual(source.tables);
  const conflicting = mergeEvidence(source, { attachments: [], tables: [{ ...source.tables[0]!, accessVersion: 2 }], docs: [] });
  expect(conflicting.tables).toHaveLength(2);
  expect(await validateEvidence(world.pool, conversationId, world.bot.id, conflicting)).toBe(false);
  await world.tables.share(table.id, { operationId: randomUUID(), expectedVersion: table.version, botIds: [] }, owner);
  expect(await validateEvidence(world.pool, conversationId, world.bot.id, closure!)).toBe(false);
  expect(await attachmentEvidence(world.pool, conversationId, world.bot.id, [output])).toBeNull();
});

it('não transfere proveniência entre atores mesmo quando ambos têm concessão para a tabela', async () => {
  world = await createTablesWorld();
  const other = await world.bots.create({ name: 'Outro', color: '#60A5FA', instructions: '', model: null, effort: null, stepLimit: 50 }, { ip: '203.0.113.20', userAgent: 'evidence-test' });
  const table = await world.create();
  await world.tables.share(table.id, { operationId: randomUUID(), expectedVersion: table.version, botIds: [world.bot.id, other.id] }, owner);
  const conversationId = (await world.pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id=$1', [world.bot.id])).rows[0]!.id;
  const foreign = { attachments: [], tables: [{ tableId: table.id, botId: other.id, accessVersion: 2 }], docs: [] };
  expect(await validateEvidence(world.pool, conversationId, world.bot.id, foreign)).toBe(false);
  expect(await validateEvidence(world.pool, conversationId, world.bot.id, { attachments: [], tables: [{ ...foreign.tables[0]!, botId: world.bot.id }], docs: [] })).toBe(true);
});

it('rollback sem derivados preserva anexos, mensagens e tabelas anteriores', async () => {
  world = await createTablesWorld();
  const table = await world.create();
  const original = await attachment('document');
  await world.pool.query(evidenceProvenanceMigration.rollback);
  expect((await world.pool.query('SELECT extracted_text,stored_bytes FROM attachments WHERE id=$1', [original])).rows[0]).toEqual({ extracted_text: 'x', stored_bytes: 1 });
  expect((await world.pool.query('SELECT name FROM data_tables WHERE id=$1', [table.id])).rows[0]!.name).toBe(table.name);
  expect((await world.pool.query("SELECT content FROM messages WHERE content='fixture'")).rows).toEqual([{ content: 'fixture' }]);
});

// Docs como fonte de proveniência (phase 14, A33): o doc segue a regra das tabelas, com a revisão de acesso que a leitura do bot capturou no mesmo instante autorizado.
let docsWorld: DocsWorld | undefined;
afterEach(async () => { await docsWorld?.cleanup(); docsWorld = undefined; });

it('docs: a leitura do bot captura a revisão de acesso; compartilhar a mesma lista é no-op, revogar invalida e conceder de novo não revive; leitura de outro bot não vale', async () => {
  docsWorld = await createDocsWorld();
  const [bot, other] = [await docsWorld.bot(), await docsWorld.bot()];
  const conversationId = (await docsWorld.pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id=$1', [bot.id])).rows[0]!.id;
  const doc = await docsWorld.create({ botIds: [bot.id, other.id], content: 'texto do doc' });
  let captured = mergeEvidence();
  const reader = docsWorld.service({ onEvidence: (entries) => { captured = mergeEvidence(captured, { attachments: [], tables: [], docs: [...entries] }); } });
  await reader.read(doc.id, botActor(bot.id));
  expect(captured.docs).toEqual([{ docId: doc.id, botId: bot.id, accessVersion: 1 }]);
  expect(await validateEvidence(docsWorld.pool, conversationId, bot.id, captured)).toBe(true);
  // A fonte é do bot que leu: a mesma evidência não vale para outro ator (nem para a conversa sem bot).
  expect(await validateEvidence(docsWorld.pool, conversationId, other.id, captured)).toBe(false);
  expect(await validateEvidence(docsWorld.pool, conversationId, null, captured)).toBe(false);
  // Editar o texto não toca o acesso; compartilhar a mesma lista não sobe a revisão.
  await docsWorld.docs.update(doc.id, { expectedVersion: 1, operationId: operation(), edit: { operation: 'append', text: 'mais' } }, botActor(bot.id));
  await docsWorld.docs.share(doc.id, { botIds: [bot.id, other.id], expectedAccessVersion: 1, operationId: operation() }, { kind: 'owner' });
  expect(await validateEvidence(docsWorld.pool, conversationId, bot.id, captured)).toBe(true);
  // Revogar tira a leitura anterior do pedido; conceder de novo sobe a revisão outra vez e não a revive.
  await docsWorld.docs.share(doc.id, { botIds: [other.id], expectedAccessVersion: 1, operationId: operation() }, { kind: 'owner' });
  expect(await validateEvidence(docsWorld.pool, conversationId, bot.id, captured)).toBe(false);
  await docsWorld.docs.share(doc.id, { botIds: [bot.id, other.id], expectedAccessVersion: 2, operationId: operation() }, { kind: 'owner' });
  expect(await validateEvidence(docsWorld.pool, conversationId, bot.id, captured)).toBe(false);
  // Doc excluído: a leitura antiga também deixa de valer.
  const gone = await docsWorld.create({ botIds: [bot.id] });
  const goneRead = mergeEvidence({ attachments: [], tables: [], docs: [{ docId: gone.id, botId: bot.id, accessVersion: 1 }] });
  expect(await validateEvidence(docsWorld.pool, conversationId, bot.id, goneRead)).toBe(true);
  await docsWorld.docs.delete(gone.id, { operationId: operation() }, { kind: 'owner' });
  expect(await validateEvidence(docsWorld.pool, conversationId, bot.id, goneRead)).toBe(false);
});

it('a evidência gravada antes dos docs (sem o campo) segue válida como "nenhum doc", e docs entra na união canônica sem repetição', async () => {
  const legacy = parseEvidence({ attachments: ['4'], tables: [] });
  expect(legacy).toEqual({ attachments: ['4'], tables: [], docs: [] });
  const docA = { docId: '11111111-1111-4111-8111-111111111111', botId: '22222222-2222-4222-8222-222222222222', accessVersion: 1 };
  const docB = { ...docA, docId: '00000000-0000-4000-8000-000000000000' };
  expect(mergeEvidence({ attachments: [], tables: [], docs: [docA, docB] }, { attachments: [], tables: [], docs: [docA] }).docs).toEqual([docB, docA]);
  // Campo desconhecido continua recusado (a forma é fechada) e docs malformado não vira "nenhum doc".
  expect(parseEvidence({ attachments: [], tables: [], docs: [], extra: 1 })).toBeNull();
  expect(parseEvidence({ attachments: [], tables: [], docs: [{ docId: 'x', botId: docA.botId, accessVersion: 1 }] })).toBeNull();
});

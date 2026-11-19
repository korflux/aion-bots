// Prova do serviço de docs (phase 14, passo 2; DOC-01, DOC-02, SEC-03) contra PostgreSQL real: limites da tabela do A8 (inclusive o 100.º e o 101.º doc em duas
// criações simultâneas), conflito por versão esperada (A12), bot sem acesso igual a id inexistente (A13), restauração que cria versão nova (A15), retenção MEM-01
// com relógio injetado (A16), exclusão de bot que preserva doc, versões e os outros bots (A25), recibos idempotentes, exclusão só com prova de aprovação do bot e a
// leitura paginada por caractere. O que a API e as ferramentas fazem por cima (rotas, `doc_*`) é provado nos passos 3a e 3b.
import { randomUUID } from 'node:crypto';
import { DOC_ACTIONS, DOC_LIMITS, countChars, type Doc } from '@aion/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantApprovalProof } from '../approvals/proof';
import type { Pool } from '../db/pool';
import { DomainError } from '../errors';
import type { DocActor, DocEvidenceEntry, DocService } from './service';
import { ORIGIN, botActor, createDocsWorld, operation, owner, type DocsWorld } from './test-support';

let w: DocsWorld;
beforeAll(async () => {
  w = await createDocsWorld();
});
afterAll(async () => {
  await w.cleanup();
});

/** Código e mensagem da recusa (ou `OK`): a recusa de um doc sem acesso tem de ser IDÊNTICA à de um id inexistente, mensagem inclusive. */
const refusal = async (promise: Promise<unknown>): Promise<{ code: string; message: string }> => {
  try {
    await promise;
    return { code: 'OK', message: '' };
  } catch (error) {
    if (error instanceof DomainError) return { code: error.code, message: error.message };
    return { code: `INESPERADO:${String(error)}`, message: '' };
  }
};
const codeOf = async (promise: Promise<unknown>): Promise<string> => (await refusal(promise)).code;

/** Retrato de TODO o estado dos docs (docs, versões, associações e recibos): "nada gravado" é igualdade entre dois retratos. */
async function dump(pool: Pool): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const table of ['docs', 'doc_versions', 'doc_bot_access', 'doc_mutation_receipts']) {
    const rows = await pool.query<{ row: unknown }>(`SELECT to_jsonb(t) AS row FROM ${table} t`);
    out[table] = rows.rows.map((entry) => JSON.stringify(entry.row)).sort();
  }
  return out;
}

const versionsOf = async (pool: Pool, docId: string): Promise<{ version: number; content: string; author: string; restored_from: number | null }[]> =>
  (await pool.query('SELECT version, content, author, restored_from FROM doc_versions WHERE doc_id = $1 ORDER BY version', [docId])).rows;

const append = (text: string) => ({ operation: 'append', text }) as const;
const rewrite = (content: string) => ({ operation: 'rewrite', content }) as const;

describe('limites do doc (A8)', () => {
  it.each([
    ['título vazio', { title: '' }, 'VALIDATION_FAILED'],
    ['título só de espaços', { title: '   ' }, 'VALIDATION_FAILED'],
    ['título com quebra de linha', { title: 'a\nb' }, 'VALIDATION_FAILED'],
    ['título de 120 caracteres', { title: 'é'.repeat(120) }, 'OK'],
    ['título de 121 caracteres', { title: 'é'.repeat(121) }, 'VALIDATION_FAILED'],
    ['título de 120 emojis (conta caractere, não unidade UTF-16)', { title: '😀'.repeat(120) }, 'OK'],
    ['título de 121 emojis', { title: '😀'.repeat(121) }, 'VALIDATION_FAILED'],
    ['texto de 100.000 caracteres', { content: 'a'.repeat(100_000) }, 'OK'],
    ['texto de 100.000 emojis', { content: '😀'.repeat(100_000) }, 'OK'],
    ['texto de 100.001 caracteres', { content: 'a'.repeat(100_001) }, 'DOC_TOO_LARGE'],
    ['texto de 100.001 emojis', { content: '😀'.repeat(100_001) }, 'DOC_TOO_LARGE'],
    ['texto com caractere de controle', { content: 'a\u0000b' }, 'VALIDATION_FAILED'],
    ['texto com surrogate solto', { content: `a${String.fromCharCode(0xd800)}b` }, 'VALIDATION_FAILED'],
  ] as const)('criação: %s', async (_name, input, expected) => {
    const before = await dump(w.pool);
    const outcome = await codeOf(w.create(input));
    expect(outcome).toBe(expected);
    // Recusado: nada foi gravado, em nenhuma das quatro tabelas.
    if (expected !== 'OK') expect(await dump(w.pool)).toEqual(before);
  });

  it('o texto aceito é gravado caractere por caractere (sem normalizar) e o título é aparado e normalizado em NFC', async () => {
    const content = 'linha 1\r\nlinha 2\t\u00e9 e\u0301  \n\n  fim  ';
    const doc = await w.create({ title: '  Plano\u0301  ', content });
    expect(doc.title).toBe('Plano\u0301'.normalize('NFC'));
    expect((await w.docs.get(doc.id, owner)).content).toBe(content);
    expect(doc.size).toBe(countChars(content));
  });

  it('a edição segue os mesmos limites: título, texto reescrito e texto acrescentado acima de 100.000 são recusados e nada é gravado', async () => {
    const doc = await w.create({ content: 'a'.repeat(99_990) });
    const before = await dump(w.pool);
    const base = { expectedVersion: 1, operationId: operation() };
    expect(await codeOf(w.docs.update(doc.id, { ...base, title: '' }, owner))).toBe('VALIDATION_FAILED');
    expect(await codeOf(w.docs.update(doc.id, { ...base, operationId: operation(), title: 'x'.repeat(121) }, owner))).toBe('VALIDATION_FAILED');
    expect(await codeOf(w.docs.update(doc.id, { ...base, operationId: operation(), edit: rewrite('a'.repeat(100_001)) }, owner))).toBe('DOC_TOO_LARGE');
    // 99.990 + 1 (quebra de linha) + 10 = 100.001: o acréscimo que passa do limite é recusado, e o que cabe exato entra.
    expect(await codeOf(w.docs.update(doc.id, { ...base, operationId: operation(), edit: append('b'.repeat(10)) }, owner))).toBe('DOC_TOO_LARGE');
    expect(await dump(w.pool)).toEqual(before);
    const fits = await w.docs.update(doc.id, { ...base, operationId: operation(), edit: append('b'.repeat(9)) }, owner);
    expect(fits).toMatchObject({ changed: true, doc: { version: 2, size: 100_000 } });
  });

  it('quantidade: o 100.º doc é criado e o 101.º é recusado, também em duas criações simultâneas (a contagem e a criação são atômicas)', async () => {
    const world = await createDocsWorld();
    try {
      await world.pool.query("INSERT INTO docs (id, title, updated_by) SELECT gen_random_uuid(), 'Semente ' || n, 'owner' FROM generate_series(1, 98) AS n");
      await world.pool.query("INSERT INTO doc_versions (doc_id, version, content, author, created_at) SELECT id, 1, '', 'owner', now() FROM docs");
      // O 99.º e o 100.º entram juntos: cabem os dois.
      const both = await Promise.allSettled([world.create({ title: 'A' }), world.create({ title: 'B' })]);
      expect(both.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(Number((await world.pool.query('SELECT count(*) FROM docs')).rows[0].count)).toBe(DOC_LIMITS.docs);
      // O 101.º, duas vezes ao mesmo tempo: as duas são recusadas e nada é criado.
      const before = await dump(world.pool);
      const over = await Promise.all([refusal(world.create({ title: 'C' })), refusal(world.create({ title: 'D' }))]);
      expect(over.map((entry) => entry.code)).toEqual(['DOC_LIMIT_EXCEEDED', 'DOC_LIMIT_EXCEEDED']);
      expect(await dump(world.pool)).toEqual(before);
      // Com 99 docs, duas criações simultâneas: exatamente uma vence (o 100.º) e a outra é o 101.º.
      await world.pool.query('DELETE FROM docs WHERE id = (SELECT id FROM docs ORDER BY id LIMIT 1)');
      const race = await Promise.all([refusal(world.create({ title: 'E' })), refusal(world.create({ title: 'F' }))]);
      expect(race.map((entry) => entry.code).sort()).toEqual(['DOC_LIMIT_EXCEEDED', 'OK']);
      expect(Number((await world.pool.query('SELECT count(*) FROM docs')).rows[0].count)).toBe(DOC_LIMITS.docs);
    } finally {
      await world.cleanup();
    }
  });

  it('o corpo máximo da API comporta o texto de 100.000 caracteres no pior caso de UTF-8 e de escape JSON', async () => {
    const { DOC_BODY_LIMIT } = await import('@aion/shared');
    // 4 bytes por emoji em UTF-8 cru; 12 bytes por emoji quando o cliente escapa o par substituto (barra, u, quatro dígitos, duas vezes): o JSON legal que mais pesa por caractere.
    expect(Buffer.byteLength(JSON.stringify({ content: '😀'.repeat(100_000) }))).toBeLessThan(DOC_BODY_LIMIT);
    const escapedPair = String.raw`\ud83d\ude00`; // 12 caracteres ASCII: a forma escapada de um emoji
    expect(escapedPair).toHaveLength(12);
    expect(Buffer.byteLength(`{"content":"${escapedPair.repeat(100_000)}"}`)).toBeLessThan(DOC_BODY_LIMIT);
    // Sobra para os demais campos do corpo (título, versão esperada, identidade da operação, bots), mas não é um corpo livre: continua bem abaixo de 2 MiB.
    expect(DOC_BODY_LIMIT).toBeLessThan(2 * 1024 * 1024);
  });
});

describe('versões e conflito (A12, DOC-02)', () => {
  it('a criação grava a versão 1 e cada alteração do texto, do dono ou do bot, cria uma versão imutável com o autor certo', async () => {
    const bot = await w.bot();
    const doc = await w.create({ content: 'um', botIds: [bot.id] });
    expect(doc).toMatchObject({ version: 1, accessVersion: 1, updatedBy: 'owner', botIds: [bot.id] });
    const owned = await w.docs.update(doc.id, { expectedVersion: 1, operationId: operation(), edit: rewrite('dois') }, owner, ORIGIN);
    expect(owned).toMatchObject({ changed: true, doc: { version: 2, size: 4, updatedBy: 'owner' } });
    const botted = await w.docs.update(doc.id, { expectedVersion: 2, operationId: operation(), edit: append('três') }, botActor(bot.id));
    expect(botted).toMatchObject({ changed: true, doc: { version: 3, updatedBy: 'bot' } });
    expect(await versionsOf(w.pool, doc.id)).toEqual([
      { version: 1, content: 'um', author: 'owner', restored_from: null },
      { version: 2, content: 'dois', author: 'owner', restored_from: null },
      { version: 3, content: 'dois\ntrês', author: 'bot', restored_from: null },
    ]);
  });

  it('versão esperada antiga é recusada com DOC_CONFLICT e nada muda, para o bot e para o dono (A12)', async () => {
    const bot = await w.bot();
    const doc = await w.create({ content: 'base', botIds: [bot.id] });
    await w.docs.update(doc.id, { expectedVersion: 1, operationId: operation(), edit: rewrite('base v2') }, owner);
    const before = await dump(w.pool);
    expect(await codeOf(w.docs.update(doc.id, { expectedVersion: 1, operationId: operation(), edit: append('atrasado') }, botActor(bot.id)))).toBe('DOC_CONFLICT');
    expect(await codeOf(w.docs.update(doc.id, { expectedVersion: 1, operationId: operation(), edit: rewrite('atrasado do dono') }, owner))).toBe('DOC_CONFLICT');
    expect(await codeOf(w.docs.update(doc.id, { expectedVersion: 1, operationId: operation(), title: 'Só o título' }, owner))).toBe('DOC_CONFLICT');
    expect(await codeOf(w.docs.restore(doc.id, { version: 1, expectedVersion: 1, operationId: operation() }, botActor(bot.id)))).toBe('DOC_CONFLICT');
    expect(await dump(w.pool)).toEqual(before);
    expect((await w.docs.get(doc.id, owner)).content).toBe('base v2');
  });

  it('duas gravações simultâneas sobre a mesma versão: uma vence, a outra é DOC_CONFLICT e o histórico fica sem lacuna (corrida entre o dono e o bot)', async () => {
    const bot = await w.bot();
    const doc = await w.create({ content: 'base', botIds: [bot.id] });
    const results = await Promise.all([
      refusal(w.docs.update(doc.id, { expectedVersion: 1, operationId: operation(), edit: rewrite('do dono') }, owner)),
      refusal(w.docs.update(doc.id, { expectedVersion: 1, operationId: operation(), edit: rewrite('do bot') }, botActor(bot.id))),
    ]);
    expect(results.map((entry) => entry.code).sort()).toEqual(['DOC_CONFLICT', 'OK']);
    const versions = await versionsOf(w.pool, doc.id);
    expect(versions.map((row) => row.version)).toEqual([1, 2]);
    expect((await w.docs.get(doc.id, owner)).content).toBe(versions[1]!.content);
  });

  it('só o título mudar não cria versão de texto, e texto igual ao atual não cria versão nem conflita por conteúdo', async () => {
    const doc = await w.create({ title: 'Antes', content: 'texto' });
    const renamed = await w.docs.update(doc.id, { expectedVersion: 1, operationId: operation(), title: 'Depois' }, owner);
    expect(renamed).toMatchObject({ changed: true, doc: { title: 'Depois', version: 1 } });
    const same = await w.docs.update(doc.id, { expectedVersion: 1, operationId: operation(), edit: rewrite('texto') }, owner);
    expect(same).toMatchObject({ changed: false, doc: { version: 1 } });
    expect((await versionsOf(w.pool, doc.id)).map((row) => row.version)).toEqual([1]);
  });

  it('o bot não renomeia o doc nem escolhe bots ao criar: o servidor associa o doc ao próprio bot', async () => {
    const bot = await w.bot();
    const other = await w.bot();
    const doc = await w.docs.create({ title: 'Do bot', content: 'x', operationId: operation() }, botActor(bot.id));
    expect(doc).toMatchObject({ version: 1, updatedBy: 'bot', botIds: [] });
    expect((await w.docs.get(doc.id, owner)).botIds).toEqual([bot.id]);
    expect((await versionsOf(w.pool, doc.id))[0]).toMatchObject({ author: 'bot' });
    expect(await codeOf(w.docs.update(doc.id, { expectedVersion: 1, operationId: operation(), title: 'Outro' }, botActor(bot.id)))).toBe('VALIDATION_FAILED');
    expect(await codeOf(w.docs.create({ title: 'X', botIds: [other.id], operationId: operation() }, botActor(bot.id)))).toBe('VALIDATION_FAILED');
    // Campo fora do contrato (autor, revisões, tamanho) é recusado em vez de ignorado ou gravado: nada vem do chamador além do que o schema permite.
    const forged = { expectedVersion: 1, operationId: operation(), edit: append('y'), updatedBy: 'owner', version: 99, accessVersion: 99 };
    expect(await codeOf(w.docs.update(doc.id, forged as never, botActor(bot.id)))).toBe('VALIDATION_FAILED');
    expect(await codeOf(w.docs.create({ title: 'X', operationId: operation(), accessVersion: 9, id: randomUUID() } as never, owner))).toBe('VALIDATION_FAILED');
    expect(await codeOf(w.docs.share(doc.id, { botIds: [], expectedAccessVersion: 1, operationId: operation(), version: 5 } as never, owner))).toBe('VALIDATION_FAILED');
    expect((await w.docs.get(doc.id, owner)).version).toBe(1);
  });
});

describe('edição pelo ator: acrescentar, substituir trecho exato e reescrever (A9, A10)', () => {
  it('acrescentar junta em nova linha só quando o texto não termina em quebra; substituir exige o trecho exato e único; reescrever troca tudo; cada um cria versão', async () => {
    const bot = await w.bot();
    const actor = botActor(bot.id);
    const doc = await w.create({ content: '# Plano\n\nPasso A: comprar $& e \\1.\n', botIds: [bot.id] });
    let version = 1;
    const apply = async (edit: Parameters<DocService['update']>[1]['edit']) => {
      const result = await w.docs.update(doc.id, { expectedVersion: version, operationId: operation(), edit }, actor);
      version = result.doc.version;
      return result;
    };
    // Termina em quebra de linha: o texto entra direto; sem quebra, entra numa nova linha.
    await apply(append('Passo B.'));
    expect((await w.docs.get(doc.id, actor)).content).toBe('# Plano\n\nPasso A: comprar $& e \\1.\nPasso B.');
    await apply(append('Passo C.'));
    expect((await w.docs.get(doc.id, actor)).content).toBe('# Plano\n\nPasso A: comprar $& e \\1.\nPasso B.\nPasso C.');
    // Substituir: o trecho é literal ($& e \1 não são padrões) e a troca vale uma vez só.
    await apply({ operation: 'replace', find: 'comprar $& e \\1.', replacement: 'comprar $$ e $1 $`.' });
    expect((await w.docs.get(doc.id, actor)).content).toBe('# Plano\n\nPasso A: comprar $$ e $1 $`.\nPasso B.\nPasso C.');
    await apply({ operation: 'replace', find: '\nPasso B.', replacement: '' }); // trecho apagado: replacement vazio é permitido
    expect((await w.docs.get(doc.id, actor)).content).toBe('# Plano\n\nPasso A: comprar $$ e $1 $`.\nPasso C.');
    await apply(rewrite('# Novo\n'));
    expect((await w.docs.get(doc.id, actor)).content).toBe('# Novo\n');
    expect((await versionsOf(w.pool, doc.id)).map((row) => [row.version, row.author, row.restored_from])).toEqual([
      [1, 'owner', null], [2, 'bot', null], [3, 'bot', null], [4, 'bot', null], [5, 'bot', null], [6, 'bot', null],
    ]);
  });

  it('trecho que não existe exatamente ou que aparece mais de uma vez é recusado (DOC_TEXT_NOT_FOUND e DOC_TEXT_AMBIGUOUS) e o texto e as versões ficam como estavam (A10)', async () => {
    const bot = await w.bot();
    const doc = await w.create({ content: 'gato\ngato\nCachorro', botIds: [bot.id] });
    const before = await dump(w.pool);
    const replace = (find: string) => w.docs.update(doc.id, { expectedVersion: 1, operationId: operation(), edit: { operation: 'replace', find, replacement: 'x' } }, botActor(bot.id));
    expect(await codeOf(replace('cachorro'))).toBe('DOC_TEXT_NOT_FOUND'); // maiúscula e minúscula são diferentes
    expect(await codeOf(replace('gato\r\ngato'))).toBe('DOC_TEXT_NOT_FOUND');
    expect(await codeOf(replace('gato'))).toBe('DOC_TEXT_AMBIGUOUS');
    expect(await codeOf(replace(''))).toBe('VALIDATION_FAILED');
    expect(await dump(w.pool)).toEqual(before);
    // Trocar um trecho por ele mesmo não muda nada: sem versão nova.
    const same = await w.docs.update(doc.id, { expectedVersion: 1, operationId: operation(), edit: { operation: 'replace', find: 'Cachorro', replacement: 'Cachorro' } }, botActor(bot.id));
    expect(same.changed).toBe(false);
  });
});

describe('acesso por bot: sem acesso é igual a id inexistente (A13, DOC-01)', () => {
  it('bot sem acesso recebe a MESMA recusa (código e mensagem) de um id inexistente em toda operação, sem ler nem gravar nada, nem evidência', async () => {
    const x = await w.bot();
    const y = await w.bot();
    const secret = await w.create({ title: 'Segredo', content: 'conteúdo reservado', botIds: [x.id] });
    const ghost = randomUUID();
    const evidence: DocEvidenceEntry[] = [];
    const asY = w.service({ onEvidence: (entries) => evidence.push(...entries) });
    const actor = botActor(y.id);
    const proof = grantApprovalProof(DOC_ACTIONS.delete.slug, 'owner_approved');
    const operations: { name: string; run: (id: string) => Promise<unknown> }[] = [
      { name: 'get', run: (id) => asY.get(id, actor) },
      { name: 'read', run: (id) => asY.read(id, actor, {}) },
      { name: 'listVersions', run: (id) => asY.listVersions(id, actor) },
      { name: 'getVersion', run: (id) => asY.getVersion(id, 1, actor) },
      { name: 'peek', run: (id) => asY.peek(id, actor) },
      { name: 'update', run: (id) => asY.update(id, { expectedVersion: 1, operationId: operation(), edit: append('invasão') }, actor) },
      { name: 'restore', run: (id) => asY.restore(id, { version: 1, expectedVersion: 1, operationId: operation() }, actor) },
      { name: 'delete', run: (id) => asY.delete(id, { operationId: operation() }, actor, proof) },
    ];
    const before = await dump(w.pool);
    for (const { name, run } of operations) {
      const denied = await refusal(run(secret.id));
      const missing = await refusal(run(ghost));
      expect(denied, name).toEqual(missing);
      expect(denied.code, name).toBe('DOC_NOT_FOUND');
    }
    expect(await dump(w.pool)).toEqual(before);
    expect(evidence).toEqual([]);
    // A lista do bot só traz o que foi compartilhado com ele; o dono vê tudo.
    expect((await asY.list(actor)).docs.map((doc) => doc.id)).not.toContain(secret.id);
    expect((await w.docs.list(botActor(x.id))).docs.map((doc) => doc.id)).toContain(secret.id);
  });

  it('quem não é o dono não compartilha (DOC_ACCESS_DENIED), e o ator que não é dono nem bot é recusado', async () => {
    const bot = await w.bot();
    const doc = await w.create({ botIds: [bot.id] });
    const share = { botIds: [], expectedAccessVersion: 1, operationId: operation() };
    expect(await codeOf(w.docs.share(doc.id, share, botActor(bot.id)))).toBe('DOC_ACCESS_DENIED');
    const chat = { kind: 'chat' } as unknown as DocActor;
    expect(await codeOf(w.docs.get(doc.id, chat))).toBe('DOC_ACCESS_DENIED');
    expect(await codeOf(w.docs.list(chat))).toBe('DOC_ACCESS_DENIED');
    expect(await codeOf(w.docs.create({ title: 'x', operationId: operation() }, chat))).toBe('DOC_ACCESS_DENIED');
    expect(await codeOf(w.docs.get(doc.id, { kind: 'bot', botId: 'não é um uuid' }))).toBe('DOC_ACCESS_DENIED');
    expect((await w.docs.get(doc.id, owner)).botIds).toEqual([bot.id]);
  });

  it('o compartilhamento do dono sobe a revisão de acesso, é no-op quando igual, confere a versão esperada e revoga na chamada seguinte; a evidência leva a revisão lida', async () => {
    const a = await w.bot();
    const b = await w.bot();
    const doc = await w.create({ content: 'lido', botIds: [a.id] });
    const evidence: DocEvidenceEntry[] = [];
    const asA = w.service({ onEvidence: (entries) => evidence.push(...entries) });
    await asA.get(doc.id, botActor(a.id));
    expect(evidence).toEqual([{ docId: doc.id, botId: a.id, accessVersion: 1 }]);

    // Mesmo conjunto: no-op, a revisão não sobe. Revisão esperada antiga: conflito.
    expect((await w.docs.share(doc.id, { botIds: [a.id], expectedAccessVersion: 1, operationId: operation() }, owner)).accessVersion).toBe(1);
    expect(await codeOf(w.docs.share(doc.id, { botIds: [a.id, b.id], expectedAccessVersion: 7, operationId: operation() }, owner))).toBe('DOC_CONFLICT');
    expect(await codeOf(w.docs.share(doc.id, { botIds: [randomUUID()], expectedAccessVersion: 1, operationId: operation() }, owner))).toBe('BOT_NOT_FOUND');
    const shared = await w.docs.share(doc.id, { botIds: [a.id, b.id], expectedAccessVersion: 1, operationId: operation() }, owner, ORIGIN);
    expect(shared).toMatchObject({ accessVersion: 2, botIds: [a.id, b.id].sort() });
    // O bot lê o doc sem descobrir quem mais o acessa (o dono é quem vê a lista de bots).
    expect((await asA.get(doc.id, botActor(a.id))).botIds).toEqual([]);
    // Revogar o bot A: a próxima chamada dele já é DOC_NOT_FOUND, e a leitura de B passa a registrar a revisão nova.
    const revoked = await w.docs.share(doc.id, { botIds: [b.id], expectedAccessVersion: 2, operationId: operation() }, owner);
    expect(revoked).toMatchObject({ accessVersion: 3, botIds: [b.id] });
    expect(await codeOf(asA.get(doc.id, botActor(a.id)))).toBe('DOC_NOT_FOUND');
    await asA.get(doc.id, botActor(b.id));
    expect(evidence.at(-1)).toEqual({ docId: doc.id, botId: b.id, accessVersion: 3 });
    // Um doc sem bot é permitido, e o texto e as versões não mudam com o compartilhamento.
    const none = await w.docs.share(doc.id, { botIds: [], expectedAccessVersion: 3, operationId: operation() }, owner);
    expect(none).toMatchObject({ botIds: [], version: 1 });
  });

  it('a lista do dono traz todos os docs com os bots (e filtra por bot), a do bot só os compartilhados com ele e sem os outros bots, e nenhuma traz o texto', async () => {
    const world = await createDocsWorld();
    try {
      const a = await world.bot();
      const b = await world.bot();
      const onlyA = await world.create({ title: 'So A', botIds: [a.id] });
      const both = await world.create({ title: 'A e B', botIds: [a.id, b.id] });
      const none = await world.create({ title: 'Sem bot' });
      const all = await world.docs.list(owner);
      expect(all.docs.map((doc) => doc.id).sort()).toEqual([onlyA.id, both.id, none.id].sort());
      expect(all.docs.find((doc) => doc.id === both.id)!.botIds).toEqual([a.id, b.id].sort());
      expect(all.docs.every((doc) => !('content' in doc))).toBe(true);
      expect((await world.docs.list(owner, { botId: b.id })).docs.map((doc) => doc.id)).toEqual([both.id]);
      expect(await codeOf(world.docs.list(owner, { botId: randomUUID() }))).toBe('BOT_NOT_FOUND');
      const mine = await world.docs.list(botActor(a.id));
      expect(mine.docs.map((doc) => doc.id).sort()).toEqual([onlyA.id, both.id].sort());
      expect(mine.docs.every((doc) => doc.botIds.length === 0)).toBe(true);
    } finally {
      await world.cleanup();
    }
  });
});

describe('versões, restauração e retenção (A15, A16, A32)', () => {
  it('restaurar a versão 2 cria uma versão nova com o texto dela, as posteriores continuam no histórico e restaurar o que já é o atual não cria versão (A15)', async () => {
    const doc = await w.create({ content: 'v1' });
    for (const [index, text] of ['v2', 'v3', 'v4'].entries()) {
      await w.docs.update(doc.id, { expectedVersion: index + 1, operationId: operation(), edit: rewrite(text) }, owner);
    }
    const restored = await w.docs.restore(doc.id, { version: 2, expectedVersion: 4, operationId: operation() }, owner, ORIGIN);
    expect(restored).toMatchObject({ changed: true, doc: { version: 5, updatedBy: 'owner' } });
    expect((await w.docs.get(doc.id, owner)).content).toBe('v2');
    expect((await versionsOf(w.pool, doc.id)).map((row) => [row.version, row.content, row.restored_from])).toEqual([
      [1, 'v1', null], [2, 'v2', null], [3, 'v3', null], [4, 'v4', null], [5, 'v2', 2],
    ]);
    // Versão que não existe (nunca existiu ou a retenção apagou) e restauração do texto atual.
    expect(await codeOf(w.docs.restore(doc.id, { version: 99, expectedVersion: 5, operationId: operation() }, owner))).toBe('DOC_VERSION_NOT_FOUND');
    expect(await w.docs.restore(doc.id, { version: 5, expectedVersion: 5, operationId: operation() }, owner)).toMatchObject({ changed: false, doc: { version: 5 } });
    expect((await versionsOf(w.pool, doc.id)).length).toBe(5);
  });

  it('o bot lista as versões (data, autor e tamanho) e restaura com a versão esperada atual; fica registrada como feita pelo bot; versão esperada antiga é conflito (A32)', async () => {
    const bot = await w.bot();
    const actor = botActor(bot.id);
    const doc = await w.create({ content: 'original', botIds: [bot.id] });
    await w.docs.update(doc.id, { expectedVersion: 1, operationId: operation(), edit: rewrite('trocado pelo bot') }, actor);
    await w.docs.update(doc.id, { expectedVersion: 2, operationId: operation(), edit: rewrite('trocado de novo') }, owner);
    const listed = await w.docs.listVersions(doc.id, actor);
    expect(listed.versions.map((item) => [item.version, item.author, item.size, item.restoredFrom])).toEqual([
      [3, 'owner', 15, null], [2, 'bot', 16, null], [1, 'owner', 8, null],
    ]);
    expect(listed.versions.every((item) => !Number.isNaN(Date.parse(item.createdAt)))).toBe(true);
    expect(listed.versions.every((item) => !('content' in item))).toBe(true);

    const before = await dump(w.pool);
    expect(await codeOf(w.docs.restore(doc.id, { version: 1, expectedVersion: 2, operationId: operation() }, actor))).toBe('DOC_CONFLICT');
    expect(await dump(w.pool)).toEqual(before);

    const restored = await w.docs.restore(doc.id, { version: 1, expectedVersion: 3, operationId: operation() }, actor);
    expect(restored).toMatchObject({ changed: true, doc: { version: 4, updatedBy: 'bot' } });
    expect(await versionsOf(w.pool, doc.id)).toContainEqual({ version: 4, content: 'original', author: 'bot', restored_from: 1 });
    expect((await w.docs.getVersion(doc.id, 2, actor)).content).toBe('trocado pelo bot');
    expect(await codeOf(w.docs.getVersion(doc.id, 99, actor))).toBe('DOC_VERSION_NOT_FOUND');
  });

  it('a retenção apaga as versões com mais de 90 dias, mas nunca as 50 mais recentes de cada doc, com relógio injetado; repetir não apaga mais nada (A16)', async () => {
    const now = new Date('2026-10-28T12:00:00.000Z');
    const day = 86_400_000;
    const world = await createDocsWorld(() => now);
    try {
      const seed = async (title: string, ages: (version: number) => number): Promise<string> => {
        const doc = await world.create({ title });
        // Versões sintéticas 1..N com a idade dada, e a versão atual do doc é a mais recente.
        await world.pool.query('DELETE FROM doc_versions WHERE doc_id = $1', [doc.id]);
        const total = 55;
        for (let version = 1; version <= total; version += 1) {
          await world.pool.query("INSERT INTO doc_versions (doc_id, version, content, author, created_at) VALUES ($1, $2, $3, 'owner', $4)", [doc.id, version, `v${version}`, new Date(now.getTime() - ages(version))]);
        }
        await world.pool.query('UPDATE docs SET version = $2, content = $3 WHERE id = $1', [doc.id, total, `v${total}`]);
        return doc.id;
      };
      const remaining = async (id: string): Promise<number[]> => (await world.pool.query<{ version: number }>('SELECT version FROM doc_versions WHERE doc_id = $1 ORDER BY version', [id])).rows.map((row) => row.version);
      const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, index) => from + index);

      const allOld = await seed('Todas velhas', () => 200 * day); // 55 versões de 200 dias: saem as 5 mais antigas (rank 51 a 55)
      const mixed = await seed('Velhas e novas', (version) => (version <= 40 ? 200 : 10) * day); // 40 velhas e 15 novas: as 5 mais antigas são velhas e saem
      const allNew = await seed('Todas novas', () => 10 * day); // acima de 50, mas com menos de 90 dias: ficam todas
      const edge = await seed('Na fronteira', (version) => (version === 1 ? 90 * day : version === 2 ? 90 * day + 60_000 : 1 * day)); // v1 em exatamente 90 dias fica; v2 em 90 dias e 1 minuto sai
      const few = await world.create({ title: 'Poucas' });
      await world.pool.query("INSERT INTO doc_versions (doc_id, version, content, author, created_at) SELECT $1, n, 'v', 'owner', $2 FROM generate_series(2, 10) AS n", [few.id, new Date(now.getTime() - 300 * day)]);

      expect(await world.docs.purgeExpiredVersions()).toBe(5 + 5 + 0 + 1);
      expect(await remaining(allOld)).toEqual(range(6, 55));
      expect(await remaining(mixed)).toEqual(range(6, 55));
      expect(await remaining(allNew)).toEqual(range(1, 55));
      expect(await remaining(edge)).toEqual([1, ...range(3, 55)]);
      expect(await remaining(few.id)).toEqual(range(1, 10)); // menos de 50 versões: nenhuma sai, por mais velha que seja
      expect((await world.docs.get(allOld, owner)).version).toBe(55); // a versão atual é sempre uma das mais recentes
      expect(await world.docs.purgeExpiredVersions()).toBe(0);
    } finally {
      await world.cleanup();
    }
  });
});

describe('exclusão (A14, A25, DOC-01)', () => {
  it('o bot só exclui com a prova de aprovação da ação certa; o dono exclui sem prova; a exclusão leva as versões e as associações e deixa o recibo', async () => {
    const bot = await w.bot();
    const doc = await w.create({ title: 'Apagável', content: 'x', botIds: [bot.id] });
    await w.docs.update(doc.id, { expectedVersion: 1, operationId: operation(), edit: append('y') }, owner);
    const before = await dump(w.pool);
    const actor = botActor(bot.id);
    // Sem prova, com prova de outra ação ou com prova de uma ação de tabela: APPROVAL_REQUIRED e nada muda.
    expect(await codeOf(w.docs.delete(doc.id, { operationId: operation() }, actor))).toBe('APPROVAL_REQUIRED');
    expect(await codeOf(w.docs.delete(doc.id, { operationId: operation() }, actor, grantApprovalProof('aion_table_delete', 'owner_approved')))).toBe('APPROVAL_REQUIRED');
    expect(await dump(w.pool)).toEqual(before);

    const proof = grantApprovalProof(DOC_ACTIONS.delete.slug, 'owner_approved');
    const operationId = operation();
    // O resultado da exclusão não leva o título: o dono exclui esperando que o nome saia (o cartão de aprovação é quem o mostra, antes).
    expect(await w.docs.delete(doc.id, { operationId }, actor, proof, ORIGIN)).toEqual({ id: doc.id, deleted: true });
    for (const table of ['docs', 'doc_versions', 'doc_bot_access']) expect((await dump(w.pool))[table]!.some((row) => row.includes(doc.id))).toBe(false);
    expect((await dump(w.pool)).doc_mutation_receipts!.some((row) => row.includes(operationId))).toBe(true);
    expect(await codeOf(w.docs.get(doc.id, owner))).toBe('DOC_NOT_FOUND');

    // O dono exclui pela tela, sem aprovação.
    const mine = await w.create({ title: 'Do dono' });
    expect(await w.docs.delete(mine.id, { operationId: operation() }, owner)).toMatchObject({ id: mine.id, deleted: true });
  });

  it('com o bot excluído, o doc e as versões continuam e os outros bots mantêm o acesso (A25)', async () => {
    const x = await w.bot('Bot X dos docs');
    const y = await w.bot('Bot Y dos docs');
    const doc = await w.create({ title: 'Plano', content: 'texto', botIds: [x.id, y.id] });
    await w.docs.update(doc.id, { expectedVersion: 1, operationId: operation(), edit: append('do bot X') }, botActor(x.id));
    const versions = await versionsOf(w.pool, doc.id);
    expect(versions.map((row) => row.author)).toEqual(['owner', 'bot']);

    await w.bots.archive(x.id, ORIGIN);
    await w.bots.deleteArchived(x.id, 'Bot X dos docs', ORIGIN);

    expect(await versionsOf(w.pool, doc.id)).toEqual(versions); // o autor "bot" continua, sem vínculo com o bot excluído
    const kept = await w.docs.get(doc.id, owner);
    expect(kept).toMatchObject({ title: 'Plano', content: 'texto\ndo bot X', botIds: [y.id], version: 2 });
    expect(kept.accessVersion).toBe(2); // a revisão de acesso sobe: uma tela de compartilhamento aberta antes não grava por cima
    expect((await w.docs.get(doc.id, botActor(y.id))).content).toBe('texto\ndo bot X');
    expect((await w.docs.list(botActor(y.id))).docs.map((item) => item.id)).toContain(doc.id);
  });
});

describe('recibos idempotentes por ator e operação (CLAUDE.md, item 25)', () => {
  it('repetir a mesma operação devolve o resultado gravado sem criar outra versão; a mesma operação com outro conteúdo é DOC_CONFLICT; outro ator tem os próprios recibos', async () => {
    const bot = await w.bot();
    const doc = await w.create({ content: 'a', botIds: [bot.id] });
    const actor = botActor(bot.id);
    const input = { expectedVersion: 1, operationId: operation(), edit: append('b') };
    const first = await w.docs.update(doc.id, input, actor);
    const replay = await w.docs.update(doc.id, input, actor); // o replay de uma execução abandonada: a versão esperada é a antiga e não conflita
    expect(replay).toEqual(first);
    expect((await versionsOf(w.pool, doc.id)).length).toBe(2);
    expect(await codeOf(w.docs.update(doc.id, { ...input, edit: append('c') }, actor))).toBe('DOC_CONFLICT');
    expect(await codeOf(w.docs.update(doc.id, { ...input, expectedVersion: 2 }, actor))).toBe('DOC_CONFLICT');
    // A criação repetida devolve o mesmo doc, e só existe um.
    const created = { title: 'Replay', content: 'x', operationId: operation() };
    const one = await w.docs.create(created, owner);
    const two = await w.docs.create(created, owner);
    expect(two).toEqual(one);
    expect(Number((await w.pool.query('SELECT count(*) FROM docs WHERE title = $1', ['Replay'])).rows[0].count)).toBe(1);
    // O recibo é do ator: a mesma identidade de operação usada pelo dono é outra operação.
    const asOwner = await w.docs.update(doc.id, { expectedVersion: 2, operationId: input.operationId, edit: append('do dono') }, owner);
    expect(asOwner.doc.version).toBe(3);
  });

  it('a exclusão repetida (retomada após reinício) devolve o resultado gravado mesmo com o doc já apagado; sem acesso ou com outro ator, é inexistente', async () => {
    const bot = await w.bot();
    const other = await w.bot();
    const doc = await w.create({ title: 'Some', botIds: [bot.id] });
    const proof = grantApprovalProof(DOC_ACTIONS.delete.slug, 'owner_approved');
    const input = { operationId: operation() };
    const first = await w.docs.delete(doc.id, input, botActor(bot.id), proof);
    expect(first).toEqual({ id: doc.id, deleted: true }); // sem título: o replay devolve exatamente isto
    expect(await w.docs.delete(doc.id, input, botActor(bot.id), proof)).toEqual(first);
    expect(await w.docs.delete(doc.id, input, botActor(bot.id))).toEqual(first); // o replay não pede a prova de novo: o efeito já foi aprovado e aplicado
    expect(await codeOf(w.docs.delete(doc.id, { operationId: operation() }, botActor(other.id), proof))).toBe('DOC_NOT_FOUND');
  });

  it('depois da exclusão nenhum recibo do doc guarda o título (create, update, restore, share e delete), e os recibos dos outros docs não são tocados', async () => {
    const bot = await w.bot();
    const title = 'TITULO-QUE-DEVE-SAIR';
    const kept = await w.create({ title: 'TITULO-QUE-FICA', botIds: [bot.id] });
    const doc = await w.create({ title, content: 'a', botIds: [bot.id] });
    await w.docs.update(doc.id, { expectedVersion: 1, operationId: operation(), edit: append('b') }, botActor(bot.id));
    await w.docs.update(doc.id, { expectedVersion: 2, operationId: operation(), title: `${title} 2` }, owner);
    await w.docs.restore(doc.id, { version: 1, expectedVersion: 2, operationId: operation() }, owner);
    await w.docs.share(doc.id, { botIds: [], expectedAccessVersion: 1, operationId: operation() }, owner);
    const receipts = (id: string) => w.pool.query<{ action: string; result: unknown }>('SELECT action, result FROM doc_mutation_receipts WHERE doc_id = $1 ORDER BY created_at, action', [id]);
    // Antes da exclusão os recibos guardam o resultado (com o título): é o que faz a repetição devolver o gravado.
    expect(JSON.stringify((await receipts(doc.id)).rows)).toContain(title);

    const operationId = operation();
    await w.docs.delete(doc.id, { operationId }, owner);
    const after = (await receipts(doc.id)).rows;
    expect(after.map((row) => row.action).sort()).toEqual(['doc.create', 'doc.delete', 'doc.restore', 'doc.share', 'doc.update', 'doc.update']);
    expect(JSON.stringify(after)).not.toContain(title);
    expect(JSON.stringify((await w.pool.query('SELECT result FROM doc_mutation_receipts')).rows)).not.toContain(title);
    // O recibo da exclusão guarda só o que o replay devolve; o de outro doc segue como estava.
    expect(after.find((row) => row.action === 'doc.delete')!.result).toEqual({ id: doc.id, deleted: true });
    expect(JSON.stringify((await receipts(kept.id)).rows)).toContain('TITULO-QUE-FICA');
    // A repetição de qualquer operação sobre o doc excluído não devolve título: a exclusão devolve o resultado sem ele e as demais são DOC_NOT_FOUND.
    expect(await w.docs.delete(doc.id, { operationId }, owner)).toEqual({ id: doc.id, deleted: true });
    expect(await codeOf(w.docs.update(doc.id, { expectedVersion: 1, operationId: operation(), edit: append('c') }, owner))).toBe('DOC_NOT_FOUND');
  });

  it('o replay de uma escrita respeita o acesso de agora: o bot que perdeu o acesso recebe DOC_NOT_FOUND, e o doc apagado também', async () => {
    const bot = await w.bot();
    const revoked = await w.create({ content: 'a', botIds: [bot.id] });
    const removed = await w.create({ content: 'a', botIds: [bot.id] });
    const inputRevoked = { expectedVersion: 1, operationId: operation(), edit: append('b') };
    const inputRemoved = { expectedVersion: 1, operationId: operation(), edit: append('b') };
    await w.docs.update(revoked.id, inputRevoked, botActor(bot.id));
    await w.docs.update(removed.id, inputRemoved, botActor(bot.id));
    await w.docs.share(revoked.id, { botIds: [], expectedAccessVersion: 1, operationId: operation() }, owner);
    await w.docs.delete(removed.id, { operationId: operation() }, owner);
    expect(await codeOf(w.docs.update(revoked.id, inputRevoked, botActor(bot.id)))).toBe('DOC_NOT_FOUND');
    expect(await codeOf(w.docs.update(removed.id, inputRemoved, botActor(bot.id)))).toBe('DOC_NOT_FOUND');
  });
});

describe('guarda de execução do bot', () => {
  it('a escrita do bot só vale com a execução ainda ativa, com a posse atual e sem cancelamento; a do dono não depende de execução', async () => {
    const bot = await w.bot();
    const doc = await w.create({ content: 'a', botIds: [bot.id] });
    const conversation = (await w.pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [bot.id])).rows[0]!.id;
    const lease = randomUUID();
    const run = (
      await w.pool.query<{ id: string }>("INSERT INTO runs (conversation_id, bot_id, status, input, created_at, lease_until, lease_owner) VALUES ($1, $2, 'running', 'x', now(), now() + interval '1 hour', $3) RETURNING id", [conversation, bot.id, lease])
    ).rows[0]!.id;
    const abort = new AbortController();
    const guarded = w.service({ execution: { runId: run, signal: abort.signal, leaseOwner: lease } });
    const actor = botActor(bot.id);
    expect((await guarded.update(doc.id, { expectedVersion: 1, operationId: operation(), edit: append('b') }, actor)).doc.version).toBe(2);

    await w.pool.query("UPDATE runs SET stop_requested_at = now() WHERE id = $1", [run]);
    const before = await dump(w.pool);
    expect(await codeOf(guarded.update(doc.id, { expectedVersion: 2, operationId: operation(), edit: append('c') }, actor))).toBe('DOC_CONFLICT');
    await w.pool.query('UPDATE runs SET stop_requested_at = NULL WHERE id = $1', [run]);
    abort.abort();
    expect(await codeOf(guarded.update(doc.id, { expectedVersion: 2, operationId: operation(), edit: append('c') }, actor))).toBe('DOC_CONFLICT');
    expect(await dump(w.pool)).toEqual(before);
    expect((await guarded.update(doc.id, { expectedVersion: 2, operationId: operation(), edit: append('do dono') }, owner)).doc.version).toBe(3);
  });
});

describe('a posse da execução é conferida sob trava (FOR SHARE em runs)', () => {
  /** Um bot com um doc compartilhado e uma execução `running` dele, com a posse `lease` valendo por uma hora, como a que o motor reivindicou; o serviço guardado é o que a ferramenta usa. */
  async function scenario() {
    const bot = await w.bot();
    const doc = await w.create({ content: 'a', botIds: [bot.id] });
    const conversation = (await w.pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [bot.id])).rows[0]!.id;
    const lease = randomUUID();
    const run = (
      await w.pool.query<{ id: string }>("INSERT INTO runs (conversation_id, bot_id, status, input, created_at, lease_until, lease_owner) VALUES ($1, $2, 'running', 'x', now(), now() + interval '1 hour', $3) RETURNING id", [conversation, bot.id, lease])
    ).rows[0]!.id;
    const guarded = w.service({ execution: { runId: run, signal: new AbortController().signal, leaseOwner: lease } });
    const write = (version: number) => guarded.update(doc.id, { expectedVersion: version, operationId: operation(), edit: append('b') }, botActor(bot.id));
    return { doc, run, lease, write };
  }
  /** Espera uma sessão do banco parada numa trava com a consulta que casa com `like`: o instante em que a escrita sob prova chegou ao ponto que o teste quer observar. */
  async function waitForLockWait(like: string): Promise<void> {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      const waiting = await w.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1", [like]);
      if (waiting.rowCount) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`nenhuma sessão esperando a trava de ${like}`);
  }

  it('posse vencida (lease_until no passado): a escrita não grava nada; com a posse renovada, a mesma escrita vale', async () => {
    const { run, write } = await scenario();
    await w.pool.query("UPDATE runs SET lease_until = now() - interval '1 second' WHERE id = $1", [run]);
    const before = await dump(w.pool);
    expect(await codeOf(write(1))).toBe('DOC_CONFLICT');
    expect(await dump(w.pool)).toEqual(before);
    await w.pool.query("UPDATE runs SET lease_until = now() + interval '1 hour' WHERE id = $1", [run]);
    expect((await write(1)).doc.version).toBe(2);
  });

  it('a troca de posse que termina enquanto a escrita espera a linha da execução recusa a escrita: a conferência relê a linha mais nova e nada é gravado', async () => {
    const { run, write } = await scenario();
    const motor = await w.pool.connect(); // simula o motor que já tomou a linha para trocar a posse (a reivindicação trava a linha e troca o dono) e ainda não commitou
    try {
      await motor.query('BEGIN');
      await motor.query('SELECT 1 FROM runs WHERE id = $1 FOR UPDATE', [run]);
      const before = await dump(w.pool);
      const pending = refusal(write(1));
      await waitForLockWait('%FROM runs%FOR SHARE%'); // sem o FOR SHARE a conferência era um SELECT que não esperava e lia a posse antiga
      await motor.query("UPDATE runs SET lease_owner = $2, lease_until = now() + interval '1 hour' WHERE id = $1", [run, randomUUID()]);
      await motor.query('COMMIT');
      expect((await pending).code).toBe('DOC_CONFLICT');
      expect(await dump(w.pool)).toEqual(before);
    } finally {
      await motor.query('ROLLBACK').catch(() => undefined);
      motor.release();
    }
  });

  it('uma escrita em curso segura a linha da execução: `claimNext` (FOR UPDATE SKIP LOCKED) a pula e o UPDATE da posse espera, então a troca não ultrapassa a escrita, que termina com a posse que conferiu', async () => {
    const { doc, run, write } = await scenario();
    const blocker = await w.pool.connect(); // segura a linha do doc para a escrita parar no meio da transação, já com a posse conferida e travada
    const motor = await w.pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM docs WHERE id = $1 FOR NO KEY UPDATE', [doc.id]); // não conflita com a chave estrangeira das versões: a escrita para no UPDATE do doc, depois de inserir a versão
      const pending = refusal(write(1));
      await waitForLockWait('UPDATE docs%');
      await motor.query('BEGIN');
      // `claimNext` reivindica execuções abandonadas com `FOR UPDATE SKIP LOCKED`: a linha travada pela escrita é PULADA (não aparece), e um UPDATE da linha (batimento, pedido de parada) ESPERA.
      expect((await motor.query('SELECT id FROM runs WHERE id = $1 FOR UPDATE SKIP LOCKED', [run])).rowCount).toBe(0);
      await motor.query("SET LOCAL lock_timeout = '300ms'");
      await expect(motor.query('UPDATE runs SET lease_owner = $2 WHERE id = $1', [run, randomUUID()])).rejects.toMatchObject({ code: '55P03' });
      await motor.query('ROLLBACK');
      await blocker.query('COMMIT');
      expect((await pending).code).toBe('OK');
      expect((await w.pool.query<{ version: number }>('SELECT version FROM docs WHERE id = $1', [doc.id])).rows[0]!.version).toBe(2);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      await motor.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      motor.release();
    }
  });
});

describe('leitura paginada por caractere (A21)', () => {
  it('as páginas de um doc de 100.000 caracteres (com emojis) cabem no tamanho pedido, não partem um caractere e, em sequência, devolvem o texto inteiro', async () => {
    const bot = await w.bot();
    const actor = botActor(bot.id);
    const content = Array.from({ length: 100_000 }, (_, index) => (index % 7 === 0 ? '😀' : index % 11 === 0 ? 'é' : String.fromCharCode(97 + (index % 26)))).join('');
    const doc = await w.create({ title: 'Grande', content, botIds: [bot.id] });
    expect(doc.size).toBe(100_000);
    const pages: string[] = [];
    let offset = 0;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await w.docs.read(doc.id, actor, { offset, limit: 10_000, expectedVersion: 1 });
      expect(page).toMatchObject({ id: doc.id, title: 'Grande', version: 1, size: 100_000, offset });
      expect(countChars(page.content)).toBeLessThanOrEqual(10_000);
      expect(page.content).not.toMatch(/\p{Surrogate}/u); // nenhum surrogate solto: a página nunca parte um emoji ao meio
      pages.push(page.content);
      if (page.nextOffset === null) break;
      expect(page.nextOffset).toBe(offset + countChars(page.content));
      offset = page.nextOffset;
    }
    expect(pages).toHaveLength(10);
    expect(pages.join('')).toBe(content);
  });

  it('o padrão é uma página de 10.000, o limite 1 devolve um caractere, o início além do fim devolve vazio e a versão esperada antiga é conflito', async () => {
    const doc = await w.create({ content: '😀abc' });
    expect(await w.docs.read(doc.id, owner)).toMatchObject({ content: '😀abc', nextOffset: null, size: 4, offset: 0 });
    expect(await w.docs.read(doc.id, owner, { limit: 1 })).toMatchObject({ content: '😀', nextOffset: 1 });
    expect(await w.docs.read(doc.id, owner, { offset: 4, limit: 5 })).toMatchObject({ content: '', nextOffset: null });
    expect(await w.docs.read(doc.id, owner, { offset: 9, limit: 5 })).toMatchObject({ content: '', nextOffset: null });
    await w.docs.update(doc.id, { expectedVersion: 1, operationId: operation(), edit: append('d') }, owner);
    expect(await codeOf(w.docs.read(doc.id, owner, { expectedVersion: 1 }))).toBe('DOC_CONFLICT');
    expect(await codeOf(w.docs.read(doc.id, owner, { limit: 0 }))).toBe('VALIDATION_FAILED');
    expect(await codeOf(w.docs.read(doc.id, owner, { offset: -1 }))).toBe('VALIDATION_FAILED');
  });
});

describe('auditoria', () => {
  it('registra quem fez o quê (ator, versão, tamanho) e nunca o título nem o texto do doc', async () => {
    const world = await createDocsWorld();
    try {
      const bot = await world.bot();
      const secret = 'TÍTULO-SIGILOSO-123';
      const text = 'TEXTO-SIGILOSO-456';
      const doc = await world.create({ title: secret, content: text, botIds: [bot.id] });
      await world.docs.update(doc.id, { expectedVersion: 1, operationId: operation(), edit: append(text) }, botActor(bot.id));
      await world.docs.restore(doc.id, { version: 1, expectedVersion: 2, operationId: operation() }, owner, ORIGIN);
      await world.docs.share(doc.id, { botIds: [], expectedAccessVersion: 1, operationId: operation() }, owner, ORIGIN);
      await world.docs.delete(doc.id, { operationId: operation() }, owner, undefined, ORIGIN);
      const rows = (await world.pool.query<{ action: string; actor: string; target: string; ip: string | null; details: Record<string, unknown> }>("SELECT action, actor, target, ip, details FROM audit_log WHERE action LIKE 'doc.%' ORDER BY id")).rows;
      expect(rows.map((row) => row.action)).toEqual(['doc.create', 'doc.update', 'doc.restore', 'doc.share', 'doc.delete']);
      expect(rows.map((row) => row.actor)).toEqual(['owner', 'system', 'owner', 'owner', 'owner']);
      expect(rows.every((row) => row.target === doc.id)).toBe(true);
      expect(rows[1]!.details).toMatchObject({ actor: `bot:${bot.id}`, version: 2 });
      expect(rows[2]!.ip).toBe(ORIGIN.ip);
      expect(JSON.stringify(rows)).not.toContain(secret);
      expect(JSON.stringify(rows)).not.toContain(text);
      // Uma operação que não muda nada não gera auditoria.
      const kept = await world.create({ content: 'x' });
      const audited = (await world.pool.query('SELECT count(*)::int AS total FROM audit_log WHERE action LIKE \'doc.%\'')).rows[0].total as number;
      await world.docs.update(kept.id, { expectedVersion: 1, operationId: operation(), edit: rewrite('x') }, owner);
      expect((await world.pool.query('SELECT count(*)::int AS total FROM audit_log WHERE action LIKE \'doc.%\'')).rows[0].total).toBe(audited);
    } finally {
      await world.cleanup();
    }
  });
});

describe('peek (o que a aprovação de exclusão mostra, decisão 23)', () => {
  it('devolve id e título só a quem tem acesso, sem registrar evidência', async () => {
    const bot = await w.bot();
    const doc = await w.create({ title: 'Plano de viagem', botIds: [bot.id] });
    const evidence: DocEvidenceEntry[] = [];
    const svc = w.service({ onEvidence: (entries) => evidence.push(...entries) });
    expect(await svc.peek(doc.id, botActor(bot.id))).toEqual({ id: doc.id, title: 'Plano de viagem' });
    expect(evidence).toEqual([]);
    const stranger = await w.bot();
    expect(await codeOf(svc.peek(doc.id, botActor(stranger.id)))).toBe('DOC_NOT_FOUND');
    expect(await svc.peek(doc.id, owner)).toEqual({ id: doc.id, title: 'Plano de viagem' });
  });
});

/** O retorno de `get` é o contrato que a API (3a) devolve ao dono: os campos e nenhum a mais. */
it('o doc completo traz os campos do contrato (e só eles)', async () => {
  const bot = await w.bot();
  const doc: Doc = await w.docs.get((await w.create({ title: 'Contrato', content: 'abc', botIds: [bot.id] })).id, owner);
  expect(Object.keys(doc).sort()).toEqual(['accessVersion', 'botIds', 'content', 'createdAt', 'id', 'size', 'title', 'updatedAt', 'updatedBy', 'version']);
  expect(doc).toMatchObject({ size: 3, version: 1, accessVersion: 1, updatedBy: 'owner' });
});

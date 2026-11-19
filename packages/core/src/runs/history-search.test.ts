// Prova da busca no histórico (A9, F6 passo 3; A5, F3 da phase 1): o bot encontra o que foi dito antes das últimas 5 rodadas, com trecho, data
// de origem e o id da mensagem para o link "ver na conversa". A busca é em português (radical das palavras) e tolera acento e plural (migration
// 0016), fica restrita à conversa do bot, devolve no máximo 3 trechos e não devolve o que a própria execução em curso escreveu.
// Três blocos: a execução real pelo motor (rodadas antigas fora do contexto), a tabela de consultas contra mensagens reais no PostgreSQL (acento,
// plural, E entre palavras, entrada hostil, índice usado pelo planner) e a degradação sem a extensão `unaccent` (a migration só avisa e a busca
// anterior segue funcionando).
import { randomBytes } from 'node:crypto';
import type { ActivityView } from '@aion/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { MIGRATIONS } from '../db/migrations';
import { waitForSchema, type Migration } from '../db/migrator';
import { createPool, type Pool } from '../db/pool';
import { createLogger } from '../logging';
import { migrateTestDatabase } from '../testing/migrate';
import { createTestDatabase, type TestDatabase } from '../testing/postgres';
import { historyResultSearchSql, historySearchMode, historySearchSql, searchHistoryTool, tolerantQueryText } from './search-history';
import { createRunsWorld, type RunsWorld } from './test-support';
import type { ToolContext } from './tools';

let world: RunsWorld;

beforeAll(async () => {
  world = await createRunsWorld();
  world.engine.start();
});

afterAll(async () => {
  await world.cleanup();
});

/** Grava uma rodada antiga (pergunta e resposta) direto na conversa do bot, com data fixa. */
async function seedRound(botId: string, question: string, answer: string, at: string): Promise<string> {
  const conversation = await world.pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [botId]);
  const conversationId = conversation.rows[0]!.id;
  const asked = await world.pool.query<{ id: string }>(
    `INSERT INTO messages (conversation_id, role, kind, status, opens_round, content, created_at)
     VALUES ($1, 'user', 'text', 'done', true, $2, $3) RETURNING id`,
    [conversationId, question, at],
  );
  await world.pool.query(
    `INSERT INTO messages (conversation_id, role, kind, status, step, content, created_at)
     VALUES ($1, 'assistant', 'text', 'done', 1, $2, $3)`,
    [conversationId, answer, at],
  );
  // Resposta sintética desta fixture não deriva de anexos ou recursos compartilhados.
  await world.pool.query(`UPDATE messages SET evidence_provenance='{"attachments":[],"tables":[]}'::jsonb WHERE conversation_id=$1 AND role='assistant' AND evidence_provenance IS NULL`, [conversationId]);
  return asked.rows[0]!.id;
}

/** Banco(s) e papel(éis) criados só por estes testes, removidos no fim. */
const extraDatabases: TestDatabase[] = [];
const extraPools: Pool[] = [];
const extraRoles: string[] = [];

afterAll(async () => {
  await Promise.all(extraPools.map((pool) => pool.end()));
  await Promise.all(extraDatabases.map((database) => database.drop()));
  if (extraRoles.length === 0) return;
  const admin = new pg.Client({ connectionString: inject('adminDatabaseUrl') });
  await admin.connect();
  try {
    for (const role of extraRoles) await admin.query(`DROP ROLE IF EXISTS ${role}`);
  } finally {
    await admin.end();
  }
});

/**
 * Cria uma conversa sem bot (como uma sessão do chat geral) com estas mensagens de texto concluídas, e devolve o id e o id de cada mensagem pela
 * etiqueta. Cada mensagem abre uma rodada respondida por uma execução concluída e pende da execução anterior, como o motor grava (phase 4: numa
 * sessão a busca só alcança o caminho ativo, e uma mensagem solta, sem pai, seria uma versão da primeira).
 */
async function seedConversation(pool: Pool, messages: Record<string, string>): Promise<{ id: string; ids: Record<string, string> }> {
  const conversation = await pool.query<{ id: string }>('INSERT INTO conversations (created_at) VALUES (now()) RETURNING id');
  const id = conversation.rows[0]!.id;
  const ids: Record<string, string> = {};
  let parent: string | null = null;
  for (const [tag, content] of Object.entries(messages)) {
    const run = await pool.query<{ id: string }>("INSERT INTO runs (conversation_id, status, input, created_at) VALUES ($1, 'completed', $2, now()) RETURNING id::text AS id", [id, content]);
    const row = await pool.query<{ id: string }>(
      `INSERT INTO messages (conversation_id, run_id, role, kind, status, opens_round, content, parent_run_id, created_at)
       VALUES ($1, $2, 'user', 'text', 'done', true, $3, $4, now()) RETURNING id::text AS id`,
      [id, run.rows[0]!.id, content, parent],
    );
    await pool.query('UPDATE runs SET trigger_message_id = $2 WHERE id = $1', [run.rows[0]!.id, row.rows[0]!.id]);
    ids[tag] = row.rows[0]!.id;
    parent = run.rows[0]!.id;
  }
  return { id, ids };
}

/** Executa `search_history` como o motor faria (argumentos em JSON, contexto da conversa); `runId` 0 não existe, então nada é excluído por vir da execução. */
async function search(pool: Pool, conversationId: string, query: string) {
  const context: ToolContext = { pool, conversationId, botId: null, runId: '0', signal: new AbortController().signal, now: () => new Date() };
  const outcome = await searchHistoryTool.prepare(JSON.stringify({ query })).execute(context);
  const hits = outcome.detail?.type === 'history_search' ? outcome.detail.hits : [];
  return { outcome, hits };
}

const activityOf = async (botId: string) => {
  const bot = { id: botId } as Parameters<RunsWorld['timeline']>[0];
  const entry = (await world.timeline(bot)).find((row) => row.kind === 'activity');
  return entry as unknown as { status: string; content: string; data: { label: string; detail: ActivityView['detail'] } };
};

describe('busca no histórico da conversa', () => {
  it('acha uma informação antiga fora da janela de 5 rodadas, com trecho, data de origem e link, sem vazar de outra conversa', async () => {
    const bot = await world.createBot();
    const other = await world.createBot();
    // A informação está na 1ª rodada; depois vêm 6 rodadas, então ela já saiu do contexto do modelo.
    const oldQuestion = await seedRound(bot.id, 'Na reunião com a Acme combinamos um contrato de 12 meses', 'Anotado: contrato Acme por 12 meses.', '2026-01-15T10:30:00.000Z');
    for (let round = 1; round <= 6; round += 1) await seedRound(bot.id, `assunto qualquer ${round}`, `ok ${round}`, `2026-02-0${round}T09:00:00.000Z`);
    await seedRound(other.id, 'O contrato Acme secreto de 18 meses é de outro bot', 'Não deve aparecer.', '2026-01-10T10:00:00.000Z');

    const runId = await world.send(bot, '[pesquisar:contratos Acme] o que combinamos com a Acme?');
    await world.waitForStatus(runId, 'completed');

    // A1: a informação antiga NÃO estava no contexto enviado ao modelo (só a pergunta atual e as rodadas recentes).
    const firstRequest = world.conversationRequests().at(-2)?.body?.messages as { role: string; content: string }[];
    expect(JSON.stringify(firstRequest)).not.toContain('contrato de 12 meses');

    const activity = await activityOf(bot.id);
    expect(activity).toMatchObject({ status: 'completed', data: { label: 'Pesquisou no histórico: contratos Acme' } });
    // "contratos" acha "contrato" (radical em português), e só a conversa deste bot entra.
    const detail = activity.data.detail;
    expect(detail).toMatchObject({ type: 'history_search', query: 'contratos Acme' });
    const hits = detail?.type === 'history_search' ? detail.hits : [];
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.length).toBeLessThanOrEqual(3);
    const found = hits.find((hit) => hit.messageId === oldQuestion);
    expect(found).toBeDefined();
    expect(found?.createdAt).toBe('2026-01-15T10:30:00.000Z');
    expect(found?.snippet).toContain('Acme');
    expect(found?.snippet).not.toMatch(/[«»]/); // os marcadores do destaque não vazam
    expect(JSON.stringify(hits)).not.toContain('secreto');
    // A pergunta da própria execução (que também tem "Acme") não volta como resultado.
    const current = await world.pool.query<{ id: string }>("SELECT id::text FROM messages WHERE run_id = $1 AND role = 'user'", [runId]);
    expect(hits.map((hit) => hit.messageId)).not.toContain(current.rows[0]?.id);

    // O modelo recebeu o resultado com a data, o id da mensagem e o tipo (phase 9, F5: é o que liga a busca a read_activity) e respondeu a partir dele.
    expect(activity.content).toContain(`[2026-01-15 10:30 UTC] messageId=${oldQuestion}, mensagem do dono:`);
    const timeline = await world.timeline(bot);
    expect(timeline.at(-1)?.content).toContain('Encontrei: Trechos encontrados');
  });

  it('devolve no máximo 3 trechos, trata palavra sem conteúdo como "nenhum trecho" e aceita a sintaxe de busca sem efeito colateral', async () => {
    const bot = await world.createBot();
    for (let round = 1; round <= 5; round += 1) await seedRound(bot.id, `Orçamento do projeto versão ${round}`, `Resposta sobre o orçamento ${round}`, `2026-03-0${round}T12:00:00.000Z`);

    const many = await world.send(bot, '[pesquisar:orçamento] liste');
    await world.waitForStatus(many, 'completed');
    const first = (await activityOf(bot.id)).data.detail;
    expect(first?.type === 'history_search' && first.hits).toHaveLength(3);

    const stop = await world.send(bot, '[pesquisar:de] só palavra vazia');
    await world.waitForStatus(stop, 'completed');
    const entries = (await world.timeline(bot)).filter((row) => row.kind === 'activity');
    expect(entries.at(-1)?.content).toBe('Nenhum trecho encontrado para "de".');

    const syntax = await world.send(bot, '[pesquisar:"orçamento do projeto" -zebra; DROP TABLE messages] sintaxe');
    await world.waitForStatus(syntax, 'completed');
    // O termo é só texto de consulta (parametrizado): a tabela continua lá e a execução terminou normalmente.
    expect(Number((await world.pool.query<{ total: string }>('SELECT count(*) AS total FROM messages')).rows[0]?.total)).toBeGreaterThan(10);
    expect((await world.runRow(syntax)).status).toBe('completed');
  });
});

describe('busca tolerante a acento e plural (migration 0016)', () => {
  /** Conversa da consulta; uma segunda conversa, criada à parte, não pode vazar para ela. */
  const corpus = {
    reuniao: 'Na reunião de segunda decidimos o orçamento do projeto',
    reunioes: 'As reuniões da semana foram canceladas',
    contrato: 'O contrato de aluguel vence em março',
    caes: 'Passeei com os cães e comprei pão',
    acoes: 'As ações da empresa subiram na bolsa',
    ordem: 'A ordem de compra foi aprovada',
  };
  let conversationId: string;
  let ids: Record<string, string>;

  beforeAll(async () => {
    const own = await seedConversation(world.pool, corpus);
    conversationId = own.id;
    ids = own.ids;
    // O que a busca NUNCA devolve: texto ainda em escrita, resultado de ferramenta de origem desconhecida (sem `evidence_provenance`: a busca também
    // alcança resultados, mas só os de proveniência válida, ver recall.test.ts) e uma mensagem de outra conversa.
    await world.pool.query(
      `INSERT INTO messages (conversation_id, role, kind, status, step, content, created_at) VALUES
         ($1, 'assistant', 'text', 'streaming', 1, 'reunião sendo escrita agora', now()),
         ($1, 'assistant', 'activity', 'completed', 1, 'resultado de ferramenta com reunião e orçamento', now())`,
      [conversationId],
    );
    await seedConversation(world.pool, { outra: 'A reunião secreta de outra conversa sobre o orçamento' });
  });

  const both = ['reuniao', 'reunioes'];
  it.each([
    ['reuniao', both],
    ['reunião', both],
    ['reuniões', both],
    ['reunioes', both],
    ['REUNIÃO', both],
    ['"reunião"', both], // aspas viram pontuação
    ['orcamento', ['reuniao']],
    ['orçamento', ['reuniao']],
    ['orçamentos', ['reuniao']],
    ['reunioes orcamento', ['reuniao']], // todas as palavras precisam aparecer (E), cada uma em qualquer variante
    ['reunião -orçamento', ['reuniao']], // o "-" não exclui mais: vira pontuação e "orçamento" passa a ser exigido
    ['reunião or orçamento', ['reuniao']], // o "or" é descartado (não é operador nem palavra exigida): sobram as duas palavras reais
    ['reunião OR orçamento', ['reuniao']],
    ['or', []], // só "or": nada a procurar
    ['or or', []],
    ['ordem', ['ordem']], // só a palavra inteira "or" cai: quem a contém continua valendo
    ['contratos', ['contrato']], // plural comum: o radical já junta
    ['cao', ['caes']],
    ['cão', ['caes']],
    ['caes', ['caes']],
    ['acao', ['acoes']],
    ['ações', ['acoes']],
    ['reunião zebra', []],
    ['de', []], // só palavra sem conteúdo
    ['!!!', []], // só pontuação
  ])('"%s" encontra %j', async (query, tags) => {
    const { hits, outcome } = await search(world.pool, conversationId, query);
    expect(hits.map((hit) => hit.messageId).sort()).toEqual(tags.map((tag) => ids[tag]!).sort());
    if (tags.length === 0) expect(outcome.result).toBe(`Nenhum trecho encontrado para "${query}".`);
  });

  it('devolve até 3 trechos com a data em UTC e destaca a palavra achada com a mesma configuração', async () => {
    const many = await seedConversation(world.pool, Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`m${n}`, `Orçamento do projeto, versão ${n}`])));
    await world.pool.query("UPDATE messages SET created_at = '2026-03-01T12:00:00.000Z' WHERE conversation_id = $1", [many.id]);
    const { hits, outcome } = await search(world.pool, many.id, 'orcamento');
    expect(hits).toHaveLength(3);
    expect(hits.every((hit) => hit.createdAt === '2026-03-01T12:00:00.000Z')).toBe(true);
    expect(outcome.result).toContain('[2026-03-01 12:00 UTC]');

    // O destaque bruto (antes de a ferramenta tirar os marcadores) cai na palavra com acento, que a consulta sem acento achou.
    const raw = await world.pool.query<{ snippet: string }>(historySearchSql('tolerant'), [many.id, tolerantQueryText('orcamento'), '0', 3]);
    expect(raw.rows[0]?.snippet).toContain('«Orçamento»');
  });

  it('usa o índice do histórico: a consulta tem a mesma expressão e predicado dele', async () => {
    // Tabela grande o bastante e uma palavra rara: o planner escolhe o índice GIN por custo, sem forçar nada.
    const bulk = await world.pool.query<{ id: string }>('INSERT INTO conversations (created_at) VALUES (now()) RETURNING id');
    const bulkId = bulk.rows[0]!.id;
    await world.pool.query(
      `INSERT INTO messages (conversation_id, role, kind, status, opens_round, content, created_at)
       SELECT $1, 'user', 'text', 'done', true, 'mensagem comum numero ' || n || ' sobre assuntos variados', now() FROM generate_series(1, 5000) AS n`,
      [bulkId],
    );
    await world.pool.query(
      "INSERT INTO messages (conversation_id, role, kind, status, opens_round, content, created_at) VALUES ($1, 'user', 'text', 'done', true, 'A reunião de ontem tratou do orçamento', now())",
      [bulkId],
    );
    await world.pool.query('ANALYZE messages');
    const plan = await world.pool.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${historySearchSql('tolerant')}`, [bulkId, tolerantQueryText('reuniões orcamento'), '0', 3]);
    expect(plan.rows.map((row) => row['QUERY PLAN']).join('\n')).toContain('Bitmap Index Scan on messages_search');
    expect((await search(world.pool, bulkId, 'reuniões orcamento')).hits).toHaveLength(1);
  });

  it('resultados de ferramenta (migration 0042): o planner usa o índice parcial e um resultado muito antigo, além dos mais recentes, ainda é achado', async () => {
    // Um bot com um resultado ANTIGO com o termo raro e milhares de resultados comuns depois dele: com o teto antigo (os 200 mais recentes) ele não seria achado.
    const bot = await world.createBot();
    const conversationId = (await world.pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [bot.id])).rows[0]!.id;
    const insertResults = (content: string, count: number) => world.pool.query<{ id: string }>(
      `INSERT INTO messages (conversation_id, role, kind, status, step, content, data, evidence_provenance, created_at)
       SELECT $1, 'assistant', 'activity', 'completed', 1, $2 || n, '{"callId":"c","tool":"table_read","label":"Ler","arguments":"{}","detail":null}', '{"attachments":[],"tables":[]}', now()
       FROM generate_series(1, $3::int) AS n RETURNING id::text AS id`, [conversationId, content, count]);
    const old = (await insertResults('Cartório: protocolo ZX900 aberto, número ', 1)).rows[0]!.id;
    await insertResults('resultado comum sobre assuntos variados, número ', 3000);
    await world.pool.query('ANALYZE messages');
    const plan = await world.pool.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${historyResultSearchSql('tolerant')}`, [conversationId, tolerantQueryText('zx900'), '0', 3]);
    expect(plan.rows.map((row) => row['QUERY PLAN']).join('\n')).toContain('Bitmap Index Scan on messages_result_search');
    const context: ToolContext = { pool: world.pool, conversationId, botId: bot.id, runId: '0', signal: new AbortController().signal, now: () => new Date() };
    const found = await searchHistoryTool.prepare(JSON.stringify({ query: 'zx900 cartorio' })).execute(context);
    expect(found.detail?.type === 'history_search' ? found.detail.hits.map((hit) => hit.messageId) : []).toEqual([old]);
    expect(found.result).toContain(`messageId=${old}, resultado de table_read:`);
  });

  it('trata o texto do modelo como dado: operadores, SQL e unicode viram só palavras ou pontuação, sem erro nem efeito colateral', async () => {
    const total = async () => Number((await world.pool.query<{ total: string }>('SELECT count(*) AS total FROM messages')).rows[0]?.total);
    const before = await total();
    for (const hostile of [
      "'); DROP TABLE messages; --",
      '&|!:*<->',
      "( ) ' \\ :* <-> & | !",
      'сообщение 会议 مرحبا ٣ İstanbul 😀',
      'a'.repeat(200),
    ]) {
      const { hits } = await search(world.pool, conversationId, hostile);
      expect(hits, hostile).toEqual([]);
    }
    // A mesma pontuação ao redor de uma palavra real não atrapalha: só a palavra conta.
    const mixed = await search(world.pool, conversationId, "reunião & | ! ( ) :* <-> \\ '");
    expect(mixed.hits.map((hit) => hit.messageId).sort()).toEqual(both.map((tag) => ids[tag]!).sort());
    expect(await total()).toBe(before);
  });
});

describe('sem a extensão unaccent', () => {
  /** Banco novo e o que falta para a 0016 não conseguir criar a extensão, de duas maneiras reais: não instalada no servidor e sem permissão. */
  async function databaseWithoutUnaccent(cause: 'not-installed' | 'no-permission'): Promise<{ pool: Pool; migrations: readonly Migration[] }> {
    const admin = inject('adminDatabaseUrl');
    const database = await createTestDatabase(admin);
    extraDatabases.push(database);
    if (cause === 'not-installed') {
      // O servidor de teste traz a extensão; pedir uma que não existe produz o mesmo erro (0A000, "is not available") de um pacote contrib ausente.
      const migrations = MIGRATIONS.map((migration) => {
        if (!migration.id.startsWith('0016')) return migration;
        const up = migration.up.replace('CREATE EXTENSION IF NOT EXISTS unaccent;', 'CREATE EXTENSION IF NOT EXISTS unaccent_ausente;');
        expect(up).not.toBe(migration.up);
        return { ...migration, up };
      });
      const pool = createPool(database.url, { applicationName: 'history-search-test' });
      extraPools.push(pool);
      return { pool, migrations };
    }
    // Usuário comum do banco (sem CREATE no banco, que é o que criar uma extensão confiável exige): a migration real, sem alteração.
    const role = `aion_semext_${randomBytes(4).toString('hex')}`;
    const password = randomBytes(12).toString('hex');
    const superuser = new pg.Client({ connectionString: database.url });
    await superuser.connect();
    try {
      await superuser.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
      extraRoles.push(role);
      await superuser.query(`GRANT ALL ON SCHEMA public TO ${role}`);
    } finally {
      await superuser.end();
    }
    const url = new URL(database.url);
    url.username = role;
    url.password = password;
    const pool = createPool(url.toString(), { applicationName: 'history-search-test' });
    extraPools.push(pool);
    return { pool, migrations: MIGRATIONS };
  }

  it.each(['not-installed', 'no-permission'] as const)(
    'a migration termina sem erro e avisa no log (%s), o schema fica pronto para a API e a busca anterior funciona',
    async (cause) => {
      const { pool, migrations } = await databaseWithoutUnaccent(cause);
      const lines: string[] = [];
      const logger = createLogger({ level: 'warn', name: 'history-search-test', destination: { write: (line: string) => void lines.push(line) } });

      // A migration termina (a API subiria) e o aviso chega ao log do serviço, identificando a migration.
      const ran = await migrateTestDatabase(pool, { migrations, logger });
      expect(ran).toEqual(MIGRATIONS.map((migration) => migration.id));
      await expect(waitForSchema(pool, { migrations, timeoutMs: 1_000, intervalMs: 50 })).resolves.toBeUndefined();
      const warnings = lines.map((line) => JSON.parse(line) as { level: number; migration?: string; msg: string }).filter((entry) => entry.level === 40);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({ migration: '0016_history_search_unaccent' });
      expect(warnings[0]?.msg).toContain('unaccent');

      // Nada da 0016 ficou pela metade: sem configuração nova, o índice é o anterior e a busca é a anterior.
      expect(await historySearchMode(pool)).toBe('fallback');
      const index = await pool.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE indexname = 'messages_search'");
      expect(index.rows[0]?.indexdef).toContain("to_tsvector('portuguese'::regconfig, content)");
      // O índice dos resultados de ferramenta (0042) acompanha a configuração de recuo: a busca de resultados continua usando o índice, sem a extensão.
      const resultIndex = await pool.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE indexname = 'messages_result_search'");
      expect(resultIndex.rows[0]?.indexdef).toContain("'portuguese'::regconfig");
      expect(resultIndex.rows[0]?.indexdef).not.toContain('portuguese_unaccent');

      // A busca anterior: acha com a palavra como está escrita e pelo radical, mas sem tolerância a acento (limitação documentada).
      const seeded = await seedConversation(pool, { reuniao: 'Na reunião de segunda fechamos o contrato' });
      expect((await search(pool, seeded.id, 'reunião')).hits.map((hit) => hit.messageId)).toEqual([seeded.ids.reuniao]);
      expect((await search(pool, seeded.id, 'contratos')).hits.map((hit) => hit.messageId)).toEqual([seeded.ids.reuniao]);
      expect((await search(pool, seeded.id, 'reuniao')).hits).toEqual([]);

      // A busca de resultados de ferramenta (phase 9, F5) também degrada para a configuração anterior: acha pelo radical, com o id e o tipo no texto.
      const run = (await pool.query<{ run_id: string }>('SELECT run_id::text AS run_id FROM messages WHERE id = $1', [seeded.ids.reuniao])).rows[0]!.run_id;
      const result = await pool.query<{ id: string }>(
        `INSERT INTO messages (conversation_id, run_id, role, kind, status, step, content, data, evidence_provenance, created_at)
         VALUES ($1, $2, 'assistant', 'activity', 'completed', 1, 'Tabela lida: protocolo ZX900 aberto', '{"callId":"c1","tool":"table_read","label":"Ler","arguments":"{}","detail":null}', '{"attachments":[],"tables":[]}', now())
         RETURNING id::text AS id`, [seeded.id, run]);
      const found = await search(pool, seeded.id, 'protocolos');
      expect(found.hits.map((hit) => hit.messageId)).toEqual([result.rows[0]!.id]);
      expect(found.outcome.result).toContain(`messageId=${result.rows[0]!.id}, resultado de table_read:`);
    },
  );

  it('o procedimento da 0016 depois de a extensão ficar disponível (rollback, apagar a linha, subir) ativa a busca tolerante também nos resultados de ferramenta', async () => {
    const { pool, migrations } = await databaseWithoutUnaccent('not-installed');
    await migrateTestDatabase(pool, { migrations });
    const unaccent = MIGRATIONS.find((migration) => migration.id.startsWith('0016'))!;
    // Antes: sem a configuração, a 0042 criou o índice dos resultados em `portuguese`, e "cartorio" não acha "cartório" (a busca anterior não tolera acento).
    expect(await historySearchMode(pool)).toBe('fallback');
    const seeded = await seedConversation(pool, { abertura: 'Pedido do dono' });
    const run = (await pool.query<{ run_id: string }>('SELECT run_id::text AS run_id FROM messages WHERE id = $1', [seeded.ids.abertura])).rows[0]!.run_id;
    const result = (await pool.query<{ id: string }>(
      `INSERT INTO messages (conversation_id, run_id, role, kind, status, step, content, data, evidence_provenance, created_at)
       VALUES ($1, $2, 'assistant', 'activity', 'completed', 1, 'Tabela lida: cartório com protocolo ZX900 aberto', '{"callId":"c1","tool":"table_read","label":"Ler","arguments":"{}","detail":null}', '{"attachments":[],"tables":[]}', now())
       RETURNING id::text AS id`, [seeded.id, run])).rows[0]!.id;
    expect((await search(pool, seeded.id, 'cartorio')).hits).toEqual([]);

    // O dono instala a extensão e segue o procedimento do cabeçalho da 0016, sem recriar nenhum índice à mão: com a extensão, a 0016 real cria a configuração e leva o
    // índice dos resultados a ela. (O rollback antes dele não faz nada aqui: a configuração nunca existiu.)
    await pool.query(unaccent.rollback);
    await pool.query('DELETE FROM schema_migrations WHERE id = $1', [unaccent.id]);
    expect(await migrateTestDatabase(pool)).toEqual([unaccent.id]);
    expect(await historySearchMode(pool)).toBe('tolerant');
    const resultIndex = await pool.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE indexname = 'messages_result_search'");
    expect(resultIndex.rows[0]?.indexdef).toContain("'portuguese_unaccent'::regconfig");
    const found = await search(pool, seeded.id, 'cartorio');
    expect(found.hits.map((hit) => hit.messageId)).toEqual([result]);
    expect(found.outcome.result).toContain(`messageId=${result}, resultado de table_read:`);
  });
});

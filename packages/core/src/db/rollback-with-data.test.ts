// Prova dos planos de rollback das migrations 0010 a 0020, 0028, 0029, 0053, 0054 e 0055 (rotinas, push, chat geral, silenciar, modelo padrão do chat, idioma e fuso, busca com
// unaccent, pesquisa na web, personagem do bot, remoção do personagem do bot) com o banco CHEIO (R22): o teste do migrator só roda os rollbacks num banco vazio, e estes apagam dados (a 0012 remove as
// sessões do chat geral com mensagens, execuções, aprovações e eventos; a 0010 as rotinas e o histórico). Aqui o banco tem um bot com conversa, uma rotina
// executada, uma sessão do chat geral com modelo padrão definido, um dispositivo de push com eventos, um silêncio, a chave da Parallel e o interruptor da
// pesquisa desligado, e o rollback precisa terminar sem violar nenhuma chave estrangeira e deixar intacto o que é do bot. A 0016 só troca um índice: aqui
// se prova que refazê-lo sobre mensagens existentes preserva todas e que o plano roda de novo sem erro (idempotente). A 0017 remove a chave da Parallel ANTES
// de restaurar a restrição de `credentials.kind` (senão ela falharia contra o dado novo) e preserva as demais credenciais, preferências e dados. A 0028 (a mais nova, que
// remove `bots.mascot`) recria a coluna com o valor calculado do id sem tocar no bot, na conversa nem nas mensagens; a 0018 remove só essa coluna de novo e preserva o
// bot, a conversa e as mensagens. O preenchimento dos bots antigos e a ida e volta da 0018 e da 0028 em detalhe estão no migrator.test.ts. O rollback da 0016
// roda com a 0042 aplicada (o índice dos resultados de ferramenta depende da configuração que ele remove): a ordem das duas em detalhe está no migrator.test.ts.
// A 0019 remove anexos preenchidos preservando suas mensagens; a 0020 remove só o cache de visão de um perfil cheio,
// preservando favorito, protocolo, esforço e resultado normal do teste.
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AttachmentService } from '../attachments/service';
import { readActivePath } from '../conversation/path';
import { GeneralChatService } from '../general-chat/service';
import { PushService } from '../push/service';
import { SettingsService, readAppSettings, readWebSearchEnabled } from '../settings/service';
import { historySearchMode } from '../runs/search-history';
import { ORIGIN, createRunsWorld, type RunsWorld } from '../runs/test-support';
import { pngFixture, xlsxFixture } from '../testing/attachment-fixtures';
import { startFakeSandbox } from '../testing/fake-sandbox';
import { pythonMarker } from '../testing/fake-upstreams';
import { seedLegacyChatApproval } from '../testing/legacy-chat-approval';
import { MIGRATIONS } from './migrations';
import type { Migration } from './migrator';
import { createPool, type Pool } from './pool';
import { migrateTestDatabase } from '../testing/migrate';
import { createTestDatabase } from '../testing/postgres';

/**
 * As migrations cujo rollback este teste exercita, da mais antiga à mais nova. Selecionadas por id (e não pelas últimas N do registro) para que
 * uma migration nova no fim do registro não deslize a janela e quebre o teste.
 */
const ROLLED_BACK_IDS = [
  '0010_routines',
  '0011_push',
  '0012_general_chat',
  '0013_push_mutes',
  '0014_general_chat_settings',
  '0015_app_settings',
  '0016_history_search_unaccent',
  '0017_web_search_settings',
  '0018_bot_mascot',
  '0019_attachments',
  '0020_model_image_support',
  '0028_drop_bot_mascot',
];

/** Os seis ids que a 0018 e o rollback da 0028 gravam em `bots.mascot` (lista fixa do SQL delas): o personagem saiu dos contratos na phase 5. */
const LEGACY_MASCOTS = ['circle', 'square', 'triangle', 'diamond', 'hexagon', 'pill'];

/** Banco histórico isolado: fixtures de rollback não executam um worker que escreve eventos de migrations posteriores. */
async function createHistoricalDatabase(migrationId: string) {
  const database = await createTestDatabase(inject('adminDatabaseUrl'));
  const pool = createPool(database.url, { applicationName: 'historical-rollback-test', max: 4 });
  try {
    await migrateTestDatabase(pool, { migrations: MIGRATIONS.filter((migration) => migration.id <= migrationId) });
  } catch (error) {
    await pool.end();
    await database.drop();
    throw error;
  }
  return { pool, async cleanup() { await pool.end(); await database.drop(); } };
}

/** Cria somente o dono/conversa exigidos pelas FKs do schema histórico; sessão não precisa de bot. */
async function seedHistoricalConversation(pool: Pool, botName?: string): Promise<{ id: string; botId: string | null }> {
  const botId = botName ? (await pool.query<{ id: string }>(
    "INSERT INTO bots (name, name_key, color, created_at, updated_at) VALUES ($1, $1, '#123ABC', now(), now()) RETURNING id", [botName],
  )).rows[0]!.id : null;
  const id = (await pool.query<{ id: string }>('INSERT INTO conversations (bot_id, created_at) VALUES ($1, now()) RETURNING id', [botId])).rows[0]!.id;
  return { id, botId };
}

/** Materializa uma rodada histórica com abertura, resposta e eventos antigos válidos, sem inferência ou telemetry moderna. */
async function seedHistoricalRound(pool: Pool, conversation: { id: string; botId: string | null }, content: string, status = 'completed') {
  const runId = (await pool.query<{ id: string }>(
    'INSERT INTO runs (conversation_id, bot_id, input, status, created_at) VALUES ($1, $2, $3, $4, now()) RETURNING id::text',
    [conversation.id, conversation.botId, content, status],
  )).rows[0]!.id;
  const messageId = (await pool.query<{ id: string }>(
    "INSERT INTO messages (conversation_id, run_id, role, kind, status, opens_round, content, created_at) VALUES ($1, $2, 'user', 'text', 'done', true, $3, now()) RETURNING id::text",
    [conversation.id, runId, content],
  )).rows[0]!.id;
  await pool.query('UPDATE runs SET trigger_message_id = $2 WHERE id = $1', [runId, messageId]);
  await pool.query("INSERT INTO messages (conversation_id, run_id, role, kind, status, step, content, created_at) VALUES ($1, $2, 'assistant', 'text', 'done', 1, 'Resposta histórica', now())", [conversation.id, runId]);
  await pool.query("INSERT INTO conversation_events (conversation_id, kind, ref, created_at) VALUES ($1, 'message', $2, now()), ($1, 'run', $3, now())", [conversation.id, messageId, runId]);
  return { runId, messageId };
}

/** Documento sintético completo, ligado ao complemento ou à rodada original conforme o schema sob teste. */
async function seedHistoricalAttachment(pool: Pool, conversationId: string, name: string, text: string, links: { complementId?: string; runId?: string; messageId?: string }) {
  return (await pool.query<{ id: string }>(
    "INSERT INTO attachments (conversation_id, kind, name, original_bytes, stored_bytes, extracted_text, complement_id, run_id, message_id) VALUES ($1, 'document', $2, $3, $3, $4, $5, $6, $7) RETURNING id::text",
    [conversationId, name, Buffer.byteLength(text), text, links.complementId ?? null, links.runId ?? null, links.messageId ?? null],
  )).rows[0]!;
}

let world: RunsWorld;

beforeAll(async () => {
  world = await createRunsWorld();
  await world.connectComposio();
  world.engine.start();
});

afterAll(async () => {
  await world.cleanup();
});

describe('rollback das migrations 0010 a 0020 e 0028 com dados', () => {
  it('apaga rotinas, sessões, eventos e silêncios sem violar chaves estrangeiras e preserva a conversa do bot', async () => {
    const push = new PushService({ pool: world.pool, config: { enabled: false } });
    await push.registerDevice('device-rollback', ORIGIN); // antes das execuções: o desfecho de cada uma grava um evento de push

    const bot = await world.createBot({ name: 'Bot do rollback' });
    const botRun = await world.send(bot, 'conversa que deve sobreviver ao rollback');
    await world.waitForStatus(botRun, 'completed');
    await push.setMute(bot.id, 'run_failed', true, ORIGIN);

    const routine = await world.routines.create(
      { name: 'Rotina do rollback', botId: bot.id, instruction: 'Resuma', schedule: { type: 'daily', times: ['07:00'] }, timezone: 'America/Sao_Paulo', startsAt: null, endsAt: null, maxRuns: null },
      ORIGIN,
    );
    const routineRun = await world.routines.runNow(routine.id, ORIGIN);
    await world.waitForStatus(routineRun.id, 'completed');

    await world.conversations.setSessionDefault('opencode/glm-5.1', null, ORIGIN); // o modelo padrão do chat (0014) também precisa sair sem deixar rastro
    const settings = new SettingsService({ pool: world.pool });
    await settings.update({ language: 'en', timeZone: 'America/New_York', ownerName: '' }, ORIGIN); // idioma e fuso (0015) idem
    await world.credentials.save('web_search', 'valid-parallel-rollback-9999', ORIGIN); // a chave da Parallel e o interruptor desligado (0017)
    await settings.setWebSearchEnabled(false, ORIGIN);
    const chat = new GeneralChatService({ pool: world.pool });
    const session = await chat.create();
    await world.conversations.setPreference({ sessionId: session.id }, 'opencode/glm-5.1', null);
    // A sessão tem uma aprovação de ação do conector pendente, como a phase 12 a deixava no banco (nada mais a cria na phase 13, então a prova a semeia); o rollback da 0012 também a apaga, sem violar chave estrangeira.
    await seedLegacyChatApproval({ pool: world.pool, approvals: world.approvals, sessionId: session.id });
    await world.conversations.stop({ sessionId: session.id }).catch(() => undefined);
    await world.engine.stop();

    const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await world.pool.query<{ total: string }>(sql, params)).rows[0]?.total);
    expect(await count('SELECT count(*) AS total FROM push_events')).toBeGreaterThan(0);
    expect(await count('SELECT count(*) AS total FROM routine_occurrences')).toBeGreaterThan(0);
    expect(await count('SELECT count(*) AS total FROM approvals WHERE bot_id IS NULL')).toBeGreaterThan(0);

    expect(await historySearchMode(world.pool)).toBe('tolerant'); // o banco do teste tem a extensão unaccent e a 0016 aplicada

    // Os planos, do mais novo ao mais antigo, como o dono os executaria. Erro de chave estrangeira aparece aqui como exceção.
    const planned = MIGRATIONS.filter((migration) => ROLLED_BACK_IDS.includes(migration.id));
    expect(planned.map((migration) => migration.id)).toEqual(ROLLED_BACK_IDS);
    const rollBack = async (migration: Migration): Promise<void> => {
      await world.pool.query(migration.rollback);
      await world.pool.query('DELETE FROM schema_migrations WHERE id = $1', [migration.id]);
    };
    const [dropMascot, vision, attachments, personagem, web, newest, ...older] = [...planned].reverse();
    // A 0028 (a mais nova de todas) removeu a coluna do personagem: o rollback a recria com o valor calculado do id, como a 0018 faria, sem tocar no bot,
    // na conversa nem nas mensagens, e roda de novo sem erro (idempotente).
    expect(await count("SELECT count(*) AS total FROM information_schema.columns WHERE table_name = 'bots' AND column_name = 'mascot'")).toBe(0);
    const botOnDrop = (await world.pool.query<{ name: string; color: string; instructions: string; step_limit: number }>('SELECT name, color, instructions, step_limit FROM bots WHERE id = $1', [bot.id])).rows;
    const messagesOnDrop = await count('SELECT count(*) AS total FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.bot_id = $1', [bot.id]);
    await rollBack(dropMascot!);
    await world.pool.query(dropMascot!.rollback);
    expect((await world.pool.query<{ mascot: string }>('SELECT mascot FROM bots WHERE id = $1', [bot.id])).rows[0]?.mascot).toBe(LEGACY_MASCOTS[parseInt(bot.id.slice(0, 7), 16) % LEGACY_MASCOTS.length]);
    expect((await world.pool.query('SELECT name, color, instructions, step_limit FROM bots WHERE id = $1', [bot.id])).rows).toEqual(botOnDrop);
    expect(await count('SELECT count(*) AS total FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.bot_id = $1', [bot.id])).toBe(messagesOnDrop);

    // Perfil preenchido torna observável que apenas o cache de visão se perde no rollback.
    await world.pool.query("INSERT INTO model_profiles (model_id, favorited_at, test_status, test_protocol, effort_levels, tested_at, created_at, updated_at, accepts_images) VALUES ('rollback-vision', now(), 'ok', 'messages', ARRAY['high'], now(), now(), now(), true)");
    expect((await world.pool.query('SELECT accepts_images FROM model_profiles WHERE model_id = $1', ['rollback-vision'])).rows[0]?.accepts_images).toBe(true);
    const profileColumns = 'model_id, favorited_at, test_status, test_reason, test_protocol, effort_levels, tested_at, created_at, updated_at';
    const profileBefore = (await world.pool.query(`SELECT ${profileColumns} FROM model_profiles WHERE model_id = $1`, ['rollback-vision'])).rows;
    const profilesBefore = await count('SELECT count(*) AS total FROM model_profiles');
    await rollBack(vision!);
    await world.pool.query(vision!.rollback);
    expect(await count("SELECT count(*) AS total FROM information_schema.columns WHERE table_name = 'model_profiles' AND column_name = 'accepts_images'")).toBe(0);
    expect(await count('SELECT count(*) AS total FROM model_profiles')).toBe(profilesBefore);
    expect((await world.pool.query(`SELECT ${profileColumns} FROM model_profiles WHERE model_id = $1`, ['rollback-vision'])).rows).toEqual(profileBefore);
    // Reverte a tabela nova com dados sem tocar nas mensagens e nos donos.
    await world.pool.query("INSERT INTO attachments (conversation_id, run_id, kind, name, original_bytes, stored_bytes, extracted_text) SELECT conversation_id, id, 'document', 'rollback.txt', 5, 5, 'texto' FROM runs LIMIT 1");
    expect(await count('SELECT count(*) AS total FROM attachments')).toBe(1);
    const rowsBeforeAttachments = await count('SELECT count(*) AS total FROM messages');
    await rollBack(attachments!);
    await world.pool.query(attachments!.rollback);
    expect(await count("SELECT count(*) AS total FROM information_schema.tables WHERE table_name = 'attachments'")).toBe(0);
    expect(await count('SELECT count(*) AS total FROM messages')).toBe(rowsBeforeAttachments);

    // A 0018 remove SÓ a coluna do personagem (recriada pelo rollback da 0028 acima): o bot (nome, cor, instruções), a conversa e as mensagens seguem como
    // estavam, e o plano roda de novo sem erro (idempotente). O personagem se perde, como o rollback documenta.
    expect((await world.pool.query<{ mascot: string }>('SELECT mascot FROM bots WHERE id = $1', [bot.id])).rows[0]?.mascot).toBeTruthy();
    const botBefore = (await world.pool.query<{ name: string; color: string; instructions: string; step_limit: number }>('SELECT name, color, instructions, step_limit FROM bots WHERE id = $1', [bot.id])).rows;
    const botMessages = await count('SELECT count(*) AS total FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.bot_id = $1', [bot.id]);
    await rollBack(personagem!);
    await world.pool.query(personagem!.rollback);
    expect(await count("SELECT count(*) AS total FROM information_schema.columns WHERE table_name = 'bots' AND column_name = 'mascot'")).toBe(0);
    expect((await world.pool.query('SELECT name, color, instructions, step_limit FROM bots WHERE id = $1', [bot.id])).rows).toEqual(botBefore);
    expect(await count('SELECT count(*) AS total FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.bot_id = $1', [bot.id])).toBe(botMessages);

    // A 0017 (a mais nova) remove SÓ a chave da Parallel e a coluna do interruptor: provedor, Composio, idioma e fuso e todos os dados do bot seguem
    // como estavam, a restrição de `credentials.kind` volta a recusar o tipo novo, e o plano roda de novo sem erro.
    const credentialsBefore = (await world.pool.query<{ kind: string; masked: string }>("SELECT kind, masked FROM credentials WHERE kind <> 'web_search' ORDER BY kind")).rows;
    expect(credentialsBefore.map((row) => row.kind)).toEqual(['connector', 'provider']);
    expect(await count("SELECT count(*) AS total FROM credentials WHERE kind = 'web_search'")).toBe(1);
    const botMessagesBefore = await count('SELECT count(*) AS total FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.bot_id = $1', [bot.id]);
    await rollBack(web!);
    await world.pool.query(web!.rollback);
    expect(await count("SELECT count(*) AS total FROM credentials WHERE kind = 'web_search'")).toBe(0);
    expect((await world.pool.query<{ kind: string; masked: string }>('SELECT kind, masked FROM credentials ORDER BY kind')).rows).toEqual(credentialsBefore);
    expect(await count("SELECT count(*) AS total FROM information_schema.columns WHERE table_name = 'app_settings' AND column_name = 'web_search_enabled'")).toBe(0);
    expect(await readAppSettings(world.pool)).toEqual({ language: 'en', timeZone: 'America/New_York' });
    expect(await count('SELECT count(*) AS total FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.bot_id = $1', [bot.id])).toBe(botMessagesBefore);
    await expect(world.pool.query("INSERT INTO credentials (kind, secret_sealed, masked, created_at, updated_at) VALUES ('web_search', 'x', '••', now(), now())")).rejects.toThrow(/credentials_kind_check/);

    // A 0016 só troca os índices da busca: nenhuma mensagem some, a busca volta à configuração anterior e o plano roda de novo sem erro. O banco do teste tem a
    // 0042 aplicada (índice dos resultados de ferramenta sobre `portuguese_unaccent`): sem a troca do índice pelo rollback da 0016, a remoção da configuração falharia.
    const resultIndexDef = async () => (await world.pool.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE indexname = 'messages_result_search'")).rows[0]?.indexdef;
    expect(await resultIndexDef()).toContain("'portuguese_unaccent'::regconfig");
    const messagesBefore = await count('SELECT count(*) AS total FROM messages');
    await rollBack(newest!);
    await world.pool.query(newest!.rollback);
    expect(await count('SELECT count(*) AS total FROM messages')).toBe(messagesBefore);
    expect(await historySearchMode(world.pool)).toBe('fallback');
    const searchIndex = await world.pool.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE indexname = 'messages_search'");
    expect(searchIndex.rows).toHaveLength(1);
    expect(searchIndex.rows[0]?.indexdef).toContain("to_tsvector('portuguese'::regconfig, content)");
    // O índice dos resultados segue existindo, agora na configuração de recuo, com o mesmo corte e predicado.
    const fallbackResultIndex = await resultIndexDef();
    expect(fallbackResultIndex).toContain("to_tsvector('portuguese'::regconfig");
    expect(fallbackResultIndex).not.toContain('portuguese_unaccent');
    expect(fallbackResultIndex).toContain('100000');
    expect(fallbackResultIndex).toContain("kind = 'activity'::text");

    // A 0055 (ids `opencode/...`, CHECKs de 209, `hidden_at` e a chave anthropic, que tocam `bots`, `general_chat_settings`, `model_profiles` e `credentials`) é a mais nova: sai primeiro.
    await rollBack(MIGRATIONS.find((migration) => migration.id === '0055_provider_model_ids')!);
    // A 0054 (os interruptores "Mostrar conteúdo", colunas de `app_settings`) e a 0053 (as entregas e os registros do aparelho do push, que dependem de `push_events`) saem antes
    // das antigas, a mais nova primeiro.
    await rollBack(MIGRATIONS.find((migration) => migration.id === '0054_push_content')!);
    await rollBack(MIGRATIONS.find((migration) => migration.id === '0053_push_delivery')!);
    for (const migration of older) await rollBack(migration);

    // A conversa do bot sobrevive inteira; o que era do chat geral, das rotinas, do push, do silenciar e do modelo padrão do chat não existe mais.
    expect(await count('SELECT count(*) AS total FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.bot_id = $1', [bot.id])).toBeGreaterThan(0);
    expect(await count('SELECT count(*) AS total FROM conversations WHERE bot_id IS NULL')).toBe(0);
    const tables = (await world.pool.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows.map((row) => row.tablename);
    for (const gone of ['routines', 'routine_occurrences', 'push_devices', 'push_events', 'push_mutes', 'general_chat_settings', 'app_settings']) expect(tables, gone).not.toContain(gone);
  });
});

// A 0024 (phase 4, T2; C2) com um complemento pendente de uma execução ativa e um rascunho devolvido, os dois com anexo: o rollback perde só os
// complementos e o vínculo dos anexos (que ficam como pendentes soltos), apaga os eventos `draft` antes de o CHECK antigo voltar, preserva
// mensagens, execuções e anexos, é idempotente e o `up` roda de novo.
describe('rollback da 0024 com complemento pendente e rascunho devolvido', () => {
  it('perde só os complementos e o vínculo dos anexos, sem violar chaves nem o CHECK dos eventos, e o up roda de novo', async () => {
    const data = await createHistoricalDatabase('0024_complements');
    try {
      const bot = await seedHistoricalConversation(data.pool, 'pendente');
      const run = await seedHistoricalRound(data.pool, bot, 'segura a execução', 'running');
      const pending = (await data.pool.query<{ id: string }>(
        "INSERT INTO complements (conversation_id, run_id, state, content, created_at) VALUES ($1, $2, 'pending', 'complemento pendente', now()) RETURNING id::text", [bot.id, run.runId],
      )).rows[0]!;
      const pendingFile = await seedHistoricalAttachment(data.pool, bot.id, 'pendente.txt', 'anexo do complemento', { complementId: pending.id });
      const other = await seedHistoricalConversation(data.pool, 'rascunho');
      await seedHistoricalRound(data.pool, other, 'outra', 'interrupted');
      const returned = (await data.pool.query<{ id: string }>(
        "INSERT INTO complements (conversation_id, state, content, created_at, returned_at) VALUES ($1, 'returned', 'vai voltar', now(), now()) RETURNING id::text", [other.id],
      )).rows[0]!;
      const draftFile = await seedHistoricalAttachment(data.pool, other.id, 'rascunho.txt', 'anexo do rascunho', { complementId: returned.id });
      await data.pool.query("INSERT INTO conversation_events (conversation_id, kind, ref, created_at) VALUES ($1, 'draft', $2, now())", [other.id, returned.id]);
      expect((await data.pool.query('SELECT content FROM complements WHERE id = $1', [returned.id])).rows[0]).toEqual({ content: 'vai voltar' });

      const count = async (sql: string): Promise<number> => Number((await data.pool.query<{ total: string }>(sql)).rows[0]?.total);
      expect(await count("SELECT count(*) AS total FROM complements WHERE state = 'pending'")).toBe(1);
      expect(await count("SELECT count(*) AS total FROM complements WHERE state = 'returned'")).toBe(1);
      expect(await count("SELECT count(*) AS total FROM conversation_events WHERE kind = 'draft'")).toBeGreaterThan(0);
      const before = [await count('SELECT count(*) AS total FROM messages'), await count('SELECT count(*) AS total FROM runs'), await count('SELECT count(*) AS total FROM attachments')];

      const migration = MIGRATIONS.find((candidate) => candidate.id === '0024_complements')!;
      expect(migration.destructive).toBeFalsy();
      await data.pool.query(migration.rollback);
      expect(await count("SELECT count(*) AS total FROM information_schema.tables WHERE table_name = 'complements'")).toBe(0);
      expect(await count("SELECT count(*) AS total FROM information_schema.columns WHERE table_name = 'attachments' AND column_name = 'complement_id'")).toBe(0);
      expect([await count('SELECT count(*) AS total FROM messages'), await count('SELECT count(*) AS total FROM runs'), await count('SELECT count(*) AS total FROM attachments')]).toEqual(before);
      // Os dois anexos ficam como pendentes soltos da conversa (vencem pelo job de 24 horas).
      const loose = await data.pool.query('SELECT 1 FROM attachments WHERE id = ANY($1::bigint[]) AND run_id IS NULL AND message_id IS NULL', [[pendingFile.id, draftFile.id]]);
      expect(loose.rowCount).toBe(2);
      await expect(data.pool.query("INSERT INTO conversation_events (conversation_id, kind, ref, created_at) SELECT id, 'draft', 1, now() FROM conversations LIMIT 1")).rejects.toThrow(/conversation_events_kind_check/);

      await data.pool.query(migration.rollback); // idempotente
      await data.pool.query(migration.up);
      expect(await count('SELECT count(*) AS total FROM complements')).toBe(0);
    } finally {
      await data.cleanup();
    }
  });
});

// A 0025 (phase 4, T3; C2) com uma sessão que tem versão de mensagem (com anexo mantido nas duas), versão de resposta, troca de versão e
// retrocesso em vigor: o rollback perde só os vínculos de versão, a ordem de escolha, o corte e os vínculos extras de anexo; todas as mensagens,
// execuções e anexos ficam. Uma repetição gravada como o código anterior gravava (retry antigo) e uma mensagem nova entram com o schema antigo, e o
// `up` refaz o caminho linear por id com a repetição mais recente ativa (Suposição 11).
describe('rollback da 0025 com versões e retry antigo', () => {
  it('perde só os vínculos de versão, preserva todas as linhas e o up refaz o caminho linear com a repetição mais recente ativa', async () => {
    const data = await createHistoricalDatabase('0025_conversation_versions');
    try {
      const session = await seedHistoricalConversation(data.pool);
      const first = await seedHistoricalRound(data.pool, session, 'primeira');
      const second = await seedHistoricalRound(data.pool, session, 'segunda');
      const edited = await seedHistoricalRound(data.pool, session, 'segunda editada');
      const { runId: r1, messageId: m1 } = first;
      const { runId: r2, messageId: m2 } = second;
      const { runId: r2e, messageId: m2e } = edited;
      await data.pool.query('UPDATE messages SET parent_run_id = $1 WHERE id = ANY($2::bigint[])', [r1, [m2, m2e]]);
      const file = await seedHistoricalAttachment(data.pool, session.id, 'versao.txt', 'anexo das duas versões', { runId: r2, messageId: m2 });
      await data.pool.query('INSERT INTO message_attachment_links (message_id, attachment_id) VALUES ($1, $2)', [m2e, file.id]);
      const r1b = (await data.pool.query<{ id: string }>(
        "INSERT INTO runs (conversation_id, status, input, trigger_message_id, created_at) VALUES ($1, 'completed', 'primeira', $2, now()) RETURNING id::text", [session.id, m1],
      )).rows[0]!.id;
      await data.pool.query("INSERT INTO messages (conversation_id, run_id, role, kind, status, step, content, created_at) VALUES ($1, $2, 'assistant', 'text', 'done', 1, 'Outra resposta histórica', now())", [session.id, r1b]);
      // Escolha explícita da primeira resposta e corte antes da segunda: há ramos preservados, não só colunas preenchidas.
      await data.pool.query("UPDATE runs SET version_seq = nextval('conversation_version_seq') WHERE id = $1", [r1]);
      await data.pool.query('UPDATE conversations SET rewound_run_id = $2, rewound_message_id = $3 WHERE id = $1', [session.id, r1, m2e]);
      await data.pool.query("INSERT INTO conversation_events (conversation_id, kind, ref, created_at) VALUES ($1, 'path', $2, now())", [session.id, r1]);
      expect((await readActivePath(data.pool, session.id)).rewound).toEqual({ runId: r1, rounds: 1 });

      const count = async (sql: string): Promise<number> => Number((await data.pool.query<{ total: string }>(sql)).rows[0]?.total);
      expect(await count('SELECT count(*) AS total FROM message_attachment_links')).toBe(1);
      expect(await count("SELECT count(*) AS total FROM conversation_events WHERE kind = 'path'")).toBeGreaterThan(0);
      expect(await count('SELECT count(*) AS total FROM conversations WHERE rewound_run_id IS NOT NULL')).toBe(1);
      const totals = async () => [await count('SELECT count(*) AS total FROM messages'), await count('SELECT count(*) AS total FROM runs'), await count('SELECT count(*) AS total FROM attachments')];
      const before = await totals();

      const migration = MIGRATIONS.find((candidate) => candidate.id === '0025_conversation_versions')!;
      expect(migration.destructive).toBeFalsy();
      await data.pool.query(migration.rollback);
      const column = (table: string, name: string) => count(`SELECT count(*) AS total FROM information_schema.columns WHERE table_name = '${table}' AND column_name = '${name}'`);
      expect([await column('messages', 'parent_run_id'), await column('messages', 'version_seq'), await column('runs', 'version_seq'), await column('conversations', 'rewound_run_id'), await column('conversations', 'rewound_message_id')]).toEqual([0, 0, 0, 0, 0]);
      expect(await count("SELECT count(*) AS total FROM information_schema.tables WHERE table_name = 'message_attachment_links'")).toBe(0);
      expect(await count("SELECT count(*) AS total FROM pg_class WHERE relname = 'conversation_version_seq'")).toBe(0);
      expect(await totals()).toEqual(before);
      // O anexo segue ligado ao dono original (a primeira versão); os eventos `path` saíram antes de o CHECK antigo voltar.
      expect((await data.pool.query<{ message_id: string }>('SELECT message_id::text AS message_id FROM attachments WHERE id = $1', [file.id])).rows[0]?.message_id).toBe(m2);
      await expect(data.pool.query("INSERT INTO conversation_events (conversation_id, kind, ref, created_at) VALUES ($1, 'path', 0, now())", [session.id])).rejects.toThrow(/conversation_events_kind_check/);

      // Com o schema antigo: o "Tentar novamente" de antes (execução nova sobre a mesma mensagem) e uma mensagem nova, como o código anterior gravava.
      const oldRetry = (await data.pool.query<{ id: string }>(
        "INSERT INTO runs (conversation_id, status, input, trigger_message_id, created_at) VALUES ($1, 'completed', 'segunda editada', $2, now()) RETURNING id::text AS id",
        [session.id, m2e],
      )).rows[0]!.id;
      const r4 = (await data.pool.query<{ id: string }>("INSERT INTO runs (conversation_id, status, input, created_at) VALUES ($1, 'completed', 'quarta', now()) RETURNING id::text AS id", [session.id])).rows[0]!.id;
      const m4 = (await data.pool.query<{ id: string }>(
        "INSERT INTO messages (conversation_id, run_id, role, kind, status, opens_round, content, created_at) VALUES ($1, $2, 'user', 'text', 'done', true, 'quarta', now()) RETURNING id::text AS id",
        [session.id, r4],
      )).rows[0]!.id;
      await data.pool.query('UPDATE runs SET trigger_message_id = $2 WHERE id = $1', [r4, m4]);

      await data.pool.query(migration.rollback); // idempotente
      await data.pool.query(migration.up);
      // Backfill: as aberturas em ordem de id, cada uma pendendo da execução mais recente da anterior; a repetição mais recente fica ativa.
      const path = await readActivePath(data.pool, session.id);
      expect(path.rewound).toBeNull();
      expect(path.rounds.map((round) => [round.messageId, round.runId])).toEqual([
        [m1, r1b],
        [m2, r2],
        [m2e, oldRetry],
        [m4, r4],
      ]);
      expect(path.rounds.map((round) => round.runVersions)).toEqual([[r1, r1b], [r2], [r2e, oldRetry], [r4]]);
      // A sequência começa acima dos ids preenchidos: uma escolha nova vence as linhas antigas.
      await data.pool.query("UPDATE runs SET version_seq = nextval('conversation_version_seq') WHERE id = $1", [r2e]);
      expect((await readActivePath(data.pool, session.id)).rounds[2]?.runId).toBe(r2e);
    } finally {
      await data.cleanup();
    }
  });
});

// A 0026 (phase 4, T5; ATT-01) com uma planilha enviada e relida e um documento comum: o rollback transforma a planilha em documento removido
// (original zerado, referência na mensagem mantida), ajusta o tipo da releitura gravada, preserva todas as linhas e o documento, devolve os
// CHECKs antigos, é idempotente e o `up` roda de novo.
describe('rollback da 0026 com planilha enviada e relida', () => {
  it('a planilha vira documento removido sem apagar linhas, os CHECKs antigos voltam e o up roda de novo', async () => {
    const data = await createRunsWorld();
    try {
      const files = new AttachmentService({ pool: data.pool, conversations: data.conversations });
      data.engine.start();
      const bot = await data.createBot();
      const sheet = await files.upload(bot.id, 'vendas.xlsx', xlsxFixture());
      const note = await files.upload(bot.id, 'nota.txt', Buffer.from('texto comum'));
      const run = (await data.conversations.send(bot.id, 'Analise', [sheet.id, note.id])).id;
      await data.waitForStatus(run, 'completed');
      const reread = await data.send(bot, `[anexo-ler:${sheet.id}|0]`);
      await data.waitForStatus(reread, 'completed');
      await data.engine.stop();

      const count = async (sql: string): Promise<number> => Number((await data.pool.query<{ total: string }>(sql)).rows[0]?.total);
      const totals = async () => [await count('SELECT count(*) AS total FROM messages'), await count('SELECT count(*) AS total FROM runs'), await count('SELECT count(*) AS total FROM attachments')];
      const before = await totals();
      expect(await count("SELECT count(*) AS total FROM messages WHERE data->'detail'->>'kind' = 'spreadsheet'")).toBe(1);

      const migration = MIGRATIONS.find((candidate) => candidate.id === '0026_spreadsheet_attachments')!;
      expect(migration.destructive).toBeFalsy();
      await data.pool.query(migration.rollback);
      expect(await count("SELECT count(*) AS total FROM information_schema.columns WHERE table_name = 'attachments' AND column_name = 'file_bytes'")).toBe(0);
      expect(await totals()).toEqual(before);
      const rows = await data.pool.query<{ id: string; kind: string; stored_bytes: number; removed: boolean; message_id: string | null; extracted_text: string | null }>(
        'SELECT id::text, kind, stored_bytes, removed_at IS NOT NULL AS removed, message_id::text, extracted_text FROM attachments WHERE id = ANY($1::bigint[]) ORDER BY id', [[sheet.id, note.id]],
      );
      expect(rows.rows.map(({ message_id: _message, ...row }) => row)).toEqual([
        { id: sheet.id, kind: 'document', stored_bytes: 0, removed: true, extracted_text: null },
        { id: note.id, kind: 'document', stored_bytes: Buffer.byteLength('texto comum'), removed: false, extracted_text: 'texto comum' },
      ]);
      expect(rows.rows.every((row) => row.message_id !== null)).toBe(true);
      expect(await count("SELECT count(*) AS total FROM messages WHERE data->'detail'->>'kind' = 'spreadsheet'")).toBe(0);
      await expect(data.pool.query("INSERT INTO attachments (conversation_id, kind, name, original_bytes, stored_bytes, removed_at) SELECT conversation_id, 'spreadsheet', 'x.xlsx', 1, 0, now() FROM attachments LIMIT 1")).rejects.toThrow(/attachments_kind_check/);

      await data.pool.query(migration.rollback); // idempotente
      await data.pool.query(migration.up);
      const again = await files.upload(bot.id, 'de-novo.xlsx', xlsxFixture());
      expect((await files.content(bot.id, again.id)).kind).toBe('spreadsheet');
    } finally {
      await data.cleanup();
    }
  });
});

// A 0027 (phase 4, T7; C2) com uma execução de `run_python` que gerou um PNG e um CSV (pelo sandbox falso) e uma planilha comum: o rollback transforma
// os arquivos gerados em documentos removidos (bytes zerados, vínculos com a atividade e a execução mantidos), apaga só o detalhe `python` da atividade
// (o resultado textual fica), preserva todas as linhas e a planilha, devolve os CHECKs da 0026, é idempotente e o `up` roda de novo.
describe('rollback da 0027 com arquivos gerados pelo Python', () => {
  it('os gerados viram documentos removidos e o detalhe python sai, sem apagar linhas; o up roda de novo', async () => {
    const sandbox = await startFakeSandbox();
    sandbox.handler = () => ({ output: 'ok', files: [{ name: 'grafico.png', data: pngFixture(2, 2) }, { name: 'tabela.csv', data: Buffer.from('a\n1\n') }] });
    const data = await createRunsWorld({ python: { url: sandbox.url, token: sandbox.token } });
    try {
      const files = new AttachmentService({ pool: data.pool, conversations: data.conversations });
      data.engine.start();
      const bot = await data.createBot();
      const sheet = await files.upload(bot.id, 'vendas.xlsx', xlsxFixture());
      const first = (await data.conversations.send(bot.id, 'Planilha', [sheet.id])).id;
      await data.waitForStatus(first, 'completed');
      const run = await data.send(bot, pythonMarker({ code: 'gerar()', attachments: [sheet.id] }));
      await data.waitForStatus(run, 'completed');
      await data.engine.stop();

      const count = async (sql: string): Promise<number> => Number((await data.pool.query<{ total: string }>(sql)).rows[0]?.total);
      const totals = async () => [await count('SELECT count(*) AS total FROM messages'), await count('SELECT count(*) AS total FROM runs'), await count('SELECT count(*) AS total FROM attachments')];
      const before = await totals();
      expect(await count("SELECT count(*) AS total FROM attachments WHERE kind = 'generated'")).toBe(2);
      expect(await count("SELECT count(*) AS total FROM messages WHERE data->'detail'->>'type' = 'python'")).toBe(1);

      const migration = MIGRATIONS.find((candidate) => candidate.id === '0027_generated_attachments')!;
      expect(migration.destructive).toBeFalsy();
      await data.pool.query(migration.rollback);
      expect(await count("SELECT count(*) AS total FROM information_schema.columns WHERE table_name = 'attachments' AND column_name = 'format'")).toBe(0);
      expect(await totals()).toEqual(before);
      const rows = await data.pool.query<{ kind: string; stored_bytes: number; removed: boolean; run_id: string | null; message_id: string | null; file_bytes: Buffer | null }>(
        'SELECT kind, stored_bytes, removed_at IS NOT NULL AS removed, run_id::text, message_id::text, file_bytes FROM attachments WHERE run_id = $1 AND id <> $2 ORDER BY id', [run, sheet.id],
      );
      expect(rows.rows.map(({ kind, stored_bytes: bytes, removed, file_bytes: content }) => ({ kind, bytes, removed, content }))).toEqual([
        { kind: 'document', bytes: 0, removed: true, content: null },
        { kind: 'document', bytes: 0, removed: true, content: null },
      ]);
      expect(rows.rows.every((row) => row.message_id !== null)).toBe(true);
      const activity = await data.pool.query<{ detail: unknown; content: string }>("SELECT data->'detail' AS detail, content FROM messages WHERE run_id = $1 AND kind = 'activity'", [run]);
      expect(activity.rows[0]).toMatchObject({ detail: null });
      expect(activity.rows[0]!.content).toContain('Desfecho: ok.');
      // A planilha comum fica intacta (lida por SQL: o código novo já pede a coluna `format`, que o rollback tirou).
      expect((await data.pool.query('SELECT kind, file_bytes IS NOT NULL AS kept FROM attachments WHERE id = $1', [sheet.id])).rows[0]).toEqual({ kind: 'spreadsheet', kept: true });
      await expect(data.pool.query("INSERT INTO attachments (conversation_id, kind, name, original_bytes, stored_bytes, removed_at) SELECT conversation_id, 'generated', 'x.png', 1, 0, now() FROM attachments LIMIT 1")).rejects.toThrow(/attachments_kind_check/);

      await data.pool.query(migration.rollback); // idempotente
      await data.pool.query(migration.up);
      // O primeiro motor foi parado (não reinicia): outro motor sobre o mesmo mundo, como um worker novo depois do deploy.
      const engine = data.createEngine();
      engine.start();
      const again = await data.send(bot, pythonMarker({ code: 'de_novo()' }));
      await data.waitForStatus(again, 'completed');
      await engine.stop();
      expect(await count(`SELECT count(*) AS total FROM attachments WHERE kind = 'generated' AND run_id = ${Number(again)}`)).toBe(2);
    } finally {
      await data.cleanup();
      await sandbox.stop();
    }
  });
});

// A 0029 (phase 5, T4) com o nome do dono, idioma, fuso e o interruptor da pesquisa na web já gravados: o rollback remove SÓ a coluna do nome (o nome se
// perde), preserva idioma, fuso, interruptor, bots e conversas, devolve o banco a aceitar a linha sem o nome, é idempotente e o `up` roda de novo (nome
// vazio, 40 caracteres no máximo, como na primeira vez).
describe('rollback da 0029 com o nome do dono gravado', () => {
  it('remove só a coluna do nome, preserva as demais preferências e os dados do bot, e o up roda de novo', async () => {
    const data = await createRunsWorld();
    try {
      data.engine.start();
      const bot = await data.createBot({ name: 'Bot do nome' });
      await data.waitForStatus(await data.send(bot, 'conversa que sobrevive'), 'completed');
      await data.engine.stop();
      const settings = new SettingsService({ pool: data.pool });
      await settings.update({ language: 'es', timeZone: 'Asia/Tokyo', ownerName: 'Marco' }, ORIGIN);
      await settings.setWebSearchEnabled(false, ORIGIN);
      expect(await settings.read()).toEqual({ language: 'es', timeZone: 'Asia/Tokyo', ownerName: 'Marco' });

      const count = async (sql: string): Promise<number> => Number((await data.pool.query<{ total: string }>(sql)).rows[0]?.total);
      const messages = await count('SELECT count(*) AS total FROM messages');
      const migration = MIGRATIONS.find((candidate) => candidate.id === '0029_owner_name')!;
      expect(migration.destructive).toBeFalsy(); // aditiva: roda no deploy sem o pedido do dono
      await data.pool.query(migration.rollback);
      expect(await count("SELECT count(*) AS total FROM information_schema.columns WHERE table_name = 'app_settings' AND column_name = 'owner_name'")).toBe(0);
      // O que é do contexto (e o interruptor) segue exatamente como estava, e os dados do bot não foram tocados.
      expect(await readAppSettings(data.pool)).toEqual({ language: 'es', timeZone: 'Asia/Tokyo' });
      expect(await readWebSearchEnabled(data.pool)).toBe(false);
      expect(await count('SELECT count(*) AS total FROM messages')).toBe(messages);
      expect((await data.pool.query('SELECT name FROM bots WHERE id = $1', [bot.id])).rows).toEqual([{ name: 'Bot do nome' }]);

      await data.pool.query(migration.rollback); // idempotente
      await data.pool.query(migration.up);
      expect((await settings.read()).ownerName).toBe(''); // o nome se perdeu: volta vazio
      expect(await readAppSettings(data.pool)).toEqual({ language: 'es', timeZone: 'Asia/Tokyo' });
      expect((await settings.update({ language: 'es', timeZone: 'Asia/Tokyo', ownerName: 'Marco' }, ORIGIN)).ownerName).toBe('Marco');
    } finally {
      await data.cleanup();
    }
  });
});
// A migration aditiva mantém a conversa existente e recusa retirar a coluna que recupera chamadas completas.
describe('rollback 0032 com argumentos de ferramenta persistidos', () => {
  it('preserva argumento/resultado/conversa e falha fechado em vez de voltar a usar resumo truncado', async () => {
    const data = await createRunsWorld();
    try {
      const bot = await data.createBot(); data.engine.start();
      const run = await data.send(bot, '[pesquisar] consulta do rollback');
      await data.waitForStatus(run, 'completed'); await data.engine.stop();
      const before = (await data.pool.query('SELECT id, content, data, tool_arguments FROM messages WHERE run_id=$1 ORDER BY id', [run])).rows;
      expect(before.some((row) => row.tool_arguments !== null)).toBe(true);
      const migration = MIGRATIONS.find((candidate) => candidate.id === '0032_table_operations')!;
      await expect(data.pool.query(migration.rollback)).rejects.toThrow(/Preserve preparações e argumentos/);
      expect((await data.pool.query('SELECT id, content, data, tool_arguments FROM messages WHERE run_id=$1 ORDER BY id', [run])).rows).toEqual(before);
    } finally { await data.cleanup(); }
  });
});

// A 0053 (phase 16, passo 1; A14) com eventos de todos os desfechos, entregas por dispositivo e registros do aparelho já gravados: o rollback apaga SÓ as duas
// tabelas novas, devolve as linhas de código novo ao estado anterior ANTES de restaurar o CHECK da 0022 (sem isso o CHECK antigo as recusaria e o rollback
// falharia), preserva os códigos antigos e os dados do bot, é idempotente e o `up` roda de novo.
describe('rollback da 0053 com entregas, registros do aparelho e motivos de descarte novos', () => {
  it('apaga só as tabelas novas, devolve cada código novo ao estado anterior, restaura o CHECK antigo e roda de novo (A14)', async () => {
    const data = await createRunsWorld();
    try {
      data.engine.start();
      const bot = await data.createBot({ name: 'Bot da 0053' });
      await data.waitForStatus(await data.send(bot, 'conversa que sobrevive'), 'completed');
      await data.engine.stop();
      const count = async (sql: string): Promise<number> => Number((await data.pool.query<{ total: string }>(sql)).rows[0]?.total);
      const seed = async (status: string, reason: string | null, botId: string | null = bot.id): Promise<string> =>
        (
          await data.pool.query<{ id: string }>(
            "INSERT INTO push_events (kind, bot_id, status, drop_reason, created_at, finished_at) VALUES ('run_completed', $1, $2, $3, now(), now()) RETURNING id::text AS id",
            [botId, status, reason],
          )
        ).rows[0]!.id;
      const events = {
        noDevice: await seed('dropped', 'no_device'),
        noDestination: await seed('dropped', 'no_destination', null),
        noAccount: await seed('dropped', 'no_fcm_account'),
        exhausted: await seed('dropped', 'attempts_exhausted'),
        presence: await seed('dropped', 'presence'),
        sent: await seed('sent', null),
      };
      const device = '3f0c1a52-8f7e-4d0e-9c1e-6a2b8d4e7f10';
      await data.pool.query("INSERT INTO push_deliveries (event_id, device_id, attempt, http_status, outcome, created_at) VALUES ($1, $2, 1, 404, 'rejected_token', now())", [events.sent, device]);
      await data.pool.query("INSERT INTO push_receipts (event_id, device_id, state, reason, created_at) VALUES ($1, $2, 'suppressed', 'invalid', now())", [events.sent, device]);
      const messages = await count('SELECT count(*) AS total FROM messages');
      const stateOf = async () =>
        Object.fromEntries(
          (await data.pool.query<{ id: string; status: string; drop_reason: string | null }>('SELECT id::text AS id, status, drop_reason FROM push_events WHERE id = ANY($1::bigint[])', [Object.values(events)])).rows.map((row) => [row.id, [row.status, row.drop_reason]]),
        );

      const migration = MIGRATIONS.find((candidate) => candidate.id === '0053_push_delivery')!;
      expect(migration.destructive).toBeFalsy(); // aditiva: roda no deploy sem o pedido do dono
      await data.pool.query(migration.rollback);
      expect(await count("SELECT count(*) AS total FROM pg_tables WHERE tablename IN ('push_deliveries', 'push_receipts')")).toBe(0);
      expect(await stateOf()).toEqual({
        [events.noDevice]: ['sent', null], // como o código anterior gravava
        [events.noDestination]: ['sent', null],
        [events.noAccount]: ['dropped', null],
        [events.exhausted]: ['dropped', null],
        [events.presence]: ['dropped', 'presence'], // código antigo intacto
        [events.sent]: ['sent', null],
      });
      expect(await count('SELECT count(*) AS total FROM messages')).toBe(messages);
      expect((await data.pool.query('SELECT name FROM bots WHERE id = $1', [bot.id])).rows).toEqual([{ name: 'Bot da 0053' }]);
      // O CHECK da 0022 voltou: o código novo é recusado, os seis antigos seguem aceitos.
      await expect(seed('dropped', 'no_device')).rejects.toThrow(/push_events_check/);
      await seed('dropped', 'muted');

      await data.pool.query(migration.rollback); // idempotente
      await data.pool.query(migration.up);
      await seed('dropped', 'attempts_exhausted'); // o CHECK novo aceita de novo
      expect(await count('SELECT count(*) AS total FROM push_deliveries') + (await count('SELECT count(*) AS total FROM push_receipts'))).toBe(0); // as tabelas voltam vazias
    } finally {
      await data.cleanup();
    }
  });
});

// A 0054 (phase 16, passo 4; A14) com os dois interruptores já desligados e as demais preferências preenchidas: o rollback remove SÓ as duas colunas novas de `app_settings`,
// preserva idioma, fuso, nome do dono, a pesquisa na web, os dispositivos, os eventos, as entregas e os registros do aparelho da 0053, é idempotente e o `up` roda de novo
// com os dois ligados (o padrão).
describe('rollback da 0054 com os interruptores "Mostrar conteúdo" desligados', () => {
  it('remove só as duas colunas novas, preserva o resto de app_settings e do push, e o up volta com os dois ligados (A14)', async () => {
    const data = await createRunsWorld();
    try {
      const push = new PushService({ pool: data.pool, config: { enabled: false } });
      await push.registerDevice('device-0054', ORIGIN);
      const bot = await data.createBot({ name: 'Bot da 0054' });
      const event = (await data.pool.query<{ id: string }>("INSERT INTO push_events (kind, bot_id, status, created_at, finished_at) VALUES ('run_completed', $1, 'sent', now(), now()) RETURNING id::text AS id", [bot.id])).rows[0]!.id;
      await data.pool.query("INSERT INTO push_deliveries (event_id, device_id, attempt, http_status, outcome, created_at) VALUES ($1, '3f0c1a52-8f7e-4d0e-9c1e-6a2b8d4e7f10', 1, 200, 'accepted', now())", [event]);
      await push.setContent('bots', false, ORIGIN);
      await push.setContent('general_chat', false, ORIGIN);
      await data.pool.query("UPDATE app_settings SET owner_name = 'Dono da 0054', web_search_enabled = false");
      const columns = async (): Promise<string[]> =>
        (await data.pool.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'app_settings' AND column_name LIKE 'push_content_%' ORDER BY column_name")).rows.map((row) => row.column_name);
      expect(await columns()).toEqual(['push_content_bots', 'push_content_general_chat']);
      const others = async () => (await data.pool.query('SELECT owner_name, web_search_enabled, language, time_zone FROM app_settings')).rows;
      const before = await others();
      const count = async (sql: string): Promise<number> => Number((await data.pool.query<{ total: string }>(sql)).rows[0]?.total);
      const counts = async () => [await count('SELECT count(*) AS total FROM push_devices'), await count('SELECT count(*) AS total FROM push_events'), await count('SELECT count(*) AS total FROM push_deliveries'), await count('SELECT count(*) AS total FROM bots')];
      const countsBefore = await counts();

      const migration = MIGRATIONS.find((candidate) => candidate.id === '0054_push_content')!;
      expect(migration.destructive).toBeFalsy(); // aditiva: roda no deploy sem o pedido do dono
      await data.pool.query(migration.rollback);
      expect(await columns()).toEqual([]);
      expect(await others()).toEqual(before);
      expect(await counts()).toEqual(countsBefore);
      expect(await count("SELECT count(*) AS total FROM pg_tables WHERE tablename IN ('push_deliveries', 'push_receipts')")).toBe(2); // as tabelas da 0053 ficam

      await data.pool.query(migration.rollback); // idempotente
      await data.pool.query(migration.up);
      expect(await push.contentSettings()).toEqual({ bots: true, generalChat: true });
      expect(await others()).toEqual(before);
    } finally {
      await data.cleanup();
    }
  });
});

// A 0055 (phase 17, passo 2; A12 e A13) sobre dados reais do motor: um bot com conversa concluída (execução, uso de modelo, mensagens), o Chat geral com modelo padrão, o modelo do
// resumo, uma recusa de resumo, perfis de modelo, o cartão `model_without_tools` e as duas chaves. O `up` roda de novo sobre esse banco (idempotente) para o prefixar, como o deploy faria
// com os dados de produção. Sem `anthropic/` gravado e sem a chave `anthropic` (que o dono remove antes), o rollback devolve os ids aos de antes (A12); com `anthropic/` em QUALQUER das 9 colunas, OU com a
// chave `anthropic` ainda gravada, ele recusa antes de alterar linha (A13) e o estado fica byte a byte o mesmo (a decisão do dono: o rollback recusa em vez de perder dado).
describe('rollback da 0055 com ids provedor/modelo gravados', () => {
  /** As 9 colunas do id e o SQL que lê o que está gravado em cada uma: a foto é comparada por igualdade. */
  const SNAPSHOTS = {
    bots: 'SELECT model FROM bots ORDER BY name',
    general_chat_settings: 'SELECT model FROM general_chat_settings',
    conversations: 'SELECT preferred_model FROM conversations ORDER BY id',
    app_settings: 'SELECT summary_model FROM app_settings',
    context_summary_refusals: 'SELECT model FROM context_summary_refusals ORDER BY impression',
    model_profiles: 'SELECT model_id FROM model_profiles ORDER BY model_id',
    model_call_usage: 'SELECT model FROM model_call_usage ORDER BY id',
    runs: 'SELECT last_model FROM runs ORDER BY id',
    card: "SELECT data->>'model' AS model FROM messages WHERE kind = 'card' AND data->>'type' = 'model_without_tools'",
  } as const;
  /** Um UPDATE que grava `anthropic/...` numa linha de cada alvo. */
  const WRITE_ANTHROPIC: Record<keyof typeof SNAPSHOTS, string> = {
    bots: "UPDATE bots SET model = 'anthropic/claude-haiku-5-5' WHERE name = 'Bot da 0055'",
    general_chat_settings: "UPDATE general_chat_settings SET model = 'anthropic/claude-haiku-5-5'",
    conversations: "UPDATE conversations SET preferred_model = 'anthropic/claude-haiku-5-5' WHERE id = (SELECT id FROM conversations ORDER BY id LIMIT 1)",
    app_settings: "UPDATE app_settings SET summary_model = 'anthropic/claude-haiku-5-5'",
    context_summary_refusals: "UPDATE context_summary_refusals SET model = 'anthropic/claude-haiku-5-5'",
    model_profiles: "UPDATE model_profiles SET model_id = 'anthropic/claude-haiku-5-5' WHERE model_id = 'opencode/claude-haiku-5-5'",
    model_call_usage: "UPDATE model_call_usage SET model = 'anthropic/claude-haiku-5-5' WHERE id = (SELECT id FROM model_call_usage ORDER BY id LIMIT 1)",
    runs: "UPDATE runs SET last_model = 'anthropic/claude-haiku-5-5' WHERE id = (SELECT id FROM runs ORDER BY id LIMIT 1)",
    card: "UPDATE messages SET data = jsonb_set(data, '{model}', '\"anthropic/claude-haiku-5-5\"') WHERE kind = 'card' AND data->>'type' = 'model_without_tools'",
  };

  /** Banco com dados do motor, já com os ids `opencode/...` (o `up` repetido prefixa o que o motor gravou sem prefixo, que é o estado de antes do código novo). */
  async function seeded() {
    const data = await createRunsWorld();
    const migration = MIGRATIONS.find((candidate) => candidate.id === '0055_provider_model_ids')!;
    data.engine.start();
    const bot = await data.createBot({ name: 'Bot da 0055' });
    await data.waitForStatus(await data.send(bot, 'conversa que sobrevive'), 'completed');
    await data.engine.stop();
    const conversation = (await data.pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [bot.id])).rows[0]!.id;
    const run = (await data.pool.query<{ id: string }>('SELECT id FROM runs WHERE conversation_id = $1 ORDER BY id LIMIT 1', [conversation])).rows[0]!.id;
    await data.pool.query("UPDATE bots SET model = 'deepseek-v4.1-flash' WHERE id = $1", [bot.id]);
    await data.pool.query("INSERT INTO general_chat_settings (model, updated_at) VALUES ('claude-haiku-5-5', now()) ON CONFLICT (singleton) DO UPDATE SET model = excluded.model");
    await data.pool.query("UPDATE app_settings SET summary_model = 'mimo-v2.6-pro'");
    await data.pool.query("UPDATE conversations SET preferred_model = 'deepseek-v4.1-flash' WHERE id = $1", [conversation]);
    await data.pool.query("INSERT INTO context_summary_refusals (conversation_id, impression, model, outcome, created_at) VALUES ($1, 'impressao-0055', 'deepseek-v4.1-flash', 'empty', now())", [conversation]);
    await data.pool.query("INSERT INTO model_profiles (model_id, created_at, updated_at) VALUES ('deepseek-v4.1-flash', now(), now()), ('claude-haiku-5-5', now(), now()) ON CONFLICT DO NOTHING");
    await data.pool.query("INSERT INTO messages (conversation_id, run_id, role, kind, status, content, data, created_at) VALUES ($1, $2, 'system', 'card', 'done', '', '{\"type\":\"model_without_tools\",\"model\":\"mimo-v2.6-pro\"}', now())", [conversation, run]);
    await data.pool.query("UPDATE runs SET last_model = 'deepseek-v4.1-flash' WHERE id = $1", [run]);
    await data.pool.query("INSERT INTO credentials (kind, secret_sealed, masked, created_at, updated_at) VALUES ('provider', 'v1.a.b.c', 'abcd', now(), now()) ON CONFLICT (kind) DO NOTHING");
    await data.pool.query(migration.up);
    await data.pool.query("INSERT INTO credentials (kind, secret_sealed, masked, created_at, updated_at) VALUES ('anthropic', 'v1.x.y.z', 'wxyz', now(), now())");
    const snapshot = async () => Object.fromEntries(await Promise.all(Object.entries(SNAPSHOTS).map(async ([key, sql]) => [key, (await data.pool.query(sql)).rows])));
    const other = async () => ({
      messages: Number((await data.pool.query<{ total: string }>('SELECT count(*) AS total FROM messages')).rows[0]!.total),
      credentials: (await data.pool.query('SELECT kind FROM credentials ORDER BY kind')).rows,
      bots: (await data.pool.query('SELECT name FROM bots ORDER BY name')).rows,
    });
    return { data, migration, snapshot, other };
  }

  it('A12: sem anthropic/ gravado e sem a chave anthropic, o rollback devolve os ids aos de antes, remove só as colunas novas, preserva o resto e o up roda de novo', async () => {
    const { data, migration, snapshot, other } = await seeded();
    try {
      const prefixed = await snapshot();
      for (const [key, rows] of Object.entries(prefixed)) for (const row of rows as Record<string, unknown>[]) for (const value of Object.values(row)) expect(String(value), key).toMatch(/^opencode\//);
      const preserved = await other();
      expect(preserved.credentials).toEqual([{ kind: 'anthropic' }, { kind: 'provider' }]);
      // O dono remove a chave da Anthropic antes (com ela gravada o rollback recusa, ver A13).
      await data.pool.query("DELETE FROM credentials WHERE kind = 'anthropic'");
      const withoutKey = await other();

      await data.pool.query(migration.rollback);
      await data.pool.query(migration.rollback); // idempotente
      const restored = await snapshot();
      for (const [key, rows] of Object.entries(restored)) for (const row of rows as Record<string, unknown>[]) for (const value of Object.values(row)) expect(String(value), key).not.toContain('/');
      // Os ids voltam aos exatos de antes (tabela da spec) e nada é apagado: a chave do provedor, o bot e todas as mensagens ficam.
      expect(restored.bots).toEqual([{ model: 'deepseek-v4.1-flash' }]);
      expect(restored.general_chat_settings).toEqual([{ model: 'claude-haiku-5-5' }]);
      expect(restored.app_settings).toEqual([{ summary_model: 'mimo-v2.6-pro' }]);
      expect(restored.card).toEqual([{ model: 'mimo-v2.6-pro' }]);
      expect(restored.model_profiles).toEqual([{ model_id: 'claude-haiku-5-5' }, { model_id: 'deepseek-v4.1-flash' }, { model_id: 'glm-5.1' }]); // glm-5.1 é o perfil que o motor de teste cria
      expect(await other()).toEqual(withoutKey); // a chave do provedor, o bot e todas as mensagens ficam
      expect(withoutKey.credentials).toEqual([{ kind: 'provider' }]);
      expect((await data.pool.query("SELECT column_name FROM information_schema.columns WHERE (table_name = 'model_profiles' AND column_name = 'hidden_at') OR (table_name = 'credentials' AND column_name = 'credits_exhausted_at')")).rowCount).toBe(0);
      await expect(data.pool.query("INSERT INTO credentials (kind, secret_sealed, masked, created_at, updated_at) VALUES ('anthropic', 'v1.x.y.z', 'wxyz', now(), now())")).rejects.toMatchObject({ code: '23514' });
      await expect(data.pool.query('INSERT INTO model_profiles (model_id, created_at, updated_at) VALUES ($1, now(), now())', ['m'.repeat(201)])).rejects.toMatchObject({ code: '23514' });

      await data.pool.query(migration.up); // o up roda de novo e prefixa outra vez
      expect(await snapshot()).toEqual(prefixed);
    } finally {
      await data.cleanup();
    }
  });

  it.each(Object.keys(SNAPSHOTS) as (keyof typeof SNAPSHOTS)[])('A13: com anthropic/ gravado em %s, o rollback recusa antes de alterar linha e o estado fica igual', async (target) => {
    const { data, migration, snapshot, other } = await seeded();
    try {
      // Sem a chave anthropic gravada, para provar que SÓ este id já basta para recusar.
      await data.pool.query("DELETE FROM credentials WHERE kind = 'anthropic'");
      await data.pool.query(WRITE_ANTHROPIC[target]);
      const before = await snapshot();
      expect(JSON.stringify(before[target])).toContain('anthropic/claude-haiku-5-5');
      const preserved = await other();

      await expect(data.pool.query(migration.rollback)).rejects.toThrow(/Rollback da 0055 recusado/);
      expect(await snapshot()).toEqual(before);
      expect(await other()).toEqual(preserved); // nada foi alterado
      // Os CHECKs seguem em 209: o rollback não chegou a trocá-los.
      expect((await data.pool.query<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'bots_model_check'")).rows[0]!.def).toContain('209');
    } finally {
      await data.cleanup();
    }
  });

  it('A13: com a chave anthropic gravada e nenhum id anthropic/, o rollback também recusa antes de alterar linha, preserva a chave cifrada e só roda depois de o dono a remover', async () => {
    const { data, migration, snapshot, other } = await seeded();
    try {
      const before = await snapshot();
      for (const [key, rows] of Object.entries(before)) for (const row of rows as Record<string, unknown>[]) for (const value of Object.values(row)) expect(String(value), key).not.toContain('anthropic/');
      const sealed = (await data.pool.query<{ secret_sealed: string; masked: string }>("SELECT secret_sealed, masked FROM credentials WHERE kind = 'anthropic'")).rows;
      expect(sealed).toEqual([{ secret_sealed: 'v1.x.y.z', masked: 'wxyz' }]);
      const preserved = await other();

      await expect(data.pool.query(migration.rollback)).rejects.toThrow(/Rollback da 0055 recusado.*chave da Anthropic/);
      await expect(data.pool.query(migration.rollback)).rejects.toThrow(/Rollback da 0055 recusado/); // repetir também recusa
      expect(await snapshot()).toEqual(before);
      expect(await other()).toEqual(preserved);
      expect((await data.pool.query<{ secret_sealed: string; masked: string }>("SELECT secret_sealed, masked FROM credentials WHERE kind = 'anthropic'")).rows).toEqual(sealed);
      expect((await data.pool.query<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'credentials_kind_check'")).rows[0]!.def).toContain('anthropic');

      // Removida a chave pelo dono, o rollback segue.
      await data.pool.query("DELETE FROM credentials WHERE kind = 'anthropic'");
      await data.pool.query(migration.rollback);
      expect((await data.pool.query("SELECT 1 FROM credentials WHERE kind = 'provider'")).rowCount).toBe(1);
      expect((await snapshot()).bots).toEqual([{ model: 'deepseek-v4.1-flash' }]);
    } finally {
      await data.cleanup();
    }
  });
});

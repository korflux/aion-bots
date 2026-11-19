// Prova do serviço de bots (A4, F5; A7, F6) contra PostgreSQL real e relógio controlado. Cada teste percorre uma jornada
// e confere os efeitos observáveis: respostas, tabelas (conversa 1:1, memória vazia) e auditoria.
//
// Mapa do arquivo:
//  1. criar, editar, arquivar e desarquivar (F5), e a ausência do personagem do mascote (removido na phase 5);
//  2. exclusão definitiva, recusas e travas (F6): bancos leves, sem motor de execução, com execuções semeadas por SQL;
//  3. exclusão definitiva com dados reais (F6, A7): dois bots e uma sessão do chat geral semeados pelo motor e pelos serviços de verdade,
//     com o catálogo do banco guiando o que "tudo do bot" significa (ver o apoio logo antes desse bloco).
//  4. estado ao vivo da lista de bots (F10, A12): cada linha da precedência com execuções semeadas e relógio simulado, a manutenção de contexto (fria e manual)
//     que não conta como trabalho do bot (phase 11, T11), e o motor real;
//  5. prévia da última novidade na lista (phase 5, T5): resposta final, cartão, texto em escrita, conversa vazia, corte, consulta única e fora dos logs.
import { randomUUID } from 'node:crypto';
import type { Bot, BotCreate } from '@aion/shared';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { queueContextMaintenance } from '../conversation/run-queue';
import { GeneralChatService } from '../general-chat/service';
import { migrateTestDatabase } from '../testing/migrate';
import { createPool, withTransaction, type Pool } from '../db/pool';
import { DomainError } from '../errors';
import { PushService } from '../push/service';
import { createRunsWorld, waitFor, type RunsWorld } from '../runs/test-support';
import { createTestDatabase, type TestDatabase } from '../testing/postgres';
import { firstPlainLine } from './preview';
import { BotService, nameKeyOf, type ModelSelectionValidator } from './service';

const ORIGIN = { ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (teste)' };
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

let database: TestDatabase;
let pool: Pool;
let service: BotService;
let now = new Date('2026-03-01T12:00:00Z');
const advance = (ms: number) => {
  now = new Date(now.getTime() + ms);
};

/**
 * Validador de modelo da prova: registra cada consulta (modelo, effort) e recusa o modelo `fora-da-lista`. A regra de
 * verdade (lista do provedor e níveis gravados) é provada no `ModelService`; aqui só importa QUANDO o serviço de bots consulta.
 */
const consulted: [string | null, string | null][] = [];
const models: ModelSelectionValidator = {
  async validateSelection(model, effort) {
    consulted.push([model, effort]);
    if (model === 'fora-da-lista') throw new DomainError('MODEL_UNAVAILABLE');
  },
};

/** Entrada completa de criação (o que o schema do Zod entrega ao core), com os campos que o teste quer mudar. */
const input = (name: string, overrides: Partial<BotCreate> = {}): BotCreate => ({
  name,
  color: '#60A5FA',
  instructions: '',
  model: null,
  effort: null,
  stepLimit: 25,
  ...overrides,
});

const code = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    return error instanceof DomainError ? error.code : `UNEXPECTED:${String(error)}`;
  }
};

const count = async (table: string, where = 'true', params: unknown[] = []): Promise<number> =>
  (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params)).rows[0]?.n ?? -1;

const auditRows = async () =>
  (await pool.query<{ action: string; outcome: string; actor: string; target: string | null; details: Record<string, unknown>; ip: string | null }>(
    "SELECT action, outcome, actor, target, details, ip FROM audit_log WHERE action LIKE 'bot.%' ORDER BY id",
  )).rows;

beforeAll(async () => {
  database = await createTestDatabase(inject('adminDatabaseUrl'));
  pool = createPool(database.url, { applicationName: 'bots-test', max: 6 });
  await migrateTestDatabase(pool);
  service = new BotService({ pool, models, now: () => now });
});

afterAll(async () => {
  await pool.end();
  await database.drop();
});

describe('jornada de um bot: criar, nome único, editar, arquivar e desarquivar', () => {
  it('percorre o ciclo completo com as regras de nome e os efeitos no banco e na auditoria', async () => {
    // --- criar: nasce com conversa única e memória vazia, na mesma transação ---
    const created = await service.create(input('Financeiro', { instructions: 'Controle o caixa.', stepLimit: 40 }), ORIGIN);
    expect(created).toMatchObject({
      name: 'Financeiro',
      color: '#60A5FA',
      instructions: 'Controle o caixa.',
      model: null,
      effort: null,
      stepLimit: 40,
      archivedAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    expect(await count('conversations', 'bot_id = $1', [created.id])).toBe(1);
    const memory = await pool.query<{ content: string }>('SELECT content FROM bot_memories WHERE bot_id = $1', [created.id]);
    expect(memory.rows).toEqual([{ content: '' }]);

    // --- nome único sem diferenciar maiúsculas entre bots não arquivados ---
    for (const clash of ['financeiro', 'FINANCEIRO', 'FinanCeiro']) {
      expect(await code(service.create(input(clash), ORIGIN)), clash).toBe('BOT_NAME_TAKEN');
    }
    // Acentos: a forma composta e a decomposta (NFD) são o mesmo nome, e maiúsculas acentuadas também.
    await service.create(input('Ação'), ORIGIN);
    expect(await code(service.create(input('AÇÃO'), ORIGIN))).toBe('BOT_NAME_TAKEN');
    expect(await code(service.create(input('Ação'), ORIGIN))).toBe('BOT_NAME_TAKEN');
    // Acento muda o nome (a regra só ignora maiúsculas), e uma conta com aspas é gravada literalmente.
    await service.create(input('Acao'), ORIGIN);
    const quoted = await service.create(input("Robert'); DROP TABLE bots;--"), ORIGIN);
    expect(quoted.name).toBe("Robert'); DROP TABLE bots;--");
    // Criações recusadas não deixam conversa nem memória órfãs: há uma de cada por bot.
    expect(await count('conversations')).toBe(await count('bots'));
    expect(await count('bot_memories')).toBe(await count('bots'));

    // --- editar: parcial, só o que mudou ---
    advance(60_000);
    const renamed = await service.update(created.id, { name: 'Contábil', color: '#F472B6' }, ORIGIN);
    expect(renamed).toMatchObject({ name: 'Contábil', color: '#F472B6', instructions: 'Controle o caixa.', stepLimit: 40 });
    expect(renamed.createdAt).toBe(created.createdAt);
    expect(renamed.updatedAt).toBe(now.toISOString());
    // O nome antigo ficou livre; o novo já está em uso por este bot; trocar só a caixa do próprio nome é permitido.
    const reuse = await service.create(input('financeiro'), ORIGIN);
    expect(await code(service.update(reuse.id, { name: 'CONTÁBIL' }, ORIGIN))).toBe('BOT_NAME_TAKEN');
    expect((await service.get(reuse.id)).name).toBe('financeiro'); // recusa não altera nada
    expect((await service.update(created.id, { name: 'CONTÁBIL' }, ORIGIN)).name).toBe('CONTÁBIL');

    // --- arquivar: sai da lista principal, libera o nome e preserva conversa e memória ---
    advance(60_000);
    const archived = await service.archive(created.id, ORIGIN);
    expect(archived.archivedAt).toBe(now.toISOString());
    expect(await count('conversations', 'bot_id = $1', [created.id])).toBe(1);
    expect(await count('bot_memories', 'bot_id = $1', [created.id])).toBe(1);
    const takeover = await service.create(input('contábil'), ORIGIN); // nome liberado pelo arquivamento
    const listed = await service.list();
    expect(listed.find((bot) => bot.id === created.id)?.archivedAt).toBe(now.toISOString());
    expect(listed.find((bot) => bot.id === takeover.id)?.archivedAt).toBeNull();

    // --- desarquivar com conflito: fica arquivado; renomear o arquivado destrava ---
    expect(await code(service.unarchive(created.id, ORIGIN))).toBe('BOT_NAME_TAKEN');
    expect((await service.get(created.id)).archivedAt).toBe(archived.archivedAt);
    await service.update(created.id, { name: 'Contábil antigo' }, ORIGIN); // arquivado não disputa o nome
    expect((await service.unarchive(created.id, ORIGIN)).archivedAt).toBeNull();

    // --- auditoria: quem, o quê e onde, sem o conteúdo das instruções ---
    const audit = await auditRows();
    const ofBot = audit.filter((row) => row.target === created.id);
    expect(ofBot.map((row) => row.action)).toEqual([
      'bot.create',
      'bot.update',
      'bot.update',
      'bot.archive',
      'bot.update',
      'bot.unarchive',
    ]);
    expect(ofBot[1]?.details).toEqual({ fields: 'name,color' });
    for (const row of audit) {
      expect(row).toMatchObject({ outcome: 'success', actor: 'owner', ip: ORIGIN.ip });
    }
    expect(JSON.stringify(audit)).not.toContain('Controle o caixa');
    // Criações e edições recusadas não geram auditoria de sucesso.
    expect(audit.filter((row) => row.action === 'bot.create')).toHaveLength(await count('bots'));
  });

  it('sem personagem (phase 5): o bot criado, lido, listado e editado não traz `mascot` e a coluna não existe mais no banco', async () => {
    const created = await service.create(input('Sem personagem'), ORIGIN);
    expect(Object.keys(created)).not.toContain('mascot');
    expect(Object.keys(await service.get(created.id))).not.toContain('mascot');
    expect(Object.keys((await service.list()).find((bot) => bot.id === created.id) ?? {})).not.toContain('mascot');
    expect(Object.keys(await service.update(created.id, { instructions: 'Outra.' }, ORIGIN))).not.toContain('mascot');
    // Segunda barreira, do banco: a migration 0028 removeu a coluna, então nada consegue gravá-la nem lê-la.
    const columns = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'bots' AND column_name = 'mascot'");
    expect(columns.rowCount).toBe(0);
  });

  it('lista em ordem alfabética sem diferenciar maiúsculas, com ativos e arquivados juntos', async () => {
    const db = await createTestDatabase(inject('adminDatabaseUrl'));
    const isolated = createPool(db.url, { applicationName: 'bots-test-list', max: 2 });
    try {
      await migrateTestDatabase(isolated);
      const svc = new BotService({ pool: isolated, models, now: () => now });
      const [charlie, , bravo] = [
        await svc.create(input('charlie', { color: '#F87171' }), ORIGIN),
        await svc.create(input('Alfa'), ORIGIN),
        await svc.create(input('bravo'), ORIGIN),
      ];
      await svc.archive(bravo.id, ORIGIN);
      const list = await svc.list();
      expect(list.map((bot) => bot.name)).toEqual(['Alfa', 'bravo', 'charlie']);
      expect(list.find((bot) => bot.id === charlie.id)).toEqual({
        id: charlie.id,
        name: 'charlie',
        color: '#F87171',
        archivedAt: null,
        runState: 'idle',
        unread: false,
        preview: 'Nenhuma mensagem ainda',
      });
      // O resumo da lista nunca carrega as instruções; leva o estado ao vivo e a prévia para o avatar e o texto não dependerem de outra consulta.
      expect(Object.keys(list[0] ?? {}).sort()).toEqual(['archivedAt', 'color', 'id', 'name', 'preview', 'runState', 'unread']);
      // Arquivado dorme: o estado de cada item vem na mesma leitura.
      expect(list.find((bot) => bot.id === bravo.id)?.runState).toBe('sleep');
    } finally {
      await isolated.end();
      await db.drop();
    }
  });
});

describe('bordas do serviço', () => {
  it('id inexistente é BOT_NOT_FOUND em toda operação por id, sem efeitos colaterais', async () => {
    const auditBefore = (await auditRows()).length;
    expect(await code(service.get(UNKNOWN_ID))).toBe('BOT_NOT_FOUND');
    expect(await code(service.update(UNKNOWN_ID, { name: 'Fantasma' }, ORIGIN))).toBe('BOT_NOT_FOUND');
    expect(await code(service.archive(UNKNOWN_ID, ORIGIN))).toBe('BOT_NOT_FOUND');
    expect(await code(service.unarchive(UNKNOWN_ID, ORIGIN))).toBe('BOT_NOT_FOUND');
    expect(await count('bots', 'name_key = $1', [nameKeyOf('Fantasma')])).toBe(0);
    expect((await auditRows()).length).toBe(auditBefore);
  });

  it('arquivar e desarquivar são idempotentes, e editar sem mudança real não altera nada nem audita', async () => {
    const bot = await service.create(input('Idempotente', { instructions: 'igual' }), ORIGIN);
    const auditBefore = (await auditRows()).length;

    advance(1000);
    const first = await service.archive(bot.id, ORIGIN);
    advance(1000);
    const second = await service.archive(bot.id, ORIGIN);
    expect(second.archivedAt).toBe(first.archivedAt); // a data do primeiro arquivamento permanece
    expect(second.updatedAt).toBe(first.updatedAt);
    await service.unarchive(bot.id, ORIGIN);
    const again = await service.unarchive(bot.id, ORIGIN);
    expect(again.archivedAt).toBeNull();
    expect((await auditRows()).length - auditBefore).toBe(2); // um arquivar e um desarquivar

    // Enviar os mesmos valores (ou nada) é um no-op: sem nova `updated_at` e sem auditoria.
    advance(1000);
    const untouched = await service.update(bot.id, { name: 'Idempotente', instructions: 'igual', stepLimit: 25 }, ORIGIN);
    const empty = await service.update(bot.id, {}, ORIGIN);
    expect(untouched.updatedAt).toBe(again.updatedAt);
    expect(empty).toEqual(untouched);
    expect((await auditRows()).length - auditBefore).toBe(2);

    // Edição parcial mexe só no que foi enviado, inclusive voltando as instruções a vazio.
    advance(1000);
    const cleared = await service.update(bot.id, { instructions: '' }, ORIGIN);
    expect(cleared).toMatchObject({ name: 'Idempotente', instructions: '', stepLimit: 25, updatedAt: now.toISOString() });
  });

  it('modelo e effort: o validador só é consultado quando a escolha muda, e uma recusa não grava nada', async () => {
    consulted.length = 0;
    // Sem modelo nem effort (o padrão) o provedor nem é consultado; criar com modelo consulta, e recusa não cria o bot.
    const plain = await service.create(input('Modelos'), ORIGIN);
    expect(consulted).toEqual([]);
    const botsBefore = await count('bots');
    expect(await code(service.create(input('Sem modelo válido', { model: 'fora-da-lista' }), ORIGIN))).toBe('MODEL_UNAVAILABLE');
    expect(await count('bots')).toBe(botsBefore);

    const chosen = await service.create(input('Com modelo', { model: 'opencode/glm-5.1', effort: 'high' }), ORIGIN);
    expect(chosen).toMatchObject({ model: 'opencode/glm-5.1', effort: 'high' });
    expect(consulted.at(-1)).toEqual(['opencode/glm-5.1', 'high']);

    // Editar outros campos não consulta, mesmo que o modelo gravado saia do catálogo depois.
    consulted.length = 0;
    await service.update(chosen.id, { name: 'Com modelo 2', instructions: 'nova' }, ORIGIN);
    await service.update(chosen.id, { model: 'opencode/glm-5.1', effort: 'high' }, ORIGIN); // valores iguais aos gravados
    expect(consulted).toEqual([]);

    // Trocar o modelo (mantendo o effort gravado) ou escolher um effort novo consulta a combinação FINAL.
    await service.update(chosen.id, { model: 'opencode/kimi-k2.7-code' }, ORIGIN);
    expect(consulted.at(-1)).toEqual(['opencode/kimi-k2.7-code', 'high']);
    await service.update(chosen.id, { effort: 'low' }, ORIGIN);
    expect(consulted.at(-1)).toEqual(['opencode/kimi-k2.7-code', 'low']);
    // Limpar o effort com o modelo igual não consulta; limpar o modelo consulta (o validador recusa effort sem modelo).
    consulted.length = 0;
    await service.update(chosen.id, { effort: null }, ORIGIN);
    expect(consulted).toEqual([]);
    await service.update(chosen.id, { model: null }, ORIGIN);
    expect(consulted).toEqual([[null, null]]);
    expect(await service.get(chosen.id)).toMatchObject({ model: null, effort: null });

    // Recusa na edição mantém o bot como estava.
    expect(await code(service.update(plain.id, { model: 'fora-da-lista' }, ORIGIN))).toBe('MODEL_UNAVAILABLE');
    expect(await service.get(plain.id)).toMatchObject({ model: null, effort: null });
  });

  it('criações simultâneas com o mesmo nome (em caixas diferentes): uma vence e as outras recebem BOT_NAME_TAKEN', async () => {
    const names = ['Corrida', 'corrida', 'CORRIDA', 'CoRrIdA', 'cORRIDA'];
    const results = await Promise.allSettled(names.map((name) => service.create(input(name), ORIGIN)));
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected.map((result) => (result.reason as DomainError).code)).toEqual(Array(4).fill('BOT_NAME_TAKEN'));
    expect(await count('bots', 'name_key = $1', ['corrida'])).toBe(1);
    // A transação perdedora desfez tudo: a conversa e a memória acompanham exatamente os bots existentes.
    expect(await count('conversations')).toBe(await count('bots'));
    expect(await count('bot_memories')).toBe(await count('bots'));
  });

  it('criar é tudo ou nada: se a memória não puder ser criada, nem o bot nem a conversa ficam', async () => {
    const before = { bots: await count('bots'), conversations: await count('conversations') };
    await pool.query(`
      CREATE FUNCTION falha_simulada() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'falha simulada'; END $$;
      CREATE TRIGGER falha_na_memoria BEFORE INSERT ON bot_memories FOR EACH ROW EXECUTE FUNCTION falha_simulada();
    `);
    try {
      expect(await code(service.create(input('Atomico'), ORIGIN))).toMatch(/^UNEXPECTED:/);
    } finally {
      await pool.query('DROP TRIGGER falha_na_memoria ON bot_memories; DROP FUNCTION falha_simulada();');
    }
    expect({ bots: await count('bots'), conversations: await count('conversations') }).toEqual(before);
    expect(await count('bots', 'name_key = $1', ['atomico'])).toBe(0);
    // Sem o gatilho, o mesmo nome entra normalmente (o nome não ficou "preso" pela tentativa que falhou).
    expect((await service.create(input('Atomico'), ORIGIN)).name).toBe('Atomico');
  });

  it('o banco recusa dados fora dos limites mesmo sem passar pelo schema (defesa em profundidade)', async () => {
    const insert = (overrides: Record<string, unknown>) => {
      const row = { name: 'x', name_key: 'x', color: '#AABBCC', instructions: '', step_limit: 25, ...overrides };
      return pool.query(
        `INSERT INTO bots (name, name_key, color, instructions, step_limit, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, now(), now())`,
        [row.name, row.name_key, row.color, row.instructions, row.step_limit],
      );
    };
    await expect(insert({ name: '', name_key: 'v1' })).rejects.toThrow(/check/i);
    await expect(insert({ name: 'a'.repeat(61), name_key: 'v2' })).rejects.toThrow(/check/i);
    await expect(insert({ name_key: 'v3', color: 'azul' })).rejects.toThrow(/check/i);
    await expect(insert({ name_key: 'v4', color: '#aabbcc' })).rejects.toThrow(/check/i);
    await expect(insert({ name_key: 'v5', instructions: 'x'.repeat(8001) })).rejects.toThrow(/check/i);
    await expect(insert({ name_key: 'v6', step_limit: 0 })).rejects.toThrow(/check/i);
    await expect(insert({ name_key: 'v7', step_limit: 101 })).rejects.toThrow(/check/i);
    // Dois bots ativos com a mesma chave também são recusados pelo índice, não só pelo serviço.
    await insert({ name_key: 'chave-unica' });
    await expect(insert({ name_key: 'chave-unica' })).rejects.toThrow(/bots_active_name_key/);
  });
});

// ===========================================================================================================================
// Exclusão definitiva (F6, A7, DATA-01): irreversível, então a prova é a mais pesada deste arquivo.
// ===========================================================================================================================

// --- Apoio: o catálogo do banco define o que é "tudo do bot" ---------------------------------------------------------------
// Nada abaixo decide o que pertence ao bot por uma lista de tabelas escrita à mão: tudo vem de `pg_constraint` (quem aponta para quem
// e quais colunas identificam cada linha). Se uma migration futura criar uma tabela com chave estrangeira para
// `bots`, `conversations`, `runs` ou `messages` (direta ou por outra tabela) e a exclusão não a apagar, estes testes reprovam: ou pelo
// conjunto esperado em `BOT_TABLES`, ou por sobrar no banco uma linha do bot excluído.

/** As tabelas que dependem do bot (direta ou transitivamente) hoje. Uma tabela nova na cadeia reprova o teste até a semente e a exclusão a cobrirem. */
const BOT_TABLES = [
  'approvals',
  'attachments',
  'bot_approval_rules',
  'bot_memories',
  'bot_objectives',
  'complements',
  'connector_account_bots',
  'context_cold_masks',
  'context_maintenance',
  'context_summary_refusals',
  'conversation_context',
  'conversation_events',
  'conversation_presence',
  'conversations',
  'doc_bot_access',
  'memory_versions',
  'message_attachment_links',
  'messages',
  'model_call_usage',
  'objective_versions',
  'push_deliveries',
  'push_events',
  'push_mutes',
  'push_receipts',
  'routine_occurrences',
  'routines',
  'runs',
  'table_bot_access',
];

/** Uma linha de tabela como o banco a descreve (`to_jsonb`): a base de toda comparação de conteúdo. */
type Row = Record<string, unknown>;

/** Chave estrangeira de coluna única: `child.childColumn` aponta para `parent.parentColumn`. */
interface ForeignKey {
  child: string;
  childColumn: string;
  parent: string;
  parentColumn: string;
  childColumns: string[];
  parentColumns: string[];
}

/** O que o catálogo do banco diz do schema `public`: as tabelas, as colunas da chave primária de cada uma e as chaves estrangeiras. */
interface Catalog {
  tables: string[];
  primaryKeys: Map<string, string[]>;
  foreignKeys: ForeignKey[];
}

/** Lê todas as chaves, inclusive compostas: cada tupla é seguida como unidade, sem atribuir linhas por um único membro da chave. */
async function readCatalog(db: Pool): Promise<Catalog> {
  const tables = await db.query<{ name: string }>("SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
  const keys = await db.query<{ table_name: string; columns: string[] }>(
    `SELECT c.relname AS table_name, array_agg(a.attname::text ORDER BY k.ord) AS columns
     FROM pg_constraint con
     JOIN pg_class c ON c.oid = con.conrelid AND c.relnamespace = 'public'::regnamespace
     CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
     WHERE con.contype = 'p'
     GROUP BY c.relname`,
  );
  const foreign = await db.query<ForeignKey>(
    `SELECT cc.relname AS child, ca.attname::text AS "childColumn", pc.relname AS parent, pa.attname::text AS "parentColumn",
            ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(n, ord) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.ord) AS "childColumns",
            ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(n, ord) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.ord) AS "parentColumns"
     FROM pg_constraint con
     JOIN pg_class cc ON cc.oid = con.conrelid AND cc.relnamespace = 'public'::regnamespace
     JOIN pg_class pc ON pc.oid = con.confrelid
     JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = con.conkey[1]
     JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
     WHERE con.contype = 'f'
     ORDER BY 1, 2`,
  );
  return {
    tables: tables.rows.map((row) => row.name),
    primaryKeys: new Map(keys.rows.map((row) => [row.table_name, row.columns])),
    foreignKeys: foreign.rows,
  };
}

/** Identidade estável de uma linha: os valores da chave primária ou, sem chave (ex.: `push_mutes`), a linha inteira. */
function identityOf(catalog: Catalog, table: string, row: Row): string {
  const columns = catalog.primaryKeys.get(table) ?? [];
  return columns.length > 0 ? columns.map((column) => String(row[column])).join('|') : JSON.stringify(row);
}

/** Tabelas que dependem de `root` seguindo as chaves estrangeiras (direta ou transitivamente), em ordem alfabética, sem contar `root`. */
function tablesDependingOn(catalog: Catalog, root: string): string[] {
  const reached = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const key of catalog.foreignKeys) {
      if (reached.has(key.parent) && !reached.has(key.child)) {
        reached.add(key.child);
        grew = true;
      }
    }
  }
  reached.delete(root);
  return [...reached].sort();
}

/**
 * Todas as linhas que pertencem ao bot, por tabela: parte da linha do bot e segue as chaves estrangeiras até não aparecer linha nova
 * (o ciclo execuções <-> mensagens converge porque só linhas inéditas contam). Uma linha pertence ao bot se alguma chave dela aponta
 * para uma linha que já pertence. O resultado é lido ANTES da exclusão e serve de gabarito do que precisa sumir.
 */
async function ownedRows(db: Pool, catalog: Catalog, botId: string): Promise<Map<string, Map<string, Row>>> {
  const owned = new Map<string, Map<string, Row>>();
  const add = (table: string, row: Row): boolean => {
    const rows = owned.get(table) ?? new Map<string, Row>();
    owned.set(table, rows);
    const identity = identityOf(catalog, table, row);
    if (rows.has(identity)) return false;
    rows.set(identity, row);
    return true;
  };
  const root = await db.query<{ row: Row }>('SELECT to_jsonb(b) AS row FROM bots b WHERE b.id = $1', [botId]);
  for (const { row } of root.rows) add('bots', row);
  for (let grew = true; grew; ) {
    grew = false;
    for (const key of catalog.foreignKeys) {
      const parents = owned.get(key.parent);
      if (!parents) continue;
      const values = [...parents.values()].filter((row) => key.parentColumns.every((column) => row[column] !== null && row[column] !== undefined))
        .map((row) => Object.fromEntries(key.parentColumns.map((column) => [column, String(row[column])])));
      if (values.length === 0) continue;
      const fields = key.parentColumns.map((column) => `"${column}" text`).join(', ');
      const match = key.childColumns.map((column, index) => `t."${column}"::text = p."${key.parentColumns[index]}"`).join(' AND ');
      const found = await db.query<{ row: Row }>(`SELECT to_jsonb(t) AS row FROM "${key.child}" t WHERE EXISTS (SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS p(${fields}) WHERE ${match})`, [JSON.stringify(values)]);
      for (const { row } of found.rows) if (add(key.child, row)) grew = true;
    }
  }
  return owned;
}

const byJson = (a: Row, b: Row): number => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);

/** Retrato do conteúdo de todas as tabelas (menos as de `skip`), com as linhas em ordem estável: a base do "byte a byte". */
async function dumpTables(db: Pool, catalog: Catalog, skip: readonly string[] = []): Promise<Record<string, Row[]>> {
  const dump: Record<string, Row[]> = {};
  for (const table of catalog.tables.filter((name) => !skip.includes(name))) {
    const rows = await db.query<{ row: Row }>(`SELECT to_jsonb(t) AS row FROM "${table}" t`);
    dump[table] = rows.rows.map((entry) => entry.row).sort(byJson);
  }
  return dump;
}

/** O retrato sem as linhas do bot: é exatamente o que o banco deve ser depois de excluí-lo. */
function withoutOwned(dump: Record<string, Row[]>, owned: Map<string, Map<string, Row>>, catalog: Catalog): Record<string, Row[]> {
  const detached = new Set([...(owned.get('table_bot_access')?.values() ?? [])].map((row) => row.table_id));
  // A conta do conector liberada ao bot excluído fica (é do dono) e tem a versão revisada, como a tabela compartilhada com ele (phase 13).
  const released = new Set([...(owned.get('connector_account_bots')?.values() ?? [])].map((row) => row.account_id));
  // O doc compartilhado com o bot excluído fica (é do dono, com as versões e os recibos) e tem a REVISÃO DE ACESSO revisada, como a tabela tem a versão (phase 14): o texto e a versão do doc não mudam.
  const shared = new Set([...(owned.get('doc_bot_access')?.values() ?? [])].map((row) => row.doc_id));
  const revised = (table: string, row: Row): Row => {
    if (table === 'data_tables' && detached.has(row.id)) return { ...row, version: Number(row.version) + 1 };
    if (table === 'connector_accounts' && released.has(row.id)) return { ...row, version: Number(row.version) + 1 };
    if (table === 'docs' && shared.has(row.id)) return { ...row, access_version: Number(row.access_version) + 1 };
    return row;
  };
  return Object.fromEntries(Object.entries(dump).map(([table, rows]) => [table, rows.filter((row) => !owned.get(table)?.has(identityOf(catalog, table, row))).map((row) => revised(table, row))]));
}

/** Linhas do gabarito que ainda existem (por tabela). Vazio quando a exclusão apagou tudo, inclusive o que uma chave `SET NULL` deixaria órfão. */
async function survivors(db: Pool, catalog: Catalog, owned: Map<string, Map<string, Row>>): Promise<Record<string, string[]>> {
  const left: Record<string, string[]> = {};
  for (const [table, rows] of owned) {
    const current = await db.query<{ row: Row }>(`SELECT to_jsonb(t) AS row FROM "${table}" t`);
    const still = current.rows.map(({ row }) => identityOf(catalog, table, row)).filter((identity) => rows.has(identity));
    if (still.length > 0) left[table] = still;
  }
  return left;
}

/** Quantas linhas do gabarito há numa tabela (0 se a tabela nem aparece). */
const sizeOf = (owned: Map<string, Map<string, Row>>, table: string): number => owned.get(table)?.size ?? 0;

/** Trilha de auditoria inteira em ordem, para conferir que só a linha de criação do bot excluído mudou e que uma linha nova entrou. */
const auditAll = (db: Pool) =>
  db
    .query<{ id: string; at: Date; action: string; outcome: string; actor: string; ip: string | null; user_agent: string | null; target: string | null; details: Record<string, unknown> }>(
      'SELECT id::text AS id, at, action, outcome, actor, ip, user_agent, target, details FROM audit_log ORDER BY audit_log.id', // `ORDER BY id` ordenaria pelo alias de texto
    )
    .then((result) => result.rows);

/** Erro lançado pela promessa, ou `null` se ela resolveu; para conferir também os `fields` de um `DomainError`. */
const failureOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
};

/** Instala um gatilho que lança `falha simulada` no evento dado; devolve a função que o remove. Serve para provar a atomicidade da exclusão. */
async function injectFailure(db: Pool, event: { on: 'DELETE' | 'INSERT'; table: string; when?: string }): Promise<() => Promise<void>> {
  await db.query(`
    CREATE FUNCTION falha_simulada() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'falha simulada'; END $$;
    CREATE TRIGGER falha_na_exclusao BEFORE ${event.on} ON ${event.table} FOR EACH ROW ${event.when ? `WHEN (${event.when})` : ''} EXECUTE FUNCTION falha_simulada();
  `);
  return async () => {
    await db.query(`DROP TRIGGER falha_na_exclusao ON ${event.table}; DROP FUNCTION falha_simulada();`);
  };
}

// --- Bloco 2: recusas, estados de execução, travas e limite (bancos leves, sem motor) -----------------------------------------
describe('exclusão definitiva: recusas, estados de execução, ordem de travas e limite (A7)', () => {
  let remover: BotService;
  let catalog: Catalog;

  beforeAll(async () => {
    // Teto alto: nenhum teste deste bloco, exceto o do limite, deve esbarrar nos 5 por minuto.
    remover = new BotService({ pool, models, now: () => now, deletesPerMinute: 1000 });
    catalog = await readCatalog(pool);
  });

  /** Bot já arquivado (a única forma excluível). */
  const archivedBot = async (name: string): Promise<Bot> => {
    const bot = await service.create(input(name), ORIGIN);
    await service.archive(bot.id, ORIGIN);
    return bot;
  };

  /** Execução do bot no estado dado, semeada por SQL (o motor não participa deste bloco). */
  const insertRun = async (botId: string, status: string): Promise<string> =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO runs (conversation_id, bot_id, status, input, created_at)
         SELECT c.id, c.bot_id, $2, 'semente', now() FROM conversations c WHERE c.bot_id = $1 RETURNING id::text AS id`,
        [botId, status],
      )
    ).rows[0]!.id;

  /** A tentativa é recusada com o código dado e o banco inteiro (inclusive a auditoria) fica exatamente como estava. */
  const refusedWith = async (expected: string, attempt: () => Promise<unknown>): Promise<void> => {
    const before = await dumpTables(pool, catalog);
    expect(await code(attempt())).toBe(expected);
    expect(await dumpTables(pool, catalog)).toEqual(before);
  };

  it('recusa bot inexistente, não arquivado e nome errado sem apagar nem auditar nada', async () => {
    const bot = await archivedBot('Recusado');
    const active = await service.create(input('Ainda ativo'), ORIGIN);

    await refusedWith('BOT_NOT_FOUND', () => remover.deleteArchived(UNKNOWN_ID, 'Recusado', ORIGIN));
    await refusedWith('BOT_NOT_ARCHIVED', () => remover.deleteArchived(active.id, 'Ainda ativo', ORIGIN));

    // O nome precisa ser IGUAL ao gravado: sem diferenciar maiúsculas não vale, nem prefixo, nem texto vazio, nem nome de outro bot.
    for (const typed of ['recusado', 'RECUSADO', 'Recusad', 'Recusado 2', '', 'Ainda ativo']) {
      const refusal = await failureOf(remover.deleteArchived(bot.id, typed, ORIGIN));
      expect(refusal, typed).toBeInstanceOf(DomainError);
      expect((refusal as DomainError).code).toBe('VALIDATION_FAILED');
      expect((refusal as DomainError).fields).toEqual([{ field: 'confirmName', reason: 'O nome digitado não confere.' }]);
    }
    await refusedWith('VALIDATION_FAILED', () => remover.deleteArchived(bot.id, 'recusado', ORIGIN));
    expect((await service.get(bot.id)).name).toBe('Recusado');

    // Precedência: existência, depois arquivamento, depois execuções, e só então o nome.
    await insertRun(active.id, 'queued');
    await refusedWith('BOT_NOT_ARCHIVED', () => remover.deleteArchived(active.id, 'nome errado', ORIGIN));
    await insertRun(bot.id, 'queued');
    await refusedWith('BOT_HAS_OPEN_RUN', () => remover.deleteArchived(bot.id, 'nome errado', ORIGIN));
  });

  it('recusa com execução na fila, em andamento ou esperando aprovação (cada uma), e aceita quando todas estão em estado final', async () => {
    const bot = await archivedBot('Com execuções');
    for (const status of ['queued', 'running', 'waiting_approval']) {
      const runId = await insertRun(bot.id, status);
      await refusedWith('BOT_HAS_OPEN_RUN', () => remover.deleteArchived(bot.id, 'Com execuções', ORIGIN));
      await pool.query('DELETE FROM runs WHERE id = $1', [runId]); // libera o índice "uma execução ativa por bot" para o próximo estado
    }
    // Todo estado final convive com a exclusão: nenhum deles é "aberto".
    for (const status of ['completed', 'failed', 'interrupted', 'limit_reached', 'expired', 'cancelled']) await insertRun(bot.id, status);
    expect(await count('runs', 'bot_id = $1', [bot.id])).toBe(6);

    await remover.deleteArchived(bot.id, 'Com execuções', ORIGIN);
    expect(await count('runs', 'bot_id = $1', [bot.id])).toBe(0);
    expect(await count('bots', 'id = $1', [bot.id])).toBe(0);
  });

  it('nome com acentos exclui com o texto canônico, e uma exclusão repetida devolve BOT_NOT_FOUND sem rastro', async () => {
    const bot = await archivedBot('Coração de Ação');
    await remover.deleteArchived(bot.id, 'Coração de Ação', ORIGIN);
    await refusedWith('BOT_NOT_FOUND', () => remover.deleteArchived(bot.id, 'Coração de Ação', ORIGIN));
  });

  it('ordem de travas do arquivamento: espera as rotinas do bot, não toca no bot antes, não entra em impasse com o agendador e enxerga a execução criada no meio', async () => {
    const bot = await archivedBot('Travas');
    const routine = await pool.query<{ id: string }>(
      `INSERT INTO routines (bot_id, name, instruction, schedule, timezone, anchor_at, status, created_at, updated_at)
       VALUES ($1, 'Rotina', 'instrução', '{"type":"daily","times":["07:00"]}', 'America/Sao_Paulo', now(), 'paused', now(), now()) RETURNING id`,
      [bot.id],
    );
    const conversationId = (await pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [bot.id])).rows[0]!.id;

    // O "agendador" (ou "Executar agora"): segura a rotina e só depois trava o bot para criar a execução, a ordem de `queueRun`.
    const scheduler = await pool.connect();
    try {
      await scheduler.query('BEGIN');
      await scheduler.query('SELECT id FROM routines WHERE id = $1 FOR UPDATE', [routine.rows[0]!.id]);

      const pending = code(remover.deleteArchived(bot.id, 'Travas', ORIGIN));
      // A exclusão fica esperando a trava da ROTINA...
      await waitFor('a exclusão esperando a trava das rotinas do bot', async () => {
        const waiting = await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FROM routines WHERE bot_id%'",
        );
        return waiting.rowCount ? true : null;
      });
      // ...e ainda não travou o bot: o agendador trava o bot SEM esperar (se a exclusão tivesse travado o bot primeiro, os dois se esperariam: impasse).
      await scheduler.query('SELECT id FROM bots WHERE id = $1 FOR UPDATE NOWAIT', [bot.id]);
      await scheduler.query("INSERT INTO runs (conversation_id, bot_id, status, input, created_at) VALUES ($1, $2, 'queued', 'agenda', now())", [conversationId, bot.id]);
      await scheduler.query('COMMIT');

      // A checagem de execuções vem DEPOIS da trava: ela enxerga a execução que nasceu enquanto a exclusão esperava.
      expect(await pending).toBe('BOT_HAS_OPEN_RUN');
    } finally {
      await scheduler.query('ROLLBACK').catch(() => undefined);
      scheduler.release();
    }
    expect(await count('bots', 'id = $1', [bot.id])).toBe(1);
    expect(await count('runs', "bot_id = $1 AND status = 'queued'", [bot.id])).toBe(1);
    expect(await count('routines', 'bot_id = $1', [bot.id])).toBe(1);
  });

  it('limita a 5 exclusões por minuto, contando cada tentativa, e volta a aceitar depois da janela, sem apagar nada quando recusa', async () => {
    const limited = new BotService({ pool, models, now: () => now }); // teto padrão
    const bot = await archivedBot('Limitado');
    for (let attempt = 0; attempt < 5; attempt += 1) expect(await code(limited.deleteArchived(UNKNOWN_ID, 'qualquer', ORIGIN))).toBe('BOT_NOT_FOUND');

    const refusal = await failureOf(limited.deleteArchived(bot.id, 'Limitado', ORIGIN));
    expect(refusal).toBeInstanceOf(DomainError);
    expect(refusal).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 60 });
    expect(await count('bots', 'id = $1', [bot.id])).toBe(1);

    advance(61_000);
    await limited.deleteArchived(bot.id, 'Limitado', ORIGIN);
    expect(await count('bots', 'id = $1', [bot.id])).toBe(0);
  });
});

// --- Bloco 3: dados reais, o catálogo do banco como gabarito -------------------------------------------------------------------
describe('exclusão definitiva com dados reais: dois bots, regras globais e uma sessão do chat geral (A7)', () => {
  const ALPHA = 'Alfa Confidencial';
  const BETA = 'Beta Vizinho';
  let world: RunsWorld;
  let remover: BotService;
  let catalog: Catalog;
  let alpha: Bot;
  let beta: Bot;

  /**
   * Percorre a vida de um bot pelos serviços e pelo motor de verdade (provedor e Composio falsos): conversa com várias rodadas, uma
   * memória escrita pelo dono e outra pelo bot (versões), execuções em cada estado final, um pedido de aprovação respondido com "sempre
   * permitir" (regra do bot), uma rotina executada à mão, um horário perdido, um silenciado de push e os avisos de push das execuções.
   */
  async function seedBot(name: string, push: PushService): Promise<Bot> {
    const bot = await world.createBot({ name, stepLimit: 4 });
    await world.memory.save({ scope: 'bot', botId: bot.id }, `Anotações do dono sobre ${name}`, 0, ORIGIN);

    const finish = async (text: string, status: string): Promise<string> => {
      const runId = await world.send(bot, text);
      await world.waitForStatus(runId, status);
      return runId;
    };
    await finish('Olá, tudo bem?', 'completed');
    await finish(`[memoria:lembrar de ${name}] anote isto`, 'completed'); // versão de memória escrita pelo bot, com cartão
    await finish('[pesquisar:tudo bem] procure', 'completed');
    await finish('[falha] provedor fora do ar', 'failed');
    await finish('[loop] sem parar', 'limit_reached');

    await world.releaseConnectorAccounts(bot);
    const gated = await world.send(bot, '[gmail] envie o relatório');
    const approval = await waitFor('pedido de aprovação pendente', async () => {
      const found = await world.approvalOf(gated);
      return found?.status === 'pending' ? found : null;
    });
    await world.waitForStatus(gated, 'waiting_approval');
    await world.approvals.respond(approval.id, 'allow_always', ORIGIN); // cria a regra do bot (bot_approval_rules)
    await world.waitForStatus(gated, 'completed');

    const slow = await world.send(bot, '[demorar]');
    await world.waitForStatus(slow, 'running');
    await world.conversations.stop(bot.id);
    await world.waitForStatus(slow, 'interrupted');

    const routine = await world.routines.create(
      {
        name: `Resumo de ${name}`,
        botId: bot.id,
        instruction: 'Resuma o dia',
        schedule: { type: 'daily', times: ['07:00'] },
        timezone: 'America/Sao_Paulo',
        startsAt: null,
        endsAt: null,
        maxRuns: null,
      },
      ORIGIN,
    );
    const manual = await world.routines.runNow(routine.id, ORIGIN);
    await world.waitForStatus(manual.id, 'completed');
    // Horário perdido: o agendador grava o cartão e o aponta na ocorrência (scheduler.ts, `missed`); a semente repete esse par.
    const missed = await world.pool.query<{ id: string }>(
      `INSERT INTO messages (conversation_id, role, kind, status, content, data, created_at)
       SELECT c.id, 'system', 'card', 'done', '', '{"type":"routine_missed"}', now() FROM conversations c WHERE c.bot_id = $1 RETURNING id`,
      [bot.id],
    );
    await world.pool.query(
      "INSERT INTO routine_occurrences (routine_id, scheduled_for, outcome, message_id, created_at) VALUES ($1, now() - interval '1 day', 'missed', $2, now())",
      [routine.id, missed.rows[0]!.id],
    );
    await world.pool.query("INSERT INTO attachments (conversation_id, kind, name, original_bytes, stored_bytes, extracted_text) SELECT id, 'document', 'semente.txt', 7, 7, 'semente' FROM conversations WHERE bot_id = $1", [bot.id]);
    // Vínculo extra de anexo a uma mensagem (phase 4, ATT-01): no uso real só a edição do Chat geral o cria, mas a tabela depende das mensagens do bot
    // e precisa sair com elas (cascata da chave para `messages`).
    await world.pool.query(
      `INSERT INTO message_attachment_links (message_id, attachment_id)
       SELECT m.id, a.id FROM conversations c JOIN messages m ON m.conversation_id = c.id AND m.opens_round
       JOIN attachments a ON a.conversation_id = c.id AND a.name = 'semente.txt' WHERE c.bot_id = $1 ORDER BY m.id LIMIT 1`,
      [bot.id],
    );
    // Rascunho devolvido com um anexo (phase 4, F5): o complemento só existe pendente durante uma execução ativa, que impede a exclusão.
    await world.pool.query(
      `WITH draft AS (
         INSERT INTO complements (conversation_id, state, content, created_at, returned_at)
         SELECT id, 'returned', 'rascunho da semente', now(), now() FROM conversations WHERE bot_id = $1 RETURNING id, conversation_id
       )
       INSERT INTO attachments (conversation_id, kind, name, original_bytes, stored_bytes, extracted_text, complement_id)
       SELECT conversation_id, 'document', 'rascunho.txt', 8, 8, 'rascunho', id FROM draft`,
      [bot.id],
    );
    // Presença de um aparelho (sessão de login própria) na conversa do bot (phase 3, T2): sai junto com a conversa, a sessão fica.
    await world.pool.query(
      `WITH device AS (
         INSERT INTO sessions (token_hash, created_at, last_used_at, expires_at, ip)
         VALUES (md5(random()::text), now(), now(), now() + interval '30 days', '127.0.0.1') RETURNING id
       )
       INSERT INTO conversation_presence (session_id, conversation_id, renewed_at) SELECT device.id, c.id, now() FROM device, conversations c WHERE c.bot_id = $1`,
      [bot.id],
    );
    await push.setMute(bot.id, 'run_completed', true, ORIGIN);
    // Entrega por dispositivo e registro do aparelho (phase 16, migration 0053): dependem do evento de push (ON DELETE CASCADE), que a exclusão do bot apaga, então saem com ele.
    // O `device_id` não tem chave para `push_devices` (a entrega do dispositivo recusado precisa sobreviver à remoção dele), por isso é só um uuid.
    const pushEvent = await world.pool.query<{ id: string }>('SELECT id::text AS id FROM push_events WHERE bot_id = $1 ORDER BY id LIMIT 1', [bot.id]);
    expect(pushEvent.rowCount, `um aviso de push gravado para ${name}`).toBe(1);
    await world.pool.query("INSERT INTO push_deliveries (event_id, device_id, attempt, http_status, outcome, created_at) VALUES ($1, gen_random_uuid(), 1, 404, 'rejected_token', now())", [pushEvent.rows[0]!.id]);
    await world.pool.query("INSERT INTO push_receipts (event_id, device_id, state, created_at) VALUES ($1, gen_random_uuid(), 'received', now())", [pushEvent.rows[0]!.id]);
    // Objetivo e revisão são dados independentes da memória e entram no inventário de exclusão cheio.
    await world.pool.query("INSERT INTO objective_versions(bot_id,version,content,source_message_ids,author,created_at) VALUES($1,1,'Direção sintética da semente','{}','bot',now())", [bot.id]);
    await world.pool.query("UPDATE bot_objectives SET content='Direção sintética da semente',version=1,updated_at=now() WHERE bot_id=$1", [bot.id]);
    // Estado de contexto/usage já nasce dos runs reais; manutenção também precisa de linha própria na prova de cascata. "Compactar agora" é a única manutenção
    // (a elisão saiu na phase 9) e exige o perfil do modelo validado, então o modelo é testado antes de ler a revisão esperada.
    await world.models.test('opencode/glm-5.1');
    const state=await world.conversations.contextState(bot.id),requestId=randomUUID();
    await world.conversations.maintainContext(bot.id,{requestId,mode:'summarize',expectedRevision:state.revision},randomUUID());
    const maintenance=(await world.pool.query<{id:string}>('SELECT id::text FROM runs WHERE context_operation_id=$1',[requestId])).rows[0]!;
    await world.waitForStatus(maintenance.id,'completed');
    // Recusa durável do resumo (phase 9, migration 0042): dado derivado da conversa, sai junto com ela pela cascata.
    await world.pool.query("INSERT INTO context_summary_refusals(conversation_id,impression,run_id,model,outcome,created_at) SELECT id,'impressao-sintetica-da-semente',$2,'opencode/glm-5.1','empty',now() FROM conversations WHERE bot_id=$1",[bot.id,maintenance.id]);
    // Limpeza fria gravada (phase 11, migration 0047): marca de que um resultado de ferramenta do bot vai ao modelo como marcador. Depende da conversa e da mensagem
    // (ON DELETE CASCADE), então precisa sair com o bot. A semente repete o que `maskColdResults` grava: uma linha por resultado de ferramenta concluído (atividade `completed`).
    const masked = await world.pool.query(
      `INSERT INTO context_cold_masks(message_id, conversation_id, masked_at)
       SELECT m.id, m.conversation_id, now() FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE c.bot_id = $1 AND m.kind = 'activity' AND m.status = 'completed' ORDER BY m.id LIMIT 1`,
      [bot.id],
    );
    expect(masked.rowCount, `um resultado de ferramenta concluído para mascarar em ${name}`).toBe(1);
    return bot;
  }

  beforeAll(async () => {
    world = await createRunsWorld({ engine: { approvalSweepMs: 40 } });
    await world.connectComposio();
    const push = new PushService({ pool: world.pool, config: { enabled: false } });
    await push.registerDevice('token-de-teste-1', ORIGIN); // sem dispositivo o motor nem grava avisos de push
    await world.memory.save({ scope: 'global' }, 'Regras globais do dono', 0, ORIGIN);
    world.engine.start();

    [alpha, beta] = await Promise.all([seedBot(ALPHA, push), seedBot(BETA, push)]);
    // Tabelas pertencem ao dono: só as associações são apagadas. Registros e recibos entram no retrato preservado.
    const preservedTable = randomUUID();
    await world.pool.query("INSERT INTO data_tables (id, name) VALUES ($1, 'Tabela preservada')", [preservedTable]);
    await world.pool.query('INSERT INTO table_bot_access (table_id, bot_id) VALUES ($1, $2), ($1, $3)', [preservedTable, alpha.id, beta.id]);
    await world.pool.query("INSERT INTO table_records (table_id, id, values) VALUES ($1, $2, '{}'::jsonb)", [preservedTable, randomUUID()]);
    // Contas do conector (phase 13, migration 0050): a conta é do dono e fica; só a liberação depende do bot e sai com ele (a versão da conta liberada sobe). Uma conta liberada
    // aos dois bots, outra só ao alfa (fica sem liberação) e outra sem nenhum bot (intacta).
    await world.pool.query(
      "INSERT INTO connector_accounts (id, app_slug, app_name, name, name_key) VALUES ('ca_compartilhada', 'gmail', 'Gmail', 'Pessoal', 'pessoal'), ('ca_so_alfa', 'gmail', 'Gmail', NULL, NULL), ('ca_sem_bot', 'github', 'Github', NULL, NULL)",
    );
    await world.pool.query("INSERT INTO connector_account_bots (account_id, bot_id) VALUES ('ca_compartilhada', $1), ('ca_compartilhada', $2), ('ca_so_alfa', $1)", [alpha.id, beta.id]);
    // Docs (phase 14, migration 0051): o doc é do dono e fica; só a associação depende do bot e sai com ele (a revisão de acesso do doc sobe). Um doc compartilhado com os dois bots, outro só com o alfa
    // (fica sem bot) e um sem nenhum bot (intacto). As versões não apontam para bot (o autor é "dono" ou "bot") e os recibos não apontam para o doc nem para o bot: tudo isso sobrevive à exclusão.
    const [sharedDoc, alphaDoc, looseDoc] = [randomUUID(), randomUUID(), randomUUID()];
    await world.pool.query("INSERT INTO docs (id, title, content, updated_by) VALUES ($1, 'Doc compartilhado', 'texto do alfa', 'bot'), ($2, 'Doc só do alfa', 'x', 'owner'), ($3, 'Doc sem bot', 'y', 'owner')", [sharedDoc, alphaDoc, looseDoc]);
    await world.pool.query(
      "INSERT INTO doc_versions (doc_id, version, content, author, created_at) VALUES ($1, 1, 'texto do alfa', 'bot', now()), ($2, 1, 'x', 'owner', now()), ($3, 1, 'y', 'owner', now())",
      [sharedDoc, alphaDoc, looseDoc],
    );
    await world.pool.query('INSERT INTO doc_bot_access (doc_id, bot_id) VALUES ($1, $2), ($1, $3), ($4, $2)', [sharedDoc, alpha.id, beta.id, alphaDoc]);
    await world.pool.query("INSERT INTO doc_mutation_receipts (actor, operation_id, doc_id, action, payload_hash, result) VALUES ($1, $2, $3, 'doc.update', 'hash', '{}'::jsonb)", [`bot:${alpha.id}`, randomUUID(), sharedDoc]);

    // Uma sessão do chat geral com conversa de verdade, salva, e um silenciado do Chat geral: nada disso é de nenhum bot.
    await world.conversations.setSessionDefault('opencode/glm-5.1', null, ORIGIN);
    const chat = new GeneralChatService({ pool: world.pool });
    const session = await chat.create();
    const sessionRun = await world.conversations.send({ sessionId: session.id }, 'Olá do chat geral');
    await world.waitForStatus(sessionRun.id, 'completed');
    await chat.setSaved(session.id, true);
    await push.setMute(null, 'run_failed', true, ORIGIN);

    await world.engine.stop(); // nenhum processo do motor mexe no banco durante as provas
    await world.bots.archive(alpha.id, ORIGIN);
    remover = new BotService({ pool: world.pool, models: world.models, deletesPerMinute: 1000 });
    catalog = await readCatalog(world.pool);
  }, 120_000);

  afterAll(async () => {
    await world.cleanup();
  });

  it('a semente cobre TODA tabela que depende do bot (o gabarito vem do catálogo, não de uma lista fixa)', async () => {
    expect(tablesDependingOn(catalog, 'bots')).toEqual(BOT_TABLES);
    for (const bot of [alpha, beta]) {
      const owned = await ownedRows(world.pool, catalog, bot.id);
      for (const table of BOT_TABLES) expect(sizeOf(owned, table), `${table} semeada para ${bot.name}`).toBeGreaterThan(0);
      const statuses = [...(owned.get('runs')?.values() ?? [])].map((row) => row.status);
      expect(statuses).toEqual(expect.arrayContaining(['completed', 'failed', 'limit_reached', 'interrupted']));
      expect([...(owned.get('approvals')?.values() ?? [])].map((row) => row.status)).toContain('approved');
    }
  });

  it('as recusas com dados reais não apagam nem auditam nada', async () => {
    const before = await dumpTables(world.pool, catalog);
    expect(await code(remover.deleteArchived(beta.id, BETA, ORIGIN))).toBe('BOT_NOT_ARCHIVED'); // beta segue ativo
    expect(await code(remover.deleteArchived(alpha.id, 'nome errado', ORIGIN))).toBe('VALIDATION_FAILED');
    expect(await code(remover.deleteArchived(alpha.id, ALPHA.toLowerCase(), ORIGIN))).toBe('VALIDATION_FAILED');
    expect(await code(remover.deleteArchived(UNKNOWN_ID, ALPHA, ORIGIN))).toBe('BOT_NOT_FOUND');
    expect(await dumpTables(world.pool, catalog)).toEqual(before);
  });

  it('uma falha em qualquer ponto da transação desfaz tudo, inclusive a auditoria e o nome no registro de criação', async () => {
    const before = await dumpTables(world.pool, catalog); // todas as tabelas, com a auditoria
    const failures = [
      { label: 'na primeira tabela com dado (mensagens)', on: 'DELETE', table: 'messages' },
      { label: 'na última linha apagada (o próprio bot)', on: 'DELETE', table: 'bots' },
      { label: 'ao gravar a auditoria da exclusão, depois de tudo', on: 'INSERT', table: 'audit_log', when: "NEW.action = 'bot.delete'" },
    ] as const;
    for (const failure of failures) {
      const restore = await injectFailure(world.pool, failure);
      try {
        await expect(remover.deleteArchived(alpha.id, ALPHA, ORIGIN), failure.label).rejects.toThrow('falha simulada');
      } finally {
        await restore();
      }
      expect(await dumpTables(world.pool, catalog), failure.label).toEqual(before);
    }
    // Sem o gatilho a mesma exclusão passa a funcionar: a falha não deixou nada preso (trava, estado ou nome gasto).
    expect((await ownedRows(world.pool, catalog, alpha.id)).size).toBeGreaterThan(0);
  });

  it('apaga TUDO do bot (nenhuma linha em nenhuma tabela dependente) e mantém o resto do banco byte a byte', async () => {
    const owned = await ownedRows(world.pool, catalog, alpha.id);
    const ownedBeta = await ownedRows(world.pool, catalog, beta.id);
    const dumpBefore = await dumpTables(world.pool, catalog, ['audit_log']);
    const auditBefore = await auditAll(world.pool);

    await remover.deleteArchived(alpha.id, ALPHA, ORIGIN);

    // 1. Nada do bot restou, em nenhuma tabela que dependa dele (nem como linha órfã com a chave zerada).
    expect(await survivors(world.pool, catalog, owned)).toEqual({});
    expect((await ownedRows(world.pool, catalog, alpha.id)).size).toBe(0);
    // 2. O resto do banco é exatamente o de antes menos as linhas do bot: outros bots, Regras Globais, perfis de modelo, dispositivos de
    //    push, credenciais, configurações e a sessão do chat geral, com contagens e conteúdos idênticos.
    expect(await dumpTables(world.pool, catalog, ['audit_log'])).toEqual(withoutOwned(dumpBefore, owned, catalog));
    expect(await ownedRows(world.pool, catalog, beta.id)).toEqual(ownedBeta);
    // Docs (A25): os três docs, as três versões e o recibo continuam; o compartilhado com os dois bots segue com o beta, e o que era só do alfa ficou sem bot.
    expect((await world.pool.query("SELECT title, access_version, version FROM docs ORDER BY title")).rows).toEqual([
      { title: 'Doc compartilhado', access_version: 2, version: 1 },
      { title: 'Doc sem bot', access_version: 1, version: 1 },
      { title: 'Doc só do alfa', access_version: 2, version: 1 },
    ]);
    expect((await world.pool.query('SELECT count(*)::int AS total FROM doc_versions')).rows).toEqual([{ total: 3 }]);
    expect((await world.pool.query('SELECT count(*)::int AS total FROM doc_mutation_receipts')).rows).toEqual([{ total: 1 }]);
    expect((await world.pool.query('SELECT d.title, a.bot_id FROM doc_bot_access a JOIN docs d ON d.id = a.doc_id')).rows).toEqual([{ title: 'Doc compartilhado', bot_id: beta.id }]);
    // A limpeza fria gravada (migration 0047) sai com o bot excluído pela cascata das mensagens e da conversa; a do bot vizinho fica intacta (é a única que sobra na tabela).
    const maskedIds = [...(owned.get('context_cold_masks')?.values() ?? [])].map((row) => String(row.message_id));
    expect(maskedIds.length).toBeGreaterThan(0);
    expect((await world.pool.query('SELECT 1 FROM context_cold_masks WHERE message_id = ANY($1::bigint[])', [maskedIds])).rowCount).toBe(0);
    expect((await world.pool.query('SELECT 1 FROM context_cold_masks')).rowCount).toBe(sizeOf(ownedBeta, 'context_cold_masks'));
    const sessions =await world.pool.query('SELECT 1 FROM conversations WHERE bot_id IS NULL');
    expect(sessions.rowCount).toBeGreaterThan(0);
    expect((await world.pool.query('SELECT content FROM global_memory')).rows).toEqual([{ content: 'Regras globais do dono' }]);

    // 3. Auditoria: só a linha de criação do bot excluído mudou (perdeu o nome) e uma linha `bot.delete` entrou, com id e contagens.
    const auditAfter = await auditAll(world.pool);
    const forgotten = auditBefore.map((row) => (row.action === 'bot.create' && row.target === alpha.id ? { ...row, details: {} } : row));
    expect(auditAfter.slice(0, auditBefore.length)).toEqual(forgotten);
    expect(auditAfter).toHaveLength(auditBefore.length + 1);
    const deletion = auditAfter.at(-1)!;
    expect(deletion).toMatchObject({ action: 'bot.delete', outcome: 'success', actor: 'owner', ip: ORIGIN.ip, user_agent: ORIGIN.userAgent, target: alpha.id });
    expect(deletion.details).toEqual({
      approvals: sizeOf(owned, 'approvals'),
      attachments: sizeOf(owned, 'attachments'),
      attachmentBytes: 15, // o anexo solto da semente (7) e o do rascunho devolvido (8)
      complements: sizeOf(owned, 'complements'),
      pushEvents: sizeOf(owned, 'push_events'),
      occurrences: sizeOf(owned, 'routine_occurrences'),
      messages: sizeOf(owned, 'messages'),
      runs: sizeOf(owned, 'runs'),
      routines: sizeOf(owned, 'routines'),
      events: sizeOf(owned, 'conversation_events'),
      objectiveVersions: sizeOf(owned, 'objective_versions'),
      objectives: sizeOf(owned, 'bot_objectives'),
      memoryVersions: sizeOf(owned, 'memory_versions'),
      rules: sizeOf(owned, 'bot_approval_rules'),
      mutes: sizeOf(owned, 'push_mutes'),
      tableAccess: sizeOf(owned, 'table_bot_access'),
      connectorAccess: sizeOf(owned, 'connector_account_bots'),
      docAccess: sizeOf(owned, 'doc_bot_access'),
    });
    // Nem o nome nem o texto de nada do bot sobrevivem na trilha; o registro de criação do OUTRO bot segue com o nome dele.
    expect(JSON.stringify(auditAfter)).not.toContain(ALPHA);
    expect(JSON.stringify(auditAfter)).not.toContain('Anotações do dono');
    expect(auditAfter.find((row) => row.action === 'bot.create' && row.target === beta.id)?.details).toEqual({ name: BETA });
    expect(auditAfter.filter((row) => row.action === 'bot.create' && row.target === alpha.id).map((row) => row.details)).toEqual([{}]);

    // 4. Uma exclusão repetida é BOT_NOT_FOUND e não deixa rastro.
    const dumpAfter = await dumpTables(world.pool, catalog);
    expect(await code(remover.deleteArchived(alpha.id, ALPHA, ORIGIN))).toBe('BOT_NOT_FOUND');
    expect(await dumpTables(world.pool, catalog)).toEqual(dumpAfter);
  });
});

// --- Bloco 4: estado ao vivo na lista (F10, A12) --------------------------------------------------------------------------------
// A regra de precedência é provada sozinha em packages/shared (live-state.test.ts). Aqui se prova que a CONSULTA da lista entrega os fatos certos para
// ela: primeiro com execuções semeadas por SQL (cada linha da precedência, com o relógio do serviço simulado), depois com o motor e o provedor falsos
// executando de verdade, e por fim a leitura do bot completo, que não traz o estado.
describe('estado ao vivo na lista de bots (A12)', () => {
  const T0 = new Date('2026-06-01T12:00:00.000Z');
  let clock = T0;
  let live: BotService;

  beforeAll(() => {
    live = new BotService({ pool, models, now: () => clock });
  });

  /** O estado que a lista mostra hoje para o bot. */
  const stateOf = async (bot: Bot): Promise<string | undefined> => (await live.list()).find((item) => item.id === bot.id)?.runState;

  /** Execução semeada por SQL com o término dado (`finishedAt` nulo = ainda sem término); só o necessário para a consulta. */
  const seedRun = async (bot: Bot, status: string, finishedAt: Date | null = null): Promise<string> =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO runs (conversation_id, bot_id, status, input, created_at, finished_at)
         SELECT c.id, c.bot_id, $2, 'semente', $3, $4 FROM conversations c WHERE c.bot_id = $1 RETURNING id::text AS id`,
        [bot.id, status, T0, finishedAt],
      )
    ).rows[0]!.id;

  const seedRoutine = async (bot: Bot, status: 'active' | 'paused' | 'completed'): Promise<void> => {
    await pool.query(
      `INSERT INTO routines (bot_id, name, instruction, schedule, timezone, anchor_at, status, created_at, updated_at)
       VALUES ($1, $2, 'instrução', '{"type":"daily","times":["07:00"]}', 'America/Sao_Paulo', $3, $4, $3, $3)`,
      [bot.id, `Rotina ${status}`, T0, status],
    );
  };

  const fresh = (name: string): Promise<Bot> => service.create(input(`Vivo ${name}`), ORIGIN);

  /**
   * Manutenção de contexto enfileirada pelo ENFILEIRADOR de verdade (`queueContextMaintenance`, fonte única das duas origens), não por um INSERT imitando a linha: sem sessão é a
   * compactação fria do worker (phase 11, T8, sem gesto do dono); com sessão é o clique do dono em "Compactar agora". Nasce `queued`; o teste a leva a `running` e a `completed` por SQL,
   * como o motor faria, no relógio simulado do serviço da lista (o executor de verdade mede o término no relógio real e não deixaria provar a janela de 60 s do "concluído").
   */
  const queueMaintenance = async (bot: Bot, origin: 'cold' | 'manual'): Promise<string> =>
    withTransaction(pool, async (tx) => {
      const conversationId = (await tx.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [bot.id])).rows[0]!.id;
      const run = await queueContextMaintenance(tx, {
        botId: bot.id,
        conversationId,
        requestId: randomUUID(),
        mode: 'summarize',
        expectedRevision: 0,
        sessionId: origin === 'cold' ? null : randomUUID(),
        at: clock,
      });
      return run.id;
    });

  it('cada linha da precedência: livre, trabalhando, aguardando, fila como livre, interrompida e cancelada como livres', async () => {
    clock = T0;
    expect(await stateOf(await fresh('livre'))).toBe('idle');

    const working = await fresh('trabalhando');
    await seedRun(working, 'running');
    expect(await stateOf(working)).toBe('working');

    const waiting = await fresh('aguardando');
    await seedRun(waiting, 'waiting_approval');
    expect(await stateOf(waiting)).toBe('waiting');

    const queued = await fresh('fila');
    await seedRun(queued, 'queued');
    expect(await stateOf(queued)).toBe('idle'); // a fila conta como livre

    for (const status of ['interrupted', 'cancelled']) {
      const bot = await fresh(`terminal ${status}`);
      await seedRun(bot, status, T0);
      expect(await stateOf(bot), status).toBe('idle');
    }
  });

  it('concluída é done por 60 s desde finished_at (fronteira exata) e depois livre', async () => {
    const bot = await fresh('concluído');
    await seedRun(bot, 'completed', T0);
    clock = T0;
    expect(await stateOf(bot)).toBe('done');
    clock = new Date(T0.getTime() + 59_999);
    expect(await stateOf(bot)).toBe('done');
    clock = new Date(T0.getTime() + 60_000);
    expect(await stateOf(bot)).toBe('idle');
    clock = new Date(T0.getTime() + 3_600_000);
    expect(await stateOf(bot)).toBe('idle');
    clock = T0;
  });

  it('falhou, expirou ou atingiu o limite é erro até a próxima execução começar; a fila não limpa o erro e a execução que começa assume', async () => {
    clock = new Date(T0.getTime() + 86_400_000 * 30); // um mês depois do término: o erro não tem prazo
    for (const status of ['failed', 'expired', 'limit_reached']) {
      const bot = await fresh(`erro ${status}`);
      await seedRun(bot, status, T0);
      expect(await stateOf(bot), status).toBe('error');
    }

    const bot = await fresh('erro e retomada');
    await seedRun(bot, 'failed', T0);
    expect(await stateOf(bot)).toBe('error');
    const next = await seedRun(bot, 'queued');
    expect(await stateOf(bot), 'a fila ainda não é "começar"').toBe('error');
    await pool.query("UPDATE runs SET status = 'running' WHERE id = $1", [next]);
    expect(await stateOf(bot), 'a execução começou').toBe('working');
    await pool.query("UPDATE runs SET status = 'completed', finished_at = $2 WHERE id = $1", [next, clock]);
    expect(await stateOf(bot), 'a nova execução terminou bem').toBe('done');
    clock = new Date(clock.getTime() + 60_000);
    expect(await stateOf(bot), 'e o erro antigo não volta').toBe('idle');
    clock = T0;
  });

  it('a última execução terminal é a que TERMINOU por último, não a de maior id (uma da fila cancelada cedo não esconde a falha)', async () => {
    const bot = await fresh('ordem');
    // A execução 1 falhou depois; a 2 (id maior) foi cancelada antes, ainda na fila, quando a rotina foi pausada.
    await seedRun(bot, 'failed', new Date(T0.getTime() - 1_000));
    await seedRun(bot, 'cancelled', new Date(T0.getTime() - 30_000));
    clock = T0;
    expect(await stateOf(bot)).toBe('error');
  });

  it('arquivado dorme (mesmo com falha recente) e rotinas todas pausadas também; ativa ou concluída entre elas não conta como pausada', async () => {
    clock = T0;
    const archived = await fresh('arquivado');
    await seedRun(archived, 'failed', T0);
    await service.archive(archived.id, ORIGIN); // o arquivamento pausa as rotinas do bot e vale mais que a falha
    expect(await stateOf(archived)).toBe('sleep');

    const paused = await fresh('rotinas pausadas');
    await seedRoutine(paused, 'paused');
    await seedRoutine(paused, 'paused');
    expect(await stateOf(paused)).toBe('sleep');

    const mixed = await fresh('rotinas mistas');
    await seedRoutine(mixed, 'paused');
    await seedRoutine(mixed, 'active');
    expect(await stateOf(mixed), 'uma ativa basta para não dormir').toBe('idle');

    const finishedOne = await fresh('rotina concluída');
    await seedRoutine(finishedOne, 'paused');
    await seedRoutine(finishedOne, 'completed');
    expect(await stateOf(finishedOne), 'concluída não é pausada').toBe('idle');

    // Com rotinas pausadas, a falha (regra 3) vale mais que o sono (regra 4), e uma execução ativa vale mais que as duas.
    const failing = await fresh('rotina pausada e falha');
    await seedRoutine(failing, 'paused');
    await seedRun(failing, 'failed', T0);
    expect(await stateOf(failing)).toBe('error');
    await seedRun(failing, 'running');
    expect(await stateOf(failing)).toBe('working');
  });

  it('o arquivado que ainda tem uma execução em andamento mostra a execução (a regra 1 vale mais que o arquivamento)', async () => {
    const bot = await fresh('arquivado trabalhando');
    await seedRun(bot, 'running');
    await service.archive(bot.id, ORIGIN);
    expect(await stateOf(bot)).toBe('working');
  });

  it('a manutenção de contexto, fria ou manual, não é trabalho do bot: enfileirada, em andamento e concluída não muda o estado nem esconde o último desfecho', async () => {
    for (const origin of ['cold', 'manual'] as const) {
      // Erro verdadeiro anterior, uma hora depois do término: a execução de manutenção concluída agora seria a "última execução terminal" e esconderia a falha (virava "done").
      clock = new Date(T0.getTime() + 3_600_000);
      const failing = await fresh(`manutenção ${origin} depois de falha`);
      await seedRun(failing, 'failed', T0);
      expect(await stateOf(failing), `${origin}: ponto de partida`).toBe('error');
      const afterFailure = await queueMaintenance(failing, origin);
      expect(await stateOf(failing), `${origin}: enfileirada`).toBe('error');
      await pool.query("UPDATE runs SET status = 'running' WHERE id = $1", [afterFailure]);
      expect(await stateOf(failing), `${origin}: em andamento não é "Trabalhando"`).toBe('error');
      await pool.query("UPDATE runs SET status = 'completed', finished_at = $2 WHERE id = $1", [afterFailure, clock]);
      expect(await stateOf(failing), `${origin}: concluída agora não esconde o erro nem vira "Concluiu agora"`).toBe('error');

      // Bot livre: a manutenção concluída agora (dentro dos 60 s do "concluído") não o põe em "done".
      const idle = await fresh(`manutenção ${origin} sem execução`);
      expect(await stateOf(idle), `${origin}: ponto de partida`).toBe('idle');
      const onIdle = await queueMaintenance(idle, origin);
      expect(await stateOf(idle), `${origin}: enfileirada`).toBe('idle');
      await pool.query("UPDATE runs SET status = 'running' WHERE id = $1", [onIdle]);
      expect(await stateOf(idle), `${origin}: em andamento não é "Trabalhando"`).toBe('idle');
      await pool.query("UPDATE runs SET status = 'completed', finished_at = $2 WHERE id = $1", [onIdle, clock]);
      expect(await stateOf(idle), `${origin}: concluída agora não é "Concluiu agora"`).toBe('idle');

      // Controle: a mesma consulta continua vendo a execução de verdade do bot, que vale em cima da manutenção que terminou.
      await seedRun(idle, 'running');
      expect(await stateOf(idle), `${origin}: execução real em andamento`).toBe('working');
    }
    clock = T0;
  });

  it('só a lista traz o estado: o bot completo, a criação e a edição não o devolvem', async () => {
    const bot = await fresh('contrato');
    expect(Object.keys(bot)).not.toContain('runState');
    expect(Object.keys(await service.get(bot.id))).not.toContain('runState');
    expect(Object.keys(await service.update(bot.id, { instructions: 'x' }, ORIGIN))).not.toContain('runState');
    expect(Object.keys((await live.list()).find((item) => item.id === bot.id) ?? {}).sort()).toEqual(['archivedAt', 'color', 'id', 'name', 'preview', 'runState', 'unread']);
  });

  it('com o motor e o provedor falsos executando de verdade: trabalhando, aguardando, concluído, erro e livre depois de interromper', async () => {
    const world = await createRunsWorld({ engine: { approvalSweepMs: 40 } });
    try {
      await world.connectComposio();
      world.engine.start();
      const stateInWorld = async (bot: Bot): Promise<string | undefined> => (await world.bots.list()).find((item) => item.id === bot.id)?.runState;
      const previewInWorld = async (bot: Bot): Promise<string | undefined> => (await world.bots.list()).find((item) => item.id === bot.id)?.preview;
      const bot = await world.createBot({ name: 'Real' });
      const idleBot = await world.createBot({ name: 'Parado' });
      expect(await stateInWorld(bot)).toBe('idle');

      // Concluída: "done" logo depois de terminar (o relógio é o real, e a janela é de 60 s).
      await world.waitForStatus(await world.send(bot, 'Olá, tudo bem?'), 'completed');
      expect(await stateInWorld(bot)).toBe('done');
      // A prévia é a primeira linha da resposta que o bot gravou (o que o bot respondeu, sem a mensagem do dono nem a atividade).
      const answer = (await world.pool.query<{ content: string }>("SELECT content FROM messages WHERE conversation_id = (SELECT id FROM conversations WHERE bot_id = $1) AND role = 'assistant' AND kind = 'text' AND status = 'done' ORDER BY id DESC LIMIT 1", [bot.id])).rows[0]!.content;
      expect(answer).not.toBe('');
      expect(await previewInWorld(bot)).toBe(firstPlainLine(answer));

      // Falhou (provedor fora do ar): erro, e fica erro (o "done" anterior era de uma execução mais antiga).
      await world.waitForStatus(await world.send(bot, '[falha] provedor fora do ar'), 'failed');
      expect(await stateInWorld(bot)).toBe('error');
      expect(await previewInWorld(bot)).toBe('A execução falhou'); // o cartão de falha é a novidade mais recente

      // Aguardando aprovação: a execução pausa e o estado é "waiting"; permitir retoma, e ao concluir volta a "done".
      await world.releaseConnectorAccounts(bot);
      const gated = await world.send(bot, '[gmail] envie o relatório');
      await world.waitForStatus(gated, 'waiting_approval');
      expect(await stateInWorld(bot)).toBe('waiting');
      expect(await previewInWorld(bot)).toBe('Aprovação pendente'); // o cartão da aprovação em espera
      const approval = await waitFor('pedido de aprovação pendente', async () => {
        const found = await world.approvalOf(gated);
        return found?.status === 'pending' ? found : null;
      });
      await world.approvals.respond(approval.id, 'allow_once', ORIGIN);
      await world.waitForStatus(gated, 'completed');
      expect(await stateInWorld(bot)).toBe('done');

      // Trabalhando: uma execução que não termina; interrompê-la deixa o bot livre (interrompida não é falha, e vale mais que o "done" antigo).
      const slow = await world.send(bot, '[demorar]');
      await world.waitForStatus(slow, 'running');
      expect(await stateInWorld(bot)).toBe('working');
      await world.conversations.stop(bot.id);
      await world.waitForStatus(slow, 'interrupted');
      expect(await stateInWorld(bot)).toBe('idle');

      // Um bot que nunca executou segue livre, e o arquivamento o põe para dormir.
      expect(await stateInWorld(idleBot)).toBe('idle');
      await world.bots.archive(idleBot.id, ORIGIN);
      expect(await stateInWorld(idleBot)).toBe('sleep');
    } finally {
      await world.cleanup();
    }
  }, 60_000);
});

describe('prévia da última novidade na lista de bots (phase 5, T5; spec F4, Suposição 12)', () => {
  /** Linhas da conversa no formato que o CHECK da migration 0006 exige para cada tipo. */
  const LINE_SQL = {
    owner: "'user', 'text', 'done', NULL",
    answer: "'assistant', 'text', 'done', 1",
    streaming: "'assistant', 'text', 'streaming', 1",
    discarded: "'assistant', 'text', 'discarded', 1",
    activity: "'assistant', 'activity', 'completed', 1",
    card: "'system', 'card', 'done', NULL",
  } as const;

  /** Grava uma mensagem na conversa do bot, na ordem de chamada (o id cresce), com o texto ou o cartão dados. */
  const say = async (bot: Bot, line: keyof typeof LINE_SQL, content: string, data: unknown = {}): Promise<void> => {
    await pool.query(
      `INSERT INTO messages (conversation_id, role, kind, status, step, content, data, created_at)
       SELECT c.id, ${LINE_SQL[line]}, $2, $3::jsonb, $4 FROM conversations c WHERE c.bot_id = $1`,
      [bot.id, content, JSON.stringify(data), now],
    );
  };

  const previewOfBot = async (bot: Bot): Promise<string | undefined> => (await service.list()).find((item) => item.id === bot.id)?.preview;
  const fresh = (name: string): Promise<Bot> => service.create(input(`Prévia ${name}`), ORIGIN);
  const failedCard = { type: 'run_failed', code: 'PROVIDER_ERROR' };
  const activityData = { tool: 'x', label: 'x', arguments: '{}', callId: 'c1', detail: null };

  it('conversa vazia e conversa só com mensagens do dono, texto em escrita, descartado ou atividade: "Nenhuma mensagem ainda"', async () => {
    const bot = await fresh('vazio');
    expect(await previewOfBot(bot)).toBe('Nenhuma mensagem ainda');
    await say(bot, 'owner', 'Oi, tudo bem?');
    await say(bot, 'streaming', 'Escrevendo aos poucos…');
    await say(bot, 'discarded', 'Resposta descartada');
    await say(bot, 'activity', 'resultado da ferramenta', activityData);
    expect(await previewOfBot(bot)).toBe('Nenhuma mensagem ainda');
  });

  it('um bot sem conversa nenhuma (linha criada por SQL, sem a conversa única) também mostra "Nenhuma mensagem ainda" e a lista não cai', async () => {
    await pool.query("INSERT INTO bots (name, name_key, color, created_at, updated_at) VALUES ('Prévia sem conversa', 'prévia sem conversa', '#60A5FA', now(), now())");
    try {
      expect((await service.list()).find((item) => item.name === 'Prévia sem conversa')?.preview).toBe('Nenhuma mensagem ainda');
    } finally {
      await pool.query("DELETE FROM bots WHERE name_key = 'prévia sem conversa'");
    }
  });

  it('a resposta final é a primeira linha, sem Markdown; a mais recente vence, e o dono, o texto em escrita, o descartado e a atividade depois dela não mudam nada', async () => {
    const bot = await fresh('resposta');
    await say(bot, 'answer', '## **Relatório pronto**: veja o [anexo](https://exemplo.com/r)\nSegunda linha que não aparece.');
    expect(await previewOfBot(bot)).toBe('Relatório pronto: veja o anexo');
    await say(bot, 'answer', '- primeiro item\n- segundo item');
    expect(await previewOfBot(bot)).toBe('primeiro item');
    await say(bot, 'owner', 'E agora?');
    await say(bot, 'streaming', 'Terceira resposta ainda em escrita');
    await say(bot, 'discarded', 'Quarta, descartada');
    await say(bot, 'activity', 'saída da ferramenta', activityData);
    expect(await previewOfBot(bot)).toBe('primeiro item');
    // Quando o texto em escrita termina, vira a novidade mais recente.
    await pool.query("UPDATE messages SET status = 'done' WHERE status = 'streaming' AND conversation_id = (SELECT id FROM conversations WHERE bot_id = $1)", [bot.id]);
    expect(await previewOfBot(bot)).toBe('Terceira resposta ainda em escrita');
  });

  it('o cartão mais recente vence a resposta anterior (título do cartão), e uma resposta mais nova vence o cartão', async () => {
    const bot = await fresh('cartão');
    await say(bot, 'answer', 'Vou enviar o e-mail.');
    await say(bot, 'card', '', {
      type: 'approval',
      approvalId: '1',
      status: 'pending',
      decision: null,
      action: 'GMAIL_SEND_EMAIL',
      actionLabel: 'Send Email',
      appName: 'Gmail',
      params: [],
      omitted: [],
      expiresAt: '2026-03-02T12:00:00.000Z',
    });
    expect(await previewOfBot(bot)).toBe('Aprovação pendente');
    await say(bot, 'card', 'A execução falhou', failedCard);
    expect(await previewOfBot(bot)).toBe('A execução falhou');
    await say(bot, 'answer', 'Tudo certo agora.');
    expect(await previewOfBot(bot)).toBe('Tudo certo agora.');
    await say(bot, 'card', '', {
      type: 'routine_run',
      routineId: null,
      routineName: 'Resumo diário',
      scheduledFor: '2026-03-01T10:00:00.000Z',
      startedAt: '2026-03-01T10:00:01.000Z',
      manual: false,
      state: 'completed',
      finishedAt: '2026-03-01T10:05:00.000Z',
      failureCode: null,
    });
    expect(await previewOfBot(bot)).toBe('Rotina “Resumo diário” concluída');
  });

  it('corta em 120 caracteres (reticências incluídas, emoji contando 1) e só o começo da resposta sai do banco', async () => {
    const bot = await fresh('corte');
    await say(bot, 'answer', `${'palavra '.repeat(40)}fim`);
    const cut = (await previewOfBot(bot)) ?? '';
    expect(Array.from(cut)).toHaveLength(120);
    expect(cut.endsWith('…')).toBe(true);
    await say(bot, 'answer', '😀'.repeat(200));
    expect(await previewOfBot(bot)).toBe(`${'😀'.repeat(119)}…`);
    // Uma resposta gigante cujo começo é só marcação não derruba a lista nem vaza o resto: o texto lido do banco é limitado.
    await say(bot, 'answer', `${'-'.repeat(5_000)}\nnunca aparece`);
    expect(await previewOfBot(bot)).toBe('Nenhuma mensagem ainda');
  });

  it('o bot arquivado também traz a prévia, e a bolinha de não lido segue a mesma regra de novidade', async () => {
    const bot = await fresh('arquivado');
    await say(bot, 'answer', 'Última fala antes de arquivar.');
    await service.archive(bot.id, ORIGIN);
    const item = (await service.list()).find((candidate) => candidate.id === bot.id);
    expect(item).toMatchObject({ preview: 'Última fala antes de arquivar.', unread: true, archivedAt: expect.any(String) });
  });

  it('a lista toda sai numa consulta só, com vários bots e mensagens (sem uma chamada por bot) e sem escrever nada no console', async () => {
    const withNews = await Promise.all(['a', 'b', 'c', 'd'].map((letter) => fresh(`lote ${letter}`)));
    for (const [index, bot] of withNews.entries()) {
      await say(bot, 'answer', `Resposta do lote ${index}`);
      if (index % 2 === 0) await say(bot, 'card', '', failedCard);
    }
    const query = vi.spyOn(pool, 'query');
    const consoleCalls = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    try {
      const listed = await service.list();
      expect(listed.length).toBeGreaterThanOrEqual(withNews.length);
      expect(query).toHaveBeenCalledTimes(1);
      for (const spy of consoleCalls) expect(spy).not.toHaveBeenCalled();
    } finally {
      query.mockRestore();
      for (const spy of consoleCalls) spy.mockRestore();
    }
    const previews = Object.fromEntries((await service.list()).filter((item) => item.name.startsWith('Prévia lote')).map((item) => [item.name, item.preview]));
    expect(previews).toEqual({
      'Prévia lote a': 'A execução falhou',
      'Prévia lote b': 'Resposta do lote 1',
      'Prévia lote c': 'A execução falhou',
      'Prévia lote d': 'Resposta do lote 3',
    });
  });
});

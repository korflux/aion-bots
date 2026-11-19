// Prova do serviço de chaves de terceiros (T3) contra PostgreSQL real e servidores HTTP falsos locais do OpenCode Go
// e do Composio: a chave é validada antes de gravar, fica cifrada, só aparece mascarada, a troca nunca descarta a
// chave anterior antes de validar a nova, e nada (banco, auditoria, erros) guarda ou repete a chave em claro.
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { DomainError } from '../errors';
import { createLogger } from '../logging';
import { openSecret } from '../crypto/secret-box';
import { migrateTestDatabase } from '../testing/migrate';
import { createPool, type Pool } from '../db/pool';
import { createTestDatabase, type TestDatabase } from '../testing/postgres';
import { startFakeUpstreams, type FakeUpstreams } from '../testing/fake-upstreams';
import { createAnthropicClient } from './anthropic';
import { createComposioClient } from './composio';
import { createOpenCodeGoClient } from './opencode-go';
import { createParallelClient } from './parallel';
import { CredentialService, KEY_REMOVALS_PER_MINUTE, KEY_VALIDATIONS_PER_MINUTE, maskSecret } from './service';

const MASTER_KEY = Buffer.alloc(32, 3);
const ORIGIN = { ip: '203.0.113.9', userAgent: 'teste' };

let database: TestDatabase;
let pool: Pool;
let upstreams: FakeUpstreams;
/** Relógio controlado pelo teste (o limitador de taxa usa o mesmo). */
let clock: Date;

const logLines: string[] = [];
const logger = createLogger({ level: 'info', name: 'test', destination: { write: (line) => void logLines.push(line) } });

function createService(masterKey = MASTER_KEY): CredentialService {
  return new CredentialService({
    pool,
    masterKey,
    provider: createOpenCodeGoClient({ baseUrl: upstreams.opencodeGoBaseUrl, timeoutMs: 2_000 }),
    anthropic: createAnthropicClient({ baseUrl: upstreams.anthropicBaseUrl, timeoutMs: 2_000 }),
    connector: createComposioClient({ baseUrl: upstreams.composioBaseUrl, timeoutMs: 2_000 }),
    webSearch: createParallelClient({ baseUrl: upstreams.parallelBaseUrl, timeoutMs: 2_000, logger }),
    logger,
    now: () => clock,
  });
}

beforeAll(async () => {
  database = await createTestDatabase(inject('adminDatabaseUrl'));
  pool = createPool(database.url, { applicationName: 'credentials-test', max: 4 });
  await migrateTestDatabase(pool);
  upstreams = await startFakeUpstreams();
});

afterAll(async () => {
  await upstreams.stop();
  await pool.end();
  await database.drop();
});

beforeEach(async () => {
  clock = new Date('2026-09-30T12:00:00Z');
  upstreams.requests.length = 0;
  await pool.query('TRUNCATE credentials, audit_log');
});

/** Tudo que o banco guarda sobre as chaves e a auditoria, como texto, para provar que a chave em claro não está lá. */
async function dumpStoredText(): Promise<string> {
  const credentials = await pool.query('SELECT to_jsonb(c) AS row FROM credentials c');
  const audit = await pool.query('SELECT to_jsonb(a) AS row FROM audit_log a');
  return JSON.stringify([credentials.rows, audit.rows]);
}

const expectDomainError = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
  return error as DomainError;
};

describe('maskSecret', () => {
  it('mostra os 4 últimos caracteres e, em chaves curtas, no máximo um quarto dela', () => {
    expect(maskSecret('sk-abcdefghij1234')).toBe('••••1234');
    expect(maskSecret('abcdefgh')).toBe('••••gh');
    expect(maskSecret('abc')).toBe('••••');
    expect(maskSecret('x')).toBe('••••');
  });
});

describe('provedor OpenCode Go', () => {
  it('jornada: recusa chave inválida, salva cifrada, substitui só após validar a nova e desconecta', async () => {
    const service = createService();
    const firstKey = 'valid-provider-key-1111';
    const secondKey = 'valid-provider-key-2222';

    // Não configurado de início.
    expect((await service.overview()).provider).toEqual({
      kind: 'provider',
      configured: false,
      masked: null,
      updatedAt: null,
      modelCount: null,
    });

    // Chave recusada pelo provedor: nada é gravado.
    const invalid = await expectDomainError(service.save('provider', 'invalid-provider-key-0000', ORIGIN), 'PROVIDER_KEY_INVALID');
    expect(JSON.stringify(invalid)).not.toContain('invalid-provider-key-0000');
    expect((await pool.query('SELECT 1 FROM credentials')).rowCount).toBe(0);
    // R8 (A3): como no provedor real, a listagem pública de modelos aceita qualquer texto e só o chat recusa a chave. Quem barra
    // aqui é a sonda de chat: sem ela, esta chave inventada seria gravada e exibida como "Conectado".
    await expectDomainError(service.save('provider', 'ghost-provider-key-0000', ORIGIN), 'PROVIDER_KEY_INVALID');
    expect((await pool.query('SELECT 1 FROM credentials')).rowCount).toBe(0);

    // Chave válida: estado mascarado com o total de modelos; banco guarda só o texto cifrado.
    const saved = await service.save('provider', firstKey, ORIGIN);
    expect(saved).toMatchObject({ kind: 'provider', configured: true, masked: '••••1111', modelCount: 14 });
    const stored = await pool.query<{ secret_sealed: string; masked: string }>('SELECT secret_sealed, masked FROM credentials');
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.secret_sealed).toMatch(/^v1\./);
    expect(openSecret(MASTER_KEY, 'provider-key', stored.rows[0]!.secret_sealed)).toBe(firstKey);
    // A cifra é presa à finalidade: o texto do provedor não abre como chave de conector.
    expect(() => openSecret(MASTER_KEY, 'connector-key', stored.rows[0]!.secret_sealed)).toThrow();
    expect(await service.revealKey('provider')).toBe(firstKey);

    // Substituição com chave recusada ou provedor fora do ar: a anterior continua intacta e utilizável.
    await expectDomainError(service.save('provider', 'invalid-provider-key-9999', ORIGIN), 'PROVIDER_KEY_INVALID');
    await expectDomainError(service.save('provider', 'down-provider-key-9999', ORIGIN), 'PROVIDER_UNAVAILABLE');
    await expectDomainError(service.save('provider', 'html-provider-key-9999', ORIGIN), 'PROVIDER_UNAVAILABLE');
    expect((await service.overview()).provider.masked).toBe('••••1111');
    expect(await service.revealKey('provider')).toBe(firstKey);
    // As tentativas chegaram mesmo ao provedor: a validação é anterior à gravação.
    expect(upstreams.requests.map((r) => `${r.method} ${r.path.split('/').pop()} ${r.key}`)).toEqual([
      'GET models invalid-provider-key-0000', // a listagem recusa e a sonda nem roda
      'GET models ghost-provider-key-0000', // a listagem pública aceita...
      'POST completions ghost-provider-key-0000', // ...e a sonda de chat recusa
      'GET models valid-provider-key-1111',
      'POST completions valid-provider-key-1111', // chave válida: listagem e UMA sonda de chat
      'GET models invalid-provider-key-9999',
      'GET models down-provider-key-9999',
      'GET models html-provider-key-9999',
    ]);

    // Substituição válida: só então a nova vale, e o estado mostra o novo sufixo.
    clock = new Date('2026-09-30T12:05:00Z');
    const replaced = await service.save('provider', secondKey, ORIGIN);
    expect(replaced.masked).toBe('••••2222');
    expect(replaced.updatedAt).toBe('2026-09-30T12:05:00.000Z');
    expect(await service.revealKey('provider')).toBe(secondKey);
    expect((await pool.query('SELECT 1 FROM credentials')).rowCount).toBe(1);

    // Desconectar apaga; repetir é inofensivo e não gera auditoria extra.
    await service.disconnect('provider', ORIGIN);
    expect(await service.revealKey('provider')).toBeNull();
    expect((await service.overview()).provider.configured).toBe(false);
    await service.disconnect('provider', ORIGIN);
    await expectDomainError(service.requireKey('provider'), 'PROVIDER_NOT_CONFIGURED');

    // Auditoria: a troca traz as versões mascaradas (nova e anterior); recusas registram só o código.
    const audit = await pool.query<{ action: string; outcome: string; target: string; details: Record<string, unknown> }>(
      'SELECT action, outcome, target, details FROM audit_log ORDER BY id',
    );
    expect(audit.rows.map((row) => [row.action, row.outcome, row.details])).toEqual([
      ['credential.save', 'failure', { code: 'PROVIDER_KEY_INVALID' }],
      ['credential.save', 'failure', { code: 'PROVIDER_KEY_INVALID' }],
      ['credential.save', 'success', { masked: '••••1111', previousMasked: null, replaced: false }],
      ['credential.save', 'failure', { code: 'PROVIDER_KEY_INVALID' }],
      ['credential.save', 'failure', { code: 'PROVIDER_UNAVAILABLE' }],
      ['credential.save', 'failure', { code: 'PROVIDER_UNAVAILABLE' }],
      ['credential.save', 'success', { masked: '••••2222', previousMasked: '••••1111', replaced: true }],
      ['credential.disconnect', 'success', { masked: '••••2222' }],
    ]);
    expect(audit.rows.every((row) => row.target === 'provider')).toBe(true);

    // Nenhuma chave em claro no banco, na auditoria nem no log.
    const everything = `${await dumpStoredText()}\n${logLines.join('\n')}`;
    for (const key of [firstKey, secondKey, 'invalid-provider-key-0000', 'ghost-provider-key-0000', 'invalid-provider-key-9999', 'down-provider-key-9999']) {
      expect(everything).not.toContain(key);
    }
  });

  it('o corpo de erro do serviço externo, mesmo ecoando a chave, nunca chega ao erro do domínio', async () => {
    const service = createService();
    const error = await expectDomainError(service.save('provider', 'leaky-provider-key-7777', ORIGIN), 'PROVIDER_KEY_INVALID');
    expect(`${error.message} ${JSON.stringify(error)} ${String(error.stack)}`).not.toContain('leaky-provider-key-7777');
    expect(logLines.join('\n')).not.toContain('leaky-provider-key-7777');
  });

  it('chave mestra trocada: a chave guardada não abre e vira erro interno sem vazar nada', async () => {
    await createService().save('provider', 'valid-provider-key-3333', ORIGIN);
    const otherMaster = createService(Buffer.alloc(32, 4));
    const error = await expectDomainError(otherMaster.revealKey('provider'), 'INTERNAL_ERROR');
    expect(error.message).toBe('INTERNAL_ERROR');
    // O dono ainda consegue recuperar substituindo a chave.
    const recovered = await otherMaster.save('provider', 'valid-provider-key-4444', ORIGIN);
    expect(recovered.masked).toBe('••••4444');
    expect(await otherMaster.revealKey('provider')).toBe('valid-provider-key-4444');
  });
});

describe('conector Composio', () => {
  it('jornada: salva, lista as contas com o estado de cada uma, mostra a lista vazia sem contas e desconecta', async () => {
    const service = createService();

    // Sem chave não há lista: erro de "não configurado", sem chamada externa.
    await expectDomainError(service.listConnectorAccounts(), 'CONNECTOR_NOT_CONFIGURED');
    expect(upstreams.requests).toHaveLength(0);

    // Chave válida, mas o Composio não tem nenhuma conta conectada: salva e a lista de contas vem vazia.
    const saved = await service.save('connector', 'noapps-connector-key-1234', ORIGIN);
    expect(saved).toMatchObject({ kind: 'connector', configured: true, masked: '••••1234', modelCount: null });
    expect(await service.listConnectorAccounts()).toEqual([]);

    // Recusas não mexem na chave salva.
    await expectDomainError(service.save('connector', 'invalid-connector-key-0000', ORIGIN), 'CONNECTOR_KEY_INVALID');
    await expectDomainError(service.save('connector', 'down-connector-key-0000', ORIGIN), 'CONNECTOR_UNAVAILABLE');
    expect(await service.revealKey('connector')).toBe('noapps-connector-key-1234');

    // Troca por uma chave com contas: uma linha por conta (as linhas e o estado de cada uma estão no teste seguinte; a leitura por app, do cliente, em `clients.test.ts`).
    await service.save('connector', 'valid-connector-key-5678', ORIGIN);
    expect(await service.listConnectorAccounts()).toHaveLength(6);
    // A lista é lida ao vivo com a chave guardada (decifrada), não com a digitada antes.
    expect(upstreams.requests.at(-1)).toMatchObject({ service: 'composio', path: '/composio/api/v3/connected_accounts', key: 'valid-connector-key-5678' });

    // Desconectar: nenhum consumidor recebe mais a chave do conector.
    await service.disconnect('connector', ORIGIN);
    expect(await service.revealKey('connector')).toBeNull();
    await expectDomainError(service.requireKey('connector'), 'CONNECTOR_NOT_CONFIGURED');

    const everything = `${await dumpStoredText()}\n${logLines.join('\n')}`;
    for (const key of ['noapps-connector-key-1234', 'valid-connector-key-5678', 'invalid-connector-key-0000']) {
      expect(everything).not.toContain(key);
    }
  });

  it('lista todas as contas do Composio com a chave guardada, uma por conta (os dois Gmail separados) e com o estado de cada uma, sem a chave na resposta (phase 13)', async () => {
    const service = createService();
    await expectDomainError(service.listConnectorAccounts(), 'CONNECTOR_NOT_CONFIGURED');
    expect(upstreams.requests).toHaveLength(0);

    await service.save('connector', 'valid-connector-key-7878', ORIGIN);
    const accounts = await service.listConnectorAccounts();
    expect(accounts.map((account) => [account.id, account.toolkitSlug, account.status])).toEqual([
      ['ca_1', 'gmail', 'active'],
      ['ca_2', 'github', 'pending'],
      ['ca_3', 'github', 'active'],
      ['ca_4', 'google_calendar', 'pending'],
      ['ca_5', 'slack', 'attention'],
      ['ca_6', 'gmail', 'active'],
    ]);
    // Lida ao vivo com a chave guardada (decifrada), e a chave nunca sai na resposta.
    expect(upstreams.requests.at(-1)).toMatchObject({ service: 'composio', path: '/composio/api/v3/connected_accounts', key: 'valid-connector-key-7878' });
    expect(JSON.stringify(accounts)).not.toContain('valid-connector-key-7878');
  });

  it('as duas chaves são independentes: salvar uma não altera a outra', async () => {
    const service = createService();
    await service.save('provider', 'valid-provider-key-1212', ORIGIN);
    await service.save('connector', 'valid-connector-key-3434', ORIGIN);
    await service.disconnect('provider', ORIGIN);
    const overview = await service.overview();
    expect(overview.provider.configured).toBe(false);
    expect(overview.connector).toMatchObject({ configured: true, masked: '••••3434' });
    expect(await service.revealKey('connector')).toBe('valid-connector-key-3434');
  });
});

describe('chave opcional da pesquisa na web (Parallel)', () => {
  it('jornada: valida com uma pesquisa mínima, grava cifrada, substitui só após validar e desconecta, com auditoria sem a chave', async () => {
    const service = createService();
    const firstKey = 'valid-parallel-key-1111';
    const secondKey = 'stream-parallel-key-2222'; // a Parallel falsa responde esta em stream de eventos: o resultado é o mesmo

    // Sem chave: nível anônimo. O estado vem de `statusOf` (a visão geral só traz as duas chaves obrigatórias) e nada é chamado fora.
    expect(await service.statusOf('web_search')).toEqual({ kind: 'web_search', configured: false, masked: null, updatedAt: null, modelCount: null });
    expect(Object.keys(await service.overview()).sort()).toEqual(['anthropic', 'connector', 'provider']);
    expect(await service.revealKey('web_search')).toBeNull();
    expect(upstreams.requests).toHaveLength(0);

    // Recusas não gravam nada, e o corpo de erro do serviço (que ecoa a chave) não vaza.
    const invalid = await expectDomainError(service.save('web_search', 'invalid-parallel-key-0000', ORIGIN), 'WEB_SEARCH_KEY_INVALID');
    await expectDomainError(service.save('web_search', 'forbidden-parallel-key-0000', ORIGIN), 'WEB_SEARCH_KEY_INVALID');
    const leaky = await expectDomainError(service.save('web_search', 'leaky-parallel-key-0000', ORIGIN), 'WEB_SEARCH_KEY_INVALID');
    expect(`${invalid.message} ${JSON.stringify(leaky)} ${String(leaky.stack)}`).not.toContain('leaky-parallel-key-0000');
    expect((await pool.query('SELECT 1 FROM credentials')).rowCount).toBe(0);

    // Chave válida: estado mascarado sem total de modelos; o banco guarda só o texto cifrado, preso à finalidade da pesquisa.
    const saved = await service.save('web_search', firstKey, ORIGIN);
    expect(saved).toMatchObject({ kind: 'web_search', configured: true, masked: '••••1111', modelCount: null });
    const stored = await pool.query<{ kind: string; secret_sealed: string }>('SELECT kind, secret_sealed FROM credentials');
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.kind).toBe('web_search');
    expect(openSecret(MASTER_KEY, 'web-search-key', stored.rows[0]!.secret_sealed)).toBe(firstKey);
    expect(() => openSecret(MASTER_KEY, 'provider-key', stored.rows[0]!.secret_sealed)).toThrow();
    expect(await service.revealKey('web_search')).toBe(firstKey);
    expect(await service.statusOf('web_search')).toMatchObject({ configured: true, masked: '••••1111' });
    // A visão geral das chaves obrigatórias não é afetada pela chave opcional.
    expect((await service.overview()).provider.configured).toBe(false);
    expect((await service.overview()).connector.configured).toBe(false);
    // A validação foi UMA pesquisa por JSON-RPC com a chave no Bearer; só objetivo e consulta saíram.
    expect(upstreams.requests.at(-1)).toMatchObject({ service: 'parallel', method: 'POST', key: firstKey, body: { method: 'tools/call', params: { name: 'web_search', arguments: { objective: expect.any(String), search_queries: [expect.any(String)] } } } });

    // Substituição com chave recusada ou serviço fora do ar: a anterior continua intacta e utilizável.
    await expectDomainError(service.save('web_search', 'invalid-parallel-key-9999', ORIGIN), 'WEB_SEARCH_KEY_INVALID');
    await expectDomainError(service.save('web_search', 'down-parallel-key-9999', ORIGIN), 'WEB_SEARCH_UNAVAILABLE');
    await expectDomainError(service.save('web_search', 'limited-parallel-key-9999', ORIGIN), 'WEB_SEARCH_UNAVAILABLE');
    await expectDomainError(service.save('web_search', 'drop-parallel-key-9999', ORIGIN), 'WEB_SEARCH_UNAVAILABLE');
    expect((await service.statusOf('web_search')).masked).toBe('••••1111');
    expect(await service.revealKey('web_search')).toBe(firstKey);

    // Substituição válida: só então a nova vale.
    clock = new Date('2026-09-30T12:05:00Z');
    const replaced = await service.save('web_search', secondKey, ORIGIN);
    expect(replaced.masked).toBe('••••2222');
    expect(replaced.updatedAt).toBe('2026-09-30T12:05:00.000Z');
    expect(await service.revealKey('web_search')).toBe(secondKey);
    expect((await pool.query('SELECT 1 FROM credentials')).rowCount).toBe(1);

    // Desconectar apaga e volta ao anônimo; repetir é inofensivo e não gera auditoria extra.
    await service.disconnect('web_search', ORIGIN);
    expect(await service.revealKey('web_search')).toBeNull();
    expect((await service.statusOf('web_search')).configured).toBe(false);
    await service.disconnect('web_search', ORIGIN);

    // Auditoria: salvar, substituir e desconectar com a chave só mascarada; recusas registram só o código.
    const audit = await pool.query<{ action: string; outcome: string; target: string; details: Record<string, unknown> }>('SELECT action, outcome, target, details FROM audit_log ORDER BY id');
    expect(audit.rows.map((row) => [row.action, row.outcome, row.details])).toEqual([
      ['credential.save', 'failure', { code: 'WEB_SEARCH_KEY_INVALID' }],
      ['credential.save', 'failure', { code: 'WEB_SEARCH_KEY_INVALID' }],
      ['credential.save', 'failure', { code: 'WEB_SEARCH_KEY_INVALID' }],
      ['credential.save', 'success', { masked: '••••1111', previousMasked: null, replaced: false }],
      ['credential.save', 'failure', { code: 'WEB_SEARCH_KEY_INVALID' }],
      ['credential.save', 'failure', { code: 'WEB_SEARCH_UNAVAILABLE' }],
      ['credential.save', 'failure', { code: 'WEB_SEARCH_UNAVAILABLE' }],
      ['credential.save', 'failure', { code: 'WEB_SEARCH_UNAVAILABLE' }],
      ['credential.save', 'success', { masked: '••••2222', previousMasked: '••••1111', replaced: true }],
      ['credential.disconnect', 'success', { masked: '••••2222' }],
    ]);
    expect(audit.rows.every((row) => row.target === 'web_search')).toBe(true);

    // Nenhuma chave em claro no banco, na auditoria nem no log.
    const everything = `${await dumpStoredText()}\n${logLines.join('\n')}`;
    for (const key of [firstKey, secondKey, 'invalid-parallel-key-0000', 'forbidden-parallel-key-0000', 'leaky-parallel-key-0000', 'down-parallel-key-9999', 'limited-parallel-key-9999', 'drop-parallel-key-9999']) {
      expect(everything).not.toContain(key);
    }
  });

  it('é independente das outras chaves, e a chave do provedor nunca abre como a da pesquisa', async () => {
    const service = createService();
    await service.save('provider', 'valid-provider-key-1212', ORIGIN);
    await service.save('web_search', 'valid-parallel-key-3434', ORIGIN);
    await service.disconnect('provider', ORIGIN);
    expect(await service.revealKey('web_search')).toBe('valid-parallel-key-3434');
    expect(await service.revealKey('provider')).toBeNull();
    // Sem chave obrigatória configurada, o erro de "não configurado" continua só para provedor e conector.
    await expectDomainError(service.requireKey('provider'), 'PROVIDER_NOT_CONFIGURED');
    // Um tipo fora da lista nunca chega à tabela (restrição da migration 0017).
    await expect(pool.query("INSERT INTO credentials (kind, secret_sealed, masked, created_at, updated_at) VALUES ('outro', 'x', '••', now(), now())")).rejects.toThrow();
  });
});

describe('chave da Anthropic (phase 17, SEC-08)', () => {
  const FIRST = 'valid-anthropic-AAAA';
  const SECOND = 'valid-anthropic-BBBB';

  /** Serviço cuja Anthropic lista os modelos no servidor falso e responde ao chat do jeito dado (recusa 4xx, stream quebrado ou 5xx). */
  function createServiceWithChat(chat: () => Response): CredentialService {
    const fetchImpl: typeof fetch = (input, init) => (String(input).endsWith('/messages') ? Promise.resolve(chat()) : fetch(input, init));
    return new CredentialService({
      pool,
      masterKey: MASTER_KEY,
      provider: createOpenCodeGoClient({ baseUrl: upstreams.opencodeGoBaseUrl, timeoutMs: 2_000 }),
      anthropic: createAnthropicClient({ baseUrl: upstreams.anthropicBaseUrl, timeoutMs: 2_000, fetchImpl }),
      connector: createComposioClient({ baseUrl: upstreams.composioBaseUrl, timeoutMs: 2_000 }),
      webSearch: createParallelClient({ baseUrl: upstreams.parallelBaseUrl, timeoutMs: 2_000, logger }),
      logger,
      now: () => clock,
    });
  }

  it('A1: sem chave de início; a válida é provada (listagem e UMA chamada mínima ao Haiku pelo messages), gravada cifrada e só aparece mascarada', async () => {
    const service = createService();
    expect((await service.overview()).anthropic).toEqual({ kind: 'anthropic', configured: false, masked: null, updatedAt: null, modelCount: null });

    const saved = await service.save('anthropic', FIRST, ORIGIN);
    expect(saved).toEqual({ kind: 'anthropic', configured: true, masked: '••••AAAA', updatedAt: '2026-09-30T12:00:00.000Z', modelCount: 8 });
    // A prova: a listagem e uma chamada de chat ao Haiku (id local, sem o prefixo do produto), 16 tokens, só com a chave da Anthropic.
    expect(upstreams.requests.map((request) => `${request.service} ${request.method} ${request.path.split('/').pop()} ${request.key}`)).toEqual([
      `anthropic GET models ${FIRST}`,
      `anthropic POST messages ${FIRST}`,
    ]);
    expect(upstreams.requests.at(-1)).toMatchObject({ model: 'claude-haiku-5-5', body: expect.objectContaining({ max_tokens: 16 }) });
    // Banco: só o texto cifrado com a finalidade própria (não abre como a chave do OpenCode Go) e a máscara.
    const stored = await pool.query<{ secret_sealed: string; masked: string }>("SELECT secret_sealed, masked FROM credentials WHERE kind = 'anthropic'");
    expect(openSecret(MASTER_KEY, 'anthropic-key', stored.rows[0]!.secret_sealed)).toBe(FIRST);
    expect(() => openSecret(MASTER_KEY, 'provider-key', stored.rows[0]!.secret_sealed)).toThrow();
    expect(stored.rows[0]!.masked).toBe('••••AAAA');
    expect(await service.revealKey('anthropic')).toBe(FIRST);
    expect((await service.overview()).anthropic).toMatchObject({ configured: true, masked: '••••AAAA', modelCount: 8 });
    // É independente das outras: o OpenCode Go segue sem chave.
    expect((await service.overview()).provider.configured).toBe(false);
  });

  it('A2: chave recusada, serviço fora do ar, prova recusada ou stream quebrado dão erro seguro e a chave anterior fica intacta', async () => {
    const service = createService();
    await service.save('anthropic', FIRST, ORIGIN);
    const requests = upstreams.requests.length;

    const invalid = await expectDomainError(service.save('anthropic', 'invalid-anthropic-0001', ORIGIN), 'PROVIDER_KEY_INVALID');
    expect(JSON.stringify(invalid)).not.toContain('invalid-anthropic-0001');
    await expectDomainError(service.save('anthropic', 'forbidden-anthropic-0002', ORIGIN), 'PROVIDER_KEY_INVALID');
    await expectDomainError(service.save('anthropic', 'down-anthropic-0003', ORIGIN), 'PROVIDER_UNAVAILABLE');
    await expectDomainError(service.save('anthropic', 'html-anthropic-0004', ORIGIN), 'PROVIDER_UNAVAILABLE');
    await expectDomainError(service.save('anthropic', 'limited-anthropic-0005', ORIGIN), 'PROVIDER_UNAVAILABLE');
    // A listagem aceita a chave, mas a chamada de prova é recusada (4xx do pedido) ou chega quebrada: nada é gravado.
    const refusing = createServiceWithChat(() => Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'sua chave ecoada: valid-anthropic-CCCC' } }, { status: 400 }));
    await expectDomainError(refusing.save('anthropic', 'valid-anthropic-CCCC', ORIGIN), 'PROVIDER_KEY_INVALID');
    const broken = createServiceWithChat(() => new Response('data: isto não é json\n\n', { status: 200 }));
    await expectDomainError(broken.save('anthropic', 'valid-anthropic-DDDD', ORIGIN), 'PROVIDER_UNAVAILABLE');
    const overloaded = createServiceWithChat(() => Response.json({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, { status: 529 }));
    await expectDomainError(overloaded.save('anthropic', 'valid-anthropic-EEEE', ORIGIN), 'PROVIDER_UNAVAILABLE');

    // A anterior continua gravada e utilizável, e nenhuma tentativa recusada deixou linha nem chave no banco.
    expect((await service.overview()).anthropic.masked).toBe('••••AAAA');
    expect(await service.revealKey('anthropic')).toBe(FIRST);
    expect((await pool.query('SELECT 1 FROM credentials')).rowCount).toBe(1);
    expect(upstreams.requests.length).toBeGreaterThan(requests); // as tentativas chegaram mesmo à Anthropic: a validação é anterior à gravação
    const failures = await pool.query<{ details: Record<string, unknown> }>("SELECT details FROM audit_log WHERE outcome = 'failure' ORDER BY id");
    expect(failures.rows.map((row) => row.details)).toEqual([
      { code: 'PROVIDER_KEY_INVALID' }, { code: 'PROVIDER_KEY_INVALID' }, { code: 'PROVIDER_UNAVAILABLE' }, { code: 'PROVIDER_UNAVAILABLE' }, { code: 'PROVIDER_UNAVAILABLE' },
      { code: 'PROVIDER_KEY_INVALID' }, { code: 'PROVIDER_UNAVAILABLE' }, { code: 'PROVIDER_UNAVAILABLE' },
    ]);
  });

  it('A20: salvar uma chave sem saldo falha com PROVIDER_CREDITS_EXHAUSTED sem gravar (a anterior segue), e salvar uma chave que passa limpa o estado de saldo esgotado', async () => {
    const service = createService();
    await service.save('anthropic', FIRST, ORIGIN);
    await pool.query("UPDATE credentials SET credits_exhausted_at = now() WHERE kind = 'anthropic'");

    const refused = await expectDomainError(service.save('anthropic', 'nobalance-anthropic-0001', ORIGIN), 'PROVIDER_CREDITS_EXHAUSTED');
    expect(JSON.stringify(refused)).not.toContain('nobalance-anthropic-0001');
    // Nada mudou: a chave anterior continua, e a recusa por saldo não mexeu no estado da chave salva (só a chamada com a chave SALVA o altera).
    expect(await service.revealKey('anthropic')).toBe(FIRST);
    expect((await pool.query("SELECT credits_exhausted_at IS NOT NULL AS exhausted FROM credentials WHERE kind = 'anthropic'")).rows).toEqual([{ exhausted: true }]);
    const failures = await pool.query<{ details: Record<string, unknown> }>("SELECT details FROM audit_log WHERE action = 'credential.save' AND outcome = 'failure' ORDER BY id");
    expect(failures.rows.map((row) => row.details)).toEqual([{ code: 'PROVIDER_CREDITS_EXHAUSTED' }]);

    // Uma chave nova que passa na prova libera o estado (a chave de antes ficou sem saldo; a nova pode ter).
    await service.save('anthropic', SECOND, ORIGIN);
    expect((await pool.query("SELECT credits_exhausted_at FROM credentials WHERE kind = 'anthropic'")).rows).toEqual([{ credits_exhausted_at: null }]);
  });

  it('A3 e A4: troca e remoção são auditadas só com a máscara, depois de remover nenhuma chamada sai com a chave, e nada (banco, auditoria, log, erro) guarda a chave inteira', async () => {
    const service = createService();
    await service.save('anthropic', FIRST, ORIGIN);
    clock = new Date('2026-09-30T12:05:00Z');
    const replaced = await service.save('anthropic', SECOND, ORIGIN);
    expect(replaced).toMatchObject({ masked: '••••BBBB', updatedAt: '2026-09-30T12:05:00.000Z' });
    expect(await service.revealKey('anthropic')).toBe(SECOND);

    await service.disconnect('anthropic', ORIGIN);
    await service.disconnect('anthropic', ORIGIN); // idempotente e sem auditoria extra
    expect(await service.revealKey('anthropic')).toBeNull();
    await expectDomainError(service.requireKey('anthropic'), 'PROVIDER_NOT_CONFIGURED');
    // Nenhuma chamada sai com a chave removida: ler o estado e pedir a chave não consulta a Anthropic.
    const before = upstreams.requests.length;
    await service.overview();
    await service.statusOf('anthropic');
    await service.revealKey('anthropic');
    expect(upstreams.requests).toHaveLength(before);

    const audit = await pool.query<{ action: string; outcome: string; target: string; details: Record<string, unknown> }>('SELECT action, outcome, target, details FROM audit_log ORDER BY id');
    expect(audit.rows.map((row) => [row.action, row.outcome, row.target, row.details])).toEqual([
      ['credential.save', 'success', 'anthropic', { masked: '••••AAAA', previousMasked: null, replaced: false }],
      ['credential.save', 'success', 'anthropic', { masked: '••••BBBB', previousMasked: '••••AAAA', replaced: true }],
      ['credential.disconnect', 'success', 'anthropic', { masked: '••••BBBB' }],
    ]);
    const leaky = await expectDomainError(service.save('anthropic', 'leaky-anthropic-9999', ORIGIN), 'PROVIDER_KEY_INVALID');
    const everything = `${await dumpStoredText()}\n${logLines.join('\n')}\n${leaky.message} ${JSON.stringify(leaky)} ${String(leaky.stack)}`;
    for (const key of [FIRST, SECOND, 'leaky-anthropic-9999']) expect(everything).not.toContain(key);
  });

  it('A5: o limite de validações por minuto é o mesmo das outras chaves: acima dele a recusa é auditada como denied, não chega à Anthropic e nada é gravado', async () => {
    const service = createService();
    for (let attempt = 0; attempt < KEY_VALIDATIONS_PER_MINUTE; attempt += 1) {
      await expectDomainError(service.save('anthropic', `invalid-anthropic-${attempt}`, ORIGIN), 'PROVIDER_KEY_INVALID');
    }
    const requests = upstreams.requests.length;
    await expectDomainError(service.save('anthropic', FIRST, ORIGIN), 'RATE_LIMITED');
    await expectDomainError(service.save('provider', 'valid-provider-key-1234', ORIGIN), 'RATE_LIMITED'); // UM limite só para todas as chaves
    expect(upstreams.requests).toHaveLength(requests);
    expect((await pool.query('SELECT 1 FROM credentials')).rowCount).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE outcome = 'denied'")).rows[0]).toEqual({ n: 2 });
  });
});

describe('limite de remoções', () => {
  it('A5: remover tem limite próprio por minuto: acima dele a recusa é RATE_LIMITED, não apaga nada e fica auditada como denied; a janela libera depois de um minuto e salvar não é afetado', async () => {
    const service = createService();
    await service.save('provider', 'valid-provider-key-6666', ORIGIN);
    await service.save('anthropic', 'valid-anthropic-6666', ORIGIN);
    // Cada remoção conta, inclusive a de uma chave que não existe (idempotente): 60 delas gastam o limite sem tocar nas chaves salvas.
    for (let attempt = 0; attempt < KEY_REMOVALS_PER_MINUTE; attempt += 1) await service.disconnect('web_search', ORIGIN);
    clock = new Date(clock.getTime() + 20_000);
    for (const kind of ['provider', 'anthropic'] as const) {
      const limited = await expectDomainError(service.disconnect(kind, ORIGIN), 'RATE_LIMITED');
      expect(limited.retryAfterSeconds).toBe(40);
    }
    // Nada foi apagado e as recusas ficaram na auditoria só com o tipo da chave e o código.
    expect((await service.overview())).toMatchObject({ provider: { configured: true, masked: '••••6666' }, anthropic: { configured: true, masked: '••••6666' } });
    const denied = await pool.query<{ target: string; details: Record<string, unknown> }>("SELECT target, details FROM audit_log WHERE action = 'credential.disconnect' AND outcome = 'denied' ORDER BY id");
    expect(denied.rows).toEqual([{ target: 'provider', details: { code: 'RATE_LIMITED' } }, { target: 'anthropic', details: { code: 'RATE_LIMITED' } }]);
    // Salvar tem o limite dele: remover em excesso não o consome.
    expect((await service.save('provider', 'valid-provider-key-7777', ORIGIN)).masked).toBe('••••7777');

    clock = new Date(clock.getTime() + 41_000);
    await service.disconnect('anthropic', ORIGIN);
    expect((await service.overview()).anthropic.configured).toBe(false);
    expect((await service.overview()).provider.configured).toBe(true);
  });
});

describe('limite de validações', () => {
  it('10 por minuto: a 11ª é recusada sem chamar o serviço externo, e a janela libera depois de um minuto', async () => {
    const service = createService();
    for (let attempt = 0; attempt < KEY_VALIDATIONS_PER_MINUTE; attempt += 1) {
      await expectDomainError(service.save('provider', `invalid-key-${attempt}`, ORIGIN), 'PROVIDER_KEY_INVALID');
    }
    expect(upstreams.requests).toHaveLength(KEY_VALIDATIONS_PER_MINUTE);

    clock = new Date(clock.getTime() + 20_000);
    const limited = await expectDomainError(service.save('provider', 'valid-provider-key-5555', ORIGIN), 'RATE_LIMITED');
    // A primeira tentativa da janela saiu há 20 s: faltam 40 s para liberar.
    expect(limited.retryAfterSeconds).toBe(40);
    expect(upstreams.requests).toHaveLength(KEY_VALIDATIONS_PER_MINUTE);
    // Vale para as três chaves (UM limite só, inclusive a opcional da pesquisa na web) e a recusa fica na auditoria como "denied".
    await expectDomainError(service.save('connector', 'valid-connector-key-5555', ORIGIN), 'RATE_LIMITED');
    await expectDomainError(service.save('web_search', 'valid-parallel-key-5555', ORIGIN), 'RATE_LIMITED');
    expect(upstreams.requests).toHaveLength(KEY_VALIDATIONS_PER_MINUTE); // nenhuma das recusadas chegou ao serviço externo
    const denied = await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE outcome = 'denied'");
    expect(denied.rows[0]).toEqual({ n: 3 });

    // Ler o estado e a lista de apps não consome o limite.
    await service.overview();

    clock = new Date(clock.getTime() + 41_000);
    const saved = await service.save('provider', 'valid-provider-key-5555', ORIGIN);
    expect(saved.masked).toBe('••••5555');
  });
});

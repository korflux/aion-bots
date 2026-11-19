// Prova do serviço de modelos (A10, F8) contra PostgreSQL real e o provedor falso: o teste da primeira seleção descobre
// protocolo, ferramenta e effort em cada cenário; o resultado é gravado e sobrescrito; favoritos, limite de 10 testes por
// minuto, deduplicação de testes simultâneos, allowlist do catálogo e a validação de modelo e effort de um bot.
import type { ModelEntry } from '@aion/shared';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { resolveContextWindow } from '@aion/shared';
import { createAnthropicClient, type AnthropicClient, type AnthropicModel } from '../credentials/anthropic';
import { createCreditsState } from '../credentials/credits-state';
import { createOpenCodeGoClient, type ProviderClient } from '../credentials/opencode-go';
import { migrateTestDatabase } from '../testing/migrate';
import { createPool, type Pool } from '../db/pool';
import { DomainError } from '../errors';
import { createLogger } from '../logging';
import { startFakeUpstreams, type FakeUpstreams } from '../testing/fake-upstreams';
import { createTestDatabase, type TestDatabase } from '../testing/postgres';
import { contextEnvelope, MAX_OUTPUT_TOKENS } from '../runs/context-budget';
import { readModelContextCapacity } from './context-capacity';
import { CATALOG_TTL_MS, ModelService, createProviderRouter, modelCredentialKind } from './service';

const KEY = 'valid-provider-key-ABCD';

let upstreams: FakeUpstreams;
let database: TestDatabase;
let pool: Pool;
let now = new Date('2026-03-01T12:00:00Z');
const advance = (ms: number) => {
  now = new Date(now.getTime() + ms);
};

/** Serviço sobre o banco da prova; `key` simula a chave guardada (a cifra das chaves é coberta na T3). */
function serviceWith({ key = KEY, testDeadlineMs, provider }: { key?: string | null; testDeadlineMs?: number; provider?: ProviderClient } = {}): ModelService {
  return new ModelService({
    pool,
    credentials: {
      requireKey: async () => {
        if (key === null) throw new DomainError('PROVIDER_NOT_CONFIGURED');
        return key;
      },
    },
    provider: provider ?? createOpenCodeGoClient({ baseUrl: upstreams.opencodeGoBaseUrl, chatTimeoutMs: 5_000 }),
    logger: createLogger({ level: 'silent', name: 'models-test' }),
    now: () => now,
    testDeadlineMs,
  });
}

const code = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    return error instanceof DomainError ? error.code : `UNEXPECTED:${String(error)}`;
  }
};

/** Requisições de chat recebidas depois de `since`, sem as de listagem. */
const chatCalls = (since: number) => upstreams.requests.slice(since).filter((request) => request.method === 'POST');
const storedProfiles = async () =>
  (await pool.query<{ model_id: string; test_status: string | null; test_protocol: string | null; effort_levels: string[] }>(
    'SELECT model_id, test_status, test_protocol, effort_levels FROM model_profiles ORDER BY model_id',
  )).rows;

beforeAll(async () => {
  upstreams = await startFakeUpstreams();
  database = await createTestDatabase(inject('adminDatabaseUrl'));
  pool = createPool(database.url, { applicationName: 'models-test', max: 6 });
  await migrateTestDatabase(pool);
});

afterAll(async () => {
  await pool.end();
  await database.drop();
  await upstreams.stop();
});

describe('teste do modelo: cada cenário do provedor vira o resultado certo', () => {
  it('descobre protocolo, ferramenta e níveis de effort, e grava o resultado (sobrescrevendo o anterior)', async () => {
    const service = serviceWith();
    await pool.query('DELETE FROM model_profiles');

    // Lista: todos os modelos do provedor, em ordem natural, nenhum testado nem favorito.
    const listed = await service.list();
    expect(listed.map((entry) => entry.id)).toEqual([
      'opencode/broken-model', 'opencode/deepseek-v4-pro', 'opencode/deepseek-v4.1-flash', 'opencode/garbled-model', 'opencode/glm-5.1', 'opencode/glm-5.3-flash', 'opencode/grok-4.7', 'opencode/kimi-k2.7-code', 'opencode/mute-model', 'opencode/slow-model', 'opencode/vision-model', 'opencode/vision-reject', 'opencode/vision-unstable', 'opencode/vision-wrong',
    ]);
    expect(listed.every((entry) => !entry.favorite && entry.test === null)).toBe(true);

    // chat/completions com ferramenta e níveis low, medium e high: "Liberado".
    let since = upstreams.requests.length;
    const glm = await service.test('opencode/glm-5.1');
    expect(glm).toMatchObject({ id: 'opencode/glm-5.1', test: { status: 'ok', reason: null, effortLevels: ['low', 'medium', 'high'], testedAt: now.toISOString() } });
    // 1 texto, 1 ferramenta e 6 de effort (um nível inventado de propósito e os 5 conhecidos), todos com a chave certa.
    const glmCalls = chatCalls(since);
    expect(glmCalls).toHaveLength(8);
    expect(glmCalls.every((call) => call.path === '/opencode-go/v1/chat/completions' && call.key === KEY && call.model === 'glm-5.1')).toBe(true);
    expect(glmCalls.filter((call) => call.tools)).toHaveLength(1);
    expect(glmCalls.map((call) => call.effort).filter(Boolean).sort()).toEqual(['aion-nivel-invalido', 'high', 'low', 'max', 'medium', 'xhigh']);

    // messages: descobre o protocolo, recusa o inválido antes das sondas válidas e guarda todos os níveis aceitos.
    since = upstreams.requests.length;
    const kimi = await service.test('opencode/kimi-k2.7-code');
    expect(kimi.test).toMatchObject({ status: 'ok', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] });
    const kimiCalls = chatCalls(since);
    expect(kimiCalls.map((call) => call.path.replace('/opencode-go/v1', ''))).toEqual(['/chat/completions', ...Array<string>(8).fill('/messages')]);
    expect(kimiCalls.filter((call) => call.effort).map((call) => call.effort)).toEqual(['aion-nivel-invalido', 'low', 'medium', 'high', 'xhigh', 'max']);
    for (const call of kimiCalls.filter((call) => call.effort)) expect(call.body?.output_config).toEqual({ effort: call.effort });

    // responses com effort até xhigh.
    const grok = await service.test('opencode/grok-4.7');
    expect(grok.test).toMatchObject({ status: 'ok', effortLevels: ['low', 'medium', 'high', 'xhigh'] });

    // Sem ferramentas: o provedor recusa `tools` (400) ou ignora e responde texto. Em ambos passa em texto e streaming.
    expect((await service.test('opencode/deepseek-v4-pro')).test).toMatchObject({ status: 'no_tools', reason: 'no_tool_call', effortLevels: [] }); // aceita qualquer effort = parâmetro ignorado
    expect((await service.test('opencode/glm-5.3-flash')).test).toMatchObject({ status: 'no_tools', reason: 'no_tool_call', effortLevels: [] }); // recusa todo effort

    // Falhas do modelo: resposta vazia, stream quebrado e nenhum endpoint que o sirva. São resultados, não erros.
    expect((await service.test('opencode/mute-model')).test).toMatchObject({ status: 'failed', reason: 'empty_response', effortLevels: [] });
    expect((await service.test('opencode/garbled-model')).test).toMatchObject({ status: 'failed', reason: 'bad_stream' });
    expect((await service.test('opencode/broken-model')).test).toMatchObject({ status: 'failed', reason: 'unsupported' });

    // O banco guarda o protocolo em que cada um respondeu (a T6 chama o modelo nele) e nada de modelo que não foi testado.
    expect(await storedProfiles()).toEqual([
      { model_id: 'opencode/broken-model', test_status: 'failed', test_protocol: null, effort_levels: [] },
      { model_id: 'opencode/deepseek-v4-pro', test_status: 'no_tools', test_protocol: 'chat_completions', effort_levels: [] },
      { model_id: 'opencode/garbled-model', test_status: 'failed', test_protocol: null, effort_levels: [] },
      { model_id: 'opencode/glm-5.1', test_status: 'ok', test_protocol: 'chat_completions', effort_levels: ['low', 'medium', 'high'] },
      { model_id: 'opencode/glm-5.3-flash', test_status: 'no_tools', test_protocol: 'chat_completions', effort_levels: [] },
      { model_id: 'opencode/grok-4.7', test_status: 'ok', test_protocol: 'responses', effort_levels: ['low', 'medium', 'high', 'xhigh'] },
      { model_id: 'opencode/kimi-k2.7-code', test_status: 'ok', test_protocol: 'messages', effort_levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { model_id: 'opencode/mute-model', test_status: 'failed', test_protocol: null, effort_levels: [] },
    ]);

    // A lista reflete os resultados; testar de novo sobrescreve (nova data) em vez de acumular.
    const after = await service.list();
    expect(after.find((entry) => entry.id === 'opencode/glm-5.1')?.test?.status).toBe('ok');
    expect(after.find((entry) => entry.id === 'opencode/slow-model')?.test).toBeNull();
    advance(5_000);
    const again = await service.test('opencode/glm-5.1');
    expect(again.test?.testedAt).toBe(now.toISOString());
    expect((await storedProfiles()).filter((row) => row.model_id === 'opencode/glm-5.1')).toHaveLength(1);
  });

  it('dois testes simultâneos do mesmo modelo dividem uma execução só', async () => {
    const service = serviceWith();
    advance(61_000); // janela do limite limpa
    const since = upstreams.requests.length;
    const [first, second] = await Promise.all([service.test('opencode/glm-5.1'), service.test('opencode/glm-5.1')]);
    expect(second).toEqual(first);
    expect(chatCalls(since)).toHaveLength(8); // e não 16
  });

  it('erros que não são do modelo não gravam resultado: prazo estourado, chave recusada e provedor sem chave', async () => {
    await pool.query("DELETE FROM model_profiles WHERE model_id = 'opencode/slow-model'");
    advance(61_000);
    // slow-model nunca responde: o prazo geral do teste estoura e o modelo continua "nunca testado".
    expect(await code(serviceWith({ testDeadlineMs: 300 }).test('opencode/slow-model'))).toBe('PROVIDER_UNAVAILABLE');
    expect((await storedProfiles()).some((row) => row.model_id === 'opencode/slow-model')).toBe(false);
    // Chave recusada pelo provedor: nem a lista nem o teste seguem.
    expect(await code(serviceWith({ key: 'invalid-provider-key-0001' }).test('opencode/glm-5.1'))).toBe('PROVIDER_KEY_INVALID');
    // Sem provedor configurado.
    expect(await code(serviceWith({ key: null }).list())).toBe('PROVIDER_NOT_CONFIGURED');
    expect(await code(serviceWith({ key: null }).test('opencode/glm-5.1'))).toBe('PROVIDER_NOT_CONFIGURED');
  });

  it('limita a 10 testes por minuto e libera depois da janela', async () => {
    const service = serviceWith();
    advance(61_000);
    for (let attempt = 0; attempt < 10; attempt += 1) expect(await code(service.test('opencode/mute-model')), `teste ${attempt + 1}`).toBe('OK');
    const before = upstreams.requests.length;
    expect(await code(service.test('opencode/mute-model'))).toBe('RATE_LIMITED');
    expect(upstreams.requests.length).toBe(before); // recusado antes de chamar o provedor
    advance(61_000);
    expect(await code(service.test('opencode/mute-model'))).toBe('OK');
  });
});

describe('catálogo e favoritos', () => {
  it('só modelos da lista atual entram em qualquer operação, sem chamar o provedor nem gravar nada', async () => {
    const service = serviceWith();
    advance(61_000);
    const since = upstreams.requests.length;
    const rowsBefore = (await storedProfiles()).length;
    expect(await code(service.test('nao-existe'))).toBe('MODEL_UNAVAILABLE');
    expect(await code(service.setFavorite('nao-existe', true))).toBe('MODEL_UNAVAILABLE');
    expect(await code(service.validateSelection('nao-existe', null))).toBe('MODEL_UNAVAILABLE');
    expect(chatCalls(since)).toHaveLength(0);
    expect((await storedProfiles()).length).toBe(rowsBefore);
  });

  it('o catálogo fica em memória por 60 s e depois é lido de novo', async () => {
    const service = serviceWith();
    advance(CATALOG_TTL_MS + 1);
    const count = () => upstreams.requests.filter((request) => request.path.endsWith('/models')).length;
    const before = count();
    await service.list();
    await service.list();
    expect(count() - before).toBe(1);
    advance(CATALOG_TTL_MS + 1);
    await service.list();
    expect(count() - before).toBe(2);
  });

  it('favoritar e desfavoritar: idempotente, mantém a posição e ordena por quando foi marcado', async () => {
    const service = serviceWith();
    await pool.query('UPDATE model_profiles SET favorited_at = NULL');
    advance(61_000);
    const first = await service.setFavorite('opencode/kimi-k2.7-code', true);
    expect(first).toMatchObject({ id: 'opencode/kimi-k2.7-code', favorite: true, favoritedAt: now.toISOString() });
    expect(first.test?.status).toBe('ok'); // favoritar não apaga o resultado do teste
    advance(1_000);
    await service.setFavorite('opencode/glm-5.1', true);
    advance(1_000);
    // Favoritar de novo não move o modelo para o fim da fila de favoritos.
    const repeated = await service.setFavorite('opencode/kimi-k2.7-code', true);
    expect(repeated.favoritedAt).toBe(first.favoritedAt);

    const favorites = (await service.list()).filter((entry): entry is ModelEntry & { favoritedAt: string } => entry.favorite);
    expect(favorites.sort((a, b) => a.favoritedAt.localeCompare(b.favoritedAt)).map((entry) => entry.id)).toEqual(['opencode/kimi-k2.7-code', 'opencode/glm-5.1']);

    // Modelo nunca testado também pode ser favorito (a linha nasce só com o favorito).
    const untested = await service.setFavorite('opencode/slow-model', true);
    expect(untested).toMatchObject({ favorite: true, test: null });
    const off = await service.setFavorite('opencode/slow-model', false);
    expect(off).toMatchObject({ favorite: false, favoritedAt: null, test: null });
    expect((await service.setFavorite('opencode/slow-model', false)).favorite).toBe(false); // desmarcar de novo não erra
  });
});

describe('validação de modelo e effort de um bot', () => {
  it('confere a combinação final: sem modelo não há effort, o modelo consta na lista e o effort é um nível gravado', async () => {
    const service = serviceWith();
    advance(61_000);
    await service.test('opencode/glm-5.1');
    const check = (model: string | null, effort: Parameters<ModelService['validateSelection']>[1]) => code(service.validateSelection(model, effort));

    expect(await check(null, null)).toBe('OK');
    expect(await check('opencode/glm-5.1', null)).toBe('OK');
    expect(await check('opencode/glm-5.1', 'high')).toBe('OK');
    // Effort sem modelo, nível que o modelo não aceitou e modelo que não expõe effort: VALIDATION_FAILED no campo effort.
    expect(await check('opencode/kimi-k2.7-code', 'max')).toBe('OK');
    for (const [model, effort] of [[null, 'high'], ['opencode/glm-5.1', 'xhigh'], ['opencode/glm-5.1', 'max'], ['opencode/glm-5.3-flash', 'low']] as const) {
      const error = await service.validateSelection(model, effort).catch((caught: unknown) => caught);
      expect(error, `${model}/${effort}`).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('VALIDATION_FAILED');
      expect((error as DomainError).fields?.map((field) => field.field)).toEqual(['effort']);
    }
    // Modelo nunca testado não tem nível algum.
    await pool.query("DELETE FROM model_profiles WHERE model_id = 'opencode/grok-4.7'");
    expect(await check('opencode/grok-4.7', 'low')).toBe('VALIDATION_FAILED');
    expect(await check('opencode/grok-4.7', null)).toBe('OK');
  });
});

describe('visao persistida por modelo', () => {
  it('sonda os quatro comportamentos, reutiliza cache e limpa ao retestar', async () => {
    await pool.query('DELETE FROM model_profiles');
    const service = serviceWith();
    for (const [model, accepts] of [['opencode/vision-model', true], ['opencode/vision-reject', false], ['opencode/vision-wrong', false]] as const) {
      expect((await service.verifyImage(model)).acceptsImages).toBe(accepts);
      const since = upstreams.requests.length;
      expect((await service.verifyImage(model)).acceptsImages).toBe(accepts);
      expect(chatCalls(since)).toHaveLength(0);
    }
    expect(await code(service.verifyImage('opencode/vision-unstable'))).toBe('MODEL_IMAGE_CHECK_FAILED');
    expect((await service.list()).find((entry) => entry.id === 'opencode/vision-unstable')?.acceptsImages).toBeNull();
    expect((await service.verifyImage('opencode/vision-unstable')).acceptsImages).toBe(true);
    // Corrida real: o reteste deve terminar com o cache limpo, mesmo havendo sonda ativa.
    await pool.query("UPDATE model_profiles SET accepts_images = null WHERE model_id = 'opencode/vision-model'");
    const checking = service.verifyImage('opencode/vision-model');
    const retesting = service.test('opencode/vision-model');
    await checking;
    expect((await retesting).acceptsImages).toBeNull();
    const since = upstreams.requests.length;
    expect((await service.verifyImage('opencode/vision-model')).acceptsImages).toBe(true);
    expect(chatCalls(since)).toHaveLength(1);
    expect(await code(service.verifyImage('modelo-fora-da-lista'))).toBe('MODEL_UNAVAILABLE');
  });
  it('compartilha orçamento com testes normais e deduplica sondas simultaneas', async () => {
    const service = serviceWith();
    await pool.query("UPDATE model_profiles SET accepts_images = null WHERE model_id = 'opencode/vision-model'");
    const since = upstreams.requests.length;
    await Promise.all([service.verifyImage('opencode/vision-model'), service.verifyImage('opencode/vision-model')]);
    expect(chatCalls(since)).toHaveLength(1);
    for (let i = 0; i < 9; i++) await service.test('opencode/vision-model');
    expect(await code(service.verifyImage('opencode/vision-model'))).toBe('RATE_LIMITED');
  });
});

it('falha de reteste limpa visao, preserva teste normal e permite nova sonda', async () => {
  const base = createOpenCodeGoClient({ baseUrl: upstreams.opencodeGoBaseUrl });
  let failed = false;
  const provider: ProviderClient = { ...base, async *streamChat(...args) {
    if (failed) throw new DomainError('PROVIDER_UNAVAILABLE');
    yield* base.streamChat(...args);
  } };
  const service = serviceWith({ provider });
  expect((await service.verifyImage('opencode/vision-model')).acceptsImages).toBe(true);
  failed = true;
  expect(await code(service.test('opencode/vision-model'))).toBe('PROVIDER_UNAVAILABLE');
  expect((await service.list()).find((entry) => entry.id === 'opencode/vision-model')).toMatchObject({ acceptsImages: null, test: { status: 'ok' } });
  failed = false;
  expect((await service.verifyImage('opencode/vision-model')).acceptsImages).toBe(true);
});

it('falha na descoberta e no catalogo deixa a visao sem cache', async () => {
  const service = serviceWith({ testDeadlineMs: 50 });
  expect(await code(service.verifyImage('opencode/broken-model'))).toBe('MODEL_IMAGE_CHECK_FAILED');
  expect(await code(service.verifyImage('opencode/slow-model'))).toBe('MODEL_IMAGE_CHECK_FAILED');
  expect((await service.list()).filter((entry) => ['opencode/broken-model', 'opencode/slow-model'].includes(entry.id)).every((entry) => entry.acceptsImages === null)).toBe(true);
  const unavailable = createOpenCodeGoClient({ baseUrl: 'https://provider.test', fetchImpl: async () => new Response('', { status: 503 }) });
  expect(await code(serviceWith({ provider: unavailable }).verifyImage('opencode/vision-model'))).toBe('MODEL_IMAGE_CHECK_FAILED');
});

describe('provedores: OpenCode Go e Anthropic (phase 17; A6, A10)', () => {
  const OPENCODE_KEY = 'valid-provider-key-ABCD';
  const ANTHROPIC_KEY = 'valid-anthropic-WXYZ';

  /** Serviço com a chave de cada provedor (nulo = sem chave) e o roteador por provedor, como em produção. */
  function twoProviders({ opencodeKey = OPENCODE_KEY, anthropicKey = ANTHROPIC_KEY }: { opencodeKey?: string | null; anthropicKey?: string | null } = {}): ModelService {
    const opencode = createOpenCodeGoClient({ baseUrl: upstreams.opencodeGoBaseUrl, chatTimeoutMs: 5_000 });
    const anthropic = createAnthropicClient({ baseUrl: upstreams.anthropicBaseUrl, chatTimeoutMs: 5_000 });
    return new ModelService({
      pool,
      credentials: {
        requireKey: async (kind) => {
          const key = kind === 'anthropic' ? anthropicKey : opencodeKey;
          if (key === null) throw new DomainError('PROVIDER_NOT_CONFIGURED');
          return key;
        },
      },
      provider: createProviderRouter({ opencode, anthropic, creditsState: createCreditsState(pool) }),
      anthropic,
      logger: createLogger({ level: 'silent', name: 'models-test' }),
      now: () => now,
    });
  }
  const services = (since: number) => upstreams.requests.slice(since).map((request) => request.service);

  it('A6: com as duas chaves o catálogo traz cada modelo como provedor/modelo, o OpenCode Go e depois a Anthropic, todos visíveis, com a capacidade confirmada da Anthropic', async () => {
    advance(2 * CATALOG_TTL_MS);
    const listed = await twoProviders().list();
    const ids = listed.map((entry) => entry.id);
    expect(ids).toHaveLength(14 + 8);
    expect(ids.every((id) => /^(opencode|anthropic)\//.test(id))).toBe(true);
    expect(ids.slice(0, 14).every((id) => id.startsWith('opencode/'))).toBe(true);
    expect(ids.slice(14)).toEqual(['anthropic/claude-haiku-3-5', 'anthropic/claude-haiku-4-5', 'anthropic/claude-haiku-5-5', 'anthropic/claude-mute', 'anthropic/claude-opus-5', 'anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5', 'anthropic/claude-sonnet-5-5']);
    expect(listed.find((entry) => entry.id === 'anthropic/claude-haiku-5-5')!.contextCapacity).toMatchObject({ provider: 'anthropic', model: 'anthropic/claude-haiku-5-5', contextTokens: 1_000_000, outputTokens: 128_000 });
    expect(listed.find((entry) => entry.id === 'anthropic/claude-haiku-4-5')!.contextCapacity).toMatchObject({ contextTokens: 200_000, outputTokens: 64_000 });
    // O OpenCode Go segue com a tabela fixa dele; os ids do catálogo nunca saem sem o prefixo.
    expect(listed.find((entry) => entry.id === 'opencode/deepseek-v4.1-flash')!.contextCapacity).toMatchObject({ provider: 'opencode_go', contextTokens: 1_000_000 });
  });

  it('A7, A8, A23: cada entrada traz nome, preço e se está oculta; ocultar e reexibir é idempotente, não tira o modelo da lista e só vale para modelo da lista atual', async () => {
    advance(2 * CATALOG_TTL_MS);
    const service = twoProviders();
    const haiku = 'anthropic/claude-haiku-5-5';
    try {
      const listed = await service.list();
      const by = (id: string) => listed.find((entry) => entry.id === id)!;
      // Modelo novo do provedor nasce visível (A8), com o nome do provedor (Anthropic) ou sem nome (OpenCode Go) e o preço da tabela (A23).
      expect(listed.every((entry) => entry.hidden === false)).toBe(true);
      expect(by(haiku)).toMatchObject({ displayName: 'Claude Haiku 5.5', price: { input: 0.1, output: 0.5 } });
      expect(by('anthropic/claude-sonnet-5-5')).toMatchObject({ displayName: 'Claude Sonnet 5.5', price: { input: 2, output: 10 } });
      expect(by('anthropic/claude-opus-5-5')).toMatchObject({ displayName: 'Claude Opus 5.5', price: { input: 4, output: 20 } });
      expect(by('opencode/deepseek-v4.1-flash')).toMatchObject({ displayName: null, price: { input: 0.3, output: 1.2 } });
      expect(by('anthropic/claude-opus-5').price).toBeNull(); // sem linha na tabela: "preço desconhecido"
      expect(by('opencode/glm-5.1').price).toBeNull();

      const hidden = await service.setHidden(haiku, true);
      expect(hidden).toMatchObject({ id: haiku, hidden: true, displayName: 'Claude Haiku 5.5' });
      const firstHiddenAt = (await pool.query<{ hidden_at: Date }>('SELECT hidden_at FROM model_profiles WHERE model_id = $1', [haiku])).rows[0]!.hidden_at;
      advance(5_000);
      await service.setHidden(haiku, true); // repetir mantém o primeiro instante
      expect((await pool.query<{ hidden_at: Date }>('SELECT hidden_at FROM model_profiles WHERE model_id = $1', [haiku])).rows[0]!.hidden_at).toEqual(firstHiddenAt);
      // Só ele fica oculto, e a lista segue com todos (quem monta as escolhas novas é que esconde); o servidor aceita validar uma escolha com o modelo oculto (A9).
      const after = await service.list();
      expect(after).toHaveLength(listed.length);
      expect(after.filter((entry) => entry.hidden).map((entry) => entry.id)).toEqual([haiku]);
      await expect(service.validateSelection(haiku, null)).resolves.toBeUndefined();
      // Ocultar não mexe no favorito nem no teste, e reexibir o devolve.
      expect(await service.setFavorite(haiku, true)).toMatchObject({ hidden: true, favorite: true });
      expect(await service.setHidden(haiku, false)).toMatchObject({ hidden: false, favorite: true });
      expect(await code(service.setHidden('anthropic/inexistente', true))).toBe('MODEL_UNAVAILABLE');
      expect(await code(service.setHidden('sem-provedor', true))).toBe('MODEL_UNAVAILABLE');
    } finally {
      await pool.query('DELETE FROM model_profiles WHERE model_id = $1', [haiku]);
    }
  });

  it('A21: saldo esgotado deixa os modelos da Anthropic indisponíveis no catálogo (os do OpenCode Go não), o teste do modelo para com PROVIDER_CREDITS_EXHAUSTED sem gravar nada, e a chamada que passa os libera', async () => {
    await pool.query("INSERT INTO credentials (kind, secret_sealed, masked, created_at, updated_at) VALUES ('anthropic', 'selado', '••••WXYZ', now(), now()) ON CONFLICT (kind) DO NOTHING");
    try {
      advance(2 * CATALOG_TTL_MS);
      const service = twoProviders();
      const flags = async (provider: string) => (await service.list()).filter((entry) => entry.id.startsWith(`${provider}/`)).map((entry) => entry.unavailable ?? null);
      expect(new Set(await flags('anthropic'))).toEqual(new Set([null]));

      const storedBefore = (await storedProfiles()).length;
      upstreams.controls.anthropicOutOfCredits = true;
      expect(await code(service.test('anthropic/claude-haiku-5-5'))).toBe('PROVIDER_CREDITS_EXHAUSTED');
      expect((await storedProfiles()).length).toBe(storedBefore); // nada foi gravado, nem um "falhou" para o modelo
      expect(new Set(await flags('anthropic'))).toEqual(new Set(['credits_exhausted']));
      expect(new Set(await flags('opencode'))).toEqual(new Set([null]));

      upstreams.controls.anthropicOutOfCredits = false;
      await service.test('anthropic/claude-haiku-5-5'); // uma chamada que passa
      expect(new Set(await flags('anthropic'))).toEqual(new Set([null]));
    } finally {
      upstreams.controls.anthropicOutOfCredits = false;
      await pool.query("DELETE FROM credentials WHERE kind = 'anthropic'");
    }
  });

  it('A21: favoritar, ocultar, testar e os perfis devolvem a entrada com o MESMO estado da lista (saldo, oculto, preço e nome), porque a tela troca a linha pelo que o servidor devolve', async () => {
    await pool.query("INSERT INTO credentials (kind, secret_sealed, masked, credits_exhausted_at, created_at, updated_at) VALUES ('anthropic', 'selado', '••••WXYZ', now(), now(), now()) ON CONFLICT (kind) DO UPDATE SET credits_exhausted_at = now()");
    const haiku = 'anthropic/claude-haiku-5-5';
    try {
      advance(2 * CATALOG_TTL_MS);
      const service = twoProviders();
      const fromList = (await service.list()).find((entry) => entry.id === haiku)!;
      expect(fromList).toMatchObject({ unavailable: 'credits_exhausted', displayName: 'Claude Haiku 5.5', price: { input: 0.1, output: 0.5 }, hidden: false });
      // Cada operação devolve a mesma montagem: nenhuma perde o "indisponível" nem o nome e o preço.
      expect(await service.setFavorite(haiku, true)).toMatchObject({ id: haiku, favorite: true, unavailable: 'credits_exhausted', displayName: 'Claude Haiku 5.5', price: { input: 0.1, output: 0.5 } });
      expect(await service.setHidden(haiku, true)).toMatchObject({ hidden: true, favorite: true, unavailable: 'credits_exhausted', displayName: 'Claude Haiku 5.5' });
      expect((await service.profiles()).find((entry) => entry.id === haiku)).toMatchObject({ unavailable: 'credits_exhausted', hidden: true, favorite: true });
      // O modelo do OpenCode Go não herda o estado, e o saldo de volta limpa todas as formas.
      expect(await service.setFavorite('opencode/glm-5.1', true)).toMatchObject({ unavailable: null });
      await pool.query("UPDATE credentials SET credits_exhausted_at = NULL WHERE kind = 'anthropic'");
      expect(await service.setHidden(haiku, false)).toMatchObject({ hidden: false, unavailable: null });
      expect((await service.list()).find((entry) => entry.id === haiku)).toMatchObject({ unavailable: null });
    } finally {
      await pool.query('DELETE FROM model_profiles WHERE model_id IN ($1, $2)', [haiku, 'opencode/glm-5.1']);
      await pool.query("DELETE FROM credentials WHERE kind = 'anthropic'");
    }
  });

  it('A8: o modelo que o provedor passa a listar depois de uma curadoria aparece na lista seguinte, visível e com o nome e o preço dele, sem desfazer o oculto nem o favorito dos outros', async () => {
    const capacity = { maxInputTokens: 1_000_000, maxTokens: 128_000 };
    let offered: AnthropicModel[] = [
      { id: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5', ...capacity },
      { id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', ...capacity },
    ];
    const anthropic: AnthropicClient = { listModels: () => Promise.resolve(offered), streamChat: () => (async function* () { yield* []; })() };
    const opencode = createOpenCodeGoClient({ baseUrl: upstreams.opencodeGoBaseUrl, chatTimeoutMs: 5_000 });
    const service = new ModelService({
      pool,
      credentials: { requireKey: (kind) => Promise.resolve(kind === 'anthropic' ? ANTHROPIC_KEY : OPENCODE_KEY) },
      provider: createProviderRouter({ opencode, anthropic }),
      anthropic,
      logger: createLogger({ level: 'silent', name: 'models-test' }),
      now: () => now,
    });
    const anthropicOnly = async () => (await service.list()).filter((entry) => entry.id.startsWith('anthropic/'));
    try {
      advance(2 * CATALOG_TTL_MS);
      expect((await anthropicOnly()).map((entry) => entry.id)).toEqual(['anthropic/claude-haiku-5-5', 'anthropic/claude-sonnet-5-5']);
      // A curadoria do dono: oculta o Haiku e favorita o Sonnet.
      await service.setHidden('anthropic/claude-haiku-5-5', true);
      await service.setFavorite('anthropic/claude-sonnet-5-5', true);

      // O provedor lista um modelo novo (e a tabela de preços não o conhece): depois do prazo do cache ele entra visível e escolhível.
      offered = [...offered, { id: 'claude-fresh-5-6', displayName: 'Claude Fresh 5.6', ...capacity }];
      advance(2 * CATALOG_TTL_MS);
      const after = await anthropicOnly();
      expect(after.map((entry) => entry.id)).toEqual(['anthropic/claude-fresh-5-6', 'anthropic/claude-haiku-5-5', 'anthropic/claude-sonnet-5-5']);
      expect(after.find((entry) => entry.id === 'anthropic/claude-fresh-5-6')).toMatchObject({ hidden: false, favorite: false, unavailable: null, displayName: 'Claude Fresh 5.6', price: null });
      // O que o dono já tinha decidido segue como estava.
      expect(after.find((entry) => entry.id === 'anthropic/claude-haiku-5-5')).toMatchObject({ hidden: true });
      expect(after.find((entry) => entry.id === 'anthropic/claude-sonnet-5-5')).toMatchObject({ hidden: false, favorite: true });
      // E o servidor já o aceita em qualquer escolha.
      await expect(service.validateSelection('anthropic/claude-fresh-5-6', null)).resolves.toBeUndefined();
      expect(await service.setFavorite('anthropic/claude-fresh-5-6', true)).toMatchObject({ hidden: false, favorite: true });
    } finally {
      await pool.query("DELETE FROM model_profiles WHERE model_id LIKE 'anthropic/%'");
    }
  });

  it('cada provedor só entra com a chave dele: sem a da Anthropic ela nem é consultada, sem a do OpenCode Go só a Anthropic aparece e sem nenhuma o erro é "configure um provedor"', async () => {
    advance(2 * CATALOG_TTL_MS);
    let since = upstreams.requests.length;
    expect((await twoProviders({ anthropicKey: null }).list()).every((entry) => entry.id.startsWith('opencode/'))).toBe(true);
    expect(services(since)).toEqual(['opencode-go']);

    advance(2 * CATALOG_TTL_MS);
    since = upstreams.requests.length;
    expect((await twoProviders({ opencodeKey: null }).list()).every((entry) => entry.id.startsWith('anthropic/'))).toBe(true);
    expect(services(since)).toEqual(['anthropic']);

    expect(await code(twoProviders({ opencodeKey: null, anthropicKey: null }).list())).toBe('PROVIDER_NOT_CONFIGURED');
    // Um modelo da Anthropic sem a chave dela não é testado nem aceito: o erro é o da chave, e nenhuma chamada sai.
    since = upstreams.requests.length;
    expect(await code(twoProviders({ anthropicKey: null }).test('anthropic/claude-haiku-5-5'))).toBe('PROVIDER_NOT_CONFIGURED');
    expect(upstreams.requests).toHaveLength(since);
  });

  it('só modelo da lista do provedor dele entra: id sem provedor, de outro provedor ou inexistente é MODEL_UNAVAILABLE e nada é gravado', async () => {
    const service = twoProviders();
    const before = (await storedProfiles()).length;
    for (const model of ['claude-haiku-5-5', 'opencode/claude-haiku-5-5', 'anthropic/glm-5.1', 'anthropic/nao-existe', 'anthropic/', 'anthropic']) {
      expect(await code(service.setFavorite(model, true)), model).toBe('MODEL_UNAVAILABLE');
      expect(await code(service.test(model)), model).toBe('MODEL_UNAVAILABLE');
    }
    expect((await storedProfiles()).length).toBe(before);
    expect(modelCredentialKind('anthropic/claude-haiku-5-5')).toBe('anthropic');
    expect([modelCredentialKind('opencode/glm-5.1'), modelCredentialKind('glm-5.1'), modelCredentialKind('anthropic')]).toEqual(['provider', 'provider', 'provider']); // sem provedor conhecido cai no OpenCode Go, que o recusa como indisponível
  });

  it('testar um modelo da Anthropic usa só a chave dela: tenta o chat_completions (recusado sem pedido), descobre o messages, a ferramenta e os cinco níveis de effort', async () => {
    const service = twoProviders();
    const since = upstreams.requests.length;
    const tested = await service.test('anthropic/claude-haiku-5-5');
    expect(tested).toMatchObject({ id: 'anthropic/claude-haiku-5-5', test: { status: 'ok', reason: null, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] } });
    const calls = upstreams.requests.slice(since);
    expect(calls.every((call) => call.service === 'anthropic' && call.key === ANTHROPIC_KEY)).toBe(true); // nenhuma chamada ao OpenCode Go, e a chave é a da Anthropic em todas
    const chats = calls.filter((call) => call.method === 'POST');
    expect(chats.length).toBeGreaterThan(5);
    expect(chats.every((call) => call.path === '/anthropic/v1/messages' && call.model === 'claude-haiku-5-5')).toBe(true); // o id local vai ao provedor; o chat_completions nem chega a sair
    expect((await storedProfiles()).find((row) => row.model_id === 'anthropic/claude-haiku-5-5')).toMatchObject({ test_status: 'ok', test_protocol: 'messages' });
    // O Haiku 4.5 recusa o parâmetro de effort: o modelo não expõe o controle.
    expect((await service.test('anthropic/claude-haiku-4-5')).test).toMatchObject({ status: 'ok', effortLevels: [] });
    // E a listagem seguinte traz o resultado gravado do modelo.
    expect((await service.list()).find((entry) => entry.id === 'anthropic/claude-haiku-5-5')!.test?.status).toBe('ok');
  });

  it('A10: a janela efetiva de um modelo da Anthropic respeita max_input_tokens e a reserva de saída respeita max_tokens, e o modelo sem leitura do catálogo fica sem teto', async () => {
    const service = twoProviders();
    advance(2 * CATALOG_TTL_MS);
    await service.warmCapacity('anthropic/claude-haiku-3-5'); // o motor e o arranque a carregam antes de calcular a janela
    const small = readModelContextCapacity('anthropic/claude-haiku-4-5');
    expect(small).toMatchObject({ contextTokens: 200_000, outputTokens: 64_000 });
    // Janela escolhida de 512k num modelo de 200k de contexto: vale o do modelo.
    expect(resolveContextWindow(524_288, 'bot', 'anthropic/claude-haiku-4-5', small).effectiveTokens).toBe(200_000);
    // O modelo de 1M de contexto não limita nenhuma das quatro opções do dono.
    expect(resolveContextWindow(524_288, 'bot', 'anthropic/claude-haiku-5-5', readModelContextCapacity('anthropic/claude-haiku-5-5')).effectiveTokens).toBe(524_288);
    // Reserva: o menor entre 32.768, 25% da janela e o max_tokens do modelo (64.000 não corta; 8.192 corta).
    expect(contextEnvelope(200_000, MAX_OUTPUT_TOKENS, small!.outputTokens).outputReserve).toBe(32_768);
    const tiny = readModelContextCapacity('anthropic/claude-haiku-3-5');
    expect(tiny).toMatchObject({ contextTokens: 200_000, outputTokens: 8_192 });
    expect(contextEnvelope(200_000, MAX_OUTPUT_TOKENS, tiny!.outputTokens).outputReserve).toBe(8_192);
    // Sem leitura do catálogo (id que a Anthropic não lista) não há capacidade, e a janela escolhida vale inteira.
    expect(readModelContextCapacity('anthropic/claude-inventado')).toBeNull();
    expect(resolveContextWindow(262_144, 'global', 'anthropic/claude-inventado', null).effectiveTokens).toBe(262_144);
  });

  it('warmCapacity nunca falha e só age para a Anthropic: sem chave, com a chave recusada ou para modelo do OpenCode Go não faz nenhuma chamada nem lança', async () => {
    advance(2 * CATALOG_TTL_MS);
    const since = upstreams.requests.length;
    await twoProviders({ anthropicKey: null }).warmCapacity('anthropic/claude-haiku-5-5');
    await twoProviders().warmCapacity('opencode/glm-5.1');
    expect(upstreams.requests).toHaveLength(since);
    const refused = 'invalid-anthropic-0001'; // valor sem a palavra "key" (regra generic-api-key do gitleaks)
    await expect(twoProviders({ anthropicKey: refused }).warmCapacity()).resolves.toBeUndefined();
  });
});

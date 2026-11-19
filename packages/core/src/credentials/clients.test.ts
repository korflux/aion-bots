// Prova dos adaptadores do OpenCode Go, do Composio e da Parallel e da configuração dos destinos de rede: timeout, rede fora do
// ar, corpo fora do formato ou grande demais, redirecionamento (nunca seguido) e destinos fixos na configuração.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatEvent, ChatRequest } from '../models/chat-protocols';
import { loadApiConfig, loadWorkerConfig, type Env } from '../config';
import { DomainError } from '../errors';
import { startFakeUpstreams, type FakeUpstreams } from '../testing/fake-upstreams';
import { ACTION_OUTCOME_UNKNOWN, createComposioClient } from './composio';
import { createAnthropicClient } from './anthropic';
import { createOpenCodeGoClient } from './opencode-go';
import { createParallelClient } from './parallel';
import { ProviderRateLimited } from './upstream-http';

let upstreams: FakeUpstreams;

beforeAll(async () => {
  upstreams = await startFakeUpstreams();
});

afterAll(async () => {
  await upstreams.stop();
});

/** Código do `DomainError` lançado, ou `ok` se a chamada deu certo. */
const outcome = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => 'ok',
    (error: unknown) => (error instanceof DomainError ? error.code : `inesperado: ${String(error)}`),
  );

describe('adaptador do OpenCode Go', () => {
  // Prazo folgado nos cenários que NÃO são o de lentidão (E11): com 300 ms, uma resposta local atrasada pela carga da máquina virava
  // "indisponível" e reprovava um teste que não é de prazo. O cliente impaciente (300 ms) existe só para o cenário do timeout.
  const client = () => createOpenCodeGoClient({ baseUrl: upstreams.opencodeGoBaseUrl, timeoutMs: 5_000 });
  const impatient = () => createOpenCodeGoClient({ baseUrl: upstreams.opencodeGoBaseUrl, timeoutMs: 300 });

  it('lista os modelos com a chave em Authorization: Bearer', async () => {
    const models = await client().listModels('valid-key');
    expect(models).toHaveLength(14);
    expect(models.slice(0, 3)).toEqual([{ id: 'glm-5.1' }, { id: 'glm-5.3-flash' }, { id: 'kimi-k2.7-code' }]);
    expect(upstreams.requests.at(-1)).toEqual({ service: 'opencode-go', method: 'GET', path: '/opencode-go/v1/models', key: 'valid-key' });
  });

  it('classifica os cenários: 401 e 403 são chave inválida; o resto é serviço indisponível', async () => {
    expect(await outcome(client().listModels('invalid-key'))).toBe('PROVIDER_KEY_INVALID');
    expect(await outcome(client().listModels('forbidden-key'))).toBe('PROVIDER_KEY_INVALID');
    expect(await outcome(client().listModels('down-key'))).toBe('PROVIDER_UNAVAILABLE');
    expect(await outcome(client().listModels('html-key'))).toBe('PROVIDER_UNAVAILABLE');
    expect(await outcome(client().listModels('huge-key'))).toBe('PROVIDER_UNAVAILABLE');
  });

  it('timeout: um serviço que não responde vira indisponível sem prender a chamada', async () => {
    const started = Date.now();
    expect(await outcome(impatient().listModels('slow-key'))).toBe('PROVIDER_UNAVAILABLE');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('rede fora do ar (conexão recusada) vira indisponível', async () => {
    const dead = createOpenCodeGoClient({ baseUrl: 'http://127.0.0.1:1/v1', timeoutMs: 5_000 }); // conexão recusada é imediata, o prazo não entra
    expect(await outcome(dead.listModels('valid-key'))).toBe('PROVIDER_UNAVAILABLE');
  });

  it('redirecionamento nunca é seguido (a chave não é entregue a outro destino)', async () => {
    const before = upstreams.requests.length;
    expect(await outcome(client().listModels('redirect-key'))).toBe('PROVIDER_UNAVAILABLE');
    const after = upstreams.requests.slice(before);
    expect(after).toHaveLength(1);
    expect(after.some((request) => request.service === 'composio')).toBe(false);
  });
});

describe('429 do chat do OpenCode Go (phase 17, passo 8; A22)', () => {
  const chatRequest = (text: string, retry: boolean): ChatRequest => ({
    model: 'opencode/glm-5.1',
    sessionId: randomUUID(),
    turns: [{ role: 'system', text: 'Você é um teste.' }, { role: 'user', text }],
    maxTokens: 64,
    ...(retry ? { retryOnRateLimit: true } : {}),
  });
  const posts = (since: number) => upstreams.requests.slice(since).filter((request) => request.service === 'opencode-go' && request.method === 'POST');
  const drain = async (stream: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> => {
    const events: ChatEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
  };
  /** Cliente com a espera trocada por um registro (nenhum teste dorme de verdade); `backoffMs` encurta a tabela de esperas sem `Retry-After`. */
  const withSleeps = (options: { backoffMs?: readonly number[]; maxWaitMs?: number; fetchImpl?: typeof fetch } = {}) => {
    const waits: number[] = [];
    const { fetchImpl, ...retry } = options;
    const client = createOpenCodeGoClient({
      baseUrl: upstreams.opencodeGoBaseUrl,
      timeoutMs: 5_000,
      chatTimeoutMs: 5_000,
      ...(fetchImpl ? { fetchImpl } : {}),
      rateLimitRetry: { ...retry, sleep: (ms) => { waits.push(ms); return Promise.resolve(); } },
    });
    return { client, waits };
  };
  const failureOf = async (stream: AsyncGenerator<ChatEvent>): Promise<DomainError> => {
    const error = await drain(stream).then(() => null, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(DomainError);
    return error as DomainError;
  };

  it('um 429 antes do stream é esperado (o Retry-After do provedor) e repetido UMA vez: o texto chega inteiro, sem evento duplicado', async () => {
    const { client, waits } = withSleeps();
    const since = upstreams.requests.length;
    const events = await drain(client.streamChat('valid-key', 'chat_completions', chatRequest('[limitar] escreva', true)));
    expect(posts(since)).toHaveLength(2); // a recusada e a que passou
    expect(waits).toEqual([0]); // o fake manda `Retry-After: 0`
    expect(events.filter((event) => event.type === 'text').map((event) => (event as { text: string }).text).join('')).toBe('Resposta: [limitar] escreva');
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
  });

  it('esgotadas as novas tentativas (2) a falha é a de sempre, PROVIDER_UNAVAILABLE com a marca de limite do provedor; sem `retryOnRateLimit` (teste de modelo, sonda) não espera nem repete', async () => {
    const { client, waits } = withSleeps();
    let since = upstreams.requests.length;
    const exhausted = await failureOf(client.streamChat('valid-key', 'chat_completions', chatRequest('[limitar-sempre] x', true)));
    expect(exhausted.code).toBe('PROVIDER_UNAVAILABLE');
    expect(exhausted.cause).toBeInstanceOf(ProviderRateLimited);
    expect(posts(since)).toHaveLength(3); // a original e 2 novas tentativas, nunca mais
    expect(waits).toEqual([0, 0]);

    since = upstreams.requests.length;
    waits.length = 0;
    const plain = await failureOf(client.streamChat('valid-key', 'chat_completions', chatRequest('[limitar-sempre] y', false)));
    expect(plain.code).toBe('PROVIDER_UNAVAILABLE');
    expect(posts(since)).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('sem Retry-After usa a espera crescente; um pedido de espera acima do teto (Retry-After: 30 do cenário `limited`) não é esperado nem repetido; outros erros 5xx não são repetidos', async () => {
    const stub = (responses: Response[]) => {
      const calls: number[] = [];
      const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => (responses.length > 0 ? (calls.push(1), Promise.resolve(responses.shift()!)) : fetch(input, init))) as typeof fetch;
      return { fetchImpl, calls };
    };
    const first = stub([new Response('{}', { status: 429 })]);
    const { client, waits } = withSleeps({ backoffMs: [7, 9], fetchImpl: first.fetchImpl });
    const events = await drain(client.streamChat('valid-key', 'chat_completions', chatRequest('[limitar-nada] ok', true)));
    expect(waits).toEqual([7]);
    expect(events.some((event) => event.type === 'text')).toBe(true);

    let since = upstreams.requests.length;
    const capped = withSleeps();
    const limited = await failureOf(capped.client.streamChat('limited-key', 'chat_completions', chatRequest('qualquer', true)));
    expect(limited.cause).toMatchObject({ retryAfterMs: 30_000 });
    expect(posts(since)).toHaveLength(1);
    expect(capped.waits).toEqual([]);

    since = upstreams.requests.length;
    const down = withSleeps();
    expect((await failureOf(down.client.streamChat('down-key', 'chat_completions', chatRequest('qualquer', true)))).code).toBe('PROVIDER_UNAVAILABLE');
    expect(posts(since)).toHaveLength(1);
    expect(down.waits).toEqual([]);
  });

  it('a parada do dono interrompe a espera da nova tentativa (o aborto vira PROVIDER_UNAVAILABLE) e nada mais é enviado', async () => {
    const limitedOnce = (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch;
    const client = createOpenCodeGoClient({ baseUrl: upstreams.opencodeGoBaseUrl, timeoutMs: 5_000, chatTimeoutMs: 5_000, fetchImpl: limitedOnce, rateLimitRetry: { backoffMs: [60_000], maxWaitMs: 120_000 } });
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 40);
    const error = await failureOf(client.streamChat('valid-key', 'chat_completions', chatRequest('qualquer', true), controller.signal));
    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('o Composio e a Parallel NÃO repetem o 429: uma única chamada em cada', async () => {
    let calls = 0;
    const limited = (async () => { calls += 1; return new Response('{}', { status: 429 }); }) as unknown as typeof fetch;
    const composio = createComposioClient({ baseUrl: 'http://composio.local/api/v3', fetchImpl: limited });
    expect(await outcome(composio.executeAction('k', { slug: 'GMAIL_SEND_EMAIL', arguments: {}, connectedAccountId: 'ca_1', userId: 'usr_1' }))).toBe('CONNECTOR_UNAVAILABLE');
    expect(calls).toBe(1);
    const parallel = createParallelClient({ baseUrl: 'http://parallel.local/mcp', fetchImpl: limited });
    expect(await outcome(parallel.validateKey('k'))).toBe('WEB_SEARCH_UNAVAILABLE');
    expect(calls).toBe(2);
  });
});

describe('adaptador da Anthropic', () => {
  const client = () => createAnthropicClient({ baseUrl: upstreams.anthropicBaseUrl, timeoutMs: 5_000 });
  const impatient = () => createAnthropicClient({ baseUrl: upstreams.anthropicBaseUrl, timeoutMs: 300 });

  it('lista os modelos com x-api-key e a versão, sem Bearer, e traz o nome exibido e a capacidade confirmada de cada um', async () => {
    const models = await client().listModels('valid-key');
    expect(models.map((model) => model.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-haiku-3-5', 'claude-mute']);
    expect(models.find((model) => model.id === 'claude-haiku-5-5')).toEqual({ id: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5', maxInputTokens: 1_000_000, maxTokens: 128_000 });
    expect(models.find((model) => model.id === 'claude-haiku-4-5')).toMatchObject({ maxInputTokens: 200_000, maxTokens: 64_000 });
    // Só a chave e a versão: a Anthropic nativa não usa Authorization: Bearer.
    expect(upstreams.requests.at(-1)).toMatchObject({ service: 'anthropic', method: 'GET', path: '/anthropic/v1/models', key: 'valid-key', anthropicVersion: '2023-06-01', bearer: false });
  });

  it('pagina pelo cursor: o last_id de cada página vira o after_id da seguinte até has_more falso, e um cursor que não avança encerra a leitura', async () => {
    const pages: Record<string, unknown> = {
      '': { data: [{ id: 'claude-a', display_name: 'A', max_input_tokens: 10, max_tokens: 5 }], has_more: true, last_id: 'claude-a' },
      'claude-a': { data: [{ id: 'claude-b', display_name: null, max_input_tokens: null }], has_more: true, last_id: 'claude-b' },
      'claude-b': { data: [{ id: 'claude-c', max_input_tokens: 0, max_tokens: 'x' }], has_more: false, last_id: 'claude-c' },
    };
    const asked: (string | null)[] = [];
    const paged = createAnthropicClient({
      baseUrl: 'https://anthropic.invalido/v1',
      fetchImpl: async (input) => {
        const after = new URL(String(input)).searchParams.get('after_id');
        asked.push(after);
        return Response.json(pages[after ?? '']);
      },
    });
    expect(await paged.listModels('chave')).toEqual([
      { id: 'claude-a', displayName: 'A', maxInputTokens: 10, maxTokens: 5 },
      { id: 'claude-b', displayName: null, maxInputTokens: null, maxTokens: null },
      // capacidade fora do formato (zero, texto) vira "sem dado", nunca um valor inventado
      { id: 'claude-c', displayName: null, maxInputTokens: null, maxTokens: null },
    ]);
    expect(asked).toEqual([null, 'claude-a', 'claude-b']);

    // Cursor repetido: a API diz que há mais, mas devolve o mesmo last_id; a leitura para em vez de girar.
    let calls = 0;
    const stuck = createAnthropicClient({
      baseUrl: 'https://anthropic.invalido/v1',
      fetchImpl: async () => { calls += 1; return Response.json({ data: [{ id: 'claude-a' }], has_more: true, last_id: 'claude-a' }); },
    });
    expect((await stuck.listModels('chave')).map((model) => model.id)).toEqual(['claude-a', 'claude-a']);
    expect(calls).toBe(2);
  });

  it('classifica os cenários: 401 e 403 são chave inválida; o resto é serviço indisponível', async () => {
    expect(await outcome(client().listModels('invalid-key'))).toBe('PROVIDER_KEY_INVALID');
    expect(await outcome(client().listModels('forbidden-key'))).toBe('PROVIDER_KEY_INVALID');
    expect(await outcome(client().listModels('down-key'))).toBe('PROVIDER_UNAVAILABLE');
    expect(await outcome(client().listModels('html-key'))).toBe('PROVIDER_UNAVAILABLE');
    expect(await outcome(client().listModels('huge-key'))).toBe('PROVIDER_UNAVAILABLE');
    expect(await outcome(client().listModels('limited-key'))).toBe('PROVIDER_UNAVAILABLE');
  });

  it('timeout, rede fora do ar e redirecionamento (nunca seguido: a chave não é entregue a outro destino)', async () => {
    expect(await outcome(impatient().listModels('slow-key'))).toBe('PROVIDER_UNAVAILABLE');
    expect(await outcome(createAnthropicClient({ baseUrl: 'http://127.0.0.1:9' }).listModels('valid-key'))).toBe('PROVIDER_UNAVAILABLE');
    const before = upstreams.requests.length;
    expect(await outcome(client().listModels('redirect-key'))).toBe('PROVIDER_UNAVAILABLE');
    expect(upstreams.requests.slice(before).map((request) => request.service)).toEqual(['anthropic']);
  });

  it('a chave nunca vai ao log nem à mensagem de erro, mesmo quando o serviço a ecoa', async () => {
    const lines: string[] = [];
    const logger = { warn: (...args: unknown[]) => lines.push(JSON.stringify(args)), info: () => undefined, error: () => undefined, debug: () => undefined } as never;
    const failure = await createAnthropicClient({ baseUrl: upstreams.anthropicBaseUrl, timeoutMs: 5_000, logger }).listModels('leaky-chave-secreta').catch((error: unknown) => error as Error);
    expect((failure as DomainError).code).toBe('PROVIDER_KEY_INVALID');
    expect(`${(failure as Error).message}${lines.join('')}`).not.toContain('leaky-chave-secreta');
  });
});

describe('adaptador do Composio', () => {
  const client = () => createComposioClient({ baseUrl: upstreams.composioBaseUrl, timeoutMs: 5_000 });
  const impatient = () => createComposioClient({ baseUrl: upstreams.composioBaseUrl, timeoutMs: 300 }); // só o cenário de lentidão (E11)

  it('lista os apps com a chave em x-api-key e pede no máximo 100 contas', async () => {
    const apps = await client().listConnectedApps('valid-key');
    expect(apps.map((app) => app.slug)).toEqual(['github', 'gmail', 'google_calendar', 'slack']);
    expect(upstreams.requests.at(-1)).toMatchObject({ service: 'composio', path: '/composio/api/v3/connected_accounts', key: 'valid-key' });
  });

  it('lista TODAS as contas com o estado de cada uma, sem juntar por app, na ordem do Composio; as ativas seguem sendo as mesmas e na mesma ordem (phase 13)', async () => {
    const accounts = await client().listAccounts('valid-key');
    // Dois Gmail ativos e um GitHub pendente continuam separados (a leitura por app, `listConnectedApps`, junta e mostra só o melhor estado).
    expect(accounts.map((account) => [account.id, account.toolkitSlug, account.status])).toEqual([
      ['ca_1', 'gmail', 'active'],
      ['ca_2', 'github', 'pending'],
      ['ca_3', 'github', 'active'],
      ['ca_4', 'google_calendar', 'pending'],
      ['ca_5', 'slack', 'attention'],
      ['ca_6', 'gmail', 'active'],
    ]);
    expect(accounts[0]).toEqual({ id: 'ca_1', userId: 'usr_dono', toolkitSlug: 'gmail', toolkitName: 'Gmail', status: 'active' });
    expect(accounts[4]).toMatchObject({ toolkitName: 'Slack' });
    expect(upstreams.requests.at(-1)).toMatchObject({ service: 'composio', path: '/composio/api/v3/connected_accounts', key: 'valid-key' });
    // As ativas, filtradas da mesma lista, seguem na ordem do Composio: a primeira ativa de cada app (a conta que os bots usavam antes da phase 13) vem primeiro.
    expect(accounts.filter((account) => account.status === 'active').map((account) => account.id)).toEqual(['ca_1', 'ca_3', 'ca_6']);
    expect(await client().listAccounts('noapps-key')).toEqual([]);
  });

  it('a conta desabilitada vale como "requer atenção" e item sem id ou sem app fica de fora da lista de contas', async () => {
    const body = {
      items: [
        { id: 'ca_off', user_id: 'u', status: 'ACTIVE', is_disabled: true, toolkit: { slug: 'gmail' } },
        { id: 'ca_ok', status: 'ACTIVE', toolkit: { slug: 'google_calendar', name: ' Agenda ' } },
        { status: 'ACTIVE', toolkit: { slug: 'gmail' } },
        { id: 'ca_sem_app', status: 'ACTIVE' },
      ],
    };
    const fetchImpl = (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const accounts = await createComposioClient({ baseUrl: 'http://composio.local/api/v3', fetchImpl }).listAccounts('k');
    expect(accounts).toEqual([
      { id: 'ca_off', userId: 'u', toolkitSlug: 'gmail', toolkitName: 'Gmail', status: 'attention' },
      { id: 'ca_ok', userId: null, toolkitSlug: 'google_calendar', toolkitName: 'Agenda', status: 'active' },
    ]);
  });

  it('marca a leitura como TRUNCADA quando o Composio informa mais páginas (next_cursor), e só então; as contas lidas e o resto da lista não mudam (R9)', async () => {
    const items = [{ id: 'ca_1', status: 'ACTIVE', toolkit: { slug: 'gmail' } }];
    const read = async (extra: Record<string, unknown>) => {
      const fetchImpl = (async () => new Response(JSON.stringify({ items, ...extra }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
      return createComposioClient({ baseUrl: 'http://composio.local/api/v3', fetchImpl }).listAccounts('k');
    };
    // Com cursor (texto, ou qualquer valor não vazio): há mais contas além das lidas.
    for (const next_cursor of ['pagina-2', 42]) {
      const truncated = await read({ next_cursor });
      expect(truncated.truncated, JSON.stringify(next_cursor)).toBe(true);
      expect([...truncated]).toEqual([{ id: 'ca_1', userId: null, toolkitSlug: 'gmail', toolkitName: 'Gmail', status: 'active' }]);
    }
    // Sem cursor (ausente, nulo ou vazio) a leitura é completa: um array comum, sem a marca.
    for (const extra of [{}, { next_cursor: null }, { next_cursor: '' }]) {
      const complete = await read(extra);
      expect(complete.truncated, JSON.stringify(extra)).toBeUndefined();
      expect(complete).toEqual([{ id: 'ca_1', userId: null, toolkitSlug: 'gmail', toolkitName: 'Gmail', status: 'active' }]);
    }
    // O Composio falso responde uma página só: a leitura real dos testes nunca vem truncada.
    expect((await client().listAccounts('valid-key')).truncated).toBeUndefined();
  });

  it('o Composio falso confere a conta da execução: ca_6 executa, e a conta de outro app, a pendente e a inexistente são recusadas, todas anotadas em connectedAccountId', async () => {
    const run = (slug: string, connectedAccountId: string) => client().executeAction('valid-key', { slug, arguments: {}, connectedAccountId, userId: 'usr_dono' });
    expect(await run('GMAIL_FETCH_EMAILS', 'ca_6')).toEqual({ ok: true, data: { messages: [{ id: 'm1', subject: 'Olá' }] } });
    expect(upstreams.requests.at(-1)?.connectedAccountId).toBe('ca_6');
    for (const [slug, id, reason] of [
      ['GMAIL_FETCH_EMAILS', 'ca_3', 'does not belong'], // conta de outro app (GitHub ativa)
      ['GITHUB_CREATE_ISSUE', 'ca_2', 'not active'], // conta pendente (GitHub INITIATED)
      ['GMAIL_FETCH_EMAILS', 'ca_inexistente', 'not found'],
    ] as const) {
      expect(await run(slug, id), id).toMatchObject({ ok: false, error: expect.stringContaining(reason) });
      expect(upstreams.requests.at(-1)?.connectedAccountId, id).toBe(id);
    }
  });

  it('a execução leva o user_id da conta junto com o id dela; sem ele o Composio recusa e o motivo chega legível (T24, o erro do Gmail em produção)', async () => {
    const [gmail] = (await client().listAccounts('valid-key')).filter((account) => account.status === 'active' && account.toolkitSlug === 'gmail');
    expect(gmail).toEqual({ id: 'ca_1', userId: 'usr_dono', toolkitSlug: 'gmail', toolkitName: 'Gmail', status: 'active' });

    const ok = await client().executeAction('valid-key', { slug: 'GMAIL_FETCH_EMAILS', arguments: {}, connectedAccountId: gmail!.id, userId: gmail!.userId });
    expect(ok).toEqual({ ok: true, data: { messages: [{ id: 'm1', subject: 'Olá' }] } });
    expect(upstreams.requests.at(-1)?.body).toEqual({ connected_account_id: 'ca_1', user_id: 'usr_dono', version: 'latest', arguments: {} }); // a versão mais recente do app (T30)

    // Antes da correção a chamada saía só com a conta: o serviço recusava com o slug do log de produção.
    const refused = await client().executeAction('valid-key', { slug: 'GMAIL_FETCH_EMAILS', arguments: {}, connectedAccountId: 'ca_1', userId: null });
    expect(upstreams.requests.at(-1)?.body).toEqual({ connected_account_id: 'ca_1', version: 'latest', arguments: {} });
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining('Entity id is required') });
  });

  it('um app sem nenhuma ação "importante" (app MCP, como o Notion) oferece a lista geral dele, no mesmo teto (T26)', async () => {
    const urls: string[] = [];
    const tool = (slug: string) => ({ slug, name: slug, description: 'd', input_parameters: { type: 'object', properties: {} }, toolkit: { slug: 'notion_mcp', name: 'Notion' } });
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      const body = url.includes('important=true') ? { items: [] } : { items: [tool('NOTION_MCP_SEARCH'), tool('NOTION_MCP_FETCH')] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const tools = await createComposioClient({ baseUrl: 'http://composio.local/api/v3', fetchImpl }).listTools('k', 'notion_mcp');
    expect(tools.map((item) => item.slug)).toEqual(['NOTION_MCP_SEARCH', 'NOTION_MCP_FETCH']);
    expect(urls).toHaveLength(2); // primeiro com o filtro, depois sem ele, ambos limitados a 40 por app
    expect(urls[0]).toContain('toolkit_slug=notion_mcp&limit=40&toolkit_versions=latest&important=true');
    expect(urls[1]).toContain('toolkit_slug=notion_mcp&limit=40&toolkit_versions=latest');
    expect(urls[1]).not.toContain('important');

    // Com ações importantes, só elas valem (nenhuma segunda chamada): o comportamento dos apps curados não muda.
    urls.length = 0;
    const curated = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ items: [tool('GMAIL_SEND_EMAIL')] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    expect((await createComposioClient({ baseUrl: 'http://composio.local/api/v3', fetchImpl: curated }).listTools('k', 'gmail')).map((item) => item.slug)).toEqual(['GMAIL_SEND_EMAIL']);
    expect(urls).toHaveLength(1);
  });

  it('pede a versão MAIS RECENTE dos apps: sem ela a v3 usa a versão base, onde um app novo (Notion MCP) vem sem nenhuma ação (T30)', async () => {
    // O Composio como a v3 se comporta sem versão: o app novo só tem ações na versão mais recente; a base devolve lista vazia e 404 no slug.
    const tool = { slug: 'NOTION_MCP_SEARCH', name: 'Search', description: 'Procura no Notion.', input_parameters: { type: 'object', properties: {} }, toolkit: { slug: 'notion_mcp', name: 'Notion' } };
    const versioned = (async (url: string) => {
      const latest = new URL(url).searchParams.get('toolkit_versions') === 'latest';
      const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (new URL(url).pathname.endsWith('/tools')) return reply(200, { items: latest ? [tool] : [] });
      return latest ? reply(200, tool) : reply(404, { error: { message: 'tool not found' } });
    }) as unknown as typeof fetch;
    const composio = createComposioClient({ baseUrl: 'http://composio.local/api/v3', fetchImpl: versioned });
    expect((await composio.searchTools('k', 'notion_mcp', 'search', 8)).map((item) => item.slug)).toEqual(['NOTION_MCP_SEARCH']);
    expect((await composio.listTools('k', 'notion_mcp')).map((item) => item.slug)).toEqual(['NOTION_MCP_SEARCH']);
    expect(await composio.getTool('k', 'NOTION_MCP_SEARCH')).toMatchObject({ slug: 'NOTION_MCP_SEARCH', toolkitSlug: 'notion_mcp' });
  });

  it('busca ações por texto num app e obtém uma ferramenta pelo slug (T29): a consulta vai codificada, 404 é "não existe" e os erros do serviço são os de sempre', async () => {
    // Contra o Composio falso: a busca filtra por nome, slug ou descrição, e `getTool` devolve o app e o esquema da ação.
    const found = await client().searchTools('valid-key', 'gmail', 'email', 8);
    expect(found.map((tool) => tool.slug)).toEqual(['GMAIL_SEND_EMAIL', 'GMAIL_FETCH_EMAILS']);
    expect(await client().searchTools('valid-key', 'gmail', 'issue', 8)).toEqual([]);
    const tool = await client().getTool('valid-key', 'GMAIL_SEND_EMAIL');
    expect(tool).toMatchObject({ slug: 'GMAIL_SEND_EMAIL', name: 'Send Email', toolkitSlug: 'gmail', toolkitName: 'Gmail' });
    expect(tool?.inputSchema).toMatchObject({ type: 'object', required: ['to', 'subject', 'body'] });
    expect(await client().getTool('valid-key', 'ACAO_QUE_NAO_EXISTE')).toBeNull();

    // O endereço: app e consulta codificados (a consulta é texto do modelo), o limite pedido e a chave só no cabeçalho.
    const urls: string[] = [];
    const recording = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    await createComposioClient({ baseUrl: 'http://composio.local/api/v3', fetchImpl: recording }).searchTools('k', 'notion_mcp', 'criar página & "x"', 8);
    expect(urls).toEqual(['http://composio.local/api/v3/tools?toolkit_slug=notion_mcp&query=criar%20p%C3%A1gina%20%26%20%22x%22&limit=8&toolkit_versions=latest']);

    // Erros: chave recusada, serviço fora do ar e corpo fora do formato; o slug vai codificado na rota.
    const replying = (status: number, body = '{}') => (async () => new Response(body, { status })) as unknown as typeof fetch;
    const via = (fetchImpl: typeof fetch) => createComposioClient({ baseUrl: 'http://composio.local/api/v3', fetchImpl });
    expect(await outcome(via(replying(401)).getTool('k', 'X'))).toBe('CONNECTOR_KEY_INVALID');
    expect(await outcome(via(replying(500)).getTool('k', 'X'))).toBe('CONNECTOR_UNAVAILABLE');
    expect(await outcome(via(replying(200, '{"slug":42}')).getTool('k', 'X'))).toBe('CONNECTOR_UNAVAILABLE');
    expect(await outcome(via(replying(403)).searchTools('k', 'gmail', 'x', 8))).toBe('CONNECTOR_KEY_INVALID');
    expect(await outcome(via(replying(404)).searchTools('k', 'gmail', 'x', 8))).toBe('CONNECTOR_UNAVAILABLE'); // 404 na busca NÃO é "não existe"
    const oneTool = (async (url: string) => {
      urls.push(url);
      return new Response('{"slug":"A_B_C","name":"B"}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    await via(oneTool).getTool('k', 'A/B C');
    expect(urls.at(-1)).toBe('http://composio.local/api/v3/tools/A%2FB%20C?toolkit_versions=latest');
    // Sem o app no corpo, a ferramenta volta com o app vazio (quem usa não acha conta ativa e recusa a ação).
    expect((await via(replying(200, '{"slug":"X_Y","name":"Y"}')).getTool('k', 'X_Y'))?.toolkitSlug).toBe('');
  });

  it('classifica os cenários e nunca segue redirecionamento', async () => {
    expect(await outcome(client().listConnectedApps('invalid-key'))).toBe('CONNECTOR_KEY_INVALID');
    expect(await outcome(client().listConnectedApps('leaky-key'))).toBe('CONNECTOR_KEY_INVALID');
    expect(await outcome(client().listConnectedApps('down-key'))).toBe('CONNECTOR_UNAVAILABLE');
    expect(await outcome(client().listConnectedApps('html-key'))).toBe('CONNECTOR_UNAVAILABLE');
    expect(await outcome(impatient().listConnectedApps('slow-key'))).toBe('CONNECTOR_UNAVAILABLE');
    const before = upstreams.requests.length;
    expect(await outcome(client().listConnectedApps('redirect-key'))).toBe('CONNECTOR_UNAVAILABLE');
    expect(upstreams.requests.slice(before)).toHaveLength(1);
  });
});

describe('execução de ação do Composio: resultado desconhecido x recusa clara (R1)', () => {
  const request = { slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'a@b.com' }, connectedAccountId: 'ca_1', userId: 'usr_1' };
  const clientWith = (fetchImpl: typeof fetch) => createComposioClient({ baseUrl: 'http://composio.local/api/v3', fetchImpl });
  const replying = (status: number, body = '{}') => (async () => new Response(body, { status })) as unknown as typeof fetch;
  const unknown = { ok: false, error: ACTION_OUTCOME_UNKNOWN, outcomeUnknown: true };

  it('sem resposta confiável DEPOIS do envio a ação pode ter sido executada: falha de rede, prazo, 408, 5xx, 2xx ilegível e corpo enorme', async () => {
    const failing = (error: unknown) => (async () => { throw error; }) as unknown as typeof fetch;
    expect(await clientWith(failing(new TypeError('fetch failed'))).executeAction('k', request)).toEqual(unknown);
    expect(await clientWith(failing(new DOMException('prazo', 'TimeoutError'))).executeAction('k', request)).toEqual(unknown);
    for (const status of [408, 500, 502, 503, 504]) expect(await clientWith(replying(status)).executeAction('k', request), String(status)).toEqual(unknown);
    // 2xx com uma página no lugar do JSON (proxy no caminho): a ação provavelmente executou, mas não há prova.
    expect(await clientWith(replying(200, '<html>ok</html>')).executeAction('k', request)).toEqual(unknown);
    expect(await clientWith(replying(200, 'x'.repeat(2 * 1024 * 1024))).executeAction('k', request)).toEqual(unknown);
  });

  it('o que é recusa clara NÃO vira "desconhecido": 429 não executou, 401/403 é chave, 4xx e falha da ação são recusas', async () => {
    const code = async (promise: Promise<unknown>) => promise.then(() => 'ok', (error: unknown) => (error instanceof DomainError ? error.code : String(error)));
    expect(await code(clientWith(replying(429)).executeAction('k', request))).toBe('CONNECTOR_UNAVAILABLE');
    expect(await code(clientWith(replying(401)).executeAction('k', request))).toBe('CONNECTOR_KEY_INVALID');
    expect(await code(clientWith(replying(403)).executeAction('k', request))).toBe('CONNECTOR_KEY_INVALID');
    expect(await clientWith(replying(404)).executeAction('k', request)).toEqual({ ok: false, error: 'O Composio recusou a ação (HTTP 404).' });
    // Corpo que não é o erro estruturado do Composio (página de um proxy, texto, formato novo): sem motivo, só o status.
    for (const body of ['<html>erro</html>', 'texto solto', '{"error":"string solta"}', '[]', '{"error":{"message":42}}']) {
      expect(await clientWith(replying(400, body)).executeAction('k', request), body).toEqual({ ok: false, error: 'O Composio recusou a ação (HTTP 400).' });
    }
    expect(await clientWith(replying(200, '{"successful":false,"error":"Destinatário inválido"}')).executeAction('k', request)).toEqual({
      ok: false,
      error: 'Destinatário inválido',
    });
    expect(await clientWith(replying(200, '{"successful":true,"data":{"id":"m1"}}')).executeAction('k', request)).toEqual({ ok: true, data: { id: 'm1' } });
  });

  it('a recusa 4xx leva o MOTIVO do Composio ao bot (mensagem, sugestão e erros por campo), sem a chave, curto, e o log registra o request_id mas não o texto (T22)', async () => {
    const apiKey = 'ak_chave-secreta-do-teste';
    const refusal = (error: Record<string, unknown>) => JSON.stringify({ error: { code: 1, status: 400, ...error } });
    const logged: Array<Record<string, unknown>> = [];
    const logger = { warn: (fields: Record<string, unknown>) => logged.push(fields) } as unknown as NonNullable<Parameters<typeof createComposioClient>[0]['logger']>;
    const loud = (fetchImpl: typeof fetch) => createComposioClient({ baseUrl: 'http://composio.local/api/v3', fetchImpl, logger });

    const result = await loud(
      replying(400, refusal({ message: 'Invalid arguments for GMAIL_FETCH_EMAILS', slug: 'Tool_InputInvalid', request_id: 'req_123', suggested_fix: 'Envie max_results como número', errors: ['max_results: esperado inteiro', 'query: vazio'] })),
    ).executeAction(apiKey, request);
    expect(result).toEqual({
      ok: false,
      error: 'O Composio recusou a ação (HTTP 400): Invalid arguments for GMAIL_FETCH_EMAILS Sugestão: Envie max_results como número Detalhes: max_results: esperado inteiro; query: vazio',
    });
    expect(result).not.toHaveProperty('outcomeUnknown'); // é recusa clara: repetir com argumentos corrigidos é seguro
    // O log identifica o erro (status, ferramenta, slug e request_id) e NÃO leva o texto livre, que pode ecoar dados dos argumentos.
    expect(logged).toEqual([{ service: 'composio', status: 400, tool: 'GMAIL_SEND_EMAIL', errorSlug: 'Tool_InputInvalid', requestId: 'req_123' }]);
    expect(JSON.stringify(logged)).not.toContain('max_results');

    // Um campo com tipo inesperado descarta só ele: a mensagem continua chegando (errors como objetos, request_id numérico).
    const odd = await loud(replying(400, refusal({ message: 'Argumentos inválidos', errors: [{ field: 'query', message: 'vazio' }, 'texto'], request_id: 42, suggested_fix: 7 }))).executeAction(apiKey, request);
    expect(odd).toEqual({ ok: false, error: 'O Composio recusou a ação (HTTP 400): Argumentos inválidos Detalhes: texto' });

    // Um serviço que ecoa a chave na mensagem não a entrega ao bot nem ao log; quebras de linha e excesso de tamanho são tratados.
    logged.length = 0;
    const echoed = await loud(replying(422, refusal({ message: `chave ${apiKey}\ninválida\n\n  de novo ${apiKey}`, request_id: `r-${apiKey}` }))).executeAction(apiKey, request);
    expect(echoed).toEqual({ ok: false, error: 'O Composio recusou a ação (HTTP 422): chave *** inválida de novo ***' });
    expect(JSON.stringify(logged)).not.toContain(apiKey);
    const long = await loud(replying(400, refusal({ message: 'x'.repeat(5_000) }))).executeAction(apiKey, request);
    expect(long.ok === false && long.error.length).toBeLessThan(600);
  });

  it('parada do dono ou worker encerrando durante a espera sobe como aborto, sem virar "desconhecido" aqui (o executor trata)', async () => {
    const hanging = (async (_url: unknown, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))) as unknown as typeof fetch;
    const controller = new AbortController();
    const pending = clientWith(hanging).executeAction('k', request, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeDefined();
  });
});

describe('adaptador da Parallel (pesquisa na web)', () => {
  const client = () => createParallelClient({ baseUrl: upstreams.parallelBaseUrl, timeoutMs: 5_000 });
  const impatient = () => createParallelClient({ baseUrl: upstreams.parallelBaseUrl, timeoutMs: 300 }); // só o cenário de lentidão

  it('valida com UMA pesquisa mínima por JSON-RPC (tools/call web_search), a chave em Authorization: Bearer e só o objetivo e a consulta fixos', async () => {
    const before = upstreams.requests.length;
    await client().validateKey('valid-key');
    const sent = upstreams.requests.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ service: 'parallel', method: 'POST', path: '/parallel/mcp', key: 'valid-key' });
    // O falso responde 406 se o `accept` não listar JSON e stream de eventos: o sucesso acima já prova o cabeçalho.
    expect(sent[0]?.body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'web_search', arguments: { objective: expect.any(String), search_queries: [expect.any(String)] } },
    });
  });

  it('entende a resposta em stream de eventos (uma notificação e, por último, a resposta do JSON-RPC)', async () => {
    expect(await outcome(client().validateKey('stream-key'))).toBe('ok');
  });

  it('classifica: 401 e 403 são chave recusada; 429, 5xx, corpo fora do formato, erro do JSON-RPC, isError e corpo grande são indisponível', async () => {
    expect(await outcome(client().validateKey('invalid-key'))).toBe('WEB_SEARCH_KEY_INVALID');
    expect(await outcome(client().validateKey('forbidden-key'))).toBe('WEB_SEARCH_KEY_INVALID');
    expect(await outcome(client().validateKey('limited-key'))).toBe('WEB_SEARCH_UNAVAILABLE');
    expect(await outcome(client().validateKey('down-key'))).toBe('WEB_SEARCH_UNAVAILABLE');
    expect(await outcome(client().validateKey('html-key'))).toBe('WEB_SEARCH_UNAVAILABLE');
    expect(await outcome(client().validateKey('rpcerror-key'))).toBe('WEB_SEARCH_UNAVAILABLE');
    expect(await outcome(client().validateKey('toolerror-key'))).toBe('WEB_SEARCH_UNAVAILABLE');
    expect(await outcome(client().validateKey('huge-key'))).toBe('WEB_SEARCH_UNAVAILABLE');
  });

  it('prazo, conexão derrubada e rede fora do ar viram indisponível sem prender a chamada', async () => {
    const started = Date.now();
    expect(await outcome(impatient().validateKey('slow-key'))).toBe('WEB_SEARCH_UNAVAILABLE');
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await outcome(client().validateKey('drop-key'))).toBe('WEB_SEARCH_UNAVAILABLE');
    expect(await outcome(createParallelClient({ baseUrl: 'http://127.0.0.1:1/mcp', timeoutMs: 5_000 }).validateKey('valid-key'))).toBe('WEB_SEARCH_UNAVAILABLE');
  });

  it('redirecionamento nunca é seguido (a chave não é entregue a outro destino)', async () => {
    const before = upstreams.requests.length;
    expect(await outcome(client().validateKey('redirect-key'))).toBe('WEB_SEARCH_UNAVAILABLE');
    const after = upstreams.requests.slice(before);
    expect(after).toHaveLength(1);
    expect(after.some((request) => request.service !== 'parallel')).toBe(false);
  });

  it('nunca registra a chave nem o corpo de erro do serviço (mesmo quando ele a ecoa)', async () => {
    const logged: Array<Record<string, unknown>> = [];
    const logger = { warn: (fields: Record<string, unknown>, message: string) => logged.push({ ...fields, message }) } as unknown as NonNullable<Parameters<typeof createParallelClient>[0]['logger']>;
    const loud = createParallelClient({ baseUrl: upstreams.parallelBaseUrl, timeoutMs: 5_000, logger });
    const keys = ['leaky-parallel-key-1', 'down-parallel-key-2', 'html-parallel-key-3', 'rpcerror-parallel-key-4'];
    for (const key of keys) await outcome(loud.validateKey(key));
    expect(logged.length).toBeGreaterThan(0);
    const everything = JSON.stringify(logged);
    for (const secret of [...keys, 'Service unavailable', 'Invalid API key', 'Bem-vindo']) expect(everything).not.toContain(secret);
  });
});

describe('destinos de rede fixos na configuração', () => {
  const base: Env = {
    DATABASE_URL: 'postgres://aion:x@db:5432/aion',
    AION_OWNER_EMAIL: 'dono@aion.test',
    AION_OWNER_PASSWORD: 'senha-de-teste-do-dono-1',
    AION_MASTER_KEY: Buffer.alloc(32, 9).toString('base64'),
  };

  it('usa os serviços oficiais por padrão e tira a barra final das URLs configuradas', () => {
    expect(loadApiConfig(base)).toMatchObject({
      opencodeGoBaseUrl: 'https://opencode.ai/zen/go/v1',
      composioBaseUrl: 'https://backend.composio.dev/api/v3',
      parallelBaseUrl: 'https://search.parallel.ai/mcp',
      anthropicBaseUrl: 'https://api.anthropic.com/v1',
    });
    const custom = loadApiConfig({
      ...base,
      AION_OPENCODE_GO_BASE_URL: 'https://go.exemplo.test/v1/',
      AION_COMPOSIO_BASE_URL: 'http://127.0.0.1:4010/api/v3',
      AION_PARALLEL_BASE_URL: 'http://127.0.0.1:4011/mcp/',
      AION_ANTHROPIC_BASE_URL: 'http://127.0.0.1:4012/anthropic/v1/',
    });
    expect(custom.opencodeGoBaseUrl).toBe('https://go.exemplo.test/v1');
    expect(custom.anthropicBaseUrl).toBe('http://127.0.0.1:4012/anthropic/v1');
    expect(custom.composioBaseUrl).toBe('http://127.0.0.1:4010/api/v3');
    expect(custom.parallelBaseUrl).toBe('http://127.0.0.1:4011/mcp');
    // O worker lê o mesmo destino (as ferramentas de pesquisa da T9 rodam nele), com o mesmo padrão.
    const worker = { DATABASE_URL: base.DATABASE_URL, AION_MASTER_KEY: base.AION_MASTER_KEY };
    expect(loadWorkerConfig(worker).parallelBaseUrl).toBe('https://search.parallel.ai/mcp');
    expect(loadWorkerConfig({ ...worker, AION_PARALLEL_BASE_URL: 'https://parallel.exemplo.test/mcp/' }).parallelBaseUrl).toBe('https://parallel.exemplo.test/mcp');
    expect(loadWorkerConfig(worker).anthropicBaseUrl).toBe('https://api.anthropic.com/v1');
    expect(loadWorkerConfig({ ...worker, AION_ANTHROPIC_BASE_URL: 'https://anthropic.exemplo.test/v1/' }).anthropicBaseUrl).toBe('https://anthropic.exemplo.test/v1');
  });

  it('o endereço da Anthropic segue as mesmas regras (https ou loopback, sem credenciais, consulta nem fragmento) na api e no worker, sem ecoar o valor', () => {
    const invalid = ['http://anthropic.exemplo.test/v1', 'ftp://exemplo.test/v1', 'https://usuario:senha@exemplo.test/v1', 'https://exemplo.test/v1?token=abc', 'https://exemplo.test/v1#x', 'nao-e-url'];
    const worker = { DATABASE_URL: base.DATABASE_URL, AION_MASTER_KEY: base.AION_MASTER_KEY };
    for (const value of invalid) {
      for (const load of [() => loadApiConfig({ ...base, AION_ANTHROPIC_BASE_URL: value }), () => loadWorkerConfig({ ...worker, AION_ANTHROPIC_BASE_URL: value })]) {
        let message = '';
        try {
          load();
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message, value).toContain('AION_ANTHROPIC_BASE_URL inválida');
        expect(message).not.toContain(value);
      }
    }
  });

  it('recusa destino que não é https (fora do loopback), com credenciais, consulta ou lixo, sem ecoar o valor', () => {
    const invalid = [
      'http://opencode.exemplo.test/v1',
      'ftp://exemplo.test/v1',
      'https://usuario:senha@exemplo.test/v1',
      'https://exemplo.test/v1?token=abc',
      'https://exemplo.test/v1#x',
      'nao-e-url',
    ];
    for (const value of invalid) {
      let message = '';
      try {
        loadApiConfig({ ...base, AION_OPENCODE_GO_BASE_URL: value });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, value).toContain('AION_OPENCODE_GO_BASE_URL inválida');
      expect(message).not.toContain(value);
    }
  });

  it('o endereço da Parallel segue as mesmas regras (https ou loopback, sem credenciais, consulta nem fragmento) na api e no worker, sem ecoar o valor', () => {
    const invalid = ['http://parallel.exemplo.test/mcp', 'ftp://exemplo.test/mcp', 'https://usuario:senha@exemplo.test/mcp', 'https://exemplo.test/mcp?token=abc', 'https://exemplo.test/mcp#x', 'nao-e-url'];
    const worker = { DATABASE_URL: base.DATABASE_URL, AION_MASTER_KEY: base.AION_MASTER_KEY };
    for (const value of invalid) {
      for (const load of [() => loadApiConfig({ ...base, AION_PARALLEL_BASE_URL: value }), () => loadWorkerConfig({ ...worker, AION_PARALLEL_BASE_URL: value })]) {
        let message = '';
        try {
          load();
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message, value).toContain('AION_PARALLEL_BASE_URL inválida');
        expect(message).not.toContain(value);
      }
    }
  });
});

// Prova de A3 e C2 pela borda HTTP (T3): chaves do OpenCode Go e do Composio (e a opcional da Parallel, T8 da phase 1) validadas, gravadas cifradas e mostradas
// só mascaradas; nenhuma resposta, log, auditoria ou banco contém a chave em claro; sessão e CSRF exigidos; corpo
// estrito (nenhuma entrada do usuário escolhe destino de rede); rate limit de 10 validações por minuto.
// Os serviços externos são servidores HTTP falsos locais (`startFakeUpstreams`).
import { startFakeUpstreams, type FakeUpstreams } from '@aion/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORIGIN, createTestApi, type TestApi } from './testing/harness';

let upstreams: FakeUpstreams;
const apis: TestApi[] = [];

/** Sobe uma API nova (banco e limitador de taxa próprios) apontada para os serviços falsos. */
async function newApi(): Promise<TestApi> {
  const api = await createTestApi({
    AION_OPENCODE_GO_BASE_URL: upstreams.opencodeGoBaseUrl,
    AION_COMPOSIO_BASE_URL: upstreams.composioBaseUrl,
    AION_PARALLEL_BASE_URL: upstreams.parallelBaseUrl,
  });
  apis.push(api);
  return api;
}

beforeAll(async () => {
  upstreams = await startFakeUpstreams();
});

afterAll(async () => {
  await Promise.all(apis.map((api) => api.cleanup()));
  await upstreams.stop();
});

/** Cliente de teste autenticado: toda resposta (corpo e cabeçalhos) é guardada para a varredura de vazamento. */
async function authenticatedClient(api: TestApi) {
  const session = await api.login();
  const seen: string[] = [];
  const send = async (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) => {
    const response = await api.app.inject({
      method,
      url,
      headers: { cookie: session.cookie, origin: ORIGIN, 'x-csrf-token': session.csrfToken },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    seen.push(response.body, JSON.stringify(response.headers));
    return response;
  };
  return { send, seen, session };
}

describe('jornada das chaves pela API', () => {
  it('provedor e conector: valida, grava cifrado, mostra só mascarado, substitui sem perder a anterior e desconecta', async () => {
    const api = await newApi();
    const { send, seen } = await authenticatedClient(api);
    const keys = {
      invalid: 'invalid-provider-key-0001',
      down: 'down-provider-key-0002',
      first: 'valid-provider-key-ABCD',
      replaceInvalid: 'invalid-provider-key-0003',
      second: 'valid-provider-key-WXYZ',
      noApps: 'noapps-connector-key-1234',
      leaky: 'leaky-connector-key-9999',
      connector: 'valid-connector-key-5678',
    };

    // Estado inicial: nada configurado.
    const initial = await send('GET', '/api/credentials');
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({
      provider: { kind: 'provider', configured: false, masked: null, updatedAt: null, modelCount: null },
      connector: { kind: 'connector', configured: false, masked: null, updatedAt: null, modelCount: null },
      anthropic: { kind: 'anthropic', configured: false, masked: null, updatedAt: null, modelCount: null },
    });

    // Provedor: chave recusada (422) e serviço fora do ar (503) não gravam nada, com o envelope padrão.
    const invalid = await send('POST', '/api/credentials/provider', { key: keys.invalid });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toEqual({ code: 'PROVIDER_KEY_INVALID', message: 'Chave recusada pelo provedor.' });
    const down = await send('POST', '/api/credentials/provider', { key: keys.down });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toEqual({ code: 'PROVIDER_UNAVAILABLE', message: 'Provedor indisponível. Tente novamente.' });
    expect((await send('GET', '/api/credentials')).json().provider.configured).toBe(false);

    // Chave válida (com espaço e quebra de linha coladas nas pontas): a resposta tem só o estado mascarado.
    const saved = await send('POST', '/api/credentials/provider', { key: `  ${keys.first}\n` });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({
      kind: 'provider',
      configured: true,
      masked: '••••ABCD',
      updatedAt: expect.any(String),
      modelCount: 14,
    });
    // O provedor recebeu a chave sem as sobras das pontas.
    expect(upstreams.requests.at(-1)?.key).toBe(keys.first);
    expect((await send('GET', '/api/credentials')).json().provider).toMatchObject({ configured: true, masked: '••••ABCD' });

    // Substituição com chave recusada: a anterior continua valendo. Com chave válida: a nova assume.
    expect((await send('POST', '/api/credentials/provider', { key: keys.replaceInvalid })).statusCode).toBe(422);
    expect((await send('GET', '/api/credentials')).json().provider.masked).toBe('••••ABCD');
    const replaced = await send('POST', '/api/credentials/provider', { key: keys.second });
    expect(replaced.json().masked).toBe('••••WXYZ');
    // O servidor consegue usar a chave guardada (T5 a T7), decifrada, sem que ela passe por resposta alguma.
    expect(await api.credentials.revealKey('provider')).toBe(keys.second);

    // Desconectar é idempotente e devolve 204 sem corpo.
    const removed = await send('DELETE', '/api/credentials/provider');
    expect(removed.statusCode).toBe(204);
    expect(removed.body).toBe('');
    expect((await send('DELETE', '/api/credentials/provider')).statusCode).toBe(204);
    expect((await send('GET', '/api/credentials')).json().provider.configured).toBe(false);
    expect(await api.credentials.revealKey('provider')).toBeNull();

    // Conector: sem chave, a lista de contas responde "não configurado".
    const notConfigured = await send('GET', '/api/connector/accounts');
    expect(notConfigured.statusCode).toBe(409);
    expect(notConfigured.json()).toEqual({ code: 'CONNECTOR_NOT_CONFIGURED', message: 'Conecte o Composio.' });

    // Chave válida sem contas conectadas: salva e a lista de contas vem vazia.
    expect((await send('POST', '/api/credentials/connector', { key: keys.noApps })).json().masked).toBe('••••1234');
    expect((await send('GET', '/api/connector/accounts')).json()).toEqual({ accounts: [] });

    // Chave recusada cujo corpo de erro do serviço ecoa a chave: a resposta nossa não a repete.
    const leaky = await send('POST', '/api/credentials/connector', { key: keys.leaky });
    expect(leaky.statusCode).toBe(422);
    expect(leaky.json()).toEqual({ code: 'CONNECTOR_KEY_INVALID', message: 'Chave recusada pelo Composio.' });

    // Troca por chave com contas: a lista traz uma linha por conta, com o app e o estado de cada uma.
    await send('POST', '/api/credentials/connector', { key: keys.connector });
    const accounts = await send('GET', '/api/connector/accounts');
    expect(accounts.json().accounts.map((account: { appSlug: string; status: string }) => `${account.appSlug}:${account.status}`).sort()).toEqual([
      'github:active',
      'github:pending',
      'gmail:active',
      'gmail:active',
      'google_calendar:pending',
      'slack:attention',
    ]);
    expect((await send('DELETE', '/api/credentials/connector')).statusCode).toBe(204);
    expect((await send('GET', '/api/connector/accounts')).statusCode).toBe(409);

    // C2: nenhuma chave em claro em resposta, cabeçalho, log, banco ou auditoria.
    const stored = await api.pool.query(
      `SELECT (SELECT coalesce(jsonb_agg(to_jsonb(c)), '[]') FROM credentials c) AS credentials,
              (SELECT coalesce(jsonb_agg(to_jsonb(a)), '[]') FROM audit_log a) AS audit`,
    );
    const everywhere = [...seen, ...api.logs, JSON.stringify(stored.rows)].join('\n');
    for (const key of Object.values(keys)) expect(everywhere, key).not.toContain(key);

    // A auditoria registra a troca com as versões mascaradas (nova e anterior), sem a chave.
    const audit = await api.pool.query<{ action: string; outcome: string; target: string; details: Record<string, unknown> }>(
      "SELECT action, outcome, target, details FROM audit_log WHERE action LIKE 'credential.%' ORDER BY id",
    );
    expect(audit.rows.find((row) => row.details.masked === '••••WXYZ')).toMatchObject({
      action: 'credential.save',
      outcome: 'success',
      target: 'provider',
      details: { masked: '••••WXYZ', previousMasked: '••••ABCD', replaced: true },
    });
    expect(audit.rows.filter((row) => row.action === 'credential.disconnect').map((row) => [row.target, row.details])).toEqual([
      ['provider', { masked: '••••WXYZ' }],
      ['connector', { masked: '••••5678' }],
    ]);
  });
});

describe('chave opcional da pesquisa na web (Parallel) pela API', () => {
  it('valida, grava cifrada, mostra só mascarada na rota da pesquisa, substitui sem perder a anterior e desconecta', async () => {
    const api = await newApi();
    const { send, seen } = await authenticatedClient(api);
    const keys = {
      invalid: 'invalid-parallel-key-0001',
      leaky: 'leaky-parallel-key-0002',
      down: 'down-parallel-key-0003',
      limited: 'limited-parallel-key-0004',
      first: 'valid-parallel-key-ABCD',
      second: 'stream-parallel-key-WXYZ',
    };

    // Chave recusada (422), com o corpo de erro do serviço ecoando a chave, e serviço fora do ar ou limitado (503): nada é gravado.
    for (const key of [keys.invalid, keys.leaky]) {
      const refused = await send('POST', '/api/credentials/web_search', { key });
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toEqual({ code: 'WEB_SEARCH_KEY_INVALID', message: 'Chave recusada pela Parallel.' });
    }
    for (const key of [keys.down, keys.limited]) {
      const unavailable = await send('POST', '/api/credentials/web_search', { key });
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toEqual({ code: 'WEB_SEARCH_UNAVAILABLE', message: 'Não foi possível validar agora.' });
    }
    expect((await send('GET', '/api/settings/web-search')).json().key.configured).toBe(false);

    // Chave válida (com sobras nas pontas): a resposta tem só o estado mascarado; a Parallel recebeu a chave limpa, por uma única pesquisa.
    const before = upstreams.requests.length;
    const saved = await send('POST', '/api/credentials/web_search', { key: `  ${keys.first}\n` });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ kind: 'web_search', configured: true, masked: '••••ABCD', updatedAt: expect.any(String), modelCount: null });
    expect(upstreams.requests.slice(before).map((call) => `${call.service} ${call.method} ${call.path} ${call.key}`)).toEqual([`parallel POST /parallel/mcp ${keys.first}`]);
    expect((await send('GET', '/api/settings/web-search')).json()).toEqual({ enabled: true, key: saved.json() });
    // A visão geral das chaves de provedor, conector e Anthropic não traz a opcional.
    expect(Object.keys((await send('GET', '/api/credentials')).json()).sort()).toEqual(['anthropic', 'connector', 'provider']);

    // Substituição recusada não derruba a anterior; válida (em stream de eventos), a nova assume.
    expect((await send('POST', '/api/credentials/web_search', { key: keys.invalid })).statusCode).toBe(422);
    expect((await send('GET', '/api/settings/web-search')).json().key.masked).toBe('••••ABCD');
    expect((await send('POST', '/api/credentials/web_search', { key: keys.second })).json().masked).toBe('••••WXYZ');
    expect(await api.credentials.revealKey('web_search')).toBe(keys.second);

    // Desconectar é idempotente (204 sem corpo) e a pesquisa volta ao uso anônimo.
    const removed = await send('DELETE', '/api/credentials/web_search');
    expect(removed.statusCode).toBe(204);
    expect(removed.body).toBe('');
    expect((await send('DELETE', '/api/credentials/web_search')).statusCode).toBe(204);
    expect((await send('GET', '/api/settings/web-search')).json().key).toEqual({ kind: 'web_search', configured: false, masked: null, updatedAt: null, modelCount: null });
    expect(await api.credentials.revealKey('web_search')).toBeNull();

    // C2: nenhuma chave em claro em resposta, cabeçalho, log, banco ou auditoria.
    const stored = await api.pool.query(
      `SELECT (SELECT coalesce(jsonb_agg(to_jsonb(c)), '[]') FROM credentials c) AS credentials,
              (SELECT coalesce(jsonb_agg(to_jsonb(a)), '[]') FROM audit_log a) AS audit`,
    );
    const everywhere = [...seen, ...api.logs, JSON.stringify(stored.rows)].join('\n');
    for (const key of Object.values(keys)) expect(everywhere, key).not.toContain(key);

    // Auditoria: salvar, substituir e desconectar com a chave só mascarada (as recusas registram só o código).
    const audit = await api.pool.query<{ action: string; outcome: string; target: string; details: Record<string, unknown> }>(
      "SELECT action, outcome, target, details FROM audit_log WHERE action LIKE 'credential.%' AND outcome = 'success' ORDER BY id",
    );
    expect(audit.rows.map((row) => [row.action, row.target, row.details])).toEqual([
      ['credential.save', 'web_search', { masked: '••••ABCD', previousMasked: null, replaced: false }],
      ['credential.save', 'web_search', { masked: '••••WXYZ', previousMasked: '••••ABCD', replaced: true }],
      ['credential.disconnect', 'web_search', { masked: '••••WXYZ' }],
    ]);
  });

  it('o corpo é o mesmo das outras chaves (estrito) e o limite de 10 validações por minuto é compartilhado com elas', async () => {
    const api = await newApi();
    const { send } = await authenticatedClient(api);
    const before = upstreams.requests.length;
    for (const payload of [{}, { key: '' }, { key: 'k'.repeat(513) }, { key: 'chave com espaço' }, { key: 'valid-parallel-key-1111', url: 'http://169.254.169.254/' }]) {
      expect((await send('POST', '/api/credentials/web_search', payload)).statusCode, JSON.stringify(payload)).toBe(422);
    }
    expect(upstreams.requests.length).toBe(before); // recusado na borda: nem chega à Parallel

    // 5 validações da pesquisa e 5 do provedor esgotam o limite; a 11ª, de qualquer chave, volta 429 sem chamar o serviço.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await send('POST', '/api/credentials/web_search', { key: `invalid-parallel-key-${attempt}` })).statusCode).toBe(422);
      expect((await send('POST', '/api/credentials/provider', { key: `invalid-provider-key-${attempt}` })).statusCode).toBe(422);
    }
    const limited = await send('POST', '/api/credentials/web_search', { key: 'valid-parallel-key-1111' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(upstreams.requests.length - before).toBe(10);
  });
});

describe('bordas de segurança', () => {
  it('exige sessão e CSRF e, recusado, nem chega a chamar o serviço externo', async () => {
    const api = await newApi();
    const session = await api.login();
    const before = upstreams.requests.length;

    // Sem sessão (mesmo com Origin certo): 401 em todas as rotas.
    const anonymous = { origin: ORIGIN };
    for (const [method, url, payload] of [
      ['GET', '/api/credentials', undefined],
      ['POST', '/api/credentials/provider', { key: 'valid-provider-key-1111' }],
      ['DELETE', '/api/credentials/provider', undefined],
      ['GET', '/api/connector/accounts', undefined],
    ] as const) {
      const response = await api.app.inject({ method, url, headers: anonymous, ...(payload ? { payload } : {}) });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(response.json().code).toBe('AUTH_SESSION_EXPIRED');
    }

    // Com sessão, mas sem token CSRF ou com Origin errado: 403.
    const post = (headers: Record<string, string>) =>
      api.app.inject({
        method: 'POST',
        url: '/api/credentials/provider',
        headers: { cookie: session.cookie, ...headers },
        payload: { key: 'valid-provider-key-1111' },
      });
    expect((await post({ origin: ORIGIN })).json().code).toBe('CSRF_TOKEN_INVALID');
    expect((await post({ origin: 'https://evil.example', 'x-csrf-token': session.csrfToken })).json().code).toBe('CSRF_ORIGIN_INVALID');
    const del = await api.app.inject({ method: 'DELETE', url: '/api/credentials/provider', headers: { cookie: session.cookie, origin: ORIGIN } });
    expect(del.json().code).toBe('CSRF_TOKEN_INVALID');

    expect(upstreams.requests.length).toBe(before);
    expect((await api.pool.query('SELECT 1 FROM credentials')).rowCount).toBe(0);
  });

  it('A5: salvar e remover a chave da Anthropic sem sessão, sem Origin ou sem CSRF são recusados, nada é gravado nem chega à Anthropic, e o corpo é o mesmo estrito das outras chaves', async () => {
    // Valor FALSO sem a palavra "key" (a regra generic-api-key do gitleaks a confunde com segredo): o provedor falso nem chega a vê-lo, tudo é recusado antes.
    const candidate = 'valid-anthropic-1111';
    const api = await newApi();
    const session = await api.login();
    const before = upstreams.requests.length;

    // Sem sessão (mesmo com Origin certo): 401 em salvar e em remover.
    for (const [method, url, payload] of [
      ['POST', '/api/credentials/anthropic', { key: candidate }],
      ['DELETE', '/api/credentials/anthropic', undefined],
    ] as const) {
      const response = await api.app.inject({ method, url, headers: { origin: ORIGIN }, ...(payload ? { payload } : {}) });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(response.json().code).toBe('AUTH_SESSION_EXPIRED');
    }
    // Com sessão, mas sem CSRF ou com Origin de outro site: 403.
    const post = (headers: Record<string, string>) =>
      api.app.inject({ method: 'POST', url: '/api/credentials/anthropic', headers: { cookie: session.cookie, ...headers }, payload: { key: candidate } });
    expect((await post({ origin: ORIGIN })).json().code).toBe('CSRF_TOKEN_INVALID');
    expect((await post({ origin: 'https://evil.example', 'x-csrf-token': session.csrfToken })).json().code).toBe('CSRF_ORIGIN_INVALID');
    expect((await post({ 'x-csrf-token': session.csrfToken })).statusCode).toBeGreaterThanOrEqual(400); // sem Origin
    const del = await api.app.inject({ method: 'DELETE', url: '/api/credentials/anthropic', headers: { cookie: session.cookie, origin: ORIGIN } });
    expect(del.json().code).toBe('CSRF_TOKEN_INVALID');
    expect((await api.pool.query('SELECT 1 FROM credentials')).rowCount).toBe(0);
    expect(upstreams.requests.length).toBe(before);

    // O corpo estrito vale também para a Anthropic: campo extra ou destino de rede é recusado antes de qualquer chamada.
    const { send } = await authenticatedClient(api);
    for (const payload of [{}, { key: '' }, { key: 'k'.repeat(513) }, { key: candidate, baseUrl: 'http://127.0.0.1:9' }, { key: candidate, model: 'claude-opus-5-5' }]) {
      const refused = await send('POST', '/api/credentials/anthropic', payload);
      expect(refused.statusCode, JSON.stringify(payload).slice(0, 40)).toBe(422);
      expect(refused.json().code).toBe('VALIDATION_FAILED');
    }
    expect(upstreams.requests.length).toBe(before);
  });

  it('A5: remover acima de 60 por minuto volta 429 com Retry-After, não apaga nada e a rota segue protegida por sessão e CSRF', async () => {
    const api = await newApi();
    const { send } = await authenticatedClient(api);
    expect((await send('POST', '/api/credentials/provider', { key: 'valid-provider-key-8888' })).statusCode).toBe(200);
    for (let attempt = 0; attempt < 60; attempt += 1) expect((await send('DELETE', '/api/credentials/web_search')).statusCode).toBe(204);
    for (const kind of ['provider', 'anthropic']) {
      const limited = await send('DELETE', `/api/credentials/${kind}`);
      expect([kind, limited.statusCode, limited.json().code]).toEqual([kind, 429, 'RATE_LIMITED']);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(60);
    }
    // A chave continua gravada, e ler o estado segue liberado.
    expect((await send('GET', '/api/credentials')).json().provider).toMatchObject({ configured: true, masked: '••••8888' });
    expect(await api.credentials.revealKey('provider')).toBe('valid-provider-key-8888');
    // Sem sessão ou sem CSRF a remoção nem chega ao limite (recusa antes, como as demais).
    expect((await api.app.inject({ method: 'DELETE', url: '/api/credentials/provider', headers: { origin: ORIGIN } })).statusCode).toBe(401);
  });

  it('o corpo é estrito: só `key`, de 1 a 512 caracteres ASCII sem espaço; nenhuma URL ou destino entra por ali', async () => {
    const api = await newApi();
    const { send, seen } = await authenticatedClient(api);
    const before = upstreams.requests.length;

    const refused: [string, unknown][] = [
      ['corpo vazio', {}],
      ['chave vazia', { key: '' }],
      ['só espaços', { key: '   ' }],
      ['espaço no meio', { key: 'valid provider key' }],
      ['quebra de linha no meio (injeção de cabeçalho)', { key: 'valid-key\r\nx-injetado: 1' }],
      ['acima de 512 caracteres', { key: 'k'.repeat(513) }],
      ['fora do ASCII', { key: 'chave-çã-válida' }],
      ['tipo errado', { key: 12345 }],
      ['destino de rede por url', { key: 'valid-provider-key-1111', url: 'http://169.254.169.254/latest' }],
      ['destino de rede por baseUrl', { key: 'valid-provider-key-1111', baseUrl: 'http://127.0.0.1:9' }],
      ['campo extra comum', { key: 'valid-provider-key-1111', kind: 'connector' }],
    ];
    for (const [name, payload] of refused) {
      const response = await send('POST', '/api/credentials/provider', payload);
      expect(response.statusCode, name).toBe(422);
      expect(response.json().code, name).toBe('VALIDATION_FAILED');
    }
    // A resposta de validação não repete o que foi enviado (nem a chave, nem a URL).
    expect(seen.join('\n')).not.toMatch(/169\.254|127\.0\.0\.1:9|valid-provider-key-1111|injetado/);

    // Finalidade desconhecida na rota.
    expect((await send('POST', '/api/credentials/outro', { key: 'valid-provider-key-1111' })).statusCode).toBe(422);
    expect((await send('DELETE', '/api/credentials/outro')).statusCode).toBe(422);

    // Corpo acima de 256 KB é recusado pelo limite global.
    const huge = await send('POST', '/api/credentials/provider', { key: 'k'.repeat(300 * 1024) });
    expect(huge.statusCode).toBe(413);
    expect(huge.json().code).toBe('PAYLOAD_TOO_LARGE');

    // Nada disso chegou a um serviço externo.
    expect(upstreams.requests.length).toBe(before);
  });

  it('as únicas saídas de rede da API são os destinos fixos da configuração (OpenCode Go, Composio e Parallel)', async () => {
    const api = await newApi();
    const { send } = await authenticatedClient(api);
    const before = upstreams.requests.length;
    await send('POST', '/api/credentials/provider', { key: 'valid-provider-key-1111' });
    await send('POST', '/api/credentials/connector', { key: 'valid-connector-key-2222' });
    await send('GET', '/api/connector/accounts');
    await send('POST', '/api/credentials/web_search', { key: 'valid-parallel-key-3333' });
    const calls = upstreams.requests.slice(before);
    expect(calls.map((call) => `${call.service} ${call.method} ${call.path}`)).toEqual([
      'opencode-go GET /opencode-go/v1/models',
      'opencode-go POST /opencode-go/v1/chat/completions', // a sonda de chat que prova a chave do provedor (R8)
      'composio GET /composio/api/v3/connected_accounts',
      'composio GET /composio/api/v3/connected_accounts',
      'parallel POST /parallel/mcp', // a pesquisa mínima que prova a chave da Parallel (T8)
    ]);
  });

  it('limita a 10 validações por minuto: a 11ª volta 429 com Retry-After e não chama o serviço externo', async () => {
    const api = await newApi();
    const { send } = await authenticatedClient(api);
    const before = upstreams.requests.length;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await send('POST', '/api/credentials/provider', { key: `invalid-provider-key-${attempt}` });
      expect(response.statusCode).toBe(422);
    }
    const limited = await send('POST', '/api/credentials/provider', { key: 'valid-provider-key-1111' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ code: 'RATE_LIMITED', message: 'Muitas solicitações. Aguarde um instante e tente novamente.' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(upstreams.requests.length - before).toBe(10);
    // Ler o estado segue liberado.
    expect((await send('GET', '/api/credentials')).statusCode).toBe(200);
  });
});

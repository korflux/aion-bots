// Prova do prazo do cliente HTTP da web (E26): uma requisição que a API aceita e nunca responde vira NETWORK_ERROR depois do prazo, em vez
// de deixar a tela em "Carregando" para sempre. O `fetch` simulado respeita o `AbortSignal` como o do navegador.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from './api-client';

afterEach(() => vi.unstubAllGlobals());

/** `fetch` que nunca responde por conta própria: só termina quando o sinal de aborto dispara (como o do navegador). */
const hangingFetch = () =>
  vi.fn(
    (_path: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }),
  );

describe('prazo das chamadas à API', () => {
  it('uma requisição que nunca responde vira NETWORK_ERROR depois do prazo, e a chamada leva o sinal de aborto', async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);

    const started = Date.now();
    const error = await apiFetch('/api/bots', { timeoutMs: 50 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('uma resposta dentro do prazo passa normalmente', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await expect(apiFetch<{ ok: boolean }>('/api/bots', { timeoutMs: 5_000 })).resolves.toEqual({ ok: true });
  });
});

describe('saída voluntária e respostas atrasadas', () => {
  it('sessão vencida preserva o destino; marcar a saída antes do POST impede 401 tardio e redirecionamento direto de upload', async () => {
    // Módulo novo representa um documento novo, como os logins e logouts que sempre recarregam a página.
    vi.resetModules();
    const client = await import('./api-client');
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { pathname: '/configuracoes/conta-e-seguranca', search: '?origem=teste', assign } });
    const expired = () => new Response(JSON.stringify({ code: 'AUTH_SESSION_EXPIRED', message: 'Sessão expirada. Entre novamente.' }), { status: 401 });
    let respond!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { respond = resolve; })));

    const ordinary = client.apiFetch('/api/auth/sessions').catch((error: unknown) => error);
    respond(expired());
    expect(await ordinary).toMatchObject({ code: 'AUTH_SESSION_EXPIRED' });
    expect(assign).toHaveBeenCalledWith('/login?next=%2Fconfiguracoes%2Fconta-e-seguranca%3Forigem%3Dteste');
    assign.mockClear();

    const late = client.apiFetch('/api/auth/sessions').catch((error: unknown) => error);
    client.beginSignOut();
    respond(expired());
    expect(await late).toMatchObject({ code: 'AUTH_SESSION_EXPIRED' });
    client.redirectToLogin(); // Uploads possuem transporte próprio, mas usam este mesmo ponto de decisão.
    expect(assign).not.toHaveBeenCalled();

    vi.resetModules();
    const nextDocument = await import('./api-client');
    nextDocument.redirectToLogin();
    expect(assign).toHaveBeenCalledOnce();
  });
});

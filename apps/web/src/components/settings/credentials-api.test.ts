// Contrato do pedido de remoção da conta desconectada (phase 13, R8): DELETE sem corpo, id codificado na URL e CSRF da sessão; o 204 sem corpo resolve, e os erros do servidor chegam
// com o código estável que a tela usa para decidir entre "recarregar as contas" (tela desatualizada) e a mensagem segura da API.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectorAccountErrorMessage, isStaleAccountError, removeConnectorAccount } from './credentials-api';

afterEach(() => vi.unstubAllGlobals());

const refusal = (status: number, code: string, message: string) => new Response(JSON.stringify({ code, message }), { status });

describe('removeConnectorAccount', () => {
  it('envia DELETE à conta, com o id codificado, o CSRF e sem corpo, e resolve no 204', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(removeConnectorAccount('ca_a/b', 'csrf-token')).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('/api/connector/accounts/ca_a%2Fb');
    expect(init).toMatchObject({ method: 'DELETE', credentials: 'same-origin' });
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ 'x-csrf-token': 'csrf-token' });
  });

  it('a conta que o Composio ainda lista (409) e a já removida (404) são "tela desatualizada"; o Composio fora do ar mostra a mensagem segura da API', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(refusal(409, 'CONNECTOR_ACCOUNT_CONFLICT', 'As contas mudaram. Recarregue antes de salvar.'))
        .mockResolvedValueOnce(refusal(404, 'NOT_FOUND', 'Não encontrado.'))
        .mockResolvedValueOnce(refusal(503, 'CONNECTOR_UNAVAILABLE', 'Composio indisponível. Tente novamente.')),
    );
    const stale = await removeConnectorAccount('ca_1', 'csrf').catch((error: unknown) => error);
    const missing = await removeConnectorAccount('ca_1', 'csrf').catch((error: unknown) => error);
    const down = await removeConnectorAccount('ca_1', 'csrf').catch((error: unknown) => error);
    expect([isStaleAccountError(stale), isStaleAccountError(missing), isStaleAccountError(down)]).toEqual([true, true, false]);
    expect(connectorAccountErrorMessage(down, 'não usada')).toBe('Composio indisponível. Tente novamente.');
  });
});

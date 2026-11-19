// Prova da leitura única dos perfis de modelo: várias instâncias de `useModelEntry` (uma por barra de resposta) pedem os perfis ao mesmo tempo e só uma requisição sai; depois que ela
// termina, a próxima chamada lê de novo (o perfil de um modelo recém-testado não pode ficar preso à leitura anterior).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api-client', () => ({ apiFetch }));

import { fetchModelProfiles } from './models-api';

describe('fetchModelProfiles', () => {
  beforeEach(() => apiFetch.mockReset());

  it('várias chamadas ao mesmo tempo compartilham uma única requisição', async () => {
    apiFetch.mockResolvedValue({ models: [{ id: 'opencode/a' }] });
    const results = await Promise.all([fetchModelProfiles(), fetchModelProfiles(), fetchModelProfiles()]);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    for (const models of results) expect(models).toEqual([{ id: 'opencode/a' }]);
  });

  it('terminada a leitura, a chamada seguinte lê de novo; a falha também libera', async () => {
    apiFetch.mockResolvedValueOnce({ models: [] }).mockRejectedValueOnce(new Error('falhou')).mockResolvedValueOnce({ models: [{ id: 'opencode/b' }] });
    await fetchModelProfiles();
    await expect(fetchModelProfiles()).rejects.toThrow('falhou');
    expect(await fetchModelProfiles()).toEqual([{ id: 'opencode/b' }]);
    expect(apiFetch).toHaveBeenCalledTimes(3);
  });
});

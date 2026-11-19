// @vitest-environment jsdom
// Prova da leitura única dos perfis de modelo pelas barras de resposta (phase 18, passo 7): uma conversa monta várias `MessageActions`, cada uma com seu `ModelName` (que lê os
// perfis por `useModelEntry`), e só uma requisição de perfis sai; cada barra mostra o nome vindo dessa leitura única. `models-api.test.ts` prova a função isolada; aqui está o consumo real.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api-client', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/api-client')>()), apiFetch }));

import { TooltipProvider } from '@/components/ui/tooltip';
import { MessageActions } from './message-actions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('barras de resposta e a leitura de perfis de modelo', () => {
  afterEach(() => {
    apiFetch.mockReset();
    document.body.innerHTML = '';
  });

  it('várias barras de resposta montadas juntas fazem uma única chamada de perfis e todas mostram o nome lido', async () => {
    apiFetch.mockResolvedValue({ models: [{ id: 'anthropic/claude-haiku-5-5', displayName: 'Claude Haiku 5.5' }], recents: [] });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <TooltipProvider>
          {[1, 2, 3, 4].map((index) => (
            <MessageActions key={index} align="start" model="anthropic/claude-haiku-5-5" />
          ))}
        </TooltipProvider>,
      );
    });
    // Deixa a promessa compartilhada resolver e as quatro barras reagirem a ela.
    await act(async () => {
      await Promise.resolve();
    });
    const profileCalls = apiFetch.mock.calls.filter(([path]) => path === '/api/models/profiles');
    expect(profileCalls).toHaveLength(1);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    const names = [...host.querySelectorAll('[data-message-actions] span[title]')].map((node) => node.getAttribute('title'));
    expect(names).toHaveLength(4);
    expect(new Set(names).size).toBe(1);
    expect(names[0]).toContain('Claude Haiku 5.5');
    await act(async () => root.unmount());
  });
});

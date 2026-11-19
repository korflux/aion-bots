// Chamadas da web à API da memória (F11, T8). Único lugar que conhece esses caminhos. A memória global e a de um bot têm o mesmo
// formato de rotas (muda só o prefixo), então as funções recebem o escopo. Toda alteração leva o token CSRF da sessão.
import type { MemoryVersionDetail, MemoryVersionList, MemoryView } from '@aion/shared';
import { apiFetch } from '@/lib/api-client';

/** Qual memória a tela está mostrando. */
export type MemoryScope = { kind: 'global' } | { kind: 'bot'; botId: string };

const baseOf = (scope: MemoryScope): string => (scope.kind === 'global' ? '/api/memory/global' : `/api/bots/${scope.botId}/memory`);

export const fetchMemory = (scope: MemoryScope): Promise<MemoryView> => apiFetch<MemoryView>(baseOf(scope));

/** Salva o texto sobre a versão que a tela carregou; `MEMORY_CONFLICT` se a memória mudou desde então. */
export const saveMemory = (scope: MemoryScope, content: string, expectedVersion: number, csrfToken: string): Promise<MemoryView> =>
  apiFetch<MemoryView>(baseOf(scope), { method: 'PUT', body: { content, expectedVersion }, csrfToken });

export const fetchMemoryVersions = (scope: MemoryScope): Promise<MemoryVersionList> => apiFetch<MemoryVersionList>(`${baseOf(scope)}/versions`);

export const fetchMemoryVersion = (scope: MemoryScope, version: number): Promise<MemoryVersionDetail> =>
  apiFetch<MemoryVersionDetail>(`${baseOf(scope)}/versions/${version}`);

/** Restaura uma versão antiga como versão nova. */
export const restoreMemoryVersion = (scope: MemoryScope, version: number, expectedVersion: number, csrfToken: string): Promise<MemoryView> =>
  apiFetch<MemoryView>(`${baseOf(scope)}/restore`, { method: 'POST', body: { version, expectedVersion }, csrfToken });

/** Desfazer pelo cartão "Memória atualizada" da conversa do bot. */
export const undoMemoryCard = (botId: string, cardId: string, csrfToken: string): Promise<MemoryView> =>
  apiFetch<MemoryView>(`/api/bots/${botId}/memory/undo`, { method: 'POST', body: { cardId }, csrfToken });

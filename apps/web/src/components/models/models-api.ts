// Chamadas da web à API de modelos (F8). Único lugar que conhece os caminhos /api/models; o seletor só chama estas
// funções. O navegador nunca fala com o provedor: a lista, o teste e os favoritos passam pelo servidor, que guarda a chave.
import type { ModelEntry, ModelList } from '@aion/shared';
import { apiFetch } from '@/lib/api-client';

/** A lista do servidor: os modelos de cada provedor com chave (favorito, último teste, nome, preço, oculto) e os ids dos recentes (A26). O seletor separa favoritos, recentes e grupos. */
export const fetchModelCatalog = (): Promise<ModelList> => apiFetch<ModelList>('/api/models');

/** Só os modelos da lista do servidor, em ordem natural por provedor. */
export const fetchModels = (): Promise<ModelEntry[]> => fetchModelCatalog().then((list) => list.models);

/** Leitura de perfis em andamento, compartilhada por quem a pede enquanto ela não termina (ver `fetchModelProfiles`). */
let profilesInFlight: Promise<ModelEntry[]> | null = null;

/**
 * Perfis persistidos para resolver favoritos/capacidade sem descobrir catálogo externo. Chamadas feitas enquanto uma leitura está em andamento recebem a MESMA promessa (uma requisição
 * só para todas as barras de resposta da conversa, via `useModelEntry`); ao terminar, certo ou errado, a próxima chamada lê de novo, então o perfil recém-testado de um modelo escolhido
 * depois nunca fica preso a uma leitura velha (por isso é dedup de requisição em voo, não cache).
 */
export const fetchModelProfiles = (): Promise<ModelEntry[]> => {
  profilesInFlight ??= apiFetch<ModelList>('/api/models/profiles')
    .then((list) => list.models)
    .finally(() => {
      profilesInFlight = null;
    });
  return profilesInFlight;
};

/** Testa o modelo (primeira seleção ou "testar novamente"); o servidor grava o resultado e o devolve. */
export const testModel = (model: string, csrfToken: string): Promise<ModelEntry> =>
  apiFetch<ModelEntry>('/api/models/test', { method: 'POST', body: { model }, csrfToken });

/** Oculta ou reexibe o modelo (curadoria em Conexões, A7): oculto sai das escolhas novas, mas o que já o usa continua funcionando. */
export const setModelHidden = (model: string, hidden: boolean, csrfToken: string): Promise<ModelEntry> =>
  apiFetch<ModelEntry>('/api/models/hidden', { method: 'PATCH', body: { model, hidden }, csrfToken });

/** Marca ou desmarca o favorito. */
export const setModelFavorite = (model: string, favorite: boolean, csrfToken: string): Promise<ModelEntry> =>
  apiFetch<ModelEntry>('/api/models/favorite', { method: 'PATCH', body: { model, favorite }, csrfToken });

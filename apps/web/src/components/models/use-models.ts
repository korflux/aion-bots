'use client';

// Carrega a lista de modelos enquanto o seletor está aberto. Reabrir busca de novo (favoritos e resultados de teste
// podem ter mudado em outra aba), mas a lista anterior continua na tela enquanto isso: só a primeira carga mostra o
// esqueleto. `upsert` troca uma linha pelo que o servidor devolveu de um teste ou favorito, sem recarregar tudo. `recents` (A26) são os ids dos modelos usados mais recentemente, só no
// catálogo (os perfis persistidos não os trazem). `useModelEntry` dá a um gatilho a entrada de UM modelo (nome do provedor, oculto), lida dos perfis, sem consultar o provedor.
import type { ModelEntry } from '@aion/shared';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiErrorMessage } from '@/lib/api-client';
import { fetchModelCatalog, fetchModelProfiles } from './models-api';

export type ModelsState =
  | { status: 'loading' }
  | { status: 'ready'; models: ModelEntry[]; recents: string[] }
  | { status: 'error'; message: string; notConfigured: boolean };

/** O seletor descobre catálogo ao abrir; consumidores de contexto leem somente metadados persistidos. */
export function useModels(enabled: boolean, source: 'catalog' | 'profiles' = 'catalog'): { state: ModelsState; upsert: (entry: ModelEntry) => void; reload: () => void } {
  const [state, setState] = useState<ModelsState>({ status: 'loading' });
  // Incrementar dispara nova busca ("Tentar novamente").
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (source === 'profiles' ? fetchModelProfiles().then((models) => ({ models, recents: [] as string[] })) : fetchModelCatalog().then((list) => ({ models: list.models, recents: list.recents ?? [] }))).then(
      ({ models, recents }) => {
        if (!cancelled) setState({ status: 'ready', models, recents });
      },
      (error: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', message: apiErrorMessage(error), notConfigured: error instanceof ApiError && error.code === 'PROVIDER_NOT_CONFIGURED' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, attempt, source]);

  const upsert = useCallback((entry: ModelEntry) => {
    setState((current) =>
      current.status === 'ready' ? { status: 'ready', models: current.models.map((model) => (model.id === entry.id ? entry : model)), recents: current.recents } : current,
    );
  }, []);

  const reload = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((value) => value + 1);
  }, []);

  return { state, upsert, reload };
}

/**
 * A entrada de um modelo para o gatilho que o mostra (composer, campo de modelo): o nome do provedor e se está oculto. Lê os perfis persistidos (sem consultar o provedor); `null` enquanto carrega, sem
 * modelo ou quando o perfil ainda não existe (modelo nunca testado nem favoritado). O gatilho mostra o id local até a entrada chegar.
 */
export function useModelEntry(model: string | null): ModelEntry | null {
  // A leitura guarda de QUAL modelo ela é: a entrada de um modelo antigo nunca vale para o novo enquanto a releitura não chega.
  const [loaded, setLoaded] = useState<{ model: string; entry: ModelEntry | null } | null>(null);
  // Relê a cada troca de modelo: o perfil do modelo recém-escolhido (testado no momento da escolha) não estava na leitura anterior. Várias barras de resposta montadas juntas
  // compartilham a mesma requisição em voo (`fetchModelProfiles`), então a conversa faz uma leitura só.
  useEffect(() => {
    if (model === null) return;
    let cancelled = false;
    fetchModelProfiles().then(
      (models) => {
        if (!cancelled) setLoaded({ model, entry: models.find((candidate) => candidate.id === model) ?? null });
      },
      () => {
        if (!cancelled) setLoaded({ model, entry: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [model]);
  return model !== null && loaded?.model === model ? loaded.entry : null;
}

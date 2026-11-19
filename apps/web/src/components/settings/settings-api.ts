// Chamadas da web à API das preferências gerais: idioma das respostas dos bots e fuso horário (T28), a pesquisa na web (phase 1, T8) e o estado do
// Python (phase 4, F11). Único lugar que conhece /api/settings. A gravação leva o token CSRF da sessão e o servidor devolve o estado como ficou.
import type { AppSettings, PythonStatus, WebSearchSettings, ContextPreferencesView, ContextPreferenceUpdate } from '@aion/shared';
import { apiFetch } from '@/lib/api-client';

export const fetchAppSettings = (): Promise<AppSettings> => apiFetch<AppSettings>('/api/settings');

/**
 * Escolhas independentes de contexto: as janelas por escopo e o "Modelo do resumo" (nulo = o modelo de cada conversa). Cada gravação altera UMA delas
 * (a janela de um escopo ou o modelo do resumo) e o servidor devolve o conjunto como ficou; nunca reenvia idioma, fuso ou uma cópia desatualizada das outras.
 */
export const fetchContextPreferences = (): Promise<ContextPreferencesView> => apiFetch('/api/settings/context');
export const saveContextPreference = (input: ContextPreferenceUpdate, csrfToken: string): Promise<ContextPreferencesView> =>
  apiFetch('/api/settings/context', { method: 'PUT', body: input, csrfToken });

export const saveAppSettings = (settings: AppSettings, csrfToken: string): Promise<AppSettings> =>
  apiFetch<AppSettings>('/api/settings', { method: 'PUT', body: settings, csrfToken });

/** O interruptor da pesquisa na web e o estado MASCARADO da chave opcional da Parallel (a chave inteira nunca vem do servidor). */
export const fetchWebSearchSettings = (): Promise<WebSearchSettings> => apiFetch<WebSearchSettings>('/api/settings/web-search');

/** Liga ou desliga a pesquisa na web; vale a partir da próxima execução. Salvar, substituir e desconectar a chave são as chamadas de `credentials-api`. */
export const saveWebSearchEnabled = (enabled: boolean, csrfToken: string): Promise<WebSearchSettings> =>
  apiFetch<WebSearchSettings>('/api/settings/web-search', { method: 'PUT', body: { enabled }, csrfToken });

/** Estado do Python (disponível, não instalado ou indisponível agora), conferido pelo servidor a cada leitura; o endereço e o token do sandbox nunca vêm. */
export const fetchPythonStatus = (): Promise<PythonStatus> => apiFetch<PythonStatus>('/api/settings/python');

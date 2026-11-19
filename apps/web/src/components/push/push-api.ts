// Chamadas da web à API do push (F14; T10). Único lugar que conhece esses caminhos. Toda alteração leva o token CSRF da sessão. O token do
// dispositivo só SAI daqui (no registro) e nunca volta: a lista traz apenas id, rótulo e datas.
import type { PushConfig, PushContentSet, PushContentSettings, PushDevice, PushMuteSet, PushMuteTarget, PushPreferences } from '@aion/shared';
import { apiFetch } from '@/lib/api-client';

/** Configuração pública do Firebase (ou `enabled: false`). */
export const fetchPushConfig = (): Promise<PushConfig> => apiFetch<PushConfig>('/api/push/config');

export const fetchPushDevices = async (): Promise<PushDevice[]> => (await apiFetch<{ devices: PushDevice[] }>('/api/push/devices')).devices;

/** Registra (ou renova) o dispositivo pelo token do FCM. Idempotente: a mesma chamada devolve o mesmo dispositivo. */
export const registerPushDevice = (token: string, csrfToken: string): Promise<PushDevice> =>
  apiFetch<PushDevice>('/api/push/devices', { method: 'POST', body: { token }, csrfToken });

export const removePushDevice = (id: string, csrfToken: string): Promise<undefined> =>
  apiFetch(`/api/push/devices/${encodeURIComponent(id)}`, { method: 'DELETE', csrfToken });

/** A matriz de silenciar (T13): os bots ativos e o Chat geral, cada um com os tipos silenciados. */
export const fetchPushPreferences = async (): Promise<PushMuteTarget[]> => (await apiFetch<PushPreferences>('/api/push/preferences')).targets;

/** Silencia ou volta a receber UM tipo de uma origem (`botId: null` = Chat geral). Devolve a linha da matriz já atualizada. */
export const setPushMute = (change: PushMuteSet, csrfToken: string): Promise<PushMuteTarget> =>
  apiFetch<PushMuteTarget>('/api/push/preferences', { method: 'PUT', body: change, csrfToken });

/** Estado das chaves "Mostrar conteúdo" (phase 16): bots e Chat geral, ligadas por padrão. */
export const fetchPushContent = (): Promise<PushContentSettings> => apiFetch<PushContentSettings>('/api/push/content');

/** Liga ou desliga UMA origem (estado final, idempotente). Devolve o estado das duas chaves já gravado. */
export const setPushContent = (change: PushContentSet, csrfToken: string): Promise<PushContentSettings> =>
  apiFetch<PushContentSettings>('/api/push/content', { method: 'PUT', body: change, csrfToken });

/**
 * "App aberto" (phase 3, T4; F3, Suposição 7): o servidor grava o instante da abertura (o dele, que só avança), e os avisos anteriores deixam
 * de ser enviados e de aparecer em qualquer aparelho. Sem corpo. Não marca conversa nenhuma como lida. Sessão vencida não leva ao login
 * daqui: a falha nunca chega ao dono (o shell cuida da sessão), e a próxima abertura tenta de novo.
 */
export const recordAppOpen = (csrfToken: string): Promise<undefined> =>
  apiFetch('/api/push/opened', { method: 'PUT', csrfToken, redirectOnExpired: false });

// Id do dispositivo para o service worker (phase 16): o worker reporta o que fez com cada aviso (`POST /api/push/receipts`) e precisa saber qual dispositivo
// é este. A Cache API existe na página e no worker (o `sw.js`, estático, repete estas duas constantes e só lê), sem esquema nem versão para guardar uma
// string. A página grava ao registrar o dispositivo e apaga ao removê-lo; sem o valor o worker simplesmente não reporta. Melhor esforço: nunca lança.
const DEVICE_STATE_CACHE = 'aion-push-device';
const DEVICE_STATE_KEY = '/__aion/push-device';

/** Guarda (ou, com `null`, apaga) o id do dispositivo deste navegador onde o service worker o lê. */
export async function rememberPushDevice(deviceId: string | null): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    if (deviceId === null) {
      await caches.delete(DEVICE_STATE_CACHE);
      return;
    }
    const cache = await caches.open(DEVICE_STATE_CACHE);
    await cache.put(DEVICE_STATE_KEY, new Response(JSON.stringify({ deviceId }), { headers: { 'content-type': 'application/json' } }));
  } catch {
    // Sem armazenamento disponível (navegação privada, cota): o worker segue sem reportar.
  }
}

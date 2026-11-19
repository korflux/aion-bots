// Estado do push neste navegador (T10, F14): a função pura que decide, a partir do que o servidor oferece e do que o navegador permite,
// em qual dos estados da spec ("não ativado, ativado, negado pelo navegador") o dono está. Fica separada do provedor (efeitos) para ser
// provada sem navegador. Os estados que só existem DURANTE uma ação (`enabling`, `error`) e o resultado da sincronização (`active`) são
// atribuídos pelo provedor.
import type { PushConfig } from '@aion/shared';

export type PushStatus =
  /** Ainda lendo a configuração do servidor e a permissão do navegador (o servidor e a primeira renderização do cliente coincidem aqui). */
  | 'loading'
  /** O servidor não tem o Firebase configurado: não há o que ativar, e a web não mostra aviso nenhum. */
  | 'unconfigured'
  /** Navegador sem service worker, PushManager ou Notification (ex.: Safari do iPhone fora da PWA instalada). */
  | 'unsupported'
  /** Não ativado: permissão ainda não pedida, ou concedida mas o dono removeu este dispositivo. */
  | 'off'
  /** A permissão foi negada no navegador: só o dono libera, nas configurações do site (`PUSH_PERMISSION_DENIED`). */
  | 'denied'
  /** Permissão já concedida: renovando o registro do token em silêncio (o token do FCM pode girar). */
  | 'syncing'
  /** O dono clicou em "Ativar": pedindo a permissão e registrando. */
  | 'enabling'
  /** Dispositivo registrado: recebe os avisos. */
  | 'active'
  /** A ativação falhou (rede, FCM): o dono pode tentar de novo. */
  | 'error';

export interface PushEnvironment {
  /** Configuração do servidor; `null` enquanto ainda não chegou. */
  config: PushConfig | null;
  /** O navegador suporta push (ver `pushSupported`). */
  supported: boolean;
  permission: NotificationPermission;
  /** O dono removeu ESTE dispositivo da lista: a sincronização silenciosa não o registra de novo até ele ativar outra vez. */
  optedOut: boolean;
}

/** Estado inicial depois de ler o servidor e o navegador. */
export function initialPushStatus({ config, supported, permission, optedOut }: PushEnvironment): PushStatus {
  if (config === null) return 'loading';
  if (!config.enabled) return 'unconfigured';
  if (!supported) return 'unsupported';
  if (permission === 'denied') return 'denied';
  if (permission === 'granted' && !optedOut) return 'syncing';
  return 'off';
}

/** O navegador tem o necessário para receber push (só chamar no cliente). */
export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

const OPT_OUT_KEY = 'aion:push-opt-out';
const NOTICE_DISMISSED_KEY = 'aion:push-notice-dismissed';

/** Conveniência por navegador (nunca estado que precise persistir): o armazenamento pode estar bloqueado, então tudo é tolerante a falha. */
function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    if (on) window.localStorage.setItem(key, '1');
    else window.localStorage.removeItem(key);
  } catch {
    // Sem armazenamento, a escolha só vale até recarregar a página.
  }
}

export const isOptedOut = (): boolean => readFlag(OPT_OUT_KEY);
export const setOptedOut = (on: boolean): void => writeFlag(OPT_OUT_KEY, on);
export const isNoticeDismissed = (): boolean => readFlag(NOTICE_DISMISSED_KEY);
export const dismissNotice = (): void => writeFlag(NOTICE_DISMISSED_KEY, true);

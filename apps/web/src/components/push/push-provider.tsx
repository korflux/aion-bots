'use client';

// Provedor do push neste navegador (F14; T10): lê o que o servidor oferece (`GET /api/push/config`) e o que o navegador permite, mantém o
// estado (`PushStatus`) e executa as duas ações do dono: ativar (pedir a permissão, obter o token do FCM e registrar o dispositivo) e
// remover um dispositivo da lista. O id do dispositivo registrado fica guardado onde o service worker o lê (`rememberPushDevice`), para ele reportar o que fez
// com cada aviso (phase 16), e é apagado na remoção. Também registra o service worker do app (`/sw.js`) assim que o shell carrega, porque ele é o que faz o
// navegador oferecer a instalação da PWA, com ou sem push configurado.
//
// Sincronização silenciosa: com a permissão já concedida (e o dono não tendo removido este dispositivo), cada carga renova o registro do token,
// porque o FCM pode girá-lo; sem isso um token novo nunca chegaria ao servidor e os avisos parariam. Remover ESTE dispositivo apaga o token
// no FCM e liga um marcador local, para a sincronização não registrá-lo de novo contra a vontade do dono.
//
// Abertura do app (phase 3, T4; F3, Suposição 7): sempre que a página fica visível (carga já visível, volta do segundo plano ou do bloqueio
// de tela), avisa o servidor ("app aberto") e fecha as notificações do Aion exibidas neste aparelho (`close-notifications.ts`, a mesma peça que a decisão de uma aprovação
// na tela e a abertura de uma conversa usam para fechar só as suas). Independe de o push estar ativo aqui:
// abrir o app num aparelho sem push também encerra os avisos dos outros. Não marca conversa nenhuma como lida.
import type { FirebaseWebConfig, PushConfig } from '@aion/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSession } from '@/lib/session-context';
import { closeAllNotifications } from './close-notifications';
import { activeServiceWorker, obtainFcmToken, releaseFcmToken } from './fcm-token';
import { fetchPushConfig, recordAppOpen, registerPushDevice, rememberPushDevice, removePushDevice } from './push-api';
import { initialPushStatus, isOptedOut, pushSupported, setOptedOut, type PushStatus } from './push-state';

interface PushContextValue {
  status: PushStatus;
  /** Id do dispositivo registrado por ESTE navegador (para a lista marcar "Este dispositivo"); nulo se não está registrado. */
  deviceId: string | null;
  /** Pede a permissão e registra este navegador. Só deve ser chamada por um clique do dono (o navegador exige o gesto). */
  enable: () => Promise<void>;
  /** Remove um dispositivo da lista; se for este navegador, apaga o token no FCM e deixa de se registrar sozinho. */
  removeDevice: (id: string) => Promise<void>;
}

const PushContext = createContext<PushContextValue | null>(null);

export function PushProvider({ children }: { children: ReactNode }) {
  const { csrfToken } = useSession();
  const [status, setStatus] = useState<PushStatus>('loading');
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const configRef = useRef<Extract<PushConfig, { enabled: true }> | null>(null);

  /** Obtém o token e o registra no servidor. Qualquer falha vira `error` (o dono tenta de novo pelo botão). */
  const register = useCallback(
    async (config: { firebase: FirebaseWebConfig; vapidKey: string }) => {
      try {
        const token = await obtainFcmToken(config.firebase, config.vapidKey);
        const device = await registerPushDevice(token, csrfToken);
        setDeviceId(device.id);
        void rememberPushDevice(device.id); // o service worker reporta o que fez com cada aviso por este id (phase 16)
        setStatus('active');
      } catch {
        setStatus('error');
      }
    },
    [csrfToken],
  );

  useEffect(() => {
    let cancelled = false;
    if ('serviceWorker' in navigator) void activeServiceWorker().catch(() => undefined);
    fetchPushConfig().then(
      (config) => {
        if (cancelled) return;
        configRef.current = config.enabled ? config : null;
        const next = initialPushStatus({
          config,
          supported: pushSupported(),
          permission: 'Notification' in window ? Notification.permission : 'default',
          optedOut: isOptedOut(),
        });
        setStatus(next);
        if (next === 'syncing' && config.enabled) void register(config);
      },
      // Sem a configuração não há o que oferecer; o aviso simplesmente não aparece (a próxima carga tenta de novo).
      () => {
        if (!cancelled) setStatus('unconfigured');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [register]);

  // Abertura do app: só na carga com a página visível e na TRANSIÇÃO para visível (o evento também dispara ao ocultar, e aí não faz nada),
  // então o limite do servidor (10 por minuto por sessão) só é atingido alternando o app sem parar; o excesso é recusado e ignorado aqui.
  useEffect(() => {
    const opened = () => {
      if (document.visibilityState !== 'visible') return;
      void closeAllNotifications(); // fecha as do Aion exibidas neste aparelho (`close-notifications.ts`, melhor esforço)
      recordAppOpen(csrfToken).catch(() => undefined);
    };
    opened();
    document.addEventListener('visibilitychange', opened);
    return () => document.removeEventListener('visibilitychange', opened);
  }, [csrfToken]);

  const enable = useCallback(async () => {
    const config = configRef.current;
    if (!config) return;
    setStatus('enabling');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setStatus(permission === 'denied' ? 'denied' : 'off');
        return;
      }
      setOptedOut(false);
      await register(config);
    } catch {
      setStatus('error');
    }
  }, [register]);

  const removeDevice = useCallback(
    async (id: string) => {
      await removePushDevice(id, csrfToken);
      if (id !== deviceId) return;
      setOptedOut(true);
      setDeviceId(null);
      void rememberPushDevice(null);
      setStatus('off');
      if (configRef.current) await releaseFcmToken(configRef.current.firebase);
    },
    [csrfToken, deviceId],
  );

  const value = useMemo(() => ({ status, deviceId, enable, removeDevice }), [status, deviceId, enable, removeDevice]);
  return <PushContext value={value}>{children}</PushContext>;
}

/** Estado e ações do push (só existe dentro do shell autenticado). */
export function usePush(): PushContextValue {
  const value = useContext(PushContext);
  if (!value) throw new Error('usePush fora do PushProvider');
  return value;
}

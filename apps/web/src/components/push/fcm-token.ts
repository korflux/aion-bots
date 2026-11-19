// Obtém (e devolve) o token de push deste navegador junto ao FCM, com o SDK do Firebase. É o ÚNICO ponto da web que conhece o Firebase, e
// ele só é carregado quando o dono ativa as notificações (ou quando elas já estão ativas), por importação dinâmica: quem nunca ativa não
// baixa o SDK. O SDK contata só `firebaseinstallations.googleapis.com` e `fcmregistrations.googleapis.com`, os dois domínios que a CSP libera.
//
// O service worker é o `public/sw.js` do próprio app (que mostra a notificação e abre o cartão): ele é registrado aqui e passado ao SDK,
// em vez do `firebase-messaging-sw.js` que o SDK procuraria por padrão.
import type { FirebaseWebConfig } from '@aion/shared';

/** Registro ATIVO do service worker do app (espera ele assumir; o `ready` do navegador só resolve com um worker ativo). */
export async function activeServiceWorker(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  return navigator.serviceWorker.ready;
}

/** Instância do Firebase Messaging para esta configuração (o app do Firebase é criado uma vez por página). */
async function messagingFor(config: FirebaseWebConfig) {
  const [{ getApp, getApps, initializeApp }, { getMessaging }] = await Promise.all([import('@firebase/app'), import('@firebase/messaging')]);
  return getMessaging(getApps().length > 0 ? getApp() : initializeApp(config));
}

/** Pede ao FCM o token deste navegador (o SDK guarda o token e o renova sozinho quando precisa). A permissão já deve estar concedida. */
export async function obtainFcmToken(config: FirebaseWebConfig, vapidKey: string): Promise<string> {
  const { getToken } = await import('@firebase/messaging');
  const [messaging, serviceWorkerRegistration] = await Promise.all([messagingFor(config), activeServiceWorker()]);
  const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration });
  if (!token) throw new Error('o FCM não devolveu um token');
  return token;
}

/** Apaga o token deste navegador no FCM (o dono removeu o dispositivo). Melhor esforço: a remoção no servidor já vale por si. */
export async function releaseFcmToken(config: FirebaseWebConfig): Promise<void> {
  try {
    const { deleteToken } = await import('@firebase/messaging');
    await deleteToken(await messagingFor(config));
  } catch {
    // Sem rede ou sem token local: o servidor já deixou de enviar para este dispositivo.
  }
}

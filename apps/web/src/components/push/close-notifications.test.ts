// Prova do fechamento das notificações do Aion pela página (phase 16, passo 5; A10): decidir uma aprovação na tela fecha a notificação DELA (tag por aprovação), abrir a
// conversa fecha as da conversa (resposta, rotina e aprovação, pelo caminho de abertura guardado nelas), abrir o app fecha todas, e a falta de service worker ou a falha do
// navegador nunca lança. O que se observa é o efeito: quais notificações ficaram na bandeja simulada.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeAllNotifications, closeApprovalNotification, closeConversationNotifications } from './close-notifications';

const BOT = '4380ae7e-11a7-4110-98f3-f2767965bfa1';
const SESSION = '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

/** Instala um `navigator.serviceWorker` simulado com a bandeja dada e devolve as tags que continuam nela. */
function installTray(items: Array<{ tag: string; data?: unknown }>) {
  const tray = [...items];
  const registration = {
    getNotifications: async () => tray.map((item) => ({ ...item, close: () => void tray.splice(tray.indexOf(item), 1) })),
  };
  vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => registration } });
  return () => tray.map((item) => item.tag);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fechamento das notificações do Aion', () => {
  it('decidir uma aprovação fecha só a notificação dela (a tag é exata: 50 não fecha 501)', async () => {
    const left = installTray([{ tag: 'aion-approval-501' }, { tag: 'aion-approval-5011' }, { tag: 'aion-approval-502' }, { tag: `aion-activity-${BOT}` }]);
    await closeApprovalNotification('501');
    expect(left()).toEqual(['aion-approval-5011', 'aion-approval-502', `aion-activity-${BOT}`]);
  });

  it('abrir a conversa fecha as notificações dela pelo caminho de abertura, com ou sem a consulta, e deixa as outras conversas', async () => {
    const left = installTray([
      { tag: `aion-activity-${BOT}`, data: { url: `/bots/${BOT}?mensagem=42` } },
      { tag: 'aion-approval-501', data: { url: `/bots/${BOT}?mensagem=43` } },
      { tag: 'aion-activity-outro', data: { url: '/bots/00000000-0000-4000-8000-000000000000?mensagem=1' } },
      { tag: `aion-activity-${SESSION}`, data: { url: `/chat/${SESSION}?mensagem=9` } },
      { tag: 'sem-dado' },
      { tag: 'url-ilegivel', data: { url: 12 } },
    ]);
    await closeConversationNotifications({ kind: 'bot', id: BOT });
    expect(left()).toEqual(['aion-activity-outro', `aion-activity-${SESSION}`, 'sem-dado', 'url-ilegivel']);

    await closeConversationNotifications({ kind: 'session', id: SESSION });
    expect(left()).toEqual(['aion-activity-outro', 'sem-dado', 'url-ilegivel']);
  });

  it('abrir o app fecha todas', async () => {
    const left = installTray([{ tag: 'a' }, { tag: 'b', data: { url: '/' } }]);
    await closeAllNotifications();
    expect(left()).toEqual([]);
  });

  it('sem service worker, sem registro ou com o navegador falhando nada lança', async () => {
    vi.stubGlobal('navigator', {});
    await expect(closeAllNotifications()).resolves.toBeUndefined();
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => undefined } });
    await expect(closeApprovalNotification('1')).resolves.toBeUndefined();
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => { throw new Error('recusado'); } } });
    await expect(closeConversationNotifications({ kind: 'bot', id: BOT })).resolves.toBeUndefined();
  });
});

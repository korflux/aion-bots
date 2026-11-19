// Prova do estado do push neste navegador (F14; T10): cada combinação do que o servidor oferece com o que o navegador permite leva ao estado
// certo da spec ("não ativado, ativado, negado pelo navegador"), e remover o dispositivo impede a sincronização silenciosa de registrá-lo
// de novo.
import type { PushConfig } from '@aion/shared';
import { describe, expect, it } from 'vitest';
import { initialPushStatus, type PushEnvironment } from './push-state';

const ENABLED: PushConfig = { enabled: true, firebase: { apiKey: 'k', projectId: 'p', messagingSenderId: '1', appId: 'a' }, vapidKey: 'v'.repeat(30) };
const base: PushEnvironment = { config: ENABLED, supported: true, permission: 'default', optedOut: false };

describe('estado inicial do push', () => {
  it.each<[string, Partial<PushEnvironment>, string]>([
    ['sem a resposta do servidor ainda', { config: null }, 'loading'],
    ['servidor sem Firebase: nada a oferecer, mesmo com permissão concedida', { config: { enabled: false }, permission: 'granted' }, 'unconfigured'],
    ['navegador sem suporte a push', { supported: false }, 'unsupported'],
    ['permissão negada: só o dono libera nas configurações do navegador', { permission: 'denied' }, 'denied'],
    ['permissão negada vence a escolha de remover o dispositivo', { permission: 'denied', optedOut: true }, 'denied'],
    ['permissão ainda não pedida', { permission: 'default' }, 'off'],
    ['permissão concedida: renova o registro do token em silêncio', { permission: 'granted' }, 'syncing'],
    ['permissão concedida, mas o dono removeu este dispositivo: não se registra sozinho', { permission: 'granted', optedOut: true }, 'off'],
  ])('%s', (_description, override, expected) => {
    expect(initialPushStatus({ ...base, ...override })).toBe(expected);
  });
});

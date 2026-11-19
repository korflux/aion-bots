// Prova da lista de chats de uma linha (phase 18, A22 a A24): o HTML de `ChatPanel` no servidor, com o store trocado por sessões fixas e o relógio em 2026-11-14 12:00 UTC. "Novo chat"
// no topo, as seções "Salvos" e "Recentes", só o título e a bolinha em cada linha, UM aviso da retenção sob "Recentes" e o relógio só na linha a que falta 1 dia ou menos, com a data
// exata no nome acessível. O hover, o foco e o toque no relógio (tooltip) são do E2E (`e2e/general-chat.spec.ts`). Renderização no servidor, sem DOM.
import type { ChatSession } from '@aion/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ChatPanel } from './chat-panel';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const state = vi.hoisted(() => ({ sessions: [] as unknown[] }));

vi.mock('next/navigation', () => ({ usePathname: () => '/chat/zz', useRouter: () => ({ push: () => undefined, replace: () => undefined }) }));
vi.mock('@/lib/use-now', () => ({ useNow: () => Date.parse('2026-11-14T12:00:00.000Z') }));
vi.mock('./chat-store', async (importOriginal) => ({ ...(await importOriginal<typeof import('./chat-store')>()), useLiveChatSessions: () => ({ status: 'ready', sessions: state.sessions }) }));
vi.mock('./use-new-session', () => ({ useNewSession: () => ({ open: async () => undefined, busy: false, failed: false }) }));

const session = (id: string, title: string, patch: Partial<ChatSession> = {}): ChatSession =>
  ({ id, title, saved: false, unread: false, lastActivityAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 6 * DAY).toISOString(), ...patch }) as ChatSession;

const render = (): string =>
  renderToStaticMarkup(
    <TooltipProvider>
      <ChatPanel />
    </TooltipProvider>,
  );

describe('lista de chats (A22 a A24)', () => {
  beforeEach(() => {
    state.sessions = [
      session('a', 'Chat de ontem'),
      session('b', 'Chat guardado', { saved: true, expiresAt: null }),
      session('c', 'Chat quase apagado', { unread: true, expiresAt: new Date(NOW + 60 * 60_000).toISOString() }),
      session('d', 'Chat com 2 dias', { expiresAt: new Date(NOW + 2 * DAY).toISOString() }),
    ];
  });

  it('"Novo chat" abre o painel e as seções vêm na ordem Salvos, aviso e Recentes, com o aviso uma única vez', () => {
    const html = render();
    const positions = ['Novo chat', 'Salvos', 'Recentes', 'Apagados 7 dias após a última mensagem', 'Chat guardado', 'Chat de ontem'].map((text) => html.indexOf(text));
    expect(positions.every((position) => position > -1)).toBe(true);
    expect(html.indexOf('Novo chat')).toBeLessThan(html.indexOf('Salvos'));
    expect(html.indexOf('Salvos')).toBeLessThan(html.indexOf('Chat guardado'));
    expect(html.indexOf('Chat guardado')).toBeLessThan(html.indexOf('Recentes'));
    expect(html.indexOf('Recentes')).toBeLessThan(html.indexOf('Apagados 7 dias'));
    expect(html.indexOf('Apagados 7 dias')).toBeLessThan(html.indexOf('Chat de ontem'));
    expect(html.match(/Apagados 7 dias/g)).toHaveLength(1);
  });

  it('cada linha mostra só o título e a bolinha de não lido: nada de "apaga em N dias"', () => {
    const html = render();
    expect(html).not.toContain('apaga em');
    expect(html.match(/data-testid="unread-dot"/g)).toHaveLength(1);
    expect(html).toContain('Novidades não lidas');
  });

  it('o relógio aparece só na sessão a que falta 1 dia ou menos, com a data exata no nome acessível', () => {
    const html = render();
    const clocks = [...html.matchAll(/aria-label="(Apaga em [^"]*)"/g)].map((match) => match[1]);
    expect(clocks).toHaveLength(1);
    expect(clocks[0]).toMatch(/14\/11\/2026/);
    expect(html.indexOf('Chat quase apagado')).toBeLessThan(html.indexOf('Apaga em'));
  });

  it('sem sessão não salva não há aviso nem seção Recentes', () => {
    state.sessions = [session('b', 'Chat guardado', { saved: true, expiresAt: null })];
    const html = render();
    expect(html).not.toContain('Apagados 7 dias');
    expect(html).not.toContain('Recentes');
    expect(html).toContain('Salvos');
  });
});

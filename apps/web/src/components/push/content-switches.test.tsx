// @vitest-environment jsdom
// Prova das chaves "Mostrar conteúdo" de Configurações → Notificações (phase 16, passo 7; A13) com o DOM real (jsdom) e a API trocada por um servidor FALSO em memória na fronteira
// `fetch`: o `apiFetch` e o cliente `push-api.ts` rodam de verdade, então o CSRF e o corpo da gravação também são provados. O que se observa é o que o dono vê e faz:
// - as duas chaves existem, cada uma com o rótulo como nome acessível, o estado que o servidor tem (ligadas por padrão) e a ajuda do que o desligado significa;
// - ligar ou desligar grava na hora, só aquela origem, e o estado PERSISTE (uma tela nova lê o que o servidor guardou);
// - a falha devolve a chave ao valor anterior e o foco continua na chave (o botão não perde o foco durante a gravação, `aria-disabled` em vez de `disabled`);
// - o teclado (foco e Espaço/Enter pelo clique do botão nativo) alcança as chaves.
// O axe, o contraste dos tokens (TOK-01) e as larguras de 1440 e 375 px são do E2E (`e2e/notifications.spec.ts`), que renderiza a tela com o CSS real.
import type { PushContentSettings, SessionInfo } from '@aion/shared';
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '@/lib/session-context';
import { ContentSwitches } from './content-switches';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION: SessionInfo = { owner: { email: 'dono@example.com' }, sessionId: '5b1f9c0e-3c1d-4f6e-8a7b-2d4e6f8a0b1c', csrfToken: 'csrf-token-de-teste' };
const BOTS = 'Mostrar conteúdo nos avisos dos bots';
const CHAT = 'Mostrar conteúdo nos avisos do Chat geral';

interface Call {
  method: string;
  path: string;
  body: unknown;
  csrf: string | null;
}

/** O servidor falso das chaves: guarda o estado, valida o CSRF como a API e pode atrasar ou recusar a gravação. */
function makeServer(initial: PushContentSettings = { bots: true, generalChat: true }) {
  const state = { ...initial };
  const calls: Call[] = [];
  const control: { failNextWrite: boolean; hold: Promise<void> | null } = { failNextWrite: false, hold: null };
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  async function handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const csrf = headers['x-csrf-token'] ?? null;
    calls.push({ method, path: url.pathname, body, csrf });
    if (url.pathname !== '/api/push/content') return reply(404, { code: 'NOT_FOUND', message: 'Não encontrado.' });
    if (method === 'GET') return reply(200, state);
    if (csrf !== SESSION.csrfToken) return reply(403, { code: 'CSRF_TOKEN_INVALID', message: 'Token de segurança inválido. Recarregue a página.' });
    if (control.hold) await control.hold;
    if (control.failNextWrite) {
      control.failNextWrite = false;
      return reply(500, { code: 'INTERNAL_ERROR', message: 'Algo deu errado.' });
    }
    const { origin, enabled } = body as { origin: 'bots' | 'general_chat'; enabled: boolean };
    if (origin === 'bots') state.bots = enabled;
    else state.generalChat = enabled;
    return reply(200, state);
  }

  return { state, calls, control, handle, writes: () => calls.filter((call) => call.method !== 'GET') };
}

const mounted: Array<{ root: ReturnType<typeof createRoot>; container: HTMLElement }> = [];
let server = makeServer();

beforeEach(() => {
  server = makeServer();
  vi.stubGlobal('fetch', vi.fn(server.handle));
});

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

/** Renderiza dentro da sessão (CSRF) e espera a leitura inicial. */
async function mount(ui: ReactElement = <ContentSwitches />) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => root.render(<SessionProvider session={SESSION}>{ui}</SessionProvider>));
  await act(async () => {
    await vi.waitFor(() => expect(container.querySelector('[role="switch"]')).not.toBeNull(), { timeout: 4000, interval: 20 });
  });
  return container;
}

const switchOf = (container: HTMLElement, name: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find((item) => item.getAttribute('aria-label') === name);
  if (!found) throw new Error(`Chave "${name}" não encontrada.`);
  return found;
};
const click = (element: HTMLElement) => act(async () => element.click());
/** Espera a gravação terminar em passos curtos de `act`: as respostas da API só viram tela quando o `act` fecha, então a espera não pode ficar dentro de um `act` só. */
const settled = async () => {
  for (let step = 0; step < 150 && document.querySelector('[aria-busy="true"]') !== null; step += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  expect(document.querySelector('[aria-busy="true"]')).toBeNull();
};

describe('A13: chaves "Mostrar conteúdo" em Notificações', () => {
  it('as duas chaves existem com o rótulo como nome acessível, ligadas por padrão, e a ajuda diz o que o desligado faz e o que é do Android', async () => {
    const container = await mount();
    const bots = switchOf(container, BOTS);
    const chat = switchOf(container, CHAT);
    expect(bots.getAttribute('aria-checked')).toBe('true');
    expect(chat.getAttribute('aria-checked')).toBe('true');
    // São botões nativos (alcançáveis por Tab, acionáveis por Espaço e Enter) com a área de toque de 44 px do kit.
    expect(bots.tagName).toBe('BUTTON');
    expect(bots.className).toContain('h-11');
    // O rótulo é texto visível na tela, e não só o nome acessível.
    expect(container.textContent).toContain(BOTS);
    expect(container.textContent).toContain(CHAT);
    // A ajuda: desligado = aviso genérico e sem botões de aprovação; a tela bloqueada é do Android.
    const text = container.textContent ?? '';
    expect(text).toMatch(/desligad[oa][^.]*genérico/i);
    expect(text).toMatch(/sem os botões Aprovar e Recusar/i);
    expect(text).toMatch(/tela bloqueada[^.]*Android/i);
    expect(server.writes()).toEqual([]); // abrir a tela não grava nada
  });

  it('mostra o estado que o servidor tem (uma chave desligada de antes aparece desligada)', async () => {
    server = makeServer({ bots: false, generalChat: true });
    vi.stubGlobal('fetch', vi.fn(server.handle));
    const container = await mount();
    expect(switchOf(container, BOTS).getAttribute('aria-checked')).toBe('false');
    expect(switchOf(container, CHAT).getAttribute('aria-checked')).toBe('true');
  });

  it('desligar grava na hora só aquela origem, com o CSRF, e o estado persiste: uma tela nova lê o que o servidor guardou', async () => {
    const container = await mount();
    await click(switchOf(container, BOTS));
    await settled();

    expect(switchOf(container, BOTS).getAttribute('aria-checked')).toBe('false');
    expect(switchOf(container, CHAT).getAttribute('aria-checked')).toBe('true');
    expect(server.writes()).toEqual([{ method: 'PUT', path: '/api/push/content', body: { origin: 'bots', enabled: false }, csrf: SESSION.csrfToken }]);
    expect(server.state).toEqual({ bots: false, generalChat: true });

    // Persistência: outra montagem (recarregar a tela) lê o estado gravado.
    const reloaded = await mount();
    expect(switchOf(reloaded, BOTS).getAttribute('aria-checked')).toBe('false');
    expect(switchOf(reloaded, CHAT).getAttribute('aria-checked')).toBe('true');

    // Voltar a ligar também grava e persiste; o Chat geral é uma origem à parte.
    await click(switchOf(reloaded, CHAT));
    await settled();
    await click(switchOf(reloaded, BOTS));
    await settled();
    expect(server.writes().map((call) => call.body)).toEqual([
      { origin: 'bots', enabled: false },
      { origin: 'general_chat', enabled: false },
      { origin: 'bots', enabled: true },
    ]);
    expect(server.state).toEqual({ bots: true, generalChat: false });
  });

  it('durante a gravação a chave ignora cliques e continua focada; se a gravação falhar, volta ao valor anterior', async () => {
    const container = await mount();
    const bots = switchOf(container, BOTS);
    bots.focus();
    let release!: () => void;
    server.control.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.control.failNextWrite = true;

    await click(bots);
    // Valor novo na tela de imediato, gravação em andamento: `aria-busy` e `aria-disabled` (não `disabled`, que tiraria o foco do teclado).
    expect(switchOf(container, BOTS).getAttribute('aria-checked')).toBe('false');
    expect(switchOf(container, BOTS).getAttribute('aria-busy')).toBe('true');
    expect(switchOf(container, BOTS).getAttribute('aria-disabled')).toBe('true');
    expect(switchOf(container, BOTS).disabled).toBe(false);
    expect(document.activeElement).toBe(switchOf(container, BOTS));
    await click(switchOf(container, BOTS)); // ignorado enquanto grava
    expect(server.writes()).toHaveLength(1);

    release();
    await settled();
    expect(switchOf(container, BOTS).getAttribute('aria-checked')).toBe('true'); // a falha devolveu o valor anterior
    expect(switchOf(container, BOTS).getAttribute('aria-busy')).toBeNull();
    expect(document.activeElement).toBe(switchOf(container, BOTS));
    expect(server.state).toEqual({ bots: true, generalChat: true }); // o servidor não mudou
  });

  it('a falha ao carregar mostra o erro com "Tentar novamente", sem chave que pareça ligada ou desligada', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'INTERNAL_ERROR', message: 'Algo deu errado.' }), { status: 500, headers: { 'content-type': 'application/json' } })));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    await act(async () => root.render(<SessionProvider session={SESSION}><ContentSwitches /></SessionProvider>));
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull(), { timeout: 4000, interval: 20 });
    });
    expect(container.querySelectorAll('[role="switch"]')).toHaveLength(0);
    expect([...container.querySelectorAll('button')].map((item) => item.textContent)).toContain('Tentar novamente');
  });
});

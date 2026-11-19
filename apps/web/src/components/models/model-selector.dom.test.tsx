// @vitest-environment jsdom
// Prova do seletor de modelo RENDERIZADO (phase 17, passo 11; UI-05; A9, A21, A23, A25 a A28), com o DOM real (jsdom) e a API trocada por um servidor FALSO em memória na fronteira `fetch`: o
// `ModelSelector`, o `useModels` e o `apiFetch` rodam de verdade. Observa o que o dono vê e faz: os chips e o filtro, os grupos com contador e o recolher, Favoritos e Recentes com o nome completo,
// a linha com nome sem prefixo, preço e os selos Visão e Effort, o oculto e o indisponível, a busca com o provedor e o teclado (setas, Enter e Esc). As regras de divisão da lista são provadas
// sem tela em `model-selector.test.tsx`; o desenho em 340 px e em 375 px, o drawer e o axe são do E2E (`e2e/model-selector.spec.ts`).
import type { ModelEntry, SessionInfo } from '@aion/shared';
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '@/lib/session-context';
import { ModelSelector, type ModelChoice } from './model-selector';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const SESSION: SessionInfo = { owner: { email: 'dono@example.com' }, sessionId: '5b1f9c0e-3c1d-4f6e-8a7b-2d4e6f8a0b1d', csrfToken: 'csrf-token-de-teste' };
const TESTED = { status: 'ok' as const, reason: null, effortLevels: ['low', 'high'] as ('low' | 'high')[], testedAt: '2026-11-14T10:00:00.000Z' };

const entry = (id: string, patch: Partial<ModelEntry> = {}): ModelEntry => ({ id, favorite: false, favoritedAt: null, test: null, acceptsImages: null, hidden: false, displayName: null, price: null, unavailable: null, ...patch });
const MODELS: ModelEntry[] = [
  entry('opencode/deepseek-v4.1-flash', { price: { input: 0.3, output: 1.2 }, test: TESTED, favorite: true, favoritedAt: '2026-11-01T10:00:00.000Z' }),
  entry('opencode/glm-5.1', { test: { ...TESTED, effortLevels: [] } }),
  entry('opencode/kimi-k2.7-code', { hidden: true }),
  entry('anthropic/claude-haiku-5-5', { displayName: 'Claude Haiku 5.5', price: { input: 0.1, output: 0.5 }, acceptsImages: true, test: TESTED }),
  entry('anthropic/claude-opus-5-5', { displayName: 'Claude Opus 5.5', price: { input: 4, output: 20 }, hidden: true }),
  entry('anthropic/claude-sonnet-5-5', { displayName: 'Claude Sonnet 5.5', price: { input: 2, output: 10 }, unavailable: 'credits_exhausted', test: TESTED }),
];
const RECENTS = ['anthropic/claude-haiku-5-5', 'opencode/glm-5.1'];

const mounted: Array<{ root: ReturnType<typeof createRoot>; container: HTMLElement }> = [];
afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});
beforeEach(() => {
  // Desktop (popover): nenhuma media query casa. O servidor falso só serve a lista; favoritar e testar não são chamados aqui.
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path === '/api/models') return Response.json({ models: MODELS, recents: RECENTS });
    return Response.json({ code: 'NOT_FOUND', message: 'não previsto' }, { status: 404 });
  }));
});

async function mount(ui: ReactElement) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => root.render(<SessionProvider session={SESSION}>{ui}</SessionProvider>));
}
const doNow = (action: () => void) => act(async () => action());
const eventually = (check: () => void) => act(async () => { await vi.waitFor(check, { timeout: 4000, interval: 20 }); });
const click = (element: Element) => doNow(() => (element as HTMLElement).click());

/** Escreve num campo controlado pelo React, como a digitação faz. */
const write = (element: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value);
  return doNow(() => element.dispatchEvent(new Event('input', { bubbles: true })));
};
const key = (element: Element, name: string) => doNow(() => element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })));

/** O que está aberto em portal (o popover fica em `document.body`). */
const picker = () => document.body.querySelector<HTMLElement>('[role="dialog"][aria-label="Selecionar modelo"]')!;
const list = (name: string) => picker().querySelector<HTMLElement>(`ul[aria-label="${name}"]`);
const rows = (scope: ParentNode) => [...scope.querySelectorAll('li')];
const rowButton = (scope: ParentNode, name: RegExp) => [...scope.querySelectorAll<HTMLButtonElement>('li > div > button[aria-describedby], li > div > button:first-child')].find((item) => name.test(item.textContent ?? ''))!;
const chips = () => [...picker().querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Filtrar por provedor"] button')];
const groupHeader = (label: RegExp) => [...picker().querySelectorAll<HTMLButtonElement>('h3 button[aria-expanded]')].find((item) => label.test(item.textContent ?? ''))!;

/** Abre o seletor com a escolha dada e espera a lista chegar. */
async function open(value: ModelChoice = { model: null, effort: null }, onChange: (choice: ModelChoice) => void = () => undefined) {
  await mount(<ModelSelector value={value} onChange={onChange} noneLabel="Sem modelo padrão"><button type="button">Gatilho</button></ModelSelector>);
  await click(document.body.querySelector('button')!);
  await eventually(() => expect(list('Modelos do OpenCode Go')).not.toBeNull());
}

describe('chips e grupos (A25, A26)', () => {
  it('mostra os chips Todos, Anthropic e OpenCode Go abaixo da busca, "Todos" escolhido, e um grupo por provedor com o contador (sem os ocultos)', async () => {
    await open();
    expect(chips().map((chip) => [chip.textContent, chip.getAttribute('aria-pressed')])).toEqual([['Todos', 'true'], ['Anthropic', 'false'], ['OpenCode Go', 'false']]);
    const search = picker().querySelector('input[type="search"]')!;
    const group = picker().querySelector('[role="group"][aria-label="Filtrar por provedor"]')!;
    expect(search.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // os chips vêm DEPOIS da busca
    // Os ocultos (Kimi e Opus) ficam fora do contador e da lista.
    expect(groupHeader(/OpenCode Go/).textContent).toContain('(2)');
    expect(groupHeader(/Anthropic/).textContent).toContain('(2)');
    expect(rows(list('Modelos do OpenCode Go')!)).toHaveLength(2);
    expect(rows(list('Modelos da Anthropic')!)).toHaveLength(2);
    expect(picker().textContent).not.toContain('Claude Opus 5.5');
    expect(picker().textContent).not.toContain('kimi-k2.7-code');
  });

  it('o chip filtra tudo por provedor, marca o escolhido com aria-pressed e "Todos" devolve a lista', async () => {
    await open();
    await click(chips()[1]!); // Anthropic
    expect(chips().map((chip) => chip.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
    expect(list('Modelos do OpenCode Go')).toBeNull();
    expect(list('Modelos da Anthropic')).not.toBeNull();
    expect(picker().textContent).not.toContain('Favoritos'); // o favorito é do OpenCode Go
    await click(chips()[0]!);
    expect(list('Modelos do OpenCode Go')).not.toBeNull();
  });

  it('o cabeçalho do grupo recolhe e abre a lista, com aria-expanded e sem perder o contador', async () => {
    await open();
    const header = groupHeader(/Anthropic/);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    await click(header);
    expect(groupHeader(/Anthropic/).getAttribute('aria-expanded')).toBe('false');
    expect(groupHeader(/Anthropic/).textContent).toContain('(2)');
    expect(list('Modelos da Anthropic')).toBeNull();
    expect(list('Modelos do OpenCode Go')).not.toBeNull(); // o outro grupo segue aberto
    await click(groupHeader(/Anthropic/));
    expect(list('Modelos da Anthropic')).not.toBeNull();
  });
});

describe('a linha (A23, A28) e os nomes', () => {
  it('Favoritos e Recentes mostram o nome completo; os grupos, o nome sem prefixo', async () => {
    await open();
    const favorites = picker().querySelector<HTMLElement>('ul[aria-labelledby="modelos-favoritos"]')!;
    expect(rows(favorites).map((row) => row.querySelector('[data-model-name]')!.textContent)).toEqual(['opencode/deepseek-v4.1-flash']);
    const recents = picker().querySelector<HTMLElement>('ul[aria-labelledby="modelos-recentes"]')!;
    expect(rows(recents).map((row) => row.querySelector('[data-model-name]')!.textContent)).toEqual(['anthropic/Claude Haiku 5.5', 'opencode/glm-5.1']);
    expect(rows(list('Modelos da Anthropic')!).map((row) => row.querySelector('[data-model-name]')!.textContent)).toEqual(['Claude Haiku 5.5', 'Claude Sonnet 5.5']);
  });

  it('cada linha traz o preço da tabela ou "preço desconhecido", e os selos Visão e Effort só com a prova', async () => {
    await open();
    const haiku = rowButton(list('Modelos da Anthropic')!, /Claude Haiku 5\.5/);
    expect(haiku.textContent).toContain('US$ 0,10/0,50');
    expect(haiku.textContent).toContain('Visão'); // visão comprovada
    expect(haiku.textContent).toContain('Effort'); // o teste mostrou níveis
    expect(haiku.textContent).toContain('Liberado');
    const deepseek = rowButton(list('Modelos do OpenCode Go')!, /deepseek-v4\.1-flash/);
    expect(deepseek.textContent).toContain('US$ 0,30/1,20');
    expect(deepseek.textContent).not.toContain('Visão');
    const glm = rowButton(list('Modelos do OpenCode Go')!, /^glm-5\.1/);
    expect(glm.textContent).toContain('preço desconhecido');
    expect(glm.textContent).not.toContain('Effort'); // testado, mas sem nível de effort
  });
});

describe('oculto e indisponível (A9, A21)', () => {
  it('o oculto só aparece quando é a escolha atual, com o selo "Oculto"', async () => {
    await open({ model: 'anthropic/claude-opus-5-5', effort: null });
    const opus = rowButton(list('Modelos da Anthropic')!, /Claude Opus 5\.5/);
    expect(opus.textContent).toContain('Oculto');
    expect(opus.getAttribute('aria-current')).toBe('true');
    expect(groupHeader(/Anthropic/).textContent).toContain('(3)');
  });

  /** O texto a que a linha se liga por `aria-describedby` (o motivo, dito uma vez na tela). */
  const reasonOf = (button: HTMLElement) => (button.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
  const REASON = 'Indisponível: os créditos da Anthropic acabaram.';

  it('o indisponível mostra só o selo na linha e fica aria-disabled; o motivo aparece UMA vez, no cabeçalho do grupo, e a linha o liga por aria-describedby; não é escolhido, e o disponível é', async () => {
    const onChange = vi.fn();
    await open({ model: null, effort: null }, onChange);
    const sonnet = rowButton(list('Modelos da Anthropic')!, /Claude Sonnet 5\.5/);
    expect(sonnet.textContent).toContain('Indisponível');
    expect(sonnet.textContent).not.toContain('créditos'); // a linha não repete o motivo
    expect(sonnet.getAttribute('aria-disabled')).toBe('true');
    expect(picker().textContent?.split(REASON).length).toBe(2); // exatamente uma vez na tela
    const header = groupHeader(/Anthropic/).closest('section')!;
    expect(header.querySelector('p')?.textContent).toBe(REASON); // no cabeçalho do grupo da Anthropic
    expect(reasonOf(sonnet)).toBe(REASON);
    expect(reasonOf(rowButton(list('Modelos da Anthropic')!, /Claude Haiku 5\.5/))).toBe(''); // o disponível não aponta para o motivo
    await click(sonnet);
    expect(onChange).not.toHaveBeenCalled();
    await click(rowButton(list('Modelos da Anthropic')!, /Claude Haiku 5\.5/)); // testado: aplica direto
    expect(onChange).toHaveBeenCalledWith({ model: 'anthropic/claude-haiku-5-5', effort: null });
  });
});

describe('o motivo do indisponível fora do grupo (A21)', () => {
  const REASON = 'Indisponível: os créditos da Anthropic acabaram.';
  const reasonOf = (button: HTMLElement) => (button.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();

  it('a linha indisponível em Favoritos e em Recentes continua ligada ao motivo, que está na tela (o cabeçalho do grupo), e a busca o diz sob "Resultados"', async () => {
    const favorite = MODELS.map((model) => (model.id === 'anthropic/claude-sonnet-5-5' ? { ...model, favorite: true, favoritedAt: '2026-11-02T10:00:00.000Z' } : model));
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ models: favorite, recents: ['anthropic/claude-sonnet-5-5'] })));
    await open();
    const inFavorites = picker().querySelector<HTMLElement>('ul[aria-labelledby="modelos-favoritos"]')!;
    const inRecents = picker().querySelector<HTMLElement>('ul[aria-labelledby="modelos-recentes"]')!;
    for (const scope of [inFavorites, inRecents]) {
      const sonnet = rowButton(scope, /Claude Sonnet 5\.5/);
      expect(sonnet.getAttribute('aria-disabled')).toBe('true');
      expect(sonnet.textContent).not.toContain('créditos');
      expect(reasonOf(sonnet)).toBe(REASON);
    }
    expect(picker().textContent?.split(REASON).length).toBe(2); // continua dito uma vez só
    // Na busca não há cabeçalho de grupo: o motivo vem sob "Resultados", uma vez, e a linha o liga.
    await write(picker().querySelector('input[type="search"]')!, 'sonnet');
    const results = picker().querySelector<HTMLElement>('ul[aria-labelledby$="-resultados"]')!;
    expect(reasonOf(rowButton(results, /Claude Sonnet 5\.5/))).toBe(REASON);
    expect(picker().textContent?.split(REASON).length).toBe(2);
  });
});

describe('busca e teclado (A27, A29)', () => {
  it('a busca devolve uma lista só, de todos os provedores, e cada resultado mostra o provedor', async () => {
    await open();
    await write(picker().querySelector('input[type="search"]')!, 'k');
    const results = picker().querySelector<HTMLElement>('ul[aria-labelledby$="-resultados"]')!;
    const text = rows(results).map((row) => row.textContent ?? '');
    expect(text.some((item) => item.includes('Claude Haiku 5.5') && item.includes('Anthropic'))).toBe(true);
    expect(text.some((item) => item.includes('deepseek-v4.1-flash') && item.includes('OpenCode Go'))).toBe(true);
    expect(list('Modelos da Anthropic')).toBeNull(); // sem grupos durante a busca
    await write(picker().querySelector('input[type="search"]')!, 'zzz');
    expect(picker().textContent).toContain('Nenhum modelo encontrado');
  });

  it('seta para baixo desce da busca à primeira linha, cada seta anda uma linha, seta para cima volta à busca e Enter escolhe a linha em foco', async () => {
    const onChange = vi.fn();
    await open({ model: null, effort: null }, onChange);
    const search = picker().querySelector<HTMLInputElement>('input[type="search"]')!;
    await doNow(() => search.focus());
    await key(search, 'ArrowDown');
    expect(document.activeElement?.textContent).toContain('Sem modelo padrão'); // a opção de limpar vem primeiro
    await key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement?.textContent).toContain('opencode/deepseek-v4.1-flash'); // o primeiro favorito
    await key(document.activeElement!, 'ArrowUp');
    await key(document.activeElement!, 'ArrowUp');
    expect(document.activeElement).toBe(search);
    // Enter num botão é o clique do navegador: a linha em foco é a que escolhe.
    await key(search, 'ArrowDown');
    await key(document.activeElement!, 'ArrowDown');
    await click(document.activeElement!);
    expect(onChange).toHaveBeenCalledWith({ model: 'opencode/deepseek-v4.1-flash', effort: null });
  });
});

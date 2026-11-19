// @vitest-environment jsdom
// Prova da interação do painel do artefato (phase 14, passo 7; A5, A6 e A7) com o DOM real (jsdom): o que o teste estático de `conversation/thread.test.tsx` não alcança. Monta o que a
// conversa monta, `useArtifactPanel` (URL, endereço dos cartões, guarda de descarte e painel) e `ArtifactCards`, com o `DocView` REAL carregado por `next/dynamic` e a API trocada por um
// servidor FALSO na fronteira `fetch`. Só a fronteira do Next é falsa: o roteador (uma URL reativa, para o painel seguir o `?artefato=` como na conversa) e o `Link` (que chama o `onClick`
// e, se ele não impediu, navega com `push`, o contrato do Link do Next).
//
// Cada caso sai da regra e observa o que o dono vê e a URL:
// - Abrir e fechar: o cartão abre o painel pela URL (`push`), o foco vai ao painel e volta ao cartão ao fechar; fechar é `replace` para a conversa sem o parâmetro; o Voltar do navegador (a
//   URL mudando por fora) também fecha; valor inválido não abre nada.
// - Guarda de descarte (texto não salvo no doc em edição): fechar (Voltar e Fechar painel), "Abrir em tela inteira" e abrir OUTRO cartão perguntam antes; "Continuar editando" mantém o texto
//   digitado e a URL; "Descartar alterações" segue. Sem alteração, nada pergunta. O mesmo cartão aberto não pergunta nem troca nada.
// - Contrato do embutido: sem o "Voltar" de página, título em h2, e excluir o doc fecha o painel sem navegar para a lista.
import type { SessionInfo } from '@aion/shared';
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '@/lib/session-context';
import { DocView } from '@/components/docs/doc-view';
import { ArtifactCards } from './artifact-card';
import { useArtifactPanel } from './artifact-panel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// O jsdom não mede layout: o cartão de bloco de código observa o tamanho e o ProseMirror pede a posição do cursor. Só existem neste arquivo (mesmos substitutos de `doc-view.test.tsx`).
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
const EMPTY_RECT = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => EMPTY_RECT as DOMRect;

const CONVERSATION = '/bots/b1';

/** Roteador falso: UMA URL reativa. `push` e `replace` a trocam e `usePathname` e `useSearchParams` a seguem, como no app; `set` é a URL mudando por fora (o Voltar do navegador). */
const nav = vi.hoisted(() => {
  let url = '/bots/b1';
  const listeners = new Set<() => void>();
  const set = (next: string) => {
    url = next;
    listeners.forEach((listener) => listener());
  };
  return {
    get: () => url,
    set,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    push: vi.fn((href: string, _options?: unknown) => set(href)),
    replace: vi.fn((href: string, _options?: unknown) => set(href)),
  };
});
vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  const useCurrentUrl = () => new URL(useSyncExternalStore(nav.subscribe, nav.get), 'http://localhost');
  return { useRouter: () => ({ push: nav.push, replace: nav.replace }), usePathname: () => useCurrentUrl().pathname, useSearchParams: () => useCurrentUrl().searchParams };
});
// O Link do Next: o `onClick` do dono do link roda primeiro e, se ele não impediu o padrão, a navegação vira `push` (é o que o Next faz).
vi.mock('next/link', async () => {
  const { createElement } = await import('react');
  type Props = { href: string; onClick?: (event: MouseEvent) => void; scroll?: boolean; prefetch?: boolean; children?: unknown } & Record<string, unknown>;
  return {
    default: ({ href, onClick, scroll, prefetch: _prefetch, children, ...rest }: Props) =>
      createElement(
        'a',
        {
          ...rest,
          href,
          onClick: (event: MouseEvent) => {
            onClick?.(event);
            if (event.defaultPrevented) return;
            event.preventDefault();
            nav.push(href, { scroll });
          },
        },
        children as never,
      ),
  };
});

const SESSION: SessionInfo = { owner: { email: 'dono@example.com' }, sessionId: '5b1f9c0e-3c1d-4f6e-8a7b-2d4e6f8a0b1c', csrfToken: 'csrf-token-de-teste' };
const PLANO = { type: 'doc' as const, id: '8f0c2f4e-5f5f-4f7a-9d7e-1f8a6a1d0003', title: 'Plano' };
const ROTEIRO = { type: 'doc' as const, id: '8f0c2f4e-5f5f-4f7a-9d7e-1f8a6a1d0004', title: 'Roteiro' };
const TITLES: Record<string, string> = { [PLANO.id]: PLANO.title, [ROTEIRO.id]: ROTEIRO.title };

/** API falsa de docs: lê qualquer um dos dois docs e exclui; o resto não é chamado por estes casos. */
const api = { deleted: [] as string[] };
async function handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), 'http://localhost');
  const method = init?.method ?? 'GET';
  const id = /^\/api\/docs\/([^/]+)$/.exec(url.pathname)?.[1] ?? '';
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (!(id in TITLES)) return reply(404, { code: 'DOC_NOT_FOUND', message: 'Doc não encontrado.' });
  if (method === 'DELETE') {
    api.deleted.push(id);
    return reply(200, { id, deleted: true });
  }
  // Texto sem título de Markdown: um `#` do próprio doc viraria um h1 e confundiria a conferência do título da tela.
  const content = `Texto do ${TITLES[id]}\n`;
  return reply(200, { id, title: TITLES[id], content, version: 1, accessVersion: 1, size: content.length, botIds: [], updatedBy: 'owner', createdAt: '2026-10-20T10:00:00.000Z', updatedAt: '2026-10-22T10:00:00.000Z' });
}

/** O que a conversa monta: os cartões e, ao lado, o painel com o popup de descarte, tudo vindo de `useArtifactPanel`. */
function Harness() {
  const panel = useArtifactPanel();
  return (
    <>
      <ArtifactCards artifacts={[PLANO, ROTEIRO]} links={panel.links} />
      {panel.element}
    </>
  );
}

const mounted: Array<{ root: ReturnType<typeof createRoot>; container: HTMLElement }> = [];

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
});

// O primeiro `import()` do doc (Milkdown e ProseMirror) é lento: carrega uma vez antes dos casos, para o prazo de cada um medir o painel e não o carregamento do módulo.
beforeAll(async () => {
  await import('@/components/docs/doc-view');
}, 60_000);

beforeEach(() => {
  api.deleted = [];
  nav.set(CONVERSATION);
  nav.push.mockClear();
  nav.replace.mockClear();
  vi.stubGlobal('fetch', vi.fn(handle));
});

async function mount(ui: ReactElement) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => root.render(<SessionProvider session={SESSION}>{ui}</SessionProvider>));
  return container;
}

/** Espera uma condição com a árvore em `act`, para os efeitos, o `import()` do doc e as respostas da API assentarem. */
const eventually = (check: () => void) =>
  act(async () => {
    await vi.waitFor(check, { timeout: 4000, interval: 20 });
  });

const doNow = (action: () => void) => act(async () => action());
const click = (element: HTMLElement) => doNow(() => element.click());

/** O botão pelo nome visível ou acessível, no documento inteiro (o popup abre em portal). */
function button(name: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find((item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name);
  if (!found) throw new Error(`Botão "${name}" não encontrado. Botões: ${[...document.body.querySelectorAll('button')].map((item) => item.textContent?.trim() || item.getAttribute('aria-label')).join(' | ')}`);
  return found;
}

/** O cartão do artefato (o link "Abrir <tipo> <título>"). */
function card(title: string): HTMLAnchorElement {
  const found = [...document.body.querySelectorAll('ul[aria-label="Artefatos desta resposta"] a')].find((item) => item.textContent?.includes(title));
  if (!found) throw new Error(`Cartão "${title}" não encontrado.`);
  return found as HTMLAnchorElement;
}

const panelEl = () => document.body.querySelector<HTMLElement>('aside[aria-label="Painel do doc"]');
const dialogOpen = () => document.body.querySelector('[role="dialog"]') !== null;
const markdownField = () => document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="Texto do doc em Markdown"]')!;
const fullScreenLink = () => [...document.body.querySelectorAll('aside a')].find((item) => item.textContent?.includes('Abrir em tela inteira')) as HTMLAnchorElement;
const urlNow = () => nav.get();

/** Troca o valor de um campo controlado pelo React, como a digitação faz. */
function write(element: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(element, value);
  return doNow(() => element.dispatchEvent(new Event('input', { bubbles: true })));
}

/** Clica no cartão (com o foco nele, como no teclado) e espera o painel mostrar o doc. */
async function openCard(item: { id: string; title: string }) {
  const link = card(item.title);
  link.focus();
  await click(link);
  await eventually(() => expect(panelEl()?.querySelector('h2')?.textContent).toBe(item.title));
  return link;
}

/** Entra na edição em texto cru e digita: o doc fica com alteração não salva e o painel é avisado. */
async function typeUnsaved(text = 'Texto que ainda não foi salvo') {
  await click(button('Editar'));
  await eventually(() => expect(panelEl()?.querySelector('[data-ready="true"]')).not.toBeNull());
  await click(button('Ver Markdown'));
  await write(markdownField(), text);
  expect(markdownField().value).toBe(text);
  return text;
}

describe('abrir e fechar o painel pela URL (A5 e A6)', () => {
  it('o cartão abre o painel pela URL (?artefato=doc:<id>, um push), o foco vai ao painel e o painel mostra o doc embutido: sem "Voltar" de página e com título em h2', async () => {
    await mount(<Harness />);
    expect(panelEl()).toBeNull();
    const link = await openCard(PLANO);
    expect(nav.push).toHaveBeenCalledWith(`${CONVERSATION}?artefato=doc:${PLANO.id}`, { scroll: false });
    expect(urlNow()).toBe(`${CONVERSATION}?artefato=doc:${PLANO.id}`);
    expect(document.activeElement).toBe(panelEl());
    expect(link.getAttribute('aria-current')).toBe('true');
    expect(card(ROTEIRO.title).hasAttribute('aria-current')).toBe(false);
    // O controle de sair é do painel: a página não traz o próprio "Voltar" (um link) e o título não é um h1 (a conversa já tem o dela).
    expect(panelEl()!.querySelector('a[aria-label="Voltar"]')).toBeNull();
    expect(panelEl()!.querySelector('h1')).toBeNull();
    expect(fullScreenLink().getAttribute('href')).toBe(`/artefatos/docs/${PLANO.id}`);
  });

  it('fechar (Voltar no celular, Fechar painel ao lado) é um replace para a conversa sem o parâmetro e devolve o foco ao cartão que abriu', async () => {
    for (const name of ['Fechar painel', 'Voltar']) {
      nav.set(CONVERSATION);
      nav.replace.mockClear();
      const container = await mount(<Harness />);
      const link = await openCard(PLANO);
      await click(button(name));
      expect(nav.replace).toHaveBeenCalledWith(CONVERSATION, { scroll: false });
      expect(urlNow()).toBe(CONVERSATION);
      expect(panelEl()).toBeNull();
      expect(dialogOpen()).toBe(false);
      expect(document.activeElement, name).toBe(link);
      const entry = mounted.pop()!;
      await act(async () => entry.root.unmount());
      container.remove();
    }
  });

  it('o Voltar do navegador (a URL mudando por fora) fecha o painel, e o link colado com o parâmetro abre direto', async () => {
    nav.set(`${CONVERSATION}?artefato=doc:${ROTEIRO.id}`);
    await mount(<Harness />);
    await eventually(() => expect(panelEl()?.querySelector('h2')?.textContent).toBe(ROTEIRO.title));
    await doNow(() => nav.set(CONVERSATION));
    expect(panelEl()).toBeNull();
  });

  it.each([
    ['id que não é UUID', 'doc:plano'],
    ['tipo desconhecido', `sheet:${PLANO.id}`],
    ['caminho depois do id', `doc:${PLANO.id}/../x`],
  ])('valor inválido na URL (%s) não abre o painel', async (_name, value) => {
    nav.set(`${CONVERSATION}?artefato=${value}`);
    await mount(<Harness />);
    expect(panelEl()).toBeNull();
    expect(document.body.querySelector('aside')).toBeNull();
  });

  it('excluir o doc pelo painel fecha o painel, sem navegar para a lista de Artefatos', async () => {
    await mount(<Harness />);
    await openCard(PLANO);
    await click(button('Excluir'));
    await click(button('Excluir doc'));
    await eventually(() => expect(panelEl()).toBeNull());
    expect(api.deleted).toEqual([PLANO.id]);
    expect(nav.replace).toHaveBeenCalledWith(CONVERSATION, { scroll: false });
    expect(nav.replace).not.toHaveBeenCalledWith('/artefatos');
    expect(nav.push).not.toHaveBeenCalledWith('/artefatos', expect.anything());
  });
});

describe('guarda de descarte: texto não salvo no painel nunca se perde em silêncio', () => {
  it.each(['Fechar painel', 'Voltar'])('fechar com %s pergunta antes; "Continuar editando" mantém o texto, a URL e o painel; "Descartar alterações" fecha', async (name) => {
    await mount(<Harness />);
    await openCard(PLANO);
    const text = await typeUnsaved();

    await click(button(name));
    expect(dialogOpen()).toBe(true);
    expect(nav.replace).not.toHaveBeenCalled();
    expect(panelEl()).not.toBeNull();

    await click(button('Continuar editando'));
    expect(dialogOpen()).toBe(false);
    expect(markdownField().value).toBe(text);
    expect(urlNow()).toBe(`${CONVERSATION}?artefato=doc:${PLANO.id}`);
    expect(nav.replace).not.toHaveBeenCalled();

    await click(button(name));
    await click(button('Descartar alterações'));
    expect(nav.replace).toHaveBeenCalledWith(CONVERSATION, { scroll: false });
    expect(panelEl()).toBeNull();
  });

  it('"Abrir em tela inteira" pergunta antes; "Continuar editando" mantém o texto e não navega; "Descartar alterações" vai à página própria', async () => {
    await mount(<Harness />);
    await openCard(PLANO);
    const text = await typeUnsaved();
    nav.push.mockClear();

    await click(fullScreenLink());
    expect(dialogOpen()).toBe(true);
    expect(nav.push).not.toHaveBeenCalled();

    await click(button('Continuar editando'));
    expect(markdownField().value).toBe(text);
    expect(nav.push).not.toHaveBeenCalled();

    await click(fullScreenLink());
    await click(button('Descartar alterações'));
    expect(nav.push).toHaveBeenCalledWith(`/artefatos/docs/${PLANO.id}`);
  });

  it('abrir OUTRO cartão pergunta antes; "Continuar editando" mantém o doc aberto e o texto; "Descartar alterações" troca para o outro doc', async () => {
    await mount(<Harness />);
    await openCard(PLANO);
    const text = await typeUnsaved();
    nav.push.mockClear();

    await click(card(ROTEIRO.title));
    expect(dialogOpen()).toBe(true);
    expect(nav.push).not.toHaveBeenCalled();
    expect(urlNow()).toBe(`${CONVERSATION}?artefato=doc:${PLANO.id}`);

    await click(button('Continuar editando'));
    expect(markdownField().value).toBe(text);
    expect(urlNow()).toBe(`${CONVERSATION}?artefato=doc:${PLANO.id}`);

    await click(card(ROTEIRO.title));
    await click(button('Descartar alterações'));
    expect(nav.push).toHaveBeenCalledWith(`${CONVERSATION}?artefato=doc:${ROTEIRO.id}`, { scroll: false });
    await eventually(() => expect(panelEl()?.querySelector('h2')?.textContent).toBe(ROTEIRO.title));
    // O painel novo começa limpo: nada pergunta ao fechá-lo.
    await click(button('Fechar painel'));
    expect(dialogOpen()).toBe(false);
    expect(panelEl()).toBeNull();
  });

  it('o cartão do doc que já está aberto não pergunta nem troca nada, e o texto digitado fica', async () => {
    await mount(<Harness />);
    await openCard(PLANO);
    const text = await typeUnsaved();

    await click(card(PLANO.title));
    expect(dialogOpen()).toBe(false);
    expect(markdownField().value).toBe(text);
    expect(urlNow()).toBe(`${CONVERSATION}?artefato=doc:${PLANO.id}`);
  });

  it('sem alteração nada pergunta: fechar, abrir outro cartão e "Abrir em tela inteira" vão direto', async () => {
    await mount(<Harness />);
    await openCard(PLANO);
    await click(button('Editar'));
    await eventually(() => expect(panelEl()?.querySelector('[data-ready="true"]')).not.toBeNull());
    await click(button('Ver Markdown'));
    // Entrar na edição e alternar para o texto cru, sem digitar, não é alteração (A17).

    await click(card(ROTEIRO.title));
    expect(dialogOpen()).toBe(false);
    await eventually(() => expect(panelEl()?.querySelector('h2')?.textContent).toBe(ROTEIRO.title));

    nav.push.mockClear();
    await click(fullScreenLink());
    expect(dialogOpen()).toBe(false);
    expect(nav.push).toHaveBeenCalledWith(`/artefatos/docs/${ROTEIRO.id}`, expect.anything());

    // A página própria é outra rota: voltar à conversa com o doc aberto e fechar o painel também não pergunta.
    await doNow(() => nav.set(`${CONVERSATION}?artefato=doc:${ROTEIRO.id}`));
    await eventually(() => expect(panelEl()?.querySelector('h2')?.textContent).toBe(ROTEIRO.title));
    await click(button('Fechar painel'));
    expect(dialogOpen()).toBe(false);
    expect(panelEl()).toBeNull();
  });

  it('depois de descartar e fechar, o doc reaberto começa sem alteração (o aviso de alteração não fica preso)', async () => {
    await mount(<Harness />);
    await openCard(PLANO);
    await typeUnsaved();
    await click(button('Fechar painel'));
    await click(button('Descartar alterações'));
    expect(panelEl()).toBeNull();

    await openCard(PLANO);
    await click(button('Fechar painel'));
    expect(dialogOpen()).toBe(false);
    expect(panelEl()).toBeNull();
  });
});

describe('cabeçalho do doc: rótulos e quebra de linha pela largura certa (A30)', () => {
  // O jsdom não mede layout: aqui vai a REGRA (quem decide e que nenhum controle perde o nome); a geometria real, cada controle dentro do painel em 1280 e 375 px, é do E2E (A30).
  const ACTIONS = ['Histórico', 'Compartilhar', 'Baixar .md', 'Excluir'];
  /** O span do rótulo de uma ação do cabeçalho (o texto continua no DOM quando só o ícone aparece: é o nome acessível). */
  const labelOf = (name: string) => [...button(name).querySelectorAll('span')].find((item) => item.textContent === name)!;

  it('embutido no painel, o rótulo e o tamanho dos botões seguem a largura DO PAINEL (container query), não a da janela, e o grupo quebra a linha em vez de passar da borda', async () => {
    await mount(<Harness />);
    await openCard(PLANO);
    for (const name of ACTIONS) {
      // O rótulo some só de vista (sr-only) abaixo de 42 rem de painel; o nome acessível é o mesmo texto.
      expect(labelOf(name).className, name).toContain('@max-2xl/panel:sr-only');
      expect(labelOf(name).className, name).not.toContain('max-md:');
      expect(button(name).className, name).toContain('@max-2xl/panel:size-10');
      expect(button(name).className, name).not.toContain('max-md:');
      expect(button(name).textContent?.trim(), name).toBe(name);
    }
    expect(button('Editar').textContent?.trim()).toBe('Editar');
    expect(button('Editar').parentElement!.className).toContain('flex-wrap');
  });

  it('a página própria do doc não muda: o rótulo e o tamanho seguem a janela (abaixo de 768 px) e o grupo não quebra', async () => {
    await mount(<DocView docId={PLANO.id} />);
    await eventually(() => expect(document.body.querySelector('h1')?.textContent).toBe(PLANO.title));
    for (const name of ACTIONS) {
      expect(labelOf(name).className, name).toContain('max-md:sr-only');
      expect(labelOf(name).className, name).not.toContain('@max-2xl/panel');
      expect(button(name).className, name).toContain('max-md:size-10');
    }
    expect(button('Editar').parentElement!.className).not.toContain('flex-wrap');
  });
});

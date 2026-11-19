// Prova das páginas de erro do app (phase 5, A18; F11): "Não encontrado" (`not-found.tsx` fora do shell e `(app)/not-found.tsx` dentro dele), "Algo deu errado"
// (`error.tsx`) e a tela do layout raiz (`global-error.tsx`). Renderização no servidor, sem DOM: o texto do desenho, a Faísca do Aion no estado de cada página
// (aguardando no "Não encontrado", erro na falha) com halo, a entrada, sem laço de movimento e sem olhar (rosto fixo), as ações de cada página, `retry` chamado pelo botão
// "Tentar novamente" (o clique é disparado no elemento devolvido pelo componente, porque não há DOM para clicar), nenhum detalhe do erro na tela e o landmark: um único
// `main` fora do shell e nenhum dentro dele (o `main` é o do shell). O tamanho responsivo (112, 96 e 72 px), a contagem de `main` na página inteira e o visual no navegador
// real são provados no E2E (a página não encontrada, dentro e fora do shell); a falha real do layout raiz não tem como ser forçada de forma estável no E2E.
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import AppNotFound from './(app)/not-found';
import AppError from './error';
import GlobalError from './global-error';
import NotFound from './not-found';

type AnyElement = ReactElement<Record<string, unknown>>;

/** Procura, na árvore de elementos devolvida por um componente (sem renderizar), o primeiro que satisfaz `match`. */
function findElement(node: ReactNode, match: (element: AnyElement) => boolean): AnyElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, match);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return null;
  return match(node) ? node : findElement(node.props.children as ReactNode, match);
}

/** A etiqueta `<svg>` da Faísca da página (a única da tela). */
const faiscaTag = (html: string): string => {
  const tags = html.match(/<svg[^>]*class="faisca[^"]*"[^>]*>/g) ?? [];
  expect(tags).toHaveLength(1);
  return tags[0]!;
};

/** Quantos landmarks `main` (a abertura da etiqueta) o HTML tem. */
const mainCount = (html: string): number => (html.match(/<main[\s>]/g) ?? []).length;

/**
 * O que as telas de erro compartilham: a Faísca do Aion no estado dado, com a entrada, sem olhar, sem laço, decorativa, no tamanho de destaque e com o halo no invólucro,
 * e um único título.
 */
function expectFaisca(html: string, state: 'waiting' | 'error'): void {
  const tag = faiscaTag(html);
  expect(tag).toContain(`data-state="${state}"`);
  expect(tag).toContain('data-enter=""'); // entrada única (com movimento reduzido o CSS global a encurta a nada)
  expect(tag).not.toContain('data-look'); // rosto fixo: estas poses não seguem o cursor
  expect(tag).toContain('data-still=""'); // sem laço de movimento: a entrada é o único movimento
  expect(tag).toContain('aria-hidden="true"'); // decorativa: o título diz o estado
  expect(tag).not.toContain('role="img"');
  expect(tag).toContain('data-detail="full"');
  expect(tag).toMatch(/class="faisca faisca-hero"/); // `.faisca-hero` dá 112 px, 96 px abaixo de 768 px de largura e 72 px com a janela baixa
  expect(tag).toContain('width="112"');
  expect(tag).toContain('--faisca-body:var(--faisca)'); // cor de marca: estas telas não pertencem a nenhum bot
  expect(html).toMatch(/<div class="faisca-halo w-fit"><svg /); // o halo envolve só a Faísca
  expect(html).toMatch(/<h1[^>]*>[^<]+<\/h1>/); // um único título por página
  expect(html.match(/<h1/g)).toHaveLength(1);
}

/** O caminho de volta de todas as telas de erro: "Ir para o Início", secundário, apontando para `/`. */
function expectHomeLink(html: string): void {
  const link = html.match(/<a [^>]*>Ir para o Início<\/a>/)?.[0] ?? '';
  expect(link).toContain('href="/"');
  expect(link).toContain('border-line'); // secundário
  expect(link).not.toContain('bg-action');
}

describe.each([
  ['fora do shell (not-found.tsx da raiz)', <NotFound key="root" />, 1],
  ['dentro do shell (app/not-found.tsx)', <AppNotFound key="shell" />, 0],
])('página não encontrada %s', (_where, element, mains) => {
  const html = renderToStaticMarkup(element);

  it('mostra a Faísca aguardando, o título e o apoio do design', () => {
    expectFaisca(html, 'waiting');
    expect(html).toMatch(/<h1[^>]*>Não encontrado<\/h1>/);
    expect(html).toContain('Esta página não existe ou foi removida.');
  });

  it('tem só o caminho de volta, "Ir para o Início" (secundário, para /), e nenhum "Tentar novamente"', () => {
    expect(html.match(/<a /g)).toHaveLength(1);
    expectHomeLink(html);
    expect(html).not.toContain('Tentar novamente');
    expect(html).not.toContain('<button');
  });

  it(`tem ${mains} landmark main: fora do shell a tela é o main da página; dentro dele o main é o do shell`, () => {
    expect(mainCount(html)).toBe(mains);
  });
});

describe('página de erro', () => {
  const technical = Object.assign(new Error('falha interna: hunter2 em SELECT * FROM bots'), { digest: 'digest-9f3a' });

  it('mostra a Faísca em erro, o título e o apoio do design, sem nenhum detalhe técnico do erro, num único main', () => {
    const html = renderToStaticMarkup(<AppError error={technical} retry={() => undefined} />);
    expectFaisca(html, 'error');
    expect(html).toMatch(/<h1[^>]*>Algo deu errado<\/h1>/);
    expect(html).toContain('Não foi possível mostrar esta página. Tente de novo.');
    for (const leaked of ['hunter2', 'SELECT', 'digest-9f3a', 'falha interna']) expect(html).not.toContain(leaked);
    expect(mainCount(html)).toBe(1);
  });

  it('tem "Tentar novamente" (primário) antes de "Ir para o Início" (secundário)', () => {
    const html = renderToStaticMarkup(<AppError error={technical} retry={() => undefined} />);
    const retry = html.indexOf('Tentar novamente');
    const home = html.indexOf('Ir para o Início');
    expect(retry).toBeGreaterThan(-1);
    expect(home).toBeGreaterThan(retry);
    expect(html).toMatch(/<button [^>]*class="[^"]*bg-action[^"]*"[^>]*>Tentar novamente<\/button>/);
    expectHomeLink(html);
  });

  it('"Tentar novamente" chama `retry` uma vez, e "Ir para o Início" não o chama', () => {
    const retry = vi.fn();
    const screen = AppError({ error: technical, retry });
    const button = findElement(screen, (element) => typeof element.props.onClick === 'function' && element.props.children === 'Tentar novamente');
    expect(button, 'botão "Tentar novamente"').not.toBeNull();
    (button!.props.onClick as () => void)();
    expect(retry).toHaveBeenCalledTimes(1);

    const home = findElement(screen, (element) => element.props.href === '/');
    expect(home, 'link "Ir para o Início"').not.toBeNull();
    expect(home!.props.onClick).toBeUndefined();
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe('erro do layout raiz (global-error)', () => {
  const technical = Object.assign(new Error('falha interna: hunter2 em SELECT * FROM bots'), { digest: 'digest-9f3a' });
  const html = renderToStaticMarkup(<GlobalError error={technical} retry={() => undefined} />);

  it('é um documento próprio (html em pt-BR e body) com a mesma composição do erro do app, sem nenhum detalhe técnico', () => {
    // O React leva o título e o viewport ao head; o body não leva classe de fundo (UI-06): o fundo liso vem do `body` de globals.css, o mesmo do layout raiz.
    expect(html).toMatch(/^<html lang="pt-BR"><head>.*<\/head><body>/);
    expectFaisca(html, 'error');
    expect(html).toMatch(/<h1[^>]*>Algo deu errado<\/h1>/);
    expect(html).toContain('Não foi possível mostrar esta página. Tente de novo.');
    expect(html).toMatch(/<button [^>]*class="[^"]*bg-action[^"]*"[^>]*>Tentar novamente<\/button>/);
    expectHomeLink(html);
    for (const leaked of ['hunter2', 'SELECT', 'digest-9f3a', 'falha interna']) expect(html).not.toContain(leaked);
  });

  it('tem um único main, o título e o viewport do documento (sem o layout raiz que os daria)', () => {
    expect(mainCount(html)).toBe(1);
    expect(html).toContain('<title>Algo deu errado · Aion</title>');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>');
  });

  it('"Tentar novamente" repassa o `retry` da fronteira do Next', () => {
    const retry = vi.fn();
    const document = GlobalError({ error: technical, retry });
    const app = findElement(document, (element) => element.type === AppError);
    expect(app, 'o erro do app dentro do documento').not.toBeNull();
    expect(app!.props.retry).toBe(retry);
  });
});

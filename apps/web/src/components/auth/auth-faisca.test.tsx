// Prova da assinatura no login e no TOTP (phase 5, A1 e A17; F1 e F11): o login mostra a Faísca do Aion de 112 px ociosa, com halo, a entrada e sem olhar no HTML do servidor (o
// olhar só começa depois de montar, então a hidratação não diverge), e o tamanho responsivo vem da classe `.faisca-hero`; o TOTP mostra a mesma Faísca de 72 px, parada e sem
// entrada. Nas duas a cor é a de marca (a tela não tem bot) e a Faísca é decorativa, abaixo da qual o logotipo é o único título: um `<h1>` cujo conteúdo é o SVG com o nome
// acessível "Aion". O movimento do olhar, o encolher em janela baixa e o visual são provados no navegador real (E2E). Renderização no servidor, sem DOM.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LoginForm } from './login-form';
import { TotpForm } from './totp-form';

// O formulário do TOTP usa o roteador do Next, que só existe montado no app.
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: () => undefined }) }));

/** O logotipo é o único título da tela: `<h1>` com o SVG de nome acessível "Aion" (36 px de altura, 90 de largura) e as letras na cor do texto. */
function expectLogoTitle(html: string): void {
  expect(html.match(/<h1/g)).toHaveLength(1);
  const title = html.match(/<h1[^>]*>(<svg[^>]*>)/)?.[1] ?? '';
  expect(title, 'o título é o SVG do logotipo').toContain('role="img"');
  expect(title).toContain('aria-label="Aion"');
  expect(title).toContain('height="36"');
  expect(title).toContain('width="90"');
  expect(title).toContain('viewBox="0 0 240 96"');
}

/** A etiqueta `<svg>` da Faísca da tela (a única, com o halo no invólucro), acima do título com o logotipo. */
function faiscaOf(html: string): string {
  const tags = html.match(/<svg[^>]*class="faisca[^"]*"[^>]*>/g) ?? [];
  expect(tags).toHaveLength(1);
  expect(html).toContain('faisca-halo');
  expect(html.indexOf(tags[0]!), 'a Faísca vem acima do logotipo').toBeLessThan(html.indexOf('<h1'));
  expectLogoTitle(html);
  return tags[0]!;
}

describe('login', () => {
  const html = renderToStaticMarkup(<LoginForm next="/bots" />);
  const tag = faiscaOf(html);

  it('é a Faísca ociosa de 112 px na cor de marca, com a entrada, decorativa e no tamanho de destaque responsivo (112, 96 e 72 px por CSS)', () => {
    expect(tag).toContain('data-state="idle"');
    expect(tag).toContain('data-enter=""');
    expect(tag).toContain('data-detail="full"');
    expect(tag).toContain('width="112"');
    expect(tag).toMatch(/class="faisca faisca-hero"/);
    expect(tag).toContain('--faisca-body:var(--faisca)'); // sem cor de bot
    expect(tag).toContain('aria-hidden="true"');
    expect(tag).not.toContain('role="img"');
  });

  it('não tem olhar no HTML do servidor: o `useGaze` só liga depois de montar, sem desvio de hidratação', () => {
    expect(tag).not.toContain('data-look');
  });

  it('o único título é o logotipo "Aion"; o texto "Aion" não aparece como título em texto', () => {
    expect(html).not.toMatch(/<h1[^>]*>Aion<\/h1>/);
  });
});

describe('TOTP', () => {
  const tag = faiscaOf(renderToStaticMarkup(<TotpForm next="/bots" />));

  it('é a mesma Faísca, de 72 px, parada e sem entrada, na cor de marca e decorativa', () => {
    expect(tag).toContain('data-state="idle"');
    expect(tag).toContain('data-still=""');
    expect(tag).not.toContain('data-enter');
    expect(tag).not.toContain('data-look');
    expect(tag).toContain('width="72"');
    expect(tag).not.toContain('faisca-hero'); // tamanho fixo: a continuidade da tela do login, não uma tela de destaque nova
    expect(tag).toContain('--faisca-body:var(--faisca)');
    expect(tag).toContain('aria-hidden="true"');
  });
});

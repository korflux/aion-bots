// Prova do Markdown das respostas do bot no HTML do servidor (phase 3, T7; A14 e A15, F8): cada bloco cercado vira o cartão certo
// (`text` com só Copiar e sem rolagem; código com rótulo da linguagem ou "Código", "Quebrar linhas" desligado e corpo focável), o conteúdo
// do cartão é exatamente o da cerca (espaços, Unicode e quebras reais, sem a quebra final), o código inline segue sem cartão e as regras
// de segurança continuam (sem HTML cru, sem imagem e sem link perigoso). Sem DOM: cópia, "Copiado", quebra visual, largura do cartão e
// rolagem da página são provados no navegador real (e2e/conversation.spec.ts).
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from './markdown';

const render = (markdown: string) => renderToStaticMarkup(<Markdown>{markdown}</Markdown>);
/** Os cartões de bloco do HTML, na ordem, para conferir um de cada vez. */
const cards = (html: string) => html.split('<div data-code-block=').slice(1);

describe('Markdown: blocos cercados', () => {
  it('bloco `text` é um cartão "Texto" com só o botão Copiar, corpo que quebra e sem região rolável', () => {
    const [card] = cards(render('Antes\n\n```text\nOlá,  mundo\n```'));
    expect(card).toMatch(/^"text"/);
    expect(card).toContain('>Texto</span>');
    expect(card).toContain('Copiar</button>');
    expect(card).not.toContain('Quebrar linhas');
    expect(card).not.toContain('<pre');
    expect(card).not.toContain('tabindex');
    expect(card).toContain('whitespace-pre-wrap');
  });

  it('bloco de código mostra a linguagem como veio, "Quebrar linhas" desligado, Copiar e corpo rolável focável', () => {
    const [card] = cards(render('```ts\nconst a = 1;\n```'));
    expect(card).toMatch(/^"code"/);
    expect(card).toContain('>ts</span>');
    expect(card).toMatch(/<button[^>]*aria-pressed="false"[^>]*>.*Quebrar linhas<\/button>/);
    expect(card).toContain('Copiar</button>');
    expect(card).toMatch(/<pre tabindex="0" class="[^"]*overflow-x-auto whitespace-pre"/);
    expect(card).toContain('role="status"');
  });

  it('bloco sem identificador é código com o rótulo "Código"', () => {
    const [card] = cards(render('```\nls -la\n```'));
    expect(card).toMatch(/^"code"/);
    expect(card).toContain('>Código</span>');
    expect(card).toContain('Quebrar linhas');
  });

  it('o conteúdo do cartão é exatamente o da cerca: espaços, Unicode e quebras reais, sem a quebra final', () => {
    const content = '  indentado\n\tcom tab  e  espaços\nação ✓ 日本語 🚀\n\núltima';
    const html = render(`\`\`\`python\n${content}\n\`\`\``);
    expect(html).toContain(`<code>${content}</code>`);
    // Bloco vazio: cartão com corpo vazio (Copiar copia vazio).
    expect(render('```ts\n```')).toContain('<code></code>');
  });

  it('código inline segue sem cartão e sem botão', () => {
    const html = render('Use `npm test` aqui.');
    expect(html).toContain('<code>npm test</code>');
    expect(cards(html)).toHaveLength(0);
    expect(html).not.toContain('<button');
  });

  it('continua sem HTML cru, sem imagem e sem link perigoso', () => {
    const html = render('Olá <script>alert(1)</script> ![x](https://evil.example/x.png) [clique](javascript:alert(1)) [ok](https://exemplo.com)\n\n```html\n<b>literal</b>\n```');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('<span>clique</span>');
    expect(html).toContain('<a href="https://exemplo.com" target="_blank" rel="noopener noreferrer nofollow">ok</a>');
    // HTML dentro de um bloco é texto do bloco, escapado, nunca elemento.
    expect(html).toContain('<code>&lt;b&gt;literal&lt;/b&gt;</code>');
  });
});

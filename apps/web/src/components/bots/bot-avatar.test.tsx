// Prova do avatar (phase 5, A1 e A2): o limite de 24 px entre a inicial e a Faísca, o nível de detalhe por tamanho, o que o avatar repassa à Faísca (cor, estado, parada,
// entrada e olhar) e o Aion (dono nulo, Chat geral) que nunca vira marcador. Renderização no servidor, sem DOM; o visual é provado no navegador (E2E e captura).
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BotAvatar } from './bot-avatar';

const BOT = { name: 'financeiro', color: '#60A5FA' };
const render = (props: Partial<Parameters<typeof BotAvatar>[0]> = {}) => renderToStaticMarkup(<BotAvatar owner={BOT} size={32} {...props} />);

describe('BotAvatar', () => {
  it('abaixo de 24 px o bot é a inicial (16 e 20), sem Faísca', () => {
    for (const size of [16, 20]) {
      const html = render({ size });
      expect(html, `${size} px`).not.toContain('<svg');
      expect(html, `${size} px`).toContain('>F<');
      expect(html).toContain(`width:${size}px`);
      expect(html).toContain('aria-hidden="true"');
    }
  });

  it('a partir de 24 px é a Faísca, com o nível de detalhe do tamanho: 24 a 47 liso, 48 ou mais completo', () => {
    const expected: [number, string][] = [
      [24, 'small'],
      [32, 'small'],
      [40, 'small'],
      [47, 'small'],
      [48, 'full'],
      [56, 'full'],
      [96, 'full'],
      [112, 'full'],
    ];
    for (const [size, detail] of expected) {
      const html = render({ size });
      expect(html, `${size} px`).toContain(`data-detail="${detail}"`);
      expect(html).toContain('class="faisca"');
      expect(html).not.toContain('>F<'); // a Faísca não leva a inicial
    }
  });

  it('o Aion (dono nulo) é sempre a Faísca em `--faisca`, nunca o marcador, mesmo abaixo de 24 px', () => {
    for (const size of [16, 20, 24, 32, 112]) {
      const html = render({ owner: null, size });
      expect(html, `${size} px`).toContain('class="faisca"');
      expect(html).toContain('--faisca-body:var(--faisca)');
      expect(html).not.toContain('rounded-full'); // o marcador de inicial
    }
  });

  it('repassa a cor, o estado e o parado; sem eles vale ocioso e a cor do bot', () => {
    expect(render({ owner: { name: 'Rosa', color: '#F472B6' } })).toContain('--faisca-body:#F472B6');
    expect(render({ state: 'sleep', size: 40 })).toContain('data-state="sleep"');
    expect(render({ state: 'working' })).not.toContain('data-still'); // trabalhando se mexe
    expect(render({ state: 'working', still: true })).toContain('data-still'); // a menos que esteja parado (lista, prévia)
    expect(render({ state: 'waiting' })).not.toContain('data-still');
    for (const state of ['idle', 'done', 'error', 'sleep'] as const) expect(render({ state }), state).toContain('data-still'); // os demais nunca se mexem

    const plain = render();
    expect(plain).toContain('data-state="idle"');
    expect(plain).toContain(`--faisca-body:${BOT.color}`);
  });

  it('repassa a entrada e o olhar (telas de destaque); abaixo de 24 px, onde é a inicial, não valem', () => {
    const lively = render({ size: 112, enter: true, gaze: { x: 0.5, y: -0.25 } });
    expect(lively).toContain('data-enter');
    expect(lively).toContain('data-look');
    expect(lively).toContain('--lx:0.5;--ly:-0.25');
    const plain = render({ size: 112 });
    expect(plain).not.toContain('data-enter');
    expect(plain).not.toContain('data-look');
    // O olhar só vale ocioso ou aguardando: a Faísca trabalhando ignora o vetor.
    expect(render({ size: 112, state: 'working', gaze: { x: 1, y: 1 } })).not.toContain('data-look');
    const marker = render({ size: 20, enter: true, gaze: { x: 1, y: 0 } });
    expect(marker).not.toContain('data-enter');
    expect(marker).not.toContain('data-look');
  });

  it('é decorativo nos dois casos: o nome do bot e o estado ficam em texto ao lado, nunca no avatar', () => {
    for (const size of [16, 20, 24, 40, 112]) {
      const html = render({ size });
      expect(html, `${size} px`).toContain('aria-hidden="true"');
      expect(html).not.toContain('role="img"');
      expect(html).not.toContain('aria-label');
    }
  });
});

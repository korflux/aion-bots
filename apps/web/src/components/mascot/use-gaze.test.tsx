// Prova do olhar que segue o cursor (phase 5, F1): o vetor sai do centro da Faísca e nunca passa de `GAZE_LIMIT` (o CSS da Faísca o traduz em
// até 4 px de deslocamento dos olhos), o rastreador só liga com mouse e sem movimento reduzido (e acompanha a mudança dessas preferências), e o HTML do servidor é o mesmo
// com ou sem o hook (sem desvio de hidratação). Sem DOM: o `window` é um duplo mínimo (`GazeEnvironment`); o movimento no navegador real é provado no E2E.
import { renderToStaticMarkup } from 'react-dom/server';
import { useRef } from 'react';
import { describe, expect, it } from 'vitest';
import { Faisca } from './faisca';
import { GAZE_LIMIT, GAZE_REACH_PX, gazeToward, trackGaze, useGaze, type Gaze, type GazeEnvironment, type GazePointerEvent } from './use-gaze';

const BOX = { left: 100, top: 100, width: 112, height: 112 }; // centro em (156, 156)

describe('gazeToward', () => {
  it('o cursor no centro do mascote não desvia o olhar, e a direção é a do cursor', () => {
    expect(gazeToward({ x: 156, y: 156 }, BOX)).toEqual({ x: 0, y: 0 });
    expect(gazeToward({ x: 156 + GAZE_REACH_PX, y: 156 }, BOX)).toEqual({ x: GAZE_LIMIT, y: 0 });
    expect(gazeToward({ x: 156 - GAZE_REACH_PX, y: 156 }, BOX)).toEqual({ x: -GAZE_LIMIT, y: 0 });
    expect(gazeToward({ x: 156, y: 156 + GAZE_REACH_PX }, BOX)).toEqual({ x: 0, y: GAZE_LIMIT });
    expect(gazeToward({ x: 156, y: 156 - GAZE_REACH_PX }, BOX)).toEqual({ x: 0, y: -GAZE_LIMIT });
  });

  it('é proporcional à distância até o alcance e trava no limite além dele', () => {
    expect(gazeToward({ x: 156 + GAZE_REACH_PX / 2, y: 156 }, BOX)).toEqual({ x: 0.45, y: 0 }); // metade do alcance: metade do limite
    expect(gazeToward({ x: 156 + 100 * GAZE_REACH_PX, y: 156 }, BOX)).toEqual({ x: GAZE_LIMIT, y: 0 });
  });

  it('o limite deixa o deslocamento dos olhos em até 4 px na Faísca de 112 px, com o arredondamento (o CSS da Faísca move 4,6 unidades do quadro de 128 no vetor 1)', () => {
    const CSS_SHIFT_UNITS = 2.2 + 2.4; // rosto + olhos, faisca.css seção 5
    const ROUNDING = Math.SQRT2 * 0.005; // arredondar cada eixo em centésimos soma, no pior caso, até 0,007 ao comprimento
    expect(CSS_SHIFT_UNITS * (GAZE_LIMIT + ROUNDING) * (112 / 128)).toBeLessThanOrEqual(4);
    expect(CSS_SHIFT_UNITS * 1 * (112 / 128)).toBeGreaterThan(4); // sem o limite passaria
  });

  it('o comprimento do vetor nunca passa do limite em direção nenhuma, nem com o cursor muito longe', () => {
    for (let x = -3000; x <= 3000; x += 187) {
      for (let y = -3000; y <= 3000; y += 191) {
        const gaze = gazeToward({ x, y }, BOX);
        expect(Math.hypot(gaze.x, gaze.y), `cursor em ${x},${y}`).toBeLessThanOrEqual(GAZE_LIMIT + Math.SQRT2 * 0.005);
      }
    }
    // Na diagonal o vetor também chega perto do limite (o arredondamento em centésimos o move menos de 0,007).
    const diagonal = gazeToward({ x: 156 + 10_000, y: 156 + 10_000 }, BOX);
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeGreaterThan(GAZE_LIMIT - 0.02);
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeLessThanOrEqual(GAZE_LIMIT + Math.SQRT2 * 0.005);
  });
});

/** `window` de mentira: guarda os ouvintes, deixa o teste mudar as preferências de mídia e disparar movimentos e quadros. */
function fakeEnvironment(initial: { reduced: boolean; fine: boolean }) {
  const media = { '(prefers-reduced-motion: reduce)': { matches: initial.reduced, listeners: new Set<() => void>() }, '(hover: hover) and (pointer: fine)': { matches: initial.fine, listeners: new Set<() => void>() } };
  const moves = new Set<(event: GazePointerEvent) => void>();
  const frames = new Map<number, () => void>();
  let nextFrame = 1;
  const added: unknown[] = [];
  const environment: GazeEnvironment = {
    matchMedia: (query) => {
      const entry = media[query as keyof typeof media];
      return {
        get matches() {
          return entry.matches;
        },
        addEventListener: (_type, listener) => entry.listeners.add(listener),
        removeEventListener: (_type, listener) => entry.listeners.delete(listener),
      };
    },
    addEventListener: (_type, listener, options) => {
      moves.add(listener);
      added.push(options);
    },
    removeEventListener: (_type, listener) => moves.delete(listener),
    requestAnimationFrame: (callback) => {
      frames.set(nextFrame, callback);
      return nextFrame++;
    },
    cancelAnimationFrame: (handle) => frames.delete(handle),
  };
  return {
    environment,
    /** Quantos ouvintes de `pointermove` estão ligados. */
    listening: () => moves.size,
    /** Opções com que o ouvinte foi registrado. */
    added,
    /** Muda uma preferência e avisa quem a observa, como o navegador faz. */
    setMedia: (query: keyof typeof media, matches: boolean) => {
      media[query].matches = matches;
      for (const listener of [...media[query].listeners]) listener();
    },
    /** O cursor se mexeu; o olhar só sai quando o quadro seguinte roda. */
    move: (event: GazePointerEvent) => {
      for (const listener of [...moves]) listener(event);
    },
    runFrames: () => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback();
    },
    pendingFrames: () => frames.size,
  };
}

const REDUCED = '(prefers-reduced-motion: reduce)';
const FINE = '(hover: hover) and (pointer: fine)';
const target = () => ({ getBoundingClientRect: () => BOX as DOMRect });
const mouse = (x: number, y: number): GazePointerEvent => ({ clientX: x, clientY: y, pointerType: 'mouse' });

describe('trackGaze', () => {
  it('com mouse e movimento normal acompanha o cursor, uma vez por quadro, e entrega o vetor do centro do elemento', () => {
    const fake = fakeEnvironment({ reduced: false, fine: true });
    const seen: (Gaze | null)[] = [];
    trackGaze(fake.environment, target, (gaze) => seen.push(gaze));
    expect(fake.listening()).toBe(1);
    expect(fake.added).toEqual([{ passive: true }]);

    fake.move(mouse(156 + GAZE_REACH_PX, 156));
    fake.move(mouse(156, 156 - GAZE_REACH_PX)); // mais um movimento antes do quadro: só o último conta
    expect(fake.pendingFrames()).toBe(1);
    fake.runFrames();
    expect(seen).toEqual([{ x: 0, y: -GAZE_LIMIT }]);
  });

  it('com movimento reduzido não liga: nenhum ouvinte, nenhum quadro e nenhum vetor, por mais que o cursor se mexa', () => {
    const fake = fakeEnvironment({ reduced: true, fine: true });
    const seen: (Gaze | null)[] = [];
    trackGaze(fake.environment, target, (gaze) => seen.push(gaze));
    expect(fake.listening()).toBe(0);
    fake.move(mouse(300, 300));
    fake.runFrames();
    expect(seen).toEqual([]);
  });

  it('em tela de toque (sem ponteiro preciso) não liga, e um dedo ou uma caneta nunca são o cursor', () => {
    const touch = fakeEnvironment({ reduced: false, fine: false });
    const seen: (Gaze | null)[] = [];
    trackGaze(touch.environment, target, (gaze) => seen.push(gaze));
    expect(touch.listening()).toBe(0);
    touch.move(mouse(300, 300));
    touch.runFrames();
    expect(seen).toEqual([]);

    const hybrid = fakeEnvironment({ reduced: false, fine: true });
    trackGaze(hybrid.environment, target, (gaze) => seen.push(gaze));
    for (const pointerType of ['touch', 'pen']) hybrid.move({ clientX: 300, clientY: 300, pointerType });
    expect(hybrid.pendingFrames()).toBe(0);
    hybrid.runFrames();
    expect(seen).toEqual([]);
  });

  it('acompanha a mudança das preferências com a tela aberta: ao reduzir o movimento desliga e devolve null; ao voltar, religa', () => {
    const fake = fakeEnvironment({ reduced: false, fine: true });
    const seen: (Gaze | null)[] = [];
    trackGaze(fake.environment, target, (gaze) => seen.push(gaze));
    fake.move(mouse(156 + GAZE_REACH_PX, 156));
    fake.runFrames();
    expect(seen).toEqual([{ x: GAZE_LIMIT, y: 0 }]);

    fake.move(mouse(156, 156 + GAZE_REACH_PX)); // quadro pendente que não deve sobreviver ao desligamento
    fake.setMedia(REDUCED, true);
    expect(fake.listening()).toBe(0);
    expect(fake.pendingFrames()).toBe(0);
    expect(seen).toEqual([{ x: GAZE_LIMIT, y: 0 }, null]);

    fake.setMedia(REDUCED, false);
    expect(fake.listening()).toBe(1);
    fake.setMedia(FINE, false);
    expect(fake.listening()).toBe(0);
  });

  it('o elemento já fora da tela (ref vazio) não gera vetor, e desfazer remove o ouvinte e o quadro pendente', () => {
    const fake = fakeEnvironment({ reduced: false, fine: true });
    const seen: (Gaze | null)[] = [];
    const stop = trackGaze(fake.environment, () => null, (gaze) => seen.push(gaze));
    fake.move(mouse(300, 300));
    fake.runFrames();
    expect(seen).toEqual([]);

    fake.move(mouse(300, 300));
    stop();
    expect(fake.listening()).toBe(0);
    expect(fake.pendingFrames()).toBe(0);
    fake.setMedia(REDUCED, true); // depois de desfeito, mudar a preferência não toca em mais nada
    fake.setMedia(REDUCED, false);
    expect(fake.listening()).toBe(0);
  });
});

describe('useGaze no servidor', () => {
  /** Uma Faísca com o olhar do hook, como a conversa vazia o usa. */
  function Probe() {
    const ref = useRef<HTMLDivElement>(null);
    const gaze = useGaze(ref);
    return (
      <div ref={ref}>
        <Faisca color="#60A5FA" size={112} state="idle" enter gaze={gaze} />
      </div>
    );
  }

  it('o HTML é idêntico ao da Faísca sem olhar: o hook começa em null, e o olhar só chega depois de montar (sem desvio de hidratação)', () => {
    const withHook = renderToStaticMarkup(<Probe />);
    const without = renderToStaticMarkup(
      <div>
        <Faisca color="#60A5FA" size={112} state="idle" enter gaze={null} />
      </div>,
    );
    expect(withHook).toBe(without);
    expect(withHook).not.toContain('data-look');
    expect(withHook).not.toContain('--lx');
  });
});

'use client';

// Olhar da Faísca que segue o cursor: o hook de cliente das telas de destaque, a conversa vazia (do bot e do Chat geral) e o login. Quem usa
// guarda o elemento da Faísca num `ref`, chama `useGaze(ref)` e entrega o resultado à prop `gaze` da `Faisca` (ou do `BotAvatar`):
//
//   const ref = useRef<HTMLDivElement>(null);
//   const gaze = useGaze(ref);
//   <div ref={ref}><BotAvatar ... state="idle" gaze={gaze} /></div>
//
// O que o hook devolve é um vetor (direção e distância do cursor ao CENTRO do elemento, até `GAZE_REACH_PX`), ou `null`, de comprimento até `GAZE_LIMIT`.
// A Faísca escreve o vetor em `--lx` e `--ly`, e o CSS dela (faisca.css, seção 5) desloca o rosto (2,2) e os olhos (2,4) em 220 ms, ao todo 4,6 unidades
// do quadro de 128 no extremo do vetor 1, ou seja 4,0 px na Faísca de 112 px. O olhar do design vai "até 4 px", então o vetor para em `GAZE_LIMIT`.
//
// Quando é `null`: no servidor, na primeira renderização do cliente (por isso o HTML hidratado é idêntico ao do servidor: o olhar só começa
// depois de montar, no efeito), com movimento reduzido, em tela de toque e enquanto o cursor não se mexeu. `null` é o olhar à frente: a Faísca ociosa não
// olha em volta sozinha (só trabalhando e aguardando se mexem). O olhar só vale nos estados ocioso e aguardando (a `Faisca` ignora o vetor nos demais).
import { useEffect, useState, type RefObject } from 'react';

/** Para onde olhar: de -1 (esquerda ou cima) a 1 (direita ou baixo) em cada eixo. */
export interface Gaze {
  x: number;
  y: number;
}

/** Distância do cursor ao centro da Faísca, em px, a partir da qual o olhar chega ao limite; mais perto, o olhar é proporcional à distância. */
export const GAZE_REACH_PX = 160;

/**
 * Comprimento máximo do vetor de olhar (a `Faisca` aceita até 1). Com o CSS da Faísca o vetor 1 desloca os olhos 4,6 unidades de 128, ou seja 4,03 px nos 112 px
 * das telas de destaque (a Faísca ociosa não respira). 0,9 deixa o extremo em 3,62 px e, somado ao arredondamento de cada eixo em centésimos (até 0,007 de
 * comprimento a mais), em 3,65 px: dentro do "até 4 px" do design, e menos nos 96 px do celular. Se o deslocamento da Faísca (faisca.css, seção 5) ou o tamanho
 * de destaque mudar, esta é a constante a rever.
 */
export const GAZE_LIMIT = 0.9;

/** Preferência do sistema por menos movimento: o olhar não segue o cursor (a Faísca fica na pose estática do estado). */
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
/** Ponteiro principal preciso com hover (mouse, trackpad): é o que distingue o cursor do dedo. Em tela de toque não há cursor para seguir. */
const FINE_POINTER = '(hover: hover) and (pointer: fine)';

/**
 * Vetor de olhar para um cursor em `pointer`, visto de um elemento com a caixa `box` (coordenadas da janela). Do centro da caixa ao cursor, com
 * comprimento proporcional à distância até `GAZE_REACH_PX` e travado em `GAZE_LIMIT` além disso (`dx / max(distância, alcance)` é as duas coisas de uma
 * vez). Arredonda em centésimos (0,01 do deslocamento máximo é menos de meio décimo de pixel) para um cursor que se mexe pouco não gerar renderizações
 * diferentes à toa e o vetor sair com números limpos; o arredondamento pode somar até 0,007 ao comprimento, já contado em `GAZE_LIMIT`.
 */
export function gazeToward(pointer: { x: number; y: number }, box: { left: number; top: number; width: number; height: number }): Gaze {
  const dx = pointer.x - (box.left + box.width / 2);
  const dy = pointer.y - (box.top + box.height / 2);
  const scale = Math.max(Math.hypot(dx, dy), GAZE_REACH_PX) / GAZE_LIMIT;
  // `+ 0` troca o -0 de um cursor exatamente no centro pelo 0 (o vetor vai escrito no estilo da Faísca).
  return { x: Math.round((dx / scale) * 100) / 100 + 0, y: Math.round((dy / scale) * 100) / 100 + 0 };
}

/** O pouco que `trackGaze` usa do `window`: separado para a decisão de ligar o olhar ser provada em teste, sem DOM. */
export interface GazeEnvironment {
  matchMedia(query: string): { matches: boolean; addEventListener(type: 'change', listener: () => void): void; removeEventListener(type: 'change', listener: () => void): void };
  addEventListener(type: 'pointermove', listener: (event: GazePointerEvent) => void, options: { passive: true }): void;
  removeEventListener(type: 'pointermove', listener: (event: GazePointerEvent) => void): void;
  requestAnimationFrame(callback: () => void): number;
  cancelAnimationFrame(handle: number): void;
}

/** O que o rastreador lê de um evento de ponteiro. */
export type GazePointerEvent = Pick<PointerEvent, 'clientX' | 'clientY' | 'pointerType'>;

/**
 * Liga o olhar: enquanto o movimento NÃO está reduzido e o ponteiro é preciso (mouse), acompanha o `pointermove` da janela, no máximo uma vez por
 * quadro, e entrega o vetor a `onGaze`. Reage à mudança das duas preferências com a tela aberta: ao desligar, para de ouvir e entrega `null` (a
 * Faísca volta à pose do estado); ao religar, volta a ouvir. Dedos e canetas (`pointerType` diferente de mouse) não são cursor. Devolve a função
 * que desfaz tudo (ouvintes e quadro pendente).
 */
export function trackGaze(env: GazeEnvironment, target: () => Pick<HTMLElement, 'getBoundingClientRect'> | null, onGaze: (gaze: Gaze | null) => void): () => void {
  const reduced = env.matchMedia(REDUCED_MOTION);
  const fine = env.matchMedia(FINE_POINTER);
  let frame = 0;
  let listening = false;

  const onMove = (event: GazePointerEvent) => {
    if (event.pointerType !== 'mouse') return;
    env.cancelAnimationFrame(frame);
    frame = env.requestAnimationFrame(() => {
      const box = target()?.getBoundingClientRect();
      if (box) onGaze(gazeToward({ x: event.clientX, y: event.clientY }, box));
    });
  };

  const sync = () => {
    const enabled = !reduced.matches && fine.matches;
    if (enabled === listening) return;
    listening = enabled;
    if (enabled) {
      env.addEventListener('pointermove', onMove, { passive: true });
    } else {
      env.removeEventListener('pointermove', onMove);
      env.cancelAnimationFrame(frame);
      onGaze(null);
    }
  };

  reduced.addEventListener('change', sync);
  fine.addEventListener('change', sync);
  sync();
  return () => {
    reduced.removeEventListener('change', sync);
    fine.removeEventListener('change', sync);
    if (listening) env.removeEventListener('pointermove', onMove);
    env.cancelAnimationFrame(frame);
  };
}

/**
 * Para onde a Faísca do elemento em `ref` deve olhar, seguindo o cursor (ver o cabeçalho do arquivo). `null` até o cursor se mexer, e sempre
 * `null` com movimento reduzido ou em toque. O elemento de `ref` deve ser o da própria Faísca (o vetor sai do centro dela).
 */
export function useGaze(ref: RefObject<HTMLElement | null>): Gaze | null {
  const [gaze, setGaze] = useState<Gaze | null>(null);
  useEffect(
    () =>
      trackGaze(
        window,
        () => ref.current,
        // Mesmo vetor, mesmo estado: evita renderizar de novo a Faísca (e o resto da conversa vazia) a cada movimento do cursor.
        (next) => setGaze((previous) => (previous?.x === next?.x && previous?.y === next?.y ? previous : next)),
      ),
    [ref],
  );
  return gaze;
}

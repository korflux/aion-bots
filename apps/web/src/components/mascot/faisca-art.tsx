// Desenho da Faísca em SVG (peças puras, sem estado): portado de `docs/identidade/gerador/faisca.mjs`, a fonte do design system, para o app desenhar a Faísca
// inline (nunca um <img> dos SVG de `assets/`, porque a cor do corpo, o estado e o movimento mudam em tempo de execução). Quadro `-4 -8 128 128`; luz de cima à
// esquerda; corpo em camadas (base, sombras, barriga, brilho, tufo).
//
// Cores: o corpo e os seus tons (sombra, brilho) vêm do CSS (faisca.css, `--faisca-body` e `color-mix`), porque a cor de um bot é um valor em tempo de
// execução e a do Aion é um token (`var(--faisca)`); a tinta do rosto, as bochechas e a estrela ociosa usam os tokens `--tinta`, `--bochecha`, `--brilho`,
// `--brilho-miolo` e `--brilho-traco`. Os demais tons (estrela de cada estado, ícones flutuantes) são os literais do design: são o vocabulário de estado do
// mascote, não cores de interface.
//
// Níveis (faisca-detail.ts): `rich` (48 px ou mais) liga pelo, miolo e brilho da estrela, dedinhos e o ícone flutuante; abaixo disso o contorno da estrela
// engrossa e o resto some. Movimento: as classes `fx-*` só marcam o que se move; quem decide se roda é o CSS (`.faisca:not([data-still])`).
import type { CSSProperties, ReactNode } from 'react';
import type { FaiscaState } from './faisca-detail';

/** Estrela de quatro pontas, centrada na origem (a antena, o brilho de conclusão e o pingo do i da marca; o `Logo` importa daqui para a estrela ter uma fonte só). */
export const STAR = 'M0 -11 C1.6 -3.6 3.6 -1.6 11 0 C3.6 1.6 1.6 3.6 0 11 C-1.6 3.6 -3.6 1.6 -11 0 C-3.6 -1.6 -1.6 -3.6 0 -11Z';
/** Corpo: gota arredondada, achatada embaixo. */
const BODY = 'M60 27 C86 27 100 45 102 70 C104 94 94 106 60 106 C26 106 16 94 18 70 C20 45 34 27 60 27Z';

/** Estrela de cada estado: miolo, preenchimento, contorno e escala. O ocioso usa os tokens da marca; os outros, o vocabulário de estado do mascote. */
const SPARK: Record<FaiscaState, { core: string; fill: string; line: string; scale: number }> = {
  idle: { core: 'var(--brilho-miolo)', fill: 'var(--brilho)', line: 'var(--brilho-traco)', scale: 1 },
  working: { core: '#FEF9C3', fill: '#FDE047', line: '#CA8A04', scale: 1.2 },
  waiting: { core: '#FED7AA', fill: '#FB923C', line: '#C2410C', scale: 1 },
  done: { core: '#FEF9C3', fill: '#FDE047', line: '#CA8A04', scale: 1.12 },
  error: { core: '#FECACA', fill: '#F87171', line: '#B91C1C', scale: 0.82 },
  sleep: { core: '#E2E8F0', fill: '#CBD5E1', line: '#64748B', scale: 0.78 },
};

/** Arredonda a dois decimais para o HTML sair limpo (somas de ponto flutuante viram 48.800000000000004). */
const round = (value: number): number => Math.round(value * 100) / 100;

/** Olho de um estado: concluído é um arco feliz, dormindo é um arco fechado, os demais são a elipse com reflexo (trabalhando olha de lado, aguardando para cima). */
function Eye({ cx, cy, state }: { cx: number; cy: number; state: FaiscaState }) {
  if (state === 'done') return <path className="fa-ink-line" strokeWidth="3.2" d={`M${cx - 5.5} ${cy + 1.5} Q${cx} ${cy - 6} ${cx + 5.5} ${cy + 1.5}`} />;
  if (state === 'sleep') return <path className="fa-ink-line" strokeWidth="3.2" d={`M${cx - 5.5} ${cy - 1} Q${cx} ${cy + 4.5} ${cx + 5.5} ${cy - 1}`} />;
  const lx = state === 'working' ? 1.6 : 0;
  const ly = state === 'waiting' ? -1 : 0;
  const ry = state === 'error' ? 5.6 : 6.8;
  return (
    <>
      <ellipse className="fa-ink" data-part="pupil" cx={cx} cy={cy} rx="5.6" ry={ry} />
      <ellipse cx={round(cx + lx * 0.4)} cy={round(cy + ry * 0.45)} rx="3.4" ry="1.8" fill="#4B4570" />
      <circle cx={round(cx + 1.9 + lx)} cy={round(cy - 2.6 + ly)} r="2.3" fill="#fff" />
      <circle cx={round(cx - 1.8 + lx)} cy={round(cy + 2.4 + ly)} r="1" fill="#fff" fillOpacity=".85" />
    </>
  );
}

/** Sobrancelhas: erro (tristes), aguardando (uma de dúvida) e trabalhando (retas, concentradas); os outros estados não têm. */
function Brows({ state }: { state: FaiscaState }) {
  if (state === 'error') return <path className="fa-ink-line" strokeWidth="2.4" d="M42.5 55.5 Q47 55 53 58.5 M77.5 55.5 Q73 55 67 58.5" />;
  if (state === 'waiting') return <path className="fa-ink-line" strokeWidth="2.4" d="M66 56 Q71 52.5 76.5 55" />;
  if (state === 'working') return <path className="fa-ink-line" strokeWidth="2.2" d="M44 57 Q49 55.5 54 57 M66 57 Q71 55.5 76 57" />;
  return null;
}

/** Boca de cada estado: sorriso, "o" de esforço, traço ondulado de dúvida, sorriso aberto com língua, linha torta de aflição e "o" de sono. */
function Mouth({ state }: { state: FaiscaState }) {
  switch (state) {
    case 'working':
      return <path className="fa-ink" d="M57.5 76.6 Q60 74.8 62.5 76.6 Q62.4 80 60 80 Q57.6 80 57.5 76.6Z" />;
    case 'waiting':
      return <path className="fa-ink-line" strokeWidth="2.4" d="M56 77.6 Q58 76 60 77 T64 76.4" />;
    case 'done':
      return (
        <>
          <path className="fa-ink" d="M53.6 74 Q60 74.6 66.4 74 Q65.4 83.6 60 83.6 Q54.6 83.6 53.6 74Z" />
          <path className="fa-cheek" d="M56.4 80.6 Q60 77.6 63.6 80.6 Q62.2 82.6 60 82.6 Q57.8 82.6 56.4 80.6Z" />
        </>
      );
    case 'error':
      return <path className="fa-ink-line" strokeWidth="2.4" d="M55.4 79 Q57.7 75.8 60 78.2 Q62.3 80.6 64.6 77.4" />;
    case 'sleep':
      return <ellipse className="fa-ink" cx="60" cy="77.6" rx="2.2" ry="2.6" />;
    default:
      return <path className="fa-ink-line" strokeWidth="2.4" d="M55.8 75.2 Q60 79.8 64.2 75.2" />;
  }
}

/**
 * Rosto: bochechas, sobrancelhas, olhos e boca. Duas camadas aninhadas para o olhar que segue o cursor (`fa-face` desloca o rosto todo, `fa-follow` os olhos
 * um pouco mais; `data-part` `face`, `eyes` e `pupil` são o ponto de ancoragem estável do E2E, no lugar das classes de desenho), porque `transform` de dois movimentos no mesmo elemento não se compõe. Parado, as camadas ficam na origem.
 */
export function FaiscaFace({ state }: { state: FaiscaState }) {
  // Bochechas mais fracas no erro (o rosto empalidece).
  const cheek = state === 'error' ? 0.22 : 0.5;
  return (
    <g className="fa-face" data-part="face">
      <ellipse className="fa-cheek" cx="38.5" cy="76" rx="7" ry="4.2" fillOpacity={(cheek * 0.6).toFixed(2)} />
      <ellipse className="fa-cheek" cx="38.5" cy="76" rx="4.6" ry="2.6" fillOpacity={cheek} />
      <ellipse className="fa-cheek" cx="81.5" cy="76" rx="7" ry="4.2" fillOpacity={(cheek * 0.6).toFixed(2)} />
      <ellipse className="fa-cheek" cx="81.5" cy="76" rx="4.6" ry="2.6" fillOpacity={cheek} />
      <g className="fa-follow" data-part="eyes">
        <Brows state={state} />
        <Eye cx={49} cy={65.5} state={state} />
        <Eye cx={71} cy={65.5} state={state} />
      </g>
      <Mouth state={state} />
    </g>
  );
}

/** Antena com a estrela da faísca. `rich` acrescenta o miolo claro e o brilho; `halo` (trabalhando e concluído) acende um clarão atrás da estrela. */
export function FaiscaAntenna({ state, rich }: { state: FaiscaState; rich: boolean }) {
  const { core, fill, line, scale } = SPARK[state];
  const halo = state === 'working' || state === 'done';
  const star: CSSProperties = { fill, stroke: line };
  // Erro e sono derrubam a antena (a pose não depende do movimento).
  const droop = state === 'error' ? 'rotate(26 60 30)' : state === 'sleep' ? 'rotate(-22 60 30)' : undefined;
  return (
    <g transform={droop}>
      <g className="fx-ant">
        <path className="fa-s78" d="M57.4 31 C55 22 57 14.6 63.4 11.6 L64.6 13.8 C60 16.6 59 22.4 61.6 31Z" />
        <g transform="translate(64 11)">
          <g className="fx-tw">
            {halo ? (
              <>
                <circle r="15" fill={fill} fillOpacity=".28" />
                <circle r="10" fill={fill} fillOpacity=".35" />
              </>
            ) : null}
            <path className="fa-spark" d={STAR} transform={`scale(${scale})`} style={star} strokeWidth={rich ? 1.4 : 2.6} strokeLinejoin="round" />
            {rich ? (
              <>
                <path className="fa-spark" d={STAR} transform={`scale(${(scale * 0.48).toFixed(3)})`} style={{ fill: core }} />
                <circle cx="-2.4" cy="-2.6" r="1.3" fill="#fff" />
              </>
            ) : null}
          </g>
        </g>
      </g>
    </g>
  );
}

/** Corpo em camadas (pés, braços, tronco, sombras, barriga, brilho e tufo). `furId` liga o filtro de pelo no nível completo; liso, o grupo vai sem filtro. */
export function FaiscaBody({ state, furId }: { state: FaiscaState; furId: string | null }) {
  // Braços: para cima na comemoração, recolhidos na dúvida.
  const arm = state === 'done' ? 32 : state === 'waiting' ? 14 : 22;
  return (
    <g filter={furId ? `url(#${furId})` : undefined}>
      <ellipse className="fa-s72" cx="44" cy="105" rx="12.5" ry="7.2" />
      <ellipse className="fa-s72" cx="76" cy="105" rx="12.5" ry="7.2" />
      <ellipse className="fa-s80" cx="21" cy="81" rx="7.2" ry="11.5" transform={`rotate(${arm} 21 81)`} />
      <ellipse className="fa-s80" cx="99" cy="81" rx="7.2" ry="11.5" transform={`rotate(${-arm} 99 81)`} />
      <path className="fa-body" d={BODY} />
      <path className="fa-s84" d="M18.6 78 C22 98 36 106 60 106 C84 106 98 98 101.4 78 C96 94 82 100 60 100 C38 100 24 94 18.6 78Z" />
      <path className="fa-s86" d="M88 40 C101 56 104 82 94 98 C98 80 96 60 88 40Z" />
      <ellipse className="fa-l84" cx="60" cy="88" rx="23" ry="11.5" fillOpacity=".5" />
      <path className="fa-l64" d="M30 56 C31 44 40 35 51 32 C44 38 37 46 34 57Z" fillOpacity=".7" />
      <path className="fa-body" d="M54 31.5 Q55.5 25 59 30 Q60.5 24 63.5 30 Q65.5 26 66.5 31.5Z" />
    </g>
  );
}

/** Dedinhos dos pés: só no nível completo (em 24 px viram ruído). */
export function FaiscaToes() {
  return <path className="fa-toes" d="M52 101 Q54 98 56 101 M64 101 Q66 98 68 101" />;
}

/** Balão de "digitando" do estado trabalhando: três pontinhos que sobem em sequência (o movimento é do CSS). */
function WorkingBubble() {
  return (
    <g transform="translate(97 26)">
      <g className="fx-float">
        <path d="M-7 9 L-12 16 L-1 10.5Z" fill="#fff" stroke="#CBD5E1" strokeWidth="1.5" strokeLinejoin="round" />
        <rect x="-15" y="-10" width="30" height="20" rx="10" fill="#fff" stroke="#CBD5E1" strokeWidth="1.5" />
        <path d="M-9 9.2 L-6 9.2" stroke="#fff" strokeWidth="2.2" />
        {[-7, 0, 7].map((x) => (
          <circle key={x} className="fx-dot" cx={x} cy="0" r="2.6" fill="#3B82F6" />
        ))}
      </g>
    </g>
  );
}

/** Disco de estado com símbolo (aguardando "?", concluído "✓", erro "!"): o que a pose não diz sozinha, também por forma e não só por cor. */
function StateDisc({ x, y, tail, fill, stroke, children }: { x: number; y: number; tail?: boolean; fill: string; stroke: string; children: ReactNode }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <g className="fx-float">
        {tail ? <path d="M-7 9 L-12 16 L-1 10.5Z" fill={fill} stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" /> : null}
        <circle r="12" fill={fill} stroke={stroke} strokeWidth="1.5" />
        {children}
      </g>
    </g>
  );
}

/** "z" de sono: três, de tamanhos crescentes, subindo para a direita. Ficam sempre visíveis (a Faísca dormindo não se mexe). */
function Zzz() {
  const z = (x: number, y: number, k: number) => (
    <g key={x} transform={`translate(${x} ${y}) scale(${k})`}>
      <path d="M-5 -5 H5 L-5 5 H5" fill="none" stroke="#818CF8" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </g>
  );
  return (
    <>
      {z(88, 40, 0.8)}
      {z(96, 28, 1)}
      {z(105, 15, 1.2)}
    </>
  );
}

/** Estrelinhas da conclusão. */
function Sparkles() {
  return (
    <g fill="#FDE047" stroke="#CA8A04" strokeWidth="1">
      <path transform="translate(18 40) scale(.42)" d={STAR} />
      <path transform="translate(30 20) scale(.3)" d={STAR} />
      <path transform="translate(108 56) scale(.34)" d={STAR} />
    </g>
  );
}

/**
 * Ícone flutuante do estado, em cima à direita (só no nível completo; o ocioso não tem). Trabalhando: balão de digitação; aguardando: "?" sobre disco âmbar;
 * concluído: "✓" sobre disco verde com estrelinhas; erro: "!" sobre disco vermelho com uma gota; dormindo: os "z".
 */
export function FaiscaBubble({ state }: { state: FaiscaState }) {
  switch (state) {
    case 'working':
      return <WorkingBubble />;
    case 'waiting':
      return (
        <StateDisc x={98} y={26} tail fill="#F59E0B" stroke="#B45309">
          <path d="M-3.6 -3.4 Q-3.6 -7 0 -7 Q3.6 -7 3.6 -3.6 Q3.6 -1 0 0.6 V2.4" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
          <circle cx="0" cy="6.2" r="1.7" fill="#fff" />
        </StateDisc>
      );
    case 'done':
      return (
        <>
          <StateDisc x={98} y={28} fill="#16A34A" stroke="#15803D">
            <path d="M-5.4 0.4 L-1.6 4.4 L5.6 -4" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          </StateDisc>
          <Sparkles />
        </>
      );
    case 'error':
      return (
        <>
          <StateDisc x={98} y={28} fill="#DC2626" stroke="#B91C1C">
            <path d="M0 -6.4 V1.4" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
            <circle cx="0" cy="6" r="1.8" fill="#fff" />
          </StateDisc>
          <path d="M96.5 52 Q100.5 59.5 96.5 63 Q92.5 59.5 96.5 52Z" fill="#BAE6FD" stroke="#38BDF8" strokeWidth="1.2" />
        </>
      );
    case 'sleep':
      return <Zzz />;
    case 'idle':
      return null;
  }
}

/** Filtro de pelo (ruído fractal que desloca a borda do corpo): declarado dentro de cada <svg> do nível completo, com id próprio. */
export function FaiscaFurFilter({ id }: { id: string }) {
  return (
    <defs>
      <filter id={id} x="-8%" y="-8%" width="116%" height="116%">
        <feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="2" seed="11" />
        <feDisplacementMap in="SourceGraphic" scale="2.4" />
      </filter>
    </defs>
  );
}

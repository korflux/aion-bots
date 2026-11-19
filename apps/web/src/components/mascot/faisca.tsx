// Faísca: o mascote único do Aion (identidade da phase 5, ID-01; substitui os seis personagens da phase 1). É o ÚNICO componente que desenha o mascote:
// SVG inline com movimento em CSS (faisca.css, importado por globals.css), seis estados (ocioso, trabalhando, aguardando, concluído, erro, dormindo), a cor
// do bot ou a de marca como cor do corpo e o nível de detalhe escolhido pelo tamanho (faisca-detail.ts). O desenho vem de `docs/identidade/gerador/faisca.mjs`
// (faisca-art.tsx); os SVG de `docs/identidade/assets/Faisca` são só referência visual e nunca entram como <img>.
//
// Uso: <Faisca color={bot.color} state={runState} size={32} /> para um bot; <Faisca state="working" size={24} /> para o Aion (corpo em `--faisca`).
// Quem não tem bot nem é o Aion não usa a Faísca (ver `BotAvatar`, o ponto único de escolha entre a Faísca e o marcador de inicial).
// Estado: sempre o que `mascotStateOfRunStatus` e `botRunStateOf` (packages/shared/src/live-state.ts) devolvem; a tela não inventa estado.
// Níveis: 48 px ou mais completo (pelo, miolo e brilho da estrela, dedinhos, ícone flutuante); de 24 a 47 px liso; abaixo de 24 px o avatar do bot é o
// marcador de inicial e o Chat geral nunca usa marcador (decisão do design). O estado também sempre vai em texto ao lado: a Faísca é decorativa.
// Movimento: só `working` e `waiting` rodam laços, e nunca com `still` (listas e qualquer Faísca que não seja o foco da tela). `enter` anima a entrada
// uma vez (login, estados vazios, erros); `gaze` desloca o rosto em direção ao cursor (só ocioso e aguardando; ver use-gaze.ts). Com
// `prefers-reduced-motion` nada se mexe (a regra global de globals.css zera as animações) e os "z" do sono continuam visíveis.
// Acessibilidade: `aria-hidden` sem rótulo; com `label` vira uma imagem nomeada.
import type { CSSProperties } from 'react';
import { useId } from 'react';
import { cn } from '@/lib/cn';
import { FaiscaAntenna, FaiscaBody, FaiscaBubble, FaiscaFace, FaiscaFurFilter, FaiscaToes } from './faisca-art';
import { FAISCA_AION_COLOR, faiscaDetailOf, faiscaMoves, type FaiscaState } from './faisca-detail';

export interface FaiscaProps {
  /** Cor do corpo: `#RRGGBB` do bot, ou um valor CSS como `var(--faisca)` (o padrão, quando a Faísca representa o Aion). */
  color?: string;
  state?: FaiscaState;
  /** Lado em px (o desenho é quadrado). Escolhe o nível de detalhe: 48 ou mais completo, de 24 a 47 liso. */
  size?: number;
  /** Nome para leitores de tela; sem ele a Faísca é decorativa (`aria-hidden`). */
  label?: string;
  /** Desliga os laços de movimento (listas e qualquer Faísca que não seja o foco). A pose e o ícone do estado continuam. */
  still?: boolean;
  /** Anima a entrada (pop com leve salto), uma vez ao montar. Para telas vazias, login e erros. */
  enter?: boolean;
  /** Para onde olhar, de -1 a 1 em cada eixo. Só vale ocioso ou aguardando; `null` deixa o olhar à frente. */
  gaze?: { x: number; y: number } | null;
  className?: string;
}

const clamp1 = (value: number): number => Math.max(-1, Math.min(1, value));

export function Faisca({ color = FAISCA_AION_COLOR, state = 'idle', size = 96, label, still = false, enter = false, gaze = null, className }: FaiscaProps) {
  const rich = faiscaDetailOf(size) === 'full';
  // O filtro de pelo precisa de um id próprio por desenho (vários podem estar na mesma página); `useId` traz ":" e "«", que não servem em `url(#...)`.
  const furId = `faisca-fur-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const looking = gaze !== null && (state === 'idle' || state === 'waiting');
  const style = {
    '--faisca-body': color,
    ...(looking ? { '--lx': clamp1(gaze.x), '--ly': clamp1(gaze.y) } : {}),
  } as CSSProperties;
  return (
    <svg
      viewBox="-4 -8 128 128"
      width={size}
      height={size}
      style={style}
      className={cn('faisca', className)}
      data-state={state}
      data-detail={rich ? 'full' : 'small'}
      data-still={faiscaMoves(state, still) ? undefined : ''}
      data-enter={enter ? '' : undefined}
      data-look={looking ? '' : undefined}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {rich ? <FaiscaFurFilter id={furId} /> : null}
      <g className="fa-enter">
        <ellipse className="fa-ground" cx="60" cy="114" rx="31" ry="4.2" />
        <g className="fx-bob">
          <FaiscaAntenna state={state} rich={rich} />
          <FaiscaBody state={state} furId={rich ? furId : null} />
          {rich ? <FaiscaToes /> : null}
          <FaiscaFace state={state} />
        </g>
        {rich ? <FaiscaBubble state={state} /> : null}
      </g>
    </svg>
  );
}

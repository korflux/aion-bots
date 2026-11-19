// Avatar de quem fala ou trabalha numa tela: o bot ou, no Chat geral, o próprio Aion. É a imagem do bot em qualquer tela e o ÚNICO ponto que decide entre a
// Faísca e o marcador de inicial, para nenhuma tela repetir o limite de 24 px (`FAISCA_MIN_SIZE`, fonte única em components/mascot/faisca-detail.ts):
//  - de 24 px para cima é a Faísca, na cor do bot (`owner` com nome e cor) ou na cor de marca `--faisca` (`owner` nulo, o Aion);
//  - abaixo de 24 px o rosto vira mancha, e o avatar do BOT é o marcador de inicial (`BotMarker`). O Aion nunca usa marcador: o Chat geral pede 24 px ou mais
//    (decisão do design); se um dia pedir menos, a Faísca renderiza pequena em vez de a tela inventar outro marcador.
//
// O nível de detalhe da Faísca sai do tamanho (24 a 47 px liso, 48 ou mais completo; ver `faiscaDetailOf`). O avatar é decorativo (`aria-hidden`): o nome do
// bot e o estado, quando há, sempre vêm em texto ao lado. `still` desliga os laços (listas e qualquer Faísca que não seja o foco da tela); `enter` e `gaze` são
// das telas de destaque (a conversa vazia): a entrada única e o olhar que segue o cursor, calculado por `useGaze` (components/mascot/use-gaze.ts).
// O bot não tem personagem: a identidade é a Faísca, única, na cor dele.
import { Faisca } from '@/components/mascot/faisca';
import { FAISCA_AION_COLOR, FAISCA_MIN_SIZE, type FaiscaState } from '@/components/mascot/faisca-detail';
import { BotMarker } from './bot-marker';

/** O que o avatar precisa de um bot: nome (a inicial) e cor (o corpo). Um `Bot`, um `BotSummary` e o dono de uma atividade servem como estão. */
export interface AvatarOwner {
  name: string;
  /** Cor do bot (`#RRGGBB`): é o corpo da Faísca e o fundo da inicial. */
  color: string;
}

interface BotAvatarProps {
  /** O bot; `null` é o próprio Aion (Chat geral), com a Faísca em `--faisca`. */
  owner: AvatarOwner | null;
  /** Lado em px. Abaixo de 24 o bot vira a inicial; de 24 em diante, a Faísca. */
  size: number;
  /** Estado da Faísca (ocioso por padrão), sempre o que `mascotStateOfRunStatus` ou `botRunStateOf` devolvem. Não vale para a inicial. */
  state?: FaiscaState;
  /** Faísca sem laços de movimento (a pose e o ícone do estado continuam). Não vale para a inicial. */
  still?: boolean;
  /** Entrada animada, uma vez ao montar (conversa vazia). Não vale para a inicial. */
  enter?: boolean;
  /** Para onde a Faísca olha, de -1 a 1 em cada eixo (só vale ocioso ou aguardando). Não vale para a inicial. */
  gaze?: { x: number; y: number } | null;
  className?: string;
}

/** Faísca do bot a partir de 24 px, inicial do nome abaixo disso; do Aion, sempre a Faísca. Decorativo: quem usa mantém o nome em texto ao lado. */
export function BotAvatar({ owner, size, state, still, enter, gaze, className }: BotAvatarProps) {
  if (owner !== null && size < FAISCA_MIN_SIZE) return <BotMarker name={owner.name} color={owner.color} size={size} className={className} />;
  return <Faisca color={owner?.color ?? FAISCA_AION_COLOR} size={size} state={state} still={still} enter={enter} gaze={gaze} className={className} />;
}

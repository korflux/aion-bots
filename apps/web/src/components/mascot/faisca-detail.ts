// Regras da Faísca que não dependem de React: estados, níveis de detalhe por tamanho e a regra de movimento. É a fonte única dessas três coisas: o
// componente (faisca.tsx), a arte (faisca-art.tsx), o `BotAvatar` (que decide entre a Faísca e o marcador de inicial) e os testes leem daqui, então mudar um
// limite de tamanho ou o conjunto de estados que se movem é mudar só este arquivo.
//
// Os seis estados são os mesmos de `BotRunState` (packages/shared/src/live-state.ts): o valor que sai de `mascotStateOfRunStatus` e de `botRunStateOf` entra
// na Faísca sem tradução, e o compilador recusa a divergência. A regra que decide o estado continua lá; a tela nunca inventa estado.
import type { BotRunState } from '@aion/shared';

/** Ocioso, trabalhando, aguardando, concluído, erro e dormindo. */
export type FaiscaState = BotRunState;

/** Os estados na ordem de exibição (galeria, testes). */
export const FAISCA_STATES: readonly FaiscaState[] = ['idle', 'working', 'waiting', 'done', 'error', 'sleep'];

/**
 * Cor do corpo quando a Faísca representa o próprio Aion (Chat geral, login, erros, estados vazios do app): o token de marca `--faisca`, resolvido pelo
 * CSS. Quando representa um bot, o corpo é a cor do bot (`#RRGGBB`).
 */
export const FAISCA_AION_COLOR = 'var(--faisca)';

/** Menor tamanho (px) da Faísca; abaixo dele o avatar do bot é o marcador de inicial (`BotAvatar`). O Chat geral nunca usa marcador. */
export const FAISCA_MIN_SIZE = 24;
/** A partir deste tamanho (px) o desenho é o completo; de `FAISCA_MIN_SIZE` até aqui, o liso. */
export const FAISCA_FULL_SIZE = 48;

/**
 * Nível de detalhe: `full` (48 px ou mais) tem pelo, miolo e brilho na estrela, dedinhos e o ícone flutuante do estado; `small` (24 a 47 px) é liso, com a
 * estrela de contorno grosso e sem ícone flutuante, e o estado vai em texto ao lado. ponytail: abaixo de 24 px devolve `small` mesmo assim (renderiza, mas
 * borrado) em vez de recusar; quem decide a inicial é o `BotAvatar`, e o Chat geral nunca pede menos de 24 px.
 */
export type FaiscaDetail = 'full' | 'small';
export const faiscaDetailOf = (size: number): FaiscaDetail => (size >= FAISCA_FULL_SIZE ? 'full' : 'small');

/** Só a Faísca que trabalha ou espera uma aprovação se mexe; as demais ficam paradas (orçamento de movimento do design). */
const MOVING_STATES: readonly FaiscaState[] = ['working', 'waiting'];

/** A Faísca roda os laços de movimento? Só em `working` e `waiting`, e nunca com `still` (listas e qualquer Faísca que não seja o foco da tela). */
export const faiscaMoves = (state: FaiscaState, still: boolean): boolean => !still && MOVING_STATES.includes(state);

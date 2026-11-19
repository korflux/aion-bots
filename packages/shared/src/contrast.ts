// Contraste de cores pela definição da WCAG 2.x (luminância relativa e razão de contraste).
//
// Fonte única para web e core: a web decide a cor da inicial sobre o marcador do bot e avisa de cor
// personalizada com pouco contraste (design: "Kit mínimo", cor do bot). Funções puras e sem DOM.

/** Fundo do app (`--bg-app`): a cor do bot é sempre avaliada contra ele. */
export const APP_BACKGROUND = '#0E0E13';
/** Texto escuro e claro candidatos para o marcador; o escuro acompanha o fundo real da identidade. */
export const MARKER_TEXT_DARK = APP_BACKGROUND;
export const MARKER_TEXT_LIGHT = '#FFFFFF';
/** Razão mínima de contraste de uma cor de bot sobre o fundo; abaixo dela a interface avisa (design). */
export const BOT_MIN_CONTRAST = 3;
/** Razão mínima para texto normal (WCAG AA). */
export const TEXT_MIN_CONTRAST = 4.5;

const HEX_COLOR = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/** O valor é uma cor `#RRGGBB` (maiúsculas ou minúsculas)? */
export const isHexColor = (value: string): boolean => HEX_COLOR.test(value);

/** Converte um canal sRGB de 0 a 255 na sua contribuição linear para a luminância. */
function linearChannel(channel: number): number {
  const scaled = channel / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

/** Luminância relativa (0 preto, 1 branco) de uma cor `#RRGGBB`. Lança se o formato for inválido. */
export function relativeLuminance(hex: string): number {
  const match = HEX_COLOR.exec(hex);
  if (!match) throw new RangeError('Cor deve estar no formato #RRGGBB.');
  const [red, green, blue] = [match[1], match[2], match[3]].map((part) => linearChannel(Number.parseInt(part ?? '0', 16)));
  return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0);
}

/** Razão de contraste entre duas cores, de 1 (iguais) a 21 (preto sobre branco). */
export function contrastRatio(first: string, second: string): number {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

/**
 * Cor do texto (escuro ou claro) com maior contraste sobre `background`; usada na inicial do marcador.
 * ponytail: no pior caso (cinza médio) a inicial fica em ~4,38:1, abaixo dos 4,5:1 do AA para texto pequeno,
 * porque o design fixa o texto escuro em #0F0F10 e não em preto puro; trocar se a inicial passar a carregar informação.
 */
export function readableTextOn(background: string): string {
  return contrastRatio(background, MARKER_TEXT_DARK) >= contrastRatio(background, MARKER_TEXT_LIGHT)
    ? MARKER_TEXT_DARK
    : MARKER_TEXT_LIGHT;
}

/** A cor do bot fica abaixo do contraste mínimo sobre o fundo do app? (dispara o aviso do editor) */
export const hasLowBotContrast = (hex: string): boolean => contrastRatio(hex, APP_BACKGROUND) < BOT_MIN_CONTRAST;

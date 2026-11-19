// Logotipo do Aion (identidade da phase 5, ID-03): "aion" em minúsculas, em traço redondo de espessura única, com a estrela da Faísca no lugar do pingo do i.
// É o desenho de `docs/identidade/assets/Logos/aion-logotipo-claro.svg`, inline para as letras herdarem a cor do texto (`currentColor`, o `--text` do tema
// escuro) e a estrela usar os tokens `--brilho`, `--brilho-miolo` e `--brilho-traco`. Regras da marca: nunca recompor em texto (Fredoka), nunca esticar nem
// trocar a cor das letras por cor de bot; altura mínima de 24 px. A estrela é a mesma da Faísca (`STAR`, fonte única em faisca-art.tsx).
//
// Acessibilidade: o SVG é uma imagem com o nome "Aion". Telas que o usam como título (login e TOTP) o envolvem num `<h1>`, e o nome acessível do título é o dele.
import { STAR } from '@/components/mascot/faisca-art';

/** Proporção do quadro do logotipo (viewBox 240 x 96): a largura é 2,5 vezes a altura. */
const LOGO_RATIO = 240 / 96;

/** Logotipo "aion" com a altura dada em px (36 no login e no TOTP). */
export function Logo({ height = 36, className }: { height?: number; className?: string }) {
  return (
    <svg viewBox="0 0 240 96" width={height * LOGO_RATIO} height={height} role="img" aria-label="Aion" className={className}>
      <g fill="none" stroke="currentColor" strokeWidth="14" strokeLinecap="round" strokeLinejoin="round">
        {/* a */}
        <circle cx="34" cy="55" r="22" />
        <path d="M56 34 V80" />
        {/* i: a haste; o pingo é a estrela abaixo */}
        <path d="M88 34 V80" />
        {/* o */}
        <circle cx="136" cy="55" r="22" />
        {/* n */}
        <path d="M186 80 V34 M186 54 C186 40 195 33 206 33 C218 33 226 41 226 54 V80" />
      </g>
      <g transform="translate(88 12)">
        <path d={STAR} fill="var(--brilho)" stroke="var(--brilho-traco)" strokeWidth="1.2" strokeLinejoin="round" />
        <path d={STAR} transform="scale(.48)" fill="var(--brilho-miolo)" />
      </g>
    </svg>
  );
}

/**
 * A estrela da Faísca sozinha (`docs/identidade/assets/Logos/faisca-estrela.svg`): a marca do Aion onde o logotipo não cabe, como o topo da barra de ícones do desktop
 * (link "Início", ver `shell/icon-rail.tsx`). É a mesma estrela do pingo do i do logotipo, com os tokens `--brilho`, `--brilho-miolo` e `--brilho-traco`. Decorativa (`aria-hidden`):
 * quem a usa dá o nome ao link. Regra da marca: o amarelo `brilho` é só da estrela, então ela nunca vira ícone de ação genérica.
 */
export function BrandStar({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="-13 -13 26 26" width={size} height={size} aria-hidden focusable="false" className={className}>
      <path d={STAR} fill="var(--brilho)" stroke="var(--brilho-traco)" strokeWidth="1.2" strokeLinejoin="round" />
      <path d={STAR} transform="scale(.48)" fill="var(--brilho-miolo)" />
    </svg>
  );
}

// Manifesto da PWA (design: "Baseline mobile" e "Ícones, favicon, push e manifesto"): nome "Aion", abre em `standalone` no Início (`start_url: '/'`), com o fundo e a
// cor do tema do app (`bg-app`, o mesmo `--bg-app` de globals.css) e o ícone da identidade: a Faísca sobre tinta, gerada dos SVG de `docs/identidade/assets/Icones`
// por `tests/support/generate-app-icons.mjs`. Os ícones ficam em `public/icons` e, junto com este manifesto e o service worker (`public/sw.js`), são públicos no
// proxy porque o navegador os busca sem cookies. O endereço de cada ícone leva o hash do conteúdo e vem de `@/lib/app-icons.json` (gravado pelo gerador; phase 5, T9):
// é isso que faz a borda e o Android verem o manifesto mudar quando o desenho muda, sem depender de limpar cache. Os `shortcuts` são os atalhos do toque longo no
// ícone do app (Android): abrem direto o Chat geral e as Aprovações.
import type { MetadataRoute } from 'next';
import appIcons from '@/lib/app-icons.json';

/** Fundo do app (`--bg-app`): vale para `background_color` (splash) e `theme_color` (barra do sistema). */
const BG_APP = '#0E0E13';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Aion',
    short_name: 'Aion',
    description: 'Bots autônomos para uso pessoal.',
    lang: 'pt-BR',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: BG_APP,
    theme_color: BG_APP,
    icons: [
      { src: appIcons.icon192, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: appIcons.icon512, sizes: '512x512', type: 'image/png', purpose: 'any' },
      // Máscara adaptável do Android: o desenho da Faísca fica dentro da zona segura (80 % central), então o recorte em círculo ou squircle não o corta.
      { src: appIcons.iconMaskable512, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Novo chat', url: '/chat' },
      { name: 'Aprovações', url: '/aprovacoes' },
    ],
  };
}

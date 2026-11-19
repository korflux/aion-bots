// Layout raiz: HTML em PT-BR, fontes autohospedadas (Inter, JetBrains Mono e a Fredoka de marca via fontsource, sem CDN), tema escuro único e Toaster
// global. A Fredoka só é usada pela classe de marca `font-display` (globals.css); o @font-face dela só baixa o arquivo quando algum texto a usa. App
// privado: sem indexação. `connection()` força renderização dinâmica, requisito para o Next aplicar o nonce da CSP (gerado por requisição em src/proxy.ts).
import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import '@fontsource-variable/fredoka';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './globals.css';
import { Toaster } from '@/components/toaster';
import appIcons from '@/lib/app-icons.json';

export const metadata: Metadata = {
  title: { default: 'Aion', template: '%s · Aion' },
  description: 'Bots autônomos para uso pessoal.',
  robots: { index: false, follow: false },
  // O manifesto vem de `manifest.ts`; os arquivos ficam em `public/icons` e saem dos SVG de `docs/identidade/assets/Icones` por
  // `tests/support/generate-app-icons.mjs`. O ícone do app (apple-touch, manifesto) e o favicon são a estrela chapada da marca sobre tinta (ID-03, desde
  // 2026-11-15), o favicon em arquivos próprios: o SVG para quem o aceita e os PNG de 32 e 16 px para os demais. Não há `favicon.ico`.
  // Os endereços vêm de `@/lib/app-icons.json`, gravado pelo gerador com o hash do conteúdo no nome (phase 5, T9): um desenho novo é outro endereço, e a
  // aba, a tela inicial do iOS e o convite de instalação não ficam presos ao desenho antigo guardado pela borda ou pelo navegador.
  icons: {
    icon: [
      { url: appIcons.favicon, sizes: 'any', type: 'image/svg+xml' },
      { url: appIcons.favicon32, sizes: '32x32', type: 'image/png' },
      { url: appIcons.favicon16, sizes: '16x16', type: 'image/png' },
    ],
    apple: appIcons.appleTouch,
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  // O teclado virtual encolhe a viewport de layout (e não só a visual): o shell em `100dvh` acompanha e o composer sobe junto, logo acima do teclado (phase 5, T6; spec A6).
  interactiveWidget: 'resizes-content',
  // `bg-app` (globals.css, --bg-app): a barra do navegador e o splash da PWA combinam com o fundo do app.
  themeColor: '#0E0E13',
  colorScheme: 'dark',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  return (
    <html lang="pt-BR">
      {/* Fundo de toda tela (UI-06): a cor lisa de `bg-app`, definida no `body` de globals.css; shell, login e erros ficam transparentes por cima. */}
      <body>
        {children}
        <Toaster />
      </body>
    </html>
  );
}

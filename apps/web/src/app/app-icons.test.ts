// Prova dos ícones do app (phase 5, T3 e T9; spec A3 e F2): lê os PNGs REAIS de `public/icons` (cabeçalho e pixels, com o `node:zlib`, sem biblioteca de imagem),
// gerados por `tests/support/generate-app-icons.mjs` a partir dos SVG de `docs/identidade/assets/Icones`, e confere o que o aceite pede: cada arquivo do manifesto,
// do `metadata`, do favicon e do push existe com o tamanho declarado; o ícone do app é a estrela chapada sobre a tinta com os cantos transparentes (desde
// 2026-11-15; antes era a Faísca inteira); o apple-touch é um quadrado opaco sem cantos; o desenho do ícone mascarável cabe na zona segura (círculo de 80 %
// central que os sistemas preservam ao recortar); o favicon é a mesma estrela, em arquivo próprio de 32 e 16 px; o ícone grande do push é a Faísca sobre o disco tinta e o pequeno só tem alfa (branco sobre transparente). Fecha com o manifesto
// (as cores do fundo do app e os dois atalhos).
// ENDEREÇO PELO CONTEÚDO (T9): todo endereço de ícone leva o hash do conteúdo no nome, e o registro `lib/app-icons.json` (gravado pelo gerador) é a fonte única que o
// manifesto e o layout leem. O bloco `ícones: endereço pelo conteúdo` reprova se um arquivo mudar sem o nome mudar (a borda e o Android continuariam com o desenho
// antigo), se sobrar arquivo fora do registro e se manifesto, `metadata` ou `sw.js` apontarem para um endereço que não existe; o `sw.js` é EXECUTADO (um push sem
// dados), não lido como texto. Que o aviso do push leva os dois ícones certos nos demais casos também é provado em `components/push/sw.test.ts`.
// As cores vêm dos tokens de `globals.css` (a fonte das cores do app) e os caminhos e tamanhos, do `manifest.ts` e do `metadata` do `layout.tsx`: os mesmos objetos que o
// Next serve, não texto do código-fonte.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import appIcons from '@/lib/app-icons.json';
import { metadata, viewport } from './layout';
import manifest from './manifest';

const ICONS_DIR = new URL('../../public/icons/', import.meta.url);
const SERVICE_WORKER_SOURCE = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
const GLOBALS_CSS = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');

type Rgba = [number, number, number, number];

/** O valor `#rrggbb` de um token de globals.css, em minúsculas (erra alto se o app não o declara). */
function token(name: string): string {
  const value = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(GLOBALS_CSS)?.[1];
  if (!value) throw new Error(`token --${name} não está em globals.css`);
  return value.toLowerCase();
}
const BG_APP = token('bg-app');
const TINTA = token('tinta');
const FAISCA = token('faisca');

interface DecodedPng {
  width: number;
  height: number;
  /** O arquivo traz canal alfa (tipo de cor 6)? Sem ele (tipo 2) todo pixel é opaco. */
  hasAlpha: boolean;
  pixel(x: number, y: number): Rgba;
}

/** Fórmula de predição do filtro 4 do PNG: o vizinho (esquerda, acima ou diagonal) mais próximo de `esquerda + acima - diagonal`. */
function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const dLeft = Math.abs(estimate - left);
  const dUp = Math.abs(estimate - up);
  const dUpLeft = Math.abs(estimate - upLeft);
  if (dLeft <= dUp && dLeft <= dUpLeft) return left;
  return dUp <= dUpLeft ? up : upLeft;
}

/**
 * Decodificador mínimo de PNG: 8 bits por canal, sem entrelaçamento, RGB (tipo 2) ou RGBA (tipo 6), que é o que o Chromium grava. Qualquer
 * outro formato (paleta, tons de cinza, 16 bits) falha com mensagem clara em vez de ler pixels errados: refazer o PNG nesse formato
 * exige estender este leitor, e nada no app depende disso.
 */
function decodePng(file: Buffer): DecodedPng {
  expect(file.subarray(0, 8).toString('hex'), 'assinatura PNG').toBe('89504e470d0a1a0a');
  let header: { width: number; height: number; bitDepth: number; colorType: number; interlace: number } | null = null;
  const compressed: Buffer[] = [];
  for (let offset = 8; offset < file.length; ) {
    const length = file.readUInt32BE(offset);
    const type = file.toString('ascii', offset + 4, offset + 8);
    const body = file.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), bitDepth: body[8]!, colorType: body[9]!, interlace: body[12]! };
    } else if (type === 'IDAT') {
      compressed.push(body);
    }
    offset += 12 + length;
  }
  if (!header) throw new Error('PNG sem cabeçalho IHDR');
  const { width, height, bitDepth, colorType, interlace } = header;
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`PNG fora do formato lido por este teste (profundidade ${bitDepth}, tipo de cor ${colorType}, entrelaçamento ${interlace})`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(compressed));
  const data = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    for (let i = 0; i < stride; i += 1) {
      const value = raw[y * (stride + 1) + 1 + i]!;
      const left = i >= channels ? data[y * stride + i - channels]! : 0;
      const up = y > 0 ? data[(y - 1) * stride + i]! : 0;
      const upLeft = y > 0 && i >= channels ? data[(y - 1) * stride + i - channels]! : 0;
      const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter];
      if (predicted === undefined) throw new Error(`filtro de PNG desconhecido: ${filter}`);
      data[y * stride + i] = (value + predicted) & 0xff;
    }
  }
  return {
    width,
    height,
    hasAlpha: channels === 4,
    pixel(x, y) {
      const at = y * stride + x * channels;
      return [data[at]!, data[at + 1]!, data[at + 2]!, channels === 4 ? data[at + 3]! : 255];
    },
  };
}

/** Arquivo de `public/icons` a partir do caminho público do app (`/icons/x.<hash>.png`), conferindo que existe. */
function iconFile(publicPath: string): URL {
  const file = new URL(publicPath.replace('/icons/', ''), ICONS_DIR);
  expect(existsSync(file), `${publicPath} existe em public/icons`).toBe(true);
  return file;
}

/** Lê e decodifica um arquivo de `public/icons` a partir do caminho público do app. */
function readIcon(publicPath: string): DecodedPng {
  return decodePng(readFileSync(iconFile(publicPath)));
}

const hex = ([r, g, b]: Rgba): string => `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
/** A estrela da marca (brilho `#FACC15` e miolo `#FEF3C7`) é amarela: vermelho e verde altos, azul bem abaixo. */
const isStarYellow = ([r, g, b]: Rgba): boolean => r >= 0xf0 && g >= 0xc0 && b <= r - 0x30;

/** Os quatro cantos de um PNG quadrado. */
const corners = (png: DecodedPng): [number, number][] => [[0, 0], [png.width - 1, 0], [0, png.height - 1], [png.width - 1, png.height - 1]];

/** Pixel em fração do quadro (0 a 1 em cada eixo), para achar o mesmo ponto do desenho em qualquer tamanho. */
const at = (png: DecodedPng, fractionX: number, fractionY: number): Rgba => png.pixel(Math.floor(fractionX * png.width), Math.floor(fractionY * png.height));

/** Distância, a partir do centro do quadro, do pixel mais afastado que não é o fundo `background` (o desenho): o raio que o desenho ocupa. */
function farthestArt(png: DecodedPng, background: string): number {
  const center = { x: (png.width - 1) / 2, y: (png.height - 1) / 2 };
  let farthest = 0;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      if (hex(png.pixel(x, y)) === background) continue;
      farthest = Math.max(farthest, Math.hypot(x - center.x, y - center.y));
    }
  }
  return farthest;
}

/** Raio da zona segura do ícone mascarável: círculo central com 80 % do lado. */
const SAFE_ZONE_RADIUS = 0.4;

/** Os arquivos do ícone do app: o do `metadata` (apple-touch) e os do manifesto, com o lado declarado de cada um. */
const MANIFEST_ICONS = (manifest().icons ?? []).map((icon) => ({ src: icon.src, side: Number.parseInt(String(icon.sizes), 10), purpose: icon.purpose }));
const APPLE_TOUCH = { src: (metadata.icons as { apple: string }).apple, side: 180 };
const APP_ICONS = [APPLE_TOUCH, ...MANIFEST_ICONS];

/**
 * Ícones que o `sw.js` põe no aviso, lidos EXECUTANDO o worker de verdade: carrega o arquivo num contexto isolado com um `self` mínimo, dispara um `push` sem
 * dados (o aviso genérico) e devolve o `icon` e o `badge` que ele passou a `showNotification`. Sem id de evento não há conferência no servidor, então não precisa de `fetch`.
 */
async function iconsOfServiceWorker(): Promise<{ icon: string; badge: string }> {
  type PushEvent = { data: null; waitUntil(work: Promise<unknown>): void };
  let onPush: ((event: PushEvent) => void) | undefined;
  let shown: { icon: string; badge: string } | undefined;
  const self = {
    location: { origin: 'https://aion.exemplo.com' },
    skipWaiting: () => undefined,
    addEventListener: (type: string, handler: (event: PushEvent) => void) => {
      if (type === 'push') onPush = handler;
    },
    registration: {
      getNotifications: async () => [],
      showNotification: async (_title: string, options: { icon: string; badge: string }) => {
        shown = { icon: options.icon, badge: options.badge };
      },
    },
    clients: { claim: async () => undefined, matchAll: async () => [] },
  };
  vm.runInContext(SERVICE_WORKER_SOURCE, vm.createContext({ self, URL }));
  const pending: Promise<unknown>[] = [];
  onPush?.({ data: null, waitUntil: (work) => pending.push(work) });
  await Promise.all(pending);
  if (!shown) throw new Error('o sw.js não mostrou notificação para o push sem dados');
  return shown;
}

describe('ícones: endereço pelo conteúdo (T9)', () => {
  const registered = Object.entries(appIcons);

  it.each(registered)('%s: o nome do arquivo leva o hash do conteúdo, e o arquivo existe', (_key, publicPath) => {
    const name = /^\/icons\/[a-z0-9-]+\.([0-9a-f]{8})\.(?:png|svg)$/.exec(publicPath);
    expect(name, `${publicPath} segue o padrão /icons/<nome>.<hash8>.<ext>`).not.toBeNull();
    const hash = createHash('sha256').update(readFileSync(iconFile(publicPath))).digest('hex').slice(0, 8);
    // Se o desenho mudar e o nome não, o hash calculado deixa de bater: a borda e o Android continuariam servindo o desenho antigo.
    expect(hash, `${publicPath}: hash do conteúdo atual`).toBe(name![1]);
  });

  it('o favicon em SVG não tem quebra de linha: o autocrlf do Git (Windows) não muda os bytes nem invalida o hash do nome numa cópia nova do repositório', () => {
    const bytes = readFileSync(iconFile(appIcons.favicon));
    expect(bytes.includes(0x0a) || bytes.includes(0x0d)).toBe(false);
  });

  it('public/icons só tem os arquivos do registro: nenhum nome fixo antigo nem sobra de outro hash', () => {
    expect(readdirSync(ICONS_DIR).sort()).toEqual(registered.map(([, publicPath]) => publicPath.replace('/icons/', '')).sort());
  });

  it('manifesto, metadata do layout e sw.js apontam só para endereços do registro, e usam todos eles', async () => {
    const layoutIcons = metadata.icons as { icon: { url: string }[]; apple: string };
    const worker = await iconsOfServiceWorker();
    const referenced = [
      ...(manifest().icons ?? []).map((icon) => icon.src),
      ...layoutIcons.icon.map((icon) => icon.url),
      layoutIcons.apple,
      worker.icon,
      worker.badge,
    ];
    for (const publicPath of referenced) {
      expect(Object.values(appIcons), `${publicPath} está no registro`).toContain(publicPath);
      expect(existsSync(iconFile(publicPath)), `${publicPath} existe`).toBe(true);
    }
    // Nenhum ícone gerado fica sem uso: cada endereço do registro é referenciado por manifesto, layout ou push.
    expect([...new Set(referenced)].sort()).toEqual(Object.values(appIcons).sort());
    // O aviso usa os dois arquivos próprios do push, não os do app.
    expect(worker).toEqual({ icon: appIcons.notificationIcon, badge: appIcons.notificationBadge });
  });
});

describe('ícones do app: a estrela chapada sobre a tinta', () => {
  it('o apple-touch e o manifesto declaram os quatro arquivos e cada PNG tem o tamanho declarado', () => {
    expect(APP_ICONS.map((icon) => `${icon.src}:${icon.side}`).sort()).toEqual(
      [`${appIcons.appleTouch}:180`, `${appIcons.icon192}:192`, `${appIcons.icon512}:512`, `${appIcons.iconMaskable512}:512`].sort(),
    );
    for (const { src, side } of APP_ICONS) {
      const png = readIcon(src);
      expect([png.width, png.height], src).toEqual([side, side]);
    }
  });

  it.each(MANIFEST_ICONS.filter((icon) => icon.purpose === 'any'))('$src: cantos transparentes, borda e fundo da tinta e a estrela amarela no centro', ({ src, side }) => {
    const png = readIcon(src);
    expect(png.hasAlpha, `${src} tem canal alfa`).toBe(true);
    for (const [x, y] of corners(png)) expect(png.pixel(x, y)[3], `${src} canto ${x},${y}`).toBe(0);
    // Os cantos arredondados deixam a borda reta opaca: o meio de cada lado é tinta, sem transparência.
    const middle = Math.floor(side / 2);
    for (const [x, y] of [[middle, 0], [middle, side - 1], [0, middle], [side - 1, middle]] as const) {
      expect(png.pixel(x, y)[3], `${src} meio da borda ${x},${y}`).toBe(255);
      expect(hex(png.pixel(x, y)), `${src} meio da borda ${x},${y}`).toBe(TINTA);
    }
    expect(isStarYellow(png.pixel(middle, middle)), `${src} centro`).toBe(true);
    // Fora da estrela, a meio caminho entre o centro e o canto, é tinta: o ícone não é um quadro amarelo cheio.
    expect(hex(at(png, 0.25, 0.25)), `${src} diagonal`).toBe(TINTA);
  });

  it('o apple-touch é um quadrado opaco SEM cantos (o iOS arredonda e pinta de preto o que fosse transparente), com a estrela no centro', () => {
    const png = readIcon(APPLE_TOUCH.src);
    for (const [x, y] of corners(png)) expect(hex(png.pixel(x, y)), `canto ${x},${y}`).toBe(TINTA);
    for (let y = 0; y < png.height; y += 1) {
      for (let x = 0; x < png.width; x += 1) {
        if (png.pixel(x, y)[3] !== 255) throw new Error(`apple-touch: pixel ${x},${y} com transparência`);
      }
    }
    expect(isStarYellow(png.pixel(Math.floor(png.width / 2), Math.floor(png.height / 2))), 'centro').toBe(true);
  });

  it('o ícone mascarável é um quadrado cheio de tinta e a estrela fica dentro da zona segura central de 80 %', () => {
    const png = readIcon(appIcons.iconMaskable512);
    for (const [x, y] of corners(png)) expect(hex(png.pixel(x, y)), `canto ${x},${y}`).toBe(TINTA);
    for (let y = 0; y < png.height; y += 1) {
      for (let x = 0; x < png.width; x += 1) {
        if (png.pixel(x, y)[3] !== 255) throw new Error(`maskable: pixel ${x},${y} com transparência`);
      }
    }
    expect(isStarYellow(png.pixel(png.width / 2, png.height / 2)), 'centro').toBe(true);
    // 1 px de folga para o antialiasing da borda do desenho.
    const farthest = farthestArt(png, TINTA);
    expect(farthest, `raio do desenho ${farthest.toFixed(1)} px`).toBeLessThanOrEqual(png.width * SAFE_ZONE_RADIUS + 1);
    // E o desenho existe: ocupa uma parte real do quadro (não é um ícone vazio nem minúsculo).
    expect(farthest, `raio do desenho ${farthest.toFixed(1)} px`).toBeGreaterThan(png.width * 0.25);
  });
});

describe('favicon: a estrela da marca', () => {
  const icons = (metadata.icons as { icon: { url: string; sizes: string; type: string }[] }).icon;

  it('o `metadata` declara o SVG e os PNG de 32 e 16 px, todos existentes e com o tamanho declarado', () => {
    expect(icons.map((icon) => `${icon.url}:${icon.type}`)).toEqual([
      `${appIcons.favicon}:image/svg+xml`,
      `${appIcons.favicon32}:image/png`,
      `${appIcons.favicon16}:image/png`,
    ]);
    const svg = readFileSync(iconFile(appIcons.favicon), 'utf8');
    expect(svg.trimStart().startsWith('<svg')).toBe(true);
    for (const { url, sizes } of icons.filter((icon) => icon.type === 'image/png')) {
      const side = Number.parseInt(sizes, 10);
      const png = readIcon(url);
      expect([png.width, png.height], url).toEqual([side, side]);
    }
  });

  it('tem arquivos próprios, fora dos do ícone do app, com cantos transparentes e a estrela amarela no centro', () => {
    const appIconPaths = APP_ICONS.map((icon) => icon.src);
    for (const { url } of icons) expect(appIconPaths, url).not.toContain(url);
    for (const { url } of icons.filter((icon) => icon.type === 'image/png')) {
      const png = readIcon(url);
      // Em 16 px o canto arredondado (raio 3,5) deixa o pixel do vértice quase todo fora do desenho: alfa praticamente 0, não exatamente 0 pelo antialiasing.
      expect(png.pixel(0, 0)[3], `${url} canto`).toBeLessThan(0x20);
      const center = png.pixel(Math.floor(png.width / 2), Math.floor(png.height / 2));
      expect(isStarYellow(center), `${url} centro ${hex(center)}`).toBe(true);
    }
  });
});

/** Arquivos que o `sw.js` põe no aviso (endereço com hash do registro; que o worker aponta para eles é provado no bloco do endereço pelo conteúdo). */
const NOTIFICATION_ICON = appIcons.notificationIcon;
const NOTIFICATION_BADGE = appIcons.notificationBadge;

describe('push: ícone grande e ícone pequeno', () => {
  it('os dois arquivos do aviso existem e nenhum deles é um ícone do app', () => {
    expect(APP_ICONS.map((icon) => icon.src)).not.toContain(NOTIFICATION_ICON);
    expect(APP_ICONS.map((icon) => icon.src)).not.toContain(NOTIFICATION_BADGE);
  });

  it('o ícone grande é a Faísca simples sobre o disco tinta de 192 px: cantos transparentes, borda do disco opaca e o azul da Faísca no centro', () => {
    const png = readIcon(NOTIFICATION_ICON);
    expect([png.width, png.height]).toEqual([192, 192]);
    expect(png.hasAlpha).toBe(true);
    for (const [x, y] of corners(png)) expect(png.pixel(x, y)[3], `canto ${x},${y}`).toBe(0);
    // Um disco encostado nos quatro lados: a poucos pixels do meio de cada borda já é tinta opaca.
    for (const [x, y] of [[96, 4], [96, 187], [4, 96], [187, 96]] as const) expect(hex(png.pixel(x, y)), `borda ${x},${y}`).toBe(TINTA);
    expect(png.pixel(4, 96)[3]).toBe(255);
    expect(hex(png.pixel(96, 96))).toBe(FAISCA);
  });

  it('o ícone pequeno é só alfa: 96 px, RGB branco em TODOS os pixels, cantos transparentes, estrela cheia no centro, centrada e ocupando cerca de 85 % da altura', () => {
    const png = readIcon(NOTIFICATION_BADGE);
    expect([png.width, png.height]).toEqual([96, 96]);
    expect(png.hasAlpha, 'o ícone pequeno tem canal alfa').toBe(true);
    const last = png.width - 1;
    for (const [x, y] of corners(png)) expect(png.pixel(x, y)[3], `canto ${x},${y}`).toBe(0);
    expect(png.pixel(48, 48)[3], 'o centro da estrela é opaco').toBe(255);
    const box = { left: png.width, right: -1, top: png.height, bottom: -1 };
    let opaque = 0;
    for (let y = 0; y < png.height; y += 1) {
      for (let x = 0; x < png.width; x += 1) {
        const [r, g, b, alpha] = png.pixel(x, y);
        // RGB sempre branco, inclusive nos pixels totalmente transparentes: o desenho mora só no alfa.
        if (r !== 255 || g !== 255 || b !== 255) throw new Error(`pixel ${x},${y} não é branco: ${hex([r, g, b, alpha])}`);
        if (alpha === 0) continue;
        if (alpha === 255) opaque += 1;
        box.left = Math.min(box.left, x);
        box.right = Math.max(box.right, x);
        box.top = Math.min(box.top, y);
        box.bottom = Math.max(box.bottom, y);
      }
    }
    // Uma estrela de verdade: há miolo opaco (não só borda translúcida) e o fundo transparente domina o quadro.
    const fraction = opaque / (png.width * png.height);
    expect(fraction, `fração de pixels opacos ${fraction.toFixed(3)}`).toBeGreaterThan(0.1);
    expect(fraction, `fração de pixels opacos ${fraction.toFixed(3)}`).toBeLessThan(0.5);
    // A estrela do SVG vai de -11 a 11 num quadro de 26 unidades: 22 / 26 da altura, centrada a menos de 1,5 px em cada eixo.
    const height = (box.bottom - box.top + 1) / png.height;
    expect(Math.abs(height - 22 / 26), `altura da estrela ${height.toFixed(3)}`).toBeLessThanOrEqual(0.03);
    expect(Math.abs((box.left + box.right) / 2 - last / 2), 'centro horizontal').toBeLessThanOrEqual(1.5);
    expect(Math.abs((box.top + box.bottom) / 2 - last / 2), 'centro vertical').toBeLessThanOrEqual(1.5);
  });
});

describe('manifesto: cores do app e atalhos', () => {
  const app = manifest();

  it('o fundo e a cor do tema do manifesto e do viewport são o `--bg-app` do app', () => {
    expect(app.background_color?.toLowerCase()).toBe(BG_APP);
    expect(app.theme_color?.toLowerCase()).toBe(BG_APP);
    expect(String(viewport.themeColor).toLowerCase()).toBe(BG_APP);
  });

  it('abre no Início em `standalone` e oferece os atalhos "Novo chat" (/chat) e "Aprovações" (/aprovacoes)', () => {
    expect(app.start_url).toBe('/');
    expect(app.display).toBe('standalone');
    expect(app.shortcuts?.map(({ name, url }) => ({ name, url }))).toEqual([
      { name: 'Novo chat', url: '/chat' },
      { name: 'Aprovações', url: '/aprovacoes' },
    ]);
  });
});

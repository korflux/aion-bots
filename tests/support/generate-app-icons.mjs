// Gerador dos ícones do app (phase 1 T14; refeito na phase 5 T3, spec A3; endereço pelo conteúdo na phase 5 T9): rasteriza os SVG de
// `docs/identidade/assets/Icones` (a identidade da Faísca) nos PNGs que o app publica em `apps/web/public/icons` e copia o `favicon.svg`. Os SVG são
// a fonte única do desenho: nada aqui redesenha o mascote, só escolhe tamanho e grava.
//
// Como rodar (da raiz do repositório, depois de `pnpm install`; o Chromium do Playwright já faz parte do E2E):
//   node tests/support/generate-app-icons.mjs
// A SAÍDA ESTÁ COMMITADA: este script NÃO roda em build, em teste nem no CI; só se roda de novo se um SVG da identidade mudar, e então os arquivos
// regenerados são commitados junto. `apps/web/src/app/app-icons.test.ts` confere os arquivos gerados (tamanho, transparência, zona segura e o
// endereço pelo conteúdo), não este script. Rodar de novo sem mudar um SVG não muda nenhum byte nem nome (o Chromium rasteriza igual).
//
// ENDEREÇO PELO CONTEÚDO (T9): todo arquivo sai com o hash curto do próprio conteúdo no nome (`icon-192.<hash8>.png`). A borda (Cloudflare) e o
// navegador guardam `/icons/*` por endereço, e o Android só atualiza o app instalado e o convite de instalação quando o manifesto muda de texto:
// com nome fixo, um ícone novo ficava invisível atrás do cache e o manifesto não mudava. Com o hash no nome, o ícone novo é OUTRO endereço (a borda
// nunca o viu, o manifesto muda) e o antigo deixa de ser referenciado. Nome com hash, e não `?v=`, porque nem toda regra de cache da borda
// distingue a query. O mesmo conteúdo dá sempre o mesmo nome.
//
// Saídas (ver `RENDERED`, `BADGE` e `COPIED`; cada uma tem uma chave, a que o app usa para achar o endereço):
//   - `icon-192` e `icon-512`: `app-icon.svg` (cantos de 22 %, fora deles transparente), purpose "any" do manifesto;
//   - `icon-maskable-512`: `app-icon-maskable.svg`, quadrado cheio com a Faísca dentro da zona segura de 80 % (o Android recorta);
//   - `apple-touch-icon` (180): o mesmo `app-icon.svg` SEM os cantos arredondados (o iOS arredonda e pinta de preto o que for transparente);
//   - `favicon` (SVG, cópia) e `favicon-32` e `favicon-16`: a estrela sobre tinta, para a aba do navegador;
//   - `notification-icon` (192): ícone grande do push, a Faísca simples sobre o disco tinta (`push-icone-grande.svg`);
//   - `notification-badge` (96): ícone pequeno do push (`push-badge.svg`). O Android usa SÓ o canal alfa do `badge` (um PNG opaco vira um
//     quadrado branco), então o RGB é branco em todos os pixels e o desenho mora no alfa (ver `renderAlpha` e `encodeWhitePng`).
//
// FONTE ÚNICA DOS ENDEREÇOS (T9): além dos arquivos, o script grava `apps/web/src/lib/app-icons.json` (chave -> caminho público com hash), que
// `manifest.ts`, `layout.tsx` e os testes importam, e reescreve em `apps/web/public/sw.js` as duas constantes do push (o worker é um arquivo
// estático e não importa o JSON). Os ícones de uma rodada anterior (nome com outro hash) são apagados de `public/icons`, que é inteiramente gerado
// por este script.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const SOURCE_DIR = new URL('../../docs/identidade/assets/Icones/', import.meta.url);
const OUTPUT_DIR = new URL('../../apps/web/public/icons/', import.meta.url);
/** Registro chave -> caminho público com hash que o app importa (`manifest.ts`, `layout.tsx` e os testes). */
const REGISTRY_FILE = new URL('../../apps/web/src/lib/app-icons.json', import.meta.url);
/** Service worker estático: as duas constantes do push são reescritas aqui (ver `pointServiceWorkerAt`). */
const SERVICE_WORKER_FILE = new URL('../../apps/web/public/sw.js', import.meta.url);
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));

/** Prefixo público da pasta de saída e tamanho do hash que entra no nome (32 bits bastam para nove arquivos; o teste confere o nome contra o conteúdo). */
const PUBLIC_DIR = '/icons/';
const HASH_LENGTH = 8;

/** Raio dos cantos do `app-icon.svg` (22 % de 512); o apple-touch o remove. */
const APP_ICON_CORNER = ' rx="112"';

/**
 * PNGs rasterizados no Chromium: chave no registro, nome base do arquivo (o hash entra antes da extensão), SVG de origem, lado do quadrado e, no
 * apple-touch, o pedido de tirar os cantos.
 */
const RENDERED = [
  { key: 'icon192', file: 'icon-192.png', svg: 'app-icon.svg', size: 192 },
  { key: 'icon512', file: 'icon-512.png', svg: 'app-icon.svg', size: 512 },
  { key: 'iconMaskable512', file: 'icon-maskable-512.png', svg: 'app-icon-maskable.svg', size: 512 },
  { key: 'appleTouch', file: 'apple-touch-icon.png', svg: 'app-icon.svg', size: 180, squareCorners: true },
  { key: 'favicon32', file: 'favicon-32.png', svg: 'favicon.svg', size: 32 },
  { key: 'favicon16', file: 'favicon-16.png', svg: 'favicon.svg', size: 16 },
  { key: 'notificationIcon', file: 'notification-icon.png', svg: 'push-icone-grande.svg', size: 192 },
];

/** Ícone pequeno do push: só alfa (ver o cabeçalho). */
const BADGE = { key: 'notificationBadge', file: 'notification-badge.png', svg: 'push-badge.svg', size: 96 };

/** Arquivos copiados (o navegador aceita SVG como favicon; ver `readCopiedSvg`: sem a quebra de linha final), cada um com a chave no registro. */
const COPIED = [{ key: 'favicon', file: 'favicon.svg' }];

/** Constantes do `sw.js` que levam o endereço do ícone do push: nome da constante -> chave no registro. */
const SERVICE_WORKER_CONSTANTS = { NOTIFICATION_ICON: 'notificationIcon', NOTIFICATION_BADGE: 'notificationBadge' };

/** Texto do SVG de origem; no apple-touch, sem os cantos. Falha alto se o SVG deixar de ter o canto esperado (a identidade mudou). */
function readSvg({ svg, squareCorners }) {
  const source = readFileSync(new URL(svg, SOURCE_DIR), 'utf8');
  if (!squareCorners) return source;
  if (!source.includes(APP_ICON_CORNER)) throw new Error(`${svg} não tem o canto ${APP_ICON_CORNER.trim()} a remover para o apple-touch`);
  return source.replace(APP_ICON_CORNER, '');
}

/**
 * Página de um quadro `size` x `size` só com o SVG, sem margem e sem fundo (a transparência dos cantos e do disco vai para o PNG). O CSS manda
 * no `width` e no `height` do SVG, então o `viewBox` de cada desenho o escala ao quadro.
 */
function iconPage(svg, size) {
  return `<!doctype html><meta charset="utf-8"><style>html, body { margin: 0; background: transparent; }
svg { display: block; width: ${size}px; height: ${size}px; }</style>${svg}`;
}

/**
 * Roda no Chromium (via `page.evaluate`): desenha o SVG num canvas `size` x `size` e devolve o alfa (0 a 255) de cada pixel. Só o alfa sai daqui:
 * o RGB do ícone pequeno do push é sempre branco (ver `encodeWhitePng`).
 */
async function renderAlpha({ svgDataUrl, size }) {
  // Globais da página, não do Node: lidos de `globalThis` porque este arquivo é checado pelo lint como módulo Node.
  const { document, Image } = globalThis;
  const image = new Image();
  image.src = svgDataUrl;
  await image.decode();
  const canvas = document.createElement('canvas');
  Object.assign(canvas, { width: size, height: size });
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, size, size);
  const { data } = context.getImageData(0, 0, size, size);
  return Array.from({ length: size * size }, (_, index) => data[index * 4 + 3]);
}

/** Bloco (chunk) de PNG: comprimento, tipo, dados e o CRC-32 de tipo + dados. */
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, checksum]);
}

/**
 * Codifica um PNG RGBA de 8 bits com RGB branco em TODOS os pixels e o alfa recebido. O canvas não serve para gravar: na exportação ele
 * zera o RGB dos pixels totalmente transparentes (alfa pré-multiplicado), e o ícone pequeno deve ser só branco ou transparente.
 */
function encodeWhitePng(size, alphas) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8 bits, RGBA, compressão e filtro padrão, sem entrelaçamento
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y += 1) {
    const row = y * (1 + size * 4); // primeiro byte da linha: filtro 0 (nenhum)
    for (let x = 0; x < size; x += 1) raw.set([255, 255, 255, alphas[y * size + x]], row + 1 + x * 4);
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Bytes de um SVG copiado como está, SEM a quebra de linha final. O nome leva o hash dos bytes gravados, e no Windows o Git (`core.autocrlf`) troca LF por CRLF
 * no checkout de arquivo de texto: um SVG com quebra de linha mudaria de conteúdo (e o hash do nome deixaria de bater) numa cópia nova do repositório. Em uma
 * linha só não há o que converter. Falha alto se o SVG tiver outra quebra de linha (aí o certo é um `.gitattributes` com `-text` para `public/icons`).
 */
function readCopiedSvg(file) {
  const text = readFileSync(new URL(file, SOURCE_DIR), 'utf8').trim();
  if (/[\r\n]/.test(text)) throw new Error(`${file} tem mais de uma linha: o hash do nome não sobreviveria ao autocrlf do Git; marque public/icons como -text no .gitattributes`);
  return Buffer.from(text, 'utf8');
}

/** Nome do arquivo com o hash curto do conteúdo antes da extensão: `icon-192.png` com estes bytes vira `icon-192.<hash8>.png`. */
function hashedName(file, bytes) {
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, HASH_LENGTH);
  const dot = file.lastIndexOf('.');
  return `${file.slice(0, dot)}.${hash}${file.slice(dot)}`;
}

/** Grava os bytes em `public/icons` com o nome por conteúdo, anota o caminho público no registro e devolve o nome do arquivo gravado. */
function writeIcon(registry, { key, file }, bytes) {
  const name = hashedName(file, bytes);
  writeFileSync(fileURLToPath(new URL(name, OUTPUT_DIR)), bytes);
  registry[key] = `${PUBLIC_DIR}${name}`;
  return name;
}

/** Apaga de `public/icons` os PNG e SVG que não são saída desta rodada (nomes com o hash de uma versão anterior dos ícones). */
function removeStaleIcons(kept) {
  for (const name of readdirSync(OUTPUT_DIR)) {
    if (!kept.has(name) && /\.(png|svg)$/.test(name)) unlinkSync(new URL(name, OUTPUT_DIR));
  }
}

/** Reescreve no `sw.js` o caminho das duas constantes do push, sem mexer no resto (nem nas quebras de linha). Falha alto se uma constante sumiu. */
function pointServiceWorkerAt(registry) {
  const before = readFileSync(SERVICE_WORKER_FILE, 'utf8');
  let after = before;
  for (const [constant, key] of Object.entries(SERVICE_WORKER_CONSTANTS)) {
    const declaration = new RegExp(`(const ${constant} = ')[^']*(';)`);
    if (!declaration.test(after)) throw new Error(`sw.js não declara a constante ${constant} entre aspas simples`);
    after = after.replace(declaration, (_match, head, tail) => `${head}${registry[key]}${tail}`);
  }
  if (after !== before) writeFileSync(SERVICE_WORKER_FILE, after);
}

/**
 * Renderiza cada saída no Chromium (sem movimento, escala 1), grava os PNGs e o ícone pequeno do push e copia o favicon em SVG, tudo com nome por
 * conteúdo; depois apaga os nomes antigos, grava o registro (chave -> caminho público) e aponta o `sw.js` para os dois arquivos do push.
 */
async function main() {
  const { chromium } = webRequire('@playwright/test');
  mkdirSync(OUTPUT_DIR, { recursive: true });
  /** Registro na ordem em que as saídas são gravadas: o JSON sai sempre igual para o mesmo conteúdo. */
  const registry = {};
  const kept = new Set();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1, reducedMotion: 'reduce' });
    for (const output of RENDERED) {
      await page.setViewportSize({ width: output.size, height: output.size });
      await page.setContent(iconPage(readSvg(output), output.size));
      const png = await page.screenshot({ type: 'png', animations: 'disabled', omitBackground: true });
      kept.add(writeIcon(registry, output, png));
    }

    const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from(readSvg(BADGE)).toString('base64')}`;
    const alphas = await page.evaluate(renderAlpha, { svgDataUrl, size: BADGE.size });
    kept.add(writeIcon(registry, BADGE, encodeWhitePng(BADGE.size, alphas)));
  } finally {
    await browser.close();
  }
  for (const copied of COPIED) kept.add(writeIcon(registry, copied, readCopiedSvg(copied.file)));

  removeStaleIcons(kept);
  writeFileSync(REGISTRY_FILE, `${JSON.stringify(registry, null, 2)}\n`);
  pointServiceWorkerAt(registry);
}

await main();

// Prova dos tokens aplicados no app (phase 5, A4 e C3; TOK-01): LÊ `globals.css`, o arquivo que o navegador carrega, e não uma cópia dos valores. Quatro coisas:
//  1. os tokens do app são os de `docs/identidade/tokens.json` (tema escuro): cores, tipografia, raios, sombra, durações, curvas e degradês, um a um;
//  2. contraste: todo par de texto do design passa de 4,5:1 e o foco, de 3:1, medidos com `packages/shared/src/contrast.ts` (o `check.mjs` do design system só
//     imprime os contrastes; este teste reprova), e as 12 cores de bot passam de 4,5:1 como texto do nome sobre o fundo do app;
//  3. fontes: nenhuma por CDN (só fontsource, autohospedada) e a Fredoka só na família de marca (`--font-display`);
//  4. fundo liso (phase 18, UI-06): os utilitários de degradê, grão e brilho não pintam nada, o único degradê é o halo da Faísca, a sombra flutuante tem uma fonte só e botões e
//     selos não levam camada de aparência.
// Funções puras e arquivos em disco: sem DOM. O visual e o axe no navegador real são do E2E.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { APP_BACKGROUND, BOT_COLORS, MARKER_TEXT_DARK, contrastRatio } from '@aion/shared';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const CSS = read('./globals.css');
/** `tokens.json` do design system (fonte dos valores). Só o que o teste lê está tipado. */
const DESIGN = JSON.parse(read('../../../../docs/identidade/tokens.json')) as {
  color: { tokens: { name: string; value: { dark?: string } }[] };
  type: { families: Record<string, string>; groups: { styles: { name: string; fontSize: string; lineHeight: string; fontWeight: number; letterSpacing?: string }[] }[] };
  radius: { tokens: { name: string; value: string }[] };
  spacing: { tokens: { name: string; value: string }[] };
  shadow: { tokens: { name: string; value: { dark: string } }[] };
  duration: { tokens: { name: string; value: string }[] };
  easing: { tokens: { name: string; value: string }[] };
  gradient: { tokens: { name: string; value: string }[] };
};

/** Toda declaração `--nome: valor;` do arquivo (a última vence), sem comentários. */
const DECLARED = new Map<string, string>();
for (const match of CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/--([\w-]+)\s*:\s*([^;{}]+);/g)) DECLARED.set(match[1]!, match[2]!.trim());

/** O valor aplicado de um token (erra alto se o app não o declara). */
function applied(name: string): string {
  const value = DECLARED.get(name);
  if (value === undefined) throw new Error(`token --${name} não está em globals.css`);
  // Resolve referências entre tokens para medir o CSS aplicado, inclusive a base linear compartilhada do app e dos bots.
  return value.replace(/var\(--([\w-]+)\)/g, (_, token: string) => applied(token));
}
/** Compara valores ignorando espaços e caixa (`rgba(0,0,0,0.4)` e `rgba(0, 0, 0, 0.4)` são o mesmo valor). */
const same = (left: string, right: string): boolean => left.replace(/\s+/g, '').toLowerCase() === right.replace(/\s+/g, '').toLowerCase();

/** Cor `#rrggbb` ou `#rrggbbaa` composta sobre `over` (um `#rrggbb`), como `#RRGGBB` opaco, que é o que `contrastRatio` entende. */
function solid(value: string, over = '#000000'): string {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value);
  if (!match) throw new Error(`cor ${value} não é #rrggbb nem #rrggbbaa`);
  const alpha = match[2] === undefined ? 1 : Number.parseInt(match[2], 16) / 255;
  const channel = (hex: string, offset: number) => Number.parseInt(hex.slice(offset, offset + 2), 16);
  const out = [0, 2, 4].map((offset) => Math.round(channel(match[1]!, offset) * alpha + channel(over.slice(1), offset) * (1 - alpha)));
  return `#${out.map((part) => part.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}
const color = (name: string, over?: string): string => solid(applied(name), over);

describe('tokens do app são os de docs/identidade/tokens.json (tema escuro)', () => {
  it('cada cor do tema escuro, incluindo marca, estados e as 12 de bot', () => {
    expect(DESIGN.color.tokens.length).toBeGreaterThanOrEqual(40);
    for (const token of DESIGN.color.tokens) {
      const expected = token.value.dark;
      expect(expected, `${token.name} tem valor escuro`).toBeDefined();
      expect(same(applied(token.name), expected!), `--${token.name}`).toBe(true);
    }
    expect(APP_BACKGROUND).toBe(color('bg-app'));
    expect(MARKER_TEXT_DARK).toBe(color('bg-app'));
  });

  it('as 12 cores de bot do app são as de BOT_COLORS (a lista que o editor grava)', () => {
    const fromTokens = DESIGN.color.tokens.filter((token) => token.name.startsWith('bot-')).map((token) => applied(token.name).toUpperCase());
    expect(fromTokens).toEqual(BOT_COLORS.map((bot) => bot.hex));
  });

  it('raios, espaço, sombra, durações, curvas e degradês', () => {
    for (const group of [DESIGN.radius, DESIGN.spacing, DESIGN.duration, DESIGN.easing, DESIGN.gradient]) {
      expect(group.tokens.length).toBeGreaterThan(0);
      for (const token of group.tokens) expect(same(applied(token.name), token.value), `--${token.name}`).toBe(true);
    }
    for (const token of DESIGN.shadow.tokens) expect(same(applied(token.name), token.value.dark), `--${token.name}`).toBe(true);
  });

  it('tipografia: as famílias e cada estilo de texto (tamanho, entrelinha, peso e espaçamento)', () => {
    const { families, groups } = DESIGN.type;
    expect(same(applied('font-sans'), families.sans!)).toBe(true);
    expect(same(applied('font-mono'), families.mono!)).toBe(true);
    // A família de marca acrescenta o nome que o fontsource registra ("Fredoka Variable") antes do que o design lista.
    expect(same(applied('font-display'), `"Fredoka Variable", ${families.display!}`)).toBe(true);
    const styles = groups.flatMap((group) => group.styles);
    expect(styles.map((style) => style.name)).toEqual(['display', 'display-sm', 'page-title', 'section-title', 'body', 'label', 'small', 'caption', 'code']);
    for (const style of styles) {
      expect(applied(`text-${style.name}`), style.name).toBe(style.fontSize);
      expect(applied(`text-${style.name}--line-height`), style.name).toBe(style.lineHeight);
      expect(Number(applied(`text-${style.name}--font-weight`)), style.name).toBe(style.fontWeight);
      if (style.letterSpacing) expect(applied(`text-${style.name}--letter-spacing`), style.name).toBe(style.letterSpacing);
    }
  });
});

describe('contraste dos tokens aplicados (WCAG AA)', () => {
  const TEXT_AA = 4.5;
  const FOCUS_AA = 3;
  const SURFACES = ['bg-app', 'bg-panel', 'bg-surface'] as const;
  const INTERACTIVE = [...SURFACES, 'bg-surface-hover', 'bg-selected'] as const;

  /** Reprova com uma lista legível dos pares abaixo do mínimo (primeiro e segundo plano, e a razão medida). */
  function expectAbove(minimum: number, pairs: [foreground: string, background: string, label: string][]): void {
    const below = pairs.map(([foreground, background, label]) => ({ label, ratio: contrastRatio(foreground, background) })).filter((pair) => pair.ratio < minimum);
    expect(below.map((pair) => `${pair.label}: ${pair.ratio.toFixed(2)}:1`), `pares abaixo de ${minimum}:1`).toEqual([]);
  }

  it('texto principal e secundário passam de 4,5:1 em todo fundo de interface, inclusive no item selecionado', () => {
    const pairs: [string, string, string][] = [];
    for (const surface of INTERACTIVE) {
      pairs.push([color('text'), color(surface), `text sobre ${surface}`]);
      pairs.push([color('text-muted'), color(surface), `text-muted sobre ${surface}`]);
    }
    expectAbove(TEXT_AA, pairs);
  });

  it('o texto discreto (dicas e placeholders) passa de 4,5:1 nos fundos onde é permitido; sobre `bg-selected` o design o proíbe', () => {
    expectAbove(TEXT_AA, SURFACES.map((surface): [string, string, string] => [color('text-subtle'), color(surface), `text-subtle sobre ${surface}`]));
    // A regra de uso que o design registra: o discreto sobre o item selecionado NÃO passa, por isso a interface usa o secundário ali.
    expect(contrastRatio(color('text-subtle'), color('bg-selected'))).toBeLessThan(TEXT_AA);
    expect(contrastRatio(color('text-muted'), color('bg-selected'))).toBeGreaterThanOrEqual(TEXT_AA);
  });

  it('texto de marca, de estado e de ação passa de 4,5:1 sobre os fundos e sobre o próprio fundo tingido (-soft e faisca-suave)', () => {
    const pairs: [string, string, string][] = [];
    for (const surface of SURFACES) pairs.push([color('faisca-claro'), color(surface), `faisca-claro sobre ${surface}`]);
    pairs.push([color('faisca-claro'), color('faisca-suave'), 'faisca-claro sobre faisca-suave']);
    pairs.push([color('text'), color('faisca-suave'), 'text sobre faisca-suave']);
    for (const state of ['success', 'warning', 'danger']) {
      for (const surface of SURFACES) {
        pairs.push([color(state), color(surface), `${state} sobre ${surface}`]);
        // O selo e o cartão do estado são o -soft translúcido SOBRE o fundo da tela: mede-se o texto do estado sobre o composto.
        pairs.push([color(state), color(`${state}-soft`, color(surface)), `${state} sobre ${state}-soft em ${surface}`]);
      }
    }
    // `info` (azul da Faísca) só serve a links e à bolinha de não lido, sem fundo -soft; o texto de link é medido sobre os fundos do app.
    for (const surface of SURFACES) pairs.push([color('info'), color(surface), `info sobre ${surface}`]);
    // Selos e chips neutros ("Trabalhando", fila, "Esta sessão"): text-muted sobre surface-hover; o botão de ditado ativo usa text sobre selected.
    pairs.push([color('text-muted'), color('bg-surface-hover'), 'text-muted sobre bg-surface-hover']);
    pairs.push([color('text'), color('bg-selected'), 'text sobre bg-selected (ditado ativo: ícone e contorno border-fg)']);
    pairs.push([color('action-fg'), color('action'), 'action-fg sobre action (botão primário)']);
    expectAbove(TEXT_AA, pairs);
  });

  it('o anel de foco passa de 3:1 em todo fundo onde um controle pode estar', () => {
    expectAbove(FOCUS_AA, INTERACTIVE.map((surface): [string, string, string] => [color('focus'), color(surface), `focus sobre ${surface}`]));
    expectAbove(FOCUS_AA, [[color('focus'), color('faisca-suave'), 'focus sobre faisca-suave']]);
  });

  it('as 12 cores de bot passam de 4,5:1 como texto do nome sobre o fundo do app, e o rosto da Faísca (tinta) passa de 3:1 sobre o corpo de cada uma e o de marca', () => {
    const bots = DESIGN.color.tokens.filter((token) => token.name.startsWith('bot-')).map((token) => token.name);
    expect(bots).toHaveLength(12);
    expectAbove(TEXT_AA, bots.map((name): [string, string, string] => [color(name), color('bg-app'), `${name} sobre bg-app`]));
    expectAbove(FOCUS_AA, [...bots, 'faisca'].map((name): [string, string, string] => [color('tinta'), color(name), `tinta sobre ${name}`]));
  });

  it('a estrela da Faísca (brilho) tem o contorno que a separa do corpo de cada cor de bot (3:1 do traço sobre o brilho)', () => {
    expect(contrastRatio(color('brilho-traco'), color('brilho'))).toBeGreaterThanOrEqual(FOCUS_AA);
    expect(contrastRatio(color('brilho-traco'), color('brilho-miolo'))).toBeGreaterThanOrEqual(FOCUS_AA);
  });
});

/**
 * Fundo liso (phase 18, UI-06; antes eram as camadas de profundidade da phase 5, T8). Os utilitários `grad-*`, `bot-glow` e `grain` seguem definidos em `globals.css` (cerca de 34
 * componentes ainda os citam) mas sem efeito; aqui entra a prova disso e o que sobra de regra: o único degradê é o halo da Faísca, o grão deixou de existir, a sombra flutuante
 * tem uma fonte só e botões e selos não levam camada de aparência. O texto segue medido sobre o token sólido, na prova de contraste acima.
 */
describe('fundo liso (sem degradê, sem grão e sem brilho) e sombra flutuante', () => {
  /** O corpo de cada `@utility nome { ... }` do arquivo, sem comentários. */
  const UTILITIES = new Map<string, string>();
  for (const match of CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/@utility\s+([\w-]+)\s*\{([\s\S]*?)\n\}/g)) UTILITIES.set(match[1]!, match[2]!);

  /** Todo `.tsx` de componente ou tela abaixo de `src` (sem os testes), com o caminho relativo a `src`. */
  function sourceFiles(directory = new URL('..', import.meta.url)): { path: string; text: string }[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) return sourceFiles(child);
      return entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')
        ? [{ path: fileURLToPath(child).replace(/\\/g, '/').split('/src/')[1]!, text: readFileSync(child, 'utf8') }]
        : [];
    });
  }
  // Varre a árvore uma vez só: antes cada `textOf` varria tudo de novo e o teste dos botões estourava os 5 s do Vitest sob carga (flake registrado em 2026-10-28, resolvido aqui).
  const FILES = sourceFiles();
  const textOf = (path: string): string | undefined => FILES.find((file) => file.path === path)?.text;

  it('os utilitários de fundo existem em um lugar só e não pintam nada: sem degradê, sem URL de grão e sem brilho na cor do bot', () => {
    for (const name of ['grad-app', 'grad-panel', 'grad-sheen', 'grad-composer', 'bot-glow', 'grain']) {
      const body = UTILITIES.get(name);
      expect(body, `@utility ${name}`).toBeDefined();
      expect(body, name).toMatch(/background-image:\s*none;/);
      expect(body, name).not.toMatch(/gradient|url\(|--bot|--faisca|::before/);
    }
    // A conversa do bot segue opaca (era o único utilitário que também trazia a cor sólida).
    expect(UTILITIES.get('bot-glow')).toContain('background-color: var(--bg-app)');
  });

  it('o único degradê do CSS do app é o halo da Faísca (`--grad-hero`), e o arquivo do grão não existe mais', () => {
    const gradients = [...CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:--grad-[\w-]+|background(?:-image)?)\s*:[^;]*-gradient/g)]; // as máscaras de rolagem (`mask-image`) usam linear-gradient só como transparência e não pintam fundo
    expect(gradients).toHaveLength(1);
    expect(DECLARED.get('grad-hero')).toMatch(/^radial-gradient/);
    expect(DESIGN.gradient.tokens.map((token) => token.name)).toEqual(['grad-hero']);
    expect(existsSync(fileURLToPath(new URL('./grain.svg', import.meta.url)))).toBe(false);
  });

  it('o corpo da página é a cor lisa de `bg-app`: nem o layout raiz nem o erro global levam classe de fundo no `<body>`', () => {
    expect(/\nbody\s*\{[^}]*background-color:\s*var\(--bg-app\)/.test(CSS)).toBe(true);
    for (const path of ['app/layout.tsx', 'app/global-error.tsx']) expect(textOf(path), path).toMatch(/<body>/);
  });

  it('a sombra flutuante tem uma fonte só: `shadow-float` (o token), sem o valor escrito à mão em nenhum componente', () => {
    expect(applied('shadow-float')).toBe('0 8px 24px rgba(0, 0, 0, 0.4)');
    const literal = FILES.filter((file) => /shadow-\[[^\]]*8px_24px|box-shadow:[^;]*8px 24px/.test(file.text)).map((file) => file.path);
    expect(literal, 'componentes com a sombra flutuante escrita à mão').toEqual([]);
    for (const path of ['components/ui/menu.tsx', 'components/ui/modal.tsx', 'components/ui/popover.tsx']) expect(textOf(path), path).toContain('shadow-float');
  });

  it('botões, selos e estados não levam degradê nem camada de fundo', () => {
    for (const path of ['components/ui/button.tsx', 'components/settings/status-badge.tsx', 'components/ui/unread-dot.tsx', 'components/ui/switch-track.tsx', 'components/ui/tooltip.tsx']) {
      expect(textOf(path), path).toBeDefined();
      expect(textOf(path), path).not.toMatch(/grad-|bot-glow|grain|--grad|faisca-halo/);
    }
  });
});

describe('fontes', () => {
  it('nenhuma fonte, folha ou imagem remota no CSS do app: tudo autohospedado (fontsource)', () => {
    expect(CSS).not.toMatch(/https?:\/\//i);
    expect(CSS).not.toMatch(/@import\s+url\(/i);
    const layout = read('./layout.tsx');
    expect(layout).not.toMatch(/fonts\.googleapis|fonts\.gstatic|next\/font\/google|https?:\/\//i);
    expect(layout).toContain("import '@fontsource-variable/fredoka'");
    expect(layout).toContain("import '@fontsource-variable/inter'");
    expect(layout).toContain("import '@fontsource-variable/jetbrains-mono'");
  });

  it('a Fredoka só existe na família de marca: o texto do app (sans e mono) e o `body` não a usam', () => {
    const fredokaDeclarations = [...DECLARED.entries()].filter(([, value]) => /fredoka/i.test(value)).map(([name]) => name);
    expect(fredokaDeclarations).toEqual(['font-display']);
    // A família do texto de todo o app é a sans (a regra do `body` que declara `font-family`; `html, body` só dá a altura).
    const bodyFamilies = [...CSS.matchAll(/(?:^|\n)body\s*\{([^}]*)\}/g)].flatMap((match) => [...match[1]!.matchAll(/font-family:\s*([^;]+);/g)].map((family) => family[1]!.trim()));
    expect(bodyFamilies).toEqual(['var(--font-sans)']);
  });
});

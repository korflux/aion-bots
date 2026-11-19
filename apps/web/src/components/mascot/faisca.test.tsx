// Prova da Faísca (HTML renderizado no servidor, sem DOM): o que o desenho e o componente garantem e o CSS não consegue garantir sozinho. O movimento e o visual no
// navegador real são provados no E2E (bots, conversa e Chat geral); aqui ficam os invariantes: os seis estados e o que muda em cada um, o nível de detalhe pelo
// tamanho (48 px ou mais completo, 24 a 47 px liso), a regra de movimento (só `working` e `waiting`, e nunca com `still`), a cor do corpo (a do bot ou a de
// marca), o olhar, a entrada e a acessibilidade (`aria-hidden` sem rótulo).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BOT_RUN_STATES } from '@aion/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Faisca, type FaiscaProps } from './faisca';
import { FAISCA_AION_COLOR, FAISCA_FULL_SIZE, FAISCA_MIN_SIZE, FAISCA_STATES, faiscaDetailOf, faiscaMoves, type FaiscaState } from './faisca-detail';

const render = (props: FaiscaProps = {}) => renderToStaticMarkup(<Faisca {...props} />);

/** A etiqueta `<svg>` de abertura de um desenho renderizado (onde ficam os atributos e as variáveis de cor). */
const svgTag = (html: string): string => html.match(/<svg[^>]*>/)?.[0] ?? '';

describe('estados', () => {
  it('os seis estados são os de BotRunState, na mesma ordem, e cada um sai em `data-state`', () => {
    expect([...FAISCA_STATES]).toEqual([...BOT_RUN_STATES]);
    for (const state of FAISCA_STATES) expect(svgTag(render({ state })), state).toContain(`data-state="${state}"`);
    expect(svgTag(render())).toContain('data-state="idle"');
  });

  it('o rosto muda por estado: reflexo nos olhos redondos, arco feliz, arco fechado, sobrancelhas e uma boca para cada um', () => {
    const faces = Object.fromEntries(FAISCA_STATES.map((state) => [state, render({ state, size: 96 })])) as Record<FaiscaState, string>;
    // Olhos redondos com reflexo: ocioso, trabalhando, aguardando e erro. Concluído (arco feliz) e dormindo (arco fechado) não os têm.
    for (const state of ['idle', 'working', 'waiting', 'error'] as const) expect(faces[state], state).toContain('<ellipse class="fa-ink" data-part="pupil" cx="49" cy="65.5" rx="5.6"');
    expect(faces.done).toContain('M43.5 67 Q49 59.5 54.5 67');
    expect(faces.done).not.toContain('<ellipse class="fa-ink" data-part="pupil" cx="49"');
    expect(faces.sleep).toContain('M43.5 64.5 Q49 70 54.5 64.5');
    expect(faces.sleep).not.toContain('<ellipse class="fa-ink" data-part="pupil" cx="49"');
    // O erro tem olhos mais baixos; trabalhando e aguardando têm sobrancelhas próprias; ocioso, concluído e dormindo não têm.
    expect(faces.error).toContain('ry="5.6"');
    expect(faces.idle).toContain('ry="6.8"');
    expect(faces.error).toContain('M42.5 55.5 Q47 55 53 58.5');
    expect(faces.waiting).toContain('M66 56 Q71 52.5 76.5 55');
    expect(faces.working).toContain('M44 57 Q49 55.5 54 57');
    for (const state of ['idle', 'done', 'sleep'] as const) expect(faces[state], state).not.toContain('fa-ink-line" stroke-width="2.4" d="M42.5');
    // Cada estado tem a sua boca (seis desenhos diferentes).
    const mouths = new Set(
      FAISCA_STATES.map((state) => faces[state].match(/<g class="fa-follow" data-part="eyes">[\s\S]*?<\/g>([\s\S]*?)<\/g>/)?.[1] ?? ''),
    );
    expect(mouths.size).toBe(FAISCA_STATES.length);
    // Concluído mostra a língua (token de bochecha); as bochechas ficam mais fracas no erro.
    expect(faces.done).toContain('M56.4 80.6 Q60 77.6 63.6 80.6');
    expect(faces.error).toContain('fill-opacity="0.22"');
    expect(faces.idle).toContain('fill-opacity="0.5"');
  });

  it('a estrela da antena é a do estado: tokens de marca no ocioso, escala e cor próprias nos demais, halo só trabalhando e concluído', () => {
    expect(render({ state: 'idle', size: 96 })).toContain('fill:var(--brilho);stroke:var(--brilho-traco)');
    expect(render({ state: 'waiting', size: 96 })).toContain('fill:#FB923C;stroke:#C2410C');
    expect(render({ state: 'error', size: 96 })).toContain('scale(0.82)');
    expect(render({ state: 'error', size: 96 })).toContain('rotate(26 60 30)'); // a antena cai no erro
    expect(render({ state: 'sleep', size: 96 })).toContain('rotate(-22 60 30)'); // e no sono, para o outro lado
    for (const state of FAISCA_STATES) {
      const halo = render({ state, size: 96 }).includes('<circle r="15"');
      expect(halo, state).toBe(state === 'working' || state === 'done');
    }
  });
});

describe('níveis de detalhe', () => {
  it('48 px ou mais é o desenho completo; de 24 a 47 px é o liso; o limite e o piso vêm de constantes únicas', () => {
    expect(FAISCA_MIN_SIZE).toBe(24);
    expect(FAISCA_FULL_SIZE).toBe(48);
    const expected: [number, 'full' | 'small'][] = [
      [112, 'full'],
      [96, 'full'],
      [48, 'full'],
      [47, 'small'],
      [40, 'small'],
      [32, 'small'],
      [24, 'small'],
      [16, 'small'], // abaixo do piso renderiza liso (quem decide a inicial é o BotAvatar)
    ];
    for (const [size, detail] of expected) {
      expect(faiscaDetailOf(size), `${size} px`).toBe(detail);
      const tag = svgTag(render({ size }));
      expect(tag, `${size} px`).toContain(`data-detail="${detail}"`);
      expect(tag).toContain(`width="${size}"`);
      expect(tag).toContain(`height="${size}"`);
    }
  });

  it('o completo tem pelo, miolo e brilho na estrela, dedinhos e o ícone flutuante; o liso não tem nenhum, e a estrela ganha contorno mais grosso', () => {
    const full = render({ size: 48, state: 'working' });
    const small = render({ size: 47, state: 'working' });
    expect(full).toContain('<filter');
    expect(full).toContain('filter="url(#faisca-fur-');
    expect(full).toContain('fa-toes');
    expect(full).toContain('stroke-width="1.4"'); // contorno fino da estrela completa
    expect(full).toContain('<circle cx="-2.4" cy="-2.6" r="1.3"'); // brilho da estrela
    expect(full).toContain('fx-dot'); // balão de digitação
    expect(small).not.toContain('<filter');
    expect(small).not.toContain('filter=');
    expect(small).not.toContain('fa-toes');
    expect(small).not.toContain('fx-dot');
    expect(small).not.toContain('<circle cx="-2.4"');
    expect(small).toContain('stroke-width="2.6"'); // contorno grosso da estrela lisa
    // O liso não tem ícone flutuante em nenhum estado; o completo tem em todos menos no ocioso.
    for (const state of FAISCA_STATES) {
      expect(render({ size: 32, state }), `${state} liso`).not.toContain('fx-float');
      expect(render({ size: 32, state }), `${state} liso`).not.toContain('translate(88 40)');
      expect(render({ size: 96, state }).includes('fx-float') || render({ size: 96, state }).includes('translate(88 40)'), `${state} completo`).toBe(state !== 'idle');
    }
  });

  it('cada estado tem o seu ícone flutuante no completo: balão, "?", "✓" com estrelinhas, "!" com gota e os "z" do sono', () => {
    expect(render({ size: 96, state: 'working' })).toContain('fx-dot');
    expect(render({ size: 96, state: 'waiting' })).toContain('fill="#F59E0B"');
    expect(render({ size: 96, state: 'done' })).toContain('fill="#16A34A"');
    expect(render({ size: 96, state: 'done' })).toContain('scale(.42)'); // estrelinhas da conclusão
    expect(render({ size: 96, state: 'error' })).toContain('fill="#DC2626"');
    expect(render({ size: 96, state: 'error' })).toContain('M96.5 52 Q100.5 59.5 96.5 63'); // gota
    expect((render({ size: 96, state: 'sleep' }).match(/M-5 -5 H5 L-5 5 H5/g) ?? []).length).toBe(3);
  });

  it('cada desenho completo tem o filtro de pelo com id próprio (vários na mesma página não colidem)', () => {
    const html = renderToStaticMarkup(
      <>
        <Faisca size={96} />
        <Faisca size={96} state="working" />
      </>,
    );
    const ids = [...html.matchAll(/<filter id="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => /^[a-zA-Z][\w-]*$/.test(id!))).toBe(true); // serve em `url(#...)`
    for (const id of ids) expect(html).toContain(`filter="url(#${id})"`);
  });
});

describe('movimento', () => {
  it('só trabalhando e aguardando rodam laços; os demais estados ficam parados mesmo sem `still`', () => {
    for (const state of FAISCA_STATES) {
      const moving = state === 'working' || state === 'waiting';
      expect(faiscaMoves(state, false), state).toBe(moving);
      expect(svgTag(render({ state })).includes('data-still'), `${state}: parada`).toBe(!moving);
    }
  });

  it('`still` para até o trabalhando e o aguardando (listas e qualquer Faísca que não seja o foco)', () => {
    for (const state of ['working', 'waiting'] as const) {
      expect(faiscaMoves(state, true), state).toBe(false);
      expect(svgTag(render({ state, still: true })), state).toContain('data-still');
    }
  });

  it('todo laço do CSS só roda sem `data-still`, e a entrada só com `data-enter` (a Faísca parada nunca anima)', () => {
    const css = readFileSync(fileURLToPath(new URL('./faisca.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1]!.trim(), body: match[2]! }));
    const animated = rules.filter((rule) => /animation(-duration|-delay)?\s*:/.test(rule.body) && !rule.selector.startsWith('to') && !/^\d|^from|^%/.test(rule.selector));
    expect(animated.length).toBeGreaterThan(0);
    for (const rule of animated) {
      expect(rule.selector, rule.selector).toMatch(/:not\(\[data-still\]\)|\[data-enter\]/);
    }
    // Laço infinito só atrás do `data-still`: a entrada roda uma vez.
    for (const rule of animated.filter((item) => item.body.includes('infinite'))) expect(rule.selector).toContain(':not([data-still])');
  });
});

describe('cor do corpo', () => {
  it('a cor do bot vira o corpo; sem cor vale a de marca (o Aion), que é um token e não um valor fixo', () => {
    expect(svgTag(render({ color: '#F472B6' }))).toContain('--faisca-body:#F472B6');
    expect(svgTag(render())).toContain(`--faisca-body:${FAISCA_AION_COLOR}`);
    expect(FAISCA_AION_COLOR).toBe('var(--faisca)');
  });

  it('o corpo e os tons de sombra e brilho vêm das classes do CSS (que misturam a cor), e o rosto usa a tinta de marca, não a cor do bot', () => {
    const html = render({ color: '#1E3A8A', size: 96 });
    for (const tone of ['fa-body', 'fa-s72', 'fa-s78', 'fa-s80', 'fa-s84', 'fa-s86', 'fa-l84', 'fa-l64']) expect(html, tone).toContain(tone);
    expect(html).toContain('fa-ink'); // tinta fixa nos dois temas: legível em qualquer cor de bot, sem calcular tinta por cor
    expect(html).toContain('fa-cheek');
    const css = readFileSync(fileURLToPath(new URL('./faisca.css', import.meta.url)), 'utf8');
    expect(css).toMatch(/\.fa-ink\s*\{\s*fill:\s*var\(--tinta\)/);
    expect(css).toMatch(/\.fa-cheek\s*\{\s*fill:\s*var\(--bochecha\)/);
    expect(css).toMatch(/\.fa-s72\s*\{\s*fill:\s*color-mix\(in srgb, var\(--faisca-body\) 72%, #000\)/);
  });
});

describe('olhar, entrada e acessibilidade', () => {
  it('o olhar só vale ocioso e aguardando, é limitado a -1..1, e `enter` vira atributo', () => {
    expect(svgTag(render({ gaze: { x: 0.5, y: -0.25 } }))).toContain('--lx:0.5;--ly:-0.25');
    expect(svgTag(render({ state: 'waiting', gaze: { x: 9, y: -9 } }))).toContain('--lx:1;--ly:-1');
    expect(svgTag(render({ state: 'working', gaze: { x: 1, y: 1 } }))).not.toContain('--lx');
    expect(svgTag(render({ gaze: null }))).not.toContain('--lx');
    expect(svgTag(render({ gaze: { x: 1, y: 0 } }))).toContain('data-look');
    expect(svgTag(render())).not.toContain('data-look');
    expect(svgTag(render({ enter: true }))).toContain('data-enter');
    expect(svgTag(render())).not.toContain('data-enter');
  });

  it('é decorativa por padrão (`aria-hidden`, sem rótulo) e vira imagem nomeada quando recebe `label`', () => {
    const decorative = svgTag(render());
    expect(decorative).toContain('aria-hidden="true"');
    expect(decorative).not.toContain('role=');
    expect(decorative).not.toContain('aria-label');
    expect(decorative).toContain('focusable="false"');

    const named = svgTag(render({ state: 'working', label: 'Financeiro, trabalhando' }));
    expect(named).toContain('role="img"');
    expect(named).toContain('aria-label="Financeiro, trabalhando"');
    expect(named).not.toContain('aria-hidden');
  });

  it('a classe do chamador acompanha a base (`faisca`), para o tamanho de destaque e o espaçamento virem de quem usa', () => {
    expect(svgTag(render({ className: 'faisca-hero' }))).toContain('class="faisca faisca-hero"');
    expect(svgTag(render())).toContain('class="faisca"');
  });
});

// Desenho da Faísca (mascote único do Aion) em SVG puro, fonte única para os assets e previews do design system.
// Quadro 0 0 120 120. Luz de cima à esquerda; corpo em camadas (base, sombra inferior, sombra lateral, barriga, brilho, tufo).
// `rich` (>= 48 px) liga pelo, miolo da faísca e dedinhos; abaixo disso o desenho engrossa e simplifica.

export const INK = '#1B1530';
export const STAR = 'M0 -11 C1.6 -3.6 3.6 -1.6 11 0 C3.6 1.6 1.6 3.6 0 11 C-1.6 3.6 -3.6 1.6 -11 0 C-3.6 -1.6 -1.6 -3.6 0 -11Z';
export const STATES = ['idle', 'working', 'waiting', 'done', 'error', 'sleep'];
export const STATE_LABEL = { idle: 'Ocioso', working: 'Trabalhando', waiting: 'Aguardando', done: 'Concluído', error: 'Erro', sleep: 'Dormindo' };

/** Mistura a cor com preto (k < 1) ou branco (k > 1, 2-k é a fração da cor). Gera os tons de sombra e brilho do corpo. */
export function mix(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const t = k < 1 ? 0 : 255, f = k < 1 ? k : 2 - k;
  const c = (v) => Math.round(v * f + t * (1 - f)).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Cor da faísca por estado: [miolo, preenchimento, contorno, escala]. */
const SPARK = {
  idle: ['#FEF3C7', '#FACC15', '#A16207', 1],
  working: ['#FEF9C3', '#FDE047', '#CA8A04', 1.2],
  waiting: ['#FED7AA', '#FB923C', '#C2410C', 1],
  done: ['#FEF9C3', '#FDE047', '#CA8A04', 1.12],
  error: ['#FECACA', '#F87171', '#B91C1C', 0.82],
  sleep: ['#E2E8F0', '#CBD5E1', '#64748B', 0.78],
};

const BODY = 'M60 27 C86 27 100 45 102 70 C104 94 94 106 60 106 C26 106 16 94 18 70 C20 45 34 27 60 27Z';

function eye(cx, cy, s) {
  if (s === 'done') return `<path d="M${cx - 5.5} ${cy + 1.5} Q${cx} ${cy - 6} ${cx + 5.5} ${cy + 1.5}" fill="none" stroke="${INK}" stroke-width="3.2" stroke-linecap="round"/>`;
  if (s === 'sleep') return `<path d="M${cx - 5.5} ${cy - 1} Q${cx} ${cy + 4.5} ${cx + 5.5} ${cy - 1}" fill="none" stroke="${INK}" stroke-width="3.2" stroke-linecap="round"/>`;
  const lx = s === 'working' ? 1.6 : 0, ly = s === 'waiting' ? -1 : 0, ry = s === 'error' ? 5.6 : 6.8;
  return `<ellipse cx="${cx}" cy="${cy}" rx="5.6" ry="${ry}" fill="${INK}"/><ellipse cx="${cx + lx * 0.4}" cy="${cy + ry * 0.45}" rx="3.4" ry="1.8" fill="#4B4570"/><circle cx="${cx + 1.9 + lx}" cy="${cy - 2.6 + ly}" r="2.3" fill="#fff"/><circle cx="${cx - 1.8 + lx}" cy="${cy + 2.4 + ly}" r="1" fill="#fff" fill-opacity=".85"/>`;
}

function brows(s) {
  if (s === 'error') return `<path d="M42.5 55.5 Q47 55 53 58.5 M77.5 55.5 Q73 55 67 58.5" fill="none" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/>`;
  if (s === 'waiting') return `<path d="M66 56 Q71 52.5 76.5 55" fill="none" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/>`;
  if (s === 'working') return `<path d="M44 57 Q49 55.5 54 57 M66 57 Q71 55.5 76 57" fill="none" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/>`;
  return '';
}

function mouth(s) {
  return {
    idle: `<path d="M55.8 75.2 Q60 79.8 64.2 75.2" fill="none" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/>`,
    working: `<path d="M57.5 76.6 Q60 74.8 62.5 76.6 Q62.4 80 60 80 Q57.6 80 57.5 76.6Z" fill="${INK}"/>`,
    waiting: `<path d="M56 77.6 Q58 76 60 77 T64 76.4" fill="none" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/>`,
    done: `<path d="M53.6 74 Q60 74.6 66.4 74 Q65.4 83.6 60 83.6 Q54.6 83.6 53.6 74Z" fill="${INK}"/><path d="M56.4 80.6 Q60 77.6 63.6 80.6 Q62.2 82.6 60 82.6 Q57.8 82.6 56.4 80.6Z" fill="#FF7AA8"/>`,
    error: `<path d="M55.4 79 Q57.7 75.8 60 78.2 Q62.3 80.6 64.6 77.4" fill="none" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/>`,
    sleep: `<ellipse cx="60" cy="77.6" rx="2.2" ry="2.6" fill="${INK}"/>`,
  }[s];
}

/** Ícone flutuante do estado (ao lado, em cima à direita). Ocioso não tem. `anim` adiciona classes para o CSS animar. */
export function bubble(s, anim = false) {
  const fl = anim ? ' class="fx-float"' : '';
  const g = (x, y, inner) => `<g transform="translate(${x} ${y})"><g${fl}>${inner}</g></g>`;
  const tail = (fill, stroke) => `<path d="M-7 9 L-12 16 L-1 10.5Z" fill="${fill}" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round"/>`;
  const dot = anim ? ' class="fx-dot"' : '';
  if (s === 'working') return g(97, 26, `${tail('#fff', '#CBD5E1')}<rect x="-15" y="-10" width="30" height="20" rx="10" fill="#fff" stroke="#CBD5E1" stroke-width="1.5"/><path d="M-9 9.2 L-6 9.2" stroke="#fff" stroke-width="2.2"/><circle${dot} cx="-7" cy="0" r="2.6" fill="#3B82F6"/><circle${dot} cx="0" cy="0" r="2.6" fill="#3B82F6"/><circle${dot} cx="7" cy="0" r="2.6" fill="#3B82F6"/>`);
  if (s === 'waiting') return g(98, 26, `${tail('#F59E0B', '#B45309')}<circle r="12" fill="#F59E0B" stroke="#B45309" stroke-width="1.5"/><path d="M-3.6 -3.4 Q-3.6 -7 0 -7 Q3.6 -7 3.6 -3.6 Q3.6 -1 0 0.6 V2.4" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/><circle cx="0" cy="6.2" r="1.7" fill="#fff"/>`);
  if (s === 'done') return g(98, 28, `<circle r="12" fill="#16A34A" stroke="#15803D" stroke-width="1.5"/><path d="M-5.4 0.4 L-1.6 4.4 L5.6 -4" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`) + `<g fill="#FDE047" stroke="#CA8A04" stroke-width="1"><path transform="translate(18 40) scale(.42)" d="${STAR}"/><path transform="translate(30 20) scale(.3)" d="${STAR}"/><path transform="translate(108 56) scale(.34)" d="${STAR}"/></g>`;
  if (s === 'error') return g(98, 28, `<circle r="12" fill="#DC2626" stroke="#B91C1C" stroke-width="1.5"/><path d="M0 -6.4 V1.4" stroke="#fff" stroke-width="3" stroke-linecap="round"/><circle cx="0" cy="6" r="1.8" fill="#fff"/>`) + `<path d="M96.5 52 Q100.5 59.5 96.5 63 Q92.5 59.5 96.5 52Z" fill="#BAE6FD" stroke="#38BDF8" stroke-width="1.2"/>`;
  if (s === 'sleep') {
    const z = (x, y, k, c) => `<g transform="translate(${x} ${y}) scale(${k})"><g${anim ? ` class="fx-z ${c}"` : ''}><path d="M-5 -5 H5 L-5 5 H5" fill="none" stroke="#818CF8" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></g></g>`;
    return z(88, 40, 0.8, '') + z(96, 28, 1, 'fx-z2') + z(105, 15, 1.2, 'fx-z3');
  }
  return '';
}

/**
 * Miolo do desenho (sem <svg>). opts: color (corpo), state, rich (pelo e detalhes), bubble (ícone de estado), anim (classes de movimento),
 * furId (id do filtro de pelo; o chamador declara o <filter>), ground (sombra no chão).
 */
export function faiscaInner({ color = '#3B82F6', state = 'idle', rich = true, withBubble = true, anim = false, furId = 'fur', ground = true } = {}) {
  const c = color, s = state;
  const [core, fill, line, sc] = SPARK[s];
  const droop = s === 'error' ? ' transform="rotate(26 60 30)"' : s === 'sleep' ? ' transform="rotate(-22 60 30)"' : '';
  const arm = s === 'done' ? 32 : s === 'waiting' ? 14 : 22;
  const ch = s === 'error' ? 0.22 : 0.5;
  const halo = s === 'working' || s === 'done' ? `<circle r="15" fill="${fill}" fill-opacity=".28"/><circle r="10" fill="${fill}" fill-opacity=".35"/>` : '';
  const fur = rich ? ` filter="url(#${furId})"` : '';
  const a = (cls) => (anim ? ` class="${cls}"` : '');
  return `${ground ? `<ellipse cx="60" cy="114" rx="31" ry="4.2" fill="${INK}" fill-opacity=".13"/>` : ''}
<g${a('fx-bob')}>
<g${droop}><g${a('fx-ant')}>
<path d="M57.4 31 C55 22 57 14.6 63.4 11.6 L64.6 13.8 C60 16.6 59 22.4 61.6 31Z" fill="${mix(c, 0.78)}"/>
<g transform="translate(64 11)"><g${a('fx-tw')}>${halo}<path d="${STAR}" transform="scale(${sc})" fill="${fill}" stroke="${line}" stroke-width="${rich ? 1.4 : 2.6}" stroke-linejoin="round"/>${rich ? `<path d="${STAR}" transform="scale(${(sc * 0.48).toFixed(3)})" fill="${core}"/><circle cx="-2.4" cy="-2.6" r="1.3" fill="#fff"/>` : ''}</g></g>
</g></g>
<g${fur}>
<ellipse cx="44" cy="105" rx="12.5" ry="7.2" fill="${mix(c, 0.72)}"/><ellipse cx="76" cy="105" rx="12.5" ry="7.2" fill="${mix(c, 0.72)}"/>
<ellipse cx="21" cy="81" rx="7.2" ry="11.5" transform="rotate(${arm} 21 81)" fill="${mix(c, 0.8)}"/><ellipse cx="99" cy="81" rx="7.2" ry="11.5" transform="rotate(${-arm} 99 81)" fill="${mix(c, 0.8)}"/>
<path d="${BODY}" fill="${c}"/>
<path d="M18.6 78 C22 98 36 106 60 106 C84 106 98 98 101.4 78 C96 94 82 100 60 100 C38 100 24 94 18.6 78Z" fill="${mix(c, 0.84)}"/>
<path d="M88 40 C101 56 104 82 94 98 C98 80 96 60 88 40Z" fill="${mix(c, 0.86)}"/>
<ellipse cx="60" cy="88" rx="23" ry="11.5" fill="${mix(c, 1.16)}" fill-opacity=".5"/>
<path d="M30 56 C31 44 40 35 51 32 C44 38 37 46 34 57Z" fill="${mix(c, 1.36)}" fill-opacity=".7"/>
<path d="M54 31.5 Q55.5 25 59 30 Q60.5 24 63.5 30 Q65.5 26 66.5 31.5Z" fill="${c}"/>
</g>
${rich ? `<path d="M52 101 Q54 98 56 101 M64 101 Q66 98 68 101" fill="none" stroke="${mix(c, 0.7)}" stroke-width="1.4" stroke-linecap="round"/>` : ''}
<ellipse cx="38.5" cy="76" rx="7" ry="4.2" fill="#FF7AA8" fill-opacity="${(ch * 0.6).toFixed(2)}"/><ellipse cx="38.5" cy="76" rx="4.6" ry="2.6" fill="#FF7AA8" fill-opacity="${ch}"/>
<ellipse cx="81.5" cy="76" rx="7" ry="4.2" fill="#FF7AA8" fill-opacity="${(ch * 0.6).toFixed(2)}"/><ellipse cx="81.5" cy="76" rx="4.6" ry="2.6" fill="#FF7AA8" fill-opacity="${ch}"/>
${brows(s)}${eye(49, 65.5, s)}${eye(71, 65.5, s)}${mouth(s)}
</g>${withBubble ? bubble(s, anim) : ''}`;
}

export const furFilter = (id = 'fur') =>
  `<filter id="${id}" x="-8%" y="-8%" width="116%" height="116%"><feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="2" seed="11"/><feDisplacementMap in="SourceGraphic" scale="2.4"/></filter>`;

/** SVG completo e independente (para arquivo de asset). */
export function faiscaSvg(opts = {}) {
  const rich = opts.rich ?? true;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -8 128 128" width="${opts.size ?? 120}" height="${opts.size ?? 120}">${rich ? `<defs>${furFilter()}</defs>` : ''}${faiscaInner({ ...opts, rich })}</svg>\n`;
}

/** Estrela da faísca sozinha (favicon, push, pingo do i). */
export function sparkInner({ fill = '#FACC15', line = '#A16207', core = '#FEF3C7', rich = true } = {}) {
  return `<path d="${STAR}" fill="${fill}"${line ? ` stroke="${line}" stroke-width="${rich ? 1.2 : 1.8}" stroke-linejoin="round"` : ''}/>${rich && core ? `<path d="${STAR}" transform="scale(.48)" fill="${core}"/>` : ''}`;
}

/**
 * Logotipo "aion" desenhado (traço redondo, sem depender de fonte instalada): a de um andar, ı sem pingo, o, n; a faísca é o pingo do i.
 * Medidas: traço 14, altura-x 50 (y 30 a 80), viewBox 0 0 240 96.
 */
export function wordmarkInner(ink) {
  const st = `fill="none" stroke="${ink}" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"`;
  return `<circle cx="34" cy="55" r="22" ${st}/><path d="M56 34 V80" ${st}/><path d="M88 34 V80" ${st}/><circle cx="136" cy="55" r="22" ${st}/><path d="M186 80 V34 M186 54 C186 40 195 33 206 33 C218 33 226 41 226 54 V80" ${st}/><g transform="translate(88 12)">${sparkInner({ rich: true })}</g>`;
}
export const wordmarkSvg = (ink, h = 92) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 96" width="${Math.round((240 * h) / 96)}" height="${h}">${wordmarkInner(ink)}</svg>\n`;

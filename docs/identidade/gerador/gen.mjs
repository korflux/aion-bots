// Gera docs/identidade (tokens.json, assets SVG e components/*) a partir de faisca.mjs, tokens.mjs, comps.mjs, appcomps.mjs e phase34.mjs; depois rode galeria.mjs. Rodar: node docs/identidade/gerador/gen.mjs. Não reescreve README.md, aplicacao.md nem navegacao-mobile.html.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tokens } from './tokens.mjs';
import { COMPONENTS, KIT } from './comps.mjs';
import { APP_COMPONENTS, APPKIT } from './appcomps.mjs';
import { P34_COMPONENTS, P34_CSS } from './phase34.mjs';
import { MOTION_COMPONENTS, MOTION_CSS, MOTION_TOKENS, REPLAY_JS } from './motion.mjs';
import { BG_APPLY_CSS, BG_COMPONENTS, BG_CSS, GRADIENT_TOKENS } from './bg.mjs';
import { INK, STATES, STATE_LABEL, faiscaInner, faiscaSvg, furFilter, sparkInner, wordmarkInner, wordmarkSvg } from './faisca.mjs';

const OUT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const put = (p, s) => { const f = join(OUT, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, s); };

// ---------- tokens ----------
put('tokens.json', JSON.stringify({ ...tokens, ...MOTION_TOKENS, ...GRADIENT_TOKENS }, null, 2) + '\n');

// ---------- assets ----------
const svgWrap = (vb, w, h, inner, defs = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${w}" height="${h}">${defs ? `<defs>${defs}</defs>` : ''}${inner}</svg>\n`;
put('assets/Logos/aion-logotipo-claro.svg', wordmarkSvg('#ECECF1'));
put('assets/Logos/aion-logotipo-tinta.svg', wordmarkSvg(INK));
// Assinatura: Faísca (120) + logotipo, alinhados pela base.
const lockup = (ink) => svgWrap('0 0 400 128', 400, 128, `<g transform="translate(0 4)">${faiscaInner({ withBubble: false, ground: false })}</g><g transform="translate(140 22)">${wordmarkInner(ink)}</g>`, furFilter());
put('assets/Logos/aion-assinatura-claro.svg', lockup('#ECECF1'));
put('assets/Logos/aion-assinatura-tinta.svg', lockup(INK));
put('assets/Logos/faisca-estrela.svg', svgWrap('-13 -13 26 26', 64, 64, sparkInner()));

for (const s of STATES) put(`assets/Faisca/faisca-${s}.svg`, faiscaSvg({ state: s, size: 240 }));
put('assets/Faisca/faisca-simples-24.svg', faiscaSvg({ state: 'idle', rich: false, withBubble: false, size: 24 }));
for (const [n, c] of [['verde', '#4ade80'], ['rosa', '#f472b6'], ['ambar', '#fbbf24']]) put(`assets/Faisca/faisca-bot-${n}.svg`, faiscaSvg({ color: c, size: 240 }));

// Ícones do app (estrela chapada desde 2026-11-15, decisão do dono): a estrela sólida, sem contorno nem miolo, sobre tinta, no ícone do app, no maskable
// e no favicon, porque a Faísca inteira (corpo, rosto e pelo) ficava carregada ao lado dos ícones minimalistas da tela inicial. A estrela ocupa 36 % do lado
// no ícone e no favicon (escala 16,8 em 512 e 1,05 em 32) e 28,8 % no maskable (escala 13,4), para parecer do mesmo tamanho depois do recorte de 80 %.
const flatStar = sparkInner({ line: null, rich: false });
put('assets/Icones/app-icon.svg', svgWrap('0 0 512 512', 512, 512, `<rect width="512" height="512" rx="112" fill="${INK}"/><g transform="translate(256 256) scale(16.8)">${flatStar}</g>`));
put('assets/Icones/app-icon-maskable.svg', svgWrap('0 0 512 512', 512, 512, `<rect width="512" height="512" fill="${INK}"/><g transform="translate(256 256) scale(13.4)">${flatStar}</g>`));
put('assets/Icones/favicon.svg', svgWrap('0 0 32 32', 32, 32, `<rect width="32" height="32" rx="7" fill="${INK}"/><g transform="translate(16 16) scale(1.05)">${flatStar}</g>`));
put('assets/Icones/push-badge.svg', svgWrap('-13 -13 26 26', 96, 96, sparkInner({ fill: '#FFFFFF', line: null, rich: false })));
put('assets/Icones/push-icone-grande.svg', svgWrap('0 0 192 192', 192, 192, `<circle cx="96" cy="96" r="96" fill="${INK}"/><g transform="translate(24 22) scale(1.2)">${faiscaInner({ color: '#3B82F6', withBubble: false, ground: false, rich: false })}</g>`));

put('assets/Logos/README.md', `# Logos

- \`aion-logotipo-claro.svg\`: logotipo em #ECECF1 (token text, tema escuro) para fundos bg-app, bg-panel e tinta.
- \`aion-logotipo-tinta.svg\`: logotipo em tinta #1B1530 para fundos claros (bg-app do tema claro, branco).
- \`aion-assinatura-claro.svg\` e \`aion-assinatura-tinta.svg\`: Faísca + logotipo, para login, README e divulgação. Mínimo 32 px de altura.
- \`faisca-estrela.svg\`: a estrela sozinha (brilho com contorno brilho-traco). Pingo do i, favicon e selos de conquista.

O logotipo é desenhado em traço, não depende de fonte instalada. Nunca recompor em texto com Fredoka nem trocar a cor da estrela.
`);
put('assets/Faisca/README.md', `# Faísca

Um SVG por estado (\`faisca-idle\`, \`-working\`, \`-waiting\`, \`-done\`, \`-error\`, \`-sleep\`), corpo em Azul Faísca, com pelo e ícone flutuante. \`faisca-bot-*\` mostram a regra da cor do bot. \`faisca-simples-24.svg\` é o nível pequeno: sem pelo, sem miolo na estrela, contorno mais grosso, sem ícone flutuante.

Estes arquivos são referência visual e material de divulgação. No app a Faísca é o componente React (ver componente Faisca), nunca um <img> destes arquivos.
`);
put('assets/Icones/README.md', `# Ícones do app

- \`app-icon.svg\`: ícone do PWA (192 e 512 px exportados em PNG), estrela chapada sobre tinta, cantos de 22%.
- \`app-icon-maskable.svg\`: versão maskable, estrela chapada dentro da zona segura de 80% (o Android recorta em círculo ou squircle).
- \`favicon.svg\`: a mesma estrela chapada sobre tinta, 32 e 16 px.
- \`push-badge.svg\`: estrela branca sobre transparente. Ícone pequeno da notificação no Android, que só usa o alfa.
- \`push-icone-grande.svg\`: Faísca simples sobre disco tinta, ícone grande da notificação.
`);

// ---------- previews ----------
const FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400&display=swap">';
// Fallbacks literais: o frame carrega tokens.css, mas os previews continuam legíveis sem ele.
const BASE = `html,body{margin:0}body{background:var(--bg-app,#0e0e13);color:var(--text,#ececf1);font-family:var(--font-sans,"Inter",system-ui,sans-serif);font-size:15px;line-height:24px;padding:16px}
.lbl{font-size:12px;line-height:16px;color:var(--text-muted,#a3a3b0);text-align:center}`;
const MOTION = `.fx-bob{animation:fxbob 3s ease-in-out infinite;transform-box:view-box;transform-origin:60px 108px}
.fx-ant{animation:fxsway 3s ease-in-out infinite;transform-box:view-box;transform-origin:60px 30px}
.fx-tw{animation:fxtw 1.8s ease-in-out infinite}.fx-float{animation:fxfloat 2.4s ease-in-out infinite}
.fx-dot{animation:fxdot 1.2s ease-in-out infinite}.fx-dot:nth-of-type(2){animation-delay:.15s}.fx-dot:nth-of-type(3){animation-delay:.3s}
.fx-z{animation:fxz 2.6s ease-in infinite;opacity:0}.fx-z2{animation-delay:.9s}.fx-z3{animation-delay:1.8s}
svg[data-s="working"] .fx-bob{animation-duration:1.1s}svg[data-s="sleep"] .fx-bob{animation-duration:4.5s}
svg[data-s="error"] .fx-bob,svg[data-s="error"] .fx-ant{animation:none}
@keyframes fxbob{0%,100%{transform:translateY(0) scale(1,1)}50%{transform:translateY(-2.5px) scale(.985,1.015)}}
@keyframes fxsway{0%,100%{transform:rotate(-5deg)}50%{transform:rotate(6deg)}}
@keyframes fxtw{0%,100%{transform:scale(1) rotate(0)}50%{transform:scale(1.15) rotate(14deg)}}
@keyframes fxfloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
@keyframes fxdot{0%,100%{transform:translateY(0);opacity:.45}40%{transform:translateY(-2.5px);opacity:1}}
@keyframes fxz{0%{opacity:0;transform:translate(0,4px) scale(.7)}25%{opacity:1}100%{opacity:0;transform:translate(8px,-14px) scale(1.1)}}
@media (prefers-reduced-motion:reduce){.fx-bob,.fx-ant,.fx-tw,.fx-float,.fx-dot{animation:none}.fx-z{animation:none;opacity:1}}`;
const inl = (opts, size, id) => `<svg viewBox="-4 -8 128 128" width="${size}" height="${size}" data-s="${opts.state}" aria-hidden="true">${opts.rich === false ? '' : `<defs>${furFilter(id)}</defs>`}${faiscaInner({ ...opts, furId: id })}</svg>`;
const preview = (marker, title, css, body, script = '') => `${marker}
<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>${title}</title>${FONTS}<style>${BASE}${css}${MOTION_CSS}${BG_CSS}${BG_APPLY_CSS}</style></head>
<body>
${body}
${script ? `<script>${script}</script>` : ''}
<script>${REPLAY_JS}</script>
</body>
</html>
`;

// Faísca: palco com seletor de estado + grade dos seis estados + régua de tamanhos.
const heroMap = Object.fromEntries(STATES.map((s) => [s, inl({ state: s, anim: true }, 176, `h-${s}`)]));
put('components/Faisca/preview.html', preview('<!-- @dsCard group="Marca" height=640 subtitle="Mascote único: seis estados, cor do bot, níveis de detalhe" -->', 'Faísca',
  `${MOTION}
.stage{display:flex;flex-direction:column;align-items:center;gap:12px;background:var(--bg-panel,#15151b);border:1px solid var(--border,#2e2e38);border-radius:var(--radius-lg,16px);padding:16px}
.pick{display:flex;flex-wrap:wrap;gap:6px;justify-content:center}
.pick button{font:500 13px/20px var(--font-sans,"Inter",sans-serif);color:var(--text-muted,#a3a3b0);background:var(--bg-surface,#1b1b22);border:1px solid var(--border,#2e2e38);border-radius:999px;padding:4px 12px;cursor:pointer}
.pick button[aria-pressed="true"]{color:var(--text,#ececf1);background:var(--bg-selected,#2a2a33);border-color:var(--border-strong,#6a6a80)}
.pick button:focus-visible{outline:2px solid var(--focus,#8db6fa);outline-offset:2px}
.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-top:12px}
.cell{display:flex;flex-direction:column;align-items:center;background:var(--bg-surface,#1b1b22);border-radius:var(--radius-md,10px);padding:6px 2px}
.sizes{display:flex;gap:20px;align-items:flex-end;justify-content:center;margin-top:12px}
.sizes div{display:flex;flex-direction:column;align-items:center;gap:2px}`,
  `<div class="stage"><div id="hero">${heroMap.working}</div><div class="pick" role="group" aria-label="Estado">${STATES.map((s) => `<button type="button" data-s="${s}" aria-pressed="${s === 'working'}">${STATE_LABEL[s]}</button>`).join('')}</div></div>
<div class="grid">${STATES.map((s, i) => `<div class="cell">${inl({ state: s, color: ['#60a5fa', '#4ade80', '#f472b6', '#a78bfa', '#2dd4bf', '#fb923c'][i], anim: true }, 84, `g-${s}`)}<span class="lbl">${STATE_LABEL[s]}</span></div>`).join('')}</div>
<div class="sizes">${[24, 32, 48, 64, 96].map((z) => `<div>${inl({ state: 'idle', rich: z >= 48, withBubble: z >= 48 }, z, `s-${z}`)}<span class="lbl">${z} px</span></div>`).join('')}</div>`,
  `var M=${JSON.stringify(heroMap)};var hero=document.getElementById('hero');document.querySelectorAll('.pick button').forEach(function(b){b.addEventListener('click',function(){hero.innerHTML=M[b.dataset.s];document.querySelectorAll('.pick button').forEach(function(x){x.setAttribute('aria-pressed',String(x===b))})})});`));

put('components/Faisca/README.md', `# Faisca

A Faísca é o mascote único do Aion: representa o próprio Aion na cor faisca e cada bot na cor do bot.

## O que o consumidor fornece
- \`color\`: cor do corpo. Use faisca quando for o Aion (login, Chat geral, estados vazios do app); use a cor do bot quando for um bot.
- \`state\`: idle, working, waiting, done, error ou sleep. Derive de \`mascotStateOfRunStatus\` (packages/shared/src/live-state.ts); nunca invente estado na tela.
- \`size\`: lado em px, a partir de 24. Abaixo disso use a inicial do bot.
- \`label\` opcional: sem ele a Faísca é decorativa (\`aria-hidden\`), porque o estado já está em texto ao lado.
- \`still\` em listas; \`enter\` em login e estados vazios; \`gaze\` só na conversa vazia e no login.

## Níveis de detalhe
- 48 px ou mais: pelo (filtro de deslocamento), miolo e brilho na estrela, dedinhos, ícone flutuante, movimento.
- 24 a 47 px: corpo liso, estrela com contorno de 2,6, sem ícone flutuante; o estado vai num ponto de status de 8 px no canto (cor do estado: info, warning, success, danger) ou só no texto.

## Estados
| Estado | Faísca | Rosto | Ícone flutuante |
|---|---|---|---|
| idle | amarela | sorriso | nenhum |
| working | acesa, com halo | olhar de lado, boca em o | balão com três pontos |
| waiting | laranja | sobrancelha de dúvida | disco warning com ? |
| done | brilhante | olhos ^^, bracinhos para cima | disco success com ✓ e estrelinhas |
| error | vermelha, antena caída | sobrancelhas tristes | disco danger com ! e gota |
| sleep | cinza, antena caída | olhos fechados | z subindo |

## Faça e não faça
- Faça: anime só a Faísca que está trabalhando ou esperando; as demais ficam \`still\`.
- Faça: respeite \`prefers-reduced-motion\` (tudo parado, os z ficam visíveis).
- Não faça: acessórios, roupas ou formas novas; a identidade agora é uma só.
- Não faça: trocar a cor da estrela pela cor do bot; brilho é fixo.
- Não faça: Faísca como ícone de botão ou enfeite em toda tela; ela aparece onde há um bot ou o Aion falando.
`);

// Logo
put('components/Logo/preview.html', preview('<!-- @dsCard group="Marca" height=360 subtitle="Logotipo, assinatura, área de proteção e tamanhos mínimos" -->', 'Logo',
  `.row{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.pan{border-radius:var(--radius-md,10px);display:flex;align-items:center;justify-content:center;min-height:120px;padding:12px}
.dk{background:var(--bg-app,#0e0e13);border:1px solid var(--border,#2e2e38)}.lt{background:#f6f5fa}.ink{background:${INK}}
.zone{outline:1px dashed var(--faisca-claro,#8db6fa);outline-offset:18px}
.mins{display:flex;gap:24px;align-items:flex-end;justify-content:center;margin-top:16px}
.mins div{display:flex;flex-direction:column;align-items:center;gap:4px}`,
  `<div class="row">
<div class="pan dk"><svg class="zone" viewBox="0 0 240 96" width="180" height="72" role="img" aria-label="aion">${wordmarkInner('#ECECF1')}</svg></div>
<div class="pan ink"><svg viewBox="0 0 400 128" width="230" height="74" role="img" aria-label="Aion"><defs>${furFilter('lk1')}</defs><g transform="translate(0 4)">${faiscaInner({ withBubble: false, ground: false, furId: 'lk1' })}</g><g transform="translate(140 22)">${wordmarkInner('#ECECF1')}</g></svg></div>
<div class="pan lt"><svg viewBox="0 0 400 128" width="230" height="74" role="img" aria-label="Aion"><defs>${furFilter('lk2')}</defs><g transform="translate(0 4)">${faiscaInner({ withBubble: false, ground: false, furId: 'lk2' })}</g><g transform="translate(140 22)">${wordmarkInner(INK)}</g></svg></div>
</div>
<div class="mins">
<div><svg viewBox="0 0 240 96" width="60" height="24" aria-hidden="true">${wordmarkInner('#ECECF1')}</svg><span class="lbl">Logotipo mín. 24 px</span></div>
<div><svg viewBox="-13 -13 26 26" width="16" height="16" aria-hidden="true">${sparkInner({ rich: false })}</svg><span class="lbl">Estrela mín. 16 px</span></div>
<div><svg viewBox="0 0 120 120" width="24" height="24" aria-hidden="true">${faiscaInner({ rich: false, withBubble: false, ground: false })}</svg><span class="lbl">Faísca mín. 24 px</span></div>
</div>`));
put('components/Logo/README.md', `# Logo

O logotipo é "aion" em minúsculas, traço redondo de espessura única, com a estrela da Faísca no lugar do pingo do i.

## Versões
- Logotipo claro (#ECECF1) sobre bg-app, bg-panel e tinta; logotipo tinta sobre fundos claros.
- Assinatura (Faísca à esquerda, logotipo à direita) no login, no README do repositório e em divulgação.
- Estrela sozinha onde o espaço não comporta letras: favicon, push e selos.

## Regras
- Área de proteção: a altura-x do logotipo em todos os lados (linha tracejada no preview).
- Tamanho mínimo: logotipo 24 px de altura, assinatura 32 px, estrela 16 px, Faísca 24 px.
- A estrela é sempre brilho com contorno brilho-traco, mesmo no logotipo tinta.
- Não escreva o logo com a fonte Fredoka: use o SVG. Não estique, não gire, não troque as cores do logotipo por cores de bot.
- O nome em texto corrido é "Aion", com maiúscula; o logotipo é que vai em minúsculas.
`);

// Button (variantes reais de apps/web/src/components/ui/button.tsx)
put('components/Button/preview.html', preview('<!-- @dsCard group="Controles" height=150 subtitle="primário, secundário, ghost e perigo; md 36 px, sm 32 px, ícone" -->', 'Button',
  `.r{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}
.b{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:36px;padding:0 16px;border-radius:var(--radius-md,10px);font:500 14px/20px var(--font-sans,"Inter",sans-serif);border:1px solid transparent;cursor:pointer;white-space:nowrap}
.b:focus-visible{outline:2px solid var(--focus,#8db6fa);outline-offset:2px}
.sm{height:32px;padding:0 12px}.ic{width:32px;padding:0}
.p{background:var(--action,#ececf1);color:var(--action-fg,#0e0e13)}
.s{background:var(--bg-surface,#1b1b22);color:var(--text,#ececf1);border-color:var(--border,#2e2e38)}.s:hover{background:var(--bg-surface-hover,#23232b)}
.g{background:transparent;color:var(--text-muted,#a3a3b0)}.g:hover{background:var(--bg-surface-hover,#23232b);color:var(--text,#ececf1)}
.d{background:transparent;color:var(--danger,#f87171)}.d:hover{background:var(--danger-soft,#f871711f)}
.b[disabled]{opacity:.5;pointer-events:none}`,
  `<div class="r"><button class="b p">Salvar alterações</button><button class="b s">Cancelar</button><button class="b g">Ver detalhes</button><button class="b d">Excluir bot</button></div>
<div class="r"><button class="b p sm">Aprovar</button><button class="b s sm">Negar</button><button class="b s ic" aria-label="Mais opções"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></button><button class="b s" disabled>Indisponível</button></div>`));
put('components/Button/README.md', `# Button

Botão do kit (apps/web/src/components/ui/button.tsx): primário, secundário (padrão), ghost e perigo, em md 36 px, sm 32 px e ícone 32 px (40 px de toque no celular).

- Uma ação primária por tela; o primário usa action e action-fg, não a cor faisca. O azul da marca fica para a Faísca e os links (faisca-claro), para o app continuar calmo.
- Botão só de ícone exige \`aria-label\`.
- Perigo é texto danger sem fundo; o fundo danger-soft só aparece no hover.
- Rótulos começam por verbo e não levam ponto: "Salvar alterações", "Excluir bot".
`);

// Componentes restantes do kit (comps.mjs)
for (const [name, marker, css, body, script, readme] of COMPONENTS) {
  put(`components/${name}/preview.html`, preview(`<!-- @dsCard ${marker} -->`, name, KIT + css, body, script));
  put(`components/${name}/README.md`, readme);
}

for (const [name, marker, css, body, script, readme] of APP_COMPONENTS) {
  put(`components/${name}/preview.html`, preview(`<!-- @dsCard ${marker} -->`, name, KIT + APPKIT + css, body, script));
  put(`components/${name}/README.md`, readme);
}

// Componentes das phases 3 e 4 (phase34.mjs)
for (const [name, marker, css, body, script, readme] of P34_COMPONENTS) {
  put(`components/${name}/preview.html`, preview(`<!-- @dsCard ${marker} -->`, name, KIT + APPKIT + P34_CSS + css, body, script));
  put(`components/${name}/README.md`, readme);
}

// Pranchas de movimento e estados (motion.mjs) e de fundos (bg.mjs)
for (const [name, marker, css, body, script, readme] of [...MOTION_COMPONENTS, ...BG_COMPONENTS]) {
  put(`components/${name}/preview.html`, preview(`<!-- @dsCard ${marker} -->`, name, KIT + APPKIT + css, body, script));
  put(`components/${name}/README.md`, readme);
}

// Cover
put('components/Cover/preview.html', `<!-- @dsCard height=288 -->
<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>Aion</title>${FONTS}
<style>
html,body{margin:0;height:100%}
body{background:var(--bg-app,#0e0e13);color:var(--text,#ececf1);font-family:var(--font-sans,"Inter",sans-serif);overflow:hidden}
.cover{position:relative;height:288px;width:960px;overflow:hidden}
.art{position:absolute;top:0;left:480px;width:480px;height:288px}
.faisca{fill:var(--faisca,#3b82f6)}.claro{fill:var(--faisca-claro,#8db6fa)}.suave{fill:var(--faisca-suave,#172340)}
.brilho{fill:var(--brilho,#facc15)}.bochecha{fill:var(--bochecha,#ff7aa8)}
.blk{rx:var(--radius-lg,16px)}
.words{position:absolute;left:32px;bottom:32px;max-width:440px}
.name{margin:0;font-family:var(--font-display,"Fredoka","Nunito",sans-serif);font-weight:600;font-size:120px;line-height:.92;letter-spacing:-.01em;color:var(--text,#ececf1)}
.tag{margin:8px 0 0 4px;font-size:14px;line-height:20px;color:var(--text-muted,#a3a3b0)}
</style></head>
<body>
<div class="cover">
<div class="art" aria-hidden="true">
<svg viewBox="0 0 480 288" width="480" height="288">
<!--
  blocks      faisca 160×264 sangrando pelo topo (a cor da marca, maior) · faisca-suave 128×176 · faisca-claro 96×96 · brilho 64×64 · bochecha 64×32 (pílula, uso raro)
  arrangement um bloco alto de faisca com satélites; bases alinhadas a space-8 da borda, gutters space-4
  pattern     a estrela da faísca (motivo literal da marca): cinco estrelas de quatro pontas em brilho, três sobre o bloco faisca e duas soltas, subindo como faíscas
  scales      lados múltiplos de space-8 (32); gutters space-4 (16); cantos radius-lg (16); pílula rx = metade da altura (16)
-->
<rect class="faisca blk" x="16" y="-8" width="160" height="264" rx="16"/>
<rect class="suave blk" x="192" y="80" width="128" height="176" rx="16"/>
<rect class="claro blk" x="336" y="160" width="96" height="96" rx="16"/>
<rect class="brilho blk" x="336" y="80" width="64" height="64" rx="16"/>
<rect class="bochecha" x="208" y="32" width="64" height="32" rx="16"/>
<g class="brilho">
<path transform="translate(96 200) scale(2.2)" d="M0 -11 C1.6 -3.6 3.6 -1.6 11 0 C3.6 1.6 1.6 3.6 0 11 C-1.6 3.6 -3.6 1.6 -11 0 C-3.6 -1.6 -1.6 -3.6 0 -11Z"/>
<path transform="translate(60 120) scale(1.3)" d="M0 -11 C1.6 -3.6 3.6 -1.6 11 0 C3.6 1.6 1.6 3.6 0 11 C-1.6 3.6 -3.6 1.6 -11 0 C-3.6 -1.6 -1.6 -3.6 0 -11Z"/>
<path transform="translate(128 56) scale(.8)" d="M0 -11 C1.6 -3.6 3.6 -1.6 11 0 C3.6 1.6 1.6 3.6 0 11 C-1.6 3.6 -3.6 1.6 -11 0 C-3.6 -1.6 -1.6 -3.6 0 -11Z"/>
<path transform="translate(408 40) scale(1)" d="M0 -11 C1.6 -3.6 3.6 -1.6 11 0 C3.6 1.6 1.6 3.6 0 11 C-1.6 3.6 -3.6 1.6 -11 0 C-3.6 -1.6 -1.6 -3.6 0 -11Z"/>
<path transform="translate(448 112) scale(.6)" d="M0 -11 C1.6 -3.6 3.6 -1.6 11 0 C3.6 1.6 1.6 3.6 0 11 C-1.6 3.6 -3.6 1.6 -11 0 C-3.6 -1.6 -1.6 -3.6 0 -11Z"/>
</g>
</svg>
</div>
<div class="words"><h1 class="name">Aion</h1><p class="tag">Bots que trabalham por você, com uma faísca de personalidade.</p></div>
</div>
</body>
</html>
`);

console.log('ok', OUT);

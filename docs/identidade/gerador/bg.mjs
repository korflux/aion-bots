// Fundos com profundidade: degradês sutis no lugar de superfícies 100% sólidas.
// Regra: o degradê nunca carrega informação e nunca baixa contraste de texto (alfa máximo de 12% na cor da marca);
// um grão de 3% evita faixas (banding) em telas escuras. BG_CSS entra em previews e telas junto do MOTION_CSS.
import { F, T } from './appcomps.mjs';

/** Tokens de degradê (família própria em tokens.json; valores CSS literais, sem var()). */
export const GRADIENT_TOKENS = {
  gradient: {
    note: 'Camadas de fundo. Sempre sobre a cor sólida do token correspondente; nenhuma passa de 12% de alfa na cor da marca.',
    tokens: [
      { name: 'grad-app', value: 'radial-gradient(120% 70% at 50% -20%, #3b82f61f 0%, #3b82f600 60%), linear-gradient(180deg, #11111a 0%, #0e0e13 45%)', usage: 'Fundo da página: brilho azul que cai do topo e base levemente mais clara em cima.' },
      { name: 'grad-panel', value: 'linear-gradient(180deg, #17171f 0%, #14141a 100%)', usage: 'Painel lateral, drawer e barra inferior.' },
      { name: 'grad-sheen', value: 'linear-gradient(180deg, #ffffff08 0%, #ffffff00 40%)', usage: 'Brilho de topo sobre bg-surface em cartões, modal, popover e composer.' },
      { name: 'grad-hero', value: 'radial-gradient(closest-side, #3b82f62e 0%, #818cf814 45%, #3b82f600 100%)', usage: 'Halo atrás da Faísca no Início, login, conversa vazia e telas de exceção.' },
      { name: 'grad-composer', value: 'linear-gradient(0deg, #0e0e13 55%, #0e0e1300 100%)', usage: 'Faixa sob o composer: as mensagens somem suavemente em vez de cortar.' },
    ],
  },
};

const GRAIN = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.5'/%3E%3C/svg%3E")`;
const G = Object.fromEntries(GRADIENT_TOKENS.gradient.tokens.map((t) => [t.name, `var(--${t.name},${t.value})`]));

export const BG_CSS = `
/* ===== Fundos com profundidade ===== */
.bg-app{background-color:${T.app};background-image:${G['grad-app']}}
.bg-panel{background-color:${T.panel};background-image:${G['grad-panel']}}
.sheen{background-image:${G['grad-sheen']}}
.grain{position:relative;isolation:isolate}.grain::before{content:"";position:absolute;inset:0;background-image:${GRAIN};opacity:.03;pointer-events:none;z-index:-1;mix-blend-mode:overlay}
.hero-glow{position:relative;isolation:isolate}.hero-glow::before{content:"";position:absolute;left:50%;top:50%;width:260%;aspect-ratio:1;transform:translate(-50%,-50%);background:${G['grad-hero']};z-index:-1;pointer-events:none}
.bot-glow{background-image:radial-gradient(110% 55% at 50% -15%, color-mix(in srgb,var(--bot,#3b82f6) 14%,transparent) 0%, transparent 60%),linear-gradient(180deg,#11111a 0%,#0e0e13 45%)}
.composer-fade{background:${G['grad-composer']};padding-top:20px;margin-top:-20px;position:relative}
`;

/** Aplica a camada nas classes já usadas pelas telas e pelos previews (sem mexer na marcação). */
export const BG_APPLY_CSS = `
body{background-image:${G['grad-app']};background-attachment:fixed}
.phone,.desk{background-color:${T.app};background-image:${G['grad-app']}}
.side,.tabs,.dr,.rail{background-image:${G['grad-panel']}}.rail{background-image:none}
.crd,.modal,.mod,.pop,.menu,.cmp,.apcard,.pend,.bub,.blk,.ban,.sht,.sh[role="dialog"],.toast,.tst{background-image:${G['grad-sheen']}}
`;

const box = (label, cls, style, inner = '') => `<div class="spc"><div class="${cls}" style="${style}">${inner}</div><span class="lbl2">${label}</span></div>`;

export const BG_COMPONENTS = [
  ['Backgrounds', 'group="Marca" height=880 subtitle="degradês sutis: página, painel, cartão, halo, conversa do bot e composer"',
    `.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.spc{display:flex;flex-direction:column;gap:6px}
.spc>div{height:150px;border-radius:12px;border:1px solid ${T.line};overflow:hidden;display:flex;align-items:center;justify-content:center}
.lbl2{font:500 12px/16px ${T.sans};color:${T.subtle}}.h{margin:20px 0 8px;font:600 14px/20px ${T.sans}}.h:first-child{margin-top:0}
.card{width:80%;height:70px;border-radius:12px;border:1px solid ${T.line};background-color:${T.surface};padding:10px;font-size:13px}
.msgs{width:100%;height:100%;display:flex;flex-direction:column;justify-content:flex-end;gap:6px;padding:10px}
.m{border-radius:10px;background:${T.surface};padding:4px 10px;font-size:12px;width:fit-content}.cmpb{border-radius:18px;border:1px solid ${T.line};background-color:${T.surface};padding:8px 12px;font-size:12px;color:${T.subtle}}`,
    `<p class="h">Sólido (hoje) e com degradê (proposta)</p>
<div class="pair">${box('Página · sólido', '', `background:${T.app}`)}${box('Página · grad-app + grão', 'bg-app grain', '')}${box('Painel · sólido', '', `background:${T.panel}`)}${box('Painel · grad-panel', 'bg-panel', '')}</div>
<p class="h">Cartões e camadas: brilho de topo (grad-sheen)</p>
<div class="pair">${box('Cartão sólido', '', `background:${T.app}`, '<div class="card">Rotina salva</div>')}${box('Cartão com grad-sheen', 'bg-app', '', '<div class="card sheen">Rotina salva</div>')}</div>
<p class="h">Halo da Faísca (grad-hero): Início, login, conversa vazia e exceções</p>
<div class="pair">${box('Sem halo', '', `background:${T.app}`, F(72, '#3b82f6'))}${box('Com halo', 'bg-app', '', `<div class="hero-glow">${F(72, '#3b82f6')}</div>`)}</div>
<p class="h">Conversa do bot: o brilho do topo usa a cor do bot</p>
<div class="pair">${['#60a5fa', '#4ade80', '#f472b6', '#fb923c'].map((c) => box(`bot-glow · ${c}`, 'bot-glow', `--bot:${c}`, `<div style="display:flex;flex-direction:column;align-items:center;gap:6px">${F(40, c)}<span style="font-size:12px;color:${T.muted}">Conversa</span></div>`)).join('')}</div>
<p class="h">Composer: as mensagens somem sob ele (grad-composer)</p>
<div class="pair">${box('Corte seco', '', `background:${T.app};align-items:stretch`, `<div class="msgs"><div class="m">Lê o extrato</div><div class="m" style="margin-left:auto">Somei por categoria</div><div class="cmpb">Escreva uma mensagem</div></div>`)}
${box('Com grad-composer', 'bg-app', 'align-items:stretch', `<div class="msgs"><div class="m">Lê o extrato</div><div class="m" style="margin-left:auto">Somei por categoria</div><div class="composer-fade"><div class="cmpb sheen">Escreva uma mensagem</div></div></div>`)}</div>`, '',
    `# Backgrounds

Fundos com profundidade: degradês sutis por baixo da interface, para ela não parecer chapada. Nunca carregam informação.

- Página: \`grad-app\` sobre bg-app (brilho azul de 12% caindo do topo e base levemente mais clara em cima) e um grão de 3% que evita faixas visíveis em telas escuras.
- Painel, drawer e barra inferior: \`grad-panel\`, um vertical quase imperceptível.
- Cartão, modal, popover, menu, toast e composer: \`grad-sheen\`, brilho branco de 3% no topo, como luz vindo de cima.
- Faísca em destaque (Início, login, conversa vazia, erro e 404): halo \`grad-hero\` em azul e índigo.
- Conversa de um bot: o brilho do topo usa a cor do bot a 14% (\`bot-glow\`), então cada conversa ganha um tom próprio sem mudar contraste.
- Composer: \`grad-composer\` faz as mensagens sumirem por baixo dele em vez de serem cortadas.
- Regras: o texto sempre fica sobre o token sólido (contraste medido sem o degradê); nada de degradê em botões, selos ou estados; no tema claro de materiais os degradês não se aplicam.
`],
];

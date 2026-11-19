// Sistema de movimento e estados de interação do Aion: tokens de duração e curva, hover/pressionado/foco/desabilitado,
// entradas e saídas (popover, menu, modal, drawer, bottom sheet, toast, tooltip, mensagem, cartão) e microinterações.
// MOTION_CSS entra em TODOS os previews e telas (gen.mjs e telas.mjs); REPLAY_JS acrescenta o botão "Repetir animação"
// em qualquer preview que tenha elementos com [data-anim]. Respeita prefers-reduced-motion em tudo.
import { F, T, ic } from './appcomps.mjs';

/** Tokens de movimento (entram em tokens.json como famílias próprias). */
export const MOTION_TOKENS = {
  duration: {
    note: 'Entradas usam a duração cheia; saídas usam cerca de 60% dela, porque o que some não precisa ser acompanhado.',
    tokens: [
      { name: 'dur-instant', value: '80ms', usage: 'Troca de cor no foco e no pressionado.' },
      { name: 'dur-fast', value: '120ms', usage: 'Hover de botão, linha e ícone; saída de tooltip, popover e menu.' },
      { name: 'dur-base', value: '180ms', usage: 'Entrada de popover, menu, tooltip e toast; troca de versão; selo e ponto aparecendo.' },
      { name: 'dur-slow', value: '250ms', usage: 'Entrada de modal, drawer, bottom sheet, mensagem nova e pílula da aba ativa.' },
      { name: 'dur-slower', value: '400ms', usage: 'Troca de estado da Faísca e entrada da Faísca em login e telas vazias.' },
    ],
  },
  easing: {
    note: 'Curvas como texto CSS; valores fixos, sem var().',
    tokens: [
      { name: 'ease-out', value: 'cubic-bezier(0.16, 1, 0.3, 1)', usage: 'Padrão de toda entrada e de hover.' },
      { name: 'ease-in', value: 'cubic-bezier(0.4, 0, 1, 1)', usage: 'Saídas: acelera para fora.' },
      { name: 'ease-drawer', value: 'cubic-bezier(0.32, 0.72, 0, 1)', usage: 'Drawer e bottom sheet (entrada e saída).' },
      { name: 'ease-spring', value: 'cubic-bezier(0.34, 1.56, 0.64, 1)', usage: 'Só microinterações pequenas: selo contando, ponto de não lido, check do Copiado.' },
    ],
  },
};

const M = {
  inst: 'var(--dur-instant,80ms)', fast: 'var(--dur-fast,120ms)', base: 'var(--dur-base,180ms)', slow: 'var(--dur-slow,250ms)', slower: 'var(--dur-slower,400ms)',
  out: 'var(--ease-out,cubic-bezier(.16,1,.3,1))', in: 'var(--ease-in,cubic-bezier(.4,0,1,1))', drawer: 'var(--ease-drawer,cubic-bezier(.32,.72,0,1))', spring: 'var(--ease-spring,cubic-bezier(.34,1.56,.64,1))',
};

export const MOTION_CSS = `
/* ===== Estados de interação (hover só com ponteiro fino; no toque vale o :active) ===== */
.b,.bi,.si,.hrow,.mi,.mr,.it,.ar,.rk,.tab,.nv,.li,.chip,.dl,.sw,.dy,.fp,.sg span,.trg,.a,.cbx,.in,.field,input,select,textarea,.ta,.c{transition:background-color ${M.fast} ${M.out},color ${M.fast} ${M.out},border-color ${M.fast} ${M.out},box-shadow ${M.fast} ${M.out},opacity ${M.fast} ${M.out},transform ${M.fast} ${M.out}}
.b,.bi,.si,.hrow,.mi,.mr,.it,.ar,.rk,.tab,.nv,.chip,.dl,.sw,.dy,.fp,.sg span,.trg,.a{cursor:pointer;-webkit-tap-highlight-color:transparent}
@media (hover:hover) and (pointer:fine){
.b.p:hover{background:rgb(236 236 241/.9)}.b.s:hover{background:${T.hover};border-color:${T.strong}}.b.g:hover{background:${T.hover};color:${T.fg}}.b.d:hover{background:${T.badS}}
.bi:hover,.si:hover,.hrow:hover,.mi:hover,.mr:hover,.it:hover,.rk:hover,.nv:hover,.li:hover,.trg:hover,.a:hover{background:${T.hover};color:${T.fg}}
.ar:hover{color:${T.fg}}.tab:hover{color:${T.fg}}.tab:hover .pill{background:${T.hover}}.tab.on:hover .pill{background:${T.sel}}
.chip:hover,.dl:hover{border-color:${T.strong}}.sw:hover,.c:hover{transform:scale(1.08)}.dy:hover:not(.on),.fp:hover:not(.on){border-color:${T.strong};color:${T.fg}}
.sg span:hover:not(.on){background:${T.hover};color:${T.fg}}.in:hover,.field:hover,.ta:hover,input:hover,select:hover,textarea:hover{border-color:${T.strong}}
.reveal .acts{opacity:0}.reveal:hover .acts,.reveal:focus-within .acts{opacity:1}}
.b:active,.a:active,.sw:active,.dy:active,.chip:active{transform:scale(.97);transition-duration:${M.inst}}
.bi:active,.si:active,.hrow:active,.mi:active,.mr:active,.it:active,.rk:active,.nv:active,.li:active{background:${T.sel}}
.tab:active .pill{transform:scale(.92)}
:focus-visible{outline:2px solid ${T.focus};outline-offset:2px;transition:none}
.b[disabled],.b.is-disabled,[aria-disabled="true"]{opacity:.5;cursor:not-allowed;pointer-events:none}
/* Estados forçados para as pranchas de especificação */
.b.p.is-hover{background:rgb(236 236 241/.9)}.b.s.is-hover{background:${T.hover};border-color:${T.strong}}.b.g.is-hover{background:${T.hover};color:${T.fg}}.b.d.is-hover{background:${T.badS}}
.is-press{transform:scale(.97)}.b.s.is-press{background:${T.sel}}.b.g.is-press{background:${T.sel}}.b.p.is-press{background:rgb(236 236 241/.8)}
.is-focus{outline:2px solid ${T.focus};outline-offset:2px}
.b.is-loading{color:transparent;position:relative;pointer-events:none}.b.is-loading::after{content:"";position:absolute;width:14px;height:14px;border-radius:50%;border:2px solid currentColor;border-color:${T.afg} transparent ${T.afg} ${T.afg};animation:spin .8s linear infinite}
.b.s.is-loading::after,.b.g.is-loading::after{border-color:${T.fg} transparent ${T.fg} ${T.fg}}.b.d.is-loading::after{border-color:${T.bad} transparent ${T.bad} ${T.bad}}

/* ===== Entradas e saídas: [data-anim] + [data-state=open|closed] ===== */
[data-anim="pop"]{transform-origin:top left}[data-anim="pop-r"]{transform-origin:top right}[data-anim="tip"]{transform-origin:bottom center}
[data-anim="pop"],[data-anim="pop-r"]{animation:m-pop-in ${M.base} ${M.out} both}[data-anim="pop"][data-state="closed"],[data-anim="pop-r"][data-state="closed"]{animation:m-pop-out ${M.fast} ${M.in} both}
[data-anim="tip"]{animation:m-tip-in ${M.base} ${M.out} both}[data-anim="tip"][data-state="closed"]{animation:m-fade-out ${M.fast} ${M.in} both}
[data-anim="modal"]{animation:m-modal-in ${M.slow} ${M.out} both}[data-anim="modal"][data-state="closed"]{animation:m-modal-out 150ms ${M.in} both}
[data-anim="scrim"]{animation:m-fade-in ${M.slow} ${M.out} both}[data-anim="scrim"][data-state="closed"]{animation:m-fade-out 150ms ${M.in} both}
[data-anim="drawer"]{animation:m-drawer-in ${M.slow} ${M.drawer} both}[data-anim="drawer"][data-state="closed"]{animation:m-drawer-out 200ms ${M.drawer} both}
[data-anim="drawer-r"]{animation:m-drawer-r-in ${M.slow} ${M.drawer} both}[data-anim="drawer-r"][data-state="closed"]{animation:m-drawer-r-out 200ms ${M.drawer} both}
[data-anim="sheet"]{animation:m-sheet-in ${M.slow} ${M.drawer} both}[data-anim="sheet"][data-state="closed"]{animation:m-sheet-out 200ms ${M.drawer} both}
[data-anim="toast"]{animation:m-toast-in ${M.base} ${M.out} both}[data-anim="toast"][data-state="closed"]{animation:m-toast-out ${M.fast} ${M.in} both}
[data-anim="dialog"]{animation:m-dialog-in ${M.slow} ${M.out} both}[data-anim="dialog"][data-state="closed"]{animation:m-pop-out 150ms ${M.in} both}
@keyframes m-dialog-in{from{opacity:0;transform:translateY(8px) scale(.96)}}
[data-anim="msg"]{animation:m-msg-in ${M.slow} ${M.out} both}[data-anim="card"]{animation:m-card-in ${M.base} ${M.out} both}
[data-anim="fade"]{animation:m-fade-in ${M.base} ${M.out} both}[data-anim="fade"][data-state="closed"]{animation:m-fade-out ${M.fast} ${M.in} both}
@keyframes m-pop-in{from{opacity:0;transform:scale(.96) translateY(-4px)}}@keyframes m-pop-out{to{opacity:0;transform:scale(.97)}}
@keyframes m-tip-in{from{opacity:0;transform:translateY(2px) scale(.97)}}@keyframes m-fade-in{from{opacity:0}}@keyframes m-fade-out{to{opacity:0}}
@keyframes m-modal-in{from{opacity:0;transform:translate(-50%,-48%) scale(.96)}to{transform:translate(-50%,-50%)}}
@keyframes m-modal-out{from{transform:translate(-50%,-50%)}to{opacity:0;transform:translate(-50%,-50%) scale(.97)}}
@keyframes m-drawer-in{from{transform:translateX(-100%)}}@keyframes m-drawer-out{to{transform:translateX(-100%)}}
@keyframes m-drawer-r-in{from{transform:translateX(100%)}}@keyframes m-drawer-r-out{to{transform:translateX(100%)}}
@keyframes m-sheet-in{from{transform:translateY(100%)}}@keyframes m-sheet-out{to{transform:translateY(100%)}}
@keyframes m-toast-in{from{opacity:0;transform:translateY(12px) scale(.98)}}@keyframes m-toast-out{to{opacity:0;transform:translateX(24px)}}
@keyframes m-msg-in{from{opacity:0;transform:translateY(8px)}}@keyframes m-card-in{from{opacity:0;transform:translateY(4px)}}

/* ===== Microinterações ===== */
.m-bump{animation:m-bump 300ms ${M.spring}}@keyframes m-bump{40%{transform:scale(1.3)}}
.m-dot{animation:m-dot ${M.base} ${M.spring} both}@keyframes m-dot{from{transform:scale(0)}}
.m-check{animation:m-check ${M.base} ${M.spring} both}@keyframes m-check{from{transform:scale(.4);opacity:0}}
.m-pill{animation:m-pill ${M.slow} ${M.out} both}@keyframes m-pill{from{transform:scaleX(.5);opacity:.4}}
.m-next{animation:m-next ${M.base} ${M.out} both}@keyframes m-next{from{opacity:0;transform:translateX(12px)}}
.m-prev{animation:m-prev ${M.base} ${M.out} both}@keyframes m-prev{from{opacity:0;transform:translateX(-12px)}}
.m-swap{animation:m-swap ${M.slower} ${M.out} both}@keyframes m-swap{from{opacity:0;transform:scale(.92)}}
.m-shimmer{background:linear-gradient(90deg,${T.surface} 0%,${T.hover} 50%,${T.surface} 100%);background-size:200% 100%;animation:m-shimmer 1.4s linear infinite}@keyframes m-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}
.trk i{transition:left ${M.base} ${M.out},background-color ${M.base} ${M.out}}.trk{transition:background-color ${M.base} ${M.out},border-color ${M.base} ${M.out}}

/* ===== Botão de repetir (só nas pranchas) ===== */
.replay{position:fixed;right:12px;bottom:12px;z-index:50;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:999px;border:1px solid ${T.strong};background:${T.surface};color:${T.fg};font:500 13px/1 ${T.sans};cursor:pointer;box-shadow:0 8px 24px rgb(0 0 0/.4)}

@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
`;

/** Botão "Repetir animação": fecha e reabre todo [data-anim] da prancha. */
export const REPLAY_JS = `(function(){var els=document.querySelectorAll('[data-anim]');if(!els.length)return;var b=document.createElement('button');b.type='button';b.className='replay';b.textContent='Repetir animação';
b.addEventListener('click',function(){els.forEach(function(e){e.setAttribute('data-state','closed')});setTimeout(function(){els.forEach(function(e){e.removeAttribute('data-state');void e.offsetWidth;e.setAttribute('data-state','open')})},420)});document.body.appendChild(b)})();`;

// ---------- pranchas ----------
const btnRow = (v, label) => `<tr><th>${label}</th>${['', 'is-hover', 'is-press', 'is-focus', 'is-disabled', 'is-loading'].map((s) => `<td><span class="b ${v} sm ${s}">${v === 'g' ? 'Ver detalhes' : v === 'd' ? 'Excluir' : v === 'p' ? 'Salvar' : 'Cancelar'}</span></td>`).join('')}</tr>`;
const rowState = (cls, style, label) => `<div class="bi ${cls}" style="${style}">${F(24, '#60a5fa')}<div class="t"><div class="n">Resumo das manhãs</div><div class="s muted">${label}</div></div></div>`;

export const MOTION_COMPONENTS = [
  ['InteractionStates', 'group="Movimento e estados" height=760 subtitle="repouso, hover, pressionado, foco, desabilitado e carregando"',
    `.st{width:100%;border-collapse:collapse;font-size:12px}.st th{padding:6px 8px;text-align:left;font-weight:500;color:${T.subtle};white-space:nowrap}.st td{padding:6px 8px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}.cell{display:flex;flex-direction:column;gap:6px}.cl{font:500 12px/16px ${T.sans};color:${T.subtle}}
.bi{display:flex;align-items:center;gap:8px;height:44px;padding:0 12px;border-radius:6px}.bi .t{flex:1}.bi .n{font:500 14px/20px ${T.sans}}.bi .s{font:500 12px/16px ${T.sans}}
.in{height:36px;display:flex;align-items:center;border-radius:10px;border:1px solid ${T.strong};background:${T.surface};padding:0 12px;font-size:14px}
.trk{position:relative;display:inline-block;width:36px;height:20px;border-radius:999px;border:1px solid ${T.strong};background:${T.sel}}.trk i{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:${T.muted}}.trk.on{background:${T.action};border-color:transparent}.trk.on i{left:18px;background:${T.afg}}
.tabd{display:flex;flex-direction:column;align-items:center;gap:2px;font:500 11px/14px ${T.sans};color:${T.muted};width:72px}.tabd .pill{width:52px;height:28px;border-radius:999px;display:grid;place-items:center}`,
    `<p class="cl" style="margin:0 0 8px">Botões (passe o mouse e clique para ver ao vivo; a tabela força cada estado)</p>
<div style="overflow-x:auto"><table class="st"><tr><th></th><th>Repouso</th><th>Hover</th><th>Pressionado</th><th>Foco</th><th>Desabilitado</th><th>Carregando</th></tr>${btnRow('p', 'Primário')}${btnRow('s', 'Secundário')}${btnRow('g', 'Ghost')}${btnRow('d', 'Perigo')}</table></div>
<div class="grid" style="margin-top:20px">
<div class="cell"><span class="cl">Linha de lista</span>${rowState('', '', 'Repouso')}${rowState('', `background:${T.hover}`, 'Hover')}${rowState('', `background:${T.sel}`, 'Pressionado e ativo')}${rowState('is-focus', '', 'Foco (teclado)')}</div>
<div class="cell"><span class="cl">Campo</span><div class="in" style="color:${T.subtle}">Repouso</div><div class="in" style="border-color:${T.strong};color:${T.subtle}">Hover</div><div class="in is-focus">Foco</div><div class="in" style="border-color:${T.bad}">Erro</div><div class="in" style="opacity:.5">Desabilitado</div></div>
<div class="cell"><span class="cl">Interruptor (clique)</span><span class="row" style="gap:16px"><button class="sw-live" role="switch" aria-checked="false" style="all:unset;cursor:pointer"><span class="trk"><i></i></span></button><span class="trk on"><i></i></span><span class="trk is-focus"><i></i></span><span class="trk" style="opacity:.5"><i></i></span></span>
<span class="cl" style="margin-top:12px">Aba da barra inferior</span><span class="row" style="gap:4px"><span class="tabd"><span class="pill">${ic('chat', 's18')}</span>Repouso</span><span class="tabd" style="color:${T.fg}"><span class="pill" style="background:${T.hover}">${ic('chat', 's18')}</span>Hover</span><span class="tabd" style="color:${T.fg}"><span class="pill" style="background:${T.sel}">${ic('home', 's18')}</span>Ativa</span><span class="tabd"><span class="pill" style="transform:scale(.92);background:${T.sel}">${ic('cal', 's18')}</span>Toque</span></span></div>
</div>`,
    `document.querySelectorAll('.sw-live').forEach(function(b){b.addEventListener('click',function(){var on=b.getAttribute('aria-checked')!=='true';b.setAttribute('aria-checked',String(on));b.firstElementChild.classList.toggle('on',on)})});`,
    `# InteractionStates

Prancha de estados de interação, válida para todos os componentes.

- Hover: só com ponteiro fino (\`@media (hover:hover) and (pointer:fine)\`); muda fundo para bg-surface-hover e texto para text, em dur-fast com ease-out. No toque não há hover: vale o pressionado.
- Pressionado: botões e alvos de toque escalam para 0,97 em dur-instant; linhas vão para bg-selected; a pílula da aba encolhe para 0,92.
- Foco: anel focus de 2 px a 2 px de distância, sempre visível no teclado, sem transição (aparece na hora).
- Desabilitado: 50% de opacidade, sem hover nem clique, com o motivo no tooltip quando houver.
- Carregando: o rótulo some e um spinner ocupa o lugar, mantendo a largura do botão (nada pula).
- Erro em campo: borda danger, mensagem abaixo.
`],

  ['MotionPlayground', 'group="Movimento e estados" height=900 subtitle="entradas, saídas e microinterações ao vivo"',
    `.board{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.demo{position:relative;min-height:190px;border-radius:12px;border:1px solid ${T.line};background:${T.app};overflow:hidden;padding:12px;display:flex;flex-direction:column;gap:8px}
.demo h4{margin:0;font:500 13px/18px ${T.sans};color:${T.fg}}.demo .why{margin:0;font-size:12px;line-height:16px;color:${T.subtle}}.demo .ctl{margin-top:auto;display:flex;gap:6px;flex-wrap:wrap}
.pop{position:absolute;left:12px;top:72px;width:200px;padding:4px;border-radius:10px;border:1px solid ${T.line};background:${T.surface};box-shadow:0 8px 24px rgb(0 0 0/.4);z-index:2}
.pop .mi{display:flex;align-items:center;height:32px;padding:0 8px;border-radius:6px;font-size:13px}
.scrim{position:absolute;inset:0;background:rgb(0 0 0/.6);z-index:3}.mod{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:200px;padding:14px;border-radius:14px;border:1px solid ${T.line};background:${T.surface};z-index:4;font-size:13px}
.drw{position:absolute;left:0;top:0;bottom:0;width:150px;background:${T.panel};border-right:1px solid ${T.line};z-index:4;padding:12px;font-size:13px}
.sht{position:absolute;left:0;right:0;bottom:0;height:62%;background:${T.surface};border-top:1px solid ${T.line};border-radius:16px 16px 0 0;z-index:4;padding:8px 12px;font-size:13px}.sht .grab{width:32px;height:4px;border-radius:999px;background:${T.strong};margin:0 auto 8px}
.tst{position:absolute;right:12px;bottom:56px;display:flex;align-items:center;gap:8px;border-radius:10px;border:1px solid ${T.line};background:${T.surface};padding:8px 10px;font-size:13px;box-shadow:0 8px 24px rgb(0 0 0/.4);z-index:4}
.feed{display:flex;flex-direction:column;gap:6px;overflow:hidden;max-height:120px;justify-content:flex-end}.me{margin-left:auto;border-radius:12px;background:${T.surface};padding:4px 10px;font-size:13px}
.bub{border-radius:12px;border:1px solid ${T.line};background:${T.panel};padding:4px 10px;font-size:13px;width:fit-content}
.cf{border-left:3px solid ${T.ok};border-radius:8px;background:${T.surface};padding:6px 10px;font-size:12px}
.tabs{display:grid;grid-template-columns:repeat(4,1fr);border-top:1px solid ${T.line};background:${T.panel};margin:0 -12px -12px;height:56px}
.tab{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font:500 10px/12px ${T.sans};color:${T.muted};border:0;background:none;cursor:pointer}.tab.on{color:${T.fg}}
.tab .pill{position:relative;width:46px;height:26px;border-radius:999px;display:grid;place-items:center}.tab.on .pill{background:${T.sel}}
.bdg{position:absolute;top:-3px;right:4px;min-width:15px;height:15px;border-radius:999px;background:${T.warn};color:${T.afg};font:600 10px/15px ${T.sans};text-align:center;padding:0 3px}
.unr{width:8px;height:8px;border-radius:50%;background:${T.info};display:inline-block}
.ver{display:inline-flex;align-items:center;gap:4px;font:500 12px/16px ${T.sans};color:${T.muted}}.ver button{all:unset;cursor:pointer;width:24px;height:24px;display:grid;place-items:center;border-radius:6px}.ver button:hover{background:${T.hover}}
.skl{height:12px;border-radius:6px;margin-bottom:6px}
.trk{position:relative;display:inline-block;width:36px;height:20px;border-radius:999px;border:1px solid ${T.strong};background:${T.sel}}.trk i{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:${T.muted}}.trk.on{background:${T.action};border-color:transparent}.trk.on i{left:18px;background:${T.afg}}`,
    `<div class="board">
<div class="demo" id="d-pop"><h4>Popover e menu</h4><p class="why">Entra com escala 0,96 e 4 px a partir do gatilho em dur-base; sai em dur-fast acelerando.</p><div class="ctl"><button class="b s sm" data-open="pop">Abrir ou fechar menu</button></div></div>
<div class="demo" id="d-mod"><h4>Modal</h4><p class="why">Véu escurece em 250 ms; o diálogo sobe 2% e cresce de 0,96. Sai em 150 ms.</p><div class="ctl"><button class="b s sm" data-open="mod">Abrir modal</button></div></div>
<div class="demo" id="d-drw"><h4>Drawer lateral</h4><p class="why">Desliza da borda em 250 ms com a curva do drawer; sai em 200 ms.</p><div class="ctl"><button class="b s sm" data-open="drw">Abrir drawer</button></div></div>
<div class="demo" id="d-sht"><h4>Bottom sheet</h4><p class="why">Sobe do rodapé em 250 ms; no celular substitui popovers grandes.</p><div class="ctl"><button class="b s sm" data-open="sht">Abrir sheet</button></div></div>
<div class="demo" id="d-tst"><h4>Toast</h4><p class="why">Sobe 12 px e aparece em 180 ms; sai para a direita. Sucesso some em 4 s; erro fica até fechar.</p><div class="ctl"><button class="b s sm" id="b-tst">Mostrar toast</button></div></div>
<div class="demo"><h4>Mensagem e cartão chegando</h4><p class="why">Mensagem nova sobe 8 px em 250 ms; cartão de sistema 4 px em 180 ms.</p><div class="feed" id="feed"><div class="me">Resume os e-mails de hoje.</div></div><div class="ctl"><button class="b s sm" id="b-msg">Chegar resposta</button><button class="b s sm" id="b-card">Chegar cartão</button></div></div>
<div class="demo"><h4>Copiar</h4><p class="why">Copy vira Check com mola em 180 ms e "Copiado" por 2 s; volta sem animação.</p><div class="ctl"><button class="b g sm" id="b-copy"><svg class="i s14" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Copiar</span></button></div></div>
<div class="demo"><h4>Selo e não lido</h4><p class="why">O contador pula com mola ao mudar; o ponto azul nasce de escala 0. Sem loop.</p><div class="row" style="gap:16px;font-size:13px"><span>Aprovações <span class="bdg" id="cnt" style="position:static;display:inline-block">1</span></span><span id="unr-wrap">Conteúdo</span></div><div class="ctl"><button class="b s sm" id="b-cnt">Nova aprovação</button><button class="b s sm" id="b-unr">Chegar novidade</button></div></div>
<div class="demo"><h4>Troca de versão</h4><p class="why">O conteúdo desliza 12 px na direção da seta em 180 ms.</p><div class="bub" id="vtxt">Entre abril e junho: menos chuva.</div><span class="ver"><button id="v-prev" aria-label="Versão anterior">‹</button><span id="vlab">2/2</span><button id="v-next" aria-label="Próxima versão">›</button></span></div>
<div class="demo"><h4>Faísca mudando de estado</h4><p class="why">Troca com fade e escala de 0,92 em 400 ms; o movimento contínuo de cada estado segue depois.</p><div id="fx" style="display:flex;justify-content:center">${F(72, '#60a5fa', 'idle')}</div><div class="ctl"><button class="b s sm" id="b-fx">Próximo estado</button></div></div>
<div class="demo"><h4>Carregando para conteúdo</h4><p class="why">Esqueleto com brilho passando; o conteúdo entra com fade em 180 ms, sem pular de altura.</p><div id="sk"><div class="skl m-shimmer" style="width:80%"></div><div class="skl m-shimmer" style="width:55%"></div></div><div class="ctl"><button class="b s sm" id="b-sk">Carregar</button></div></div>
<div class="demo"><h4>Barra inferior e interruptor</h4><p class="why">A pílula da aba nasce do centro em 250 ms; o polegar do interruptor desliza em 180 ms.</p><button class="sw-live" role="switch" aria-checked="false" style="all:unset;cursor:pointer;width:fit-content"><span class="trk"><i></i></span></button><nav class="tabs" id="tabs" style="margin-top:auto">${[['home', 'Início'], ['chat', 'Chats'], ['cal', 'Rotinas'], ['shield', 'Aprovações']].map(([i, l], n) => `<button class="tab${n === 0 ? ' on' : ''}"><span class="pill">${ic(i, 's18')}</span>${l}</button>`).join('')}</nav></div>
</div>`,
    `(function(){
var FX=${JSON.stringify(['idle', 'working', 'waiting', 'done', 'error', 'sleep'].map((s) => F(72, '#60a5fa', s)))};
function overlay(box,html){var ex=box.querySelectorAll('[data-anim]');if(ex.length){ex.forEach(function(e){e.setAttribute('data-state','closed')});setTimeout(function(){ex.forEach(function(e){e.remove()})},260);return}box.insertAdjacentHTML('beforeend',html);box.querySelectorAll('[data-anim]').forEach(function(e){e.addEventListener('click',function(ev){if(ev.target.closest('[data-close]'))overlay(box)})})}
var H={pop:'<div class="pop" data-anim="pop" role="menu"><div class="mi">Editar bot</div><div class="mi">Rotinas</div><div class="mi" style="color:${T.bad}">Excluir bot</div></div>',
mod:'<div class="scrim" data-anim="scrim" data-close></div><div class="mod" data-anim="modal" role="dialog"><b>Excluir este arquivo?</b><p style="margin:6px 0 10px;color:${T.muted}">Não há como desfazer.</p><button class="b s sm" data-close>Cancelar</button></div>',
drw:'<div class="scrim" data-anim="scrim" data-close></div><nav class="drw" data-anim="drawer">Menu<br><span style="color:${T.muted}">Toque fora para fechar</span></nav>',
sht:'<div class="scrim" data-anim="scrim" data-close></div><div class="sht" data-anim="sheet"><div class="grab"></div>Selecionar modelo<br><span style="color:${T.muted}">Toque fora para fechar</span></div>'};
document.querySelectorAll('[data-open]').forEach(function(b){b.addEventListener('click',function(){var k=b.getAttribute('data-open');overlay(b.closest('.demo'),H[k])})});
document.getElementById('b-tst').addEventListener('click',function(){var box=this.closest('.demo');box.insertAdjacentHTML('beforeend','<div class="tst" data-anim="toast">${'✓'} Rotina salva</div>');var t=box.lastElementChild;setTimeout(function(){t.setAttribute('data-state','closed');setTimeout(function(){t.remove()},200)},2200)});
var feed=document.getElementById('feed');
document.getElementById('b-msg').addEventListener('click',function(){feed.insertAdjacentHTML('beforeend','<div class="bub" data-anim="msg">Três pedem resposta hoje.</div>')});
document.getElementById('b-card').addEventListener('click',function(){feed.insertAdjacentHTML('beforeend','<div class="cf" data-anim="card">Rotina “Resumo das 9h” concluída</div>')});
var cp=document.getElementById('b-copy'),cpHtml=cp.innerHTML,cpT;cp.addEventListener('click',function(){clearTimeout(cpT);cp.innerHTML='<svg class="i s14 m-check" viewBox="0 0 24 24" style="color:${T.ok}"><path d="M20 6 9 17l-5-5"/></svg><span style="color:${T.ok}">Copiado</span>';cpT=setTimeout(function(){cp.innerHTML=cpHtml},2000)});
var cnt=document.getElementById('cnt'),n=1;document.getElementById('b-cnt').addEventListener('click',function(){n++;cnt.textContent=n>9?'9+':n;cnt.classList.remove('m-bump');void cnt.offsetWidth;cnt.classList.add('m-bump')});
document.getElementById('b-unr').addEventListener('click',function(){var w=document.getElementById('unr-wrap'),d=w.querySelector('.unr');if(d){d.remove();return}w.insertAdjacentHTML('beforeend',' <span class="unr m-dot"></span>')});
var vs=['Entre março e maio: dias firmes.','Entre abril e junho: menos chuva.'],vi=1,vt=document.getElementById('vtxt'),vl=document.getElementById('vlab');
function go(d){var ni=vi+d;if(ni<0||ni>1)return;vi=ni;vt.textContent=vs[vi];vl.textContent=(vi+1)+'/2';vt.className='bub '+(d>0?'m-next':'m-prev')}
document.getElementById('v-prev').addEventListener('click',function(){go(-1)});document.getElementById('v-next').addEventListener('click',function(){go(1)});
var fi=0,fx=document.getElementById('fx');document.getElementById('b-fx').addEventListener('click',function(){fi=(fi+1)%FX.length;fx.innerHTML=FX[fi];fx.firstElementChild.classList.add('m-swap')});
document.getElementById('b-sk').addEventListener('click',function(){var s=document.getElementById('sk');s.innerHTML='<div class="skl m-shimmer" style="width:80%"></div><div class="skl m-shimmer" style="width:55%"></div>';setTimeout(function(){s.innerHTML='<div data-anim="fade" style="font-size:13px">3 rotinas ativas · próxima às 21:00</div>'},900)});
document.querySelectorAll('#tabs .tab').forEach(function(t){t.addEventListener('click',function(){document.querySelectorAll('#tabs .tab').forEach(function(x){x.classList.remove('on');x.querySelector('.pill').classList.remove('m-pill')});t.classList.add('on');t.querySelector('.pill').classList.add('m-pill')})});
document.querySelectorAll('.sw-live').forEach(function(b){b.addEventListener('click',function(){var on=b.getAttribute('aria-checked')!=='true';b.setAttribute('aria-checked',String(on));b.firstElementChild.classList.toggle('on',on)})});
})();`,
    `# MotionPlayground

Movimento do Aion, ao vivo. Regra geral: entrar devagar o bastante para ser acompanhado, sair rápido; nada anima em loop além da Faísca trabalhando.

| Elemento | Entrada | Saída |
|---|---|---|
| Popover, menu | escala 0,96 + 4 px, dur-base, ease-out, a partir do gatilho | escala 0,97 + fade, dur-fast, ease-in |
| Tooltip | 2 px + fade, dur-base, após 400 ms de hover ou foco | fade, dur-fast |
| Modal | véu fade 250 ms; diálogo 0,96 → 1 subindo 2%, dur-slow | 150 ms, ease-in |
| Drawer, bottom sheet | desliza da borda, dur-slow, ease-drawer | 200 ms, ease-drawer |
| Toast | sobe 12 px, dur-base | desliza 24 px para a direita, dur-fast; sucesso fecha em 4 s, erro só ao fechar |
| Mensagem nova | sobe 8 px, dur-slow | — |
| Cartão de sistema | sobe 4 px, dur-base | — |
| Conteúdo após carregar | fade, dur-base, sem mudar a altura reservada pelo esqueleto | — |

Microinterações: selo contando pula com ease-spring; ponto de não lido nasce de escala 0; Check do Copiado com mola; pílula da aba ativa nasce do centro; troca de versão desliza 12 px na direção da seta; Faísca troca de estado com fade e escala em dur-slower.

Com \`prefers-reduced-motion\`, todas as durações caem para quase zero: a interface muda de estado sem animar.
`],
];

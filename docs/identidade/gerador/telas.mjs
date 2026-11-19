// Telas redesenhadas do Aion (phase 5), em HTML estático: celular (380 px) e desktop (1280 px, reduzido para caber).
// Cada tela marca a origem dos elementos novos com chips "phase 3", "phase 4" e "phase 5", para a implementação saber de onde vem cada peça.
// Gera docs/identidade/telas/*.html. Rodar: node docs/identidade/gerador/telas.mjs (depois de gen.mjs).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { APPKIT, CARD_CSS, F, T, card, ic } from './appcomps.mjs';
import { wordmarkInner, sparkInner } from './faisca.mjs';
import { renderRestantes, RESTANTES_CSS } from './telas-restantes.mjs';
import { MOTION_CSS, REPLAY_JS } from './motion.mjs';
import { BG_APPLY_CSS, BG_CSS } from './bg.mjs';

const OUT = new URL('../telas/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(OUT, { recursive: true });

// ---------- ícones extras desta camada ----------
const X = {
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  wrap: '<path d="M3 6h18M3 12h15a3 3 0 1 1 0 6h-4M3 18h7"/><path d="m16 16-2 2 2 2"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
  chevL: '<path d="m15 18-6-6 6-6"/>', chevR: '<path d="m9 18 6-6-6-6"/>', back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>', code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', reply: '<path d="M9 17 4 12l5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
};
const ix = (n, style = '') => `<svg class="i" viewBox="0 0 24 24"${style ? ` style="${style}"` : ''} aria-hidden="true">${X[n]}</svg>`;
const BOT = '#60a5fa';
const BRAND = '#3b82f6';
const wm = (h = 22) => `<svg viewBox="0 0 240 96" width="${Math.round((240 * h) / 96)}" height="${h}" role="img" aria-label="aion">${wordmarkInner('#ECECF1')}</svg>`;
const star = (s = 18) => `<svg viewBox="-13 -13 26 26" width="${s}" height="${s}" role="img" aria-label="Aion">${sparkInner({ rich: false })}</svg>`;
const tag = (p) => `<span class="ph-tag ph${p}" title="Entra na phase ${p}">phase ${p}</span>`;

// ---------- CSS das telas ----------
const SCREEN_CSS = `${APPKIT}${CARD_CSS}
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;padding:24px 16px 64px;background:#08080b;color:${T.fg};font:15px/24px ${T.sans}}
main{max-width:1400px;margin:0 auto}h1.pg{font:600 22px/30px ${T.sans};margin:0 0 4px}.lead{color:${T.muted};margin:0 0 8px;max-width:80ch}
.legend{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 24px;font-size:13px;color:${T.muted};align-items:center}
.ph-tag{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:999px;font:600 10px/1 ${T.sans};letter-spacing:.02em;vertical-align:middle;margin-left:6px;white-space:nowrap}
.ph3{background:#2dd4bf26;color:#5eead4}.ph4{background:#f472b626;color:#f9a8d4}.ph5{background:#facc1526;color:#fde047}
h2.st{font:600 17px/24px ${T.sans};margin:40px 0 4px}.sub{color:${T.muted};font-size:14px;line-height:20px;margin:0 0 16px;max-width:90ch}
.pair{display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start}
.cap2{font:500 12px/16px ${T.sans};color:${T.subtle};margin:0 0 6px}
/* Celular */
.phone{width:380px;height:780px;border-radius:40px;border:10px solid #000;outline:1px solid ${T.line};background:${T.app};overflow:hidden;display:flex;flex-direction:column;position:relative;flex:none}
.sbar{height:28px;flex:none;display:flex;justify-content:space-between;align-items:center;padding:0 22px;font:600 12px/1 ${T.sans};color:${T.fg}}
.mh{height:52px;flex:none;display:flex;align-items:center;gap:8px;padding:0 8px;border-bottom:1px solid ${T.line}}
.mh .tt{flex:1;min-width:0;font:500 14px/20px ${T.sans};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:8px}
.scroll{flex:1;min-height:0;overflow:hidden;padding:12px}
.tabs{flex:none;height:64px;display:grid;grid-template-columns:repeat(4,1fr);border-top:1px solid ${T.line};background:${T.panel};padding-bottom:4px}
.tab{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font:500 11px/14px ${T.sans};color:${T.muted}}.tab.on{color:${T.fg}}
.pill{position:relative;width:52px;height:28px;border-radius:999px;display:grid;place-items:center}.tab.on .pill{background:${T.sel}}
.bdg{position:absolute;top:-2px;right:6px;min-width:16px;height:16px;border-radius:999px;background:${T.warn};color:${T.afg};font:600 11px/16px ${T.sans};text-align:center;padding:0 4px}
.unr{width:8px;height:8px;border-radius:50%;background:${T.info};flex:none}.pill .unr{position:absolute;top:0;right:10px;box-shadow:0 0 0 2px ${T.panel}}
/* Desktop: desenhado a 1280 × 800 e reduzido */
.desk-wrap{width:832px;height:520px;flex:none;border-radius:12px;outline:1px solid ${T.line};overflow:hidden}
.desk{width:1280px;height:800px;transform:scale(.65);transform-origin:0 0;display:flex;background:${T.app}}
.rail{width:56px;flex:none;display:flex;flex-direction:column;align-items:center;gap:4px;padding:12px 0}
.rk{position:relative;width:40px;height:40px;border-radius:10px;display:grid;place-items:center;color:${T.muted}}.rk.on{background:${T.sel};color:${T.fg}}
.rk .unr{position:absolute;top:4px;right:4px;box-shadow:0 0 0 2px ${T.app}}.rk .bdg{top:2px;right:2px}
.side{width:264px;flex:none;background:${T.panel};border-right:1px solid ${T.line};display:flex;flex-direction:column}
.sh{height:52px;display:flex;align-items:center;justify-content:space-between;padding:0 8px 0 16px;font:500 14px/20px ${T.sans}}
.bl{list-style:none;margin:0;padding:0 8px;display:flex;flex-direction:column;gap:2px}
.bi{display:flex;align-items:center;gap:8px;height:44px;padding:0 12px;border-radius:6px}.bi.on{background:${T.sel}}.bi .t{flex:1;min-width:0}
.bi .n{font:500 14px/20px ${T.sans};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bi .s{font:500 12px/16px ${T.sans};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.si{display:flex;flex-direction:column;gap:2px;padding:8px 12px;border-radius:6px;font-size:14px;color:${T.muted}}.si.on{background:${T.sel};color:${T.fg};font-weight:500}.si .r1{display:flex;align-items:center;gap:8px}.si .r1 span{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.content{flex:1;min-width:0;display:flex;flex-direction:column}
.ch{height:52px;flex:none;display:flex;align-items:center;gap:12px;padding:0 24px}.ch h3{flex:1;min-width:0;margin:0;font:500 14px/20px ${T.sans}}
.thread{flex:1;min-height:0;overflow:hidden;padding:16px 24px}
.col{max-width:760px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
/* Conversa */
.me{margin-left:auto;max-width:80%;border-radius:16px;background:${T.surface};padding:8px 16px;font-size:15px;line-height:24px;white-space:pre-wrap}
.mewrap{margin-left:auto;max-width:80%;display:flex;flex-direction:column;align-items:flex-end;gap:4px}.mewrap .me{max-width:100%;margin:0}
.br{display:flex;gap:8px}.br .mk{width:24px;flex:none}.br .bc{min-width:0;flex:1;display:flex;flex-direction:column;gap:6px}
.bub{width:fit-content;max-width:100%;border-radius:16px;border:1px solid ${T.line};background:${T.panel};padding:8px 16px;font-size:15px;line-height:24px}
.bub p{margin:0}.bub p+p,.bub ul,.bub .blk,.bub .png,.bub .dl{margin-top:12px}.bub ul{padding-left:22px;margin-bottom:0}
.acts{display:flex;align-items:center;gap:2px;color:${T.muted};font-size:12px;line-height:16px}.acts .a{width:32px;height:32px;display:grid;place-items:center;border-radius:10px}
.acts .a.hv{background:${T.hover};color:${T.fg}}.acts .mdl{margin-left:6px;color:${T.subtle};font:12px ${T.mono}}
.ver{display:inline-flex;align-items:center;gap:2px;font:500 12px/16px ${T.sans};color:${T.muted}}.ver .a{width:28px}
.blk{border:1px solid ${T.line};border-radius:10px;background:${T.surface};overflow:hidden}
.blk .bh{height:32px;display:flex;align-items:center;gap:8px;padding:0 4px 0 12px;border-bottom:1px solid ${T.line};font:12px ${T.mono};color:${T.muted}}.blk .bh span{flex:1}
.blk .bh .b{height:26px;padding:0 8px;font-size:12px;gap:4px;color:${T.muted}}.blk pre{margin:0;padding:12px 16px;font:13px/20px ${T.mono};color:${T.fg};overflow:hidden;white-space:pre}
.kw{color:#c4b5fd}.st2{color:#86efac}.cm{color:${T.subtle}}.nu{color:#fcd34d}
.work{display:flex;align-items:center;gap:8px;height:40px;color:${T.muted};font-size:14px}
.ar{display:flex;align-items:center;gap:8px;min-height:28px;font-size:14px;line-height:20px;color:${T.muted}}.ar .l{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.det{display:flex;flex-direction:column;gap:8px;padding:6px 0 4px 24px}.lab{margin:0 0 4px;font:500 12px/16px ${T.sans};color:${T.subtle}}
.out{margin:0;border-radius:6px;background:${T.surface};padding:8px;font:13px/20px ${T.mono};color:${T.muted};white-space:pre-wrap}
.png{border-radius:10px;border:1px solid ${T.line};background:#f8fafc;padding:12px;max-width:420px}
.dl{display:flex;align-items:center;gap:10px;height:48px;max-width:420px;border-radius:10px;border:1px solid ${T.line};background:${T.hover};padding:0 8px 0 12px;font-size:14px}
.cmp{flex:none;margin:8px 12px 12px;border-radius:24px;border:1px solid ${T.line};background:${T.surface};padding:10px 12px;display:flex;flex-direction:column;gap:6px}
.cmp .tx{font-size:15px;line-height:24px;color:${T.subtle};min-height:24px}.cmp .tx.f{color:${T.fg}}
.cmp .tb{display:flex;align-items:center;gap:6px}.cmp .trg{display:flex;align-items:center;gap:4px;height:32px;padding:0 6px;border-radius:10px;font-size:13px;color:${T.muted};white-space:nowrap}
.cmp .ed{display:flex;align-items:center;gap:8px;font-size:12px;color:${T.info}}
.compl{display:inline-flex;align-items:center;gap:4px;font:500 12px/16px ${T.sans};color:${T.muted}}
.home h2{margin:0;font:600 24px/30px ${T.disp}}.hrow{display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:10px}.hrow .t{flex:1;min-width:0}
.hrow .n{font:500 14px/20px ${T.sans};display:flex;align-items:center;gap:6px}.hrow .s{font-size:12px;line-height:16px;color:${T.muted};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.secth{display:flex;align-items:center;justify-content:space-between;margin:16px 4px 4px;font:500 12px/16px ${T.sans};color:${T.muted}}
.apcard{display:flex;align-items:center;gap:10px;border-radius:12px;border:1px solid ${T.warn};background:${T.surface};padding:10px 12px;font-size:13px;line-height:18px}
.empty{display:flex;flex-direction:column;align-items:center;gap:12px;text-align:center;padding:40px 8px}.empty h2{margin:0;font:600 24px/32px ${T.sans}}
.scrim{position:absolute;inset:0;background:rgb(0 0 0/.6)}
.modal{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:calc(100% - 32px);max-width:440px;padding:24px;border-radius:16px;border:1px solid ${T.line};background:${T.surface};box-shadow:0 8px 24px rgb(0 0 0/.4)}
.modal h4{margin:0;font:600 18px/26px ${T.sans}}.modal p{margin:8px 0 0;font-size:14px;line-height:20px;color:${T.muted}}.modal .mact{display:flex;justify-content:flex-end;gap:8px;margin-top:24px}
.notes{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;margin-top:16px}
.note{border:1px solid ${T.line};border-radius:12px;padding:14px 16px;background:${T.panel}}.note h3{margin:0 0 6px;font:600 14px/20px ${T.sans}}.note ul{margin:0;padding-left:18px;color:${T.muted};font-size:13px;line-height:20px}
${RESTANTES_CSS(T)}${MOTION_CSS}${BG_CSS}${BG_APPLY_CSS}
body{background:#08080b;background-image:none}`;

const page = (title, lead, body) => `<!doctype html>
<!-- ${title}: tela redesenhada para a phase 5 (gerada por docs/identidade/gerador/telas.mjs; não editar à mão). -->
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aion · ${title}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fredoka:wght@600&family=Inter:wght@400;500;600&family=JetBrains+Mono&display=swap">
<style>${SCREEN_CSS}</style></head><body><main>
<p class="cap2"><a href="../galeria.html" style="color:${T.info}">Galeria</a> · <a href="index.html" style="color:${T.info}">Telas</a></p>
<h1 class="pg">${title}</h1><p class="lead">${lead}</p>
<div class="legend">Origem dos elementos novos: ${tag(3)} notificações, contexto e blocos ${tag(4)} controle da conversa e Python ${tag(5)} identidade e navegação</div>
${body}
</main><script>${REPLAY_JS}</script></body></html>
`;

// ---------- peças reutilizadas ----------
const tabs = (on = 'inicio', { chatUnread = false, approvals = 1 } = {}) => `<nav class="tabs" aria-label="Seções">
${[['inicio', 'home', 'Início'], ['chats', 'chat', 'Chats'], ['rotinas', 'cal', 'Rotinas'], ['aprov', 'shield', 'Aprovações']].map(([id, icon, label]) => `<a class="tab${on === id ? ' on' : ''}"${on === id ? ' aria-current="page"' : ''}><span class="pill">${ic(icon, 's18')}${id === 'aprov' && approvals ? `<span class="bdg">${approvals}</span>` : ''}${id === 'chats' && chatUnread ? '<span class="unr"></span>' : ''}</span>${label}</a>`).join('')}</nav>`;
const sbar = '<div class="sbar"><span>14:32</span><span>5G ▮▮▮</span></div>';
const rail = (on, { botsUnread = false, chatUnread = false, approvals = 1 } = {}) => `<nav class="rail" aria-label="Seções"><span style="margin:2px 0 12px">${star(20)}</span>
${[['bots', 'bot', 'Bots', botsUnread], ['chat', 'chat', 'Chat geral', chatUnread], ['rot', 'cal', 'Rotinas', false], ['apr', 'shield', 'Aprovações', false]].map(([id, icon, label, u]) => `<span class="rk${on === id ? ' on' : ''}" aria-label="${label}">${icon === 'bot' ? `<svg class="i s18" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/></svg>` : ic(icon, 's18')}${u ? '<span class="unr"></span>' : ''}${id === 'apr' && approvals ? `<span class="bdg">${approvals}</span>` : ''}</span>`).join('')}
<span class="rk" style="margin-top:auto" aria-label="Configurações">${ic('gear', 's18')}</span></nav>`;
const botItem = (name, color, state, line, lineColor, { on = false, unread = false } = {}) => `<li class="bi${on ? ' on' : ''}">${F(24, color, state)}<div class="t"><div class="n">${name}</div><div class="s" style="color:${lineColor}">${line}</div></div>${unread ? `<span class="unr" title="Novidades não lidas"></span>${tag(3)}` : ''}</li>`;
const botsSide = (current) => `<aside class="side"><div class="sh">Bots<span class="b g ic">${ix('plus')}</span></div><ul class="bl">
${botItem('Resumo das manhãs', BOT, current === 'res' ? 'working' : 'working', 'Trabalhando…', T.info, { on: current === 'res' })}
${botItem('Financeiro', '#4ade80', 'waiting', 'Aguardando aprovação', T.warn, { on: current === 'fin' })}
${botItem('Conteúdo', '#f472b6', 'done', 'Concluiu agora', T.ok, { unread: true })}
${botItem('Viagens', '#fb923c', 'idle', 'Livre', T.muted)}
${botItem('Estudos', '#a78bfa', 'idle', 'Livre', T.muted)}</ul></aside>`;
const copyAct = (hover = false) => `<span class="a${hover ? ' hv' : ''}" aria-label="Copiar" title="Copiar">${ix('copy')}</span>`;
const userMsg = (text, { actions = '', compl = '' } = {}) => `<div class="mewrap"><div class="me">${text}</div>${compl}${actions ? `<div class="acts">${actions}</div>` : ''}</div>`;
const botMsg = (color, html, { mark = true, actions = '', state = 'idle' } = {}) => `<div class="br"><div class="mk">${mark ? F(24, color, state) : ''}</div><div class="bc"><div class="bub">${html}</div>${actions ? `<div class="acts">${actions}</div>` : ''}</div></div>`;
const codeBlock = (lang, code, wrapBtn = true) => `<div class="blk"><div class="bh"><span>${lang}</span>${wrapBtn ? `<span class="b g">${ix('wrap')}Quebrar linhas</span>` : ''}<span class="b g">${ix('copy')}Copiar</span></div><pre>${code}</pre></div>`;
const composer = ({ text = 'Escreva uma mensagem', filled = false, model = 'deepseek-v4.1-flash', effort = 'Padrão', send = 'up', banner = '' } = {}) => `<div class="composer-fade"><div class="cmp">${banner}<div class="tx${filled ? ' f' : ''}">${text}</div><div class="tb"><span class="b g ic" style="margin-right:auto">${ic('clip')}</span><span class="trg">${model} ${ic('chevD')}</span><span class="trg">${effort}</span><span class="b g ic">${ic('mic')}</span>${send === 'stop' ? `<span class="b p ic round" aria-label="Parar execução">${ic('square', 's14')}</span>` : `<span class="b p ic round" aria-label="Enviar mensagem"${filled ? '' : ' style="opacity:.5"'}>${ic('arrowUp', '', 'stroke-width:2')}</span>`}</div></div></div>`;
const chart = `<svg viewBox="0 0 380 170" width="100%" role="img" aria-label="Gráfico de barras: gastos de outubro por categoria"><text x="8" y="16" font-size="12" font-family="sans-serif" fill="#0f172a">Gastos de outubro por categoria (R$)</text>
${[['Mercado', 1480], ['Moradia', 1200], ['Transporte', 620], ['Lazer', 512], ['Saúde', 401]].map(([k, val], i) => `<text x="8" y="${44 + i * 26}" font-size="11" font-family="sans-serif" fill="#334155">${k}</text><rect x="86" y="${33 + i * 26}" width="${Math.round(val / 6)}" height="15" rx="2" fill="#3b82f6"/><text x="${92 + Math.round(val / 6)}" y="${45 + i * 26}" font-size="11" font-family="sans-serif" fill="#334155">${val.toLocaleString('pt-BR')}</text>`).join('')}</svg>`;
const pyCode = `<span class="kw">import</span> pandas <span class="kw">as</span> pd
df = pd.read_csv(<span class="st2">"extrato-outubro.csv"</span>)
por_cat = df.groupby(<span class="st2">"categoria"</span>)[<span class="st2">"valor"</span>].sum()
por_cat.sort_values().plot.barh()  <span class="cm"># vira o PNG abaixo</span>
por_cat.to_csv(<span class="st2">"gastos-outubro.csv"</span>)`;

// =====================================================================
// 1. Início do celular e conversa do bot
// =====================================================================
const homePhone = `<div class="phone">${sbar}
<div class="mh"><span style="padding-left:8px;flex:1">${wm(22)}</span><span class="b g ic" aria-label="Configurações">${ic('gear', 's18')}</span></div>
<div class="scroll home">
<div style="display:flex;align-items:center;gap:12px;margin:4px 4px 16px"><span class="hero-glow">${F(64, BRAND)}</span><div><h2>Boa tarde, Marco</h2><span class="xs muted">2 bots trabalhando · 1 aprovação</span></div></div>
<a class="apcard">${F(24, '#4ade80', 'waiting')}<span><b style="font-weight:600">Financeiro</b> quer enviar um e-mail para a contabilidade</span>${ix('chevR')}</a>
<div class="secth">Seus bots<span class="b g sm" style="height:28px;padding:0 8px">${ix('plus')}Novo bot</span></div>
<div class="hrow">${F(32, BOT, 'working')}<div class="t"><div class="n">Resumo das manhãs</div><div class="s">Lendo a caixa de entrada…</div></div><span class="badge info">Trabalhando</span></div>
<div class="hrow">${F(32, '#4ade80', 'waiting')}<div class="t"><div class="n">Financeiro</div><div class="s">Preparei o e-mail da contabilidade</div></div><span class="badge warn">Aguardando</span></div>
<div class="hrow">${F(32, '#f472b6')}<div class="t"><div class="n">Conteúdo <span class="unr" title="Novidades não lidas"></span></div><div class="s" style="color:${T.fg}">Rotina das 9h concluída</div></div></div>
<div class="hrow">${F(32, '#fb923c')}<div class="t"><div class="n">Viagens</div><div class="s">Livre</div></div></div>
<div class="secth">Chats recentes</div>
<div class="hrow"><div class="t"><div class="n">Viagem para Floripa <span class="unr"></span></div><div class="s">ontem · apaga em 6 dias</div></div></div>
</div>
${composer({ text: 'Pergunte ao Aion', model: 'deepseek-v4.1-flash' }).replace('class="cmp"', 'class="cmp" style="margin:8px"')}
${tabs('inicio', { chatUnread: true })}</div>`;

const homeEmptyPhone = `<div class="phone">${sbar}
<div class="mh"><span style="padding-left:8px;flex:1">${wm(22)}</span><span class="b g ic">${ic('gear', 's18')}</span></div>
<div class="scroll home"><div class="empty"><span class="hero-glow">${F(112, BRAND, 'sleep')}</span><h2 style="font:600 24px/30px ${T.disp}">Seus bots começam aqui</h2><p class="sm muted" style="margin:0;max-width:30ch">Cada bot tem nome, instruções e memória próprios, e trabalha mesmo com o app fechado.</p><span class="b p" style="width:100%">Criar bot</span><span class="xs subtle">Ou pergunte direto ao Aion no campo abaixo.</span></div></div>
${composer({ text: 'Pergunte ao Aion' }).replace('class="cmp"', 'class="cmp" style="margin:8px"')}
${tabs('inicio', { approvals: 0 })}</div>`;

const botConvPhone = `<div class="phone bot-glow" style="--bot:${BOT}">${sbar}
<div class="mh"><span class="b g ic" aria-label="Voltar ao Início">${ix('back')}</span><span class="tt">${F(28, BOT, 'working')}<span style="min-width:0;display:flex;flex-direction:column"><span style="color:#8db6fa;overflow:hidden;text-overflow:ellipsis">Resumo das manhãs</span><span class="xs" style="color:${T.info};display:flex;align-items:center;gap:4px"><span class="dot" style="width:6px;height:6px;border-radius:50%;background:currentColor"></span>Trabalhando</span></span></span><span class="b g ic" aria-label="Mais ações do bot">${ic('more')}</span></div>
<div class="scroll"><div class="col">
${userMsg('Lê o extrato de outubro e me mostra onde mais gastei.', { actions: copyAct() })}
${botMsg(BOT, `<p>Somei por categoria com Python. Mercado lidera, seguido de moradia.</p><div class="png">${chart}</div><div class="dl">${ic('file', '', `color:${T.muted}`)}<span style="flex:1">gastos-outubro.csv<span class="xs muted" style="display:block">CSV · 4 KB</span></span><span class="b g ic" aria-label="Baixar gastos-outubro.csv">${ix('download')}</span></div>`, { actions: copyAct(true) })}
${userMsg('Agora compara com setembro.', { actions: '' })}
<div class="br"><div class="mk">${F(24, BOT, 'working')}</div><div class="bc"><div class="ar">${ic('loader', 'spin')}<span class="l">Executando Python…</span>${ic('chevR')}</div></div></div>
${userMsg('Ignora a categoria Moradia.', { compl: `<span class="compl">${ix('reply')}Complemento · será lido na próxima etapa${tag(4)}</span>` })}
</div></div>
${composer({ text: 'Escreva uma mensagem', send: 'stop', model: 'deepseek-v4.1-flash', effort: 'Alto' })}</div>`;

const botConvDesk = `<div class="desk-wrap"><div class="desk">${rail('bots', { botsUnread: true, chatUnread: true })}${botsSide('res')}
<div class="content bot-glow" style="--bot:${BOT}"><div class="ch">${F(32, BOT, 'working')}<h3 style="color:#8db6fa">Resumo das manhãs</h3><span class="badge info"><span class="dot"></span>Trabalhando</span><span class="b g ic">${ic('clip')}</span><span class="b g ic">${ic('brain')}</span><span class="b g ic">${ic('sliders')}</span></div>
<div class="thread"><div class="col">
${userMsg('Lê o extrato de outubro e me mostra onde mais gastei.', { actions: copyAct() })}
<div class="br"><div class="mk">${F(24, BOT)}</div><div class="bc"><div class="ar">${ic('check', '', `color:${T.ok}`)}<span class="l">Python executado (2,1 s)${tag(4)}</span><span style="transform:rotate(90deg);display:inline-flex">${ic('chevR')}</span></div>
<div class="det">${codeBlock('python', pyCode, false)}<div><p class="lab">Saída</p><pre class="out">5 categorias · 38 lançamentos · total 4.212,90</pre></div></div>
<div class="bub"><p>Somei por categoria. Mercado lidera com R$ 1.480, seguido de moradia.</p><div class="png">${chart}</div><div class="dl">${ic('file', '', `color:${T.muted}`)}<span style="flex:1">gastos-outubro.csv<span class="xs muted" style="display:block">CSV · 4 KB</span></span><span class="b g sm">${ix('download')}Baixar</span></div></div>
<div class="acts">${copyAct(true)}<span class="xs">Copiar${tag(4)}</span></div></div></div>
${userMsg('Gera o comando para exportar isso do banco.', {})}
${botMsg(BOT, `<p>Este SQL roda no SQLite em memória do Python:</p>${codeBlock('sql', `<span class="kw">SELECT</span> categoria, <span class="kw">SUM</span>(valor) <span class="kw">AS</span> total <span class="kw">FROM</span> extrato <span class="kw">WHERE</span> mes = <span class="nu">10</span> <span class="kw">GROUP BY</span> categoria <span class="kw">ORDER BY</span> total <span class="kw">DESC</span>;`)}<span class="xs subtle">Bloco com Copiar e Quebrar linhas${tag(3)}</span>`, { actions: copyAct() })}
</div></div>
<div style="max-width:808px;margin:0 auto;width:100%">${composer({ text: 'Escreva uma mensagem', effort: 'Alto' })}</div></div></div></div>`;

const botEmptyDesk = `<div class="desk-wrap"><div class="desk">${rail('bots', { chatUnread: true })}${botsSide('fin')}
<div class="content bot-glow" style="--bot:#4ade80"><div class="ch">${F(32, '#4ade80', 'waiting')}<h3 style="color:#86efac">Financeiro</h3><span class="badge warn">Aguardando aprovação</span><span class="b g ic">${ic('clip')}</span><span class="b g ic">${ic('brain')}</span><span class="b g ic">${ic('sliders')}</span></div>
<div class="thread"><div class="col">
${userMsg('Manda a fatura #4821 para a contabilidade e pede o ajuste do valor.')}
<div class="br"><div class="mk">${F(24, '#4ade80')}</div><div class="bc"><div class="ar">${ic('clock', '', `color:${T.warn}`)}<span class="l">Enviar e-mail<span class="xs" style="margin-left:8px;color:${T.warn}">Aguardando aprovação</span></span>${ic('chevR')}</div></div></div>
${card(T.warn, 'Aprovação pendente', 'shield', `<div style="font-weight:500">Enviar e-mail</div><div class="mono subtle">GMAIL_SEND_EMAIL</div><dl style="display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:8px 0 0;font:13px/20px ${T.mono}"><dt class="subtle">para</dt><dd style="margin:0" class="muted">contabilidade@exemplo.com</dd><dt class="subtle">assunto</dt><dd style="margin:0" class="muted">Ajuste da fatura #4821</dd></dl><p class="xs subtle" style="margin:8px 0 0">Expira em 3 h</p>`, `<span class="b p sm">Permitir uma vez</span><span class="b s sm">Negar</span><span class="b s ic">${ic('chevD')}</span>`, F(32, '#4ade80', 'waiting'))}
</div></div>
<div style="max-width:808px;margin:0 auto;width:100%">${composer({ text: 'Escreva uma mensagem' })}</div></div></div></div>`;

const botFirstPhone = `<div class="phone bot-glow" style="--bot:#a78bfa">${sbar}
<div class="mh"><span class="b g ic">${ix('back')}</span><span class="tt">${F(28, '#a78bfa')}<span style="color:#c4b5fd">Estudos</span></span><span class="b g ic">${ic('more')}</span></div>
<div class="scroll"><div class="empty" style="padding-top:96px"><span class="hero-glow">${F(112, '#a78bfa')}</span><h2>O que o <span style="color:#c4b5fd">Estudos</span> faz agora?</h2></div></div>
${composer({})}</div>`;

writeFileSync(join(OUT, '01-inicio-e-conversa-do-bot.html'), page('Início e conversa do bot',
  'Bloco 1 das telas da phase 5. No celular o app abre no Início (opção B) e a conversa do bot ocupa a tela inteira, sem a barra inferior, com voltar no cabeçalho. No desktop o shell continua o mesmo, com a Faísca no lugar dos mascotes antigos e a estrela no topo da barra de ícones.',
  `<h2 class="st">Início do celular${tag(5)}</h2><p class="sub">Com bots e pendências, e no primeiro acesso (sem bots). O ponto azul é o marcador de não lido da phase 3, que no celular passa para as linhas do Início e para a aba Chats.</p>
<div class="pair"><div><p class="cap2">Com bots · 380 px</p>${homePhone}</div><div><p class="cap2">Primeiro acesso · 380 px</p>${homeEmptyPhone}</div></div>
<h2 class="st">Conversa do bot no celular</h2><p class="sub">Execução de Python com gráfico e arquivo${tag(4)}, complemento enviado durante a execução${tag(4)} e o botão de parar. A barra inferior some dentro da conversa para dar espaço ao composer.</p>
<div class="pair"><div><p class="cap2">Trabalhando · 380 px</p>${botConvPhone}</div><div><p class="cap2">Conversa vazia · 380 px</p>${botFirstPhone}</div></div>
<h2 class="st">Conversa do bot no desktop</h2><p class="sub">1280 × 800 reduzido. À esquerda, a barra com a estrela da marca e os marcadores (não lido em azul, aprovações em amarelo); o painel lista os bots com a Faísca de 24 px.</p>
<div class="pair" style="flex-direction:column"><div><p class="cap2">Python executado e bloco de código · 1280 px</p>${botConvDesk}</div><div><p class="cap2">Aguardando aprovação · 1280 px</p>${botEmptyDesk}</div></div>
<div class="notes">
<div class="note"><h3>Decisões desta tela</h3><ul><li>Conversa no celular sem barra inferior; "Voltar" leva ao Início. O estado do bot vira uma segunda linha sob o nome, para o nome não ser cortado.</li><li>As ações do bot (arquivos, memória, configurações) viram um menu "Mais ações" no celular; no desktop seguem como ícones.</li><li>Copiar aparece sempre no celular e no hover no desktop (phase 4).</li><li>A Faísca do cabeçalho mostra o estado ao vivo; a da coluna de respostas fica parada.</li></ul></div>
<div class="note"><h3>Vem de outras phases</h3><ul><li>Phase 3: marcador de não lido, bloco cercado com Copiar e Quebrar linhas.</li><li>Phase 4: Copiar mensagem, complemento, execução de Python (atividade, código, saída, PNG inline e cartão de download).</li></ul></div>
<div class="note"><h3>Para conferir na implementação</h3><ul><li>Primeiro acesso sem provedor: o banner "Configure um provedor para conversar." continua acima do composer.</li><li>Teclado aberto no Início: o composer sobe e a barra inferior some.</li></ul></div>
</div>`));

// =====================================================================
// 2. Chat geral
// =====================================================================
const chatSide = `<aside class="side"><div class="sh">Chat geral<span class="b g ic" aria-label="Novo chat">${ix('plus')}</span></div><div style="padding:0 8px;display:flex;flex-direction:column;gap:2px">
<div class="si on"><div class="r1"><span>Viagem para Floripa</span></div><span class="xs muted" style="font-weight:400">apaga em 6 dias</span></div>
<div class="si" style="color:${T.fg};font-weight:500"><div class="r1"><span>Ideias de post para outubro</span><span class="unr" style="flex:none"></span>${tag(3)}</div><span class="xs muted" style="font-weight:400">apaga em 7 dias</span></div>
<div class="si"><div class="r1"><span>Dúvida de imposto</span></div><span class="xs muted" style="font-weight:400;display:flex;align-items:center;gap:4px">${ic('bookmark', 's14')}Salva</span></div>
<div class="si"><div class="r1"><span>Receita de pão</span></div><span class="xs muted" style="font-weight:400">apaga hoje</span></div></div></aside>`;
const ver = (n, of) => `<span class="ver" aria-label="Versão ${n} de ${of}"><span class="a" aria-label="Versão anterior">${ix('chevL')}</span>${n}/${of}<span class="a" aria-label="Próxima versão">${ix('chevR')}</span></span>`;
const userActs = (v = '') => `${v}${copyAct()}<span class="a" aria-label="Editar mensagem" title="Editar">${ix('pencil')}</span>`;
const botActs = (v = '', model = 'deepseek-v4.1-flash') => `${v}${copyAct()}<span class="a" aria-label="Gerar outra resposta" title="Gerar outra resposta">${ix('refresh')}</span><span class="a" aria-label="Retroceder até aqui" title="Retroceder até aqui">${ix('undo')}</span><span class="mdl">${model}</span>`;
const chatThread = (mobile = false) => `<div class="col">
${userMsg('Qual a melhor época para ir a Floripa com pouca chuva?', { actions: userActs(ver(2, 2)) })}
${botMsg(BRAND, `<p>Entre abril e junho: menos chuva, mar ainda morno e preços de baixa temporada.</p><ul><li>Abril e maio: dias firmes, água por volta de 22 °C.</li><li>Junho: mais frio, ótimo para trilhas.</li></ul>`, { actions: botActs(ver(1, 2), 'kimi-k2.5') })}
${userMsg('E para ver baleias?', { actions: userActs() })}
${botMsg(BRAND, `<p>A temporada das baleias-francas vai de julho a novembro, com pico em setembro, na Praia do Rosa e na Guarda do Embaú.</p>`, { actions: botActs('', 'kimi-k2.5'), state: 'idle' })}
</div>`;

const chatDesk = `<div class="desk-wrap"><div class="desk">${rail('chat', { botsUnread: true, chatUnread: true })}${chatSide}
<div class="content"><div class="ch">${F(32, BRAND)}<h3>Viagem para Floripa</h3><span class="b g ic" aria-label="Salvar sessão">${ic('bookmark')}</span></div>
<div class="thread">${chatThread()}</div>
<div style="max-width:808px;margin:0 auto;width:100%">${composer({ model: 'kimi-k2.5' })}</div></div></div></div>`;

const chatEditDesk = `<div class="desk-wrap" style="position:relative"><div class="desk" style="position:relative">${rail('chat', { botsUnread: true })}${chatSide}
<div class="content"><div class="ch">${F(32, BRAND)}<h3>Viagem para Floripa</h3></div>
<div class="thread">${chatThread()}</div>
<div style="max-width:808px;margin:0 auto;width:100%">${composer({ text: 'Qual a melhor época para ir a Floripa com pouca chuva e pouca gente?', filled: true, model: 'kimi-k2.5', banner: `<div class="ed">${ix('pencil')}Editando a mensagem: a versão atual continua salva como 2/2.${tag(4)}<span class="b g sm" style="margin-left:auto;height:24px">Cancelar</span></div>` })}</div></div></div></div>`;

const chatPhone = `<div class="phone">${sbar}
<div class="mh"><span class="b g ic" aria-label="Voltar">${ix('back')}</span><span class="tt">${F(28, BRAND)}Viagem para Floripa</span><span class="b g ic">${ic('more')}</span></div>
<div class="scroll">${chatThread(true)}</div>
${composer({ model: 'kimi-k2.5' })}</div>`;

const chatListPhone = `<div class="phone">${sbar}
<div class="mh"><span class="tt" style="padding-left:8px">Chats</span><span class="b g ic" aria-label="Novo chat">${ix('plus')}</span></div>
<div class="scroll" style="padding:8px">
<div class="si" style="padding:10px 12px;color:${T.fg};font-weight:500"><div class="r1"><span>Ideias de post para outubro</span><span class="unr" style="flex:none"></span></div><span class="xs muted" style="font-weight:400">apaga em 7 dias</span></div>
<div class="si" style="padding:10px 12px"><div class="r1"><span>Viagem para Floripa</span></div><span class="xs muted" style="font-weight:400">apaga em 6 dias</span></div>
<div class="si" style="padding:10px 12px"><div class="r1"><span>Dúvida de imposto</span></div><span class="xs muted" style="font-weight:400;display:flex;align-items:center;gap:4px">${ic('bookmark', 's14')}Salva</span></div>
<div class="si" style="padding:10px 12px"><div class="r1"><span>Receita de pão</span></div><span class="xs muted" style="font-weight:400">apaga hoje</span></div>
<p class="xs subtle" style="margin:12px">As sessões não salvas somem 7 dias após a última mensagem.</p></div>
${tabs('chats')}</div>`;

const rewindPhone = `<div class="phone" style="position:relative">${sbar}
<div class="mh"><span class="b g ic">${ix('back')}</span><span class="tt">${F(28, BRAND)}Viagem para Floripa</span></div>
<div class="scroll">${chatThread(true)}</div>${composer({ model: 'kimi-k2.5' })}
<div class="scrim" data-anim="scrim"></div><div class="modal" role="dialog" data-anim="modal"><h4>Retroceder até esta resposta?</h4><p>2 rodadas saem do contexto do modelo e ficam guardadas como outra versão, que você pode reabrir pelo seletor.</p><p>Ações já feitas por conectores, como e-mails enviados, não são desfeitas.</p><div class="mact"><span class="b s">Cancelar</span><span class="b p">Retroceder</span></div></div></div>`;

writeFileSync(join(OUT, '02-chat-geral.html'), page('Chat geral',
  'Bloco 2. O Chat geral passa a ter a Faísca na cor da marca (é o próprio Aion falando) e recebe o controle da conversa da phase 4: copiar, editar com versões, gerar outra resposta e retroceder. Nada disso existe nos bots, que seguem lineares.',
  `<h2 class="st">Sessão no desktop${tag(4)}</h2><p class="sub">Ações abaixo de cada mensagem: no desktop aparecem no hover (aqui todas visíveis para leitura). O seletor "‹ 1/2 ›" troca o ramo ativo; cada resposta mostra o modelo que a gerou.</p>
<div class="pair" style="flex-direction:column"><div><p class="cap2">Com versões · 1280 px</p>${chatDesk}</div><div><p class="cap2">Editando uma mensagem · 1280 px</p>${chatEditDesk}</div></div>
<h2 class="st">Celular</h2><p class="sub">A aba Chats lista as sessões com o marcador de não lido; a sessão abre em tela cheia, com as ações sempre visíveis. Retroceder pede confirmação com a contagem de rodadas.</p>
<div class="pair"><div><p class="cap2">Aba Chats · 380 px</p>${chatListPhone}</div><div><p class="cap2">Sessão · 380 px</p>${chatPhone}</div><div><p class="cap2">Retroceder · 380 px</p>${rewindPhone}</div></div>
<div class="notes">
<div class="note"><h3>Decisões desta tela</h3><ul><li>Faísca em faisca no cabeçalho e na coluna das respostas, no lugar do marcador de conversa.</li><li>Ações do dono: Copiar e Editar. Ações da resposta: Copiar, Gerar outra resposta, Retroceder até aqui e o nome do modelo.</li><li>Editar acontece no composer, com a faixa "Editando a mensagem" e Cancelar; enviar cria a versão nova.</li><li>Com execução ativa ou fila, editar, gerar outra, retroceder e trocar versão ficam desabilitados com o motivo no tooltip.</li></ul></div>
<div class="note"><h3>Vem de outras phases</h3><ul><li>Phase 3: marcador de não lido nas sessões e título em destaque.</li><li>Phase 4: todo o controle da conversa (CONV-01 a CONV-03).</li></ul></div>
</div>`));

// ---------- blocos 3 a 7 ----------
for (const [file, html] of Object.entries(renderRestantes({ page, T, F, ic, ix, tag, wm, star, sbar, tabs, rail, botsSide, composer, BOT, BRAND, card }))) writeFileSync(join(OUT, file), html);

// ---------- índice das telas ----------
writeFileSync(join(OUT, 'index.html'), page('Telas da phase 5', 'Telas redesenhadas, em blocos, para aprovação antes da implementação. Cada bloco é aprovado ou ajustado antes do próximo.',
  `<ol style="font-size:15px;line-height:28px"><li><a style="color:${T.info}" href="01-inicio-e-conversa-do-bot.html">Início e conversa do bot</a></li><li><a style="color:${T.info}" href="02-chat-geral.html">Chat geral</a></li>
${[['03-login-e-totp', 'Login e TOTP'], ['04-criar-e-editar-bot', 'Criar e editar bot'], ['05-aprovacoes-e-rotinas', 'Aprovações e Rotinas'], ['06-configuracoes', 'Configurações'], ['07-erro-404-e-primeiro-acesso', 'Erro, 404 e primeiro acesso']].map(([f, t]) => `<li><a style="color:${T.info}" href="${f}.html">${t}</a></li>`).join('')}</ol>`));
console.log('telas ok', OUT);

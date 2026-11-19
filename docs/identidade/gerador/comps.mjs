// Previews e guias dos componentes restantes do kit (apps/web/src/components/ui), recriados em HTML estático a partir das classes reais.
// Sobreposições (menu, popover, modal, drawer, bottom sheet, tooltip) aparecem abertas dentro de uma moldura que imita a tela.
import { faiscaInner, furFilter } from './faisca.mjs';

const v = (name, fb) => `var(--${name},${fb})`;
const C = {
  app: v('bg-app', '#0e0e13'), panel: v('bg-panel', '#15151b'), surface: v('bg-surface', '#1b1b22'), hover: v('bg-surface-hover', '#23232b'),
  selected: v('bg-selected', '#2a2a33'), line: v('border', '#2e2e38'), strong: v('border-strong', '#6a6a80'), text: v('text', '#ececf1'),
  muted: v('text-muted', '#a3a3b0'), subtle: v('text-subtle', '#8b8b99'), action: v('action', '#ececf1'), actionFg: v('action-fg', '#0e0e13'),
  focus: v('focus', '#8db6fa'), danger: v('danger', '#f87171'), dangerSoft: v('danger-soft', '#f871711f'), sans: v('font-sans', "'Inter',system-ui,sans-serif"),
  mono: v('font-mono', "'JetBrains Mono',monospace"), md: v('radius-md', '10px'), sm: v('radius-sm', '6px'), lg: v('radius-lg', '16px'),
};
const SHADOW = '0 8px 24px rgb(0 0 0 / .4)';
// Peças comuns: moldura de tela, botões e campo, para os previews compostos.
const KIT = `.screen{position:relative;height:var(--h,260px);border:1px solid ${C.line};border-radius:${C.lg};background:${C.app};overflow:hidden}
.scrim{position:absolute;inset:0;background:rgb(0 0 0/.6)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:36px;padding:0 16px;border-radius:${C.md};font:500 14px/20px ${C.sans};border:1px solid transparent;white-space:nowrap}
.btn.p{background:${C.action};color:${C.actionFg}}.btn.s{background:${C.surface};color:${C.text};border-color:${C.line}}.btn.d{background:transparent;color:${C.danger}}
.btn.sm{height:32px;padding:0 12px}.btn.ic{width:32px;padding:0}
.field{height:36px;width:100%;box-sizing:border-box;border-radius:${C.md};border:1px solid ${C.strong};background:${C.surface};color:${C.text};padding:0 12px;font:400 14px/20px ${C.sans}}
.lb{display:block;margin-bottom:6px;font:500 14px/20px ${C.sans};color:${C.text}}
.muted{color:${C.muted};font-size:13px;line-height:20px}
:focus-visible{outline:2px solid ${C.focus};outline-offset:2px}`;
const dots = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';
const icon = (d) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const sleepFaisca = (id, color = '#a78bfa') => `<svg viewBox="-4 -8 128 128" width="40" height="40" aria-hidden="true"><defs>${furFilter(id)}</defs>${faiscaInner({ color, state: 'sleep', withBubble: false, furId: id, ground: false })}</svg>`;

/** Lista [Nome, marcador, css, corpo, script, README]. */
export const COMPONENTS = [
  ['Input', 'group="Campos" height=200 subtitle="36 px, borda forte, foco e erro"',
    `.f{max-width:360px;margin-bottom:12px}.err .field{border-color:${C.danger}}.msg{margin-top:6px;font-size:13px;line-height:20px;color:${C.danger}}input::placeholder{color:${C.subtle}}`,
    `<div class="f"><label class="lb" for="n">Nome do bot</label><input class="field" id="n" placeholder="Resumo das manhãs"></div>
<div class="f err"><label class="lb" for="m">Fuso da rotina</label><input class="field" id="m" value="Sao Paulo" aria-invalid="true" aria-describedby="me"><div class="msg" id="me">Escolha um fuso da lista, como America/Sao_Paulo.</div></div>`, '',
    `# Input

Campo de texto do kit (ui/input.tsx) com o Label irmão: 36 px, bg-surface, borda border-strong (a border some contra o fundo), raio radius-md, 12 px de padding lateral.

- Fonte de 16 px no celular (evita o zoom do iOS) e 14 px no desktop.
- Placeholder em text-subtle, sempre um exemplo real e nunca a repetição do rótulo.
- Erro por \`aria-invalid\`: borda danger e mensagem em danger ligada por \`aria-describedby\`, dizendo o que fazer.
- Desabilitado em 50% de opacidade.
`],
  ['Textarea', 'group="Campos" height=240 subtitle="cresce com o texto até 60 dvh"',
    `textarea{display:block;width:100%;box-sizing:border-box;min-height:160px;resize:vertical;border-radius:${C.md};border:1px solid ${C.strong};background:${C.surface};color:${C.text};padding:8px 12px;font:400 14px/24px ${C.sans}}textarea::placeholder{color:${C.subtle}}`,
    `<label class="lb" for="r">Regras do bot</label><textarea id="r" placeholder="Responda sempre com uma lista curta e cite a fonte de cada item."></textarea>`, '',
    `# Textarea

Irmã do Input (ui/textarea.tsx): mesma superfície, borda border-strong e erro por \`aria-invalid\`. Usada em Regras, Memória e Regras Globais.

- Mínimo de 160 px; cresce com o conteúdo (\`field-sizing: content\`) até 60 dvh e então rola.
- 16 px no celular, 14 px com entrelinha de 24 px no desktop.
- Contador de caracteres (limite de 8.000 da memória) fica abaixo, em small text-muted, e vira danger ao passar do limite.
`],
  ['Select', 'group="Campos" height=120 subtitle="select nativo do sistema"',
    `select{height:36px;width:100%;max-width:360px;border-radius:${C.md};border:1px solid ${C.strong};background:${C.surface};color:${C.text};padding:0 10px;font:400 14px/20px ${C.sans}}`,
    `<label class="lb" for="f">Frequência</label><select id="f"><option>Todo dia</option><option>Dias úteis</option><option>Toda semana</option></select>`, '',
    `# Select

Select nativo (ui/select.tsx), irmão do Input: 36 px, borda border-strong, erro por \`aria-invalid\`.

- Nativo de propósito: teclado, leitor de tela e o seletor do celular vêm prontos.
- Use para listas curtas (frequência, fuso). Para listas longas ou com busca (modelo), use Popover no desktop e BottomSheet no celular.
`],
  ['CodeInput', 'group="Campos" height=140 subtitle="seis caixas, um input real por cima"',
    `.boxes{display:flex;gap:8px;max-width:360px}.box{flex:1;height:48px;display:grid;place-items:center;border-radius:${C.md};border:1px solid ${C.strong};background:${C.app};font:400 20px/1 ${C.mono};color:${C.text}}.box.on{border-color:${C.focus};box-shadow:0 0 0 2px ${C.focus}}`,
    `<span class="lb">Código do autenticador</span><div class="boxes" aria-hidden="true"><span class="box">4</span><span class="box">8</span><span class="box">1</span><span class="box on"></span><span class="box"></span><span class="box"></span></div>`, '',
    `# CodeInput

Campo de código de 6 dígitos do TOTP (ui/code-input.tsx): seis caixas desenhadas com um único \`<input>\` transparente por cima.

- O input único mantém colagem ("123 456"), autopreenchimento \`one-time-code\`, teclado numérico e um só nome acessível.
- Caixas de 48 px em bg-app, borda border-strong, dígitos em mono 20 px; a caixa que recebe o próximo dígito ganha o anel focus quando o campo tem foco.
- O sexto dígito dispara \`onComplete\`: o login envia sozinho.
- Erro: todas as caixas com borda danger.
`],
  ['Switch', 'group="Controles" height=130 subtitle="trilho 36×20, toque de 44 px"',
    `.row{display:flex;align-items:center;justify-content:space-between;max-width:360px;min-height:44px;font:400 14px/20px ${C.sans};color:${C.text}}
.trk{position:relative;display:inline-block;width:36px;height:20px;border-radius:999px;box-sizing:border-box;border:1px solid ${C.strong};background:${C.selected}}
.trk i{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:${C.muted}}
.trk.on{background:${C.action};border-color:transparent}.trk.on i{left:18px;background:${C.actionFg}}
button.sw{all:unset;cursor:pointer;display:flex;align-items:center;min-height:44px;border-radius:${C.sm}}`,
    `<div class="row"><span>Pesquisa na web</span><button class="sw" role="switch" aria-checked="true" aria-label="Pesquisa na web"><span class="trk on"><i></i></span></button></div>
<div class="row"><span>Silenciar avisos deste bot</span><button class="sw" role="switch" aria-checked="false" aria-label="Silenciar avisos deste bot"><span class="trk"><i></i></span></button></div>`,
    `document.querySelectorAll('button.sw').forEach(function(b){b.addEventListener('click',function(){var on=b.getAttribute('aria-checked')!=='true';b.setAttribute('aria-checked',String(on));b.firstElementChild.classList.toggle('on',on)})});`,
    `# Switch

Interruptor (ui/switch-track.tsx desenha; quem usa fornece o \`<button role="switch">\`): trilho 36 × 20 px.

- Ligado: trilho action, polegar action-fg. Desligado: trilho bg-selected com borda border-strong, polegar text-muted.
- O botão que envolve dá o estado (\`aria-checked\`), o nome (\`aria-label\` ou rótulo) e a área de toque de 44 px.
- A transição do polegar zera com movimento reduzido.
`],
  ['Tooltip', 'group="Sobreposições" height=130 subtitle="aparece após 400 ms"',
    `.wrap{position:relative;display:inline-flex;flex-direction:column;align-items:center;margin:40px 0 0 24px}
.tip{position:absolute;bottom:calc(100% + 8px);white-space:nowrap;border-radius:${C.sm};border:1px solid ${C.line};background:${C.surface};padding:4px 8px;font:500 12px/16px ${C.sans};color:${C.text}}
.icb{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:${C.md};color:${C.muted}}`,
    `<div class="wrap"><span class="tip" role="tooltip" data-anim="tip">Ditado</span><span class="icb" aria-label="Ditado">${icon('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 19v3"/>')}</span></div>`, '',
    `# Tooltip

Tooltip do kit (ui/tooltip.tsx, Radix): bg-surface, borda border, raio radius-sm, texto caption 12 px em text.

- Aparece após 400 ms e entra por transform/opacity a partir do gatilho.
- Só para nomear botões de ícone; nunca guarde informação necessária só no tooltip (no toque ele não existe).
`],
  ['Popover', 'group="Sobreposições" height=300 subtitle="seletor de modelo no desktop"',
    `.screen{--h:280px;padding:16px}.pop{position:absolute;left:16px;top:60px;width:280px;border-radius:${C.lg};border:1px solid ${C.line};background:${C.surface};box-shadow:${SHADOW};overflow:hidden}
.hd{padding:10px 12px;border-bottom:1px solid ${C.line};font:400 14px/20px ${C.sans};color:${C.subtle}}
.it{display:flex;justify-content:space-between;align-items:center;height:36px;padding:0 12px;font:400 14px/20px ${C.sans};color:${C.text}}.it.sel{background:${C.hover}}
.it small{color:${C.muted};font-size:12px}`,
    `<div class="screen"><span class="btn s sm">deepseek-v4.1-flash</span>
<div class="pop" role="dialog" aria-label="Escolher modelo" data-anim="pop"><div class="hd">Buscar modelo</div>
<div class="it sel"><span>deepseek-v4.1-flash</span><small>favorito</small></div><div class="it"><span>kimi-k2.5</span><small>visão</small></div><div class="it"><span>glm-5</span><small></small></div><div class="it"><span>qwen3.6-plus</span><small>visão</small></div></div></div>`, '',
    `# Popover

Popover do kit (ui/popover.tsx, Radix): bg-surface, borda border, raio radius-lg, sombra shadow-float, 8 px do gatilho.

- Fecha com Esc e clique fora, devolve o foco ao gatilho e vira de lado se não couber.
- Entra com scale(0.97) e opacidade em 150 ms ease-out.
- No celular, popovers grandes (seletor de modelo) viram BottomSheet.
`],
  ['Menu', 'group="Sobreposições" height=260 subtitle="menu de ações do bot"',
    `.screen{--h:240px;padding:16px;display:flex;justify-content:flex-end}.menu{position:absolute;right:16px;top:56px;min-width:180px;padding:4px;border-radius:${C.md};border:1px solid ${C.line};background:${C.surface};box-shadow:${SHADOW}}
.mi{display:flex;align-items:center;gap:8px;height:36px;padding:0 8px;border-radius:${C.sm};font:400 14px/20px ${C.sans};color:${C.text}}.mi.hl{background:${C.hover}}.mi.dg{color:${C.danger}}
.sep{height:1px;margin:4px 0;background:${C.line}}`,
    `<div class="screen"><span class="btn s ic" aria-label="Ações do bot">${dots}</span>
<div class="menu" role="menu" data-anim="pop-r"><div class="mi hl" role="menuitem">${icon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>')}Editar bot</div><div class="mi" role="menuitem">${icon('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>')}Rotinas</div><div class="mi" role="menuitem">${icon('<path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 6v6l4 2"/>')}Memória</div><div class="sep" role="separator"></div><div class="mi dg" role="menuitem">${icon('<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>')}Excluir bot</div></div></div>`, '',
    `# Menu

Menu de ações (ui/menu.tsx, DropdownMenu do Radix): mesma superfície do popover com raio radius-md e 4 px de padding; itens de 36 px (40 px no celular), raio radius-sm, hover em bg-surface-hover.

- Abre por clique, Enter, Espaço ou seta; navega por setas; Esc fecha e devolve o foco.
- Ação destrutiva por último, separada por um fio border e em danger.
- Itens começam por verbo e podem levar ícone Lucide de 16 px.
`],
  ['Modal', 'group="Sobreposições" height=320 subtitle="confirmação, até 440 px, ações à direita"',
    `.screen{--h:300px}.mod{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:calc(100% - 32px);max-width:440px;box-sizing:border-box;padding:24px;border-radius:${C.lg};border:1px solid ${C.line};background:${C.surface};box-shadow:${SHADOW}}
.ttl{display:flex;align-items:center;gap:12px;margin:0;font:600 18px/26px ${C.sans};color:${C.text}}.ds{margin:8px 0 0;font:400 14px/20px ${C.sans};color:${C.muted}}
.act{display:flex;justify-content:flex-end;gap:8px;margin-top:24px}`,
    `<div class="screen"><div class="scrim" data-anim="scrim"></div><div class="mod" data-anim="modal" role="dialog" aria-labelledby="t" aria-describedby="d"><h2 class="ttl" id="t">${sleepFaisca('md1')}Excluir o bot Resumo das manhãs?</h2><p class="ds" id="d">A conversa, a memória e as rotinas dele também serão apagadas. Não dá para desfazer.</p><div class="act"><span class="btn s">Cancelar</span><span class="btn d" style="border-color:#f8717166">Excluir bot</span></div></div></div>`, '',
    `# Modal

Modal do kit (ui/modal.tsx, Dialog do Radix): até 440 px, gutter de 16 px no celular, bg-surface, raio radius-lg, padding 24 px, sombra shadow-float sobre véu preto a 60%.

- Título em page-title 18/26; descrição em text-muted, ligada como descrição acessível.
- \`leading\` aceita a Faísca do bot (dormindo, 40 px) ao lado do título no popup de exclusão; ela não entra no nome acessível.
- Ações à direita, a principal por último (no celular, empilhadas com Cancelar primeiro). Em exclusão, o botão perigo descreve a ação ("Excluir bot") e leva a borda danger a 40%, como em todo diálogo destrutivo.
- Foco preso; ao fechar volta a quem abriu, mesmo com o modal controlado.
`],
  ['Drawer', 'group="Sobreposições" height=320 subtitle="navegação no celular, entra pela esquerda"',
    `.screen{--h:300px}.dr{position:absolute;left:0;top:0;bottom:0;width:240px;background:${C.app};border-right:1px solid ${C.line};padding:16px 8px;box-sizing:border-box}
.brand{display:flex;align-items:center;gap:8px;padding:0 8px 16px}.nv{display:flex;align-items:center;gap:10px;height:36px;padding:0 8px;border-radius:${C.md};font:400 14px/20px ${C.sans};color:${C.muted}}.nv.on{background:${C.selected};color:${C.text}}
.nv svg.f{flex:none}`,
    `<div class="screen"><div class="scrim" data-anim="scrim"></div><nav class="dr" data-anim="drawer" aria-label="Navegação"><div class="brand"><svg viewBox="0 0 240 96" width="60" height="24" role="img" aria-label="aion"><circle cx="34" cy="55" r="22" fill="none" stroke="#ECECF1" stroke-width="14"/><path d="M56 34 V80 M88 34 V80" fill="none" stroke="#ECECF1" stroke-width="14" stroke-linecap="round"/><circle cx="136" cy="55" r="22" fill="none" stroke="#ECECF1" stroke-width="14"/><path d="M186 80 V34 M186 54 C186 40 195 33 206 33 C218 33 226 41 226 54 V80" fill="none" stroke="#ECECF1" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/><path transform="translate(88 12)" d="M0 -11 C1.6 -3.6 3.6 -1.6 11 0 C3.6 1.6 1.6 3.6 0 11 C-1.6 3.6 -3.6 1.6 -11 0 C-3.6 -1.6 -1.6 -3.6 0 -11Z" fill="#FACC15" stroke="#A16207" stroke-width="1.2"/></svg></div>
<div class="nv">${icon('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>')}Chat geral</div><div class="nv on"><svg class="f" viewBox="-4 -8 128 128" width="20" height="20" aria-hidden="true">${faiscaInner({ color: '#60a5fa', rich: false, withBubble: false, ground: false })}</svg>Resumo das manhãs</div><div class="nv"><svg class="f" viewBox="-4 -8 128 128" width="20" height="20" aria-hidden="true">${faiscaInner({ color: '#4ade80', rich: false, withBubble: false, ground: false })}</svg>Financeiro</div><div class="nv">${icon('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>')}Configurações</div></nav></div>`, '',
    `# Drawer

Drawer lateral (ui/drawer.tsx, Dialog do Radix): navegação no celular pela esquerda e histórico de versões da memória pela direita (\`side="right"\`).

- Fundo bg-app, até 90 vw, sobre véu preto a 60%; entra por transform em 250 ms com o ease do drawer e respeita a safe area.
- No topo, o logotipo claro a 24 px. Itens de 36 px com raio radius-md; o ativo em bg-selected com text, os demais em text-muted.
- Cada bot aparece com a Faísca de 20 px na cor dele (nível simples, parada); o Chat geral mantém o ícone de conversa, ou a Faísca em faisca se a phase 5 confirmar.
- \`title\` é obrigatório: vira o nome acessível do diálogo.
`],
  ['BottomSheet', 'group="Sobreposições" height=340 subtitle="popover grande no celular, 70 dvh"',
    `.screen{--h:320px;max-width:380px}.sh{position:absolute;left:0;right:0;bottom:0;height:70%;display:flex;flex-direction:column;border-top:1px solid ${C.line};border-radius:${C.lg} ${C.lg} 0 0;background:${C.surface}}
.grab{width:36px;height:4px;border-radius:999px;background:${C.strong};margin:8px auto}.sh .hd{padding:4px 16px 8px;font:600 15px/24px ${C.sans};color:${C.text}}
.it{display:flex;justify-content:space-between;align-items:center;height:44px;padding:0 16px;font:400 15px/24px ${C.sans};color:${C.text}}.it.sel{background:${C.hover}}.it small{color:${C.muted};font-size:12px}`,
    `<div class="screen"><div class="scrim" data-anim="scrim"></div><div class="sh" data-anim="sheet" role="dialog" aria-label="Escolher modelo"><div class="grab"></div><div class="hd">Modelo</div><div class="it sel"><span>deepseek-v4.1-flash</span><small>favorito</small></div><div class="it"><span>kimi-k2.5</span><small>visão</small></div><div class="it"><span>glm-5</span><small></small></div></div></div>`, '',
    `# BottomSheet

Drawer inferior (ui/bottom-sheet.tsx, Dialog do Radix): versão para celular dos popovers grandes, como o seletor de modelo.

- 70 dvh de altura, bg-surface, borda superior border e cantos superiores radius-lg; sobe por transform em 250 ms.
- Quem usa decide o que fica fixo no topo e na base e o que rola; itens de 44 px para toque.
- Foco preso, Esc e toque fora fecham, o foco volta ao gatilho. \`title\` obrigatório (nome acessível).
`],
];

export { KIT };

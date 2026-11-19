// Componentes de produto do Aion (conversa, modelos, bots, aprovações, configurações e a navegação mobile da opção B),
// recriados em HTML estático a partir das classes reais de apps/web/src/components, já com a identidade da Faísca.
// Cada entrada: [Nome, marcador @dsCard, css, corpo, script, README].
import { faiscaInner, furFilter } from './faisca.mjs';

// ---------- base ----------
const v = (n, fb) => `var(--${n},${fb})`;
export const T = {
  app: v('bg-app', '#0e0e13'), panel: v('bg-panel', '#15151b'), surface: v('bg-surface', '#1b1b22'), hover: v('bg-surface-hover', '#23232b'),
  sel: v('bg-selected', '#2a2a33'), line: v('border', '#2e2e38'), strong: v('border-strong', '#6a6a80'), fg: v('text', '#ececf1'),
  muted: v('text-muted', '#a3a3b0'), subtle: v('text-subtle', '#8b8b99'), action: v('action', '#ececf1'), afg: v('action-fg', '#0e0e13'),
  focus: v('focus', '#8db6fa'), ok: v('success', '#4ade80'), warn: v('warning', '#fbbf24'), bad: v('danger', '#f87171'), info: v('info', '#8db6fa'),
  okS: v('success-soft', '#4ade801f'), warnS: v('warning-soft', '#fbbf241f'), badS: v('danger-soft', '#f871711f'), infoS: v('info-soft', '#8db6fa1f'),
  sans: v('font-sans', "'Inter',system-ui,sans-serif"), mono: v('font-mono', "'JetBrains Mono',monospace"), disp: v('font-display', "'Fredoka','Nunito',sans-serif"),
};
export const APPKIT = `
.stack{display:flex;flex-direction:column;gap:12px}.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cap{font:500 12px/16px ${T.sans};color:${T.subtle};margin:0 0 6px}
.b{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:36px;padding:0 16px;border-radius:10px;font:500 14px/20px ${T.sans};border:1px solid transparent;white-space:nowrap;background:transparent;color:${T.fg}}
.b.p{background:${T.action};color:${T.afg}}.b.s{background:${T.surface};border-color:${T.line}}.b.g{color:${T.muted}}.b.d{color:${T.bad}}
.b.sm{height:32px;padding:0 12px}.b.ic{width:32px;padding:0}.b.round{border-radius:999px}
.badge{display:inline-flex;align-items:center;gap:6px;border-radius:6px;padding:2px 6px;font:500 12px/16px ${T.sans}}
.badge.ok{background:${T.okS};color:${T.ok}}.badge.warn{background:${T.warnS};color:${T.warn}}.badge.bad{background:${T.badS};color:${T.bad}}.badge.info{background:${T.infoS};color:${T.info}}.badge.neu{background:${T.hover};color:${T.muted}}
.dot{width:6px;height:6px;border-radius:50%;background:currentColor;animation:pd 1.2s linear infinite}
@keyframes pd{0%,100%{opacity:1}50%{opacity:.3}}@keyframes spin{to{transform:rotate(360deg)}}
.spin{animation:spin 1s linear infinite}
@media (prefers-reduced-motion:reduce){.dot,.spin{animation:none}}
svg.i{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
svg.i.s14{width:14px;height:14px}svg.i.s18{width:18px;height:18px}
.mono{font-family:${T.mono};font-size:13px;line-height:20px}
.muted{color:${T.muted}}.subtle{color:${T.subtle}}.sm{font-size:14px;line-height:20px}.xs{font-size:12px;line-height:16px}
`;

// Ícones (traços no estilo Lucide, 24×24).
const P = {
  check: '<path d="M20 6 9 17l-5-5"/>', x: '<path d="M18 6 6 18M6 6l12 12"/>', clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  loader: '<path d="M21 12a9 9 0 1 1-6.2-8.6"/>', clip: '<path d="m21.4 11-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>', globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h5M9 13h6M9 17h6"/>', chevR: '<path d="m9 18 6-6-6-6"/>',
  chevD: '<path d="m6 9 6 6 6-6"/>', arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>', arrowDown: '<path d="M12 5v14M19 12l-7 7-7-7"/>', mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 19v3"/>',
  square: '<rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor"/>', shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  gauge: '<path d="m12 14 4-4"/><path d="M3.3 19a10 10 0 1 1 17.4 0"/>', wrench: '<path d="M14.7 6.3a4 4 0 0 0 5 5L22 14l-8 8-2.3-2.3a4 4 0 0 0-5-5L2 10l8-8z"/>',
  alert: '<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3z"/><path d="M12 9v4M12 17h.01"/>', cal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  calPlus: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M12 14v4M10 16h4"/>', brain: '<path d="M12 5a3 3 0 1 0-6 .1 4 4 0 0 0-2.5 5.8A4 4 0 0 0 6 18a3 3 0 0 0 6 .1zM12 5a3 3 0 1 1 6 .1 4 4 0 0 1 2.5 5.8A4 4 0 0 1 18 18a3 3 0 0 1-6 .1z"/>',
  star: '<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/>', more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0"/>', plus: '<path d="M12 5v14M5 12h14"/>', pipette: '<path d="m2 22 1-1h3l9-9M3 21v-3l9-9M15 6l3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3z"/>',
  sliders: '<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>', home: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>', gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" fill="currentColor"/>', fileX: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="m9.5 12.5 5 5M14.5 12.5l-5 5"/>',
};
export const ic = (n, cls = '', style = '') => `<svg class="i ${cls}" viewBox="0 0 24 24"${style ? ` style="${style}"` : ''} aria-hidden="true">${P[n]}</svg>`;
let fid = 0;
/** Faísca inline; abaixo de 48 px usa o nível simples e sem ícone flutuante, como manda o design system. */
export const F = (size, color = '#3b82f6', state = 'idle') => {
  const rich = size >= 48; const id = `ff${fid++}`;
  return `<svg viewBox="-4 -8 128 128" width="${size}" height="${size}" aria-hidden="true" style="flex:none">${rich ? `<defs>${furFilter(id)}</defs>` : ''}${faiscaInner({ color, state, rich, withBubble: rich, ground: false, furId: id })}</svg>`;
};
export const card = (tone, title, icon, body, actions = '', mascot = '') => `<section class="cf" style="border-left-color:${tone}"><div class="cb">${mascot}<div style="min-width:0"><p class="ct">${mascot ? '' : ic(icon, 's14')}${title}</p><div class="cc">${body}</div></div></div>${actions ? `<div class="ca">${actions}</div>` : ''}</section>`;
export const CARD_CSS = `.cf{display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px 16px;border-radius:10px;border-left:3px solid;background:${T.surface};padding:12px 16px;animation:ci .15s ${v('ease-out', 'cubic-bezier(.16,1,.3,1)')}}
@keyframes ci{from{opacity:0;transform:translateY(4px)}}.cb{display:flex;align-items:flex-start;gap:12px;flex:1 1 16rem;min-width:0}
.ct{display:flex;align-items:center;gap:6px;margin:0 0 4px;font:500 12px/16px ${T.sans};color:${T.muted}}.cc{font-size:14px;line-height:20px;color:${T.fg}}.ca{display:flex;align-items:center;gap:8px;flex:none}`;
const BOT = '#60a5fa';

export const APP_COMPONENTS = [
  // ===== Conversa =====
  ['Thread', 'group="Conversa" height=560 subtitle="mensagens, Faísca do bot, trabalhando, fila e novas mensagens"',
    `.col{max-width:760px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
.me{margin-left:auto;max-width:80%;border-radius:16px;background:${T.surface};padding:8px 16px;font-size:15px;line-height:24px;white-space:pre-wrap}
.br{display:flex;gap:8px}.br .mk{width:24px;flex:none}.bub{width:fit-content;max-width:100%;border-radius:16px;border:1px solid ${T.line};background:${T.panel};padding:8px 16px;font-size:15px;line-height:24px}
.bub ul{margin:8px 0 0;padding-left:24px}.bub code{font:13px ${T.mono};background:${T.surface};border-radius:6px;padding:1px 5px}
.work{display:flex;align-items:center;gap:8px;height:40px;color:${T.muted};font-size:14px}
.q{margin-left:auto;display:flex;flex-direction:column;align-items:flex-end;gap:4px;max-width:80%}
.pane{position:relative;padding-bottom:48px}.nm{position:absolute;bottom:0;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:6px;border-radius:999px;border:1px solid ${T.strong};background:${T.surface};padding:6px 12px;font:500 14px/20px ${T.sans};box-shadow:0 8px 24px rgb(0 0 0/.4)}
.empty{display:flex;flex-direction:column;align-items:center;gap:16px;padding:8px 0 16px;text-align:center}.empty h2{margin:0;font:600 28px/36px ${T.sans}}`,
    `<div class="empty">${F(112, BOT)}<h2>O que o <span style="color:#8db6fa">Resumo das manhãs</span> faz agora?</h2></div>
<div class="pane"><div class="col" role="log" aria-label="Conversa">
<div class="me">Resume os e-mails de hoje e me diz o que precisa de resposta.</div>
<div class="br"><div class="mk">${F(24, BOT)}</div><div class="bub">Três pedem resposta ainda hoje:<ul><li>contrato da agência, prazo às 18h;</li><li>reunião de sexta, confirmar horário;</li><li>fatura <code>#4821</code>, valor diverge.</li></ul></div></div>
<div class="work">${F(32, BOT, 'working')}Trabalhando…</div>
<div class="q"><div class="me" style="margin:0;max-width:100%">E agenda a reunião para as 10h.</div><span class="badge info">Na fila</span></div>
</div><span class="nm">Novas mensagens ${ic('arrowDown')}</span></div>`, '',
    `# Thread

Lista de mensagens da conversa (conversation/thread.tsx), \`role="log"\`, coluna de até 760 px com gap de 16 px.

- Conversa vazia: Faísca do bot a 112 px com halo, \`enter\` e olhar que segue o cursor; título em sans 28/36 no desktop e 24/32 no celular, "O que o {nome} faz agora?", com o nome na cor legível do bot. No Chat geral: Faísca em faisca e "No que posso ajudar?".
- Mensagem do dono: bolha bg-surface à direita, raio radius-lg, até 80% (88% no celular).
- Resposta do bot: Faísca de 24 px parada na coluna da esquerda (só no primeiro bloco), bolha bg-panel com borda border e Markdown.
- "Trabalhando…": Faísca de 32 px em working ao lado do texto em text-muted. É o único ponto animado da conversa.
- Fila: a mensagem enfileirada leva o selo info "Na fila".
- "Novas mensagens": pílula flutuante bg-surface com borda border-strong e sombra shadow-float, centralizada no rodapé.
`],

  ['ActivityBlock', 'group="Conversa" height=470 subtitle="atividade das ferramentas, ao vivo e expandida"',
    `ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.ar{display:flex;align-items:center;gap:8px;min-height:28px;width:100%;font-size:14px;line-height:20px;color:${T.muted};border-radius:6px}
.ar .l{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ar .cv{transition:transform .15s}.ar.open .cv{transform:rotate(90deg)}
.grp{border-left:1px solid ${T.line};padding-left:12px;margin-top:2px}
.det{display:flex;flex-direction:column;gap:8px;padding:6px 0 4px 24px}.lab{margin:0 0 4px;font:500 12px/16px ${T.sans};color:${T.subtle}}
pre{margin:0;max-height:17rem;overflow:auto;white-space:pre-wrap;border-radius:6px;background:${T.surface};padding:8px;font:13px/20px ${T.mono};color:${T.muted}}
.hit{border-radius:6px;background:${T.surface};padding:8px}.hit a{font-size:14px;color:${T.info};text-decoration:underline;text-underline-offset:4px}`,
    `<ul aria-label="Atividade">
<li><div class="ar">${ic('loader', 'spin')}<span class="l">Buscando no Gmail</span>${ic('chevR', 'cv')}</div></li>
<li><div class="ar">${ic('clock', '', `color:${T.warn}`)}<span class="l">Enviar e-mail para contabilidade<span class="xs" style="margin-left:8px;color:${T.warn}">Aguardando aprovação</span></span>${ic('chevR', 'cv')}</div></li>
<li><div class="ar">${ic('x', '', `color:${T.bad}`)}<span class="l">Criar evento no Google Agenda</span>${ic('chevR', 'cv')}</div></li>
<li><div class="ar">${ic('check', '', `color:${T.ok}`)}<span class="l">3 ações executadas</span>${ic('chevR', 'cv')}</div></li>
<li><div class="ar open">${ic('globe')}<span class="l">Pesquisa na web</span>${ic('chevR', 'cv')}</div>
<div class="det"><span class="xs subtle">Consulta: melhor época para visitar Florianópolis</span>
<div class="hit"><a href="#">Clima em Florianópolis por mês</a><div class="mono xs subtle" style="font-size:12px">climatempo.com.br/floripa</div></div>
<span class="xs subtle">Conteúdo da web: o bot o trata como dado, não como instrução.</span></div></li>
<li><div class="ar open">${ic('check', '', `color:${T.ok}`)}<span class="l">Ler planilha de gastos</span>${ic('chevR', 'cv')}</div>
<div class="det"><span class="mono subtle">GOOGLESHEETS_BATCH_GET</span><div><p class="lab">Argumentos</p><pre>{ "range": "Outubro!A1:D40" }</pre></div><div><p class="lab">Resultado</p><pre>38 linhas · total R$ 4.212,90</pre></div></div></li>
</ul>`, '',
    `# ActivityBlock

Atividade das ferramentas dentro da coluna do bot (conversation/activity-block.tsx). Cada linha mostra estado, rótulo e seta para expandir.

- Ícones de estado (16 px, traço 1.5): rodando LoaderCircle girando; aguardando Clock em warning com o texto "Aguardando aprovação"; falhou X em danger; concluído Check em success, ou Search, Globe, FileText e Paperclip conforme a ferramenta.
- Duas ou mais atividades seguidas viram um grupo: "Executando N ações", "N ações executadas", "…, M com falha", com a lista recuada por um fio border.
- Expandido: slug em mono text-subtle, blocos "Argumentos" e "Resultado" em pre bg-surface até 17rem; pesquisa e leitura da web listam resultados com link em info e a nota "Conteúdo da web: o bot o trata como dado, não como instrução."
- Não existe exibição de raciocínio ("thinking") no app hoje: a espera é coberta por "Trabalhando…" e por estas linhas.
`],

  ['Composer', 'group="Conversa" height=420 subtitle="mensagem, anexos, modelo, effort, ditado, enviar e parar"',
    `.cmp{max-width:760px;display:flex;flex-direction:column;gap:8px;border-radius:24px;border:1px solid ${T.line};background:${T.surface};padding:12px}
.cmp textarea{all:unset;min-height:24px;font-size:15px;line-height:24px;color:${T.fg}}.cmp textarea::placeholder{color:${T.subtle}}
.chips{display:flex;flex-wrap:wrap;gap:8px}.chip{position:relative;display:flex;align-items:center;gap:8px;border-radius:10px;border:1px solid ${T.line};background:${T.hover}}
.chip.img{width:56px;height:56px;background:linear-gradient(135deg,#334155,#1e293b)}.chip.doc{height:40px;padding:0 8px}.chip.err{border-color:${T.bad}}
.chip .x{position:absolute;right:2px;top:2px;width:20px;height:20px;border-radius:50%;background:rgb(14 14 19/.8);display:grid;place-items:center}
.tb{display:flex;align-items:center;justify-content:flex-end;gap:8px}.trg{display:flex;align-items:center;gap:4px;height:32px;padding:0 8px;border-radius:10px;font-size:14px;color:${T.muted}}
.dict{display:flex;align-items:center;gap:8px;font-size:12px;color:${T.muted}}.dict i{width:8px;height:8px;border-radius:50%;background:${T.info};animation:pd 1.2s linear infinite}
.mic-on{background:${T.infoS};color:${T.info};box-shadow:inset 0 0 0 1px ${T.info}}`,
    `<div class="stack">
<form class="cmp" onsubmit="return false"><textarea aria-label="Mensagem" placeholder="Escreva uma mensagem"></textarea>
<div class="tb"><span class="b g ic" style="margin-right:auto" aria-label="Anexar arquivo">${ic('clip')}</span><span class="trg">deepseek-v4.1-flash ${ic('chevD')}</span><span class="trg">Padrão ${ic('chevD')}</span><span class="b g ic" aria-label="Ditar">${ic('mic')}</span><span class="b p ic round" aria-label="Enviar mensagem" style="opacity:.5">${ic('arrowUp', '', 'stroke-width:2')}</span></div></form>
<form class="cmp" onsubmit="return false"><div class="chips" aria-label="Arquivos anexados"><span class="chip img"><span class="x">${ic('x', 's14')}</span></span><span class="chip doc">${ic('file', '', `color:${T.muted}`)}<span><span class="sm" style="display:block">contrato-agencia.pdf</span><span class="xs muted">PDF · 212 KB</span></span></span><span class="chip doc err">${ic('file', '', `color:${T.muted}`)}<span><span class="sm" style="display:block">planilha.xlsx</span><span class="xs" style="color:${T.bad}">Formato não aceito</span></span></span></div>
<div class="dict"><i></i>Ouvindo… o áudio é processado pelo navegador.</div>
<textarea aria-label="Mensagem">Confere esse contrato e me diz os pontos de atenção</textarea>
<div class="tb"><span class="b g ic" style="margin-right:auto">${ic('clip')}</span><span class="trg">kimi-k2.5 ${ic('chevD')}</span><span class="trg">Alto ${ic('chevD')}</span><span class="b g ic mic-on" aria-label="Parar ditado">${ic('mic')}</span><span class="b p ic round" aria-label="Enviar mensagem">${ic('arrowUp', '', 'stroke-width:2')}</span></div></form>
<div class="row"><span class="xs subtle">Bot trabalhando e campo vazio:</span><span class="b p ic round" aria-label="Parar execução">${ic('square', 's14')}</span></div>
</div>`, '',
    `# Composer

Campo de mensagem da conversa (conversation/composer.tsx): bg-surface, borda border, raio 24 px (radius-xl), padding 12 px, até 760 px; o anel focus vai no formulário inteiro quando o campo tem foco.

- Campo: cresce até 40 dvh, 16 px no celular e 15/24 no desktop, placeholder "Escreva uma mensagem" ou o motivo do bloqueio ("Configure um provedor para conversar.").
- Anexos acima do texto: miniatura de 56 px para imagem, chip de 40 px para documento ("PDF · 212 KB"), borda danger com a mensagem quando falha.
- Barra: anexar (Paperclip) à esquerda; seletor de modelo e de effort (texto muted com seta); microfone; botão redondo primário.
- Botão redondo: ArrowUp para enviar (50% sem texto), quadrado cheio para parar quando o bot trabalha e o campo está vazio, LoaderCircle enquanto envia ou para.
- Ditado: microfone em info-soft com contorno info pulsando e a linha "Ouvindo… o áudio é processado pelo navegador.".
`],

  ['SystemCard', 'group="Cartões" height=520 subtitle="moldura dos cartões de sistema e suas variantes"',
    CARD_CSS,
    `<div class="stack">
${card(BOT, 'Execução interrompida', 'square', `<span class="muted">Etapas concluídas:</span><ul style="margin:4px 0 0;padding-left:20px;color:${T.muted}"><li>Buscou 12 e-mails</li><li>Leu a planilha de gastos</li></ul><p style="margin:8px 0 0;color:${T.warn}">Estas ações podem ter sido concluídas: enviar e-mail.</p>`)}
${card(T.warn, 'Limite atingido', 'gauge', 'O limite de chamadas de ferramenta desta execução foi atingido.', '', F(32, BOT, 'error'))}
${card(T.warn, 'Modelo sem ferramentas', 'wrench', `O modelo <span class="mono">glm-5</span> não chama ferramentas, então esta execução segue sem as ações do Composio.`)}
${card(T.bad, 'A execução falhou', 'alert', 'O provedor demorou demais para responder.', '<span class="b s sm">Tentar novamente</span>', F(32, BOT, 'error'))}
</div>`, '',
    `# SystemCard

Moldura dos cartões de sistema na conversa (conversation/card-frame.tsx): bg-surface, raio radius-md, padding 12 × 16, borda esquerda de 3 px no tom do cartão, entrada de 150 ms.

- Tom: cor do bot (neutro), warning (atenção) ou danger (falha).
- Título em 12 px text-muted com ícone de 14 px; quando há Faísca (32 px, parada exceto em waiting), ela substitui o ícone.
- Ações à direita; no celular descem para baixo do texto.
- Variantes: Execução interrompida, Limite atingido (Faísca em erro), Modelo sem ferramentas, A execução falhou (Faísca em erro e "Tentar novamente").
`],

  ['ApprovalCard', 'group="Cartões" height=330 subtitle="aprovação pendente e respondida"',
    CARD_CSS + `dl{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:8px 0 0;font:13px/20px ${T.mono}}dt{color:${T.subtle}}dd{margin:0;color:${T.muted}}`,
    `<div class="stack">
${card(T.warn, 'Aprovação pendente', 'shield', `<div style="font-weight:500">Enviar e-mail</div><div class="mono subtle">GMAIL_SEND_EMAIL</div><dl><dt>para</dt><dd>contabilidade@exemplo.com</dd><dt>assunto</dt><dd>Fatura #4821</dd></dl><p class="xs subtle" style="margin:8px 0 0">Expira em 3 h</p>`, `<span class="b p sm">Permitir uma vez</span><span class="b s sm">Negar</span><span class="b s ic" aria-label="Mais opções de resposta">${ic('chevD')}</span>`, F(32, '#4ade80', 'waiting'))}
${card(BOT, 'Aprovação', 'shield', `<div class="row"><span>Enviar e-mail</span><span class="badge ok">Aprovada</span><span class="xs subtle">(sempre permitir)</span></div>`)}
${card(BOT, 'Aprovação', 'shield', `<div class="row"><span>Criar evento</span><span class="badge bad">Negada</span></div>`)}
</div>`, '',
    `# ApprovalCard

Pedido de aprovação na conversa (conversation/approval-card.tsx).

- Pendente: tom warning, Faísca do bot em waiting (32 px, é a única que se mexe na lista de cartões), nome da ação, slug em mono, parâmetros em lista mono, "Expira em 3 h".
- Ações: primário "Permitir uma vez", secundário "Negar" e, em bots, o menu "Mais opções de resposta" com "Sempre permitir" e "Negar sempre".
- Respondida: tom do bot, sem Faísca, nome da ação e selo Aprovada (success), Negada (danger), Expirada (warning) ou Cancelada (info).
`],

  ['RoutineCard', 'group="Cartões" height=420 subtitle="rotina executada, proposta e alteração"',
    CARD_CSS,
    `<div class="stack">
${card(BOT, 'Rotina “Resumo das 9h” concluída', 'cal', '<span class="muted">Previsto para 09:00 · iniciou 09:00 · terminou 09:02</span>', '<span class="b g sm">Ver rotina</span>', F(32, BOT, 'done'))}
${card(BOT, 'Proposta de rotina', 'calPlus', `<div style="font-weight:500">Resumo das manhãs</div><div class="muted">Dias úteis às 07:00 · America/Sao_Paulo</div><p class="xs subtle" style="margin:8px 0 2px;font-weight:500">Instrução que a rotina vai executar</p><div class="muted">Leia os e-mails não lidos e resuma o que pede resposta.</div><ol class="xs muted" style="margin:8px 0 0;padding-left:18px"><li>seg., 12/10 às 07:00</li><li>ter., 13/10 às 07:00</li></ol>`, '<span class="b p sm">Confirmar</span><span class="b s sm">Editar</span>')}
${card(T.warn, 'Pausar a rotina “Resumo das 9h”', 'cal', 'A rotina deixa de rodar e as execuções que ainda não começaram saem da fila, até ser retomada.', '<span class="badge warn">Desatualizada</span>')}
</div>`, '',
    `# RoutineCard

Cartões de rotina na conversa (conversation/routine-card.tsx).

- Execução: "Rotina “X” iniciada/concluída/falhou/interrompida/atingiu o limite/expirou"; Faísca só no fim (done ou error); ação "Ver rotina".
- Perdida: tom warning, CalendarX, explica que o serviço estava parado.
- Proposta: nome, resumo da agenda com fuso, instrução recolhível ("Mostrar mais"), próximas execuções; "Confirmar" e "Editar", depois selo "Confirmada".
- Alteração (alterar, pausar, retomar, excluir): campo "antigo → novo", efeito explicado, "Confirmar" ou perigo "Excluir"; selo "Desatualizada" quando a rotina mudou depois.
`],

  ['MemoryCard', 'group="Cartões" height=250 subtitle="memória atualizada com diff"',
    CARD_CSS + `.diff{list-style:none;margin:0;padding:0;border-radius:6px;overflow:hidden;font:13px/20px ${T.mono}}.diff li{display:flex;gap:8px;padding:0 8px}.diff .a{background:${T.okS}}.diff .r{background:${T.badS}}.diff .s{color:${T.subtle}}.diff b{width:12px;font-weight:400}`,
    card(BOT, 'Memória atualizada', 'brain', `<ul class="diff" aria-label="Mudanças na memória"><li class="s"><b> </b>Prefere respostas em lista.</li><li class="r"><b style="color:${T.bad}">−</b>Reunião de equipe às segundas.</li><li class="a"><b style="color:${T.ok}">+</b>Reunião de equipe às terças, 10h.</li></ul><p class="xs subtle" style="margin:4px 0 0">+1 −1 linhas · 1.234 / 8.000 caracteres · <a href="#" style="color:inherit">Ver memória</a></p>`, '<span class="b g sm">Desfazer</span>'), '',
    `# MemoryCard

Cartão "Memória atualizada" (conversation/memory-card.tsx) com o MemoryDiff (memory/memory-diff.tsx).

- Diff em mono 13/20: linha adicionada em success-soft com "+" success, removida em danger-soft com "−" danger, igual em text-subtle.
- Rodapé: "+N −M linhas · 1.234 / 8.000 caracteres · Ver memória".
- Ação ghost "Desfazer"; depois, selo info "Desfeita".
`],

  ['ConversationHeader', 'group="Conversa" height=250 subtitle="cabeçalho com Faísca, estado e ações; banner de configuração"',
    `.hd{display:flex;align-items:center;gap:12px;height:52px;padding:0 16px;border-bottom:1px solid ${T.line}}.hd h1{flex:1;min-width:0;margin:0;font:500 14px/20px ${T.sans};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ban{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;border-radius:16px;border:1px solid ${T.line};background:${T.surface};padding:12px;font-size:14px;margin-top:12px}`,
    `<div class="hd">${F(32, BOT, 'working')}<h1 style="color:#8db6fa">Resumo das manhãs</h1><span class="badge info"><span class="dot"></span>Trabalhando</span><span class="b g ic" aria-label="Arquivos do bot">${ic('clip')}</span><span class="b g ic" aria-label="Memória do bot">${ic('brain')}</span><span class="b g ic" aria-label="Configurações do bot">${ic('sliders')}</span></div>
<div class="hd">${F(32, '#3b82f6')}<h1>Viagem para Floripa</h1><span class="badge warn">Aguardando aprovação</span></div>
<div class="ban"><span>Configure um provedor para conversar.</span><span class="b s sm">Abrir Provedores</span></div>`, '',
    `# ConversationHeader

Cabeçalho da conversa (conversation/conversation-view.tsx), 52 px.

- Bot: Faísca de 32 px no estado ao vivo (anima só em working e waiting) e nome na cor legível do bot.
- Chat geral: Faísca de 32 px em faisca e o título da sessão. Substitui o marcador de conversa da phase 1.
- RunBadge: info com ponto pulsando "Trabalhando", ou warning "Aguardando aprovação".
- Ações do bot: Arquivos (Paperclip), Memória (Brain), Configurações (SlidersHorizontal), ghost de ícone com tooltip.
- Celular: "Voltar" à esquerda, o estado vira uma segunda linha sob o nome e as três ações vão para o menu "Mais ações".
- SetupBanner: cartão bg-surface com o motivo e o link secundário ("Abrir Provedores", "Abrir Chat geral").
`],

  ['AttachmentList', 'group="Conversa" height=200 subtitle="anexos dentro da mensagem"',
    `.al{display:flex;flex-wrap:wrap;gap:8px;max-width:420px}.th{width:96px;height:96px;border-radius:10px;border:1px solid ${T.line};background:linear-gradient(135deg,#334155,#1e293b)}
.th.off{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;background:${T.hover};color:${T.muted}}
.dc{display:flex;align-items:center;gap:8px;width:100%;height:40px;padding:0 8px;border-radius:10px;border:1px solid ${T.line};background:${T.hover};font-size:14px}.dc.rm{border-style:dashed;background:transparent;color:${T.muted}}`,
    `<div class="al"><span class="th" role="img" aria-label="Abrir imagem recibo.jpg"></span><span class="th off">${ic('x')}<span class="xs">Indisponível</span></span>
<a class="dc" href="#" style="color:${T.fg};text-decoration:none">${ic('file', '', `color:${T.muted}`)}<span>contrato-agencia.pdf</span><span class="xs muted" style="margin-left:auto">PDF · 212 KB</span></a>
<span class="dc rm">${ic('fileX')}Arquivo removido: rascunho.docx</span></div>`, '',
    `# AttachmentList

Anexos dentro das mensagens (conversation/attachment-list.tsx).

- Imagem: miniatura de 96 px (72 px no celular, 40 px compacta) com borda border; abre o visualizador em modal de até 960 px.
- Documento: linha de 40 px com FileText, nome e "PDF · 212 KB"; baixa o texto extraído.
- Indisponível: ImageOff e "Indisponível". Removido: borda tracejada, "Arquivo removido: {nome}".
`],

  // ===== Modelos =====
  ['ModelSelector', 'group="Modelos" height=520 subtitle="busca, favoritos, teste e effort"',
    `.pop{width:340px;border-radius:16px;border:1px solid ${T.line};background:${T.surface};box-shadow:0 8px 24px rgb(0 0 0/.4);overflow:hidden}
.sb{display:flex;align-items:center;gap:8px;border-bottom:1px solid ${T.line};padding:12px;color:${T.subtle};font-size:14px}
.ls{padding:4px;max-height:300px;overflow:auto}.h{margin:0;padding:8px 8px 4px;font:500 12px/16px ${T.sans};letter-spacing:.04em;text-transform:uppercase;color:${T.subtle}}
.mr{display:flex;align-items:center;gap:2px;padding-right:4px;border-radius:6px}.mr:hover,.mr.hl{background:${T.hover}}
.pk{display:flex;align-items:center;gap:8px;flex:1;min-width:0;min-height:40px;padding:0 8px;font-size:14px}.pk .n{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ck{width:16px;flex:none}.b.fav{color:${T.warn}}.b.fav svg{fill:currentColor}.tl{display:flex;align-items:center;gap:6px;padding:0 32px 8px;font-size:12px;color:${T.muted}}
.ef{border-top:1px solid ${T.line};padding:12px}.trk{position:relative;height:28px;border-radius:999px;border:1px solid ${T.line};background:${T.app}}
.fill{position:absolute;inset:0 auto 0 0;width:62%;border-radius:999px;background:${T.strong}}.thumb{position:absolute;top:3px;left:calc(62% - 22px);width:20px;height:20px;border-radius:50%;background:${T.action};box-shadow:0 1px 4px rgb(0 0 0/.5)}
.tk{position:absolute;top:12px;width:4px;height:4px;border-radius:50%;background:${T.subtle}}`,
    `<div class="pop" role="dialog" aria-label="Selecionar modelo" data-anim="pop"><div class="sb">${ic('search')}Buscar modelo</div><div class="ls">
<p class="h">Favoritos</p>
<div class="mr hl"><span class="pk"><span class="ck">${ic('check', '', 'stroke-width:2')}</span><span class="n">deepseek-v4.1-flash</span><span class="badge ok">Liberado</span></span><span class="b g ic fav" aria-pressed="true" aria-label="Favoritar deepseek-v4.1-flash">${ic('star')}</span><span class="b g ic">${ic('more')}</span></div>
<div class="mr"><span class="pk"><span class="ck"></span><span class="n">kimi-k2.5</span><span class="badge ok">Liberado</span></span><span class="b g ic fav" aria-pressed="true">${ic('star')}</span><span class="b g ic">${ic('more')}</span></div>
<p class="h">Todos os modelos</p>
<div class="mr"><span class="pk"><span class="ck"></span><span class="n">glm-5</span><span class="badge warn">Sem ferramentas</span></span><span class="b g ic" aria-pressed="false">${ic('star')}</span><span class="b g ic">${ic('more')}</span></div>
<div class="mr"><span class="pk"><span class="ck"></span><span class="n">qwen3.6-plus</span></span><span class="b g ic" aria-pressed="false">${ic('star')}</span><span class="b g ic">${ic('more')}</span></div>
<div class="tl">${ic('loader', 'spin s14')}Testando modelo…</div>
</div><div class="ef"><div style="display:flex;align-items:baseline;gap:8px;margin-bottom:4px"><span class="h" style="padding:0">Effort</span><span class="sm" style="font-weight:500">Alto</span></div>
<div class="trk"><span class="fill"></span><span class="tk" style="left:10%"></span><span class="tk" style="left:26%"></span><span class="tk" style="left:42%"></span><span class="tk" style="left:58%"></span><span class="tk" style="left:74%"></span><span class="tk" style="left:90%"></span><span class="thumb"></span></div></div></div>`, '',
    `# ModelSelector

Seletor de modelo (models/model-selector.tsx): popover de 340 px no desktop, BottomSheet de 70 dvh no celular.

- Busca "Buscar modelo" no topo.
- Seção "Favoritos" (só quando há algum, na ordem em que foram favoritados) e "Todos os modelos"; títulos 12 px em maiúsculas text-subtle.
- Linha: Check no selecionado, nome, selo do teste (Liberado success, Sem ferramentas warning, Falhou danger), estrela e "Mais ações".
- Favorito: estrela cheia em warning (ligado) ou contorno text-muted (desligado); botão com \`aria-pressed\` e rótulo "Favoritar {modelo}".
- Testando: "Testando modelo…" com LoaderCircle. Falha: "Falhou: {motivo}" em danger.
- Rodapé EffortControl quando o modelo aceita effort: rótulo "Effort", valor atual e trilho de 28 px (40 px no celular) com pontos por nível e polegar action de 20 px. Trocar o modelo volta o effort para "Padrão".
`],

  ['ModelField', 'group="Modelos" height=170 subtitle="campo de modelo padrão no editor"',
    `.mf{max-width:360px}.lb{display:block;margin-bottom:6px;font:500 14px/20px ${T.sans}}.tr{display:flex;align-items:center;justify-content:space-between;height:36px;border-radius:10px;border:1px solid ${T.strong};background:${T.surface};padding:0 12px;font-size:14px}`,
    `<div class="mf"><span class="lb">Modelo padrão</span><div class="tr">deepseek-v4.1-flash · Alto ${ic('chevD')}</div><p class="xs subtle" style="margin:6px 0 0">Sem modelo padrão, o bot usa o primeiro favorito.</p></div>`, '',
    `# ModelField

Campo "Modelo padrão" do editor de bot e de Configurações → Chat geral (models/model-field.tsx): parece um Input e abre o ModelSelector.

- Valor: "modelo · effort", "Sem modelo padrão", "Escolher modelo", "Configure um provedor" ou "Carregando…" (text-muted quando vazio ou bloqueado).
- Ajuda em 12 px text-subtle: "Sem modelo padrão, o bot usa o primeiro favorito."
- Erro: borda danger e mensagem abaixo.
`],

  // ===== Bots =====
  ['BotList', 'group="Bots" height=380 subtitle="lista de bots com a Faísca e o estado ao vivo"',
    `ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;max-width:264px;background:${T.panel};padding:8px;border-radius:12px}
.it{display:flex;align-items:center;gap:8px;height:44px;padding:0 12px;border-radius:6px}.it.on{background:${T.sel}}
.n{font:500 14px/20px ${T.sans}}.s{font:500 12px/16px ${T.sans}}.arc{display:flex;align-items:center;gap:4px;height:32px;margin-top:16px;padding:0 12px;font:500 12px/16px ${T.sans};letter-spacing:.04em;text-transform:uppercase;color:${T.subtle}}`,
    `<ul aria-label="Bots">
<li class="it on">${F(24, BOT, 'working')}<div><div class="n">Resumo das manhãs</div><div class="s" style="color:${T.info}">Trabalhando…</div></div></li>
<li class="it">${F(24, '#4ade80', 'waiting')}<div><div class="n">Financeiro</div><div class="s" style="color:${T.warn}">Aguardando aprovação</div></div></li>
<li class="it">${F(24, '#f472b6', 'done')}<div><div class="n">Conteúdo</div><div class="s" style="color:${T.ok}">Concluiu agora</div></div></li>
<li class="it">${F(24, '#fb923c', 'error')}<div><div class="n">Viagens</div><div class="s" style="color:${T.bad}">Última execução falhou</div></div></li>
<li class="it">${F(24, '#a78bfa')}<div><div class="n">Estudos</div><div class="s muted">Livre</div></div></li>
<li class="arc">${ic('chevR', 's14')}Arquivados<span style="margin-left:auto;text-transform:none;font-weight:400">2</span></li></ul>`, '',
    `# BotList

Lista de bots do painel (bots/bots-panel.tsx) e base da lista "Seus bots" do Início no celular.

- Item de 44 px: Faísca de 24 px na cor do bot (anima só em working e waiting), nome 14 px e linha de estado 12 px.
- Estados: Trabalhando… (info), Aguardando aprovação (warning), Concluiu agora (success), Última execução falhou (danger), Livre ou Arquivado/Rotinas pausadas (muted).
- Ativo em bg-selected. "Arquivados" recolhível no fim, com a contagem.
`],

  ['ColorPicker', 'group="Bots" height=230 subtitle="cor do bot: 12 da paleta e personalizada"',
    `.sw{display:flex;flex-wrap:wrap;gap:12px;padding:4px 0}.c{position:relative;width:28px;height:28px;border-radius:50%;display:grid;place-items:center}.c.on{box-shadow:0 0 0 2px ${T.app},0 0 0 4px ${T.fg}}
.c.cu{border:1px dashed ${T.strong};color:${T.muted}}.prev{display:flex;align-items:center;gap:12px;margin-top:12px}`,
    `<p style="margin:0 0 6px;font:500 14px/20px ${T.sans}">Cor</p><div class="sw" role="radiogroup" aria-label="Cor">${['#f87171', '#fb923c', '#fbbf24', '#a3e635', '#4ade80', '#2dd4bf', '#22d3ee', '#60a5fa', '#818cf8', '#a78bfa', '#f472b6', '#9ca3af'].map((c, i) => `<span class="c${i === 7 ? ' on' : ''}" style="background:${c}" role="radio" aria-checked="${i === 7}">${i === 7 ? ic('check', '', 'color:#0e0e13;stroke-width:2.5') : ''}</span>`).join('')}<span class="c cu" aria-label="Personalizada">${ic('pipette', 's14')}</span></div>
<div class="prev">${F(56, '#60a5fa')}${F(56, '#4ade80')}${F(56, '#fbbf24')}<span class="xs muted" style="max-width:220px">A cor escolhida vira o corpo da Faísca do bot. A estrela e o rosto não mudam.</span></div>`, '',
    `# ColorPicker

Escolha da cor do bot (bots/color-picker.tsx): 12 círculos de 28 px da paleta bot-* e um 13º "Personalizada" tracejado com Pipette, que abre o campo hexadecimal.

- Selecionado: anel de 2 px em text com afastamento bg-app e Check na cor legível sobre a cor.
- Cor de pouco contraste: aviso em warning, "Cor com pouco contraste.", mas é aceita.
- Phase 5: a grade "Personagem" sai do editor; a cor passa a ser a única escolha visual do bot, e a prévia mostra a Faísca nela.
`],

  ['StatusBadge', 'group="Base" height=110 subtitle="selos de estado"',
    '',
    `<div class="row"><span class="badge ok">Concluída</span><span class="badge warn">Aguardando aprovação</span><span class="badge bad">Falhou</span><span class="badge info">Na fila</span><span class="badge neu">Arquivado</span><span class="badge info"><span class="dot"></span>Trabalhando</span></div>`, '',
    `# StatusBadge

Selo de estado (settings/status-badge.tsx): raio radius-sm, padding 2 × 6, 12 px peso 500.

- Tons: success, warning, danger e info sobre o respectivo -soft; neutro em bg-surface-hover com text-muted.
- O selo sempre leva texto; a cor nunca é a única informação. "Trabalhando" ganha o ponto pulsante.
`],

  ['SegmentedControl', 'group="Base" height=170 subtitle="regra de aprovação e tipo de agenda"',
    `.sg{display:inline-flex;border-radius:10px;border:1px solid ${T.line};background:${T.surface};padding:2px}.sg span{height:32px;display:inline-flex;align-items:center;padding:0 12px;border-radius:6px;font:500 14px/20px ${T.sans};color:${T.muted}}.sg .on{background:${T.sel}}
.days{display:flex;gap:6px}.days span{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;font:500 14px/1 ${T.sans};border:1px solid ${T.strong};background:${T.surface};color:${T.muted}}.days .on{background:${T.action};color:${T.afg};border-color:transparent}`,
    `<div class="stack"><div class="sg" role="radiogroup"><span class="on" style="color:${T.ok}">Permitir</span><span>Perguntar</span><span>Negar</span><span>Neutro</span></div>
<div class="sg"><span>Única</span><span>Intervalo</span><span class="on" style="color:${T.fg}">Diária</span><span>Semanal</span><span>Mensal</span><span>Cron</span></div>
<div class="days" role="group" aria-label="Dias da semana">${['S', 'T', 'Q', 'Q', 'S', 'S', 'D'].map((d, i) => `<span class="${i < 5 ? 'on' : ''}">${d}</span>`).join('')}</div></div>`, '',
    `# SegmentedControl

Controle segmentado (approvals/segmented-control.tsx), usado nas regras de aprovação e no tipo de agenda da rotina.

- Grupo bg-surface com borda border e 2 px de folga; opção de 32 px (40 px no celular).
- Ativa em bg-selected; texto success em "Permitir", danger em "Negar", text nos demais.
- Dias da semana (routines/schedule-builder.tsx): pílulas redondas de 36 px, ligadas em action.
`],

  // ===== Configurações e avisos =====
  ['NotificationNotice', 'group="Avisos" height=120 subtitle="faixa para ativar notificações"',
    `.nn{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;border-bottom:1px solid ${T.line};background:${T.surface};padding:8px 16px}.nn p{flex:1 1 14rem;margin:0;font-size:14px;line-height:20px}`,
    `<section class="nn" aria-label="Aviso de notificações">${ic('bell', '', `color:${T.muted}`)}<p>Receba um aviso quando um bot terminar, falhar ou pedir a sua aprovação.</p><span class="b s sm">Ativar notificações</span><span class="b g sm">Agora não</span></section>`, '',
    `# NotificationNotice

Faixa acima do conteúdo (push/notification-notice.tsx) que oferece ativar notificações; some quando não há o que oferecer.

- bg-surface com fio inferior border, sino text-muted, texto 14 px, "Ativar notificações" secundário e "Agora não" ghost.
- Erro: "Não foi possível ativar as notificações. Tente de novo."
`],

  ['FileRow', 'group="Configurações" height=200 subtitle="arquivos e atividades"',
    `ul{list-style:none;margin:0;padding:0;border-radius:12px;overflow:hidden;border:1px solid ${T.line}}li{display:flex;align-items:center;gap:8px;min-height:56px;border-bottom:1px solid ${T.line};background:${T.surface};padding:8px 4px 8px 12px}li:last-child{border:0}
.tm{width:40px;height:40px;border-radius:10px;background:${T.hover};display:grid;place-items:center;color:${T.muted}}`,
    `<ul><li><input type="checkbox" aria-label="Selecionar contrato-agencia.pdf"><span class="tm">${ic('file')}</span><div style="flex:1;min-width:0"><div class="sm" style="font-weight:500">contrato-agencia.pdf</div><div class="xs muted row" style="gap:4px">Documento · 212 KB · há 2 h<span class="badge info">Em uso</span></div><div class="xs muted row" style="gap:4px;margin-top:4px">${F(24, '#4ade80')}Financeiro</div></div><span class="b g ic">${ic('more')}</span></li>
<li><input type="checkbox" aria-label="Selecionar recibo.jpg"><span class="tm" style="background:linear-gradient(135deg,#334155,#1e293b)"></span><div style="flex:1;min-width:0"><div class="sm" style="font-weight:500">recibo.jpg</div><div class="xs muted">Imagem · 1,2 MB · ontem</div><div class="xs muted row" style="gap:4px;margin-top:4px">${F(24)}Chat geral · Viagem para Floripa</div></div><span class="b g ic">${ic('more')}</span></li></ul>`, '',
    `# FileRow

Linha de Configurações → Arquivos (files/file-row.tsx); as linhas de Atividades (activities/activity-rows.tsx) seguem o mesmo desenho.

- 56 px no mínimo, caixa de seleção, miniatura de 40 px, nome 14 px, metadados "Documento · 212 KB · há 2 h" e selo "Em uso".
- Origem com a Faísca de 24 px: do bot na cor dele, do Chat geral em faisca.
- Menu "Mais ações": "Abrir" ou "Baixar texto" e "Excluir" em danger.
`],

  // ===== Navegação mobile (opção B) =====
  ['TabBar', 'group="Navegação mobile" height=160 subtitle="barra inferior da opção B"',
    `.tabs{max-width:380px;height:64px;display:grid;grid-template-columns:repeat(4,1fr);border-top:1px solid ${T.line};background:${T.panel}}
.tab{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font:500 11px/14px ${T.sans};color:${T.muted};min-height:48px}.tab.on{color:${T.fg}}
.pill{position:relative;width:52px;height:28px;border-radius:999px;display:grid;place-items:center}.tab.on .pill{background:${T.sel}}
.bd{position:absolute;top:-2px;right:6px;min-width:16px;height:16px;border-radius:999px;background:${T.warn};color:${T.afg};font:600 11px/16px ${T.sans};text-align:center;padding:0 4px}`,
    `<nav class="tabs" aria-label="Seções"><a class="tab on" aria-current="page">${'<span class="pill">' + ic('home', 's18') + '</span>'}Início</a><a class="tab"><span class="pill">${ic('chat', 's18')}</span>Chats</a><a class="tab"><span class="pill">${ic('cal', 's18')}</span>Rotinas</a><a class="tab" aria-label="Aprovações, 2 pendentes"><span class="pill">${ic('shield', 's18')}<span class="bd" aria-hidden="true">2</span></span>Aprovações</a></nav>`, '',
    `# TabBar

Barra inferior do celular (novo na phase 5, opção B): substitui o menu sanduíche abaixo de 768 px.

- 64 px mais a safe area inferior, bg-panel com fio superior border, quatro abas de 48 px de alvo: Início, Chats, Rotinas, Aprovações.
- Ativa: ícone dentro de uma pílula bg-selected de 52 × 28 e texto em text; inativas em text-muted. \`aria-current="page"\` na ativa.
- Aprovações leva o selo warning com a contagem (até "9+"), dita também no nome acessível ("Aprovações, 2 pendentes").
- Some quando o teclado está aberto. No desktop não existe.
`],

  ['HomeMobile', 'group="Navegação mobile" height=600 subtitle="Início do celular: saudação, aprovação, bots, chats e composer"',
    `.ph{max-width:380px;border:1px solid ${T.line};border-radius:16px;overflow:hidden;background:${T.app}}
.hh{display:flex;align-items:center;justify-content:space-between;height:52px;padding:0 8px 0 16px;border-bottom:1px solid ${T.line}}
.bd{padding:12px}.hello{display:flex;align-items:center;gap:12px;margin:4px 4px 16px}.hello h2{margin:0;font:600 24px/30px ${T.disp}}
.ap{display:flex;align-items:center;gap:10px;border-radius:12px;border:1px solid ${T.warn};background:${T.surface};padding:10px 12px;font-size:13px;line-height:18px}
.sh{display:flex;align-items:center;justify-content:space-between;margin:16px 4px 4px;font:500 12px/16px ${T.sans};color:${T.muted}}
.br{display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:10px}.br .t{flex:1;min-width:0}.br .s{font-size:12px;line-height:16px;color:${T.muted};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cp{display:flex;align-items:center;gap:8px;margin:8px;border-radius:24px;border:1px solid ${T.line};background:${T.surface};padding:8px 8px 8px 16px;font-size:15px;color:${T.subtle}}`,
    `<div class="ph"><div class="hh"><svg viewBox="0 0 240 96" width="55" height="22" role="img" aria-label="aion"><circle cx="34" cy="55" r="22" fill="none" stroke="#ECECF1" stroke-width="14"/><path d="M56 34V80M88 34V80" stroke="#ECECF1" stroke-width="14" stroke-linecap="round"/><circle cx="136" cy="55" r="22" fill="none" stroke="#ECECF1" stroke-width="14"/><path d="M186 80V34M186 54C186 40 195 33 206 33C218 33 226 41 226 54V80" fill="none" stroke="#ECECF1" stroke-width="14" stroke-linecap="round"/><path transform="translate(88 12)" d="M0 -11C1.6 -3.6 3.6 -1.6 11 0C3.6 1.6 1.6 3.6 0 11C-1.6 3.6 -3.6 1.6 -11 0C-3.6 -1.6 -1.6 -3.6 0 -11Z" fill="#FACC15" stroke="#A16207" stroke-width="1.2"/></svg><span class="b g ic" aria-label="Configurações">${ic('gear', 's18')}</span></div>
<div class="bd"><div class="hello"><span class="hero-glow">${F(64)}</span><div><h2>Boa tarde, Marco</h2><span class="xs muted">2 bots trabalhando · 1 aprovação</span></div></div>
<a class="ap">${F(24, '#4ade80', 'waiting')}<span><b style="font-weight:600">Financeiro</b> quer enviar um e-mail para a contabilidade</span>${ic('chevR')}</a>
<div class="sh">Seus bots<span class="b g sm" style="height:28px;padding:0 8px">${ic('plus', 's14')}Novo bot</span></div>
<div class="br">${F(32, BOT, 'working')}<div class="t"><div class="sm" style="font-weight:500">Resumo das manhãs</div><div class="s">Lendo a caixa de entrada…</div></div><span class="badge info">Trabalhando</span></div>
<div class="br">${F(32, '#4ade80', 'waiting')}<div class="t"><div class="sm" style="font-weight:500">Financeiro</div><div class="s">Preparei o e-mail da contabilidade</div></div><span class="badge warn">Aguardando</span></div>
<div class="br">${F(32, '#f472b6')}<div class="t"><div class="sm" style="font-weight:500">Conteúdo</div><div class="s">Rotina das 9h concluída</div></div></div>
<div class="sh">Chats recentes</div><div class="br"><div class="t"><div class="sm">Viagem para Floripa</div><div class="s">ontem · apaga em 6 dias</div></div></div></div>
<div class="cp">Pergunte ao Aion<span class="b p ic round" style="margin-left:auto" aria-label="Enviar mensagem">${ic('arrowUp', '', 'stroke-width:2')}</span></div></div>`, '',
    `# HomeMobile

Tela Início do celular (novo na phase 5, opção B), rota \`/\`, onde o app sempre abre.

- Cabeçalho de 52 px com o logotipo claro (22 px) e a engrenagem de Configurações (abre a lista das 6 áreas).
- Saudação: Faísca de 64 px em faisca (\`enter\`), "Boa tarde, {nome}" em display-sm e o resumo do momento em 12 px text-muted.
- Aprovação mais recente: cartão bg-surface com borda warning e a Faísca do bot em waiting; leva à conversa.
- "Seus bots" com a ação "Novo bot": linha de 44 px com Faísca de 32 px (parada salvo em working e waiting), nome, última linha e selo de estado.
- "Chats recentes": as últimas sessões do Chat geral.
- Composer "Pergunte ao Aion" fixo acima da TabBar: enviar cria a sessão do Chat geral e abre a conversa; o rascunho fica no aparelho.
`],
];

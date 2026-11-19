// Componentes que as phases 3 e 4 trazem para a conversa, já no padrão da Faísca, com todos os estados.
// Phase 3: marcador de não lido, bloco cercado copiável e notificação do sistema.
// Phase 4: ações da mensagem, versões, edição, complemento, retroceder, gerar outra resposta, execução de Python, saídas e anexo .xlsx.
// As decisões de comportamento vêm de .vibeflow/phases/phase-3-.../design.md (aprovado) e phase-4-.../interview.md (confirmada, sem spec):
// os desenhos da phase 4 são proposta até o design dela ser aprovado.
import { CARD_CSS, F, T, card, ic } from './appcomps.mjs';
import { sparkInner } from './faisca.mjs';

// ---------- ícones extras ----------
const X = {
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  check: '<path d="M20 6 9 17l-5-5"/>', wrap: '<path d="M3 6h18M3 12h15a3 3 0 1 1 0 6h-4M3 18h7"/><path d="m16 16-2 2 2 2"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>', refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>', chevL: '<path d="m15 18-6-6 6-6"/>', chevR: '<path d="m9 18 6-6-6-6"/>',
  reply: '<path d="M9 17 4 12l5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>', download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  sheet: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>', menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  timer: '<path d="M10 2h4M12 14l3-3"/><circle cx="12" cy="14" r="8"/>', ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
};
const ix = (n, style = '') => `<svg class="i" viewBox="0 0 24 24"${style ? ` style="${style}"` : ''} aria-hidden="true">${X[n]}</svg>`;
const BOT = '#60a5fa';
const BRAND = '#3b82f6';
const st = (label) => `<p class="stl">${label}</p>`;

// CSS comum desta camada (somado a KIT e APPKIT pelo gen.mjs).
export const P34_CSS = `${CARD_CSS}
.stl{margin:16px 0 6px;font:500 12px/16px ${T.sans};color:${T.subtle}}.stl:first-child{margin-top:0}
.unr{display:inline-block;width:8px;height:8px;border-radius:50%;background:${T.info};flex:none}
.me{margin-left:auto;width:fit-content;max-width:80%;border-radius:16px;background:${T.surface};padding:8px 16px;font-size:15px;line-height:24px}
.mew{margin-left:auto;max-width:80%;display:flex;flex-direction:column;align-items:flex-end;gap:4px}.mew .me{max-width:100%;margin:0}
.br{display:flex;gap:8px}.br .mk{width:24px;flex:none}.br .bc{min-width:0;flex:1;display:flex;flex-direction:column;gap:6px}
.bub{width:fit-content;max-width:100%;border-radius:16px;border:1px solid ${T.line};background:${T.panel};padding:8px 16px;font-size:15px;line-height:24px}.bub p{margin:0}
.acts{display:flex;align-items:center;gap:2px;color:${T.muted};font-size:12px;line-height:16px}.acts .a{width:32px;height:32px;display:grid;place-items:center;border-radius:10px;position:relative}
.acts .a.hv{background:${T.hover};color:${T.fg}}.acts .a.off{opacity:.4}.acts .mdl{margin-left:6px;color:${T.subtle};font:12px ${T.mono}}.acts .ok{color:${T.ok}}
.tip{position:absolute;top:calc(100% + 6px);left:0;white-space:nowrap;border-radius:6px;border:1px solid ${T.line};background:${T.surface};padding:4px 8px;font:500 12px/16px ${T.sans};color:${T.fg};z-index:2}
.ver{display:inline-flex;align-items:center;gap:2px;font:500 12px/16px ${T.sans};color:${T.muted}}.ver .a{width:28px}
.blk{border:1px solid ${T.line};border-radius:10px;background:${T.surface};overflow:hidden;max-width:560px}
.blk .bh{height:32px;display:flex;align-items:center;gap:8px;padding:0 4px 0 12px;border-bottom:1px solid ${T.line};font:12px ${T.mono};color:${T.muted}}.blk .bh .lb2{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.blk .bh .b{height:26px;padding:0 8px;font-size:12px;gap:4px;color:${T.muted}}.blk .bh .b[aria-pressed="true"]{background:${T.sel};color:${T.fg}}
.blk pre{margin:0;padding:12px 16px;font:13px/20px ${T.mono};color:${T.fg};white-space:pre;overflow-x:auto}.blk pre.wr{white-space:pre-wrap;overflow-wrap:anywhere}
.blk .tx{padding:12px 16px;font-size:15px;line-height:24px;white-space:pre-wrap;overflow-wrap:anywhere}
.kw{color:#c4b5fd}.s2{color:#86efac}.cm{color:${T.subtle}}.nu{color:#fcd34d}
.cmp{border-radius:24px;border:1px solid ${T.line};background:${T.surface};padding:10px 12px;display:flex;flex-direction:column;gap:8px;max-width:620px}
.cmp .tx{font-size:15px;line-height:24px;color:${T.fg}}.cmp .tx.ph{color:${T.subtle}}.cmp .tb{display:flex;align-items:center;gap:6px}
.cmp .trg{display:flex;align-items:center;gap:4px;height:32px;padding:0 6px;border-radius:10px;font-size:13px;color:${T.muted}}
.band{display:flex;align-items:center;gap:8px;font-size:12px;line-height:16px;border-radius:10px;padding:6px 8px 6px 10px}.band.info{background:${T.infoS};color:${T.info}}.band.warn{background:${T.warnS};color:${T.warn}}.band.bad{background:${T.badS};color:${T.bad}}
.chips{display:flex;flex-wrap:wrap;gap:8px}.chip{position:relative;display:flex;align-items:center;gap:8px;height:40px;padding:0 8px;border-radius:10px;border:1px solid ${T.line};background:${T.hover};font-size:14px}.chip.err{border-color:${T.bad}}
.chip .sub{display:block;font-size:12px;line-height:16px;color:${T.muted}}
.compl{display:inline-flex;align-items:center;gap:4px;font:500 12px/16px ${T.sans};color:${T.muted}}
.ar{display:flex;align-items:center;gap:8px;min-height:28px;font-size:14px;line-height:20px;color:${T.muted}}.ar .l{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.det{display:flex;flex-direction:column;gap:8px;padding:6px 0 4px 24px;max-width:600px}.lab{margin:0 0 4px;font:500 12px/16px ${T.sans};color:${T.subtle}}
.out{margin:0;border-radius:6px;background:${T.surface};padding:8px;font:13px/20px ${T.mono};color:${T.muted};white-space:pre-wrap}.out.err{color:${T.bad}}
.dl{display:flex;align-items:center;gap:10px;min-height:48px;max-width:420px;border-radius:10px;border:1px solid ${T.line};background:${T.hover};padding:4px 8px 4px 12px;font-size:14px}
.dl.rm{border-style:dashed;background:transparent;color:${T.muted}}
.png{position:relative;border-radius:10px;border:1px solid ${T.line};background:#f8fafc;padding:12px;max-width:420px}
.sec{display:flex;flex-direction:column;gap:2px;padding:8px 12px;border-radius:6px;font-size:14px;color:${T.muted};max-width:260px}.sec .r1{display:flex;align-items:center;gap:8px}.sec .r1 span{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bi{display:flex;align-items:center;gap:8px;height:44px;padding:0 12px;border-radius:6px;max-width:264px}.bi .t{flex:1;min-width:0}.bi .n{font:500 14px/20px ${T.sans}}.bi .s{font:500 12px/16px ${T.sans}}
.rk{position:relative;width:40px;height:40px;border-radius:10px;display:grid;place-items:center;color:${T.muted}}.rk .unr{position:absolute;top:4px;right:4px;box-shadow:0 0 0 2px ${T.app}}
.ntf{max-width:380px;border-radius:20px;background:#2b2b33;padding:12px 14px;display:flex;gap:12px;align-items:flex-start;font-family:${T.sans}}
.ntf .app{display:flex;align-items:center;gap:6px;font-size:12px;color:#c9c9d1}.ntf .ttl{font:600 14px/20px ${T.sans};color:#fff}.ntf .bd{font-size:14px;line-height:20px;color:#d4d4dc}
.modal{position:relative;max-width:440px;padding:24px;border-radius:16px;border:1px solid ${T.line};background:${T.surface};box-shadow:0 8px 24px rgb(0 0 0/.4)}
.modal h4{margin:0;font:600 18px/26px ${T.sans}}.modal p{margin:8px 0 0;font-size:14px;line-height:20px;color:${T.muted}}.modal .mact{display:flex;justify-content:flex-end;gap:8px;margin-top:24px}
.toast{display:flex;align-items:center;gap:10px;max-width:420px;border-radius:12px;border:1px solid ${T.line};background:${T.surface};padding:10px 12px;font-size:14px;box-shadow:0 8px 24px rgb(0 0 0/.4)}
.mark{display:flex;align-items:center;gap:12px;font:500 12px/16px ${T.sans};color:${T.subtle};max-width:760px}.mark::before,.mark::after{content:"";height:1px;flex:1;background:${T.line}}
`;

// ---------- peças ----------
const copyA = (s = '') => `<span class="a${s}" aria-label="Copiar">${ix('copy')}</span>`;
const ver = (n, of, { prevOff = false, nextOff = false, off = false } = {}) => `<span class="ver${off ? ' off' : ''}" aria-label="Versão ${n} de ${of}" style="${off ? 'opacity:.4' : ''}"><span class="a" aria-label="Versão anterior" style="${prevOff ? 'opacity:.4' : ''}">${ix('chevL')}</span>${n}/${of}<span class="a" aria-label="Próxima versão" style="${nextOff ? 'opacity:.4' : ''}">${ix('chevR')}</span></span>`;
const userA = (o = {}) => `${o.ver || ''}${o.copied ? `<span class="a ok" aria-label="Copiado">${ix('check')}</span><span class="ok xs">Copiado</span>` : copyA()}${o.bot ? '' : `<span class="a${o.off ? ' off' : ''}" aria-label="Editar mensagem">${ix('pencil')}${o.tip ? `<span class="tip">${o.tip}</span>` : ''}</span>`}`;
const botA = (o = {}) => `${o.ver || ''}${o.copied ? `<span class="a ok">${ix('check')}</span><span class="ok xs">Copiado</span>` : copyA(o.hover ? ' hv' : '')}${o.bot ? '' : `<span class="a${o.off ? ' off' : ''}" aria-label="Gerar outra resposta">${ix('refresh')}${o.tip ? `<span class="tip">${o.tip}</span>` : ''}</span><span class="a${o.off ? ' off' : ''}" aria-label="Retroceder até aqui">${ix('undo')}</span>`}<span class="mdl">${o.model || 'deepseek-v4.1-flash'}</span>`;
const um = (text, acts = '', extra = '') => `<div class="mew"><div class="me">${text}</div>${extra}${acts ? `<div class="acts">${acts}</div>` : ''}</div>`;
const bm = (color, html, acts = '', state = 'idle') => `<div class="br"><div class="mk">${F(24, color, state)}</div><div class="bc"><div class="bub">${html}</div>${acts ? `<div class="acts">${acts}</div>` : ''}</div></div>`;
const composer = (o = {}) => `<div class="cmp">${o.band || ''}${o.chips ? `<div class="chips">${o.chips}</div>` : ''}<div class="tx${o.text ? '' : ' ph'}">${o.text || 'Escreva uma mensagem'}</div><div class="tb"><span class="b g ic" style="margin-right:auto">${ic('clip')}</span><span class="trg">${o.model || 'deepseek-v4.1-flash'} ${ic('chevD')}</span><span class="trg">${o.effort || 'Padrão'}</span><span class="b g ic">${ic('mic')}</span>${o.stop ? `<span class="b p ic round" aria-label="Parar execução">${ic('square', 's14')}</span>` : `<span class="b p ic round" aria-label="${o.sendLabel || 'Enviar mensagem'}"${o.text ? '' : ' style="opacity:.5"'}>${ic('arrowUp', '', 'stroke-width:2')}</span>`}</div></div>`;
const block = (lang, body, o = {}) => `<div class="blk"${o.w ? ` style="max-width:${o.w}px"` : ''}><div class="bh"><span class="lb2">${lang}</span>${o.text ? '' : `<span class="b g" aria-pressed="${o.wrap ? 'true' : 'false'}"${o.iconOnly ? ' aria-label="Quebrar linhas"' : ''}>${ix('wrap')}${o.iconOnly ? '' : 'Quebrar linhas'}</span>`}<span class="b g"${o.iconOnly ? ' aria-label="Copiar"' : ''}>${o.copied ? `${ix('check', `color:${T.ok}`)}${o.iconOnly ? '' : `<span style="color:${T.ok}">Copiado</span>`}` : `${ix('copy')}${o.iconOnly ? '' : 'Copiar'}`}</span></div>${o.text ? `<div class="tx">${body}</div>` : `<pre class="${o.wrap ? 'wr' : ''}" tabindex="${o.wrap ? '-1' : '0'}">${body}</pre>`}</div>`;
const LONG = `<span class="kw">const</span> resumo = mensagens.<span class="kw">filter</span>((m) =&gt; m.lida === <span class="kw">false</span> &amp;&amp; m.remetente.endsWith(<span class="s2">"@cliente.com.br"</span>)).<span class="kw">map</span>((m) =&gt; m.assunto).join(<span class="s2">", "</span>);`;
const PY = `<span class="kw">import</span> pandas <span class="kw">as</span> pd
df = pd.read_excel(<span class="s2">"extrato-outubro.xlsx"</span>, sheet_name=<span class="s2">"Lançamentos"</span>)
por_cat = df.groupby(<span class="s2">"categoria"</span>)[<span class="s2">"valor"</span>].sum().sort_values()
por_cat.plot.barh()
por_cat.to_csv(<span class="s2">"gastos-outubro.csv"</span>)`;
const chart = `<svg viewBox="0 0 380 150" width="100%" role="img" aria-label="Gráfico: gastos de outubro por categoria"><text x="8" y="16" font-size="12" font-family="sans-serif" fill="#0f172a">Gastos de outubro por categoria (R$)</text>${[['Mercado', 1480], ['Moradia', 1200], ['Transporte', 620], ['Lazer', 512]].map(([k, v], i) => `<text x="8" y="${44 + i * 26}" font-size="11" font-family="sans-serif" fill="#334155">${k}</text><rect x="86" y="${33 + i * 26}" width="${Math.round(v / 6)}" height="15" rx="2" fill="#3b82f6"/><text x="${92 + Math.round(v / 6)}" y="${45 + i * 26}" font-size="11" font-family="sans-serif" fill="#334155">${v}</text>`).join('')}</svg>`;
const actRow = (icon, label, o = {}) => `<div class="ar">${icon}<span class="l">${label}${o.tag ? `<span class="xs" style="margin-left:8px;color:${o.tagColor || T.muted}">${o.tag}</span>` : ''}</span><span style="display:inline-flex;${o.open ? 'transform:rotate(90deg)' : ''}">${ic('chevR')}</span></div>`;
const PY_IC = `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c-3 0-4 1.3-4 3v2h4v1H6c-2 0-3 1.5-3 4s1 4 3 4h2v-2.5c0-1.6 1.3-3 3-3h4c1.7 0 3-1.3 3-3V5c0-1.7-1.5-3-4-3z"/><path d="M12 22c3 0 4-1.3 4-3v-2h-4v-1h6c2 0 3-1.5 3-4s-1-4-3-4h-2v2.5c0 1.6-1.3 3-3 3H9c-1.7 0-3 1.3-3 3V19c0 1.7 1.5 3 4 3z"/></svg>`;
const fileCard = (name, kind, size, o = {}) => `<div class="dl${o.removed ? ' rm' : ''}">${o.removed ? ic('fileX') : kind === 'XLSX' ? ix('sheet', `color:${T.ok}`) : ic('file', '', `color:${T.muted}`)}<span style="flex:1;min-width:0">${o.removed ? `Arquivo removido: ${name}` : `${name}<span class="xs muted" style="display:block">${kind} · ${size}${o.byBot ? ' · gerado pelo bot' : ''}</span>`}</span>${o.removed ? '' : `<span class="b g sm">${ix('download')}Baixar</span>`}</div>`;

export const P34_COMPONENTS = [
  // ================= Phase 3 =================
  ['UnreadMarker', 'group="Phase 3 · Notificações e blocos" height=560 subtitle="marcador de não lido: listas, navegação e celular"', '',
    `${st('Lista de bots (painel e Início): com novidade, sem novidade, aberto')}
<div class="bi">${F(24, '#f472b6', 'done')}<div class="t"><div class="n">Conteúdo</div><div class="s" style="color:${T.ok}">Concluiu agora</div></div><span class="unr" aria-hidden="true"></span><span class="sr-only" style="display:none">Novidades não lidas</span></div>
<div class="bi">${F(24, '#fb923c')}<div class="t"><div class="n">Viagens</div><div class="s muted">Livre</div></div></div>
<div class="bi" style="background:${T.sel}">${F(24, BOT, 'working')}<div class="t"><div class="n">Resumo das manhãs</div><div class="s" style="color:${T.info}">Trabalhando…</div></div></div>
${st('Sessões do Chat geral: título em destaque e marcador; salva com novidade')}
<div class="sec" style="color:${T.fg};font-weight:500"><div class="r1"><span>Ideias de post para outubro</span><span class="unr"></span></div><span class="xs muted" style="font-weight:400">apaga em 7 dias</span></div>
<div class="sec" style="color:${T.fg};font-weight:500"><div class="r1"><span>Dúvida de imposto</span><span class="unr"></span></div><span class="xs muted" style="font-weight:400;display:flex;gap:4px;align-items:center">${ic('bookmark', 's14')}Salva</span></div>
<div class="sec"><div class="r1"><span>Receita de pão</span></div><span class="xs muted">apaga hoje</span></div>
${st('Navegação: barra lateral (ícone com anel), aba Chats e linha do Início no celular')}
<div class="row" style="gap:24px;align-items:center"><span class="rk" aria-label="Bots, há novidades não lidas"><svg class="i s18" viewBox="0 0 24 24"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/></svg><span class="unr"></span></span>
<span style="position:relative;width:52px;height:28px;border-radius:999px;display:grid;place-items:center;color:${T.muted}" aria-label="Chats, há novidades não lidas">${ic('chat', 's18')}<span class="unr" style="position:absolute;top:0;right:10px;box-shadow:0 0 0 2px ${T.panel}"></span></span>
<span class="row" style="gap:6px;font:500 14px/20px ${T.sans}">${F(32, '#f472b6')}Conteúdo <span class="unr"></span></span></div>`, '',
    `# UnreadMarker

Marcador de não lido (phase 3, design aprovado): ponto de 8 px em info, sem número, \`aria-hidden\`, com \`span.sr-only\` "Novidades não lidas" no link.

- Bots: último filho da linha, depois da coluna de texto (o nome trunca antes). Item aberto não mostra marcador (a presença marca lido). Bot arquivado com novidade mostra o marcador dentro de Arquivados; o botão "Arquivados" recolhido não ganha.
- Chat geral: título passa de text-muted para text com peso 500, além do ponto. Sessão salva mostra os dois marcadores.
- Navegação: na barra lateral, no canto do ícone com anel de 2 px em bg-app. Phase 5: no celular, o ponto vai para a aba Chats (anel em bg-panel) e para as linhas do Início, no lugar do botão de menu.
- Nome acessível: "Bots, há novidades não lidas", "Chats, há novidades não lidas". Sem animação: a lista é relida a cada 5 a 15 s.
`],

  ['CodeBlockCard', 'group="Phase 3 · Notificações e blocos" height=760 subtitle="bloco cercado: texto, código, quebra, copiado, estreito, vazio"', '',
    `${st('Código com rolagem (normal)')}${block('ts', LONG)}
${st('Quebrar linhas ligado (aria-pressed)')}${block('ts', LONG, { wrap: true })}
${st('Depois de Copiar (2 s)')}${block('bash', 'pnpm --filter @aion/web test:e2e', { copied: true })}
${st('Texto: só Copiar, fonte sans e quebra sempre')}${block('Texto', 'Olá, Ana!\nSegue a fatura #4821 ajustada. O valor correto é R$ 1.212,90.\nQualquer dúvida, estou à disposição.', { text: true })}
${st('Largura útil abaixo de 300 px: só ícones, com aria-label e tooltip')}${block('python', 'print(soma)', { iconOnly: true, w: 280 })}
${st('Bloco vazio e código inline (sem cartão)')}${block('Código', '&nbsp;')}<p class="sm" style="margin:8px 0 0">Rode <code style="font:13px ${T.mono};background:${T.surface};border-radius:6px;padding:1px 5px">pnpm test</code> antes do push.</p>
${st('Falha ao copiar (toast que fica até fechar)')}<div class="toast" data-anim="toast">${ic('alert', '', `color:${T.bad}`)}<span style="flex:1">Não foi possível copiar. Selecione o texto e copie manualmente.</span>${ic('x', 's14')}</div>`, '',
    `# CodeBlockCard

Bloco cercado dentro da resposta do bot (phase 3, design aprovado): cartão bg-surface, borda border, radius-md.

- Cabeçalho de 32 px: rótulo em mono 12 px text-muted ("Texto", o identificador da linguagem como veio, ou "Código"), ações ghost à direita.
- Código: mono 13/20, \`white-space: pre\`, rola só por dentro (\`tabIndex=0\`); "Quebrar linhas" (\`aria-pressed\`) troca para \`pre-wrap\` e tira o \`tabIndex\`.
- Texto: sans 15/24, quebra sempre, sem rolagem, só "Copiar".
- Copiar: ícone Copy e "Copiar"; por 2 s Check e "Copiado", com \`role="status"\` "Conteúdo copiado". Falha: toast de erro que só some ao fechar.
- Abaixo de 300 px úteis os botões viram só ícone, com \`aria-label\` e tooltip. Nenhum bloco cria rolagem horizontal na página. Código inline não ganha cartão.
`],

  ['PushNotification', 'group="Phase 3 · Notificações e blocos" height=420 subtitle="aviso no Android: phase 3 com o A, phase 5 com a estrela"',
    '',
    `${st('Phase 3 (como está sendo feito): emblema "A" transparente')}
<div class="ntf"><div style="width:40px;height:40px;border-radius:50%;background:#1b1530;display:grid;place-items:center;color:#fff;font:600 18px ${T.sans};flex:none">A</div><div style="flex:1;min-width:0"><div class="app"><span style="font:700 11px ${T.sans}">A</span>Aion · agora</div><div class="ttl">Financeiro</div><div class="bd">Aprovação pendente</div></div></div>
${st('Phase 5: estrela da Faísca no emblema e Faísca no ícone grande')}
<div class="ntf"><span style="width:40px;height:40px;border-radius:50%;background:#1b1530;display:grid;place-items:center;flex:none">${F(32, BRAND)}</span><div style="flex:1;min-width:0"><div class="app"><svg viewBox="-13 -13 26 26" width="12" height="12" aria-hidden="true">${sparkInner({ fill: '#c9c9d1', line: null, rich: false })}</svg>Aion · agora</div><div class="ttl">Financeiro</div><div class="bd">Aprovação pendente</div></div></div>
${st('Aviso silencioso de fallback (sem corpo, fecha logo)')}
<div class="ntf" style="opacity:.8"><div style="flex:1"><div class="app"><svg viewBox="-13 -13 26 26" width="12" height="12" aria-hidden="true">${sparkInner({ fill: '#c9c9d1', line: null, rich: false })}</svg>Aion · agora</div><div class="ttl">Aion</div></div></div>`, '',
    `# PushNotification

Aviso do sistema (phase 3 entrega o comportamento; phase 5 troca a marca).

- Título: nome do bot ou "Chat geral"; corpo: o tipo do evento ("Concluída", "Falha", "Aprovação pendente", "Aprovação expirada"). Nada de conteúdo da conversa.
- Emblema (\`badge\`): o Android usa só o canal alfa. Phase 3 gera o "A" branco transparente; phase 5 troca por \`assets/Icones/push-badge.svg\` (estrela branca).
- Ícone grande (\`icon\`): phase 3 mantém o "A"; phase 5 usa \`push-icone-grande.svg\` (Faísca sobre disco tinta).
- Fallback silencioso: título "Aion", sem corpo, sem som nem vibração, fechado logo depois.
`],

  // ================= Phase 4: controle da conversa =================
  ['MessageActions', 'group="Phase 4 · Controle da conversa" height=620 subtitle="copiar, editar, gerar outra, retroceder: estados"', '',
    `${st('Chat geral: ações da mensagem do dono e da resposta (desktop no hover; celular sempre visíveis)')}
${um('Qual a melhor época para ir a Floripa?', userA())}
${bm(BRAND, '<p>Entre abril e junho: menos chuva e preços de baixa temporada.</p>', botA({ hover: true, model: 'kimi-k2.5' }))}
${st('Depois de Copiar (2 s): Check e "Copiado", anunciado por role=status')}
${bm(BRAND, '<p>Entre abril e junho: menos chuva e preços de baixa temporada.</p>', botA({ copied: true, model: 'kimi-k2.5' }))}
${st('Execução ativa ou fila: editar, gerar outra e retroceder desabilitados, com o motivo no tooltip')}
<div style="padding-bottom:28px">${bm(BRAND, '<p>A temporada das baleias vai de julho a novembro.</p>', botA({ off: true, tip: 'Pare a execução para gerar outra resposta' }))}</div>
${st('Bot: só Copiar (conversa linear)')}
${um('Resume os e-mails de hoje.', userA({ bot: true }))}
${bm(BOT, '<p>Três pedem resposta ainda hoje.</p>', botA({ bot: true }))}
${st('Desktop ao vivo: passe o mouse ou foque a resposta para revelar as ações (fade em 120 ms; a altura fica reservada)')}
<div class="reveal">${bm(BRAND, '<p>Entre abril e junho: menos chuva e preços de baixa temporada.</p>', botA({ model: 'kimi-k2.5' }))}</div>`, '',
    `# MessageActions

Linha de ações abaixo de cada mensagem (phase 4, proposta até o design dela).

- Mensagem do dono: Copiar (Markdown bruto) e, só no Chat geral, Editar.
- Resposta: Copiar e, só no Chat geral, Gerar outra resposta e Retroceder até aqui; à direita, o modelo que gerou a resposta em mono 12 px text-subtle.
- Botões ghost de ícone com 32 px (40 px de toque no celular), \`aria-label\` e tooltip. Desktop: aparecem no hover e no foco do teclado, com a altura reservada. Celular: sempre visíveis.
- Copiado: Check em success e "Copiado" por 2 s, \`role="status"\`.
- Desabilitado com execução ativa ou fila (CONV-02 e a trilha 4 da interview): 40% de opacidade e tooltip com o motivo ("Pare a execução para editar", "…para gerar outra resposta", "…para retroceder").
- Bots: só Copiar. Atividades, cartões e aprovações não têm Copiar.
`],

  ['VersionSwitcher', 'group="Phase 4 · Controle da conversa" height=300 subtitle="seletor ‹ 1/2 › de versões e ramos"', '',
    `${st('Primeira versão (anterior desabilitada), meio, última (próxima desabilitada)')}
<div class="acts">${ver(1, 3, { prevOff: true })}</div><div class="acts">${ver(2, 3)}</div><div class="acts">${ver(3, 3, { nextOff: true })}</div>
${st('Na mensagem editada e na resposta regenerada')}
${um('Qual a melhor época para ir a Floripa com pouca gente?', userA({ ver: ver(2, 2, { nextOff: true }) }))}
${st('Desabilitado durante execução ou fila')}<div class="acts">${ver(1, 2, { off: true })}</div>`, '',
    `# VersionSwitcher

Seletor de versão (phase 4, Chat geral): "‹ n/total ›" antes das ações da mensagem editada e da resposta regenerada.

- Trocar a versão troca o ramo ativo: as rodadas seguintes mudam junto e o modelo passa a receber só o ramo ativo (CONV-01).
- Setas ghost de 28 px com \`aria-label\` "Versão anterior" e "Próxima versão"; o grupo diz "Versão 2 de 3". Nas pontas, a seta fica desabilitada.
- Desabilitado com execução ativa ou fila.
`],

  ['EditMessage', 'group="Phase 4 · Controle da conversa" height=560 subtitle="editar no composer: normal, com anexos, imagem sem visão"', '',
    `${st('Editando: faixa no composer, texto e anexos originais pré-carregados')}
${composer({ band: `<div class="band info">${ix('pencil')}<span style="flex:1">Editando a mensagem. A versão atual continua salva como 1/2.</span><span class="b g sm" style="height:24px">Cancelar</span></div>`, chips: `<span class="chip">${ic('file', '', `color:${T.muted}`)}<span>roteiro.pdf<span class="sub">PDF · 88 KB</span></span></span>`, text: 'Qual a melhor época para ir a Floripa com pouca gente?', sendLabel: 'Salvar edição e enviar', model: 'kimi-k2.5' })}
${st('Modelo atual sem visão e a mensagem tem imagem: envio recusado com motivo')}
${composer({ band: `<div class="band warn">${ix('image')}<span style="flex:1">kimi-k2.5 não lê imagens. Troque o modelo ou remova a imagem para enviar.</span></div>`, chips: `<span class="chip err" style="width:56px;height:56px;padding:0;background:linear-gradient(135deg,#334155,#1e293b)"></span>`, text: 'O que tem nesta foto?', model: 'kimi-k2.5' })}
${st('Depois de enviar: a mensagem vira 2/2 e a resposta nova chega no ramo novo')}
${um('Qual a melhor época para ir a Floripa com pouca gente?', userA({ ver: ver(2, 2, { nextOff: true }) }))}`, '',
    `# EditMessage

Edição de mensagem do dono no Chat geral (phase 4). A edição acontece no composer, não dentro da bolha.

- Faixa info no topo do composer: "Editando a mensagem. A versão atual continua salva como n/total." e "Cancelar" (Esc também cancela).
- Texto e anexos originais vêm pré-carregados e podem ser trocados; os originais seguem ligados à versão antiga.
- Modelo e effort: os do composer no momento. Imagem com modelo sem visão é recusada com o motivo em faixa warning.
- Enviar cria a versão nova e o ramo novo; nada é apagado.
`],

  ['Complement', 'group="Phase 4 · Controle da conversa" height=640 subtitle="complemento durante a execução: pendente, lido, nova rodada, devolvido"', '',
    `${st('Enviado com o bot trabalhando: pendente até a próxima etapa')}
${um('Ignora a categoria Moradia.', '', `<span class="compl">${ix('reply')}Complemento · será lido na próxima etapa</span>`)}
${st('Lido pelo bot na fronteira entre etapas')}
${um('Ignora a categoria Moradia.', '', `<span class="compl" style="color:${T.ok}">${ix('check')}Complemento lido</span>`)}
${st('A execução terminou antes: vira nova rodada (mensagem normal)')}
${um('Ignora a categoria Moradia.', '')}
${st('Parar com complemento não lido: volta ao composer como rascunho, com texto e anexos')}
${composer({ band: `<div class="band info">${ix('reply')}<span style="flex:1">O complemento não foi lido e voltou para o rascunho.</span></div>`, text: 'Ignora a categoria Moradia.' })}
${st('Composer com o bot trabalhando e texto digitado: enviar complementa; o quadrado só aparece com o campo vazio')}
${composer({ text: 'E compara com setembro também', sendLabel: 'Enviar complemento' })}`, '',
    `# Complement

Complemento enviado enquanto o bot trabalha (phase 4, CONV-03). É o padrão ao enviar com execução ativa, nas duas superfícies.

- Nunca interrompe ferramenta nem resposta em curso; é lido só na fronteira entre etapas (em aprovação, na retomada).
- Marca abaixo da mensagem, 12 px: "Complemento · será lido na próxima etapa" (text-muted) e depois "Complemento lido" (success). Se a execução termina antes, vira nova rodada e a marca some.
- Parar com complemento não lido devolve texto e anexos ao composer, com faixa info explicando.
- Botão redondo: com texto digitado envia o complemento ("Enviar complemento"); com o campo vazio é Parar.
- Rotinas que disparam com execução ativa continuam enfileirando ("Na fila").
`],

  ['RewindAndRegenerate', 'group="Phase 4 · Controle da conversa" height=700 subtitle="retroceder até aqui e gerar outra resposta"', '',
    `${st('Confirmação de retroceder')}
<div class="modal" role="dialog" aria-labelledby="rw" data-anim="dialog"><h4 id="rw">Retroceder até esta resposta?</h4><p>2 rodadas saem do contexto do modelo e ficam guardadas como outra versão, que você pode reabrir pelo seletor.</p><p>Ações já feitas por conectores, como e-mails enviados, não são desfeitas.</p><div class="mact"><span class="b s">Cancelar</span><span class="b p">Retroceder</span></div></div>
${st('Depois de retroceder: a resposta ganha o seletor e a conversa continua dali')}
${bm(BRAND, '<p>Entre abril e junho: menos chuva e preços de baixa temporada.</p>', botA({ ver: ver(2, 2, { nextOff: true }), model: 'kimi-k2.5' }))}
<div class="mark">2 rodadas guardadas na versão 1/2</div>
${st('Gerando outra resposta: a anterior fica guardada; a Faísca trabalha no lugar')}
<div class="br"><div class="mk">${F(24, BRAND, 'working')}</div><div class="bc"><div class="ar">${ic('loader', 'spin')}<span class="l">Gerando outra resposta…</span></div></div></div>
${st('Falha ao gerar: "Tentar novamente" usa o mesmo mecanismo e cria nova versão')}
${card(T.bad, 'A execução falhou', 'alert', 'O provedor demorou demais para responder.', '<span class="b s sm">Tentar novamente</span>', F(32, BRAND, 'error'))}`, '',
    `# RewindAndRegenerate

Retroceder e gerar outra resposta (phase 4, só no Chat geral).

- Retroceder até aqui: modal com a contagem de rodadas que saem do contexto e o aviso de que ações de conectores não são desfeitas. A resposta escolhida fica; o corte vira ramo recuperável pelo seletor. Uma linha discreta marca o ponto ("2 rodadas guardadas na versão 1/2").
- Gerar outra resposta: a resposta atual vira versão anterior; enquanto gera, a Faísca trabalha no lugar com "Gerando outra resposta…". A nova usa o modelo e o effort do composer e mostra o nome dele.
- Falha: o cartão "A execução falhou" oferece "Tentar novamente", que cria nova versão pelo mesmo mecanismo. No bot, o "Tentar novamente" atual continua igual.
`],

  // ================= Phase 4: Python =================
  ['PythonRun', 'group="Phase 4 · Execução de Python" height=980 subtitle="execução de código: fila, rodando, concluída, erro, tempo, parada"', '',
    `${st('Na fila: no máximo 2 execuções de código ao mesmo tempo no servidor')}${actRow(ic('clock', '', `color:${T.muted}`), 'Python na fila', { tag: 'aguardando a vez' })}
${st('Rodando')}${actRow(ic('loader', 'spin'), 'Executando Python…')}
${st('Concluída, recolhida e expandida')}${actRow(ic('check', '', `color:${T.ok}`), 'Python executado (2,1 s)')}
${actRow(ic('check', '', `color:${T.ok}`), 'Python executado (2,1 s)', { open: true })}
<div class="det">${block('python', PY)}<div><p class="lab">Saída</p><pre class="out">4 categorias · 38 lançamentos · total 3.812,90\n[saída cortada em 4.000 caracteres]</pre></div><div><p class="lab">Arquivos gerados</p><span class="xs muted">gastos-outubro.csv · grafico-1.png</span></div></div>
${st('Erro do Python: traceback em danger, o bot recebe o erro e pode corrigir')}${actRow(ix('ban', `color:${T.bad}`), 'Python falhou (0,4 s)', { open: true })}
<div class="det">${block('python', `df = pd.read_excel(<span class="s2">"extrato.xlsx"</span>)\ndf[<span class="s2">"valr"</span>].sum()`)}<div><p class="lab">Erro</p><pre class="out err">KeyError: 'valr'\n  linha 2, em &lt;module&gt;</pre></div></div>
${st('Tempo esgotado (60 s)')}${actRow(ix('timer', `color:${T.warn}`), 'Python interrompido: passou de 60 s')}
${st('Parado pelo dono')}${actRow(ic('square', 's14', `color:${T.muted}`), 'Python interrompido por você')}
${st('Limite de arquivos ou de memória')}${actRow(ic('alert', '', `color:${T.warn}`), 'Python executado (1,8 s)', { tag: '2 arquivos acima do limite foram descartados', tagColor: T.warn })}`, '',
    `# PythonRun

Execução de código no bloco de atividade (phase 4, EXEC-01 e EXEC-02): só Python (Pyodide em WASM no worker), sem rede, sem disco e sem banco do Aion, isento de aprovação (SEC-05).

- Estados: "Python na fila" (há 2 execuções rodando), "Executando Python…" (LoaderCircle), "Python executado (tempo)" (Check success), "Python falhou (tempo)" (Ban danger), "passou de 60 s" (Timer warning), "interrompido por você" (Parar encerra na hora) e aviso de limite.
- Expandido: o código no CodeBlockCard da phase 3 (rótulo "python", Copiar e Quebrar linhas), a saída truncada em mono e a lista de arquivos gerados. Erro: traceback em danger, que o modelo também recebe.
- Cada chamada começa do zero (sem estado). O modelo recebe a saída truncada e a lista de arquivos, não a imagem.
`],

  ['CodeOutputs', 'group="Phase 4 · Execução de Python" height=560 subtitle="gráfico inline e arquivos gerados para baixar"', '',
    `${st('Gráfico PNG inline (abre no visualizador de imagem)')}<div class="png" role="img" aria-label="Abrir imagem grafico-1.png">${chart}</div>
${st('Arquivos gerados: CSV, XLSX, JSON e TXT como cartão de download')}
<div class="stack" style="gap:8px">${fileCard('gastos-outubro.csv', 'CSV', '4 KB', { byBot: true })}${fileCard('resumo-outubro.xlsx', 'XLSX', '18 KB', { byBot: true })}${fileCard('categorias.json', 'JSON', '1 KB', { byBot: true })}</div>
${st('Arquivo gerado e depois excluído pelo dono')}${fileCard('relatorio.txt', 'TXT', '2 KB', { removed: true })}`, '',
    `# CodeOutputs

Saídas da execução de Python dentro da resposta do bot (phase 4, ATT-01).

- PNG: inline, até 420 px, fundo claro do próprio gráfico, abre o visualizador de imagem já existente.
- CSV, XLSX, JSON e TXT: cartão de 48 px com ícone, nome, "TIPO · tamanho · gerado pelo bot" e "Baixar".
- Viram anexos produzidos pelo bot: mesmo ciclo de vida, exclusão ("Arquivo removido: nome") e regras de log dos anexos; aparecem em Atividade e arquivos com a origem do bot.
- Excedentes de quantidade ou tamanho são recusados e o modelo recebe o aviso.
`],

  ['XlsxAttachment', 'group="Phase 4 · Execução de Python" height=330 subtitle="anexo .xlsx: validando, pronto, recusado e na mensagem"', '',
    `${st('No composer')}<div class="chips"><span class="chip">${ic('loader', 'spin')}<span>extrato-outubro.xlsx<span class="sub">Validando planilha…</span></span></span><span class="chip">${ix('sheet', `color:${T.ok}`)}<span>extrato-outubro.xlsx<span class="sub">Planilha · 3 abas · 120 KB</span></span><span class="b g ic" style="width:32px;height:32px">${ic('x', 's14')}</span></span><span class="chip err">${ix('sheet', `color:${T.bad}`)}<span>dados.xlsx<span class="sub" style="color:${T.bad}">Planilha inválida ou grande demais</span></span></span></div>
${st('Na mensagem enviada')}${um(`<span class="chip" style="margin-bottom:8px;background:${T.hover}">${ix('sheet', `color:${T.ok}`)}<span>extrato-outubro.xlsx<span class="sub">Planilha · 120 KB</span></span></span><br>Soma os gastos por categoria e faz um gráfico.`)}`, '',
    `# XlsxAttachment

Anexo de planilha (phase 4, ATT-01): novo tipo aceito no composer, com o original guardado.

- Ícone de planilha em success; sublinha "Planilha · N abas · tamanho". Enquanto valida: LoaderCircle e "Validando planilha…".
- Recusa (formato inválido, zip bomb ou acima do limite próprio): borda e texto em danger, "Planilha inválida ou grande demais".
- Na mensagem: chip com nome e tamanho; o código lê a planilha somente leitura, pela regra do \`read_attachment\`.
- Conta no limite global \`AION_ATTACHMENTS_MAX_TOTAL_MB\`.
`],
];

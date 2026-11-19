// Gera docs/identidade/galeria.html a partir de components/*/preview.html (grupo, altura e subtítulo vêm do marcador @dsCard)
// e dos SVG em assets/. Rodar depois de gen.mjs: node docs/identidade/gerador/galeria.mjs
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
/** Ordem dos grupos na página; grupos novos entram no fim, na ordem em que aparecem. */
const ORDER = ['Marca', 'Movimento e estados', 'Navegação mobile', 'Conversa', 'Cartões', 'Modelos', 'Bots', 'Base', 'Controles', 'Campos', 'Sobreposições', 'Avisos', 'Configurações',
  'Phase 3 · Notificações e blocos', 'Phase 4 · Controle da conversa', 'Phase 4 · Execução de Python'];

const anchor = (g) => `g-${g.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\W+/g, '-')}`;
const meta = (c) => {
  const t = readFileSync(join(ROOT, 'components', c, 'preview.html'), 'utf8').split('\n')[0];
  const get = (k) => new RegExp(`${k}="([^"]+)"`).exec(t)?.[1];
  return { c, g: get('group') ?? 'Outros', s: get('subtitle') ?? '', h: Number(/height=(\d+)/.exec(t)?.[1] ?? 260) + 40 };
};
const comps = readdirSync(join(ROOT, 'components')).filter((c) => c !== 'Cover').map(meta);
const groups = [...new Set([...ORDER, ...comps.map((m) => m.g)])].filter((g) => comps.some((m) => m.g === g));
const assets = readdirSync(join(ROOT, 'assets'));

const html = `<!doctype html>
<!-- Galeria local do design system do Aion, gerada por gerador/galeria.mjs (não editar à mão). Abre os previews e os SVG sem rede, servindo esta pasta por HTTP. -->
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aion · identidade</title>
<style>body{margin:0;padding:24px 16px;background:#0e0e13;color:#ececf1;font:15px/24px Inter,system-ui,sans-serif}main{max-width:1000px;margin:0 auto}
h1{font-size:22px}h2{font-size:20px;margin:40px 0 8px}h3{margin:24px 0 2px;font-size:16px}a{color:#8db6fa}
iframe{display:block;width:100%;border:1px solid #2e2e38;border-radius:16px;background:#0e0e13}.sub{margin:0 0 8px;color:#a3a3b0;font-size:14px}
nav{margin:16px 0;display:flex;flex-wrap:wrap;gap:8px 16px;font-size:14px}
.g{display:flex;flex-wrap:wrap;gap:12px}.g figure{margin:0;background:#15151b;border:1px solid #2e2e38;border-radius:10px;padding:8px;text-align:center}.g img{height:96px;max-width:240px}figcaption{font-size:12px;color:#a3a3b0}</style></head>
<body><main><h1>Aion · identidade</h1>
<p>Brand book em <a href="README.md">README.md</a>, kit de aplicação em <a href="aplicacao.md">aplicacao.md</a>, tokens em <a href="tokens.json">tokens.json</a>, proposta de <a href="navegacao-mobile.html">navegação no celular</a> e as <a href="telas/index.html">telas da phase 5</a>. Para os previews carregarem, sirva esta pasta por HTTP (veja o README desta pasta).</p>
<iframe src="components/Cover/preview.html" style="height:300px" title="Capa"></iframe>
<nav aria-label="Grupos">${groups.map((g) => `<a href="#${anchor(g)}">${g}</a>`).join('')}<a href="#assets">Assets</a></nav>
${groups.map((g) => `<h2 id="${anchor(g)}">${g}</h2>\n${comps.filter((m) => m.g === g).map((m) => `<h3>${m.c}</h3><p class="sub">${m.s} · <a href="components/${m.c}/README.md">guia de uso</a></p><iframe src="components/${m.c}/preview.html" style="height:${m.h}px" title="${m.c}" loading="lazy"></iframe>`).join('\n')}`).join('\n')}
<h2 id="assets">Assets</h2>
${assets.map((g) => `<h3>${g}</h3><div class="g">${readdirSync(join(ROOT, 'assets', g)).filter((f) => f.endsWith('.svg')).map((f) => `<figure><img src="assets/${g}/${f}" alt="${f}"><figcaption>${f}</figcaption></figure>`).join('')}</div>`).join('\n')}
</main></body></html>
`;
writeFileSync(join(ROOT, 'galeria.html'), html);
console.log(`galeria ok: ${comps.length} componentes em ${groups.length} grupos`);

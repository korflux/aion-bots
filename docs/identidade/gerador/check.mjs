// Checagem de contraste dos pares de token nos dois temas. Rodar: node docs/identidade/gerador/check.mjs
import { color, contrast } from './tokens.mjs';
const T={};for(const [n,d,l] of color){T[n]={dark:d,light:l??d};}
const pairs=[['text',['bg-app','bg-panel','bg-surface','bg-selected']],['text-muted',['bg-app','bg-panel','bg-surface','bg-selected']],['text-subtle',['bg-app','bg-panel','bg-surface']],['faisca-claro',['bg-app','bg-panel','bg-surface','faisca-suave']],['action-fg',['action']],['success',['bg-app','bg-surface']],['warning',['bg-app','bg-surface']],['danger',['bg-app','bg-surface']],['info',['bg-app','bg-surface']],['focus',['bg-app','bg-surface','bg-selected']],['border-strong',['bg-app','bg-surface']],['faisca',['bg-app']],['brilho-traco',['bg-app']]];
for(const th of ['dark','light'])for(const [f,bs] of pairs)for(const b of bs){const c=contrast(T[f][th].slice(0,7),T[b][th].slice(0,7));console.log(th.padEnd(5),f.padEnd(14),b.padEnd(14),c.toFixed(2),c<4.5?'<4.5':'');}

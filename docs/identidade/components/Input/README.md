# Input

Campo de texto do kit (ui/input.tsx) com o Label irmão: 36 px, bg-surface, borda border-strong (a border some contra o fundo), raio radius-md, 12 px de padding lateral.

- Fonte de 16 px no celular (evita o zoom do iOS) e 14 px no desktop.
- Placeholder em text-subtle, sempre um exemplo real e nunca a repetição do rótulo.
- Erro por `aria-invalid`: borda danger e mensagem em danger ligada por `aria-describedby`, dizendo o que fazer.
- Desabilitado em 50% de opacidade.

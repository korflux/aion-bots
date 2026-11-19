# BottomSheet

Drawer inferior (ui/bottom-sheet.tsx, Dialog do Radix): versão para celular dos popovers grandes, como o seletor de modelo.

- 70 dvh de altura, bg-surface, borda superior border e cantos superiores radius-lg; sobe por transform em 250 ms.
- Quem usa decide o que fica fixo no topo e na base e o que rola; itens de 44 px para toque.
- Foco preso, Esc e toque fora fecham, o foco volta ao gatilho. `title` obrigatório (nome acessível).

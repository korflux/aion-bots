# InteractionStates

Prancha de estados de interação, válida para todos os componentes.

- Hover: só com ponteiro fino (`@media (hover:hover) and (pointer:fine)`); muda fundo para bg-surface-hover e texto para text, em dur-fast com ease-out. No toque não há hover: vale o pressionado.
- Pressionado: botões e alvos de toque escalam para 0,97 em dur-instant; linhas vão para bg-selected; a pílula da aba encolhe para 0,92.
- Foco: anel focus de 2 px a 2 px de distância, sempre visível no teclado, sem transição (aparece na hora).
- Desabilitado: 50% de opacidade, sem hover nem clique, com o motivo no tooltip quando houver.
- Carregando: o rótulo some e um spinner ocupa o lugar, mantendo a largura do botão (nada pula).
- Erro em campo: borda danger, mensagem abaixo.

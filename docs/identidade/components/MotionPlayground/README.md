# MotionPlayground

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

Com `prefers-reduced-motion`, todas as durações caem para quase zero: a interface muda de estado sem animar.

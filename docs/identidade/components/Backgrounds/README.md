# Backgrounds

Fundos do tema neutro escuro (phase 18, UI-06): cor lisa, camadas separadas por tons de cinza. Nunca carregam informação.

- Página: `bg-app` liso, quase preto, sem degradê, sem grão e sem brilho de topo.
- Painel, drawer e barra inferior em `bg-panel`; cartão, modal, popover, menu, toast e composer em `bg-surface`; hover em `bg-surface-hover`; item ativo em `bg-selected`. As camadas se separam por fundo e borda `border`.
- Conversa de um bot: a cor do bot não pinta o fundo; fica na Faísca e no nome.
- Faísca em destaque (Início, login, conversa vazia, erro e 404): halo `grad-hero` em azul e índigo, o único degradê que sobrou, porque pertence à Faísca.
- Regras: contraste medido sobre o token sólido; nada de degradê em botões, selos ou estados.
- Os utilitários antigos (`grad-app`, `grad-panel`, `grad-sheen`, `grad-composer`, `bot-glow` e `grain`) continuam declarados no CSS do app sem efeito, à espera de uma limpeza própria (dívida `ponytail:` no backlog).

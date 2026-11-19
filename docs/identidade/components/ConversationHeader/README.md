# ConversationHeader

Cabeçalho da conversa (conversation/conversation-view.tsx), 52 px.

- Bot: Faísca de 32 px no estado ao vivo (anima só em working e waiting) e nome na cor legível do bot.
- Chat geral: Faísca de 32 px em faisca e o título da sessão. Substitui o marcador de conversa da phase 1.
- RunBadge: neutro (bg-surface-hover, text-muted) com ponto pulsando "Trabalhando", ou warning "Aguardando aprovação". O azul fica só na Faísca, em links, no foco e na bolinha (phase 18).
- Ações do bot: Arquivos (Paperclip), Memória (Brain), Configurações (SlidersHorizontal), ghost de ícone com tooltip.
- Celular: "Voltar" à esquerda, o estado vira uma segunda linha sob o nome e as três ações vão para o menu "Mais ações".
- SetupBanner: cartão bg-surface com o motivo e o link secundário ("Abrir Provedores", "Abrir Chat geral").

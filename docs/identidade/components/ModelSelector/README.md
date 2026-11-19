# ModelSelector

Seletor de modelo (models/model-selector.tsx): popover de 340 px no desktop, BottomSheet de 70 dvh no celular.

- Busca "Buscar modelo" no topo.
- Seção "Favoritos" (só quando há algum, na ordem em que foram favoritados) e "Todos os modelos"; títulos 12 px em maiúsculas text-subtle.
- Linha: Check no selecionado, nome, selo do teste (Liberado success, Sem ferramentas warning, Falhou danger), estrela e "Mais ações".
- Favorito: estrela cheia em warning (ligado) ou contorno text-muted (desligado); botão com `aria-pressed` e rótulo "Favoritar {modelo}".
- Testando: "Testando modelo…" com LoaderCircle. Falha: "Falhou: {motivo}" em danger.
- Rodapé EffortControl quando o modelo aceita effort: rótulo "Effort", valor atual e trilho de 28 px (40 px no celular) com pontos por nível e polegar action de 20 px. Trocar o modelo volta o effort para "Padrão".

# MessageActions

Linha de ações abaixo de cada mensagem (conversation/message-actions.tsx).

- Mensagem do dono: Copiar (Markdown bruto) e, só no Chat geral, Editar.
- Resposta: Copiar e, só no Chat geral, Gerar outra resposta e Retroceder até aqui; à direita, o nome do modelo que gerou a resposta (o nome legível, nunca o id cru) em 12 px text-subtle.
- Botões ghost de ícone com 32 px (40 px de toque no celular), `aria-label` e tooltip.
- Desktop: aparecem no hover e no foco do teclado, com a altura reservada; a da última resposta fica sempre visível.
- Celular (phase 18): a da mensagem do dono fica sempre visível; a da resposta só na última e, nas demais, depois de o dono tocar na mensagem. A das outras respostas some sem reservar espaço.
- Copiado: Check em success e "Copiado" por 2 s, `role="status"`.
- Desabilitado com execução ativa ou fila (CONV-02 e a trilha 4 da interview): 40% de opacidade e tooltip com o motivo ("Pare a execução para editar", "…para gerar outra resposta", "…para retroceder").
- Bots: só Copiar. Atividades, cartões e aprovações não têm Copiar.

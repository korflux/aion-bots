# Thread

Lista de mensagens da conversa (conversation/thread.tsx), `role="log"`, coluna central de até 760 px com gap de 16 px. Desenho da phase 18 (UI-07 e ID-04).

- Conversa vazia: Faísca do bot a 112 px com halo, `enter` e olhar que segue o cursor; título em sans 28/36 no desktop e 24/32 no celular, "O que o {nome} faz agora?", com o nome na cor legível do bot. No Chat geral: Faísca em faisca e "No que posso ajudar?".
- Mensagem do dono: a única bolha da conversa, bg-surface à direita, raio radius-lg, até 80% (88% no celular).
- Resposta do bot: texto corrido em Markdown direto na coluna, sem bolha, borda, fundo nem Faísca ao lado.
- Linha da Faísca (`conversation/working-line.tsx`): enquanto há execução, uma linha fixa de 36 px logo acima do composer, fora da lista que rola, então continua visível com a conversa rolada até o topo. Mostra a Faísca de 24 px em working (waiting com aprovação pendente) e a frase da ação atual em 14 px text-muted: "Procurando e-mails no Gmail…", "Lendo o doc {título}…", "Aguardando sua aprovação" ou "Trabalhando…". A frase troca a cada ferramenta e é anunciada numa região `polite`; com movimento reduzido a Faísca fica parada e a frase continua mudando. Some quando a execução termina, para ou falha. Nenhum "Trabalhando…" rola junto com as mensagens.
- Linha de trabalho e cartões: ver ActivityBlock e SystemCard.
- Artefato criado ou alterado na resposta: uma linha por artefato (ícone, tipo e título, sem moldura), que abre o painel ao lado da conversa ou em tela cheia.
- Fila: a mensagem enfileirada leva o selo neutro "Na fila"; a rotina na fila é um cartão neutro com o mesmo selo.
- "Novas mensagens": pílula flutuante bg-surface com borda border-strong e sombra shadow-float, centralizada no rodapé.

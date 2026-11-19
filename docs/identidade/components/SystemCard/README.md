# SystemCard

O que o sistema conta na conversa fora da fala do bot (conversation/card-frame.tsx), em duas formas desde a phase 18 (decisão 6 da spec).

- Linha (`SystemLine`), para o que só informa: ícone de 16 px, título em 14 px e o link ou a ação inline (Desfazer, Ver rotina, Ver memória), sem moldura nem fundo; o corpo opcional (o diff da memória, o texto do objetivo) vai logo abaixo, recuado e em 12 px text-muted. Variantes: Execução interrompida, Modelo sem ferramentas, Memória atualizada, Objetivo atualizado, rotina iniciada, concluída, interrompida, perdida, confirmada, recusada ou editada.
- Cartão (`SystemCard`), só para o que pede uma decisão ou uma retomada do dono: bloco de largura total em bg-surface com borda fina border, raio radius-md, padding 10 × 12 e entrada de 150 ms; sem borda lateral colorida e sem brilho. Variantes: Aprovação, rotina criada ou alterada (Recusar e Editar), A execução falhou e Limite atingido (Faísca em erro e "Tentar novamente" ou "Continuar"), execução de rotina que falhou, estourou o limite ou expirou.
- Tom do cartão: neutro, warning (atenção) ou danger (falha); o tom só pinta o título de 12 px e o ícone de 14 px da legenda.
- Faísca: só nos cartões de aprovação pendente (waiting, a única que se mexe), falha, limite e rotina que falhou, com 32 px no lugar do ícone; as linhas nunca a mostram.
- Ações à direita; no celular descem para baixo do texto.

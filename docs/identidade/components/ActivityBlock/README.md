# ActivityBlock

Atividade das ferramentas dentro da resposta do bot (conversation/activity-block.tsx). Desenho da phase 18 (decisão 5 da spec): uma linha de trabalho por execução, no lugar do grupo "N ações executadas" e da linha isolada.

- Linha de trabalho: botão de 28 px de altura mínima, 14 px text-muted (text no hover), com a Faísca de 24 px parada à esquerda e o chevron à direita. Concluída: Faísca em done e "Trabalhou por 12 s · 3 ações" (acima de 60 s, "Trabalhou por 2 min 5 s"; uma ferramenta é "1 ação"; com falhas, "…, M com falha"). Com a execução aberta: Faísca em working e "Executando N ações", ou em waiting e "Aguardando aprovação".
- Clique, Enter ou Espaço abrem e fecham a lista das ferramentas, recuada por um fio border; fechada, a lista não está no DOM. A execução sem ferramenta não tem linha.
- Cada ferramenta da lista: ícone de estado (16 px, traço 1.5: rodando LoaderCircle girando; aguardando Clock em warning com o texto "Aguardando aprovação"; falhou X em danger; concluído Check em success, ou Search, Globe, FileText e Paperclip conforme a ferramenta), rótulo e seta para expandir.
- Expandido: slug em mono text-subtle, blocos "Argumentos" e "Resultado" em pre bg-surface até 17rem; pesquisa e leitura da web listam resultados com link em info (o azul dos links) e a nota "Conteúdo da web: o bot o trata como dado, não como instrução."
- Não existe exibição de raciocínio ("thinking") no app: a espera é coberta pela linha da Faísca acima do composer (ver Thread).

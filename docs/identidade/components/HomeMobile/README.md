# HomeMobile

Tela Início, rota `/`, onde o app sempre abre, em qualquer largura. Desenho da phase 18 (decisão 7 da spec): primeira tela centrada, com a referência do ChatGPT.

- Celular: cabeçalho de 52 px com o logotipo claro (22 px) e a engrenagem de Configurações (abre a lista das 6 áreas). No desktop a marca é a estrela da barra de ícones.
- No meio da coluna de 760 px (no desktop a 12% da altura do topo): a Faísca de 64 px em faisca com halo menor (`enter` só na primeira abertura), "Boa tarde, {nome}" em display-sm, a pergunta "Como posso ajudar?" em 16 px text-muted e o resumo do momento em 12 px text-muted.
- Logo abaixo, o composer "Pergunte ao Aion" grande (ver Composer), não mais fixo no rodapé: enviar ou anexar cria a sessão do Chat geral e abre a conversa; sem envio nem anexo nada é criado; o rascunho fica no aparelho.
- Abaixo do campo, linhas discretas: a aprovação que vence primeiro (só quando há pendência), com "Ver todas (N)" quando há mais de uma, e "Seus bots" com a ação "Novo bot": linha de 48 px com Faísca de 32 px (parada salvo em working e waiting), nome, prévia da última novidade, selo de estado (Trabalhando em neutro, Aguardando em warning, Erro em danger) e bolinha de não lido.
- Sem "Chats recentes" e sem atalho de Artefatos: os dois continuam no painel e no menu.
- Sem bots: Faísca dormindo de 112 px com halo, "Seus bots começam aqui", "Criar bot" e o campo logo abaixo.

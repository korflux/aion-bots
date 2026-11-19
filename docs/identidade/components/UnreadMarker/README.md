# UnreadMarker

Marcador de não lido (phase 3, design aprovado): ponto de 8 px em info, sem número, `aria-hidden`, com `span.sr-only` "Novidades não lidas" no link.

- Bots: último filho da linha, depois da coluna de texto (o nome trunca antes). Item aberto não mostra marcador (a presença marca lido). Bot arquivado com novidade mostra o marcador dentro de Arquivados; o botão "Arquivados" recolhido não ganha.
- Chat geral: título passa de text-muted para text com peso 500, além do ponto. Sessão salva mostra os dois marcadores.
- Navegação: na barra lateral, no canto do ícone com anel de 2 px em bg-app. Phase 5: no celular, o ponto vai para a aba Chats (anel em bg-panel) e para as linhas do Início, no lugar do botão de menu.
- Nome acessível: "Bots, há novidades não lidas", "Chats, há novidades não lidas". Sem animação: a lista é relida a cada 5 a 15 s.

# BotList

Lista de bots do painel do desktop (bots/bots-panel.tsx), uma linha por bot desde a phase 18 (decisão 9 da spec).

- Item de 44 px: Faísca de 24 px na cor do bot, que conta o estado pela pose (anima só em working e waiting), e o nome inteiro em 14 px peso 500.
- Texto de estado só quando o bot pede atenção, numa segunda linha menor (12 px) sob o nome: "Aguardando aprovação" (warning) ou "Última execução falhou" (danger). Nos demais estados a linha é única e o texto fica só para o leitor de tela. O nome não divide espaço com o estado e só trunca se não couber.
- Bolinha de não lido à direita (ver UnreadMarker). Ativo em bg-selected. "Arquivados" recolhível no fim, com a contagem.
- "Seus bots" do Início usa linha própria, com prévia (ver HomeMobile).

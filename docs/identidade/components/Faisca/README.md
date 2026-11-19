# Faisca

A Faísca é o mascote único do Aion: representa o próprio Aion na cor faisca e cada bot na cor do bot.

## O que o consumidor fornece
- `color`: cor do corpo. Use faisca quando for o Aion (login, Chat geral, estados vazios do app); use a cor do bot quando for um bot.
- `state`: idle, working, waiting, done, error ou sleep. Derive de `mascotStateOfRunStatus` (packages/shared/src/live-state.ts); nunca invente estado na tela.
- `size`: lado em px, a partir de 24. Abaixo disso use a inicial do bot.
- `label` opcional: sem ele a Faísca é decorativa (`aria-hidden`), porque o estado já está em texto ao lado.
- `still` em listas; `enter` em login e estados vazios; `gaze` só na conversa vazia e no login.

## Níveis de detalhe
- 48 px ou mais: pelo (filtro de deslocamento), miolo e brilho na estrela, dedinhos, ícone flutuante, movimento.
- 24 a 47 px: corpo liso, estrela com contorno de 2,6, sem ícone flutuante; o estado vai num ponto de status de 8 px no canto (cor do estado: info, warning, success, danger) ou só no texto.

## Estados
| Estado | Faísca | Rosto | Ícone flutuante |
|---|---|---|---|
| idle | amarela | sorriso | nenhum |
| working | acesa, com halo | olhar de lado, boca em o | balão com três pontos |
| waiting | laranja | sobrancelha de dúvida | disco warning com ? |
| done | brilhante | olhos ^^, bracinhos para cima | disco success com ✓ e estrelinhas |
| error | vermelha, antena caída | sobrancelhas tristes | disco danger com ! e gota |
| sleep | cinza, antena caída | olhos fechados | z subindo |

## Na conversa e no Início (phase 18, ID-04)
- Linha da Faísca: 24 px em working, ou waiting com aprovação pendente, logo acima do composer enquanto a execução roda, ao lado da frase da ação atual (ver Thread).
- Linha de trabalho: 24 px parada em done depois da execução, em "Trabalhou por N s · N ações" (ver ActivityBlock).
- As respostas do bot não têm Faísca ao lado. No Início ela fica no centro, com 64 px e halo, acima da pergunta (ver HomeMobile).
- Estados vazios, falhas de carregamento, Configurações e as demais telas seguem com a Faísca da phase 5; a avaliação delas está no backlog.
- No app, `data-part` (`face`, `eyes`, `pupil`) marca as partes do desenho para o E2E, que nunca localiza pelas classes de desenho.

## Faça e não faça
- Faça: anime só a Faísca que está trabalhando ou esperando; as demais ficam `still`.
- Faça: respeite `prefers-reduced-motion` (tudo parado, os z ficam visíveis).
- Não faça: acessórios, roupas ou formas novas; a identidade agora é uma só.
- Não faça: trocar a cor da estrela pela cor do bot; brilho é fixo.
- Não faça: Faísca como ícone de botão ou enfeite em toda tela; ela aparece onde há um bot ou o Aion falando.

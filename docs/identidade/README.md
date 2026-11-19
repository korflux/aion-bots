# Identidade do Aion

Design system da Faísca, aplicado no app desde a phase 5 (tokens no CSS global do app web, TOK-01). Para ver os previews e a galeria, sirva esta pasta por HTTP e abra `galeria.html`:

```bash
python -m http.server 8765 --directory docs/identidade
```

Conteúdo: este brand book, o [kit de aplicação](aplicacao.md), os [tokens](tokens.json), os guias e previews em `components/` e os SVG em `assets/`.

O Aion é um app pessoal de bots que trabalham em segundo plano para um único dono. A identidade gira em torno da **Faísca**: uma pelúcia azul, gordinha, com uma antena que termina numa estrela. A estrela é a centelha de ação do Aion: acende quando um bot trabalha e apaga quando ele dorme. A interface continua escura, calma e densa; a personalidade fica concentrada na Faísca e no logotipo, nunca espalhada pela tela.

## Princípios

- **A personalidade mora na Faísca.** Botões, tabelas e formulários seguem neutros (tokens `bg-*`, `text-*`, `action`). Cor de marca e movimento aparecem onde há um bot ou o Aion falando.
- **O estado é dito três vezes.** Pela pose da Faísca, pelo ícone flutuante e por texto ao lado ("Trabalhando…", "Aguardando aprovação"). Nunca só por cor.
- **Brilho é raro.** O amarelo `brilho` existe só na estrela e em conquistas. Se aparecer em todo lugar, deixa de significar ação.
- **Fofo, não infantil.** A Faísca é caricata; o texto e a interface são adultos e diretos.

## Voz e texto

- Português do Brasil, tratando o dono por "você". O sistema não fala em primeira pessoa; quem fala "eu" é o bot, na conversa.
- Frases curtas, voz ativa, verbo primeiro nos botões: "Salvar alterações", "Excluir bot", "Aprovar".
- Só a primeira letra maiúscula em títulos, abas e botões. Sem ponto em rótulos e títulos; com ponto em ajuda e mensagens.
- Reticências só para algo em andamento: "Trabalhando…".
- Sem emoji na interface e sem ponto de exclamação em mensagens do sistema.
- Erro diz o que houve e o que fazer: "Escolha um modelo para este bot." Nunca expõe código, consulta ou stack trace.
- O nome é "Aion" em texto corrido; o logotipo é que vai em minúsculas.

## Marca

- Use a **assinatura** (Faísca + logotipo, `assets/Logos/aion-assinatura-*.svg`) no login, no README do repositório e em divulgação.
- Use o **logotipo** sozinho no cabeçalho do Início no celular e em materiais estreitos; versão `-claro` sobre `bg-app` e `tinta`, versão `-tinta` sobre fundos claros. No desktop, a marca na barra de ícones é a estrela.
- Use a **estrela** (`faisca-estrela.svg`) onde não cabem letras: favicon, push e selo de conquista.
- Respeite a área de proteção (a altura-x do logotipo) e os mínimos: logotipo 24 px, assinatura 32 px, estrela 16 px, Faísca 24 px.
- Nunca escreva o logotipo com a fonte `display`: use o SVG.

## A Faísca

- Corpo em `faisca` quando representa o Aion; na cor do bot (`bot-*`) quando representa um bot. A estrela é sempre `brilho` com contorno `brilho-traco`, e o rosto é sempre `tinta`.
- Seis estados, vindos de `mascotStateOfRunStatus`: ocioso, trabalhando, aguardando, concluído, erro e dormindo. Cada um tem pose, cor de estrela e ícone flutuante próprios (ver componente Faisca).
- Dois níveis de detalhe: de 48 px para cima há pelo, miolo na estrela, ícone flutuante e movimento; de 24 a 47 px o desenho é liso, a estrela engrossa e o estado vai num ponto de status ou no texto.
- Abaixo de 24 px, use a inicial do bot no marcador colorido.
- Anime só a Faísca que trabalha ou espera aprovação; as demais ficam paradas (`still`).

## Cor

- Fundo da página em `bg-app`; painéis fixos em `bg-panel`; cartões, inputs e composer em `bg-surface`; hover em `bg-surface-hover`; item ativo em `bg-selected`.
- Texto principal em `text`; secundário em `text-muted`; dicas e placeholders em `text-subtle`, que é proibido sobre `bg-selected`.
- Links e o azul de marca em texto usam `faisca-claro`. `faisca` é cor de corpo e de bloco, não de texto pequeno.
- Fundo tingido de marca (boas-vindas, item novo) em `faisca-suave`.
- Botão primário em `action`/`action-fg`, não em azul: a interface fica calma e a Faísca se destaca.
- Estados: `success`, `warning` e `danger` para texto e ícone, com as versões `-soft` para fundos de selo e cartão. O azul (`info`, igual a `faisca-claro`) é só da Faísca, de links, do foco e da bolinha de não lido: "trabalhando" e estados sem juízo usam tons neutros.
- Paleta de bots: doze cores `bot-*`; bot novo começa em `bot-azul`. Num bot `bot-ambar` a estrela só aparece graças ao contorno `brilho-traco`.
- O tema claro existe para materiais fora do app (README, divulgação, impressos). O app é só escuro.

## Tipografia

- `display` (Fredoka 600) só onde a marca recebe o dono: saudação e estado vazio do Início (`display-sm`) e materiais de divulgação (`display`). Uma vez por tela, nunca em texto corrido. O login usa o logotipo, não texto em Fredoka.
- `sans` (Inter) em toda a interface: `page-title` 18/26 nos títulos de página, `body` 15/24 no texto, `label` 14/20 em botões, `small` 13/20 em metadados, `caption` 12/16 em selos.
- `mono` (JetBrains Mono) em slugs de ferramenta e blocos de código, no estilo `code`.
- No app as fontes são autohospedadas pelo fontsource (`@fontsource-variable/inter`, `@fontsource-variable/jetbrains-mono` e, na phase 5, `@fontsource-variable/fredoka`), sem CDN.

## Espaço, raios e camadas

- Espaçamento em passos de 4: `space-1` a `space-8`. Cartões com `space-4` de padding; seções separadas por `space-6`; margem de página `space-8` no desktop e `space-4` no celular.
- Raios: `radius-sm` em selos e itens de menu, `radius-md` em inputs, botões e cartões, `radius-lg` em popovers e modais, `radius-xl` no ícone do app (o composer em pílula da phase 18 usa raio de 28 px), `radius-full` em pílulas.
- Camadas se separam por fundo e borda `border`. Sombra (`shadow-float`) só em popover, menu e modal.

## Fundos

- Tema neutro escuro (phase 18, UI-06): a página é `bg-app` liso; painéis, cartões e composer sobem em camadas de cinza (`bg-panel`, `bg-surface`, `bg-surface-hover`, `bg-selected`) separadas por fundo e borda `border`.
- Sem degradê, sem grão e sem brilho de topo. A cor da conversa de um bot não pinta o fundo; ela fica no avatar e no nome.
- A cor de marca (azul) aparece só na Faísca, nos links, no anel de foco e na bolinha de não lido. A Faísca em destaque (Início, login, conversa vazia, erro e 404) ganha o halo `grad-hero`, que é da própria Faísca.
- Contraste é medido sobre o token sólido. Botões, selos e estados não levam degradê.

## Movimento

- Durações: `dur-instant` 80 ms (pressionado e foco), `dur-fast` 120 ms (hover e saídas pequenas), `dur-base` 180 ms (popover, menu, tooltip, toast, selos), `dur-slow` 250 ms (modal, drawer, bottom sheet, mensagem nova, aba ativa), `dur-slower` 400 ms (troca de estado da Faísca).
- Curvas: `ease-out` em toda entrada e hover; `ease-in` nas saídas; `ease-drawer` em drawer e bottom sheet; `ease-spring` só em microinterações pequenas (selo contando, ponto de não lido, check do Copiado).
- Entrar devagar o bastante para ser acompanhado e sair em cerca de 60% do tempo. Anime só `transform` e `opacity`.
- Hover só com ponteiro fino; no toque vale o pressionado (escala 0,97 em botões, bg-selected em linhas). Foco aparece na hora, sem transição.
- Nada fica em loop, exceto a Faísca trabalhando ou esperando e o ponto de "Trabalhando".
- Com `prefers-reduced-motion`, todas as durações caem para quase zero.
- Referência viva: componentes MotionPlayground e InteractionStates, e o botão "Repetir animação" nos previews com sobreposições.

## Foco e acessibilidade

- Todo controle mostra foco com anel `focus` de 2 px, afastado 2 px. O `focus` passa de 3:1 sobre `bg-app`, `bg-surface` e `bg-selected` nos dois temas.
- Pares de texto deste sistema passam de 4,5:1 nos dois temas, exceto `text-subtle` sobre `bg-selected`, que é proibido.
- A Faísca é decorativa por padrão (`aria-hidden`); o estado está em texto ao lado. Com `label`, vira imagem nomeada.
- Botão só de ícone exige `aria-label`. Área de toque mínima de 40 px no celular.

## Iconografia

- Ícones de interface: Lucide (`lucide-react`), traço, 16 px em botões e 20 px em navegação, na cor do texto ao redor.
- A estrela da Faísca não é ícone de interface genérico: aparece só como marca, favicon, push e conquista.
- Os ícones flutuantes de estado pertencem à Faísca e não são reutilizados soltos na interface; fora dela, use selos com texto.

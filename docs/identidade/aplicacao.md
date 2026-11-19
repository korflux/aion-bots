# Kit de aplicação

Onde a identidade entra em cada superfície do Aion: o mapa da phase 5 e o redesenho minimalista da phase 18 (tema neutro, conversa enxuta e a Faísca viva na conversa).

## Superfícies

| Superfície | O que usar | Detalhes |
|---|---|---|
| Ícone do app (PWA) | `assets/Icones/app-icon.svg` | PNG 192 e 512 px, estrela chapada sobre `tinta`, cantos `radius-xl` proporcionais (22%) |
| Ícone maskable | `app-icon-maskable.svg` | 512 px, fundo `tinta` sem cantos, estrela chapada dentro da zona segura de 80% |
| Apple touch | `app-icon.svg` | PNG 180 px, sem cantos (o iOS arredonda) |
| Favicon | `favicon.svg` | a mesma estrela chapada sobre `tinta`; SVG mais PNG 32 e 16 px |
| Push, ícone pequeno | `push-badge.svg` | estrela branca sobre transparente, PNG 96 px; o Android usa só o alfa |
| Push, ícone grande | `push-icone-grande.svg` | Faísca simples sobre disco `tinta`, PNG 192 px |
| Manifesto | tokens | `theme_color` e `background_color` = `bg-app` (#0E0E13) |
| Login e TOTP | Faísca + logotipo | Faísca de 112 px (96 no celular, 72 em telas baixas) com halo, `enter` e olhar que segue o cursor; logotipo de 36 px no lugar do título; no TOTP a Faísca fica com 72 px e parada |
| Cabeçalho do Início (celular) | logotipo claro | 22 px; no desktop, a estrela no topo da barra de ícones |
| Estado vazio | Faísca 112 px com halo | No Início, título em `display-sm`; na conversa vazia, a pergunta "O que o {nome} faz agora?" em sans, com a Faísca na cor do bot |
| Conversa de um bot | Faísca na cor do bot | phase 18: nenhuma Faísca ao lado das respostas; 24 px animada na linha fixa acima do composer durante a execução e 24 px parada em done na linha "Trabalhou por" |
| Chat geral | Faísca na cor `faisca` | passa a ter mascote: é o próprio Aion conversando |
| Lista de bots | Faísca 32 px no Início, 24 px no painel do desktop | parada, exceto trabalhando ou aguardando; no painel o estado vai pela pose e só aguardando ou erro ganham texto, numa segunda linha sob o nome; no Início, selo de estado à direita; ponto de não lido nas duas |
| Grupo de rotinas | Faísca 24 px | no lugar da inicial de 16 px |
| Aprovações | Faísca 24 px na cor do bot | estado waiting no cartão pendente |
| Página de erro e 404 | Faísca em erro, 96 px | texto explica e oferece voltar |
| README do GitHub | assinatura tinta e claro | `<picture>` com `prefers-color-scheme` |
| Imagem de compartilhamento | assinatura sobre `bg-app` | 1200 × 630, só se o app vier a ter página pública |

## Mapa da phase 5 no código

- **Mascote:** `apps/web/src/components/mascot/mascot-art.tsx` passa de seis personagens para a Faísca; `mascot.tsx` perde `character`, ganha os ícones flutuantes no lugar dos selos; `mascot.css` recebe os movimentos novos; `mascot-detail.ts` mantém os níveis.
- **Seletor de personagem:** `apps/web/src/components/bots/mascot-picker.tsx` e a grade "Personagem" do editor saem, com seus testes.
- **Dados:** `BOT_MASCOTS` e `BOT_DEFAULT_MASCOT` saem de `packages/shared/src/bots.ts`; a coluna `bots.mascot` sai por migration nova, com `down` que recria a coluna e refaz o preenchimento da migration 0018.
- **Chat geral:** ganha a Faísca na cor `faisca`, revogando a decisão da phase 1 de não ter mascote ali.
- **Ícones:** `tests/support/generate-app-icons.mjs` passa a gerar a partir destes SVGs; `public/icons/*` são substituídos; `sw.js` aponta para o novo badge de push.
- **Tokens:** `apps/web/src/app/globals.css` adota `bg-*`, `border-*`, `text-*` e `focus` deste sistema e ganha os tokens de marca; `manifest.ts` troca `#0F0F10` por `#0E0E13`.
- **Fontes:** `layout.tsx` importa `@fontsource-variable/fredoka` e expõe `--font-display`.
- **Protótipo antigo:** `docs/mascote/` sai ou fica arquivado.

## Navegação no celular (decidida: opção B)

Proposta visual em `navegacao-mobile.html`. Abaixo de 768 px o menu sanduíche dá lugar a uma barra inferior com quatro abas: Início, Chats, Rotinas e Aprovações (com o selo de pendentes). Configurações vai para o cabeçalho. No desktop nada muda.

- **Início (`/`):** desde a phase 18, centrado: a Faísca em `faisca` com a saudação, a pergunta "Como posso ajudar?" e o resumo do momento ("2 bots trabalhando · 1 aprovação"), o composer "Pergunte ao Aion" grande no meio e, abaixo, a aprovação que vence primeiro (só quando há) e "Seus bots" com a Faísca de 32 px, a prévia e o selo de estado. "Chats recentes" e o atalho de Artefatos saíram do Início.
- **Composer do Início:** enviar cria a sessão do Chat geral e navega para ela; abrir o app não cria nada. O rascunho fica guardado no aparelho.
- **Abertura:** o app sempre abre no Início (`start_url: '/'`, que deixa de redirecionar para `/bots` no celular).
- **Bots:** sem aba própria. O Início lista todos e tem a ação "Novo bot" ao lado do título "Seus bots"; a lista completa continua no painel do desktop.
- **Atalhos do ícone:** `shortcuts` no manifesto com "Novo chat" e "Aprovações".
- **Barra inferior:** 64 px mais a safe area, alvos de 48 px, aba ativa com pílula em `bg-selected`; some com o teclado aberto.

## Configurações em 6 áreas

Proposta visual em `telas/06-configuracoes.html`. As 10 áreas atuais viram 6:

| Hoje | Passa a ficar em |
|---|---|
| Provedores, Conectores, Pesquisa na web | Conexões |
| Chat geral, Idioma e fuso | Preferências |
| Regras globais | Personalização (editor na própria página, com Histórico e Salvar) |
| Notificações | Notificações |
| Atividades, Arquivos | Atividade e arquivos ("Aguardando você" fica em Aprovações; a lista de arquivos abre por botão) |
| Conta | Conta e segurança |

- As rotas antigas redirecionam para a área nova.
- Preferências salvam ao mudar, sem botão Salvar; Personalização mantém Salvar, porque é um texto longo com versões.
- No celular, Configurações abre pela engrenagem do Início, numa lista com o estado atual de cada área.
- Acabamento da phase 18: o índice é uma linha simples por área, sem cartão com brilho, com nome e descrição à esquerda e o valor atual à direita (no celular, abaixo da descrição), separadas por um filete. O valor só quebra entre as partes separadas por " · ", então o id do modelo fica inteiro.

## Phase 18: interface minimalista

Referência: o ChatGPT. Só o tema escuro; estruturas do shell, rotas e contratos não mudam.

- **Tema neutro (UI-06):** fundo quase preto liso, sem degradê, grão nem brilho de topo, e camadas em tons de cinza (ver Backgrounds). O azul da marca fica só na Faísca, em links, no anel de foco e na bolinha de não lido; "Trabalhando", "Na fila", "Esta sessão" e o ditado ativo usam tons neutros, e o token `info-soft` saiu.
- **Conversa (UI-07):** a mensagem do dono é a única bolha; a resposta do bot é texto corrido na coluna central de 760 px, sem bolha, borda, fundo nem Faísca ao lado (ver Thread).
- **Linha da Faísca (ID-04):** linha fixa logo acima do composer durante a execução, com a Faísca animada e a frase da ação atual, visível mesmo com a conversa rolada, no lugar do "Trabalhando…" que rolava com as mensagens (ver Thread).
- **Linha de trabalho:** depois da execução, "Trabalhou por N s · N ações" com a Faísca pequena de concluído, que abre os detalhes no clique e pelo teclado (ver ActivityBlock).
- **Cartões:** o que só informa vira linha com ícone e link, inclusive o artefato criado ou alterado, que abre o painel; continuam cartão neutro, sem borda lateral nem brilho, só aprovação, rotina criada ou alterada e erro ou limite (ver SystemCard, ApprovalCard, MemoryCard e RoutineCard).
- **Composer:** pílula lisa com anexar à esquerda e modelo, effort, contexto, ditado e enviar à direita na mesma linha (ver Composer). No celular, a barra de ações aparece só na última resposta e nas demais ao toque (ver MessageActions).
- **Listas:** Chats com "Novo chat" como linha de texto com ícone no topo, as seções "Salvos" e "Recentes", título e bolinha em cada linha, um aviso único "Apagados 7 dias após a última mensagem" sob "Recentes" e o relógio, com a data exata, só na sessão a que falta 1 dia ou menos; Bots em uma linha (ver BotList).
- **Início e Configurações:** ver Navegação no celular e Configurações em 6 áreas, acima, e HomeMobile.
- **Faísca:** papel novo só na conversa e no Início (ver Faisca).

Os guias `components/*/README.md` e esta seção descrevem o desenho da phase 18. Os previews (`components/*/preview.html`) e as telas de `telas/` ainda são os desenhos da phase 5, gerados por `gerador/`, e não foram redesenhados: onde divergem, valem os guias e esta seção. Os guias também saem do gerador, então rodar `gerador/gen.mjs` hoje os devolve ao texto anterior, o mesmo desvio registrado para `tokens.json` em `.erros-encontrados/2026-11-15-gerador-identidade-regrava-tokens-desatualizados.md`.

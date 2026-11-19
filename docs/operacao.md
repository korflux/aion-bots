# Operação do Aion

Guia de operação do Aion: estrutura dos serviços, implantação, variáveis de ambiente, serviços opcionais,
sondas, relatórios, desenvolvimento local e verificações. A apresentação do projeto está no
[`README.md`](../README.md). Os caminhos citados aqui são relativos à raiz do repositório.

## Estrutura

| Pasta | Serviço no Easypanel | Papel |
|---|---|---|
| `apps/web` | `web` | Next.js, tema escuro e PWA. Serve a interface na raiz do domínio. |
| `apps/api` | `api` | Fastify: rotas HTTP sob `/api`. Roda as migrations ao iniciar. |
| `apps/worker` | `worker` | Executa os bots, dispara rotinas, envia push e limpa dados vencidos. Consome a fila do pg-boss. |
| `apps/sandbox` | `sandbox` (opcional) | Executa o Python da ferramenta `run_python` (Pyodide/WebAssembly) em processos descartáveis, só na rede interna. Ver *Serviço sandbox*. |
| `packages/core` | (biblioteca) | Fonte única das regras: banco, migrations, auth, auditoria, fila. Usada por `api` e `worker`. |
| `packages/shared` | (biblioteca) | Schemas Zod, códigos de erro e cabeçalhos de segurança, usados por `web` e `core`. |
| `tests` | (só testes) | Smoke de `api` + `worker` reais e a pilha usada pelo E2E da web. |

O PostgreSQL é o serviço nativo do Easypanel (banco, fila e agendador). Todos os serviços são construídos por
Dockerfile a partir da **raiz** do repositório.

## Implantação no Easypanel (passos únicos)

Domínio: `aion.exemplo.com`, com a web na raiz e a API em `/api` (mesma origem, sem CORS). HTTPS é gerenciado
pelo Easypanel.

1. **Projeto:** crie o projeto `aion`.
2. **PostgreSQL:** adicione o serviço nativo **Postgres** com o nome `postgres` e anote a senha. A URL interna é
   `postgres://postgres:<senha>@<host-interno-do-postgres>:5432/<banco>` (o host interno aparece na aba do serviço,
   normalmente `aion_postgres`).
3. **Serviços de aplicação:** crie três serviços **App**, `api`, `worker` e `web`, todos com:
   - Fonte: **GitHub**, este repositório, branch `main`;
   - Build: **Dockerfile**, com o caminho `apps/api/Dockerfile`, `apps/worker/Dockerfile` e `apps/web/Dockerfile`
     respectivamente (o contexto de build é a raiz do repositório);
   - **Implantação automática** ligada, para o push na `main` publicar.

   O quarto serviço, `sandbox` (Python), é **opcional** e tem procedimento próprio: ver *Serviço sandbox*.
4. **Variáveis de ambiente** (aba *Environment* de cada serviço, tabela abaixo).
5. **Domínios:**
   - serviço `web`: host `aion.exemplo.com`, caminho `/`, porta `3000`;
   - serviço `api`: host `aion.exemplo.com`, caminho `/api`, porta `3001`. **Não remova o prefixo do caminho**:
     a API espera receber `/api/...`.
6. **Ordem do primeiro deploy:** `postgres`, `api`, `worker`, `web`. A API espera o banco por até 30 s e aplica as
   migrations sozinha. O `worker` não expõe porta.
7. **Conferência:**

   ```bash
   curl -sI https://aion.exemplo.com/api/health
   ```

   Deve responder `200` com `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
   `Referrer-Policy` e `Content-Security-Policy` com `frame-ancestors 'none'`.

### Variáveis de ambiente por serviço

| Variável | `api` | `worker` | `web` | Descrição |
|---|:---:|:---:|:---:|---|
| `DATABASE_URL` | obrigatória | obrigatória | | URL `postgres://` do serviço `postgres`. |
| `AION_OWNER_EMAIL` | obrigatória | | | E-mail do dono (login). |
| `AION_OWNER_PASSWORD` | obrigatória | | | Senha do dono, de 12 a 256 caracteres, em texto no ambiente (decisão AUTH-02). Trocá-la e reiniciar a `api` **encerra todas as sessões**. |
| `AION_MASTER_KEY` | obrigatória | obrigatória | | 32 bytes em base64 ou hex (`openssl rand -base64 32`). Criptografa as chaves de terceiros e o segredo TOTP. O `worker` a usa só para decifrar a chave do provedor ao chamar o modelo; **use a mesma da `api`**. |
| `AION_PUBLIC_ORIGIN` | obrigatória em produção | | obrigatória em produção | Origin exato da web, igual na `api` e na `web` (função `resolvePublicOrigin` de `@aion/shared`), ex.: `https://aion.exemplo.com`. Em produção não há padrão: sem ela a `api` não sobe e as páginas da `web` respondem 500; fora de produção, `http://localhost:3000`. Base do CSRF, do HSTS, da CSP e do destino do redirect de login. |
| `AION_API_INTERNAL_URL` | | | recomendada | URL interna da API para o servidor do Next, ex.: `http://aion_api:3001`. Padrão `http://localhost:3001`. |
| `AION_TRUSTED_PROXIES` | opcional | | | Proxies em que a API confia para ler o IP do cliente. Padrão em produção: `loopback,uniquelocal` (rede interna do Easypanel). Ver *Segurança*. |
| `AION_ALLOW_DESTRUCTIVE_MIGRATIONS` | opcional | | | `true` só com pedido explícito do dono (ver *Migrations*). |
| `AION_ATTACHMENTS_MAX_TOTAL_MB` | opcional | opcional | | Teto global dos anexos armazenados (JPEG, texto extraído, planilhas e arquivos gerados pelo Python), em MB; padrão 1024. A `api` o aplica nos uploads e o `worker` nos arquivos gerados pelo `run_python`: **use o mesmo valor nos dois**. |
| `AION_OPENCODE_GO_BASE_URL` | opcional | opcional | | Base da API do OpenCode Go. Padrão `https://opencode.ai/zen/go/v1`. Só https (http apenas em loopback). Nenhuma entrada do usuário define destino de rede. |
| `AION_ANTHROPIC_BASE_URL` | opcional | opcional | | Base da API da Anthropic (segundo provedor de modelos, phase 17). Padrão `https://api.anthropic.com/v1`. Mesmas regras do OpenCode Go (só https, http apenas em loopback, sem credenciais, consulta nem fragmento). A **chave** da Anthropic não é variável de ambiente: entra em Configurações → Conexões e fica cifrada no banco. |
| `AION_COMPOSIO_BASE_URL` | opcional | opcional | | Base da API v3 do Composio. Padrão `https://backend.composio.dev/api/v3`. Mesmas regras. |
| `AION_PARALLEL_BASE_URL` | opcional | opcional | | Endpoint MCP da Parallel (pesquisa na web). Padrão `https://search.parallel.ai/mcp`. Mesmas regras (só https, http apenas em loopback; sem credenciais, consulta nem fragmento). A chave opcional da Parallel **não** é variável: entra em Configurações → Conexões → Pesquisa na web. |
| `AION_FCM_WEB_CONFIG` | opcional (par) | | | JSON do **app web** do Firebase com `apiKey`, `projectId`, `messagingSenderId` e `appId`, **ou esse JSON em base64** (use base64 no Easypanel: o painel pode estragar as aspas do JSON). Ver *Notificações push*. Configuração **pública**, entregue ao navegador. Junto com `AION_FCM_VAPID_KEY` liga o aviso "Ativar notificações". |
| `AION_FCM_VAPID_KEY` | opcional (par) | | | Chave VAPID pública (Firebase, Cloud Messaging, Web Push). Uma das duas sozinha, ou qualquer uma inválida, **desliga o push** (a `api` sobe normalmente e o log registra o nome da variável). |
| `AION_FCM_SERVICE_ACCOUNT` | | opcional | | JSON da **conta de serviço** do Firebase (ou esse JSON em base64, para colar numa linha só). **Segredo**: só o `worker` o recebe, e só ele envia push. Sem ele, os avisos são descartados com um aviso no log. |
| `AION_FCM_BASE_URL` / `AION_FCM_TOKEN_URL` | | opcional | | Destinos de saída fixos do FCM. Padrão `https://fcm.googleapis.com` e `https://oauth2.googleapis.com/token`. Só https (http apenas em loopback). |
| `AION_SANDBOX_URL` | opcional (par) | opcional (par) | | Endereço interno do serviço `sandbox` do Python, ex.: `http://aion_sandbox:8080` (http ou https, sem caminho, credenciais nem consulta). Com `AION_SANDBOX_TOKEN`, o `worker` oferece a ferramenta `run_python` e a `api` confere a saúde para Configurações → Conexões → Python. Sem o par, o Python não existe e nada mais muda; uma das duas sozinha ou inválida **desliga o Python** sem impedir a subida (o log cita só o nome). |
| `AION_SANDBOX_TOKEN` | opcional (par) | opcional (par) | | **Segredo** próprio do sandbox, de 32 a 512 caracteres ASCII sem espaço (`openssl rand -hex 32`); o **mesmo valor** da variável de igual nome no serviço `sandbox`. Nunca vai ao navegador nem ao log. |
| `AION_TOTP_RESET` | opcional | | | `true` desativa o autenticador (TOTP) ao iniciar a `api` e registra a ação na auditoria. Só para recuperação (ver *Recuperar o acesso sem o autenticador*); **remova depois**. |
| `LOG_LEVEL` | opcional | opcional | | Padrão `info`. `debug` e `trace` são ignorados em produção. |
| `NODE_ENV` | `production` | `production` | `production` | As imagens já definem `production`. |

As variáveis do **push** são opcionais e **nunca impedem a subida**: se estiverem inválidas, a `api` e o `worker` sobem sem push e o log (`configuração opcional ignorada`) cita só o nome da variável. Já sem `AION_OWNER_EMAIL`, `AION_OWNER_PASSWORD` ou `AION_MASTER_KEY` (ou com valor inválido), a `api` **não inicia** e
o log cita apenas o nome da variável, nunca o valor. O `worker` tem a mesma regra para `DATABASE_URL` e `AION_MASTER_KEY`
e nunca recebe a credencial do dono.

### Serviço sandbox (Python, opcional)

O `run_python` só existe com o serviço `sandbox` no ar e o par `AION_SANDBOX_URL`/`AION_SANDBOX_TOKEN` na `api` e no
`worker`. Sem ele, o resto do Aion funciona igual. O sandbox não guarda nada, não acessa o banco e não recebe nenhum
segredo do Aion: o `worker` manda o código e os arquivos, valida tudo o que volta e é o único que grava.

1. **Token próprio:** gere um valor aleatório novo, só para o sandbox (32 a 512 caracteres ASCII sem espaço), com
   `openssl rand -hex 32`. Não reaproveite a chave mestra nem outra senha.
2. **Serviço:** crie um serviço **App** `sandbox` no projeto `aion`:
   - Fonte: **GitHub**, este repositório, branch `main`, **implantação automática** ligada;
   - Build: **Dockerfile**, caminho `apps/sandbox/Dockerfile` (contexto na raiz do repositório);
   - **Sem domínio** e sem porta publicada: ele escuta em `8080` só na rede interna do projeto;
   - **Environment:** apenas `AION_SANDBOX_TOKEN` com o token do passo 1. **Nenhuma** outra variável do Aion
     (`DATABASE_URL`, `AION_MASTER_KEY`, credenciais do dono, chaves de terceiros): um escape do Python não pode
     encontrar segredos aqui. O serviço lê o token, apaga-o do próprio ambiente e não sobe sem ele;
   - **Limite de memória** do serviço (configuração de recursos do App no Easypanel): **3 GB** (reserva opcional de 1 GB). Com SciPy, a base com as 2
     vagas aquecidas mede cerca de 1,2 GiB, e cada chamada pode crescer até 768 MiB sobre a base antes do encerramento
     forçado (512 MiB do WebAssembly mais a memória JavaScript fora dele), ou seja, cerca de 2,7 GiB no pior caso com as
     2 vagas ocupadas, mais folga para o reaquecimento. Este limite é o **teto real**: se o kernel matar um processo por
     falta de memória, a chamada volta como "Memória esgotada" e a vaga é reaquecida. Valores em
     `apps/sandbox/src/protocol.ts` (`LIMITS`).
3. **`api` e `worker`:** acrescente nos dois `AION_SANDBOX_URL=http://<host-interno-do-sandbox>:8080` (o host interno
   aparece na aba do serviço, normalmente `aion_sandbox`) e `AION_SANDBOX_TOKEN` com o **mesmo** token. Reimplante os dois.
4. **Conferência:** Configurações → Conexões → Python deve mostrar **Disponível** (a `api` consulta a saúde do sandbox; "Não
   instalado" indica o par de variáveis ausente ou inválido, e "Indisponível agora", sandbox sem resposta ou token diferente). O
   aquecimento das 2 vagas leva alguns segundos; o healthcheck da imagem usa o próprio `/health` com o token. Para
   trocar o token, mude-o nos três serviços e reimplante os três.

**Rede sem saída (risco residual da Suposição 22c).** O código Python roda no WebAssembly de um processo filho do Node 26
sem permissão de rede, de processo ou de escrita, e cada processo é descartado ao fim da chamada. Ainda assim, no nível do
Docker o container tem saída para a internet, e um escape duplo (WebAssembly e permissões do Node) poderia enviar para
fora os dados daquela chamada. Verifique no VPS, por SSH:

```bash
docker exec "$(docker ps -q -f name=aion_sandbox | head -n1)" node -e "fetch('https://example.com',{signal:AbortSignal.timeout(5000)}).then(r=>console.log('SAIDA ABERTA',r.status),e=>console.log('sem saida',e.cause?.code||e.name))"
```

O comando roda no processo principal do container (sem as restrições do Python) e mede só a rede do Docker:
`sem saida` é o resultado desejado; `SAIDA ABERTA 200` confirma a saída. Numa rede Docker criada com `--internal` o
mesmo comando responde `sem saida EAI_AGAIN` (provado localmente com a imagem do sandbox). O Easypanel liga os Apps à
rede do projeto, que tem saída, e a interface não oferece rede interna sem saída por serviço; uma rede `--internal`
ligada à mão (`docker service update --network-add`) seria desfeita no próximo deploy e cortaria também a conversa com o
`worker`, se ele não estiver nela. Enquanto o Easypanel não permitir, o risco fica registrado e coberto pelas camadas do
próprio sandbox: Python em WebAssembly sem rede, `pip` nem JavaScript; processo filho com o modelo de permissões do Node
(leitura só do runtime, sem rede, sem processos filhos, sem escrita); arquivos de root só leitura e usuário `node`; nenhum
segredo do Aion no ambiente; um processo novo por chamada (o escape só alcança os dados daquela chamada); e token próprio
comparado em tempo constante. Se o Easypanel passar a oferecer rede sem saída por serviço, ela vira requisito de operação.

### Como uma mensagem vira trabalho (conversa e worker)

A `api` só enfileira, lê e transmite: enviar uma mensagem cria uma execução `queued` na tabela `runs` (a fila é o próprio
banco, FIFO por bot, e um índice único garante **uma execução ativa por bot**). O `worker` reivindica a execução, grava a
mensagem do dono na conversa, chama o modelo etapa por etapa e grava tudo no banco: o texto aos poucos, cada chamada de
ferramenta e o desfecho. A tela recebe o resultado por SSE (`GET /api/bots/:id/conversation/events`), que retoma a partir do
último evento recebido (`Last-Event-ID`).

- **Reinício do worker:** uma execução `running` cuja posse (`lease_until`, renovada a cada segundo) venceu é retomada por
  outro worker; o texto parcial é descartado e a etapa é refeita. Um encerramento ordenado (`SIGTERM`) devolve a posse na hora.
- **Esperar a API:** o `worker` só começa depois que a `api` aplicou as migrations (falha depois de 60 s, para o Easypanel reiniciar).
- **Proxy:** o SSE é uma resposta longa. O Traefik do Easypanel a repassa sem buffer; se outro proxy entrar na frente, desligue o
  buffering de resposta para o caminho `/api/` (a API já envia `X-Accel-Buffering: no`). A API encerra cada conexão SSE depois de
  5 minutos e o navegador reconecta sozinho, conferindo a sessão de novo.

### Modelo, effort e contexto da execução

Modelo e effort têm controles separados no composer. Alterar effort mantém o modelo; trocar de modelo redefine o nível para Padrão. O controle de effort aparece somente nos modelos com níveis confirmados. No protocolo `messages`, o nível usa `output_config.effort`; Padrão omite o parâmetro.

O turno de sistema não tem hora nem modelo, para ficar idêntico entre execuções e aproveitar o cache de prompt do provedor (`packages/core/src/runs/context.ts`). No bot, ele traz Funcionamento do Aion (texto-base com o nome), Ferramentas fora da sua lista (o índice da árvore de grupos, desde a phase 15), Regras Globais, Dados (só o idioma), Formatação das respostas, Regras do agente e Memória do agente; no Chat geral, Funcionamento do Aion (variante do chat), Regras Globais, Dados e Formatação. Depois do sistema vem o histórico como foi gravado, que só cresce no fim até a próxima compactação (ver *Contexto, objetivo e compactação*). O turno que abre cada rodada leva o bloco `# Dados` (modelo desta resposta, `Agora` até o minuto e fuso com GMT) seguido de `# Mensagem`. Desde a phase 10 o bloco é montado uma única vez, na primeira preparação de cada execução, gravado em `runs.request_data` (migration 0044) e reenviado igual em todas as etapas, nas retomadas e nas rodadas seguintes, para o pedido anterior ser sempre o começo exato do próximo e o provedor reaproveitar o cache; cada rodada leva o bloco da execução mais recente que o gravou para a mensagem dela (no Chat geral, a do caminho ativo), e rodada antiga sem bloco entra sem ele. O bloco não aparece na timeline, em `search_history`, em `read_activity` nem na entrada do resumo. No Chat geral, `[Sistema] Novo chat aberto.` entra como primeira rodada derivada enquanto a sessão tem menos de cinco rodadas e a abertura íntegra está presente, sem resumo; não é gravado nem aparece na busca do histórico. **Ferramentas do bot (phase 15).** O campo `tools` do bot é fixo dentro da conversa (`botCatalogNames` em `packages/core/src/runs/tool-discovery.ts`): as portas `abrir_grupo`, `use_tool`, `read_activity`, `composio_search_actions` e `composio_execute_action` (as duas do conector só com conta liberada e ativa) e as até 5 ferramentas mais usadas do bot, limitadas a 12.000 bytes de definições. O resto do catálogo mora na árvore de grupos `TOOL_TREE` (por exemplo `artefatos/docs`, `artefatos/tabelas/dados`, `ferramentas/rotinas` e `ferramentas/web`), cujo índice vai no turno de sistema. O bot abre um galho ou uma folha com `abrir_grupo`, recebe o esquema de cada ferramenta aberta em resultado próprio no fim do histórico, sem mudar `tools`, e a chama com `use_tool`; quem passa pelo portão de aprovação é a ferramenta de destino, nunca a porta, e `use_tool` recusa as reservadas, a si mesma e as portas do conector. As mais usadas saem do uso do próprio bot nos últimos 30 dias e só são recalculadas quando a conversa fica fria ou numa compactação aplicada, com a contagem congelada nesse instante; bot novo começa com `table_query`, `table_write` e `edit_memory`. Ferramenta nova entra com o nome dela no galho certo de `TOOL_TREE`. O Chat geral fica sem árvore e segue com as 7 ferramentas de antes, descritas a seguir.

**Ferramentas do Chat geral.** As ferramentas são publicadas sob demanda: `discover_tools` apresenta um índice compacto do registro disponível e seleciona até oito schemas nativos por chamada. Desde a phase 12 a lista de ferramentas do pedido só cresce dentro da conversa (`selectCatalog` em `packages/core/src/runs/tool-discovery.ts`): cada seleção se soma às anteriores, derivada das atividades `discover_tools` gravadas na conversa, sem tabela própria; a ordem é a da primeira seleção, então uma ferramenta nunca selecionada antes entra no fim, a opcional que saiu na compactação e é selecionada de novo volta à posição da primeira seleção, a ordem anterior é preservada e `names: []` não descarrega nada. A escala de calibração não muda a lista. As definições da web só mudam quando o dono muda o interruptor da pesquisa. Assim o campo `tools` fica idêntico entre etapas e rodadas sem descoberta, e o prefixo do pedido segue em cache. No bot, as definições do Composio, montadas com os apps e as contas liberadas a ele (desde a phase 13), só mudam quando o conteúdo muda, ou seja, quando o dono conecta ou desconecta um app ou uma conta, libera, revoga ou renomeia uma conta liberada ao bot; uma releitura do Composio que falha por indisponibilidade (`CONNECTOR_UNAVAILABLE`) mantém as definições da última leitura boa da mesma chave. O teto de 65% do orçamento de entrada só retira opcionais depois de uma compactação aplicada, e só as selecionadas até o corte dela, da mais antiga para a mais nova, com indicação para redescobri-las; a conta desse teto usa a estimativa de 1 byte por token, sem calibração nem histórico. A rede de segurança é a única outra saída: quando o pedido só terminaria em `CONTEXT_TOO_LARGE`, as opcionais saem apenas daquele pedido, com o aviso de omitidas e sem nada gravado, e a preparação seguinte recalcula a lista do mesmo jeito. As ferramentas essenciais do Chat geral (core: busca no histórico, anexos e Python, `CORE_TOOLS`) e as portas nunca saem, e se sistema e essenciais passarem do teto é o histórico que se compacta. `read_activity` permanece disponível para recuperar payloads históricos por referência. O registro executável, as permissões e as aprovações continuam no servidor; selecionar um schema não concede acesso nem executa uma ação. As regras específicas ficam na descrição da ferramenta oferecida, com ordem estável do registro. O sistema é fixado no início de cada trecho e relido na retomada após aprovação ou reinício; o bloco `# Dados` não muda na retomada nem quando o modelo troca no meio da execução, e idioma e fuso alterados valem a partir da próxima execução. Uma alteração de memória feita por ferramenta é persistida e entra nas etapas seguintes pelo resultado da ferramenta; o sistema é relido no próximo trecho.

Cada etapa concluída registra somente ids, modelo, protocolo e números de `usage`: tokens de entrada, em cache, gravados no cache e saída, quando informados. No protocolo `messages` o cache é explícito: desde a phase 12 o pedido leva `cache_control: {type: "ephemeral"}` (5 minutos) no último item de `tools`, no último bloco do sistema, que passou a ser uma lista de blocos, e no último bloco da última mensagem (`packages/core/src/models/chat-protocols.ts`); `chat_completions` e `responses` não mudam. Nesse protocolo a leitura (`cache_read_input_tokens`) vai para os tokens em cache, a gravação (`cache_creation_input_tokens`) vai para `model_call_usage.cache_write_tokens` (migration 0049, nula quando o provedor não informa) e os tokens de entrada seguem como o total do pedido, leitura e gravação incluídas, para a ocupação não mudar; no stream, o evento final não sobrescreve a contagem de cache do início. O ledger de contexto também persiste chamadas principais e resumos, identidade de preparação e estado conhecido/desconhecido para a interface e a comparação de consumo. Os três protocolos são lidos; no streaming de `chat_completions`, uma recusa identificada de `stream_options.include_usage` permite repetir sem esse parâmetro antes de começar o stream. Cache do Composio e cache de prompt do provedor são mecanismos diferentes.

Cada chamada de resumo tem linha própria no ledger, com o uso informado e o desfecho em `summary_outcome`; uma chamada recusada conserva o custo como conhecido, mas não significa resumo aplicado. A recusa definitiva de uma compactação automática fica registrada pela impressão do conjunto coberto (migration 0042) e vale para todas as execuções até mudar o conteúdo coberto ou o modelo do resumo. A migration 0038 preserva o recibo `summary_outcome` no rollback de aplicação; não remova a coluna com desfechos gravados.

### Contexto, objetivo e compactação (phases 8, 9 e 11)

Em **Configurações → Preferências**, as janelas de bots e do Chat geral são independentes: **64k, 128k, 256k ou 512k**, com padrão de 256k desde a phase 11. A de 32k saiu: o servidor a recusa com `VALIDATION_FAILED`, e a migration `0046` levou os globais a 256k e os bots que estavam em 32k a 64k (o rollback devolve 128k ao global dos bots, 64k ao do Chat geral e a opção de 32k, rebaixa 512k para 256k e mantém em 64k os bots que vieram de 32k, sem apagar dados). Um bot pode herdar sua preferência global ou escolher outro desses presets. A janela efetiva é a menor entre a escolhida e a capacidade fundamentada do modelo efetivo (o registro de capacidade inclui o MiMo V2.6 Pro, com 1M de contexto), sem apagar a preferência escolhida. Sem capacidade confirmada para o modelo, vale exatamente a janela escolhida, sem teto nem aviso provisório; sem modelo, não se apresenta uma janela disponível. Trocar o modelo da conversa preserva a precedência existente e recalcula essa resolução no servidor.

O objetivo do bot é separado de memória, instruções e autorização. Tem até 2.000 caracteres Unicode, revisão própria e evidências de mensagens do dono já absorvidas. `update_objective` só existe para bots; anexos e respostas externas não podem fornecer autoridade para alterá-lo. O cartão permite desfazer a revisão vigente; replay não cria outra revisão e uma atualização posterior impede sobrescrita. Após desfazer, o bot precisa de nova evidência do dono para atualizar novamente. O convite inicial não cria rodada, inferência ou notificação, e não bloqueia um pedido sem objetivo.

O orçamento de entrada desconta a reserva de saída e uma margem de 2.048 tokens da janela efetiva. Desde a phase 12 a reserva de saída de cada etapa é a menor entre 32.768 tokens, 25% da janela efetiva (arredondado para baixo) e a capacidade de saída confirmada do modelo (`contextEnvelope` em `packages/core/src/runs/context-budget.ts`): 16.384 em 64k e 32.768 de 128k para cima, o que deixa orçamentos de entrada de 47.104, 96.256, 227.328 e 489.472 tokens em 64k, 128k, 256k e 512k. O mesmo número vai no `max_tokens` do corpo, na estimativa e no log. Uma medição gravada com outra reserva fica desatualizada e o indicador passa a mostrar o orçamento vigente até a próxima preparação medir de novo. As 3 continuações automáticas seguem a regra de sempre e, de 128k para cima, somam até 98.304 tokens de saída por execução; o resumo mantém o teto de saída próprio. O estimador usa os bytes UTF-8 do corpo realmente serializado, incluindo schemas, escapes e pares de ferramenta, com margem de enquadramento; é uma **estimativa conservadora**, reduzida pela calibração observada do modelo. A ocupação é uma conta única, usada pelo indicador e pelo gatilho: os tokens de entrada que o provedor informou na última chamada principal concluída do mesmo modelo, cache incluído, mais o acréscimo estimado desde aquele pedido (`packages/core/src/runs/context-anchor.ts`). Sem essa âncora (primeira chamada, troca de modelo, usage implausível ou compactação aplicada depois dela), vale a estimativa calibrada.

A cobertura do histórico começa uma única vez, na primeira preparação da conversa, nas últimas 5 rodadas (`ROUNDS_IN_CONTEXT` em `packages/shared/src/conversation.ts`; no Chat geral, contadas no caminho ativo); esse ponto de partida fica fixo (`coverage_start`) e não desliza a cada rodada. Rodadas anteriores a ele não entram no pedido e só voltam por `search_history` e `read_activity`. Entre compactações, o histórico entra no pedido como foi gravado e só cresce no fim, o que mantém o prefixo idêntico e aproveitado do cache do provedor. O resultado de ferramenta é gravado íntegro até 256 KiB (acima disso, cortado com o tamanho original) e chega ao modelo numa forma única e estável, função só da linha gravada e do nome da ferramenta: no máximo 12.000 caracteres no total, marcador incluído, para toda ferramenta, sem exceção para as que têm limite próprio (`RESULT_PROMPT_MAX_CHARS` em `packages/core/src/runs/context.ts`). Se cortado, o texto termina com `[mostrando N de M caracteres; íntegro em read_activity messageId=<id>]`, e `read_activity` devolve por páginas o original gravado. Algumas ferramentas têm forma própria antes do teto: o `table_query` vai como tabela markdown com id curto (ver *Tabelas e trabalho recorrente*), a ação do conector vai limpa, dentro da moldura de dado não confiável (ver *Ações do Composio e aprovações*), a página do `doc_read` vai na moldura do doc, já cortada no que cabe (ver *Artefatos: tabelas e docs*), e `run_python` e `read_attachment` cortam só o corpo, preservando completo o fim obrigatório (fechamento do bloco de dado não confiável, aviso de saída cortada e lista de arquivos gerados). A gravação e a tela não mudam. No deploy da phase 11, cada conversa existente perde o cache uma vez, porque o teto e a limpeza mudam a forma dos resultados antigos.

A compactação automática é única e dispara a 90% do orçamento de entrada (`COMPACTION_THRESHOLD` em `context-budget.ts`). O histórico antigo vira um checkpoint estruturado em PT-BR com sete seções (objetivo e pedidos do dono, restrições, decisões, estado, efeitos externos, próximo passo e referências), e um trecho final de até 25% do orçamento fica íntegro, cortado em unidades inteiras e sempre com as mensagens do dono da rodada atual e a etapa mais recente. Desde a phase 11 o pedido de resumo traz, já na primeira tentativa, o alvo de 4.000 a 6.000 caracteres para o checkpoint; 16.000 caracteres continuam como teto, e é só o teto que a validação confere. Com checkpoint anterior, o resumo trabalha em modo atualizar: recebe o checkpoint vigente e só as unidades novas, com a instrução de enxugar o que perdeu relevância. Sistema, memória do bot, Regras Globais, idioma, objetivo e catálogo nunca são resumidos e não invalidam o checkpoint; ele só é invalidado quando muda o conteúdo que cobre (no Chat geral, também quando o caminho ativo muda). Depois da compactação, o pedido traz a abertura da rodada atual e os complementos do dono mantidos íntegros, o checkpoint logo antes do primeiro item íntegro posterior ao trecho coberto e o trecho final. A chamada de resumo não leva ferramentas, usa o effort mais baixo que o modelo do resumo aceita e até 6.144 tokens de saída (`SUMMARY_MAX_OUTPUT_TOKENS`: o raciocínio do modelo conta no limite do provedor, e com 2.048 o deepseek-v4.1-flash gastava tudo pensando e nunca devolvia o texto). Resposta fora do formato ganha uma segunda tentativa com lembrete; recusa definitiva repete com a entrada reduzida a 70%, 50% e 35%; esgotadas as tentativas, a recusa é registrada e a execução segue.

O colapso em índice é só a rede de segurança, sem chamada ao modelo: entra quando a compactação falha ou quando checkpoint e trecho final ainda passam de 100% do orçamento. O começo do histórico vira um índice com ids só de dígitos (ou a faixa de ids e a contagem por tipo, quando as linhas não cabem), e o corte vigente é mantido entre as etapas enquanto o pedido couber. O recall acontece por `read_activity` (aceita o id com ou sem `#`) e `search_history`, que devolve o `messageId`, a data e o tipo de cada trecho. Uma recusa confirmada de tamanho pelo provedor, antes de qualquer texto ou chamada de ferramenta, provoca uma compactação forçada e uma única nova chamada; a segunda recusa encerra com `CONTEXT_TOO_LARGE`, sem trocar de modelo nem repetir efeitos externos.

**Manutenção fria (phases 11 e 15).** Uma conversa é fria quando não há nenhuma chamada ao modelo nela há mais de 40 minutos (`COLD_AFTER_MS` em `packages/core/src/runs/cold-maintenance.ts`, valor medido pela sonda `validate:cache-ttl`) e nenhuma execução ativa ou na fila. Só nesse estado, quando o cache do provedor provavelmente já se perdeu (40 minutos fica acima dos 30 medidos com cache válido), o histórico muda fora da compactação comum; com a conversa quente nada muda. O mascaramento troca cada resultado de ferramenta concluído com mais de 1.000 caracteres gravados, fora das 2 rodadas mais recentes, pelo marcador `[resultado de <ferramenta>, <tamanho> caracteres, #<id>; releia com read_activity]`. Mensagens do dono, respostas do bot e cartões nunca mudam, a página inicial lida por `read_attachment` fica de fora e, no Chat geral, vale só o caminho ativo. A limpeza é gravada uma vez por resultado (`context_cold_masks`, migration `0047`), para o pedido seguinte começar igual ao último pedido limpo e voltar a aproveitar o cache; o resultado íntegro continua no banco e em `read_activity`. Ela vale também na entrada do resumo, não invalida o checkpoint e descarta a âncora de ocupação. Quem a aplica é o laço do worker, a cada minuto, e, como rede de segurança, a abertura de uma execução numa conversa fria que o worker ainda não tratou, que grava o mascaramento antes do primeiro pedido sem chamar o modelo.

Depois do mascaramento, se a ocupação (a mesma conta do indicador e do gatilho de 90%) ainda estiver no gatilho frio ou acima dele, o worker enfileira na fila da conversa uma compactação em segundo plano com gatilho próprio. Desde a phase 15 o gatilho frio é o menor entre 40.000 tokens e 50% do orçamento de entrada (`coldTriggerTokens`, com `COLD_TRIGGER_TOKENS` e `COLD_COMPACTION_SHARE` em `cold-maintenance.ts`): 23.552 tokens na janela de 64k e 40.000 de 128k para cima (antes eram só os 50%, 113 mil tokens na janela padrão de 256k, e a rotina que abria numa conversa fria pagava a abertura inteira sem cache). O trecho final íntegro da compactação fria fica limitado para a abertura seguinte ficar perto de 30.000 tokens (`COLD_OPENING_TOKENS`: piso do pedido, checkpoint e trecho final somados, além do teto de 25% de sempre), e a abertura e os complementos do dono da rodada mais recente ainda não coberta nunca viram só resumo, para a rotina seguinte ainda ver a mensagem recente do dono. É a compactação de sempre, com o Modelo do resumo, e respeita a recusa registrada e a idempotência por revisão; o gatilho de 90% com a conversa quente não muda. Ela é invisível ao dono: não cria operação no painel, cartão, push nem bolinha, e não aparece como trabalho na lista de bots. A migration `0048` torna `context_maintenance.session_id` anulável para essa manutenção sem sessão do dono. Uma mensagem enviada durante a compactação espera na fila e já prepara o pedido com o checkpoint novo; o resumo pago nunca é descartado, e a falha não muda a conversa nem derruba execução. Os rollbacks da `0047` e da `0048` recusam enquanto houver limpeza fria ou manutenção fria gravada, sem apagar dados.

**Limitação de imagens:** sem estimativa visual fundamentada, o motor recusa o envio com `CONTEXT_ESTIMATE_UNAVAILABLE`. Não remove a imagem para forçar o pedido a caber, nem usa o tamanho de base64 como contagem de tokens visuais. Pedido e anexos ficam preservados, mas essa execução não está concluída. Compatibilidade de visão e estimativa de ocupação são verificações distintas; suporte anterior à imagem não certifica esta estimativa. Blocos obrigatórios (sistema, objetivo, ferramentas essenciais e a mensagem nova) que excedem a janela geram `CONTEXT_TOO_LARGE`. Exceção: sem calibração de tokens do modelo (primeira chamada de um modelo, estimativa de 1 byte por token) o sistema com as essenciais pode passar do orçamento só na estimativa; nesse caso o pedido final ainda é conferido na escala mais otimista plausível (0,2 token por byte) e só segue se couber assim (senão, `CONTEXT_TOO_LARGE` na hora, sem chamada ao provedor), e a chamada que segue leva o histórico no mínimo, o provedor decide e uma recusa de contexto confirmada vira `CONTEXT_TOO_LARGE` depois de uma repreparação. "Sem calibração" quer dizer sem amostra válida de usage do modelo: com amostra, mesmo de razão alta (escala em 1), um piso que não cabe é recusado de imediato. A falha do resumo automático nunca derruba a execução: vira "sem compactação", e o colapso resolve se o pedido não couber. `CONTEXT_COMPACTION_FAILED` fica restrito ao resumo: na compactação manual indica que nada foi aplicado. Se o modelo, a janela ou o effort mudam durante a preparação da etapa, ela é preparada de novo uma vez com a configuração vigente, e só uma segunda mudança encerra a execução com `CONTEXT_CONFIGURATION_CHANGED`. A falta da evidência das fontes de contexto, ou uma fonte removida ou revogada depois da preparação, encerra com `CONTEXT_EVIDENCE_UNAVAILABLE`.

O indicador **Contexto**, junto ao composer de bot/chat, abre metadados sem chamar o modelo. No Início, mostra somente a ausência de medição, sem criar sessão. A ocupação exibida é a mesma conta do gatilho, dividida pelo orçamento de entrada após reservas; rascunhos não enviados ficam fora. Sem medição, aparece “Ainda não calculado”. Ao fim de cada chamada principal, a medição passa a ser a entrada real informada pelo provedor, sem marcar "Desatualizado" por causa da própria resposta; só conteúdo ou configuração novos depois dela tornam a medição desatualizada. O dropdown mostra o percentual de uso da janela, avisos e a ação "Compactar agora"; quando a compactação automática atua no pedido corrente, o indicador mostra "compactado" de forma discreta. Consumo e custo ficam nos registros de uso, fora do painel.

**Compactar agora** executa a mesma compactação, abaixo do limiar. Exige modelo validado, chave do provedor configurada e histórico fora do trecho final para cobrir; sem isso, o botão fica desabilitado com o motivo. Consome tokens e pode não liberar espaço: o painel mostra "Compactando…" com cancelar e, no fim, o antes e depois ou o motivo seguro da falha (`contextFailureMessage`). Por ser pedido explícito do dono, ignora a recusa registrada do conjunto e a desistência da execução, então cada clique pode pagar de novo um resumo já recusado. Exige conversa ociosa; execução, aprovação ou manutenção pendentes mostram o motivo e bloqueiam outro pedido. Um novo envio durante a compactação segue a fila normal, sem virar complemento nem se perder.

Em **Configurações → Preferências**, **Modelo do resumo** escolhe o modelo que compacta conversas longas (`app_settings.summary_model`, migration 0041). A opção padrão, "Mesmo modelo da conversa", grava vazio. O servidor só aceita modelo validado do provedor, confere de novo no uso e, se o modelo deixou de valer, usa o da conversa e registra no log.

A operação manual usa `requestId` UUID e `expectedRevision` no endpoint autenticado `POST /api/bots/:id/conversation/context/maintenance` ou no equivalente de sessão `/api/chat/sessions/:id/conversation/context/maintenance`; o corpo aceita somente `mode: summarize` e esses dois campos, com teto de 1 KiB; operações antigas com `elision` continuam legíveis no histórico do painel. Há limite de cinco novos pedidos por minuto por sessão de login; replay idêntico retorna a operação existente. `GET .../conversation/context` lê o estado, e `POST .../conversation/context/maintenance/:requestId/cancel` com corpo `{}` cancela a operação autorizada. Sessão, Origin e CSRF seguem as proteções existentes. Manutenção não cria mensagem, rodada, não lido, push nem item de atividade.

Checkpoint e confirmação do resumo são um único commit sob a posse vigente. Resposta recebida sem checkpoint confirmado mantém o uso observado e resultado desconhecido; restart não paga novamente essa chamada automaticamente. A identidade `preparation_id` liga resumos à chamada principal, e a manutenção usa seu `requestId` ao retomar. Legado sem identidade permanece desconhecido. Resultados confirmados de ferramentas são relidos por referência. Falhas internas encerradas também podem ser paginadas, conservando `failed`, erro/desfecho e aviso de corte, com a mesma validação de origem; isso não transforma falha em sucesso. Falhas externas ou efeitos incertos permanecem protegidos, e ações externas não são reexecutadas para recuperar conteúdo. Recibos locais reconhecem efeito já gravado, inclusive se a regra atual mudou para negar novas execuções.

Dependências de anexos/tabelas são registradas pelo servidor e propagadas por Python, recall e resumos sucessivos. Remoção/revogação invalida derivados antes de leituras e envios seguintes; legado sem proveniência suficiente é omitido conservadoramente. Revisão de acesso é separada da versão de células, e revoke/regrant não revalida cópias antigas. A reserva autorizada é gravada antes da rede em transação curta; revogação posterior não desfaz uma requisição já autorizada, mas impede uso seguinte e persistência derivada sem nova validação. Projeção e resumo não apagam mensagens ou originais persistidos; não recuperam bytes que já haviam sido descartados pela origem.

#### Recuperação e rollback da aplicação

As migrations `0033` a `0037` preservam preferências, objetivos, revisões, proveniência, checkpoints, uso e operações. **Com dados, volte a aplicação sem baixar essas migrations.** Os rollbacks de schema recusam perda de estado; são destinados somente ao cenário vazio explicitamente verificado. Backup deve incluir banco e chave mestra, conforme OPS-01.

O código anterior puro não é um artefato de rollback compatível: seu codec não reconhece `objective_updated` e seu worker não distingue execuções de manutenção. Para recuperação, prepare um artefato separado com manifesto/hashes e patch de leitura que apresente o cartão novo como referência neutra preservando sua âncora, omita-o do contexto/busca antigos e avance os eventos SSE novos sem mutar o banco. Mantenha o baseline de benchmark intacto. Essa compatibilidade precisa de prova operacional de snapshot, paginação, SSE, integridade e retorno à Phase 8 antes de publicação.

Procedimento de recuperação **restrito a leitura e quiescência**, sem promessa de compatibilidade do motor antigo para mutações:

1. Bloqueie novos envios, rotinas e pedidos de manutenção. Com a API/worker atuais ainda ativos, cancele as manutenções queued/running pelos endpoints acima, ou deixe a operação conhecida terminar. Aguarde estado terminal durável de cada operação e de suas execuções; preserve resultados desconhecidos e uso observado, sem repetir inferências para encerrá-los.
2. Pare o worker atual e desligue a API antes da troca. Não inicie o worker antigo: manutenção abandonada não pode ser retomada como mensagem/inferência comum. Preserve todos os dados e registros de migrations; não exclua operações, cartões ou mensagens para fazer o código anterior aceitar o banco.
3. Suba somente o artefato de API/web com compatibilidade de leitura certificada, protegendo-o operacionalmente contra alterações. **Não permita mutações de ACL/compartilhamento, anexos, tabelas, mensagens, objetivos, memória ou configuração no binário antigo.** Ele não atualiza a revisão de acesso da Phase 8; revogar e conceder novamente acesso nele poderia tornar derivados anteriores aparentemente válidos na volta. Ocultar botões não substitui bloquear operações no servidor/proxy.
4. Confira contratos HTTP/SSE e âncoras de paginação, e compare banco/mensagens/objetivos/recibos/usage com o snapshot preservado. Encerrada a recuperação, pare o artefato antigo, retorne à API/web da Phase 8, verifique as migrations sem removê-las e só então religue o worker e os envios. Confirme leitura dos dados originais e nenhuma manutenção incerta repetida.

O manifesto/patch e o procedimento acima delimitam o que deve ser certificado; sua presença nesta documentação não afirma que o rollout/rollback operacional já foi validado nem autoriza deploy.

### Anexos e tela Arquivos

O composer de bot ou Chat geral aceita até cinco anexos. A imagem escolhida tem até 10 MB e é recodificada no navegador para JPEG de até 2.000 px, removendo metadados; o servidor aceita apenas JPEG de até 5 MB e valida sua estrutura. PDF/DOCX têm até 15 MB; TXT/MD/CSV/JSON, até 1 MB em UTF-8. Extração de documentos roda fora do laço da API, com prazo de 20 s e limite de 500.000 caracteres. O original do documento é descartado: abrir o chip baixa apenas o texto extraído como `.txt`. Planilhas `.xlsx` (até 15 MB) guardam o original, sem texto extraído, e são conferidas na mesma thread isolada: ZIP completo, tipo `spreadsheetml`, sem macros (`.xlsm` recusado), descompactadas até 100 MB e até 10.000 entradas. O original conta no espaço total e é baixado como anexo, com cache privado de uma hora.

Imagens exigem que o servidor confirme visão no modelo efetivo, além da estimativa de contexto fundamentada descrita na Phase 8. Resultado inconclusivo pode ser testado novamente; uma recusa transitória não marca o modelo como incapaz. O texto inicial respeita os limites por documento, turno e orçamento. Uma leitura original equivalente de `read_attachment`, do mesmo anexo e offset zero, ainda integral no contexto permite trocar a cópia inline por referência; se essa leitura virar referência de atividade, o corpo inline pode voltar enquanto couber. Sob pressão, metadados e referências recuperáveis substituem o texto inline. A mera exposição anterior não prova que o modelo ainda tem os dados. As molduras do mesmo conteúdo são estáveis para favorecer cache de prefixo, sem garantir acertos de cache ou economia monetária. Imagens não são descartadas por essa redução. Nas rodadas seguintes o texto e as imagens continuam na mensagem do dono, idênticos, até um checkpoint de compactação cobri-la; depois disso a mensagem sai do pedido, o resumo cita o id e o nome do anexo e o arquivo segue legível por `read_attachment`. Onde o custo visual do modelo é desconhecido, só a imagem da rodada atual vai ao modelo e as de rodadas anteriores ficam como metadados com a referência de leitura. `read_attachment`, isenta de aprovação, relê páginas de texto de até 30.000 caracteres, reduzidas pelo limite de bytes calculado pelo motor, com offset/nextOffset e sem partir caracteres Unicode; a leitura de imagem segue os controles de visão/contexto. Só acessa anexos da conversa da execução. Conteúdo de arquivo é marcado como dado não confiável.

JPEGs e texto extraído ficam no PostgreSQL, sob o teto global `AION_ATTACHMENTS_MAX_TOTAL_MB` (padrão 1024). A quota usa bytes armazenados. O tamanho mostrado usa o JPEG recebido para imagem e o arquivo escolhido para documento. Todas as rotas exigem sessão; alterações exigem Origin/CSRF. Há limites de 30 uploads/minuto e 10 exclusões em lote/minuto, com `Retry-After`, além de limites de quantidade, tamanho e concorrência.

Em Configurações → Atividade e arquivos, o botão "Ver arquivos" abre a lista (`/configuracoes/arquivos`), que recebe apenas metadados, pagina 50 itens por cursor e filtra origem/tipo. O atalho Arquivos do bot na conversa ou no editor abre `/bots/[id]/arquivos`, com identidade do bot e origem fixa; filtros de tipo e paginação mantêm esse vínculo. Quota e contagem de armazenamento continuam globais. Arquivar conserva os anexos; excluir definitivamente o bot os apaga na mesma transação. Abrir conteúdo faz uma consulta autenticada separada. É possível excluir um arquivo (`DELETE` sem corpo) ou lotes de até 100. Arquivo ligado a trabalho ativo é mantido com `ATTACHMENT_IN_USE`. Excluir zera conteúdo e resultados antigos de releitura na mesma transação; a mensagem continua com Arquivo removido. Auditoria guarda somente tipo, bytes e contagem. Pendentes com mais de 24 horas são apagados; excluir bot ou vencer sessão remove seus anexos em lotes.

### Ditado no navegador

O microfone aparece quando Web Speech está disponível. Usa o idioma configurado, insere texto na posição do cursor e nunca envia a mensagem sozinho. Edição manual ou saída da conversa encerra o reconhecimento. Áudio é processado pelo serviço de reconhecimento do navegador, podendo sair do aparelho; Aion não guarda áudio nem contrata transcrição própria. A prova no Chrome Android com PWA instalado depende do dono.

### Caches e conferência em produção

Em produção, somente chunks `/_next/static/*` têm `public, max-age=31536000, immutable`, e `/icons/*`, `public, max-age=86400` (os ícones têm o hash do conteúdo no nome, ver "PWA" abaixo: um ícone novo é outro endereço, então o cache da borda não o prende). HTML, manifesto, service worker e demais respostas permanecem `no-store`. Imagem de anexo usa `private, max-age=3600`; documento e demais respostas da API usam `no-store`. CSP e cabeçalhos de segurança permanecem nos estáticos. A exclusão no servidor não apaga uma cópia já baixada ou no cache privado do aparelho.

Depois de um deploy autorizado, conferir com `curl.exe -sSI` no Windows (ou `curl -sSI`):

```powershell
curl.exe -sSI https://aion.exemplo.com/api/health
curl.exe -sSI https://aion.exemplo.com/login
curl.exe -sSI https://aion.exemplo.com/sw.js
curl.exe -sSI https://aion.exemplo.com/manifest.webmanifest
# O endereço do ícone leva o hash do conteúdo e muda quando o desenho muda: ler o do manifesto em vez de um nome fixo.
$manifest = curl.exe -sS https://aion.exemplo.com/manifest.webmanifest | ConvertFrom-Json
curl.exe -sSI "https://aion.exemplo.com$($manifest.icons[0].src)"
```

API e web devem trazer `Permissions-Policy: camera=(), microphone=(self), geolocation=()`. Copiar do HTML de login o caminho atual de um script `/_next/static/` e conferir seu cache imutável, CSP, HSTS, nosniff, Referrer-Policy e proteção de framing. Imagem privada deve ser conferida numa sessão do dono; sem sessão, a recusa permanece `no-store`. Registrar também ditado/arquivos reais, tokens em cache no worker e cache de build no Easypanel, sem copiar credenciais para logs ou artefatos.

Os Dockerfiles instalam com lockfile congelado após copiar os manifestos de todo o workspace; copiam depois os pacotes e somente o app correspondente. API e worker finais levam apenas `dist`, sem `node_modules`; web usa standalone e um mount de cache de build em `.next/cache`. Uma mudança somente na web preserva instalação e build de API/worker. Esse cache foi provado localmente; sua utilização no Easypanel precisa da confirmação do dono.

### Ações do Composio e aprovações (T7)

Os apps são conectados no painel do Composio, no projeto de desenvolvedor da chave (`ak_...`, ver Configurações → Conexões). O
`worker` oferece ao bot o Composio **por níveis** (T29): duas ferramentas, `composio_search_actions` (busca por texto, num app conectado, e devolve as melhores ações com os parâmetros) e `composio_execute_action` (executa uma ação pelo slug), com os apps conectados na descrição da primeira. Antes, o bot recebia uma definição por ação (até 120), o que pesava dezenas de milhares de tokens por etapa e escondia apps. Buscar não pede aprovação (é leitura do catálogo, como as ferramentas internas); a execução passa pela regra POR AÇÃO: o executor traduz a chamada de `composio_execute_action` na da ação antes do portão, e o slug é conferido no Composio a cada execução (inclusive ao retomar uma aprovação, horas depois). **Nenhuma ação executa sem a regra
resolvida no servidor** (critério C4): a regra do bot vale; senão a global, se não for neutra; senão a ação **pergunta**.

**Contas por bot (phase 13).** O mesmo app pode ter várias contas conectadas no Composio (por exemplo, um Gmail pessoal e um profissional). Em **Configurações → Conexões** cada conta é uma linha, com nome editável (1 a 40 caracteres, único dentro do app; sem nome vale o rótulo automático com o nome do app e o sufixo do id, como "Gmail · ca_…1a2b"), estado e os bots liberados; o editor do bot só mostra as contas liberadas a ele. A regra mora em `packages/core/src/credentials/accounts.ts` (tabelas `connector_accounts`, `connector_account_bots` e `connector_seed`, migration `0050`) e a API em `apps/api/src/routes/connector-accounts.ts` (`GET /api/connector/accounts`, `PATCH /api/connector/accounts/:id` para o nome, `PUT /api/connector/accounts/:id/access` para a lista de bots, `DELETE /api/connector/accounts/:id` para remover a conta desconectada e `GET /api/bots/:id/connector-accounts`, só leitura), com sessão, Origin e CSRF, versão esperada e auditoria, sem a chave do Composio. O bot só recebe as duas ferramentas com ao menos uma conta liberada e ativa, e as definições trazem só os apps e as contas dele; o parâmetro `account` leva o nome da conta e é obrigatório quando o bot tem duas ou mais contas liberadas no mesmo app. A liberação é conferida no banco **a cada execução e a cada retomada após aprovação**, fora do cache de 60 s da leitura do Composio (`resolveAccount` em `packages/core/src/runs/composio-tools.ts`): revogar vale na chamada seguinte, e a conta resolvida fica gravada na chamada pendente, então a retomada recusa se ela deixou de estar liberada, mesmo com outra conta do mesmo app liberada ao bot. Conta não liberada, inexistente, desconectada ou ausente quando há mais de uma é recusada sem chamar o Composio, com a recusa entregue ao modelo como resultado da ferramenta e auditada. A conta que o Composio deixa de listar aparece como desconectada e mantém nome e liberações; só nela a tela de Conexões oferece **Remover** (com confirmação): como reconectar o app no Composio gera outro id, a conta antiga nunca voltaria. O servidor confere o estado na leitura ao vivo e recusa a conta que o Composio ainda lista (`CONNECTOR_ACCOUNT_CONFLICT`), não apaga nada se a leitura falhar, apaga a conta e as liberações numa transação e audita `connector_account.remove` com o id mascarado e o nome; se o Composio listar o mesmo id depois, ele volta como conta nova, sem nome nem liberação. Conta nova e bot novo nascem sem liberação, e excluir o bot apaga as liberações dele. No deploy, a `0050` grava o instantâneo dos bots existentes e a primeira leitura boa do Composio libera a eles a primeira conta ativa de cada app, que era a conta usada antes; com o Composio fora do ar, essa semeadura fica pendente. O rollback da `0050` apaga as três tabelas novas, com os nomes e as liberações feitos depois do deploy, e o código anterior volta à primeira conta ativa para todos.

**Chat geral sem conector (phase 13).** O Chat geral não recebe `composio_search_actions` nem `composio_execute_action`, porque não há bot dono da liberação. Uma aprovação de ação do conector que ficou pendente no Chat geral desde antes da phase 13 é recusada ao ser respondida, sem executar no Composio.

A busca é uma prévia limitada. Para parâmetros aninhados, enums e regras completas, `composio_search_actions` aceita `app`, `action` e `offset`: devolve páginas reversíveis do contrato, com `nextOffset` e `sourceHash`. O consumidor deve comparar o hash entre páginas e reiniciar a leitura se ele mudar; o servidor não mantém um snapshot do catálogo. O detalhe valida app conectado e slug e não executa a ação. Conteúdo externo continua delimitado como dado não confiável.

**Resultado limpo para o modelo (phase 11, CTX-12).** O resultado de `composio_execute_action` é gravado íntegro e devolvido assim por `read_activity`; o pedido ao modelo leva uma versão limpa, dentro da moldura de dado não confiável com marca derivada da linha gravada (estável entre etapas), e depois o teto de 12.000 caracteres. A limpeza fica em `packages/core/src/connectors/result-shaping/`, é função pura do slug da ação e do texto gravado, nunca executa o conteúdo, nunca lança erro e nunca devolve texto maior que o gravado. A camada genérica (`generic.ts`) vale para todo conector: omite base64 longo com o tamanho, converte HTML em texto, omite texto longo repetido, remove nulos e vazios, escreve listas uniformes de objetos rasos como tabela markdown e mantém as URLs intactas. O Gmail (`gmail.ts`) mantém só os cabeçalhos From, To, Cc, Subject, Date e Reply-To, descarta `payload.body.data` e blobs, tira o assunto duplicado e tem regras para `GMAIL_FETCH_EMAILS` e `GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID`; o Notion (`notion.ts`) entrega as linhas em markdown. O Google Calendar (`google-calendar.ts`, phase 12) tira o envelope de sincronização e a identidade interna de cada evento (`kind`, `etag`, `iCalUID`, `sequence`, `created`, `updated`, `nextSyncToken`, `accessRole`, `defaultReminders`), o lembrete e o tipo padrão, as marcas `self` e `optional` falsas e o criador e o organizador que já aparecem entre os participantes, e mantém o `id` do evento e todas as URLs; tem regra para `GOOGLECALENDAR_EVENTS_LIST` e regra própria para `GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS`, que agrupa os eventos por calendário. Na fixture, o resultado limpo de `EVENTS_LIST` fica 30,5% menor que o da camada genérica, e o de `EVENTS_LIST_ALL_CALENDARS`, 6,6% menor. As demais ações do Calendar e os conectores sem arquivo próprio passam só pela camada genérica, e um resultado que a regra do conector não interpreta segue pela genérica sem falhar.

Para adicionar um conector novo, sem tocar no executor nem nos outros conectores:

1. crie `packages/core/src/connectors/result-shaping/<conector>.ts` exportando um `ConnectorShaper` (`types.ts`), com o nome, os prefixos do slug das ações (por exemplo `GMAIL_`) e a função `shape`, que tira do JSON o que o modelo não usa (regra por ação é um `if` ou uma tabela por slug, como `ACTION_RULES` em `gmail.ts`);
2. registre-o na lista `SHAPERS` de `index.ts`, que escolhe o conector pelo prefixo do slug da ação;
3. acrescente a fixture anonimizada em `fixtures.ts` e o caso em `result-shaping.test.ts`, provando o texto útil presente, o tamanho menor e as URLs intactas.

- **Perguntar** pausa a execução (`waiting_approval`), devolve a posse e libera o worker: o tempo ativo não corre. O cartão aparece na
  conversa, o ícone Aprovações da barra (a aba Aprovações, no celular) mostra o número de pendências, a tela Aprovações as lista em "Aguardando você" e a execução fica parada. Responder (permitir uma vez, negar,
  sempre permitir ou negar sempre) faz o motor retomá-la **do ponto exato**, inclusive as chamadas que o modelo pediu depois da
  barrada. "Sempre permitir" e "negar sempre" gravam a regra no bot. Sem resposta em 24 h a aprovação e a execução ficam `expirada`;
  parar a execução cancela o pedido. Reiniciar `api` ou `worker` não perde nada (o estado está no banco).
- **Regras:** tela Aprovações (global, por ação: as que o bot pode chamar aparecem já ao abrir a tela, antes do primeiro uso, com a regra neutra, e as já usadas) e seção "Aprovações do bot" no editor. Valem na próxima chamada. A `api` registra o catálogo (as ações "importantes" de cada app, com cache próprio de 60 s; o bot alcança todas as ações pela busca). O adaptador pede ao Composio a versão `latest` dos apps (`toolkit_versions=latest` nas leituras e `version` na execução): sem ela a v3 usa a versão base, onde apps novos como o Notion MCP vêm sem ações ao abrir a tela; se o Composio estiver fora do ar, a tela mostra o que já está registrado.
- **Cache:** a leitura das contas conectadas fica 60 s em memória no `worker` (e na `api`, para a tela Aprovações); conectar um app novo no Composio
  pode levar até 1 minuto para o bot poder buscar nele. A liberação das contas por bot não passa por esse cache: é lida do banco a cada execução e retomada. O `worker` registra uma linha `conector Composio carregado` a cada leitura e, por execução,
  `contexto enviado ao modelo` com o tamanho do que vai ao modelo. Desconectar o Composio tira as ferramentas na chamada seguinte (a chave é conferida a cada leitura).
- **O que o cartão mostra:** a ação, o app, o nome da conta (também na linha de "Aguardando você"; a regra continua por ação e vale para todas as contas do bot) e os 6 primeiros parâmetros (valor cortado com reticências). Os demais **não somem em
  silêncio**: o cartão avisa "+N parâmetros não exibidos" e lista os nomes, porque a ação executa com todos os argumentos.
- **Ação sem confirmação:** se o Composio não responde depois de o pedido sair (queda, prazo de 60 s, 408, 5xx ou corpo ilegível), ou se
  o worker cai com a ação em andamento, o bot recebe "a ação pode ter sido concluída, confirme o efeito antes de repetir" e não
  repete às cegas (um e-mail permitido por regra sairia duas vezes). Só o limite de taxa (429) é tratado como "não executou".
- **Auditoria** (`audit_log`): `approval.respond` (desde a phase 16 com a origem, `source`: `screen` ou `notification`), `approval.rule`, `approval.expire`, `composio.action_started` (tentativa, gravada
  **antes** de a ação executar; se não grava, a ação não executa) e `composio.action` (ação, bot, execução, resultado e, desde a phase 13, a conta pelo id mascarado e pelo nome, também em `composio.action_started`; nunca
  argumentos nem resultado da ação).
- **Rollback da migration 0007:** o `rollback` do arquivo apaga regras e pedidos; antes disso, encerre manualmente as execuções em
  `waiting_approval` (`status = 'interrupted'`). A 0008 só cria índices em chaves estrangeiras; o `rollback` dela remove os índices.

### Regras globais e memória por bot (T8)

Cada bot tem uma memória de até **8.000 caracteres** (Markdown, caracteres contados como o contador da tela) e existe uma memória
**global**, lida por todos os bots (desde o T27 chamada de **Regras Globais** na tela e no prompt). As duas entram no turno de sistema fixado no início de cada trecho da execução e relido na retomada. Mudanças feitas pela ferramenta entram nas etapas seguintes pelo resultado; uma edição do dono vale na próxima montagem do sistema. Telas: `/bots/[id]/memoria` (ícone de cérebro na conversa e seção "Memória" do editor do bot) e
Configurações → Personalização.

- **Versões imutáveis:** toda gravação cria uma versão (autor: dono ou bot). Restaurar e desfazer criam uma versão **nova**, nunca
  reescrevem uma antiga. O salvamento leva a versão esperada: se a memória mudou desde que a tela a carregou (o bot também a edita),
  responde `MEMORY_CONFLICT` e a tela preserva o texto digitado. Acima do limite, `MEMORY_TOO_LARGE`. Texto igual ao atual não cria versão.
- **Bot:** a ferramenta interna `edit_memory` (`append` ou `replace`) escreve **só na memória do próprio bot**: o id vem do contexto da
  execução e o schema estrito recusa qualquer outro argumento. As Regras Globais só o dono altera. Cada edição do bot gera o cartão
  "Memória atualizada" com o diff resumido e **Desfazer**, que só vale enquanto a memória ainda está na versão que o bot gravou.
- **Retenção:** o job diário `memory.retention` (pg-boss, 03:00 de Brasília, roda uma vez ao voltar se o worker passou do horário)
  apaga versões com mais de 90 dias, **sempre mantendo as 50 mais recentes de cada memória**.
- **Auditoria:** `memory.save`, `memory.restore`, `memory.undo` (dono) e `memory.bot_edit` (bot), com a memória e a versão; nunca o texto.
- **Rollback da migration 0009:** apaga o histórico de versões e as Regras Globais (a antiga memória global; o texto atual de cada bot continua em
  `bot_memories.content`).

### Rotinas agendadas (T9)

Uma **rotina** é "este bot executa esta instrução nesta agenda". Telas: seção **Rotinas** (lista em `/rotinas` e no painel do desktop, agrupada por bot, com os filtros
Ativas, Pausadas e Concluídas), editor em `/rotinas/nova` e `/rotinas/[id]` (com a prévia das próximas 5 execuções) e o histórico em
`/rotinas/[id]/historico`. O bot também cria rotinas pela ferramenta interna `propose_routine`: desde a phase 10 a rotina nasce já ativa e
a conversa ganha um cartão (agenda legível, fuso e as próximas 5 datas) com **Recusar** e **Editar** (ver *Rotinas do bot*, abaixo).

- **Agenda:** única, a cada N minutos ou horas (mínimo 5 minutos, com janela opcional que recomeça a cada dia), diária com vários
  horários, semanal, mensal por dia (inclusive "último"), por posição (a segunda terça-feira, a última sexta-feira) ou por dia útil (primeiro
  ao vigésimo ou último), anual e cron de 5
  campos. Fuso IANA por rotina (padrão `America/Sao_Paulo`), início e fim opcionais e limite de execuções (1 a 10.000). A agenda é guardada
  como definição estruturada (`routines.schedule`); as datas vêm do `rrule-temporal` (padrões de calendário) e do `cron-parser`. Horas e datas
  da agenda são **hora de parede no fuso da rotina**. No salto do horário de verão de outro fuso, uma hora que não existe roda uma hora depois
  (RFC 5545) e a hora repetida roda uma vez só. Dia útil significa segunda a sexta, **incluindo feriados**. Mensal nos dias 29/30/31
  ajusta para o último dia dos meses curtos e mantém o dia escolhido nos seguintes. A prévia, o scheduler e as fórmulas compartilham
  o calendário civil; cron e anual mantêm seus contratos. Para uma série com `ADD_MONTHS`, use a data-base original e o deslocamento
  de cada posição, sem encadear datas já ajustadas. A função não descobre a origem de chamadas encadeadas. O vencimento em uma tabela
  é independente do horário da rotina.
- **Disparo (worker):** o agendador procura a cada 5 s as rotinas cujo `next_run_at` chegou e enfileira a execução **na fila do bot** (FIFO,
  uma ativa por bot). Cada horário previsto é tratado numa transação com índice único (rotina, horário), então **não há execução duplicada**
  com dois workers ou reinícios. O cartão "Rotina <nome> iniciada" abre a rodada na conversa e é atualizado (concluída, falhou, interrompida,
  limite atingido, expirada); a rotina grava o tipo de disparo `schedule`.
- **Execução perdida (worker parado):** atraso de **até 60 minutos** roda **uma vez** (no horário previsto mais antigo do grupo); acima
  disso a execução é registrada como `perdida` no histórico e num cartão, sem executar (as 10 mais recentes por retomada). Uma rotina nunca
  tem mais de uma execução aguardando na fila: o horário que chega com a anterior ainda na fila fica `pulada`.
- **Gerir:** editar vale a partir do próximo horário previsto (a instrução é copiada para a execução quando o horário dispara). Pausar ou
  excluir tira da fila (`cancelled`) o que ainda não começou e **não interrompe** a execução em andamento. Retomar recalcula o próximo
  horário (o tempo parado não vira "perdida"). **Executar agora** enfileira uma execução manual, com o teto de 20 aguardando do bot, sem
  consumir o limite de execuções.
- **Arquivar o bot** pausa as rotinas dele (e tira da fila o que não começou); desarquivar **não** as retoma.
- **Migration 0010 (aditiva):** `routines`, `routine_occurrences` e as colunas `runs.routine_id` e `runs.routine_name`; amplia
  `runs.status` com `cancelled`. Rollback no arquivo (apaga as rotinas e o histórico; `cancelled` volta a `interrupted`).
- **Auditoria:** `routine.create`, `.update`, `.pause`, `.resume`, `.delete` e `.run_now`, com o id da rotina e do bot; nunca a instrução.

### Tabelas e trabalho recorrente (phase 6)

Desde a phase 14 a área **Artefatos** (ver *Artefatos: tabelas e docs*) lista todas as tabelas, inclusive **Sem bot**, junto com os docs,
e abre o mesmo editor, também no painel ao lado da conversa. No desktop, a grade permite setas, Enter/F2, Escape e Tab para salvar e
avançar; no celular, a lista usa os campos da vista e abre o formulário completo. Estrutura e fórmulas usam construtores visuais; vistas
salvam filtros, ordem e projeção sem copiar registros. **Aplicar** uma consulta não salva a vista. Calculadas são somente leitura.

Somente o dono compartilha com bots, incluindo os arquivados. Bots autorizados podem consultar e editar; compartilhar não concede
acesso automaticamente às tabelas relacionadas. Relações exigem acesso aos dois lados. Revogar vale para novas chamadas e retomadas.
Excluir o criador ou o último bot associado preserva a tabela. O dono continua gerindo as tabelas sem bot. O Chat geral não usa essas ferramentas.
Excluir tabela, registros ou coluna e converter estrutura exige preparo com revisão/impacto; o dono confirma esse impacto na interface.
Quando o bot executa, o portão segue a regra global/bot existente: **Sempre permitir** pode liberar sem nova pergunta, sem confirmação
humana adicional. Dependências bloqueiam a operação sem cascata. As categorias internas **Tabelas do Aion** seguem esse mesmo fluxo; uma regra permanente
não concede acesso a uma tabela. Conflitos conservam o rascunho e exigem revisar o estado atual antes de confirmar novamente.

Limites: 100 tabelas, 50 colunas e 10.000 registros por tabela; lotes atômicos de até 100 registros e 1 MiB. Texto de célula tem até
8.000 caracteres; decimais e dinheiro trafegam como strings exatas, com moeda no tipo da coluna, e vazio é `null` (distinto de zero/falso).
Consultas paginam até 100 registros, projetam até 50 colunas, ordenam por até três campos e ID, filtram até 20 predicados/profundidade três
e devolvem no máximo **64 KiB de JSON UTF-8**, sem cortar células, com prazo total de cinco segundos. Agregações abrangem o filtro completo.
Fórmulas aceitam apenas a AST restrita do contrato (100 nós, profundidade dez, 4.000 caracteres), com erros por célula e a mesma avaliação
na prévia/consulta. API autenticada mantém Origin/CSRF; limites por sessão são 120 leituras/min, 60 mutações/min e cinco confirmações destrutivas/min.

**O que o bot lê do `table_query` (phase 11, TAB-03).** O serviço, a API e a web seguem com o JSON de sempre; só o pedido ao modelo muda. A ferramenta grava, junto do resultado, os nomes das colunas mostradas e os rótulos das opções usadas, e o modelo recebe uma tabela markdown (`packages/core/src/tables/model-format.ts`): uma linha de metadados (`totalCount`, `hasMore`, `nextCursor` e agregações), a legenda "nome = id" das colunas, o cabeçalho pelos nomes, o id curto e a versão (`v`, para `expectedVersion`) de cada registro, os rótulos no lugar dos ids das opções e os nulos vazios, com "|" e quebras de linha escapados. O id curto é o menor começo do UUID, a partir de 8 caracteres, que o torna único dentro do próprio resultado; as células de relação seguem com o UUID completo. Acima do teto de 12.000 caracteres, o corte preserva metadados e legenda. Resultado gravado antes da phase 11 não é reconvertido e só leva o teto.

As ferramentas de tabela aceitam o id curto onde recebem id de registro: `table_write` em `updates[].id` e nas células de relação de `creates[].values` e `updates[].values`, `table_query` em `recordIds` e `table_prepare_operation` em `delete_records`. O servidor valida o formato (8 a 36 caracteres hexadecimais com os hífens do UUID, ou o UUID completo), resolve depois da checagem de acesso com consulta parametrizada, só na tabela informada ou, na célula de relação, na tabela de destino da coluna, e grava sempre o id completo no vínculo e no recibo da mutação (`packages/core/src/tables/record-prefix.ts`). Prefixo de mais de um registro responde `TABLE_RECORD_AMBIGUOUS` (422) com até 10 candidatos (id completo e nome) e a contagem dos demais (`moreCandidates`); prefixo inexistente responde `TABLE_NOT_FOUND` e formato inválido, `VALIDATION_FAILED`. O contrato das rotas de tabelas não muda.

Uma rotina executa a instrução do dono com as mesmas ferramentas e permissões da conversa. **Recorrências/Lançamentos** é um exemplo
configurável: relacionar origem e ocorrência, consultar ativos e pendências e criar somente períodos ausentes com chave estável de
recorrência/período (até 200 caracteres). Repetir a chave com o conteúdo original devolve o registro existente sem sobrescrever pagamentos;
conteúdo diferente gera conflito, e uma chave removida não recria o registro. Alterar a recorrência afeta novas gerações; mudar históricos
exige pedido explícito. Sem valor obrigatório, o bot relata pendência, sem inventar valor efetivo ou pagamento. As mesmas ferramentas
operam tarefas e outros dados: não há motor financeiro, horizonte de geração ou regra universal de pagamento no núcleo.

**Migrations aditivas e rollback:** `0030_bot_tables` cria tabelas, relações, acesso, deduplicação e recibos; `0031_table_views` cria vistas;
`0032_table_operations` cria preparações e argumentos completos das chamadas. Voltar o código da aplicação mantém esse schema, os dados
e os registros de migrations aplicadas. Os SQLs de rollback nos arquivos recusam remoção com tabelas/recibos, vistas ou preparações/argumentos
existentes; a remoção de schema cabe somente no banco vazio. Não apagar registros de migrations para forçar reaplicação. Backup/restauração
e qualquer remoção de dados exigem planejamento e autorização do dono. As provas locais usam PostgreSQL descartável, API/worker reais,
provedor falso e relógio controlado, incluindo restart após commit; não constituem execução de migration ou validação na produção.

### Artefatos: tabelas e docs (phase 14)

**Artefato** é o nome de produto para as tabelas e os docs dos bots; rotas `/api/tables/*`, ferramentas `table_*`, slugs `aion_table_*` e o
banco das tabelas não mudaram. A área **Artefatos** (`/artefatos`) lista os dois tipos com tipo, título e bots, filtra por tipo e por bot
(inclusive **Sem bot**), busca pelo título e oferece **Nova tabela**, **Novo doc** e **Compartilhar** por item. Ela é aberta pelo ícone e pelo
menu da conversa do bot e por **Configurações → Atividade e arquivos** (o atalho do Início saiu na phase 18); fica fora da barra inferior do celular, onde o
"Voltar" leva ao Início. As listas antigas `/bots/:id/tabelas` e `/configuracoes/tabelas` redirecionam com 308 para ela, preservando a query
string; as páginas próprias antigas de cada tabela continuam, e a canônica passou a ser `/artefatos/tabelas/[id]` (a do doc é `/artefatos/docs/[id]`).

Quando o bot cria ou altera uma tabela ou um doc, a resposta dele ganha **uma linha por artefato** (desde a phase 18, sem moldura), com tipo, título e link. A linha vem da
referência gravada na atividade da ferramenta (`activity.artifacts`), não é cartão de sistema e por isso não gera push nem bolinha de não lido.
A linha abre o artefato num painel ao lado da conversa (parâmetro `?artefato=<tipo>:<id>` na URL, então o "Voltar" do navegador fecha o painel
e o link colado abre direto); com a conversa estreita e no celular, o painel ocupa a tela cheia e tem "Voltar" para a conversa. A tabela no
painel tem **Abrir em tela inteira**. Fechar o painel, abrir outro artefato ou ir para a tela inteira com texto não salvo pede confirmação.

**Docs.** Um doc tem título de 1 a 120 caracteres e texto em Markdown de até 100.000 caracteres; o limite é de 100 docs. O texto gravado é o
formato canônico, que o bot lê e escreve. Na tela, o dono lê o doc formatado (sem HTML interpretado, sem imagens e com links `noopener`) e edita no
editor visual (Milkdown com o conjunto GFM do chat: títulos, negrito, itálico, tachado, listas, checklist, links, citação, bloco de código,
tabela e linha divisória). Salvar sem alterar nada não chama a API, então o Markdown não muda sozinho; com alteração, o documento inteiro é
serializado de novo e pode normalizar trechos não editados (limitação registrada no backlog). **Ver Markdown** mostra e edita o texto cru, e
**Baixar .md** gera o arquivo no navegador com o texto gravado. O compartilhamento com bots é só do dono, e o doc sobrevive à exclusão do bot.

- **Versões:** toda alteração do texto, do dono ou do bot, cria uma versão imutável com autor e tamanho; restaurar cria uma versão **nova**
  com o texto da escolhida. Toda gravação leva a versão esperada: se o doc mudou (por exemplo, o bot gravou enquanto o dono editava), responde
  `DOC_CONFLICT`, nada é gravado e a tela mantém o texto digitado. O título não é versionado.
- **Bot:** as ferramentas `doc_list`, `doc_create`, `doc_read`, `doc_append`, `doc_replace`, `doc_rewrite`, `doc_versions`, `doc_restore` e
  `doc_delete` são só do bot e, desde a phase 15, chegam a ele pelo grupo `artefatos/docs` (abertas por `abrir_grupo` e chamadas por
  `use_tool`); o Chat geral não as recebe. Criar, ler, editar e restaurar não
  pedem aprovação, porque toda alteração fica no histórico; `doc_delete` segue a regra de aprovação da categoria **Docs do Aion**, e o cartão
  de aprovação e "Aguardando você" mostram o título do doc, lido no servidor. O bot sem acesso ao doc recebe a mesma resposta de um id
  inexistente (`DOC_NOT_FOUND`), inclusive na exclusão, sem aprovação gravada. `doc_read` devolve uma página que cabe no teto de 12.000
  caracteres, dentro da moldura de dado não confiável. Revogar o compartilhamento tira do pedido o que o bot já leu daquele doc.
- **API:** `GET /api/docs` e `/api/docs/:id`, `POST /api/docs`, `PATCH /api/docs/:id`, `GET /api/docs/:id/versions` e
  `/api/docs/:id/versions/:version`, `POST /api/docs/:id/restore`, `PUT /api/docs/:id/access` e `DELETE /api/docs/:id`, com sessão, Origin e
  CSRF, schemas estritos, `operationId` idempotente em toda escrita e limites por sessão de 120 leituras, 60 escritas e 5 exclusões por minuto.
  Criar e editar aceitam corpo até `DOC_BODY_LIMIT` (`packages/shared/src/docs.ts`), acima do limite global de 256 KiB, para caber um texto de
  100.000 caracteres não ASCII. Erros estáveis: `DOC_NOT_FOUND`, `DOC_ACCESS_DENIED`, `DOC_CONFLICT`, `DOC_TOO_LARGE`, `DOC_LIMIT_EXCEEDED`,
  `DOC_VERSION_NOT_FOUND`, `DOC_TEXT_NOT_FOUND` e `DOC_TEXT_AMBIGUOUS`.
- **Retenção:** o job diário `docs.retention` (pg-boss, 03:15 de Brasília, 15 minutos depois do da memória, roda uma vez ao voltar se o worker
  passou do horário) apaga versões com mais de 90 dias, **sempre mantendo as 50 mais recentes de cada doc**, a mesma regra da memória.
- **Auditoria:** `doc.create`, `doc.update`, `doc.restore`, `doc.share` e `doc.delete`, com ator, versão e tamanho; nunca o título nem o texto.
- **Migration 0051 (aditiva):** `docs`, `doc_versions`, `doc_bot_access` e `doc_mutation_receipts`; nenhuma tabela existente é alterada.
- **Rollback da 0051 (perda declarada):** o SQL do campo `rollback` apaga as quatro tabelas **mesmo com dados**: todos os docs, as versões e
  as associações com bots se perdem. Reverter é decisão do dono, que pode antes baixar cada doc com **Baixar .md**. O SQL é idempotente e roda
  de novo sem erro; subir a migration de novo recria as tabelas vazias. O agendamento da retenção **não** volta junto: a fila e o agendamento de
  `docs.retention` ficam no PostgreSQL, no schema do pg-boss, fora das tabelas do app. Com o código da phase 14 ainda no ar, o job falha a cada
  execução por falta da tabela; com o código anterior, ninguém consome a fila. Depois do rollback, remova o agendamento e a fila
  `docs.retention` pelo pg-boss (`unschedule` e `deleteQueue`) ou reaplique a migration.

### Provedores de modelos: OpenCode Go e Anthropic (phase 17)

O Aion fala com dois provedores, escolhidos pelo prefixo do id do modelo. O id gravado, aceito e mostrado é sempre `provedor/modelo` (`opencode/deepseek-v4.1-flash`, `anthropic/claude-haiku-5-5`); o provedor recebe só o id local, sem o prefixo, e o bloco `# Dados` também mostra o id local, então o pedido do DeepSeek no OpenCode Go segue idêntico em bytes ao de antes. O DeepSeek continua o padrão e o Claude é opção (MODEL-01: o prompt só foi medido no DeepSeek). Os destinos são fixos no código (`AION_ANTHROPIC_BASE_URL` só troca a base, nunca a tela).

- **Chave da Anthropic (SEC-08):** Configurações → Conexões, um cartão ao lado do OpenCode Go, cifrada como as demais e devolvida só mascarada. Ao salvar, o servidor lista `GET /v1/models` e faz **uma** chamada mínima ao `claude-haiku-5-5` pelo protocolo `messages` (16 tokens de saída); chave recusada, prova que falha ou saldo esgotado não gravam nada e a anterior fica intacta. Trocar e remover são auditados só com a máscara. Salvar divide o limite de 10 validações por minuto com as outras chaves; remover tem limite próprio de 60 por minuto.
- **Chamada ao Claude:** `x-api-key` e `anthropic-version: 2023-06-01`, sem Bearer nem `x-opencode-session`; nunca `temperature`, `top_p`, `top_k` nem `tool_choice` forçado; o effort vai em `output_config.effort`; os blocos `thinking` da resposta são descartados e nunca reenviados (a API recusa o histórico editado com eles). O cache é o do protocolo `messages` (leitura e gravação à parte no uso).
- **Catálogo:** `GET /api/models` traz, por modelo, o nome (`display_name` da Anthropic, o id local no OpenCode Go), a capacidade confirmada (`max_input_tokens` e `max_tokens` limitam a janela efetiva e a reserva de saída), o preço (`packages/core/src/models/prices.ts`, US$ por milhão de tokens; sem linha, "preço desconhecido"), se está oculto, se está indisponível por saldo e os até 5 modelos usados mais recentemente (`recents`, de `runs.last_model`). Toda rota que devolve uma entrada (listar, favoritar, ocultar, testar) usa a mesma montagem.
- **Saldo esgotado:** a recusa de cobrança (HTTP 402 `billing_error`, ou 400 com a mensagem de saldo baixo) vira `PROVIDER_CREDITS_EXHAUSTED` ("Créditos da Anthropic esgotados."): a execução (bot, rotina e Chat geral), o resumo e o teste de modelo param na primeira chamada, sem nova tentativa nem outro provedor, e o aviso `run_failed` mostra o motivo. O estado fica em `credentials.credits_exhausted_at`: os modelos `anthropic/` aparecem **Indisponíveis** no seletor (o motivo é dito uma vez no cabeçalho do grupo) até uma chamada passar, e uma chave nova o limpa. Nada impede uma execução de tentar de novo: a chamada que passar libera.
- **429 do OpenCode Go (A22):** o chat do motor espera o `Retry-After` (ou 2 s e 5 s sem ele) e repete até 2 vezes, **só antes de qualquer evento do stream**, então nada é duplicado; espera acima de 15 s não é feita. Acabadas as tentativas a execução termina como `RATE_LIMITED` em `runs.failure_code` (também no cartão da rotina). O teste de modelo, a sonda da chave, o Composio e a Parallel não repetem.
- **Curadoria (UI-05):** em Conexões, cada cartão de provedor com chave tem a seção "Modelos" (busca e um interruptor Visível ou Oculto por modelo; `PATCH /api/models/hidden`). Modelo novo do provedor nasce visível. Oculto sai das escolhas novas (seletor, favorito de reserva do bot sem modelo, "Modelo do resumo"), mas bot, rotina, conversa e resumo que já o usam seguem funcionando e mostram "oculto".
- **Seletor:** chips Todos, Anthropic e OpenCode Go (com mais de um provedor), Favoritos e Recentes com o nome completo (`anthropic/Claude Haiku 5.5`), um grupo recolhível por provedor com contador, a linha com o nome sem prefixo (inteiro, sem corte em 340 e 375 px), preço, selos Visão e Effort e o selo do teste, e uma busca que acha em todos os provedores e mostra o provedor de cada resultado. O gatilho mostra o nome completo; o nome da Anthropic vem do catálogo em memória da API, aquecido na subida (ver o `ponytail:` de `model-field.tsx`).
- **Migration 0055 e a janela de deploy:** ela prefixa `opencode/` em todo id gravado (as colunas de modelo e o JSON do cartão `model_without_tools`), sobe o limite do `CHECK` para 209 caracteres e acrescenta `model_profiles.hidden_at`, `credentials.credits_exhausted_at` e o kind `anthropic`. Como o código antigo não entende `opencode/...`, **publique `api` e `worker` juntos** (a `api` aplica a migration ao subir; um `worker` antigo rodando depois dela falharia nas execuções até ser trocado). O rollback tira o prefixo, mas **recusa antes de alterar qualquer linha** se houver `anthropic/` gravado em qualquer coluna ou a chave da Anthropic salva: troque os modelos para um do OpenCode Go e remova a chave em Conexões antes de repetir.

### Chat geral: modelo padrão obrigatório (T23)

O Chat geral só conversa com um **modelo padrão** (e effort) definido em **Configurações → Preferências**; sem ele o chat novo mostra uma faixa que leva
a essa área e o campo de mensagem fica bloqueado. Todo chat novo começa com o padrão; trocar o modelo ou o effort dentro de um chat vale só para
aquele chat. O primeiro favorito **não** vale para o Chat geral (continua valendo para bots sem modelo padrão). API: `GET` e `PUT /api/chat/settings`
(o `PUT` exige um modelo da lista do provedor e um effort que ele aceite). Ao atualizar de uma versão anterior, o padrão não vem definido: defina-o uma vez.

### Idioma e fuso horário (T28)

**Configurações → Preferências** define em que idioma os bots e o Chat geral respondem (português do Brasil, inglês ou espanhol) e o fuso
horário do dono; cada campo grava sozinho ao mudar, sem botão Salvar. "Como te chamar" fica em **Configurações → Personalização**, acima das Regras globais, e também grava ao mudar (`app_settings.owner_name`, até 40
caracteres, migration aditiva `0029_owner_name`, rollback `DROP COLUMN`), usado só na saudação do Início e fora do contexto dos bots e do Chat geral. O idioma vira a linha `Idioma:` do contexto do modelo; o fuso, o `Agora:` do mesmo contexto, o fuso padrão que o bot usa ao
propor uma rotina sem dizer o fuso e o fuso padrão do formulário de rotina nova. Cada rotina guarda o próprio fuso e **não** muda quando o
fuso do dono muda. As telas do Aion seguem em português do Brasil. API: `GET` e `PUT /api/settings` (idioma da lista e fuso que o runtime
conhece). A migration `0015_app_settings` é aditiva e já traz a linha com o padrão anterior (português do Brasil e `America/Sao_Paulo`), então
quem não mexer em nada não nota diferença. Rollback: `DROP TABLE app_settings` (nada de rotinas, bots ou mensagens é tocado).

### Rotinas do bot: criar, alterar, recusar e editar (T21 e phase 10)

O bot tem quatro ferramentas internas sobre as rotinas **dele** (nunca as de outro bot), todas só em conversa de bot: `propose_routine` (criar, da T9),
`list_routines` e `get_routine` (ver, sem efeito) e `propose_routine_change` (mudar campos, pausar, retomar ou excluir). Desde a phase 10 as rotinas são
**aceitas por padrão**: `propose_routine` cria a rotina já ativa e `propose_routine_change` valida com as regras do editor e aplica na hora, guardando no
cartão o antes e o depois (`change.before` na alteração; em pausar e retomar a própria ação indica o estado anterior). Só a exclusão grava um instantâneo
interno da rotina (`data.restore`, que fica só no servidor e nunca vai ao navegador). O cartão oferece:

- **Recusar** (`POST /api/routines/cards/:messageId/refuse`, sem corpo): desfaz pelo que o servidor gravou no cartão. Rotina nova é excluída; alteração
  volta ao estado anterior; exclusão recusada recria a rotina com o mesmo id e o histórico de execuções e de cartões (até as 5.000 mais recentes de cada). É idempotente.
- **Editar**: abre o editor em `/rotinas/<id>?cartao=<id do cartão>`, preenchido com o estado atual; salvar grava a edição e a liga ao cartão.

Recusa e edição gravam no fim da conversa os avisos `routine_refused` e `routine_edited` (este com nome, agenda, fuso e instrução finais), que o modelo
vê na rodada seguinte e que não acendem a bolinha de não lido nem a prévia. Quando um botão deixa de valer, a tela o deixa indisponível com o motivo, e o
servidor responde assim:

- Editar pelo cartão um cartão já recusado ou editado, ou uma rotina que mudou depois por outro caminho, responde `ROUTINE_CHANGED` (409).
- Recusar de novo um cartão já recusado é idempotente: responde 200, sem aviso nem efeito.
- Recusar um cartão já editado, ou uma rotina que mudou depois por outro caminho, responde `ROUTINE_CHANGED` (409) sem desfazer nada.

Cartões de proposta ou de alteração pendentes, gravados antes da phase 10, continuam com **Confirmar** (`POST /api/routines/changes/:messageId/confirm`,
que aplica o que o servidor gravou, nunca o que o navegador enviar); o de alteração aparece como "Desatualizada" quando a rotina mudou depois dele. Tudo é
auditado sem a instrução. Aceitar por padrão vale para o que o bot propõe sobre a rotina (criar, mudar, pausar, retomar e excluir), não para a execução
dela: cada execução da rotina continua passando pela regra de aprovação.

### Identidade visual: a Faísca (phase 5)

O Aion tem um único mascote, a **Faísca**, que aparece na cor de cada bot (as 12 cores pré-definidas ou uma personalizada) e no estado que o bot está
(ocioso, trabalhando, esperando aprovação, concluiu, com erro, dormindo). O dono **não escolhe mais personagem**: o campo `mascot` não existe nos
contratos de `@aion/shared` (bots, Atividades, regras de aprovação, rotinas e anexos), e a API o recusa em criar ou editar bot como campo desconhecido
(`VALIDATION_FAILED`). O componente é `apps/web/src/components/mascot/faisca.tsx`; a marca, os tokens e as telas de referência vivem em `docs/identidade/`.

- **Migration 0028 (destrutiva):** remove a coluna `bots.mascot` (criada pela 0018 com seis personagens). Só roda com
  `AION_ALLOW_DESTRUCTIVE_MIGRATIONS=true` no serviço `api`: o dono liga a variável no Easypanel **antes** do push que publica a migration e a desliga
  **depois** do deploy confirmado. Sem a variável a API recusa subir e o log diz "Migration destrutiva bloqueada (0028_drop_bot_mascot)". Nada de
  relevante se perde: a coluna guardava só a escolha de personagem, que deixou de existir.
- **Rollback manual da 0028 (procedimento do dono):** o campo `rollback` do arquivo `packages/core/src/db/migrations/0028_drop_bot_mascot.ts`
  recria a coluna como a 0018 a criou (texto obrigatório, padrão `circle`, restrita à lista antiga) e refaz o MESMO preenchimento determinístico pelo
  id dos bots existentes. O personagem que cada bot tinha antes **não** volta (a 0028 o descartou): cada bot recebe o valor calculado do id. Passos:
  (1) execute o SQL do campo `rollback` no console do PostgreSQL (é idempotente: só recria e preenche se a coluna não existe); (2) volte o código de
  `api`, `worker` e `web` para a versão anterior à phase 5 (a `api` antiga lê e grava `bots.mascot`); (3) apague o registro da migration,
  `DELETE FROM schema_migrations WHERE id = '0028_drop_bot_mascot';`, para que um deploy futuro a aplique de novo (com a variável ligada).
- **Navegação:** o app abre no **Início** (`/`, também o destino do login; um `next` válido continua valendo), centrado desde a phase 18: saudação (nome de "Como te chamar"),
  a pergunta "Como posso ajudar?", o composer do Chat geral no meio e, abaixo, a pendência mais urgente e os bots ativos; os chats recentes ficam no painel. `/bots` segue abrindo o último bot. Abaixo de 768 px a **barra inferior**
  (Início, Chats `/chats`, Rotinas, Aprovações) substitui o menu lateral e só aparece nessas quatro telas; as demais têm "Voltar" ao pai fixo da hierarquia
  (não ao histórico do navegador). Do desktop em diante a barra de ícones e o painel continuam. Os atalhos do ícone do PWA são "Novo chat" (`/chat`) e "Aprovações".
- **Configurações em 6 áreas** (`/configuracoes` é o índice): **Conexões** (OpenCode Go, Composio, Pesquisa na web e Python), **Preferências** (idioma,
  fuso e modelo do Chat geral), **Personalização** (Como te chamar e Regras globais), **Notificações**, **Atividade e arquivos** (execuções recentes,
  armazenamento e "Ver arquivos") e **Conta e segurança**. As rotas antigas (`provedores`, `conectores`, `pesquisa-na-web`, `python`, `chat-geral`,
  `idioma-e-fuso`, `regras-globais`, `atividades` e `conta`) redirecionam em definitivo para a área nova, com a query string, e os links salvos seguem
  válidos. Fonte única das áreas: `apps/web/src/components/settings/settings-areas.ts`.
- **Depois do deploy da Phase 5:** recarregue as abas abertas e reabra o PWA antes de salvar preferências. O JavaScript anterior envia
  `PUT /api/settings` sem o campo obrigatório `ownerName` e recebe 422; recarregar obtém o contrato novo. O servidor mantém a validação estrita.

### Notificações push e PWA (T10)

O Aion avisa o dono por **web push via FCM** quando uma execução **termina** (`run_completed`), **falha ou atinge o limite** (`run_failed`),
**pede aprovação** (`approval_pending`) ou **a aprovação expira** (`approval_expired`). Parar uma execução pelo próprio dono não avisa. A
mensagem que viaja pelo FCM nunca leva conteúdo da conversa: só o **nome do bot** (ou "Chat geral"), o rótulo do tipo do evento, o caminho de
abertura (`url`), a `tag`, o `kind` e o `eventId`; o toque abre a conversa do bot na mensagem do cartão (`/bots/<id>?mensagem=<id>`). Na tela: aviso
"Ativar notificações" no topo (dispensável com "Agora não", só neste navegador) e **Configurações → Notificações**, com o estado deste navegador,
a faixa de instrução quando o navegador negou a permissão, as chaves "Mostrar conteúdo", a matriz de silêncio e a lista de dispositivos com
**Remover**. Remover este navegador apaga o token no FCM e ele não se registra sozinho de novo até o dono ativar outra vez.
**Quem decide se avisa é o servidor, na hora do envio (NOTIF-01, phase 3).** A conversa aberta, visível e em foco informa presença e leitura
por sessão de login (`PUT /api/presence`, renovada a cada 20 s, vence em 45 s sem renovação); a página do app que fica visível com sessão grava a
abertura (`PUT /api/push/opened`) e fecha as notificações do Aion daquele aparelho, sem marcar conversas como lidas. O `PushDispatcher` descarta o
evento (`push_events.status = 'dropped'` com `drop_reason`) quando há presença válida na conversa em qualquer aparelho (`presence`), o evento é
anterior à última abertura do app (`opened`), a conversa já foi lida além da mensagem dele (`read`), a aprovação já não está pendente
(`resolved`), ele está silenciado (`muted`) ou tem mais de 24 h (`expired`). Desde a phase 16 os desfechos do envio que antes ficavam sem
motivo também têm código: `no_fcm_account` (o worker não tem a conta de serviço do FCM), `no_device` (nenhum dispositivo no envio),
`no_destination` (o bot ou a sessão do evento foi apagado) e `attempts_exhausted` (as 4 tentativas com falha transitória acabaram). O evento válido vai a todos os aparelhos com `eventId` e uma `tag`.
Desde a phase 16 a tag das respostas e rotinas é uma por conversa (`aion-activity-<conversa>`): o aviso novo substitui o anterior da mesma conversa
com novo alerta (`renotify`) e acrescenta ao corpo o contador das anteriores ainda não vistas ("+2 anteriores", até 99). A das aprovações é uma por
aprovação (`aion-approval-<id da aprovação>`), então duas aprovações seguidas são duas notificações, e a expirada substitui a pendente da mesma
aprovação. Na chegada, o service worker confere o evento novo e as notificações do Aion já exibidas (`GET /api/push/events/check`, até 21 ids,
prazo de 3 s), fecha as obsoletas e só mostra o que vale; sem resposta, com erro ou sem sessão, mostra o aviso genérico do FCM (falha aberta). A
regra local antiga (conversa visível e em foco neste navegador) segue como segunda camada. A página também fecha notificações neste aparelho
(`close-notifications.ts`): abrir o app fecha todas, decidir uma aprovação na tela fecha a dela e abrir e olhar uma conversa fecha as dela. No Safari/iOS, que exige uma notificação para todo push, essa regra precisaria mudar (ver os `ponytail` em
`apps/web/public/sw.js`). Dentro do app, bots e sessões do Chat geral com resposta ou cartão posterior à leitura mostram a **bolinha azul** de
não lido nas listas, na barra de ícones e, no celular, nas abas Início (bots) e Chats (sessões) da barra inferior; ler numa sessão a apaga nas outras no ciclo de releitura (até 15 s), e
silenciar não a tira. Logo depois do deploy da phase 3, toda conversa que já tem resposta ou cartão acende a bolinha até ser aberta uma
vez, porque a posição de leitura nasce vazia (Suposição 5 da spec).

**Como funciona.** O executor e o serviço de aprovações gravam o evento em `push_events` (caixa de saída) **na mesma transação** do desfecho,
então o aviso nunca se perde numa queda nem avisa de um desfecho desfeito. O `PushDispatcher` do worker lê a caixa a cada 2 s e envia a cada
dispositivo (API HTTP v1 do FCM, JWT RS256 da conta de serviço trocado por token de acesso de 1 hora). Um token que o FCM recusa
explicitamente (`UNREGISTERED`, token malformado, token de outro projeto) remove o dispositivo; falha transitória repete até 4 vezes
(a mesma `tag` evita notificação dupla) e depois desiste com aviso no log e `drop_reason = 'attempts_exhausted'`. Sem dispositivo registrado, nenhum evento é gravado. O
navegador obtém o token com o SDK do Firebase (carregado só ao ativar), por isso a **CSP libera para conexão apenas
`firebaseinstallations.googleapis.com` e `fcmregistrations.googleapis.com`**. O token do dispositivo nunca volta ao navegador.

**Funil medido (phase 16).** Duas tabelas guardam só metadados do que aconteceu com cada aviso: `push_deliveries` (uma linha por tentativa e
dispositivo, com o status HTTP do FCM e o resultado `accepted`, `rejected_token` ou `failed`; a do dispositivo removido por token recusado
fica) e `push_receipts` (o que o service worker reportou em `POST /api/push/receipts`: `received`, `shown`, `suppressed` com `invalid` ou
`owner_looking`, `clicked`, e `check_timeout` quando a conferência não respondeu em 3 s e o aviso saiu por falha aberta). O service worker
guarda o id do dispositivo na Cache API do aparelho. Nenhuma das duas leva token, título, corpo nem texto da conversa. Os eventos tratados, com as
entregas e os registros, são apagados depois de **30 dias** (antes eram 7), para a janela de medição de 7 dias não perder o descarte com
motivo na borda. O relatório está em "Relatório do funil de push".

**Conteúdo no aviso (phase 16, NOTIF-02).** O texto do que aconteceu chega ao aparelho só pela resposta autenticada da conferência
(`GET /api/push/events/check`, com o cookie da sessão e `no-store`), nunca pelo FCM: para o evento válido de uma origem com "Mostrar conteúdo"
ligado, a resposta traz também `title` (o nome do bot ou "Chat geral") e `body` em texto puro, cortados em 160 caracteres (pontos de código) na
última palavra inteira, com reticências (`packages/core/src/push/content.ts`, `PushService.checkEvents`). O corpo é o começo da resposta do bot
(a primeira linha com texto, sem Markdown) em `run_completed`; o título do cartão de falha ou de limite com o motivo seguro do código de erro em
`run_failed`; "Aprovação pendente: <ação> · <conta>" e "Aprovação expirada: <ação> · <conta>" nas aprovações; e o nome da rotina com o desfecho
numa execução de rotina. Sem conteúdo montável o corpo volta ao tipo do evento. Nada desse texto é gravado nem vai a log ou auditoria. As chaves
ficam em **Configurações → Notificações**, acima da matriz de silêncio: "Mostrar conteúdo nos avisos dos bots" (todos os bots juntos) e "Mostrar
conteúdo nos avisos do Chat geral", ligadas por padrão e salvas na hora (`GET /api/push/content` lê as duas; `PUT /api/push/content` com
`{ origin: "bots" | "general_chat", enabled }` muda uma, idempotente, com sessão, Origin e CSRF). Desligada, vale o aviso genérico (nome e tipo),
sem os botões de aprovação. O que aparece com a tela bloqueada não é decidido pelo Aion: a Notification API não tem esse controle, e no Android
o dono o ajusta no canal de notificações do app instalado (configurações de notificação do Aion no sistema).

**Aprovar e Recusar na notificação (phase 16, SEC-07).** A notificação de `approval_pending` cuja conferência devolveu o id da aprovação
(`approvalId`, só com a chave ligada e a aprovação ainda pendente) ganha os botões **Aprovar** (`allow_once`) e **Recusar** (`deny`). O toque decide
pela mesma rota da tela, `POST /api/approvals/:id/respond`, com o cookie da sessão, o token CSRF de `GET /api/auth/session` e `source: notification`;
o servidor recusa com `VALIDATION_FAILED` "sempre permitir" e "negar sempre" vindos da notificação, porque a regra permanente é só do app. Sucesso
fecha a notificação. Qualquer outro desfecho a troca por uma explicativa, de mesma tag e sem botões, que abre o cartão ao toque: já decidida
(`APPROVAL_NOT_PENDING`, ou a resposta idempotente com `alreadyApplied: true` quando a mesma decisão já estava aplicada e o toque não gravou
nada), expirada, sessão vencida, sem rede (prazo de 10 s) ou outro erro. Assim uma decisão sem efeito nunca parece sucesso.

**Silenciar por bot e por tipo (T13).** Em **Configurações → Notificações → Avisos por bot** há uma matriz com um bot por linha (os ativos,
mais o **Chat geral**) e os quatro tipos nas colunas. O toggle **ligado** recebe o aviso (o padrão, inclusive para bots novos); **desligado**
silencia. A escolha fica no servidor (`push_mutes`, só os pares silenciados) e vale para todos os dispositivos: o `PushDispatcher` a consulta
**na hora de enviar**, então silenciar também segura o que já estava na caixa de saída e ainda não saiu. Um evento silenciado termina como
descartado (`drop_reason = 'muted'`), sem chamar o FCM. Bots arquivados saem da matriz, e o que foi silenciado neles volta ao desarquivar. A alteração é auditada
(`push.mute_set`, só quando muda algo).

**Configurar o Firebase (uma vez, pelo dono):**

1. No [console do Firebase](https://console.firebase.google.com/), crie um projeto e, em **Configurações do projeto → Geral → Seus apps**,
   adicione um app **Web**. Copie `apiKey`, `projectId`, `messagingSenderId` e `appId` para o JSON de `AION_FCM_WEB_CONFIG` na `api`, ex.:
   `{"apiKey":"...","projectId":"...","messagingSenderId":"...","appId":"..."}`. No Easypanel, **converta esse JSON para base64** antes de colar
   (PowerShell: `[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('<o JSON>')) | Set-Clipboard`): o painel pode alterar as aspas do JSON, e a
   `api` então ignora a variável e deixa o push desligado.
2. Em **Configurações do projeto → Cloud Messaging → Web Push certificates**, gere o par de chaves e copie a **chave pública** para
   `AION_FCM_VAPID_KEY` na `api`.
3. Em **Configurações do projeto → Contas de serviço → Gerar nova chave privada**, baixe o JSON. Cole-o em `AION_FCM_SERVICE_ACCOUNT` no
   `worker` (em uma linha só, ou converta antes com `base64 -w0 arquivo.json`). **Não o guarde no repositório nem na `api`.**
4. Reinicie `api` e `worker`. Abra o app, **Configurações → Notificações → Ativar notificações** e permita no navegador. Repita em cada
   navegador ou celular. No iPhone o push só funciona com o app **instalado na tela inicial** (iOS 16.4 ou superior).

**PWA.** `app/manifest.ts` (nome "Aion", `display: standalone`, fundo e tema `#0E0E13`, o `--bg-app`; atalhos do ícone "Novo chat" e "Aprovações") e
`public/sw.js` (service worker que confere e mostra a notificação, abre o cartão ao toque, decide a aprovação pelos botões e reporta o funil; não guarda nada em cache) permitem instalar o app no Android e no desktop. O
manifesto, os ícones (`public/icons`) e o `sw.js` são **públicos no proxy**: o navegador os busca sem cookies e nenhum tem dado do dono. Os ícones são os da
identidade da phase 5, gerados dos SVG de `docs/identidade/assets/Icones` por `tests/support/generate-app-icons.mjs` (`node tests/support/generate-app-icons.mjs`; a
saída está commitada e o script não roda em build nem em teste): o ícone do app (192 e 512 com cantos arredondados, o mascarável com a estrela na zona segura e o
apple-touch sem cantos) é a estrela chapada da marca sobre a tinta, e o favicon (`favicon.svg` mais `favicon-32.png` e `favicon-16.png`) é a mesma estrela; a notificação push usa o
ícone grande `notification-icon.png` (a Faísca simples sobre o disco tinta, 192 px) e, como ícone pequeno (`badge`, barra de status do Android), o
`notification-badge.png`, a estrela branca sobre fundo transparente (96 x 96), porque o Android usa só o canal alfa dele e um ícone opaco aparece como quadrado
branco. O `sw.js` aponta para os dois arquivos do push.

**Ícones: o nome leva o hash do conteúdo.** Cada arquivo de `public/icons` sai como `<nome>.<hash8>.<ext>` (ex.: `icon-192.ffd0372d.png`; o hash são os 8 primeiros
caracteres do SHA-256 do arquivo). Motivo: a borda na frente do domínio (Cloudflare) guarda `/icons/*` por endereço, e o Android só atualiza o app instalado e o
convite de instalação quando o texto do manifesto muda. Com nome fixo, trocar o desenho não mudava nenhum endereço: a borda seguia servindo o ícone antigo e o
manifesto continuava idêntico. Com o hash no nome, um desenho novo é **outro endereço** (a borda nunca o viu e o manifesto muda), sem limpar cache, e o mesmo
conteúdo dá sempre o mesmo nome (rodar o gerador sem mudar um SVG não muda nada). Nome com hash, e não `?v=`, porque nem toda regra de cache da borda distingue a
query. O cache público de `/icons/*` continua em um dia (o proxy não distingue os nomes; o endereço trocar já resolve a troca de desenho).

Para trocar um ícone: ajustar o SVG em `docs/identidade/assets/Icones` e rodar, da raiz, `node tests/support/generate-app-icons.mjs` (o Chromium do Playwright já faz
parte do E2E). O gerador grava os arquivos com os nomes novos, **apaga os de nome antigo**, escreve `apps/web/src/lib/app-icons.json` (a fonte única dos
endereços, lida por `manifest.ts`, `layout.tsx` e pelos testes) e reescreve as duas constantes do push em `public/sw.js`. Commitar tudo junto. Nunca renomear nem editar
um arquivo de `public/icons` à mão: `apps/web/src/app/app-icons.test.ts` reprova se o conteúdo não bater com o hash do nome, se sobrar arquivo fora do registro ou se
manifesto, layout ou `sw.js` apontarem para um endereço que não existe. Depois do deploy, o app já instalado no Android recebe o ícone novo quando o Chrome compara o
manifesto (em geral ao abrir o app, no máximo uma vez por dia) e atualiza o WebAPK; reinstalar é o atalho. A prova no aparelho é do dono.

- **Migration 0011 (aditiva):** `push_devices` e `push_events`. Rollback no arquivo (apaga os dois; os avisos ainda não enviados se perdem).
- **Migration 0021 (aditiva):** `conversation_presence` (uma linha por sessão, apagada com a sessão ou a conversa) e
  `conversations.read_through_message_id` (só avança). Rollback no arquivo (perde só presenças e posições de leitura;
  conversas, mensagens e sessões ficam intactas).
- **Migration 0022 (aditiva):** `app_opened` (instante da última abertura, só avança) e `push_events.drop_reason`. Rollback no arquivo (perde o
  instante e os motivos; os eventos seguem `dropped`).
- **Migration 0053 (aditiva, phase 16):** `push_deliveries`, `push_receipts` e os quatro `drop_reason` novos (alarga o CHECK de `push_events`). Rollback no
  arquivo (apaga as duas tabelas, volta `no_device` e `no_destination` a `sent` e `no_fcm_account` e `attempts_exhausted` a `dropped` sem motivo antes de
  restaurar o CHECK; entregas e registros feitos depois do deploy se perdem).
- **Migration 0054 (aditiva, phase 16):** `app_settings.push_content_bots` e `app_settings.push_content_general_chat`, booleanas, NOT NULL e ligadas
  por padrão (a linha existente nasce ligada, sem preenchimento). Rollback no arquivo (remove só as duas colunas; a escolha se perde e volta ligada ao
  reaplicar).
- **Auditoria:** `push.device_register` (só o primeiro registro de cada token) e `push.device_remove`, com o id e o rótulo; nunca o token.
  `push.content_set` (phase 16), só numa mudança real, com a origem como alvo e só o booleano. A decisão pelos botões entra em `approval.respond`
  com `source: notification` (a da tela, `source: screen`).
- **Limitação:** `maxAttempts` conta por evento, não por dispositivo (phase 16): a repetição reenvia só aos dispositivos sem entrega aceita, mas um aparelho que falha sempre esgota as tentativas do evento (`ponytail:` em `dispatcher.ts`).

**Conferência em produção da phase 3 (pelo dono, depois do deploy autorizado):**

1. **Presença:** com a conversa de um bot aberta, visível e em foco no PC, peça algo ao bot e espere a resposta; nenhum aparelho recebe
   aviso. Com o app em outra tela ou em segundo plano, a resposta seguinte avisa.
2. **Abertura do app:** deixe avisos chegarem com o PC desligado, abra o app no celular (as notificações do Aion somem do celular) e só
   depois ligue o PC: os pushes antigos não aparecem nele, as conversas seguem com a bolinha azul dentro do app e um evento novo avisa normalmente.
3. **Emblema no Android:** com o PWA instalado, a barra de status e a notificação aberta mostram a estrela branca, sem quadrado branco; o aviso
   mostra a Faísca como ícone grande (no PC também). Se o Chrome mostrar o aviso genérico "site atualizado em segundo plano", siga o `ponytail` do `sw.js`.

### Chave mestra e backup (OPS-01)

`AION_MASTER_KEY` cifra o que o Aion guarda no banco (chaves do OpenCode Go e do Composio, segredo do autenticador).
As chaves do OpenCode Go e do Composio são inseridas pelo dono em Configurações → Conexões (validadas no
serviço, cifradas com AES-256-GCM e exibidas só mascaradas; a API nunca as devolve ao navegador). A chave do OpenCode Go é
validada por uma chamada de chat mínima (cerca de 1 token da assinatura a cada salvamento), porque a listagem de modelos
do provedor é pública e aceitaria qualquer texto; se nenhum modelo tentado responder de forma decisiva, a chave é aceita
sem prova (motivo do modelo, não da chave) e o aviso fica no log.
O backup do PostgreSQL é responsabilidade do dono, no VPS. **Guarde uma cópia da `AION_MASTER_KEY` fora do VPS**
(gerenciador de senhas): sem ela, um banco restaurado não consegue decifrar nada e as chaves precisam ser inseridas
de novo.

### Validar o OpenCode Go com a chave real (T5)

O provedor serve cada modelo em um de três formatos de API (`chat/completions`, `responses` ou `messages`) e a listagem
não diz qual. O Aion descobre isso no teste da primeira seleção de cada modelo (não há nada a configurar além da chave). Como os formatos foram implementados pela documentação pública e testados contra um provedor simulado, rode uma vez a
validação real, com a chave do dono, no computador de desenvolvimento (a chave vai só por variável de ambiente, não é impressa
nem gravada):

```bash
AION_VALIDATE_PROVIDER_KEY=<chave> pnpm validate:provider deepseek-v4.1-flash
AION_VALIDATE_PROVIDER_KEY=<chave> pnpm validate:provider --image deepseek-v4.1-flash
```

Antes dos modelos, a saída confere a validação da chave: `GET /models` aceita uma chave inventada (a listagem é pública), a
sonda de chat a **recusa** e aceita a chave informada. Sem `AION_VALIDATE_PROVIDER_KEY`, o script só confere a recusa da
chave inventada (não gasta a assinatura do dono). Depois, mostra, por modelo, o resultado (`ok`, `no_tools` ou `failed`), o
protocolo em que respondeu e os níveis de effort aceitos. Cada modelo faz de 3 a 9 chamadas curtas na assinatura do
dono. Use ids explícitos e sondas curtas: omitir os ids testa o catálogo inteiro e exige aprovação prévia por gastar a cota. `--image` exige ids e acrescenta uma verificação de visão. Registre o resumo na task da phase correspondente, sem chave ou conteúdo privado.

### Sondar a Anthropic com a chave real (phase 17)

`validate:anthropic` confere, contra a API real, os fatos em que o adaptador da Anthropic se apoia: `GET /v1/models` paginado com `max_input_tokens` e `max_tokens`, streaming só com `x-api-key` e `anthropic-version`, uma ferramenta de eco, o histórico reeditado **sem** `thinking` (sem 400) e a leitura de cache na segunda chamada. Por restrição do dono usa **só** o `claude-haiku-5-5` (não há opção de trocar o modelo), chamadas curtas e contadas (3 chamadas, na casa de US$ 0,005) e recusa continuar se o gasto da própria execução passar do teto; o teto da phase inteira é de US$ 3. A chave vem de `AION_VALIDATE_ANTHROPIC_KEY`, no ambiente ou em `.env.anthropic` (fora do Git, carregado pelo script), e nunca é impressa nem gravada. A saída tem só identificadores e números. O saldo esgotado não é provocado (a forma do erro vem da documentação oficial).

```bash
pnpm validate:anthropic                 # effort low (padrão)
pnpm validate:anthropic --effort high   # o modelo tende a pensar: prova o descarte do `thinking`
```

### Sondar a compactação de contexto (phase 9)

`validate:compaction` roda uma rodada longa de um bot com o motor real (PostgreSQL embarcado e migrations, como nos testes), em janela de 64k e com o `deepseek-v4.1-flash`: o bot chama 40 vezes uma ferramenta sintética de eco, sem dado real, e a rodada cruza o limiar de compactação. A saída traz só ids gerados e números: entrada, cache e saída por chamada, as chamadas de resumo, os totais e os critérios C1 e C4.

```bash
AION_VALIDATE_PROVIDER_KEY=<chave> pnpm validate:compaction
pnpm validate:compaction --mode deterministic
pnpm validate:compaction --baseline-uncached <n>
```

A chave pode ficar em `.env.validate.local` na raiz (`AION_VALIDATE_PROVIDER_KEY=<chave>`): o script carrega o arquivo quando ele existe, e o padrão `.env.*` do `.gitignore` o mantém fora do Git. Sem chave, o modo real termina com erro claro. `--mode deterministic` roda offline, com provedor roteirizado, e não demonstra consumo real. O critério C4 mede a entrada não lida do cache mais a saída, resumos incluídos (`uncachedTokens`); o total bruto, com cache, é só informativo. Para conferir C4, rode a mesma sonda numa worktree de `790481c` e passe o `uncachedTokens` dela em `--baseline-uncached`. `--calls` e `--result-chars` ajustam o volume. O modo real gasta a assinatura do dono.

Desde a phase 15 a sonda está defasada: ela publica a ferramenta de eco pela marca `core: true`, que a lista fixa do bot ignora (`botCatalogNames`), então o modo real mede um pedido sem a ferramenta que pretende exercitar. O modo determinístico continua passando. Não rode o modo real antes do ajuste registrado em `.erros-encontrados/2026-11-08-sonda-validate-compaction-core-ignorado-pelo-bot.md`.

### Sondar o cache de contexto (phase 10)

`validate:cache` confere, com o provedor real e o contexto e o cliente do motor, que a regra do bloco `# Dados` gravado por execução mantém o cache de prefixo. A conversa de um bot sintético (memória cheia de notas sintéticas, sem dado real) é roteirizada: a própria sonda chama a ferramenta de eco, então o número de chamadas e a forma dos pedidos não dependem do modelo. São 6 chamadas curtas ao `deepseek-v4.1-flash`, e cada medição compara os `cachedTokens` da etapa com o `inputTokens` do pedido anterior:

- `next_round` (primeira etapa da rodada seguinte) e `resume` (retomada da mesma execução por outra posse, com o mesmo bloco): critério C1, exigem 90% ou mais;
- `effort_change` (primeira etapa de uma rodada com effort diferente) e `effort_steady` (etapa seguinte, no mesmo effort): critério C4, só reportados.

```bash
AION_VALIDATE_PROVIDER_KEY=<chave> pnpm validate:cache
```

A chave entra só pelo ambiente; sem ela, a sonda termina com erro antes de chamar o provedor. A saída no stdout são linhas JSON só com identificadores e números; uma falha sai no stderr como envelope `{ code, message, exitCode }` (`PROVIDER_CACHE_BELOW_THRESHOLD` quando uma medição exigida fica abaixo de 90%, `PROVIDER_CACHE_VALIDATION_FAILED` nos demais casos), com código de saída 1. Cada caso é uma amostra só e o cache do provedor é de melhor esforço: se uma medição exigida ficar perto de 90%, repita a sonda antes de concluir que a regra quebrou o cache. Em 17/10/2026, C1 deu 99,4% na virada de rodada e 97,3% na retomada, e C4 deu 49,6%. O modo real gasta a assinatura do dono.

**Modo `messages` (phase 12).** `--model claude-haiku-5-5` faz a mesma montagem de pedido pelo protocolo `messages`, para confirmar se o OpenCode Go repassa o `cache_control` à Anthropic. São no máximo 3 chamadas curtas (etapa 1 da rodada 1, etapa 2 depois do eco e etapa 1 da rodada 2), e cada linha traz a entrada, a leitura e a gravação de cache. O repasse fica confirmado quando alguma chamada grava ou lê cache; não repassar não reprova, porque nesse caso o cache só não aparece e nada quebra. O `--model` é uma allowlist com só o `deepseek-v4.1-flash` (padrão) e o `claude-haiku-5-5`: qualquer outro valor, inclusive o `mimo-v2.6-pro`, é recusado antes de qualquer chamada com `PROVIDER_CACHE_INVALID_ARGUMENT`.

```bash
AION_VALIDATE_PROVIDER_KEY=<chave> pnpm validate:cache --model claude-haiku-5-5
node --env-file=.env.provider --import tsx tests/support/validate-prompt-cache.ts --model claude-haiku-5-5
```

A segunda forma lê a chave de `.env.provider` (fora do Git); `pnpm validate:cache` não carrega arquivo nenhum. Em 18/10/2026 o gateway repassou a marcação: entrada de 10.869, 10.926 e 11.043 tokens, leitura de 0, 10.865 e 10.924 e gravação de 10.865, 59 e 115 nas três chamadas. Os outros modelos do protocolo `messages` (Kimi, MiniMax e Qwen) também recebem `cache_control` e não foram sondados.

### Sondar o tempo de vida do cache (phase 11)

`validate:cache-ttl` mede por quanto tempo o cache de prompt do OpenCode Go sobrevive parado, que é o valor que decide quando a conversa fica fria (ver *Manutenção fria*). A sonda abre uma cadeia independente por intervalo (5, 15, 30 e 60 minutos), cada uma com prefixo e sessão próprios: escreve o prefixo e o relê uma única vez depois do intervalo, para um tempo de vida deslizante não contaminar a medição. Um intervalo é válido quando a releitura lê do cache pelo menos 90% da entrada da escrita. Só se o cache ainda valer em 60 minutos abrem as cadeias extras de 90 e 120 minutos. Usa só o `deepseek-v4.1-flash`, com chamadas curtas: 8 chamadas sem as extras e 12 com elas, em 60 a 180 minutos de relógio, porque as cadeias correm ao mesmo tempo.

```bash
pnpm validate:cache-ttl [--out <arquivo.md>]
```

A chave vem de `AION_VALIDATE_PROVIDER_KEY` no ambiente ou em `.env.provider` (fora do Git), carregado se existir, e nunca é impressa nem gravada. A saída no stdout são linhas JSON só com identificadores e números; a falha sai no stderr como envelope `{ code, message, exitCode }` (códigos `PROVIDER_CACHE_TTL_*`). O resultado por intervalo e o T fixado (maior intervalo válido mais 10 minutos de folga, nunca abaixo dele) são gravados em `--out`, por padrão `.vibeflow/phases/phase-11-contexto-enxuto/cache-ttl.md`; falha do provedor reprova a sonda sem gravar nada e sem fixar T. A execução de 18/10/2026 viu o cache válido até 30 minutos e morto em 60, e fixou T em 40 minutos. Mudar o T do código exige nova medição e decisão do dono. O modo real gasta a assinatura do dono.

### Banco de testes com o modelo real (phase 15)

`aion-bench` (`tests/support/aion-bench.ts`, casos em `tests/support/aion-bench-cases.ts`) roda o motor real do Aion (bots, tabelas, docs, rotinas, memória e aprovações) sobre PostgreSQL embutido, com o `deepseek-v4.1-flash` de verdade e o Composio, a web e o sandbox falsos, em casos escritos em linguagem natural, alguns com várias rodadas. O acerto é o efeito consultado no banco (memória gravada, rotina criada, registro de tabela, doc, ação do conector executada ou não), nunca a presença de texto na resposta: um caso cujo efeito não ocorreu é erro mesmo que o modelo afirme que fez. O custo de cada caso vem de `model_call_usage`, com os preços do relatório de custo. Cerca de 30% dos casos são separados (`held-out`) e só rodam no gate final; os de otimização servem à linha de base, às correções, ao A/B e ao laço do prompt. É a régua para mudar o texto do sistema ou as descrições das ferramentas: o laço do prompt da phase 15 e o gate final (397 de 400 execuções, segurança 175 de 175) foram medidos aqui.

```bash
pnpm bench --mode offline --set optimization                                       # modelo roteirizado, sem gasto (o que pnpm test aion-bench exercita)
pnpm bench --mode real --set optimization --repeats 4 --run-cap 1 --report .aion-bench/rodada.md
pnpm bench --mode real --set optimization --only memoria-simples --repeats 6 --transcripts .aion-bench/transcripts/rodada
pnpm bench --mode real --set held-out --final-gate --repeats 25 --run-cap 2 --report .aion-bench/gate.md
pnpm bench:baseline                                                                # a linha de base da phase 15; sobrescreve o baseline.md da pasta da phase
```

A chave vem de `AION_VALIDATE_PROVIDER_KEY` no ambiente ou em `.env.provider` (fora do Git), carregado se existir, e nunca é impressa nem gravada; o modo real é o padrão e falha sem ela. A saída no stdout são linhas JSON só com identificadores de caso, rótulos de verificação, códigos e números, e `--report` grava o relatório em Markdown. Os argumentos são uma allowlist: `--mode real|offline`, `--set optimization|held-out|all`, `--repeats` (1 a 400), `--concurrency` (1 a 8, padrão 3), `--only <caso,caso>`, `--run-cap`, `--report`, `--label`, `--ledger`, `--transcripts` e `--final-gate`. Os casos separados só rodam com `--final-gate`: sem ele, `--set held-out`, `--set all` ou um caso separado em `--only` é recusado com `BENCH_HELD_OUT_BEFORE_GATE`, para o laço nunca vê-los. `--transcripts <pasta>` grava, fora do Git, a conversa de cada execução reprovada (ferramentas, argumentos e o começo dos textos), para classificar a falha; o conteúdo nunca vai ao stdout nem ao relatório.

Todo gasto real entra no livro `.aion-bench/ledger.jsonl` (JSON por linha, fora do Git; `--ledger` aponta outro arquivo). Cada chamada reserva o pior caso (entrada estimada sem cache mais a saída máxima) antes de sair, e a que passaria do teto da phase não é enviada: o teto é US$ 17 (`PHASE_CAP_USD`, decisão 5 da spec da phase 15, ampliado pelo dono de US$ 15 em 2026-11-08), e o banco para, relata no evento `result` o gasto da rodada e o da phase (`budgetStopped`) e sai com código 1. `--run-cap` limita a rodada (padrão US$ 2, nunca acima do teto da phase) e reduz as repetições quando a projeção não deixa folga; o caso interrompido pelo teto sai como cortado, fora do acerto e do custo médio. Livro ilegível para tudo com `BENCH_LEDGER_CORRUPT`. O modo real gasta a assinatura do dono.

### Relatório de custo de tokens

`report:cost` lê o ledger `model_call_usage` de um banco do Aion e imprime, em Markdown, o custo em US$ dividido em entrada sem cache, cache (leitura), gravação de cache e saída, por posição da chamada (abertura de execução, após `abrir_grupo` no bot, após `discover_tools` no Chat geral, após aprovação, após compactação, continuação e resumo), por modelo, por origem (bot, Chat geral, rotina), por dia, as execuções mais caras e o tamanho da compactação (saída das chamadas de resumo, com a parte de raciocínio informada, e caracteres dos checkpoints vigentes; do checkpoint sai só o comprimento). Não chama o provedor e abre uma transação somente leitura. A coluna "Perda por falta de cache" é quanto cada grupo economizaria se toda a entrada viesse do cache. A coluna "Raciocínio" mostra a fatia da saída que o provedor informou ter gasto pensando (`model_call_usage.reasoning_tokens`, migration 0045, gravada na chamada principal e no resumo): os tokens e o percentual da saída das chamadas que informaram, ou "sem dado" quando nenhuma informou. O `chat_completions` informa em `usage.completion_tokens_details` e o `responses` em `usage.output_tokens_details`; o protocolo `messages` não informa e fica sem dado. Como o raciocínio já está dentro da saída e é cobrado com ela, os totais em US$ não mudam. As colunas "Gravação" e "Gravação US$" (phase 12) mostram a fatia da entrada que o provedor gravou no cache (`model_call_usage.cache_write_tokens`, migration 0049, só o protocolo `messages`): ela já está em "Entrada", não entra em "Cache", que é a leitura, e é cobrada pelo preço de gravação do modelo ou, quando ele não declara um, pelo preço de entrada. A entrada sem cache passa a ser a entrada menos a leitura menos a gravação, e a "Perda por falta de cache" conta também a gravação. É a medição do P0 de `docs/estudo-custo-tokens.md`.

```bash
pnpm report:cost --days 30
pnpm report:cost --days 7 --price glm-5.1=1.4,0.26,4.4
```

A URL do banco vem de `AION_REPORT_DATABASE_URL`, no ambiente ou em `.env.report.local` (fora do Git). Têm preço embutido o `deepseek-v4.1-flash`, o `mimo-v2.6-pro` e o `claude-haiku-5-5` (faixa de até 100K tokens), copiados da tabela do OpenCode Go; só o `claude-haiku-5-5` declara gravação de cache, a 0,125 US$ por milhão (1,25 vez a entrada, o multiplicador da escrita de cache de 5 minutos da documentação de prompt caching da Anthropic), e DeepSeek e MiMo, de cache automático, não cobram gravação à parte; outros modelos entram com `--price modelo=entrada,cache,saída` em US$ por milhão e, sem preço, aparecem só em tokens. O ledger some junto com a conversa (sessão vencida, bot excluído), então o relatório cobre o que ainda existe no banco.

Para ler a produção, use um usuário só de leitura com acesso apenas às colunas que o relatório consulta, e alcance o `postgres` do Easypanel por túnel SSH (ou porta exposta temporariamente):

```sql
CREATE ROLE aion_relatorio LOGIN PASSWORD '<senha forte>';
GRANT CONNECT ON DATABASE <banco> TO aion_relatorio;
GRANT USAGE ON SCHEMA public TO aion_relatorio;
GRANT SELECT ON model_call_usage TO aion_relatorio;
GRANT SELECT (id, routine_id, routine_name) ON runs TO aion_relatorio;
GRANT SELECT (id, bot_id) ON conversations TO aion_relatorio;
GRANT SELECT (run_id, decided_at) ON approvals TO aion_relatorio;
GRANT SELECT (run_id, kind, data, created_at) ON messages TO aion_relatorio;
GRANT SELECT (summary) ON conversation_context TO aion_relatorio;
```

### Relatório do funil de push

`report:push` (phase 16) lê `push_events`, `push_deliveries` e `push_receipts` de um banco do Aion e imprime, em Markdown, onde o aviso se perde. Por tipo de evento
(`run_completed`, `run_failed`, `approval_pending`, `approval_expired`) e no período: eventos criados, descartados (por `drop_reason`), enviados, pendentes e pendentes
presos (há mais de 10 minutos); entregas ao FCM por resultado (aceita, token recusado, falha) e por status HTTP; o que o aparelho registrou (eventos aceitos pelo
FCM, recebidos, exibidos, exibidos com `check_timeout`, suprimidos por motivo, tocados); os **aceitos sem recebido** (o FCM aceitou e o service worker nunca registrou,
candidato a limite do Android ou do Chrome); as latências (criação até o fim no servidor e até o primeiro recebido, mediana e p95); e uma listagem dos 200 eventos mais
recentes só com id, tipo, origem (`bot` ou `chat_geral`, sem nome), horários, estado e, por aparelho, entregas e registros, para cruzar com as anotações do dono por
hora. Não chama o FCM, abre uma transação somente leitura e a saída não tem título, texto, token, nome de bot nem rótulo de aparelho.

```bash
pnpm report:push --days 7
pnpm report:push --days 7 --tz America/Sao_Paulo
```

A URL do banco vem de `AION_REPORT_DATABASE_URL`, no ambiente ou em `.env.report.local` (fora do Git), como no `report:cost`. Para ler a produção, o papel só de leitura precisa
apenas destas colunas (alcance o `postgres` do Easypanel por túnel SSH, como no relatório de custo):

```sql
GRANT SELECT (id, kind, bot_id, status, drop_reason, attempts, created_at, finished_at) ON push_events TO aion_relatorio;
GRANT SELECT (event_id, device_id, attempt, http_status, outcome, created_at) ON push_deliveries TO aion_relatorio;
GRANT SELECT (event_id, device_id, state, reason, created_at) ON push_receipts TO aion_relatorio;
```

### Recuperar o acesso sem o autenticador

O autenticador (TOTP) é opcional e se ativa em **Configurações → Conta e segurança**. Se o celular for perdido, ou se a `AION_MASTER_KEY`
mudar (o segredo cifrado deixa de abrir e o login com código falha), o acesso se recupera pelo ambiente:

1. no serviço `api`, defina `AION_TOTP_RESET=true` e reinicie (ou faça novo deploy);
2. na inicialização a `api` apaga o segredo do autenticador e grava o evento `auth.totp_reset` na auditoria; as sessões
   existentes continuam valendo e o login volta a pedir só e-mail e senha;
3. **remova a variável** e reative o autenticador em Conta. Com a variável ainda definida, cada reinício desativa o
   autenticador de novo (e registra a auditoria de novo).

### Migrations

Rodam na inicialização da `api`, de forma serializada (um lock no banco impede duas instâncias de aplicarem a mesma).
Regras:

- são **aditivas** por padrão (criar tabela, coluna ou índice);
- cada migration carrega o próprio **plano de rollback** no arquivo (`packages/core/src/db/migrations/`), campo `rollback`,
  com o SQL que a desfaz, a ser executado manualmente se um deploy precisar voltar;
- uma migration que remove ou altera dados é marcada `destructive` e **não roda** sem `AION_ALLOW_DESTRUCTIVE_MIGRATIONS=true`;
  a API recusa a subida e informa qual migration está bloqueada. A primeira destrutiva do registro é a `0028_drop_bot_mascot` (remove `bots.mascot`; procedimento
  de deploy e de rollback em *Identidade visual: a Faísca*). Os bancos de teste ligam a variável sozinhos (helper `migrateTestDatabase`, harness da API, smoke e pilha
  do E2E); o padrão de produção continua desligado.

### Segurança operacional

- A API só é alcançável pela rede interna do Easypanel (o roteamento por caminho passa pelo proxy reverso). Por isso
  ela confia no cabeçalho `X-Forwarded-For` **apenas** quando quem conecta está numa rede privada. Se a API for
  exposta direto à internet, defina `AION_TRUSTED_PROXIES=` (vazio) para ela usar sempre o IP da conexão.
- Se houver outro proxy na frente do Traefik (ex.: Cloudflare), todos os acessos chegarão com o IP dele e o bloqueio
  por IP passa a valer para todos: ajuste `AION_TRUSTED_PROXIES` para incluir os IPs desse proxy.
- Cookies de sessão são `HttpOnly`, `Secure` (em produção) e `SameSite=Lax`. Requisições que alteram estado exigem
  `Origin` igual a `AION_PUBLIC_ORIGIN` e o token CSRF da sessão.

## Desenvolvimento local

Requisitos: Node 24 e pnpm (`corepack enable`, o Node 24 já traz o Corepack). Um PostgreSQL local para rodar os
serviços (os testes **não** precisam: sobem um PostgreSQL embarcado sozinhos).

```bash
pnpm install --frozen-lockfile
cp .env.example .env   # preencha DATABASE_URL, AION_OWNER_EMAIL, AION_OWNER_PASSWORD e AION_MASTER_KEY
```

Cada serviço em um terminal (exporte as variáveis do `.env` no shell):

```bash
pnpm --filter @aion/api dev      # http://localhost:3001
pnpm --filter @aion/worker dev   # sem ele as mensagens ficam "Na fila": é ele quem chama o modelo
pnpm --filter @aion/web dev      # http://localhost:3000 (encaminha /api para a API local)
```

O `worker` exige `DATABASE_URL` e `AION_MASTER_KEY` (os mesmos da API) e espera a API migrar o banco antes de começar.

### Comparar consumo de contexto (phase 8)

A CLI de T5 usa apenas **OpenCode Go, `deepseek-v4.1-flash`, effort `default`** na avaliação real. Não escolhe outro modelo nem busca credenciais/runtime implicitamente. O modo determinístico é offline e não demonstra economia real:

```bash
pnpm exec tsx tests/support/validate-context.ts --mode deterministic
```

Para o modo pareado, defina `AION_CONTEXT_ADAPTER_MODULE` com o caminho absoluto do adaptador operacional privado aprovado para a campanha. Ele deve exportar `executePaired` conforme `ContextAdapter` em `tests/support/context-validation.ts`, isolar bancos/destinos/portas de ambos os braços, aplicar os limites **antes** de cada despacho e fornecer ledger/snapshots exatos. Sem adaptador explícito, a CLI recusa com `CONTEXT_ADAPTER_REQUIRED`. Chaves entram pela fonte privada/ambiente do adaptador; não copie credenciais, fonte financeira ou conteúdo de prompts para o repositório ou a saída da CLI.

```bash
pnpm exec tsx tests/support/validate-context.ts --mode paired --model deepseek-v4.1-flash --effort default --window 32768
# Depois de piloto válido e fonte/prompt/estado/runtime congelados, avaliar também 65536 e 131072.
```

Este é o procedimento da campanha da phase 8, que mediu as janelas de 32k, 64k e 128k. Desde a migration 0046 (phase 11) o produto recusa a janela de 32k, então a CLI, que ainda tem essas três janelas fixas, não roda contra o runtime atual com `--window 32768`; uma campanha nova exige atualizar antes a CLI para as janelas vigentes. Na campanha original, o começo foi um par de piloto de 32k, conferindo os oráculos de dados/direção e o replay antes de multiplicar. Por execução, os limites do harness são 20 chamadas, 250.000 tokens de entrada observados, 300.000 de entrada+saída e 15 minutos, respeitando limite menor do produto. Replay tem teto de oito chamadas e 80.000 tokens de entrada. Cada preparação faz no máximo cinco chamadas de resumo, o mesmo limite do motor (`SUMMARY_MAX_CALLS`, a fonte única que o harness importa de `@aion/core`): a primeira, uma segunda chamada com lembrete quando a resposta vem fora do formato ou grande demais (só no primeiro alvo) e as três repetições com a entrada reduzida a 70%, 50% e 35%. A campanha inteira, incluindo negativos e tentativas de correção, tem teto de três milhões de tokens observados de entrada+saída. Resposta já enviada pode ultrapassar o orçamento entre verificações; registre o excesso e não despache outra chamada.

Depois do piloto válido, o aceite prevê três repetições válidas por preset, com destinos novos e resultados funcionais equivalentes em ambos os braços. Reporte cada par e agregado por janela, sem escolher a melhor tentativa ou compensar preset regressivo com outro. O baseline deve ser o runtime anterior congelado; não aplique o patch de rollback nele nem invente uma preferência de janela que ele não possui. Consumo total soma entrada+saída de todas as chamadas necessárias, incluindo resumos/repreparações; cache permanece separado. Uso ausente ou desconhecido impede comparação exata. Uma execução com dados divergentes não é sucesso barato, e baseline que não conclui a mesma tarefa demonstra diferença funcional, não economia pareada.

Pare a multiplicação ao primeiro piloto com aumento de consumo, duplicação/perda de dados/direção, orçamento excedido ou uso impossível de conferir. HTTP 429 respeita `Retry-After`; não troque o modelo nem repita mutação incerta. O ledger registra tentativas negativas e a certificação independente confere dados, revisões, relações, fórmulas/vistas e replay. Fontes/snapshots financeiros ficam privados e os destinos protegidos são comparados por leitura. A CLI imprime métricas e códigos seguros; documentação e modo offline não certificam redução de tokens reais nem autorizam publicação.

### Verificações

```bash
pnpm -r typecheck && pnpm -r lint     # tipos e lint de todos os pacotes
pnpm test                             # unitários e de integração (PostgreSQL embarcado)
pnpm test smoke                       # sobe api e worker reais (bundles de produção) e confere health e fila
pnpm --filter @aion/web test:e2e      # Playwright + axe contra a pilha de produção (1ª vez: playwright install chromium)
                                      # o spec do TOTP roda num projeto à parte, depois dos demais (o TOTP é estado global);
                                      # para rodar só ele: playwright test totp --no-deps
                                      # idem o do seletor de modelo (chave do provedor e favoritos são estado global):
                                      # playwright test model-selector --project=chromium-models --no-deps
                                      # idem o da conversa (também mexe na chave do provedor e nos favoritos):
                                      # playwright test conversation --project=chromium-conversation --no-deps
                                      # idem o das rotinas (o painel lista todas e o worker as dispara; um teste espera ~2 min o worker
                                      # disparar uma rotina única): playwright test routines --project=chromium-routines --no-deps
                                      # idem o das notificações (dispositivos de push são estado global; usa o Chromium completo no modo
                                      # sem tela, que respeita a permissão de notificações): playwright test notifications
                                      # --project=chromium-notifications --no-deps
                                      # a pilha do E2E sobe api, worker e web reais contra um provedor falso, um Composio falso e um FCM falso
pnpm --filter @aion/sandbox test:container  # exige Docker: constrói a imagem do sandbox e roda as suítes de execução, fuga e
                                      # limites e a prova worker -> sandbox real (fora do `pnpm test`, pois exige o Node 26 da imagem)
gitleaks detect --no-banner           # vazamento de segredos
pnpm audit --audit-level high         # vulnerabilidades conhecidas
```

Para usar um PostgreSQL existente nos testes, defina `AION_TEST_DATABASE_URL` com um superusuário
(ex.: `postgres://postgres:senha@localhost:5432/postgres`); cada arquivo de teste cria o próprio banco nele.

## Integração contínua

### Gate local antes de cada push

Antes de cada push, rode e confirme verdes: `pnpm -r typecheck`, `pnpm -r lint`, `pnpm test`,
`gitleaks detect --no-banner --redact --source .` e `pnpm audit --audit-level high`. O audit tem só exceções
explícitas e datadas, hoje duas (`auditConfig.ignoreGhsas` em `pnpm-workspace.yaml`, com motivo e condição de remoção); qualquer outro
advisory alto reprova. O deploy do Easypanel é automático no push da `main` e não espera o CI, então este gate local é a
única barreira antes de a mudança ir para produção.

### CI proibido

O CI está proibido por decisão do dono (2026-10-16, seção `## CI` do `AGENTS.md`): `.github/workflows/ci.yml` não roda em
push nem em pull request e também não é disparado pelo `workflow_dispatch`, nem no fim de phase, nem para conferir uma
entrega. O arquivo continua no repositório só como registro do que ele rodaria: typecheck, lint, testes com PostgreSQL 17,
gitleaks e `pnpm audit` (job `verify`), E2E com Playwright e axe (`e2e`), o build das quatro imagens Docker, `api`,
`worker`, `web` e `sandbox` (`docker`), e as suítes em container do sandbox (`sandbox`, o mesmo
`pnpm --filter @aion/sandbox test:container` do desenvolvimento local).

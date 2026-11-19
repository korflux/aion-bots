// Playwright (E2E da web). Sobe a pilha real de produção (tests/support/e2e-stack.ts) e roda contra ela.
// Chromium apenas: o aceite de T1 pede layout, teclado e axe, não compatibilidade entre navegadores.
import { defineConfig, devices } from '@playwright/test';
import { E2E_ORIGIN } from '../../tests/support/e2e-env';

// Todos os specs compartilham UM banco (a pilha sobe uma vez). O shell assume a seção Bots vazia, então os
// specs que criam bots rodam num projeto à parte, que só começa depois que o projeto principal terminou. O do seletor
// de modelo (chave do provedor, favoritos e testes são estado global) roda depois do de bots, que assume o provedor
// desconfigurado. O da conversa (chave do provedor e favoritos) roda depois dos dois. O das aprovações (chave do Composio e
// regras de aprovação, também globais) roda depois da conversa. O da memória (cria bots e grava a memória global, estado de todos os
// bots) roda depois das aprovações. O das rotinas (o painel lista todas as rotinas, e o worker dispara as agendadas) roda depois da
// memória. O das notificações (dispositivos de push são estado global; o worker real envia ao FCM falso e usa o provedor falso) roda
// depois das rotinas. O de Atividades (lista as execuções e aprovações de todos os bots, e usa o Composio e o provedor falsos) roda
// depois das notificações. O do chat geral (cria sessões e execuções que Atividades lista, usa o provedor e o Composio falsos e roda a
// retenção do chat, que apaga as sessões temporárias de todos) roda depois de Atividades. O das versões do Chat geral (cria sessões e execuções
// que Atividades lista e lê o link de uma execução fora do caminho) roda logo depois do chat geral e antes dos anexos. O do Início (phase 5, T5) lista
// TODOS os bots, pendências e sessões, zera os bots pelo controle da pilha no primeiro teste (precisa do banco sem bots) e troca o provedor, então roda
// depois de todos os demais que criam esse estado. Conexões (phase 13, CONN-02) cria bots para escolher as contas do Composio, nomeia e libera contas (estado global do conector, também lido
// pelos specs de aprovações, conversa, Atividades e Início) e troca as chaves do provedor e do conector: roda na MESMA cadeia serial dos que tocam o conector, depois do Início (que zera os
// bots) e antes do TOTP; não pode ficar no projeto paralelo, onde os specs do shell supõem a seção Bots vazia. O spec do TOTP muda o estado de login do dono e roda por último.
const BOT_STATE_SPECS = /bots\.spec\.ts$/;
const MODEL_STATE_SPECS = /model-selector\.spec\.ts$/;
const CONVERSATION_STATE_SPECS = /conversation\.spec\.ts$/;
const APPROVAL_STATE_SPECS = /approvals\.spec\.ts$/;
const MEMORY_STATE_SPECS = /memory\.spec\.ts$/;
const ROUTINE_STATE_SPECS = /routines\.spec\.ts$/;
const NOTIFICATION_STATE_SPECS = /notifications\.spec\.ts$/;
const ACTIVITY_STATE_SPECS = /activities\.spec\.ts$/;
const GENERAL_CHAT_STATE_SPECS = /general-chat\.spec\.ts$/;
const VERSION_STATE_SPECS = /versions\.spec\.ts$/;
const ATTACHMENT_STATE_SPECS = /attachments\.spec\.ts$/;
const FILE_STATE_SPECS = /files\.spec\.ts$/;
const PYTHON_STATE_SPECS = /python\.spec\.ts$/;
const CONTEXT_STATE_SPECS = /context-objectives\.spec\.ts$/;
// A rolagem única da conversa (phase 9, T13) cria bot e sessão do Chat geral e grava a chave do provedor falso: no projeto paralelo isso trocava a chave
// no meio de Configurações e do shell. Roda no mesmo worker serial da manutenção de contexto, antes do Início (que zera os bots).
const CONTEXT_MAINTENANCE_SPECS = /(context-maintenance|conversation-scroll)\.spec\.ts$/;
// Tabelas (phase 6) e Artefatos (phase 14, passo 8) dividem o projeto serial: os dois criam bots, tabelas e docs, e a lista de Artefatos mostra TODAS as tabelas e docs do banco único.
const TABLE_STATE_SPECS = /(tables|artifacts)\.spec\.ts$/;
const HOME_STATE_SPECS = /home\.spec\.ts$/;
const SETTINGS_KEYS_STATE_SPECS = /settings-keys\.spec\.ts$/;
const TOTP_STATE_SPECS = /totp\.spec\.ts$/;
const SERIAL_STATE_SPECS = /(bots|model-selector|conversation|approvals|memory|routines|notifications|activities|general-chat|versions|attachments|files|python|tables|artifacts|context-objectives|context-maintenance|conversation-scroll|home|settings-keys|totp)\.spec\.ts$/;
// Um worker por projeto de estado global: com `--repeat-each` cada repetição de um arquivo é um grupo de testes à parte (a repetição entra
// no hash do worker), e com 2 workers duas repetições rodariam ao mesmo tempo no MESMO banco (E29), brigando pelo estado que o arquivo
// supõe só dele (pendências, rotinas, bots). Sem repetição cada projeto tem um arquivo serial, ou seja, um worker: nada muda.
const ONE_AT_A_TIME = 1;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // Poucos navegadores em paralelo: cada um baixa dezenas de chunks do Next, e com muitos a máquina fica
  // disputando CPU e disco (visto: chunks levando de 3 a 5 s), o que gera falsos negativos de tempo.
  workers: 2,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  // No CI uma segunda tentativa transforma um flake isolado em "flaky" no relatório (com o trace da primeira), em vez de derrubar o job e esconder
  // os projetos seguintes da cadeia (E27). Local não repete: a falha tem de aparecer.
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  outputDir: 'test-results',
  use: {
    baseURL: E2E_ORIGIN,
    trace: 'retain-on-failure',
    // Pt-BR, como o dono usa; afeta formatação de datas e a tradução nativa de controles.
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  },
  projects: [
    { name: 'chromium', testIgnore: SERIAL_STATE_SPECS, use: { ...devices['Desktop Chrome'] } },
    { name: 'chromium-bots', testMatch: BOT_STATE_SPECS, workers: ONE_AT_A_TIME, dependencies: ['chromium'], use: { ...devices['Desktop Chrome'] } },
    {
      name: 'chromium-models',
      testMatch: MODEL_STATE_SPECS,
      workers: ONE_AT_A_TIME,
      dependencies: ['chromium', 'chromium-bots'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // A conversa muda o estado global do provedor (chave, sem chave) e dos favoritos, que o seletor de modelo também lê, então
      // roda depois dele e de bots. O worker da pilha executa os bots contra o provedor falso.
      name: 'chromium-conversation',
      testMatch: CONVERSATION_STATE_SPECS,
      workers: ONE_AT_A_TIME,
      dependencies: ['chromium', 'chromium-bots', 'chromium-models'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // As aprovações mudam a chave do Composio e as regras globais por ação, que não podem aparecer nos outros specs, e usam o
      // provedor falso e o worker como a conversa: por isso rodam depois dela.
      name: 'chromium-approvals',
      testMatch: APPROVAL_STATE_SPECS,
      workers: ONE_AT_A_TIME,
      dependencies: ['chromium', 'chromium-bots', 'chromium-models', 'chromium-conversation'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // A memória cria bots e grava a memória global (lida por todos os bots), e usa o provedor falso e o worker como a conversa:
      // por isso roda depois dela e das aprovações.
      name: 'chromium-memory',
      testMatch: MEMORY_STATE_SPECS,
      workers: ONE_AT_A_TIME,
      dependencies: ['chromium', 'chromium-bots', 'chromium-models', 'chromium-conversation', 'chromium-approvals'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // As rotinas são estado global (o painel lista todas) e o worker da pilha as dispara contra o provedor falso, como a conversa: por
      // isso rodam depois dela, das aprovações e da memória.
      name: 'chromium-routines',
      testMatch: ROUTINE_STATE_SPECS,
      workers: ONE_AT_A_TIME,
      dependencies: ['chromium', 'chromium-bots', 'chromium-models', 'chromium-conversation', 'chromium-approvals', 'chromium-memory'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Os dispositivos de push são estado global (a tela os lista) e o worker da pilha envia ao FCM falso e executa os bots contra o
      // provedor falso, como a conversa: por isso rodam depois das rotinas e de todos os que mexem no provedor.
      // `channel: 'chromium'` (o Chromium completo no modo sem tela novo, e não o "headless shell" dos demais): só ele respeita a concessão da
      // permissão de notificações, que o service worker exige para mostrar o aviso; o shell sem tela a nega sempre.
      name: 'chromium-notifications',
      testMatch: NOTIFICATION_STATE_SPECS,
      workers: ONE_AT_A_TIME,
      dependencies: ['chromium', 'chromium-bots', 'chromium-models', 'chromium-conversation', 'chromium-approvals', 'chromium-memory', 'chromium-routines'],
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
    },
    {
      // Atividades lista TODAS as execuções e aprovações pendentes (estado global) e cria bots, execuções e a rotina contra o provedor e o
      // Composio falsos, como a conversa e as aprovações: por isso roda depois de todos os que mexem nesse estado.
      name: 'chromium-activities',
      testMatch: ACTIVITY_STATE_SPECS,
      workers: ONE_AT_A_TIME,
      dependencies: ['chromium', 'chromium-bots', 'chromium-models', 'chromium-conversation', 'chromium-approvals', 'chromium-memory', 'chromium-routines', 'chromium-notifications'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // O chat geral cria sessões e execuções (Atividades lista todas), conecta o provedor e o Composio falsos como a conversa e as
      // aprovações, e o último teste roda a retenção, que apaga as sessões temporárias de todos: por isso roda depois de Atividades e
      // de todos os que mexem nesse estado, e antes do TOTP.
      name: 'chromium-general-chat',
      testMatch: GENERAL_CHAT_STATE_SPECS,
      workers: ONE_AT_A_TIME,
      dependencies: ['chromium', 'chromium-bots', 'chromium-models', 'chromium-conversation', 'chromium-approvals', 'chromium-memory', 'chromium-routines', 'chromium-notifications', 'chromium-activities'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Versões do Chat geral (phase 4, T4): sessões e execuções que Atividades lista, com o provedor que o chat geral deixou configurado.
      name: 'chromium-versions', testMatch: VERSION_STATE_SPECS, workers: ONE_AT_A_TIME,
      dependencies: ['chromium-general-chat'], use: { ...devices['Desktop Chrome'] },
    },
    {
      // Uploads e visão alteram estado global; depois das versões do chat geral e antes do TOTP.
      name: 'chromium-attachments', testMatch: ATTACHMENT_STATE_SPECS, workers: ONE_AT_A_TIME,
      dependencies: ['chromium-versions'], use: { ...devices['Desktop Chrome'] },
    },
    {
      // Gestão global dos anexos usa os arquivos e o provedor já configurados, antes da alteração de autenticação.
      name: 'chromium-files', testMatch: FILE_STATE_SPECS, workers: ONE_AT_A_TIME,
      dependencies: ['chromium-attachments'], use: { ...devices['Desktop Chrome'] },
    },
    {
      // Python (phase 4, T8): cria arquivos gerados que Arquivos lista e troca a saúde do sandbox falso da pilha (estado global de Configurações → Python),
      // então roda depois da gestão de arquivos e antes do TOTP.
      name: 'chromium-python', testMatch: PYTHON_STATE_SPECS, workers: ONE_AT_A_TIME,
      dependencies: ['chromium-files'], use: { ...devices['Desktop Chrome'] },
    },
    {
      // Tabelas e Artefatos (phase 14, passo 8) criam bots e dados persistentes (tabelas e docs) e rodam em série neste projeto, um arquivo depois do outro; sempre antes dos resets do Início e da mudança de login/TOTP.
      name: 'chromium-tables', testMatch: TABLE_STATE_SPECS, workers: ONE_AT_A_TIME,
      dependencies: ['chromium-python'], use: { ...devices['Desktop Chrome'] },
    },
    {
      // Contexto altera globais e bots, isolado antes do reset do Início.
      name: 'chromium-context', testMatch: CONTEXT_STATE_SPECS, workers: ONE_AT_A_TIME,
      dependencies: ['chromium-tables'], use: { ...devices['Desktop Chrome'] },
    },
    {
      // Manutenção compartilha provedor e configurações com contexto; execução serial antes do reset do Início.
      name: 'chromium-context-maintenance', testMatch: CONTEXT_MAINTENANCE_SPECS, workers: ONE_AT_A_TIME,
      dependencies: ['chromium-context'], use: { ...devices['Desktop Chrome'] },
    },
    {
      // O Início (phase 5, T5) lista todos os bots, pendências e sessões (estado global), zera os bots no primeiro teste e remove e devolve a chave do provedor:
      // por isso roda depois de todos os que criam esse estado e antes do TOTP, que muda o login.
      name: 'chromium-home', testMatch: HOME_STATE_SPECS, workers: ONE_AT_A_TIME,
      dependencies: ['chromium-context-maintenance'], use: { ...devices['Desktop Chrome'] },
    },
    {
      // Conexões (phase 13, CONN-02): cria bots, nomeia e libera contas do Composio e troca as chaves do provedor e do conector (estado global). Roda depois do Início, que zera os bots, e antes do
      // TOTP, que muda o login; as chaves que o spec deixa para trás não afetam o TOTP, que só faz login.
      name: 'chromium-settings-keys',
      testMatch: SETTINGS_KEYS_STATE_SPECS,
      workers: ONE_AT_A_TIME,
      dependencies: ['chromium-home'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // O TOTP é estado global (dono único): com ele ativo, o login de outro teste pediria código. Por isso o spec
      // dele roda sozinho, depois de todos os demais (inclusive os de bots e de modelos, que também fazem login), e
      // cada teste o devolve ao estado desativado.
      name: 'chromium-totp',
      testMatch: TOTP_STATE_SPECS,
      workers: ONE_AT_A_TIME,
      dependencies: ['chromium', 'chromium-bots', 'chromium-models', 'chromium-conversation', 'chromium-approvals', 'chromium-memory', 'chromium-routines', 'chromium-notifications', 'chromium-activities', 'chromium-general-chat', 'chromium-versions', 'chromium-attachments', 'chromium-files', 'chromium-python', 'chromium-home', 'chromium-settings-keys'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm exec tsx ../../tests/support/e2e-stack.ts',
    url: `${E2E_ORIGIN}/login`,
    // Nunca reusa um servidor que já esteja na porta (E4): o E2E de outro processo, ou de outra versão do código, daria um resultado que não
    // é deste commit. Com a porta ocupada o Playwright falha de forma explícita; `AION_E2E_PORT_BASE` escolhe outra faixa.
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});

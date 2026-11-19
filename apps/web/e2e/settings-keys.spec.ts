// E2E de A3 e C2 no navegador real, contra a pilha de produção (Postgres, API, Next e proxy) com OpenCode Go e
// Composio FALSOS: salvar chave inválida, salvar válida, substituir, desconectar, lista de apps, estados visuais
// (não configurado, validando, erro, configurado, Composio sem apps, modal) em 1440 e 375 px, e a garantia de que a
// chave nunca volta ao navegador. O servidor falso escolhe o cenário pelo prefixo da chave digitada
// (ver packages/core/src/testing/fake-upstreams.ts).
//
// O estado das chaves é global (dono único) e o limite é de 10 validações por minuto na API (janela deslizante, global no processo:
// `packages/core/src/credentials/rate-limit.ts`): por isso o arquivo é serial e GASTA NO MÁXIMO 10 validações reais no total, de ponta a ponta. A
// execução inteira dura pouco mais de um minuto, então um total acima de 10 reprova ou passa conforme a velocidade da máquina; o orçamento é, portanto, uma regra
// do arquivo, não uma folga de tempo. A conta (phase 13): Provedor no desktop 4 (inválida, válida, substituição inválida e substituição válida), Conectores no desktop 2
// (sem apps e com apps), Contas no desktop 1 (a chave com apps que o teste de Conectores deixou salva é reaproveitada por `ensureConnectorWithApps`; só a troca pela chave
// sem apps, que prova a conta desconectada, valida de novo), Pesquisa na web no desktop 2 (inválida e válida) e Conectores no mobile 1 (a chave com apps). Provedor e
// Pesquisa no mobile usam resposta simulada no navegador (o fluxo real de salvar é o do desktop; em 375 px só interessa a tela em cada estado). Um teste novo que
// precise de validação real tira uma de outro ou reaproveita a chave já salva (`ensureCredential` não valida de novo quando há chave). A curadoria de modelos da Anthropic (phase 17, passo 10)
// valida a chave UMA vez, logo no começo do arquivo, quando só as 4 do Provedor estão na mesma janela de 1 minuto; a janela é deslizante, então o total do arquivo (11) não passa de 10 em nenhum minuto.
//
// Phase 5, T4: Provedores, Conectores, Pesquisa na web e Python viraram UMA área, Configurações → Conexões, com os quatro cartões na mesma página. Cada teste escopa os controles
// no cartão que prova (`providerCard`, `connectorCard`, `searchKeyCard`): "Salvar", "Substituir" e o campo de chave existem em mais de um cartão ao mesmo tempo. Estados repetidos no mobile e os de limite e de rede usam resposta simulada no navegador, sem consumir o limite.
//
// Contas do Composio por bot (phase 13, CONN-02; A11, A12, A17, A25): Configurações → Conexões mostra UMA LINHA POR CONTA conectada (nome ou rótulo automático, app, estado e os bots liberados), com o
// nome editável (recusas por nome em uso e por tamanho, vazio volta ao rótulo), a escolha dos bots (versão antiga recarrega as contas) e a conta que o Composio deixou de listar, que aparece como
// DESCONECTADA com o nome e os bots mantidos e, só nela, a ação "Remover" (R8: confirmação, remoção de verdade no servidor e a recusa de uma conta que o Composio ainda lista). O estado das contas (nome e bots) é global como o das chaves, e as contas vêm do Composio falso (Gmail `ca_1` e `ca_6` ativas, GitHub `ca_2` pendente e
// `ca_3` ativa, `ca_4` pendente do Google Calendar e `ca_5` do Slack que requer atenção): cada teste de contas começa pela API, zerando nomes e liberações, e cria os bots que escolhe. O
// teste de Conectores deixa a chave com apps salva para o de Contas (que também funciona sozinho: sem essa chave, ele a salva), e é o de Contas que termina desconectando o Composio. Por criar bots e
// mexer na chave do conector, o arquivo roda no projeto serial `chromium-settings-keys` (playwright.config.ts), depois dos que dependem de a lista de bots começar vazia.
//
// Pesquisa na web (phase 1, T8, F8): Configurações → Conexões → Pesquisa na web com a Parallel FALSA. A chave opcional segue as mesmas regras das outras
// (validada, mascarada, nunca devolvida) e o interruptor salva na hora; o spec cobre os estados (carregando, anônima, com chave, desligada,
// validando, chave recusada, limite, rede e o modal de desconectar) em 1440 e 375 px, o teclado (foco visível e Espaço) e a varredura de vazamento.
import { CONNECTOR_ACCOUNT_NAME_MAX, CONNECTOR_NO_APPS_MESSAGE, connectorAccountViewSchema, connectorAccountsResponseSchema, type ConnectorAccountView, type CredentialStatus } from '@aion/shared';
import type { Locator, Page, TestInfo } from '@playwright/test';
import {
  ORIGIN,
  apiHeaders,
  apiLogin,
  attachShot,
  backLink,
  ensureCredential,
  expect,
  expectNoA11yViolations,
  expectNoHorizontalScroll,
  tabBarOf,
  test,
  uniqueBotName,
} from './support/fixtures';

test.describe.configure({ mode: 'serial' });

const PROVIDER_KEYS = {
  invalid: 'invalid-e2e-provider-0001',
  first: 'valid-e2e-provider-1111',
  replaceInvalid: 'invalid-e2e-provider-0002',
  second: 'valid-e2e-provider-2222',
};
/** Chaves da Anthropic (phase 17): o teste da tela usa respostas SIMULADAS no navegador (o orçamento de 10 validações reais do arquivo já está gasto), e o prefixo só nomeia o cenário. */
const ANTHROPIC_KEYS = { invalid: 'invalid-e2e-anthropic-0001', valid: 'valid-e2e-anthropic-7777' };
const CONNECTOR_KEYS = { noApps: 'noapps-e2e-connector-3333', withApps: 'valid-e2e-connector-4444' };
/** Chaves da Parallel falsa (o prefixo escolhe o cenário). `simulated` só aparece em respostas simuladas no navegador, nunca no servidor. */
const WEB_SEARCH_KEYS = { invalid: 'invalid-e2e-parallel-0001', valid: 'valid-e2e-parallel-5555', simulated: 'valid-e2e-parallel-7777' };
const ALL_KEYS = [...Object.values(PROVIDER_KEYS), ...Object.values(ANTHROPIC_KEYS), ...Object.values(CONNECTOR_KEYS), ...Object.values(WEB_SEARCH_KEYS)];

/**
 * Apaga as duas chaves pela API (cada teste começa do zero, e o DELETE não consome o limite de validações).
 * O cookie é enviado à mão: o cookie de sessão é `Secure` e o Playwright o omite de `cookies(url)` e do cliente de
 * API em http://127.0.0.1 (o navegador o envia normalmente, por tratar loopback como seguro).
 */
async function resetCredentials(page: Page) {
  await apiLogin(page.context());
  const cookie = (await page.context().cookies()).map((item) => `${item.name}=${item.value}`).join('; ');
  const session = await (await page.context().request.get(`${ORIGIN}/api/auth/session`, { headers: { cookie } })).json();
  for (const kind of ['provider', 'anthropic', 'connector', 'web_search']) {
    const response = await page.context().request.delete(`${ORIGIN}/api/credentials/${kind}`, {
      headers: { cookie, origin: ORIGIN, 'x-csrf-token': session.csrfToken },
    });
    expect(response.status(), `reset ${kind}`).toBe(204);
  }
}

/**
 * Devolve a pesquisa na web ao padrão pela API: chave desconectada e interruptor LIGADO. O interruptor é estado GLOBAL (um dono só) e nenhum
 * outro spec pode encontrá-lo desligado. Chame ANTES de abrir a tela (E22: `apiHeaders` faz um login novo e invalida o token CSRF de uma tela aberta).
 */
async function resetWebSearch(page: Page) {
  const headers = await apiHeaders(page);
  const removed = await page.context().request.delete(`${ORIGIN}/api/credentials/web_search`, { headers });
  expect(removed.status(), 'reset da chave da pesquisa').toBe(204);
  const on = await page.context().request.put(`${ORIGIN}/api/settings/web-search`, { headers, data: { enabled: true } });
  expect(on.status(), 'reset do interruptor da pesquisa').toBe(200);
}

/**
 * Observa a página: problemas de console e violações de CSP (sem contar o "Failed to load resource" que o
 * próprio navegador emite para as respostas 4xx/5xx esperadas nos cenários de erro) e o corpo de toda resposta
 * da API, para provar depois que nenhuma trouxe a chave.
 */
async function monitor(page: Page) {
  const problems: string[] = [];
  const bodies: Promise<string>[] = [];
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener('securitypolicyviolation', (event) =>
      (window as unknown as { __csp: string[] }).__csp.push(`${event.violatedDirective}: ${event.blockedURI}`),
    );
  });
  page.on('console', (message) => {
    const isProblem = message.type() === 'error' || message.type() === 'warning';
    if (isProblem && !message.text().includes('Failed to load resource')) problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(String(error)));
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.startsWith('/api/')) bodies.push(response.text().catch(() => ''));
  });
  return {
    problems,
    /** Nenhuma chave em resposta da API, no HTML, em localStorage/sessionStorage; nenhum problema de console ou CSP. */
    async expectClean(keys: string[]) {
      const storage = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
      const haystack = [...(await Promise.all(bodies)), await page.content(), storage].join('\n');
      for (const key of keys) expect(haystack, `chave ${key} vazou`).not.toContain(key);
      expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
      expect(problems).toEqual([]);
    },
  };
}

/** Nome do elemento focado e se o foco está visível (contorno de pelo menos 2 px). */
const focused = (page: Page) =>
  page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    const style = element ? getComputedStyle(element) : null;
    return {
      name: element?.getAttribute('aria-label') ?? element?.textContent?.trim() ?? element?.tagName ?? '',
      visible: Boolean(style && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2),
    };
  });

/** Os cartões da área Conexões que este spec prova (cada um é uma região nomeada pelo título). */
const providerCard = (page: Page) => page.getByRole('region', { name: 'Provedor de IA · OpenCode Go' });
const anthropicCard = (page: Page) => page.getByRole('region', { name: 'Provedor de IA · Anthropic' });
const connectorCard = (page: Page) => page.getByRole('region', { name: 'Ferramentas · Composio' });
const searchKeyCard = (page: Page) => page.getByRole('region', { name: 'Chave da Parallel (opcional)' });
/** O esqueleto de carregamento da pesquisa na web (os outros cartões também têm um, com outro nome). */
const searchSkeleton = (page: Page) => page.locator('[aria-busy="true"][aria-label="Carregando pesquisa na web"]');

/**
 * Contas do Composio pela API (cabeçalhos de `apiHeaders`, obtidos ANTES de abrir a tela: um login novo invalidaria o token CSRF dela, E22). A leitura é ao vivo no Composio falso e traz
 * TAMBÉM as contas que ele deixou de listar (estado `disconnected`), então vale com qualquer chave salva, inclusive a `noapps...`.
 */
async function listAccounts(page: Page, headers: Record<string, string>): Promise<ConnectorAccountView[]> {
  const response = await page.context().request.get(`${ORIGIN}/api/connector/accounts`, { headers });
  expect(response.status(), 'ler as contas do conector').toBe(200);
  return connectorAccountsResponseSchema.parse(await response.json()).accounts;
}

/** Altera nome e/ou bots de uma conta pela API, relendo a versão atual (a tela e a API disputam a versão). Devolve a conta depois da alteração. */
async function changeAccount(page: Page, headers: Record<string, string>, id: string, changes: { name?: string | null; botIds?: string[] }): Promise<ConnectorAccountView> {
  const request = page.context().request;
  let current = (await listAccounts(page, headers)).find((account) => account.id === id);
  expect(current, `conta ${id} na lista`).toBeDefined();
  if (changes.name !== undefined) {
    const renamed = await request.patch(`${ORIGIN}/api/connector/accounts/${id}`, { headers, data: { name: changes.name, expectedVersion: current!.version } });
    expect(renamed.status(), `renomear a conta ${id}`).toBe(200);
    current = connectorAccountViewSchema.parse(await renamed.json());
  }
  if (changes.botIds !== undefined) {
    const released = await request.put(`${ORIGIN}/api/connector/accounts/${id}/access`, { headers, data: { botIds: changes.botIds, expectedVersion: current!.version } });
    expect(released.status(), `liberar a conta ${id}`).toBe(200);
    current = connectorAccountViewSchema.parse(await released.json());
  }
  return current!;
}

/** Zera nome e liberações de TODAS as contas conhecidas: o ponto de partida dos testes de contas (outros specs também liberam e nomeiam contas). Precisa de uma chave do conector salva. */
async function resetAccounts(page: Page, headers: Record<string, string>): Promise<void> {
  for (const account of await listAccounts(page, headers)) {
    if (account.name === null && account.botIds.length === 0) continue;
    await changeAccount(page, headers, account.id, { name: null, botIds: [] });
  }
}

/** Cria um bot pela API (sem modelo, basta existir para ser escolhido) com o nome exclusivo da repetição (E29) e devolve id e nome. */
async function createBot(page: Page, headers: Record<string, string>, name: string): Promise<{ id: string; name: string }> {
  const unique = uniqueBotName(name);
  const response = await page.context().request.post(`${ORIGIN}/api/bots`, { headers, data: { name: unique, color: '#60A5FA', instructions: '', model: null, effort: null, stepLimit: 25 } });
  expect(response.status(), `criar o bot ${unique}`).toBe(201);
  return { id: ((await response.json()) as { id: string }).id, name: unique };
}

/** A lista de contas do cartão do Composio (a de nível mais externo: as listas de bots dentro de cada linha não trazem o nome de nenhum app). */
const accountList = (page: Page) => connectorCard(page).getByRole('list').filter({ hasText: 'Google Calendar' }).first();
/** Uma linha de conta, pelo nome acessível (o nome do dono ou o rótulo automático); `app` desempata duas contas de apps diferentes com o mesmo nome. */
const accountRow = (page: Page, label: string, app?: string) => {
  const row = accountList(page).getByRole('listitem', { name: label, exact: true });
  return app === undefined ? row : row.filter({ hasText: app });
};

/**
 * Deixa o conector com a chave que lista as contas (`CONNECTOR_KEYS.withApps`) sem gastar validação quando ela já está salva: o teste de Conectores a deixa assim, e o orçamento
 * de 10 validações reais por minuto do arquivo (ver o cabeçalho) depende dessa reutilização. Sem a chave, ou com outra que não lista as contas (a `noapps...`), a troca valida uma vez.
 * Chame ANTES de abrir a tela (E22: `ensureCredential` e `apiHeaders` fazem login novo e invalidam o token CSRF de uma tela aberta).
 */
async function ensureConnectorWithApps(page: Page): Promise<void> {
  const headers = await apiHeaders(page);
  const overview = (await (await page.context().request.get(`${ORIGIN}/api/credentials`, { headers })).json()) as { connector: { configured: boolean; masked: string | null } };
  const withApps = CONNECTOR_KEYS.withApps;
  if (overview.connector.configured && overview.connector.masked?.endsWith(withApps.slice(-4))) return;
  await ensureCredential(page, 'connector', withApps, { replace: true });
}

/**
 * Captura de tela SEM os toasts transitórios por cima: o aviso de sucesso ("Chave do Composio salva", "Nome da conta salvo", "Liberação da conta atualizada") fica 4 s no canto e, em 375 px (topo
 * da tela) ou em linhas baixas do desktop, cobre exatamente o conteúdo que a imagem deveria mostrar. Espera por condição (o nó do toast sai do DOM, com a saída animada incluída), sem pausa fixa.
 * Toasts de erro (`data-type="error"`, `duration: Infinity`) nunca saem sozinhos e fazem parte do estado que a captura documenta, então não são esperados.
 * `fullContent` captura o conteúdo inteiro (ver `attachShot`): as capturas de 375 px da lista de contas e do link do Composio passam da dobra e, na janela, mostrariam só o topo.
 */
async function attachCleanShot(page: Page, testInfo: TestInfo, name: string, options: { fullContent?: boolean } = {}): Promise<void> {
  await expect(page.locator('[data-sonner-toast]:not([data-type="error"])')).toHaveCount(0);
  await attachShot(page, testInfo, name, options);
}

/** O campo de chave de um cartão (a página inteira tem vários). */
const keyField = (scope: Locator) => scope.getByLabel('Chave de API');
const fieldError = (page: Page, text: string) => page.getByRole('alert').filter({ hasText: text });

async function submitKey(scope: Locator, key: string) {
  await keyField(scope).fill(key);
  await scope.getByRole('button', { name: 'Salvar' }).click();
}

test.describe('desktop (1440 × 900)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('A1, A2: Anthropic: o cartão vem depois do OpenCode Go, a chave recusada mostra erro seguro e a válida só aparece mascarada (respostas simuladas)', async ({ page }) => {
    await resetCredentials(page);
    const watch = await monitor(page);
    const card = anthropicCard(page);
    let posts = 0;
    await page.route('**/api/credentials/anthropic', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      posts += 1;
      return posts === 1
        ? route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ code: 'PROVIDER_KEY_INVALID', message: 'Chave recusada pelo provedor.' }) })
        : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ kind: 'anthropic', configured: true, masked: '••••7777', updatedAt: new Date().toISOString(), modelCount: 7 }) });
    });
    await page.goto('/configuracoes/conexoes');
    await expect(page.getByRole('heading', { level: 1, name: 'Conexões' })).toBeVisible();
    // Dois cartões de provedor, o OpenCode Go primeiro e a Anthropic em seguida, antes do conector.
    const headings = await page.getByRole('heading', { level: 2 }).allTextContents();
    expect(headings.slice(0, 2)).toEqual(['Provedor de IA · OpenCode Go', 'Provedor de IA · Anthropic']);
    await expect(keyField(card)).toHaveAttribute('type', 'password');
    await expect(card.getByRole('button', { name: 'Salvar' })).toBeDisabled();

    // A2: chave recusada, erro seguro (sem o valor), o campo mantém o que foi digitado e nada vira "Conectado".
    await submitKey(card, ANTHROPIC_KEYS.invalid);
    await expect(fieldError(page, 'Chave recusada pelo provedor.')).toBeVisible();
    await expect(keyField(card)).toHaveValue(ANTHROPIC_KEYS.invalid);
    await expect(card.getByText('Conectado', { exact: true })).toHaveCount(0);

    // A1: a chave válida some do campo e só a máscara e o total de modelos aparecem.
    await submitKey(card, ANTHROPIC_KEYS.valid);
    await expect(card.getByText('••••7777')).toBeVisible();
    await expect(card.getByText('7 modelos disponíveis')).toBeVisible();
    await expect(page.getByText('Chave da Anthropic salva')).toBeVisible(); // o aviso é um toast, fora do cartão
    await expect(keyField(card)).toHaveCount(0);
    expect(await page.content()).not.toContain(ANTHROPIC_KEYS.valid);
    await expectNoA11yViolations(page);

    // Desconectar descreve o efeito nos modelos Claude e deixa os do OpenCode Go como estão.
    await card.getByRole('button', { name: 'Desconectar' }).click();
    const dialog = page.getByRole('dialog', { name: 'Desconectar a Anthropic?' });
    await expect(dialog).toContainText('modelos Claude');
    await dialog.getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialog).toBeHidden();
    await watch.expectClean(ALL_KEYS);
  });

  test('A7, A8: curadoria: o cartão da Anthropic lista os modelos visíveis, busca, oculta e reexibe, e o estado persiste ao recarregar e vale no servidor', async ({ page }) => {
    await resetCredentials(page);
    const headers = await apiHeaders(page);
    // UMA validação real (a da chave da Anthropic, no começo do arquivo): o resto segue dentro do orçamento de 10 por minuto.
    const saved = await page.context().request.post(`${ORIGIN}/api/credentials/anthropic`, { headers, data: { key: ANTHROPIC_KEYS.valid } });
    expect(saved.status(), 'salvar a chave da Anthropic').toBe(200);
    const catalog = async () =>
      ((await (await page.context().request.get(`${ORIGIN}/api/models`, { headers })).json()) as { models: { id: string; hidden: boolean }[] }).models.filter((entry) => entry.id.startsWith('anthropic/'));
    const HAIKU = 'Claude Haiku 5.5';
    const toggle = (scope: Locator) => scope.getByRole('switch', { name: `Mostrar ${HAIKU} ao escolher um modelo` });
    try {
      // A8: tudo o que o provedor lista nasce visível.
      const listed = await catalog();
      expect(listed).toHaveLength(8);
      expect(listed.every((entry) => entry.hidden === false)).toBe(true);

      await page.goto('/configuracoes/conexoes');
      const card = anthropicCard(page);
      const header = card.getByRole('button', { name: /^Modelos \(8\)/ });
      await expect(header).toHaveAttribute('aria-expanded', 'false');
      await expect(card.getByRole('list', { name: 'Modelos de Anthropic' })).toHaveCount(0);
      await header.click();
      await expect(header).toHaveAttribute('aria-expanded', 'true');
      const list = card.getByRole('list', { name: 'Modelos de Anthropic' });
      await expect(list.getByRole('listitem')).toHaveCount(8);
      await expect(list.getByRole('listitem').first()).toContainText('Claude Haiku 3.5');
      await expect(list.getByRole('switch', { checked: true })).toHaveCount(8);

      // Busca pelo nome do provedor: só os três Haiku; sem resultado, a mensagem própria.
      const search = card.getByRole('searchbox', { name: 'Buscar modelo de Anthropic' });
      await search.fill('haiku');
      await expect(list.getByRole('listitem')).toHaveCount(3);
      await search.fill('nenhum-modelo-assim');
      await expect(card.getByText('Nenhum modelo encontrado')).toBeVisible();
      await search.fill('haiku');

      // Ocultar: o interruptor muda na hora, o aviso confirma e o contador do cabeçalho passa a dizer "1 oculto".
      await expect(toggle(list)).toBeChecked();
      await toggle(list).click();
      await expect(toggle(list)).not.toBeChecked();
      await expect(page.getByText(`${HAIKU} oculto`, { exact: true }).first()).toBeVisible();
      await expect(header).toContainText('1 oculto');
      await expect(list.getByRole('listitem').filter({ hasText: HAIKU })).toContainText('Oculto');
      const afterHide = await catalog();
      expect(afterHide.filter((entry) => entry.hidden).map((entry) => entry.id)).toEqual(['anthropic/claude-haiku-5-5']);
      expect(afterHide).toHaveLength(8); // oculto continua na lista do servidor: quem monta as escolhas novas é o seletor
      await expectNoA11yViolations(page);

      // Persiste ao recarregar (vem do servidor) e reexibir devolve o modelo.
      await page.reload();
      await expect(card.getByRole('button', { name: /^Modelos \(8\) · 1 oculto/ })).toBeVisible();
      await card.getByRole('button', { name: /^Modelos \(8\)/ }).click();
      await expect(toggle(card.getByRole('list', { name: 'Modelos de Anthropic' }))).not.toBeChecked();
      await toggle(card.getByRole('list', { name: 'Modelos de Anthropic' })).click();
      await expect(toggle(card.getByRole('list', { name: 'Modelos de Anthropic' }))).toBeChecked();
      expect((await catalog()).every((entry) => entry.hidden === false)).toBe(true);
    } finally {
      // O estado de "oculto" é global: nenhum outro spec pode encontrá-lo.
      for (const entry of await catalog()) {
        if (entry.hidden) await page.context().request.patch(`${ORIGIN}/api/models/hidden`, { headers, data: { model: entry.id, hidden: false } });
      }
    }
  });

  test('Provedor: chave inválida, validando, válida, substituir sem perder a anterior e desconectar', async ({ page }, testInfo) => {
    await resetCredentials(page);
    const watch = await monitor(page);
    const card = providerCard(page);
    await page.goto('/configuracoes/conexoes');
    await expect(page.getByRole('heading', { level: 1, name: 'Conexões' })).toBeVisible();
    await expect(page.getByRole('complementary').getByRole('link', { name: 'Conexões' })).toHaveAttribute('aria-current', 'page');

    // Não configurado: campo de senha e "Salvar" (desabilitado enquanto vazio).
    await expect(page.getByRole('heading', { level: 2, name: 'OpenCode Go' })).toBeVisible();
    await expect(keyField(card)).toHaveAttribute('type', 'password');
    await expect(keyField(card)).toHaveAttribute('autocomplete', 'off');
    await expect(card.getByRole('button', { name: 'Salvar' })).toBeDisabled();
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'provedores-1440-nao-configurado');

    // Chave recusada pelo provedor: erro inline, valor mantido, nada vira "Conectado".
    await submitKey(card, PROVIDER_KEYS.invalid);
    await expect(fieldError(page, 'Chave recusada pelo provedor.')).toBeVisible();
    await expect(keyField(card)).toHaveAttribute('aria-invalid', 'true');
    await expect(keyField(card)).toHaveValue(PROVIDER_KEYS.invalid);
    await expect(page.getByText('Conectado', { exact: true })).toHaveCount(0);
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'provedores-1440-erro');

    // Validando: a resposta é atrasada para o estado de carregamento ficar observável (spinner e botão bloqueado).
    await page.route('**/api/credentials/provider', async (route) => {
      if (route.request().method() === 'POST') await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.continue();
    });
    await submitKey(card, PROVIDER_KEYS.first);
    await expect(card.getByRole('button', { name: 'Salvar' })).toBeDisabled();
    await expect(card.locator('form').getByRole('status')).toHaveText('Validando a chave…');
    await expect(page.locator('form [data-icon="LoaderCircle"]')).toBeVisible();
    await attachCleanShot(page, testInfo, 'provedores-1440-validando');

    // Configurado: versão mascarada, selo, total de modelos e foco em "Substituir". A chave digitada foi apagada.
    await expect(page.getByText('Conectado', { exact: true })).toBeVisible();
    // Só agora sai a interceptação (desfazê-la com a resposta atrasada em andamento aborta a requisição).
    await page.unroute('**/api/credentials/provider');
    await expect(page.getByText('••••1111')).toBeVisible();
    await expect(page.getByText('Chave configurada, termina em 1111')).toBeAttached();
    await expect(page.getByText('14 modelos disponíveis')).toBeVisible();
    await expect(page.getByText('Chave do OpenCode Go salva')).toBeVisible();
    await expect(keyField(card)).toHaveCount(0);
    // Foco devolvido por script depois de um clique de mouse não mostra contorno (comportamento do :focus-visible);
    // o contorno visível no teclado é provado no teste de Conectores, com Tab e Shift+Tab.
    await expect(card.getByRole('button', { name: 'Substituir' })).toBeFocused();
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'provedores-1440-configurado');

    // Substituir: o campo volta vazio e focado. Uma chave recusada NÃO derruba a anterior.
    await card.getByRole('button', { name: 'Substituir' }).click();
    await expect(keyField(card)).toHaveValue('');
    await expect(keyField(card)).toBeFocused();
    await submitKey(card, PROVIDER_KEYS.replaceInvalid);
    await expect(fieldError(page, 'Chave recusada pelo provedor.')).toBeVisible();
    await card.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.getByText('••••1111')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Substituir' })).toBeFocused();

    // Substituir com chave válida: a nova assume.
    await card.getByRole('button', { name: 'Substituir' }).click();
    await submitKey(card, PROVIDER_KEYS.second);
    await expect(page.getByText('••••2222')).toBeVisible();
    await expect(page.getByText('••••1111')).toHaveCount(0);

    // Desconectar pede confirmação; cancelar devolve o foco ao botão e nada muda.
    await card.getByRole('button', { name: 'Desconectar' }).click();
    const dialog = page.getByRole('dialog', { name: 'Desconectar OpenCode Go?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Conversas e rotinas passam a mostrar "Configure um provedor".');
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'provedores-1440-modal-desconectar');
    await dialog.getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialog).toBeHidden();
    await expect(card.getByRole('button', { name: 'Desconectar' })).toBeFocused();
    await expect(page.getByText('••••2222')).toBeVisible();

    // Confirmar apaga a chave e leva o foco ao campo.
    await card.getByRole('button', { name: 'Desconectar' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Desconectar' }).click();
    await expect(page.getByText('OpenCode Go desconectado')).toBeVisible();
    await expect(keyField(card)).toBeVisible();
    await expect(keyField(card)).toBeFocused();
    await expect(page.getByText('Conectado', { exact: true })).toHaveCount(0);

    // O servidor confirma: nada configurado.
    const overview = await page.evaluate(() => fetch('/api/credentials').then((response) => response.json()));
    expect(overview.provider.configured).toBe(false);

    await watch.expectClean(ALL_KEYS);
  });

  test('Conectores: Composio sem contas, uma linha por conta e atualizar', async ({ page }, testInfo) => {
    await resetCredentials(page);
    const headers = await apiHeaders(page);
    const watch = await monitor(page);
    const card = connectorCard(page);
    await page.goto('/configuracoes/conexoes');
    await expect(page.getByRole('heading', { level: 1, name: 'Conexões' })).toBeVisible();
    await expect(page.getByRole('complementary').getByRole('link', { name: 'Conexões' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { level: 2, name: 'Composio' })).toBeVisible();
    await attachCleanShot(page, testInfo, 'conectores-1440-nao-configurado');

    // Chave válida, mas sem nenhuma conta conectada: o aviso da spec e o link externo (sem contas, é o estado vazio; com contas que o Composio já não lista, vêm como desconectadas logo abaixo).
    await submitKey(card, CONNECTOR_KEYS.noApps);
    await expect(page.getByText('••••3333')).toBeVisible();
    await expect(page.getByText(CONNECTOR_NO_APPS_MESSAGE)).toBeVisible();
    const manage = page.getByRole('link', { name: /Gerenciar apps no Composio/ });
    await expect(manage).toHaveAttribute('href', 'https://app.composio.dev');
    await expect(manage).toHaveAttribute('target', '_blank');
    await expect(manage).toHaveAttribute('rel', /noopener/);
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'conectores-1440-sem-apps');

    // Nomes e liberações que outros specs deixaram valem para a mesma conta: zerados pela API (todas as contas conhecidas vêm como desconectadas com esta chave) para os rótulos automáticos aparecerem.
    await resetAccounts(page, headers);

    // Substituir por uma chave com contas: UMA LINHA POR CONTA (A12), com o rótulo automático (app e sufixo do id), o app e o selo de estado. Os dois Gmail e os dois GitHub não se juntam.
    await card.getByRole('button', { name: 'Substituir' }).click();
    await submitKey(card, CONNECTOR_KEYS.withApps);
    await expect(page.getByText('••••4444')).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: 'Contas conectadas' })).toBeVisible();
    await expect(accountList(page).locator(':scope > li')).toHaveCount(6);
    for (const [label, app, badge] of [
      ['Github · ca_…2', 'Github', 'Pendente'],
      ['Github · ca_…3', 'Github', 'Ativa'],
      ['Gmail · ca_…1', 'Gmail', 'Ativa'],
      ['Gmail · ca_…6', 'Gmail', 'Ativa'],
      ['Google Calendar · ca_…4', 'Google Calendar', 'Pendente'],
      ['Slack · ca_…5', 'Slack', 'Requer atenção'],
    ] as const) {
      const row = accountRow(page, label);
      await expect(row).toContainText(app);
      await expect(row).toContainText(badge);
      await expect(row).toContainText('Nenhum bot pode usar esta conta.');
      await expect(row.getByRole('button', { name: 'Renomear' })).toBeVisible();
      await expect(row.getByRole('button', { name: 'Escolher bots' })).toBeVisible();
    }
    await expect(page.getByText(CONNECTOR_NO_APPS_MESSAGE)).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'conectores-1440-com-contas');

    // Atualizar (botão só com ícone, com nome acessível) recarrega a lista a partir do Composio.
    const reload = page.waitForResponse((response) => response.url().endsWith('/api/connector/accounts'));
    await page.getByRole('button', { name: 'Atualizar' }).click();
    expect((await reload).status()).toBe(200);
    await expect(accountList(page).locator(':scope > li')).toHaveCount(6);

    // Teclado: o foco passa por Substituir e Desconectar, nos dois sentidos, com contorno visível.
    await card.getByRole('button', { name: 'Substituir' }).focus();
    await page.keyboard.press('Tab');
    expect(await focused(page)).toEqual({ name: 'Desconectar', visible: true });
    await page.keyboard.press('Shift+Tab');
    expect(await focused(page)).toEqual({ name: 'Substituir', visible: true });
    await page.keyboard.press('Tab');
    await expect(card.getByRole('button', { name: 'Desconectar' })).toBeFocused();

    // A chave com apps fica salva de propósito: o teste de Contas a reaproveita (sem nova validação, ver o cabeçalho) e é ele que termina desconectando o Composio.
    await watch.expectClean(ALL_KEYS);
  });

  test('Contas: nome (aceito, em uso, longo demais, vazio), escolha dos bots, versão antiga, conta desconectada, remover a conta desconectada e desconectar o Composio', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await ensureConnectorWithApps(page); // reaproveita a chave do teste anterior; sozinho (sem ela salva), valida uma vez aqui e a troca pela chave sem apps, mais adiante, valida de novo: 2 POSTs
    const headers = await apiHeaders(page);
    await resetAccounts(page, headers);
    const first = await createBot(page, headers, 'Conta pessoal');
    const second = await createBot(page, headers, 'Conta profissional');
    const watch = await monitor(page);
    const apiName = async (id: string) => (await listAccounts(page, headers)).find((account) => account.id === id)?.name;
    await page.goto('/configuracoes/conexoes');
    await expect(page.getByRole('heading', { level: 1, name: 'Conexões' })).toBeVisible();
    await expect(accountList(page).locator(':scope > li')).toHaveCount(6);

    // Renomear pelo teclado: Enter no botão abre o editor com o foco no campo, Enter no campo grava, e o foco volta ao botão da linha, com o nome novo (A11, "nome novo").
    const gmail1 = accountRow(page, 'Gmail · ca_…1');
    await gmail1.getByRole('button', { name: 'Renomear' }).focus();
    await page.keyboard.press('Enter');
    await expect(gmail1.getByLabel('Nome da conta')).toBeFocused();
    await page.keyboard.type('Pessoal');
    await page.keyboard.press('Enter');
    const personal = accountRow(page, 'Pessoal');
    await expect(personal).toContainText('Gmail');
    await expect(personal.getByRole('button', { name: 'Renomear' })).toBeFocused();
    expect(await focused(page)).toEqual({ name: 'Renomear Pessoal', visible: true });
    expect(await apiName('ca_1')).toBe('Pessoal');

    // Nome em uso por outra conta do MESMO app: a mensagem aparece no editor, o campo fica marcado com o valor digitado e o nome anterior segue gravado (A11).
    const gmail6 = accountRow(page, 'Gmail · ca_…6');
    await gmail6.getByRole('button', { name: 'Renomear' }).click();
    const field6 = gmail6.getByLabel('Nome da conta');
    await field6.fill('Pessoal');
    await gmail6.getByRole('button', { name: 'Salvar nome' }).click();
    await expect(gmail6.getByRole('alert')).toHaveText('Já existe uma conta com esse nome neste app.');
    await expect(field6).toHaveAttribute('aria-invalid', 'true');
    await expect(field6).toHaveValue('Pessoal');
    expect(await apiName('ca_6')).toBeNull();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'contas-1440-nome-em-uso');

    // 41 caracteres: o servidor recusa (VALIDATION_FAILED) e a tela diz o que corrigir; com 40 a conta é renomeada (A11, os dois limites).
    await field6.fill('x'.repeat(CONNECTOR_ACCOUNT_NAME_MAX + 1));
    await gmail6.getByRole('button', { name: 'Salvar nome' }).click();
    await expect(gmail6.getByRole('alert')).toHaveText(`Nome inválido: use de 1 a ${CONNECTOR_ACCOUNT_NAME_MAX} caracteres, sem caracteres de controle.`);
    expect(await apiName('ca_6')).toBeNull();
    const longName = 'P'.repeat(CONNECTOR_ACCOUNT_NAME_MAX);
    await field6.fill(longName);
    await gmail6.getByRole('button', { name: 'Salvar nome' }).click();
    const long = accountRow(page, longName);
    await expect(long).toBeVisible();
    expect(await apiName('ca_6')).toBe(longName);

    // O editor abre com o nome atual; trocar por outro livre grava.
    await long.getByRole('button', { name: 'Renomear' }).click();
    await expect(long.getByLabel('Nome da conta')).toHaveValue(longName);
    await long.getByLabel('Nome da conta').fill('Profissional');
    await long.getByRole('button', { name: 'Salvar nome' }).click();
    const professional = accountRow(page, 'Profissional');
    await expect(professional).toBeVisible();

    // O mesmo nome numa conta de OUTRO app é aceito (A11), e o campo vazio volta ao rótulo automático.
    const github3 = accountRow(page, 'Github · ca_…3');
    await github3.getByRole('button', { name: 'Renomear' }).click();
    await github3.getByLabel('Nome da conta').fill('Pessoal');
    await github3.getByRole('button', { name: 'Salvar nome' }).click();
    const githubPersonal = accountRow(page, 'Pessoal', 'Github');
    await expect(githubPersonal).toBeVisible();
    await expect(accountList(page).getByRole('listitem', { name: 'Pessoal', exact: true })).toHaveCount(2);
    await githubPersonal.getByRole('button', { name: 'Renomear' }).click();
    await githubPersonal.getByLabel('Nome da conta').fill('');
    await githubPersonal.getByRole('button', { name: 'Salvar nome' }).click();
    await expect(accountRow(page, 'Github · ca_…3')).toBeVisible();
    await expect(accountList(page).getByRole('listitem', { name: 'Pessoal', exact: true })).toHaveCount(1);
    expect(await apiName('ca_3')).toBeNull();
    // Sem nome e sem mudança, "Salvar nome" fica desabilitado (nada a gravar).
    await accountRow(page, 'Github · ca_…3').getByRole('button', { name: 'Renomear' }).click();
    await expect(accountRow(page, 'Github · ca_…3').getByRole('button', { name: 'Salvar nome' })).toBeDisabled();
    await accountRow(page, 'Github · ca_…3').getByRole('button', { name: 'Cancelar' }).click();

    // Escolher os bots: a lista dos bots com caixas, salvar mostra os bots liberados na linha, e o servidor guardou a lista completa.
    await personal.getByRole('button', { name: 'Escolher bots' }).click();
    await expect(personal.getByRole('group', { name: 'Bots que podem usar esta conta' })).toBeVisible();
    await expect(personal.getByRole('button', { name: 'Salvar liberação' })).toBeDisabled();
    await personal.getByRole('checkbox', { name: first.name, exact: true }).check();
    await expect(personal.getByRole('button', { name: 'Salvar liberação' })).toBeEnabled();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'contas-1440-escolher-bots');
    await personal.getByRole('button', { name: 'Salvar liberação' }).click();
    await expect(personal.getByRole('listitem').filter({ hasText: first.name })).toBeVisible();
    await expect(personal.getByRole('button', { name: 'Escolher bots' })).toBeFocused();
    expect((await listAccounts(page, headers)).find((account) => account.id === 'ca_1')?.botIds).toEqual([first.id]);
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'contas-1440-com-bots');

    // Versão antiga: a tela de "Profissional" ficou desatualizada (a conta mudou por outro lado) e salvar recusa, sem gravar a seleção; "Recarregar contas" traz o estado do servidor.
    await professional.getByRole('button', { name: 'Escolher bots' }).click();
    await professional.getByRole('checkbox', { name: second.name, exact: true }).check();
    await changeAccount(page, headers, 'ca_6', { botIds: [first.id] });
    await professional.getByRole('button', { name: 'Salvar liberação' }).click();
    await expect(professional.getByRole('alert')).toHaveText('As contas mudaram. Recarregue antes de salvar.');
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'contas-1440-versao-antiga');
    await professional.getByRole('button', { name: 'Recarregar contas' }).click();
    await expect(professional.getByRole('listitem').filter({ hasText: first.name })).toBeVisible();
    await expect(professional.getByRole('listitem').filter({ hasText: second.name })).toHaveCount(0);
    await expect(professional.getByRole('button', { name: 'Escolher bots' })).toBeVisible();
    expect((await listAccounts(page, headers)).find((account) => account.id === 'ca_6')?.botIds).toEqual([first.id]);

    // Só a conta desconectada tem "Remover" (R8): com o Composio listando as seis (ativas, pendentes e que requer atenção), nenhuma linha oferece a ação.
    await expect(accountList(page).getByRole('button', { name: /^Remover/ })).toHaveCount(0);

    // Conta desconectada (A17): trocar a chave por uma de outra conta do Composio (que não lista estas contas) as deixa na lista como desconectadas, com o nome e os bots mantidos.
    await connectorCard(page).getByRole('button', { name: 'Substituir' }).click();
    await submitKey(connectorCard(page), CONNECTOR_KEYS.noApps); // a única validação do teste quando a chave com apps é reaproveitada
    await expect(page.getByText('••••3333')).toBeVisible();
    const gone = accountRow(page, 'Pessoal');
    await expect(gone).toContainText('Desconectada');
    await expect(gone).toContainText('O Composio não lista mais esta conta.');
    await expect(gone.getByRole('listitem').filter({ hasText: first.name })).toBeVisible();
    await expect(gone.getByRole('button', { name: 'Renomear' })).toBeVisible();
    await expect(page.getByText(CONNECTOR_NO_APPS_MESSAGE)).toBeVisible();
    const known = await listAccounts(page, headers);
    expect(known.every((account) => account.status === 'disconnected')).toBe(true);
    await expect(accountList(page).getByText('Desconectada', { exact: true })).toHaveCount(known.length);
    expect(known.find((account) => account.id === 'ca_1')).toMatchObject({ name: 'Pessoal', botIds: [first.id] });
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'contas-1440-desconectada');

    // Remover a conta desconectada (R8), de verdade no servidor: cada uma das seis agora tem "Remover"; Cancelar não apaga nada e devolve o foco ao botão; "Remover conta" apaga a conta e as
    // liberações dela, tira a linha da lista e leva o foco ao "Atualizar" (a linha que o tinha deixou de existir).
    await expect(accountList(page).getByRole('button', { name: /^Remover/ })).toHaveCount(known.length);
    await gone.getByRole('button', { name: 'Remover Pessoal' }).click();
    const removeDialog = page.getByRole('dialog', { name: 'Remover a conta “Pessoal”?' });
    await expect(removeDialog).toContainText('O nome e a liberação aos bots serão apagados do Aion.');
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'contas-1440-remover-confirmacao');
    await removeDialog.getByRole('button', { name: 'Cancelar' }).click();
    await expect(removeDialog).toHaveCount(0);
    await expect(gone.getByRole('button', { name: 'Remover Pessoal' })).toBeFocused();
    expect((await listAccounts(page, headers)).map((account) => account.id)).toContain('ca_1');

    await gone.getByRole('button', { name: 'Remover Pessoal' }).click();
    await removeDialog.getByRole('button', { name: 'Remover conta' }).click();
    await expect(page.getByText('Conta removida', { exact: true })).toBeVisible();
    await expect(gone).toHaveCount(0);
    await expect(accountList(page).locator(':scope > li')).toHaveCount(known.length - 1);
    await expect(page.getByRole('button', { name: 'Atualizar' })).toBeFocused();
    const remaining = await listAccounts(page, headers);
    expect(remaining.map((account) => account.id)).not.toContain('ca_1');
    expect(remaining).toHaveLength(known.length - 1);
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'contas-1440-removida');

    // Desconectar o Composio (era o fim do teste de Conectores): o modal avisa o efeito sobre os bots, e depois o campo volta vazio e focado, sem a lista de contas.
    await connectorCard(page).getByRole('button', { name: 'Desconectar' }).click();
    await expect(page.getByRole('dialog', { name: 'Desconectar Composio?' })).toContainText(
      'Nenhum bot recebe ferramentas do Composio a partir da próxima chamada.',
    );
    await page.getByRole('dialog').getByRole('button', { name: 'Desconectar' }).click();
    await expect(page.getByText('Composio desconectado')).toBeVisible();
    await expect(keyField(connectorCard(page))).toBeFocused();
    await expect(page.getByRole('heading', { level: 3, name: 'Contas conectadas' })).toHaveCount(0);

    await watch.expectClean(ALL_KEYS);
  });

  test('Pesquisa na web: carregando, anônima, interruptor por Espaço, chave recusada, validando, com chave, limite, rede e desconectar', async ({ page }, testInfo) => {
    await resetCredentials(page);
    await resetWebSearch(page);
    const watch = await monitor(page);
    const keyCard = searchKeyCard(page);

    // Falha ao carregar (leitura simulada com erro 500): o aviso com "Tentar novamente", sem interruptor nem campo.
    await page.route('**/api/settings/web-search', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'INTERNAL_ERROR', message: 'Erro interno. Tente novamente.' }) })
        : route.continue(),
    );
    await page.goto('/configuracoes/conexoes');
    await expect(page.getByRole('heading', { level: 1, name: 'Conexões' })).toBeVisible();
    await expect(page.getByRole('complementary').getByRole('link', { name: 'Conexões' })).toHaveAttribute('aria-current', 'page');
    await expect(fieldError(page, 'Não foi possível carregar a pesquisa na web.')).toBeVisible();
    await expect(page.getByRole('switch')).toHaveCount(0);
    await expect(keyField(keyCard)).toHaveCount(0);
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'pesquisa-1440-erro-de-carga');

    // Tentar de novo com a leitura atrasada: volta o esqueleto dos dois cartões (com aria-busy) e, por fim, a tela.
    await page.unroute('**/api/settings/web-search');
    await page.route('**/api/settings/web-search', async (route) => {
      if (route.request().method() === 'GET') await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.continue();
    });
    await page.getByRole('button', { name: 'Tentar novamente' }).click();
    await expect(searchSkeleton(page)).toBeVisible();
    await expect(page.getByRole('switch')).toHaveCount(0);
    await attachCleanShot(page, testInfo, 'pesquisa-1440-carregando');

    // Ligada e anônima (o padrão): interruptor, os dois textos de apoio, o selo "Uso anônimo" e o campo de chave vazio.
    const toggle = page.getByRole('switch', { name: 'Pesquisa na web' });
    await expect(toggle).toBeVisible();
    // Só agora sai a interceptação (desfazê-la com a resposta atrasada em andamento aborta a requisição).
    await page.unroute('**/api/settings/web-search');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('Os bots e o Chat geral podem pesquisar e ler páginas da internet.')).toBeVisible();
    await expect(page.getByText('As consultas e as URLs são enviadas à Parallel. Memória, regras e conversas não saem do Aion.')).toBeVisible();
    await expect(page.getByText('Desligada: os bots não pesquisam na web.')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 2, name: 'Chave da Parallel (opcional)' })).toBeVisible();
    await expect(page.getByText('Uso anônimo', { exact: true })).toBeVisible();
    await expect(page.getByText('Sem chave, a pesquisa usa o limite do nível anônimo da Parallel.')).toBeVisible();
    await expect(keyField(keyCard)).toHaveAttribute('type', 'password');
    await expect(keyField(keyCard)).toHaveAttribute('autocomplete', 'off');
    await expect(keyCard.getByRole('button', { name: 'Salvar' })).toBeDisabled();
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'pesquisa-1440-anonima');

    // Teclado: Tab leva do interruptor ao campo e Shift+Tab volta, sempre com contorno visível; Espaço liga e desliga, e o foco fica no interruptor.
    await toggle.focus();
    await page.keyboard.press('Tab');
    await expect(keyField(keyCard)).toBeFocused();
    expect((await focused(page)).visible).toBe(true);
    await page.keyboard.press('Shift+Tab');
    expect(await focused(page)).toEqual({ name: 'Pesquisa na web', visible: true });
    await page.keyboard.press('Space');
    await expect(page.getByText('Pesquisa na web desligada')).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(toggle).toBeFocused();
    await expect(page.getByText('Desligada: os bots não pesquisam na web.')).toBeVisible();
    // O servidor guardou a escolha (vale a partir da próxima execução) e a chave segue como estava.
    expect(await page.evaluate(() => fetch('/api/settings/web-search').then((response) => response.json()))).toMatchObject({ enabled: false, key: { configured: false } });
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'pesquisa-1440-desligada');
    await page.keyboard.press('Space');
    await expect(page.getByText('Pesquisa na web ligada')).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    // Chave recusada pela Parallel (1º POST real): erro inline, valor mantido, nada vira "Conectada".
    await submitKey(keyCard, WEB_SEARCH_KEYS.invalid);
    await expect(fieldError(page, 'Chave recusada pela Parallel.')).toBeVisible();
    await expect(keyField(keyCard)).toHaveAttribute('aria-invalid', 'true');
    await expect(keyField(keyCard)).toHaveValue(WEB_SEARCH_KEYS.invalid);
    await expect(page.getByText('Conectada', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Uso anônimo', { exact: true })).toBeVisible();
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'pesquisa-1440-chave-recusada');

    // Validando (resposta atrasada): botão bloqueado, "Validando a chave…" e o spinner.
    await page.route('**/api/credentials/web_search', async (route) => {
      if (route.request().method() === 'POST') await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.continue();
    });
    await submitKey(keyCard, WEB_SEARCH_KEYS.valid); // 2º POST real
    await expect(keyCard.getByRole('button', { name: 'Salvar' })).toBeDisabled();
    await expect(keyCard.locator('form').getByRole('status')).toHaveText('Validando a chave…');
    await expect(page.locator('form [data-icon="LoaderCircle"]')).toBeVisible();
    await attachCleanShot(page, testInfo, 'pesquisa-1440-validando');

    // Com chave: selo "Conectada", a versão mascarada em mono e o foco em "Substituir"; o campo e a chave digitada somem da tela.
    await expect(page.getByText('Conectada', { exact: true })).toBeVisible();
    await page.unroute('**/api/credentials/web_search');
    await expect(page.getByText('••••5555')).toBeVisible();
    await expect(page.getByText('Chave configurada, termina em 5555')).toBeAttached();
    await expect(page.getByText('Chave da Parallel salva')).toBeVisible();
    await expect(page.getByText('Uso anônimo', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Conectado', { exact: true })).toHaveCount(0); // o selo é um só, o do cartão ("Conectada")
    await expect(keyField(keyCard)).toHaveCount(0);
    await expect(keyCard.getByRole('button', { name: 'Substituir' })).toBeFocused();
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'pesquisa-1440-com-chave');

    // A escolha vem do servidor: depois de recarregar a chave segue conectada e o interruptor ligado. Desligado, o cartão da chave segue editável.
    await page.reload();
    await expect(page.getByText('••••5555')).toBeVisible();
    await expect(page.getByText('Conectada', { exact: true })).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(page.getByText('Desligada: os bots não pesquisam na web.')).toBeVisible();
    await expect(keyCard.getByRole('button', { name: 'Substituir' })).toBeEnabled();
    await expect(keyCard.getByRole('button', { name: 'Desconectar' })).toBeEnabled();
    await expect(page.getByText('Pesquisa na web desligada')).toBeVisible(); // a gravação terminou
    await expectNoA11yViolations(page); // também espera a transição do interruptor acabar antes da captura
    await attachCleanShot(page, testInfo, 'pesquisa-1440-desligada-com-chave');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    // Limite de validações e falha ao validar (respostas simuladas, sem consumir o limite): a mensagem aparece no campo e a chave anterior segue valendo.
    await keyCard.getByRole('button', { name: 'Substituir' }).click();
    await expect(keyField(keyCard)).toBeFocused();
    let simulated = { status: 429, body: { code: 'RATE_LIMITED', message: 'Muitas solicitações. Aguarde um instante e tente novamente.' } };
    await page.route('**/api/credentials/web_search', (route) =>
      route.request().method() === 'POST' ? route.fulfill({ status: simulated.status, contentType: 'application/json', body: JSON.stringify(simulated.body) }) : route.continue(),
    );
    await submitKey(keyCard, WEB_SEARCH_KEYS.simulated);
    await expect(fieldError(page, 'Muitas solicitações. Aguarde um instante e tente novamente.')).toBeVisible();
    await attachCleanShot(page, testInfo, 'pesquisa-1440-limite');
    simulated = { status: 503, body: { code: 'WEB_SEARCH_UNAVAILABLE', message: 'Não foi possível validar agora.' } };
    await keyCard.getByRole('button', { name: 'Salvar' }).click();
    await expect(fieldError(page, 'Não foi possível validar agora.')).toBeVisible();
    await attachCleanShot(page, testInfo, 'pesquisa-1440-falha-de-rede');
    await page.unroute('**/api/credentials/web_search');
    await keyCard.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.getByText('••••5555')).toBeVisible();

    // Desconectar: o popup do design; cancelar devolve o foco ao botão, confirmar volta ao uso anônimo e leva o foco ao campo.
    await keyCard.getByRole('button', { name: 'Desconectar' }).click();
    const dialog = page.getByRole('dialog', { name: 'Desconectar a chave da Parallel?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('A pesquisa continua funcionando no uso anônimo, com o limite do provedor.');
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'pesquisa-1440-modal-desconectar');
    await dialog.getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialog).toBeHidden();
    await expect(keyCard.getByRole('button', { name: 'Desconectar' })).toBeFocused();
    await keyCard.getByRole('button', { name: 'Desconectar' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Desconectar' }).click();
    await expect(page.getByText('Chave da Parallel desconectada')).toBeVisible();
    await expect(page.getByText('Uso anônimo', { exact: true })).toBeVisible();
    await expect(keyField(keyCard)).toBeFocused();
    expect(await page.evaluate(() => fetch('/api/settings/web-search').then((response) => response.json()))).toMatchObject({ enabled: true, key: { configured: false, masked: null } });

    // Falha ao gravar o interruptor (resposta simulada): o valor volta ao que era e o toast de erro aparece.
    await page.route('**/api/settings/web-search', (route) =>
      route.request().method() === 'PUT'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'INTERNAL_ERROR', message: 'Erro interno. Tente novamente.' }) })
        : route.continue(),
    );
    await toggle.click();
    await expect(page.getByText('Erro interno. Tente novamente.')).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await page.unroute('**/api/settings/web-search');

    await watch.expectClean(ALL_KEYS);
  });
});

test.describe('mobile (375 × 812)', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('Provedor cabe em 375 px: estados não configurado, validando, erro, configurado e modal, sem rolagem horizontal', async ({ page }, testInfo) => {
    await resetCredentials(page);
    const watch = await monitor(page);
    const card = providerCard(page);
    await page.goto('/configuracoes/conexoes');
    await expect(page.getByRole('heading', { level: 1, name: 'Conexões' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'provedores-375-nao-configurado');

    // No celular a área não tem barra inferior nem painel: o cabeçalho tem "Voltar" para o índice de Configurações (o pai fixo).
    await expect(tabBarOf(page)).toHaveCount(0);
    await expect(page.getByRole('complementary')).toBeHidden();
    await expect(backLink(page)).toHaveAttribute('href', '/configuracoes');

    // Salvar com a resposta simulada no navegador, para chegar ao estado configurado sem gastar validação real: o fluxo real de salvar é o do desktop, e o orçamento de 10 validações
    // por minuto do arquivo (ver o cabeçalho) não tem uma para o mobile do Provedor. A tela trata a resposta do POST como o estado da chave, então o resto do teste segue como se tivesse salvado.
    const savedProvider: CredentialStatus = { kind: 'provider', configured: true, masked: '••••1111', updatedAt: new Date().toISOString(), modelCount: 14 };
    await page.route('**/api/credentials/provider', (route) =>
      route.request().method() === 'POST' ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(savedProvider) }) : route.continue(),
    );
    await submitKey(card, PROVIDER_KEYS.first);
    await expect(page.getByText('••••1111')).toBeVisible();
    await expect(page.getByText('14 modelos disponíveis')).toBeVisible();
    await page.unroute('**/api/credentials/provider');
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'provedores-375-configurado');

    // Validando e erro com a resposta simulada no navegador (não consome o limite de validações da API).
    await page.route('**/api/credentials/provider', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      return route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'PROVIDER_KEY_INVALID', message: 'Chave recusada pelo provedor.' }),
      });
    });
    await card.getByRole('button', { name: 'Substituir' }).click();
    await submitKey(card, PROVIDER_KEYS.replaceInvalid);
    await expect(card.locator('form').getByRole('status')).toHaveText('Validando a chave…');
    await expectNoHorizontalScroll(page);
    await attachCleanShot(page, testInfo, 'provedores-375-validando');
    await expect(fieldError(page, 'Chave recusada pelo provedor.')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'provedores-375-erro');
    await page.unroute('**/api/credentials/provider');
    await card.getByRole('button', { name: 'Cancelar' }).click();

    // Modal de desconectar em 375 px.
    await card.getByRole('button', { name: 'Desconectar' }).click();
    await expect(page.getByRole('dialog', { name: 'Desconectar OpenCode Go?' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'provedores-375-modal');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();

    await watch.expectClean([...Object.values(PROVIDER_KEYS)]);
  });

  test('Conectores cabe em 375 px: sem contas, uma linha por conta, editores e conta desconectada, sem rolagem horizontal e sem violações', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await resetCredentials(page);
    const headers = await apiHeaders(page);
    const bot = await createBot(page, headers, 'Conta no celular');
    const watch = await monitor(page);
    const card = connectorCard(page);
    await page.goto('/configuracoes/conexoes');
    await expect(page.getByRole('heading', { level: 1, name: 'Conexões' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await attachCleanShot(page, testInfo, 'conectores-375-nao-configurado');

    // Salvar de verdade a chave que lista as contas (a ÚNICA validação real do mobile, ver o cabeçalho). A primeira leitura das contas é simulada como lista vazia, que é o estado "sem contas" em 375 px
    // (aviso e link externo); o servidor já prova esse estado no desktop, com a chave sem apps. A lista real vem logo depois, em "Atualizar".
    await page.route('**/api/connector/accounts', (route) =>
      route.request().method() === 'GET' ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accounts: [] }) }) : route.continue(),
    );
    await submitKey(card, CONNECTOR_KEYS.withApps);
    await expect(page.getByText('••••4444')).toBeVisible();
    await expect(page.getByText(CONNECTOR_NO_APPS_MESSAGE)).toBeVisible();
    await expect(page.getByRole('link', { name: /Gerenciar apps no Composio/ })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'conectores-375-sem-contas', { fullContent: true });
    await page.unroute('**/api/connector/accounts');

    // A lista real: uma linha por conta, empilhada, sem estourar a largura. Um nome do tamanho máximo, sem espaços, e um bot liberado vêm da API.
    await resetAccounts(page, headers);
    await page.getByRole('button', { name: 'Atualizar' }).click();
    await expect(accountList(page).locator(':scope > li')).toHaveCount(6);
    const longName = 'M'.repeat(CONNECTOR_ACCOUNT_NAME_MAX);
    await changeAccount(page, headers, 'ca_1', { name: longName, botIds: [bot.id] });
    await changeAccount(page, headers, 'ca_6', { name: 'Profissional' });
    await page.getByRole('button', { name: 'Atualizar' }).click();
    const long = accountRow(page, longName);
    await expect(long.getByRole('listitem').filter({ hasText: bot.name })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'conectores-375-com-contas', { fullContent: true });

    // Editor de nome com a recusa (nome em uso no app) e editor dos bots, ambos dentro da largura da tela e sem violações.
    const professional = accountRow(page, 'Profissional');
    await professional.getByRole('button', { name: 'Renomear' }).click();
    await professional.getByLabel('Nome da conta').fill(longName);
    await professional.getByRole('button', { name: 'Salvar nome' }).click();
    await expect(professional.getByRole('alert')).toHaveText('Já existe uma conta com esse nome neste app.');
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'conectores-375-nome-em-uso');
    await professional.getByRole('button', { name: 'Cancelar' }).click();
    await long.getByRole('button', { name: 'Escolher bots' }).click();
    await expect(long.getByRole('checkbox', { name: bot.name, exact: true })).toBeChecked();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'conectores-375-escolher-bots');
    await long.getByRole('button', { name: 'Cancelar' }).click();

    // Conta desconectada (resposta simulada: a conta `ca_1`, com o nome e o bot reais, vem como desconectada; o servidor já prova esse estado em `Contas`, no desktop).
    await page.route('**/api/connector/accounts', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const real = connectorAccountsResponseSchema.parse(await (await route.fetch()).json());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accounts: real.accounts.map((account) => (account.id === 'ca_1' ? { ...account, status: 'disconnected' } : account)) }) });
    });
    await page.getByRole('button', { name: 'Atualizar' }).click();
    const gone = accountRow(page, longName);
    await expect(gone).toContainText('Desconectada');
    await expect(gone).toContainText('O Composio não lista mais esta conta.');
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'conectores-375-desconectada');

    // Remover em 375 px (R8). A tela mostra `ca_1` como desconectada, mas o Composio falso a lista (ativa): o servidor confere o estado ao vivo e RECUSA (409, "tela desatualizada"), então
    // nada é apagado, o erro fica na linha com "Recarregar contas" e o foco volta ao botão. Depois a resposta de sucesso (204) é simulada para ver a linha sair da lista e o foco ir ao
    // "Atualizar"; a remoção de verdade no servidor é a do desktop (`Contas`), que tem uma conta realmente desconectada.
    const removeLabel = `Remover ${longName}`;
    await gone.getByRole('button', { name: removeLabel }).click();
    const removeDialog = page.getByRole('dialog', { name: `Remover a conta “${longName}”?` });
    await expect(removeDialog).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'conectores-375-remover-confirmacao');
    await removeDialog.getByRole('button', { name: 'Cancelar' }).click();
    await expect(gone.getByRole('button', { name: removeLabel })).toBeFocused();

    await gone.getByRole('button', { name: removeLabel }).click();
    await removeDialog.getByRole('button', { name: 'Remover conta' }).click();
    await expect(removeDialog).toHaveCount(0);
    await expect(gone.getByRole('alert')).toHaveText('Esta conta mudou desde que a lista foi carregada e não pode ser removida agora. Recarregue as contas.');
    await expect(gone.getByRole('button', { name: removeLabel })).toBeFocused();
    expect((await listAccounts(page, headers)).find((account) => account.id === 'ca_1')).toMatchObject({ status: 'active', name: longName, botIds: [bot.id] });
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'conectores-375-remocao-recusada');

    await page.route('**/api/connector/accounts/ca_1', (route) => (route.request().method() === 'DELETE' ? route.fulfill({ status: 204 }) : route.continue()));
    await gone.getByRole('button', { name: removeLabel }).click();
    await removeDialog.getByRole('button', { name: 'Remover conta' }).click();
    await expect(page.getByText('Conta removida', { exact: true })).toBeVisible();
    await expect(gone).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Atualizar' })).toBeFocused();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await page.unroute('**/api/connector/accounts/ca_1');
    await page.unroute('**/api/connector/accounts');

    await watch.expectClean([...Object.values(CONNECTOR_KEYS)]);
  });

  test('Pesquisa na web cabe em 375 px: carregando, anônima, validando, chave recusada, com chave, desligada e modal, sem rolagem horizontal', async ({ page }, testInfo) => {
    await resetCredentials(page);
    await resetWebSearch(page);
    const watch = await monitor(page);
    const keyCard = searchKeyCard(page);

    // Carregando: leitura atrasada (esqueleto dos dois cartões com aria-busy).
    await page.route('**/api/settings/web-search', async (route) => {
      if (route.request().method() === 'GET') await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.continue();
    });
    await page.goto('/configuracoes/conexoes');
    await expect(searchSkeleton(page)).toBeVisible();
    await expectNoHorizontalScroll(page);
    await attachCleanShot(page, testInfo, 'pesquisa-375-carregando');
    const toggle = page.getByRole('switch', { name: 'Pesquisa na web' });
    await expect(toggle).toBeVisible();
    await page.unroute('**/api/settings/web-search');

    // Anônima: interruptor com área de toque de 44 px, campo de chave com fonte de 16 px (sem zoom no iOS) e nada estourando a largura.
    const box = await toggle.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(await keyField(keyCard).evaluate((element) => getComputedStyle(element).fontSize)).toBe('16px');
    await expect(page.getByText('Uso anônimo', { exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'pesquisa-375-anonima');

    // No celular a área tem "Voltar" para o índice de Configurações, e nenhuma barra inferior.
    await expect(tabBarOf(page)).toHaveCount(0);
    await expect(backLink(page)).toHaveAttribute('href', '/configuracoes');

    // Validando e chave recusada, com a resposta simulada (não consome o limite de validações da API).
    await page.route('**/api/credentials/web_search', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      return route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ code: 'WEB_SEARCH_KEY_INVALID', message: 'Chave recusada pela Parallel.' }) });
    });
    await submitKey(keyCard, WEB_SEARCH_KEYS.simulated);
    await expect(keyCard.locator('form').getByRole('status')).toHaveText('Validando a chave…');
    await expectNoHorizontalScroll(page);
    await attachCleanShot(page, testInfo, 'pesquisa-375-validando');
    await expect(fieldError(page, 'Chave recusada pela Parallel.')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'pesquisa-375-chave-recusada');
    await page.unroute('**/api/credentials/web_search');

    // Com chave e desligada (leitura simulada): selo "Conectada", máscara em mono, o aviso "Desligada" e os botões com texto.
    const key = { kind: 'web_search', configured: true, masked: '••••7777', updatedAt: '2026-10-03T12:00:00.000Z', modelCount: null };
    let state: { enabled: boolean; key: unknown } = { enabled: true, key };
    await page.route('**/api/settings/web-search', (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state) }) : route.continue()));
    await page.reload();
    await expect(page.getByText('••••7777')).toBeVisible();
    await expect(page.getByText('Conectada', { exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'pesquisa-375-com-chave');
    state = { enabled: false, key };
    await page.reload();
    await expect(page.getByText('Desligada: os bots não pesquisam na web.')).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'pesquisa-375-desligada');

    // Modal de desconectar em 375 px (cancelado: o estado simulado não vai ao servidor).
    await keyCard.getByRole('button', { name: 'Desconectar' }).click();
    await expect(page.getByRole('dialog', { name: 'Desconectar a chave da Parallel?' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'pesquisa-375-modal');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.unroute('**/api/settings/web-search');

    // Falha ao carregar (leitura simulada com erro 500): o aviso com "Tentar novamente", cabendo em 375 px.
    await page.route('**/api/settings/web-search', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'INTERNAL_ERROR', message: 'Erro interno. Tente novamente.' }) })
        : route.continue(),
    );
    await page.reload();
    await expect(fieldError(page, 'Não foi possível carregar a pesquisa na web.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tentar novamente' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachCleanShot(page, testInfo, 'pesquisa-375-erro-de-carga');
    await page.unroute('**/api/settings/web-search');

    await watch.expectClean(ALL_KEYS);
  });
});

// O interruptor da pesquisa é estado global: o spec o devolve ao padrão (ligado, sem chave) mesmo se um teste falhar no meio.
test.afterAll(async ({ browser }) => {
  const context = await browser.newContext();
  try {
    await resetWebSearch(await context.newPage());
  } finally {
    await context.close();
  }
});

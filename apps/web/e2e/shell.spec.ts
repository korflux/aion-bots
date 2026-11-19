// E2E do shell (A16) em 1440 e 375 px: estrutura, teclado com foco visível e varredura axe. Phase 5, T6: no celular (375 e 320 px) a barra inferior no lugar do menu sanduíche e da gaveta, só nas
// quatro telas de aba, com o selo de Aprovações, e o "Voltar" para o pai fixo de cada tela (também aberta direto pela URL).
// Os screenshots ficam anexados ao relatório como evidência visual.
// Phase 5, T4: Configurações em 6 áreas (índice com o estado de cada uma, painel com as 6, "Ver arquivos") e o redirecionamento permanente das rotas antigas
// com a query string.
import type { Page, TestInfo } from '@playwright/test';
import {
  apiLogin,
  backLink,
  contentOf,
  expect,
  expectNoA11yViolations,
  expectNoHorizontalScroll,
  expectVisibleFocusOnTab,
  openTab,
  tabBarOf,
  tabOf,
  test,
  waitForHydration,
  type TabName,
} from './support/fixtures';

const SECTIONS = ['Bots', 'Chat geral', 'Rotinas', 'Aprovações', 'Configurações'];
/** As 6 áreas de Configurações, na ordem do painel e do índice. */
const AREAS = ['Conexões', 'Preferências', 'Personalização', 'Notificações', 'Atividade e arquivos', 'Conta e segurança'];
/** Rota antiga de Configurações → área nova (spec F9, Suposição 23). */
const OLD_ROUTES: Record<string, string> = {
  provedores: 'conexoes',
  conectores: 'conexoes',
  'pesquisa-na-web': 'conexoes',
  python: 'conexoes',
  'chat-geral': 'preferencias',
  'idioma-e-fuso': 'preferencias',
  'regras-globais': 'personalizacao',
  atividades: 'atividade-e-arquivos',
  conta: 'conta-e-seguranca',
};

async function attachShot(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, { body: await page.screenshot(), contentType: 'image/png' });
}

/** Descrição do elemento focado (nome acessível) e se o foco está visível (contorno de pelo menos 2 px). */
async function focusedElement(page: Page) {
  return page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    if (!element) return null;
    const style = getComputedStyle(element);
    return {
      name: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? element.tagName,
      outlineVisible: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2,
    };
  });
}

test.describe('shell no desktop (1440 × 900)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('barra de 56 px, painel de 264 px e conteúdo, sem violações de acessibilidade', async ({ page }, testInfo) => {
    await apiLogin(page.context());
    await page.goto('/bots');

    const rail = page.getByRole('navigation', { name: 'Seções' });
    for (const name of SECTIONS) await expect(rail.getByRole('link', { name })).toBeVisible();
    // Atividade e arquivos é consulta ocasional: não ocupa um ícone da barra, vive no painel de Configurações.
    await expect(rail.getByRole('link', { name: 'Atividade e arquivos' })).toHaveCount(0);
    await expect(rail.getByRole('link', { name: 'Bots' })).toHaveAttribute('aria-current', 'page');
    // Sem conversa com novidade (T5, F4): nenhuma bolinha de não lido na barra e o nome acessível é só o da seção.
    await expect(rail.getByRole('link', { name: 'Bots' })).toHaveAccessibleName('Bots');
    await expect(rail.getByRole('link', { name: 'Chat geral' })).toHaveAccessibleName('Chat geral');
    await expect(rail.getByTestId('unread-dot')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Bots' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Crie seu primeiro bot' })).toBeVisible();

    const panel = page.getByRole('complementary');
    await expect(panel).toContainText('Bots');
    // `toBeCloseTo`: o layout em Windows devolve larguras sub-pixel (264,0000114...) que um `toBe` exato recusa (E13).
    expect((await rail.boundingBox())?.width).toBeCloseTo(56, 0);
    expect((await panel.boundingBox())?.width).toBeCloseTo(264, 0);

    // Ícone sem texto tem tooltip (após 400 ms) e nome acessível.
    await rail.getByRole('link', { name: 'Rotinas' }).hover();
    await expect(page.getByRole('tooltip').first()).toContainText('Rotinas');

    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'shell-1440-bots');
  });

  test('teclado: Tab percorre skip link, barra e painel com foco visível, e Enter navega entre seções', async ({ page }) => {
    await apiLogin(page.context());
    await page.goto('/bots');

    const focusOrder: string[] = [];
    for (let step = 0; step < 10; step += 1) {
      await page.keyboard.press('Tab');
      const focused = await focusedElement(page);
      expect(focused?.outlineVisible, `foco visível em "${focused?.name}"`).toBe(true);
      focusOrder.push(focused?.name ?? '');
    }
    expect(focusOrder).toEqual([
      'Pular para o conteúdo',
      'Início', // a estrela da marca no topo da barra (phase 5, T5)
      'Bots',
      'Chat geral',
      'Rotinas',
      'Aprovações',
      'Configurações',
      'Novo bot',
      'Recolher painel',
      'Redimensionar painel',
    ]);

    // Enter em "Rotinas" navega e move o aria-current.
    await page.getByRole('navigation', { name: 'Seções' }).getByRole('link', { name: 'Rotinas' }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/rotinas$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Rotinas' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Seções' }).getByRole('link', { name: 'Rotinas' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('Atividade e arquivos abre pelo painel de Configurações, a seção continua sendo Configurações e "Ver arquivos" abre a lista fora do menu', async ({ page }) => {
    await apiLogin(page.context());
    await page.goto('/configuracoes/conta-e-seguranca');
    await page.getByRole('complementary').getByRole('link', { name: 'Atividade e arquivos' }).click();
    await expect(page).toHaveURL(/\/configuracoes\/atividade-e-arquivos$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Atividade e arquivos' })).toBeVisible();
    await expect(page.getByRole('complementary').getByRole('link', { name: 'Atividade e arquivos' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('navigation', { name: 'Seções' }).getByRole('link', { name: 'Configurações' })).toHaveAttribute('aria-current', 'page');
    // O cartão Armazenamento tem "Ver arquivos (N)", que abre a lista completa; a lista não é um item do menu.
    await expect(page.getByRole('region', { name: 'Armazenamento' })).toContainText(/de 1 GB/);
    await page.getByRole('link', { name: /^Ver arquivos \(\d+\)$/ }).click();
    await expect(page).toHaveURL(/\/configuracoes\/arquivos$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Arquivos' })).toBeVisible();
    await expect(page.getByRole('complementary').getByRole('link', { name: 'Arquivos', exact: true })).toHaveCount(0);
    // A lista de arquivos é filha de Atividade e arquivos: o painel segue marcando essa área (e a seção continua sendo Configurações).
    await expect(page.getByRole('complementary').getByRole('link', { name: 'Atividade e arquivos' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('navigation', { name: 'Seções' }).getByRole('link', { name: 'Configurações' })).toHaveAttribute('aria-current', 'page');
  });

  test('o painel recolhe e expande, e a largura muda por teclado dentro de 220 a 360 px', async ({ page }) => {
    await apiLogin(page.context());
    await page.goto('/bots');
    const panel = page.getByRole('complementary');

    const handle = page.getByRole('separator', { name: 'Redimensionar painel' });
    await handle.focus();
    await page.keyboard.press('ArrowRight');
    await expect(handle).toHaveAttribute('aria-valuenow', '280');
    await page.keyboard.press('End');
    await expect(handle).toHaveAttribute('aria-valuenow', '360');
    await page.keyboard.press('Home');
    await expect(handle).toHaveAttribute('aria-valuenow', '220');
    expect((await panel.boundingBox())?.width).toBeCloseTo(220, 0);

    await page.getByRole('button', { name: 'Recolher painel' }).click();
    await expect(panel).toHaveCount(0);
    await page.getByRole('button', { name: 'Expandir painel' }).click();
    await expect(panel).toBeVisible();
  });

  test('o ícone Configurações abre o índice das 6 áreas (a barra e o painel levam às mesmas), e a página de login também passa na varredura axe', async ({ page }, testInfo) => {
    await apiLogin(page.context());
    await page.goto('/bots');
    await page.getByRole('navigation', { name: 'Seções' }).getByRole('link', { name: 'Configurações' }).click();
    await expect(page).toHaveURL(/\/configuracoes$/); // o índice, e não mais a Conta
    await expect(page.getByRole('heading', { level: 1, name: 'Configurações' })).toBeVisible();
    // O painel lista as 6 áreas, na ordem, e o índice traz uma linha para cada uma, com a descrição e o link da área.
    expect(await page.getByRole('complementary').getByRole('link').allTextContents()).toEqual(AREAS);
    const list = page.locator('#conteudo').getByRole('list');
    await expect(list.getByRole('listitem')).toHaveCount(6);
    for (const [index, area] of AREAS.entries()) await expect(list.getByRole('listitem').nth(index)).toContainText(area);
    await expect(list.getByRole('listitem').nth(0)).toContainText('OpenCode Go, Anthropic, Composio, pesquisa na web e Python');
    // O estado de cada área vem dos endpoints dela (o que cada linha diz depende do estado global que os outros specs deixam).
    await expect(list.getByRole('listitem').nth(0)).toContainText(/Provedor não configurado|Composio não conectado|Tudo conectado/);
    await expect(list.getByRole('listitem').nth(1)).toContainText(/Modelo do Chat geral não definido|Português \(Brasil\) · |English · |Español · /);
    await expect(list.getByRole('listitem').nth(2)).toContainText(/\d[\d.]* \/ 8\.000 caracteres/);
    await expect(list.getByRole('listitem').nth(3)).toContainText(/(Ativadas|Desativadas) neste aparelho/);
    await expect(list.getByRole('listitem').nth(4)).toContainText(/ de 1 GB/);
    await expect(list.getByRole('listitem').nth(5)).toContainText(/Autenticador (ativo|desativado)/);
    // A33: as seis linhas do índice (e o que vem antes) mostram o anel de foco.
    await expectVisibleFocusOnTab(page, 12);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'shell-1440-configuracoes');

    // Cada linha abre a área; a área ativa no painel leva aria-current e o título é o nome dela.
    await list.getByRole('link', { name: /^Conta e segurança/ }).click();
    await expect(page).toHaveURL(/\/configuracoes\/conta-e-seguranca$/);
    await expect(page.getByRole('complementary').getByRole('link', { name: 'Conta e segurança' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { level: 1, name: 'Conta e segurança' })).toBeVisible();
    await expect(page.getByText('Esta sessão')).toBeVisible();
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'shell-1440-conta');

    // Login (sem sessão): página própria, sem shell.
    await page.context().clearCookies();
    await page.goto('/login');
    await waitForHydration(page.getByLabel('E-mail')); // o axe mede a página já hidratada (E6)
    await expect(page.getByRole('heading', { level: 1, name: 'Aion' })).toBeVisible();
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'login-1440');
  });
});

/** As quatro telas de aba da barra inferior (phase 5, T6): endereço e nome da aba. */
const TABS: { path: string; name: TabName }[] = [
  { path: '/', name: 'Início' },
  { path: '/chats', name: 'Chats' },
  { path: '/rotinas', name: 'Rotinas' },
  { path: '/aprovacoes', name: 'Aprovações' },
];
/** Telas que NÃO são de aba: sem barra inferior (conversas e editores têm cabeçalho com "Voltar"; as áreas de Configurações também). */
const SEM_BARRA = ['/bots/novo', '/rotinas/nova', '/configuracoes', '/configuracoes/preferencias', '/configuracoes/arquivos'];
/** Pai fixo de cada tela sem aba (spec, Suposição 6), aberta direto pela URL: ids inexistentes caem nos estados "não encontrado", que também levam o "Voltar". */
const UNKNOWN_BOT = '3f0e6c2e-8b1f-4c53-9d0e-6a5f2d7b9c11';
const UNKNOWN_SESSION = '7a1d2b9c-4e55-4f0a-8c3b-1d9e6f0a2b34';
const UNKNOWN_ROUTINE = 'c4b8e1f0-2d36-4a7b-9e51-0f3a6d8c5e72';
const PAIS: [path: string, parent: string][] = [
  [`/bots/${UNKNOWN_BOT}`, '/'],
  [`/bots/${UNKNOWN_BOT}/editar`, '/'],
  ['/bots/novo', '/'],
  [`/bots/${UNKNOWN_BOT}/memoria`, `/bots/${UNKNOWN_BOT}`],
  [`/chat/${UNKNOWN_SESSION}`, '/chats'],
  ['/rotinas/nova', '/rotinas'],
  [`/rotinas/${UNKNOWN_ROUTINE}`, '/rotinas'],
  [`/rotinas/${UNKNOWN_ROUTINE}/historico`, '/rotinas'],
  ['/configuracoes/conexoes', '/configuracoes'],
  ['/configuracoes/preferencias', '/configuracoes'],
  ['/configuracoes/personalizacao', '/configuracoes'],
  ['/configuracoes/notificacoes', '/configuracoes'],
  ['/configuracoes/atividade-e-arquivos', '/configuracoes'],
  ['/configuracoes/conta-e-seguranca', '/configuracoes'],
  ['/configuracoes', '/'],
  ['/configuracoes/arquivos', '/configuracoes/atividade-e-arquivos'],
];

/** Confere a barra inferior numa tela de aba: as quatro abas na ordem, só a atual com `aria-current`, alvos de 48 px e sem o menu sanduíche. */
async function expectTabBar(page: Page, active: TabName): Promise<void> {
  const bar = tabBarOf(page);
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('link')).toHaveCount(4);
  for (const { name } of TABS) {
    const tab = tabOf(page, name);
    await expect(tab).toBeVisible();
    if (name === active) await expect(tab).toHaveAttribute('aria-current', 'page');
    else await expect(tab).not.toHaveAttribute('aria-current', /.+/);
    expect((await tab.boundingBox())!.height, `alvo da aba ${name}`).toBeGreaterThanOrEqual(48);
    // O nome da aba cabe sem quebrar nem cortar (320 px inclusive).
    const label = tab.getByText(name, { exact: true }).first();
    // `clientWidth` e `scrollWidth` são inteiros arredondados: a largura fracionária do texto (62,4 px) dá 62 contra 63 sem haver corte, então compara-se com a largura medida, arredondada para cima.
    expect(await label.evaluate((element) => element.scrollWidth <= Math.ceil(element.getBoundingClientRect().width)), `rótulo de ${name} inteiro`).toBe(true);
  }
  await expect(page.getByRole('button', { name: /^Abrir menu/ })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Seções' })).toBeHidden();
}

for (const viewport of [
  { width: 375, height: 812 },
  { width: 320, height: 640 },
]) {
  test.describe(`barra inferior (${viewport.width} × ${viewport.height})`, () => {
    test.use({ viewport });

    test('aparece só nas quatro telas de aba, com o nome e o `aria-current` de cada uma, no lugar do menu sanduíche e sem rolagem horizontal', async ({ page }, testInfo) => {
      await apiLogin(page.context());
      for (const { path, name } of TABS) {
        await page.goto(path);
        await expectTabBar(page, name);
        await expectNoHorizontalScroll(page);
        await expectNoA11yViolations(page);
        await attachShot(page, testInfo, `barra-${viewport.width}-${name}`);
      }
      // Tocar numa aba abre a tela dela e passa o `aria-current`.
      await openTab(page, 'Rotinas');
      await expect(page).toHaveURL(/\/rotinas$/);
      await expectTabBar(page, 'Rotinas');
      await openTab(page, 'Aprovações');
      await expect(page).toHaveURL(/\/aprovacoes$/);
      await expectTabBar(page, 'Aprovações');
      await openTab(page, 'Chats');
      await expect(page).toHaveURL(/\/chats$/);
      await expectTabBar(page, 'Chats');
      await openTab(page, 'Início');
      await expect(page).toHaveURL(/\/$/);
      await expectTabBar(page, 'Início');
    });

    test('as demais telas não têm a barra e têm "Voltar" (conversas, editores, Configurações)', async ({ page }) => {
      await apiLogin(page.context());
      for (const path of SEM_BARRA) {
        await page.goto(path);
        await expect(page.getByRole('main').first(), path).toBeVisible();
        await expect(tabBarOf(page), path).toHaveCount(0);
        await expect(page.getByRole('button', { name: /^Abrir menu/ }), path).toHaveCount(0);
      }
    });

    test('"Voltar" leva ao pai fixo de cada tela, também aberta direto pela URL', async ({ page }) => {
      await apiLogin(page.context());
      for (const [path, parent] of PAIS) {
        await page.goto(path);
        const back = backLink(page);
        await expect(back, path).toBeVisible();
        await expect(back, path).toHaveAttribute('href', parent);
        const box = (await back.boundingBox())!;
        expect(Math.min(box.width, box.height), `alvo do Voltar em ${path}`).toBeGreaterThanOrEqual(40);
        expect(box.x, `Voltar dentro da viewport em ${path}`).toBeGreaterThanOrEqual(0);
        // Não é o histórico do navegador: a tela foi aberta direto (sem página anterior do app) e o botão leva ao pai.
        await back.click();
        await expect(page, path).toHaveURL(parent === '/' ? /\/$/ : new RegExp(`${parent.replace(/\//g, '\\/')}$`));
      }
    });
  });
}

test.describe('shell no mobile (375 × 812)', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('o selo de Aprovações some em 0, mostra o número até 9 e "9+" acima, também no nome acessível', async ({ page }, testInfo) => {
    await apiLogin(page.context());
    for (const [count, badge, name] of [
      [0, null, 'Aprovações'],
      [3, '3', 'Aprovações, 3 pendentes'],
      [9, '9', 'Aprovações, 9 pendentes'],
      [12, '9+', 'Aprovações, 12 pendentes'],
    ] as const) {
      await page.unroute('**/api/approvals/pending-count');
      await page.route('**/api/approvals/pending-count', (route) => route.fulfill({ json: { count } }));
      await page.goto('/chats');
      const tab = tabOf(page, 'Aprovações');
      await expect(tab).toHaveAccessibleName(name);
      if (badge === null) await expect(tab.getByTestId('tab-approvals-badge')).toHaveCount(0);
      else await expect(tab.getByTestId('tab-approvals-badge')).toHaveText(badge);
      if (count === 12) {
        await expectNoHorizontalScroll(page);
        await expectNoA11yViolations(page);
        await attachShot(page, testInfo, 'barra-375-selo-9mais');
      }
    }
  });

  test('o cabeçalho das abas Chats e Rotinas tem o "+" com nome acessível, e Início tem a engrenagem das Configurações', async ({ page }) => {
    await apiLogin(page.context());
    await page.goto('/chats');
    await expect(page.getByRole('heading', { level: 1, name: 'Chats' })).toBeVisible();
    await expect(contentOf(page).getByRole('button', { name: 'Novo chat' })).toBeVisible();
    await page.goto('/rotinas');
    await expect(page.getByRole('heading', { level: 1, name: 'Rotinas' })).toBeVisible();
    await expect(contentOf(page).getByRole('link', { name: 'Nova rotina' }).first()).toHaveAttribute('href', '/rotinas/nova');
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Configurações' })).toHaveAttribute('href', '/configuracoes');
  });

  test('o índice de Configurações sobrevive a uma leitura com falha: a linha daquela área fica sem estado e as outras seguem', async ({ page }, testInfo) => {
    await apiLogin(page.context());
    // A leitura das chaves falha (500): só a linha de Conexões perde o estado.
    await page.route('**/api/credentials', (route) =>
      route.request().method() === 'GET' ? route.fulfill({ status: 500, json: { code: 'INTERNAL_ERROR', message: 'Erro interno. Tente novamente.' } }) : route.continue(),
    );
    await page.goto('/configuracoes');
    const list = page.locator('#conteudo').getByRole('list');
    await expect(list.getByRole('listitem')).toHaveCount(6);
    await expect(list.getByRole('listitem').nth(5)).toContainText(/Autenticador (ativo|desativado)/); // as outras leituras chegaram
    await expect(list.getByRole('listitem').nth(0)).toContainText('Conexões');
    await expect(list.getByRole('listitem').nth(0)).not.toContainText(/Provedor não configurado|Composio não conectado|Tudo conectado/);
    await expect(list.getByRole('link').first()).toHaveAttribute('href', '/configuracoes/conexoes'); // e a linha segue sendo o link da área
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'configuracoes-375-leitura-com-falha');
  });

  test('login e Conta cabem em 375 px, sem rolagem horizontal e sem violações de acessibilidade', async ({ page }, testInfo) => {
    await page.goto('/login');
    await waitForHydration(page.getByLabel('E-mail')); // o axe mede a página já hidratada (E6)
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'login-375');

    await apiLogin(page.context());
    await page.goto('/configuracoes/conta-e-seguranca');
    await expect(page.getByText('Esta sessão')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'conta-375');
  });
});

// As rotas antigas de Configurações (11 áreas, antes da phase 5) redirecionam de forma PERMANENTE (308) à área nova, mantendo a query string, para links salvos e avisos
// continuarem válidos. O redirecionamento é do Next (`next.config.ts`), antes do proxy: vale com e sem sessão.
test.describe('rotas antigas de Configurações', () => {
  for (const [old, area] of Object.entries(OLD_ROUTES)) {
    test(`/configuracoes/${old} redireciona de forma permanente para /configuracoes/${area}, com a query string`, async ({ page }) => {
      const query = '?de=link-antigo&n=1';
      const response = await page.request.get(`/configuracoes/${old}${query}`, { maxRedirects: 0 });
      expect(response.status()).toBe(308);
      expect(response.headers()['location']).toBe(`/configuracoes/${area}${query}`);
      // No navegador, com sessão: chega na área nova com a query string intacta.
      await apiLogin(page.context());
      await page.goto(`/configuracoes/${old}${query}`);
      await expect(page).toHaveURL(new RegExp(`/configuracoes/${area}\\?de=link-antigo&n=1$`));
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    });
  }

  test('/configuracoes/arquivos continua existindo (não é rota antiga) e sem sessão cai no login preservando o destino novo', async ({ page }) => {
    const kept = await page.request.get('/configuracoes/arquivos', { maxRedirects: 0 });
    expect(kept.status()).not.toBe(308);
    // Sem sessão: a rota antiga vai à área nova e o login guarda o destino novo em `next`.
    await page.goto('/configuracoes/conta?x=1');
    await expect(page).toHaveURL(/\/login\?next=%2Fconfiguracoes%2Fconta-e-seguranca%3Fx%3D1$/);
  });
});

// E2E de A1 no navegador real, contra a pilha de produção: redirecionamento com destino, erro inline, bloqueio,
// sair, encerrar outra sessão e proteção do destino pós-login, e a assinatura do login (phase 5, T1 e T3: Faísca com halo, entrada, olhar que segue o cursor, tamanho por
// viewport e movimento reduzido, e o logotipo "Aion" como único título).
import { apiLogin, attachShot, expect, expectFaiscaEnvelope, expectNoA11yViolations, expectNoHorizontalScroll, AION_BODY, faiscaLook, OWNER, test, waitForHydration } from './support/fixtures';

/** Preenche e envia o login. Espera a hidratação antes de digitar: texto digitado antes dela se perde (E6). */
const submitLogin = async (page: import('@playwright/test').Page, password: string) => {
  await waitForHydration(page.getByLabel('E-mail'));
  await page.getByLabel('E-mail').fill(OWNER.email);
  await page.getByLabel('Senha', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
};

// O Next mantém um `role=alert` próprio (anunciador de rotas); o erro do formulário é o do <main>.
const formAlert = (page: import('@playwright/test').Page) => page.getByRole('main').getByRole('alert');

test.describe('login e sessão', () => {
  test('Sair revoga a sessão e mantém /login quando uma leitura real em voo recebe 401 depois da revogação', async ({ page }, testInfo) => {
    await apiLogin(page.context());
    let readStarted!: () => void;
    const reading = new Promise<void>((resolve) => { readStarted = resolve; });
    const startedReads = new Set<string>();
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    let serverRevoked!: () => void;
    const revoked = new Promise<void>((resolve) => { serverRevoked = resolve; });
    let releaseLogout!: () => void;
    const logoutGate = new Promise<void>((resolve) => { releaseLogout = resolve; });
    // A leitura começa autenticada, mas só chega ao servidor depois do logout verdadeiro; não fabricamos o 401.
    await page.route(/\/api\/auth\/(sessions|totp)$/, async (route) => {
      // Retemos ambas as leituras para provar os dois consumidores, sem depender da ordem da rede.
      startedReads.add(new URL(route.request().url()).pathname);
      if (startedReads.size === 2) readStarted();
      await readGate;
      const response = await route.fetch();
      expect(response.status()).toBe(401);
      await route.fulfill({ response });
    });
    await page.route('**/api/auth/logout', async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(204);
      serverRevoked(); await logoutGate;
      await route.fulfill({ response });
    });
    try {
      await page.goto('/configuracoes/conta-e-seguranca'); await reading;
      await page.getByRole('button', { name: 'Sair', exact: true }).click(); await revoked;
      releaseRead();
      // A leitura atrasada foi processada sem competir com a saída, enquanto o POST ainda aguarda sua resposta no navegador.
      // Os dois consumidores da conta recebem a revogação; cada região deve anunciar seu próprio erro.
      for (const name of ['Autenticador', 'Sessões']) {
        await expect(page.getByRole('region', { name, exact: true }).getByRole('alert')).toHaveText('Sessão expirada. Entre novamente.');
      }
      await expect(page).toHaveURL('/configuracoes/conta-e-seguranca');
      releaseLogout(); await expect(page).toHaveURL(/\/login$/);
      for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
        await expectNoA11yViolations(page); await expectNoHorizontalScroll(page);
        await attachShot(page, testInfo, `logout-com-leitura-atrasada-${width}`);
      }
      expect((await page.context().request.get('/api/auth/sessions')).status()).toBe(401);
    } finally {
      releaseRead(); releaseLogout();
    }
  });

  test('sem sessão vai ao login preservando o destino; erro inline; entra no destino; sair revoga', async ({ page }) => {
    await page.goto('/rotinas?filtro=ativas');
    await expect(page).toHaveURL(/\/login\?next=%2Frotinas%3Ffiltro%3Dativas$/);

    // Credencial errada: mensagem única e inline, e o campo de senha é limpo.
    await submitLogin(page, 'senha-errada-qualquer');
    await expect(formAlert(page)).toHaveText('E-mail ou senha incorretos.');
    await expect(page.getByLabel('Senha', { exact: true })).toHaveValue('');

    // Credencial certa: cai no destino original, com a query preservada.
    await submitLogin(page, OWNER.password);
    await expect(page).toHaveURL('/rotinas?filtro=ativas');
    await expect(page.getByRole('heading', { level: 1, name: 'Rotinas' })).toBeVisible();

    // Conta mostra o dono e a sessão atual; Sair leva ao login e a sessão deixa de existir.
    await page.getByRole('link', { name: 'Configurações', exact: true }).click();
    await expect(page).toHaveURL(/\/configuracoes$/);
    await page.getByRole('complementary').getByRole('link', { name: 'Conta e segurança' }).click();
    await expect(page).toHaveURL(/\/configuracoes\/conta-e-seguranca$/);
    await expect(page.getByText(OWNER.email)).toBeVisible();
    await expect(page.getByText('Esta sessão')).toBeVisible();
    await page.getByRole('button', { name: 'Sair' }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.goto('/bots');
    await expect(page).toHaveURL(/\/login\?next=%2Fbots$/);
  });

  test('5 falhas seguidas bloqueiam o IP: mensagem de bloqueio e botão desabilitado, mesmo com a senha certa', async ({ page }) => {
    await page.goto('/login');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await submitLogin(page, 'senha-errada-qualquer');
      await expect(formAlert(page)).toHaveText('E-mail ou senha incorretos.');
    }
    await submitLogin(page, OWNER.password);
    await expect(formAlert(page)).toHaveText('Muitas tentativas. Tente novamente em alguns minutos.');
    await expect(page.getByRole('button', { name: 'Entrar' })).toBeDisabled();
    await expect(page).toHaveURL(/\/login/);
  });

  test('encerrar outra sessão em Conta a revoga no servidor: o outro dispositivo é levado ao login', async ({ page, browser }) => {
    await apiLogin(page.context());
    const other = await browser.newContext({
      extraHTTPHeaders: { 'x-e2e-client-ip': '198.19.10.10' },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    });
    try {
      await apiLogin(other);
      const otherPage = await other.newPage();
      await otherPage.goto('/bots');
      await expect(otherPage.getByRole('heading', { level: 1, name: 'Bots' })).toBeVisible();

      await page.goto('/configuracoes/conta-e-seguranca');
      await expect(page.getByText('Safari no macOS')).toBeVisible();
      await page.getByRole('button', { name: 'Encerrar sessão de Safari no macOS' }).click();
      await expect(page.getByText('Sessão encerrada')).toBeVisible();
      await expect(page.getByText('Safari no macOS')).toHaveCount(0);

      // O cookie do outro dispositivo continua no navegador dele, mas o servidor já não o reconhece.
      await otherPage.reload();
      await expect(otherPage).toHaveURL(/\/login\?next=%2Fbots$/);
    } finally {
      await other.close();
    }
  });

  test('destino externo em ?next é ignorado depois do login (sem open redirect)', async ({ page }) => {
    await page.goto('/login?next=//evil.example/roubar');
    await submitLogin(page, OWNER.password);
    await expect(page).toHaveURL('/');
  });

  test('entrar sem `next` abre o Início, e um `next` válido (inclusive /bots) continua respeitado (A17)', async ({ page }) => {
    // Sem destino: o Início (`/`), com o shell e um único título (a saudação, ou o convite do estado vazio quando ainda não há bots).
    await page.goto('/login');
    await submitLogin(page, OWNER.password);
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^(Bom dia|Boa tarde|Boa noite|Seus bots começam aqui)/);
    await expect(page.getByRole('textbox', { name: 'Pergunte ao Aion' })).toBeVisible();
    await expect(page.getByRole('main')).toHaveCount(1);

    // Pedir uma tela sem sessão leva ao login com o destino, e ele é respeitado depois de entrar (aqui /bots, que segue abrindo a seção de bots).
    await page.context().clearCookies();
    await page.goto('/bots');
    await expect(page).toHaveURL(/\/login\?next=%2Fbots$/);
    await submitLogin(page, OWNER.password);
    await expect(page).toHaveURL(/\/bots(\/[0-9a-f-]{36})?$/);
  });

  test('a senha pode ser mostrada e ocultada com nome acessível e estado', async ({ page }) => {
    await page.goto('/login');
    await waitForHydration(page.getByLabel('E-mail'));
    const password = page.getByLabel('Senha', { exact: true });
    await password.fill('segredo-de-teste');
    await expect(password).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'Mostrar senha' }).click();
    await expect(password).toHaveAttribute('type', 'text');
    await expect(page.getByRole('button', { name: 'Ocultar senha' })).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('cabeçalhos de segurança da web', () => {
  test('a página de login vem com CSP de nonce e cabeçalhos de segurança, e a CSP não bloqueia nada nem gera erro no console', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') consoleErrors.push(message.text());
    });
    // Registra violações de CSP reportadas pelo navegador desde o início do carregamento.
    await page.addInitScript(() => {
      (window as unknown as { __csp: string[] }).__csp = [];
      document.addEventListener('securitypolicyviolation', (event) =>
        (window as unknown as { __csp: string[] }).__csp.push(
          `${event.violatedDirective}: ${event.blockedURI} em ${event.sourceFile}:${event.lineNumber} (${event.sample})`,
        ),
      );
    });

    const response = await page.goto('/login');
    const headers = response!.headers();
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['x-frame-options']).toBe('DENY');
    const csp = headers['content-security-policy']!;
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    // O servidor Next de produção também processa os headers: prova os assets reais, sem confiar só no proxy isolado.
    expect(headers['cache-control']).toBe('no-store');
    const chunk = await page.locator('script[src^="/_next/static/"]').first().getAttribute('src');
    expect(chunk).toBeTruthy();
    // O ícone vem do manifesto servido (o endereço leva o hash do conteúdo, phase 5, T9), não de um nome fixo: é o caminho que o navegador percorre.
    const served = (await (await page.request.get('/manifest.webmanifest')).json()) as { icons: { src: string; sizes: string; purpose?: string }[] };
    const icon192 = served.icons.find((icon) => icon.sizes === '192x192')?.src;
    expect(icon192, 'o manifesto declara o ícone de 192 px').toMatch(/^\/icons\/icon-192\.[0-9a-f]{8}\.png$/);
    for (const [path, cache] of [
      [chunk!, 'public, max-age=31536000, immutable'],
      [icon192!, 'public, max-age=86400'],
      ['/sw.js', 'no-store'], ['/manifest.webmanifest', 'no-store'],
    ]) {
      const asset = await page.request.get(path!);
      expect(asset.status(), path).toBe(200);
      const assetHeaders = asset.headers();
      expect(assetHeaders['cache-control'], path).toBe(cache);
      expect(assetHeaders['content-security-policy'], path).toContain("frame-ancestors 'none'");
      for (const header of ['x-content-type-options', 'referrer-policy', 'x-frame-options', 'permissions-policy']) {
        expect(assetHeaders[header], `${path}: ${header}`).toBe(headers[header]);
      }
    }
    // O nonce muda a cada requisição.
    const again = await page.request.get('/login');
    expect(again.headers()['content-security-policy']).not.toBe(csp);

    // A página hidratou e funciona sob a CSP (o botão de mostrar senha só reage com JavaScript rodando).
    await page.getByLabel('Senha', { exact: true }).fill('x');
    await page.getByRole('button', { name: 'Mostrar senha' }).click();
    await expect(page.getByLabel('Senha', { exact: true })).toHaveAttribute('type', 'text');

    expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});

test.describe('assinatura do login: Faísca e logotipo (phase 5, T1 e T3)', () => {
  test('112 px com a entrada e o olhar que segue o cursor; 96 px no celular e 72 px com a janela baixa; parada, sem olhar, com movimento reduzido', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/login');
    await waitForHydration(page.getByLabel('E-mail'));
    const faisca = page.locator('svg.faisca');
    await expect(faisca).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1, name: 'Aion' })).toBeVisible();
    // O único título é o logotipo: SVG com o nome acessível "Aion" e 36 px de altura, abaixo da Faísca, que fica dentro do halo. Um `main` só.
    const logo = page.getByRole('heading', { level: 1 }).locator('svg[role="img"]');
    await expect(logo).toHaveAttribute('aria-label', 'Aion');
    expect((await logo.boundingBox())!.height).toBeCloseTo(36, 0);
    expect((await faisca.boundingBox())!.y + 112, 'a Faísca vem acima do logotipo').toBeLessThanOrEqual((await logo.boundingBox())!.y);
    await expectFaiscaEnvelope(faisca);
    await expect(page.getByRole('main')).toHaveCount(1);

    // A Faísca do Aion na cor de marca (a tela não tem bot), ociosa, de 112 px, com a entrada de uma vez, decorativa; o título segue sendo a marca.
    expect(await faiscaLook(faisca)).toMatchObject({ state: 'idle', detail: 'full', still: true, decorative: true, size: [112, 112], body: AION_BODY });
    await expect(faisca).toHaveAttribute('data-enter', '');
    await attachShot(page, testInfo, 'login-faisca-1440');

    // Sem cursor a Faísca fica à frente (sem olhar fixo). Com o cursor longe, o rosto desliza para o lado dele (a translação do grupo do rosto muda de sinal).
    await expect(faisca).not.toHaveAttribute('data-look', '');
    const box = (await faisca.boundingBox())!;
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const faceShift = () => faisca.evaluate((svg) => new DOMMatrixReadOnly(getComputedStyle(svg.querySelector('[data-part="eyes"]')!).transform).m41);
    await page.mouse.move(center.x + 400, center.y);
    await expect(faisca).toHaveAttribute('data-look', '');
    await expect.poll(faceShift).toBeGreaterThan(1.5);
    await attachShot(page, testInfo, 'login-faisca-olhar-direita-1440');
    await page.mouse.move(center.x - 400, center.y);
    await expect.poll(faceShift).toBeLessThan(-1.5);
    await attachShot(page, testInfo, 'login-faisca-olhar-esquerda-1440');

    // Tamanho por viewport: 112 px, 96 px abaixo de 768 px de largura e 72 px com a altura abaixo de 640 px (a altura curta vence a largura estreita).
    const sizeAt = async (width: number, height: number) => {
      await page.setViewportSize({ width, height });
      return (await faiscaLook(faisca)).size;
    };
    expect(await sizeAt(768, 900)).toEqual([112, 112]);
    expect(await sizeAt(767, 900)).toEqual([96, 96]);
    expect(await sizeAt(375, 812)).toEqual([96, 96]);
    expect(await sizeAt(1440, 640)).toEqual([112, 112]);
    expect(await sizeAt(1440, 639)).toEqual([72, 72]);
    expect(await sizeAt(375, 600)).toEqual([72, 72]);

    // Janela baixa no celular (teclado aberto): o formulário inteiro cabe sem rolar, sem rolagem horizontal e sem violações.
    await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
    const submit = (await page.getByRole('button', { name: 'Entrar' }).boundingBox())!;
    expect(submit.y + submit.height, 'o botão Entrar cabe na janela de 600 px').toBeLessThanOrEqual(600);
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'login-faisca-375-baixo');

    // Movimento reduzido: pose estática (nenhuma animação em curso) e o rosto não segue o cursor.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(faisca).not.toHaveAttribute('data-look', '');
    await expect.poll(() => page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === 'running').length)).toBe(0);
    const still = await faceShift();
    await page.mouse.move(center.x + 400, center.y + 100);
    await page.mouse.move(center.x - 300, center.y - 150);
    await page.waitForTimeout(400);
    await expect(faisca).not.toHaveAttribute('data-look', '');
    expect(await faceShift(), 'o rosto não segue o cursor com movimento reduzido').toBeCloseTo(still, 5);
    await attachShot(page, testInfo, 'login-faisca-movimento-reduzido-1440');
  });
});

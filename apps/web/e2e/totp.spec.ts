// E2E de A2 no navegador real, contra a pilha de produção: ativar o autenticador em Conta (modal com QR e segredo),
// entrar com o código, erro, reuso do código, expiração do desafio, bloqueio e desativar. Os screenshots ficam
// anexados ao relatório como evidência visual (1440 × 900 e 375 × 812).
//
// O TOTP é estado GLOBAL (dono único): com ele ativo, o login de qualquer outro teste pediria código. Por isso este
// arquivo roda num projeto próprio, depois dos demais (playwright.config.ts), em série, e cada teste devolve o
// autenticador ao estado desativado no fim. O "reinício com AION_TOTP_RESET=true" não é feito aqui (a pilha do E2E
// não reinicia a API no meio): ele é provado na subida real da API em apps/api/src/totp.routes.test.ts.
//
// Orçamento de falhas: o limite global de AUTH-04 (20 falhas/hora, banco inteiro) vale para o E2E todo. Este arquivo
// provoca poucos palpites errados de propósito e simula o estado "bloqueado" com uma resposta 429 simulada; o
// bloqueio de verdade é provado pelos testes da API.
import type { Page, TestInfo } from '@playwright/test';
import {
  AION_BODY,
  CLIENT_IP_HEADER,
  ORIGIN,
  OWNER,
  apiLogin,
  clientIpFor,
  expect,
  expectNoA11yViolations,
  expectNoHorizontalScroll,
  faiscaLook,
  test,
  waitForHydration,
  expectFaiscaEnvelope,
} from './support/fixtures';
import {
  disableTotpViaApi,
  enableTotpViaApi,
  freshCode,
  totpEnabled,
  wrongCode,
  type ActiveTotp,
} from './support/totp';

test.describe.configure({ mode: 'serial' });

const VIEWPORTS = [
  { name: '1440', size: { width: 1440, height: 900 } },
  { name: '375', size: { width: 375, height: 812 } },
] as const;

/** Captura a tela e a anexa ao relatório; o arquivo também fica em test-results/<teste>/<nome>.png. */
async function attachShot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

/**
 * Observa a página desde o início: violações de CSP, erros e avisos de console e toda origem contatada. O QR é
 * desenhado no navegador, então nenhum pedido pode sair da origem do app (o segredo não vai a serviço externo).
 */
async function watch(page: Page) {
  const problems: string[] = [];
  const origins = new Set<string>();
  page.on('console', (message) => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    // O navegador registra como erro toda resposta 4xx de fetch, inclusive as esperadas destes testes (código errado).
    if (message.text().startsWith('Failed to load resource') && message.location().url.includes('/api/auth/')) return;
    problems.push(message.text());
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol === 'http:' || url.protocol === 'https:') origins.add(url.origin);
  });
  await page.addInitScript(() => {
    const store: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = store;
    document.addEventListener('securitypolicyviolation', (event) => store.push(`${event.violatedDirective}: ${event.blockedURI}`));
  });
  return {
    /** Nenhuma violação de CSP no documento atual. */
    async expectNoCspViolations() {
      expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
    },
    /** Sem erro de console e sem nenhum pedido fora da origem do app. */
    expectClean() {
      expect(problems).toEqual([]);
      expect([...origins]).toEqual([ORIGIN]);
    },
  };
}

async function passwordLogin(page: Page) {
  await page.goto('/login');
  await waitForHydration(page.getByLabel('E-mail'));
  await page.getByLabel('E-mail').fill(OWNER.email);
  await page.getByLabel('Senha', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
}

/** A caixa ativa do campo de código tem anel de foco visível (o input real é transparente). */
const activeCellHasRing = (page: Page) =>
  page.evaluate(() => {
    const input = document.activeElement as HTMLInputElement | null;
    const cells = input?.parentElement?.firstElementChild?.children;
    return Boolean(cells && [...cells].some((cell) => getComputedStyle(cell).boxShadow !== 'none'));
  });

// O formulário tem o próprio `role=alert`; o Next mantém outro, do anunciador de rotas.
const formAlert = (page: Page) => page.getByRole('main').getByRole('alert');

test.describe('jornada completa no desktop', () => {
  test.use({ viewport: VIEWPORTS[0].size });

  test('ativa em Conta, sai, entra com o código, recusa erro e reuso, e desativa', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const faults = await watch(page);
    await apiLogin(page.context());
    await page.goto('/configuracoes/conta');

    const section = page.getByRole('region', { name: 'Autenticador' });
    await expect(section.getByRole('button', { name: 'Ativar' })).toBeVisible();
    await expect(section).toContainText('Adicione uma segunda etapa ao login');
    await attachShot(page, testInfo, 'totp-1440-conta-inativo');

    // Modal de ativação: QR de 200 px, segredo em texto, confirmar desabilitado até 6 dígitos.
    await section.getByRole('button', { name: 'Ativar' }).click();
    const dialog = page.getByRole('dialog', { name: 'Ativar autenticador' });
    const qr = dialog.getByRole('img', { name: /QR code/ });
    await expect(qr).toBeVisible();
    expect((await qr.boundingBox())?.width).toBeCloseTo(200, 0); // sub-pixel no Windows (E13)
    const secret = (await dialog.getByTestId('totp-secret').innerText()).replaceAll(/\s/g, '');
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const codeInput = dialog.getByLabel('Código do app');
    await expect(codeInput).toBeFocused();
    await expect(dialog.getByRole('button', { name: 'Confirmar' })).toBeDisabled();
    await faults.expectNoCspViolations();
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'totp-1440-ativar-modal');

    // Código errado: erro inline, o modal fica, e NADA foi ativado no servidor.
    await codeInput.fill(wrongCode(secret));
    await dialog.getByRole('button', { name: 'Confirmar' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Código inválido.');
    await expect(codeInput).toHaveValue('');
    await expect(codeInput).toBeFocused();
    expect(await totpEnabled(page.context())).toBe(false);
    await attachShot(page, testInfo, 'totp-1440-ativar-erro');

    // Código certo: o modal fecha, aparece o aviso e o estado vira "Ativo".
    const activation = await freshCode(secret, -1);
    await codeInput.fill(activation.code);
    await dialog.getByRole('button', { name: 'Confirmar' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Autenticador ativado')).toBeVisible();
    await expect(section.getByText('Ativo', { exact: true })).toBeVisible();
    await expect(section.getByRole('button', { name: 'Desativar' })).toBeFocused();
    await attachShot(page, testInfo, 'totp-1440-conta-ativo');
    faults.expectClean();

    // Sair e entrar de novo: a senha correta leva ao segundo passo, sem sessão ainda.
    await page.getByRole('button', { name: 'Sair' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await passwordLogin(page);
    await expect(page).toHaveURL(/\/login\/totp\?next=%2F$/);
    await page.goto('/bots');
    await expect(page).toHaveURL(/\/login\?next=%2Fbots$/);
    await passwordLogin(page);
    await expect(page).toHaveURL(/\/login\/totp\?next=%2F$/);

    // O código da ativação já foi usado: recusado, campo limpo e foco de volta no campo.
    const loginCode = page.getByLabel('Código de verificação');
    await waitForHydration(loginCode);
    await loginCode.fill(activation.code);
    await expect(formAlert(page)).toHaveText('Código inválido.');
    await expect(loginCode).toHaveValue('');
    await expect(loginCode).toBeFocused();

    // O código da janela seguinte entra sozinho ao completar os 6 dígitos.
    const login = await freshCode(secret, activation.step);
    await loginCode.fill(login.code);
    // Sem `next`, entrar abre o Início (phase 5, T5, A17): o título é a saudação ou, sem bots, o convite do estado vazio.
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^(Bom dia|Boa tarde|Boa noite|Seus bots começam aqui)/);

    // Desativar em Conta: código errado mantém; o certo (esperando a janela se preciso) desativa.
    await page.goto('/configuracoes/conta');
    await section.getByRole('button', { name: 'Desativar' }).click();
    const disableDialog = page.getByRole('dialog', { name: 'Desativar autenticador' });
    const disableInput = disableDialog.getByLabel('Código do app');
    await expect(disableInput).toBeFocused();
    await disableInput.fill(wrongCode(secret));
    await disableDialog.getByRole('button', { name: 'Desativar' }).click();
    await expect(disableDialog.getByRole('alert')).toHaveText('Código inválido.');
    await expect(disableInput).toBeFocused();
    await attachShot(page, testInfo, 'totp-1440-desativar-erro');
    const disable = await freshCode(secret, login.step);
    await disableInput.fill(disable.code);
    await disableDialog.getByRole('button', { name: 'Desativar' }).click();
    await expect(disableDialog).toBeHidden();
    await expect(page.getByText('Autenticador desativado')).toBeVisible();
    await expect(section.getByRole('button', { name: 'Ativar' })).toBeVisible();

    // De volta ao login simples: sair e entrar só com e-mail e senha.
    await page.getByRole('button', { name: 'Sair' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await passwordLogin(page);
    await expect(page).toHaveURL('/');
  });
});

for (const viewport of VIEWPORTS) {
  test.describe(`tela /login/totp em ${viewport.name} px`, () => {
    test.use({ viewport: viewport.size });

    test('estados inicial, enviando, código inválido, desafio expirado e bloqueado', async ({ browser, page }, testInfo) => {
      // O dono fica logado (sessão criada ANTES de ativar) só para desligar o autenticador no fim.
      const owner = await browser.newContext({ extraHTTPHeaders: { [CLIENT_IP_HEADER]: clientIpFor(`${testInfo.testId}:owner`) } });
      let totp: ActiveTotp | undefined;
      try {
        await apiLogin(owner);
        totp = await enableTotpViaApi(owner);
        const faults = await watch(page);

        await passwordLogin(page);
        await expect(page).toHaveURL(/\/login\/totp\?next=%2F$/);
        const input = page.getByLabel('Código de verificação');
        const verify = page.getByRole('button', { name: 'Verificar' });

        // Inicial: campo focado com anel visível, botão desabilitado, sem rolagem horizontal e sem violações.
        await expect(page.getByRole('heading', { level: 1, name: 'Aion' })).toBeVisible();
        // O único título é o logotipo (SVG com o nome acessível "Aion", 36 px de altura), e a Faísca do login em 72 px fica acima dele, dentro do halo.
        const logo = page.getByRole('heading', { level: 1 }).locator('svg[role="img"]');
        await expect(logo).toHaveAttribute('aria-label', 'Aion');
        expect((await logo.boundingBox())!.height).toBeCloseTo(36, 0);
        // A Faísca do login em 72 px, PARADA e sem nova entrada (a continuidade da tela), na cor de marca; decorativa.
        const faisca = page.locator('svg.faisca');
        await expect(faisca).toHaveCount(1);
        await expectFaiscaEnvelope(faisca);
        expect(await faiscaLook(faisca)).toMatchObject({ state: 'idle', detail: 'full', still: true, decorative: true, size: [72, 72], body: AION_BODY });
        await expect(faisca).not.toHaveAttribute('data-enter', '');
        await expect(faisca).not.toHaveAttribute('data-look', '');
        expect(await faisca.evaluate((svg) => svg.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running').length), 'a Faísca do TOTP não se anima').toBe(0);
        await waitForHydration(input);
        await expect(input).toBeFocused();
        expect(await activeCellHasRing(page)).toBe(true);
        await expect(verify).toBeDisabled();
        await expect(page.getByRole('link', { name: 'Voltar' })).toHaveAttribute('href', '/login?next=%2F');
        await expectNoHorizontalScroll(page);
        await expectNoA11yViolations(page);
        await faults.expectNoCspViolations();
        await attachShot(page, testInfo, `totp-login-${viewport.name}-inicial`);

        // A colagem com espaços e texto em volta vira só dígitos; o estado parcial mostra os dígitos nas caixas.
        await input.fill('12 34');
        await expect(input).toHaveValue('1234');
        await expect(verify).toBeDisabled();
        await input.fill('');

        // Enviando: o envio é automático ao completar; enquanto espera, o botão mostra o spinner e fica desabilitado.
        await page.route('**/api/auth/totp/verify', async (route) => {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          await route.continue();
        });
        await input.fill(wrongCode(totp.secret));
        await expect(verify).toBeDisabled();
        await expect(verify.locator('[data-icon="LoaderCircle"]')).toBeVisible();
        await attachShot(page, testInfo, `totp-login-${viewport.name}-enviando`);

        // Código inválido: erro inline, campo limpo e foco de volta. O atraso só sai depois da resposta chegar
        // (retirar a rota com o pedido em voo faria o `route.continue` pendente falhar).
        await expect(formAlert(page)).toHaveText('Código inválido.');
        await page.unroute('**/api/auth/totp/verify');
        await expect(input).toHaveValue('');
        await expect(input).toBeFocused();
        await expectNoA11yViolations(page);
        await attachShot(page, testInfo, `totp-login-${viewport.name}-erro`);

        // Bloqueado (resposta simulada, o bloqueio real é provado na API): mensagem, campo e botão desabilitados.
        await page.route('**/api/auth/totp/verify', (route) =>
          route.fulfill({
            status: 429,
            headers: { 'retry-after': '900' },
            json: { code: 'AUTH_LOCKED', message: 'Muitas tentativas. Tente novamente em alguns minutos.' },
          }),
        );
        await input.fill(wrongCode(totp.secret));
        await expect(formAlert(page)).toHaveText('Muitas tentativas. Tente novamente em alguns minutos.');
        await expect(input).toBeDisabled();
        await expect(verify).toBeDisabled();
        await expectNoA11yViolations(page);
        await attachShot(page, testInfo, `totp-login-${viewport.name}-bloqueado`);
        await page.unroute('**/api/auth/totp/verify');

        // Desafio expirado (o cookie de 5 min some do navegador): volta ao login com aviso, sem perder o destino.
        await page.reload();
        await page.context().clearCookies({ name: 'aion_totp_challenge' });
        const reloaded = page.getByLabel('Código de verificação');
        await waitForHydration(reloaded);
        await reloaded.fill(wrongCode(totp.secret));
        await expect(page.getByText('O tempo expirou. Entre novamente.')).toBeVisible();
        await expect(page).toHaveURL(/\/login\?next=%2F$/);
        await attachShot(page, testInfo, `totp-login-${viewport.name}-expirado`);
        faults.expectClean();
      } finally {
        if (totp) await disableTotpViaApi(owner, totp);
        await owner.close();
      }
    });

    test('modais de ativar e desativar: layout, teclado, foco e acessibilidade', async ({ page }, testInfo) => {
      const faults = await watch(page);
      await apiLogin(page.context());
      await page.goto('/configuracoes/conta');
      const section = page.getByRole('region', { name: 'Autenticador' });
      let totp: ActiveTotp | undefined;
      let disabledByUi = false;
      try {
        // Ativar: o QR cabe na tela, sem rolagem horizontal, e o foco fica preso dentro do modal.
        await expectNoA11yViolations(page);
        await attachShot(page, testInfo, `totp-${viewport.name}-conta-inativo`);
        await section.getByRole('button', { name: 'Ativar' }).click();
        const dialog = page.getByRole('dialog', { name: 'Ativar autenticador' });
        const qr = dialog.getByRole('img', { name: /QR code/ });
        await expect(qr).toBeVisible();
        const box = (await dialog.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.size.width);
        await expectNoHorizontalScroll(page);
        await expect(dialog.getByLabel('Código do app')).toBeFocused();
        expect(await activeCellHasRing(page)).toBe(true);
        await expectNoA11yViolations(page);
        await attachShot(page, testInfo, `totp-${viewport.name}-ativar-modal`);
        for (let press = 0; press < 8; press += 1) {
          await page.keyboard.press('Tab');
          expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null), `Tab ${press + 1}`).toBe(true);
        }

        // Erro visível no modal; Esc fecha e devolve o foco ao botão que o abriu.
        const secret = (await dialog.getByTestId('totp-secret').innerText()).replaceAll(/\s/g, '');
        await dialog.getByLabel('Código do app').fill(wrongCode(secret));
        await dialog.getByRole('button', { name: 'Confirmar' }).click();
        await expect(dialog.getByRole('alert')).toHaveText('Código inválido.');
        await attachShot(page, testInfo, `totp-${viewport.name}-ativar-erro`);
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(section.getByRole('button', { name: 'Ativar' })).toBeFocused();

        // Desativar: liga pela API, abre o modal de confirmação e desativa com o próximo código livre.
        totp = await enableTotpViaApi(page.context());
        await page.reload();
        await section.getByRole('button', { name: 'Desativar' }).click();
        const disableDialog = page.getByRole('dialog', { name: 'Desativar autenticador' });
        await expect(disableDialog.getByLabel('Código do app')).toBeFocused();
        await expectNoHorizontalScroll(page);
        await expectNoA11yViolations(page);
        await attachShot(page, testInfo, `totp-${viewport.name}-desativar-modal`);
        await disableDialog.getByLabel('Código do app').fill((await freshCode(totp.secret, totp.lastUsedStep)).code);
        await disableDialog.getByRole('button', { name: 'Desativar' }).click();
        await expect(disableDialog).toBeHidden();
        await expect(page.getByText('Autenticador desativado')).toBeVisible();
        disabledByUi = true;
        await faults.expectNoCspViolations();
        faults.expectClean();
      } finally {
        if (totp && !disabledByUi) await disableTotpViaApi(page.context(), totp);
      }
    });
  });
}

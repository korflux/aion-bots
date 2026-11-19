// Phase 8 T1: preferências e herança renderizadas na pilha descartável, sem inferência real.
import { apiHeaders, apiLogin, attachShot, ensureCredential, expect, expectNoA11yViolations, expectNoHorizontalScroll, ORIGIN, test, uniqueBotName } from './support/fixtures';

test.describe.configure({ mode: 'serial' });

test('editor, preferências e Início leem contexto local sem consultar catálogo ao abrir', async ({ page }) => {
  await ensureCredential(page, 'provider', 'valid-e2e-context-1111');
  const headers = await apiHeaders(page);
  expect((await page.request.patch(`${ORIGIN}/api/models/favorite`, { headers, data: { model: 'opencode/glm-5.1', favorite: true } })).status()).toBe(200);
  const catalogRequests: string[] = [];
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/models') catalogRequests.push(request.method()); });
  const localProfiles = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/models/profiles');
  await page.goto('/bots/novo');
  expect((await localProfiles).status()).toBe(200);
  // Modelo sem capacidade confirmada (glm-5.1): vale a janela escolhida, sem teto provisório de 32k nem aviso de capacidade.
  const botsPreference = (await (await page.request.get(`${ORIGIN}/api/settings/context`, { headers })).json()).bots as number;
  await expect(page.getByText(`Limite efetivo: ${botsPreference / 1024}k.`, { exact: true })).toBeVisible();
  await expect(page.getByText(/provisoriamente|não confirmada/i)).toHaveCount(0);
  await page.goto('/configuracoes/preferencias');
  await expect(page.getByLabel('Contexto dos bots', { exact: true })).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(catalogRequests).toEqual([]);
  // Remove somente a preferência sintética criada aqui; os cenários seguintes mantêm seu estado inicial.
  expect((await page.request.patch(`${ORIGIN}/api/models/favorite`, { headers, data: { model: 'opencode/glm-5.1', favorite: false } })).status()).toBe(200);
});

test('contexto salva presets, preserva falha/retry e reabre herança no editor em desktop/mobile', async ({ page }, testInfo) => {
  await ensureCredential(page, 'provider', 'valid-e2e-context-1111');
  const headers = await apiHeaders(page);
  await page.goto('/configuracoes/preferencias');
  const bots = page.getByLabel('Contexto dos bots', { exact: true });
  const chat = page.getByLabel('Contexto do Chat geral', { exact: true });
  // Padrão do dono: 256k nos dois escopos (migration 0046, decisão de 17/10/2026). Cada escolha abaixo difere da anterior, e o Chat geral termina de volta no padrão.
  await expect(bots).toHaveValue('262144');
  await expect(chat).toHaveValue('262144');
  // As quatro opções renderizadas, na ordem, e nenhuma de 32k (A16, A17).
  for (const select of [bots, chat]) await expect(select.locator('option')).toHaveText(['64k', '128k', '256k', '512k']);
  await expect(bots.locator('option[value="32768"]')).toHaveCount(0);
  for (const value of ['524288', '65536', '131072']) {
    await bots.selectOption(value);
    await expect.poll(async () => (await (await page.request.get(`${ORIGIN}/api/settings/context`, { headers })).json()).bots).toBe(Number(value));
  }
  for (const value of ['131072', '524288', '262144']) {
    await chat.selectOption(value);
    await expect.poll(async () => (await (await page.request.get(`${ORIGIN}/api/settings/context`, { headers })).json()).generalChat).toBe(Number(value));
  }
  // O servidor recusa 32k nos dois escopos e na criação de bot (422, VALIDATION_FAILED), e nada muda: a allowlist vale mesmo para quem não usa a tela.
  for (const scope of ['bots', 'general_chat']) {
    const refused = await page.request.put(`${ORIGIN}/api/settings/context`, { headers, data: { scope, windowTokens: 32768 } });
    expect(refused.status()).toBe(422);
    expect((await refused.json()).code).toBe('VALIDATION_FAILED');
  }
  expect((await page.request.post(`${ORIGIN}/api/bots`, { headers, data: { name: uniqueBotName('Janela 32k'), color: '#60A5FA', contextWindowTokens: 32768 } })).status()).toBe(422);
  expect(await (await page.request.get(`${ORIGIN}/api/settings/context`, { headers })).json()).toMatchObject({ bots: 131072, generalChat: 262144 });
  await page.route('**/api/settings/context', async (route) => {
    if (route.request().method() === 'PUT') { await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'INTERNAL_ERROR', message: 'Não foi possível concluir.' }) }); return; }
    await route.continue();
  });
  await bots.selectOption('131072');
  await expect(page.getByText('Não foi possível salvar.', { exact: false })).toBeVisible();
  await expect(bots).toHaveValue('131072');
  await page.unroute('**/api/settings/context');
  await page.getByRole('button', { name: 'Tentar de novo', exact: true }).click();
  await expect.poll(async () => (await (await page.request.get(`${ORIGIN}/api/settings/context`, { headers })).json()).bots).toBe(131072);
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 360, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, `phase8-t1-preferencias-${viewport.width}`);
  }
  const response = await page.request.post(`${ORIGIN}/api/bots`, { headers, data: { name: uniqueBotName('Contexto Phase8'), color: '#60A5FA', model: 'opencode/glm-5.1', contextWindowTokens: 65536 } });
  expect(response.status()).toBe(201);
  const bot = await response.json();
  await page.goto(`/bots/${bot.id}/editar`);
  await expect(page.getByLabel('Contexto', { exact: true })).toHaveValue('65536');
  // O editor oferece a herança do global e as mesmas quatro opções, sem 32k.
  await expect(page.getByLabel('Contexto', { exact: true }).locator('option')).toHaveText([/^Usar global/, '64k', '128k', '256k', '512k']);
  // Escolha própria do bot (64k) vale integralmente para um modelo sem capacidade confirmada.
  await expect(page.getByText('Limite efetivo: 64k.', { exact: true })).toBeVisible();
  await expect(page.getByText(/provisoriamente|não confirmada/i)).toHaveCount(0);
  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await page.getByLabel('Contexto', { exact: true }).scrollIntoViewIfNeeded();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, `phase8-t1-editor-${width}`);
  }
  await page.getByLabel('Contexto', { exact: true }).selectOption('global');
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await page.waitForURL(`/bots/${bot.id}`);
  await page.goto(`/bots/${bot.id}/editar`);
  await expect(page.getByLabel('Contexto', { exact: true })).toHaveValue('global');
  await expect(page.getByText('Global: 128k.')).toBeVisible();
  await page.goto('/bots/novo');
  await expect(page.getByLabel('Contexto', { exact: true })).toHaveValue('global');
});

test('capacidade conhecida/menor e troca do modelo preservam a preferência no formulário', async ({ page }, testInfo) => {
  await ensureCredential(page, 'provider', 'valid-e2e-context-1111');
  const headers = await apiHeaders(page);
  const created = await page.request.post(`${ORIGIN}/api/bots`, { headers, data: { name: uniqueBotName('Limite Phase8'), color: '#60A5FA', contextWindowTokens: 131072 } });
  expect(created.status()).toBe(201);
  const bot = await created.json();
  // Metadado sintético da borda só para estados renderizados; não altera o catálogo, banco ou prova real.
  let contextTokens = 1000000;
  await page.route(`**/api/bots/${bot.id}`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, contextModel: { model: 'opencode/deepseek-v4.1-flash', fromConversation: true,
      capacity: { provider: 'opencode_go', model: 'opencode/deepseek-v4.1-flash', contextTokens, outputTokens: 8192, source: 'https://example.test/capacidade-sintetica', checkedAt: '2026-10-12T00:00:00.000Z' } } } });
  });
  await page.goto(`/bots/${bot.id}/editar`);
  await expect(page.getByText('Limite efetivo: 128k.')).toBeVisible();
  await expect(page.getByLabel('Contexto', { exact: true })).toHaveValue('131072');
  contextTokens = 16000;
  await page.reload();
  await expect(page.getByText('Limite efetivo: 16.000.')).toBeVisible();
  await expect(page.getByLabel('Contexto', { exact: true })).toHaveValue('131072');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Contexto', { exact: true }).scrollIntoViewIfNeeded();
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'phase8-t1-modelo-limitado-sintetico-390');
  await page.unroute(`**/api/bots/${bot.id}`);
  await page.reload();
  await expect(page.getByText('Escolha um modelo para calcular o limite efetivo.')).toBeVisible();
  await expect(page.getByLabel('Contexto', { exact: true })).toHaveValue('131072');
});

test('objetivo tem convite único, atualiza e desfaz em duas sessões sem cadastro obrigatório', async ({ page, browser }, testInfo) => {
  await ensureCredential(page, 'provider', 'valid-e2e-context-1111');
  const headers = await apiHeaders(page);
  const created = await page.request.post(`${ORIGIN}/api/bots`, { headers, data: { name: uniqueBotName('Objetivo Phase8'), color: '#60A5FA', model: 'opencode/glm-5.1' } });
  const bot = await created.json();
  await page.goto(`/bots/${bot.id}`);
  await expect(page.getByText('Qual é meu objetivo? Você pode me contar agora ou começar com um pedido.')).toBeVisible();
  await expect.poll(async () => (await (await page.request.get(`${ORIGIN}/api/bots/${bot.id}/objective`, { headers })).json()).invitationPresented).toBe(true);
  const otherContext = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 390, height: 844 } });
  try {
    await apiLogin(otherContext);
    const other = await otherContext.newPage();
    await other.goto(`/bots/${bot.id}`);
    await expect(other.getByText('Qual é meu objetivo? Você pode me contar agora ou começar com um pedido.')).toHaveCount(0);
    await page.getByRole('button', { name: 'Dispensar', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Mensagem', exact: true })).toBeEnabled();
    await page.getByRole('textbox', { name: 'Mensagem', exact: true }).fill('[objetivo:Manter o acompanhamento contínuo dos registros sintéticos.]');
    await page.getByRole('textbox', { name: 'Mensagem', exact: true }).press('Enter');
    await expect(page.getByText('Objetivo atualizado', { exact: true })).toBeVisible();
    await expect(other.getByText('Objetivo atualizado', { exact: true })).toBeVisible();
    // O cartão traz o objetivo inteiro direto (sem "Ver objetivo completo") e o topo da conversa não tem mais o disclosure "Objetivo".
    await expect(page.getByRole('region', { name: 'Objetivo atualizado', exact: true }).getByText('Manter o acompanhamento contínuo dos registros sintéticos.', { exact: true })).toBeVisible();
    await expect(page.getByText('Ver objetivo completo')).toHaveCount(0);
    await expect(page.locator('details > summary', { hasText: 'Objetivo' })).toHaveCount(0);
    await page.setViewportSize({ width: 360, height: 844 });
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'phase8-t2-objetivo-cartao-360');
    await page.getByRole('button', { name: 'Desfazer', exact: true }).click();
    await expect(page.getByText('Alteração desfeita', { exact: true })).toBeVisible();
    await expect(other.getByText('Alteração desfeita', { exact: true })).toBeVisible();
    await expect.poll(async () => (await (await page.request.get(`${ORIGIN}/api/bots/${bot.id}/objective`, { headers })).json()).version).toBe(2);
    await page.reload();
    await expect(page.getByText('Qual é meu objetivo? Você pode me contar agora ou começar com um pedido.')).toHaveCount(0);
  } finally { await otherContext.close(); }
});

test('objetivo inferido antes da abertura e texto extenso ficam legíveis no editor e na conversa', async ({ page }, testInfo) => {
  await ensureCredential(page, 'provider', 'valid-e2e-context-1111');
  const headers = await apiHeaders(page);
  const response = await page.request.post(`${ORIGIN}/api/bots`, { headers, data: { name: uniqueBotName('Objetivo extenso Phase8'), color: '#60A5FA', model: 'opencode/glm-5.1' } });
  const bot = await response.json();
  const content = 'Manter dados sintéticos íntegros e revisar a direção conforme pedidos do dono. '.repeat(20).trim();
  expect((await page.request.post(`${ORIGIN}/api/bots/${bot.id}/messages`, { headers, data: { content: `[objetivo:${content}]` } })).status()).toBe(201);
  await expect.poll(async () => (await (await page.request.get(`${ORIGIN}/api/bots/${bot.id}/objective`, { headers })).json()).content, { timeout: 30000 }).toBe(content);
  await page.goto(`/bots/${bot.id}`);
  await expect(page.getByText('Qual é meu objetivo? Você pode me contar agora ou começar com um pedido.')).toHaveCount(0);
  // Conversa: o cartão mostra o texto extenso por inteiro (sem line-clamp: o conteúdo não transborda o próprio elemento) e o cabeçalho não o repete.
  const card = page.getByRole('region', { name: 'Objetivo atualizado', exact: true });
  const cardText = card.getByText(content, { exact: true });
  await expect(cardText).toBeVisible();
  expect(await cardText.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
  await expect(page.getByText('Ver objetivo completo')).toHaveCount(0);
  await expect(page.locator('details > summary', { hasText: 'Objetivo' })).toHaveCount(0);
  await page.goto(`/bots/${bot.id}/editar`);
  await expect(page.getByRole('heading', { name: 'Objetivo', exact: true })).toBeVisible();
  await expect(page.getByText(content, { exact: true })).toBeVisible();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await page.getByRole('heading', { name: 'Objetivo', exact: true }).scrollIntoViewIfNeeded();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, `phase8-t2-editor-objetivo-extenso-${width}`);
  }
});

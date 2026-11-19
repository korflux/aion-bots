// Rolagem única da conversa (phase 9, T13): com a conversa maior que a tela, só o log ("Conversa") rola; o <main> do shell não ganha uma segunda barra
// de rolagem. Vale para o bot e para o Chat geral, que usam o mesmo `Thread`. A regressão vinha dos elementos absolutos das mensagens (os `sr-only` das
// ações) escapando do recorte do log (ver `thread.tsx`).
import type { Page, TestInfo } from '@playwright/test';
import { apiHeaders, ensureCredential, expect, ORIGIN, test, uniqueBotName } from './support/fixtures';

/**
 * Enche a conversa aberta em `path` com mensagens longas (cada resposta traz as ações com os `sr-only`) e confere, no desktop e no celular, que o log rola
 * e que o <main> e o documento não. `name` separa as capturas de tela de cada conversa.
 */
async function expectSingleScroll(page: Page, info: TestInfo, path: string, name: string): Promise<void> {
  await page.goto(path);
  const field = page.getByRole('textbox', { name: 'Mensagem', exact: true });
  const log = page.getByRole('log', { name: 'Conversa' });
  for (let index = 0; index < 4; index++) {
    await field.fill(`Mensagem longa ${index} `.repeat(40)); await field.press('Enter');
    // Espera a resposta desta mensagem antes da próxima: a conversa fica com pares mensagem e resposta, sem fila.
    await expect(log.getByRole('button', { name: 'Copiar' })).toHaveCount((index + 1) * 2, { timeout: 30_000 });
  }
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(path);
    await expect(log.getByRole('button', { name: 'Copiar' }).first()).toBeVisible();
    const sizes = await page.evaluate(() => {
      const main = document.querySelector('main')!; const thread = document.querySelector('[role="log"]')!;
      return { mainScroll: main.scrollHeight, mainClient: main.clientHeight, logScroll: thread.scrollHeight, logClient: thread.clientHeight, docScroll: document.documentElement.scrollHeight, docClient: document.documentElement.clientHeight };
    });
    const label = `${name} ${width}px: ${JSON.stringify(sizes)}`;
    // O log rola (a conversa é maior que ele); o <main> e o documento não.
    expect(sizes.logScroll, label).toBeGreaterThan(sizes.logClient);
    expect(sizes.mainScroll, label).toBeLessThanOrEqual(sizes.mainClient);
    expect(sizes.docScroll, label).toBeLessThanOrEqual(sizes.docClient);
    // Evidência visual: a barra única fica no log, ao lado das mensagens.
    await page.screenshot({ path: info.outputPath(`${name}-${width}.png`) });
  }
}

test('conversa longa do bot rola só no log, sem rolagem no <main>, no desktop e no celular', async ({ page }, info) => {
  test.setTimeout(120_000);
  await ensureCredential(page, 'provider', 'valid-e2e-scroll-1111');
  const headers = await apiHeaders(page);
  const created = await page.context().request.post(`${ORIGIN}/api/bots`, { headers, data: { name: uniqueBotName('Rolagem'), color: '#60A5FA', instructions: '', model: 'opencode/deepseek-v4.1-flash', effort: null, stepLimit: 25 } });
  expect(created.status(), await created.text()).toBe(201);
  const { id } = await created.json();
  await expectSingleScroll(page, info, `/bots/${id}`, 'bot');
});

test('conversa longa do Chat geral rola só no log, sem rolagem no <main>, no desktop e no celular', async ({ page }, info) => {
  test.setTimeout(120_000);
  await ensureCredential(page, 'provider', 'valid-e2e-scroll-1111');
  const headers = await apiHeaders(page); const request = page.context().request;
  const created = await request.post(`${ORIGIN}/api/chat/sessions`, { headers });
  expect(created.status(), await created.text()).toBe(201);
  const { id } = await created.json();
  // Modelo da própria sessão: o teste não depende do padrão do Chat geral configurado por outros specs.
  expect((await request.patch(`${ORIGIN}/api/chat/sessions/${id}/conversation`, { headers, data: { model: 'opencode/deepseek-v4.1-flash', effort: null } })).status()).toBe(200);
  await expectSingleScroll(page, info, `/chat/${id}`, 'chat');
});

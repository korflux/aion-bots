// E2E do Python na tela (phase 4, T8; F8, F10 e F11, A20 e A21) no navegador real, contra a pilha de produção com o OpenCode Go e o sandbox do
// Python FALSOS (`tests/support/e2e-sandbox.ts`): o marcador `[python:...]` faz o modelo falso chamar `run_python` com o código escolhido, e o código
// escolhe o cenário do sandbox (gráfico PNG e CSV, ou tempo esgotado).
//
// Jornadas: (1) resposta com gráfico e CSV: prévia inline, lightbox com volta do foco, download do CSV conferido byte a byte, atividade expandida
// com código, saída e arquivos, e a falha por tempo; (2) Configurações → Arquivos com a origem "Gerado pelo Python", o PNG no filtro Imagens e
// "Baixar" no menu; (3) Configurações → Python nos três estados. "Disponível" e "Indisponível agora" são reais (o controle da pilha troca a saúde
// do sandbox falso); "Não instalado" exige a API SEM a configuração do sandbox, e subir uma segunda pilha só para isso custaria minutos, então a
// resposta da rota é trocada no navegador pelo contrato real (`{ status: 'not_installed' }`): a rota em si, sem configuração, é provada em
// `apps/api/src/python.routes.test.ts`. Em cada estado: axe, sem rolagem horizontal e capturas em 1440 e 375 px.
//
// Serial e no projeto `chromium-python` (depois de Arquivos, antes do TOTP): cria arquivos que Arquivos lista e muda a saúde do sandbox da pilha.
import { readFile } from 'node:fs/promises';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { pythonMarker } from '../../../packages/core/src/testing/fake-upstreams';
import { E2E_CHART_CODE, E2E_CHART_CSV, E2E_PORTS, E2E_TIMEOUT_CODE } from '../../../tests/support/e2e-env';
import { ORIGIN, apiHeaders, attachShot, ensureCredential, expect, expectNoA11yViolations, expectNoHorizontalScroll, test, uniqueBotName, watchPage, openWorkLine } from './support/fixtures';

test.describe.configure({ mode: 'serial' });

const BOT = 'Analista Python';
/** Bot criado no primeiro teste e lido no segundo (Arquivos filtra pela origem dele). */
let botId = '';

/** Em 1440 e 375 px: sem rolagem horizontal, axe sem violações e a captura com o nome do estado; `focus` é rolado à vista em cada largura. */
async function evidence(page: Page, info: TestInfo, state: string, focus?: Locator): Promise<void> {
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    await focus?.scrollIntoViewIfNeeded();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, info, `python-${state}-${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

/** Troca a saúde do sandbox falso da pilha (200 disponível, 503 indisponível). */
async function sandboxHealth(status: 200 | 503): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${E2E_PORTS.control}/sandbox-health?status=${status}`, { method: 'POST' });
  expect(response.status, 'trocar a saúde do sandbox').toBe(200);
}

test('resposta com gráfico e CSV: prévia, lightbox, download, atividade expandida e falha por tempo', async ({ page }, info) => {
  test.setTimeout(180_000);
  const problems = watchPage(page);
  await ensureCredential(page, 'provider', 'valid-e2e-python-1111');
  const headers = await apiHeaders(page);
  const request = page.context().request;
  const created = await request.post(`${ORIGIN}/api/bots`, { headers, data: { name: uniqueBotName(BOT), color: '#60A5FA', instructions: '', model: 'opencode/vision-model', effort: null, stepLimit: 25 } });
  expect(created.status()).toBe(201);
  botId = ((await created.json()) as { id: string }).id;

  /** Envia pela API e espera a execução terminar (a conversa sem execução aberta). */
  async function say(content: string): Promise<void> {
    const sent = await request.post(`${ORIGIN}/api/bots/${botId}/messages`, { headers, data: { content } });
    expect(sent.status(), await sent.text()).toBe(201);
    await expect
      .poll(async () => ((await (await request.get(`${ORIGIN}/api/bots/${botId}/conversation`, { headers })).json()) as { runs: unknown[] }).runs.length, { timeout: 60_000 })
      .toBe(0);
  }
  await say(`Gere o gráfico de vendas ${pythonMarker({ code: E2E_CHART_CODE })}`);

  await page.goto(`/bots/${botId}`);
  const log = page.getByRole('log', { name: 'Conversa' });
  // Prévia grande do PNG sob a resposta, carregada da rota privada da mesma origem (a CSP aceita), com o tamanho real do gráfico.
  const preview = log.getByRole('button', { name: 'Abrir imagem grafico.png' });
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.getByRole('img', { name: 'grafico.png' }).evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(480);
  expect((await preview.boundingBox())!.width).toBeGreaterThan(300);
  // O CSV vira chip de download do original, com tipo e tamanho; o arquivo baixado é o que o Python gravou.
  const csv = log.getByRole('link', { name: 'Baixar dados.csv' });
  await expect(csv).toContainText('CSV · 1 KB');
  const downloading = page.waitForEvent('download');
  await csv.click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('dados.csv');
  expect(await readFile(await download.path(), 'utf8')).toBe(E2E_CHART_CSV);
  await evidence(page, info, 'resposta');

  // Lightbox: o mesmo visualizador das imagens anexadas; Esc devolve o foco à prévia.
  await preview.click();
  const dialog = page.getByRole('dialog', { name: 'grafico.png' });
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.getByRole('img', { name: 'grafico.png' }).evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(480);
  await evidence(page, info, 'lightbox');
  await page.keyboard.press('Escape');
  await expect(preview).toBeFocused();

  // Atividade: rótulo com a duração e, expandida, o código no bloco de código (com Copiar), a saída e os arquivos gerados.
  const activity = log.getByRole('button', { name: 'Python executado (1,2 s)' });
  await openWorkLine(log, activity);
  await activity.click();
  await expect(activity).toHaveAttribute('aria-expanded', 'true');
  const details = page.locator(`[id="${await activity.getAttribute('aria-controls')}"]`);
  await expect(details.locator('[data-code-block="code"]')).toContainText("plt.savefig('grafico.png')");
  await expect(details.getByRole('button', { name: 'Copiar' })).toBeVisible();
  await expect(details.getByText('Saída', { exact: true })).toBeVisible();
  await expect(details.getByText('Total: 105', { exact: true })).toBeVisible();
  await expect(details.getByRole('listitem').filter({ hasText: 'grafico.png' })).toBeVisible();
  await expect(details.getByRole('listitem').filter({ hasText: 'dados.csv' })).toContainText('1 KB');
  await evidence(page, info, 'atividade', details.getByText('Arquivos gerados', { exact: true }));

  // Falha por tempo: o rótulo "Python falhou" e, expandida, a frase do tempo esgotado no bloco de erro; nenhum arquivo sob a resposta.
  await say(`Rode o laço ${pythonMarker({ code: E2E_TIMEOUT_CODE })}`);
  const failed = log.getByRole('button', { name: 'Python falhou' });
  await openWorkLine(log, failed);
  await expect(failed).toBeVisible();
  await failed.click();
  const failure = page.locator(`[id="${await failed.getAttribute('aria-controls')}"]`);
  await expect(failure.getByText('Erro', { exact: true })).toHaveCSS('color', 'rgb(248, 113, 113)'); // --danger
  await expect(failure.getByText('Tempo esgotado (60 s).', { exact: true })).toBeVisible();
  await expect(log.locator('[data-generated-files]')).toHaveCount(1);
  await evidence(page, info, 'falha-tempo', failure.getByText('Tempo esgotado (60 s).', { exact: true }));
  expect(problems).toEqual([]);
});

test('Arquivos: origem "Gerado pelo Python", PNG nas imagens e Baixar no menu', async ({ page }, info) => {
  test.setTimeout(120_000);
  expect(botId, 'o teste anterior cria o bot').not.toBe('');
  const problems = watchPage(page);
  await apiHeaders(page);
  await page.goto('/configuracoes/arquivos');
  await expect(page.getByRole('heading', { name: 'Arquivos', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Origem' }).selectOption(botId);
  const list = page.getByRole('list', { name: 'Arquivos anexados' });
  const chart = list.locator(':scope > li').filter({ hasText: 'grafico.png' });
  const data = list.locator(':scope > li').filter({ hasText: 'dados.csv' });
  await expect(chart).toContainText(`Gerado pelo Python · ${uniqueBotName(BOT)}`);
  await expect(chart).toContainText('Imagem ·');
  await expect(data).toContainText(`Gerado pelo Python · ${uniqueBotName(BOT)}`);
  await expect(data).toContainText('Documento ·');
  await evidence(page, info, 'arquivos');

  // O PNG gerado conta como imagem no filtro Tipo e abre no visualizador.
  await page.getByRole('radio', { name: 'Imagens', exact: true }).click();
  await expect(list.locator(':scope > li')).toHaveCount(1);
  await expect(chart).toBeVisible();
  // "Baixar" no menu do arquivo gerado baixa o original.
  await page.getByRole('radio', { name: 'Documentos', exact: true }).click();
  await page.getByRole('button', { name: 'Mais ações de dados.csv' }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Baixar', exact: true }).click();
  const download = await downloading;
  expect(await readFile(await download.path(), 'utf8')).toBe(E2E_CHART_CSV);
  expect(problems).toEqual([]);
});

test('Configurações → Python: disponível, indisponível agora (com Verificar de novo) e não instalado', async ({ page }, info) => {
  test.setTimeout(120_000);
  const problems = watchPage(page);
  await apiHeaders(page);
  try {
    await page.goto('/configuracoes/conta-e-seguranca');
    // O Python não tem mais item próprio na navegação: é o ÚLTIMO cartão da área Conexões (phase 5, T4), depois da pesquisa na web.
    const nav = page.getByRole('complementary');
    expect(await nav.getByRole('link').allTextContents()).not.toContain('Python');
    await nav.getByRole('link', { name: 'Conexões', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Conexões', level: 1 })).toBeVisible();
    const card = page.getByRole('region', { name: 'Execução de Python' });
    await expect(card.getByText('Disponível', { exact: true })).toBeVisible();
    const cards = await page.locator('#conteudo section[aria-labelledby]').evaluateAll((sections) => sections.map((section) => section.getAttribute('aria-labelledby') ?? ''));
    expect(cards.at(-1), 'o cartão do Python vem por último').toBe(await card.getAttribute('aria-labelledby'));
    // A rota antiga de Python redireciona para Conexões.
    await page.goto('/configuracoes/python');
    await expect(page).toHaveURL(/\/configuracoes\/conexoes$/);
    await expect(card.getByText('Disponível', { exact: true })).toBeVisible();
    await expect(card).toContainText('sem acesso à internet');
    await evidence(page, info, 'config-disponivel');

    await sandboxHealth(503);
    await page.reload();
    await expect(card.getByText('Indisponível agora', { exact: true })).toBeVisible();
    await evidence(page, info, 'config-indisponivel');
    await sandboxHealth(200);
    await card.getByRole('button', { name: 'Verificar de novo' }).click();
    await expect(card.getByText('Disponível', { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Verificar de novo' })).toHaveCount(0);

    // Sem a configuração do sandbox na API (ver o cabeçalho): a resposta do contrato real, trocada só no navegador.
    await page.route('**/api/settings/python', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'not_installed' }) }));
    await page.reload();
    await expect(card.getByText('Não instalado', { exact: true })).toBeVisible();
    await expect(card).toContainText('Os bots funcionam normalmente sem Python.');
    await evidence(page, info, 'config-nao-instalado');
  } finally {
    await sandboxHealth(200);
  }
  expect(problems).toEqual([]);
});

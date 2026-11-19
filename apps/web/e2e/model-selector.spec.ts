// E2E de A10 (F8) no navegador real, contra a pilha de produção (Postgres, API, Next e proxy) com o OpenCode Go
// FALSO (14 modelos, cada um com um comportamento; ver packages/core/src/testing/fake-upstreams.ts): primeira seleção
// com teste e carregamento, segunda seleção sem teste, effort só com os níveis aceitos, favoritos no topo, falha e
// "sem ferramentas" selecionáveis com aviso, "testar novamente", erro de API sem aplicar o modelo, teclado, e o
// drawer em 375 px. Tudo termina salvo no bot e relido no editor.
//
// O estado (chave do provedor, favoritos e resultados de teste) é global (dono único), então o arquivo é serial e roda
// no projeto `chromium-models`, depois do de bots (ver playwright.config.ts). O limite é de 10 testes por minuto na API:
// o arquivo inteiro faz 6 testes reais (o erro de limite do último teste é simulado no navegador). Os resultados de teste
// persistem no banco da pilha: rodar de novo contra a MESMA pilha (reuseExistingServer) exige uma pilha nova.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { ORIGIN, apiHeaders, expect, expectNoA11yViolations, expectNoHorizontalScroll, ensureCredential, setProvider, test, uniqueBotName, watchPage } from './support/fixtures';

test.describe.configure({ mode: 'serial' });

const PROVIDER_KEY = 'valid-e2e-models-1111';

/** Anexa a captura ao relatório e, com `AION_E2E_SHOTS_DIR`, também grava o PNG nessa pasta. */
async function attachShot(page: Page, testInfo: TestInfo, name: string) {
  const body = await page.screenshot();
  await testInfo.attach(name, { body, contentType: 'image/png' });
  const dir = process.env.AION_E2E_SHOTS_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}.png`), body);
  }
}

/** Corpos dos POST /api/models/test enviados pelo navegador (um por teste de verdade). */
function watchTests(page: Page) {
  const sent: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/models/test') sent.push(request.postData() ?? '');
  });
  return sent;
}

const modelButton = (page: Page) => page.getByRole('button', { name: /^Modelo padrão/ });
const picker = (page: Page) => page.getByRole('dialog', { name: 'Selecionar modelo' });
/** O grupo do OpenCode Go (phase 17: a lista "Todos os modelos" virou um grupo recolhível por provedor). */
const allModels = (page: Page) => picker(page).getByRole('list', { name: 'Modelos do OpenCode Go' });
const favoriteModels = (page: Page) => picker(page).getByRole('list', { name: 'Favoritos' });
/** Botão de escolher de uma linha (o nome inclui o selo: "glm-5.1 Liberado"). */
const rowOf = (list: Locator, id: string) => list.getByRole('button', { name: new RegExp(`^${id.replace('.', '\\.')}( |$)`) });
const toast = (page: Page, text: string) => page.getByText(text, { exact: true }).first();

async function openPicker(page: Page) {
  await modelButton(page).click();
  await expect(picker(page)).toBeVisible();
  await expect(allModels(page)).toBeVisible(); // a lista saiu do esqueleto
}

/** As etapas do glm-5.1 no provedor falso: "Padrão" e os três níveis que ele aceita (a barra tem uma etapa por item, nesta ordem). */
const EFFORT_STEPS = ['Padrão', 'Baixo', 'Médio', 'Alto'];

/** A barra de effort (T18): `<input type="range">` com o nome da etapa em `aria-valuetext`. */
const effortSlider = (page: Page) => picker(page).getByRole('slider', { name: 'Effort' });

/** Vai até a etapa pelo teclado, como o dono faria (Home volta a "Padrão"; cada seta anda uma etapa), e confere o nome em cima da barra. */
async function pickEffort(page: Page, label: string, steps: string[]) {
  const slider = effortSlider(page);
  await slider.focus();
  await page.keyboard.press('Home');
  for (let step = 0; step < steps.indexOf(label); step += 1) await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuetext', label);
  await expect(picker(page).getByText(label, { exact: true }).first()).toBeVisible();
}

test.describe('seletor de modelo no desktop (1440 × 900)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  let botId = '';

  test('primeira seleção testa com carregamento; a segunda não; effort só com os níveis aceitos; favoritos no topo; salva no bot', async ({ page }, testInfo) => {
    const problems = watchPage(page);
    const tests = watchTests(page);
    await ensureCredential(page, 'provider', PROVIDER_KEY);

    await page.goto('/bots/novo');
    await expect(modelButton(page)).toBeEnabled();
    await expect(modelButton(page)).toHaveAccessibleName('Modelo padrão Sem modelo padrão');

    // Abre: busca com foco, lista completa e nenhum favorito ainda.
    await openPicker(page);
    await expect(picker(page).getByRole('searchbox', { name: 'Buscar modelo' })).toBeFocused();
    await expect(picker(page).getByRole('heading', { name: 'Favoritos' })).toHaveCount(0);
    await expect(allModels(page).getByRole('listitem')).toHaveCount(14);
    await expect(allModels(page).getByText('Liberado')).toHaveCount(0); // nenhum testado ainda
    await expect(picker(page).getByRole('radio')).toHaveCount(0); // sem modelo, sem effort
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'seletor-1440-lista');

    // Busca: filtra por trecho do id e mostra o vazio.
    const search = picker(page).getByRole('searchbox', { name: 'Buscar modelo' });
    await search.fill('glm');
    await expect(picker(page).getByRole('list', { name: 'Resultados' }).getByRole('listitem')).toHaveCount(2);
    await search.fill('zzz');
    await expect(picker(page).getByText('Nenhum modelo encontrado')).toBeVisible();
    await search.fill('');
    await expect(allModels(page).getByRole('listitem')).toHaveCount(14);

    // Primeira seleção: o teste demora (resposta atrasada para o estado ser observável), a linha mostra o carregamento
    // e as outras ficam bloqueadas; ao terminar aparece o toast, o selo e o modelo é aplicado.
    await page.route('**/api/models/test', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.continue();
    });
    await rowOf(allModels(page), 'glm-5.1').click();
    await expect(picker(page).getByRole('status').filter({ hasText: 'Testando modelo…' })).toBeVisible();
    await expect(rowOf(allModels(page), 'glm-5.1')).toHaveAttribute('aria-busy', 'true');
    await expect(rowOf(allModels(page), 'kimi-k2.7-code')).toBeDisabled();
    await attachShot(page, testInfo, 'seletor-1440-testando');
    await expect(toast(page, 'Modelo liberado')).toBeVisible();
    await page.unroute('**/api/models/test');
    await expect(rowOf(allModels(page), 'glm-5.1')).toContainText('Liberado');
    await expect(rowOf(allModels(page), 'glm-5.1')).toHaveAttribute('aria-current', 'true');
    await expect(modelButton(page)).toHaveAccessibleName('Modelo padrão opencode/glm-5.1');
    expect(tests).toHaveLength(1);
    expect(JSON.parse(tests[0] as string)).toEqual({ model: 'opencode/glm-5.1' });

    // Effort: só "Padrão" e os níveis que o provedor aceitou neste modelo (Baixo, Médio e Alto; não Extra alto nem Máximo).
    // Uma barra com 4 etapas (0 a 3), não uma fileira de botões: o nome da etapa aparece em cima.
    const slider = effortSlider(page);
    await expect(slider).toHaveCount(1);
    await expect(slider).toHaveAttribute('min', '0');
    await expect(slider).toHaveAttribute('max', '3');
    await expect(slider).toHaveAttribute('aria-valuetext', 'Padrão');
    await expect(picker(page).getByText('Máximo', { exact: true })).toHaveCount(0);
    await expect(picker(page).getByRole('radio')).toHaveCount(0);
    await pickEffort(page, 'Alto', EFFORT_STEPS);
    // O arraste com o ponteiro também escolhe: soltar na ponta esquerda volta a "Padrão".
    const box = await slider.boundingBox();
    await page.mouse.click((box?.x ?? 0) + 4, (box?.y ?? 0) + (box?.height ?? 0) / 2);
    await expect(slider).toHaveAttribute('aria-valuetext', 'Padrão');
    await pickEffort(page, 'Alto', EFFORT_STEPS);
    await attachShot(page, testInfo, 'seletor-1440-effort');
    await expect(modelButton(page)).toHaveAccessibleName('Modelo padrão opencode/glm-5.1 · Alto');
    await expectNoA11yViolations(page);

    // Segunda seleção: limpar o modelo e escolher o glm-5.1 de novo NÃO chama o servidor. O effort volta a "Padrão".
    await picker(page).getByRole('list', { name: 'Sem modelo' }).getByRole('button', { name: /Sem modelo padrão/ }).click();
    await expect(modelButton(page)).toHaveAccessibleName('Modelo padrão Sem modelo padrão');
    await expect(effortSlider(page)).toHaveCount(0);
    await rowOf(allModels(page), 'glm-5.1').click();
    await expect(modelButton(page)).toHaveAccessibleName('Modelo padrão opencode/glm-5.1');
    await expect(effortSlider(page)).toHaveAttribute('aria-valuetext', 'Padrão');
    expect(tests).toHaveLength(1);

    // Favoritos no topo, na ordem em que foram marcados; a lista completa continua com todos.
    await allModels(page).getByRole('button', { name: 'Favoritar glm-5.1' }).click();
    await expect(allModels(page).getByRole('button', { name: 'Favoritar glm-5.1' })).toHaveAttribute('aria-pressed', 'true');
    await expect(picker(page).getByRole('heading', { name: 'Favoritos' })).toBeVisible();
    await allModels(page).getByRole('button', { name: 'Favoritar grok-4.7' }).click();
    await expect(favoriteModels(page).getByRole('listitem')).toHaveCount(2);
    await expect(favoriteModels(page).getByRole('button', { name: /^(opencode\/glm-5\.1|opencode\/grok-4\.7)/ })).toHaveText([/^opencode\/glm-5\.1/, /^opencode\/grok-4\.7/]);
    const favoritesBox = await picker(page).getByRole('heading', { name: 'Favoritos' }).boundingBox();
    const allBox = await picker(page).getByRole('heading', { name: /^OpenCode Go/ }).boundingBox();
    expect((favoritesBox?.y ?? Infinity) < (allBox?.y ?? 0)).toBe(true);
    await expect(allModels(page).getByRole('listitem')).toHaveCount(14);
    await attachShot(page, testInfo, 'seletor-1440-favoritos');

    // Falha e "sem ferramentas" são selecionáveis: o modelo é aplicado e a linha avisa.
    await rowOf(allModels(page), 'broken-model').click();
    await expect(rowOf(allModels(page), 'broken-model')).toContainText('Falhou');
    await expect(allModels(page).getByText('Falhou: O provedor não aceitou este modelo em nenhum formato conhecido.')).toBeVisible();
    await expect(modelButton(page)).toHaveAccessibleName('Modelo padrão opencode/broken-model');
    await expect(picker(page).getByRole('radio')).toHaveCount(0);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'seletor-1440-falhou');
    await rowOf(allModels(page), 'deepseek-v4-pro').click();
    await expect(toast(page, 'Modelo sem suporte a ferramentas')).toBeVisible();
    await expect(rowOf(allModels(page), 'deepseek-v4-pro')).toContainText('Sem ferramentas');
    await expect(allModels(page).getByText('O modelo não chamou a ferramenta de teste.')).toBeVisible();
    await expect(modelButton(page)).toHaveAccessibleName('Modelo padrão opencode/deepseek-v4-pro');
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'seletor-1440-sem-ferramentas');
    expect(tests).toHaveLength(3);

    // "Testar novamente" (menu da linha) repete o teste sem mudar o modelo escolhido.
    await favoriteModels(page).getByRole('button', { name: 'Mais ações de glm-5.1' }).click();
    await page.getByRole('menuitem', { name: 'Testar novamente' }).click();
    await expect.poll(() => tests.length).toBe(4);
    expect(JSON.parse(tests[3] as string)).toEqual({ model: 'opencode/glm-5.1' });
    await expect(rowOf(favoriteModels(page), 'opencode/glm-5.1')).toContainText('Liberado');
    await expect(modelButton(page)).toHaveAccessibleName('Modelo padrão opencode/deepseek-v4-pro');

    // Teclado: Esc fecha e devolve o foco ao botão; ao reabrir a busca tem o foco, seta desce para a primeira linha e
    // Enter escolhe o modelo (já testado, sem novo teste).
    await page.keyboard.press('Escape');
    await expect(picker(page)).toBeHidden();
    await expect(modelButton(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(picker(page)).toBeVisible();
    await expect(picker(page).getByRole('searchbox', { name: 'Buscar modelo' })).toBeFocused();
    await page.keyboard.type('glm-5.1');
    await page.keyboard.press('ArrowDown');
    await expect(picker(page).getByRole('list', { name: 'Resultados' }).getByRole('button', { name: /^glm-5\.1/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(modelButton(page)).toHaveAccessibleName('Modelo padrão opencode/glm-5.1');
    expect(tests).toHaveLength(4);
    await pickEffort(page, 'Médio', EFFORT_STEPS);
    await page.keyboard.press('Escape');
    await expect(modelButton(page)).toHaveAccessibleName('Modelo padrão opencode/glm-5.1 · Médio');

    // Salvar: o bot guarda modelo e effort, e o editor os mostra de volta.
    await page.getByLabel('Nome', { exact: true }).fill('Com modelo');
    await page.getByRole('button', { name: 'Salvar' }).click();
    await expect(page).toHaveURL(/\/bots\/[0-9a-f-]{36}$/);
    botId = page.url().split('/').pop() ?? '';
    const saved = await page.evaluate((id) => fetch(`/api/bots/${id}`).then((response) => response.json()), botId);
    expect(saved).toMatchObject({ model: 'opencode/glm-5.1', effort: 'medium' });
    await page.goto(`/bots/${botId}/editar`);
    await expect(modelButton(page)).toHaveAccessibleName('Modelo padrão opencode/glm-5.1 · Médio');
    expect(problems).toEqual([]);
  });

  test('erro de API no teste não aplica o modelo e a linha avisa; tentar de novo funciona', async ({ page }, testInfo) => {
    const problems = watchPage(page);
    const tests = watchTests(page);
    await ensureCredential(page, 'provider', PROVIDER_KEY);
    await page.goto('/bots/novo');
    await openPicker(page);

    // Limite de testes simulado no navegador (o real já foi provado na API): nada é aplicado.
    await page.route('**/api/models/test', (route) =>
      route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ code: 'RATE_LIMITED', message: 'Muitas solicitações. Aguarde um instante e tente novamente.' }) }),
    );
    await rowOf(allModels(page), 'mute-model').click();
    await expect(allModels(page).getByRole('alert')).toHaveText('Muitas solicitações. Aguarde um instante e tente novamente.');
    await expect(modelButton(page)).toHaveAccessibleName('Modelo padrão Sem modelo padrão');
    await expect(rowOf(allModels(page), 'mute-model')).not.toContainText('Falhou');
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'seletor-1440-erro-api');
    await page.unroute('**/api/models/test');

    // De novo, agora de verdade: o modelo mudo falha por resposta vazia, é aplicado com aviso e o erro anterior some.
    await rowOf(allModels(page), 'mute-model').click();
    await expect(allModels(page).getByText('Falhou: O modelo respondeu sem texto.')).toBeVisible();
    await expect(allModels(page).getByRole('alert')).toHaveCount(0);
    await expect(modelButton(page)).toHaveAccessibleName('Modelo padrão opencode/mute-model');
    expect(tests).toHaveLength(2); // o navegador enviou duas: a recusa simulada (429) e a de verdade
    expect(problems).toEqual(['429 POST /api/models/test']);
  });
});

test.describe('seletor de modelo no mobile (375 × 812)', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('drawer de 70 dvh com busca no topo e effort na base; erro da lista com "Tentar novamente"; sem rolagem horizontal', async ({ page }, testInfo) => {
    const problems = watchPage(page);
    const tests = watchTests(page);
    await ensureCredential(page, 'provider', PROVIDER_KEY);
    await page.goto('/bots/novo');
    await expectNoHorizontalScroll(page);

    // Erro ao carregar a lista (provedor indisponível): mensagem e saída "Tentar novamente".
    await page.route('**/api/models', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'PROVIDER_UNAVAILABLE', message: 'Provedor indisponível. Tente novamente.' }) })
        : route.continue(),
    );
    await modelButton(page).click();
    await expect(picker(page)).toBeVisible();
    await expect(picker(page).getByRole('alert')).toHaveText('Provedor indisponível. Tente novamente.');
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'seletor-375-erro');
    await page.unroute('**/api/models');
    await picker(page).getByRole('button', { name: 'Tentar novamente' }).click();
    await expect(allModels(page)).toBeVisible();

    // Drawer inferior: ocupa 70 % da altura e cola na base; favoritos (marcados no teste do desktop) no topo da lista.
    const box = await picker(page).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThan(812 * 0.7 - 3);
    expect(box?.height ?? 0).toBeLessThan(812 * 0.7 + 3);
    expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(812);
    await expect(favoriteModels(page).getByRole('listitem')).toHaveCount(2);
    await expect(rowOf(favoriteModels(page), 'opencode/glm-5.1')).toContainText('Liberado');
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'seletor-375-lista');

    // Áreas de toque de 40 px nos controles da linha.
    for (const name of ['Favoritar glm-5.1', 'Mais ações de glm-5.1']) {
      const target = await favoriteModels(page).getByRole('button', { name }).boundingBox();
      expect(target?.width ?? 0, name).toBeGreaterThanOrEqual(40);
      expect(target?.height ?? 0, name).toBeGreaterThanOrEqual(40);
    }

    // Primeira seleção no mobile (teste atrasado para ver o carregamento) e o effort fixo na base do drawer.
    await page.route('**/api/models/test', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.continue();
    });
    await rowOf(allModels(page), 'kimi-k2.7-code').click();
    await expect(picker(page).getByRole('status').filter({ hasText: 'Testando modelo…' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await attachShot(page, testInfo, 'seletor-375-testando');
    await expect(toast(page, 'Modelo liberado')).toBeVisible();
    await page.unroute('**/api/models/test');
    await expect(rowOf(allModels(page), 'kimi-k2.7-code')).toContainText('Liberado');
    await expect(effortSlider(page)).toHaveAttribute('aria-valuetext', 'Padrão');
    await pickEffort(page, 'Máximo', ['Padrão', 'Baixo', 'Médio', 'Alto', 'Extra alto', 'Máximo']);
    await expect(effortSlider(page)).toHaveAttribute('aria-valuetext', 'Máximo');
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'seletor-375-messages-effort');
    await rowOf(favoriteModels(page), 'opencode/glm-5.1').click(); // já testado: aplica sem teste
    await expect(effortSlider(page)).toHaveCount(1);
    const footer = await effortSlider(page).boundingBox();
    expect(Math.round((footer?.y ?? 0) + (footer?.height ?? 0))).toBeLessThanOrEqual(812);
    expect(footer?.height ?? 0, 'alvo de toque da barra').toBeGreaterThanOrEqual(40);
    await pickEffort(page, 'Baixo', EFFORT_STEPS);
    await attachShot(page, testInfo, 'seletor-375-effort');
    expect(tests).toHaveLength(1);

    // Fechar pelo botão devolve o foco ao gatilho e o valor aparece no campo.
    await picker(page).getByRole('button', { name: 'Fechar' }).click();
    await expect(picker(page)).toBeHidden();
    await expect(modelButton(page)).toBeFocused();
    await expect(modelButton(page)).toHaveAccessibleName('Modelo padrão opencode/glm-5.1 · Baixo');
    await expectNoHorizontalScroll(page);

    // A chave do provedor sai de cena: o campo volta a pedir a configuração (estado guardado no teste de bots).
    await setProvider(page, null);
    await page.reload();
    await expect(modelButton(page)).toBeDisabled();
    await expect(modelButton(page)).toHaveAccessibleName('Modelo padrão Configure um provedor');
    expect(problems).toEqual(['503 GET /api/models']);
  });
});

// ---------------------------------------------------------------------------------------------
// Dois provedores (phase 17, passo 11; UI-05): chips, grupos, Recentes, preço, oculto e indisponível
// ---------------------------------------------------------------------------------------------
// A chave da Anthropic é estado global como a do OpenCode Go: cada teste a salva (UMA validação real, dentro do orçamento do arquivo) e a remove no fim, e desfaz os favoritos e as marcas de
// oculto que fez, para nenhum spec seguinte encontrar a lista diferente. Os perfis testados que sobram (o `claude-mute` e o `claude-haiku-5-5`) não aparecem sem a chave e não atrapalham.

const ANTHROPIC_KEY = 'valid-e2e-anthropic-models-2222';

/**
 * O NOME de toda linha aparece inteiro (A28): nenhum corte com reticências no popover de 340 px nem no drawer de 375 px. O nome quebra em vez de cortar, então o conteúdo nunca passa da
 * largura do próprio elemento (`scrollWidth <= clientWidth`) e o elemento nunca passa da borda do seletor. `minimum` evita a prova vazia (uma lista que nem renderizou).
 */
async function expectNamesNotTruncated(page: Page, minimum: number) {
  const names = picker(page).locator('[data-model-name]');
  expect(await names.count()).toBeGreaterThanOrEqual(minimum);
  const frame = await picker(page).boundingBox();
  const measures = await names.evaluateAll((elements) =>
    elements.map((element) => ({ text: element.textContent ?? '', overflow: element.scrollWidth - element.clientWidth, right: element.getBoundingClientRect().right, ellipsis: getComputedStyle(element).textOverflow === 'ellipsis' })),
  );
  for (const measure of measures) {
    expect(measure.overflow, `nome cortado: ${measure.text}`).toBeLessThanOrEqual(0);
    expect(measure.ellipsis, `nome com reticências: ${measure.text}`).toBe(false);
    expect(measure.right, `nome fora do seletor: ${measure.text}`).toBeLessThanOrEqual((frame?.x ?? 0) + (frame?.width ?? 0) + 0.5);
  }
}

/** Captura só o seletor (o popover de 340 px ou o drawer de 375 px): anexa ao relatório e, com `AION_E2E_SHOTS_DIR`, grava o PNG. */
async function attachPickerShot(page: Page, testInfo: TestInfo, name: string) {
  const body = await picker(page).screenshot();
  await testInfo.attach(name, { body, contentType: 'image/png' });
  const dir = process.env.AION_E2E_SHOTS_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}.png`), body);
  }
}
const chipsOf = (page: Page) => picker(page).getByRole('group', { name: 'Filtrar por provedor' });
const groupOf = (page: Page, provider: 'OpenCode Go' | 'Anthropic') => picker(page).getByRole('list', { name: provider === 'Anthropic' ? 'Modelos da Anthropic' : 'Modelos do OpenCode Go' });
const groupButton = (page: Page, provider: 'OpenCode Go' | 'Anthropic', total: number) => picker(page).getByRole('button', { name: new RegExp(`^${provider} \\(${total}\\)`) });

/** Desfaz o que os testes de dois provedores mudam no estado global: favorito e oculto de cada modelo da Anthropic, e a chave dela. */
async function cleanAnthropic(page: Page) {
  const headers = await apiHeaders(page);
  const models = ((await (await page.context().request.get(`${ORIGIN}/api/models`, { headers })).json()) as { models: { id: string; hidden?: boolean; favorite: boolean }[] }).models.filter((entry) => entry.id.startsWith('anthropic/'));
  for (const entry of models) {
    if (entry.hidden) await page.context().request.patch(`${ORIGIN}/api/models/hidden`, { headers, data: { model: entry.id, hidden: false } });
    if (entry.favorite) await page.context().request.patch(`${ORIGIN}/api/models/favorite`, { headers, data: { model: entry.id, favorite: false } });
  }
  await page.context().request.delete(`${ORIGIN}/api/credentials/anthropic`, { headers });
  await setProvider(page, null); // o estado em que o teste de 375 px deixa a chave do provedor
}

test.describe('seletor com dois provedores (1440 × 900)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('A23, A25 a A29: chips filtram, grupos recolhem com contador, a linha mostra nome sem prefixo e preço, a busca mostra o provedor, Favoritos e o gatilho mostram o nome completo, e o teclado percorre tudo', async ({ page }, testInfo) => {
    const problems = watchPage(page);
    await ensureCredential(page, 'provider', PROVIDER_KEY);
    await ensureCredential(page, 'anthropic', ANTHROPIC_KEY);
    // O favorito do OpenCode Go que o teste anterior deixa, garantido aqui para o teste valer sozinho.
    const setup = await apiHeaders(page);
    expect((await page.context().request.patch(`${ORIGIN}/api/models/favorite`, { headers: setup, data: { model: 'opencode/glm-5.1', favorite: true } })).status()).toBe(200);
    try {
      await page.goto('/bots/novo');
      await expect(modelButton(page)).toBeEnabled();
      await openPicker(page);

      // A25: chips "Todos", "Anthropic" e "OpenCode Go" abaixo da busca; "Todos" é o escolhido.
      await expect(chipsOf(page).getByRole('button')).toHaveText(['Todos', 'Anthropic', 'OpenCode Go']);
      await expect(chipsOf(page).getByRole('button', { name: 'Todos' })).toHaveAttribute('aria-pressed', 'true');
      const searchBox = await picker(page).getByRole('searchbox', { name: 'Buscar modelo' }).boundingBox();
      const chipBox = await chipsOf(page).boundingBox();
      expect((chipBox?.y ?? 0) > (searchBox?.y ?? 0)).toBe(true);

      // A26: um grupo por provedor, com o contador, aberto; os favoritos de antes (glm-5.1 e grok-4.7) no topo, com o nome completo.
      await expect(groupButton(page, 'OpenCode Go', 14)).toHaveAttribute('aria-expanded', 'true');
      await expect(groupButton(page, 'Anthropic', 8)).toHaveAttribute('aria-expanded', 'true');
      await expect(groupOf(page, 'Anthropic').getByRole('listitem')).toHaveCount(8);
      await expect(groupOf(page, 'OpenCode Go').getByRole('listitem')).toHaveCount(14);
      await expect(favoriteModels(page).getByRole('button', { name: /^opencode\/glm-5\.1/ })).toBeVisible();

      // A28 e A23: a linha mostra o nome SEM prefixo e o preço da tabela; modelo sem preço diz "preço desconhecido".
      const claude = groupOf(page, 'Anthropic');
      await expect(claude).not.toContainText('anthropic/');
      await expect(rowOf(claude, 'Claude Haiku 5.5')).toContainText('US$ 0,10/0,50');
      await expect(rowOf(claude, 'Claude Sonnet 5.5')).toContainText('US$ 2,00/10,00');
      await expect(rowOf(claude, 'Claude Opus 5.5')).toContainText('US$ 4,00/20,00');
      await expect(rowOf(claude, 'Claude Opus 5')).toContainText('preço desconhecido');
      await expect(rowOf(groupOf(page, 'OpenCode Go'), 'deepseek-v4.1-flash')).toContainText('US$ 0,30/1,20');
      await expect(rowOf(groupOf(page, 'OpenCode Go'), 'glm-5.1')).toContainText('preço desconhecido');
      await expectNoA11yViolations(page);
      await attachShot(page, testInfo, 'seletor-1440-dois-provedores');
      // O nome inteiro, no popover de 340 px, em todas as linhas (Favoritos, grupos do OpenCode Go e da Anthropic).
      expect((await picker(page).boundingBox())?.width).toBeCloseTo(340, 0);
      await expectNamesNotTruncated(page, 20);
      await attachPickerShot(page, testInfo, 'cp2-seletor-340-linhas');

      // A25: o chip filtra tudo por provedor; "Todos" devolve a lista.
      await chipsOf(page).getByRole('button', { name: 'Anthropic' }).click();
      await expect(chipsOf(page).getByRole('button', { name: 'Anthropic' })).toHaveAttribute('aria-pressed', 'true');
      await expect(chipsOf(page).getByRole('button', { name: 'Todos' })).toHaveAttribute('aria-pressed', 'false');
      await expect(groupOf(page, 'OpenCode Go')).toHaveCount(0);
      await expect(favoriteModels(page)).toHaveCount(0); // os favoritos são do OpenCode Go
      await expect(groupOf(page, 'Anthropic').getByRole('listitem')).toHaveCount(8);
      await chipsOf(page).getByRole('button', { name: 'OpenCode Go' }).click();
      await expect(groupOf(page, 'Anthropic')).toHaveCount(0);
      await expect(groupOf(page, 'OpenCode Go').getByRole('listitem')).toHaveCount(14);
      await chipsOf(page).getByRole('button', { name: 'Todos' }).click();
      await expect(groupOf(page, 'Anthropic')).toBeVisible();

      // A26: o grupo recolhe e abre, sem perder o contador; recolhido não deixa linha para as setas.
      await groupButton(page, 'Anthropic', 8).click();
      await expect(groupButton(page, 'Anthropic', 8)).toHaveAttribute('aria-expanded', 'false');
      await expect(groupOf(page, 'Anthropic')).toHaveCount(0);
      await groupButton(page, 'Anthropic', 8).click();
      await expect(groupOf(page, 'Anthropic').getByRole('listitem')).toHaveCount(8);

      // A27: a busca acha em todos os provedores e cada resultado mostra o provedor.
      const search = picker(page).getByRole('searchbox', { name: 'Buscar modelo' });
      await search.fill('k');
      const results = picker(page).getByRole('list', { name: 'Resultados' });
      await expect(results.getByRole('button', { name: /OpenCode Go/ }).first()).toBeVisible();
      await expect(results.getByRole('button', { name: /Anthropic/ }).first()).toBeVisible();
      await expect(rowOf(results, 'kimi-k2.7-code')).toContainText('OpenCode Go');
      await expect(rowOf(results, 'Claude Haiku 5.5')).toContainText('Anthropic');
      await search.fill('claude-haiku');
      await expect(results.getByRole('listitem')).toHaveCount(3);
      await expect(results.getByRole('button', { name: /Anthropic/ })).toHaveCount(3);
      await search.fill('');

      // A28: Favoritos e o gatilho mostram o nome completo. O Claude Mute falha no teste e é aplicado com aviso (a lista do resumo não o oferece).
      await rowOf(claude, 'Claude Mute').click();
      await expect(rowOf(claude, 'Claude Mute')).toContainText('Falhou');
      await expect(modelButton(page)).toHaveAccessibleName('Modelo padrão anthropic/Claude Mute');
      await claude.getByRole('button', { name: 'Favoritar claude-mute' }).click();
      await expect(rowOf(favoriteModels(page), 'anthropic/Claude Mute')).toBeVisible();
      await expect(picker(page).getByRole('list', { name: 'Recentes' }).getByText(/anthropic\//)).toHaveCount(0); // nenhuma execução com modelo da Anthropic ainda

      // A29: teclado. Seta desce da busca à primeira linha e cada seta anda uma linha; os chips e os cabeçalhos dos grupos entram no Tab; Esc fecha e devolve o foco.
      await search.focus();
      await page.keyboard.press('ArrowDown');
      await expect(picker(page).getByRole('list', { name: 'Sem modelo' }).getByRole('button', { name: /^Sem modelo padrão/ })).toBeFocused(); // a opção de limpar vem primeiro no editor
      await page.keyboard.press('ArrowDown');
      await expect(favoriteModels(page).getByRole('button', { name: /^opencode\/glm-5\.1/ })).toBeFocused();
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('ArrowUp');
      await expect(search).toBeFocused();
      await chipsOf(page).getByRole('button', { name: 'Todos' }).focus();
      await page.keyboard.press('Enter');
      await expect(chipsOf(page).getByRole('button', { name: 'Todos' })).toHaveAttribute('aria-pressed', 'true');
      await groupButton(page, 'Anthropic', 8).focus();
      await page.keyboard.press('Space');
      await expect(groupButton(page, 'Anthropic', 8)).toHaveAttribute('aria-expanded', 'false');
      await page.keyboard.press('Space');
      await expect(groupButton(page, 'Anthropic', 8)).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('Escape');
      await expect(picker(page)).toBeHidden();
      await expect(modelButton(page)).toBeFocused();
      expect(problems).toEqual([]);
    } finally {
      await cleanAnthropic(page);
    }
  });

  test('A9, A21: modelo oculto sai das escolhas novas mas segue em uso e rodando, com "oculto"; saldo esgotado deixa a Anthropic "indisponível" até uma chamada passar; Recentes mostra o que rodou', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await ensureCredential(page, 'provider', PROVIDER_KEY);
    await ensureCredential(page, 'anthropic', ANTHROPIC_KEY);
    const headers = await apiHeaders(page);
    const request = page.context().request;
    const HAIKU = 'anthropic/claude-haiku-5-5';
    const hide = async (model: string, hidden: boolean) => expect((await request.patch(`${ORIGIN}/api/models/hidden`, { headers, data: { model, hidden } })).status()).toBe(200);
    try {
      const created = await request.post(`${ORIGIN}/api/bots`, { headers, data: { name: uniqueBotName('Bot Claude'), color: '#60A5FA', instructions: '', model: HAIKU, effort: null, stepLimit: 25 } });
      expect(created.status(), await created.text()).toBe(201);
      const { id } = (await created.json()) as { id: string };
      const field = (target: Page) => target.getByRole('textbox', { name: 'Mensagem', exact: true });

      // A9: oculto em Conexões, o modelo continua no bot e o gatilho diz "(oculto)"; a lista do seletor mostra só ele (o atual), com o selo, e o outro oculto sai.
      await hide(HAIKU, true);
      await hide('anthropic/claude-opus-5-5', true);
      await page.goto(`/bots/${id}/editar`);
      await expect(modelButton(page)).toHaveAccessibleName('Modelo padrão anthropic/Claude Haiku 5.5 (oculto)');
      await modelButton(page).click();
      await expect(groupOf(page, 'Anthropic')).toBeVisible();
      await expect(groupButton(page, 'Anthropic', 7)).toBeVisible();
      await expect(rowOf(groupOf(page, 'Anthropic'), 'Claude Haiku 5.5')).toContainText('Oculto');
      await expect(rowOf(groupOf(page, 'Anthropic'), 'Claude Haiku 5.5')).toHaveAttribute('aria-current', 'true');
      await expect(groupOf(page, 'Anthropic').getByText('Claude Opus 5.5', { exact: true })).toHaveCount(0);
      await picker(page).getByRole('searchbox', { name: 'Buscar modelo' }).fill('opus');
      await expect(picker(page).getByRole('list', { name: 'Resultados' }).getByRole('button', { name: /^Claude Opus 5\.5/ })).toHaveCount(0);
      await expectNoA11yViolations(page);
      await attachShot(page, testInfo, 'seletor-1440-oculto');
      await page.keyboard.press('Escape');

      // O oculto roda: a mensagem do dono é respondida pelo Claude.
      await page.goto(`/bots/${id}`);
      await field(page).fill('Oi, Claude');
      await field(page).press('Enter');
      await expect(page.getByText('Resposta: Oi, Claude')).toBeVisible();
      await hide(HAIKU, false);
      await hide('anthropic/claude-opus-5-5', false);

      // A26: o modelo que acabou de rodar entra em Recentes, com o nome completo.
      await page.goto('/bots/novo');
      await modelButton(page).click();
      await expect(picker(page).getByRole('heading', { name: 'Recentes' })).toBeVisible();
      await expect(rowOf(picker(page).getByRole('list', { name: 'Recentes' }), 'anthropic/Claude Haiku 5.5')).toBeVisible();
      await page.keyboard.press('Escape');

      // A20 e A21: o saldo acaba (o provedor falso recusa com 402): a execução para com o aviso e a Anthropic fica indisponível no seletor, sem escolha possível.
      await page.goto(`/bots/${id}`);
      await field(page).fill('[sem-saldo] escreva algo');
      await field(page).press('Enter');
      await expect(page.getByText('Créditos da Anthropic esgotados.').first()).toBeVisible();
      await page.goto('/bots/novo');
      await modelButton(page).click();
      const sonnet = rowOf(groupOf(page, 'Anthropic'), 'Claude Sonnet 5.5');
      await expect(sonnet).toContainText('Indisponível');
      await expect(sonnet).toHaveAttribute('aria-disabled', 'true');
      await expect(groupOf(page, 'Anthropic').getByRole('button', { name: /Indisponível/ })).toHaveCount(8);
      // O motivo é dito UMA vez, no cabeçalho do grupo, e cada linha indisponível o liga por aria-describedby (também a de Favoritos, abaixo).
      const reason = picker(page).getByText('Indisponível: os créditos da Anthropic acabaram.', { exact: true });
      await expect(reason).toHaveCount(1);
      await expect(reason).toBeVisible();
      const describedBy = async (row: Locator) => row.evaluate((element) => (element.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim());
      expect(await describedBy(sonnet)).toBe('Indisponível: os créditos da Anthropic acabaram.');
      await expect(sonnet).not.toContainText('créditos'); // a linha só tem o selo
      await sonnet.click({ force: true });
      await expect(modelButton(page)).toHaveAccessibleName('Modelo padrão Sem modelo padrão'); // nada foi escolhido
      await expect(rowOf(groupOf(page, 'OpenCode Go'), 'glm-5.1')).not.toContainText('Indisponível'); // só a Anthropic

      // Favoritar o indisponível troca a linha pelo que o servidor devolve: ela continua "Indisponível" e sem escolha, no grupo e em Favoritos.
      await groupOf(page, 'Anthropic').getByRole('button', { name: 'Favoritar claude-sonnet-5-5' }).click();
      await expect(groupOf(page, 'Anthropic').getByRole('button', { name: 'Favoritar claude-sonnet-5-5' })).toHaveAttribute('aria-pressed', 'true');
      const favoriteSonnet = rowOf(favoriteModels(page), 'anthropic/Claude Sonnet 5.5');
      await expect(favoriteSonnet).toContainText('Indisponível');
      await expect(favoriteSonnet).toHaveAttribute('aria-disabled', 'true');
      expect(await describedBy(favoriteSonnet)).toBe('Indisponível: os créditos da Anthropic acabaram.'); // fora do grupo, o motivo segue acessível
      await expect(reason).toHaveCount(1);
      await expect(sonnet).toContainText('Indisponível');
      await expect(sonnet).toHaveAttribute('aria-disabled', 'true');
      await expect(groupOf(page, 'Anthropic').getByRole('button', { name: /Indisponível/ })).toHaveCount(8);
      await expectNamesNotTruncated(page, 20); // inclusive nas linhas indisponíveis, com o selo e o motivo
      await expectNoA11yViolations(page);
      await attachShot(page, testInfo, 'seletor-1440-indisponivel');
      await attachPickerShot(page, testInfo, 'cp2-seletor-340-indisponivel');
      await page.keyboard.press('Escape');

      // Uma chamada que passa libera os modelos: o bot responde de novo e a lista volta ao normal.
      await page.goto(`/bots/${id}`);
      await field(page).fill('Agora com saldo');
      await field(page).press('Enter');
      await expect(page.getByText('Resposta: Agora com saldo')).toBeVisible();
      await page.goto('/bots/novo');
      await modelButton(page).click();
      await expect(rowOf(groupOf(page, 'Anthropic'), 'Claude Sonnet 5.5')).not.toContainText('Indisponível');
      await expect(rowOf(groupOf(page, 'Anthropic'), 'Claude Sonnet 5.5')).not.toHaveAttribute('aria-disabled', 'true');
    } finally {
      await cleanAnthropic(page);
    }
  });
});

test.describe('seletor com dois provedores (375 × 812)', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('A29: no celular abre o drawer de 70 dvh com os chips, os grupos e os preços, sem rolagem horizontal e sem violação de acessibilidade', async ({ page }, testInfo) => {
    await ensureCredential(page, 'provider', PROVIDER_KEY);
    await ensureCredential(page, 'anthropic', ANTHROPIC_KEY);
    try {
      await page.goto('/bots/novo');
      await modelButton(page).click();
      await expect(picker(page)).toBeVisible();
      await expect(groupOf(page, 'Anthropic')).toBeVisible();
      // O drawer sobe com uma animação: espera encostar na base antes de medir.
      await expect.poll(async () => {
        const moving = await picker(page).boundingBox();
        return Math.round((moving?.y ?? 0) + (moving?.height ?? 0));
      }).toBe(812);
      const box = await picker(page).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThan(812 * 0.7 - 3);
      expect(box?.height ?? 0).toBeLessThan(812 * 0.7 + 3);
      await expect(chipsOf(page).getByRole('button')).toHaveText(['Todos', 'Anthropic', 'OpenCode Go']);
      // Alvo de toque dos chips e dos cabeçalhos dos grupos.
      for (const target of [chipsOf(page).getByRole('button', { name: 'Anthropic' }), groupButton(page, 'Anthropic', 8)]) {
        expect((await target.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(36);
      }
      await expect(rowOf(groupOf(page, 'Anthropic'), 'Claude Haiku 5.5')).toContainText('US$ 0,10/0,50');
      await expectNoHorizontalScroll(page);
      await expectNoA11yViolations(page);
      await attachShot(page, testInfo, 'seletor-375-dois-provedores');
      await expectNamesNotTruncated(page, 20); // o nome inteiro também no drawer de 375 px
      await attachPickerShot(page, testInfo, 'cp2-seletor-375-linhas');
      await chipsOf(page).getByRole('button', { name: 'Anthropic' }).click();
      await expect(groupOf(page, 'OpenCode Go')).toHaveCount(0);
      await expectNoHorizontalScroll(page);
      await expectNoA11yViolations(page);
    } finally {
      await cleanAnthropic(page);
    }
  });
});

// E2E de A4 (F5) no navegador real, contra a pilha de produção: criar com erro de validação, nome duplicado em
// caixa diferente, cor personalizada com aviso, editar, arquivar com modal (foco volta ao botão), nome liberado,
// desarquivar com conflito, conversa vazia e painel, e a exclusão definitiva de um bot arquivado (T7, F6: zona do editor, popup de
// confirmação por nome, erros do servidor, "Excluindo…" e o que a interface recarrega) e a Faísca do bot (phase 5, T1: prévia de 96 px no
// editor na cor escolhida, clara, escura e personalizada, sem seletor de personagem, e a Faísca dormindo de 48 px no título do popup de exclusão) e o estado ao vivo na lista
// de bots (a Faísca dormindo na lista vazia, o texto de estado e a Faísca de 24 px de cada linha no painel e de 32 px no Início do celular, a atualização sozinha sem recarregar e uma releitura
// só com o painel e o Início montados; os estados que dependem de uma execução de verdade ficam em conversation.spec.ts, que tem o provedor) e a página não encontrada, fora do shell, com a Faísca em pose de erro. Os specs rodam em série no projeto
// `chromium-bots` (ver playwright.config.ts), pois criam bots no banco compartilhado da pilha.
// Screenshots anexados ao relatório são a evidência visual (1440 × 900 e 375 × 812).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { E2E_PORTS } from '../../../tests/support/e2e-env';
import {
  ORIGIN,
  apiHeaders,
  apiLogin,
  AION_BODY,
  backLink,
  contentOf,
  expect,
  expectFaiscaEnvelope,
  expectNoA11yViolations,
  expectNoHorizontalScroll,
  faiscaLook,
  runningAnimations,
  tabBarOf,
  test,
  uniqueBotName,
  watchPage,
} from './support/fixtures';

test.describe.configure({ mode: 'serial' });

/**
 * Zera o banco descartável antes do arquivo (E29). Os testes partem da lista vazia e de um painel sem "Arquivados"; com `--repeat-each`,
 * ou numa nova tentativa, bots anteriores podem permanecer. O controle usa TRUNCATE para montar o cenário sem consumir limites da API (ver
 * `/reset-bots` em tests/support/e2e-stack.ts). Roda uma vez por worker, e cada repetição ou nova tentativa de um arquivo serial é um worker novo.
 */
test.beforeAll(async () => {
  const reset = await fetch(`http://127.0.0.1:${E2E_PORTS.control}/reset-bots`, { method: 'POST' });
  expect(reset.status, 'zerar os bots pelo controle da pilha').toBe(200);
});

/**
 * Anexa o screenshot ao relatório do Playwright e, se `AION_E2E_SHOTS_DIR` estiver definida, também grava o PNG
 * nessa pasta com o nome da captura (para abrir as imagens sem mexer no relatório).
 */
async function attachShot(page: Page, testInfo: TestInfo, name: string) {
  const body = await page.screenshot();
  await testInfo.attach(name, { body, contentType: 'image/png' });
  const dir = process.env.AION_E2E_SHOTS_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}.png`), body);
  }
}

/** Foco visível: contorno de pelo menos 2 px no elemento focado (A16). */
async function expectVisibleFocus(locator: Locator) {
  await expect(locator).toBeFocused();
  const outline = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
  });
  expect(outline.style).not.toBe('none');
  expect(outline.width).toBeGreaterThanOrEqual(2);
}

const nameField = (page: Page) => page.getByLabel('Nome', { exact: true });
const saveButton = (page: Page) => page.getByRole('button', { name: 'Salvar' });
const toast = (page: Page, text: string) => page.getByText(text, { exact: true }).first(); // toasts anteriores ainda podem estar na tela
/** Faixa "Bot arquivado" da conversa (dentro do main: o toast de mesmo texto fica fora dele). */
const archivedBanner = (page: Page) => page.getByRole('main').getByText('Bot arquivado', { exact: true });

/**
 * Escolhe uma amostra de cor clicando na amostra visível, como o dono faz. O radio em si é só para leitores de
 * tela (fica recortado), então o clique vai no rótulo que o envolve e o resultado é conferido no radio.
 */
async function pickColor(page: Page, name: string) {
  await page.locator('label').filter({ has: page.getByRole('radio', { name, exact: true }) }).click();
  await expect(page.getByRole('radio', { name, exact: true })).toBeChecked();
}

/** Preenche o editor (nome e, se vier, cor pré-definida, instruções e limite) sem salvar. */
async function fillEditor(page: Page, fields: { name?: string; color?: string; instructions?: string; steps?: string }) {
  if (fields.name !== undefined) await nameField(page).fill(fields.name);
  if (fields.color) await pickColor(page, fields.color);
  if (fields.instructions !== undefined) await page.getByLabel('Instruções').fill(fields.instructions);
  if (fields.steps !== undefined) await page.getByLabel('Limite de etapas').fill(fields.steps);
}

/** Cria um bot pelo editor e espera chegar à conversa; devolve o id (da URL). */
async function createBotViaUi(page: Page, fields: Parameters<typeof fillEditor>[1] & { name: string }): Promise<string> {
  await page.goto('/bots/novo');
  await fillEditor(page, fields);
  await saveButton(page).click();
  await expect(page).toHaveURL(/\/bots\/[0-9a-f-]{36}$/);
  return page.url().split('/').pop() ?? '';
}

const panelOf = (page: Page) => page.getByRole('complementary');
/**
 * Link de um bot no painel (ou na lista do Início, no celular) pelo NOME do bot. O texto do estado ao vivo ("Livre", "Trabalhando…") faz parte do link e portanto do nome
 * acessível ("<nome> <estado>"), que é o que o leitor de tela lê; o nome puro vem do `title` do link.
 */
const panelBotLink = (scope: Locator, name: string) => scope.locator(`a[title=${JSON.stringify(name)}]`);
/** Escapa o texto para entrar numa expressão regular (nome de bot com parênteses, como o sufixo de repetição). */
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Leitura da API pela própria página (mesma origem, com a sessão dela): é o que o app vê, sem refazer o login nem montar cabeçalhos. */
const apiGet = <T>(page: Page, path: string) => page.evaluate(async (url) => (await fetch(url)).json(), path) as Promise<T>;

/** O grupo de botões de opção "Cor" do editor (12 amostras mais a personalizada). */
const colorGroup = (page: Page) => page.getByRole('radiogroup', { name: 'Cor', exact: true });
/** Prévia da Faísca ao lado do campo Nome: a única Faísca da seção Identidade do editor. */
const faiscaPreview = (page: Page) => page.locator('section[aria-labelledby="sec-identidade"] svg.faisca');

test.describe('lista de bots vazia (T11, F10 passo 9)', () => {
  test('a Faísca dormindo com o convite em 1440 e 375 px, o botão na largura da coluna no celular e o painel vazio sem Faísca', async ({ page }, testInfo) => {
    const problems = watchPage(page);
    await apiLogin(page.context());
    const faiscas = () => page.getByRole('main').locator('svg.faisca');

    for (const [label, viewport] of [
      ['1440', { width: 1440, height: 900 }],
      ['375', { width: 375, height: 812 }],
    ] as const) {
      await page.setViewportSize(viewport);
      await page.goto('/bots');
      await expect(page.getByRole('heading', { level: 2, name: 'Crie seu primeiro bot' })).toBeVisible();
      await expect(page.getByText('Cada bot tem nome, instruções e memória próprios.')).toBeVisible();

      // A Faísca dormindo, de 96 px nas duas telas, decorativa, com a entrada de uma vez e na cor de marca (não é de um bot); é a única da tela.
      await expect(faiscas()).toHaveCount(1);
      expect(await faiscaLook(faiscas()), label).toMatchObject({ state: 'sleep', detail: 'full', decorative: true, size: [96, 96], still: true, body: AION_BODY });
      await expect(faiscas()).toHaveAttribute('data-enter', '');

      // O botão primário "Criar bot": largura de conteúdo no desktop e a da coluna no celular (375 px menos as margens de 24 px).
      const create = page.getByRole('main').getByRole('link', { name: 'Criar bot' });
      const box = (await create.boundingBox())!;
      if (label === '375') expect(box.width, 'botão em largura total').toBeGreaterThanOrEqual(300);
      else expect(box.width, 'botão do tamanho do texto').toBeLessThan(160);
      // O painel lateral continua com o texto curto de hoje e sem Faísca (no celular ele fica escondido por CSS).
      await expect(panelOf(page).locator('svg.faisca')).toHaveCount(0);
      if (label === '1440') await expect(panelOf(page).getByText('Nenhum bot ainda.')).toBeVisible();
      await expectNoHorizontalScroll(page);
      await expectNoA11yViolations(page);
      await attachShot(page, testInfo, `lista-vazia-${label}`);
    }

    // Com movimento reduzido a entrada vira pose estática: nenhuma animação em curso.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/bots');
    await expect(faiscas()).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === 'running').length)).toBe(0);

    await page.getByRole('main').getByRole('link', { name: 'Criar bot' }).click();
    await expect(page).toHaveURL(/\/bots\/novo$/);
    await expect(page.getByRole('button', { name: /Configure um provedor/ })).toBeDisabled();
    await expect(page.getByLabel('Contexto', { exact: true })).toHaveValue('global');
    expect(problems).toEqual([]);
  });
});

test.describe('bots no desktop (1440 × 900)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  let journeyIds: { financeiro: string; vendas: string; contabil: string };

  test('criar: estado vazio, erro de validação com foco, nome duplicado em outra caixa e conversa vazia', async ({ page }, testInfo) => {
    const problems = watchPage(page);
    await apiLogin(page.context());

    // Lista vazia com o CTA "Criar bot" (F5, a Faísca dormindo); o painel também diz que não há bots.
    await page.goto('/bots');
    await expect(page.getByRole('heading', { level: 2, name: 'Crie seu primeiro bot' })).toBeVisible();
    await expect(panelOf(page).getByText('Nenhum bot ainda.')).toBeVisible();
    await attachShot(page, testInfo, 'painel-1440-vazio');
    await page.getByRole('link', { name: 'Criar bot' }).click();
    await expect(page).toHaveURL(/\/bots\/novo$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Novo bot' })).toBeVisible();

    // Modelo padrão: desabilitado com a orientação do aceite (T5 o ativa).
    const model = page.getByRole('button', { name: /Configure um provedor/ });
    await expect(model).toBeDisabled();
    await expect(page.getByText('O modelo e o effort padrão ficam disponíveis')).toBeVisible();
    // Padrões do F5: 50 etapas (T30), cor Azul marcada, 12 amostras pré-definidas mais "Personalizada".
    await expect(page.getByLabel('Limite de etapas')).toHaveValue('50');
    await expect(colorGroup(page).getByRole('radio')).toHaveCount(13);
    await expect(page.getByRole('radio', { name: 'Azul', exact: true })).toBeChecked();
    // Sem personagem: a Faísca é única (nenhuma grade além da cor).
    await expect(page.getByRole('radiogroup')).toHaveCount(1);

    // Salvar sem nome e com limite inválido: erros inline por campo, foco no primeiro campo inválido, nada criado.
    await page.getByLabel('Limite de etapas').fill('101');
    await saveButton(page).click();
    await expect(page.getByText('Informe um nome.')).toBeVisible();
    await expect(page.getByText('Informe um número inteiro de 1 a 100.')).toBeVisible();
    await expectVisibleFocus(nameField(page));
    await expect(nameField(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(page).toHaveURL(/\/bots\/novo$/);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'editor-1440-erro-validacao');

    // Corrigir apaga o erro do campo que foi editado.
    await nameField(page).fill('Financeiro');
    await expect(page.getByText('Informe um nome.')).toHaveCount(0);
    await page.getByLabel('Limite de etapas').fill('30');
    await page.getByLabel('Instruções').fill('Controle o caixa e concilie as contas.');
    await expect(page.getByText('38 / 8.000')).toBeVisible();
    await pickColor(page, 'Verde');
    expect(await faiscaLook(faiscaPreview(page))).toMatchObject({ body: '#4ADE80', size: [96, 96] }); // a prévia acompanha a cor escolhida
    await saveButton(page).click();

    // Conversa vazia do bot novo: saudação do design, cabeçalho, painel com o marcador e o bot destacado.
    await expect(page).toHaveURL(/\/bots\/[0-9a-f-]{36}$/);
    const id = page.url().split('/').pop() ?? '';
    await expect(toast(page, 'Bot criado')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Financeiro' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'O que o Financeiro faz agora?' })).toBeVisible();
    const panelLink = panelBotLink(panelOf(page), 'Financeiro');
    await expect(panelLink).toHaveAttribute('aria-current', 'page');
    // O painel mostra a Faísca de 24 px (nível liso), parada e decorativa, na cor do bot. Verde (#4ADE80) é clara: a tinta do rosto é fixa e segue legível. O estado
    // vem em texto, dentro do link ("Livre").
    expect(await faiscaLook(panelLink.locator('svg.faisca'))).toMatchObject({ state: 'idle', detail: 'small', still: true, decorative: true, size: [24, 24], body: '#4ADE80' });
    await expect(panelLink.getByText('Livre', { exact: true })).toBeVisible();
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'conversa-1440-vazia');

    // Nome duplicado sem diferenciar maiúsculas: erro no campo, foco nele e nada é criado.
    await page.goto('/bots/novo');
    await fillEditor(page, { name: 'FINANCEIRO' });
    await saveButton(page).click();
    await expect(page.getByText('Já existe um bot ativo com esse nome.')).toBeVisible();
    await expectVisibleFocus(nameField(page));
    await expect(page).toHaveURL(/\/bots\/novo$/);
    await attachShot(page, testInfo, 'editor-1440-nome-duplicado');
    await expect(panelOf(page).getByRole('list', { name: 'Bots', exact: true }).getByRole('link')).toHaveCount(1); // nada foi criado
    journeyIds = { financeiro: id, vendas: '', contabil: '' };
    // Única recusa esperada em toda a jornada: o 409 do nome duplicado.
    expect(problems).toEqual(['409 POST /api/bots']);
  });

  test('cor personalizada: aviso de pouco contraste, aceita mesmo assim, e Faísca na cor escolhida', async ({ page }, testInfo) => {
    const problems = watchPage(page);
    await apiLogin(page.context());
    await page.goto('/bots/novo');
    await fillEditor(page, { name: 'Vendas' });

    await pickColor(page, 'Personalizada');
    const hex = page.getByLabel('Cor personalizada (hexadecimal)');
    await expect(hex).toBeVisible();
    // Digitação parcial: sem aviso até a cor ficar válida; sem o "#" ele é acrescentado.
    await hex.fill('22');
    await expect(page.getByText('Cor com pouco contraste.')).toHaveCount(0);
    await hex.fill('222222');
    await expect(hex).toHaveValue('#222222');
    await expect(page.getByText('Cor com pouco contraste.')).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'será aceita' })).toBeVisible();
    // Formato inválido bloqueia o envio com a frase do campo.
    await hex.fill('#22');
    await saveButton(page).click();
    await expect(page.getByText('Use o formato #RRGGBB, por exemplo #60A5FA.')).toBeVisible();
    await expectVisibleFocus(hex);
    await hex.fill('#222222');
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'editor-1440-cor-aviso');

    // Cor acima de 3:1 não avisa.
    await hex.fill('#60A5FA');
    await expect(page.getByText('Cor com pouco contraste.')).toHaveCount(0);

    // Aceita a cor fraca mesmo com o aviso; a Faísca usa a cor escolhida (a tinta do rosto é fixa, não depende dela).
    await hex.fill('#222222');
    await saveButton(page).click();
    await expect(page).toHaveURL(/\/bots\/[0-9a-f-]{36}$/);
    const id = page.url().split('/').pop() ?? '';
    expect(await faiscaLook(panelBotLink(panelOf(page), 'Vendas').locator('svg.faisca'))).toMatchObject({ body: '#222222' });
    // O nome destacado não usa a cor fraca: cai para o texto padrão (legível).
    await expect(page.getByRole('heading', { level: 1, name: 'Vendas' })).toHaveCSS('color', 'rgb(236, 236, 241)');
    await expectNoA11yViolations(page);

    // Reabrir o editor abre em "Personalizada" (a cor salva não é uma das 12) com o valor e o aviso.
    await page.goto(`/bots/${id}/editar`);
    await expect(page.getByRole('radio', { name: 'Personalizada' })).toBeChecked();
    await expect(page.getByLabel('Cor personalizada (hexadecimal)')).toHaveValue('#222222');
    await expect(page.getByText('Cor com pouco contraste.')).toBeVisible();
    journeyIds = { ...journeyIds, vendas: id };
    expect(problems).toEqual([]);
  });

  test('seletor de cor por teclado: setas movem a escolha e o foco fica visível', async ({ page }) => {
    await apiLogin(page.context());
    await page.goto('/bots/novo');
    const azul = page.getByRole('radio', { name: 'Azul', exact: true });
    await azul.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: 'Índigo', exact: true })).toBeChecked();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('radio', { name: 'Ciano', exact: true })).toBeChecked();
    // Foco visível: o contorno fica na amostra (o radio em si é só para leitores de tela).
    const swatch = page.locator('label', { has: page.getByRole('radio', { name: 'Ciano', exact: true }) }).locator('span').first();
    const outline = await swatch.evaluate((element) => ({ style: getComputedStyle(element).outlineStyle, width: parseFloat(getComputedStyle(element).outlineWidth) }));
    expect(outline.style).not.toBe('none');
    expect(outline.width).toBeGreaterThanOrEqual(2);
  });

  test('a prévia da Faísca no editor: 96 px à esquerda do Nome, ociosa e parada, na cor escolhida (clara, escura, personalizada e inválida), sem seletor de personagem', async ({ page }, testInfo) => {
    const problems = watchPage(page);
    await apiLogin(page.context());
    await page.goto('/bots/novo');
    await fillEditor(page, { name: 'Contraste' }); // só olhamos a tela: nada é salvo

    // O personagem não existe mais: nem a grade, nem o rótulo. A Faísca é única e a cor do bot é a única escolha de identidade.
    await expect(page.getByRole('radiogroup', { name: 'Personagem', exact: true })).toHaveCount(0);
    await expect(page.getByText('Personagem', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('radiogroup', { name: 'Cor', exact: true })).toBeVisible();

    // A prévia: Faísca completa de 96 px (nível de 48 px ou mais), ociosa, parada, decorativa, na cor atual (Azul), à esquerda do campo Nome e sem animação rodando.
    const preview = faiscaPreview(page);
    await expect(preview).toHaveCount(1);
    expect(await faiscaLook(preview)).toMatchObject({ state: 'idle', detail: 'full', still: true, decorative: true, size: [96, 96], body: '#60A5FA' });
    const [previewBox, nameBox] = await Promise.all([preview.boundingBox(), nameField(page).boundingBox()]);
    expect(previewBox!.x + previewBox!.width, 'a prévia fica à esquerda do Nome').toBeLessThanOrEqual(nameBox!.x);
    expect(await runningAnimations(preview), 'a prévia não se mexe').toBe(0);

    // A troca de cor é imediata (sem animação): a prévia acompanha a amostra clara, a escura e a personalizada.
    await pickColor(page, 'Âmbar'); // clara: o contorno da estrela é o que a separa do corpo
    expect(await faiscaLook(preview)).toMatchObject({ body: '#FBBF24', size: [96, 96] });
    await attachShot(page, testInfo, 'editor-1440-faisca-ambar');
    await pickColor(page, 'Personalizada');
    await page.getByLabel('Cor personalizada (hexadecimal)').fill('#1E3A8A'); // escura: a tinta do rosto é fixa e continua legível
    expect(await faiscaLook(preview)).toMatchObject({ body: '#1E3A8A' });
    await attachShot(page, testInfo, 'editor-1440-faisca-escura');
    // Digitação parcial (cor inválida): a prévia cai para o cinza neutro em vez de quebrar.
    await page.getByLabel('Cor personalizada (hexadecimal)').fill('#1E');
    expect(await faiscaLook(preview)).toMatchObject({ body: '#9CA3AF' });
    await page.getByLabel('Cor personalizada (hexadecimal)').fill('#1E3A8A');
    await expectNoA11yViolations(page);
    expect(problems).toEqual([]);
  });

  test('editar: campos preenchidos, salvar renomeia e o painel acompanha; erro de nome em uso na edição', async ({ page }, testInfo) => {
    const problems = watchPage(page);
    await apiLogin(page.context());
    await page.goto(`/bots/${journeyIds.financeiro}`);

    // O atalho de configurações da conversa leva ao editor do mesmo bot.
    await page.getByRole('link', { name: 'Configurações do bot' }).click();
    await expect(page).toHaveURL(`/bots/${journeyIds.financeiro}/editar`);
    await expect(nameField(page)).toHaveValue('Financeiro');
    await expect(page.getByLabel('Instruções')).toHaveValue('Controle o caixa e concilie as contas.');
    await expect(page.getByLabel('Limite de etapas')).toHaveValue('30');
    await expect(page.getByRole('radio', { name: 'Verde', exact: true })).toBeChecked();
    expect(await faiscaLook(faiscaPreview(page))).toMatchObject({ body: '#4ADE80', size: [96, 96] }); // a prévia parte da cor gravada
    await attachShot(page, testInfo, 'editor-1440-edicao');

    // Renomear para o nome de outro bot ativo (em outra caixa) é recusado, e o painel não muda.
    await nameField(page).fill('vendas');
    await saveButton(page).click();
    await expect(page.getByText('Já existe um bot ativo com esse nome.')).toBeVisible();
    await expect(panelBotLink(panelOf(page), 'Financeiro')).toBeVisible();

    // Trocar só a caixa do próprio nome é permitido; renomear de verdade atualiza a conversa e o painel.
    await nameField(page).fill('FINANCEIRO');
    await saveButton(page).click();
    await expect(page).toHaveURL(`/bots/${journeyIds.financeiro}`);
    await expect(page.getByRole('heading', { level: 1, name: 'FINANCEIRO' })).toBeVisible();
    await page.getByRole('link', { name: 'Configurações do bot' }).click();
    await nameField(page).fill('Contábil');
    await pickColor(page, 'Rosa');
    expect(await faiscaLook(faiscaPreview(page))).toMatchObject({ body: '#F472B6' }); // a prévia troca de cor na hora
    await saveButton(page).click();
    await expect(toast(page, 'Bot salvo')).toBeVisible();
    // O bot guarda só nome e cor (sem personagem): a lista traz a cor nova, e o corpo da Faísca no painel é a cor gravada.
    const listed = await apiGet<{ bots: { id: string; color: string }[] }>(page, '/api/bots');
    expect(listed.bots.find((bot) => bot.id === journeyIds.financeiro)?.color, 'a lista traz a cor nova').toBe('#F472B6');
    await expect(page.getByRole('heading', { level: 2, name: 'O que o Contábil faz agora?' })).toBeVisible();
    await expect(panelBotLink(panelOf(page), 'Contábil')).toBeVisible();
    await expect(panelBotLink(panelOf(page), 'Financeiro')).toHaveCount(0);
    await expect(panelBotLink(panelOf(page), 'FINANCEIRO')).toHaveCount(0);
    // A lista do painel segue a ordem alfabética.
    const names = await panelOf(page).getByRole('list', { name: 'Bots', exact: true }).getByRole('link').evaluateAll((links) => links.map((link) => link.getAttribute('title')));
    expect(names).toEqual(['Contábil', 'Vendas']);
    expect(problems).toEqual(['409 PATCH /api/bots/'.concat(journeyIds.financeiro)]);
    journeyIds = { ...journeyIds, contabil: journeyIds.financeiro };
  });

  test('arquivar: modal com foco de volta ao botão, bot vai para Arquivados, nome liberado e desarquivar com conflito', async ({ page }, testInfo) => {
    const problems = watchPage(page);
    await apiLogin(page.context());
    await page.goto(`/bots/${journeyIds.contabil}/editar`);

    // Modal de confirmação: texto do design, foco inicial em "Cancelar"; Esc e Cancelar devolvem o foco ao gatilho.
    const archiveTrigger = page.getByRole('button', { name: 'Arquivar bot' });
    await archiveTrigger.click();
    const dialog = page.getByRole('dialog', { name: 'Arquivar este bot?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('As rotinas deste bot serão pausadas.');
    await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'modal-arquivar-1440');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(archiveTrigger).toBeFocused();
    await archiveTrigger.click();
    await dialog.getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialog).toBeHidden();
    await expect(archiveTrigger).toBeFocused();
    // Nada foi arquivado até aqui.
    await page.goto('/bots');
    await expect(panelBotLink(panelOf(page), 'Contábil')).toBeVisible();
    await expect(panelOf(page).getByRole('button', { name: /Arquivados/ })).toHaveCount(0);

    // Confirmar arquiva: vai para a conversa do bot com a faixa "Bot arquivado"; o painel abre Arquivados sozinho.
    await page.goto(`/bots/${journeyIds.contabil}/editar`);
    await archiveTrigger.click();
    await dialog.getByRole('button', { name: 'Arquivar', exact: true }).click();
    await expect(page).toHaveURL(`/bots/${journeyIds.contabil}`);
    await expect(toast(page, 'Bot arquivado')).toBeVisible();
    await expect(archivedBanner(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Desarquivar' })).toBeVisible();
    const archivedToggle = panelOf(page).getByRole('button', { name: /Arquivados/ });
    await expect(archivedToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(panelBotLink(panelOf(page).getByRole('list', { name: 'Bots arquivados' }), 'Contábil')).toBeVisible();
    await expect(panelBotLink(panelOf(page).getByRole('list', { name: 'Bots', exact: true }), 'Contábil')).toHaveCount(0);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'conversa-1440-arquivado');

    // O dono recolhe e expande Arquivados (escolha explícita vence o padrão).
    await archivedToggle.click();
    await expect(archivedToggle).toHaveAttribute('aria-expanded', 'false');
    await archivedToggle.click();
    await expect(archivedToggle).toHaveAttribute('aria-expanded', 'true');

    // Nome liberado: um bot novo pode usar "contábil" (minúsculas e com acento) enquanto o antigo está arquivado.
    const replacementId = await createBotViaUi(page, { name: 'contábil', color: 'Ciano' });
    await expect(panelBotLink(panelOf(page).getByRole('list', { name: 'Bots', exact: true }), 'contábil')).toBeVisible();

    // Desarquivar o antigo agora conflita: a faixa orienta a renomear, e o bot segue arquivado.
    await page.goto(`/bots/${journeyIds.contabil}`);
    await page.getByRole('button', { name: 'Desarquivar' }).click();
    await expect(page.getByText(/Já existe um bot ativo com esse nome\./)).toBeVisible();
    await attachShot(page, testInfo, 'conversa-1440-desarquivar-conflito');
    await page.getByRole('link', { name: 'Renomeie este bot' }).click();
    await expect(page).toHaveURL(`/bots/${journeyIds.contabil}/editar`);
    // No editor de um bot arquivado a zona de arquivamento oferece desarquivar (mesmo conflito, mesma orientação).
    await expect(page.getByText('Este bot está arquivado.')).toBeVisible();
    await page.getByRole('button', { name: 'Desarquivar' }).click();
    await expect(page.getByTestId('form-error')).toContainText('Renomeie este bot e salve antes de desarquivar.');

    // Renomear o arquivado destrava; depois desarquivar o devolve à lista principal.
    await nameField(page).fill('Contábil antigo');
    await saveButton(page).click();
    await expect(page).toHaveURL(`/bots/${journeyIds.contabil}`);
    await expect(archivedBanner(page)).toBeVisible();
    // E18 (causa vista no trace do CI): o toast "Bot salvo" do salvamento acima entra no canto inferior direito (posição do design) e
    // passa por cima do botão "Desarquivar" da faixa; o Playwright já tinha conferido o alvo, o toast chegou antes do clique e o
    // engoliu (nenhum POST /unarchive saiu). Como a navegação foi no cliente, o toast sobrevive à troca de página: espera ele sair.
    await expect(toast(page, 'Bot salvo')).toBeHidden();
    // E o status da API vem antes do toast: separa "o servidor recusou ou não respondeu" de "o servidor aceitou e o toast não apareceu".
    const unarchived = page.waitForResponse((response) => response.url().endsWith(`/api/bots/${journeyIds.contabil}/unarchive`));
    await page.getByRole('button', { name: 'Desarquivar' }).click();
    expect((await unarchived).status(), 'desarquivar depois de renomear').toBe(200);
    await expect(toast(page, 'Bot desarquivado')).toBeVisible();
    await expect(archivedBanner(page)).toHaveCount(0);
    await expect(panelBotLink(panelOf(page).getByRole('list', { name: 'Bots', exact: true }), 'Contábil antigo')).toBeVisible();
    await expect(panelOf(page).getByRole('button', { name: /Arquivados/ })).toHaveCount(0);

    // A conversa única e a memória do bot arquivado foram preservadas: a conversa abre vazia normalmente.
    await expect(page.getByRole('heading', { level: 2, name: 'O que o Contábil antigo faz agora?' })).toBeVisible();
    expect(replacementId).toMatch(/^[0-9a-f-]{36}$/);
    // Recusas esperadas: só as duas tentativas de desarquivar com o nome em uso (faixa da conversa e zona do editor).
    expect(problems).toEqual(['409 POST /api/bots/'.concat(journeyIds.contabil, '/unarchive'), '409 POST /api/bots/'.concat(journeyIds.contabil, '/unarchive')]);
  });

  test('teclado: cria um bot só com Tab, setas e Enter, com foco visível em cada parada', async ({ page }) => {
    const problems = watchPage(page);
    await apiLogin(page.context());
    await page.goto('/bots/novo');
    await expect(nameField(page)).toBeVisible();

    /** Quem tem o foco e se o foco aparece (contorno de 2 px nele ou, no radio recortado, na amostra ao lado). */
    const focus = () =>
      page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        if (!element) return null;
        const shown = element instanceof HTMLInputElement && element.type === 'radio' ? (element.nextElementSibling as HTMLElement) : element;
        const style = getComputedStyle(shown);
        const label = element instanceof HTMLInputElement ? element.labels?.[0]?.textContent?.trim() : undefined;
        const name = element.getAttribute('aria-label') ?? (element.id || element.textContent?.trim() || label || element.tagName);
        return { id: element.id, name, visible: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2 };
      });
    const tabTo = async (id: string) => {
      for (let step = 0; step < 50; step += 1) {
        await page.keyboard.press('Tab');
        const state = await focus();
        expect(state?.visible, `foco visível em "${state?.name}"`).toBe(true);
        if (state?.id === id) return;
      }
      throw new Error(`o foco não chegou a #${id} em 50 Tabs`);
    };

    // Do início da página (barra, painel com os bots e o cabeçalho) até o nome, sem nenhuma parada sem foco visível.
    await tabTo('nome');
    await page.keyboard.type('Teclado');
    // Um único Tab entra no grupo de cores (no radio marcado); as setas escolhem a cor.
    await page.keyboard.press('Tab');
    const swatch = await focus();
    expect(swatch).toMatchObject({ name: 'Azul', visible: true });
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: 'Índigo', exact: true })).toBeChecked();
    await tabTo('instrucoes');
    await page.keyboard.type('Instrução escrita pelo teclado.');
    // O modelo padrão está desabilitado: o próximo Tab pula direto para o limite de etapas.
    await tabTo('limite-etapas');
    await page.keyboard.press('Control+A');
    await page.keyboard.type('12');
    await page.keyboard.press('Enter'); // Enter no campo envia o formulário

    await expect(page).toHaveURL(/\/bots\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Teclado' })).toBeVisible();
    await page.getByRole('link', { name: 'Configurações do bot' }).click();
    await expect(page.getByLabel('Limite de etapas')).toHaveValue('12');
    await expect(page.getByLabel('Instruções')).toHaveValue('Instrução escrita pelo teclado.');
    await expect(page.getByRole('radio', { name: 'Índigo', exact: true })).toBeChecked();
    expect(problems).toEqual([]);
  });

  test('bot inexistente ou id malformado mostra "Não encontrado" com caminho de volta', async ({ page }) => {
    await apiLogin(page.context());
    await page.goto('/bots/00000000-0000-4000-8000-000000000000');
    await expect(page.getByRole('heading', { level: 1, name: 'Não encontrado' })).toBeVisible();
    await page.getByRole('link', { name: 'Ir para Bots' }).click();
    await expect(page).toHaveURL(/\/bots(\/[0-9a-f-]{36})?$/);

    await page.goto('/bots/00000000-0000-4000-8000-000000000000/editar');
    await expect(page.getByRole('heading', { level: 1, name: 'Não encontrado' })).toBeVisible();
    await page.goto('/bots/nao-e-uuid');
    await expect(page.getByRole('heading', { level: 1, name: 'Não encontrado' })).toBeVisible();
    await expectNoA11yViolations(page);
  });

  for (const [where, path] of [
    ['fora do shell (rota que não existe)', '/rota-que-nao-existe'],
    ['dentro do shell (notFound() de uma página do app)', '/bots/nao-e-uuid'],
  ] as const) {
    test(`a página não encontrada ${where} mostra a Faísca aguardando com a entrada e sem olhar, tem um único main, e se adapta ao celular e à janela baixa`, async ({ page }, testInfo) => {
      const shot = `nao-encontrada-${path === '/bots/nao-e-uuid' ? 'no-shell' : 'fora-do-shell'}`;
      await apiLogin(page.context());
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(path);
      const heading = page.getByRole('heading', { level: 1, name: 'Não encontrado' });
      // Dentro do shell o painel de bots também tem Faíscas: a da tela é a que está junto do título.
      const faisca = heading.locator('..').locator('svg.faisca');
      const home = page.getByRole('link', { name: 'Ir para o Início' });
      await expect(heading).toBeVisible();
      // Um landmark principal só: dentro do shell o `main` é o dele (a tela não declara outro), fora dele é o da tela (A18; antes ficava um dentro do outro).
      await expect(page.locator('main')).toHaveCount(1);
      await expect(page.getByRole('main')).toHaveCount(1);
      await expect(page.getByText('Esta página não existe ou foi removida.')).toBeVisible();
      await expect(home).toBeVisible();
      await expect(page.getByRole('button', { name: 'Tentar novamente' })).toHaveCount(0);

      // A Faísca do Aion (cor de marca), aguardando e sem laço (só a entrada), com halo, decorativa e de 112 px.
      await expect(faisca).toHaveCount(1);
      expect(await faiscaLook(faisca)).toMatchObject({ state: 'waiting', detail: 'full', still: true, decorative: true, size: [112, 112], body: AION_BODY });
      await expect(faisca).toHaveAttribute('data-enter', '');
      await expectFaiscaEnvelope(faisca);
      // Rosto fixo: esta pose não segue o cursor (sem `data-look`, e o rosto não se move com o cursor longe dele).
      const face = () => faisca.evaluate((svg) => ['[data-part="face"]', '[data-part="eyes"]'].map((selector) => getComputedStyle(svg.querySelector(selector)!).transform));
      await expect.poll(() => faisca.evaluate((svg) => svg.getAnimations({ subtree: true }).filter((animation) => (animation as CSSAnimation).animationName === 'fa-enter').length)).toBe(0);
      const before = await face();
      const box = (await faisca.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2 + 400, box.y + box.height / 2);
      await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 60);
      await page.waitForTimeout(400); // mais que os 220 ms da transição do rosto
      await expect(faisca).not.toHaveAttribute('data-look', '');
      expect(await face(), 'o rosto não se move com o cursor').toEqual(before);
      // A tela cabe sem rolar (dentro do shell, quem rola é o <main> do shell; fora dele, o documento).
      const extraHeight = () =>
        page.evaluate(() => {
          const parent = [...document.querySelectorAll('main')].at(-1)!.parentElement!;
          const scroller = parent === document.body ? document.documentElement : parent;
          return scroller.scrollHeight - scroller.clientHeight;
        });
      expect(await extraHeight(), 'sem rolagem vertical').toBeLessThanOrEqual(0);
      await expectNoHorizontalScroll(page);
      await expectNoA11yViolations(page);
      await attachShot(page, testInfo, `${shot}-1440`);

      // Celular: a Faísca cai para 96 px, o botão ocupa a largura da coluna (375 px menos as margens de 16 px) e nada rola.
      await page.setViewportSize({ width: 375, height: 812 });
      expect((await faiscaLook(faisca)).size).toEqual([96, 96]);
      expect((await home.boundingBox())!.width, 'botão em largura total').toBeGreaterThanOrEqual(375 - 32 - 1);
      expect((await home.boundingBox())!.x, 'margem de 16 px').toBeGreaterThanOrEqual(16 - 1);
      expect(await extraHeight(), 'sem rolagem vertical').toBeLessThanOrEqual(0);
      await expectNoHorizontalScroll(page);
      await expectNoA11yViolations(page);
      await attachShot(page, testInfo, `${shot}-375`);

      // Altura abaixo de 640 px (tela baixa): 72 px, no celular e no desktop, e a altura de 640 px ainda não encolhe.
      await page.setViewportSize({ width: 375, height: 600 });
      expect((await faiscaLook(faisca)).size).toEqual([72, 72]);
      await page.setViewportSize({ width: 1440, height: 639 });
      expect((await faiscaLook(faisca)).size).toEqual([72, 72]);
      await page.setViewportSize({ width: 1440, height: 640 });
      expect((await faiscaLook(faisca)).size).toEqual([112, 112]);
      await page.setViewportSize({ width: 375, height: 600 });
      await attachShot(page, testInfo, `${shot}-375-baixa`);

      // Movimento reduzido: pose estática (a entrada não roda) e o caminho de volta continua valendo.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect.poll(() => faisca.evaluate((svg) => svg.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running').length)).toBe(0);
      await home.click();
      // "Ir para o Início" leva ao Início (`/`, phase 5 T5: a raiz deixou de redirecionar para /bots).
      await expect(page).toHaveURL(/\/$/);
    });
  }

  test('/bots abre a conversa do último bot aberto', async ({ page }) => {
    await apiLogin(page.context());
    await page.goto(`/bots/${journeyIds.vendas}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Vendas' })).toBeVisible();
    await page.goto('/bots');
    await expect(page).toHaveURL(`/bots/${journeyIds.vendas}`);
    // Sem nenhum registro de "último", abre o primeiro da lista (ordem alfabética).
    await page.evaluate(() => window.localStorage.clear());
    await page.goto('/bots');
    await expect(page).toHaveURL(/\/bots\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });
});

/** Bot criado pela API com o nome exclusivo da repetição (`uniqueBotName`, E29): o id e o nome, que localiza a linha do painel. `headers` vem de UM login antes de abrir a tela (E22). */
async function createLiveBot(page: Page, headers: SessionHeaders, name: string): Promise<{ id: string; name: string }> {
  const unique = uniqueBotName(name);
  return { id: await createBotViaApi(page, headers, unique), name: unique };
}

test.describe('estado ao vivo na lista de bots, sem execução (T11, F10)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('livre, rotinas pausadas e arquivado: o texto no DOM, a Faísca decorativa e parada, e a lista muda sozinha sem recarregar', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const problems = watchPage(page);
    const headers = await apiHeaders(page);
    const request = page.context().request;
    const free = await createLiveBot(page, headers, 'Vivo livre');
    const sleepy = await createLiveBot(page, headers, 'Vivo pausado');
    const archived = await createLiveBot(page, headers, 'Vivo arquivado');
    const routine = await request.post(`${ORIGIN}/api/routines`, {
      headers,
      data: { name: 'Rotina do vivo', botId: sleepy.id, instruction: 'Resumir o dia', schedule: { type: 'daily', times: ['07:00'] }, timezone: 'America/Sao_Paulo', startsAt: null, endsAt: null, maxRuns: null },
    });
    expect(routine.status(), `criar a rotina: ${await routine.text()}`).toBe(201);
    const routineId = ((await routine.json()) as { id: string }).id;

    try {
      await page.goto(`/bots/${free.id}`);
      await page.evaluate(() => {
        (window as unknown as { __semRecarga: boolean }).__semRecarga = true; // some se a página recarregar: a prova de que a lista mudou sozinha
      });
      const panel = panelOf(page);
      const freeLink = panelBotLink(panel, free.name);
      const sleepyLink = panelBotLink(panel, sleepy.name);

      // Livre: o texto de estado é parte do link (o nome acessível o inclui), a Faísca de 24 px é decorativa e parada, e a linha tem 44 px.
      await expect(freeLink).toHaveAttribute('aria-current', 'page');
      await expect(freeLink).toHaveAccessibleName(new RegExp(`^${escapeRegExp(free.name)}\\s*Livre$`));
      expect(await faiscaLook(freeLink.locator('svg.faisca'))).toMatchObject({ state: 'idle', detail: 'small', still: true, decorative: true, size: [24, 24], body: '#F472B6' });
      await expect(freeLink.getByText('Livre', { exact: true })).toHaveCSS('color', 'rgb(163, 163, 176)'); // --text-muted
      expect(Math.round((await freeLink.boundingBox())!.height)).toBe(44);
      // A rotina ativa não põe o bot para dormir.
      expect(await faiscaLook(sleepyLink.locator('svg.faisca'))).toMatchObject({ state: 'idle' });
      await expect(sleepyLink).toContainText('Livre');

      // Outro dispositivo pausa a rotina e arquiva um bot: a lista acompanha sozinha (no máximo 15 s depois), sem recarregar a página.
      expect((await request.post(`${ORIGIN}/api/routines/${routineId}/pause`, { headers })).status()).toBe(200);
      await archiveBotViaApi(page, headers, archived.id);
      await expect(sleepyLink).toContainText('Rotinas pausadas', { timeout: 25_000 });
      expect(await faiscaLook(sleepyLink.locator('svg.faisca'))).toMatchObject({ state: 'sleep', still: true, decorative: true });
      await expect(sleepyLink).toHaveAccessibleName(new RegExp(`^${escapeRegExp(sleepy.name)}\\s*Rotinas pausadas$`));

      const archivedToggle = panel.getByRole('button', { name: /Arquivados/ });
      await expect(archivedToggle).toBeVisible({ timeout: 25_000 });
      if ((await archivedToggle.getAttribute('aria-expanded')) !== 'true') await archivedToggle.click();
      const archivedLink = panelBotLink(panel.getByRole('list', { name: 'Bots arquivados' }), archived.name);
      await expect(archivedLink).toContainText('Arquivado');
      expect(await faiscaLook(archivedLink.locator('svg.faisca'))).toMatchObject({ state: 'sleep', still: true, decorative: true, size: [24, 24] });
      await expect(archivedLink.getByText('Arquivado', { exact: true })).toHaveCSS('color', 'rgb(163, 163, 176)');
      await expectNoA11yViolations(page);
      await attachShot(page, testInfo, 'lista-1440-livre-pausado-arquivado');

      // Retomar a rotina devolve o bot ao "Livre", também sozinho.
      expect((await request.post(`${ORIGIN}/api/routines/${routineId}/resume`, { headers })).status()).toBe(200);
      await expect(sleepyLink).toContainText('Livre', { timeout: 25_000 });
      expect(await faiscaLook(sleepyLink.locator('svg.faisca'))).toMatchObject({ state: 'idle' });
      expect(await page.evaluate(() => (window as unknown as { __semRecarga?: boolean }).__semRecarga), 'a página não recarregou').toBe(true);
      expect(problems).toEqual([]);
    } finally {
      await request.delete(`${ORIGIN}/api/routines/${routineId}`, { headers }); // deixa as rotinas como encontrou (o spec de rotinas parte do zero)
    }
  });
});

test.describe('bots no mobile (375 × 812)', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('Voltar e Início no celular, editor com erro, aviso de cor e modal de arquivar, sem rolagem horizontal', async ({ page }, testInfo) => {
    const problems = watchPage(page);
    await apiLogin(page.context());
    const longName = 'Assistente-de-operações-financeiras-e-fiscais-do-mês-2026';

    // Editor em 375 px: erro de validação, cabeçalho com Salvar à vista, amostras em mais de uma linha.
    await page.goto('/bots/novo');
    await expectNoHorizontalScroll(page);
    await saveButton(page).click();
    await expect(page.getByText('Informe um nome.')).toBeVisible();
    await expectVisibleFocus(nameField(page));
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'editor-375-erro-validacao');

    // Prévia da Faísca em 375 px: 96 px acima do Nome (coluna única), dentro da viewport e sem rolagem horizontal.
    const preview = faiscaPreview(page);
    expect(await faiscaLook(preview)).toMatchObject({ state: 'idle', detail: 'full', still: true, decorative: true, size: [96, 96] });
    const [previewBox, nameBox] = await Promise.all([preview.boundingBox(), nameField(page).boundingBox()]);
    expect(previewBox!.y + previewBox!.height, 'a prévia fica acima do Nome no celular').toBeLessThanOrEqual(nameBox!.y);
    expect(previewBox!.x + previewBox!.width, 'dentro da viewport').toBeLessThanOrEqual(375);
    await expectNoHorizontalScroll(page);
    await attachShot(page, testInfo, 'editor-375-faisca');

    // Cor personalizada com aviso.
    await fillEditor(page, { name: longName });
    await pickColor(page, 'Personalizada');
    await page.getByLabel('Cor personalizada (hexadecimal)').fill('#1A1A1A');
    await expect(page.getByText('Cor com pouco contraste.')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'editor-375-cor-aviso');

    // Salvar um nome longo e sem espaços: a conversa e o painel truncam ou quebram, sem estourar a largura.
    await saveButton(page).click();
    await expect(page).toHaveURL(/\/bots\/[0-9a-f-]{36}$/);
    const id = page.url().split('/').pop() ?? '';
    await expect(page.getByRole('heading', { level: 2 })).toContainText('faz agora?');
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'conversa-375-vazia');

    // Celular: a conversa não tem barra inferior; "Voltar" leva ao pai fixo (Início), que tem a barra, lista o bot (nome longo truncado) e abre o editor de criação por "Novo bot".
    await expect(tabBarOf(page)).toHaveCount(0);
    await backLink(page).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(tabBarOf(page)).toBeVisible();
    await expect(panelBotLink(contentOf(page), longName)).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'inicio-375-bots');
    await contentOf(page).getByRole('link', { name: 'Novo bot' }).click();
    await expect(page).toHaveURL(/\/bots\/novo$/);
    await expect(tabBarOf(page)).toHaveCount(0);

    // Arquivar no mobile: modal em 375 px; Esc devolve o foco ao botão; confirmar leva à conversa arquivada.
    await page.goto(`/bots/${id}/editar`);
    const archiveTrigger = page.getByRole('button', { name: 'Arquivar bot' });
    await archiveTrigger.click();
    const dialog = page.getByRole('dialog', { name: 'Arquivar este bot?' });
    await expect(dialog).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'modal-arquivar-375');
    await page.keyboard.press('Escape');
    await expect(archiveTrigger).toBeFocused();
    await archiveTrigger.click();
    await dialog.getByRole('button', { name: 'Arquivar', exact: true }).click();
    await expect(page).toHaveURL(`/bots/${id}`);
    await expect(archivedBanner(page)).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'conversa-375-arquivado');
    expect(problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Exclusão definitiva de um bot arquivado (T7; F6, A7, DATA-01). Cada teste cria o PRÓPRIO bot pela API e termina excluindo-o pela
// interface, então nenhum bot sobra e o pressuposto de "lista vazia" do início do arquivo (reset em `beforeAll`) segue valendo na
// repetição. O servidor limita a 5 exclusões por minuto e cada tentativa que chega a ele conta: os três testes fazem uma exclusão real
// cada (os erros são simulados por `page.route`, que não chega ao servidor).
// ---------------------------------------------------------------------------------------------------------------------------------

const DAILY = { schedule: { type: 'daily', times: ['07:00'] }, timezone: 'America/Sao_Paulo', startsAt: null, endsAt: null, maxRuns: null };

/** Cabeçalhos de uma sessão já aberta (cookie, Origin e CSRF); ver `apiHeaders` em fixtures sobre pedir uma vez ANTES de abrir a tela (E22). */
type SessionHeaders = Awaited<ReturnType<typeof apiHeaders>>;

/** Cria um bot pela API (sem modelo: o provedor não está configurado neste spec) e devolve o id. A cor é a Rosa (#F472B6); o personagem não existe mais. */
async function createBotViaApi(page: Page, headers: SessionHeaders, name: string): Promise<string> {
  const created = await page.context().request.post(`${ORIGIN}/api/bots`, {
    headers,
    data: { name, color: '#F472B6', instructions: '', model: null, effort: null, stepLimit: 25 },
  });
  expect(created.status(), `criar o bot ${name}`).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

async function archiveBotViaApi(page: Page, headers: SessionHeaders, id: string): Promise<void> {
  const archived = await page.context().request.post(`${ORIGIN}/api/bots/${id}/archive`, { headers });
  expect(archived.status(), 'arquivar pela API').toBe(200);
}

/** A zona "Arquivamento" do editor (seção com título) e o botão que abre o popup de exclusão. */
const archivalZone = (page: Page) => page.getByRole('region', { name: 'Arquivamento' });
// Por CSS e não por papel: com o popup aberto a zona fica `aria-hidden` e uma consulta por papel não a enxerga (o botão segue na tela, desabilitado).
const zoneDeleteButton = (page: Page) => page.locator('section[aria-labelledby="sec-arquivamento"] button', { hasText: 'Excluir definitivamente' });
/** O popup de exclusão do bot (nome acessível = título do design) e seus controles. */
const deleteDialog = (page: Page, botName: string) => page.getByRole('dialog', { name: `Excluir ${botName} definitivamente?` });
const confirmField = (dialog: Locator) => dialog.getByLabel('Digite o nome do bot para confirmar');
const finalDeleteButton = (dialog: Locator) => dialog.getByRole('button', { name: /^(Excluir definitivamente|Excluindo…)$/ });

/**
 * Registra o caminho de cada `pushState` e `replaceState` do app (a navegação do Next no cliente) e devolve a leitura. `/bots` é só uma
 * parada: com bots ativos a página já se redireciona para a conversa de um deles, então a URL final não prova que o redirect passou por lá.
 */
async function trackHistory(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __paths: string[] }).__paths = seen;
    for (const method of ['pushState', 'replaceState'] as const) {
      const original = history[method].bind(history);
      history[method] = (data: unknown, unused: string, url?: string | URL | null) => {
        original(data, unused, url);
        seen.push(location.pathname);
      };
    }
  });
  return () => page.evaluate(() => (window as unknown as { __paths: string[] }).__paths);
}

/** Requisições do app no formato `MÉTODO /caminho`, na ordem em que saíram (para provar o que foi recarregado depois da exclusão). */
function trackRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => seen.push(`${request.method()} ${new URL(request.url()).pathname}`));
  return seen;
}

test.describe('estado ao vivo no Início do celular (T11, F10; phase 5, T6)', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('o Início mostra o estado de cada linha, trunca o nome e, com o painel do desktop e a barra de ícones montados por baixo, o store faz uma releitura só por ciclo', async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const problems = watchPage(page);
    const headers = await apiHeaders(page);
    const longName = 'Assistente-de-operações-financeiras-e-fiscais-do-mês-vivo';
    const free = await createLiveBot(page, headers, longName);
    const archived = await createLiveBot(page, headers, 'Vivo no Início arquivado');
    await archiveBotViaApi(page, headers, archived.id);

    // Cada leitura da lista de bots (GET /api/bots, sem barra final) desde antes da navegação.
    let reads = 0;
    page.on('request', (captured) => {
      if (captured.method() === 'GET' && new URL(captured.url()).pathname === '/api/bots') reads += 1;
    });
    await page.goto('/');
    const freeLink = panelBotLink(contentOf(page), free.name);

    // Linha de pelo menos 48 px com a Faísca de 32 px e o texto de estado (sem selo, só para o leitor de tela); o nome longo trunca em uma linha (o nome inteiro fica no title) e a página não rola para o lado.
    await expect(freeLink).toContainText('Livre');
    expect(await faiscaLook(freeLink.locator('svg.faisca'))).toMatchObject({ state: 'idle', still: true, decorative: true, size: [32, 32] });
    expect(Math.round((await freeLink.boundingBox())!.height)).toBeGreaterThanOrEqual(48);
    const nameLine = freeLink.getByText(free.name, { exact: true }).first();
    expect(await nameLine.evaluate((element) => element.scrollWidth > element.clientWidth), 'o nome longo é truncado com reticências').toBe(true);
    const toggle = contentOf(page).getByRole('button', { name: /Arquivados/ });
    await toggle.click();
    const archivedLink = panelBotLink(contentOf(page), archived.name);
    await expect(archivedLink).toContainText('Arquivado');
    expect(await faiscaLook(archivedLink.locator('svg.faisca'))).toMatchObject({ state: 'sleep', still: true, size: [32, 32] });
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'inicio-375-estados');

    // O painel do desktop segue montado por baixo (escondido por CSS abaixo de 768 px), a barra de ícones e a barra inferior assinam a lista de bots (a bolinha de Início) e o Início a mostra: mesmo
    // assim a lista é relida UMA vez por ciclo. Contando desde a navegação: a carga inicial e a releitura de 15 s depois, e nenhuma a mais.
    await expect.poll(() => reads, { timeout: 30_000 }).toBe(2);
    await page.waitForTimeout(3_000);
    expect(reads, 'uma releitura por ciclo, não uma por componente montado').toBe(2);
    expect(problems).toEqual([]);
  });
});

test.describe('exclusão definitiva de bot no desktop (1440 × 900)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('arquivar pela interface, abrir o popup, confirmar com o nome exato e excluir: some de tudo e vai para a lista', async ({ page }, testInfo) => {
    const problems = watchPage(page);
    const headers = await apiHeaders(page);
    const name = uniqueBotName('Descartável');
    const id = await createBotViaApi(page, headers, name);
    const routine = await page.context().request.post(`${ORIGIN}/api/routines`, {
      headers,
      data: { name: 'Rotina do descartável', botId: id, instruction: 'Instrução de teste', ...DAILY },
    });
    expect(routine.status(), `criar a rotina: ${await routine.text()}`).toBe(201);
    const routineId = ((await routine.json()) as { id: string }).id;

    // Bot ativo: a zona só oferece arquivar; excluir exige o arquivamento antes.
    await page.goto(`/bots/${id}/editar`);
    await expect(page.getByRole('button', { name: 'Arquivar bot' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Excluir definitivamente' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Arquivar bot' }).click();
    await page.getByRole('dialog', { name: 'Arquivar este bot?' }).getByRole('button', { name: 'Arquivar', exact: true }).click();
    await expect(page).toHaveURL(`/bots/${id}`);
    await expect(archivedBanner(page)).toBeVisible();

    // Bot arquivado: a zona mostra "Desarquivar" à esquerda e "Excluir definitivamente" (perigo) à direita, na mesma linha.
    await page.goto(`/bots/${id}/editar`);
    await expect(archivalZone(page).getByText('Este bot está arquivado.')).toBeVisible();
    const restore = archivalZone(page).getByRole('button', { name: 'Desarquivar' });
    const openDelete = zoneDeleteButton(page);
    await expect(openDelete).toBeVisible();
    // A carga das regras acima empurra esta zona ao trocar o esqueleto pela lista; as duas medidas devem usar o estado carregado.
    await expect(page.getByText('Este bot segue as regras globais.', { exact: true })).toBeVisible();
    const restoreBox = await restore.boundingBox();
    const deleteBox = await openDelete.boundingBox();
    expect(deleteBox!.x, 'excluir à direita de desarquivar').toBeGreaterThan(restoreBox!.x + restoreBox!.width);
    expect(Math.abs(deleteBox!.y - restoreBox!.y), 'as duas ações na mesma linha').toBeLessThan(2);
    await expect(openDelete).toHaveCSS('color', 'rgb(248, 113, 113)'); // --danger
    await expectNoA11yViolations(page);
    await archivalZone(page).scrollIntoViewIfNeeded();
    await attachShot(page, testInfo, 'editor-1440-zona-arquivado');

    // Popup: título com o nome, lista do que é apagado, aviso, campo com o foco inicial e o botão final desabilitado.
    const dialog = deleteDialog(page, name);
    const field = confirmField(dialog);
    const finalButton = finalDeleteButton(dialog);
    await openDelete.click();
    await expect(dialog).toBeVisible();
    // O título leva a Faísca do bot DORMINDO: 48 px (nível completo), parada, decorativa e na cor do bot; o nome acessível do popup segue sendo só o título.
    const sleeper = dialog.locator('svg.faisca');
    await expect(sleeper).toHaveCount(1);
    // A entrada do popup usa scale(0.97) por 200 ms: o tamanho medido só vale depois dela.
    await expect.poll(async () => (await faiscaLook(sleeper)).size, { message: 'Faísca de 48 px depois da entrada do popup' }).toEqual([48, 48]);
    expect(await faiscaLook(sleeper)).toMatchObject({ state: 'sleep', detail: 'full', still: true, decorative: true, body: '#F472B6' });
    await expect(dialog.getByRole('heading', { name: `Excluir ${name} definitivamente?` })).toBeVisible();
    const titleBox = await dialog.getByRole('heading').boundingBox();
    const sleeperBox = await sleeper.boundingBox();
    expect(sleeperBox!.x + sleeperBox!.width, 'Faísca à esquerda do título').toBeLessThanOrEqual(titleBox!.x);
    for (const item of [
      'A conversa e todas as mensagens',
      'As execuções e as aprovações',
      'A memória e o histórico de versões',
      'As rotinas e o histórico delas',
      'As regras de aprovação deste bot',
    ]) {
      await expect(dialog.getByRole('listitem').filter({ hasText: item })).toBeVisible();
    }
    await expect(dialog).toContainText('Não há como desfazer. O registro de auditoria permanece, sem o nome do bot.');
    await expect(dialog.getByText(name, { exact: true }).last()).toHaveCSS('font-family', /JetBrains Mono|monospace/);
    await expectVisibleFocus(field);
    await expect(field).toHaveAttribute('autocomplete', 'off');
    await expect(field).toHaveAttribute('spellcheck', 'false');
    await expect(field).toHaveAttribute('autocapitalize', 'none');
    await expect(field).toHaveCSS('font-size', '14px');
    await expect(finalButton).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeEnabled();
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'modal-excluir-1440-desabilitado');

    // Comparação exata, sem aviso enquanto digita: parcial, caixa diferente e espaço sobrando não habilitam.
    await field.fill(name.slice(0, -1));
    await expect(finalButton).toBeDisabled();
    await field.fill(name.toUpperCase());
    await expect(finalButton).toBeDisabled();
    await field.fill(`${name} `);
    await expect(finalButton).toBeDisabled();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await field.fill(name);
    await expect(finalButton).toBeEnabled();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await attachShot(page, testInfo, 'modal-excluir-1440-habilitado');

    // Teclado: Tab do campo vai a "Cancelar" e depois ao botão final, com foco visível; Esc fecha (fora do estado "excluindo") e devolve o
    // foco ao botão da zona; ao reabrir o texto digitado foi descartado.
    await page.keyboard.press('Tab');
    await expectVisibleFocus(dialog.getByRole('button', { name: 'Cancelar' }));
    await page.keyboard.press('Tab');
    await expectVisibleFocus(finalButton);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(openDelete).toBeFocused();
    await openDelete.click();
    await expect(field).toHaveValue('');
    await expectVisibleFocus(field);
    await expect(finalButton).toBeDisabled();
    await field.fill(name);

    // "Excluindo…": a chamada fica retida; o botão mostra o spinner, "Cancelar" e o campo travam, e nem Esc nem o clique fora fecham.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(`**/api/bots/${id}`, async (route) => {
      if (route.request().method() !== 'DELETE') return route.fallback();
      await gate;
      return route.continue();
    });
    const requests = trackRequests(page);
    const history = await trackHistory(page);
    const deleteRequest = page.waitForRequest((request) => request.method() === 'DELETE' && request.url().endsWith(`/api/bots/${id}`));
    const deleteResponse = page.waitForResponse((response) => response.request().method() === 'DELETE' && response.url().endsWith(`/api/bots/${id}`));
    await finalButton.click();
    expect((await deleteRequest).postData(), 'corpo da exclusão').toBe(JSON.stringify({ confirmName: name }));
    await expect(finalButton).toHaveText('Excluindo…');
    await expect(finalButton).toBeDisabled();
    await expect(finalButton.locator('[data-icon="LoaderCircle"]')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    await expect(field).toHaveJSProperty('readOnly', true);
    await page.keyboard.press('Escape');
    await page.mouse.click(8, 8);
    await expect(dialog).toBeVisible();
    await expect(openDelete).toBeDisabled();
    await attachShot(page, testInfo, 'modal-excluir-1440-excluindo');

    // Libera: o servidor apaga (204 sem corpo), o popup fecha, o toast aparece e o dono passa pela lista de bots.
    release();
    const response = await deleteResponse;
    expect(response.status(), 'status da exclusão').toBe(204);
    await expect(toast(page, 'Bot excluído')).toBeVisible();
    await expect(dialog).toBeHidden();
    expect(await history()).toContain('/bots');
    await expect(page).not.toHaveURL(new RegExp(id));
    await attachShot(page, testInfo, 'lista-1440-depois-de-excluir');

    // A interface recarregou o que guarda em estado (lista de bots, rotinas e contador de aprovações pendentes) logo depois da exclusão.
    await expect
      .poll(() => requests.slice(requests.indexOf(`DELETE /api/bots/${id}`) + 1))
      .toEqual(expect.arrayContaining(['GET /api/bots', 'GET /api/routines', 'GET /api/approvals/pending-count']));
    await expect(panelBotLink(panelOf(page), name)).toHaveCount(0);

    // O servidor apagou tudo do bot: ele, a rotina dele e (sem aprovação pendente neste spec) o contador segue em zero.
    const request = page.context().request;
    expect((await request.get(`${ORIGIN}/api/bots/${id}`, { headers })).status(), 'bot excluído').toBe(404);
    const bots = (await (await request.get(`${ORIGIN}/api/bots`, { headers })).json()) as { bots: { id: string }[] };
    expect(bots.bots.map((bot) => bot.id)).not.toContain(id);
    const routines = (await (await request.get(`${ORIGIN}/api/routines`, { headers })).json()) as { routines: { id: string }[] };
    expect(routines.routines.map((item) => item.id)).not.toContain(routineId);
    expect(((await (await request.get(`${ORIGIN}/api/approvals/pending-count`, { headers })).json()) as { count: number }).count).toBe(0);
    await expect(page.getByRole('link', { name: /Aprovações, \d+ pendente/ })).toHaveCount(0);
    expect(problems).toEqual([]);
  });

  test('cada erro do servidor aparece no popup, mantém o texto digitado e deixa tentar de novo', async ({ page }, testInfo) => {
    const problems = watchPage(page);
    const headers = await apiHeaders(page);
    const name = uniqueBotName('Descartável com erros');
    const id = await createBotViaApi(page, headers, name);
    await archiveBotViaApi(page, headers, id);
    await page.goto(`/bots/${id}/editar`);

    const GENERIC = 'Não foi possível excluir o bot. Nada foi apagado.';
    // O nome que não confere só é alcançável por resposta simulada: o botão não habilita com um nome diferente.
    const scenarios = [
      { slug: 'nome-nao-confere', status: 422, body: { code: 'VALIDATION_FAILED', message: 'Dados inválidos.', fields: [{ field: 'confirmName', reason: 'O nome digitado não confere.' }] }, text: 'O nome digitado não confere.' },
      { slug: 'nao-arquivado', status: 409, body: { code: 'BOT_NOT_ARCHIVED', message: 'Arquive o bot antes de excluir.' }, text: 'Arquive o bot antes de excluir.' },
      {
        slug: 'execucao-aberta',
        status: 409,
        body: { code: 'BOT_HAS_OPEN_RUN', message: 'O bot tem execuções em andamento ou na fila. Aguarde terminarem ou pare-as e tente de novo.' },
        text: 'O bot tem execuções em andamento ou na fila. Aguarde terminarem ou pare-as e tente de novo.',
      },
      { slug: 'limite', status: 429, body: { code: 'RATE_LIMITED', message: 'Muitas solicitações. Aguarde um instante e tente novamente.' }, text: 'Muitas solicitações. Aguarde um instante e tente novamente.' },
      { slug: 'falha-do-servidor', status: 500, body: { code: 'INTERNAL_ERROR', message: 'Erro interno. Tente novamente.' }, text: GENERIC },
      { slug: 'nao-encontrado', status: 404, body: { code: 'BOT_NOT_FOUND', message: 'Bot não encontrado.' }, text: GENERIC },
      { slug: 'sem-rede', status: 0, body: null, text: GENERIC },
    ] as const;
    let current: (typeof scenarios)[number] | null = null;
    await page.route(`**/api/bots/${id}`, (route) => {
      if (route.request().method() !== 'DELETE' || !current) return route.fallback();
      if (current.status === 0) return route.abort('failed');
      return route.fulfill({ status: current.status, contentType: 'application/json', body: JSON.stringify(current.body) });
    });

    const dialog = deleteDialog(page, name);
    const field = confirmField(dialog);
    const finalButton = finalDeleteButton(dialog);
    await zoneDeleteButton(page).click();
    await field.fill(name);
    for (const scenario of scenarios) {
      current = scenario;
      await finalButton.click();
      const alert = dialog.getByRole('alert');
      await expect(alert).toHaveText(scenario.text);
      // O popup segue aberto, com o texto digitado, o botão e o "Cancelar" de volta e o foco no campo (quem usa teclado corrige dali).
      await expect(dialog).toBeVisible();
      await expect(field).toHaveValue(name);
      await expect(finalButton).toHaveText('Excluir definitivamente');
      await expect(finalButton).toBeEnabled();
      await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeEnabled();
      await expectVisibleFocus(field);
      // O erro fica acima das ações.
      const alertBox = await alert.boundingBox();
      const actionsBox = await finalButton.boundingBox();
      expect(alertBox!.y + alertBox!.height, 'erro acima das ações').toBeLessThanOrEqual(actionsBox!.y);
      if (scenario.slug === 'nome-nao-confere') await expectNoA11yViolations(page);
      await attachShot(page, testInfo, `modal-excluir-1440-erro-${scenario.slug}`);
    }

    // Corrigir o texto apaga o erro da tentativa anterior; o texto errado volta a desabilitar o botão.
    await field.fill(`${name}x`);
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expect(finalButton).toBeDisabled();
    await field.fill(name);

    // Sem a simulação, a mesma tentativa passa: o popup fecha e o bot é excluído (também limpa o bot deste teste).
    current = null;
    await finalButton.click();
    await expect(toast(page, 'Bot excluído')).toBeVisible();
    await expect(dialog).toBeHidden();
    expect((await page.context().request.get(`${ORIGIN}/api/bots/${id}`, { headers })).status(), 'bot excluído').toBe(404);
    // As únicas recusas são as simuladas com status HTTP (a queda de rede não é resposta).
    expect(problems).toEqual(
      scenarios.filter((scenario) => scenario.status > 0).map((scenario) => `${scenario.status} DELETE /api/bots/${id}`),
    );
  });
});

test.describe('exclusão definitiva de bot no mobile (375 × 812)', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('ações empilhadas, popup na largura da tela, erro, "Excluindo…" e exclusão, sem rolagem horizontal', async ({ page }, testInfo) => {
    const problems = watchPage(page);
    const headers = await apiHeaders(page);
    // Nome longo e sem espaços: o título e o rótulo do campo quebram em qualquer ponto em vez de estourar a largura.
    const name = uniqueBotName('Operações-fiscais-e-financeiras-do-trimestre-2026');
    const id = await createBotViaApi(page, headers, name);
    await archiveBotViaApi(page, headers, id);

    // Zona do editor: as duas ações empilham em largura total, com "Excluir definitivamente" por último.
    await page.goto(`/bots/${id}/editar`);
    await expectNoHorizontalScroll(page);
    const openDelete = zoneDeleteButton(page);
    await openDelete.scrollIntoViewIfNeeded(); // as duas caixas são lidas depois da rolagem: as coordenadas são da viewport
    const restoreBox = await archivalZone(page).getByRole('button', { name: 'Desarquivar' }).boundingBox();
    const deleteBox = await openDelete.boundingBox();
    expect(deleteBox!.y, 'excluir abaixo de desarquivar').toBeGreaterThan(restoreBox!.y + restoreBox!.height);
    expect(deleteBox!.width, 'largura total').toBeCloseTo(restoreBox!.width, 0);
    expect(deleteBox!.width).toBeGreaterThan(300);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'editor-375-zona-arquivado');

    // Popup: 16 px de margem de cada lado, dentro da viewport, campo de 16 px, ações empilhadas com a de perigo por último.
    const dialog = deleteDialog(page, name);
    const field = confirmField(dialog);
    const finalButton = finalDeleteButton(dialog);
    await openDelete.click();
    await expect(dialog).toBeVisible();
    // A Faísca dormindo do título também cabe em 375 px (o nome longo quebra ao lado dela, sem estourar a largura).
    const sleeper = dialog.locator('svg.faisca');
    await expect.poll(async () => (await faiscaLook(sleeper)).size, { message: 'Faísca de 48 px depois da entrada do popup' }).toEqual([48, 48]);
    expect(await faiscaLook(sleeper)).toMatchObject({ state: 'sleep', still: true, decorative: true });
    await expectVisibleFocus(field);
    await expect(field).toHaveCSS('font-size', '16px');
    // A entrada do popup usa scale(0.97) por 200 ms: a medida só vale depois dela.
    await expect.poll(async () => (await dialog.boundingBox())!.x, { message: 'margem esquerda' }).toBeCloseTo(16, 0);
    // A margem entra na tolerância antes da largura; ambas precisam estabilizar durante a entrada de 200 ms.
    await expect.poll(async () => (await dialog.boundingBox())!.width, { message: 'largura do popup' }).toBeCloseTo(375 - 32, 0);
    const box = await dialog.boundingBox();
    expect(box!.width, 'largura do popup').toBeCloseTo(375 - 32, 0);
    expect(box!.y + box!.height, 'cabe na altura').toBeLessThanOrEqual(812);
    const cancelBox = await dialog.getByRole('button', { name: 'Cancelar' }).boundingBox();
    const finalBox = await finalButton.boundingBox();
    expect(finalBox!.y, 'excluir abaixo de cancelar').toBeGreaterThan(cancelBox!.y + cancelBox!.height);
    expect(finalBox!.width, 'ações em largura total').toBeCloseTo(cancelBox!.width, 0);
    await expect(finalButton).toBeDisabled();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'modal-excluir-375-desabilitado');
    await field.fill(name);
    await expect(finalButton).toBeEnabled();
    await attachShot(page, testInfo, 'modal-excluir-375-habilitado');

    // Um erro simulado (a frase mais longa) e depois a chamada retida, que segue para o servidor de verdade quando liberada.
    let mode: 'erro' | 'retida' = 'erro';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(`**/api/bots/${id}`, async (route) => {
      if (route.request().method() !== 'DELETE') return route.fallback();
      if (mode === 'erro') {
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ code: 'BOT_HAS_OPEN_RUN', message: 'O bot tem execuções em andamento ou na fila. Aguarde terminarem ou pare-as e tente de novo.' }),
        });
      }
      await gate;
      return route.continue();
    });
    await finalButton.click();
    await expect(dialog.getByRole('alert')).toHaveText('O bot tem execuções em andamento ou na fila. Aguarde terminarem ou pare-as e tente de novo.');
    await expect(field).toHaveValue(name);
    await expect(finalButton).toBeEnabled();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'modal-excluir-375-erro');

    mode = 'retida';
    const deleteResponse = page.waitForResponse((response) => response.request().method() === 'DELETE' && response.url().endsWith(`/api/bots/${id}`));
    await finalButton.click();
    await expect(finalButton).toHaveText('Excluindo…');
    await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.mouse.click(8, 8);
    await expect(dialog).toBeVisible();
    await expectNoHorizontalScroll(page);
    await attachShot(page, testInfo, 'modal-excluir-375-excluindo');

    release();
    expect((await deleteResponse).status(), 'status da exclusão').toBe(204);
    await expect(toast(page, 'Bot excluído')).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(page).not.toHaveURL(new RegExp(id));
    await expectNoHorizontalScroll(page);
    await attachShot(page, testInfo, 'lista-375-depois-de-excluir');
    expect((await page.context().request.get(`${ORIGIN}/api/bots/${id}`, { headers })).status(), 'bot excluído').toBe(404);
    expect(problems).toEqual([`409 DELETE /api/bots/${id}`]);
  });
});

// E2E da memória (T8; A11, MEM-01, MEM-02; F11) no navegador real, contra a pilha de produção (Postgres, API, worker, Next e proxy) com
// o OpenCode Go FALSO. O modelo falso edita a memória por marcadores no texto: [memoria:texto] acrescenta ao fim, [memoria-global:texto]
// tenta apontar para a memória global (argumento fora do contrato) (ver packages/core/src/testing/fake-upstreams.ts).
//
// Cobre: o editor da memória do bot (contador, aviso e bloqueio acima do limite, salvar, última alteração, e o texto digitado durante o
// salvamento, que não pode ser sobrescrito pela resposta: R11), o drawer de histórico (lista,
// diff rico da T14 com fundo por estado, prefixos e quebra de linha longa, restaurar, restaurar bloqueado com texto não salvo), o
// conflito por versão (o texto digitado é preservado; copiar e recarregar), o cartão "Memória atualizada" na conversa com o mesmo
// diff rico e desfazer (e o desfazer recusado quando a memória já mudou), e a
// memória global (salvar, persistir e o bot não consegue escrever nela), em 1440 e 375 px, com axe em cada estado. O cabeçalho da memória do bot mostra o
// Faísca parada dele. A memória global é
// estado de todos os bots, então o arquivo é serial e roda no projeto `chromium-memory`, depois das aprovações.
import type { Locator, Page } from '@playwright/test';
import { ORIGIN, apiHeaders, attachShot, uniqueBotName, ensureCredential, expect, expectNoA11yViolations, expectNoHorizontalScroll, faiscaLook, openWorkLine, test, watchPage } from './support/fixtures';

test.describe.configure({ mode: 'serial' });

const PROVIDER_KEY = 'valid-e2e-memoria-1111';

/** Cria um bot pela API com o nome exclusivo da repetição (`uniqueBotName`, E29) e devolve o id. */
async function createBot(page: Page, name: string, color = '#60A5FA'): Promise<string> {
  const unique = uniqueBotName(name);
  const response = await page.context().request.post(`${ORIGIN}/api/bots`, {
    headers: await apiHeaders(page),
    data: { name: unique, color, instructions: '', model: 'opencode/glm-5.1', effort: null, stepLimit: 25 },
  });
  expect(response.status(), `criar o bot ${unique}`).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/**
 * Grava a memória pela API (simula "outra aba") sobre a versão atual; devolve a versão nova. `apiHeaders` faz um login novo e troca o cookie
 * do contexto, o que invalida o token CSRF de uma tela já aberta: quem grava DEPOIS de abrir a tela passa os `headers` obtidos antes
 * dela, para a sessão da tela continuar valendo.
 */
async function putMemory(page: Page, path: string, content: string, sessionHeaders?: Record<string, string>): Promise<number> {
  const headers = sessionHeaders ?? (await apiHeaders(page));
  const current = (await (await page.context().request.get(`${ORIGIN}${path}`, { headers })).json()) as { version: number };
  const saved = await page.context().request.put(`${ORIGIN}${path}`, { headers, data: { content, expectedVersion: current.version } });
  expect(saved.status(), 'gravar a memória pela API').toBe(200);
  return ((await saved.json()) as { version: number }).version;
}

/** Um item do diff como o navegador o desenhou: estado, prefixo visível, fundo calculado (canais RGBA), altura e se ele estoura a lista. */
interface DiffRow {
  kind: string | null;
  prefix: string;
  background: number[];
  height: number;
  sticksOut: boolean;
}

/**
 * Lê o desenho de uma lista de diff (T14): os itens, os tokens `--success-soft` e `--danger-soft` (para comparar o fundo com o token em
 * vez de fixar uma cor no teste) e se a lista ou algum item é mais largo que a própria caixa, que é o que seria uma rolagem horizontal.
 */
async function readDiff(list: Locator): Promise<{ overflowsX: boolean; tokens: Record<'add' | 'remove', number[]>; rows: DiffRow[] }> {
  return list.evaluate((ul) => {
    const channels = (value: string): number[] => (value.match(/[\d.]+/g) ?? []).map(Number);
    // O CSS minificado grava o token em hexadecimal (#f871711f), então o valor é resolvido pelo navegador como cor calculada.
    const tokenColor = (name: string): number[] => {
      const probe = document.createElement('i');
      probe.style.backgroundColor = `var(${name})`;
      document.body.append(probe);
      const value = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return channels(value);
    };
    const listRight = ul.getBoundingClientRect().right;
    return {
      overflowsX: ul.scrollWidth > ul.clientWidth,
      tokens: { add: tokenColor('--success-soft'), remove: tokenColor('--danger-soft') },
      rows: [...ul.children].map((item) => {
        const box = item.getBoundingClientRect();
        return {
          kind: item.getAttribute('data-diff-kind'),
          prefix: item.children[0]?.textContent ?? '',
          background: channels(getComputedStyle(item).backgroundColor),
          height: box.height,
          sticksOut: box.right > listRight + 0.5 || item.scrollWidth > item.clientWidth,
        };
      }),
    };
  });
}

/** O fundo calculado é o do token do estado: mesmos canais RGB e a mesma opacidade (o navegador arredonda o alfa para 8 bits). */
function expectBackground(row: DiffRow, token: number[]): void {
  expect(row.background.slice(0, 3), `fundo do item ${row.kind}`).toEqual(token.slice(0, 3));
  expect(row.background[3] ?? 1, `opacidade do fundo do item ${row.kind}`).toBeCloseTo(token[3] ?? 1, 1);
}

/** Linha igual (contexto): sem fundo, ou seja, transparente. */
function expectNoBackground(row: DiffRow): void {
  expect(row.background[3], `o item ${row.kind} não tem fundo`).toBe(0);
}

const editor = (page: Page, name: string) => page.getByRole('textbox', { name });
const save = (page: Page) => page.getByRole('button', { name: 'Salvar' });
const history = (page: Page) => page.getByRole('dialog', { name: 'Histórico de versões' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Mensagem' });
const memoryCards = (page: Page) => page.getByRole('region', { name: 'Memória atualizada' });

test('o dono edita a memória do bot: contador, limite, salvar e última alteração, em 1440 e 375 px', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  await ensureCredential(page, 'provider', PROVIDER_KEY);
  await page.setViewportSize({ width: 1440, height: 900 });
  const botId = await createBot(page, 'Memorioso', '#60A5FA');
  await page.goto(`/bots/${botId}/memoria`);

  // Vazia: título com o nome do bot, placeholder, contador zerado, Salvar desabilitado (nada a salvar).
  await expect(page.getByRole('heading', { name: `Memória de ${uniqueBotName('Memorioso')}`, level: 1 })).toBeVisible();
  // O cabeçalho do bot mostra a Faísca dele: 32 px, parada e ociosa, na cor do bot. Só a do cabeçalho: o painel
  // de bots ao lado também tem Faíscas, por isso o localizador parte do título.
  const headerFaisca = page.getByRole('heading', { name: `Memória de ${uniqueBotName('Memorioso')}`, level: 1 }).locator('..').locator('svg.faisca');
  expect(await faiscaLook(headerFaisca)).toMatchObject({ state: 'idle', detail: 'small', still: true, decorative: true, size: [32, 32], body: '#60A5FA' });
  const box = editor(page, `Memória de ${uniqueBotName('Memorioso')}`);
  await expect(box).toHaveAttribute('placeholder', 'Anotações que o bot deve lembrar');
  await expect(page.getByText('0 / 8.000')).toBeVisible();
  await expect(page.getByText('Ainda sem alterações.')).toBeVisible();
  await expect(save(page)).toBeDisabled();
  await expectNoA11yViolations(page);

  // Digitar habilita Salvar; salvar mostra o toast e a última alteração.
  await box.fill('Dono mora em São Paulo.\nPrefere respostas curtas.');
  await expect(save(page)).toBeEnabled();
  await save(page).click();
  await expect(page.getByText('Memória salva', { exact: true })).toBeVisible();
  await expect(page.getByText(/Última alteração por Você/)).toBeVisible();
  await expect(save(page)).toBeDisabled();

  // Limite: 7.500 caracteres ainda salvam (contador em aviso); 8.001 bloqueiam o Salvar com a mensagem junto do contador.
  await box.fill('a'.repeat(7500));
  await expect(page.getByText('7.500 / 8.000')).toBeVisible();
  await expect(save(page)).toBeEnabled();
  await box.fill('a'.repeat(8001));
  await expect(page.getByText('8.001 / 8.000')).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'A memória passou de 8.000 caracteres' })).toBeVisible();
  await expect(save(page)).toBeDisabled();
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'memoria-limite-1440');
  await box.fill('a'.repeat(8000));
  await expect(save(page)).toBeEnabled();
  await save(page).click();
  await expect(page.getByText('8.000 / 8.000')).toBeVisible();
  await expect(save(page)).toBeDisabled();
  await box.fill('Dono mora em São Paulo.\nPrefere respostas curtas.\nFuso: Brasília.');
  await save(page).click();
  await expect(save(page)).toBeDisabled();

  // 375 px: coluna única, sem rolagem horizontal.
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByText(/\d{1,3}(\.\d{3})? \/ 8\.000/)).toBeVisible();
  expect(await faiscaLook(headerFaisca), 'a Faísca do cabeçalho segue com 32 px').toMatchObject({ size: [32, 32] });
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'memoria-bot-375');
  expect(problems).toEqual([]);
});

test('texto digitado enquanto o salvamento está em andamento não é descartado: continua no editor, não salvo, e salva na vez seguinte (R11)', async ({ page }) => {
  const problems = watchPage(page);
  await ensureCredential(page, 'provider', PROVIDER_KEY);
  await page.setViewportSize({ width: 1440, height: 900 });
  const botId = await createBot(page, 'Digitador');
  await page.goto(`/bots/${botId}/memoria`);
  const box = editor(page, `Memória de ${uniqueBotName('Digitador')}`);

  // Segura a resposta do PUT: a janela em que o dono segue digitando fica aberta pelo tempo que o teste precisar (em rede móvel ela dura segundos).
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/bots/${botId}/memory`, async (route) => {
    if (route.request().method() === 'PUT') await held;
    await route.continue();
  });

  const sent = 'Primeira anotação.';
  const typedLater = `${sent}\nSegunda, digitada durante o salvamento.`;
  await box.fill(sent);
  await save(page).click();
  await expect(save(page)).toBeDisabled(); // salvando
  await box.fill(typedLater);
  release();

  // A resposta chegou: o salvo virou a versão atual, mas o que o dono digitou depois NÃO foi sobrescrito, e ainda conta como não salvo.
  await expect(page.getByText('Memória salva', { exact: true })).toBeVisible();
  await expect(box).toHaveValue(typedLater);
  await expect(save(page)).toBeEnabled();

  // Salvar de novo grava o texto completo, e ele sobrevive a recarregar a página.
  const second = page.waitForResponse((response) => response.request().method() === 'PUT' && response.url().endsWith(`/api/bots/${botId}/memory`));
  await save(page).click();
  expect((await second).status(), 'o segundo salvamento grava o texto completo').toBe(200);
  await page.unroute(`**/api/bots/${botId}/memory`);
  await page.reload();
  await expect(editor(page, `Memória de ${uniqueBotName('Digitador')}`)).toHaveValue(typedLater);
  expect(problems).toEqual([]);
});

test('o histórico lista as versões com o diff rico (fundo por estado e prefixos) e restaura como versão nova; com texto não salvo, restaurar fica bloqueado', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  await ensureCredential(page, 'provider', PROVIDER_KEY);
  await page.setViewportSize({ width: 1440, height: 900 });
  const botId = await createBot(page, 'Historiador', '#F472B6');
  const path = `/api/bots/${botId}/memory`;
  // A linha da versão 2 tem 200 caracteres sem espaço: só quebra se o diff quebrar em qualquer ponto (T14), no drawer de 420 px e em 375 px.
  const longLine = `Linha da segunda. ${'x'.repeat(200)}`;
  await putMemory(page, path, 'Primeira versão.');
  await putMemory(page, path, `Primeira versão.\n${longLine}`);
  await putMemory(page, path, 'Terceira versão inteira.');
  await page.goto(`/bots/${botId}/memoria`);
  const box = editor(page, `Memória de ${uniqueBotName('Historiador')}`);
  await expect(box).toHaveValue('Terceira versão inteira.');

  await page.getByRole('button', { name: 'Histórico' }).click();
  const drawer = history(page);
  await expect(drawer).toBeVisible();
  // Lista: mais recente primeiro, a atual marcada, autor "Você" e o resumo de linhas.
  await expect(drawer.getByRole('button', { name: /Versão 3/ })).toContainText('atual');
  await expect(drawer.getByRole('button', { name: /Versão 3/ })).toContainText('Você');
  await expect(drawer.getByRole('button', { name: /Versão 3/ })).toContainText('+1 −2 linhas');
  await expect(drawer.getByRole('button', { name: /Versão 1/ })).toContainText('+1 −0 linha');
  await expectNoA11yViolations(page);

  // Detalhe: diff rico. Cada linha que mudou tem o fundo do estado (token -soft) E o prefixo visível, então a mudança não depende só da
  // cor; a lista não passa da própria largura (a linha de 200 caracteres sem espaço quebra dentro do drawer).
  await drawer.getByRole('button', { name: /Versão 3/ }).click();
  const diff = drawer.getByRole('list', { name: 'Mudanças da versão 3' });
  await expect(diff).toContainText('Terceira versão inteira.');
  await expect(diff).toContainText('Linha da segunda.');
  const richDiff = await readDiff(diff);
  expect(richDiff.rows.map((row) => [row.kind, row.prefix])).toEqual([
    ['remove', '−'],
    ['remove', '−'],
    ['add', '+'],
  ]);
  expectBackground(richDiff.rows[0]!, richDiff.tokens.remove);
  expectBackground(richDiff.rows[1]!, richDiff.tokens.remove);
  expectBackground(richDiff.rows[2]!, richDiff.tokens.add);
  expect(richDiff.tokens.add, 'o fundo de adicionada é diferente do de removida').not.toEqual(richDiff.tokens.remove);
  expect(richDiff.rows[1]!.height, 'a linha longa ocupa várias linhas visuais').toBeGreaterThan(40);
  expect(richDiff.overflowsX || richDiff.rows.some((row) => row.sticksOut), 'o diff não rola na horizontal').toBe(false);
  await expectNoA11yViolations(page); // contraste do texto e do prefixo sobre os fundos de removida e adicionada
  await attachShot(page, testInfo, 'memoria-historico-diff-removidas-1440');
  await expect(drawer.getByText('Esta é a versão atual.')).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Restaurar esta versão' })).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Versões' }).click();
  await drawer.getByRole('button', { name: /Versão 2/ }).click();
  await expect(drawer.getByRole('list', { name: 'Mudanças da versão 2' })).toContainText('Linha da segunda.');
  // A linha igual (contexto) fica sem fundo ao lado da adicionada.
  const contextDiff = await readDiff(drawer.getByRole('list', { name: 'Mudanças da versão 2' }));
  expect(contextDiff.rows.map((row) => [row.kind, row.prefix])).toEqual([
    ['same', ' '],
    ['add', '+'],
  ]);
  expectNoBackground(contextDiff.rows[0]!);
  expectBackground(contextDiff.rows[1]!, contextDiff.tokens.add);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'memoria-historico-diff-1440');

  // Com texto não salvo no editor, restaurar fica bloqueado e explica o motivo.
  await drawer.getByRole('button', { name: 'Fechar histórico' }).click();
  await box.fill('Terceira versão inteira. E mais um pouco.');
  await page.getByRole('button', { name: 'Histórico' }).click();
  await drawer.getByRole('button', { name: /Versão 1/ }).click();
  await expect(drawer.getByRole('button', { name: 'Restaurar esta versão' })).toBeDisabled();
  await expect(drawer.getByText(/Salve ou descarte o texto digitado/)).toBeVisible();
  await drawer.getByRole('button', { name: 'Fechar histórico' }).click();
  await box.fill('Terceira versão inteira.');

  // Restaurar a versão 1: vira a versão 4 (o histórico não é reescrito) e o editor mostra o texto.
  await page.getByRole('button', { name: 'Histórico' }).click();
  await drawer.getByRole('button', { name: /Versão 1/ }).click();
  await drawer.getByRole('button', { name: 'Restaurar esta versão' }).click();
  await expect(page.getByText('Versão restaurada', { exact: true })).toBeVisible();
  await expect(drawer).toHaveCount(0);
  await expect(box).toHaveValue('Primeira versão.');
  await page.getByRole('button', { name: 'Histórico' }).click();
  await expect(drawer.getByRole('button', { name: /Versão 4/ })).toContainText('restaurada da versão 1');
  await expect(drawer.getByRole('button', { name: /Versão 1/ })).toBeVisible();

  // 375 px: o drawer ocupa a tela inteira, com o botão de voltar (Versões) no detalhe.
  await page.setViewportSize({ width: 375, height: 812 });
  await drawer.getByRole('button', { name: /Versão 2/ }).click();
  const width = (await drawer.boundingBox())?.width ?? 0;
  expect(width, 'o drawer ocupa a largura da tela em 375 px').toBeGreaterThanOrEqual(370);
  await expect(drawer.getByRole('button', { name: 'Versões' })).toBeVisible();
  // Em 375 px o diff continua legível: a linha longa quebra em várias linhas visuais, mantém fundo e prefixo e nada passa da largura.
  const narrowDiff = await readDiff(drawer.getByRole('list', { name: 'Mudanças da versão 2' }));
  expect(narrowDiff.rows.map((row) => [row.kind, row.prefix])).toEqual([
    ['same', ' '],
    ['add', '+'],
  ]);
  expectBackground(narrowDiff.rows[1]!, narrowDiff.tokens.add);
  expect(narrowDiff.rows[1]!.height, 'a linha longa quebra em 375 px').toBeGreaterThan(60);
  expect(narrowDiff.overflowsX || narrowDiff.rows.some((row) => row.sticksOut), 'o diff não rola na horizontal em 375 px').toBe(false);
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'memoria-historico-diff-375');
  expect(problems).toEqual([]);
});

test('em 375 px o toast entra abaixo do cabeçalho do drawer reaberto logo depois de uma ação, sem cobrir o título nem os botões (E25)', async ({ page }) => {
  const problems = watchPage(page);
  await ensureCredential(page, 'provider', PROVIDER_KEY);
  await page.setViewportSize({ width: 375, height: 812 });
  const botId = await createBot(page, 'Toasteiro');
  const path = `/api/bots/${botId}/memory`;
  await putMemory(page, path, 'Primeira versão.');
  await putMemory(page, path, 'Segunda versão.');
  await page.goto(`/bots/${botId}/memoria`);

  // Restaurar fecha o drawer e mostra o toast no topo; o dono reabre o histórico com o toast (4 s) ainda na tela.
  await page.getByRole('button', { name: 'Histórico' }).click();
  await history(page).getByRole('button', { name: /Versão 1/ }).click();
  await history(page).getByRole('button', { name: 'Restaurar esta versão' }).click();
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'Versão restaurada' });
  await expect(toast).toBeVisible();
  await page.getByRole('button', { name: 'Histórico' }).click();
  const close = history(page).getByRole('button', { name: 'Fechar histórico' });
  await expect(close).toBeVisible();

  // O cliente não perde o clique (o Radix desliga o ponteiro fora do drawer), mas o toast por cima escondia o título e os botões do
  // cabeçalho: ele precisa começar ABAIXO deles. Antes do conserto o toast ficava a 16 px do topo, sobre o cabeçalho de 52 px.
  const toastBox = await toast.boundingBox();
  const closeBox = await close.boundingBox();
  expect(toastBox, 'o toast está na tela').not.toBeNull();
  expect(closeBox, 'o botão de fechar está na tela').not.toBeNull();
  expect(toastBox!.y, 'o toast começa abaixo do cabeçalho do drawer').toBeGreaterThanOrEqual(closeBox!.y + closeBox!.height);
  expect(problems).toEqual([]);
});

test('conflito por versão: o texto digitado é preservado, o dono copia e recarrega a versão atual', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  await ensureCredential(page, 'provider', PROVIDER_KEY);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 1440, height: 900 });
  const botId = await createBot(page, 'Concorrente', '#2DD4BF');
  const path = `/api/bots/${botId}/memory`;
  await putMemory(page, path, 'Texto inicial.');
  const headers = await apiHeaders(page);
  await page.goto(`/bots/${botId}/memoria`);
  const box = editor(page, `Memória de ${uniqueBotName('Concorrente')}`);
  await expect(box).toHaveValue('Texto inicial.');

  // Outra aba (ou o bot) grava enquanto o dono edita: ao salvar, o servidor recusa por versão.
  await putMemory(page, path, 'Texto que mudou por fora.', headers);
  await box.fill('Meu texto digitado com muito cuidado.');
  await save(page).click();
  const modal = page.getByRole('dialog', { name: 'A memória mudou enquanto você editava' });
  await expect(modal).toBeVisible();
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'memoria-conflito-1440');

  // Fechar o modal NÃO descarta o texto digitado.
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await expect(box).toHaveValue('Meu texto digitado com muito cuidado.');

  // Copiar: o texto vai para a área de transferência.
  await save(page).click();
  await expect(modal).toBeVisible();
  await modal.getByRole('button', { name: 'Copiar meu texto' }).click();
  await expect(page.getByText('Texto copiado', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Meu texto digitado com muito cuidado.');

  // Recarregar: o editor passa a mostrar a versão atual do servidor e o Salvar volta a ficar desabilitado.
  await modal.getByRole('button', { name: 'Recarregar' }).click();
  await expect(modal).toHaveCount(0);
  await expect(box).toHaveValue('Texto que mudou por fora.');
  await expect(save(page)).toBeDisabled();

  // 375 px: o modal cabe na tela.
  await page.setViewportSize({ width: 375, height: 812 });
  await putMemory(page, path, 'Mudou de novo por fora.', headers);
  await box.fill('Outro texto digitado.');
  await save(page).click();
  await expect(modal).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'memoria-conflito-375');
  await modal.getByRole('button', { name: 'Recarregar' }).click();
  expect(problems.filter((problem) => !problem.includes('409 PUT'))).toEqual([]);
});

test('o bot edita a própria memória pela conversa: cartão com diff e desfazer, e o desfazer é recusado depois que a memória muda', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  await ensureCredential(page, 'provider', PROVIDER_KEY);
  await page.setViewportSize({ width: 1440, height: 900 });
  const botId = await createBot(page, 'Anotador', '#FB923C');
  await page.goto(`/bots/${botId}`);
  await composer(page).fill('[memoria:Prefere tabelas.] anote isso');
  await composer(page).press('Enter');

  // O cartão chega com o diff resumido, o tamanho e o botão Desfazer; a atividade da ferramenta aparece na resposta.
  const card = memoryCards(page).first();
  await expect(card).toBeVisible();
  await expect(card).toContainText('Prefere tabelas.');
  await expect(card).toContainText('+1 −0 linha');
  await expect(card).toContainText('caracteres');
  const noted = page.getByRole('log', { name: 'Conversa' }).getByText('Anotou na memória');
  await openWorkLine(page.getByRole('log', { name: 'Conversa' }), noted);
  await expect(noted).toBeVisible();
  await expect(page.getByRole('log', { name: 'Conversa' }).getByText(/Encontrei: Memória atualizada \(versão 1\)/)).toBeVisible();
  // O diff do cartão é o mesmo desenho do drawer: linha adicionada com fundo do estado e o prefixo `+`.
  const cardDiff = await readDiff(card.getByRole('list', { name: 'Mudanças na memória' }));
  expect(cardDiff.rows.map((row) => [row.kind, row.prefix])).toEqual([['add', '+']]);
  expectBackground(cardDiff.rows[0]!, cardDiff.tokens.add);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'memoria-cartao-1440');

  // Desfazer: o cartão passa a "Desfeita" e a memória volta a ficar vazia (versão nova do dono).
  await card.getByRole('button', { name: 'Desfazer' }).click();
  await expect(card.getByText('Desfeita', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Desfazer' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Memória do bot' }).click();
  await expect(page.getByRole('heading', { name: `Memória de ${uniqueBotName('Anotador')}`, level: 1 })).toBeVisible();
  await expect(editor(page, `Memória de ${uniqueBotName('Anotador')}`)).toHaveValue('');
  await page.getByRole('button', { name: 'Histórico' }).click();
  // Desfazer a primeira edição volta à memória vazia (versão 0): é uma versão do dono que remove a linha, sem versão de origem.
  await expect(history(page).getByRole('button', { name: /Versão 2/ })).toContainText('Você');
  await expect(history(page).getByRole('button', { name: /Versão 2/ })).toContainText('+0 −1 linha');
  await expect(history(page).getByRole('button', { name: /Versão 1/ })).toContainText(uniqueBotName('Anotador')); // a edição do bot, com o nome dele
  await history(page).getByRole('button', { name: 'Fechar histórico' }).click();

  // Memória que mudou depois da edição do bot: o Desfazer daquele cartão é recusado (apagaria o que veio depois).
  const headers = await apiHeaders(page);
  await page.goto(`/bots/${botId}`);
  await composer(page).fill('[memoria:Segunda nota.] anote');
  await composer(page).press('Enter');
  await expect(memoryCards(page)).toHaveCount(2);
  await putMemory(page, `/api/bots/${botId}/memory`, 'O dono reescreveu tudo.', headers);
  await memoryCards(page).last().getByRole('button', { name: 'Desfazer' }).click();
  await expect(page.getByText(/A memória mudou depois desta edição/)).toBeVisible();
  expect(await (await page.context().request.get(`${ORIGIN}/api/bots/${botId}/memory`, { headers: await apiHeaders(page) })).json()).toMatchObject({
    content: 'O dono reescreveu tudo.',
  });

  // 375 px: o cartão cabe, com o botão visível e sem rolagem horizontal.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/bots/${botId}`);
  await expect(memoryCards(page).first()).toBeVisible();
  const narrowCardDiff = await readDiff(memoryCards(page).first().getByRole('list', { name: 'Mudanças na memória' }));
  expectBackground(narrowCardDiff.rows[0]!, narrowCardDiff.tokens.add);
  expect(narrowCardDiff.overflowsX || narrowCardDiff.rows.some((row) => row.sticksOut), 'o diff do cartão não rola na horizontal em 375 px').toBe(false);
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'memoria-cartao-375');
  expect(problems.filter((problem) => !problem.includes('409 POST'))).toEqual([]);
});

test('as regras globais (a antiga memória global) são editadas só pelo dono: salva e persiste, e o bot não consegue escrever nela', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  await ensureCredential(page, 'provider', PROVIDER_KEY);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/bots');
  await page.getByRole('link', { name: 'Configurações', exact: true }).click();
  await page.getByRole('complementary').getByRole('link', { name: 'Personalização' }).click();
  await expect(page).toHaveURL(/\/configuracoes\/personalizacao$/);
  await expect(page.getByRole('heading', { name: 'Personalização', level: 1 })).toBeVisible();
  await expect(page.getByText('Regras que todos os bots e o Chat geral leem em toda execução, antes das regras de cada bot. Só você edita; cada salvamento vira uma versão restaurável.')).toBeVisible();
  // Sem bot não há Faísca: o cabeçalho das regras globais mantém o ícone de globo.
  await expect(page.getByRole('heading', { name: 'Personalização', level: 1 }).locator('..').locator('svg.faisca')).toHaveCount(0);
  const box = editor(page, 'Regras globais');
  const text = `Idioma: português. Registro ${Date.now()}`;
  await box.fill(text);
  await save(page).click();
  await expect(page.getByText('Memória salva', { exact: true })).toBeVisible();
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'memoria-global-1440');
  await page.reload();
  await expect(box).toHaveValue(text);

  // O bot tenta apontar a ferramenta para a memória global: a chamada falha, a global segue como estava e não há cartão.
  const botId = await createBot(page, 'Curioso', '#818CF8');
  await page.goto(`/bots/${botId}`);
  await composer(page).fill('[memoria-global:invadir] tente a global');
  await composer(page).press('Enter');
  await expect(page.getByRole('log', { name: 'Conversa' }).getByText(/Encontrei: .*"code":"VALIDATION_FAILED".*Argumentos inválidos/)).toBeVisible();
  await expect(memoryCards(page)).toHaveCount(0);
  await page.goto('/configuracoes/regras-globais'); // a rota antiga redireciona para Personalização
  await expect(page).toHaveURL(/\/configuracoes\/personalizacao$/);
  await expect(box).toHaveValue(text);

  // 375 px.
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByRole('heading', { name: 'Personalização', level: 1 })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'memoria-global-375');
  expect(problems).toEqual([]);
});

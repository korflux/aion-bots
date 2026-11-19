// E2E das preferências gerais no navegador real, contra a pilha de produção. Configurações → Preferências (phase 5, T4; antes "Idioma e fuso", T28): o padrão (português do
// Brasil, America/Sao_Paulo), cada campo (Idioma das respostas, Fuso horário) gravando AO MUDAR, sem botão Salvar, com "Salvo" ao lado do rótulo (região `aria-live`) e o valor
// relido da API e depois de recarregar; e, com a gravação falhando (resposta simulada), o erro no campo com o valor MANTIDO e "Tentar de novo". Configurações → Personalização
// (T10: "Como te chamar" saiu de Preferências): o nome grava ao mudar com "Salvo", é recusado acima de 40 caracteres e com caractere de controle (sem enviar nada), mantém o valor
// e oferece "Tentar de novo" quando a gravação falha; Preferências já não o mostra (a saudação do Início com o nome está em `home.spec.ts`). Axe em cada estado, em 1440 e 375 px. O modelo do Chat
// geral, o terceiro campo de Preferências, é provado em `general-chat.spec.ts` (precisa do provedor falso). As preferências são estado global (valem para todos os bots e para o
// fuso padrão das rotinas novas), então cada teste devolve o padrão no fim, mesmo se falhar no meio.
import type { Page } from '@playwright/test';
import { ORIGIN, apiHeaders, apiLogin, attachShot, expect, expectNoA11yViolations, expectNoHorizontalScroll, test, watchPage } from './support/fixtures';

// As preferências são globais: os testes do arquivo não podem rodar ao mesmo tempo (um mudaria o que o outro confere).
test.describe.configure({ mode: 'serial' });

const DEFAULTS = { language: 'pt-BR', timeZone: 'America/Sao_Paulo', ownerName: '' };
type Preferences = typeof DEFAULTS;

/** Cabeçalhos de API de um login (E22: cada `apiHeaders` faz um login novo e invalida o token CSRF de uma tela aberta, então o teste os obtém UMA vez, antes de abrir a tela). */
type Headers = Record<string, string>;

/** As preferências como o servidor as tem, lidas pela API com os cabeçalhos da sessão da tela. */
async function settingsOf(page: Page, headers: Headers): Promise<Preferences> {
  const response = await page.context().request.get(`${ORIGIN}/api/settings`, { headers });
  return (await response.json()) as Preferences;
}

/** Devolve as preferências de antes do teste, pela API (não depende da tela), e devolve os cabeçalhos dessa sessão para o teste reutilizar. */
async function restoreDefaults(page: Page): Promise<Headers> {
  const headers = await apiHeaders(page);
  await page.context().request.put(`${ORIGIN}/api/settings`, { headers, data: DEFAULTS });
  return headers;
}

const ownerName = (page: Page) => page.getByRole('textbox', { name: 'Como te chamar' });
const language = (page: Page) => page.getByRole('combobox', { name: 'Idioma das respostas' });
const timeZone = (page: Page) => page.getByRole('combobox', { name: 'Fuso horário' });
/** Qualquer "Salvo" na tela (para provar que NÃO há nenhum). */
const savedMark = (page: Page) => page.getByText('Salvo', { exact: true });
/** O "Salvo" ao lado do rótulo de UM campo (dois campos gravados em sequência mostram o seu ao mesmo tempo, por cerca de 2 s). */
const savedFor = (page: Page, label: string) => page.locator('label', { hasText: label }).locator('xpath=..').getByText('Salvo', { exact: true });
const NAME_ERROR = 'Use até 40 caracteres, sem símbolos de controle.';
const SAVE_ERROR = 'Não foi possível salvar. Tente de novo.';

/** Quantos PUT /api/settings o navegador já mandou (para provar que o nome inválido NÃO é enviado). */
function countPuts(page: Page): () => number {
  let puts = 0;
  page.on('request', (request) => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/settings') puts += 1;
  });
  return () => puts;
}

test('preferências: o padrão, idioma e fuso gravam ao mudar com "Salvo" e persistem sem desfazer o nome, "Como te chamar" não está mais aqui, e o layout em 375 px', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  try {
    const headers = await restoreDefaults(page);
    // O nome mora em Personalização, mas as três preferências vão juntas ao servidor: um nome já gravado prova que idioma e fuso não o desfazem.
    await page.context().request.put(`${ORIGIN}/api/settings`, { headers, data: { ...DEFAULTS, ownerName: 'Marco' } });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/bots');
    await page.getByRole('link', { name: 'Configurações', exact: true }).click();
    await page.getByRole('complementary').getByRole('link', { name: 'Preferências', exact: true }).click();
    await expect(page).toHaveURL(/\/configuracoes\/preferencias$/);
    await expect(page.getByRole('heading', { name: 'Preferências', level: 1 })).toBeVisible();
    await expect(page.getByRole('complementary').getByRole('link', { name: 'Preferências' })).toHaveAttribute('aria-current', 'page');

    // O padrão é o de antes: português do Brasil e o fuso de Brasília; nenhum botão Salvar, e a tela mostra que horas são nesse fuso. "Como te chamar" saiu daqui (T10).
    await expect(language(page)).toHaveValue('pt-BR');
    await expect(timeZone(page)).toHaveValue('America/Sao_Paulo');
    await expect(ownerName(page)).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 2, name: 'Seu nome' })).toHaveCount(0);
    await expect(page.getByText('Aparece na saudação do Início.')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Salvar' })).toHaveCount(0);
    await expect(page.getByText(/Agora: .*\(GMT-03:00\)\./)).toBeVisible();
    await expect(savedMark(page)).toHaveCount(0);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'preferencias-1440');

    // Idioma: seletor, grava ao escolher.
    await language(page).selectOption('en');
    await expect(savedFor(page, 'Idioma das respostas')).toBeVisible();
    await expect.poll(async () => (await settingsOf(page, headers)).language).toBe('en');

    // Fuso: seletor, grava ao escolher, e a dica mostra que horas são no fuso novo.
    await timeZone(page).selectOption('America/New_York');
    await expect(savedFor(page, 'Fuso horário')).toBeVisible();
    await expect(page.getByText(/Agora: .*\(GMT-0[45]:00\)\./)).toBeVisible();
    await expect.poll(async () => (await settingsOf(page, headers)).timeZone).toBe('America/New_York');
    // Um campo não desfaz o outro (o servidor guarda os três juntos): o nome e o idioma seguem como foram gravados.
    expect(await settingsOf(page, headers)).toEqual({ language: 'en', timeZone: 'America/New_York', ownerName: 'Marco' });

    // Os valores persistem depois de recarregar.
    await page.reload();
    await expect(language(page)).toHaveValue('en');
    await expect(timeZone(page)).toHaveValue('America/New_York');

    // 375 px: sem rolagem horizontal, com os campos visíveis.
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.getByRole('heading', { name: 'Preferências', level: 1 })).toBeVisible();
    await expect(timeZone(page)).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'preferencias-375');
    expect(problems).toEqual([]);
  } finally {
    await restoreDefaults(page);
  }
});

test('preferências: quando a gravação falha o erro aparece no campo, o valor escolhido é mantido e "Tentar de novo" grava (idioma e fuso)', async ({ page }, testInfo) => {
  // O 500 simulado é esperado: o `watchPage` o registra, e só ele pode constar.
  const problems = watchPage(page);
  try {
    const headers = await restoreDefaults(page);
    await page.context().request.put(`${ORIGIN}/api/settings`, { headers, data: { ...DEFAULTS, ownerName: 'Marco' } }); // o nome (de Personalização) tem de sobreviver ao corpo completo do PUT
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/configuracoes/preferencias');
    await expect(language(page)).toHaveValue('pt-BR');

    let failing = true;
    await page.route('**/api/settings', (route) =>
      failing && route.request().method() === 'PUT'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'INTERNAL_ERROR', message: 'Erro interno. Tente novamente.' }) })
        : route.continue(),
    );

    // Idioma: o seletor mostra a escolha mesmo com a falha, e o erro fica no campo do idioma (o do fuso não aparece).
    failing = true;
    await language(page).selectOption('es');
    const languageError = page.getByRole('alert').filter({ hasText: SAVE_ERROR });
    await expect(languageError).toHaveCount(1);
    await expect(language(page)).toHaveValue('es');
    await expect(language(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(timeZone(page)).not.toHaveAttribute('aria-invalid', 'true');
    expect((await settingsOf(page, headers)).language, 'nada foi gravado').toBe('pt-BR');
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'preferencias-1440-erro-gravacao');
    failing = false;
    await languageError.getByRole('button', { name: 'Tentar de novo' }).click();
    await expect(savedFor(page, 'Idioma das respostas')).toBeVisible();
    await expect(language(page)).toHaveValue('es');
    expect((await settingsOf(page, headers)).language).toBe('es');

    // Fuso: o mesmo.
    failing = true;
    await timeZone(page).selectOption('Europe/Lisbon');
    const zoneError = page.getByRole('alert').filter({ hasText: SAVE_ERROR });
    await expect(zoneError).toHaveCount(1);
    await expect(timeZone(page)).toHaveValue('Europe/Lisbon');
    expect((await settingsOf(page, headers)).timeZone, 'nada foi gravado').toBe('America/Sao_Paulo');
    failing = false;
    await zoneError.getByRole('button', { name: 'Tentar de novo' }).click();
    await expect(savedFor(page, 'Fuso horário')).toBeVisible();
    expect(await settingsOf(page, headers)).toEqual({ language: 'es', timeZone: 'Europe/Lisbon', ownerName: 'Marco' });
    expect(problems.filter((problem) => !problem.startsWith('500 PUT /api/settings'))).toEqual([]);
  } finally {
    await restoreDefaults(page);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Modelo do resumo (phase 9, T4; A13, F6 passo 5): campo do cartão Contexto de Preferências, que grava ao mudar. Escolher um modelo VALIDADO exige um perfil de modelo testado
// no banco, e o único caminho para criá-lo é testar o modelo com a chave do provedor, que é estado GLOBAL (o spec de chaves a apaga e regrava em paralelo neste projeto, e o do
// seletor assume os modelos ainda sem teste): por isso a prova da tela simula a LISTA de perfis e a gravação do modelo no navegador, e a recusa pelo servidor roda na API real.
// A regra de gravação (só modelo validado, nulo, auditoria) e a persistência no banco estão provadas em `settings.test.ts` e `settings.routes.test.ts`.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
const summaryModel = (page: Page) => page.getByRole('combobox', { name: 'Modelo do resumo' });
/** Leva o cartão Contexto ao centro da janela: a captura da tela mostra só a janela, e o campo novo fica abaixo da dobra. */
const showContextCard = (page: Page) => page.getByRole('region', { name: 'Contexto', exact: true }).evaluate((card) => card.scrollIntoView({ block: 'center' }));
const SUMMARY_DEFAULT = 'Mesmo modelo da conversa';
const SUMMARY_REFUSED = 'Este modelo não está validado. Escolha outro.';
const SUMMARY_HELP = 'Usado só para compactar conversas longas. Vazio usa o modelo de cada conversa, com o menor effort que ele aceita.';

/** Perfil de modelo como `GET /api/models/profiles` o devolve; `null` = nunca testado (só favoritado). */
function modelProfile(id: string, status: 'ok' | 'no_tools' | 'failed' | null) {
  const testedAt = '2026-10-14T12:00:00.000Z';
  const reason = status === 'no_tools' ? 'no_tool_call' : status === 'failed' ? 'unsupported' : null;
  return { id, favorite: status === null, favoritedAt: status === null ? testedAt : null, acceptsImages: null, test: status === null ? null : { status, reason, effortLevels: [], testedAt } };
}

/** Lista de perfis simulada: dois liberados (fora de ordem alfabética de propósito), um sem ferramentas, um que falhou e um só favoritado. */
async function mockModelProfiles(page: Page): Promise<void> {
  const models = [modelProfile('zeta-resumo', 'ok'), modelProfile('alfa-resumo', 'ok'), modelProfile('beta-sem-ferramentas', 'no_tools'), modelProfile('reprovado-resumo', 'failed'), modelProfile('so-favorito', null)];
  await page.route('**/api/models/profiles', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models }) }));
}

test('preferências: "Modelo do resumo" lista só modelos validados, grava ao mudar com "Salvo", persiste ao recarregar, marca o salvo ausente como "(indisponível)" e o layout em 1280 e 390 px (T4)', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  await apiLogin(page.context()); // sem criar nenhum estado: só a sessão do dono, que a tela exige
  await mockModelProfiles(page);
  // O servidor real responde as janelas (e prova que a leitura já traz `summaryModel`, nulo); a gravação do modelo e a releitura são simuladas com o estado guardado aqui.
  let windows = { bots: 262144, generalChat: 262144 };
  let stored: string | null = null;
  let realSummaryModel: string | null | undefined;
  const puts: unknown[] = [];
  await page.route('**/api/settings/context', async (route) => {
    const request = route.request();
    if (request.method() === 'PUT') {
      const body = request.postDataJSON() as { summaryModel: string | null };
      puts.push(body);
      stored = body.summaryModel;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...windows, summaryModel: stored }) });
    }
    const real = await route.fetch();
    const body = (await real.json()) as { bots: number; generalChat: number; summaryModel: string | null };
    realSummaryModel = body.summaryModel;
    windows = { bots: body.bots, generalChat: body.generalChat };
    return route.fulfill({ response: real, json: { ...body, summaryModel: stored } });
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/configuracoes/preferencias');
  await expect(summaryModel(page)).toBeVisible();
  expect(realSummaryModel, 'a leitura real já traz o modelo do resumo, nulo por padrão').toBeNull();

  // O padrão é "Mesmo modelo da conversa" (valor vazio); depois, só os modelos validados (Liberado e Sem ferramentas) em ordem alfabética: o que falhou e o só favoritado não entram.
  await expect(summaryModel(page)).toHaveValue('');
  await expect(summaryModel(page).locator('option')).toHaveText([SUMMARY_DEFAULT, 'alfa-resumo', 'beta-sem-ferramentas', 'zeta-resumo']);
  await expect(page.getByText(SUMMARY_HELP)).toBeVisible();
  await expect(summaryModel(page)).toHaveAccessibleDescription(SUMMARY_HELP);
  await expect(page.getByRole('combobox', { name: 'Contexto dos bots' })).toBeVisible(); // os campos de antes seguem no cartão
  for (const name of ['Contexto dos bots', 'Contexto do Chat geral']) await expect(page.getByRole('combobox', { name }).locator('option')).toHaveText(['64k', '128k', '256k', '512k']); // as quatro opções (32k saiu na phase 11)
  await expect(savedMark(page)).toHaveCount(0);
  await expectNoA11yViolations(page);
  await showContextCard(page);
  await attachShot(page, testInfo, 'preferencias-resumo-1280');

  // Escolher um modelo grava ao mudar, mostra "Salvo" ao lado do rótulo e envia só o modelo (nada das janelas).
  await summaryModel(page).selectOption('beta-sem-ferramentas');
  await expect(savedFor(page, 'Modelo do resumo')).toBeVisible();
  expect(puts).toEqual([{ scope: 'summary_model', summaryModel: 'beta-sem-ferramentas' }]);
  await expectNoA11yViolations(page);
  await showContextCard(page);
  await attachShot(page, testInfo, 'preferencias-resumo-1280-salvo');

  // O valor persiste depois de recarregar (a leitura devolve o que foi guardado).
  await page.reload();
  await expect(summaryModel(page)).toHaveValue('beta-sem-ferramentas');
  await expect(summaryModel(page).locator('option')).toHaveText([SUMMARY_DEFAULT, 'alfa-resumo', 'beta-sem-ferramentas', 'zeta-resumo']);

  // "Mesmo modelo da conversa" volta ao padrão: envia nulo e, recarregando, o campo mostra o padrão de novo.
  await summaryModel(page).selectOption('');
  await expect(savedFor(page, 'Modelo do resumo')).toBeVisible();
  expect(puts.at(-1)).toEqual({ scope: 'summary_model', summaryModel: null });
  await page.reload();
  await expect(summaryModel(page)).toHaveValue('');

  // Um modelo salvo que não está mais na lista validada continua visível, rotulado "(indisponível)", sem ser trocado sozinho.
  stored = 'modelo-removido';
  await page.reload();
  await expect(summaryModel(page)).toHaveValue('modelo-removido');
  await expect(summaryModel(page).locator('option:checked')).toHaveText('modelo-removido (indisponível)');
  await expect(summaryModel(page).locator('option')).toHaveText([SUMMARY_DEFAULT, 'modelo-removido (indisponível)', 'alfa-resumo', 'beta-sem-ferramentas', 'zeta-resumo']);
  await expectNoA11yViolations(page);
  stored = null;

  // 390 px: o cartão vira coluna única (o campo novo abaixo do Chat geral, na mesma coluna), sem rolagem horizontal e com o nome longo do modelo truncado no próprio seletor.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(summaryModel(page)).toBeVisible();
  const chat = (await page.getByRole('combobox', { name: 'Contexto do Chat geral' }).boundingBox())!;
  const summary = (await summaryModel(page).boundingBox())!;
  expect(summary.y, 'em coluna única o campo novo vem abaixo').toBeGreaterThan(chat.y + chat.height);
  expect(Math.abs(summary.x - chat.x), 'na mesma coluna').toBeLessThan(1);
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await showContextCard(page);
  await attachShot(page, testInfo, 'preferencias-resumo-390');
  expect(problems).toEqual([]);
});

test('preferências: um modelo que o servidor não reconhece como validado recebe VALIDATION_FAILED, a escolha fica na tela com o erro e o padrão volta a gravar (API real) (T4)', async ({ page }, testInfo) => {
  // O 422 é o esperado: o `watchPage` o registra, e só ele pode constar.
  const problems = watchPage(page);
  await apiLogin(page.context());
  await mockModelProfiles(page); // a tela oferece 'alfa-resumo', mas o banco da pilha não tem esse perfil: só a lista é simulada, a gravação e a leitura são do servidor
  const contextOf = (): Promise<{ summaryModel: string | null }> => page.evaluate(() => fetch('/api/settings/context').then((response) => response.json()));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/configuracoes/preferencias');
  await expect(summaryModel(page)).toHaveValue('');
  expect((await contextOf()).summaryModel, 'a pilha parte sem modelo do resumo').toBeNull();

  const refused = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/settings/context' && response.request().method() === 'PUT');
  await summaryModel(page).selectOption('alfa-resumo');
  const response = await refused;
  expect(response.status()).toBe(422);
  expect(await response.json()).toMatchObject({ code: 'VALIDATION_FAILED', fields: [{ field: 'summaryModel', reason: 'Escolha um modelo validado.' }] });

  // A escolha fica na tela, marcada como inválida, com o erro no campo e "Tentar de novo"; nada foi gravado e nenhum "Salvo" aparece.
  const error = page.getByRole('alert').filter({ hasText: SUMMARY_REFUSED });
  await expect(error).toHaveCount(1);
  await expect(summaryModel(page)).toHaveValue('alfa-resumo');
  await expect(summaryModel(page)).toHaveAttribute('aria-invalid', 'true');
  await expect(summaryModel(page)).toHaveAccessibleDescription(new RegExp(`${SUMMARY_REFUSED}`));
  await expect(error.getByRole('button', { name: 'Tentar de novo' })).toBeVisible();
  await expect(savedMark(page)).toHaveCount(0);
  expect((await contextOf()).summaryModel, 'nada foi gravado').toBeNull();
  await expectNoA11yViolations(page);
  await showContextCard(page);
  await attachShot(page, testInfo, 'preferencias-resumo-erro-1280');

  // Escolher "Mesmo modelo da conversa" é sempre aceito (nulo): grava, o erro some e o servidor segue sem modelo do resumo.
  await summaryModel(page).selectOption('');
  await expect(savedFor(page, 'Modelo do resumo')).toBeVisible();
  await expect(error).toHaveCount(0);
  await expect(summaryModel(page)).not.toHaveAttribute('aria-invalid', 'true');
  expect((await contextOf()).summaryModel).toBeNull();
  expect(problems.filter((problem) => !problem.startsWith('422 PUT /api/settings/context'))).toEqual([]);
});

test('personalização: "Como te chamar" grava ao mudar com "Salvo", o nome inválido é recusado sem enviar, o nome persiste e o layout em 375 px (T10)', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  try {
    const headers = await restoreDefaults(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/bots');
    await page.getByRole('link', { name: 'Configurações', exact: true }).click();
    await page.getByRole('complementary').getByRole('link', { name: 'Personalização', exact: true }).click();
    await expect(page).toHaveURL(/\/configuracoes\/personalizacao$/);
    await expect(page.getByRole('heading', { name: 'Personalização', level: 1 })).toBeVisible();
    await expect(page.getByRole('complementary').getByRole('link', { name: 'Personalização' })).toHaveAttribute('aria-current', 'page');
    const puts = countPuts(page);

    // O cartão "Seu nome" vem acima das Regras globais (o editor, com Histórico e Salvar); o campo parte do que o servidor guarda (sem nome) e não tem botão próprio.
    await expect(page.getByRole('heading', { level: 2, name: 'Seu nome' })).toBeVisible();
    await expect(ownerName(page)).toHaveValue('');
    await expect(page.getByText('Aparece na saudação do Início.')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Regras globais' })).toBeVisible();
    await expect(savedMark(page)).toHaveCount(0);
    expect((await ownerName(page).boundingBox())!.y, 'o nome vem acima do editor').toBeLessThan((await page.getByRole('textbox', { name: 'Regras globais' }).boundingBox())!.y);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'personalizacao-1440');

    // Grava ao apertar Enter, mostra "Salvo" e a API devolve o nome.
    await ownerName(page).fill('Marco');
    await ownerName(page).press('Enter');
    await expect(savedFor(page, 'Como te chamar')).toBeVisible();
    expect((await settingsOf(page, headers)).ownerName).toBe('Marco');
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'personalizacao-1440-salvo');
    // O "Salvo" some sozinho depois de alguns segundos.
    await expect(savedFor(page, 'Como te chamar')).toHaveCount(0, { timeout: 6_000 });

    // Grava também ao sair do campo, e apara os espaços das pontas (a tela mostra o texto como foi guardado).
    await ownerName(page).fill('  Ana Clara  ');
    await page.getByRole('heading', { name: 'Personalização', level: 1 }).click(); // tira o foco do campo
    await expect(savedFor(page, 'Como te chamar')).toBeVisible();
    await expect(ownerName(page)).toHaveValue('Ana Clara');
    expect((await settingsOf(page, headers)).ownerName).toBe('Ana Clara');
    const putsBeforeInvalid = puts();

    // Mais de 40 caracteres e caractere de controle: o erro aparece no campo com o texto da spec, o campo fica marcado como inválido, o valor é mantido, e NADA é enviado.
    await ownerName(page).fill('a'.repeat(41));
    await ownerName(page).press('Enter');
    await expect(page.getByRole('alert').filter({ hasText: NAME_ERROR })).toBeVisible();
    await expect(ownerName(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(ownerName(page)).toHaveValue('a'.repeat(41));
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'personalizacao-1440-erro-nome');
    await ownerName(page).fill('ab\tc');
    await ownerName(page).press('Enter');
    await expect(page.getByRole('alert').filter({ hasText: NAME_ERROR })).toBeVisible();
    expect(puts(), 'o nome inválido não chega ao servidor').toBe(putsBeforeInvalid);
    expect((await settingsOf(page, headers)).ownerName).toBe('Ana Clara');
    // Voltar a editar tira o erro; um nome válido grava de novo. O servidor também recusa o nome inválido (VALIDATION_FAILED), como a API prova nos testes de rota.
    await ownerName(page).fill('Marco');
    await expect(page.getByRole('alert').filter({ hasText: NAME_ERROR })).toHaveCount(0);
    await ownerName(page).press('Enter');
    await expect(savedFor(page, 'Como te chamar')).toBeVisible();
    expect((await settingsOf(page, headers)).ownerName).toBe('Marco');

    // Vazio apaga o nome; depois o nome volta.
    await ownerName(page).fill('');
    await ownerName(page).press('Enter');
    await expect(savedFor(page, 'Como te chamar')).toBeVisible();
    expect((await settingsOf(page, headers)).ownerName).toBe('');
    await ownerName(page).fill('Marco');
    await ownerName(page).press('Enter');
    await expect(savedFor(page, 'Como te chamar')).toBeVisible();
    expect((await settingsOf(page, headers)).ownerName).toBe('Marco');

    // O nome persiste depois de recarregar.
    await page.reload();
    await expect(ownerName(page)).toHaveValue('Marco');

    // A saudação do Início usar o nome gravado aqui é provada em `home.spec.ts` (o Início só mostra a saudação com bots, e este arquivo roda com o banco sem bots).

    // 375 px: sem rolagem horizontal, com o cartão e o editor visíveis; o índice de Configurações mostra o nome no resumo de Personalização e Preferências já não o cita.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/configuracoes/personalizacao');
    await expect(page.getByRole('heading', { name: 'Personalização', level: 1 })).toBeVisible();
    await expect(ownerName(page)).toBeVisible();
    await expect(ownerName(page)).toHaveValue('Marco');
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'personalizacao-375');
    await page.goto('/configuracoes');
    await expect(page.getByRole('link', { name: /^Personalização/ })).toContainText('Como te chamar e as regras globais que todos os bots seguem');
    await expect(page.getByRole('link', { name: /^Personalização/ })).toContainText(/Marco · [\d.]+ \/ 8\.000 caracteres/);
    await expect(page.getByRole('link', { name: /^Preferências/ })).not.toContainText('Como te chamar');
    expect(problems).toEqual([]);
  } finally {
    await restoreDefaults(page);
  }
});

test('personalização: quando a gravação do nome falha o erro aparece no campo, o texto é mantido e "Tentar de novo" grava (T10)', async ({ page }, testInfo) => {
  // O 500 simulado é esperado: o `watchPage` o registra, e só ele pode constar.
  const problems = watchPage(page);
  try {
    const headers = await restoreDefaults(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/configuracoes/personalizacao');
    await expect(ownerName(page)).toHaveValue('');

    let failing = true;
    await page.route('**/api/settings', (route) =>
      failing && route.request().method() === 'PUT'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'INTERNAL_ERROR', message: 'Erro interno. Tente novamente.' }) })
        : route.continue(),
    );

    // O erro aparece abaixo do campo, o texto digitado fica, e "Tentar de novo" reenvia o que está na tela.
    await ownerName(page).fill('Marco');
    await ownerName(page).press('Enter');
    const nameError = page.getByRole('alert').filter({ hasText: SAVE_ERROR });
    await expect(nameError).toBeVisible();
    await expect(ownerName(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(ownerName(page)).toHaveValue('Marco');
    await expect(savedMark(page)).toHaveCount(0);
    expect((await settingsOf(page, headers)).ownerName, 'nada foi gravado').toBe('');
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'personalizacao-1440-erro-gravacao');
    failing = false;
    await nameError.getByRole('button', { name: 'Tentar de novo' }).click();
    await expect(savedFor(page, 'Como te chamar')).toBeVisible();
    await expect(nameError).toHaveCount(0);
    expect((await settingsOf(page, headers)).ownerName).toBe('Marco');
    expect(problems.filter((problem) => !problem.startsWith('500 PUT /api/settings'))).toEqual([]);
  } finally {
    await restoreDefaults(page);
  }
});

test('uma rotina nova já abre com o fuso do dono (Configurações → Preferências)', async ({ page }) => {
  const problems = watchPage(page);
  try {
    await page.context().request.put(`${ORIGIN}/api/settings`, { headers: await apiHeaders(page), data: { ...DEFAULTS, timeZone: 'Europe/Lisbon' } });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/rotinas/nova');
    await expect(page.getByRole('combobox', { name: 'Fuso horário' })).toHaveValue('Europe/Lisbon');
    expect(problems).toEqual([]);
  } finally {
    await restoreDefaults(page);
  }
});

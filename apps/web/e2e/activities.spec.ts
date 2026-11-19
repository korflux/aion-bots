// E2E de Atividade e arquivos (T11; A14; F15 e F7; phase 5, T4: Configurações → Atividade e arquivos, com "Aguardando você" no topo de Aprovações) no navegador
// real, contra a pilha de produção (Postgres, API, worker, Next e proxy) com o OpenCode Go e o Composio FALSOS. Marcadores do modelo falso: [gmail] pede
// aprovação (num bot com a conta liberada, phase 13), [falha] falha o provedor, [demorar] roda até o dono parar (ver packages/core/src/testing/fake-upstreams.ts).
//
// Cobre: "Execuções recentes" com execuções em estados variados (concluída, falhou, rotina, em execução, aguardando aprovação) e a origem de cada uma; "Aguardando
// você" com 2 pendências NO TOPO DE APROVAÇÕES (e fora de Atividade e arquivos, mesmo quando a API as traz); a navegação de cada tipo de item até o cartão certo na
// conversa, a aprovação NÃO feita nessas telas, "Parar" (execução ativa e execução que espera aprovação, que sai de "Aguardando você"), e, com respostas simuladas da
// API, os estados vazio, erro com nova tentativa, "Carregar mais" por cursor, "Nada aguardando você." e a parada recusada por lista desatualizada. axe em cada estado,
// e o layout em 1440 e 375 px. O avatar de cada linha é a Faísca de 24 px parada, no estado da execução.
//
// As execuções, as chaves do Composio e os bots são estado global (a tela lista tudo), então o arquivo é serial, roda no projeto
// `chromium-activities` depois dos demais e os nomes dos bots são exclusivos ("Atv ...").
import type { Locator, Page } from '@playwright/test';
import {
  ORIGIN,
  apiHeaders,
  apiLogin,
  attachShot,
  uniqueBotName,
  ensureCredential,
  expect,
  expectNoA11yViolations,
  expectNoHorizontalScroll,
  faiscaLook,
  releaseConnectorAccounts,
  test,
  watchPage,
} from './support/fixtures';

test.describe.configure({ mode: 'serial' });

const FAKE_PROVIDER = 'valid-e2e-atividades-1111';
const FAKE_CONNECTOR = 'valid-e2e-composio-3333';
const DAILY = { schedule: { type: 'daily', times: ['07:00'] }, timezone: 'America/Sao_Paulo', startsAt: null, endsAt: null, maxRuns: null };

let credentialsSeeded = false;

interface Bot {
  id: string;
  name: string;
}
interface Scenario {
  financeiro: Bot;
  contador: Bot;
  pesquisador: Bot;
  monitor: Bot;
  escritor: Bot;
}
/** Montado uma vez, no primeiro teste, e reaproveitado pelos seguintes (o arquivo é serial e roda num worker só). */
let scenario: Scenario | null = null;

interface Page1 {
  pending: { runId: string; bot: { id: string; name: string } }[];
  items: { runId: string; status: string; routineName: string | null; bot: { id: string; name: string } }[];
  nextCursor: string | null;
}

/** Provedor e Composio conectados (a chave do Composio é trocada na primeira vez: o spec de chaves a deixa sem apps). */
async function prepare(page: Page): Promise<void> {
  const replace = !credentialsSeeded;
  await ensureCredential(page, 'provider', FAKE_PROVIDER, { replace });
  await ensureCredential(page, 'connector', FAKE_CONNECTOR, { replace });
  credentialsSeeded = true;
}

/** Cria um bot pela API com o nome exclusivo da repetição (`uniqueBotName`, E29) e devolve o id e esse nome, que as asserções da tela usam. */
async function createBot(page: Page, name: string, color: string): Promise<Bot> {
  const unique = uniqueBotName(name);
  const response = await page.context().request.post(`${ORIGIN}/api/bots`, {
    headers: await apiHeaders(page),
    data: { name: unique, color, instructions: '', model: 'opencode/glm-5.1', effort: null, stepLimit: 25 },
  });
  expect(response.status(), `criar o bot ${unique}`).toBe(201);
  return { id: ((await response.json()) as { id: string }).id, name: unique };
}

async function send(page: Page, bot: Bot, content: string): Promise<string> {
  const response = await page.context().request.post(`${ORIGIN}/api/bots/${bot.id}/messages`, { headers: await apiHeaders(page), data: { content } });
  expect(response.status(), 'enviar pela API').toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/** Primeira página de Atividades pela API (as execuções do cenário são as mais novas, então estão nela). */
async function firstPage(page: Page): Promise<Page1> {
  const response = await page.context().request.get(`${ORIGIN}/api/activities`, { headers: await apiHeaders(page) });
  expect(response.status(), 'GET /api/activities').toBe(200);
  return (await response.json()) as Page1;
}

/** Espera a execução chegar ao estado dado (consultando a própria API de Atividades). */
async function waitForRun(page: Page, runId: string, status: string): Promise<void> {
  await expect.poll(async () => (await firstPage(page)).items.find((item) => item.runId === runId)?.status, { timeout: 30_000 }).toBe(status);
}

/**
 * Encerra as execuções que ficaram ativas ou esperando aprovação antes deste cenário (E29): as de uma repetição anterior
 * (`--repeat-each`) ou de outro spec. "Aguardando você" lista as pendências de TODOS os bots e o primeiro teste espera exatamente as 2 do
 * cenário. Usa a mesma ação do botão "Parar" (parada por execução, que a API recusa com 409 se ela já terminou) e repete até o worker
 * zerar as pendências e as execuções ativas: parar uma libera a próxima da fila do bot, que também precisa parar.
 */
async function stopLeftoverRuns(page: Page): Promise<void> {
  const headers = await apiHeaders(page);
  const request = page.context().request;
  await expect
    .poll(
      async () => {
        const view = (await (await request.get(`${ORIGIN}/api/activities`, { headers })).json()) as Page1;
        const active = [...view.pending, ...view.items.filter((item) => ['queued', 'running', 'waiting_approval'].includes(item.status))];
        for (const { bot, runId } of active) await request.post(`${ORIGIN}/api/bots/${bot.id}/runs/stop?runId=${runId}`, { headers });
        return active.length;
      },
      { timeout: 30_000 },
    )
    .toBe(0);
}

/** Monta o cenário: 2 aprovações pendentes e execuções concluída, com falha, de rotina e em andamento. */
async function seed(page: Page): Promise<Scenario> {
  // Cada teste tem um contexto novo: o login vale para a tela mesmo quando o cenário já foi montado por um teste anterior.
  await apiLogin(page.context());
  if (scenario) return scenario;
  await prepare(page);
  await stopLeftoverRuns(page);
  const financeiro = await createBot(page, 'Atv Financeiro', '#60A5FA');
  const contador = await createBot(page, 'Atv Contador', '#FB923C');
  const pesquisador = await createBot(page, 'Atv Pesquisador', '#4ADE80');
  const monitor = await createBot(page, 'Atv Monitor', '#F472B6');
  const escritor = await createBot(page, 'Atv Escritor', '#818CF8');

  await waitForRun(page, await send(page, pesquisador, 'oi, tudo bem?'), 'completed');
  await waitForRun(page, await send(page, pesquisador, '[falha] provedor fora do ar'), 'failed');
  const routine = await page.context().request.post(`${ORIGIN}/api/routines`, {
    headers: await apiHeaders(page),
    data: { name: 'Resumo diário', botId: monitor.id, instruction: 'Resuma o dia', ...DAILY },
  });
  expect(routine.status(), 'criar a rotina').toBe(201);
  const routineId = ((await routine.json()) as { id: string }).id;
  const routineRun = await page.context().request.post(`${ORIGIN}/api/routines/${routineId}/run`, { headers: await apiHeaders(page) });
  expect(routineRun.status(), 'executar a rotina agora').toBe(202);
  await waitForRun(page, ((await routineRun.json()) as { id: string }).id, 'completed');
  // Os dois bots que pedem aprovação do Gmail nascem sem conta (A15, A16): sem a liberação o pedido não traz as ferramentas do conector e nenhuma aprovação aparece (CONN-02).
  await releaseConnectorAccounts(page, financeiro.id);
  await releaseConnectorAccounts(page, contador.id);
  await waitForRun(page, await send(page, financeiro, '[gmail] envie o relatório do mês'), 'waiting_approval');
  await waitForRun(page, await send(page, contador, '[gmail] envie a folha de pagamento'), 'waiting_approval');
  await waitForRun(page, await send(page, escritor, '[demorar]'), 'running');
  scenario = { financeiro, contador, pesquisador, monitor, escritor };
  return scenario;
}

const ACTIVITY_URL = '/configuracoes/atividade-e-arquivos';
const pendingSection = (page: Page) => page.getByRole('region', { name: 'Aguardando você' });
const recentsSection = (page: Page) => page.getByRole('region', { name: 'Execuções recentes' });
const rowOf = (page: Page, bot: Bot) => recentsSection(page).getByRole('listitem').filter({ hasText: bot.name });
const stopButton = (page: Page, bot: Bot) => page.getByRole('button', { name: `Parar a execução de ${bot.name}` });

/** Id da mensagem para onde o clique levou (`?mensagem=` da URL). */
async function targetMessage(page: Page, bot: Bot): Promise<string> {
  await expect(page).toHaveURL(new RegExp(`/bots/${bot.id}\\?mensagem=\\d+$`));
  return new URL(page.url()).searchParams.get('mensagem') ?? '';
}

test('Atividade e arquivos lista as execuções de todos os bots com origem, estado e horário, e Aprovações lista "Aguardando você", sem responder aprovação, em 1440 e 375 px', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  const bots = await seed(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(ACTIVITY_URL);

  await expect(page.getByRole('heading', { level: 1, name: 'Atividade e arquivos' })).toBeVisible();
  // As pendências NÃO aparecem mais aqui (vivem no topo de Aprovações), mesmo havendo duas na API; o cartão Armazenamento abre a lista de arquivos.
  await expect(recentsSection(page)).toBeVisible();
  await expect(pendingSection(page)).toHaveCount(0);
  await expect(page.getByText('Aguardando você', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Armazenamento' })).toContainText(/de 1 GB/);
  await expect(page.getByRole('link', { name: /^Ver arquivos \(\d+\)$/ })).toHaveAttribute('href', '/configuracoes/arquivos');
  await expect(page.getByRole('button', { name: /^(Permitir uma vez|Negar)$/ })).toHaveCount(0); // nomes exatos: "Negar tudo" é das regras globais

  // Execuções recentes: cada execução com a origem e o selo de estado, e "Parar" só nas ativas.
  const recents = recentsSection(page);
  await expect(rowOf(page, bots.escritor)).toContainText('Mensagem');
  await expect(rowOf(page, bots.escritor)).toContainText('Trabalhando');
  await expect(rowOf(page, bots.monitor)).toContainText('Rotina: Resumo diário');
  await expect(rowOf(page, bots.monitor)).toContainText('Concluída');
  await expect(rowOf(page, bots.financeiro)).toContainText('Aguardando aprovação');
  await expect(rowOf(page, bots.contador)).toContainText('Aguardando aprovação');
  await expect(rowOf(page, bots.pesquisador).filter({ hasText: 'Falhou' })).toHaveCount(1);
  await expect(rowOf(page, bots.pesquisador).filter({ hasText: 'Concluída' })).toHaveCount(1);
  await expect(rowOf(page, bots.pesquisador).first()).toContainText(/agora|há \d+ min/);
  await expect(stopButton(page, bots.escritor)).toBeVisible();
  await expect(stopButton(page, bots.financeiro)).toBeVisible();
  await expect(stopButton(page, bots.pesquisador)).toHaveCount(0);
  await expect(stopButton(page, bots.monitor)).toHaveCount(0);
  // Do mais novo ao mais antigo: o bot em execução vem antes do que falhou.
  const texts = await recents.getByRole('listitem').allInnerTexts();
  const position = (bot: Bot) => texts.findIndex((text) => text.includes(bot.name));
  expect(position(bots.escritor)).toBeLessThan(position(bots.contador));
  expect(position(bots.contador)).toBeLessThan(position(bots.financeiro));
  expect(position(bots.financeiro)).toBeLessThan(position(bots.monitor));
  expect(position(bots.monitor)).toBeLessThan(position(bots.pesquisador));

  // O avatar de cada linha é a Faísca de 24 px do bot (na cor dele), PARADA (lista não anima), no estado da execução da linha pela função única
  // (em andamento, concluída, falha, aguardando), nas recentes e nas pendências; o texto do estado continua ao lado.
  const LIST_FAISCA = { detail: 'small', still: true, decorative: true, size: [24, 24] };
  const faiscaOf = (row: Locator) => faiscaLook(row.locator('svg.faisca'));
  expect(await faiscaOf(rowOf(page, bots.escritor))).toMatchObject({ ...LIST_FAISCA, state: 'working', body: '#818CF8' });
  expect(await faiscaOf(rowOf(page, bots.monitor))).toMatchObject({ ...LIST_FAISCA, state: 'done', body: '#F472B6' });
  expect(await faiscaOf(rowOf(page, bots.pesquisador).filter({ hasText: 'Falhou' }))).toMatchObject({ ...LIST_FAISCA, state: 'error', body: '#4ADE80' });
  expect(await faiscaOf(rowOf(page, bots.pesquisador).filter({ hasText: 'Concluída' }))).toMatchObject({ ...LIST_FAISCA, state: 'done', body: '#4ADE80' });
  expect(await faiscaOf(rowOf(page, bots.contador))).toMatchObject({ ...LIST_FAISCA, state: 'waiting', body: '#FB923C' });
  // Nada se anima na lista, nem com movimento reduzido.
  const runningAnimations = () =>
    page.evaluate(() => [...document.querySelectorAll('svg.faisca')].flatMap((svg) => svg.getAnimations({ subtree: true })).filter((animation) => animation.playState === 'running').length);
  expect(await runningAnimations(), 'nenhuma Faísca da lista se anima').toBe(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await runningAnimations(), 'com movimento reduzido').toBe(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'atividades-1440');

  // Aprovações: "Aguardando você" NO TOPO (antes das regras globais), as duas aprovações com o bot, a ação legível e o tempo restante; nada para responder aqui.
  await page.goto('/aprovacoes');
  const pending = pendingSection(page);
  await expect(pending.getByRole('link')).toHaveCount(2);
  await expect(pending.getByText('Abrir leva à conversa, onde a aprovação é respondida.')).toBeVisible();
  for (const bot of [bots.financeiro, bots.contador]) {
    const link = pending.getByRole('link').filter({ hasText: bot.name });
    await expect(link).toContainText('Send Email');
    await expect(link).toContainText('Gmail');
    await expect(link).toContainText(/Expira em (23|24) h/);
  }
  await expect(page.getByRole('button', { name: /^(Permitir uma vez|Negar)$/ })).toHaveCount(0); // nomes exatos: "Negar tudo" é das regras globais
  const pendingBox = (await pending.boundingBox())!;
  const rulesBox = (await page.getByRole('heading', { level: 2, name: 'Regras globais' }).boundingBox())!;
  expect(pendingBox.y + pendingBox.height, '"Aguardando você" fica acima das regras globais').toBeLessThanOrEqual(rulesBox.y);
  const pendingLink = (bot: Bot) => pendingSection(page).getByRole('link').filter({ hasText: bot.name });
  expect(await faiscaOf(pendingLink(bots.financeiro))).toMatchObject({ ...LIST_FAISCA, state: 'waiting', body: '#60A5FA' });
  expect(await faiscaOf(pendingLink(bots.contador))).toMatchObject({ ...LIST_FAISCA, state: 'waiting', body: '#FB923C' });
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'aprovacoes-aguardando-1440');
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(pendingLink(bots.financeiro)).toBeVisible();
  expect(await faiscaOf(pendingLink(bots.financeiro))).toMatchObject({ ...LIST_FAISCA, state: 'waiting' });
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'aprovacoes-aguardando-375');

  // 375 px em Atividade e arquivos: o horário desce para a segunda linha, a página não rola na horizontal e o botão Parar continua alcançável.
  await page.goto(ACTIVITY_URL);
  await expect(rowOf(page, bots.escritor)).toContainText('Trabalhando');
  await expect(stopButton(page, bots.escritor)).toBeVisible();
  await expectNoHorizontalScroll(page);
  const row = rowOf(page, bots.escritor).first();
  const time = row.locator('time');
  const name = row.getByText(bots.escritor.name);
  expect((await time.boundingBox())!.y, 'horário na segunda linha em 375 px').toBeGreaterThan((await name.boundingBox())!.y + 4);
  expect(await faiscaOf(row), 'a Faísca não encolhe abaixo de 24 px').toMatchObject({ ...LIST_FAISCA, state: 'working' });
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'atividades-375');
  expect(problems).toEqual([]);
});

test('o clique em cada tipo de item abre a conversa já no cartão certo; a aprovação continua pendente', async ({ page }) => {
  const problems = watchPage(page);
  const bots = await seed(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/aprovacoes');

  // Pendência (em Aprovações) -> o cartão de aprovação pendente (a resposta é dada lá, com o contexto).
  await pendingSection(page).getByRole('link').filter({ hasText: bots.financeiro.name }).click();
  const approvalId = await targetMessage(page, bots.financeiro);
  await expect(page.locator(`#message-${approvalId}`).getByRole('region', { name: 'Aprovação pendente' })).toBeVisible();

  // Execução que falhou -> o cartão de falha. A que concluiu -> a resposta final do bot.
  await page.goto(ACTIVITY_URL);
  await rowOf(page, bots.pesquisador).filter({ hasText: 'Falhou' }).getByRole('link').click();
  const failedId = await targetMessage(page, bots.pesquisador);
  await expect(page.locator(`#message-${failedId}`).getByRole('region', { name: 'A execução falhou' })).toBeVisible();
  await page.goto(ACTIVITY_URL);
  await rowOf(page, bots.pesquisador).filter({ hasText: 'Concluída' }).getByRole('link').click();
  const answerId = await targetMessage(page, bots.pesquisador);
  await expect(page.locator(`#message-${answerId}`)).toContainText('Resposta: oi, tudo bem?');
  // Execução de rotina -> o cartão da rotina.
  await page.goto(ACTIVITY_URL);
  await rowOf(page, bots.monitor).getByRole('link').click();
  const routineId = await targetMessage(page, bots.monitor);
  await expect(page.locator(`#message-${routineId}`)).toBeVisible();

  // Nada foi respondido: as duas aprovações seguem pendentes na API.
  const after = await firstPage(page);
  expect(after.pending.map((item) => item.bot.name).sort()).toEqual(expect.arrayContaining([bots.contador.name, bots.financeiro.name]));
  expect(problems).toEqual([]);
});

test('Parar numa execução ativa a interrompe; parar a que espera aprovação a tira de "Aguardando você" (em Aprovações)', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  const bots = await seed(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/aprovacoes');
  await expect(pendingSection(page).getByRole('link').filter({ hasText: bots.contador.name })).toBeVisible();
  await page.goto(ACTIVITY_URL);

  await stopButton(page, bots.escritor).click();
  await expect(rowOf(page, bots.escritor)).toContainText('Interrompida');
  await expect(stopButton(page, bots.escritor)).toHaveCount(0);

  await stopButton(page, bots.contador).click();
  await expect(rowOf(page, bots.contador)).toContainText('Interrompida');
  await page.goto('/aprovacoes');
  await expect(pendingSection(page).getByRole('link').filter({ hasText: bots.contador.name })).toHaveCount(0);
  // A outra aprovação continua à espera do dono.
  await expect(pendingSection(page).getByRole('link').filter({ hasText: bots.financeiro.name })).toBeVisible();
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'atividades-apos-parar-1440');
  expect(problems).toEqual([]);
});

// -----------------------------------------------------------------------------------------------------------------------------
// Estados com a API simulada: independem do que os outros specs deixaram no banco
// -----------------------------------------------------------------------------------------------------------------------------

const BOT_X = { id: '8f0c2f4e-5f5f-4f7a-9d7e-1f8a6a1d0001', name: 'Bot simulado', color: '#60A5FA', archived: false };
const fakeRun = (id: number, status = 'completed') => ({
  runId: String(id),
  bot: BOT_X,
  routineName: null,
  status,
  createdAt: new Date(Date.now() - id * 60_000).toISOString(),
  messageId: String(id * 10),
});
const ACTIVITIES_URL = /\/api\/activities(\?.*)?$/;

test('estado vazio e erro de carga com nova tentativa', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  await apiLogin(page.context());
  await page.setViewportSize({ width: 1440, height: 900 });

  // Vazio total: sem pendências e sem execuções. O armazenamento e "Ver arquivos" seguem na tela (leitura própria).
  await page.route(ACTIVITIES_URL, (route) => route.fulfill({ json: { pending: [], items: [], nextCursor: null } }));
  await page.goto(ACTIVITY_URL);
  await expect(page.getByText('Nada por aqui ainda.')).toBeVisible();
  await expect(pendingSection(page)).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Armazenamento' })).toBeVisible();
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'atividades-vazio-1440');

  // Falha de carga: mensagem segura e "Tentar novamente", que carrega de verdade.
  await page.unroute(ACTIVITIES_URL);
  let calls = 0;
  await page.route(ACTIVITIES_URL, (route) => {
    calls += 1;
    return calls === 1 ? route.fulfill({ status: 500, json: { code: 'INTERNAL_ERROR', message: 'Algo deu errado. Tente novamente.' } }) : route.continue();
  });
  await page.goto(ACTIVITY_URL);
  await expect(page.getByText('Algo deu errado. Tente novamente.')).toBeVisible();
  await page.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(recentsSection(page)).toBeVisible();
  // Só as chamadas da API acusam erro: o 500 simulado é esperado e o `watchPage` o registra.
  expect(problems).toEqual(['500 GET /api/activities']);
});

test('Aprovações: sem pendências "Nada aguardando você."; com a leitura falhando o erro fica só na seção (com nova tentativa) e as regras globais seguem; com pendências a atividade ignora as pendências', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  await apiLogin(page.context());
  await page.setViewportSize({ width: 1440, height: 900 });

  // Sem pendências: texto no lugar dos itens, sem Faísca (vazio de lista administrativa), e as regras globais abaixo.
  await page.route(ACTIVITIES_URL, (route) => route.fulfill({ json: { pending: [], items: [], nextCursor: null } }));
  await page.goto('/aprovacoes');
  await expect(pendingSection(page)).toContainText('Nada aguardando você.');
  await expect(pendingSection(page).getByRole('link')).toHaveCount(0);
  await expect(pendingSection(page).locator('svg.faisca')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 2, name: 'Regras globais' })).toBeVisible();
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'aprovacoes-sem-pendencias-1440');
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalScroll(page);
  await attachShot(page, testInfo, 'aprovacoes-sem-pendencias-375');
  await page.setViewportSize({ width: 1440, height: 900 });

  // Falha de leitura: a mensagem e "Tentar novamente" ficam só na seção; as regras globais não somem. A leitura falha enquanto `failing` (a seção também relê quando o
  // número de pendências do shell muda, e isso não pode tirar o erro da tela antes de a asserção olhar).
  await page.unroute(ACTIVITIES_URL);
  let failing = true;
  await page.route(ACTIVITIES_URL, (route) =>
    failing
      ? route.fulfill({ status: 500, json: { code: 'INTERNAL_ERROR', message: 'Algo deu errado. Tente novamente.' } })
      : route.fulfill({ json: { pending: [], items: [], nextCursor: null } }),
  );
  await page.goto('/aprovacoes');
  await expect(pendingSection(page).getByRole('alert')).toContainText('Algo deu errado. Tente novamente.');
  await expect(page.getByRole('heading', { level: 2, name: 'Regras globais' })).toBeVisible();
  failing = false;
  await pendingSection(page).getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(pendingSection(page)).toContainText('Nada aguardando você.');

  // Com pendências na API, Atividade e arquivos continua sem a seção (e Aprovações a mostra).
  await page.unroute(ACTIVITIES_URL);
  const pendingItem = {
    approvalId: '501',
    runId: '9001',
    bot: BOT_X,
    sessionId: null,
    actionLabel: 'Send Email · Gmail',
    expiresAt: new Date(Date.now() + 23 * 3_600_000).toISOString(),
    messageId: '90010',
  };
  await page.route(ACTIVITIES_URL, (route) => route.fulfill({ json: { pending: [pendingItem], items: [fakeRun(9)], nextCursor: null } }));
  await page.goto(ACTIVITY_URL);
  await expect(recentsSection(page).getByRole('listitem')).toHaveCount(1);
  await expect(pendingSection(page)).toHaveCount(0);
  await page.goto('/aprovacoes');
  await expect(pendingSection(page).getByRole('link')).toHaveCount(1);
  await expect(pendingSection(page).getByRole('link')).toHaveAttribute('href', `/bots/${BOT_X.id}?mensagem=90010`);
  await expectNoA11yViolations(page);
  // O 500 simulado é esperado e o `watchPage` o registra (uma ou mais vezes: a seção também relê sozinha).
  expect([...new Set(problems)]).toEqual(['500 GET /api/activities']);
});

test('"Carregar mais" traz a página seguinte por cursor, e a tela não tem seção de pendências', async ({ page }) => {
  const problems = watchPage(page);
  await apiLogin(page.context());
  await page.setViewportSize({ width: 1440, height: 900 });
  const requested: (string | null)[] = [];
  await page.route(ACTIVITIES_URL, (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    requested.push(cursor);
    return route.fulfill({
      json:
        cursor === null
          ? { pending: [], items: [fakeRun(9), fakeRun(8), fakeRun(7)], nextCursor: '7' }
          : { pending: [], items: [fakeRun(6), fakeRun(5)], nextCursor: null },
    });
  });
  await page.goto(ACTIVITY_URL);
  await expect(recentsSection(page).getByRole('listitem')).toHaveCount(3);
  await expect(pendingSection(page)).toHaveCount(0); // as pendências não aparecem nesta tela
  await page.getByRole('button', { name: 'Carregar mais' }).click();
  await expect(recentsSection(page).getByRole('listitem')).toHaveCount(5);
  await expect(page.getByRole('button', { name: 'Carregar mais' })).toHaveCount(0);
  expect(requested).toContain('7'); // a segunda página foi pedida com o cursor da primeira
  await expectNoA11yViolations(page);
  expect(problems).toEqual([]);
});

test('parar com a lista desatualizada: a API recusa pelo runId, a tela avisa e a execução seguinte não é tocada', async ({ page }) => {
  const problems = watchPage(page);
  await apiLogin(page.context());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route(ACTIVITIES_URL, (route) => route.fulfill({ json: { pending: [], items: [fakeRun(4, 'running'), fakeRun(3)], nextCursor: null } }));
  let stopUrl = '';
  await page.route(/\/api\/bots\/[^/]+\/runs\/stop/, (route) => {
    stopUrl = route.request().url();
    return route.fulfill({ status: 409, json: { code: 'RUN_NOT_ACTIVE', message: 'Não há execução ativa para parar.' } });
  });
  await page.goto(ACTIVITY_URL);
  await page.getByRole('button', { name: `Parar a execução de ${BOT_X.name}` }).click();
  await expect(page.getByText('Esta execução já terminou.')).toBeVisible();
  expect(stopUrl).toContain(`/api/bots/${BOT_X.id}/runs/stop?runId=4`); // a parada leva o id da execução que o dono viu
  await expect(page.getByRole('button', { name: `Parar a execução de ${BOT_X.name}` })).toBeEnabled();
  expect(problems).toEqual(['409 POST /api/bots/8f0c2f4e-5f5f-4f7a-9d7e-1f8a6a1d0001/runs/stop']);
});

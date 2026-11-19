// E2E das rotinas (T9; A4, A12; F12, F13; phase 10, T6: A12 a A15, F7, F8) no navegador real, contra a pilha de produção (Postgres, API, worker com o
// agendador, Next e proxy) com o OpenCode Go FALSO. O modelo falso propõe rotinas por marcadores no texto: [rotina:nome|HH:mm] chama propose_routine com
// uma rotina diária no horário, e [rotina-invalida] com uma agenda abaixo do mínimo; [rotina-mudar|pausar|excluir:nome] chama propose_routine_change
// (ver packages/core/src/testing/fake-upstreams.ts).
//
// Cobre: o estado vazio e a criação pelo editor, o construtor de agenda com a prévia (mensal por posição, intervalo com janela, cron e erro
// de cron, fuso diferente do navegador, intervalo abaixo do mínimo e data no passado), "Executar agora" com o cartão e o link do histórico
// para a conversa, pausar, retomar e excluir, o arquivamento do bot que pausa as rotinas, e uma rotina única que o worker dispara sozinho no
// horário, com nenhuma tela aberta. Em 1440 e 375 px, com axe em cada estado. As rotinas são
// estado global (o painel lista todas), então o arquivo é serial e roda no projeto `chromium-routines`, depois da memória. O seletor de bot do editor mostra a Faísca
// parada do bot escolhido, e o grupo do painel mostra a Faísca de 24 px do bot no lugar da inicial de 16 px (phase 5, T1).
//
// Rotinas aceitas por padrão (phase 10, SEC-03 substituída): a rotina que o bot propõe já nasce ativa e a alteração que ele propõe já vale, ambas com o
// cartão "Rotina criada pelo bot" ou "Rotina “X” alterada pelo bot" e as ações Recusar (modal) e Editar (editor ligado ao cartão). Os testes provam, pela
// tela e pelo estado real da API: a rotina ativa logo após a proposta, Recusar desfazendo cada caso (inclusive a exclusão, com o histórico de volta),
// Editar pelo editor, os avisos "recusada" e "editada" no fim da conversa sem acender a bolinha de não lido, a rotina que mudou depois (ao vivo e no clique),
// o foco que não se perde quando Recusar tira os botões da tela, a agenda recusada que não vira rotina nem cartão, e os cartões ANTIGOS (proposta e alteração
// pendentes, gravados antes da phase 10), que a pilha não consegue mais gerar: eles são renderizados a partir do snapshot real da conversa com o estado trocado
// e seus cliques (Confirmar, Editar, o 409 ROUTINE_CHANGED) são provados com as respostas do POST simuladas (ver `showLegacyCards`).
import type { Locator, Page } from '@playwright/test';
import { ERROR_CODES } from '@aion/shared';
import { tableMarker } from '../../../packages/core/src/testing/fake-upstreams';
import { E2E_PORTS } from '../../../tests/support/e2e-env';
import { ORIGIN, apiHeaders, attachShot, backLink, contentOf, ensureCredential, expect, expectNoA11yViolations, expectNoHorizontalScroll, faiscaLook, tabBarOf, tabOf, test, uniqueBotName, watchPage, openWorkLine } from './support/fixtures';

test.describe.configure({ mode: 'serial' });

const FAKE_PROVIDER = 'valid-e2e-rotinas-1111';
const DAILY = { schedule: { type: 'daily', times: ['07:00'] }, timezone: 'America/Sao_Paulo', startsAt: null, endsAt: null, maxRuns: null };
/** Selo do cartão cuja rotina saiu do estado em que o bot a deixou (o texto é o do design, do estado; o erro do clique vem do envelope da API). */
const SUPERSEDED = 'A rotina mudou depois desta proposta';

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

async function createRoutine(page: Page, botId: string, name: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const response = await page.context().request.post(`${ORIGIN}/api/routines`, {
    headers: await apiHeaders(page),
    data: { name, botId, instruction: `Instrução de ${name}`, ...DAILY, ...overrides },
  });
  expect(response.status(), `criar a rotina ${name}: ${await response.text()}`).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/**
 * Apaga as rotinas que já existem antes do arquivo (E29). O painel lista TODAS e o primeiro teste espera o estado vazio e a contagem
 * "Ativas 1", mas as rotinas de uma repetição anterior (`--repeat-each`) ou de outro spec continuariam no banco. Exclui pela API, como o
 * dono faria. Roda uma vez por worker, e cada repetição ou nova tentativa de um arquivo serial é um worker novo. O contexto próprio
 * (`browser.newContext`) existe porque o fixture `page` não está disponível num `beforeAll`.
 */
test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const headers = await apiHeaders(await context.newPage());
    const listed = (await (await context.request.get(`${ORIGIN}/api/routines`, { headers })).json()) as { routines: { id: string }[] };
    for (const { id } of listed.routines) {
      expect((await context.request.delete(`${ORIGIN}/api/routines/${id}`, { headers })).status(), `excluir a rotina ${id}`).toBe(204);
    }
  } finally {
    await context.close();
  }
});

const toast = (page: Page, text: string) => page.getByText(text, { exact: true }).first(); // toasts anteriores ainda podem estar na tela
const panel = (page: Page) => page.getByRole('complementary');
const composer = (page: Page) => page.getByRole('textbox', { name: 'Mensagem' });
const preview = (page: Page) => page.getByRole('region', { name: 'Próximas execuções' });
const kind = (page: Page, label: string) => page.getByRole('radio', { name: label, exact: true });

type ApiHeaders = Record<string, string>;

/** Manda uma mensagem pelo composer, como o dono faria. */
async function send(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

/** Cartão "Rotina criada pelo bot" da rotina `name` (o título é o mesmo em todos, o nome da rotina fica no corpo). */
const createdCard = (page: Page, name: string) => page.getByRole('region', { name: 'Rotina criada pelo bot', exact: true }).filter({ hasText: name });
/** Cartão de alteração já aplicada pelo bot (`verb`: alterada, pausada, retomada ou excluída). O título é o nome da região. */
const appliedCard = (page: Page, name: string, verb: 'alterada' | 'pausada' | 'retomada' | 'excluída') => page.getByRole('region', { name: `Rotina “${name}” ${verb} pelo bot`, exact: true });
/** Aviso de uma linha que o dono gerou ao recusar ou editar pelo cartão. */
const noticeCard = (page: Page, name: string, verb: 'recusada' | 'editada') => page.getByRole('region', { name: `Rotina “${name}” ${verb}`, exact: true });
/** Contêiner de estado e ações de um cartão de rotina aplicada pelo bot: o único trecho do cartão que não sai do DOM, e por isso o alvo do foco depois de Recusar. */
const stateOf = (card: Locator) => card.getByRole('group', { name: 'Estado da rotina' });

/** A conversa do bot como o navegador a recebe (snapshot): os cartões do tipo pedido, do mais antigo ao mais novo. */
async function cardsOf(page: Page, botId: string, headers: ApiHeaders, type: string): Promise<{ id: string; card: Record<string, unknown> }[]> {
  const response = await page.context().request.get(`${ORIGIN}/api/bots/${botId}/conversation`, { headers });
  const snapshot = (await response.json()) as { items: { id: string; kind: string; card?: Record<string, unknown> }[] };
  return snapshot.items.flatMap((item) => (item.kind === 'card' && item.card?.type === type ? [{ id: item.id, card: item.card }] : []));
}

/** Espera a conversa do bot ficar sem execução ativa ou na fila: a resposta final já foi gravada e nada mais chega por conta do modelo. */
async function waitIdle(page: Page, botId: string, headers: ApiHeaders): Promise<void> {
  await expect
    .poll(async () => ((await (await page.context().request.get(`${ORIGIN}/api/bots/${botId}/conversation`, { headers })).json()) as { runs: unknown[] }).runs.length, { timeout: 30_000 })
    .toBe(0);
}

/** A rotina como a API a guarda agora (status e campos), ou `null` quando não existe mais. */
async function routineNow(page: Page, id: string, headers: ApiHeaders): Promise<{ id: string; name: string; instruction: string; status: string; summary: string; runCount: number } | null> {
  const response = await page.context().request.get(`${ORIGIN}/api/routines/${id}`, { headers });
  if (response.status() === 404) return null;
  expect(response.status(), 'ler a rotina').toBe(200);
  return (await response.json()) as { id: string; name: string; instruction: string; status: string; summary: string; runCount: number };
}

/** O id da rotina que o bot criou na conversa, pelo nome (a lista da API traz todas as rotinas). */
async function routineIdByName(page: Page, headers: ApiHeaders, botId: string, name: string): Promise<string> {
  const listed = (await (await page.context().request.get(`${ORIGIN}/api/routines`, { headers })).json()) as { routines: { id: string; name: string; bot: { id: string } }[] };
  const found = listed.routines.find((routine) => routine.name === name && routine.bot.id === botId);
  expect(found, `a rotina "${name}" do bot existe`).toBeDefined();
  return found!.id;
}

/** Espera a prévia terminar de calcular (o debounce e a chamada à API). */
const previewReady = async (page: Page) => {
  await expect(preview(page).getByText('Calculando…')).toHaveCount(0);
  await expect(preview(page).getByText('Complete a agenda para ver as próximas execuções.')).toHaveCount(0);
};

// ---------------------------------------------------------------------------------------------
// Cartões do fluxo ANTIGO (proposta e alteração pendentes, gravados antes da phase 10)
// ---------------------------------------------------------------------------------------------

/** Item da conversa como a API o entrega (mensagem de cartão ou outra); só o que os helpers abaixo leem. */
type SnapshotItem = { id: string; kind: string; card?: Record<string, unknown> } & Record<string, unknown>;

/**
 * O item como o servidor o devolveria se o cartão tivesse sido gravado antes da phase 10: proposta pendente (sem rotina), e alteração pendente ou
 * desatualizada (`stale`, sem rotina), esta para os nomes de rotina em `staleChanges`. Só o estado muda; o conteúdo (proposta, antes e depois) é o que o bot
 * realmente propôs na pilha.
 */
function asLegacyItem(item: SnapshotItem, staleChanges: ReadonlySet<string>): SnapshotItem {
  const { card } = item;
  if (item.kind !== 'card' || card === undefined) return item;
  if (card.type === 'routine_proposal') return { ...item, card: { ...card, status: 'pending', routineId: null } };
  if (card.type === 'routine_change') {
    const stale = staleChanges.has(String(card.routineName));
    return { ...item, card: { ...card, status: stale ? 'stale' : 'pending', ...(stale ? { routineId: null } : {}) } };
  }
  return item;
}

/**
 * A pilha só gera cartões do fluxo novo (os do antigo existem em conversas gravadas antes da phase 10). Para ver como a tela os desenha, a leitura da conversa
 * do bot volta com os cartões de proposta e de alteração no estado antigo, sem mudar nada no servidor. `staleChanges` é lido a cada leitura: o teste o altera
 * e relê a página para ver o estado "Desatualizada".
 */
async function showLegacyCards(page: Page, staleChanges: Set<string>): Promise<void> {
  await page.route(/\/api\/bots\/[0-9a-f-]{36}\/conversation$/, async (route) => {
    const response = await route.fetch();
    const snapshot = (await response.json()) as { items: SnapshotItem[] };
    snapshot.items = snapshot.items.map((item) => asLegacyItem(item, staleChanges));
    await route.fulfill({ response, json: snapshot });
  });
}

/**
 * Guarda os EventSource que a página abrir (vale a partir da próxima navegação ou recarga) para `deliverToStream` entregar a um deles o evento que o servidor
 * mandaria. É o único jeito de ver o cartão antigo mudar AO VIVO depois de um clique cujo efeito no servidor foi simulado.
 */
async function captureStreams(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const streams: EventSource[] = [];
    (window as unknown as { aionStreams: EventSource[] }).aionStreams = streams;
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        streams.push(this);
      }
    };
  });
}

/** Entrega o item às conexões abertas da conversa como o evento `message` do SSE faria; a tela o aplica pelo id da mensagem. */
async function deliverToStream(page: Page, item: SnapshotItem): Promise<void> {
  await page.evaluate((data) => {
    for (const stream of (window as unknown as { aionStreams: EventSource[] }).aionStreams) {
      if (stream.readyState !== EventSource.CLOSED) stream.dispatchEvent(new MessageEvent('message', { data }));
    }
  }, JSON.stringify(item));
}

test('estado vazio e criação pelo editor: nome, bot, instrução e agenda diária com a prévia, em 1440 e 375 px', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  await ensureCredential(page, 'provider', FAKE_PROVIDER);
  await page.setViewportSize({ width: 1440, height: 900 });
  const botId = await createBot(page, 'Agendador');

  await page.goto('/rotinas');
  await expect(page.getByRole('heading', { name: 'Rotinas', level: 1 })).toBeVisible();
  await expect(page.getByText('Nenhuma rotina. Peça a um bot ou crie aqui.')).toBeVisible();
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotinas-vazio-1440');

  await page.getByRole('link', { name: 'Nova rotina' }).first().click();
  await expect(page).toHaveURL(/\/rotinas\/nova$/);
  await expect(page.getByRole('heading', { name: 'Nova rotina', level: 1 })).toBeVisible();

  // Campos obrigatórios: salvar vazio aponta o que falta e leva o foco ao primeiro erro.
  await page.getByRole('button', { name: 'Salvar rotina' }).click();
  await expect(page.getByText('Informe o nome.')).toBeVisible();
  await expect(page.getByText('Escolha o bot.')).toBeVisible();
  await expect(page.getByText('Informe a instrução.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Nome', exact: true })).toBeFocused();

  await page.getByRole('textbox', { name: 'Nome', exact: true }).fill('Resumo da manhã');
  await page.getByRole('combobox', { name: 'Bot', exact: true }).selectOption({ label: uniqueBotName('Agendador') });
  await page.getByRole('textbox', { name: 'Instrução' }).fill('Resuma as novidades do dia.');

  // Diária às 07:00 (padrão): a prévia mostra 5 datas às 07:00 no fuso da rotina.
  await previewReady(page);
  await expect(preview(page).getByText('Todos os dias às 07:00')).toBeVisible();
  await expect(preview(page).getByRole('listitem')).toHaveCount(5);
  await expect(preview(page).getByRole('listitem').first()).toContainText('07:00');
  // Segundo horário: a prévia passa a alternar 07:00 e 18:00.
  await page.getByRole('button', { name: 'Adicionar horário' }).click();
  await page.getByLabel('Horário 2').fill('18:00');
  await previewReady(page);
  await expect(preview(page).getByText('Todos os dias às 07:00 e 18:00')).toBeVisible();
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-editor-diaria-1440');

  await page.getByRole('button', { name: 'Salvar rotina' }).click();
  await expect(toast(page, 'Rotina salva')).toBeVisible();
  await expect(page).toHaveURL(/\/rotinas$/);

  // O painel lista a rotina, agrupada pelo bot, com a agenda legível e a próxima execução.
  const group = panel(page).getByRole('region', { name: `Rotinas de ${uniqueBotName('Agendador')}` });
  await expect(group.getByRole('link', { name: /Resumo da manhã/ })).toContainText('Todos os dias às 07:00 e 18:00');
  await expect(group.getByRole('link', { name: /Resumo da manhã/ })).toContainText(/Próxima: (hoje|amanhã) \d{2}:\d{2}/);
  await expect(panel(page).getByRole('button', { name: 'Ativas 1' })).toHaveAttribute('aria-pressed', 'true');
  // A página também mostra a lista (phase 5, T6, no lugar do antigo texto de orientação), agrupada pelo bot com a Faísca de 24 px.
  const pageGroup = contentOf(page).getByRole('region', { name: `Rotinas de ${uniqueBotName('Agendador')}` });
  await expect(pageGroup.getByRole('link', { name: /Resumo da manhã/ })).toContainText('Todos os dias às 07:00 e 18:00');
  expect(await faiscaLook(pageGroup.locator('svg.faisca'))).toMatchObject({ detail: 'small', still: true, decorative: true, size: [24, 24] });
  await expect(page.getByText('Escolha uma rotina na lista para editar, ou crie uma nova.')).toHaveCount(0);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotinas-lista-1440');

  // Reabrir para editar traz os valores salvos.
  await group.getByRole('link', { name: /Resumo da manhã/ }).click();
  await expect(page.getByRole('heading', { name: 'Resumo da manhã', level: 1 })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Nome', exact: true })).toHaveValue('Resumo da manhã');
  await expect(page.getByLabel('Horário 2')).toHaveValue('18:00');

  // 375 px: editor em coluna única (sem barra inferior), prévia depois da agenda, sem rolagem horizontal.
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByRole('region', { name: 'Próximas execuções' })).toBeVisible();
  await expect(tabBarOf(page)).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-editor-diaria-375');
  // "Voltar" leva a Rotinas (o pai fixo), a aba que lista as rotinas na própria página, agrupadas por bot com a Faísca de 24 px, com a barra inferior.
  await backLink(page).click();
  await expect(page).toHaveURL(/\/rotinas$/);
  await expect(tabOf(page, 'Rotinas')).toHaveAttribute('aria-current', 'page');
  const group375 = contentOf(page).getByRole('region', { name: `Rotinas de ${uniqueBotName('Agendador')}` });
  await expect(group375.getByRole('link', { name: /Resumo da manhã/ })).toBeVisible();
  expect(await faiscaLook(group375.locator('svg.faisca'))).toMatchObject({ detail: 'small', still: true, decorative: true, size: [24, 24] });
  await expect(contentOf(page).getByRole('link', { name: 'Nova rotina' })).toHaveAttribute('href', '/rotinas/nova'); // o "+" do cabeçalho
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotinas-lista-375');

  expect(botId).toBeTruthy();
  expect(problems).toEqual([]);
});

test('o construtor de agenda: mensal por posição, intervalo com janela, cron, fuso diferente do navegador e erros com o motivo', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  await ensureCredential(page, 'provider', FAKE_PROVIDER);
  await page.setViewportSize({ width: 1440, height: 900 });
  await apiHeaders(page);
  await page.goto('/rotinas/nova');
  await expect(page.getByRole('heading', { name: 'Nova rotina', level: 1 })).toBeVisible();

  // Mensal por posição: a segunda terça-feira do mês, às 09:00.
  await kind(page, 'Mensal').click();
  await page.getByRole('radio', { name: 'Dia da semana', exact: true }).check();
  await page.getByLabel('Posição no mês').selectOption('second');
  await page.getByRole('combobox', { name: 'Dia da semana', exact: true }).selectOption('TU');
  await page.getByLabel('Horário', { exact: true }).fill('09:00');
  await previewReady(page);
  await expect(preview(page).getByText('Na segunda terça-feira do mês às 09:00')).toBeVisible();
  const lines = await preview(page).getByRole('listitem').allTextContents();
  expect(lines).toHaveLength(5);
  for (const line of lines) expect(line).toMatch(/^ter\.?,? \d{2}\/\d{2}\/\d{4},? 09:00/);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-editor-mensal-posicao-1440');

  // Intervalo com janela: a cada 30 minutos entre 09:00 e 18:00.
  await kind(page, 'Intervalo').click();
  await page.getByRole('spinbutton', { name: 'A cada' }).fill('30');
  await page.getByRole('checkbox', { name: 'Somente em uma janela do dia' }).check();
  await page.getByLabel('Janela: início').fill('09:00');
  await page.getByLabel('Janela: fim').fill('18:00');
  await previewReady(page);
  await expect(preview(page).getByText('A cada 30 minutos, das 09:00 às 18:00')).toBeVisible();
  for (const line of await preview(page).getByRole('listitem').allTextContents()) {
    const hour = Number(/(\d{2}):\d{2}/.exec(line.replace(/\d{2}\/\d{2}\/\d{4}/, ''))?.[1]);
    expect(hour, line).toBeGreaterThanOrEqual(9);
    expect(hour, line).toBeLessThanOrEqual(18);
  }
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-editor-intervalo-janela-1440');

  // Intervalo abaixo do mínimo: o motivo vem do servidor, na prévia e ao salvar.
  await page.getByRole('spinbutton', { name: 'A cada' }).fill('3');
  await previewReady(page);
  await expect(page.getByTestId('previa-invalida')).toHaveText('Agenda inválida: O intervalo mínimo é de 5 minutos.');

  // Cron: descrição legível e prévia; depois um cron quebrado mostra o erro.
  await kind(page, 'Cron').click();
  await page.getByRole('textbox', { name: 'Expressão cron' }).fill('0 7 * * 1-5');
  await previewReady(page);
  await expect(page.getByText(/Às 07:00, de segunda-feira a sexta-feira/).first()).toBeVisible();
  await expect(preview(page).getByRole('listitem')).toHaveCount(5);
  await page.getByRole('textbox', { name: 'Expressão cron' }).fill('99 7 * * *');
  await previewReady(page);
  await expect(page.getByTestId('previa-invalida')).toContainText('Agenda inválida: Expressão cron inválida');
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-editor-cron-erro-1440');

  // Fuso diferente do navegador (São Paulo): cada linha mostra também o horário local.
  await page.getByRole('textbox', { name: 'Expressão cron' }).fill('0 9 * * *');
  await page.getByLabel('Fuso horário').fill('Asia/Tokyo');
  await previewReady(page);
  await expect(preview(page).getByText(/No seu horário:/).first()).toBeVisible();
  await expect(preview(page).getByRole('listitem').first()).toContainText('09:00');
  await expect(preview(page).getByRole('listitem').first()).toContainText('21:00'); // 09:00 em Tóquio = 21:00 da véspera em Brasília
  await page.getByLabel('Fuso horário').fill('Marte/Olimpo');
  await previewReady(page);
  await expect(page.getByTestId('previa-invalida')).toHaveText('Agenda inválida: Fuso horário desconhecido.');
  await page.getByLabel('Fuso horário').fill('America/Sao_Paulo');

  // Execução única no passado.
  await kind(page, 'Única').click();
  await page.getByLabel('Data e hora').fill('2020-01-01T10:00');
  await previewReady(page);
  await expect(page.getByTestId('previa-invalida')).toHaveText('Agenda inválida: A data e a hora da execução já passaram.');

  // 375 px: segmentos quebram em linhas e a página não rola na horizontal.
  await page.setViewportSize({ width: 375, height: 812 });
  await kind(page, 'Semanal').click();
  await expect(page.getByRole('button', { name: 'Segunda-feira' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Sábado' }).click();
  await previewReady(page);
  await expect(preview(page).getByText('Segundas, terças, quartas, quintas, sextas e sábados às 07:00')).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-editor-semanal-375');
  await kind(page, 'Mensal').click();
  await expectNoHorizontalScroll(page);
  await attachShot(page, testInfo, 'rotina-editor-mensal-375');
  await kind(page, 'Intervalo').click();
  await expectNoHorizontalScroll(page);
  await attachShot(page, testInfo, 'rotina-editor-intervalo-375');
  await kind(page, 'Cron').click();
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-editor-cron-375');

  expect(problems).toEqual([]);
});

test('uma agenda recusada pelo servidor aparece na seção Agenda ao salvar, com o foco no campo', async ({ page }) => {
  await ensureCredential(page, 'provider', FAKE_PROVIDER);
  const botId = await createBot(page, 'Recusado');
  await page.goto('/rotinas/nova');
  await page.getByRole('textbox', { name: 'Nome', exact: true }).fill('Rápida demais');
  await page.getByRole('combobox', { name: 'Bot', exact: true }).selectOption(botId);
  await page.getByRole('textbox', { name: 'Instrução' }).fill('Verificar.');
  await kind(page, 'Intervalo').click();
  await page.getByRole('spinbutton', { name: 'A cada' }).fill('2');
  await previewReady(page);
  await page.getByRole('button', { name: 'Salvar rotina' }).click();
  await expect(page.getByText('O intervalo mínimo é de 5 minutos.').last()).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'A cada' })).toBeFocused();
  await expect(page).toHaveURL(/\/rotinas\/nova$/);
  // Corrigir e salvar passa.
  await page.getByRole('spinbutton', { name: 'A cada' }).fill('15');
  await previewReady(page);
  await page.getByRole('button', { name: 'Salvar rotina' }).click();
  await expect(toast(page, 'Rotina salva')).toBeVisible();
});

test('Executar agora enfileira no bot, o cartão da rotina chega concluído na conversa e o histórico leva até ele', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  await ensureCredential(page, 'provider', FAKE_PROVIDER);
  await page.setViewportSize({ width: 1440, height: 900 });
  const botId = await createBot(page, 'Executor', '#F59E0B');
  const routineId = await createRoutine(page, botId, 'Relatório do dia', { instruction: 'Resuma as novidades do dia.' });
  await page.goto('/rotinas');

  await panel(page).getByRole('button', { name: 'Ações da rotina Relatório do dia' }).click();
  await page.getByRole('menuitem', { name: 'Executar agora' }).click();
  await expect(toast(page, 'Execução enfileirada')).toBeVisible();

  await page.goto(`/bots/${botId}`);
  const card = page.getByRole('region', { name: /Rotina “Relatório do dia” concluída/ });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Executada agora a pedido seu');
  // A rotina concluída é uma linha discreta (phase 18, A12): o ícone do calendário e o link "Ver rotina", sem a Faísca do desfecho (essa fica nos cartões de falha).
  await expect(card.locator('[data-icon="CalendarClock"]')).toHaveCount(1);
  await expect(card.locator('svg.faisca')).toHaveCount(0);
  await expect(card.getByRole('link', { name: 'Ver rotina' })).toBeVisible();
  // T20: o resultado do bot aparece UMA vez, na bolha logo abaixo do cartão (o provedor falso ecoa a instrução); o cartão só conta o horário.
  await expect(card.locator('.markdown')).toHaveCount(0);
  await expect(card).not.toContainText('Resuma as novidades do dia.');
  await expect(page.getByRole('log', { name: 'Conversa' }).getByText('Resuma as novidades do dia.')).toHaveCount(1);
  await expect(page.getByRole('region', { name: /A execução falhou/ })).toHaveCount(0);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-cartao-concluida-1440');

  // Histórico: a execução manual, concluída, com o link para o cartão.
  await page.goto(`/rotinas/${routineId}/historico`);
  await expect(page.getByRole('heading', { name: 'Histórico: Relatório do dia', level: 1 })).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: 'Concluída' });
  await expect(row).toContainText('(manual)');
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-historico-1440');
  await row.getByRole('link', { name: 'Ver na conversa' }).click();
  await expect(page).toHaveURL(new RegExp(`/bots/${botId}\\?mensagem=\\d+$`));
  await expect(page.getByRole('region', { name: /Rotina “Relatório do dia” concluída/ })).toBeVisible();

  // 375 px: o cartão e o histórico cabem na tela.
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalScroll(page);
  const actionBox = (await card.getByRole('link', { name: 'Ver rotina' }).boundingBox())!;
  const bodyBox = (await card.getByText('Executada agora a pedido seu').boundingBox())!;
  expect(actionBox.x + actionBox.width, 'o link da linha cabe na tela de 375 px').toBeLessThanOrEqual(375);
  expect(bodyBox.x + bodyBox.width, 'o texto da linha cabe na tela de 375 px').toBeLessThanOrEqual(375);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-cartao-concluida-375');
  await page.goto(`/rotinas/${routineId}/historico`);
  await expect(page.getByRole('row').filter({ hasText: 'Concluída' })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-historico-375');

  expect(problems).toEqual([]);
});

test('uma rotina que falha: o cartão mostra a Faísca do bot em erro, parada, e o motivo, em 1440 e 375 px', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  await ensureCredential(page, 'provider', FAKE_PROVIDER);
  await page.setViewportSize({ width: 1440, height: 900 });
  const botId = await createBot(page, 'Falhador', '#A78BFA');
  // O provedor falso devolve 503 a quem pede "[falha]": a instrução da rotina é a mensagem da execução, então a execução falha.
  const routineId = await createRoutine(page, botId, 'Rotina que falha', { instruction: '[falha] provedor fora do ar' });
  const headers = await apiHeaders(page);
  const started = await page.context().request.post(`${ORIGIN}/api/routines/${routineId}/run`, { headers });
  expect(started.status(), 'executar a rotina agora').toBe(202);

  await page.goto(`/bots/${botId}`);
  const card = page.getByRole('region', { name: /Rotina “Rotina que falha” falhou/ });
  await expect(card).toBeVisible();
  // O desfecho em falha vira a Faísca em erro (parada), no lugar do ícone da legenda; o motivo continua em texto, em `--danger`.
  expect(await faiscaLook(card.locator('svg.faisca'))).toMatchObject({ state: 'error', detail: 'small', still: true, decorative: true, size: [32, 32], body: '#A78BFA' });
  await expect(card.locator('[data-icon="CalendarClock"]')).toHaveCount(0);
  // O motivo da falha é o último parágrafo do cartão (depois do título e do horário) e vai em --danger.
  await expect(card.locator('p').last()).toHaveCSS('color', 'rgb(248, 113, 113)');
  await expect(card).toContainText('Executada agora a pedido seu');
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-cartao-falha-1440');

  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalScroll(page);
  const faiscaBox = (await card.locator('svg.faisca').boundingBox())!;
  const bodyBox = (await card.getByText('Executada agora a pedido seu').boundingBox())!;
  expect(faiscaBox.x + faiscaBox.width, 'a Faísca fica à esquerda do texto').toBeLessThanOrEqual(bodyBox.x);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-cartao-falha-375');
  expect(problems).toEqual([]);
});

test('pausar, retomar e excluir pelo menu da lista, com o filtro e os contadores', async ({ page }, testInfo) => {
  await ensureCredential(page, 'provider', FAKE_PROVIDER);
  await page.setViewportSize({ width: 1440, height: 900 });
  const botId = await createBot(page, 'Gerenciado');
  await createRoutine(page, botId, 'Para pausar');
  await page.goto('/rotinas');

  const item = (name: string) => panel(page).getByRole('link', { name: new RegExp(name) });
  await expect(item('Para pausar')).toBeVisible();
  await panel(page).getByRole('button', { name: 'Ações da rotina Para pausar' }).click();
  await page.getByRole('menuitem', { name: 'Pausar' }).click();
  await expect(toast(page, 'Rotina pausada')).toBeVisible();
  // Pausada sai de "Ativas" e aparece em "Pausadas", com o texto de estado.
  await expect(item('Para pausar')).toHaveCount(0);
  await panel(page).getByRole('button', { name: /^Pausadas/ }).click();
  await expect(item('Para pausar')).toContainText('Pausada');
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotinas-pausada-1440');

  await panel(page).getByRole('button', { name: 'Ações da rotina Para pausar' }).click();
  await page.getByRole('menuitem', { name: 'Retomar' }).click();
  await expect(toast(page, 'Rotina retomada')).toBeVisible();
  await panel(page).getByRole('button', { name: /^Ativas/ }).click();
  await expect(item('Para pausar')).toContainText(/Próxima: (hoje|amanhã) 07:00/);

  // Excluir pede confirmação.
  await panel(page).getByRole('button', { name: 'Ações da rotina Para pausar' }).click();
  await page.getByRole('menuitem', { name: 'Excluir' }).click();
  const dialog = page.getByRole('dialog', { name: /Excluir a rotina/ });
  await expect(dialog).toBeVisible();
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotinas-excluir-1440');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(item('Para pausar')).toBeVisible();
  await panel(page).getByRole('button', { name: 'Ações da rotina Para pausar' }).click();
  await page.getByRole('menuitem', { name: 'Excluir' }).click();
  await page.getByRole('dialog', { name: /Excluir a rotina/ }).getByRole('button', { name: 'Excluir rotina' }).click();
  await expect(toast(page, 'Rotina excluída')).toBeVisible();
  await expect(item('Para pausar')).toHaveCount(0);
});

test('arquivar o bot pausa as rotinas dele; retomar enquanto arquivado é recusado e desarquivar não as retoma (A4)', async ({ page }) => {
  await ensureCredential(page, 'provider', FAKE_PROVIDER);
  await page.setViewportSize({ width: 1440, height: 900 });
  const botId = await createBot(page, 'Arquivável');
  const routineId = await createRoutine(page, botId, 'Do arquivável');
  const headers = await apiHeaders(page);

  // Arquivar pela tela de edição do bot (a mesma ação do dono), com a sessão do navegador.
  await page.goto(`/bots/${botId}/editar`);
  await page.getByRole('button', { name: 'Arquivar bot' }).click();
  await page.getByRole('dialog', { name: 'Arquivar este bot?' }).getByRole('button', { name: 'Arquivar' }).click();
  await expect(toast(page, 'Bot arquivado')).toBeVisible();

  await page.goto('/rotinas');
  await panel(page).getByRole('button', { name: /^Pausadas/ }).click();
  await expect(panel(page).getByRole('link', { name: /Do arquivável/ })).toContainText('Pausada');
  await panel(page).getByRole('button', { name: 'Ações da rotina Do arquivável' }).click();
  await page.getByRole('menuitem', { name: 'Retomar' }).click();
  await expect(page.getByText('Este bot está arquivado. Desarquive para continuar.').first()).toBeVisible();

  const unarchived = await page.context().request.post(`${ORIGIN}/api/bots/${botId}/unarchive`, { headers });
  expect(unarchived.status()).toBe(200);
  const routine = (await (await page.context().request.get(`${ORIGIN}/api/routines/${routineId}`, { headers })).json()) as { status: string };
  expect(routine.status, 'desarquivar não retoma as rotinas').toBe('paused');
});

test('a rotina proposta pelo bot já nasce ativa e rodando na agenda: o cartão traz a agenda, a instrução, as datas, Editar e Recusar, em 1280 e 375 px (A12)', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  await ensureCredential(page, 'provider', FAKE_PROVIDER);
  await page.setViewportSize({ width: 1280, height: 800 });
  const botId = await createBot(page, 'Proponente', '#34D399');
  const headers = await apiHeaders(page);
  await page.goto(`/bots/${botId}`);

  await send(page, 'Quero um resumo todo dia [rotina:Resumo diário|07:30]');
  const card = createdCard(page, 'Resumo diário');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Todos os dias às 07:30 · America/Sao_Paulo');
  // R12 segue valendo: o que a rotina executa sozinha, com o poder do bot, fica à vista no cartão.
  await expect(card).toContainText('Instrução que a rotina executa');
  await expect(card).toContainText('Executar Resumo diário');
  await expect(card.getByRole('list', { name: 'Próximas execuções' }).getByRole('listitem')).toHaveCount(5);
  await expect(card.getByText('Ativa', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Editar', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Recusar', exact: true })).toBeVisible();
  // Nada a confirmar: a rotina que o bot acabou de criar não tem cartão "Proposta de rotina" nem botão Confirmar.
  await expect(page.getByRole('region', { name: 'Proposta de rotina' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Confirmar' })).toHaveCount(0);
  await waitIdle(page, botId, headers);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-criada-ativa-1280');

  // A12: sem nenhum clique do dono a rotina já está ativa e aparece em Rotinas, com a próxima execução na agenda.
  const routineId = await routineIdByName(page, headers, botId, 'Resumo diário');
  expect(await routineNow(page, routineId, headers)).toMatchObject({ status: 'active', summary: 'Todos os dias às 07:30' });
  await page.goto('/rotinas');
  const group = panel(page).getByRole('region', { name: `Rotinas de ${uniqueBotName('Proponente')}` });
  await expect(group.getByRole('link', { name: /Resumo diário/ })).toContainText('Todos os dias às 07:30');
  await expect(group.getByRole('link', { name: /Resumo diário/ })).toContainText(/Próxima: (hoje|amanhã) 07:30/);

  // 375 px: as ações descem para uma linha abaixo do corpo do cartão, com "Editar" antes de "Recusar", sem rolagem horizontal.
  await page.goto(`/bots/${botId}`);
  await page.setViewportSize({ width: 375, height: 812 });
  const mobile = createdCard(page, 'Resumo diário');
  await expect(mobile).toBeVisible();
  await expectNoHorizontalScroll(page);
  const datesBox = (await mobile.getByRole('list', { name: 'Próximas execuções' }).boundingBox())!;
  const editBox = (await mobile.getByRole('button', { name: 'Editar', exact: true }).boundingBox())!;
  const refuseBox = (await mobile.getByRole('button', { name: 'Recusar', exact: true }).boundingBox())!;
  expect(editBox.y, 'as ações descem para uma linha abaixo do corpo do cartão').toBeGreaterThanOrEqual(datesBox.y + datesBox.height);
  expect(editBox.x, '"Editar" vem antes de "Recusar"').toBeLessThan(refuseBox.x);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-criada-ativa-375');

  expect(problems).toEqual([]);
});

test('uma agenda recusada pelo servidor não vira rotina nem cartão: o bot recebe o motivo e o dono não vê "Rotina criada pelo bot" nem proposta (A12)', async ({ page }) => {
  const problems = watchPage(page);
  await ensureCredential(page, 'provider', FAKE_PROVIDER);
  await page.setViewportSize({ width: 1280, height: 800 });
  const botId = await createBot(page, 'Agenda recusada', '#FB923C');
  const headers = await apiHeaders(page);
  const log = page.getByRole('log', { name: 'Conversa' });
  await page.goto(`/bots/${botId}`);

  // O modelo falso chama propose_routine com um intervalo de 2 minutos, abaixo do mínimo de 5: a ferramenta recusa e o resultado volta ao bot, que o ecoa na resposta.
  await send(page, 'Outra rotina [rotina-invalida]');
  await expect(log.getByText(/Agenda inválida: .*5 minutos/).first()).toBeVisible();
  await waitIdle(page, botId, headers);

  // Nada foi criado: nenhuma rotina do bot, nenhum cartão de criação ou de proposta no servidor e nenhum cartão na tela.
  const listed = (await (await page.context().request.get(`${ORIGIN}/api/routines`, { headers })).json()) as { routines: { name: string; bot: { id: string } }[] };
  expect(listed.routines.filter((routine) => routine.bot.id === botId)).toEqual([]);
  expect(await cardsOf(page, botId, headers, 'routine_proposal')).toEqual([]);
  await expect(page.getByRole('region', { name: 'Rotina criada pelo bot', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Proposta de rotina', exact: true })).toHaveCount(0);
  await expectNoA11yViolations(page);
  expect(problems).toEqual([]);
});

test('Editar no cartão abre o editor da rotina ligado ao cartão e, ao salvar, volta à conversa: o cartão vira "Editada pelo dono" e o aviso entra no fim (A13)', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  await ensureCredential(page, 'provider', FAKE_PROVIDER);
  await page.setViewportSize({ width: 1280, height: 800 });
  const botId = await createBot(page, 'Editor do cartão', '#38BDF8');
  const headers = await apiHeaders(page);
  const log = page.getByRole('log', { name: 'Conversa' });
  await page.goto(`/bots/${botId}`);

  await send(page, 'Crie [rotina:Para editar|07:30]');
  await expect(createdCard(page, 'Para editar')).toBeVisible();
  await waitIdle(page, botId, headers);
  const routineId = await routineIdByName(page, headers, botId, 'Para editar');
  await createdCard(page, 'Para editar').getByRole('button', { name: 'Editar', exact: true }).click();

  // O editor da rotina que já existe (nada de proposta no sessionStorage), ligado ao cartão pelo parâmetro.
  await expect(page).toHaveURL(new RegExp(`/rotinas/${routineId}\\?cartao=\\d+$`));
  await expect(page.getByRole('heading', { name: 'Para editar', level: 1 })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Nome', exact: true })).toHaveValue('Para editar');
  await expect(page.getByRole('textbox', { name: 'Instrução' })).toHaveValue('Executar Para editar');
  await expect(page.getByRole('combobox', { name: 'Bot', exact: true })).toHaveValue(botId);
  await expect(page.getByLabel('Horário 1')).toHaveValue('07:30');
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-editor-aberto-pelo-cartao-1280');

  // Cancelar não grava nada: a rotina segue como o bot a criou e o cartão continua "Ativa".
  await page.getByRole('link', { name: 'Cancelar' }).click();
  await expect(page).toHaveURL(/\/rotinas$/);
  await page.goto(`/bots/${botId}`);
  await expect(createdCard(page, 'Para editar').getByText('Ativa', { exact: true })).toBeVisible();
  expect(await routineNow(page, routineId, headers)).toMatchObject({ name: 'Para editar', summary: 'Todos os dias às 07:30' });

  // Salvar pelo editor: toast "Rotina editada", volta à conversa do bot e o cartão passa a "Editada pelo dono".
  await createdCard(page, 'Para editar').getByRole('button', { name: 'Editar', exact: true }).click();
  await page.getByRole('textbox', { name: 'Nome', exact: true }).fill('Para editar, versão do dono');
  await page.getByRole('textbox', { name: 'Instrução' }).fill('Instrução reescrita pelo dono.');
  await page.getByLabel('Horário 1').fill('08:15');
  await previewReady(page);
  await page.getByRole('button', { name: 'Salvar rotina' }).click();
  await expect(toast(page, 'Rotina editada')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/bots/${botId}$`));
  const edited = createdCard(page, 'Para editar');
  await expect(edited.getByText('Editada pelo dono', { exact: true })).toBeVisible();
  await expect(edited.getByRole('button', { name: 'Editar' })).toHaveCount(0);
  await expect(edited.getByRole('button', { name: 'Recusar' })).toHaveCount(0);
  await expect(edited.getByRole('link', { name: 'Ver rotina' })).toHaveAttribute('href', `/rotinas/${routineId}`);
  // O aviso entra no fim da conversa (o texto com o estado final vai ao modelo; a tela mostra a linha curta).
  const notice = noticeCard(page, 'Para editar, versão do dono', 'editada');
  await expect(notice).toContainText('Você editou a rotina.');
  await expect(log.getByRole('region').last()).toHaveAccessibleName('Rotina “Para editar, versão do dono” editada');
  expect(await routineNow(page, routineId, headers)).toMatchObject({ name: 'Para editar, versão do dono', instruction: 'Instrução reescrita pelo dono.', summary: 'Todos os dias às 08:15' });
  expect(await cardsOf(page, botId, headers, 'routine_edited')).toHaveLength(1);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-editada-pelo-dono-1280');

  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-editada-pelo-dono-375');
  expect(problems).toEqual([]);
});

test('Recusar pelo modal exclui a rotina e o cartão vira "Recusada" sem botões; o aviso entra no fim da conversa e uma segunda recusa não faz nada (A13)', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  await ensureCredential(page, 'provider', FAKE_PROVIDER);
  await page.setViewportSize({ width: 1280, height: 800 });
  const botId = await createBot(page, 'Recusador', '#FB7185');
  const headers = await apiHeaders(page);
  const log = page.getByRole('log', { name: 'Conversa' });
  await page.goto(`/bots/${botId}`);

  await send(page, 'Crie [rotina:Para recusar|08:00]');
  const card = createdCard(page, 'Para recusar');
  await expect(card).toBeVisible();
  await waitIdle(page, botId, headers);
  const routineId = await routineIdByName(page, headers, botId, 'Para recusar');

  // O modal diz o que acontece; Cancelar fecha sem desfazer nada e devolve o foco ao "Recusar" que o abriu.
  await card.getByRole('button', { name: 'Recusar', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Recusar a rotina “Para recusar”?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Ela será excluída. Execuções que já aconteceram continuam no histórico. O bot vai saber da recusa.');
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-recusar-modal-1280');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Recusar', exact: true })).toBeFocused();
  expect((await routineNow(page, routineId, headers))?.status).toBe('active');

  // 375 px: o modal cabe na tela; confirmar recusa de verdade (toast, cartão "Recusada" sem botões, rotina excluída).
  await page.setViewportSize({ width: 375, height: 812 });
  await card.getByRole('button', { name: 'Recusar', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-recusar-modal-375');
  await dialog.getByRole('button', { name: 'Recusar', exact: true }).click();
  await expect(toast(page, 'Rotina recusada')).toBeVisible();
  await expect(card.getByText('Recusada', { exact: true })).toBeVisible();
  await expect(card.getByRole('button')).toHaveCount(0);
  // O botão em que o foco estava saiu do DOM: o foco não se perde no body, vai para o contêiner de estado do próprio cartão (que é o que fica).
  await expect(stateOf(card)).toBeFocused();
  await expect(page.locator('body')).not.toBeFocused();
  await expect(card.getByRole('link', { name: 'Ver rotina' })).toHaveCount(0);
  await expect(card.getByRole('list', { name: 'Próximas execuções' })).toHaveCount(0);
  expect(await routineNow(page, routineId, headers), 'a rotina recusada foi excluída').toBeNull();
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-recusada-375');

  // O aviso entra no fim da conversa, como uma linha sem ações.
  await page.setViewportSize({ width: 1280, height: 800 });
  const notice = noticeCard(page, 'Para recusar', 'recusada');
  await expect(notice).toContainText('Você recusou a rotina criada pelo bot.');
  await expect(notice.getByRole('button')).toHaveCount(0);
  await expect(log.getByRole('region').last()).toHaveAccessibleName('Rotina “Para recusar” recusada');
  await attachShot(page, testInfo, 'rotina-recusada-aviso-1280');

  // Segunda recusa (outro aparelho, pela API): idempotente, sem efeito e sem aviso novo.
  const [proposal] = await cardsOf(page, botId, headers, 'routine_proposal');
  const again = await page.context().request.post(`${ORIGIN}/api/routines/cards/${proposal!.id}/refuse`, { headers });
  expect(again.status()).toBe(200);
  expect(await again.json()).toEqual({ routine: null });
  expect(await cardsOf(page, botId, headers, 'routine_refused')).toHaveLength(1);
  expect(problems).toEqual([]);
});

test('os avisos "recusada" e "editada" entram na conversa sem acender a bolinha de não lido, e uma resposta comum do bot a acende (A13)', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const problems = watchPage(page);
  await ensureCredential(page, 'provider', FAKE_PROVIDER);
  await page.setViewportSize({ width: 1280, height: 800 });
  const targetId = await createBot(page, 'Aviso alvo');
  const otherId = await createBot(page, 'Aviso outro');
  const targetName = uniqueBotName('Aviso alvo');
  const headers = await apiHeaders(page);
  await page.goto(`/bots/${targetId}`);
  await send(page, '[rotina:Aviso um|09:00]');
  await expect(createdCard(page, 'Aviso um')).toBeVisible();
  await waitIdle(page, targetId, headers);
  await send(page, '[rotina:Aviso dois|09:30]');
  await expect(createdCard(page, 'Aviso dois')).toBeVisible();
  await waitIdle(page, targetId, headers);
  const [first, second] = await cardsOf(page, targetId, headers, 'routine_proposal');
  const secondRoutineId = await routineIdByName(page, headers, targetId, 'Aviso dois');

  // Ponto de partida sem novidade, com o dono em OUTRA conversa: o que entrar no alvo agora só é lido se for novidade de verdade.
  await page.goto(`/bots/${otherId}`);
  const item = panel(page).locator(`a[title=${JSON.stringify(targetName)}]`);
  await expect(item).toBeVisible();
  const marked = await fetch(`http://127.0.0.1:${E2E_PORTS.control}/mark-all-read`, { method: 'POST' });
  expect(marked.status, 'marcar tudo como lido pelo controle da pilha').toBe(200);
  await page.reload();
  await expect(item).toBeVisible();
  await expect(item.getByTestId('unread-dot')).toHaveCount(0);

  // O dono recusa um cartão e edita o outro (como faria em outro aparelho): os dois avisos entram na conversa do alvo.
  expect((await page.context().request.post(`${ORIGIN}/api/routines/cards/${first!.id}/refuse`, { headers })).status()).toBe(200);
  const edit = await page.context().request.put(`${ORIGIN}/api/routines/${secondRoutineId}`, {
    headers,
    data: { name: 'Aviso dois', botId: targetId, instruction: 'Editada pelo dono.', ...DAILY, schedule: { type: 'daily', times: ['09:45'] }, cardId: second!.id },
  });
  expect(edit.status(), await edit.text()).toBe(200);
  expect(await cardsOf(page, targetId, headers, 'routine_refused')).toHaveLength(1);
  expect(await cardsOf(page, targetId, headers, 'routine_edited')).toHaveLength(1);
  await page.reload();
  await expect(item).toBeVisible();
  await expect(item.getByTestId('unread-dot'), 'recusar e editar não são novidade').toHaveCount(0);
  await attachShot(page, testInfo, 'rotina-avisos-sem-bolinha-1280');

  // Controle: uma resposta comum do bot, no mesmo lugar e pelo mesmo caminho, acende a bolinha (a prova acima não é vácua).
  const asked = await page.context().request.post(`${ORIGIN}/api/bots/${targetId}/messages`, { headers, data: { content: 'Qual é a sua função?' } });
  expect(asked.status(), 'enviar ao bot pela API').toBe(201);
  await waitIdle(page, targetId, headers);
  await page.reload();
  await expect(item.getByTestId('unread-dot')).toBeVisible();

  // Os dois avisos estão na conversa do alvo, depois dos cartões, que mostram o estado de cada um.
  await page.goto(`/bots/${targetId}`);
  await expect(noticeCard(page, 'Aviso um', 'recusada')).toBeVisible();
  await expect(noticeCard(page, 'Aviso dois', 'editada')).toBeVisible();
  await expect(createdCard(page, 'Aviso um').getByText('Recusada', { exact: true })).toBeVisible();
  await expect(createdCard(page, 'Aviso dois').getByText('Editada pelo dono', { exact: true })).toBeVisible();
  expect(problems).toEqual([]);
});

test('depois que a rotina muda por outro caminho o cartão passa a "mudou depois" sem Recusar nem Editar, e a recusa pelo clique mostra o erro da API (A15)', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const problems = watchPage(page);
  await ensureCredential(page, 'provider', FAKE_PROVIDER);
  await page.setViewportSize({ width: 1280, height: 800 });
  const botId = await createBot(page, 'Mudador', '#F472B6');
  const headers = await apiHeaders(page);
  await page.goto(`/bots/${botId}`);

  // Ao vivo: o dono altera a rotina por fora do cartão e o cartão que está na tela troca de estado, sem recarregar.
  await send(page, '[rotina:Alvo vivo|10:00]');
  const live = createdCard(page, 'Alvo vivo');
  await expect(live.getByRole('button', { name: 'Recusar', exact: true })).toBeVisible();
  await waitIdle(page, botId, headers);
  const liveId = await routineIdByName(page, headers, botId, 'Alvo vivo');
  const changed = await page.context().request.put(`${ORIGIN}/api/routines/${liveId}`, {
    headers,
    data: { name: 'Alvo vivo', botId, instruction: 'Reescrita pelo dono.', ...DAILY, schedule: { type: 'daily', times: ['10:00'] } },
  });
  expect(changed.status()).toBe(200);
  await expect(live.getByText(SUPERSEDED, { exact: true })).toBeVisible();
  await expect(live.getByRole('button', { name: 'Recusar' })).toHaveCount(0);
  await expect(live.getByRole('button', { name: 'Editar' })).toHaveCount(0);
  await expect(live.getByRole('link', { name: 'Ver rotina' })).toHaveAttribute('href', `/rotinas/${liveId}`);
  await expect(live.getByRole('list', { name: 'Próximas execuções' })).toHaveCount(0);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-mudou-depois-1280');
  // 375 px: o selo quebra linha sem truncar e nada estoura.
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalScroll(page);
  const badgeBox = (await live.getByText(SUPERSEDED, { exact: true }).boundingBox())!;
  const cardBox = (await live.boundingBox())!;
  expect(badgeBox.x + badgeBox.width, 'o selo fica dentro do cartão').toBeLessThanOrEqual(cardBox.x + cardBox.width);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-mudou-depois-375');
  // 320 px (o menor celular que o app atende): o selo longo e "Ver rotina" não cabem lado a lado e não podem estourar o cartão.
  await page.setViewportSize({ width: 320, height: 640 });
  await expectNoHorizontalScroll(page);
  const narrowBadge = (await live.getByText(SUPERSEDED, { exact: true }).boundingBox())!;
  const narrowLink = (await live.getByRole('link', { name: 'Ver rotina' }).boundingBox())!;
  const narrowCard = (await live.boundingBox())!;
  expect(narrowBadge.x + narrowBadge.width, 'o selo fica dentro do cartão em 320 px').toBeLessThanOrEqual(narrowCard.x + narrowCard.width);
  expect(narrowLink.x + narrowLink.width, '"Ver rotina" fica dentro do cartão em 320 px').toBeLessThanOrEqual(narrowCard.x + narrowCard.width);
  await attachShot(page, testInfo, 'rotina-mudou-depois-320');
  await page.setViewportSize({ width: 1280, height: 800 });

  // No clique: arquivar o bot PAUSA a rotina sem passar pelo caminho que marca os cartões, então o cartão ainda mostra "Recusar". O servidor recusa
  // com ROUTINE_CHANGED, a tela mostra a mensagem dele (a do envelope, não uma cópia) e o cartão passa a "mudou depois"; nada é desfeito.
  await send(page, '[rotina:Alvo clique|11:00]');
  const click = createdCard(page, 'Alvo clique');
  await expect(click.getByRole('button', { name: 'Recusar', exact: true })).toBeVisible();
  await waitIdle(page, botId, headers);
  const clickId = await routineIdByName(page, headers, botId, 'Alvo clique');
  expect((await page.context().request.post(`${ORIGIN}/api/bots/${botId}/archive`, { headers })).status(), 'arquivar o bot').toBe(200);
  await click.getByRole('button', { name: 'Recusar', exact: true }).click();
  await page.getByRole('dialog', { name: 'Recusar a rotina “Alvo clique”?' }).getByRole('button', { name: 'Recusar', exact: true }).click();
  await expect(page.getByText(ERROR_CODES.ROUTINE_CHANGED.message).first()).toBeVisible();
  await expect(click.getByText(SUPERSEDED, { exact: true })).toBeVisible();
  await expect(click.getByRole('button', { name: 'Recusar' })).toHaveCount(0);
  await expect(click.getByRole('button', { name: 'Editar' })).toHaveCount(0);
  // Também aqui os botões saíram do DOM: o foco vai para o contêiner de estado do cartão, não para o body.
  await expect(stateOf(click)).toBeFocused();
  await attachShot(page, testInfo, 'rotina-mudou-depois-erro-1280');
  expect((await routineNow(page, clickId, headers))?.status, 'a recusa recusada não desfez nada').toBe('paused');
  expect(await cardsOf(page, botId, headers, 'routine_refused')).toHaveLength(0);
  // O único erro de rede esperado é o 409 provocado de propósito.
  expect(problems.filter((problem) => !/^409 POST \/api\/routines\/cards\/\d+\/refuse$/.test(problem))).toEqual([]);
});

test('a proposta com instrução longa: o cartão mostra o começo recolhido, "Mostrar mais" revela o fim e nada estoura em 375 px (R12)', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  await ensureCredential(page, 'provider', FAKE_PROVIDER);
  await page.setViewportSize({ width: 1440, height: 900 });
  const botId = await createBot(page, 'Proponente Longo', '#FBBF24');
  await page.goto(`/bots/${botId}`);

  await send(page, 'Quero um relatório [rotina-longa:Relatório longo|08:00]');
  const card = createdCard(page, 'Relatório longo');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Instrução que a rotina executa');
  await expect(card).toContainText('Executar Relatório longo com atenção.');

  // Recolhida: a instrução ocupa até 6 linhas; "Mostrar mais" a expande até a última linha e "Mostrar menos" a recolhe.
  const instruction = card.getByText('Executar Relatório longo com atenção.').locator('xpath=ancestor::div[@id][1]');
  const more = card.getByRole('button', { name: 'Mostrar mais' });
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  const collapsed = (await instruction.boundingBox())?.height ?? 0;
  await attachShot(page, testInfo, 'rotina-proposta-longa-recolhida-1440');
  await more.click();
  await expect(card.getByRole('button', { name: 'Mostrar menos' })).toHaveAttribute('aria-expanded', 'true');
  await expect(card.getByText('FIM DA INSTRUÇÃO')).toBeVisible();
  const expanded = (await instruction.boundingBox())?.height ?? 0;
  expect(expanded, 'expandida é mais alta que recolhida').toBeGreaterThan(collapsed + 40);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-proposta-longa-expandida-1440');

  // 375 px: a linha de 120 caracteres sem espaços quebra dentro do cartão, sem rolagem horizontal.
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-proposta-longa-375');

  expect(problems).toEqual([]);
});

test('o bot vê as próprias rotinas e altera uma: o cartão traz o antes e o depois com a alteração já valendo, Recusar a desfaz e Editar abre o editor ligado ao cartão (A14)', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const problems = watchPage(page);
  await ensureCredential(page, 'provider', FAKE_PROVIDER);
  await page.setViewportSize({ width: 1280, height: 800 });
  const botId = await createBot(page, 'Gestor', '#A78BFA');
  const routineId = await createRoutine(page, botId, 'Boletim do gestor', { instruction: 'Instrução original do boletim.' });
  // UM login só, antes de a tela carregar: as chamadas à API do teste reaproveitam estes cabeçalhos (o token CSRF da tela é o desta sessão).
  const headers = await apiHeaders(page);
  const log = page.getByRole('log', { name: 'Conversa' });
  await page.goto(`/bots/${botId}`);

  // O bot vê as rotinas dele: a atividade aparece e a resposta cita a rotina (o modelo falso ecoa o resultado da ferramenta).
  await send(page, '[rotinas] o que eu tenho agendado?');
  await openWorkLine(log, log.getByRole('button', { name: 'Consultou as rotinas' }));
  await expect(log.getByRole('button', { name: 'Consultou as rotinas' })).toBeVisible();
  await expect(log.getByText('Boletim do gestor').first()).toBeVisible();
  await waitIdle(page, botId, headers);

  // Alterar: o cartão mostra o antes e o depois e a prévia das próximas execuções, e a alteração JÁ vale (nada a confirmar).
  await send(page, '[rotina-mudar:Boletim do gestor|09:30] mude o horário');
  const card = appliedCard(page, 'Boletim do gestor', 'alterada');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Instrução: antes');
  await expect(card).toContainText('Instrução original do boletim.');
  await expect(card).toContainText('Instrução: depois');
  await expect(card).toContainText('Nova instrução de Boletim do gestor');
  await expect(card).toContainText(/Agenda: Todos os dias às 07:00.*Todos os dias às 09:30/); // o antes, a seta e o depois (a seta é só visual; leitores de tela ouvem "para")
  await expect(card.getByRole('list', { name: 'Próximas execuções' }).getByRole('listitem')).toHaveCount(5);
  await expect(card.getByText('Aplicada', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Editar', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Recusar', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: /^Alterar a rotina/ })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Confirmar' })).toHaveCount(0);
  await waitIdle(page, botId, headers);
  expect(await routineNow(page, routineId, headers)).toMatchObject({ summary: 'Todos os dias às 09:30', instruction: 'Nova instrução de Boletim do gestor' });
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-alteracao-aplicada-1280');
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-alteracao-aplicada-375');
  await page.setViewportSize({ width: 1280, height: 800 });

  // Recusar volta a rotina ao que era: o modal diz isso, o cartão vira "Recusada" e o aviso entra no fim da conversa.
  await card.getByRole('button', { name: 'Recusar', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Recusar a alteração da rotina “Boletim do gestor”?' });
  await expect(dialog).toContainText('A rotina volta a ser como era antes desta alteração.');
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-alteracao-recusar-modal-1280');
  await dialog.getByRole('button', { name: 'Recusar', exact: true }).click();
  await expect(toast(page, 'Rotina recusada')).toBeVisible();
  await expect(card.getByText('Recusada', { exact: true })).toBeVisible();
  await expect(card.getByRole('button')).toHaveCount(0);
  expect(await routineNow(page, routineId, headers)).toMatchObject({ summary: 'Todos os dias às 07:00', instruction: 'Instrução original do boletim.' });
  await expect(noticeCard(page, 'Boletim do gestor', 'recusada')).toContainText('Você recusou a alteração do bot.');
  await expect(log.getByRole('region').last()).toHaveAccessibleName('Rotina “Boletim do gestor” recusada');
  await attachShot(page, testInfo, 'rotina-alteracao-recusada-1280');

  // Editar: de novo uma alteração aplicada; o editor abre ligado ao cartão e salvar volta à conversa com o cartão "Editada pelo dono".
  await send(page, '[rotina-mudar:Boletim do gestor|11:00] mude de novo');
  await expect(appliedCard(page, 'Boletim do gestor', 'alterada')).toHaveCount(2);
  const second = appliedCard(page, 'Boletim do gestor', 'alterada').last();
  await waitIdle(page, botId, headers);
  await second.getByRole('button', { name: 'Editar', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/rotinas/${routineId}\\?cartao=\\d+$`));
  await expect(page.getByRole('textbox', { name: 'Instrução' })).toHaveValue('Nova instrução de Boletim do gestor');
  await page.getByRole('textbox', { name: 'Instrução' }).fill('Instrução final do dono.');
  await page.getByRole('button', { name: 'Salvar rotina' }).click();
  await expect(toast(page, 'Rotina editada')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/bots/${botId}$`));
  await expect(appliedCard(page, 'Boletim do gestor', 'alterada').last().getByText('Editada pelo dono', { exact: true })).toBeVisible();
  await expect(noticeCard(page, 'Boletim do gestor', 'editada')).toContainText('Você editou a rotina.');
  expect(await routineNow(page, routineId, headers)).toMatchObject({ summary: 'Todos os dias às 11:00', instruction: 'Instrução final do dono.' });
  await attachShot(page, testInfo, 'rotina-alteracao-editada-1280');
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-alteracao-editada-375');
  expect(problems).toEqual([]);
});

test('pausar vale na hora e Recusar a desfaz; excluir vale na hora, sem Editar, e "Recusar e restaurar" traz a rotina de volta com o mesmo histórico (A14)', async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const problems = watchPage(page);
  await ensureCredential(page, 'provider', FAKE_PROVIDER);
  await page.setViewportSize({ width: 1280, height: 800 });
  const botId = await createBot(page, 'Pausador', '#34D399');
  const routineId = await createRoutine(page, botId, 'Boletim de pausa', { instruction: 'Instrução do boletim de pausa.' });
  const headers = await apiHeaders(page);
  // O histórico como o dono o vê: horários, estado, origem e cartão de cada execução. O `id` da linha é um número interno que a restauração renumera, e não faz parte do que se vê.
  const historyOf = async () =>
    ((await (await page.context().request.get(`${ORIGIN}/api/routines/${routineId}/history`, { headers })).json()) as { items: { id: string; scheduledFor: string; startedAt: string | null; state: string; manual: boolean; messageId: string | null }[] }).items.map(({ id: _id, ...visible }) => visible);

  // Uma execução concluída para a rotina ter histórico: é ele que a exclusão recusada tem de trazer de volta.
  expect((await page.context().request.post(`${ORIGIN}/api/routines/${routineId}/run`, { headers })).status(), 'executar a rotina agora').toBe(202);
  await expect.poll(async () => (await historyOf()).map((item) => `${item.state}:${item.manual}`), { timeout: 30_000 }).toEqual(['completed:true']);
  await waitIdle(page, botId, headers);
  const historyBefore = await historyOf();
  const before = await routineNow(page, routineId, headers);
  await page.goto(`/bots/${botId}`);

  // Pausar: já vale; o cartão aceita Editar e Recusar; Recusar reativa a rotina.
  await send(page, '[rotina-pausar:Boletim de pausa] pause');
  const paused = appliedCard(page, 'Boletim de pausa', 'pausada');
  await expect(paused).toContainText('A rotina foi pausada');
  await expect(paused.getByText('Aplicada', { exact: true })).toBeVisible();
  await expect(paused.getByRole('button', { name: 'Editar', exact: true })).toBeVisible();
  expect((await routineNow(page, routineId, headers))?.status).toBe('paused');
  await waitIdle(page, botId, headers);
  await paused.getByRole('button', { name: 'Recusar', exact: true }).click();
  const pauseDialog = page.getByRole('dialog', { name: 'Recusar a alteração da rotina “Boletim de pausa”?' });
  await expect(pauseDialog).toContainText('A rotina volta a ser como era antes desta alteração.');
  await pauseDialog.getByRole('button', { name: 'Recusar', exact: true }).click();
  await expect(paused.getByText('Recusada', { exact: true })).toBeVisible();
  await expect(stateOf(paused)).toBeFocused();
  expect((await routineNow(page, routineId, headers))?.status, 'recusar a pausa reativa a rotina').toBe('active');
  await attachShot(page, testInfo, 'rotina-pausa-recusada-1280');

  // Excluir: já vale, sem "Editar" (a rotina nem existe); o modal oferece "Recusar e restaurar".
  await send(page, '[rotina-excluir:Boletim de pausa] apague');
  const removed = appliedCard(page, 'Boletim de pausa', 'excluída');
  await expect(removed).toContainText('A rotina e o histórico dela foram apagados pelo bot.');
  await expect(removed.getByText('Aplicada', { exact: true })).toBeVisible();
  await expect(removed.getByRole('button', { name: 'Editar' })).toHaveCount(0);
  await expect(removed.getByRole('button', { name: 'Recusar', exact: true })).toBeVisible();
  await expect(removed.locator('[data-icon="CalendarX"]')).toHaveCount(1);
  expect(await routineNow(page, routineId, headers), 'a exclusão vale na hora').toBeNull();
  await waitIdle(page, botId, headers);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-exclusao-aplicada-1280');
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalScroll(page);
  await attachShot(page, testInfo, 'rotina-exclusao-aplicada-375');
  await page.setViewportSize({ width: 1280, height: 800 });
  await removed.getByRole('button', { name: 'Recusar', exact: true }).click();
  const removeDialog = page.getByRole('dialog', { name: 'Recusar a exclusão da rotina “Boletim de pausa”?' });
  await expect(removeDialog).toContainText('A rotina volta com a mesma configuração e o mesmo histórico.');
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-exclusao-recusar-modal-1280');
  await removeDialog.getByRole('button', { name: 'Recusar e restaurar' }).click();
  await expect(toast(page, 'Rotina recusada')).toBeVisible();
  await expect(removed.getByText('Recusada', { exact: true })).toBeVisible();
  await expect(removed.getByRole('button')).toHaveCount(0);
  await expect(stateOf(removed)).toBeFocused();

  // A rotina voltou com o mesmo id, a mesma configuração e o mesmo histórico.
  expect(await routineNow(page, routineId, headers)).toMatchObject({ id: routineId, name: 'Boletim de pausa', instruction: 'Instrução do boletim de pausa.', status: 'active', runCount: before!.runCount });
  expect(await historyOf()).toEqual(historyBefore);
  await expect(noticeCard(page, 'Boletim de pausa', 'recusada')).toHaveCount(2);
  await attachShot(page, testInfo, 'rotina-exclusao-recusada-1280');
  expect(problems).toEqual([]);
});

test('a proposta ANTIGA pendente continua com Confirmar e a alteração antiga com Confirmar ou "Desatualizada": cartões do fluxo antigo, desenhados a partir de uma conversa real com o estado trocado (A15)', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const problems = watchPage(page);
  await ensureCredential(page, 'provider', FAKE_PROVIDER);
  await page.setViewportSize({ width: 1280, height: 800 });
  const botId = await createBot(page, 'Antigo', '#FBBF24');
  await createRoutine(page, botId, 'Rotina do antigo');
  const headers = await apiHeaders(page);
  await page.goto(`/bots/${botId}`);
  await send(page, '[rotina:Proposta antiga|06:30]');
  await expect(createdCard(page, 'Proposta antiga')).toBeVisible();
  await waitIdle(page, botId, headers);
  await send(page, '[rotina-mudar:Rotina do antigo|08:30] mude');
  await expect(appliedCard(page, 'Rotina do antigo', 'alterada')).toBeVisible();
  await waitIdle(page, botId, headers);

  // Só o desenho: a leitura da conversa volta com os dois cartões no estado antigo (`showLegacyCards`). Os cliques deles estão no teste seguinte.
  const stale = new Set<string>();
  await showLegacyCards(page, stale);
  await page.reload();

  const proposal = page.getByRole('region', { name: 'Proposta de rotina', exact: true });
  await expect(proposal).toContainText('Proposta antiga');
  await expect(proposal).toContainText('Instrução que a rotina vai executar');
  await expect(proposal.getByRole('button', { name: 'Confirmar' })).toBeVisible();
  await expect(proposal.getByRole('button', { name: 'Editar', exact: true })).toBeVisible();
  await expect(proposal.getByRole('button', { name: 'Recusar' })).toHaveCount(0);
  await expect(proposal.getByText('Ativa', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Rotina criada pelo bot', exact: true })).toHaveCount(0);
  const change = page.getByRole('region', { name: 'Alterar a rotina “Rotina do antigo”', exact: true });
  await expect(change).toContainText('Instrução: antes');
  await expect(change.getByRole('button', { name: 'Confirmar' })).toBeVisible();
  await expect(change.getByRole('button', { name: 'Recusar' })).toHaveCount(0);
  await expect(change.getByText('Aplicada', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: /pelo bot$/ })).toHaveCount(0);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-proposta-antiga-pendente-1280');

  // A alteração antiga que ficou para trás: selo "Desatualizada", o aviso de que nada foi aplicado e nenhuma ação.
  stale.add('Rotina do antigo');
  await page.reload();
  await expect(change.getByText('Desatualizada', { exact: true })).toBeVisible();
  await expect(change).toContainText('A rotina mudou depois desta proposta, então nada foi aplicado.');
  await expect(change.getByRole('button')).toHaveCount(0);
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'rotina-alteracao-antiga-desatualizada-375');
  expect(problems).toEqual([]);
});

test('os cliques dos cartões ANTIGOS: Editar abre o editor preenchido, Confirmar cria a rotina e aplica a alteração, e o 409 ROUTINE_CHANGED mostra o erro da API e leva a "Desatualizada" (A15)', async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const problems = watchPage(page);
  await ensureCredential(page, 'provider', FAKE_PROVIDER);
  await page.setViewportSize({ width: 1280, height: 800 });
  const botId = await createBot(page, 'Antigo clique', '#F59E0B');
  const confirmId = await createRoutine(page, botId, 'Rotina antiga confirmada');
  await createRoutine(page, botId, 'Rotina antiga desatualizada');
  const headers = await apiHeaders(page);
  await captureStreams(page);
  await page.goto(`/bots/${botId}`);
  await send(page, '[rotina:Proposta antiga clique|06:30]');
  await expect(createdCard(page, 'Proposta antiga clique')).toBeVisible();
  await waitIdle(page, botId, headers);
  await send(page, '[rotina-mudar:Rotina antiga confirmada|08:30] mude');
  await expect(appliedCard(page, 'Rotina antiga confirmada', 'alterada')).toBeVisible();
  await waitIdle(page, botId, headers);
  await send(page, '[rotina-mudar:Rotina antiga desatualizada|09:30] mude');
  await expect(appliedCard(page, 'Rotina antiga desatualizada', 'alterada')).toBeVisible();
  await waitIdle(page, botId, headers);
  const [proposalCard] = await cardsOf(page, botId, headers, 'routine_proposal');
  const changeCards = await cardsOf(page, botId, headers, 'routine_change');
  expect(changeCards).toHaveLength(2);

  // Os três cartões voltam no estado antigo (pendentes). A pilha não aceita o clique de um cartão que já vale (o servidor responde NOT_FOUND), então a RESPOSTA do
  // POST de cada clique é simulada; o corpo e o destino da requisição que a tela manda saem de verdade da tela e são conferidos aqui. O efeito de cada resposta
  // no servidor é coberto nos testes do serviço e da API.
  const stale = new Set<string>();
  await showLegacyCards(page, stale);
  await page.reload();
  const proposal = page.getByRole('region', { name: 'Proposta de rotina', exact: true });
  await expect(proposal.getByRole('button', { name: 'Confirmar' })).toBeVisible();

  // Editar da proposta pendente: o editor abre preenchido com a proposta, no bot que a propôs (a rotina nova, não a existente), e Cancelar volta sem criar nada.
  await proposal.getByRole('button', { name: 'Editar', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/rotinas/nova\\?proposta=${proposalCard!.id}&bot=${botId}$`));
  await expect(page.getByRole('textbox', { name: 'Nome', exact: true })).toHaveValue('Proposta antiga clique');
  await expect(page.getByRole('textbox', { name: 'Instrução' })).toHaveValue('Executar Proposta antiga clique');
  await expect(page.getByRole('combobox', { name: 'Bot', exact: true })).toHaveValue(botId);
  await expect(page.getByLabel('Horário 1')).toHaveValue('06:30');
  await page.getByRole('link', { name: 'Cancelar' }).click();
  await expect(page).toHaveURL(/\/rotinas$/);
  await page.goto(`/bots/${botId}`);
  await expect(proposal.getByRole('button', { name: 'Confirmar' })).toBeVisible();

  // Confirmar da proposta pendente: a tela pede a criação da rotina ligada ao cartão (`proposalMessageId`); com a resposta, toast "Rotina criada", selo
  // "Confirmada" e o link para a rotina que a API devolveu.
  const created = await (await page.context().request.get(`${ORIGIN}/api/routines/${await routineIdByName(page, headers, botId, 'Proposta antiga clique')}`, { headers })).json();
  let createRequest: Record<string, unknown> | null = null;
  await page.route(/\/api\/routines$/, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    createRequest = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({ status: 201, json: created });
  });
  await proposal.getByRole('button', { name: 'Confirmar' }).click();
  await expect(toast(page, 'Rotina criada')).toBeVisible();
  await expect(proposal.getByText('Confirmada', { exact: true })).toBeVisible();
  await expect(proposal.getByRole('button', { name: 'Confirmar' })).toHaveCount(0);
  await expect(proposal.getByRole('button', { name: 'Editar' })).toHaveCount(0);
  await expect(proposal.getByRole('link', { name: 'Ver rotina' })).toHaveAttribute('href', `/rotinas/${(created as { id: string }).id}`);
  expect(createRequest).toMatchObject({ name: 'Proposta antiga clique', botId, proposalMessageId: proposalCard!.id });

  // Confirmar da alteração pendente: o POST vai ao cartão certo, sem corpo; com a resposta, toast "Rotina alterada", "Confirmada" e "Ver rotina".
  const [confirmedChange, staleChange] = changeCards as [(typeof changeCards)[number], (typeof changeCards)[number]];
  const confirmRoutine = await (await page.context().request.get(`${ORIGIN}/api/routines/${confirmId}`, { headers })).json();
  let confirmUrl: string | null = null;
  let confirmBody: string | null = null;
  await page.route(`**/api/routines/changes/${confirmedChange.id}/confirm`, (route) => {
    confirmUrl = new URL(route.request().url()).pathname;
    confirmBody = route.request().postData();
    return route.fulfill({ status: 200, json: { routine: confirmRoutine } });
  });
  const toConfirm = page.getByRole('region', { name: 'Alterar a rotina “Rotina antiga confirmada”', exact: true });
  await expect(toConfirm.getByRole('button', { name: 'Confirmar' })).toBeVisible();
  await toConfirm.getByRole('button', { name: 'Confirmar' }).click();
  await expect(toast(page, 'Rotina alterada')).toBeVisible();
  await expect(toConfirm.getByText('Confirmada', { exact: true })).toBeVisible();
  await expect(toConfirm.getByRole('button', { name: 'Confirmar' })).toHaveCount(0);
  await expect(toConfirm.getByRole('link', { name: 'Ver rotina' })).toHaveAttribute('href', `/rotinas/${confirmId}`);
  expect(confirmUrl).toBe(`/api/routines/changes/${confirmedChange.id}/confirm`);
  expect(confirmBody, 'o corpo não existe: o servidor aplica o que gravou no cartão').toBeNull();

  // O 409 ROUTINE_CHANGED de uma alteração antiga que ficou para trás: o toast traz a mensagem do envelope (não uma cópia da tela), o cartão ainda não é "Confirmada"
  // e, com o cartão que o servidor marcou como desatualizado chegando pelo SSE, passa a "Desatualizada" sem ações.
  const { status, message } = ERROR_CODES.ROUTINE_CHANGED;
  await page.route(`**/api/routines/changes/${staleChange.id}/confirm`, (route) => route.fulfill({ status, json: { code: 'ROUTINE_CHANGED', message } }));
  const toStale = page.getByRole('region', { name: 'Alterar a rotina “Rotina antiga desatualizada”', exact: true });
  await toStale.getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.getByText(message).first()).toBeVisible();
  await expect(toStale.getByText('Confirmada', { exact: true })).toHaveCount(0);
  await expect(toStale.getByRole('button', { name: 'Confirmar' })).toBeVisible();
  stale.add('Rotina antiga desatualizada');
  const items = ((await (await page.context().request.get(`${ORIGIN}/api/bots/${botId}/conversation`, { headers })).json()) as { items: SnapshotItem[] }).items;
  await deliverToStream(page, asLegacyItem(items.find((item) => item.id === staleChange.id)!, stale));
  await expect(toStale.getByText('Desatualizada', { exact: true })).toBeVisible();
  await expect(toStale).toContainText('A rotina mudou depois desta proposta, então nada foi aplicado.');
  await expect(toStale.getByRole('button')).toHaveCount(0);
  await attachShot(page, testInfo, 'rotina-alteracao-antiga-409-1280');
  // O único erro de rede esperado é o 409 provocado de propósito.
  expect(problems.filter((problem) => problem !== `409 POST /api/routines/changes/${staleChange.id}/confirm`)).toEqual([]);
});

test('o worker dispara sozinho uma rotina única no horário previsto, sem nenhuma tela aberta, e o resultado já está na conversa', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await ensureCredential(page, 'provider', FAKE_PROVIDER);
  const botId = await createBot(page, 'Madrugador');
  // O próximo minuto cheio com folga de um minuto para o cadastro (a agenda única precisa estar no futuro quando é salva).
  const at = new Date(Math.ceil((Date.now() + 70_000) / 60_000) * 60_000);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  const local = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  const headers = await apiHeaders(page);
  const created = await page.context().request.post(`${ORIGIN}/api/routines`, {
    headers,
    data: { name: 'Disparo único', botId, instruction: 'Registrar que acordei.', ...DAILY, schedule: { type: 'once', at: local } },
  });
  expect(created.status(), await created.text()).toBe(201);
  const routineId = ((await created.json()) as { id: string }).id;

  // Nenhuma tela: só a API é consultada até o worker disparar, executar e concluir.
  await expect
    .poll(
      async () => {
        const history = (await (await page.context().request.get(`${ORIGIN}/api/routines/${routineId}/history`, { headers })).json()) as { items: { state: string; manual: boolean }[] };
        return history.items.map((item) => `${item.state}:${item.manual}`);
      },
      { timeout: 200_000, intervals: [3_000] },
    )
    .toEqual(['completed:false']);
  const routine = (await (await page.context().request.get(`${ORIGIN}/api/routines/${routineId}`, { headers })).json()) as { status: string; runCount: number; nextRunAt: string | null };
  expect(routine).toMatchObject({ status: 'completed', runCount: 1, nextRunAt: null });

  // Quem abre o app depois encontra o resultado na conversa.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/bots/${botId}`);
  const card = page.getByRole('region', { name: /Rotina “Disparo único” concluída/ });
  await expect(card).toContainText('Previsto para');
  // O resultado do bot está na bolha logo abaixo do cartão (uma vez só), não dentro dele (T20).
  await expect(page.getByRole('log', { name: 'Conversa' }).getByText('Registrar que acordei.')).toHaveCount(1);
  await attachShot(page, testInfo, 'rotina-disparo-agendado-1440');
});

test('o seletor de bot do editor mostra a Faísca parada do bot escolhido (24 px) e o grupo do painel mostra a Faísca de 24 px do bot, em 1440 e 375 px', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  await ensureCredential(page, 'provider', FAKE_PROVIDER);
  const pillName = uniqueBotName('Seletor pílula');
  const pillId = await createBot(page, 'Seletor pílula', '#F472B6');
  await createBot(page, 'Seletor losango', '#4ADE80');
  const routineId = await createRoutine(page, pillId, 'Rotina do seletor');
  const headers = await apiHeaders(page);
  // Só o avatar do editor está dentro do formulário (o painel e o cabeçalho ficam fora dele).
  const editorFaisca = page.locator('form svg.faisca');
  const runningAnimations = () =>
    page.evaluate(() => [...document.querySelectorAll('svg.faisca')].flatMap((svg) => svg.getAnimations({ subtree: true })).filter((animation) => animation.playState === 'running').length);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/rotinas/nova');
    await expect(page.getByRole('heading', { name: 'Nova rotina', level: 1 })).toBeVisible();

    // Sem bot escolhido não há avatar; ao escolher, é a Faísca do bot, parada e ociosa, na cor dele, e a troca de bot troca a cor.
    await expect(editorFaisca).toHaveCount(0);
    const select = page.getByRole('combobox', { name: 'Bot', exact: true });
    await select.selectOption({ label: pillName });
    await expect(editorFaisca).toHaveCount(1);
    expect(await faiscaLook(editorFaisca)).toMatchObject({ state: 'idle', detail: 'small', still: true, decorative: true, size: [24, 24], body: '#F472B6' });
    await select.selectOption({ label: uniqueBotName('Seletor losango') });
    expect(await faiscaLook(editorFaisca)).toMatchObject({ state: 'idle', still: true, size: [24, 24], body: '#4ADE80' });
    await select.selectOption({ value: '' });
    await expect(editorFaisca).toHaveCount(0);
    await select.selectOption({ label: pillName });
    expect(await runningAnimations(), 'nada se anima no editor').toBe(0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await runningAnimations(), 'com movimento reduzido').toBe(0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    // O grupo do painel mostra a Faísca de 24 px do bot (parada, na cor dele) no lugar da inicial de 16 px; nenhum marcador de inicial sobra.
    const group = panel(page).getByRole('region', { name: `Rotinas de ${pillName}` });
    await expect(group).toBeVisible();
    await expect(group.locator('svg.faisca')).toHaveCount(1);
    expect(await faiscaLook(group.locator('svg.faisca'))).toMatchObject({ state: 'idle', detail: 'small', still: true, decorative: true, size: [24, 24], body: '#F472B6' });
    await expect(group.locator('h3 > span[aria-hidden="true"]')).toHaveCount(0);
    await expectNoA11yViolations(page);
    await expectNoHorizontalScroll(page);
    await attachShot(page, testInfo, 'rotina-editor-faisca-1440');

    // Ao editar, o avatar já abre com o bot da rotina.
    await page.goto(`/rotinas/${routineId}`);
    await expect(page.getByRole('heading', { name: 'Rotina do seletor', level: 1 })).toBeVisible();
    await expect(editorFaisca).toHaveCount(1);
    expect(await faiscaLook(editorFaisca)).toMatchObject({ state: 'idle', still: true, size: [24, 24], body: '#F472B6' });

    // 375 px: a Faísca não encolhe abaixo de 24 px, ao lado do campo, sem rolagem horizontal.
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await faiscaLook(editorFaisca)).toMatchObject({ size: [24, 24] });
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'rotina-editor-faisca-375');
    expect(problems).toEqual([]);
  } finally {
    await page.context().request.delete(`${ORIGIN}/api/routines/${routineId}`, { headers });
  }
});

test('D8: dia útil primeiro, quinto e último, fuso, mensal curto e proposta usam a mesma agenda', async ({ page }, info) => {
  await ensureCredential(page, 'provider', FAKE_PROVIDER);
  const botId = await createBot(page, 'Dias úteis');
  const headers = await apiHeaders(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/rotinas/nova?bot=${botId}`);
  await page.getByRole('combobox', { name: 'Bot', exact: true }).selectOption(botId);
  await page.getByLabel('Nome', { exact: true }).fill('Rotina mensal útil');
  await page.getByLabel('Instrução', { exact: true }).fill('Consultar e atualizar as tabelas autorizadas.');
  await kind(page, 'Mensal').click();
  await page.getByRole('radio', { name: 'Dia útil', exact: true }).check();
  await page.getByLabel('Fuso horário', { exact: true }).fill('Asia/Tokyo');
  /** Compara os instantes canônicos renderizados à API real, sem reproduzir calendário no teste. */
  const samePreview = async (position: number | 'last') => {
    const response = await page.request.post(`${ORIGIN}/api/routines/preview`, { headers, data: { schedule: { type: 'monthly_business_day', position, time: '09:00' }, timezone: 'Asia/Tokyo', startsAt: null, endsAt: null, maxRuns: null } });
    expect(response.status()).toBe(200);
    const expected = await response.json() as { occurrences: string[] };
    await expect.poll(() => preview(page).locator('time').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('datetime')))).toEqual(expected.occurrences);
    await expect(preview(page)).toContainText('Fuso: Asia/Tokyo');
    return expected.occurrences;
  };
  await samePreview(1);
  await expect(page.getByText('Segunda a sexta, incluindo feriados.', { exact: true })).toBeVisible();
  await expectNoA11yViolations(page); await expectNoHorizontalScroll(page);
  await attachShot(page, info, 'T8-D8-primeiro-1280');
  await page.getByLabel('Posição do dia útil').selectOption('5');
  const fifthRuns = await samePreview(5);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('group', { name: 'Modalidade mensal', exact: true }).evaluate((node) => node.scrollIntoView({ block: 'start' }));
  await expectNoHorizontalScroll(page); await expectNoA11yViolations(page);
  await attachShot(page, info, 'T8-D8-quinto-375');
  await preview(page).evaluate((node) => node.scrollIntoView({ block: 'start' })); await attachShot(page, info, 'T8-D8-previa-375');
  await page.getByLabel('Posição do dia útil').selectOption('last');
  const nextRuns = await samePreview('last');
  await page.setViewportSize({ width: 320, height: 640 });
  await page.getByLabel('Horário', { exact: true }).focus();
  await expect(page.getByLabel('Horário', { exact: true })).toBeFocused();
  await page.getByRole('group', { name: 'Modalidade mensal', exact: true }).evaluate((node) => node.scrollIntoView({ block: 'start' }));
  await expectNoHorizontalScroll(page); await expectNoA11yViolations(page);
  await attachShot(page, info, 'T8-D8-ultimo-320');
  await preview(page).evaluate((node) => node.scrollIntoView({ block: 'start' })); await attachShot(page, info, 'T8-D8-previa-320');
  await page.getByRole('radio', { name: 'Dia do mês', exact: true }).check();
  await page.getByRole('combobox', { name: 'Dia do mês', exact: true }).selectOption('31');
  await expect(page.getByText('Em meses sem esse dia, executa no último dia do mês.', { exact: true })).toBeVisible();
  await previewReady(page); await attachShot(page, info, 'T8-D8-mensal31-320');
  await page.getByRole('radio', { name: 'Dia útil', exact: true }).check();
  await samePreview('last');
  const saved = page.waitForResponse((response) => response.url().endsWith('/api/routines') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Salvar rotina' }).click();
  const routine = await (await saved).json() as { id: string; nextRunAt: string };
  expect(routine.nextRunAt).toBe(nextRuns[0]);
  await page.goto(`/rotinas/${routine.id}`);
  await expect(page.getByRole('radio', { name: 'Dia útil', exact: true })).toBeChecked();
  await expect(page.getByLabel('Posição do dia útil')).toHaveValue('last');
  await samePreview('last');
  const proposal = { name: 'Proposta no quinto dia útil', instruction: 'Consultar as tabelas autorizadas.', schedule: { type: 'monthly_business_day', position: 5, time: '09:00' }, timezone: 'Asia/Tokyo', startsAt: null, endsAt: null, maxRuns: null };
  expect((await page.request.post(`${ORIGIN}/api/bots/${botId}/messages`, { headers, data: { content: tableMarker('propose_routine', proposal) } })).status()).toBe(201);
  await page.goto(`/bots/${botId}`);
  const card = createdCard(page, proposal.name);
  await expect(card.getByRole('button', { name: 'Editar', exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText('Asia/Tokyo');
  await expect(card).toContainText('No 5º dia útil do mês às 09:00');
  await expect(card.locator('time')).toHaveCount(5);
  expect(await card.locator('time').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('datetime')))).toEqual(fifthRuns);
  await card.evaluate((node) => node.scrollIntoView({ block: 'start' }));
  await expectNoHorizontalScroll(page); await attachShot(page, info, 'T8-D8-proposta-320');
  await page.setViewportSize({ width: 375, height: 812 }); await card.evaluate((node) => node.scrollIntoView({ block: 'start' })); await expectNoHorizontalScroll(page); await attachShot(page, info, 'T8-D8-proposta-375');
  await page.setViewportSize({ width: 1280, height: 800 }); await card.evaluate((node) => node.scrollIntoView({ block: 'start' })); await expectNoHorizontalScroll(page); await attachShot(page, info, 'T8-D8-proposta-1280');
  await card.getByRole('button', { name: 'Editar', exact: true }).click();
  await expect(page.getByLabel('Posição do dia útil')).toHaveValue('5');
  await expect(page.getByRole('radio', { name: 'Dia útil', exact: true })).toBeChecked();
  await samePreview(5);
  // A rotina da proposta já existe (o bot a criou ativa): "Editar" abre o editor dela ligado ao cartão e salvar é um PUT, não uma criação.
  await expect(page).toHaveURL(/\/rotinas\/[0-9a-f-]{36}\?cartao=\d+$/);
  const edited = page.waitForResponse((response) => /\/api\/routines\/[0-9a-f-]{36}$/.test(response.url()) && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Salvar rotina' }).click();
  expect((await (await edited).json()).schedule).toEqual(proposal.schedule);
  await expect(page).toHaveURL(new RegExp(`/bots/${botId}$`));
  await expect(createdCard(page, proposal.name)).toContainText('Editada pelo dono');
});

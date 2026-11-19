// E2E de Artefatos (phase 14, passo 8; ART-01, DOC-01 a DOC-04, UI-04; A1 a A8, A11, A15, A17 a A20, A29 a A31, A35) no navegador real, contra a pilha de produção (Postgres, API, worker, Next e proxy) com o
// OpenCode Go e o Composio FALSOS. Os bots escrevem pelo worker real: o marcador `tableMarker(<ferramenta>, <argumentos>)` do provedor falso faz o modelo chamar exatamente aquela ferramenta
// (`doc_create`, `doc_append`, `table_write`) uma vez, e a atividade, o `artifacts` do dado dela e o cartão da conversa nascem do código de produção. O dono escreve pela tela e pela API do dono.
//
// O QUE ESTE ARQUIVO PROVA, POR TESTE
//   1. Lista (A1, A29): tipo, bots e título nos dois tipos; filtros por tipo, por bot (com "Sem bot") e a busca (sem caixa e sem acento); vazio de filtro; "Compartilhar" por item; "Novo doc" e "Nova tabela"
//      (esta pede o bot) com os limites de título do A8.
//   2. Vazio (A2): a frase que explica o que são artefatos. O banco da pilha é um só e guarda as tabelas de todos os specs, então o vazio global vem de uma resposta simulada das duas leituras de artefatos da
//      lista, tabelas e docs (`page.route`; os bots ficam reais), no mesmo molde dos vazios de `home.spec.ts`; a tela é a de produção.
//   3. Navegação (A3, A31): sem "Tabelas do bot", sem "Tabelas" no menu e em Configurações; "Artefatos" pelo cabeçalho, pelo menu e por Configurações (o Início não tem mais o atalho, phase 18); a barra do celular segue com quatro abas; o
//      "Voltar" leva ao pai fixo; as duas listas antigas respondem 308 com a query string e as páginas próprias das tabelas continuam, com "Voltar" para Artefatos.
//   4. Doc (A8, A17 a A20): leitura que não interpreta HTML nem imagem; o editor visual com cada elemento GFM; "Ver Markdown" sem digitar que não é alteração; Salvar sem alteração que não chama a API;
//      edição pelo texto cru; limites de título e de texto com a mensagem e nada gravado; "Baixar .md" igual ao gravado; guarda "Descartar alterações?".
//   5. Conflito e histórico (A11, A15): o bot grava a versão seguinte enquanto o dono edita; o texto do dono continua na tela e a versão do bot continua gravada; restaurar cria versão nova.
//   6. Conversa e painel (A4 a A7, A30): um cartão por artefato por resposta (e dois cartões numa resposta que cria o doc e altera a tabela duas vezes), sem cartão de sistema nem aviso a mais; o painel ao
//      lado no desktop (conversa utilizável, "Fechar painel", Voltar do navegador, link direto), a tela cheia em 375 px ("Voltar" à mesma conversa), a tabela embutida e "Abrir em tela inteira".
//   A30: lista, vazio, cartão, painel com doc em leitura, painel com doc em edição, painel com tabela e aviso de conflito, cada um em 1280 e 375 px, com axe e sem rolagem horizontal (`proveScreen`).
//   7. Aprovação da exclusão de doc (A35, decisão 23): o bot pede `doc_delete` de um doc "Plano" com acesso, o worker real pausa na aprovação, e o título "Plano" aparece ao lado da ação no cartão da conversa
//      (pendente e respondido) e na linha abaixo da ação em "Aguardando você", em Aprovações (decisão do dono, 29/10/2026); o cartão de exclusão de registros de tabela segue com o nome da tabela. A30 nessas telas, em 1280 e 375 px.
//
// UMA RESPOSTA COM TRÊS CHAMADAS (A4). O provedor falso faz uma chamada por mensagem, então a resposta "cria o doc e altera a tabela duas vezes" são três respostas reais (três execuções). O teste prova
// as três reais (um cartão por artefato em cada) e, para o cartão ÚNICO por artefato por resposta, relê a conversa com as três atividades sob a MESMA execução (`page.route` reescreve só o `runId`
// das atividades que já trazem `artifacts`, no snapshot): a tela agrupa o que o worker gravou, e o agrupamento em si é provado em `thread.test.tsx`.
//
// Estado global: a lista de Artefatos mostra TODAS as tabelas e docs do banco único, então cada teste cria bots e artefatos próprios (`uniqueBotName`) e conta pelo filtro de bot, nunca pelo total. O arquivo é
// serial e roda no projeto `chromium-tables`, junto de `tables.spec.ts`, antes do Início e do TOTP.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { DataTable, Doc, DocSummary, DocVersionList, TableColumnInput } from '@aion/shared';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { tableMarker } from '../../../packages/core/src/testing/fake-upstreams';
import { E2E_PORTS } from '../../../tests/support/e2e-env';
import { ORIGIN, apiHeaders, attachShot, backLink, contentOf, ensureCredential, expect, expectNoA11yViolations, expectNoHorizontalScroll, tabBarOf, test, uniqueBotName, watchPage } from './support/fixtures';

test.describe.configure({ mode: 'serial' });

const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 375, height: 812 };
const CONTROL = `http://127.0.0.1:${E2E_PORTS.control}`;
const FAKE_PROVIDER = 'valid-e2e-artifacts-1111';

type Headers = Record<string, string>;
interface Bot {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Fixtures: bots, tabelas e docs pela API do dono; escritas do bot pelo worker real
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Cabeçalhos da API do dono, com o provedor falso conectado. Devem ser pedidos UMA vez, ANTES de abrir tela (E22): outro login invalidaria o CSRF da tela aberta. */
async function start(page: Page): Promise<Headers> {
  await ensureCredential(page, 'provider', FAKE_PROVIDER);
  return apiHeaders(page);
}

/** Título exclusivo da repetição (`--repeat-each`), pelo mesmo sufixo dos nomes de bot (E29). */
const unique = (title: string): string => uniqueBotName(title);

async function createBot(page: Page, headers: Headers, name: string): Promise<Bot> {
  const unified = unique(name);
  const response = await page.request.post(`${ORIGIN}/api/bots`, { headers, data: { name: unified, color: '#60A5FA', instructions: '', model: 'opencode/glm-5.1', effort: null, stepLimit: 25 } });
  expect(response.status(), `criar o bot ${unified}`).toBe(201);
  return { id: ((await response.json()) as { id: string }).id, name: unified };
}

/** Tabela associada ao bot (TAB-01), criada pela mesma rota que a tela usa. */
async function createTable(page: Page, headers: Headers, botId: string, name: string, columns: TableColumnInput[] = [{ name: 'Título', type: 'text' }]): Promise<DataTable> {
  const response = await page.request.post(`${ORIGIN}/api/bots/${botId}/tables`, { headers, data: { name, description: '', operationId: randomUUID(), columns } });
  expect(response.status(), `criar a tabela ${name}`).toBe(201);
  return (await response.json()) as DataTable;
}

/** Registros de uma tabela pelo dono (a coluna é o primeiro campo, de texto). */
async function seedRecords(page: Page, headers: Headers, table: DataTable, titles: string[]): Promise<void> {
  const response = await page.request.post(`${ORIGIN}/api/tables/${table.id}/records`, {
    headers,
    data: { operationId: randomUUID(), expectedSchemaVersion: table.schemaVersion, creates: titles.map((title) => ({ values: { [table.columns[0]!.id]: title } })) },
  });
  expect(response.status(), 'semear registros').toBe(200);
}

/** Doc criado pelo dono pela API, com o texto e os bots escolhidos (nenhum é permitido). */
async function createDoc(page: Page, headers: Headers, title: string, content: string, botIds: string[]): Promise<DocSummary> {
  const response = await page.request.post(`${ORIGIN}/api/docs`, { headers, data: { title, content, botIds, operationId: randomUUID() } });
  expect(response.status(), `criar o doc ${title}`).toBe(201);
  return (await response.json()) as DocSummary;
}

const readDoc = async (page: Page, headers: Headers, id: string): Promise<Doc> => {
  const response = await page.request.get(`${ORIGIN}/api/docs/${id}`, { headers });
  expect(response.status(), 'ler o doc').toBe(200);
  return (await response.json()) as Doc;
};
const readVersions = async (page: Page, headers: Headers, id: string): Promise<DocVersionList['versions']> =>
  ((await (await page.request.get(`${ORIGIN}/api/docs/${id}/versions`, { headers })).json()) as DocVersionList).versions;

/** Os docs que o dono vê e têm o bot entre os que acessam (o doc que um bot criou nasce associado só a ele). */
async function docsOfBot(page: Page, headers: Headers, botId: string): Promise<DocSummary[]> {
  const response = await page.request.get(`${ORIGIN}/api/docs?botId=${botId}`, { headers });
  expect(response.status(), 'listar os docs do bot').toBe(200);
  return ((await response.json()) as { docs: DocSummary[] }).docs;
}

/** Envia uma mensagem ao bot pela API e espera a execução terminar com sucesso (lida em Atividades, que lista as execuções de todos os bots). Devolve o id da execução. */
async function runAsBot(page: Page, headers: Headers, botId: string, content: string): Promise<string> {
  const sent = await page.request.post(`${ORIGIN}/api/bots/${botId}/messages`, { headers, data: { content } });
  expect(sent.status(), 'enviar ao bot').toBe(201);
  const runId = ((await sent.json()) as { id: string }).id;
  await expect
    .poll(
      async () => {
        const listed = (await (await page.request.get(`${ORIGIN}/api/activities`, { headers })).json()) as { items: { runId: string; status: string }[] };
        return listed.items.find((item) => item.runId === runId)?.status;
      },
      { timeout: 30_000 },
    )
    .toBe('completed');
  return runId;
}

/** O bot cria o doc pela ferramenta `doc_create` e o doc volta como o dono o vê. */
async function botCreatesDoc(page: Page, headers: Headers, bot: Bot, title: string, content: string): Promise<DocSummary> {
  await runAsBot(page, headers, bot.id, tableMarker('doc_create', { title, content, operationId: randomUUID() }));
  const doc = (await docsOfBot(page, headers, bot.id)).find((item) => item.title === title);
  expect(doc, `o bot criou o doc ${title}`).toBeDefined();
  return doc!;
}

/** O bot acrescenta ao fim do doc pela ferramenta `doc_append`, sobre a versão esperada (a escrita do bot que o dono encontra no meio da edição, A11). */
async function botAppends(page: Page, headers: Headers, bot: Bot, doc: { id: string }, expectedVersion: number, text: string): Promise<void> {
  await runAsBot(page, headers, bot.id, tableMarker('doc_append', { docId: doc.id, expectedVersion, operationId: randomUUID(), text }));
}

/** O bot grava um registro novo pela ferramenta `table_write` (uma alteração da tabela). */
async function botWritesTable(page: Page, headers: Headers, bot: Bot, table: DataTable, title: string): Promise<string> {
  return runAsBot(
    page,
    headers,
    bot.id,
    tableMarker('table_write', { tableId: table.id, input: { operationId: randomUUID(), expectedSchemaVersion: table.schemaVersion, creates: [{ values: { [table.columns[0]!.id]: title } }] } }),
  );
}

// Seletores da conversa e do painel
const composer = (page: Page) => page.getByRole('textbox', { name: 'Mensagem' });
const conversationLog = (page: Page) => page.getByRole('log', { name: 'Conversa' });
const cardLists = (page: Page) => page.getByRole('list', { name: 'Artefatos desta resposta' });
const docCard = (page: Page, title: string) => page.getByRole('link', { name: new RegExp(`Abrir Doc\\s*${title}`) });
const tableCard = (page: Page, title: string) => page.getByRole('link', { name: new RegExp(`Abrir Tabela\\s*${title}`) });
const docPanel = (page: Page) => page.getByRole('complementary', { name: 'Painel do doc' });
const tablePanel = (page: Page) => page.getByRole('complementary', { name: 'Painel da tabela' });
/** O campo editável do editor visual: o papel `textbox` com o nome acessível do campo (`exact` o separa do "Texto do doc em Markdown"). */
const visualEditor = (scope: Page | Locator) => scope.getByRole('textbox', { name: 'Texto do doc', exact: true });

/** A30: a tela renderizada sem rolagem horizontal da página e sem violação do axe, com a captura em `AION_E2E_SHOTS_DIR` (prova visual). */
async function proveScreen(page: Page, info: TestInfo, name: string): Promise<void> {
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, info, `A30-${name}`);
}

/** A30 nas duas larguras da mesma tela (a tela continua aberta: a largura só muda o layout). Termina em 1280 px. */
async function proveBothWidths(page: Page, info: TestInfo, name: string): Promise<void> {
  await page.setViewportSize(MOBILE);
  await proveScreen(page, info, `${name}-375`);
  await page.setViewportSize(DESKTOP);
  await proveScreen(page, info, `${name}-1280`);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// 1. Lista (A1, A29)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

test('A1: a lista junta tabelas e docs com tipo, título e bots, e os filtros por tipo, por bot (com "Sem bot") e a busca reduzem a lista; Compartilhar, Novo doc e Nova tabela (A29)', async ({ page }, info) => {
  test.setTimeout(180_000);
  const problems = watchPage(page);
  const headers = await start(page);
  const alpha = await createBot(page, headers, 'Art Bot Alfa');
  const beta = await createBot(page, headers, 'Art Bot Beta');
  const alphaTable = await createTable(page, headers, alpha.id, unique('Art Tabela de Alfa'));
  const betaTable = await createTable(page, headers, beta.id, unique('Art Tabela de Beta'));
  const alphaDoc = await createDoc(page, headers, unique('Art Doc de Alfa'), '# Alfa', [alpha.id]);
  const looseDoc = await createDoc(page, headers, unique('Art Relatório sem bot'), '# Solto', []);
  const row = (title: string) => page.getByRole('listitem').filter({ has: page.getByRole('link', { name: title, exact: true }) });
  const link = (title: string) => page.getByRole('link', { name: title, exact: true });
  const kindGroup = page.getByRole('group', { name: 'Tipo de artefato' });
  const botFilter = page.getByRole('combobox', { name: 'Filtrar por bot', exact: true });
  const search = page.getByRole('searchbox', { name: 'Buscar pelo título' });

  await page.setViewportSize(DESKTOP);
  await page.goto('/artefatos');
  await expect(page.getByRole('heading', { level: 1, name: 'Artefatos' })).toBeVisible();
  // Os quatro, com tipo e bots (A1): a tabela e o doc de cada bot, e o doc sem bot diz "Sem bot".
  for (const title of [alphaTable.name, betaTable.name, alphaDoc.title, looseDoc.title]) await expect(link(title)).toBeVisible();
  await expect(row(alphaTable.name)).toContainText('Tabela');
  await expect(row(alphaTable.name)).toContainText(alpha.name);
  await expect(row(alphaDoc.title)).toContainText('Doc');
  await expect(row(alphaDoc.title)).toContainText(alpha.name);
  await expect(row(looseDoc.title)).toContainText('Sem bot');
  await expect(link(alphaTable.name)).toHaveAttribute('href', `/artefatos/tabelas/${alphaTable.id}`);
  await expect(link(alphaDoc.title)).toHaveAttribute('href', `/artefatos/docs/${alphaDoc.id}`);

  // Filtro por tipo: "Docs" tira as tabelas, "Tabelas" tira os docs, "Todos" devolve tudo.
  await kindGroup.getByRole('button', { name: 'Docs', exact: true }).click();
  await expect(kindGroup.getByRole('button', { name: 'Docs', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(link(alphaDoc.title)).toBeVisible();
  await expect(link(looseDoc.title)).toBeVisible();
  await expect(link(alphaTable.name)).toHaveCount(0);
  await expect(link(betaTable.name)).toHaveCount(0);
  await kindGroup.getByRole('button', { name: 'Tabelas', exact: true }).click();
  await expect(link(alphaTable.name)).toBeVisible();
  await expect(link(alphaDoc.title)).toHaveCount(0);
  await kindGroup.getByRole('button', { name: 'Todos', exact: true }).click();
  await expect(link(alphaDoc.title)).toBeVisible();

  // Filtro por bot: só os do Alfa; "Sem bot" só o doc solto; os dois filtros juntos (bot e tipo) cruzam.
  await botFilter.selectOption({ label: alpha.name });
  await expect(link(alphaTable.name)).toBeVisible();
  await expect(link(alphaDoc.title)).toBeVisible();
  await expect(link(betaTable.name)).toHaveCount(0);
  await expect(link(looseDoc.title)).toHaveCount(0);
  await kindGroup.getByRole('button', { name: 'Docs', exact: true }).click();
  await expect(link(alphaDoc.title)).toBeVisible();
  await expect(link(alphaTable.name)).toHaveCount(0);
  await kindGroup.getByRole('button', { name: 'Todos', exact: true }).click();
  await botFilter.selectOption({ label: 'Sem bot' });
  await expect(link(looseDoc.title)).toBeVisible();
  await expect(link(alphaDoc.title)).toHaveCount(0);
  await expect(link(alphaTable.name)).toHaveCount(0);

  // Busca pelo título, sem caixa e sem acento ("relatorio" acha "Relatório"), e o vazio do filtro com "Limpar filtros".
  await botFilter.selectOption('all');
  await search.fill('RELATORIO sem');
  await expect(link(looseDoc.title)).toBeVisible();
  await expect(link(alphaDoc.title)).toHaveCount(0);
  await search.fill('título que nenhum artefato tem');
  await expect(page.getByText('Nenhum artefato com estes filtros.')).toBeVisible();
  await page.getByRole('button', { name: 'Limpar filtros' }).click();
  await expect(search).toHaveValue('');
  await expect(link(alphaDoc.title)).toBeVisible();

  // A30: a lista (com o recorte do Alfa, para a captura mostrar linhas de verdade), em 1280 e 375 px.
  await botFilter.selectOption({ label: alpha.name });
  await expect(link(alphaTable.name)).toBeVisible();
  await proveBothWidths(page, info, 'lista');

  // "Compartilhar" por item (A29), agora também para docs: acrescentar o Beta ao doc do Alfa muda o doc e a linha.
  await botFilter.selectOption('all');
  await page.getByRole('button', { name: `Compartilhar ${alphaDoc.title}`, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: `Compartilhar · ${alphaDoc.title}`, exact: true });
  await expect(drawer.getByRole('checkbox', { name: alpha.name, exact: true })).toBeChecked();
  await drawer.getByRole('checkbox', { name: beta.name, exact: true }).check();
  await drawer.getByRole('button', { name: 'Salvar compartilhamento' }).click();
  await expect(drawer).toHaveCount(0);
  expect((await readDoc(page, headers, alphaDoc.id)).botIds.sort()).toEqual([alpha.id, beta.id].sort());
  await expect(row(alphaDoc.title)).toContainText(beta.name);
  // E a tabela, pelo mesmo botão (A29: o compartilhamento de tabela não se perdeu na lista única).
  await page.getByRole('button', { name: `Compartilhar ${alphaTable.name}`, exact: true }).click();
  await expect(page.getByRole('dialog', { name: `Compartilhar · ${alphaTable.name}`, exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  // "Novo doc": o título vazio e o de 121 caracteres são recusados com a mensagem e nada é criado; o de 120 cria e abre a página do doc (A8).
  const docsBefore = (await docsOfBot(page, headers, alpha.id)).length;
  await page.getByRole('button', { name: 'Novo doc', exact: true }).click();
  const newDoc = page.getByRole('dialog', { name: 'Novo doc', exact: true });
  await newDoc.getByRole('button', { name: 'Criar doc' }).click();
  await expect(newDoc.getByRole('alert')).toHaveText('Dê um título ao doc.');
  await newDoc.getByLabel('Título', { exact: true }).fill('x'.repeat(121));
  await newDoc.getByRole('button', { name: 'Criar doc' }).click();
  await expect(newDoc.getByRole('alert')).toHaveText('O título passou de 120 caracteres.');
  expect((await docsOfBot(page, headers, alpha.id)).length, 'nada foi criado pelas recusas').toBe(docsBefore);
  const longTitle = unique('Art Doc com título no limite ').padEnd(120, 'x');
  expect(longTitle).toHaveLength(120);
  await newDoc.getByLabel('Título', { exact: true }).fill(longTitle);
  await newDoc.getByRole('checkbox', { name: alpha.name, exact: true }).check();
  await newDoc.getByRole('button', { name: 'Criar doc' }).click();
  await expect(page).toHaveURL(/\/artefatos\/docs\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: longTitle })).toBeVisible();
  await expect(page.getByText('Este doc ainda está vazio.')).toBeVisible();
  const created = (await docsOfBot(page, headers, alpha.id)).find((item) => item.title === longTitle);
  expect(created?.version).toBe(1);
  expect(created?.botIds).toEqual([alpha.id]);

  // "Nova tabela" pede o bot (a lista única não é por bot): sem escolher, "Criar tabela" não habilita; com o bot, cria e abre a página da tabela.
  await page.goto('/artefatos');
  await page.getByRole('button', { name: 'Nova tabela', exact: true }).click();
  const newTable = page.getByRole('dialog', { name: 'Nova tabela', exact: true });
  const tableName = unique('Art Tabela criada na área');
  await newTable.getByLabel('Nome', { exact: true }).fill(tableName);
  await expect(newTable.getByRole('button', { name: 'Criar tabela' })).toBeDisabled();
  await newTable.getByLabel('Bot', { exact: true }).selectOption(beta.id);
  await newTable.getByRole('button', { name: 'Criar tabela' }).click();
  await expect(page).toHaveURL(/\/artefatos\/tabelas\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: tableName })).toBeVisible();
  expect(problems).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// 2. Estado vazio (A2)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

test('A2: sem nenhum artefato a área mostra a frase que explica o que são artefatos, em 1280 e 375 px', async ({ page }, info) => {
  await start(page);
  // O banco da pilha tem as tabelas de todos os specs: o "sem nenhum artefato" é a resposta das duas leituras de artefatos da lista (o catálogo de tabelas e os docs; os bots e o shell ficam reais), e a tela é a de produção.
  await page.route('**/api/tables?*', (route) => route.fulfill({ json: { tables: [], nextCursor: null } }));
  await page.route('**/api/docs', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { docs: [] } }) : route.fallback()));
  await page.setViewportSize(DESKTOP);
  await page.goto('/artefatos');
  await expect(page.getByText('Artefatos são as tabelas e os docs que os bots criam e mantêm para você.')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Artefatos' })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Tipo de artefato' }), 'sem artefato não há filtros').toHaveCount(0);
  await proveBothWidths(page, info, 'vazio');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// 3. Navegação e endereços antigos (A3, A31)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

test('A3: "Tabelas" saiu do cabeçalho, do menu e de Configurações; Artefatos entra por eles e por Configurações (o Início não tem mais o atalho), a barra do celular segue com quatro abas e o Voltar leva ao pai fixo', async ({ page }) => {
  const problems = watchPage(page);
  const headers = await start(page);
  const bot = await createBot(page, headers, 'Art Navegação');

  // Desktop: o ícone "Tabelas do bot" não existe mais; "Artefatos" leva à lista.
  await page.setViewportSize(DESKTOP);
  await page.goto(`/bots/${bot.id}`);
  await expect(page.getByRole('link', { name: 'Arquivos do bot', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Tabelas do bot' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Artefatos', exact: true })).toHaveAttribute('href', '/artefatos');

  // Celular: o menu "Mais ações do bot" tem Artefatos e não tem Tabelas; a barra inferior não existe na conversa.
  await page.setViewportSize(MOBILE);
  await page.goto(`/bots/${bot.id}`);
  await page.getByRole('button', { name: 'Mais ações do bot', exact: true }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Tabelas', exact: true })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: 'Artefatos', exact: true })).toHaveAttribute('href', '/artefatos');
  await menu.getByRole('menuitem', { name: 'Artefatos', exact: true }).click();
  await expect(page).toHaveURL(/\/artefatos$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Artefatos' })).toBeVisible();
  // Artefatos não é aba: no celular não há barra inferior ali, e o "Voltar" leva ao pai fixo, o Início, onde a barra segue com as quatro abas.
  await expect(tabBarOf(page)).toHaveCount(0);
  await expect(backLink(page)).toHaveAttribute('href', '/');
  await backLink(page).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(tabBarOf(page)).toBeVisible();
  expect(await tabBarOf(page).getByRole('link').evaluateAll((links) => links.map((item) => item.getAttribute('href')))).toEqual(['/', '/chats', '/rotinas', '/aprovacoes']);
  // Phase 18 (A19): o Início não tem mais o atalho de Artefatos; a lista segue pelo menu da conversa e por Configurações.
  await expect(contentOf(page).getByRole('link', { name: /^Artefatos/ })).toHaveCount(0);

  // Configurações → Atividade e arquivos: a entrada Tabelas não existe, a de Artefatos sim, e leva à lista.
  await page.setViewportSize(DESKTOP);
  await page.goto('/configuracoes/atividade-e-arquivos');
  await expect(page.getByRole('link', { name: /^Artefatos Consultar, compartilhar/ })).toHaveAttribute('href', '/artefatos');
  await expect(page.getByRole('link', { name: /^Tabelas/ })).toHaveCount(0);
  await page.getByRole('link', { name: /^Artefatos Consultar, compartilhar/ }).click();
  await expect(page).toHaveURL(/\/artefatos$/);
  expect(problems).toEqual([]);
});

test('A31: as listas antigas de tabelas respondem 308 para Artefatos com a query string, e o link de uma tabela abre a página própria, cujo Voltar leva a Artefatos', async ({ page }, info) => {
  test.setTimeout(120_000);
  const problems = watchPage(page);
  const headers = await start(page);
  const bot = await createBot(page, headers, 'Art Endereços');
  const table = await createTable(page, headers, bot.id, unique('Art Tabela endereçada'));
  await seedRecords(page, headers, table, ['Linha única']);

  // O redirecionamento é do servidor web (antes do proxy e sem sessão): 308 permanente, com `?x=1` preservado, para as duas listas antigas.
  for (const path of [`/bots/${bot.id}/tabelas?x=1`, '/configuracoes/tabelas?x=1']) {
    const response = await page.request.get(`${ORIGIN}${path}`, { maxRedirects: 0 });
    expect(response.status(), path).toBe(308);
    const location = new URL(response.headers().location!, ORIGIN);
    expect(location.pathname + location.search, path).toBe('/artefatos?x=1');
  }
  // No navegador, o mesmo link cai na lista de Artefatos.
  await page.setViewportSize(DESKTOP);
  await page.goto(`/bots/${bot.id}/tabelas?x=1`);
  await expect(page).toHaveURL(`${ORIGIN}/artefatos?x=1`);
  await expect(page.getByRole('heading', { level: 1, name: 'Artefatos' })).toBeVisible();
  await page.goto('/configuracoes/tabelas?x=1');
  await expect(page).toHaveURL(`${ORIGIN}/artefatos?x=1`);

  // O link salvo de UMA tabela continua valendo (as duas páginas próprias antigas e a canônica) e, no celular, o "Voltar" leva a Artefatos.
  for (const path of [`/bots/${bot.id}/tabelas/${table.id}`, `/configuracoes/tabelas/${table.id}`, `/artefatos/tabelas/${table.id}`]) {
    await page.setViewportSize(MOBILE);
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: table.name })).toBeVisible();
    await expect(page.getByRole('button', { name: /Linha única/ })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Voltar', exact: true }).last(), path).toHaveAttribute('href', '/artefatos');
  }
  await page.getByRole('link', { name: 'Voltar', exact: true }).last().click();
  await expect(page).toHaveURL(/\/artefatos$/);
  await attachShot(page, info, 'A31-voltar-para-artefatos-375');
  expect(problems).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// 4. O doc: leitura, editor, texto cru, limites e download (A8, A17 a A20)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Um doc com todo o conjunto GFM, escrito de propósito com marcadores que o editor reescreveria se reserializasse (`*` nas listas e `***` na linha divisória): o texto gravado só sobrevive
 * caractere por caractere à abertura sem alteração se o editor devolver o que recebeu (A17). Termina em quebra de linha.
 */
const GFM_DOC = [
  '# Plano de lançamento',
  '',
  'Texto com **negrito**, *itálico* e ~~tachado~~, e um [link](https://example.com/plano).',
  '',
  '## Etapas',
  '',
  '* Primeiro item',
  '* Segundo item',
  '',
  '1. Passo um',
  '2. Passo dois',
  '',
  '- [x] Tarefa feita',
  '- [ ] Tarefa aberta',
  '',
  '> Citação importante',
  '',
  '```js',
  'const x = 1;',
  '```',
  '',
  '| Coluna A | Coluna B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '***',
  '',
  'Fim.',
  '',
].join('\n');

/** Um doc hostil: HTML cru, imagem em Markdown (para uma URL que nunca resolve) e um link. Nada disso pode virar elemento nem pedido de rede (A19). */
const HOSTILE_DOC = [
  '# Documento não confiável',
  '',
  '<script>window.__xss = 1</script>',
  '',
  '<img src="http://aion-e2e-html.invalid/x.png" onerror="window.__xss = 2">',
  '',
  '![imagem hostil](http://aion-e2e-imagem.invalid/y.png)',
  '',
  '[link externo](https://example.com/seguro)',
  '',
].join('\n');

test('A19: o HTML e a imagem do texto do doc não são interpretados na leitura nem no editor, e o link abre com noopener', async ({ page }) => {
  const problems = watchPage(page);
  const headers = await start(page);
  const doc = await createDoc(page, headers, unique('Art Doc hostil'), HOSTILE_DOC, []);
  const requested: string[] = [];
  page.on('request', (request) => requested.push(request.url()));
  await page.setViewportSize(DESKTOP);
  await page.goto(`/artefatos/docs/${doc.id}`);
  const reading = page.getByRole('region', { name: 'Texto do doc' });
  await expect(reading.getByRole('heading', { level: 1, name: 'Documento não confiável' })).toBeVisible();
  // Leitura: nenhum elemento `script` nem `img` no texto, o HTML cru some e a imagem some (a sintaxe não vira nada); o link tem `noopener`.
  await expect(reading.locator('script, img')).toHaveCount(0);
  await expect(reading.getByText('window.__xss')).toHaveCount(0);
  const readLink = reading.getByRole('link', { name: 'link externo' });
  await expect(readLink).toHaveAttribute('href', 'https://example.com/seguro');
  await expect(readLink).toHaveAttribute('rel', /noopener/);
  await expect(readLink).toHaveAttribute('target', '_blank');

  // Editor visual: o HTML e a sintaxe da imagem aparecem como TEXTO (e voltam como estão), sem `script` nem `img`, e o link também leva `noopener`.
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  const editor = visualEditor(page);
  await expect(editor).toContainText('<script>window.__xss = 1</script>');
  await expect(editor).toContainText('![imagem hostil](http://aion-e2e-imagem.invalid/y.png)');
  // O ProseMirror põe um `<img>` SEM `src` depois de cada nó em linha atômico (detalhe interno do editor, sem pedido à rede); o que provaria o texto virando elemento é um `script` ou um `img` com `src`.
  await expect(editor.locator('script'), 'nenhum script do texto do doc').toHaveCount(0);
  await expect(editor.locator('img[src]')).toHaveCount(0);
  await expect(editor.getByRole('link', { name: 'link externo' })).toHaveAttribute('rel', /noopener/);
  // A ida e volta pelo texto cru devolve o texto gravado (HTML e imagem preservados como texto).
  await page.getByRole('button', { name: 'Ver Markdown', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Texto do doc em Markdown' })).toHaveValue(HOSTILE_DOC);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss), 'nenhum script do texto rodou').toBeUndefined();
  expect(requested.filter((url) => url.includes('.invalid')), 'nenhuma imagem foi pedida').toEqual([]);
  expect(problems).toEqual([]);
});

test('A17, A18, A20: o editor visual mostra cada elemento GFM, abrir e salvar sem mudar nada não grava nem chama a API, "Ver Markdown" sem digitar não é alteração, e o texto cru se edita e salva; Baixar .md traz o gravado', async ({ page }) => {
  test.setTimeout(180_000);
  const problems = watchPage(page);
  const headers = await start(page);
  const bot = await createBot(page, headers, 'Art Bot Doc');
  const doc = await createDoc(page, headers, unique('Art Doc GFM'), GFM_DOC, [bot.id]);
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/docs/') && request.method() !== 'GET') writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  await page.setViewportSize(DESKTOP);
  await page.goto(`/artefatos/docs/${doc.id}`);
  const reading = page.getByRole('region', { name: 'Texto do doc' });
  await expect(reading.getByRole('heading', { level: 1, name: 'Plano de lançamento' })).toBeVisible();

  // A20: "Baixar .md" entrega o texto gravado, caractere por caractere.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Baixar .md', exact: true }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.md$/);
  expect(await readFile((await download.path())!, 'utf8')).toBe(GFM_DOC);

  // A18: o editor visual mostra cada elemento do conjunto GFM já formatado.
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  const editor = visualEditor(page);
  await expect(editor.locator('h1')).toHaveText('Plano de lançamento');
  await expect(editor.locator('h2')).toHaveText('Etapas');
  await expect(editor.locator('strong')).toHaveText('negrito');
  await expect(editor.locator('em')).toHaveText('itálico');
  await expect(editor.locator('del, s')).toHaveText('tachado');
  await expect(editor.locator('ul > li').filter({ hasText: 'Primeiro item' })).toHaveCount(1);
  await expect(editor.locator('ol > li')).toHaveCount(2);
  await expect(editor.locator('li[data-item-type="task"]')).toHaveCount(2);
  await expect(editor.locator('li[data-item-type="task"][data-checked="true"]')).toHaveText('Tarefa feita');
  await expect(editor.locator('a[href="https://example.com/plano"]')).toHaveText('link');
  await expect(editor.locator('blockquote')).toContainText('Citação importante');
  await expect(editor.locator('pre')).toContainText('const x = 1;');
  await expect(editor.locator('table th')).toHaveText(['Coluna A', 'Coluna B']);
  await expect(editor.locator('table td')).toHaveText(['1', '2']);
  await expect(editor.locator('hr')).toHaveCount(1);

  // A17: sem alteração, Salvar não habilita e Cancelar não pergunta nada; "Ver Markdown" sem digitar mostra o texto gravado idêntico e também não é alteração.
  const save = page.getByRole('button', { name: 'Salvar', exact: true });
  await expect(save).toBeDisabled();
  await page.getByRole('button', { name: 'Ver Markdown', exact: true }).click();
  const raw = page.getByRole('textbox', { name: 'Texto do doc em Markdown' });
  await expect(raw).toHaveValue(GFM_DOC);
  await expect(save).toBeDisabled();
  await page.getByRole('button', { name: 'Ver Markdown', exact: true }).click();
  await expect(visualEditor(page)).toBeVisible();
  await expect(save).toBeDisabled();
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Descartar alterações?' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Editar', exact: true })).toBeVisible();
  expect(writes, 'abrir, alternar e sair sem alterar não chama a API').toEqual([]);
  const untouched = await readDoc(page, headers, doc.id);
  expect(untouched.content).toBe(GFM_DOC);
  expect(untouched.version, 'nenhuma versão nova').toBe(1);

  // A18: o texto cru se edita e se salva (uma versão nova, com o texto exato do campo).
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  await page.getByRole('button', { name: 'Ver Markdown', exact: true }).click();
  const edited = `${GFM_DOC}\nLinha escrita no texto cru.\n`;
  await raw.fill(edited);
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole('button', { name: 'Editar', exact: true })).toBeVisible();
  await expect(reading).toContainText('Linha escrita no texto cru.');
  const saved = await readDoc(page, headers, doc.id);
  expect(saved.content).toBe(edited);
  expect(saved.version).toBe(2);
  expect(saved.updatedBy).toBe('owner');
  expect(writes).toEqual([`PATCH /api/docs/${doc.id}`]);

  // Editar no visual também grava (o documento inteiro, serializado): digitar no fim cria a versão 3 com o texto novo.
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  await visualEditor(page).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' Escrito no editor visual.');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(reading).toContainText('Escrito no editor visual.');
  const visual = await readDoc(page, headers, doc.id);
  expect(visual.version).toBe(3);
  expect(visual.content).toContain('Escrito no editor visual.');
  expect(problems).toEqual([]);
});

test('A8: o título de 120 caracteres grava e o de 121 e o vazio são recusados com a mensagem; o texto de 100.000 caracteres grava e o de 100.001 é recusado, e nada é gravado nas recusas', async ({ page }) => {
  test.setTimeout(180_000);
  const problems = watchPage(page);
  const headers = await start(page);
  const doc = await createDoc(page, headers, unique('Art Doc limites'), 'texto inicial', []);
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/docs/') && request.method() !== 'GET') writes.push(request.method());
  });
  await page.setViewportSize(DESKTOP);
  await page.goto(`/artefatos/docs/${doc.id}`);
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  const title = page.getByRole('textbox', { name: 'Título do doc' });
  const save = page.getByRole('button', { name: 'Salvar', exact: true });

  // Título vazio e de 121 caracteres: a mensagem aparece e NADA é enviado.
  await title.fill('   ');
  await save.click();
  await expect(page.getByRole('alert').filter({ hasText: 'Dê um título' })).toHaveText('Dê um título ao doc.');
  await title.fill('t'.repeat(121));
  await save.click();
  await expect(page.getByRole('alert').filter({ hasText: 'O título passou' })).toHaveText('O título passou de 120 caracteres.');
  expect(writes, 'as recusas de título não chamam a API').toEqual([]);
  expect((await readDoc(page, headers, doc.id)).title).toBe(doc.title);

  // Texto de 100.001 caracteres (pelo texto cru): a mensagem com o tamanho, Salvar desabilitado e nada gravado.
  await title.fill(doc.title);
  await page.getByRole('button', { name: 'Ver Markdown', exact: true }).click();
  const raw = page.getByRole('textbox', { name: 'Texto do doc em Markdown' });
  await raw.fill('a'.repeat(100_001));
  await expect(page.getByRole('alert').filter({ hasText: 'O texto passou' })).toContainText('O texto passou de 100.000 caracteres (100.001).');
  await expect(save).toBeDisabled();
  expect(writes).toEqual([]);
  expect((await readDoc(page, headers, doc.id)).content).toBe('texto inicial');

  // No limite exato (100.000 caracteres) o texto grava, e o título de 120 caracteres também (renomear não cria versão).
  await raw.fill('a'.repeat(100_000));
  await expect(page.getByRole('alert').filter({ hasText: 'O texto passou' })).toHaveCount(0);
  const longTitle = 'T'.repeat(120);
  await title.fill(longTitle);
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole('button', { name: 'Editar', exact: true })).toBeVisible();
  const saved = await readDoc(page, headers, doc.id);
  expect(saved.content).toHaveLength(100_000);
  expect(saved.title).toBe(longTitle);
  expect(saved.version).toBe(2);
  expect(writes).toEqual(['PATCH']);
  expect(problems).toEqual([]);
});

test('o texto não salvo pede confirmação antes de descartar (Cancelar e Voltar), e Continuar editando o mantém', async ({ page }) => {
  const headers = await start(page);
  const doc = await createDoc(page, headers, unique('Art Doc descarte'), 'texto salvo', []);
  await page.setViewportSize(DESKTOP);
  await page.goto(`/artefatos/docs/${doc.id}`);
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  await page.getByRole('button', { name: 'Ver Markdown', exact: true }).click();
  const raw = page.getByRole('textbox', { name: 'Texto do doc em Markdown' });
  await raw.fill('texto não salvo');
  // Cancelar pergunta; "Continuar editando" mantém o texto.
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Descartar alterações?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Continuar editando' }).click();
  await expect(raw).toHaveValue('texto não salvo');
  // "Voltar" da página também pergunta, e descartar sai para Artefatos sem gravar.
  await page.getByRole('link', { name: 'Voltar', exact: true }).first().click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Descartar alterações' }).click();
  await expect(page).toHaveURL(/\/artefatos$/);
  expect((await readDoc(page, headers, doc.id)).content).toBe('texto salvo');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// 5. Conflito com o bot e histórico (A11, A15)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

test('A11 e A15: o bot grava a versão seguinte enquanto o dono edita e o conflito mantém o texto do dono e a versão do bot; restaurar uma versão cria uma versão nova e mantém as posteriores', async ({ page }) => {
  test.setTimeout(180_000);
  const problems = watchPage(page);
  const headers = await start(page);
  const bot = await createBot(page, headers, 'Art Bot Conflito');
  const doc = await botCreatesDoc(page, headers, bot, unique('Art Doc conflito'), 'Versão um do texto.');
  expect(doc.version).toBe(1);
  expect(doc.updatedBy).toBe('bot');
  await page.setViewportSize(DESKTOP);
  await page.goto(`/artefatos/docs/${doc.id}`);
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  await page.getByRole('button', { name: 'Ver Markdown', exact: true }).click();
  const raw = page.getByRole('textbox', { name: 'Texto do doc em Markdown' });
  await raw.fill('Texto do dono, escrito na versão 1.');

  // No meio da edição o bot grava a versão 2 (escrita real do worker, pela ferramenta `doc_append`).
  await botAppends(page, headers, bot, doc, 1, 'Linha do bot.');
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  // O conflito aparece com o aviso, o texto do dono continua na tela e a versão do bot continua gravada.
  const alert = page.getByRole('alert').filter({ hasText: 'O doc mudou enquanto você editava' });
  await expect(alert).toBeVisible();
  await expect(raw).toHaveValue('Texto do dono, escrito na versão 1.');
  await expect(alert.getByRole('button', { name: 'Copiar meu texto' })).toBeVisible();
  const afterConflict = await readDoc(page, headers, doc.id);
  expect(afterConflict.version).toBe(2);
  expect(afterConflict.content).toBe('Versão um do texto.\nLinha do bot.');
  expect(afterConflict.updatedBy).toBe('bot');
  expect(problems.filter((problem) => problem !== `409 PATCH /api/docs/${doc.id}`)).toEqual([]);
  // Salvar fica bloqueado até o dono decidir; descartar carrega a versão atual do bot.
  await expect(page.getByRole('button', { name: 'Salvar', exact: true })).toBeDisabled();
  await alert.getByRole('button', { name: 'Descartar e carregar a versão atual' }).click();
  const reading = page.getByRole('region', { name: 'Texto do doc' });
  await expect(reading).toContainText('Linha do bot.');

  // A15: o dono edita a versão 3 e depois restaura a versão 1: o texto volta ao da versão 1 numa versão NOVA (4), e as versões 2 e 3 continuam no histórico.
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  await page.getByRole('button', { name: 'Ver Markdown', exact: true }).click();
  await page.getByRole('textbox', { name: 'Texto do doc em Markdown' }).fill('Versão três, do dono.');
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(reading).toContainText('Versão três, do dono.');
  await page.getByRole('button', { name: 'Histórico', exact: true }).click();
  const history = page.getByRole('dialog', { name: 'Histórico de versões' });
  await expect(history.getByRole('button', { name: /^Versão 3/ })).toBeVisible();
  await expect(history.getByRole('button', { name: /^Versão 2/ })).toContainText('Bot');
  await history.getByRole('button', { name: /^Versão 1/ }).click();
  await expect(history.getByText('Versão um do texto.')).toBeVisible();
  await history.getByRole('button', { name: 'Restaurar esta versão' }).click();
  await expect(history).toHaveCount(0);
  await expect(reading).toContainText('Versão um do texto.');
  const restored = await readDoc(page, headers, doc.id);
  expect(restored.version).toBe(4);
  expect(restored.content).toBe('Versão um do texto.');
  const versions = await readVersions(page, headers, doc.id);
  expect(versions.map((item) => item.version)).toEqual([4, 3, 2, 1]);
  expect(versions[0]).toMatchObject({ author: 'owner', restoredFrom: 1 });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// 6. Conversa: cartões e painel (A4 a A7, A30)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

/** O conteúdo do doc "Plano" que o bot cria, com o suficiente de Markdown para a leitura formatada aparecer nas capturas. */
const PLAN_CONTENT = '# Plano\n\nPrimeira versão do plano, escrita pelo bot.\n\n- Definir o escopo\n- Revisar os prazos\n';

/**
 * Uma conversa de bot com os dois artefatos criados e alterados pelo worker real: o doc "Plano" (uma resposta) e a tabela "Tarefas" (outra resposta, com um registro do bot). O nome do bot é único por teste (o nome de
 * um bot ativo é único no banco).
 */
async function buildConversation(page: Page, headers: Headers, botName: string) {
  const bot = await createBot(page, headers, botName);
  const table = await createTable(page, headers, bot.id, 'Tarefas');
  await seedRecords(page, headers, table, ['Tarefa de partida']);
  const doc = await botCreatesDoc(page, headers, bot, 'Plano', PLAN_CONTENT);
  await botWritesTable(page, headers, bot, table, 'Tarefa do bot 1');
  return { bot, table, doc, url: `/bots/${bot.id}` };
}

test('A4: cada resposta tem um cartão por artefato com tipo, título e link, sem cartão de sistema, push nem bolinha a mais; numa resposta que cria o doc e altera a tabela duas vezes são exatamente dois cartões', async ({ page }, info) => {
  test.setTimeout(240_000);
  const problems = watchPage(page);
  const headers = await start(page);
  // Um dispositivo de push registrado: sem nenhum, o servidor nem grava os eventos de aviso e a prova de "sem push a mais" seria vazia. Removido no fim.
  const registered = await page.request.post(`${ORIGIN}/api/push/devices`, { headers, data: { token: `artifacts-e2e-${randomUUID()}` } });
  expect(registered.status(), 'registrar o dispositivo de push').toBe(200);
  const deviceId = ((await registered.json()) as { id: string }).id;
  try {
    const bot = await createBot(page, headers, 'Art Bot Cartões');
    const table = await createTable(page, headers, bot.id, 'Tarefas');
    // Uma resposta comum, sem artefato: é a referência do que uma resposta do bot gera de push.
    await runAsBot(page, headers, bot.id, 'Uma resposta comum, sem artefato.');
    const doc = await botCreatesDoc(page, headers, bot, 'Plano', PLAN_CONTENT);
    await botWritesTable(page, headers, bot, table, 'Primeira alteração');
    await botWritesTable(page, headers, bot, table, 'Segunda alteração');

    await page.setViewportSize(DESKTOP);
    await page.goto(`/bots/${bot.id}`);
    await expect(conversationLog(page)).toBeVisible();
    // As três respostas reais: um cartão por artefato em cada (a tabela alterada em duas respostas tem um cartão em cada uma).
    await expect(cardLists(page)).toHaveCount(3);
    for (const list of await cardLists(page).all()) await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(cardLists(page).nth(0).getByRole('link')).toHaveAttribute('href', `/bots/${bot.id}?artefato=doc:${doc.id}`);
    await expect(cardLists(page).nth(0)).toContainText('Doc');
    await expect(cardLists(page).nth(0)).toContainText('Plano');
    await expect(cardLists(page).nth(1).getByRole('link')).toHaveAttribute('href', `/bots/${bot.id}?artefato=table:${table.id}`);
    await expect(cardLists(page).nth(1)).toContainText('Tabela');
    await expect(cardLists(page).nth(1)).toContainText('Tarefas');

    // Sem cartão de sistema: o conteúdo da conversa não ganha nenhuma mensagem de cartão, e o aviso é um só por resposta (o mesmo tipo da resposta comum).
    const snapshot = (await (await page.request.get(`${ORIGIN}/api/bots/${bot.id}/conversation`, { headers })).json()) as { items: { kind: string; tool?: string; artifacts?: { type: string }[] }[] };
    expect(snapshot.items.filter((item) => item.kind === 'card'), 'nenhum cartão de sistema gravado').toEqual([]);
    expect(snapshot.items.filter((item) => item.kind === 'activity' && item.artifacts?.length).map((item) => item.tool)).toEqual(['doc_create', 'table_write', 'table_write']);
    const pushed = (await (await fetch(`${CONTROL}/push-events?botId=${bot.id}`)).json()) as { events: { kind: string }[] };
    expect(pushed.events, 'um aviso por resposta, as quatro').toHaveLength(4);
    expect(new Set(pushed.events.map((event) => event.kind)).size, 'os avisos são todos do mesmo tipo: o da resposta').toBe(1);

    // UMA resposta com as três chamadas: as três atividades sob a MESMA execução (só o `runId` é reescrito, no snapshot) dão exatamente dois cartões, um por artefato.
    await page.route(`**/api/bots/${bot.id}/conversation`, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { items: { kind: string; runId: string | null; artifacts?: unknown[] }[] };
      const marked = body.items.filter((item) => item.kind === 'activity' && item.artifacts?.length);
      for (const item of marked) item.runId = marked[0]!.runId;
      await route.fulfill({ response, json: body });
    });
    await page.reload();
    await expect(conversationLog(page)).toBeVisible();
    await expect(cardLists(page)).toHaveCount(1);
    const only = cardLists(page).first();
    await expect(only.getByRole('listitem')).toHaveCount(2);
    await expect(only.getByRole('link').nth(0)).toContainText('Plano');
    await expect(only.getByRole('link').nth(0)).toContainText('Doc');
    await expect(only.getByRole('link').nth(1)).toContainText('Tarefas');
    await expect(only.getByRole('link').nth(1)).toContainText('Tabela');
    await page.unroute(`**/api/bots/${bot.id}/conversation`);

    // A30: o cartão na conversa, em 1280 e 375 px (a conversa já recarregada com as três respostas reais).
    await page.reload();
    await expect(cardLists(page)).toHaveCount(3);
    await proveBothWidths(page, info, 'cartao');
    expect(problems).toEqual([]);
  } finally {
    await page.request.delete(`${ORIGIN}/api/push/devices/${deviceId}`, { headers });
  }
});

test('A5, A7 e A30: no desktop o cartão abre o doc num painel ao lado com a conversa utilizável, Fechar painel e o Voltar do navegador o fecham, o link abre direto e o conflito mantém o texto no painel', async ({ page }, info) => {
  test.setTimeout(240_000);
  const problems = watchPage(page);
  const headers = await start(page);
  const { bot, doc, url } = await buildConversation(page, headers, 'Art Bot Painel do doc');
  await page.setViewportSize(DESKTOP);
  await page.goto(url);
  await expect(docCard(page, 'Plano')).toBeVisible();

  // A5: abrir o cartão põe o doc num painel AO LADO; a conversa continua visível e utilizável (o campo de mensagem aceita texto e a lista de mensagens não some nem passa por baixo do painel).
  await docCard(page, 'Plano').click();
  await expect(docPanel(page)).toBeVisible();
  await expect(docPanel(page)).toBeFocused();
  await expect(page).toHaveURL(`${ORIGIN}${url}?artefato=doc:${doc.id}`);
  await expect(docPanel(page).getByRole('heading', { level: 2, name: 'Plano' })).toBeVisible();
  await expect(docPanel(page).getByRole('region', { name: 'Texto do doc' })).toContainText('Primeira versão do plano, escrita pelo bot.');
  await expect(docCard(page, 'Plano')).toHaveAttribute('aria-current', 'true');
  const log = (await conversationLog(page).boundingBox())!;
  const panel = (await docPanel(page).boundingBox())!;
  expect(log.width, 'a conversa continua com largura de leitura').toBeGreaterThan(400);
  expect(log.x + log.width, 'o painel está ao lado da conversa, sem sobrepô-la').toBeLessThanOrEqual(panel.x + 1);
  await composer(page).fill('Mensagem de teste com o painel aberto');
  await expect(composer(page)).toHaveValue('Mensagem de teste com o painel aberto');
  // A30: o painel com o doc em leitura.
  await proveBothWidths(page, info, 'painel-doc-leitura');

  // "Fechar painel" fecha e devolve o foco ao cartão; a conversa e o texto digitado ficam como estavam.
  await page.getByRole('button', { name: 'Fechar painel', exact: true }).click();
  await expect(docPanel(page)).toHaveCount(0);
  await expect(page).toHaveURL(`${ORIGIN}${url}`);
  await expect(composer(page)).toHaveValue('Mensagem de teste com o painel aberto');
  await expect(docCard(page, 'Plano')).toBeFocused();
  // O Voltar do navegador fecha o painel aberto por clique, e Avançar o reabre.
  await docCard(page, 'Plano').click();
  await expect(docPanel(page)).toBeVisible();
  await page.goBack();
  await expect(docPanel(page)).toHaveCount(0);
  await expect(page).toHaveURL(`${ORIGIN}${url}`);
  await page.goForward();
  await expect(docPanel(page)).toBeVisible();
  // O link direto (`?artefato=`) abre o painel já na carga.
  await page.goto(`${url}?artefato=doc:${doc.id}`);
  await expect(docPanel(page)).toBeVisible();
  await expect(docPanel(page).getByRole('heading', { level: 2, name: 'Plano' })).toBeVisible();

  // A30: o painel com o doc em edição (o editor visual dentro do painel).
  await docPanel(page).getByRole('button', { name: 'Editar', exact: true }).click();
  await expect(visualEditor(docPanel(page))).toBeVisible();
  await visualEditor(docPanel(page)).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('Linha escrita pelo dono no painel.');
  await proveBothWidths(page, info, 'painel-doc-edicao');

  // Texto não salvo: fechar o painel pergunta; "Continuar editando" mantém o painel e o texto.
  await page.getByRole('button', { name: 'Fechar painel', exact: true }).click();
  const discard = page.getByRole('dialog', { name: 'Descartar alterações?' });
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: 'Continuar editando' }).click();
  await expect(visualEditor(docPanel(page))).toContainText('Linha escrita pelo dono no painel.');

  // A11 no painel e A30 (aviso de conflito): o bot grava a versão 2 enquanto o dono edita; o painel mostra o conflito, o texto continua e a versão do bot fica gravada.
  await botAppends(page, headers, bot, doc, 1, '- Item que o bot acrescentou');
  await docPanel(page).getByRole('button', { name: 'Salvar', exact: true }).click();
  const conflict = docPanel(page).getByRole('alert').filter({ hasText: 'O doc mudou enquanto você editava' });
  await expect(conflict).toBeVisible();
  await expect(visualEditor(docPanel(page))).toContainText('Linha escrita pelo dono no painel.');
  expect((await readDoc(page, headers, doc.id)).content).toBe(`${PLAN_CONTENT}- Item que o bot acrescentou`);
  await proveBothWidths(page, info, 'painel-doc-conflito');
  await conflict.getByRole('button', { name: 'Descartar e carregar a versão atual' }).click();
  await expect(docPanel(page).getByRole('region', { name: 'Texto do doc' })).toContainText('Item que o bot acrescentou');
  expect(problems.filter((problem) => problem !== `409 PATCH /api/docs/${doc.id}`)).toEqual([]);
});

test('A6: em 375 px o cartão abre o artefato em tela cheia e o Voltar retorna à mesma conversa', async ({ page }) => {
  test.setTimeout(240_000);
  const problems = watchPage(page);
  const headers = await start(page);
  const { bot, doc, url } = await buildConversation(page, headers, 'Art Bot Tela cheia');
  await page.setViewportSize(MOBILE);
  await page.goto(url);
  await expect(docCard(page, 'Plano')).toBeVisible();
  await expect(page.getByText('Encontrei:').first()).toBeVisible();

  await docCard(page, 'Plano').click();
  await expect(docPanel(page)).toBeVisible();
  // Tela cheia: o painel cobre a largura toda e a conversa fica escondida por baixo (fora da leitura e do foco).
  const box = (await docPanel(page).boundingBox())!;
  expect(box.x).toBeLessThanOrEqual(1);
  expect(box.width).toBeGreaterThanOrEqual(MOBILE.width - 2);
  await expect(conversationLog(page)).toBeHidden();
  await expect(docPanel(page).getByRole('heading', { level: 2, name: 'Plano' })).toBeVisible();
  await expect(docPanel(page).getByRole('button', { name: 'Fechar painel' }), 'em 375 px o controle é o Voltar').toBeHidden();
  // "Voltar" retorna à MESMA conversa (o mesmo endereço, sem o painel, com as mensagens à vista).
  await docPanel(page).getByRole('button', { name: 'Voltar', exact: true }).click();
  await expect(docPanel(page)).toHaveCount(0);
  await expect(page).toHaveURL(`${ORIGIN}/bots/${bot.id}`);
  await expect(conversationLog(page)).toBeVisible();
  await expect(docCard(page, 'Plano')).toBeVisible();
  await expect(page.getByText('Encontrei:').first()).toBeVisible();
  // O endereço com `?artefato=` também abre em tela cheia direto, e o do doc que não existe mostra a mensagem do painel sem derrubar a conversa.
  await page.goto(`${url}?artefato=doc:${doc.id}`);
  await expect(docPanel(page)).toBeVisible();
  await page.goto(`${url}?artefato=doc:${randomUUID()}`);
  await expect(docPanel(page).getByText('Doc não encontrado.')).toBeVisible();
  expect(problems.filter((problem) => !problem.startsWith('404 GET /api/docs/'))).toEqual([]);
});

test('A7 e A30: a tabela abre embutida no painel com "Abrir em tela inteira", que leva à página própria, e o mesmo endereço aberto direto mostra a tabela', async ({ page, context }, info) => {
  test.setTimeout(240_000);
  const problems = watchPage(page);
  const headers = await start(page);
  const { table, url } = await buildConversation(page, headers, 'Art Bot Painel da tabela');
  await page.setViewportSize(DESKTOP);
  await page.goto(url);
  await expect(tableCard(page, 'Tarefas')).toBeVisible();
  await tableCard(page, 'Tarefas').click();
  await expect(tablePanel(page)).toBeVisible();
  await expect(tablePanel(page).getByRole('heading', { level: 2, name: 'Tarefas' })).toBeVisible();
  // Embutida, a grade larga não cabe: vale a lista de registros do painel (container query), com os registros do dono e do bot, e a página não rola na horizontal.
  await expect(tablePanel(page).getByRole('button', { name: /Tarefa de partida/ })).toBeVisible();
  await expect(tablePanel(page).getByRole('button', { name: /Tarefa do bot 1/ })).toBeVisible();
  await expect(tablePanel(page).getByRole('grid')).toBeHidden();
  const log = (await conversationLog(page).boundingBox())!;
  const panel = (await tablePanel(page).boundingBox())!;
  expect(log.x + log.width, 'o painel está ao lado da conversa').toBeLessThanOrEqual(panel.x + 1);
  await proveBothWidths(page, info, 'painel-tabela');

  // "Abrir em tela inteira": a página própria da tabela, com a grade completa.
  await tablePanel(page).getByRole('link', { name: 'Abrir em tela inteira' }).click();
  await expect(page).toHaveURL(`${ORIGIN}/artefatos/tabelas/${table.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Tarefas' })).toBeVisible();
  await expect(page.getByRole('grid')).toBeVisible();
  // O mesmo endereço aberto direto, numa página nova com a mesma sessão, mostra o artefato; o do doc também tem página própria (`artefatos/docs/[id]`).
  const direct = await context.newPage();
  await direct.setViewportSize(DESKTOP);
  await direct.goto(`/artefatos/tabelas/${table.id}`);
  await expect(direct.getByRole('heading', { level: 1, name: 'Tarefas' })).toBeVisible();
  await expect(direct.getByRole('gridcell', { name: /Tarefa de partida/ })).toBeVisible();
  await direct.close();
  expect(problems).toEqual([]);
});

test('o ?artefato= fora do formato não abre painel nem derruba a conversa', async ({ page }) => {
  const problems = watchPage(page);
  const headers = await start(page);
  const bot = await createBot(page, headers, 'Art Bot Parâmetro');
  await page.setViewportSize(DESKTOP);
  // Valores que a URL pode trazer e que nunca devem virar caminho de API: id que não é UUID, tipo desconhecido, tipo em maiúsculas e valor sem id.
  for (const value of ['doc:nao-e-um-uuid', 'pdf:00000000-0000-4000-8000-000000000000', 'DOC:00000000-0000-4000-8000-000000000000', 'doc', 'doc:../../api/bots']) {
    await page.goto(`/bots/${bot.id}?artefato=${encodeURIComponent(value)}`);
    await expect(conversationLog(page), value).toBeVisible();
    await expect(page.getByRole('complementary', { name: /^Painel d/ }), value).toHaveCount(0);
  }
  expect(problems).toEqual([]);
});

/**
 * Todo controle (botão, link, campo) do painel `scope` que fica FORA da largura do painel: a lista vazia é "nenhum controle cortado nem por baixo da conversa". O axe e a rolagem da PÁGINA não
 * enxergam isso, porque o painel esconde o que passa da borda dele (`overflow`) sem a página rolar.
 */
async function controlsOutside(scope: Locator): Promise<string[]> {
  return scope.evaluate((panel) => {
    const box = panel.getBoundingClientRect();
    const controls = [...panel.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, [contenteditable="true"]')].filter((control) => {
      const rect = control.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(control).visibility !== 'hidden';
    });
    return controls.flatMap((control) => {
      const rect = control.getBoundingClientRect();
      const name = control.getAttribute('aria-label') ?? control.textContent?.trim().slice(0, 40) ?? control.tagName;
      return rect.left < box.left - 1 || rect.right > box.right + 1 ? [`${name}: ${Math.round(rect.left)} a ${Math.round(rect.right)} px, fora do painel (${Math.round(box.left)} a ${Math.round(box.right)} px)`] : [];
    });
  });
}

test('A30: todos os controles do painel cabem na largura dele, no doc em leitura e em edição e na tabela, em 1280 e 375 px', async ({ page }) => {
  test.setTimeout(240_000);
  const headers = await start(page);
  const { doc, table, url } = await buildConversation(page, headers, 'Art Bot Geometria');
  for (const [label, size] of [['1280', DESKTOP], ['375', MOBILE]] as const) {
    await page.setViewportSize(size);
    await page.goto(`${url}?artefato=doc:${doc.id}`);
    await expect(docPanel(page).getByRole('region', { name: 'Texto do doc' })).toBeVisible();
    expect.soft(await controlsOutside(docPanel(page)), `doc em leitura em ${label} px`).toEqual([]);
    await docPanel(page).getByRole('button', { name: 'Editar', exact: true }).click();
    await expect(visualEditor(docPanel(page))).toBeVisible();
    expect.soft(await controlsOutside(docPanel(page)), `doc em edição em ${label} px`).toEqual([]);
    await page.goto(`${url}?artefato=table:${table.id}`);
    await expect(tablePanel(page).getByRole('button', { name: /Tarefa de partida/ })).toBeVisible();
    expect.soft(await controlsOutside(tablePanel(page)), `tabela em ${label} px`).toEqual([]);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// 7. Aprovação da exclusão de doc (A35, decisão 23)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

/** O cartão de aprovação do bot como a API da conversa o entrega: só o que a prova de A35 lê (o impacto que o servidor gravou, não o que a tela monta). */
interface ApprovalSnapshot {
  approvalId: string;
  status: string;
  action: string;
  impact?: { kind?: string; docId?: string; docTitle?: string; tableName?: string };
}

/** Espera o cartão de aprovação PENDENTE do bot na conversa (lida pela API, que é o que o worker real gravou ao pausar a execução) e o devolve. */
async function pendingApprovalOf(page: Page, headers: Headers, botId: string): Promise<ApprovalSnapshot> {
  let found: ApprovalSnapshot | undefined;
  await expect
    .poll(
      async () => {
        const snapshot = (await (await page.request.get(`${ORIGIN}/api/bots/${botId}/conversation`, { headers })).json()) as { items: { card?: ApprovalSnapshot & { type: string } }[] };
        found = snapshot.items.map((item) => item.card).find((card) => card?.type === 'approval' && card.status === 'pending');
        return found?.approvalId ?? '';
      },
      { timeout: 30_000 },
    )
    .not.toBe('');
  return found!;
}

/** O bot pede a ferramenta pelo marcador do provedor falso e a mensagem é aceita; a execução NÃO termina (pausa na aprovação), então não se espera por ela. */
async function botAsks(page: Page, headers: Headers, bot: Bot, name: string, args: unknown): Promise<void> {
  const sent = await page.request.post(`${ORIGIN}/api/bots/${bot.id}/messages`, { headers, data: { content: tableMarker(name, args) } });
  expect(sent.status(), `pedir ${name} ao bot`).toBe(201);
}

/** A35: o texto de `note` está na mesma linha de `label` e à direita dele, ou seja, "ao lado da ação" (só no desktop: no celular a linha pode quebrar, e o texto continua visível). */
async function expectBeside(label: Locator, note: Locator): Promise<void> {
  await expect(label).toBeVisible();
  await expect(note).toBeVisible();
  const [labelBox, noteBox] = [(await label.boundingBox())!, (await note.boundingBox())!];
  expect(noteBox.x, 'o título vem depois da ação, na mesma linha').toBeGreaterThanOrEqual(labelBox.x + labelBox.width - 1);
  expect(Math.abs(labelBox.y + labelBox.height / 2 - (noteBox.y + noteBox.height / 2)), 'o título e a ação ficam na mesma linha').toBeLessThan(labelBox.height);
}

test('A35: o bot pede para excluir o doc "Plano" e o cartão (pendente e respondido) mostra "Doc: Plano" ao lado da ação e "Aguardando você" na linha abaixo dela; o cartão de exclusão de registros segue com o nome da tabela; A30', async ({ page }, info) => {
  test.setTimeout(240_000);
  const problems = watchPage(page);
  const headers = await start(page);
  // As duas categorias de exclusão perguntam (o catálogo é registrado pela leitura das regras) e voltam a neutras no fim: a regra global é estado de todos os bots e dos outros specs.
  const slugs = ['aion_doc_delete', 'aion_table_records_delete'];
  expect((await page.request.get(`${ORIGIN}/api/approval-rules`, { headers })).status(), 'registrar o catálogo de regras').toBe(200);
  const setRules = async (value: 'ask' | 'neutral') => {
    for (const slug of slugs) expect((await page.request.put(`${ORIGIN}/api/approval-rules/${slug}`, { headers, data: { value } })).status(), `regra ${slug}`).toBe(200);
  };
  await setRules('ask');
  try {
    // O bot do doc: o doc "Plano" compartilhado com ele (acesso) e o pedido de exclusão, que o worker real pausa na aprovação.
    const docBot = await createBot(page, headers, 'Art Bot Exclui Doc');
    const doc = await createDoc(page, headers, 'Plano', PLAN_CONTENT, [docBot.id]);
    await botAsks(page, headers, docBot, 'doc_delete', { docId: doc.id, operationId: randomUUID() });
    // O bot da tabela: um registro e o pedido de exclusão dele (a aprovação que já mostrava o nome da tabela).
    const tableBot = await createBot(page, headers, 'Art Bot Exclui Tabela');
    const table = await createTable(page, headers, tableBot.id, unique('Art Tabela com nome longo de exclusão de registro'));
    const written = await page.request.post(`${ORIGIN}/api/tables/${table.id}/records`, {
      headers,
      data: { operationId: randomUUID(), expectedSchemaVersion: table.schemaVersion, creates: [{ values: { [table.columns[0]!.id]: 'Registro a excluir' } }] },
    });
    expect(written.status(), 'semear o registro').toBe(200);
    const record = ((await written.json()) as { records: { id: string; version: number }[] }).records[0]!;
    const current = (await (await page.request.get(`${ORIGIN}/api/tables/${table.id}`, { headers })).json()) as DataTable;
    await botAsks(page, headers, tableBot, 'table_delete_records', {
      tableId: table.id,
      operationId: randomUUID(),
      operation: { kind: 'delete_records', expectedVersion: current.version, records: [{ id: record.id, expectedVersion: record.version }] },
    });

    // O que o servidor gravou no cartão: o título lido do banco no impacto (o argumento do modelo só tem o id), e o nome da tabela no impacto da tabela.
    const docApproval = await pendingApprovalOf(page, headers, docBot.id);
    expect(docApproval.action).toBe('aion_doc_delete');
    expect(docApproval.impact).toEqual({ kind: 'delete_doc', docId: doc.id, docTitle: 'Plano' });
    const tableApproval = await pendingApprovalOf(page, headers, tableBot.id);
    expect(tableApproval.action).toBe('aion_table_records_delete');
    expect(tableApproval.impact?.tableName).toBe(table.name);

    // Cartão pendente do doc na conversa: "Doc: Plano" ao lado da ação e a frase de que não há volta.
    const pendingCard = page.getByRole('region', { name: 'Aprovação pendente' });
    const answeredCard = page.getByRole('region', { name: 'Aprovação', exact: true });
    await page.setViewportSize(DESKTOP);
    await page.goto(`/bots/${docBot.id}`);
    await expect(pendingCard).toBeVisible();
    await expectBeside(pendingCard.getByText('Excluir doc', { exact: true }), pendingCard.getByText('Doc: Plano', { exact: true }));
    await expect(pendingCard).toContainText('Esta ação não pode ser desfeita.');
    // A30: a conversa com o cartão pendente do doc.
    await proveBothWidths(page, info, 'aprovacao-doc-pendente');

    // "Aguardando você", no topo de Aprovações: a linha do bot do doc traz "Doc: Plano" na linha abaixo da ação, como a conta da phase 13; a do bot da tabela traz só a ação, sem título de doc.
    await page.goto('/aprovacoes');
    const waiting = page.getByRole('region', { name: 'Aguardando você' });
    const docRow = waiting.getByRole('link').filter({ hasText: docBot.name });
    const tableRow = waiting.getByRole('link').filter({ hasText: tableBot.name });
    await expect(docRow).toContainText('Excluir doc');
    await expect(docRow).toContainText('Doc: Plano');
    await expect(tableRow).toContainText('Excluir registros');
    await expect(tableRow).not.toContainText('Doc:');
    // A30: Aprovações com as duas pendências.
    await proveBothWidths(page, info, 'aprovacoes-aguardando-doc');

    // A linha leva ao cartão do bot do doc, que continua pendente e com o título.
    await docRow.click();
    await expect(page).toHaveURL(new RegExp(`/bots/${docBot.id}\\?mensagem=`));
    await expect(pendingCard.getByText('Doc: Plano', { exact: true })).toBeVisible();

    // O cartão de exclusão de registros segue mostrando o nome da tabela, sem título de doc; negar o fecha e preserva o registro.
    await page.goto(`/bots/${tableBot.id}`);
    await expect(pendingCard).toContainText(`Tabela: ${table.name}`);
    await expect(pendingCard).toContainText('1 registro(s) afetado(s).');
    await expect(pendingCard).not.toContainText('Doc:');
    await pendingCard.getByRole('button', { name: 'Negar', exact: true }).click();
    await expect(answeredCard).toContainText('Excluir registros');
    await expect(answeredCard).toContainText(`${table.name} · 1 registro(s) afetado(s)`);
    await expect(answeredCard).toContainText('Negada');
    await expect(answeredCard).not.toContainText('Doc:');
    const kept = (await (await page.request.get(`${ORIGIN}/api/tables/${table.id}/records`, { headers })).json()) as { records: { id: string }[] };
    expect(kept.records.map((row) => row.id), 'negar preserva o registro').toContain(record.id);

    // Cartão respondido do doc: permitir uma vez executa a exclusão e o cartão colapsado continua dizendo "Doc: Plano" ao lado da ação, também depois de recarregar (o que o servidor gravou).
    await page.goto(`/bots/${docBot.id}`);
    await pendingCard.getByRole('button', { name: 'Permitir uma vez', exact: true }).click();
    await expect(pendingCard).toHaveCount(0);
    await expect(answeredCard).toContainText('Aprovada');
    await expectBeside(answeredCard.getByText('Excluir doc', { exact: true }), answeredCard.getByText('Doc: Plano', { exact: true }));
    await page.reload();
    await expect(answeredCard).toContainText('Aprovada');
    await expectBeside(answeredCard.getByText('Excluir doc', { exact: true }), answeredCard.getByText('Doc: Plano', { exact: true }));
    // A exclusão foi mesmo executada (o doc saiu) e a pendência saiu de "Aguardando você".
    await expect.poll(async () => (await page.request.get(`${ORIGIN}/api/docs/${doc.id}`, { headers })).status()).toBe(404);
    // A30: a conversa com o cartão respondido do doc.
    await proveBothWidths(page, info, 'aprovacao-doc-respondida');
    await page.goto('/aprovacoes');
    await expect(waiting.getByRole('link').filter({ hasText: docBot.name })).toHaveCount(0);
    expect(problems).toEqual([]);
  } finally {
    await setRules('neutral');
  }
});

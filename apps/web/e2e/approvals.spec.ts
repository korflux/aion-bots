// E2E das aprovações (T7; A8, C4; F9 e F10) no navegador real, contra a pilha de produção (Postgres, API, worker, Next e proxy) com o
// OpenCode Go e o Composio FALSOS. O modelo falso chama ações do Composio por marcadores no texto: [gmail] envia e-mail, [gmail2]
// envia e lista na mesma etapa, [github] abre uma issue (ver packages/core/src/testing/fake-upstreams.ts).
//
// Cobre: o cartão pendente (ação, app, parâmetros, "Expira em", selo "Aguardando aprovação" e badge da barra), permitir uma vez
// por teclado (Enter no botão), negar, sempre permitir pelo menu (e a regra aparecendo na seção "Aprovações do bot", onde também
// se altera e se remove), a tela Aprovações (grupos por app, controle segmentado com setas, busca, bots com regra própria), parar a
// execução que espera, o badge com 3 pendências e o layout em 375 px, com axe em cada estado. A chave do Composio e as regras
// são estado global, então o arquivo é serial e roda no projeto `chromium-approvals`, depois da conversa.
//
// Phase 13 (CONN-02): o bot criado num teste nasce sem conta do conector e, sem conta, não traz as ferramentas do Composio, então `createBot` libera a ele a conta que os bots usavam antes
// da phase (Gmail `ca_1`, GitHub `ca_3`) pelo auxiliar de `support/fixtures.ts`. O teste da conta (A9, A13, A25) libera só a segunda conta do Gmail (`ca_6`) e confere que o nome dela
// aparece no cartão pendente e respondido, em "Aguardando você" e, só para leitura, no editor do bot, em 1440 e 375 px.
import type { Locator, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { connectorAccountsResponseSchema, type DataTable } from '@aion/shared';
import { tableMarker } from '../../../packages/core/src/testing/fake-upstreams';
import {
  FIRST_ACTIVE_CONNECTOR_ACCOUNTS,
  ORIGIN,
  apiHeaders,
  attachShot,
  uniqueBotName,
  expect,
  expectNoA11yViolations,
  ensureCredential,
  expectNoHorizontalScroll,
  faiscaLook,
  releaseConnectorAccounts,
  runningAnimations,
  openWorkLine,
  test,
  watchPage,
} from './support/fixtures';

test.describe.configure({ mode: 'serial' });

test('D7: categoria interna de tabelas permite, nega e sempre permite sem ampliar acesso, com retomada real', async ({ page }, info) => {
  await prepare(page); const headers = await apiHeaders(page); const botId = await createBot(page, 'Aprovar exclusões locais');
  await page.request.get(`${ORIGIN}/api/approval-rules`, { headers });
  expect((await page.request.put(`${ORIGIN}/api/approval-rules/aion_table_records_delete`, { headers, data: { value: 'ask' } })).status()).toBe(200);
  const response = await page.request.post(`${ORIGIN}/api/bots/${botId}/tables`, { headers, data: { name: 'Tabela fictícia de aprovação com identificação legível e nome longo', operationId: randomUUID(), columns: [{ name: 'Nome', type: 'text' }] } });
  expect(response.status()).toBe(201); const table = await response.json() as DataTable;
  /** Cada rodada usa a revisão atual, e o próprio bot prepara antes de pedir aprovação no executor real. */
  async function propose(label: string) {
    const write = await page.request.post(`${ORIGIN}/api/tables/${table.id}/records`, { headers, data: { operationId: randomUUID(), expectedSchemaVersion: 1, creates: [{ values: { [table.columns[0]!.id]: label } }] } });
    expect(write.status()).toBe(200); const row = (await write.json()).records[0] as { id: string; version: number };
    const current = await (await page.request.get(`${ORIGIN}/api/tables/${table.id}`, { headers })).json() as DataTable;
    const sent = await page.request.post(`${ORIGIN}/api/bots/${botId}/messages`, { headers, data: { content: tableMarker('table_delete_records', { tableId: table.id, operationId: randomUUID(), operation: { kind: 'delete_records', expectedVersion: current.version, records: [{ id: row.id, expectedVersion: row.version }] } }) } }); expect(sent.status()).toBe(201);
    return row;
  }
  async function records() { return (await (await page.request.get(`${ORIGIN}/api/tables/${table.id}/records`, { headers })).json()).records as { id: string }[]; }
  /** Reutiliza a sessão capturada: apiHeaders depois da navegação criaria cookie novo e invalidaria o CSRF da UI. */
  async function pending() { await expect.poll(async () => { const snapshot = await (await page.request.get(`${ORIGIN}/api/bots/${botId}/conversation`, { headers })).json(); return snapshot.items.some((item: { card?: { type: string; status: string } }) => item.card?.type === "approval" && item.card.status === "pending"); }).toBe(true); }
  const denied = await propose('Negado e preservado'); await pending(); await page.goto(`/bots/${botId}`);
  await expect(pendingCard(page)).toContainText(`Tabela: ${table.name}`); await expect(pendingCard(page)).toContainText('1 registro(s) afetado(s).');
  await expect(pendingCard(page)).toContainText('Não concede acesso a outras tabelas.');
  await page.setViewportSize({ width: 1280, height: 800 }); await expectNoA11yViolations(page); await pendingCard(page).scrollIntoViewIfNeeded(); await attachShot(page, info, 'T7-D7-aprovacao-1280');
  await page.setViewportSize({ width: 320, height: 640 }); await expectNoHorizontalScroll(page); await expectNoA11yViolations(page); await pendingCard(page).scrollIntoViewIfNeeded(); await attachShot(page, info, 'T7-D7-aprovacao-320');
  await pendingCard(page).getByRole('button', { name: 'Negar', exact: true }).click();
  await expect(answeredCard(page).getByText('Negada', { exact: true })).toBeVisible();
  await expect.poll(async () => (await records()).some((row) => row.id === denied.id)).toBe(true);
  await expect(headerBadge(page)).toHaveCount(0);
  const allowed = await propose('Permitido uma vez'); await pending();
  await pendingCard(page).getByRole('button', { name: 'Permitir uma vez', exact: true }).click();
  await expect.poll(async () => (await records()).some((row) => row.id === allowed.id)).toBe(false);
  const always = await propose('Sempre permitido'); await pending();
  await pendingCard(page).getByRole('button', { name: 'Mais opções de resposta' }).click();
  await page.getByRole('menuitem', { name: 'Sempre permitir', exact: true }).click();
  await expect.poll(async () => (await records()).some((row) => row.id === always.id)).toBe(false);
  const rules = await (await page.request.get(`${ORIGIN}/api/bots/${botId}/approval-rules`, { headers })).json();
  expect(rules.rules).toContainEqual(expect.objectContaining({ action: 'aion_table_records_delete', value: 'allow', appName: 'Tabelas do Aion' }));
  expect((await (await page.request.get(`${ORIGIN}/api/tables/${table.id}`, { headers })).json()).botIds).toEqual([botId]);
  const subsequent = await propose('Executado pela regra do bot');
  await expect.poll(async () => (await records()).some((row) => row.id === subsequent.id)).toBe(false);
  await expect(pendingCard(page)).toHaveCount(0);
  await page.goto('/aprovacoes');
  const group = page.getByRole('region', { name: 'Tabelas do Aion', exact: true });
  await expect(group).toContainText('Categorias internas do Aion.');
  await page.setViewportSize({ width: 375, height: 812 }); await expectNoHorizontalScroll(page); await expectNoA11yViolations(page); await attachShot(page, info, 'T7-D7-regras-375');
});

const PROVIDER_KEY = 'valid-e2e-aprov-1111';
const CONNECTOR_KEY = 'valid-e2e-composio-2222';
const SEND_EMAIL = 'GMAIL_SEND_EMAIL';

/** O primeiro `prepare` deste processo já trocou as chaves pelas esperadas? (o arquivo é serial e roda num worker só) */
let credentialsSeeded = false;

/**
 * Provedor e Composio conectados, e a regra global de enviar e-mail de volta a neutra (cada teste parte do mesmo estado). Na PRIMEIRA
 * chamada as duas chaves são trocadas pelas que este spec espera: as credenciais são estado global e os projetos anteriores as deixam
 * como terminaram (o último teste de `settings-keys.spec.ts` deixa o Composio SEM apps, e sem apps o motor não oferece ação nenhuma, então
 * o cartão de aprovação nunca aparece: E17). Nas chamadas seguintes só se confere que existem: o limite é de 10 validações por minuto.
 */
async function prepare(page: Page): Promise<void> {
  const replace = !credentialsSeeded;
  await ensureCredential(page, 'provider', PROVIDER_KEY, { replace });
  await ensureCredential(page, 'connector', CONNECTOR_KEY, { replace });
  credentialsSeeded = true;
  const headers = await apiHeaders(page);
  // A ação só consta na lista depois que a tela Aprovações a registra (ou de um uso); antes disso a regra global não existe e o PUT é ignorado.
  await page.context().request.put(`${ORIGIN}/api/approval-rules/${SEND_EMAIL}`, { headers, data: { value: 'neutral' } });
}

/**
 * Cria um bot pela API com o nome exclusivo da repetição (`uniqueBotName`, E29) e devolve o id. O bot nasce SEM conta do conector (A15, A16) e sem conta ele não traz as
 * ferramentas do Composio, então todo bot deste spec recebe a liberação logo depois de criado: por padrão a conta que os bots usavam antes da phase (Gmail `ca_1` e GitHub `ca_3`),
 * ou as `accounts` pedidas. A liberação exige o conector configurado, o que o `prepare` de cada teste já garante.
 */
async function createBot(page: Page, name: string, color = '#60A5FA', model = 'opencode/glm-5.1', accounts: readonly string[] = FIRST_ACTIVE_CONNECTOR_ACCOUNTS): Promise<string> {
  const unique = uniqueBotName(name);
  const headers = await apiHeaders(page);
  const response = await page.context().request.post(`${ORIGIN}/api/bots`, {
    headers,
    data: { name: unique, color, instructions: '', model, effort: null, stepLimit: 25 },
  });
  expect(response.status(), `criar o bot ${unique}`).toBe(201);
  const botId = ((await response.json()) as { id: string }).id;
  await releaseConnectorAccounts(page, botId, accounts, headers);
  return botId;
}

/**
 * O rótulo que o servidor dá à conta (o nome do dono ou o rótulo automático "Gmail · ca_…6"), lido da mesma rota de que a tela de Conexões se alimenta. O teste não presume o
 * nome: a conta é estado global do Composio falso e outro spec pode tê-la renomeado.
 */
async function accountLabelOf(page: Page, headers: Record<string, string>, accountId: string): Promise<string> {
  const response = await page.context().request.get(`${ORIGIN}/api/connector/accounts`, { headers });
  expect(response.status(), 'ler as contas do conector').toBe(200);
  const account = connectorAccountsResponseSchema.parse(await response.json()).accounts.find((item) => item.id === accountId);
  expect(account, `conta ${accountId} na lista do Composio falso`).toBeDefined();
  return account!.label;
}

async function sendViaApi(page: Page, botId: string, content: string): Promise<void> {
  const response = await page.context().request.post(`${ORIGIN}/api/bots/${botId}/messages`, { headers: await apiHeaders(page), data: { content } });
  expect(response.status(), 'enviar pela API').toBe(201);
}

/** Espera o cartão pendente do bot aparecer na conversa (consultando a API) e devolve o id da aprovação. */
async function pendingApprovalId(page: Page, botId: string): Promise<string> {
  const headers = await apiHeaders(page);
  let found = '';
  await expect
    .poll(
      async () => {
        const snapshot = (await (await page.context().request.get(`${ORIGIN}/api/bots/${botId}/conversation`, { headers })).json()) as {
          items: { kind: string; card?: { type: string; status: string; approvalId: string } }[];
        };
        const card = snapshot.items.find((item) => item.card?.type === 'approval' && item.card.status === 'pending');
        found = card?.card?.approvalId ?? '';
        return found;
      },
      { timeout: 20_000 },
    )
    .not.toBe('');
  return found;
}

async function respondViaApi(page: Page, approvalId: string, decision: string): Promise<void> {
  const response = await page.context().request.post(`${ORIGIN}/api/approvals/${approvalId}/respond`, {
    headers: await apiHeaders(page),
    data: { decision },
  });
  expect(response.status(), `responder ${decision}`).toBe(200);
}

const composer = (page: Page) => page.getByRole('textbox', { name: 'Mensagem' });
const pendingCard = (page: Page) => page.getByRole('region', { name: 'Aprovação pendente' });
const answeredCard = (page: Page) => page.getByRole('region', { name: 'Aprovação', exact: true });
const headerBadge = (page: Page) => page.getByRole('status').filter({ hasText: 'Aguardando aprovação' });

/**
 * A Faísca do cartão pendente: 32 px (nível liso), decorativa, aguardando, na cor do bot, no lugar do ícone da legenda. É o ÚNICO cartão que se mexe (a Faísca
 * aguardando balança e o ícone de dúvida flutua), e o texto, o título e as ações continuam os de sempre.
 */
async function expectPendingFaisca(card: Locator, color: string): Promise<void> {
  const faisca = card.locator('svg.faisca');
  await expect(faisca).toHaveCount(1);
  expect(await faiscaLook(faisca)).toMatchObject({ state: 'waiting', detail: 'small', still: false, decorative: true, size: [32, 32], body: color.toUpperCase() });
  await expect(card.locator('[data-icon="ShieldCheck"]'), 'o ícone de 14 px da legenda sai').toHaveCount(0);
  await expect.poll(() => runningAnimations(faisca)).toBeGreaterThan(0);
}

async function send(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

test('o cartão pendente mostra a ação e pausa a execução; permitir uma vez por teclado retoma e conclui', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  await prepare(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const botId = await createBot(page, 'Financeiro');
  await page.goto(`/bots/${botId}`);
  await send(page, '[gmail] envie o relatório');

  // Pendente: a ação legível, o app, o slug, os parâmetros resumidos e o tempo restante.
  const card = pendingCard(page);
  await expect(card).toBeVisible();
  await expect(card).toContainText('Send Email');
  await expect(card).toContainText('Gmail');
  // O nome do app aparece UMA vez, dentro do rótulo "Send Email · Gmail" (E20: o cartão imprimia "Send Email · Gmail · Gmail").
  await expect(card.getByText('Send Email · Gmail', { exact: true })).toBeVisible();
  await expect(card).not.toContainText('Gmail · Gmail');
  await expect(card).toContainText(SEND_EMAIL);
  await expect(card).toContainText('dono@example.com');
  await expect(card).toContainText('Relatório');
  await expect(card).toContainText(/Expira em (23|24) h/);
  await expectPendingFaisca(card, '#60A5FA');
  // Movimento reduzido: a Faísca do cartão deixa de se mexer e fica na pose estática; depois volta.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => runningAnimations(card.locator('svg.faisca'))).toBe(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // A execução está pausada: selo no cabeçalho, atividade aguardando (relógio) e o badge da barra com o nome acessível.
  await expect(headerBadge(page)).toBeVisible();
  await expect(page.getByRole('log', { name: 'Conversa' }).getByText('Aguardando aprovação')).toBeVisible();
  await expect(page.getByTestId('approvals-badge')).toHaveText('1');
  await expect(page.getByRole('link', { name: 'Aprovações, 1 pendente' })).toBeVisible();
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'aprovacao-pendente-1440');

  // Teclado: Tab chega aos botões do cartão e Enter aprova (botão com texto, primário).
  await card.getByRole('button', { name: 'Permitir uma vez' }).focus();
  await expect(card.getByRole('button', { name: 'Permitir uma vez' })).toBeFocused();
  await page.keyboard.press('Enter');

  // Retomou do ponto exato: o cartão colapsa com o selo, a ação concluiu e o bot respondeu com o resultado.
  await expect(answeredCard(page)).toContainText('Aprovada');
  await expect(pendingCard(page)).toHaveCount(0);
  // O cartão respondido não leva Faísca e volta ao ícone da legenda.
  await expect(answeredCard(page).locator('svg.faisca')).toHaveCount(0);
  await expect(answeredCard(page).locator('[data-icon="ShieldCheck"]')).toHaveCount(1);
  await expect(page.getByRole('log', { name: 'Conversa' }).getByText(/Encontrei:/)).toBeVisible();
  await expect(headerBadge(page)).toHaveCount(0);
  await expect(page.getByTestId('approvals-badge')).toHaveCount(0);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'aprovacao-respondida-1440');
  expect(problems).toEqual([]);
});

test('a conta liberada ao bot aparece no cartão, em "Aguardando você" e, só para leitura, no editor, em 1440 e em 375 px (A9, A13, A25)', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  await prepare(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  // O bot só tem a SEGUNDA conta do Gmail (`ca_6`): a conta do cartão não é a primeira ativa que os bots usavam antes da phase, e com uma só conta liberada o modelo não precisa nomeá-la.
  const botId = await createBot(page, 'Conta própria', '#60A5FA', 'opencode/glm-5.1', ['ca_6']);
  const headers = await apiHeaders(page); // antes de abrir qualquer tela: um login novo invalidaria o CSRF dela (E22)
  const label = await accountLabelOf(page, headers, 'ca_6');
  const accountNote = `Conta: ${label}`;

  // Cartão pendente, 1440 px: a conta ao lado da ação, com o resto do cartão como sempre.
  await page.goto(`/bots/${botId}`);
  await send(page, '[gmail] envie o relatório');
  const card = pendingCard(page);
  await expect(card).toBeVisible();
  await expect(card.getByText('Send Email · Gmail', { exact: true })).toBeVisible();
  await expect(card.getByText(accountNote, { exact: true })).toBeVisible();
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'aprovacao-conta-1440');

  // "Aguardando você": a mesma conta na linha da pendência.
  await page.goto('/aprovacoes');
  const waiting = page.getByRole('region', { name: 'Aguardando você' });
  const row = waiting.getByRole('link').filter({ hasText: uniqueBotName('Conta própria') });
  await expect(row).toContainText('Send Email');
  await expect(row.getByText(accountNote, { exact: true })).toBeVisible();
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'aguardando-conta-1440');

  // 375 px: o cartão e a linha cabem na tela, a conta não sobrepõe o texto nem os botões e não há rolagem horizontal.
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(row.getByText(accountNote, { exact: true })).toBeVisible();
  const rowBox = (await row.getByText(accountNote, { exact: true }).boundingBox())!;
  expect(rowBox.x, 'a conta da linha começa dentro da tela').toBeGreaterThanOrEqual(0);
  expect(rowBox.x + rowBox.width, 'a conta da linha termina dentro da tela').toBeLessThanOrEqual(375);
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'aguardando-conta-375');
  await page.goto(`/bots/${botId}`);
  await expect(card).toBeVisible();
  const note = (await card.getByText(accountNote, { exact: true }).boundingBox())!;
  const allow = (await card.getByRole('button', { name: 'Permitir uma vez' }).boundingBox())!;
  expect(note.x, 'a conta do cartão começa dentro da tela').toBeGreaterThanOrEqual(0);
  expect(note.x + note.width, 'a conta do cartão termina dentro da tela').toBeLessThanOrEqual(375);
  expect(note.y + note.height, 'a conta fica acima dos botões').toBeLessThanOrEqual(allow.y);
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'aprovacao-conta-375');

  // Respondido: a execução retoma na conta liberada e o cartão colapsado continua dizendo qual conta foi.
  await card.getByRole('button', { name: 'Permitir uma vez' }).click();
  await expect(answeredCard(page)).toContainText('Aprovada');
  await expect(answeredCard(page).getByText(accountNote, { exact: true })).toBeVisible();
  await expect(page.getByRole('log', { name: 'Conversa' }).getByText(/Encontrei:/)).toBeVisible();
  await expectNoA11yViolations(page);

  // Editor do bot (A13): a seção lista a conta só para leitura, sem nenhum botão, e aponta Configurações → Conexões, o único lugar de liberar.
  await page.goto(`/bots/${botId}/editar`);
  const accounts = page.getByRole('region', { name: 'Contas do conector' });
  await expect(accounts.getByText(label, { exact: true })).toBeVisible();
  await expect(accounts.getByText('Ativa', { exact: true })).toBeVisible();
  await expect(accounts.getByRole('button')).toHaveCount(0);
  await expect(accounts.getByRole('checkbox')).toHaveCount(0);
  await expect(accounts.getByRole('link', { name: 'Configurações → Conexões' })).toHaveAttribute('href', '/configuracoes/conexoes');
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await accounts.scrollIntoViewIfNeeded(); // a seção fica abaixo da dobra do editor: a captura precisa mostrá-la
  await attachShot(page, testInfo, 'editor-contas-375');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(accounts.getByText(label, { exact: true })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await accounts.scrollIntoViewIfNeeded(); // a mudança de largura reposiciona a página: rola de novo até a seção
  await attachShot(page, testInfo, 'editor-contas-1440');

  // Bot sem nenhuma conta liberada: a seção diz que nenhuma está liberada (e que ele não usa o Composio).
  const bare = await createBot(page, 'Sem conta', '#9CA3AF', 'opencode/glm-5.1', []);
  await page.goto(`/bots/${bare}/editar`);
  await expect(page.getByRole('region', { name: 'Contas do conector' }).getByText('Nenhuma conta liberada a este bot.')).toBeVisible();
  expect(problems).toEqual([]);
});

test('negar não executa e o bot decide; "sempre permitir" grava a regra no bot, que passa a executar sem perguntar e aparece no editor', async ({ page }) => {
  const problems = watchPage(page);
  await prepare(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Negar: nenhuma execução, e o bot recebe "ação negada pelo usuário".
  const denied = await createBot(page, 'Cauteloso');
  await page.goto(`/bots/${denied}`);
  await send(page, '[gmail] não me deixe enviar');
  await pendingCard(page).getByRole('button', { name: 'Negar', exact: true }).click();
  await expect(answeredCard(page)).toContainText('Negada');
  await expect(page.getByRole('log', { name: 'Conversa' }).getByText(/negada pelo usuário/)).toBeVisible();

  // Sempre permitir (menu do cartão): colapsa como aprovada "sempre"; a próxima chamada executa sem cartão.
  const trusting = await createBot(page, 'Confiante', '#4ADE80');
  await page.goto(`/bots/${trusting}`);
  await send(page, '[gmail] primeiro');
  await pendingCard(page).getByRole('button', { name: 'Mais opções de resposta' }).click();
  await page.getByRole('menuitem', { name: 'Sempre permitir' }).click();
  await expect(answeredCard(page)).toContainText('Aprovada');
  await expect(answeredCard(page)).toContainText('sempre permitir');
  await expect(page.getByRole('log', { name: 'Conversa' }).getByText(/Encontrei:/)).toBeVisible();
  await send(page, '[gmail] segundo');
  await expect(page.getByRole('log', { name: 'Conversa' }).getByText(/Encontrei:/)).toHaveCount(2);
  await expect(pendingCard(page)).toHaveCount(0);

  // Editor do bot: a regra própria aparece, muda no controle segmentado (por teclado) e some ao remover.
  await page.goto(`/bots/${trusting}/editar`);
  const section = page.getByRole('region', { name: 'Aprovações do bot' });
  await expect(section.getByText(SEND_EMAIL)).toBeVisible();
  const group = section.getByRole('radiogroup', { name: 'Regra do bot para Send Email · Gmail' });
  await expect(group.getByRole('radio', { name: 'Permitir' })).toBeChecked();
  await group.getByRole('radio', { name: 'Permitir' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(group.getByRole('radio', { name: 'Perguntar' })).toBeChecked();
  await expect(page.getByText('Regra de Send Email · Gmail: Perguntar')).toBeVisible();
  await expectNoA11yViolations(page);
  await section.getByRole('button', { name: 'Remover regra de Send Email · Gmail' }).click();
  await expect(section.getByText('Este bot segue as regras globais.')).toBeVisible();
  expect(problems).toEqual([]);
});

test('a tela Aprovações agrupa as ações por app, mostra os bots com regra própria e altera a regra global', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  await prepare(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  // Dois apps: o Gmail (já visto) e o GitHub, visto agora por um pedido que o dono nega.
  const reader = await createBot(page, 'Leitor', '#F472B6');
  await sendViaApi(page, reader, '[github] abra uma issue');
  await respondViaApi(page, await pendingApprovalId(page, reader), 'deny');
  // Dois bots com regra própria para a mesma ação.
  const headers = await apiHeaders(page);
  const alpha = await createBot(page, 'Alfa', '#FB923C');
  const beta = await createBot(page, 'Beta', '#818CF8');
  for (const [id, value] of [[alpha, 'allow'], [beta, 'deny']] as const) {
    // A ação precisa constar como vista: o bot a usa uma vez e a resposta fica pendente até o dono decidir (aqui, negada).
    await sendViaApi(page, id, '[gmail] vê a ação');
    await respondViaApi(page, await pendingApprovalId(page, id), 'deny');
    const rule = await page.context().request.put(`${ORIGIN}/api/bots/${id}/approval-rules/${SEND_EMAIL}`, { headers, data: { value } });
    expect(rule.status()).toBe(200);
  }

  await page.goto('/bots');
  await page.getByRole('link', { name: 'Aprovações', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Aprovações', level: 1 })).toBeVisible();
  await expect(page.getByText('A regra do bot sempre prevalece. Neutro deixa cada bot decidir.')).toBeVisible();
  // O título está dentro da mesma coluna do conteúdo (alinhado à esquerda dela), e não na borda da tela.
  const titleBox = await page.getByRole('heading', { name: 'Aprovações', level: 1 }).boundingBox();
  const searchBox = await page.getByRole('textbox', { name: 'Buscar ação' }).boundingBox();
  expect(Math.abs((titleBox?.x ?? 0) - (searchBox?.x ?? 999)), 'alinhamento do título com a coluna').toBeLessThanOrEqual(2);
  await expect(page.getByRole('heading', { name: 'Gmail', level: 3 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'GitHub', level: 3 })).toBeVisible();
  const row = page.getByRole('listitem').filter({ hasText: SEND_EMAIL });
  await expect(row).toContainText('Send Email · Gmail');
  // "Regra própria em:" com um marcador por bot e a regra de cada um no nome acessível.
  await expect(row.getByText('Regra própria em:')).toBeVisible();
  await expect(row.getByRole('img', { name: `${uniqueBotName('Alfa')}: Permitir` })).toBeVisible();
  await expect(row.getByRole('img', { name: `${uniqueBotName('Beta')}: Negar` })).toBeVisible();
  // O marcador de cada bot é a Faísca dele a 24 px (o piso), parada e decorativa, na cor do bot; a inicial de 20 px saiu daqui.
  const alphaMarker = row.getByRole('img', { name: `${uniqueBotName('Alfa')}: Permitir` });
  await expect(row.locator('svg.faisca')).toHaveCount(2);
  await expect(alphaMarker.locator('span[aria-hidden="true"]')).toHaveCount(0);
  expect(await faiscaLook(alphaMarker.locator('svg.faisca'))).toMatchObject({ size: [24, 24], still: true, decorative: true, body: '#FB923C', detail: 'small' });
  await row.getByRole('img', { name: `${uniqueBotName('Alfa')}: Permitir` }).hover();
  await expect(page.getByRole('tooltip').getByText(`${uniqueBotName('Alfa')}: Permitir`)).toBeVisible();
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'aprovacoes-1440');

  // Controle segmentado: a regra global muda com clique e com as setas; o servidor confirma por toast.
  const control = row.getByRole('radiogroup', { name: 'Regra global de Send Email · Gmail' });
  await expect(control.getByRole('radio', { name: 'Neutro' })).toBeChecked();
  await control.getByRole('radio', { name: 'Negar' }).click();
  await expect(control.getByRole('radio', { name: 'Negar' })).toBeChecked();
  await expect(page.getByText('Regra de Send Email · Gmail: Negar')).toBeVisible();
  await control.getByRole('radio', { name: 'Negar' }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(control.getByRole('radio', { name: 'Perguntar' })).toBeChecked();

  // Busca por nome ou app, sem se importar com maiúsculas.
  await page.getByRole('textbox', { name: 'Buscar ação' }).fill('ISSUE');
  await expect(page.getByRole('heading', { name: 'GitHub', level: 3 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Gmail', level: 3 })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Buscar ação' }).fill('nada disso existe');
  await expect(page.getByText(/Nenhuma ação encontrada/)).toBeVisible();
  await page.getByRole('textbox', { name: 'Buscar ação' }).fill('');

  // 375 px: o controle vai para a linha de baixo, sem rolagem horizontal.
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByRole('heading', { name: 'Gmail', level: 3 })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'aprovacoes-375');
  expect(problems).toEqual([]);
});

test('a tela Aprovações já lista as ações que nenhum bot usou e a regra pode ser definida antes do primeiro uso (T25)', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  await prepare(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/aprovacoes');
  await expect(page.getByRole('heading', { name: 'Aprovações', level: 1 })).toBeVisible();
  // Nenhum teste deste projeto usa GMAIL_FETCH_EMAILS: a ação só consta porque o catálogo do Composio é registrado ao abrir a tela.
  const row = page.getByRole('listitem').filter({ hasText: 'GMAIL_FETCH_EMAILS' });
  await expect(row).toContainText('Fetch Emails · Gmail');
  const control = row.getByRole('radiogroup', { name: 'Regra global de Fetch Emails · Gmail' });
  await expect(control.getByRole('radio', { name: 'Neutro' })).toBeChecked();
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'aprovacoes-catalogo-1440');

  // Definir a regra antes do primeiro uso: o servidor confirma por toast e a regra sobrevive a reabrir a tela.
  await control.getByRole('radio', { name: 'Permitir' }).click();
  await expect(page.getByText('Regra de Fetch Emails · Gmail: Permitir')).toBeVisible();
  await page.reload();
  await expect(control.getByRole('radio', { name: 'Permitir' })).toBeChecked();
  await control.getByRole('radio', { name: 'Neutro' }).click(); // devolve ao estado de partida dos demais testes
  await expect(page.getByText('Regra de Fetch Emails · Gmail: Neutro')).toBeVisible();
  expect(problems).toEqual([]);
});

test('o conector por níveis: buscar ações aparece como atividade e não pede aprovação; um slug inexistente falha com o motivo (T29)', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  await prepare(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const botId = await createBot(page, 'Explorador');
  await page.goto(`/bots/${botId}`);
  const conversation = page.getByRole('log', { name: 'Conversa' });

  // Buscar: a atividade diz o que foi procurado, mostra as ações e os parâmetros ao expandir, e nenhum cartão de aprovação aparece.
  await send(page, '[composio-buscar:gmail|send email] como envio e-mail?');
  const search = conversation.getByRole('button', { name: 'Procurou ações em Gmail: send email' });
  await openWorkLine(conversation, search);
  await expect(search).toBeVisible();
  await expect(conversation.getByText(/Encontrei: Ações de Gmail \(gmail\) para "send email"/)).toBeVisible();
  await search.click();
  await expect(conversation.getByText('composio_search_actions', { exact: true })).toBeVisible(); // o nome técnico, distinto da orientação no resultado
  await expect(conversation.getByText(/1\. GMAIL_SEND_EMAIL — Send Email/)).toBeVisible();
  await expect(conversation.getByText(/- to \(string, obrigatório\)/)).toBeVisible();
  await expect(pendingCard(page)).toHaveCount(0);
  await expect(page.getByTestId('approvals-badge')).toHaveCount(0);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'conector-busca-1440');

  // Slug que não existe no catálogo: a atividade falha (nada executa nem pergunta) e o motivo aparece para o dono.
  await send(page, '[composio-desconhecida] execute algo');
  const unknown = conversation.getByRole('button', { name: /ACAO_QUE_NAO_EXISTE/ });
  await openWorkLine(conversation, unknown);
  await expect(unknown).toBeVisible();
  await unknown.click();
  // A16 e A21: a falha chega ao modelo no envelope único {code, message}; o dono lê só a mensagem no bloco Resultado (sem o JSON cru), que cita o slug e o caminho certo.
  const result = conversation.locator('pre', { hasText: 'Ação desconhecida: ACAO_QUE_NAO_EXISTE. Busque com composio_search_actions e use o slug exato.' }).first();
  await expect(result).toBeVisible();
  await expect(result).not.toContainText('ACTION_NOT_FOUND');
  await expect(pendingCard(page)).toHaveCount(0);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'conector-desconhecida-1440');
  expect(problems).toEqual([]);
});

test('parar a execução que espera cancela o pedido: o cartão fica cancelado e a execução, interrompida', async ({ page }) => {
  const problems = watchPage(page);
  await prepare(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const botId = await createBot(page, 'Impaciente');
  await page.goto(`/bots/${botId}`);
  await send(page, '[gmail] vou parar');
  await expect(pendingCard(page)).toBeVisible();
  await page.getByRole('button', { name: 'Parar execução' }).click();
  await expect(answeredCard(page)).toContainText('Cancelada');
  await expect(page.getByRole('region', { name: 'Execução interrompida' })).toBeVisible();
  await expect(headerBadge(page)).toHaveCount(0);
  await expect(page.getByTestId('approvals-badge')).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('o badge conta as pendências de todos os bots e o cartão cabe em 375 px', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  await prepare(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const bots = [await createBot(page, 'Um'), await createBot(page, 'Dois', '#2DD4BF'), await createBot(page, 'Três', '#A78BFA')];
  for (const id of bots) await sendViaApi(page, id, '[gmail] pendente');
  for (const id of bots) await pendingApprovalId(page, id);

  await page.goto('/bots');
  // /bots abre a conversa de um bot: espera ela aparecer (com os cartões já entrando) antes do axe.
  await expect(page.getByRole('log', { name: 'Conversa' })).toBeVisible();
  await expect(page.getByTestId('approvals-badge')).toHaveText('3');
  await expect(page.getByRole('link', { name: 'Aprovações, 3 pendentes' })).toBeVisible();
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'badge-3-pendencias-1440');

  // Aprovações (phase 5, T4): "Aguardando você" NO TOPO, com as 3 pendências (uma por bot), acima das regras globais; cada item abre a conversa do bot já no cartão.
  await page.goto('/aprovacoes');
  const waiting = page.getByRole('region', { name: 'Aguardando você' });
  await expect(waiting.getByRole('link')).toHaveCount(3);
  for (const name of ['Um', 'Dois', 'Três']) await expect(waiting.getByRole('link').filter({ hasText: uniqueBotName(name) })).toContainText('Send Email');
  const waitingBox = (await waiting.boundingBox())!;
  const rulesTitleBox = (await page.getByRole('heading', { level: 2, name: 'Regras globais' }).boundingBox())!;
  expect(waitingBox.y + waitingBox.height, '"Aguardando você" fica acima das regras globais').toBeLessThanOrEqual(rulesTitleBox.y);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'aprovacoes-aguardando-3-1440');
  await waiting.getByRole('link').filter({ hasText: uniqueBotName('Dois') }).click();
  await expect(page).toHaveURL(new RegExp(`/bots/${bots[1]}\\?mensagem=\\d+$`));
  const cardMessage = new URL(page.url()).searchParams.get('mensagem') ?? '';
  await expect(page.locator(`#message-${cardMessage}`).getByRole('region', { name: 'Aprovação pendente' })).toBeVisible();

  // Mobile: o cartão pendente cabe na tela, com os botões de texto visíveis e sem rolagem horizontal.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/bots/${bots[0]}`);
  const card = pendingCard(page);
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: 'Permitir uma vez' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Negar', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Mais opções de resposta' })).toBeVisible();
  await expectPendingFaisca(card, '#60A5FA');
  // Layout (a quebra de uma letra por linha passa em axe e na rolagem horizontal): o texto tem largura de leitura e as ações descem.
  const body = await card.getByText('Olá, segue o relatório.').boundingBox();
  expect(body?.width ?? 0, 'largura do texto do cartão').toBeGreaterThan(120);
  expect(body?.height ?? 999, 'altura do texto do cartão').toBeLessThan(60);
  const allow = await card.getByRole('button', { name: 'Permitir uma vez' }).boundingBox();
  expect(allow?.y ?? 0, 'os botões ficam abaixo do texto no mobile').toBeGreaterThan((body?.y ?? 0) + (body?.height ?? 0));
  // A Faísca continua à esquerda do corpo, na primeira linha do cartão, acima dos botões.
  const faiscaBox = await card.locator('svg.faisca').boundingBox();
  expect(faiscaBox!.x + faiscaBox!.width, 'a Faísca fica à esquerda do texto').toBeLessThanOrEqual(body!.x);
  expect(faiscaBox!.y + faiscaBox!.height, 'a Faísca fica acima dos botões').toBeLessThanOrEqual(allow!.y);
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'aprovacao-pendente-375');

  // Limpeza: encerra as pendências (nenhuma fica para os outros specs) e o badge some.
  const headers = await apiHeaders(page);
  for (const id of bots) await page.context().request.post(`${ORIGIN}/api/bots/${id}/runs/stop`, { headers });
  // A parada é assíncrona (o worker cancela os pedidos): espera o servidor zerar as pendências antes de olhar o badge, que só se
  // atualiza a cada 15 s ou quando algo avisa que mudou.
  await expect
    .poll(async () => ((await (await page.context().request.get(`${ORIGIN}/api/approvals/pending-count`, { headers })).json()) as { count: number }).count, { timeout: 20_000 })
    .toBe(0);
  await page.goto('/aprovacoes');
  await expect(page.getByRole('region', { name: 'Aguardando você' })).toContainText('Nada aguardando você.'); // sem pendências: o texto no lugar dos itens
  await expect(page.getByRole('region', { name: 'Aguardando você' }).getByRole('link')).toHaveCount(0);
  await page.goto('/bots');
  await expect(page.getByTestId('approvals-badge')).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('com mais de 6 parâmetros o cartão avisa dos omitidos (contagem e nomes), em 1440 e em 375 px', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  await prepare(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const botId = await createBot(page, 'Omitidos');
  await page.goto(`/bots/${botId}`);
  await send(page, '[gmail-muitos] envie com cópia');

  // O modelo mandou 8 parâmetros (o `bcc` na última posição): o cartão mostra 6 e NÃO esconde os outros 2 em silêncio.
  const card = pendingCard(page);
  await expect(card).toBeVisible();
  await expect(card).toContainText('thread_id');
  const notice = card.getByText('+2 parâmetros não exibidos: labels, bcc');
  await expect(notice).toBeVisible();
  await expect(card).not.toContainText('oculto@example.com'); // só o nome do omitido aparece, não o valor
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'aprovacao-omitidos-1440');

  // Mobile: o aviso quebra linha dentro do cartão, sem rolagem horizontal.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/bots/${botId}`);
  await expect(pendingCard(page)).toBeVisible();
  await expect(notice).toBeVisible();
  const box = await notice.boundingBox();
  expect(box?.x ?? -1, 'o aviso começa dentro da tela').toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 999), 'o aviso termina dentro da tela').toBeLessThanOrEqual(375);
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'aprovacao-omitidos-375');

  // Limpeza: nega (nenhuma pendência fica para os outros testes).
  await pendingCard(page).getByRole('button', { name: 'Negar', exact: true }).click();
  await expect(answeredCard(page)).toContainText('Negada');
  expect(problems).toEqual([]);
});

test('um modelo "sem ferramentas" executa sem as ações do Composio e o cartão avisa o dono', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  await prepare(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const botId = await createBot(page, 'Sem ferramentas', '#9CA3AF', 'opencode/glm-5.3-flash');
  await page.goto(`/bots/${botId}`);
  await send(page, 'oi');
  const notice = page.getByRole('region', { name: 'Modelo sem ferramentas' });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('opencode/glm-5.3-flash');
  await expect(notice).toContainText('segue sem as ações do Composio');
  await expect(page.getByRole('log', { name: 'Conversa' }).getByText(/Resposta:/)).toBeVisible(); // a execução concluiu normalmente
  await expect(pendingCard(page)).toHaveCount(0);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'modelo-sem-ferramentas-1440');

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(notice).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'modelo-sem-ferramentas-375');
  expect(problems).toEqual([]);
});

test('responder depois do prazo (APPROVAL_EXPIRED) mostra o cartão como expirado e avisa por toast', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  await prepare(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const botId = await createBot(page, 'Atrasado', '#FB923C');
  await page.goto(`/bots/${botId}`);
  await send(page, '[gmail] tarde demais');
  await expect(pendingCard(page)).toBeVisible();
  // O prazo de 24 h não cabe num E2E: o servidor é simulado na rede do navegador, que é exatamente o que a tela trata (a regra de
  // expiração em si está provada nos testes do núcleo e da API).
  await page.route('**/api/approvals/*/respond', (route) =>
    route.fulfill({ status: 410, contentType: 'application/json', body: JSON.stringify({ code: 'APPROVAL_EXPIRED', message: 'Esta aprovação expirou.' }) }),
  );
  await pendingCard(page).getByRole('button', { name: 'Permitir uma vez' }).click();
  await expect(answeredCard(page)).toContainText('Expirada');
  await expect(pendingCard(page)).toHaveCount(0);
  await expect(page.getByText('Esta aprovação expirou.')).toBeVisible();
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'aprovacao-expirada-1440');

  // Limpeza: a execução real segue pausada no servidor; encerra para não deixar pendência.
  await page.unroute('**/api/approvals/*/respond');
  await page.context().request.post(`${ORIGIN}/api/bots/${botId}/runs/stop`, { headers: await apiHeaders(page) });
  expect(problems.filter((problem) => !problem.includes('410 POST'))).toEqual([]);
});

test('"tudo" (F12, T18): Aprovações e o editor do bot aplicam a regra a TODAS as ações conhecidas (a busca e a lista do bot não restringem) e só "Permitir tudo" pede confirmação', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  await prepare(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const botId = await createBot(page, 'Em lote', '#4ADE80');

  // Tela Aprovações: o total de ações conhecidas é o das linhas da lista; o lote vale para todas, mesmo com a busca filtrando.
  await page.goto('/aprovacoes');
  await expect(page.getByRole('heading', { name: 'Aprovações', level: 1 })).toBeVisible();
  const rows = page.getByRole('radiogroup', { name: /^Regra global de / });
  await expect(rows.first()).toBeVisible();
  const total = await rows.count();
  expect(total, 'o catálogo do Composio falso traz mais de uma ação').toBeGreaterThan(1);
  const group = page.getByRole('group', { name: 'Todas as ações' });
  const checked = (name: string) => page.getByRole('radio', { name, checked: true });
  await expect(group.getByRole('button')).toHaveText(['Permitir tudo', 'Perguntar tudo', 'Negar tudo', 'Neutro tudo']);

  await page.getByRole('textbox', { name: 'Buscar ação' }).fill('ISSUE'); // só uma parte da lista aparece
  await expect(rows).not.toHaveCount(total);
  await group.getByRole('button', { name: 'Negar tudo' }).click(); // aplica na hora, sem confirmação
  await expect(page.getByText(`Regra de todas as ${total} ações: Negar`)).toBeVisible();
  await page.getByRole('textbox', { name: 'Buscar ação' }).fill('');
  await expect(rows).toHaveCount(total);
  await expect(page.getByRole('radio', { name: 'Negar', checked: true })).toHaveCount(total); // inclusive as que a busca escondia

  // "Permitir tudo" pede confirmação: o foco inicial é "Cancelar", e cancelar não altera nada.
  await group.getByRole('button', { name: 'Permitir tudo' }).click();
  const dialog = page.getByRole('dialog', { name: 'Permitir tudo?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`As ${total} ações conhecidas passam a ser permitidas sem pedir aprovação`);
  await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused();
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'aprovacoes-permitir-tudo-confirmacao-1440');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('radio', { name: 'Negar', checked: true })).toHaveCount(total);
  await group.getByRole('button', { name: 'Permitir tudo' }).click();
  await dialog.getByRole('button', { name: 'Permitir tudo' }).click();
  await expect(page.getByText(`Regra de todas as ${total} ações: Permitir`)).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Permitir', checked: true })).toHaveCount(total);
  await attachShot(page, testInfo, 'aprovacoes-tudo-1440');
  await group.getByRole('button', { name: 'Perguntar tudo' }).click();
  await expect(page.getByRole('radio', { name: 'Perguntar', checked: true })).toHaveCount(total);
  await group.getByRole('button', { name: 'Neutro tudo' }).click();
  await expect(page.getByRole('radio', { name: 'Neutro', checked: true })).toHaveCount(total); // deixa tudo neutro para os outros testes
  await page.reload();
  await expect(checked('Neutro')).toHaveCount(total); // o servidor guardou

  // Editor do bot: sem regra nenhuma o lote cria a regra própria em TODAS as ações, que a lista passa a mostrar; "Neutro tudo" remove todas.
  await page.goto(`/bots/${botId}/editar`);
  const section = page.getByRole('region', { name: 'Aprovações do bot' });
  await expect(section.getByText('Este bot segue as regras globais.')).toBeVisible();
  const botGroup = section.getByRole('group', { name: 'Todas as ações' });
  await expect(botGroup.getByRole('button')).toHaveText(['Permitir tudo', 'Perguntar tudo', 'Negar tudo', 'Neutro tudo']);
  const botRows = section.getByRole('radiogroup', { name: /^Regra do bot para / });
  await botGroup.getByRole('button', { name: 'Perguntar tudo' }).click();
  await expect(page.getByText('Regra de todas as ações: Perguntar')).toBeVisible();
  await expect(botRows).toHaveCount(total);
  await expect(section.getByRole('radio', { name: 'Perguntar', checked: true })).toHaveCount(total);
  await botGroup.getByRole('button', { name: 'Permitir tudo' }).click();
  await expect(page.getByRole('dialog', { name: 'Permitir tudo?' })).toContainText('Este bot passa a executar todas as ações conhecidas sem pedir aprovação');
  await page.getByRole('dialog', { name: 'Permitir tudo?' }).getByRole('button', { name: 'Permitir tudo' }).click();
  await expect(section.getByRole('radio', { name: 'Permitir', checked: true })).toHaveCount(total);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'editor-bot-tudo-1440');
  // A tela Aprovações mostra o bot com regra própria em todas as ações (e a Faísca dele), e o "Neutro tudo" do bot as remove.
  await page.goto('/aprovacoes');
  await expect(page.getByText('Regra própria em:')).toHaveCount(total);
  await page.goto(`/bots/${botId}/editar`);
  await section.getByRole('button', { name: 'Neutro tudo' }).click();
  await expect(page.getByText('Regras do bot removidas: vale a global')).toBeVisible();
  await expect(section.getByText('Este bot segue as regras globais.')).toBeVisible();
  await expect(botRows).toHaveCount(0);

  // 375 px: os quatro botões em duas colunas, sem rolagem horizontal, com área de toque de 40 px.
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalScroll(page);
  const heights = await section.getByRole('group', { name: 'Todas as ações' }).getByRole('button').evaluateAll((buttons) => buttons.map((button) => Math.round(button.getBoundingClientRect().height)));
  expect(heights).toEqual([40, 40, 40, 40]);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'editor-bot-tudo-375');
  await page.goto('/aprovacoes');
  await expect(page.getByRole('group', { name: 'Todas as ações' })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'aprovacoes-tudo-375');
  expect(problems).toEqual([]);
});

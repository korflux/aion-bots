// E2E do chat geral temporário (T12; A15; F16) no navegador real, contra a pilha de produção (Postgres, API, worker, Next e proxy) com o
// OpenCode Go e o Composio FALSOS. Marcadores do modelo falso: [gmail] pede aprovação (só num bot: o Chat geral não tem mais conector, phase 13, A6), [demorar] roda até o dono parar
// (ver packages/core/src/testing/fake-upstreams.ts). A aprovação PENDENTE do Chat geral, que o dono ainda pode responder depois do deploy (A7), vem do controle da pilha
// (`/seed-legacy-connector-approval`), porque nenhuma mensagem a cria mais.
//
// Cobre: a entrada em /chat que já abre um "Novo chat" (rascunho vazio, fora do painel, reaproveitado até a primeira mensagem), o título gerado pela primeira mensagem, a conversa pelo
// mesmo motor (resposta em streaming, seletor de modelo), as seções "Salvos" e "Recentes" com o aviso único da retenção e o relógio da sessão a menos de 1 dia de ser apagada, o toggle "Salvar" (com
// o aviso ao desligar), a Faísca do Aion em `--faisca` nas cinco posições (cabeçalho, respostas, vazio, "Trabalhando…" e cartões; phase 5, A2), o cartão de aprovação REDUZIDO (só "Permitir uma vez" e "Negar", sem o menu de "sempre"), a execução do chat geral
// em Atividades (nome "Chat geral", clique até o cartão, "Parar") e a tela "Esta sessão expirou" depois que a retenção apaga a sessão. O job
// de retenção em si (datas simuladas) está provado em @aion/core e o agendamento no worker; aqui a retenção roda pelo controle da pilha, com
// o relógio adiantado. axe em cada estado e o layout em 1440 e 375 px.
//
// As sessões, as execuções e a chave do Composio são estado global (Atividades lista tudo), então o arquivo é serial, roda no projeto
// `chromium-general-chat` depois dos demais e os títulos das sessões são exclusivos ("Cg ...").
//
// Cada `apiHeaders` faz um login NOVO (troca o cookie do contexto), e o token CSRF da tela pertence à sessão com que ela carregou. Por isso
// `setup` entra UMA vez, antes de qualquer `goto`, e todas as chamadas à API do teste reaproveitam esses cabeçalhos: um login no meio do
// teste deixaria a tela com um token que não é mais o da sessão (CSRF_TOKEN_INVALID).
import type { Locator, Page, Response, TestInfo } from '@playwright/test';
import { E2E_PORTS } from '../../../tests/support/e2e-env';
import {
  AION_BODY,
  CLIENT_IP_HEADER,
  ORIGIN,
  apiHeaders,
  apiLogin,
  attachShot,
  backLink,
  clientIpFor,
  ensureCredential,
  expect,
  expectNoA11yViolations,
  expectNoHorizontalScroll,
  expectWorkingLineAtTop,
  LONG_HISTORY_MESSAGE,
  faiscaLook,
  runningAnimations,
  tabBarOf,
  tabOf,
  test,
  uniqueBotName,
  watchPage,
} from './support/fixtures';

test.describe.configure({ mode: 'serial' });

const FAKE_PROVIDER = 'valid-e2e-chat-geral-1111';
const FAKE_CONNECTOR = 'valid-e2e-composio-3333';
const MODEL = 'opencode/glm-5.1';

let credentialsSeeded = false;

interface SessionInfo {
  id: string;
  title: string | null;
  saved: boolean;
  expiresAt: string | null;
}

/** Chamadas à API do teste, com os cabeçalhos (cookie, Origin e CSRF) de UM login feito antes de a tela carregar. */
interface Api {
  headers: Record<string, string>;
  createSession(): Promise<SessionInfo>;
  send(sessionId: string, content: string): Promise<string>;
  sessionOf(id: string): Promise<SessionInfo>;
  /** Ids da lista de sessões que o painel recebe (o rascunho vazio não vem nela). */
  listedIds(): Promise<string[]>;
  /** O modelo e o effort padrão do Chat geral (T23); `model` nulo enquanto não foi definido. */
  chatDefault(): Promise<{ model: string | null; effort: string | null }>;
  pendingApprovalOf(runId: string): Promise<string | undefined>;
  runStatus(runId: string): Promise<string | undefined>;
  waitForRun(runId: string, status: string): Promise<void>;
  /**
   * Deixa na sessão a aprovação pendente de uma ação do conector, como a phase 12 a gravava (controle da pilha): o Chat geral não tem conector, então nenhuma mensagem a cria (A6) e só a
   * pendência de antes do deploy existe (A7). Devolve a execução (em `waiting_approval`) e o pedido.
   */
  seedLegacyApproval(sessionId: string, input: string): Promise<{ runId: string; approvalId: string }>;
  /** Quantas execuções de ação o Composio falso recebeu até agora (controle da pilha). */
  composioExecutions(): Promise<number>;
  /** A atividade da ferramenta na sessão (estado e resultado resumido), ou nada se ela não existe. */
  activityOf(sessionId: string, tool: string): Promise<{ status: string; result: string | null } | undefined>;
}

/** Provedor e Composio conectados (a chave do Composio é trocada na primeira vez: o spec de chaves a deixa sem apps), e UM login para o teste. */
async function setup(page: Page): Promise<Api> {
  const replace = !credentialsSeeded;
  await ensureCredential(page, 'provider', FAKE_PROVIDER, { replace });
  await ensureCredential(page, 'connector', FAKE_CONNECTOR, { replace });
  credentialsSeeded = true;
  const headers = await apiHeaders(page);
  const request = page.context().request;

  const activities = async () =>
    (await (await request.get(`${ORIGIN}/api/activities`, { headers })).json()) as {
      pending: { runId: string; approvalId: string }[];
      items: { runId: string; status: string }[];
    };
  const api: Api = {
    headers,
    async createSession() {
      const created = await request.post(`${ORIGIN}/api/chat/sessions`, { headers });
      expect(created.status(), 'criar a sessão').toBe(201);
      const session = (await created.json()) as SessionInfo;
      // Uma sessão não tem padrão de bot e o ambiente não tem favoritos: o modelo é escolhido como o dono faria no composer.
      const preference = await request.patch(`${ORIGIN}/api/chat/sessions/${session.id}/conversation`, { headers, data: { model: MODEL, effort: null } });
      expect(preference.status(), 'escolher o modelo').toBe(200);
      return session;
    },
    async send(sessionId, content) {
      const response = await request.post(`${ORIGIN}/api/chat/sessions/${sessionId}/messages`, { headers, data: { content } });
      expect(response.status(), 'enviar pela API').toBe(201);
      return ((await response.json()) as { id: string }).id;
    },
    async sessionOf(id) {
      const response = await request.get(`${ORIGIN}/api/chat/sessions/${id}`, { headers });
      expect(response.status(), 'ler a sessão').toBe(200);
      return (await response.json()) as SessionInfo;
    },
    async chatDefault() {
      const response = await request.get(`${ORIGIN}/api/chat/settings`, { headers });
      expect(response.status(), 'ler o padrão do chat').toBe(200);
      return (await response.json()) as { model: string | null; effort: string | null };
    },
    async listedIds() {
      const response = await request.get(`${ORIGIN}/api/chat/sessions`, { headers });
      expect(response.status(), 'listar as sessões').toBe(200);
      return ((await response.json()) as { items: { id: string }[] }).items.map((item) => item.id);
    },
    async pendingApprovalOf(runId) {
      return (await activities()).pending.find((item) => item.runId === runId)?.approvalId;
    },
    // As execuções do teste são as mais novas, então estão na primeira página de Atividades.
    async runStatus(runId) {
      return (await activities()).items.find((item) => item.runId === runId)?.status;
    },
    async waitForRun(runId, status) {
      await expect.poll(() => api.runStatus(runId), { timeout: 30_000 }).toBe(status);
    },
    async seedLegacyApproval(sessionId, input) {
      const seeded = await fetch(`http://127.0.0.1:${E2E_PORTS.control}/seed-legacy-connector-approval?${new URLSearchParams({ sessionId, input })}`, { method: 'POST' });
      expect(seeded.status, 'semear a aprovação pendente antiga pelo controle da pilha').toBe(200);
      return (await seeded.json()) as { runId: string; approvalId: string };
    },
    async composioExecutions() {
      const counted = await fetch(`http://127.0.0.1:${E2E_PORTS.control}/composio-executions`);
      expect(counted.status, 'contar as execuções do Composio falso pelo controle da pilha').toBe(200);
      return ((await counted.json()) as { executions: number }).executions;
    },
    async activityOf(sessionId, tool) {
      const response = await request.get(`${ORIGIN}/api/chat/sessions/${sessionId}/conversation`, { headers });
      expect(response.status(), 'ler a conversa da sessão').toBe(200);
      const items = ((await response.json()) as { items: { kind: string; tool?: string; status: string; result?: string | null }[] }).items;
      const found = items.find((item) => item.kind === 'activity' && item.tool === tool);
      return found ? { status: found.status, result: found.result ?? null } : undefined;
    },
  };
  return api;
}

const panel = (page: Page) => page.getByRole('complementary');
const sessionLink = (page: Page, title: string) => panel(page).getByRole('link').filter({ hasText: title });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Mensagem' });
const content = (page: Page) => page.locator('#conteudo');

/** Escreve e envia pela tela. */
async function typeAndSend(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await page.getByRole('button', { name: 'Enviar mensagem' }).click();
}

test('entrar no chat geral já abre um "Novo chat" vazio, sem clique extra e sem deixar sessão vazia no painel; a primeira mensagem dá o título, põe a sessão no painel e a resposta chega pelo mesmo motor', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  const api = await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/chat');

  // Sem clique: /chat troca a URL pelo chat novo (e o Voltar não reabre /chat para ser redirecionado de novo).
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
  const id = new URL(page.url()).pathname.split('/').pop() as string;
  await expect(page.getByRole('heading', { level: 2, name: 'No que posso ajudar?' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Novo chat' })).toBeVisible();
  // O Chat geral é o próprio Aion: a Faísca em `--faisca` (azul de marca) no cabeçalho (32 px) e na conversa vazia (112 px, com a entrada), e nenhum marcador de chat.
  await expect(page.locator('svg.faisca')).toHaveCount(2);
  expect(await faiscaLook(page.getByRole('main').locator('header').first().locator('svg.faisca'))).toMatchObject({ state: 'idle', detail: 'small', still: true, decorative: true, size: [32, 32], body: AION_BODY });
  const emptyFaisca = page.getByRole('log', { name: 'Conversa' }).locator('svg.faisca');
  expect(await faiscaLook(emptyFaisca)).toMatchObject({ state: 'idle', detail: 'full', still: true, decorative: true, size: [112, 112], body: AION_BODY });
  await expect(emptyFaisca).toHaveAttribute('data-enter', '');
  await expect(page.getByRole('log', { name: 'Conversa' }).locator('[data-icon="MessageSquare"]')).toHaveCount(0);
  // T23: sem modelo padrão do Chat geral (nem favorito que valha) o chat não deixa conversar: faixa que leva a Configurações e campo bloqueado.
  await expect(content(page).getByText('Defina o modelo padrão do Chat geral para conversar.').first()).toBeVisible();
  await expect(content(page).getByRole('link', { name: 'Abrir Preferências' })).toHaveAttribute('href', '/configuracoes/preferencias');
  await expect(composer(page)).toBeDisabled();
  await expect(composer(page)).toHaveAttribute('placeholder', 'Defina o modelo padrão do Chat geral para conversar.');
  await expect(page.getByRole('button', { name: 'Salvar', exact: true })).toHaveCount(0);
  // O rascunho não é uma sessão guardada: não aparece no painel nem na API de listagem.
  await expect(panel(page).getByRole('link').filter({ hasText: 'Novo chat' })).toHaveCount(0);
  expect(await api.listedIds()).not.toContain(id);
  await attachShot(page, testInfo, 'chat-geral-novo-1440');

  // Entrar de novo, ou pedir "Novo chat" sem ter escrito nada, devolve o MESMO chat: nada se acumula.
  await page.goto('/chat');
  await expect(page).toHaveURL(new RegExp(`/chat/${id}$`));
  await panel(page).getByRole('button', { name: 'Novo chat' }).click();
  await expect(page).toHaveURL(new RegExp(`/chat/${id}$`));
  expect(await api.listedIds()).not.toContain(id);

  // Escolher o modelo (a preferência fica nesta conversa) e conferir o layout em 375 px.
  const preference = await page.context().request.patch(`${ORIGIN}/api/chat/sessions/${id}/conversation`, { headers: api.headers, data: { model: MODEL, effort: null } });
  expect(preference.status()).toBe(200);
  await page.reload();
  await expect(page.getByRole('button', { name: MODEL })).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'chat-geral-novo-375');
  await page.setViewportSize({ width: 1440, height: 900 });

  await typeAndSend(page, 'Cg primeira conversa: preciso de um resumo da semana');
  await expect(page.getByRole('log', { name: 'Conversa' })).toContainText('Resposta: Cg primeira conversa');
  // A resposta não tem Faísca ao lado (phase 18, UI-07): a única Faísca do Aion que trabalha é a da linha fixa acima do composer.
  await expect(page.getByRole('log', { name: 'Conversa' }).locator('[data-bot-marker]')).toHaveCount(0);
  await expect(page.getByRole('log', { name: 'Conversa' }).locator('svg.faisca')).toHaveCount(0);
  // O título nasce da primeira mensagem (cabeçalho e painel), a sessão entra no painel só agora, sob "Recentes" com o aviso único dos 7 dias e sem relógio (falta mais de 1 dia), e o "Salvar" passa a existir.
  await expect(page.getByRole('heading', { level: 1, name: 'Cg primeira conversa: preciso de um resumo da semana' })).toBeVisible();
  const entry = sessionLink(page, 'Cg primeira conversa');
  await expect(panel(page).getByText('Apagados 7 dias após a última mensagem')).toHaveCount(1);
  await expect(panel(page).getByRole('heading', { name: 'Recentes' })).toBeVisible();
  await expect(panel(page).getByRole('button', { name: /^Apaga em/ })).toHaveCount(0);
  await expect(entry).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: 'Salvar', exact: true })).toBeVisible();
  expect((await api.sessionOf(id)).title).toBe('Cg primeira conversa: preciso de um resumo da semana');
  expect(await api.listedIds()).toContain(id);

  // Depois da primeira mensagem o chat deixa de ser rascunho: "Novo chat" abre OUTRO, vazio.
  await panel(page).getByRole('button', { name: 'Novo chat' }).click();
  await expect(page).not.toHaveURL(new RegExp(`/chat/${id}$`));
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Novo chat' })).toBeVisible();
  await expect(entry).toBeVisible();
  await expectNoA11yViolations(page);
  expect(problems).toEqual([]);
});

test('o modelo padrão do Chat geral é obrigatório: sem ele o chat leva a Configurações; definido, todo chat novo já nasce com ele e a troca dentro do chat não o altera (T23)', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  const api = await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(await api.chatDefault(), 'o ambiente começa sem padrão').toEqual({ model: null, effort: null, effortLevels: [] });

  // Sem padrão: o chat novo está bloqueado e a faixa leva à configuração.
  await page.goto('/chat');
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
  await expect(composer(page)).toBeDisabled();
  await content(page).getByRole('link', { name: 'Abrir Preferências' }).click();
  await expect(page).toHaveURL(/\/configuracoes\/preferencias$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Preferências' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Modelo do Chat geral' })).toBeVisible();
  await expect(page.getByText('Obrigatório', { exact: true }).first()).toBeVisible();
  const field = page.getByRole('button', { name: /^Modelo padrão/ });
  await expect(field).toHaveAccessibleName('Modelo padrão Escolher modelo');
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'chat-geral-configuracao-sem-padrao-1440');

  // O seletor é o mesmo dos bots, mas SEM a opção "sem modelo": o padrão é obrigatório. Escolher grava na hora (modelo e depois o effort).
  const picker = page.getByRole('dialog', { name: 'Selecionar modelo' });
  await field.click();
  await expect(picker.getByRole('list', { name: 'Modelos do OpenCode Go' })).toBeVisible();
  await expect(picker.getByText('Sem modelo padrão')).toHaveCount(0);
  await picker.getByRole('list', { name: 'Modelos do OpenCode Go' }).getByRole('button', { name: /^glm-5\.1( |$)/ }).click();
  // Grava ao escolher e mostra "Salvo" ao lado do título do cartão (região `aria-live`), sem botão Salvar.
  await expect(page.getByText('Salvo', { exact: true })).toBeVisible();
  await expect.poll(() => api.chatDefault(), { timeout: 30_000 }).toEqual({ model: MODEL, effort: null, effortLevels: ['low', 'medium', 'high'] });
  const slider = picker.getByRole('slider', { name: 'Effort' });
  await slider.focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuetext', 'Médio');
  await expect.poll(() => api.chatDefault()).toEqual({ model: MODEL, effort: 'medium', effortLevels: ['low', 'medium', 'high'] });
  await page.keyboard.press('Escape');
  await expect(field).toHaveAccessibleName('Modelo padrão opencode/glm-5.1 · Médio');
  await expect(page.getByText('Definido', { exact: true })).toBeVisible();
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'chat-geral-configuracao-1440');

  // Gravação que falha (resposta simulada): o erro aparece no campo, o valor escolhido é MANTIDO na tela e "Tentar de novo" grava.
  await page.route('**/api/chat/settings', (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'INTERNAL_ERROR', message: 'Erro interno. Tente novamente.' }) })
      : route.continue(),
  );
  await field.click();
  const failSlider = picker.getByRole('slider', { name: 'Effort' });
  await failSlider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(failSlider).toHaveAttribute('aria-valuetext', 'Alto');
  await page.keyboard.press('Escape');
  const saveError = page.getByRole('alert').filter({ hasText: 'Não foi possível salvar. Tente de novo.' });
  await expect(saveError).toBeVisible();
  await expect(field).toHaveAccessibleName('Modelo padrão opencode/glm-5.1 · Alto'); // o valor escolhido continua na tela
  expect((await api.chatDefault()).effort, 'nada foi gravado').toBe('medium');
  await attachShot(page, testInfo, 'chat-geral-configuracao-erro-1440');
  await page.unroute('**/api/chat/settings');
  await saveError.getByRole('button', { name: 'Tentar de novo' }).click();
  await expect(page.getByText('Salvo', { exact: true })).toBeVisible();
  await expect(saveError).toHaveCount(0);
  await expect.poll(async () => (await api.chatDefault()).effort).toBe('high');
  // Devolve o padrão que o resto do teste espera (Médio).
  await field.click();
  const backSlider = picker.getByRole('slider', { name: 'Effort' });
  await backSlider.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(backSlider).toHaveAttribute('aria-valuetext', 'Médio');
  await expect.poll(async () => (await api.chatDefault()).effort).toBe('medium');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'chat-geral-configuracao-375');
  await page.setViewportSize({ width: 1440, height: 900 });

  // Definido: o chat novo já nasce com o padrão, sem faixa e com o campo livre; a conversa funciona sem escolher nada.
  await page.goto('/chat');
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
  await expect(composer(page)).toBeEnabled();
  await expect(content(page).getByText('Defina o modelo padrão do Chat geral para conversar.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'opencode/glm-5.1', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Effort: Médio' })).toBeVisible();
  await typeAndSend(page, 'Cg com o padrão do chat');
  await expect(page.getByRole('log', { name: 'Conversa' })).toContainText('Resposta: Cg com o padrão do chat');

  // Trocar o effort DENTRO deste chat vale só para ele: o padrão continua em "Médio" e o próximo chat novo volta a nascer com ele.
  await page.getByRole('button', { name: 'Effort: Médio' }).click();
  const chatSlider = page.getByRole('dialog', { name: 'Effort', exact: true }).getByRole('slider', { name: 'Effort' });
  await chatSlider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(chatSlider).toHaveAttribute('aria-valuetext', 'Alto');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'opencode/glm-5.1', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Effort: Alto' })).toBeVisible();
  expect(await api.chatDefault()).toEqual({ model: MODEL, effort: 'medium', effortLevels: ['low', 'medium', 'high'] });
  await panel(page).getByRole('button', { name: 'Novo chat' }).click();
  await expect(page.getByRole('button', { name: 'opencode/glm-5.1', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Effort: Médio' })).toBeVisible();
  expect(problems).toEqual(['500 PUT /api/chat/settings']); // só o 500 simulado da gravação que falha (o erro no campo é esperado)
});

test('o painel lista a sessão temporária (sob "Recentes", com o aviso único) e a salva (sob "Salvos"), o toggle "Salvar" liga e desliga com o aviso, e o layout vale em 1440 e 375 px', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  const api = await setup(page);
  const temporary = await api.createSession();
  await api.waitForRun(await api.send(temporary.id, 'Cg sessão temporária de teste'), 'completed');
  const kept = await api.createSession();
  await api.waitForRun(await api.send(kept.id, 'Cg sessão para guardar'), 'completed');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/chat/${kept.id}`);
  await expect(page.getByRole('log', { name: 'Conversa' })).toContainText('Resposta: Cg sessão para guardar');
  // Antes de salvar: as duas aparecem como temporárias, sob "Recentes", com UM aviso da retenção e sem seção "Salvos".
  await expect(sessionLink(page, 'Cg sessão temporária de teste')).toBeVisible();
  await expect(sessionLink(page, 'Cg sessão para guardar')).toBeVisible();
  await expect(panel(page).getByText('Apagados 7 dias após a última mensagem')).toHaveCount(1);
  await expect(panel(page).getByRole('heading', { name: 'Salvos' })).toHaveCount(0);

  const toggle = page.getByRole('button', { name: 'Salvar', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(page.getByRole('button', { name: 'Salva', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Sessão salva: ela não será apagada.')).toBeVisible();
  // Salva: a sessão passa à seção "Salvos" (antes de "Recentes"), e a API deixa de dar data de expiração; a outra segue sob "Recentes" e o aviso continua único.
  await expect(panel(page).getByRole('heading', { name: 'Salvos' })).toBeVisible();
  await expect(sessionLink(page, 'Cg sessão para guardar')).toBeVisible();
  expect((await api.sessionOf(kept.id)).expiresAt).toBeNull();
  const order = await panel(page).getByRole('list', { name: 'Sessões' }).getByRole('listitem').allInnerTexts();
  const at = (match: (text: string) => boolean) => order.findIndex(match);
  expect(at((text) => text.trim() === 'Salvos')).toBeLessThan(at((text) => text.includes('Cg sessão para guardar')));
  expect(at((text) => text.includes('Cg sessão para guardar'))).toBeLessThan(at((text) => text.trim() === 'Recentes'));
  expect(at((text) => text.trim() === 'Recentes')).toBeLessThan(at((text) => text.includes('Cg sessão temporária de teste')));
  await expect(panel(page).getByText('Apagados 7 dias após a última mensagem')).toHaveCount(1);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'chat-geral-1440');

  // 375 px: a sessão não tem barra inferior; o cabeçalho cabe com "Voltar" e o menu "Mais ações do chat" (o "Salvar" do desktop vai para lá) e a página não rola na horizontal.
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(tabBarOf(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Salva', exact: true })).toBeHidden();
  await expect(backLink(page)).toHaveAttribute('href', '/chats');
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'chat-geral-375');
  // O menu traz a ação da sessão: desta, que está salva, "Remover dos salvos".
  await page.getByRole('button', { name: 'Mais ações do chat' }).click();
  await expect(page.getByRole('menuitem', { name: 'Remover dos salvos' })).toBeVisible();
  // Sem axe com o menu aberto (`aria-hidden-focus` do menu modal do kit, registrado em .erros-encontrados/2026-10-09-axe-aria-hidden-focus-com-menu-aberto-em-arquivos.md).
  await attachShot(page, testInfo, 'chat-geral-375-menu');
  await page.keyboard.press('Escape');
  // "Voltar" leva a Chats (o pai fixo), que lista as sessões na página, com a aba ativa, o "+" de novo chat e o aviso da retenção; escolher a sessão abre a conversa de novo.
  await backLink(page).click();
  await expect(page).toHaveURL(/\/chats$/);
  await expect(tabOf(page, 'Chats')).toHaveAttribute('aria-current', 'page');
  await expect(content(page).getByRole('button', { name: 'Novo chat' })).toBeVisible();
  await expect(content(page).getByRole('link').filter({ hasText: 'Cg sessão temporária de teste' })).toBeVisible();
  await expect(content(page).getByText('Apagados 7 dias após a última mensagem')).toHaveCount(1);
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'chats-375');
  await content(page).getByRole('link').filter({ hasText: 'Cg sessão para guardar' }).click();
  await expect(page).toHaveURL(new RegExp(`/chat/${kept.id}$`));

  // Desligar volta a contar os 7 dias a partir da última mensagem, com o aviso.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Salva', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Salvar', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByText('Sessão não salva: apaga em 7 dias.')).toBeVisible();
  expect((await api.sessionOf(kept.id)).expiresAt).not.toBeNull();
  expect(problems).toEqual([]);
});

test('a aprovação do chat geral mostra o cartão reduzido (só "Permitir uma vez" e "Negar"), vira pendência em Aprovações como "Chat geral" e "Parar" (em Atividade e arquivos) a encerra', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  const api = await setup(page);
  const session = await api.createSession();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/chat/${session.id}`);
  await expect(page.getByRole('heading', { level: 2, name: 'No que posso ajudar?' })).toBeVisible();

  // O Chat geral não tem conector (A6): nenhuma mensagem pede aprovação ali. O cartão que o dono ainda pode ter pendente de antes do deploy (A7) é semeado pelo controle da pilha e a
  // sessão é recarregada, para a tela vê-lo como na volta do dono ao app. O que o teste prova (cartão reduzido, pendência sem bot, "Parar") não depende de qual mensagem o criou.
  await api.seedLegacyApproval(session.id, '[gmail] Cg envie o relatório do mês');
  await page.reload();
  const card = page.getByRole('region', { name: 'Aprovação pendente' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Send Email');
  await expect(card.getByRole('button', { name: 'Permitir uma vez' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Negar' })).toBeVisible();
  // Sem bot não há onde gravar uma regra: o menu de "sempre" não existe.
  await expect(card.getByRole('button', { name: 'Mais opções de resposta' })).toHaveCount(0);
  // O cartão pendente leva a Faísca do Aion aguardando (32 px, em `--faisca`), a única que se mexe, no lugar do ícone de 14 px da legenda.
  await expect(card.locator('svg.faisca')).toHaveCount(1);
  expect(await faiscaLook(card.locator('svg.faisca'))).toMatchObject({ state: 'waiting', detail: 'small', still: false, decorative: true, size: [32, 32], body: AION_BODY });
  await expect(card.locator('[data-icon="ShieldCheck"]')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Aguardando aprovação' })).toBeVisible();
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'chat-geral-aprovacao-1440');
  // 375 px: o cartão reduzido continua inteiro, com as duas ações ao alcance, e a página não rola na horizontal.
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(card.getByRole('button', { name: 'Permitir uma vez' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Negar' })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'chat-geral-aprovacao-375');
  await page.setViewportSize({ width: 1440, height: 900 });

  // O pedido da sessão vira pendência em Aprovações ("Aguardando você"), sem bot, e o clique volta ao cartão dentro da sessão.
  await page.goto('/aprovacoes');
  const pending = page.getByRole('region', { name: 'Aguardando você' }).getByRole('link').filter({ hasText: 'Chat geral' });
  await expect(pending).toContainText('Send Email');
  // A linha da pendência leva a Faísca do Aion (24 px, parada, em `--faisca`) aguardando, no lugar do marcador de chat.
  expect(await faiscaLook(pending.locator('svg.faisca'))).toMatchObject({ state: 'waiting', detail: 'small', still: true, decorative: true, size: [24, 24], body: AION_BODY });
  await expect(pending.locator('[data-icon="MessageSquare"]')).toHaveCount(0);
  await pending.click();
  await expect(page).toHaveURL(new RegExp(`/chat/${session.id}\\?mensagem=\\d+$`));
  const messageId = new URL(page.url()).searchParams.get('mensagem') ?? '';
  await expect(page.locator(`#message-${messageId}`).getByRole('region', { name: 'Aprovação pendente' })).toBeVisible();

  // Em Execuções recentes (Atividade e arquivos) a execução aparece como "Chat geral" e "Parar" a interrompe pela rota da sessão (sai de "Aguardando você").
  await page.goto('/configuracoes/atividade-e-arquivos');
  await expect(page.getByRole('region', { name: 'Aguardando você' })).toHaveCount(0); // as pendências não aparecem mais aqui
  // As execuções vêm da mais nova para a mais antiga e esta é a mais nova do chat geral (as dos testes anteriores já terminaram).
  const newest = page.getByRole('region', { name: 'Execuções recentes' }).getByRole('listitem').filter({ hasText: 'Chat geral' }).first();
  await expect(newest).toContainText('Aguardando aprovação');
  await expect(newest).toContainText('Mensagem');
  expect(await faiscaLook(newest.locator('svg.faisca'))).toMatchObject({ state: 'waiting', detail: 'small', still: true, decorative: true, size: [24, 24], body: AION_BODY });
  await page.getByRole('button', { name: 'Parar a execução de Chat geral' }).click();
  await expect(newest).toContainText('Interrompida');
  await page.goto('/aprovacoes');
  await expect(page.getByRole('region', { name: 'Aguardando você' }).getByRole('link').filter({ hasText: 'Chat geral' })).toHaveCount(0);
  await page.goto('/configuracoes/atividade-e-arquivos');
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'chat-geral-atividades-375');
  expect(problems).toEqual([]);
});

test('o Chat geral mostra a Faísca do Aion no cabeçalho e na linha "Trabalhando…" acima do composer, sem spinner nem marcador de chat, e o cartão de interrupção mantém o ícone', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  const api = await setup(page);
  const session = await api.createSession();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/chat/${session.id}`);
  const log = page.getByRole('log', { name: 'Conversa' });
  await expect(page.getByRole('heading', { level: 2, name: 'No que posso ajudar?' })).toBeVisible();

  // Histórico que faz o log rolar (A6): uma mensagem longa e a resposta dela, antes de a execução ficar trabalhando.
  await typeAndSend(page, LONG_HISTORY_MESSAGE);
  await expect(log.locator('.markdown').filter({ hasText: 'Resposta:' })).toBeVisible();
  await typeAndSend(page, '[demorar] Cg trabalhando sem fim');
  const line = page.locator('[data-working-line]');
  const working = line.getByText('Trabalhando…');
  await expect(working).toBeVisible();
  // A linha fixa (ID-04): a Faísca do Aion de 24 px trabalhando (se mexe), sem spinner, e a frase numa região educada, fora da lista. O cabeçalho (32 px)
  // acompanha a execução da sessão, e nenhum marcador de chat sobra.
  await expect(line.locator('[data-icon="LoaderCircle"]')).toHaveCount(0);
  await expect(log.locator('[data-icon="LoaderCircle"]')).toHaveCount(0);
  await expect(log.locator('[data-icon="MessageSquare"]')).toHaveCount(0);
  await expect(log.getByText('Trabalhando…')).toHaveCount(0);
  const working1 = line.locator('svg.faisca');
  await expect(working1).toHaveCount(1);
  expect(await faiscaLook(working1)).toMatchObject({ state: 'working', detail: 'small', still: false, decorative: true, size: [24, 24], body: AION_BODY });
  await expect(working).toHaveAttribute('aria-live', 'polite');
  const header = page.getByRole('main').locator('header').first().locator('svg.faisca');
  expect(await faiscaLook(header)).toMatchObject({ state: 'working', detail: 'small', size: [32, 32], body: AION_BODY });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => runningAnimations(working1)).toBe(0); // movimento reduzido: pose estática
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(() => runningAnimations(working1)).toBeGreaterThan(0);
  await expectNoA11yViolations(page);
  await expectWorkingLineAtTop(page, log, line);
  await attachShot(page, testInfo, 'chat-geral-trabalhando-1440');
  await page.setViewportSize({ width: 375, height: 812 });
  await expectWorkingLineAtTop(page, log, line);
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'chat-geral-trabalhando-375');
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByRole('button', { name: 'Parar execução' }).click();
  const interrupted = page.getByRole('region', { name: 'Execução interrompida' });
  await expect(interrupted).toBeVisible();
  await expect(interrupted.locator('svg.faisca')).toHaveCount(0);
  await expect(interrupted.locator('svg[data-icon]')).toHaveCount(1);
  await expect(line).toHaveCount(0); // sem execução não há linha de trabalho
  await expect(log.locator('svg.faisca')).toHaveCount(0);
  expect(await faiscaLook(page.getByRole('main').locator('header').first().locator('svg.faisca'))).toMatchObject({ state: 'idle', body: AION_BODY });
  expect(problems).toEqual([]);
});

test('"Permitir uma vez" na aprovação antiga do conector, no cartão reduzido, recusa a ação sem executá-la no Composio, e a resposta permanente é recusada pela API (nenhuma regra é gravada)', async ({ page }) => {
  const problems = watchPage(page);
  const api = await setup(page);
  const session = await api.createSession();
  // A7: a pendência de antes do deploy (o Chat geral não tem conector, então só o controle da pilha a cria).
  const { runId: run, approvalId } = await api.seedLegacyApproval(session.id, '[gmail] Cg envie a folha');
  await api.waitForRun(run, 'waiting_approval');
  expect(await api.pendingApprovalOf(run), 'a pendência da sessão em Atividades').toBe(approvalId);
  const executionsBefore = await api.composioExecutions();

  const refused = await page.context().request.post(`${ORIGIN}/api/approvals/${approvalId}/respond`, { headers: api.headers, data: { decision: 'allow_always' } });
  expect(refused.status()).toBe(422);
  expect(((await refused.json()) as { code: string }).code).toBe('VALIDATION_FAILED');
  await expect.poll(() => api.runStatus(run)).toBe('waiting_approval');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/chat/${session.id}`);
  await page.getByRole('region', { name: 'Aprovação pendente' }).getByRole('button', { name: 'Permitir uma vez' }).click();
  // A resposta do dono é aceita e a execução segue até o fim, mas a ação não executa: o Chat geral não tem conector (A7). A chamada fecha como falha com a recusa, que o bot lê.
  await api.waitForRun(run, 'completed');
  await expect(page.getByRole('region', { name: 'Aprovação' }).getByText('Aprovada')).toBeVisible();
  await expect.poll(() => api.activityOf(session.id, 'GMAIL_SEND_EMAIL')).toMatchObject({ status: 'failed', result: expect.stringContaining('Ação recusada: o Chat geral não usa conectores. Ela não foi executada.') });
  expect(await api.composioExecutions(), 'nenhuma execução chegou ao Composio').toBe(executionsBefore);
  expect(problems).toEqual([]);
});

// --- Bolinha azul de não lido (phase 3, T5; F4, A2, A7) ------------------------------------------------------------------------------------
// Fica neste arquivo porque precisa do provedor falso e do worker para gerar respostas reais (bots e sessões), e roda antes da retenção (o último
// teste), que apaga as sessões temporárias. O ponto de partida "sem novidade" vem do controle da pilha (`/mark-all-read`): os specs anteriores
// deixam conversas nunca abertas. A leitura que apaga a bolinha na outra sessão é a presença real do navegador.

/** Bolinha de não lido dentro de um item (lista) ou de uma entrada da navegação. */
const dotIn = (scope: Locator) => scope.getByTestId('unread-dot');
/** Item de um bot na lista (pelo nome completo, que fica no `title`) e de uma sessão (pelo endereço). */
const botItem = (scope: Locator, name: string) => scope.locator(`a[title=${JSON.stringify(name)}]`);
const sessionItem = (scope: Locator, id: string) => scope.locator(`a[href="/chat/${id}"]`);
const railOf = (scope: Page | Locator) => scope.getByRole('navigation', { name: 'Seções' });
/** É a escrita de presença e leitura do navegador (`PUT /api/presence`)? */
const isPresenceWrite = (response: Response) => new URL(response.url()).pathname === '/api/presence' && response.request().method() === 'PUT';

/** Bot criado pela API com o modelo escolhido na conversa (como o dono faria no composer), pronto para responder pelo provedor falso. */
async function createTalkingBot(page: Page, api: Api, base: string): Promise<{ id: string; name: string }> {
  const name = uniqueBotName(base);
  const created = await page.context().request.post(`${ORIGIN}/api/bots`, {
    headers: api.headers,
    data: { name, color: '#60A5FA', instructions: '', model: null, effort: null, stepLimit: 25 },
  });
  expect(created.status(), `criar o bot ${name}`).toBe(201);
  const id = ((await created.json()) as { id: string }).id;
  const preference = await page.context().request.patch(`${ORIGIN}/api/bots/${id}/conversation`, { headers: api.headers, data: { model: MODEL, effort: null } });
  expect(preference.status(), 'escolher o modelo do bot').toBe(200);
  return { id, name };
}

/** Manda uma mensagem ao bot pela API (outro aparelho, sem presença nesta conversa) e espera a resposta concluída. */
async function botAnswers(page: Page, api: Api, botId: string, text: string): Promise<void> {
  const response = await page.context().request.post(`${ORIGIN}/api/bots/${botId}/messages`, { headers: api.headers, data: { content: text } });
  expect(response.status(), 'enviar ao bot pela API').toBe(201);
  await api.waitForRun(((await response.json()) as { id: string }).id, 'completed');
}

/** Leva a leitura de todas as conversas até a mensagem mais recente (controle da pilha): nenhuma bolinha acesa. */
async function markAllRead(): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${E2E_PORTS.control}/mark-all-read`, { method: 'POST' });
  expect(response.status, 'marcar tudo como lido pelo controle da pilha').toBe(200);
}

/** Captura do estado, sem rolagem horizontal e sem violações de acessibilidade. */
async function unreadShot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, name);
}

test('bolinha de não lido: acende no item e na navegação (barra de ícones e barra inferior) com a novidade, ignora o arquivado na barra e o silenciamento, e some na outra sessão quando a conversa é lida (T5)', async ({ page, browser }, testInfo) => {
  test.setTimeout(240_000);
  const problems = watchPage(page);
  const api = await setup(page);
  const target = await createTalkingBot(page, api, 'Cg bolinha alvo');
  const other = await createTalkingBot(page, api, 'Cg bolinha outro');
  const archived = await createTalkingBot(page, api, 'Cg bolinha arquivado');
  // Criar a sessão devolve o rascunho vazio até ele receber uma mensagem: a segunda só nasce depois da primeira mensagem na primeira.
  const targetSession = await api.createSession();
  await api.waitForRun(await api.send(targetSession.id, 'Cg bolinha sessão alvo'), 'completed');
  const otherSession = await api.createSession();
  await api.waitForRun(await api.send(otherSession.id, 'Cg bolinha sessão outra'), 'completed');
  // Ponto de partida sem novidade; depois só o bot arquivado ganha uma (ela aparece em Arquivados, mas não acende Bots).
  await markAllRead();
  await botAnswers(page, api, archived.id, 'Cg pergunta ao arquivado');
  expect((await page.context().request.post(`${ORIGIN}/api/bots/${archived.id}/archive`, { headers: api.headers })).status(), 'arquivar').toBe(200);
  // Silenciar os avisos de conclusão do bot alvo não pode tirar a bolinha (a matriz de silenciar volta ao estado anterior no fim).
  const mute = (muted: boolean) =>
    page.context().request.put(`${ORIGIN}/api/push/preferences`, { headers: api.headers, data: { botId: target.id, kind: 'run_completed', muted } });
  expect((await mute(true)).status(), 'silenciar o bot alvo').toBe(200);

  try {
    // --- Sem novidade, 1280 px: nenhum item com bolinha (fora o arquivado, dentro de Arquivados) e a barra sem marcador ---------------------------
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/bots/${other.id}`);
    await expect(botItem(panel(page), target.name)).toBeVisible();
    const approvalsBefore = await railOf(page).getByRole('link', { name: /^Aprovações/ }).getAttribute('aria-label');
    await expect(dotIn(botItem(panel(page), target.name))).toHaveCount(0);
    await expect(railOf(page).getByRole('link', { name: /^Bots/ })).toHaveAccessibleName('Bots');
    await expect(railOf(page).getByRole('link', { name: /^Chat geral/ })).toHaveAccessibleName('Chat geral');
    await expect(dotIn(railOf(page))).toHaveCount(0);
    await panel(page).getByRole('button', { name: /Arquivados/ }).click();
    const archivedItem = botItem(panel(page).getByRole('list', { name: 'Bots arquivados' }), archived.name);
    await expect(dotIn(archivedItem)).toBeVisible();
    await expect(archivedItem).toHaveAccessibleName(/Novidades não lidas$/);
    await unreadShot(page, testInfo, 'nao-lido-bots-1280-sem-novidade');

    await page.goto(`/chat/${otherSession.id}`);
    await expect(sessionItem(panel(page), targetSession.id)).toBeVisible();
    await expect(dotIn(panel(page))).toHaveCount(0);
    await expect(dotIn(railOf(page))).toHaveCount(0);
    await unreadShot(page, testInfo, 'nao-lido-chat-1280-sem-novidade');

    // --- Sem novidade, 375 px: a barra inferior sem bolinha em Início e em Chats, e as listas do Início e de Chats também ---------------------------------------
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await expect(tabOf(page, 'Início')).toHaveAccessibleName('Início');
    await expect(tabOf(page, 'Chats')).toHaveAccessibleName('Chats');
    await expect(botItem(content(page), target.name)).toBeVisible();
    // A lista de ativos e a barra sem marcador; o do arquivado fica na lista recolhida de Arquivados (no DOM, oculta), fora desta conferência.
    await expect(dotIn(content(page).getByRole('list', { name: 'Seus bots', exact: true }))).toHaveCount(0);
    await expect(dotIn(tabBarOf(page))).toHaveCount(0);
    await unreadShot(page, testInfo, 'nao-lido-inicio-375-sem-novidade');
    await page.goto('/chats');
    await expect(sessionItem(content(page), targetSession.id)).toBeVisible();
    await expect(dotIn(content(page))).toHaveCount(0);
    await expect(dotIn(tabBarOf(page))).toHaveCount(0);
    await unreadShot(page, testInfo, 'nao-lido-chats-375-sem-novidade');

    // --- Chega novidade no bot alvo (silenciado) e na sessão alvo, sem presença em nenhuma das duas -------------------------------------------
    await botAnswers(page, api, target.id, 'Cg pergunta ao alvo');
    await api.waitForRun(await api.send(targetSession.id, 'Cg segunda pergunta da sessão alvo'), 'completed');

    // 1280 px: marcador no item, nome acessível com a novidade, barra acesa em Bots e Chat geral, contador de aprovações igual.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/bots/${other.id}`);
    const targetItem = botItem(panel(page), target.name);
    await expect(dotIn(targetItem)).toBeVisible();
    await expect(targetItem).toHaveAccessibleName(/Novidades não lidas$/);
    const dotBox = (await dotIn(targetItem).boundingBox())!;
    expect([Math.round(dotBox.width), Math.round(dotBox.height)], 'marcador de 8 px').toEqual([8, 8]);
    await expect(dotIn(targetItem)).toHaveCSS('background-color', 'rgb(141, 182, 250)'); // --info
    await expect(dotIn(botItem(panel(page), other.name)), 'o item aberto não mostra o marcador').toHaveCount(0);
    await expect(railOf(page).getByRole('link', { name: /^Bots/ })).toHaveAccessibleName('Bots, há novidades não lidas');
    await expect(railOf(page).getByRole('link', { name: /^Chat geral/ })).toHaveAccessibleName('Chat geral, há novidades não lidas');
    await expect(railOf(page).getByRole('link', { name: /^Aprovações/ })).toHaveAttribute('aria-label', approvalsBefore ?? 'Aprovações');
    await unreadShot(page, testInfo, 'nao-lido-bots-1280-com-novidade');

    await page.goto(`/chat/${otherSession.id}`);
    const targetSessionItem = sessionItem(panel(page), targetSession.id);
    await expect(dotIn(targetSessionItem)).toBeVisible();
    await expect(targetSessionItem).toHaveAccessibleName(/Novidades não lidas/);
    // Título em destaque (`text-fg font-medium`) na sessão com novidade.
    const title = targetSessionItem.getByText('Cg bolinha sessão alvo', { exact: true });
    await expect(title).toHaveCSS('font-weight', '500');
    await expect(title).toHaveCSS('color', 'rgb(236, 236, 241)'); // --text
    await expect(dotIn(sessionItem(panel(page), otherSession.id)), 'a sessão aberta não mostra o marcador').toHaveCount(0);
    await unreadShot(page, testInfo, 'nao-lido-chat-1280-com-novidade');

    // 375 px: a aba Início com a bolinha e o nome acessível (bot ativo com novidade) e o item do bot com o marcador; a aba Chats com a dela e a sessão com o marcador.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await expect(tabOf(page, 'Início')).toHaveAccessibleName('Início, há novidades não lidas');
    await expect(dotIn(tabOf(page, 'Início'))).toBeVisible();
    await expect(tabOf(page, 'Chats')).toHaveAccessibleName('Chats, há novidades não lidas');
    await expect(dotIn(tabOf(page, 'Chats'))).toBeVisible();
    await expect(dotIn(botItem(content(page), target.name))).toBeVisible();
    await unreadShot(page, testInfo, 'nao-lido-inicio-375-com-novidade');
    await page.goto('/chats');
    await expect(tabOf(page, 'Chats')).toHaveAccessibleName('Chats, há novidades não lidas'); // também na própria lista (design: a regra é a mesma em toda tela com barra)
    await expect(dotIn(sessionItem(content(page), targetSession.id))).toBeVisible();
    await unreadShot(page, testInfo, 'nao-lido-chats-375-com-novidade');

    // --- A2: o outro aparelho (contexto B, outra sessão de login) vê a bolinha; o A lê a conversa e ela some no B no ciclo da lista (até 15 s) ---
    await page.setViewportSize({ width: 1280, height: 900 });
    const contextB = await browser.newContext({
      baseURL: ORIGIN,
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
      viewport: { width: 1280, height: 900 },
      extraHTTPHeaders: { [CLIENT_IP_HEADER]: clientIpFor(`${testInfo.testId}:${testInfo.retry}:b`) },
    });
    try {
      await apiLogin(contextB);
      const pageB = await contextB.newPage();
      const problemsB = watchPage(pageB);
      await pageB.goto(`/bots/${other.id}`);
      await expect(dotIn(botItem(panel(pageB), target.name))).toBeVisible();

      const read = page.waitForResponse(isPresenceWrite);
      await page.goto(`/bots/${target.id}`);
      expect((await read).status(), 'presença e leitura no A').toBe(204);
      await expect(dotIn(botItem(panel(pageB), target.name)), 'a bolinha some no B sem recarregar').toHaveCount(0, { timeout: 25_000 });
      await expect(railOf(pageB).getByRole('link', { name: /^Bots/ })).toHaveAccessibleName('Bots', { timeout: 25_000 });

      await pageB.goto(`/chat/${otherSession.id}`);
      await expect(dotIn(sessionItem(panel(pageB), targetSession.id))).toBeVisible();
      const readChat = page.waitForResponse(isPresenceWrite);
      await page.goto(`/chat/${targetSession.id}`);
      expect((await readChat).status(), 'presença e leitura da sessão no A').toBe(204);
      await expect(dotIn(sessionItem(panel(pageB), targetSession.id)), 'a bolinha da sessão some no B').toHaveCount(0, { timeout: 25_000 });
      await expect(railOf(pageB).getByRole('link', { name: /^Chat geral/ })).toHaveAccessibleName('Chat geral', { timeout: 25_000 });
      expect(problemsB).toEqual([]);
    } finally {
      await contextB.close();
    }
    expect(problems).toEqual([]);
  } finally {
    await mute(false);
  }
});

test('o relógio da sessão aparece só quando falta 1 dia ou menos e a data exata do apagamento vem no hover, no foco, no toque e no nome acessível (A24)', async ({ page }) => {
  const problems = watchPage(page);
  const api = await setup(page);
  const session = await api.createSession();
  await api.waitForRun(await api.send(session.id, 'Cg relógio da retenção'), 'completed');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/chat/${session.id}`);
  await expect(sessionLink(page, 'Cg relógio da retenção')).toBeVisible();
  // Faltam 7 dias: sem relógio.
  const row = panel(page).getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Cg relógio da retenção' }) });
  await expect(row.getByRole('button', { name: /^Apaga em/ })).toHaveCount(0);

  // O relógio da página avança 6 dias e 12 horas: falta meio dia, e o ícone aparece com a data exata (a mesma do servidor, no fuso do navegador).
  const expiresAt = (await api.sessionOf(session.id)).expiresAt as string;
  await page.clock.setFixedTime(new Date(Date.now() + 6.5 * 24 * 60 * 60 * 1000));
  await page.reload();
  const clock = row.getByRole('button', { name: /^Apaga em/ });
  await expect(clock).toHaveCount(1);
  const label = (await clock.getAttribute('aria-label')) as string;
  expect(label).toContain(new Date(expiresAt).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }));
  // Hover, foco pelo teclado e toque mostram a mesma data no tooltip.
  await clock.hover();
  await expect(page.getByRole('tooltip')).toHaveText(label);
  await page.mouse.move(900, 600, { steps: 10 }); // longe da barra de ícones (o canto superior esquerdo tem dicas próprias)
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await clock.focus();
  await expect(page.getByRole('tooltip')).toHaveText(label);
  await clock.blur();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await clock.click();
  await expect(page.getByRole('tooltip')).toHaveText(label);
  await expectNoA11yViolations(page);
  expect(problems).toEqual([]);
});

test('uma sessão apagada pela retenção mostra "Esta sessão expirou" com "Novo chat", e some do painel', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  const api = await setup(page);
  const doomed = await api.createSession();
  await api.waitForRun(await api.send(doomed.id, 'Cg vai expirar logo'), 'completed');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/chat/${doomed.id}`);
  await expect(page.getByRole('log', { name: 'Conversa' })).toContainText('Resposta: Cg vai expirar logo');
  await expect(sessionLink(page, 'Cg vai expirar logo')).toBeVisible();

  // A retenção (job diário do worker) apagou a sessão: aqui a mesma exclusão do serviço, com o relógio 8 dias adiante (controle da pilha).
  const purge = await fetch(`http://127.0.0.1:${E2E_PORTS.control}/chat-retention`, { method: 'POST' });
  expect(purge.status, 'rodar a retenção do chat geral').toBe(200);
  expect(((await purge.json()) as { removed: number }).removed).toBeGreaterThanOrEqual(1);

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Esta sessão expirou' })).toBeVisible();
  await expect(page.getByText('As sessões do chat geral são apagadas 7 dias após a última mensagem')).toBeVisible();
  await expect(sessionLink(page, 'Cg vai expirar logo')).toHaveCount(0);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'chat-geral-expirada-1440');

  await content(page).getByRole('button', { name: 'Novo chat' }).click();
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 2, name: 'No que posso ajudar?' })).toBeVisible();
  // O único erro de resposta esperado é o 404 da própria sessão apagada (SESSION_NOT_FOUND).
  expect(problems.filter((problem) => !/^404 GET \/api\/chat\/sessions\//.test(problem))).toEqual([]);
});

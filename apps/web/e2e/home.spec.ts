// E2E do Início (phase 5, T5; A7, A8, A9, A11 e a parte "entrar sem next abre o Início" de A17; F4) no navegador real, contra a pilha de produção (Postgres, API, worker, Next e proxy)
// com o OpenCode Go e o Composio FALSOS. Marcadores do modelo falso: [demorar] roda até o dono parar (o bot fica "Trabalhando"), [gmail] pede aprovação (só num bot com conta liberada: o Chat
// geral não tem conector, phase 13), [blocos] responde em Markdown (ver packages/core/src/testing/fake-upstreams.ts). A aprovação pendente do Chat geral é a de antes do deploy, semeada pelo
// controle da pilha (`/seed-legacy-connector-approval`).
//
// Cobre: o estado vazio (banco sem bots: "Seus bots começam aqui" e "Criar bot"); sem provedor (campo desabilitado, aviso e "Abrir Conexões") e sem modelo padrão do Chat geral
// ("Abrir Preferências"); o Início com dados em 1280 e 375 px (saudação com o nome pelo relógio e fuso controlados, resumo do momento, cartão da pendência que vence primeiro com
// "Ver todas (N)", bots com a prévia da última novidade, o selo de estado e a bolinha de não lido, "Arquivados (N)" recolhido, o campo "Pergunte
// ao Aion"); a saudação em cada faixa do dia, no fuso do dono e com ou sem nome; abrir o Início sem criar sessão, o texto não enviado que volta ao recarregar, a falha que mantém o texto,
// o envio que cria a sessão, aplica modelo e effort só a ela e abre a conversa; anexar, que abre o rascunho antes do upload; a estrela da barra de ícones; e `/bots`, que segue abrindo o
// último bot. Chats (phase 5, T10; A12): o MESMO campo "Pergunte ao Aion" no rodapé (abrir não cria sessão, o rascunho é o do Início, enviar cria a sessão e abre a conversa) e a
// escolha "Todos | Salvos" na URL (só as salvas, filtradas no servidor; sobrevive a recarregar e ao Voltar; valor desconhecido cai em Todos; vazio próprio e erro com "Tentar novamente").
// axe em cada estado, sem rolagem horizontal e sem erro de console nem resposta de erro inesperada.
//
// O estado é global (o Início lista todos os bots, pendências e sessões), então o arquivo é serial, roda no projeto `chromium-home` depois dos demais (antes do TOTP), zera os bots
// pelo controle da pilha no primeiro teste (o único que precisa do banco sem bots) e os nomes são exclusivos ("Ini ...").
import type { Page } from '@playwright/test';
import { ERROR_CODES } from '@aion/shared';
import { E2E_PORTS } from '../../../tests/support/e2e-env';
import {
  AION_BODY,
  ORIGIN,
  apiHeaders,
  apiLogin,
  attachShot,
  backLink,
  ensureCredential,
  expect,
  expectNoA11yViolations,
  expectNoHorizontalScroll,
  expectVisibleFocusOnTab,
  faiscaLook,
  releaseConnectorAccounts,
  setKeyboard,
  setProvider,
  tabBarOf,
  tabOf,
  test,
  uniqueBotName,
  watchPage,
} from './support/fixtures';

test.describe.configure({ mode: 'serial' });

const FAKE_PROVIDER = 'valid-e2e-inicio-1111';
const FAKE_CONNECTOR = 'valid-e2e-composio-3333';
const MODEL = 'opencode/glm-5.1';
const CONTROL = `http://127.0.0.1:${E2E_PORTS.control}`;
/** Chave do `localStorage` do texto não enviado do Início (ver `home-composer.tsx`). */
const DRAFT_KEY = 'aion:home-draft';

const MOBILE = { width: 375, height: 812 };
const DESKTOP = { width: 1280, height: 800 };

let credentialsSeeded = false;

/** Provedor e Composio conectados (a chave do Composio é trocada na primeira vez: o spec de chaves a deixa sem apps) e o modelo padrão do Chat geral definido. */
async function prepare(page: Page): Promise<void> {
  const replace = !credentialsSeeded;
  await ensureCredential(page, 'provider', FAKE_PROVIDER, { replace });
  await ensureCredential(page, 'connector', FAKE_CONNECTOR, { replace });
  credentialsSeeded = true;
  const headers = await apiHeaders(page);
  // Os níveis de effort de um modelo só existem depois do teste dele (o padrão do Chat geral só aceita um effort que o modelo tenha): sem os specs anteriores da cadeia, o teste vem aqui.
  const tested = await page.context().request.post(`${ORIGIN}/api/models/test`, { headers, data: { model: MODEL } });
  expect(tested.status(), 'testar o modelo').toBe(200);
  const saved = await page.context().request.put(`${ORIGIN}/api/chat/settings`, { headers, data: { model: MODEL, effort: 'medium' } });
  expect(saved.status(), 'definir o modelo padrão do Chat geral').toBe(200);
}

/** O que a API devolve de uma página de Atividades: as pendências e as execuções mais novas, cada uma de um bot ou de uma sessão do Chat geral. */
interface ActivityOwner {
  runId: string;
  bot: { id: string } | null;
  sessionId: string | null;
}
interface ActivitiesPage {
  pending: ActivityOwner[];
  items: (ActivityOwner & { status: string })[];
}
const activities = async (page: Page, headers: Record<string, string>): Promise<ActivitiesPage> =>
  (await (await page.context().request.get(`${ORIGIN}/api/activities`, { headers })).json()) as ActivitiesPage;

/** Espera a execução chegar ao estado dado (consultando a própria API de Atividades). */
async function waitForRun(page: Page, headers: Record<string, string>, runId: string, status: string): Promise<void> {
  await expect.poll(async () => (await activities(page, headers)).items.find((item) => item.runId === runId)?.status, { timeout: 30_000 }).toBe(status);
}

/** Encerra as execuções que ficaram ativas ou esperando aprovação (as do cenário, ao fim, para não deixar o worker ocupado para os próximos arquivos). */
async function stopRuns(page: Page): Promise<void> {
  const headers = await apiHeaders(page);
  const request = page.context().request;
  await expect
    .poll(
      async () => {
        const view = await activities(page, headers);
        const active = [...view.pending, ...view.items.filter((item) => ['queued', 'running', 'waiting_approval'].includes(item.status))];
        // Parada por execução (a mesma do botão "Parar" de Atividades): a rota é a da conversa do bot ou da sessão; a API recusa com 409 a execução que já terminou.
        for (const { runId, bot, sessionId } of active) {
          const base = bot ? `/api/bots/${bot.id}` : `/api/chat/sessions/${sessionId}`;
          await request.post(`${ORIGIN}${base}/runs/stop?runId=${runId}`, { headers });
        }
        return active.length;
      },
      { timeout: 30_000 },
    )
    .toBe(0);
}

interface Bot {
  id: string;
  name: string;
}

/** Cria um bot pela API com o nome exclusivo da repetição (`uniqueBotName`, E29). */
async function createBot(page: Page, headers: Record<string, string>, name: string, color: string): Promise<Bot> {
  const unique = uniqueBotName(name);
  const response = await page.context().request.post(`${ORIGIN}/api/bots`, { headers, data: { name: unique, color, instructions: '', model: MODEL, effort: null, stepLimit: 25 } });
  expect(response.status(), `criar o bot ${unique}`).toBe(201);
  return { id: ((await response.json()) as { id: string }).id, name: unique };
}

async function sendToBot(page: Page, headers: Record<string, string>, bot: Bot, content: string): Promise<string> {
  const response = await page.context().request.post(`${ORIGIN}/api/bots/${bot.id}/messages`, { headers, data: { content } });
  expect(response.status(), 'enviar ao bot pela API').toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/**
 * Deixa na sessão do Chat geral a aprovação pendente de uma ação do conector, como a phase 12 a gravava (controle da pilha): o Chat geral não tem mais conector (phase 13, A6), então nenhuma
 * mensagem a cria e só a pendência de antes do deploy existe (A7). O spec roda no navegador e não importa o semeador do núcleo (`seedLegacyChatApproval`, de `@aion/core/testing`): chama a rota de
 * controle da pilha, que o usa, e assim a forma da linha tem uma fonte só. Devolve a execução, que já está em `waiting_approval`.
 */
async function seedLegacyApproval(sessionId: string): Promise<string> {
  const seeded = await fetch(`${CONTROL}/seed-legacy-connector-approval?${new URLSearchParams({ sessionId })}`, { method: 'POST' });
  expect(seeded.status, 'semear a aprovação pendente antiga pelo controle da pilha').toBe(200);
  return ((await seeded.json()) as { runId: string }).runId;
}

/** Sessão do Chat geral com uma mensagem enviada pela API (o modelo é o padrão do Chat geral); devolve a sessão e o id da execução. */
async function chatWith(page: Page, headers: Record<string, string>, content: string): Promise<{ id: string; runId: string }> {
  const request = page.context().request;
  const created = await request.post(`${ORIGIN}/api/chat/sessions`, { headers });
  expect(created.status(), 'abrir a sessão').toBe(201);
  const id = ((await created.json()) as { id: string }).id;
  const sent = await request.post(`${ORIGIN}/api/chat/sessions/${id}/messages`, { headers, data: { content } });
  expect(sent.status(), 'enviar à sessão pela API').toBe(201);
  return { id, runId: ((await sent.json()) as { id: string }).id };
}

/** Os ids da lista de sessões que o Início e o painel recebem (o rascunho invisível não vem nela). */
async function listedSessionIds(page: Page, headers: Record<string, string>): Promise<string[]> {
  const response = await page.context().request.get(`${ORIGIN}/api/chat/sessions`, { headers });
  expect(response.status(), 'listar as sessões').toBe(200);
  return ((await response.json()) as { items: { id: string }[] }).items.map((item) => item.id);
}

/** "Como te chamar" e o fuso do dono: lê as preferências e grava de volta com os campos dados (a API aceita o objeto completo). */
async function setPreferences(page: Page, headers: Record<string, string>, change: { ownerName?: string; timeZone?: string }): Promise<void> {
  const request = page.context().request;
  const current = (await (await request.get(`${ORIGIN}/api/settings`, { headers })).json()) as { language: string; timeZone: string; ownerName: string };
  const saved = await request.put(`${ORIGIN}/api/settings`, { headers, data: { ...current, ...change } });
  expect(saved.status(), 'gravar as preferências').toBe(200);
}

/** O instante (UTC) em que o relógio de São Paulo (UTC-3) marca `hour:minute`, o próximo a partir de agora: sempre à frente, então os "há 5 min" da tela nunca caem no futuro. */
function atSaoPaulo(hour: number, minute = 0): Date {
  const now = new Date();
  const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour + 3, minute, 0));
  if (target.getTime() <= now.getTime()) target.setUTCDate(target.getUTCDate() + 1);
  return target;
}

const greeting = (page: Page) => page.getByRole('heading', { level: 1 });
const field = (page: Page) => page.getByRole('textbox', { name: 'Pergunte ao Aion' });
const rail = (page: Page) => page.getByRole('navigation', { name: 'Seções' });
const botsList = (page: Page) => page.getByRole('list', { name: 'Seus bots' });
const botRow = (page: Page, name: string) => botsList(page).getByRole('link').filter({ hasText: name });
const pendingCard = (page: Page) => page.getByRole('region', { name: 'Aguardando você' });
const recentChats = (page: Page) => page.getByRole('region', { name: 'Chats recentes' });
const content = (page: Page) => page.locator('#conteudo');
/** A lista de sessões da PÁGINA Chats (a do painel do desktop, `complementary`, tem o mesmo nome e fica fora do `#conteudo`). */
const chatsList = (page: Page) => content(page).getByRole('list', { name: 'Sessões' });
const viewGroup = (page: Page) => page.getByRole('group', { name: 'Vista dos chats' });
const viewButton = (page: Page, name: 'Todos' | 'Salvos') => viewGroup(page).getByRole('button', { name, exact: true });
const RETENTION_NOTICE = 'Apagados 7 dias após a última mensagem';
const SAVED_EMPTY = 'Nenhum chat salvo. Use "Salvar" dentro de uma conversa para guardá-la aqui.';
/** Os ids da lista `?saved=true` da API: o que a vista Salvos deve mostrar (o filtro é do servidor). */
async function savedSessionIds(page: Page, headers: Record<string, string>): Promise<string[]> {
  const response = await page.context().request.get(`${ORIGIN}/api/chat/sessions?saved=true`, { headers });
  expect(response.status(), 'listar as sessões salvas').toBe(200);
  return ((await response.json()) as { items: { id: string; saved: boolean }[] }).items.map((item) => item.id);
}

test.afterAll(async ({ browser }) => {
  // O cenário deixa um bot "Trabalhando" e duas aprovações pendentes: sem isto o worker seguiria ocupado para os arquivos seguintes.
  const context = await browser.newContext();
  try {
    await stopRuns(await context.newPage());
  } finally {
    await context.close();
  }
});

test('banco sem bots: o Início mostra o vazio com "Criar bot" e o campo "Pergunte ao Aion" pronto; sem sessão nenhuma, a seção de chats não aparece (A9)', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  await prepare(page);
  // Sem bots, nem arquivados (só o primeiro teste do arquivo precisa do banco assim): o controle da pilha zera os bots e tudo o que depende deles.
  expect((await fetch(`${CONTROL}/reset-bots`, { method: 'POST' })).status).toBe(200);
  const headers = await apiHeaders(page);
  expect(await listedSessionIds(page, headers)).toEqual([]);

  for (const [name, viewport] of [['375', MOBILE], ['1280', DESKTOP]] as const) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(greeting(page)).toHaveText('Seus bots começam aqui');
    await expect(page.getByText('Cada bot tem nome, instruções e memória próprios, e trabalha mesmo com o app fechado.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Criar bot' })).toHaveAttribute('href', '/bots/novo');
    await expect(page.getByText('Ou pergunte direto ao Aion no campo abaixo.')).toBeVisible();
    // A Faísca do Aion dormindo (112 px, completa, com a entrada) no lugar da saudação; nada de resumo, cartão, lista de bots nem chats.
    const sleeping = page.locator('#conteudo svg.faisca').first();
    expect(await faiscaLook(sleeping)).toMatchObject({ state: 'sleep', detail: 'full', decorative: true, size: [112, 112], body: AION_BODY });
    await expect(page.getByRole('heading', { level: 2 })).toHaveCount(0);
    await expect(page.getByText('Tudo em dia')).toHaveCount(0);
    await expect(botsList(page)).toHaveCount(0);
    await expect(recentChats(page)).toHaveCount(0);
    // Phase 14, A3: o atalho para Artefatos só existe com bots; sem nenhum, o Início é só o convite do primeiro bot.
    await expect(content(page).getByRole('link', { name: /^Artefatos/ })).toHaveCount(0);
    // O campo está pronto (provedor e modelo padrão definidos) e sem aviso.
    await expect(field(page)).toBeEnabled();
    await expect(page.getByText('Configure um provedor para conversar.')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, `inicio-vazio-${name}`);
  }

  await page.getByRole('link', { name: 'Criar bot' }).click();
  await expect(page).toHaveURL(/\/bots\/novo$/);
  expect(problems).toEqual([]);
});

test('sem provedor o campo fica desabilitado com o aviso e "Abrir Conexões"; sem modelo padrão do Chat geral o aviso leva a Preferências (A9)', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  await prepare(page);
  await setProvider(page, null);

  for (const [name, viewport] of [['375', MOBILE], ['1280', DESKTOP]] as const) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.getByText('Configure um provedor para conversar.', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Abrir Conexões' })).toHaveAttribute('href', '/configuracoes/conexoes');
    // Desabilitado: o campo diz o motivo no lugar da ajuda, e sem provedor não há seletor de modelo, anexo nem ditado.
    await expect(field(page)).toBeDisabled();
    await expect(field(page)).toHaveAttribute('placeholder', 'Configure um provedor para conversar.');
    await expect(page.getByRole('button', { name: 'Anexar arquivo' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeDisabled();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, `inicio-sem-provedor-${name}`);
  }
  await page.getByRole('link', { name: 'Abrir Conexões' }).click();
  await expect(page).toHaveURL(/\/configuracoes\/conexoes$/);

  // Com o provedor de volta, mas o Chat geral sem modelo padrão (resposta simulada: o padrão é obrigatório e a API não o apaga): o aviso muda e leva a Preferências.
  await prepare(page);
  await page.route('**/api/chat/settings', (route) => route.fulfill({ json: { model: null, effort: null, effortLevels: [] } }));
  await page.goto('/');
  await expect(page.getByText('Defina o modelo padrão do Chat geral para conversar.', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Abrir Preferências' })).toHaveAttribute('href', '/configuracoes/preferencias');
  await expect(page.getByText('Configure um provedor para conversar.')).toHaveCount(0);
  await expect(field(page)).toBeDisabled();
  await expect(field(page)).toHaveAttribute('placeholder', 'Defina o modelo padrão do Chat geral para conversar.');
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'inicio-sem-modelo-padrao-375');
  await page.unroute('**/api/chat/settings');
  expect(problems).toEqual([]);
});

/** O cenário do Início com dados: 4 bots ativos (trabalhando, aguardando, com novidade e livre), 1 arquivado, 2 pendências e 4 sessões (3 aparecem). Montado uma vez. */
interface Scenario {
  waiting: Bot;
  working: Bot;
  news: Bot;
  free: Bot;
  archived: Bot;
  saved: { id: string };
  chats: { id: string }[];
  /** A sessão do Chat geral com a aprovação pendente (a antiga, semeada): a mais recente das sessões. */
  approvalChat: { id: string };
}
let scenario: Scenario | null = null;

async function seed(page: Page): Promise<Scenario> {
  if (scenario) return scenario;
  await prepare(page);
  // Estado próprio (registro 2026-10-27): encerra as execuções que sobraram e zera os bots, para o cenário não herdar nada do teste anterior nem de outro arquivo.
  await stopRuns(page);
  expect((await fetch(`${CONTROL}/reset-bots`, { method: 'POST' })).status).toBe(200);
  const headers = await apiHeaders(page);
  const request = page.context().request;
  const waiting = await createBot(page, headers, 'Ini Aguardando', '#FB923C');
  const working = await createBot(page, headers, 'Ini Trabalhando', '#60A5FA');
  const news = await createBot(page, headers, 'Ini Novidade', '#F472B6');
  const free = await createBot(page, headers, 'Ini Livre', '#4ADE80');
  const archived = await createBot(page, headers, 'Ini Arquivado', '#A78BFA');

  await waitForRun(page, headers, await sendToBot(page, headers, news, '[blocos]'), 'completed');
  await waitForRun(page, headers, await sendToBot(page, headers, archived, 'oi, antes de arquivar'), 'completed');
  expect((await request.post(`${ORIGIN}/api/bots/${archived.id}/archive`, { headers })).status(), 'arquivar').toBe(200);
  // A aprovação do bot é a primeira a vencer (a do Chat geral vem depois, com o mesmo prazo). O bot nasce sem conta do conector (A15, A16): sem a liberação o `[gmail]` não tem ação a
  // executar e nenhuma aprovação nasce (CONN-02). Os cabeçalhos são do login único do cenário (E22).
  await releaseConnectorAccounts(page, waiting.id, undefined, headers);
  await waitForRun(page, headers, await sendToBot(page, headers, waiting, '[gmail] envie o relatório do mês'), 'waiting_approval');
  await waitForRun(page, headers, await sendToBot(page, headers, working, '[demorar]'), 'running');

  // Quatro sessões: a mais antiga (fora dos 3 recentes), duas concluídas (uma salva) e a do Chat geral que espera aprovação (a mais recente).
  const oldest = await chatWith(page, headers, 'Ini chat mais antigo');
  await waitForRun(page, headers, oldest.runId, 'completed');
  const first = await chatWith(page, headers, 'Ini chat da semana');
  await waitForRun(page, headers, first.runId, 'completed');
  const kept = await chatWith(page, headers, 'Ini chat para guardar');
  await waitForRun(page, headers, kept.runId, 'completed');
  expect((await request.patch(`${ORIGIN}/api/chat/sessions/${kept.id}`, { headers, data: { saved: true } })).status(), 'salvar a sessão').toBe(200);
  // A sessão responde primeiro (sem marcador: `[gmail]` no Chat geral é só uma ferramenta desconhecida, A6) e só então recebe a aprovação pendente antiga, que o dono ainda pode ter (A7).
  const approvalChat = await chatWith(page, headers, 'Ini chat com aprovação');
  await waitForRun(page, headers, approvalChat.runId, 'completed');
  await waitForRun(page, headers, await seedLegacyApproval(approvalChat.id), 'waiting_approval');

  expect((await activities(page, headers)).pending).toHaveLength(2);
  scenario = { waiting, working, news, free, archived, saved: kept, chats: [oldest, first, kept], approvalChat };
  return scenario;
}

test('Início com dados em 1280 e 375 px: Faísca, saudação, pergunta e campo centrados, pendência que vence primeiro e bots com prévia e estado, sem chats recentes nem atalho de Artefatos (A7, A11, A19)', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const problems = watchPage(page);
  const data = await seed(page);
  const headers = await apiHeaders(page);
  await setPreferences(page, headers, { ownerName: 'Marco', timeZone: 'America/Sao_Paulo' });
  // 14h em São Paulo: "Boa tarde". O relógio da página é fixo, o resto (servidor, timers) segue real.
  await page.clock.setFixedTime(atSaoPaulo(14));

  // ---- Desktop: a mesma coluna centrada, sem cabeçalho próprio e sem painel; a estrela da barra de ícones é o Início.
  await page.setViewportSize(DESKTOP);
  await page.goto('/');
  await expect(greeting(page)).toHaveText('Boa tarde, Marco');
  await expect(page.getByText('1 bot trabalhando · 2 aprovações', { exact: true })).toBeVisible();
  const greetingFaisca = page.locator('#conteudo svg.faisca').first();
  expect(await faiscaLook(greetingFaisca)).toMatchObject({ state: 'idle', detail: 'full', decorative: true, size: [64, 64], body: AION_BODY });
  // Fredoka só na saudação (e no título do vazio): o resto da tela segue na fonte do app.
  expect(await greeting(page).evaluate((element) => getComputedStyle(element).fontFamily)).toContain('Fredoka');
  expect(await botRow(page, 'Ini Novidade').evaluate((element) => getComputedStyle(element).fontFamily)).not.toContain('Fredoka');
  // A estrela da marca no topo da barra de ícones abre o Início, sem painel (como Aprovações).
  const star = rail(page).getByRole('link', { name: 'Início' });
  await expect(star).toHaveAttribute('aria-current', 'page');
  await expect(star).toHaveAttribute('href', '/');
  await expect(page.getByRole('complementary')).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'Aion' })).toHaveCount(0); // o logotipo do cabeçalho é só do celular

  // O cartão da pendência que vence primeiro (a do bot), com "Ver todas (2)" para Aprovações.
  await expect(pendingCard(page).getByRole('link')).toHaveCount(2); // o cartão e "Ver todas"
  const card = pendingCard(page).getByRole('list').getByRole('link');
  await expect(card).toContainText(data.waiting.name);
  await expect(card).toContainText('Expira em');
  expect(await card.getAttribute('href')).toMatch(new RegExp(`^/bots/${data.waiting.id}\\?mensagem=\\d+$`));
  await expect(pendingCard(page).getByRole('link', { name: 'Ver todas (2)' })).toHaveAttribute('href', '/aprovacoes');

  // Seus bots: os quatro ativos na ordem do painel (alfabética), "Novo bot" e a prévia da última novidade de cada um.
  await expect(page.getByRole('heading', { level: 2, name: 'Seus bots' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Novo bot' })).toHaveAttribute('href', '/bots/novo');
  await expect(botsList(page).getByRole('link')).toHaveCount(4);
  expect(await botsList(page).getByRole('link').evaluateAll((links) => links.map((link) => link.getAttribute('href')?.split('/').pop()))).toEqual(
    [data.waiting, data.free, data.news, data.working].map((bot) => bot.id),
  );
  // Resposta final em Markdown vira a primeira linha limpa; o bot sem resposta final (só texto em escrita) e o livre dizem que não há mensagem.
  await expect(botRow(page, 'Ini Novidade')).toContainText('Seguem os blocos com código inline:');
  await expect(botRow(page, 'Ini Novidade')).not.toContainText('`');
  await expect(botRow(page, 'Ini Trabalhando')).toContainText('Nenhuma mensagem ainda');
  await expect(botRow(page, 'Ini Livre')).toContainText('Nenhuma mensagem ainda');
  // Cartão mais recente: a aprovação pendente.
  await expect(botRow(page, 'Ini Aguardando')).toContainText('Aprovação pendente');
  // Selo de estado (só trabalhando, aguardando e erro), Faísca no estado ao vivo na cor do bot e a bolinha de não lido (só a novidade nunca lida).
  await expect(botRow(page, 'Ini Trabalhando').getByText('Trabalhando', { exact: true })).toBeVisible();
  await expect(botRow(page, 'Ini Aguardando').getByText('Aguardando', { exact: true })).toBeVisible();
  await expect(botRow(page, 'Ini Novidade').getByText('Trabalhando', { exact: true })).toHaveCount(0);
  await expect(botRow(page, 'Ini Livre').getByText('Livre', { exact: true })).toBeAttached(); // sem selo: o estado só para o leitor de tela
  expect(await faiscaLook(botRow(page, 'Ini Trabalhando').locator('svg.faisca'))).toMatchObject({ state: 'working', detail: 'small', still: false, decorative: true, size: [32, 32], body: '#60A5FA' });
  expect(await faiscaLook(botRow(page, 'Ini Aguardando').locator('svg.faisca'))).toMatchObject({ state: 'waiting', still: false, size: [32, 32], body: '#FB923C' });
  expect(await faiscaLook(botRow(page, 'Ini Livre').locator('svg.faisca'))).toMatchObject({ state: 'idle', still: true, size: [32, 32], body: '#4ADE80' });
  await expect(botRow(page, 'Ini Novidade').getByTestId('unread-dot')).toBeVisible();
  await expect(botRow(page, 'Ini Novidade')).toContainText('Novidades não lidas');
  await expect(botRow(page, 'Ini Livre').getByTestId('unread-dot')).toHaveCount(0);
  await expect(botRow(page, 'Ini Trabalhando').getByTestId('unread-dot')).toHaveCount(0);
  // O bot abre pela linha inteira.
  expect(await botRow(page, 'Ini Livre').getAttribute('href')).toBe(`/bots/${data.free.id}`);

  // Phase 18 (A19): o Início não tem mais o atalho de Artefatos (a lista continua no menu e na barra de ícones) nem "Chats recentes".
  await expect(content(page).getByRole('link', { name: /^Artefatos/ })).toHaveCount(0);
  await expect(recentChats(page)).toHaveCount(0);

  // Arquivados (1) recolhido; ao abrir, o bot arquivado com a bolinha dele (que não acende nada fora da lista).
  const archivedToggle = page.getByRole('button', { name: 'Arquivados (1)' });
  await expect(archivedToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('link', { name: /Ini Arquivado/ })).toBeHidden();
  await archivedToggle.click();
  await expect(archivedToggle).toHaveAttribute('aria-expanded', 'true');
  const archivedRow = page.getByRole('list', { name: 'Bots arquivados' }).getByRole('link').filter({ hasText: data.archived.name });
  await expect(archivedRow).toContainText('Resposta: oi, antes de arquivar');
  await expect(archivedRow.getByTestId('unread-dot')).toBeVisible();
  await archivedToggle.click();
  await expect(archivedToggle).toHaveAttribute('aria-expanded', 'false');

  // O campo "Pergunte ao Aion": pronto, no modelo padrão do Chat geral, com anexo e envio.
  await expect(field(page)).toBeEnabled();
  await expect(page.getByRole('button', { name: MODEL, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Effort: Médio' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Anexar arquivo' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeDisabled(); // sem texto, não envia
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('main')).toHaveCount(1);
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'inicio-dados-1280');

  // Ordem do teclado no desktop: o link de pular, a estrela e as seções.
  await page.goto('/');
  const focusOrder: string[] = [];
  for (let step = 0; step < 3; step += 1) {
    await page.keyboard.press('Tab');
    focusOrder.push(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim() ?? ''));
  }
  expect(focusOrder).toEqual(['Pular para o conteúdo', 'Início', expect.stringMatching(/^Bots/)]);
  // A33: todo controle do Início, do começo da tela até o campo e as linhas de pendência e de bots, mostra o anel de foco.
  await page.goto('/');
  await expectVisibleFocusOnTab(page, 14);

  // ---- Celular: o cabeçalho com o logotipo e a engrenagem (abre o índice de Configurações); o resto é a mesma tela.
  await page.setViewportSize(MOBILE);
  await page.goto('/');
  await expect(greeting(page)).toHaveText('Boa tarde, Marco');
  await expect(page.getByRole('main').getByRole('img', { name: 'Aion' })).toBeVisible();
  await expect(page.getByRole('main').getByRole('link', { name: 'Configurações' })).toHaveAttribute('href', '/configuracoes');
  await expect(page.getByText('1 bot trabalhando · 2 aprovações', { exact: true })).toBeVisible();
  await expect(botsList(page).getByRole('link')).toHaveCount(4);
  await expect(recentChats(page)).toHaveCount(0);
  await expect(field(page)).toBeEnabled();
  // A barra inferior (T6) com os dados reais: Início ativo e com a bolinha (bot ativo com novidade), Chats com a bolinha (sessão não lida) e Aprovações com as 2 pendências.
  await expect(tabOf(page, 'Início')).toHaveAttribute('aria-current', 'page');
  await expect(tabOf(page, 'Início')).toHaveAccessibleName('Início, há novidades não lidas');
  await expect(tabOf(page, 'Chats')).toHaveAccessibleName('Chats, há novidades não lidas');
  await expect(tabOf(page, 'Aprovações')).toHaveAccessibleName('Aprovações, 2 pendentes');
  await expect(tabOf(page, 'Aprovações').getByTestId('tab-approvals-badge')).toHaveText('2');
  await expect(tabBarOf(page).getByTestId('unread-dot')).toHaveCount(2);
  // Artefatos NÃO vira quinta aba nem atalho do Início: a barra segue com Início, Chats, Rotinas e Aprovações.
  await expect(content(page).getByRole('link', { name: /^Artefatos/ })).toHaveCount(0);
  expect(await tabBarOf(page).getByRole('link').evaluateAll((links) => links.map((link) => link.getAttribute('href')))).toEqual(['/', '/chats', '/rotinas', '/aprovacoes']);
  // O campo fica no meio da coluna (A19), acima da pendência e dos bots, e a barra inferior segue dentro da tela.
  const box = (await field(page).boundingBox())!;
  const bar = (await tabBarOf(page).boundingBox())!;
  expect(box.y, 'o campo vem antes dos bots').toBeLessThan((await botsList(page).boundingBox())!.y);
  expect(bar.y + bar.height).toBeLessThanOrEqual(MOBILE.height);
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'inicio-dados-375');
  await page.evaluate(() => document.querySelector('#conteudo > div > div')?.scrollTo({ top: 10_000 }));
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'inicio-dados-375-rolado');
  await page.getByRole('main').getByRole('link', { name: 'Configurações' }).click();
  await expect(page).toHaveURL(/\/configuracoes$/);
  expect(problems).toEqual([]);
});

test('a saudação muda em cada faixa do dia (4h59 é noite, 5h dia, 12h tarde, 18h noite), vale o fuso do dono e não o do navegador, e mostra o nome só quando preenchido (A7, A14)', async ({ page }) => {
  const problems = watchPage(page);
  await seed(page);
  const headers = await apiHeaders(page);
  await page.setViewportSize(MOBILE);

  /** Abre o Início com o relógio da página fixo no instante dado e devolve o texto da saudação. */
  const greetingAt = async (at: Date): Promise<string | null> => {
    await page.clock.setFixedTime(at);
    await page.goto('/');
    await expect(greeting(page)).not.toHaveText('');
    return greeting(page).textContent();
  };

  await setPreferences(page, headers, { ownerName: '', timeZone: 'America/Sao_Paulo' });
  expect(await greetingAt(atSaoPaulo(4, 59))).toBe('Boa noite');
  expect(await greetingAt(atSaoPaulo(5, 0))).toBe('Bom dia');
  expect(await greetingAt(atSaoPaulo(11, 59))).toBe('Bom dia');
  expect(await greetingAt(atSaoPaulo(12, 0))).toBe('Boa tarde');
  expect(await greetingAt(atSaoPaulo(17, 59))).toBe('Boa tarde');
  expect(await greetingAt(atSaoPaulo(18, 0))).toBe('Boa noite');

  // O nome aparece depois da vírgula quando "Como te chamar" está preenchido.
  await setPreferences(page, headers, { ownerName: 'Marco' });
  expect(await greetingAt(atSaoPaulo(8))).toBe('Bom dia, Marco');
  expect(await greetingAt(atSaoPaulo(21))).toBe('Boa noite, Marco');

  // O fuso é o do dono, não o do navegador (que segue em São Paulo): 14h em São Paulo são 2h do dia seguinte em Tóquio.
  expect(await greetingAt(atSaoPaulo(14))).toBe('Boa tarde, Marco');
  await setPreferences(page, headers, { timeZone: 'Asia/Tokyo' });
  expect(await greetingAt(atSaoPaulo(14))).toBe('Boa noite, Marco');
  await setPreferences(page, headers, { timeZone: 'America/Sao_Paulo', ownerName: '' });
  expect(problems).toEqual([]);
});

test('abrir o Início não cria sessão; o texto não enviado volta ao recarregar; a falha mantém o texto; enviar cria a sessão, envia e abre a conversa (A8)', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const problems = watchPage(page);
  await seed(page);
  const headers = await apiHeaders(page);
  await page.setViewportSize(MOBILE);
  await page.clock.setFixedTime(atSaoPaulo(14));

  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && request.url().includes('/api/chat/sessions')) writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  const before = await listedSessionIds(page, headers);

  await page.goto('/');
  await expect(field(page)).toBeEnabled();
  await field(page).fill('Ini pergunta direta ao Aion');
  // Abrir o Início e digitar não abrem sessão nenhuma (nenhuma escrita em /api/chat/sessions) e a lista de sessões fica igual; o texto fica no aparelho.
  expect(writes).toEqual([]);
  expect(await listedSessionIds(page, headers)).toEqual(before);
  await expect.poll(() => page.evaluate((key) => window.localStorage.getItem(key), DRAFT_KEY)).toBe('Ini pergunta direta ao Aion');

  // Recarregar devolve o texto não enviado.
  await page.reload();
  await expect(field(page)).toHaveValue('Ini pergunta direta ao Aion');
  await expect(field(page)).toBeEnabled();

  // Falha no envio (resposta simulada): o motivo aparece acima do campo e o texto e a página ficam; o rascunho invisível não vira sessão visível.
  await page.route('**/api/chat/sessions/*/messages', (route) =>
    route.fulfill({ status: 422, json: { code: 'MODEL_UNAVAILABLE', message: ERROR_CODES.MODEL_UNAVAILABLE.message } }),
  );
  await page.getByRole('button', { name: 'Enviar mensagem' }).click();
  const alert = page.getByRole('alert').filter({ hasText: ERROR_CODES.MODEL_UNAVAILABLE.message });
  await expect(alert).toBeVisible();
  await expect(field(page)).toHaveValue('Ini pergunta direta ao Aion');
  await expect(page).toHaveURL(/\/$/);
  expect(await page.evaluate((key) => window.localStorage.getItem(key), DRAFT_KEY)).toBe('Ini pergunta direta ao Aion');
  expect(await listedSessionIds(page, headers)).toEqual(before);
  await attachShot(page, testInfo, 'inicio-falha-no-envio-375');
  await page.unroute('**/api/chat/sessions/*/messages');

  // Enviar de novo: abre a sessão (o mesmo rascunho), envia e navega para a conversa; o texto guardado sai.
  await page.getByRole('button', { name: 'Enviar mensagem' }).click();
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
  const id = new URL(page.url()).pathname.split('/').pop() as string;
  await expect(page.getByRole('log', { name: 'Conversa' })).toContainText('Resposta: Ini pergunta direta ao Aion');
  expect(await page.evaluate((key) => window.localStorage.getItem(key), DRAFT_KEY)).toBeNull();
  // O padrão do Chat geral vale para a sessão (o modelo e o effort que o campo mostrava) e ela entrou na lista com o título da mensagem.
  await expect(page.getByRole('button', { name: MODEL, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Effort: Médio' })).toBeVisible();
  expect(await listedSessionIds(page, headers)).toContain(id);
  // Escritas feitas pelo Início: abrir o rascunho (uma vez, mesmo com a falha e o novo envio) e enviar a mensagem (a recusada e a aceita).
  expect(writes.filter((write) => write === 'POST /api/chat/sessions')).toHaveLength(1);

  // De volta ao Início: o campo vazio (a sessão nova está na lista da API, conferida acima; o Início não lista chats).
  await page.goto('/');
  await expect(field(page)).toHaveValue('');
  expect(problems).toEqual([`422 POST /api/chat/sessions/${id}/messages`]);
});

test('o modelo e o effort escolhidos no Início valem só para a sessão que ele abre e o padrão do Chat geral não muda (A8)', async ({ page }) => {
  test.setTimeout(120_000);
  const problems = watchPage(page);
  await seed(page);
  const headers = await apiHeaders(page);
  const chatDefault = async () => (await (await page.context().request.get(`${ORIGIN}/api/chat/settings`, { headers })).json()) as { model: string | null; effort: string | null };
  expect(await chatDefault()).toMatchObject({ model: MODEL, effort: 'medium' });
  await page.setViewportSize(DESKTOP);

  // Effort: de "Médio" (o padrão) para "Alto", só na tela do Início.
  await page.goto('/');
  await expect(field(page)).toBeEnabled();
  await page.getByRole('button', { name: 'Effort: Médio' }).click();
  const slider = page.getByRole('dialog', { name: 'Effort', exact: true }).getByRole('slider', { name: 'Effort' });
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuetext', 'Alto');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Effort: Alto' })).toBeVisible();
  expect(await chatDefault()).toMatchObject({ model: MODEL, effort: 'medium' }); // nada foi gravado só por escolher
  await field(page).fill('Ini com effort alto');
  await field(page).press('Enter');
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('log', { name: 'Conversa' })).toContainText('Resposta: Ini com effort alto');
  await expect(page.getByRole('button', { name: 'Effort: Alto' })).toBeVisible();
  expect(await chatDefault()).toMatchObject({ model: MODEL, effort: 'medium' });

  // Modelo: outro modelo (sem níveis de effort) só para a próxima sessão.
  await page.goto('/');
  await expect(field(page)).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Effort: Médio' })).toBeVisible(); // o campo volta ao padrão do Chat geral
  await page.getByRole('button', { name: MODEL, exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Selecionar modelo' });
  await picker.getByRole('list', { name: 'Modelos do OpenCode Go' }).getByRole('button', { name: /^glm-5\.3-flash( |$)/ }).click();
  await expect(picker.getByRole('list', { name: 'Modelos do OpenCode Go' }).getByRole('button', { name: /^glm-5\.3-flash/ })).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'opencode/glm-5.3-flash', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Effort:/ })).toHaveCount(0);
  await field(page).fill('Ini com outro modelo');
  await page.getByRole('button', { name: 'Enviar mensagem' }).click();
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('log', { name: 'Conversa' })).toContainText('Resposta: Ini com outro modelo');
  await expect(page.getByRole('button', { name: 'opencode/glm-5.3-flash', exact: true })).toBeVisible();
  expect(await chatDefault()).toMatchObject({ model: MODEL, effort: 'medium' });
  expect(problems).toEqual([]);
});

test('anexar abre o rascunho invisível antes do upload (e só então), e o arquivo segue com a mensagem para a conversa (A8)', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const problems = watchPage(page);
  await seed(page);
  const headers = await apiHeaders(page);
  await page.setViewportSize(MOBILE);
  const before = await listedSessionIds(page, headers);
  const calls: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && request.url().includes('/api/chat/sessions')) calls.push(`${request.method()} ${new URL(request.url()).pathname.replace(/[0-9a-f-]{36}/, ':id')}`);
  });

  await page.goto('/');
  await expect(field(page)).toBeEnabled();
  await field(page).fill('Ini com anexo');
  expect(calls).toEqual([]); // nada até aqui

  // Escolher o arquivo é o que abre a sessão: o upload vai para ela.
  await page.getByLabel('Escolher arquivos').setInputFiles({ name: 'nota-inicio.txt', mimeType: 'text/plain', buffer: Buffer.from('Conteúdo da nota do Início') });
  await expect(page.getByLabel('Arquivos anexados').getByText('nota-inicio.txt')).toBeVisible();
  await expect(page.getByLabel('Arquivos anexados').getByText('Lendo…')).toHaveCount(0);
  expect(calls).toEqual(['POST /api/chat/sessions', 'POST /api/chat/sessions/:id/attachments']);
  expect(await listedSessionIds(page, headers)).toEqual(before); // o rascunho segue invisível
  await attachShot(page, testInfo, 'inicio-com-anexo-375');
  await expectNoA11yViolations(page);

  await page.getByRole('button', { name: 'Enviar mensagem' }).click();
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('log', { name: 'Conversa' })).toContainText('Resposta: Ini com anexo');
  await expect(page.getByRole('log', { name: 'Conversa' }).getByText('nota-inicio.txt').first()).toBeVisible();
  // A sessão do rascunho é a mesma do upload: abrir, anexar e enviar usaram uma só (um POST de abertura).
  expect(calls.filter((call) => call === 'POST /api/chat/sessions')).toHaveLength(1);
  expect(problems).toEqual([]);
});

test('o nome gravado em Configurações → Personalização aparece na saudação do Início, e apagá-lo a deixa só com a faixa do dia (T10, A14)', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  await seed(page);
  const headers = await apiHeaders(page);
  await setPreferences(page, headers, { ownerName: '', timeZone: 'America/Sao_Paulo' });
  await page.setViewportSize(MOBILE);
  try {
    // Pela tela: Início sem nome, o campo de Personalização grava "Marco" ("Salvo") e a saudação o usa.
    await page.goto('/');
    await expect(greeting(page)).toHaveText(/^(Bom dia|Boa tarde|Boa noite)$/);
    await page.goto('/configuracoes/personalizacao');
    const name = page.getByRole('textbox', { name: 'Como te chamar' });
    await expect(name).toHaveValue('');
    await name.fill('Marco');
    await name.press('Enter');
    await expect(page.locator('label', { hasText: 'Como te chamar' }).locator('xpath=..').getByText('Salvo', { exact: true })).toBeVisible();
    await page.goto('/');
    await expect(greeting(page)).toHaveText(/^(Bom dia|Boa tarde|Boa noite), Marco$/);
    await attachShot(page, testInfo, 'inicio-saudacao-com-nome-375');
    // Preferências não tem mais o campo do nome.
    await page.goto('/configuracoes/preferencias');
    await expect(page.getByRole('heading', { level: 1, name: 'Preferências' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Como te chamar' })).toHaveCount(0);
    expect(problems).toEqual([]);
  } finally {
    await setPreferences(page, headers, { ownerName: '' });
  }
});

test('Chats tem o mesmo campo "Pergunte ao Aion" no rodapé, acima da barra: abrir não cria sessão, o rascunho é o do Início, e enviar cria a sessão, envia e abre a conversa (T10)', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const problems = watchPage(page);
  await seed(page);
  const headers = await apiHeaders(page);
  await page.setViewportSize(MOBILE);

  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && request.url().includes('/api/chat/sessions')) writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  const before = await listedSessionIds(page, headers);

  await page.goto('/chats');
  await expect(page.getByRole('heading', { level: 1, name: 'Chats' })).toBeVisible();
  await expect(field(page)).toBeEnabled();
  await expect(page.getByRole('button', { name: MODEL, exact: true })).toBeVisible(); // o mesmo composer: seletor de modelo (o padrão do Chat geral), effort, anexo e ditado
  await expect(page.getByRole('button', { name: 'Anexar arquivo' })).toBeVisible();
  // A lista segue ali, e o campo é fixo no rodapé da coluna, ACIMA da barra inferior (que o shell põe fora do `<main>`).
  await expect(chatsList(page).getByRole('link').filter({ hasText: 'Ini chat da semana' })).toBeVisible();
  const form = page.locator('form.composer');
  const formBox = (await form.boundingBox())!;
  const barBox = (await tabBarOf(page).boundingBox())!;
  expect(formBox.y + formBox.height, 'o campo termina acima da barra inferior').toBeLessThanOrEqual(barBox.y + 1);
  expect(barBox.y - (formBox.y + formBox.height), 'o campo fica colado na barra (rodapé da coluna)').toBeLessThan(40);
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'chats-campo-375');
  // Abrir Chats e digitar não abrem sessão nenhuma (nenhuma escrita em /api/chat/sessions) e a lista de sessões fica igual.
  await field(page).fill('Ini rascunho dos chats');
  expect(writes).toEqual([]);
  expect(await listedSessionIds(page, headers)).toEqual(before);
  await expect.poll(() => page.evaluate((key) => window.localStorage.getItem(key), DRAFT_KEY)).toBe('Ini rascunho dos chats');

  // O rascunho é UM só, o do "novo chat": o Início o mostra, e voltar a Chats também.
  await page.goto('/');
  await expect(field(page)).toHaveValue('Ini rascunho dos chats');
  await page.goto('/chats');
  await expect(field(page)).toHaveValue('Ini rascunho dos chats');
  expect(writes).toEqual([]);

  // Enviar abre a sessão (o rascunho invisível), envia e navega para a conversa; o texto guardado sai e a sessão entra na lista.
  await page.getByRole('button', { name: 'Enviar mensagem' }).click();
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
  const id = new URL(page.url()).pathname.split('/').pop() as string;
  await expect(page.getByRole('log', { name: 'Conversa' })).toContainText('Resposta: Ini rascunho dos chats');
  expect(await page.evaluate((key) => window.localStorage.getItem(key), DRAFT_KEY)).toBeNull();
  expect(await listedSessionIds(page, headers)).toContain(id);
  expect(writes.filter((write) => write === 'POST /api/chat/sessions')).toHaveLength(1);

  // "Voltar" leva a Chats: a sessão nova no topo de "Recentes", e o campo vazio.
  await backLink(page).click();
  await expect(page).toHaveURL(/\/chats$/);
  await expect(field(page)).toHaveValue('');
  // Com as seções (phase 18), "Salvos" vem antes: a sessão nova é a primeira de "Recentes" (as não salvas), acima da mais antiga.
  await expect(chatsList(page).getByRole('link').filter({ hasText: 'Ini rascunho dos chats' })).toBeVisible();
  const titles = await chatsList(page).getByRole('link').evaluateAll((links) => links.map((link) => link.getAttribute('title')));
  expect(titles.indexOf('Ini rascunho dos chats')).toBeLessThan(titles.indexOf('Ini chat da semana'));

  // Desktop: o campo no rodapé da coluna, com o painel de sessões ao lado como sempre.
  await page.setViewportSize(DESKTOP);
  await expect(field(page)).toBeVisible();
  await expect(page.getByRole('complementary').getByRole('link').filter({ hasText: 'Ini rascunho dos chats' })).toBeVisible();
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'chats-campo-1280');
  expect(problems).toEqual([]);
});

test('Chats: "Todos | Salvos" mostra só as salvas (filtro do servidor), vive na URL (recarregar e Voltar), cai em Todos com valor desconhecido e tem vazio e erro próprios (T10)', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const problems = watchPage(page);
  const data = await seed(page);
  const headers = await apiHeaders(page);
  const saved = await savedSessionIds(page, headers);
  expect(saved, 'o cenário tem a sessão salva').toContain(data.saved.id);
  await page.setViewportSize(MOBILE);

  // Todos: a lista de sempre (salvas e temporárias), com o aviso da retenção, e a escolha com o nome acessível e o estado selecionado.
  await page.goto('/chats');
  await expect(viewGroup(page)).toBeVisible();
  await expect(viewButton(page, 'Todos')).toHaveAttribute('aria-pressed', 'true');
  await expect(viewButton(page, 'Salvos')).toHaveAttribute('aria-pressed', 'false');
  await expect(chatsList(page).getByRole('link').filter({ hasText: 'Ini chat da semana' })).toBeVisible();
  await expect(chatsList(page).getByRole('heading', { name: 'Recentes' })).toBeVisible();
  await expect(chatsList(page).getByRole('link').filter({ hasText: 'Ini chat para guardar' })).toBeVisible();
  await expect(content(page).getByText(RETENTION_NOTICE)).toBeVisible();
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'chats-todos-375');

  // Salvos: a URL ganha `?vista=salvos` (sem navegar de verdade), só as salvas aparecem (as mesmas da API), sem relógio, só a seção "Salvos" e sem o aviso de 7 dias.
  await viewButton(page, 'Salvos').click();
  await expect(page).toHaveURL(/\/chats\?vista=salvos$/);
  await expect(viewButton(page, 'Salvos')).toHaveAttribute('aria-pressed', 'true');
  await expect(viewButton(page, 'Todos')).toHaveAttribute('aria-pressed', 'false');
  await expect(chatsList(page).getByRole('link').filter({ hasText: 'Ini chat para guardar' })).toBeVisible();
  await expect(chatsList(page).getByRole('link').filter({ hasText: 'Ini chat da semana' })).toHaveCount(0);
  await expect(chatsList(page).getByRole('link')).toHaveCount(saved.length);
  expect(await chatsList(page).getByRole('link').evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).pathname.split('/').pop()))).toEqual(saved);
  await expect(chatsList(page).getByRole('button', { name: /^Apaga em/ })).toHaveCount(0);
  await expect(chatsList(page).getByRole('heading', { name: 'Salvos' })).toBeVisible();
  await expect(chatsList(page).getByRole('heading', { name: 'Recentes' })).toHaveCount(0);
  await expect(content(page).getByText(RETENTION_NOTICE)).toHaveCount(0);
  await expect(field(page)).toBeVisible(); // o campo "Pergunte ao Aion" segue no rodapé nas duas vistas
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'chats-salvos-375');

  // Recarregar mantém a vista (a URL é o estado); abrir um chat da lista e voltar também.
  await page.reload();
  await expect(viewButton(page, 'Salvos')).toHaveAttribute('aria-pressed', 'true');
  await expect(chatsList(page).getByRole('link').filter({ hasText: 'Ini chat para guardar' })).toBeVisible();
  await chatsList(page).getByRole('link').filter({ hasText: 'Ini chat para guardar' }).click();
  await expect(page).toHaveURL(new RegExp(`/chat/${data.saved.id}$`));
  await page.goBack();
  await expect(page).toHaveURL(/\/chats\?vista=salvos$/);
  await expect(viewButton(page, 'Salvos')).toHaveAttribute('aria-pressed', 'true');
  await expect(chatsList(page).getByRole('link').filter({ hasText: 'Ini chat para guardar' })).toBeVisible();

  // Voltar a "Todos" limpa o parâmetro; um valor desconhecido (ou com outra caixa) cai em "Todos" sem quebrar a página.
  await viewButton(page, 'Todos').click();
  await expect(page).toHaveURL(/\/chats$/);
  await expect(viewButton(page, 'Todos')).toHaveAttribute('aria-pressed', 'true');
  for (const value of ['qualquer-coisa', 'Salvos', '']) {
    await page.goto(`/chats?vista=${value}`);
    await expect(viewButton(page, 'Todos'), value).toHaveAttribute('aria-pressed', 'true');
    await expect(chatsList(page).getByRole('link').filter({ hasText: 'Ini chat da semana' }), value).toBeVisible();
  }

  // Vazio próprio: sem salvas (resposta simulada, o banco do teste tem salvas) a frase diz onde salvar, sem o aviso da retenção, e o campo segue ali.
  const savedRoute = /\/api\/chat\/sessions\?saved=true$/;
  await page.route(savedRoute, (route) => route.fulfill({ json: { items: [] } }));
  await page.goto('/chats?vista=salvos');
  await expect(content(page).getByText(SAVED_EMPTY)).toBeVisible();
  await expect(chatsList(page)).toHaveCount(0);
  await expect(content(page).getByText(RETENTION_NOTICE)).toHaveCount(0);
  await expect(field(page)).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'chats-salvos-vazio-375');

  // Erro: a leitura falha (500 simulado), a tela diz e oferece "Tentar novamente"; com a API de volta, a lista aparece.
  await page.unroute(savedRoute);
  await page.route(savedRoute, (route) => route.fulfill({ status: 500, json: { code: 'INTERNAL_ERROR', message: 'Erro interno. Tente novamente.' } }));
  await page.goto('/chats?vista=salvos');
  await expect(content(page).getByText('Não foi possível carregar as sessões.')).toBeVisible();
  await page.unroute(savedRoute);
  await content(page).getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(chatsList(page).getByRole('link').filter({ hasText: 'Ini chat para guardar' })).toBeVisible();
  await expect(content(page).getByText('Não foi possível carregar as sessões.')).toHaveCount(0);

  // Desktop: a vista é da página; o painel de sessões do lado não muda (segue com as sessões temporárias).
  await page.setViewportSize(DESKTOP);
  await page.goto('/chats?vista=salvos');
  await expect(viewButton(page, 'Salvos')).toHaveAttribute('aria-pressed', 'true');
  await expect(chatsList(page).getByRole('link').filter({ hasText: 'Ini chat para guardar' })).toBeVisible();
  await expect(page.getByRole('complementary').getByRole('link').filter({ hasText: 'Ini chat da semana' })).toBeVisible();
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'chats-salvos-1280');
  expect(problems.filter((problem) => problem !== '500 GET /api/chat/sessions')).toEqual([]);
});

test('`/bots` continua abrindo o último bot e a estrela da barra de ícones volta ao Início, sem painel (A11)', async ({ page }) => {
  const problems = watchPage(page);
  const data = await seed(page);
  await apiLogin(page.context()); // cada teste tem um contexto novo: o cenário já existe, mas o login vale para esta tela
  await page.setViewportSize(DESKTOP);

  await page.goto(`/bots/${data.free.id}`);
  await expect(page.getByRole('heading', { level: 1, name: data.free.name })).toBeVisible();
  await page.goto('/bots');
  await expect(page).toHaveURL(`/bots/${data.free.id}`);

  // De uma seção com painel (Rotinas) para o Início pela estrela: a página é o Início e o painel some.
  await page.goto('/rotinas');
  await expect(page.getByRole('complementary')).toBeVisible();
  await rail(page).getByRole('link', { name: 'Início' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(greeting(page)).toBeVisible();
  await expect(page.getByRole('complementary')).toHaveCount(0);
  await expect(rail(page).getByRole('link', { name: 'Início' })).toHaveAttribute('aria-current', 'page');
  await expect(rail(page).getByRole('link', { name: 'Bots' })).not.toHaveAttribute('aria-current', 'page');
  expect(problems).toEqual([]);
});

test('o teclado aberto esconde a barra inferior e o campo sobe; ao fechar a barra volta; foco sem a viewport encolher, ou viewport encolhida sem foco, não a esconde (A6)', async ({ page }, testInfo) => {
  const problems = watchPage(page);
  await seed(page);
  await apiLogin(page.context());
  await page.setViewportSize(MOBILE);
  await page.goto('/');
  await expect(tabBarOf(page)).toBeVisible();
  await expect(field(page)).toBeEnabled();

  // Foco no campo sem o teclado virtual (teclado físico, ou o teclado ainda não abriu): a viewport não encolheu, então a barra fica.
  await field(page).focus();
  await expect(field(page)).toBeFocused();
  await page.waitForTimeout(300);
  await expect(tabBarOf(page)).toBeVisible();

  // Teclado aberto: a viewport visual encolhe com o campo focado, a barra some e o campo continua à vista, acima do "teclado".
  await setKeyboard(page, true);
  await expect(tabBarOf(page)).toHaveCount(0);
  await expect(field(page)).toBeFocused();
  const open = (await field(page).boundingBox())!;
  expect(open.y + open.height, 'o campo cabe acima do teclado').toBeLessThanOrEqual(MOBILE.height - 400);
  expect(open.y, 'o campo está dentro da viewport').toBeGreaterThanOrEqual(0);
  await expectNoHorizontalScroll(page);
  await attachShot(page, testInfo, 'inicio-teclado-aberto-375');

  // O teclado fecha: a barra volta.
  await setKeyboard(page, false);
  await expect(tabBarOf(page)).toBeVisible();

  // Viewport encolhida sem campo em foco (zoom, barra do navegador, rotação) não é teclado: a barra fica.
  await field(page).blur();
  await setKeyboard(page, true);
  await page.waitForTimeout(300);
  await expect(tabBarOf(page)).toBeVisible();
  await setKeyboard(page, false);
  await expect(tabBarOf(page)).toBeVisible();
  expect(problems).toEqual([]);
});

test('o resumo do momento omite a parte zerada e diz "Tudo em dia" quando nada trabalha nem espera (A7)', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const problems = watchPage(page);
  const data = await seed(page);
  const headers = await apiHeaders(page);
  const request = page.context().request;
  await page.setViewportSize(MOBILE);

  /** Pede a parada de uma execução (bot ou sessão do Chat geral); a API recusa com 409 a que já terminou. */
  const stop = async ({ runId, bot, sessionId }: { runId: string; bot: { id: string } | null; sessionId: string | null }): Promise<void> => {
    await request.post(`${ORIGIN}${bot ? `/api/bots/${bot.id}` : `/api/chat/sessions/${sessionId}`}/runs/stop?runId=${runId}`, { headers });
  };
  const botState = async (id: string): Promise<string | undefined> =>
    ((await (await request.get(`${ORIGIN}/api/bots`, { headers })).json()) as { bots: { id: string; runState: string }[] }).bots.find((bot) => bot.id === id)?.runState;

  // Para o bot que trabalha: sobram as 2 aprovações, e a parte dos bots sai do resumo (sem "0 bots trabalhando").
  const view = await activities(page, headers);
  const running = view.items.find((item) => item.bot?.id === data.working.id && item.status === 'running');
  expect(running, 'a execução do bot que trabalha').toBeDefined();
  await stop(running!);
  await expect.poll(() => botState(data.working.id), { timeout: 30_000 }).not.toBe('working');
  await page.goto('/');
  await expect(page.getByText('2 aprovações', { exact: true })).toBeVisible();
  await expect(page.getByText(/^\d+ bots? trabalhando/)).toHaveCount(0);

  // Para as duas aprovações (a do bot e a do Chat geral): nada trabalha e nada espera, então o resumo diz "Tudo em dia" e o cartão da pendência some.
  for (const pending of (await activities(page, headers)).pending) await stop(pending);
  await expect.poll(async () => (await activities(page, headers)).pending.length, { timeout: 30_000 }).toBe(0);
  await page.goto('/');
  await expect(page.getByText('Tudo em dia', { exact: true })).toBeVisible();
  await expect(page.getByText(/^\d+ aprovaç(ão|ões)/)).toHaveCount(0);
  await expect(pendingCard(page)).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'inicio-tudo-em-dia-375');
  expect(problems).toEqual([]);
});

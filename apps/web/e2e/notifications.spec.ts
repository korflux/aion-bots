// E2E do web push e da PWA (T10; A13, A7 em parte; F14) no navegador real, contra a pilha de produção (Postgres, API, worker, Next e proxy)
// com o OpenCode Go e o FCM FALSOS. O que é fingido, e por quê:
//   - A permissão do navegador e o PushManager: o Chromium sem tela nega a permissão e não tem serviço de push, então um script de
//     inicialização reproduz o contrato da API de Notificações e do PushManager (permissão que vai de "default" a "granted" ao pedir, e
//     uma assinatura fixa). O SDK do Firebase roda de VERDADE por cima disso.
//   - Os dois domínios do Google que o SDK contata (instalação e registro do token) são respondidos aqui, com a CSP da página em vigor:
//     se a CSP bloqueasse algum, o registro falharia e a violação apareceria (prova que ela libera só o necessário).
//   - O FCM do servidor é o falso da pilha: o worker REAL envia a ele, e o spec lê o que ele recebeu.
// A entrega do push ao aparelho é simulada pelo DevTools (`ServiceWorker.deliverPushMessage`) com a mesma mensagem que o worker enviou ao
// FCM falso, e o toque, pelo evento `notificationclick` disparado no service worker. A prova real (Firebase do dono, desktop e Android) é da
// task. Os dispositivos são estado GLOBAL, então o arquivo é serial e cada teste começa sem nenhum.
// A matriz de silenciar (T13) é provada aqui também: a tela em 1440 e 375 px e o efeito no worker real (o tipo silenciado não chega ao FCM
// falso e os demais chegam).
// Dois aparelhos (phase 3, T4; A1, A3 a A6): dois contextos de navegador, cada um com a sua sessão de login e o seu service worker, mostram a
// decisão do servidor no envio (presença, abertura do app, aprovação resolvida), a conferência do service worker na chegada (fecha as
// obsoletas, falha aberta sem resposta) e o "app aberto" que encerra os avisos. As asserções são pelo `getNotifications()` de cada aparelho e
// pelo banco (controle da pilha, `GET /push-events`); toda espera é por uma condição observável (resposta, mensagem no FCM falso, estado).
// O segundo plano é simulado na página (`visibilityState` "hidden" e o evento `visibilitychange`): o Chromium sem tela não oculta abas.
import type { Browser, BrowserContext, Page, Response, Route, TestInfo } from '@playwright/test';
import { E2E_FIREBASE_WEB_CONFIG, E2E_ORIGIN, E2E_PORTS } from '../../../tests/support/e2e-env';
import {
  CLIENT_IP_HEADER,
  ORIGIN,
  apiHeaders,
  apiLogin,
  clientIpFor,
  attachShot,
  ensureCredential,
  expect,
  expectNoA11yViolations,
  expectNoHorizontalScroll,
  releaseConnectorAccounts,
  test,
  uniqueBotName,
  watchPage,
} from './support/fixtures';

test.describe.configure({ mode: 'serial' });

const FAKES = `http://127.0.0.1:${E2E_PORTS.fakes}`;
const CONTROL = `http://127.0.0.1:${E2E_PORTS.control}`;
const PROVIDER_KEY = 'valid-e2e-push-1111';
const CONNECTOR_KEY = 'valid-e2e-composio-2222';

interface FcmMessage {
  token: string;
  data: Record<string, string>;
  message: Record<string, unknown>;
  status: number;
}

/**
 * Prepara o navegador: permissão inicial do site e o PushManager fixo. A escolha da permissão fica no `localStorage`, então sobrevive a
 * recargas como num navegador de verdade, e `requestPermission` só concede se ainda estava em "default" (negado continua negado).
 */
async function prepareBrowserPush(context: BrowserContext, initial: 'default' | 'denied'): Promise<void> {
  await context.addInitScript(
    ({ initialPermission }) => {
      const KEY = 'e2e:permission';
      if (localStorage.getItem(KEY) === null) localStorage.setItem(KEY, initialPermission);
      Object.defineProperty(Notification, 'permission', { configurable: true, get: () => localStorage.getItem(KEY) });
      Notification.requestPermission = async () => {
        if (localStorage.getItem(KEY) === 'default') localStorage.setItem(KEY, 'granted');
        return localStorage.getItem(KEY) as NotificationPermission;
      };
      const bytes = (length: number, seed: number) => Uint8Array.from({ length }, (_, index) => (seed + index) % 256).buffer;
      const subscription = () => ({
        endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-endpoint',
        expirationTime: null,
        options: { userVisibleOnly: true, applicationServerKey: bytes(65, 4) },
        getKey: (name: string) => (name === 'auth' ? bytes(16, 1) : bytes(65, 2)),
        toJSON() {
          return { endpoint: this.endpoint, keys: {} };
        },
        unsubscribe: async () => {
          localStorage.removeItem('e2e:subscription');
          return true;
        },
      });
      PushManager.prototype.getSubscription = async () => (localStorage.getItem('e2e:subscription') ? (subscription() as unknown as PushSubscription) : null);
      PushManager.prototype.subscribe = async () => {
        localStorage.setItem('e2e:subscription', '1');
        return subscription() as unknown as PushSubscription;
      };
    },
    { initialPermission: initial },
  );
}

/** Responde, com os cabeçalhos CORS que um domínio de outra origem exige, os dois serviços do Google que o SDK do Firebase contata. */
async function mockFirebaseServices(context: BrowserContext, fcmToken: string, requests: string[]): Promise<void> {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
  const answer = (body: unknown) => async (route: import('@playwright/test').Route) => {
    requests.push(`${route.request().method()} ${new URL(route.request().url()).hostname}`);
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  };
  await context.route(
    'https://firebaseinstallations.googleapis.com/**',
    answer({ name: 'projects/aion-e2e/installations/e2e-fid', fid: 'e2e-fid', refreshToken: 'e2e-refresh', authToken: { token: 'e2e-auth', expiresIn: '604800s' } }),
  );
  await context.route('https://fcmregistrations.googleapis.com/**', answer({ token: fcmToken }));
}

type ApiHeaders = Awaited<ReturnType<typeof apiHeaders>>;

/**
 * Cabeçalhos da API capturados UMA vez, antes de a página carregar. Chamar `apiHeaders` de novo faria outro login, que troca o cookie de
 * sessão do contexto: o token CSRF que a página já tem passaria a não valer mais e o próximo clique dela receberia 403.
 */
async function startApi(page: Page) {
  const headers: ApiHeaders = await apiHeaders(page);
  const request = page.context().request;
  const devices = async () => ((await (await request.get(`${ORIGIN}/api/push/devices`, { headers })).json()) as { devices: { id: string; label: string }[] }).devices;
  return {
    headers,
    devices,
    /** Remove todos os dispositivos (estado global) pela API, para o teste começar do zero. */
    async clearDevices() {
      for (const device of await devices()) expect((await request.delete(`${ORIGIN}/api/push/devices/${device.id}`, { headers })).status()).toBe(204);
    },
    /** Cria o bot com o `name` dado; os testes passam um nome de `uniqueBotName` (E29), que também é o título do aviso e o rótulo na matriz. */
    async createBot(name: string): Promise<string> {
      const response = await request.post(`${ORIGIN}/api/bots`, { headers, data: { name, color: '#60A5FA', instructions: '', model: 'opencode/glm-5.1', effort: null, stepLimit: 25 } });
      expect(response.status(), `criar o bot ${name}`).toBe(201);
      return ((await response.json()) as { id: string }).id;
    },
    /** Envia a mensagem e devolve o id da execução criada. */
    async sendMessage(botId: string, content: string): Promise<string> {
      const response = await request.post(`${ORIGIN}/api/bots/${botId}/messages`, { headers, data: { content } });
      expect(response.status(), 'enviar a mensagem').toBe(201);
      return ((await response.json()) as { id: string }).id;
    },
    /** Espera a execução terminar com sucesso (lida em Atividades, que lista as execuções de todos os bots). */
    async waitForCompleted(runId: string): Promise<void> {
      await expect
        .poll(async () => {
          const page = (await (await request.get(`${ORIGIN}/api/activities`, { headers })).json()) as { items: { runId: string; status: string }[] };
          return page.items.find((item) => item.runId === runId)?.status;
        }, { timeout: 30_000 })
        .toBe('completed');
    },
    /** Registra um dispositivo pelo token, como a web faz depois de obter o do FCM (o FCM falso aceita qualquer token sem prefixo especial). */
    async registerDevice(token: string): Promise<void> {
      expect((await request.post(`${ORIGIN}/api/push/devices`, { headers, data: { token } })).status()).toBe(200);
    },
    /** Cria uma rotina diária do bot e a dispara agora (o "Executar agora" da tela); devolve o id da rotina, para apagá-la no fim. */
    async runRoutineNow(botId: string, name: string): Promise<string> {
      const created = await request.post(`${ORIGIN}/api/routines`, {
        headers,
        data: { name, botId, instruction: `Instrução de ${name}`, schedule: { type: 'daily', times: ['07:00'] }, timezone: 'America/Sao_Paulo', startsAt: null, endsAt: null, maxRuns: null },
      });
      expect(created.status(), `criar a rotina ${name}`).toBe(201);
      const routineId = ((await created.json()) as { id: string }).id;
      expect((await request.post(`${ORIGIN}/api/routines/${routineId}/run`, { headers })).status(), 'executar a rotina agora').toBe(202);
      return routineId;
    },
    /** Apaga a rotina criada pelo teste (o painel de rotinas lista todas, e uma diária esquecida dispararia às 7 h). */
    async deleteRoutine(routineId: string): Promise<void> {
      expect((await request.delete(`${ORIGIN}/api/routines/${routineId}`, { headers })).status()).toBe(204);
    },
    /** Espera o cartão de aprovação pendente do bot e o responde pela API, como o dono faria em outro aparelho. */
    async respondToPendingApproval(botId: string, decision: string): Promise<void> {
      let approvalId = '';
      await expect
        .poll(
          async () => {
            const snapshot = (await (await request.get(`${ORIGIN}/api/bots/${botId}/conversation`, { headers })).json()) as {
              items: { card?: { type: string; status: string; approvalId: string } }[];
            };
            approvalId = snapshot.items.find((item) => item.card?.type === 'approval' && item.card.status === 'pending')?.card?.approvalId ?? '';
            return approvalId;
          },
          { timeout: 20_000 },
        )
        .not.toBe('');
      expect((await request.post(`${ORIGIN}/api/approvals/${approvalId}/respond`, { headers, data: { decision } })).status(), `responder ${decision}`).toBe(200);
    },
  };
}

/** Mensagens que o FCM falso recebeu para um token, em ordem. */
async function fcmMessagesFor(token: string): Promise<FcmMessage[]> {
  const all = (await (await fetch(`${FAKES}/fcm/__messages`)).json()) as FcmMessage[];
  return all.filter((message) => message.token === token);
}

/** Espera o FCM falso ter recebido `count` avisos do bot `title` para o token e os devolve em ordem (outros bots do arquivo são ignorados). */
async function sentFor(token: string, title: string, count: number): Promise<FcmMessage[]> {
  const ofBot = async () => (await fcmMessagesFor(token)).filter((message) => message.data.title === title);
  await expect.poll(async () => (await ofBot()).length, { timeout: 30_000 }).toBe(count);
  return ofBot();
}

/** Desfecho dos avisos de um bot na caixa de saída e a posição de leitura da conversa dele, lidos do banco pelo controle da pilha. */
interface PushEventsOfBot {
  events: { id: string; kind: string; status: string; dropReason: string | null }[];
  readThrough: string | null;
}

async function pushEventsOf(botId: string): Promise<PushEventsOfBot> {
  const response = await fetch(`${CONTROL}/push-events?botId=${botId}`);
  expect(response.status, 'ler push_events pelo controle da pilha').toBe(200);
  return (await response.json()) as PushEventsOfBot;
}

/** É a resposta do "app aberto" (`PUT /api/push/opened`)? */
const isAppOpen = (response: Response) => new URL(response.url()).pathname === '/api/push/opened' && response.request().method() === 'PUT';

/** Abre uma tela do app com carga completa e espera o servidor gravar a abertura (204), para os eventos seguintes serem posteriores a ela. */
async function openApp(page: Page, path: string): Promise<void> {
  const opened = page.waitForResponse(isAppOpen);
  await page.goto(path);
  expect((await opened).status(), `app aberto em ${path}`).toBe(204);
}

/** Abre a conversa do bot e espera a abertura e a presença (o dono olhando a conversa, com a janela visível e em foco) gravadas. */
async function openConversation(page: Page, botId: string): Promise<void> {
  const present = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/presence' && response.request().method() === 'PUT' && (response.request().postDataJSON() as { present: boolean }).present,
  );
  await openApp(page, `/bots/${botId}`);
  expect((await present).status(), 'presença na conversa').toBe(204);
}

/**
 * Leva a página do app ao segundo plano ou de volta (a tela do celular apagada e acesa). O Chromium sem tela mantém toda aba visível, então
 * a página passa a informar o estado pedido e recebe o `visibilitychange`, como num aparelho; é o que o app lê para "app aberto" e presença.
 */
async function setVisibility(page: Page, state: 'hidden' | 'visible'): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

/** Notificação exibida num aparelho, reduzida ao que as asserções comparam: a tag (conversa e categoria) e o evento que ela avisa. */
interface ShownNotice {
  tag: string;
  eventId: string | null;
}

/**
 * Um aparelho do dono na prova: a página do app (com o service worker do app ativo) e a entrega de push pelo DevTools, com a mesma mensagem
 * que o worker enviou ao FCM falso. `shown` lê as notificações exibidas neste aparelho; `checkOf` espera a conferência do service worker que
 * pede o evento dado (a requisição do service worker aparece no contexto do navegador).
 */
async function deviceOf(page: Page) {
  const context = page.context();
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state ?? null)).toBe('activated');
  const cdp = await context.newCDPSession(page);
  const registrations: { registrationId: string; scopeURL: string }[] = [];
  cdp.on('ServiceWorker.workerRegistrationUpdated', (event) => registrations.push(...event.registrations));
  await cdp.send('ServiceWorker.enable');
  await expect.poll(() => registrations.find((entry) => entry.scopeURL.startsWith(E2E_ORIGIN))?.registrationId).toBeTruthy();
  const registrationId = registrations.find((entry) => entry.scopeURL.startsWith(E2E_ORIGIN))?.registrationId as string;
  return {
    async deliver(message: FcmMessage): Promise<void> {
      await cdp.send('ServiceWorker.deliverPushMessage', {
        origin: E2E_ORIGIN,
        registrationId,
        data: JSON.stringify({ data: message.data, from: E2E_FIREBASE_WEB_CONFIG.messagingSenderId, fcmMessageId: `e2e-${message.data.eventId}` }),
      });
    },
    shown: (): Promise<ShownNotice[]> =>
      page.evaluate(async () =>
        (await (await navigator.serviceWorker.ready).getNotifications()).map((item) => ({ tag: item.tag, eventId: (item.data as { eventId?: string }).eventId ?? null })),
      ),
    checkOf: (eventId: string): Promise<Response> =>
      context.waitForEvent(
        'response',
        (response) => new URL(response.url()).pathname === '/api/push/events/check' && new URL(response.url()).searchParams.get('ids')?.split(',')[0] === eventId,
      ),
  };
}

// Tag das respostas e rotinas: uma por conversa. A das aprovações é uma por APROVAÇÃO (`aion-approval-<id da aprovação>`, phase 16) e o teste a lê da mensagem do FCM.
const activityTag = (botId: string) => `aion-activity-${botId}`;
const APPROVAL_TAG = /^aion-approval-\d+$/;

const notice = (page: Page) => page.getByRole('region', { name: 'Aviso de notificações' });
const enableButton = (scope: Page | ReturnType<typeof notice>) => scope.getByRole('button', { name: 'Ativar notificações' });

test.describe('ativar, renovar e remover o dispositivo', () => {
  test('o aviso do shell registra o navegador pelo SDK do Firebase sob a CSP, a lista mostra o dispositivo e remover o desliga de vez', async ({ page, context }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const problems = watchPage(page);
    const violations: string[] = [];
    page.on('console', (message) => {
      if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
    });
    const googleCalls: string[] = [];
    const fcmToken = `e2e-fcm-token-${testInfo.workerIndex}-ativar`;
    await prepareBrowserPush(context, 'default');
    await mockFirebaseServices(context, fcmToken, googleCalls);
    const api = await startApi(page);
    await api.clearDevices();

    await page.goto('/bots');
    await expect(notice(page)).toBeVisible();
    await expect(notice(page)).toContainText('Receba um aviso quando um bot terminar, falhar ou pedir a sua aprovação.');
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'notificacoes-aviso-1440');

    await enableButton(notice(page)).click();
    await expect(notice(page)).toBeHidden();

    await page.goto('/configuracoes/notificacoes');
    await expect(page.getByRole('heading', { name: 'Notificações', level: 1 })).toBeVisible();
    await expect(page.getByText('Ativadas', { exact: true })).toBeVisible();
    const row = page.getByRole('listitem').filter({ hasText: 'Chrome no Windows' });
    await expect(row).toHaveCount(1);
    await expect(row.getByText('Este navegador')).toBeVisible();
    // O token do FCM nunca vai para a tela nem para a lista da API.
    await expect(page.locator('body')).not.toContainText(fcmToken);
    expect(JSON.stringify(await api.devices())).not.toContain(fcmToken);
    // O SDK falou só com os dois domínios liberados na CSP, e a CSP não bloqueou nada.
    expect([...new Set(googleCalls.map((call) => call.split(' ')[1]))].sort()).toEqual(['fcmregistrations.googleapis.com', 'firebaseinstallations.googleapis.com']);
    expect(violations).toEqual([]);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'notificacoes-ativas-1440');

    // Recarregar renova o registro sem duplicar: continua um só dispositivo, o mesmo, e o aviso não volta.
    const before = await api.devices();
    await page.reload();
    await expect(page.getByText('Ativadas', { exact: true })).toBeVisible();
    await expect.poll(async () => (await api.devices()).map((device) => device.id)).toEqual(before.map((device) => device.id));

    // Remover ESTE dispositivo o apaga e impede a sincronização silenciosa de registrá-lo de novo.
    await row.getByRole('button', { name: 'Remover Chrome no Windows' }).click();
    await expect(page.getByText('Dispositivo removido')).toBeVisible();
    await expect(page.getByText('Nenhum dispositivo registrado.')).toBeVisible();
    await expect(enableButton(page)).toBeVisible();
    await page.reload();
    await expect(enableButton(page)).toBeVisible();
    await expect(page.getByText('Nenhum dispositivo registrado.')).toBeVisible();
    expect(await api.devices()).toEqual([]);

    // E ativar de novo funciona (o dono mudou de ideia): volta como o mesmo navegador.
    await enableButton(page).click();
    await expect(page.getByText('Ativadas', { exact: true })).toBeVisible();
    expect(await api.devices()).toHaveLength(1);

    expect(problems).toEqual([]);
  });

  test('"Agora não" dispensa o aviso neste navegador, e ele não volta em outra página', async ({ page, context }, testInfo) => {
    await prepareBrowserPush(context, 'default');
    await mockFirebaseServices(context, `e2e-fcm-token-${testInfo.workerIndex}-dispensar`, []);
    await (await startApi(page)).clearDevices();
    await page.goto('/bots');
    await expect(notice(page)).toBeVisible();
    await notice(page).getByRole('button', { name: 'Agora não' }).click();
    await expect(notice(page)).toBeHidden();
    await page.goto('/rotinas');
    await expect(page.getByRole('heading', { name: 'Rotinas', level: 1 })).toBeVisible();
    await expect(notice(page)).toBeHidden();
    // Em Configurações o aviso é a própria tela, então o botão continua lá.
    await page.goto('/configuracoes/notificacoes');
    await expect(enableButton(page)).toBeVisible();
  });
});

test.describe('permissão negada no navegador', () => {
  for (const [name, viewport] of [
    ['1440', { width: 1440, height: 900 }],
    ['375', { width: 375, height: 812 }],
  ] as const) {
    test(`mostra a faixa de instrução em ${name} px e não oferece ativar, nem no aviso do shell`, async ({ page, context }, testInfo) => {
      await page.setViewportSize(viewport);
      await prepareBrowserPush(context, 'denied');
      await (await startApi(page)).clearDevices();

      await page.goto('/bots');
      await expect(page.getByRole('heading', { name: 'Bots', level: 1 })).toBeVisible();
      await expect(notice(page)).toBeHidden();

      await page.goto('/configuracoes/notificacoes');
      const banner = page.getByRole('status').filter({ hasText: 'bloqueadas neste navegador' });
      await expect(banner).toBeVisible();
      await expect(banner).toContainText('Libere nas configurações do site e tente de novo.');
      await expect(enableButton(page)).toHaveCount(0);
      await expect(page.getByText('Nenhum dispositivo registrado.')).toBeVisible();
      await expectNoA11yViolations(page);
      await expectNoHorizontalScroll(page);
      await attachShot(page, testInfo, `notificacoes-negado-${name}`);
    });
  }
});

test.describe('lista de dispositivos em 375 px', () => {
  test('mostra o dispositivo com "Remover" sem rolagem horizontal e o aviso do shell cabe na largura', async ({ page, context }, testInfo) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await prepareBrowserPush(context, 'default');
    await mockFirebaseServices(context, `e2e-fcm-token-${testInfo.workerIndex}-mobile`, []);
    await (await startApi(page)).clearDevices();

    await page.goto('/bots');
    await expect(notice(page)).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'notificacoes-aviso-375');
    await enableButton(notice(page)).click();
    await expect(notice(page)).toBeHidden();

    await page.goto('/configuracoes/notificacoes');
    await expect(page.getByText('Ativadas', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remover Chrome no Windows' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'notificacoes-ativas-375');
  });
});

test.describe('o push de ponta a ponta', () => {
  test('o worker envia ao FCM só o nome do bot e o tipo, o service worker mostra a notificação e o toque abre a resposta na conversa', async ({ page, context }, testInfo) => {
    const problems = watchPage(page);
    const fcmToken = `e2e-fcm-token-${testInfo.workerIndex}-ponta`;
    await context.grantPermissions(['notifications'], { origin: E2E_ORIGIN });
    await prepareBrowserPush(context, 'default');
    await mockFirebaseServices(context, fcmToken, []);
    await ensureCredential(page, 'provider', PROVIDER_KEY);
    const api = await startApi(page);
    await api.clearDevices();

    // Ativa pela tela e recarrega para o service worker (já ativo) passar a controlar a aba, como numa visita seguinte.
    await page.goto('/configuracoes/notificacoes');
    await enableButton(page).click();
    await expect(page.getByText('Ativadas', { exact: true })).toBeVisible();
    // A recarga é uma abertura do app (phase 3, T4): o evento do bot só vale se for posterior a ela, então espera a abertura gravada.
    const opened = page.waitForResponse(isAppOpen);
    await page.reload();
    expect((await opened).status()).toBe(204);
    await expect(page.getByText('Ativadas', { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

    // Um bot conclui uma execução: o worker de verdade grava o evento junto do desfecho e o despachante o envia ao FCM falso.
    const botName = uniqueBotName('Bot do aviso');
    const botId = await api.createBot(botName);
    await api.sendMessage(botId, 'conteudo-privado-da-conversa-98765');
    await expect.poll(async () => (await fcmMessagesFor(fcmToken)).length, { timeout: 30_000 }).toBe(1);
    const [sent] = await fcmMessagesFor(fcmToken);
    expect(sent?.status).toBe(200);
    // `eventId` (phase 3, T3) é o id do evento em `push_events`, que o service worker confere na chegada; a tag é a da conversa e categoria.
    expect(Object.keys(sent?.data ?? {}).sort()).toEqual(['body', 'eventId', 'kind', 'tag', 'title', 'url']);
    expect(sent?.data).toMatchObject({ title: botName, body: 'Execução concluída', kind: 'run_completed', tag: activityTag(botId) });
    expect(sent?.data.eventId).toMatch(/^\d+$/);
    expect(sent?.data.url).toMatch(new RegExp(`^/bots/${botId}\\?mensagem=\\d+$`));
    // A privacidade da tela de bloqueio: nada da conversa (nem a mensagem do dono, nem a resposta que o provedor falso ecoa) vai ao FCM.
    expect(JSON.stringify(sent?.message)).not.toContain('conteudo-privado-da-conversa-98765');

    // Entrega a mesma mensagem ao service worker (o que o FCM faria) e confere a notificação que ele mostra. Com "Mostrar conteúdo" ligado (o padrão, phase 16) o corpo vem da
    // conferência: o começo da resposta do bot (o provedor falso ecoa o pedido), e não o tipo do evento que o FCM levou. O aparelho também registra no servidor o que fez
    // com o aviso (`POST /api/push/receipts`, passos 1 e 2): recebido e exibido aqui, tocado depois do clique, todos aceitos (204) pelo dispositivo registrado pela tela.
    const receipts: { state: string; status: number }[] = [];
    context.on('response', (response) => {
      if (new URL(response.url()).pathname === '/api/push/receipts') receipts.push({ state: (response.request().postDataJSON() as { state: string }).state, status: response.status() });
    });
    await (await deviceOf(page)).deliver(sent as FcmMessage);
    const shown = () =>
      page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((item) => ({ title: item.title, body: item.body, tag: item.tag, url: (item.data as { url: string }).url })));
    await expect.poll(shown).toEqual([{ title: botName, body: 'Resposta: conteudo-privado-da-conversa-98765', tag: sent?.data.tag, url: sent?.data.url }]);
    await expect.poll(() => receipts.map((entry) => entry.state).sort()).toEqual(['received', 'shown']);

    // O toque abre o cartão: a aba existente navega até a conversa do bot, na mensagem indicada.
    const worker = context.serviceWorkers().find((entry) => entry.url().startsWith(E2E_ORIGIN));
    expect(worker, 'service worker do app').toBeDefined();
    // Expressão em texto: o código roda no escopo do service worker, cujos tipos o projeto de testes (DOM) não tem.
    await worker?.evaluate(`(async () => {
      const [notification] = await self.registration.getNotifications();
      self.dispatchEvent(new NotificationEvent('notificationclick', { notification }));
    })()`);
    await page.waitForURL(`**${sent?.data.url}`);
    await expect(page.getByRole('log', { name: 'Conversa' })).toContainText('conteudo-privado-da-conversa-98765');
    await expect.poll(async () => (await shown()).length).toBe(0); // o toque fecha a notificação
    await expect.poll(() => receipts.map((entry) => entry.state).sort()).toEqual(['clicked', 'received', 'shown']);
    expect(receipts.every((entry) => entry.status === 204)).toBe(true);

    // O antigo cenário T17 ("conversa aberta" e "outra tela" reentregando este mesmo aviso) saiu daqui: o toque abriu o app, então este
    // aviso já é anterior à abertura e o servidor o dá como obsoleto. Os dois casos são provados com eventos novos e dois aparelhos em
    // "dois aparelhos" (abaixo), sem espera arbitrária.

    expect(problems).toEqual([]);
  });

  test('um token que o FCM recusa como inválido remove o dispositivo da lista', async ({ page, context }, testInfo) => {
    await prepareBrowserPush(context, 'default');
    await ensureCredential(page, 'provider', PROVIDER_KEY);
    const api = await startApi(page);
    await api.clearDevices();

    const registered = await page.context().request.post(`${ORIGIN}/api/push/devices`, { headers: api.headers, data: { token: `unregistered-e2e-${testInfo.workerIndex}` } });
    expect(registered.status()).toBe(200);
    const deviceId = ((await registered.json()) as { id: string }).id;
    expect((await api.devices()).map((device) => device.id)).toEqual([deviceId]);

    const botId = await api.createBot(uniqueBotName('Bot do token inválido'));
    await api.sendMessage(botId, 'olá');
    await expect.poll(async () => (await api.devices()).length, { timeout: 30_000 }).toBe(0);

    await page.goto('/configuracoes/notificacoes');
    await expect(page.getByText('Nenhum dispositivo registrado.')).toBeVisible();
  });
});

/**
 * Dois aparelhos do dono (phase 3, T4): o aparelho A é o `page` do teste; o B é outro contexto de navegador com a SUA sessão de login (cada
 * aparelho é uma sessão, AUTH-03) e o seu service worker. Os dois têm a permissão de notificações concedida (o service worker precisa dela para
 * mostrar) e o PushManager falso com "negado" na página, para a web não tentar o SDK do Firebase: os dois tokens são registrados pela API,
 * e o worker real envia a cada um no FCM falso.
 */
async function twoDevices(page: Page, browser: Browser, testInfo: TestInfo) {
  await page.context().grantPermissions(['notifications'], { origin: E2E_ORIGIN });
  await prepareBrowserPush(page.context(), 'denied');
  await ensureCredential(page, 'provider', PROVIDER_KEY);
  const api = await startApi(page);
  await api.clearDevices();
  const tokens = { a: `e2e-aparelho-a-${testInfo.workerIndex}`, b: `e2e-aparelho-b-${testInfo.workerIndex}` };
  await api.registerDevice(tokens.a);
  await api.registerDevice(tokens.b);

  const contextB = await browser.newContext({
    baseURL: E2E_ORIGIN,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    extraHTTPHeaders: { [CLIENT_IP_HEADER]: clientIpFor(`${testInfo.testId}:${testInfo.retry}:b`) },
  });
  await contextB.grantPermissions(['notifications'], { origin: E2E_ORIGIN });
  await prepareBrowserPush(contextB, 'denied');
  await apiLogin(contextB);
  return { api, tokens, contextB, pageB: await contextB.newPage() };
}

test.describe('dois aparelhos: o servidor decide no envio, o service worker confere na chegada e abrir o app encerra (phase 3, T4)', () => {
  test('conversa em foco não avisa ninguém; outra conversa, outra tela, segundo plano e rotina avisam; o aviso novo substitui; abrir o app no A encerra os avisos antigos no B', async ({ page, browser }, testInfo) => {
    const { api, tokens, contextB, pageB } = await twoDevices(page, browser, testInfo);
    let routineId: string | null = null;
    try {
      const problems = watchPage(page);
      const problemsB = watchPage(pageB);
      const focused = uniqueBotName('Bot em foco');
      const focusedId = await api.createBot(focused);
      const beside = uniqueBotName('Bot ao lado');
      const besideId = await api.createBot(beside);
      // Bot só do aviso posterior à abertura: tag própria (o push antigo, se aparecesse, não seria substituído por ele) e nenhuma presença.
      const later = uniqueBotName('Bot depois da abertura');
      const laterId = await api.createBot(later);

      // A1: o dono olha a conversa no A (visível e em foco). A resposta do bot não gera push para nenhum aparelho e termina descartada
      // por presença no banco; o B, em outra tela, também não recebe nada.
      await openConversation(page, focusedId);
      await openApp(pageB, '/rotinas');
      const a = await deviceOf(page);
      const b = await deviceOf(pageB);
      await api.waitForCompleted(await api.sendMessage(focusedId, 'pergunta com a conversa em foco'));
      await expect
        .poll(async () => (await pushEventsOf(focusedId)).events.map((event) => [event.kind, event.status, event.dropReason]))
        .toEqual([['run_completed', 'dropped', 'presence']]);
      expect(await fcmMessagesFor(tokens.a).then((messages) => messages.filter((message) => message.data.title === focused))).toEqual([]);
      expect(await fcmMessagesFor(tokens.b).then((messages) => messages.filter((message) => message.data.title === focused))).toEqual([]);
      expect(await a.shown()).toEqual([]);
      expect(await b.shown()).toEqual([]);

      // A3, outra conversa e outra tela: o A passa a olhar a conversa de outro bot e o B continua em Rotinas. O aviso vai aos dois
      // aparelhos, cada service worker o confere no servidor e os dois o mostram com a tag da conversa e categoria.
      await openConversation(page, besideId);
      await api.sendMessage(focusedId, 'pergunta com o dono em outra conversa');
      const [first] = await sentFor(tokens.a, focused, 1);
      await sentFor(tokens.b, focused, 1);
      await a.deliver(first as FcmMessage);
      await b.deliver(first as FcmMessage);
      const firstNotice = { tag: activityTag(focusedId), eventId: first?.data.eventId };
      await expect.poll(a.shown).toEqual([firstNotice]);
      await expect.poll(b.shown).toEqual([firstNotice]);

      // A3, segundo plano e rotina; A4, substituição: com o B em segundo plano, a rotina do mesmo bot conclui. O aviso dela é da mesma
      // conversa e categoria, então SUBSTITUI o anterior no B em vez de empilhar.
      await setVisibility(pageB, 'hidden');
      routineId = await api.runRoutineNow(focusedId, uniqueBotName('Rotina do aviso'));
      const [, fromRoutine] = await sentFor(tokens.b, focused, 2);
      await b.deliver(fromRoutine as FcmMessage);
      await expect.poll(b.shown).toEqual([{ tag: activityTag(focusedId), eventId: fromRoutine?.data.eventId }]);
      await expect.poll(async () => (await pushEventsOf(focusedId)).events.map((event) => event.status)).toEqual(['dropped', 'sent', 'sent']);

      // A6: um aviso sai enquanto ninguém olha a conversa, mas só chega ao B depois de o dono abrir o app no A. Abrir fecha as notificações
      // do A e grava a abertura sem marcar a conversa como lida (a posição de leitura no banco não muda).
      await api.sendMessage(focusedId, 'pergunta antes de abrir o app');
      const [, , beforeOpening] = await sentFor(tokens.b, focused, 3);
      const readBefore = (await pushEventsOf(focusedId)).readThrough;
      await openApp(page, '/bots');
      await expect.poll(a.shown).toEqual([]);
      expect((await pushEventsOf(focusedId)).readThrough).toBe(readBefore);

      // O push antigo chega ao B (que reconecta): a conferência o dá como obsoleto e ele não aparece, e a notificação anterior do B, também
      // anterior à abertura, é fechada na mesma chegada.
      const checked = b.checkOf(beforeOpening?.data.eventId as string);
      await b.deliver(beforeOpening as FcmMessage);
      expect((await checked).status()).toBe(200);
      await expect.poll(b.shown).toEqual([]);

      // Evento posterior à abertura avisa normalmente (A6), e é o ÚNICO no B: o push antigo não apareceu nem depois.
      await api.sendMessage(laterId, 'pergunta depois de abrir o app');
      const [afterOpening] = await sentFor(tokens.b, later, 1);
      await b.deliver(afterOpening as FcmMessage);
      await expect.poll(b.shown).toEqual([{ tag: activityTag(laterId), eventId: afterOpening?.data.eventId }]);

      // O B volta do segundo plano: é uma abertura do app nele, que fecha as notificações deste aparelho.
      const reopened = pageB.waitForResponse(isAppOpen);
      await setVisibility(pageB, 'visible');
      expect((await reopened).status()).toBe(204);
      await expect.poll(b.shown).toEqual([]);

      expect(problems).toEqual([]);
      expect(problemsB).toEqual([]);
    } finally {
      if (routineId !== null) await api.deleteRoutine(routineId);
      await api.clearDevices();
      await contextB.close();
    }
  });

  test('aprovação resolvida depois do envio não aparece; sem resposta da conferência em 3 s o aviso aparece', async ({ page, browser }, testInfo) => {
    // O Composio falso com apps (a chave é estado global; outro spec pode tê-la deixado sem apps, e sem apps não há aprovação) e a regra
    // global de enviar e-mail neutra: sem regra própria do bot, a execução pausa pedindo aprovação.
    await ensureCredential(page, 'connector', CONNECTOR_KEY, { replace: true });
    const { api, tokens, contextB, pageB } = await twoDevices(page, browser, testInfo);
    try {
      const problems = watchPage(page);
      const problemsB = watchPage(pageB);
      await page.context().request.put(`${ORIGIN}/api/approval-rules/GMAIL_SEND_EMAIL`, { headers: api.headers, data: { value: 'neutral' } });
      const approver = uniqueBotName('Bot da aprovação');
      const approverId = await api.createBot(approver);
      // O bot novo nasce sem conta do conector (A15, A16): sem a liberação o `[gmail]` não tem ação a executar e nenhuma aprovação nasce (CONN-02). Cabeçalhos do login único do teste (E22).
      await releaseConnectorAccounts(page, approverId, undefined, api.headers);
      await openApp(page, '/rotinas');
      await openApp(pageB, '/bots');
      const a = await deviceOf(page);
      const b = await deviceOf(pageB);

      // A4: a aprovação pendente é avisada; o dono a nega em outro lugar antes de o push chegar ao B. Na chegada, a conferência a dá como
      // obsoleta e ela não aparece; o aviso seguinte (a execução retomada e concluída) aparece, e é o único.
      await api.sendMessage(approverId, '[gmail] envie o relatório');
      const [pending] = await sentFor(tokens.b, approver, 1);
      expect(pending?.data).toMatchObject({ kind: 'approval_pending' });
      expect(pending?.data.tag).toMatch(APPROVAL_TAG);
      await api.respondToPendingApproval(approverId, 'deny');
      const [, resumed] = await sentFor(tokens.b, approver, 2);
      expect(resumed?.data.tag).toBe(activityTag(approverId));
      const checked = b.checkOf(pending?.data.eventId as string);
      await b.deliver(pending as FcmMessage);
      expect((await checked).status()).toBe(200);
      await b.deliver(resumed as FcmMessage);
      await expect.poll(b.shown).toEqual([{ tag: activityTag(approverId), eventId: resumed?.data.eventId }]);
      await expect.poll(async () => (await pushEventsOf(approverId)).events.map((event) => [event.kind, event.status])).toEqual([
        ['approval_pending', 'sent'],
        [resumed?.data.kind, 'sent'],
      ]);

      // A5, conferência sem resposta: o servidor recebe a consulta do A e nunca responde. Passado o prazo de 3 s, o service worker mostra
      // o aviso (falha aberta), mesmo sendo o da aprovação já resolvida.
      const unanswered: Route[] = [];
      await page.context().route('**/api/push/events/check**', (route) => {
        unanswered.push(route);
      });
      await a.deliver(pending as FcmMessage);
      await expect.poll(a.shown).toEqual([{ tag: pending?.data.tag, eventId: pending?.data.eventId }]);
      expect(unanswered).toHaveLength(1);
      await page.context().unrouteAll({ behavior: 'ignoreErrors' });

      expect(problems).toEqual([]);
      expect(problemsB).toEqual([]);
    } finally {
      await api.clearDevices();
      await contextB.close();
    }
  });
});

/** A tabela da matriz de silenciar e um toggle dela. O nome acessível do toggle é "<tipo> de <origem>", igual nos dois tamanhos de tela. */
const muteMatrix = (page: Page) => page.getByRole('table', { name: 'Avisos por bot e por tipo' });
const muteSwitch = (page: Page, kind: string, owner: string) => page.getByRole('switch', { name: `${kind} de ${owner}`, exact: true });

test.describe('matriz de silenciar (T13, A13)', () => {
  for (const [width, height, name] of [
    [1440, 900, '1440'],
    [375, 812, '375'],
  ] as const) {
    test(`lista os bots e o Chat geral, o toggle silencia um tipo só, a escolha sobrevive a recarregar, e a tela cabe e passa no axe em ${name} px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      const problems = watchPage(page);
      await ensureCredential(page, 'provider', PROVIDER_KEY); // criar um bot com modelo exige o provedor configurado
      const api = await startApi(page);
      const bot = uniqueBotName(`Bot da matriz ${name}`);
      await api.createBot(bot);

      await page.goto('/configuracoes/notificacoes');
      await expect(muteMatrix(page)).toBeVisible();
      await expect(page.getByRole('rowheader', { name: bot })).toBeVisible();
      await expect(page.getByRole('rowheader', { name: 'Chat geral' })).toBeVisible();
      // Um bot novo recebe tudo: os quatro tipos ligados, e o Chat geral também.
      for (const kind of ['Concluída', 'Falha', 'Aprovação pendente', 'Aprovação expirada']) {
        await expect(muteSwitch(page, kind, bot)).toHaveAttribute('aria-checked', 'true');
        await expect(muteSwitch(page, kind, 'Chat geral')).toHaveAttribute('aria-checked', 'true');
      }
      await expectNoHorizontalScroll(page);
      await expectNoA11yViolations(page);
      await attachShot(page, testInfo, `notificacoes-matriz-ligada-${name}`);

      // Desligar "Falha" silencia só esse tipo, só desse bot (nem os outros tipos do bot, nem o Chat geral).
      await muteSwitch(page, 'Falha', bot).click();
      await expect(muteSwitch(page, 'Falha', bot)).toHaveAttribute('aria-checked', 'false');
      await expect(muteSwitch(page, 'Concluída', bot)).toHaveAttribute('aria-checked', 'true');
      await expect(muteSwitch(page, 'Falha', 'Chat geral')).toHaveAttribute('aria-checked', 'true');
      await muteSwitch(page, 'Aprovação pendente', 'Chat geral').click();
      await expect(muteSwitch(page, 'Aprovação pendente', 'Chat geral')).toHaveAttribute('aria-checked', 'false');
      await expectNoHorizontalScroll(page);
      await expectNoA11yViolations(page);
      await attachShot(page, testInfo, `notificacoes-matriz-silenciada-${name}`);

      // A escolha é do servidor: recarregar mantém, e voltar a ligar também persiste.
      await page.reload();
      await expect(muteSwitch(page, 'Falha', bot)).toHaveAttribute('aria-checked', 'false');
      await expect(muteSwitch(page, 'Aprovação pendente', 'Chat geral')).toHaveAttribute('aria-checked', 'false');
      await expect(muteSwitch(page, 'Concluída', bot)).toHaveAttribute('aria-checked', 'true');
      await muteSwitch(page, 'Falha', bot).click();
      await muteSwitch(page, 'Aprovação pendente', 'Chat geral').click();
      await expect(muteSwitch(page, 'Falha', bot)).toHaveAttribute('aria-checked', 'true');
      await expect(muteSwitch(page, 'Aprovação pendente', 'Chat geral')).toHaveAttribute('aria-checked', 'true');
      await page.reload();
      await expect(muteSwitch(page, 'Falha', bot)).toHaveAttribute('aria-checked', 'true');
      await expect(muteSwitch(page, 'Aprovação pendente', 'Chat geral')).toHaveAttribute('aria-checked', 'true');

      expect(problems).toEqual([]);
    });
  }

  test('um tipo silenciado no toggle não gera push no worker, e os demais bots e tipos continuam chegando', async ({ page }, testInfo) => {
    const problems = watchPage(page);
    await ensureCredential(page, 'provider', PROVIDER_KEY);
    const api = await startApi(page);
    await api.clearDevices();
    const token = `e2e-matrix-token-${testInfo.workerIndex}`;
    await api.registerDevice(token);
    const silenced = uniqueBotName('Bot silenciado na matriz');
    const heard = uniqueBotName('Bot ouvido na matriz');
    const silencedId = await api.createBot(silenced);
    const heardId = await api.createBot(heard);
    /** Títulos dos avisos deste teste que já chegaram ao FCM (outros bots do arquivo podem terminar ao mesmo tempo e são ignorados). */
    const titles = async () =>
      (await fcmMessagesFor(token)).map((message) => message.data.title).filter((title) => title === silenced || title === heard);

    await page.goto('/configuracoes/notificacoes');
    await muteSwitch(page, 'Concluída', silenced).click();
    await expect(muteSwitch(page, 'Concluída', silenced)).toHaveAttribute('aria-checked', 'false');

    // O silenciado termina ANTES de o outro começar: se o aviso dele fosse enviado, já estaria na frente do aviso do outro na fila.
    await api.waitForCompleted(await api.sendMessage(silencedId, 'um'));
    await api.waitForCompleted(await api.sendMessage(heardId, 'dois'));
    await expect.poll(titles, { timeout: 30_000 }).toContain(heard);
    expect(await titles()).toEqual([heard]);

    // Voltar a ligar vale para o aviso seguinte.
    await muteSwitch(page, 'Concluída', silenced).click();
    await expect(muteSwitch(page, 'Concluída', silenced)).toHaveAttribute('aria-checked', 'true');
    await api.sendMessage(silencedId, 'três');
    await expect.poll(titles, { timeout: 30_000 }).toEqual([heard, silenced]);

    await api.clearDevices();
    expect(problems).toEqual([]);
  });
});

/** As chaves "Mostrar conteúdo nos avisos" (phase 16) pelo nome acessível, que é o próprio rótulo. */
const contentSwitch = (page: Page, owner: 'dos bots' | 'do Chat geral') => page.getByRole('switch', { name: `Mostrar conteúdo nos avisos ${owner}`, exact: true });

test.describe('chaves "Mostrar conteúdo nos avisos" (phase 16, A13)', () => {
  for (const [width, height, name] of [
    [1440, 900, '1440'],
    [375, 812, '375'],
  ] as const) {
    test(`ligadas por padrão e acima da matriz de silêncio, a escolha persiste ao recarregar, o foco chega pelo teclado, e a tela cabe e passa no axe e no contraste dos tokens em ${name} px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      const problems = watchPage(page);
      await ensureCredential(page, 'provider', PROVIDER_KEY);
      const api = await startApi(page);
      try {
        await page.goto('/configuracoes/notificacoes');
        const bots = contentSwitch(page, 'dos bots');
        const chat = contentSwitch(page, 'do Chat geral');
        await expect(bots).toBeVisible();
        await expect(chat).toBeVisible();
        await expect(muteMatrix(page)).toBeVisible();
        // Padrão ligado nas duas, e as chaves ficam ACIMA da matriz de silêncio.
        await expect(bots).toHaveAttribute('aria-checked', 'true');
        await expect(chat).toHaveAttribute('aria-checked', 'true');
        const switchBox = await bots.boundingBox();
        const matrixBox = await muteMatrix(page).boundingBox();
        expect((switchBox?.y ?? Infinity) < (matrixBox?.y ?? 0), 'as chaves vêm antes da matriz').toBe(true);
        // A ajuda diz o que o desligado faz e o que é do Android.
        await expect(page.getByText('Desligada, o aviso fica genérico: só o nome e o tipo, sem os botões Aprovar e Recusar.')).toBeVisible();
        await expect(page.getByText(/tela bloqueada é ajustado no Android/)).toBeVisible();
        await expectNoHorizontalScroll(page);
        await expectNoA11yViolations(page); // axe, incluindo o contraste dos textos e do foco (TOK-01) com o CSS real
        await attachShot(page, testInfo, `notificacoes-conteudo-ligado-${name}`);

        // Teclado: Tab chega à chave dos bots e o Espaço a desliga, só ela. O foco fica visível e na chave depois de gravar.
        await bots.focus();
        await expect(bots).toBeFocused();
        await page.keyboard.press('Space');
        await expect(bots).toHaveAttribute('aria-checked', 'false');
        await expect(chat).toHaveAttribute('aria-checked', 'true');
        await expect(bots).toBeFocused();
        await chat.click();
        await expect(chat).toHaveAttribute('aria-checked', 'false');
        await expectNoHorizontalScroll(page);
        await expectNoA11yViolations(page);
        await attachShot(page, testInfo, `notificacoes-conteudo-desligado-${name}`);

        // A escolha é do servidor: recarregar mantém as duas desligadas.
        await page.reload();
        await expect(bots).toHaveAttribute('aria-checked', 'false');
        await expect(chat).toHaveAttribute('aria-checked', 'false');
        expect((await page.context().request.get(`${ORIGIN}/api/push/content`, { headers: api.headers })).status()).toBe(200);

        // Volta ao padrão (estado global da pilha) e confere que também persiste.
        await bots.click();
        await chat.click();
        await expect(bots).toHaveAttribute('aria-checked', 'true');
        await expect(chat).toHaveAttribute('aria-checked', 'true');
        await page.reload();
        await expect(bots).toHaveAttribute('aria-checked', 'true');
        await expect(chat).toHaveAttribute('aria-checked', 'true');
        expect(problems).toEqual([]);
      } finally {
        // Nunca deixa a pilha com uma chave desligada (um teste que falhou no meio não pode afetar os seguintes).
        for (const origin of ['bots', 'general_chat'] as const) {
          await page.context().request.put(`${ORIGIN}/api/push/content`, { headers: api.headers, data: { origin, enabled: true } });
        }
      }
    });
  }
});

test.describe('PWA instalável', () => {
  test('manifesto, ícones e service worker abrem sem sessão, e o Chromium não vê impedimento para instalar', async ({ page, context, browser }, testInfo) => {
    // Sem cookies, como o navegador busca o manifesto.
    const anonymous = await browser.newContext({ baseURL: E2E_ORIGIN });
    try {
      const manifestResponse = await anonymous.request.get('/manifest.webmanifest');
      expect(manifestResponse.status()).toBe(200);
      const manifest = (await manifestResponse.json()) as { name: string; display: string; start_url: string; theme_color: string; background_color: string; icons: { src: string; sizes: string; purpose?: string }[] };
      // Fundo e tema são o `--bg-app` da identidade (phase 5, T3), e os atalhos do ícone abrem o Chat geral e as Aprovações.
      expect(manifest).toMatchObject({
        name: 'Aion',
        display: 'standalone',
        start_url: '/',
        theme_color: '#0E0E13',
        background_color: '#0E0E13',
        shortcuts: [{ name: 'Novo chat', url: '/chat' }, { name: 'Aprovações', url: '/aprovacoes' }],
      });
      expect(manifest.icons.map((icon) => `${icon.sizes}:${icon.purpose}`).sort()).toEqual(['192x192:any', '512x512:any', '512x512:maskable']);
      for (const icon of manifest.icons) {
        const response = await anonymous.request.get(icon.src);
        expect(response.status(), icon.src).toBe(200);
        expect(response.headers()['content-type']).toBe('image/png');
      }
      const worker = await anonymous.request.get('/sw.js');
      expect(worker.status()).toBe(200);
      expect(worker.headers()['content-type']).toMatch(/javascript/);
      expect(await worker.text()).toContain("addEventListener('push'");
    } finally {
      await anonymous.close();
    }

    // Logado, o shell registra o service worker e o navegador relata se a página é instalável.
    await prepareBrowserPush(context, 'denied');
    await page.setViewportSize({ width: 375, height: 812 });
    await startApi(page); // entra na conta (o shell autenticado é quem registra o service worker)
    await page.goto('/configuracoes/conta');
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state ?? null)).toBe('activated');
    const cdp = await context.newCDPSession(page);
    const installability = (await cdp.send('Page.getInstallabilityErrors')) as { installabilityErrors: { errorId: string }[] };
    // O contexto do Playwright é anônimo (`in-incognito`), o único impedimento que o Chromium relata: manifesto, ícones, service worker e
    // origem segura (localhost) estão todos aceitos.
    expect(installability.installabilityErrors.map((error) => error.errorId).filter((id) => id !== 'in-incognito')).toEqual([]);

    // O manifesto pede `display: standalone` (provado acima); abrir de fato como app instalado é a prova real no Android e no desktop. Aqui
    // fica o registro do shell em 375 px com o viewport-fit e o tema da PWA.
    await expect(page.getByRole('heading', { name: 'Conta', level: 1 })).toBeVisible();
    expect(await page.locator('meta[name="theme-color"]').getAttribute('content')).toBe('#0E0E13');
    expect(await page.locator('meta[name="viewport"]').getAttribute('content')).toContain('viewport-fit=cover');
    await expectNoHorizontalScroll(page);
    await attachShot(page, testInfo, 'pwa-shell-375');
  });
});

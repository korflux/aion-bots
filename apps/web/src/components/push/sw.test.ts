// Prova do service worker de verdade (apps/web/public/sw.js, T10), carregado num contexto isolado do Node com um `self` simulado: a guarda do
// destino de abertura (R13), os dois manipuladores que a usam, `push` (monta a notificação) e `notificationclick` (abre o cartão), o
// silêncio quando o dono já está olhando a conversa do aviso (T17) e a conferência na chegada (phase 3, T4: consulta ao servidor com o evento
// novo e as notificações exibidas, fechamento das obsoletas, falha aberta em 3 s e substituição por tag com novo alerta).
// O que se prova aqui é o efeito observável: qual caminho vai para a notificação, o que fica na bandeja do aparelho, o que foi perguntado ao
// servidor e qual URL o navegador é mandado abrir. Phase 16 (passo 2): o registro do que o aparelho fez com cada aviso (recebido, exibido, suprimido com
// motivo, tocado), que sai depois da exibição, só com o id do dispositivo guardado, e cuja falha nunca muda o que aparece. Nada de conteúdo da conversa passa pelo worker; ele só repete o que o servidor mandou,
// depois de validar.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import appIcons from '@/lib/app-icons.json';

const ORIGIN = 'https://aion.exemplo.com';
const SOURCE = readFileSync(new URL('../../../public/sw.js', import.meta.url), 'utf8');

type Handler = (event: Record<string, unknown>) => void;

/** Opções de notificação que o worker passa a `showNotification` (o caminho de abertura e o id do evento ficam em `data`). */
interface ShownOptions {
  body: string;
  tag: string;
  renotify?: boolean;
  actions?: Array<{ action: string; title: string }>;
  icon: string;
  badge: string;
  data: { url: string; eventId?: string; previous?: number; approvalId?: string };
}

/** Notificação na bandeja simulada do aparelho, como `registration.getNotifications()` a devolve. */
interface TrayItem {
  title: string;
  tag: string;
  data: { url: string; eventId?: string; previous?: number; approvalId?: string };
  close(): void;
}

/** Resposta da conferência simulada: o corpo devolvido com o status, ou um modo de falha. */
type CheckAnswer = { status: number; body: unknown } | 'network-error' | 'no-answer';

/** Resposta do servidor falso à decisão tomada na notificação (`POST /api/approvals/:id/respond`): status e corpo, ou um modo de falha. */
type RespondAnswer = { status: number; body: unknown } | 'network-error' | 'no-answer';

/** Decisão recebida pelo servidor falso: o id da aprovação, o corpo enviado e o que acompanhou o pedido (CSRF, cookie). */
interface RespondPost {
  approvalId: string;
  body: Record<string, unknown>;
  csrf: string | undefined;
  credentials: string;
}

/** Registro do service worker recebido pelo servidor falso (`POST /api/push/receipts`). */
interface ReceiptPost {
  body: Record<string, unknown>;
  csrf: string | undefined;
  credentials: string;
  method: string;
}

/** Como o armazenamento do dispositivo se apresenta ao worker: com o id guardado, vazio, falhando ou ausente (sem Cache API). */
type DeviceStorage = { deviceId: string } | 'empty' | 'throws' | 'absent';

/** Como o servidor falso responde a uma chamada do registro: um status, erro de rede ou sem resposta. */
type ReceiptAnswer = number | 'network-error' | 'no-answer';

const DEVICE = '9b2f6a1c-3d4e-4f5a-8b6c-7d8e9f0a1b2c';

interface Worker {
  /** Dispara um evento no manipulador registrado e espera o que o worker passou a `waitUntil`. */
  fire(type: 'push' | 'notificationclick', event: Record<string, unknown>): Promise<void>;
  /** Notificações mostradas (registro de cada `showNotification`): o caminho de abertura fica em `options.data.url`. */
  shown: Array<{ title: string; options: ShownOptions }>;
  /** O que está exibido agora no aparelho: a mesma tag substitui, e `close()` tira da bandeja. */
  tray: TrayItem[];
  /** Ids pedidos em cada conferência (`GET /api/push/events/check?ids=`), na ordem da consulta. */
  checks: string[][];
  /** Como o servidor responde às próximas conferências (padrão: todo evento pedido vale). */
  answerChecks(answer: (ids: string[]) => CheckAnswer): void;
  /** Põe uma notificação já exibida na bandeja, como se tivesse chegado num push anterior. */
  display(item: { tag: string; eventId?: string }): void;
  /** URLs para as quais o worker navegou numa janela do app já aberta. */
  navigated: string[];
  /** URLs que o worker abriu numa janela nova. */
  opened: string[];
  /** Define se há uma janela do app aberta que o toque pode reaproveitar (ausente: o worker abre uma nova). */
  setOpenWindow(open: boolean): void;
  /** Define as janelas do app com o estado que o navegador informa (visibilidade, foco e endereço). */
  setWindows(windows: WindowState[]): void;
  /** Faz a listagem das janelas falhar (o navegador recusou `clients.matchAll`). */
  failListing(): void;
  /** Registros recebidos pelo servidor falso, na ordem de chegada. */
  receipts: ReceiptPost[];
  /** Quantas vezes o worker pediu o token CSRF (`GET /api/auth/session`). */
  sessionFetches: number;
  /** Ordem dos fatos observáveis: `show` (notificação exibida) e `receipt:<estado>` (registro recebido). */
  order: string[];
  /** Como o servidor responde à sessão (padrão: 200 com o token) e aos registros (padrão: 204). */
  answerSession(answer: 'ok' | 'unauthorized' | 'network-error'): void;
  answerReceipts(answer: ReceiptAnswer): void;
  /** Faz a próxima exibição falhar (o navegador recusou `showNotification`). */
  failShowing(): void;
  /** Decisões que o servidor falso recebeu pela notificação, na ordem de chegada, e como ele responde às próximas (padrão: 200 com a aprovação decidida). */
  responds: RespondPost[];
  answerRespond(answer: RespondAnswer): void;
}

/** O que o worker lê de cada janela do app que o navegador lista. */
interface WindowState {
  url: string;
  visibilityState: 'visible' | 'hidden';
  focused: boolean;
}

/** Resposta da conferência em que cada id pedido recebe o veredito dado (os não listados valem). */
const verdicts =
  (invalid: string[]) =>
  (ids: string[]): CheckAnswer => ({ status: 200, body: { events: ids.map((id) => ({ id, valid: !invalid.includes(id) })) } });

/**
 * Carrega o `sw.js` num contexto com `self` falso e devolve o que o worker mostrou, navegou e abriu. A bandeja simula o navegador (mesma tag
 * substitui) e o `fetch` simula a API da conferência; `setTimeout` é lido na hora da chamada, então os relógios falsos do Vitest valem.
 */
function loadWorker(storage: DeviceStorage = 'absent'): Worker {
  const handlers = new Map<string, Handler>();
  const shown: Worker['shown'] = [];
  const tray: TrayItem[] = [];
  const checks: string[][] = [];
  const navigated: string[] = [];
  const opened: string[] = [];
  let windows: Array<Partial<WindowState>> = [];
  let listingFails = false;
  let answer: (ids: string[]) => CheckAnswer = verdicts([]);
  const receipts: ReceiptPost[] = [];
  const order: string[] = [];
  let sessionAnswer: 'ok' | 'unauthorized' | 'network-error' = 'ok';
  let receiptAnswer: ReceiptAnswer = 204;
  let sessionFetches = 0;
  let showFails = false;
  const responds: RespondPost[] = [];
  let respondAnswer: RespondAnswer = { status: 200, body: { id: '501', status: 'approved', decision: 'allow_once' } };

  /** Coloca na bandeja, substituindo a notificação de mesma tag, como o navegador faz. */
  const putInTray = (title: string, tag: string, data: TrayItem['data']) => {
    const index = tray.findIndex((item) => item.tag === tag);
    if (index >= 0) tray.splice(index, 1);
    const item: TrayItem = {
      title,
      tag,
      data,
      close: () => {
        const at = tray.indexOf(item);
        if (at >= 0) tray.splice(at, 1);
      },
    };
    tray.push(item);
  };

  /** Fica pendurada até o `abort` do prazo, como um servidor que nunca responde. */
  const hang = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));

  const fetch = async (input: string, init: { signal: AbortSignal; credentials: string; method?: string; headers?: Record<string, string>; body?: string }) => {
    const url = new URL(input, ORIGIN);
    if (url.pathname === '/api/auth/session') {
      sessionFetches += 1;
      expect(init.credentials).toBe('same-origin');
      if (sessionAnswer === 'network-error') throw new TypeError('Failed to fetch');
      if (sessionAnswer === 'unauthorized') return { ok: false, status: 401, json: async () => ({ code: 'AUTH_SESSION_EXPIRED' }) };
      return { ok: true, status: 200, json: async () => ({ owner: { email: 'dono@exemplo.com' }, sessionId: 's', csrfToken: 'csrf-do-teste' }) };
    }
    if (url.pathname === '/api/push/receipts') {
      expect(init.method).toBe('POST');
      if (receiptAnswer === 'network-error') throw new TypeError('Failed to fetch');
      if (receiptAnswer === 'no-answer') return hang(init.signal);
      const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
      receipts.push({ body, csrf: init.headers?.['x-csrf-token'], credentials: init.credentials, method: init.method ?? '' });
      order.push(`receipt:${String(body.state)}`);
      return { ok: receiptAnswer < 400, status: receiptAnswer, json: async () => ({}) };
    }
    const approvalMatch = /^\/api\/approvals\/([^/]+)\/respond$/.exec(url.pathname);
    if (approvalMatch) {
      expect(init.method).toBe('POST');
      const answered = respondAnswer;
      if (answered === 'network-error') throw new TypeError('Failed to fetch');
      if (answered === 'no-answer') return hang(init.signal);
      responds.push({ approvalId: approvalMatch[1] as string, body: JSON.parse(init.body ?? '{}') as Record<string, unknown>, csrf: init.headers?.['x-csrf-token'], credentials: init.credentials });
      return { ok: answered.status >= 200 && answered.status < 300, status: answered.status, json: async () => answered.body };
    }
    expect(url.pathname).toBe('/api/push/events/check');
    expect(init.credentials).toBe('same-origin');
    const ids = (url.searchParams.get('ids') ?? '').split(',');
    checks.push(ids);
    const result = answer(ids);
    if (result === 'network-error') throw new TypeError('Failed to fetch');
    if (result === 'no-answer') {
      // O servidor nunca responde: só o `abort` do prazo encerra a consulta.
      return hang(init.signal);
    }
    return { ok: result.status >= 200 && result.status < 300, status: result.status, json: async () => result.body };
  };

  const self = {
    location: { origin: ORIGIN },
    skipWaiting: () => undefined,
    addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
    registration: {
      showNotification: async (title: string, options: ShownOptions) => {
        if (showFails) {
          showFails = false;
          throw new Error('showNotification recusado');
        }
        order.push('show');
        shown.push({ title, options });
        putInTray(title, options.tag, options.data);
      },
      getNotifications: async () => [...tray],
    },
    clients: {
      claim: async () => undefined,
      matchAll: async () => {
        if (listingFails) throw new Error('matchAll falhou');
        return windows.map((state) => ({
          url: `${ORIGIN}/bots`,
          ...state,
          navigate: async (target: string) => {
            navigated.push(target);
            return { focus: async () => undefined };
          },
        }));
      },
      openWindow: async (target: string) => {
        opened.push(target);
        return null;
      },
    },
  };
  // Cache API do aparelho: o id do dispositivo que a página guardou (ou nada, ou uma falha). `absent` não define `caches`, como num contexto sem a API.
  const caches =
    storage === 'absent'
      ? undefined
      : {
          open: async () => {
            if (storage === 'throws') throw new Error('armazenamento indisponível');
            return { match: async () => (storage === 'empty' ? undefined : { json: async () => ({ deviceId: storage.deviceId }) }) };
          },
        };
  vm.runInContext(
    SOURCE,
    vm.createContext({
      self,
      URL,
      fetch,
      caches,
      AbortController,
      setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    }),
  );

  return {
    shown,
    tray,
    checks,
    navigated,
    opened,
    answerChecks: (next) => {
      answer = next;
    },
    display: ({ tag, eventId }) => putInTray('Anterior', tag, eventId === undefined ? { url: '/' } : { url: '/', eventId }),
    setOpenWindow: (open) => {
      windows = open ? [{}] : [];
    },
    setWindows: (next) => {
      windows = next;
    },
    failListing: () => {
      listingFails = true;
    },
    receipts,
    order,
    get sessionFetches() {
      return sessionFetches;
    },
    answerSession: (next) => {
      sessionAnswer = next;
    },
    answerReceipts: (next) => {
      receiptAnswer = next;
    },
    failShowing: () => {
      showFails = true;
    },
    responds,
    answerRespond: (next) => {
      respondAnswer = next;
    },
    async fire(type, event) {
      const pending: Array<Promise<unknown>> = [];
      handlers.get(type)?.({ ...event, waitUntil: (work: Promise<unknown>) => pending.push(work) });
      await Promise.all(pending);
    },
  };
}

/** Evento `push` do FCM: o envelope traz a mensagem em `data`. */
const pushOf = (data: Record<string, unknown>) => ({ data: { json: () => ({ data }) } });
/** Evento de toque numa notificação cujo `data.url` é o valor dado (e, se houver, o `eventId` guardado nela). */
const clickOn = (url: unknown, eventId?: string) => ({ notification: { close: () => undefined, data: eventId === undefined ? { url } : { url, eventId } } });

const CARD = '/bots/4380ae7e-11a7-4110-98f3-f2767965bfa1?mensagem=42';

describe('service worker: destino de abertura da notificação (R13)', () => {
  // Cada valor começa com `/` ou é de outro esquema, e por isso passaria numa checagem de texto; o navegador resolve todos para outro host
  // (ou deixa uma barra dupla que voltaria a ser outro host quando resolvida de novo).
  const hostile = ['//evil.com', '/\\evil.com', '/\t/evil.com', '/\n/evil.com', '/..//evil.com', 'https://evil.com/x', 'javascript:alert(1)', 42, null, undefined];

  it('um destino que sai da origem nunca chega à notificação: vira a raiz do app', async () => {
    for (const url of hostile) {
      const worker = loadWorker();
      await worker.fire('push', pushOf({ title: 'Bot', body: 'Concluída', tag: 't', url }));
      expect(worker.shown, String(url)).toHaveLength(1);
      expect(worker.shown[0]?.options.data.url, String(url)).toBe('/');
    }
  });

  it('um caminho do próprio app passa inteiro, com a consulta que abre o cartão, e uma URL absoluta da própria origem vira caminho', async () => {
    const bot = loadWorker();
    await bot.fire('push', pushOf({ title: 'Bot', body: 'Concluída', tag: 't', url: CARD }));
    expect(bot.shown[0]?.options.data.url).toBe(CARD);

    const chat = loadWorker();
    await chat.fire('push', pushOf({ title: 'Chat geral', body: 'Concluída', tag: 't', url: '/chat/4380ae7e-11a7-4110-98f3-f2767965bfa1?mensagem=7' }));
    expect(chat.shown[0]?.options.data.url).toBe('/chat/4380ae7e-11a7-4110-98f3-f2767965bfa1?mensagem=7');

    const absolute = loadWorker();
    await absolute.fire('push', pushOf({ title: 'Bot', body: 'Concluída', tag: 't', url: `${ORIGIN}${CARD}` }));
    expect(absolute.shown[0]?.options.data.url).toBe(CARD);
  });

  it('o toque revalida: um dado adulterado na notificação não abre outro host, nem numa janela aberta nem numa nova', async () => {
    for (const hasWindow of [false, true]) {
      for (const url of hostile) {
        const worker = loadWorker();
        worker.setOpenWindow(hasWindow);
        await worker.fire('notificationclick', clickOn(url));
        expect([...worker.navigated, ...worker.opened], `${String(url)} janela=${hasWindow}`).toEqual([`${ORIGIN}/`]);
      }
    }
  });

  it('o toque leva ao cartão: reaproveita a janela do app aberta ou abre uma nova', async () => {
    const withWindow = loadWorker();
    withWindow.setOpenWindow(true);
    await withWindow.fire('notificationclick', clickOn(CARD));
    expect(withWindow.navigated).toEqual([`${ORIGIN}${CARD}`]);
    expect(withWindow.opened).toEqual([]);

    const withoutWindow = loadWorker();
    await withoutWindow.fire('notificationclick', clickOn(CARD));
    expect(withoutWindow.opened).toEqual([`${ORIGIN}${CARD}`]);
  });
});

describe('service worker: ícones da notificação (T16; phase 5, T3 e T9)', () => {
  it('o aviso mostra a Faísca sobre o disco tinta no ícone grande, a estrela branca transparente no ícone pequeno, e não o ícone do app', async () => {
    const worker = loadWorker();
    await worker.fire('push', pushOf({ title: 'Bot', body: 'Concluída', tag: 't', url: CARD }));
    const [notification] = worker.shown;
    // Os PNGs em si (ícone grande de 192 px com a Faísca; ícone pequeno de 96 px branco sobre transparente) e o nome com o hash do conteúdo são conferidos em
    // `app/app-icons.test.ts`; aqui se prova que o aviso aponta para cada um no lugar certo. Os endereços vêm do registro que o gerador grava
    // (`lib/app-icons.json`), o mesmo que o gerador usa para reescrever as constantes do `sw.js`: se divergirem, este teste reprova.
    expect(notification?.options.icon).toBe(appIcons.notificationIcon);
    expect(notification?.options.badge).toBe(appIcons.notificationBadge);
    expect(notification?.options.icon).not.toBe(appIcons.icon192);
    // Um push ilegível também mostra os dois ícones: nenhum deles depende do conteúdo da mensagem.
    const unreadable = loadWorker();
    await unreadable.fire('push', { data: { json: () => { throw new Error('ilegível'); } } });
    expect(unreadable.shown[0]?.options.icon).toBe(appIcons.notificationIcon);
    expect(unreadable.shown[0]?.options.badge).toBe(appIcons.notificationBadge);
  });
});

describe('service worker: silêncio quando o dono já está olhando a conversa (T17)', () => {
  const CONVERSATION = '/bots/4380ae7e-11a7-4110-98f3-f2767965bfa1';
  const push = { title: 'Bot', body: 'Concluída', tag: 't', url: `${CONVERSATION}?mensagem=42` };
  const looking = { url: `${ORIGIN}${CONVERSATION}`, visibilityState: 'visible', focused: true } satisfies WindowState;

  it('com a conversa do aviso visível e em foco nenhuma notificação é mostrada (a consulta ?mensagem= não muda a conversa)', async () => {
    const worker = loadWorker();
    worker.setWindows([looking]);
    await worker.fire('push', pushOf(push));
    expect(worker.shown).toEqual([]);

    // Também vale para uma sessão do chat geral e para o endereço com a mesma conversa em outra janela do app.
    const chat = loadWorker();
    chat.setWindows([{ url: `${ORIGIN}/bots`, visibilityState: 'visible', focused: false }, { ...looking, url: `${ORIGIN}/chat/4380ae7e-11a7-4110-98f3-f2767965bfa1?mensagem=3` }]);
    await chat.fire('push', pushOf({ ...push, url: '/chat/4380ae7e-11a7-4110-98f3-f2767965bfa1?mensagem=7' }));
    expect(chat.shown).toEqual([]);
  });

  it('se não der para saber o que está aberto (a listagem das janelas falha), a notificação aparece em vez de sumir', async () => {
    const worker = loadWorker();
    worker.failListing();
    await worker.fire('push', pushOf(push));
    expect(worker.shown).toHaveLength(1);
    expect(worker.shown[0]?.options.data.url).toBe(push.url);
  });

  it('em qualquer outra situação o aviso aparece: sem janela, janela sem foco, aba oculta, outra tela do app, outra conversa ou outra origem', async () => {
    const situations: Array<[string, WindowState[]]> = [
      ['sem janela aberta', []],
      ['janela visível mas sem foco', [{ ...looking, focused: false }]],
      ['aba oculta', [{ ...looking, visibilityState: 'hidden' }]],
      ['em outra tela do app', [{ ...looking, url: `${ORIGIN}/rotinas` }]],
      ['em outra conversa', [{ ...looking, url: `${ORIGIN}/bots/00000000-0000-4000-8000-000000000000` }]],
      ['mesmo caminho em outra origem', [{ ...looking, url: `https://evil.example${CONVERSATION}` }]],
      ['endereço ilegível', [{ ...looking, url: 'não é uma url' }]],
    ];
    for (const [name, windows] of situations) {
      const worker = loadWorker();
      worker.setWindows(windows);
      await worker.fire('push', pushOf(push));
      expect(worker.shown, name).toHaveLength(1);
      expect(worker.shown[0]?.options.data.url, name).toBe(push.url);
    }
  });
});

describe('service worker: conferência na chegada (phase 3, T4; Suposições 8 e 10; A4 e A5)', () => {
  const BOT = '4380ae7e-11a7-4110-98f3-f2767965bfa1';
  const push = { title: 'Bot', body: 'Execução concluída', tag: `aion-activity-${BOT}`, url: `/bots/${BOT}?mensagem=42`, kind: 'run_completed', eventId: '77' };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pergunta pelo evento novo e pelas exibidas, fecha as que deixaram de valer e mostra o novo com a tag do servidor, novo alerta e o id guardado', async () => {
    const worker = loadWorker();
    worker.display({ tag: 'aion-approval-outra', eventId: '70' });
    worker.display({ tag: 'aion-activity-outra', eventId: '71' });
    worker.display({ tag: 'sem-id' }); // notificação sem id (formato anterior): não entra na consulta e fica
    worker.answerChecks(verdicts(['70']));
    await worker.fire('push', pushOf(push));

    expect(worker.checks).toEqual([['77', '70', '71']]);
    expect(worker.tray.map((item) => item.tag)).toEqual(['aion-activity-outra', 'sem-id', push.tag]);
    expect(worker.shown).toHaveLength(1);
    expect(worker.shown[0]?.options).toMatchObject({ tag: push.tag, renotify: true, data: { url: push.url, eventId: '77' } });
  });

  it('o evento novo que o servidor dá como obsoleto não aparece, e as exibidas obsoletas fecham na mesma chegada', async () => {
    const worker = loadWorker();
    worker.display({ tag: `aion-approval-${BOT}`, eventId: '60' });
    worker.answerChecks(verdicts(['77', '60']));
    await worker.fire('push', pushOf(push));
    expect(worker.shown).toEqual([]);
    expect(worker.tray).toEqual([]);
  });

  it('um aviso novo da mesma conversa e categoria substitui o anterior (a mesma tag) em vez de empilhar', async () => {
    const worker = loadWorker();
    await worker.fire('push', pushOf(push));
    await worker.fire('push', pushOf({ ...push, url: `/bots/${BOT}?mensagem=43`, eventId: '78' }));
    // A aprovação é outra categoria: fica ao lado. A expirada usa a mesma tag da pendente e a substitui.
    await worker.fire('push', pushOf({ ...push, tag: `aion-approval-${BOT}`, kind: 'approval_pending', eventId: '79' }));
    await worker.fire('push', pushOf({ ...push, tag: `aion-approval-${BOT}`, kind: 'approval_expired', eventId: '80' }));
    expect(worker.tray.map((item) => [item.tag, item.data.eventId])).toEqual([
      [push.tag, '78'],
      [`aion-approval-${BOT}`, '80'],
    ]);
    expect(worker.shown.every((entry) => entry.options.renotify === true)).toBe(true);
  });

  it('só as 20 primeiras exibidas entram na consulta (o servidor aceita 21 ids)', async () => {
    const worker = loadWorker();
    for (let index = 0; index < 25; index += 1) worker.display({ tag: `t${index}`, eventId: String(100 + index) });
    await worker.fire('push', pushOf(push));
    expect(worker.checks[0]).toHaveLength(21);
    expect(worker.checks[0]?.slice(0, 2)).toEqual(['77', '100']);
  });

  it('um id fora do formato não é enviado ao servidor: o push aparece e só as exibidas válidas são conferidas', async () => {
    const worker = loadWorker();
    for (const eventId of ['abc', '1,2', '-1', '1234567890123456789', 12]) {
      await worker.fire('push', pushOf({ ...push, eventId }));
    }
    expect(worker.checks).toEqual([]);
    expect(worker.shown).toHaveLength(5);
    expect(worker.shown[0]?.options.data).toEqual({ url: push.url });
  });

  it('falha aberta: sem resposta em 3 s, erro de rede, sem sessão (401), erro do servidor ou corpo fora do contrato, o aviso aparece', async () => {
    const failures: Array<[string, CheckAnswer]> = [
      ['erro de rede', 'network-error'],
      ['sem sessão', { status: 401, body: { code: 'AUTH_SESSION_EXPIRED', message: 'Sessão expirada.' } }],
      ['limite', { status: 429, body: { code: 'RATE_LIMITED', message: 'Muitas tentativas.' } }],
      ['erro do servidor', { status: 500, body: null }],
      ['corpo fora do contrato', { status: 200, body: { valid: false } }],
    ];
    for (const [name, failure] of failures) {
      const worker = loadWorker();
      worker.display({ tag: 'antiga', eventId: '70' });
      worker.answerChecks(() => failure);
      await worker.fire('push', pushOf(push));
      expect(worker.shown, name).toHaveLength(1);
      // Sem resposta utilizável nada é fechado: a exibida continua.
      expect(worker.tray.map((item) => item.tag), name).toEqual(['antiga', push.tag]);
    }

    vi.useFakeTimers();
    const silent = loadWorker();
    silent.answerChecks(() => 'no-answer');
    const arrival = silent.fire('push', pushOf(push));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(silent.shown, 'antes do prazo ainda espera').toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await arrival;
    expect(silent.shown).toHaveLength(1);
  });

  it('a conferência local continua como segunda camada: evento válido no servidor com a conversa em foco neste aparelho não aparece', async () => {
    const worker = loadWorker();
    worker.setWindows([{ url: `${ORIGIN}/bots/${BOT}`, visibilityState: 'visible', focused: true }]);
    await worker.fire('push', pushOf(push));
    expect(worker.checks).toEqual([['77']]);
    expect(worker.shown).toEqual([]);
  });
});

describe('service worker: registro do que o aparelho fez com o aviso (phase 16, passo 2; A1 e A9)', () => {
  const BOT = '4380ae7e-11a7-4110-98f3-f2767965bfa1';
  const push = { title: 'Bot', body: 'Execução concluída', tag: `aion-activity-${BOT}`, url: `/bots/${BOT}?mensagem=42`, kind: 'run_completed', eventId: '77' };
  const stored: DeviceStorage = { deviceId: DEVICE };

  afterEach(() => {
    vi.useRealTimers();
  });

  /** O que o servidor recebeu, como [estado, motivo]. */
  const states = (worker: Worker) => worker.receipts.map((receipt) => [receipt.body.state, receipt.body.reason]);

  it('aviso exibido: registra recebido e exibido DEPOIS de mostrar, com o token CSRF da sessão, o evento e o dispositivo, e nada além disso', async () => {
    const worker = loadWorker(stored);
    await worker.fire('push', pushOf(push));

    expect(worker.shown).toHaveLength(1);
    expect(worker.order[0]).toBe('show'); // o registro nunca antecede a exibição
    expect(states(worker)).toEqual([
      ['received', undefined],
      ['shown', undefined],
    ]);
    for (const receipt of worker.receipts) {
      expect(receipt).toMatchObject({ csrf: 'csrf-do-teste', credentials: 'same-origin', method: 'POST' });
      expect(Object.keys(receipt.body).filter((key) => !['eventId', 'deviceId', 'state', 'reason'].includes(key))).toEqual([]); // nenhum conteúdo
      expect(receipt.body).toMatchObject({ eventId: '77', deviceId: DEVICE });
    }
    expect(JSON.stringify(worker.receipts)).not.toContain('Execução concluída');
  });

  it('aviso que o servidor dá como obsoleto: registra recebido e suprimido por invalid, e não mostra', async () => {
    const worker = loadWorker(stored);
    worker.answerChecks(verdicts(['77']));
    await worker.fire('push', pushOf(push));
    expect(worker.shown).toEqual([]);
    expect(states(worker)).toEqual([
      ['received', undefined],
      ['suppressed', 'invalid'],
    ]);
  });

  it('conversa aberta neste aparelho: registra recebido e suprimido por owner_looking', async () => {
    const worker = loadWorker(stored);
    worker.setWindows([{ url: `${ORIGIN}/bots/${BOT}`, visibilityState: 'visible', focused: true }]);
    await worker.fire('push', pushOf(push));
    expect(worker.shown).toEqual([]);
    expect(states(worker)).toEqual([
      ['received', undefined],
      ['suppressed', 'owner_looking'],
    ]);
  });

  it('conferência sem resposta: o aviso continua aparecendo (falha aberta) e é registrado como exibido com o motivo check_timeout, não como suprimido', async () => {
    vi.useFakeTimers();
    const worker = loadWorker(stored);
    worker.answerChecks(() => 'no-answer');
    const arrival = worker.fire('push', pushOf(push));
    await vi.advanceTimersByTimeAsync(3_000);
    await arrival;
    expect(worker.shown).toHaveLength(1);
    expect(states(worker)).toEqual([
      ['received', undefined],
      ['shown', 'check_timeout'],
    ]);

    // Erro de rede ou HTTP na conferência é o mesmo caso: não há resposta utilizável.
    const failing = loadWorker(stored);
    failing.answerChecks(() => 'network-error');
    await failing.fire('push', pushOf(push));
    expect(states(failing)).toEqual([
      ['received', undefined],
      ['shown', 'check_timeout'],
    ]);
  });

  it('o toque registra tocado e abre o cartão sem esperar o registro', async () => {
    vi.useFakeTimers();
    const worker = loadWorker(stored);
    worker.setOpenWindow(true);
    worker.answerReceipts('no-answer'); // o servidor do registro nunca responde
    const tap = worker.fire('notificationclick', clickOn(push.url, '77'));
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.navigated).toEqual([`${ORIGIN}${push.url}`]); // já navegou, com o registro ainda pendente
    await vi.advanceTimersByTimeAsync(2_000);
    await tap;

    const ok = loadWorker(stored);
    await ok.fire('notificationclick', clickOn(push.url, '77'));
    expect(states(ok)).toEqual([['clicked', undefined]]);
    expect(ok.receipts[0]?.body).toMatchObject({ eventId: '77', deviceId: DEVICE });
    expect(ok.opened).toEqual([`${ORIGIN}${push.url}`]);
  });

  it('sem o id do dispositivo guardado (vazio, ausente ou falha do armazenamento) nada é registrado nem pedido, e o aviso aparece igual', async () => {
    for (const storage of ['empty', 'absent', 'throws'] as const) {
      const worker = loadWorker(storage);
      await worker.fire('push', pushOf(push));
      await worker.fire('notificationclick', clickOn(push.url, '77'));
      expect(worker.shown, storage).toHaveLength(1);
      expect(worker.receipts, storage).toEqual([]);
      expect(worker.sessionFetches, storage).toBe(0);
    }
    // Um valor guardado fora do formato de uuid também não é usado.
    const corrupt = loadWorker({ deviceId: 'não é um uuid' });
    await corrupt.fire('push', pushOf(push));
    expect(corrupt.receipts).toEqual([]);
    expect(corrupt.shown).toHaveLength(1);
  });

  it('push sem id de evento não registra nada (não há a que ligar o registro)', async () => {
    const worker = loadWorker(stored);
    await worker.fire('push', pushOf({ ...push, eventId: undefined }));
    expect(worker.shown).toHaveLength(1);
    expect(worker.receipts).toEqual([]);
    expect(worker.sessionFetches).toBe(0);
  });

  it('falha do registro (sem sessão, rede, erro HTTP ou sem resposta) nunca muda o que aparece nem faz o worker lançar', async () => {
    const cases: Array<[string, (worker: Worker) => void]> = [
      ['sessão vencida', (worker) => worker.answerSession('unauthorized')],
      ['rede fora na sessão', (worker) => worker.answerSession('network-error')],
      ['rede fora no registro', (worker) => worker.answerReceipts('network-error')],
      ['recusa do servidor', (worker) => worker.answerReceipts(403)],
      ['limite do servidor', (worker) => worker.answerReceipts(429)],
    ];
    for (const [name, setup] of cases) {
      const worker = loadWorker(stored);
      setup(worker);
      await worker.fire('push', pushOf(push));
      expect(worker.shown, name).toHaveLength(1);
      expect(worker.tray.map((item) => item.tag), name).toEqual([push.tag]);
    }

    vi.useFakeTimers();
    const silent = loadWorker(stored);
    silent.answerReceipts('no-answer');
    const arrival = silent.fire('push', pushOf(push));
    await vi.advanceTimersByTimeAsync(2_000);
    await arrival;
    expect(silent.shown).toHaveLength(1);
  });

  it('o token CSRF fica em memória: dois avisos seguidos pedem a sessão uma vez só', async () => {
    const worker = loadWorker(stored);
    await worker.fire('push', pushOf(push));
    await worker.fire('push', pushOf({ ...push, tag: 'outra', eventId: '78' }));
    expect(worker.sessionFetches).toBe(1);
    expect(worker.receipts).toHaveLength(4);
  });

  it('se a exibição falhar, só o recebido é registrado e o erro continua subindo como antes', async () => {
    const worker = loadWorker(stored);
    worker.failShowing();
    await expect(worker.fire('push', pushOf(push))).rejects.toThrow('showNotification recusado');
    expect(states(worker)).toEqual([['received', undefined]]);
  });
});

// Conteúdo e agrupamento do aviso (phase 16, passo 5; NOTIF-02; A4 no lado do aparelho e A10): o título e o corpo vêm da conferência quando o servidor os manda,
// e o genérico do FCM vale em qualquer outra situação; cada aprovação é uma notificação, e as respostas de uma conversa dividem uma, com o contador das anteriores.
describe('service worker: conteúdo do aviso e agrupamento (phase 16, passo 5; A4 e A10)', () => {
  const BOT = '4380ae7e-11a7-4110-98f3-f2767965bfa1';
  const activity = { title: 'Bot', body: 'Execução concluída', tag: `aion-activity-${BOT}`, url: `/bots/${BOT}?mensagem=42`, kind: 'run_completed', eventId: '77' };
  const approval = (approvalId: string, eventId: string) => ({ title: 'Bot', body: 'Aprovação pendente', tag: `aion-approval-${approvalId}`, url: `/bots/${BOT}?mensagem=${eventId}`, kind: 'approval_pending', eventId });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Resposta da conferência em que cada id vale e os listados em `content` trazem título e corpo. */
  const withContent =
    (content: Record<string, { title?: string; body?: string; approvalId?: string }>) =>
    (ids: string[]): CheckAnswer => ({ status: 200, body: { events: ids.map((id) => ({ id, valid: true, ...content[id] })) } });

  it('A4: com título e corpo da conferência o aviso diz o que aconteceu; o genérico do FCM só vale sem eles', async () => {
    const worker = loadWorker();
    worker.answerChecks(withContent({ '77': { title: 'Bot de vendas', body: 'Pronto: o relatório de vendas ficou com 12 linhas.' } }));
    await worker.fire('push', pushOf(activity));
    expect(worker.shown[0]).toMatchObject({ title: 'Bot de vendas', options: { body: 'Pronto: o relatório de vendas ficou com 12 linhas.', tag: activity.tag, renotify: true } });

    // Chave desligada (a conferência só diz que vale), conteúdo pela metade, texto vazio ou de outro tipo: genérico.
    for (const [name, entry] of [
      ['chave desligada', {}],
      ['só o título', { title: 'Bot de vendas' }],
      ['só o corpo', { body: 'texto' }],
      ['vazios', { title: '', body: '' }],
      ['fora do tipo', { title: 12, body: ['x'] }],
    ] as const) {
      const generic = loadWorker();
      generic.answerChecks(withContent({ '77': entry as { title?: string } }));
      await generic.fire('push', pushOf(activity));
      expect(generic.shown[0], name).toMatchObject({ title: 'Bot', options: { body: 'Execução concluída' } });
    }
  });

  it('A4: sem sessão, sem resposta em 3 s ou com erro da conferência o aviso genérico aparece, e o conteúdo nunca vem de outro lugar', async () => {
    for (const failure of ['network-error', { status: 401, body: { code: 'AUTH_SESSION_EXPIRED' } }, { status: 500, body: null }] as CheckAnswer[]) {
      const worker = loadWorker();
      worker.answerChecks(() => failure);
      await worker.fire('push', pushOf(activity));
      expect(worker.shown[0]).toMatchObject({ title: 'Bot', options: { body: 'Execução concluída' } });
    }
    vi.useFakeTimers();
    const silent = loadWorker();
    silent.answerChecks(() => 'no-answer');
    const arrival = silent.fire('push', pushOf(activity));
    await vi.advanceTimersByTimeAsync(3_000);
    await arrival;
    expect(silent.shown[0]).toMatchObject({ title: 'Bot', options: { body: 'Execução concluída' } });
  });

  it('o corte de 160 conta pontos de código: um emoji na fronteira nunca vira meio caractere, e o texto que já cabe passa intacto', async () => {
    const worker = loadWorker();
    const fits = 'a' + '😀'.repeat(159); // 160 pontos de código, 319 unidades UTF-16
    worker.answerChecks(withContent({ '77': { title: fits, body: fits } }));
    await worker.fire('push', pushOf(activity));
    expect(worker.shown[0]?.title).toBe(fits);
    expect(worker.shown[0]?.options.body).toBe(fits);

    const over = loadWorker();
    const long = '😀'.repeat(200);
    over.answerChecks(withContent({ '77': { title: long, body: long } }));
    await over.fire('push', pushOf(activity));
    expect(Array.from(over.shown[0]?.title ?? '')).toHaveLength(160);
    expect(Array.from(over.shown[0]?.options.body ?? '')).toHaveLength(160);
    expect(over.shown[0]?.options.body).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });

  it('o texto do servidor é repetido cortado em 160 caracteres', async () => {
    const worker = loadWorker();
    worker.answerChecks(withContent({ '77': { title: 'T'.repeat(300), body: 'c'.repeat(300) } }));
    await worker.fire('push', pushOf(activity));
    expect(worker.shown[0]?.title).toHaveLength(160);
    expect(worker.shown[0]?.options.body).toHaveLength(160);
  });

  it('A10: duas aprovações seguidas são duas notificações (uma tag por aprovação), e a expirada substitui só a pendente da mesma aprovação', async () => {
    const worker = loadWorker();
    await worker.fire('push', pushOf(approval('501', '81')));
    await worker.fire('push', pushOf(approval('502', '82')));
    expect(worker.tray.map((item) => item.tag)).toEqual(['aion-approval-501', 'aion-approval-502']);

    await worker.fire('push', pushOf({ ...approval('501', '83'), kind: 'approval_expired', body: 'Aprovação expirada' }));
    expect(worker.tray.map((item) => [item.tag, item.data.eventId])).toEqual([['aion-approval-502', '82'], ['aion-approval-501', '83']]);
    // Nenhuma aprovação carrega o contador das anteriores.
    expect(worker.shown.map((entry) => entry.options.body)).toEqual(['Aprovação pendente', 'Aprovação pendente', 'Aprovação expirada']);
  });

  it('A10: três respostas da mesma conversa viram uma notificação com "+2 anteriores" e novo alerta; outra conversa não entra na conta', async () => {
    const worker = loadWorker();
    await worker.fire('push', pushOf({ ...activity, eventId: '91' }));
    await worker.fire('push', pushOf({ ...activity, eventId: '92' }));
    await worker.fire('push', pushOf({ ...activity, eventId: '93' }));
    await worker.fire('push', pushOf({ ...activity, tag: 'aion-activity-outra', eventId: '94' }));

    expect(worker.shown.map((entry) => entry.options.body)).toEqual([
      'Execução concluída',
      'Execução concluída · +1 anterior',
      'Execução concluída · +2 anteriores',
      'Execução concluída',
    ]);
    expect(worker.shown.every((entry) => entry.options.renotify === true)).toBe(true);
    expect(worker.tray.map((item) => [item.tag, item.data.eventId, item.data.previous])).toEqual([
      [activity.tag, '93', 2],
      ['aion-activity-outra', '94', undefined],
    ]);
  });

  it('o contador conta só as que o dono não viu: a anterior que o servidor deu como obsoleta (conversa lida) não entra', async () => {
    const worker = loadWorker();
    await worker.fire('push', pushOf({ ...activity, eventId: '91' }));
    await worker.fire('push', pushOf({ ...activity, eventId: '92' }));
    worker.answerChecks(verdicts(['92']));
    await worker.fire('push', pushOf({ ...activity, eventId: '93' }));
    expect(worker.shown.at(-1)?.options.body).toBe('Execução concluída');
    expect(worker.tray.map((item) => item.data.previous)).toEqual([undefined]);
  });

  it('o contador também vale com o conteúdo da conferência', async () => {
    const worker = loadWorker();
    worker.answerChecks(withContent({ '91': { title: 'Bot', body: 'Primeira' }, '92': { title: 'Bot', body: 'Segunda' } }));
    await worker.fire('push', pushOf({ ...activity, eventId: '91' }));
    await worker.fire('push', pushOf({ ...activity, eventId: '92' }));
    expect(worker.shown.map((entry) => entry.options.body)).toEqual(['Primeira', 'Segunda · +1 anterior']);
  });
});

// Botões Aprovar e Recusar (phase 16, passo 6; SEC-07; A6, A7, A8 no lado do aparelho): a notificação de aprovação pendente com o id da aprovação (que só a conferência com
// "Mostrar conteúdo" ligado devolve) ganha os dois botões; o toque decide pela MESMA rota da tela, com o cookie e o CSRF de GET /api/auth/session, só com `allow_once` ou `deny`
// e `source: notification`. Falha de qualquer tipo troca a notificação por uma que explica e abre o cartão; o sucesso fecha a notificação (sem confirmação: a escolha é não
// empilhar mais um aviso, e a falha NUNCA fecha em silêncio, então sumir significa que a decisão foi registrada).
describe('service worker: botões Aprovar e Recusar na notificação (phase 16, passo 6)', () => {
  const BOT = '4380ae7e-11a7-4110-98f3-f2767965bfa1';
  const CARD_URL = `/bots/${BOT}?mensagem=42`;
  const pending = { title: 'Bot', body: 'Aprovação pendente', tag: 'aion-approval-501', url: CARD_URL, kind: 'approval_pending', eventId: '77' };
  const withApproval =
    (approvalId: string | undefined) =>
    (ids: string[]): CheckAnswer => ({
      status: 200,
      body: { events: ids.map((id) => ({ id, valid: true, title: 'Bot', body: 'Aprovação pendente: Send Email · Gmail', ...(approvalId === undefined ? {} : { approvalId }) })) },
    });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Toque num botão (ou no corpo, com `action` vazio) da notificação que está na bandeja. */
  const tap = (worker: Worker, action: string) => {
    const item = worker.tray[0]!;
    return worker.fire('notificationclick', { action, notification: { tag: item.tag, data: item.data, close: () => item.close() } });
  };

  it('com o id da aprovação na conferência a notificação ganha Aprovar e Recusar (no máximo dois) e guarda o id; sem ele, ou com a conferência falhando, não há botões', async () => {
    const worker = loadWorker();
    worker.answerChecks(withApproval('501'));
    await worker.fire('push', pushOf(pending));
    expect(worker.shown[0]?.options.actions).toEqual([
      { action: 'approve', title: 'Aprovar' },
      { action: 'deny', title: 'Recusar' },
    ]);
    expect(worker.tray[0]?.data).toMatchObject({ approvalId: '501', eventId: '77', url: CARD_URL });

    const bareCases: Array<[string, (ids: string[]) => CheckAnswer]> = [
      ['chave desligada', withApproval(undefined)],
      ['id fora do formato', withApproval('5 01; drop')],
      ['sem sessão', () => ({ status: 401, body: { code: 'AUTH_SESSION_EXPIRED' } })],
      ['sem resposta', () => 'network-error'],
    ];
    for (const [name, answer] of bareCases) {
      const bare = loadWorker();
      bare.answerChecks(answer);
      await bare.fire('push', pushOf(pending));
      expect(bare.shown[0]?.options.actions, name).toBeUndefined();
      expect(bare.tray[0]?.data.approvalId, name).toBeUndefined();
    }
  });

  it('A6: Aprovar decide allow_once e Recusar decide deny, na rota da tela, com cookie, CSRF e `source: notification`, e a notificação fecha', async () => {
    for (const [action, decision] of [
      ['approve', 'allow_once'],
      ['deny', 'deny'],
    ] as const) {
      const worker = loadWorker();
      worker.answerChecks(withApproval('501'));
      await worker.fire('push', pushOf(pending));
      await tap(worker, action);

      expect(worker.responds).toEqual([{ approvalId: '501', body: { decision, source: 'notification' }, csrf: 'csrf-do-teste', credentials: 'same-origin' }]);
      expect(worker.tray).toEqual([]); // fechada pelo toque; nada novo foi exibido
      expect(worker.shown).toHaveLength(1);
      expect(worker.navigated.concat(worker.opened)).toEqual([]); // o botão não abre o app
    }
  });

  it('o toque no corpo da notificação, ou numa ação desconhecida, só abre o cartão: nenhuma decisão é enviada', async () => {
    for (const action of ['', 'always', 'allow_always']) {
      const worker = loadWorker();
      worker.answerChecks(withApproval('501'));
      await worker.fire('push', pushOf(pending));
      await tap(worker, action);
      expect(worker.responds, `ação "${action}"`).toEqual([]);
      expect(worker.opened).toEqual([`${ORIGIN}${CARD_URL}`]);
    }
  });

  it('o botão de uma notificação sem id de aprovação (aviso genérico, ou de antes dos botões) não decide nada e abre o cartão', async () => {
    const worker = loadWorker();
    await worker.fire('push', pushOf(pending));
    await tap(worker, 'approve');
    expect(worker.responds).toEqual([]);
    expect(worker.sessionFetches).toBe(0);
    expect(worker.opened).toEqual([`${ORIGIN}${CARD_URL}`]);
  });

  it('A7: aprovação já decidida, expirada, sessão vencida, rede ou erro do servidor: a notificação vira uma explicativa (mesma tag, sem botões) que abre o cartão, e o sucesso nunca é simulado', async () => {
    // `calls` é quantas decisões chegaram ao servidor falso: sem sessão ou sem rede ao pedir o token, nenhuma.
    const cases: Array<{ name: string; setup: (worker: Worker) => void; expected: RegExp; calls: number }> = [
      { name: 'já decidida', setup: (w) => w.answerRespond({ status: 409, body: { code: 'APPROVAL_NOT_PENDING' } }), expected: /já estava decidida/, calls: 1 },
      // A mesma decisão repetida: o servidor é idempotente (200), mas avisa que já estava aplicada. Não é sucesso deste toque, então vira a explicativa.
      { name: 'mesma decisão já aplicada (200 com alreadyApplied)', setup: (w) => w.answerRespond({ status: 200, body: { id: '501', status: 'approved', decision: 'allow_once', alreadyApplied: true } }), expected: /já estava decidida/, calls: 1 },
      { name: 'expirada', setup: (w) => w.answerRespond({ status: 409, body: { code: 'APPROVAL_EXPIRED' } }), expected: /expirou/, calls: 1 },
      { name: 'sessão vencida na decisão', setup: (w) => w.answerRespond({ status: 401, body: { code: 'AUTH_SESSION_EXPIRED' } }), expected: /sessão/i, calls: 1 },
      { name: 'erro do servidor', setup: (w) => w.answerRespond({ status: 500, body: null }), expected: /Não foi possível registrar/, calls: 1 },
      { name: 'corpo ilegível', setup: (w) => w.answerRespond({ status: 502, body: undefined }), expected: /Não foi possível registrar/, calls: 1 },
      { name: 'rede na decisão', setup: (w) => w.answerRespond('network-error'), expected: /Sem conexão/, calls: 0 },
      { name: 'sem sessão para o token CSRF', setup: (w) => w.answerSession('unauthorized'), expected: /sessão/i, calls: 0 },
      { name: 'rede ao pedir o token CSRF', setup: (w) => w.answerSession('network-error'), expected: /Sem conexão/, calls: 0 },
    ];
    for (const { name, setup, expected, calls } of cases) {
      const worker = loadWorker();
      worker.answerChecks(withApproval('501'));
      await worker.fire('push', pushOf(pending));
      setup(worker);
      await tap(worker, 'approve');

      expect(worker.responds.length, name).toBe(calls);
      expect(worker.shown, name).toHaveLength(2);
      const explanation = worker.shown[1]!;
      expect(explanation.title, name).toMatch(/Não foi possível aprovar/);
      expect(explanation.options.body, name).toMatch(expected);
      expect(explanation.options.tag, name).toBe('aion-approval-501');
      expect(explanation.options.actions, name).toBeUndefined();
      expect(explanation.options.data, name).toEqual({ url: CARD_URL });
      expect(worker.tray.map((item) => item.tag), name).toEqual(['aion-approval-501']);

      // Tocar na explicativa abre o cartão e não decide nada.
      await tap(worker, '');
      expect(worker.opened, name).toEqual([`${ORIGIN}${CARD_URL}`]);
      expect(worker.responds.length, name).toBe(calls);
    }
  });

  it('sem resposta do servidor em 10 s a notificação vira a explicativa de falta de conexão', async () => {
    vi.useFakeTimers();
    const worker = loadWorker();
    worker.answerChecks(withApproval('501'));
    await worker.fire('push', pushOf(pending));
    worker.answerRespond('no-answer');
    const decision = tap(worker, 'deny');
    await vi.advanceTimersByTimeAsync(10_000);
    await decision;
    expect(worker.shown[1]?.title).toMatch(/Não foi possível recusar/);
    expect(worker.shown[1]?.options.body).toMatch(/Sem conexão/);
  });

  it('o token CSRF vencido (403) é pedido de novo uma vez e a decisão é repetida com o token novo; um segundo 403 vira a explicativa', async () => {
    const worker = loadWorker();
    worker.answerChecks(withApproval('501'));
    await worker.fire('push', pushOf(pending));
    worker.answerRespond({ status: 403, body: { code: 'CSRF_TOKEN_INVALID' } });
    await tap(worker, 'approve');
    expect(worker.responds).toHaveLength(2);
    expect(worker.sessionFetches).toBe(2);
    expect(worker.shown[1]?.title).toMatch(/Não foi possível aprovar/);
  });
});

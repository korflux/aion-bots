// Service worker do Aion (T10). Duas funções, nenhuma delas de cache:
//   1. Receber o push do FCM e MOSTRAR a notificação só se o aviso ainda vale. Duas camadas (phase 3, T4; NOTIF-01; Suposição 8):
//      a) conferência no servidor (`checkEvents`): o evento novo e as notificações do Aion já exibidas neste aparelho (até 20) são
//         conferidos em `GET /api/push/events/check`; as exibidas que deixaram de valer são fechadas e o evento novo só aparece se vale.
//         Sem resposta em 3 s, com erro ou sem sessão, o aviso aparece (falha aberta: nunca some por falha de conferência);
//      b) conferência local (T17, `ownerIsLookingAt`): o dono já está olhando a conversa do aviso neste aparelho.
//      A mensagem do FCM traz só `data` (título = nome do bot, corpo = tipo do evento, caminho de abertura, tag, id do evento): é o aviso GENÉRICO, e
//      nada da conversa viaja pelo FCM. Desde a phase 16 (NOTIF-02, SEC-07) a conferência acima também devolve, para o evento válido de uma origem
//      com "Mostrar conteúdo" ligado, o título e o corpo com o conteúdo (começo da resposta, ação da aprovação, desfecho da rotina): é o ÚNICO canal
//      desse texto, e este arquivo só o repete (cortado em 160 caracteres), sem montar nem guardar nada além da notificação. Sem esse conteúdo (chave
//      desligada, sem resposta em 3 s, sem sessão, erro) vale o genérico do FCM.
//      Agrupamento (phase 16): a tag vem do servidor. Cada aprovação tem a sua (`aion-approval-<id da aprovação>`), então duas aprovações seguidas são duas
//      notificações; as respostas e rotinas de uma conversa dividem uma (`aion-activity-<conversa>`), que a mais nova substitui com novo alerta
//      (`renotify`) e o contador das anteriores ainda não vistas ("+2 anteriores").
//   2. Abrir o cartão quando o dono toca na notificação: reaproveita uma janela do app já aberta (navega nela) ou abre uma nova.
//      Aprovar e Recusar (phase 16, SEC-07): a notificação de aprovação pendente cuja conferência devolveu o id da aprovação (só com "Mostrar conteúdo" ligado) ganha
//      os dois botões. O toque decide pela MESMA rota da tela (`POST /api/approvals/:id/respond`, cookie da sessão e token CSRF de `GET /api/auth/session`), só com
//      `allow_once` ou `deny` e `source: notification`; "sempre" é só do app, e o servidor também o recusa. Sucesso fecha a notificação. Qualquer falha (já decidida,
//      expirada, sessão vencida, sem rede, erro) a troca por uma explicativa, de mesma tag e sem botões, que abre o cartão: uma decisão sem efeito nunca parece sucesso.
//   3. Registrar no servidor o que fez com cada aviso (phase 16; `POST /api/push/receipts`): recebido, exibido, suprimido com motivo e tocado, para o
//      funil do push separar servidor, FCM e aparelho. É só telemetria e NUNCA muda o que aparece: o registro sai DEPOIS da decisão e da exibição, com prazo
//      curto, e qualquer falha (sem id do dispositivo, sem sessão, rede, recusa) é engolida. Leva ids e códigos fechados, nunca conteúdo.
// Ser registrado e responder a esses eventos é também o que faz o navegador oferecer a instalação da PWA.
//
// Formato do push: o FCM entrega no evento `push` um envelope JSON com a mensagem em `data` (strings). Tudo é validado antes de usar,
// e um push ilegível ainda mostra uma notificação genérica, porque o navegador exige uma notificação visível por push recebido.
// Segurança: o destino da abertura só vale se, RESOLVIDO como o navegador resolve, cair na própria origem. Comparar o texto não basta
// (`//host`, `/\host` e `/<tab>/host` começam com `/` e viram outro host no parser de URL), então `safePath` resolve e confere a origem.
// Assim uma mensagem adulterada não leva o dono para fora do app.

// Ícone grande da notificação: a Faísca simples sobre o disco tinta (`push-icone-grande.svg`, 192 px), em arquivo próprio e distinto do ícone do app
// (`icon-192`, com cantos e o pelo da Faísca completa). Os arquivos ficam em `public/icons`, que o proxy libera sem sessão, e saem dos SVG da identidade
// por `tests/support/generate-app-icons.mjs`.
// ENDEREÇO PELO CONTEÚDO (phase 5, T9): o nome de cada ícone leva o hash do conteúdo (`notification-icon.<hash8>.png`), para a borda e o navegador nunca
// servirem um desenho antigo atrás do cache. As DUAS constantes abaixo (`NOTIFICATION_ICON` e `NOTIFICATION_BADGE`) são reescritas pelo gerador, junto
// com `src/lib/app-icons.json` (a fonte única que manifesto e layout leem): este worker é estático e não importa o JSON. Não editar os nomes à mão.
const NOTIFICATION_ICON = '/icons/notification-icon.efbedc1e.png';
// Ícone pequeno (`badge`, barra de status e cabeçalho do aviso no Android): o sistema usa só o canal alfa, então é a estrela da marca em branco sobre fundo
// transparente (`push-badge.svg`, 96 px, mesmo gerador); um ícone opaco ali viraria um quadrado branco.
const NOTIFICATION_BADGE = '/icons/notification-badge.e1040d71.png';

// Conferência na chegada (phase 3, T4): prazo da consulta ao servidor, quantas notificações exibidas entram junto com o evento novo (o
// servidor aceita até 21 ids por consulta) e o formato do id de `push_events` (texto de dígitos, como `bigintIdSchema` de @aion/shared).
const CHECK_TIMEOUT_MS = 3_000;
const CHECK_SHOWN_MAX = 20;
const EVENT_ID = /^\d{1,18}$/;
// Botões da notificação de aprovação (phase 16): prazo da decisão (maior que o do registro, porque o dono espera o resultado), a ação do botão -> a decisão do servidor
// (as duas únicas que a notificação envia) e o aviso de cada falha, sempre terminando em como seguir. O id da aprovação segue o formato de `approvalIdSchema` (dígitos).
const RESPOND_TIMEOUT_MS = 10_000;
const BUTTON_DECISIONS = { approve: 'allow_once', deny: 'deny' };
const FAILURE_REASONS = {
  decided: 'Esta aprovação já estava decidida. Toque para ver o cartão.',
  expired: 'Esta aprovação expirou. Toque para ver o cartão.',
  session: 'Sua sessão venceu. Toque para abrir o app e entrar.',
  network: 'Sem conexão para registrar a resposta. Toque para abrir o cartão e decidir.',
  failed: 'Não foi possível registrar a resposta. Toque para abrir o cartão.',
};
// Título e corpo com conteúdo (phase 16): o servidor já corta em 160 caracteres; o worker corta de novo, porque repete o que recebe.
const CONTENT_MAX = 160;
// A tag das respostas e rotinas de uma conversa (uma notificação por conversa, com o contador das anteriores). A das aprovações é outra (uma por aprovação) e não conta.
const ACTIVITY_TAG_PREFIX = 'aion-activity-';
// Teto do contador: acima disso "+99 anteriores" já diz tudo e o dado guardado na notificação não cresce sem limite.
const PREVIOUS_MAX = 99;

// Registro do que o aparelho fez com o aviso (phase 16). O id do dispositivo (o que o servidor devolveu no registro do push) é guardado pela página na
// Cache API sob esta chave, porque a Cache API existe na página e no worker, sem esquema nem versão (o IndexedDB pediria abrir banco e migrar para guardar
// uma string); a página escreve ao registrar e apaga ao remover o dispositivo (`push-api.ts`, que repete estas duas constantes: este arquivo é estático e não
// importa módulos). O token CSRF vem de `GET /api/auth/session` e fica em memória por `CSRF_TTL_MS`; o worker pode ser encerrado a qualquer hora, e aí
// ele só busca de novo. `RECEIPT_TIMEOUT_MS` limita cada chamada para o registro não segurar o worker vivo.
const DEVICE_STATE_CACHE = 'aion-push-device';
const DEVICE_STATE_KEY = '/__aion/push-device';
const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECEIPT_TIMEOUT_MS = 2_000;
const CSRF_TTL_MS = 60_000;
let csrfCache = null;

/** Lê o envelope do push com segurança; qualquer falha vira `null`. */
function readPushData(event) {
  try {
    const envelope = event.data ? event.data.json() : null;
    const data = envelope && typeof envelope === 'object' ? (envelope.data ?? envelope) : null;
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

/** Texto curto de um campo da mensagem, ou o valor padrão se vier ausente ou do tipo errado. */
function text(value, fallback, max) {
  return typeof value === 'string' && value !== '' ? value.slice(0, max) : fallback;
}

/**
 * Caminho (com consulta) de abertura, garantidamente da própria origem; qualquer outra coisa (outro host, esquema estranho, valor que
 * não é texto, `//host`, barra seguida de barra invertida, `/..//host`) vira a raiz do app. Resolve como o navegador resolve e confere a origem, e recusa o
 * resultado que começa com `//`: um caminho assim, mesmo vindo de uma URL da própria origem (`/..//host`), voltaria a ser outro host
 * quando resolvido de novo no toque.
 */
function safePath(value) {
  if (typeof value !== 'string') return '/';
  try {
    const url = new URL(value, self.location.origin);
    const path = `${url.pathname}${url.search}`;
    return url.origin === self.location.origin && !path.startsWith('//') ? path : '/';
  } catch {
    return '/';
  }
}

/**
 * O dono está olhando AGORA a conversa do aviso? Há uma janela do app visível, com o foco, cujo caminho é o do destino da notificação
 * (a consulta `?mensagem=` não conta: é a mesma conversa). Nesse caso a resposta já está na tela e a notificação só atrapalharia (T17).
 * Uma janela visível mas sem foco (outra janela por cima, outro monitor) ou em outra tela do app NÃO conta: o aviso continua útil.
 * Chrome e Edge dispensam a notificação do push quando existe uma janela visível do site, então não aparece o aviso genérico do
 * navegador.
 * ponytail: o Safari/iOS exige uma notificação para TODO push recebido e pode cancelar a assinatura de quem não mostra; se o dono usar
 *   o app no iOS, trocar este descarte por uma notificação que some sozinha.
 */
async function ownerIsLookingAt(path) {
  const target = new URL(path, self.location.origin).pathname;
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return windows.some((client) => {
    if (client.visibilityState !== 'visible' || client.focused !== true) return false;
    try {
      const url = new URL(client.url);
      return url.origin === self.location.origin && url.pathname === target;
    } catch {
      return false;
    }
  });
}

/** Id do evento de `push_events` levado pelo push ou guardado na notificação, ou `null` se ausente ou fora do formato. */
function eventIdOf(value) {
  return typeof value === 'string' && EVENT_ID.test(value) ? value : null;
}

/**
 * Pergunta ao servidor quais destes eventos ainda valem (`GET /api/push/events/check`, com o cookie da sessão deste aparelho). Devolve um
 * mapa id -> { valid, title, body } (`title` e `body` só existem quando o servidor mandou o conteúdo: evento válido de uma origem com "Mostrar
 * conteúdo" ligado, e ambos textos não vazios), ou `null` quando não há resposta utilizável: prazo de `CHECK_TIMEOUT_MS` estourado, rede, sessão
 * vencida, erro HTTP ou corpo fora do contrato. Quem chama trata `null` como "não sei" e mostra o aviso genérico (falha aberta, Suposição 8). O prazo
 * cobre também a leitura do corpo, porque o `abort` interrompe o fluxo da resposta.
 */
async function checkEvents(ids) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(`/api/push/events/check?ids=${ids.join(',')}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await response.json();
    if (!body || !Array.isArray(body.events)) return null;
    const verdicts = new Map();
    for (const entry of body.events) {
      if (!entry || typeof entry.id !== 'string' || typeof entry.valid !== 'boolean') continue;
      const hasContent = entry.valid && typeof entry.title === 'string' && entry.title !== '' && typeof entry.body === 'string' && entry.body !== '';
      // O id da aprovação só vale junto do conteúdo (a chave ligada) e no formato de dígitos; qualquer outra coisa deixa a notificação sem botões.
      const approvalId = hasContent && eventIdOf(entry.approvalId) !== null ? entry.approvalId : undefined;
      verdicts.set(entry.id, hasContent ? { valid: true, title: entry.title, body: entry.body, approvalId } : { valid: entry.valid });
    }
    return verdicts;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Id do dispositivo guardado pela página, ou `null` (nada guardado, Cache API ausente ou valor fora do formato). */
async function readDeviceId() {
  try {
    if (typeof caches === 'undefined') return null;
    const cache = await caches.open(DEVICE_STATE_CACHE);
    const stored = await cache.match(DEVICE_STATE_KEY);
    const body = stored ? await stored.json() : null;
    return body && typeof body.deviceId === 'string' && DEVICE_ID.test(body.deviceId) ? body.deviceId : null;
  } catch {
    return null;
  }
}

/** `fetch` com prazo: o `abort` interrompe também a leitura do corpo. O chamador trata a rejeição. */
async function fetchWithin(url, init, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Token CSRF desta sessão (`GET /api/auth/session`), em memória por `CSRF_TTL_MS`; `null` sem sessão ou sem resposta. */
async function sessionCsrf() {
  if (csrfCache !== null && csrfCache.expiresAt > Date.now()) return csrfCache.value;
  csrfCache = null;
  const response = await fetchWithin('/api/auth/session', {}, RECEIPT_TIMEOUT_MS);
  if (!response.ok) return null;
  const body = await response.json();
  if (!body || typeof body.csrfToken !== 'string' || body.csrfToken === '') return null;
  csrfCache = { value: body.csrfToken, expiresAt: Date.now() + CSRF_TTL_MS };
  return csrfCache.value;
}

/**
 * Registra no servidor o que o aparelho fez com o aviso `eventId` (`entries`: pares [estado, motivo]). Melhor esforço e NUNCA lança: sem id de evento ou
 * sem id do dispositivo guardado não reporta; sem sessão, rede, prazo ou recusa do servidor (inclusive o CSRF vencido, que só limpa o cache do token)
 * o registro se perde, e o aviso segue como estava. Quem chama espera esta função só para o worker não ser encerrado no meio, nunca antes de exibir.
 */
async function reportReceipts(eventId, entries) {
  try {
    if (eventId === null) return;
    const deviceId = await readDeviceId();
    if (deviceId === null) return;
    const csrf = await sessionCsrf();
    if (csrf === null) return;
    await Promise.all(
      entries.map(async ([state, reason]) => {
        const response = await fetchWithin(
          '/api/push/receipts',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
            body: JSON.stringify(reason ? { eventId, deviceId, state, reason } : { eventId, deviceId, state }),
          },
          RECEIPT_TIMEOUT_MS,
        );
        if (response.status === 403) csrfCache = null;
      }),
    );
  } catch {
    // Telemetria: nada aqui pode afetar a notificação.
  }
}

/**
 * Primeira camada da decisão de mostrar (Suposição 8): confere no servidor o evento novo e as notificações do Aion já exibidas neste
 * aparelho, fecha as exibidas que deixaram de valer e responde `{ verdict, content }`: `verdict` é `'valid'`, `'invalid'` (o servidor disse que o evento
 * novo não vale) ou `'unknown'` (sem resposta utilizável: prazo de 3 s, rede, sessão vencida, erro HTTP ou corpo fora do contrato), e `content` é o
 * `{ title, body, approvalId }` que o servidor mandou para o evento novo (`approvalId` só no pedido de aprovação pendente) ou `null` (então vale o genérico do FCM, sem botões). Só `'invalid'` impede o aviso; `'unknown'` o
 * mostra (falha aberta) e é registrado como `check_timeout` junto do exibido. Push sem id (formato anterior à T3, ou ilegível) é `'valid'`.
 * Fallback da Suposição 10 (notificação "Aion" silenciosa no lugar do push descartado) não existe: na prova E2E do Chromium (push entregue
 * pelo DevTools) o navegador não mostrou aviso genérico pelo push não exibido.
 * ponytail: o Chrome pode mostrar o aviso genérico ("site atualizado em segundo plano") quando muitos pushes seguidos não viram notificação;
 *   se a prova no Chrome desktop ou no Android mostrar isso, trocar o descarte por uma notificação "Aion" silenciosa fechada logo depois.
 */
async function eventStillValid(eventId) {
  const shown = await self.registration.getNotifications().catch(() => []);
  const tracked = shown.filter((notification) => eventIdOf(notification.data && notification.data.eventId) !== null).slice(0, CHECK_SHOWN_MAX);
  const ids = [...new Set([eventId, ...tracked.map((notification) => notification.data.eventId)].filter((id) => id !== null))];
  if (ids.length === 0) return { verdict: 'valid', content: null };
  const verdicts = await checkEvents(ids);
  if (verdicts === null) return { verdict: 'unknown', content: null };
  for (const notification of tracked) {
    const known = verdicts.get(notification.data.eventId);
    if (known !== undefined && known.valid === false) notification.close();
  }
  const mine = eventId === null ? undefined : verdicts.get(eventId);
  if (mine !== undefined && mine.valid === false) return { verdict: 'invalid', content: null };
  return { verdict: 'valid', content: mine !== undefined && mine.title !== undefined ? { title: mine.title, body: mine.body, approvalId: mine.approvalId } : null };
}

/**
 * Quantas notificações anteriores da MESMA conversa (tag `aion-activity-<conversa>`) a nova vai substituir sem que o dono tenha visto: 0 se não há nenhuma na
 * bandeja, senão o contador guardado nela mais um. Lê a bandeja DEPOIS da conferência, então a que o servidor deu como obsoleta (conversa lida, por exemplo) já
 * foi fechada e não conta. As aprovações têm uma tag por aprovação, então não passam por aqui (a expirada que substitui a pendente da mesma aprovação não é "anterior").
 * ponytail: dois pushes da mesma conversa tratados ao mesmo tempo leem a mesma bandeja e podem contar um a menos; o worker trata um push por vez na prática, e o contador
 * é só informativo.
 */
async function previousStacked(tag) {
  if (!tag.startsWith(ACTIVITY_TAG_PREFIX)) return 0;
  const shown = await self.registration.getNotifications().catch(() => []);
  const same = shown.find((notification) => notification.tag === tag);
  if (!same) return 0;
  const before = same.data && Number.isInteger(same.data.previous) && same.data.previous > 0 ? same.data.previous : 0;
  return Math.min(before + 1, PREVIOUS_MAX);
}

// Uma versão nova assume na hora (o worker não guarda nada em cache), e as abas já abertas passam a ser controladas por ele: é isso que
// permite ao toque na notificação navegar numa aba existente em vez de abrir outra.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  const data = readPushData(event) ?? {};
  const url = safePath(data.url);
  const eventId = eventIdOf(data.eventId);
  event.waitUntil(
    (async () => {
      // O que o aparelho fez com o aviso, para o registro no servidor (phase 16): sai no `finally`, depois de decidir e de exibir. Fica `null` se a
      // exibição falhar (só o "recebido" é registrado) e o erro continua subindo como antes.
      let outcome = null;
      try {
        // Primeira camada: o servidor diz que o aviso não vale mais (presença, abertura do app, leitura, aprovação resolvida, silêncio, 24 h).
        const { verdict, content } = await eventStillValid(eventId);
        if (verdict === 'invalid') {
          outcome = ['suppressed', 'invalid'];
          return;
        }
        // Segunda camada (T17), também otimização: se não for possível saber (matchAll falhou), a notificação aparece, nunca some.
        if (await ownerIsLookingAt(url).catch(() => false)) {
          outcome = ['suppressed', 'owner_looking'];
          return;
        }
        await showAlert(data, url, eventId, content, await previousStacked(text(data.tag, 'aion', 80)));
        outcome = ['shown', verdict === 'unknown' ? 'check_timeout' : null];
      } finally {
        await reportReceipts(eventId, outcome === null ? [['received', null]] : [['received', null], outcome]);
      }
    })(),
  );
});

/** Corta em `max` pontos de código (nunca no meio de um par substituto, como `slice` faria). O servidor já corta no mesmo limite; isto só protege contra resposta fora do contrato. */
function clipCodePoints(value, max) {
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join('');
}

/**
 * Mostra a notificação. Com `content` (título e corpo da conferência) o aviso diz o que aconteceu; sem ele vale o genérico da mensagem do FCM (campos validados
 * e cortados por `text`). `previous` > 0 acrescenta ao corpo o contador das anteriores da conversa ainda não vistas ("+2 anteriores"), e fica guardado na notificação
 * para a próxima somar.
 */
function showAlert(data, url, eventId, content, previous) {
  const title = content ? clipCodePoints(content.title, CONTENT_MAX) : text(data.title, 'Aion', 80);
  const body = content ? clipCodePoints(content.body, CONTENT_MAX) : text(data.body, 'Há uma novidade no Aion.', 120);
  const saved = { url };
  if (eventId !== null) saved.eventId = eventId;
  if (previous > 0) saved.previous = previous;
  // Aprovar e Recusar (no máximo dois botões no Chrome Android): só com o id da aprovação que a conferência devolveu; o id fica guardado para o toque.
  const approvalId = content && content.approvalId ? content.approvalId : null;
  if (approvalId !== null) saved.approvalId = approvalId;
  return self.registration.showNotification(title, {
    ...(approvalId === null
      ? {}
      : {
          actions: [
            { action: 'approve', title: 'Aprovar' },
            { action: 'deny', title: 'Recusar' },
          ],
        }),
    body: previous > 0 ? `${body} · +${previous} ${previous === 1 ? 'anterior' : 'anteriores'}` : body,
    // Tag por conversa e categoria (do servidor): o aviso novo SUBSTITUI o anterior da mesma conversa e categoria, e `renotify` faz a
    // substituição alertar de novo (som/vibração), em vez de trocar o texto em silêncio.
    tag: text(data.tag, 'aion', 80),
    renotify: true,
    icon: NOTIFICATION_ICON,
    badge: NOTIFICATION_BADGE,
    // `eventId` fica guardado para a conferência das notificações exibidas na chegada de um push seguinte, e `previous` para o contador da próxima.
    data: saved,
  });
}

/**
 * Decide a aprovação pelo botão da notificação (`POST /api/approvals/:id/respond` com `decision` e `source: notification`, cookie e token CSRF). Devolve `'done'` quando
 * o servidor decidiu agora (200 sem `alreadyApplied`) ou o motivo da falha: `'decided'` (APPROVAL_NOT_PENDING, ou 200 com `alreadyApplied`: a mesma decisão já estava aplicada e este toque não gravou nada), `'expired'` (APPROVAL_EXPIRED),
 * `'session'` (sem sessão para o token CSRF, ou 401), `'network'` (rede ou prazo de 10 s) e `'failed'` (qualquer outra recusa ou erro). Nunca lança. O 403 repete UMA vez com o token
 * pedido de novo (o guardado em memória pode ter vencido por troca de sessão); um segundo 403 é `'session'`.
 */
async function decideApproval(approvalId, decision) {
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const csrf = await sessionCsrf();
      if (csrf === null) return 'session';
      const response = await fetchWithin(
        `/api/approvals/${approvalId}/respond`,
        { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ decision, source: 'notification' }) },
        RESPOND_TIMEOUT_MS,
      );
      if (response.ok) {
        // A mesma decisão repetida é idempotente no servidor (200 sem efeito novo) e vem marcada `alreadyApplied`: este toque não decidiu nada, então não é sucesso.
        const accepted = await response.json().catch(() => null);
        return accepted && accepted.alreadyApplied === true ? 'decided' : 'done';
      }
      if (response.status === 403 && attempt === 0) {
        csrfCache = null;
        continue;
      }
      if (response.status === 401 || response.status === 403) return 'session';
      const body = await response.json().catch(() => null);
      const code = body && typeof body.code === 'string' ? body.code : null;
      if (code === 'APPROVAL_NOT_PENDING') return 'decided';
      if (code === 'APPROVAL_EXPIRED') return 'expired';
      return 'failed';
    }
    return 'session';
  } catch {
    return 'network';
  }
}

/**
 * Toque em Aprovar ou Recusar: decide e, se o servidor não aceitou, TROCA a notificação (já fechada pelo toque) por uma que explica o motivo, de mesma tag, sem botões, com
 * o mesmo caminho de abertura: tocar nela abre o cartão. Em sucesso não mostra nada (a notificação fechada é a confirmação). Sem exibição possível a falha não tem como ser
 * dita; o cartão continua pendente no app, que é onde a decisão sempre pode ser tomada.
 */
async function respondFromNotification(notification, approvalId, decision) {
  const outcome = await decideApproval(approvalId, decision);
  if (outcome === 'done') return;
  await self.registration.showNotification(`Não foi possível ${decision === 'allow_once' ? 'aprovar' : 'recusar'}`, {
    body: FAILURE_REASONS[outcome],
    tag: text(notification.tag, 'aion', 80),
    renotify: true,
    icon: NOTIFICATION_ICON,
    badge: NOTIFICATION_BADGE,
    data: { url: safePath(notification.data && notification.data.url) },
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Confere de novo no toque (e não só ao montar a notificação): o `data` da notificação é o que o navegador guardou.
  const target = new URL(safePath(event.notification.data && event.notification.data.url), self.location.origin).href;
  // O toque também é registrado no servidor (phase 16, "tocado"), mas a chamada só COMEÇA aqui e não é esperada antes de abrir o cartão: a navegação não
  // espera a rede do registro, e o worker só termina depois dos dois.
  const reported = reportReceipts(eventIdOf(event.notification.data && event.notification.data.eventId), [['clicked', null]]);
  // Botão Aprovar ou Recusar de uma notificação com o id da aprovação: decide sem abrir o app. Ação desconhecida (inclusive "sempre") ou notificação sem o id caem no
  // toque comum, que só abre o cartão.
  const decision = Object.hasOwn(BUTTON_DECISIONS, event.action) ? BUTTON_DECISIONS[event.action] : null;
  const approvalId = eventIdOf(event.notification.data && event.notification.data.approvalId);
  if (decision !== null && approvalId !== null) {
    event.waitUntil(Promise.all([respondFromNotification(event.notification, approvalId, decision), reported]));
    return;
  }
  event.waitUntil(
    (async () => {
      try {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        // Uma janela do app já aberta é reaproveitada: navega até o cartão e a traz para a frente.
        for (const client of windows) {
          if (new URL(client.url).origin === self.location.origin && 'navigate' in client) {
            const navigated = await client.navigate(target).catch(() => null);
            if (navigated) return await navigated.focus().catch(() => navigated);
          }
        }
        return await self.clients.openWindow(target);
      } finally {
        await reported;
      }
    })(),
  );
});

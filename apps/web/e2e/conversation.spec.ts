// E2E da conversa do bot (T6; A5, A6, A7, A9) no navegador real, contra a pilha de produção (Postgres, API, worker, Next e
// proxy) com o OpenCode Go FALSO. O provedor falso roteia cada resposta por marcadores no texto da mensagem (ver
// packages/core/src/testing/fake-upstreams.ts): [lento] responde em 8 pedaços, [demorar] nunca termina, [pesquisar:a|b] chama a
// busca no histórico, [loop] chama sem parar, [falha] devolve erro do provedor.
//
// Cobre: envio e streaming, atividades agrupadas e expandidas, busca no histórico com o link "ver na conversa", fila e parada,
// limite de etapas, falha com "tentar novamente", Markdown seguro, blocos cercados copiáveis ([blocos], phase 3 T7), pílula de novas mensagens, troca de modelo no composer (sem
// mexer no padrão do bot), recusa sem modelo, faixa sem provedor, o layout em 375 px e a barra de ações das mensagens (phase 4, T1: Copiar, modelo da
// resposta e revelação por hover, foco e toque, no bot e no Chat geral). O histórico por rodadas (F4) tem testes à parte, com
// 26 rodadas semeadas pelo produto de verdade (bot e sessão do chat geral): abre nas 10 últimas, carrega as anteriores sozinho ao chegar ao
// topo sem pular a leitura, "Carregando…", "Início da conversa", a falha com "Tentar novamente" e o link "ver na conversa" para uma mensagem
// a mais de 10 rodadas. O estado ao vivo do bot (T11, F10) tem um teste à parte: seis bots em estados diferentes na lista e o cabeçalho em cada estado
// (trabalhando, aguardando aprovação, concluído, erro, livre e dormindo), com a mudança de estado sem recarregar. A Faísca na conversa (phase 5, T1) tem os
// próprios testes (conversa vazia com a entrada e o olhar que segue o cursor, com movimento reduzido e em toque; linha da Faísca "Trabalhando…"; cartões de falha e de limite)
// e verificações nos testes que já passam por essas telas; a aprovação pendente está em approvals.spec.ts, a rotina em routines.spec.ts e o Chat geral, que também
// leva a Faísca (em `--faisca`), em general-chat.spec.ts. O estado (chave do provedor e favoritos) é global, então o arquivo é serial e roda no projeto `chromium-conversation`, depois de bots e modelos.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { FAKE_BLOCK_CODE, FAKE_BLOCK_TEXT, FAKE_BLOCKS_REPLY } from '../../../packages/core/src/testing/fake-upstreams';
import type { SpeechRecognitionLike } from '../src/components/conversation/use-dictation';
import { CLIENT_IP_HEADER, ORIGIN, apiHeaders, apiLogin, backLink, clientIpFor, contentOf, uniqueBotName, expect, expectNoA11yViolations, expectNoHorizontalScroll, expectWorkingLineAtTop, LONG_HISTORY_MESSAGE, ensureCredential, faiscaLook, releaseConnectorAccounts, runningAnimations, setProvider, tabBarOf, test, watchPage, openWorkLine } from './support/fixtures';

test.describe.configure({ mode: 'serial' });

const PROVIDER_KEY = 'valid-e2e-chat-1111';

/** Interface de controle do falso: o teste entrega eventos, sem abrir microfone nem contatar serviço de voz. */
type DictationWindow = Window & { __dictation: { instances: (SpeechRecognitionLike & { stops: number; aborts: number })[]; result: (text: string, final: boolean) => void; end: () => void; error: (code: string) => void } };

/** Injeta o Web Speech antes da hidratação; ausência também é testável sem depender da plataforma do runner. */
async function installDictation(page: Page, supported = true) {
  await page.addInitScript((available) => {
    const target = window as unknown as DictationWindow & { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
    const instances: DictationWindow['__dictation']['instances'] = [];
    /** Reconhecimento de uma só escuta, controlado pelo teste; stop e abort deixam evidência da liberação do microfone. */
    class FakeSpeech {
      lang = ''; continuous = true; interimResults = false; stops = 0; aborts = 0;
      onresult: SpeechRecognitionLike['onresult'] = null;
      onerror: SpeechRecognitionLike['onerror'] = null;
      onend: SpeechRecognitionLike['onend'] = null;
      /** Inicia sem entregar texto automaticamente, como quando o navegador aguarda a fala. */
      start() { instances.push(this); }
      /** Encerra por gesto, como a entrega do evento end pelo navegador. */
      stop() { this.stops++; this.onend?.(); }
      /** Aborta por edição, envio ou desmontagem. */
      abort() { this.aborts++; this.onend?.(); }
    }
    target.SpeechRecognition = available ? FakeSpeech : undefined;
    target.webkitSpeechRecognition = undefined;
    target.__dictation = {
      instances,
      result: (text, final) => instances.at(-1)?.onresult?.({ results: [{ isFinal: final, 0: { transcript: text } }] }),
      end: () => instances.at(-1)?.onend?.(),
      error: (code) => instances.at(-1)?.onerror?.({ error: code }),
    };
  }, supported);
}

test.describe('ditado no composer (T4)', () => {
  test('insere hipóteses no cursor, preserva edição, para por gesto e silêncio e libera ao sair, sem enviar sozinho', async ({ page }) => {
    test.setTimeout(120_000);
    await ensureCredential(page, 'provider', PROVIDER_KEY);
    await installDictation(page);
    const headers = await apiHeaders(page);
    const request = page.context().request;
    const settings = await request.get(`${ORIGIN}/api/settings`, { headers });
    const original = await settings.json();
    expect((await request.put(`${ORIGIN}/api/settings`, { headers, data: { ...original, language: 'en' } })).status()).toBe(200);
    const botId = await createBot(page, 'Ditado por cursor');
    let sends = 0;
    let reads = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/messages$/.test(request.url())) sends++;
      if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/settings') reads++;
    });
    try {
      await page.goto(`/bots/${botId}`);
      const field = composer(page);
      const mic = page.getByRole('button', { name: 'Ditar', exact: true });
      await expect(mic).toBeEnabled();
      await field.fill('Antes depois');
      await field.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(6, 6));
      await mic.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: 'Parar ditado' })).toHaveAttribute('aria-pressed', 'true');
      expect(await page.evaluate(() => { const current = (window as unknown as DictationWindow).__dictation.instances.at(-1)!; return { lang: current.lang, continuous: current.continuous, interim: current.interimResults }; })).toEqual({ lang: 'en-US', continuous: false, interim: true });
      await page.evaluate(() => (window as unknown as DictationWindow).__dictation.result('parc', false));
      await expect(field).toHaveValue('Antes parc depois');
      await page.evaluate(() => (window as unknown as DictationWindow).__dictation.result('final', true));
      await expect(field).toHaveValue('Antes final depois');
      expect(await field.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(11);
      await page.evaluate(() => (window as unknown as DictationWindow).__dictation.end());
      await expect(mic).toHaveAttribute('aria-pressed', 'false');
      expect(sends).toBe(0);

      // Outra escuta troca só a seleção; a edição manual encerra a escuta e não é sobrescrita por evento tardio.
      await field.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(6, 11));
      await mic.click();
      await page.evaluate(() => (window as unknown as DictationWindow).__dictation.result('novo', false));
      await expect(field).toHaveValue('Antes novo depois');
      await field.fill('Texto revisado pelo dono');
      await page.evaluate(() => (window as unknown as DictationWindow).__dictation.result('tardio', true));
      await expect(field).toHaveValue('Texto revisado pelo dono');
      expect(await page.evaluate(() => (window as unknown as DictationWindow).__dictation.instances.at(-1)!.aborts)).toBe(1);
      await field.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(element.value.length, element.value.length));
      await mic.click();
      await page.evaluate(() => (window as unknown as DictationWindow).__dictation.result('acréscimo', false));
      await page.getByRole('button', { name: 'Parar ditado' }).press('Space');
      await expect(field).toHaveValue('Texto revisado pelo dono acréscimo');
      expect(await page.evaluate(() => (window as unknown as DictationWindow).__dictation.instances.at(-1)!.stops)).toBe(1);
      expect(sends).toBe(0);

      // Navegação cliente desmonta a conversa, mas mantém as preferências do shell. A gravação muda o idioma da próxima escuta.
      await mic.click();
      await page.getByRole('link', { name: 'Configurações do bot' }).click();
      await expect(page).toHaveURL(new RegExp(`/bots/${botId}/editar$`));
      await expect.poll(() => page.evaluate(() => (window as unknown as DictationWindow).__dictation.instances.at(-1)!.aborts)).toBe(1);
      await page.getByRole('link', { name: 'Configurações', exact: true }).click();
      await page.getByRole('complementary').getByRole('link', { name: 'Preferências', exact: true }).click();
      await page.getByLabel('Idioma das respostas', { exact: true }).selectOption('es'); // grava ao escolher, sem botão Salvar
      await expect(page.getByText('Salvo', { exact: true })).toBeVisible();
      await page.getByRole('link', { name: 'Bots', exact: true }).click();
      await page.getByRole('link', { name: /Ditado por cursor/ }).click();
      await mic.click();
      expect(await page.evaluate(() => (window as unknown as DictationWindow).__dictation.instances.at(-1)!.lang)).toBe('es-ES');
      expect(reads).toBe(1);
      expect(sends).toBe(0);
    } finally {
      expect((await request.put(`${ORIGIN}/api/settings`, { headers, data: original })).status()).toBe(200);
    }
  });

  test('estados e cinco erros são acessíveis em bot e Chat geral, 1440 e 375 px, com movimento reduzido', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const problems = watchPage(page);
    await ensureCredential(page, 'provider', PROVIDER_KEY);
    await installDictation(page);
    const botId = await createBot(page, 'Ditado acessível');
    const headers = await apiHeaders(page);
    const created = await page.context().request.post(`${ORIGIN}/api/chat/sessions`, { headers });
    expect(created.status()).toBe(201);
    const sessionId = ((await created.json()) as { id: string }).id;
    expect((await page.context().request.patch(`${ORIGIN}/api/chat/sessions/${sessionId}/conversation`, { headers, data: { model: 'opencode/glm-5.1', effort: null } })).status()).toBe(200);
    const errors = [
      ['not-allowed', 'Permita o microfone nas configurações do site para ditar.', 'alert'],
      ['no-speech', 'Não ouvi nada. Tente de novo.', 'status'],
      ['network', 'O ditado precisa de conexão com a internet.', 'alert'],
      ['audio-capture', 'Não consegui acessar o microfone.', 'alert'],
      ['service-not-allowed', 'O ditado por voz não funciona neste modo. Use o ditado do teclado.', 'alert'],
    ] as const;
    for (const [kind, id] of [['bots', botId], ['chat', sessionId]]) {
      for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: width === 1440 ? 900 : 812 });
        const response = await page.goto(`/${kind}/${id}`);
        expect(response!.headers()['permissions-policy']).toBe('camera=(), microphone=(self), geolocation=()');
        const mic = page.getByRole('button', { name: 'Ditar', exact: true });
        await expect(mic).toBeEnabled();
        await expect(mic).toHaveAttribute('aria-pressed', 'false');
        await mic.focus();
        await expect(page.getByRole('tooltip')).toHaveText('Ditar (o áudio é processado pelo navegador)');
        await attachShot(page, testInfo, `ditado-${kind}-${width}-ocioso`);
        await page.keyboard.press('Enter');
        const listening = page.getByRole('status').filter({ hasText: 'Ouvindo… o áudio é processado pelo navegador.' });
        await expect(listening).toBeVisible();
        await expect(page.locator('form.composer').getByRole('status')).toContainText('Ouvindo');
        await expectNoHorizontalScroll(page);
        await expectNoA11yViolations(page);
        await attachShot(page, testInfo, `ditado-${kind}-${width}-ouvindo`);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        expect(await listening.locator('span').evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.evaluate(() => (window as unknown as DictationWindow).__dictation.end());
        for (const [code, message, role] of errors) {
          await mic.click();
          await page.evaluate((code) => (window as unknown as DictationWindow).__dictation.error(code), code);
          await expect(page.getByRole(role).filter({ hasText: message })).toBeVisible();
          await expect(mic).toHaveAttribute('aria-pressed', 'false');
          await expectNoHorizontalScroll(page);
          await expectNoA11yViolations(page);
          await attachShot(page, testInfo, `ditado-${kind}-${width}-${code}`);
        }
        if (width === 375) expect((await mic.boundingBox())!.width).toBeGreaterThanOrEqual(40);
        await expect(composer(page)).toHaveValue('');
      }
    }
    expect(problems).toEqual([]);
  });

  test('sem API não oferece microfone e prefere aguardar o idioma confirmado antes de iniciar', async ({ page }) => {
    await ensureCredential(page, 'provider', PROVIDER_KEY);
    await installDictation(page, false);
    const botId = await createBot(page, 'Ditado indisponível');
    await page.goto(`/bots/${botId}`);
    await expect(composer(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ditar', exact: true })).toHaveCount(0);
    await installDictation(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/settings', async (route) => { await gate; await route.fulfill({ status: 503, json: { code: 'INTERNAL_ERROR', message: 'Tente novamente.' } }); });
    await page.reload();
    const mic = page.getByRole('button', { name: 'Ditar', exact: true });
    await expect(mic).toBeVisible();
    await expect(mic).toBeDisabled();
    release();
    await expect(mic).toBeDisabled();
    expect(await page.evaluate(() => (window as unknown as DictationWindow).__dictation.instances.length)).toBe(0);
  });
});

/** Anexa a captura ao relatório e, com `AION_E2E_SHOTS_DIR`, também grava o PNG nessa pasta. */
async function attachShot(page: Page, testInfo: TestInfo, name: string) {
  const body = await page.screenshot();
  await testInfo.attach(name, { body, contentType: 'image/png' });
  const dir = process.env.AION_E2E_SHOTS_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}.png`), body);
  }
}

/**
 * Prepara a conferência das cópias (antes do `goto`) e devolve a leitura da última. A cópia é conferida em dois pontos: o texto EXATO que a página
 * entrega ao `writeText` (gravado antes de chegar ao sistema) e o que a área de transferência devolve. O Windows guarda quebras de linha como CRLF
 * na área de transferência, então a leitura volta com `\r\n` nesse sistema; a normalização vale só para a leitura, e a igualdade estrita fica no
 * valor entregue pela página. Usada pelos blocos cercados (phase 3) e pela barra de ações (phase 4).
 */
async function trackCopies(page: Page): Promise<() => Promise<string | undefined>> {
  await page.addInitScript(() => {
    const target = window as unknown as { __copies: string[] };
    target.__copies = [];
    const original = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = (text: string) => {
      target.__copies.push(text);
      return original(text);
    };
  });
  return async () => {
    const written = await page.evaluate(() => (window as unknown as { __copies: string[] }).__copies.at(-1));
    const read = await page.evaluate(() => navigator.clipboard.readText());
    expect(read.replace(/\r\n/g, '\n'), 'a área de transferência recebe o mesmo texto').toBe(written);
    return written;
  };
}

/** Cria um bot pela API (mais rápido que pela tela; o editor já tem a própria prova), com o nome exclusivo da repetição (`uniqueBotName`, E29), e devolve o id. */
async function createBot(page: Page, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const unique = uniqueBotName(name);
  const response = await page.context().request.post(`${ORIGIN}/api/bots`, {
    headers: await apiHeaders(page),
    data: { name: unique, color: '#60A5FA', instructions: '', model: 'opencode/glm-5.1', effort: null, stepLimit: 25, ...extra },
  });
  expect(response.status(), `criar o bot ${unique}`).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/** Envia uma mensagem pela API (simula outra aba ou dispositivo). */
async function sendViaApi(page: Page, botId: string, content: string) {
  const response = await page.context().request.post(`${ORIGIN}/api/bots/${botId}/messages`, { headers: await apiHeaders(page), data: { content } });
  expect(response.status(), 'enviar pela API').toBe(201);
}

const composer = (page: Page) => page.getByRole('textbox', { name: 'Mensagem' });
const log = (page: Page) => page.getByRole('log', { name: 'Conversa' });
/** Selo do cabeçalho (texto exato: a linha da Faísca acima do composer diz "Trabalhando…" com reticências). */
const workingBadge = (page: Page) => page.getByText('Trabalhando', { exact: true });
/** As Faíscas de DESTAQUE da lista de mensagens (a conversa vazia e os cartões), sem a do cabeçalho e sem a da linha fixa de trabalho (`workingLine`, fora da lista). */
const threadFaiscas = (page: Page) => log(page).locator('svg.faisca');
/** A linha fixa da Faísca acima do composer (phase 18, ID-04): fora do log, só enquanto a conversa trabalha. */
const workingLine = (page: Page) => page.locator('[data-working-line]');
/**
 * Um cartão com Faísca: a Faísca de 32 px decorativa, parada e na cor do bot, no lugar do ícone de 14 px da legenda, com o título e o texto do cartão
 * de sempre. `body` é um texto do corpo do cartão, que serve de régua do layout: a Faísca fica à esquerda dele, na mesma altura do cartão.
 */
async function expectCardFaisca(card: Locator, state: string, body: string, color = '#60A5FA'): Promise<void> {
  expect(await faiscaLook(card.locator('svg.faisca')), `Faísca do cartão (${state})`).toMatchObject({ state, detail: 'small', still: true, decorative: true, size: [32, 32], body: color.toUpperCase() });
  await expect(card.locator('svg[data-icon]'), 'o ícone de 14 px da legenda sai').toHaveCount(0);
  const [faisca, text] = await Promise.all([card.locator('svg.faisca').boundingBox(), card.getByText(body).boundingBox()]);
  expect(faisca!.x + faisca!.width, 'a Faísca fica à esquerda do texto').toBeLessThanOrEqual(text!.x);
}

/** Em 375 px as ações do cartão vão para uma linha abaixo do corpo, e a Faísca continua à esquerda do corpo, na primeira linha. */
async function expectActionsBelowBody(card: Locator, body: string, action: string): Promise<void> {
  const [faisca, text, button] = await Promise.all([card.locator('svg.faisca').boundingBox(), card.getByText(body).boundingBox(), card.getByRole('button', { name: action }).boundingBox()]);
  expect(button!.y, 'as ações ficam abaixo do corpo').toBeGreaterThanOrEqual(text!.y + text!.height);
  expect(faisca!.y + faisca!.height, 'a Faísca fica na linha do corpo, acima das ações').toBeLessThanOrEqual(button!.y);
  expect(faisca!.x, 'a Faísca continua à esquerda').toBeLessThan(text!.x);
}

/** Digita e envia com Enter (o caminho de teclado do composer). */
async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

// ---------------------------------------------------------------------------------------------
// Histórico por rodadas (F4)
// ---------------------------------------------------------------------------------------------

const SEEDED_ROUNDS = 26;
/** A frase da rodada 1 (a mais antiga), que a busca no histórico e o link "ver na conversa" procuram. */
const OLDEST_FACT = 'A reunião com a Acme definiu um contrato de 12 meses';
const MESSAGES_PAGE = (url: URL) => url.pathname.endsWith('/conversation/messages');
const LOAD_OLDER_BUTTON = 'Carregar mensagens anteriores';
const LOADING_TEXT = 'Carregando mensagens anteriores…';
const LOAD_FAILED_TEXT = 'Não foi possível carregar as mensagens anteriores.';

/** Bolha do dono da rodada `n` ("rodada n"; a da 1 é `OLDEST_FACT`). Texto exato: a resposta do bot ("Resposta: rodada n") não casa. */
const roundBubble = (page: Page, n: number) => log(page).getByText(n === 1 ? OLDEST_FACT : `rodada ${n}`, { exact: true });
/** Quantas rodadas (bolhas do dono) a tela tem carregadas. */
const loadedRounds = (page: Page) => log(page).locator('[id^="message-"]').filter({ hasText: /^(rodada \d+|A reunião com a Acme.*)$/ });
/** Distância da rolagem até o fim da lista, em px. */
const distanceFromBottom = (page: Page) => log(page).evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);
/** Rodadas cuja posição na tela prova que a leitura não pulou (as mais antigas da primeira página, que a carga das anteriores empurra para baixo). */
const READING_ROUNDS = [17, 18, 19, 20];
/** Posição vertical (px na janela) da bolha de cada rodada: antes e depois de uma carga, a diferença é o salto da leitura. */
const yOfRounds = (page: Page, rounds: number[]) => Promise.all(rounds.map(async (n) => (await roundBubble(page, n).boundingBox())!.y));
const scrollLogTo = (page: Page, top: number) =>
  log(page).evaluate((element, value) => {
    element.scrollTop = value;
  }, top);

/**
 * Envia uma mensagem pela API. O limite de 60 mensagens por minuto vale para a API inteira (não por conversa), e os testes anteriores do arquivo
 * já gastaram parte dele: a recusa 429 espera o `Retry-After` e tenta de novo, em vez de falhar um teste que não é sobre o limite.
 */
async function postMessage(page: Page, url: string, headers: Record<string, string>, content: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await page.context().request.post(url, { headers, data: { content } });
    if (response.status() === 201) return;
    expect(response.status(), `enviar "${content.slice(0, 30)}"`).toBe(429);
    await page.waitForTimeout((Number(response.headers()['retry-after']) || 5) * 1000);
  }
  throw new Error('o limite de mensagens por minuto não liberou a tempo');
}

/** Espera a conversa ficar sem execução aberta (na fila, rodando ou aguardando aprovação). */
async function waitIdle(page: Page, base: string, headers: Record<string, string>): Promise<void> {
  await expect
    .poll(async () => ((await (await page.context().request.get(`${ORIGIN}${base}/conversation`, { headers })).json()) as { runs: unknown[] }).runs.length, { timeout: 60_000 })
    .toBe(0);
}

/**
 * Cria `SEEDED_ROUNDS` rodadas pelo produto de verdade (mensagens pela API e o worker real respondendo com o provedor falso), uma de cada vez: desde a
 * phase 4 (CONV-03), uma mensagem enviada com a execução anterior ainda ativa vira COMPLEMENTO dela e não abre rodada, então cada envio espera o
 * anterior terminar. `base` é o prefixo da conversa (`/api/bots/:id` ou `/api/chat/sessions/:id`) e `headers` vêm de UM login feito ANTES de abrir a
 * tela (E22). A rodada 1 é `OLDEST_FACT`; as demais, "rodada n".
 */
async function seedRounds(page: Page, base: string, headers: Record<string, string>): Promise<void> {
  for (let n = 1; n <= SEEDED_ROUNDS; n += 1) {
    await postMessage(page, `${ORIGIN}${base}/messages`, headers, n === 1 ? OLDEST_FACT : `rodada ${n}`);
    await waitIdle(page, base, headers);
  }
}

/** O bot com as rodadas semeadas, criado uma vez e reaproveitado pelos testes de histórico (eles só leem a conversa, exceto o último). */
let longBot: { id: string; firstMessageId: string } | undefined;
async function ensureLongBot(page: Page): Promise<{ id: string; firstMessageId: string }> {
  if (longBot) {
    await apiLogin(page.context()); // cada teste tem um contexto novo: sem sessão a tela cairia no login
    return longBot;
  }
  await ensureCredential(page, 'provider', PROVIDER_KEY);
  const id = await createBot(page, 'Rodadeiro');
  const headers = await apiHeaders(page);
  await seedRounds(page, `/api/bots/${id}`, headers);
  // O id da mensagem da rodada 1 (para o link "ver na conversa"): a página mais antiga com 50 rodadas a traz inteira.
  const all = (await (await page.context().request.get(`${ORIGIN}/api/bots/${id}/conversation/messages?rounds=50&before=999999999999999999`, { headers })).json()) as {
    items: { id: string; kind: string; role?: string }[];
  };
  const first = all.items.find((item) => item.kind === 'text' && item.role === 'user');
  expect(first, 'a rodada 1 existe').toBeDefined();
  longBot = { id, firstMessageId: first!.id };
  return longBot;
}

/** Sessão do chat geral com as mesmas rodadas semeadas (a conversa sem bot: a lista e o histórico se comportam como os do bot). */
async function createSessionWithRounds(page: Page): Promise<string> {
  await ensureCredential(page, 'provider', PROVIDER_KEY);
  const headers = await apiHeaders(page);
  const request = page.context().request;
  const created = await request.post(`${ORIGIN}/api/chat/sessions`, { headers });
  expect(created.status(), 'criar a sessão').toBe(201);
  const id = ((await created.json()) as { id: string }).id;
  const preference = await request.patch(`${ORIGIN}/api/chat/sessions/${id}/conversation`, { headers, data: { model: 'opencode/glm-5.1', effort: null } });
  expect(preference.status(), 'escolher o modelo').toBe(200);
  await seedRounds(page, `/api/chat/sessions/${id}`, headers);
  return id;
}

/**
 * O caminho completo do histórico, igual para o bot e para a sessão: abre nas 10 últimas rodadas rolada ao fim, segura o primeiro pedido para
 * ver "Carregando…", confere que a leitura não pula quando as 10 anteriores entram, e vai até "Início da conversa".
 */
async function expectRoundsFlow(page: Page, testInfo: TestInfo, shots: string): Promise<void> {
  await expect(log(page).getByText(`Resposta: rodada ${SEEDED_ROUNDS}`)).toBeVisible();
  // Abre rolada ao fim com as 10 últimas rodadas (17 a 26); a 16 ainda não foi carregada, e o botão do topo existe para teclado e leitor de tela.
  expect(await distanceFromBottom(page)).toBeLessThan(80);
  await expect(loadedRounds(page)).toHaveCount(10);
  await expect(roundBubble(page, 17)).toBeAttached();
  await expect(roundBubble(page, 16)).toHaveCount(0);
  await expect(page.getByRole('button', { name: LOAD_OLDER_BUTTON })).toBeAttached();
  await attachShot(page, testInfo, `${shots}-aberta-no-fim`);

  // Segura a resposta do primeiro pedido: ao chegar ao topo (a menos de 200 px) a carga começa sozinha, e a faixa mostra "Carregando…".
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(MESSAGES_PAGE, async (route) => {
    await held;
    await route.continue();
  });
  await scrollLogTo(page, 0);
  const loading = log(page).getByText(LOADING_TEXT);
  await expect(loading).toBeVisible();
  await expect(loading).toHaveAttribute('aria-live', 'polite');
  await expect(page.getByRole('button', { name: LOAD_OLDER_BUTTON })).toHaveCount(0); // o spinner ocupa o lugar do botão
  const yBefore = await yOfRounds(page, READING_ROUNDS);
  await attachShot(page, testInfo, `${shots}-carregando`);
  await expectNoA11yViolations(page);
  release();
  await page.unrouteAll({ behavior: 'wait' }); // espera o pedido segurado seguir (soltar a rota no meio dele o cancelaria)

  // As 10 anteriores (7 a 16) entram em cima, e a mensagem que o dono lia continua no MESMO ponto da tela.
  await expect(roundBubble(page, 16)).toBeAttached();
  await expect(roundBubble(page, 7)).toBeAttached();
  await expect(loadedRounds(page)).toHaveCount(20);
  await expect(loading).toHaveCount(0);
  const yAfter = await yOfRounds(page, READING_ROUNDS);
  const jumps = yAfter.map((y, index) => Math.abs(y - yBefore[index]!));
  expect(Math.max(...jumps), `a leitura saltou (px por rodada): ${jumps.join(', ')}`).toBeLessThanOrEqual(1);

  // A última página tem as 6 rodadas que restam; ao terminar, a faixa vira "Início da conversa" e o botão some.
  await scrollLogTo(page, 0);
  await expect(roundBubble(page, 1)).toBeAttached();
  await expect(loadedRounds(page)).toHaveCount(SEEDED_ROUNDS);
  await scrollLogTo(page, 0);
  await expect(log(page).getByText('Início da conversa')).toBeInViewport();
  await expect(page.getByRole('button', { name: LOAD_OLDER_BUTTON })).toHaveCount(0);
  await attachShot(page, testInfo, `${shots}-inicio-da-conversa`);
  await expectNoA11yViolations(page);
}

// ---------------------------------------------------------------------------------------------
// Pesquisa e leitura de páginas na web (F7, T9)
// ---------------------------------------------------------------------------------------------

/** A URL de mais de 300 caracteres do terceiro resultado do cenário `cinco` da Parallel falsa (igual a `FAKE_LONG_URL` em fake-upstreams.ts). */
const LONG_URL = `https://exemplo.com.br/${'caminho-muito-longo-de-um-artigo/'.repeat(8)}pagina-final.html?utm_source=aion&utm_medium=teste&referencia=${'x'.repeat(40)}`;
const SEARCH_LABEL = /^Pesquisou na web: Pesquisar: cinco resultados/;
const FETCH_LABEL = /^Leu 3 páginas: exemplo\.com/;
const UNTRUSTED_NOTE = 'Conteúdo da web: o bot o trata como dado, não como instrução.';
const resultsList = (page: Page) => log(page).getByRole('list', { name: 'Resultados da pesquisa' });
const pagesList = (page: Page) => log(page).getByRole('list', { name: 'Páginas pedidas' });

/**
 * Os links dos resultados apontam para domínios fictícios: a rede de verdade nunca é usada. O roteamento do CONTEXTO vale também para a nova aba que o
 * clique abre (e para a leitura da página falsa); o app em si (127.0.0.1) não passa por aqui.
 */
async function stubExternalPages(page: Page): Promise<void> {
  await page.context().route(/^https?:\/\/(www\.)?(exemplo\.com\.br|exemplo\.com|mozilla\.org)\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<title>página falsa</title>' }),
  );
}

/** Pede ao bot (ou à sessão) a pesquisa de cinco resultados e a leitura de três URLs (uma não lida), e abre cada atividade na tela. */
async function runWebActivities(page: Page): Promise<void> {
  await send(page, '[web-pesquisar:cinco resultados]');
  const search = log(page).getByRole('button', { name: SEARCH_LABEL });
  await openWorkLine(log(page), search);
  await expect(search).toBeVisible();
  await search.click();
  await expect(resultsList(page)).toBeVisible();
  await send(page, '[web-ler:https://exemplo.com/a|https://exemplo.com/nao-lida|https://exemplo.com/longa/1]');
  const fetched = log(page).getByRole('button', { name: FETCH_LABEL });
  await openWorkLine(log(page), fetched);
  await expect(fetched).toBeVisible();
  await fetched.click();
  await expect(pagesList(page)).toBeVisible();
}

/** O que as duas atividades mostram, igual no bot e no chat geral e em qualquer largura. */
async function expectWebActivities(page: Page): Promise<void> {
  const results = resultsList(page);
  await expect(results.getByRole('listitem')).toHaveCount(5);
  await expect(results.getByRole('link')).toHaveCount(5);
  // A URL mais longa aparece INTEIRA, quebrando em vez de rolar para o lado, e o título dela é o link.
  const longUrl = results.getByText(LONG_URL, { exact: true });
  await longUrl.scrollIntoViewIfNeeded();
  await expect(longUrl).toBeVisible();
  expect(await longUrl.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const link = results.getByRole('link', { name: /Resultado número 3 da pesquisa/ });
  await expect(link).toHaveAttribute('href', LONG_URL);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(link).toHaveAccessibleName(/\(abre em nova aba\)$/);
  await expect(log(page).getByText(UNTRUSTED_NOTE)).toHaveCount(2); // uma por atividade aberta

  const pages = pagesList(page);
  await expect(pages.getByRole('listitem')).toHaveCount(3);
  await expect(pages.getByText('Lida', { exact: true })).toHaveCount(2);
  await expect(pages.getByText('Não lida', { exact: true })).toHaveCount(1);
  for (const url of ['https://exemplo.com/a', 'https://exemplo.com/nao-lida', 'https://exemplo.com/longa/1']) {
    const pageLink = pages.getByRole('link', { name: new RegExp(`^${url.replaceAll('.', '\\.').replaceAll('/', '\\/')}`) });
    await expect(pageLink).toHaveAttribute('href', url);
    await expect(pageLink).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(pageLink).toHaveText(`${url} (abre em nova aba)`); // a URL pedida, inteira, como texto do link (mais o aviso para o leitor de tela)
  }
  await expectNoHorizontalScroll(page);
}

test.describe('conversa no desktop (1440 × 900)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('envia, acompanha a resposta em streaming, agrupa e expande as atividades e acha o trecho antigo pela busca', async ({ page }, testInfo) => {
    const problems = watchPage(page);
    await ensureCredential(page, 'provider', PROVIDER_KEY);
    const botId = await createBot(page, 'Conversador');

    await page.goto(`/bots/${botId}`);
    await expect(page.getByRole('heading', { level: 2, name: `O que o ${uniqueBotName('Conversador')} faz agora?` })).toBeVisible();
    // A conversa vazia tem a Faísca do bot de 112 px (nível completo), ociosa (nenhum laço: só trabalhando e aguardando se mexem), decorativa e com a entrada; é a única da lista.
    await expect(threadFaiscas(page)).toHaveCount(1);
    expect(await faiscaLook(threadFaiscas(page))).toMatchObject({ state: 'idle', detail: 'full', still: true, decorative: true, size: [112, 112], body: '#60A5FA' });
    await expect(threadFaiscas(page)).toHaveAttribute('data-enter', '');
    await expect(composer(page)).toBeEnabled();
    await expect(page.getByRole('button', { name: 'opencode/glm-5.1', exact: true })).toBeVisible(); // o modelo do bot, já resolvido
    await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeDisabled(); // campo vazio
    await attachShot(page, testInfo, 'conversa-1440-vazia-composer');

    // A resposta aparece INTEIRA, de uma vez (T19): enquanto o modelo escreve (8 pedaços em 2 s) a tela mostra o selo "Trabalhando" no
    // cabeçalho e a linha da Faísca "Trabalhando…" acima do composer, e nenhum pedaço do texto; no fim o texto completo surge numa só vez.
    await send(page, '[lento] conte até oito');
    await expect(log(page).getByText('[lento] conte até oito')).toBeVisible();
    await expect(composer(page)).toHaveValue('');
    await expect(workingBadge(page)).toBeVisible();
    await expect(workingLine(page).getByText('Trabalhando…')).toBeVisible();
    await expect(log(page).getByText('Trabalhando…')).toHaveCount(0); // nunca rola junto com as mensagens (A8)
    await attachShot(page, testInfo, 'conversa-1440-trabalhando');
    const reply = log(page).locator('.markdown').filter({ hasText: 'parte1' });
    // Acompanha o DOM durante toda a escrita: o texto nunca aparece incompleto (só ausente ou inteiro, com o último pedaço).
    const seen = await page.evaluate(async () => {
      const states = new Set<string>();
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        const found = [...document.querySelectorAll('[role="log"] .markdown')].map((node) => node.textContent ?? '').find((value) => value.includes('parte'));
        states.add(found === undefined ? 'ausente' : found.includes('parte8') ? 'inteiro' : 'parcial');
        if (found?.includes('parte8')) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return [...states];
    });
    expect(seen).toContain('inteiro');
    expect(seen).not.toContain('parcial');
    await expect(reply).toContainText('parte8');
    await expect(workingLine(page)).toHaveCount(0); // a execução terminou: a linha some (A8)
    await expect(workingBadge(page)).toHaveCount(0);
    // A resposta do bot não é balão (A4, UI-07): sem borda, sem fundo e sem a Faísca ao lado; a mensagem do dono continua em balão (A5).
    const answer = log(page).locator('[id^="message-"]').filter({ hasText: 'parte8' });
    await expect(answer).toHaveCSS('border-top-width', '0px');
    await expect(answer).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(log(page).locator('[data-bot-marker]')).toHaveCount(0);
    await expect(threadFaiscas(page)).toHaveCount(0);
    const ownerBubble = log(page).locator('[id^="message-"]').filter({ hasText: '[lento] conte até oito' });
    expect(await ownerBubble.evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    await attachShot(page, testInfo, 'conversa-1440-resposta-completa');
    await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeDisabled();

    // Uma mensagem antiga com o fato que a busca vai achar, e as três ações da mesma etapa agrupadas.
    await send(page, 'A reunião com a Acme definiu um contrato de 12 meses');
    await expect(log(page).getByText('Resposta: A reunião com a Acme')).toBeVisible();
    await send(page, '[pesquisar:alpha|beta|gama] procure três coisas');
    const group = page.getByRole('button', { name: /^Trabalhou por .* · 3 ações/ });
    await expect(group).toBeVisible();
    await expect(group).toHaveAttribute('aria-expanded', 'false');
    await group.click();
    await expect(group).toHaveAttribute('aria-expanded', 'true');
    for (const term of ['alpha', 'beta', 'gama']) await expect(log(page).getByRole('button', { name: `Pesquisou no histórico: ${term}` })).toBeVisible();
    // A10: a linha "Trabalhou por" também abre e fecha pelo teclado: Enter abre, Espaço fecha.
    await group.click();
    await expect(group).toHaveAttribute('aria-expanded', 'false');
    await group.focus();
    await page.keyboard.press('Enter');
    await expect(group).toHaveAttribute('aria-expanded', 'true');
    await expect(log(page).getByRole('button', { name: 'Pesquisou no histórico: alpha' })).toBeVisible();
    await page.keyboard.press('Space');
    await expect(group).toHaveAttribute('aria-expanded', 'false');
    await group.click();
    await expect(group).toHaveAttribute('aria-expanded', 'true');
    await log(page).getByRole('button', { name: 'Pesquisou no histórico: beta' }).click();
    await expect(log(page).getByText('search_history').first()).toBeVisible(); // o slug em mono, no detalhe
    await expect(log(page).getByText('Nenhum trecho encontrado.').first()).toBeVisible();
    await attachShot(page, testInfo, 'conversa-1440-atividades-agrupadas');
    await expectNoA11yViolations(page);

    // Busca com resultado: trecho, data e "ver na conversa" que rola até a mensagem e a destaca.
    await send(page, '[pesquisar:contratos Acme] o que combinamos?');
    const search = log(page).getByRole('button', { name: 'Pesquisou no histórico: contratos Acme' });
    await openWorkLine(log(page), search);
    await expect(search).toBeVisible();
    await search.click();
    // Dois trechos batem (a pergunta original e o eco do bot); o teste segue o da pergunta do dono.
    const hit = log(page)
      .locator('li')
      .filter({ has: page.getByRole('button', { name: 'ver na conversa' }) }) // só os trechos da atividade (a resposta do bot também lista o resultado)
      .filter({ hasText: 'contrato de 12 meses' })
      .filter({ hasNotText: 'Resposta:' });
    await expect(hit).toBeVisible();
    await expect(hit.getByText(/\d{2}\/\d{2}\/\d{4}/)).toBeVisible();
    await attachShot(page, testInfo, 'conversa-1440-busca-historico');
    await hit.getByRole('button', { name: 'ver na conversa' }).click();
    const origin = log(page).locator('[id^="message-"]').filter({ hasText: 'A reunião com a Acme definiu um contrato de 12 meses' }).filter({ hasNotText: 'Resposta:' });
    await expect(origin).toBeInViewport();
    await expect(origin).toHaveCSS('outline-width', '2px'); // o destaque da mensagem de origem
    await expect(origin).not.toHaveCSS('outline-width', '2px'); // o destaque some sozinho em 2 s

    expect(problems).toEqual([]);
  });

  test('uma mensagem enviada com o bot ocupado vira complemento aguardando; parar interrompe com o cartão e devolve o complemento ao composer', async ({ page }, testInfo) => {
    const problems = watchPage(page);
    const botId = await createBot(page, 'Fila');
    await page.goto(`/bots/${botId}`);

    // Histórico que faz o log rolar (A6): uma mensagem longa e a resposta dela, antes de o bot ficar ocupado.
    await send(page, LONG_HISTORY_MESSAGE);
    await expect(log(page).locator('.markdown').filter({ hasText: 'Resposta:' })).toBeVisible();
    await send(page, '[demorar] trabalhando sem fim');
    await expect(workingBadge(page)).toBeVisible();
    await expect(workingLine(page).getByText('Trabalhando…')).toBeVisible();
    // A linha fixa (ID-04) tem a Faísca de 24 px trabalhando (se mexe: é o foco), sem spinner, e a frase numa região educada, acima do composer e fora da lista. A Faísca do
    // cabeçalho também trabalha; na lista não sobra nenhuma.
    const lineFaisca = workingLine(page).locator('svg.faisca');
    await expect(lineFaisca).toHaveCount(1);
    expect(await faiscaLook(lineFaisca)).toMatchObject({ state: 'working', detail: 'small', still: false, decorative: true, size: [24, 24], body: '#60A5FA' });
    await expect(threadFaiscas(page)).toHaveCount(0);
    await expect(workingLine(page).locator('[data-icon="LoaderCircle"]')).toHaveCount(0);
    await expect(workingLine(page).getByText('Trabalhando…')).toHaveAttribute('aria-live', 'polite');
    // A6: com o histórico rolado até o topo a linha continua visível, logo acima do composer.
    await expectWorkingLineAtTop(page, log(page), workingLine(page));
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'conversa-1440-indicador-faisca');
    // Movimento reduzido (A9): a Faísca da linha cai na pose estática (nenhuma animação roda, o ícone do estado continua dizendo o estado) e a frase segue lá; depois volta a se mexer.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => runningAnimations(lineFaisca)).toBe(0);
    await expect(workingLine(page).getByText('Trabalhando…')).toBeVisible();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect.poll(() => runningAnimations(lineFaisca)).toBeGreaterThan(0);
    // O texto que o modelo vai escrevendo fica escondido até a execução terminar ou ser parada (T19).
    await page.waitForTimeout(700); // alguns pedaços de 200 ms já chegaram ao banco
    await expect(log(page).getByText('passo 1', { exact: false })).toHaveCount(0);
    // Com o campo vazio e uma execução ativa, o botão circular é "Parar"; com texto digitado, continua sendo "Enviar".
    await expect(page.getByRole('button', { name: 'Parar execução' })).toBeVisible();
    await send(page, 'depois da parada');
    await expect(page.getByRole('button', { name: 'Parar execução' })).toBeVisible(); // campo limpo de novo
    // Phase 4 (CONV-03): com o bot ocupado o envio COMPLEMENTA o pedido, sem interromper a execução, e não entra na fila.
    const pending = log(page).locator('[data-complement="pending"]');
    await expect(pending).toContainText('depois da parada');
    await expect(pending.getByText('Complemento · aguardando')).toBeVisible();
    await expect(log(page).getByText('Na fila', { exact: true })).toHaveCount(0);
    await expect(workingBadge(page)).toBeVisible();
    await attachShot(page, testInfo, 'conversa-1440-complemento-aguardando');

    await page.getByRole('button', { name: 'Parar execução' }).click();
    const card = page.getByRole('region', { name: 'Execução interrompida' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('Nenhuma etapa havia sido concluída.');
    // A interrupção não é falha nem aviso da Faísca: o cartão fica com o ícone de 14 px, sem Faísca.
    await expect(card.locator('svg.faisca')).toHaveCount(0);
    await expect(card.locator('svg[data-icon]')).toHaveCount(1);
    await attachShot(page, testInfo, 'conversa-1440-interrompida');
    // Parar devolve o complemento não lido ao composer vazio, com aviso, sem executá-lo (A11).
    await expect(composer(page)).toHaveValue('depois da parada');
    await expect(page.getByText('Seu complemento voltou para o campo de mensagem.')).toBeVisible();
    await expect(pending).toHaveCount(0);
    await expect(log(page).getByText('Resposta: depois da parada')).toHaveCount(0);
    await expect(workingBadge(page)).toHaveCount(0);
    // A resposta parcial da execução interrompida ficou, inteira e concluída: ao parar, o texto escrito até ali aparece.
    await expect(log(page).locator('.markdown').filter({ hasText: 'passo 1' })).toBeVisible();
    await expectNoA11yViolations(page);
    expect(problems).toEqual([]);
  });

  test('o limite de etapas encerra com o relatório; a falha do provedor vira cartão com "Tentar novamente"', async ({ page }, testInfo) => {
    const problems = watchPage(page);
    const limited = await createBot(page, 'Limitado', { stepLimit: 2 });
    await page.goto(`/bots/${limited}`);
    await send(page, '[loop] sem parar');
    const limit = page.getByRole('region', { name: 'Limite atingido' });
    await expect(limit).toBeVisible();
    await expect(limit).toContainText('O limite de chamadas de ferramenta desta execução foi atingido.');
    await expect(limit.getByText('Pesquisou no histórico: loop')).toHaveCount(2);
    await expect(workingBadge(page)).toHaveCount(0);
    // Limite atingido e falha mostram a Faísca em erro, parada, na cor do bot, no lugar do ícone da legenda.
    await expectCardFaisca(limit, 'error', 'O limite de chamadas de ferramenta desta execução foi atingido.');
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'conversa-1440-limite-atingido');

    const flaky = await createBot(page, 'Instável');
    await page.goto(`/bots/${flaky}`);
    await send(page, '[falha] provedor fora do ar');
    const failure = page.getByRole('region', { name: 'A execução falhou' });
    await expect(failure).toBeVisible();
    await expect(failure).toContainText('O provedor falhou ao responder. Tente novamente.');
    await expect(failure).not.toContainText('Service unavailable'); // nada do erro cru do provedor
    await expectCardFaisca(failure, 'error', 'O provedor falhou ao responder. Tente novamente.');
    await attachShot(page, testInfo, 'conversa-1440-falha');
    await failure.getByRole('button', { name: 'Tentar novamente' }).click();
    await expect(log(page).getByText('Resposta: [Sistema]')).toBeVisible();
    await expect(failure.getByRole('button', { name: 'Tentar novamente' })).toHaveCount(0);
    // Uma só bolha do dono: a repetição reaproveita a mensagem.
    await expect(log(page).getByText('[falha] provedor fora do ar')).toHaveCount(1);
    await expectNoA11yViolations(page);
    expect(problems).toEqual([]);
  });

  test('o Markdown do bot é renderizado sem executar HTML, carregar imagem de terceiros nem aceitar link perigoso', async ({ page }, testInfo) => {
    const problems = watchPage(page);
    const botId = await createBot(page, 'Markdown');
    await page.goto(`/bots/${botId}`);
    const hostile = 'Olá **negrito** e `código`. <script>window.__pwned = 1</script> ![x](https://evil.example/x.png) [clique](javascript:alert(1)) [ok](https://exemplo.com)';
    await send(page, hostile);
    const answer = log(page).locator('.markdown').filter({ hasText: 'Resposta:' });
    await expect(answer).toBeVisible();
    await expect(answer.locator('strong')).toHaveText('negrito');
    await expect(answer.locator('code').first()).toHaveText('código');
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    await expect(answer.locator('script')).toHaveCount(0);
    await expect(answer.locator('img')).toHaveCount(0);
    const hrefs = await answer.locator('a').evaluateAll((links) => links.map((link) => link.getAttribute('href')));
    expect(hrefs.every((href) => !(href ?? '').toLowerCase().startsWith('javascript:'))).toBe(true);
    const safe = answer.getByRole('link', { name: 'ok' });
    await expect(safe).toHaveAttribute('href', 'https://exemplo.com');
    await expect(safe).toHaveAttribute('rel', /noopener/);
    await expect(safe).toHaveAttribute('target', '_blank');
    await expect(answer.getByRole('link', { name: 'clique' })).toHaveCount(0); // o link perigoso virou texto
    await attachShot(page, testInfo, 'conversa-1440-markdown');
    expect(problems).toEqual([]);
  });

  test('blocos cercados: `text` quebra sem rolar, código rola e quebra pelo controle, Copiar leva o conteúdo exato e anuncia, falha vira toast (1280, 375 e 320 px)', async ({ page }, testInfo) => {
    // Phase 3, T7 (A14 e A15; F8). O marcador [blocos] faz o provedor falso responder com um bloco `text` longo e um `ts` com linha de 200 colunas.
    test.setTimeout(150_000);
    const problems = watchPage(page);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await ensureCredential(page, 'provider', PROVIDER_KEY);
    const botId = await createBot(page, 'Blocos');
    await sendViaApi(page, botId, '[blocos] mande o texto e o código');
    const textCard = log(page).locator('[data-code-block="text"]');
    const codeCard = log(page).locator('[data-code-block="code"]');
    const codeBody = codeCard.locator('pre');
    /** Rolagem horizontal própria de um elemento (largura do conteúdo menos a visível). */
    const overflowOf = (locator: Locator) => locator.evaluate((element) => element.scrollWidth - element.clientWidth);
    const clipboard = await trackCopies(page);

    for (const width of [1280, 375, 320]) {
      await page.setViewportSize({ width, height: width === 1280 ? 900 : 812 });
      // Recarregar zera o "Quebrar linhas": o estado é por bloco e não persiste.
      await page.goto(`/bots/${botId}`);
      await expect(codeCard).toBeVisible();

      // Normal. Texto: rótulo "Texto", só Copiar, quebra sem rolar e na fonte do corpo (sans 15/24).
      await expect(textCard.getByText('Texto', { exact: true })).toBeVisible();
      await expect(textCard.getByRole('button')).toHaveCount(1);
      await expect(textCard.getByRole('button', { name: 'Copiar' })).toBeVisible();
      const textBody = textCard.locator('xpath=./div[2]'); // o corpo vem depois do cabeçalho do bloco
      expect(await overflowOf(textBody), 'o bloco `text` não rola na horizontal').toBeLessThanOrEqual(0);
      expect(await textBody.evaluate((element) => { const style = getComputedStyle(element); return [style.fontFamily.startsWith('"Inter'), style.fontSize, style.lineHeight]; })).toEqual([true, '15px', '24px']);
      expect(await textBody.evaluate((element) => element.getBoundingClientRect().height), 'o texto longo quebra em várias linhas').toBeGreaterThan(24 * 3);
      await expect(textBody).not.toHaveAttribute('tabindex');
      // Código: rótulo da linguagem, mono 13/20, rola por dentro, focável, "Quebrar linhas" desligado.
      await expect(codeCard.getByText('ts', { exact: true })).toBeVisible();
      const wrap = codeCard.getByRole('button', { name: 'Quebrar linhas' });
      await expect(wrap).toHaveAttribute('aria-pressed', 'false');
      expect(await codeBody.locator('code').evaluate((element) => { const style = getComputedStyle(element); return [style.fontFamily.startsWith('"JetBrains'), style.fontSize, style.lineHeight]; })).toEqual([true, '13px', '20px']);
      expect(await overflowOf(codeBody), 'o código de 200 colunas rola por dentro').toBeGreaterThan(0);
      await expect(codeBody).toHaveAttribute('tabindex', '0');
      // Código inline segue sem cartão.
      await expect(log(page).locator('.markdown code', { hasText: 'código inline' }).locator('xpath=ancestor::*[@data-code-block]')).toHaveCount(0);
      // O modo só ícone é decidido pelo que cabe no cabeçalho do CARTÃO (não pela janela). Decisão do dono no R1 da review da phase 3, fiel ao
      // design: em 1280 e 375 px os botões mantêm o texto (o rótulo trunca primeiro) e cabem dentro do cartão; só numa tela realmente estreita
      // (320 px) os do cartão de código ficam só com o ícone, com nome acessível, tooltip e área de 40 px. O cartão `text` tem um botão só, que
      // ainda cabe em 320 px, então segue com o texto: a regra é por cartão, pelo que cabe nele.
      const cardBox = (await codeCard.boundingBox())!;
      const copyText = textCard.getByRole('button', { name: 'Copiar' });
      if (width !== 320) {
        await expect(wrap).toHaveText('Quebrar linhas');
        await expect(codeCard.getByRole('button', { name: 'Copiar' })).toHaveText('Copiar');
        await expect(copyText).toHaveText('Copiar');
        expect((await wrap.boundingBox())!.height).toBeGreaterThanOrEqual(32);
        const copyBox = (await codeCard.getByRole('button', { name: 'Copiar' }).boundingBox())!;
        expect(copyBox.x + copyBox.width, 'os botões com texto cabem dentro do cartão').toBeLessThanOrEqual(cardBox.x + cardBox.width);
        expect((await codeCard.getByText('ts', { exact: true }).boundingBox())!.width, 'o rótulo continua visível ao lado dos botões').toBeGreaterThan(0);
      } else {
        const copyCodeIcon = codeCard.getByRole('button', { name: 'Copiar' });
        await expect(wrap).toHaveText('');
        await expect(copyCodeIcon).toHaveText('');
        await expect(wrap).toHaveAttribute('aria-label', 'Quebrar linhas');
        await expect(copyCodeIcon).toHaveAttribute('aria-label', 'Copiar');
        await expect(copyText).toHaveText('Copiar');
        expect((await wrap.boundingBox())!.height).toBeGreaterThanOrEqual(40);
        await wrap.hover();
        await expect(page.getByRole('tooltip', { name: 'Quebrar linhas' })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('tooltip', { name: 'Quebrar linhas' })).toHaveCount(0);
      }
      // Foco visível no corpo rolável: Tab a partir do Copiar do código leva ao corpo.
      await codeCard.getByRole('button', { name: 'Copiar' }).focus();
      await page.keyboard.press('Tab');
      await expect(codeBody).toBeFocused();
      expect(await codeBody.evaluate((element) => element.matches(':focus-visible') && getComputedStyle(element).outlineStyle === 'solid')).toBe(true);
      await expectNoHorizontalScroll(page);
      await expectNoA11yViolations(page);
      await textCard.scrollIntoViewIfNeeded();
      await attachShot(page, testInfo, `blocos-${width}-normal`);

      // Quebrado: o código quebra, deixa de rolar e sai da ordem de foco; tocar de novo volta à rolagem.
      await wrap.click();
      await expect(wrap).toHaveAttribute('aria-pressed', 'true');
      expect(await overflowOf(codeBody), 'quebrado, o código não rola').toBeLessThanOrEqual(0);
      await expect(codeBody).not.toHaveAttribute('tabindex');
      await expectNoHorizontalScroll(page);
      await expectNoA11yViolations(page);
      await codeCard.scrollIntoViewIfNeeded();
      await attachShot(page, testInfo, `blocos-${width}-quebrado`);

      // Copiado: a área de transferência recebe o conteúdo exato (a quebra visual não entra), o botão mostra "Copiado" e há o anúncio.
      const copyCode = codeCard.getByRole('button', { name: 'Copiar' });
      await copyCode.click();
      await expect(codeCard.getByRole('button', { name: 'Copiado' })).toBeVisible();
      await expect(codeCard.getByRole('status')).toHaveText('Conteúdo copiado');
      expect(await clipboard()).toBe(FAKE_BLOCK_CODE);
      await expectNoA11yViolations(page);
      await attachShot(page, testInfo, `blocos-${width}-copiado`);
      await expect(codeCard.getByRole('button', { name: 'Copiar' }), '"Copiado" volta a "Copiar" em 2 s').toBeVisible({ timeout: 3_000 });
      await expect(codeCard.getByRole('status')).toHaveText('');
      await wrap.click();
      await expect(wrap).toHaveAttribute('aria-pressed', 'false');
      expect(await overflowOf(codeBody)).toBeGreaterThan(0);
      await textCard.getByRole('button', { name: 'Copiar' }).click();
      await expect(textCard.getByRole('button', { name: 'Copiado' })).toBeVisible();
      expect(await clipboard()).toBe(FAKE_BLOCK_TEXT);
    }

    // Falha: a cópia negada mostra o toast de erro, que fica até ser fechado (mais que os 4 s dos toasts comuns).
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => {
      navigator.clipboard.writeText = () => Promise.reject(new DOMException('negado', 'NotAllowedError'));
    });
    await textCard.getByRole('button', { name: 'Copiar' }).click();
    const failure = page.getByText('Não foi possível copiar. Selecione o texto e copie manualmente.', { exact: true });
    await expect(failure).toBeVisible();
    await expect(textCard.getByRole('button', { name: 'Copiar' })).toBeVisible();
    await page.waitForTimeout(5_000);
    await expect(failure, 'o toast de erro não some sozinho').toBeVisible();
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'blocos-1280-falha');
    expect(problems).toEqual([]);
  });

  test('a pílula "Novas mensagens" aparece quando chega algo com a leitura mais acima, e não puxa a tela', async ({ page }, testInfo) => {
    const problems = watchPage(page);
    const botId = await createBot(page, 'Longa');
    // Texto longo o bastante para a conversa passar da altura da tela (sem rolagem não há "leitura mais acima").
    for (let round = 1; round <= 8; round += 1) await sendViaApi(page, botId, `rodada ${round}: ${'um assunto com texto de enchimento para ocupar espaço. '.repeat(4)}`);
    await page.goto(`/bots/${botId}`);
    await expect(log(page).getByText('Resposta: rodada 8')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Novas mensagens' })).toHaveCount(0);

    // Leitura mais acima: nada de pílula por conta do que já estava lá, e uma mensagem nova (de "outra aba") acende a pílula.
    await log(page).evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(log(page).getByText('rodada 1:', { exact: false }).first()).toBeInViewport();
    await sendViaApi(page, botId, 'chegou enquanto eu lia');
    const pill = page.getByRole('button', { name: 'Novas mensagens' });
    await expect(pill).toBeVisible();
    expect(await log(page).evaluate((element) => element.scrollTop)).toBeLessThan(40); // a tela não foi puxada
    await attachShot(page, testInfo, 'conversa-1440-pilula');
    await pill.click();
    await expect(pill).toHaveCount(0);
    await expect(log(page).getByText('Resposta: chegou enquanto eu lia')).toBeInViewport();
    expect(problems).toEqual([]);
  });

  test('o bot abre nas 10 últimas rodadas, carrega as anteriores ao chegar ao topo sem pular a leitura e termina em "Início da conversa"', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const problems = watchPage(page);
    const bot = await ensureLongBot(page);
    await page.goto(`/bots/${bot.id}`);
    await expectRoundsFlow(page, testInfo, 'historico-1440-bot');
    expect(problems).toEqual([]);
  });

  test('o botão "Carregar mensagens anteriores" funciona pelo teclado, e uma falha mostra o aviso no topo sem perder o que está na tela e sem insistir sozinha até "Tentar novamente"', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const problems = watchPage(page);
    const bot = await ensureLongBot(page);
    await page.goto(`/bots/${bot.id}`);
    await expect(log(page).getByText(`Resposta: rodada ${SEEDED_ROUNDS}`)).toBeVisible();

    // Teclado: longe da zona de carga automática (a mais de 200 px do topo) o botão carrega com Enter, e o foco vai para a lista, que rola com as setas.
    await scrollLogTo(page, 400);
    await page.getByRole('button', { name: LOAD_OLDER_BUTTON }).evaluate((element) => (element as HTMLElement).focus({ preventScroll: true }));
    await page.keyboard.press('Enter');
    await expect(roundBubble(page, 7)).toBeAttached();
    await expect(loadedRounds(page)).toHaveCount(20);
    await expect(log(page)).toBeFocused();

    // Falha: a rede cai e o aviso aparece no topo; as 20 rodadas continuam na tela e só um pedido saiu (a rolagem não insiste).
    let attempts = 0;
    await page.route(MESSAGES_PAGE, async (route) => {
      attempts += 1;
      await route.abort('failed');
    });
    await scrollLogTo(page, 0);
    const failed = log(page).getByText(LOAD_FAILED_TEXT);
    await expect(failed).toBeVisible();
    await expect(failed).toBeInViewport();
    const retry = page.getByRole('button', { name: 'Tentar novamente' });
    await expect(retry).toBeVisible();
    await expect(loadedRounds(page)).toHaveCount(20);
    await scrollLogTo(page, 60);
    await scrollLogTo(page, 0);
    await page.waitForTimeout(600);
    expect(attempts).toBe(1);
    await attachShot(page, testInfo, 'historico-1440-erro');
    await expectNoA11yViolations(page);

    // Tentar novamente: com a rede de volta, a página que faltava entra e o aviso some.
    await page.unroute(MESSAGES_PAGE);
    await retry.click();
    await expect(roundBubble(page, 1)).toBeAttached();
    await expect(loadedRounds(page)).toHaveCount(SEEDED_ROUNDS);
    await expect(failed).toHaveCount(0);
    await expect(log(page).getByText('Início da conversa')).toBeAttached();
    // Só o pedido que falhou deixou erro de rede; nada de erro de console nem de resposta HTTP.
    expect(problems).toEqual([]);
  });

  test('o link "ver na conversa" para uma mensagem a mais de 10 rodadas carrega as páginas até ela, rola e a destaca; um id que não existe avisa', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const problems = watchPage(page);
    const bot = await ensureLongBot(page);

    // Aberto já apontando para a rodada 1 (como o link de Atividades e o do histórico de rotinas): as 3 páginas são carregadas até ela.
    await page.goto(`/bots/${bot.id}?mensagem=${bot.firstMessageId}`);
    const origin = roundBubble(page, 1);
    await expect(origin).toBeInViewport();
    await expect(origin).toHaveCSS('outline-width', '2px'); // o destaque da mensagem de origem
    await expect(loadedRounds(page)).toHaveCount(SEEDED_ROUNDS);
    await attachShot(page, testInfo, 'historico-1440-ver-na-conversa');
    await expect(origin).not.toHaveCSS('outline-width', '2px'); // o destaque some sozinho em 2 s

    // Um id que não existe (ids do banco começam em 1) e é mais antigo que tudo: carrega até o começo e avisa, sem travar a tela.
    await page.goto(`/bots/${bot.id}?mensagem=0`);
    await expect(page.getByText('Mensagem não encontrada')).toBeVisible();
    await expect(loadedRounds(page)).toHaveCount(SEEDED_ROUNDS);
    await expect(composer(page)).toBeEnabled();

    // O link do trecho da busca no histórico (a rodada 1 está a 26 rodadas do fim): rola até a mensagem de origem e a destaca.
    await page.goto(`/bots/${bot.id}`);
    await expect(log(page).getByText(`Resposta: rodada ${SEEDED_ROUNDS}`)).toBeVisible();
    await expect(roundBubble(page, 1)).toHaveCount(0);
    await send(page, '[pesquisar:contratos Acme] o que combinamos?');
    const search = log(page).getByRole('button', { name: 'Pesquisou no histórico: contratos Acme' });
    await openWorkLine(log(page), search);
    await expect(search).toBeVisible();
    await search.click();
    const hit = log(page)
      .locator('li')
      .filter({ has: page.getByRole('button', { name: 'ver na conversa' }) })
      .filter({ hasText: 'contrato de 12 meses' })
      .filter({ hasNotText: 'Resposta:' });
    await expect(hit).toBeVisible();
    await hit.getByRole('button', { name: 'ver na conversa' }).click();
    await expect(roundBubble(page, 1)).toBeInViewport();
    await expect(roundBubble(page, 1)).toHaveCSS('outline-width', '2px');
    expect(problems).toEqual([]);
  });

  test('a coluna de mensagens esmaece nas bordas em vez de ser cortada rente ao campo de escrita, sem invadi-lo, e o foco do teclado segue visível', async ({ page }, testInfo) => {
    const problems = watchPage(page);
    const botId = await createBot(page, 'Borda');
    // Respostas com lista (o formato do print do dono): o texto cortado rente ao composer parecia passar por baixo dele.
    const list = ['Aqui vai o resumo:', '', '- Busca por texto nas mensagens antigas da gente', '- Anotar coisas na minha memória', '- Criar e mudar rotinas', '', 'E se quiser mais detalhes é só pedir! '.repeat(6)].join('\n');
    for (let round = 1; round <= 8; round += 1) await sendViaApi(page, botId, `rodada ${round}\n\n${list}`);
    await page.goto(`/bots/${botId}`);
    await expect(log(page).getByText('Resposta: rodada 8')).toBeVisible();

    // A coluna termina onde o composer começa (nenhuma sobreposição) e a página não rola por fora dela.
    const geometry = await page.evaluate(() => {
      const column = (document.querySelector('[role="log"]') as HTMLElement).getBoundingClientRect();
      const composerTop = (document.querySelector('form.composer') as HTMLElement).getBoundingClientRect().top;
      return { overlap: column.bottom - composerTop, pageScrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight };
    });
    expect(geometry.overlap).toBeLessThanOrEqual(0);
    expect(geometry.pageScrolls).toBe(false);
    // O esmaecimento está aplicado na coluna que rola.
    expect(await log(page).evaluate((element) => getComputedStyle(element).maskImage)).toContain('linear-gradient');

    await log(page).evaluate((element) => {
      element.scrollTop = Math.floor(element.scrollHeight / 2);
    });
    await attachShot(page, testInfo, 'conversa-1440-borda-esmaecida');

    // O anel de foco da coluna (focável por teclado) é desenhado no contêiner, que não é mascarado: segue visível em volta de tudo.
    await log(page).focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(log(page)).toBeFocused();
    const ring = await log(page).evaluate((element) => {
      const own = getComputedStyle(element);
      const pane = getComputedStyle(element.parentElement as HTMLElement);
      return { own: own.outlineStyle, pane: pane.outlineStyle, paneWidth: pane.outlineWidth };
    });
    expect(ring).toEqual({ own: 'none', pane: 'solid', paneWidth: '2px' });
    expect(problems).toEqual([]);
  });

  test('o bot pesquisa e lê páginas na web: a atividade mostra as URLs completas, só http e https viram link seguro e o link abre em nova aba sem opener', async ({ page }, testInfo) => {
    const problems = watchPage(page);
    await stubExternalPages(page);
    await ensureCredential(page, 'provider', PROVIDER_KEY);
    const botId = await createBot(page, 'Pesquisador');
    await page.goto(`/bots/${botId}`);
    await runWebActivities(page);
    await expectWebActivities(page);
    await attachShot(page, testInfo, 'web-1440-bot-atividades');
    await expectNoA11yViolations(page);

    // O link abre em OUTRA aba e a página aberta não alcança a nossa (sem `opener`).
    const link = resultsList(page).getByRole('link', { name: /Resultado número 3 da pesquisa/ });
    const [popup] = await Promise.all([page.context().waitForEvent('page'), link.click()]);
    await popup.waitForLoadState();
    expect(popup.url()).toBe(LONG_URL);
    expect(await popup.evaluate(() => window.opener)).toBeNull();
    await popup.close();
    await expect(page).toHaveURL(new RegExp(`/bots/${botId}$`)); // a conversa continua onde estava
    expect(problems).toEqual([]);
  });

  test('o Chat geral também pesquisa e lê páginas, com a mesma atividade', async ({ page }, testInfo) => {
    const problems = watchPage(page);
    await stubExternalPages(page);
    await ensureCredential(page, 'provider', PROVIDER_KEY);
    const headers = await apiHeaders(page);
    const created = await page.context().request.post(`${ORIGIN}/api/chat/sessions`, { headers });
    expect(created.status(), 'criar a sessão').toBe(201);
    const sessionId = ((await created.json()) as { id: string }).id;
    const preference = await page.context().request.patch(`${ORIGIN}/api/chat/sessions/${sessionId}/conversation`, { headers, data: { model: 'opencode/glm-5.1', effort: null } });
    expect(preference.status(), 'escolher o modelo').toBe(200);
    await page.goto(`/chat/${sessionId}`);
    await runWebActivities(page);
    await expectWebActivities(page);
    await attachShot(page, testInfo, 'web-1440-chat-geral-atividades');
    await expectNoA11yViolations(page);
    expect(problems).toEqual([]);
  });

  test('o servidor descarta resultado com esquema que não é http ou https, e a tela nunca cria link para ele mesmo que ele chegue: aparece só como texto', async ({ page }, testInfo) => {
    const problems = watchPage(page);
    await stubExternalPages(page);
    await ensureCredential(page, 'provider', PROVIDER_KEY);
    const botId = await createBot(page, 'Esquemas');
    await page.goto(`/bots/${botId}`);
    await send(page, '[web-pesquisar:esquema]');
    const row = log(page).getByRole('button', { name: /^Pesquisou na web: Pesquisar: esquema/ });
    await openWorkLine(log(page), row);
    await expect(row).toBeVisible();
    await row.click();
    // O Aion só entrega à tela os dois resultados http e https; ftp:, javascript: e a URL com usuário e senha ficaram no servidor.
    await expect(resultsList(page).getByRole('listitem')).toHaveCount(2);
    await expect(log(page).getByText(/ftp:|javascript:|senha/)).toHaveCount(0);

    // Defesa da tela: mesmo que um esquema perigoso chegasse na resposta da API, ele aparece como texto, nunca como link.
    await page.route(/\/api\/bots\/[^/]+\/conversation$/, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { items: { detail?: { type: string; results: { title: string; url: string }[] } }[] };
      for (const item of body.items) {
        if (item.detail?.type === 'web_search') {
          item.detail.results.push({ title: 'Script', url: 'javascript:alert(1)' }, { title: 'Arquivo', url: 'ftp://arquivos.exemplo.com/a.txt' }, { title: 'Credenciais', url: 'https://dono:senha@exemplo.com/privado' });
        }
      }
      await route.fulfill({ response, json: body });
    });
    await page.reload();
    await openWorkLine(log(page), log(page).getByRole('button', { name: /^Pesquisou na web: Pesquisar: esquema/ }));
    await expect(log(page).getByRole('button', { name: /^Pesquisou na web: Pesquisar: esquema/ })).toBeVisible();
    await log(page).getByRole('button', { name: /^Pesquisou na web: Pesquisar: esquema/ }).click();
    const results = resultsList(page);
    await expect(results.getByRole('listitem')).toHaveCount(5);
    await expect(results.getByRole('link')).toHaveCount(2); // só os dois http e https
    for (const text of ['javascript:alert(1)', 'ftp://arquivos.exemplo.com/a.txt', 'https://dono:senha@exemplo.com/privado']) {
      await expect(results.getByText(text, { exact: true })).toBeVisible();
    }
    await expect(results.getByRole('link', { name: /Script|Arquivo|Credenciais/ })).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    await attachShot(page, testInfo, 'web-1440-esquemas-so-texto');
    await expectNoA11yViolations(page);
    expect(problems).toEqual([]);
  });

  test('effort independente persiste em bot e Chat geral, reverte na recusa e mantém modelo e teclado em 1440 e 375 px', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await ensureCredential(page, 'provider', PROVIDER_KEY);
    const headers = await apiHeaders(page);
    const request = page.context().request;
    const botId = await createBot(page, 'Effort próprio');
    const created = await request.post(`${ORIGIN}/api/chat/sessions`, { headers });
    expect(created.status()).toBe(201);
    const sessionId = ((await created.json()) as { id: string }).id;

    for (const [kind, id, apiPath] of [['bots', botId, `/api/bots/${botId}`], ['chat', sessionId, `/api/chat/sessions/${sessionId}`]]) {
      for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: width === 1440 ? 900 : 812 });
        expect((await request.patch(`${ORIGIN}${apiPath}/conversation`, { headers, data: { model: 'opencode/glm-5.1', effort: null } })).status()).toBe(200);
        await page.goto(`/${kind}/${id}`);
        const button = page.getByRole('button', { name: 'Effort: Padrão', exact: true });
        await expect(button).toBeVisible();
        await expectNoA11yViolations(page);
        await attachShot(page, testInfo, `effort-${kind}-${width}-padrao`);
        await button.focus();
        await page.keyboard.press('Enter');
        const popover = page.getByRole('dialog', { name: 'Effort', exact: true });
        const slider = popover.getByRole('slider', { name: 'Effort', exact: true });
        await expect(slider).toBeFocused();
        await page.keyboard.press('End');
        await expect(slider).toHaveAttribute('aria-valuetext', 'Alto');
        await expect.poll(async () => ((await (await request.get(`${ORIGIN}${apiPath}/conversation`, { headers })).json()) as { model: { effort: string } }).model.effort).toBe('high');
        await expectNoHorizontalScroll(page);
        await expectNoA11yViolations(page);
        await attachShot(page, testInfo, `effort-${kind}-${width}-popover`);
        await page.keyboard.press('Escape');
        await expect(page.getByRole('button', { name: 'Effort: Alto' })).toBeFocused();
        await page.reload();
        await expect(page.getByRole('button', { name: 'Effort: Alto' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'opencode/glm-5.1', exact: true })).toBeVisible();

        if (kind === 'bots' && width === 1440) {
          // A primeira gravação demora: gestos posteriores precisam vencer no banco mesmo com respostas de duração diferente.
          let firstFinished!: () => void;
          const firstDone = new Promise<void>((resolve) => { firstFinished = resolve; });
          await page.route(`**${apiPath}/conversation`, async (route) => {
            if (route.request().method() !== 'PATCH') return route.continue();
            const effort = (route.request().postDataJSON() as { effort: string | null }).effort;
            if (effort === null) await new Promise((resolve) => setTimeout(resolve, 400));
            const response = await route.fetch();
            await route.fulfill({ response });
            if (effort === null) firstFinished();
          });
          await page.getByRole('button', { name: 'Effort: Alto' }).click();
          await slider.press('Home');
          await slider.press('ArrowRight');
          await slider.press('End');
          await firstDone;
          await expect.poll(async () => ((await (await request.get(`${ORIGIN}${apiPath}/conversation`, { headers })).json()) as { model: { effort: string } }).model.effort).toBe('high');
          await page.keyboard.press('Escape');
          await page.reload();
          await expect(page.getByRole('button', { name: 'Effort: Alto' })).toBeVisible();
          await page.unroute(`**${apiPath}/conversation`);
        }

        // Falha de transporte mantém a última preferência persistida e anuncia a recusa em toast.
        await page.route(`**${apiPath}/conversation`, (route) => route.request().method() === 'PATCH' ? route.abort('failed') : route.continue());
        await page.getByRole('button', { name: 'Effort: Alto' }).click();
        await slider.press('Home');
        await expect(page.getByText('Sem conexão com o servidor. Tente novamente.', { exact: true })).toBeVisible();
        await expect(slider).toHaveAttribute('aria-valuetext', 'Alto');
        await page.keyboard.press('Escape');
        await page.unroute(`**${apiPath}/conversation`);
      }
    }
    // Sem níveis o botão desaparece; a mesma rota conserva o modelo selecionado.
    expect((await request.patch(`${ORIGIN}/api/bots/${botId}/conversation`, { headers, data: { model: 'opencode/glm-5.3-flash', effort: null } })).status()).toBe(200);
    await page.goto(`/bots/${botId}`);
    await expect(page.getByRole('button', { name: 'opencode/glm-5.3-flash', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Effort:/ })).toHaveCount(0);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'effort-bots-375-sem-niveis');
    // Fixture só da apresentação: o catálogo real pode ter ids longos; a persistência foi provada acima com os modelos do fake.
    const longModel = 'provedor/modelo-com-um-nome-muito-longo-para-a-largura-do-composer';
    await page.route(`**/api/bots/${botId}/conversation`, async (route) => {
      const response = await route.fetch();
      const snapshot = await response.json() as Record<string, unknown>;
      await route.fulfill({ response, json: { ...snapshot, model: { model: longModel, effort: 'xhigh', effortLevels: ['low', 'medium', 'high', 'xhigh'] } } });
    });
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 812 });
      await page.reload();
      await expect(page.getByRole('button', { name: 'Effort: Extra alto' })).toBeVisible();
      const model = page.getByRole('button', { name: longModel, exact: true }).locator('span');
      await expect(model).toHaveCSS('text-overflow', 'ellipsis');
      expect(await model.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
      await expectNoHorizontalScroll(page);
      await expectNoA11yViolations(page);
      await attachShot(page, testInfo, `effort-bots-${width}-extra-alto-modelo-longo`);
      await page.getByRole('button', { name: 'Effort: Extra alto' }).click();
      await expect(page.getByRole('dialog', { name: 'Effort', exact: true }).getByRole('slider')).toHaveAttribute('aria-valuetext', 'Extra alto');
      await expectNoHorizontalScroll(page);
      await expectNoA11yViolations(page);
      await attachShot(page, testInfo, `effort-bots-${width}-extra-alto-popover`);
      await page.keyboard.press('Escape');
    }
    await page.unroute(`**/api/bots/${botId}/conversation`);
  });

  test('trocar o modelo no composer vale para a conversa e não altera o padrão do bot; sem modelo o envio é recusado', async ({ page }) => {
    const problems = watchPage(page);
    const botId = await createBot(page, 'Preferência');
    await page.goto(`/bots/${botId}`);
    await expect(page.getByRole('button', { name: 'opencode/glm-5.1', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'opencode/glm-5.1', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Selecionar modelo' });
    await expect(picker).toBeVisible();
    await picker.getByRole('list', { name: 'Modelos do OpenCode Go' }).getByRole('button', { name: /^glm-5\.3-flash( |$)/ }).click();
    await expect(picker.getByRole('list', { name: 'Modelos do OpenCode Go' }).getByRole('button', { name: /^glm-5\.3-flash/ })).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'opencode/glm-5.3-flash', exact: true })).toBeVisible();

    // A preferência sobrevive ao recarregar (está na conversa, no servidor) e o padrão do bot segue o mesmo no editor.
    await page.reload();
    await expect(page.getByRole('button', { name: 'opencode/glm-5.3-flash', exact: true })).toBeVisible();
    await page.goto(`/bots/${botId}/editar`);
    await expect(page.getByRole('button', { name: /^Modelo padrão/ })).toHaveAccessibleName('Modelo padrão opencode/glm-5.1');

    // Sem modelo padrão e sem favorito: o envio é recusado com a orientação, e o texto digitado fica.
    const headers = await apiHeaders(page);
    const listed = (await (await page.context().request.get(`${ORIGIN}/api/models`, { headers })).json()) as { models: { id: string; favorite: boolean }[] };
    for (const model of listed.models.filter((entry) => entry.favorite)) {
      const unfavorited = await page.context().request.patch(`${ORIGIN}/api/models/favorite`, { headers, data: { model: model.id, favorite: false } });
      expect(unfavorited.status()).toBe(200);
    }
    const bare = await createBot(page, 'Sem modelo', { model: null });
    await page.goto(`/bots/${bare}`);
    await expect(page.getByRole('button', { name: 'Escolher modelo' })).toBeVisible();
    await send(page, 'oi, sem modelo');
    await expect(page.getByRole('alert').filter({ hasText: 'Modelo indisponível. Escolha outro modelo.' })).toBeVisible();
    await expect(composer(page)).toHaveValue('oi, sem modelo');
    await expect(log(page).getByText('oi, sem modelo')).toHaveCount(0);
    expect(problems.filter((problem) => !problem.startsWith('422 POST /api/bots/'))).toEqual([]);
  });

  /** O centro do primeiro olho (a pupila) da Faísca, em px da janela: onde o olhar da Faísca é medido. */
  const pupilCenter = (faisca: Locator) =>
    faisca.evaluate((svg) => {
      const box = svg.querySelector('[data-part="eyes"] [data-part="pupil"]')!.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
  /** A pupila depois de a transição do olhar (220 ms) terminar: lê de novo até duas leituras seguidas coincidirem. */
  async function settledPupil(page: Page, faisca: Locator) {
    let last = await pupilCenter(faisca);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await page.waitForTimeout(100);
      const next = await pupilCenter(faisca);
      if (Math.hypot(next.x - last.x, next.y - last.y) < 0.01) return next;
      last = next;
    }
    throw new Error('a pupila não parou de se mover');
  }

  test('o olhar da Faísca da conversa vazia segue o cursor em até 4 px, fica à frente e parado sem cursor e não segue com movimento reduzido nem em toque', async ({ page, browser }, testInfo) => {
    const problems = watchPage(page);
    await ensureCredential(page, 'provider', PROVIDER_KEY);
    const botId = await createBot(page, 'Olhar', { color: '#F472B6' });
    await page.goto(`/bots/${botId}`);
    const faisca = threadFaiscas(page);
    await expect(faisca).toHaveCount(1);
    expect(await faiscaLook(faisca)).toMatchObject({ state: 'idle', size: [112, 112], body: '#F472B6' });

    // Sem cursor (o ponteiro ainda não se mexeu): nada de olhar fixo, e a Faísca ociosa fica à frente e parada (só trabalhando e aguardando se mexem), depois da entrada.
    await expect(faisca).not.toHaveAttribute('data-look', '');
    await expect.poll(() => runningAnimations(faisca)).toBe(0);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'conversa-1440-vazia-faisca');

    // O cursor no centro da Faísca liga o olhar (vetor zero): a pupila fica na posição de repouso. A entrada (400 ms) já acabou (nenhuma animação rodando), então as
    // medidas seguintes enxergam apenas o olhar.
    const box = (await faisca.boundingBox())!;
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.move(center.x, center.y);
    await expect(faisca).toHaveAttribute('data-look', '');
    const rest = await settledPupil(page, faisca);

    // Cursor longe (além do alcance de 160 px, e dentro da janela: o navegador não entrega o movimento de fora dela) em cada direção: a pupila vai para o lado do
    // cursor e nunca mais de 4 px do repouso.
    const shifts: Record<string, { dx: number; dy: number }> = {};
    for (const [name, dx, dy] of [
      ['direita', 400, 0],
      ['esquerda', -400, 0],
      ['abaixo', 0, 300],
      ['acima', 0, -300],
      ['diagonal', 300, 300],
    ] as const) {
      await page.mouse.move(center.x + dx, center.y + dy);
      const pupil = await settledPupil(page, faisca);
      shifts[name] = { dx: pupil.x - rest.x, dy: pupil.y - rest.y };
      expect(Math.hypot(shifts[name]!.dx, shifts[name]!.dy), `deslocamento da pupila (${name})`).toBeLessThanOrEqual(4);
    }
    testInfo.annotations.push({ type: 'olhar', description: `deslocamento da pupila em px por direção: ${JSON.stringify(shifts)}` });
    expect(shifts.direita!.dx, 'olha para a direita').toBeGreaterThan(3);
    expect(shifts.esquerda!.dx, 'olha para a esquerda').toBeLessThan(-3);
    expect(shifts.abaixo!.dy, 'olha para baixo').toBeGreaterThan(2);
    expect(shifts.acima!.dy, 'olha para cima').toBeLessThan(-2);
    expect(shifts.diagonal!.dx).toBeGreaterThan(1.5);
    expect(shifts.diagonal!.dy).toBeGreaterThan(1.5);
    // Perto da Faísca o olhar é proporcional à distância (80 px é metade do alcance): menos que o extremo, mais que o repouso.
    await page.mouse.move(center.x + 80, center.y);
    const near = await settledPupil(page, faisca);
    expect(near.x - rest.x).toBeGreaterThan(1);
    expect(near.x - rest.x).toBeLessThan(shifts.direita!.dx - 0.5);
    await page.mouse.move(center.x + 400, center.y);
    await settledPupil(page, faisca);
    await attachShot(page, testInfo, 'conversa-1440-vazia-olhar-direita');
    await page.mouse.move(center.x - 400, center.y);
    await settledPupil(page, faisca);
    await attachShot(page, testInfo, 'conversa-1440-vazia-olhar-esquerda');

    // Movimento reduzido: o olhar solta o cursor na hora (com a tela aberta), a pose é estática e nenhuma animação roda; ao voltar, o olhar volta.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(faisca).not.toHaveAttribute('data-look', '');
    await expect.poll(() => runningAnimations(faisca)).toBe(0);
    const still = await settledPupil(page, faisca);
    await page.mouse.move(center.x + 400, center.y + 100);
    await page.mouse.move(center.x - 300, center.y - 150);
    await page.waitForTimeout(400);
    await expect(faisca).not.toHaveAttribute('data-look', '');
    const afterMoves = await settledPupil(page, faisca);
    expect(Math.hypot(afterMoves.x - still.x, afterMoves.y - still.y), 'a pupila não segue o cursor com movimento reduzido').toBeLessThan(0.05);
    await attachShot(page, testInfo, 'conversa-1440-vazia-movimento-reduzido');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    // O navegador avisa a mudança da preferência no próximo quadro de renderização: o cursor continua se mexendo (como o de quem usa a tela), até o olhar voltar.
    let wiggle = 0;
    await expect(async () => {
      wiggle += 1;
      await page.mouse.move(center.x + 300 + 10 * wiggle, center.y);
      await expect(faisca).toHaveAttribute('data-look', '', { timeout: 500 });
    }).toPass({ timeout: 10_000 });

    // Em toque (sem ponteiro preciso, o celular): nada de olhar fixo, mesmo que cheguem movimentos, e a Faísca fica à frente e parada. Contexto próprio com toque.
    const touch = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 812 }, extraHTTPHeaders: { [CLIENT_IP_HEADER]: clientIpFor(`${testInfo.testId}:toque`) } });
    try {
      await apiLogin(touch);
      const phone = await touch.newPage();
      await phone.goto(`/bots/${botId}`);
      const phoneFaisca = threadFaiscas(phone);
      await expect(phoneFaisca).toHaveCount(1);
      expect(await phone.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches), 'o celular não tem ponteiro preciso').toBe(false);
      expect(await faiscaLook(phoneFaisca)).toMatchObject({ state: 'idle', size: [96, 96] });
      const phoneBox = (await phoneFaisca.boundingBox())!;
      await phone.touchscreen.tap(phoneBox.x + phoneBox.width / 2, phoneBox.y - 40);
      await phone.mouse.move(phoneBox.x + 150, phoneBox.y + 150);
      await phone.waitForTimeout(400);
      await expect(phoneFaisca).not.toHaveAttribute('data-look', '');
      await expect.poll(() => runningAnimations(phoneFaisca)).toBe(0);
    } finally {
      await touch.close();
    }
    expect(problems).toEqual([]);
  });

  test('o composer em pílula tem anexar à esquerda e os demais controles à direita, na mesma linha, em 1440 e em 390 px, sem controle sumido nem sobreposto (A18)', async ({ page }, testInfo) => {
    const problems = watchPage(page);
    await ensureCredential(page, 'provider', PROVIDER_KEY);
    const botId = await createBot(page, 'Pílula');
    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await page.goto(`/bots/${botId}`);
      const form = page.locator('form.composer');
      await expect(form).toBeVisible();
      // Os controles da linha, na ordem do design: anexar, modelo, effort (se o modelo tem), contexto, ditado (se o navegador tem) e enviar.
      const names = [/^Anexar arquivo$/, /^opencode\//, /^Effort:/, /^Contexto:/, /^(Ditar|Parar ditado)$/, /^Enviar mensagem$/];
      const boxes: { name: string; x: number; width: number; y: number; height: number }[] = [];
      for (const name of names) {
        const control = form.getByRole('button', { name });
        if ((await control.count()) === 0) continue;
        const box = (await control.first().boundingBox())!;
        expect(box, `controle ${name} visível`).not.toBeNull();
        boxes.push({ name: String(name), ...box });
      }
      expect(boxes.map((box) => box.name)[0], 'anexar é o primeiro').toBe(String(names[0]));
      expect(boxes.some((box) => box.name === String(names[1])), 'o modelo está na linha').toBe(true);
      expect(boxes.some((box) => box.name === String(names[5])), 'enviar está na linha').toBe(true);
      const formBox = (await form.boundingBox())!;
      const middle = (box: { y: number; height: number }) => box.y + box.height / 2;
      for (const [index, box] of boxes.entries()) {
        expect(box.x, `${box.name} dentro do campo (esquerda)`).toBeGreaterThanOrEqual(formBox.x);
        expect(box.x + box.width, `${box.name} dentro do campo (direita)`).toBeLessThanOrEqual(formBox.x + formBox.width + 0.5);
        expect(Math.abs(middle(box) - middle(boxes[0]!)), `${box.name} na mesma linha do anexar`).toBeLessThan(box.height);
        const next = boxes[index + 1];
        if (next) expect(box.x + box.width, `${box.name} não se sobrepõe a ${next.name}`).toBeLessThanOrEqual(next.x + 0.5);
      }
      await expectNoHorizontalScroll(page);
      await expectNoA11yViolations(page);
      await attachShot(page, testInfo, `composer-pilula-${width}`);
    }
    expect(problems).toEqual([]);
  });

  test('sem provedor o composer fica desabilitado e a faixa leva a Conexões', async ({ page }, testInfo) => {
    const problems = watchPage(page);
    const botId = await createBot(page, 'Sem provedor');
    await setProvider(page, null);
    await page.goto(`/bots/${botId}`);
    await expect(page.getByText('Configure um provedor para conversar.')).toBeVisible();
    await expect(composer(page)).toBeDisabled();
    await expect(page.getByRole('link', { name: 'Abrir Conexões' })).toHaveAttribute('href', '/configuracoes/conexoes');
    await attachShot(page, testInfo, 'conversa-1440-sem-provedor');
    await expectNoA11yViolations(page);
    await ensureCredential(page, 'provider', PROVIDER_KEY);
    expect(problems).toEqual([]);
  });
});

test.describe('conversa em 375 × 812', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('o composer fica embaixo, código e links longos não alargam a página e tudo passa no axe', async ({ page }, testInfo) => {
    const problems = watchPage(page);
    await ensureCredential(page, 'provider', PROVIDER_KEY);
    const botId = await createBot(page, 'Celular com um nome bem comprido para truncar');
    await page.goto(`/bots/${botId}`);
    await expect(composer(page)).toBeVisible();
    // Em 375 px a Faísca da conversa vazia cai para 96 px (o mesmo nível de detalhe completo) e nada rola na horizontal.
    await expect(threadFaiscas(page)).toHaveCount(1);
    expect(await faiscaLook(threadFaiscas(page))).toMatchObject({ state: 'idle', detail: 'full', size: [96, 96], decorative: true });
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'conversa-375-vazia');

    const longLine = 'https://exemplo.com/um/caminho/muito/longo/que/nao/tem/onde/quebrar/'.repeat(3);
    await send(page, `Olá, o trecho:\n\`\`\`\nconst linhaDeCodigoMuitoLonga = ${longLine};\n\`\`\`\n${longLine}`);
    await expect(log(page).locator('.markdown').filter({ hasText: 'Resposta:' })).toBeVisible();
    await send(page, '[pesquisar:a|b|c] três ações');
    await expect(page.getByRole('button', { name: /^Trabalhou por .* · 3 ações/ })).toBeVisible();
    await page.getByRole('button', { name: /^Trabalhou por .* · 3 ações/ }).click();
    await expectNoHorizontalScroll(page);

    // O composer está dentro da tela (fixo embaixo) e o seletor de modelo mostra o nome truncado.
    const box = await composer(page).boundingBox();
    expect(box && box.y + box.height).toBeLessThanOrEqual(812);
    const trigger = page.getByRole('button', { name: 'opencode/glm-5.1', exact: true });
    expect((await trigger.boundingBox())?.width).toBeLessThanOrEqual(327); // modelo flexível ocupa o espaço que os controles deixam
    await attachShot(page, testInfo, 'conversa-375-mensagens');
    await expectNoA11yViolations(page);

    // O seletor de modelo vira drawer inferior (T5) também a partir do composer.
    await trigger.click();
    await expect(page.getByRole('dialog', { name: 'Selecionar modelo' })).toBeVisible();
    await attachShot(page, testInfo, 'conversa-375-seletor');
    await page.keyboard.press('Escape');

    // Falha e limite também cabem na tela estreita.
    await send(page, '[falha] provedor fora do ar');
    const failure = page.getByRole('region', { name: 'A execução falhou' });
    await expect(failure).toBeVisible();
    await expectNoHorizontalScroll(page);
    // A falha mostra a Faísca em erro; em 375 px ela continua à esquerda do texto e as ações descem para uma linha abaixo do corpo.
    await expectCardFaisca(failure, 'error', 'O provedor falhou ao responder. Tente novamente.');
    await expectActionsBelowBody(failure, 'O provedor falhou ao responder. Tente novamente.', 'Tentar novamente');
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'conversa-375-falha');
    expect(problems).toEqual([]);
  });

  test('a linha da Faísca "Trabalhando…" e o cartão de limite cabem em 375 px, sem rolagem horizontal e sem violação de acessibilidade', async ({ page }, testInfo) => {
    const problems = watchPage(page);
    await ensureCredential(page, 'provider', PROVIDER_KEY);
    const working = await createBot(page, 'Celular trabalhando');
    await page.goto(`/bots/${working}`);
    await send(page, LONG_HISTORY_MESSAGE);
    await expect(log(page).locator('.markdown').filter({ hasText: 'Resposta:' })).toBeVisible();
    await send(page, '[demorar] trabalhando sem fim');
    await expect(workingLine(page).getByText('Trabalhando…')).toBeVisible();
    await expect(workingLine(page).locator('svg.faisca')).toHaveCount(1);
    // A6 em 375 px: histórico rolado até o topo, a linha segue na viewport acima do composer.
    await expectWorkingLineAtTop(page, log(page), workingLine(page));
    expect(await faiscaLook(workingLine(page).locator('svg.faisca'))).toMatchObject({ state: 'working', detail: 'small', still: false, decorative: true, size: [24, 24] });
    await expect(workingLine(page).locator('[data-icon="LoaderCircle"]')).toHaveCount(0);
    expect((await workingLine(page).boundingBox())!.height, 'linha fixa de 36 px').toBe(36);
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'conversa-375-indicador-faisca');
    await page.getByRole('button', { name: 'Parar execução' }).click();
    await expect(page.getByRole('region', { name: 'Execução interrompida' })).toBeVisible();
    await expect(workingLine(page)).toHaveCount(0); // sem execução não há linha de trabalho
    await expect(threadFaiscas(page)).toHaveCount(0); // e a interrupção não leva Faísca

    const limited = await createBot(page, 'Celular limitado', { stepLimit: 2, color: '#2DD4BF' });
    await page.goto(`/bots/${limited}`);
    await send(page, '[loop] sem parar');
    const limit = page.getByRole('region', { name: 'Limite atingido' });
    await expect(limit).toBeVisible();
    await expectCardFaisca(limit, 'error', 'O limite de chamadas de ferramenta desta execução foi atingido.', '#2DD4BF');
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'conversa-375-limite-faisca');
    expect(problems).toEqual([]);
  });

  test('a atividade da web cabe na tela estreita: a lista mostra até 12 linhas e rola por dentro, a URL longa quebra e o link abre em nova aba', async ({ page }, testInfo) => {
    const problems = watchPage(page);
    await stubExternalPages(page);
    await ensureCredential(page, 'provider', PROVIDER_KEY);
    const botId = await createBot(page, 'Pesquisador celular');
    await page.goto(`/bots/${botId}`);
    await runWebActivities(page);
    await expectNoHorizontalScroll(page);

    // A lista de resultados mostra no máximo 12 linhas (15 rem) e rola por dentro, focável pelo teclado; a página nunca rola para o lado.
    const metrics = await resultsList(page).evaluate((element) => ({
      client: element.clientHeight,
      scroll: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
      tabIndex: element.tabIndex,
    }));
    expect(metrics.client).toBeLessThanOrEqual(240);
    expect(metrics.scroll).toBeGreaterThan(metrics.client);
    expect(metrics).toMatchObject({ overflowY: 'auto', tabIndex: 0 });
    await attachShot(page, testInfo, 'web-375-pesquisa');
    await expectWebActivities(page);
    await attachShot(page, testInfo, 'web-375-leitura');
    await expectNoA11yViolations(page);
    const popupPromise = page.context().waitForEvent('page');
    await resultsList(page).getByRole('link', { name: /Resultado número 3 da pesquisa/ }).click();
    const popup = await popupPromise;
    expect(popup.url()).toBe(LONG_URL);
    await popup.close();
    expect(problems).toEqual([]);
  });

  test('o chat geral carrega o histórico por rodadas como o bot, e o aviso de falha e o botão cabem na coluna estreita', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const problems = watchPage(page);
    const sessionId = await createSessionWithRounds(page);
    await page.goto(`/chat/${sessionId}`);
    await expectRoundsFlow(page, testInfo, 'historico-375-chat-geral');
    await expectNoHorizontalScroll(page);

    // A falha de carga também cabe em 375 px: o texto quebra linha e o botão fica ao alcance do toque (44 px de altura, largura da coluna).
    await page.goto(`/chat/${sessionId}`);
    await expect(log(page).getByText(`Resposta: rodada ${SEEDED_ROUNDS}`)).toBeVisible();
    await page.route(MESSAGES_PAGE, (route) => route.abort('failed'));
    await scrollLogTo(page, 0);
    const retry = page.getByRole('button', { name: 'Tentar novamente' });
    await expect(retry).toBeInViewport();
    const box = (await retry.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThan(300);
    await expectNoHorizontalScroll(page);
    await attachShot(page, testInfo, 'historico-375-chat-geral-erro');
    await expectNoA11yViolations(page);
    await page.unroute(MESSAGES_PAGE);
    expect(problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Estado ao vivo do bot na lista e no cabeçalho (T11, F10, A12)
// ---------------------------------------------------------------------------------------------

/** Chave do Composio com apps (a mesma de approvals.spec.ts): sem apps o motor não oferece a ação e o cartão de aprovação nunca aparece. */
const CONNECTOR_KEY = 'valid-e2e-composio-2222';

/** Cor de texto de cada estado na lista (tokens do kit: --text, --warning, --success, --danger e --text-muted). */
const STATE_TEXT_COLOR = {
  working: 'rgb(236, 236, 241)',
  waiting: 'rgb(251, 191, 36)',
  done: 'rgb(74, 222, 128)',
  error: 'rgb(248, 113, 113)',
  idle: 'rgb(163, 163, 176)',
  sleep: 'rgb(163, 163, 176)',
} as const;

test.describe('estado ao vivo do bot: lista de bots e cabeçalho da conversa (T11)', () => {
  test('seis bots em estados diferentes, o cabeçalho em cada estado e a mudança de estado sem recarregar, em 1440 e 375 px', async ({ page }, testInfo) => {
    test.setTimeout(300_000);
    const problems = watchPage(page);
    await ensureCredential(page, 'provider', PROVIDER_KEY);
    await ensureCredential(page, 'connector', CONNECTOR_KEY, { replace: true });
    // UM login, antes de abrir a tela (E22): todas as chamadas por API reutilizam estes cabeçalhos.
    const headers = await apiHeaders(page);
    const request = page.context().request;
    await request.put(`${ORIGIN}/api/approval-rules/GMAIL_SEND_EMAIL`, { headers, data: { value: 'neutral' } }); // cada execução parte da regra neutra (a ação pede aprovação)

    interface Fixture {
      id: string;
      name: string;
      color: string;
    }
    const make = async (name: string, color: string): Promise<Fixture> => {
      const unique = uniqueBotName(name);
      const response = await request.post(`${ORIGIN}/api/bots`, { headers, data: { name: unique, color, instructions: '', model: 'opencode/glm-5.1', effort: null, stepLimit: 25 } });
      expect(response.status(), `criar o bot ${unique}`).toBe(201);
      return { id: ((await response.json()) as { id: string }).id, name: unique, color };
    };
    // Nomes com o prefixo "Estado": o banco é um só para todos os specs, e a lista ao vivo localiza cada linha pelo nome exato (o bots.spec já usa "Vivo ...").
    const bots = {
      transition: await make('Estado transição', '#60A5FA'),
      working: await make('Estado trabalhando', '#FBBF24'),
      waiting: await make('Estado aguardando', '#F472B6'),
      failed: await make('Estado falhou', '#A78BFA'),
      archived: await make('Estado arquivado', '#2DD4BF'),
      done: await make('Estado concluído', '#4ADE80'),
    };
    // O bot que espera aprovação nasce sem conta do conector (A15, A16): sem a liberação o pedido não traz as ferramentas do conector e `[gmail]` nunca pausa pedindo aprovação (CONN-02).
    await releaseConnectorAccounts(page, bots.waiting.id, undefined, headers);

    /** O estado ao vivo que a API devolve para o bot na lista. */
    const stateOf = async (bot: Fixture): Promise<string | undefined> => {
      const list = (await (await request.get(`${ORIGIN}/api/bots`, { headers })).json()) as { bots: { id: string; runState: string }[] };
      return list.bots.find((item) => item.id === bot.id)?.runState;
    };
    /** Leva o bot ao estado pedido enviando a mensagem (se ele ainda não está nele) e espera a API confirmar. */
    const reach = async (bot: Fixture, state: string, content: string): Promise<void> => {
      if ((await stateOf(bot)) !== state) {
        const sent = await request.post(`${ORIGIN}/api/bots/${bot.id}/messages`, { headers, data: { content } });
        expect(sent.status(), `enviar "${content}" ao bot ${bot.name}`).toBe(201);
      }
      await expect.poll(() => stateOf(bot), { timeout: 30_000, message: `${bot.name} em ${state}` }).toBe(state);
    };

    let waitingApproval = '';
    try {
      // --- Os seis estados, em ordem: o concluído por último, para a janela de 60 s ainda estar aberta quando a tela os mostrar ---
      await reach(bots.failed, 'error', '[falha] provedor fora do ar');
      await reach(bots.waiting, 'waiting', '[gmail] envie o relatório');
      await reach(bots.working, 'working', '[demorar]');
      expect((await request.post(`${ORIGIN}/api/bots/${bots.archived.id}/archive`, { headers })).status()).toBe(200);
      await reach(bots.done, 'done', 'Olá, tudo bem?');
      const snapshot = (await (await request.get(`${ORIGIN}/api/bots/${bots.waiting.id}/conversation`, { headers })).json()) as {
        items: { card?: { type: string; status: string; approvalId: string } }[];
      };
      waitingApproval = snapshot.items.find((item) => item.card?.type === 'approval' && item.card.status === 'pending')?.card?.approvalId ?? '';
      expect(waitingApproval, 'o pedido de aprovação do bot que espera').not.toBe('');

      // --- 1440 × 900: a lista com os seis estados ---
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/bots/${bots.transition.id}`);
      await page.evaluate(() => {
        (window as unknown as { __semRecarga: boolean }).__semRecarga = true; // some se a página recarregar
      });
      const panel = page.getByRole('complementary');
      const linkOf = (scope: Locator, bot: Fixture) => scope.locator(`a[title=${JSON.stringify(bot.name)}]`);
      /** As linhas da lista do painel (desktop): texto de estado, cor, e a Faísca. `skip` deixa de fora o bot cujo estado o teste já mexeu. */
      const expectRows = async (scope: Locator, skip: Fixture[] = []): Promise<void> => {
        const rows: [Fixture, string, keyof typeof STATE_TEXT_COLOR, boolean][] = [
          [bots.transition, 'Livre', 'idle', true],
          [bots.working, 'Trabalhando…', 'working', false],
          [bots.waiting, 'Aguardando aprovação', 'waiting', false],
          [bots.done, 'Concluiu agora', 'done', true],
          [bots.failed, 'Última execução falhou', 'error', true],
          [bots.archived, 'Arquivado', 'sleep', true],
        ];
        for (const [bot, text, state, still] of rows.filter(([bot]) => !skip.includes(bot))) {
          const link = linkOf(scope, bot);
          await expect(link, `linha de ${bot.name}`).toContainText(text);
          // O texto de estado é do link (nome acessível "<nome> <estado>"); só o bot que trabalha ou espera aprovação se mexe; a Faísca é decorativa, de 24 px, na cor do bot.
          await expect(link.getByText(text, { exact: true })).toHaveCSS('color', STATE_TEXT_COLOR[state]);
          // A25 (phase 18): o texto de estado só fica à vista quando o bot aguarda o dono ou está com erro; nos demais estados é só do leitor de tela.
          const attention = state === 'waiting' || state === 'error';
          const stateBox = (await link.getByText(text, { exact: true }).boundingBox())!;
          if (attention) {
            expect(stateBox.width, `texto de estado de ${bot.name} à vista`).toBeGreaterThan(8);
            // Decisão do dono (15/11/2026): o estado de atenção fica numa segunda linha, abaixo do nome, que não é truncado por ele.
            const nameBox = (await link.getByText(bot.name, { exact: true }).boundingBox())!;
            expect(stateBox.y, `estado de ${bot.name} abaixo do nome`).toBeGreaterThanOrEqual(nameBox.y + nameBox.height - 1);
            expect(await link.getByText(bot.name, { exact: true }).evaluate((el) => el.scrollWidth <= el.clientWidth), `nome de ${bot.name} inteiro`).toBe(true);
          } else expect(stateBox.width, `texto de estado de ${bot.name} só para o leitor de tela`).toBeLessThanOrEqual(1);
          expect(await faiscaLook(link.locator('svg.faisca')), `Faísca de ${bot.name}`).toMatchObject({
            state,
            detail: 'small',
            still,
            decorative: true,
            size: [24, 24],
            body: bot.color.toUpperCase(),
          });
        }
      };
      const archivedToggle = panel.getByRole('button', { name: /Arquivados/ });
      if ((await archivedToggle.getAttribute('aria-expanded')) !== 'true') await archivedToggle.click();
      await expectRows(panel);
      await expectNoA11yViolations(page);
      await attachShot(page, testInfo, 'lista-1440-seis-estados');

      // --- O cabeçalho em cada estado, navegando pela própria lista (sem recarregar) ---
      const header = page.getByRole('main').locator('header').first();
      const headerFaisca = header.locator('svg.faisca');
      // Só trabalhando e aguardando se mexem; a Faísca do cabeçalho não leva `still` do chamador, então os demais estados ficam parados sozinhos.
      const headerLook = (bot: Fixture, state: string) => ({ state, detail: 'small', still: state !== 'working' && state !== 'waiting', decorative: true, size: [32, 32], body: bot.color.toUpperCase() });
      expect(await faiscaLook(headerFaisca), 'cabeçalho de um bot livre').toMatchObject(headerLook(bots.transition, 'idle'));
      // Por estado: o selo visível do cabeçalho (ou nulo) e o texto de estado da lista, que o cabeçalho também diz.
      const headerStates: [Fixture, string, string | null, string][] = [
        [bots.working, 'working', 'Trabalhando', 'Trabalhando…'],
        [bots.waiting, 'waiting', 'Aguardando aprovação', 'Aguardando aprovação'],
        [bots.failed, 'error', null, 'Última execução falhou'],
        [bots.done, 'done', null, 'Concluiu agora'],
        [bots.archived, 'sleep', null, 'Arquivado'],
      ];
      for (const [bot, state, badge, stateText] of headerStates) {
        await linkOf(panel, bot).click();
        await expect(page).toHaveURL(new RegExp(`/bots/${bot.id}$`));
        await expect(headerFaisca, `cabeçalho de ${bot.name}`).toHaveAttribute('data-state', state);
        expect(await faiscaLook(headerFaisca), `cabeçalho de ${bot.name}`).toMatchObject(headerLook(bot, state));
        // O selo de estado do cabeçalho continua dizendo em texto o que se passa (a Faísca não o substitui); nos demais estados não há selo.
        await expect(header.getByRole('status')).toHaveCount(badge === null ? 0 : 1);
        if (badge !== null) await expect(header.getByRole('status')).toHaveText(badge);
        // O estado também existe em texto no DOM do cabeçalho (a Faísca é decorativa): com o selo visível (trabalhando, aguardando) o selo o diz e nada se repete; nos demais
        // há um texto só para leitor de tela (`sr-only`) com o mesmo texto da lista, estático, sem região ao vivo (a releitura de 5 ou 15 s não o reanuncia).
        if (badge === null) {
          const hidden = header.getByText(stateText, { exact: true });
          await expect(hidden, `texto de estado no cabeçalho de ${bot.name}`).toHaveCount(1);
          expect((await hidden.boundingBox())!.width, 'só para leitor de tela').toBeLessThanOrEqual(1);
          await expect(hidden).not.toHaveAttribute('aria-live', /.+/);
        } else {
          await expect(header.getByText(stateText, { exact: true }), 'com o selo visível o texto de estado não se repete').toHaveCount(badge === stateText ? 1 : 0);
        }
        await attachShot(page, testInfo, `cabecalho-1440-${state}`);
      }
      await expectNoA11yViolations(page);

      // --- A mudança de estado sem recarregar: o bot livre trabalha e conclui, no cabeçalho e na lista ---
      await linkOf(panel, bots.transition).click();
      await expect(page).toHaveURL(new RegExp(`/bots/${bots.transition.id}$`));
      await expect(headerFaisca).toHaveAttribute('data-state', 'idle');
      expect((await header.getByText('Livre', { exact: true }).boundingBox())!.width, 'o bot livre diz "Livre" no cabeçalho, só para leitor de tela').toBeLessThanOrEqual(1);
      await composer(page).fill('[lento] conte até oito');
      await composer(page).press('Enter');
      await expect(headerFaisca).toHaveAttribute('data-state', 'working');
      await expect(workingBadge(page)).toBeVisible();
      await expect(linkOf(panel, bots.transition)).toContainText('Trabalhando…');
      expect(await faiscaLook(linkOf(panel, bots.transition).locator('svg.faisca'))).toMatchObject({ state: 'working', still: false });
      await attachShot(page, testInfo, 'cabecalho-1440-trabalhando-transicao'); // a execução [lento] dura cerca de 2 s: a captura pode pegar o fim
      // O evento de fim da execução (SSE) muda a Faísca do cabeçalho na hora, sem esperar o ciclo de 5 s da lista (prazo menor que o ciclo).
      await expect(workingLine(page)).toHaveCount(0, { timeout: 15_000 });
      await expect(headerFaisca).toHaveAttribute('data-state', 'done', { timeout: 4_000 });
      await expect(workingBadge(page)).toHaveCount(0);
      expect((await header.getByText('Concluiu agora', { exact: true }).boundingBox())!.width, 'sem o selo, o cabeçalho diz o novo estado, só para leitor de tela').toBeLessThanOrEqual(1);
      await expect(linkOf(panel, bots.transition)).toContainText('Concluiu agora', { timeout: 10_000 });
      await attachShot(page, testInfo, 'cabecalho-1440-concluido-transicao');
      expect(await page.evaluate(() => (window as unknown as { __semRecarga?: boolean }).__semRecarga), 'a página não recarregou').toBe(true);

      // --- 375 × 812: o cabeçalho estreito (Voltar, nome com a segunda linha de estado e "Mais ações do bot") e o Início com os seis estados ---
      await reach(bots.working, 'working', '[demorar]'); // a execução longa do primeiro passo pode ter acabado (o provedor falso fala por 60 s)
      await reach(bots.done, 'done', 'Oi de novo'); // e o concluído tem só 60 s de janela
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(`/bots/${bots.waiting.id}`);
      await expect(tabBarOf(page), 'a conversa não tem barra inferior').toHaveCount(0);
      await expect(headerFaisca).toHaveAttribute('data-state', 'waiting');
      expect(await faiscaLook(headerFaisca)).toMatchObject(headerLook(bots.waiting, 'waiting'));
      // A segunda linha do cabeçalho é o selo de estado (no desktop ele fica à direita do nome; só um está visível por largura).
      await expect(header.getByRole('status')).toHaveText('Aguardando aprovação');
      await expect(header.getByText('Aguardando aprovação', { exact: true }), 'o estado não se repete fora do selo').toHaveCount(1);
      // O nome precisa ocupar espaço legível mesmo com o estado longo e os controles; axe/overflow não detectam largura zero. Só os controles visíveis contam (os ícones do desktop ficam escondidos).
      const geometry = await header.evaluate((element) => {
        const title = element.querySelector('h1')!.getBoundingClientRect();
        const state = element.querySelector('[role=status]')!.getBoundingClientRect();
        const actions = [...element.querySelectorAll('a, button')]
          .map((control) => { const box = control.getBoundingClientRect(); return { name: control.getAttribute('aria-label'), x: box.x, right: box.right, width: box.width, height: box.height }; })
          .filter((action) => action.width > 0);
        return { titleWidth: title.width, titleBottom: title.bottom, stateTop: state.top, actions, viewport: window.innerWidth };
      });
      expect(geometry.titleWidth, JSON.stringify(geometry)).toBeGreaterThan(150);
      expect(geometry.titleBottom, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.stateTop);
      expect(geometry.actions.map((action) => action.name), 'no celular só o Voltar e o menu').toEqual(['Voltar', 'Mais ações do bot']);
      for (const action of geometry.actions) { expect(action.width).toBeGreaterThanOrEqual(40); expect(action.height).toBeGreaterThanOrEqual(40); expect(action.x).toBeGreaterThanOrEqual(0); expect(action.right).toBeLessThanOrEqual(geometry.viewport); }
      await testInfo.attach('cabecalho-375-geometria', { body: JSON.stringify(geometry), contentType: 'application/json' });
      await expectNoHorizontalScroll(page);
      await expectNoA11yViolations(page);
      await attachShot(page, testInfo, 'cabecalho-375-aguardando');
      // "Mais ações do bot": Artefatos (phase 14, A3: no lugar do item Tabelas da phase 6), Arquivos, Memória e Editar bot, com as mesmas portas do desktop.
      await page.getByRole('button', { name: 'Mais ações do bot' }).click();
      const actionsMenu = page.getByRole('menu');
      await expect(actionsMenu.getByRole('menuitem')).toHaveText(['Artefatos', 'Arquivos', 'Memória', 'Editar bot']);
      await expect(actionsMenu.getByRole('menuitem', { name: 'Artefatos' })).toHaveAttribute('href', '/artefatos');
      await expect(actionsMenu.getByRole('menuitem', { name: 'Arquivos' })).toHaveAttribute('href', `/bots/${bots.waiting.id}/arquivos`);
      await expect(actionsMenu.getByRole('menuitem', { name: 'Memória' })).toHaveAttribute('href', `/bots/${bots.waiting.id}/memoria`);
      await expect(actionsMenu.getByRole('menuitem', { name: 'Editar bot' })).toHaveAttribute('href', `/bots/${bots.waiting.id}/editar`);
      // Sem axe com o menu aberto: o Radix modal aplica `aria-hidden` ao resto da página e o axe acusa `aria-hidden-focus` em qualquer menu do kit (registrado em .erros-encontrados/2026-10-09-axe-aria-hidden-focus-com-menu-aberto-em-arquivos.md).
      await attachShot(page, testInfo, 'cabecalho-375-menu-aberto');
      await page.keyboard.press('Escape');
      await expect(actionsMenu).toHaveCount(0);

      // "Voltar" leva ao Início, que lista os bots nos seis estados (selo, Faísca de 32 px no estado ao vivo e o texto de estado).
      await backLink(page).click();
      await expect(page).toHaveURL(/\/$/);
      const home = contentOf(page);
      const archivedToggle375 = home.getByRole('button', { name: /Arquivados/ });
      if ((await archivedToggle375.getAttribute('aria-expanded')) !== 'true') await archivedToggle375.click();
      // O da transição está concluído ou já livre, conforme o tempo que passou: fica de fora. Sem selo (concluído, livre, arquivado) o texto de estado é só para o leitor de tela.
      const homeRows: [Fixture, string, string, boolean][] = [
        [bots.working, 'Trabalhando', 'working', false],
        [bots.waiting, 'Aguardando', 'waiting', false],
        [bots.done, 'Concluiu agora', 'done', true],
        [bots.failed, 'Erro', 'error', true],
        [bots.archived, 'Arquivado', 'sleep', true],
      ];
      for (const [bot, text, state, still] of homeRows) {
        const row = linkOf(home, bot);
        await expect(row, `linha de ${bot.name} no Início`).toContainText(text);
        expect(await faiscaLook(row.locator('svg.faisca')), `Faísca de ${bot.name} no Início`).toMatchObject({ state, detail: 'small', still, decorative: true, size: [32, 32], body: bot.color.toUpperCase() });
      }
      await expectNoHorizontalScroll(page);
      await expectNoA11yViolations(page);
      await attachShot(page, testInfo, 'inicio-375-seis-estados');

      // --- O concluído vale 60 s e depois fica livre, sozinho (a lista relê a cada 5 s enquanto há bot em movimento) ---
      await expect(linkOf(home, bots.done)).toContainText('Livre', { timeout: 90_000 });
      expect(await faiscaLook(linkOf(home, bots.done).locator('svg.faisca'))).toMatchObject({ state: 'idle', still: true });
      expect(problems).toEqual([]);
    } finally {
      // Deixa o estado como encontrou: o pedido de aprovação respondido (o badge das Aprovações volta a zero) e a execução longa parada.
      if (waitingApproval !== '') await request.post(`${ORIGIN}/api/approvals/${waitingApproval}/respond`, { headers, data: { decision: 'deny' } });
      await request.post(`${ORIGIN}/api/bots/${bots.working.id}/runs/stop`, { headers });
      await expect.poll(() => stateOf(bots.working), { timeout: 20_000 }).not.toBe('working');
      await expect.poll(() => stateOf(bots.waiting), { timeout: 20_000 }).not.toBe('waiting');
    }
  });
});

test.describe('barra de ações das mensagens (phase 4, T1; F6 e F7)', () => {
  /** Mensagem do dono com quebras, recuo e Markdown: Copiar leva o texto como foi digitado, sem passar pela renderização. */
  const OWNER_TEXT = 'Primeira rodada:\n  item com recuo\n\n**sem negrito na cópia**';
  /** Cada mensagem da conversa com a sua barra (bolha do dono ou última bolha de uma resposta), na ordem da tela. */
  const groups = (page: Page) => log(page).locator('.message-group');
  const barOf = (group: Locator) => group.locator('[data-message-actions]');

  /** Duas rodadas pelo produto de verdade: uma resposta comum e a dos blocos cercados (Markdown bruto conhecido, `FAKE_BLOCKS_REPLY`). */
  async function seedTwoRounds(page: Page, base: string, headers: Record<string, string>): Promise<void> {
    // Uma de cada vez: com a primeira ainda ativa, a segunda viraria complemento dela (CONV-03) e não abriria rodada.
    await postMessage(page, `${ORIGIN}${base}/messages`, headers, OWNER_TEXT);
    await waitIdle(page, base, headers);
    await postMessage(page, `${ORIGIN}${base}/messages`, headers, '[blocos] agora os blocos');
    await waitIdle(page, base, headers);
  }

  test('Copiar leva o texto exato das duas bolhas, mostra "Copiado" e anuncia, a negada vira toast; a resposta mostra o modelo; hover e foco revelam a barra no desktop, o toque a mostra sempre; 1440, 375 e 320 px', async ({ page, browser }, testInfo) => {
    test.setTimeout(180_000);
    const problems = watchPage(page);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await ensureCredential(page, 'provider', PROVIDER_KEY);
    const headers = await apiHeaders(page);
    const request = page.context().request;
    const botId = await createBot(page, 'Barra');
    await seedTwoRounds(page, `/api/bots/${botId}`, headers);
    const created = await request.post(`${ORIGIN}/api/chat/sessions`, { headers });
    expect(created.status(), 'criar a sessão').toBe(201);
    const sessionId = ((await created.json()) as { id: string }).id;
    expect((await request.patch(`${ORIGIN}/api/chat/sessions/${sessionId}/conversation`, { headers, data: { model: 'opencode/glm-5.1', effort: null } })).status()).toBe(200);
    await seedTwoRounds(page, `/api/chat/sessions/${sessionId}`, headers);
    const clipboard = await trackCopies(page);
    const surfaces = [
      { kind: 'bot', url: `/bots/${botId}` },
      { kind: 'chat-geral', url: `/chat/${sessionId}` },
    ];

    for (const { kind, url } of surfaces) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(url);
      await expect(log(page).locator('[data-code-block="code"]')).toBeVisible();
      // Dono, resposta, dono, resposta: uma barra em cada; Copiar em todas, o modelo só nas respostas.
      await expect(groups(page)).toHaveCount(4);
      const owner = groups(page).nth(0);
      const firstAnswer = groups(page).nth(1);
      const lastAnswer = groups(page).nth(3);
      for (const answer of [firstAnswer, lastAnswer]) await expect(barOf(answer).getByText('opencode/glm-5.1', { exact: true })).toHaveAttribute('title', 'opencode/glm-5.1');
      await expect(barOf(owner).getByText('opencode/glm-5.1')).toHaveCount(0);

      // Desktop: sem hover nem foco, só a barra da última resposta aparece; o espaço das outras fica reservado.
      await page.mouse.move(1, 1);
      await expect(barOf(owner)).toHaveCSS('opacity', '0');
      await expect(barOf(firstAnswer)).toHaveCSS('opacity', '0');
      await expect(barOf(lastAnswer)).toHaveCSS('opacity', '1');
      expect((await barOf(owner).boundingBox())!.height, 'o espaço da barra escondida é reservado').toBeGreaterThanOrEqual(32);
      await attachShot(page, testInfo, `barra-${kind}-1440-repouso`);
      // Hover sobre a mensagem revela a barra dela, e só a dela.
      await owner.locator('[id^="message-"]').hover();
      await expect(barOf(owner)).toHaveCSS('opacity', '1');
      await expect(barOf(firstAnswer)).toHaveCSS('opacity', '0');
      await attachShot(page, testInfo, `barra-${kind}-1440-hover`);
      // Foco por teclado: Tab a partir da lista chega ao Copiar da primeira mensagem, e a barra dela aparece sem o mouse.
      await page.mouse.move(1, 1);
      await expect(barOf(owner)).toHaveCSS('opacity', '0');
      await log(page).focus();
      await page.keyboard.press('Tab');
      const ownerCopy = barOf(owner).getByRole('button', { name: 'Copiar' });
      await expect(ownerCopy).toBeFocused();
      await expect(barOf(owner)).toHaveCSS('opacity', '1');
      await attachShot(page, testInfo, `barra-${kind}-1440-foco`);

      // Copiar na mensagem do dono (pelo teclado): o texto como foi digitado, "Copiado" por 2 s e o anúncio.
      await page.keyboard.press('Enter');
      await expect(barOf(owner).getByRole('button', { name: 'Copiado' })).toBeVisible();
      await expect(barOf(owner).getByRole('status')).toHaveText('Mensagem copiada');
      expect(await clipboard()).toBe(OWNER_TEXT);
      await expect(barOf(owner).getByRole('button', { name: 'Copiar' }), '"Copiado" volta a "Copiar" em 2 s').toBeVisible({ timeout: 3_000 });
      await expect(barOf(owner).getByRole('status')).toHaveText('');
      // Copiar na resposta: o Markdown bruto (cercas, crases), não o texto renderizado.
      await barOf(lastAnswer).getByRole('button', { name: 'Copiar' }).click();
      await expect(barOf(lastAnswer).getByRole('button', { name: 'Copiado' })).toBeVisible();
      await expect(barOf(lastAnswer).getByRole('status')).toHaveText('Mensagem copiada');
      expect(await clipboard()).toBe(FAKE_BLOCKS_REPLY);
      await expectNoA11yViolations(page);
      await attachShot(page, testInfo, `barra-${kind}-1440-copiado`);

      // Telas estreitas: a barra cabe na coluna, sem rolagem horizontal da página.
      for (const width of [375, 320]) {
        await page.setViewportSize({ width, height: 812 });
        for (const group of [owner, lastAnswer]) {
          const box = (await barOf(group).boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width, `barra dentro da tela em ${width} px`).toBeLessThanOrEqual(width);
        }
        await expectNoHorizontalScroll(page);
        await expectNoA11yViolations(page);
        await lastAnswer.scrollIntoViewIfNeeded();
        await attachShot(page, testInfo, `barra-${kind}-${width}`);
      }
    }

    // Cópia negada: o toast de erro da phase 3, que fica até ser fechado.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => {
      navigator.clipboard.writeText = () => Promise.reject(new DOMException('negado', 'NotAllowedError'));
    });
    const owner = groups(page).nth(0);
    await owner.locator('[id^="message-"]').hover();
    await barOf(owner).getByRole('button', { name: 'Copiar' }).click();
    await expect(page.getByText('Não foi possível copiar. Selecione o texto e copie manualmente.', { exact: true })).toBeVisible();
    await expect(barOf(owner).getByRole('button', { name: 'Copiar' })).toBeVisible();
    await attachShot(page, testInfo, 'barra-chat-geral-1440-falha');
    expect(problems).toEqual([]);

    // Toque (celular, sem hover real): a barra da mensagem do dono e da última resposta sempre visível, a das respostas antigas só depois do toque, nas duas superfícies.
    const touch = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 812 }, extraHTTPHeaders: { [CLIENT_IP_HEADER]: clientIpFor(`${testInfo.testId}:toque`) } });
    try {
      await apiLogin(touch);
      const phone = await touch.newPage();
      const phoneProblems = watchPage(phone);
      for (const { kind, url } of surfaces) {
        await phone.goto(url);
        await expect(log(phone).locator('[data-code-block="code"]')).toBeVisible();
        expect(await phone.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches), 'o celular não tem ponteiro preciso').toBe(false);
        await expect(groups(phone)).toHaveCount(4);
        // A16 (phase 18): só a última resposta e as mensagens do dono mostram a barra; a resposta antiga a mostra depois do toque nela (e a esconde no segundo toque).
        for (const index of [0, 2, 3]) await expect(barOf(groups(phone).nth(index))).toBeVisible();
        for (const index of [0, 2, 3]) await expect(barOf(groups(phone).nth(index))).toHaveCSS('opacity', '1');
        const oldAnswer = groups(phone).nth(1);
        await expect(barOf(oldAnswer)).toBeHidden();
        await oldAnswer.locator('.markdown').first().tap();
        await expect(barOf(oldAnswer)).toBeVisible();
        await expect(barOf(oldAnswer)).toHaveCSS('opacity', '1');
        await oldAnswer.locator('.markdown').first().tap();
        await expect(barOf(oldAnswer)).toBeHidden();
        await oldAnswer.locator('.markdown').first().tap();
        expect((await barOf(groups(phone).nth(0)).getByRole('button', { name: 'Copiar' }).boundingBox())!.height, 'alvo de 40 px no toque').toBeGreaterThanOrEqual(40);
        await expectNoHorizontalScroll(phone);
        await expectNoA11yViolations(phone);
        await attachShot(phone, testInfo, `barra-${kind}-375-toque`);
      }
      expect(phoneProblems).toEqual([]);
    } finally {
      await touch.close();
    }
  });
});
// ---------------------------------------------------------------------------------------------
// Complemento durante a execução (phase 4, T2; F5, CONV-03; A8 a A11)
// ---------------------------------------------------------------------------------------------

test.describe('complemento durante a execução (phase 4, T2; F5)', () => {
  /** A bolha do complemento que espera a próxima fronteira entre etapas. */
  const pendingBubble = (page: Page) => log(page).locator('[data-complement="pending"]');
  /** A linha "Rascunho devolvido" dentro da caixa do composer. */
  const draftLine = (page: Page) => page.getByRole('group', { name: 'Rascunho devolvido' });

  /** Sessão do Chat geral nova, com o modelo escolhido, e o prefixo dela na API. */
  async function createSession(page: Page, headers: Record<string, string>): Promise<string> {
    const created = await page.context().request.post(`${ORIGIN}/api/chat/sessions`, { headers });
    expect(created.status(), 'criar a sessão').toBe(201);
    const id = ((await created.json()) as { id: string }).id;
    expect((await page.context().request.patch(`${ORIGIN}/api/chat/sessions/${id}/conversation`, { headers, data: { model: 'opencode/glm-5.1', effort: null } })).status()).toBe(200);
    return id;
  }

  test('aguardando com Cancelar, lido com a legenda "complemento" e Cancelar devolvendo ao composer, no bot e no Chat geral, em 1440 e 375 px', async ({ page }, testInfo) => {
    test.setTimeout(150_000);
    const problems = watchPage(page);
    await ensureCredential(page, 'provider', PROVIDER_KEY);
    const headers = await apiHeaders(page);
    const botId = await createBot(page, 'Complementado');
    const sessionId = await createSession(page, headers);
    const surfaces = [
      { kind: 'bot', url: `/bots/${botId}` },
      { kind: 'chat-geral', url: `/chat/${sessionId}` },
    ];

    for (const { kind, url } of surfaces) {
      for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
        await page.goto(url);
        // Uma etapa que escreve devagar e ainda chama uma ferramenta: o complemento enviado no meio é lido antes da chamada seguinte ao modelo.
        const tag = `${kind}-${width}`;
        await send(page, `[lento-pesquisar:x] pedido ${tag}`);
        await expect(page.getByRole('button', { name: 'Parar execução' })).toBeVisible();
        await send(page, `complemento ${tag}`);
        await expect(pendingBubble(page)).toContainText(`complemento ${tag}`);
        await expect(pendingBubble(page).getByText('Complemento · aguardando')).toBeVisible();
        await expect(pendingBubble(page).getByRole('button', { name: 'Cancelar' })).toBeVisible();
        await expectNoHorizontalScroll(page);
        await expectNoA11yViolations(page);
        await attachShot(page, testInfo, `complemento-${tag}-aguardando`);

        // Lido: a bolha vira mensagem do dono com a legenda "complemento", e a resposta segue considerando-o.
        await expect(log(page).getByText(`Resposta: complemento ${tag}`)).toBeVisible({ timeout: 20_000 });
        await expect(pendingBubble(page)).toHaveCount(0);
        const read = log(page).locator('.message-group').filter({ hasText: `complemento ${tag}` }).filter({ hasNot: page.getByText(`Resposta: complemento ${tag}`) });
        await expect(read.getByText('complemento', { exact: true })).toBeVisible();
        await expect(read.getByRole('button', { name: 'Copiar' })).toHaveCount(1); // Copiar continua, sem Editar (complemento não é rodada)
        await expect(workingBadge(page)).toHaveCount(0);
        await expectNoHorizontalScroll(page);
        await expectNoA11yViolations(page);
        await attachShot(page, testInfo, `complemento-${tag}-lido`);
      }

      // Cancelar: o complemento sai da execução (que segue) e volta ao composer vazio, com o aviso.
      await page.setViewportSize({ width: 1440, height: 900 });
      await send(page, '[demorar] segura');
      await expect(page.getByRole('button', { name: 'Parar execução' })).toBeVisible();
      await send(page, `para cancelar ${kind}`);
      await expect(pendingBubble(page)).toContainText(`para cancelar ${kind}`);
      await pendingBubble(page).getByRole('button', { name: 'Cancelar' }).click();
      await expect(composer(page)).toHaveValue(`para cancelar ${kind}`);
      await expect(page.getByText('Seu complemento voltou para o campo de mensagem.').first()).toBeVisible();
      await expect(pendingBubble(page)).toHaveCount(0);
      await expect(workingBadge(page)).toBeVisible(); // nada foi interrompido
      await attachShot(page, testInfo, `complemento-${kind}-1440-devolvido`);
      await composer(page).fill('');
      await page.getByRole('button', { name: 'Parar execução' }).click();
      await expect(page.getByRole('region', { name: 'Execução interrompida' }).last()).toBeVisible();
    }
    expect(problems).toEqual([]);
  });

  test('o rascunho devolvido chega a dois aparelhos uma vez só: com texto digitado vira a linha "Usar · Descartar", e vazio entra no campo de um só', async ({ page, browser }, testInfo) => {
    test.setTimeout(120_000);
    const problems = watchPage(page);
    await ensureCredential(page, 'provider', PROVIDER_KEY);
    const headers = await apiHeaders(page);
    const botId = await createBot(page, 'Dois aparelhos');
    const other = await browser.newContext({ viewport: { width: 375, height: 812 }, extraHTTPHeaders: { [CLIENT_IP_HEADER]: clientIpFor(`${testInfo.testId}:outro`) } });
    try {
      await apiLogin(other);
      const phone = await other.newPage();
      await page.goto(`/bots/${botId}`);
      await phone.goto(`/bots/${botId}`);
      const stop = async () => expect((await page.context().request.post(`${ORIGIN}/api/bots/${botId}/runs/stop`, { headers })).status()).toBe(200);

      // 1. Os dois composers com texto: a parada devolve o rascunho como a linha inline nos dois.
      // A parada anterior devolve o rascunho na hora, mas a execução só termina no batimento do worker: com ela ainda ativa (parando), o envio
      // seguinte entraria na fila. Espera o bot livre e a nova execução rodando de fato.
      await expect(workingBadge(page)).toHaveCount(0);
      await send(page, '[demorar] primeira');
      await expect(workingLine(page).getByText('Trabalhando…')).toBeVisible();
      await send(page, 'complemento devolvido em linha');
      await expect(pendingBubble(phone)).toContainText('complemento devolvido em linha'); // o outro aparelho também vê a bolha
      await composer(page).fill('texto do desktop');
      await composer(phone).fill('texto do celular');
      await stop();
      await expect(draftLine(page)).toContainText('complemento devolvido em linha');
      await expect(draftLine(phone)).toContainText('complemento devolvido em linha');
      await expectNoHorizontalScroll(phone);
      await expectNoA11yViolations(phone);
      await attachShot(phone, testInfo, 'complemento-375-linha-rascunho');
      await attachShot(page, testInfo, 'complemento-1440-linha-rascunho');
      // "Usar" pede a confirmação inline; "Substituir" troca o texto do celular, e a linha some no desktop (entregue uma vez).
      await draftLine(phone).getByRole('button', { name: 'Usar' }).click();
      await expect(draftLine(phone)).toContainText('Substituir o texto atual?');
      await attachShot(phone, testInfo, 'complemento-375-confirmar-substituir');
      await draftLine(phone).getByRole('button', { name: 'Substituir' }).click();
      await expect(composer(phone)).toHaveValue('complemento devolvido em linha');
      await expect(draftLine(page)).toHaveCount(0);
      await expect(composer(page)).toHaveValue('texto do desktop');

      // 2. "Descartar": a linha some e o texto digitado fica.
      await composer(phone).fill('');
      await composer(page).fill('');
      // A parada anterior devolve o rascunho na hora, mas a execução só termina no batimento do worker: com ela ainda ativa (parando), o envio
      // seguinte entraria na fila. Espera o bot livre e a nova execução rodando de fato.
      await expect(workingBadge(page)).toHaveCount(0);
      await send(page, '[demorar] segunda');
      await expect(workingLine(page).getByText('Trabalhando…')).toBeVisible();
      await send(page, 'complemento descartado');
      await expect(pendingBubble(page)).toContainText('complemento descartado');
      await composer(page).fill('fica como está');
      await composer(phone).fill('também fica');
      await stop();
      await expect(draftLine(page)).toBeVisible();
      await draftLine(page).getByRole('button', { name: 'Descartar' }).click();
      await expect(draftLine(page)).toHaveCount(0);
      await expect(draftLine(phone)).toHaveCount(0);
      await expect(composer(page)).toHaveValue('fica como está');
      await expect(composer(phone)).toHaveValue('também fica');

      // 3. Os dois composers vazios: só um recebe o rascunho no campo.
      await composer(page).fill('');
      await composer(phone).fill('');
      // A parada anterior devolve o rascunho na hora, mas a execução só termina no batimento do worker: com ela ainda ativa (parando), o envio
      // seguinte entraria na fila. Espera o bot livre e a nova execução rodando de fato.
      await expect(workingBadge(page)).toHaveCount(0);
      await send(page, '[demorar] terceira');
      await expect(workingLine(page).getByText('Trabalhando…')).toBeVisible();
      await send(page, 'complemento de um aparelho só');
      await expect(pendingBubble(phone)).toContainText('complemento de um aparelho só');
      await stop();
      await expect.poll(async () => [await composer(page).inputValue(), await composer(phone).inputValue()].filter((value) => value === 'complemento de um aparelho só').length, { timeout: 15_000 }).toBe(1);
      await page.waitForTimeout(1_500); // nenhum segundo aparelho o recebe depois
      expect([await composer(page).inputValue(), await composer(phone).inputValue()].sort()).toEqual(['', 'complemento de um aparelho só']);
      await expect(draftLine(page)).toHaveCount(0);
      await expect(draftLine(phone)).toHaveCount(0);
    } finally {
      await other.close();
    }
    // O aparelho que perdeu a corrida pode ter recebido o 404 esperado (DRAFT_NOT_FOUND); nada além disso.
    expect(problems.filter((problem) => !/^404 POST \/api\/bots\/[^/]+\/draft\/\d+\/consume$/.test(problem))).toEqual([]);
  });
});

// Jornada real do cartão de limite: a mesma execução é continuada pela interface, sem reenviar a mensagem.
test('limite de saída preserva trecho e permite continuar no mesmo run', async ({ page }) => {
  await ensureCredential(page, 'provider', PROVIDER_KEY);
  const botId = await createBot(page, 'Limite de saída');
  // apiHeaders faz login novo: capture antes de hidratar a tela para manter cookie e CSRF da mesma sessão.
  const headers = await apiHeaders(page);
  await page.goto(`/bots/${botId}`);
  await send(page, `[saida-limitada-manual] concluir a resposta ${botId}`);
  await expect(page.getByText('Resposta incompleta: limite de saída atingido.', { exact: true }).last()).toBeVisible();
  await expect(page.getByText('Trecho preservado antes do limite.', { exact: true }).last()).toBeVisible();
  const before = await (await page.context().request.get(`${ORIGIN}/api/bots/${botId}/conversation`, { headers })).json();
  const runIdsBefore = [...new Set(before.items.map((item: { runId: string | null }) => item.runId).filter(Boolean))];
  expect(runIdsBefore).toHaveLength(1);
  const limitCard = before.items.find((item: { kind: string; card?: { type: string; continuation?: { automatic: boolean } } }) => item.kind === 'card' && item.card?.type === 'run_limit' && !item.card.continuation?.automatic);

  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await expect(page.getByText('Resposta concluída após continuar.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continuar', exact: true })).toHaveCount(0);

  // Requisição atrasada da ação antiga recusa, sem virar retry/regenerate nem abrir outra execução.
  const stale = await page.context().request.post(`${ORIGIN}/api/bots/${botId}/runs/${runIdsBefore[0]}/continue`, { headers, data: { limitMessageId: limitCard.id } });
  expect(stale.status()).toBe(409);
  expect(await stale.json()).toMatchObject({ code: 'RUN_NOT_RETRYABLE' });
  const after = await (await page.context().request.get(`${ORIGIN}/api/bots/${botId}/conversation`, { headers })).json();
  expect([...new Set(after.items.map((item: { runId: string | null }) => item.runId).filter(Boolean))]).toEqual(runIdsBefore);
  await expectNoA11yViolations(page);
});

// O indicador permanece visível enquanto o worker continua, e a conclusão não exige clique.
test('continuação automática após limite de saída conclui no mesmo run', async ({ page }) => {
  await ensureCredential(page, 'provider', PROVIDER_KEY);
  const botId = await createBot(page, 'Saída automática');
  const headers = await apiHeaders(page);
  await page.goto(`/bots/${botId}`); await send(page, `[saida-limitada] concluir ${botId}`);
  await expect(page.getByText('Continuação automática 1/3', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Parar execução', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continuar', exact: true })).toHaveCount(0);
  await expect(page.getByText('Resposta concluída após continuar.', { exact: true })).toBeVisible();
  const snapshot = await (await page.context().request.get(`${ORIGIN}/api/bots/${botId}/conversation`, { headers })).json();
  expect(snapshot.runs).toEqual([]);
  expect([...new Set(snapshot.items.map((item: { runId: string | null }) => item.runId).filter(Boolean))]).toHaveLength(1);
  await expectNoA11yViolations(page);
});

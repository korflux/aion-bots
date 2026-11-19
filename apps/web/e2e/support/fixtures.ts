// Fixtures dos specs: cada teste recebe um "IP de cliente" próprio (repassado pelo proxy da pilha em
// X-Forwarded-For), para que o bloqueio por IP de um teste nunca afete os outros, e ajudantes de login e axe.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { connectorAccountsResponseSchema } from '@aion/shared';
import { expect, test as base, type BrowserContext, type Locator, type Page, type TestInfo } from '@playwright/test';
import { E2E_CLIENT_IP_HEADER, E2E_ORIGIN, E2E_OWNER } from '../../../../tests/support/e2e-env';
import { isAntivirusNoise } from './console-noise';

export { E2E_OWNER as OWNER, E2E_ORIGIN as ORIGIN, E2E_CLIENT_IP_HEADER as CLIENT_IP_HEADER };

/** IP de documentação (198.18.0.0/15) derivado do id do teste: estável, único e fora de faixas reais. */
export function clientIpFor(seed: string): string {
  const digest = createHash('sha1').update(seed).digest();
  return `198.18.${digest[0]! % 250}.${(digest[1]! % 250) + 1}`;
}

export const test = base.extend({
  extraHTTPHeaders: async ({}, use, testInfo) => {
    await use({ [E2E_CLIENT_IP_HEADER]: clientIpFor(`${testInfo.testId}:${testInfo.retry}`) });
  },
});

export { expect };

/**
 * Nome de bot exclusivo da repetição (`--repeat-each`) e da nova tentativa (`retries`) em curso (E29). O nome de um bot ativo é único no
 * banco e a pilha do E2E é uma só, então um spec que cria "Memorioso" a cada execução toma 409 (`BOT_NAME_TAKEN`) da segunda em diante.
 * A primeira execução (repetição 0, sem nova tentativa) mantém o nome puro; as demais recebem o sufixo `(r<repetição>[.<tentativa>])`.
 * É estável dentro do teste: chamar duas vezes com o mesmo `base` devolve o mesmo nome, então a asserção recalcula em vez de guardar.
 * Só vale dentro de um teste ou hook (lê `test.info()`).
 */
export function uniqueBotName(base: string): string {
  const { repeatEachIndex, retry } = test.info();
  return repeatEachIndex === 0 && retry === 0 ? base : `${base} (r${repeatEachIndex}${retry > 0 ? `.${retry}` : ''})`;
}

/**
 * Espera o React hidratar o elemento: só depois disso os handlers existem. O `autoFocus` não serve de sinal (o HTML do servidor já
 * sai com `autofocus`, então o navegador foca antes da hidratação) e digitar antes dela perde o valor, porque o React reinicia os
 * campos controlados ao assumir a página. O React grava `__reactProps$...` no nó ao hidratar. Use depois de `goto` e antes de
 * preencher um campo ou clicar (formulários de login e de código do autenticador): em máquina lenta, como o CI, o clique ou o texto
 * que chega antes da hidratação se perde (E6).
 */
export async function waitForHydration(locator: Locator): Promise<void> {
  await expect
    .poll(() => locator.evaluate((element) => Object.keys(element).some((key) => key.startsWith('__reactProps$'))))
    .toBe(true);
}

/** Login direto pela API no contexto (fica com o cookie de sessão), sem passar pela tela. */
export async function apiLogin(context: BrowserContext): Promise<void> {
  const response = await context.request.post(`${E2E_ORIGIN}/api/auth/login`, {
    headers: { origin: E2E_ORIGIN },
    data: { email: E2E_OWNER.email, password: E2E_OWNER.password },
  });
  expect(response.status(), 'login por API').toBe(200);
}

/**
 * O invólucro da Faísca das telas de destaque (login, TOTP, erro, Início): o elemento pai envolve SÓ a Faísca (um filho), que é onde o halo e a posição ficam. Prova a estrutura, não a classe
 * de aparência do halo (a classe não é localizador: phase 18, A32).
 */
export async function expectFaiscaEnvelope(faisca: Locator): Promise<void> {
  expect(await faisca.evaluate((svg) => svg.parentElement?.children.length ?? 0), 'o invólucro envolve só a Faísca').toBe(1);
}

/**
 * Foco visível (A33): percorre `steps` paradas do Tab e confere que cada elemento focado mostra o anel do token `focus` (contorno sólido de pelo menos 2 px na cor dele), o que a regra global de `:focus-visible` desenha em
 * todo controle. Devolve os nomes (rótulo ou texto) das paradas, para o teste conferir a ordem se quiser. Começa do topo da página (`body` focado).
 */
export async function expectVisibleFocusOnTab(page: Page, steps: number): Promise<string[]> {
  const stops: string[] = [];
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let step = 0; step < steps; step += 1) {
    await page.keyboard.press('Tab');
    // O anel é medido em poll: as regras de cor do projeto têm `transition` em `outline-color`, então logo após o Tab o contorno ainda está a meio caminho da cor do token.
    const measure = () =>
      page.evaluate(() => {
        const element = document.activeElement as HTMLElement | null;
        if (!element || element === document.body) return null;
        const style = getComputedStyle(element);
        // O anel real do projeto (`:focus-visible` global e as regras do composer e do painel de rolagem): contorno sólido de 2 px na cor do token `--focus`, nunca uma sombra qualquer
        // (um controle com sombra própria permanente não pode passar por foco visível).
        const token = document.createElement('span');
        token.style.color = 'var(--focus)';
        document.body.append(token);
        const focusColor = getComputedStyle(token).color;
        token.remove();
        const outline = style.outlineStyle === 'solid' && parseFloat(style.outlineWidth) >= 2 && style.outlineColor === focusColor;
        // O campo de texto do composer não desenha o anel: quem o desenha é a caixa inteira (`form.composer`), por desenho.
        const box = element.closest('form.composer');
        const boxStyle = box ? getComputedStyle(box) : null;
        const boxRing = boxStyle !== null && boxStyle.outlineStyle === 'solid' && parseFloat(boxStyle.outlineWidth) >= 2 && boxStyle.outlineColor === focusColor && element.matches('textarea');
        return { name: element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40) ?? '', ring: outline || boxRing };
      });
    let stop = await measure();
    expect(stop, `parada ${step + 1} do Tab`).not.toBeNull();
    await expect.poll(async () => (stop = await measure())?.ring ?? false, { message: `anel de foco visível em "${stop!.name}"`, timeout: 2_000 }).toBe(true);
    stops.push(stop!.name);
  }
  return stops;
}

/**
 * Espera as animações e transições FINITAS terminarem e o resto da tela ficar QUIETO por 200 ms. O axe calcula o contraste com a
 * opacidade corrente: um toast ou um cartão ainda aparecendo (fade de entrada) falha em `color-contrast` sem ser um defeito real, e a
 * falha depende só do tempo (vista no CI, mais lento, e aqui com as cores medidas a ~35 % de opacidade). A janela de calma cobre o
 * conteúdo que monta logo depois da última espera. Animações infinitas (spinner, ponto pulsante) não bloqueiam. Quem sabe que há
 * conteúdo assíncrono por vir deve esperar por ele antes (ex.: o `role="log"` da conversa) para o fade já ter começado.
 *
 * Toasts empilhados (sonner): quando entra um toast novo, o antigo passa para trás da pilha e desvanece (`opacity .4s`), mas só depois
 * de a pilha ser renderizada de novo. Sem essa renderização ainda não existe animação para esperar, e uma máquina lenta (o CI) mede o
 * contraste do toast antigo no meio do fade (`li[data-index="1"] ... [data-title]`). Por isso, antes do silêncio, espera-se a pilha
 * ficar consistente: todos os toasts montados e um só na frente.
 */
async function waitForAnimationsToSettle(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () => {
        const toasts = [...document.querySelectorAll('[data-sonner-toast]:not([data-removed="true"])')];
        return toasts.every((toast) => toast.getAttribute('data-mounted') === 'true') && toasts.filter((toast) => toast.getAttribute('data-front') === 'true').length <= 1;
      },
      undefined,
      { timeout: 5_000 },
    )
    // Pilha que não estabiliza em 5 s não é motivo para falhar aqui: o axe abaixo diz se há violação de verdade.
    .catch(() => undefined);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let quietSince = performance.now();
        const check = () => {
          // `pending` é o primeiro quadro de uma animação recém-criada: já conta como ocupada.
          const busy = document
            .getAnimations()
            .some((animation) => (animation.pending || animation.playState === 'running') && animation.effect?.getComputedTiming().iterations !== Infinity);
          const now = performance.now();
          if (busy) quietSince = now;
          if (now - quietSince >= 200) resolve();
          else requestAnimationFrame(check);
        };
        check();
      }),
  );
}

/** Varredura axe (WCAG 2.0/2.1 A e AA: contraste, ARIA, nomes, landmarks). Nenhuma violação é aceita. */
export async function expectNoA11yViolations(page: Page): Promise<void> {
  // A barra de ações da mensagem aparece e some por opacidade em 150 ms (hover, foco); o Chromium reenvia o hover depois de um relayout, então a transição pode começar DEPOIS da janela de calma
  // e o axe medir o texto no meio do fade (registro 2026-11-15-flake-axe-contraste-barra-de-acoes-em-fade-no-attachments). Só a transição sai da medida: o estado final de cada barra segue o mesmo.
  await page.evaluate(() => {
    if (document.getElementById('e2e-no-actions-fade')) return;
    const style = document.createElement('style');
    style.id = 'e2e-no-actions-fade';
    style.textContent = '.message-actions { transition: none !important; }';
    document.head.append(style);
  });
  await waitForAnimationsToSettle(page);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const summary = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    // O resumo do axe traz as cores e a razão de contraste medidas: sem ele uma falha intermitente não se explica.
    nodes: violation.nodes.map((node) => `${node.target.join(' ')} :: ${node.failureSummary?.replace(/\s+/g, ' ') ?? ''}`),
  }));
  expect(summary, JSON.stringify(summary, null, 2)).toEqual([]);
}

/**
 * O que a Faísca desenha na tela (`<svg class="faisca">`): estado, nível de detalhe (`full` a partir de 48 px, `small` de 24 a 47), parada (sem laços de movimento: só
 * `working` e `waiting` se mexem, e nunca com `still`), decorativa (`aria-hidden` sem rótulo), tamanho medido e a cor do corpo (`--faisca-body`: a do bot, ou o azul de
 * marca `#3B82F6` quando é o Aion). É a ÚNICA leitura da Faísca dos specs: uma mudança no desenho se corrige aqui, não em cada spec.
 */
export async function faiscaLook(svg: Locator) {
  return svg.evaluate((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return {
      state: element.getAttribute('data-state'),
      detail: element.getAttribute('data-detail'),
      still: element.hasAttribute('data-still'),
      decorative: element.getAttribute('aria-hidden') === 'true' && !element.hasAttribute('role'),
      size: [Math.round(box.width), Math.round(box.height)],
      body: style.getPropertyValue('--faisca-body').trim().toUpperCase(),
    };
  });
}

/** O azul de marca (`--faisca`) com que a Faísca do Aion (Chat geral, login, erros) aparece em `faiscaLook().body`. */
export const AION_BODY = '#3B82F6';

/** Quantas animações de movimento estão rodando dentro do elemento (laços da Faísca; a entrada, que roda uma vez, conta enquanto durar). */
export async function runningAnimations(element: Locator): Promise<number> {
  return element.evaluate((node) => node.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running').length);
}

/** A página não rola na horizontal (nada estourando a largura da viewport). */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'rolagem horizontal da página').toBeLessThanOrEqual(0);
}

/**
 * Navegação do celular (phase 5, T6): a barra inferior e o "Voltar" no lugar do menu sanduíche e da gaveta, em UM lugar para os specs não repetirem seletores. A barra só existe abaixo
 * de 768 px, nas quatro telas de aba e sem o teclado virtual aberto; no desktop vale a barra de ícones e o painel (`navigation` "Seções" e `complementary`).
 */
export type TabName = 'Início' | 'Chats' | 'Rotinas' | 'Aprovações';
/** A barra inferior do celular (`nav` "Navegação principal"). */
export const tabBarOf = (page: Page): Locator => page.getByRole('navigation', { name: 'Navegação principal' });
/** Uma aba da barra: o nome acessível leva o sinal ("Aprovações, 3 pendentes", "Chats, há novidades não lidas"), então casa pelo começo. */
export const tabOf = (page: Page, name: TabName): Locator => tabBarOf(page).getByRole('link', { name: new RegExp(`^${name}`) });
/** Toca numa aba da barra inferior. */
export async function openTab(page: Page, name: TabName): Promise<void> {
  await tabOf(page, name).click();
}
/** O botão "Voltar" do cabeçalho do celular, que leva ao pai fixo da tela (nunca ao histórico do navegador). */
export const backLink = (page: Page): Locator => page.getByRole('link', { name: 'Voltar', exact: true });
/**
 * O conteúdo da página (`main`). No celular as listas de bots, sessões e rotinas vivem aqui, mas o painel do desktop segue montado por baixo (escondido por CSS) com a mesma lista:
 * um seletor solto casaria os dois, então a lista do celular se procura sempre dentro do conteúdo.
 */
export const contentOf = (page: Page): Locator => page.locator('#conteudo');
/** Simula o teclado virtual do celular: com a viewport encolhida em 400 px (a visual encolhe junto, como com `interactive-widget=resizes-content`) a barra inferior deve sumir se um campo tem foco. */
export async function setKeyboard(page: Page, open: boolean, size: { width: number; height: number } = { width: 375, height: 812 }): Promise<void> {
  await page.setViewportSize({ width: size.width, height: open ? size.height - 400 : size.height });
}

/**
 * Ações do cabeçalho de uma conversa de bot (phase 5, T6): a partir de 768 px são três ícones com nome acessível ("Arquivos do bot", "Memória do bot", "Configurações do bot");
 * abaixo disso o cabeçalho tem só o menu "Mais ações do bot" com os itens "Arquivos", "Memória" e "Editar bot". Os specs que clicam nessas ações num teste que passa pelas duas larguras
 * (as capturas em 375 px deixam a viewport estreita para o resto do teste) usam estes dois ajudantes, que escolhem a porta pela largura atual da viewport.
 */
export type BotAction = 'arquivos' | 'memoria' | 'editar';
const BOT_ACTIONS: Record<BotAction, { icon: string; item: string }> = {
  arquivos: { icon: 'Arquivos do bot', item: 'Arquivos' },
  memoria: { icon: 'Memória do bot', item: 'Memória' },
  editar: { icon: 'Configurações do bot', item: 'Editar bot' },
};
const isNarrow = (page: Page): boolean => (page.viewportSize()?.width ?? 1280) < 768;
/** A entrada visível da ação: o ícone no desktop, o botão "Mais ações do bot" no celular. */
export const botActionEntry = (page: Page, action: BotAction): Locator =>
  isNarrow(page) ? page.getByRole('button', { name: 'Mais ações do bot' }) : page.getByRole('link', { name: BOT_ACTIONS[action].icon, exact: true });
/** Abre a ação do cabeçalho do bot: clica no ícone (desktop) ou abre o menu e escolhe o item (celular). */
export async function openBotAction(page: Page, action: BotAction): Promise<void> {
  const narrow = isNarrow(page);
  await botActionEntry(page, action).click();
  if (narrow) await page.getByRole('menuitem', { name: BOT_ACTIONS[action].item, exact: true }).click();
}

/**
 * Cabeçalhos para chamar a API direto (sem passar pela tela): loga o contexto e devolve cookie, Origin e token CSRF. O cookie de
 * sessão é `Secure` e o Playwright o omite do cliente de API em http://127.0.0.1, então o cabeçalho vai à mão (o navegador
 * o envia normalmente).
 *
 * ATENÇÃO (E22): cada chamada faz um login NOVO e troca o cookie de sessão do contexto, o que invalida o token CSRF de uma tela que já
 * está aberta. Num teste que mistura API e tela, obtenha os cabeçalhos ANTES de abrir a tela e reutilize-os nas chamadas seguintes
 * (como `putMemory` em memory.spec.ts faz com `sessionHeaders`), em vez de chamar `apiHeaders` de novo depois de abrir a tela.
 */
export async function apiHeaders(page: Page): Promise<Record<string, string>> {
  await apiLogin(page.context());
  const cookie = (await page.context().cookies()).map((item) => `${item.name}=${item.value}`).join('; ');
  const session = await (await page.context().request.get(`${E2E_ORIGIN}/api/auth/session`, { headers: { cookie } })).json();
  return { cookie, origin: E2E_ORIGIN, 'x-csrf-token': session.csrfToken };
}

/** Configura (ou, com `null`, remove) a chave do provedor pela API. Com o provedor falso, a chave `valid...` é aceita. */
export async function setProvider(page: Page, key: string | null): Promise<void> {
  const headers = await apiHeaders(page);
  const removed = await page.context().request.delete(`${E2E_ORIGIN}/api/credentials/provider`, { headers });
  expect(removed.status(), 'remover chave do provedor').toBe(204);
  if (key !== null) {
    const saved = await page.context().request.post(`${E2E_ORIGIN}/api/credentials/provider`, { headers, data: { key } });
    expect(saved.status(), 'salvar chave do provedor').toBe(200);
  }
}

/**
 * Garante que a credencial (`provider` ou `connector`) esteja configurada, salvando a chave só se ainda não houver uma. Ao contrário de
 * `setProvider`, que remove e salva de novo, não gasta a cota de 10 validações de chave por minuto: um spec com
 * vários testes que precisam da mesma credencial estouraria o limite (429) se a regravasse a cada teste.
 *
 * A credencial é estado GLOBAL e outros specs a deixam em estados diferentes (ex.: o Composio "sem apps" de `settings-keys.spec.ts`).
 * Um spec que depende de uma chave ESPECÍFICA (o Composio com apps, no das aprovações) passa `replace: true` na primeira vez, para
 * trocá-la pela esperada (1 validação); nas seguintes, o padrão sem troca basta (E17).
 */
export async function ensureCredential(page: Page, kind: 'provider' | 'anthropic' | 'connector', key: string, { replace = false } = {}): Promise<void> {
  const headers = await apiHeaders(page);
  const overview = (await (await page.context().request.get(`${E2E_ORIGIN}/api/credentials`, { headers })).json()) as Record<string, { configured: boolean }>;
  if (overview[kind]?.configured) {
    if (!replace) return;
    const removed = await page.context().request.delete(`${E2E_ORIGIN}/api/credentials/${kind}`, { headers });
    expect(removed.status(), `remover a chave (${kind})`).toBe(204);
  }
  const saved = await page.context().request.post(`${E2E_ORIGIN}/api/credentials/${kind}`, { headers, data: { key } });
  expect(saved.status(), `salvar a chave (${kind})`).toBe(200);
}

/**
 * A conta que cada app do Composio falso já usava antes de as contas serem liberadas por bot (phase 13, CONN-02): a primeira conta ativa, o Gmail `ca_1` e o GitHub `ca_3`. O Gmail tem
 * ainda uma segunda conta ativa, `ca_6`, para os specs que precisam de duas contas do mesmo app.
 */
export const FIRST_ACTIVE_CONNECTOR_ACCOUNTS: readonly string[] = ['ca_1', 'ca_3'];

/**
 * Libera contas do Composio ao bot pela rota do dono (`PUT /api/connector/accounts/:id/access`), ACRESCENTANDO às que o bot já tem. O bot criado num spec nasce sem nenhuma conta (A15, A16),
 * então todo spec que executa uma ação do conector por um bot (os `[gmail]` e `[github]` do provedor falso) a chama antes de enviar a mensagem. O padrão é a conta que os bots usavam antes
 * da phase (`FIRST_ACTIVE_CONNECTOR_ACCOUNTS`). Idempotente. Exige a chave do conector já salva (`ensureCredential(page, 'connector', ...)`), porque a lista de contas lê o Composio.
 *
 * Passe `headers` (de `apiHeaders`, obtidos ANTES de abrir a tela) num spec que já tem uma tela aberta: sem eles, cada chamada faz um login novo e invalida o token CSRF dela (E22). Specs
 * em paralelo disputam a versão da conta, então um conflito (`CONNECTOR_ACCOUNT_CONFLICT`) relê a conta e tenta de novo, como a tela de Conexões faria ao recarregar.
 */
export async function releaseConnectorAccounts(page: Page, botId: string, accountIds: readonly string[] = FIRST_ACTIVE_CONNECTOR_ACCOUNTS, headers?: Record<string, string>): Promise<void> {
  const request = page.context().request;
  const sent = headers ?? (await apiHeaders(page));
  for (const accountId of accountIds) {
    for (let attempt = 1; ; attempt += 1) {
      const listed = await request.get(`${E2E_ORIGIN}/api/connector/accounts`, { headers: sent });
      expect(listed.status(), 'ler as contas do conector').toBe(200);
      const account = connectorAccountsResponseSchema.parse(await listed.json()).accounts.find((item) => item.id === accountId);
      expect(account, `conta ${accountId} na lista do Composio falso`).toBeDefined();
      if (account!.botIds.includes(botId)) break;
      const released = await request.put(`${E2E_ORIGIN}/api/connector/accounts/${accountId}/access`, { headers: sent, data: { botIds: [...account!.botIds, botId], expectedVersion: account!.version } });
      if (released.status() === 200) break;
      const code = ((await released.json()) as { code?: string }).code;
      if (code !== 'CONNECTOR_ACCOUNT_CONFLICT' || attempt >= 10) throw new Error(`liberar a conta ${accountId} ao bot falhou: ${released.status()} ${code}`);
    }
  }
}

/**
 * Anexa a captura ao relatório e, com `AION_E2E_SHOTS_DIR`, também grava o PNG nessa pasta (prova visual da task). `fullContent` captura o conteúdo inteiro da página, não só a janela: é para
 * o estado cujo conteúdo passa da dobra em 375 px (por exemplo, a lista de contas e o link do Composio), que a captura da janela cortaria. O shell tem altura fixa e quem rola é o
 * `main#conteudo` (por isso `fullPage` do Playwright não serve: ele só estica uma janela de altura fixa e deixa o resto em branco), então a janela é alongada até o conteúdo caber, a
 * captura é feita e o tamanho original volta.
 */
export async function attachShot(page: Page, testInfo: TestInfo, name: string, { fullContent = false }: { fullContent?: boolean } = {}): Promise<void> {
  const viewport = page.viewportSize();
  if (fullContent && viewport) {
    const hidden = await page.evaluate(() => {
      const main = document.querySelector('main#conteudo');
      return main ? main.scrollHeight - main.clientHeight : 0;
    });
    if (hidden > 0) await page.setViewportSize({ width: viewport.width, height: viewport.height + hidden });
  }
  let body: Buffer;
  try {
    body = await page.screenshot();
  } finally {
    if (viewport) await page.setViewportSize(viewport);
  }
  await testInfo.attach(name, { body, contentType: 'image/png' });
  const dir = process.env.AION_E2E_SHOTS_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}.png`), body);
  }
}

/**
 * Vigia erros de console e de página (inclui violações de CSP) e respostas HTTP com erro; o teste confere a lista no fim. O ruído do
 * antivírus da máquina de desenvolvimento (erro de CORS do script que ele injeta) não conta: ver `console-noise.ts`.
 */
export function watchPage(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource') && !isAntivirusNoise(message.text())) problems.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('response', (response) => {
    if (response.status() >= 400 && !response.url().includes('/_next/')) {
      problems.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
    }
  });
  return problems;
}

/**
 * Abre a linha de trabalho ("Trabalhou por N s · N ações") que guarda a ferramenta `tool` (phase 18, decisão 5 da spec): a ferramenta só existe no DOM com a linha da execução aberta.
 * É a ÚNICA forma dos specs chegarem a uma ferramenta, e é escopada pelo CONTEÚDO, não pela posição: logo depois do envio a última linha ainda é a da rodada anterior, então
 * "abrir a última" erraria; aqui se abre, uma a uma, cada linha ainda fechada até a ferramenta aparecer, e se espera a linha nova existir (o poll repete até o prazo).
 * Linha já aberta não é tocada, e a ferramenta já visível não clica em nada.
 */
export async function openWorkLine(log: Locator, tool: Locator): Promise<void> {
  const closed = log.getByRole('button', { name: /^(Trabalhou por|Executando \d+ aç|Aguardando aprovação)/, expanded: false });
  await expect
    .poll(async () => {
      while ((await tool.count()) === 0 && (await closed.count()) > 0) await closed.first().click();
      return (await tool.count()) > 0;
    }, { timeout: 15_000 })
    .toBe(true);
}

/** Mensagem longa (60 parágrafos) que, com a resposta do provedor falso, faz o log da conversa rolar em 1440 e em 375 px (A6): o histórico que o teste do topo precisa. */
export const LONG_HISTORY_MESSAGE = Array.from({ length: 60 }, (_, index) => `Parágrafo ${index + 1} do histórico longo da conversa.`).join('\n\n');

/**
 * A6: com a conversa rolada até o topo a linha fixa da Faísca segue na viewport, logo acima do composer. Exige que o contêiner de rolagem role de verdade (`scrollHeight > clientHeight`),
 * rola até o topo e confere a posição da linha contra `form.composer`.
 */
export async function expectWorkingLineAtTop(page: Page, scroller: Locator, line: Locator): Promise<void> {
  const metrics = await scroller.evaluate((node) => ({ scroll: node.scrollHeight, client: node.clientHeight }));
  expect(metrics.scroll, 'a conversa tem histórico que rola').toBeGreaterThan(metrics.client);
  await scroller.evaluate((node) => {
    node.scrollTop = 0;
  });
  expect(await scroller.evaluate((node) => node.scrollTop), 'rolada até o topo').toBe(0);
  await expect(line).toBeInViewport();
  const lineBox = (await line.boundingBox())!;
  const composerBox = (await page.locator('form.composer').boundingBox())!;
  expect(lineBox.y + lineBox.height, 'a linha termina acima do composer').toBeLessThanOrEqual(composerBox.y + 1);
  expect(composerBox.y - (lineBox.y + lineBox.height), 'logo acima do composer').toBeLessThan(40);
}

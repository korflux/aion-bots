// Painel de contexto na pilha descartável (phase 8 T4; phase 9 T6): a única ação é "Compactar agora" (a elisão manual saiu) e "Compactando…" é o único rótulo de
// andamento. Os cenários com fixture de borda (`page.route`) provam a apresentação e o contrato do cliente; os cenários reais (provedor falso, worker e banco da pilha)
// provam elegibilidade, o indicador sem "Desatualizado" depois da resposta, o percentual recalculado sobre a janela nova depois de trocá-la (phase 9 T11) e a
// compactação manual de ponta a ponta. Não certificam posse nem o executor.
import type { ContextState, ContextUsageCounts, ConversationSnapshot, DataTable } from '@aion/shared';
import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { tableMarker } from '../../../packages/core/src/testing/fake-upstreams';
import { apiHeaders, apiLogin, attachShot, ensureCredential, expect, expectNoA11yViolations, expectNoHorizontalScroll, ORIGIN, test, uniqueBotName, watchPage } from './support/fixtures';

test.describe.configure({ mode: 'serial' });

/** Uso parcial preserva campos desconhecidos e explicita cache já contido na entrada. */
const partialUsage: ContextUsageCounts = { calls: 2, inputTokens: 1200, outputTokens: null, cachedTokens: 700, coverage: 'partial' };
const unknownUsage: ContextUsageCounts = { calls: 1, inputTokens: null, outputTokens: null, cachedTokens: null, coverage: 'unknown' };
/** Elegibilidade do servidor com tudo liberado para "Compactar agora" (o servidor decide; a fixture só a reproduz). */
const ELIGIBLE = { enabled: true, reason: null, summarizeEnabled: true, summarizeReason: null } as const;
/** Medição com orçamento de entrada de 22.000 tokens: 19.000 = 86% e 14.000 = 64% da janela nos textos "Compactado: X% → Y% da janela.". */
const MEASURED = { measuredAt: '2026-10-12T12:00:00.000Z', method: 'utf8-body-upper-bound-v1', inputTokens: 19000, inputBudget: 22000, outputReserve: 8192, margin: 2576, availableTokens: 3000, excessTokens: 0, stale: false } as const;

/** Estado sintético sem conteúdo privado, destinado exclusivamente às variantes visuais. */
function contextFixture(): ContextState {
  return {
    revision: 7, model: 'opencode/glm-5.1', window: { preferredTokens: 65536, effectiveTokens: 65536, origin: 'global', model: 'opencode/glm-5.1', capacity: null },
    measurement: null, phase: 'not_measured', operation: null, eligibility: { enabled: true, reason: null },
    usage: { last: null, main: partialUsage, summary: unknownUsage, total: partialUsage, cost: null },
  };
}

/** Abre o painel pela bola de contexto e devolve o dropdown. */
async function openPanel(page: Page) {
  await page.getByRole('button', { name: /^Contexto:/ }).click();
  return page.getByRole('dialog', { name: 'Contexto', exact: true });
}

/** Cria o bot do cenário (nome exclusivo da repetição) e devolve o id. */
async function createBot(page: Page, name: string, extra: Record<string, unknown> = {}, model = 'opencode/glm-5.1'): Promise<{ id: string }> {
  const headers = await apiHeaders(page);
  const response = await page.request.post(`${ORIGIN}/api/bots`, { headers, data: { name: uniqueBotName(name), model, color: '#60A5FA', ...extra } });
  expect(response.status()).toBe(201);
  return response.json();
}

/** "Compactar agora" exige o modelo validado (o resumo é uma chamada paga): valida pela API o modelo falso, como o dono faria em Configurações. */
async function validateModel(page: Page, model = 'opencode/glm-5.1'): Promise<void> {
  const headers = await apiHeaders(page);
  expect((await page.request.post(`${ORIGIN}/api/models/test`, { headers, data: { model } })).status()).toBe(200);
}

test('abertura abre o painel sem aviso de capacidade, sem criar sessão e preserva composer em desktop/mobile', async ({ page }, testInfo) => {
  await ensureCredential(page, 'provider', 'valid-e2e-context-1111');
  let createdSessions = 0;
  const problems = watchPage(page);
  page.on('request', (request) => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/chat/sessions') createdSessions += 1; });
  await page.route('**/api/chat/settings', (route) => route.fulfill({ json: { model: 'opencode/glm-5.1', effort: null, effortLevels: [] } }));
  await page.goto('/');
  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    const trigger = page.getByRole('button', { name: 'Contexto: Ainda não calculado', exact: true });
    await trigger.click();
    const panel = page.getByRole('dialog', { name: 'Contexto', exact: true });
    // Modelo sem capacidade confirmada (glm-5.1) usa a janela escolhida pelo dono: nenhum aviso de teto provisório.
    await expect(panel.getByText('Ainda não calculado', { exact: true })).toBeVisible();
    await expect(panel.getByText(/provisório|provisoriamente|não confirmada/i)).toHaveCount(0);
    // Abertura não tem conversa: sem inventar execução, consumo, preço ou manutenção.
    await expect(panel.getByRole('heading', { name: /Consumo|Manutenção/ })).toHaveCount(0);
    await expect(panel.getByText(/Custo estimado/)).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Compactar agora', exact: true })).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, `phase8-t4-abertura-${width}`);
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
  }
  await expect(page.getByRole('textbox', { name: 'Pergunte ao Aion', exact: true })).toBeEnabled();
  expect(createdSessions).toBe(0);
  expect(problems).toEqual([]);
});

test('painel mostra "Compactar agora" sem elisão e distingue estimativa, stale, ocupado e resultado incerto com foco e movimento reduzido', async ({ page }, testInfo) => {
  await ensureCredential(page, 'provider', 'valid-e2e-context-1111');
  const bot = await createBot(page, 'Painel contexto T6');
  let state = contextFixture();
  const problems = watchPage(page);
  await page.route(`**/api/bots/${bot.id}/conversation`, async (route) => {
    const original = await route.fetch();
    await route.fulfill({ response: original, json: { ...await original.json(), context: state } });
  });
  await page.route(`**/api/bots/${bot.id}/conversation/context`, (route) => route.fulfill({ json: state }));
  state = { ...state, phase: 'ready', eligibility: ELIGIBLE, measurement: { ...MEASURED, inputTokens: 18000 }, usage: { ...state.usage, last: { runId: '1', main: partialUsage, summary: unknownUsage, total: partialUsage, cost: null } } };
  for (const width of [1280, 390, 360]) {
    await page.setViewportSize({ width, height: width === 1280 ? 800 : 844 });
    await page.goto(`/bots/${bot.id}`);
    const trigger = page.getByRole('button', { name: 'Contexto: ≈ 82%', exact: true });
    await trigger.click();
    const panel = page.getByRole('dialog', { name: 'Contexto', exact: true });
    // Só o percentual de uso da janela; números absolutos saíram por confundirem (o orçamento de entrada é menor que a janela escolhida).
    await expect(panel.getByRole('meter', { name: 'Uso da janela', exact: true })).toHaveAttribute('aria-valuenow', '82');
    await expect(panel.getByText('82% da janela', { exact: true })).toBeVisible();
    await expect(panel.getByText(/18.000|22.000|reserva/)).toHaveCount(0);
    await expect(panel.getByText(/Uso parcial|Custo estimado|Consumo/)).toHaveCount(0);
    // A ação única é textual e habilitada; a elisão e o rótulo "Comprimir:" saíram, junto com os ícones.
    await expect(panel.getByRole('button', { name: 'Compactar agora', exact: true })).toBeEnabled();
    await expect(panel.getByText('Comprimir:')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: /Reduzir resultados|Resumir a conversa/ })).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, `phase9-t6-painel-${width}`);
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
  }
  // Desatualizado com aprovação pendente: o botão fica desabilitado e o motivo aparece na dica (invólucro focável).
  state = { ...state, measurement: { ...state.measurement!, stale: true }, eligibility: { enabled: false, reason: 'Há uma aprovação pendente nesta conversa.' } };
  await page.reload();
  await page.getByRole('button', { name: 'Contexto: Desatualizado', exact: true }).click();
  let panel = page.getByRole('dialog', { name: 'Contexto', exact: true });
  await expect(panel.getByText('Desatualizado desde a última medição.')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Compactar agora', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: 'Compactar agora', exact: true }).locator('..').hover();
  await expect(page.getByRole('tooltip')).toContainText('Há uma aprovação pendente nesta conversa.');
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'phase9-t6-stale-aprovacao-360');
  await page.keyboard.press('Escape');
  // Operação em andamento (outro aparelho): "Compactando…" é o único rótulo, com movimento reduzido na bola.
  state = { ...state, phase: 'summarizing', operation: { requestId: '4a6a54ab-a7a6-40c5-a98b-6fd34c04baf6', mode: 'summarize', status: 'running', cancelable: true, result: null, errorCode: null }, eligibility: { enabled: false, reason: 'Manutenção em andamento em outro aparelho.' } };
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  panel = await openPanel(page);
  await panel.getByRole('status').scrollIntoViewIfNeeded();
  await expect(panel.getByRole('status')).toHaveText('Compactando…');
  await expect(panel.getByRole('button', { name: 'Cancelar compactação', exact: true })).toBeVisible();
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'phase9-t6-compactando-reduced-motion-360');
  await page.keyboard.press('Escape');
  state = { ...state, phase: 'failed', operation: { ...state.operation!, status: 'unknown', cancelable: false, result: { changed: false, beforeInputTokens: null, afterInputTokens: null, summaryUsage: unknownUsage } }, eligibility: { enabled: false, reason: 'Resultado da chamada anterior ainda incerto.' } };
  await page.reload();
  panel = await openPanel(page);
  await panel.getByRole('status').scrollIntoViewIfNeeded();
  await expect(panel.getByRole('status')).toContainText('Resultado incerto');
  await expect(panel.getByRole('button', { name: 'Tentar novamente', exact: true })).toHaveCount(0);
  await attachShot(page, testInfo, 'phase9-t6-resultado-incerto-360');
  expect(problems).toEqual([]);
});

test('gestos enviam revisão/UUID, mostram "Compactando…", cancelamento, falha e sucesso sem repetição automática; operação antiga de elisão é exibida sem erro', async ({ page }, testInfo) => {
  await ensureCredential(page, 'provider', 'valid-e2e-context-1111');
  const bot = await createBot(page, 'Gestos contexto T6');
  let state: ContextState = { ...contextFixture(), phase: 'ready', eligibility: ELIGIBLE, measurement: { ...MEASURED } };
  const requests: { mode: string; expectedRevision: number; requestId: string }[] = [];
  await page.route(`**/api/bots/${bot.id}/conversation`, async (route) => { const original = await route.fetch(); await route.fulfill({ response: original, json: { ...await original.json(), context: state } }); });
  await page.route(`**/api/bots/${bot.id}/conversation/context`, (route) => route.fulfill({ json: state }));
  await page.route(`**/api/bots/${bot.id}/conversation/context/maintenance`, async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    expect(Object.keys(body).sort()).toEqual(['expectedRevision', 'mode', 'requestId']);
    // O único modo que o cliente pede é `summarize` ("Compactar agora"); a revisão vem do estado lido.
    expect(body.mode).toBe('summarize');
    expect(body.expectedRevision).toBe(7);
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    state = { ...state, phase: 'summarizing', operation: { requestId: body.requestId, mode: 'summarize', status: 'running', cancelable: true, result: null, errorCode: null }, eligibility: { enabled: false, reason: 'Manutenção em andamento.' } };
    await route.fulfill({ json: state });
  });
  await page.route(`**/api/bots/${bot.id}/conversation/context/maintenance/*/cancel`, async (route) => {
    expect(route.request().postDataJSON()).toEqual({});
    state = { ...state, phase: 'ready', operation: { ...state.operation!, status: 'cancelled', cancelable: false }, eligibility: ELIGIBLE };
    await route.fulfill({ json: state });
  });
  const problems = watchPage(page);
  await page.goto(`/bots/${bot.id}`);
  let panel = await openPanel(page);
  expect(requests).toHaveLength(0);
  const compact = () => panel.getByRole('button', { name: 'Compactar agora', exact: true });
  // Habilitado, o botão explica o que faz e que custa tokens.
  await expect(compact()).toBeEnabled();
  await compact().locator('..').hover();
  await expect(page.getByRole('tooltip')).toContainText('consome tokens');
  await page.mouse.move(0, 0);
  await compact().click();
  await expect(panel.getByRole('status')).toHaveText('Compactando…');
  await expect(compact()).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Cancelar compactação', exact: true })).toBeVisible();
  expect(requests).toHaveLength(1);
  // Prova visual (design): botão, "Compactando…" com loader na bola e cancelar, em 1280 e 390 px.
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 1280 ? 800 : 844 });
    await panel.getByRole('status').scrollIntoViewIfNeeded();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, `phase9-t6-compactando-${width}`);
  }
  await panel.getByRole('button', { name: 'Cancelar compactação', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Compactação cancelada.');
  expect(requests).toHaveLength(1);
  await page.keyboard.press('Escape');
  // Falha: o motivo seguro vem do código gravado, e a nova tentativa é um clique deliberado (nunca repetição automática).
  state = { ...state, phase: 'failed', operation: { ...state.operation!, status: 'failed', errorCode: 'CONTEXT_COMPACTION_FAILED', result: { changed: false, beforeInputTokens: 19000, afterInputTokens: 19000, summaryUsage: partialUsage } }, eligibility: ELIGIBLE };
  await page.reload();
  panel = await openPanel(page);
  await expect(panel.getByRole('status')).toHaveText('O modelo não devolveu um resumo utilizável. Nada foi alterado; tente de novo.');
  expect(requests).toHaveLength(1);
  await compact().click();
  expect(requests).toHaveLength(2);
  expect(requests[0]!.requestId).not.toBe(requests[1]!.requestId);
  await page.keyboard.press('Escape');
  // Sucesso: antes e depois em percentual da janela (o orçamento é 22.000).
  state = { ...state, phase: 'ready', operation: { ...state.operation!, status: 'completed', cancelable: false, errorCode: null, result: { changed: true, beforeInputTokens: 19000, afterInputTokens: 14000, summaryUsage: partialUsage } }, eligibility: ELIGIBLE };
  await page.reload();
  panel = await openPanel(page);
  await panel.getByRole('status').scrollIntoViewIfNeeded();
  await expect(panel.getByRole('status')).toHaveText('Compactado: 86% → 64% da janela.');
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'phase9-t6-compactado-fixture-390');
  expect(requests).toHaveLength(2);
  await page.keyboard.press('Escape');
  state = { ...state, operation: { ...state.operation!, result: { changed: true, beforeInputTokens: 19000, afterInputTokens: 21000, summaryUsage: partialUsage } } };
  await page.reload();
  panel = await openPanel(page);
  await panel.getByRole('status').scrollIntoViewIfNeeded();
  await expect(panel.getByRole('status')).toHaveText('Resumo salvo, sem redução de espaço.');
  await page.keyboard.press('Escape');
  // Operação gravada pela elisão antiga: o desfecho aparece pelo texto genérico, sem erro, e o botão segue habilitado (a elisão não pode mais ser pedida).
  state = { ...state, operation: { requestId: randomUUID(), mode: 'elision', status: 'completed', cancelable: false, result: { changed: false, beforeInputTokens: null, afterInputTokens: null, summaryUsage: null }, errorCode: null } };
  await page.reload();
  panel = await openPanel(page);
  await expect(panel.getByRole('status')).toHaveText('Nada a compactar.');
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(compact()).toBeEnabled();
  await page.keyboard.press('Escape');
  state = { ...state, phase: 'failed', operation: { ...state.operation!, status: 'failed', errorCode: 'CONTEXT_COMPACTION_FAILED' } };
  await page.reload();
  panel = await openPanel(page);
  await expect(panel.getByRole('status')).toHaveText('Não foi possível compactar.');
  await expect(panel.getByRole('alert')).toHaveCount(0);
  expect(requests).toHaveLength(2);
  expect(problems).toEqual([]);
});

test('aviso da compactação automática é discreto: só conversa resumida e trecho em índice, na bola e no painel, sem mensagem nem cartão', async ({ page }, testInfo) => {
  await ensureCredential(page, 'provider', 'valid-e2e-context-1111');
  const bot = await createBot(page, 'Aviso automático T6');
  const compaction = (summary: boolean, index: boolean) => ({ elision: false, summary, index });
  let state: ContextState = { ...contextFixture(), phase: 'ready', eligibility: ELIGIBLE, measurement: { ...MEASURED, inputTokens: 15840, compaction: compaction(true, false) } };
  await page.route(`**/api/bots/${bot.id}/conversation`, async (route) => { const original = await route.fetch(); await route.fulfill({ response: original, json: { ...await original.json(), context: state } }); });
  await page.route(`**/api/bots/${bot.id}/conversation/context`, (route) => route.fulfill({ json: state }));
  const problems = watchPage(page);
  await page.goto(`/bots/${bot.id}`);
  // 15.840 de 22.000 = 72%; o rótulo da bola acrescenta "compactado" e o painel diz o que mudou.
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 1280 ? 800 : 844 });
    const trigger = page.getByRole('button', { name: 'Contexto: ≈ 72% · compactado', exact: true });
    await trigger.click();
    const panel = page.getByRole('dialog', { name: 'Contexto', exact: true });
    await expect(panel.getByText('Contexto compactado automaticamente: conversa antiga resumida.', { exact: true })).toBeVisible();
    await expect(panel.getByText(/resultados antigos reduzidos/)).toHaveCount(0);
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, `phase9-t6-aviso-automatico-${width}`);
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
  }
  // Com o colapso de último recurso, os dois estados aparecem juntos; a elisão (campo morto do contrato) nunca acende o aviso.
  state = { ...state, measurement: { ...state.measurement!, compaction: compaction(true, true) } };
  await page.reload();
  let panel = await openPanel(page);
  await expect(panel.getByText('Contexto compactado automaticamente: conversa antiga resumida, trecho mais antigo em índice.', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  state = { ...state, measurement: { ...state.measurement!, compaction: { elision: true, summary: false, index: false } } };
  await page.reload();
  panel = await openPanel(page);
  await expect(panel.getByText(/automaticamente/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Contexto: ≈ 72%', exact: true })).toBeVisible();
  expect(problems).toEqual([]);
});

test('compactar sem histórico ou sem modelo validado fica desabilitado com o motivo, e a API recusa a elisão com VALIDATION_FAILED', async ({ page }, testInfo) => {
  await ensureCredential(page, 'provider', 'valid-e2e-context-1111');
  const headers = await apiHeaders(page);
  // Modelo falso permitido mas nunca validado pelas suites anteriores: sem perfil, a compactação (chamada paga) não é oferecida.
  const unvalidated = await createBot(page, 'Sem perfil T6', {}, 'opencode/slow-model');
  const base = (id: string) => `${ORIGIN}/api/bots/${id}/conversation`;
  const first = await (await page.request.get(`${base(unvalidated.id)}/context`, { headers })).json() as ContextState;
  expect(first.eligibility).toMatchObject({ enabled: true, summarizeEnabled: false });
  expect(first.eligibility.summarizeReason).toContain('Valide o modelo em Configurações antes de compactar.');
  await page.goto(`/bots/${unvalidated.id}`);
  let panel = await openPanel(page);
  await expect(panel.getByRole('button', { name: 'Compactar agora', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: 'Compactar agora', exact: true }).locator('..').hover();
  await expect(page.getByRole('tooltip')).toContainText('Valide o modelo em Configurações antes de compactar.');
  await page.keyboard.press('Escape');

  // Modelo validado e conversa nova: nada a cobrir, com o motivo certo.
  await validateModel(page);
  const empty = await createBot(page, 'Sem histórico T6');
  const problems = watchPage(page);
  const state = await (await page.request.get(`${base(empty.id)}/context`, { headers })).json() as ContextState;
  expect(state.eligibility).toMatchObject({ enabled: true, summarizeEnabled: false, summarizeReason: 'Ainda não há histórico antigo para compactar.' });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 1280 ? 800 : 844 });
    await page.goto(`/bots/${empty.id}`);
    panel = await openPanel(page);
    await expect(panel.getByRole('button', { name: 'Compactar agora', exact: true })).toBeDisabled();
    await panel.getByRole('button', { name: 'Compactar agora', exact: true }).locator('..').hover();
    await expect(page.getByRole('tooltip')).toContainText('Ainda não há histórico antigo para compactar.');
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, `phase9-t6-sem-historico-${width}`);
    await page.keyboard.press('Escape');
  }
  // A API não aceita mais a elisão manual: erro de validação no envelope padrão, nada na fila e nenhum detalhe interno.
  const refused = await page.request.post(`${base(empty.id)}/context/maintenance`, { headers, data: { requestId: randomUUID(), expectedRevision: state.revision, mode: 'elision' } });
  expect(refused.status()).toBe(422);
  expect(await refused.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  expect((await (await page.request.get(`${base(empty.id)}/context`, { headers })).json() as ContextState).operation).toBeNull();
  expect(problems).toEqual([]);
});

test('logo depois de uma resposta o indicador não fica "Desatualizado"; conteúdo que chega durante a resposta o marca, e a conclusão o limpa', async ({ page }, testInfo) => {
  await ensureCredential(page, 'provider', 'valid-e2e-context-1111');
  const headers = await apiHeaders(page);
  await validateModel(page);
  const bot = await createBot(page, 'Medição T6');
  const base = `${ORIGIN}/api/bots/${bot.id}/conversation`;
  const contextOf = async () => (await (await page.request.get(`${base}/context`, { headers })).json()) as ContextState;
  const send = async (content: string) => expect((await page.request.post(`${ORIGIN}/api/bots/${bot.id}/messages`, { headers, data: { content } })).status()).toBe(201);
  const idle = async () => expect.poll(async () => (await (await page.request.get(base, { headers })).json()).runs.length, { timeout: 30_000 }).toBe(0);
  await send('Primeira mensagem do cenário de medição.');
  await idle();
  // Logo após a resposta: medição real do provedor (ou a da preparação, se o provedor falso não informa usage plausível), sem "Desatualizado".
  const settled = await contextOf();
  expect(settled.measurement).not.toBeNull();
  expect(settled.measurement!.stale).toBe(false);
  await page.goto(`/bots/${bot.id}`);
  const trigger = page.getByRole('button', { name: /^Contexto:/ });
  await expect(trigger).toHaveAccessibleName(/^Contexto: ≈ \d+%$/);
  // Uma resposta lenta (8 pedaços em 2 s) grava texto novo depois da medição da preparação: enquanto ela escreve, a medição está desatualizada.
  await send('[lento] Segunda mensagem, com resposta lenta.');
  await expect.poll(async () => (await contextOf()).measurement?.stale, { timeout: 10_000, intervals: [100] }).toBe(true);
  await idle();
  // Concluída a chamada, a medição é fechada: não há "Desatualizado" por causa da própria resposta.
  await expect.poll(async () => (await contextOf()).measurement?.stale, { timeout: 10_000 }).toBe(false);
  await page.reload();
  const panel = await openPanel(page);
  await expect(panel.getByText('Desatualizado desde a última medição.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Contexto: Desatualizado/ })).toHaveCount(0);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'phase9-t6-bot-apos-resposta-1280');
});

test('Chat geral: sem "Desatualizado" logo depois da resposta, com ele quando texto novo chega depois da medição e sem ele de novo na resposta seguinte', async ({ page }, testInfo) => {
  await ensureCredential(page, 'provider', 'valid-e2e-context-1111');
  const headers = await apiHeaders(page);
  await validateModel(page);
  const problems = watchPage(page);
  const created = await page.request.post(`${ORIGIN}/api/chat/sessions`, { headers });
  expect(created.status()).toBe(201);
  const session = await created.json() as { id: string };
  expect((await page.request.patch(`${ORIGIN}/api/chat/sessions/${session.id}/conversation`, { headers, data: { model: 'opencode/glm-5.1', effort: null } })).status()).toBe(200);
  const base = `${ORIGIN}/api/chat/sessions/${session.id}/conversation`;
  const contextOf = async () => (await (await page.request.get(`${base}/context`, { headers })).json()) as ContextState;
  const send = async (content: string) => expect((await page.request.post(`${ORIGIN}/api/chat/sessions/${session.id}/messages`, { headers, data: { content } })).status()).toBe(201);
  const idle = async () => expect.poll(async () => (await (await page.request.get(base, { headers })).json()).runs.length, { timeout: 30_000 }).toBe(0);
  await send('Primeira pergunta do Chat geral.');
  await idle();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/chat/${session.id}`);
  await expect(page.getByRole('log', { name: 'Conversa' })).toContainText('Resposta: Primeira pergunta do Chat geral.');
  const trigger = page.getByRole('button', { name: /^Contexto:/ });
  await expect(trigger).toHaveAccessibleName(/^Contexto: ≈ \d+%$/);
  const panel = await openPanel(page);
  await expect(panel.getByRole('meter', { name: 'Uso da janela', exact: true })).toBeVisible();
  await expect(panel.getByText('Desatualizado desde a última medição.')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Compactar agora', exact: true })).toBeVisible();
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'phase9-t6-chat-apos-resposta-1280');
  await page.keyboard.press('Escape');
  // Nova mensagem do dono. Em tempo real o estado desatualizado só dura enquanto o texto novo chega depois da medição da preparação (a linha da mensagem nasce quando
  // o worker a reivindica, e a preparação mede logo em seguida), então o cenário usa a resposta que não termina ([demorar]): o texto em escrita muda a revisão e o
  // estado fica estável o tempo que o teste precisar, sem depender de janela de tempo.
  await send('[demorar] Segunda pergunta, com resposta que não termina.');
  await expect.poll(async () => (await contextOf()).measurement?.stale, { timeout: 15_000 }).toBe(true);
  // O indicador relê o estado ao abrir (não há evento de contexto enquanto a resposta escreve): agora a bola e o painel acusam "Desatualizado".
  const stalePanel = await openPanel(page);
  await expect(page.getByRole('button', { name: 'Contexto: Desatualizado', exact: true })).toBeVisible();
  await expect(stalePanel.getByText('Desatualizado desde a última medição.')).toBeVisible();
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'phase9-t6-chat-desatualizado-1280');
  await page.keyboard.press('Escape');
  // Para a resposta que não termina e envia uma nova: a preparação mede de novo e o fim da chamada fecha a medição, então o indicador volta ao percentual sem "Desatualizado".
  await page.getByRole('button', { name: 'Parar execução' }).click();
  await idle();
  await send('Terceira pergunta do Chat geral.');
  await idle();
  await expect(page.getByRole('log', { name: 'Conversa' })).toContainText('Resposta: Terceira pergunta do Chat geral.');
  await expect(trigger).toHaveAccessibleName(/^Contexto: ≈ \d+%$/);
  expect((await contextOf()).measurement!.stale).toBe(false);
  const settledPanel = await openPanel(page);
  await expect(settledPanel.getByText('Desatualizado desde a última medição.')).toHaveCount(0);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'phase9-t6-chat-nova-resposta-1280');
  expect(problems).toEqual([]);
});

test('trocar a janela do bot recalcula o percentual sobre o orçamento novo, sem "Desatualizado" e sem chamar o modelo; mensagem nova volta a marcar', async ({ page }, testInfo) => {
  await ensureCredential(page, 'provider', 'valid-e2e-context-1111');
  const headers = await apiHeaders(page);
  await validateModel(page);
  // Janela explícita no bot (64k), para não depender do padrão global; a troca para 128k é a edição que o dono faz no bot (grava a janela e o carimbo do bot juntos).
  const bot = await createBot(page, 'Janela T11', { contextWindowTokens: 65536 });
  const base = `${ORIGIN}/api/bots/${bot.id}/conversation`;
  const contextOf = async () => (await (await page.request.get(`${base}/context`, { headers })).json()) as ContextState;
  const send = async (content: string) => expect((await page.request.post(`${ORIGIN}/api/bots/${bot.id}/messages`, { headers, data: { content } })).status()).toBe(201);
  const idle = async () => expect.poll(async () => (await (await page.request.get(base, { headers })).json()).runs.length, { timeout: 30_000 }).toBe(0);
  const problems = watchPage(page);
  // O primeiro acesso à página de um bot novo grava o cartão de convite do objetivo (conteúdo novo da conversa). Abre a página ANTES da primeira mensagem, para a
  // medição ser posterior a ele e o cenário partir de uma medição atualizada.
  await page.setViewportSize({ width: 1280, height: 800 });
  const invitation = page.waitForResponse((response) => response.url().endsWith(`/api/bots/${bot.id}/objective/invitation`));
  await page.goto(`/bots/${bot.id}`);
  await invitation;
  await send('Mensagem do cenário de troca de janela.');
  await idle();
  const before = await contextOf();
  const measured = before.measurement!;
  expect(measured.stale).toBe(false);
  expect(measured.inputBudget + measured.outputReserve + measured.margin).toBe(65536);
  // A reserva de saída é função da janela (phase 12): 25% dela, até 32.768. Em 64k é 16.384 (entrada de 47.104) e em 128k é 32.768 (entrada de 96.256), então o orçamento da janela nova
  // NÃO reaproveita a reserva da medição de 64k: vem da regra, escrita à mão aqui (e não calculada a partir da medição) para o teste reprovar uma regra trocada.
  expect(measured).toMatchObject({ outputReserve: 16384, inputBudget: 47104 });
  const percentOn = (budget: number) => Math.round((measured.inputTokens / budget) * 100);
  const wide = 131072 - 32768 - measured.margin;
  expect(wide).toBe(96256);
  // Premissa: a mesma medição dá percentuais diferentes nas duas janelas, senão o cenário não distinguiria o orçamento antigo do novo.
  expect(percentOn(measured.inputBudget)).not.toBe(percentOn(wide));
  const meter = (panel: Locator) => panel.getByRole('meter', { name: 'Uso da janela', exact: true });
  let panel = await openPanel(page);
  await expect(meter(panel)).toHaveAttribute('aria-valuenow', String(percentOn(measured.inputBudget)));
  await page.keyboard.press('Escape');

  // O dono sobe a janela do bot para 128k. Ler o estado não chama o modelo: o servidor devolve os mesmos tokens medidos sobre o orçamento da janela vigente.
  expect((await page.request.patch(`${ORIGIN}/api/bots/${bot.id}`, { headers, data: { contextWindowTokens: 131072 } })).status()).toBe(200);
  const after = await contextOf();
  expect(after.measurement).toMatchObject({ stale: false, inputTokens: measured.inputTokens, measuredAt: measured.measuredAt, inputBudget: wide, outputReserve: 32768 });
  expect(after.usage.total.calls).toBe(before.usage.total.calls);
  // O painel relê o estado ao abrir: o medidor e o texto passam a ser sobre os 128k, sem nenhuma marca de desatualizado.
  panel = await openPanel(page);
  const recalculated = percentOn(wide);
  await expect(meter(panel)).toHaveAttribute('aria-valuenow', String(recalculated));
  await expect(panel.getByText(`${recalculated}% da janela`, { exact: true })).toBeVisible();
  await expect(panel.getByText('Desatualizado desde a última medição.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Contexto: ≈ ${recalculated}%`, exact: true })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'phase9-t11-painel-janela-nova-1280');
  await page.keyboard.press('Escape');

  // Mensagem nova depois da troca: o conteúdo mudou, então o indicador volta a marcar "Desatualizado" enquanto o texto novo chega depois da medição da preparação.
  await send('[lento] Mensagem nova depois da troca de janela.');
  await expect.poll(async () => (await contextOf()).measurement?.stale, { timeout: 10_000, intervals: [100] }).toBe(true);
  panel = await openPanel(page);
  await expect(panel.getByText('Desatualizado desde a última medição.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Contexto: Desatualizado', exact: true })).toBeVisible();
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'phase9-t11-mensagem-nova-desatualizado-1280');
  await page.keyboard.press('Escape');
  // Concluída a resposta, a medição seguinte já é da janela nova (a preparação mede sobre ela), sem "Desatualizado".
  await idle();
  await expect.poll(async () => (await contextOf()).measurement?.stale, { timeout: 10_000 }).toBe(false);
  expect((await contextOf()).measurement!.inputBudget).toBe(wide);
  await page.reload();
  panel = await openPanel(page);
  await expect(panel.getByText('Desatualizado desde a última medição.')).toHaveCount(0);
  await expect(meter(panel)).toBeVisible();
  expect(problems).toEqual([]);
});

test('compactar agora de ponta a ponta: "Compactando…", antes e depois em % da janela, originais preservados e o outro aparelho sincronizado', async ({ page, browser }, testInfo) => {
  await ensureCredential(page, 'provider', 'valid-e2e-context-1111');
  const headers = await apiHeaders(page);
  // Premissa do cenário: o "Compactar agora" só tem o que cobrir se NENHUMA compactação automática tirou o histórico antigo antes do gesto e se esse histórico passa do
  // trecho final (até 25% do orçamento de entrada que sobra depois do piso). A pilha do E2E publica sempre a lista fixa do bot (as portas e as mais usadas, phase 15) e o modelo falso não calibra (o usage fixo de
  // 100 tokens é descartado como implausível), então o piso pesa ~25 mil bytes (eram ~35 mil com as 13 core). Em 128k a ocupação fica abaixo do gatilho automático de 90% e as rodadas mais antigas
  // ficam fora do trecho final, elegíveis só ao gesto manual. Janela explícita no bot, para não depender do padrão global.
  const bot = await createBot(page, 'Compactar real T6', { contextWindowTokens: 131072 });
  const base = `${ORIGIN}/api/bots/${bot.id}/conversation`;
  const tableResponse = await page.request.post(`${ORIGIN}/api/bots/${bot.id}/tables`, { headers, data: { operationId: randomUUID(), name: 'Evidência sintética T6', columns: [{ name: 'Descrição', type: 'text' }] } });
  expect(tableResponse.status()).toBe(201);
  const table = await tableResponse.json() as DataTable;
  const original = 'Registro sintético demonstrativo. '.repeat(90);
  expect((await page.request.post(`${ORIGIN}/api/tables/${table.id}/records`, { headers, data: { operationId: randomUUID(), expectedSchemaVersion: table.schemaVersion, creates: [{ values: { [table.columns[0]!.id]: original } }] } })).status()).toBe(200);
  /** Envio e conclusão reais, sem seed SQL; o marcador só determina a resposta do provedor falso. */
  async function sendAndWait(content: string) {
    expect((await page.request.post(`${ORIGIN}/api/bots/${bot.id}/messages`, { headers, data: { content } })).status()).toBe(201);
    await expect.poll(async () => (await (await page.request.get(base, { headers })).json()).runs.length, { timeout: 30_000 }).toBe(0);
  }
  // Nove rodadas completas (~4 mil bytes cada) e uma de fechamento: as mais antigas passam do trecho final e viram o lote da compactação.
  for (let round = 0; round < 9; round++) await sendAndWait(tableMarker('table_query', { tableId: table.id, query: {} }));
  await sendAndWait('Mantenha a evidência disponível para consulta. Este pedido sintético não requer nova ferramenta.');
  const before = await (await page.request.get(base, { headers })).json() as ConversationSnapshot;
  expect(before.items.some((item) => item.kind === 'activity' && item.tool === 'table_query' && item.status === 'completed')).toBe(true);
  // Guarda da premissa: nenhuma compactação automática (resumo ou índice) tocou o histórico antes do gesto manual, e o indicador está medido e atualizado.
  expect(before.context!.measurement!.compaction).toEqual({ elision: false, summary: false, index: false });
  expect(before.context!.measurement!.stale).toBe(false);
  expect(before.context!.eligibility).toMatchObject({ summarizeEnabled: true, summarizeReason: null });

  const otherContext = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 390, height: 844 } });
  try {
    await apiLogin(otherContext);
    const other = await otherContext.newPage();
    const problems = watchPage(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await Promise.all([page.goto(`/bots/${bot.id}`), other.goto(`/bots/${bot.id}`)]);
    const panel = await openPanel(page);
    const otherPanel = await openPanel(other);
    await panel.getByRole('button', { name: 'Compactar agora', exact: true }).click();
    // A operação real termina em milissegundos: "Compactando…" pode já ter passado quando o teste olha, então aceita os dois textos e o desfecho é estrito logo depois.
    await expect(panel.getByRole('status')).toHaveText(/^(Compactando…|Compactado: \d+% → \d+% da janela\.)$/);
    try {
      await expect(panel.getByRole('status')).toHaveText(/^Compactado: \d+% → \d+% da janela\.$/);
      await expect(otherPanel.getByRole('status')).toHaveText(/^Compactado: \d+% → \d+% da janela\.$/);
    } catch (failure) {
      // Diagnóstico mínimo da borda: inclui somente a operação pública, nunca sessão, headers ou conteúdo da conversa.
      const current = await (await page.request.get(`${base}/context`, { headers })).json() as ContextState;
      await testInfo.attach('estado-publico-manutencao', { body: JSON.stringify(current.operation), contentType: 'application/json' });
      throw failure;
    }
    const after = await (await page.request.get(base, { headers })).json() as ConversationSnapshot;
    // Compactar é projeção e ponteiro: nenhuma linha da conversa muda e nenhuma mensagem nova nasce; só o resumo custa uma chamada (modo `summarize`).
    expect(after.items).toEqual(before.items);
    expect(after.context!.operation!.mode).toBe('summarize');
    expect(after.context!.operation!.result!.changed).toBe(true);
    expect(after.context!.operation!.result!.afterInputTokens!).toBeLessThan(after.context!.operation!.result!.beforeInputTokens!);
    expect(after.context!.usage.summary.calls).toBe(before.context!.usage.summary.calls + 1);
    expect(after.context!.measurement!.compaction).toEqual({ elision: false, summary: false, index: false });
    const records = await (await page.request.post(`${ORIGIN}/api/tables/${table.id}/query`, { headers, data: {} })).json();
    expect(records.records[0].values[table.columns[0]!.id]).toBe(original);
    await panel.getByRole('status').scrollIntoViewIfNeeded();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, 'phase9-t6-compactado-real-1280');
    await otherPanel.getByRole('status').scrollIntoViewIfNeeded();
    await expectNoHorizontalScroll(other);
    await expectNoA11yViolations(other);
    await attachShot(other, testInfo, 'phase9-t6-compactado-real-390');
    // Segundo clique sem histórico novo: o servidor responde "Nada a compactar." e a conversa continua intacta.
    await panel.getByRole('button', { name: 'Compactar agora', exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText(/^(Compactando…|Nada a compactar\.)$/);
    await expect(panel.getByRole('status')).toHaveText('Nada a compactar.');
    const again = await (await page.request.get(base, { headers })).json() as ConversationSnapshot;
    expect(again.items).toEqual(before.items);
    expect(again.context!.usage.summary.calls).toBe(after.context!.usage.summary.calls);
    expect(problems).toEqual([]);
  } finally { await otherContext.close(); }
});

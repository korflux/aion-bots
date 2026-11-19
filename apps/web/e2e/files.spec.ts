// Gestão de anexos contra API/worker reais; interceptações ficam restritas a estados transitórios e erros de rede.
import type { Page } from '@playwright/test';
import { attachmentPageSchema, modelEntrySchema, type AttachmentPage } from '@aion/shared';
import { JPEG_FIXTURE, pdfFixture } from '../../../packages/core/src/testing/attachment-fixtures';
import { apiHeaders, attachShot, botActionEntry, ensureCredential, expect, expectNoA11yViolations, expectNoHorizontalScroll, openBotAction, ORIGIN, test, uniqueBotName } from './support/fixtures';
test.describe.configure({ mode: 'serial' });
/** Captura persistente das duas larguras com axe e inspeção de overflow em cada estado. */
async function evidence(page: Page, state: string) {
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    await expectNoHorizontalScroll(page); await expectNoA11yViolations(page);
    await attachShot(page, test.info(), `${state}-${width}`);
  }
}
/** Evidência contextual registra rota, estado e viewport junto da captura, com axe e overflow verificados. */
async function botEvidence(page: Page, state: string) {
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    await expectNoHorizontalScroll(page); await expectNoA11yViolations(page);
    const name = `${state}-${width}`;
    await attachShot(page, test.info(), name);
    await test.info().attach(`${name}-estado`, { body: JSON.stringify({ route: page.url(), viewport: page.viewportSize(), state, axe: 'zero violações', overflow: 'ausente' }, null, 2), contentType: 'application/json' });
  }
}
/** Consulta do contrato público para aguardar o worker sem seed direto no banco. */
async function listed(page: Page, headers: Record<string, string>, query = ''): Promise<AttachmentPage> { return (await page.context().request.get(`${ORIGIN}/api/attachments${query}`, { headers })).json(); }

test('lista origens reais, pagina cinquenta, abre, baixa, exclui e conserva mensagem original', async ({ page }) => {
  test.setTimeout(240_000);
  await ensureCredential(page, 'provider', 'valid-e2e-files-1111');
  const headers = await apiHeaders(page); const request = page.context().request;
  // A jornada isolada também passa pela prova pública de visão, sem depender do cache deixado pelo predecessor.
  const vision = await request.post(`${ORIGIN}/api/models/verify-image`, { headers, data: { model: 'opencode/vision-model' } }); expect(vision.status()).toBe(200); modelEntrySchema.parse(await vision.json());
  /** Bot público como o dono criaria na interface. */
  async function bot(name: string) { const response = await request.post(`${ORIGIN}/api/bots`, { headers, data: { name: uniqueBotName(name), color: '#60A5FA', instructions: '', model: 'opencode/vision-model', effort: null, stepLimit: 25 } }); expect(response.status()).toBe(201); return (await response.json()).id as string; }
  const id = await bot('Arquivos Alfa'); const archived = await bot('Arquivos Beta');
  /** Upload e envio pelo contrato real; no máximo cinco anexos por rodada. */
  async function attach(base: string, name: string, bytes: Buffer) {
    const upload = () => request.post(`${ORIGIN}${base}/attachments`, { headers: { ...headers, 'content-type': 'application/octet-stream', 'x-attachment-name': encodeURIComponent(name) }, data: bytes });
    let response = await upload();
    // O setup atravessa o rate limit público: respeita a espera real sem mudar a proteção ou substituir uploads.
    while (response.status() === 429) { const seconds = Number(response.headers()['retry-after']); expect(seconds).toBeGreaterThan(0); await page.waitForTimeout(seconds * 1000); response = await upload(); }
    expect(response.status(), await response.text()).toBe(201); return (await response.json()).id as string;
  }
  /** Envio preserva a associação original entre mensagem e referências dos arquivos. */
  async function send(base: string, ids: string[], content = 'Arquivos da jornada') { const response = await request.post(`${ORIGIN}${base}/messages`, { headers, data: { content, attachmentIds: ids } }); expect(response.status(), await response.text()).toBe(201); }
  // Mais de uma página real; as origens visuais entram depois para aparecerem juntas no topo da lista.
  for (let start = 0; start < 50; start += 5) { const ids: string[] = []; for (let index = start; index < start + 5; index++) ids.push(await attach(`/api/bots/${id}`, `pagina-${index}.txt`, Buffer.from(`Documento ${index}`))); await send(`/api/bots/${id}`, ids); }
  const first = await attach(`/api/bots/${id}`, 'imagem.jpg', JPEG_FIXTURE); const doc = await attach(`/api/bots/${id}`, 'documento.pdf', pdfFixture('Conteudo da jornada Arquivos'));
  await send(`/api/bots/${id}`, [first, doc]);
  const old = await attach(`/api/bots/${archived}`, 'arquivado.txt', Buffer.from('Origem arquivada')); await send(`/api/bots/${archived}`, [old]);
  await expect.poll(async () => (await listed(page, headers, `?botId=${archived}`)).items.every((file) => !file.inUse)).toBe(true);
  expect((await request.post(`${ORIGIN}/api/bots/${archived}/archive`, { headers })).status()).toBe(200);
  const session = (await (await request.post(`${ORIGIN}/api/chat/sessions`, { headers })).json()).id;
  expect((await request.patch(`${ORIGIN}/api/chat/sessions/${session}/conversation`, { headers, data: { model: 'opencode/vision-model', effort: null } })).status()).toBe(200);
  const chat = await attach(`/api/chat/sessions/${session}`, 'chat.txt', Buffer.from('Chat geral')); await send(`/api/chat/sessions/${session}`, [chat], 'Sessao arquivos');
  await expect.poll(async () => (await listed(page, headers, `?botId=${id}`)).items.some((file) => file.inUse), { timeout: 60_000 }).toBe(false);
  // A entrada no cabeçalho e a recarga mantêm o escopo desde a primeira consulta; nenhuma página de outro dono aparece.
  const scopedQueries: URLSearchParams[] = [];
  const recordScope = (response: import('@playwright/test').Response) => { if (/\/api\/attachments\?/.test(response.url())) scopedQueries.push(new URL(response.url()).searchParams); };
  page.on('response', recordScope);
  await page.goto(`/bots/${id}`); await page.getByRole('link', { name: 'Arquivos do bot', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: `Arquivos de ${uniqueBotName('Arquivos Alfa')}`, exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Origem' })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Arquivos anexados' }).locator(':scope > li')).toHaveCount(50);
  await expect(page.getByText('Armazenamento global do Aion', { exact: false })).toBeVisible();
  await botEvidence(page, 'bot-lista');
  await page.getByRole('button', { name: 'Carregar mais' }).click(); await expect(page.getByRole('list', { name: 'Arquivos anexados' }).locator(':scope > li')).toHaveCount(52);
  await expect(page.getByRole('checkbox', { name: 'Selecionar chat.txt' })).toHaveCount(0); await expect(page.getByRole('checkbox', { name: 'Selecionar arquivado.txt' })).toHaveCount(0);
  await page.getByRole('radio', { name: 'Imagens', exact: true }).click(); await expect(page.getByRole('list', { name: 'Arquivos anexados' }).locator(':scope > li')).toHaveCount(1);
  await page.reload(); await expect(page.getByRole('list', { name: 'Arquivos anexados' }).locator(':scope > li')).toHaveCount(50);
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(page.getByRole('button', { name: 'Carregar mais' })).toBeEnabled();
  expect(scopedQueries.length).toBeGreaterThan(3); expect(scopedQueries.every((query) => query.get('origin') === 'bot' && query.get('botId') === id)).toBe(true);
  page.off('response', recordScope);
  await page.getByRole('link', { name: 'Voltar à conversa' }).click(); await openBotAction(page, 'editar'); await page.getByRole('link', { name: 'Abrir arquivos do bot' }).click();
  await expect(page.getByRole('heading', { name: `Arquivos de ${uniqueBotName('Arquivos Alfa')}`, exact: true })).toBeVisible();
  await page.goto(`/bots/${archived}/arquivos`); await expect(page.getByText('Bot arquivado', { exact: true })).toBeVisible();
  await page.getByRole('radio', { name: 'Imagens', exact: true }).focus(); await page.keyboard.press('Enter'); await expect(page.getByText('Nenhum arquivo com esses filtros.', { exact: true })).toBeVisible();
  await botEvidence(page, 'bot-arquivado-filtro-vazio');
  await page.getByRole('button', { name: 'Limpar filtros' }).click(); await expect(page.getByRole('checkbox', { name: 'Selecionar arquivado.txt' })).toBeVisible(); await expect(page.getByRole('checkbox', { name: 'Selecionar chat.txt' })).toHaveCount(0);
  await botEvidence(page, 'bot-arquivado-lista');
  // A interceptação começa antes da miniatura: no-store na fixture impede reutilização dos bytes da tentativa anterior.
  let imageMode = 'ready'; let imageRelease!: () => void; let imageHeld = Promise.resolve();
  await page.route(`**/api/attachments/${first}/content`, async (route) => { if (imageMode === 'failed') await route.abort('failed'); else { await imageHeld; await route.fulfill({ status: 200, contentType: 'image/jpeg', headers: { 'cache-control': 'no-store' }, body: JPEG_FIXTURE }); } });
  await page.goto('/configuracoes/arquivos'); await expect(page.getByRole('heading', { name: 'Arquivos', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: `${uniqueBotName('Arquivos Beta')} (arquivado)` })).toHaveCount(1);
  await evidence(page, 'lista');
  await page.getByRole('combobox', { name: 'Origem' }).selectOption(id);
  await expect(page.getByRole('list', { name: 'Arquivos anexados' }).locator(':scope > li')).toHaveCount(50);
  const globalCount = (await listed(page, headers)).count; await expect(page.getByText(`${globalCount} arquivos`, { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Selecionar todos os arquivos carregados' }).check(); await expect(page.getByRole('status').filter({ hasText: '50 selecionados' })).toBeVisible(); await evidence(page, 'selecao-todos');
  await page.getByRole('button', { name: 'Carregar mais' }).click(); await expect(page.getByRole('list', { name: 'Arquivos anexados' }).locator(':scope > li')).toHaveCount(52);
  await page.getByRole('button', { name: 'Limpar seleção' }).click();
  await page.getByRole('radio', { name: 'Imagens', exact: true }).click(); await expect(page.getByRole('list', { name: 'Arquivos anexados' }).locator(':scope > li')).toHaveCount(1);
  const thumb = page.getByRole('button', { name: 'Abrir imagem imagem.jpg' }); await thumb.click(); await expect(page.getByRole('dialog', { name: 'imagem.jpg' })).toBeVisible(); await evidence(page, 'imagem-modal');
  await page.keyboard.press('Tab'); await expect(page.getByRole('dialog')).toContainText('imagem.jpg'); await page.keyboard.press('Escape'); await expect(thumb).toBeFocused();
  const imageName = page.getByRole('button', { name: 'imagem.jpg', exact: true }); await imageName.click(); await expect(page.getByRole('dialog')).toBeVisible(); await page.keyboard.press('Escape'); await expect(imageName).toBeFocused();
  const imageMenu = page.getByRole('button', { name: 'Mais ações de imagem.jpg' }); await imageMenu.click(); await page.getByRole('menuitem', { name: 'Abrir', exact: true }).click(); await expect(page.getByRole('dialog')).toBeVisible(); await page.keyboard.press('Escape'); await expect(imageMenu).toBeFocused();
  // Falha transitória não fica presa no visualizador quando uma ação externa tenta abrir novamente.
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    for (const trigger of ['name', 'menu']) {
      // Uma nova página descarta a imagem já decodificada pela miniatura; a recuperação abaixo permanece no mesmo documento.
      imageMode = 'failed'; await page.reload(); await page.getByRole('combobox', { name: 'Origem' }).selectOption(id); await page.getByRole('radio', { name: 'Imagens', exact: true }).click(); await imageName.click(); await expect(page.getByRole('dialog').getByText('Imagem indisponível', { exact: true })).toBeVisible(); await expectNoA11yViolations(page); await page.keyboard.press('Escape'); await expect(imageName).toBeFocused();
      imageMode = 'ready'; imageHeld = new Promise<void>((resolve) => { imageRelease = resolve; });
      if (trigger === 'name') await imageName.click(); else { await imageMenu.click(); await page.getByRole('menuitem', { name: 'Abrir', exact: true }).click(); }
      await expect(page.getByRole('dialog').getByLabel('Carregando imagem')).toBeVisible(); imageRelease();
      await expect.poll(() => page.getByRole('dialog').getByRole('img', { name: 'imagem.jpg' }).evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      await expect(page.getByRole('dialog').getByText('Imagem indisponível', { exact: true })).toHaveCount(0); await expectNoA11yViolations(page); await expectNoHorizontalScroll(page);
      await attachShot(page, test.info(), `imagem-recuperada-${trigger}-${width}`); await page.keyboard.press('Escape'); await expect(trigger === 'name' ? imageName : imageMenu).toBeFocused();
    }
  }
  await page.unroute(`**/api/attachments/${first}/content`);
  await page.getByRole('radio', { name: 'Documentos', exact: true }).click(); await page.getByRole('button', { name: 'Carregar mais' }).click();
  // O mesmo menu comum em duas larguras: setas/Home/End, Esc e retorno ao gatilho, com axe no estado aberto.
  const documentMenu = page.getByRole('button', { name: 'Mais ações de documento.pdf' });
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    await documentMenu.focus(); await page.keyboard.press('ArrowDown');
    const download = page.getByRole('menuitem', { name: 'Baixar texto', exact: true });
    const remove = page.getByRole('menuitem', { name: 'Excluir', exact: true });
    await expect(download).toBeFocused();
    await expectNoA11yViolations(page); await expectNoHorizontalScroll(page);
    await attachShot(page, test.info(), `arquivos-menu-aberto-${width}`);
    await page.keyboard.press('ArrowDown'); await expect(remove).toBeFocused();
    await page.keyboard.press('Home'); await expect(download).toBeFocused();
    await page.keyboard.press('End'); await expect(remove).toBeFocused();
    await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toHaveCount(0); await expect(documentMenu).toBeFocused();
    await page.keyboard.press('Enter'); await page.keyboard.press('End'); await expect(remove).toBeFocused();
    await page.keyboard.press('Enter'); await expect(page.getByRole('dialog', { name: 'Excluir este arquivo?' })).toBeVisible();
    await page.keyboard.press('Escape'); await expect(documentMenu).toBeFocused();
  }
  const downloadPromise = page.waitForEvent('download'); await page.getByRole('link', { name: 'documento.pdf', exact: true }).click(); expect((await downloadPromise).suggestedFilename()).toBe('documento.txt');
  await page.getByRole('button', { name: 'Mais ações de documento.pdf' }).click(); await page.getByRole('menuitem', { name: 'Excluir', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Excluir este arquivo?' })).toContainText('"documento.pdf" será apagado do Aion.'); await evidence(page, 'dialog-individual');
  await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: 'Mais ações de documento.pdf' })).toBeFocused();
  await page.getByRole('button', { name: 'Mais ações de documento.pdf' }).click(); await page.getByRole('menuitem', { name: 'Excluir', exact: true }).click(); await page.getByRole('button', { name: 'Excluir', exact: true }).click();
  await expect(page.getByText('Arquivo excluído.', { exact: true })).toBeVisible(); await expect(page.getByRole('link', { name: 'documento.pdf', exact: true })).toHaveCount(0); await expect(page.getByRole('checkbox', { name: 'Selecionar todos os arquivos carregados' })).toBeFocused(); await evidence(page, 'sucesso-individual');
  expect((await request.get(`${ORIGIN}/api/attachments/${doc}/content`, { headers })).status()).toBe(404);
  const history = await (await request.get(`${ORIGIN}/api/bots/${id}/conversation/messages?rounds=50`, { headers })).json();
  const originalMessage = history.items.find((item: { attachments?: { id: string }[] }) => item.attachments?.some((file) => file.id === doc)); expect(originalMessage).toBeTruthy();
  await page.goto(`/bots/${id}?mensagem=${originalMessage.id}`); await expect(page.getByText('Arquivo removido: documento.pdf', { exact: true })).toBeVisible();
  await page.goto('/configuracoes/arquivos'); await page.getByRole('combobox', { name: 'Origem' }).selectOption(archived); await expect(page.getByRole('checkbox', { name: 'Selecionar arquivado.txt' })).toBeVisible(); await page.getByRole('checkbox', { name: 'Selecionar arquivado.txt' }).check(); await evidence(page, 'selecao');
  // A origem filtrada perde sua última linha; o foco retorna ao controle estável mesmo sem checkbox ou gatilho.
  await page.getByRole('button', { name: 'Excluir selecionados' }).click(); await page.getByRole('button', { name: 'Excluir', exact: true }).click(); await expect(page.getByText('Nenhum arquivo com esses filtros.', { exact: true })).toBeVisible(); await expect(page.getByRole('combobox', { name: 'Origem' })).toBeFocused(); await evidence(page, 'ultimo-arquivo-excluido');
  // Lote real de várias referências, de origens distintas e inclusive bot arquivado.
  await page.getByRole('combobox', { name: 'Origem' }).selectOption('all'); await expect(page.getByRole('button', { name: 'Excluir selecionados' })).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Selecionar pagina-49.txt' }).check(); await page.getByRole('checkbox', { name: 'Selecionar pagina-48.txt' }).check();
  await page.getByRole('button', { name: 'Excluir selecionados' }).click(); await expect(page.getByRole('dialog', { name: 'Excluir 2 arquivos?' })).toBeVisible(); await evidence(page, 'dialog-lote');
  await page.getByRole('button', { name: 'Excluir 2 arquivos', exact: true }).click(); await expect(page.getByText(/2 arquivos excluídos/)).toBeVisible(); await evidence(page, 'sucesso-lote');
  // Arquivo real na fila: o selo e a seleção obedecem ao worker e desaparecem após parar.
  const busy = await attach(`/api/bots/${id}`, 'em-uso.txt', Buffer.from('Em uso')); await send(`/api/bots/${id}`, [busy], '[demorar]');
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(page.getByRole('checkbox', { name: 'Selecionar em-uso.txt' })).toBeDisabled(); await evidence(page, 'em-uso');
  await page.getByRole('button', { name: 'Mais ações de em-uso.txt' }).click(); await expect(page.getByRole('menuitem', { name: 'Excluir', exact: true })).toHaveAttribute('data-disabled'); await page.keyboard.press('Escape');
  await request.post(`${ORIGIN}/api/bots/${id}/runs/stop`, { headers });
});

test('estados transitórios, quota, falhas e releitura ignoram resposta antiga em duas larguras', async ({ page }) => {
  test.setTimeout(180_000); const auth = await apiHeaders(page);
  const quotaResponse = await page.context().request.get(`${ORIGIN}/api/attachments`, { headers: auth });
  expect(quotaResponse.status()).toBe(200); const quotaList = attachmentPageSchema.parse(await quotaResponse.json());
  let mode = 'loading'; let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  const headers = { 'content-type': 'application/json' };
  const data: AttachmentPage = { items: [], nextCursor: null, usedBytes: 0, maxBytes: 100 * 1048576, count: 0 };
  await page.route(/\/api\/attachments(?:\?.*)?$/, async (route) => { if (mode === 'loading') await held; if (mode === 'error') await route.fulfill({ status: 503, headers, body: JSON.stringify({ code: 'UNKNOWN', message: 'Não foi possível carregar arquivos.' }) }); else await route.fulfill({ status: 200, headers, body: JSON.stringify(mode === 'warning' || mode === 'full' ? { ...quotaList, maxBytes: data.maxBytes, usedBytes: (mode === 'warning' ? 80 : 100) * 1048576 } : data) }); });
  await page.goto('/configuracoes/arquivos'); await expect(page.getByRole('status', { name: 'Carregando arquivos' })).toBeVisible(); await evidence(page, 'carregando');
  mode = 'error'; release(); await expect(page.getByText('Não foi possível carregar arquivos.', { exact: true })).toBeVisible(); await evidence(page, 'erro');
  mode = 'empty'; await page.getByRole('button', { name: 'Tentar novamente' }).click(); await expect(page.getByText('Nenhum arquivo anexado ainda.', { exact: true })).toBeVisible(); await evidence(page, 'vazio-quota-baixa');
  await page.getByRole('radio', { name: 'Imagens', exact: true }).focus(); await page.keyboard.press('ArrowRight'); await expect(page.getByRole('radio', { name: 'Documentos', exact: true })).toHaveAttribute('aria-checked', 'true'); await expect(page.getByText('Nenhum arquivo com esses filtros.', { exact: true })).toBeVisible(); await evidence(page, 'filtro-vazio');
  await page.getByRole('button', { name: 'Limpar filtros' }).click(); mode = 'warning'; await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '80'); await evidence(page, 'quota-alerta');
  mode = 'full'; await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100'); await evidence(page, 'quota-cheia');
});

test('respostas atrasadas, exclusão em andamento, conflitos e lotes grandes conservam estado e foco', async ({ page }) => {
  test.setTimeout(180_000); const auth = await apiHeaders(page); const real = await listed(page, auth); const template = real.items.find((file) => !file.inUse)!; expect(template).toBeTruthy();
  // Metadados válidos derivados do contrato real isolam a coordenação de respostas, já que exclusão real foi provada acima.
  const files = Array.from({ length: 101 }, (_, index) => ({ ...template, id: String(900000 + index), name: `coordenacao-${index}.txt`, kind: 'document' as const, originalBytes: 1024, storedBytes: 100, inUse: false }));
  let pageMode = 'first'; let cursorRelease!: () => void; let staleRelease!: () => void;
  const cursorHeld = new Promise<void>((resolve) => { cursorRelease = resolve; }); const staleHeld = new Promise<void>((resolve) => { staleRelease = resolve; });
  const json = { 'content-type': 'application/json' }; const makePage = (items = files.slice(0, 50), nextCursor: string | null = '900049') => ({ ...real, items, nextCursor, count: files.length, usedBytes: 10100 });
  await page.route(/\/api\/attachments(?:\?.*)?$/, async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.has('cursor')) { await cursorHeld; await route.fulfill({ status: 200, headers: json, body: JSON.stringify(makePage(files.slice(50), null)) }); return; }
    if (query.get('kind') === 'image') { await staleHeld; await route.fulfill({ status: 200, headers: json, body: JSON.stringify(makePage([{ ...files[0]!, name: 'resposta-antiga.txt' }], null)) }); return; }
    await route.fulfill({ status: 200, headers: json, body: JSON.stringify(pageMode === 'all' ? makePage(files, null) : makePage()) });
  });
  await page.goto('/configuracoes/arquivos'); await expect(page.getByRole('checkbox', { name: 'Selecionar coordenacao-0.txt' })).toBeVisible();
  await page.getByRole('button', { name: 'Carregar mais' }).click(); await expect(page.getByRole('button', { name: 'Carregar mais' })).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(page.getByRole('button', { name: 'Carregar mais' })).toBeEnabled();
  const cursorResponse = page.waitForResponse((response) => response.url().includes('/api/attachments?') && response.url().includes('cursor=')); cursorRelease(); await cursorResponse; await expect(page.getByRole('list', { name: 'Arquivos anexados' }).locator(':scope > li')).toHaveCount(50);
  await page.getByRole('checkbox', { name: 'Selecionar coordenacao-0.txt' }).check(); await page.getByRole('radio', { name: 'Imagens', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Carregando arquivos' })).toBeVisible(); await page.getByRole('radio', { name: 'Documentos', exact: true }).click(); await expect(page.getByRole('checkbox', { name: 'Selecionar coordenacao-0.txt' })).toBeVisible();
  const staleResponse = page.waitForResponse((response) => response.url().includes('/api/attachments?') && response.url().includes('kind=image')); staleRelease(); await staleResponse; await expect(page.getByText('resposta-antiga.txt', { exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Excluir selecionados' })).toHaveCount(0);
  // Uma falha individual fecha o diálogo, mantém o item e permanece por mais que o toast de sucesso.
  let deletionMode = 'network'; let deleteRelease!: () => void; let deletionHeld = new Promise<void>((resolve) => { deleteRelease = resolve; });
  await page.route('**/api/attachments/900000', async (route) => { await deletionHeld; if (deletionMode === 'network') await route.abort('failed'); else await route.fulfill({ status: 409, headers: json, body: JSON.stringify({ code: 'ATTACHMENT_IN_USE', message: 'O arquivo está em uso por uma execução. Tente de novo quando ela terminar.' }) }); });
  const menu = page.getByRole('button', { name: 'Mais ações de coordenacao-0.txt' }); await menu.click(); await page.getByRole('menuitem', { name: 'Excluir', exact: true }).click(); await page.getByRole('button', { name: 'Excluir', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancelar', exact: true })).toBeDisabled(); await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toBeVisible(); await evidence(page, 'excluindo');
  deleteRelease(); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByText('Sem conexão com o servidor. Tente novamente.', { exact: true })).toBeVisible(); await expect(menu).toBeFocused(); await evidence(page, 'erro-rede-toast');
  await page.waitForTimeout(4200); await expect(page.getByText('Sem conexão com o servidor. Tente novamente.', { exact: true })).toBeVisible();
  deletionMode = 'in-use'; deletionHeld = Promise.resolve(); await menu.click(); await page.getByRole('menuitem', { name: 'Excluir', exact: true }).click(); await page.getByRole('button', { name: 'Excluir', exact: true }).click(); await expect(page.getByText('O arquivo está em uso por uma execução. Tente de novo quando ela terminar.', { exact: true })).toBeVisible(); await evidence(page, 'erro-em-uso-toast');
  // Mais de cem selecionados geram duas chamadas; uma falha posterior conserva o resultado da primeira.
  pageMode = 'all'; await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(page.getByRole('list', { name: 'Arquivos anexados' }).locator(':scope > li')).toHaveCount(101);
  const batches: string[][] = []; let batchMode = 'partial';
  await page.route('**/api/attachments/delete-batch', async (route) => { const ids = route.request().postDataJSON().ids as string[]; batches.push(ids); if (batchMode === 'partial' && batches.length === 2) { await route.abort('failed'); return; } const inUse = batchMode === 'kept' ? ids.slice(0, 1) : []; const deleted = ids.filter((id) => !inUse.includes(id)); await route.fulfill({ status: 200, headers: json, body: JSON.stringify({ deleted, inUse, alreadyRemoved: [], freedBytes: deleted.length * 100 }) }); });
  // A releitura pós-exclusão representa o estado autoritativo compatível com os resultados recebidos.
  await page.unroute(/\/api\/attachments(?:\?.*)?$/);
  await page.route(/\/api\/attachments(?:\?.*)?$/, async (route) => { const removed = new Set(batches.length ? batches[0] : []); await route.fulfill({ status: 200, headers: json, body: JSON.stringify(makePage(files.filter((file) => !removed.has(file.id)), null)) }); });
  await page.getByRole('checkbox', { name: 'Selecionar todos os arquivos carregados' }).check(); await page.getByRole('button', { name: 'Excluir selecionados' }).click(); await expect(page.getByRole('dialog', { name: 'Excluir 101 arquivos?' })).toBeVisible(); await page.getByRole('button', { name: 'Excluir 101 arquivos', exact: true }).click();
  await expect.poll(() => batches.map((ids) => ids.length)).toEqual([100, 1]); await expect(page.getByRole('checkbox', { name: 'Selecionar coordenacao-100.txt' })).toBeVisible(); await expect(page.getByRole('checkbox', { name: 'Selecionar coordenacao-1.txt' })).toHaveCount(0);
  // Resultado misto do servidor informa os mantidos, sem excluir a linha protegida.
  batchMode = 'kept'; batches.length = 0; await page.unroute(/\/api\/attachments(?:\?.*)?$/);
  await page.route(/\/api\/attachments(?:\?.*)?$/, async (route) => { const remaining = batches.length ? [{ ...files[0]!, inUse: true }] : files.slice(0, 2); await route.fulfill({ status: 200, headers: json, body: JSON.stringify(makePage(remaining, null)) }); });
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(page.getByRole('list', { name: 'Arquivos anexados' }).locator(':scope > li')).toHaveCount(2); await page.getByRole('checkbox', { name: 'Selecionar todos os arquivos carregados' }).check(); await page.getByRole('button', { name: 'Excluir selecionados' }).click(); await page.getByRole('button', { name: 'Excluir 2 arquivos', exact: true }).click(); await expect(page.getByText(/1 arquivos em uso foram mantidos/)).toBeVisible(); await expect(page.getByRole('checkbox', { name: 'Selecionar coordenacao-0.txt' })).toBeDisabled(); await evidence(page, 'lote-mantido-toast');
});


test('arquivos do bot preservam escopo nos erros, foco no último excluído e remoção definitiva sem órfãos', async ({ page }) => {
  test.setTimeout(180_000);
  const headers = await apiHeaders(page); const request = page.context().request;
  const name = uniqueBotName('Arquivos contextual com nome comprido');
  const created = await request.post(`${ORIGIN}/api/bots`, { headers, data: { name, color: '#34D399', instructions: '', model: 'opencode/vision-model', effort: null, stepLimit: 25 } });
  expect(created.status()).toBe(201); const id = (await created.json()).id as string;
  /** Referências pendentes também pertencem à conversa e entram no ciclo de vida da exclusão definitiva. */
  async function upload(filename: string) {
    const response = await request.post(`${ORIGIN}/api/bots/${id}/attachments`, { headers: { ...headers, 'content-type': 'application/octet-stream', 'x-attachment-name': encodeURIComponent(filename) }, data: Buffer.from(filename) });
    expect(response.status()).toBe(201); return (await response.json()).id as string;
  }
  const first = await upload('ultimo-contextual.txt');
  let botFailure = true; let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/bots/${id}`, async (route) => { if (route.request().method() !== 'GET') return route.continue(); await held; if (botFailure) await route.abort('failed'); else await route.continue(); });
  await page.goto(`/bots/${id}/arquivos`); await expect(page.getByRole('status', { name: 'Carregando bot', exact: true })).toBeVisible(); await botEvidence(page, 'bot-carregando'); release();
  await expect(page.getByRole('heading', { name: 'Não foi possível carregar', exact: true })).toBeVisible(); await botEvidence(page, 'bot-erro');
  botFailure = false; await page.getByRole('button', { name: 'Tentar novamente' }).click(); await expect(page.getByRole('checkbox', { name: 'Selecionar ultimo-contextual.txt' })).toBeVisible(); await page.unroute(`**/api/bots/${id}`);
  const queries: URLSearchParams[] = []; let listFailure = true;
  await page.route(/\/api\/attachments(?:\?.*)?$/, async (route) => { queries.push(new URL(route.request().url()).searchParams); if (listFailure) await route.abort('failed'); else await route.continue(); });
  await page.reload(); await expect(page.getByRole('alert').filter({ hasText: 'Sem conexão com o servidor. Tente novamente.' })).toHaveText('Sem conexão com o servidor. Tente novamente.'); await botEvidence(page, 'lista-erro');
  listFailure = false; await page.getByRole('button', { name: 'Tentar novamente' }).click(); await expect(page.getByRole('checkbox', { name: 'Selecionar ultimo-contextual.txt' })).toBeVisible();
  const menu = page.getByRole('button', { name: 'Mais ações de ultimo-contextual.txt' });
  await page.route(`**/api/attachments/${first}`, (route) => route.abort('failed'));
  await menu.click(); await page.getByRole('menuitem', { name: 'Excluir', exact: true }).click(); await page.getByRole('button', { name: 'Excluir', exact: true }).click();
  await expect(page.getByText('Sem conexão com o servidor. Tente novamente.', { exact: true })).toBeVisible(); await expect(menu).toBeFocused();
  await page.unroute(`**/api/attachments/${first}`); await menu.click(); await page.getByRole('menuitem', { name: 'Excluir', exact: true }).click(); await page.getByRole('button', { name: 'Excluir', exact: true }).click();
  await expect(page.getByText('Nenhum arquivo anexado ainda.', { exact: true })).toBeVisible(); await expect(page.getByRole('radio', { name: 'Todos', exact: true })).toBeFocused(); await botEvidence(page, 'bot-ultimo-excluido');
  expect(queries.every((query) => query.get('origin') === 'bot' && query.get('botId') === id)).toBe(true); await page.unroute(/\/api\/attachments(?:\?.*)?$/);
  const retained = await upload('remover-junto-bot.txt'); const globalBefore = await listed(page, headers);
  expect((await request.post(`${ORIGIN}/api/bots/${id}/archive`, { headers })).status()).toBe(200);
  await page.goto(`/bots/${id}`); await expect(botActionEntry(page, 'arquivos')).toBeVisible(); await botEvidence(page, 'conversa-arquivada');
  await openBotAction(page, 'arquivos'); await expect(page.getByRole('checkbox', { name: 'Selecionar remover-junto-bot.txt' })).toBeVisible(); await botEvidence(page, 'bot-retido-arquivado');
  expect((await request.delete(`${ORIGIN}/api/bots/${id}`, { headers, data: { confirmName: name } })).status()).toBe(204);
  expect((await request.get(`${ORIGIN}/api/attachments/${retained}/content`, { headers })).status()).toBe(404);
  const after = await listed(page, headers); expect(after.count).toBe(globalBefore.count - 1); expect(after.items.some((file) => file.bot?.id === id)).toBe(false);
  await page.goto('/configuracoes/arquivos'); await expect(page.getByRole('checkbox', { name: 'Selecionar remover-junto-bot.txt' })).toHaveCount(0);
  await page.goto(`/bots/${id}/arquivos`); await expect(page.getByText('Este bot não existe ou foi removido.', { exact: true })).toBeVisible(); await botEvidence(page, 'bot-inexistente');
  await page.goto('/bots/id-invalido/arquivos'); await expect(page.getByRole('heading', { name: 'Não encontrado', exact: true })).toBeVisible();
});

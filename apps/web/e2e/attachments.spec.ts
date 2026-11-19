// Jornada de anexos contra API/worker reais. Canvas Chromium prova pixels, JPEG e remoção de metadados.
import { readFile } from 'node:fs/promises';
import type { Page, TestInfo } from '@playwright/test';
import { docxFixture, pdfFixture, xlsxFixture } from '../../../packages/core/src/testing/attachment-fixtures';
import { apiHeaders, ensureCredential, expect, expectNoA11yViolations, expectNoHorizontalScroll, openBotAction, ORIGIN, test, uniqueBotName, openWorkLine } from './support/fixtures';

test.describe.configure({ mode: 'serial' });
/** Evidência visual sem depender do diretório transitório do Playwright. */
async function shot(page: Page, info: TestInfo, name: string) { await page.screenshot({ path: info.outputPath(`${name}.png`) }); await expectNoHorizontalScroll(page); await expectNoA11yViolations(page); }
/** PNG transparente grande, criado no navegador sem dependência de biblioteca de imagem. */
async function png(page: Page) { const data = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 4000; canvas.height = 1000; const context = canvas.getContext('2d')!; context.fillStyle = '#ff0000'; context.fillRect(0, 0, 100, 100); return canvas.toDataURL('image/png').split(',')[1]!; }); return { name: 'paisagem.png', mimeType: 'image/png', buffer: Buffer.from(data, 'base64') }; }
/** Cria o dono da conversa pelo contrato público, após configurar o provedor falso. */
async function setup(page: Page, name: string, model = 'opencode/deepseek-v4.1-flash') {
  await ensureCredential(page, 'provider', 'valid-e2e-attachments-1111');
  const headers = await apiHeaders(page);
  const request = page.context().request;
  const response = await request.post(`${ORIGIN}/api/bots`, { headers, data: { name: uniqueBotName(name), color: '#60A5FA', instructions: '', model, effort: null, stepLimit: 25 } });
  expect(response.status(), await response.text()).toBe(201);
  const { id } = await response.json();
  await page.goto(`/bots/${id}`);
  await expect(page.getByRole('button', { name: 'Anexar arquivo' })).toBeVisible();
  return { id, headers, request };
}

test('anexa PDF e PNG, recodifica, envia, abre e baixa, conserva fila e estados em duas larguras', async ({ page }, info) => {
  test.setTimeout(180_000);
  const { id, headers, request } = await setup(page, 'Anexos completos');
  const image = await png(page);
  const input = page.locator('input[type=file]');
  const field = page.getByRole('textbox', { name: 'Mensagem', exact: true });
  let probes = 0;
  page.on('request', (request) => { if (request.url().endsWith('/api/models/verify-image')) probes++; });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/\/attachments$/, async (route) => { if (route.request().method() === 'POST') await held; await route.continue(); });
  let visionRelease!: () => void; const visionHeld = new Promise<void>((resolve) => { visionRelease = resolve; });
  await page.route('**/api/models/verify-image', async (route) => { await visionHeld; await route.continue(); });
  await input.setInputFiles([image, { name: 'relatório.pdf', mimeType: 'application/pdf', buffer: pdfFixture('Documento da jornada') }]);
  await expect(page.getByRole('button', { name: 'Remover relatório.pdf' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Verificando se o modelo aceita imagens…' })).toBeVisible();
  for (const width of [1440, 375]) { await page.setViewportSize({ width, height: width === 375 ? 812 : 900 }); await shot(page, info, `${width}-verificando`); }
  // Retenção termina antes de remover a rota, evitando que unroute continue o mesmo pedido duas vezes.
  const visionResponse = page.waitForResponse('**/api/models/verify-image'); visionRelease(); await visionResponse; await page.unroute('**/api/models/verify-image');
  for (const width of [1440, 375]) { await page.setViewportSize({ width, height: width === 375 ? 812 : 900 }); await shot(page, info, `${width}-carregando`); }
  release();
  await field.fill('Leia os anexos');
  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeEnabled();
  await page.unroute(/\/attachments$/);
  await input.setInputFiles(Array.from({ length: 3 }, (_, index) => ({ name: `nota-${index}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`Nota ${index}`) })));
  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeEnabled();
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 }); await shot(page, info, `${width}-cinco`);
    // Mede a área efetivamente clicável dentro do recorte rolável, sem inferir o alvo pelas classes CSS.
    const geometry = await page.getByRole('button', { name: 'Remover paisagem.png' }).evaluate((button) => {
      const target = button.getBoundingClientRect(); const clip = button.closest('[aria-label="Arquivos anexados"]')!.getBoundingClientRect();
      return { width: target.width, height: target.height, visibleWidth: Math.max(0, Math.min(target.right, clip.right) - Math.max(target.left, clip.left)), visibleHeight: Math.max(0, Math.min(target.bottom, clip.bottom) - Math.max(target.top, clip.top)), targetTop: target.top, clipTop: clip.top };
    });
    await info.attach(`${width}-removal-geometry`, { body: JSON.stringify(geometry), contentType: 'application/json' });
    expect(geometry.visibleWidth, JSON.stringify(geometry)).toBeGreaterThanOrEqual(32); expect(geometry.visibleHeight, JSON.stringify(geometry)).toBeGreaterThanOrEqual(32);
  }
  await page.getByRole('button', { name: 'Anexar arquivo' }).click();
  await expect(page.locator('form.composer').getByRole('alert')).toHaveText('Uma mensagem aceita até 5 arquivos.');
  await field.press('Enter');
  const log = page.getByRole('log', { name: 'Conversa' });
  const thumb = log.getByRole('button', { name: 'Abrir imagem paisagem.png' });
  await expect(thumb).toBeVisible();
  // Só o formato de imagem correto ativa esta resposta no provedor falso.
  await expect(log.getByText('vermelho', { exact: true })).toBeVisible();
  expect(probes).toBeLessThanOrEqual(1);
  const snapshot = await (await request.get(`${ORIGIN}/api/bots/${id}/conversation`, { headers })).json();
  const files = snapshot.items.find((item: { role?: string; content?: string }) => item.role === 'user' && item.content === 'Leia os anexos').attachments;
  const stored = await request.get(`${ORIGIN}/api/bots/${id}/attachments/${files.find((file: { kind: string }) => file.kind === 'image').id}/content`, { headers });
  const bytes = await stored.body(); expect(bytes.subarray(0, 2)).toEqual(Buffer.from([255, 216]));
  const dimensions = await page.evaluate(async (body) => { const bitmap = await createImageBitmap(new Blob([Uint8Array.from(body)], { type: 'image/jpeg' })); const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height; const ctx = canvas.getContext('2d')!; ctx.drawImage(bitmap, 0, 0); const color = Array.from(ctx.getImageData(bitmap.width - 1, bitmap.height - 1, 1, 1).data); return { width: bitmap.width, height: bitmap.height, color }; }, [...bytes]);
  expect(dimensions).toEqual({ width: 2000, height: 500, color: [255, 255, 255, 255] });
  expect(bytes.includes(Buffer.from('Exif'))).toBe(false);
  const downloadPromise = page.waitForEvent('download'); await log.getByRole('link', { name: 'Baixar texto de relatório.pdf' }).click(); const download = await downloadPromise; expect(download.suggestedFilename()).toBe('relatório.txt');
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 }); await shot(page, info, `${width}-enviado`);
    await thumb.click(); await expect(page.getByRole('dialog', { name: 'paisagem.png' })).toBeVisible(); await shot(page, info, `${width}-modal`); await page.keyboard.press('Escape'); await expect(thumb).toBeFocused();
  }
  await field.fill(`[anexo-ler:${files.find((file: { kind: string }) => file.kind === 'document').id}|0]`); await field.press('Enter');
  await openWorkLine(log, log.getByRole('button', { name: 'Leu o anexo relatório.pdf' }));
  await expect(log.getByRole('button', { name: 'Leu o anexo relatório.pdf' })).toBeVisible();
  await log.getByRole('button', { name: 'Leu o anexo relatório.pdf' }).click(); await shot(page, info, '375-atividade');
  // Complemento real (phase 4, CONV-03): com a execução ocupando o bot, o envio com arquivo vira complemento aguardando, com os metadados ainda sem message_id.
  await field.fill('[demorar]'); await field.press('Enter'); await expect(page.getByRole('button', { name: 'Parar execução' })).toBeVisible();
  await input.setInputFiles({ name: 'fila.txt', mimeType: 'text/plain', buffer: Buffer.from('Fila') }); await field.fill('Pedido na fila'); await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeEnabled(); await field.press('Enter');
  await expect(log.getByText('Complemento · aguardando', { exact: true })).toBeVisible(); await expect(log.locator('[data-complement="pending"]').getByText('fila.txt')).toBeVisible();
  for (const width of [1440, 375]) { await page.setViewportSize({ width, height: width === 375 ? 812 : 900 }); await shot(page, info, `${width}-fila`); }
  // Parar devolve o texto e o arquivo ao composer vazio (A11): o chip volta pronto, sem novo upload.
  await page.getByRole('button', { name: 'Parar execução' }).click();
  await expect(field).toHaveValue('Pedido na fila'); await expect(page.getByLabel('Arquivos anexados').getByText('fila.txt')).toBeVisible();
  // Contrato removido e rede indisponível, sem implementar a exclusão T10.
  await page.route(`**/api/bots/${id}/conversation`, async (route) => { const response = await route.fetch(); const state = await response.json(); for (const item of state.items) for (const file of item.attachments ?? []) if (file.kind === 'document') file.removed = true; await route.fulfill({ response, json: state }); });
  await page.route('**/attachments/*/content', (route) => route.abort());
  await page.reload(); await expect(log.getByText('Arquivo removido: relatório.pdf')).toBeVisible(); await expect(log.getByText('Indisponível')).toBeVisible();
  for (const width of [1440, 375]) { await page.setViewportSize({ width, height: width === 375 ? 812 : 900 }); await shot(page, info, `${width}-removido-indisponivel`); await thumb.click(); await expect(page.getByRole('status', { name: '' }).filter({ hasText: 'Imagem indisponível' })).toBeVisible(); await shot(page, info, `${width}-modal-indisponivel`); await page.keyboard.press('Escape'); }
});

test('recusas locais e do servidor, reteste de visão e mensagens seguras permanecem no rascunho', async ({ page }, info) => {
  test.setTimeout(120_000);
  const { id, headers, request } = await setup(page, 'Anexos recusados', 'opencode/vision-reject');
  const image = await png(page); const input = page.locator('input[type=file]');
  await input.setInputFiles(image); await expect(page.locator('form.composer').getByRole('alert')).toHaveText('Este modelo não aceita imagens. Escolha outro modelo.');
  for (const width of [1440, 375]) { await page.setViewportSize({ width, height: width === 375 ? 812 : 900 }); await shot(page, info, `${width}-sem-visao`); }
  await page.getByRole('button', { name: 'Remover paisagem.png' }).click();
  await input.setInputFiles({ name: 'animado.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') }); await expect(page.locator('form.composer').getByRole('alert')).toHaveText('Este tipo de arquivo não é aceito.'); await page.getByRole('button', { name: 'Remover animado.gif' }).click();
  await input.setInputFiles({ name: 'vazio.txt', mimeType: 'text/plain', buffer: Buffer.from(' ') }); await expect(page.locator('form.composer').getByRole('alert')).toHaveText('Não encontrei texto neste documento (talvez seja escaneado).');
  for (const width of [1440, 375]) { await page.setViewportSize({ width, height: width === 375 ? 812 : 900 }); await shot(page, info, `${width}-erro-documento`); }
  await page.getByRole('button', { name: 'Remover vazio.txt' }).click();
  expect((await request.patch(`${ORIGIN}/api/bots/${id}/conversation`, { headers, data: { model: 'opencode/vision-model', effort: null } })).status()).toBe(200); await page.reload();
  await page.route('**/api/models/verify-image', (route) => route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ code: 'RATE_LIMITED', message: 'Muitos testes. Aguarde.' }) }));
  await request.post(`${ORIGIN}/api/models/test`, { headers, data: { model: 'opencode/vision-model' } });
  await input.setInputFiles(image); await expect(page.locator('form.composer').getByRole('alert')).toHaveText('Muitos testes. Aguarde.'); await page.unroute('**/api/models/verify-image');
  await page.getByRole('button', { name: 'Tentar novamente paisagem.png' }).click(); await page.getByRole('textbox', { name: 'Mensagem', exact: true }).fill('Preservado'); await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeEnabled();
  await page.getByRole('button', { name: 'Remover paisagem.png' }).click();
  // Reteste invalida visão sem remontar o composer; o próximo gesto precisa consultar o servidor outra vez.
  expect((await request.post(`${ORIGIN}/api/models/test`, { headers, data: { model: 'opencode/vision-model' } })).status()).toBe(200);
  await page.route('**/api/models/verify-image', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'MODEL_IMAGE_CHECK_FAILED', message: 'Tente novamente.' }) }));
  await input.setInputFiles(image); await expect(page.locator('form.composer').getByRole('alert')).toHaveText('Não consegui verificar o modelo agora. Tente de novo.');
  await page.unroute('**/api/models/verify-image');
  await page.getByRole('button', { name: 'Remover paisagem.png' }).click();
  await page.route(/\/attachments$/, (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'ATTACHMENT_QUOTA_EXCEEDED', message: 'O espaço para arquivos acabou. Exclua arquivos em Configurações → Arquivos.' }) }));
  await input.setInputFiles({ name: 'quota.txt', mimeType: 'text/plain', buffer: Buffer.from('Texto') }); await expect(page.locator('form.composer').getByRole('alert')).toContainText('O espaço para arquivos acabou.');
  for (const width of [1440, 375]) { await page.setViewportSize({ width, height: width === 375 ? 812 : 900 }); await shot(page, info, `${width}-quota`); }
  await page.unroute(/\/attachments$/);
  await page.getByRole('button', { name: 'Remover quota.txt' }).click();
  await page.route(/\/attachments$/, (route) => route.abort());
  await input.setInputFiles({ name: 'rede.txt', mimeType: 'text/plain', buffer: Buffer.from('Texto') }); await expect(page.locator('form.composer').getByRole('alert')).toHaveText('Sem conexão com o servidor. Tente novamente.');
  for (const width of [1440, 375]) { await page.setViewportSize({ width, height: width === 375 ? 812 : 900 }); await shot(page, info, `${width}-rede`); }
  await page.unroute(/\/attachments$/); await page.getByRole('button', { name: 'Remover rede.txt' }).click();
  // Um 429 externo continua possível entre dispositivos: o rascunho oferece repetição explícita.
  await page.route('**/attachments', (route) => route.fulfill({ status: 429, headers: { 'Retry-After': '1' }, contentType: 'application/json', body: JSON.stringify({ code: 'RATE_LIMITED', message: 'Muitas solicitações. Aguarde um instante e tente novamente.' }) }));
  await input.setInputFiles({ name: 'limite.txt', mimeType: 'text/plain', buffer: Buffer.from('Texto') });
  await expect(page.locator('form.composer').getByRole('alert')).toHaveText('Muitas solicitações. Aguarde um instante e tente novamente.');
  await page.unroute('**/attachments'); await page.getByRole('button', { name: 'Tentar novamente limite.txt' }).click();
  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeEnabled(); await page.getByRole('button', { name: 'Remover limite.txt' }).click();
  // Retém os dois pedidos ativos. Remover um aguardando e navegar devem cancelar o lote sem iniciar os demais.
  const started: string[] = []; const aborted: string[] = [];
  page.on('requestfailed', (request) => { if (request.url().endsWith('/attachments')) aborted.push(request.url()); });
  await page.route('**/attachments', (route) => { started.push(decodeURIComponent(route.request().headers()['x-attachment-name']!)); });
  await input.setInputFiles(Array.from({ length: 4 }, (_, index) => ({ name: `espera-${index}.txt`, mimeType: 'text/plain', buffer: Buffer.from('Fila local') })));
  await expect.poll(() => started).toEqual(['espera-0.txt', 'espera-1.txt']);
  await page.getByRole('button', { name: 'Remover espera-2.txt' }).click(); await expect(page.getByRole('button', { name: 'Remover espera-2.txt' })).toHaveCount(0);
  await openBotAction(page, 'editar'); await expect(input).toHaveCount(0);
  await expect.poll(() => aborted.length).toBe(2); expect(started).toEqual(['espera-0.txt', 'espera-1.txt']);
  await page.unroute('**/attachments');
});

test('Chat geral compartilha upload, bolha, imagem e download com a origem correta', async ({ page }, info) => {
  test.setTimeout(90_000);
  await ensureCredential(page, 'provider', 'valid-e2e-attachments-1111');
  const headers = await apiHeaders(page); const request = page.context().request;
  const created = await request.post(`${ORIGIN}/api/chat/sessions`, { headers }); expect(created.status()).toBe(201);
  const { id } = await created.json();
  // Este ID tem estimativa visual fundamentada; vision-model segue reservado às sondas de recusa/reteste.
  expect((await request.patch(`${ORIGIN}/api/chat/sessions/${id}/conversation`, { headers, data: { model: 'opencode/deepseek-v4.1-flash', effort: null } })).status()).toBe(200);
  await page.goto(`/chat/${id}`);
  await expect(page.getByRole('button', { name: 'Anexar arquivo' })).toBeVisible();
  await page.locator('input[type=file]').setInputFiles([await png(page), { name: 'chat.txt', mimeType: 'text/plain', buffer: Buffer.from('Nota do chat geral') }]);
  const field = page.getByRole('textbox', { name: 'Mensagem', exact: true }); await field.fill('Arquivos do chat');
  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeEnabled(); await field.press('Enter');
  const log = page.getByRole('log', { name: 'Conversa' });
  const link = log.getByRole('link', { name: 'Baixar texto de chat.txt' }); await expect(link).toHaveAttribute('href', new RegExp(`/api/chat/sessions/${id}/attachments/\\d+/content`));
  for (const width of [1440, 375]) { await page.setViewportSize({ width, height: width === 375 ? 812 : 900 }); await shot(page, info, `${width}-chat`); await log.getByRole('button', { name: 'Abrir imagem paisagem.png' }).click(); await shot(page, info, `${width}-chat-modal`); await page.keyboard.press('Escape'); }
});

// Phase 4, T5 (F9, ATT-01, A19): chips de planilha e JSON no composer, recusa do servidor, bolha com download do original e a linha
// "Planilha" com "Baixar" em Configurações → Arquivos, nas duas larguras e com axe.
test('planilha e JSON: chips, recusa, download do original na conversa e linha "Planilha" em Arquivos', async ({ page }, info) => {
  test.setTimeout(120_000);
  const { id } = await setup(page, 'Anexos planilha');
  const sheetName = `vendas-${Date.now()}.xlsx`;
  const sheet = xlsxFixture();
  await page.locator('input[type=file]').setInputFiles([
    { name: sheetName, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: sheet },
    { name: 'dados.json', mimeType: 'application/json', buffer: Buffer.from('{"total": 42}') },
    { name: 'falsa.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: docxFixture() },
  ]);
  const chips = page.locator('form.composer [aria-label="Arquivos anexados"]');
  await expect(chips.getByText(/^Planilha · \d+ KB$/)).toBeVisible();
  await expect(chips.getByText(/^JSON · 1 KB$/)).toBeVisible();
  await expect(page.locator('form.composer').getByRole('alert')).toHaveText('Este tipo de arquivo não é aceito.');
  await expect(chips.locator('[data-file-icon="spreadsheet"]')).toHaveCount(2);
  await expect(chips.locator('[data-file-icon="json"]')).toHaveCount(1);
  for (const width of [1440, 375]) { await page.setViewportSize({ width, height: width === 375 ? 812 : 900 }); await shot(page, info, `${width}-planilha-composer`); }
  await page.getByRole('button', { name: 'Remover falsa.xlsx' }).click();
  const field = page.getByRole('textbox', { name: 'Mensagem', exact: true });
  await field.fill('Analise a planilha'); await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeEnabled(); await field.press('Enter');
  const log = page.getByRole('log', { name: 'Conversa' });
  const link = log.getByRole('link', { name: `Baixar ${sheetName}` });
  await expect(link).toHaveAttribute('href', new RegExp(`/api/bots/${id}/attachments/\\d+/content`));
  await expect(log.getByRole('link', { name: 'Baixar texto de dados.json' })).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  expect(download.suggestedFilename()).toBe(sheetName);
  expect(await readFile((await download.path())!)).toEqual(sheet);
  for (const width of [1440, 375]) { await page.setViewportSize({ width, height: width === 375 ? 812 : 900 }); await shot(page, info, `${width}-planilha-bolha`); }
  // Sem sessão o original não sai: contexto novo, sem cookies.
  const anonymous = await page.context().browser()!.newContext();
  expect((await anonymous.request.get(`${ORIGIN}${await link.getAttribute('href')}`)).status()).toBe(401);
  await anonymous.close();
  await page.goto('/configuracoes/arquivos');
  const row = page.getByRole('list', { name: 'Arquivos anexados' }).locator(':scope > li').filter({ hasText: sheetName });
  await expect(row.getByText(/^Planilha · \d+ KB · /)).toBeVisible();
  await expect(row.locator('[data-file-icon="spreadsheet"]')).toBeVisible();
  for (const width of [1440, 375]) { await page.setViewportSize({ width, height: width === 375 ? 812 : 900 }); await row.scrollIntoViewIfNeeded(); await shot(page, info, `${width}-planilha-arquivos`); }
  await row.getByRole('button', { name: `Mais ações de ${sheetName}` }).click();
  await expect(page.getByRole('menuitem', { name: 'Baixar', exact: true })).toBeVisible();
  // Menu aberto: só a captura e a rolagem; o axe deste estado acusa o `aria-hidden` que o Menu (Radix) põe no resto da página, fora desta task
  // (registrado em .erros-encontrados/). Os estados da lista acima passam pelo axe completo.
  await page.screenshot({ path: info.outputPath('375-planilha-arquivos-menu.png') }); await expectNoHorizontalScroll(page);
  const [fromFiles] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Baixar', exact: true }).click()]);
  expect(fromFiles.suggestedFilename()).toBe(sheetName);
});

test('arrastar arquivos para a tela anexa pelo mesmo fluxo do botão e o seletor oferece câmera e galeria no celular', async ({ page }, info) => {
  const { id, headers, request } = await setup(page, 'Anexos por arraste');
  // O seletor nativo recebe tipos MIME além das extensões: com tipos de imagem o Android oferece câmera e galeria, não só "Arquivos".
  await expect(page.locator('input[type=file]')).toHaveAttribute('accept', /image\/jpeg/);
  await expect(page.locator('input[type=file]')).toHaveAttribute('accept', /\.pdf/);
  // Arraste com arquivo: dragenter mostra o aviso e o drop entrega à mesma fila do botão (validação, limite e upload).
  const transfer = await page.evaluateHandle(() => { const data = new DataTransfer(); data.items.add(new File(['Nota arrastada'], 'arrastada.txt', { type: 'text/plain' })); return data; });
  const body = page.locator('body');
  await body.dispatchEvent('dragenter', { dataTransfer: transfer });
  await expect(page.getByText('Solte para anexar', { exact: true })).toBeVisible();
  await shot(page, info, 'arraste-aviso');
  await body.dispatchEvent('dragover', { dataTransfer: transfer });
  await body.dispatchEvent('drop', { dataTransfer: transfer });
  await expect(page.getByText('Solte para anexar', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Remover arrastada.txt' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Mensagem', exact: true }).fill('Leia o arquivo arrastado');
  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeEnabled();
  await page.getByRole('button', { name: 'Enviar mensagem' }).click();
  await expect.poll(async () => JSON.stringify((await (await request.get(`${ORIGIN}/api/bots/${id}/conversation`, { headers })).json()).items)).toContain('arrastada.txt');
  // Arrastar texto (sem arquivos) não ativa o aviso nem intercepta o comportamento padrão.
  const textOnly = await page.evaluateHandle(() => { const data = new DataTransfer(); data.setData('text/plain', 'trecho'); return data; });
  await body.dispatchEvent('dragenter', { dataTransfer: textOnly });
  await expect(page.getByText('Solte para anexar', { exact: true })).toHaveCount(0);
});

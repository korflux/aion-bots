// E2E das versões do Chat geral (phase 4, T4; F1 a F4, A1 a A7) no navegador real, contra a pilha de produção (Postgres, API, worker, Next e
// proxy) com o OpenCode Go e o Composio FALSOS (sem marcador o modelo responde "Resposta: <última mensagem do dono>"; `[demorar]` deixa a execução aberta até o dono parar). O Chat
// geral não tem conector (phase 13, A6), então `[gmail]` não abre mais execução aberta nele: a execução aberta que o bloqueio de F4 exige vem do `[demorar]`.
//
// Uma jornada por teste: editar no lugar (texto e anexos da versão, remover e somar, a recusa de imagem sem visão no campo, Esc devolvendo o foco);
// gerar outra resposta e trocar de versão (contador, anúncio "Versão k de n", foco no seletor) com o bloqueio durante a execução (dica e toast) e
// a liberação ao terminar; retroceder (popup com a contagem, Cancelar devolvendo o foco, a linha "Restaurar", a restauração e a mensagem nova que
// vira versão) e o link de Atividades para a execução que saiu do caminho (toast "Esta atividade está em outra versão da conversa."). Em cada
// estado: axe, sem rolagem horizontal em 375 e 320 px e capturas em 1440, 375 e 320 px; o contexto de toque prova a barra sempre visível.
//
// As sessões são estado global (Atividades lista todas), então o arquivo é serial e roda no projeto `chromium-versions`, depois do chat geral (que
// deixa o provedor configurado e roda a retenção) e antes dos anexos. Cada teste entra UMA vez pela API antes de abrir a tela (E22).
import type { Locator, Page, TestInfo } from '@playwright/test';
import {
  CLIENT_IP_HEADER,
  ORIGIN,
  apiHeaders,
  apiLogin,
  attachShot,
  clientIpFor,
  ensureCredential,
  expect,
  expectNoA11yViolations,
  expectNoHorizontalScroll,
  test,
  watchPage,
} from './support/fixtures';

test.describe.configure({ mode: 'serial' });

const FAKE_PROVIDER = 'valid-e2e-versoes-1111';
const FAKE_CONNECTOR = 'valid-e2e-composio-3333';
const BLOCKED = 'Pare a execução para editar.';

/** Chamadas à API do teste com os cabeçalhos de UM login feito antes de a tela carregar. */
interface Api {
  headers: Record<string, string>;
  /** Sessão nova com o modelo escolhido (a preferência dela). */
  createSession(model?: string): Promise<string>;
  /** Envia pela API e espera a sessão ficar parada (cada mensagem abre uma rodada; com execução ativa ela viraria complemento). */
  say(sessionId: string, content: string): Promise<void>;
  waitIdle(sessionId: string): Promise<void>;
  snapshot(sessionId: string): Promise<{ rounds: { messageId: string; runId: string; messageVersions: string[]; runVersions: string[] }[]; rewound: unknown }>;
}

/** Provedor falso configurado e UM login para o teste inteiro. */
async function setup(page: Page): Promise<Api> {
  await ensureCredential(page, 'provider', FAKE_PROVIDER);
  await ensureCredential(page, 'connector', FAKE_CONNECTOR); // Composio configurado de propósito: mesmo assim o Chat geral não recebe o conector (phase 13, A6)
  const headers = await apiHeaders(page);
  const request = page.context().request;
  const api: Api = {
    headers,
    async createSession(model = 'opencode/glm-5.1') {
      const created = await request.post(`${ORIGIN}/api/chat/sessions`, { headers });
      expect(created.status(), 'criar a sessão').toBe(201);
      const id = ((await created.json()) as { id: string }).id;
      expect((await request.patch(`${ORIGIN}/api/chat/sessions/${id}/conversation`, { headers, data: { model, effort: null } })).status(), 'escolher o modelo').toBe(200);
      return id;
    },
    async say(sessionId, content) {
      const sent = await request.post(`${ORIGIN}/api/chat/sessions/${sessionId}/messages`, { headers, data: { content } });
      expect(sent.status(), 'enviar pela API').toBe(201);
      await api.waitIdle(sessionId);
    },
    async waitIdle(sessionId) {
      await expect
        .poll(async () => ((await (await request.get(`${ORIGIN}/api/chat/sessions/${sessionId}/conversation`, { headers })).json()) as { runs: unknown[] }).runs.length, { timeout: 60_000 })
        .toBe(0);
    },
    async snapshot(sessionId) {
      const response = await request.get(`${ORIGIN}/api/chat/sessions/${sessionId}/conversation`, { headers });
      expect(response.status()).toBe(200);
      return response.json();
    },
  };
  return api;
}

const log = (page: Page) => page.getByRole('log', { name: 'Conversa' });
/** Grupos das mensagens do dono (bolha à direita com a barra) e das respostas, na ordem da conversa. */
// As mensagens do dono são as que têm "Editar" na barra (só o dono edita, no Chat geral); as demais são respostas.
const userGroups = (page: Page) => log(page).locator('.message-group').filter({ has: page.getByRole('button', { name: 'Editar' }) });
const answerGroups = (page: Page) => log(page).locator('.message-group').filter({ hasNot: page.getByRole('button', { name: 'Editar' }) });
const barOf = (group: Locator) => group.locator('[data-message-actions]');
const composer = (page: Page) => page.getByRole('textbox', { name: 'Mensagem', exact: true });

/** Confere a tela em 375 e 320 px (sem rolagem horizontal, axe) com capturas, e volta ao desktop. */
async function narrow(page: Page, testInfo: TestInfo, name: string, target?: Locator): Promise<void> {
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 812 });
    await target?.scrollIntoViewIfNeeded();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
    await attachShot(page, testInfo, `${name}-${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

/** PNG pequeno criado no navegador (a imagem que o modelo sem visão recusa). */
async function png(page: Page) {
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 40;
    canvas.height = 40;
    canvas.getContext('2d')!.fillRect(0, 0, 40, 40);
    return canvas.toDataURL('image/png').split(',')[1]!;
  });
  return { name: 'grafico.png', mimeType: 'image/png', buffer: Buffer.from(data, 'base64') };
}

test('F1: editar no lugar traz texto e anexos da versão, Esc devolve o foco, remove e soma arquivos, recusa imagem sem visão no campo e cria a versão 2/2 sem as rodadas seguintes', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const problems = watchPage(page);
  const api = await setup(page);
  // Modelo sem visão: a imagem somada na edição é recusada no próprio campo.
  const sessionId = await api.createSession('opencode/vision-reject');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/chat/${sessionId}`);

  // Primeira rodada pela tela, com um anexo; a segunda pela API.
  await page.locator('form.composer input[type=file]').setInputFiles({ name: 'nota-a.txt', mimeType: 'text/plain', buffer: Buffer.from('Nota A') });
  await expect(page.getByRole('button', { name: 'Remover nota-a.txt' })).toBeVisible();
  await composer(page).fill('Cv1 primeira pergunta');
  await expect(page.getByRole('button', { name: 'Enviar mensagem' })).toBeEnabled();
  await page.getByRole('button', { name: 'Enviar mensagem' }).click();
  await expect(log(page)).toContainText('Resposta: Cv1 primeira pergunta');
  await api.waitIdle(sessionId);
  await api.say(sessionId, 'Cv1 segunda pergunta');
  await expect(log(page)).toContainText('Resposta: Cv1 segunda pergunta');

  // Editar abre a caixa no lugar com o texto e o anexo da versão; Esc fecha sem mudar nada e o foco volta ao Editar.
  const first = userGroups(page).first();
  await first.hover();
  const editButton = barOf(first).getByRole('button', { name: 'Editar' });
  await editButton.click();
  const form = page.getByRole('form', { name: 'Editar mensagem' });
  const field = form.getByRole('textbox', { name: 'Mensagem editada' });
  await expect(field).toHaveValue('Cv1 primeira pergunta');
  await expect(field).toBeFocused();
  await expect(form.getByRole('button', { name: 'Remover nota-a.txt' })).toBeVisible();
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'versoes-edicao-1440');
  await field.press('Escape');
  await expect(form).toHaveCount(0);
  await expect(editButton).toBeFocused();
  await expect(log(page)).toContainText('Cv1 segunda pergunta');

  // De novo: tira o anexo da versão, soma outro, e a imagem é recusada no campo (modelo sem visão).
  await editButton.click();
  await form.getByRole('button', { name: 'Remover nota-a.txt' }).click();
  await form.locator('input[type=file]').setInputFiles({ name: 'nota-b.txt', mimeType: 'text/plain', buffer: Buffer.from('Nota B') });
  await expect(form.getByRole('button', { name: 'Remover nota-b.txt' })).toBeVisible();
  await form.locator('input[type=file]').setInputFiles(await png(page));
  await expect(form.getByRole('alert')).toHaveText('Este modelo não aceita imagens. Escolha outro modelo.');
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'versoes-edicao-sem-visao-1440');
  await narrow(page, testInfo, 'versoes-edicao-sem-visao', form);
  await form.getByRole('button', { name: 'Remover grafico.png' }).click();
  await field.fill('Cv1 primeira pergunta editada');
  await expect(form.getByRole('button', { name: 'Enviar', exact: true })).toBeEnabled();
  await form.getByRole('button', { name: 'Enviar', exact: true }).click();

  // A versão nova fica no lugar com "2/2", as rodadas seguintes saem da tela e a resposta nova chega.
  await expect(form).toHaveCount(0);
  await expect(log(page)).toContainText('Resposta: Cv1 primeira pergunta editada');
  await expect(log(page)).not.toContainText('Cv1 segunda pergunta');
  await expect(userGroups(page)).toHaveCount(1);
  const edited = userGroups(page).first();
  await expect(barOf(edited).getByRole('group', { name: 'Versão 2 de 2' })).toContainText('2/2');
  await expect(edited.getByRole('link', { name: /nota-b\.txt/ })).toBeVisible();
  await expect(edited.getByText('nota-a.txt')).toHaveCount(0);
  const snapshot = await api.snapshot(sessionId);
  expect(snapshot.rounds).toHaveLength(1);
  expect(snapshot.rounds[0]!.messageVersions).toHaveLength(2);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'versoes-editada-1440');
  await narrow(page, testInfo, 'versoes-editada', edited);

  // Voltar à versão 1 devolve o anexo dela e a segunda rodada (A2).
  await edited.hover();
  await barOf(edited).getByRole('button', { name: 'Versão anterior' }).click();
  await expect(barOf(userGroups(page).first()).getByRole('group', { name: 'Versão 1 de 2' })).toBeVisible();
  await expect(log(page)).toContainText('Cv1 segunda pergunta');
  await expect(userGroups(page).first().getByRole('link', { name: /nota-a\.txt/ })).toBeVisible();
  expect(problems).toEqual([]);
});

test('F2 e F4: gerar outra resposta cria a versão 2/2 da resposta, o seletor troca e anuncia "Versão k de n" com o foco nele; com execução aberta os controles ficam bloqueados com a dica e o toast, e voltam ao terminar', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const problems = watchPage(page);
  const api = await setup(page);
  const sessionId = await api.createSession();
  await api.say(sessionId, 'Cv2 pergunta');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/chat/${sessionId}`);
  await expect(log(page)).toContainText('Resposta: Cv2 pergunta');

  // "Mais ações" da resposta (menu com texto) -> "Gerar outra resposta": a versão nova chega com o seletor 2/2.
  const answer = () => answerGroups(page).last();
  await barOf(answer()).getByRole('button', { name: 'Mais ações' }).click();
  // Sem rodadas depois desta resposta, "Retroceder até aqui" não existe. (O axe roda com o menu fechado: o menu modal do Radix esconde o resto
  // da tela de propósito enquanto está aberto.)
  await expect(page.getByRole('menuitem', { name: 'Retroceder até aqui' })).toHaveCount(0);
  await attachShot(page, testInfo, 'versoes-menu-1440');
  await page.getByRole('menuitem', { name: 'Gerar outra resposta' }).click();
  await expect(barOf(answer()).getByRole('group', { name: 'Versão 2 de 2' })).toBeVisible();
  await api.waitIdle(sessionId);
  await expect(log(page)).toContainText('Resposta: Cv2 pergunta');
  const snapshot = await api.snapshot(sessionId);
  expect(snapshot.rounds[0]!.runVersions).toHaveLength(2);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'versoes-resposta-2de2-1440');

  // Trocar pelo seletor: o contador muda, o leitor de tela ouve "Versão 1 de 2" e o foco fica no seletor (no lado que ainda anda).
  await barOf(answer()).getByRole('button', { name: 'Versão anterior' }).click();
  await expect(barOf(answer()).getByRole('group', { name: 'Versão 1 de 2' })).toContainText('1/2');
  await expect(page.getByRole('status').filter({ hasText: 'Versão 1 de 2' })).toHaveCount(1);
  await expect(barOf(answer()).getByRole('button', { name: 'Próxima versão' })).toBeFocused();
  await expect(barOf(answer()).getByRole('button', { name: 'Versão anterior' })).toBeDisabled();
  await page.keyboard.press('Enter');
  await expect(barOf(answer()).getByRole('group', { name: 'Versão 2 de 2' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Versão 2 de 2' })).toHaveCount(1);
  await expect(barOf(answer()).getByRole('button', { name: 'Versão anterior' })).toBeFocused();
  await narrow(page, testInfo, 'versoes-seletor', answer());

  // Execução aberta (`[demorar]`, que não termina sozinha; a aprovação pendente do Chat geral deixou de existir com o conector, A6): o seletor, o Editar e os itens do menu ficam
  // aria-disabled (focáveis), a dica explica e o toque mostra o toast. Copiar não. O que o bloqueio exige é a execução aberta, não o motivo dela.
  const firstAnswer = answerGroups(page).first();
  const owner = userGroups(page).first();
  await composer(page).fill('[demorar] Cv2 trabalhando sem fim');
  await page.getByRole('button', { name: 'Enviar mensagem' }).click();
  await expect(page.locator('[data-working-line]').getByText('Trabalhando…')).toBeVisible();
  const ownerEdit = barOf(owner).getByRole('button', { name: 'Editar' });
  await expect(ownerEdit).toHaveAttribute('aria-disabled', 'true');
  await expect(barOf(firstAnswer).getByRole('button', { name: 'Versão anterior' })).toHaveAttribute('aria-disabled', 'true');
  await expect(barOf(owner).getByRole('button', { name: 'Copiar' })).not.toHaveAttribute('aria-disabled', 'true');
  await owner.hover();
  await ownerEdit.hover();
  await expect(page.getByRole('tooltip')).toHaveText(BLOCKED);
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'versoes-bloqueado-1440');
  // `force`: o Playwright trata aria-disabled como desabilitado e esperaria; o dono consegue tocar e o produto responde com o toast.
  await ownerEdit.click({ force: true });
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: BLOCKED })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Editar mensagem' })).toHaveCount(0);
  await firstAnswer.hover();
  await barOf(firstAnswer).getByRole('button', { name: 'Mais ações' }).click();
  await expect(page.getByRole('menuitem', { name: 'Gerar outra resposta' })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await narrow(page, testInfo, 'versoes-bloqueado', owner);

  // Parar a execução a encerra, e os controles voltam.
  await page.getByRole('button', { name: 'Parar execução' }).click();
  await api.waitIdle(sessionId);
  await expect(ownerEdit).not.toHaveAttribute('aria-disabled', 'true');
  await expect(barOf(firstAnswer).getByRole('button', { name: 'Versão anterior' })).not.toHaveAttribute('aria-disabled', 'true');
  expect(problems).toEqual([]);
});

test('F3: retroceder pede confirmação com a contagem (Cancelar devolve o foco), tira as rodadas da tela com a linha "Restaurar", restaura, e a mensagem nova vira versão; Atividades leva à execução fora do caminho com o aviso', async ({ page, browser }, testInfo) => {
  test.setTimeout(180_000);
  const problems = watchPage(page);
  const api = await setup(page);
  const sessionId = await api.createSession();
  for (const text of ['Cv3 um', 'Cv3 dois', 'Cv3 três']) await api.say(sessionId, text);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/chat/${sessionId}`);
  await expect(log(page)).toContainText('Resposta: Cv3 três');

  // Popup com a contagem; Cancelar fecha e devolve o foco ao "Mais ações" que o abriu.
  const firstAnswer = answerGroups(page).first();
  await firstAnswer.hover();
  const more = barOf(firstAnswer).getByRole('button', { name: 'Mais ações' });
  await more.click();
  await page.getByRole('menuitem', { name: 'Retroceder até aqui' }).click();
  const dialog = page.getByRole('dialog', { name: 'Retroceder até esta resposta?' });
  await expect(dialog).toContainText('2 rodadas saem do contexto e continuam recuperáveis pelas versões. Ações já executadas, como envios pelo Composio, não são desfeitas.');
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'versoes-retroceder-popup-1440');
  await narrow(page, testInfo, 'versoes-retroceder-popup');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(more).toBeFocused();
  await expect(log(page)).toContainText('Cv3 três');

  // Confirmar: as rodadas seguintes saem da tela e a linha "2 rodadas retrocedidas · Restaurar" fecha a conversa.
  await more.click();
  await page.getByRole('menuitem', { name: 'Retroceder até aqui' }).click();
  await dialog.getByRole('button', { name: 'Retroceder' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(log(page)).not.toContainText('Cv3 dois');
  const rewound = log(page).locator('[data-rewound]');
  await expect(rewound).toContainText('2 rodadas retrocedidas');
  await expect(composer(page)).toBeEnabled();
  expect((await api.snapshot(sessionId)).rewound).toMatchObject({ rounds: 2 });
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'versoes-retrocedido-1440');
  await narrow(page, testInfo, 'versoes-retrocedido', rewound);

  // Restaurar devolve o caminho anterior inteiro.
  await rewound.getByRole('button', { name: 'Restaurar' }).click();
  await expect(log(page)).toContainText('Resposta: Cv3 três');
  await expect(rewound).toHaveCount(0);
  await attachShot(page, testInfo, 'versoes-restaurado-1440');

  // Retroceder e enviar: a mensagem nova vira a versão 2/2 ao lado da primeira rodada retrocedida, e a linha some.
  await firstAnswer.hover();
  await more.click();
  await page.getByRole('menuitem', { name: 'Retroceder até aqui' }).click();
  await dialog.getByRole('button', { name: 'Retroceder' }).click();
  await expect(rewound).toBeVisible();
  await composer(page).fill('Cv3 caminho novo');
  await page.getByRole('button', { name: 'Enviar mensagem' }).click();
  await expect(rewound).toHaveCount(0);
  await expect(log(page)).toContainText('Resposta: Cv3 caminho novo');
  await api.waitIdle(sessionId);
  await expect(barOf(userGroups(page).nth(1)).getByRole('group', { name: 'Versão 2 de 2' })).toBeVisible();
  await expect(log(page)).not.toContainText('Cv3 três');
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'versoes-depois-de-retroceder-1440');

  // Toque (celular): as barras das mensagens do dono e da última resposta ficam sempre visíveis, com alvos de 40 px; a da resposta antiga aparece ao tocar nela.
  const touch = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 375, height: 812 }, extraHTTPHeaders: { [CLIENT_IP_HEADER]: clientIpFor(`${testInfo.testId}:toque`) } });
  try {
    await apiLogin(touch);
    const phone = await touch.newPage();
    const phoneProblems = watchPage(phone);
    await phone.goto(`/chat/${sessionId}`);
    await expect(log(phone)).toContainText('Resposta: Cv3 caminho novo');
    // A16 (phase 18): as barras das mensagens do dono e da última resposta ficam sempre visíveis; a da resposta antiga aparece só depois do toque nela.
    for (const group of [userGroups(phone).first(), answerGroups(phone).last(), userGroups(phone).nth(1)]) await expect(barOf(group)).toHaveCSS('opacity', '1');
    await expect(answerGroups(phone)).toHaveCount(2);
    await expect(barOf(answerGroups(phone).first())).toBeHidden();
    await answerGroups(phone).first().locator('.markdown').first().tap();
    await expect(barOf(answerGroups(phone).first())).toBeVisible();
    expect((await barOf(userGroups(phone).nth(1)).getByRole('button', { name: 'Próxima versão' }).boundingBox())!.height, 'alvo de 40 px no toque').toBeGreaterThanOrEqual(40);
    await expectNoHorizontalScroll(phone);
    await expectNoA11yViolations(phone);
    await attachShot(phone, testInfo, 'versoes-375-toque');
    expect(phoneProblems).toEqual([]);
  } finally {
    await touch.close();
  }

  // A execução da rodada "Cv3 dois" saiu do caminho: em Atividades o link abre a sessão e avisa que ela está em outra versão.
  await page.goto('/configuracoes/atividades');
  const offPath = page.locator(`a[href="/chat/${sessionId}?versao=outra"]`).first();
  await expect(offPath).toBeVisible();
  await offPath.click();
  await expect(page).toHaveURL(new RegExp(`/chat/${sessionId}\\?versao=outra$`));
  await expect(page.getByText('Esta atividade está em outra versão da conversa.', { exact: true })).toBeVisible();
  await expect(log(page)).toContainText('Resposta: Cv3 caminho novo');
  await expectNoA11yViolations(page);
  await attachShot(page, testInfo, 'versoes-atividade-fora-do-caminho-1440');
  expect(problems).toEqual([]);
});

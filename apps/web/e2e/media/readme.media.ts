// Gerador das capturas e do GIF do README (`pnpm --filter @aion/web media:readme`, config `playwright.media.config.ts`).
//
// Fluxo: semeia pela API uma conta de demonstração (nome do dono, chaves falsas, cinco bots, rotinas, um doc e uma aprovação pendente),
// captura as telas em 1440x900 e 390x844 e grava em vídeo o fluxo "pedido -> aprovação -> resposta", convertido em GIF pelo ffmpeg do PATH.
// A interface é a real; só o texto é de demonstração. O modelo falso é comandado por marcadores no texto da mensagem (`[gmail]`,
// `[rotina:...]`) e responde "Resposta: <pedido>", então `DISPLAY_RULES` reescreve esses textos NA TELA (só no DOM do navegador, nunca no
// banco) para a conversa ler como uma conversa de verdade. Ao mudar a tela, rode de novo e confira as imagens antes de commitar.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { apiHeaders, ensureCredential, expect, ORIGIN, releaseConnectorAccounts, test, waitForHydration } from '../support/fixtures';

const OUT = fileURLToPath(new URL('../../../../docs/media/', import.meta.url));
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

/** Pedido do GIF: o texto digitado na tela, que a rota de envio completa com o marcador antes de chegar à API. */
const GIF_REQUEST = 'Envia o resumo da semana para a equipe por e-mail.';

/**
 * Regras de exibição, aplicadas em ordem a cada nó de texto (e a cada nó novo, por MutationObserver). O marcador some do pedido, e a
 * resposta-eco do modelo falso vira a resposta de demonstração do pedido correspondente.
 */
const DISPLAY_RULES: [string, string][] = [
  // Depois da ação aprovada, o modelo falso ecoa o resultado do Composio falso.
  ['^Encontrei: Resultado do conector[\\s\\S]*$', 'Pronto. Enviei o resumo da semana para a equipe, com os três destaques e os próximos passos.'],
  ['^Resposta: Resume os e-mails.*$', 'Li 14 e-mails novos. Dois pedem resposta hoje: o contrato da agência e a reunião de quinta.'],
  ['^Resposta: Organiza o roteiro.*$', 'Montei o roteiro de Lisboa em 4 dias e salvei no doc "Viagem a Lisboa".'],
  ['^Resposta: Monta um plano.*$', 'Plano de estudos pronto: 3 blocos por semana, com revisão aos domingos.'],
  // Depois de criar a rotina, o modelo falso ecoa o resultado da ferramenta ("Encontrei: Rotina criada e ATIVA: ...").
  ['^Encontrei: Rotina criada e ATIVA: "([^"]+)".*$', 'Pronto: criei a rotina "$1", que já está valendo. Se não quiser, recuse ou edite pelo cartão.'],
  ['\\s*\\[(?:gmail|rotina:[^\\]]*)\\]', ''],
  ['^opencode/', ''],
];

/** Instala as regras de exibição antes de qualquer script da página. Roda no navegador. */
async function installDisplayRules(page: Page): Promise<void> {
  await page.addInitScript((rules: [string, string][]) => {
    const compiled = rules.map(([source, replacement]) => [new RegExp(source, 'g'), replacement] as const);
    const rewrite = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        let text = node.textContent ?? '';
        for (const [pattern, replacement] of compiled) text = text.replace(pattern, replacement);
        if (text !== node.textContent) node.textContent = text;
        return;
      }
      if (node.nodeName === 'TEXTAREA' || node.nodeName === 'INPUT') return;
      node.childNodes.forEach(rewrite);
    };
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'characterData') rewrite(record.target);
        record.addedNodes.forEach(rewrite);
      }
    }).observe(document, { subtree: true, childList: true, characterData: true });
    document.addEventListener('DOMContentLoaded', () => rewrite(document.body));
  }, DISPLAY_RULES);
}

type Headers = Record<string, string>;

async function createBot(page: Page, headers: Headers, name: string, color: string): Promise<string> {
  const response = await page.context().request.post(`${ORIGIN}/api/bots`, {
    headers,
    data: { name, color, instructions: '', model: 'opencode/deepseek-v4.1-flash', effort: null, stepLimit: 25 },
  });
  expect(response.status(), `criar ${name}`).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function say(page: Page, headers: Headers, botId: string, content: string): Promise<void> {
  const response = await page.context().request.post(`${ORIGIN}/api/bots/${botId}/messages`, { headers, data: { content } });
  expect(response.status(), 'enviar mensagem').toBe(201);
}

/** Espera a conversa do bot conter o trecho (resposta final ou cartão), lendo a API. */
async function waitConversation(page: Page, headers: Headers, botId: string, fragment: string): Promise<void> {
  await expect
    .poll(async () => JSON.stringify(await (await page.context().request.get(`${ORIGIN}/api/bots/${botId}/conversation`, { headers })).json()).includes(fragment), {
      timeout: 60_000,
    })
    .toBe(true);
}

async function shot(page: Page, name: string): Promise<void> {
  // A Faísca e os indicadores animam; meio segundo deixa a tela assentar depois da navegação.
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
}

test('capturas e GIF do README', async ({ page, browser }) => {
  mkdirSync(OUT, { recursive: true });
  await page.setViewportSize(DESKTOP);
  await installDisplayRules(page);

  // Semeadura: dono, chaves falsas (o provedor e o Composio falsos aceitam `valid-*`) e cinco bots.
  await ensureCredential(page, 'provider', 'valid-media-provider-1111', { replace: true });
  await ensureCredential(page, 'connector', 'valid-media-composio-2222', { replace: true });
  const headers = await apiHeaders(page);
  const settings = (await (await page.context().request.get(`${ORIGIN}/api/settings`, { headers })).json()) as Record<string, unknown>;
  await page.context().request.put(`${ORIGIN}/api/settings`, { headers, data: { ...settings, ownerName: 'Alex', timeZone: 'America/Sao_Paulo' } });

  const mail = await createBot(page, headers, 'Assistente de e-mail', '#60A5FA');
  const finance = await createBot(page, headers, 'Financeiro', '#4ADE80');
  const news = await createBot(page, headers, 'Notícias', '#F472B6');
  const travel = await createBot(page, headers, 'Viagens', '#FB923C');
  const study = await createBot(page, headers, 'Estudos', '#A78BFA');
  await releaseConnectorAccounts(page, mail, undefined, headers);
  await releaseConnectorAccounts(page, finance, undefined, headers);
  // Nome da conta do Gmail no Aion (sem ele, a tela mostra o rótulo automático "Gmail · ca_…1").
  const accounts = (await (await page.context().request.get(`${ORIGIN}/api/connector/accounts`, { headers })).json()) as { accounts: { id: string; version: number }[] };
  const gmail = accounts.accounts.find((account) => account.id === 'ca_1')!;
  await page.context().request.patch(`${ORIGIN}/api/connector/accounts/ca_1`, { headers, data: { name: 'Gmail pessoal', expectedVersion: gmail.version } });
  // Modelo padrão do Chat geral (sem ele o Início pede para defini-lo) e o convite de objetivo já apresentado (sem a faixa no topo da conversa).
  await page.context().request.put(`${ORIGIN}/api/chat/settings`, { headers, data: { model: 'opencode/deepseek-v4.1-flash', effort: null } });
  for (const bot of [mail, finance, news, travel, study]) await page.context().request.post(`${ORIGIN}/api/bots/${bot}/objective/invitation`, { headers, data: {} });
  await say(page, headers, mail, 'Resume os e-mails de hoje.');
  await waitConversation(page, headers, mail, 'Resposta:');

  await say(page, headers, news, 'Quero receber as notícias do mercado toda manhã [rotina:Notícias do mercado|07:30]');
  await say(page, headers, finance, 'Me lembra de revisar o orçamento toda sexta [rotina:Revisar orçamento|17:00]');
  await say(page, headers, travel, 'Organiza o roteiro de Lisboa em 4 dias.');
  await say(page, headers, study, 'Monta um plano de estudos de estatística.');
  await waitConversation(page, headers, news, 'Notícias do mercado');
  await waitConversation(page, headers, finance, 'Revisar orçamento');
  await waitConversation(page, headers, travel, 'Resposta:');
  await waitConversation(page, headers, study, 'Resposta:');
  // Pendência no Início: o Financeiro pede para enviar um e-mail e fica aguardando a aprovação.
  await say(page, headers, finance, 'Manda o relatório de gastos para a contabilidade [gmail]');
  await waitConversation(page, headers, finance, '"status":"pending"');

  const doc = await page.context().request.post(`${ORIGIN}/api/docs`, {
    headers,
    data: {
      title: 'Viagem a Lisboa',
      content: [
        '# Viagem a Lisboa',
        '',
        'Roteiro de 4 dias, montado pelo bot **Viagens**.',
        '',
        '| Dia | Manhã | Tarde |',
        '|---|---|---|',
        '| 1 | Alfama e Castelo de São Jorge | Miradouro da Graça |',
        '| 2 | Belém e Jerónimos | LX Factory |',
        '| 3 | Sintra | Cabo da Roca |',
        '| 4 | Chiado e Bairro Alto | Pôr do sol no Tejo |',
        '',
        '## Pendências',
        '',
        '- [x] Passagens',
        '- [ ] Reservar o hotel em Alfama',
        '- [ ] Comprar o passe de transporte',
      ].join('\n'),
      botIds: [travel],
      operationId: randomUUID(),
    },
  });
  expect(doc.status(), 'criar o doc').toBe(201);
  const docId = ((await doc.json()) as { id: string }).id;

  // Telas no desktop.
  await page.goto('/');
  await expect(page.getByText('Como posso ajudar?')).toBeVisible();
  await shot(page, 'inicio');

  await page.goto(`/bots/${finance}`);
  await expect(page.getByRole('region', { name: 'Aprovação pendente' })).toBeVisible();
  await shot(page, 'aprovacao');

  await page.goto(`/bots/${news}`);
  await expect(page.getByText('Notícias do mercado').first()).toBeVisible();
  await shot(page, 'rotina');

  await page.goto('/rotinas');
  await shot(page, 'rotinas');

  await page.goto(`/artefatos/docs/${docId}`);
  await expect(page.getByText('Alfama e Castelo de São Jorge')).toBeVisible();
  await shot(page, 'doc');

  await page.goto('/artefatos');
  await shot(page, 'artefatos');

  // Celular.
  await page.setViewportSize(MOBILE);
  await page.goto('/');
  await expect(page.getByText('Como posso ajudar?')).toBeVisible();
  await shot(page, 'celular-inicio');
  await page.goto(`/bots/${finance}`);
  await expect(page.getByRole('region', { name: 'Aprovação pendente' })).toBeVisible();
  await shot(page, 'celular-aprovacao');

  // GIF: o dono pede pelo composer, o bot trabalha, pede aprovação, o dono permite e o bot conclui. A rota de envio acrescenta o
  // marcador do modelo falso ao texto digitado, e as regras de exibição o escondem de volta.
  const videoDir = join(OUT, '.video');
  rmSync(videoDir, { recursive: true, force: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 760 },
    recordVideo: { dir: videoDir, size: { width: 1280, height: 760 } },
    colorScheme: 'dark',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    storageState: await page.context().storageState(),
  });
  const demo = await context.newPage();
  await installDisplayRules(demo);
  await demo.route('**/api/bots/*/messages', async (route) => {
    const body = route.request().postDataJSON() as { content?: string } | null;
    if (route.request().method() !== 'POST' || !body?.content) return route.continue();
    await route.continue({ postData: JSON.stringify({ ...body, content: `${body.content} [gmail]` }) });
  });
  await demo.goto(`/bots/${mail}`);
  const composer = demo.getByRole('textbox', { name: 'Mensagem' });
  await waitForHydration(composer);
  await demo.waitForTimeout(700);
  await composer.pressSequentially(GIF_REQUEST, { delay: 35 });
  await demo.waitForTimeout(300);
  await composer.press('Enter');
  const card = demo.getByRole('region', { name: 'Aprovação pendente' });
  await expect(card).toBeVisible();
  await demo.waitForTimeout(1800);
  await card.getByRole('button', { name: 'Permitir uma vez' }).hover();
  await demo.waitForTimeout(500);
  await card.getByRole('button', { name: 'Permitir uma vez' }).click();
  await expect(demo.getByText(/^Trabalhou por/)).toBeVisible();
  await demo.waitForTimeout(2500);
  await context.close();

  const [video] = readdirSync(videoDir).filter((file) => file.endsWith('.webm'));
  expect(video, 'vídeo gravado').toBeDefined();
  const palette = join(videoDir, 'palette.png');
  const filters = 'fps=12,scale=960:-1:flags=lanczos';
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(videoDir, video!), '-vf', `${filters},palettegen=stats_mode=diff`, palette]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(videoDir, video!), '-i', palette, '-lavfi', `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5`, join(OUT, 'demo-aprovacao.gif')]);
  rmSync(videoDir, { recursive: true, force: true });
});

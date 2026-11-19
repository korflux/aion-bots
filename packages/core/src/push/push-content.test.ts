// Prova do conteúdo do aviso (phase 16, passo 4; NOTIF-02, SEC-07; A3, A4, A5) contra PostgreSQL real, o motor de execução real, o provedor falso e o FCM falso:
// o texto só sai pela conferência do service worker (`PushService.checkEvents`), para evento VÁLIDO e com a chave "Mostrar conteúdo" da origem ligada, e nunca vai ao
// FCM, ao log nem à auditoria. Cada tipo de evento tem título e corpo em texto puro de até 160 caracteres; chave desligada, evento inválido e conteúdo que não se monta
// ficam no genérico (sem título, corpo nem id de aprovação). Os casos de borda do corte em palavra são de `clipAtWord`, sem banco.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ERROR_CODES, PUSH_CONTENT_MAX, PUSH_EVENT_LABELS, type PushEventCheck } from '@aion/shared';
import type { FcmServiceAccount } from '../config';
import { createLogger } from '../logging';
import { ORIGIN, createRunsWorld, type RunsWorld } from '../runs/test-support';
import { GeneralChatService } from '../general-chat/service';
import { seedLegacyChatApproval } from '../testing/legacy-chat-approval';
import { generateKeyPairSync } from 'node:crypto';
import { clipAtWord } from './content';
import { createFcmClient } from './fcm';
import { PushDispatcher } from './dispatcher';
import { PushService } from './service';

const ACCOUNT: FcmServiceAccount = {
  projectId: 'aion-test',
  clientEmail: 'push@aion-test.iam.gserviceaccount.com',
  privateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};

let world: RunsWorld;
let push: PushService;

beforeAll(async () => {
  world = await createRunsWorld({ engine: { approvalSweepMs: 40 } });
  await world.connectComposio();
  push = new PushService({ pool: world.pool, config: { enabled: false } });
  world.engine.start();
});

afterAll(async () => {
  await world.cleanup();
});

/** Cada teste começa com os dois interruptores no padrão (ligados), um dispositivo e sem eventos nem mensagens anteriores no FCM falso. */
beforeEach(async () => {
  await world.pool.query('UPDATE app_settings SET push_content_bots = true, push_content_general_chat = true');
  await world.pool.query('DELETE FROM push_events');
  await world.pool.query('DELETE FROM push_devices');
  await world.pool.query('DELETE FROM app_opened');
  world.upstreams.fcmMessages.length = 0;
  await push.registerDevice('device-content', ORIGIN);
});

const eventOf = async (runId: string, kind: string): Promise<string> =>
  (await world.pool.query<{ id: string }>('SELECT id::text AS id FROM push_events WHERE run_id = $1 AND kind = $2 ORDER BY id DESC LIMIT 1', [runId, kind])).rows[0]!.id;

/** A conferência de UM evento, com uma sessão nova a cada chamada (o limite é por sessão). */
const checkOne = async (eventId: string): Promise<PushEventCheck['events'][number]> => (await push.checkEvents(randomUUID(), [eventId])).events[0]!;

/** Troca o texto da resposta final do bot: dá controle total do que o aviso deve resumir. */
const setReply = async (runId: string, content: string): Promise<void> => {
  await world.pool.query("UPDATE messages SET content = $2 WHERE id = (SELECT max(id) FROM messages WHERE run_id = $1 AND kind = 'text' AND status <> 'discarded')", [runId, content]);
};

/** O texto puro do aviso: sem marcação, sem quebra de linha nem caractere de controle, até o limite. */
function expectPlain(text: string | undefined): asserts text is string {
  expect(text).toBeTypeOf('string');
  expect(Array.from(text as string).length).toBeLessThanOrEqual(PUSH_CONTENT_MAX);
  expect(text).not.toMatch(/[*`[\]<>#~\n\r\t]/);
  expect(text).not.toMatch(/\p{Cc}/u);
}

describe('clipAtWord', () => {
  it('não mexe no que cabe, corta em palavra com reticências dentro do limite e nunca parte um ponto de código', () => {
    expect(clipAtWord('curto', 160)).toBe('curto');
    const exact = 'a'.repeat(160);
    expect(clipAtWord(exact, 160)).toBe(exact);

    const words = Array.from({ length: 80 }, (_, index) => `palavra${index}`).join(' ');
    const clipped = clipAtWord(words, 160);
    expect(Array.from(clipped).length).toBeLessThanOrEqual(160);
    expect(clipped.endsWith('…')).toBe(true);
    // Termina numa palavra inteira: o que precede as reticências é um prefixo do texto que acaba antes de um espaço.
    const body = clipped.slice(0, -1);
    expect(words.startsWith(body)).toBe(true);
    expect(words[body.length]).toBe(' ');
    expect(body.endsWith(' ')).toBe(false);

    // Uma palavra só maior que o limite: corte duro, ainda dentro do limite.
    const long = clipAtWord('x'.repeat(300), 160);
    expect(Array.from(long)).toHaveLength(160);
    expect(long.endsWith('…')).toBe(true);

    // Emoji (par substituto) na fronteira: nunca vira metade de caractere.
    const emoji = clipAtWord('😀'.repeat(200), 160);
    expect(Array.from(emoji)).toHaveLength(160);
    expect(emoji).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});

describe('A3: com a chave ligada, o aviso de cada tipo de evento traz título e corpo em texto puro de até 160 caracteres', () => {
  it('run_completed de um bot: o título é o nome do bot e o corpo é o começo da resposta sem Markdown, cortado em palavra com reticências', async () => {
    const bot = await world.createBot({ name: 'Bot do conteúdo' });
    const runId = await world.send(bot, 'pergunta qualquer');
    await world.waitForStatus(runId, 'completed');
    const filler = Array.from({ length: 60 }, (_, index) => `detalhe${index}`).join(' ');
    await setReply(runId, `**Pronto**: o [relatório de vendas](https://exemplo.test/x) ficou \`pronto\` e ${filler}\n\nSegunda linha que não entra.`);

    const check = await checkOne(await eventOf(runId, 'run_completed'));
    expect(check.valid).toBe(true);
    expect(check.title).toBe('Bot do conteúdo');
    expectPlain(check.body);
    expect(check.body.startsWith('Pronto: o relatório de vendas ficou pronto e detalhe0 detalhe1')).toBe(true);
    expect(check.body.endsWith('…')).toBe(true);
    expect(check.body).not.toContain('Segunda linha');
    expect(check.approvalId).toBeUndefined();
  });

  it('run_completed: uma resposta curta vai inteira, e sem texto aproveitável o corpo volta ao tipo do evento', async () => {
    const bot = await world.createBot();
    const runId = await world.send(bot, 'outra pergunta');
    await world.waitForStatus(runId, 'completed');
    await setReply(runId, 'Tudo certo por aqui.');
    expect((await checkOne(await eventOf(runId, 'run_completed'))).body).toBe('Tudo certo por aqui.');

    await setReply(runId, '```\n```');
    const bare = await checkOne(await eventOf(runId, 'run_completed'));
    expect(bare.body).toBe(PUSH_EVENT_LABELS.run_completed);
    expect(bare.title).toBe(bot.name);
  });

  it('run_failed e limite atingido: o corpo é o título do cartão e, na falha, o motivo seguro do código (o texto público do registro de erros)', async () => {
    const failing = await world.createBot({ name: 'Bot que falha' });
    const failedRun = await world.send(failing, '[falha] provedor fora');
    await world.waitForStatus(failedRun, 'failed');
    const failed = await checkOne(await eventOf(failedRun, 'run_failed'));
    expectPlain(failed.body);
    expect(failed.title).toBe('Bot que falha');
    const code = (await world.pool.query<{ failure_code: string }>('SELECT failure_code FROM runs WHERE id = $1', [failedRun])).rows[0]!.failure_code as keyof typeof ERROR_CODES;
    expect(ERROR_CODES[code]).toBeDefined();
    expect(failed.body.startsWith('A execução falhou: ')).toBe(true);
    expect(failed.body.slice('A execução falhou: '.length)).toBe(clipAtWord(ERROR_CODES[code].message, PUSH_CONTENT_MAX - 'A execução falhou: '.length));

    const limited = await world.createBot({ stepLimit: 2 });
    const limitedRun = await world.send(limited, '[loop] sem parar');
    await world.waitForStatus(limitedRun, 'limit_reached');
    expect((await checkOne(await eventOf(limitedRun, 'run_failed'))).body).toBe('Limite atingido');
  });

  it('rotina: o corpo é o nome e o desfecho, com o motivo seguro na falha', async () => {
    const bot = await world.createBot({ name: 'Bot da rotina' });
    const routine = await world.routines.create(
      { name: 'Resumo', botId: bot.id, instruction: '[falha] rotina', schedule: { type: 'daily', times: ['07:00'] }, timezone: 'America/Sao_Paulo', startsAt: null, endsAt: null, maxRuns: null },
      ORIGIN,
    );
    const failedRun = (await world.routines.runNow(routine.id, ORIGIN)).id;
    await world.waitForStatus(failedRun, 'failed');
    const failed = await checkOne(await eventOf(failedRun, 'run_failed'));
    expectPlain(failed.body);
    expect(failed.title).toBe('Bot da rotina');
    expect(failed.body.startsWith('Rotina “Resumo” falhou: ')).toBe(true);

    const good = await world.routines.create(
      { name: 'Bom dia', botId: bot.id, instruction: 'diga ok', schedule: { type: 'daily', times: ['07:00'] }, timezone: 'America/Sao_Paulo', startsAt: null, endsAt: null, maxRuns: null },
      ORIGIN,
    );
    const doneRun = (await world.routines.runNow(good.id, ORIGIN)).id;
    await world.waitForStatus(doneRun, 'completed');
    expect((await checkOne(await eventOf(doneRun, 'run_completed'))).body).toBe('Rotina “Bom dia” concluída');
  });

  it('approval_pending e approval_expired: o corpo é a ação e o nome da conta como no cartão, e só o pendente válido leva o id da aprovação', async () => {
    const bot = await world.createBot({ name: 'Bot que pede' });
    await world.releaseConnectorAccounts(bot);
    const runId = await world.send(bot, '[gmail] enviar');
    await world.waitForStatus(runId, 'waiting_approval');
    const approval = (await world.approvalOf(runId))!;
    const card = (await world.pool.query<{ data: { actionLabel: string; accountLabel?: string } }>("SELECT data FROM messages WHERE run_id = $1 AND data->>'type' = 'approval'", [runId])).rows[0]!.data;
    expect(card.accountLabel).toBeTruthy();
    const what = `${card.actionLabel} · ${card.accountLabel}`;

    const pending = await checkOne(await eventOf(runId, 'approval_pending'));
    expect(pending).toMatchObject({ valid: true, title: 'Bot que pede', body: `Aprovação pendente: ${what}`, approvalId: String(approval.id) });
    expectPlain(pending.body);

    await world.pool.query("UPDATE approvals SET expires_at = now() - interval '1 second' WHERE id = $1", [approval.id]);
    await world.waitForStatus(runId, 'expired');
    const expired = await checkOne(await eventOf(runId, 'approval_expired'));
    expect(expired).toMatchObject({ valid: true, title: 'Bot que pede', body: `Aprovação expirada: ${what}` });
    expect(expired.approvalId).toBeUndefined();
    // O pedido que já não está pendente é inválido: sem texto e sem id, mesmo com a chave ligada.
    const stale = await checkOne(await eventOf(runId, 'approval_pending'));
    expect(stale).toEqual({ id: stale.id, valid: false });
  });

  it('Chat geral: o título é "Chat geral" (nunca o da sessão) e o corpo segue o mesmo tipo', async () => {
    const session = await new GeneralChatService({ pool: world.pool }).create();
    await world.conversations.setPreference({ sessionId: session.id }, 'opencode/glm-5.1', null);
    const done = (await world.conversations.send({ sessionId: session.id }, 'assunto-sigiloso-do-titulo-999')).id;
    await world.waitForStatus(done, 'completed');
    await setReply(done, 'Resposta do chat geral.');
    const asking = (await seedLegacyChatApproval({ pool: world.pool, approvals: world.approvals, sessionId: session.id, input: '[gmail] enviar', queuePush: true })).runId;

    const completed = await checkOne(await eventOf(done, 'run_completed'));
    expect(completed).toMatchObject({ valid: true, title: 'Chat geral', body: 'Resposta do chat geral.' });
    const pending = await checkOne(await eventOf(asking, 'approval_pending'));
    expect(pending.title).toBe('Chat geral');
    expect(pending.body?.startsWith('Aprovação pendente: ')).toBe(true);
    expect(pending.approvalId).toBe(String((await world.approvalOf(asking))!.id));
    await world.conversations.stop({ sessionId: session.id });
  });
});

describe('A4: com a chave desligada, ou com o evento inválido, a conferência não devolve conteúdo', () => {
  it('cada chave vale só para a sua origem: bots desligada deixa o Chat geral com conteúdo, e vice-versa; desligada não leva título, corpo nem id de aprovação', async () => {
    const bot = await world.createBot({ name: 'Bot das chaves' });
    await world.releaseConnectorAccounts(bot);
    const runId = await world.send(bot, '[gmail] enviar');
    await world.waitForStatus(runId, 'waiting_approval');
    const session = await new GeneralChatService({ pool: world.pool }).create();
    await world.conversations.setPreference({ sessionId: session.id }, 'opencode/glm-5.1', null);
    const chatRun = (await world.conversations.send({ sessionId: session.id }, 'oi')).id;
    await world.waitForStatus(chatRun, 'completed');
    const botEvent = await eventOf(runId, 'approval_pending');
    const chatEvent = await eventOf(chatRun, 'run_completed');

    await push.setContent('bots', false, ORIGIN);
    const botOff = await checkOne(botEvent);
    expect(botOff).toEqual({ id: botEvent, valid: true });
    expect((await checkOne(chatEvent)).title).toBe('Chat geral');

    await push.setContent('bots', true, ORIGIN);
    await push.setContent('general_chat', false, ORIGIN);
    expect((await checkOne(botEvent)).approvalId).toBeTruthy();
    expect(await checkOne(chatEvent)).toEqual({ id: chatEvent, valid: true });
  });

  it('o evento que não vale mais (conversa lida, silenciado) e o id desconhecido voltam só { id, valid: false }, sem conteúdo', async () => {
    const bot = await world.createBot();
    const runId = await world.send(bot, 'uma pergunta');
    await world.waitForStatus(runId, 'completed');
    const eventId = await eventOf(runId, 'run_completed');
    expect((await checkOne(eventId)).title).toBe(bot.name);

    await push.setMute(bot.id, 'run_completed', true, ORIGIN);
    expect(await checkOne(eventId)).toEqual({ id: eventId, valid: false });
    await push.setMute(bot.id, 'run_completed', false, ORIGIN);
    expect((await checkOne('999999999')).valid).toBe(false);
    expect(await checkOne('999999999')).toEqual({ id: '999999999', valid: false });
  });
});

describe('A5: o texto da conversa entregue num aviso não aparece no payload do FCM, nos logs nem na auditoria', () => {
  it('o texto chega só na resposta da conferência; o FCM, as linhas de log do envio e do servidor e toda a trilha de auditoria ficam sem ele', async () => {
    const marker = 'texto-secreto-da-resposta-A5-424242';
    const bot = await world.createBot({ name: 'Bot do A5' });
    const runId = await world.send(bot, 'pedido-secreto-do-dono-A5-737373');
    await world.waitForStatus(runId, 'completed');
    await setReply(runId, `${marker} e o resto da resposta`);

    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', name: 'push-content', destination: { write: (line: string) => void lines.push(line) } });
    const fcm = createFcmClient({ serviceAccount: ACCOUNT, baseUrl: world.upstreams.fcmBaseUrl, tokenUrl: world.upstreams.fcmTokenUrl });
    expect(await new PushDispatcher({ pool: world.pool, fcm, logger }).tickOnce()).toBe(1);
    expect(world.upstreams.fcmMessages).toHaveLength(1);

    // A conferência (o único canal do texto) o traz de fato: a prova abaixo não é vazia.
    const check = await checkOne(await eventOf(runId, 'run_completed'));
    expect(check.body).toBe(`${marker} e o resto da resposta`);
    await push.setContent('bots', false, ORIGIN);
    await push.setContent('bots', true, ORIGIN);

    const fcmPayload = JSON.stringify(world.upstreams.fcmMessages.map((message) => message.message));
    const audit = JSON.stringify((await world.pool.query('SELECT * FROM audit_log')).rows);
    for (const secret of [marker, 'pedido-secreto-do-dono-A5-737373']) {
      expect(fcmPayload, `FCM com ${secret}`).not.toContain(secret);
      expect(lines.join(''), `log com ${secret}`).not.toContain(secret);
      expect(audit, `auditoria com ${secret}`).not.toContain(secret);
    }
    // O que o FCM leva continua sendo o genérico: nome do bot e tipo.
    expect(world.upstreams.fcmMessages[0]?.data).toMatchObject({ title: 'Bot do A5', body: PUSH_EVENT_LABELS.run_completed });
  });
});

describe('interruptores "Mostrar conteúdo"', () => {
  it('nascem ligados, mudam por origem, são idempotentes e só uma mudança real vai para a auditoria (com o booleano e a origem, nada mais)', async () => {
    expect(await push.contentSettings()).toEqual({ bots: true, generalChat: true });
    const audits = async () => (await world.pool.query<{ target: string; details: unknown; actor: string }>("SELECT target, details, actor FROM audit_log WHERE action = 'push.content_set' ORDER BY id")).rows;
    const before = (await audits()).length;

    expect(await push.setContent('bots', false, ORIGIN)).toEqual({ bots: false, generalChat: true });
    expect(await push.setContent('bots', false, ORIGIN)).toEqual({ bots: false, generalChat: true }); // repetir não muda nem audita de novo
    expect(await push.setContent('general_chat', false, ORIGIN)).toEqual({ bots: false, generalChat: false });
    expect(await push.setContent('bots', true, ORIGIN)).toEqual({ bots: true, generalChat: false });

    const rows = (await audits()).slice(before);
    expect(rows).toEqual([
      { target: 'bots', details: { enabled: false }, actor: 'owner' },
      { target: 'general_chat', details: { enabled: false }, actor: 'owner' },
      { target: 'bots', details: { enabled: true }, actor: 'owner' },
    ]);
    expect(await push.contentSettings()).toEqual({ bots: true, generalChat: false });
  });
});

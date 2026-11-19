// Prova do web push (A13 e A7 em parte; F14; T10) contra PostgreSQL real, o motor de execução real, o provedor falso e o FCM falso:
// cada desfecho que deve avisar grava o evento junto com o desfecho, o despachante envia só o nome do bot e o tipo (nunca o conteúdo
// da conversa) a cada dispositivo, um token recusado pelo FCM remove o dispositivo, falha transitória é repetida até esgotar, a parada do
// dono não avisa e nada é gravado quando não há dispositivo. O cliente do FCM é provado também pela assinatura do JWT e pelo token de
// acesso reaproveitado e renovado. Phase 3 (T3): o push leva o `eventId` e a tag por conversa e categoria, e a regra de validade descarta no
// envio (presença, abertura do app, leitura, aprovação resolvida, mais de 24 horas) e responde à conferência do service worker.
import { createVerify, generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PUSH_APP_OPENS_PER_MINUTE, PUSH_CHECKS_PER_MINUTE, PUSH_DEVICES_MAX, PUSH_EVENT_LABELS } from '@aion/shared';
import type { FcmServiceAccount } from '../config';
import { createLogger } from '../logging';
import { ORIGIN, createRunsWorld, waitFor, type RunsWorld } from '../runs/test-support';
import { GeneralChatService } from '../general-chat/service';
import { seedLegacyChatApproval } from '../testing/legacy-chat-approval';
import { createFcmClient, classifySendResponse } from './fcm';
import { PushDispatcher, type PushDispatcherConfig } from './dispatcher';
import { PushService } from './service';

const { privateKey: privatePem, publicKey } = (() => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: pair.publicKey };
})();
const ACCOUNT: FcmServiceAccount = { projectId: 'aion-test', clientEmail: 'push@aion-test.iam.gserviceaccount.com', privateKey: privatePem };

/** Instante que o teste controla (o cliente do FCM o usa para a validade do token de acesso). */
let clock = new Date('2026-10-01T12:00:00Z');

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

/** Despachante sobre o FCM falso do mundo. `fcm: null` simula o worker sem a conta de serviço. */
function dispatcher(config: Partial<PushDispatcherConfig> = {}, { fcm = true, logger = world.logger }: { fcm?: boolean; logger?: typeof world.logger } = {}) {
  const client = fcm
    ? createFcmClient({ serviceAccount: ACCOUNT, baseUrl: world.upstreams.fcmBaseUrl, tokenUrl: world.upstreams.fcmTokenUrl, now: () => clock })
    : null;
  return new PushDispatcher({ pool: world.pool, fcm: client, logger, config });
}

/** Começa o teste com os dispositivos dados e sem eventos nem mensagens anteriores no FCM falso. */
async function useDevices(...tokens: string[]): Promise<void> {
  await world.pool.query('DELETE FROM push_events');
  await world.pool.query('DELETE FROM push_devices');
  world.upstreams.fcmMessages.length = 0;
  for (const token of tokens) await push.registerDevice(token, ORIGIN);
}

const eventsOf = async (runId: string) =>
  (
    await world.pool.query<{ id: string; kind: string; status: string; attempts: number; message_id: string | null; bot_id: string | null }>(
      'SELECT id::text AS id, kind, status, attempts, message_id::text AS message_id, bot_id FROM push_events WHERE run_id = $1 ORDER BY push_events.id',
      [runId],
    )
  ).rows;

const lastVisible = async (runId: string, kinds: string[]): Promise<string | undefined> =>
  (
    await world.pool.query<{ id: string }>(
      "SELECT id::text AS id FROM messages WHERE run_id = $1 AND kind = ANY($2) AND status <> 'discarded' ORDER BY messages.id DESC LIMIT 1",
      [runId, kinds],
    )
  ).rows[0]?.id;

describe('cliente do FCM', () => {
  it('assina o JWT RS256 com a conta de serviço, envia só `data` com o token de acesso e o reaproveita até perto de vencer', async () => {
    const fcm = createFcmClient({ serviceAccount: ACCOUNT, baseUrl: world.upstreams.fcmBaseUrl, tokenUrl: world.upstreams.fcmTokenUrl, now: () => clock });
    world.upstreams.fcmMessages.length = 0;
    const exchangesBefore = world.upstreams.tokenExchanges.length;
    const message = { title: 'Bot', body: 'Execução concluída', url: '/bots/x', tag: 'aion-activity-x', kind: 'run_completed', eventId: '1' } as const;

    expect(await fcm.send('device-token-1', message)).toEqual({ result: 'sent', status: 200 });
    expect(await fcm.send('device-token-2', message)).toEqual({ result: 'sent', status: 200 });
    expect(world.upstreams.tokenExchanges.length - exchangesBefore).toBe(1); // o token de acesso foi reaproveitado

    // O JWT é RS256, assinado com a chave da conta de serviço, e aponta para o endpoint de troca e o escopo do FCM.
    const [header, claims, signature] = (world.upstreams.tokenExchanges.at(-1) as string).split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const parsed = JSON.parse(Buffer.from(claims, 'base64url').toString()) as { iss: string; scope: string; aud: string; iat: number; exp: number };
    expect(parsed).toMatchObject({ iss: ACCOUNT.clientEmail, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: world.upstreams.fcmTokenUrl });
    expect(parsed.exp - parsed.iat).toBe(3600);
    expect(createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true);

    // A mensagem é só `data` (mais o TTL de 24 horas e a urgência alta do FCM), com os seis campos e nada mais.
    const sent = world.upstreams.fcmMessages.at(-1);
    expect(sent?.authorization).toBe('Bearer fake-fcm-access-token');
    expect(Object.keys(sent?.message ?? {}).sort()).toEqual(['data', 'token', 'webpush']);
    expect(sent?.data).toEqual({ title: 'Bot', body: 'Execução concluída', url: '/bots/x', tag: 'aion-activity-x', kind: 'run_completed', eventId: '1' });
    expect((sent?.message as { webpush?: unknown }).webpush).toEqual({ headers: { TTL: '86400', Urgency: 'high' } });

    // Perto do vencimento do token de acesso (1 hora), ele é renovado uma vez.
    clock = new Date(clock.getTime() + 3600_000 - 30_000);
    await fcm.send('device-token-1', message);
    expect(world.upstreams.tokenExchanges.length - exchangesBefore).toBe(2);
  });

  it('só chama o dispositivo de inválido quando o FCM diz que o token não serve; erro de configuração ou transitório não apaga ninguém', async () => {
    const fcm = createFcmClient({ serviceAccount: ACCOUNT, baseUrl: world.upstreams.fcmBaseUrl, tokenUrl: world.upstreams.fcmTokenUrl, now: () => clock });
    const message = { title: 'Bot', body: 'x', url: '/bots/x', tag: 't', kind: 'run_failed', eventId: '2' } as const;
    // O status HTTP do FCM vai junto do resultado (phase 16: vira `push_deliveries.http_status`).
    expect(await fcm.send('unregistered-a', message)).toEqual({ result: 'invalid_token', status: 404 });
    expect(await fcm.send('malformed-a', message)).toEqual({ result: 'invalid_token', status: 400 });
    expect(await fcm.send('mismatch-a', message)).toEqual({ result: 'invalid_token', status: 403 });
    expect(await fcm.send('down-a', message)).toEqual({ result: 'failed', status: 503 });

    // A mesma decisão sobre respostas sintéticas: sem o código explícito, não é culpa do token.
    const cases: [number, unknown, string][] = [
      [200, {}, 'sent'],
      [404, { error: { status: 'NOT_FOUND', details: [] } }, 'failed'], // projeto errado: apagar os dispositivos perderia todos
      [400, { error: { details: [{ fieldViolations: [{ field: 'message.data' }] }] } }, 'failed'],
      [401, { error: { status: 'UNAUTHENTICATED' } }, 'failed'],
      [429, undefined, 'failed'],
      [500, 'html', 'failed'],
    ];
    for (const [status, json, expected] of cases) expect(classifySendResponse({ status, json }), `${status}`).toBe(expected);
  });
});

describe('eventos de execução (A13, A7)', () => {
  it('concluída: avisa cada dispositivo com o nome do bot e o tipo, o toque abre a resposta, e nada do conteúdo da conversa vai no push', async () => {
    await useDevices('device-aaa', 'device-bbb');
    const bot = await world.createBot({ name: 'Bot do resumo' });
    const runId = await world.send(bot, 'texto-secreto-da-conversa-12345');
    await world.waitForStatus(runId, 'completed');

    const [event] = await eventsOf(runId);
    expect(event).toMatchObject({ kind: 'run_completed', status: 'pending', attempts: 0, bot_id: bot.id });
    expect(event?.message_id).toBe(await lastVisible(runId, ['text']));

    expect(await dispatcher().tickOnce()).toBe(1);
    const sent = world.upstreams.fcmMessages;
    expect(sent.map((message) => message.token).sort()).toEqual(['device-aaa', 'device-bbb']);
    for (const message of sent) {
      expect(message.data).toEqual({
        title: 'Bot do resumo',
        body: PUSH_EVENT_LABELS.run_completed,
        url: `/bots/${bot.id}?mensagem=${event?.message_id}`,
        tag: `aion-activity-${bot.id}`,
        kind: 'run_completed',
        eventId: event?.id,
      });
      // O texto da mensagem do dono e o da resposta do bot (que o provedor falso ecoa) nunca aparecem no que vai ao FCM.
      expect(JSON.stringify(message.message)).not.toContain('texto-secreto-da-conversa-12345');
    }
    expect((await eventsOf(runId))[0]?.status).toBe('sent');
    expect(await dispatcher().tickOnce()).toBe(0); // já enviado: nada se repete
  });

  it('cada envio com sucesso deixa uma linha de log com o evento, o tipo e a quantidade de dispositivos, sem token nem conteúdo (R19)', async () => {
    await useDevices('device-log-aaa', 'device-log-bbb');
    const bot = await world.createBot({ name: 'Bot do log' });
    const runId = await world.send(bot, 'texto-secreto-do-log-67890');
    await world.waitForStatus(runId, 'completed');
    const lines: string[] = [];
    const logger = createLogger({ level: 'info', name: 'push-test', destination: { write: (line: string) => void lines.push(line) } });

    expect(await dispatcher({}, { logger }).tickOnce()).toBe(1);
    const sent = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((entry) => entry.msg === 'push enviado');
    expect(sent).toMatchObject({ kind: 'run_completed', devices: 2 });
    expect(typeof sent?.eventId).toBe('string');
    const everything = lines.join('');
    expect(everything).not.toContain('device-log-aaa'); // o token nunca vai ao log
    expect(everything).not.toContain('texto-secreto-do-log-67890'); // nem o conteúdo da conversa
  });

  it('falha do provedor e limite de chamadas avisam como falha, e o toque abre o cartão de falha ou do limite', async () => {
    await useDevices('device-fail');
    const failing = await world.createBot();
    const failedRun = await world.send(failing, '[falha] provedor fora');
    await world.waitForStatus(failedRun, 'failed');
    const limited = await world.createBot({ stepLimit: 2 });
    const limitedRun = await world.send(limited, '[loop] sem parar');
    await world.waitForStatus(limitedRun, 'limit_reached');

    expect(await dispatcher().tickOnce()).toBe(2);
    const bodies = world.upstreams.fcmMessages.map((message) => message.data);
    expect(bodies.map((data) => [data.title, data.body, data.kind])).toEqual([
      [failing.name, PUSH_EVENT_LABELS.run_failed, 'run_failed'],
      [limited.name, PUSH_EVENT_LABELS.run_failed, 'run_failed'],
    ]);
    expect(bodies[0]?.url).toBe(`/bots/${failing.id}?mensagem=${await lastVisible(failedRun, ['card'])}`);
    expect(bodies[1]?.url).toBe(`/bots/${limited.id}?mensagem=${await lastVisible(limitedRun, ['card'])}`);
  });

  it('uma execução interrompida pelo dono não gera push', async () => {
    await useDevices('device-stop');
    const bot = await world.createBot();
    const runId = await world.send(bot, '[demorar] sem fim');
    await world.waitForStatus(runId, 'running');
    await world.conversations.stop(bot.id);
    await world.waitForStatus(runId, 'interrupted');

    expect(await eventsOf(runId)).toEqual([]);
    expect(await dispatcher().tickOnce()).toBe(0);
    expect(world.upstreams.fcmMessages).toEqual([]);
  });

  it('a falha de uma rotina avisa e o toque abre o cartão da rotina', async () => {
    await useDevices('device-routine');
    const bot = await world.createBot({ name: 'Bot da rotina' });
    const routine = await world.routines.create(
      { name: 'Resumo', botId: bot.id, instruction: '[falha] rotina', schedule: { type: 'daily', times: ['07:00'] }, timezone: 'America/Sao_Paulo', startsAt: null, endsAt: null, maxRuns: null },
      ORIGIN,
    );
    const run = await world.routines.runNow(routine.id, ORIGIN);
    await world.waitForStatus(run.id, 'failed');

    const [event] = await eventsOf(run.id);
    expect(event).toMatchObject({ kind: 'run_failed' });
    const routineCard = (await world.pool.query<{ id: string }>("SELECT id::text AS id FROM messages WHERE run_id = $1 AND data->>'type' = 'routine_run'", [run.id])).rows[0]?.id;
    expect(event?.message_id).toBe(routineCard);
    await dispatcher().tickOnce();
    expect(world.upstreams.fcmMessages.map((message) => message.data.title)).toEqual(['Bot da rotina']);
  });
});

describe('eventos de aprovação (A13, A8)', () => {
  it('pausar para aprovar avisa "Aprovação pendente" e expirar avisa "Aprovação expirada", os dois abrindo o cartão da aprovação', async () => {
    await useDevices('device-approval');
    const bot = await world.createBot({ name: 'Bot que pede' });
    await world.releaseConnectorAccounts(bot);
    const runId = await world.send(bot, '[gmail] enviar');
    await world.waitForStatus(runId, 'waiting_approval');

    const card = await lastVisible(runId, ['card']);
    expect((await eventsOf(runId)).map((event) => [event.kind, event.message_id])).toEqual([['approval_pending', card]]);
    // Enviado enquanto a aprovação ainda espera o dono (resolvida antes do envio, seria descartada: ver "validade do aviso").
    expect(await dispatcher().tickOnce()).toBe(1);

    const approval = await world.approvalOf(runId);
    await world.pool.query("UPDATE approvals SET expires_at = now() - interval '1 second' WHERE id = $1", [approval?.id]);
    await world.waitForStatus(runId, 'expired');

    expect((await eventsOf(runId)).map((event) => [event.kind, event.message_id])).toEqual([
      ['approval_pending', card],
      ['approval_expired', card],
    ]);
    expect(await dispatcher().tickOnce()).toBe(1);
    // As duas são da MESMA aprovação: a mesma tag (uma por aprovação, phase 16), então a expiração SUBSTITUI o pedido dela na tela do aparelho.
    expect(world.upstreams.fcmMessages.map((message) => [message.data.title, message.data.body, message.data.url, message.data.tag])).toEqual([
      [bot.name, PUSH_EVENT_LABELS.approval_pending, `/bots/${bot.id}?mensagem=${card}`, `aion-approval-${approval?.id}`],
      [bot.name, PUSH_EVENT_LABELS.approval_expired, `/bots/${bot.id}?mensagem=${card}`, `aion-approval-${approval?.id}`],
    ]);
  });
});

describe('chat geral (T12, spec decisão 18)', () => {
  it('a execução de uma sessão avisa com o título "Chat geral" (nunca o título da sessão) e o toque abre a sessão no cartão certo', async () => {
    await useDevices('device-chat');
    const session = await new GeneralChatService({ pool: world.pool }).create();
    await world.conversations.setPreference({ sessionId: session.id }, 'opencode/glm-5.1', null);
    const done = (await world.conversations.send({ sessionId: session.id }, 'assunto-sigiloso-da-sessao-777')).id;
    await world.waitForStatus(done, 'completed');
    // Aprovação de ação do conector pendente na sessão, como a phase 12 a deixava no banco (nada mais a cria na phase 13, então a prova a semeia), com o aviso `approval_pending` na mesma
    // transação, como a pausa do executor. O que o teste prova (título "Chat geral" e o link do toque no cartão da sessão) vem do despachante e não depende de qual ferramenta pediu.
    const asking = (await seedLegacyChatApproval({ pool: world.pool, approvals: world.approvals, sessionId: session.id, input: '[gmail] enviar', queuePush: true })).runId;

    // Os avisos nascem sem bot, junto do desfecho, e apontam para as mensagens certas.
    const completed = (await eventsOf(done))[0];
    const pending = (await eventsOf(asking))[0];
    expect(completed).toMatchObject({ kind: 'run_completed', bot_id: null, message_id: await lastVisible(done, ['text']) });
    expect(pending).toMatchObject({ kind: 'approval_pending', bot_id: null, message_id: await lastVisible(asking, ['card']) });

    expect(await dispatcher().tickOnce()).toBe(2);
    expect(world.upstreams.fcmMessages.map((message) => [message.data.title, message.data.body, message.data.url, message.data.tag])).toEqual([
      ['Chat geral', PUSH_EVENT_LABELS.run_completed, `/chat/${session.id}?mensagem=${completed?.message_id}`, `aion-activity-${session.id}`],
      ['Chat geral', PUSH_EVENT_LABELS.approval_pending, `/chat/${session.id}?mensagem=${pending?.message_id}`, `aion-approval-${(await world.approvalOf(asking))?.id}`],
    ]);
    // O título da sessão (a primeira mensagem do dono) é conteúdo da conversa e nunca vai no push.
    expect(JSON.stringify(world.upstreams.fcmMessages.map((message) => message.message))).not.toContain('assunto-sigiloso-da-sessao-777');
    expect((await eventsOf(done))[0]?.status).toBe('sent');

    // Uma sessão apagada antes do envio não tem para onde levar o toque: o aviso termina como enviado, sem mandar nada.
    world.upstreams.fcmMessages.length = 0;
    await world.pool.query("UPDATE push_events SET status = 'pending', finished_at = NULL, claimed_at = NULL WHERE run_id = $1", [done]);
    await world.pool.query("UPDATE push_events SET run_id = NULL WHERE run_id = $1", [done]);
    expect(await dispatcher().tickOnce()).toBe(1);
    expect(world.upstreams.fcmMessages).toEqual([]);
    await world.conversations.stop({ sessionId: session.id });
  });
});

describe('despacho', () => {
  it('um token que o FCM recusa como inválido remove o dispositivo, e os demais continuam recebendo', async () => {
    await useDevices('device-ok', 'unregistered-gone');
    const bot = await world.createBot();
    const first = await world.send(bot, 'um');
    await world.waitForStatus(first, 'completed');
    await dispatcher().tickOnce();

    expect((await push.listDevices()).length).toBe(1);
    expect((await world.pool.query<{ token: string }>('SELECT token FROM push_devices')).rows[0]?.token).toBe('device-ok');
    expect((await eventsOf(first))[0]?.status).toBe('sent');

    const second = await world.send(bot, 'dois');
    await world.waitForStatus(second, 'completed');
    world.upstreams.fcmMessages.length = 0;
    await dispatcher().tickOnce();
    expect(world.upstreams.fcmMessages.map((message) => message.token)).toEqual(['device-ok']);
  });

  it('falha transitória do FCM repete o evento (com a mesma tag) até esgotar as tentativas e então desiste, sem remover o dispositivo', async () => {
    await useDevices('down-device');
    const bot = await world.createBot();
    const runId = await world.send(bot, 'transitório');
    await world.waitForStatus(runId, 'completed');
    const flaky = dispatcher({ claimTtlMs: 30, maxAttempts: 3 });

    expect(await flaky.tickOnce()).toBe(1);
    expect(await eventsOf(runId)).toMatchObject([{ status: 'pending', attempts: 1 }]);
    expect(await flaky.tickOnce()).toBe(0); // a posse ainda não venceu: sem repetir em seguida

    await waitFor('a posse vencer e o evento voltar', async () => ((await flaky.tickOnce()) === 1 ? true : null));
    await waitFor('a terceira tentativa', async () => ((await eventsOf(runId))[0]?.status === 'dropped' ? true : (await flaky.tickOnce(), null)));

    const tags = new Set(world.upstreams.fcmMessages.map((message) => message.data.tag));
    expect(world.upstreams.fcmMessages.length).toBe(3);
    expect(tags.size).toBe(1);
    expect(await eventsOf(runId)).toMatchObject([{ status: 'dropped', attempts: 3 }]);
    expect((await push.listDevices()).length).toBe(1);
  });

  it('sem nenhum dispositivo registrado o evento nem é gravado; sem a conta de serviço no worker, o aviso é descartado em vez de acumular', async () => {
    await useDevices();
    const bot = await world.createBot();
    const without = await world.send(bot, 'sem dispositivo');
    await world.waitForStatus(without, 'completed');
    expect(await eventsOf(without)).toEqual([]);

    await push.registerDevice('device-late', ORIGIN);
    const withDevice = await world.send(bot, 'com dispositivo');
    await world.waitForStatus(withDevice, 'completed');
    expect(await dispatcher({}, { fcm: false }).tickOnce()).toBe(1);
    expect(await eventsOf(withDevice)).toMatchObject([{ status: 'dropped' }]);
    expect((await world.pool.query('SELECT drop_reason FROM push_events WHERE run_id = $1', [withDevice])).rows).toEqual([{ drop_reason: 'no_fcm_account' }]);
    expect(world.upstreams.fcmMessages).toEqual([]);
  });

  it('dois despachantes ao mesmo tempo enviam cada evento uma única vez', async () => {
    await useDevices('device-one', 'device-two');
    const bot = await world.createBot();
    const runs: string[] = [];
    // Quatro execuções na fila (o envio com a primeira já rodando viraria complemento dela, CONV-03, e não teria evento próprio).
    for (let index = 0; index < 4; index += 1) runs.push(await world.enqueue(bot, `rodada ${index}`));
    for (const runId of runs) await world.waitForStatus(runId, 'completed');

    const handled = await Promise.all([dispatcher({ batch: 2 }).tickOnce(), dispatcher({ batch: 2 }).tickOnce()]);
    expect(handled.reduce((sum, count) => sum + count, 0)).toBe(4);
    expect(world.upstreams.fcmMessages.length).toBe(4 * 2); // quatro eventos, dois dispositivos, nenhum repetido
    expect(new Set(world.upstreams.fcmMessages.map((message) => `${message.token}:${message.data.eventId}`)).size).toBe(8);
  });
});

// Entrega por dispositivo e motivos de descarte novos (phase 16, passo 1; A1 na parte do servidor): o que o FCM respondeu a cada dispositivo
// fica gravado sem token nem conteúdo, a linha do dispositivo recusado sobrevive à remoção dele, a repetição só vai a quem não aceitou, cada
// desfecho sem envio tem o próprio `drop_reason`, o log conta os aceitos e a retenção de 30 dias leva as linhas filhas junto.
describe('entrega por dispositivo (phase 16; A1)', () => {
  const deliveriesOf = async (eventId: string) =>
    (
      await world.pool.query<{ device_id: string; attempt: number; http_status: number | null; outcome: string }>(
        'SELECT device_id::text AS device_id, attempt, http_status, outcome FROM push_deliveries WHERE event_id = $1 ORDER BY attempt, outcome',
        [eventId],
      )
    ).rows;
  const deviceIds = async (): Promise<Record<string, string>> =>
    Object.fromEntries((await world.pool.query<{ id: string; token: string }>('SELECT id, token FROM push_devices')).rows.map((row) => [row.token, row.id]));
  const eventRow = async (eventId: string) =>
    (await world.pool.query<{ status: string; drop_reason: string | null }>('SELECT status, drop_reason FROM push_events WHERE id = $1', [eventId])).rows[0];

  it('grava aceito e recusado por dispositivo com o status HTTP; a entrega do recusado fica depois que o dispositivo é removido, e nenhuma coluna guarda token nem conteúdo', async () => {
    await useDevices('device-del-ok', 'unregistered-del-gone');
    const ids = await deviceIds();
    const bot = await world.createBot();
    const runId = await world.send(bot, 'entrega por dispositivo');
    await world.waitForStatus(runId, 'completed');
    const [event] = await eventsOf(runId);
    await dispatcher().tickOnce();

    expect((await world.pool.query('SELECT 1 FROM push_devices WHERE id = $1', [ids['unregistered-del-gone']])).rowCount).toBe(0); // o recusado saiu
    const deliveries = await deliveriesOf(event!.id);
    expect(deliveries).toHaveLength(2);
    expect(deliveries).toEqual(
      expect.arrayContaining([
        { device_id: ids['device-del-ok'], attempt: 1, http_status: 200, outcome: 'accepted' },
        { device_id: ids['unregistered-del-gone'], attempt: 1, http_status: 404, outcome: 'rejected_token' },
      ]),
    );
    expect(await eventRow(event!.id)).toEqual({ status: 'sent', drop_reason: null });

    const columns = (
      await world.pool.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name IN ('push_deliveries', 'push_receipts')")
    ).rows.map((row) => row.column_name);
    expect(columns.filter((name) => /token|title|body|content|text|url/.test(name))).toEqual([]);
  });

  it('grava o aceito e o recusado com o HTTP para cada tipo de evento: run_completed, run_failed, approval_pending e approval_expired', async () => {
    await useDevices();
    const bot = await world.createBot({ name: 'Bot dos tipos' });
    await world.releaseConnectorAccounts(bot);

    /** Deixa só um dispositivo que aceita e outro que o FCM recusa. Vem ANTES da execução: sem dispositivo registrado o evento nem é gravado. */
    const registerPair = async (suffix: string) => {
      await world.pool.query('DELETE FROM push_devices');
      await push.registerDevice(`device-${suffix}-ok`, ORIGIN);
      await push.registerDevice(`unregistered-${suffix}-gone`, ORIGIN);
      return deviceIds();
    };
    /** Envia o evento pendente do tipo e confere as duas linhas de entrega dele. */
    const expectPair = async (kind: string, runId: string, suffix: string, ids: Record<string, string>) => {
      const events = (await eventsOf(runId)).filter((event) => event.kind === kind && event.status === 'pending');
      expect(events, kind).toHaveLength(1);
      await dispatcher().tickOnce();
      const deliveries = await deliveriesOf(events[0]!.id);
      expect(deliveries, kind).toHaveLength(2);
      expect(deliveries, kind).toEqual(
        expect.arrayContaining([
          { device_id: ids[`device-${suffix}-ok`], attempt: 1, http_status: 200, outcome: 'accepted' },
          { device_id: ids[`unregistered-${suffix}-gone`], attempt: 1, http_status: 404, outcome: 'rejected_token' },
        ]),
      );
      expect(await eventRow(events[0]!.id), kind).toEqual({ status: 'sent', drop_reason: null });
    };

    let ids = await registerPair('completed');
    const completed = await world.send(bot, 'concluída');
    await world.waitForStatus(completed, 'completed');
    await expectPair('run_completed', completed, 'completed', ids);

    ids = await registerPair('failed');
    const failed = await world.send(bot, '[falha] provedor fora');
    await world.waitForStatus(failed, 'failed');
    await expectPair('run_failed', failed, 'failed', ids);

    ids = await registerPair('pending');
    const approval = await world.send(bot, '[gmail] enviar');
    await world.waitForStatus(approval, 'waiting_approval');
    await expectPair('approval_pending', approval, 'pending', ids); // enviada enquanto a aprovação ainda espera o dono

    ids = await registerPair('expired');
    await world.pool.query("UPDATE approvals SET expires_at = now() - interval '1 second' WHERE id = $1", [(await world.approvalOf(approval))?.id]);
    await world.waitForStatus(approval, 'expired');
    await expectPair('approval_expired', approval, 'expired', ids);
  });

  it('a repetição por falha transitória só reenvia a quem ainda não aceitou, cada tentativa fica gravada e o esgotamento é `attempts_exhausted`', async () => {
    await useDevices('device-del-fine', 'down-del-flaky');
    const ids = await deviceIds();
    const bot = await world.createBot();
    const runId = await world.send(bot, 'repetição por dispositivo');
    await world.waitForStatus(runId, 'completed');
    const [event] = await eventsOf(runId);
    const flaky = dispatcher({ claimTtlMs: 30, maxAttempts: 3 });

    await flaky.tickOnce();
    await waitFor('as três tentativas', async () => ((await eventRow(event!.id))?.status === 'dropped' ? true : (await flaky.tickOnce(), null)));

    const sentTo = (token: string) => world.upstreams.fcmMessages.filter((message) => message.token === token).length;
    expect(sentTo('device-del-fine')).toBe(1); // aceito na primeira tentativa, não recebe de novo
    expect(sentTo('down-del-flaky')).toBe(3);
    expect(await deliveriesOf(event!.id)).toEqual([
      { device_id: ids['device-del-fine'], attempt: 1, http_status: 200, outcome: 'accepted' },
      { device_id: ids['down-del-flaky'], attempt: 1, http_status: 503, outcome: 'failed' },
      { device_id: ids['down-del-flaky'], attempt: 2, http_status: 503, outcome: 'failed' },
      { device_id: ids['down-del-flaky'], attempt: 3, http_status: 503, outcome: 'failed' },
    ]);
    expect(await eventRow(event!.id)).toEqual({ status: 'dropped', drop_reason: 'attempts_exhausted' });
  });

  it('FCM inacessível grava a falha sem status HTTP', async () => {
    await useDevices('device-del-offline');
    const bot = await world.createBot();
    const runId = await world.send(bot, 'fcm fora');
    await world.waitForStatus(runId, 'completed');
    const [event] = await eventsOf(runId);
    const offline = createFcmClient({ serviceAccount: ACCOUNT, baseUrl: 'http://127.0.0.1:9', tokenUrl: world.upstreams.fcmTokenUrl, now: () => clock });
    await new PushDispatcher({ pool: world.pool, fcm: offline, logger: world.logger }).tickOnce();

    expect(await deliveriesOf(event!.id)).toMatchObject([{ attempt: 1, http_status: null, outcome: 'failed' }]);
    expect(await eventRow(event!.id)).toEqual({ status: 'pending', drop_reason: null }); // volta à fila
  });

  it('cada desfecho sem envio tem o próprio motivo: sem conta do FCM, sem dispositivo e sem destino, e nenhum grava entrega', async () => {
    await useDevices('device-del-reasons');
    const bot = await world.createBot();
    const noAccount = await world.send(bot, 'sem conta');
    await world.waitForStatus(noAccount, 'completed');
    await dispatcher({}, { fcm: false }).tickOnce();
    const [accountEvent] = await eventsOf(noAccount);
    expect(await eventRow(accountEvent!.id)).toEqual({ status: 'dropped', drop_reason: 'no_fcm_account' });

    const noDevice = await world.send(bot, 'dispositivo removido depois');
    await world.waitForStatus(noDevice, 'completed');
    await world.pool.query('DELETE FROM push_devices');
    await dispatcher().tickOnce();
    const [deviceEvent] = await eventsOf(noDevice);
    expect(await eventRow(deviceEvent!.id)).toEqual({ status: 'dropped', drop_reason: 'no_device' });

    // Sem bot nem execução o evento não tem a quem pertencer (a sessão do Chat geral já foi apagada): não há título nem caminho para abrir.
    await push.registerDevice('device-del-reasons-2', ORIGIN);
    const orphan = (await world.pool.query<{ id: string }>("INSERT INTO push_events (kind, created_at) VALUES ('run_completed', now()) RETURNING id::text AS id")).rows[0]!.id;
    await dispatcher().tickOnce();
    expect(await eventRow(orphan)).toEqual({ status: 'dropped', drop_reason: 'no_destination' });

    expect(world.upstreams.fcmMessages).toEqual([]);
    expect((await world.pool.query('SELECT 1 FROM push_deliveries')).rowCount).toBe(0);
  });

  it('o log conta os dispositivos que o FCM aceitou e os tokens recusados; com todos recusados diz que ninguém aceitou, sem token nem conteúdo', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'info', name: 'push-test', destination: { write: (line: string) => void lines.push(line) } });
    const entries = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);

    await useDevices('device-cnt-ok', 'unregistered-cnt-a');
    const bot = await world.createBot();
    const mixed = await world.send(bot, 'um aceita, um recusa');
    await world.waitForStatus(mixed, 'completed');
    await dispatcher({}, { logger }).tickOnce();
    expect(entries().find((entry) => entry.msg === 'push enviado')).toMatchObject({ kind: 'run_completed', devices: 1, rejected: 1 });

    lines.length = 0;
    await useDevices('unregistered-cnt-b');
    const allRefused = await world.send(bot, 'todos recusam');
    await world.waitForStatus(allRefused, 'completed');
    await dispatcher({}, { logger }).tickOnce();
    expect(entries().find((entry) => entry.msg === 'push enviado')).toBeUndefined();
    expect(entries().find((entry) => String(entry.msg).startsWith('push sem aceite'))).toMatchObject({ rejected: 1 });
    expect((await eventsOf(allRefused))[0]?.status).toBe('sent');
    expect(lines.join('')).not.toContain('unregistered-cnt');
  });

  it('a retenção de 30 dias apaga o evento tratado com as entregas e os registros do aparelho; o de 29 dias fica', async () => {
    await useDevices();
    const bot = await world.createBot();
    const day = 24 * 3600_000;
    const seed = async (ageDays: number): Promise<string> => {
      const at = new Date(Date.now() - ageDays * day);
      const id = (
        await world.pool.query<{ id: string }>("INSERT INTO push_events (kind, bot_id, status, created_at, finished_at) VALUES ('run_completed', $1, 'sent', $2, $2) RETURNING id::text AS id", [bot.id, at])
      ).rows[0]!.id;
      const device = randomUUID(); // sem chave para push_devices: o id vale mesmo sem o dispositivo
      await world.pool.query("INSERT INTO push_deliveries (event_id, device_id, attempt, http_status, outcome, created_at) VALUES ($1, $2, 1, 200, 'accepted', $3)", [id, device, at]);
      await world.pool.query("INSERT INTO push_receipts (event_id, device_id, state, created_at) VALUES ($1, $2, 'received', $3)", [id, device, at]);
      return id;
    };
    const recent = await seed(29);
    const old = await seed(31);
    await dispatcher().tickOnce(); // a limpeza roda no início do ciclo, com a retenção padrão
    const rowsOf = async (id: string) =>
      Number(
        (
          await world.pool.query<{ total: string }>(
            'SELECT (SELECT count(*) FROM push_events WHERE id = $1) + (SELECT count(*) FROM push_deliveries WHERE event_id = $1) + (SELECT count(*) FROM push_receipts WHERE event_id = $1) AS total',
            [id],
          )
        ).rows[0]!.total,
      );
    expect(await rowsOf(recent)).toBe(3);
    expect(await rowsOf(old)).toBe(0);
  });

  it('o registro do aparelho é único por evento, dispositivo e estado, e o motivo só vale onde faz sentido', async () => {
    await useDevices();
    const bot = await world.createBot();
    const event = (await world.pool.query<{ id: string }>("INSERT INTO push_events (kind, bot_id, created_at) VALUES ('run_completed', $1, now()) RETURNING id::text AS id", [bot.id])).rows[0]!.id;
    const device = randomUUID();
    const insert = (state: string, reason: string | null, deviceId = device) =>
      world.pool.query('INSERT INTO push_receipts (event_id, device_id, state, reason, created_at) VALUES ($1, $2, $3, $4, now())', [event, deviceId, state, reason]);

    await insert('received', null);
    await insert('shown', 'check_timeout');
    await insert('suppressed', 'owner_looking', randomUUID());
    await insert('clicked', null);
    await expect(insert('received', null)).rejects.toThrow(/push_receipts_event_id_device_id_state_key/); // idempotência da rota do passo 2
    await expect(insert('suppressed', null, randomUUID())).rejects.toThrow(/check/); // suprimido sempre leva motivo
    await expect(insert('suppressed', 'check_timeout', randomUUID())).rejects.toThrow(/check/); // a conferência sem resposta exibe, não suprime
    await expect(insert('received', 'invalid', randomUUID())).rejects.toThrow(/check/);
    await expect(insert('seen', null, randomUUID())).rejects.toThrow(/check/);
  });
});

describe('dispositivos (F14)', () => {
  it('registrar é idempotente por token, o rótulo vem do navegador, só o primeiro registro é auditado e remover duas vezes é NOT_FOUND', async () => {
    await useDevices();
    const chrome = { ip: '127.0.0.1', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36' };
    let registeredAt = new Date('2026-10-01T12:00:00Z');
    const timed = new PushService({ pool: world.pool, config: { enabled: false }, now: () => registeredAt });
    const first = await timed.registerDevice('device-idem', chrome);
    registeredAt = new Date('2026-10-01T12:05:00Z');
    const again = await timed.registerDevice('device-idem', chrome);
    expect(again.id).toBe(first.id);
    // O re-registro renova o último uso e mantém a data de criação.
    expect([again.createdAt, again.lastSeenAt]).toEqual(['2026-10-01T12:00:00.000Z', '2026-10-01T12:05:00.000Z']);
    expect(first.label).toBe('Chrome no Windows');
    expect(await push.listDevices()).toHaveLength(1);
    expect(JSON.stringify(await push.listDevices())).not.toContain('device-idem'); // o token nunca volta

    const audits = await world.pool.query<{ details: Record<string, unknown>; target: string }>("SELECT target, details FROM audit_log WHERE action = 'push.device_register' AND target = $1", [first.id]);
    expect(audits.rows).toHaveLength(1);
    expect(JSON.stringify(audits.rows)).not.toContain('device-idem');

    await push.removeDevice(first.id, ORIGIN);
    expect(await push.listDevices()).toEqual([]);
    await expect(push.removeDevice(first.id, ORIGIN)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('o teto de 20 dispositivos recusa um novo, mas renovar um já registrado passa e remover libera a vaga (R16)', async () => {
    await useDevices(...Array.from({ length: PUSH_DEVICES_MAX }, (_, index) => `device-cap-${index}`));
    expect(await push.listDevices()).toHaveLength(PUSH_DEVICES_MAX);

    await expect(push.registerDevice('device-cap-novo', ORIGIN)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', fields: [{ field: 'token' }] });
    expect(await push.listDevices()).toHaveLength(PUSH_DEVICES_MAX); // nada foi gravado

    // O navegador que já está registrado renova no teto (a sincronização silenciosa a cada carga não pode falhar).
    await expect(push.registerDevice('device-cap-3', ORIGIN)).resolves.toMatchObject({ label: expect.any(String) });
    expect(await push.listDevices()).toHaveLength(PUSH_DEVICES_MAX);

    const [oldest] = await push.listDevices();
    await push.removeDevice((oldest as { id: string }).id, ORIGIN);
    await expect(push.registerDevice('device-cap-novo', ORIGIN)).resolves.toBeDefined();
    expect(await push.listDevices()).toHaveLength(PUSH_DEVICES_MAX);
    await useDevices();
  });
});

describe('validade do aviso no envio e na conferência (phase 3, T3; A1, A4, A5, A6)', () => {
  // Estas provas são da REGRA DE VALIDADE (`{ id, valid }` exato). Com "Mostrar conteúdo" ligado (o padrão desde a phase 16) a conferência do evento válido traz também título e corpo,
  // que têm prova própria em `push-content.test.ts`; aqui as chaves ficam desligadas para as asserções de validade seguirem exatas, sem afrouxá-las.
  beforeAll(async () => {
    await world.pool.query('UPDATE app_settings SET push_content_bots = false, push_content_general_chat = false');
  });
  afterAll(async () => {
    await world.pool.query('UPDATE app_settings SET push_content_bots = true, push_content_general_chat = true');
  });
  /** Sessão de login válida (cada aparelho é uma), como o login a grava. */
  const newSession = async (): Promise<string> =>
    (
      await world.pool.query<{ id: string }>(
        `INSERT INTO sessions (token_hash, created_at, last_used_at, expires_at, ip) VALUES (md5(random()::text), now(), now(), now() + interval '30 days', '127.0.0.1') RETURNING id`,
      )
    ).rows[0]!.id;
  const conversationOf = async (botId: string): Promise<string> =>
    (await world.pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [botId])).rows[0]!.id;
  /** Desfecho de cada evento da execução: tipo, estado e motivo do descarte. */
  const outcomesOf = async (runId: string) =>
    (await world.pool.query<{ kind: string; status: string; drop_reason: string | null }>('SELECT kind, status, drop_reason FROM push_events WHERE run_id = $1 ORDER BY id', [runId])).rows;
  /** Manda uma mensagem ao bot e espera a execução concluir. */
  async function completedRun(bot: Parameters<RunsWorld['send']>[0], text: string): Promise<string> {
    const runId = await world.send(bot, text);
    await world.waitForStatus(runId, 'completed');
    return runId;
  }
  const sentIds = () => world.upstreams.fcmMessages.map((message) => message.data.eventId);

  it('presença válida em qualquer sessão descarta como `presence` sem tocar o FCM; presença vencida não impede o aviso', async () => {
    await useDevices('device-presence');
    const bot = await world.createBot({ name: 'Bot olhado' });
    const phone = await newSession();
    const watched = await completedRun(bot, 'olhando');
    await world.pool.query('INSERT INTO conversation_presence (session_id, conversation_id, renewed_at) VALUES ($1, $2, now())', [phone, await conversationOf(bot.id)]);

    expect(await dispatcher().tickOnce()).toBe(1);
    expect(world.upstreams.fcmMessages).toEqual([]);
    expect(await outcomesOf(watched)).toEqual([{ kind: 'run_completed', status: 'dropped', drop_reason: 'presence' }]);

    // Sem renovação há mais de 45 s, a presença não vale: o aviso segue.
    await world.pool.query("UPDATE conversation_presence SET renewed_at = now() - interval '46 seconds' WHERE session_id = $1", [phone]);
    const later = await completedRun(bot, 'saiu da tela');
    await dispatcher().tickOnce();
    expect(sentIds()).toEqual([(await eventsOf(later))[0]?.id]);
    expect(await outcomesOf(later)).toEqual([{ kind: 'run_completed', status: 'sent', drop_reason: null }]);
    await world.pool.query('DELETE FROM conversation_presence');
  });

  it('a conversa lida até a mensagem do evento descarta como `read`; leitura anterior à mensagem não impede o aviso', async () => {
    await useDevices('device-read');
    const bot = await world.createBot({ name: 'Bot lido' });
    const first = await completedRun(bot, 'primeira');
    const second = await completedRun(bot, 'segunda');
    // Leu até a resposta da primeira execução: a primeira é descartada, a segunda (mensagem mais nova) avisa.
    await world.pool.query('UPDATE conversations SET read_through_message_id = $2 WHERE bot_id = $1', [bot.id, (await eventsOf(first))[0]?.message_id]);

    expect(await dispatcher().tickOnce()).toBe(2);
    expect(await outcomesOf(first)).toEqual([{ kind: 'run_completed', status: 'dropped', drop_reason: 'read' }]);
    expect(await outcomesOf(second)).toEqual([{ kind: 'run_completed', status: 'sent', drop_reason: null }]);
    expect(sentIds()).toEqual([(await eventsOf(second))[0]?.id]);
  });

  it('aprovação resolvida antes do envio descarta como `resolved`; resolvida depois, a conferência a dá como inválida; a tag separa atividade e aprovação', async () => {
    await useDevices('device-resolved');
    const bot = await world.createBot({ name: 'Bot que pede de novo' });
    const session = await newSession();

    // Depois do envio: o pedido chega (tag de aprovação) e vale até o dono responder.
    await world.releaseConnectorAccounts(bot);
    const answeredLater = await world.send(bot, '[gmail] enviar');
    await world.waitForStatus(answeredLater, 'waiting_approval');
    expect(await dispatcher().tickOnce()).toBe(1);
    const [pending] = await eventsOf(answeredLater);
    expect(world.upstreams.fcmMessages.map((message) => [message.data.eventId, message.data.tag])).toEqual([[pending?.id, `aion-approval-${(await world.approvalOf(answeredLater))?.id}`]]);
    expect(await push.checkEvents(session, [pending!.id])).toEqual({ events: [{ id: pending?.id, valid: true }] });
    await world.approvals.respond((await world.approvalOf(answeredLater))!.id, 'deny', ORIGIN);
    await world.waitForStatus(answeredLater, 'completed');
    expect(await push.checkEvents(session, [pending!.id])).toEqual({ events: [{ id: pending?.id, valid: false }] });

    // Antes do envio: respondida antes do despachante passar, o pedido é descartado; a conclusão avisa com a tag de atividade.
    await world.releaseConnectorAccounts(bot);
    const answeredFirst = await world.send(bot, '[gmail] enviar de novo');
    await world.waitForStatus(answeredFirst, 'waiting_approval');
    await world.approvals.respond((await world.approvalOf(answeredFirst))!.id, 'deny', ORIGIN);
    await world.waitForStatus(answeredFirst, 'completed');
    world.upstreams.fcmMessages.length = 0;
    await dispatcher().tickOnce();
    expect(await outcomesOf(answeredFirst)).toEqual([
      { kind: 'approval_pending', status: 'dropped', drop_reason: 'resolved' },
      { kind: 'run_completed', status: 'sent', drop_reason: null },
    ]);
    expect(world.upstreams.fcmMessages.filter((message) => message.data.kind === 'approval_pending')).toEqual([]);
    expect(new Set(world.upstreams.fcmMessages.map((message) => message.data.tag))).toEqual(new Set([`aion-activity-${bot.id}`]));
  });

  it('com 24 horas ou mais o evento é descartado como `expired` no envio e inválido na conferência', async () => {
    await useDevices('device-expired');
    const bot = await world.createBot();
    const runId = await completedRun(bot, 'velho');
    const [event] = await eventsOf(runId);
    const session = await newSession();
    expect(await push.checkEvents(session, [event!.id])).toEqual({ events: [{ id: event?.id, valid: true }] });

    await world.pool.query("UPDATE push_events SET created_at = now() - interval '24 hours 1 second' WHERE id = $1", [event?.id]);
    expect(await push.checkEvents(session, [event!.id])).toEqual({ events: [{ id: event?.id, valid: false }] });
    await dispatcher().tickOnce();
    expect(world.upstreams.fcmMessages).toEqual([]);
    expect(await outcomesOf(runId)).toEqual([{ kind: 'run_completed', status: 'dropped', drop_reason: 'expired' }]);
  });

  it('abrir o app descarta os eventos anteriores como `opened` sem marcar conversa como lida; evento posterior avisa normalmente', async () => {
    await useDevices('device-open');
    const bot = await world.createBot({ name: 'Bot da abertura' });
    const before = await completedRun(bot, 'antes de abrir');
    const beforeId = (await eventsOf(before))[0]!.id;
    const pc = await newSession();
    expect(await push.checkEvents(pc, [beforeId])).toEqual({ events: [{ id: beforeId, valid: true }] });

    await push.recordAppOpen(pc);
    // A notificação já exibida em outro aparelho passa a ser inválida na conferência (A6).
    expect(await push.checkEvents(pc, [beforeId])).toEqual({ events: [{ id: beforeId, valid: false }] });
    const after = await completedRun(bot, 'depois de abrir');
    expect(await dispatcher().tickOnce()).toBe(2);
    expect(await outcomesOf(before)).toEqual([{ kind: 'run_completed', status: 'dropped', drop_reason: 'opened' }]);
    expect(await outcomesOf(after)).toEqual([{ kind: 'run_completed', status: 'sent', drop_reason: null }]);
    expect(sentIds()).toEqual([(await eventsOf(after))[0]?.id]);
    expect((await world.pool.query('SELECT read_through_message_id FROM conversations WHERE bot_id = $1', [bot.id])).rows).toEqual([{ read_through_message_id: null }]);
  });

  it('a abertura grava a hora do servidor e só avança, numa única linha; acima de 10 por minuto na sessão é RATE_LIMITED sem afetar outra', async () => {
    const session = await newSession();
    const at = new Date();
    await new PushService({ pool: world.pool, config: { enabled: false }, now: () => at }).recordAppOpen(session);
    await new PushService({ pool: world.pool, config: { enabled: false }, now: () => new Date(at.getTime() - 3600_000) }).recordAppOpen(session);
    expect((await world.pool.query('SELECT opened_at FROM app_opened')).rows).toEqual([{ opened_at: at }]);

    const limited = new PushService({ pool: world.pool, config: { enabled: false } });
    for (let index = 0; index < PUSH_APP_OPENS_PER_MINUTE; index += 1) await limited.recordAppOpen(session);
    await expect(limited.recordAppOpen(session)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await expect(limited.recordAppOpen(await newSession())).resolves.toBeUndefined();
  });

  it('a conferência responde só { id, valid } na ordem pedida, id desconhecido é inválido, e acima de 60 por minuto na sessão é RATE_LIMITED', async () => {
    await useDevices('device-check');
    const bot = await world.createBot();
    const [event] = await eventsOf(await completedRun(bot, 'conferir'));
    const checker = new PushService({ pool: world.pool, config: { enabled: false } });
    const session = await newSession();

    expect(await checker.checkEvents(session, ['999999999', event!.id, event!.id])).toEqual({
      events: [
        { id: '999999999', valid: false },
        { id: event?.id, valid: true },
        { id: event?.id, valid: true },
      ],
    });
    for (let index = 1; index < PUSH_CHECKS_PER_MINUTE; index += 1) await checker.checkEvents(session, [event!.id]);
    await expect(checker.checkEvents(session, [event!.id])).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await expect(checker.checkEvents(await newSession(), [event!.id])).resolves.toEqual({ events: [{ id: event?.id, valid: true }] });
  });

  it('o descarte deixa no log só o evento, o tipo e o motivo, sem conteúdo da conversa', async () => {
    await useDevices('device-drop-log');
    const bot = await world.createBot();
    const runId = await completedRun(bot, 'texto-secreto-do-descarte-24680');
    const [event] = await eventsOf(runId);
    await world.pool.query('UPDATE conversations SET read_through_message_id = $2 WHERE bot_id = $1', [bot.id, event?.message_id]);
    const lines: string[] = [];
    const logger = createLogger({ level: 'info', name: 'push-test', destination: { write: (line: string) => void lines.push(line) } });

    await dispatcher({}, { logger }).tickOnce();
    const dropped = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((entry) => String(entry.msg).startsWith('push descartado'));
    expect(dropped).toMatchObject({ eventId: event?.id, kind: 'run_completed', reason: 'read' });
    expect(lines.join('')).not.toContain('texto-secreto-do-descarte-24680');
  });
});

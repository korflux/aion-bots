// Prova da matriz de silenciar (A13; F14 passo 4; T13) contra PostgreSQL real, o motor de execução real, o provedor falso e o FCM falso:
// o despachante não envia o tipo silenciado de um bot (nem do Chat geral) e os demais continuam chegando, o silêncio vale também para o
// que já estava na caixa de saída e voltar a receber vale na hora, a matriz lista só os bots ativos mais o Chat geral, e a alteração é
// idempotente, validada e auditada só quando muda algo.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { PUSH_EVENT_LABELS } from '@aion/shared';
import type { FcmServiceAccount } from '../config';
import { GeneralChatService } from '../general-chat/service';
import { ORIGIN, createRunsWorld, type RunsWorld } from '../runs/test-support';
import { PushDispatcher } from './dispatcher';
import { createFcmClient } from './fcm';
import { PushService } from './service';

const ACCOUNT: FcmServiceAccount = {
  projectId: 'aion-test',
  clientEmail: 'push@aion-test.iam.gserviceaccount.com',
  privateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};
const GHOST = '00000000-0000-4000-8000-000000000000';

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

const dispatcher = () =>
  new PushDispatcher({
    pool: world.pool,
    fcm: createFcmClient({ serviceAccount: ACCOUNT, baseUrl: world.upstreams.fcmBaseUrl, tokenUrl: world.upstreams.fcmTokenUrl }),
    logger: world.logger,
  });

/** Começa o teste com um dispositivo, sem eventos, sem silêncios e sem mensagens anteriores no FCM falso. */
async function reset(): Promise<void> {
  await world.pool.query('DELETE FROM push_events');
  await world.pool.query('DELETE FROM push_devices');
  await world.pool.query('DELETE FROM push_mutes');
  world.upstreams.fcmMessages.length = 0;
  await push.registerDevice('device-matrix', ORIGIN);
}

/** O que o FCM falso recebeu, como [título, tipo]. */
const delivered = () => world.upstreams.fcmMessages.map((message) => [message.data.title, message.data.kind]);

/** [tipo, estado] de cada evento da execução; o descarte acrescenta o motivo (phase 3, T3). */
const eventStatuses = async (runId: string) =>
  (
    await world.pool.query<{ kind: string; status: string; drop_reason: string | null }>('SELECT kind, status, drop_reason FROM push_events WHERE run_id = $1 ORDER BY id', [runId])
  ).rows.map((row) => (row.drop_reason === null ? [row.kind, row.status] : [row.kind, row.status, row.drop_reason]));

describe('a matriz de silenciar (A13)', () => {
  it('um tipo silenciado de um bot não gera push, e os outros tipos, os outros bots e o Chat geral continuam chegando', async () => {
    await reset();
    const silenced = await world.createBot({ name: 'Bot silenciado' });
    const other = await world.createBot({ name: 'Bot que segue' });
    await push.setMute(silenced.id, 'run_completed', true, ORIGIN);

    // Silenciado: concluída. Segue: falha do MESMO bot, e a conclusão de OUTRO bot.
    const completed = await world.send(silenced, 'concluir');
    const otherCompleted = await world.send(other, 'concluir também');
    const failed = await world.send(silenced, '[falha] provedor fora');
    await Promise.all([world.waitForStatus(completed, 'completed'), world.waitForStatus(otherCompleted, 'completed'), world.waitForStatus(failed, 'failed')]);

    expect(await dispatcher().tickOnce()).toBe(3);
    expect(delivered().sort()).toEqual(
      [
        [other.name, 'run_completed'],
        [silenced.name, 'run_failed'],
      ].sort(),
    );
    // O evento silenciado é tratado e descartado com o motivo (não fica na fila nem é repetido), sem ter tocado o FCM (phase 3, T3).
    expect(await eventStatuses(completed)).toEqual([['run_completed', 'dropped', 'muted']]);
    expect(await dispatcher().tickOnce()).toBe(0);

    // Voltar a receber vale na hora para o que vier depois.
    await push.setMute(silenced.id, 'run_completed', false, ORIGIN);
    world.upstreams.fcmMessages.length = 0;
    const again = await world.send(silenced, 'concluir de novo');
    await world.waitForStatus(again, 'completed');
    await dispatcher().tickOnce();
    expect(delivered()).toEqual([[silenced.name, 'run_completed']]);
  });

  it('o silêncio vale para o que já estava gravado na caixa de saída e ainda não foi enviado', async () => {
    await reset();
    const bot = await world.createBot({ name: 'Bot da fila' });
    const runId = await world.send(bot, 'concluir');
    await world.waitForStatus(runId, 'completed');
    expect(await eventStatuses(runId)).toEqual([['run_completed', 'pending']]);

    await push.setMute(bot.id, 'run_completed', true, ORIGIN);
    await dispatcher().tickOnce();
    expect(world.upstreams.fcmMessages).toEqual([]);
    expect(await eventStatuses(runId)).toEqual([['run_completed', 'dropped', 'muted']]);
  });

  it('cada tipo é independente: silenciar "Aprovação pendente" não silencia "Aprovação expirada" do mesmo bot', async () => {
    await reset();
    const bot = await world.createBot({ name: 'Bot que pede' });
    await push.setMute(bot.id, 'approval_pending', true, ORIGIN);
    await world.releaseConnectorAccounts(bot);
    const runId = await world.send(bot, '[gmail] enviar');
    await world.waitForStatus(runId, 'waiting_approval');
    const approval = await world.approvalOf(runId);
    await world.pool.query("UPDATE approvals SET expires_at = now() - interval '1 second' WHERE id = $1", [approval?.id]);
    await world.waitForStatus(runId, 'expired');

    expect(await dispatcher().tickOnce()).toBe(2);
    expect(world.upstreams.fcmMessages.map((message) => [message.data.title, message.data.body])).toEqual([[bot.name, PUSH_EVENT_LABELS.approval_expired]]);
  });

  it('o Chat geral tem a própria linha: silenciá-lo não silencia os bots, e silenciar um bot não silencia o Chat geral', async () => {
    await reset();
    const bot = await world.createBot({ name: 'Bot vizinho' });
    const sessions = new GeneralChatService({ pool: world.pool });
    const session = await sessions.create();
    await world.conversations.setPreference({ sessionId: session.id }, 'opencode/glm-5.1', null);

    // Só o Chat geral silencia a conclusão: a do bot chega.
    await push.setMute(null, 'run_completed', true, ORIGIN);
    const chatRun = (await world.conversations.send({ sessionId: session.id }, 'concluir no chat')).id;
    const botRun = await world.send(bot, 'concluir no bot');
    await Promise.all([world.waitForStatus(chatRun, 'completed'), world.waitForStatus(botRun, 'completed')]);
    await dispatcher().tickOnce();
    expect(delivered()).toEqual([[bot.name, 'run_completed']]);

    // Troca: o bot silencia e o Chat geral volta a receber.
    await push.setMute(null, 'run_completed', false, ORIGIN);
    await push.setMute(bot.id, 'run_completed', true, ORIGIN);
    world.upstreams.fcmMessages.length = 0;
    const chatAgain = (await world.conversations.send({ sessionId: session.id }, 'concluir de novo no chat')).id;
    const botAgain = await world.send(bot, 'concluir de novo no bot');
    await Promise.all([world.waitForStatus(chatAgain, 'completed'), world.waitForStatus(botAgain, 'completed')]);
    await dispatcher().tickOnce();
    expect(delivered()).toEqual([['Chat geral', 'run_completed']]);
  });
});

describe('listar e alterar a matriz', () => {
  it('lista os bots ativos em ordem alfabética e o Chat geral por último, com os tipos silenciados na ordem da allowlist; o arquivado sai e volta com o que tinha', async () => {
    await reset();
    const zeta = await world.createBot({ name: 'Zeta matriz' });
    const alfa = await world.createBot({ name: 'alfa matriz' });
    const arquivado = await world.createBot({ name: 'Bot arquivado matriz' });

    await push.setMute(alfa.id, 'approval_expired', true, ORIGIN);
    await push.setMute(alfa.id, 'run_failed', true, ORIGIN);
    await push.setMute(arquivado.id, 'run_completed', true, ORIGIN);
    await world.bots.archive(arquivado.id, ORIGIN);

    const targets = (await push.listPreferences()).targets;
    const names = targets.map((target) => target.name);
    expect(names.at(-1)).toBe('Chat geral');
    expect(targets.at(-1)).toEqual({ botId: null, name: 'Chat geral', muted: [] });
    expect(names).not.toContain('Bot arquivado matriz');
    expect(names.indexOf('alfa matriz')).toBeLessThan(names.indexOf('Zeta matriz')); // sem distinguir maiúsculas
    expect(targets.find((target) => target.botId === alfa.id)?.muted).toEqual(['run_failed', 'approval_expired']);
    expect(targets.find((target) => target.botId === zeta.id)?.muted).toEqual([]); // bot novo recebe tudo

    await world.bots.unarchive(arquivado.id, ORIGIN);
    expect((await push.listPreferences()).targets.find((target) => target.botId === arquivado.id)?.muted).toEqual(['run_completed']);
  });

  it('silenciar e voltar a receber são idempotentes e devolvem a linha atualizada; só a mudança real é auditada, sem dado da conversa', async () => {
    await reset();
    await world.pool.query("DELETE FROM audit_log WHERE action = 'push.mute_set'");
    const bot = await world.createBot({ name: 'Bot auditado' });

    expect(await push.setMute(bot.id, 'approval_pending', true, ORIGIN)).toEqual({ botId: bot.id, name: bot.name, muted: ['approval_pending'] });
    expect(await push.setMute(bot.id, 'approval_pending', true, ORIGIN)).toMatchObject({ muted: ['approval_pending'] }); // repetir não erra
    expect(await push.setMute(bot.id, 'run_completed', true, ORIGIN)).toMatchObject({ muted: ['run_completed', 'approval_pending'] });
    expect(await push.setMute(bot.id, 'run_completed', false, ORIGIN)).toMatchObject({ muted: ['approval_pending'] });
    expect(await push.setMute(bot.id, 'run_completed', false, ORIGIN)).toMatchObject({ muted: ['approval_pending'] }); // já recebia
    expect(await push.setMute(null, 'run_failed', true, ORIGIN)).toEqual({ botId: null, name: 'Chat geral', muted: ['run_failed'] });
    await push.setMute(null, 'run_failed', false, ORIGIN);

    const audit = await world.pool.query<{ target: string; details: unknown }>("SELECT target, details FROM audit_log WHERE action = 'push.mute_set' ORDER BY id");
    expect(audit.rows).toEqual([
      { target: bot.id, details: { kind: 'approval_pending', muted: true } },
      { target: bot.id, details: { kind: 'run_completed', muted: true } },
      { target: bot.id, details: { kind: 'run_completed', muted: false } },
      { target: 'general_chat', details: { kind: 'run_failed', muted: true } },
      { target: 'general_chat', details: { kind: 'run_failed', muted: false } },
    ]);
  });

  it('um bot que não existe é BOT_NOT_FOUND e não grava nada; o banco recusa linha duplicada e tipo fora da allowlist', async () => {
    await reset();
    await expect(push.setMute(GHOST, 'run_completed', true, ORIGIN)).rejects.toMatchObject({ code: 'BOT_NOT_FOUND' });
    expect((await world.pool.query('SELECT 1 FROM push_mutes')).rows).toEqual([]);

    const bot = await world.createBot();
    const insert = (botId: string | null, kind: string) => world.pool.query('INSERT INTO push_mutes (bot_id, kind, created_at) VALUES ($1, $2, now())', [botId, kind]);
    await insert(bot.id, 'run_failed');
    await expect(insert(bot.id, 'run_failed')).rejects.toMatchObject({ code: '23505' });
    await insert(null, 'run_failed');
    await expect(insert(null, 'run_failed')).rejects.toMatchObject({ code: '23505' }); // NULL não escapa da unicidade do Chat geral
    await expect(insert(bot.id, 'qualquer_coisa')).rejects.toMatchObject({ code: '23514' });
  });
});

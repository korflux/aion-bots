// Prova das versões e do caminho ativo do Chat geral (phase 4, T3; A1 a A7, CONV-01, CONV-02, ATT-01): árvore de mensagens e respostas com
// troca de versão, o contexto que o modelo recebe (janela de 5 rodadas e "Novo chat aberto" contados no caminho), a edição com anexos, gerar outra
// resposta no meio e no fim, retroceder, restaurar e enviar depois de retroceder, a leitura e o aviso, o bloqueio com execução aberta ou complemento
// pendente e o isolamento entre sessões. Mundo real: PostgreSQL embarcado, motor real e provedor falso (responde "Resposta: <última mensagem>").
import { ActivityService } from '../activities/service';
import { AttachmentService } from '../attachments/service';
import { DomainError } from '../errors';
import { GeneralChatService } from '../general-chat/service';
import { PushService } from '../push/service';
import { NEW_CHAT_MARKER, loadContextRows, loadRequestData } from '../runs/context';
import { ORIGIN, createRunsWorld, type RunsWorld } from '../runs/test-support';
import { JPEG_FIXTURE } from '../testing/attachment-fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readActivePath } from './path';
import { ConversationService, type SessionRef } from './service';

let world: RunsWorld;
let chat: GeneralChatService;

beforeAll(async () => {
  world = await createRunsWorld();
  chat = new GeneralChatService({ pool: world.pool });
  world.engine.start();
});

afterAll(async () => {
  await world.cleanup();
});

/** Código de domínio de uma promessa recusada (ou OK). */
const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    return error instanceof DomainError ? error.code : `INESPERADO:${String(error)}`;
  }
};

/** Sessão nova com modelo escolhido (a sessão não tem padrão de bot e o mundo não tem favoritos). */
async function openSession(): Promise<SessionRef> {
  const session = await chat.create();
  await world.conversations.setPreference({ sessionId: session.id }, 'opencode/glm-5.1', null);
  return { sessionId: session.id };
}

/** Espera a execução concluir e devolve o id dela. */
const done = async (run: { id: string }): Promise<string> => {
  await world.waitForStatus(run.id, 'completed');
  return run.id;
};

/** Envia e espera concluir; devolve o id da execução. */
const say = async (ref: SessionRef, text: string, attachmentIds: string[] = []): Promise<string> => done(await world.conversations.send(ref, text, attachmentIds));

/** A mensagem do dono que a execução responde. */
const messageOf = async (runId: string): Promise<string> =>
  (await world.pool.query<{ id: string }>('SELECT trigger_message_id::text AS id FROM runs WHERE id = $1', [runId])).rows[0]!.id;

/** Os textos das mensagens do caminho visível, na ordem. */
async function texts(ref: SessionRef): Promise<string[]> {
  const { rounds } = await readActivePath(world.pool, ref.sessionId);
  const found = await world.pool.query<{ id: string; content: string }>('SELECT id::text AS id, content FROM messages WHERE id = ANY($1::bigint[])', [rounds.map((round) => round.messageId)]);
  return rounds.map((round) => found.rows.find((row) => row.id === round.messageId)!.content);
}

/** Turnos do dono (e o marcador) do último pedido ao provedor: sem o bloco `# Dados` que cada abertura de rodada leva (PERF-01, phase 10) e sem os cartões "[Sistema] ...". */
function ownerTurns(): string[] {
  const body = world.conversationRequests().at(-1)!.body as { messages: { role: string; content: string }[] };
  return body.messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content.replace(/^# Dados\n[\s\S]*?\n\n# Mensagem\n/, ''))
    .filter((text) => !text.startsWith('[Sistema] ') || text === NEW_CHAT_MARKER);
}

describe('árvore de versões e caminho ativo do Chat geral', () => {
  it('R1: os 60 controles por minuto somam entre ações da conversa, sem bloquear outra sessão ou bot, e liberam ao vencer a janela', async () => {
    const a = await openSession();
    const b = await openSession();
    const first = await say(a, 'primeira rodada do limite');
    await say(a, 'segunda rodada do limite');
    const other = await say(b, 'outra conversa');
    const bot = await world.createBot();
    let at = new Date('2026-10-09T12:00:00Z');
    const controls = new ConversationService({ pool: world.pool, credentials: world.credentials, models: world.models, now: () => at });

    // São 60 controles efetivos na mesma conversa: a troca e o retrocesso seguem funcionais até a janela encher.
    for (let cycle = 0; cycle < 20; cycle += 1) {
      await controls.chooseVersion(a, { runId: first });
      await controls.rewind(a, first);
      await controls.restore(a);
    }
    await expect(controls.chooseVersion(a, { runId: first })).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 60 });
    expect(await codeOf(controls.rewind(a, first))).toBe('RATE_LIMITED');
    expect(await codeOf(controls.restore(a))).toBe('RATE_LIMITED');
    expect(await codeOf(controls.cancelComplement(a, '0'))).toBe('RATE_LIMITED');
    expect(await codeOf(controls.consumeDraft(a, '0'))).toBe('RATE_LIMITED');
    expect(await codeOf(controls.restore({ sessionId: a.sessionId.toUpperCase() }))).toBe('RATE_LIMITED');

    // Outra sessão ainda troca versões; controles de complemento/rascunho seguem até a validação de domínio, inclusive no bot.
    await controls.chooseVersion(b, { runId: other });
    expect(await codeOf(controls.cancelComplement(b, '0'))).toBe('COMPLEMENT_NOT_FOUND');
    expect(await codeOf(controls.consumeDraft(b, '0'))).toBe('DRAFT_NOT_FOUND');
    for (let attempt = 0; attempt < 60; attempt += 1) {
      expect(await codeOf(controls.cancelComplement(bot.id, '0'))).toBe('COMPLEMENT_NOT_FOUND');
    }
    expect(await codeOf(controls.consumeDraft(bot.id, '0'))).toBe('RATE_LIMITED');
    expect(await codeOf(controls.cancelComplement(bot.id.toUpperCase(), '0'))).toBe('RATE_LIMITED');
    await controls.chooseVersion(b, { runId: other });

    at = new Date('2026-10-09T12:00:59.999Z');
    await expect(controls.restore(a)).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 1 });
    at = new Date('2026-10-09T12:01:00Z');
    await controls.rewind(a, first);
    await controls.restore(a);
    expect(await texts(a)).toEqual(['primeira rodada do limite', 'segunda rodada do limite']);
  });

  it('árvore de 3 níveis: editar, gerar e trocar versões levam o contexto exatamente ao caminho ativo, com a janela e o marcador; nada sai do banco', async () => {
    const ref = await openSession();
    const r1 = await say(ref, 'm1');
    const r2 = await say(ref, 'm2');
    const r3 = await say(ref, 'm3');
    const [m1, m2] = [await messageOf(r1), await messageOf(r2)];

    // Nível da mensagem 2: a edição é versão ao lado da original, e o modelo deixa de ver a original e o que veio depois dela.
    const edited = await world.conversations.edit(ref, m2, 'm2 editada');
    await done(edited);
    const m2e = await messageOf(edited.id);
    expect(ownerTurns()).toEqual([NEW_CHAT_MARKER, 'm1', 'm2 editada']);
    await say(ref, 'm3 nova');
    expect(ownerTurns()).toEqual([NEW_CHAT_MARKER, 'm1', 'm2 editada', 'm3 nova']);

    // Nível da resposta 1 (resposta do meio): a versão nova não tem rodadas seguintes, e um envio cria o ramo dela.
    const r1b = await done(await world.conversations.regenerate(ref, r1));
    expect(ownerTurns()).toEqual([NEW_CHAT_MARKER, 'm1']);
    await say(ref, 'x2');
    expect(await texts(ref)).toEqual(['m1', 'x2']);

    // Voltar à resposta 1 reencontra a última escolha daquele ramo (a edição); a mensagem 2 original devolve o ramo dela inteiro.
    await world.conversations.chooseVersion(ref, { runId: r1 });
    expect(await texts(ref)).toEqual(['m1', 'm2 editada', 'm3 nova']);
    await world.conversations.chooseVersion(ref, { messageId: m2 });
    expect(await texts(ref)).toEqual(['m1', 'm2', 'm3']);

    // Nível da resposta 3 (resposta do fim) e a continuação: a janela e o marcador contam só o caminho.
    await done(await world.conversations.regenerate(ref, r3));
    expect(ownerTurns()).toEqual([NEW_CHAT_MARKER, 'm1', 'm2', 'm3']);
    await say(ref, 'm4');
    expect(ownerTurns()).toEqual([NEW_CHAT_MARKER, 'm1', 'm2', 'm3', 'm4']);
    await say(ref, 'm5');
    expect(ownerTurns()).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    await say(ref, 'm6');
    expect(ownerTurns()).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);

    // Trocar para a edição: o caminho volta a ter 3 rodadas e o marcador volta à janela.
    await world.conversations.chooseVersion(ref, { messageId: m2e });
    await say(ref, 'm4 do ramo editado');
    expect(ownerTurns()).toEqual([NEW_CHAT_MARKER, 'm1', 'm2 editada', 'm3 nova', 'm4 do ramo editado']);

    // As linhas montadas para o contexto são exatamente as do caminho: a mensagem de cada rodada e as linhas da resposta em vigor.
    const path = await readActivePath(world.pool, ref.sessionId);
    const rows = await loadContextRows(world.pool, ref.sessionId);
    const pathMessages = new Set(path.rounds.map((round) => round.messageId));
    const pathRuns = new Set(path.rounds.map((round) => round.runId));
    expect(rows.filter((row) => row.opens_round).map((row) => row.id)).toEqual(path.rounds.map((round) => round.messageId));
    expect(rows.every((row) => (row.opens_round ? pathMessages.has(row.id!) : pathRuns.has(row.run_id)))).toBe(true);
    expect(path.rounds[0]).toMatchObject({ messageId: m1, runId: r1, runVersions: [r1, r1b] });
    expect(path.rounds[1]).toMatchObject({ messageId: m2e, messageVersions: [m2, m2e] });

    // PERF-01 (phase 10): cada abertura do pedido leva o bloco `# Dados` gravado pela execução em vigor no caminho, uma por rodada, nunca a de outra versão
    // (a prova que distingue as versões pela hora e pelo modelo está em `runs/request-data.test.ts`, com o relógio do domínio movido).
    await loadRequestData(world.pool, ref.sessionId, rows, true);
    const storedRuns = await world.pool.query<{ id: string; request_data: string | null }>('SELECT id::text, request_data FROM runs WHERE id = ANY($1::bigint[])', [path.rounds.map((round) => round.runId)]);
    const pathBlocks = path.rounds.map((round) => storedRuns.rows.find((run) => run.id === round.runId)!.request_data);
    expect(pathBlocks.every((block) => typeof block === 'string')).toBe(true);
    expect(rows.filter((row) => row.opens_round).map((row) => row.request_data)).toEqual(pathBlocks);
    const sent = (world.conversationRequests().at(-1)!.body as { messages: { role: string; content: string }[] }).messages
      .filter((message) => message.role === 'user' && message.content.startsWith('# Dados'))
      .map((message) => /^# Dados\n[\s\S]*?\n\n# Mensagem\n/.exec(message.content)![0]);
    expect(sent).toEqual(pathBlocks);

    // Nada saiu do banco: todas as versões continuam lá.
    const all = (await world.pool.query<{ content: string }>("SELECT content FROM messages WHERE conversation_id = $1 AND role = 'user' ORDER BY id", [ref.sessionId])).rows;
    expect(all.map((row) => row.content)).toEqual(['m1', 'm2', 'm3', 'm2 editada', 'm3 nova', 'x2', 'm4', 'm5', 'm6', 'm4 do ramo editado']);

    // A tela recebe as rodadas do caminho com as versões de cada uma (posição = índice do id em vigor; total = tamanho).
    const snapshot = await world.conversations.snapshot(ref);
    expect(snapshot.rounds?.map((round) => [round.messageVersions.indexOf(round.messageId) + 1, round.messageVersions.length, round.runVersions.indexOf(round.runId!) + 1, round.runVersions.length])).toEqual([
      [1, 1, 1, 2],
      [2, 2, 1, 1],
      [1, 1, 1, 1],
      [1, 1, 1, 1],
    ]);
    expect(snapshot.items.filter((item) => item.kind === 'text' && item.role === 'user').map((item) => (item.kind === 'text' ? item.content : ''))).toEqual(['m1', 'm2 editada', 'm3 nova', 'm4 do ramo editado']);
    expect(snapshot.rewound).toBeNull();
  });

  it('editar traz os anexos escolhidos (removidos e somados), recusa imagem sem visão e conta o arquivo mantido uma vez no espaço', async () => {
    const files = new AttachmentService({ pool: world.pool, conversations: world.conversations });
    const ref = await openSession();
    const a = await files.upload(ref, 'a.txt', Buffer.from('conteudo-alfa'));
    const b = await files.upload(ref, 'b.txt', Buffer.from('conteudo-beta'));
    const sent = await say(ref, 'com anexos', [a.id, b.id]);
    const original = await messageOf(sent);
    const c = await files.upload(ref, 'c.txt', Buffer.from('conteudo-gama'));
    const usedBefore = (await files.list({})).usedBytes;

    // Imagem com um modelo sem visão confirmada: recusada sem criar nada.
    const image = await files.upload(ref, 'foto.jpg', JPEG_FIXTURE);
    expect(await codeOf(world.conversations.edit(ref, original, 'com imagem', [a.id, image.id]))).toBe('MODEL_NO_IMAGE_SUPPORT');
    expect(await texts(ref)).toEqual(['com anexos']);
    await files.discard(ref, image.id);

    // Remove b e soma c; a fica nas duas versões.
    const edited = await world.conversations.edit(ref, original, 'sem beta, com gama', [a.id, c.id]);
    expect(edited.attachments?.map((file) => file.id)).toEqual([a.id, c.id]);
    await done(edited);
    const request = JSON.stringify(world.conversationRequests().at(-1)!.body);
    expect(request).toContain('conteudo-alfa');
    expect(request).toContain('conteudo-gama');
    expect(request).not.toContain('conteudo-beta');
    const views = (await world.conversations.snapshot(ref)).items.filter((item) => item.kind === 'text' && item.role === 'user');
    expect(views.map((item) => item.attachments?.map((file) => file.id))).toEqual([[a.id, c.id]]);
    await world.conversations.chooseVersion(ref, { messageId: original });
    const back = (await world.conversations.snapshot(ref)).items.filter((item) => item.kind === 'text' && item.role === 'user');
    expect(back.map((item) => item.attachments?.map((file) => file.id))).toEqual([[a.id, b.id]]);

    // O arquivo mantido é uma linha só: o espaço não cresce com a versão nova.
    expect((await files.list({})).usedBytes).toBe(usedBefore);
    expect((await world.pool.query('SELECT 1 FROM attachments WHERE id = $1', [a.id])).rowCount).toBe(1);
  });

  it('gerar no meio e no fim, "Tentar novamente", retroceder, restaurar e enviar depois de retroceder criam os ramos da spec; versão alheia ou fora do caminho é VERSION_NOT_FOUND', async () => {
    const ref = await openSession();
    const r1 = await say(ref, 'm1');
    const r2 = await say(ref, 'm2');
    const r3 = await say(ref, 'm3');
    const [m2, m3] = [await messageOf(r2), await messageOf(r3)];

    // Gerar na resposta do meio: a rodada 3 sai do caminho e continua recuperável pela versão anterior.
    const r2b = await done(await world.conversations.regenerate(ref, r2));
    expect(await texts(ref)).toEqual(['m1', 'm2']);
    expect((await world.conversations.snapshot(ref)).rounds?.[1]).toMatchObject({ runId: r2b, runVersions: [r2, r2b] });
    await world.conversations.chooseVersion(ref, { runId: r2 });
    expect(await texts(ref)).toEqual(['m1', 'm2', 'm3']);

    // Gerar na resposta do fim e o "Tentar novamente" da sessão (o mesmo comando).
    const r3b = await done(await world.conversations.regenerate(ref, r3));
    const r3c = await done(await world.conversations.retry(ref, r3b));
    expect((await world.conversations.snapshot(ref)).rounds?.[2]).toMatchObject({ messageId: m3, runId: r3c, runVersions: [r3, r3b, r3c] });

    // Retroceder até a resposta 1: duas rodadas saem da tela e do contexto, sem apagar.
    let snapshot = await world.conversations.rewind(ref, r1);
    expect(snapshot.rewound).toEqual({ runId: r1, rounds: 2 });
    expect(snapshot.items.filter((item) => item.kind === 'text' && item.role === 'user').map((item) => (item.kind === 'text' ? item.content : ''))).toEqual(['m1']);
    expect((await loadContextRows(world.pool, ref.sessionId)).filter((row) => row.role === 'user').map((row) => row.content)).toEqual(['m1']);
    expect((await new ActivityService({ pool: world.pool }).list(undefined)).items.find((item) => item.runId === r3c)).toMatchObject({ offPath: true });

    // Restaurar devolve o caminho anterior inteiro; sem retrocesso não há o que restaurar.
    snapshot = await world.conversations.restore(ref);
    expect(snapshot.rewound).toBeNull();
    expect(await texts(ref)).toEqual(['m1', 'm2', 'm3']);
    expect(await codeOf(world.conversations.restore(ref))).toBe('VERSION_NOT_FOUND');

    // Retroceder e enviar: a mensagem nova é versão ao lado da primeira rodada retrocedida, e o retrocesso deixa de valer.
    await world.conversations.rewind(ref, r1);
    const afterRewind = await world.conversations.latestEventId(ref.sessionId);
    const r2n = await say(ref, 'm2 nova');
    // A mensagem que vira versão muda a forma do caminho: o evento `path` avisa as telas abertas (T4), que relêem o snapshot.
    expect((await world.conversations.updatesSince(ref.sessionId, afterRewind)).updates.map((update) => update.event)).toContain('path');
    const m2n = await messageOf(r2n);
    snapshot = await world.conversations.snapshot(ref);
    expect(snapshot.rewound).toBeNull();
    expect(snapshot.rounds?.[1]).toMatchObject({ messageId: m2n, messageVersions: [m2, m2n] });
    expect(ownerTurns()).toEqual([NEW_CHAT_MARKER, 'm1', 'm2 nova']);
    const activities = (await new ActivityService({ pool: world.pool }).list(undefined)).items;
    expect(activities.find((item) => item.runId === r2)).toMatchObject({ offPath: true });
    expect(activities.find((item) => item.runId === r2n)?.offPath).toBeUndefined();

    // Fora do caminho, sem rodadas depois, de outra sessão ou de um bot: nada muda.
    expect(await codeOf(world.conversations.rewind(ref, r2n))).toBe('VERSION_NOT_FOUND');
    expect(await codeOf(world.conversations.regenerate(ref, r2))).toBe('VERSION_NOT_FOUND');
    expect(await codeOf(world.conversations.edit(ref, m3, 'fora do caminho'))).toBe('VERSION_NOT_FOUND');
    const other = await openSession();
    const o1 = await say(other, 'outra sessão');
    expect(await codeOf(world.conversations.chooseVersion(ref, { runId: o1 }))).toBe('VERSION_NOT_FOUND');
    expect(await codeOf(world.conversations.chooseVersion(ref, { messageId: await messageOf(o1) }))).toBe('VERSION_NOT_FOUND');
    expect(await codeOf(world.conversations.edit(ref, await messageOf(o1), 'alheia'))).toBe('VERSION_NOT_FOUND');
    const bot = await world.createBot();
    const botConversation = await world.conversations.conversationIdOf(bot.id);
    expect(await codeOf(world.conversations.chooseVersion({ sessionId: botConversation }, { runId: r1 }))).toBe('SESSION_NOT_FOUND');
    expect(await texts(ref)).toEqual(['m1', 'm2 nova']);
  });

  it('trocar de versão não gera novidade, bolinha nem aviso; a resposta de uma versão nova segue a leitura e o aviso da phase 3', async () => {
    const push = new PushService({ pool: world.pool, config: { enabled: false } });
    await push.registerDevice('device-versions', ORIGIN);
    const ref = await openSession();
    const r1 = await say(ref, 'pergunta');
    const r1b = await done(await world.conversations.regenerate(ref, r1));
    await world.pool.query('UPDATE conversations SET read_through_message_id = (SELECT max(id) FROM messages WHERE conversation_id = $1) WHERE id = $1', [ref.sessionId]);
    const count = async (sql: string): Promise<number> => Number((await world.pool.query<{ total: string }>(sql, [ref.sessionId])).rows[0]?.total);
    const pushes = 'SELECT count(*) AS total FROM push_events e JOIN runs r ON r.id = e.run_id WHERE r.conversation_id = $1';
    const before = { pushes: await count(pushes), messages: await count('SELECT count(*) AS total FROM messages WHERE conversation_id = $1') };
    expect((await chat.get(ref.sessionId)).unread).toBe(false);

    const cursor = await world.conversations.latestEventId(ref.sessionId);
    await world.conversations.chooseVersion(ref, { runId: r1 });
    await world.conversations.chooseVersion(ref, { runId: r1b });
    // Os aparelhos abertos só recebem o aviso de que o caminho mudou (uma atualização `path`, sem mensagem nova).
    expect((await world.conversations.updatesSince(ref.sessionId, cursor)).updates.map((update) => update.event)).toEqual(['path']);
    expect((await chat.get(ref.sessionId)).unread).toBe(false);
    expect({ pushes: await count(pushes), messages: await count('SELECT count(*) AS total FROM messages WHERE conversation_id = $1') }).toEqual(before);

    await done(await world.conversations.regenerate(ref, r1b));
    expect((await chat.get(ref.sessionId)).unread).toBe(true);
    expect(await count(pushes)).toBe(before.pushes + 1);
  });

  it('todas as trocas de caminho recusam com execução aberta ou complemento pendente (CONVERSATION_BUSY) e voltam a valer com a sessão parada', async () => {
    const ref = await openSession();
    const r1 = await say(ref, 'm1');
    const m1 = await messageOf(r1);
    const commands = () => [
      world.conversations.edit(ref, m1, 'editada'),
      world.conversations.regenerate(ref, r1),
      world.conversations.rewind(ref, r1),
      world.conversations.restore(ref),
      world.conversations.chooseVersion(ref, { runId: r1 }),
      world.conversations.retry(ref, r1),
    ];
    const running = await world.conversations.send(ref, '[demorar] segura a sessão');
    await world.waitForStatus(running.id, 'running');
    expect(await Promise.all(commands().map(codeOf))).toEqual(Array(6).fill('CONVERSATION_BUSY'));
    expect((await world.conversations.send(ref, 'complemento')).kind).toBe('complement');
    expect(await Promise.all(commands().map(codeOf))).toEqual(Array(6).fill('CONVERSATION_BUSY'));

    await world.conversations.stop(ref);
    await world.waitForStatus(running.id, 'interrupted');
    expect(await codeOf(world.conversations.chooseVersion(ref, { runId: r1 }))).toBe('OK');
    expect(await codeOf(world.conversations.rewind(ref, r1))).toBe('OK');
    expect(await texts(ref)).toEqual(['m1']);
  });

  it('a retenção de 7 dias apaga a sessão inteira, com todos os ramos, os vínculos extras de anexo e o retrocesso em vigor', async () => {
    const files = new AttachmentService({ pool: world.pool, conversations: world.conversations });
    const ref = await openSession();
    const file = await files.upload(ref, 'ramo.txt', Buffer.from('arquivo dos dois ramos'));
    const r1 = await say(ref, 'm1');
    const r2 = await say(ref, 'm2', [file.id]);
    await done(await world.conversations.edit(ref, await messageOf(r2), 'm2 editada', [file.id]));
    await world.conversations.rewind(ref, r1);
    const later = new GeneralChatService({ pool: world.pool, now: () => new Date(Date.now() + 8 * 24 * 3600_000) });
    await later.purgeExpired();
    const left = async (sql: string) => Number((await world.pool.query<{ total: string }>(sql, [ref.sessionId])).rows[0]?.total);
    expect(await left('SELECT count(*) AS total FROM conversations WHERE id = $1')).toBe(0);
    expect(await left('SELECT count(*) AS total FROM messages WHERE conversation_id = $1')).toBe(0);
    expect(await left('SELECT count(*) AS total FROM runs WHERE conversation_id = $1')).toBe(0);
    expect(await left('SELECT count(*) AS total FROM attachments WHERE conversation_id = $1')).toBe(0);
    expect(Number((await world.pool.query<{ total: string }>('SELECT count(*) AS total FROM message_attachment_links WHERE attachment_id = $1', [file.id])).rows[0]?.total)).toBe(0);
  });
});

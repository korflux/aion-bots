// Prova da retenção das sessões do chat geral (F16 passo 5, A15, decisão 17; T12) contra PostgreSQL real e o motor real, com DATAS
// SIMULADAS: o serviço de retenção recebe um relógio que anda para a frente, então "7 dias depois da última mensagem" é provado sem
// esperar nem editar datas no banco. Prova o limite exato, o que NÃO é apagado (salva, com trabalho em curso, de bot), o que é apagado
// por inteiro (mensagens, execuções, aprovações, eventos e avisos de push), a sessão apagada respondendo SESSION_NOT_FOUND e a corrida
// com uma mensagem que chega durante a exclusão.
import { CHAT_SESSION_RETENTION_MS } from '@aion/shared';
import type { PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '../errors';
import { ORIGIN, createRunsWorld, waitFor, type RunsWorld } from '../runs/test-support';
import { seedLegacyChatApproval } from '../testing/legacy-chat-approval';
import { GeneralChatService } from './service';

const DAY = 24 * 60 * 60 * 1000;

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    return error instanceof DomainError ? error.code : `INESPERADO:${String(error)}`;
  }
};

describe('retenção de 7 dias das sessões do chat geral', () => {
  let world: RunsWorld;
  let chat: GeneralChatService;
  /** Instante que a retenção enxerga como "agora" (ms). Nulo = o relógio real. As mensagens nascem no tempo real; a retenção as vê no futuro. */
  let clock: number | null = null;
  /** Só a corrida de mensagem simula também o relógio do envio e motor; os demais cenários mantêm prazos reais de aprovação. */
  let executionClock: number | null = null;
  let retention: GeneralChatService;

  beforeAll(async () => {
    world = await createRunsWorld({ now: () => new Date(executionClock ?? Date.now()), engine: { approvalSweepMs: 10 * 60_000 } });
    await world.connectComposio();
    chat = new GeneralChatService({ pool: world.pool });
    retention = new GeneralChatService({ pool: world.pool, now: () => new Date(clock ?? Date.now()) });
    world.engine.start();
  });
  // Cada teste termina sem sessão temporária sobrando (a retenção de outro teste as contaria): apaga o que sobrou, no futuro distante.
  afterEach(async () => {
    clock = Date.now() + 365 * DAY;
    await retention.purgeExpired();
    clock = null;
    executionClock = null;
  });
  afterAll(async () => {
    await world.cleanup();
  });

  /** Sessão com uma conversa concluída (a última mensagem é a resposta do bot, no instante real do teste). */
  async function sessionWithConversation() {
    const session = await chat.create();
    await world.conversations.setPreference({ sessionId: session.id }, 'opencode/glm-5.1', null);
    const run = (await world.conversations.send({ sessionId: session.id }, 'conversa que vai vencer')).id;
    await world.waitForStatus(run, 'completed');
    return { session, run };
  }

  /**
   * Aprovação de ação do conector pendente na sessão, como a phase 12 a deixava no banco: o conector saiu do Chat geral na phase 13 (A6, A7) e nada mais cria uma pendência ali, então a prova
   * a semeia (`seedLegacyChatApproval`: execução esperando, atividade "aguardando", pedido e cartão pelo `ApprovalService`). Devolve a execução. O que a retenção prova (apagar sessão com pedido,
   * e não apagar enquanto há trabalho esperando o dono) não depende de qual ferramenta pediu.
   */
  const seedPendingApproval = async (sessionId: string): Promise<string> =>
    (await seedLegacyChatApproval({ pool: world.pool, approvals: world.approvals, sessionId, input: '[gmail] envie', withProvenance: true })).runId;

  const exists = async (id: string): Promise<boolean> => (await world.pool.query('SELECT 1 FROM conversations WHERE id = $1', [id])).rowCount === 1;
  const countOf = async (table: string, id: string): Promise<number> =>
    Number((await world.pool.query<{ total: string }>(`SELECT count(*) AS total FROM ${table} WHERE conversation_id = $1`, [id])).rows[0]?.total);

  /** O corte sempre ao redor do instante da última mensagem: as execuções do teste usam o relógio real. */
  const lastActivity = async (id: string): Promise<number> => Date.parse((await chat.get(id)).lastActivityAt);

  it('apaga a sessão não salva só DEPOIS de 7 dias da última mensagem, no limite exato', async () => {
    const { session } = await sessionWithConversation();
    const last = await lastActivity(session.id);

    clock = last + 7 * DAY; // exatamente 7 dias depois da última mensagem: ainda não venceu
    expect(await retention.purgeExpired()).toBe(0);
    expect(await exists(session.id)).toBe(true);

    clock = last + 7 * DAY + 1; // 1 ms depois: venceu
    expect(await retention.purgeExpired()).toBe(1);
    expect(await exists(session.id)).toBe(false);
  });

  it('apaga mensagens, execuções, aprovações, eventos e avisos de push da sessão, e a sessão apagada responde SESSION_NOT_FOUND', async () => {
    // Uma sessão com tudo: uma execução concluída, uma que passou por aprovação, eventos de conversa e avisos na caixa de saída do push.
    await world.pool.query("INSERT INTO push_devices (token, label, created_at, last_seen_at) VALUES ('retention-device', 'teste', now(), now()) ON CONFLICT DO NOTHING");
    const { session, run: firstRun } = await sessionWithConversation();
    const approvalRun = await seedPendingApproval(session.id);
    const approval = await world.approvalOf(approvalRun);
    await world.approvals.respond(approval!.id, 'allow_once', ORIGIN);
    await world.waitForStatus(approvalRun, 'completed');

    // Controle: um bot com conversa, execução, aprovação e a memória dele. Nada disso pode ser tocado.
    const bot = await world.createBot();
    await world.waitForStatus(await world.send(bot, 'conversa do bot'), 'completed');
    const botConversation = (await world.pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [bot.id])).rows[0]!.id;

    expect(await countOf('messages', session.id)).toBeGreaterThan(4);
    expect(await countOf('runs', session.id)).toBe(2);
    expect(await countOf('approvals', session.id)).toBe(1);
    expect(await countOf('conversation_events', session.id)).toBeGreaterThan(4);
    const pushOf = async (): Promise<number> =>
      Number((await world.pool.query<{ total: string }>('SELECT count(*) AS total FROM push_events WHERE run_id = ANY($1::bigint[])', [[firstRun, approvalRun]])).rows[0]?.total);
    expect(await pushOf()).toBeGreaterThan(0);
    const botMessages = await countOf('messages', botConversation);
    const botRuns = await countOf('runs', botConversation);

    clock = (await lastActivity(session.id)) + 7 * DAY + 60_000;
    // As sessões que outros testes deixaram vencidas saem junto; o que importa é que ESTA saiu inteira e o bot ficou intacto.
    expect(await retention.purgeExpired()).toBeGreaterThanOrEqual(1);

    expect(await exists(session.id)).toBe(false);
    for (const table of ['messages', 'runs', 'approvals', 'conversation_events']) expect(await countOf(table, session.id), table).toBe(0);
    expect(await pushOf()).toBe(0);
    expect((await chat.list()).items.map((item) => item.id)).not.toContain(session.id);
    expect(await codeOf(chat.get(session.id))).toBe('SESSION_NOT_FOUND');
    expect(await codeOf(world.conversations.snapshot({ sessionId: session.id }))).toBe('SESSION_NOT_FOUND');
    expect(await codeOf(world.conversations.send({ sessionId: session.id }, 'oi'))).toBe('SESSION_NOT_FOUND');
    expect(await codeOf(chat.setSaved(session.id, true))).toBe('SESSION_NOT_FOUND');

    expect(await countOf('messages', botConversation)).toBe(botMessages);
    expect(await countOf('runs', botConversation)).toBe(botRuns);
    expect(await exists(botConversation)).toBe(true);
  });

  it('a sessão salva fica, e ao desligar "salvar" a contagem volta a partir da última mensagem (já vencida, sai no job seguinte)', async () => {
    const { session } = await sessionWithConversation();
    await chat.setSaved(session.id, true);
    clock = (await lastActivity(session.id)) + 30 * DAY; // 30 dias depois
    expect(await retention.purgeExpired()).toBe(0);
    expect(await exists(session.id)).toBe(true);

    // Desligar: a última mensagem é de 30 dias atrás (no relógio da retenção), então já passou dos 7 dias.
    await chat.setSaved(session.id, false);
    expect(await retention.purgeExpired()).toBe(1);
    expect(await exists(session.id)).toBe(false);

    // Desligar logo depois de uma conversa recente NÃO apaga: a contagem parte da última mensagem.
    const recent = await sessionWithConversation();
    await chat.setSaved(recent.session.id, true);
    await chat.setSaved(recent.session.id, false);
    clock = Date.now() + 3 * DAY;
    expect(await retention.purgeExpired()).toBe(0);
    expect(await exists(recent.session.id)).toBe(true);
  });

  it('uma sessão ainda vazia conta os 7 dias a partir da criação', async () => {
    const empty = await chat.create();
    const created = Date.parse(empty.createdAt);
    clock = created + 7 * DAY;
    expect(await retention.purgeExpired()).toBe(0);
    expect(await exists(empty.id)).toBe(true);
    clock = created + 7 * DAY + 1;
    expect(await retention.purgeExpired()).toBeGreaterThanOrEqual(1);
    expect(await exists(empty.id)).toBe(false);
  });

  it('uma sessão com trabalho em curso (esperando aprovação) não é apagada, e some depois que o trabalho termina', async () => {
    const session = await chat.create();
    await world.conversations.setPreference({ sessionId: session.id }, 'opencode/glm-5.1', null);
    const run = await seedPendingApproval(session.id);

    clock = Date.now() + 30 * DAY;
    expect(await retention.purgeExpired()).toBe(0);
    expect(await exists(session.id)).toBe(true);

    await world.approvals.respond((await world.approvalOf(run))!.id, 'deny', ORIGIN);
    await world.waitForStatus(run, 'completed');
    clock = Date.now() + 30 * DAY;
    expect(await retention.purgeExpired()).toBeGreaterThanOrEqual(1);
    expect(await exists(session.id)).toBe(false);
  });

  it('nenhuma conversa de bot é apagada, por mais antiga que seja', async () => {
    const bot = await world.createBot();
    await world.waitForStatus(await world.send(bot, 'conversa antiga do bot'), 'completed');
    const conversation = (await world.pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [bot.id])).rows[0]!.id;
    clock = Date.now() + 365 * DAY;
    await retention.purgeExpired();
    expect(await exists(conversation)).toBe(true);
    expect(await countOf('messages', conversation)).toBeGreaterThan(0);
  });

  it('uma mensagem que chega durante a exclusão vence a corrida: a sessão é conferida de novo sob trava e fica', async () => {
    const { session } = await sessionWithConversation();
    clock = (await lastActivity(session.id)) + 8 * DAY;
    // O novo envio está no "agora" da retenção, mesmo se o worker o concluir antes da releitura sob trava.
    executionClock = clock;

    // Segura a trava da conversa (como faz o envio de uma mensagem) enquanto a retenção já listou a sessão como vencida.
    const holder = await world.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM conversations WHERE id = $1 FOR UPDATE', [session.id]);
      const purge = retention.purgeExpired();
      await retentionWaitingForLock(holder); // a retenção lista, tenta travar e espera
      await holder.query(
        "INSERT INTO runs (conversation_id, status, input, created_at) VALUES ($1, 'queued', 'chegou a tempo', $2)",
        [session.id, new Date(clock)],
      );
      await holder.query('COMMIT');
      expect(await purge).toBe(0);
    } finally {
      holder.release();
    }
    expect(await exists(session.id)).toBe(true);
    expect(await countOf('runs', session.id)).toBe(2);
    // O motor segue a fila: a execução inserida é uma mensagem de verdade e termina normalmente.
    await waitFor('a execução da sessão terminar', async () => (await world.pool.query("SELECT 1 FROM runs WHERE conversation_id = $1 AND status = 'completed'", [session.id])).rowCount === 2);
    clock = null;
    executionClock = null;
  });

  /** Identifica a retenção esperando ESTE detentor, sem confundir uma trava concorrente de outra consulta com a corrida testada. */
  const retentionWaitingForLock = async (holder: PoolClient): Promise<boolean> => {
    const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    return waitFor('a retenção esperando a trava da conversa', async () => (await world.pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND query LIKE 'SELECT id FROM conversations%FOR UPDATE'",
      [pid],
    )).rowCount === 1);
  };

  /**
   * A retenção listou a sessão como vencida e espera a trava da conversa; `during` roda DENTRO da transação que segura a trava (o que o
   * envio de uma mensagem ou o "salvar" fazem) e a retenção, ao ganhar a trava, confere de novo e deve poupar a sessão (R22).
   */
  async function purgeWhileHeld(sessionId: string, during: (holder: PoolClient) => Promise<void>): Promise<number> {
    const holder = await world.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM conversations WHERE id = $1 FOR UPDATE', [sessionId]);
      const purge = retention.purgeExpired();
      await retentionWaitingForLock(holder);
      await during(holder);
      await holder.query('COMMIT');
      return await purge;
    } finally {
      holder.release();
    }
  }

  it('um "salvar" que chega durante a exclusão vence a corrida: a releitura sob trava vê a sessão salva e a poupa (R22)', async () => {
    const { session } = await sessionWithConversation();
    clock = (await lastActivity(session.id)) + 8 * DAY;
    expect(await purgeWhileHeld(session.id, async (holder) => void (await holder.query('UPDATE conversations SET saved = true WHERE id = $1', [session.id])))).toBe(0);
    expect(await exists(session.id)).toBe(true);
    clock = null;
  });

  it('uma mensagem recente que chega durante a exclusão vence a corrida: a última atividade é relida sob trava e a sessão fica (R22)', async () => {
    const { session } = await sessionWithConversation();
    clock = (await lastActivity(session.id)) + 8 * DAY;
    const simulatedNow = new Date(clock);
    const purged = await purgeWhileHeld(session.id, async (holder) => {
      await holder.query("INSERT INTO messages (conversation_id, role, kind, status, content, data, created_at) VALUES ($1, 'user', 'text', 'done', 'oi de novo', '{}', $2)", [session.id, simulatedNow]);
    });
    expect(purged).toBe(0);
    expect(await exists(session.id)).toBe(true);
    clock = null;
  });

  it('uma sessão que não pode ser apagada não trava as outras: as demais saem e o job falha no fim, dizendo quantas ficaram (R15)', async () => {
    const blocked = (await sessionWithConversation()).session;
    const other = (await sessionWithConversation()).session;
    clock = Math.max(await lastActivity(blocked.id), await lastActivity(other.id)) + 8 * DAY;

    // Uma tabela futura com chave estrangeira para a conversa e sem ON DELETE (o que a review R15 teme): o DELETE da sessão bloqueada falha (23503).
    await world.pool.query('CREATE TABLE retention_probe (conversation_id uuid NOT NULL REFERENCES conversations (id))');
    try {
      await world.pool.query('INSERT INTO retention_probe (conversation_id) VALUES ($1)', [blocked.id]);
      await expect(retention.purgeExpired()).rejects.toThrow(/1 sessão.*1 apagada/);
      expect(await exists(other.id)).toBe(false); // a sessão apagável saiu, mesmo com a outra falhando antes ou depois
      expect(await exists(blocked.id)).toBe(true); // a bloqueada fica intacta (a transação dela foi desfeita)
      expect(await countOf('messages', blocked.id)).toBeGreaterThan(0);
    } finally {
      await world.pool.query('DROP TABLE retention_probe');
    }
  });

  it('o prazo é de 7 dias exatos (constante da spec) e a retenção devolve zero quando não há o que apagar', async () => {
    expect(CHAT_SESSION_RETENTION_MS).toBe(7 * DAY);
    expect(await retention.purgeExpired()).toBe(0);
  });
});

// Prova, no motor real (PostgreSQL, provedor falso e Composio falso com duas contas Gmail ativas), de que cada bot age só nas contas do conector liberadas a ele (phase 13, CONN-02, passo 4):
// a conta usada na execução (A1) e na rotina (A21), a conferência da liberação no banco a cada execução (A4) e a cada retomada (A5), a auditoria com a conta e sem a chave (A10), a semeadura
// na primeira leitura boa (A14, A15) e o bot sem conta sem as portas (A16). A regra do parâmetro de conta (A3), as definições por bot (A2) e a estabilidade delas (A22) estão em
// `composio-tools.test.ts`, porque o provedor falso não escreve o parâmetro `account`; a estabilidade pelo motor está em `tool-discovery.test.ts` (A7) e a limpeza do resultado (A24), em
// `result-origin.test.ts`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableMarker } from '../testing/fake-upstreams';
import { ORIGIN, createRunsWorld, waitFor, type RunsWorld } from './test-support';

const CONNECTOR_KEY = 'valid-key-2222';

/** A regra global da ação de e-mail: `allow` executa sem pausar, `neutral` (sem regra) PERGUNTA e pausa a execução. */
async function setRule(world: RunsWorld, rule: 'allow' | 'neutral'): Promise<void> {
  await world.pool.query(
    `INSERT INTO approval_actions (slug, app_slug, app_name, label, global_rule, first_seen_at, last_seen_at)
     VALUES ('GMAIL_SEND_EMAIL', 'gmail', 'Gmail', 'Send Email · Gmail', $1, now(), now())
     ON CONFLICT (slug) DO UPDATE SET global_rule = EXCLUDED.global_rule`,
    [rule],
  );
}

/** Dá nome à conta (o nome é o valor do parâmetro de conta e o que a auditoria e o cartão mostram). */
async function rename(world: RunsWorld, id: string, name: string): Promise<void> {
  await world.accounts.rename(id, { name, expectedVersion: (await world.accounts.get(id)).version }, ORIGIN);
}

/** Tira a liberação da conta ao bot (as dos outros bots ficam), como o dono faz em Conexões. */
async function revoke(world: RunsWorld, id: string, bot: { id: string }): Promise<void> {
  const view = await world.accounts.get(id);
  await world.accounts.release(id, { botIds: view.botIds.filter((botId) => botId !== bot.id), expectedVersion: view.version }, ORIGIN);
}

/** As contas em que as ações chegaram ao Composio falso, na ordem (`connected_account_id` do corpo da execução). */
const executedAccounts = (world: RunsWorld): (string | undefined)[] => world.composioExecutions().map((request) => request.connectedAccountId);

/** Eventos de auditoria de uma ação (os `composio.*` da execução), do mais antigo ao mais novo. */
const audits = async (world: RunsWorld, action: string) =>
  (await world.pool.query<{ outcome: string; target: string; details: Record<string, string> }>('SELECT outcome, target, details FROM audit_log WHERE action = $1 ORDER BY id', [action])).rows;

/** As atividades de ferramenta de uma execução, com o resultado que o modelo leu. */
const activitiesOf = async (world: RunsWorld, runId: string) =>
  (await world.pool.query<{ status: string; content: string }>("SELECT status, content FROM messages WHERE run_id = $1 AND kind = 'activity' ORDER BY id", [runId])).rows;

/** As ferramentas que o modelo recebeu na última chamada, na ordem: o bot publica as portas do conector na lista fixa (phase 15, decisão 24), sem abrir grupo. */
const publishedToolsOfLastRequest = (world: RunsWorld): string[] => {
  const body = world.conversationRequests().at(-1)?.body as { tools: { function: { name: string } }[] };
  return body.tools.map((tool) => tool.function.name);
};

describe('cada bot age só nas contas liberadas a ele', () => {
  let world: RunsWorld;
  beforeAll(async () => {
    world = await createRunsWorld({ engine: { approvalSweepMs: 40 } });
    await world.connectComposio();
    // Os dois Gmail ativos do Composio falso ganham nome (o valor do parâmetro de conta, o que a auditoria e o cartão mostram).
    await rename(world, 'ca_1', 'Pessoal');
    await rename(world, 'ca_6', 'Profissional');
    world.engine.start();
  });
  afterAll(async () => {
    await world.cleanup();
  });

  it('A1 e A10: X executa na conta "Pessoal" e Y na "Profissional"; os eventos registram a conta pelo id mascarado e pelo nome, nunca a chave', async () => {
    await setRule(world, 'allow');
    const x = await world.createBot();
    const y = await world.createBot();
    await world.releaseConnectorAccounts(x, ['ca_1']);
    await world.releaseConnectorAccounts(y, ['ca_6']);
    const before = executedAccounts(world).length;
    const startedBefore = (await audits(world, 'composio.action_started')).length;

    const runX = await world.send(x, '[gmail] envie do X');
    await world.waitForStatus(runX, 'completed');
    const runY = await world.send(y, '[gmail] envie do Y');
    await world.waitForStatus(runY, 'completed');

    // A mesma ação (`GMAIL_SEND_EMAIL`), cada bot na sua conta: o Composio recebeu `ca_1` e depois `ca_6`.
    expect(executedAccounts(world).slice(before)).toEqual(['ca_1', 'ca_6']);
    // A10: a tentativa e o resultado levam a conta (id mascarado e nome) e o bot; nenhum deles contém a chave nem o id inteiro.
    const started = (await audits(world, 'composio.action_started')).slice(startedBefore);
    expect(started.map((event) => [event.details.account, event.details.accountName])).toEqual([['ca_…1', 'Pessoal'], ['ca_…6', 'Profissional']]);
    const finished = (await audits(world, 'composio.action')).filter((event) => [runX, runY].includes(event.details.run as string));
    expect(finished.map((event) => [event.outcome, event.target, event.details.account, event.details.accountName, event.details.bot])).toEqual([
      ['success', 'GMAIL_SEND_EMAIL', 'ca_…1', 'Pessoal', x.id],
      ['success', 'GMAIL_SEND_EMAIL', 'ca_…6', 'Profissional', y.id],
    ]);
    const everything = JSON.stringify([started, finished]);
    expect(everything).not.toContain(CONNECTOR_KEY);
    expect(everything).not.toMatch(/"ca_[16]"/);
    // E5 (phase 15): a base da aprovação tem nome próprio na auditoria (`basis`), e `via` é só o nome da porta na atividade, nunca no evento.
    expect([...started, ...finished].map((event) => [event.details.basis, 'via' in event.details])).toEqual(Array(4).fill(['allow_rule', false]));
  });

  // A47 e E6 (phase 15, passo 9): as portas do conector ficam sempre publicadas e só a CONN-02 (`account`, liberação do bot) decide a conta. Pela `use_tool` não passa conta nenhuma: a chamada é
  // recusada como porta reservada antes de qualquer resolução, então o Composio não recebe pedido de busca, de ação nem de execução, nenhuma conta é usada e nada é auditado como ação do conector.
  it('A47 e E6: use_tool apontada para composio_execute_action ou composio_search_actions é recusada como reservada: o Composio não é chamado e nenhuma conta é usada', async () => {
    await setRule(world, 'allow');
    const bot = await world.createBot();
    await world.releaseConnectorAccounts(bot, ['ca_6']);
    const toolRequests = () => world.upstreams.requests.filter((request) => request.service === 'composio' && request.path.includes('/tools')).length;
    const before = { executions: executedAccounts(world).length, requests: toolRequests() };
    const attempts = [
      { name: 'composio_execute_action', arguments: { action: 'GMAIL_SEND_EMAIL', arguments: { to: 'a@b.com', subject: 'x', body: 'y' }, account: 'Profissional' } },
      { name: 'composio_search_actions', arguments: { app: 'gmail', query: 'send email' } },
    ];
    for (const attempt of attempts) {
      const run = await world.send(bot, tableMarker('use_tool', attempt));
      await world.waitForStatus(run, 'completed');
      const [activity] = await activitiesOf(world, run);
      expect(activity).toMatchObject({ status: 'failed', content: expect.stringContaining('se chamam direto') });
      const logged = (await world.pool.query<{ action: string }>("SELECT action FROM audit_log WHERE details->>'run' = $1", [run])).rows;
      expect(logged).toEqual([]);
    }
    expect(executedAccounts(world)).toHaveLength(before.executions);
    expect(toolRequests()).toBe(before.requests);
    // Controle: a MESMA ação pela porta de sempre executa, na conta liberada.
    const direct = await world.send(bot, '[gmail] pela porta do conector');
    await world.waitForStatus(direct, 'completed');
    expect(executedAccounts(world).slice(before.executions)).toEqual(['ca_6']);
  });

  // A28 e E3 pelo motor: o dono aprovou uma ação; se a retomada reencontra outra (aqui, o pedido gravado diz outra ação), a aprovação não vale. Sem isso a prova de aprovação sairia do handler
  // reencontrado e a ação nova executaria com a aprovação da antiga. O Composio não é chamado e a recusa fica auditada (`basis: action_changed`).
  it('A28 e E3: a ação reencontrada na retomada precisa ser a do pedido aprovado; se difere, a ação não executa, o modelo recebe a recusa e a tentativa é auditada', async () => {
    await setRule(world, 'neutral');
    const bot = await world.createBot();
    await world.releaseConnectorAccounts(bot, ['ca_6']);
    const before = executedAccounts(world).length;
    const run = await world.send(bot, '[gmail] aprovar outra ação');
    const approval = await waitFor('pedido de aprovação pendente', async () => {
      const found = await world.approvalOf(run);
      return found?.status === 'pending' ? found : null;
    });
    await world.pool.query("INSERT INTO approval_actions (slug, app_slug, app_name, label, global_rule, first_seen_at, last_seen_at) VALUES ('GMAIL_OUTRA_ACAO', 'gmail', 'Gmail', 'Outra', 'neutral', now(), now()) ON CONFLICT DO NOTHING");
    await world.pool.query("UPDATE approvals SET action_slug = 'GMAIL_OUTRA_ACAO' WHERE id = $1", [approval.id]);
    await world.approvals.respond(approval.id, 'allow_once', ORIGIN);
    await world.waitForStatus(run, 'completed');

    expect(executedAccounts(world)).toHaveLength(before); // nada chegou ao Composio
    expect(await activitiesOf(world, run)).toEqual([expect.objectContaining({ status: 'failed', content: expect.stringContaining('A ação mudou depois do pedido de aprovação') })]);
    const denied = (await audits(world, 'composio.action')).filter((event) => event.details.run === run);
    expect(denied).toEqual([expect.objectContaining({ outcome: 'denied', target: 'GMAIL_SEND_EMAIL', details: expect.objectContaining({ basis: 'action_changed', account: 'ca_…6', accountName: 'Profissional' }) })]);
    expect((await audits(world, 'composio.action_started')).filter((event) => event.details.run === run)).toEqual([]);
  });

  it('A21: a rotina de um bot executa nas contas liberadas a ele, como numa mensagem do dono; a de um bot sem conta não alcança o Composio', async () => {
    await setRule(world, 'allow');
    const owner = await world.createBot();
    const stranger = await world.createBot();
    await world.releaseConnectorAccounts(owner, ['ca_6']);
    const routineOf = (bot: { id: string }) =>
      world.routines.create({ name: 'Envio', botId: bot.id, instruction: '[gmail] envie o relatório', schedule: { type: 'daily', times: ['07:00'] }, timezone: 'America/Sao_Paulo', startsAt: null, endsAt: null, maxRuns: null }, ORIGIN);
    const before = executedAccounts(world).length;

    const ownerRun = (await world.routines.runNow((await routineOf(owner)).id, ORIGIN)).id;
    await world.waitForStatus(ownerRun, 'completed');
    expect(executedAccounts(world).slice(before)).toEqual(['ca_6']);

    const strangerRun = (await world.routines.runNow((await routineOf(stranger)).id, ORIGIN)).id;
    await world.waitForStatus(strangerRun, 'completed');
    expect(executedAccounts(world).slice(before)).toEqual(['ca_6']); // nada novo: o bot sem conta não tem as portas do conector
    expect(await activitiesOf(world, strangerRun)).toEqual([expect.objectContaining({ status: 'failed', content: expect.stringContaining('"code":"TOOL_NOT_FOUND"') })]);
  });

  it('A4: com a leitura do conector em cache, revogar a liberação recusa a execução seguinte, sem chamar o Composio, e a recusa é auditada', async () => {
    await setRule(world, 'allow');
    const bot = await world.createBot();
    await world.releaseConnectorAccounts(bot, ['ca_1', 'ca_3']); // o GitHub mantém as portas do conector no bot depois da revogação do Gmail
    const first = await world.send(bot, '[gmail] primeiro');
    await world.waitForStatus(first, 'completed');
    const before = executedAccounts(world).length;
    expect(await activitiesOf(world, first)).toEqual([expect.objectContaining({ status: 'completed' })]);

    // O dono revoga a conta do Gmail; a leitura do Composio (60 s) segue em cache e o bot ainda recebe as portas, pelo GitHub.
    await revoke(world, 'ca_1', bot);
    const second = await world.send(bot, '[gmail] segundo');
    await world.waitForStatus(second, 'completed');

    expect(executedAccounts(world)).toHaveLength(before); // o Composio não foi chamado
    expect(await activitiesOf(world, second)).toEqual([expect.objectContaining({ status: 'failed', content: expect.stringMatching(/gmail.* não está conectado para este bot/u) })]);
    const denied = (await audits(world, 'composio.action')).filter((event) => event.details.run === second);
    expect(denied).toEqual([expect.objectContaining({ outcome: 'denied', target: 'GMAIL_SEND_EMAIL', details: expect.objectContaining({ reason: 'app_not_connected', basis: 'account' }) })]);
    expect((await audits(world, 'composio.action_started')).filter((event) => event.details.run === second)).toEqual([]); // a ação nunca começou
  });

  it('A5: a chamada pausada guarda o id da conta; revogada a liberação antes da aprovação, a retomada recusa sem executar, mesmo com OUTRA conta do mesmo app liberada ao bot', async () => {
    await setRule(world, 'neutral'); // sem regra a ação pergunta e pausa
    const bot = await world.createBot();
    await world.releaseConnectorAccounts(bot, ['ca_1']);
    const before = executedAccounts(world).length;
    const run = await world.send(bot, '[gmail] pausar');
    const approval = await waitFor('pedido de aprovação pendente', async () => {
      const found = await world.approvalOf(run);
      return found?.status === 'pending' ? found : null;
    });
    // A conta resolvida fica gravada na chamada pendente (o id, e o nome para o cartão e a auditoria).
    const stored = (await world.pool.query<{ call: { account?: { id: string; label: string }; arguments: string } }>('SELECT call FROM approvals WHERE id = $1', [approval.id])).rows[0]!.call;
    expect(stored.account).toEqual({ id: 'ca_1', label: 'Pessoal' });
    expect(Object.keys(JSON.parse(stored.arguments) as object)).not.toContain('account'); // o parâmetro de conta nunca fica nos argumentos da ação

    // Enquanto espera, o dono libera a OUTRA conta Gmail ao bot e revoga a do pedido; depois aprova.
    await world.releaseConnectorAccounts(bot, ['ca_6']);
    await revoke(world, 'ca_1', bot);
    await world.approvals.respond(approval.id, 'allow_once', ORIGIN);
    await world.waitForStatus(run, 'completed');

    expect(executedAccounts(world)).toHaveLength(before); // nada chegou ao Composio, nem na conta liberada depois
    expect(await activitiesOf(world, run)).toEqual([expect.objectContaining({ status: 'failed', content: expect.stringContaining('não está mais liberada') })]);
    const denied = (await audits(world, 'composio.action')).filter((event) => event.details.run === run);
    expect(denied).toEqual([expect.objectContaining({ outcome: 'denied', details: expect.objectContaining({ reason: 'account_not_allowed', account: 'ca_…1', accountName: 'Pessoal' }) })]);
  });

  it('A5: com a liberação intacta, a retomada executa na MESMA conta que o pedido gravou', async () => {
    await setRule(world, 'neutral');
    const bot = await world.createBot();
    await world.releaseConnectorAccounts(bot, ['ca_6']);
    const before = executedAccounts(world).length;
    const run = await world.send(bot, '[gmail] aprovar');
    const approval = await waitFor('pedido de aprovação pendente', async () => {
      const found = await world.approvalOf(run);
      return found?.status === 'pending' ? found : null;
    });
    await world.approvals.respond(approval.id, 'allow_once', ORIGIN);
    await world.waitForStatus(run, 'completed');
    expect(executedAccounts(world).slice(before)).toEqual(['ca_6']);
    const started = (await audits(world, 'composio.action_started')).filter((event) => event.details.run === run);
    expect(started).toEqual([expect.objectContaining({ details: expect.objectContaining({ basis: 'owner_approved', account: 'ca_…6', accountName: 'Profissional' }) })]);
  });

  it('A16: um bot sem nenhuma conta liberada não recebe as portas do conector; o bot com conta recebe', async () => {
    await setRule(world, 'allow');
    const without = await world.createBot();
    const withAccount = await world.createBot();
    await world.releaseConnectorAccounts(withAccount, ['ca_1']);
    const before = executedAccounts(world).length;

    await world.waitForStatus(await world.send(without, 'oi'), 'completed');
    expect(publishedToolsOfLastRequest(world)).toEqual(['abrir_grupo', 'use_tool', 'read_activity']);
    const blocked = await world.send(without, '[gmail] tente');
    await world.waitForStatus(blocked, 'completed');
    expect(await activitiesOf(world, blocked)).toEqual([expect.objectContaining({ status: 'failed', content: expect.stringContaining('"code":"TOOL_NOT_FOUND"') })]);
    expect(executedAccounts(world)).toHaveLength(before);

    await world.waitForStatus(await world.send(withAccount, 'oi'), 'completed');
    expect(publishedToolsOfLastRequest(world)).toEqual(['abrir_grupo', 'use_tool', 'read_activity', 'composio_search_actions', 'composio_execute_action']);
  });
});

// Retomada após aprovação de um bot que ficou SEM nenhuma conta liberada e ativa (R1 da review da phase 13; decisão 8 da spec: "conta fora da lista é recusada e auditada"). Sem conta
// utilizável o bot não recebe as portas do conector (A16), então a retomada não pode procurar o destino nas definições publicadas: ela o resolve direto na fonte do conector, e a
// recusa sai como `AccountRefusal` (motivo certo, auditoria `composio.action` negada), não como "Ação desconhecida". É a forma mais comum da revogação (bot com uma única conta).
describe('retomada após aprovação com o bot sem nenhuma conta liberada e ativa (A5, A17, R1)', () => {
  let world: RunsWorld;
  beforeAll(async () => {
    world = await createRunsWorld({ engine: { approvalSweepMs: 40 } });
    await world.connectComposio();
    await rename(world, 'ca_1', 'Pessoal');
    world.engine.start();
  });
  afterAll(async () => {
    await world.cleanup();
  });

  /** Bot só com "Pessoal" e uma ação de e-mail pausada aguardando o dono (sem regra a ação pergunta); devolve o que o teste precisa para responder à aprovação. */
  async function pauseOnOnlyAccount() {
    await setRule(world, 'neutral');
    const bot = await world.createBot();
    await world.releaseConnectorAccounts(bot, ['ca_1']);
    const before = executedAccounts(world).length;
    const run = await world.send(bot, '[gmail] pausar');
    const approval = await waitFor('pedido de aprovação pendente', async () => {
      const found = await world.approvalOf(run);
      return found?.status === 'pending' ? found : null;
    });
    return { bot, before, run, approval };
  }

  /** O desfecho esperado nos dois casos: a ação não chegou ao Composio, o modelo leu o motivo e a recusa ficou auditada (sem `composio.action_started`, a ação nunca começou). */
  async function expectRefusal(run: string, before: number, message: string, reason: 'account_not_allowed' | 'account_disconnected') {
    expect(executedAccounts(world)).toHaveLength(before); // nenhuma execução no Composio falso
    expect(await activitiesOf(world, run)).toEqual([expect.objectContaining({ status: 'failed', content: expect.stringContaining(message) })]);
    const denied = (await audits(world, 'composio.action')).filter((event) => event.details.run === run);
    expect(denied).toEqual([expect.objectContaining({ outcome: 'denied', target: 'GMAIL_SEND_EMAIL', details: expect.objectContaining({ basis: 'account', reason, account: 'ca_…1', accountName: 'Pessoal' }) })]);
    expect((await audits(world, 'composio.action_started')).filter((event) => event.details.run === run)).toEqual([]);
  }

  it('conta revogada: a única conta do bot é revogada enquanto a aprovação espera; a retomada recusa como "não está mais liberada", auditada, sem executar', async () => {
    const { bot, before, run, approval } = await pauseOnOnlyAccount();
    await revoke(world, 'ca_1', bot); // o bot fica sem nenhuma conta: as portas deixam de existir para ele
    expect(await world.accounts.releasedTo(bot.id)).toEqual([]);
    await world.approvals.respond(approval.id, 'allow_once', ORIGIN);
    await world.waitForStatus(run, 'completed');
    await expectRefusal(run, before, 'não está mais liberada', 'account_not_allowed');
  });

  it('conta desconectada: o Composio deixa de listar a única conta do bot enquanto a aprovação espera; a retomada recusa como "foi desconectada", auditada, sem executar', async () => {
    const { before, run, approval } = await pauseOnOnlyAccount();
    // A chave `noapps...` faz o Composio falso listar nenhuma conta (a conta de `ca_1` segue liberada e com nome, mas desconectada); a leitura é refeita porque a chave mudou.
    await world.credentials.save('connector', 'noapps-connector-key-1234', ORIGIN);
    await world.approvals.respond(approval.id, 'allow_once', ORIGIN);
    await world.waitForStatus(run, 'completed');
    await expectRefusal(run, before, 'foi desconectada do Composio', 'account_disconnected');
  });

  it('conta removida (R8): o Composio deixa de listar a única conta do bot e o dono a remove enquanto a aprovação espera; a retomada recusa como "não está mais liberada", auditada, sem executar', async () => {
    await world.connectComposio(); // o teste anterior deixou a chave sem contas salva; a ação só pausa com a conta ativa
    const { bot, before, run, approval } = await pauseOnOnlyAccount();
    await world.credentials.save('connector', 'noapps-connector-key-1234', ORIGIN);
    await world.accounts.remove('ca_1', ORIGIN); // só a conta que o Composio não lista é removível: a linha e a liberação saem do banco
    expect(await world.accounts.releasedTo(bot.id)).toEqual([]);
    await world.approvals.respond(approval.id, 'allow_once', ORIGIN);
    await world.waitForStatus(run, 'completed');
    await expectRefusal(run, before, 'não está mais liberada', 'account_not_allowed');
  });
});

describe('semeadura da liberação na primeira leitura boa (A14, A15)', () => {
  it('os bots que existiam antes da migration usam a conta de sempre (a primeira ativa de cada app) sem ninguém liberar; a conta e o bot criados depois nascem sem liberação', async () => {
    const world = await createRunsWorld({ engine: { approvalSweepMs: 40 } });
    try {
      await world.connectComposio();
      await setRule(world, 'allow');
      const x = await world.createBot();
      const y = await world.createBot();
      // Banco "de produção": os dois bots já existiam quando a 0050 rodou, então o instantâneo os lista e a semeadura ainda está pendente (nenhuma leitura boa do Composio aconteceu).
      await world.pool.query('UPDATE connector_seed SET completed_at = NULL, bot_ids = $1::uuid[]', [[x.id, y.id]]);
      expect(await world.accounts.releasedTo(x.id)).toEqual([]);
      world.engine.start();

      // A primeira execução lê as contas do Composio e conclui a semeadura: o bot X segue na conta de sempre, `ca_1` (a primeira ativa do Gmail; `ca_6`, a segunda, não é a dele).
      const run = await world.send(x, '[gmail] envie');
      await world.waitForStatus(run, 'completed');
      expect(executedAccounts(world)).toEqual(['ca_1']);

      // A14: a primeira conta ativa de cada app (Gmail `ca_1`, GitHub `ca_3`) fica liberada a TODOS os bots antigos; a outra conta Gmail, a nenhum.
      for (const bot of [x, y]) expect((await world.accounts.releasedTo(bot.id)).map((account) => account.id)).toEqual(['ca_3', 'ca_1']);
      expect((await world.accounts.get('ca_6')).botIds).toEqual([]);
      // A15: um bot criado depois e uma conta conectada depois não ganham liberação nenhuma.
      const created = await world.createBot();
      expect(await world.accounts.releasedTo(created.id)).toEqual([]);
      expect((await world.pool.query<{ done: boolean }>('SELECT completed_at IS NOT NULL AS done FROM connector_seed')).rows).toEqual([{ done: true }]);
    } finally {
      await world.cleanup();
    }
  });
});

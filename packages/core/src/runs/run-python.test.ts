// Prova da ferramenta `run_python` no worker (phase 4, T7; F8, A16 a A18, A21) com PostgreSQL real, o motor de verdade, o provedor falso e o sandbox
// FALSO (`testing/fake-sandbox.ts`, o mesmo HTTP do serviço real). O comportamento do Python de verdade é provado contra o container em
// `python-sandbox.test.ts`. Blocos:
// 1. oferta condicional (sem configuração o contexto é o de antes) e indisponibilidade (sandbox parado ou token errado);
// 2. entradas: tipos em /data/, anti-IDOR, removido, 50 MB e argumentos estritos;
// 3. saídas: formatos pelo conteúdo, limites, espaço global e o que o modelo recebe;
// 4. vagas e "Parar": a terceira chamada espera, "Parar" cancela executando ou esperando, a espera conta no tempo da execução;
// 5. logs sem código, saída nem nomes.
import { conversationSnapshotSchema, tableCreateSchema, type Bot, type PythonDetail } from '@aion/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it,vi } from 'vitest';
import { AttachmentService } from '../attachments/service';
import { GeneralChatService } from '../general-chat/service';
import { createLogger } from '../logging';
import { PythonSandboxClient } from '../python/client';
import { JPEG_FIXTURE, pdfFixture, pngFixture, xlsxFixture } from '../testing/attachment-fixtures';
import { pythonMarker } from '../testing/fake-upstreams';
import { startFakeSandbox, type FakeSandbox, type FakeSandboxHandler } from '../testing/fake-sandbox';
import { ORIGIN, createRunsWorld, waitFor, type RunsWorld } from './test-support';
import { RESULT_PROMPT_MAX_CHARS } from './context';
import { attachmentEvidence, mergeEvidence, validateEvidence } from './evidence-provenance';
import { TableService } from '../tables/service';
import { RUN_PYTHON_TOOL, createRunPythonTool } from './run-python';
import { randomUUID } from 'node:crypto';

const MIB = 1024 * 1024;
const toolNames = (request: { body?: Record<string, unknown> } | undefined): string[] =>
  ((request?.body?.tools as { function: { name: string } }[] | undefined) ?? []).map((tool) => tool.function.name);

interface ActivityRow {
  id: string;
  status: string;
  content: string;
  data: { tool: string; label: string; detail: PythonDetail | null };
}
const pythonActivities = (world: RunsWorld, runId: string) =>
  world.pool
    .query<ActivityRow>("SELECT id::text AS id, status, content, data FROM messages WHERE run_id = $1 AND kind = 'activity' AND data->>'tool' = 'run_python' ORDER BY messages.id", [runId])
    .then((result) => result.rows);
const generatedOf = (world: RunsWorld, runId: string) =>
  world.pool
    .query<{ id: string; name: string; format: string; message_id: string; stored_bytes: number; file_bytes: Buffer }>(
      "SELECT id::text AS id, name, format, message_id::text AS message_id, stored_bytes, file_bytes FROM attachments WHERE run_id = $1 AND kind = 'generated' ORDER BY attachments.id",
      [runId],
    )
    .then((result) => result.rows);

/** Handler que segura a resposta até o cliente desistir ou o teste soltar (`release`). */
function holding(): { handler: FakeSandboxHandler; release: () => void } {
  let release = () => undefined as void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    handler: async (_request, signal) => {
      await Promise.race([gate, new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))]);
      return { output: 'liberado' };
    },
    release: () => release(),
  };
}

// ---------------------------------------------------------------------------------------------
// 1. Oferta condicional e indisponibilidade
// ---------------------------------------------------------------------------------------------

/** O texto da falha dentro do envelope único {code, message} (A21) com que o modelo e a atividade a recebem; o prefixo "CÓDIGO: " do run_python faz parte da mensagem. */
const failureText = (content: string): string => (JSON.parse(content) as { message: string }).message;

describe('run_python: oferta condicional e sandbox indisponível', () => {
  it('sem a configuração do sandbox a ferramenta não é oferecida e o pedido é o mesmo de antes', async () => {
    const world = await createRunsWorld();
    try {
      world.engine.start();
      const bot = await world.createBot();
      const run = await world.send(bot, 'Olá');
      await world.waitForStatus(run, 'completed');
      const request = world.conversationRequests().at(-1);
      expect(toolNames(request)).toEqual(['abrir_grupo', 'use_tool', 'read_activity']);
      // A única menção é a orientação de planilha que `read_attachment` já trazia desde a T5; nenhuma outra parte do pedido fala de Python.
      const body = request?.body as { messages: unknown[]; tools: { function: { name: string } }[] };
      expect(JSON.stringify(body.messages)).not.toContain('run_python');
      expect(JSON.stringify(body.tools)).not.toContain('run_python'); // nem o campo tools cita a ferramenta que o registry não tem (o índice da árvore está no sistema)
    } finally {
      await world.cleanup();
    }
  });

  it('com a configuração: run_python existe no bot (grupo ferramentas/python), no Chat geral (índice de discover_tools) e na rotina', async () => {
    const sandbox = await startFakeSandbox();
    const world = await createRunsWorld({ webSearch: true, python: { url: sandbox.url, token: sandbox.token } });
    try {
      world.engine.start();
      const bot = await world.createBot();
      const run = await world.send(bot, 'Olá');
      await world.waitForStatus(run, 'completed');
      // Bot: a lista fixa só tem as portas; run_python mora no grupo ferramentas/python, que o índice da árvore no turno de sistema indexa.
      expect(toolNames(world.conversationRequests().at(-1))).toEqual(['abrir_grupo', 'use_tool', 'read_activity']);
      expect(JSON.stringify(world.conversationRequests().at(-1)?.body)).toContain('ferramentas/python');
      expect(JSON.stringify(world.conversationRequests().at(-1)?.body)).toContain('(run_python)');
      // A35 (phase 15, passo 10): com o sandbox, o modelo fica sabendo de run_python desde o sistema, mesmo antes de a ferramenta ser carregada (a regra de cálculo do dono, 12/10/2026); a frase
      // é livre, o efeito é este: o sistema cita a ferramenta SÓ com o sandbox configurado (sem ele, o teste anterior prova que o pedido inteiro não fala de Python).
      expect((world.conversationRequests().at(-1)?.body as { messages: { content: string }[] }).messages[0]!.content).toContain(RUN_PYTHON_TOOL);

      const chat = new GeneralChatService({ pool: world.pool });
      const session = await chat.create();
      await world.conversations.setPreference({ sessionId: session.id }, 'opencode/glm-5.1', null);
      const chatRun = (await world.conversations.send({ sessionId: session.id }, pythonMarker({ code: 'print(1)' }))).id;
      await world.waitForStatus(chatRun, 'completed');
      expect(toolNames(world.conversationRequests().at(-1))).toEqual(['discover_tools', 'read_activity']);
      expect(JSON.stringify(world.conversationRequests().at(-1)?.body)).toContain('run_python:');
      expect(JSON.stringify(world.conversationRequests().at(-1)?.body)).not.toContain('table_list:');
      expect((world.conversationRequests().at(-1)?.body as { messages: { content: string }[] }).messages[0]!.content).toContain(RUN_PYTHON_TOOL);
      expect((await pythonActivities(world, chatRun)).map((row) => row.status)).toEqual(['completed']);

      const routine = await world.routines.create(
        { name: 'Cálculo', botId: bot.id, instruction: pythonMarker({ code: 'print(2)' }), schedule: { type: 'daily', times: ['07:00'] }, timezone: 'America/Sao_Paulo', startsAt: null, endsAt: null, maxRuns: null },
        ORIGIN,
      );
      const routineRun = (await world.routines.runNow(routine.id, ORIGIN)).id;
      await world.waitForStatus(routineRun, 'completed');
      expect((await pythonActivities(world, routineRun)).map((row) => row.status)).toEqual(['completed']);
      expect(sandbox.requests.map((request) => request.code)).toEqual(['print(1)', 'print(2)']);
    } finally {
      await world.cleanup();
      await sandbox.stop();
    }
  });

  it('sandbox parado: PYTHON_UNAVAILABLE ao modelo e a execução segue até a resposta', async () => {
    const sandbox = await startFakeSandbox();
    await sandbox.stop();
    const world = await createRunsWorld({ python: { url: sandbox.url, token: sandbox.token } });
    try {
      world.engine.start();
      const bot = await world.createBot();
      const run = await world.send(bot, pythonMarker({ code: 'print(1)' }));
      await world.waitForStatus(run, 'completed');
      const [activity] = await pythonActivities(world, run);
      expect(activity!.status).toBe('failed');
      expect(failureText(activity!.content)).toMatch(/^PYTHON_UNAVAILABLE: Python indisponível agora/);
      expect(activity!.data.detail).toMatchObject({ type: 'python', state: 'done', outcome: 'PYTHON_UNAVAILABLE', code: 'print(1)' });
      const answer = (await world.timeline(bot)).filter((entry) => entry.kind === 'text' && entry.role === 'assistant').at(-1);
      expect(answer?.content).toContain('PYTHON_UNAVAILABLE');
    } finally {
      await world.cleanup();
    }
  });

  it('token errado é recusado pelo sandbox e vira PYTHON_UNAVAILABLE; a saúde só é "available" com 200 e o token certo', async () => {
    const sandbox = await startFakeSandbox();
    const world = await createRunsWorld({ python: { url: sandbox.url, token: 'token-errado-0123456789abcdef0123456789' } });
    try {
      world.engine.start();
      const bot = await world.createBot();
      const run = await world.send(bot, pythonMarker({ code: 'print(1)' }));
      await world.waitForStatus(run, 'completed');
      expect(failureText((await pythonActivities(world, run))[0]!.content)).toMatch(/^PYTHON_UNAVAILABLE/);
      expect(sandbox.unauthorized).toBe(1);
      expect(sandbox.requests).toHaveLength(0);

      expect(await new PythonSandboxClient({ url: sandbox.url, token: sandbox.token }).health()).toBe('available');
      expect(await new PythonSandboxClient({ url: sandbox.url, token: 'token-errado-0123456789abcdef0123456789' }).health()).toBe('unavailable');
      sandbox.healthStatus = 503;
      expect(await new PythonSandboxClient({ url: sandbox.url, token: sandbox.token }).health()).toBe('unavailable');
      await sandbox.stop();
      expect(await new PythonSandboxClient({ url: sandbox.url, token: sandbox.token }).health()).toBe('unavailable');
    } finally {
      await world.cleanup();
      await sandbox.stop();
    }
  });

  it('resposta malformada do sandbox é recusada como PYTHON_UNAVAILABLE (o que volta não é confiável)', async () => {
    const sandbox = await startFakeSandbox();
    const world = await createRunsWorld({ python: { url: sandbox.url, token: sandbox.token } });
    try {
      world.engine.start();
      const bot = await world.createBot();
      sandbox.handler = () => ({ raw: Buffer.from([0, 0, 0, 2, 0x7b, 0x7d]) });
      const run = await world.send(bot, pythonMarker({ code: 'print(1)' }));
      await world.waitForStatus(run, 'completed');
      expect(failureText((await pythonActivities(world, run))[0]!.content)).toMatch(/^PYTHON_UNAVAILABLE/);
    } finally {
      await world.cleanup();
      await sandbox.stop();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 2 e 3. Entradas e saídas
// ---------------------------------------------------------------------------------------------

describe('run_python: entradas em /data/ e saídas gravadas como anexos', () => {
  let sandbox: FakeSandbox;
  let world: RunsWorld;
  let files: AttachmentService;

  beforeAll(async () => {
    sandbox = await startFakeSandbox();
    world = await createRunsWorld({ python: { url: sandbox.url, token: sandbox.token } });
    files = new AttachmentService({ pool: world.pool, conversations: world.conversations });
    // O JPEG de entrada exige visão confirmada no modelo do bot (regra dos anexos), como nos testes de anexos.
    await world.models.test('opencode/glm-5.1');
    await world.pool.query("UPDATE model_profiles SET accepts_images = true WHERE model_id = 'opencode/glm-5.1'");
    world.engine.start();
  });
  afterAll(async () => {
    await world.cleanup();
    await sandbox.stop();
  });
  afterEach(() => {
    sandbox.handler = ({ files: inputs }) => ({ output: inputs.map((file) => `${file.name}:${file.data.length}`).join('\n') });
  });

  /** Anexos enviados numa mensagem do bot (ligados a ela), prontos para o `run_python` indicar. */
  async function sentFiles(bot: Bot, uploads: [string, Buffer][]): Promise<string[]> {
    const ids: string[] = [];
    for (const [name, bytes] of uploads) ids.push((await files.upload(bot.id, name, bytes)).id);
    const before=world.conversationRequests().length;
    const run = (await world.conversations.send(bot.id, 'Guarde estes arquivos', ids)).id;
    if(uploads.some(([name])=>name.endsWith('.jpg'))){
      // Entrada JPEG preservada para o sandbox; esta execução de visão não pode inferir sem estimativa fundamentada.
      await world.waitForStatus(run,'failed');expect((await world.runRow(run)).failure_code).toBe('CONTEXT_ESTIMATE_UNAVAILABLE');
      expect(world.conversationRequests()).toHaveLength(before);
      const stored=(await world.pool.query<{image_bytes:Buffer;removed_at:Date|null}>('SELECT image_bytes,removed_at FROM attachments WHERE id=ANY($1::bigint[]) AND kind=\'image\'',[ids])).rows;
      expect(stored).toEqual([{image_bytes:JPEG_FIXTURE,removed_at:null}]);
      expect((await world.pool.query('SELECT 1 FROM attachments WHERE id=ANY($1::bigint[]) AND removed_at IS NULL',[ids])).rowCount).toBe(ids.length);
    }else await world.waitForStatus(run, 'completed');
    return ids;
  }

  it('protege a closure durante Python e invalida saídas sucessivas após exclusão da entrada, preservando os arquivos gerados', async () => {
    const bot = await world.createBot();
    const [source] = await sentFiles(bot, [['origem.txt', Buffer.from('dado sintético')]]);
    const gate = holding();
    sandbox.handler = gate.handler;
    const running = await world.send(bot, pythonMarker({ code: 'analisar', attachments: [source!] }));
    await waitFor('Python carregou a entrada', async () => sandbox.active === 1);
    await expect(files.remove(source!, ORIGIN)).rejects.toMatchObject({ code: 'ATTACHMENT_IN_USE' });
    gate.release();
    await world.waitForStatus(running, 'completed');
    sandbox.handler = () => ({ output: 'arquivo', files: [{ name: 'derivado.txt', data: Buffer.from('derivado sintético') }] });
    const firstRun = await world.send(bot, pythonMarker({ code: 'gerar', attachments: [source!] }));
    await world.waitForStatus(firstRun, 'completed');
    const first = (await generatedOf(world, firstRun))[0]!;
    const secondRun = await world.send(bot, pythonMarker({ code: 'regerar', attachments: [first.id] }));
    await world.waitForStatus(secondRun, 'completed');
    const second = (await generatedOf(world, secondRun))[0]!;
    const conversationId = await world.conversations.conversationIdOf(bot.id);
    const evidence = await attachmentEvidence(world.pool, conversationId, bot.id, [second.id]);
    expect(evidence?.attachments).toEqual(expect.arrayContaining([source!, first.id, second.id]));
    await files.remove(source!, ORIGIN);
    expect(await validateEvidence(world.pool, conversationId, bot.id, evidence!)).toBe(false);
    expect((await files.content(bot.id, second.id)).bytes).toEqual(Buffer.from('derivado sintético'));
    const before = sandbox.requests.length;
    const rejected = await world.send(bot, pythonMarker({ code: 'reler revogado', attachments: [second.id] }));
    await world.waitForStatus(rejected, 'completed');
    expect(sandbox.requests.length).toBe(before);
    expect((await pythonActivities(world, rejected))[0]?.content).toContain('PYTHON_INPUT_INVALID');
  });

  it('herda evidência de células presentes no contexto mesmo sem carregar arquivos no sandbox', async () => {
    const bot = await world.createBot();
    const tables = new TableService({ pool: world.pool });
    const table = await tables.create(tableCreateSchema.parse({ name: 'Tabela sintética', operationId: randomUUID() }), { kind: 'owner' }, bot.id);
    let evidence = mergeEvidence();
    await new TableService({ pool: world.pool, onEvidence: (source) => { evidence = mergeEvidence(evidence, source); } }).get(table.id, { kind: 'bot', botId: bot.id });
    const runId = await world.send(bot, 'Preparar prova sintética');
    await world.waitForStatus(runId, 'completed');
    const conversationId = await world.conversations.conversationIdOf(bot.id);
    const activityId = (await world.pool.query<{ id: string }>("INSERT INTO messages(conversation_id,run_id,role,kind,status,step,created_at) VALUES($1,$2,'assistant','activity','completed',99,now()) RETURNING id::text", [conversationId, runId])).rows[0]!.id;
    sandbox.handler = () => ({ output: 'calculado', files: [{ name: 'celulas.txt', data: Buffer.from('resultado sintético') }] });
    const handler = createRunPythonTool({ client: new PythonSandboxClient({ url: sandbox.url, token: sandbox.token }), logger: createLogger({ level: 'silent', name: 'python-provenance-test' }), maxTotalBytes: 1024 * MIB });
    const outcome = await handler.prepare(JSON.stringify({ code: 'print(42)' })).execute({ pool: world.pool, conversationId, botId: bot.id, runId, now: () => new Date(), signal: new AbortController().signal, evidence, activity: { id: activityId, report: async () => undefined } });
    expect(outcome.evidence).toEqual(evidence);
    const output = (await generatedOf(world, runId))[0]!;
    const closure = await attachmentEvidence(world.pool, conversationId, bot.id, [output.id]);
    expect(closure?.tables).toEqual(evidence.tables);
    await tables.share(table.id, { operationId: randomUUID(), expectedVersion: table.version, botIds: [] }, { kind: 'owner' });
    expect(await validateEvidence(world.pool, conversationId, bot.id, closure!)).toBe(false);
    expect((await files.content(bot.id, output.id)).bytes).toEqual(Buffer.from('resultado sintético'));
  });

  it('cada tipo chega a /data/ como a spec manda, com nomes únicos, e PNG e CSV gerados viram anexos ligados à atividade e à execução', async () => {
    const bot = await world.createBot();
    const xlsx = xlsxFixture();
    const ids = await sentFiles(bot, [
      ['dados.csv', Buffer.from('a,b\n1,2\n')],
      ['vendas.xlsx', xlsx],
      ['foto.jpg', JPEG_FIXTURE],
      ['relatorio.pdf', pdfFixture('Texto do PDF')],
      ['dados.csv', Buffer.from('c\n3\n')],
    ]);
    const png = pngFixture(2, 2);
    sandbox.handler = () => ({ output: 'feito', files: [{ name: 'grafico.png', data: png }, { name: 'resumo.csv', data: Buffer.from('total\n3\n') }] });
    const run = await world.send(bot, pythonMarker({ code: 'import pandas', attachments: ids }));
    await world.waitForStatus(run, 'completed');

    const request = sandbox.requests.at(-1)!;
    expect(request.files.map((file) => file.name)).toEqual(['dados.csv', 'vendas.xlsx', 'foto.jpg', 'relatorio.txt', 'dados_2.csv']);
    // Documento entra como o texto guardado na extração (a regra atual dos anexos apara o fim).
    expect(request.files[0]!.data.toString('utf8')).toBe('a,b\n1,2');
    expect(request.files[1]!.data.equals(xlsx)).toBe(true);
    expect(request.files[2]!.data.equals(JPEG_FIXTURE)).toBe(true);
    expect(request.files[3]!.data.toString('utf8')).toContain('Texto do PDF');

    const [activity] = await pythonActivities(world, run);
    expect(activity!.status).toBe('completed');
    expect(activity!.data.label).toBe('Python executado (0 s)');
    expect(activity!.data.detail).toEqual({ type: 'python', state: 'done', code: 'import pandas', outcome: 'ok', output: 'feito', outputTruncated: false, error: null, durationMs: 12, rejected: [] });
    const generated = await generatedOf(world, run);
    expect(generated.map(({ name, format, message_id: messageId, stored_bytes: bytes }) => ({ name, format, messageId, bytes }))).toEqual([
      { name: 'grafico.png', format: 'png', messageId: activity!.id, bytes: png.length },
      { name: 'resumo.csv', format: 'csv', messageId: activity!.id, bytes: 8 },
    ]);
    expect(generated[0]!.file_bytes.equals(png)).toBe(true);
    // O modelo recebe a lista com ids (não a imagem) e a saída num bloco não confiável.
    expect(activity!.content).toContain(`id=${generated[0]!.id}; nome="grafico.png"; tipo=png; tamanho=${png.length} bytes`);
    expect(activity!.content).toMatch(/<conteudo_python_nao_confiavel_[0-9a-f]+>\nfeito\n/);
    // A tela lê os arquivos na própria atividade, com o formato, pelo contrato compartilhado.
    const snapshot = conversationSnapshotSchema.parse(await world.conversations.snapshot(bot.id));
    const item = snapshot.items.find((entry) => entry.id === activity!.id);
    expect(item?.attachments).toEqual([
      { id: generated[0]!.id, name: 'grafico.png', kind: 'generated', sizeBytes: png.length, removed: false, format: 'png' },
      { id: generated[1]!.id, name: 'resumo.csv', kind: 'generated', sizeBytes: 8, removed: false, format: 'csv' },
    ]);
    // O conteúdo privado devolve os bytes; um arquivo gerado pode voltar a /data/ numa chamada seguinte.
    expect((await files.content(bot.id, generated[0]!.id)).bytes.equals(png)).toBe(true);
    const again = await world.send(bot, pythonMarker({ code: 'reler', attachments: [generated[1]!.id] }));
    await world.waitForStatus(again, 'completed');
    expect(sandbox.requests.at(-1)!.files.map((file) => [file.name, file.data.toString('utf8')])).toEqual([['resumo.csv', 'total\n3\n']]);
  });

  it('anexo de outra conversa, inexistente ou removido é recusado sem chamar o sandbox; acima de 50 MB somados também', async () => {
    const bot = await world.createBot();
    const other = await world.createBot();
    const [foreign] = await sentFiles(other, [['alheio.txt', Buffer.from('segredo de outra conversa')]]);
    const [mine, removed] = await sentFiles(bot, [['meu.txt', Buffer.from('meu')], ['apagado.txt', Buffer.from('apagado')]]);
    await files.remove(removed!, ORIGIN);
    const before = sandbox.requests.length;
    for (const attachments of [[mine!, foreign!], ['999999'], [removed!]]) {
      const run = await world.send(bot, pythonMarker({ code: 'print(1)', attachments }));
      await world.waitForStatus(run, 'completed');
      const [activity] = await pythonActivities(world, run);
      expect(activity!.status).toBe('failed');
      expect(failureText(activity!.content)).toMatch(/^PYTHON_INPUT_INVALID: anexo inexistente nesta conversa ou removido/);
      expect(activity!.content).not.toContain('segredo');
      expect(activity!.data.detail).toMatchObject({ outcome: 'PYTHON_INPUT_INVALID' });
    }
    // 50 MB somados: um arquivo gerado grande (gravado direto, o upload tem teto de 15 MB) ligado a uma mensagem desta conversa.
    const message = await world.pool.query<{ id: string; conversation_id: string }>(
      "SELECT m.id::text AS id, m.conversation_id::text AS conversation_id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.bot_id = $1 AND m.role = 'user' LIMIT 1",
      [bot.id],
    );
    const big = await world.pool.query<{ id: string }>(
      "INSERT INTO attachments (conversation_id, message_id, kind, format, name, original_bytes, stored_bytes, file_bytes) VALUES ($1, $2, 'generated', 'txt', 'grande.txt', $3, $3, $4) RETURNING id::text AS id",
      [message.rows[0]!.conversation_id, message.rows[0]!.id, 50 * MIB, Buffer.alloc(50 * MIB, 0x61)],
    );
    const run = await world.send(bot, pythonMarker({ code: 'print(1)', attachments: [big.rows[0]!.id, mine!] }));
    await world.waitForStatus(run, 'completed');
    expect(failureText((await pythonActivities(world, run))[0]!.content)).toMatch(/^PYTHON_INPUT_INVALID: os anexos indicados passam de 50 MB/);
    expect(sandbox.requests.length).toBe(before);
  });

  it('argumentos estritos: código acima de 20.000, mais de 5 anexos, repetidos ou campo extra são recusados sem chamar o sandbox', async () => {
    const bot = await world.createBot();
    const before = sandbox.requests.length;
    const cases = [
      { code: 'x'.repeat(20_001) },
      { code: 'print(1)', attachments: ['1', '2', '3', '4', '5', '6'] },
      { code: 'print(1)', attachments: ['7', '07'] },
      { code: 'print(1)', network: true },
      { code: '' },
    ];
    const original=world.provider.streamChat.bind(world.provider);let args:unknown={},emit=true;
    const mock=vi.spyOn(world.provider,'streamChat').mockImplementation(async function*(key,protocol,request,signal){
      if(emit){emit=false;yield{type:'tool_call',id:randomUUID(),name:'run_python',arguments:JSON.stringify(args)};yield{type:'done',reason:'stop'};}else yield*original(key,protocol,request,signal);
    });
    try{for (const current of cases) {
      // O limite pertence aos argumentos da ferramenta, não a um ownerturn base64 artificialmente maior que a janela.
      args=current;emit=true;const run = await world.send(bot,'Verifique estes argumentos de ferramenta.');
      await world.waitForStatus(run, 'completed');
      expect(failureText((await pythonActivities(world, run))[0]!.content)).toMatch(/^Argumentos inválidos/);
    }}finally{mock.mockRestore();}
    expect(sandbox.requests.length).toBe(before);
  });

  it('saídas fora de formato ou limite são recusadas com aviso; as válidas são gravadas', async () => {
    const bot = await world.createBot();
    const small = (name: string) => ({ name, data: Buffer.from(`conteúdo de ${name}\n`) });
    sandbox.handler = () => ({
      files: [
        { name: 'falso.png', data: Buffer.from('não sou png') },
        { name: 'programa.exe', data: Buffer.from('MZ') },
        { name: 'quebrado.json', data: Buffer.from('{"a":') },
        { name: 'binario.txt', data: Buffer.from([0x61, 0x00, 0x62]) },
        small('a.txt'),
        small('b.md'),
        { name: 'c.json', data: Buffer.from('{"ok":true}') },
        { name: 'grande.png', data: pngFixture(1, 1, 5 * MIB) },
        small('d.csv'),
        { name: 'e.xlsx', data: xlsxFixture() },
        small('f.txt'),
        { name: 'omitido.csv', data: Buffer.from('x'), omitted: true },
      ],
      filesOmitted: 3,
    });
    const run = await world.send(bot, pythonMarker({ code: 'gerar()' }));
    await world.waitForStatus(run, 'completed');
    const [activity] = await pythonActivities(world, run);
    expect(activity!.status).toBe('completed');
    expect((await generatedOf(world, run)).map((file) => [file.name, file.format])).toEqual([['a.txt', 'txt'], ['b.md', 'md'], ['c.json', 'json'], ['d.csv', 'csv'], ['e.xlsx', 'xlsx']]);
    expect(activity!.data.detail!.rejected).toEqual([
      { name: 'falso.png', reason: 'format' },
      { name: 'programa.exe', reason: 'format' },
      { name: 'quebrado.json', reason: 'format' },
      { name: 'binario.txt', reason: 'format' },
      { name: 'grande.png', reason: 'limit' },
      { name: 'f.txt', reason: 'limit' },
      { name: 'omitido.csv', reason: 'limit' },
    ]);
    expect(activity!.content).toContain('PYTHON_OUTPUT_REJECTED');
    expect(activity!.content).toContain('mais 3 arquivo(s) em /out/ além dos 20 listados');
  });

  it('10 MB somados: o arquivo que passaria do total é recusado; os anteriores ficam', async () => {
    const bot = await world.createBot();
    sandbox.handler = () => ({ files: ['um', 'dois', 'tres'].map((name) => ({ name: `${name}.png`, data: pngFixture(1, 1, 4 * MIB) })) });
    const run = await world.send(bot, pythonMarker({ code: 'gerar()' }));
    await world.waitForStatus(run, 'completed');
    expect((await generatedOf(world, run)).map((file) => file.name)).toEqual(['um.png', 'dois.png']);
    expect((await pythonActivities(world, run))[0]!.data.detail!.rejected).toEqual([{ name: 'tres.png', reason: 'limit' }]);
  });

  it('erro do Python volta como traceback ao modelo, a atividade falha com o detalhe e a saída longa é cortada com aviso', async () => {
    const bot = await world.createBot();
    sandbox.handler = () => ({ outcome: 'PYTHON_ERROR', output: 'y'.repeat(19_990), error: 'Traceback (most recent call last):\nValueError: ruim', files: [] });
    const run = await world.send(bot, pythonMarker({ code: 'raise ValueError("ruim")' }));
    await world.waitForStatus(run, 'completed');
    const [activity] = await pythonActivities(world, run);
    expect(activity!.status).toBe('failed');
    expect(failureText(activity!.content)).toMatch(/^Desfecho: PYTHON_ERROR\./);
    expect(activity!.content).toContain('[saída cortada: passou de 20000 caracteres]');
    expect(activity!.data.detail).toMatchObject({ state: 'done', outcome: 'PYTHON_ERROR', error: 'Traceback (most recent call last):\nValueError: ruim' });
    for (const outcome of ['PYTHON_TIMEOUT', 'PYTHON_MEMORY_LIMIT'] as const) {
      sandbox.handler = () => ({ outcome, error: 'limite', files: [] });
      const next = await world.send(bot, pythonMarker({ code: 'while True: pass' }));
      await world.waitForStatus(next, 'completed');
      expect((await pythonActivities(world, next))[0]!.data.detail).toMatchObject({ outcome });
    }
  });

  it('saída acima do teto de 12.000 caracteres: no pedido só o corpo da saída é cortado e o fim obrigatório (fechamento do bloco, aviso de corte e arquivos gerados) segue completo; igual na rodada seguinte (A2, A3)', async () => {
    const bot = await world.createBot();
    // O sandbox real entrega até 20.000 caracteres de saída e avisa que cortou (`outputTruncated`); 1.700 linhas ficam abaixo disso e bem acima do teto de 12.000 do pedido.
    sandbox.handler = () => ({ output: Array.from({ length: 1700 }, (_, index) => `linha ${index}`).join('\n'), outputTruncated: true, files: [{ name: 'a.csv', data: Buffer.from('a,b\n1,2\n') }, { name: 'b.txt', data: Buffer.from('ok\n') }] });
    const toolContent = (request: { body?: Record<string, unknown> } | undefined): string[] =>
      ((request?.body?.messages as { role: string; content: string }[] | undefined) ?? []).filter((message) => message.role === 'tool').map((message) => message.content);
    const before = world.conversationRequests().length;
    const run = await world.send(bot, pythonMarker({ code: 'imprimir()' }));
    await world.waitForStatus(run, 'completed');
    const [activity] = await pythonActivities(world, run);
    expect(activity!.status).toBe('completed');
    // Gravado íntegro (até os 20.000 caracteres de saída da própria ferramenta, mais o fim obrigatório): acima do teto do pedido.
    expect(activity!.content.length).toBeGreaterThan(RESULT_PROMPT_MAX_CHARS);
    const tail = activity!.content.slice(activity!.content.lastIndexOf('\n</conteudo_python_nao_confiavel_'));
    expect(tail).toContain('[saída cortada: passou de 20000 caracteres]');
    expect(tail).toContain('Arquivos gerados (anexos da conversa):');

    const requests = world.conversationRequests().slice(before);
    expect(requests).toHaveLength(2);
    const [sent] = toolContent(requests[1]);
    expect(sent!.length).toBeLessThanOrEqual(RESULT_PROMPT_MAX_CHARS);
    expect(sent!.length).toBeGreaterThan(RESULT_PROMPT_MAX_CHARS - 20);
    // O marcador fecha o resultado e cita a linha; logo antes dele vem o fim obrigatório INTEIRO, igual ao gravado.
    const marker = /\n\[mostrando ([\d.]+) de ([\d.]+) caracteres; continue em read_activity messageId=(\d+) offset=\d+\]$/.exec(sent!)!;
    expect(marker).not.toBeNull();
    expect(marker[3]).toBe(activity!.id);
    expect(sent!.slice(0, marker.index).endsWith(tail)).toBe(true);
    expect(sent!.startsWith(activity!.content.slice(0, 200))).toBe(true);
    expect(sent!.match(/<\/conteudo_python_nao_confiavel_[a-f0-9]+>/g)).toHaveLength(1);
    // Rodada seguinte: a mesma forma, byte a byte.
    await world.waitForStatus(await world.send(bot, 'Obrigado.'), 'completed');
    expect(toolContent(world.conversationRequests().at(-1))).toEqual([sent]);
  });
});

describe('run_python: espaço global esgotado', () => {
  it('sem espaço, ATTACHMENT_QUOTA_EXCEEDED ao modelo e nenhum arquivo é gravado', async () => {
    const sandbox = await startFakeSandbox();
    const world = await createRunsWorld({ python: { url: sandbox.url, token: sandbox.token, maxTotalBytes: 100 } });
    try {
      world.engine.start();
      const bot = await world.createBot();
      sandbox.handler = () => ({ output: 'ok', files: [{ name: 'a.csv', data: Buffer.from('a\n1\n') }, { name: 'g.png', data: pngFixture(4, 4) }] });
      const run = await world.send(bot, pythonMarker({ code: 'gerar()' }));
      await world.waitForStatus(run, 'completed');
      const [activity] = await pythonActivities(world, run);
      expect(activity!.status).toBe('failed');
      expect(activity!.content).toContain('ATTACHMENT_QUOTA_EXCEEDED: o espaço para arquivos do Aion acabou; nenhum arquivo foi gravado.');
      expect(activity!.data.detail).toMatchObject({ outcome: 'ATTACHMENT_QUOTA_EXCEEDED', output: 'ok' });
      expect(await generatedOf(world, run)).toEqual([]);
    } finally {
      await world.cleanup();
      await sandbox.stop();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Vagas e "Parar"
// ---------------------------------------------------------------------------------------------

describe('run_python: duas vagas, espera e "Parar"', () => {
  let sandbox: FakeSandbox;
  let world: RunsWorld;
  beforeAll(async () => {
    sandbox = await startFakeSandbox();
    world = await createRunsWorld({ python: { url: sandbox.url, token: sandbox.token } });
    world.engine.start();
  });
  afterAll(async () => {
    await world.cleanup();
    await sandbox.stop();
  });

  const detailOf = async (runId: string): Promise<PythonDetail | null> => (await pythonActivities(world, runId))[0]?.data.detail ?? null;

  it('a terceira chamada simultânea espera vaga ("aguardando") e executa quando uma vaga sai', async () => {
    const gate = holding();
    sandbox.handler = gate.handler;
    const bots = [await world.createBot(), await world.createBot(), await world.createBot()];
    const runs: string[] = [];
    for (const bot of bots) runs.push(await world.send(bot, pythonMarker({ code: `print("${bot.name}")` })));
    await waitFor('duas no sandbox', async () => sandbox.active === 2);
    const waiting = await waitFor('uma aguardando vaga', async () => {
      const states = await Promise.all(runs.map(async (run) => (await detailOf(run))?.state));
      return states.filter((state) => state === 'waiting').length === 1 ? states : null;
    });
    expect(waiting.filter((state) => state === 'running')).toHaveLength(2);
    expect(sandbox.requests.length).toBe(2);
    gate.release();
    for (const run of runs) await world.waitForStatus(run, 'completed');
    expect(sandbox.maxActive).toBe(2);
    expect(sandbox.requests.length).toBe(3);
    for (const run of runs) expect((await detailOf(run))?.outcome).toBe('ok');
  });

  it('"Parar" durante a execução cancela o pedido (o sandbox vê a conexão fechada) e a execução termina interrompida', async () => {
    const gate = holding();
    sandbox.handler = gate.handler;
    const cancelled = sandbox.cancelled;
    const bot = await world.createBot();
    const run = await world.send(bot, pythonMarker({ code: 'while True: pass' }));
    await waitFor('no sandbox', async () => sandbox.active === 1);
    await world.conversations.stop(bot.id);
    await world.waitForStatus(run, 'interrupted');
    await waitFor('pedido cancelado', async () => sandbox.cancelled === cancelled + 1);
    const [activity] = await pythonActivities(world, run);
    expect(activity!.status).toBe('failed');
    expect(failureText(activity!.content)).toBe('Execução de Python interrompida.');
    expect(activity!.data.detail).toMatchObject({ state: 'done', outcome: null, code: 'while True: pass' });
    gate.release();
  });

  it('"Parar" esperando vaga tira a chamada da fila sem nunca chegar ao sandbox', async () => {
    const gate = holding();
    sandbox.handler = gate.handler;
    const holders = [await world.createBot(), await world.createBot()];
    const holderRuns: string[] = [];
    for (const bot of holders) holderRuns.push(await world.send(bot, pythonMarker({ code: 'segura()' })));
    await waitFor('duas vagas ocupadas', async () => sandbox.active === 2);
    const requests = sandbox.requests.length;
    const bot = await world.createBot();
    const run = await world.send(bot, pythonMarker({ code: 'na_fila()' }));
    await waitFor('aguardando vaga', async () => (await detailOf(run))?.state === 'waiting');
    await world.conversations.stop(bot.id);
    await world.waitForStatus(run, 'interrupted');
    expect(failureText((await pythonActivities(world, run))[0]!.content)).toBe('Execução de Python interrompida.');
    gate.release();
    for (const holder of holderRuns) await world.waitForStatus(holder, 'completed');
    expect(sandbox.requests.length).toBe(requests);
    expect(sandbox.requests.some((request) => request.code === 'na_fila()')).toBe(false);
  });

  it('a espera pela vaga conta no tempo da execução: o prazo encerra a chamada que esperava', async () => {
    const gate = holding();
    sandbox.handler = gate.handler;
    const shortWorld = await createRunsWorld({ python: { url: sandbox.url, token: sandbox.token }, engine: { maxActiveMs: 1_500 } });
    const holderSignal = new AbortController();
    const holders: Promise<unknown>[] = [];
    try {
      // Ocupantes sem prazo de execução: as vagas só saem após o teste, evitando que um prazo anterior solte a terceira chamada.
      for (let index = 0; index < 2; index += 1) {
        holders.push(shortWorld.pythonClient!.run({ code: `segura_${index}()`, files: [] }, holderSignal.signal));
      }
      await waitFor('duas vagas ocupadas sem prazo concorrente', async () => sandbox.active === 2);
      const requests = sandbox.requests.length;
      shortWorld.engine.start();
      const bot = await shortWorld.createBot();
      const run = await shortWorld.send(bot, pythonMarker({ code: 'espera_prazo()' }));
      await waitFor('execução esperando vaga antes do prazo', async () => (await pythonActivities(shortWorld, run))[0]?.data.detail?.state === 'waiting');
      await shortWorld.waitForStatus(run, 'limit_reached');
      expect((await shortWorld.runRow(run)).active_ms).toBeGreaterThanOrEqual(1_500);
      expect((await pythonActivities(shortWorld, run))[0]!.data.detail).toMatchObject({ state: 'done', outcome: null });
      expect(sandbox.requests).toHaveLength(requests);
      expect(sandbox.requests.some((request) => request.code === 'espera_prazo()')).toBe(false);
      expect(sandbox.active).toBe(2);
    } finally {
      gate.release();
      await Promise.allSettled(holders);
      await shortWorld.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Logs
// ---------------------------------------------------------------------------------------------

describe('run_python: log da chamada', () => {
  it('leva só ids, duração, desfecho, contagens e tamanhos: nunca código, saída, erro ou nomes de arquivo', async () => {
    const sandbox = await startFakeSandbox();
    const lines: string[] = [];
    const logger = createLogger({ level: 'info', name: 'python-log-test', destination: { write: (line: string) => void lines.push(line) } });
    const world = await createRunsWorld({ python: { url: sandbox.url, token: sandbox.token }, logger });
    try {
      world.engine.start();
      const bot = await world.createBot();
      const files = new AttachmentService({ pool: world.pool, conversations: world.conversations });
      const input = (await files.upload(bot.id, 'entrada-secreta.csv', Buffer.from('coluna\nVALOR_DE_ENTRADA\n'))).id;
      const sent = (await world.conversations.send(bot.id, 'arquivo', [input])).id;
      await world.waitForStatus(sent, 'completed');
      sandbox.handler = () => ({ output: 'SAIDA_SECRETA', error: 'ERRO_SECRETO', files: [{ name: 'arquivo-secreto.csv', data: Buffer.from('CONTEUDO_SECRETO\n') }] });
      const run = await world.send(bot, pythonMarker({ code: 'CODIGO_SECRETO = 1', attachments: [input] }));
      await world.waitForStatus(run, 'completed');
      const call = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((entry) => entry.msg === 'run_python concluída');
      expect(call).toMatchObject({ runId: run, outcome: 'ok', inputFiles: 1, inputBytes: 23, outputFiles: 1, outputBytes: 17, rejectedFiles: 0, durationMs: 12 });
      const all = lines.join('\n');
      for (const secret of ['CODIGO_SECRETO', 'SAIDA_SECRETA', 'ERRO_SECRETO', 'arquivo-secreto', 'entrada-secreta', 'CONTEUDO_SECRETO', 'VALOR_DE_ENTRADA', sandbox.token]) {
        expect(all).not.toContain(secret);
      }
      const events = await world.pool.query<{ row: string }>('SELECT row_to_json(e)::text AS row FROM conversation_events e');
      expect(events.rows.map((event) => event.row).join('\n')).not.toMatch(/SECRET|secreto/);
    } finally {
      await world.cleanup();
      await sandbox.stop();
    }
  });
});

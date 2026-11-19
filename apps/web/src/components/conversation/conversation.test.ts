// Prova da lógica pura da conversa no cliente: aplicar eventos do SSE (upsert idempotente, ordem por id, descartados, execuções
// abertas) e agrupar a linha do tempo em blocos (marcador só no começo da sequência do bot, ações seguidas num grupo).
import type { ActivityView, CardView, ConversationSnapshot, MessageView, RunView, TextMessageView } from '@aion/shared';
import { describe, expect, it } from 'vitest';
import { activeRunOf, applyComplement, applyDraft, applyMessage, applyRun, compareIds, dropComplement, fromSnapshot, isBusy, prependPage, queuedRunsOf } from './conversation-state';
import { bareAnswerAnchorsOf, buildBlocks, describeWork, elapsedLabel, generatedFilesOf, isWaitingApproval, isWorking, lastVisibleItem, visibleItems, workingDocId, workingPhrase, workLinesOf } from './timeline';

const AT = '2026-03-01T12:00:00.000Z';
const text = (id: string, role: 'user' | 'assistant', content: string, status: TextMessageView['status'] = 'done'): TextMessageView => ({
  id, runId: '1', createdAt: AT, kind: 'text', role, status, content,
});
const activity = (id: string, status: ActivityView['status'] = 'completed'): ActivityView => ({
  id, runId: '1', createdAt: AT, kind: 'activity', status, step: 1, tool: 'search_history', label: `Pesquisou ${id}`, arguments: '{}', result: status === 'running' ? null : 'ok', detail: null, awaitingApproval: false,
});
const card = (id: string): CardView => ({
  id, runId: '1', createdAt: AT, kind: 'card', status: 'done', content: 'Execução interrompida pelo dono.', card: { type: 'run_interrupted', steps: [], maybeCompleted: [] },
});
const run = (id: string, status: RunView['status']): RunView => ({ id, status, input: status === 'queued' ? 'texto' : null, routineName: null, toolCalls: 0, failureCode: null, createdAt: AT, startedAt: null, finishedAt: null });

const snapshot = (items: MessageView[], runs: RunView[] = []): ConversationSnapshot => ({
  items, hasMore: false, runs, lastEventId: '0', model: { model: 'opencode/glm-5.1', effort: null }, providerConfigured: true,
});

describe('estado da conversa', () => {
  it('compara ids inteiros em texto pelo valor, não pela ordem alfabética', () => {
    expect(['10', '9', '100', '2'].sort(compareIds)).toEqual(['2', '9', '10', '100']);
  });

  it('aplicar a mesma mensagem duas vezes dá o mesmo estado; o texto em streaming é substituído pelo estado atual da linha', () => {
    let state = fromSnapshot(snapshot([text('1', 'user', 'oi')]));
    state = applyMessage(state, text('2', 'assistant', 'Ol', 'streaming'));
    state = applyMessage(state, text('2', 'assistant', 'Olá, tudo', 'streaming'));
    const once = applyMessage(state, text('2', 'assistant', 'Olá, tudo bem?', 'done'));
    expect(applyMessage(once, text('2', 'assistant', 'Olá, tudo bem?', 'done'))).toEqual(once);
    expect(once.items.map((item) => [item.id, item.kind === 'text' && item.content, item.status])).toEqual([
      ['1', 'oi', 'done'],
      ['2', 'Olá, tudo bem?', 'done'],
    ]);
  });

  it('mantém a ordem por id mesmo quando um evento chega fora de ordem e descarta o que o worker abandonou', () => {
    let state = fromSnapshot(snapshot([text('10', 'user', 'a'), text('12', 'assistant', 'c')]));
    state = applyMessage(state, text('11', 'assistant', 'b'));
    state = applyMessage(state, text('9', 'user', 'antes'));
    expect(state.items.map((item) => item.id)).toEqual(['9', '10', '11', '12']);
    state = applyMessage(state, text('11', 'assistant', 'b', 'discarded'));
    expect(state.items.map((item) => item.id)).toEqual(['9', '10', '12']);
    expect(applyMessage(state, text('99', 'assistant', 'nunca vista', 'discarded'))).toBe(state); // descartar o que não existe não muda nada
  });

  it('só as execuções abertas ficam na lista: a que termina sai, a nova entra, e a fila mantém a ordem', () => {
    let state = fromSnapshot(snapshot([], [run('5', 'running'), run('6', 'queued')]));
    expect(activeRunOf(state)?.id).toBe('5');
    expect(queuedRunsOf(state).map((queued) => queued.id)).toEqual(['6']);
    state = applyRun(state, run('7', 'queued'));
    expect(state.runs.map((item) => item.id)).toEqual(['5', '6', '7']);
    state = applyRun(state, run('5', 'completed'));
    expect(state.runs.map((item) => item.id)).toEqual(['6', '7']);
    expect(activeRunOf(state)).toBeNull();
    state = applyRun(state, run('6', 'running'));
    expect(activeRunOf(state)?.id).toBe('6');
    expect(applyRun(state, run('1', 'failed'))).toBe(state); // terminal desconhecida: nada a remover
  });

  it('junta a página mais antiga no começo, sem repetir o que já estava na lista', () => {
    const state = fromSnapshot({ ...snapshot([text('3', 'user', 'c'), text('4', 'assistant', 'd')]), hasMore: true });
    const next = prependPage(state, { items: [text('1', 'user', 'a'), text('2', 'assistant', 'b'), text('3', 'user', 'c')], hasMore: false });
    expect(next.items.map((item) => item.id)).toEqual(['1', '2', '3', '4']);
    expect(next.hasMore).toBe(false);
  });
});

describe('blocos da linha do tempo', () => {
  it('o marcador do bot vai só no primeiro bloco de cada sequência e ações seguidas formam um grupo', () => {
    const blocks = buildBlocks([
      text('1', 'user', 'faça'),
      activity('2'),
      activity('3'),
      activity('4', 'running'),
      text('5', 'assistant', 'pronto'),
      text('6', 'assistant', 'mais uma'),
      card('7'),
      text('8', 'assistant', 'depois do cartão'),
    ]);
    expect(blocks.map((block) => block.type)).toEqual(['user', 'activities', 'assistant', 'assistant', 'card', 'assistant']);
    const activities = blocks[1];
    expect(activities?.type === 'activities' && activities.activities.map((entry) => entry.id)).toEqual(['2', '3', '4']);
    expect(blocks.map((block) => ('first' in block ? block.first : null))).toEqual([null, true, false, false, null, true]);
  });

  it('uma execução que começa por texto põe o marcador no texto e uma atividade no meio não reabre a sequência', () => {
    const blocks = buildBlocks([text('1', 'user', 'oi'), text('2', 'assistant', 'vou ver'), activity('3'), text('4', 'assistant', 'achei')]);
    expect(blocks.map((block) => ('first' in block ? block.first : null))).toEqual([null, true, false, false]);
  });

  it('o texto do bot ainda em escrita não vira bloco: a resposta aparece inteira só quando termina, e as ferramentas continuam ao vivo (T19)', () => {
    const writing = [text('1', 'user', 'faça'), activity('2', 'running'), text('3', 'assistant', 'Olá, tud', 'streaming')];
    expect(visibleItems(writing).map((item) => item.id)).toEqual(['1', '2']);
    expect(buildBlocks(writing).map((block) => block.type)).toEqual(['user', 'activities']);

    // O mesmo texto, agora concluído (o evento seguinte do SSE troca o estado da linha), entra inteiro, sem remontar a sequência.
    const done = writing.map((item) => (item.id === '3' ? text('3', 'assistant', 'Olá, tudo bem?') : item));
    const blocks = buildBlocks(done);
    expect(blocks.map((block) => block.type)).toEqual(['user', 'activities', 'assistant']);
    const reply = blocks[2];
    expect(reply?.type === 'assistant' && [reply.message.content, reply.first]).toEqual(['Olá, tudo bem?', false]);

    expect(lastVisibleItem(writing)?.id).toBe('2');
    expect(lastVisibleItem([text('1', 'assistant', 'só escrevendo', 'streaming')])).toBeUndefined();
    expect(lastVisibleItem(done)?.id).toBe('3');

    // Só o texto do BOT escondido: a mensagem do dono nunca fica fora, e um cartão em qualquer estado aparece.
    expect(visibleItems([text('1', 'user', 'oi', 'streaming'), card('2')]).map((item) => item.id)).toEqual(['1', '2']);
  });

});

// A linha única de trabalho da execução (phase 18, decisão 5 da spec; A10 e A11): "Trabalhou por N s · N ações", uma por execução, com o tempo que sai só dos `createdAt` dos itens.
describe('linha de trabalho "Trabalhou por N s · N ações" (A10 e A11)', () => {
  const at = (seconds: number): string => new Date(Date.parse(AT) + seconds * 1000).toISOString();
  const item = <T extends MessageView>(message: T, runId: string, seconds: number): T => ({ ...message, runId, createdAt: at(seconds) });
  const tool = (id: string, runId: string, seconds: number, status: ActivityView['status'] = 'completed'): ActivityView => item(activity(id, status), runId, seconds);
  const lineOf = (items: MessageView[], key: string) => workLinesOf(buildBlocks(items), items).get(key);

  it('a duração vai da mensagem que abre a rodada ao último item da execução; a resposta final conta pelo `createdAt` dela', () => {
    const items = [item(text('1', 'user', 'oi'), '7', 0), tool('2', '7', 3), tool('3', '7', 9), item(text('4', 'assistant', 'pronto'), '7', 12)];
    const line = lineOf(items, '2');
    expect(line).toMatchObject({ startedAt: at(0), endedAt: at(12) });
    expect(line && describeWork(line, false)).toBe('Trabalhou por 12 s · 2 ações');
  });

  it('uma ação é "1 ação"; acima de 60 s a duração vira minutos; nunca "0 s"; falha entra no resumo', () => {
    const one = [item(text('1', 'user', 'oi'), '7', 0), tool('2', '7', 4)];
    expect(describeWork(lineOf(one, '2')!, false)).toBe('Trabalhou por 4 s · 1 ação');
    expect(elapsedLabel(at(0), at(60))).toBe('60 s');
    expect(elapsedLabel(at(0), at(65))).toBe('1 min 5 s');
    expect(elapsedLabel(at(0), at(120))).toBe('2 min');
    expect(elapsedLabel(at(0), at(0))).toBe('1 s');
    const failed = [item(text('1', 'user', 'oi'), '7', 0), tool('2', '7', 2, 'failed'), tool('3', '7', 3)];
    expect(describeWork(lineOf(failed, '2')!, false)).toBe('Trabalhou por 3 s · 2 ações, 1 com falha');
  });

  it('em andamento não tem duração: "Executando N ações", ou "Aguardando aprovação" quando uma ação espera o dono', () => {
    const items = [item(text('1', 'user', 'oi'), '7', 0), tool('2', '7', 3), tool('3', '7', 4, 'running')];
    expect(describeWork(lineOf(items, '2')!, false)).toBe('Executando 2 ações');
    expect(describeWork(lineOf([item(text('1', 'user', 'oi'), '7', 0), tool('2', '7', 3)], '2')!, true)).toBe('Executando 1 ação');
    const waiting = { ...tool('3', '7', 4, 'running'), awaitingApproval: true };
    expect(describeWork(lineOf([item(text('1', 'user', 'oi'), '7', 0), waiting], '3')!, true)).toBe('Aguardando aprovação');
  });

  it('uma linha por execução: o texto intermediário não parte a linha, e os blocos seguintes da mesma execução ficam sem linha', () => {
    const items = [item(text('1', 'user', 'oi'), '7', 0), tool('2', '7', 2), item(text('3', 'assistant', 'achei'), '7', 3), tool('4', '7', 5), item(text('5', 'assistant', 'fim'), '7', 8)];
    const lines = workLinesOf(buildBlocks(items), items);
    expect(lines.get('2')?.activities.map((activity) => activity.id)).toEqual(['2', '4']);
    expect(lines.get('4')).toBeNull();
    expect(lines.get('2')).toMatchObject({ startedAt: at(0), endedAt: at(8) });
    // Duas execuções diferentes têm cada uma a sua.
    const two = [...items, item(text('6', 'user', 'de novo'), '8', 20), tool('7', '8', 22)];
    expect(workLinesOf(buildBlocks(two), two).get('7')).toMatchObject({ startedAt: at(20), endedAt: at(22) });
  });

  it('a rotina (sem mensagem do dono) conta do primeiro item da execução', () => {
    const items = [tool('2', '9', 100), item(text('3', 'assistant', 'resumo'), '9', 130)];
    expect(describeWork(lineOf(items, '2')!, false)).toBe('Trabalhou por 30 s · 1 ação');
  });

  it('rodada sem ferramenta não tem linha (A11)', () => {
    const items = [item(text('1', 'user', 'oi'), '7', 0), item(text('2', 'assistant', 'olá'), '7', 2)];
    expect(workLinesOf(buildBlocks(items), items).size).toBe(0);
  });

  it('o texto em escrita não estica a duração (só o que a tela mostra conta)', () => {
    const items = [item(text('1', 'user', 'oi'), '7', 0), tool('2', '7', 3), item(text('3', 'assistant', 'escrevendo', 'streaming'), '7', 50)];
    expect(lineOf(items, '2')).toMatchObject({ endedAt: at(3) });
  });
});
describe('complemento e rascunho devolvido no cliente (phase 4, F5)', () => {
  const complement = (id: string) => ({ id, content: `complemento ${id}`, attachments: [], createdAt: AT });
  const draft = (id: string, content = 'rascunho') => ({ id, content, attachments: [], returnedAt: AT });

  it('o complemento enviado entra na execução ativa uma vez; cancelar o tira; sem execução ativa nada muda', () => {
    let state = fromSnapshot(snapshot([], [run('5', 'running'), run('6', 'queued')]));
    state = applyComplement(applyComplement(state, complement('70')), complement('70'));
    expect(activeRunOf(state)?.complements?.map((item) => item.id)).toEqual(['70']);
    expect(state.runs.find((item) => item.id === '6')?.complements).toBeUndefined();
    expect(activeRunOf(dropComplement(state, '70'))?.complements).toEqual([]);
    const idle = fromSnapshot(snapshot([]));
    expect(applyComplement(idle, complement('71'))).toBe(idle);
  });

  it('o snapshot traz o rascunho; o evento substitui, e `draft: null` só tira o rascunho do mesmo id', () => {
    const state = fromSnapshot({ ...snapshot([]), draft: draft('9') });
    expect(state.draft?.id).toBe('9');
    expect(applyDraft(state, { id: '8', draft: null }).draft?.id).toBe('9'); // evento atrasado de um rascunho antigo
    expect(applyDraft(state, { id: '9', draft: null }).draft).toBeNull();
    expect(applyDraft(state, { id: '9', draft: draft('9', 'juntado') }).draft?.content).toBe('juntado');
    expect(fromSnapshot(snapshot([])).draft).toBeNull();
  });
});

describe('versões do Chat geral no cliente (phase 4, F1 a F4)', () => {
  const round = (messageId: string, runId: string, messageVersions = [messageId], runVersions = [runId]) => ({ messageId, runId, messageVersions, runVersions });

  it('o snapshot da sessão traz as rodadas e o retrocesso; a página antiga soma as rodadas dela antes, sem repetir; o bot fica sem rodadas', () => {
    const session = fromSnapshot({ ...snapshot([text('3', 'user', 'c')]), hasMore: true, rounds: [round('3', '30', ['2', '3'])], rewound: { runId: '30', rounds: 2 } });
    expect(session.rounds).toEqual([round('3', '30', ['2', '3'])]);
    expect(session.rewound).toEqual({ runId: '30', rounds: 2 });
    const older = prependPage(session, { items: [text('1', 'user', 'a')], hasMore: false, rounds: [round('1', '10'), round('3', '30', ['2', '3'])] });
    expect(older.rounds?.map((item) => item.messageId)).toEqual(['1', '3']);
    const bot = fromSnapshot(snapshot([text('1', 'user', 'a')]));
    expect([bot.rounds, bot.rewound]).toEqual([null, null]);
    expect(prependPage(bot, { items: [], hasMore: false }).rounds).toBeNull();
  });

  it('a mensagem do dono que chega pelo SSE abre uma rodada de versão única na sessão; o complemento e o bot não mexem nas rodadas', () => {
    const session = fromSnapshot({ ...snapshot([]), rounds: [] });
    const opened = applyMessage(session, { ...text('5', 'user', 'nova'), runId: '50' });
    expect(opened.rounds).toEqual([round('5', '50')]);
    expect(applyMessage(opened, { ...text('5', 'user', 'nova'), runId: '50' }).rounds).toEqual([round('5', '50')]);
    expect(applyMessage(opened, { ...text('6', 'user', 'mais'), runId: '50', complement: true }).rounds).toEqual([round('5', '50')]);
    expect(applyMessage(fromSnapshot(snapshot([])), text('7', 'user', 'bot')).rounds).toBeNull();
  });

  it('a sessão fica ocupada (controles de versão bloqueados) com qualquer execução aberta, inclusive a da fila', () => {
    expect(isBusy(fromSnapshot(snapshot([])))).toBe(false);
    expect(isBusy(fromSnapshot(snapshot([], [run('9', 'queued')])))).toBe(true);
    expect(isBusy(fromSnapshot(snapshot([], [run('9', 'waiting_approval')])))).toBe(true);
  });

  it('a resposta sem texto (falha, só atividades) do caminho recebe a barra no último bloco dela; a com texto e a de fora do caminho, não', () => {
    const failed = { ...card('5'), runId: '50' };
    const tools = { ...activity('7'), runId: '70' };
    const blocks = buildBlocks([text('1', 'user', 'a'), { ...text('2', 'assistant', 'b'), runId: '20' }, text('4', 'user', 'c'), failed, text('6', 'user', 'd'), tools, { ...card('8'), runId: '80' }]);
    expect([...bareAnswerAnchorsOf(blocks, new Set(['20', '50', '70']))]).toEqual([['5', '50'], ['7', '70']]);
  });
});

describe('arquivos gerados pelo Python sob a resposta (phase 4, F10)', () => {
  const file = (id: string, format: 'png' | 'csv') => ({ id, name: `arquivo-${id}.${format}`, kind: 'generated' as const, sizeBytes: 10, removed: false, format });
  const python = (id: string, runId: string, files: ReturnType<typeof file>[]): ActivityView => ({ ...activity(id), runId, tool: 'run_python', attachments: files });

  it('vão para a última bolha de texto da execução, na ordem de gravação; anexos que não são gerados ficam de fora', () => {
    const blocks = buildBlocks([
      text('1', 'user', 'a'),
      { ...python('2', '10', [file('20', 'png')]), attachments: [file('20', 'png'), { id: '21', name: 'foto.jpg', kind: 'image', sizeBytes: 5, removed: false }] },
      { ...text('3', 'assistant', 'parcial'), runId: '10' },
      python('4', '10', [file('22', 'csv')]),
      { ...text('5', 'assistant', 'final'), runId: '10' },
    ]);
    expect([...generatedFilesOf(blocks)]).toEqual([['5', [file('20', 'png'), file('22', 'csv')]]]);
  });

  it('a execução sem texto (falha, parada) os mostra sob o último grupo de atividades dela; execuções sem arquivo não aparecem', () => {
    const blocks = buildBlocks([text('1', 'user', 'a'), python('2', '10', [file('20', 'png')]), { ...card('3'), runId: '10' }, text('4', 'user', 'b'), python('5', '11', [])]);
    expect([...generatedFilesOf(blocks)]).toEqual([['2', [file('20', 'png')]]]);
  });
});

// A frase e a presença da linha da Faísca acima do composer (phase 18, ID-04, A7 e A8): a tabela de frases tem uma casa só, `workingPhrase`.
describe('frase da linha da Faísca (A7)', () => {
  const DOC = '8f0c2f4e-5f5f-4f7a-9d7e-1f8a6a1d0002';
  const running = (tool: string, args = '{}', awaitingApproval = false): ActivityView => ({ ...activity('9', 'running'), tool, arguments: args, awaitingApproval });
  const titles = (docId: string): string | null => (docId === DOC ? 'Plano de maio' : null);

  it('busca de e-mails no Gmail, leitura de doc com o título, aprovação pendente e o resto: "Trabalhando…"', () => {
    expect(workingPhrase([running('GMAIL_FETCH_EMAILS')], false, titles)).toBe('Procurando e-mails no Gmail…');
    expect(workingPhrase([running('GMAIL_LIST_MESSAGES')], false, titles)).toBe('Procurando e-mails no Gmail…');
    expect(workingPhrase([running('doc_read', JSON.stringify({ docId: DOC }))], false, titles)).toBe('Lendo o doc Plano de maio…');
    expect(workingPhrase([running('GMAIL_SEND_EMAIL')], true, titles)).toBe('Aguardando sua aprovação');
    expect(workingPhrase([running('table_write')], false, titles)).toBe('Trabalhando…');
    expect(workingPhrase([], false, titles)).toBe('Trabalhando…');
  });

  it('a frase segue a ferramenta EM CURSO: a concluída não conta e a última em andamento vence', () => {
    const done: ActivityView = { ...activity('1'), tool: 'GMAIL_FETCH_EMAILS' };
    expect(workingPhrase([done], false, titles)).toBe('Trabalhando…');
    expect(workingPhrase([done, running('doc_read', JSON.stringify({ docId: DOC }))], false, titles)).toBe('Lendo o doc Plano de maio…');
    expect(workingPhrase([running('doc_read', JSON.stringify({ docId: DOC })), running('GMAIL_FETCH_EMAILS')], false, titles)).toBe('Procurando e-mails no Gmail…');
  });

  it('doc fora da lista (sem acesso ou excluído), argumento truncado ou sem docId: "Trabalhando…", sem lançar e sem id na frase', () => {
    expect(workingPhrase([running('doc_read', JSON.stringify({ docId: '7e57' }))], false, titles)).toBe('Trabalhando…');
    expect(workingPhrase([running('doc_read', '{"docId":"8f0c2f4e-5f5f-4f7a')], false, titles)).toBe('Trabalhando…');
    expect(workingPhrase([running('doc_read', '{}')], false, titles)).toBe('Trabalhando…');
    expect(workingDocId([running('doc_read', '{"docId":"8f0c')])).toBeNull();
    expect(workingDocId([running('doc_read', JSON.stringify({ docId: DOC }))])).toBe(DOC);
    expect(workingDocId([running('table_write', JSON.stringify({ docId: DOC }))])).toBeNull();
  });

  it('aprovação pendente vem da execução ou da atividade em andamento que a espera', () => {
    expect(isWaitingApproval('waiting_approval', [])).toBe(true);
    expect(isWaitingApproval('running', [running('GMAIL_SEND_EMAIL', '{}', true)])).toBe(true);
    expect(isWaitingApproval('running', [{ ...running('x', '{}', true), status: 'completed' }])).toBe(false);
    expect(isWaitingApproval(undefined, [])).toBe(false);
  });
});

describe('a linha da Faísca aparece só enquanto há trabalho (A6 e A8)', () => {
  it('execução rodando ou aguardando aprovação: sim; terminada, parada ou falha (sem execução aberta): não', () => {
    expect(isWorking(fromSnapshot(snapshot([text('1', 'user', 'oi')], [run('5', 'running')])))).toBe(true);
    expect(isWorking(fromSnapshot(snapshot([text('1', 'user', 'oi')], [run('5', 'waiting_approval')])))).toBe(true);
    expect(isWorking(fromSnapshot(snapshot([text('1', 'user', 'oi'), text('2', 'assistant', 'ok')])))).toBe(false);
  });

  it('fila: a de bot ou de rotina não conta; a de uma versão nova do Chat geral, já no caminho, conta', () => {
    expect(isWorking(fromSnapshot(snapshot([text('1', 'user', 'oi')], [run('5', 'queued')])))).toBe(false);
    const onPath = { ...fromSnapshot(snapshot([text('1', 'user', 'oi')], [run('5', 'queued')])), rounds: [{ messageId: '1', messageVersions: ['1'], runId: '5', runVersions: ['5'] }] };
    expect(isWorking(onPath)).toBe(true);
  });
});

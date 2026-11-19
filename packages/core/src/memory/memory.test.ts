// Prova da memória global e por bot (A11, MEM-01, MEM-02; F11; T8) contra PostgreSQL real e o provedor falso: o dono salva, vê o
// histórico e restaura; o limite de 8.000 caracteres e o conflito por versão são recusados sem alterar nada; o bot edita só a
// própria memória (a global é intocável para ele), a edição gera o cartão com desfazer; as duas memórias entram no contexto do
// modelo; e a retenção apaga o que passou de 90 dias sem nunca baixar das 50 versões mais recentes.
import type { Bot, CardView } from '@aion/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '../errors';
import { editMemoryTool } from '../runs/edit-memory';
import { ORIGIN, createRunsWorld, type RunsWorld } from '../runs/test-support';
import type { ToolContext } from '../runs/tools';
import { MemoryService } from './service';

let w: RunsWorld;
beforeAll(async () => {
  w = await createRunsWorld();
  w.engine.start();
});
afterAll(async () => {
  await w.cleanup();
});

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    return error instanceof DomainError ? error.code : `INESPERADO:${String(error)}`;
  }
};

const GLOBAL = { scope: 'global' } as const;
const botOf = (botId: string) => ({ scope: 'bot', botId }) as const;

/** Cartões "Memória atualizada" da conversa do bot, em ordem. */
async function memoryCards(bot: Bot) {
  const entries = await w.timeline(bot);
  return entries.filter((entry) => entry.kind === 'card' && entry.data.type === 'memory_updated');
}

describe('o dono edita a memória, vê o histórico e restaura (F11 passos 3 a 5)', () => {
  it('cada salvamento é uma versão imutável; limite, versão esperada e versão inexistente são recusados sem alterar nada', async () => {
    const { memory } = w;
    const bot = await w.createBot();
    const target = botOf(bot.id);

    // Nasce vazia, na versão 0.
    expect(await memory.read(target)).toEqual({ content: '', version: 0, limit: 8000, updatedAt: null, updatedBy: null });

    const first = await memory.save(target, 'Dono mora em SP.', 0, ORIGIN);
    expect(first).toMatchObject({ content: 'Dono mora em SP.', version: 1, updatedBy: 'owner' });
    const second = await memory.save(target, 'Dono mora em SP.\nPrefere planilhas.', 1, ORIGIN);
    expect(second.version).toBe(2);

    // Conflito: a tela ainda estava na versão 1. Nada muda, e a memória atual continua a da versão 2.
    expect(await codeOf(memory.save(target, 'texto de quem estava desatualizado', 1, ORIGIN))).toBe('MEMORY_CONFLICT');
    expect((await memory.read(target)).content).toBe('Dono mora em SP.\nPrefere planilhas.');
    // Salvar de novo o mesmo texto não cria versão nem conflita (repetir um salvamento é inofensivo).
    expect((await memory.save(target, 'Dono mora em SP.\nPrefere planilhas.', 1, ORIGIN)).version).toBe(2);

    // Limite de 8.000 caracteres: 8.000 passam (emoji conta 1), 8.001 são recusados e a memória fica como estava.
    const atLimit = await memory.save(target, '😀'.repeat(8000), 2, ORIGIN);
    expect(atLimit.version).toBe(3);
    expect(await codeOf(memory.save(target, 'x'.repeat(8001), 3, ORIGIN))).toBe('MEMORY_TOO_LARGE');
    expect((await memory.read(target)).version).toBe(3);

    // Histórico: mais recente primeiro, com autor, data e o tamanho da mudança.
    const list = await memory.listVersions(target);
    expect(list.versions.map((item) => [item.version, item.author, item.added, item.removed, item.restoredFrom])).toEqual([
      [3, 'owner', 1, 2, null],
      [2, 'owner', 1, 0, null],
      [1, 'owner', 1, 0, null],
    ]);
    // Uma versão traz o texto e o diff contra a anterior; a primeira é comparada com o vazio.
    expect((await memory.getVersion(target, 2)).diff).toEqual([
      { kind: 'same', text: 'Dono mora em SP.' },
      { kind: 'add', text: 'Prefere planilhas.' },
    ]);
    expect((await memory.getVersion(target, 1)).diff).toEqual([{ kind: 'add', text: 'Dono mora em SP.' }]);
    expect(await codeOf(memory.getVersion(target, 99))).toBe('MEMORY_VERSION_NOT_FOUND');

    // Restaurar a versão 1 cria a versão 4 (nada é reescrito), com autor dono e a origem registrada.
    const restored = await memory.restore(target, 1, 3, ORIGIN);
    expect(restored).toMatchObject({ content: 'Dono mora em SP.', version: 4, updatedBy: 'owner' });
    expect((await memory.listVersions(target)).versions[0]).toMatchObject({ version: 4, restoredFrom: 1 });
    expect((await memory.getVersion(target, 1)).content).toBe('Dono mora em SP.'); // a versão 1 segue intacta
    expect(await codeOf(memory.restore(target, 1, 3, ORIGIN))).toBe('MEMORY_CONFLICT'); // versão esperada velha
    expect(await codeOf(memory.restore(target, 77, 4, ORIGIN))).toBe('MEMORY_VERSION_NOT_FOUND');
    // Restaurar o texto que já é o atual não cria versão.
    expect((await memory.restore(target, 1, 4, ORIGIN)).version).toBe(4);

    // Bot que não existe não ganha memória.
    expect(await codeOf(memory.read(botOf('00000000-0000-4000-8000-000000000000')))).toBe('BOT_NOT_FOUND');

    // Auditoria: quem, o quê e quando, sem o texto da memória.
    const audit = await w.pool.query<{ action: string; actor: string; details: Record<string, unknown> }>(
      "SELECT action, actor, details FROM audit_log WHERE action LIKE 'memory.%' AND target = $1 ORDER BY id",
      [bot.id],
    );
    expect(audit.rows.map((row) => row.action)).toEqual(['memory.save', 'memory.save', 'memory.save', 'memory.restore']);
    expect(JSON.stringify(audit.rows)).not.toContain('planilhas');
  });

  it('a memória global segue as mesmas regras e é independente das memórias dos bots', async () => {
    const { memory } = w;
    const before = await memory.read(GLOBAL);
    expect(before.version).toBe(0);
    const saved = await memory.save(GLOBAL, 'Idioma: português.', 0, ORIGIN);
    expect(saved).toMatchObject({ content: 'Idioma: português.', version: 1 });
    expect(await codeOf(memory.save(GLOBAL, 'outra', 0, ORIGIN))).toBe('MEMORY_CONFLICT');
    expect(await codeOf(memory.save(GLOBAL, 'x'.repeat(8001), 1, ORIGIN))).toBe('MEMORY_TOO_LARGE');
    expect((await memory.listVersions(GLOBAL)).versions.map((item) => item.version)).toEqual([1]);
    expect((await memory.restore(GLOBAL, 1, 1, ORIGIN)).version).toBe(1);

    // Bots criados antes e depois não herdam nada nem aparecem no histórico global.
    const bot = await w.createBot();
    expect((await memory.read(botOf(bot.id))).content).toBe('');
    expect((await memory.listVersions(botOf(bot.id))).versions).toEqual([]);
  });
});

describe('o bot edita a própria memória pela ferramenta (F11 passos 1 e 2)', () => {
  it('a edição vira versão do bot e cartão com diff e desfazer; desfazer restaura como versão do dono e só vale enquanto nada mudou depois', async () => {
    const { memory, conversations } = w;
    const bot = await w.createBot();
    const other = await w.createBot();
    await memory.save(botOf(bot.id), 'Prefere respostas curtas.', 0, ORIGIN);

    const runId = await w.send(bot, '[memoria:Cliente principal: Acme.] anote isso');
    await w.waitForStatus(runId, 'completed');

    // A memória tem o texto novo, na versão 2 e com autor bot.
    expect(await memory.read(botOf(bot.id))).toMatchObject({ content: 'Prefere respostas curtas.\nCliente principal: Acme.', version: 2, updatedBy: 'bot' });
    // A atividade registra a chamada e devolve ao bot o tamanho e o limite.
    const timeline = await w.timeline(bot);
    const activity = timeline.find((entry) => entry.kind === 'activity');
    expect(activity).toMatchObject({ status: 'completed', data: { tool: 'edit_memory', label: 'Anotou na memória' } });
    expect(activity?.content).toMatch(/versão 2.*Tamanho: 50 de 8\.000 caracteres/);
    // O cartão: versão, diff resumido (só a linha nova) e tamanho. Fica fora da busca e do contexto (conteúdo vazio).
    const [card] = await memoryCards(bot);
    expect(card).toMatchObject({
      status: 'done',
      content: '',
      data: { type: 'memory_updated', version: 2, previousVersion: 1, status: 'applied', added: 1, removed: 0, size: 50, preview: [{ kind: 'add', text: 'Cliente principal: Acme.' }] },
    });
    const view = (await conversations.snapshot(bot.id)).items.find((item) => item.kind === 'card' && item.card.type === 'memory_updated') as CardView;
    expect(view.card).toMatchObject({ type: 'memory_updated', limit: 8000 });

    // Desfazer: de outro bot o cartão não existe (sem IDOR); do bot certo restaura a versão anterior como NOVA versão do dono.
    expect(await codeOf(memory.undoCard(other.id, card!.id, ORIGIN))).toBe('NOT_FOUND');
    const undone = await memory.undoCard(bot.id, card!.id, ORIGIN);
    expect(undone).toMatchObject({ content: 'Prefere respostas curtas.', version: 3, updatedBy: 'owner' });
    expect((await memoryCards(bot))[0]?.data.status).toBe('undone');
    expect((await memory.listVersions(botOf(bot.id))).versions[0]).toMatchObject({ version: 3, restoredFrom: 1, author: 'owner' });
    expect((await memory.undoCard(bot.id, card!.id, ORIGIN)).version).toBe(3); // repetir o desfazer é inofensivo

    // Depois que o dono muda a memória, o cartão de uma edição antiga não pode mais desfazer (apagaria o que veio depois).
    const secondRun = await w.send(bot, '[memoria:Fuso: Brasília.] mais uma');
    await w.waitForStatus(secondRun, 'completed');
    const [, secondCard] = await memoryCards(bot);
    const current = await memory.read(botOf(bot.id));
    await memory.save(botOf(bot.id), `${current.content}\nEditado pelo dono.`, current.version, ORIGIN);
    expect(await codeOf(memory.undoCard(bot.id, secondCard!.id, ORIGIN))).toBe('MEMORY_CONFLICT');
    expect((await memory.read(botOf(bot.id))).content).toContain('Editado pelo dono.');
  });

  it('o bot não escreve na memória global nem na de outro bot, e uma edição acima do limite é recusada com orientação', async () => {
    const { memory } = w;
    const bot = await w.createBot();
    const other = await w.createBot();
    const globalBefore = await memory.read(GLOBAL);
    const otherBefore = await memory.read(botOf(other.id));

    // O modelo tenta apontar para a global (`scope`): o argumento está fora do contrato e a chamada falha sem escrever.
    const attempt = await w.send(bot, '[memoria-global:invadir] tente a global');
    await w.waitForStatus(attempt, 'completed');
    const failed = (await w.timeline(bot)).find((entry) => entry.kind === 'activity');
    expect(failed).toMatchObject({ status: 'failed', content: expect.stringMatching(/^\{"code":"VALIDATION_FAILED","message":"Argumentos inválidos/) });
    expect(await memory.read(GLOBAL)).toEqual(globalBefore);
    expect(await memoryCards(bot)).toEqual([]);
    // Uma edição válida do bot também só alcança a memória dele: a global e a de outro bot seguem exatamente como estavam.
    await w.waitForStatus(await w.send(bot, '[memoria:só minha] anote'), 'completed');
    expect((await memory.read(botOf(bot.id))).content).toBe('só minha');
    expect(await memory.read(GLOBAL)).toEqual(globalBefore);
    expect(await memory.read(botOf(other.id))).toEqual(otherBefore);
    await memory.save(botOf(bot.id), 'Memória atual.', 1, ORIGIN);
    // ...e as chamadas inválidas não deixaram cartão.
    expect(await memoryCards(bot)).toHaveLength(1);

    // Acima de 8.000 caracteres: a ferramenta devolve erro orientando a reorganizar, nada muda e não há cartão novo.
    const big = await w.send(bot, '[memoria-grande] reescreva tudo');
    await w.waitForStatus(big, 'completed');
    const bigActivity = (await w.timeline(bot)).filter((entry) => entry.kind === 'activity').at(-1);
    expect(bigActivity?.status).toBe('failed');
    expect(bigActivity?.content).toMatch(/8\.001 caracteres, acima do limite de 8\.000.*Nada foi alterado.*Reorganize/);
    expect(await memory.read(botOf(bot.id))).toMatchObject({ content: 'Memória atual.', version: 2 });
    expect(await memoryCards(bot)).toHaveLength(1);
  });
});

describe('as memórias entram no contexto do modelo (spec decisão 10)', () => {
  it('cada etapa leva a memória global e a do bot lidas na hora, e uma edição do dono vale já na próxima execução', async () => {
    const { memory } = w;
    const bot = await w.createBot();
    await memory.save(GLOBAL, 'Regra global: nunca invente números.', (await memory.read(GLOBAL)).version, ORIGIN);
    await memory.save(botOf(bot.id), 'Preferência do bot: tabelas.', 0, ORIGIN);

    const systemOf = () => (w.conversationRequests().at(-1)?.body?.messages as { role: string; content: string }[])[0]?.content ?? '';
    await w.waitForStatus(await w.send(bot, 'oi'), 'completed');
    const first = systemOf();
    // A35 (phase 15, passo 10), pelo efeito e não pelo título: cada memória chega uma vez, sob um rótulo próprio, a global antes da do bot.
    const bodies = ['Regra global: nunca invente números.', 'Preferência do bot: tabelas.'];
    /** O título na linha não vazia logo acima da linha da memória (ou nada, se ela não estiver sob um título). */
    const labelOf = (body: string) => {
      const above = first.slice(0, first.indexOf(body)).split('\n').slice(0, -1).filter((line) => line.trim() !== '').at(-1);
      return above !== undefined && /^#{1,3} /.test(above) ? above : undefined;
    };
    for (const body of bodies) expect(first.split(body)).toHaveLength(2);
    expect(first.indexOf(bodies[0]!)).toBeLessThan(first.indexOf(bodies[1]!));
    expect(labelOf(bodies[0]!)).toBeDefined();
    expect(labelOf(bodies[1]!)).toBeDefined();
    expect(labelOf(bodies[0]!)).not.toBe(labelOf(bodies[1]!));
    // As regras de memória vivem na descrição de edit_memory (phase 3, Suposição 16), não no sistema: nenhuma frase longa dela se repete no sistema.
    const tools = w.conversationRequests().at(-1)?.body?.tools as { function: { name: string; description: string } }[];
    for (const sentence of editMemoryTool.definition.description.split(/(?<=[.!?])\s+/u).filter((part) => part.length >= 60)) expect(first).not.toContain(sentence);
    // A ferramenta de memória está ao alcance do modelo: publicada, ou indexada no índice da árvore do sistema (o catálogo sob demanda não publica todos os esquemas).
    expect(tools.some((tool) => tool.function.name === 'edit_memory') || /^- ferramentas\/memoria: .*\(edit_memory\)$/mu.test(first)).toBe(true);
    // O bot sabe da edição de memória pelo resultado da ferramenta: o cartão do dono não entra no contexto.
    await w.waitForStatus(await w.send(bot, '[memoria:Anotação nova.] anote'), 'completed');
    await w.waitForStatus(await w.send(bot, 'e agora?'), 'completed');
    const turns = w.conversationRequests().at(-1)?.body?.messages as { role: string; content?: string }[];
    expect(JSON.stringify(turns)).not.toContain('memory_updated');
    expect(turns[0]?.content).toContain('Anotação nova.');

    await memory.save(botOf(bot.id), 'Preferência do bot: gráficos.', (await memory.read(botOf(bot.id))).version, ORIGIN);
    await w.waitForStatus(await w.send(bot, 'mais uma'), 'completed');
    expect(systemOf()).toContain('Preferência do bot: gráficos.');
    expect(systemOf()).not.toContain('Preferência do bot: tabelas.');
  });
});

describe('retenção das versões (MEM-01): 90 dias, no mínimo as 50 mais recentes', () => {
  // Mundo próprio: a conta de versões da memória global não pode depender do que os outros testes gravaram nela.
  let own: RunsWorld;
  beforeAll(async () => {
    own = await createRunsWorld();
  });
  afterAll(async () => {
    await own.cleanup();
  });

  it('apaga só o que passou de 90 dias e está além das 50 mais recentes de cada memória, e nunca a versão atual', async () => {
    let clock = new Date('2026-01-01T12:00:00Z');
    const memory = new MemoryService({ pool: own.pool, now: () => clock });
    const daysAgo = (days: number) => new Date(new Date('2026-07-01T12:00:00Z').getTime() - days * 86_400_000);
    const writeVersions = async (target: Parameters<MemoryService['save']>[0], count: number, at: Date) => {
      clock = at;
      for (let index = 0; index < count; index += 1) {
        const current = await memory.read(target);
        await memory.save(target, `versão ${current.version + 1} (${at.toISOString().slice(0, 10)})`, current.version, ORIGIN);
      }
    };
    const versionsOf = async (target: Parameters<MemoryService['save']>[0]) => (await memory.listVersions(target)).versions.map((item) => item.version);

    // Bot A: 70 versões antigas (200 dias) e 5 recentes (hoje). As 50 mais recentes ficam: 5 novas + 45 antigas.
    const a = botOf((await own.createBot()).id);
    await writeVersions(a, 70, daysAgo(200));
    await writeVersions(a, 5, daysAgo(0));
    // Bot B: só 3 versões, todas antigas: abaixo do mínimo, nada sai.
    const b = botOf((await own.createBot()).id);
    await writeVersions(b, 3, daysAgo(300));
    // Bot C: 60 versões, todas dentro de 90 dias: nada sai.
    const c = botOf((await own.createBot()).id);
    await writeVersions(c, 60, daysAgo(30));
    // Memória global: 55 versões com 100 dias; as 50 mais recentes ficam, 5 saem.
    await writeVersions(GLOBAL, 55, daysAgo(100));

    clock = daysAgo(0);
    const removed = await memory.purgeExpiredVersions();
    expect(removed).toBe(25 + 5);

    const keptA = await versionsOf(a);
    expect(keptA).toHaveLength(50);
    expect(keptA[0]).toBe(75); // a versão atual
    expect(keptA.at(-1)).toBe(26); // a mais antiga que sobrou: as 50 mais recentes são 26..75
    expect(await versionsOf(b)).toEqual([3, 2, 1]);
    expect(await versionsOf(c)).toHaveLength(60);
    const keptGlobal = await versionsOf(GLOBAL);
    expect(keptGlobal).toHaveLength(50);
    expect(keptGlobal[0]).toBe(55);
    expect(keptGlobal.at(-1)).toBe(6);
    // A memória em si não muda e o job é idempotente.
    expect((await memory.read(a)).version).toBe(75);
    expect(await memory.purgeExpiredVersions()).toBe(0);
  });
});

describe('repetir o append na mesma execução não duplica o trecho (phase 15, Q8)', () => {
  /** O contexto de uma execução REAL do bot (conversa e execução existentes): o cartão da edição guarda o `run_id`, que é o que reconhece a repetição. */
  async function liveContext(bot: Bot): Promise<ToolContext> {
    const runId = await w.send(bot, 'Olá');
    await w.waitForStatus(runId, 'completed');
    const row = await w.pool.query<{ conversation_id: string }>('SELECT conversation_id::text FROM runs WHERE id = $1', [runId]);
    return { pool: w.pool, botId: bot.id, conversationId: row.rows[0]!.conversation_id, runId, now: () => new Date(), signal: new AbortController().signal };
  }
  const append = (context: ToolContext, content: string) => editMemoryTool.prepare(JSON.stringify({ operation: 'append', content })).execute(context);
  const occurrences = (text: string, part: string): number => text.split(part).length - 1;

  it('phase-15:A19: o mesmo append repetido (em sequência ou em chamadas simultâneas) fica uma vez só, com uma versão e um cartão', async () => {
    const bot = await w.createBot();
    const context = await liveContext(bot);
    await w.memory.save(botOf(bot.id), 'Prefere respostas curtas.', 0, ORIGIN);
    const outcomes = await Promise.all([append(context, 'Fuso: Brasília.'), append(context, 'Fuso: Brasília.'), append(context, 'Fuso: Brasília.')]);
    expect(outcomes.filter((outcome) => outcome.result.startsWith('Memória atualizada'))).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.result.startsWith('Esse trecho já está na memória'))).toHaveLength(2);
    const after = await w.memory.read(botOf(bot.id));
    expect(occurrences(after.content, 'Fuso: Brasília.')).toBe(1);
    expect(after).toMatchObject({ content: 'Prefere respostas curtas.\nFuso: Brasília.', version: 2, updatedBy: 'bot' });
    expect(await memoryCards(bot)).toHaveLength(1);
    // Repetição depois de uma queda: a execução recomeça e o bot repete o append; nada muda.
    expect((await append(context, 'Fuso: Brasília.')).result).toContain('já está na memória');
    expect((await w.memory.read(botOf(bot.id))).version).toBe(2);
  });

  it('phase-15:A19: texto diferente na mesma execução, o mesmo texto noutra execução e o replace entram normalmente', async () => {
    const bot = await w.createBot();
    const context = await liveContext(bot);
    await append(context, 'Primeiro.');
    await append(context, 'Segundo.');
    // O mesmo texto que um append anterior da execução, mas já com outro trecho depois: não é a repetição da última chamada, é uma anotação nova.
    await append(context, 'Primeiro.');
    expect((await w.memory.read(botOf(bot.id))).content).toBe('Primeiro.\nSegundo.\nPrimeiro.');
    // Outra execução (outra conversa de trabalho) anotando o mesmo texto: vale de novo.
    const another = await liveContext(bot);
    expect((await append(another, 'Primeiro.')).result).toContain('Memória atualizada');
    expect((await w.memory.read(botOf(bot.id))).content).toBe('Primeiro.\nSegundo.\nPrimeiro.\nPrimeiro.');
    // O dono editou depois do append do bot: repetir o append é uma anotação nova, não a repetição.
    const edited = await w.memory.read(botOf(bot.id));
    await w.memory.save(botOf(bot.id), `${edited.content}\nDono.`, edited.version, ORIGIN);
    expect((await append(another, 'Primeiro.')).result).toContain('Memória atualizada');
    // O replace nunca é tratado como repetição (troca o texto inteiro).
    const replace = () => editMemoryTool.prepare(JSON.stringify({ operation: 'replace', content: 'Tudo novo.' })).execute(another);
    expect((await replace()).result).toContain('Memória atualizada');
    expect((await replace()).result).toContain('já era exatamente esse texto');
  });
});

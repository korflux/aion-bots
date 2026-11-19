// Âncora da medição de contexto (phase 9, F1, CTX-08): a ocupação parte do usage real da última chamada principal do mesmo modelo. A conta pura é provada
// por valores; a leitura da âncora e o uso no motor (gatilho e medição gravada), com o PostgreSQL, o motor e o provedor falso reais.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatEvent, ChatRequest } from '../models/chat-protocols';
import { SUMMARY_SECTIONS } from './compaction';
import { COMPACTION_THRESHOLD, MAX_OUTPUT_TOKENS, SUMMARY_MAX_OUTPUT_TOKENS, contextEnvelope, estimateChatPayload } from './context-budget';
import { anchoredInputTokens, readContextAnchor } from './context-anchor';
import { readTokenCalibration } from './token-calibration';
import { createRunsWorld, type RunsWorld } from './test-support';

/** Janela fixada pelo teste (não depende do padrão do produto; 64k é a menor opção desde a phase 11): 65536 - saída 16384 (25% da janela, phase 12) - margem 2048 = 47.104. */
const WINDOW = 65536;
const BUDGET = contextEnvelope(WINDOW, MAX_OUTPUT_TOKENS).inputBudget;

describe('anchoredInputTokens (conta pura)', () => {
  /** Razão observada de 0,5: o provedor contou metade da estimativa crua. */
  const anchor = { inputTokens: 10_000, estimatedTokens: 20_000 };

  it('pedido idêntico devolve exatamente o usage da âncora; acréscimo entra pela escala calibrada e imagens pelo teto fixo', () => {
    expect(anchoredInputTokens(anchor, { textTokens: 20_000, imageTokens: 0 }, 0.8)).toBe(10_000);
    // 5.000 de estimativa crua nova x 0,8 = 4.000, nunca pelo teto de 1 token por byte.
    expect(anchoredInputTokens(anchor, { textTokens: 25_000, imageTokens: 0 }, 0.8)).toBe(14_000);
    expect(anchoredInputTokens(anchor, { textTokens: 25_000, imageTokens: 1024 }, 0.8)).toBe(15_024);
    // Arredonda para cima: a conta nunca subestima o acréscimo.
    expect(anchoredInputTokens(anchor, { textTokens: 20_001, imageTokens: 0 }, 0.5)).toBe(10_001);
  });

  it('redução credita só a razão observada na âncora quando ela é menor que a escala, para não declarar "cabe" o que o provedor ainda recusaria', () => {
    // Escala conservadora (0,8) acima da razão observada (0,5): remover 5.000 crus tira 2.500 reais, não 4.000.
    expect(anchoredInputTokens(anchor, { textTokens: 15_000, imageTokens: 0 }, 0.8)).toBe(7_500);
    // Escala abaixo da razão observada: a escala, que é a menor, manda.
    expect(anchoredInputTokens(anchor, { textTokens: 15_000, imageTokens: 0 }, 0.3)).toBe(8_500);
    // Esvaziar o pedido por completo nunca fica negativo, qualquer que seja a razão plausível da âncora e a escala: a redução máxima é a razão da âncora
    // aplicada à estimativa inteira dela, no máximo o próprio usage. É por isso que a conta não precisa de piso.
    for (const [inputTokens, estimatedTokens] of [[10_000, 20_000], [2_401, 20_001], [7, 53], [1, 1], [123_457, 100_003], [3, 25]] as const) {
      for (const scale of [0.2, 0.37, 0.8, 1]) {
        expect(anchoredInputTokens({ inputTokens, estimatedTokens }, { textTokens: 0, imageTokens: 0 }, scale)).toBeGreaterThanOrEqual(0);
      }
    }
    // Âncora pequena (plausível) com acréscimo: soma o usage dela ao acréscimo calibrado, sem nada abaixo disso.
    expect(anchoredInputTokens({ inputTokens: 600, estimatedTokens: 5_000 }, { textTokens: 9_000, imageTokens: 0 }, 0.5)).toBe(2_600);
  });
});

describe('readContextAnchor', () => {
  let world: RunsWorld;
  beforeAll(async () => { world = await createRunsWorld({ contextWindow: WINDOW }); });
  afterAll(async () => { await world?.cleanup(); });

  /** Relógio dos registros sintéticos: n segundos depois de uma base fixa. */
  const at = (seconds: number) => new Date(Date.UTC(2026, 9, 14, 12, 0, seconds));

  /** Conversa de um bot novo com uma execução (sem motor ligado ela só existe, o que basta para a chave estrangeira do ledger). */
  async function conversation() {
    const bot = await world.createBot();
    const run = await world.send(bot, 'abre a conversa');
    return { bot, run, conversationId: await world.conversations.conversationIdOf(bot.id) };
  }

  /** Linha do ledger de uso exatamente como o motor a deixa depois de uma chamada. */
  async function usage(scope: { run: string; conversationId: string }, row: { purpose?: 'main' | 'summary'; model?: string; state?: 'completed' | 'unknown' | 'started'; input: number | null; estimated: number | null; seconds: number; outcome?: 'applied' | 'output_limit' | 'empty' }) {
    await world.pool.query(
      `INSERT INTO model_call_usage(id,conversation_id,run_id,purpose,model,protocol,state,input_tokens,output_tokens,estimated_input_tokens,summary_outcome,created_at,completed_at)
       VALUES(gen_random_uuid(),$1,$2,$3,$4,'chat_completions',$5,$6,10,$7,$8,$9,$9)`,
      [scope.conversationId, scope.run, row.purpose ?? 'main', row.model ?? 'opencode/glm-5.1', row.state ?? 'completed', row.input, row.estimated, row.outcome ?? null, at(row.seconds)],
    );
  }

  it('usa a chamada principal concluída mais recente com entrada e estimativa plausíveis, só da própria conversa', async () => {
    const mine = await conversation(), other = await conversation();
    expect(await readContextAnchor(world.pool, mine.conversationId, 'opencode/glm-5.1')).toBeNull();
    await usage(mine, { input: 3000, estimated: 6000, seconds: 1 });
    await usage(mine, { input: 4000, estimated: 8000, seconds: 2 });
    // Nada abaixo vira âncora: chamada sem desfecho, usage implausível (valor fixo do provedor), sem estimativa (pedido com imagem), resumo não aplicado.
    await usage(mine, { state: 'unknown', input: null, estimated: 9000, seconds: 3 });
    await usage(mine, { input: 5, estimated: 9000, seconds: 4 });
    await usage(mine, { input: 9000, estimated: null, seconds: 5 });
    await usage(mine, { purpose: 'summary', input: 20, estimated: null, seconds: 6, outcome: 'output_limit' });
    await usage(other, { input: 50, estimated: 100, seconds: 7 });
    expect(await readContextAnchor(world.pool, mine.conversationId, 'opencode/glm-5.1')).toEqual({ inputTokens: 4000, estimatedTokens: 8000 });
    expect(await readContextAnchor(world.pool, other.conversationId, 'opencode/glm-5.1')).toEqual({ inputTokens: 50, estimatedTokens: 100 });
  });

  it('trocar o modelo descarta a âncora: a última chamada de outro modelo não serve ao modelo atual', async () => {
    const scope = await conversation();
    await usage(scope, { input: 4000, estimated: 8000, seconds: 1 });
    expect(await readContextAnchor(world.pool, scope.conversationId, 'opencode/glm-5.1')).toEqual({ inputTokens: 4000, estimatedTokens: 8000 });
    await usage(scope, { model: 'opencode/kimi-k2.7-code', input: 7000, estimated: 9000, seconds: 2 });
    expect(await readContextAnchor(world.pool, scope.conversationId, 'opencode/glm-5.1')).toBeNull();
    expect(await readContextAnchor(world.pool, scope.conversationId, 'opencode/kimi-k2.7-code')).toEqual({ inputTokens: 7000, estimatedTokens: 9000 });
  });

  it('uma limpeza fria gravada depois da chamada descarta a âncora (o pedido mudou de forma); gravada antes dela, não, e uma chamada posterior volta a ancorar (phase 11, T7)', async () => {
    const scope = await conversation();
    // Um resultado de ferramenta da conversa, que a limpeza fria marca (a chave estrangeira da marca é a mensagem).
    const result = (await world.pool.query<{ id: string }>(
      "INSERT INTO messages(conversation_id, run_id, role, kind, status, step, content, data, created_at) VALUES($1, $2, 'assistant', 'activity', 'completed', 1, $3, '{}', now()) RETURNING id::text AS id",
      [scope.conversationId, scope.run, 'r'.repeat(2000)])).rows[0]!.id;
    const mask = (seconds: number) => world.pool.query('INSERT INTO context_cold_masks(message_id, conversation_id, masked_at) VALUES($1, $2, $3) ON CONFLICT (message_id) DO UPDATE SET masked_at = EXCLUDED.masked_at', [result, scope.conversationId, at(seconds)]);
    await mask(1);
    await usage(scope, { input: 4000, estimated: 8000, seconds: 2 });
    expect(await readContextAnchor(world.pool, scope.conversationId, 'opencode/glm-5.1')).toEqual({ inputTokens: 4000, estimatedTokens: 8000 });
    // A limpeza fria da conversa é regravada DEPOIS da chamada dela (instante 3 > 2): a âncora cai. Outra conversa, sem limpeza, segue com a dela.
    const other = await conversation();
    await usage(other, { input: 50, estimated: 100, seconds: 3 });
    await mask(3);
    expect(await readContextAnchor(world.pool, scope.conversationId, 'opencode/glm-5.1')).toBeNull();
    expect(await readContextAnchor(world.pool, other.conversationId, 'opencode/glm-5.1')).toEqual({ inputTokens: 50, estimatedTokens: 100 });
    // Uma chamada principal posterior à limpeza volta a ancorar.
    await usage(scope, { input: 2000, estimated: 5000, seconds: 4 });
    expect(await readContextAnchor(world.pool, scope.conversationId, 'opencode/glm-5.1')).toEqual({ inputTokens: 2000, estimatedTokens: 5000 });
  });

  it('um checkpoint aplicado depois da chamada descarta a âncora; aplicado antes dela, não', async () => {
    const scope = await conversation();
    await usage(scope, { purpose: 'summary', input: 100, estimated: null, seconds: 1, outcome: 'applied' });
    await usage(scope, { input: 4000, estimated: 8000, seconds: 2 });
    expect(await readContextAnchor(world.pool, scope.conversationId, 'opencode/glm-5.1')).toEqual({ inputTokens: 4000, estimatedTokens: 8000 });
    await usage(scope, { purpose: 'summary', input: 100, estimated: null, seconds: 3, outcome: 'applied' });
    expect(await readContextAnchor(world.pool, scope.conversationId, 'opencode/glm-5.1')).toBeNull();
    // Uma chamada principal posterior ao checkpoint volta a ancorar.
    await usage(scope, { input: 2000, estimated: 5000, seconds: 4 });
    expect(await readContextAnchor(world.pool, scope.conversationId, 'opencode/glm-5.1')).toEqual({ inputTokens: 2000, estimatedTokens: 5000 });
  });
});

describe('âncora no motor', () => {
  /** Estimativa crua do que o provedor recebeu (a mesma função e o mesmo protocolo do motor). */
  const rawOf = (request: ChatRequest) => estimateChatPayload(request, 'chat_completions').textTokens;
  /** Checkpoint válido (as sete seções) que o modelo do resumo devolve nos testes: sem ele a resposta seria recusada como fora do formato. */
  const CHECKPOINT = SUMMARY_SECTIONS.map((title, index) => `## ${title}\n${index === 0 ? 'Resumo derivado do histórico antigo; ids preservados.' : 'Nada.'}`).join('\n\n');

  /** Resposta longa do bot gravada na rodada já concluída (`runId`), que a mensagem seguinte encontra como histórico de verdade (texto de `chars` caracteres). */
  async function addHistory(world: RunsWorld, conversationId: string, runId: string, step: number, chars: number): Promise<void> {
    await world.pool.query(
      `INSERT INTO messages(conversation_id,run_id,role,kind,status,opens_round,step,content,data,tool_arguments,evidence_provenance,created_at)
       VALUES($1,$2,'assistant','text','done',false,$3,$4,'{}','{}','{"attachments":[],"tables":[]}',now())`,
      [conversationId, runId, step, `Resposta ${step} do histórico. `.padEnd(chars, 'texto do histórico anterior ')],
    );
  }

  it('com chamada anterior do mesmo modelo, a medição gravada parte do usage real mais o acréscimo estimado, e a calibração segue coerente', async () => {
    const world = await createRunsWorld({ contextWindow: WINDOW });
    try {
      const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      const calls: { request: ChatRequest; measured: number }[] = [];
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request): AsyncGenerator<ChatEvent> {
        // A medição já foi gravada quando o provedor é chamado: é o número que o gatilho acabou de usar.
        const stored = await world.pool.query<{ measurement: { inputTokens: number } }>('SELECT measurement FROM conversation_context WHERE conversation_id = $1', [conversationId]);
        calls.push({ request, measured: stored.rows[0]!.measurement.inputTokens });
        yield { type: 'text', text: 'Ok.' };
        // Usage realista: 30% da estimativa crua do pedido, com o cache já incluído na entrada.
        yield { type: 'usage', usage: { inputTokens: Math.round(rawOf(request) * 0.3), outputTokens: 5, cachedTokens: 0 } };
        yield { type: 'done', reason: 'stop' };
      });
      world.engine.start();
      await world.waitForStatus(await world.send(bot, 'Primeira mensagem da conversa.'), 'completed');
      const rows = () => world.pool.query<{ input: string; estimated: string }>("SELECT input_tokens::text AS input, estimated_input_tokens::text AS estimated FROM model_call_usage WHERE purpose = 'main' ORDER BY created_at");
      const [first] = (await rows()).rows;
      // Sem âncora: vale a estimativa calibrada atual, que sem amostra é a crua. E a estimativa gravada é exatamente a crua do pedido que foi medido.
      expect(calls[0]!.measured).toBe(rawOf(calls[0]!.request));
      expect(Number(first!.estimated)).toBe(rawOf(calls[0]!.request));
      expect(Number(first!.input)).toBe(Math.round(rawOf(calls[0]!.request) * 0.3));

      const { scale, calibrated } = await readTokenCalibration(world.pool, 'opencode/glm-5.1');
      expect(calibrated).toBe(true);
      expect(scale).toBeCloseTo(0.36, 2); // razão 0,3 x folga de 20%: a calibração continua lendo input ÷ estimativa crua
      await world.waitForStatus(await world.send(bot, 'Segunda mensagem, com a primeira rodada já no histórico.'), 'completed');
      const second = (await rows()).rows[1]!;
      const expected = Number(first!.input) + Math.ceil((Number(second.estimated) - Number(first!.estimated)) * scale);
      expect(Number(second.estimated)).toBeGreaterThan(Number(first!.estimated));
      // A medição gravada é a âncora: usage real da chamada anterior + o que cresceu, e fica abaixo da estimativa calibrada do pedido inteiro.
      expect(calls[1]!.measured).toBe(expected);
      expect(calls[1]!.measured).toBeLessThan(Math.ceil(Number(second.estimated) * scale));
    } finally { await world.cleanup(); }
  });

  it('o gatilho parte do usage real: usage alto aciona o resumo com o pedido pequeno, usage baixo não, e o checkpoint novo descarta a âncora', async () => {
    const world = await createRunsWorld({ contextWindow: WINDOW });
    try {
      const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      const summaries: ChatRequest[] = [], mains: { request: ChatRequest; measured: number }[] = [];
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request): AsyncGenerator<ChatEvent> {
        if (request.maxTokens === SUMMARY_MAX_OUTPUT_TOKENS) {
          summaries.push(request);
          yield { type: 'text', text: CHECKPOINT };
          yield { type: 'usage', usage: { inputTokens: 50, outputTokens: 20 } };
          yield { type: 'done', reason: 'stop' };
          return;
        }
        const stored = await world.pool.query<{ measurement: { inputTokens: number } }>('SELECT measurement FROM conversation_context WHERE conversation_id = $1', [conversationId]);
        mains.push({ request, measured: stored.rows[0]!.measurement.inputTokens });
        yield { type: 'text', text: 'Ok.' };
        yield { type: 'usage', usage: { inputTokens: Math.round(rawOf(request) * 0.3), outputTokens: 5 } };
        yield { type: 'done', reason: 'stop' };
      });
      world.engine.start();
      const firstRun = await world.send(bot, 'Início da conversa.');
      await world.waitForStatus(firstRun, 'completed');
      // Histórico real de dezenas de KB (14 respostas longas do bot, ~42 KB, como as demais linhas gravadas) antes da segunda mensagem: o resumo só vale a chamada paga quando há o que
      // cobrir (guarda de utilidade, `compactContext`), e um histórico de poucas linhas curtas nunca seria compactado, qualquer que fosse o usage. O volume faz o pedido, pela
      // estimativa crua de 1 token por byte, passar do limiar do orçamento de 64k (42.394 tokens), como a conta abaixo exige.
      for (let step = 2; step <= 15; step += 1) await addHistory(world, conversationId, firstRun, step, 3_000);
      await world.waitForStatus(await world.send(bot, 'Segunda mensagem.'), 'completed');
      expect(summaries).toHaveLength(0);
      expect(mains[1]!.measured).toBeLessThan(0.5 * BUDGET);
      // O pedido completo, pela estimativa crua de 1 token por byte, já passaria do limiar: só o usage real, bem menor, o mantém sem compactação.
      expect(rawOf(mains[1]!.request)).toBeGreaterThan(COMPACTION_THRESHOLD * BUDGET);

      // O provedor passa a informar uma entrada de 90% do orçamento para o mesmo pedido: no limiar do resumo e abaixo de 100%.
      await world.pool.query('UPDATE model_call_usage SET input_tokens = $1', [Math.ceil(0.9 * BUDGET)]);
      const inflated = await readTokenCalibration(world.pool, 'opencode/glm-5.1');
      await world.waitForStatus(await world.send(bot, 'Terceira mensagem.'), 'completed');
      expect(summaries).toHaveLength(1);
      expect((await world.conversations.contextState(bot.id)).measurement!.compaction).toEqual({ elision: false, summary: true, index: false });
      // Com o checkpoint novo a âncora foi descartada: a medição desta chamada é a estimativa calibrada do pedido resumido, não os 90% do usage antigo.
      const resumed = mains[2]!;
      expect(resumed.measured).toBe(estimateChatPayload(resumed.request, 'chat_completions', undefined, inflated.scale).estimatedInputTokens);
      expect(resumed.measured).toBeLessThan(COMPACTION_THRESHOLD * BUDGET);
    } finally { await world.cleanup(); }
  });

  it('trocar o modelo descarta a âncora: o usage alto do modelo anterior não aciona o resumo do modelo novo', async () => {
    const world = await createRunsWorld({ contextWindow: WINDOW });
    try {
      const bot = await world.createBot(); await world.models.test('opencode/glm-5.1'); await world.models.test('opencode/kimi-k2.7-code');
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      let summaries = 0, measured = 0;
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request): AsyncGenerator<ChatEvent> {
        if (request.maxTokens === SUMMARY_MAX_OUTPUT_TOKENS) summaries++;
        else measured = (await world.pool.query<{ measurement: { inputTokens: number } }>('SELECT measurement FROM conversation_context WHERE conversation_id = $1', [conversationId])).rows[0]!.measurement.inputTokens;
        yield { type: 'text', text: 'Resumo ou resposta.' };
        yield { type: 'usage', usage: { inputTokens: 1500, outputTokens: 5 } };
        yield { type: 'done', reason: 'stop' };
      });
      world.engine.start();
      await world.waitForStatus(await world.send(bot, 'Início da conversa.'), 'completed');
      await world.pool.query('UPDATE model_call_usage SET input_tokens = $1', [Math.ceil(0.9 * BUDGET)]);
      await world.conversations.setPreference(bot.id, 'opencode/kimi-k2.7-code', null);
      await world.waitForStatus(await world.send(bot, 'Segunda mensagem, agora no outro modelo.'), 'completed');
      expect(summaries).toBe(0);
      expect(measured).toBeLessThan(0.5 * BUDGET);
    } finally { await world.cleanup(); }
  });
});

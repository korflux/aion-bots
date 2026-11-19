// Relatório de custo (P0 do estudo de custo): as contas em US$ são provadas por valores e a classificação das chamadas pela posição, com o
// PostgreSQL real e linhas do ledger, atividades e aprovações gravadas como o motor as deixa.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createPool, type Pool } from '../db/pool';
import { MIGRATIONS } from '../db/migrations';
import { createRunsWorld, type RunsWorld } from '../runs/test-support';
import { migrateTestDatabase } from '../testing/migrate';
import { createTestDatabase, type TestDatabase } from '../testing/postgres';
import { MODEL_PRICES, listPrice } from '../models/prices';
import { buildCostReport, formatCostReport, readCheckpointSizes, readSkippedCalls, readUsageCalls, type UsageCall } from './cost-report';

const PRICE = { 'opencode/deepseek-v4.1-flash': { input: 0.3, cached: 0.006, output: 1.2 } };

/** Chamada sintética com os campos que as contas usam. */
const call = (over: Partial<UsageCall>): UsageCall => ({
  runId: '1', conversationId: 'c', origin: 'bot', model: 'opencode/deepseek-v4.1-flash', category: 'continuacao',
  inputTokens: 0, cachedTokens: 0, cacheWriteTokens: null, outputTokens: 0, reasoningTokens: null, createdAt: new Date(0), day: '2026-10-16', ...over,
});

describe('buildCostReport (contas)', () => {
  it('separa entrada sem cache, cache e saída, e a perda por falta de cache é o que o cache teria poupado', () => {
    // 40k em cache + 1k sem cache + 300 de saída: 0,00024 + 0,0003 + 0,00036.
    const report = buildCostReport([call({ inputTokens: 41_000, cachedTokens: 40_000, outputTokens: 300 })], PRICE);
    expect(report.total.cachedUsd).toBeCloseTo(0.00024, 10);
    expect(report.total.uncachedUsd).toBeCloseTo(0.0003, 10);
    expect(report.total.outputUsd).toBeCloseTo(0.00036, 10);
    expect(report.total.totalUsd).toBeCloseTo(0.0009, 10);
    expect(report.total.missedCacheUsd).toBeCloseTo((1_000 * 0.294) / 1e6, 10);
  });

  it('cache ausente conta como zero e é sinalizado; cache acima da entrada é limitado a ela', () => {
    const report = buildCostReport([call({ inputTokens: 1_000, cachedTokens: null }), call({ runId: '2', inputTokens: 1_000, cachedTokens: 5_000 })], PRICE);
    expect(report.total.callsWithoutCacheData).toBe(1);
    expect(report.total.cachedTokens).toBe(1_000);
    expect(report.total.uncachedUsd).toBeCloseTo(0.0003, 10);
  });

  it('modelo sem preço deixa o custo do grupo nulo, entra na lista e ordena as execuções por entrada sem cache', () => {
    const report = buildCostReport([call({ model: 'x', runId: 'a', inputTokens: 10 }), call({ model: 'x', runId: 'b', inputTokens: 500 })], PRICE);
    expect(report.total.totalUsd).toBeNull();
    expect(report.modelsWithoutPrice).toEqual(['x']);
    expect(report.topRuns.map((run) => run.runId)).toEqual(['b', 'a']);
    expect(formatCostReport(report, { since: new Date(0), until: new Date(1), timeZone: 'UTC', skippedCalls: 0 })).toContain('sem preço');
  });

  // A23 e A24 (phase 17): a tabela é por `provedor/modelo` e o relatório separa o mesmo Claude por provedor.
  describe('preços por provedor (phase 17)', () => {
    it('A23: o selo segue a tabela da spec (entrada/saída por milhão de tokens) e o modelo sem linha não tem preço', () => {
      expect(listPrice('anthropic/claude-haiku-5-5')).toEqual({ input: 0.1, output: 0.5 });
      expect(listPrice('anthropic/claude-sonnet-5-5')).toEqual({ input: 2, output: 10 });
      expect(listPrice('anthropic/claude-opus-5-5')).toEqual({ input: 4, output: 20 });
      expect(listPrice('opencode/deepseek-v4.1-flash')).toEqual({ input: 0.3, output: 1.2 });
      for (const unknown of ['anthropic/claude-haiku-4-5', 'opencode/glm-5.1', 'claude-haiku-5-5', 'constructor', '__proto__']) expect(listPrice(unknown), unknown).toBeNull();
      // Cache de 5 minutos conferido na skill claude-api: a gravação é 1,25 da entrada em todos; a leitura é 0,1 no Haiku 5.5 (US$ 0,01) e 0,05 no Sonnet 5.5 (US$ 0,10) e no Opus 5.5 (US$ 0,20).
      const reads: [string, number, number][] = [['anthropic/claude-haiku-5-5', 0.1, 0.01], ['anthropic/claude-sonnet-5-5', 0.05, 0.1], ['anthropic/claude-opus-5-5', 0.05, 0.2]];
      for (const [model, multiplier, dollars] of reads) {
        const price = MODEL_PRICES[model]!;
        expect(price.cached, model).toBeCloseTo(dollars, 10);
        expect(price.cached, model).toBeCloseTo(price.input * multiplier, 10);
        expect(price.cacheWrite, model).toBeCloseTo(price.input * 1.25, 10);
      }
    });

    it('A24: o mesmo Claude pelo OpenCode Go e pela Anthropic entra em linhas separadas do relatório, cada uma com o preço do seu provedor', () => {
      const opencode = call({ model: 'opencode/claude-haiku-5-5', inputTokens: 1_000_000, outputTokens: 1_000_000 });
      const anthropic = call({ model: 'anthropic/claude-sonnet-5-5', inputTokens: 1_000_000, outputTokens: 1_000_000 });
      const sameName = call({ model: 'anthropic/claude-haiku-5-5', inputTokens: 1_000_000, outputTokens: 1_000_000 });
      const report = buildCostReport([opencode, anthropic, sameName], MODEL_PRICES);
      expect([...report.byModel.keys()].sort()).toEqual(['anthropic/claude-haiku-5-5', 'anthropic/claude-sonnet-5-5', 'opencode/claude-haiku-5-5']);
      expect(report.modelsWithoutPrice).toEqual([]);
      // Sem o prefixo o relatório não adivinha o provedor: o id antigo nu fica "sem preço" em vez de herdar o de um dos dois.
      expect(buildCostReport([call({ model: 'claude-haiku-5-5', inputTokens: 1_000 })], MODEL_PRICES).modelsWithoutPrice).toEqual(['claude-haiku-5-5']);
    });
  });

  // A11 (phase 12, T3): a gravação de cache (protocolo messages) é uma fatia da entrada separada da leitura e cobrada pelo preço de gravação do modelo.
  describe('gravação de cache', () => {
    const meta = { since: new Date(0), until: new Date(1), timeZone: 'UTC', skippedCalls: 0 };
    const HAIKU = 'opencode/claude-haiku-5-5';

    it('o Haiku 5.5 declara a gravação em 1,25 vez a entrada (escrita de cache de 5 minutos) e DeepSeek e MiMo não declaram gravação à parte', () => {
      const haiku = MODEL_PRICES[HAIKU]!;
      expect(haiku.cacheWrite).toBeCloseTo(haiku.input * 1.25, 10);
      expect(haiku.cached).toBeCloseTo(haiku.input * 0.1, 10);
      expect(MODEL_PRICES['opencode/deepseek-v4.1-flash']!.cacheWrite).toBeUndefined();
      expect(MODEL_PRICES['opencode/mimo-v2.6-pro']!.cacheWrite).toBeUndefined();
    });

    it('divide a entrada em sem cache, leitura e gravação, e cobra cada fatia pelo seu preço', () => {
      // 10.000 de entrada total: 6.000 lidos (0,01), 3.000 gravados (0,125) e 1.000 sem cache (0,1); 500 de saída (0,5).
      const report = buildCostReport([call({ model: HAIKU, inputTokens: 10_000, cachedTokens: 6_000, cacheWriteTokens: 3_000, outputTokens: 500 })], MODEL_PRICES);
      expect(report.total).toMatchObject({ inputTokens: 10_000, cachedTokens: 6_000, cacheWriteTokens: 3_000 });
      expect(report.total.uncachedUsd).toBeCloseTo((1_000 * 0.1) / 1e6, 12);
      expect(report.total.cachedUsd).toBeCloseTo((6_000 * 0.01) / 1e6, 12);
      expect(report.total.cacheWriteUsd).toBeCloseTo((3_000 * 0.125) / 1e6, 12);
      expect(report.total.outputUsd).toBeCloseTo((500 * 0.5) / 1e6, 12);
      expect(report.total.totalUsd).toBeCloseTo((1_000 * 0.1 + 6_000 * 0.01 + 3_000 * 0.125 + 500 * 0.5) / 1e6, 12);
      // A perda é o que o grupo economizaria se tudo que não veio do cache (sem cache e gravado) tivesse sido lido.
      expect(report.total.missedCacheUsd).toBeCloseTo((1_000 * (0.1 - 0.01) + 3_000 * (0.125 - 0.01)) / 1e6, 12);
    });

    it('modelo sem preço de gravação cobra os tokens gravados pelo preço de entrada, e chamada sem dado de gravação não muda as contas de antes', () => {
      const flat = { x: { input: 0.3, cached: 0.006, output: 1.2 } };
      const written = buildCostReport([call({ model: 'x', inputTokens: 1_000, cachedTokens: 0, cacheWriteTokens: 400 })], flat);
      expect(written.total.cacheWriteUsd).toBeCloseTo((400 * 0.3) / 1e6, 12);
      expect(written.total.totalUsd).toBeCloseTo((1_000 * 0.3) / 1e6, 12);
      const silent = buildCostReport([call({ model: 'x', inputTokens: 1_000, cachedTokens: 400, cacheWriteTokens: null })], flat);
      expect(silent.total).toMatchObject({ cacheWriteTokens: 0, cacheWriteUsd: 0 });
      expect(silent.total.uncachedUsd).toBeCloseTo((600 * 0.3) / 1e6, 12);
    });

    it('leitura e gravação nunca passam da entrada (provedor incoerente não gera custo negativo) e modelo sem preço deixa a gravação em US$ nula', () => {
      const incoherent = buildCostReport([call({ model: HAIKU, inputTokens: 1_000, cachedTokens: 900, cacheWriteTokens: 5_000 })], MODEL_PRICES);
      expect(incoherent.total).toMatchObject({ cachedTokens: 900, cacheWriteTokens: 100 });
      expect(incoherent.total.uncachedUsd).toBe(0);
      expect(buildCostReport([call({ model: 'sem-preco', inputTokens: 1_000, cacheWriteTokens: 100 })], {}).total.cacheWriteUsd).toBeNull();
    });

    it('a tabela mostra a coluna de gravação (tokens e US$) e o resumo explica que ela está dentro da entrada', () => {
      // 1.000.000 de entrada: 600.000 lidos (US$ 0,006), 300.000 gravados (US$ 0,0375), 100.000 sem cache (US$ 0,01) e 50.000 de saída (US$ 0,025).
      const text = formatCostReport(buildCostReport([call({ model: HAIKU, inputTokens: 1_000_000, cachedTokens: 600_000, cacheWriteTokens: 300_000, outputTokens: 50_000 })], MODEL_PRICES), meta);
      expect(text).toContain('| Entrada | Cache | Gravação | Saída | Raciocínio | Sem cache | Em cache | Gravação US$ | Saída US$ |');
      expect(text).toContain('| 1.000.000 | 60.0% | 300.000 | 50.000 | sem dado | US$ 0.0100 | US$ 0.0060 | US$ 0.0375 | US$ 0.0250 | US$ 0.0785 |');
      expect(text).toContain('gravação de cache US$ 0.0375');
      expect(text).toContain('já está em "Entrada"');
    });
  });

  // A16 (phase 10, T8): o raciocínio é uma FATIA da saída, que o provedor já cobra por inteiro, então só aparece como tokens: nenhum valor em US$ muda.
  describe('raciocínio dentro da saída', () => {
    const meta = { since: new Date(0), until: new Date(1), timeZone: 'UTC', skippedCalls: 0 };
    const base = [call({ inputTokens: 41_000, cachedTokens: 40_000, outputTokens: 300 }), call({ runId: '2', inputTokens: 1_000, cachedTokens: 0, outputTokens: 700 })];

    it('mostra a fatia e o percentual da saída, e os totais em US$ ficam idênticos aos de um relatório sem o dado', () => {
      const without = buildCostReport(base, PRICE);
      const withReasoning = buildCostReport([{ ...base[0]!, reasoningTokens: 120 }, { ...base[1]!, reasoningTokens: 280 }], PRICE);
      for (const key of ['uncachedUsd', 'cachedUsd', 'outputUsd', 'totalUsd', 'missedCacheUsd'] as const) expect(withReasoning.total[key], key).toBe(without.total[key]);
      expect(withReasoning.total).toMatchObject({ outputTokens: 1_000, reasoningTokens: 400, reportedOutputTokens: 1_000, callsWithoutReasoningData: 0 });
      const text = formatCostReport(withReasoning, meta);
      // A tabela tem a coluna logo depois da saída (a linha de totais do grupo traz "1.000" de saída e "400 (40.0%)" de raciocínio), e o cabeçalho conta zero chamadas sem dado.
      expect(text).toContain('| Saída | Raciocínio | Sem cache |');
      expect(text).toContain('| 1.000 | 400 (40.0%) |');
      expect(text).toContain('Sem dado de raciocínio do provedor: 0.');
      expect(text).toContain('já está em "Saída" e no custo, não soma ao total');
    });

    it('"sem dado" quando nenhuma chamada do grupo informou (nunca 0), inclusive no resumo sem nenhuma chamada', () => {
      const without = buildCostReport(base, PRICE);
      expect(without.total).toMatchObject({ reasoningTokens: 0, reportedOutputTokens: 0, callsWithoutReasoningData: 2 });
      const text = formatCostReport(without, meta);
      expect(text).toContain('| 1.000 | sem dado |');
      expect(text).toContain('Sem dado de raciocínio do provedor: 2.');
      expect(text).toContain('Saída das chamadas de resumo no período: nenhum. A saída inclui o raciocínio; informado pelo provedor nessas chamadas: sem dado.');
    });

    it('grupo misto mostra o valor informado, o percentual só sobre as chamadas que informaram e quantas ficaram sem dado; zero informado é dado', () => {
      const mixed = buildCostReport([call({ outputTokens: 300, reasoningTokens: 100 }), call({ runId: '2', outputTokens: 700, reasoningTokens: null }), call({ runId: '3', outputTokens: 100, reasoningTokens: 0 })], PRICE);
      expect(mixed.total).toMatchObject({ outputTokens: 1_100, reasoningTokens: 100, reportedOutputTokens: 400, callsWithoutReasoningData: 1 });
      expect(formatCostReport(mixed, meta)).toContain('| 1.100 | 100 (25.0%; 1 sem dado) |');
      // Só zeros informados: a saída existe, o raciocínio é 0 de verdade (diferente de "sem dado").
      const zero = formatCostReport(buildCostReport([call({ outputTokens: 50, reasoningTokens: 0 })], PRICE), meta);
      expect(zero).toContain('| 50 | 0 (0.0%) |');
    });

    it('raciocínio acima da saída da própria chamada é limitado a ela (provedor incoerente não gera fatia maior que o todo)', () => {
      const report = buildCostReport([call({ outputTokens: 300, reasoningTokens: 500 })], PRICE);
      expect(report.total.reasoningTokens).toBe(300);
      expect(formatCostReport(report, meta)).toContain('| 300 | 300 (100.0%) |');
    });
  });
});

describe('readUsageCalls (classificação no banco)', () => {
  let world: RunsWorld;
  beforeAll(async () => { world = await createRunsWorld(); });
  afterAll(async () => { await world?.cleanup(); });

  /** Instante sintético: n minutos depois de uma base fixa. */
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 16, 12, 0, 0) + minutes * 60_000);

  /** Linha do ledger como o motor a deixa ao concluir uma chamada. */
  async function usage(conversationId: string, run: string, purpose: 'main' | 'summary', minute: number, input: number | null, cached: number | null = 0, state = 'completed', reasoning: number | null = null, cacheWrite: number | null = null) {
    await world.pool.query(
      'INSERT INTO model_call_usage(id,conversation_id,run_id,purpose,model,protocol,state,input_tokens,output_tokens,cached_tokens,created_at,completed_at,reasoning_tokens,cache_write_tokens) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13)',
      [randomUUID(), conversationId, run, purpose, 'opencode/deepseek-v4.1-flash', 'chat_completions', state, input, input === null ? null : 10, cached, at(minute), reasoning, cacheWrite],
    );
  }

  /** Atividade concluída de uma ferramenta, gravada entre duas chamadas. */
  async function activity(conversationId: string, run: string, tool: string, minute: number): Promise<string> {
    return (await world.pool.query<{ id: string }>(
      "INSERT INTO messages(conversation_id,run_id,role,kind,status,step,data,created_at) VALUES($1,$2,'assistant','activity','completed',1,$3,$4) RETURNING id::text",
      [conversationId, run, JSON.stringify({ callId: randomUUID(), tool, label: tool }), at(minute)],
    )).rows[0]!.id;
  }

  it('classifica abertura fria e quente, discover_tools, aprovação, compactação, continuação e resumo; ignora chamadas sem uso', async () => {
    const bot = await world.createBot();
    const conversationId = await world.conversations.conversationIdOf(bot.id);
    const first = await world.send(bot, 'primeira');
    // Execução 1: abertura (sem chamada anterior na conversa), etapa após discover_tools, etapa após aprovação, resumo, etapa após o resumo, continuação.
    await usage(conversationId, first, 'main', 0, 20_000, 0);
    await activity(conversationId, first, 'discover_tools', 1);
    await usage(conversationId, first, 'main', 2, 21_000, 1_000);
    const approved = await activity(conversationId, first, 'composio_execute_action', 3);
    await world.pool.query("INSERT INTO approval_actions(slug,app_slug,app_name,label,first_seen_at,last_seen_at) VALUES('X_SEND','x','X','Enviar',$1,$1) ON CONFLICT DO NOTHING", [at(3)]);
    await world.pool.query(
      "INSERT INTO approvals(run_id,bot_id,conversation_id,action_slug,step,activity_id,call,status,decision,created_at,expires_at,decided_at) VALUES($1,$2,$3,'X_SEND',2,$4,'{}','approved','allow_once',$5,$6,$7)",
      [first, bot.id, conversationId, approved, at(3), at(60), at(4)],
    );
    await usage(conversationId, first, 'main', 5, 22_000, 18_000, 'completed', null, 700);
    await usage(conversationId, first, 'summary', 6, 30_000, 0, 'completed', 4);
    await usage(conversationId, first, 'main', 7, 9_000, 0);
    await usage(conversationId, first, 'main', 8, 9_500, 9_000);
    await usage(conversationId, first, 'main', 9, null, null, 'unknown');
    // Execução 2: abre 10 minutos depois da última chamada da conversa, então é abertura com a conversa ativa.
    await world.pool.query("UPDATE runs SET status='completed' WHERE id=$1", [first]);
    const second = await world.send(bot, 'segunda');
    await usage(conversationId, second, 'main', 19, 10_000, 9_000, 'completed', 6);

    const calls = await readUsageCalls(world.pool, { since: at(-1), until: at(30), timeZone: 'America/Sao_Paulo' });
    expect(calls.map((row) => [row.runId, row.category])).toEqual([
      [first, 'abertura_fria'], [first, 'apos_discover_tools'], [first, 'apos_aprovacao'], [first, 'resumo'], [first, 'apos_compactacao'], [first, 'continuacao'],
      [second, 'abertura_quente'],
    ]);
    expect(calls.every((row) => row.origin === 'bot' && row.day === '2026-10-16')).toBe(true);
    // O raciocínio vem da coluna `reasoning_tokens` (migration 0045): número quando o motor o gravou, nulo (e não 0) quando o provedor não informou.
    expect(calls.map((row) => row.reasoningTokens)).toEqual([null, null, null, 4, null, null, 6]);
    // A gravação de cache vem da coluna `cache_write_tokens` (migration 0049): número quando o motor a gravou, nulo (e não 0) quando o provedor não informou.
    expect(calls.map((row) => row.cacheWriteTokens)).toEqual([null, null, 700, null, null, null, null]);
    expect(await readSkippedCalls(world.pool, { since: at(-1), until: at(30) })).toBe(1);
    // Tamanho da compactação: só o comprimento do checkpoint sai do banco, e a seção junta a saída dos resumos do período.
    await world.pool.query("INSERT INTO conversation_context(conversation_id,coverage_start,summary) VALUES($1,0,$2) ON CONFLICT (conversation_id) DO UPDATE SET summary=EXCLUDED.summary", [conversationId, 'x'.repeat(12_345)]);
    expect(await readCheckpointSizes(world.pool)).toEqual([12_345]);
    const text = formatCostReport(buildCostReport(calls, PRICE), { since: at(-1), until: at(30), timeZone: 'UTC', skippedCalls: 1, calls, checkpointChars: [12_345] });
    // A16: o texto antigo "(inclui raciocínio)" só afirmava a inclusão; agora a seção diz que a saída inclui o raciocínio e quanto dele o provedor informou (4 dos 10 tokens do único resumo).
    expect(text).toContain('Saída das chamadas de resumo no período: média 10, mediana 10, máximo 10 tokens. A saída inclui o raciocínio; informado pelo provedor nessas chamadas: 4 (40.0%).');
    expect(text).toContain('Checkpoints vigentes (1): média 12.345, mediana 12.345, máximo 12.345 caracteres');
    // O alvo de 4.000 a 6.000 vale já na primeira tentativa do resumo (phase 11, T6), não só no lembrete da segunda: o relatório cita as mesmas constantes do prompt.
    expect(text).toContain('Teto do produto: 16.000 caracteres; alvo no prompt do resumo, já na primeira tentativa: 4.000 a 6.000.');
    expect(text).not.toContain('lembrete');
    // O período filtra, mas a classificação enxerga a chamada anterior fora dele.
    expect((await readUsageCalls(world.pool, { since: at(18), until: at(30), timeZone: 'UTC' })).map((row) => row.category)).toEqual(['abertura_quente']);
  });

  // A23 (phase 15, passo 13): a etapa que vem logo depois de o bot abrir um galho ou uma folha por `abrir_grupo` é uma categoria própria, ao lado da de `discover_tools` (a porta que o
  // Chat geral mantém), para a fração de cache dessa etapa aparecer no relatório; as demais etapas do laço continuam sendo continuação.
  it('classifica a etapa seguinte a abrir_grupo como apos_abrir_grupo, sem confundi-la com discover_tools nem com a continuação, e a tabela mostra a fração de cache dela', async () => {
    const bot = await world.createBot();
    const conversationId = await world.conversations.conversationIdOf(bot.id);
    const run = await world.send(bot, 'abrir');
    await usage(conversationId, run, 'main', 0, 20_000, 0);
    await activity(conversationId, run, 'abrir_grupo', 1);
    await usage(conversationId, run, 'main', 2, 21_000, 20_480);
    await usage(conversationId, run, 'main', 3, 21_500, 21_000);
    await activity(conversationId, run, 'discover_tools', 4);
    await usage(conversationId, run, 'main', 5, 22_000, 21_504);

    const calls = (await readUsageCalls(world.pool, { since: at(-1), until: at(30), timeZone: 'UTC' })).filter((row) => row.runId === run);
    expect(calls.map((row) => row.category)).toEqual(['abertura_fria', 'apos_abrir_grupo', 'continuacao', 'apos_discover_tools']);
    const report = buildCostReport(calls, PRICE);
    expect(report.byCategory.get('apos_abrir_grupo')).toMatchObject({ calls: 1, inputTokens: 21_000, cachedTokens: 20_480 });
    // 20.480 de 21.000 lidos do cache: 97,5% (a abertura fria, com 0 de cache, não entra nessa conta).
    expect(formatCostReport(report, { since: at(-1), until: at(30), timeZone: 'UTC', skippedCalls: 0 })).toContain('| Após abrir_grupo | 1 | 21.000 | 97.5% |');
  });
});

// A14 (phase 17): o relatório de custo do mesmo período soma igual antes e depois da migration 0055. O banco é o de produção antes dela (ids locais em `model_call_usage.model`, preços
// pela tabela de antes, chaveada pelo id local); depois da migration os mesmos ids viram `opencode/...` e os preços de `MODEL_PRICES` (chaveados pelo id do produto) dão
// exatamente os mesmos totais, sem nenhum modelo "sem preço".
describe('A14: o relatório de custo não muda com a migration 0055', () => {
  /** A tabela de preços de ANTES da phase 17: a mesma de hoje, chaveada pelo id local do OpenCode Go. */
  const LEGACY_PRICES = {
    'deepseek-v4.1-flash': { input: 0.3, cached: 0.006, output: 1.2 },
    'mimo-v2.6-pro': { input: 0.435, cached: 0.003625, output: 0.87 },
    'claude-haiku-5-5': { input: 0.1, cached: 0.01, output: 0.5, cacheWrite: 0.125 },
  };
  const databases: TestDatabase[] = [];
  const pools: Pool[] = [];
  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
    await Promise.all(databases.map((database) => database.drop()));
  });

  it('A14: soma igual antes e depois, com os três modelos reais do catálogo e as chamadas de resumo', async () => {
    const database = await createTestDatabase(inject('adminDatabaseUrl'));
    databases.push(database);
    const pool = createPool(database.url, { applicationName: 'cost-report-0055-test', max: 4 });
    pools.push(pool);
    const migration = MIGRATIONS.find((candidate) => candidate.id === '0055_provider_model_ids')!;
    await migrateTestDatabase(pool, { migrations: MIGRATIONS.filter((candidate) => candidate.id < migration.id) });
    // Produção antes da 0055: uma execução por modelo, com chamada principal e uma de resumo, com e sem gravação de cache.
    const rows: [string, string, number, number, number | null, number][] = [
      ['deepseek-v4.1-flash', 'main', 40_000, 30_000, null, 900], ['deepseek-v4.1-flash', 'summary', 12_000, 0, null, 400],
      ['mimo-v2.6-pro', 'main', 20_000, 5_000, null, 300], ['claude-haiku-5-5', 'main', 10_000, 6_000, 3_000, 500],
    ];
    let hour = 0;
    for (const [model, purpose, input, cached, cacheWrite, output] of rows) {
      const conversation = (await pool.query<{ id: string }>('INSERT INTO conversations (created_at) VALUES (now()) RETURNING id')).rows[0]!.id;
      const run = (await pool.query<{ id: string }>("INSERT INTO runs (conversation_id, input, created_at, status) VALUES ($1, 'pedido', now(), 'completed') RETURNING id", [conversation])).rows[0]!.id;
      hour += 1;
      await pool.query(
        "INSERT INTO model_call_usage (id, conversation_id, run_id, purpose, model, protocol, state, input_tokens, cached_tokens, cache_write_tokens, output_tokens, created_at, completed_at) VALUES ($1, $2, $3, $4, $5, 'chat_completions', 'completed', $6, $7, $8, $9, $10, $10)",
        [randomUUID(), conversation, run, purpose, model, input, cached, cacheWrite, output, new Date(Date.UTC(2026, 9, 20, hour))]);
    }
    const period = { since: new Date(Date.UTC(2026, 9, 1)), until: new Date(Date.UTC(2026, 10, 1)), timeZone: 'UTC' };
    const totals = (report: ReturnType<typeof buildCostReport>) => ({ ...report.total, models: report.modelsWithoutPrice });

    const before = buildCostReport(await readUsageCalls(pool, period), LEGACY_PRICES);
    expect(before.modelsWithoutPrice).toEqual([]);
    expect(before.total.totalUsd).toBeGreaterThan(0);

    await migrateTestDatabase(pool, { migrations: MIGRATIONS.filter((candidate) => candidate.id <= migration.id) });
    const afterCalls = await readUsageCalls(pool, period);
    expect(afterCalls.map((entry) => entry.model).sort()).toEqual(['opencode/claude-haiku-5-5', 'opencode/deepseek-v4.1-flash', 'opencode/deepseek-v4.1-flash', 'opencode/mimo-v2.6-pro']);
    const after = buildCostReport(afterCalls, MODEL_PRICES);
    expect(after.modelsWithoutPrice).toEqual([]);
    expect(totals(after)).toEqual(totals(before));
  });
});

// Prova da sonda `validate:cache` (phase 10, T2) sem chamar o provedor real: a lógica da sonda roda em processo contra um provedor roteirizado que simula o cache por
// prefixo (`createPrefixCacheProvider`), e a CLI roda como processo contra o falso compartilhado (`@aion/core/testing`, que informa 80% de cache fixo e por isso precisa
// REPROVAR o gate de 90%). A medição real com o `deepseek-v4.1-flash` é a segunda metade da prova e roda à parte, com a chave do dono em `.env.provider`
// (`node --env-file=.env.provider --import tsx tests/support/validate-prompt-cache.ts`); este teste nunca lê esse arquivo.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ChatRejected, TEST_TOOL, type ChatRequest, type ChatUsage, type ProviderClient } from '@aion/core';
import { startFakeUpstreams } from '@aion/core/testing';
import { describe, expect, it } from 'vitest';
import { createPrefixCacheProvider, parseProbeModel, runCacheProbe, type CacheReport, type ProbeModel } from './support/validate-prompt-cache';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const KEY = 'valid-cache-chave-XYZ9';
/** Texto da conversa que a sonda nunca pode deixar chegar à saída. */
const FORBIDDEN = ['Sonda de cache', 'Nota sintética', 'Responda'];

/**
 * Embrulha o provedor e guarda uma cópia de cada pedido recebido (a sonda reaproveita os objetos). `before` roda antes de responder (lança para simular recusa) e `mutate`
 * reescreve o uso que o provedor informaria, para provar o gate sem depender do cache real.
 */
function observe(inner: ProviderClient, hooks: { before?: (request: ChatRequest) => void; mutate?: (request: ChatRequest, usage: ChatUsage, call: number) => ChatUsage } = {}): { provider: ProviderClient; requests: ChatRequest[]; protocols: string[] } {
  const requests: ChatRequest[] = [];
  const protocols: string[] = [];
  const provider: ProviderClient = {
    listModels: (apiKey) => inner.listModels(apiKey),
    async *streamChat(apiKey, protocol, request, signal) {
      requests.push(structuredClone(request));
      protocols.push(protocol);
      hooks.before?.(request);
      const call = requests.length;
      for await (const event of inner.streamChat(apiKey, protocol, request, signal)) yield event.type === 'usage' && hooks.mutate ? { type: 'usage', usage: hooks.mutate(request, event.usage, call) } : event;
    },
  };
  return { provider, requests, protocols };
}

/** Roda a sonda em processo e devolve o relatório, as linhas emitidas, os pedidos que o provedor recebeu e o protocolo de cada um. */
async function probe(hooks?: Parameters<typeof observe>[1], model?: ProbeModel): Promise<{ report: CacheReport; lines: Record<string, unknown>[]; requests: ChatRequest[]; protocols: string[] }> {
  const { provider, requests, protocols } = observe(createPrefixCacheProvider(), hooks);
  const lines: Record<string, unknown>[] = [];
  const report = await runCacheProbe({ provider, apiKey: KEY, emit: (line) => lines.push(line), ...(model ? { model } : {}) });
  return { report, lines, requests, protocols };
}

/** Toda linha de saída é só identificador ou número: nenhum texto livre (espaços, frases) passa por este formato. */
function expectOnlyIdsAndNumbers(lines: Record<string, unknown>[]): void {
  const walk = (value: unknown, path: string): void => {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return;
    if (typeof value === 'string') { expect(value, path).toMatch(/^[A-Za-z0-9_.:-]{1,64}$/); return; }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) walk(item, `${path}.${key}`);
  };
  lines.forEach((line, index) => walk(line, `linha ${index}`));
}

/** Os textos dos turnos do usuário que abrem rodada: começam pelo bloco `# Dados`. */
const openings = (request: ChatRequest): string[] => request.turns.flatMap((turn) => (turn.role === 'user' && turn.text.startsWith('# Dados\n') ? [turn.text] : []));

describe('sonda de cache (lógica, provedor roteirizado)', () => {
  it('monta cada pedido como extensão exata do anterior e mede as quatro etapas com 6 chamadas', async () => {
    const { report, lines, requests } = await probe();
    expect(report.passed).toBe(true);
    expect(report.providerCalls).toBe(6);
    expect(requests).toHaveLength(6);
    expect(report.measurements.map((entry) => [entry.name, entry.required, entry.execution, entry.step, entry.effort, entry.measured, entry.passed])).toEqual([
      ['next_round', true, 2, 1, 'default', true, true],
      ['resume', true, 2, 2, 'default', true, true],
      ['effort_change', false, 3, 1, 'low', true, true],
      ['effort_steady', false, 3, 2, 'low', true, true],
    ]);
    // A definição de C1 e C4: cache da etapa contra a ENTRADA do pedido anterior (não contra a própria entrada).
    const call = lines.filter((line) => line.event === 'call');
    const measured = lines.filter((line) => line.event === 'measurement');
    // Chamadas na ordem: (1,1), (1,2), (2,1), (2,2), (3,1), (3,2); cada medição compara a etapa com a chamada imediatamente anterior.
    expect(measured.map((line) => [line.previousInputTokens, line.cachedTokens])).toEqual([[call[1]!.inputTokens, call[2]!.cachedTokens], [call[2]!.inputTokens, call[3]!.cachedTokens], [call[3]!.inputTokens, call[4]!.cachedTokens], [call[4]!.inputTokens, call[5]!.cachedTokens]]);
    expect(measured.map((line) => line.cachedOfPrevious)).toEqual(measured.map((line) => (line.cachedTokens as number) / (line.previousInputTokens as number)));
    expect(measured.every((line) => (line.cachedOfPrevious as number) >= 0.9)).toBe(true);
    expect([report.effortKeptCache, report.effortSteadyKeptCache]).toEqual([true, true]);
    expect(lines.map((line) => line.event)).toEqual(['call', 'call', 'call', 'measurement', 'call', 'measurement', 'call', 'measurement', 'call', 'measurement', 'result']);

    // Pedido anterior = começo exato do seguinte: ferramentas, sistema e todos os turnos, inclusive o bloco `# Dados` de cada rodada que já passou (reenviado byte a byte).
    for (let index = 1; index < requests.length; index += 1) {
      expect(requests[index]!.tools).toEqual(requests[index - 1]!.tools);
      expect(requests[index]!.turns.slice(0, requests[index - 1]!.turns.length), `pedido ${index + 1}`).toEqual(requests[index - 1]!.turns);
    }
    // Cada execução tem o seu bloco (a hora anda uma hora por rodada), e a retomada (pedido 4, outra posse com relógio mais tarde) não reescreve o da execução 2.
    const [round1, round2] = openings(requests[2]!);
    expect(round1).toMatch(/^# Dados\n- Modelo desta resposta: deepseek-v4\.1-flash\n- Agora: .+\n- Fuso: America\/Sao_Paulo \(GMT-03:00\)\n\n# Mensagem\n/);
    expect(round2).not.toBe(round1);
    expect(openings(requests[0]!)).toEqual([round1]);
    expect(openings(requests[3]!)).toEqual([round1, round2]);
    expect(openings(requests[4]!).slice(0, 2)).toEqual([round1, round2]);
    expect(openings(requests[4]!)).toHaveLength(3);
    expect(openings(requests[5]!)).toEqual(openings(requests[4]!));
    // Sistema idêntico em todos os pedidos (remontado a cada preparação, como a cada posse), uma só conversa, só o modelo da restrição do dono, e effort só na rodada de C4 (etapas 1 e 2 dela).
    expect(new Set(requests.map((request) => JSON.stringify(request.turns[0]))).size).toBe(1);
    expect(new Set(requests.map((request) => request.sessionId))).toEqual(new Set([report.conversationId]));
    expect(new Set(requests.map((request) => request.model))).toEqual(new Set(['deepseek-v4.1-flash']));
    expect(requests.every((request) => request.tools?.map((tool) => tool.name).join() === TEST_TOOL.name)).toBe(true);
    expect(requests.map((request) => request.effort)).toEqual([undefined, undefined, undefined, undefined, 'low', 'low']);

    expectOnlyIdsAndNumbers(lines);
    const text = JSON.stringify(lines);
    for (const forbidden of [KEY, ...FORBIDDEN]) expect(text).not.toContain(forbidden);
  });

  it('reprova quando uma medição exigida (C1) fica abaixo de 90%, ou quando o provedor não informa o cache', async () => {
    // Pedido 3 = primeira etapa da rodada 2; pedido 4 = retomada.
    for (const [lost, name] of [[3, 'next_round'], [4, 'resume']] as const) {
      const { report } = await probe({ mutate: (_request, usage, call) => (call === lost ? { ...usage, cachedTokens: 0 } : usage) });
      expect(report.passed, name).toBe(false);
      expect(report.measurements.filter((entry) => !entry.passed).map((entry) => entry.name)).toEqual([name]);
    }
    const silent = await probe({ mutate: (_request, usage, call) => (call === 4 ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : usage) });
    expect(silent.report.passed).toBe(false);
    expect(silent.report.measurements[1]).toMatchObject({ name: 'resume', measured: false, cachedOfPrevious: null, passed: false });
  });

  it('só reporta o cache da troca de effort (C4): perdê-lo ou ter o nível recusado não reprova a sonda', async () => {
    // O effort novo só perde o cache na troca (cache frio nele): o controle seguinte volta a ler do cache.
    const cold = await probe({ mutate: (_request, usage, call) => (call === 5 ? { ...usage, cachedTokens: 0 } : usage) });
    expect(cold.report.passed).toBe(true);
    expect([cold.report.effortKeptCache, cold.report.effortSteadyKeptCache]).toEqual([false, true]);
    expect(cold.report.measurements[2]).toMatchObject({ name: 'effort_change', required: false, measured: true, cachedTokens: 0, cachedOfPrevious: 0, passed: false });
    expect(cold.report.measurements[3]).toMatchObject({ name: 'effort_steady', required: false, measured: true, passed: true });
    // O effort novo impede o cache em toda etapa: as duas medições de C4 ficam abaixo de 90% e a sonda continua passando.
    const never = await probe({ mutate: (request, usage) => (request.effort ? { ...usage, cachedTokens: 0 } : usage) });
    expect(never.report.passed).toBe(true);
    expect([never.report.effortKeptCache, never.report.effortSteadyKeptCache]).toEqual([false, false]);

    const rejected = await probe({ before: (request) => { if (request.effort) throw new ChatRejected(400); } });
    expect(rejected.report.passed).toBe(true);
    expect(rejected.report.effortKeptCache).toBeNull();
    expect(rejected.report.providerCalls).toBe(5); // a tentativa recusada conta, e sem effort aceito não há controle
    expect(rejected.report.effortSteadyKeptCache).toBeNull();
    expect(rejected.report.measurements).toHaveLength(3);
    expect(rejected.report.measurements[2]).toMatchObject({ name: 'effort_change', measured: false, status: 400, previousInputTokens: expect.any(Number), cachedOfPrevious: null, passed: false });
    expectOnlyIdsAndNumbers(rejected.lines);

    // Qualquer outra falha (rede, chave) não é resultado de C4: a sonda a propaga para a borda da CLI.
    await expect(probe({ before: () => { throw new Error('queda de rede'); } })).rejects.toThrow('queda de rede');
  });
});

// Modo `--model claude-haiku-5-5` (phase 12, T3, C3): o protocolo messages, em que o cache é explícito. No máximo 3 chamadas e saída só com números (entrada, leitura e gravação); o repasse do
// `cache_control` pelo gateway é só reportado (não repassar não reprova). A chamada real é à parte (um comando único, autorizado pelo dono); aqui roda contra o provedor roteirizado.
describe('sonda de cache no protocolo messages (claude-haiku-5-5, provedor roteirizado)', () => {
  const MODEL = 'claude-haiku-5-5';

  it('faz 3 chamadas pelo messages, cada pedido estende o anterior, e reporta entrada, leitura e gravação só com números', async () => {
    const { report, lines, requests, protocols } = await probe(undefined, MODEL);
    expect(report).toMatchObject({ model: MODEL, providerCalls: 3, passed: true, cacheControlForwarded: true, effortKeptCache: null, effortSteadyKeptCache: null });
    expect(requests).toHaveLength(3);
    expect(protocols).toEqual(['messages', 'messages', 'messages']);
    expect(new Set(requests.map((request) => request.model))).toEqual(new Set([MODEL]));
    expect(requests.every((request) => request.effort === undefined && request.tools?.map((tool) => tool.name).join() === TEST_TOOL.name)).toBe(true);
    // Cada pedido é extensão exata do anterior (é o que o cache explícito exige para ler o que o anterior gravou): ferramentas, sistema e turnos.
    for (let index = 1; index < requests.length; index += 1) {
      expect(requests[index]!.tools).toEqual(requests[index - 1]!.tools);
      expect(requests[index]!.turns.slice(0, requests[index - 1]!.turns.length), `pedido ${index + 1}`).toEqual(requests[index - 1]!.turns);
    }
    expect(lines.map((line) => line.event)).toEqual(['call', 'call', 'measurement', 'call', 'measurement', 'result']);
    const calls = lines.filter((line) => line.event === 'call') as { inputTokens: number; cachedTokens: number; cacheWriteTokens: number; protocol: string; model: string }[];
    // O pedido da sonda passa do piso de cache do Haiku (4.096 tokens): sem isso a primeira chamada não gravaria nada e o resultado seria ambíguo.
    expect(calls[0]).toMatchObject({ cachedTokens: 0, protocol: 'messages', model: MODEL });
    expect(calls[0]!.cacheWriteTokens).toBe(calls[0]!.inputTokens);
    expect(calls[0]!.inputTokens).toBeGreaterThanOrEqual(4_096);
    // A 2ª e a 3ª leem o pedido anterior inteiro e gravam só o que é novo; leitura e gravação nunca passam da entrada total.
    for (const index of [1, 2]) {
      expect(calls[index]!.cachedTokens / calls[index - 1]!.inputTokens, `chamada ${index + 1}`).toBeGreaterThanOrEqual(0.9);
      expect(calls[index]!.cachedTokens + calls[index]!.cacheWriteTokens).toBeLessThanOrEqual(calls[index]!.inputTokens);
    }
    const measured = lines.filter((line) => line.event === 'measurement');
    expect(measured.map((line) => [line.name, line.required, line.measured, line.passed, line.previousInputTokens, line.cachedTokens, line.cacheWriteTokens])).toEqual([
      ['same_round', false, true, true, calls[0]!.inputTokens, calls[1]!.cachedTokens, calls[1]!.cacheWriteTokens],
      ['next_round', false, true, true, calls[1]!.inputTokens, calls[2]!.cachedTokens, calls[2]!.cacheWriteTokens],
    ]);
    expect(lines.at(-1)).toEqual({ event: 'result', conversationId: report.conversationId, model: MODEL, minCachedFraction: 0.9, providerCalls: 3, passed: true, cacheControlForwarded: true });
    expectOnlyIdsAndNumbers(lines);
    const text = JSON.stringify(lines);
    for (const forbidden of [KEY, ...FORBIDDEN]) expect(text).not.toContain(forbidden);
  });

  it('repasse reportado, nunca exigido: sem cache nenhum o resultado diz que não repassou e a sonda não reprova; basta uma leitura ou uma gravação para dizer que repassou', async () => {
    const silent = await probe({ mutate: (_request, usage) => ({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }) }, MODEL);
    expect(silent.report).toMatchObject({ passed: true, cacheControlForwarded: false, providerCalls: 3 });
    expect(silent.report.measurements.map((entry) => [entry.name, entry.measured, entry.passed])).toEqual([['same_round', false, false], ['next_round', false, false]]);
    expect(silent.lines.at(-1)).toMatchObject({ event: 'result', passed: true, cacheControlForwarded: false });
    expectOnlyIdsAndNumbers(silent.lines);
    // Só a gravação da primeira chamada (o gateway grava mas ainda não leu) já mostra que a marcação chegou.
    const writeOnly = await probe({ mutate: (_request, usage, call) => (call === 1 ? usage : { inputTokens: usage.inputTokens, cachedTokens: 0, outputTokens: usage.outputTokens }) }, MODEL);
    expect(writeOnly.report.cacheControlForwarded).toBe(true);
    // Só a leitura da terceira chamada também.
    const readOnly = await probe({ mutate: (_request, usage, call) => ({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, ...(call === 3 ? { cachedTokens: 1 } : {}) }) }, MODEL);
    expect(readOnly.report.cacheControlForwarded).toBe(true);
  });

  it('uma recusa do provedor na primeira chamada não vira resultado: a sonda para ali, com uma única chamada feita', async () => {
    const calls: ChatRequest[] = [];
    await expect(probe({ before: (request) => { calls.push(request); throw new ChatRejected(400); } }, MODEL)).rejects.toBeInstanceOf(ChatRejected);
    expect(calls).toHaveLength(1);
  });

  it('o modelo padrão continua o deepseek (6 chamadas pelo chat_completions), sem o campo de repasse', async () => {
    const { report, lines, protocols } = await probe();
    expect(report).toMatchObject({ model: 'deepseek-v4.1-flash', providerCalls: 6, cacheControlForwarded: null });
    expect(new Set(protocols)).toEqual(new Set(['chat_completions']));
    expect(lines.at(-1)).not.toHaveProperty('cacheControlForwarded');
    expect(lines.filter((line) => line.event === 'call').every((line) => !('cacheWriteTokens' in line))).toBe(true);
  });
});

describe('modelos aceitos pela CLI da sonda', () => {
  it('só os dois da lista passam, sem a opção vale o deepseek, e qualquer outro valor ou opção é recusado (nunca o mimo-v2.6-pro)', () => {
    expect(parseProbeModel([])).toBe('deepseek-v4.1-flash');
    expect(parseProbeModel(['--model', 'deepseek-v4.1-flash'])).toBe('deepseek-v4.1-flash');
    expect(parseProbeModel(['--model', 'claude-haiku-5-5'])).toBe('claude-haiku-5-5');
    expect(parseProbeModel(['--model=claude-haiku-5-5'])).toBe('claude-haiku-5-5');
    for (const argv of [['--model', 'mimo-v2.6-pro'], ['--model', 'glm-5.1'], ['--model', ''], ['--model', 'CLAUDE-HAIKU-5-5'], ['--model', '__proto__'], ['--model', 'toString'], ['--model'], ['--modelo', 'claude-haiku-5-5'], ['claude-haiku-5-5'], ['--model', 'claude-haiku-5-5', '--extra']]) {
      expect(() => parseProbeModel(argv), argv.join(' ')).toThrow('PROVIDER_CACHE_INVALID_ARGUMENT');
    }
  });
});

describe('CLI da sonda', () => {
  /** Executa a CLI como processo, com a chave só no ambiente do processo (nunca de `.env.provider`: sem `--env-file`). */
  const run = (env: Record<string, string | undefined>, args: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> => new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', 'tests/support/validate-prompt-cache.ts', ...args], {
      cwd: ROOT, timeout: 60_000,
      env: { ...process.env, AION_VALIDATE_PROVIDER_KEY: undefined, AION_OPENCODE_GO_BASE_URL: undefined, ...env },
    }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }));
  });

  it('falha sem chave e com chave em branco antes de chamar o provedor, com código estável e sem segredo', async () => {
    const upstreams = await startFakeUpstreams();
    try {
      for (const apiKey of [undefined, '   ']) {
        const result = await run({ AION_VALIDATE_PROVIDER_KEY: apiKey, AION_OPENCODE_GO_BASE_URL: upstreams.opencodeGoBaseUrl });
        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(JSON.parse(result.stderr)).toEqual({ code: 'PROVIDER_CACHE_VALIDATION_FAILED', message: expect.any(String), exitCode: 1 });
      }
      expect(upstreams.requests).toHaveLength(0);
    } finally { await upstreams.stop(); }
  });

  it('recusa --model fora da lista antes de qualquer chamada ao provedor, com código estável (o mimo-v2.6-pro nunca é chamado)', async () => {
    const upstreams = await startFakeUpstreams();
    try {
      for (const args of [['--model', 'mimo-v2.6-pro'], ['--model', 'qualquer'], ['--desconhecida']]) {
        const result = await run({ AION_VALIDATE_PROVIDER_KEY: KEY, AION_OPENCODE_GO_BASE_URL: upstreams.opencodeGoBaseUrl }, args);
        expect(result.code, args.join(' ')).toBe(1);
        expect(result.stdout).toBe('');
        expect(JSON.parse(result.stderr)).toEqual({ code: 'PROVIDER_CACHE_INVALID_ARGUMENT', message: expect.any(String), exitCode: 1 });
        expect(result.stderr).not.toContain(KEY);
      }
      expect(upstreams.requests).toHaveLength(0);
    } finally { await upstreams.stop(); }
  });

  it('com --model claude-haiku-5-5 o cliente HTTP real manda ao /messages o pedido com as três marcas de cache, e a recusa do provedor sai só como status', async () => {
    const upstreams = await startFakeUpstreams();
    try {
      // O provedor falso não serve o Haiku (404 em todos os endpoints): a primeira chamada é recusada e a sonda para, com uma única chamada, sem vazar corpo nem chave.
      const result = await run({ AION_VALIDATE_PROVIDER_KEY: KEY, AION_OPENCODE_GO_BASE_URL: upstreams.opencodeGoBaseUrl }, ['--model', 'claude-haiku-5-5']);
      expect(result.code, result.stderr).toBe(1);
      expect(JSON.parse(result.stderr)).toEqual({ code: 'PROVIDER_CACHE_VALIDATION_FAILED', message: expect.any(String), exitCode: 1, status: 404 });
      expect(result.stdout).toBe('');
      expect(result.stdout + result.stderr).not.toContain(KEY);
      expect(upstreams.requests).toHaveLength(1);
      const sent = upstreams.requests[0]!;
      expect(sent).toMatchObject({ model: 'claude-haiku-5-5', key: KEY });
      const body = sent.body as { system: unknown[]; tools: Record<string, unknown>[]; messages: { content: Record<string, unknown>[] }[] };
      const mark = { type: 'ephemeral' };
      expect(body.system).toEqual([{ type: 'text', text: expect.any(String), cache_control: mark }]);
      expect(body.tools.map((tool) => 'cache_control' in tool)).toEqual([true]);
      expect(body.messages.at(-1)!.content.at(-1)).toMatchObject({ cache_control: mark });
      expect(JSON.stringify(body).split('cache_control').length - 1).toBe(3);
    } finally { await upstreams.stop(); }
  });

  it('com o cliente HTTP real contra o provedor falso (80% de cache fixo) faz 6 chamadas, reporta as quatro medições e reprova o gate de 90% sem vazar chave nem conversa', async () => {
    const upstreams = await startFakeUpstreams();
    try {
      const result = await run({ AION_VALIDATE_PROVIDER_KEY: KEY, AION_OPENCODE_GO_BASE_URL: upstreams.opencodeGoBaseUrl });
      expect(result.code, result.stderr).toBe(1);
      expect(JSON.parse(result.stderr)).toEqual({ code: 'PROVIDER_CACHE_BELOW_THRESHOLD', message: expect.any(String), exitCode: 1 });
      const lines = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines.map((line) => line.event)).toEqual(['call', 'call', 'call', 'measurement', 'call', 'measurement', 'call', 'measurement', 'call', 'measurement', 'result']);
      expect(lines.filter((line) => line.event === 'call').every((line) => line.cachedTokens === 80 && line.inputTokens === 100 && line.cachedFraction === 0.8)).toBe(true);
      expect(lines.filter((line) => line.event === 'measurement').map((line) => [line.name, line.cachedOfPrevious, line.passed])).toEqual([['next_round', 0.8, false], ['resume', 0.8, false], ['effort_change', 0.8, false], ['effort_steady', 0.8, false]]);
      expect(lines.at(-1)).toMatchObject({ event: 'result', model: 'deepseek-v4.1-flash', providerCalls: 6, passed: false, effortKeptCache: false, effortSteadyKeptCache: false });
      expectOnlyIdsAndNumbers(lines);
      expect(result.stdout + result.stderr).not.toContain(KEY);
      for (const forbidden of FORBIDDEN) expect(result.stdout + result.stderr).not.toContain(forbidden);

      // O que chegou ao provedor: 6 pedidos de uma só conversa (sessão estável), a chave só no cabeçalho, e o effort só nos dois últimos (rodada de C4).
      expect(upstreams.requests).toHaveLength(6);
      expect(new Set(upstreams.requests.map((request) => request.sessionId))).toEqual(new Set([lines[0]!.conversationId as string]));
      expect(upstreams.requests.every((request) => request.key === KEY && !JSON.stringify(request.body).includes(KEY))).toBe(true);
      expect(upstreams.requests.map((request) => request.effort)).toEqual([undefined, undefined, undefined, undefined, 'low', 'low']);
    } finally { await upstreams.stop(); }
  });
});

// Prova offline da sonda `validate:tool-by-name` (phase 15, passo 1) sem chamar o provedor real nem ler `.env.provider`: a lógica roda em processo contra provedores roteirizados
// que se comportam como cada hipótese (chama pelo nome, só pela porta, ignora a ferramenta), e a CLI roda como processo contra o falso compartilhado ou sem chave. A medição real
// com o `deepseek-v4.1-flash` é a segunda metade da prova e roda à parte, com a chave do dono (`pnpm validate:tool-by-name`).
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ChatRejected, type ChatEvent, type ChatRequest, type ProviderClient } from '@aion/core';
import { startFakeUpstreams } from '@aion/core/testing';
import { describe, expect, it } from 'vitest';
import { costOf, runToolByNameProbe } from './support/validate-tool-by-name';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const KEY = 'valid-tool-chave-XYZ9';
const NOTE = { text: 'comprar leite', priority: 'alta' };
/** Texto da conversa que a sonda nunca pode deixar chegar à saída. */
const FORBIDDEN = ['comprar leite', 'Registre a nota', 'Você é um assistente'];

/** Provedor roteirizado: `reply` decide a chamada de ferramenta (ou nenhuma) a partir do pedido; guarda cópia de cada pedido. */
function scripted(reply: (request: ChatRequest, call: number) => { name: string; args: unknown } | null, options: { stop?: 'stop' | 'output_limit'; throwAt?: number } = {}): { provider: ProviderClient; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const provider: ProviderClient = {
    listModels: () => Promise.resolve([]),
    async *streamChat(_apiKey, _protocol, request): AsyncGenerator<ChatEvent> {
      requests.push(structuredClone(request));
      if (options.throwAt === requests.length) throw new ChatRejected(400);
      const call = reply(request, requests.length);
      if (call) yield { type: 'tool_call', id: 'c1', name: call.name, arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args) };
      yield { type: 'usage', usage: { inputTokens: 1_000, cachedTokens: 800, outputTokens: 40 } };
      yield { type: 'done', reason: options.stop ?? 'stop' };
    },
  };
  return { provider, requests };
}

async function probe(provider: ProviderClient): Promise<{ report: Awaited<ReturnType<typeof runToolByNameProbe>>; lines: Record<string, unknown>[] }> {
  const lines: Record<string, unknown>[] = [];
  const report = await runToolByNameProbe({ provider, apiKey: KEY, emit: (line) => lines.push(line) });
  return { report, lines };
}

/** Toda linha de saída é só identificador ou número. */
function expectOnlyIdsAndNumbers(lines: Record<string, unknown>[]): void {
  const walk = (value: unknown, path: string): void => {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return;
    if (typeof value === 'string') { expect(value, path).toMatch(/^[A-Za-z0-9_.:-]{1,64}$/); return; }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) walk(item, `${path}.${key}`);
  };
  lines.forEach((line, index) => walk(line, `linha ${index}`));
}

const hasDoor = (request: ChatRequest): boolean => request.tools!.some((tool) => tool.name === 'use_tool');

describe('sonda da chamada pelo nome (provedor roteirizado)', () => {
  it('modelo que chama pelo nome e pela porta: 3 chamadas, o alvo nunca em tools, esquema no fim do histórico, funciona', async () => {
    const { provider, requests } = scripted((request) => (hasDoor(request) ? { name: 'use_tool', args: { name: 'aion_registrar_nota', arguments: NOTE } } : { name: 'aion_registrar_nota', args: NOTE }));
    const { report, lines } = await probe(provider);
    expect(requests).toHaveLength(3);
    expect(report).toMatchObject({ providerCalls: 3, byName: 'works', doorWorks: true });
    expect(report.calls.map((call) => [call.name, call.outcome, call.expected])).toEqual([['by_name_1', 'by_name', true], ['door', 'door', true], ['by_name_2', 'by_name', true]]);
    // O alvo não está em nenhuma lista de ferramentas; o esquema dele só aparece no último turno (resultado de ferramenta).
    expect(requests.map((request) => request.tools!.map((tool) => tool.name))).toEqual([['aion_carregar_esquema'], ['aion_carregar_esquema', 'use_tool'], ['aion_carregar_esquema']]);
    for (const request of requests) {
      expect(JSON.stringify(request.tools)).not.toContain('aion_registrar_nota');
      expect(request.turns.at(-1)).toMatchObject({ role: 'tool', name: 'aion_carregar_esquema', text: expect.stringContaining('"required":["text","priority"]') });
      expect(request).toMatchObject({ model: 'deepseek-v4.1-flash', maxTokens: 256 });
      expect(request.effort).toBeUndefined();
    }
    expect(new Set(requests.map((request) => request.sessionId)).size).toBe(1);
    expect(lines.map((line) => line.event)).toEqual(['call', 'call', 'call', 'result']);
    expectOnlyIdsAndNumbers(lines);
    const text = JSON.stringify(lines);
    for (const forbidden of [KEY, ...FORBIDDEN]) expect(text).not.toContain(forbidden);
  });

  it('calcula o gasto pelos preços do deepseek: entrada sem cache, leitura de cache e saída', async () => {
    // 200 sem cache a 0,3; 800 de cache a 0,006; 40 de saída a 1,2 (US$ por milhão).
    const one = (200 * 0.3 + 800 * 0.006 + 40 * 1.2) / 1_000_000;
    expect(costOf({ inputTokens: 1_000, cachedTokens: 800, outputTokens: 40 })).toBeCloseTo(one, 12);
    expect(costOf({})).toBe(0);
    const { report, lines } = await probe(scripted(() => null).provider);
    expect(report.costUsd).toBeCloseTo(3 * one, 12);
    expect(lines.at(-1)).toMatchObject({ event: 'result', costUsd: Number(report.costUsd.toFixed(6)) });
  });

  it('modelo que só usa a porta (ignora o alvo solto): a chamada pelo nome não funciona e a porta sim', async () => {
    const { provider } = scripted((request) => (hasDoor(request) ? { name: 'use_tool', args: { name: 'aion_registrar_nota', arguments: NOTE } } : { name: 'aion_carregar_esquema', args: { name: 'aion_registrar_nota' } }));
    const { report } = await probe(provider);
    expect(report).toMatchObject({ byName: 'fails', doorWorks: true });
    expect(report.calls.map((call) => call.outcome)).toEqual(['other_tool', 'door', 'other_tool']);
  });

  it('classifica argumentos inválidos, JSON quebrado, porta apontando para outra ferramenta e resposta sem chamada', async () => {
    const cases = [
      { name: 'aion_registrar_nota', args: { text: 'x', priority: 'urgente' } }, // fora do enum
      { name: 'aion_registrar_nota', args: '{quebrado' },
      { name: 'aion_registrar_nota', args: { text: 'x', priority: 'alta', extra: 1 } }, // campo além do esquema
      { name: 'use_tool', args: { name: 'outra_ferramenta', arguments: NOTE } },
      { name: 'use_tool', args: { name: 'aion_registrar_nota', arguments: 'texto' } },
      null,
    ];
    const outcomes: string[] = [];
    for (const reply of cases) {
      const { report } = await probe(scripted(() => reply).provider);
      outcomes.push(report.calls[0]!.outcome);
    }
    expect(outcomes).toEqual(['wrong_args', 'wrong_args', 'wrong_args', 'wrong_args', 'wrong_args', 'no_call']);
  });

  it('saída cortada pelo limite ou sem chamada é inconclusiva, não prova de que não funciona', async () => {
    const truncated = await probe(scripted(() => null, { stop: 'output_limit' }).provider);
    expect(truncated.report.byName).toBe('inconclusive');
    const mixed = await probe(scripted((request, call) => (call === 1 ? { name: 'aion_registrar_nota', args: NOTE } : hasDoor(request) ? null : { name: 'aion_carregar_esquema', args: {} })).provider);
    expect(mixed.report.byName).toBe('inconclusive');
    expect(mixed.report.calls.map((call) => call.outcome)).toEqual(['by_name', 'no_call', 'other_tool']);
  });

  it('recusa do provedor na primeira chamada para a sonda ali, com uma única chamada feita e sem resultado', async () => {
    const { provider, requests } = scripted(() => null, { throwAt: 1 });
    const lines: Record<string, unknown>[] = [];
    await expect(runToolByNameProbe({ provider, apiKey: KEY, emit: (line) => lines.push(line) })).rejects.toBeInstanceOf(ChatRejected);
    expect(requests).toHaveLength(1);
    expect(lines).toEqual([]);
  });
});

describe('CLI da sonda da chamada pelo nome', () => {
  /** Executa a CLI como processo, com a chave só no ambiente do processo (nunca de `.env.provider`: sem `--env-file`). */
  const run = (env: Record<string, string | undefined>, args: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> => new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', 'tests/support/validate-tool-by-name.ts', ...args], {
      cwd: ROOT, timeout: 60_000,
      env: { ...process.env, AION_VALIDATE_PROVIDER_KEY: undefined, AION_OPENCODE_GO_BASE_URL: undefined, ...env },
    }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }));
  });

  it('falha sem chave, com chave em branco e com argumento, antes de chamar o provedor, com código estável e sem segredo', async () => {
    const upstreams = await startFakeUpstreams();
    try {
      for (const apiKey of [undefined, '   ']) {
        const result = await run({ AION_VALIDATE_PROVIDER_KEY: apiKey, AION_OPENCODE_GO_BASE_URL: upstreams.opencodeGoBaseUrl });
        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(JSON.parse(result.stderr)).toEqual({ code: 'PROVIDER_TOOL_BY_NAME_FAILED', message: expect.any(String), exitCode: 1 });
      }
      const withArg = await run({ AION_VALIDATE_PROVIDER_KEY: KEY, AION_OPENCODE_GO_BASE_URL: upstreams.opencodeGoBaseUrl }, ['--model', 'mimo-v2.6-pro']);
      expect(withArg.code).toBe(1);
      expect(JSON.parse(withArg.stderr)).toEqual({ code: 'PROVIDER_TOOL_BY_NAME_INVALID_ARGUMENT', message: expect.any(String), exitCode: 1 });
      expect(upstreams.requests).toHaveLength(0);
    } finally { await upstreams.stop(); }
  });

  it('com o cliente HTTP real contra o provedor falso faz no máximo 3 chamadas ao deepseek, com a chave só no cabeçalho, e a saída é só identificador e número', async () => {
    const upstreams = await startFakeUpstreams();
    try {
      const result = await run({ AION_VALIDATE_PROVIDER_KEY: KEY, AION_OPENCODE_GO_BASE_URL: upstreams.opencodeGoBaseUrl });
      expect(result.stdout + result.stderr).not.toContain(KEY);
      expect(upstreams.requests.length).toBeGreaterThanOrEqual(1);
      expect(upstreams.requests.length).toBeLessThanOrEqual(3);
      expect(upstreams.requests.every((request) => request.key === KEY && request.model === 'deepseek-v4.1-flash' && !JSON.stringify(request.body).includes(KEY))).toBe(true);
      const lines = result.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
      expectOnlyIdsAndNumbers(lines);
      for (const forbidden of FORBIDDEN) expect(result.stdout + result.stderr).not.toContain(forbidden);
    } finally { await upstreams.stop(); }
  });
});

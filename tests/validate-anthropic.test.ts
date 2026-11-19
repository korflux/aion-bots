// Prova offline da sonda `validate:anthropic` (phase 17, passo 1) sem chamar a Anthropic: a lógica roda em processo contra uma `fetch` roteirizada que se comporta como a API
// (`GET /models` paginado e `POST /messages` com streaming SSE, cache por prefixo e erro 400 quando o histórico traz `thinking` editado). A medição real (`pnpm validate:anthropic`,
// só com `claude-haiku-5-5`, cerca de US$ 0,005) é a segunda metade da prova e roda à parte com a chave do dono em `.env.anthropic`; este teste nunca lê esse arquivo.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { costOf, parseEffort, runAnthropicProbe, type AnthropicReport } from './support/validate-anthropic';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const KEY = 'sk-ant-chave-de-teste-XYZ9';
/** Texto da conversa que a sonda nunca pode deixar chegar à saída. */
const FORBIDDEN = ['Nota sintética', 'Chame a ferramenta', 'Agora responda', 'pronto', 'fim'];

interface Seen { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null }

/** Evento SSE da Anthropic. */
const sse = (type: string, data: Record<string, unknown>): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

/** Resposta de streaming de uma chamada: `thinking` (vazio, como no padrão `omitted`), texto e chamada de ferramenta quando `withTool`. A entrada e o cache seguem a regra de prefixo do falso. */
function stream({ withTool, usage }: { withTool: boolean; usage: { input: number; read: number; write: number } }): Response {
  const events = [
    sse('message_start', { message: { usage: { input_tokens: usage.input, cache_read_input_tokens: usage.read, cache_creation_input_tokens: usage.write, output_tokens: 1 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'assinatura' } }),
    sse('content_block_stop', { index: 0 }),
    ...(withTool
      ? [
        sse('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'eco', input: {} } }),
        sse('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"texto":' } }),
        sse('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '"ok"}' } }),
        sse('content_block_stop', { index: 1 }),
      ]
      : [
        sse('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
        sse('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'pronto' } }),
        sse('content_block_stop', { index: 1 }),
      ]),
    sse('message_delta', { delta: { stop_reason: withTool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 12 } }),
    sse('message_stop', {}),
  ].join('');
  return new Response(events, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const MODEL_PAGES = [
  { data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-09-21T00:00:00Z', max_input_tokens: 1_000_000, max_tokens: 128_000, type: 'model' }, { id: 'claude-sonnet-5-5', max_input_tokens: 1_000_000, max_tokens: 128_000 }], has_more: true, last_id: 'claude-sonnet-5-5' },
  { data: [{ id: 'claude-haiku-5-5', max_input_tokens: 1_000_000, max_tokens: 64_000 }, { id: 'modelo-sem-formato valido!' }], has_more: true, last_id: 'modelo-sem-formato valido!' },
  { data: [{ id: 'claude-haiku-4-5', max_input_tokens: 200_000, max_tokens: 64_000 }], has_more: false, last_id: 'claude-haiku-4-5' },
];

/**
 * `fetch` roteirizada. O cache do `/messages` é o prefixo igual ao do pedido anterior (ferramentas e sistema, como a marca de cache faz); a API recusa com 400 um histórico em que
 * `rejectHistory` esteja ligado, para provar a reprovação. `noTool` faz a chamada 1 terminar sem ferramenta.
 */
function fakeAnthropic(options: { rejectHistory?: boolean; noTool?: boolean; balance?: boolean } = {}): { fetchImpl: (input: string, init?: RequestInit) => Promise<Response>; seen: Seen[] } {
  const seen: Seen[] = [];
  let messagesCalls = 0;
  const fetchImpl = (input: string, init: RequestInit = {}): Promise<Response> => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]));
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    seen.push({ url: input, method: init.method ?? 'GET', headers, body });
    const url = new URL(input);
    if (url.pathname.endsWith('/models')) {
      const afterId = url.searchParams.get('after_id');
      const page = afterId === null ? MODEL_PAGES[0]! : afterId === 'claude-sonnet-5-5' ? MODEL_PAGES[1]! : MODEL_PAGES[2]!;
      return Promise.resolve(Response.json(page));
    }
    messagesCalls += 1;
    if (options.balance) return Promise.resolve(Response.json({ type: 'error', error: { type: 'billing_error', message: 'Seu saldo acabou.' }, request_id: 'req_1' }, { status: 402 }));
    const cached = messagesCalls === 1 ? 0 : 4_500;
    if (messagesCalls > 1 && options.rejectHistory) return Promise.resolve(Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'thinking blocks cannot be modified' } }, { status: 400 }));
    return Promise.resolve(stream({ withTool: messagesCalls === 1 && !options.noTool, usage: { input: 30, read: cached, write: messagesCalls === 1 ? 4_500 : 40 } }));
  };
  return { fetchImpl, seen };
}

async function probe(options?: Parameters<typeof fakeAnthropic>[0]): Promise<{ report: AnthropicReport; lines: Record<string, unknown>[]; seen: Seen[] }> {
  const { fetchImpl, seen } = fakeAnthropic(options);
  const lines: Record<string, unknown>[] = [];
  const report = await runAnthropicProbe({ fetchImpl, baseUrl: 'https://anthropic.test/v1', apiKey: KEY, emit: (line) => lines.push(line) });
  return { report, lines, seen };
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

describe('sonda da Anthropic (lógica, API roteirizada)', () => {
  it('lê /models página a página pelo cursor e mede a capacidade dos modelos Claude', async () => {
    const { report, lines, seen } = await probe();
    expect(report.models).toMatchObject({ pages: 3, total: 5, endedByHasMore: true, haikuFound: true });
    expect(report.models.fields).toEqual(['id', 'display_name', 'created_at', 'max_input_tokens', 'max_tokens', 'type']);
    // O id fora do formato nunca vira linha de saída como texto livre, e o cursor de cada página é o `last_id` da anterior.
    expect(report.models.claude.map((entry) => entry.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-haiku-4-5']);
    expect(lines.filter((line) => line.event === 'model').find((line) => line.id === 'claude-haiku-5-5')).toMatchObject({ maxInputTokens: 1_000_000, maxTokens: 64_000 });
    const pages = seen.filter((entry) => entry.url.includes('/models'));
    expect(pages.map((entry) => new URL(entry.url).searchParams.get('after_id'))).toEqual([null, 'claude-sonnet-5-5', 'modelo-sem-formato valido!']);
  });

  it('A17, A18, A19: o histórico sem thinking é aceito, o cache é lido na segunda chamada e o pedido segue o formato do adaptador', async () => {
    const { report, lines, seen } = await probe();
    expect(report.passed).toBe(true);
    expect(report.providerCalls).toBe(3);
    expect(report.thinkingBlocksSeen).toBe(true);
    expect(report.historyWithoutThinkingAccepted).toBe(true);
    expect(report.cacheReadOnSecondCall).toBe(4_500);
    expect(report.calls.map((call) => [call.call, call.status, call.stopReason, call.blocks])).toEqual([
      [1, 200, 'tool_use', ['thinking', 'tool_use']],
      [2, 200, 'end_turn', ['thinking', 'text']],
      [3, 200, 'end_turn', ['thinking', 'text']],
    ]);
    // Entrada (sem cache), leitura e gravação à parte; o custo acompanha o uso do Haiku 5.5.
    expect(report.calls[0]!.usage).toEqual({ inputTokens: 30, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 4_500 });
    expect(report.costUsd).toBeCloseTo(report.calls.reduce((sum, call) => sum + costOf(call.usage!), 0), 12);

    const messages = seen.filter((entry) => entry.method === 'POST');
    expect(messages).toHaveLength(3);
    for (const entry of messages) {
      // Sem Bearer nem sessão do OpenCode; só `x-api-key` e `anthropic-version`.
      expect(entry.headers).toMatchObject({ 'x-api-key': KEY, 'anthropic-version': '2023-06-01' });
      expect(entry.headers.authorization).toBeUndefined();
      expect(entry.headers['x-opencode-session']).toBeUndefined();
      const body = entry.body!;
      expect(body.model).toBe('claude-haiku-5-5');
      expect(body.stream).toBe(true);
      expect(body.output_config).toEqual({ effort: 'low' });
      for (const forbidden of ['temperature', 'top_p', 'top_k', 'tool_choice', 'thinking']) expect(body, forbidden).not.toHaveProperty(forbidden);
      // `cache_control` no último item das ferramentas, do sistema e da última mensagem.
      const system = body.system as { cache_control?: unknown }[];
      const tools = body.tools as { cache_control?: unknown }[];
      const history = body.messages as { content: { type: string; cache_control?: unknown }[] }[];
      expect(system.at(-1)!.cache_control).toEqual({ type: 'ephemeral' });
      expect(tools.at(-1)!.cache_control).toEqual({ type: 'ephemeral' });
      expect(history.at(-1)!.content.at(-1)!.cache_control).toEqual({ type: 'ephemeral' });
      // Nenhum bloco `thinking` ou `redacted_thinking` é reenviado.
      expect(history.flatMap((message) => message.content.map((block) => block.type))).not.toContain('thinking');
      expect(history.flatMap((message) => message.content.map((block) => block.type))).not.toContain('redacted_thinking');
    }
    expect((messages[1]!.body!.messages as unknown[]).length).toBe(3);
    expect((messages[2]!.body!.messages as unknown[]).length).toBe(5);

    expectOnlyIdsAndNumbers(lines);
    const output = JSON.stringify(lines);
    expect(output).not.toContain(KEY);
    for (const text of FORBIDDEN) expect(output).not.toContain(text);
  });

  it('envia o effort pedido em output_config', async () => {
    const { fetchImpl, seen } = fakeAnthropic();
    await runAnthropicProbe({ fetchImpl, baseUrl: 'https://anthropic.test/v1', apiKey: KEY, emit: () => undefined, effort: 'high' });
    expect(seen.filter((entry) => entry.method === 'POST').map((entry) => entry.body!.output_config)).toEqual([{ effort: 'high' }, { effort: 'high' }, { effort: 'high' }]);
  });

  it('reprova quando a API recusa o histórico sem thinking, registra só o status e o tipo e não chama a terceira vez', async () => {
    const { report, lines } = await probe({ rejectHistory: true });
    expect(report.passed).toBe(false);
    expect(report.historyWithoutThinkingAccepted).toBe(false);
    expect(report.providerCalls).toBe(2);
    expect(report.calls[1]).toMatchObject({ call: 2, status: 400, errorType: 'invalid_request_error', usage: null, costUsd: 0 });
    expectOnlyIdsAndNumbers(lines);
  });

  it('reprova sem gastar a segunda chamada quando a primeira não traz chamada de ferramenta', async () => {
    const { report } = await probe({ noTool: true });
    expect(report.passed).toBe(false);
    expect(report.providerCalls).toBe(1);
  });

  it('registra o status e o tipo de uma recusa de cobrança sem texto livre', async () => {
    const { report, lines } = await probe({ balance: true });
    expect(report.passed).toBe(false);
    expect(report.calls[0]).toMatchObject({ status: 402, errorType: 'billing_error' });
    expectOnlyIdsAndNumbers(lines);
    expect(JSON.stringify(lines)).not.toContain('saldo');
  });
});

describe('sonda da Anthropic (CLI)', () => {
  /** Executa a CLI como processo, com a chave só no ambiente do processo (nunca de `.env.anthropic`: sem `--env-file`). */
  const run = (env: Record<string, string | undefined>): Promise<{ code: number; stdout: string; stderr: string }> => new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', 'tests/support/validate-anthropic.ts'], {
      cwd: ROOT, timeout: 60_000,
      env: { ...process.env, AION_VALIDATE_ANTHROPIC_KEY: undefined, AION_ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ...env },
    }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }));
  });

  it('falha sem chave e com chave em branco antes de qualquer chamada, com código estável e sem segredo', async () => {
    for (const apiKey of [undefined, '   ']) {
      const result = await run({ AION_VALIDATE_ANTHROPIC_KEY: apiKey });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toEqual({ code: 'ANTHROPIC_PROBE_NO_KEY', message: expect.any(String), exitCode: 1 });
    }
  });

  it('aceita só os níveis de effort da lista, antes de qualquer chamada', async () => {
    expect(parseEffort([])).toBe('low');
    expect(parseEffort(['--effort', 'high'])).toBe('high');
    for (const invalid of [['--effort', 'max'], ['--effort', ''], ['--model', 'claude-opus-5-5'], ['--effort']]) expect(() => parseEffort(invalid)).toThrow('ANTHROPIC_PROBE_INVALID_ARGUMENT');
    const result = await run({ AION_VALIDATE_ANTHROPIC_KEY: KEY });
    expect(result.code).toBe(1);
    const refused = await new Promise<string>((resolve) => { execFile(process.execPath, ['--import', 'tsx', 'tests/support/validate-anthropic.ts', '--model', 'claude-opus-5-5'], { cwd: ROOT, env: { ...process.env, AION_VALIDATE_ANTHROPIC_KEY: KEY, AION_ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } }, (_error, _stdout, stderr) => resolve(stderr)); });
    expect(JSON.parse(refused)).toMatchObject({ code: 'ANTHROPIC_PROBE_INVALID_ARGUMENT', exitCode: 1 });
  });

  it('com a base inalcançável falha com envelope seguro, sem eco da chave nem de detalhe da rede', async () => {
    const result = await run({ AION_VALIDATE_ANTHROPIC_KEY: KEY });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({ code: 'ANTHROPIC_PROBE_FAILED', message: expect.any(String), exitCode: 1 });
    expect(result.stderr).not.toContain(KEY);
  });
});

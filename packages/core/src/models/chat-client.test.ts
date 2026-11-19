// Prova do leitor de SSE e do cliente de chat do OpenCode Go (T5): o mesmo stream lógico vira os mesmos eventos nos três
// protocolos, e cada falha (chave, serviço fora do ar, recusa por protocolo, stream quebrado, cortado ou grande demais)
// chega como o erro certo. O provedor é o servidor falso local; casos de borda do stream usam um `fetch` de mentira.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAnthropicClient } from '../credentials/anthropic';
import { createOpenCodeGoClient } from '../credentials/opencode-go';
import { DomainError } from '../errors';
import { startFakeUpstreams, type FakeUpstreams } from '../testing/fake-upstreams';
import { CHAT_PROTOCOLS, ChatRejected, ChatStreamError, type ChatEvent, type ChatProtocol, type ChatRequest, type ChatTurn } from './chat-protocols';
import { IMAGE_PROBE_BASE64, runImageTest } from './tester';
import { SseLimitError, readSse, type SseEvent } from './sse';

let upstreams: FakeUpstreams;

beforeAll(async () => {
  upstreams = await startFakeUpstreams();
});

afterAll(async () => {
  await upstreams.stop();
});

/** Corpo de resposta com os pedaços dados, um por leitura (as fronteiras entre pedaços são o que se quer provar). */
function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

/** Nome do erro lançado (ou `ok`), para comparar sem depender de mensagem. */
const outcome = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => 'ok',
    (error: unknown) => (error instanceof DomainError ? error.code : error instanceof Error ? error.name : `inesperado: ${String(error)}`),
  );

describe('leitor de SSE', () => {
  it('separa eventos por linha em branco, junta várias linhas data e ignora comentários, em qualquer quebra de linha', async () => {
    const events = await drain(
      readSse(
        streamOf(': keep-alive\n\nevent: a\ndata: um\n\n', 'data: dois\r\ndata: linhas\r\n\r\n', 'data:sem-espaco\rdata: cr\r\r', 'data: final-sem-linha-em-branco'),
        1024,
      ),
    );
    expect(events).toEqual<SseEvent[]>([
      { event: 'a', data: 'um' },
      { event: null, data: 'dois\nlinhas' },
      { event: null, data: 'sem-espaco\ncr' },
      { event: null, data: 'final-sem-linha-em-branco' },
    ]);
  });

  it('reconstrói um evento partido em qualquer ponto, inclusive no meio de um CRLF e de um caractere UTF-8', async () => {
    const payload = 'data: olá ✓\r\n\r\n';
    const bytes = new TextEncoder().encode(payload);
    // Um byte por pedaço: parte o CRLF e cada caractere multibyte.
    const oneByteAtATime = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    expect(await drain(readSse(oneByteAtATime, 1024))).toEqual([{ event: null, data: 'olá ✓' }]);
  });

  it('aborta o stream que passa do limite de bytes', async () => {
    const big = `data: ${'x'.repeat(200)}\n\n`;
    await expect(drain(readSse(streamOf(big, big), 300))).rejects.toBeInstanceOf(SseLimitError);
  });
});

describe('cliente de chat: um stream lógico, três protocolos', () => {
  const client = () => createOpenCodeGoClient({ baseUrl: upstreams.opencodeGoBaseUrl, chatTimeoutMs: 1_000 });
  /** Um modelo falso de cada protocolo, todos com ferramenta. */
  const MODEL_OF: Record<ChatProtocol, string> = { chat_completions: 'glm-5.1', messages: 'kimi-k2.7-code', responses: 'grok-4.7' };
  const request = (protocol: ChatProtocol, extra: Partial<ChatRequest> = {}): ChatRequest => ({
    model: MODEL_OF[protocol],
    sessionId: 'sessao-de-teste',
    turns: [{ role: 'user', text: 'oi' }],
    maxTokens: 64,
    ...extra,
  });
  const TOOL = { name: 'aion_echo', description: 'eco', parameters: { type: 'object' } };

  /** Muitas molduras pequenas reproduzem o envelope volumoso do provedor sem resposta útil grande. */
  function fragmentedEnvelope(bytes: number, terminal: boolean): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const envelope = encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'x' } }], padding: 'x'.repeat(512) })}\n\n`);
    let sent = 0;
    let closed = false;
    return new ReadableStream({
      pull(controller) {
        if (sent < bytes) { controller.enqueue(envelope); sent += envelope.byteLength; return; }
        if (!closed) {
          closed = true;
          const call = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'write', function: { name: 'table_write', arguments: '{"input":{"creates":[]}}' } }] } }] })}\n\n`;
          controller.enqueue(encoder.encode(call + (terminal ? 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n' : '')));
        }
        controller.close();
      },
    });
  }

  it('aceita SSE fragmentado acima de 1MiB sem ampliar saída/tokens, e recusa transporte acima de 16MiB', async () => {
    /** O transporte é sintético; a chamada pequena só pode sair após o terminal válido. */
    const events = async (bytes: number, terminal = true, observed: ChatEvent[] = []) => {
      const provider = createOpenCodeGoClient({ baseUrl: 'http://127.0.0.1:1', fetchImpl: async () => new Response(fragmentedEnvelope(bytes, terminal), { status: 200 }) });
      for await (const event of provider.streamChat('synthetic-key', 'chat_completions', request('chat_completions', { maxTokens: 64 }))) observed.push(event);
      return observed;
    };
    const completed = await events(2 * 1024 * 1024);
    expect(completed.filter((event) => event.type === 'tool_call')).toEqual([{ type: 'tool_call', id: 'write', name: 'table_write', arguments: '{"input":{"creates":[]}}' }]);
    expect(completed.at(-1)).toEqual({ type: 'done', reason: 'stop' });
    await expect(events(17 * 1024 * 1024)).rejects.toThrow('stream maior que o limite');
    const truncated: ChatEvent[] = [];
    await expect(events(2 * 1024 * 1024, false, truncated)).rejects.toThrow('stream encerrado sem o evento final');
    expect(truncated.some((event) => event.type === 'tool_call' || event.type === 'done')).toBe(false);
  });

  it.each(CHAT_PROTOCOLS)('%s: preserva motivo de saída e só publica ferramentas de uma resposta globalmente concluída', async (protocol) => {
    /** Um bloco completo seguido de outro parcial comprova que o término vale para toda a resposta. */
    const frames = (limited: boolean): string => {
      const frame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
      if (protocol === 'chat_completions') return [
        frame({ choices: [{ delta: { content: 'Resposta parcial', tool_calls: [{ index: 0, id: 'a', function: { name: 'aion_echo', arguments: '{"text":"ok"}' } }, { index: 1, id: 'b', function: { name: 'aion_echo', arguments: '{"text":' } }] } }] }),
        frame({ choices: [{ delta: {}, finish_reason: limited ? 'length' : 'tool_calls' }] }), 'data: [DONE]\n\n',
      ].join('');
      if (protocol === 'messages') return [
        frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Resposta parcial' } }),
        frame({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'a', name: 'aion_echo' } }),
        frame({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"text":"ok"}' } }),
        frame({ type: 'content_block_stop', index: 1 }),
        frame({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'b', name: 'aion_echo' } }),
        frame({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"text":' } }),
        frame({ type: 'message_delta', delta: { stop_reason: limited ? 'max_tokens' : 'tool_use' } }), frame({ type: 'message_stop' }),
      ].join('');
      return [
        frame({ type: 'response.output_text.delta', delta: 'Resposta parcial' }),
        frame({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'a', name: 'aion_echo', arguments: '{"text":"ok"}' } }),
        frame({ type: 'response.function_call_arguments.delta', delta: '{"text":' }),
        frame(limited ? { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } } : { type: 'response.completed' }),
      ].join('');
    };
    for (const limited of [true, false]) {
      const provider = createOpenCodeGoClient({ baseUrl: 'http://provedor.invalido', fetchImpl: async () => new Response(streamOf(frames(limited))) });
      const events = await drain(provider.streamChat('chave-de-teste', protocol, request(protocol)));
      expect(events.at(-1)).toEqual({ type: 'done', reason: limited ? 'output_limit' : 'stop' });
      expect(events).toContainEqual({ type: 'text', text: 'Resposta parcial' });
      expect(events.filter((event) => event.type === 'tool_call').length).toBe(limited ? 0 : protocol === 'chat_completions' ? 2 : 1);
    }
  });

  it.each(CHAT_PROTOCOLS)('%s: terminal ausente ou desconhecido recusa resposta sem publicar chamadas', async (protocol) => {
    const frame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
    const beginning = protocol === 'chat_completions' ? frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'aion_echo', arguments: '{}' } }] } }] }) : protocol === 'messages' ? frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'aion_echo' } }) + frame({ type: 'content_block_stop', index: 0 }) : frame({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'a', name: 'aion_echo', arguments: '{}' } });
    for (const terminal of ['', protocol === 'chat_completions' ? frame({ choices: [{ finish_reason: 'unrecognized', delta: {} }] }) + 'data: [DONE]\n\n' : protocol === 'messages' ? frame({ type: 'message_delta', delta: { stop_reason: 'unrecognized' } }) + frame({ type: 'message_stop' }) : frame({ type: 'response.incomplete', response: { incomplete_details: { reason: 'unrecognized' } } })]) {
      const provider = createOpenCodeGoClient({ baseUrl: 'http://provedor.invalido', fetchImpl: async () => new Response(streamOf(beginning + terminal)) });
      const events: ChatEvent[] = [];
      const consume = async () => { for await (const event of provider.streamChat('key', protocol, request(protocol))) events.push(event); };
      await expect(consume()).rejects.toBeInstanceOf(ChatStreamError);
      expect(events.some((event) => event.type === 'tool_call' || event.type === 'done')).toBe(false);
    }
  });

  it.each(CHAT_PROTOCOLS)('%s: o texto chega em pedaços e termina em done; a ferramenta chega inteira', async (protocol) => {
    const text = await drain(client().streamChat('valid-key', protocol, request(protocol)));
    expect(text).toEqual<ChatEvent[]>([{ type: 'text', text: 'o' }, { type: 'text', text: 'k' }, { type: 'usage', usage: { inputTokens: 100, cachedTokens: 80, outputTokens: 2 } }, { type: 'done', reason: 'stop' }]);

    const tools = await drain(client().streamChat('valid-key', protocol, request(protocol, { tools: [TOOL] })));
    expect(tools.at(-1)).toEqual({ type: 'done', reason: 'stop' });
    expect(tools.at(-2)).toEqual({ type: 'usage', usage: { inputTokens: 100, cachedTokens: 80, outputTokens: 2 } });
    const [call] = tools.filter((event) => event.type === 'tool_call');
    expect(call).toMatchObject({ type: 'tool_call', name: 'aion_echo', arguments: '{"text":"ok"}' });
    expect(call?.type === 'tool_call' && call.id).toBeTruthy();

    // A requisição foi ao caminho do protocolo, com a chave, o modelo e a ferramenta.
    const sent = upstreams.requests.at(-1);
    expect(sent).toMatchObject({
      method: 'POST',
      path: `/opencode-go/v1/${protocol === 'chat_completions' ? 'chat/completions' : protocol}`,
      key: 'valid-key',
      // O provedor real recusa o chat sem `x-opencode-session` (400); o falso faz o mesmo, então esquecê-lo quebra todos os testes.
      sessionId: 'sessao-de-teste',
      model: MODEL_OF[protocol],
      tools: true,
    });
  });

  it('recusa específica de stream_options repete só o HTTP e lembra por modelo; erros genéricos e stream parcial não repetem', async () => {
    const bodies: Record<string, unknown>[] = [];
    const compatible = createOpenCodeGoClient({ baseUrl: 'http://provedor.invalido', fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return body.stream_options ? new Response(JSON.stringify({ error: { param: 'stream_options', message: 'segredo-ecoado' } }), { status: 400 }) : new Response(streamOf('data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\ndata: [DONE]\n\n'));
    } });
    expect(await drain(compatible.streamChat('segredo-ecoado', 'chat_completions', request('chat_completions')))).toEqual([{ type: 'usage', usage: {} }, { type: 'done', reason: 'stop' }]);
    await drain(compatible.streamChat('segredo-ecoado', 'chat_completions', request('chat_completions')));
    expect(bodies.map((body) => body.stream_options !== undefined)).toEqual([true, false, false]);
    await drain(compatible.streamChat('segredo-ecoado', 'chat_completions', request('chat_completions', { model: 'outro' })));
    expect(bodies.map((body) => body.stream_options !== undefined)).toEqual([true, false, false, true, false]);

    for (const status of [400, 422, 429, 500]) {
      let attempts = 0;
      const rejected = createOpenCodeGoClient({ baseUrl: 'http://provedor.invalido', fetchImpl: async () => { attempts += 1; return new Response('{}', { status }); } });
      await expect(drain(rejected.streamChat('key', 'chat_completions', request('chat_completions')))).rejects.toBeInstanceOf(Error);
      expect(attempts).toBe(1);
    }
    let attempts = 0;
    const partial = createOpenCodeGoClient({ baseUrl: 'http://provedor.invalido', fetchImpl: async () => { attempts += 1; return new Response(streamOf('data: {"choices":[{"delta":{"content":"parcial"}}]}\n\n')); } });
    await expect(drain(partial.streamChat('key', 'chat_completions', request('chat_completions')))).rejects.toBeInstanceOf(ChatStreamError);
    expect(attempts).toBe(1);
  });

  it.each(CHAT_PROTOCOLS)('%s: usage inválido ou ausente não derruba a etapa', async (protocol) => {
    const end: Record<ChatProtocol, string> = {
      chat_completions: 'data: {"choices":[{"finish_reason":"stop","delta":{}}],"usage":{"prompt_tokens":-1,"completion_tokens":"segredo"}}\n\ndata: [DONE]\n\n',
      messages: 'data: {"type":"message_start","message":null}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n',
      responses: 'data: {"type":"response.completed","response":{"usage":null}}\n\n',
    };
    const spy = createOpenCodeGoClient({ baseUrl: 'http://provedor.invalido', fetchImpl: async () => new Response(streamOf(end[protocol])) });
    expect(await drain(spy.streamChat('key', protocol, request(protocol)))).toEqual([{ type: 'usage', usage: {} }, { type: 'done', reason: 'stop' }]);
  });

  // Tokens de raciocínio (phase 10, A16): fatia da saída lida só da forma oficial de cada protocolo; `outputTokens` segue sendo o total informado e o campo ausente ou inválido
  // fica AUSENTE (`toStrictEqual` separa "sem a chave" de "chave undefined"), nunca 0. O `messages` não tem o campo, então nada que se pareça com ele conta ali.
  describe('raciocínio no uso', () => {
    /** Resposta mínima de cada protocolo com 50 tokens de saída e o objeto de detalhes dado, como TEXTO JSON, no nome oficial do protocolo (`null` omite o objeto). O `messages` recebe o mesmo objeto nos dois nomes alheios a ele, para provar que é ignorado. */
    const respond = (protocol: ChatProtocol, details: string | null): string => ({
      chat_completions: `data: {"choices":[{"finish_reason":"stop","delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":50${details === null ? '' : `,"completion_tokens_details":${details}`}}}\n\ndata: [DONE]\n\n`,
      messages: `data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50${details === null ? '' : `,"output_tokens_details":${details},"completion_tokens_details":${details}`}}}\n\ndata: {"type":"message_stop"}\n\n`,
      responses: `data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":50${details === null ? '' : `,"output_tokens_details":${details}`}}}}\n\n`,
    })[protocol];
    const usageOf = async (protocol: ChatProtocol, body: string) => {
      const client = createOpenCodeGoClient({ baseUrl: 'http://provedor.invalido', fetchImpl: async () => new Response(streamOf(body)) });
      const event = (await drain(client.streamChat('key', protocol, request(protocol)))).find((item) => item.type === 'usage');
      return event?.type === 'usage' ? event.usage : undefined;
    };

    it.each([
      ['informado', '{"reasoning_tokens":30}', 30],
      ['informado como zero (zero informado é dado)', '{"reasoning_tokens":0}', 0],
      ['objeto sem o campo', '{}', undefined],
      ['objeto de detalhes omitido', null, undefined],
      ['negativo', '{"reasoning_tokens":-3}', undefined],
      ['fracionário', '{"reasoning_tokens":2.5}', undefined],
      ['texto', '{"reasoning_tokens":"30"}', undefined],
      ['nulo', '{"reasoning_tokens":null}', undefined],
      ['detalhes que não são objeto', '"segredo-ecoado"', undefined],
    ] as const)('%s: reasoningTokens presente só quando válido e outputTokens segue o total', async (_name, details, expected) => {
      for (const protocol of CHAT_PROTOCOLS) {
        // O messages não informa raciocínio em nenhum caso: sai só com o total de saída.
        const informed = protocol !== 'messages' && expected !== undefined;
        expect(await usageOf(protocol, respond(protocol, details)), protocol).toStrictEqual({ inputTokens: 10, outputTokens: 50, ...(informed ? { reasoningTokens: expected } : {}) });
      }
    });

    it('raciocínio fora do lugar oficial do protocolo não conta (nem como campo solto nem no objeto do outro protocolo)', async () => {
      const misplaced = '"reasoning_tokens":9,"prompt_tokens_details":{"reasoning_tokens":9},"input_tokens_details":{"reasoning_tokens":9}';
      expect(await usageOf('chat_completions', `data: {"choices":[{"finish_reason":"stop","delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":50,${misplaced},"output_tokens_details":{"reasoning_tokens":9}}}\n\ndata: [DONE]\n\n`)).toStrictEqual({ inputTokens: 10, outputTokens: 50 });
      expect(await usageOf('responses', `data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":50,${misplaced},"completion_tokens_details":{"reasoning_tokens":9}}}}\n\n`)).toStrictEqual({ inputTokens: 10, outputTokens: 50 });
    });

    it.each(CHAT_PROTOCOLS)('%s: o provedor falso só informa raciocínio quando o cenário pede, e a saída informada o contém', async (protocol) => {
      const ask = async (text: string) => {
        const turns: ChatTurn[] = [{ role: 'system', text: 'instruções' }, { role: 'user', text }];
        const event = (await drain(client().streamChat('valid-key', protocol, request(protocol, { turns })))).find((item) => item.type === 'usage');
        return event?.type === 'usage' ? event.usage : undefined;
      };
      // Valores fixos de sempre quando ninguém pede: nenhum teste anterior enxerga mudança.
      expect(await ask('oi')).toStrictEqual({ inputTokens: 100, cachedTokens: 80, outputTokens: 2 });
      // Com o marcador, chat/completions e responses trazem a fatia e a saída vira a base mais ela; o messages (sem o campo no protocolo) só traz a saída maior.
      expect(await ask('[raciocinio:7] oi')).toStrictEqual({ inputTokens: 100, cachedTokens: 80, outputTokens: 9, ...(protocol === 'messages' ? {} : { reasoningTokens: 7 }) });
    });
  });

  // Cache explícito do messages (phase 12, T3, A10): leitura em `cachedTokens`, gravação em `cacheWriteTokens`, entrada = total dos três campos, e o evento final do stream nunca sobrescreve
  // o cache do início. Os outros dois protocolos têm cache automático e não informam gravação.
  describe('cache no uso (messages)', () => {
    const sse = (...events: unknown[]): string => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
    const stop = { type: 'message_delta', delta: { stop_reason: 'end_turn' } };
    const usageOf = async (protocol: ChatProtocol, body: string) => {
      const client = createOpenCodeGoClient({ baseUrl: 'http://provedor.invalido', fetchImpl: async () => new Response(streamOf(body)) });
      const event = (await drain(client.streamChat('key', protocol, request(protocol)))).find((item) => item.type === 'usage');
      return event?.type === 'usage' ? event.usage : undefined;
    };

    it('leitura vai para cachedTokens, gravação para cacheWriteTokens, a entrada é o total dos três campos e o evento final sem cache não sobrescreve o início', async () => {
      const start = { type: 'message_start', message: { usage: { input_tokens: 20, cache_read_input_tokens: 800, cache_creation_input_tokens: 180, output_tokens: 1 } } };
      // Evento final só com a saída (a Anthropic) e evento final que repete ou zera a entrada e o cache (alguns gateways): o início manda, e só a saída é atualizada.
      for (const finalUsage of [{ output_tokens: 42 }, { output_tokens: 42, input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, { output_tokens: 42, input_tokens: 20, cache_read_input_tokens: 800, cache_creation_input_tokens: 180 }]) {
        expect(await usageOf('messages', sse(start, { ...stop, usage: finalUsage }, { type: 'message_stop' })), JSON.stringify(finalUsage)).toStrictEqual({ inputTokens: 1_000, cachedTokens: 800, cacheWriteTokens: 180, outputTokens: 42 });
      }
    });

    it('a mescla é campo a campo: o cache informado no início prevalece sobre o do final mesmo sem input_tokens no início, e o final só preenche o que o início não informou', async () => {
      const startWith = (usage: Record<string, unknown>) => ({ type: 'message_start', message: { usage } });
      const finalWith = (usage: Record<string, unknown>) => ({ ...stop, usage });
      const run = (start: Record<string, unknown>, final: Record<string, unknown>) => usageOf('messages', sse(startWith(start), finalWith(final), { type: 'message_stop' }));
      // Início com leitura e gravação e SEM input_tokens; final com outros valores para os três campos: leitura e gravação do início valem, a entrada do final preenche a lacuna e o total soma os três.
      expect(await run({ cache_read_input_tokens: 800, cache_creation_input_tokens: 180, output_tokens: 1 }, { input_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 7, output_tokens: 42 }))
        .toStrictEqual({ inputTokens: 1_000, cachedTokens: 800, cacheWriteTokens: 180, outputTokens: 42 });
      // Início com cache sem entrada e final só com a saída: o cache do início não se perde (e sem entrada em nenhum dos dois não há total).
      expect(await run({ cache_read_input_tokens: 800, cache_creation_input_tokens: 180 }, { output_tokens: 42 })).toStrictEqual({ cachedTokens: 800, cacheWriteTokens: 180, outputTokens: 42 });
      // Final que zera o cache: o zero do final não apaga a leitura e a gravação do início.
      expect(await run({ cache_read_input_tokens: 800, cache_creation_input_tokens: 180 }, { output_tokens: 42, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).toStrictEqual({ cachedTokens: 800, cacheWriteTokens: 180, outputTokens: 42 });
      // Campo a campo: só a leitura veio no início, então a gravação vem do final e a leitura continua a do início.
      expect(await run({ input_tokens: 10, cache_read_input_tokens: 800 }, { output_tokens: 42, cache_read_input_tokens: 1, cache_creation_input_tokens: 9 })).toStrictEqual({ inputTokens: 819, cachedTokens: 800, cacheWriteTokens: 9, outputTokens: 42 });
    });

    it('sem a informação no início, o evento final a preenche; sem cache em nenhum dos dois a gravação fica ausente (nunca 0)', async () => {
      expect(await usageOf('messages', sse({ type: 'message_start', message: null }, { ...stop, usage: { input_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 9 } }, { type: 'message_stop' })))
        .toStrictEqual({ inputTokens: 10, cachedTokens: 3, cacheWriteTokens: 2, outputTokens: 9 });
      expect(await usageOf('messages', sse({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } }, { ...stop, usage: { output_tokens: 7 } }, { type: 'message_stop' })))
        .toStrictEqual({ inputTokens: 10, outputTokens: 7 });
    });

    it('gravação zero informada é dado; negativa, fracionária ou em texto é ignorada; leitura e gravação inválidas não entram na entrada total', async () => {
      const startWith = (fields: Record<string, unknown>) => sse({ type: 'message_start', message: { usage: { input_tokens: 10, ...fields } } }, stop, { type: 'message_stop' });
      expect(await usageOf('messages', startWith({ cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }))).toStrictEqual({ inputTokens: 10, cachedTokens: 0, cacheWriteTokens: 0 });
      for (const invalid of [-4, 2.5, '7', null]) expect(await usageOf('messages', startWith({ cache_creation_input_tokens: invalid })), String(invalid)).toStrictEqual({ inputTokens: 10 });
    });

    it('chat_completions e responses não informam gravação: o campo da Anthropic fica ignorado e o cache continua só a leitura automática', async () => {
      const extra = '"cache_creation_input_tokens":99';
      expect(await usageOf('chat_completions', `data: {"choices":[{"finish_reason":"stop","delta":{}}],"usage":{"prompt_tokens":10,"prompt_tokens_details":{"cached_tokens":6},"completion_tokens":5,${extra}}}\n\ndata: [DONE]\n\n`))
        .toStrictEqual({ inputTokens: 10, cachedTokens: 6, outputTokens: 5 });
      expect(await usageOf('responses', `data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"input_tokens_details":{"cached_tokens":6},"output_tokens":5,${extra}}}}\n\n`))
        .toStrictEqual({ inputTokens: 10, cachedTokens: 6, outputTokens: 5 });
    });

    it('o provedor falso só informa gravação quando o cenário pede, dentro da entrada total, e só no messages', async () => {
      const ask = async (protocol: ChatProtocol, text: string) => {
        const turns: ChatTurn[] = [{ role: 'system', text: 'instruções' }, { role: 'user', text }];
        const event = (await drain(client().streamChat('valid-key', protocol, request(protocol, { turns })))).find((item) => item.type === 'usage');
        return event?.type === 'usage' ? event.usage : undefined;
      };
      for (const protocol of CHAT_PROTOCOLS) {
        // Sem marcador nenhum protocolo informa gravação (provedor que não a informa); com ele, só o messages, limitada ao que não veio do cache (100 de entrada, 80 lidos).
        expect(await ask(protocol, 'oi'), protocol).toStrictEqual({ inputTokens: 100, cachedTokens: 80, outputTokens: 2 });
        expect(await ask(protocol, '[cache-gravacao:15] oi'), protocol).toStrictEqual({ inputTokens: 100, cachedTokens: 80, outputTokens: 2, ...(protocol === 'messages' ? { cacheWriteTokens: 15 } : {}) });
      }
      expect(await ask('messages', '[cache-gravacao:900] oi')).toStrictEqual({ inputTokens: 100, cachedTokens: 80, cacheWriteTokens: 20, outputTokens: 2 });
    });
  });

  it('autentica por protocolo: Bearer em todos; messages manda também x-api-key e a versão (suposição do gateway Anthropic)', async () => {
    const FINAL: Record<ChatProtocol, string> = {
      chat_completions: 'data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\ndata: [DONE]\n\n',
      messages: 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n',
      responses: 'data: {"type":"response.completed"}\n\n',
    };
    for (const protocol of CHAT_PROTOCOLS) {
      let sent: Headers | undefined;
      let url = '';
      const spy = createOpenCodeGoClient({
        baseUrl: 'http://provedor.invalido/v1',
        fetchImpl: async (input, init) => {
          url = String(input);
          sent = new Headers(init?.headers);
          return new Response(streamOf(FINAL[protocol]), { status: 200 });
        },
      });
      await drain(spy.streamChat('chave-de-teste', protocol, request(protocol)));
      expect(url, protocol).toBe(`http://provedor.invalido/v1/${protocol === 'chat_completions' ? 'chat/completions' : protocol}`);
      expect(sent?.get('authorization'), protocol).toBe('Bearer chave-de-teste');
      expect(sent?.get('x-api-key'), protocol).toBe(protocol === 'messages' ? 'chave-de-teste' : null);
      expect(sent?.get('anthropic-version'), protocol).toBe(protocol === 'messages' ? '2023-06-01' : null);
      expect(sent?.get('content-type'), protocol).toBe('application/json');
      expect(sent?.get('x-opencode-session'), protocol).toBe('sessao-de-teste');
    }
  });

  it('A30: o pedido ao OpenCode Go é idêntico em bytes com o id do produto (opencode/x) e com o id local, em cada protocolo: o prefixo sai no cliente e nada mais muda', async () => {
    const FINAL: Record<ChatProtocol, string> = {
      chat_completions: 'data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\ndata: [DONE]\n\n',
      messages: 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n',
      responses: 'data: {"type":"response.completed"}\n\n',
    };
    for (const protocol of CHAT_PROTOCOLS) {
      const sent: { url: string; headers: [string, string][]; body: string }[] = [];
      const spy = createOpenCodeGoClient({
        baseUrl: 'http://provedor.invalido/v1',
        fetchImpl: async (input, init) => {
          sent.push({ url: String(input), headers: [...new Headers(init?.headers)].sort(([a], [b]) => a.localeCompare(b)), body: String(init?.body) });
          return new Response(streamOf(FINAL[protocol]), { status: 200 });
        },
      });
      await drain(spy.streamChat('chave-de-teste', protocol, request(protocol, { model: `opencode/${MODEL_OF[protocol]}` })));
      await drain(spy.streamChat('chave-de-teste', protocol, request(protocol)));
      expect(sent, protocol).toHaveLength(2);
      expect(sent[0], protocol).toEqual(sent[1]);
      expect(JSON.parse(sent[0]!.body).model, protocol).toBe(MODEL_OF[protocol]);
    }
  });

  it('o nível de effort vai no parâmetro próprio de cada protocolo; Padrão não manda configuração', async () => {
    await drain(client().streamChat('valid-key', 'chat_completions', request('chat_completions', { effort: 'high' })));
    expect(upstreams.requests.at(-1)?.effort).toBe('high');
    await drain(client().streamChat('valid-key', 'responses', request('responses', { effort: 'low' })));
    expect(upstreams.requests.at(-1)?.effort).toBe('low');
    await drain(client().streamChat('valid-key', 'messages', request('messages', { effort: 'high' })));
    expect(upstreams.requests.at(-1)?.effort).toBe('high');
    const body = upstreams.requests.at(-1)?.body;
    expect(body?.output_config).toEqual({ effort: 'high' });
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('reasoning_effort');
    await expect(drain(client().streamChat('valid-key', 'messages', request('messages', { effort: 'inventado' })))).rejects.toBeInstanceOf(ChatRejected);
    await drain(client().streamChat('valid-key', 'messages', request('messages')));
    expect(upstreams.requests.at(-1)?.body).not.toHaveProperty('output_config');
  });

  it('a conversa (sistema, chamada e resultado de ferramenta) vai no formato de cada protocolo', async () => {
    const turns: ChatTurn[] = [
      { role: 'system', text: 'Seja breve.' },
      { role: 'user', text: 'oi' },
      { role: 'assistant', text: 'vou pesquisar', toolCalls: [{ id: 'c1', name: 'search_history', arguments: '{"query":"x"}' }] },
      { role: 'tool', callId: 'c1', name: 'search_history', text: 'achei' },
      { role: 'user', text: 'valeu' },
    ];
    const bodyOf = async (protocol: ChatProtocol, conversation: ChatTurn[]) => {
      await drain(client().streamChat('valid-key', protocol, request(protocol, { turns: conversation })));
      return upstreams.requests.at(-1)?.body;
    };

    expect((await bodyOf('chat_completions', turns))?.messages).toEqual([
      { role: 'system', content: 'Seja breve.' },
      { role: 'user', content: 'oi' },
      { role: 'assistant', content: 'vou pesquisar', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_history', arguments: '{"query":"x"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'achei' },
      { role: 'user', content: 'valeu' },
    ]);

    // Anthropic: o sistema é um campo à parte (lista de blocos, com a marca de cache no último) e o resultado da ferramenta é um bloco do usuário, antes do texto seguinte; a última
    // mensagem leva a marca de cache no último bloco (A9, phase 12: o resto da conversa é idêntico ao de antes da marca).
    const anthropic = await bodyOf('messages', turns);
    expect(anthropic?.system).toEqual([{ type: 'text', text: 'Seja breve.', cache_control: { type: 'ephemeral' } }]);
    expect(anthropic?.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'oi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'vou pesquisar' }, { type: 'tool_use', id: 'c1', name: 'search_history', input: { query: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'achei' }, { type: 'text', text: 'valeu', cache_control: { type: 'ephemeral' } }] },
    ]);

    const responses = await bodyOf('responses', turns);
    expect(responses?.instructions).toBe('Seja breve.');
    expect(responses?.input).toEqual([
      { role: 'user', content: 'oi' },
      { role: 'assistant', content: 'vou pesquisar' },
      { type: 'function_call', call_id: 'c1', name: 'search_history', arguments: '{"query":"x"}' },
      { type: 'function_call_output', call_id: 'c1', output: 'achei' },
      { role: 'user', content: 'valeu' },
    ]);

    // Várias chamadas da mesma etapa, resultados juntos numa só mensagem do usuário (exigência da Anthropic) e argumentos
    // que não são JSON viram objeto vazio no `input`.
    const parallel: ChatTurn[] = [
      { role: 'user', text: 'faça duas' },
      {
        role: 'assistant',
        text: '',
        toolCalls: [
          { id: 'a', name: 'search_history', arguments: '{"query":"1"}' },
          { id: 'b', name: 'search_history', arguments: '{quebrado' },
        ],
      },
      { role: 'tool', callId: 'a', name: 'search_history', text: 'r1' },
      { role: 'tool', callId: 'b', name: 'search_history', text: 'r2' },
    ];
    expect((await bodyOf('messages', parallel))?.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'faça duas' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'a', name: 'search_history', input: { query: '1' } },
          { type: 'tool_use', id: 'b', name: 'search_history', input: {} },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'r1' }, { type: 'tool_result', tool_use_id: 'b', content: 'r2', cache_control: { type: 'ephemeral' } }] },
    ]);
    // Sem turno de sistema, nenhum dos campos de instrução é enviado.
    const plain = await bodyOf('responses', [{ role: 'user', text: 'oi' }]);
    expect(plain).not.toHaveProperty('instructions');
  });

  // Cache explícito do messages (phase 12, T3, A9, P6): `cache_control` ephemeral no último item de `tools`, no último bloco do sistema e no último bloco da última mensagem, e em nenhum outro
  // lugar. chat_completions e responses guardam o prefixo sozinhos: nenhuma marca e o formato de antes.
  it('o messages marca o cache nos três pontos (ferramentas, sistema e última mensagem) e os outros protocolos não mudam', async () => {
    const EPHEMERAL = { type: 'ephemeral' };
    const OTHER_TOOL = { name: 'aion_outra', description: 'outra', parameters: { type: 'object' } };
    const turns: ChatTurn[] = [
      { role: 'system', text: 'Sistema A.' },
      { role: 'user', text: 'oi' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'aion_echo', arguments: '{"a":1}' }] },
      { role: 'tool', callId: 'c1', name: 'aion_echo', text: 'resultado' },
    ];
    const bodyOf = async (protocol: ChatProtocol, conversation: ChatTurn[], tools?: { name: string; description: string; parameters: Record<string, unknown> }[]) => {
      await drain(client().streamChat('valid-key', protocol, request(protocol, { turns: conversation, ...(tools ? { tools } : {}) })));
      return upstreams.requests.at(-1)!.body!;
    };
    const marks = (body: unknown): number => JSON.stringify(body).split('cache_control').length - 1;

    const body = await bodyOf('messages', turns, [TOOL, OTHER_TOOL]);
    expect(marks(body)).toBe(3);
    // Ferramentas: só a última leva a marca, e o resto do item é o de sempre (nome, descrição e `input_schema`).
    expect(body.tools).toEqual([
      { name: 'aion_echo', description: 'eco', input_schema: { type: 'object' } },
      { name: 'aion_outra', description: 'outra', input_schema: { type: 'object' }, cache_control: EPHEMERAL },
    ]);
    // Sistema: lista de blocos com o texto de antes em um bloco só, marcado.
    expect(body.system).toEqual([{ type: 'text', text: 'Sistema A.', cache_control: EPHEMERAL }]);
    // Última mensagem: só o último bloco dela é marcado (aqui o resultado de ferramenta); a mensagem anterior fica intacta.
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'oi' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'aion_echo', input: { a: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'resultado', cache_control: EPHEMERAL }] },
    ]);

    // Vários turnos de sistema continuam um único texto (juntos por linha em branco), e uma conversa que termina no assistente marca o último bloco dele.
    const twoSystems = await bodyOf('messages', [{ role: 'system', text: 'A' }, { role: 'system', text: 'B' }, { role: 'user', text: 'oi' }, { role: 'assistant', text: 'resposta', toolCalls: [] }]);
    expect(twoSystems.system).toEqual([{ type: 'text', text: 'A\n\nB', cache_control: EPHEMERAL }]);
    expect((twoSystems.messages as { content: unknown[] }[]).at(-1)).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'resposta', cache_control: EPHEMERAL }] });

    // Sem sistema e sem ferramentas só há o que marcar na última mensagem: nada é inventado nem enviado vazio.
    const plain = await bodyOf('messages', [{ role: 'user', text: 'oi' }]);
    expect(plain).not.toHaveProperty('system');
    expect(plain).not.toHaveProperty('tools');
    expect(marks(plain)).toBe(1);
    // Lista de ferramentas vazia não tem item para marcar.
    expect(marks(await bodyOf('messages', [{ role: 'user', text: 'oi' }], []))).toBe(1);

    // chat_completions e responses: nenhuma marca, sistema como antes (mensagem `system` e `instructions` em texto) e ferramentas sem campo novo.
    for (const protocol of ['chat_completions', 'responses'] as const) {
      const other = await bodyOf(protocol, turns, [TOOL, OTHER_TOOL]);
      expect(marks(other), protocol).toBe(0);
      expect(JSON.stringify(other), protocol).not.toContain('ephemeral');
    }
    const completions = await bodyOf('chat_completions', turns, [TOOL]);
    expect((completions.messages as unknown[]).slice(0, 2)).toEqual([{ role: 'system', content: 'Sistema A.' }, { role: 'user', content: 'oi' }]);
    expect(completions.tools).toEqual([{ type: 'function', function: TOOL }]);
    const responses = await bodyOf('responses', turns, [TOOL]);
    expect(responses.instructions).toBe('Sistema A.');
    expect(responses.tools).toEqual([{ type: 'function', name: 'aion_echo', description: 'eco', parameters: { type: 'object' } }]);
  });

  it('classifica as falhas: chave, serviço fora do ar, recusa do provedor, stream quebrado ou grande demais', async () => {
    const run = (key: string, protocol: ChatProtocol = 'chat_completions') => outcome(drain(client().streamChat(key, protocol, request(protocol))));
    expect(await run('invalid-key')).toBe('PROVIDER_KEY_INVALID');
    expect(await run('forbidden-key')).toBe('PROVIDER_KEY_INVALID');
    expect(await run('leaky-key')).toBe('PROVIDER_KEY_INVALID');
    expect(await run('down-key')).toBe('PROVIDER_UNAVAILABLE');
    // O modelo não é servido neste caminho: o provedor recusa (404), e quem chama tenta outro protocolo.
    const wrongEndpoint = drain(client().streamChat('valid-key', 'messages', request('messages', { model: 'glm-5.1' })));
    expect(await outcome(wrongEndpoint)).toBe('ChatRejected');
    // 200 que não é SSE (corpo HTML) e corpo acima do limite: stream fora do formato.
    expect(await run('html-key')).toBe('ChatStreamError');
    expect(await run('huge-key')).toBe('ChatStreamError');
    // Redirecionamento nunca é seguido.
    const before = upstreams.requests.length;
    expect(await run('redirect-key')).toBe('PROVIDER_UNAVAILABLE');
    expect(upstreams.requests.slice(before)).toHaveLength(1);
    // Prazo: um modelo que não responde vira indisponível sem prender a chamada.
    const started = Date.now();
    const slow = createOpenCodeGoClient({ baseUrl: upstreams.opencodeGoBaseUrl, chatTimeoutMs: 300 });
    expect(await outcome(drain(slow.streamChat('valid-key', 'chat_completions', request('chat_completions', { model: 'slow-model' }))))).toBe('PROVIDER_UNAVAILABLE');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('o erro de recusa não carrega o corpo do provedor e o de chave não ecoa a chave', async () => {
    const error = await drain(client().streamChat('leaky-key-9999', 'chat_completions', request('chat_completions'))).catch((caught: unknown) => caught);
    expect(String(error)).not.toContain('leaky-key-9999');
    const rejected = await drain(client().streamChat('valid-key', 'messages', request('messages', { model: 'glm-5.1' }))).catch((caught: unknown) => caught);
    expect(rejected).toBeInstanceOf(ChatRejected);
    expect(String(rejected)).not.toContain('not supported');
  });

  it('stream cortado antes do evento final é erro de formato, e parar de ler cancela a conexão', async () => {
    const truncated = createOpenCodeGoClient({
      baseUrl: 'http://127.0.0.1:1',
      fetchImpl: async () =>
        new Response(streamOf('data: {"choices":[{"delta":{"content":"meia"}}]}\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    });
    const stream = truncated.streamChat('valid-key', 'chat_completions', request('chat_completions'));
    expect((await stream.next()).value).toEqual({ type: 'text', text: 'meia' });
    await expect(stream.next()).rejects.toBeInstanceOf(ChatStreamError);

    // Consumidor que desiste na primeira mensagem: a conexão é cancelada e nada fica pendurado.
    let cancelled = false;
    const endless = createOpenCodeGoClient({
      baseUrl: 'http://127.0.0.1:1',
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        ),
    });
    const early = endless.streamChat('valid-key', 'chat_completions', request('chat_completions'));
    expect((await early.next()).value).toMatchObject({ type: 'text' });
    await early.return(undefined);
    expect(cancelled).toBe(true);
  });
});

describe('imagem nos tres protocolos', () => {
  it.each([['chat_completions', 'vision-model'], ['messages', 'vision-wrong'], ['responses', 'vision-unstable']] as const)('serializa JPEG em %s sem perder corpo grande', async (protocol, model) => {
    const client = createOpenCodeGoClient({ baseUrl: upstreams.opencodeGoBaseUrl });
    const base64 = IMAGE_PROBE_BASE64 + 'A'.repeat(600_000);
    await drain(client.streamChat('valid-key-image', protocol, { model, sessionId: 'image-format-test', turns: [{ role: 'user', text: 'cor?', images: [{ mediaType: 'image/jpeg', base64 }] }], maxTokens: 1024 })).catch(() => undefined);
    const body = upstreams.requests.at(-1)?.body as Record<string, unknown>;
    const items = (protocol === 'responses' ? body.input : body.messages) as { content: Record<string, unknown>[] }[];
    const parts = items.flatMap((item) => item.content);
    // No messages a imagem é o último bloco da última mensagem, então leva a marca de cache (A9, phase 12); o resto do bloco é o de sempre.
    if (protocol === 'messages') expect(parts.find((part) => part.type === 'image')).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 }, cache_control: { type: 'ephemeral' } });
    else if (protocol === 'responses') expect(parts.find((part) => part.type === 'input_image')).toEqual({ type: 'input_image', image_url: `data:image/jpeg;base64,${base64}` });
    else expect(parts.find((part) => part.type === 'image_url')).toEqual({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } });
  });
  it.each([400, 401, 403, 404, 500])('erro HTTP %i generico nunca vira false', async (status) => {
    const client = createOpenCodeGoClient({ baseUrl: 'https://provider.test', fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'generic error' } }), { status }) });
    await expect(runImageTest({ provider: client, apiKey: 'private-test-key', model: 'm', protocol: 'chat_completions' })).rejects.toMatchObject({ code: 'MODEL_IMAGE_CHECK_FAILED' });
  });
  it('resposta vazia e transporte falho permanecem sem resultado', async () => {
    const client = createOpenCodeGoClient({ baseUrl: upstreams.opencodeGoBaseUrl });
    await expect(runImageTest({ provider: client, apiKey: 'valid-key-image', model: 'mute-model', protocol: 'chat_completions' })).rejects.toMatchObject({ code: 'MODEL_IMAGE_CHECK_FAILED' });
    const failing = createOpenCodeGoClient({ baseUrl: 'https://provider.test', fetchImpl: async () => { throw new Error('network'); } });
    await expect(runImageTest({ provider: failing, apiKey: 'private-test-key', model: 'm', protocol: 'chat_completions' })).rejects.toMatchObject({ code: 'MODEL_IMAGE_CHECK_FAILED' });
  });
});

describe('cliente de chat da Anthropic: só messages, só x-api-key e a versão', () => {
  const client = () => createAnthropicClient({ baseUrl: upstreams.anthropicBaseUrl, chatTimeoutMs: 1_000 });
  const MODEL = 'anthropic/claude-haiku-5-5';
  const request = (extra: Partial<ChatRequest> = {}): ChatRequest => ({ model: MODEL, sessionId: 'sessao-de-teste', turns: [{ role: 'user', text: 'oi' }], maxTokens: 64, ...extra });
  const TOOL = { name: 'aion_echo', description: 'eco', parameters: { type: 'object' } };
  const SSE = (...events: Record<string, unknown>[]): string => events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  const STOP = [{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }, { type: 'message_stop' }];

  /** Cliente cujo `fetch` registra cabeçalhos e corpo do pedido e responde o stream dado. */
  function spy(stream: string): { client: ReturnType<typeof createAnthropicClient>; sent: { url: string; headers: Headers; body: Record<string, unknown> }[] } {
    const sent: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const spied = createAnthropicClient({
      baseUrl: 'https://anthropic.invalido/v1',
      fetchImpl: async (input, init) => {
        sent.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return new Response(streamOf(stream), { status: 200 });
      },
    });
    return { client: spied, sent };
  }

  it('o chat chega pelo servidor falso com o id local, a chave em x-api-key e a versão, sem Bearer nem sessão do OpenCode, e termina em done', async () => {
    const before = upstreams.requests.length;
    const events = await drain(client().streamChat('valid-key', 'messages', request()));
    expect(events.filter((event) => event.type === 'text').map((event) => (event as { text: string }).text).join('')).toBe('ok');
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'stop' });
    // Com ferramenta oferecida, o modelo falso chama a de eco.
    const withTool = await drain(client().streamChat('valid-key', 'messages', request({ tools: [TOOL] })));
    expect(withTool.find((event) => event.type === 'tool_call')).toMatchObject({ name: 'aion_echo' });
    expect(upstreams.requests.slice(before)).toEqual([
      expect.objectContaining({ service: 'anthropic', method: 'POST', path: '/anthropic/v1/messages', key: 'valid-key', model: 'claude-haiku-5-5', tools: false, anthropicVersion: '2023-06-01', bearer: false }),
      expect.objectContaining({ service: 'anthropic', model: 'claude-haiku-5-5', tools: true }),
    ]);
    expect(upstreams.requests.slice(before).every((entry) => entry.sessionId === undefined)).toBe(true);
  });

  it('A18: cabeçalhos só da Anthropic e corpo sem amostragem, tool_choice nem thinking; o effort vai em output_config.effort e Padrão não manda configuração', async () => {
    const turns: ChatTurn[] = [
      { role: 'system', text: 'Regras' },
      { role: 'user', text: 'oi' },
      { role: 'assistant', text: '', toolCalls: [{ id: 'toolu_1', name: 'aion_echo', arguments: '{"text":"ok"}' }] },
      { role: 'tool', callId: 'toolu_1', name: 'aion_echo', text: 'ok' },
    ];
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', undefined]) {
      const { client: spied, sent } = spy(SSE(...STOP));
      await drain(spied.streamChat('chave-de-teste', 'messages', request({ turns, tools: [TOOL], ...(effort ? { effort } : {}) })));
      const [one] = sent;
      expect(one!.url).toBe('https://anthropic.invalido/v1/messages');
      expect([...one!.headers.keys()].sort(), String(effort)).toEqual(['accept', 'anthropic-version', 'content-type', 'x-api-key']);
      expect(one!.headers.get('x-api-key')).toBe('chave-de-teste');
      expect(one!.headers.get('anthropic-version')).toBe('2023-06-01');
      for (const forbidden of ['temperature', 'top_p', 'top_k', 'tool_choice', 'thinking']) expect(one!.body, `${String(effort)} ${forbidden}`).not.toHaveProperty(forbidden);
      expect(one!.body.model).toBe('claude-haiku-5-5'); // o id local, sem o prefixo do produto
      expect(one!.body.output_config, String(effort)).toEqual(effort ? { effort } : undefined);
      // O histórico da chamada de ferramenta não leva nenhum bloco de raciocínio.
      const blocks = (one!.body.messages as { content: { type: string }[] }[]).flatMap((message) => message.content.map((block) => block.type));
      expect(blocks).toEqual(['text', 'tool_use', 'tool_result']);
    }
  });

  it('A19: os blocos thinking da resposta (com a assinatura) não viram evento nem voltam no pedido seguinte; só texto, ferramenta, uso e fim passam', async () => {
    const stream = SSE(
      { type: 'message_start', message: { usage: { input_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 100, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'raciocínio privado' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'assinatura' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'pronto' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_9', name: 'aion_echo', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"text":"ok"}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
      { type: 'message_stop' },
    );
    const { client: spied } = spy(stream);
    const events = await drain(spied.streamChat('chave', 'messages', request({ tools: [TOOL] })));
    expect(events).toEqual([
      { type: 'text', text: 'pronto' },
      { type: 'tool_call', id: 'toolu_9', name: 'aion_echo', arguments: '{"text":"ok"}' },
      // A17: a entrada soma o que não passou pelo cache, a leitura e a gravação; as duas últimas seguem à parte para o relatório de custo.
      { type: 'usage', usage: { inputTokens: 1005, cachedTokens: 900, cacheWriteTokens: 100, outputTokens: 20 } },
      { type: 'done', reason: 'stop' },
    ]);
    expect(JSON.stringify(events)).not.toContain('raciocínio privado');
    expect(JSON.stringify(events)).not.toContain('assinatura');
  });

  it('só o protocolo messages existe: os outros dois são recusados como "este provedor não serve este formato" (404), sem nenhum pedido', async () => {
    const { client: spied, sent } = spy(SSE(...STOP));
    for (const protocol of ['chat_completions', 'responses'] as const) {
      await expect(drain(spied.streamChat('chave', protocol, request()))).rejects.toMatchObject({ name: 'ChatRejected', status: 404 });
    }
    expect(sent).toHaveLength(0);
  });

  it('o corpo de erro nunca é repassado e as recusas se classificam: chave, indisponibilidade, effort ou limite de saída que o modelo não aceita', async () => {
    expect(await outcome(drain(client().streamChat('invalid-key', 'messages', request())))).toBe('PROVIDER_KEY_INVALID');
    expect(await outcome(drain(client().streamChat('forbidden-key', 'messages', request())))).toBe('PROVIDER_KEY_INVALID');
    expect(await outcome(drain(client().streamChat('down-key', 'messages', request())))).toBe('PROVIDER_UNAVAILABLE');
    expect(await outcome(drain(client().streamChat('limited-key', 'messages', request())))).toBe('PROVIDER_UNAVAILABLE');
    // O Haiku 4.5 não aceita o parâmetro de effort, e max_tokens acima do limite do modelo (64.000) é recusado: as duas são recusa do pedido (ChatRejected), nunca da chave.
    expect(await outcome(drain(client().streamChat('valid-key', 'messages', request({ model: 'anthropic/claude-haiku-4-5', effort: 'high' }))))).toBe('ChatRejected');
    expect(await outcome(drain(client().streamChat('valid-key', 'messages', request({ model: 'anthropic/claude-haiku-4-5', maxTokens: 64_001 }))))).toBe('ChatRejected');
    expect(await outcome(drain(client().streamChat('valid-key', 'messages', request({ model: 'anthropic/claude-haiku-4-5', maxTokens: 64_000 }))))).toBe('ok');
    const refusal = await drain(client().streamChat('leaky-chave-secreta', 'messages', request())).catch((error: unknown) => error as Error);
    expect(String((refusal as Error).message)).not.toContain('leaky-chave-secreta');
  });

  it('stream cortado antes do evento final é erro de formato, e um erro no meio do stream também', async () => {
    const cut = spy(SSE({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, ));
    expect(await outcome(drain(cut.client.streamChat('chave', 'messages', request())))).toBe('ChatStreamError');
    const mid = spy(SSE({ type: 'message_start', message: { usage: { input_tokens: 1 } } }, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
    expect(await outcome(drain(mid.client.streamChat('chave', 'messages', request())))).toBe('ChatStreamError');
  });
});

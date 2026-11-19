// Prova da sonda de validação da chave do OpenCode Go (R8 da review do Marco 1; aceite A3; decisão do dono de 2026-10-01).
// O cliente é o real (`createOpenCodeGoClient`) falando com o provedor falso por HTTP, então o que se prova é o comportamento
// observável: o que a sonda envia, o que ela decide a cada resposta e quantas chamadas custa. O cenário que originou o achado é
// a chave `ghost...`: a listagem de modelos a aceita (como o provedor real) e só o chat a recusa.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '../errors';
import { ChatRejected, ChatStreamError, type ChatEvent } from '../models/chat-protocols';
import { startFakeUpstreams, type FakeUpstreams } from '../testing/fake-upstreams';
import { createAnthropicClient } from './anthropic';
import { ANTHROPIC_PROBE_MODEL, PROBE_MAX_MODELS, PROBE_MAX_TOKENS, probeAnthropicKey, probeProviderKey } from './key-probe';
import { createOpenCodeGoClient, type ProviderClient } from './opencode-go';

/**
 * Chaves FALSAS de teste: só o prefixo importa (o provedor falso escolhe o cenário por ele). O texto "key" fica fora dos valores de
 * propósito: com ele, a regra `generic-api-key` do gitleaks (que bloqueia o CI) confunde estes literais com segredos.
 */
const VALID = 'valid-probe-1111';
const GHOST = 'ghost-probe-2222';
const INVALID = 'invalid-probe-3333';
const FORBIDDEN = 'forbidden-probe-4444';
const DOWN = 'down-probe-5555';
const SLOW = 'slow-probe-6666';

let upstreams: FakeUpstreams;
beforeAll(async () => {
  upstreams = await startFakeUpstreams();
});
afterAll(async () => {
  await upstreams.stop();
});

/** Cliente real; o prazo curto de chat só serve ao caso de provedor que não responde. */
const provider = () => createOpenCodeGoClient({ baseUrl: upstreams.opencodeGoBaseUrl, timeoutMs: 2_000, chatTimeoutMs: 500 });

/** Resultado da sonda como texto: `verified`, `unverified` ou o código do `DomainError` lançado. */
const verdict = (apiKey: string, models: string[]): Promise<string> =>
  probeProviderKey({ provider: provider(), apiKey, models }).then(
    (result) => result,
    (error: unknown) => (error instanceof DomainError ? error.code : `inesperado: ${String(error)}`),
  );

/** Chamadas de chat que o provedor falso recebeu desde `since`, na ordem. */
const chatCalls = (since: number) => upstreams.requests.slice(since).filter((request) => request.path.endsWith('/chat/completions'));

describe('sonda da chave do provedor', () => {
  it('chave válida: UMA chamada de chat mínima em chat_completions, com sessão, e só o primeiro modelo é usado', async () => {
    const before = upstreams.requests.length;
    expect(await verdict(VALID, ['glm-5.1', 'glm-5.3-flash'])).toBe('verified');

    const calls = chatCalls(before);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', key: VALID, model: 'glm-5.1' });
    expect(calls[0]?.sessionId).toMatch(/^[0-9a-f-]{36}$/); // o provedor real recusa o chat sem `x-opencode-session`
    expect(calls[0]?.body).toMatchObject({ max_tokens: PROBE_MAX_TOKENS });
    expect(calls[0]?.tools).toBe(false);
    // Nenhuma outra chamada além do chat: a listagem não faz parte da sonda.
    expect(upstreams.requests.slice(before)).toHaveLength(1);
  });

  it('chave que a listagem pública aceita mas o chat recusa (401 ou 403) é recusada, sem tentar outros modelos', async () => {
    for (const key of [GHOST, INVALID, FORBIDDEN]) {
      const before = upstreams.requests.length;
      expect(await verdict(key, ['glm-5.1', 'glm-5.3-flash', 'deepseek-v4-pro'])).toBe('PROVIDER_KEY_INVALID');
      expect(chatCalls(before)).toHaveLength(1);
    }
  });

  it('provedor fora do ar, resposta fora do formato HTTP ou sem responder: indisponível, nunca "chave aceita"', async () => {
    expect(await verdict(DOWN, ['glm-5.1'])).toBe('PROVIDER_UNAVAILABLE');
    const started = Date.now();
    expect(await verdict(SLOW, ['glm-5.1'])).toBe('PROVIDER_UNAVAILABLE');
    expect(Date.now() - started).toBeLessThan(3_000);
    // Prazo geral da sonda: um sinal já estourado interrompe a chamada em curso.
    const aborted = probeProviderKey({ provider: provider(), apiKey: VALID, models: ['glm-5.1'], signal: AbortSignal.abort() });
    await expect(aborted).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('motivo do modelo não recusa a chave: segue para o próximo modelo e, sem nenhuma resposta decisiva, a chave é aceita sem prova', async () => {
    // `broken-model` e `kimi-k2.7-code` não são servidos em chat_completions (404); `garbled-model` manda um stream quebrado.
    const before = upstreams.requests.length;
    expect(await verdict(VALID, ['broken-model', 'kimi-k2.7-code', 'glm-5.1'])).toBe('verified');
    expect(chatCalls(before).map((call) => call.model)).toEqual(['broken-model', 'kimi-k2.7-code', 'glm-5.1']);

    expect(await verdict(VALID, ['garbled-model', 'glm-5.1'])).toBe('verified');

    // Só motivos do modelo, ou lista vazia: a chave não é recusada (decisão do dono).
    expect(await verdict(VALID, ['broken-model', 'kimi-k2.7-code', 'garbled-model'])).toBe('unverified');
    expect(await verdict(VALID, [])).toBe('unverified');

    // Mas a chave errada continua sendo recusada mesmo que o primeiro modelo seja um que o protocolo não serve.
    expect(await verdict(GHOST, ['broken-model', 'glm-5.1'])).toBe('PROVIDER_KEY_INVALID');
  });

  it('limita o custo: no máximo PROBE_MAX_MODELS tentativas, e a conexão de cada uma é fechada ao decidir', async () => {
    const before = upstreams.requests.length;
    const many = ['broken-model', 'kimi-k2.7-code', 'garbled-model', 'glm-5.1', 'glm-5.3-flash'];
    expect(await verdict(VALID, many)).toBe('unverified'); // o quarto (glm-5.1) nem é tentado
    expect(chatCalls(before)).toHaveLength(PROBE_MAX_MODELS);

    // Fechamento do stream: um provedor de mentira registra se o gerador foi encerrado depois do primeiro evento.
    const events: string[] = [];
    const stub: ProviderClient = {
      listModels: () => Promise.resolve([]),
      async *streamChat(): AsyncGenerator<ChatEvent> {
        try {
          yield { type: 'text', text: 'o' };
          events.push('continuou');
          yield { type: 'done', reason: 'stop' };
        } finally {
          events.push('fechou');
        }
      },
    };
    expect(await probeProviderKey({ provider: stub, apiKey: 'qualquer', models: ['m1'] })).toBe('verified');
    expect(events).toEqual(['fechou']);

    // Erros que não são do modelo nem da chave (bug, rede) propagam sem virar "aceita".
    const broken: ProviderClient = {
      listModels: () => Promise.resolve([]),
      // eslint-disable-next-line require-yield -- gerador que só falha, para provar que o erro propaga
      async *streamChat(): AsyncGenerator<ChatEvent> {
        throw new Error('falha inesperada');
      },
    };
    await expect(probeProviderKey({ provider: broken, apiKey: 'qualquer', models: ['m1'] })).rejects.toThrow('falha inesperada');
    // E as duas classes de falha do modelo, vindas de outro provedor, também seguem adiante.
    const rejecting: ProviderClient = {
      listModels: () => Promise.resolve([]),
      async *streamChat(_key, _protocol, request): AsyncGenerator<ChatEvent> {
        if (request.model === 'a') throw new ChatRejected(400);
        if (request.model === 'b') throw new ChatStreamError('stream quebrado');
        yield { type: 'done', reason: 'stop' };
      },
    };
    expect(await probeProviderKey({ provider: rejecting, apiKey: 'qualquer', models: ['a', 'b', 'c'] })).toBe('verified');
  });
});

describe('sonda da chave da Anthropic (phase 17, SEC-08)', () => {
  /** Cliente real da Anthropic falando com o servidor falso; `chat` troca só a resposta do /messages (a listagem e o resto seguem no falso). */
  const anthropic = (chat?: () => Response): ProviderClient =>
    createAnthropicClient({
      baseUrl: upstreams.anthropicBaseUrl,
      timeoutMs: 2_000,
      chatTimeoutMs: 500,
      ...(chat ? { fetchImpl: (input, init) => (String(input).endsWith('/messages') ? Promise.resolve(chat()) : fetch(input, init)) } : {}),
    });
  const verdictOf = (apiKey: string, client: ProviderClient = anthropic()): Promise<string> =>
    probeAnthropicKey({ provider: client, apiKey }).then(
      () => 'verified',
      (error: unknown) => (error instanceof DomainError ? error.code : `inesperado: ${String(error)}`),
    );

  it('chave válida: UMA chamada de chat mínima ao Haiku pelo messages, com o id local, 16 tokens de saída, só x-api-key e a versão, sem Bearer nem sessão', async () => {
    const before = upstreams.requests.length;
    const candidate = 'valid-anthropic-probe-1111'; // sem literal em `key:` (a regra generic-api-key do gitleaks o confundiria com segredo)
    expect(await verdictOf(candidate)).toBe('verified');
    const sent = upstreams.requests.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ service: 'anthropic', method: 'POST', path: '/anthropic/v1/messages', key: candidate, model: 'claude-haiku-5-5', tools: false, anthropicVersion: '2023-06-01', bearer: false });
    expect(sent[0]!.body).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: PROBE_MAX_TOKENS, stream: true });
    expect(sent[0]!.sessionId).toBeUndefined();
    expect(ANTHROPIC_PROBE_MODEL).toBe('anthropic/claude-haiku-5-5');
  });

  it('401 e 403 recusam a chave; 408, 429, 5xx, rede e prazo são indisponibilidade; recusa 4xx do pedido e stream quebrado também não aceitam a chave (a prova é obrigatória)', async () => {
    expect(await verdictOf('invalid-anthropic-probe-2222')).toBe('PROVIDER_KEY_INVALID');
    expect(await verdictOf('forbidden-anthropic-probe-3333')).toBe('PROVIDER_KEY_INVALID');
    expect(await verdictOf('down-anthropic-probe-4444')).toBe('PROVIDER_UNAVAILABLE');
    expect(await verdictOf('limited-anthropic-probe-5555')).toBe('PROVIDER_UNAVAILABLE');
    expect(await verdictOf('slow-anthropic-probe-6666')).toBe('PROVIDER_UNAVAILABLE');
    expect(await verdictOf('valid-anthropic-probe-7777', anthropic(() => Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'x' } }, { status: 400 })))).toBe('PROVIDER_KEY_INVALID');
    expect(await verdictOf('valid-anthropic-probe-8888', anthropic(() => Response.json({ type: 'error', error: { type: 'not_found_error', message: 'model' } }, { status: 404 })))).toBe('PROVIDER_KEY_INVALID');
    expect(await verdictOf('valid-anthropic-probe-9999', anthropic(() => new Response('data: isto não é json\n\n', { status: 200 })))).toBe('PROVIDER_UNAVAILABLE');
  });

  it('A20: saldo esgotado (402 billing_error, 400 com a mensagem de saldo baixo, ou a chave de cenário) reprova a prova com PROVIDER_CREDITS_EXHAUSTED: nem chave recusada nem aceita sem prova, e nada do corpo vaza', async () => {
    const billing = { type: 'error', error: { type: 'billing_error', message: 'Your credit balance is too low to access the Anthropic API.' } };
    const lowBalance = { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing.' } };
    expect(await verdictOf('nobalance-anthropic-probe-0001')).toBe('PROVIDER_CREDITS_EXHAUSTED');
    expect(await verdictOf('valid-anthropic-probe-0002', anthropic(() => Response.json(billing, { status: 402 })))).toBe('PROVIDER_CREDITS_EXHAUSTED');
    expect(await verdictOf('valid-anthropic-probe-0003', anthropic(() => Response.json(lowBalance, { status: 400 })))).toBe('PROVIDER_CREDITS_EXHAUSTED');
    // O 402 vale mesmo sem corpo utilizável; um 400 comum (outro motivo) continua sendo recusa do pedido, ou seja, chave recusada.
    expect(await verdictOf('valid-anthropic-probe-0004', anthropic(() => new Response('', { status: 402 })))).toBe('PROVIDER_CREDITS_EXHAUSTED');
    expect(await verdictOf('valid-anthropic-probe-0005', anthropic(() => Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: too small' } }, { status: 400 })))).toBe('PROVIDER_KEY_INVALID');
    const candidate = 'valid-anthropic-probe-0006'; // sem literal em `apiKey:` (a regra generic-api-key do gitleaks o confundiria com segredo)
    const failure = await probeAnthropicKey({ provider: anthropic(() => Response.json(lowBalance, { status: 400 })), apiKey: candidate }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DomainError);
    expect(JSON.stringify([(failure as Error).message, (failure as { cause?: unknown }).cause ?? null])).not.toMatch(/credit balance|Plans/i);
  });
});

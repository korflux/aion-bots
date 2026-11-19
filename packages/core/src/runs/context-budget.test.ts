// A prova mede o adaptador real, não uma cópia aproximada da estrutura enviada ao provedor.
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { CHAT_PROTOCOLS, PROTOCOLS, type ChatRequest } from '../models/chat-protocols';
import { MAX_OUTPUT_TOKENS, contextEnvelope, estimateChatPayload, fitToolCatalog } from './context-budget';

describe('context-budget', () => {
  // A1 (phase 12, F1): a reserva de saída é o menor entre o teto base, 25% da janela efetiva e a capacidade de saída confirmada; o orçamento de entrada é o que sobra depois dela e da margem.
  // Os números são os da spec, escritos à mão (e não recalculados pela mesma fórmula), para o teste reprovar uma regra trocada.
  it('A1: reserva de saída por janela e por capacidade confirmada, com o orçamento de entrada que sobra', () => {
    expect(MAX_OUTPUT_TOKENS).toBe(32_768);
    for (const [window, outputReserve, inputBudget] of [[65536, 16384, 47104], [131072, 32768, 96256], [262144, 32768, 227328], [524288, 32768, 489472]] as const) {
      expect(contextEnvelope(window, MAX_OUTPUT_TOKENS)).toEqual({ window, outputReserve, margin: 2048, inputBudget });
    }
    // Capacidade de saída confirmada menor que o resto limita a reserva e devolve o espaço à entrada; maior ou igual não a aumenta.
    expect(contextEnvelope(262144, MAX_OUTPUT_TOKENS, 4096)).toEqual({ window: 262144, outputReserve: 4096, margin: 2048, inputBudget: 256_000 });
    expect(contextEnvelope(65536, MAX_OUTPUT_TOKENS, 4096).outputReserve).toBe(4096);
    expect(contextEnvelope(65536, MAX_OUTPUT_TOKENS, 384_000).outputReserve).toBe(16384);
    expect(contextEnvelope(524288, MAX_OUTPUT_TOKENS, 131_072).outputReserve).toBe(32768);
    // Janela efetiva fora das opções (a capacidade de contexto do modelo limitando a escolha): 25% arredondado para baixo, e o teto base explícito menor ainda manda.
    expect(contextEnvelope(100_001, MAX_OUTPUT_TOKENS).outputReserve).toBe(25_000);
    expect(contextEnvelope(65536, 8192).outputReserve).toBe(8192);
    // O orçamento de entrada nunca fica negativo, mesmo numa janela absurdamente pequena.
    expect(contextEnvelope(1000, MAX_OUTPUT_TOKENS)).toMatchObject({ outputReserve: 250, inputBudget: 0 });
  });

  it.each(CHAT_PROTOCOLS)('conta corpo, schemas, escapes e pares no protocolo %s', (protocol) => {
    const request: ChatRequest = { model: 'opencode/deepseek-v4.1-flash', sessionId: 'private-header-only', maxTokens: 8192, turns: [
      { role: 'system', text: 'Regras' }, { role: 'user', text: '漢字🐾\\\n"'.repeat(200) },
      { role: 'assistant', text: '', toolCalls: [{ id: 'call', name: 'query', arguments: '{"value":"á"}' }] },
      { role: 'tool', callId: 'call', name: 'query', text: '{"rows":["é"]}' },
    ], tools: [{ name: 'query', description: 'Dados', parameters: { type: 'object', properties: { value: { type: 'string' } } } }] };
    const estimate = estimateChatPayload(request, protocol);
    expect(estimate.payloadBytes).toBe(Buffer.byteLength(JSON.stringify(PROTOCOLS[protocol].body(request)), 'utf8'));
    expect(estimate.estimatedInputTokens).toBeGreaterThan(estimate.payloadBytes);
    expect(estimateChatPayload({ ...request, sessionId: 'different' }, protocol)).toEqual(estimate);
    expect(estimate.reliable).toBe(true);
  });

  it('com o teto base explícito de 8.192 a reserva nunca o ultrapassa nos quatro presets (64k a 512k), incluindo o teto visual conhecido', () => {
    for (const window of [65536, 131072, 262144, 524288]) expect(contextEnvelope(window, 8192)).toEqual({ window, outputReserve: 8192, margin: 2048, inputBudget: window - 8192 - 2048 });
    // Janela efetiva menor que todo preset (capacidade confirmada do modelo limitando a escolha): a conta é a mesma, a função não depende da lista de opções.
    expect(contextEnvelope(32768, 8192)).toEqual({ window: 32768, outputReserve: 8192, margin: 2048, inputBudget: 22528 });
    expect(contextEnvelope(32768, 8192, 4096).outputReserve).toBe(4096);
    const image = estimateChatPayload({ model: 'opencode/deepseek-v4.1-flash', sessionId: 'test', maxTokens: 8192, turns: [{ role: 'user', text: 'Imagem', images: [{ mediaType: 'image/jpeg', base64: 'eA==' }] }] }, 'chat_completions');
    expect(image).toMatchObject({ reliable: true, images: 1, imageTokens: 1024 });
  });

  it('conta múltiplas imagens pelo teto visual e preserva integralmente texto, schemas e payload enviado', () => {
    const request: ChatRequest = { model: 'opencode/deepseek-v4.1-flash', sessionId: 'test', maxTokens: 8192, turns: [
      { role: 'system', text: 'Regras\\"漢字' }, { role: 'user', text: 'Compare duas imagens', images: [
        { mediaType: 'image/jpeg', base64: Buffer.alloc(40_000, 1).toString('base64') },
        { mediaType: 'image/jpeg', base64: Buffer.alloc(70_000, 2).toString('base64') },
      ] },
    ], tools: [{ name: 'query', description: 'Descrição UTF-8', parameters: { type: 'object', properties: { value: { type: 'string' } } } }] };
    const bodyBefore = JSON.stringify(PROTOCOLS.chat_completions.body(request));
    const hashBefore = createHash('sha256').update(bodyBefore).digest('hex');
    const textualRequest: ChatRequest = { ...request, turns: request.turns.map((turn) => turn.role === 'user' ? { ...turn, images: turn.images?.map((image) => ({ ...image, base64: '' })) } : turn) };
    const textualBytes = Buffer.byteLength(JSON.stringify(PROTOCOLS.chat_completions.body(textualRequest)), 'utf8');
    const estimate = estimateChatPayload(request, 'chat_completions');
    expect(estimate).toMatchObject({ reliable: true, images: 2, imageTokens: 2048, payloadBytes: textualBytes });
    expect(estimate.estimatedInputTokens).toBe(textualBytes + estimate.framingTokens + 2048);
    expect(estimate.estimatedInputTokens).toBeLessThan(contextEnvelope(32768, 8192).inputBudget);
    expect(estimateChatPayload({ ...request, turns: [...request.turns, { role: 'user', text: 'é'.repeat(500) }] }, 'chat_completions').payloadBytes).toBeGreaterThan(textualBytes + 1000);
    expect(createHash('sha256').update(JSON.stringify(PROTOCOLS.chat_completions.body(request))).digest('hex')).toBe(hashBefore);
    expect(JSON.stringify(PROTOCOLS.chat_completions.body(request))).toBe(bodyBefore);
  });

  it('mantém imagem sem teto confiável para outro provedor, ID ou protocolo', () => {
    const request: ChatRequest = { model: 'opencode/deepseek-v4.1-flash', sessionId: 'test', maxTokens: 8192, turns: [{ role: 'user', text: 'Imagem', images: [{ mediaType: 'image/jpeg', base64: 'YWJjZA==' }] }] };
    for (const protocol of ['responses', 'messages'] as const) expect(estimateChatPayload(request, protocol)).toMatchObject({ reliable: false, images: 1, imageTokens: 0 });
    expect(estimateChatPayload(request, 'chat_completions', 'other')).toMatchObject({ reliable: false, imageTokens: 0 });
    for (const model of ['opencode/vision-model', 'deepseek-v4.1', 'deepseek-v4.1-flash-other']) expect(estimateChatPayload({ ...request, model }, 'chat_completions')).toMatchObject({ reliable: false, imageTokens: 0 });
    expect(estimateChatPayload(request, 'messages').payloadBytes).toBe(Buffer.byteLength(JSON.stringify(PROTOCOLS.messages.body(request)), 'utf8'));
  });

  it('não descarta imagem nem texto para caber: o teto visual ainda pode exceder a janela após descarregar ferramentas', () => {
    const request: ChatRequest = { model: 'opencode/deepseek-v4.1-flash', sessionId: 'test', maxTokens: 8192, turns: [{ role: 'system', text: 'Regras' }, { role: 'user', text: 'Imagem'.repeat(3000), images: Array.from({ length: 8 }, () => ({ mediaType: 'image/jpeg' as const, base64: 'YWJjZA==' })) }], tools: [{ name: 'large', description: 'x'.repeat(5000), parameters: { type: 'object' } }] };
    const inputBudget = contextEnvelope(32768, 8192).inputBudget;
    const fitted = fitToolCatalog(request, 'chat_completions', inputBudget);
    expect(fitted.omitted).toEqual(['large']);
    expect(estimateChatPayload(fitted.request, 'chat_completions').estimatedInputTokens).toBeGreaterThan(inputBudget);
    expect(fitted.request.turns.at(-1)).toEqual(request.turns[1]);
    expect(request.tools).toHaveLength(1);
  });

  // A5/A8 (phase 12, F2): a ordem de saída é a de quem chama, sem uso recente nem escala. Uso recente e escala mudam de uma etapa para a outra e mudariam o conjunto publicado (o prefixo em
  // cache); a conta é só sobre o que está gravado. (Antes: "descarrega pelo uso mais antigo e a última seleção sai por último", que o catálogo estável substituiu.)
  it('descarrega as opcionais na ordem recebida, sem olhar o uso recente: o mesmo catálogo e o mesmo orçamento dão sempre o mesmo resultado', () => {
    const tool = (name: string) => ({ name, description: 'x'.repeat(3000), parameters: { type: 'object' } });
    const request: ChatRequest = { model: 'opencode/glm-5.1', sessionId: 'test', maxTokens: 8192, turns: [
      { role: 'system', text: 'Regras' }, { role: 'user', text: 'Pedido' },
      { role: 'assistant', text: '', toolCalls: [{ id: '1', name: 'recent', arguments: '{}' }] }, { role: 'tool', callId: '1', name: 'recent', text: 'ok' },
    ], tools: [tool('discover_tools'), tool('read_activity'), tool('oldest'), tool('recent'), tool('newest')] };
    const base = estimateChatPayload({ ...request, tools: request.tools!.slice(0, 2) }, 'chat_completions').estimatedInputTokens;
    // Cabem as duas portas e UMA ferramenta a mais: saem as duas primeiras da lista, mesmo a `recent`, que o histórico mostra em uso, e fica a última.
    const budget = base + 4200;
    const fitted = fitToolCatalog(request, 'chat_completions', budget);
    expect(fitted.omitted).toEqual(['oldest', 'recent']);
    expect(fitted.request.tools!.map((item) => item.name)).toEqual(['discover_tools', 'read_activity', 'newest']);
    // O histórico não decide: o mesmo catálogo sem o uso de `recent` sai igual.
    expect(fitToolCatalog({ ...request, turns: request.turns.slice(0, 2) }, 'chat_completions', budget).omitted).toEqual(['oldest', 'recent']);
    // Quem chama decide a ordem: com a lista reordenada sai outro par.
    const [, , a, b, c] = request.tools!;
    expect(fitToolCatalog({ ...request, tools: [...request.tools!.slice(0, 2), c!, a!, b!] }, 'chat_completions', budget).omitted).toEqual(['newest', 'oldest']);
  });

  it('ferramentas core nunca saem: a opcional cede antes de qualquer core e, com o piso acima do teto, só as opcionais saem', () => {
    const tool = (name: string) => ({ name, description: 'x'.repeat(3000), parameters: { type: 'object' } });
    // As core nunca foram usadas e vêm primeiro na lista: se a ordem decidisse por elas, seriam as primeiras a sair. A opcional recente foi usada na rodada.
    const request: ChatRequest = { model: 'opencode/glm-5.1', sessionId: 'test', maxTokens: 8192, turns: [
      { role: 'system', text: 'Regras' }, { role: 'user', text: 'Pedido' },
      { role: 'assistant', text: '', toolCalls: [{ id: '1', name: 'optional_recent', arguments: '{}' }] }, { role: 'tool', callId: '1', name: 'optional_recent', text: 'ok' },
    ], tools: [tool('discover_tools'), tool('read_activity'), tool('core_a'), tool('core_b'), tool('optional_old'), tool('optional_recent'), tool('selected')] };
    const core = ['core_a', 'core_b'];
    const floor = estimateChatPayload({ ...request, tools: request.tools!.slice(0, 4) }, 'chat_completions').estimatedInputTokens;
    const names = (fitted: ReturnType<typeof fitToolCatalog>) => fitted.request.tools!.map((item) => item.name);

    // Cabem as portas, as duas core e UMA opcional: as duas primeiras da lista saem (optional_old, optional_recent) e a última fica.
    const roomForOne = fitToolCatalog(request, 'chat_completions', floor + 4200, core);
    expect(roomForOne.omitted).toEqual(['optional_old', 'optional_recent']);
    expect(names(roomForOne)).toEqual(['discover_tools', 'read_activity', 'core_a', 'core_b', 'selected']);

    // O piso (portas + core) já passa do orçamento: todas as opcionais saem, nenhuma core, e o pedido segue acima do teto (o histórico é que cede, no executor).
    const belowFloor = fitToolCatalog(request, 'chat_completions', floor - 1, core);
    expect(belowFloor.omitted).toEqual(['optional_old', 'optional_recent', 'selected']);
    expect(names(belowFloor)).toEqual(['discover_tools', 'read_activity', 'core_a', 'core_b']);
    expect(estimateChatPayload(belowFloor.request, 'chat_completions').estimatedInputTokens).toBeGreaterThan(floor - 1);
    // Orçamento zero (recarga após recusa do provedor): continua valendo.
    expect(names(fitToolCatalog(request, 'chat_completions', 0, core))).toEqual(['discover_tools', 'read_activity', 'core_a', 'core_b']);
    // Sem o conjunto core (catálogo de testes), tudo o que não é porta segue removível como antes.
    expect(names(fitToolCatalog(request, 'chat_completions', 0))).toEqual(['discover_tools', 'read_activity']);
  });
});

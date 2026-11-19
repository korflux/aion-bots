// Protocolos de chat do OpenCode Go: o provedor serve cada modelo em UM de três formatos de API, e o catálogo
// (`GET /models`) não diz qual. Este módulo isola as diferenças: para cada protocolo sabe montar a requisição e
// converter o streaming em poucos eventos normalizados (texto, chamada de ferramenta, uso de tokens, fim). O teste de modelo (T5)
// descobre qual protocolo cada modelo aceita, e o motor de execução (T6) chama o modelo nesse protocolo.
//
// O QUE É CONFIRMADO E O QUE É SUPOSTO (documentação pública do OpenCode, consultada ao implementar T5):
// - Confirmado: os três caminhos sob a base do Go (`/chat/completions`, `/responses`, `/messages`) e que cada modelo
//   pertence a um deles; chat/completions e responses são compatíveis com a OpenAI, messages com a Anthropic.
// - Contrato dos adaptadores: os formatos de streaming seguem os oficiais da OpenAI e da Anthropic (eventos abaixo); a autenticação do
//   /messages aceita Bearer (mandamos também `x-api-key`, que o SDK da Anthropic usa); o parâmetro de effort é
//   `reasoning_effort` (chat/completions), `reasoning.effort` (responses) e `output_config.effort` (messages). A validação
//   técnica real (`pnpm validate:provider`) confere esses contratos por modelo, e qualquer ajuste é só aqui.
// A conversa é descrita por turnos normalizados (`ChatTurn`: sistema, dono, assistente com chamadas de ferramenta e
// resultado de ferramenta) e cada adaptador os converte para o formato do seu protocolo. Assim o motor de execução (T6)
// e o teste de modelo (T5) montam a mesma estrutura, e só este arquivo conhece as diferenças entre os formatos.
import { z } from 'zod';
import type { SseEvent } from './sse';

export const CHAT_PROTOCOLS = ['chat_completions', 'messages', 'responses'] as const;
export type ChatProtocol = (typeof CHAT_PROTOCOLS)[number];

/** Ferramenta oferecida ao modelo: nome, descrição e JSON Schema dos argumentos. */
export interface ChatTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Chamada de ferramenta feita pelo modelo: `arguments` é o JSON como texto (o que o protocolo devolve e espera de volta). */
export interface ChatToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Um turno da conversa enviada ao modelo, igual nos três protocolos. */
export type ChatTurn =
  | { role: 'system'; text: string }
  | { role: 'user'; text: string; images?: { mediaType: 'image/jpeg'; base64: string }[] }
  | { role: 'assistant'; text: string; toolCalls: ChatToolCall[] }
  | { role: 'tool'; callId: string; name: string; text: string };

export interface ChatRequest {
  model: string;
  /**
   * Identificador ESTÁVEL da conversa, enviado no cabeçalho `x-opencode-session` (não entra no corpo). O OpenCode Go
   * responde 400 `MissingSessionID` sem ele, em qualquer modelo e protocolo (observado com a chave real em 2026-09-30,
   * embora a documentação o chame de "recomendado"). Serve ao roteamento e ao cache de prompt: manter o mesmo valor
   * durante toda a conversa. Obrigatório no tipo para nenhum chamador esquecê-lo.
   */
  sessionId: string;
  turns: ChatTurn[];
  tools?: ChatTool[];
  /** Nível de effort (vocabulário de `EFFORT_LEVELS`; o teste também sonda um valor inválido de propósito). */
  effort?: string;
  maxTokens: number;
  /** Desliga apenas o metadado recusado por um modelo, preservando o chat. */
  includeUsage?: boolean;
  /**
   * Só a execução do motor (etapa do modelo e resumo) liga: um 429 do OpenCode Go, que chega antes de qualquer evento, é esperado e repetido (até 2 vezes, dentro do prazo, ver `opencode-go.ts`).
   * O teste de modelo e a sonda da chave não ligam: lá o 429 é o resultado da sonda, e esperar à toa só a atrasaria.
   */
  retryOnRateLimit?: boolean;
}

/**
 * Contadores opcionais sem conteúdo. Entrada inclui tokens lidos ou escritos no cache. `cachedTokens` é a LEITURA do cache e `cacheWriteTokens` a GRAVAÇÃO
 * (só o protocolo `messages` a informa, em `cache_creation_input_tokens`; o cache dos outros dois protocolos é automático e não tem gravação cobrada à parte):
 * as duas já estão dentro de `inputTokens`, que continua o total do pedido para a ocupação de contexto (CTX-08). `outputTokens` é sempre o total de
 * saída que o provedor informou e `reasoningTokens` é a fatia dele gasta em raciocínio: nunca se soma ao total (o
 * provedor já a conta dentro dele e a cobra como saída). Ausente = o provedor não informou, o que não é o mesmo que 0.
 */
export interface ChatUsage {
  inputTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

/** Só contagens inteiras não negativas entram no log; valores externos nunca viram texto. */
const count = (input: unknown): number | undefined => typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 ? input : undefined;

/**
 * Uso do `messages` a partir do `message_start` e do `message_delta` final, campo a campo (A10): entrada, leitura e gravação de cache informadas no início prevalecem sobre as do
 * final (alguns gateways as repetem ou zeram no evento final), e o final só preenche o que o início não informou; a saída é a do final quando ele a informa (é o total), senão a do início.
 * Mesclar o uso BRUTO, e não o já calculado, mantém o total coerente: `input_tokens` e os campos de cache somam sempre de uma mesma resolução campo a campo.
 */
function mergeMessagesUsage(start: unknown, final: unknown): Record<string, unknown> {
  const fromStart = z.record(z.string(), z.unknown()).safeParse(start), fromFinal = z.record(z.string(), z.unknown()).safeParse(final);
  const first = fromStart.success ? fromStart.data : {}, last = fromFinal.success ? fromFinal.data : {};
  const merged: Record<string, unknown> = {};
  for (const key of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) merged[key] = count(first[key]) ?? count(last[key]);
  merged.output_tokens = count(last.output_tokens) ?? count(first.output_tokens);
  return merged;
}

/** Telemetria ausente ou inválida nunca derruba uma resposta válida. */
function usageOf(raw: unknown, protocol: ChatProtocol): ChatUsage {
  const parsed = z.record(z.string(), z.unknown()).safeParse(raw);
  if (!parsed.success) return {};
  const value = parsed.data;
  const detailsAt = (key: string) => z.record(z.string(), z.unknown()).safeParse(value[key]);
  const details = detailsAt(protocol === 'chat_completions' ? 'prompt_tokens_details' : 'input_tokens_details');
  const cachedTokens = count(protocol === 'messages' ? value.cache_read_input_tokens : details.success ? details.data.cached_tokens : undefined);
  // Gravação de cache: só o `messages` a informa (`cache_creation_input_tokens`), e fica separada da leitura porque custa mais que a entrada comum (relatório de custo).
  const cacheWriteTokens = protocol === 'messages' ? count(value.cache_creation_input_tokens) : undefined;
  let inputTokens = count(value[protocol === 'chat_completions' ? 'prompt_tokens' : 'input_tokens']);
  // No `messages`, `input_tokens` é só a parte que não passou pelo cache: o total do pedido soma leitura e gravação (CTX-08).
  if (protocol === 'messages' && inputTokens !== undefined) inputTokens = count(inputTokens + (cachedTokens ?? 0) + (cacheWriteTokens ?? 0));
  const outputTokens = count(value[protocol === 'chat_completions' ? 'completion_tokens' : 'output_tokens']);
  // Raciocínio: formas oficiais `completion_tokens_details.reasoning_tokens` (chat_completions) e
  // `output_tokens_details.reasoning_tokens` (responses). ponytail: o protocolo messages não informa raciocínio e fica sem dado (nem a Anthropic nativa, que entrou no uso real na
  // phase 17: o raciocínio vem dentro de `output_tokens`), revisitar se a Anthropic passar a informar a fatia.
  const reasoning = protocol === 'messages' ? undefined : detailsAt(protocol === 'chat_completions' ? 'completion_tokens_details' : 'output_tokens_details');
  const reasoningTokens = count(reasoning?.success ? reasoning.data.reasoning_tokens : undefined);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedTokens === undefined ? {} : { cachedTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

/** O que o modelo produziu, igual nos três protocolos. */
export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'usage'; usage: ChatUsage }
  | { type: 'done'; reason: 'stop' | 'output_limit' | 'unknown' };

/** O provedor respondeu 2xx mas o conteúdo do stream não segue o formato do protocolo (JSON quebrado, erro no fluxo). */
export class ChatStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatStreamError';
  }
}

/**
 * O provedor recusou a requisição por causa dela (status 4xx que não é chave, prazo nem excesso de uso): modelo que este
 * protocolo não serve, parâmetro que ele não aceita. É o sinal do teste de modelo para tentar o próximo protocolo ou
 * dar o nível de effort como não aceito. Só status e classificação de recusa de imagem viajam aqui;
 * a classificação usa leitura limitada no transporte, sem conservar corpo externo ou mensagem.
 */
export class ChatRejected extends Error {
  readonly status: number;

  constructor(status: number, readonly rejectedImage = false, readonly rejectedContext = false) {
    super(`requisição recusada pelo provedor (${status})`);
    this.name = 'ChatRejected';
    this.status = status;
  }
}

interface ProtocolAdapter {
  /** Caminho sob a base fixa do provedor. */
  path: string;
  /** Cabeçalhos de autenticação com a chave. */
  authHeaders(apiKey: string): Record<string, string>;
  /** Corpo JSON da requisição, sempre em streaming. */
  body(request: ChatRequest): Record<string, unknown>;
  /** Parser com estado (uma chamada de ferramenta chega em pedaços): um por resposta. */
  parser(): (event: SseEvent) => ChatEvent[];
  /** O protocolo tem parâmetro de effort mapeado? */
  supportsEffort: boolean;
}

const bearer = (apiKey: string) => ({ authorization: `Bearer ${apiKey}` });

/** Versão da API do `messages` (cabeçalho `anthropic-version`): a do OpenCode Go (que repassa o formato) e a da Anthropic nativa (`credentials/anthropic.ts`) enviam a mesma. */
export const ANTHROPIC_VERSION = '2023-06-01';

/** JSON de um evento; dado quebrado é erro de formato, não falha do modelo. */
function parseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    throw new ChatStreamError('evento fora do formato JSON');
  }
}

// ---------------------------------------------------------------------------------------------
// chat/completions (compatível com a OpenAI): a maioria dos modelos (GLM, Kimi, DeepSeek, MiMo...)
// ---------------------------------------------------------------------------------------------

const chatChunkSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullish(),
        delta: z
          .object({
            content: z.string().nullish(),
            tool_calls: z
              .array(
                z.object({
                  index: z.number().int().default(0),
                  id: z.string().nullish(),
                  function: z.object({ name: z.string().nullish(), arguments: z.string().nullish() }).nullish(),
                }),
              )
              .nullish(),
          })
          .nullish(),
      }),
    )
    .default([]),
  error: z.unknown().optional(),
  usage: z.unknown().optional(),
});

/** Turno no formato de chat/completions: a chamada de ferramenta vai no `assistant` e o resultado no papel `tool`. */
function chatCompletionsMessage(turn: ChatTurn): Record<string, unknown> {
  switch (turn.role) {
    case 'user':
      if (turn.images?.length) return { role: 'user', content: [{ type: 'text', text: turn.text }, ...turn.images.map((image) => ({ type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.base64}` } }))] };
      return { role: 'user', content: turn.text };
    case 'system':
      return { role: turn.role, content: turn.text };
    case 'tool':
      return { role: 'tool', tool_call_id: turn.callId, content: turn.text };
    case 'assistant':
      return {
        role: 'assistant',
        content: turn.text === '' ? null : turn.text,
        ...(turn.toolCalls.length > 0
          ? { tool_calls: turn.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) }
          : {}),
      };
  }
}

const chatCompletions: ProtocolAdapter = {
  path: '/chat/completions',
  supportsEffort: true,
  authHeaders: bearer,
  body: ({ model, turns, tools, effort, maxTokens, includeUsage = true }) => ({
    model,
    stream: true,
    max_tokens: maxTokens,
    ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
    messages: turns.map(chatCompletionsMessage),
    ...(tools ? { tools: tools.map((tool) => ({ type: 'function', function: tool })) } : {}),
    ...(effort ? { reasoning_effort: effort } : {}),
  }),
  parser() {
    // Chamadas de ferramenta chegam em pedaços por `index`; saem completas quando o stream termina.
    let usage: ChatUsage = {};
    let reason: Extract<ChatEvent, { type: 'done' }>['reason'] = 'unknown';
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    return ({ data }) => {
      if (data.trim() === '[DONE]') {
        if (reason === 'unknown') throw new ChatStreamError('motivo terminal ausente ou desconhecido');
        const pending = reason === 'output_limit' ? [] : [...calls.values()].map((call): ChatEvent => ({ type: 'tool_call', ...call }));
        calls.clear();
        return [...pending, { type: 'usage', usage }, { type: 'done', reason }];
      }
      const chunk = chatChunkSchema.safeParse(parseJson(data));
      if (!chunk.success) throw new ChatStreamError('chunk fora do formato de chat/completions');
      if (chunk.data.error !== undefined) throw new ChatStreamError('erro no meio do stream');
      if (chunk.data.usage !== undefined) usage = usageOf(chunk.data.usage, 'chat_completions');
      const events: ChatEvent[] = [];
      for (const choice of chunk.data.choices) {
        if (choice.finish_reason && reason !== 'output_limit') reason = choice.finish_reason === 'length' ? 'output_limit' : ['stop', 'tool_calls', 'function_call'].includes(choice.finish_reason) ? 'stop' : 'unknown';
        if (choice.delta?.content) events.push({ type: 'text', text: choice.delta.content });
        for (const piece of choice.delta?.tool_calls ?? []) {
          const call = calls.get(piece.index) ?? { id: '', name: '', arguments: '' };
          call.id ||= piece.id ?? '';
          call.name += piece.function?.name ?? '';
          call.arguments += piece.function?.arguments ?? '';
          calls.set(piece.index, call);
        }
      }
      return events;
    };
  },
};

// ---------------------------------------------------------------------------------------------
// messages (compatível com a Anthropic): MiniMax, Qwen...
// ---------------------------------------------------------------------------------------------

const messagesEventSchema = z.object({
  type: z.string(),
  message: z.object({ usage: z.unknown().optional() }).catch({}).optional(),
  usage: z.unknown().optional(),
  index: z.number().int().optional(),
  content_block: z.object({ type: z.string(), id: z.string().nullish(), name: z.string().nullish() }).optional(),
  delta: z.object({ type: z.string().optional(), text: z.string().nullish(), partial_json: z.string().nullish(), stop_reason: z.string().nullish() }).optional(),
});

/** Instruções de sistema dos turnos `system` (o campo `system` do messages, que ganha a forma de lista de blocos ao montar o corpo, e o `instructions` do responses), ou nada. */
const systemText = (turns: ChatTurn[]): string | undefined => {
  const text = turns.flatMap((turn) => (turn.role === 'system' ? [turn.text] : [])).join('\n\n');
  return text === '' ? undefined : text;
};

/** Argumentos da chamada como objeto (o messages exige `input` objeto); texto que não é JSON vira objeto vazio. */
function toolInput(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Turnos no formato da Anthropic: o resultado de ferramenta é um bloco `tool_result` dentro de uma mensagem `user`, e os
 * resultados de uma mesma etapa ficam juntos (e antes de qualquer texto) na mensagem que segue o `assistant`. Turnos
 * consecutivos do mesmo papel viram uma só mensagem com vários blocos.
 */
function anthropicMessages(turns: ChatTurn[]): { role: 'user' | 'assistant'; content: Record<string, unknown>[] }[] {
  const out: { role: 'user' | 'assistant'; content: Record<string, unknown>[] }[] = [];
  const push = (role: 'user' | 'assistant', block: Record<string, unknown>) => {
    const last = out.at(-1);
    if (last?.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };
  for (const turn of turns) {
    if (turn.role === 'user') {
      push('user', { type: 'text', text: turn.text });
      for (const image of turn.images ?? []) push('user', { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } });
    }
    else if (turn.role === 'tool') push('user', { type: 'tool_result', tool_use_id: turn.callId, content: turn.text });
    else if (turn.role === 'assistant') {
      if (turn.text !== '') push('assistant', { type: 'text', text: turn.text });
      for (const call of turn.toolCalls) push('assistant', { type: 'tool_use', id: call.id, name: call.name, input: toolInput(call.arguments) });
    }
  }
  return out;
}

/**
 * Marca de cache explícito do `messages` (P6, phase 12): diferente do chat_completions e do responses, em que o provedor guarda o prefixo sozinho, a Anthropic só
 * guarda o que termina numa marca `cache_control`. `ephemeral` é o cache de 5 minutos (a gravação custa 1,25 vez a entrada, e a leitura, 0,1 vez). O pedido usa três das quatro marcas
 * permitidas, uma no fim de cada parte estável do prefixo (ferramentas, sistema e a última mensagem), para o pedido seguinte, que é sempre uma extensão do anterior, ler tudo o que já foi gravado.
 */
const CACHE_CONTROL = { type: 'ephemeral' } as const;

/** Lista com a marca de cache no ÚLTIMO item (lista vazia fica como está: não há onde marcar). */
function markLast<T extends Record<string, unknown>>(items: readonly T[]): T[] {
  const last = items.at(-1);
  return last === undefined ? [] : [...items.slice(0, -1), { ...last, cache_control: CACHE_CONTROL }];
}

const messages: ProtocolAdapter = {
  path: '/messages',
  supportsEffort: true,
  // Só o OpenCode Go usa estes cabeçalhos: o SDK da Anthropic autentica com `x-api-key`; o gateway documenta Bearer. Mandar os dois não custa nada: o destino é o mesmo host fixo,
  // e cada variante de gateway lê o que conhece. A Anthropic nativa manda só `x-api-key` e a versão, sem Bearer (`credentials/anthropic.ts`).
  authHeaders: (apiKey) => ({ ...bearer(apiKey), 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION }),
  body: ({ model, turns, tools, effort, maxTokens }) => {
    const system = systemText(turns);
    const conversation = anthropicMessages(turns);
    const last = conversation.at(-1);
    return {
      model,
      stream: true,
      max_tokens: maxTokens,
      // O `system` é lista de blocos (e não texto) porque a marca de cache só existe em bloco; o conteúdo é o mesmo texto de antes, em um bloco só.
      ...(system === undefined ? {} : { system: markLast([{ type: 'text', text: system }]) }),
      messages: last === undefined ? conversation : [...conversation.slice(0, -1), { ...last, content: markLast(last.content) }],
      ...(tools ? { tools: markLast(tools.map(({ name, description, parameters }) => ({ name, description, input_schema: parameters }))) } : {}),
      ...(effort ? { output_config: { effort } } : {}),
    };
  },
  parser() {
    let usage: ChatUsage = {};
    /** Uso bruto do `message_start`, guardado para o evento final mesclá-lo campo a campo. */
    let started: unknown;
    let reason: Extract<ChatEvent, { type: 'done' }>['reason'] = 'unknown';
    const blocks = new Map<number, { id: string; name: string; arguments: string }>();
    const complete: ChatToolCall[] = [];
    return ({ data }) => {
      const event = messagesEventSchema.safeParse(parseJson(data));
      if (!event.success) throw new ChatStreamError('evento fora do formato de messages');
      const { type, index = 0, content_block: block, delta } = event.data;
      if (type === 'error') throw new ChatStreamError('erro no meio do stream');
      if (type === 'message_start') {
        started = event.data.message?.usage;
        usage = usageOf(started, 'messages');
      }
      if (type === 'message_delta') {
        // O `message_start` traz a entrada e o cache do pedido; o evento final repete (ou zera) esses campos em alguns gateways e só acrescenta a saída. Cada campo
        // informado no início prevalece sobre o do final, campo a campo e sem depender de `input_tokens`; o final só preenche o que o início não informou.
        usage = usageOf(mergeMessagesUsage(started, event.data.usage), 'messages');
        if (delta?.stop_reason && reason !== 'output_limit') reason = delta.stop_reason === 'max_tokens' ? 'output_limit' : ['end_turn', 'stop_sequence', 'tool_use'].includes(delta.stop_reason) ? 'stop' : 'unknown';
      }
      if (type === 'content_block_start' && block?.type === 'tool_use') {
        blocks.set(index, { id: block.id ?? '', name: block.name ?? '', arguments: '' });
      } else if (type === 'content_block_delta') {
        if (delta?.type === 'text_delta' && delta.text) return [{ type: 'text', text: delta.text }];
        const call = blocks.get(index);
        if (delta?.type === 'input_json_delta' && call) call.arguments += delta.partial_json ?? '';
      } else if (type === 'content_block_stop') {
        const call = blocks.get(index);
        blocks.delete(index);
        if (call) complete.push({ ...call, arguments: call.arguments || '{}' });
      } else if (type === 'message_stop') {
        if (reason === 'unknown') throw new ChatStreamError('motivo terminal ausente ou desconhecido');
        return [...(reason === 'output_limit' ? [] : complete.map((call): ChatEvent => ({ type: 'tool_call', ...call }))), { type: 'usage', usage }, { type: 'done', reason }];
      }
      return [];
    };
  },
};

// ---------------------------------------------------------------------------------------------
// responses (compatível com a OpenAI): Grok, GPT, Muse...
// ---------------------------------------------------------------------------------------------

const responsesEventSchema = z.object({
  type: z.string(),
  response: z.object({ usage: z.unknown().optional(), incomplete_details: z.object({ reason: z.string().optional() }).nullish() }).catch({}).optional(),
  delta: z.string().nullish(),
  item: z
    .object({
      type: z.string(),
      call_id: z.string().nullish(),
      id: z.string().nullish(),
      name: z.string().nullish(),
      arguments: z.string().nullish(),
    })
    .optional(),
});

/** Turnos no formato de responses: mensagens `user` e `assistant`, e a chamada e o resultado de ferramenta como itens próprios. */
function responsesInput(turns: ChatTurn[]): Record<string, unknown>[] {
  return turns.flatMap((turn): Record<string, unknown>[] => {
    switch (turn.role) {
      case 'system':
        return [];
      case 'user':
        return [{ role: 'user', content: turn.images?.length ? [{ type: 'input_text', text: turn.text }, ...turn.images.map((image) => ({ type: 'input_image', image_url: `data:${image.mediaType};base64,${image.base64}` }))] : turn.text }];
      case 'tool':
        return [{ type: 'function_call_output', call_id: turn.callId, output: turn.text }];
      case 'assistant':
        return [
          ...(turn.text === '' ? [] : [{ role: 'assistant', content: turn.text }]),
          ...turn.toolCalls.map((call) => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments })),
        ];
    }
  });
}

const responses: ProtocolAdapter = {
  path: '/responses',
  supportsEffort: true,
  authHeaders: bearer,
  body: ({ model, turns, tools, effort, maxTokens }) => ({
    model,
    stream: true,
    // A API de responses recusa menos de 16 tokens de saída.
    max_output_tokens: Math.max(16, maxTokens),
    ...(systemText(turns) === undefined ? {} : { instructions: systemText(turns) }),
    input: responsesInput(turns),
    ...(tools ? { tools: tools.map((tool) => ({ type: 'function', ...tool })) } : {}),
    ...(effort ? { reasoning: { effort } } : {}),
  }),
  parser() {
    const calls: ChatToolCall[] = [];
    return ({ data }) => {
      const event = responsesEventSchema.safeParse(parseJson(data));
      if (!event.success) throw new ChatStreamError('evento fora do formato de responses');
      const { type, delta, item } = event.data;
      if (type === 'response.incomplete' && event.data.response?.incomplete_details?.reason === 'max_output_tokens') {
        return [{ type: 'usage', usage: usageOf(event.data.response?.usage, 'responses') }, { type: 'done', reason: 'output_limit' }];
      }
      if (type === 'error' || type === 'response.failed' || type === 'response.incomplete') {
        throw new ChatStreamError('erro no meio do stream');
      }
      if (type === 'response.output_text.delta' && delta) return [{ type: 'text', text: delta }];
      // O item completo (com os argumentos inteiros) chega em `output_item.done`; os deltas intermediários são ignorados.
      if (type === 'response.output_item.done' && item?.type === 'function_call') {
        calls.push({ id: item.call_id ?? item.id ?? '', name: item.name ?? '', arguments: item.arguments || '{}' });
      }
      if (type === 'response.completed') return [...calls.map((call): ChatEvent => ({ type: 'tool_call', ...call })), { type: 'usage', usage: usageOf(event.data.response?.usage, 'responses') }, { type: 'done', reason: 'stop' }];
      return [];
    };
  },
};

export const PROTOCOLS: Record<ChatProtocol, ProtocolAdapter> = {
  chat_completions: chatCompletions,
  messages,
  responses,
};

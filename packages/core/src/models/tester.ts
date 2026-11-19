// Teste de um modelo (F8, T5): descobre em qual protocolo o provedor o serve, prova texto em streaming e chamada de
// ferramenta e sonda os níveis de effort que ele aceita. É uma função pura sobre a porta `ProviderClient`: não grava
// nada (quem persiste o resultado é `ModelService`) e não conhece HTTP do Aion.
//
// Como decide (o catálogo do provedor só traz o id, então tudo é descoberto chamando o modelo):
// 1. Texto e streaming: tenta os protocolos em ordem e fica com o primeiro que devolve texto. O provedor recusando
//    (4xx), um stream fora do formato ou uma resposta sem texto fazem tentar o próximo; se nenhum serve, o modelo
//    `failed`, com o motivo mais avançado que se viu (recusa < stream ruim < resposta vazia).
// 2. Ferramenta: uma chamada com uma ferramenta de teste; sem a chamada (ou com o provedor recusando `tools`), o modelo
//    é `no_tools`: passa em texto e streaming e falha em ferramenta (selo "Sem ferramentas").
// 3. Effort: um nível INVÁLIDO é sondado antes dos válidos. Se o provedor o aceita, ele ignora o parâmetro e nenhum
//    nível tem significado, então o modelo não expõe o controle; senão, os níveis aceitos são os que voltam 2xx.
//    O adaptador envia o parâmetro próprio do protocolo, inclusive `output_config.effort` em messages.
//
// Erros que NÃO são resultado do modelo (chave recusada, provedor fora do ar, prazo geral estourado) propagam como
// `DomainError` e o teste não é gravado: o modelo segue "nunca testado" até haver um teste de verdade.
// ponytail: a sonda de texto usa 1024 tokens de saída; subir se modelos de raciocínio longo forem marcados como
// "resposta vazia" só por gastarem tudo pensando.
import { DomainError } from '../errors';
import { randomUUID } from 'node:crypto';
import { EFFORT_LEVELS, type EffortLevel, type ModelTestReason, type ModelTestStatus } from '@aion/shared';
import type { ProviderClient } from '../credentials/opencode-go';
import {
  CHAT_PROTOCOLS,
  ChatRejected,
  ChatStreamError,
  PROTOCOLS,
  type ChatEvent,
  type ChatProtocol,
  type ChatRequest,
  type ChatTool,
  type ChatTurn,
} from './chat-protocols';

export interface ModelTestOutcome {
  status: ModelTestStatus;
  /** Nulo quando `ok`. */
  reason: ModelTestReason | null;
  /** Protocolo em que o modelo respondeu; nulo se falhou em todos. */
  protocol: ChatProtocol | null;
  /** Níveis de effort aceitos, na ordem de `EFFORT_LEVELS`. */
  effortLevels: EffortLevel[];
}

export interface RunModelTestOptions {
  provider: ProviderClient;
  apiKey: string;
  model: string;
  /** Prazo geral do teste; estourado, a chamada em curso falha como `PROVIDER_UNAVAILABLE`. */
  signal?: AbortSignal;
}

/** Conversa de um único turno do dono: é tudo que as sondas do teste enviam. */
const userTurn = (text: string): ChatTurn[] => [{ role: 'user', text }];

const TEXT_PROMPT = 'Responda apenas com a palavra: ok';
const TOOL_PROMPT = 'Chame a ferramenta aion_echo com o texto "ok". Não responda com texto.';
const EFFORT_PROMPT = 'ok';
const TEXT_MAX_TOKENS = 1024;
/** Saída mínima aceita pelos três protocolos: a sonda de effort só precisa do status da resposta. */
const EFFORT_MAX_TOKENS = 16;
/** Valor que nenhum provedor reconhece: se for aceito, o parâmetro de effort está sendo ignorado. */
const BOGUS_EFFORT = 'aion-nivel-invalido';

/** Ferramenta de teste: um argumento obrigatório, para a prova exigir argumentos de verdade e não só o nome. */
export const TEST_TOOL: ChatTool = {
  name: 'aion_echo',
  description: 'Devolve o texto recebido. Serve só para confirmar que o modelo consegue chamar ferramentas.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: 'Texto a devolver.' } },
    required: ['text'],
    additionalProperties: false,
  },
};

interface Collected {
  text: string;
  toolCalls: Extract<ChatEvent, { type: 'tool_call' }>[];
}

/** Consome o stream inteiro, juntando o texto e as chamadas de ferramenta. */
async function collect(stream: AsyncGenerator<ChatEvent>): Promise<Collected> {
  const collected: Collected = { text: '', toolCalls: [] };
  for await (const event of stream) {
    if (event.type === 'text') collected.text += event.text;
    else if (event.type === 'tool_call') collected.toolCalls.push(event);
  }
  return collected;
}

/** Falha que é do protocolo ou do modelo (e não da chave ou da rede): o teste a trata como resultado. */
const isModelSideFailure = (error: unknown): boolean => error instanceof ChatRejected || error instanceof ChatStreamError;

/** Motivos em ordem de quanto o modelo chegou longe; o teste reporta o mais avançado entre os protocolos tentados. */
const FAILURE_RANK: ModelTestReason[] = ['unsupported', 'bad_stream', 'empty_response'];
const furthest = (current: ModelTestReason, candidate: ModelTestReason): ModelTestReason =>
  FAILURE_RANK.indexOf(candidate) > FAILURE_RANK.indexOf(current) ? candidate : current;

/** Os argumentos da chamada são um objeto JSON com o texto pedido? */
function isValidEchoCall(call: Collected['toolCalls'][number]): boolean {
  if (call.name !== TEST_TOOL.name) return false;
  try {
    const args: unknown = JSON.parse(call.arguments);
    return typeof args === 'object' && args !== null && !Array.isArray(args) && typeof (args as { text?: unknown }).text === 'string';
  } catch {
    return false;
  }
}

/** Roda o teste completo do modelo. Lança `DomainError` (chave, provedor fora do ar); o resto vira resultado. */
export async function runModelTest({ provider, apiKey, model, signal }: RunModelTestOptions): Promise<ModelTestOutcome> {
  // Aborta as chamadas que sobrarem quando o teste termina ou falha no meio.
  const controller = new AbortController();
  const callSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  // Uma sessão por teste: todas as sondas do mesmo modelo compartilham o id, como numa conversa de verdade.
  const sessionId = randomUUID();
  const chat = (protocol: ChatProtocol, request: Omit<ChatRequest, 'model' | 'sessionId'>) =>
    provider.streamChat(apiKey, protocol, { model, sessionId, ...request }, callSignal);

  try {
    // 1. Texto e streaming, descobrindo o protocolo.
    let protocol: ChatProtocol | null = null;
    let failure: ModelTestReason = 'unsupported';
    for (const candidate of CHAT_PROTOCOLS) {
      try {
        const answer = await collect(chat(candidate, { turns: userTurn(TEXT_PROMPT), maxTokens: TEXT_MAX_TOKENS }));
        if (answer.text.trim() !== '') {
          protocol = candidate;
          break;
        }
        failure = furthest(failure, 'empty_response');
      } catch (error) {
        if (!isModelSideFailure(error)) throw error;
        if (error instanceof ChatStreamError) failure = furthest(failure, 'bad_stream');
      }
    }
    if (protocol === null) return { status: 'failed', reason: failure, protocol: null, effortLevels: [] };

    // 2 e 3. Ferramenta e effort são independentes entre si: rodam juntos.
    const working = protocol;
    const [toolsWork, effortLevels] = await Promise.all([
      probeTools(chat, working),
      PROTOCOLS[working].supportsEffort ? probeEffort(chat, working) : Promise.resolve<EffortLevel[]>([]),
    ]);
    return toolsWork
      ? { status: 'ok', reason: null, protocol: working, effortLevels }
      : { status: 'no_tools', reason: 'no_tool_call', protocol: working, effortLevels };
  } finally {
    controller.abort();
  }
}

type ChatFn = (protocol: ChatProtocol, request: Omit<ChatRequest, 'model' | 'sessionId'>) => AsyncGenerator<ChatEvent>;

/** O modelo chamou a ferramenta de teste com argumentos válidos? Recusa do provedor a `tools` conta como "não". */
async function probeTools(chat: ChatFn, protocol: ChatProtocol): Promise<boolean> {
  try {
    const answer = await collect(chat(protocol, { turns: userTurn(TOOL_PROMPT), tools: [TEST_TOOL], maxTokens: TEXT_MAX_TOKENS }));
    return answer.toolCalls.some(isValidEchoCall);
  } catch (error) {
    if (isModelSideFailure(error)) return false;
    throw error;
  }
}

/** O provedor aceitou este nível? Basta a resposta começar (2xx e o primeiro evento): a conexão é fechada logo em seguida. */
async function acceptsEffort(chat: ChatFn, protocol: ChatProtocol, effort: string): Promise<boolean> {
  const stream = chat(protocol, { turns: userTurn(EFFORT_PROMPT), effort, maxTokens: EFFORT_MAX_TOKENS });
  try {
    await stream.next();
    return true;
  } catch (error) {
    if (isModelSideFailure(error)) return false;
    throw error;
  } finally {
    await stream.return(undefined);
  }
}

/** Níveis de effort aceitos, ou nenhum se o provedor aceita até um nível inventado (parâmetro ignorado). */
async function probeEffort(chat: ChatFn, protocol: ChatProtocol): Promise<EffortLevel[]> {
  if (await acceptsEffort(chat, protocol, BOGUS_EFFORT)) return [];
  const verdicts = await Promise.all(EFFORT_LEVELS.map((level) => acceptsEffort(chat, protocol, level)));
  return EFFORT_LEVELS.filter((_, index) => verdicts[index]);
}

/** JPEG vermelho uniforme, pequeno e sem metadados. A cor não é informada no texto enviado. */
export const IMAGE_PROBE_BASE64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAgACADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD50ooor8MP9UwooooAKKKKACiiigD/2Q==';

/** Sonda no protocolo comprovado; falhas transitórias nunca viram ausência de visão. */
export async function runImageTest({ provider, apiKey, model, signal, protocol }: RunModelTestOptions & { protocol: ChatProtocol }): Promise<boolean> {
  try {
    const answer = await collect(provider.streamChat(apiKey, protocol, {
      model, sessionId: randomUUID(), maxTokens: TEXT_MAX_TOKENS,
      turns: [{ role: 'user', text: 'Qual é a cor predominante desta imagem? Responda apenas o nome da cor.', images: [{ mediaType: 'image/jpeg', base64: IMAGE_PROBE_BASE64 }] }],
    }, signal));
    if (!answer.text.trim()) throw new DomainError('MODEL_IMAGE_CHECK_FAILED');
    return /\b(?:vermelh[oa]|red)\b/i.test(answer.text);
  } catch (error) {
    if (error instanceof ChatRejected && error.status === 400 && error.rejectedImage) return false;
    throw new DomainError('MODEL_IMAGE_CHECK_FAILED');
  }
}

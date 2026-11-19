// Sonda da chamada de ferramenta PELO NOME (phase 15, passo 1, decisão 14 da spec). Pergunta: o `deepseek-v4.1-flash` emite uma chamada pelo nome de uma ferramenta cujo esquema
// chegou no fim do histórico (como resultado de ferramenta) mas que NÃO está no campo `tools`? E, quando só existe a porta `use_tool`, como ele chama? A resposta decide se o
// passo 10 pode dispensar a porta ou se ela fica (sempre sob os controles da decisão 21: o portão de aprovação continua decidindo cada chamada).
// Mede a INTENÇÃO: a chamada emitida pelo modelo é classificada e descartada, nada é executado. Roteiro fixo, no máximo 3 chamadas reais (restrição do dono, decisões 9 e 14):
//   by_name_1   tools = [carregador]              o histórico traz o esquema de `aion_registrar_nota` devolvido pelo carregador; o modelo deve chamar `aion_registrar_nota` direto
//   door        tools = [carregador, use_tool]    mesmo histórico, agora com a porta: o modelo deve chamar `use_tool` com { name, arguments }
//   by_name_2   tools = [carregador]              repetição da primeira, para ter duas amostras da chamada pelo nome (o modelo é estocástico)
// Cada chamada é classificada em: by_name | door | wrong_args | other_tool | no_call, com `stop` informando se a saída foi cortada pelo limite (`output_limit`). Amostra cortada ou sem
// chamada torna o resultado inconclusivo; um erro do provedor propaga na hora e a sonda para ali, sem repetir a chamada.
// Limites: só o `deepseek-v4.1-flash` (nenhum outro modelo), `max_tokens` de 256 (basta para emitir a chamada), chave só do ambiente e nunca impressa; a saída contém exclusivamente
// identificadores e números (inclusive o gasto aproximado em US$ pelos preços de `MODEL_PRICES`) e a falha sai como envelope `{ code, message, exitCode }`.
//   node --env-file-if-exists=.env.provider --import tsx tests/support/validate-tool-by-name.ts     # real, até 3 chamadas
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { qualifyModelId } from '@aion/shared';
import { ChatRejected, ChatStreamError, createOpenCodeGoClient, MODEL_PRICES, type ChatEvent, type ChatRequest, type ChatTool, type ChatTurn, type ChatUsage, type ProviderClient } from '@aion/core';

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Parâmetros da sonda
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Único modelo da sonda (restrição do dono): trocá-lo muda o que ela prova e exige novo pedido. */
export const PROBE_MODEL = 'deepseek-v4.1-flash';
/** Teto de chamadas reais (decisão 14 da spec). */
export const MAX_CALLS = 3;
/** Saída curta: só precisa caber a chamada de ferramenta (decisão 9 da spec: até 256). */
export const MAX_OUTPUT_TOKENS = 256;
/** Endereço do OpenCode Go; `AION_OPENCODE_GO_BASE_URL` (só do ambiente do operador) o substitui, como nos outros scripts de validação. */
const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1';

/** Ferramenta-alvo: o esquema dela só existe no resultado do carregador, nunca em `tools`. */
const TARGET = 'aion_registrar_nota';
const LOADER = 'aion_carregar_esquema';
const DOOR = 'use_tool';
/** O esquema que o carregador devolve no histórico (a forma de `ChatTool`, como o resultado de uma ferramenta de descoberta o traria). */
const TARGET_SCHEMA = {
  name: TARGET,
  description: 'Registra uma nota curta do dono com uma prioridade.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: 'Texto da nota.' }, priority: { type: 'string', enum: ['baixa', 'alta'], description: 'Prioridade da nota.' } },
    required: ['text', 'priority'],
    additionalProperties: false,
  },
};
const LOADER_TOOL: ChatTool = {
  name: LOADER,
  description: 'Devolve o esquema de uma ferramenta pelo nome, para que ela possa ser chamada em seguida.',
  parameters: { type: 'object', properties: { name: { type: 'string', description: 'Nome da ferramenta.' } }, required: ['name'], additionalProperties: false },
};
const DOOR_TOOL: ChatTool = {
  name: DOOR,
  description: 'Chama uma ferramenta já carregada (cujo esquema o histórico mostra) pelo nome, passando os argumentos dela.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Nome da ferramenta a chamar.' }, arguments: { type: 'object', description: 'Argumentos da ferramenta, conforme o esquema dela.' } },
    required: ['name', 'arguments'],
    additionalProperties: false,
  },
};
const SYSTEM = 'Você é um assistente que executa pedidos usando ferramentas. Responda chamando a ferramenta adequada, sem texto.';
const CALL_ID = 'call_probe_schema';

/** O histórico comum às três chamadas: pedido do dono, a chamada do carregador já feita e o esquema devolvido no fim. */
const history = (): ChatTurn[] => [
  { role: 'system', text: SYSTEM },
  { role: 'user', text: `Registre a nota "comprar leite" com prioridade alta usando a ferramenta ${TARGET}.` },
  { role: 'assistant', text: '', toolCalls: [{ id: CALL_ID, name: LOADER, arguments: JSON.stringify({ name: TARGET }) }] },
  { role: 'tool', callId: CALL_ID, name: LOADER, text: JSON.stringify(TARGET_SCHEMA) },
];

/** `by_name`: chamou a ferramenta-alvo direto com argumentos válidos; `door`: chamou a porta apontando para o alvo com argumentos válidos; `wrong_args`: acertou o nome mas os argumentos não servem; `other_tool`: chamou outra coisa; `no_call`: só texto. */
export type Outcome = 'by_name' | 'door' | 'wrong_args' | 'other_tool' | 'no_call';

/** O roteiro: nome da chamada, ferramentas oferecidas e o resultado esperado. */
const SCRIPT = [
  { name: 'by_name_1', tools: [LOADER_TOOL], expect: 'by_name' },
  { name: 'door', tools: [LOADER_TOOL, DOOR_TOOL], expect: 'door' },
  { name: 'by_name_2', tools: [LOADER_TOOL], expect: 'by_name' },
] as const satisfies readonly { name: string; tools: ChatTool[]; expect: Outcome }[];

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Resultado
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface ProbeCall {
  name: (typeof SCRIPT)[number]['name'];
  outcome: Outcome;
  /** `true` quando o resultado é o esperado para esta chamada do roteiro. */
  expected: boolean;
  stop: 'stop' | 'output_limit' | 'unknown';
  usage: ChatUsage;
  /** Gasto aproximado da chamada em US$ pelos preços de `MODEL_PRICES`. */
  costUsd: number;
}

export interface ToolByNameReport {
  providerCalls: number;
  calls: ProbeCall[];
  /** Total aproximado em US$. */
  costUsd: number;
  /** `works`: as duas chamadas pelo nome acertaram; `fails`: nenhuma acertou e nenhuma foi cortada nem ficou sem chamada; `inconclusive`: o resto. */
  byName: 'works' | 'fails' | 'inconclusive';
  /** A porta foi chamada com o alvo e argumentos válidos. */
  doorWorks: boolean;
}

/** Gasto em US$ de um uso, pelos preços por milhão de tokens: entrada sem cache, leitura de cache e saída (raciocínio já incluído na saída pelo provedor). */
export function costOf(usage: ChatUsage): number {
  // A tabela de preços usa o id do produto (`opencode/<modelo>`); a chamada ao provedor segue com o id local.
  const price = MODEL_PRICES[qualifyModelId('opencode', PROBE_MODEL)]!;
  const input = usage.inputTokens ?? 0, cached = usage.cachedTokens ?? 0, output = usage.outputTokens ?? 0;
  return ((Math.max(input - cached, 0) * price.input) + (cached * price.cached) + (output * price.output)) / 1_000_000;
}

/** Classifica a chamada emitida (a primeira de ferramenta do stream) sem executá-la. */
function classify(call: Extract<ChatEvent, { type: 'tool_call' }> | undefined): Outcome {
  if (!call) return 'no_call';
  const parse = (text: string): Record<string, unknown> | null => {
    try { const value: unknown = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null; } catch { return null; }
  };
  /** Argumentos do alvo válidos pelo esquema: `text` não vazio e `priority` no enum, sem campos além. */
  const validNote = (args: Record<string, unknown> | null): boolean => !!args && typeof args.text === 'string' && args.text.length > 0 && (args.priority === 'baixa' || args.priority === 'alta') && Object.keys(args).every((key) => key === 'text' || key === 'priority');
  if (call.name === TARGET) return validNote(parse(call.arguments)) ? 'by_name' : 'wrong_args';
  if (call.name === DOOR) {
    const outer = parse(call.arguments);
    if (!outer || outer.name !== TARGET) return 'wrong_args';
    const inner = outer.arguments;
    return validNote(inner && typeof inner === 'object' && !Array.isArray(inner) ? (inner as Record<string, unknown>) : null) ? 'door' : 'wrong_args';
  }
  return 'other_tool';
}

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Sonda
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Roda o roteiro contra `provider` e devolve o relatório; `emit` recebe uma linha por chamada (`call`) e o `result` final, só com identificadores e números. Um erro do
 * provedor (inclusive recusa) propaga na hora e o roteiro para ali, sem repetir a chamada.
 */
export async function runToolByNameProbe({ provider, apiKey, emit }: { provider: ProviderClient; apiKey: string; emit: (line: Record<string, unknown>) => void }): Promise<ToolByNameReport> {
  const sessionId = randomUUID();
  const calls: ProbeCall[] = [];
  for (const entry of SCRIPT) {
    if (calls.length >= MAX_CALLS) throw new Error('Limite de chamadas ao provedor da sonda excedido.');
    const request: ChatRequest = { model: PROBE_MODEL, sessionId, turns: history(), tools: [...entry.tools], maxTokens: MAX_OUTPUT_TOKENS };
    let usage: ChatUsage = {};
    let stop: ProbeCall['stop'] = 'unknown';
    let emitted: Extract<ChatEvent, { type: 'tool_call' }> | undefined;
    for await (const event of provider.streamChat(apiKey, 'chat_completions', request)) {
      if (event.type === 'tool_call') emitted ??= event;
      else if (event.type === 'usage') usage = event.usage;
      else if (event.type === 'done') stop = event.reason;
    }
    const outcome = classify(emitted);
    const call: ProbeCall = { name: entry.name, outcome, expected: outcome === entry.expect, stop, usage, costUsd: costOf(usage) };
    calls.push(call);
    emit({ event: 'call', name: call.name, tools: entry.tools.length, outcome, expected: call.expected, stop, ...usage, costUsd: Number(call.costUsd.toFixed(6)) });
  }
  const byNameCalls = calls.filter((call) => call.name !== 'door');
  const hits = byNameCalls.filter((call) => call.outcome === 'by_name').length;
  // Cortada pelo limite ou sem chamada nenhuma é amostra perdida, não prova de que o modelo não sabe chamar pelo nome.
  const lost = byNameCalls.filter((call) => call.stop === 'output_limit' || call.outcome === 'no_call').length;
  const byName: ToolByNameReport['byName'] = hits === byNameCalls.length ? 'works' : hits === 0 && lost === 0 ? 'fails' : 'inconclusive';
  const report: ToolByNameReport = { providerCalls: calls.length, calls, costUsd: calls.reduce((sum, call) => sum + call.costUsd, 0), byName, doorWorks: calls.find((call) => call.name === 'door')?.outcome === 'door' };
  emit({ event: 'result', model: PROBE_MODEL, providerCalls: report.providerCalls, byName: report.byName, doorWorks: report.doorWorks, costUsd: Number(report.costUsd.toFixed(6)) });
  return report;
}

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Borda da CLI
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Mensagens seguras por código estável: a causa externa (provedor, rede) nunca atravessa esta borda. */
const MESSAGES = {
  PROVIDER_TOOL_BY_NAME_INVALID_ARGUMENT: 'Argumento inválido. A sonda não aceita argumentos.',
  PROVIDER_TOOL_BY_NAME_FAILED: 'Não foi possível concluir a sonda da chamada pelo nome. Confira a chave no ambiente e a disponibilidade do serviço.',
} as const;

class ProbeError extends Error {
  constructor(readonly code: keyof typeof MESSAGES) { super(code); }
}

/** Imprime uma linha JSON no stdout: o único canal de saída dos dados da sonda (só identificadores e números). */
const write = (line: Record<string, unknown>): void => { process.stdout.write(`${JSON.stringify(line)}\n`); };

/**
 * Ponto de entrada da CLI: recusa qualquer argumento e exige a chave no ambiente antes de qualquer chamada. Uma recusa do provedor (`ChatRejected`) ou um stream fora do formato
 * acrescenta ao envelope só o status HTTP ou o nome da classe do erro (número e identificador), sem vazar corpo, chave nem conversa.
 */
async function main(): Promise<void> {
  try {
    if (process.argv.length > 2) throw new ProbeError('PROVIDER_TOOL_BY_NAME_INVALID_ARGUMENT');
    const apiKey = process.env.AION_VALIDATE_PROVIDER_KEY?.trim();
    if (!apiKey) throw new ProbeError('PROVIDER_TOOL_BY_NAME_FAILED');
    const provider = createOpenCodeGoClient({ baseUrl: process.env.AION_OPENCODE_GO_BASE_URL ?? DEFAULT_BASE_URL, chatTimeoutMs: 60_000 });
    await runToolByNameProbe({ provider, apiKey, emit: write });
  } catch (error) {
    const code = error instanceof ProbeError ? error.code : 'PROVIDER_TOOL_BY_NAME_FAILED';
    const detail = error instanceof ChatRejected ? { status: error.status } : error instanceof ChatStreamError ? { errorName: error.name } : {};
    process.stderr.write(`${JSON.stringify({ code, message: MESSAGES[code], exitCode: 1, ...detail })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();

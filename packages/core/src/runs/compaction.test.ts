// Compactação do contexto (phase 9, F3, F4 e F6 passo 5; CTX-07, CTX-09): provas no motor real (PostgreSQL embarcado, fila, executor e o provedor falso, só o modelo
// é roteirizado). Cada jornada cobre um aceite da spec:
//   A4, A5, A8, C2  uma rodada única com dezenas de chamadas passa do limiar e é compactada DENTRO dela, o pedido só cresce no fim entre compactações, a segunda
//                   compactação recebe o checkpoint e só as unidades novas, e as mensagens do dono da rodada seguem íntegras em todo pedido;
//   A6, C3, S1, S3  resumo vazio ou limite de saída leva ao colapso sem falhar a execução, e a execução seguinte com o mesmo histórico não paga outro resumo;
//   A7, CTX-09      editar memória, Regras Globais ou objetivo mantém o checkpoint; mudar uma linha coberta o invalida;
//   A9              recusa de contexto do provedor: uma compactação forçada e uma nova chamada, e a segunda recusa encerra com CONTEXT_TOO_LARGE;
//   A13             o resumo usa o "Modelo do resumo" quando validado e cai no modelo da conversa quando não;
//   F4 (anexos)    sem espaço, o conteúdo de um documento grande da rodada atual vira referência (read_attachment) em vez de CONTEXT_TOO_LARGE;
//   guarda          um pedido dominado pelo que fica íntegro (etapa mais recente volumosa) não paga resumo em vão;
//   S4, S6          efeito externo incerto entra no lote com estado explícito; fora do formato há uma segunda tentativa com lembrete; recusa de contexto do PRÓPRIO
//                   resumo reduz a entrada. As peças puras (veredito, corte, redução da entrada, impressão) têm provas curtas ao final.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contextFailureMessage } from '@aion/shared';
import { DomainError } from '../errors';
import { ChatRejected, type ChatEvent, type ChatRequest } from '../models/chat-protocols';
import { AttachmentService } from '../attachments/service';
import { GeneralChatService } from '../general-chat/service';
import { readAttachmentTool } from './read-attachment';
import * as checkpoints from './context-checkpoint';
import { commitContextSummary, loadManagedContext, validCheckpoint } from './context-checkpoint';
import { mergeEvidence } from './evidence-provenance';
import { ORIGIN, createRunsWorld, waitFor, type RunsWorld } from './test-support';
import { SUMMARY_MAX_CALLS, SUMMARY_SECTIONS, coveredImpression, cutHistory, fitSummaryInput, judgeSummary, omittedNote, rowTokens, summaryPrompt, type SummaryInput } from './compaction';
import { IMAGE_TOKENS, MAX_OUTPUT_TOKENS, SUMMARY_MAX_OUTPUT_TOKENS, contextEnvelope, estimateChatPayload } from './context-budget';
import { INLINE_FILE_CHARS, INLINE_MESSAGE_CHARS, type ContextAttachment, type ContextRow } from './context';
import { ABRIR_GRUPO, DEFAULT_MOST_USED, DISCOVER_TOOLS, READ_ACTIVITY, USE_TOOL } from './tool-discovery';
import { INTERNAL_TOOLS } from './engine';
import { defineTool } from './tools';

afterEach(() => { vi.restoreAllMocks(); });

/** Janela de 64k fixada pelas provas (não depende do padrão do produto; é a menor opção desde a phase 11): 65536 - saída 16384 (25% da janela, phase 12) - margem 2048 = 47.104 tokens de entrada. */
const WINDOW = 65536;
const BUDGET = contextEnvelope(WINDOW, MAX_OUTPUT_TOKENS).inputBudget;
/** Unidades de 4.000 caracteres que semeiam um histórico acima do orçamento e do limiar sem usage (estimativa sem calibração): 18 × 4.000 ≈ 72 mil bytes contra os 47.104 do orçamento. */
const OVER_BUDGET_UNITS = 18;

/** Ferramenta volumosa: cada chamada devolve ~6.000 caracteres (abaixo do teto de 12.000 do pedido), com um marcador do número da chamada. */
const bigResult = defineTool({
  definition: { name: 'big_result', description: 'Devolve um bloco de dados de teste.', parameters: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false } },
  argsSchema: z.strictObject({ q: z.string() }), label: ({ q }) => `Bloco ${q}`, execute: async ({ q }) => ({ result: `BLOCO_${q} ${'x'.repeat(6000)}` }),
});

/** Ferramenta de texto largo (CJK, 3 bytes por caractere): pesa no pedido muito mais que o número de caracteres sugere. 6.200 caracteres (18,6 mil bytes) mantêm o pedido do teste de guarda no limiar com o turno de sistema enxuto do passo 15. */
const bigCjk = defineTool({
  definition: { name: 'big_cjk', description: 'Devolve um bloco de texto largo de teste.', parameters: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false } },
  argsSchema: z.strictObject({ q: z.string() }), label: ({ q }) => `Texto ${q}`, execute: async () => ({ result: '漢'.repeat(6200) }),
});

/** A chamada de resumo é reconhecida pelo turno de sistema dela (o limite de saída é igual ao de qualquer chamada). */
const isSummary = (request: ChatRequest): boolean => request.turns[0]?.role === 'system' && request.turns[0].text.startsWith('Você produz o checkpoint do histórico');
/** Checkpoint válido: as sete seções, com o rótulo da chamada na primeira (identifica qual resumo está no pedido). */
const checkpoint = (label: string): string => SUMMARY_SECTIONS.map((title, index) => `## ${title}\n${index === 0 ? label : 'Nada.'}`).join('\n\n');
const inputOf = (request: ChatRequest): SummaryInput => JSON.parse(request.turns[1]!.text) as SummaryInput;
/**
 * Phase 11, F7 (A15): o turno de sistema de QUALQUER pedido de resumo, já na primeira tentativa, mostra o alvo de tamanho e dá o teto como teto, e só o modo atualizar
 * traz a instrução de enxugar. As âncoras são o trecho estável de cada instrução; as sete seções seguem obrigatórias nos dois modos (provadas à parte).
 */
function expectSummaryTarget(request: ChatRequest, update: boolean): void {
  const system = request.turns[0]!.text;
  expect(system).toContain('o alvo é de 4.000 a 6.000 caracteres no total');
  expect(system).toContain('16.000 caracteres é só o teto que o sistema aceita');
  expect(system.includes('ENXUGUE ao atualizar')).toBe(update);
  expect(system.includes('ATUALIZE o checkpoint')).toBe(update);
  expect(system).toContain('Seção sem conteúdo traz "Nada."');
}
const checkpointIn = (request: ChatRequest): string | null => request.turns.find((turn) => turn.role === 'user' && turn.text.startsWith('# Resumo derivado'))?.text ?? null;
const hasIndex = (request: ChatRequest): boolean => request.turns.some((turn) => turn.role === 'user' && turn.text.startsWith('# Histórico anterior colapsado'));
/** Estimativa sem calibração do pedido como foi ao provedor (1 byte = 1 token). */
const estimated = (request: ChatRequest): number => estimateChatPayload(request, 'chat_completions').estimatedInputTokens;
/** O que o provedor simulado contaria de verdade (a razão tokens/byte do usage que o roteiro informa). */
const REAL_RATIO = 0.3;
const realTokens = (request: ChatRequest): number => Math.round(estimateChatPayload(request, 'chat_completions').textTokens * REAL_RATIO);

type SummaryReply = (call: number, request: ChatRequest) => ChatEvent[] | Error;
const reply = (label: string): ChatEvent[] => [{ type: 'text', text: checkpoint(label) }, { type: 'usage', usage: { inputTokens: 300, outputTokens: 200 } }, { type: 'done', reason: 'stop' }];
const emptyReply: ChatEvent[] = [{ type: 'usage', usage: { inputTokens: 300, outputTokens: 10 } }, { type: 'done', reason: 'stop' }];

interface Script {
  /** Pedidos principais e de resumo recebidos, na ordem, e o protocolo de cada chamada de resumo. */
  main: ChatRequest[]; summaries: ChatRequest[]; summaryProtocols: string[];
  /** Etapas com chamada de ferramenta antes da resposta final (a etapa 0 seleciona a ferramenta). */
  steps: number;
  /** Ferramenta chamada em cada etapa e quantas chamadas paralelas por etapa (padrão: `big_result`, uma). */
  tool?: string; perStep?: number;
  /** Razão tokens/byte que o provedor informa no usage (calibra o orçamento e ancora a ocupação); nulo = sem usage. */
  usage: number | null;
  summary: SummaryReply;
  /** Roda no instante em que o pedido principal de índice `call` chega ao provedor. */
  beforeCall?: (call: number) => Promise<void>;
  /** O pedido principal de índice `call` é recusado pelo provedor por tamanho, sem nenhuma saída. */
  refuse?: (call: number) => boolean;
  /** Roda no instante em que o pedido de resumo de número `call` (1, 2…) chega ao provedor, antes da resposta: simula o dono mexendo no meio da chamada paga. */
  beforeSummary?: (call: number) => Promise<void>;
}
const newScript = (steps: number, summary: SummaryReply = (call) => reply(`CHECKPOINT_${call}`), usage: number | null = 0.3): Script => ({ main: [], summaries: [], summaryProtocols: [], steps, usage, summary });

/** Primeiro passo dos roteiros: o bot abre um grupo da árvore (a lista `tools` dele é fixa, phase 15), o Chat geral seleciona a ferramenta por `discover_tools`. */
const openingCall = (request: ChatRequest, tool: string): ChatEvent => (request.tools?.some((entry) => entry.name === ABRIR_GRUPO)
  ? { type: 'tool_call', id: randomUUID(), name: ABRIR_GRUPO, arguments: JSON.stringify({ path: 'ferramentas/memoria' }) }
  : { type: 'tool_call', id: randomUUID(), name: DISCOVER_TOOLS, arguments: JSON.stringify({ names: [tool] }) });

/** Roteiro do modelo: abre/seleciona a ferramenta, chama `big_result` por `steps` etapas e responde; a chamada de resumo segue `script.summary`. */
function scriptModel(world: RunsWorld, script: Script): void {
  let call = 0;
  vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, protocol, request): AsyncGenerator<ChatEvent> {
    if (isSummary(request)) {
      script.summaries.push(structuredClone(request));
      script.summaryProtocols.push(protocol);
      await script.beforeSummary?.(script.summaries.length);
      const answer = script.summary(script.summaries.length, request);
      if (answer instanceof Error) throw answer;
      yield* answer;
      return;
    }
    script.main.push(structuredClone(request));
    const index = call++;
    await script.beforeCall?.(index);
    if (script.refuse?.(index)) throw new ChatRejected(400, false, true);
    const tool = script.tool ?? 'big_result';
    if (script.steps > 0 && index === 0) yield openingCall(request, tool);
    else if (script.steps > 0 && index <= script.steps) for (let call = 0; call < (script.perStep ?? 1); call += 1) yield { type: 'tool_call', id: randomUUID(), name: tool, arguments: JSON.stringify({ q: `${index}.${call}` }) };
    else yield { type: 'text', text: 'Concluído.' };
    if (script.usage !== null) yield { type: 'usage', usage: { inputTokens: Math.round(estimateChatPayload(request, protocol).textTokens * script.usage), outputTokens: 20 } };
    yield { type: 'done', reason: 'stop' };
  });
}

/** Mundo com a janela de 64k, o modelo testado e a ferramenta volumosa. */
async function newWorld(): Promise<RunsWorld> {
  const world = await createRunsWorld({ tools: [bigResult, bigCjk], contextWindow: WINDOW });
  await world.models.test('opencode/glm-5.1');
  return world;
}

/** Histórico anterior semeado direto no banco: `count` mensagens do dono de `chars` caracteres, cada uma sua própria unidade (a rodada que a abriu já terminou). */
async function seedHistory(world: RunsWorld, conversationId: string, count: number, chars: number): Promise<string[]> {
  // A primeira cobertura de uma conversa que já tem mensagens herda só as últimas cinco rodadas (`loadManagedContext`); criá-la ANTES de semear dá o comportamento de uma conversa nova, que começa do zero.
  await loadManagedContext(world.pool, conversationId);
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push((await world.pool.query<{ id: string }>(
      "INSERT INTO messages(conversation_id,role,kind,status,opens_round,content,created_at) VALUES($1,'user','text','done',true,$2,now()) RETURNING id::text AS id",
      [conversationId, `Histórico ${index}: ${'a'.repeat(chars)}`],
    )).rows[0]!.id);
  }
  return ids;
}

const contextFailures = async (world: RunsWorld) => (await world.pool.query("SELECT id::text, failure_code FROM runs WHERE failure_code IS NOT NULL")).rows;
const summaryRows = async (world: RunsWorld, runId?: string) => (await world.pool.query<{ state: string; summary_outcome: string | null; model: string }>(
  `SELECT state, summary_outcome, model FROM model_call_usage WHERE purpose = 'summary'${runId ? ' AND run_id = $1' : ''} ORDER BY created_at, id`, runId ? [runId] : [])).rows;
const checkpointRow = async (world: RunsWorld) => (await world.pool.query<{ revision: number; summary: string; covered: string[] }>('SELECT revision, summary, covered_message_ids::text[] AS covered FROM conversation_context')).rows[0]!;

describe('rodada única longa (A4, A5, A8, C2)', () => {
  it('é compactada dentro da própria rodada, sem CONTEXT_TOO_LARGE: o pedido só cresce no fim entre compactações, o resumo seguinte atualiza o checkpoint e as mensagens do dono ficam íntegras', async () => {
    const world = await newWorld();
    try {
      const bot = await world.createBot({ stepLimit: 100 });
      const opening = 'Levante os blocos de dados e NAO envie nada ao cliente sem aprovacao.';
      const complement = `${'Atenção a esta restrição nova do dono. '.repeat(3)}Use somente os blocos pares.`;
      const script = newScript(80);
      // O complemento chega no meio da rodada (CONV-03) e é absorvido antes da chamada seguinte: segue inteiro, como a abertura, em todo pedido depois dele.
      script.beforeCall = async (call) => { if (call === 6) await world.send(bot, complement); };
      scriptModel(world, script); world.engine.start();
      const run = await world.send(bot, opening);
      await world.waitForStatus(run, 'completed', 180_000);
      expect(await contextFailures(world)).toEqual([]);

      // Passou do limiar várias vezes (80 blocos de ~6 mil bytes, ~144 mil tokens reais, numa janela de 64k) e foi compactada na própria rodada, com poucos resumos.
      expect(script.summaries.length).toBeGreaterThanOrEqual(3);
      expect(script.summaries.length).toBeLessThanOrEqual(8);
      expect((await summaryRows(world, run)).every((row) => row.state === 'completed' && row.summary_outcome === 'applied')).toBe(true);
      const stored = await checkpointRow(world);
      expect(stored.summary).toContain('CHECKPOINT_');
      const ownRound = (await world.pool.query<{ id: string }>("SELECT id::text FROM messages WHERE run_id=$1 AND kind='activity'", [run])).rows.map((row) => row.id);
      expect(stored.covered.some((id) => ownRound.includes(id))).toBe(true); // o checkpoint cobre etapas da PRÓPRIA rodada

      // C2: a abertura e o complemento seguem íntegros em todo pedido a partir de onde existem, e nunca entram no que o resumo recebe como linha a cobrir.
      for (const [index, request] of script.main.entries()) {
        const users = request.turns.filter((turn) => turn.role === 'user').map((turn) => turn.text);
        expect(users.some((text) => text.includes(opening)), `abertura no pedido ${index}`).toBe(true);
        if (index >= 7) expect(users.some((text) => text.includes(complement)), `complemento no pedido ${index}`).toBe(true);
        expect(realTokens(request), `pedido ${index} cabe na janela real`).toBeLessThanOrEqual(BUDGET);
      }
      for (const request of script.summaries) {
        const text = JSON.stringify(inputOf(request).rows);
        expect(text).not.toContain(opening);
        expect(text).not.toContain(complement);
        expect(request.tools).toBeUndefined();
      }

      // A4: entre duas compactações o pedido da etapa é o da anterior acrescido só no fim (prefixo idêntico); a compactação é o único momento em que o prefixo muda.
      let boundaries = 0, comparisons = 0;
      for (let index = 1; index < script.main.length; index += 1) {
        const before = script.main[index - 1]!, now = script.main[index]!;
        if (checkpointIn(before) !== checkpointIn(now)) { boundaries += 1; continue; }
        expect(JSON.stringify(now.turns.slice(0, before.turns.length)), `prefixo do pedido ${index}`).toBe(JSON.stringify(before.turns));
        // O catálogo só muda uma vez, quando a seleção de ferramenta (etapa 0) entra em vigor; depois dela o mesmo conjunto vale em toda etapa.
        if (index > 1) expect(JSON.stringify(now.tools)).toBe(JSON.stringify(before.tools));
        comparisons += 1;
      }
      expect(boundaries).toBe(script.summaries.length);
      expect(comparisons).toBeGreaterThan(20);

      // Ordem coerente com a cronologia: o checkpoint vem DEPOIS da abertura (e do complemento, quando o corte o manteve no meio do histórico coberto) e ANTES do trecho
      // final. Em todo pedido com checkpoint: a abertura precede o checkpoint e nenhum resultado de ferramenta fica antes dele (o que o checkpoint cobre veio depois do pedido).
      const checkpointAt = (request: ChatRequest): number => request.turns.findIndex((turn) => turn.role === 'user' && turn.text.startsWith('# Resumo derivado'));
      const turnIndexOf = (request: ChatRequest, text: string): number => request.turns.findIndex((turn) => turn.role === 'user' && turn.text.includes(text));
      const withCheckpoint = script.main.filter((request) => checkpointAt(request) !== -1);
      expect(withCheckpoint.length).toBeGreaterThan(20);
      for (const request of withCheckpoint) {
        const at = checkpointAt(request);
        expect(turnIndexOf(request, opening)).toBeLessThan(at);
        expect(request.turns.slice(0, at).some((turn) => turn.role === 'tool')).toBe(false);
      }
      // Cronologia no pedido final, contra o banco: toda mensagem do dono mais antiga que alguma linha coberta fica ANTES do checkpoint (a abertura e o complemento que o
      // corte manteve no meio do histórico coberto) e todo resultado depois do checkpoint é mais novo que tudo o que ele cobre (o trecho final é um sufixo da conversa).
      const finalRequest = script.main.at(-1)!, finalAt = checkpointAt(finalRequest);
      const newestCovered = stored.covered.reduce((max, id) => (BigInt(id) > max ? BigInt(id) : max), 0n);
      const owners = (await world.pool.query<{ id: string; content: string }>("SELECT id::text, content FROM messages WHERE role='user' AND kind='text' ORDER BY id")).rows;
      for (const owner of owners) {
        expect(turnIndexOf(finalRequest, owner.content) < finalAt, `mensagem do dono ${owner.id} ${BigInt(owner.id) < newestCovered ? 'antes' : 'depois'} do checkpoint`).toBe(BigInt(owner.id) < newestCovered);
      }
      expect(BigInt(owners.find((owner) => owner.content === complement)!.id) < newestCovered).toBe(true); // o complemento ficou no MEIO do histórico coberto: o caso em que a ordem importa
      const blockIds = new Map((await world.pool.query<{ id: string; block: string }>("SELECT id::text, substring(content from 'BLOCO_([0-9.]+)') AS block FROM messages WHERE kind='activity' AND content LIKE 'BLOCO_%'")).rows.map((row) => [row.block, BigInt(row.id)]));
      const shownAfter = finalRequest.turns.slice(finalAt + 1).filter((turn) => turn.role === 'tool').map((turn) => /BLOCO_([0-9.]+)/.exec(turn.text)![1]!);
      expect(shownAfter.length).toBeGreaterThan(0);
      for (const block of shownAfter) expect(blockIds.get(block)! > newestCovered, `bloco ${block} depois do que o checkpoint cobre`).toBe(true);

      // A8: o checkpoint gravado tem as sete seções; a primeira compactação não leva checkpoint anterior e as seguintes o recebem inteiro, só com unidades novas.
      expect(SUMMARY_SECTIONS.every((title) => stored.summary.includes(`## ${title}`))).toBe(true);
      expect(inputOf(script.summaries[0]!).previousCheckpoint).toBeNull();
      const seen = new Set(inputOf(script.summaries[0]!).rows.map((row) => row.id));
      for (const [index, request] of script.summaries.slice(1).entries()) {
        const input = inputOf(request);
        expect(input.previousCheckpoint).toBe(checkpoint(`CHECKPOINT_${index + 1}`));
        expect(input.rows.length).toBeGreaterThan(0);
        for (const row of input.rows) { expect(seen.has(row.id), `linha ${row.id} repetida no resumo ${index + 2}`).toBe(false); seen.add(row.id); }
      }
      expect(script.summaries.every((request) => request.turns[0]!.text.includes('## Objetivo e pedidos do dono'))).toBe(true);
      expect(script.summaries.slice(1).every((request) => request.turns[0]!.text.includes('ATUALIZE o checkpoint'))).toBe(true);
      // Phase 11, A15: a primeira chamada (sem checkpoint anterior) já mostra o alvo e não pede para enxugar; cada atualização o mostra de novo e pede para enxugar.
      for (const [index, request] of script.summaries.entries()) expectSummaryTarget(request, index > 0);

      // Nada foi apagado: os 80 blocos seguem íntegros no banco (a tela, a busca e o recall leem de lá).
      const blocks = (await world.pool.query<{ total: string; shortest: string }>("SELECT count(*) AS total, min(length(content)) AS shortest FROM messages WHERE kind='activity' AND content LIKE 'BLOCO_%'")).rows[0]!;
      expect(Number(blocks.total)).toBe(80);
      expect(Number(blocks.shortest)).toBeGreaterThan(6000);
    } finally { await world.cleanup(); }
  }, 240_000);
});

// As "mais usadas" do bot (phase 15, passo 12; decisão 24, A42 e A43): com a conversa quente a lista é recalculada SÓ quando uma compactação é aplicada, na própria execução, pelo uso encerrado antes dela (a conversa que
// esfria também a recalcula, com prova em `tool-discovery.test.ts` e `cold-maintenance.test.ts`). Aqui a conversa nunca esfria: antes da primeira compactação vale a lista padrão; do pedido que traz o checkpoint em
// diante vale a lista do uso, igual em toda etapa e em todas as compactações seguintes (o uso não muda no meio).
describe('as mais usadas do bot mudam, com a conversa quente, só numa compactação aplicada (A42, A43)', () => {
  it('a lista padrão vale até a primeira compactação; o pedido que leva o checkpoint já traz a lista do uso do bot, e o campo tools não muda em nenhuma outra etapa', async () => {
    const world = await createRunsWorld({ tools: [bigResult, ...INTERNAL_TOOLS], coreCatalog: true, contextWindow: WINDOW });
    try {
      await world.models.test('opencode/glm-5.1');
      const bot = await world.createBot({ stepLimit: 100 });
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      // O uso do bot que a lista vai refletir (gravado antes da compactação): table_create e update_objective passam a ser as mais usadas, fora da lista padrão.
      const yesterday = new Date(Date.now() - 86_400_000);
      // Numa execução encerrada ontem: a contagem lê as atividades das execuções encerradas até a compactação.
      const seeded = (await world.pool.query<{ id: string }>("INSERT INTO runs(conversation_id, bot_id, status, input, created_at, started_at, finished_at) VALUES($1, $2, 'completed', 'seed', $3, $3, $3) RETURNING id::text", [conversationId, bot.id, yesterday])).rows[0]!.id;
      for (const [tool, count] of [['table_create', 14], ['update_objective', 10]] as const) {
        for (let index = 0; index < count; index += 1) await world.pool.query("INSERT INTO messages(conversation_id, run_id, role, kind, status, step, content, data, created_at) VALUES($1, $2, 'assistant', 'activity', 'completed', 1, 'ok', $3::jsonb, $4)", [conversationId, seeded, JSON.stringify({ tool }), yesterday]);
      }
      const script = newScript(60);
      scriptModel(world, script); world.engine.start();
      await world.waitForStatus(await world.send(bot, 'Levante os blocos de dados.'), 'completed', 180_000);
      expect(await contextFailures(world)).toEqual([]);
      expect(script.summaries.length).toBeGreaterThanOrEqual(2); // mais de uma compactação na rodada: o campo não muda na segunda
      const names = (request: ChatRequest): string[] => (request.tools ?? []).map((tool) => tool.name);
      const hasCheckpoint = (request: ChatRequest): boolean => checkpointIn(request) !== null;
      const firstWithCheckpoint = script.main.findIndex(hasCheckpoint);
      expect(firstWithCheckpoint).toBeGreaterThan(1);
      // Antes da primeira compactação: a lista padrão, em toda etapa. Do pedido que leva o checkpoint em diante: a lista do uso, em toda etapa e depois de cada nova compactação.
      const before = script.main.slice(0, firstWithCheckpoint), after = script.main.slice(firstWithCheckpoint);
      for (const request of before) expect(names(request)).toEqual([ABRIR_GRUPO, USE_TOOL, READ_ACTIVITY, ...DEFAULT_MOST_USED]);
      const recalculated = names(after[0]!);
      expect(recalculated.slice(0, 3)).toEqual([ABRIR_GRUPO, USE_TOOL, READ_ACTIVITY]);
      expect(recalculated.slice(3, 5)).toEqual(['table_create', 'update_objective']);
      expect(recalculated).not.toEqual(names(before[0]!));
      for (const request of after) expect(JSON.stringify(request.tools)).toBe(JSON.stringify(after[0]!.tools));
      for (const request of before) expect(JSON.stringify(request.tools)).toBe(JSON.stringify(before[0]!.tools));
    } finally { await world.cleanup(); }
  }, 240_000);
});

describe('o resumo que falha nunca derruba a execução (A6, C3, S1, S3)', () => {
  /** Resposta de resumo que não presta, por modo: saída vazia, ou texto cortado no limite de saída. */
  const failing = (mode: 'empty' | 'output_limit'): ChatEvent[] => (mode === 'empty' ? emptyReply
    : [{ type: 'text', text: 'Resumo cortado no meio' }, { type: 'usage', usage: { inputTokens: 300, outputTokens: SUMMARY_MAX_OUTPUT_TOKENS } }, { type: 'done', reason: 'output_limit' }]);

  it.each(['empty', 'output_limit'] as const)('%s: o pedido segue em índice, a execução conclui, e a execução seguinte com o mesmo histórico não grava nova linha de resumo', async (mode) => {
    const world = await newWorld();
    try {
      const bot = await world.createBot();
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      await seedHistory(world, conversationId, OVER_BUDGET_UNITS, 4000); // ~72 mil bytes: acima do orçamento e do limiar, sem usage (estimativa sem calibração)
      const script = newScript(0, () => failing(mode), null);
      scriptModel(world, script); world.engine.start();

      const first = await world.send(bot, 'Primeiro pedido pequeno.');
      await world.waitForStatus(first, 'completed', 60_000);
      expect(await world.runRow(first)).toMatchObject({ status: 'completed', failure_code: null });
      // Tentou resumir (escada de entradas menores) e falhou sempre pelo mesmo motivo; nada foi aplicado. Saída vazia e limite de saída não ganham o lembrete, então é no
      // máximo uma chamada por alvo (quatro); o teto geral da escada, com a segunda chamada de lembrete do formato inválido, é `SUMMARY_MAX_CALLS` (cinco) e tem prova própria abaixo.
      const attempts = await summaryRows(world, first);
      expect(attempts.length).toBeGreaterThanOrEqual(1);
      expect(attempts.length).toBeLessThanOrEqual(4);
      expect(attempts.every((row) => row.state === 'completed' && row.summary_outcome === mode)).toBe(true);
      expect(await checkpointRow(world)).toMatchObject({ revision: 0, summary: '' });
      // O colapso em índice (rede de segurança) segurou o pedido, que cabe, e a mensagem nova chegou inteira.
      expect(hasIndex(script.main[0]!)).toBe(true);
      expect(estimated(script.main[0]!)).toBeLessThanOrEqual(BUDGET);
      expect(script.main[0]!.turns.some((turn) => turn.role === 'user' && turn.text.includes('Primeiro pedido pequeno.'))).toBe(true);
      // A recusa ficou registrada pela impressão do conjunto, com a execução que desistiu.
      expect((await world.pool.query('SELECT run_id::text, outcome FROM context_summary_refusals')).rows).toEqual([{ run_id: first, outcome: mode }]);

      // A execução seguinte, com o mesmo histórico: nenhuma chamada de resumo nova, nenhuma linha nova de resumo, e o pedido segue em índice.
      const calls = script.summaries.length;
      const second = await world.send(bot, 'Segundo pedido pequeno.');
      await world.waitForStatus(second, 'completed', 60_000);
      expect(script.summaries.length).toBe(calls);
      expect(await summaryRows(world)).toHaveLength(attempts.length);
      expect(await contextFailures(world)).toEqual([]);
      expect(hasIndex(script.main[1]!)).toBe(true);
    } finally { await world.cleanup(); }
  }, 120_000);

  it('numa rodada longa com resumo que nunca presta, a execução desiste depois de UMA escada, segue em índice e conclui', async () => {
    const world = await newWorld();
    try {
      const bot = await world.createBot({ stepLimit: 100 });
      const script = newScript(60, () => emptyReply);
      scriptModel(world, script); world.engine.start();
      const run = await world.send(bot, 'Levante os blocos de dados.');
      await world.waitForStatus(run, 'completed', 180_000);
      expect(await contextFailures(world)).toEqual([]);
      // Uma escada só nesta execução (resposta vazia não ganha lembrete: no máximo uma chamada por alvo, quatro; o teto geral é `SUMMARY_MAX_CALLS`), mesmo com dezenas de
      // etapas pressionadas depois dela: a execução já desistiu.
      expect(script.summaries.length).toBeGreaterThanOrEqual(1);
      expect(script.summaries.length).toBeLessThanOrEqual(4);
      expect((await world.pool.query('SELECT count(*) AS total FROM context_summary_refusals WHERE run_id = $1', [run])).rows[0]!.total).toBe('1');
      // O colapso em índice segurou todos os pedidos dentro da janela real, e a abertura da rodada ficou em todos.
      expect(script.main.some(hasIndex)).toBe(true);
      for (const request of script.main) {
        expect(realTokens(request)).toBeLessThanOrEqual(BUDGET);
        expect(request.turns.some((turn) => turn.role === 'user' && turn.text.includes('Levante os blocos de dados.'))).toBe(true);
      }
    } finally { await world.cleanup(); }
  }, 240_000);

  it('queda do provedor no resumo: a execução conclui, a chamada incerta fica registrada e a execução não a repete', async () => {
    const world = await newWorld();
    try {
      const bot = await world.createBot();
      await seedHistory(world, await world.conversations.conversationIdOf(bot.id), OVER_BUDGET_UNITS, 4000);
      const script = newScript(0, () => new Error('conexão caiu'), null);
      scriptModel(world, script); world.engine.start();
      const run = await world.send(bot, 'Pedido pequeno.');
      await world.waitForStatus(run, 'completed', 60_000);
      expect(await contextFailures(world)).toEqual([]);
      expect(script.summaries).toHaveLength(1);
      expect(await summaryRows(world, run)).toEqual([expect.objectContaining({ state: 'unknown', summary_outcome: null })]);
      expect(hasIndex(script.main[0]!)).toBe(true);
    } finally { await world.cleanup(); }
  }, 60_000);

  it('recusa que repetir não resolve (400 comum do provedor) encerra a escada na primeira chamada e fica registrada', async () => {
    const world = await newWorld();
    try {
      const bot = await world.createBot();
      await seedHistory(world, await world.conversations.conversationIdOf(bot.id), OVER_BUDGET_UNITS, 4000);
      const script = newScript(0, () => new ChatRejected(400), null);
      scriptModel(world, script); world.engine.start();
      const run = await world.send(bot, 'Pedido pequeno.');
      await world.waitForStatus(run, 'completed', 60_000);
      expect(script.summaries).toHaveLength(1);
      expect((await world.pool.query('SELECT outcome FROM context_summary_refusals')).rows).toEqual([{ outcome: 'rejected' }]);
    } finally { await world.cleanup(); }
  }, 60_000);

  it('resposta válida que não pôde ser aplicada (conflito no commit): a execução conclui em índice, o custo fica no ledger como incerto e nenhuma recusa durável é gravada', async () => {
    const world = await newWorld();
    const commit = vi.spyOn(checkpoints, 'commitContextSummary').mockResolvedValue(false);
    try {
      const bot = await world.createBot();
      await seedHistory(world, await world.conversations.conversationIdOf(bot.id), OVER_BUDGET_UNITS, 4000);
      const script = newScript(0, () => reply('NAO_APLICADO'), null);
      scriptModel(world, script); world.engine.start();
      const run = await world.send(bot, 'Pedido pequeno.');
      await world.waitForStatus(run, 'completed', 60_000);
      expect(await contextFailures(world)).toEqual([]);
      // Conflito não é culpa do modelo: a escada para na primeira chamada, nada é aplicado e nenhuma recusa fica gravada (a entrada da execução seguinte será outra).
      expect(commit).toHaveBeenCalledTimes(1);
      expect(script.summaries).toHaveLength(1);
      expect(await checkpointRow(world)).toMatchObject({ revision: 0, summary: '' });
      expect((await world.pool.query('SELECT count(*) AS total FROM context_summary_refusals')).rows[0]!.total).toBe('0');
      // O custo observado fica gravado, e a linha NÃO fecha como concluída: é o que impede a retomada depois de um crash de pagar a mesma entrada de novo.
      expect((await world.pool.query("SELECT state, input_tokens::text, output_tokens::text FROM model_call_usage WHERE purpose='summary'")).rows).toEqual([{ state: 'unknown', input_tokens: '300', output_tokens: '200' }]);
      expect(hasIndex(script.main[0]!)).toBe(true); // o colapso em índice segurou o pedido
    } finally { await world.cleanup(); }
  }, 60_000);
});

describe('consistência da etapa: modelo, janela e effort (CTX-09 só tira objetivo, memória, sistema, catálogo e idioma)', () => {
  it.each([['a janela', 'janela'], ['o effort', 'effort']] as const)('trocar %s no meio da chamada de resumo descarta o resumo pronto: nada é aplicado e a etapa prepara de novo (uma vez) e conclui com a configuração vigente', async (_label, change) => {
    const world = await newWorld();
    try {
      const bot = await world.createBot();
      await seedHistory(world, await world.conversations.conversationIdOf(bot.id), OVER_BUDGET_UNITS, 4000);
      const script = newScript(0, () => reply('CONFIGURACAO_ANTIGA'), null);
      // O dono mexe na configuração enquanto a chamada paga está no ar: a janela do contexto ou o effort do bot.
      script.beforeSummary = async () => {
        if (change === 'janela') await world.pool.query('UPDATE app_settings SET bot_context_window_tokens = 131072');
        else await world.pool.query("UPDATE bots SET effort = 'high'");
      };
      scriptModel(world, script); world.engine.start();
      const run = await world.send(bot, 'Pedido pequeno.');
      await waitFor('desfecho da execução', async () => ['completed', 'failed'].includes((await world.runRow(run)).status), 60_000);
      // O pedido pronto foi dimensionado para a configuração antiga e não vai ao provedor: a etapa prepara de novo UMA vez com a vigente (A15) e a execução conclui, sem
      // CONTEXT_COMPACTION_FAILED (o código do resumo, que aqui não falhou: a configuração mudou). Uma única chamada principal, já da preparação nova.
      expect(await world.runRow(run)).toMatchObject({ status: 'completed', failure_code: null });
      expect(script.main).toHaveLength(1);
      // O resumo pronto foi descartado: nada aplicado, e a execução não paga outro (a linha incerta a faz desistir de resumir, `summaryGivenUp`).
      expect(script.summaries).toHaveLength(1);
      expect(await checkpointRow(world)).toMatchObject({ revision: 0, summary: '' });
      // A resposta válida descartada fica no ledger como incerta, com o consumo observado.
      expect((await world.pool.query("SELECT state, input_tokens::text FROM model_call_usage WHERE purpose='summary'")).rows).toEqual([{ state: 'unknown', input_tokens: '300' }]);
    } finally { await world.cleanup(); }
  }, 60_000);

  it('objetivo e memória editados no meio da chamada de resumo NÃO derrubam a etapa nem o checkpoint (CTX-09)', async () => {
    const world = await newWorld();
    try {
      const bot = await world.createBot();
      await seedHistory(world, await world.conversations.conversationIdOf(bot.id), OVER_BUDGET_UNITS, 4000);
      const script = newScript(0, () => reply('EDICAO_NO_MEIO'), null);
      script.beforeSummary = async () => {
        await world.pool.query("UPDATE bot_objectives SET content = 'Objetivo editado durante o resumo', version = version + 1");
        await world.pool.query("UPDATE bots SET instructions = 'Instruções editadas durante o resumo'");
      };
      scriptModel(world, script); world.engine.start();
      const run = await world.send(bot, 'Pedido pequeno.');
      await world.waitForStatus(run, 'completed', 60_000);
      expect(await contextFailures(world)).toEqual([]);
      expect((await checkpointRow(world)).summary).toBe(checkpoint('EDICAO_NO_MEIO'));
      expect(await summaryRows(world, run)).toEqual([expect.objectContaining({ state: 'completed', summary_outcome: 'applied' })]);
    } finally { await world.cleanup(); }
  }, 60_000);
});

describe('o resumo bem formado e a escada de entrada (S4, S6)', () => {
  it('fora do formato há UMA segunda tentativa com o lembrete, e a segunda vale', async () => {
    const world = await newWorld();
    try {
      const bot = await world.createBot();
      await seedHistory(world, await world.conversations.conversationIdOf(bot.id), OVER_BUDGET_UNITS, 4000);
      const script = newScript(0, (call) => (call === 1 ? [{ type: 'text', text: 'Resumo livre, sem as seções combinadas.' }, { type: 'usage', usage: { inputTokens: 300, outputTokens: 20 } }, { type: 'done', reason: 'stop' }] : reply('SEGUNDA_TENTATIVA')), null);
      scriptModel(world, script); world.engine.start();
      const run = await world.send(bot, 'Pedido pequeno.');
      await world.waitForStatus(run, 'completed', 60_000);
      expect(script.summaries).toHaveLength(2);
      expect(script.summaries[0]!.turns[0]!.text).not.toContain('ATENÇÃO');
      expect(script.summaries[1]!.turns[0]!.text).toContain('ATENÇÃO: a resposta anterior não seguiu o formato');
      // A15: o alvo vale já na primeira tentativa (não só no lembrete) e a segunda o mantém; sem checkpoint anterior, nenhuma pede para enxugar.
      for (const request of script.summaries) expectSummaryTarget(request, false);
      expect(inputOf(script.summaries[1]!)).toEqual(inputOf(script.summaries[0]!)); // a mesma entrada: só o lembrete muda
      expect((await checkpointRow(world)).summary).toBe(checkpoint('SEGUNDA_TENTATIVA'));
      expect(await summaryRows(world, run)).toEqual([expect.objectContaining({ state: 'completed', summary_outcome: null }), expect.objectContaining({ state: 'completed', summary_outcome: 'applied' })]);
      expect(checkpointIn(script.main[0]!)).toContain('SEGUNDA_TENTATIVA');
    } finally { await world.cleanup(); }
  }, 60_000);

  it('pior caso da escada: formato inválido duas vezes no primeiro alvo e depois 70%, 50% e 35% fazem exatamente SUMMARY_MAX_CALLS chamadas, e a execução conclui', async () => {
    const world = await newWorld();
    try {
      const bot = await world.createBot();
      // Histórico em muitas unidades pequenas: cada alvo menor da escada ainda consegue descartar unidades e reduzir de fato a entrada (sem redução a escada para antes).
      await seedHistory(world, await world.conversations.conversationIdOf(bot.id), 30, 2500);
      const malformed: ChatEvent[] = [{ type: 'text', text: 'Resumo livre, sem as seções combinadas.' }, { type: 'usage', usage: { inputTokens: 300, outputTokens: 20 } }, { type: 'done', reason: 'stop' }];
      const script = newScript(0, () => malformed, null);
      scriptModel(world, script); world.engine.start();
      const run = await world.send(bot, 'Pedido pequeno.');
      await world.waitForStatus(run, 'completed', 60_000);
      // A execução nunca falha só porque o resumo falhou (C3), e o pedido segue em índice, sem checkpoint.
      expect(await contextFailures(world)).toEqual([]);
      expect(await checkpointRow(world)).toMatchObject({ revision: 0, summary: '' });
      expect(hasIndex(script.main[0]!)).toBe(true);
      // Prende o laço do executor à constante: se um deles mudar sem o outro, este teste falha (o harness de comparação aplica `SUMMARY_MAX_CALLS` como teto).
      expect(script.summaries).toHaveLength(SUMMARY_MAX_CALLS);
      // O lembrete só existe na segunda chamada, e ela repete a MESMA entrada da primeira; as três seguintes vêm com o texto sem lembrete e entradas estritamente menores.
      expect(script.summaries.map((request) => request.turns[0]!.text.includes('ATENÇÃO: a resposta anterior não seguiu o formato'))).toEqual([false, true, false, false, false]);
      expect(inputOf(script.summaries[1]!)).toEqual(inputOf(script.summaries[0]!));
      for (const request of script.summaries) expectSummaryTarget(request, false); // o alvo acompanha toda tentativa da escada, não só a primeira
      const sizes = script.summaries.map(estimated);
      expect(sizes[2]!).toBeLessThan(sizes[1]!);
      expect(sizes[3]!).toBeLessThan(sizes[2]!);
      expect(sizes[4]!).toBeLessThan(sizes[3]!);
      // Cada chamada paga tem linha no ledger (formato inválido não tem desfecho próprio) e a recusa fica registrada UMA vez, pela impressão do conjunto, com esta execução.
      expect(await summaryRows(world, run)).toEqual(Array.from({ length: SUMMARY_MAX_CALLS }, () => expect.objectContaining({ state: 'completed', summary_outcome: null })));
      expect((await world.pool.query('SELECT run_id::text, outcome FROM context_summary_refusals')).rows).toEqual([{ run_id: run, outcome: 'format' }]);
    } finally { await world.cleanup(); }
  }, 60_000);

  it('recusa de contexto do PRÓPRIO resumo reduz a entrada e repete com a menor', async () => {
    const world = await newWorld();
    try {
      const bot = await world.createBot();
      await seedHistory(world, await world.conversations.conversationIdOf(bot.id), OVER_BUDGET_UNITS, 4000);
      const script = newScript(0, (call) => (call === 1 ? new ChatRejected(400, false, true) : reply('ENTRADA_MENOR')), null);
      scriptModel(world, script); world.engine.start();
      const run = await world.send(bot, 'Pedido pequeno.');
      await world.waitForStatus(run, 'completed', 60_000);
      expect(await contextFailures(world)).toEqual([]);
      expect(script.summaries).toHaveLength(2);
      expect(estimated(script.summaries[1]!)).toBeLessThanOrEqual(Math.floor(0.7 * estimated(script.summaries[0]!)) + 1_000); // alvo de 70% do tamanho recusado (mais o prompt, que não encolhe)
      expect(estimated(script.summaries[1]!)).toBeLessThan(estimated(script.summaries[0]!));
      expect(checkpointIn(script.main[0]!)).toContain('ENTRADA_MENOR');
      expect((await world.pool.query('SELECT count(*) AS total FROM context_summary_refusals')).rows[0]!.total).toBe('0');
    } finally { await world.cleanup(); }
  }, 60_000);

  it('efeito externo incerto entra no lote com o estado explícito e não bloqueia o resumo', async () => {
    const world = await newWorld();
    try {
      const bot = await world.createBot();
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      await seedHistory(world, conversationId, 4, 4000);
      const external = (await world.pool.query<{ id: string }>(
        `INSERT INTO messages(conversation_id,role,kind,status,step,content,data,tool_arguments,evidence_provenance,created_at)
         VALUES($1,'assistant','activity','failed',1,'Interrompida pelo dono. A ação pode ter sido concluída.',$2,'{"to":"cliente"}','{"attachments":[],"tables":[]}',now()) RETURNING id::text AS id`,
        [conversationId, JSON.stringify({ callId: 'externa', tool: 'GMAIL_SEND', label: 'Enviar e-mail', arguments: '{}', detail: null, external: true })])).rows[0]!.id;
      await seedHistory(world, conversationId, 14, 4000);
      const script = newScript(0, () => reply('COM_EXTERNO'), null);
      scriptModel(world, script); world.engine.start();
      const run = await world.send(bot, 'Pedido pequeno.');
      await world.waitForStatus(run, 'completed', 60_000);
      const rows = inputOf(script.summaries[0]!).rows;
      expect(rows.find((row) => row.id === external)).toMatchObject({ tool: 'GMAIL_SEND', external: true, externalEffect: 'uncertain', status: 'failed' });
      expect(script.summaries[0]!.turns[0]!.text).toContain('INCERTAS');
      expect(checkpointIn(script.main[0]!)).toContain('COM_EXTERNO');
      expect((await checkpointRow(world)).covered).toContain(external);
    } finally { await world.cleanup(); }
  }, 60_000);
});

describe('quando vale pagar a compactação', () => {
  it('um pedido dominado pelo que fica íntegro (a etapa mais recente volumosa) não paga resumo em vão: cobrir o lote não o tiraria do limiar', async () => {
    const world = await newWorld();
    try {
      const bot = await world.createBot({ stepLimit: 100 });
      // Uma etapa com seis blocos largos (18,6 mil bytes cada; eram oito com o orçamento de 55.296, e oito já passariam dos 47.104): o pedido final fica entre 90% e 100% do orçamento, e tudo o que não é a etapa mais recente é só a seleção da ferramenta.
      const script = newScript(1);
      script.tool = 'big_cjk'; script.perStep = 6;
      scriptModel(world, script); world.engine.start();
      const run = await world.send(bot, 'Levante os textos.');
      await world.waitForStatus(run, 'completed', 60_000);
      expect(script.main).toHaveLength(3);
      const last = script.main.at(-1)!;
      expect(Math.round(estimateChatPayload(last, 'chat_completions').textTokens * 0.36)).toBeGreaterThanOrEqual(Math.floor(0.9 * BUDGET)); // premissa: o pedido está no limiar
      expect(realTokens(last)).toBeLessThanOrEqual(BUDGET);
      expect(script.summaries).toHaveLength(0); // sem o guarda, a seleção da ferramenta seria resumida a cada etapa
      expect(await summaryRows(world)).toEqual([]);
      expect(await contextFailures(world)).toEqual([]);
    } finally { await world.cleanup(); }
  }, 60_000);
});

describe('rede de segurança para anexos (F4, último degrau do colapso)', () => {
  it('documento grande na mensagem do dono não derruba a execução: sem espaço, o conteúdo vira referência (read_attachment) e o texto do dono segue íntegro', async () => {
    const world = await createRunsWorld({ tools: [readAttachmentTool], contextWindow: WINDOW });
    try {
      await world.models.test('opencode/glm-5.1');
      const bot = await world.createBot();
      const document = '文書の合成内容 '.repeat(4300); // ~30 mil caracteres de texto largo (3 bytes cada, ~90 mil bytes): inline estoura o orçamento de 64k sem calibração
      const file = await new AttachmentService({ pool: world.pool, conversations: world.conversations }).upload(bot.id, 'grande.txt', Buffer.from(document));
      const script = newScript(0, undefined, null);
      scriptModel(world, script); world.engine.start();
      const run = (await world.conversations.send(bot.id, 'Resuma o documento anexado.', [file.id])).id;
      await world.waitForStatus(run, 'completed', 60_000);
      expect(await contextFailures(world)).toEqual([]);
      const opening = script.main[0]!.turns.filter((turn) => turn.role === 'user').map((turn) => turn.text).join('\n');
      expect(opening).toContain('Resuma o documento anexado.'); // o texto do dono, íntegro
      expect(opening).toContain(`Anexo id=${file.id}`);
      expect(opening).toContain('read_attachment'); // o modelo sabe onde ler o documento
      expect(opening).not.toContain('文書の合成内容 文書の合成内容'); // o conteúdo não foi inline
      expect(estimated(script.main[0]!)).toBeLessThanOrEqual(BUDGET);
      expect(script.summaries).toHaveLength(0); // um anexo da rodada atual não é histórico: nada a resumir
    } finally { await world.cleanup(); }
  }, 60_000);
});

describe('o que invalida o checkpoint (A7, CTX-09, O4)', () => {
  it('editar memória, Regras Globais e objetivo mantém o checkpoint sem novo resumo; mudar uma linha coberta o invalida e o resumo é refeito', async () => {
    const world = await newWorld();
    try {
      const bot = await world.createBot();
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      await seedHistory(world, conversationId, OVER_BUDGET_UNITS, 4000);
      const script = newScript(0, (call) => reply(`CHECKPOINT_${call}`), null);
      scriptModel(world, script); world.engine.start();
      await world.waitForStatus(await world.send(bot, 'Primeiro pedido.'), 'completed', 60_000);
      const stored = await checkpointRow(world);
      expect(stored.revision).toBe(1);
      expect(script.summaries).toHaveLength(1);

      // Edições do dono: memória do bot, Regras Globais e objetivo. Nenhuma toca o histórico coberto.
      const botMemory = await world.memory.read({ scope: 'bot', botId: bot.id });
      await world.memory.save({ scope: 'bot', botId: bot.id }, 'MEMORIA_NOVA_DO_BOT', botMemory.version, ORIGIN);
      const globalMemory = await world.memory.read({ scope: 'global' });
      await world.memory.save({ scope: 'global' }, 'REGRA_GLOBAL_NOVA', globalMemory.version, ORIGIN);
      await world.pool.query("UPDATE bot_objectives SET content = 'OBJETIVO_NOVO', version = version + 1 WHERE bot_id = $1", [bot.id]);
      await world.waitForStatus(await world.send(bot, 'Segundo pedido.'), 'completed', 60_000);
      const kept = script.main.at(-1)!;
      expect(script.summaries).toHaveLength(1); // nenhum resumo novo pago
      expect(await checkpointRow(world)).toEqual(stored); // o checkpoint e o conjunto coberto não se mexeram
      expect(checkpointIn(kept)).toContain('CHECKPOINT_1');
      // As edições valem no pedido: o sistema e o objetivo já levam o texto novo, sem terem custado o checkpoint.
      expect(kept.turns[0]!.text).toContain('MEMORIA_NOVA_DO_BOT');
      expect(kept.turns[0]!.text).toContain('REGRA_GLOBAL_NOVA');
      expect(JSON.stringify(kept.turns)).toContain('OBJETIVO_NOVO');

      // Mudar uma linha COBERTA invalida: o histórico original volta ao pedido, o limiar é atingido de novo e o resumo é refeito (revisão 2).
      await world.pool.query("UPDATE messages SET content = content || ' [editado]' WHERE id = $1", [stored.covered[0]]);
      await world.waitForStatus(await world.send(bot, 'Terceiro pedido.'), 'completed', 60_000);
      expect(script.summaries).toHaveLength(2);
      expect((await checkpointRow(world)).revision).toBe(2);
      expect(checkpointIn(script.main.at(-1)!)).toContain('CHECKPOINT_2');
      expect(checkpointIn(script.main.at(-1)!)).not.toContain('CHECKPOINT_1');
      expect(await contextFailures(world)).toEqual([]);
    } finally { await world.cleanup(); }
  }, 120_000);

  it('Chat geral: só o caminho ativo conta; trocar o caminho invalida a cobertura e a pergunta "há algo antes?" ignora as outras ramificações', async () => {
    const world = await createRunsWorld({ contextWindow: WINDOW });
    try {
      await world.models.test('opencode/glm-5.1');
      const session = await new GeneralChatService({ pool: world.pool }).create();
      const ref = { sessionId: session.id };
      await world.conversations.setPreference(ref, 'opencode/glm-5.1', null);
      world.engine.start();
      const say = async (text: string) => { const run = await world.conversations.send(ref, text); await world.waitForStatus(run.id, 'completed'); return run.id; };
      const first = await say('primeira mensagem');
      await say('segunda mensagem');
      const messageOf = (await world.pool.query<{ id: string }>('SELECT trigger_message_id::text AS id FROM runs WHERE id = $1', [first])).rows[0]!.id;

      // Um checkpoint que cobre a primeira rodada (a mensagem e a resposta); com o caminho como está, ele vale.
      const before = await loadManagedContext(world.pool, session.id);
      const covered = before.rows.slice(0, 2);
      expect(await commitContextSummary(world.pool, session.id, before.checkpoint.revision, checkpoint('NO_CAMINHO'), covered, mergeEvidence(), new Date())).toBe(true);
      const current = await loadManagedContext(world.pool, session.id);
      expect(await validCheckpoint(world.pool, session.id, null, current.checkpoint, current.rows)).toBe(true);

      // Editar a primeira mensagem abre outra ramificação: as linhas cobertas saem do caminho ativo e o checkpoint deixa de valer.
      await world.waitForStatus((await world.conversations.edit(ref, messageOf, 'primeira mensagem editada')).id, 'completed');
      const edited = await loadManagedContext(world.pool, session.id);
      expect(edited.rows.some((row) => covered.some((entry) => entry.id === row.id))).toBe(false);
      expect(await validCheckpoint(world.pool, session.id, null, edited.checkpoint, edited.rows)).toBe(false);

      // O4: com a cobertura recomeçando depois da edição, as linhas da ramificação antiga (ids menores) não decidem se o prefixo da sessão está presente.
      await world.pool.query('DELETE FROM conversation_context WHERE conversation_id = $1', [session.id]);
      const restarted = await loadManagedContext(world.pool, session.id);
      expect(restarted.wholeConversation).toBe(true);
    } finally { await world.cleanup(); }
  }, 60_000);
});

describe('recusa de contexto do provedor (A9, F4)', () => {
  it.each([{ second: 'aceita', status: 'completed' }, { second: 'recusa', status: 'failed' }] as const)('a primeira chamada recusada por tamanho: uma compactação forçada e uma nova chamada; segunda $second', async ({ second, status }) => {
    const world = await newWorld();
    try {
      const bot = await world.createBot();
      await seedHistory(world, await world.conversations.conversationIdOf(bot.id), 5, 3000); // ~15 mil bytes: abaixo do limiar, nada a compactar sem a recusa
      const script = newScript(0, () => reply('FORCADA'), null);
      script.refuse = (call) => call === 0 || second === 'recusa';
      scriptModel(world, script); world.engine.start();
      const run = await world.send(bot, 'Pedido pequeno.');
      await world.waitForStatus(run, status, 60_000);
      expect(script.main).toHaveLength(2); // a original e UMA nova chamada, nunca mais
      expect(script.summaries).toHaveLength(1); // uma compactação, forçada pela recusa e mesmo abaixo do limiar
      expect((await checkpointRow(world)).revision).toBe(1);
      expect(await world.runRow(run)).toMatchObject({ status, failure_code: status === 'failed' ? 'CONTEXT_TOO_LARGE' : null });
    } finally { await world.cleanup(); }
  }, 60_000);
});

describe('modelo do resumo (A13)', () => {
  it.each([
    { name: 'validado, outro protocolo', summaryModel: 'opencode/grok-4.7', validated: true, expected: { model: 'opencode/grok-4.7', protocol: 'responses', effort: 'low' } },
    { name: 'validado, sem nível de effort', summaryModel: 'opencode/glm-5.3-flash', validated: true, expected: { model: 'opencode/glm-5.3-flash', protocol: 'chat_completions', effort: undefined } },
    { name: 'não validado no uso: cai no modelo da conversa', summaryModel: 'opencode/grok-4.7', validated: false, expected: { model: 'opencode/glm-5.1', protocol: 'chat_completions', effort: 'low' } },
    { name: 'vazio: o modelo da conversa', summaryModel: null, validated: false, expected: { model: 'opencode/glm-5.1', protocol: 'chat_completions', effort: 'low' } },
  ])('$name', async ({ summaryModel, validated, expected }) => {
    const world = await newWorld();
    try {
      if (summaryModel && validated) await world.models.test(summaryModel);
      await world.pool.query('UPDATE app_settings SET summary_model = $1', [summaryModel]);
      // Effort alto na conversa: o do resumo vem do perfil do modelo que RESUME, sempre o mais baixo que ele aceita.
      const bot = await world.createBot({ effort: 'high' });
      await seedHistory(world, await world.conversations.conversationIdOf(bot.id), OVER_BUDGET_UNITS, 4000);
      const script = newScript(0, () => reply('MODELO_DO_RESUMO'), null);
      scriptModel(world, script); world.engine.start();
      const run = await world.send(bot, 'Pedido pequeno.');
      await world.waitForStatus(run, 'completed', 60_000);
      expect(script.summaries[0]).toMatchObject({ model: expected.model, maxTokens: SUMMARY_MAX_OUTPUT_TOKENS });
      expect(script.summaries[0]!.effort).toBe(expected.effort);
      expect(script.summaryProtocols[0]).toBe(expected.protocol);
      expect(script.main[0]!.model).toBe('opencode/glm-5.1');
      expect((await summaryRows(world, run))[0]).toMatchObject({ model: expected.model, summary_outcome: 'applied' });
      expect(await contextFailures(world)).toEqual([]);
    } finally { await world.cleanup(); }
  }, 60_000);
});

describe('modelo do resumo oculto em Conexões (phase 17, A9)', () => {
  it('o resumo segue usando o modelo salvo mesmo oculto: oculto só o tira das escolhas novas', async () => {
    const world = await newWorld();
    try {
      await world.models.test('opencode/grok-4.7');
      await world.pool.query('UPDATE app_settings SET summary_model = $1', ['opencode/grok-4.7']);
      await world.models.setHidden('opencode/grok-4.7', true);
      const bot = await world.createBot({ effort: 'high' });
      await seedHistory(world, await world.conversations.conversationIdOf(bot.id), OVER_BUDGET_UNITS, 4000);
      const script = newScript(0, () => reply('RESUMO_COM_MODELO_OCULTO'), null);
      scriptModel(world, script); world.engine.start();
      const run = await world.send(bot, 'Pedido pequeno.');
      await world.waitForStatus(run, 'completed', 60_000);
      expect(script.summaries[0]).toMatchObject({ model: 'opencode/grok-4.7' });
      expect((await summaryRows(world, run))[0]).toMatchObject({ model: 'opencode/grok-4.7', summary_outcome: 'applied' });
      expect(await contextFailures(world)).toEqual([]);
    } finally { await world.cleanup(); }
  }, 60_000);
});

describe('Compactar agora (manual, F6)', () => {
  /** O clique do painel: enfileira com a revisão lida agora, espera a operação terminar e devolve o estado público. */
  async function compactNow(world: RunsWorld, botId: string) {
    const state = await world.conversations.contextState(botId), requestId = randomUUID();
    await world.conversations.maintainContext(botId, { requestId, mode: 'summarize', expectedRevision: state.revision }, randomUUID());
    const run = (await world.pool.query<{ id: string }>('SELECT id::text FROM runs WHERE context_operation_id=$1', [requestId])).rows[0]!.id;
    await waitFor('manutenção', async () => ['completed', 'failed'].includes((await world.runRow(run)).status), 30_000);
    return { run, state: await world.conversations.contextState(botId) };
  }

  it('abaixo do limiar, cobre o histórico antigo com o mesmo motor e não pede nada à rodada atual (a conversa está ociosa)', async () => {
    const world = await newWorld();
    try {
      const bot = await world.createBot();
      await seedHistory(world, await world.conversations.conversationIdOf(bot.id), 5, 3000);
      const script = newScript(0, () => reply('MANUAL'), null);
      scriptModel(world, script); world.engine.start();
      const { run, state } = await compactNow(world, bot.id);
      expect(await world.runRow(run)).toMatchObject({ status: 'completed', failure_code: null });
      expect(state.operation).toMatchObject({ status: 'completed', result: { changed: true } });
      expect(script.summaries).toHaveLength(1);
      const stored = await checkpointRow(world);
      expect(stored.summary).toBe(checkpoint('MANUAL'));
      expect(stored.covered.length).toBeGreaterThan(0);
      expect(script.main).toHaveLength(0); // manutenção não chama o modelo principal
    } finally { await world.cleanup(); }
  }, 60_000);

  it('havendo o que cobrir e nada aplicado, falha com CONTEXT_COMPACTION_FAILED ("nada foi alterado") e uma nova tentativa do dono paga de novo', async () => {
    const world = await newWorld();
    try {
      const bot = await world.createBot();
      await seedHistory(world, await world.conversations.conversationIdOf(bot.id), 5, 3000);
      const script = newScript(0, () => emptyReply, null);
      scriptModel(world, script); world.engine.start();
      const first = await compactNow(world, bot.id);
      expect(first.state.operation).toMatchObject({ status: 'failed', errorCode: 'CONTEXT_COMPACTION_FAILED' });
      expect(await checkpointRow(world)).toMatchObject({ revision: 0, summary: '' });
      const calls = script.summaries.length;
      // O gesto manual ignora a recusa gravada: o dono pode tentar de novo (agora com um resumo que presta).
      script.summary = () => reply('DEPOIS');
      const second = await compactNow(world, bot.id);
      expect(second.state.operation).toMatchObject({ status: 'completed' });
      expect(script.summaries.length).toBeGreaterThan(calls);
      expect((await checkpointRow(world)).summary).toBe(checkpoint('DEPOIS'));
    } finally { await world.cleanup(); }
  }, 60_000);

  it('A20: saldo esgotado no resumo falha com PROVIDER_CREDITS_EXHAUSTED e o motivo próprio, não é tratado como recusa do modelo (nenhuma recusa gravada) e a nova tentativa do dono paga de novo', async () => {
    const world = await newWorld();
    try {
      const bot = await world.createBot();
      await seedHistory(world, await world.conversations.conversationIdOf(bot.id), 5, 3000);
      const script = newScript(0, () => new DomainError('PROVIDER_CREDITS_EXHAUSTED'), null);
      scriptModel(world, script); world.engine.start();
      const first = await compactNow(world, bot.id);
      expect(await world.runRow(first.run)).toMatchObject({ status: 'failed', failure_code: 'PROVIDER_CREDITS_EXHAUSTED' });
      expect(first.state.operation).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_CREDITS_EXHAUSTED' });
      expect(contextFailureMessage('PROVIDER_CREDITS_EXHAUSTED')).toBe('Créditos da Anthropic esgotados.');
      expect(await checkpointRow(world)).toMatchObject({ revision: 0, summary: '' });
      expect(script.summaries).toHaveLength(1); // uma chamada, sem nova tentativa
      expect((await world.pool.query('SELECT count(*) AS total FROM context_summary_refusals')).rows[0]!.total).toBe('0');
      // Com o saldo de volta, a mesma operação do dono funciona: nada ficou registrado contra o conjunto.
      script.summary = () => reply('COM SALDO');
      expect((await compactNow(world, bot.id)).state.operation).toMatchObject({ status: 'completed' });
      expect((await checkpointRow(world)).summary).toBe(checkpoint('COM SALDO'));
    } finally { await world.cleanup(); }
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// Peças puras: o que as jornadas acima não alcançam com precisão
// ---------------------------------------------------------------------------------------------

/** Linha de histórico mínima para as peças puras. */
function fixture(id: number, extra: Partial<ContextRow> & { tool?: string; external?: boolean; step?: number } = {}): ContextRow {
  const { tool, external, step, ...row } = extra;
  const activity = tool !== undefined;
  return { id: String(id), run_id: '1', role: activity ? 'assistant' : 'user', kind: activity ? 'activity' : 'text', status: activity ? 'completed' : 'done', opens_round: !activity, step: activity ? (step ?? id) : null, content: `linha ${id}`,
    data: activity ? { callId: `c${id}`, tool, label: tool, arguments: '{}', detail: null, ...(external ? { external: true } : {}) } : {}, ...row };
}

describe('judgeSummary', () => {
  const valid = checkpoint('conteúdo');
  const base = { finishReason: 'stop', toolCalled: false, outputTokens: 100, maxOutputTokens: 6144 };
  it('aceita as sete seções em ordem (o preâmbulo sai) e recusa o que não presta, dizendo se vale uma segunda tentativa', () => {
    expect(judgeSummary({ ...base, text: valid })).toEqual({ ok: true, text: valid });
    expect(judgeSummary({ ...base, text: `Aqui está o resumo:\n\n${valid}\n` })).toEqual({ ok: true, text: valid });
    expect(judgeSummary({ ...base, text: valid.replace('## Estado', '## Estado (feito, em andamento, bloqueado)') })).toMatchObject({ ok: true });
    // Fora do formato ou grande demais: uma segunda tentativa com o lembrete certo.
    expect(judgeSummary({ ...base, text: 'só texto' })).toEqual({ ok: false, failure: 'format', retry: 'format' });
    expect(judgeSummary({ ...base, text: valid.replace(/## Decisões\n/u, '') })).toEqual({ ok: false, failure: 'format', retry: 'format' });
    const swapped = SUMMARY_SECTIONS.toReversed().map((title) => `## ${title}\nNada.`).join('\n\n');
    expect(judgeSummary({ ...base, text: swapped })).toEqual({ ok: false, failure: 'format', retry: 'format' });
    expect(judgeSummary({ ...base, text: `${valid}\n${'x'.repeat(16_000)}` })).toEqual({ ok: false, failure: 'format', retry: 'length' });
    expect(judgeSummary({ ...base, text: valid, toolCalled: true })).toEqual({ ok: false, failure: 'format', retry: 'format' });
    expect(judgeSummary({ ...base, text: valid, cutShort: true })).toEqual({ ok: false, failure: 'format', retry: 'length' });
    // Sem texto ou sem terminar com sucesso: repetir igual não melhora.
    expect(judgeSummary({ ...base, text: '  \n ' })).toEqual({ ok: false, failure: 'empty', retry: null });
    expect(judgeSummary({ ...base, text: valid, finishReason: 'output_limit' })).toEqual({ ok: false, failure: 'output_limit', retry: null });
    expect(judgeSummary({ ...base, text: valid, outputTokens: 6145 })).toEqual({ ok: false, failure: 'output_limit', retry: null });
    expect(judgeSummary({ ...base, text: valid, finishReason: null })).toMatchObject({ ok: false, failure: 'format' });
  });

  it('o prompt traz as sete seções, na ordem, nos dois modos, e o lembrete só na segunda tentativa', () => {
    for (const update of [false, true]) {
      const prompt = summaryPrompt({ update });
      const positions = SUMMARY_SECTIONS.map((title) => prompt.lastIndexOf(`## ${title}`));
      expect(positions.every((at) => at > 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      // T10: o conteúdo do anexo sai do pedido quando a mensagem é coberta, então o resumo cita o id e o nome do anexo, lido por read_attachment (id de anexo não é messageId).
      expect(prompt).toContain('cite em Referências o id e o nome de cada anexo');
      expect(prompt).toContain('read_attachment');
      expect(prompt).toContain('nunca o liste como id de read_activity');
      expect(prompt).not.toContain('ATENÇÃO');
      expect(prompt.includes('ATUALIZE o checkpoint')).toBe(update);
      // Phase 11, A15: o alvo de 4.000 a 6.000 caracteres está no prompt SEM lembrete, o teto de 16.000 vem dito como teto (a validação segue em 16.000, abaixo) e só o modo
      // atualizar pede para enxugar o que perdeu relevância, sem abrir mão do que o dono restringiu, dos efeitos externos nem das referências.
      expect(prompt).toContain('o alvo é de 4.000 a 6.000 caracteres no total');
      expect(prompt).toContain('16.000 caracteres é só o teto que o sistema aceita');
      expect(prompt.includes('ENXUGUE ao atualizar')).toBe(update);
      if (update) expect(prompt).toContain('Nunca enxugue restrições do dono ainda válidas, efeitos externos');
      expect(summaryPrompt({ update, reminder: 'format' })).toContain('não seguiu o formato');
      expect(summaryPrompt({ update, reminder: 'length' })).toContain('passou do limite');
      expect(summaryPrompt({ update, reminder: 'length' })).toContain('(o alvo é de 4.000 a 6.000)'); // o lembrete de tamanho cita o mesmo alvo do prompt
    }
  });

  it('o alvo é instrução: o teto de 16.000 não mudou, e um checkpoint acima do alvo e abaixo do teto ainda vale', () => {
    const aboveTarget = (chars: number): string => `${valid}\n${'x'.repeat(chars - valid.length - 1)}`;
    expect([...aboveTarget(7_000)].length).toBe(7_000);
    expect(judgeSummary({ ...base, text: aboveTarget(7_000) })).toMatchObject({ ok: true });
    expect(judgeSummary({ ...base, text: aboveTarget(16_000) })).toMatchObject({ ok: true });
    expect(judgeSummary({ ...base, text: aboveTarget(16_001) })).toEqual({ ok: false, failure: 'format', retry: 'length' });
  });
});

describe('rowTokens e os anexos (T10)', () => {
  const file = (extra: Partial<ContextAttachment>): ContextAttachment => ({ id: '1', message_id: '1', kind: 'document', name: 'a.txt', original_bytes: 10, total_chars: 0, removed: false, extracted_text: null, image_bytes: null, ...extra });
  const tokens = (attachments: ContextAttachment[], extra: { content?: string } = {}, scale = 1): number => rowTokens(fixture(1, { content: '', attachments, ...extra }), scale);
  const bare = tokens([]);

  it('conta a primeira página do documento (até 30.000 caracteres, em bytes) e a linha de metadados de cada arquivo', () => {
    expect(tokens([file({})])).toBe(bare + 300);
    expect(tokens([file({ extracted_text: 'a'.repeat(1_000) })])).toBe(bare + 300 + 1_000);
    // Acento conta em bytes UTF-8, como o resto da estimativa; o que passa de uma página não conta.
    expect(tokens([file({ extracted_text: 'á'.repeat(1_000) })])).toBe(bare + 300 + 2_000);
    expect(tokens([file({ extracted_text: 'a'.repeat(100_000) })])).toBe(bare + 300 + INLINE_FILE_CHARS);
    // O limite da mensagem (texto do dono incluído) reparte as páginas, como em `buildTurns`.
    expect(tokens([file({ extracted_text: 'a'.repeat(INLINE_FILE_CHARS) }), file({ id: '2', extracted_text: 'b'.repeat(INLINE_FILE_CHARS) }), file({ id: '3', extracted_text: 'c'.repeat(INLINE_FILE_CHARS) })], { content: 'x'.repeat(10_000) }) - tokens([], { content: 'x'.repeat(10_000) }))
      .toBe(3 * 300 + INLINE_MESSAGE_CHARS - 10_000);
    // A calibração escala os bytes (o texto do anexo incluído).
    expect(tokens([file({ extracted_text: 'a'.repeat(1_000) })], {}, 0.5)).toBe(Math.ceil((bare + 1_300) / 2));
  });

  it('conta cada imagem carregada em IMAGE_TOKENS e ignora o que não tem conteúdo: removido, planilha, arquivo gerado e imagem não carregada', () => {
    const image = file({ kind: 'image', image_bytes: Buffer.from('jpg') });
    expect(tokens([image])).toBe(bare + 300 + IMAGE_TOKENS);
    // A imagem é um teto fixo de tokens: a calibração escala os bytes e não a alcança.
    expect(tokens([image, file({ id: '2', kind: 'image', image_bytes: Buffer.from('jpg') })], {}, 0.5)).toBe(Math.ceil((bare + 600) / 2) + 2 * IMAGE_TOKENS);
    expect(tokens([file({ kind: 'image' })])).toBe(bare + 300);
    expect(tokens([file({ removed: true, extracted_text: 'a'.repeat(500) }), file({ id: '2', kind: 'spreadsheet' }), file({ id: '3', kind: 'generated' })])).toBe(bare + 3 * 300);
  });
});

describe('cutHistory', () => {
  const rows = (): ContextRow[] => [
    fixture(1), fixture(2, { tool: 'a', content: 'x'.repeat(100) }), fixture(3, { tool: 'b', step: 2, content: 'x'.repeat(100) }),
    fixture(4), fixture(5, { tool: 'c', step: 3, content: 'x'.repeat(100) }),
    fixture(6, { opens_round: false }), // complemento do dono dentro da rodada atual
    fixture(7, { tool: 'd', step: 4, content: 'x'.repeat(100) }),
  ];
  const cost = (row: ContextRow): number => row.content.length;
  const ids = (list: ContextRow[]): string[] => list.map((row) => row.id!);

  it('o trecho final fica com a etapa mais recente e as mensagens do dono da rodada atual, mesmo acima do teto; o resto é lote, em unidades inteiras', () => {
    const cut = cutHistory(rows(), { tailTokens: 0, costOf: cost });
    // Rodada atual: abre em 4; a mensagem 6 é complemento; a etapa 7 é a mais recente. As unidades antes da abertura viram lote.
    expect(ids(cut.tail)).toEqual(['4', '6', '7']);
    expect(ids(cut.batch)).toEqual(['1', '2', '3', '5']);
    // Com folga no teto, entram mais unidades do fim para o começo (a etapa 5 cabe; a 3 já não).
    const wider = cutHistory(rows(), { tailTokens: 220, costOf: cost });
    expect(ids(wider.tail)).toEqual(['4', '5', '6', '7']);
    expect(ids(wider.batch)).toEqual(['1', '2', '3']);
    // Tudo cabendo: lote vazio (nada a cobrir).
    expect(cutHistory(rows(), { tailTokens: 10_000, costOf: cost }).batch).toEqual([]);
  });

  it('atividade em andamento e cartão só do dono nunca entram no lote; a conversa ociosa não protege rodada atual', () => {
    const list = [fixture(1), fixture(2, { tool: 'a', status: 'running', content: '' }), fixture(3, { role: 'system', kind: 'card', status: 'done', opens_round: false, data: { type: 'approval' } }), fixture(4, { tool: 'b', step: 9 }), fixture(5)];
    expect(ids(cutHistory(list, { tailTokens: 0, costOf: cost }).batch)).toEqual(['1', '4']);
    expect(ids(cutHistory(list, { tailTokens: 0, costOf: cost, idle: true }).tail)).toEqual(['2', '3', '5']);
    expect(ids(cutHistory(list, { tailTokens: 0, costOf: cost, idle: true }).batch)).toEqual(['1', '4']);
  });

  it('phase-15:A9: a compactação fria (ociosa com keepLastRound) mantém a abertura e os complementos do dono da rodada mais recente acima do teto, mesmo atrás de uma etapa volumosa', () => {
    // Rodada antiga (1 a 3), rodada mais recente aberta em 4 com a regra do dono, um complemento (6) e a etapa volumosa 7 por último; o teto do trecho final é zero.
    const list = rows();
    const idleOnly = cutHistory(list, { tailTokens: 0, costOf: cost, idle: true });
    expect(ids(idleOnly.tail)).toEqual(['7']);
    expect(ids(idleOnly.batch)).toEqual(['1', '2', '3', '4', '5', '6']);
    const cold = cutHistory(list, { tailTokens: 0, costOf: cost, idle: true, keepLastRound: true });
    expect(ids(cold.tail)).toEqual(['4', '6', '7']);
    expect(ids(cold.batch)).toEqual(['1', '2', '3', '5']);
    // Só as mensagens do dono e a etapa mais recente passam do teto: o resto da rodada continua sujeito a ele.
    expect(ids(cutHistory(list, { tailTokens: 10_000, costOf: cost, idle: true, keepLastRound: true }).batch)).toEqual([]);
  });
});

describe('fitSummaryInput', () => {
  const units = (count: number): ContextRow[][] => Array.from({ length: count }, (_, index) => [fixture(index + 1, { content: `m${index + 1} ${'y'.repeat(900)}` })]);
  /** Tamanho = bytes da entrada serializada (a medição real usa o pedido inteiro; aqui só importa que cresça com o conteúdo). */
  const size = (input: SummaryInput): number => JSON.stringify(input).length;

  it('cabendo, não mexe; apertando, primeiro achata as unidades mais antigas, depois as descarta com a nota, e a unidade mais nova fica sempre', () => {
    const all = units(10);
    const full = size(fitSummaryInput({ units: all, previous: null, size, target: Number.MAX_SAFE_INTEGER }).input);
    const untouched = fitSummaryInput({ units: all, previous: 'CHECKPOINT ANTERIOR', size, target: Number.MAX_SAFE_INTEGER });
    expect(untouched).toMatchObject({ flattened: 0, omittedUnits: 0 });
    expect(untouched.input).toMatchObject({ previousCheckpoint: 'CHECKPOINT ANTERIOR', omitted: null });
    expect(untouched.input.rows).toHaveLength(10);

    const flattened = fitSummaryInput({ units: all, previous: null, size, target: Math.floor(full * 0.6) });
    expect(flattened.omittedUnits).toBe(0);
    expect(flattened.flattened).toBeGreaterThan(0);
    expect(flattened.tokens).toBeLessThanOrEqual(Math.floor(full * 0.6));
    expect(flattened.input.rows[0]!.text.length).toBeLessThan(400); // o mais antigo foi achatado
    expect(flattened.input.rows.at(-1)!.text.length).toBeGreaterThan(900); // o mais novo não

    const dropped = fitSummaryInput({ units: all, previous: null, size, target: Math.floor(full * 0.15) });
    expect(dropped.omittedUnits).toBeGreaterThan(0);
    expect(dropped.input.omitted).toBe(omittedNote(dropped.omittedUnits));
    expect(dropped.input.rows.at(-1)!.id).toBe('10');
    expect(dropped.input.rows.length).toBe(10 - dropped.omittedUnits);
    expect(dropped.tokens).toBeLessThanOrEqual(Math.floor(full * 0.15));

    // Alvo impossível: só a unidade mais nova (achatada) sobra, e a entrada sai assim mesmo.
    const impossible = fitSummaryInput({ units: all, previous: null, size, target: 10 });
    expect(impossible.omittedUnits).toBe(9);
    expect(impossible.input.rows.map((row) => row.id)).toEqual(['10']);
    expect(fitSummaryInput({ units: units(1), previous: null, size, target: 10 }).input.rows).toHaveLength(1);
  });

  it('a nota diz "N trocas anteriores omitidas; recuperáveis por search_history"', () => {
    expect(omittedNote(3)).toBe('[3 trocas anteriores omitidas; recuperáveis por search_history]');
  });
});

describe('coveredImpression', () => {
  it('muda com o conteúdo coberto, com o conjunto e com o modelo do resumo, e só com isso', () => {
    const rows = [fixture(1), fixture(2)];
    const base = coveredImpression('opencode/glm-5.1', rows);
    expect(coveredImpression('opencode/glm-5.1', [fixture(1), fixture(2)])).toBe(base);
    expect(coveredImpression('opencode/grok-4.7', rows)).not.toBe(base);
    expect(coveredImpression('opencode/glm-5.1', [fixture(1), fixture(2, { content: 'outro' })])).not.toBe(base);
    expect(coveredImpression('opencode/glm-5.1', [fixture(1), fixture(2), fixture(3)])).not.toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('A30: a impressão de um id opencode/ é a mesma de antes da migration 0055 (o id local), então a recusa gravada continua valendo; o id de outro provedor entra inteiro', () => {
    const rows = [fixture(1), fixture(2)];
    expect(coveredImpression('opencode/glm-5.1', rows)).toBe(coveredImpression('glm-5.1', rows));
    expect(coveredImpression('anthropic/glm-5.1', rows)).not.toBe(coveredImpression('glm-5.1', rows));
    expect(coveredImpression('anthropic/glm-5.1', rows)).not.toBe(coveredImpression('opencode/glm-5.1', rows));
  });
});

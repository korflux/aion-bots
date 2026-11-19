// Banco de testes do Aion com o modelo real (phase 15, passo 3; spec decisões 4, 5, 9, 11, 12, 15 e 24; critérios A1, A2, A3, A4 e A38).
//
// O que é: roda o MOTOR REAL do Aion (`RunEngine`, bots, tabelas, docs, rotinas, memória, aprovações) sobre PostgreSQL embutido, com o `deepseek-v4.1-flash` de verdade e o
// Composio, a Parallel (web) e o sandbox do Python FALSOS (`@aion/core/testing`), em casos escritos em linguagem natural, com várias rodadas. É a régua única da phase: a linha de
// base do código atual, a correção das ferramentas, as rotinas, os grupos, o A/B, o laço do prompt e o gate final medem aqui.
//
// Regras do banco (spec):
//   - ACERTO é o EFEITO consultado no banco (memória gravada, rotina criada, linha de tabela, doc, ação do conector executada ou não), NUNCA a presença de texto na resposta (A2): um
//     caso cujo efeito não ocorreu é erro mesmo que o modelo afirme que fez. Cada caso lista as suas verificações (`BenchCase.verify`).
//   - CUSTO por caso é lido de `model_call_usage` (entrada, cache, saída e raciocínio) com os preços de `packages/core/src/usage/cost-report.ts`; o histórico semeado por modelo
//     roteirizado (gratuito) é excluído das contas.
//   - CERCA DE 30% DOS CASOS ficam SEPARADOS (`set: 'held-out'`): o laço nunca os vê. O modo real recusa rodá-los sem `finalGate` (A3), então linha de base, correções, A/B e laço só
//     enxergam os casos de otimização.
//   - LIVRO DE GASTO (`SpendLedger`, fora do Git em `.aion-bench/ledger.jsonl`): soma toda chamada real da phase, abre com a sonda do passo 1 e PARA ANTES de passar de US$ 17 (A4; era US$ 15 até o dono ampliar o teto em 2026-11-08, decisão 5 da spec):
//     cada chamada reserva o pior caso (entrada estimada sem cache mais a saída máxima) ANTES de sair, e a que passaria do teto não é enviada.
//   - CASO CORTADO (`CaseResult.cut`): o caso em que o livro recusou uma chamada foi interrompido pelo teto, não errou. Ele fica FORA do acerto e da média de custo e o relatório o lista à
//     parte (um corte contado como erro derrubaria o acerto por causa do dinheiro, não do modelo).
//   - Dois modos com a mesma montagem: `real` (provedor OpenCode Go, só pelo script explícito, chave do ambiente) e `offline` (modelo roteirizado e determinístico, o que `pnpm test`
//     roda, sem ler `.env.provider`; o gasto é SIMULADO a partir do usage roteirizado, o que prova a parada do teto sem pagar nada).
//
// Privacidade: a saída (stdout e relatório) só tem identificadores de caso, rótulos de verificação, códigos e números. Texto de conversa, de resposta e de resultado nunca é impresso
// e a chave do provedor nunca é impressa nem gravada fora do banco efêmero (cifrada com a chave mestra do mundo de teste).
//
// Uso (a partir da raiz): `pnpm bench:baseline` (linha de base real da versão atual; ver `package.json`) ou, direto,
//   node --env-file-if-exists=.env.provider --import tsx tests/support/aion-bench.ts --mode real --set optimization --repeats 3 --run-cap 2 --report <caminho.md>
// Laço do prompt (passo 15): `--transcripts <pasta>` grava a conversa de cada execução REPROVADA (ferramentas, argumentos e o começo dos textos) em arquivos locais, fora do Git, para classificar a falha;
// o conteúdo nunca vai ao stdout nem ao relatório. No CLI real o sandbox falso calcula aritmética pura (`calcSandboxHandler`), para o caso de cálculo não depender de um sandbox que não executa.
// Mapa do arquivo: tipos e constantes; preço e livro de gasto; guarda do provedor; modelo roteirizado; contexto e execução de um caso; execução do conjunto; medição do catálogo;
// relatório; borda da CLI.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { localModelId, qualifyModelId, type Bot } from '@aion/shared';
import {
  buildCostReport, ChatRejected, ChatStreamError, createOpenCodeGoClient, MODEL_PRICES, readUsageCalls,
  type ChatEvent, type ChatRequest, type ChatTurn, type ChatUsage, type CostTotals, type ProviderClient, type UsageCall,
} from '@aion/core';
import { startFakeSandbox, startTestPostgres, type FakeSandbox, type FakeSandboxRequest, type FakeSandboxResponse } from '@aion/core/testing';
import { AttachmentService } from '../../packages/core/src/attachments/service';
import { GeneralChatService } from '../../packages/core/src/general-chat/service';
import { DocService } from '../../packages/core/src/docs/service';
import { ColdMaintenance } from '../../packages/core/src/runs/cold-maintenance';
import { ABRIR_GRUPO, CONNECTOR_PORTS, READ_ACTIVITY, TOOL_TREE, USE_TOOL } from '../../packages/core/src/runs/tool-discovery';
import { ORIGIN, REAL_MODEL_ENGINE, createRunsWorld, waitFor, type RunsWorld } from '../../packages/core/src/runs/test-support';
import { TableService } from '../../packages/core/src/tables/service';
import { BENCH_CASES } from './aion-bench-cases';

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Tipos do banco de casos
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Único modelo do banco (decisão 7 da spec): trocá-lo muda o que a régua mede e exige novo pedido ao dono. */
export const BENCH_MODEL = qualifyModelId('opencode', 'deepseek-v4.1-flash');

/** Conjunto do caso: `optimization` alimenta linha de base, correções, A/B e laço; `held-out` é o gate final e nunca roda antes dele (A3, decisão 12). */
export type CaseSet = 'optimization' | 'held-out';

/** Resultado de uma execução (ou de um item de fila) que o caso provocou. */
export interface RunOutcome { runId: string; status: string; failureCode: string | null }

/** Uma verificação do efeito: o rótulo vai ao relatório (descritor curto, nunca texto da conversa) e `ok` é o resultado consultado no banco. */
export interface Check { name: string; ok: boolean }

/**
 * Um passo do MODELO PERFEITO do modo offline: chama a ferramenta com os argumentos (fixos ou calculados a partir do estado do caso e do último resultado de ferramenta) ou
 * responde texto. É a contraprova de que as verificações do caso enxergam o efeito que as ferramentas realmente produzem; no modo real o modelo decide sozinho.
 */
type MoveArgs = Record<string, unknown>;
export type Move = { tool: string; args: MoveArgs | ((ctx: CaseContext, lastResult: string | null) => MoveArgs | Promise<MoveArgs>) } | { text: string };

/** O caso: estado inicial, jornada, plano do modelo perfeito (offline) e verificações do efeito. */
export interface BenchCase {
  id: string;
  /** Uma linha: o que o caso exige do Aion (vai ao relatório). */
  title: string;
  set: CaseSet;
  /** Caso de segurança (decisão 15): no gate passa 100%. */
  security: boolean;
  /**
   * `general`: o caso é uma sessão do Chat geral (sem memória, conector, tabelas nem docs; as 7 ferramentas dele), não um bot. A jornada só usa `ctx.ownerSays` e `ctx.sessionId`; o bot que o mundo cria
   * existe só para o tipo do contexto e nunca recebe mensagem. Ausente = bot.
   */
  chat?: 'general';
  /** Janela de contexto do bot do caso; ausente = o padrão do produto (256k). */
  contextWindowTokens?: 65536 | 131072 | 262144 | 524288;
  /** `none`: o bot não recebe nenhuma conta do conector (CONN-02). Padrão `released`: Gmail `ca_1` e GitHub `ca_3`, como o dono as libera. */
  connector?: 'released' | 'none';
  /** Estados de execução aceitos nas execuções do caso (padrão: só `completed`). `waiting_approval` é o desfecho certo de uma ação externa sem regra. */
  acceptStatuses?: readonly string[];
  /** Monta o estado inicial pelos serviços (tabelas, docs, rotinas), sem modelo. */
  setup?: (ctx: CaseContext) => Promise<void>;
  /** As mensagens do dono, em ordem, uma rodada cada; ignorada quando o caso define `run`. */
  rounds?: readonly string[];
  /** Jornada própria (histórico semeado, rotina, espera fria); usa `ctx.ownerSays`, `ctx.runRoutine`, `ctx.scripted` e `ctx.coldSweep`. */
  run?: (ctx: CaseContext) => Promise<void>;
  /** Modelo perfeito do modo offline: `plan[i]` responde à i-ésima chamada de `ownerSays` ou `runRoutine`. */
  plan: readonly (readonly Move[])[];
  /** Os efeitos esperados, consultados no banco depois da jornada. */
  verify: (ctx: CaseContext) => Promise<Check[]>;
}

/** Arquivo de texto (`.txt`, `.md`, `.csv` ou `.json`) que o dono anexa à mensagem. */
export interface OwnerFile { name: string; text: string }

/** Tudo o que um caso usa: o mundo de teste real do core, o bot, as ações da jornada e os serviços de semeadura. */
export interface CaseContext {
  world: RunsWorld;
  bot: Bot;
  /** Id da sessão (e da conversa) do Chat geral, só nos casos `chat: 'general'`; nulo nos casos de bot. */
  sessionId: string | null;
  offline: boolean;
  /** Variáveis do caso (ids semeados): o que `setup` grava, `plan` e `verify` leem. */
  vars: Record<string, unknown>;
  /** Observações numéricas ou booleanas do caso que vão ao relatório sem decidir o acerto (por exemplo, se a compactação fria aconteceu). */
  notes: Record<string, number | boolean>;
  /** Execuções provocadas na jornada (sem as semeadas por modelo roteirizado). */
  outcomes: RunOutcome[];
  tables: TableService;
  docs: DocService;
  /**
   * Mensagem do dono ao bot (ou à sessão do Chat geral); espera a execução terminar (ou parar em aprovação). Na jornada offline responde pelo plano. `files` anexa arquivos de texto à mensagem
   * (conteúdo de fora que o bot ou o Chat geral lê: os casos de injeção por anexo), pelo mesmo `AttachmentService` do produto.
   */
  ownerSays(text: string, files?: readonly OwnerFile[]): Promise<RunOutcome>;
  /** "Executar agora" da rotina (a mesma entrada do dono); a execução abre com a instrução da rotina. */
  runRoutine(routineId: string): Promise<RunOutcome>;
  /** Semeia histórico com um modelo ROTEIRIZADO e gratuito, nos dois modos: a execução não entra nas contas de custo nem no livro de gasto. */
  scripted(text: string, moves: readonly Move[]): Promise<RunOutcome>;
  /** Envelhece a conversa do bot em `hours` horas (mensagens, ledger de uso e execuções) para ela esfriar sem esperar o relógio. */
  ageConversation(hours: number): Promise<void>;
  /** Passa o laço de manutenção fria do worker uma vez (mascara e enfileira a compactação fria) e espera a fila esvaziar. */
  coldSweep(): Promise<void>;
}

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Preço e livro de gasto
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Teto de gasto real da phase com o provedor (decisão 5 da spec): testes, A/B, laço e gate. US$ 17 desde 2026-11-08 (o dono ampliou os US$ 15 originais em US$ 2). */
export const PHASE_CAP_USD = 17;
/** Teto desta rodada da linha de base (pedido do líder). */
export const BASELINE_RUN_CAP_USD = 2;

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** Livro de gasto: JSON por linha, fora do Git (`.aion-bench/` está no `.gitignore`). */
export const DEFAULT_LEDGER_FILE = resolve(ROOT, '.aion-bench', 'ledger.jsonl');

/** Gasto da sonda do passo 1 (chamada pelo nome), anterior ao livro: 1.735 tokens de entrada, 0 de cache, 445 de saída. O livro abre com ele. */
export const OPENING_ENTRY = { label: 'passo-1-sonda-chamada-pelo-nome', inputTokens: 1_735, cachedTokens: 0, outputTokens: 445, costUsd: 0.001054 } as const;

/** Gasto em US$ de um usage, pelos preços do modelo: entrada sem cache, leitura de cache e saída (raciocínio já dentro da saída). Mesma conta de `addCall` em `cost-report.ts`. */
export function usageCostUsd(usage: ChatUsage, model: string = BENCH_MODEL): number {
  const price = MODEL_PRICES[model];
  if (!price) throw new Error('BENCH_MODEL_WITHOUT_PRICE');
  const input = usage.inputTokens ?? 0;
  const cached = Math.min(usage.cachedTokens ?? 0, input);
  const written = Math.min(usage.cacheWriteTokens ?? 0, input - cached);
  const uncached = input - cached - written;
  return (uncached * price.input + cached * price.cached + written * (price.cacheWrite ?? price.input) + (usage.outputTokens ?? 0) * price.output) / 1e6;
}

/**
 * Pior caso de uma chamada, em US$: entrada estimada SEM cache (0,5 token por byte do pedido, folga sobre os ~0,3 medidos) mais a saída máxima pedida. Sempre pelos preços do `BENCH_MODEL`: no modo real o
 * banco só fala com ele (`runCase` recusa outro modelo), e no offline do A39, em que o provedor roteirizado responde por outro modelo, o gasto é simulado e não tem preço próprio.
 */
export function worstCaseUsd(request: ChatRequest): number {
  const bytes = Buffer.byteLength(JSON.stringify({ turns: request.turns, tools: request.tools }), 'utf8');
  return usageCostUsd({ inputTokens: Math.ceil(bytes * 0.5), outputTokens: request.maxTokens });
}

/** O teto foi alcançado: a próxima chamada não é enviada e o banco para relatando o gasto (A4). */
export class BudgetExceeded extends Error {
  readonly code = 'BENCH_BUDGET_EXCEEDED';
  constructor(readonly spentUsd: number, readonly capUsd: number, readonly scope: 'phase' | 'run') { super('BENCH_BUDGET_EXCEEDED'); this.name = 'BudgetExceeded'; }
}

/** Uma linha do livro. `estimated`: a chamada falhou sem informar uso, e o pior caso foi cobrado (o lado seguro). */
export interface LedgerEntry {
  at: string;
  kind: 'opening' | 'call' | 'estimated';
  label: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
}

/** Reserva de uma chamada em voo: o pior caso fica separado do gasto até a chamada fechar. */
interface Reservation { estimateUsd: number }

/**
 * Livro de gasto da phase. Soma o que já foi gasto (lido do arquivo, que sobrevive entre rodadas e scripts), reserva o pior caso de cada chamada antes de enviá-la e recusa a que
 * levaria o total acima do teto da phase ou do teto desta rodada (`BudgetExceeded`); a primeira recusa trava o livro (`refused`) e nada mais sai. Sem arquivo (modo offline) vive em
 * memória, com um gasto inicial simulado opcional.
 * Concorrência: vários casos rodam juntos no mesmo processo, então as reservas em voo contam contra o teto; a gravação é síncrona (uma linha por chamada fechada).
 */
export class SpendLedger {
  private spent = 0;
  private runSpent = 0;
  private reserved = 0;
  private refusedFlag = false;
  private callCount = 0;

  private constructor(private readonly file: string | null, readonly capUsd: number, readonly runCapUsd: number | null, initialSpentUsd: number) {
    this.spent = initialSpentUsd;
  }

  /**
   * Abre o livro. Com `file`: cria o arquivo com a abertura (a sonda do passo 1) se não existir, ou soma as linhas existentes; uma linha ilegível PARA tudo (`BENCH_LEDGER_CORRUPT`),
   * porque zerar o livro em silêncio deixaria gastar acima do teto. Sem `file`: memória, começando em `initialSpentUsd`.
   */
  static open({ file, capUsd = PHASE_CAP_USD, runCapUsd = null, initialSpentUsd = 0 }: { file: string | null; capUsd?: number; runCapUsd?: number | null; initialSpentUsd?: number }): SpendLedger {
    if (file === null) return new SpendLedger(null, capUsd, runCapUsd, initialSpentUsd);
    let spent = 0;
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      const opening: LedgerEntry = { at: new Date().toISOString(), kind: 'opening', reasoningTokens: 0, ...OPENING_ENTRY };
      writeFileSync(file, `${JSON.stringify(opening)}\n`);
      spent = opening.costUsd;
    } else {
      for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
        let entry: LedgerEntry;
        try { entry = JSON.parse(line) as LedgerEntry; } catch { throw new Error('BENCH_LEDGER_CORRUPT'); }
        if (typeof entry.costUsd !== 'number' || !Number.isFinite(entry.costUsd) || entry.costUsd < 0) throw new Error('BENCH_LEDGER_CORRUPT');
        spent += entry.costUsd;
      }
    }
    return new SpendLedger(file, capUsd, runCapUsd, spent);
  }

  /** Gasto acumulado da phase (inclui a abertura e todas as rodadas). */
  get spentUsd(): number { return this.spent; }
  /** Gasto só desta rodada (processo). */
  get runSpentUsd(): number { return this.runSpent; }
  get remainingUsd(): number { return Math.max(0, this.capUsd - this.spent); }
  get calls(): number { return this.callCount; }
  /** A parada foi acionada (alguma chamada foi recusada pelo teto). */
  get refused(): boolean { return this.refusedFlag; }

  /** Reserva o pior caso de uma chamada; lança `BudgetExceeded` (e trava o livro) se ela passaria do teto da phase ou da rodada. */
  reserve(estimateUsd: number): Reservation {
    if (this.refusedFlag) throw new BudgetExceeded(this.spent, this.capUsd, 'phase');
    if (this.spent + this.reserved + estimateUsd > this.capUsd) { this.refusedFlag = true; throw new BudgetExceeded(this.spent, this.capUsd, 'phase'); }
    if (this.runCapUsd !== null && this.runSpent + this.reserved + estimateUsd > this.runCapUsd) { this.refusedFlag = true; throw new BudgetExceeded(this.runSpent, this.runCapUsd, 'run'); }
    this.reserved += estimateUsd;
    return { estimateUsd };
  }

  /** Fecha a chamada: grava o gasto real do usage informado, ou o pior caso reservado quando a chamada acabou sem usage. */
  settle(reservation: Reservation, usage: ChatUsage | null, label: string): void {
    this.reserved = Math.max(0, this.reserved - reservation.estimateUsd);
    const costUsd = Number((usage ? usageCostUsd(usage) : reservation.estimateUsd).toFixed(9));
    const entry: LedgerEntry = {
      at: new Date().toISOString(), kind: usage ? 'call' : 'estimated', label, inputTokens: usage?.inputTokens ?? 0, cachedTokens: usage?.cachedTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0, reasoningTokens: usage?.reasoningTokens ?? 0, costUsd,
    };
    this.spent += costUsd;
    this.runSpent += costUsd;
    this.callCount += 1;
    if (this.file) appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
  }
}

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Guarda do provedor
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Envolve um provedor com o livro: toda chamada de chat reserva o pior caso ANTES de sair (`BudgetExceeded` impede o envio) e fecha com o usage informado. A listagem de modelos
 * passa direto (GET gratuito). `label` identifica o caso no livro. Parar o consumo cedo também fecha a reserva (o `finally` do gerador).
 */
export function guardProvider(inner: ProviderClient, ledger: SpendLedger, label: () => string): ProviderClient {
  return {
    listModels: (apiKey) => inner.listModels(apiKey),
    async *streamChat(apiKey, protocol, request, signal): AsyncGenerator<ChatEvent> {
      const reservation = ledger.reserve(worstCaseUsd(request));
      let usage: ChatUsage | null = null;
      try {
        for await (const event of inner.streamChat(apiKey, protocol, request, signal)) {
          if (event.type === 'usage') usage = event.usage;
          yield event;
        }
      } finally {
        ledger.settle(reservation, usage, label());
      }
    },
  };
}

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Modelo roteirizado (offline e semeadura)
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Estado que o modelo roteirizado lê a cada chamada: o plano da rodada em curso e o contexto do caso (para os argumentos calculados). */
interface ScriptState { moves: readonly Move[]; ctx: CaseContext | null; requests: ChatRequest[] }

/** Passo da rodada: quantas respostas do assistente vieram depois do último turno do dono (cada passo do modelo é uma resposta com uma chamada de ferramenta). */
function stepOf(turns: readonly ChatTurn[]): number {
  let step = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    if (turn.role === 'user') break;
    if (turn.role === 'assistant') step += 1;
  }
  return step;
}

/** Texto do último resultado de ferramenta do pedido (o que o passo anterior devolveu), ou nulo no primeiro passo. */
function lastToolText(turns: readonly ChatTurn[]): string | null {
  const last = turns[turns.length - 1];
  return last?.role === 'tool' ? last.text : null;
}

/**
 * Modelo roteirizado: segue `state.moves` passo a passo, uma chamada de ferramenta por resposta, e fecha com texto. A chamada sem ferramentas (o pedido de resumo da compactação)
 * recebe um checkpoint válido, com as seções que o próprio prompt lista. O usage é proporcional ao pedido (0,3 token por byte, como o provedor real) e o cache é o pedido anterior da
 * mesma sessão arredondado a múltiplos de 128, como o do provedor; `usageMultiplier` infla tudo para a prova do teto gastar rápido.
 */
function createScriptedModel(state: ScriptState, usageMultiplier = 1, model: string = BENCH_MODEL): ProviderClient {
  const lastInput = new Map<string, number>();
  return {
    // O provedor lista ids locais (o catálogo do produto os prefixa); o motor chama com `provedor/modelo`.
    listModels: () => Promise.resolve([{ id: localModelId(model) }]),
    async *streamChat(_apiKey, _protocol, request): AsyncGenerator<ChatEvent> {
      state.requests.push(request);
      let outputChars = 0;
      const isSummary = !request.tools?.length;
      const move = isSummary ? undefined : state.moves[stepOf(request.turns)];
      if (isSummary) {
        const headings = [...(request.turns[0]?.role === 'system' ? request.turns[0].text : '').matchAll(/^## .+$/gm)].map((match) => match[0]);
        const text = (headings.length ? headings : ['## Estado']).map((heading, index) => `${heading}\n${index === 0 ? 'Checkpoint sintético do histórico antigo.' : 'Nada.'}`).join('\n\n');
        outputChars = text.length;
        yield { type: 'text', text };
      } else if (move && 'tool' in move) {
        const args = typeof move.args === 'function' ? await move.args(state.ctx!, lastToolText(request.turns)) : move.args;
        const json = JSON.stringify(args ?? {});
        outputChars = json.length;
        yield { type: 'tool_call', id: `call_${randomUUID().slice(0, 8)}`, name: move.tool, arguments: json };
      } else {
        const text = move && 'text' in move ? move.text : 'Pronto, feito.';
        outputChars = text.length;
        yield { type: 'text', text };
      }
      const bytes = Buffer.byteLength(JSON.stringify({ tools: request.tools, turns: request.turns }), 'utf8');
      const inputTokens = Math.ceil(bytes * 0.3 * usageMultiplier);
      const previous = lastInput.get(request.sessionId) ?? 0;
      lastInput.set(request.sessionId, inputTokens);
      const cachedTokens = Math.floor((Math.min(previous, inputTokens) * 0.9) / 128) * 128;
      yield { type: 'usage', usage: { inputTokens, cachedTokens, outputTokens: Math.ceil((outputChars / 3.5 + 8) * usageMultiplier) } };
      yield { type: 'done', reason: 'stop' };
    },
  };
}

/**
 * O provedor do mundo do caso. Na semeadura (`seeding`) responde SEMPRE o modelo roteirizado, direto e fora do livro (é gratuito); fora dela, passa pelo livro e responde o modelo real
 * (modo real) ou o roteirizado (offline, com o gasto simulado contado no livro).
 */
class ModelHost implements ProviderClient {
  seeding = false;
  /** O livro recusou uma chamada deste caso (`BudgetExceeded`): a jornada foi cortada pelo teto de gasto. */
  cut = false;
  /** Modelos a que as chamadas do caso foram dirigidas (semeadura incluída), para o A39 provar que um bot em outro modelo só fala com o dele. */
  readonly models = new Set<string>();
  readonly state: ScriptState = { moves: [], ctx: null, requests: [] };
  private readonly scripted: ProviderClient;
  private readonly guarded: ProviderClient;

  constructor(private readonly real: ProviderClient | null, ledger: SpendLedger, label: () => string, usageMultiplier: number, model: string = BENCH_MODEL) {
    this.scripted = createScriptedModel(this.state, usageMultiplier, model);
    this.guarded = guardProvider(real ?? this.scripted, ledger, label);
  }

  listModels(apiKey: string): Promise<{ id: string }[]> { return (this.real ?? this.scripted).listModels(apiKey); }

  async *streamChat(apiKey: string, protocol: Parameters<ProviderClient['streamChat']>[1], request: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
    this.models.add(request.model);
    try {
      yield* (this.seeding ? this.scripted : this.guarded).streamChat(apiKey, protocol, request, signal);
    } catch (error) {
      if (error instanceof BudgetExceeded) this.cut = true;
      throw error;
    }
  }
}

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Ambiente e execução de um caso
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/** O que o conjunto compartilha: o PostgreSQL de teste, o sandbox falso, o livro e o modo. */
export interface BenchEnv {
  mode: 'real' | 'offline';
  adminUrl: string;
  /** Cliente do provedor real (modo real); nulo no offline. */
  provider: ProviderClient | null;
  apiKey: string;
  ledger: SpendLedger;
  sandbox: FakeSandbox;
  /** Prazo de uma execução do caso, em ms. */
  runTimeoutMs: number;
  /** Pasta onde a conversa de cada execução REPROVADA é gravada, para o diagnóstico do laço do prompt (passo 15): fora do Git e nunca impressa. Nula ou ausente: nada é gravado. */
  transcriptsDir?: string | null;
  /** Multiplicador do usage roteirizado (offline): a prova do teto o infla para gastar rápido. */
  usageMultiplier: number;
}

const END_STATES = ['completed', 'failed', 'interrupted', 'limit_reached', 'expired', 'cancelled', 'waiting_approval'];

/** Contas de uma execução do caso, lidas de `model_call_usage`. */
export interface CaseCost {
  calls: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  uncachedUsd: number;
  cachedUsd: number;
  outputUsd: number;
  usd: number;
}

/** Entrada sem cache (tokens) da primeira chamada de cada execução do caso, na ordem: a "abertura" que a rotina fria quer reduzir (A8). */
export interface OpeningCost { runId: string; category: string; inputTokens: number; uncachedTokens: number }

/**
 * As chamadas da categoria `apos_abrir_grupo` do relatório de custo (A23): a etapa que vem logo depois de o bot abrir um galho ou uma folha por `abrir_grupo`. O campo `tools` não muda nessa
 * etapa, então a fração de cache dela (`cachedTokens` sobre `inputTokens`) mostra se a abertura preservou o prefixo.
 */
export interface AfterOpenCost { calls: number; inputTokens: number; cachedTokens: number }

/** Categoria do relatório de custo da etapa seguinte a `abrir_grupo` (A23). */
export const AFTER_OPEN_CATEGORY = 'apos_abrir_grupo';

/** Chamadas de uma ferramenta num caso: concluídas, falhas e as falhas por código do envelope. */
export interface ToolStat {
  ok: number;
  failed: number;
  /** Chamadas que pararam esperando o dono (aprovação pendente): nem concluídas nem falhas, e o desfecho certo de uma ação externa ou da exclusão de um doc sem regra. */
  waiting: number;
  codes: Record<string, number>;
}

/** O resultado de uma execução de um caso. */
export interface CaseResult {
  caseId: string;
  repeat: number;
  set: CaseSet;
  security: boolean;
  pass: boolean;
  /** O livro de gasto cortou o caso no meio: ele não errou, foi interrompido. Fica fora do acerto e da média de custo (`aggregate`) e o relatório o lista à parte. */
  cut: boolean;
  checks: Check[];
  /** Código estável do erro do banco (prazo, teto, falha do mundo), ou nulo. */
  error: string | null;
  outcomes: { status: string; failureCode: string | null }[];
  /**
   * Por ferramenta: concluídas e falhas, das execuções do caso (A12 mede a fração de falha). `codes` conta as falhas por código estável do envelope `{ code, message }` (A21), lido do resultado gravado
   * da atividade (`SEM_CODIGO` quando o resultado não é um envelope): é o que atribui uma falha de `abrir_grupo` ou `run_python` a uma causa, e o relatório e o log a quebram por caso.
   */
  toolStats: Record<string, ToolStat>;
  cost: CaseCost;
  openings: OpeningCost[];
  afterOpen: AfterOpenCost;
  notes: Record<string, number | boolean>;
  /** Modelos a que o provedor do caso foi chamado, sem repetição (A39 confere que um bot em outro modelo só fala com o dele). */
  models: string[];
  wallMs: number;
}

const zeroCost = (): CaseCost => ({ calls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, uncachedUsd: 0, cachedUsd: 0, outputUsd: 0, usd: 0 });
const zeroAfterOpen = (): AfterOpenCost => ({ calls: 0, inputTokens: 0, cachedTokens: 0 });

/** Converte os totais do relatório de custo do core nas contas do caso. */
function costOf(totals: CostTotals): CaseCost {
  return {
    calls: totals.calls, inputTokens: totals.inputTokens, cachedTokens: totals.cachedTokens, outputTokens: totals.outputTokens, reasoningTokens: totals.reasoningTokens,
    uncachedUsd: totals.uncachedUsd ?? 0, cachedUsd: totals.cachedUsd ?? 0, outputUsd: totals.outputUsd ?? 0, usd: totals.totalUsd ?? 0,
  };
}

/** Código estável de um erro qualquer do banco: nunca a mensagem (que poderia carregar texto externo). */
function errorCodeOf(error: unknown): string {
  if (error instanceof BudgetExceeded) return error.code;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.message)) return error.message;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(code)) return code;
  if (error instanceof Error && /^prazo estourado/.test(error.message)) return 'BENCH_CASE_TIMEOUT';
  return 'BENCH_CASE_FAILED';
}

/**
 * Monta o mundo do caso (banco efêmero, motor real, Composio, web e sandbox falsos, bot do modelo do banco com as contas liberadas ou, nos casos `chat: 'general'`, uma sessão do Chat geral), roda a
 * jornada e consulta os efeitos. `options.model` só existe para o A39 (um bot em OUTRO modelo, provado offline com o provedor roteirizado respondendo por ele): no modo real o banco fala sempre com o
 * `BENCH_MODEL` (decisão 7 da spec) e recusa qualquer outro.
 */
export async function runCase(def: BenchCase, repeat: number, env: BenchEnv, options: { planOverride?: readonly (readonly Move[])[]; model?: string } = {}): Promise<CaseResult> {
  if (def.set === 'held-out' && env.mode === 'real' && !finalGateEnabled) throw new Error('BENCH_HELD_OUT_BEFORE_GATE');
  const model = options.model ?? BENCH_MODEL;
  if (model !== BENCH_MODEL && env.mode === 'real') throw new Error('BENCH_MODEL_NOT_ALLOWED');
  const started = performance.now();
  const label = `${def.id}#${repeat}`;
  const offline = env.mode === 'offline';
  const plan = options.planOverride ?? def.plan;
  const host = new ModelHost(env.provider, env.ledger, () => label, env.usageMultiplier, model);
  const world = await createRunsWorld({
    adminDatabaseUrl: env.adminUrl,
    realModel: { provider: host, apiKey: env.apiKey, model },
    coreCatalog: true,
    webSearch: true,
    python: { url: env.sandbox.url, token: env.sandbox.token },
    contextWindow: def.contextWindowTokens ?? 'product',
    ...(offline ? {} : { engine: REAL_MODEL_ENGINE }),
  });
  const seedRunIds = new Set<string>();
  const outcomes: RunOutcome[] = [];
  const notes: Record<string, number | boolean> = {};
  let checks: Check[] = [];
  let error: string | null = null;
  let cost = zeroCost();
  let openings: OpeningCost[] = [];
  let afterOpen = zeroAfterOpen();
  let toolStats: CaseResult['toolStats'] = {};
  let botId: string | null = null;
  let sessionId: string | null = null;
  try {
    await world.connectComposio();
    await world.credentials.save('web_search', `valid-web-bench-${randomUUID().slice(0, 8)}`, ORIGIN);
    // Nome único por execução: o nome abre o turno de sistema, então cada caso começa com o prefixo do pedido inédito e a primeira chamada nunca herda o cache de outro caso (a medição da
    // abertura não depende da ordem nem da concorrência); dentro da conversa o cache funciona como em produção.
    const bot = await world.createBot({ name: `Bench ${randomUUID().slice(0, 8)}`, model, instructions: '', ...(def.contextWindowTokens ? { contextWindowTokens: def.contextWindowTokens } : {}) });
    botId = bot.id;
    if ((def.connector ?? 'released') === 'released' && def.chat !== 'general') await world.releaseConnectorAccounts(bot);
    // Chat geral: uma sessão nova com o modelo do banco fixado (a troca de modelo dentro do chat vale só para ele); a conversa da sessão tem o mesmo id da sessão.
    if (def.chat === 'general') {
      sessionId = (await new GeneralChatService({ pool: world.pool }).create()).id;
      await world.conversations.setPreference({ sessionId }, model, null);
    }
    let phaseIndex = 0;
    const attachments = new AttachmentService({ pool: world.pool, conversations: world.conversations });
    const awaitRun = async (runId: string): Promise<RunOutcome> => {
      const row = await waitFor(`execução ${runId} terminar`, async () => { const current = await world.runRow(runId); return END_STATES.includes(current.status) ? current : null; }, env.runTimeoutMs);
      return { runId, status: row.status, failureCode: row.failure_code };
    };
    const ctx: CaseContext = {
      world, bot, sessionId, offline, vars: {}, notes, outcomes,
      tables: new TableService({ pool: world.pool }),
      docs: new DocService({ pool: world.pool }),
      async ownerSays(text, files) {
        host.state.moves = offline ? plan[phaseIndex] ?? [] : [];
        phaseIndex += 1;
        // Com arquivos: sobem pelo serviço de anexos do produto (limites, extração e quota de verdade) e seguem com a mensagem; sem arquivos, o caminho de sempre.
        const ref = sessionId ? { sessionId } : bot.id;
        const attachmentIds: string[] = [];
        for (const file of files ?? []) attachmentIds.push((await attachments.upload(ref, file.name, Buffer.from(file.text, 'utf8'))).id);
        const outcome = await awaitRun(attachmentIds.length > 0 ? (await world.conversations.send(ref, text, attachmentIds)).id : sessionId ? (await world.conversations.send({ sessionId }, text)).id : await world.send(bot, text));
        outcomes.push(outcome);
        return outcome;
      },
      async runRoutine(routineId) {
        host.state.moves = offline ? plan[phaseIndex] ?? [] : [];
        phaseIndex += 1;
        const outcome = await awaitRun((await world.routines.runNow(routineId, ORIGIN)).id);
        outcomes.push(outcome);
        return outcome;
      },
      async scripted(text, moves) {
        host.seeding = true;
        host.state.moves = moves;
        try {
          const outcome = await awaitRun(await world.send(bot, text));
          seedRunIds.add(outcome.runId);
          return outcome;
        } finally { host.seeding = false; }
      },
      async ageConversation(hours) {
        const shift = `${hours} hours`;
        await world.pool.query('UPDATE messages SET created_at = created_at - $1::interval WHERE conversation_id IN (SELECT id FROM conversations WHERE bot_id = $2)', [shift, bot.id]);
        await world.pool.query('UPDATE model_call_usage SET created_at = created_at - $1::interval WHERE conversation_id IN (SELECT id FROM conversations WHERE bot_id = $2)', [shift, bot.id]);
        // As execuções envelhecem junto: a lista das mais usadas é recalculada na conversa fria pelo `finished_at` das execuções anteriores (`readMostUsedAnchor`, passo 12), então um relógio de
        // `runs` parado no presente, com mensagens e uso no passado, daria uma conversa que o banco enxerga como fria mas cujas execuções "acabaram agora".
        await world.pool.query('UPDATE runs SET created_at = created_at - $1::interval, started_at = started_at - $1::interval, finished_at = finished_at - $1::interval WHERE conversation_id IN (SELECT id FROM conversations WHERE bot_id = $2)', [shift, bot.id]);
      },
      async coldSweep() {
        await new ColdMaintenance({ pool: world.pool, logger: world.logger }).tickOnce();
        await waitFor('fila da conversa esvaziar', async () => ((await world.pool.query("SELECT 1 FROM runs WHERE status IN ('queued', 'running', 'waiting_approval') LIMIT 1")).rowCount === 0 ? true : null), env.runTimeoutMs);
      },
    };
    host.state.ctx = ctx;
    world.engine.start();
    await def.setup?.(ctx);
    if (def.run) await def.run(ctx);
    else for (const text of def.rounds ?? []) await ctx.ownerSays(text);
    const accepted = def.acceptStatuses ?? ['completed'];
    checks = [{ name: 'execuções terminaram no estado esperado', ok: ctx.outcomes.every((outcome) => accepted.includes(outcome.status)) }, ...(await def.verify(ctx))];
  } catch (caught) {
    error = errorCodeOf(caught);
    checks = [...checks, { name: 'jornada concluiu sem erro do banco', ok: false }];
  }
  try {
    ({ cost, openings, afterOpen, toolStats } = await readCaseAccounts(world, seedRunIds));
  } catch { error ??= 'BENCH_ACCOUNTS_FAILED'; }
  // Diagnóstico do laço do prompt: a conversa da execução reprovada vai para um arquivo local antes de o banco do caso ser descartado.
  if (env.transcriptsDir && botId !== null && !host.cut && !(error === null && checks.length > 0 && checks.every((check) => check.ok))) await dumpTranscript(world, { botId, sessionId }, join(env.transcriptsDir, `${def.id}-${repeat}.txt`), checks).catch(() => undefined);
  await world.cleanup().catch(() => undefined);
  return {
    caseId: def.id, repeat, set: def.set, security: def.security, pass: !host.cut && error === null && checks.length > 0 && checks.every((check) => check.ok), cut: host.cut, checks, error,
    outcomes: outcomes.map((outcome) => ({ status: outcome.status, failureCode: outcome.failureCode })), toolStats, cost, openings, afterOpen, notes, models: [...host.models], wallMs: Math.round(performance.now() - started),
  };
}

/**
 * Grava a conversa de uma execução reprovada num arquivo local (laço do prompt, passo 15): o que o dono disse, o que o bot respondeu, cada chamada de ferramenta com os argumentos e o início do
 * resultado, e o desfecho das execuções. É a leitura que classifica uma falha real (faltou informação, texto mal escrito ou causa fora do prompt). O arquivo fica em `.aion-bench/` (fora do Git)
 * e o conteúdo NUNCA vai ao stdout nem ao relatório. Os textos são cortados para o arquivo não crescer.
 */
async function dumpTranscript(world: RunsWorld, scope: { botId: string; sessionId: string | null }, file: string, checks: readonly Check[]): Promise<void> {
  const clip = (text: string | null | undefined, max: number): string => { const value = (text ?? '').replace(/\s+/g, ' ').trim(); return value.length > max ? `${value.slice(0, max)}…[+${value.length - max}]` : value; };
  // A conversa do bot é a do `bot_id`; a do Chat geral é a própria sessão (mesmo id).
  const conversationIds = scope.sessionId ? [scope.sessionId] : (await world.pool.query<{ id: string }>('SELECT id::text FROM conversations WHERE bot_id = $1', [scope.botId])).rows.map((row) => row.id);
  const runs = await world.pool.query<{ id: string; status: string; failure_code: string | null; tool_calls: number }>('SELECT id::text, status, failure_code, tool_calls FROM runs WHERE conversation_id::text = ANY($1::text[]) ORDER BY id', [conversationIds]);
  const rows = await world.pool.query<{ id: string; run_id: string | null; role: string; kind: string; status: string; content: string; data: Record<string, unknown>; tool_arguments: string | null }>(
    'SELECT m.id::text, m.run_id::text, m.role, m.kind, m.status, m.content, m.data, m.tool_arguments FROM messages m WHERE m.conversation_id::text = ANY($1::text[]) ORDER BY m.id',
    [conversationIds],
  );
  const lines = [
    `verificações: ${checks.map((check) => `${check.ok ? 'ok' : 'FALHOU'} - ${check.name}`).join(' | ')}`,
    `execuções: ${runs.rows.map((run) => `#${run.id} ${run.status}${run.failure_code ? `/${run.failure_code}` : ''} (${run.tool_calls} chamadas)`).join('; ')}`,
    '',
  ];
  for (const row of rows.rows) {
    const tool = typeof row.data?.tool === 'string' ? row.data.tool : null;
    const via = typeof row.data?.via === 'string' ? ` via=${row.data.via}` : '';
    lines.push(`[#${row.id} run=${row.run_id ?? '-'} ${row.role}/${row.kind} ${row.status}${tool ? ` tool=${tool}${via}` : ''}]`);
    if (row.tool_arguments) lines.push(`  argumentos: ${clip(row.tool_arguments, 700)}`);
    if (row.content) lines.push(`  ${tool ? 'resultado' : 'texto'}: ${clip(row.content, 1400)}`);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${lines.join('\n')}\n`);
}

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Sandbox falso que calcula (passo 16)
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Valor do mini-interpretador: número (inteiro ou decimal, como o `int` e o `float` do Python) ou texto. */
type PyValue = { kind: 'num'; v: number; float: boolean } | { kind: 'str'; s: string };

/** Erro do programa Python avaliado: o tipo e a mensagem saem como a última linha do traceback, a linha vem do comando que falhou. */
class PyError extends Error {
  line = 0;
  constructor(readonly pyType: string, message: string) { super(message); }
}

const pyNum = (v: number, float: boolean): PyValue => {
  if (!Number.isFinite(v)) throw new PyError('OverflowError', 'resultado fora do alcance');
  return { kind: 'num', v, float };
};

/** Texto de um valor como o `print` do Python o mostra: decimal inteiro leva ".0" (`5.0`), inteiro não. */
function pyStr(value: PyValue): string {
  if (value.kind === 'str') return value.s;
  const text = String(value.v);
  return value.float && /^-?\d+$/.test(text) ? `${text}.0` : text;
}

/**
 * `round()` do Python. Sem casas, o meio exato vai para o par (`round(2.5)` é 2, `round(3.5)` é 4). Com casas, arredonda pelo valor binário exato do número, como o Python (`round(2.675, 2)` é 2.67), que é o
 * que `toFixed` faz; só difere do Python nos empates binários exatos com casas (`round(0.125, 2)`: o Python dá 0.12, o `toFixed` 0.13), que o banco não usa.
 */
function pyRound(x: number, digits: number): number {
  if (digits === 0) return Math.abs(x % 1) === 0.5 ? 2 * Math.round(x / 2) : Math.round(x);
  if (digits > 0 && digits <= 20 && Math.abs(x) < 1e15) return Number(x.toFixed(digits));
  const scale = 10 ** digits;
  return Math.round(x * scale) / scale;
}

/** Divide `text` em `separator` fora de aspas e de colchetes (usado para separar comandos por `;` e argumentos por `,`). */
function splitTop(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0, quote = '', start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) { if (char === '\\') index += 1; else if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") quote = char;
    else if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth -= 1;
    else if (char === separator && depth === 0) { parts.push(text.slice(start, index)); start = index + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Tira o comentário (`# ...`) da linha, respeitando aspas, e devolve também quanto a linha abre de colchetes sem fechar (para juntar um comando em várias linhas). */
function stripComment(line: string): { text: string; open: number } {
  let quote = '', open = 0;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote) { if (char === '\\') index += 1; else if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") quote = char;
    else if (char === '#') return { text: line.slice(0, index), open };
    else if ('([{'.includes(char)) open += 1;
    else if (')]}'.includes(char)) open -= 1;
  }
  return { text: line, open };
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t' };

type Token = { t: 'num' | 'str' | 'fstr' | 'id' | 'op'; s: string };

/** Quebra uma expressão em números (com `_` e expoente), textos (comuns e f-string), nomes (com `.`, como `math.pi`) e operadores. */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);
    const space = /^\s+/.exec(rest);
    if (space) { index += space[0].length; continue; }
    const number = /^(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?/.exec(rest);
    if (number) { tokens.push({ t: 'num', s: number[0].replace(/_/g, '') }); index += number[0].length; continue; }
    const open = /^([fF])?(["'])/.exec(rest);
    if (open) {
      const quote = open[2]!;
      let end = open[0].length, text = '';
      while (end < rest.length && rest[end] !== quote) { if (rest[end] === '\\' && end + 1 < rest.length) { text += ESCAPES[rest[end + 1]!] ?? rest[end + 1]!; end += 2; } else { text += rest[end]!; end += 1; } }
      if (end >= rest.length) throw new PyError('SyntaxError', 'texto sem aspas de fechamento');
      tokens.push({ t: open[1] ? 'fstr' : 'str', s: text });
      index += end + 1;
      continue;
    }
    const id = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/.exec(rest);
    if (id) { tokens.push({ t: 'id', s: id[0] }); index += id[0].length; continue; }
    const op = /^(\*\*|\/\/|[-+*/%(),])/.exec(rest);
    if (!op) throw new PyError('SyntaxError', `caractere inesperado "${rest[0]}"`);
    tokens.push({ t: 'op', s: op[0] }); index += op[0].length;
  }
  return tokens;
}

/** Formata um valor numa f-string (`{x}`, `{x:.2f}`, `{x:,.2f}`, `{x:.1%}`, `{x:d}`); formato fora disso é recusado em vez de ignorado. */
function formatSpec(value: PyValue, spec: string): string {
  if (spec === '') return pyStr(value);
  const match = /^(,)?(?:\.(\d+))?([fd%])$/.exec(spec);
  if (!match || value.kind !== 'num') throw new PyError('ValueError', `formato "${spec}" não suportado pelo sandbox falso`);
  const [, comma, digits, type] = match;
  if (type === 'd' && value.float) throw new PyError('ValueError', "Unknown format code 'd' for object of type 'float'");
  const shown = Math.abs(type === '%' ? value.v * 100 : value.v).toFixed(type === 'd' ? 0 : Number(digits ?? 6));
  const [whole, fraction] = shown.split('.') as [string, string | undefined];
  return `${value.v < 0 ? '-' : ''}${comma ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : whole}${fraction ? `.${fraction}` : ''}${type === '%' ? '%' : ''}`;
}

/** Funções que o mini-interpretador conhece. */
const KNOWN_FUNCTIONS: ReadonlySet<string> = new Set(['round', 'abs', 'int', 'float', 'min', 'max', 'pow', 'math.pow', 'math.sqrt', 'math.floor', 'math.ceil']);

/** Avalia uma expressão aritmética de Python (números, textos, f-strings, variáveis, `+ - * / // % **`, parênteses e algumas funções) contra as variáveis do programa. */
function evalExpression(source: string, vars: ReadonlyMap<string, PyValue>): PyValue {
  const tokens = tokenize(source);
  let position = 0;
  const isOp = (op: string): boolean => tokens[position]?.t === 'op' && tokens[position]!.s === op;
  const numeric = (value: PyValue): Extract<PyValue, { kind: 'num' }> => {
    if (value.kind !== 'num') throw new PyError('TypeError', 'operação aritmética com texto');
    return value;
  };
  const arith = (op: string, a: PyValue, b: PyValue): PyValue => {
    if (op === '+' && a.kind === 'str' && b.kind === 'str') return { kind: 'str', s: a.s + b.s };
    const x = numeric(a), y = numeric(b), float = x.float || y.float;
    if (op === '+') return pyNum(x.v + y.v, float);
    if (op === '-') return pyNum(x.v - y.v, float);
    if (op === '*') return pyNum(x.v * y.v, float);
    if (op === '**') return pyNum(x.v ** y.v, float || y.v < 0);
    if (y.v === 0) throw new PyError('ZeroDivisionError', op === '/' ? 'division by zero' : 'integer division or modulo by zero');
    if (op === '/') return pyNum(x.v / y.v, true);
    if (op === '//') return pyNum(Math.floor(x.v / y.v), float);
    return pyNum(x.v - y.v * Math.floor(x.v / y.v), float);
  };
  const call = (name: string, args: PyValue[]): PyValue => {
    if (!KNOWN_FUNCTIONS.has(name)) throw new PyError('NameError', `name '${name}' is not defined`);
    const nums = args.map(numeric);
    const one = (): Extract<PyValue, { kind: 'num' }> => { if (nums.length !== 1) throw new PyError('TypeError', `${name}() espera 1 argumento`); return nums[0]!; };
    switch (name) {
      case 'round': {
        if (nums.length < 1 || nums.length > 2) throw new PyError('TypeError', 'round() espera 1 ou 2 argumentos');
        return nums.length === 1 ? pyNum(pyRound(nums[0]!.v, 0), false) : pyNum(pyRound(nums[0]!.v, nums[1]!.v), nums[0]!.float);
      }
      case 'abs': return pyNum(Math.abs(one().v), one().float);
      case 'int': return pyNum(Math.trunc(one().v), false);
      case 'float': return pyNum(one().v, true);
      case 'min': case 'max': {
        if (nums.length === 0) throw new PyError('TypeError', `${name}() espera ao menos 1 argumento`);
        const picked = nums.reduce((best, item) => ((name === 'min' ? item.v < best.v : item.v > best.v) ? item : best));
        return pyNum(picked.v, picked.float);
      }
      case 'pow': case 'math.pow': if (nums.length !== 2) throw new PyError('TypeError', `${name}() espera 2 argumentos`); return arith('**', nums[0]!, nums[1]!);
      case 'math.sqrt': if (one().v < 0) throw new PyError('ValueError', 'math domain error'); return pyNum(Math.sqrt(one().v), true);
      case 'math.floor': return pyNum(Math.floor(one().v), false);
      case 'math.ceil': return pyNum(Math.ceil(one().v), false);
      default: throw new PyError('NameError', `name '${name}' is not defined`);
    }
  };
  const atom = (): PyValue => {
    const token = tokens[position++];
    if (!token) throw new PyError('SyntaxError', 'expressão incompleta');
    if (token.t === 'num') return { kind: 'num', v: Number(token.s), float: /[.eE]/.test(token.s) };
    if (token.t === 'str') return { kind: 'str', s: token.s };
    if (token.t === 'fstr') return { kind: 'str', s: token.s.replace(/\{\{|\}\}|\{([^{}]*)\}/g, (all, inner: string | undefined) => {
      if (inner === undefined) return all[0]!;
      const [expression, ...spec] = splitTop(inner, ':');
      return formatSpec(evalExpression(expression!, vars), spec.join(':').trim());
    }) };
    if (token.t === 'id') {
      if (isOp('(')) {
        position += 1;
        const args: PyValue[] = [];
        while (!isOp(')')) { args.push(sum()); if (isOp(',')) position += 1; else if (!isOp(')')) throw new PyError('SyntaxError', 'faltou ")" na chamada'); }
        position += 1;
        return call(token.s, args);
      }
      if (token.s === 'math.pi') return pyNum(Math.PI, true);
      if (token.s === 'math.e') return pyNum(Math.E, true);
      const found = vars.get(token.s);
      if (!found) throw new PyError('NameError', `name '${token.s}' is not defined`);
      return found;
    }
    if (token.s === '(') { const inside = sum(); if (!isOp(')')) throw new PyError('SyntaxError', 'faltou ")"'); position += 1; return inside; }
    throw new PyError('SyntaxError', `operador "${token.s}" inesperado`);
  };
  // Precedência do Python: ** (à direita, mais forte que o sinal unário à esquerda), depois sinal unário, * / // %, e + -.
  const power = (): PyValue => { const base = atom(); if (isOp('**')) { position += 1; return arith('**', base, unary()); } return base; };
  const unary = (): PyValue => {
    if (isOp('-')) { position += 1; const v = numeric(unary()); return pyNum(-v.v, v.float); }
    if (isOp('+')) { position += 1; return unary(); }
    return power();
  };
  const term = (): PyValue => { let value = unary(); while (isOp('*') || isOp('/') || isOp('//') || isOp('%')) { const op = tokens[position++]!.s; value = arith(op, value, unary()); } return value; };
  const sum = (): PyValue => { let value = term(); while (isOp('+') || isOp('-')) { const op = tokens[position++]!.s; value = arith(op, value, term()); } return value; };
  const result = sum();
  if (position < tokens.length) throw new PyError('SyntaxError', 'expressão com sobra depois do fim');
  return result;
}

/** Um comando do programa, com os do bloco (`for`) que ele abre. */
interface PyStatement { text: string; line: number; indent: number; body: PyStatement[] }

/**
 * Separa o código em comandos: junta o que abre colchete e não fecha, tira comentários, parte por `;` e agrupa por indentação o corpo do `for`. `if`, `while`, `def`, `class`, `with` e `try` não são
 * suportados e viram erro claro, não saída vazia.
 */
function parseProgram(code: string): PyStatement[] {
  const root: PyStatement = { text: '', line: 0, indent: -1, body: [] };
  const stack: PyStatement[] = [root];
  let pending = '', pendingLine = 0, depth = 0;
  code.split(/\r?\n/).forEach((physical, index) => {
    const { text, open } = stripComment(physical);
    if (pending === '' && text.trim() === '') return;
    if (pending === '') pendingLine = index + 1;
    pending = pending === '' ? text : `${pending} ${text.trim()}`;
    depth += open;
    if (depth > 0) return;
    const indent = /^\s*/.exec(pending)![0].length;
    for (const piece of splitTop(pending.trim(), ';').map((part) => part.trim()).filter(Boolean)) {
      while (stack.length > 1 && stack.at(-1)!.indent >= indent) stack.pop();
      const statement: PyStatement = { text: piece, line: pendingLine, indent, body: [] };
      stack.at(-1)!.body.push(statement);
      if (/^for\s.*:$/.test(piece)) stack.push(statement);
      else if (/^(?:if|elif|else|while|def|class|with|try|except|finally|from|return|lambda)\b/.test(piece) || (/^import\b/.test(piece) && piece !== 'import math')) {
        throw Object.assign(new PyError('NotImplementedError', `"${piece.split(/[\s:(]/)[0]}" não é suportado pelo sandbox falso do banco de testes (só aritmética, atribuições, print, import math e for/range)`), { line: pendingLine });
      }
    }
    pending = ''; depth = 0;
  });
  if (pending !== '') throw Object.assign(new PyError('SyntaxError', 'parêntese sem fechar no fim do código'), { line: pendingLine });
  return root.body;
}

/** Estado de uma execução do mini-interpretador: o que foi impresso, o último valor calculado e o contador de passos (corta laço enorme). */
interface PyRun { out: string[]; printed: boolean; last: PyValue | null; steps: number }

/** Executa os comandos: atribuições (e `+=` e afins), `print(...)`, `for x in range(...)`, `import math` e expressões soltas. O que não for isso lança `NotImplementedError`. */
function runStatements(statements: readonly PyStatement[], vars: Map<string, PyValue>, run: PyRun): void {
  for (const statement of statements) {
    try {
      if ((run.steps += 1) > 100_000) throw new PyError('TimeoutError', 'limite de passos do sandbox falso');
      const { text } = statement;
      const loop = /^for\s+([A-Za-z_]\w*)\s+in\s+range\((.*)\)\s*:$/.exec(text);
      const assign = /^([A-Za-z_]\w*)\s*(\*\*|\/\/|[-+*/%])?=(?!=)\s*(.+)$/.exec(text);
      const printed = /^print\((.*)\)$/.exec(text);
      if (text === 'import math') continue;
      if (loop) {
        const bounds = splitTop(loop[2]!, ',').map((part) => evalExpression(part, vars));
        const ints = bounds.flatMap((bound) => (bound.kind === 'num' && !bound.float ? [bound.v] : []));
        if (ints.length !== bounds.length || ints.length < 1 || ints.length > 2) throw new PyError('TypeError', 'range() só aceita 1 ou 2 inteiros no sandbox falso');
        const [from, to] = ints.length === 1 ? [0, ints[0]!] : [ints[0]!, ints[1]!];
        for (let i = from; i < to; i += 1) { vars.set(loop[1]!, { kind: 'num', v: i, float: false }); runStatements(statement.body, vars, run); }
      } else if (assign) {
        const value = evalExpression(assign[3]!, vars);
        const current = vars.get(assign[1]!);
        if (assign[2] && !current) throw new PyError('NameError', `name '${assign[1]}' is not defined`);
        const next = assign[2] ? evalExpression(`__a ${assign[2]} (__b)`, new Map([['__a', current!], ['__b', value]])) : value;
        vars.set(assign[1]!, next);
        run.last = next;
      } else if (printed) {
        const args = printed[1]!.trim() === '' ? [] : splitTop(printed[1]!, ',').map((part) => part.trim());
        if (args.some((arg) => /^(?:sep|end|file|flush)\s*=/.test(arg))) throw new PyError('NotImplementedError', 'print com sep=, end= ou file= não é suportado pelo sandbox falso');
        run.out.push(args.map((arg) => pyStr(evalExpression(arg, vars))).join(' '));
        run.printed = true;
      } else if (/^for\b/.test(text)) {
        throw new PyError('NotImplementedError', 'só "for x in range(...)" é suportado pelo sandbox falso');
      } else {
        run.last = evalExpression(text, vars);
      }
    } catch (error) {
      if (error instanceof PyError && error.line === 0) error.line = statement.line;
      throw error;
    }
  }
}

/**
 * Sandbox FALSO que calcula: o falso padrão não executa Python e devolve saída vazia, o que deixaria o modelo sem resultado e o faria insistir. Este roda um subconjunto de Python que cobre o
 * cálculo que um modelo escreve (atribuições, `print` com f-string e `round`, `**`, `//`, `%`, `for ... in range(...)`, `math.sqrt` e afins), imprime o que o `print` pediu e, SE o programa não
 * imprimiu nada, imprime o último valor calculado (o falso é mais generoso que o Python real, que não ecoa a última expressão: o banco não quer um caso reprovado por um sandbox mudo). O que ele não
 * sabe calcular volta como `PYTHON_ERROR` com um traceback claro (nunca saída vazia), e o modelo corrige. Não é o Python de verdade (o sandbox real só é provado em container).
 * ponytail: subconjunto de Python (sem listas, funções, `if`, `while`, imports além de `math`), ampliar quando um caso do banco precisar de mais.
 */
export function calcSandboxHandler(request: FakeSandboxRequest): FakeSandboxResponse {
  const run: PyRun = { out: [], printed: false, last: null, steps: 0 };
  try {
    runStatements(parseProgram(request.code), new Map(), run);
  } catch (error) {
    if (!(error instanceof PyError)) throw error;
    return { outcome: 'PYTHON_ERROR', output: run.out.join('\n'), error: `Traceback (most recent call last):\n  File "<exec>", line ${error.line}, in <module>\n${error.pyType}: ${error.message}` };
  }
  if (!run.printed && run.last) run.out.push(pyStr(run.last));
  return { output: run.out.join('\n') };
}

/** Lê do banco do caso o custo (sem as execuções semeadas por modelo roteirizado), as aberturas, as etapas após abrir grupo e as falhas por ferramenta. */
async function readCaseAccounts(world: RunsWorld, seedRunIds: ReadonlySet<string>): Promise<{ cost: CaseCost; openings: OpeningCost[]; afterOpen: AfterOpenCost; toolStats: CaseResult['toolStats'] }> {
  const calls: UsageCall[] = (await readUsageCalls(world.pool, { since: new Date(0), until: new Date(Date.now() + 60_000), timeZone: 'UTC' })).filter((call) => !seedRunIds.has(call.runId));
  const report = buildCostReport(calls, MODEL_PRICES);
  const cost = costOf(report.total);
  const opened = report.byCategory.get(AFTER_OPEN_CATEGORY);
  const afterOpen: AfterOpenCost = opened ? { calls: opened.calls, inputTokens: opened.inputTokens, cachedTokens: opened.cachedTokens } : zeroAfterOpen();
  const firsts = new Map<string, UsageCall>();
  for (const call of calls) if (call.category !== 'resumo' && !firsts.has(call.runId)) firsts.set(call.runId, call);
  const openings = [...firsts.values()].map((call) => ({ runId: call.runId, category: call.category, inputTokens: call.inputTokens, uncachedTokens: call.inputTokens - Math.min(call.cachedTokens ?? 0, call.inputTokens) }));
  const stats = await world.pool.query<{ tool: string; status: string; waiting: boolean; total: number }>(
    "SELECT data->>'tool' AS tool, status, coalesce(data->>'awaitingApproval', 'false') = 'true' AS waiting, count(*)::int AS total FROM messages WHERE kind = 'activity' AND data ? 'tool' AND run_id <> ALL($1::bigint[]) GROUP BY 1, 2, 3",
    [[...seedRunIds]],
  );
  const toolStats: CaseResult['toolStats'] = {};
  for (const row of stats.rows) {
    const entry = (toolStats[row.tool] ??= { ok: 0, failed: 0, waiting: 0, codes: {} });
    if (row.status === 'failed') entry.failed += row.total;
    else if (row.status === 'completed') entry.ok += row.total;
    else if (row.status === 'running' && row.waiting) entry.waiting += row.total;
  }
  // O código de cada falha vem do envelope gravado como resultado da atividade (A21: `{ code, message }`); só o código estável sai daqui, nunca a mensagem nem o resto do resultado.
  const failures = await world.pool.query<{ tool: string; content: string }>(
    "SELECT data->>'tool' AS tool, content FROM messages WHERE kind = 'activity' AND status = 'failed' AND data ? 'tool' AND run_id <> ALL($1::bigint[])",
    [[...seedRunIds]],
  );
  for (const row of failures.rows) {
    const code = failureCodeOf(row.content);
    const entry = (toolStats[row.tool] ??= { ok: 0, failed: 0, waiting: 0, codes: {} });
    entry.codes[code] = (entry.codes[code] ?? 0) + 1;
  }
  return { cost, openings, afterOpen, toolStats };
}

/**
 * Código do envelope de falha (`{ code, message }`) de um resultado gravado, ou `SEM_CODIGO` quando o resultado não é um envelope com código estável. Nunca devolve texto da mensagem. A falha do
 * `run_python` chega sempre como `TOOL_FAILED` genérico, o que não diz se o sandbox recusou o código, estourou o tempo ou caiu: para esse envelope o desfecho do sandbox (`PYTHON_ERROR`, ...) e o NOME
 * da classe do erro Python (`NotImplementedError`, `NameError`, ...) são acrescentados (`TOOL_FAILED/PYTHON_ERROR:NotImplementedError`), só esses dois identificadores e nunca o texto do erro.
 */
export function failureCodeOf(content: string | null): string {
  try {
    const parsed: unknown = JSON.parse(content ?? '');
    const envelope = typeof parsed === 'object' && parsed !== null ? (parsed as { code?: unknown; message?: unknown }) : {};
    if (typeof envelope.code !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/.test(envelope.code)) return 'SEM_CODIGO';
    return envelope.code === 'TOOL_FAILED' && typeof envelope.message === 'string' ? `${envelope.code}${pythonCauseOf(envelope.message)}` : envelope.code;
  } catch { return 'SEM_CODIGO'; }
}

/** O desfecho do sandbox (`Desfecho: PYTHON_ERROR.` ou `PYTHON_ERROR:` no começo) e a última classe de erro Python do texto, no formato `/DESFECHO:Classe`; vazio quando a falha não é do `run_python`. */
function pythonCauseOf(message: string): string {
  const outcome = /^(?:Desfecho: )?(PYTHON_[A-Z_]{3,40})\b/.exec(message)?.[1];
  if (!outcome) return '';
  const errorClass = [...message.matchAll(/\b([A-Z][A-Za-z]{2,40}(?:Error|Exception))\s*:/g)].at(-1)?.[1];
  return `/${outcome}${errorClass ? `:${errorClass}` : ''}`;
}

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Execução do conjunto
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Liberação dos casos separados: só o gate final liga (A3). Fica em módulo para `runCase` recusar a execução cedo, em qualquer caminho de chamada. */
let finalGateEnabled = false;

export interface BenchOptions {
  set: CaseSet | 'all';
  /** Execuções por caso (cada uma é um mundo novo). */
  repeats: number;
  /** Subconjunto por id (vazio = todos do conjunto). */
  only: readonly string[];
  concurrency: number;
  /** Liga os casos separados: só o gate final do passo 16. */
  finalGate: boolean;
}

export interface BenchSummary {
  options: BenchOptions;
  results: CaseResult[];
  repeatsPlanned: number;
  repeatsRun: number;
  /** As repetições foram reduzidas porque a projeção de gasto passaria do teto da rodada. */
  reducedForCap: boolean;
  /** O livro recusou uma chamada: o banco parou relatando o gasto (A4). */
  budgetStopped: boolean;
  runSpentUsd: number;
  phaseSpentUsd: number;
  phaseCapUsd: number;
}

/** Casos do conjunto pedido. Os separados só entram com o gate final ligado (A3). */
export function selectCases(options: Pick<BenchOptions, 'set' | 'only' | 'finalGate'>, cases: readonly BenchCase[] = BENCH_CASES): BenchCase[] {
  if (!options.finalGate && (options.set === 'held-out' || options.set === 'all')) throw new Error('BENCH_HELD_OUT_BEFORE_GATE');
  const chosen = cases.filter((def) => (options.set === 'all' || def.set === options.set) && (options.only.length === 0 || options.only.includes(def.id)));
  if (!options.finalGate && chosen.some((def) => def.set === 'held-out')) throw new Error('BENCH_HELD_OUT_BEFORE_GATE');
  return chosen;
}

/** Roda `tasks` com no máximo `limit` em voo, devolvendo os resultados na ordem. */
async function pool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await work(items[index]!);
    }
  }));
  return results;
}

/**
 * Quantas repetições cabem no teto da rodada depois da primeira: a primeira já gastou `runSpentUsd`, cada nova custa cerca de `perRepeatUsd`, e 20% do teto ficam de folga (a reserva de pior
 * caso de uma chamada e a variação entre repetições). Nunca menos de 1 (a primeira já rodou) nem mais que as pedidas.
 */
export function affordableRepeats(requested: number, runCapUsd: number, runSpentUsd: number, perRepeatUsd: number): number {
  if (perRepeatUsd <= 0) return requested;
  return Math.max(1, Math.min(requested, 1 + Math.floor(Math.max(0, runCapUsd * 0.8 - runSpentUsd) / perRepeatUsd)));
}

/**
 * Roda o conjunto: a primeira repetição de todos os casos, depois a projeção do gasto (se o teto da rodada não comporta as repetições pedidas, roda menos e diz), depois as demais.
 * O teto da phase é do livro; quando ele recusa uma chamada, nenhum caso novo começa e o resultado diz que parou.
 */
export async function runBench(options: BenchOptions, env: BenchEnv, cases: readonly BenchCase[] = BENCH_CASES): Promise<BenchSummary> {
  finalGateEnabled = options.finalGate;
  const chosen = selectCases(options, cases);
  const results: CaseResult[] = [];
  const runOne = async (task: { def: BenchCase; repeat: number }): Promise<void> => {
    if (env.ledger.refused) return;
    results.push(await runCase(task.def, task.repeat, env));
  };
  let repeatsRun = 0;
  let reducedForCap = false;
  let planned = options.repeats;
  for (let repeat = 1; repeat <= planned; repeat += 1) {
    const before = env.ledger.runSpentUsd;
    await pool(chosen.map((def) => ({ def, repeat })), options.concurrency, runOne);
    if (env.ledger.refused) break;
    repeatsRun = repeat;
    const perRepeat = env.ledger.runSpentUsd - before;
    if (repeat === 1 && env.ledger.runCapUsd !== null) {
      const affordable = affordableRepeats(planned, env.ledger.runCapUsd, env.ledger.runSpentUsd, perRepeat);
      if (affordable < planned) { planned = affordable; reducedForCap = true; }
    }
  }
  results.sort((a, b) => a.caseId.localeCompare(b.caseId) || a.repeat - b.repeat);
  return {
    options, results, repeatsPlanned: options.repeats, repeatsRun, reducedForCap, budgetStopped: env.ledger.refused,
    runSpentUsd: env.ledger.runSpentUsd, phaseSpentUsd: env.ledger.spentUsd, phaseCapUsd: env.ledger.capUsd,
  };
}

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Medição do catálogo (bytes de bot, Chat geral, núcleo, portas e sistema)
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Bytes e contagem de um conjunto de definições de ferramenta. */
export interface ToolSet { count: number; bytes: number }

/**
 * O catálogo medido no código atual: bot e Chat geral, no estado inicial e com todo o catálogo carregado. No BOT (phase 15, passo 11) o inicial é a lista fixa (as portas e o conjunto das mais usadas, que o
 * passo 12 recalcula por bot) e o "cheio" é a soma das definições do registry: a lista fixa mais o esquema de cada ferramenta que `abrir_grupo` abre. No Chat geral, o inicial e o cheio (todas as opcionais
 * selecionadas por `discover_tools`) seguem como antes.
 */
export interface CatalogMeasure {
  bot: { initial: ToolSet; core: ToolSet; ports: ToolSet; full: ToolSet; systemChars: number };
  generalChat: { initial: ToolSet; full: ToolSet; systemChars: number };
}

const toolSetOf = (tools: readonly { name: string }[] | undefined): ToolSet => ({ count: tools?.length ?? 0, bytes: Buffer.byteLength(JSON.stringify(tools ?? []), 'utf8') });

/**
 * Os esquemas que `abrir_grupo` devolveu no histórico de um pedido do bot: cada ferramenta aberta chega como resultado próprio ({ name, description, parameters }); o resultado da chamada (resumo da abertura)
 * e qualquer outro resultado não são esquemas e ficam de fora. Sem repetição por nome.
 */
function openedSchemas(request: ChatRequest): NonNullable<ChatRequest['tools']> {
  const byName = new Map<string, NonNullable<ChatRequest['tools']>[number]>();
  for (const turn of request.turns) {
    if (turn.role !== 'tool') continue;
    try {
      const parsed = JSON.parse(turn.text) as { name?: unknown; description?: unknown; parameters?: unknown };
      if (typeof parsed.name === 'string' && typeof parsed.description === 'string' && typeof parsed.parameters === 'object' && parsed.parameters !== null) byName.set(parsed.name, parsed as NonNullable<ChatRequest['tools']>[number]);
    } catch { /* resultado de ferramenta que não é um esquema */ }
  }
  return [...byName.values()];
}

/** Nomes do índice de `discover_tools` (uma linha "nome: descrição" por ferramenta opcional), lidos da descrição da própria porta. */
function optionalNamesOf(request: ChatRequest): string[] {
  const description = request.tools?.find((tool) => tool.name === 'discover_tools')?.description ?? '';
  return [...description.matchAll(/^([a-z][a-z0-9_]*): /gm)].map((match) => match[1]!);
}

/**
 * Mede o catálogo no código atual com o modelo roteirizado (gratuito, igual nos dois modos): o primeiro pedido de um bot e de uma sessão do Chat geral dá o catálogo inicial
 * (portas e núcleo) e o tamanho do sistema; selecionar todas as opcionais pelo `discover_tools`, em lotes de 8, dá o catálogo cheio no pedido seguinte.
 */
export async function measureCatalog(env: BenchEnv): Promise<CatalogMeasure> {
  const host = new ModelHost(null, SpendLedger.open({ file: null, capUsd: 1e9 }), () => 'catalogo', 1);
  const world = await createRunsWorld({
    adminDatabaseUrl: env.adminUrl, realModel: { provider: host, apiKey: env.apiKey, model: BENCH_MODEL }, coreCatalog: true, webSearch: true,
    python: { url: env.sandbox.url, token: env.sandbox.token }, contextWindow: 'product',
  });
  try {
    await world.connectComposio();
    await world.credentials.save('web_search', `valid-web-bench-${randomUUID().slice(0, 8)}`, ORIGIN);
    world.engine.start();
    const bot = await world.createBot({ name: 'Catalogo', model: BENCH_MODEL, instructions: '' });
    await world.releaseConnectorAccounts(bot);
    const lastRequest = (): ChatRequest => host.state.requests.at(-1)!;
    const runAndWait = async (send: () => Promise<string>): Promise<void> => { await world.waitForStatus(await send(), 'completed', 30_000); };
    const batches = (names: string[]): Move[] => Array.from({ length: Math.ceil(names.length / 8) }, (_unused, index) => ({ tool: 'discover_tools', args: { names: names.slice(index * 8, index * 8 + 8) } }));

    host.state.moves = [];
    await runAndWait(() => world.send(bot, 'Olá'));
    const botInitial = lastRequest();
    // BOT: abre cada galho de nível 1 da árvore; os esquemas voltam em resultados próprios no fim do histórico, e a soma deles com a lista fixa é o catálogo cheio (a lista fixa NÃO muda).
    host.state.moves = [...new Set(TOOL_TREE.map((group) => group.path.split('/')[0]!))].map((path) => ({ tool: ABRIR_GRUPO, args: { path } }));
    await runAndWait(() => world.send(bot, 'Carregue tudo'));
    host.state.moves = [];
    await runAndWait(() => world.send(bot, 'Olá de novo'));
    const botFull = lastRequest();
    const publishedNames = new Set((botInitial.tools ?? []).map((tool) => tool.name));
    const botFullTools = [...(botInitial.tools ?? []), ...openedSchemas(botFull).filter((tool) => !publishedNames.has(tool.name))];

    const chat = new GeneralChatService({ pool: world.pool });
    const session = await chat.create();
    await world.conversations.setPreference({ sessionId: session.id }, BENCH_MODEL, null);
    host.state.moves = [];
    await runAndWait(async () => (await world.conversations.send({ sessionId: session.id }, 'Olá')).id);
    const chatInitial = lastRequest();
    host.state.moves = batches(optionalNamesOf(chatInitial));
    await runAndWait(async () => (await world.conversations.send({ sessionId: session.id }, 'Carregue tudo')).id);
    host.state.moves = [];
    await runAndWait(async () => (await world.conversations.send({ sessionId: session.id }, 'Olá de novo')).id);
    const chatFull = lastRequest();

    const systemChars = (request: ChatRequest): number => { const first = request.turns[0]; return first?.role === 'system' ? first.text.length : 0; };
    // As portas do bot (as de exposição e as do conector) e, fora delas, as mais usadas da lista fixa (o "núcleo" do relatório).
    const ports = new Set([ABRIR_GRUPO, USE_TOOL, READ_ACTIVITY, ...CONNECTOR_PORTS]);
    return {
      bot: {
        initial: toolSetOf(botInitial.tools), ports: toolSetOf(botInitial.tools?.filter((tool) => ports.has(tool.name))), core: toolSetOf(botInitial.tools?.filter((tool) => !ports.has(tool.name))),
        full: toolSetOf(botFullTools), systemChars: systemChars(botInitial),
      },
      generalChat: { initial: toolSetOf(chatInitial.tools), full: toolSetOf(chatFull.tools), systemChars: systemChars(chatInitial) },
    };
  } finally { await world.cleanup().catch(() => undefined); }
}

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Relatório
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

const money = (value: number): string => `US$ ${value.toFixed(6)}`;
const pct = (part: number, whole: number): string => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '-');
const int = (value: number): string => Math.round(value).toLocaleString('pt-BR');

/**
 * Acerto e custo agregados de um conjunto de resultados. Os casos CORTADOS pelo guarda de gasto ficam fora de tudo (`runs`, `passed` e `cost`) e só aparecem em `cut`: o corte interrompe a
 * jornada no meio, então contá-lo como erro derrubaria o acerto por causa do teto e contar o custo parcial puxaria a média para baixo. O gasto real de todos eles está no livro.
 */
export function aggregate(results: readonly CaseResult[]): { runs: number; passed: number; cut: number; cost: CaseCost } {
  const cost = zeroCost();
  const counted = results.filter((result) => !result.cut);
  for (const result of counted) for (const key of Object.keys(cost) as (keyof CaseCost)[]) cost[key] += result.cost[key];
  return { runs: counted.length, passed: counted.filter((result) => result.pass).length, cut: results.length - counted.length, cost };
}

/**
 * Relatório em Markdown: acerto por caso e total, custo por caso e total, falhas por ferramenta, aberturas, a etapa após abrir grupo, o catálogo medido e o gasto do livro. Só identificadores,
 * rótulos de verificação e números. Os casos cortados pelo teto de gasto ficam fora do acerto, do custo e das demais tabelas e aparecem numa seção própria.
 */
export function formatReport(summary: BenchSummary, meta: { title: string; label: string; catalog: CatalogMeasure | null; generatedAt: string }): string {
  const cutResults = summary.results.filter((result) => result.cut);
  const results = summary.results.filter((result) => !result.cut);
  const ids = [...new Set(summary.results.map((result) => result.caseId))];
  const total = aggregate(summary.results);
  const lines: string[] = [
    `# ${meta.title}`,
    '',
    `Gerado em ${meta.generatedAt}. Rodada: ${meta.label}. Modelo: ${BENCH_MODEL}. Conjunto: ${summary.options.set}. Repetições pedidas: ${summary.repeatsPlanned}; rodadas completas: ${summary.repeatsRun}${summary.reducedForCap ? ' (REDUZIDAS: a projeção de gasto passaria do teto da rodada)' : ''}.`,
    summary.budgetStopped ? 'A PARADA DO TETO FOI ACIONADA: o livro recusou uma chamada e o banco parou (resultados parciais).' : '',
    cutResults.length > 0 ? `${cutResults.length} execução(ões) CORTADA(S) pelo teto de gasto, interrompidas no meio: ficam fora do acerto, do custo e das demais tabelas (não erraram); a lista está em "Casos cortados pelo teto".` : '',
    '',
    '## Acerto (efeito consultado no banco)',
    '',
    '| Caso | Conjunto | Segurança | Acertos | Execuções | Acerto | Verificações que falharam |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const id of ids) {
    const rows = results.filter((result) => result.caseId === id);
    if (rows.length === 0) { const first = summary.results.find((result) => result.caseId === id)!; lines.push(`| ${id} | ${first.set} | ${first.security ? 'sim' : 'não'} | 0 | 0 | - | todas as execuções foram cortadas |`); continue; }
    // Execução fora do estado esperado: o relatório diz qual estado e qual código de falha ela teve (identificadores), para o diagnóstico não depender de nova rodada.
    const states = [...new Set(rows.filter((row) => row.checks.some((check) => !check.ok && check.name === 'execuções terminaram no estado esperado')).flatMap((row) => row.outcomes.map((outcome) => `${outcome.status}${outcome.failureCode ? `/${outcome.failureCode}` : ''}`)))];
    const failed = [...new Set(rows.flatMap((row) => [...row.checks.filter((check) => !check.ok).map((check) => check.name), ...(row.error ? [`erro ${row.error}`] : [])])), ...(states.length ? [`estados vistos: ${states.join(', ')}`] : [])];
    lines.push(`| ${id} | ${rows[0]!.set} | ${rows[0]!.security ? 'sim' : 'não'} | ${rows.filter((row) => row.pass).length} | ${rows.length} | ${pct(rows.filter((row) => row.pass).length, rows.length)} | ${failed.join('; ') || '-'} |`);
  }
  lines.push(`| TOTAL | | | ${total.passed} | ${total.runs} | ${pct(total.passed, total.runs)} | |`, '');
  lines.push('## Custo (lido de `model_call_usage`, preços de `cost-report.ts`)', '', '| Caso | Execuções | Chamadas (média) | Entrada (média) | Sem cache (média) | Cache | Saída (média) | Raciocínio (média) | Custo médio | Custo total |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const id of ids) {
    const rows = results.filter((result) => result.caseId === id);
    if (rows.length === 0) continue;
    const sum = aggregate(rows).cost, n = rows.length;
    lines.push(`| ${id} | ${n} | ${(sum.calls / n).toFixed(1)} | ${int(sum.inputTokens / n)} | ${int((sum.inputTokens - sum.cachedTokens) / n)} | ${pct(sum.cachedTokens, sum.inputTokens)} | ${int(sum.outputTokens / n)} | ${int(sum.reasoningTokens / n)} | ${money(sum.usd / n)} | ${money(sum.usd)} |`);
  }
  lines.push(`| TOTAL | ${total.runs} | ${(total.cost.calls / Math.max(1, total.runs)).toFixed(1)} | ${int(total.cost.inputTokens / Math.max(1, total.runs))} | ${int((total.cost.inputTokens - total.cost.cachedTokens) / Math.max(1, total.runs))} | ${pct(total.cost.cachedTokens, total.cost.inputTokens)} | ${int(total.cost.outputTokens / Math.max(1, total.runs))} | ${int(total.cost.reasoningTokens / Math.max(1, total.runs))} | ${money(total.cost.usd / Math.max(1, total.runs))} | ${money(total.cost.usd)} |`, '');
  // Falhas por ferramenta: o total da rodada e, logo depois, quebrado por CASO e por código de falha (A21), para a falha de `abrir_grupo` ou `run_python` ser atribuível a um caso e a uma causa.
  const tools = new Map<string, ToolStat>();
  const perCase = new Map<string, ToolStat>();
  const addStat = (map: Map<string, ToolStat>, key: string, stat: ToolStat): void => {
    const entry = map.get(key) ?? { ok: 0, failed: 0, waiting: 0, codes: {} };
    entry.ok += stat.ok; entry.failed += stat.failed; entry.waiting += stat.waiting;
    for (const [code, count] of Object.entries(stat.codes)) entry.codes[code] = (entry.codes[code] ?? 0) + count;
    map.set(key, entry);
  };
  for (const result of results) for (const [tool, stat] of Object.entries(result.toolStats)) { addStat(tools, tool, stat); addStat(perCase, `${result.caseId}\u0000${tool}`, stat); }
  const codesText = (stat: ToolStat): string => Object.entries(stat.codes).sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => `${code} x${count}`).join(', ') || '-';
  // "Chamadas" soma as concluídas, as falhas e as que pararam em aprovação (o desfecho certo de uma ação externa ou de uma exclusão sem regra); a fração de falha é das que se resolveram (concluídas e falhas).
  lines.push('## Falhas por ferramenta (A12: fração de falha das chamadas)', '', '| Ferramenta | Chamadas | Concluídas | Falhas | Em aprovação | Fração de falha | Códigos de falha |', '|---|---|---|---|---|---|---|');
  for (const [tool, stat] of [...tools.entries()].sort(([a], [b]) => a.localeCompare(b))) lines.push(`| ${tool} | ${stat.ok + stat.failed + stat.waiting} | ${stat.ok} | ${stat.failed} | ${stat.waiting} | ${pct(stat.failed, stat.ok + stat.failed)} | ${codesText(stat)} |`);
  lines.push('', '## Falhas por ferramenta e por caso (só os pares com ao menos uma falha ou uma chamada parada em aprovação)', '');
  const failing = [...perCase.entries()].filter(([, stat]) => stat.failed > 0 || stat.waiting > 0).sort(([a], [b]) => a.localeCompare(b));
  if (failing.length === 0) lines.push('Nenhuma ferramenta falhou nem parou em aprovação nesta rodada.');
  else {
    lines.push('| Caso | Ferramenta | Chamadas | Concluídas | Falhas | Em aprovação | Fração de falha | Códigos de falha |', '|---|---|---|---|---|---|---|---|');
    for (const [key, stat] of failing) { const [caseId, tool] = key.split('\u0000') as [string, string]; lines.push(`| ${caseId} | ${tool} | ${stat.ok + stat.failed + stat.waiting} | ${stat.ok} | ${stat.failed} | ${stat.waiting} | ${pct(stat.failed, stat.ok + stat.failed)} | ${codesText(stat)} |`); }
  }
  lines.push('', '## Aberturas (entrada sem cache da primeira chamada de cada execução; A8 compara a da rotina fria)', '', 'Cada execução tem um bot de nome único, então o prefixo do pedido é inédito e a primeira chamada começa sem cache (medição reprodutível, independente da ordem dos casos).', '', '| Caso | Execução | Posição | Entrada | Sem cache |', '|---|---|---|---|---|');
  for (const result of results) result.openings.forEach((opening, index) => lines.push(`| ${result.caseId}#${result.repeat} | ${index + 1} | ${opening.category} | ${int(opening.inputTokens)} | ${int(opening.uncachedTokens)} |`));
  lines.push('', `## Etapa após abrir grupo (A23: a chamada que vem logo depois de \`abrir_grupo\`, categoria \`${AFTER_OPEN_CATEGORY}\` do relatório de custo)`, '');
  const opened = ids.map((id) => ({ id, rows: results.filter((result) => result.caseId === id && result.afterOpen.calls > 0) })).filter((entry) => entry.rows.length > 0);
  if (opened.length === 0) lines.push('Nenhuma execução abriu grupo nesta rodada.');
  else {
    lines.push('| Caso | Execuções que abriram | Etapas medidas | Entrada (média por etapa) | Sem cache (média por etapa) | Cache |', '|---|---|---|---|---|---|');
    const sums = { rows: 0, calls: 0, input: 0, cached: 0 };
    for (const { id, rows } of opened) {
      const calls = rows.reduce((sum, row) => sum + row.afterOpen.calls, 0), input = rows.reduce((sum, row) => sum + row.afterOpen.inputTokens, 0), cached = rows.reduce((sum, row) => sum + row.afterOpen.cachedTokens, 0);
      sums.rows += rows.length; sums.calls += calls; sums.input += input; sums.cached += cached;
      lines.push(`| ${id} | ${rows.length} | ${calls} | ${int(input / calls)} | ${int((input - cached) / calls)} | ${pct(cached, input)} |`);
    }
    lines.push(`| TOTAL | ${sums.rows} | ${sums.calls} | ${int(sums.input / sums.calls)} | ${int((sums.input - sums.cached) / sums.calls)} | ${pct(sums.cached, sums.input)} |`);
  }
  if (meta.catalog) {
    const set = (value: ToolSet): string => `${value.count} ferramentas, ${int(value.bytes)} bytes`;
    lines.push('', '## Catálogo medido no código atual', '', '| Conjunto | Medida |', '|---|---|',
      `| Bot, pedido inicial (portas e núcleo) | ${set(meta.catalog.bot.initial)} |`, `| Bot, núcleo sem as portas | ${set(meta.catalog.bot.core)} |`, `| Bot, portas | ${set(meta.catalog.bot.ports)} |`,
      `| Bot, tudo selecionado | ${set(meta.catalog.bot.full)} |`, `| Bot, sistema | ${int(meta.catalog.bot.systemChars)} caracteres |`,
      `| Chat geral, pedido inicial | ${set(meta.catalog.generalChat.initial)} |`, `| Chat geral, tudo selecionado | ${set(meta.catalog.generalChat.full)} |`, `| Chat geral, sistema | ${int(meta.catalog.generalChat.systemChars)} caracteres |`);
  }
  const noted = results.filter((result) => Object.keys(result.notes).length > 0);
  if (noted.length > 0) {
    lines.push('', '## Observações dos casos (não decidem o acerto)', '', '| Caso | Observação | Valor |', '|---|---|---|');
    for (const result of noted) for (const [name, value] of Object.entries(result.notes)) lines.push(`| ${result.caseId}#${result.repeat} | ${name} | ${String(value)} |`);
  }
  if (cutResults.length > 0) {
    lines.push('', '## Casos cortados pelo teto', '', 'O livro de gasto recusou uma chamada destes casos e a jornada parou no meio: não erraram, e ficam fora do acerto e do custo médio (o gasto deles está no livro).', '', '| Caso | Repetição | Chamadas feitas |', '|---|---|---|');
    for (const result of cutResults) lines.push(`| ${result.caseId} | ${result.repeat} | ${result.cost.calls} |`);
  }
  lines.push('', '## Gasto do provedor', '', `- Esta rodada: ${money(summary.runSpentUsd)} (teto da rodada informado no comando; o gasto é o do livro, com o pior caso cobrado nas chamadas que falharam sem usage).`,
    `- Acumulado da phase (livro, com a sonda do passo 1 de ${money(OPENING_ENTRY.costUsd)}): ${money(summary.phaseSpentUsd)} de ${money(summary.phaseCapUsd)}.`, '');
  return lines.filter((line, index) => line !== '' || lines[index - 1] !== '').join('\n') + '\n';
}

// ----------------------------------------------------------------------------------------------------------------------------------------------------------------
// Borda da CLI
// ----------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Mensagens seguras por código estável: a causa externa (provedor, banco, chave) nunca atravessa esta borda. */
const MESSAGES: Record<string, string> = {
  BENCH_KEY_MISSING: 'Defina AION_VALIDATE_PROVIDER_KEY no ambiente ou em .env.provider (arquivo ignorado pelo Git) antes da rodada real.',
  BENCH_ARGUMENT_INVALID: 'Argumento inválido. Use --mode real|offline, --set optimization|held-out|all, --repeats, --concurrency, --only a,b, --run-cap, --report, --label, --final-gate, --ledger e --transcripts.',
  BENCH_HELD_OUT_BEFORE_GATE: 'Os casos separados só rodam no gate final (passo 16): use --final-gate apenas lá.',
  BENCH_LEDGER_CORRUPT: 'O livro de gasto está ilegível: não rode nada até conferi-lo (ele impede gastar acima do teto).',
  BENCH_BUDGET_EXCEEDED: 'O teto de gasto foi alcançado: o banco parou.',
  BENCH_FAILED: 'Não foi possível concluir o banco de testes. Confira a chave no ambiente e a disponibilidade do provedor.',
};

/** Opções da CLI (allowlist; o erro nunca ecoa o argumento recebido). */
export interface CliOptions extends BenchOptions { mode: 'real' | 'offline'; runCapUsd: number; report: string | null; label: string; ledger: string; transcripts: string | null }

/** Lê e valida os argumentos da CLI. */
export function parseCli(args: readonly string[]): CliOptions {
  const flags = new Set(['--final-gate']);
  const values = new Map<string, string>();
  let finalGate = false;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]!;
    if (flags.has(key)) { finalGate = true; continue; }
    const value = args[index + 1];
    if (!['--mode', '--set', '--repeats', '--concurrency', '--only', '--run-cap', '--report', '--label', '--ledger', '--transcripts'].includes(key) || value === undefined || values.has(key)) throw new Error('BENCH_ARGUMENT_INVALID');
    values.set(key, value);
    index += 1;
  }
  const integer = (key: string, fallback: number, min: number, max: number): number => {
    const raw = values.get(key);
    if (raw === undefined) return fallback;
    if (!/^\d{1,4}$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new Error('BENCH_ARGUMENT_INVALID');
    return Number(raw);
  };
  const mode = values.get('--mode') ?? 'real';
  const set = values.get('--set') ?? 'optimization';
  if ((mode !== 'real' && mode !== 'offline') || (set !== 'optimization' && set !== 'held-out' && set !== 'all')) throw new Error('BENCH_ARGUMENT_INVALID');
  const runCap = values.get('--run-cap') === undefined ? BASELINE_RUN_CAP_USD : Number(values.get('--run-cap'));
  if (!Number.isFinite(runCap) || runCap <= 0 || runCap > PHASE_CAP_USD) throw new Error('BENCH_ARGUMENT_INVALID');
  const only = values.get('--only')?.split(',').filter(Boolean) ?? [];
  if (only.some((id) => !/^[a-z0-9-]{1,60}$/.test(id))) throw new Error('BENCH_ARGUMENT_INVALID');
  return {
    mode, set, finalGate, repeats: integer('--repeats', 1, 1, 400), concurrency: integer('--concurrency', 3, 1, 8), only, runCapUsd: runCap,
    report: values.get('--report') ?? null, label: values.get('--label') ?? 'rodada', ledger: values.get('--ledger') ?? DEFAULT_LEDGER_FILE, transcripts: values.get('--transcripts') ?? null,
  };
}

/** Imprime uma linha JSON no stdout: o único canal de saída (só identificadores e números). */
const write = (line: Record<string, unknown>): void => { process.stdout.write(`${JSON.stringify(line)}\n`); };

/** Ponto de entrada: valida, exige a chave no modo real, sobe o PostgreSQL de teste, roda o conjunto, mede o catálogo, grava o relatório e imprime o resumo. */
async function main(): Promise<void> {
  try {
    const options = parseCli(process.argv.slice(2));
    const apiKey = options.mode === 'real' ? process.env.AION_VALIDATE_PROVIDER_KEY?.trim() : `offline-bench-${randomUUID()}`;
    if (!apiKey) throw new Error('BENCH_KEY_MISSING');
    const ledger = SpendLedger.open({ file: options.mode === 'real' ? options.ledger : null, runCapUsd: options.runCapUsd });
    const postgres = await startTestPostgres();
    const sandbox = await startFakeSandbox();
    sandbox.handler = calcSandboxHandler;
    try {
      const provider = options.mode === 'real' ? createOpenCodeGoClient({ baseUrl: (process.env.AION_OPENCODE_GO_BASE_URL ?? 'https://opencode.ai/zen/go/v1').replace(/\/+$/, ''), chatTimeoutMs: 180_000 }) : null;
      const env: BenchEnv = { mode: options.mode, adminUrl: postgres.adminUrl, provider, apiKey, ledger, sandbox, runTimeoutMs: options.mode === 'real' ? 10 * 60_000 : 30_000, usageMultiplier: 1, transcriptsDir: options.transcripts ? resolve(options.transcripts) : null };
      const catalog = await measureCatalog(env);
      const summary = await runBench(options, env);
      for (const result of summary.results) write({
        event: 'case', id: result.caseId, repeat: result.repeat, pass: result.pass, cut: result.cut, checksOk: result.checks.filter((check) => check.ok).length, checks: result.checks.length, error: result.error, calls: result.cost.calls,
        inputTokens: result.cost.inputTokens, cachedTokens: result.cost.cachedTokens, outputTokens: result.cost.outputTokens, afterOpenCalls: result.afterOpen.calls, afterOpenInputTokens: result.afterOpen.inputTokens,
        afterOpenCachedTokens: result.afterOpen.cachedTokens, costUsd: Number(result.cost.usd.toFixed(6)), wallMs: result.wallMs,
        // Falhas de ferramenta por código do envelope (A21), só identificadores e contagens: é o que atribui a falha de `abrir_grupo` ou `run_python` a um caso.
        toolFailures: Object.fromEntries(Object.entries(result.toolStats).filter(([, stat]) => stat.failed > 0).map(([tool, stat]) => [tool, { failed: stat.failed, ok: stat.ok, codes: stat.codes }])),
        // Chamadas que pararam em aprovação, por ferramenta (contagem): o relatório as separa das concluídas e das falhas.
        toolsWaiting: Object.fromEntries(Object.entries(result.toolStats).filter(([, stat]) => stat.waiting > 0).map(([tool, stat]) => [tool, stat.waiting])),
      });
      const total = aggregate(summary.results);
      write({ event: 'result', runs: total.runs, passed: total.passed, cut: total.cut, accuracy: total.runs ? Number((total.passed / total.runs).toFixed(4)) : null, costUsd: Number(total.cost.usd.toFixed(6)), runSpentUsd: Number(summary.runSpentUsd.toFixed(6)), phaseSpentUsd: Number(summary.phaseSpentUsd.toFixed(6)), phaseCapUsd: summary.phaseCapUsd, repeatsPlanned: summary.repeatsPlanned, repeatsRun: summary.repeatsRun, reducedForCap: summary.reducedForCap, budgetStopped: summary.budgetStopped });
      if (options.report) {
        mkdirSync(dirname(resolve(options.report)), { recursive: true });
        writeFileSync(resolve(options.report), formatReport(summary, { title: 'Banco de testes do Aion: relatório', label: options.label, catalog, generatedAt: new Date().toISOString() }));
      }
      if (summary.budgetStopped) process.exitCode = 1;
    } finally { await sandbox.stop(); await postgres.stop(); }
  } catch (error) {
    const code = error instanceof Error && error.message in MESSAGES ? error.message : 'BENCH_FAILED';
    const detail = error instanceof ChatRejected ? { status: error.status } : error instanceof ChatStreamError ? { errorName: error.name } : {};
    process.stderr.write(`${JSON.stringify({ code, message: MESSAGES[code], exitCode: 1, ...detail })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();

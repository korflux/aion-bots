// Executa UMA execução (run) de um bot ou de uma sessão do chat geral do começo ao fim: chama o modelo etapa por etapa, executa as
// ferramentas que ele pedir e grava tudo na linha do tempo da conversa. Quem escolhe QUAL execução rodar (fila, ordem, paralelismo) é o
// `RunEngine`; este arquivo só conhece a execução que recebeu.
//
// Sessão do chat geral (T12): a execução tem `bot_id` nulo e roda pelo MESMO caminho, com quatro diferenças, todas decididas pelo `bot_id`
// nulo: o contexto usa a variante do chat geral com só a memória global (sem nome, instruções nem memória de bot) e a rodada derivada
// "Novo chat aberto" (CTX-01), as ferramentas `botOnly` (editar memória e propor rotina) não existem para o modelo, e o limite de chamadas é o
// padrão (`BOT_STEP_LIMIT_DEFAULT`), já que não há bot que o configure.
// A aprovação resolve só a regra global (ver `ApprovalService.resolve`).
//
// Estado e retomada (spec: "estado persistido após cada etapa"): nada relevante vive só em memória. A cada etapa o contexto é
// reconstruído do banco (`loadContext`), o texto é gravado aos poucos e cada chamada de ferramenta é gravada antes e
// depois de executar. Se o worker cai, a execução mantém `status = running` com o `lease_until` vencendo; outro worker a
// reivindica e chama `recover()`, que descarta o texto parcial e fecha as chamadas que ficaram sem resultado, e segue do
// ponto em que parou (o contador de chamadas e o tempo ativo também estão no banco).
//
// Limites (spec decisão 12): `tool_calls <= step_limit` do bot (lido a cada etapa, então editar o bot vale na etapa
// seguinte) e 15 minutos de TEMPO ATIVO, contando só o tempo em que o worker trabalha. Uma chamada que passaria do limite
// não é executada: a execução encerra como `limit_reached` com o relatório do que foi concluído.
//
// Por que uma única parada: tudo que interrompe a execução (parada do dono, prazo, worker encerrando, stream mudo, posse
// perdida) passa por `abortWith(motivo)`, que aborta a chamada ao modelo e registra o motivo. O laço lê o motivo e decide o
// desfecho; só o desfecho `released` (worker encerrando) NÃO é terminal.
//
// Aprovação (T7, spec decisões 7 a 9 e F9): toda ação EXTERNA (ferramenta do Composio) tem a regra resolvida ANTES de qualquer
// efeito (`executeCall`). `allow` executa com a prova de aprovação; `deny` não executa; `ask` PAUSA a execução: numa transação
// grava a atividade (aguardando), o pedido com a chamada e as que vinham depois dela, e o cartão, põe a execução em
// `waiting_approval` e devolve a posse. O worker fica livre e o tempo ativo não corre. Quando o dono responde (ou pede parada),
// o motor reivindica a execução de volta e `drive()` começa tratando a decisão (`takeApprovalDecision` + `applyDecision`): executa
// ou recusa a MESMA chamada, roda as restantes da etapa e só então volta ao laço do modelo, ou seja, retoma do ponto exato.
//
// Conector por níveis (T29): o modelo chama `composio_execute_action({ action, arguments })`, a "porta" do Composio, e quem executa é a AÇÃO. Logo no
// começo de `executeCall` a chamada da porta vira a da ação (`toRunnableCall`: nome = slug da ação, argumentos = os internos, `via` = o nome da porta), e
// dali em diante tudo é por ação, como se o modelo a tivesse chamado: portão de aprovação, atividade, cartão, auditoria e retomada. O `via` fica na
// atividade e no pedido para o contexto do modelo continuar contando a chamada como ele a fez (ver `buildTurns`) e para a retomada reencontrar a ação.
// O Chat geral não tem conector (CONN-02, phase 13, decisão 4): `connectorTools` o tira da execução sem bot e `applyDecision` recusa a aprovação de ação do conector
// que ficou pendente de antes dessa mudança.
// Contas do conector por bot (CONN-02, decisões 2, 3 e 8): as definições e o destino da porta são resolvidos POR BOT (`connectorTools`, `target`), e a conta em que a ação age é conferida contra
// as liberações do banco a cada execução e a cada retomada. `executeCall` resolve a conta pelo NOME que o modelo escreveu na porta e a grava na chamada pendente (`RunnableCall.account`);
// `applyDecision` a reconfere pelo ID. Recusa de conta (`AccountRefusal`) não chama o Composio, volta ao modelo como resultado de ferramenta e é auditada como `composio.action` negada.
// A regra de aprovação segue por AÇÃO e vale para todas as contas do bot (decisão 3): a conta só aparece onde o dono decide, no cartão e em "Aguardando você" (`accountLabel`, do rótulo
// gravado na chamada pendente), e o histórico do modelo reconstrói a chamada da porta com o nome que ele escreveu (`RunnableCall.accountName`, gravado na atividade; ver `buildTurns`).
//
// Porta `use_tool` (phase 15, passo 9; decisões 21 e 30): a mesma mecânica de porta (`unwrap` e `target`), com o alvo sendo uma ferramenta do mapa filtrado da execução (`useToolPort`, `tool-discovery.ts`) e o `via` da atividade
// igual a `use_tool`. O portão lê as flags e a `action` do ALVO, nunca da porta (E1); a retomada reencontra o alvo no mesmo mapa (`resumedTarget`, nunca no Composio) e confere o nome e a ação reencontrados contra os do pedido
// aprovado (`DecidedApproval.actionSlug`, E3): a resposta do dono vale só para a ação que ele viu. A auditoria do conector chama a base da aprovação de `basis`, para não colidir com o `via` da atividade (E5).
//
// Push (T10): o desfecho e a pausa para aprovação gravam, NA MESMA transação, o evento na caixa de saída dos pushes
// (`enqueuePushEvent`); quem os envia é o `PushDispatcher` do worker. Concluída e falha (inclusive o limite) avisam; a parada do dono não.
//
// Complemento (phase 4, CONV-03): antes de CADA chamada ao modelo (também a primeira e a que vem depois da retomada de uma aprovação, já com a
// decisão e as chamadas restantes executadas), `absorbComplements` lê os complementos pendentes como mensagens do dono da rodada atual. O
// desfecho promove ou devolve os que sobraram na mesma transação (`settleComplementsAtEnd`). As regras moram em `conversation/complements.ts`.
//
// Contexto e compactação (phase 9, CTX-07 a CTX-10): o pedido de cada etapa leva o histórico COMO FOI GRAVADO e só cresce no fim; o resultado de ferramenta já chega
// limitado numa forma estável (`context.ts`). A ocupação é medida por uma conta única, ancorada no usage real (`context-anchor.ts`); ao chegar a 90% do orçamento de
// entrada (`COMPACTION_THRESHOLD`) `compactContext` troca o histórico antigo por UM checkpoint estruturado e mantém íntegro o trecho final (`compaction.ts`), inclusive
// dentro da rodada atual. Se o resumo falhar ou o pedido ainda passar de 100%, o colapso em índice de `context-collapse.ts` segura o pedido sem chamada ao modelo: a
// execução nunca falha só porque o resumo falhou. Uma recusa de contexto do provedor antes de qualquer saída repete UMA vez, com compactação forçada (`modelStep`).
// Bloco `# Dados` (PERF-01, phase 10): o modelo, o "Agora" e o fuso de cada rodada são gravados UMA vez em `runs.request_data` na primeira preparação da execução que a responde
// (`ensureRequestData`) e reenviados iguais em toda etapa, retomada (aprovação, reinício) e rodada seguinte (`loadRequestData`, `context.ts`): a hora nunca é lida de novo.
// Se o dono troca o modelo, a janela ou o effort no meio da preparação, a etapa é preparada de novo UMA vez com a configuração vigente (`reprepareStep`, A15); só uma
// segunda troca na mesma etapa falha, com `CONTEXT_CONFIGURATION_CHANGED`. `CONTEXT_COMPACTION_FAILED` fica restrito à compactação.
// Conversa fria (phase 11, T7): com nenhuma chamada ao modelo há mais de T e nenhuma execução ativa ou na fila, o cache do provedor provavelmente já se perdeu (T fica acima do maior intervalo medido com cache válido, 30 minutos, e o cache estava morto em 60: `COLD_AFTER_MS`) e o pedido pode enxugar sem custo na prática:
// o laço do worker (`ColdMaintenance`) grava a limpeza fria, e a ABERTURA da primeira etapa de uma execução (`maskColdOnOpening`) faz o mesmo se o laço ainda não passou, sem chamar
// o modelo. É a única exceção, junto com a compactação, à regra de que o pedido só cresce no fim; com a conversa quente nada muda (`cold-maintenance.ts`).
// Compactação fria (phase 11, T8, F5): depois da limpeza, o worker enfileira na fila FIFO da conversa uma manutenção de contexto sem sessão do dono (`enqueueColdCompaction`); esta
// classe a executa como o "Compactar agora" (`maintainContext`, `modelStep`), com o gatilho próprio `cold` (ocupação a partir de `coldTriggerTokens`, recusa registrada obedecida) e um
// desfecho que nunca aparece para o dono: a execução fria termina sempre concluída (`finish`), sem cartão, push nem bolinha.
import { randomUUID } from 'node:crypto';
import { BOT_STEP_LIMIT_DEFAULT, ERROR_CODES, type ActivityDetail, type ApprovalImpact, type ArtifactRef, type AttachmentKind, type ErrorCode, type LanguageCode, type PushEventKind, type SystemCard } from '@aion/shared';
import { grantApprovalProof, type ApprovalProof } from '../approvals/proof';
import { NOT_EXECUTED_RESULTS, type ActionInfo, type ApprovalService, type DecidedApproval } from '../approvals/service';
import { recordAudit, type AuditOutcome } from '../audit';
import { absorbComplements, settleComplementsAtEnd } from '../conversation/complements';
import { recordConversationEvent } from '../conversation/events';
import { resolveModelChoice } from '../conversation/model-choice';
import type { ActivityData, RunRow } from '../conversation/views';
import type { CredentialService } from '../credentials/service';
import type { ProviderClient } from '../credentials/opencode-go';
import { withTransaction, type Pool, type PoolClient, type Queryable } from '../db/pool';
import { DomainError } from '../errors';
import { databaseErrorForLog, type Logger } from '../logging';
import { resolveConversationContextWindow } from '../conversation/context-window';
import { estimateChatPayload, contextEnvelope, fitToolCatalog, withCatalogOmissions, lowestEffort, CATALOG_SHARE, COMPACTION_SETTLE, COMPACTION_THRESHOLD, MAX_OUTPUT_TOKENS, SUMMARY_MAX_OUTPUT_TOKENS, TAIL_SHARE, visualCostKnown } from './context-budget';
import { collapseHistory, fitByCollapse, historyUnits, type CollapseStanding } from './context-collapse';
import { MIN_SCALE, readTokenCalibration, recordUsageEstimate } from './token-calibration';
import { anchoredInputTokens, readContextAnchor } from './context-anchor';
import { coldTailTokens, coldTriggerTokens, maskColdResults, readMostUsedAnchor } from './cold-maintenance';
import { CHECKPOINT_TYPICAL_BYTES, coveredImpression, cutHistory, fitSummaryInput, judgeSummary, recordSummaryRefusal, rowTokens, summaryGivenUp, summaryPrompt, summaryRefusalKnown, summaryUserText, SUMMARY_RETRY_SHARES, type SummaryFailure, type SummaryInput, type SummaryReminder } from './compaction';
import { readTableRemovalReceipt } from '../tables/removal-receipt';
import { aggregateContextUsage, readContextRevision, settleMeasurementAfterResponse } from '../conversation/context-state';
import { readBotObjective } from '../bots/objectives';
import { loadContextMemories } from '../memory/service';
import { ProviderRateLimited } from '../credentials/upstream-http';
import { ChatRejected, ChatStreamError, type ChatEvent, type ChatRequest, type ChatUsage, type ChatProtocol, type ChatToolCall, type ChatTurn } from '../models/chat-protocols';
import { modelCredentialKind, type ModelService } from '../models/service';
import { enqueuePushEvent } from '../push/outbox';
import { settleRoutineRunCard } from '../routines/run-card';
import { readAppSettings, resolveSummaryModel } from '../settings/service';
import { READ_ATTACHMENT_TOOL, RESULT_PAGE_MAX_BYTES, readAttachmentArgsSchema } from './read-attachment';
import { RUN_PYTHON_TOOL } from './run-python';
import { buildSystemText, buildTurns, clipResult, currentDataBlock, formatCount, loadAttachmentContext, loadRequestData, measureRequest, type ConnectorActivityData, type ContextAttachment, type ContextRow } from './context';
import { accountAudit, COMPOSIO_EXECUTE_TOOL, COMPOSIO_SEARCH_TOOL, type ComposioToolSource } from './composio-tools';
import { LeaseLostError, holdLease } from './lease';
import { loadManagedContext, reserveModelSources, validCheckpoint, coverageFingerprint, contextFingerprint, requestBlockHashes, commitContextSummary, startModelUsage, finishModelUsage, SUMMARY_MAX_CHARS, type ContextCheckpoint } from './context-checkpoint';
import { mergeEvidence, parseEvidence, attachmentEvidence, validateEvidence, type EvidenceProvenance } from './evidence-provenance';
import { DOC_DELETE_TOOL, docRemovalConfirmed, readDocRemovalReceipt } from './doc-tools';
import { TextWriter } from './text-writer';
import { AccountRefusal, ToolFailure, failureEnvelope, failureResult, toolFailure, type PreparedCall, type ToolAccount, type ToolHandler, type ToolOutcome, type ToolTargetRequest } from './tools';
import type { WebToolSource } from './web-tools';
import { activityReadTool } from './activity-read';
import { ABRIR_GRUPO, abrirGrupoTool, assertRuntimeToolNames, discoveryTool, DISCOVER_TOOLS, readToolSelectionHistory, resolveMostUsed, selectCatalog, selectedBeforeCut, treeIndex, USE_TOOL, useToolPort, type ToolSelectionHistory } from './tool-discovery';

/** Tempos e tamanhos do motor. Os padrões são os da spec; os testes encurtam para provar cada limite sem esperar. */
export interface RunEngineConfig {
  /** De quanto em quanto tempo o dispatcher procura execução para iniciar ou retomar. */
  pollMs: number;
  /** Validade da posse de uma execução; vencida sem renovação, outro worker a retoma. */
  leaseMs: number;
  /** Renovação da posse, leitura do pedido de parada e gravação do tempo ativo. */
  heartbeatMs: number;
  /** Intervalo de gravação do texto em streaming. */
  flushMs: number;
  /** Execuções simultâneas por processo (bots diferentes rodam em paralelo). */
  maxConcurrentRuns: number;
  /** Tempo ativo máximo de uma execução (spec decisão 12: 15 minutos). */
  maxActiveMs: number;
  /** Silêncio máximo do modelo durante uma etapa; acima disso a etapa falha como erro do provedor. */
  streamIdleMs: number;
  /** Teto BASE de tokens de saída por etapa: o valor enviado ao provedor é a `outputReserve` de `contextEnvelope`, que ainda o limita a 25% da janela efetiva e à capacidade de saída confirmada do modelo. */
  maxTokens: number;
  /** De quanto em quanto tempo a varredura encerra os pedidos de aprovação vencidos (24 h sem resposta). */
  approvalSweepMs: number;
}

export const DEFAULT_RUN_CONFIG: RunEngineConfig = {
  pollMs: 500,
  leaseMs: 30_000,
  heartbeatMs: 1_000,
  flushMs: 250,
  maxConcurrentRuns: 10,
  maxActiveMs: 15 * 60_000,
  streamIdleMs: 180_000,
  maxTokens: MAX_OUTPUT_TOKENS,
  approvalSweepMs: 10_000,
};

export interface ExecutorDeps {
  pool: Pool;
  credentials: Pick<CredentialService, 'requireKey'>;
  provider: ProviderClient;
  /** Teste sob demanda de um modelo que ainda não tem protocolo gravado (definido por API, sem passar pelo seletor). */
  models: Pick<ModelService, 'test'> & Partial<Pick<ModelService, 'warmCapacity'>>;
  /** Ferramentas internas (sempre oferecidas). As do Composio vêm de `composio`, por execução. */
  tools: ReadonlyMap<string, ToolHandler>;
  /** Regras e pedidos de aprovação (única porta de escrita deles). */
  approvals: ApprovalService;
  /**
   * Fonte das ferramentas do Composio; ausente, o bot só tem as internas. As definições e as contas são POR BOT (`load(botId)`); a execução sem bot (Chat geral) nunca a usa (`RunExecutor.connectorTools`).
   * `resolveTarget` é o destino da porta sem passar pelas definições publicadas: a retomada após aprovação precisa dele quando o bot já não tem conta liberada e ativa (`resumedTarget`).
   */
  composio?: Pick<ComposioToolSource, 'load' | 'resolveTarget'>;
  /** Fonte de `web_search` e `web_fetch` (T9): oferecidas com a pesquisa ligada em Configurações; ausente, o bot não tem pesquisa na web. */
  web?: Pick<WebToolSource, 'load'>;
  /**
   * O bot publica as "mais usadas" ao lado das portas (phase 15, decisões 23 e 24): até 5 pelo uso dele nos últimos 30 dias, a lista padrão do Aion num bot novo, recalculadas só quando a conversa esfria e a cada
   * compactação aplicada (`RunExecutor.refreshMostUsed`). Falso (`coreCatalog` desligado, só nos testes de pressão de contexto), o bot publica só as portas. O Chat geral não usa isto.
   */
  publishMostUsed: boolean;
  logger: Logger;
  now: () => Date;
  config: RunEngineConfig;
}

type AbortReason = 'stop' | 'deadline' | 'shutdown' | 'lease_lost' | 'idle';

/**
 * Como a execução termina. Dois desfechos NÃO são terminais: `released` (worker encerrando: outro retoma) e `waiting_approval`
 * (a execução pausou esperando o dono; a transação da pausa já gravou tudo, e o motor a retoma quando houver decisão).
 */
type Outcome =
  | { status: 'completed' }
  | { status: 'interrupted' }
  | { status: 'limit_reached'; limit: 'steps' | 'time' | 'tokens'; cardId?: string }
  | { status: 'failed'; code: ErrorCode }
  | { status: 'released' }
  | { status: 'waiting_approval' };

type TerminalOutcome = Exclude<Outcome, { status: 'released' } | { status: 'waiting_approval' }>;

/**
 * Evento de push de cada desfecho (T10). Concluída e falha avisam; `limit_reached` é falha (a spec: "push de falha" no limite de
 * etapas ou de tempo); a parada pelo dono NÃO avisa, porque foi o próprio dono que a pediu e já está olhando.
 */
const PUSH_KIND_OF_OUTCOME: Record<TerminalOutcome['status'], PushEventKind | null> = {
  completed: 'run_completed',
  failed: 'run_failed',
  limit_reached: 'run_failed',
  interrupted: null,
};

/** Histórico lido do banco para uma preparação de contexto (ver `RunExecutor.loadContext`); `renderTurns` o transforma nos turnos do pedido sem novo IO. */
interface LoadedContext {
  system: string;
  objectiveTurns: ChatTurn[];
  /** O checkpoint válido como turno de usuário rotulado (estado do runtime), ou nulo sem checkpoint. */
  checkpointTurn: ChatTurn | null;
  /** Linhas que o resumo válido ainda não cobre, na ordem da conversa. */
  visibleRows: ContextRow[];
  /**
   * Quantas das primeiras `visibleRows` ficam ANTES do checkpoint: as linhas íntegras que antecedem a última linha coberta (a abertura da rodada atual e os
   * complementos do dono que o corte manteve no meio do histórico coberto). O checkpoint entra logo depois delas; o resto, o trecho final, vem depois do checkpoint.
   */
  checkpointAt: number;
  /**
   * Até onde o checkpoint vigente cobre: o maior `messages.id` coberto (nulo sem checkpoint válido). É o corte do catálogo de ferramentas (phase 12, F2): o corte do checkpoint válido é relido a
   * CADA preparação, e só as opcionais selecionadas até ele podem sair do campo `tools` (`selectedBeforeCut`); sem checkpoint, nada sai. Na prática isso acontece numa compactação aplicada, que
   * move o corte, e na rede de segurança do executor, que tira as opcionais só do pedido que não caberia de outra forma. Caso de borda aceito: uma troca de modelo ou de janela que reduz o
   * orçamento, ou um checkpoint que volta a valer, muda o resultado da conta do teto (ou o corte) sem compactação nova, e o campo `tools` muda uma vez nesse ponto.
   */
  coveredThrough: string | null;
  readImages: ContextAttachment[];
  omitNewChatMarker: boolean;
}

/**
 * Variações do mesmo histórico: inteiro, com o começo colapsado em índice (ver `context-collapse.ts`) ou com o texto dos anexos das mensagens que seguem no pedido trocado
 * por referência (`attachmentsAsReferences`, último degrau do colapso). Resultados e argumentos de ferramenta entram sempre como gravados (`buildTurns`, CTX-10).
 * `historyImages`: o custo visual do modelo é conhecido (`visualCostKnown`), então as imagens de rodadas anteriores seguem inline; senão só a da rodada atual vai (T10).
 */
interface RenderOptions {
  acceptsImages: boolean;
  historyImages: boolean;
  readAttachmentRefs: boolean;
  attachmentsAsReferences?: boolean;
  collapse?: { units: number; lines: number };
}

/** Protocolo, níveis de effort e capacidade de imagem gravados no teste do modelo (ver `RunExecutor.modelProfile`). Sem teste gravado, o protocolo é o palpite padrão. */
interface ModelProfile { status: string | null; protocol: ChatProtocol; levels: string[]; acceptsImages: boolean }

/** Uma etapa do modelo já concluída: o texto foi gravado e as chamadas de ferramenta (se houver) estão por executar. */
interface StepResult {
  step: number;
  calls: ChatToolCall[];
}

/** Desfecho de `modelStep`: a etapa concluída, um desfecho da execução ou a continuação automática depois de um corte de saída. */
type StepOutcome = StepResult | Outcome | { continueAutomatically: true };

/**
 * A manutenção de contexto que uma execução sem rodada faz: `summarize` é o gesto do dono ("Compactar agora", gatilho `manual`: compacta sempre, ignora a recusa registrada e,
 * se nada se aplica, falha para ele ver) e `cold` é a compactação fria do worker (gatilho `cold`: só a partir de `coldTriggerTokens` do orçamento, obedece a recusa
 * registrada, mantém um trecho final menor, `coldTailTokens`, e nunca aparece para o dono). `maintainContext` escolhe pela linha de `context_maintenance` (sem sessão = fria).
 */
type MaintenanceKind = 'summarize' | 'cold';

/**
 * A configuração do contexto (modelo, janela ou effort) mudou no meio da preparação da etapa (A15)? É o único erro que `modelStep` resolve preparando de novo, uma vez
 * (`reprepareStep`); a segunda ocorrência na mesma etapa vira o desfecho `CONTEXT_CONFIGURATION_CHANGED`.
 */
const isConfigurationChange = (error: unknown): boolean => error instanceof DomainError && error.code === 'CONTEXT_CONFIGURATION_CHANGED';

/** Resumo visual dos argumentos (a tela); o contexto do modelo usa os argumentos íntegros (`tool_arguments`). */
const ARGUMENTS_MAX_CHARS = 8_000;
const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}… [truncado]` : text);
/**
 * Teto da GRAVAÇÃO do resultado de uma ferramenta sem limite próprio (CTX-10, spec decisão 8): 256 KiB em UTF-8. Antes o resultado era cortado em 8.000
 * caracteres ANTES de gravar e o excedente se perdia; agora o íntegro fica em `messages.content` (a tela, `search_history` e `read_activity` com part=original o leem) e o que
 * vai ao modelo é limitado uma única vez no pedido, a 12.000 caracteres e com o id e o offset para continuar a mesma forma em `read_activity` (`resultForModel` em `context.ts`).
 */
const RESULT_STORE_MAX_BYTES = 256 * 1024;
/**
 * Ferramentas cujo resultado já sai limitado por regra própria e não pode ser cortado de novo na GRAVAÇÃO: a página do anexo (marcas de segurança no fim), o
 * `run_python` (saída até 20.000 caracteres com aviso de corte e a lista dos arquivos gerados depois dela, Suposição 25) e o `table_query` (envelope JSON de até 64 KiB,
 * recusado acima disso com `TABLE_QUERY_LIMIT`; cortado em texto deixaria de ser JSON). A constante vale SÓ para a gravação e a tela (`limitsOwnResult`): no PEDIDO ao modelo
 * todas as ferramentas passam pelo mesmo teto de 12.000 caracteres (`resultForModel`, `context.ts`).
 */
const SELF_LIMITED_RESULTS: ReadonlySet<string> = new Set([READ_ATTACHMENT_TOOL, RUN_PYTHON_TOOL, 'table_query']);

/**
 * A ferramenta limita o próprio resultado (envelope íntegro declarado em `resultLimitBytes`, ou o corte próprio de `SELF_LIMITED_RESULTS`)? Se sim, a GRAVAÇÃO não o corta
 * (`limitStoredResult`) e a tela mostra o envelope inteiro. A exceção vale só aí: no PEDIDO ao modelo (phase 11, CTX-10) toda ferramenta passa pelo mesmo teto de 12.000
 * caracteres (`resultForModel`, `context.ts`), com a forma própria de cada uma, sem consultar esta regra.
 */
const limitsOwnResult = (name: string, handler: ToolHandler | undefined): boolean => Boolean(handler?.resultLimitBytes) || SELF_LIMITED_RESULTS.has(name);

/** Exclusão confirmada por recibo durável (tabela ou doc), que o fechamento da atividade revalida e de cuja evidência o recurso excluído sai (`settleActivity`). */
type ConfirmedRemoval = NonNullable<ToolOutcome['confirmedTableRemoval'] | ToolOutcome['confirmedDocRemoval']>;

/**
 * Resultado como é gravado (CTX-10): íntegro até `RESULT_STORE_MAX_BYTES`; acima disso a gravação é cortada e o aviso informa o tamanho original. O limite é em
 * bytes UTF-8 mas o corte cai sempre numa fronteira de caractere (nunca parte um emoji) e, por `clipResult`, nunca deixa um bloco de conteúdo não confiável sem
 * fechamento. O aviso traz o texto "[truncado]" que `read_activity` e as referências já reconhecem como conteúdo incompleto. O corte é um prefixo do original
 * (a introdução da ferramenta, se houver, segue como veio): vale 256 KiB de conteúdo mais o aviso e, se o corte cair dentro de um bloco não confiável, o
 * fechamento dele.
 * ponytail: o corte é por caractere e não pela estrutura do resultado (JSON de uma ação do conector fica sem fechar), tratar por formato só se ações
 * acima de 256 KiB passarem a ser frequentes.
 */
function limitStoredResult(result: string): string {
  if (Buffer.byteLength(result, 'utf8') <= RESULT_STORE_MAX_BYTES) return result;
  const bytes = Buffer.from(result, 'utf8');
  // Um byte de continuação (10xxxxxx) na posição do corte significa que ela cai no meio de um caractere: recua até o começo dele.
  let end = RESULT_STORE_MAX_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  const maxChars = bytes.subarray(0, end).toString('utf8').length;
  return clipResult(result, maxChars, (_shown, total) => `[truncado] gravação cortada em 256 KiB: o resultado original tinha ${formatCount(total)} caracteres.`);
}


/**
 * Desfechos do SISTEMA (reinício, parada do dono, recusa do portão): ficam em texto puro porque o histórico os reconhece por igualdade (`safeOutcome`, abaixo) e porque não são falha de uma ferramenta,
 * que é sempre o envelope `{ code, message }` (`failureResult`, A21). Não os converta em envelope sem tratar as linhas já gravadas.
 */
const INTERRUPTED_BY_RESTART = 'A chamada foi interrompida por um reinício do serviço antes de devolver o resultado.';
/** Ação externa interrompida por reinício: o pedido pode ter chegado ao Composio, então o bot confirma antes de repetir. */
const INTERRUPTED_EXTERNAL_BY_RESTART = `${INTERRUPTED_BY_RESTART} A ação pode ter sido concluída. Confirme o efeito antes de repetir.`;
const INTERRUPTED_EXTERNAL = 'Interrompida pelo dono. A ação pode ter sido concluída.';
/** Ferramenta externa que chegou ao executor sem `action`: não há regra a resolver, então não executa (falha fechada, C4). */
const EXTERNAL_WITHOUT_ACTION = 'Ferramenta externa sem regra de aprovação definida. Ela não foi executada.';
/**
 * Aprovação de ação do conector que ficou pendente no Chat geral de antes da phase 13 (CONN-02, A7): o Chat geral não tem conector, então a ação não executa nem com o "permitir" do
 * dono. É o resultado de ferramenta que o modelo lê, no mesmo tom de `NOT_EXECUTED_RESULTS`.
 */
const CONNECTOR_REFUSED_IN_GENERAL_CHAT = 'Ação recusada: o Chat geral não usa conectores. Ela não foi executada.';
/** A retomada de uma aprovação reencontrou outra ação que a aprovada (E3, A28): o resultado que o modelo lê, no tom de `NOT_EXECUTED_RESULTS`. */
const ACTION_CHANGED_RESULT = 'A ação mudou depois do pedido de aprovação e a aprovação não vale para ela. Ela não foi executada.';

/**
 * A chamada a uma ferramenta (ou ação do conector) que não existe para esta execução (A16): diz o nome que o modelo escreveu, já limpo (só letras, números e `_ . : -`, até 64 caracteres, para um nome
 * hostil nunca entrar no envelope) e o caminho certo. A ferramenta que falta se carrega pela descoberta (`abrir_grupo` e `use_tool` no bot, `discover_tools` no Chat geral); a ação do conector se acha pela busca.
 * `via` é a porta pela qual a chamada veio: só a do conector (`composio_execute_action`) fala de ação e de busca; a `use_tool` e a chamada direta têm o mesmo texto de ferramenta desconhecida, que
 * não distingue o inexistente do filtrado (um alvo `botOnly` no Chat geral responde igual a um nome inventado, E2). Fonte única das mensagens: a execução e a retomada de uma aprovação.
 */
function unknownCallFailure(name: string, via: string | undefined, bot: boolean): ToolFailure {
  const shown = name.replace(/[^\w.:-]/gu, '?').slice(0, 64);
  return via === COMPOSIO_EXECUTE_TOOL
    ? toolFailure('ACTION_NOT_FOUND', `Ação desconhecida: ${shown}. Busque com ${COMPOSIO_SEARCH_TOOL} e use o slug exato.`)
    : toolFailure('TOOL_NOT_FOUND', bot
      ? `Ferramenta desconhecida: ${shown}. Use só as ferramentas da sua lista; se a que procura não está nela, abra o grupo dela com ${ABRIR_GRUPO} (os caminhos estão no seu sistema) e chame-a com ${USE_TOOL}.`
      : `Ferramenta desconhecida: ${shown}. Use só as ferramentas da sua lista; se a que procura não está nela, chame ${DISCOVER_TOOLS} para ver o índice e carregá-la.`);
}

/** Uma ferramenta externa não terminou porque a execução foi interrompida; o cartão avisa que ela pode ter sido concluída. */
class ExternalInterrupted extends Error {}

/**
 * A chamada como o executor a trata: a que o modelo fez ou, quando ele chamou uma "porta" (o conector, `composio_execute_action`, ou a `use_tool`), a do DESTINO (`name` é o slug da ação ou
 * o nome da ferramenta e `arguments` os argumentos dele), com `via` dizendo por qual porta o modelo chamou. O `via` viaja na atividade e no pedido de aprovação. Não é exclusivo do conector:
 * quem precisa saber se a porta é a do conector compara com `COMPOSIO_EXECUTE_TOOL`. Não confundir com `basis` da auditoria (`auditAction`), que é a base da aprovação (regra, dono, recusa).
 */
interface RunnableCall extends ChatToolCall {
  via?: string;
  /**
   * O NOME da conta como o modelo o escreveu na porta (phase 13), só quando ele o escreveu (com uma única conta liberada o parâmetro é opcional). Resolve o destino na execução
   * (`ToolTargetRequest.accountName`) e vai à atividade (`writeActivity`), para o histórico reconstruir a chamada da porta como ele a fez (`buildTurns`). Nunca fica nos `arguments` da ação.
   */
  accountName?: string;
  /**
   * Conta do conector em que a ação age (phase 13, CONN-02), resolvida por bot na execução e gravada junto da chamada pendente: a retomada após aprovação a reconfere pelo ID contra as liberações
   * do bot (A5), e o cartão e a auditoria a mostram. Só existe depois que o destino foi resolvido; nunca carrega a chave do Composio.
   */
  account?: ToolAccount;
}

/**
 * A chamada que o executor trata: a própria, ou a da ação de destino se `front` é a "porta" de um conector e os argumentos dela servem. O nome da conta que o modelo escreveu na porta
 * (`accountName`) fica na chamada, separado dos argumentos da ação: ele nunca chega ao Composio, ao resumo do cartão nem aos argumentos gravados na atividade.
 */
function toRunnableCall(call: ChatToolCall, front: ToolHandler | undefined): RunnableCall {
  const target = front?.unwrap?.(call.arguments);
  if (!target) return call;
  return { id: call.id, name: target.name, arguments: target.arguments, via: call.name, ...(target.account === undefined ? {} : { accountName: target.account }) };
}

/** A leitura do stream do modelo foi abandonada porque a execução foi interrompida (o desfecho vem de `halted()`, não deste erro). */
class StreamInterrupted extends Error {}

/**
 * Custo estimado de uma linha no pedido, em tokens, para dimensionar o trecho final e o que a compactação alivia: o de `rowTokens` mais o bloco `# Dados` que o turno de abertura
 * da rodada leva (`ContextRow.request_data`, PERF-01 da phase 10). `rowTokens` não o conhece porque o bloco vem de `runs`, não do que está gravado na linha; sem este acréscimo
 * o lote a cobrir pareceria menor do que é (cada abertura coberta liberta o bloco junto) e a compactação seria dispensada por engano perto do limiar.
 * ponytail: o acréscimo mora aqui e não em `rowTokens` (`compaction.ts`) só porque a T1 da phase 10 não tinha esse arquivo entre os seus; mover para `rowTokens` quando `compaction.ts` puder ser editado.
 */
const costOfRow = (row: ContextRow, scale: number): number =>
  rowTokens(row, scale) + (row.opens_round && row.request_data ? Math.ceil(Buffer.byteLength(row.request_data, 'utf8') * scale) : 0);

/**
 * Turno do runtime (checkpoint ou índice do colapso) como linha sintética do papel do usuário, sem id: `buildTurns` a posiciona na ordem do pedido e a rende como
 * turno de usuário com o texto exato (sem o marcador de evidência, que exige id, e sem o bloco `# Dados`, que só vai na abertura da rodada). Usar a própria
 * `buildTurns` para o posicionamento mantém uma única regra de rodadas, anexos e `# Dados` (partir as linhas em duas chamadas separaria a abertura da rodada das linhas
 * que dependem dela, como o bloco `# Dados` e a deduplicação da leitura de um anexo).
 */
const runtimeRow = (turn: ChatTurn): ContextRow => ({ run_id: null, role: 'user', kind: 'text', status: 'done', opens_round: false, step: null, content: turn.text, data: null });

/**
 * Ordem do pedido coerente com a cronologia (phase 9, F3): o checkpoint (e, depois dele, o índice do colapso) entra logo ANTES da primeira linha íntegra que vem depois
 * da última linha coberta, ou seja, antes do trecho final. As linhas íntegras que antecedem a última coberta (a abertura da rodada atual e os complementos do dono
 * que o corte manteve no meio do histórico coberto, Decisão 3) ficam antes dele, na ordem original: o modelo nunca lê o resumo do trabalho feito por causa de um
 * pedido antes de ler o próprio pedido. A posição só muda numa compactação nova (o conjunto coberto muda), e linhas novas entram sempre no fim, então o prefixo
 * do pedido segue idêntico byte a byte entre compactações (A4). Sem checkpoint, o índice do colapso (se houver) abre o histórico. `rows` pode ter perdido linhas
 * para o colapso: a posição é achada pela identidade das linhas do trecho final, que o colapso nunca remove por inteiro (a etapa mais recente fica).
 */
function withRuntimeTurns(rows: readonly ContextRow[], loaded: Pick<LoadedContext, 'checkpointTurn' | 'visibleRows' | 'checkpointAt'>, notice: ChatTurn | null): ContextRow[] {
  const interlude = [...(loaded.checkpointTurn ? [loaded.checkpointTurn] : []), ...(notice ? [notice] : [])].map(runtimeRow);
  if (!interlude.length) return [...rows];
  const finalStretch = new Set(loaded.visibleRows.slice(loaded.checkpointAt));
  const at = loaded.checkpointTurn ? rows.findIndex((row) => finalStretch.has(row)) : 0;
  return at === -1 ? [...rows, ...interlude] : [...rows.slice(0, at), ...interlude, ...rows.slice(at)];
}

export class RunExecutor {
  private readonly abort = new AbortController();
  /** Closure do request desta etapa, retomada também lê a versão gravada na atividade. */
  private contextEvidence: EvidenceProvenance | undefined;
  /**
   * Preparação mantém as linhas ORIGINAIS (base do CAS, da impressão do conjunto coberto e do `coverage_fingerprint`) e as SANEADAS (o que vai ao modelo e ao resumo,
   * com evidência desconhecida ou revogada trocada por marcador). Resumo/projeção nunca vira histórico de conversa.
   */
  private preparedContext: { checkpoint: ContextCheckpoint; rows: ContextRow[]; originals: ContextRow[]; summary: string; configuration: string } | null = null;
  /** Página, em bytes, que as leituras `read_attachment` e `read_activity` devolvem: `RESULT_PAGE_MAX_BYTES` (o que as duas descrições declaram), reduzida a 30% do orçamento de histórico a cada preparação. */
  private resultPageBytes = RESULT_PAGE_MAX_BYTES;
  /** Identidade da preparação liga seus resumos e chamada principal; legado permanece explicitamente desconhecido. */
  private preparationId:string|null=null;
  private reason: AbortReason | null = null;
  /** Tempo ativo já gravado antes desta posse (reinício do worker) e o início do trecho atual. */
  private readonly activeBaseMs: number;
  private readonly segmentStartedAt = Date.now();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private deadlineTimer: NodeJS.Timeout | null = null;
  /** Ferramentas externas interrompidas em andamento: vão para o cartão "podem ter sido concluídas". */
  private readonly maybeCompleted: string[] = [];
  /** Fator de calibração lido na preparação da etapa; o resumo da mesma preparação usa o mesmo valor. */
  private tokenScale = 1;
  /**
   * Corte vigente do colapso em índice nesta execução (ver `CollapseStanding`): reaplicado a cada preparação enquanto o pedido couber, para o índice, que é
   * o prefixo do pedido, não mudar a cada etapa e o cache do provedor valer. Nulo enquanto não há colapso (ou quando o pedido voltou a caber sem ele).
   */
  private collapseCut: CollapseStanding | null = null;
  /**
   * Snapshot por início/retomada (PERF-01): o turno de sistema e o idioma e o fuso que formatam o bloco `# Dados`, este só na primeira preparação da execução
   * (`ensureRequestData`). Memória editada persiste e entra no histórico pelo resultado da ferramenta; a execução seguinte (ou a retomada) já monta o sistema com ela.
   */
  private snapshot: { system: string; language: LanguageCode; timeZone: string } | null = null;
  /** O bloco `# Dados` desta execução já está gravado em `runs.request_data` (escrito agora ou por uma posse anterior): as próximas preparações desta posse não o reconferem. */
  private requestDataStored = false;
  /** A rede de segurança da conversa fria (`maskColdOnOpening`) já foi consultada nesta posse: ela só olha a abertura da execução, uma vez. */
  private coldOpeningHandled = false;
  /** Esta execução é a compactação fria do worker (definido por `maintainContext`): ela não publica fase no painel (`publishContextPhase`). */
  private coldMaintenance = false;
  /**
   * Ferramentas desta execução: as internas (sem as `botOnly` numa sessão do chat geral), as da web (se a pesquisa está ligada) e as do Composio, resolvidas
   * uma vez (a lista não muda no meio de uma execução; mudar o interruptor da pesquisa vale a partir da execução seguinte). O único item que a execução troca é a porta `abrir_grupo` do bot,
   * quando a lista das mais usadas é recalculada (`refreshMostUsed`).
   */
  private toolMap: Map<string, ToolHandler> | null = null;
  /**
   * As "mais usadas" VIGENTES do bot (phase 15, passo 12) e o instante do recálculo para o qual foram calculadas (`readMostUsedAnchor`, em milissegundos; nulo = a conversa ainda não foi recalculada, vale a
   * lista padrão; `null` fora do objeto = ainda não lidas nesta posse). A lista é função desse instante e do uso encerrado até ele (`resolveMostUsed`), então vale entre etapas, rodadas e execuções até a conversa
   * esfriar ou ser compactada de novo, e o campo `tools` do pedido fica idêntico (A43).
   */
  private mostUsed: { anchorMs: number | null; tools: readonly string[] } | null = null;

  constructor(
    private readonly deps: ExecutorDeps,
    private readonly run: RunRow,
    /** Token desta posse (ver `lease.ts`): toda escrita confere que ainda é o dono. */
    private readonly owner: string,
    /** A posse veio de uma execução abandonada por outro worker (e não de uma que acabou de sair da fila). */
    private readonly resumed: boolean,
  ) {
    this.activeBaseMs = run.active_ms;
  }

  /** Worker encerrando: aborta sem finalizar, deixando o estado como está para outro worker retomar. */
  shutdown(): void {
    this.abortWith('shutdown');
  }

  /** Roda a execução até um desfecho e o grava. Nunca lança: falhas inesperadas viram `failed` com `INTERNAL_ERROR`. */
  async execute(): Promise<void> {
    const { logger, config } = this.deps;
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), config.heartbeatMs);
    this.deadlineTimer = setTimeout(() => this.abortWith('deadline'), Math.max(0, config.maxActiveMs - this.activeMs()));
    // Parada pedida enquanto a execução esperava aprovação: o motor só a reivindicou para encerrá-la.
    if (this.run.stop_requested_at) this.abortWith('stop');

    let outcome: Outcome;
    try {
      const pendingTerminal = this.resumed ? await this.pendingTokenTerminal() : null;
      if (this.resumed && !pendingTerminal) await this.recover();
      outcome = this.halted() ?? pendingTerminal ?? await this.drive();
    } catch (error) {
      if (error instanceof LeaseLostError) {
        // Outro worker assumiu a execução: nada mais aqui é nosso (nem o desfecho, nem devolver a posse).
        logger.warn({ runId: this.run.id }, 'posse da execução perdida para outro worker');
        this.reason ??= 'lease_lost';
        outcome = { status: 'released' };
      } else if (error instanceof DomainError && ['CONTEXT_TOO_LARGE', 'CONTEXT_COMPACTION_FAILED', 'CONTEXT_CONFIGURATION_CHANGED', 'CONTEXT_EVIDENCE_UNAVAILABLE', 'CONTEXT_ESTIMATE_UNAVAILABLE','CONTEXT_CONFLICT','MODEL_UNAVAILABLE'].includes(error.code)) {
        outcome = this.failureOutcome(error);
      } else {
        logger.error({ err: error, runId: this.run.id }, 'falha inesperada na execução');
        outcome = { status: 'failed', code: 'INTERNAL_ERROR' };
      }
    } finally {
      clearInterval(this.heartbeatTimer);
      clearTimeout(this.deadlineTimer);
    }

    try {
      if (outcome.status === 'released') await this.release();
      else if (outcome.status !== 'waiting_approval') await this.finish(outcome);
    } catch (error) {
      if (error instanceof LeaseLostError) logger.warn({ runId: this.run.id }, 'posse perdida antes de registrar o desfecho');
      else logger.error({ err: error, runId: this.run.id }, 'falha ao registrar o desfecho da execução');
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Tempo, parada e batimento
  // ---------------------------------------------------------------------------------------------

  private activeMs(): number {
    return this.activeBaseMs + (Date.now() - this.segmentStartedAt);
  }

  /** Único ponto que interrompe a execução: guarda o PRIMEIRO motivo e aborta a chamada ao modelo em curso. */
  private abortWith(reason: AbortReason): void {
    this.reason ??= reason;
    this.abort.abort();
  }

  /**
   * Promessa que rejeita (`StreamInterrupted`) assim que a execução é abortada, para correr contra uma leitura que pode não acabar.
   * `dispose` tira o listener do sinal quando a etapa termina: sem isso cada etapa do modelo deixava um listener no MESMO sinal da
   * execução, e uma execução longa passava do limite de 10 e fazia o Node emitir `MaxListenersExceededWarning` (R22).
   */
  private interruption(): { promise: Promise<never>; dispose: () => void } {
    let onAbort: (() => void) | undefined;
    const promise = new Promise<never>((_, reject) => {
      if (this.abort.signal.aborted) reject(new StreamInterrupted());
      else {
        onAbort = () => reject(new StreamInterrupted());
        this.abort.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    // Sem isto, um aborto depois de o laço terminar seria uma rejeição sem ninguém ouvindo.
    promise.catch(() => undefined);
    return {
      promise,
      dispose: () => {
        if (onAbort) this.abort.signal.removeEventListener('abort', onAbort);
      },
    };
  }

  /** Desfecho pedido por quem abortou (ou nulo se a execução pode seguir). Confere o prazo também aqui, sem esperar o timer. */
  private halted(): Outcome | null {
    if (this.reason === null && this.deps.config.maxActiveMs - this.activeMs() <= 0) this.abortWith('deadline');
    switch (this.reason) {
      case null:
        return null;
      case 'stop':
        return { status: 'interrupted' };
      case 'deadline':
        return { status: 'limit_reached', limit: 'time' };
      case 'idle':
        return { status: 'failed', code: 'PROVIDER_ERROR' };
      case 'shutdown':
      case 'lease_lost':
        return { status: 'released' };
    }
  }

  /** Renova a posse, grava o tempo ativo e lê o pedido de parada. Falha de banco só é logada: o próximo batimento repete. */
  private async heartbeat(): Promise<void> {
    try {
      const beat = await this.deps.pool.query<{ stop_requested_at: Date | null }>(
        `UPDATE runs SET lease_until = now() + ($3::int * interval '1 millisecond'), active_ms = $2
         WHERE id = $1 AND status = 'running' AND lease_owner = $4 RETURNING stop_requested_at`,
        [this.run.id, this.activeMs(), this.deps.config.leaseMs, this.owner],
      );
      const row = beat.rows[0];
      if (!row) this.abortWith('lease_lost');
      else if (row.stop_requested_at) this.abortWith('stop');
    } catch (error) {
      this.deps.logger.warn({ err: error, runId: this.run.id }, 'falha no batimento da execução');
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Laço principal
  // ---------------------------------------------------------------------------------------------

  private async drive(): Promise<Outcome> {
    await this.ensureTools();
    if (this.run.context_operation_id) return this.maintainContext();
    // Retomada depois de uma aprovação: a decisão do dono e as chamadas que ficaram para depois dela vêm ANTES de qualquer nova
    // chamada ao modelo (é isso que faz a execução continuar do ponto exato). Parada pedida vence: o pedido é cancelado no desfecho.
    const early = this.halted();
    if (early) return early;
    const decided = await this.takeApprovalDecision();
    if (decided) {
      const stopped = await this.applyDecision(decided);
      if (stopped) return stopped;
    }

    for (;;) {
      const before = this.halted();
      if (before) return before;

      // Fronteira entre etapas (CONV-03): os complementos que chegaram durante a ferramenta, o streaming ou a espera da aprovação entram
      // AGORA, antes da chamada ao modelo, e nunca no meio de uma (nada em andamento é interrompido por eles).
      await this.absorbComplements();
      const step = await this.modelStep();
      if ('status' in step) return step;
      if ('continueAutomatically' in step) continue;

      const after = this.halted();
      if (after) return after;
      if (step.calls.length === 0) return this.finalAnswer();

      // Uma chamada que estouraria o limite não é executada nem gravada: a execução encerra com o relatório.
      const [limit, used] = await this.toolBudget();
      if (used + step.calls.length > limit) return { status: 'limit_reached', limit: 'steps' };
      const stopped = await this.runCalls(step.calls, step.step);
      if (stopped) return stopped;
    }
  }

  /**
   * Manutenção de contexto: "Compactar agora" (gesto do dono) e a compactação fria que o worker enfileira quando a conversa esfria (phase 11, T8, F5: a linha de
   * `context_maintenance` SEM sessão, migration 0048). As duas não criam rodada nem chamam o modelo principal; retomam commit conhecido e recusam chamada paga incerta.
   * Diferem em três pontos: (1) a revisão que mudou desde o enfileiramento: no gesto do dono é `CONTEXT_CONFLICT` (a tela diz "tente de novo"); na fria a execução
   * encerra sem efeito, porque a próxima passagem do worker decide pela revisão nova e o dono não pediu nada; (2) o gatilho, em `modelStep`: o gesto compacta sempre
   * (ignora a recusa registrada) e a fria só com a ocupação a partir de `coldTriggerTokens`, medida pela MESMA conta desta preparação, e obedecendo a recusa; (3) o desfecho
   * (`finish`): a fria termina sempre concluída para o dono, com o resultado verdadeiro só em `context_maintenance`.
   */
  private async maintainContext(): Promise<Outcome> {
    const operation = (await this.deps.pool.query<{ mode:'elision'|'summarize';expected_revision:string;outcome:string|null;cold:boolean }>('SELECT mode,expected_revision::text,outcome,(session_id IS NULL) AS cold FROM context_maintenance WHERE request_id=$1 AND run_id=$2',[this.run.context_operation_id,this.run.id])).rows[0];
    if (!operation) throw new DomainError('CONTEXT_CONFLICT');
    const kind: MaintenanceKind = operation.cold ? 'cold' : 'summarize';
    this.coldMaintenance = kind === 'cold';
    if (operation.outcome === 'completed') return {status:'completed'};
    // Pedido legado de elisão que ainda estava na fila quando a versão trocou: o modo deixou de existir e não há o que fazer. Encerra como concluído, sem resultado
    // (a tela o mostra como "Nada a compactar."), sem tocar o modelo nem a conversa.
    if (operation.mode !== 'summarize') return {status:'completed'};
    const usage = (await this.deps.pool.query<{ state:string;model:string;summary_outcome:string|null }>('SELECT state,model,summary_outcome FROM model_call_usage WHERE run_id=$1',[this.run.id])).rows;
    if (usage.some((row) => row.state !== 'completed' || ['output_limit','empty'].includes(row.summary_outcome ?? ''))) {
      await withTransaction(this.deps.pool,async (tx) => {
        await holdLease(tx,this.run.id,this.owner);
        await tx.query("UPDATE model_call_usage SET state='unknown' WHERE run_id=$1 AND state='started'",[this.run.id]);
        await tx.query("UPDATE context_maintenance SET outcome=$2,error_code='CONTEXT_COMPACTION_FAILED' WHERE request_id=$1",[this.run.context_operation_id,usage.some((row)=>row.state!=='completed')?'unknown':'failed']);
      });
      return {status:'failed',code:'CONTEXT_COMPACTION_FAILED'};
    }
    const choice = await resolveModelChoice(this.deps.pool,this.run.conversation_id);
    if (usage.some((row) => row.model !== choice.model)) throw new DomainError('CONTEXT_CONFLICT');
    if (!usage.length && await readContextRevision(this.deps.pool,this.run.conversation_id) !== Number(operation.expected_revision)) {
      if (kind === 'cold') { this.deps.logger.info({ runId: this.run.id, conversationId: this.run.conversation_id }, 'compactação fria dispensada: o contexto mudou desde que foi enfileirada'); return {status:'completed'}; }
      throw new DomainError('CONTEXT_CONFLICT');
    }
    const result = await this.modelStep(undefined,kind);
    return 'status' in result ? result : {status:'failed',code:'CONTEXT_COMPACTION_FAILED'};
  }

  /** Executa as chamadas de uma etapa em ordem. Cada uma sabe quais vêm depois dela (se pausar, o pedido as guarda). */
  private async runCalls(calls: readonly ChatToolCall[], step: number): Promise<Outcome | null> {
    for (const [index, call] of calls.entries()) {
      const stopped = await this.executeCall(call, step, calls.slice(index + 1));
      if (stopped) return stopped;
    }
    return null;
  }

  /**
   * As ferramentas do conector (Composio) que esta execução pode usar (a fonte nunca lança; sem Composio, nenhuma). A execução sem bot, a do Chat geral, não tem conector
   * (CONN-02, phase 13, decisão 4): não há bot dono da liberação das contas, então ela nem o carrega, e o aviso de "modelo sem ferramentas" também não o considera.
   * Fonte única dessa regra para o registry (`ensureTools`) e para o aviso (`noteModelWithoutTools`).
   */
  private async connectorTools(): Promise<readonly ToolHandler[]> {
    return this.run.bot_id === null ? [] : ((await this.deps.composio?.load(this.run.bot_id)) ?? []);
  }

  /**
   * Ferramentas da execução, na ordem em que o modelo as recebe: as internas, as da web (T9: só com a pesquisa ligada) e as do Composio (só no bot, ver `connectorTools`; a fonte
   * nunca lança; sem Composio, só as internas). O interruptor da pesquisa é lido AQUI, uma vez por execução.
   */
  private async ensureTools(): Promise<ReadonlyMap<string, ToolHandler>> {
    if (this.toolMap) return this.toolMap;
    const tools = new Map([...this.deps.tools].filter(([, handler]) => !(handler.botOnly && this.run.bot_id === null)));
    for (const handler of [...((await this.deps.web?.load()) ?? []), ...(await this.connectorTools())]) {
      assertRuntimeToolNames([handler]);
      if (!tools.has(handler.definition.name)) tools.set(handler.definition.name, handler);
    }
    tools.set(activityReadTool.definition.name, activityReadTool);
    // A porta de exposição depende de quem executa (decisão 26): o bot abre a árvore de grupos com `abrir_grupo` e o Chat geral segue com `discover_tools`. As duas enxergam este mesmo mapa já filtrado.
    if (this.run.bot_id === null) tools.set(DISCOVER_TOOLS, discoveryTool(tools));
    else tools.set(ABRIR_GRUPO, abrirGrupoTool(tools));
    // A porta `use_tool` enxerga este mesmo mapa já filtrado (sem as `botOnly` no Chat geral, só o conector do bot): é dele, e só dele, que sai o alvo (E2). O bot a publica ao lado de `abrir_grupo`; o Chat geral não.
    tools.set(USE_TOOL, useToolPort(tools));
    this.toolMap = tools;
    await this.refreshMostUsed();
    return tools;
  }

  /**
   * As "mais usadas" do bot (phase 15, passo 12; decisão 24 revisada em 2026-11-08): lê o instante do último recálculo da conversa (`readMostUsedAnchor`: a execução que a encontrou fria ou a última compactação
   * aplicada) e, só se ele mudou desde o último cálculo desta execução (a primeira vez, e depois de uma compactação aplicada nesta mesma execução), recalcula a lista pelo uso encerrado até ele (`resolveMostUsed`) e
   * refaz a porta `abrir_grupo` para ela dizer o que já está na lista. É o único ponto que recalcula: a execução seguinte, a retomada e cada etapa releem o mesmo instante, que é dado gravado e não o relógio de agora,
   * e ficam com a mesma lista, porque a lista é função dele e não do uso de hoje. Chamado em `ensureTools`, antes da limpeza da abertura (`maskColdOnOpening`), que não faz parte da regra: a lista é a mesma com ou
   * sem limpeza gravada, e com ou sem o laço do worker ter passado antes. Sem bot (Chat geral, sem árvore) ou com o catálogo core desligado, nada a fazer.
   */
  private async refreshMostUsed(): Promise<void> {
    if (!this.deps.publishMostUsed || this.run.bot_id === null || this.toolMap === null) return;
    const anchor = await readMostUsedAnchor(this.deps.pool, this.run.conversation_id);
    const anchorMs = anchor?.getTime() ?? null;
    if (this.mostUsed !== null && this.mostUsed.anchorMs === anchorMs) return;
    const tools = await resolveMostUsed(this.deps.pool, this.run.conversation_id, this.toolMap, anchor);
    this.mostUsed = { anchorMs, tools };
    this.toolMap.set(ABRIR_GRUPO, abrirGrupoTool(this.toolMap, tools));
  }

  /** A etapa não pediu ferramenta: a execução termina. Sem nenhum texto do bot em toda a execução, é falha (resposta vazia). */
  private async finalAnswer(): Promise<Outcome> {
    const produced = await this.deps.pool.query<{ total: string }>(
      "SELECT count(*) AS total FROM messages WHERE run_id = $1 AND role = 'assistant' AND status <> 'discarded' AND coalesce(data->>'incomplete', 'false') <> 'true'",
      [this.run.id],
    );
    return Number(produced.rows[0]?.total ?? 0) > 0 ? { status: 'completed' } : { status: 'failed', code: 'PROVIDER_ERROR' };
  }

  /**
   * Absorve os complementos pendentes da execução (phase 4, F5) como mensagens do dono da rodada atual, sob a posse. A consulta sem trava evita
   * uma transação por etapa quando não há nada: um complemento que chegar logo depois dela entra na fronteira seguinte ou é promovido no desfecho.
   */
  private async absorbComplements(): Promise<void> {
    const { pool, now } = this.deps;
    const waiting = await pool.query("SELECT 1 FROM complements WHERE run_id = $1 AND state = 'pending' LIMIT 1", [this.run.id]);
    if (!waiting.rowCount) return;
    const at = now();
    await withTransaction(pool, async (tx) => {
      await holdLease(tx, this.run.id, this.owner);
      await absorbComplements(tx, this.run, at);
    });
  }

  /** Limite de chamadas do bot (lido agora, para a edição valer já; o padrão no chat geral) e quantas esta execução já usou. */
  private async toolBudget(): Promise<[limit: number, used: number]> {
    const found = await this.deps.pool.query<{ step_limit: number; tool_calls: number }>(
      'SELECT coalesce(b.step_limit, $2::int) AS step_limit, r.tool_calls FROM runs r LEFT JOIN bots b ON b.id = r.bot_id WHERE r.id = $1',
      [this.run.id, BOT_STEP_LIMIT_DEFAULT],
    );
    const row = found.rows[0];
    return [row?.step_limit ?? BOT_STEP_LIMIT_DEFAULT, row?.tool_calls ?? 0];
  }

  // ---------------------------------------------------------------------------------------------
  // Etapa do modelo
  // ---------------------------------------------------------------------------------------------

  /** Falha esperada da chamada ao provedor, em código seguro; qualquer outra exceção é bug e sobe para virar INTERNAL_ERROR. */
  private failureOutcome(error: unknown): Outcome {
    const { logger } = this.deps;
    if (error instanceof DomainError) {
      if (error.code === 'PROVIDER_NOT_CONFIGURED' || error.code === 'PROVIDER_KEY_INVALID' || error.code === 'MODEL_UNAVAILABLE' || error.code === 'CONTEXT_ESTIMATE_UNAVAILABLE' || error.code === 'CONTEXT_TOO_LARGE' || error.code === 'CONTEXT_COMPACTION_FAILED'
        || error.code === 'CONTEXT_CONFIGURATION_CHANGED' || error.code === 'CONTEXT_EVIDENCE_UNAVAILABLE') {
        return { status: 'failed', code: error.code };
      }
      // Saldo da Anthropic esgotado (A20): para com o código próprio, sem nova tentativa; o cartão de falha e o push (`run_failed`) mostram "Créditos da Anthropic esgotados", também numa rotina e no Chat geral.
      if (error.code === 'PROVIDER_CREDITS_EXHAUSTED') {
        logger.warn({ runId: this.run.id, code: error.code }, 'créditos do provedor esgotados durante a execução');
        return { status: 'failed', code: error.code };
      }
      // Limite de uso do provedor (429 do OpenCode Go, depois de esgotadas as novas tentativas do cliente, A22): a classe da falha fica em `runs.failure_code` e no cartão (numa rotina, também no cartão
      // dela e no push), em vez do genérico `PROVIDER_ERROR`, para o dono ver o motivo sem abrir o log do worker.
      if (error.code === 'PROVIDER_UNAVAILABLE' && error.cause instanceof ProviderRateLimited) {
        logger.warn({ runId: this.run.id, code: 'RATE_LIMITED', retryAfterMs: error.cause.retryAfterMs }, 'provedor limitou as chamadas durante a execução');
        return { status: 'failed', code: 'RATE_LIMITED' };
      }
      if (error.code === 'PROVIDER_UNAVAILABLE' || error.code === 'RATE_LIMITED') {
        logger.warn({ runId: this.run.id, code: error.code }, 'provedor indisponível durante a execução');
        return { status: 'failed', code: 'PROVIDER_ERROR' };
      }
    }
    if (error instanceof ChatRejected || error instanceof ChatStreamError) {
      logger.warn({ runId: this.run.id, problem: error.name }, 'provedor recusou ou respondeu fora do formato');
      return { status: 'failed', code: 'PROVIDER_ERROR' };
    }
    throw error;
  }

  /** Protocolo e níveis de effort gravados no teste do modelo; testa na hora um modelo que nunca foi testado. */
  private async modelProfile(model: string, noTest: false | 'summarize' = false): Promise<ModelProfile> {
    const read = async () => {
      const found = await this.deps.pool.query<{ test_status: string | null; test_protocol: ChatProtocol | null; effort_levels: string[]; accepts_images: boolean | null }>(
        'SELECT test_status, test_protocol, effort_levels, accepts_images FROM model_profiles WHERE model_id = $1',
        [model],
      );
      return found.rows[0];
    };
    let row = await read();
    if (noTest === 'summarize' && (!row || row.test_protocol === null)) throw new DomainError('MODEL_UNAVAILABLE');
    if ((!row || row.test_status === null) && !noTest) {
      await this.deps.models.test(model);
      row = await read();
    }
    // Modelo que falhou no teste não tem protocolo: tenta o mais comum e o provedor diz se serve (falha vira PROVIDER_ERROR).
    return { status: row?.test_status ?? null, protocol: row?.test_protocol ?? 'chat_completions', levels: row?.effort_levels ?? [], acceptsImages: row?.accepts_images === true };
  }

  /**
   * Histórico como o banco o tem para esta preparação (parte COM IO do antigo `buildTurns`): o turno de sistema fixado na primeira etapa desta posse
   * (remontado na retomada), o objetivo, o checkpoint válido e as linhas que ele ainda não cobre, já saneadas (evidência desconhecida ou revogada: a resposta de texto sai do pedido e o resultado de ferramenta vira
   * marcador, sem alterar o que está gravado). O bloco `# Dados` de cada rodada vem de `runs.request_data` (`loadRequestData`), depois de `ensureRequestData` garantir
   * o desta execução: a primeira preparação o grava e toda outra o relê, então a hora e o modelo do bloco nunca dependem da posse nem da etapa. Fixa `preparedContext` (base da compactação e do CAS: as linhas originais e as saneadas) e `contextEvidence` (fontes
   * realmente enviadas). O checkpoint só vale pelo conteúdo que cobre (CTX-09, `validCheckpoint`): sistema, memória, Regras Globais, idioma, objetivo, catálogo,
   * effort e janela não o invalidam. Sem bot, só a memória global. Reler o banco a cada tentativa de caber no orçamento era caro e desnecessário: `renderTurns` é puro.
   * `images`: as mesmas decisões de `RenderOptions` (visão do modelo e custo visual conhecido); só as imagens que o pedido leva têm os bytes lidos do banco (`loadAttachmentContext`).
   */
  private async loadContext(model: string, images: { acceptsImages: boolean; historyImages: boolean }): Promise<LoadedContext> {
    const { pool } = this.deps;
    const botId = this.run.bot_id;
    const snapshot = this.snapshot ?? await this.loadSnapshot();
    this.snapshot = snapshot;
    // O bloco desta execução é gravado ANTES de as linhas serem lidas: `loadRequestData` o encontra como o de qualquer outra rodada.
    await this.ensureRequestData(model, snapshot);
    const managed = await loadManagedContext(pool, this.run.conversation_id);
    const rows = managed.rows;
    // Cópia anterior ao bloco e aos anexos: é a base do `coverage_fingerprint`, que só conhece campos persistidos da conversa.
    const originals = rows.map((row) => ({ ...row }));
    await loadRequestData(pool, this.run.conversation_id, rows, botId === null);
    // O checkpoint só vale pelo conteúdo que cobre (CTX-09): decidido antes de carregar os anexos, porque só as mensagens que ele cobre de fato saem do pedido e dispensam o
    // conteúdo dos anexos delas (T10); com checkpoint inválido todas voltam ao pedido, e voltam com o conteúdo.
    const usable = await validCheckpoint(pool, this.run.conversation_id, botId, managed.checkpoint, originals);
    const covered = new Set(usable ? managed.checkpoint.covered_message_ids : []);
    const readImages = await loadAttachmentContext(pool, rows, this.run.conversation_id, this.run.id, { covered, ...images });
    const sources: EvidenceProvenance[] = [];
    for (const row of rows) {
      if (row.role === 'assistant' && (row.kind === 'activity' || row.kind === 'text')) {
        const source = parseEvidence(row.evidence_provenance);
        if (!source || !await validateEvidence(pool, this.run.conversation_id, botId, source)) {
          // Projeção apenas: originals e argumentos persistidos não são alterados. Estado incerto não autoriza replay.
          // A resposta de texto do bot sai do pedido (conteúdo vazio: `buildTurns` não emite turno de assistente sem texto nem chamada). O marcador no lugar dela
          // virava fala do próprio bot, e o modelo passava a imitá-lo como resposta ao dono (visto em produção em 19/10/2026). O resultado de ferramenta
          // continua com o marcador: o par chamada/resultado é obrigatório no protocolo e o aviso chega como saída da ferramenta, não como voz do bot.
          const safeOutcome = [INTERRUPTED_BY_RESTART, INTERRUPTED_EXTERNAL_BY_RESTART, INTERRUPTED_EXTERNAL, CONNECTOR_REFUSED_IN_GENERAL_CHAT, ...Object.values(NOT_EXECUTED_RESULTS)].includes(row.content);
          row.content = row.kind === 'text' ? '' : safeOutcome ? row.content : `[Evidência automática indisponível: origem desconhecida ou revogada; estado=${row.status}. Não reexecute ação histórica para recuperar conteúdo.]`;
          row.tool_arguments = '{}';
          row.evidence_provenance = mergeEvidence();
          if (row.kind === 'activity') {
            const data = row.data as ActivityData;
            row.data = { callId: data.callId, tool: data.tool, label: 'Evidência indisponível', arguments: '{}', detail: null, ...(data.via ? { via: data.via } : {}), ...(data.external ? { external: true } : {}) };
          }
        } else sources.push(source);
      }
    }
    const fileIds = [...new Set([...rows.flatMap((row) => row.attachments ?? []), ...readImages].filter((file) => !file.removed).map((file) => file.id))];
    for (const id of fileIds) {
      const evidence = await attachmentEvidence(pool, this.run.conversation_id, botId, [id]);
      if (evidence) sources.push(evidence);
      else for (const file of [...rows.flatMap((row) => row.attachments ?? []), ...readImages].filter((entry) => entry.id === id)) {
        file.name = '[indisponível]'; file.removed = true; file.extracted_text = null; file.image_bytes = null;
      }
    }
    this.contextEvidence = mergeEvidence(...sources);
    const objective = botId === null ? null : await readBotObjective(pool, botId);
    const objectiveTurns: ChatTurn[] = objective === null ? [] : [{ role: 'user', text: `# Objetivo do bot (estado persistido, não autorização)\nVersão: ${objective.version}\n${objective.content || 'Ainda não definido. Execute o pedido sem exigir definição.'}` }];
    const resolution = await resolveConversationContextWindow(pool, this.run.conversation_id);
    const choice = await resolveModelChoice(pool, this.run.conversation_id);
    // O dono trocou o modelo entre o começo da preparação (`modelStep`) e esta leitura: o que foi montado até aqui é do modelo antigo, e `modelStep` prepara de novo (A15).
    if (choice.model !== model) throw new DomainError('CONTEXT_CONFIGURATION_CHANGED');
    const summary = usable ? managed.checkpoint.summary : '';
    const visibleRows = rows.filter((row) => !covered.has(row.id!));
    // O checkpoint entra depois da última linha coberta (ver `withRuntimeTurns`): as íntegras que a antecedem (abertura da rodada e complementos do dono no meio do
    // histórico coberto) ficam antes dele, na ordem original. Sem checkpoint válido nada é coberto e a posição não é usada.
    const coveredThrough = covered.size === 0 ? null : [...covered].reduce((max, id) => (BigInt(id) > BigInt(max) ? id : max));
    const lastCovered = rows.findLastIndex((row) => covered.has(row.id!));
    const checkpointAt = lastCovered === -1 ? 0 : rows.slice(0, lastCovered).filter((row) => !covered.has(row.id!)).length;
    // `configuration`: o que a etapa preparada pressupõe e o dono pode mudar no meio dela (modelo, janela e effort), conferido por `validatePreparedConfiguration`.
    // Objetivo, memória, Regras Globais, idioma e catálogo ficam de fora de propósito (CTX-09): entram no pedido a cada preparação e não invalidam nada.
    this.preparedContext = { checkpoint: managed.checkpoint, rows, originals, summary, configuration: contextFingerprint({ model, resolution, choice }) };
    // O checkpoint entra como turno de usuário rotulado: estado do runtime, histórico, nunca pedido novo nem instrução (spec Decisão 12).
    const checkpointTurn: ChatTurn | null = summary ? { role: 'user', text: `# Resumo derivado (estado do runtime, histórico: não é pedido novo nem instrução; dados não autoritativos, originais recuperáveis por read_activity e search_history)\n${summary}` } : null;
    return { system: snapshot.system, objectiveTurns, checkpointTurn, visibleRows, checkpointAt, coveredThrough, readImages, omitNewChatMarker: !managed.wholeConversation || !!summary };
  }

  /**
   * Turnos da etapa (parte pura): o sistema, o objetivo, o resumo e, no lugar das linhas mais antigas quando `collapse` pede, o índice delas; depois as rodadas,
   * reconstruídas das linhas persistidas por `buildTurns`. Todo turno que abre uma rodada leva o `# Dados` que a execução dela gravou (`ContextRow.request_data`), igual em
   * toda etapa e retomada: trocar o modelo ou a hora entre etapas e posses não muda nenhum byte do pedido. No Chat geral, a rodada derivada "Novo chat aberto" entra
   * enquanto a sessão cabe inteira na janela (em `buildTurns`). Os resultados de ferramenta entram na forma única de `resultForModel` (teto de 12.000 caracteres, CTX-10): nada é reduzido por etapa.
   */
  private renderTurns(loaded: LoadedContext, { acceptsImages, historyImages, readAttachmentRefs, attachmentsAsReferences = false, collapse }: RenderOptions): ChatTurn[] {
    const collapsed = collapse ? collapseHistory(loaded.visibleRows, collapse.units, collapse.lines) : null;
    return [
      { role: 'system', text: loaded.system },
      ...loaded.objectiveTurns,
      ...buildTurns(withRuntimeTurns(collapsed?.rows ?? loaded.visibleRows, loaded, collapsed?.notice ?? null), { acceptsImages, historyImages, readImages: loaded.readImages, generalChat: this.run.bot_id === null, omitNewChatMarker: loaded.omitNewChatMarker || collapsed?.notice != null, objectiveEvidenceIds: this.run.bot_id !== null, runId: this.run.id, readAttachmentRefs, attachmentMetadataOnly: attachmentsAsReferences }),
    ];
  }

  /**
   * Grava, uma única vez, o bloco `# Dados` desta execução (PERF-01, phase 10; spec decisões 1 a 4): o modelo efetivo, o "Agora" até o minuto e o fuso, lidos na
   * PRIMEIRA preparação (`UPDATE ... WHERE request_data IS NULL`, sob a posse, migration 0044). Toda preparação seguinte, desta posse ou de outra (aprovação decidida,
   * `recover` depois de um reinício, `continueRun`, preparação repetida por troca de configuração), só relê o texto gravado: nem a hora nem o modelo da etapa o reescrevem,
   * porque mudar uma linha no meio do pedido quebraria o cache de tudo o que vem depois dela. Idioma e fuso alterados nas Configurações valem só da próxima execução.
   * A manutenção ("Compactar agora") não responde rodada: não tem bloco próprio e só lê os das execuções que o gravaram.
   * ponytail: se o dono troca o modelo entre o começo da primeira preparação e a chamada (A15), a linha "Modelo desta resposta" fica com o modelo da primeira preparação;
   * gravar o bloco só ao iniciar a chamada se esse desencontro raro passar a importar.
   */
  private async ensureRequestData(model: string, { language, timeZone }: { language: LanguageCode; timeZone: string }): Promise<void> {
    if (this.requestDataStored || this.run.context_operation_id) return;
    const { pool, now } = this.deps;
    const stored = await pool.query<{ request_data: string | null }>('SELECT request_data FROM runs WHERE id = $1', [this.run.id]);
    if (stored.rows[0]?.request_data == null) {
      const block = currentDataBlock({ model, now: now(), language, timeZone });
      await withTransaction(pool, async (tx) => {
        await holdLease(tx, this.run.id, this.owner);
        await tx.query('UPDATE runs SET request_data = $2 WHERE id = $1 AND request_data IS NULL', [this.run.id, block]);
      });
    }
    this.requestDataStored = true;
  }

  /**
   * Rede de segurança da manutenção fria (phase 11, F6, A14; spec decisão 23): se o laço do worker ainda não tratou esta conversa e ela está fria, a ABERTURA da execução aplica e grava
   * o mesmo mascaramento antes do primeiro pedido, sem chamar o modelo (e sem compactar: a compactação fria é do worker, aqui vale o gatilho de 90% de sempre). A regra, a frieza e a
   * gravação são as de `maskColdResults` (`cold-maintenance.ts`), a fonte única que o laço também usa; a execução que abre não conta como "ativa" nem a rodada dela como "recente"
   * (`exceptRunId` e `openingMessageId`), então grava exatamente o que o laço teria gravado antes de o dono escrever. Só a primeira preparação de uma execução que ainda NÃO chamou o
   * modelo: uma execução retomada no meio (aprovação decidida, reinício) já tem chamadas e nunca reescreve o pedido que está montando, e a manutenção ("Compactar agora") não abre rodada.
   * Chamado ANTES da leitura da âncora de ocupação em `modelStep`, para a âncora já ser descartada pela limpeza (CTX-08). Falha da limpeza nunca derruba a execução: o pedido segue
   * sem ela (só o log, sem conteúdo).
   */
  private async maskColdOnOpening(): Promise<void> {
    // A execução de manutenção ("Compactar agora" e a compactação fria, `context_operation_id`) fica de fora DE PROPÓSITO: ela não abre rodada e a compactação chama o modelo, o que
    // esquenta a conversa; a compactação fria (T8) é enfileirada pelo worker DEPOIS do mascaramento do laço, nunca no meio dela. Mascarar aqui mudaria, no meio da manutenção, o que o resumo lê.
    if (this.coldOpeningHandled || this.run.context_operation_id) return;
    this.coldOpeningHandled = true;
    const { pool, logger, now } = this.deps;
    try {
      if ((await pool.query('SELECT 1 FROM model_call_usage WHERE run_id = $1 LIMIT 1', [this.run.id])).rowCount) return;
      await maskColdResults(pool, { conversationId: this.run.conversation_id, now: now(), exceptRunId: this.run.id, openingMessageId: this.run.trigger_message_id, origin: 'opening', logger });
    } catch (error) {
      logger.warn({ runId: this.run.id, conversationId: this.run.conversation_id, errorName: error instanceof Error ? error.name : typeof error, err: databaseErrorForLog(error) }, 'limpeza fria na abertura da execução falhou; o pedido segue sem ela');
    }
  }

  /** Lê uma vez por posse o que o turno de sistema e o bloco `# Dados` (só na primeira preparação da execução, `ensureRequestData`) precisam: bot (nome e instruções), memórias e Configurações (idioma e fuso). */
  private async loadSnapshot(): Promise<{ system: string; language: LanguageCode; timeZone: string }> {
    const { pool } = this.deps;
    const botId = this.run.bot_id;
    const [bot, memories, settings, registry] = await Promise.all([
      botId === null ? null : pool.query<{ name: string; instructions: string }>('SELECT name, instructions FROM bots WHERE id = $1', [botId]),
      loadContextMemories(pool, botId),
      readAppSettings(pool),
      this.ensureTools(),
    ]);
    const botRow = bot?.rows[0];
    const system = buildSystemText({
      botName: botId === null ? null : (botRow?.name ?? 'Bot'),
      botInstructions: botRow?.instructions ?? '',
      botMemory: memories.bot,
      globalMemory: memories.global,
      language: settings.language,
      // `run_python` só é registrado quando o sandbox está configurado no deploy (engine.ts); é a mesma fonte do catálogo.
      pythonAvailable: this.deps.tools.has(RUN_PYTHON_TOOL),
      // O índice da árvore de grupos (phase 15, passo 12) sai do registry desta execução, e só dele: não depende da lista das mais usadas, então o sistema não muda quando ela muda (A45). Só o bot a tem.
      ...(botId === null ? {} : { toolTree: treeIndex(registry) }),
    });
    return { system, language: settings.language, timeZone: settings.timeZone };
  }

  /** Silêncio do modelo além do limite aborta a etapa (a conexão ficou pendurada). */
  private startIdleWatchdog(): { touch(): void; stop(): void } {
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.abortWith('idle'), this.deps.config.streamIdleMs);
    };
    arm();
    return { touch: arm, stop: () => clearTimeout(timer) };
  }

  /**
   * Avisa o dono (cartão na conversa, uma vez por execução) que o modelo escolhido não chama ferramentas e por isso a execução segue
   * SEM as ações do Composio (spec F8). Só avisa quando há ações do Composio que ele deixa de usar: sem Composio conectado, ou no Chat geral, que não tem
   * conector (`connectorTools`), não há o que dizer. A checagem no banco evita repetir o aviso depois de uma retomada.
   */
  private async noteModelWithoutTools(model: string): Promise<void> {
    if ((await this.connectorTools()).length === 0) return;
    const { pool, now } = this.deps;
    const at = now();
    await withTransaction(pool, async (tx) => {
      await holdLease(tx, this.run.id, this.owner);
      const known = await tx.query("SELECT 1 FROM messages WHERE run_id = $1 AND kind = 'card' AND data->>'type' = 'model_without_tools'", [this.run.id]);
      if (known.rowCount) return;
      const card = await tx.query<{ id: string }>(
        `INSERT INTO messages (conversation_id, run_id, role, kind, status, content, data, created_at)
         VALUES ($1, $2, 'system', 'card', 'done', '', $3, $4) RETURNING id`,
        [this.run.conversation_id, this.run.id, JSON.stringify({ type: 'model_without_tools', model }), at],
      );
      await recordConversationEvent(tx, this.run.conversation_id, 'message', (card.rows[0] as { id: string }).id, at);
    });
  }

  /**
   * Registra na execução o modelo da chamada que vai começar (phase 4, F7): gravado ANTES do streaming, a coluna já tem o modelo certo quando o texto
   * desta etapa é fechado e a view da resposta é montada (SSE e snapshot). Como cada etapa regrava, ao fim fica o da última chamada. Confere a posse,
   * como toda escrita do executor.
   */
  private async recordCallModel(model: string): Promise<void> {
    await withTransaction(this.deps.pool, async (tx) => {
      await holdLease(tx, this.run.id, this.owner);
      await tx.query('UPDATE runs SET last_model = $2 WHERE id = $1', [this.run.id, model]);
    });
  }

  /**
   * Confere, na transação curta que publica a reserva, que a execução pode seguir: parada pedida, aborto e a configuração da preparação (modelo, janela de contexto e
   * effort: o pedido pronto foi dimensionado para eles, e se o dono os trocou no meio da etapa ele não vale). Lança `CONTEXT_CONFIGURATION_CHANGED`, e `modelStep` prepara a
   * etapa de novo uma vez (`reprepareStep`, A15). Objetivo, memória, Regras Globais, idioma e catálogo NÃO são conferidos (CTX-09): entram no pedido a cada preparação,
   * então uma edição no meio de uma etapa vale a partir da seguinte, sem derrubar a execução; nada disso autoriza efeitos. CTX-09 tira esses itens da invalidação do
   * CHECKPOINT, não a consistência da etapa em curso.
   */
  private async validatePreparedConfiguration(tx: Queryable, model: string): Promise<void> {
    const stopped = (await tx.query<{stop_requested_at:Date|null}>('SELECT stop_requested_at FROM runs WHERE id=$1',[this.run.id])).rows[0]?.stop_requested_at;
    if (stopped) this.abortWith('stop');
    if (this.abort.signal.aborted) throw new StreamInterrupted();
    const resolution = await resolveConversationContextWindow(tx, this.run.conversation_id);
    const choice = await resolveModelChoice(tx, this.run.conversation_id);
    if (choice.model !== model || this.preparedContext?.configuration !== contextFingerprint({ model, resolution, choice })) throw new DomainError('CONTEXT_CONFIGURATION_CHANGED');
  }

  /**
   * Fontes realmente enviadas nesta preparação (`loadContext` as fixa): a medição, a reserva e o registro da chamada dependem delas. `loadContext` sempre as define antes
   * de a etapa seguir, então a falta é um estado interno inconsistente e não uma falha de resumo: encerra com `CONTEXT_EVIDENCE_UNAVAILABLE`, sem chamar o provedor.
   */
  private requireContextEvidence(): EvidenceProvenance {
    if (!this.contextEvidence) throw new DomainError('CONTEXT_EVIDENCE_UNAVAILABLE');
    return this.contextEvidence;
  }

  /**
   * A configuração mudou no meio da preparação da etapa (A15): o pedido pronto foi dimensionado para a anterior e nada dele foi enviado ao provedor nem gravado como
   * chamada, então a etapa é preparada de novo, UMA vez, com o que está vigente (`reprepared` fecha o laço: a segunda mudança na mesma etapa falha com
   * `CONTEXT_CONFIGURATION_CHANGED`). A recarga pedida por uma recusa do provedor (`retryModel`) só sobrevive se o modelo vigente ainda é o que recusou: a recusa de outro
   * modelo não diz nada sobre o novo, que prepara do zero.
   * ponytail: no "Compactar agora", uma mudança que chega depois de a primeira chamada paga ser descartada refaz o resumo e paga outro (ou, com o mesmo pedido, esbarra no
   * índice único do resumo pendente e falha como `CONTEXT_COMPACTION_FAILED`), só quando o dono mexe na configuração no meio do gesto; trocar por falha imediata com
   * `CONTEXT_CONFIGURATION_CHANGED` se isso passar a pesar.
   */
  private async reprepareStep(retryModel: string | undefined, maintenance: MaintenanceKind | undefined): Promise<StepOutcome> {
    const vigent = retryModel === undefined ? null : (await resolveModelChoice(this.deps.pool, this.run.conversation_id)).model;
    this.deps.logger.info({ runId: this.run.id, maintenance: maintenance !== undefined }, 'configuração do contexto mudou durante a preparação da etapa; preparando de novo com a vigente');
    return this.modelStep(retryModel !== undefined && vigent === retryModel ? retryModel : undefined, maintenance, true);
  }

  /**
   * Tokens que o checkpoint ocupará no pedido: o vigente, ou o típico (`CHECKPOINT_TYPICAL_BYTES`) quando ele é menor, na escala calibrada. Fonte única de duas contas: se a
   * compactação vale o custo (`compactContext`) e quanto sobra para o trecho final da compactação fria (`coldTailTokens`).
   */
  private checkpointTokens(): number {
    return Math.ceil(Math.max(Buffer.byteLength(this.preparedContext?.summary ?? '', 'utf8'), CHECKPOINT_TYPICAL_BYTES) * this.tokenScale);
  }

  /**
   * Compactação do histórico (F3, CTX-07): troca o histórico antigo por UM checkpoint estruturado e mantém íntegro o trecho final. Devolve verdadeiro se um checkpoint
   * novo foi gravado (quem chama relê o contexto); falso se não havia o que cobrir, se a execução já desistiu de resumir ou o mesmo conjunto já foi recusado (S3), ou se
   * as tentativas falharam (quem chama segue: o colapso em índice resolve se o pedido ainda não cabe, e a execução NUNCA falha só porque o resumo falhou, C3).
   * O modo manual (`trigger: 'manual'`, "Compactar agora") ignora a recusa conhecida e a desistência (é um gesto explícito do dono) e, havendo o que cobrir e nada
   * aplicado, lança `CONTEXT_COMPACTION_FAILED` ("nada foi alterado").
   * O modo frio (`trigger: 'cold'`, phase 11, T8) é o da compactação que o worker enfileira com a conversa esfriada: obedece a recusa conhecida e a desistência como o automático
   * (recusa registrada não paga de novo), só segue se o resumo tirar o pedido de cima do gatilho frio (`thresholdTokens` já vem com o limiar do frio), trata a conversa como ociosa como o
   * manual, mas mantém íntegras as mensagens do dono da rodada mais recente (`keepLastRound`: o que ele disse por último, uma regra por exemplo, não pode sair do pedido da próxima execução) e, com tentativas esgotadas, lança `CONTEXT_COMPACTION_FAILED` só para o recibo em `context_maintenance` (`finish` termina a execução fria sempre concluída).
   *
   * Passos: (1) `cutHistory` separa o lote do trecho final (sempre com a etapa mais recente e as mensagens do dono da rodada atual); no limiar automático só segue se
   * cobrir o lote fizer o pedido ficar abaixo dele (`currentTokens`, `thresholdTokens`): um pedido dominado pelo que fica íntegro (uma etapa mais recente volumosa) não
   * melhora com o resumo, que se repetiria a cada etapa; quem segura o que passa de 100% é o colapso; (2) o modelo do resumo é o
   * resolvido em Preferências (`resolveSummaryModel`: o escolhido se ainda validado, senão o da conversa) com o effort mais baixo que ELE aceita; (3) a impressão do
   * conjunto coberto decide se vale pagar; (4) escada de entrada: o primeiro alvo é o orçamento de entrada e, a cada recusa definitiva (saída vazia, limite de saída,
   * formato inválido depois do lembrete, recusa de contexto do provedor), a entrada é reduzida a 70%, 50% e 35% do tamanho da primeira (`fitSummaryInput`), com no máximo `SUMMARY_MAX_CALLS` chamadas (a segunda chamada com lembrete só existe no
   * primeiro alvo; o teste do pior caso em `compaction.test.ts` falha se o laço divergir da constante); (5) esgotada a
   * escada, a recusa é gravada pela impressão do conjunto (`recordSummaryRefusal`). Cada chamada paga tem linha no ledger e revisão própria; o checkpoint, o conjunto
   * coberto e o ledger `applied` são gravados na MESMA transação (`commitSummary`), conferindo contra o banco que o conteúdo coberto não mudou.
   * ponytail: uma recusa registrada vale para o conjunto exato, e o lote de uma execução longa muda a cada poucas etapas (o trecho final avança), então um modelo que sempre
   * falha o resumo paga uma escada por execução (a própria execução não tenta de novo, `summaryGivenUp`); trocar por um disjuntor por conversa se isso passar a pesar.
   */
  private async compactContext(c: { model: string; profile: ModelProfile; apiKey: string; loaded: LoadedContext; inputBudget: number; outputReserve: number; tailTokens: number; costOf: (row: ContextRow) => number; currentTokens: number; thresholdTokens: number; trigger: 'threshold' | 'forced' | 'manual' | 'cold' }): Promise<boolean> {
    const { pool, logger, now } = this.deps;
    const state = this.preparedContext;
    const manual = c.trigger === 'manual';
    if (!state) return false;
    // Desistência da execução primeiro: é uma consulta barata e, depois dela, as etapas seguintes de uma rodada pressionada saem daqui sem fazer conta alguma.
    // EXCEÇÃO DELIBERADA do modo manual: "Compactar agora" ignora a desistência da execução e, mais abaixo, a recusa durável do conjunto. É um gesto explícito do
    // dono, e a mensagem de falha dele diz "Nada foi alterado; tente de novo" (F3): obedecer à recusa registrada tornaria o botão um no-op silencioso justamente
    // quando o dono quer insistir (por exemplo, depois de o modelo do resumo voltar a responder). Os guardas de custo (S3) valem só para o gatilho automático.
    // ponytail: cada clique manual sobre um conjunto já recusado paga outra escada de até `SUMMARY_MAX_CALLS` (cinco) chamadas; limitar por conjunto (um intervalo mínimo entre cliques) se o
    // dono repetir o gesto sem mudar o conjunto ou o modelo do resumo e o custo aparecer.
    if (!manual && await summaryGivenUp(pool, this.run.id)) { logger.info({ runId: this.run.id }, 'compactação não tentada: a execução já desistiu de resumir'); return false; }
    const conversationId = this.run.conversation_id;
    // Conversa OCIOSA (sem rodada atual a proteger): o gesto do dono e a compactação fria, que o worker só enfileira com a conversa sem execução ativa ou na fila.
    const cut = cutHistory(c.loaded.visibleRows, { tailTokens: c.tailTokens, costOf: c.costOf, idle: manual || c.trigger === 'cold', keepLastRound: c.trigger === 'cold' });
    if (!cut.batch.length) return false;
    // Os dois gatilhos automáticos só pagam o resumo se ele tirar o pedido de cima do SEU limiar (`thresholdTokens` já vem do gatilho: 90% no automático, o do frio na compactação fria).
    if (c.trigger === 'threshold' || c.trigger === 'cold') {
      const covered = cut.batch.reduce((sum, row) => sum + c.costOf(row), 0);
      const checkpointTokens = this.checkpointTokens();
      if (c.currentTokens - covered + checkpointTokens >= c.thresholdTokens) {
        logger.info({ runId: this.run.id, currentTokens: c.currentTokens, batchTokens: covered, thresholdTokens: c.thresholdTokens }, 'compactação dispensada: mesmo cobrindo o lote o pedido continuaria no limiar');
        return false;
      }
    }

    const summaryModel = await resolveSummaryModel(pool, c.model, logger);
    const profile = summaryModel === c.model ? c.profile : await this.modelProfile(summaryModel, 'summarize');
    const scale = summaryModel === c.model ? this.tokenScale : (await readTokenCalibration(pool, summaryModel)).scale;
    const previous = state.summary === '' ? null : state.summary;
    // Conjunto coberto depois desta compactação: o que o checkpoint vigente já cobre mais o lote. Para o pedido ao modelo e a proveniência vale a versão saneada das
    // linhas; a impressão e a conferência no commit usam as linhas ORIGINAIS, as mesmas de que `coverage_fingerprint` é calculado (`validCheckpoint`).
    const coveredIds = new Set([...(previous === null ? [] : state.checkpoint.covered_message_ids), ...cut.batch.map((row) => row.id!)]);
    const coveredRows = state.rows.filter((row) => coveredIds.has(row.id!));
    const coveredOriginals = state.originals.filter((row) => coveredIds.has(row.id!));
    const impression = coveredImpression(summaryModel, coveredOriginals);
    // Recusa durável (S3): só o gatilho automático a obedece; o manual a ignora de propósito (ver a exceção documentada no começo desta função).
    if (!manual && await summaryRefusalKnown(pool, conversationId, impression)) { logger.info({ runId: this.run.id }, 'compactação não tentada: o mesmo conjunto já foi recusado'); return false; }

    const evidence = mergeEvidence(...coveredRows.map((row) => parseEvidence(row.evidence_provenance)).filter((source): source is EvidenceProvenance => source !== null), ...(previous === null ? [] : [parseEvidence(state.checkpoint.evidence_provenance) ?? mergeEvidence()]));
    // Nunca acima do que a execução já reserva de saída para o modelo (capacidade confirmada de saída menor que o padrão vale aqui também).
    const maxOutputTokens = Math.min(SUMMARY_MAX_OUTPUT_TOKENS, c.outputReserve);
    const effort = lowestEffort(profile.levels);
    const requestOf = (input: SummaryInput, reminder: SummaryReminder | null): ChatRequest => ({
      model: summaryModel, sessionId: conversationId, maxTokens: maxOutputTokens, retryOnRateLimit: true, ...(effort ? { effort } : {}),
      turns: [{ role: 'system', text: summaryPrompt({ update: previous !== null, reminder }) }, { role: 'user', text: summaryUserText(input) }],
    });
    // O resumo pode usar outro provedor que o da conversa ("Modelo do resumo"): a chave é a do provedor do modelo do resumo.
    const summaryKey = summaryModel === c.model ? c.apiKey : await this.deps.credentials.requireKey(modelCredentialKind(summaryModel));
    const call = { conversationModel: c.model, summaryModel, protocol: profile.protocol, apiKey: summaryKey, maxOutputTokens, requestOf, evidence, coveredIds, coveredOriginals };
    const units = historyUnits(cut.batch).map((unit) => cut.batch.slice(unit.start, unit.end));

    await this.publishContextPhase('summarizing');
    let target = c.inputBudget, firstSize = 0, lastSize = Number.POSITIVE_INFINITY, attempts = 0, failure: SummaryFailure | 'conflict' = 'empty';
    for (let step = 0; step <= SUMMARY_RETRY_SHARES.length; step += 1) {
      const fitted = fitSummaryInput({ units, previous, size: (input) => estimateChatPayload(requestOf(input, null), profile.protocol, undefined, scale).estimatedInputTokens, target });
      // Sem como reduzir mais (só a unidade mais nova, já achatada): repetir a mesma entrada pagaria o mesmo fracasso.
      if (step > 0 && fitted.tokens >= lastSize) break;
      if (step === 0) firstSize = fitted.tokens;
      lastSize = fitted.tokens;
      let reminder: SummaryReminder | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        attempts += 1;
        const result = await this.summaryCall(call, fitted.input, reminder);
        if (result.applied) {
          logger.info({ runId: this.run.id, trigger: c.trigger, attempts, batchRows: cut.batch.length, tailRows: cut.tail.length, update: previous !== null, inputTokens: fitted.tokens, flattenedUnits: fitted.flattened, omittedUnits: fitted.omittedUnits }, 'contexto compactado em checkpoint');
          return true;
        }
        failure = result.failure;
        // Uma segunda tentativa só para formato ou tamanho, com o lembrete, e só na primeira entrada da escada (um modelo que não segue o formato não passa a seguir por
        // receber menos texto, e repetir o lembrete em cada alvo multiplicaria a chamada paga); as outras falhas não melhoram repetindo a mesma entrada.
        if (result.retry !== null && attempt === 0 && step === 0) { reminder = result.retry; continue; }
        break;
      }
      // Conflito (o conteúdo mudou) não é culpa do modelo, e recusa que repetir não resolve não melhora com entrada menor: a escada para.
      if (failure === 'conflict' || failure === 'rejected') break;
      target = Math.floor(firstSize * (SUMMARY_RETRY_SHARES[step] ?? 0));
    }
    // `conflict` (o conteúdo coberto mudou, a revisão avançou, uma fonte da proveniência foi revogada ou a configuração mudou DURANTE a chamada) não grava recusa durável:
    // não foi o modelo que falhou. A linha do ledger fica `unknown` (a resposta válida não foi aplicada), então ESTA execução não repete a mesma entrada
    // (`summaryGivenUp` e o índice único de resumo pendente). A execução seguinte relê o conjunto e a entrada dela já é outra: conteúdo ou revisão diferentes mudam a
    // impressão, e fonte revogada sai saneada (`loadContext` troca a linha por marcador e o anexo vira "[indisponível]") ou invalida o checkpoint anterior, então
    // repetir ali não é pagar duas vezes pela mesma entrada.
    // ponytail: a chamada paga que terminou em conflito não é reaproveitada; reservar a fonte (`FOR SHARE`) até o commit, mantendo a transação aberta, só se revogações
    // durante um resumo passarem a ser frequentes.
    if (failure !== 'conflict') {
      await withTransaction(pool, async (tx) => {
        await holdLease(tx, this.run.id, this.owner);
        await recordSummaryRefusal(tx, { conversationId, impression, runId: this.run.id, model: summaryModel, outcome: failure, at: now() });
      });
    }
    logger.warn({ runId: this.run.id, trigger: c.trigger, attempts, failure, batchRows: cut.batch.length }, 'compactação sem checkpoint utilizável; o pedido segue sem ela');
    // O frio propaga a falha como o manual, só para `context_maintenance` guardar o recibo verdadeiro (código, `unknown` com chamada incerta); ao dono ela nunca aparece.
    if (manual || c.trigger === 'cold') throw new DomainError('CONTEXT_COMPACTION_FAILED');
    return false;
  }

  /**
   * UMA chamada paga de resumo, sem ferramentas, no modelo do resumo: reserva as fontes e abre a linha do ledger, lê o stream, julga a resposta (`judgeSummary`) e, se
   * válida, grava o checkpoint (`commitSummary`). Devolve `applied` ou a falha com o lembrete que vale uma segunda tentativa. Falha de transporte, aborto e posse perdida
   * sobem como exceção (o ledger fica `unknown`, e a execução não repete a chamada incerta, `summaryGivenUp`). `conflict`: o conteúdo coberto mudou durante a chamada, a
   * resposta válida é descartada sem aplicar e a linha também fica `unknown` (uso observado preservado), pela mesma regra: a execução não paga duas vezes a mesma
   * entrada depois de um crash entre o fechamento da linha e o desfecho (a retomada esbarra no índice único do resumo pendente). O texto da resposta nunca é logado, só contagens.
   */
  private async summaryCall(c: { conversationModel: string; summaryModel: string; protocol: ChatProtocol; apiKey: string; maxOutputTokens: number; requestOf: (input: SummaryInput, reminder: SummaryReminder | null) => ChatRequest; evidence: EvidenceProvenance; coveredIds: ReadonlySet<string>; coveredOriginals: readonly ContextRow[] }, input: SummaryInput, reminder: SummaryReminder | null): Promise<{ applied: true } | { applied: false; failure: SummaryFailure | 'conflict'; retry: SummaryReminder | null }> {
    const { pool, provider, logger, now } = this.deps;
    const request = c.requestOf(input, reminder);
    // Hashes do pedido do resumo (migration 0052), calculados fora da transação: o ledger separa a queda de cache também nas chamadas de resumo.
    const blocks = requestBlockHashes(request);
    const id = await withTransaction(pool, async (tx) => {
      await holdLease(tx, this.run.id, this.owner);
      await reserveModelSources(tx, this.run.conversation_id, this.run.bot_id, c.evidence);
      await this.validatePreparedConfiguration(tx, c.conversationModel);
      return startModelUsage(tx, this.run.conversation_id, this.run.id, 'summary', c.summaryModel, c.protocol, now(), contextFingerprint(request), c.evidence, this.preparationId, blocks);
    });
    let text = '', usage: ChatUsage = {}, finishReason: string | null = null, toolCalled = false, cutShort = false, settled = false;
    const interruption = this.interruption();
    let events: AsyncGenerator<ChatEvent> | undefined;
    try {
      events = provider.streamChat(c.apiKey, c.protocol, request, this.abort.signal)[Symbol.asyncIterator]();
      for (;;) {
        const next = await Promise.race([events.next(), interruption.promise]);
        if (next.done) break;
        const event = next.value;
        if (event.type === 'text') text += event.text;
        else if (event.type === 'usage') usage = event.usage;
        else if (event.type === 'tool_call') toolCalled = true;
        else if (event.type === 'done') finishReason = event.reason;
        // Muito acima do teto de 16.000 caracteres: não há o que salvar, e continuar lendo só paga saída à toa.
        if (text.length > 2 * SUMMARY_MAX_CHARS) { cutShort = true; void events.return?.(undefined).catch(() => undefined); break; }
      }
      const verdict = judgeSummary({ text, finishReason, toolCalled, outputTokens: usage.outputTokens, maxOutputTokens: c.maxOutputTokens, cutShort });
      // Uma resposta julgada (o stream terminou) fecha a linha como `completed` mesmo sem usage: o desfecho é conhecido e o custo fica nulo (cobertura parcial no painel).
      // `unknown` fica para o que não terminou (aborto, queda do provedor, exceção), único caso em que a execução não repete a chamada (`summaryGivenUp`).
      // `reasoningTokens` só entra quando o provedor informou (fatia de `outputTokens`, que continua o total e o que o veredito acima julga; nunca somar os dois).
      logger.info({ runId: this.run.id, finishReason, contentChars: [...text].length, outputTokens: usage.outputTokens ?? null, ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }), valid: verdict.ok, reminder }, 'desfecho da chamada de resumo');
      if (!verdict.ok) {
        const outcome = verdict.failure === 'output_limit' || verdict.failure === 'empty' ? verdict.failure : null;
        await withTransaction(pool, async (tx) => { await holdLease(tx, this.run.id, this.owner); await finishModelUsage(tx, id, usage, true, now(), outcome); });
        settled = true;
        return { applied: false, failure: verdict.failure, retry: verdict.retry };
      }
      const applied = await this.commitSummary(c, id, usage, verdict.text);
      // Resposta válida que não pôde ser aplicada: o custo é conhecido (`usage` fica gravado), mas a linha NÃO fecha como `completed`: `unknown` é o que impede a
      // retomada depois de um crash de pagar de novo a mesma entrada (índice único do resumo pendente, `startModelUsage`) e faz `summaryGivenUp` valer nesta execução.
      if (!applied) await withTransaction(pool, async (tx) => { await holdLease(tx, this.run.id, this.owner); await finishModelUsage(tx, id, usage, false, now()); });
      settled = true;
      return applied ? { applied: true } : { applied: false, failure: 'conflict', retry: null };
    } catch (error) {
      if (error instanceof StreamInterrupted) void events?.return?.(undefined).catch(() => undefined);
      // O provedor recusou o pedido de resumo antes de gerar qualquer coisa: sem custo e sem texto. Recusa por tamanho reduz a entrada; outra recusa encerra a escada.
      if (error instanceof ChatRejected) {
        // Como as demais baixas do ledger desta chamada: sob a posse da execução (uma posse perdida sobe como exceção e a chamada fica incerta no `finally`).
        await withTransaction(pool, async (tx) => { await holdLease(tx, this.run.id, this.owner); await finishModelUsage(tx, id, {}, true, now()); });
        settled = true;
        return { applied: false, failure: error.rejectedContext ? 'context' : 'rejected', retry: null };
      }
      throw error;
    } finally {
      interruption.dispose();
      // Qualquer saída sem desfecho conhecido (aborto, queda do provedor, exceção) deixa a chamada incerta.
      if (!settled) await finishModelUsage(pool, id, usage, false, now());
    }
  }

  /**
   * Grava o checkpoint numa ÚNICA transação: confere a proveniência e, contra o banco, que o conteúdo coberto não mudou (conteúdo mudou = descarta o resumo sem aplicar),
   * aplica a troca condicionada à revisão que a preparação leu (`commitContextSummary`, CAS) e fecha a linha do ledger como `applied`. Falso quando algo mudou ou outra
   * compactação chegou antes; nesse caso nada foi aplicado.
   */
  private async commitSummary(c: { conversationModel: string; evidence: EvidenceProvenance; coveredIds: ReadonlySet<string>; coveredOriginals: readonly ContextRow[] }, usageId: string, usage: ChatUsage, text: string): Promise<boolean> {
    const state = this.preparedContext;
    if (!state) return false;
    return withTransaction(this.deps.pool, async (tx) => {
      await holdLease(tx, this.run.id, this.owner);
      if (!await validateEvidence(tx, this.run.conversation_id, this.run.bot_id, c.evidence)) return false;
      const fresh = await loadManagedContext(tx, this.run.conversation_id);
      const current = fresh.rows.filter((row) => c.coveredIds.has(row.id!));
      if (current.length !== c.coveredIds.size || coverageFingerprint(current) !== coverageFingerprint(c.coveredOriginals)) return false;
      await this.validatePreparedConfiguration(tx, c.conversationModel);
      if (!await commitContextSummary(tx, this.run.conversation_id, state.checkpoint.revision, text, current, c.evidence, this.deps.now())) return false;
      // Estado recuperável e checkpoint são o mesmo commit; resposta recebida sozinha não autoriza repetição paga.
      await finishModelUsage(tx, usageId, usage, true, this.deps.now(), 'applied');
      return true;
    });
  }

  /**
   * Uma chamada ao modelo: prepara o pedido (medição, compactação e, em último caso, colapso) e depois transmite o texto para a conversa e junta as chamadas de
   * ferramenta que ele pedir.
   *
   * Preparação (phase 9, CTX-07): o pedido leva o histórico COMO FOI GRAVADO e só cresce no fim; nada é reescrito entre compactações (a única outra exceção é a limpeza da conversa fria, phase 11, T7, que só age depois de T = 40 minutos parada, acima do maior intervalo medido com cache válido, 30 minutos, com o cache morto em 60: `COLD_AFTER_MS` e `cache-ttl.md` da phase 11), então o provedor reaproveita o
   * prefixo do cache. A ocupação é a conta única de `occupancyOf` (ancorada no usage real da última chamada do mesmo modelo, ver `context-anchor.ts`). Ao chegar a
   * `COMPACTION_THRESHOLD` do orçamento de entrada (ou numa compactação manual, ou depois de o provedor recusar o pedido por contexto, `retryModel`), `compactContext`
   * troca o histórico antigo por um checkpoint e mantém o trecho final íntegro; se ela falhar ou não bastar, o colapso em índice (`context-collapse.ts`) entra só
   * quando o pedido passa de 100%. A falha do resumo automático nunca derruba a execução (C3).
   *
   * Catálogo de ferramentas: no BOT o campo `tools` é a lista FIXA de `botCatalogNames` (portas e mais usadas, phase 15, passos 11 e 12) e não muda dentro da conversa: as mais usadas só são recalculadas pelo uso quando a conversa esfria
   * (lidas em `ensureTools`, de `readMostUsedAnchor`) ou quando uma compactação é aplicada (`refreshMostUsed`, logo abaixo da aplicação do checkpoint), isto é, quando o prefixo já se perdeu; abrir um grupo (`abrir_grupo`) devolve o esquema no fim do histórico e não toca nele. No Chat geral (phase 12, F2) ele também só cresce dentro da conversa (as seleções de `discover_tools` se acumulam) e a única saída de uma opcional é uma compactação aplicada
   * (`applyCatalog`, abaixo), quando o prefixo já se perdeu, ou a recarga depois de uma recusa de contexto do provedor, que descarrega as opcionais só para aquele pedido; fora desses dois pontos ele é idêntico, byte a byte, em toda etapa e rodada sem descoberta nova.
   *
   * Configuração alterada (A15): se o modelo, a janela ou o effort mudam no meio da preparação (ou entre ela e o início da chamada), o pedido pronto não vale e a etapa é
   * preparada de novo UMA vez com a configuração vigente (`reprepareStep`; `reprepared` impede o laço, inclusive pela recarga depois de uma recusa do provedor). Uma
   * segunda mudança na mesma etapa encerra com `CONTEXT_CONFIGURATION_CHANGED`; a falta de `contextEvidence` encerra com `CONTEXT_EVIDENCE_UNAVAILABLE`. Nenhum dos dois é
   * falha de resumo, e `CONTEXT_COMPACTION_FAILED` fica restrito à compactação.
   */
  private async modelStep(retryModel?: string, maintenance?: MaintenanceKind, reprepared = false): Promise<StepOutcome> {
    this.preparationId=this.run.context_operation_id??randomUUID();
    const { pool, config, logger } = this.deps;
    let request: { apiKey: string; protocol: ChatProtocol; model: string; turns: ChatTurn[]; tools: ToolHandler['definition'][] | undefined; effort: string | undefined };
    /** Modelo "sem ferramentas" desta etapa (para avisar o dono), ou nulo. */
    let noToolsModel: string | null = null;
    let beforeInputTokens = 0;
    /** Estimativa final do pedido preparado: a mesma que o gatilho e a medição usaram, gravada ao lado do usage da chamada (base da âncora e da calibração). */
    let preparedEstimate: { textTokens: number; images: number } | null = null;
    /** Envelope da etapa (reserva de saída, margem e orçamento de entrada): a mesma `outputReserve` vai à estimativa, ao log e ao `max_tokens` do corpo, nunca `config.maxTokens` cru (F1, phase 12). */
    let envelope: ReturnType<typeof contextEnvelope>;
    try {
      const choice = await resolveModelChoice(pool, this.run.conversation_id);
      if (choice.model === null) return { status: 'failed', code: 'MODEL_UNAVAILABLE' };
      // A recarga (recusa de contexto do provedor) foi pedida para o modelo que recusou; o dono o trocou antes de ela começar (A15).
      if (retryModel !== undefined && choice.model !== retryModel) throw new DomainError('CONTEXT_CONFIGURATION_CHANGED');
      // A chave é a do provedor DO MODELO (`anthropic/...` usa a da Anthropic, o resto a do OpenCode Go), e a capacidade confirmada do modelo da Anthropic é carregada antes da janela ser calculada.
      const apiKey = await this.deps.credentials.requireKey(modelCredentialKind(choice.model));
      await this.deps.models.warmCapacity?.(choice.model);
      // Toda manutenção (a do dono e a fria) exige o protocolo já validado e nunca testa um modelo na hora: o teste é uma chamada paga que ninguém pediu.
      const profile = await this.modelProfile(choice.model,maintenance ? 'summarize' : false);
      // Calibração pelo usage real do mesmo modelo (`token-calibration.ts`): evita compactar com a janela ainda folgada. `calibrated` é "existe
      // amostra válida do modelo", não "a escala ficou abaixo de 1": a razão observada pode ser alta (texto denso em tokens) e a escala ficar em 1.
      const { scale, calibrated } = await readTokenCalibration(pool, choice.model);
      this.tokenScale = scale;
      // Abertura numa conversa fria que o worker ainda não tratou (F6): grava a limpeza antes de ler a âncora e o histórico, para as duas leituras já a enxergarem.
      await this.maskColdOnOpening();
      // Âncora da ocupação (`context-anchor.ts`, CTX-08): usage real da última chamada principal do mesmo modelo. A recarga depois de uma recusa de contexto
      // (`retryModel`) não a usa: o provedor acabou de dizer que o pedido não cabia, então a medição ancorada está errada e vale a estimativa calibrada.
      let anchor = retryModel === undefined ? await readContextAnchor(pool, this.run.conversation_id, choice.model) : null;
      noToolsModel = profile.status === 'no_tools' ? choice.model : null;
      // Modelo "sem ferramentas" falha até em chamar as internas: nenhuma ferramenta é oferecida a ele.
      const toolsOffered = profile.status !== 'no_tools';
      const registry = await this.ensureTools();
      // CHAT GERAL: as seleções de `discover_tools` são da CONVERSA (a manutenção, que não abre rodada, tem execução própria na mesma conversa): a união delas, na ordem da primeira, é o catálogo que só cresce.
      // BOT: a lista é fixa (portas e mais usadas) e não depende de seleção; as linhas antigas de `discover_tools` no histórico dele são só atividade.
      const selections: ToolSelectionHistory = registry.has(DISCOVER_TOOLS) ? await readToolSelectionHistory(pool, this.run.id) : { names: [], lastSelectedId: new Map() };
      // Imagens de rodadas anteriores só seguem no pedido onde o custo visual é conhecido (T10): senão uma imagem recusada na estimativa travaria toda mensagem seguinte.
      // As duas decisões também dizem ao carregador de quais imagens trazer os bytes do banco (só as que o pedido leva).
      const imageOptions = { acceptsImages: profile.acceptsImages, historyImages: visualCostKnown(choice.model, profile.protocol) };
      // O histórico é lido do banco uma vez por preparação (e de novo só depois de uma compactação aplicada); o colapso é uma projeção pura dele.
      let loaded = await this.loadContext(choice.model, imageOptions);
      const readAttachmentRefs = toolsOffered && registry.has(READ_ATTACHMENT_TOOL);
      const render = (extra: Partial<RenderOptions> = {}): ChatTurn[] => this.renderTurns(loaded, { ...imageOptions, readAttachmentRefs, ...extra });
      request = {
        apiKey,
        protocol: profile.protocol,
        model: choice.model,
        turns: render(),
        // O catálogo é montado por `applyCatalog`, depois de o envelope e a estimativa existirem.
        tools: undefined,
        // Um effort que o modelo deixou de aceitar (novo "testar novamente") é ignorado em vez de quebrar a execução.
        effort: choice.effort !== null && profile.levels.includes(choice.effort) ? choice.effort : undefined,
      };
      const resolution = await resolveConversationContextWindow(pool, this.run.conversation_id);
      if (resolution.effectiveTokens === null) return { status: 'failed', code: 'MODEL_UNAVAILABLE' };
      envelope = contextEnvelope(resolution.effectiveTokens, config.maxTokens, resolution.capacity?.outputTokens);
      const payload = () => ({ model: request.model, sessionId: this.run.conversation_id, turns: request.turns, tools: request.tools, effort: request.effort, maxTokens: envelope.outputReserve });
      /**
       * A ocupação de um conjunto de turnos (com as ferramentas e o envelope do pedido atual), fonte única de gatilho, medição gravada e decisão de "não
       * cabe", do pedido inteiro e do piso: ancorada no usage real quando há âncora válida, e a estimativa calibrada sem ela (CTX-06). Só
       * `estimatedInputTokens` muda; `textTokens` e `images` seguem crus para gravar a estimativa da chamada. O piso passa pela mesma conta porque o pedido
       * anterior, que a âncora mediu, já o continha: medir o piso pela estimativa calibrada e o total pela âncora recusaria (`CONTEXT_TOO_LARGE`) um pedido
       * que a própria âncora mostra caber.
       */
      const occupancyOf = (turns: ChatTurn[]) => {
        const measured = estimateChatPayload({ ...payload(), turns }, profile.protocol, undefined, scale);
        return anchor ? { ...measured, estimatedInputTokens: anchoredInputTokens(anchor, measured, scale) } : measured;
      };
      const estimate = () => occupancyOf(request.turns);
      /** O que NÃO é histórico: sistema e objetivo (os turnos fixos); com as ferramentas, é o piso obrigatório de toda chamada. */
      const baseTurns = () => request.turns.filter((turn) => turn.role === 'system' || (turn.role === 'user' && turn.text.startsWith('# Objetivo do bot')));
      const historyBudget = () => envelope.inputBudget - occupancyOf(baseTurns()).estimatedInputTokens;
      const historySize = () => estimate().estimatedInputTokens - (envelope.inputBudget - historyBudget());
      // A estimativa calibrada multiplica bytes por `scale` (de MIN_SCALE a 1): reservas em tokens voltam a bytes pela mesma razão.
      const bytesOf = (tokens: number) => Math.max(0, Math.floor(tokens / scale));
      if (!estimate().reliable) throw new DomainError('CONTEXT_ESTIMATE_UNAVAILABLE');
      /**
       * Catálogo de ferramentas da etapa (phase 12, F2; TOOL-01 substituída parcialmente). O registry continua completo para validação/replay: o que muda aqui é só a exposição dos schemas.
       * BOT (phase 15, passos 11 e 12): a lista é fixa (`botCatalogNames`: portas e mais usadas, estas de `this.mostUsed`), sem opcional, sem seleção, sem aviso de omitidas e sem teto de catálogo; `applyCatalog` devolve a
       * mesma coisa até a conversa esfriar ou a próxima compactação aplicada, que recalculam as mais usadas, e a rede de segurança (`dropOptionals`) não tem o que retirar. O restante desta nota vale para o CHAT GERAL, que segue com `discover_tools`.
       * O campo `tools` é função pura do que está gravado (as seleções de `discover_tools` da conversa e até onde o checkpoint vigente cobre), então é o MESMO em toda etapa e rodada enquanto nenhuma
       * seleção nova chega, só cresce no fim e não depende da escala de calibração: o prefixo do pedido segue em cache. As portas e as core nunca saem (regra do dono: função antes de custo).
       * O teto de CATALOG_SHARE só retira opcional DEPOIS de uma compactação aplicada, e só as que ela deixou para trás (selecionadas até o corte, a mais antiga primeiro), porque nesse ponto o prefixo já se
       * perdeu; antes dela o catálogo cresce sem teto e, se pesar, vale a compactação a 90% de sempre. A conta usa a estimativa de 1 byte por token e só sistema e objetivo (sem o histórico): a escala
       * muda de uma etapa para outra e mudaria o conjunto. A recarga depois da recusa do provedor (`retryModel`) descarrega todas as opcionais, só para aquele pedido. É chamada de novo, com o corte novo,
       * logo depois de uma compactação aplicada; as omitidas viram o aviso de `publish` (`withCatalogOmissions`), idêntico enquanto o conjunto não muda.
       * Rede de segurança (`dropOptionals`, exceção aceita pelo dono em 18/10/2026): em dois pontos, (a) piso acima do orçamento com calibração, antes da compactação, e (b) pedido que, mesmo depois da compactação possível e do colapso, só teria como saída a recusa (CONTEXT_TOO_LARGE), as opcionais publicadas saem
       * SÓ daquele pedido, pela mesma regra da recarga depois da recusa do provedor e com o aviso de omitidas, e a execução segue; quebra o cache só nesse caso extremo, como o colapso em índice.
       * ponytail: a conta de 1 byte por token é conservadora; numa janela de 64k o piso (sistema e core) passa do teto e toda opcional anterior à compactação sai (o modelo a seleciona de novo), trocar por
       * uma escala congelada na compactação se isso pesar.
       */
      let omittedTools: string[] = [];
      /** As opcionais saem todas, só deste pedido: a recarga depois da recusa do provedor, ou a rede de segurança (`dropOptionals`). */
      let dropAll = retryModel !== undefined;
      let optionalPublished = false;
      const applyCatalog = (): void => {
        if (!toolsOffered) return;
        const plan = selectCatalog(registry, selections, dropAll ? () => true : selectedBeforeCut(loaded.coveredThrough), this.mostUsed?.tools ?? []);
        const fitted = fitToolCatalog({ ...payload(), tools: [...plan.fixed, ...plan.droppable], turns: baseTurns() }, profile.protocol, dropAll ? 0 : Math.floor(envelope.inputBudget * CATALOG_SHARE), plan.fixed.map((tool) => tool.name));
        omittedTools = fitted.omitted;
        request.tools = [...plan.fixed, ...plan.optional.filter((tool) => !fitted.omitted.includes(tool.name))];
        optionalPublished = request.tools.length > plan.fixed.length;
      };
      applyCatalog();
      /** Rede de segurança: tira todas as opcionais publicadas deste pedido (o aviso de omitidas passa a citá-las). Falso se não há nenhuma publicada. Quem chama reconstrói os turnos (`publish(render())`). */
      const dropOptionals = (): boolean => {
        if (dropAll || !optionalPublished) return false;
        dropAll = true;
        applyCatalog();
        return true;
      };
      const publish = (turns: ChatTurn[]) => withCatalogOmissions(turns, omittedTools);
      request.turns = publish(request.turns);
      beforeInputTokens = estimate().estimatedInputTokens;
      /**
       * Como o pedido pronto foi compactado (estado, não evento): vai na medição para o indicador avisar, sem mensagem, cartão nem push. Só vale a compactação
       * AUTOMÁTICA feita para ESTE pedido: a manutenção manual (que mede o pedido que o dono acabou de compactar) não acende nada. `summary`: um checkpoint foi
       * aplicado nesta preparação (um antigo continua no pedido mas não foi feito para ele); `index`: o colapso de último recurso. `elision` é campo morto do contrato
       * da medição (medições antigas o trazem) e é sempre falso: a elisão deixou de existir.
       */
      const compaction = { elision: false, summary: false, index: false };
      // Nem o piso obrigatório (sistema, objetivo e o catálogo publicado: as portas, todas as core e as opcionais ainda protegidas) cabe: não há histórico a compactar que resolva. Com calibração
      // isso é definitivo (CONTEXT_TOO_LARGE). Sem ela o estimador é só um teto (1 byte = 1 token, ~3,5x o real) e o piso sozinho pode passar do teto sem
      // passar da janela de fato: o bot com a lista fixa, o conector e o Python numa janela efetiva de 32k (modelo com capacidade confirmada de 32k; a menor opção do dono é 64k) passa (~31,7 mil bytes, medidos em 07/11/2026, contra 22.528 de orçamento) mesmo cabendo em ~12 mil tokens reais.
      // Recusar aqui travaria o bot para sempre, porque sem uma chamada não existe usage para calibrar. Então a chamada segue, com o histórico no mínimo, e
      // quem arbitra é o provedor: recusa de contexto vira a recarga (compactação forçada e uma nova chamada) e uma segunda recusa vira CONTEXT_TOO_LARGE; o usage
      // de uma chamada aceita calibra as etapas seguintes. A mensagem nova e a etapa mais recente seguem no pedido (o colapso nunca as tira).
      // A exceção NÃO libera o pedido inteiro: ela só adia o veredito do PISO. O pedido final ainda é conferido abaixo na escala mais otimista plausível
      // (`MIN_SCALE`), então uma mensagem ou anexos enormes recusam aqui mesmo, sem chamada ao provedor.
      // ponytail: modelo que nunca informa usage nunca calibra e mantém a exceção em toda chamada, limitada só pelo `MIN_SCALE`; exigir a recusa do provedor
      // (e não só a estimativa otimista) se a chamada rejeitada, sem custo de saída, passar a pesar para esses modelos.
      let floorOverflow = historyBudget() <= 0;
      // Rede de segurança do catálogo (a): com calibração o piso acima do orçamento seria recusado (CONTEXT_TOO_LARGE); se há opcional selecionada publicada, ela sai só deste pedido e o piso é medido de novo.
      if (floorOverflow && calibrated && dropOptionals()) {
        request.turns = publish(render());
        floorOverflow = historyBudget() <= 0;
      }
      const provisional = floorOverflow && !calibrated;
      if (floorOverflow && !provisional) throw new DomainError('CONTEXT_TOO_LARGE');
      if (provisional) logger.info({ runId: this.run.id, inputBudget: envelope.inputBudget, floorTokens: envelope.inputBudget - historyBudget() }, 'piso obrigatório acima do orçamento sem calibração; o provedor arbitra a chamada');
      // Compactação (F3): no limiar único, no gesto manual, na compactação fria ou na recarga depois da recusa do provedor. O trecho final cabe em até TAIL_SHARE do orçamento,
      // e menos quando o piso é grande: o pedido recém-compactado volta a COMPACTION_SETTLE e não fica de novo no limiar (o que pagaria um resumo a cada etapa).
      // Gatilho frio (phase 11, T8, decisão 18; phase 15, passo 8a, decisão 2): a mesma ocupação `estimate()` acima, comparada a `coldTriggerTokens` (cerca de 40 mil tokens, nunca acima de 50% do
      // orçamento) em vez dos 90%; é por isso que a decisão do gatilho mora aqui e não no worker, que só enfileira: não existe segunda conta de ocupação. `triggerTokens` é o limiar do gatilho
      // em uso, também o que `compactContext` exige que o resumo ultrapasse para valer o custo (o frio compara com o dele, o automático com os 90%).
      const thresholdTokens = COMPACTION_THRESHOLD * envelope.inputBudget;
      const triggerTokens = maintenance === 'cold' ? coldTriggerTokens(envelope.inputBudget) : thresholdTokens;
      const trigger = maintenance === 'summarize' ? 'manual' : retryModel !== undefined ? 'forced' : estimate().estimatedInputTokens >= triggerTokens ? (maintenance === 'cold' ? 'cold' : 'threshold') : null;
      if (trigger !== null) {
        let applied = false;
        try {
          applied = await this.compactContext({ model: choice.model, profile, apiKey, loaded, inputBudget: envelope.inputBudget, outputReserve: envelope.outputReserve, trigger, thresholdTokens: triggerTokens, currentTokens: estimate().estimatedInputTokens,
            // Trecho final íntegro: até TAIL_SHARE do orçamento (menos quando o piso é grande) e, na compactação fria, ainda limitado para a abertura seguinte ficar perto de COLD_OPENING_TOKENS.
            tailTokens: Math.floor(Math.min(TAIL_SHARE * envelope.inputBudget, Math.max(0, historyBudget() - (1 - COMPACTION_SETTLE) * envelope.inputBudget),
              trigger === 'cold' ? coldTailTokens(envelope.inputBudget - historyBudget(), this.checkpointTokens()) : Number.POSITIVE_INFINITY)),
            costOf: (row) => costOfRow(row, scale) });
        } catch (error) {
          // O resumo AUTOMÁTICO nunca derruba a execução (C3): qualquer falha dele, exceto a parada, a posse perdida e o desligamento, vira "sem compactação" e o
          // colapso resolve se o pedido não couber. O resumo manual e o frio propagam a falha: o manual é o que o painel mostra ("nada foi alterado") e o frio a grava em
          // `context_maintenance` (só o recibo; a execução fria termina concluída para o dono, `finish`).
          if (maintenance !== undefined || error instanceof StreamInterrupted || error instanceof LeaseLostError || this.abort.signal.aborted) throw error;
          logger.warn({ runId: this.run.id, errorName: error instanceof Error ? error.name : typeof error, code: error instanceof DomainError ? error.code : undefined }, 'compactação automática falhou; o pedido segue sem ela');
        }
        if (applied) {
          // Checkpoint novo: o pedido mudou de forma. A âncora mediu o anterior (mesma regra de `readContextAnchor`, aplicada sem reler o banco) e o índice do
          // colapso, prefixo do pedido, também vale de novo do zero.
          anchor = null;
          this.collapseCut = null;
          loaded = await this.loadContext(choice.model, imageOptions);
          // O corte do catálogo mudou com o checkpoint: as opcionais que ele deixou para trás saem agora (é o único ponto), junto do prefixo que a compactação já reescreveu. O mesmo vale para as
          // "mais usadas" do bot (phase 15, passo 12): a compactação passou a ser o instante do último recálculo (`readMostUsedAnchor`), então a lista é recalculada AGORA, quando o prefixo já se perdeu, e vale até a conversa esfriar ou a próxima compactação.
          await this.refreshMostUsed();
          request.turns = render();
          applyCatalog();
          request.turns = publish(request.turns);
          compaction.summary = !maintenance;
        }
      }
      // Rede de segurança, sem chamada ao modelo (F4): o que a compactação não alcançou (resumo recusado ou falho, piso grande, rodada com dezenas de chamadas) vira
      // índice recuperável. Fica só o piso (sistema, objetivo, catálogo, abertura da rodada atual, mensagens do dono dela e etapa mais recente); CONTEXT_TOO_LARGE agora
      // só significa que esse piso não cabe, nunca que o histórico acumulado travou a conversa. O último degrau (`protectLatest` falso) também troca o texto dos anexos
      // das mensagens que seguem no pedido (a rodada atual e as anteriores que o colapso e o checkpoint não alcançaram) por referência (`read_attachment`, a mesma que o pedido
      // usa para a mensagem coberta por um checkpoint): um documento grande não pode derrubar a execução, e o texto do dono e a etapa mais recente seguem íntegros.
      // O corte tem histerese (cache do provedor): o vigente (`collapseCut`) é reaplicado enquanto o pedido couber em 100% do orçamento e só quando não
      // couber `fitByCollapse` recalcula, voltando à ocupação saudável (`COMPACTION_SETTLE`) com margem para vários passos sem mover o índice.
      const settleRequest = async () => {
        if (estimate().estimatedInputTokens > envelope.inputBudget) {
          await this.publishContextPhase('reducing');
          // Meta folgada: voltar à ocupação saudável; a mínima: ao menos caber no histórico que sobra depois do piso.
          const healthy = historyBudget() - (1 - COMPACTION_SETTLE) * envelope.inputBudget;
          const collapsed = fitByCollapse({ rows: loaded.visibleRows, size: (collapse, protectLatest) => { request.turns = publish(render({ collapse, ...(protectLatest ? {} : { attachmentsAsReferences: true }) })); return historySize(); }, targets: [healthy, historyBudget()], standing: this.collapseCut });
          this.collapseCut = collapsed.through === null ? null : { through: collapsed.through, lines: collapsed.lines, protectLatest: collapsed.protectLatest };
          if (!maintenance) compaction.index = collapsed.units > 0;
          logger.info({ runId: this.run.id, ...collapsed }, 'histórico antigo colapsado em índice por falta de espaço');
        } else this.collapseCut = null;
        const settled = estimate();
        if (!settled.reliable) throw new DomainError('CONTEXT_ESTIMATE_UNAVAILABLE');
        // Pedido final: com calibração (ou sem exceção do piso) vale a estimativa vigente. Na exceção do piso sem calibração, o teto de 1 byte por token deixa
        // de valer, mas o pedido ainda precisa caber na escala mais otimista plausível; o que passa disso não cabe nem na melhor hipótese.
        return { finalEstimate: settled, decisive: provisional ? estimateChatPayload(payload(), profile.protocol, undefined, MIN_SCALE) : settled };
      };
      let { finalEstimate, decisive } = await settleRequest();
      // Rede de segurança do catálogo (b): o pedido ainda não cabe depois da compactação e do colapso (o que sobra, como a mensagem do dono, o colapso nunca tira). Antes de recusar, as opcionais
      // selecionadas saem só deste pedido, com o aviso de omitidas, e o histórico é reduzido de novo sem elas (o corte do colapso de agora, feito com elas, seria mais fundo que o necessário).
      if (decisive.estimatedInputTokens > envelope.inputBudget && dropOptionals()) {
        this.collapseCut = null;
        compaction.index = false;
        request.turns = publish(render());
        ({ finalEstimate, decisive } = await settleRequest());
      }
      if (!maintenance && (compaction.summary || compaction.index)) logger.info({ runId: this.run.id, ...compaction, beforeInputTokens, inputTokens: estimate().estimatedInputTokens, inputBudget: envelope.inputBudget }, 'contexto compactado automaticamente antes da chamada');
      preparedEstimate = finalEstimate;
      if (decisive.estimatedInputTokens > envelope.inputBudget) throw new DomainError('CONTEXT_TOO_LARGE');
      this.resultPageBytes = Math.max(512, Math.min(RESULT_PAGE_MAX_BYTES, bytesOf(historyBudget() * 0.3)));
      // A medição é do request pronto, antes de conteúdo novo; esse conteúdo torna a leitura explicitamente desatualizada.
      await withTransaction(pool,async (tx) => {
        await holdLease(tx,this.run.id,this.owner);
        await this.validatePreparedConfiguration(tx,request.model);
        const contextEvidence = this.requireContextEvidence();
        await reserveModelSources(tx,this.run.conversation_id,this.run.bot_id,contextEvidence);
        const revision = await readContextRevision(tx,this.run.conversation_id);
        const measurement = { measuredAt:this.deps.now().toISOString(),method:finalEstimate.method,inputTokens:finalEstimate.estimatedInputTokens,inputBudget:envelope.inputBudget,outputReserve:envelope.outputReserve,margin:envelope.margin,availableTokens:Math.max(0,envelope.inputBudget-finalEstimate.estimatedInputTokens),excessTokens:Math.max(0,finalEstimate.estimatedInputTokens-envelope.inputBudget),stale:false,compaction };
        await tx.query("UPDATE conversation_context SET measurement=$2,measurement_revision=$3,phase='ready',measurement_provenance=$4 WHERE conversation_id=$1",[this.run.conversation_id,JSON.stringify(measurement),revision,JSON.stringify(contextEvidence)]);
        if (maintenance) {
          const rows = (await tx.query<{ run_id:string;purpose:'main'|'summary';state:string;summary_outcome:string|null;input_tokens:string|null;output_tokens:string|null;cached_tokens:string|null }>("SELECT run_id::text,purpose,state,summary_outcome,input_tokens::text,output_tokens::text,cached_tokens::text FROM model_call_usage WHERE run_id=$1",[this.run.id])).rows;
          await tx.query("UPDATE context_maintenance SET result=$2,outcome='completed' WHERE request_id=$1",[this.run.context_operation_id,JSON.stringify({changed:finalEstimate.estimatedInputTokens < beforeInputTokens || rows.some((row)=>row.state==='completed'&&row.summary_outcome==='applied'),beforeInputTokens,afterInputTokens:finalEstimate.estimatedInputTokens,summaryUsage:aggregateContextUsage(rows)})]);
        }
        await recordConversationEvent(tx,this.run.conversation_id,'context','0',this.deps.now());
      });
      if (maintenance) return {status:'completed'};
    } catch (error) {
      const halted = this.halted();
      if (halted) return halted;
      if (isConfigurationChange(error) && !reprepared) return this.reprepareStep(retryModel, maintenance);
      return this.failureOutcome(error);
    }

    if (noToolsModel !== null) await this.noteModelWithoutTools(noToolsModel);
    await this.recordCallModel(request.model);

    const stepRow = await pool.query<{ next: number }>('SELECT coalesce(max(step), 0) + 1 AS next FROM messages WHERE run_id = $1', [this.run.id]);
    const step = stepRow.rows[0]?.next ?? 1;
    // Uma linha por etapa permite medir descoberta e referências; somente contagens, nunca payloads.
    this.deps.logger.info({ runId: this.run.id, step, botId: this.run.bot_id, model: request.model, ...measureRequest(request.turns, request.tools), ...estimateChatPayload({ model: request.model, sessionId: this.run.conversation_id, turns: request.turns, tools: request.tools, effort: request.effort, maxTokens: envelope.outputReserve }, request.protocol) }, 'contexto enviado ao modelo');
    const writer = new TextWriter({
      pool,
      conversationId: this.run.conversation_id,
      runId: this.run.id,
      owner: this.owner,
      step,
      flushMs: config.flushMs,
      now: this.deps.now,
      evidence: this.contextEvidence,
      botId: this.run.bot_id,
    });
    const idle = this.startIdleWatchdog();
    const calls: ChatToolCall[] = [];
    let usage: ChatUsage = {};
    let outputLimited = false;
    let sawTerminal = false;
    let events: AsyncGenerator<ChatEvent> | undefined;
    const interruption = this.interruption();
    let usageId: string | null = null;
    // Hashes por bloco do pedido que vai ao provedor (migration 0052): `request` é exatamente o enviado logo abaixo, e a conta (uma passada de sha256) fica fora da transação do lease.
    const blocks = requestBlockHashes(request);
    try {
      usageId = await withTransaction(pool, async (tx) => {
        await holdLease(tx, this.run.id, this.owner);
        const contextEvidence = this.requireContextEvidence();
        await reserveModelSources(tx, this.run.conversation_id, this.run.bot_id, contextEvidence);
        await this.validatePreparedConfiguration(tx, request.model);
        const id = await startModelUsage(tx, this.run.conversation_id, this.run.id, 'main', request.model, request.protocol, this.deps.now(), null, contextEvidence, this.preparationId, blocks);
        // Amostra de calibração e âncora: a estimativa crua que a preparação acabou de usar (o pedido não muda entre a preparação e o envio), comparada
        // depois ao usage informado. Não é recalculada aqui: é a MESMA conta do gatilho, e uma segunda conta sobre o pedido enviado deixaria a amostra
        // diferente da âncora. A estimativa e o `max_tokens` do corpo abaixo usam o mesmo `envelope.outputReserve` (o menor entre `config.maxTokens`, 25% da
        // janela efetiva e a capacidade de saída confirmada do modelo), então não há desvio entre o número medido e o enviado.
        if (preparedEstimate) await recordUsageEstimate(tx, id, preparedEstimate);
        return id;
      });
      const stream = this.deps.provider.streamChat(
        request.apiKey,
        request.protocol,
        {
          model: request.model,
          // Uma conversa por bot: o id dela é a sessão estável que o provedor usa para rotear e reaproveitar o cache.
          sessionId: this.run.conversation_id,
          turns: request.turns,
          ...(request.tools ? { tools: request.tools } : {}),
          ...(request.effort ? { effort: request.effort } : {}),
          // O mesmo teto que a estimativa usou (`envelope.outputReserve`), já limitado pela janela e pela capacidade de saída confirmada do modelo: nunca `config.maxTokens` cru.
          maxTokens: envelope.outputReserve,
          // O 429 do provedor antes de qualquer evento é esperado e repetido pelo cliente (A22): a etapa só chama o modelo, então repetir antes do stream não duplica efeito.
          retryOnRateLimit: true,
        },
        this.abort.signal,
      );
      events = stream[Symbol.asyncIterator]();
      // A parada corre contra a leitura (como a ferramenta externa em `runTool`): abortar o `fetch` NEM SEMPRE encerra um stream já
      // em andamento (medido: o `fetch` do Node deixou de interromper a leitura em execuções iniciadas junto de outras e o texto
      // seguiu chegando até o fim natural do stream, com o dono já tendo pedido "Parar"). O pedido do dono não pode depender disso.
      for (;;) {
        const next = await Promise.race([events.next(), interruption.promise]);
        if (next.done) break;
        const event = next.value;
        idle.touch();
        if (event.type === 'text') writer.push(event.text);
        else if (event.type === 'usage') usage = event.usage;
        else if (event.type === 'done') {
          if (event.reason === 'unknown') throw new ChatStreamError('motivo terminal desconhecido');
          sawTerminal = true;
          outputLimited ||= event.reason === 'output_limit';
        }
        else if (event.type === 'tool_call') {
          // Alguns modelos não devolvem o id da chamada; o protocolo exige um para casar chamada e resultado.
          calls.push({ id: event.id || `call_${randomUUID().replaceAll('-', '')}`, name: event.name, arguments: event.arguments });
        }
      }
      if (!sawTerminal) throw new ChatStreamError('stream encerrado sem o evento final');
    } catch (error) {
      // Leitura abandonada: o gerador pode estar preso num `read()` e `return()` esperaria por ele, então não é aguardado.
      if (error instanceof StreamInterrupted) void events?.return?.(undefined).catch(() => undefined);
      idle.stop();
      // A configuração mudou entre o fim da preparação e a reserva da chamada (A15): nada foi enviado nem gravado como chamada, então a etapa prepara de novo (uma vez).
      if (isConfigurationChange(error) && !reprepared && !this.halted()) {
        await writer.cancel();
        return this.reprepareStep(retryModel, maintenance);
      }
      if (error instanceof ChatRejected && error.rejectedContext && !writer.wrote && calls.length === 0) {
        await writer.cancel();
        if (retryModel !== undefined) return { status: 'failed', code: 'CONTEXT_TOO_LARGE' };
        return this.modelStep(request.model, undefined, reprepared);
      }
      const halted = this.halted();
      if (halted?.status === 'released') {
        await writer.cancel();
        return halted;
      }
      await writer.finish();
      return halted ?? this.failureOutcome(error);
    } finally {
      if (usageId !== null) await finishModelUsage(pool, usageId, usage, sawTerminal, this.deps.now());
      interruption.dispose(); // o listener desta etapa não fica no sinal da execução (R22)
    }
    idle.stop();
    let cutoff: Outcome | { continueAutomatically: true } | undefined;
    await writer.finish(outputLimited, outputLimited ? async (tx) => { cutoff = await this.checkpointOutputCut(tx); } : undefined);
    // A resposta concluída muda a revisão da conversa: a medição passa a ser a entrada real desta chamada, sem "Desatualizado" pelo que o próprio bot gravou.
    // O usage só vira medição se for plausível frente à estimativa crua do mesmo pedido (a regra da âncora); a decisão fica em `settleMeasurementAfterResponse`.
    // Fechar o indicador é acessório: a resposta já está gravada e a próxima preparação mede e regrava a medição. Por isso uma falha de banco aqui (que não
    // seja a perda da posse, que continua subindo e encerra a execução sem registrar nada) não pode virar INTERNAL_ERROR de uma execução que respondeu.
    try {
      await withTransaction(pool, async (tx) => {
        await holdLease(tx, this.run.id, this.owner);
        if (await settleMeasurementAfterResponse(tx, this.run.conversation_id, usage.inputTokens, preparedEstimate?.textTokens, this.deps.now())) await recordConversationEvent(tx, this.run.conversation_id, 'context', '0', this.deps.now());
      });
    } catch (error) {
      if (error instanceof LeaseLostError) throw error;
      this.deps.logger.warn({ runId: this.run.id, conversationId: this.run.conversation_id, step, errorName: error instanceof Error ? error.name : typeof error, err: databaseErrorForLog(error) }, 'medição do contexto não regravada após a resposta; a próxima preparação a refaz');
    }
    // Uma linha por etapa concluída, só identificadores e números; ausência de usage mantém os campos ausentes (inclusive `reasoningTokens`, que o `...usage` só traz quando o provedor o informou).
    this.deps.logger.info({ runId: this.run.id, step, model: request.model, protocol: request.protocol, ...usage,
      ...(usage.inputTokens !== undefined && usage.inputTokens > 0 && usage.cachedTokens !== undefined ? { cachedFraction: usage.cachedTokens / usage.inputTokens } : {}),
    }, 'uso de tokens do modelo');
    // O motivo terminal vale para a resposta inteira: nem chamadas aparentemente completas desta etapa são autorizadas.
    if (cutoff) return cutoff;
    return { step, calls };
  }

  /** Estado real da preparação automática/manual, sem cartão ou execução paralela. */
  private async publishContextPhase(phase:'reducing'|'summarizing'):Promise<void> {
    // A compactação fria é invisível ao dono (spec, decisão 22): ela não publica fase nenhuma, então o painel segue em `ready` enquanto ela roda.
    if (this.coldMaintenance) return;
    await withTransaction(this.deps.pool,async(tx)=>{
      await holdLease(tx,this.run.id,this.owner);
      const updated=await tx.query('UPDATE conversation_context SET phase=$2 WHERE conversation_id=$1 AND phase<>$2',[this.run.conversation_id,phase]);
      if(updated.rowCount) await recordConversationEvent(tx,this.run.conversation_id,'context','0',this.deps.now());
    });
  }

  /** Recupera um corte terminal já checkpointado antes da queda; queued manual é uma intenção nova e não usa este caminho. */
  private async pendingTokenTerminal(): Promise<Outcome | null> {
    const last = (await this.deps.pool.query<{ id: string; data: Extract<SystemCard, { type: 'run_limit' }> }>("SELECT id::text, data FROM messages WHERE run_id=$1 AND kind='card' AND data->>'type'='run_limit' ORDER BY messages.id DESC LIMIT 1", [this.run.id])).rows[0];
    return last?.data.limit === 'tokens' && last.data.continuation?.automatic === false && !last.data.continuedManually ? { status: 'limit_reached', limit: 'tokens', cardId: last.id } : null;
  }

  /** Corte e orçamento automático são gravados com o texto incomplete sob a mesma posse; restart e gesto manual não zeram contadores. */
  private async checkpointOutputCut(tx: PoolClient): Promise<Outcome | { continueAutomatically: true }> {
    const stop = (await tx.query<{ stop_requested_at: Date | null }>('SELECT stop_requested_at FROM runs WHERE id=$1', [this.run.id])).rows[0];
    if (stop?.stop_requested_at) this.abortWith('stop');
    const halted = this.halted(); if (halted) return halted;
    const previous = (await tx.query<{ data: Extract<SystemCard, { type: 'run_limit' }> }>("SELECT data FROM messages WHERE run_id=$1 AND kind='card' AND data->>'type'='run_limit' AND data->>'limit'='tokens' ORDER BY id DESC LIMIT 1", [this.run.id])).rows[0]?.data.continuation;
    const activities = (await tx.query<{ label: string }>("SELECT data->>'label' AS label FROM messages WHERE run_id=$1 AND kind='activity' AND status='completed' ORDER BY id", [this.run.id])).rows;
    const confirmedTools = activities.length;
    const consecutiveCuts = previous && confirmedTools <= previous.confirmedTools ? previous.consecutiveCuts + 1 : 1;
    const count = previous?.count ?? 0;
    const automatic = count < 3 && consecutiveCuts < 2;
    const continuation = { automatic, count: count + (automatic ? 1 : 0), consecutiveCuts, confirmedTools };
    const card: SystemCard = { type: 'run_limit', limit: 'tokens', steps: activities.map((activity) => activity.label), continuation };
    const content = `A resposta anterior atingiu o limite de saída e está incompleta. Nenhuma chamada da etapa truncada foi executada. ${automatic ? `Continuação automática ${continuation.count}/3.` : 'Continuação automática encerrada: teto ou cortes consecutivos sem progresso atingido.'} Ao continuar, prossiga do contexto e dos resultados confirmados; não repita ações concluídas. Reduza os lotes e a saída: faça poucas chamadas por resposta e não reproduza estruturas ou dados já recebidos.`;
    const at = this.deps.now();
    const inserted = await tx.query<{ id: string }>("INSERT INTO messages (conversation_id,run_id,role,kind,status,content,data,created_at) VALUES ($1,$2,'system','card','done',$3,$4,$5) RETURNING id::text", [this.run.conversation_id, this.run.id, content, JSON.stringify(card), at]);
    await tx.query('UPDATE runs SET active_ms=$2 WHERE id=$1', [this.run.id, this.activeMs()]);
    await recordConversationEvent(tx, this.run.conversation_id, 'message', inserted.rows[0]!.id, at);
    return automatic ? { continueAutomatically: true } : { status: 'limit_reached', limit: 'tokens', cardId: inserted.rows[0]!.id };
  }

  // ---------------------------------------------------------------------------------------------
  // Ferramentas
  // ---------------------------------------------------------------------------------------------

  /**
   * Grava a atividade como `running` e conta a chamada no limite, dentro da transação dada (que já segura a posse). Com
   * `awaitingApproval` ela nasce marcada "aguardando aprovação" (a tela mostra o relógio em vez do indicador de execução); com
   * `external` fica registrado que a ferramenta tem efeito fora do Aion (a retomada após um reinício usa isso, ver `recover`).
   */
  private async writeActivity(
    tx: Queryable,
    call: RunnableCall,
    label: string,
    step: number,
    at: Date,
    { external = false, awaitingApproval = false }: { external?: boolean; awaitingApproval?: boolean } = {},
  ): Promise<string> {
    const data: ConnectorActivityData = {
      callId: call.id,
      tool: call.name,
      label,
      arguments: truncate(call.arguments, ARGUMENTS_MAX_CHARS),
      detail: null,
      ...(call.via ? { via: call.via } : {}),
      ...(call.accountName === undefined ? {} : { accountName: call.accountName }),
      ...(external ? { external: true } : {}),
      ...(awaitingApproval ? { awaitingApproval: true } : {}),
    };
    // Referência validada antes da leitura: uma exclusão reconhece inclusive a ferramenta ainda running.
    if (call.name === READ_ATTACHMENT_TOOL) {
      let args: unknown;
      try { args = JSON.parse(call.arguments); } catch { args = null; }
      const parsed = readAttachmentArgsSchema.safeParse(args);
      if (parsed.success) {
        const file = await tx.query<{ kind: AttachmentKind; removed: boolean }>('SELECT kind, removed_at IS NOT NULL AS removed FROM attachments WHERE id = $1 AND conversation_id = $2 AND message_id IS NOT NULL FOR UPDATE', [parsed.data.attachmentId, this.run.conversation_id]);
        const row = file.rows[0];
        if (row && !row.removed) data.detail = { type: 'attachment_read', attachmentId: parsed.data.attachmentId, kind: row.kind, offset: parsed.data.offset };
      }
    }
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO messages (conversation_id, run_id, role, kind, status, step, data, created_at, tool_arguments, evidence_provenance)
       VALUES ($1, $2, 'assistant', 'activity', 'running', $3, $4, $5, $6, $7) RETURNING id`,
      [this.run.conversation_id, this.run.id, step, JSON.stringify(data), at, Buffer.byteLength(call.arguments, 'utf8') <= 1024 * 1024 ? call.arguments : null, this.contextEvidence === undefined ? null : JSON.stringify(this.contextEvidence)],
    );
    const id = (inserted.rows[0] as { id: string }).id;
    await tx.query('UPDATE runs SET tool_calls = tool_calls + 1 WHERE id = $1', [this.run.id]);
    await recordConversationEvent(tx, this.run.conversation_id, 'message', id, at);
    return id;
  }

  /** Grava a atividade (como `running`) e conta a chamada no limite, na mesma transação. */
  private insertActivity(call: RunnableCall, label: string, step: number, external: boolean): Promise<string> {
    const at = this.deps.now();
    return withTransaction(this.deps.pool, async (tx) => {
      await holdLease(tx, this.run.id, this.owner);
      return this.writeActivity(tx, call, label, step, at, { external });
    });
  }

  /**
   * União sob lease antes de trabalho longo/settle; metadados revogados não voltam a conceder acesso. `removed` é o recurso que a própria atividade acabou de excluir (confirmado por recibo,
   * `settleActivity`): a evidência herdada do contexto pode citá-lo (lido antes), e ele sai da união, senão a validação falharia por um recurso que a atividade mesma apagou.
   */
  private async persistActivityEvidence(tx: Queryable, id: string, evidence: EvidenceProvenance, removed?: { tableId: string } | { docId: string }): Promise<void> {
    const saved = await tx.query<{ evidence_provenance: unknown }>('SELECT evidence_provenance FROM messages WHERE id=$1 AND run_id=$2 FOR UPDATE', [id, this.run.id]);
    const previous = parseEvidence(saved.rows[0]?.evidence_provenance);
    const merged = mergeEvidence(...(previous ? [previous] : []), evidence);
    const closure = removed === undefined ? merged : { ...merged, tables: merged.tables.filter((table) => !('tableId' in removed) || table.tableId !== removed.tableId), docs: merged.docs.filter((doc) => !('docId' in removed) || doc.docId !== removed.docId) };
    if (!await validateEvidence(tx, this.run.conversation_id, this.run.bot_id, closure)) throw new ToolFailure('A fonte desta evidência não está mais disponível.');
    await tx.query('UPDATE messages SET evidence_provenance=$2::jsonb WHERE id=$1 AND run_id=$3', [id, JSON.stringify(closure), this.run.id]);
  }

  /**
   * Fecha a atividade com o resultado e o detalhe para a tela. `genericResult` marca o resultado de uma ferramenta SEM limite próprio (`ActivityData.genericResult`):
   * é só ele que a tela mostra limitado, porque o envelope de uma ferramenta autolimitada (tabelas, página do anexo) não pode ser cortado em texto. `artifacts` são os artefatos que a chamada criou
   * ou alterou (`ToolOutcome.artifacts`, A4 da phase 14): gravados no dado da atividade junto do `label`, só quando a chamada CONCLUIU, e sem nenhuma linha de cartão (a bolinha de não lido e o push
   * só contam a resposta do bot e os cartões de sistema).
   */
  private async settleActivity(id: string, status: 'completed' | 'failed', result: string, detail: ActivityDetail | null, label?: string, evidence?: EvidenceProvenance, removal?: ConfirmedRemoval, genericResult = false, artifacts?: readonly ArtifactRef[]): Promise<void> {
    const { pool, now } = this.deps;
    const at = now();
    await withTransaction(pool, async (tx) => {
      await holdLease(tx, this.run.id, this.owner);
      if (removal) {
        // Exclusão de tabela ou de doc: só vale com o recibo durável da própria exclusão (o mesmo recurso, a mesma operação e o resultado que está sendo fechado).
        const activity = (await tx.query<{ tool_arguments: string; data: ActivityData }>('SELECT tool_arguments,data FROM messages WHERE id=$1 AND run_id=$2', [id, this.run.id])).rows[0];
        if ('tableId' in removal) {
          const receipt = activity?.data.tool === 'table_delete_table' ? await readTableRemovalReceipt(tx, this.run.bot_id, activity.tool_arguments) : null;
          if (!receipt || receipt.confirmedTableRemoval?.tableId !== removal.tableId || receipt.confirmedTableRemoval.operationId !== removal.operationId || receipt.result !== result) throw new ToolFailure('Recibo de exclusão incompatível.');
        } else if (activity?.data.tool !== DOC_DELETE_TOOL || !await docRemovalConfirmed(tx, this.run.bot_id, activity.tool_arguments, removal, result)) throw new ToolFailure('Recibo de exclusão incompatível.');
        if (evidence) await this.persistActivityEvidence(tx, id, evidence, 'tableId' in removal ? { tableId: removal.tableId } : { docId: removal.docId });
      } else if (evidence) await this.persistActivityEvidence(tx, id, evidence);
      // Defesa de fechamento: um arquivo já removido nunca ressuscita por resultado capturado antes da exclusão.
      if (detail?.type === 'attachment_read') {
        const file = await tx.query<{ removed: boolean }>('SELECT removed_at IS NOT NULL AS removed FROM attachments WHERE id = $1 AND conversation_id = $2 FOR UPDATE', [detail.attachmentId, this.run.conversation_id]);
        if (!file.rows[0] || file.rows[0].removed) { result = '[conteúdo removido]'; detail = null; }
      }
      await tx.query('UPDATE messages SET status = $2, content = $3, data = data || $4::jsonb WHERE id = $1', [
        id,
        status,
        result,
        JSON.stringify({ detail, ...(label === undefined ? {} : { label }), ...(genericResult ? { genericResult: true } : {}), ...(status === 'completed' && artifacts?.length ? { artifacts } : {}) }),
      ]);
      await recordConversationEvent(tx, this.run.conversation_id, 'message', id, at);
    });
  }

  /**
   * Troca o detalhe de uma atividade ainda em andamento (ex.: `run_python` passa de "aguardando vaga" a "executando"), sob a posse, e avisa as telas
   * abertas pelo evento da mensagem. Só o detalhe muda: estado, rótulo e resultado continuam com `settleActivity`.
   */
  private async reportActivity(id: string, detail: ActivityDetail): Promise<void> {
    const at = this.deps.now();
    await withTransaction(this.deps.pool, async (tx) => {
      await holdLease(tx, this.run.id, this.owner);
      await tx.query("UPDATE messages SET data = data || $2::jsonb WHERE id = $1 AND status = 'running'", [id, JSON.stringify({ detail })]);
      await recordConversationEvent(tx, this.run.conversation_id, 'message', id, at);
    });
  }

  /**
   * Executa a ferramenta. Uma ferramenta EXTERNA corre contra a parada: se a execução for interrompida, ela não é esperada
   * nem desfeita, e o cartão avisa que pode ter sido concluída. As internas terminam (são rápidas e locais). `proof` é a prova
   * de aprovação que o portão emitiu e que a ferramenta externa exige (ver `proof.ts`).
   */
  private async runTool(handler: ToolHandler, prepared: PreparedCall, proof: ApprovalProof | undefined, activityId: string): Promise<ToolOutcome> {
    const saved = await this.deps.pool.query<{ evidence_provenance: unknown; tool_arguments: string }>('SELECT evidence_provenance,tool_arguments FROM messages WHERE id=$1 AND run_id=$2', [activityId, this.run.id]);
    if (handler.definition.name === 'table_delete_table' && saved.rows[0]?.tool_arguments) {
      const receipt = await readTableRemovalReceipt(this.deps.pool, this.run.bot_id, saved.rows[0].tool_arguments);
      if (receipt) return receipt;
    }
    const evidence = parseEvidence(saved.rows[0]?.evidence_provenance) ?? this.contextEvidence;
    const context = {
      evidence,
      resultPageBytes: this.resultPageBytes,
      recordEvidence: (source: EvidenceProvenance) => withTransaction(this.deps.pool, async (tx) => {
        await holdLease(tx, this.run.id, this.owner);
        await this.persistActivityEvidence(tx, activityId, source);
      }),
      pool: this.deps.pool,
      conversationId: this.run.conversation_id,
      botId: this.run.bot_id,
      runId: this.run.id,
      leaseOwner: this.owner,
      signal: this.abort.signal,
      now: this.deps.now,
      activity: { id: activityId, report: (detail: ActivityDetail) => this.reportActivity(activityId, detail) },
      ...(proof ? { approval: proof } : {}),
    };
    if (!handler.external) return prepared.execute(context);
    if (this.abort.signal.aborted) throw new ExternalInterrupted();
    const interruption = this.interruption();
    try {
      return await Promise.race([prepared.execute(context), interruption.promise]);
    } catch (error) {
      if (error instanceof StreamInterrupted) {
        this.maybeCompleted.push(prepared.label);
        throw new ExternalInterrupted();
      }
      throw error;
    } finally {
      // A mesma execução pode chamar dezenas de ações; o listener só pertence à chamada em andamento.
      interruption.dispose();
    }
  }

  /**
   * Registro de TENTATIVA, gravado ANTES de uma ação do Composio executar. Uma queda entre a ação e o registro do resultado não
   * deixa uma ação externa sem rastro. Não é best-effort: se não for possível gravar, a exceção sobe e a ação NÃO executa
   * (falha fechada: sem rastro, sem ação). Leva a conta (id mascarado e nome, A10), nunca a chave do Composio. `basis` é a base da aprovação (`ApprovalProof.basis`) e vai no campo `basis` do
   * evento; antes da phase 15 o campo se chamava `via`, o mesmo nome que a atividade usa para a porta (`RunnableCall.via`), e o passo da `use_tool` os separou (E5).
   */
  private async auditActionStarted(slug: string, basis: string, account: ToolAccount | undefined): Promise<void> {
    await recordAudit(
      this.deps.pool,
      { action: 'composio.action_started', outcome: 'success', actor: 'system', target: slug, details: { bot: this.run.bot_id, run: this.run.id, basis, ...accountAudit(account) } },
      this.deps.now(),
    );
  }

  /**
   * Auditoria do RESULTADO de uma ação do Composio (ação, bot, conta e resultado; nunca argumentos nem resultado). Falha de auditoria só é logada. `extra` leva o motivo de uma recusa de conta
   * (`reason`), auditada com resultado `denied` e sem `composio.action_started`, porque a ação nunca começou. `basis`: base da decisão (`allow_rule` e `owner_approved` da prova de aprovação, ou o motivo
   * da recusa: `rule`, `owner`, `account`, `general_chat`, `action_changed`); nunca o nome da porta pela qual o modelo chamou.
   */
  private async auditAction(slug: string, outcome: AuditOutcome, basis: string, account?: ToolAccount | null, extra: Record<string, string> = {}): Promise<void> {
    try {
      await recordAudit(
        this.deps.pool,
        { action: 'composio.action', outcome, actor: 'system', target: slug, details: { bot: this.run.bot_id, run: this.run.id, basis, ...accountAudit(account), ...extra } },
        this.deps.now(),
      );
    } catch (error) {
      this.deps.logger.error({ err: error, runId: this.run.id }, 'falha ao auditar a ação do Composio');
    }
  }

  /**
   * Valida, RESOLVE A REGRA, grava, executa e fecha uma chamada de ferramenta. Devolve um desfecho se a execução precisa parar
   * (parada, prazo, worker encerrando) ou pausou esperando aprovação. `remaining` são as chamadas da mesma etapa que vêm depois
   * desta: se esta pausar, o pedido as guarda para a retomada.
   */
  private async executeCall(call: ChatToolCall, step: number, remaining: readonly ChatToolCall[]): Promise<Outcome | null> {
    const before = this.halted();
    if (before) return before;

    // Uma chamada de "porta" (o conector, T29, ou a `use_tool`, phase 15) é tratada, daqui em diante, como a do destino: o portão lê as flags e a `action` DELE (E1), e o `inspect` dele roda antes (DOC-01).
    const front = (await this.ensureTools()).get(call.name);
    const oversized = Buffer.byteLength(call.arguments, 'utf8') > 1024 * 1024;
    // Ganha a conta (`account`) quando o destino é resolvido, e é a chamada gravada na atividade e no pedido de aprovação.
    let runnable: RunnableCall = oversized ? call : toRunnableCall(call, front);
    let handler: ToolHandler | undefined;
    let prepared: PreparedCall | null = null;
    let label = runnable.name;
    let result = '';
    let impact: ApprovalImpact | undefined;
    try {
      if (oversized) throw toolFailure('PAYLOAD_TOO_LARGE', 'Os argumentos excedem o limite permitido.');
      // O destino do conector é resolvido POR BOT e a cada chamada: a conta pedida (pelo nome que o modelo escreveu) é conferida contra as liberações do banco (CONN-02, A3, A4).
      handler = runnable.via !== undefined ? await front?.target?.(runnable.name, { botId: this.run.bot_id, ...(runnable.accountName === undefined ? {} : { accountName: runnable.accountName }) }) : front;
      if (!handler) throw unknownCallFailure(runnable.name, runnable.via, this.run.bot_id !== null);
      if (handler.account) runnable = { ...runnable, account: handler.account };
      prepared = handler.prepare(runnable.arguments);
      label = prepared.label;
      // `inspect` confere o que o portão precisa ANTES de resolver a regra: o acesso do bot ao recurso (tabela ou doc) e o impacto que o cartão mostra (a tabela, ou o id e o título do doc lidos no
      // servidor, decisão 23). A falha (bot sem acesso, id inexistente) cai no `catch` como resultado da chamada, igual à de um id que não existe, sem passar pelo portão: nenhuma aprovação, cartão,
      // título nem atividade aguardando nasce (A13). O impacto só chega ao cartão por `pauseForApproval`; nunca vem dos argumentos do modelo.
      if (prepared.inspect) impact = await prepared.inspect({ pool: this.deps.pool, botId: this.run.bot_id, runId: this.run.id, conversationId: this.run.conversation_id, signal: this.abort.signal, now: this.deps.now });
    } catch (error) {
      if (!(error instanceof ToolFailure)) throw error;
      // Recusa de conta: a ação nunca começa (sem `composio.action_started`); fica auditada como negada, com o motivo, e o modelo lê a mensagem como resultado.
      if (error instanceof AccountRefusal) await this.auditAction(runnable.name, 'denied', 'account', error.account, { reason: error.reason });
      prepared = null;
      result = failureResult(error);
    }

    // Portão único para ações externas e destrutivas locais: resolver regra antes do efeito e emitir prova.
    // external mantém apenas a semântica de interrupção/ambiguidade do conector; approvalRequired não a herda.
    // Ação sem identidade falha fechada; chamadas inválidas nunca chegam à resolução da regra.
    let proof: ApprovalProof | undefined;
    if (prepared && (handler?.external || handler?.approvalRequired)) {
      const action = handler.action;
      if (!action) {
        this.deps.logger.error({ runId: this.run.id, tool: call.name }, 'ferramenta externa sem action: recusada pelo portão de aprovação');
        prepared = null;
        result = EXTERNAL_WITHOUT_ACTION;
      } else {
        const verdict = await this.deps.approvals.resolve(this.deps.pool, this.run.bot_id, action);
        if (verdict === 'ask') return this.pauseForApproval(runnable, step, label, action, remaining, handler.external, impact);
        if (verdict === 'deny') {
          const activityId = await this.insertActivity(runnable, label, step, handler.external);
          if (handler.external) await this.auditAction(action.slug, 'denied', 'rule', handler.account);
          await this.settleActivity(activityId, 'failed', NOT_EXECUTED_RESULTS.deniedByRule, null);
          return this.halted();
        }
        proof = grantApprovalProof(action.slug, 'allow_rule');
      }
    }

    const activityId = await this.insertActivity(runnable, label, step, handler?.external === true);
    return this.runAndSettle(activityId, runnable, handler, prepared, result, proof);
  }

  /** Executa o que há para executar (se a validação passou) e fecha a atividade com o resultado. */
  private async runAndSettle(
    activityId: string,
    call: ChatToolCall,
    handler: ToolHandler | undefined,
    prepared: PreparedCall | null,
    initialResult: string,
    proof: ApprovalProof | undefined,
  ): Promise<Outcome | null> {
    let status: 'completed' | 'failed' = 'failed';
    let result = initialResult;
    let detail: ActivityDetail | null = null;
    let finalLabel: string | undefined;
    let evidence: EvidenceProvenance | undefined;
    let removal: ConfirmedRemoval | undefined;
    let artifacts: ArtifactRef[] | undefined;
    if (prepared && handler) {
      try {
        // Tentativa registrada ANTES do efeito externo; se não grava, cai no `catch` abaixo e a ação não executa.
        if (handler.external && proof && handler.action) await this.auditActionStarted(handler.action.slug, proof.basis, handler.account);
        const outcome = await this.runTool(handler, prepared, proof, activityId);
        evidence = outcome.evidence;
        removal = outcome.confirmedTableRemoval ?? outcome.confirmedDocRemoval;
        status = 'completed';
        result = outcome.result;
        detail = outcome.detail ?? null;
        finalLabel = outcome.label;
        artifacts = outcome.artifacts;
      } catch (error) {
        // Worker encerrando: a chamada fica `running` e a retomada a fecha (ver `recover`).
        if (this.reason === 'shutdown' || this.reason === 'lease_lost') return { status: 'released' };
        if (error instanceof ToolFailure) {
          result = failureResult(error);
          detail = error.detail;
        } else if (error instanceof ExternalInterrupted) result = INTERRUPTED_EXTERNAL;
        else {
          // Bug da ferramenta: o detalhe (mensagem, caminho, consulta) vai só ao log; o modelo recebe a falha genérica do registro, que diz o que fazer (A16).
          this.deps.logger.error({ err: error, runId: this.run.id, tool: call.name }, 'ferramenta falhou de forma inesperada');
          result = failureEnvelope('TOOL_FAILED');
        }
      }
    }
    if (handler?.external && handler.action && proof) {
      await this.auditAction(handler.action.slug, status === 'completed' ? 'success' : 'failure', proof.basis, handler.account);
    }
    if (handler?.resultLimitBytes && Buffer.byteLength(result, 'utf8') > handler.resultLimitBytes) {
      status = 'failed';
      // Limite genérico de resultado (A21): código próprio, e não o da consulta de tabelas; a mensagem diz o que fazer.
      result = failureEnvelope('TOOL_RESULT_TOO_LARGE');
    }
    const generic = !limitsOwnResult(call.name, handler);
    await this.settleActivity(activityId, status, generic ? limitStoredResult(result) : result, detail, finalLabel, evidence, removal, generic, artifacts);
    return this.halted();
  }

  // ---------------------------------------------------------------------------------------------
  // Aprovação: pausa e retomada
  // ---------------------------------------------------------------------------------------------

  /**
   * A regra mandou perguntar: grava, numa transação só, a atividade (aguardando), o pedido com a chamada e as restantes da etapa, o
   * cartão da conversa e a mudança da execução para `waiting_approval`, que devolve a posse e para o relógio do tempo ativo. Depois
   * disso o executor termina sem registrar desfecho: quem retoma é o motor, quando o dono responder (ver o cabeçalho).
   */
  private async pauseForApproval(
    call: RunnableCall,
    step: number,
    label: string,
    action: ActionInfo,
    remaining: readonly ChatToolCall[],
    external: boolean,
    impact?: ApprovalImpact,
  ): Promise<Outcome> {
    const { pool, now, approvals } = this.deps;
    const at = now();
    await withTransaction(pool, async (tx) => {
      await holdLease(tx, this.run.id, this.owner);
      const activityId = await this.writeActivity(tx, call, label, step, at, { external, awaitingApproval: true });
      await approvals.createPending(tx, {
        runId: this.run.id,
        botId: this.run.bot_id,
        conversationId: this.run.conversation_id,
        action,
        ...(call.account ? { accountLabel: call.account.label } : {}),
        step,
        activityId,
        call,
        remaining: [...remaining],
        ...(impact ? { impact } : {}),
      });
      // Push "Aprovação pendente", gravado com a pausa (o cartão acabou de nascer, então é ele que o toque abre).
      await enqueuePushEvent(tx, 'approval_pending', this.run.id, at);
      await tx.query("UPDATE runs SET status = 'waiting_approval', lease_until = NULL, lease_owner = NULL, active_ms = $2 WHERE id = $1", [
        this.run.id,
        this.activeMs(),
      ]);
      await recordConversationEvent(tx, this.run.conversation_id, 'run', this.run.id, at);
    });
    this.deps.logger.info({ runId: this.run.id, action: action.slug }, 'execução aguardando aprovação');
    return { status: 'waiting_approval' };
  }

  /** Pega a decisão do dono ainda não tratada (e tira a marca "aguardando" da atividade), sob a posse da execução. */
  private async takeApprovalDecision(): Promise<DecidedApproval | null> {
    const { pool, now, approvals } = this.deps;
    const at = now();
    return withTransaction(pool, async (tx) => {
      await holdLease(tx, this.run.id, this.owner);
      const decided = await approvals.takeDecision(tx, this.run.id);
      if (!decided) return null;
      await tx.query(`UPDATE messages SET data = data || '{"awaitingApproval": false}'::jsonb WHERE id = $1`, [decided.activityId]);
      await recordConversationEvent(tx, this.run.conversation_id, 'message', decided.activityId, at);
      return decided;
    });
  }

  /**
   * O destino de uma chamada pendente do conector na retomada (A5, A17, R1). A porta publicada ao bot resolve pelo `target` dela; mas um bot sem NENHUMA conta liberada e ativa (a única conta foi
   * revogada ou desconectada enquanto a aprovação esperava) já não a tem no mapa, e procurar por ela daria "Ação desconhecida" sem a auditoria da recusa. Nesse caso o destino sai direto da fonte
   * do conector, a mesma resolução que a porta usa, e a recusa chega como `AccountRefusal` (motivo certo, auditada) em vez de se perder. Sem fonte (sem conector configurado), não há destino.
   * A `use_tool` tem alvo PRÓPRIO: ele sai do mesmo mapa filtrado da execução (`useToolPort`), nunca do Composio. Sem esta separação, uma retomada cujo mapa não tivesse a porta cairia em
   * `composio.resolveTarget` e pediria ao Composio um nome interno de ferramenta; por isso a chamada pela `use_tool` nunca passa pela fonte do conector, e sem alvo no mapa não há destino.
   */
  private async resumedTarget(tools: ReadonlyMap<string, ToolHandler>, via: string, name: string, request: ToolTargetRequest): Promise<ToolHandler | undefined> {
    const front = tools.get(via);
    if (via === USE_TOOL) return front?.target?.(name, request);
    return front?.target ? front.target(name, request) : this.deps.composio?.resolveTarget(name, request);
  }

  /**
   * Retoma do ponto exato: negada, a chamada não executa e o bot recebe "ação negada pelo usuário"; permitida, a MESMA chamada
   * (argumentos como o modelo os enviou) executa com a prova do dono. Em seguida rodam as chamadas que vinham depois dela na
   * etapa, e só então o laço volta ao modelo. Exceção do Chat geral (A7): a aprovação de ação do conector pendente de antes da phase 13 é recusada mesmo permitida.
   */
  private async applyDecision(decided: DecidedApproval): Promise<Outcome | null> {
    // `via` vem do pedido gravado (o mesmo objeto da chamada, com o que `executeCall` acrescentou): a ação é reencontrada pela porta.
    const call = decided.call as RunnableCall;
    const tools = await this.ensureTools();
    if (decided.status === 'denied') {
      // Negar não precisa reencontrar a ação na rede: a natureza da chamada já foi persistida antes da espera.
      const external = (await this.deps.pool.query<{ external: boolean }>("SELECT coalesce(data->>'external','false') = 'true' AS external FROM messages WHERE id=$1", [decided.activityId])).rows[0]?.external;
      if (external) await this.auditAction(decided.call.name, 'denied', 'owner', call.account);
      await this.settleActivity(decided.activityId, 'failed', NOT_EXECUTED_RESULTS.denied, null);
    } else if (call.via === COMPOSIO_EXECUTE_TOOL && this.run.bot_id === null) {
      // A7: a execução sem bot (Chat geral) não tem mais o conector (`connectorTools`). O `via` deixou de ser exclusivo dele (a `use_tool` também o grava), então a recusa vale só para a porta do conector.
      // A pendência de antes da mudança é recusada sem tocar no Composio:
      // auditada como recusa (a ação nunca começou, então não há `composio.action_started`) e fechada com o texto que o bot lê; a execução segue com as chamadas restantes.
      await this.auditAction(call.name, 'denied', 'general_chat');
      await this.settleActivity(decided.activityId, 'failed', CONNECTOR_REFUSED_IN_GENERAL_CHAT, null);
    } else {
      let handler: ToolHandler | undefined;
      let prepared: PreparedCall | null = null;
      let result = '';
      try {
        // A conta volta pelo ID gravado na chamada pendente (não pelo nome) e é reconferida contra as liberações do banco: se deixou de estar liberada ao bot, recusa, mesmo que outra conta
        // do mesmo app esteja liberada (A5). Pendência de antes da phase 13 não tem conta gravada e cai na regra de sempre (só há conta implícita com uma liberada).
        handler = call.via !== undefined ? await this.resumedTarget(tools, call.via, call.name, { botId: this.run.bot_id, ...(call.account ? { accountId: call.account.id } : {}) }) : tools.get(call.name);
        if (!handler) throw unknownCallFailure(call.name, call.via, this.run.bot_id !== null);
        // E3 (A28, decisão 30): a dona aprovou UMA ação, a do `action_slug` gravado no pedido. A prova de aprovação sai do handler resolvido agora, então um alvo que mudou entre o pedido e a
        // resposta (o Composio devolve outro slug, a conta passou a apontar para outra ação, a chamada gravada reencontra outra ferramenta) executaria sob a aprovação de OUTRA. Nome e ação
        // resolvidos precisam ser os gravados; senão a chamada é recusada sem executar, e a recusa de uma ação externa é auditada.
        if (handler.definition.name !== call.name || handler.action?.slug !== decided.actionSlug) {
          if (handler.external) await this.auditAction(call.name, 'denied', 'action_changed', handler.account ?? call.account);
          handler = undefined;
          throw new ToolFailure(ACTION_CHANGED_RESULT);
        }
        prepared = handler.prepare(call.arguments);
      } catch (error) {
        if (!(error instanceof ToolFailure)) throw error;
        if (error instanceof AccountRefusal) await this.auditAction(call.name, 'denied', 'account', error.account ?? call.account, { reason: error.reason });
        result = failureResult(error);
      }
      const proof = handler?.action ? grantApprovalProof(handler.action.slug, 'owner_approved') : undefined;
      // Mesma falha fechada do portão: uma ferramenta externa sem `action` não executa nem com a resposta do dono.
      if ((handler?.external || handler?.approvalRequired) && !proof) {
        prepared = null;
        result = EXTERNAL_WITHOUT_ACTION;
      }
      const stopped = await this.runAndSettle(decided.activityId, call, handler, prepared, result, proof);
      if (stopped) return stopped;
    }
    return this.runCalls(decided.remaining, decided.step);
  }

  // ---------------------------------------------------------------------------------------------
  // Retomada, desfecho e liberação
  // ---------------------------------------------------------------------------------------------

  /**
   * Posse abandonada: descarta texto parcial e repete somente ferramentas locais replayable, com recibo durável ou leitura segura. Uma ação
   * EXTERNA fechada assim pode já ter sido executada (o pedido pode ter chegado ao Composio antes da queda), então o bot recebe o
   * aviso para confirmar o efeito antes de repetir; senão repetiria, por exemplo, um e-mail permitido por regra.
   */
  private async recover(): Promise<void> {
    const { pool, now } = this.deps;
    const at = now();
    await withTransaction(pool, async (tx) => {
      await holdLease(tx, this.run.id, this.owner);
      const partial = await tx.query<{ id: string }>(
        `UPDATE messages SET status = 'discarded'
         WHERE run_id = $1 AND kind = 'text' AND role = 'assistant' AND status = 'streaming' RETURNING id`,
        [this.run.id],
      );
      const open = await tx.query<{ id: string }>(
        `UPDATE messages SET status = 'failed',
                content = CASE WHEN coalesce(data->>'external', 'false') = 'true' THEN $3::text ELSE $2::text END
         WHERE run_id = $1 AND kind = 'activity' AND status = 'running' AND coalesce(data->>'awaitingApproval', 'false') <> 'true'
           AND NOT (coalesce(data->>'external', 'false') <> 'true' AND data->>'tool' = ANY($4::text[])) RETURNING id`,
        [this.run.id, INTERRUPTED_BY_RESTART, INTERRUPTED_EXTERNAL_BY_RESTART, [...this.deps.tools.values()].filter((handler) => handler.replayable && !handler.external).map((handler) => handler.definition.name)],
      );
      for (const row of [...partial.rows, ...open.rows]) await recordConversationEvent(tx, this.run.conversation_id, 'message', row.id, at);
    });
    // Apenas ferramentas locais com recibos ou leituras seguras são repetidas. Efeitos externos conservam o aviso de ambiguidade.
    const replay = await pool.query<{ id: string; data: ActivityData; tool_arguments: string | null }>("SELECT id::text, data, tool_arguments FROM messages WHERE run_id = $1 AND kind = 'activity' AND status = 'running' AND coalesce(data->>'awaitingApproval','false') <> 'true' ORDER BY messages.id", [this.run.id]);
    const tools = await this.ensureTools();
    for (const row of replay.rows) {
      const handler = tools.get(row.data.tool);
      if (!handler?.replayable || handler.external) continue;
      const call: RunnableCall = { id: row.data.callId, name: row.data.tool, arguments: row.tool_arguments ?? row.data.arguments };
      // Reconhecer efeito já confirmado precede regras novas: isto é leitura de recibo, não nova autorização.
      const receipt = call.name === 'table_delete_table' ? await readTableRemovalReceipt(pool, this.run.bot_id, call.arguments) : call.name === DOC_DELETE_TOOL ? await readDocRemovalReceipt(pool, this.run.bot_id, call.arguments) : null;
      if (receipt) {
        await this.settleActivity(row.id, 'completed', receipt.result, null, receipt.label, receipt.evidence, receipt.confirmedTableRemoval ?? receipt.confirmedDocRemoval);
        continue;
      }
      let prepared: PreparedCall | null = null;
      let proof: ApprovalProof | undefined;
      let result = INTERRUPTED_BY_RESTART;
      try {
        prepared = handler.prepare(call.arguments);
        if (handler.approvalRequired) {
          const approved = (await pool.query("SELECT 1 FROM approvals WHERE activity_id = $1 AND status = 'approved'", [row.id])).rowCount;
          if (!handler.action || !approved && await this.deps.approvals.resolve(pool, this.run.bot_id, handler.action) !== 'allow') throw new ToolFailure(NOT_EXECUTED_RESULTS.cancelled);
          proof = grantApprovalProof(handler.action.slug, approved ? 'owner_approved' : 'allow_rule');
        }
      } catch (error) {
        if (!(error instanceof ToolFailure)) throw error;
        prepared = null; result = error.message;
      }
      await this.runAndSettle(row.id, call, handler, prepared, result, proof);
      if (this.halted()) break;
    }
    this.deps.logger.info({ runId: this.run.id }, 'execução retomada após reinício');
  }

  /** Cartão de sistema que conta o desfecho (nenhum quando a execução simplesmente terminou). */
  private describe(outcome: TerminalOutcome, steps: string[]): { card: SystemCard; content: string } | null {
    switch (outcome.status) {
      case 'completed':
        return null;
      case 'interrupted': {
        const maybe = this.maybeCompleted.length > 0 ? ` Podem ter sido concluídas: ${this.maybeCompleted.join('; ')}.` : '';
        return {
          card: { type: 'run_interrupted', steps, maybeCompleted: [...this.maybeCompleted] },
          content: `Execução interrompida pelo dono. Ações concluídas: ${steps.length}.${maybe}`,
        };
      }
      case 'limit_reached':
        return {
          card: { type: 'run_limit', limit: outcome.limit, steps },
          content:
            outcome.limit === 'steps'
              ? `Limite de chamadas de ferramenta atingido; a execução foi encerrada. Ações concluídas: ${steps.length}.`
              : outcome.limit === 'tokens'
                ? `Limite de saída do modelo atingido. A resposta está incompleta e nenhuma chamada da etapa truncada foi executada. Ações anteriores concluídas: ${steps.length}. Ao continuar, prossiga do contexto e dos resultados já confirmados; não repita ações concluídas.`
                : `Limite de ${Math.round(this.deps.config.maxActiveMs / 60_000)} minutos de tempo ativo atingido; a execução foi encerrada. Ações concluídas: ${steps.length}.`,
        };
      case 'failed':
        // Numa rotina a falha aparece no próprio cartão da rotina (e ela não tem "Tentar novamente": o próximo horário a repete).
        if (this.run.routine_name !== null) return null;
        return { card: { type: 'run_failed', code: outcome.code }, content: ERROR_CODES[outcome.code].message };
    }
  }

  /** Grava o desfecho: cartão (se houver), estado terminal da execução e os eventos, tudo na mesma transação. */
  private async finish(outcome: TerminalOutcome): Promise<void> {
    const { pool, now } = this.deps;
    const at = now();
    await withTransaction(pool, async (tx) => {
      await holdLease(tx, this.run.id, this.owner);
      if (this.run.context_operation_id) {
        // Commit conhecido vence cancelamento tardio; desconhecido continua desconhecido após reinício.
        const saved = (await tx.query<{outcome:string|null;cold:boolean}>('SELECT outcome,(session_id IS NULL) AS cold FROM context_maintenance WHERE request_id=$1',[this.run.context_operation_id])).rows[0];
        const status = saved?.outcome === 'completed' ? 'completed' : outcome.status;
        const code = status === 'failed' && outcome.status === 'failed' ? outcome.code : status === 'limit_reached' ? 'CONTEXT_COMPACTION_FAILED' : null;
        // A compactação FRIA é do worker, não do dono (phase 11, T8): a falha dela nunca derruba nada nem aparece. A execução termina SEMPRE concluída (um `failed` aqui sujaria o
        // estado do bot, que lê o último desfecho terminal das execuções dele), e a verdade (falha, código, chamada incerta) fica só em `context_maintenance` e no log. A parada e o
        // desligamento (`interrupted`, `released`) seguem as regras de sempre.
        const runStatus = saved?.cold === true && (status === 'failed' || status === 'limit_reached') ? 'completed' : status;
        const usage=(await tx.query<{run_id:string;purpose:'main'|'summary';state:string;summary_outcome:string|null;input_tokens:string|null;output_tokens:string|null;cached_tokens:string|null}>("SELECT run_id::text,purpose,state,summary_outcome,input_tokens::text,output_tokens::text,cached_tokens::text FROM model_call_usage WHERE run_id=$1",[this.run.id])).rows;
        if(usage.length) await tx.query('UPDATE context_maintenance SET result=coalesce(result,$2) WHERE request_id=$1',[this.run.context_operation_id,JSON.stringify({changed:false,beforeInputTokens:null,afterInputTokens:null,summaryUsage:aggregateContextUsage(usage)})]);
        await tx.query("UPDATE context_maintenance SET outcome=coalesce(outcome,$2),error_code=coalesce(error_code,$3) WHERE request_id=$1",[this.run.context_operation_id,status === 'completed' ? 'completed' : status === 'interrupted' ? 'cancelled' : 'failed',code]);
        await tx.query('UPDATE runs SET status=$2,finished_at=$3,lease_until=NULL,active_ms=$4,failure_code=$5 WHERE id=$1',[this.run.id,runStatus,at,this.activeMs(),runStatus === status ? code : null]);
        // A fase `failed` do painel é de uma operação que o dono pediu: a falha fria (`runStatus` já concluído) devolve a fase a `ready`, sem avisar nada.
        await tx.query("UPDATE conversation_context SET phase=CASE WHEN $2 THEN 'failed' WHEN measurement IS NULL THEN 'not_measured' ELSE 'ready' END WHERE conversation_id=$1",[this.run.conversation_id,runStatus==='failed'||runStatus==='limit_reached']);
        await recordAudit(tx,{action:'context.maintenance_finished',actor:'system',outcome:status === 'completed' ? 'success':'failure',target:this.run.conversation_id,details:{requestId:this.run.context_operation_id,status,...(saved?.cold === true ? {trigger:'cold'} : {})}},at);
        await recordConversationEvent(tx,this.run.conversation_id,'context','0',at);
        return;
      }
      // Um pedido de aprovação ainda aberto (o dono parou a execução enquanto ele esperava) não pode seguir respondível.
      await tx.query("UPDATE conversation_context SET phase=CASE WHEN $2 THEN 'failed' WHEN measurement IS NULL THEN 'not_measured' ELSE 'ready' END WHERE conversation_id=$1",[this.run.conversation_id,outcome.status==='failed'||outcome.status==='limit_reached']);
      await this.deps.approvals.cancelOpenForRun(tx, this.run.id, at);
      const done = await tx.query<{ label: string }>(
        "SELECT data->>'label' AS label FROM messages WHERE run_id = $1 AND kind = 'activity' AND status = 'completed' ORDER BY id",
        [this.run.id],
      );
      // Rede de segurança: nenhum texto em streaming sobrevive ao desfecho (ex.: a gravação do texto falhou no meio).
      const dangling = await tx.query<{ id: string }>(
        "UPDATE messages SET status = 'done' WHERE run_id = $1 AND kind = 'text' AND status = 'streaming' RETURNING id",
        [this.run.id],
      );
      for (const row of dangling.rows) await recordConversationEvent(tx, this.run.conversation_id, 'message', row.id, at);
      const described = this.describe(outcome, done.rows.map((row) => row.label));
      if (described && !(outcome.status === 'limit_reached' && outcome.cardId)) {
        const card = await tx.query<{ id: string }>(
          `INSERT INTO messages (conversation_id, run_id, role, kind, status, content, data, created_at)
           VALUES ($1, $2, 'system', 'card', 'done', $3, $4, $5) RETURNING id`,
          [this.run.conversation_id, this.run.id, described.content, JSON.stringify(described.card), at],
        );
        await recordConversationEvent(tx, this.run.conversation_id, 'message', (card.rows[0] as { id: string }).id, at);
      }
      if (this.run.routine_name !== null) {
        await settleRoutineRunCard(tx, this.run, { state: outcome.status, failureCode: outcome.status === 'failed' ? outcome.code : null }, at);
      }
      // Push do desfecho, na mesma transação (depois dos cartões, para o toque abrir o último que o dono vê).
      const pushKind = PUSH_KIND_OF_OUTCOME[outcome.status];
      if (pushKind) await enqueuePushEvent(tx, pushKind, this.run.id, at);
      await tx.query(
        `UPDATE runs SET status = $2, finished_at = $3, lease_until = NULL, active_ms = $4, failure_code = $5 WHERE id = $1`,
        [this.run.id, outcome.status, at, this.activeMs(), outcome.status === 'failed' ? outcome.code : null],
      );
      // Complementos que não chegaram a ser lidos (CONV-03): promovidos a execução nova ou, na parada, devolvidos, no mesmo commit do desfecho.
      await settleComplementsAtEnd(tx, this.run, outcome.status, at);
      await recordConversationEvent(tx, this.run.conversation_id, 'run', this.run.id, at);
      await recordConversationEvent(tx, this.run.conversation_id, 'context', '0', at);
    });
  }

  /** Devolve a posse para outro worker retomar já (em vez de esperar o lease vencer). Não mexe se a posse já foi perdida. */
  private async release(): Promise<void> {
    if (this.reason === 'lease_lost') return;
    await this.deps.pool.query(
      "UPDATE runs SET lease_until = now(), active_ms = $2 WHERE id = $1 AND status = 'running' AND lease_owner = $3",
      [this.run.id, this.activeMs(), this.owner],
    );
  }
}

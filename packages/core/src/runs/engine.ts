// Motor de execução dos bots e do chat geral (roda no worker): o dispatcher que escolhe QUAL execução iniciar ou retomar, respeitando a
// fila da conversa. Quem executa cada uma é o `RunExecutor`.
//
// A fila é a tabela `runs` (e não o pg-boss): as regras que importam são invariantes do banco e uma fila genérica de jobs
// não as garante sozinha. A "pista" de uma execução é a CONVERSA dela: para um bot é a conversa única dele (1:1, então "a fila do bot"),
// e cada sessão do chat geral é uma pista própria.
// - FIFO por pista: só a execução mais antiga `queued` de cada conversa é candidata;
// - uma ativa por pista: os índices únicos parciais `runs_one_active_per_bot` e `runs_one_active_per_session` impedem duas `running`
//   da mesma conversa, mesmo com mais de um worker (quem perder a corrida recebe a violação do índice e simplesmente desiste dessa
//   conversa neste ciclo);
// - bots e sessões diferentes em paralelo: o dispatcher preenche até `maxConcurrentRuns` execuções por processo;
// - retomada: uma execução `running` cujo `lease_until` venceu perdeu o dono (worker caiu) e é reivindicada de novo. O
//   lease é renovado pelo batimento do executor, e um encerramento ordenado o devolve na hora (`release`).
// - aprovação (T7): uma execução `waiting_approval` não tem dono nem relógio correndo. Quando o dono responde ao pedido (ou manda
//   parar), ela é reivindicada de volta (vira `running`) e o executor retoma do ponto exato. Uma varredura periódica encerra os
//   pedidos pendentes de mais de 24 horas.
//
// Iniciar uma execução é UMA transação: troca o estado para `running`, dá a posse e, só então, grava a mensagem do dono na
// linha do tempo (é aí que a bolha "Na fila" vira mensagem); numa execução de rotina, o que entra é o cartão "Rotina <nome>
// iniciada", que abre a rodada. Uma repetição ("tentar novamente") já traz a mensagem e não a duplica. Os relógios de posse são os do banco (`now()` do PostgreSQL), para que workers em máquinas diferentes concordem.
import pg from 'pg';
import { CORE_TOOLS, assertRuntimeToolNames, assertToolTree } from './tool-discovery';
import { ApprovalService } from '../approvals/service';
import { recordConversationEvent } from '../conversation/events';
import { readActivePath, tipOf } from '../conversation/path';
import { CLAIM_COLUMNS, type ClaimedRunRow } from '../conversation/views';
import { ConnectorAccountService } from '../credentials/accounts';
import type { ConnectorClient } from '../credentials/composio';
import type { CredentialService } from '../credentials/service';
import type { ProviderClient } from '../credentials/opencode-go';
import type { ParallelClient } from '../credentials/parallel';
import { withTransaction, type Pool } from '../db/pool';
import type { Logger } from '../logging';
import type { ModelService } from '../models/service';
import type { PythonSandboxClient } from '../python/client';
import { openRoutineRunCard, settleRoutineRunCard } from '../routines/run-card';
import { ComposioToolSource } from './composio-tools';
import { updateObjectiveTool } from './update-objective';
import { editMemoryTool } from './edit-memory';
import { DEFAULT_RUN_CONFIG, RunExecutor, type ExecutorDeps, type RunEngineConfig } from './executor';
import { proposeRoutineTool } from './propose-routine';
import { getRoutineTool, listRoutinesTool, proposeRoutineChangeTool } from './routine-tools';
import { searchHistoryTool } from './search-history';
import { readAttachmentTool } from './read-attachment';
import { docTools } from './doc-tools';
import { createRunPythonTool } from './run-python';
import type { ToolHandler } from './tools';
import { tableTools } from './table-tools';
import { WebToolSource } from './web-tools';

/**
 * As ferramentas internas padrão do motor, fora o Python (que depende do sandbox), a web e o conector (que vêm de fontes próprias por execução). É o REGISTRO dos handlers; o CAMINHO de cada um
 * na árvore de grupos do bot mora em `TOOL_TREE` (`tool-discovery.ts`), e `assertToolTree` na partida recusa um handler novo que ficou sem caminho. Docs e tabelas ficam fora da lista fixa do
 * bot: chegam por `abrir_grupo` e `use_tool` (decisões 23 e 25 da phase 15).
 */
export const INTERNAL_TOOLS: readonly ToolHandler[] = [searchHistoryTool, readAttachmentTool, editMemoryTool, updateObjectiveTool, proposeRoutineTool, listRoutinesTool, getRoutineTool, proposeRoutineChangeTool, ...tableTools, ...docTools];

/** Nomes dos índices que garantem uma execução ativa por conversa: a do bot (migration 0006) e a da sessão do chat geral (0012). */
const ONE_ACTIVE_INDEXES: ReadonlySet<string> = new Set(['runs_one_active_per_bot', 'runs_one_active_per_session']);

export interface RunEngineOptions {
  pool: Pool;
  /** `requireKey` (provedor e conector) e `revealKey` (a chave opcional da pesquisa na web). */
  credentials: Pick<CredentialService, 'requireKey' | 'revealKey'>;
  provider: ProviderClient;
  models: Pick<ModelService, 'test'>;
  logger: Logger;
  /** Ferramentas internas oferecidas ao modelo. Padrão: `INTERNAL_TOOLS` (histórico, memória, objetivo, rotinas, tabelas e docs), todas na árvore de grupos do bot (`TOOL_TREE`); as injetadas por teste não precisam estar nela. As da web vêm de `webSearch`. */
  tools?: readonly ToolHandler[];
  /**
   * Publica sem abrir grupo: no BOT, as ferramentas mais usadas dele (até 5, pelo uso dos últimos 30 dias; a lista padrão `DEFAULT_MOST_USED` num bot novo), ao lado das portas; no Chat geral, as core (`CORE_TOOLS`), sem `discover_tools`. Padrão: ligado,
   * como em produção. Os testes cujo assunto é a pressão de contexto (janela de 64k, a menor opção, sem calibração, onde 1 byte conta como 1 token) desligam em `createRunsWorld`, como já fazem
   * com a pesquisa na web e o Python; um teste próprio liga e prova o catálogo. Desligado, o bot publica só as portas.
   */
  coreCatalog?: boolean;
  /** Cliente do Composio: com ele as ações dos apps conectados entram como ferramentas (sob aprovação). Sem ele, só as internas. */
  connector?: ConnectorClient;
  /**
   * Cliente da Parallel (T9): com ele `web_search` e `web_fetch` são oferecidas aos bots e ao Chat geral enquanto a pesquisa estiver ligada em
   * Configurações (o interruptor é lido a cada execução). Sem ele, o motor não tem pesquisa na web.
   */
  webSearch?: ParallelClient;
  /**
   * Sandbox do Python (phase 4, F8): com ele `run_python` entra entre as ferramentas internas (depois das de `tools`) em bots, Chat geral e rotinas;
   * sem ele a ferramenta não existe e o contexto é o de antes. `maxTotalBytes` é o espaço global de anexos, onde os arquivos gerados contam.
   */
  python?: { client: PythonSandboxClient; maxTotalBytes: number };
  now?: () => Date;
  config?: Partial<RunEngineConfig>;
}

interface Claimed {
  run: ClaimedRunRow;
  resumed: boolean;
}

export class RunEngine {
  private readonly deps: ExecutorDeps;
  private readonly active = new Map<RunExecutor, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private dispatching: Promise<void> = Promise.resolve();
  /** Quando a varredura de expiração rodou pela última vez (ms desde a época). */
  private lastSweepAt = 0;

  constructor({ pool, credentials, provider, models, logger, tools, coreCatalog = true, connector, webSearch, python, now = () => new Date(), config = {} }: RunEngineOptions) {
    // Os padrões de produção precisam de um caminho na árvore de grupos (`TOOL_TREE`), senão `abrir_grupo` não os alcançaria: a partida falha, e não a primeira conversa do bot.
    if (tools === undefined) assertToolTree(INTERNAL_TOOLS);
    const withPython = python ? [...(tools ?? INTERNAL_TOOLS), createRunPythonTool({ client: python.client, logger, maxTotalBytes: python.maxTotalBytes })] : (tools ?? INTERNAL_TOOLS);
    const internal = coreCatalog ? withPython.map((tool) => (CORE_TOOLS.has(tool.definition.name) ? { ...tool, core: true } : tool)) : withPython;
    assertRuntimeToolNames(internal);
    this.deps = {
      pool,
      credentials,
      provider,
      models,
      tools: new Map(internal.map((tool) => [tool.definition.name, tool])),
      approvals: new ApprovalService({ pool, now }),
      // As contas do conector liberadas por bot (phase 13): o serviço só precisa de `sync` e `releasedTo` aqui (banco), então a fonte de leitura ao vivo dele (usada pela tela de Conexões, na API)
      // é a mesma leitura da chave do Composio que o `CredentialService` faz.
      ...(connector
        ? {
            composio: new ComposioToolSource({
              credentials,
              connector,
              accounts: new ConnectorAccountService({ pool, source: { listConnectorAccounts: async () => connector.listAccounts(await credentials.requireKey('connector')) }, now }),
              logger,
            }),
          }
        : {}),
      ...(webSearch ? { web: new WebToolSource({ pool, credentials, parallel: webSearch, logger }) } : {}),
      logger,
      now,
      // As "mais usadas" do bot são calculadas por conversa pelo executor (`RunExecutor.refreshMostUsed`). Sem o catálogo core, o bot publica só as portas.
      publishMostUsed: coreCatalog,
      config: { ...DEFAULT_RUN_CONFIG, ...config },
    };
  }

  /** Começa a procurar execuções a cada `pollMs`. Erros de um ciclo são logados e o laço continua. */
  start(): void {
    if (this.timer !== null || this.stopping) return;
    const tick = () => {
      this.dispatching = this.dispatchOnce()
        .catch((error: unknown) => this.deps.logger.error({ err: error }, 'falha ao despachar execuções'))
        .finally(() => {
          if (!this.stopping) this.timer = setTimeout(tick, this.deps.config.pollMs);
        });
    };
    this.timer = setTimeout(tick, 0);
  }

  /** Encerra de forma ordenada: para de reivindicar, aborta as execuções SEM finalizá-las e devolve a posse delas. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.dispatching;
    for (const executor of this.active.keys()) executor.shutdown();
    await this.idle();
  }

  /** Resolve quando nenhuma execução deste processo está em andamento. */
  async idle(): Promise<void> {
    while (this.active.size > 0) await Promise.allSettled([...this.active.values()]);
  }

  /** Encerra os pedidos de aprovação vencidos, no máximo uma vez por `approvalSweepMs`. Falha só é logada (o próximo ciclo repete). */
  private async sweepApprovals(): Promise<void> {
    const nowMs = Date.now();
    if (nowMs - this.lastSweepAt < this.deps.config.approvalSweepMs) return;
    this.lastSweepAt = nowMs;
    try {
      const expired = await this.deps.approvals.expireDue();
      if (expired > 0) this.deps.logger.info({ expired }, 'pedidos de aprovação expirados');
    } catch (error) {
      this.deps.logger.error({ err: error }, 'falha na varredura de aprovações expiradas');
    }
  }

  /** Preenche as vagas livres uma vez: retoma execuções abandonadas e inicia as da fila. Exposto para os testes. */
  async dispatchOnce(): Promise<void> {
    await this.sweepApprovals();
    while (!this.stopping && this.active.size < this.deps.config.maxConcurrentRuns) {
      const claimed = await this.claimNext();
      if (!claimed) return;
      this.launch(claimed);
    }
  }

  private launch({ run, resumed }: Claimed): void {
    const executor = new RunExecutor(this.deps, run, run.lease_owner, resumed);
    if (this.stopping) executor.shutdown();
    this.deps.logger.info({ runId: run.id, botId: run.bot_id, conversationId: run.conversation_id, resumed }, 'execução iniciada');
    const finished = executor.execute().finally(() => this.active.delete(executor));
    this.active.set(executor, finished);
  }

  /** Reivindica a próxima execução: primeiro as abandonadas (elas seguram a vaga do bot), depois a mais antiga de cada fila. */
  private async claimNext(): Promise<Claimed | null> {
    const { pool, config, now } = this.deps;
    const abandoned = await pool.query<ClaimedRunRow>(
      `UPDATE runs SET lease_until = now() + ($1::int * interval '1 millisecond'), lease_owner = gen_random_uuid()
       WHERE id = (SELECT id FROM runs WHERE status = 'running' AND lease_until < now() ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING ${CLAIM_COLUMNS}`,
      [config.leaseMs],
    );
    if (abandoned.rows[0]) return { run: abandoned.rows[0], resumed: true };

    // Execução que esperava aprovação e já tem o que fazer: o dono decidiu, ou pediu parada. Ela continua ocupando a vaga da conversa
    // (o índice único cobre `waiting_approval` e `running`), então a troca de estado nunca disputa com outra execução dela.
    const resume = await withTransaction(pool, async (tx) => {
      const claimed = await tx.query<ClaimedRunRow>(
        `UPDATE runs SET status = 'running', lease_until = now() + ($1::int * interval '1 millisecond'), lease_owner = gen_random_uuid()
         WHERE id = (
           SELECT r.id FROM runs r
           WHERE r.status = 'waiting_approval'
             AND (r.stop_requested_at IS NOT NULL
                  OR EXISTS (SELECT 1 FROM approvals a WHERE a.run_id = r.id AND a.status IN ('approved', 'denied') AND a.consumed_at IS NULL))
           ORDER BY r.id LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING ${CLAIM_COLUMNS}`,
        [config.leaseMs],
      );
      const row = claimed.rows[0];
      if (!row) return null;
      await recordConversationEvent(tx, row.conversation_id, 'run', row.id, now());
      return row;
    });
    if (resume) return { run: resume, resumed: false };

    try {
      const run = await withTransaction(pool, async (tx) => {
        const at = now();
        const claimed = await tx.query<ClaimedRunRow>(
          `UPDATE runs SET status = 'running', started_at = coalesce(started_at, $2),
                           lease_until = now() + ($1::int * interval '1 millisecond'), lease_owner = gen_random_uuid()
           WHERE id = (
             SELECT r.id FROM runs r
             WHERE r.status = 'queued'
               AND NOT EXISTS (SELECT 1 FROM runs a WHERE a.conversation_id = r.conversation_id AND a.status IN ('running', 'waiting_approval'))
               AND r.id = (SELECT min(q.id) FROM runs q WHERE q.conversation_id = r.conversation_id AND q.status = 'queued')
             ORDER BY r.id LIMIT 1 FOR UPDATE SKIP LOCKED)
           RETURNING ${CLAIM_COLUMNS}`,
          [config.leaseMs, at],
        );
        const row = claimed.rows[0];
        if (!row) return null;
        if (row.trigger_message_id === null && !row.context_operation_id) {
          if (row.routine_name !== null) {
            // Execução de rotina: o cartão "Rotina <nome> iniciada" abre a rodada no lugar da mensagem do dono (e já registra o evento).
            row.trigger_message_id = await openRoutineRunCard(tx, { ...row, routine_name: row.routine_name }, at);
          } else {
            // Numa sessão do Chat geral a mensagem pende da ponta do caminho ativo (phase 4, CONV-01): depois de um retrocesso, é a resposta onde
            // o dono parou, e a mensagem vira versão ao lado da primeira rodada retrocedida. As trocas de caminho são recusadas enquanto há
            // execução na fila, então a ponta lida aqui é a que o dono via ao enviar. No bot (linear) não há pai. Depois de um retrocesso a mensagem
            // muda a forma do caminho (vira versão e tira a linha "Restaurar"), então o evento `path` avisa as telas abertas para relerem o snapshot.
            const path = row.bot_id === null ? await readActivePath(tx, row.conversation_id) : null;
            const parent = path === null ? null : tipOf(path);
            const message = await tx.query<{ id: string }>(
              `INSERT INTO messages (conversation_id, run_id, role, kind, status, opens_round, content, parent_run_id, created_at)
               VALUES ($1, $2, 'user', 'text', 'done', true, $3, $4, $5) RETURNING id`,
              [row.conversation_id, row.id, row.input, parent, at],
            );
            row.trigger_message_id = (message.rows[0] as { id: string }).id;
            await recordConversationEvent(tx, row.conversation_id, 'message', row.trigger_message_id, at);
            if (path?.rewound) await recordConversationEvent(tx, row.conversation_id, 'path', '0', at);
          }
          await tx.query('UPDATE runs SET trigger_message_id = $2 WHERE id = $1', [row.id, row.trigger_message_id]);
          // O vínculo com a bolha nasce na mesma transação da mensagem; retry mantém a bolha e seus anexos originais.
          await tx.query('UPDATE attachments SET message_id = $2 WHERE run_id = $1 AND conversation_id = $3', [row.id, row.trigger_message_id, row.conversation_id]);
        } else if (row.routine_name !== null) {
          // Continuação explícita reutiliza a ocorrência/cartão; running só aparece quando um worker realmente reivindica a fila.
          await settleRoutineRunCard(tx, row, { state: 'running', failureCode: null }, at);
        }
        await recordConversationEvent(tx, row.conversation_id, row.context_operation_id ? 'context' : 'run', row.context_operation_id ? '0' : row.id, at);
        return row;
      });
      return run ? { run, resumed: false } : null;
    } catch (error) {
      // Outro worker ocupou a conversa entre a consulta e a troca de estado: este ciclo desiste dela.
      if (error instanceof pg.DatabaseError && error.code === '23505' && error.constraint !== undefined && ONE_ACTIVE_INDEXES.has(error.constraint)) return null;
      throw error;
    }
  }
}

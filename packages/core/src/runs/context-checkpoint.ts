// Cobertura contínua e checkpoint substituível. Histórico original e execução mantêm seus próprios contratos.
//
// O checkpoint é um PONTEIRO sobre linhas persistidas (`covered_message_ids`) mais o texto do resumo; compactar nunca apaga nem reescreve o histórico (phase 9).
// Quando vale (CTX-09): só quando o conteúdo que ele cobre continua o mesmo, linha por linha (`coverage_fingerprint`), a origem de cada fonte continua autorizada
// (`evidence_provenance`) e, no Chat geral, todas as linhas cobertas ainda estão no caminho ativo. Sistema, memória, Regras Globais, idioma, objetivo, catálogo,
// effort e janela NÃO entram: o resumo nunca os contém (são reinjetados atualizados em todo pedido), então editar qualquer um deles não custa um resumo novo.
import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from '../errors';
import type { Queryable } from '../db/pool';
import { onPathSql, pathIds, readActivePath } from '../conversation/path';
import type { ChatProtocol, ChatRequest, ChatUsage } from '../models/chat-protocols';
import { coldMaskedSql, loadContextRows, type ContextRow } from './context';
import { mergeEvidence, parseEvidence, validateEvidence, type EvidenceProvenance } from './evidence-provenance';

/**
 * Teto do checkpoint em caracteres (pontos de código): o da coluna `conversation_context.summary` (CHECK da migration 0036) e de `commitContextSummary`. Fonte única:
 * mora aqui, e não em `compaction.ts`, porque `compaction.ts` já importa este módulo e o caminho inverso criaria um ciclo; o prompt e o veredito do resumo
 * (`compaction.ts`) e o corte da leitura do stream (`executor.ts`) importam daqui.
 */
export const SUMMARY_MAX_CHARS = 16_000;

export interface ContextCheckpoint {
  revision: number; coverage_start: string; covered_message_ids: string[]; summary: string;
  coverage_fingerprint: string; evidence_provenance: unknown;
}

/** Hash é identidade de revisão, não logs/conteúdo público. IDs ficam na ordem original numérica da query. */
export function contextFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * O que a linha de `model_call_usage` guarda sobre o PEDIDO de uma chamada (migration 0052, phase 15): só hash sha256 em hex (o mesmo cálculo de `contextFingerprint`), contagem e o
 * effort, nunca conteúdo. Cada bloco é o que o provedor lê, na ordem do prefixo; bloco ausente no pedido é `null` (e não o hash do vazio).
 */
export interface RequestBlockHashes {
  /** Turno de sistema. */
  system: string | null;
  /** Turno de objetivo do bot (`# Objetivo do bot`); `null` no Chat geral e no pedido de resumo. */
  objective: string | null;
  /** Lista `tools` enviada, na ordem enviada; `null` quando o pedido não leva ferramentas. */
  tools: string | null;
  /** Histórico inteiro: todo turno que não é o sistema nem o objetivo, na ordem do pedido. */
  history: string;
  historyTurns: number;
  /** Hash do histórico ANTES de cada turno que abre uma rodada, em ordem: o último é o histórico até o início da rodada atual. */
  historyRoundHashes: string[];
  /** Último elemento de `historyRoundHashes` (`null` sem rodada aberta), guardado à parte só para consulta simples. */
  historyPriorHash: string | null;
  effort: string | null;
}

/** Cabeçalho do turno que abre uma rodada (`currentDataBlock` em `context.ts`); é o que separa as rodadas no pedido, que não carrega `opens_round`. */
const ROUND_OPENING_PREFIX = '# Dados\n';
/** Início do turno de objetivo do bot, montado em `RunExecutor.loadContext` (mesma marca de `baseTurns`). */
const OBJECTIVE_PREFIX = '# Objetivo do bot';

/**
 * Impressão digital de cada bloco do pedido, para separar, nas aberturas de rodada, QUAL bloco quebrou o prefixo que o provedor reaproveita no cache (spec da phase 15, decisão 10):
 * sistema, objetivo, lista de ferramentas e histórico, na ordem em que o provedor os lê, mais o effort. Comparar duas chamadas da mesma conversa mostra o primeiro bloco que difere.
 *
 * O histórico leva um vetor extra porque `history` sozinho só diz que ele mudou: `historyRoundHashes` guarda o hash do histórico até o início de cada rodada, então se a chamada B estende
 * a A, o histórico de A aparece como prefixo no vetor de B, e se não aparece a quebra está antes; comparar os vetores elemento a elemento diz em qual rodada ela ocorreu. É calculado numa
 * passada só: o JSON do array é montado turno a turno num único hash, e uma cópia fechada em `]` em cada início de rodada dá exatamente `contextFingerprint(turnos até ali)`.
 *
 * ponytail: rodada sem o bloco `# Dados` (aberta antes da phase 10) não entra no vetor, então a quebra dentro dela só é localizada até a rodada anterior; some quando essas conversas passarem.
 */
export function requestBlockHashes(request: Pick<ChatRequest, 'turns' | 'tools' | 'effort'>): RequestBlockHashes {
  const system = request.turns[0]?.role === 'system' ? request.turns[0] : null;
  const objective = request.turns.find((turn) => turn.role === 'user' && turn.text.startsWith(OBJECTIVE_PREFIX)) ?? null;
  const history = request.turns.filter((turn) => turn !== system && turn !== objective);
  const prefix = createHash('sha256').update('[');
  const historyRoundHashes: string[] = [];
  history.forEach((turn, index) => {
    if (turn.role === 'user' && turn.text.startsWith(ROUND_OPENING_PREFIX)) historyRoundHashes.push(prefix.copy().update(']').digest('hex'));
    prefix.update((index === 0 ? '' : ',') + JSON.stringify(turn));
  });
  return {
    system: system && contextFingerprint(system.text),
    objective: objective && contextFingerprint(objective.text),
    tools: request.tools ? contextFingerprint(request.tools) : null,
    history: prefix.update(']').digest('hex'),
    historyTurns: history.length,
    historyRoundHashes,
    historyPriorHash: historyRoundHashes.at(-1) ?? null,
    effort: request.effort ?? null,
  };
}

/**
 * Primeira cobertura herda cinco rodadas; depois mantém tudo novo até compactar, sem expiração por contagem. No Chat geral (sessão sem bot) TUDO aqui, as linhas e a
 * pergunta "há algo antes da cobertura?", considera só o CAMINHO ATIVO (CONV-01, `conversation/path.ts`): linhas de versões substituídas não entram no pedido nem
 * decidem se o prefixo da sessão está presente (O4 da phase 9; antes a pergunta olhava todas as ramificações).
 */
export async function loadManagedContext(db: Queryable, conversationId: string): Promise<{ checkpoint: ContextCheckpoint; rows: ContextRow[]; wholeConversation: boolean }> {
  const initial = await loadContextRows(db, conversationId);
  const first = initial[0]?.id ?? '0';
  await db.query('INSERT INTO conversation_context(conversation_id,coverage_start) VALUES($1,$2) ON CONFLICT DO NOTHING', [conversationId, first]);
  const checkpoint = (await db.query<ContextCheckpoint>('SELECT revision,coverage_start::text,covered_message_ids::text[],summary,coverage_fingerprint,evidence_provenance FROM conversation_context WHERE conversation_id=$1', [conversationId])).rows[0]!;
  const owner = (await db.query<{ bot_id: string | null }>('SELECT bot_id FROM conversations WHERE id=$1', [conversationId])).rows[0]!;
  const path = owner.bot_id === null ? pathIds((await readActivePath(db, conversationId)).rounds) : null;
  // `cold_masked` (limpeza fria da phase 11, `cold-maintenance.ts`) acompanha cada linha mas NÃO entra em `coverageFingerprint`: mascarar um resultado muda só o que vai ao modelo, não o
  // conteúdo que um checkpoint cobre, então o checkpoint existente continua válido (CTX-09).
  const rows = (await db.query<ContextRow>(`SELECT m.id::text,m.run_id::text,m.role,m.kind,m.status,m.opens_round,m.step,m.content,m.data,m.tool_arguments,m.evidence_provenance,${coldMaskedSql('m')}
    FROM messages m WHERE m.conversation_id=$1 AND m.id >= $2 AND m.status NOT IN ('streaming','discarded') ${path ? `AND ${onPathSql('m', 3, 4)}` : ''} ORDER BY m.id`, [conversationId, checkpoint.coverage_start, ...(path ? [path.messageIds, path.runIds] : [])])).rows;
  const earlier = await db.query(`SELECT 1 FROM messages m WHERE m.conversation_id=$1 AND m.id<$2 AND m.status NOT IN ('streaming','discarded') ${path ? `AND ${onPathSql('m', 3, 4)}` : ''} LIMIT 1`, [conversationId, checkpoint.coverage_start, ...(path ? [path.messageIds, path.runIds] : [])]);
  return { checkpoint, rows, wholeConversation: !earlier.rowCount && !checkpoint.summary };
}

/** Só campos persistidos entram na revisão; anexos projetados e metadados de transporte não a alteram. */
export function coverageFingerprint(rows: readonly ContextRow[]): string {
  return contextFingerprint(rows.map(({ id, run_id, role, kind, status, opens_round, step, content, data, tool_arguments, evidence_provenance }) => ({ id, run_id, role, kind, status, opens_round, step, content, data, tool_arguments, evidence_provenance })));
}

/**
 * Revalida cobertura exata e suas fontes (CTX-09): acrescentar linhas ao fim não invalida; mudar uma linha coberta, removê-la ou, no Chat geral, tirá-la do caminho
 * ativo (`rows` já vem só do caminho) invalida; editar memória, Regras Globais, idioma, objetivo, modelo ou janela NÃO invalida. `rows` são as linhas ORIGINAIS do banco
 * (sem a saneação de evidência que o executor aplica ao pedido), as mesmas de que o `coverage_fingerprint` foi calculado.
 */
export async function validCheckpoint(db: Queryable, conversationId: string, botId: string | null, checkpoint: ContextCheckpoint, rows: readonly ContextRow[]): Promise<boolean> {
  if (!checkpoint.summary) return false;
  const covered = rows.filter((row) => checkpoint.covered_message_ids.includes(row.id!));
  const evidence = parseEvidence(checkpoint.evidence_provenance);
  return covered.length === checkpoint.covered_message_ids.length && checkpoint.coverage_fingerprint === coverageFingerprint(covered) && evidence !== null
    && await validateEvidence(db, conversationId, botId, evidence);
}

/** CAS em transação curta sob a posse do caller; nenhuma inferência deve ocorrer segurando o lock. */
export async function commitContextSummary(db: Queryable, conversationId: string, expectedRevision: number, summary: string, covered: readonly ContextRow[], evidence: EvidenceProvenance, at: Date): Promise<boolean> {
  if (!summary.trim() || [...summary].length > SUMMARY_MAX_CHARS) return false;
  // `configuration_fingerprint` (migration 0036) deixou de ser lido ou escrito: continua na tabela só porque a coluna só sai por migration destrutiva (fora da phase 9).
  const result = await db.query(`UPDATE conversation_context SET revision=revision+1,summary=$3,covered_message_ids=$4::bigint[],coverage_fingerprint=$5,evidence_provenance=$6::jsonb,updated_at=$7 WHERE conversation_id=$1 AND revision=$2`, [conversationId, expectedRevision, summary, covered.map((row) => row.id!), coverageFingerprint(covered), JSON.stringify(mergeEvidence(evidence)), at]);
  return result.rowCount === 1;
}

/**
 * Uma linha por tentativa paga; ausência/resultado incerto é explícito, cache nunca é subtraído da entrada. `blocks` (migration 0052) são os hashes do pedido enviado
 * (`requestBlockHashes`), gravados na abertura da linha junto com o resto da identidade da chamada; `null` deixa as colunas NULL (chamador que não os calcula).
 */
export async function startModelUsage(db: Queryable, conversationId: string, runId: string, purpose: 'main' | 'summary', model: string, protocol: ChatProtocol, at: Date, fingerprint: string | null = null, evidence: EvidenceProvenance | null = null, preparationId:string|null=null, blocks: RequestBlockHashes | null = null): Promise<string> {
  const id = randomUUID();
  try {
    await db.query('INSERT INTO model_call_usage(id,conversation_id,run_id,purpose,model,protocol,created_at,request_fingerprint,evidence_provenance,preparation_id,system_hash,objective_hash,tools_hash,history_hash,history_turns,history_round_hashes,history_prior_hash,effort) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::text[],$17,$18)',
      [id, conversationId, runId, purpose, model, protocol, at, fingerprint, evidence === null ? null : JSON.stringify(evidence), preparationId, blocks?.system ?? null, blocks?.objective ?? null, blocks?.tools ?? null, blocks?.history ?? null, blocks?.historyTurns ?? null, blocks?.historyRoundHashes ?? null, blocks?.historyPriorHash ?? null, blocks?.effort ?? null]);
  } catch (error) {
    if (purpose === 'summary' && (error as { code?: string }).code === '23505') throw new DomainError('CONTEXT_COMPACTION_FAILED');
    throw error;
  }
  return id;
}

/**
 * Finalização idempotente: custo conhecido é separado da aplicação do resumo; repetir settle não soma usage. `reasoning_tokens` (migration 0045) é a fatia do
 * raciocínio dentro de `output_tokens`, gravada na chamada principal e na de resumo; NULL quando o provedor não informou (nunca 0 por omissão). `cache_write_tokens`
 * (migration 0049) é a gravação de cache do protocolo `messages`, uma fatia de `input_tokens` (que segue o total, CTX-08) guardada à parte porque o relatório de custo a cobra
 * pelo preço próprio; `cached_tokens` continua só a leitura. NULL quando o provedor não informou (chat_completions e responses, ou campo omitido).
 */
export async function finishModelUsage(db: Queryable, id: string, usage: ChatUsage, completed: boolean, at: Date, summaryOutcome: 'applied' | 'output_limit' | 'empty' | null = null): Promise<void> {
  await db.query('UPDATE model_call_usage SET state=$2,input_tokens=$3,output_tokens=$4,cached_tokens=$5,completed_at=$6,summary_outcome=$7,reasoning_tokens=$8,cache_write_tokens=$9 WHERE id=$1 AND state=\'started\'', [id, completed ? 'completed' : 'unknown', usage.inputTokens ?? null, usage.outputTokens ?? null, usage.cachedTokens ?? null, at, summaryOutcome, usage.reasoningTokens ?? null, usage.cacheWriteTokens ?? null]);
}

/**
 * Reserva linearizável por locks de origem já usados pelos mutadores (anexos, tabelas e docs); caller libera antes de tocar a rede. Fonte removida ou com acesso revogado depois da preparação
 * lança `CONTEXT_EVIDENCE_UNAVAILABLE` (não é falha de resumo: vale para a chamada principal também), e nada é enviado ao provedor.
 */
export async function reserveModelSources(db: Queryable, conversationId: string, botId: string | null, evidence: EvidenceProvenance): Promise<void> {
  if (evidence.attachments.length) await db.query('SELECT id FROM attachments WHERE id=ANY($1::bigint[]) ORDER BY id FOR SHARE', [evidence.attachments]);
  if (evidence.tables.length) await db.query('SELECT id FROM data_tables WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [evidence.tables.map((table) => table.tableId)]);
  // Docs (phase 14, A33): o mesmo travamento das tabelas. A exclusão do doc e a revogação do acesso (que sobe `docs.access_version`) esperam esta leitura, então um doc lido pelo bot não some nem perde o
  // acesso entre a validação e o envio ao provedor.
  if (evidence.docs.length) await db.query('SELECT id FROM docs WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [evidence.docs.map((doc) => doc.docId)]);
  if (!await validateEvidence(db, conversationId, botId, evidence)) throw new DomainError('CONTEXT_EVIDENCE_UNAVAILABLE');
}

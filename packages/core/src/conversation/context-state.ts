// Leitura de metadados da janela/usage: nunca carrega conteúdo da conversa para a apresentação.
import { CONTEXT_WINDOW_PRESETS, contextMeasurementSchema, contextOperationSchema, resolveContextWindow, type ContextMeasurement, type ContextState, type ContextUsageCounts, type ContextWindowResolution } from '@aion/shared';
import type { Queryable } from '../db/pool';
import { cutHistory } from '../runs/compaction';
import { contextEnvelope, MAX_OUTPUT_TOKENS } from '../runs/context-budget';
import type { ContextRow } from '../runs/context';
import { contextFingerprint } from '../runs/context-checkpoint';
import { onPathSql, pathIds, readActivePath } from './path';
import { resolveConversationContextWindow } from './context-window';
import { resolveModelChoice } from './model-choice';
import { isPlausibleUsage } from '../runs/token-calibration';
import { parseEvidence,validateEvidence } from '../runs/evidence-provenance';
import { modelCredentialKind } from '../models/service';
import { readAppSettings } from '../settings/service';

interface UsageRow { run_id: string; purpose: 'main' | 'summary'; state: string; input_tokens: string | null; output_tokens: string | null; cached_tokens: string | null }

/** Soma apenas contagens informadas; explicita cobertura incompleta e não mistura cache com entrada/saída. */
export function aggregateContextUsage(rows: readonly UsageRow[], legacy = false): ContextUsageCounts {
  const sum = (field: 'input_tokens' | 'output_tokens' | 'cached_tokens') => {
    const known = rows.flatMap((row) => row[field] === null ? [] : [Number(row[field])]);
    return rows.length === 0 ? (legacy ? null : 0) : known.length ? known.reduce((total, value) => total + value, 0) : null;
  };
  const complete = !legacy && rows.every((row) => row.state === 'completed' && row.input_tokens !== null && row.output_tokens !== null);
  const anyKnown = rows.some((row) => row.input_tokens !== null || row.output_tokens !== null);
  return { calls: rows.length, inputTokens: sum('input_tokens'), outputTokens: sum('output_tokens'), cachedTokens: sum('cached_tokens'), coverage: complete ? 'complete' : anyKnown ? 'partial' : 'unknown' };
}

/** Folga e excesso de uma entrada medida frente a um orçamento de entrada: fonte única das duas contas no fechamento da medição e na releitura sobre a janela vigente. */
const headroom = (inputTokens: number, inputBudget: number) => ({ availableTokens: Math.max(0, inputBudget - inputTokens), excessTokens: Math.max(0, inputTokens - inputBudget) });

/**
 * Tudo o que a revisão de contexto enxerga, lido do banco: a janela resolvida, a escolha de modelo, as preferências de idioma e fuso e os metadados do material
 * elegível. Separado do hash para que `changedOnlyByWindow` refaça a revisão trocando só a janela. Metadados apenas (ids, versões, carimbos e um hash da linha do bot):
 * o texto da conversa e as instruções do bot nunca saem do banco aqui.
 */
async function readRevisionInputs(db: Queryable, conversationId: string) {
  // Queryable pode ser um cliente transacional: não concorrer comandos no mesmo socket do pg.
  const window=await resolveConversationContextWindow(db,conversationId), choice=await resolveModelChoice(db,conversationId),settings=await readAppSettings(db);
  // `bot` é o hash da linha do bot SEM `context_window_tokens` e `updated_at`. Com `updated_at`, editar só a janela do bot (que o serviço grava junto com o carimbo) mudava
  // a revisão por dois motivos e `changedOnlyByWindow` não conseguiria dizer que a janela foi a única mudança; a janela já entra pelo `window` resolvido, e qualquer outra
  // coluna do bot (nome, instruções, modelo, effort, limite de etapas, arquivamento) continua mudando a revisão, como antes.
  const metadata=await db.query(`SELECT coalesce((SELECT max(id) FROM conversation_events WHERE conversation_id=$1 AND kind IN ('message','path','objective')),0)::text AS content,
      coalesce((SELECT revision FROM conversation_context WHERE conversation_id=$1),0) AS checkpoint,
      (SELECT version FROM bot_objectives WHERE bot_id=(SELECT bot_id FROM conversations WHERE id=$1)) AS objective,
      (SELECT md5((to_jsonb(b) - 'context_window_tokens' - 'updated_at')::text) FROM bots b WHERE b.id=(SELECT bot_id FROM conversations WHERE id=$1)) AS bot,
      (SELECT updated_at FROM global_memory) AS global_memory,
      (SELECT version FROM bot_memories WHERE bot_id=(SELECT bot_id FROM conversations WHERE id=$1)) AS bot_memory,
      (SELECT count(*) FROM context_cold_masks WHERE conversation_id=$1)::int AS cold`, [conversationId]);
  // Limpeza fria (phase 11, T7): trocar resultados antigos por marcadores muda o pedido sem mudar nenhuma mensagem, então a medição guardada fica desatualizada e uma manutenção
  // pedida sobre o estado de antes (`expectedRevision`) perde o CAS. A contagem só entra na revisão quando há limpeza gravada: sem ela a revisão é bit a bit a de antes da
  // migration 0047, e as medições e o `expectedRevision` das conversas existentes não ficam desatualizados por causa do deploy.
  const { cold, ...stored } = metadata.rows[0];
  return { window, choice, settings, metadata: cold > 0 ? { ...stored, cold } : stored };
}

type RevisionInputs = Awaited<ReturnType<typeof readRevisionInputs>>;

/**
 * O envelope (reserva de saída, margem e orçamento de entrada) que uma preparação de hoje daria a esta janela efetiva: a MESMA conta do motor (`contextEnvelope`, com o teto base
 * `MAX_OUTPUT_TOKENS` e a capacidade de saída confirmada do modelo da resolução). A reserva de saída é função da janela (phase 12: 25% dela, até 32.768), então ela não é um dado da
 * medição, e sim algo que o estado recalcula sempre que lê a janela. Nulo sem janela efetiva (modelo não definido): nada a calcular. Usa o teto base do produto, não o `config.maxTokens` do
 * motor: um motor configurado com outro teto (só acontece em testes) gravaria uma reserva diferente da que o estado reconstrói.
 */
const envelopeOf = (window: ContextWindowResolution) => window.effectiveTokens === null ? null : contextEnvelope(window.effectiveTokens, MAX_OUTPUT_TOKENS, window.capacity?.outputTokens);

/**
 * A ordem das chaves é parte da identidade: mudá-la muda toda revisão já gravada. A reserva de saída entra nos insumos (phase 12, F1): uma medição gravada com a reserva antiga (o teto de
 * 8.192 de antes) tem a revisão do hash sem ela, então depois do deploy fica desatualizada e é refeita na próxima preparação. Derivada aqui da própria janela dos insumos, e não lida
 * à parte, para que `changedOnlyByWindow` (que troca a janela) recalcule a reserva de cada janela candidata e nunca compare um hash com a reserva da janela errada.
 */
const revisionOf = (inputs: RevisionInputs): number => parseInt(contextFingerprint({ ...inputs, outputReserve: envelopeOf(inputs.window)?.outputReserve ?? null }).slice(0, 12), 16);

/** Revisão opaca e estável do material elegível/configuração; evento de medição não invalida a própria medição. */
export async function readContextRevision(db: Queryable, conversationId: string): Promise<number> {
  return revisionOf(await readRevisionInputs(db, conversationId));
}

/**
 * A medição guardada ficou desatualizada SÓ porque a janela mudou? (phase 9, T11.) A revisão gravada junto da medição é um hash, então a pergunta se responde refazendo
 * o hash com cada janela que o dono poderia ter tido (as predefinidas, herdada do global ou definida no bot) e mantendo todo o resto como está agora: se alguma
 * reproduz a revisão gravada, nada além da janela mudou (modelo, effort, idioma, memória, objetivo, instruções, checkpoint e mensagens são os mesmos de quando a medição
 * foi feita). Dois hashes por preset, de um JSON pequeno; modelo e capacidade vêm da resolução atual, pois fazem parte do que precisa coincidir.
 */
function changedOnlyByWindow(inputs: RevisionInputs, storedRevision: number): boolean {
  for (const origin of ['global', 'bot'] as const) {
    for (const preferred of CONTEXT_WINDOW_PRESETS) {
      if (revisionOf({ ...inputs, window: resolveContextWindow(preferred, origin, inputs.window.model, inputs.window.capacity) }) === storedRevision) return true;
    }
  }
  return false;
}

/**
 * A medição sobre o envelope da janela VIGENTE (`envelopeOf`): os tokens medidos continuam valendo (o conteúdo é o mesmo), mas a reserva de saída, a margem e o orçamento de entrada
 * são os da janela de hoje, pela mesma conta do motor. A reserva de saída é função da janela (25% dela, até 32.768, phase 12), então ela troca junto com a janela e não é mais
 * herdada da medição. Sem chamar o modelo.
 */
function onWindow(measurement: ContextMeasurement, { outputReserve, margin, inputBudget }: NonNullable<ReturnType<typeof envelopeOf>>): ContextMeasurement {
  return { ...measurement, outputReserve, inputBudget, margin, ...headroom(measurement.inputTokens, inputBudget) };
}

/**
 * Fecha a medição de uma chamada principal concluída (phase 9, F1 passo 4). A medição gravada na preparação é do pedido ANTES da resposta, e a própria
 * resposta (mensagem, etapa de ferramenta) muda a revisão de `readContextRevision`: sem este passo o indicador marcaria "Desatualizado" por causa do que o
 * bot acabou de fazer. Aqui a medição passa a ser a entrada REAL informada pelo provedor (cache incluído, a mesma base da âncora de `context-anchor.ts`) e
 * `measurement_revision` recebe a revisão atual, lida na mesma transação. Conteúdo que chegar depois (mensagem nova, edição de memória, objetivo) muda a
 * revisão outra vez e volta a marcar "Desatualizado". `readContextRevision` não muda: ele é também o CAS de `expectedRevision` das manutenções.
 * Só entra como medição o usage utilizável: inteiro positivo E plausível frente à estimativa textual crua do mesmo pedido (`estimatedTextTokens`, a que a
 * preparação gravou; `isPlausibleUsage`, a mesma regra de `MIN_PLAUSIBLE_RATIO` que a calibração e a âncora aplicam). Provedor que informa só parte da
 * entrada (ou um valor fixo) não pode virar a ocupação exibida enquanto a âncora o descarta: seria a tela e o gatilho com números diferentes. Nesses
 * casos (ausente, zero, fracionário, implausível ou sem estimativa de referência) a estimativa da preparação é mantida e só a revisão avança.
 * Devolve se havia medição para atualizar (o chamador publica o evento `context` para o indicador se atualizar sem recarregar).
 * Quem chama segura a posse da execução (`holdLease`) na mesma transação.
 * ponytail: mensagem do dono absorvida durante a chamada (CONV-03) entra na revisão lida aqui e fica sem "Desatualizado" até a próxima preparação, que a
 * absorve e mede de novo; trocar por revisão capturada antes da chamada se esse intervalo passar a enganar o indicador.
 */
export async function settleMeasurementAfterResponse(tx: Queryable, conversationId: string, reportedInputTokens: number | undefined, estimatedTextTokens: number | undefined, at: Date): Promise<boolean> {
  const stored = await tx.query<{ measurement: unknown }>('SELECT measurement FROM conversation_context WHERE conversation_id=$1 FOR UPDATE', [conversationId]);
  const parsed = contextMeasurementSchema.safeParse(stored.rows[0]?.measurement);
  if (!parsed.success) return false;
  const revision = await readContextRevision(tx, conversationId);
  const previous = parsed.data;
  const usable = reportedInputTokens !== undefined && Number.isSafeInteger(reportedInputTokens) && reportedInputTokens > 0
    && estimatedTextTokens !== undefined && isPlausibleUsage(reportedInputTokens, estimatedTextTokens);
  const measurement = !usable ? previous
    : { ...previous, measuredAt: at.toISOString(), inputTokens: reportedInputTokens, ...headroom(reportedInputTokens, previous.inputBudget) };
  await tx.query('UPDATE conversation_context SET measurement=$2,measurement_revision=$3 WHERE conversation_id=$1', [conversationId, JSON.stringify(measurement), revision]);
  return true;
}

/** Motivo mostrado (dica do botão desabilitado) quando "Compactar agora" não teria nada a cobrir. */
export const NO_HISTORY_TO_COVER_REASON = 'Ainda não há histórico antigo para compactar.';

/**
 * Há histórico que o "Compactar agora" possa cobrir? (phase 9, F6 passo 2.) Usa a MESMA regra de corte da compactação (`cutHistory`, `compaction.ts`, fonte única do que é
 * lote e do que fica íntegro) sobre as mesmas linhas que o executor veria: as do histórico ainda não coberto por um checkpoint VÁLIDO, no caminho ativo do Chat geral.
 * Só metadados saem do banco (nunca o texto da conversa): a regra de corte não lê conteúdo, e o custo das linhas só entra na conta pelo trecho final.
 * Validade do checkpoint: o executor confere a impressão linha a linha (`validCheckpoint`, que exige o texto de toda linha coberta); aqui basta o que muda na prática,
 * linha coberta fora do caminho ativo (Chat geral) ou fonte de proveniência revogada (anexo excluído). Sem checkpoint válido o histórico inteiro conta.
 * ponytail: o corte real guarda um trecho final de até 25% do orçamento de entrada e esse tamanho depende do turno de sistema, da memória e do catálogo de
 * ferramentas, que só o executor monta. Aqui o trecho final é zero, ou seja, só se descarta o que NUNCA pode ser coberto (a etapa mais recente, atividade em andamento
 * e cartões só do dono): o botão nunca fica desabilitado quando há o que cobrir, e um histórico curto que cabe todo no trecho final habilita o botão e a ação responde
 * "Nada a compactar.". Trocar por um cálculo exato se o dono estranhar esse clique sem efeito.
 * ponytail: roda a cada leitura de estado (GET, snapshot, SSE `context`) e custa uma consulta de metadados das linhas desde o início da cobertura mais a validação da
 * proveniência do checkpoint; é barato para um dono e conversas de centenas de linhas. Medir e trocar por um campo materializado em `conversation_context` (atualizado
 * na compactação e a cada mensagem) ou por um cache por revisão se a leitura do estado passar de dezenas de milissegundos ou o SSE de `context` ficar frequente.
 */
export async function hasHistoryToCover(db: Queryable, conversationId: string, botId: string | null): Promise<boolean> {
  const checkpoint = (await db.query<{ coverage_start: string; covered_message_ids: string[]; summary: string; evidence_provenance: unknown }>(
    'SELECT coverage_start::text, covered_message_ids::text[], summary, evidence_provenance FROM conversation_context WHERE conversation_id=$1', [conversationId])).rows[0];
  // Sem linha de contexto o motor nunca preparou esta conversa: não há histórico a cobrir.
  if (!checkpoint) return false;
  const path = botId === null ? pathIds((await readActivePath(db, conversationId)).rounds) : null;
  const rows = (await db.query<ContextRow>(`SELECT m.id::text AS id, m.run_id::text AS run_id, m.role, m.kind, m.status, m.opens_round, m.step, '' AS content,
      CASE WHEN m.kind = 'card' THEN jsonb_build_object('type', m.data->>'type') ELSE '{}'::jsonb END AS data
    FROM messages m WHERE m.conversation_id=$1 AND m.id >= $2 AND m.status NOT IN ('streaming','discarded') ${path ? `AND ${onPathSql('m', 3, 4)}` : ''} ORDER BY m.id`,
  [conversationId, checkpoint.coverage_start, ...(path ? [path.messageIds, path.runIds] : [])])).rows;
  const covered = new Set(checkpoint.covered_message_ids);
  const evidence = parseEvidence(checkpoint.evidence_provenance);
  const valid = checkpoint.summary !== '' && rows.filter((row) => covered.has(row.id!)).length === covered.size && evidence !== null && await validateEvidence(db, conversationId, botId, evidence);
  const visible = valid ? rows.filter((row) => !covered.has(row.id!)) : rows;
  // Conversa ociosa (é o único caso em que o botão vale): a próxima mensagem abre uma rodada nova, então não há "rodada atual" a proteger (`idle`).
  return cutHistory(visible, { tailTokens: 0, costOf: () => 1, idle: true }).batch.length > 0;
}

/** Mesmo envelope público no GET/snapshot/SSE, com orçamento e consumo claramente separados. */
export async function readContextState(db: Queryable, conversationId: string): Promise<ContextState> {
  const [inputs, stored, usage, latest, active, legacy] = await Promise.all([
    readRevisionInputs(db, conversationId),
    db.query<{ measurement: unknown; measurement_revision: string | null;phase:ContextState['phase'];measurement_provenance:unknown }>('SELECT measurement,measurement_revision::text,phase,measurement_provenance FROM conversation_context WHERE conversation_id=$1', [conversationId]),
    db.query<UsageRow>('SELECT run_id::text,purpose,state,input_tokens::text,output_tokens::text,cached_tokens::text FROM model_call_usage WHERE conversation_id=$1 ORDER BY created_at,run_id,id', [conversationId]),
    // Só a última operação que o DONO pediu ("Compactar agora", com sessão): a manutenção fria (`session_id` nulo, migration 0048) é do worker, não é gesto do dono e não vira
    // "operação" na tela, nem com o resultado ("Nada foi alterado; tente de novo" para uma falha que o dono não causou). Ela é INVISÍVEL enquanto roda (spec, decisão 22): nem a fase
    // `summarizing` (o executor não a publica na fria) nem o motivo "manutenção em andamento" (`busy`, abaixo, dá o motivo genérico de execução aberta); aparece só pelo efeito, a
    // medição nova.
    db.query<{ request_id: string; mode: string; outcome: string | null; result: unknown; error_code: string | null; status: string }>('SELECT m.request_id,m.mode,m.outcome,m.result,m.error_code,r.status FROM context_maintenance m JOIN runs r ON r.id=m.run_id WHERE m.conversation_id=$1 AND m.session_id IS NOT NULL ORDER BY m.created_at DESC,m.run_id DESC LIMIT 1', [conversationId]),
    db.query<{ status: string; context_operation_id: string | null; cold: boolean }>("SELECT r.status,r.context_operation_id,(m.session_id IS NULL AND m.request_id IS NOT NULL) AS cold FROM runs r LEFT JOIN context_maintenance m ON m.run_id=r.id WHERE r.conversation_id=$1 AND r.status IN ('queued','running','waiting_approval') ORDER BY r.id LIMIT 1", [conversationId]),
    db.query("SELECT 1 FROM runs r WHERE r.conversation_id=$1 AND r.context_operation_id IS NULL AND r.last_model IS NOT NULL AND NOT EXISTS(SELECT 1 FROM model_call_usage u WHERE u.run_id=r.id) LIMIT 1", [conversationId]),
  ]);
  // A janela e a revisão saem da MESMA leitura: o orçamento recalculado abaixo e a decisão de "desatualizada" não podem enxergar janelas diferentes.
  const { window } = inputs, revision = revisionOf(inputs), envelope = envelopeOf(window);
  const parsed = contextMeasurementSchema.safeParse(stored.rows[0]?.measurement);
  const source=parseEvidence(stored.rows[0]?.measurement_provenance);
  const owner=(await db.query<{bot_id:string|null;archived_at:Date|null}>('SELECT c.bot_id,b.archived_at FROM conversations c LEFT JOIN bots b ON b.id=c.bot_id WHERE c.id=$1',[conversationId])).rows[0]!;
  const botId=owner.bot_id;
  const valid=source!==null && await validateEvidence(db,conversationId,botId,source);
  // Só a janela mudou (T11): os tokens medidos seguem válidos e a ocupação passa a ser sobre o orçamento da janela vigente, sem "Desatualizado" por causa dela.
  // Conteúdo, modelo ou configuração novos junto com a janela mantêm a medição como foi feita e desatualizada, até a próxima preparação medir de novo.
  // Reserva de saída (phase 12, F1): uma medição gravada com reserva diferente da de hoje (o teto de 8.192 de antes do deploy, ou a reserva de outra janela, que agora é 25% dela) mostra o
  // envelope vigente com os mesmos tokens medidos, em vez do orçamento antigo. Isso é só a exibição: a revisão já mudou (`revisionOf` leva a reserva), então a medição segue marcada
  // como desatualizada, e a próxima preparação a refaz pelo envelope novo.
  // ponytail: o orçamento só é recalculado (e nada é regravado) quando a janela é a única mudança ou a reserva gravada difere da vigente, a medição desatualizada por conteúdo junto com a
  // janela, com a mesma reserva, segue com o orçamento antigo até a próxima preparação, trocar por uma remedição sem chamar o modelo se o dono estranhar esse intervalo.
  const storedRevision = Number(stored.rows[0]?.measurement_revision);
  const windowOnly = storedRevision !== revision && envelope !== null && changedOnlyByWindow(inputs, storedRevision);
  const reserveOutdated = parsed.success && envelope !== null && parsed.data.outputReserve !== envelope.outputReserve;
  const measurement = parsed.success ? { ...(windowOnly || reserveOutdated ? onWindow(parsed.data, envelope) : parsed.data), stale: (storedRevision !== revision && !windowOnly) || !valid } : null;
  const operationRow = latest.rows[0];
  const operation = operationRow ? contextOperationSchema.parse({ requestId: operationRow.request_id, mode: operationRow.mode,
    status: operationRow.outcome ?? (operationRow.status === 'running' ? 'running' : operationRow.status === 'queued' ? 'queued' : operationRow.status === 'interrupted' ? 'cancelled' : operationRow.status === 'completed' ? 'completed' : 'failed'),
    cancelable: operationRow.outcome === null && ['queued', 'running'].includes(operationRow.status), result: operationRow.result, errorCode: operationRow.error_code }) : null;
  const busy = active.rows[0];
  const reason = owner.archived_at !== null ? 'O bot está arquivado.' : window.model === null ? 'Defina um modelo para calcular o contexto.' : busy ? busy.context_operation_id && !busy.cold ? 'Há uma manutenção em andamento.' : busy.status === 'waiting_approval' ? 'Resolva a aprovação pendente antes de compactar.' : 'Há trabalho na fila ou em execução.' : null;
  const profile=window.model===null?null:(await db.query<{test_protocol:string|null;provider_configured:boolean}>("SELECT (SELECT test_protocol FROM model_profiles WHERE model_id=$1) AS test_protocol,EXISTS(SELECT 1 FROM credentials WHERE kind=$2) AS provider_configured",[window.model,modelCredentialKind(window.model)])).rows[0];
  // Razões em ordem de prioridade: o que impede qualquer manutenção (`reason`), o que a compactação por resumo exige (perfil validado e chave) e, por último, ter o que cobrir.
  const summarizeReason=reason??(!profile?.test_protocol?'Valide o modelo em Configurações antes de compactar.':!profile.provider_configured?'Configure a chave do provedor antes de compactar.':await hasHistoryToCover(db,conversationId,botId)?null:NO_HISTORY_TO_COVER_REASON);
  const split = (rows: readonly UsageRow[], unknown = false) => ({ main: aggregateContextUsage(rows.filter((row) => row.purpose === 'main'), unknown), summary: aggregateContextUsage(rows.filter((row) => row.purpose === 'summary'), unknown), total: aggregateContextUsage(rows, unknown), cost: null });
  const lastId = usage.rows.at(-1)?.run_id;
  return { revision, model: window.model, window, measurement,
    phase: operation?.status === 'running' || operation?.status === 'queued' ? 'summarizing' : stored.rows[0]?.phase ?? 'not_measured',
    operation, eligibility: { enabled: reason === null, reason,summarizeEnabled:summarizeReason===null,summarizeReason }, usage: { ...split(usage.rows, !!legacy.rowCount), last: lastId ? { runId: lastId, ...split(usage.rows.filter((row) => row.run_id === lastId)) } : null } };
}

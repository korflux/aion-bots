// Manutenção fria do contexto (phase 11, T7 e T8; spec F4, F5 e F6, decisões 13, 15 a 18 e 20 a 23; A9 a A14; CTX-07 substituída parcialmente): a regra única de "conversa fria",
// o mascaramento dos resultados antigos de ferramenta que ela permite, a compactação em segundo plano que vem depois dele e o laço do worker que aplica as duas sozinho.
//
// Por que existe: com a conversa quente o provedor reaproveita o prefixo do pedido do cache, e reescrever qualquer ponto do meio do histórico o perderia (CTX-07, phase 9, e a
// regra de prefixo estável da phase 10). Com a conversa fria o cache provavelmente já se perdeu (T de `COLD_AFTER_MS` fica acima do maior intervalo medido com cache válido, 30 minutos, e o cache estava morto em 60), então trocar o conteúdo de um resultado antigo por um marcador curto não custa cache na prática e
// enxuga o pedido. A troca é GRAVADA (`context_cold_masks`, migration 0047) para o pedido seguinte começar igual ao último pedido limpo e só crescer no fim, voltando a valer o
// cache. O resultado íntegro nunca é apagado nem reescrito: o marcador existe só no que vai ao modelo (`coldMaskMarker`, `runs/context.ts`), e `read_activity` o devolve inteiro (a forma que o modelo recebia, ou o gravado em part=original).
//
// Conversa fria (decisão 13): nenhuma chamada ao modelo na conversa há mais de `COLD_AFTER_MS` E nenhuma execução ativa ou na fila. É UMA regra, em `coldConversations`, e vale
// igual para os dois chamadores, que nunca decidem por conta própria:
//   - o laço do worker (`ColdMaintenance`), que varre as conversas frias a cada `pollMs` (F4);
//   - a abertura de uma execução numa conversa fria que o worker ainda não tratou (`RunExecutor`, F6): a rede de segurança, sem chamar o modelo e sem compactar.
// Os dois só gravam por `maskColdResults`, que reconfere a regra DENTRO da transação que segura a trava da fila da conversa (a mesma de `queueRun`): ninguém enfileira uma
// execução entre a conferência e a gravação, então a limpeza nunca cai no meio de uma execução quente.
// Uma terceira leitura da MESMA regra, de trás para a frente sobre o que está gravado, diz quando a lista das "mais usadas" do bot é recalculada (`readMostUsedAnchor`, phase 15, passo 12, decisão 24):
// não grava nada e não depende de os dois chamadores acima terem passado antes nem de haver resultado a mascarar.
//
// Compactação fria (T8, decisão 18): depois de mascarar, a conversa que continua pesada é compactada ali mesmo, sem fazer o dono esperar na próxima mensagem. Só o laço do worker
// decide (nunca a abertura de uma execução, F6): `enqueueColdCompaction` enfileira, na MESMA fila FIFO da conversa e sob a mesma trava, uma manutenção de contexto sem sessão do
// dono (`queueContextMaintenance`, migration 0048: `session_id` nulo = fria) e quem a executa é o `RunExecutor`, que roda a compactação de sempre (CTX-07: checkpoint em sete
// seções, modo atualizar, Modelo do resumo) com o gatilho próprio "frio". O gatilho (`coldTriggerTokens`) é decidido por essa execução, pela MESMA conta de ocupação da preparação (CTX-08,
// `modelStep`): o worker só filtra por um proxy barato (a última medição gravada, `aboveColdThreshold`) para não abrir uma execução por conversa leve. Uma mensagem do dono que chegue
// durante a compactação espera na fila como espera atrás de qualquer manutenção e prepara o pedido já com o checkpoint novo; o resumo pago nunca é descartado.
//
// O que se mascara (decisão 15): resultado de ferramenta concluído com mais de `COLD_MASK_MIN_CHARS` caracteres gravados, fora das `COLD_RECENT_ROUNDS` rodadas mais recentes.
// Mensagens do dono, respostas do bot e cartões nunca entram (só `kind = 'activity'`). No Chat geral vale só o caminho ativo (CONV-01, `conversation/path.ts`).
// Abertura de grupo (phase 15, A25): o esquema que `abrir_grupo` devolveu pesa mais que o limiar e é mascarado como qualquer resultado grande. O modelo volta ao esquema abrindo o MESMO caminho de novo
// (a porta não tem estado: devolve os esquemas outra vez, em resultado novo no fim do histórico) ou relendo a abertura pelo marcador (`read_activity`, part=result); a chamada por `use_tool` não depende do
// esquema estar no pedido, porque o alvo sai do registry da execução. A mesma regra vale depois de uma compactação, que também tira a abertura do pedido.
// Ponto de extensão: um novo critério de elegibilidade muda só `maskableSql`; outro intervalo ou limiar, as constantes abaixo.
import { createHash } from 'node:crypto';
import { contextMeasurementSchema } from '@aion/shared';
import { databaseErrorForLog, type Logger } from '../logging';
import { hasHistoryToCover, readContextRevision } from '../conversation/context-state';
import { resolveConversationContextWindow } from '../conversation/context-window';
import { onPathSql, pathIds, readActivePath } from '../conversation/path';
import { queueContextMaintenance, summarizeBlocker } from '../conversation/run-queue';
import { withTransaction, type Pool, type Queryable } from '../db/pool';
import { READ_ATTACHMENT_TOOL } from './read-attachment';

/**
 * T da decisão 13: quanto tempo sem nenhuma chamada ao modelo faz a conversa ser fria. Valor fixado pela medição real do cache do OpenCode Go
 * (`.vibeflow/phases/phase-11-contexto-enxuto/cache-ttl.md`, 18/10/2026): o cache valeu até 30 minutos e estava morto em 60, então T = 30 + 10 de folga = 40 minutos. Nunca abaixo
 * do maior intervalo em que a sonda viu o cache valer (decisão 14); só muda com decisão do dono depois de nova medição (Ask first da spec).
 */
export const COLD_AFTER_MS = 40 * 60_000;
/** Rodadas mais recentes que o mascaramento nunca toca (decisão 15). */
export const COLD_RECENT_ROUNDS = 2;
/** Resultado de ferramenta com mais caracteres gravados que isto é elegível ao mascaramento (decisão 15). */
export const COLD_MASK_MIN_CHARS = 1_000;
/**
 * Fração do orçamento de entrada que o gatilho frio nunca ultrapassa (decisão 18, phase 11): 50%, contra os 90% do gatilho de sempre, que continua como rede de segurança durante a
 * conversa. Desde a phase 15 o gatilho é `coldTriggerTokens`, o menor entre este teto e `COLD_TRIGGER_TOKENS`: nas janelas de 64k continua valendo os 50%, e nas maiores o limite
 * absoluto traz o gatilho para baixo. A ocupação comparada é a de CTX-08, a mesma do indicador e do gatilho de 90%; quem compara é o `RunExecutor` (`modelStep`), e `aboveColdThreshold` usa
 * o mesmo gatilho só como filtro barato do worker.
 */
export const COLD_COMPACTION_SHARE = 0.5;
/**
 * Ocupação absoluta (tokens do pedido inteiro: piso mais histórico) a partir da qual a conversa fria é compactada (phase 15, passo 8a, decisões 2 e 13, pedido do dono em origem
 * humana). Antes só valiam os 50% do orçamento (113 mil tokens na janela padrão de 256k), e a rotina que abria numa conversa fria de 100 mil tokens pagava a abertura inteira sem cache
 * (a conversa já esfriou, o cache do prefixo se foi). Valor inicial da decisão 13, "perto de 40 mil", confirmado no banco de testes (`passo-8a.md` da phase): o resumo custa uma chamada
 * (cerca de US$ 0,03) e se paga em poucas aberturas; abaixo disso o pedido já é barato demais para valer o resumo.
 * ponytail: o gatilho é absoluto e igual para todo modelo e janela (limitado a 50% do orçamento), trocar por um valor por modelo se algum tiver preço de entrada muito diferente do DeepSeek.
 */
export const COLD_TRIGGER_TOKENS = 40_000;
/**
 * Tamanho que a compactação fria procura deixar no pedido da abertura seguinte, em tokens (piso do pedido, checkpoint e trecho final somados): perto de 30 mil, dez mil abaixo do gatilho
 * para a conversa não voltar a cruzá-lo logo (decisão 13). O trecho final íntegro recebe o que sobra depois do piso e do checkpoint (`coldTailTokens`).
 */
export const COLD_OPENING_TOKENS = 30_000;

/** Gatilho da compactação fria para um orçamento de entrada: `COLD_TRIGGER_TOKENS`, mas nunca acima de `COLD_COMPACTION_SHARE` do orçamento (janela de 64k: 23.552 tokens). */
export function coldTriggerTokens(inputBudget: number): number {
  return Math.min(COLD_TRIGGER_TOKENS, COLD_COMPACTION_SHARE * inputBudget);
}

/**
 * Teto do trecho final íntegro da compactação fria, em tokens: o que cabe em `COLD_OPENING_TOKENS` depois do piso do pedido (sistema, objetivo e catálogo, `floorTokens`) e do checkpoint.
 * Quem chama o combina com o teto de sempre (`TAIL_SHARE`) pelo menor. Piso grande demais zera o teto: sobram só as mensagens que `cutHistory` protege sempre (a etapa mais recente e,
 * na fria, as mensagens do dono da rodada mais recente).
 */
export function coldTailTokens(floorTokens: number, checkpointTokens: number): number {
  return Math.max(0, COLD_OPENING_TOKENS - floorTokens - checkpointTokens);
}
/** Teto de conversas frias que um ciclo do laço examina (proteção contra uma lista sem fim; cada exame é barato e só as com resultado grande ainda sem limpeza entram). */
const MAX_CANDIDATES = 500;

/**
 * Predicado SQL de "este resultado de ferramenta pode ser mascarado" (alias `alias` de `messages`, escrito pelo código, nunca vindo de fora): atividade concluída, maior que o
 * limiar, ainda sem linha em `context_cold_masks` e que não seja a página inicial lida por `read_attachment`. Essa página é a fonte da deduplicação da mensagem do dono
 * que a anexou (`buildTurns` omite o texto inline "porque a leitura segue íntegra no contexto"): mascará-la trocaria a forma de uma MENSAGEM DO DONO, que nunca muda.
 * `exact` mede em caracteres (o que o marcador conta); sem ele mede em bytes, que não precisa ler o conteúdo do TOAST e serve só de pré-filtro barato do laço (bytes >= caracteres).
 * ponytail: só a página inicial (offset 0) de `read_attachment` fica de fora; as demais páginas (até 4.096 bytes cada) são mascaradas como qualquer resultado, ajustar se o dono
 * quiser reter também as outras páginas lidas.
 */
const maskableSql = (alias: string, exact: boolean): string =>
  `${alias}.kind = 'activity' AND ${alias}.status = 'completed' AND ${exact ? 'char_length' : 'octet_length'}(${alias}.content) > ${COLD_MASK_MIN_CHARS}
   AND NOT (${alias}.data->>'tool' = '${READ_ATTACHMENT_TOOL}' AND ${alias}.data->'detail'->>'type' = 'attachment_read' AND ${alias}.data->'detail'->>'offset' = '0')
   AND NOT EXISTS (SELECT 1 FROM context_cold_masks k WHERE k.message_id = ${alias}.id)`;

/** Uma conversa fria: o id e o bot dono (nulo numa sessão do Chat geral). */
export interface ColdConversation {
  id: string;
  botId: string | null;
}

/**
 * A REGRA ÚNICA de conversa fria (decisão 13), em lote ou para uma conversa (`conversationId`): a última chamada ao modelo da conversa (qualquer propósito, resumo incluído:
 * ela é a medida de "a conversa esteve em uso") é mais antiga que `now - COLD_AFTER_MS` E não há execução `queued`, `running` ou `waiting_approval` (menos `exceptRunId`, a
 * execução que está abrindo e pergunta). Estritamente mais antiga: exatamente T ainda é quente. `onlyWithMaskable` restringe o lote às conversas com algum resultado grande ainda
 * sem limpeza (o pré-filtro barato do laço); a elegibilidade exata e a janela das rodadas recentes são de `maskColdResults`.
 * ponytail: conversa sem nenhuma chamada registrada (anterior ao ledger da phase 9) nunca é fria porque não há instante para medir, e a limpeza dessas conversas antigas só vem
 * depois da próxima chamada (o lado seguro: nunca mascara o que não se sabe frio), trocar o instante da última mensagem como alternativa se conversas antigas e paradas pesarem no pedido.
 * ponytail: o lote examina no máximo `MAX_CANDIDATES` (500) conversas por ciclo, em ordem de id, e uma conversa fria cujo resultado grande está dentro das 2 rodadas recentes (nunca
 * mascarado) continua candidata a cada ciclo e ocupa lugar nessa fila, então com mais de 500 conversas assim as seguintes não são examinadas, trocar por uma marca de "já examinada"
 * por última chamada ou por rodízio quando houver centenas de conversas frias ao mesmo tempo.
 */
async function coldConversations(
  db: Queryable,
  now: Date,
  { conversationId = null, exceptRunId = null, onlyWithMaskable = false }: { conversationId?: string | null; exceptRunId?: string | null; onlyWithMaskable?: boolean } = {},
): Promise<ColdConversation[]> {
  const found = await db.query<{ id: string; bot_id: string | null }>(
    `SELECT c.id::text AS id, c.bot_id::text AS bot_id FROM conversations c
     WHERE ($2::uuid IS NULL OR c.id = $2::uuid)
       AND (SELECT max(u.created_at) FROM model_call_usage u WHERE u.conversation_id = c.id) < $1
       AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.conversation_id = c.id AND r.status IN ('queued', 'running', 'waiting_approval') AND r.id IS DISTINCT FROM $3::bigint)
       AND (NOT $4::boolean OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND ${maskableSql('m', false)}))
     ORDER BY c.id LIMIT ${MAX_CANDIDATES}`,
    [new Date(now.getTime() - COLD_AFTER_MS), conversationId, exceptRunId, onlyWithMaskable],
  );
  return found.rows.map((row) => ({ id: row.id, botId: row.bot_id }));
}

/**
 * O instante do último RECÁLCULO da lista das "mais usadas" do bot na conversa (phase 15, passo 12, correção do checkpoint 2; decisão 24 revisada em 2026-11-08, A42): o maior entre
 *   - a última compactação aplicada (`conversation_context.updated_at` com revisão acima de zero; `commitContextSummary` é a única porta: a do dono, a automática e a fria) e
 *   - a criação da última execução que encontrou a conversa FRIA, que é a regra de `coldConversations` lida de trás para a frente sobre o que está gravado: a última chamada ao modelo anterior à criação
 *     dela é mais antiga que `COLD_AFTER_MS` (estritamente, como na regra) e nenhuma execução anterior ainda estava ativa nesse instante, isto é, toda anterior tinha `finished_at` até ele.
 * Nulo: a conversa nunca foi compactada nem esfriou (bot novo, ou conversa que nunca ficou 40 minutos parada), e vale a lista padrão (A44). O bot tem conversa única, então "conversa nova" é a conversa fria.
 * Por que lido, e não decidido e gravado por alguém: o instante é o `created_at` de uma execução e as chamadas e execuções anteriores a ela, todos dados imutáveis, então é o MESMO em toda etapa, rodada, retomada e
 * reinício até o recálculo seguinte, não deriva do relógio de agora (`now()`) e não depende de ninguém ter passado antes: nem do laço do worker, nem da limpeza da abertura, nem de haver resultado a mascarar (a conversa
 * fria sem nenhum resultado grande também conta). Isto não grava nada e não pede coluna. Três consequências da regra:
 *   - uma execução criada com outra ainda ativa (na fila atrás dela, ou ela própria parada em `waiting_approval`) não acorda a conversa, e a que retoma horas depois da aprovação mantém o instante dela, e não o da
 *     chamada seguinte: a conversa não esfriou, a lista não muda no meio da execução;
 *   - a compactação fria (manutenção do worker) também acorda a conversa, no instante em que é enfileirada, e a compactação que ela aplica vem depois e vale mais (`greatest`);
 *   - a mensagem seguinte, dentro de `COLD_AFTER_MS` da última chamada, não recalcula nada.
 * ponytail: a continuação manual de uma execução parada no limite de saída (`continueRun`) reabre a MESMA linha (`created_at` antigo, `finished_at` volta a nulo) e por isso não conta como acordar a conversa, mesmo
 * depois de mais de 40 minutos; a lista só muda na próxima conversa fria ou compactação, trocar por um instante de reabertura gravado se o dono estranhar.
 * ponytail: a consulta percorre as execuções da conversa da mais recente à mais antiga, com uma sondagem de índice por execução, até a primeira que acordou a conversa; uma conversa que nunca esfria nem compacta
 * percorre todas, medir e materializar o instante se uma conversa passar de dezenas de milhares de execuções sem esfriar.
 */
export async function readMostUsedAnchor(db: Queryable, conversationId: string): Promise<Date | null> {
  const found = await db.query<{ at: Date | null }>(
    `SELECT greatest(
       (SELECT cc.updated_at FROM conversation_context cc WHERE cc.conversation_id = $1 AND cc.revision > 0),
       (SELECT r.created_at FROM runs r
         WHERE r.conversation_id = $1
           AND (SELECT max(u.created_at) FROM model_call_usage u WHERE u.conversation_id = $1 AND u.created_at < r.created_at) < r.created_at - make_interval(secs => $2::double precision)
           AND NOT EXISTS (SELECT 1 FROM runs s WHERE s.conversation_id = $1 AND s.id < r.id AND (s.finished_at IS NULL OR s.finished_at > r.created_at))
         ORDER BY r.id DESC LIMIT 1)) AS at`,
    [conversationId, COLD_AFTER_MS / 1000],
  );
  return found.rows[0]?.at ?? null;
}

export interface MaskColdInput {
  conversationId: string;
  /** O instante do domínio (relógio injetável): mede a frieza e fica em `masked_at`. */
  now: Date;
  /** Execução que está abrindo e pergunta (F6): não conta como "ativa". Ausente no laço do worker. */
  exceptRunId?: string;
  /**
   * Mensagem que abre a rodada da execução que está abrindo (F6): essa rodada NÃO conta entre as rodadas recentes, para a abertura gravar exatamente o que o laço teria gravado
   * se tivesse passado antes de o dono escrever (as duas rodadas anteriores à nova ficam íntegras). Ausente no laço do worker.
   */
  openingMessageId?: string | null;
  /** Quem pediu, só para o log. */
  origin: 'sweep' | 'opening';
  logger: Logger;
}

/**
 * Grava a limpeza fria de UMA conversa, se ela estiver fria, e devolve quantos resultados passaram a ser mascarados (zero: quente, ocupada, nada elegível ou já limpa).
 * Tudo numa transação que segura a trava da fila da conversa (o bot ou, na sessão, a conversa: a mesma de `queueRun`, com `SKIP LOCKED`: se alguém está enfileirando, a conversa não
 * está fria e a limpeza desiste sem efeito) e reconfere a regra de `coldConversations` antes de gravar. Mascara só o que está fora das `COLD_RECENT_ROUNDS` rodadas mais recentes
 * (o corte é o id da abertura da penúltima rodada; no Chat geral, só o caminho ativo). Idempotente: o que já tem linha não é tocado, então repetir não grava nada.
 * Nunca lê nem altera o conteúdo da conversa; o log leva só identificadores e números.
 */
export async function maskColdResults(pool: Pool, { conversationId, now, exceptRunId, openingMessageId = null, origin, logger }: MaskColdInput): Promise<number> {
  // Filtro barato SEM trava: a conversa quente (a imensa maioria das aberturas de execução) sai aqui sem tocar a trava da fila. A decisão é a da reconferência abaixo, dentro da trava.
  if (!(await coldConversations(pool, now, { conversationId, exceptRunId: exceptRunId ?? null })).length) return 0;
  const done = await withTransaction(pool, async (tx) => {
    const owner = (await tx.query<{ bot_id: string | null }>('SELECT bot_id::text AS bot_id FROM conversations WHERE id = $1', [conversationId])).rows[0];
    if (!owner) return null;
    const locked = owner.bot_id === null
      ? await tx.query('SELECT id FROM conversations WHERE id = $1 AND bot_id IS NULL FOR UPDATE SKIP LOCKED', [conversationId])
      : await tx.query('SELECT id FROM bots WHERE id = $1 FOR UPDATE SKIP LOCKED', [owner.bot_id]);
    if (!locked.rowCount) return null;
    if (!(await coldConversations(tx, now, { conversationId, exceptRunId: exceptRunId ?? null })).length) return null;

    // O corte: tudo o que vem a partir da abertura da penúltima rodada (a rodada que está abrindo, se houver, não conta) fica íntegro.
    let cutoff: string | undefined;
    let path: ReturnType<typeof pathIds> | null = null;
    if (owner.bot_id === null) {
      const active = await readActivePath(tx, conversationId);
      const rounds = active.rounds.filter((round) => round.messageId !== openingMessageId);
      cutoff = rounds[rounds.length - COLD_RECENT_ROUNDS]?.messageId;
      path = pathIds(active.rounds);
    } else {
      // `messages.id` qualificado no ORDER BY: um `id` solto seria lido como a coluna de saída `id::text` e ordenaria como texto ("9" depois de "13"), cortando na rodada errada.
      const openings = await tx.query<{ id: string }>(
        `SELECT id::text AS id FROM messages WHERE conversation_id = $1 AND opens_round AND status <> 'discarded' AND ($2::bigint IS NULL OR id < $2::bigint) ORDER BY messages.id DESC LIMIT ${COLD_RECENT_ROUNDS}`,
        [conversationId, openingMessageId],
      );
      cutoff = openings.rows.length === COLD_RECENT_ROUNDS ? openings.rows[COLD_RECENT_ROUNDS - 1]!.id : undefined;
    }
    // Menos de duas rodadas: tudo está entre as recentes, nada a mascarar.
    if (cutoff === undefined) return null;

    const written = await tx.query<{ masked: number; chars: string }>(
      `WITH inserted AS (
         INSERT INTO context_cold_masks (message_id, conversation_id, masked_at)
         SELECT m.id, m.conversation_id, $2 FROM messages m
         WHERE m.conversation_id = $1 AND m.id < $3::bigint AND ${maskableSql('m', true)} ${path ? `AND ${onPathSql('m', 4, 5)}` : ''}
         ON CONFLICT (message_id) DO NOTHING RETURNING message_id)
       SELECT count(*)::int AS masked, coalesce(sum(char_length(m.content)), 0)::text AS chars FROM inserted i JOIN messages m ON m.id = i.message_id`,
      [conversationId, now, cutoff, ...(path ? [path.messageIds, path.runIds] : [])],
    );
    return { masked: written.rows[0]!.masked, chars: Number(written.rows[0]!.chars), botId: owner.bot_id };
  });
  if (!done || done.masked === 0) return 0;
  logger.info({ conversationId, botId: done.botId, origin, masked: done.masked, chars: done.chars }, 'limpeza fria gravada: resultados antigos passam a ir ao modelo como marcador');
  return done.masked;
}

// ---------------------------------------------------------------------------------------------
// Compactação fria (F5)
// ---------------------------------------------------------------------------------------------

/**
 * Identidade da compactação fria de UMA revisão do contexto de UMA conversa: um UUID derivado (SHA-256, formato UUID v8) de `conversationId` e `revision`. É o que dá a idempotência por
 * revisão (decisão 21): o mesmo par sempre produz o mesmo `request_id`, `enqueueColdCompaction` recusa enfileirar quem já tem recibo, e a conversa só ganha outra tentativa quando a
 * revisão muda (mensagem, checkpoint, limpeza fria, janela, modelo, memória, objetivo). Serve também de `runs.context_operation_id`, que é único.
 */
export function coldRequestId(conversationId: string, revision: number): string {
  const hex = createHash('sha256').update(`aion:cold-compaction:${conversationId}:${revision}`).digest('hex');
  const variant = ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * A última medição gravada da conversa (a do indicador do painel, escrita por `modelStep` com a conta única de CTX-08) já estava em `coldTriggerTokens` do orçamento de entrada que
 * valia nela? É só o filtro barato do worker, e propositalmente tolerante a medição desatualizada: o mascaramento só REDUZ o pedido, então uma conversa que já estava abaixo do gatilho
 * antes dele continua abaixo e nunca precisa de resumo; quem estava a partir dele ainda pode ter caído abaixo depois do mascaramento, e isso a execução decide medindo de novo, com a
 * conta de verdade. Sem medição válida (conversa nunca preparada pelo motor) nada se enfileira: o gatilho de 90% da próxima mensagem cobre.
 * ponytail: janela encolhida pelo dono, ou conteúdo trocado, com a conversa fria e a última medição abaixo do gatilho não enfileira a compactação (o orçamento da medição é o antigo); o
 * gatilho de 90% da próxima mensagem cobre, trocar por remedição sem chamar o modelo se esse caso passar a pesar.
 */
async function aboveColdThreshold(db: Queryable, conversationId: string): Promise<boolean> {
  const stored = await db.query<{ measurement: unknown }>('SELECT measurement FROM conversation_context WHERE conversation_id = $1', [conversationId]);
  const parsed = contextMeasurementSchema.safeParse(stored.rows[0]?.measurement);
  return parsed.success && parsed.data.inputBudget > 0 && parsed.data.inputTokens >= coldTriggerTokens(parsed.data.inputBudget);
}

export interface EnqueueColdCompactionInput {
  conversationId: string;
  /** O instante do domínio (relógio injetável): mede a frieza e fica em `runs.created_at` e `context_maintenance.created_at`. */
  now: Date;
  logger: Logger;
}

/**
 * Enfileira, na fila FIFO da conversa, a compactação de uma conversa FRIA que ainda pesa (F5, decisão 18), e devolve se enfileirou. Quem chama é só o laço do worker, depois de
 * `maskColdResults`. Não decide o gatilho (a execução o decide, medindo o pedido pela conta única de CTX-08, decisão 21): aqui só entram as proteções baratas, todas conferidas
 * DENTRO da transação que segura a trava da fila (como `maskColdResults`, com `SKIP LOCKED`: se alguém está enfileirando, a conversa não está fria e desiste sem efeito):
 *   - a conversa continua fria pela regra única (`coldConversations`) e o bot não está arquivado;
 *   - a última medição já estava no gatilho frio ou acima (`aboveColdThreshold`);
 *   - modelo com protocolo validado e chave do provedor (`summarizeBlocker`, a mesma regra do "Compactar agora") e janela de contexto resolvida;
 *   - ainda não existe recibo desta conversa para a revisão atual (`coldRequestId`): a idempotência por revisão, que também impede repetir uma tentativa que falhou;
 *   - há histórico a cobrir (`hasHistoryToCover`, só metadados).
 * A execução enfileirada é uma manutenção de contexto sem sessão do dono (`queueContextMaintenance`, `session_id` nulo): sem rodada, cartão, push nem bolinha. Mensagem do dono que
 * chegue depois entra na fila atrás dela. O log leva só identificadores e números.
 * ponytail: uma tentativa fria por revisão do contexto; falha transitória do provedor só é retentada quando a conversa mudar (o gatilho de 90% da próxima mensagem cobre), trocar por
 * um intervalo de nova tentativa se o dono estranhar conversas pesadas e paradas que seguem sem compactar.
 */
export async function enqueueColdCompaction(pool: Pool, { conversationId, now, logger }: EnqueueColdCompactionInput): Promise<boolean> {
  // Filtros baratos SEM trava (a conversa quente e a leve, a imensa maioria, saem aqui sem tocar a trava da fila). A decisão é a da reconferência abaixo, dentro da trava.
  if (!(await coldConversations(pool, now, { conversationId })).length || !(await aboveColdThreshold(pool, conversationId))) return false;
  const queued = await withTransaction(pool, async (tx) => {
    const owner = (await tx.query<{ bot_id: string | null; archived: boolean }>(
      'SELECT c.bot_id::text AS bot_id, (b.archived_at IS NOT NULL) AS archived FROM conversations c LEFT JOIN bots b ON b.id = c.bot_id WHERE c.id = $1', [conversationId])).rows[0];
    if (!owner || owner.archived) return null;
    const locked = owner.bot_id === null
      ? await tx.query('SELECT id FROM conversations WHERE id = $1 AND bot_id IS NULL FOR UPDATE SKIP LOCKED', [conversationId])
      : await tx.query('SELECT id FROM bots WHERE id = $1 FOR UPDATE SKIP LOCKED', [owner.bot_id]);
    if (!locked.rowCount) return null;
    if (!(await coldConversations(tx, now, { conversationId })).length) return null;
    if (await summarizeBlocker(tx, conversationId) !== null) return null;
    if ((await resolveConversationContextWindow(tx, conversationId)).effectiveTokens === null) return null;
    const revision = await readContextRevision(tx, conversationId);
    const requestId = coldRequestId(conversationId, revision);
    if ((await tx.query('SELECT 1 FROM context_maintenance WHERE request_id = $1', [requestId])).rowCount) return null;
    if (!(await hasHistoryToCover(tx, conversationId, owner.bot_id))) return null;
    await queueContextMaintenance(tx, { botId: owner.bot_id, conversationId, requestId, mode: 'summarize', expectedRevision: revision, sessionId: null, at: now });
    return { botId: owner.bot_id, requestId, revision };
  });
  if (!queued) return false;
  logger.info({ conversationId, botId: queued.botId, requestId: queued.requestId, revision: queued.revision }, 'compactação fria enfileirada: a conversa esfriou com o pedido no gatilho frio ou acima dele');
  return true;
}

// ---------------------------------------------------------------------------------------------
// Laço do worker (F4 e F5)
// ---------------------------------------------------------------------------------------------

export interface ColdMaintenanceConfig {
  /** De quanto em quanto tempo o laço procura conversas frias. */
  pollMs: number;
  /** Quantas conversas com limpeza efetivamente gravada um ciclo trata (as demais ficam para o próximo). */
  batch: number;
}

/** O ciclo de um minuto basta: a frieza se mede em dezenas de minutos e a limpeza não tem pressa. */
export const DEFAULT_COLD_CONFIG: ColdMaintenanceConfig = { pollMs: 60_000, batch: 20 };

export interface ColdMaintenanceOptions {
  pool: Pool;
  logger: Logger;
  /** Relógio do domínio (padrão: agora); os testes o injetam para esfriar uma conversa sem esperar. */
  now?: () => Date;
  config?: Partial<ColdMaintenanceConfig>;
}

/**
 * O laço do worker que cuida das conversas frias: mascara os resultados antigos (F4) e, depois, enfileira a compactação das que continuam pesadas (F5). Mesmo desenho do agendador de
 * rotinas (`routines/scheduler.ts`): `start()` agenda ciclos a cada `pollMs` (erro de um ciclo é logado e o laço continua), `stop()` espera o ciclo em andamento e `tickOnce()` trata o
 * que está frio agora (exposto para os testes). O mascaramento NÃO usa a fila de manutenção de contexto (`runs.context_operation_id`): é só uma gravação sem chamada ao modelo, não uma
 * execução. A compactação precisa dela e a usa (`enqueueColdCompaction`): o laço só ENFILEIRA, quem executa e decide o gatilho é o motor. Duas instâncias do worker não se
 * atrapalham: a gravação é idempotente por resultado, o enfileiramento é idempotente por revisão, e os dois seguram a trava da fila da conversa.
 * ponytail: cada ciclo reexamina toda conversa fria que ainda tenha resultado grande sem limpeza (por exemplo, o que está dentro das duas rodadas recentes); guardar a última chamada
 * já examinada por conversa se o número de conversas frias com resultados grandes passar a pesar no ciclo.
 */
export class ColdMaintenance {
  private readonly pool: Pool;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly config: ColdMaintenanceConfig;
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private ticking: Promise<unknown> = Promise.resolve();

  constructor({ pool, logger, now = () => new Date(), config = {} }: ColdMaintenanceOptions) {
    this.pool = pool;
    this.logger = logger;
    this.now = now;
    this.config = { ...DEFAULT_COLD_CONFIG, ...config };
  }

  /** Começa a procurar conversas frias a cada `pollMs`. Erro de um ciclo é logado e o laço continua. */
  start(): void {
    if (this.timer !== null || this.stopping) return;
    const tick = () => {
      this.ticking = this.tickOnce()
        .catch((error: unknown) => this.logger.error({ err: databaseErrorForLog(error) }, 'falha na limpeza fria das conversas'))
        .finally(() => {
          if (!this.stopping) this.timer = setTimeout(tick, this.config.pollMs);
        });
    };
    this.timer = setTimeout(tick, 0);
  }

  /** Para de procurar e espera o ciclo em andamento terminar. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.ticking;
  }

  /**
   * Trata agora as conversas frias: grava a limpeza das que têm resultado grande ainda sem limpeza (devolve quantas a receberam) e, DEPOIS dela, enfileira a compactação das que
   * continuam pesadas (`compactCold`; o efeito fica no banco e não entra no retorno). A falha de uma conversa é registrada (só identificadores e código padronizado do banco) e não
   * impede as demais nem muda nenhuma conversa.
   */
  async tickOnce(): Promise<number> {
    const candidates = await coldConversations(this.pool, this.now(), { onlyWithMaskable: true });
    let handled = 0;
    for (const candidate of candidates) {
      if (this.stopping || handled >= this.config.batch) break;
      try {
        if ((await maskColdResults(this.pool, { conversationId: candidate.id, now: this.now(), origin: 'sweep', logger: this.logger })) > 0) handled += 1;
      } catch (error) {
        this.logger.error({ conversationId: candidate.id, err: databaseErrorForLog(error) }, 'falha ao gravar a limpeza fria da conversa');
      }
    }
    await this.compactCold();
    return handled;
  }

  /**
   * Enfileira a compactação das conversas frias que `enqueueColdCompaction` aceitar, no máximo `batch` por ciclo. Roda DEPOIS do mascaramento do mesmo ciclo (decisão 18): a revisão que
   * o recibo guarda já inclui a limpeza, e a execução mede o pedido já enxuto. Cada conversa tem a falha isolada, como no mascaramento.
   * ponytail: cada ciclo reexamina toda conversa fria sem tentativa fria para a revisão atual (duas consultas baratas por conversa, mais as da revisão quando a última medição já estava
   * no gatilho frio ou acima), e o teto de `MAX_CANDIDATES` conversas por ciclo, em ordem de id, vale aqui também; guardar a última chamada já examinada por conversa se o número de conversas
   * frias passar a pesar no ciclo.
   */
  private async compactCold(): Promise<void> {
    let enqueued = 0;
    for (const candidate of await coldConversations(this.pool, this.now())) {
      if (this.stopping || enqueued >= this.config.batch) break;
      try {
        if (await enqueueColdCompaction(this.pool, { conversationId: candidate.id, now: this.now(), logger: this.logger })) enqueued += 1;
      } catch (error) {
        this.logger.error({ conversationId: candidate.id, err: databaseErrorForLog(error) }, 'falha ao enfileirar a compactação fria da conversa');
      }
    }
  }
}

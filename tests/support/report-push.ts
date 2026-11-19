// CLI `pnpm report:push`: relatório do funil do push (phase 16, passo 3; NOTIF-01), para separar, com números, onde o aviso se perde:
// no servidor (descartado, preso, recusado pelo FCM), no FCM, no aparelho (recebido, exibido, suprimido, tocado) ou no Android/Chrome
// (aceito pelo FCM e nunca recebido). Segue o padrão do `report:cost`: conecta no banco indicado por AION_REPORT_DATABASE_URL (pode vir de
// `.env.report.local`, fora do Git), abre uma transação SOMENTE LEITURA e imprime Markdown. Não chama o FCM e não grava nada.
//
// Só metadados: ids, tipo do evento, origem (`bot` ou `chat_geral`, sem nome), estado, motivo, status HTTP e instantes. Nenhum título, corpo,
// texto da conversa, token, nome de bot ou rótulo de aparelho é lido nem impresso (as colunas lidas são só estas, e docs/operacao.md recomenda um papel
// de banco com SELECT apenas nelas). O id do aparelho aparece pelos 8 primeiros caracteres, para ligar a entrega ao registro do aparelho.
//
// Arquivo organizado em: (1) tipos e leitura das três tabelas; (2) contas do funil, puras; (3) formatação em Markdown; (4) CLI.
//
// Argumentos (todos opcionais):
//   --days <n>     período até agora, em dias (padrão 7, de 1 a 3650), sobre `push_events.created_at`
//   --tz <fuso>    fuso IANA dos horários impressos (padrão America/Sao_Paulo)
//
// ponytail: lê o período inteiro em memória e lista só os 200 eventos mais recentes; o app tem um dono e poucos avisos por dia, trocar por agregação em SQL
// se o volume passar de dezenas de milhares de eventos no período.
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createPool, type Queryable } from '@aion/core';
import { PUSH_DROP_REASONS, PUSH_EVENT_KINDS, type PushEventKind } from '@aion/shared';

/** Erro de uso da CLI: a mensagem é segura para a saída (não carrega a URL do banco nem a causa externa). */
class UsageError extends Error {}

/** Um evento fica "preso" quando continua `pending` depois deste tempo: o despachante tenta a cada 2 s, e 4 tentativas a cada 30 s fecham em cerca de 2 minutos. */
export const STUCK_PENDING_MS = 10 * 60_000;
/** Quantos eventos a listagem por evento traz (os mais recentes). */
export const LISTING_LIMIT = 200;

// ---------------------------------------------------------------------------------------------
// (1) Leitura
// ---------------------------------------------------------------------------------------------

export interface EventRow { id: string; kind: PushEventKind; general: boolean; status: string; dropReason: string | null; attempts: number; createdAt: Date; finishedAt: Date | null }
export interface DeliveryRow { eventId: string; deviceId: string; attempt: number; httpStatus: number | null; outcome: string; createdAt: Date }
export interface ReceiptRow { eventId: string; deviceId: string; state: string; reason: string | null; createdAt: Date }
export interface PushFacts { events: EventRow[]; deliveries: DeliveryRow[]; receipts: ReceiptRow[] }

/** Lê os eventos criados no período e as entregas e os registros do aparelho deles. Só as colunas de metadados. */
export async function readPushFacts(db: Queryable, since: Date, until: Date): Promise<PushFacts> {
  const window = [since.toISOString(), until.toISOString()];
  const events = await db.query<{ id: string; kind: PushEventKind; general: boolean; status: string; drop_reason: string | null; attempts: number; created_at: Date; finished_at: Date | null }>(
    'SELECT id::text AS id, kind, (bot_id IS NULL) AS general, status, drop_reason, attempts, created_at, finished_at FROM push_events WHERE created_at >= $1 AND created_at < $2 ORDER BY id',
    window,
  );
  const deliveries = await db.query<{ event_id: string; device_id: string; attempt: number; http_status: number | null; outcome: string; created_at: Date }>(
    `SELECT d.event_id::text AS event_id, d.device_id::text AS device_id, d.attempt, d.http_status, d.outcome, d.created_at
       FROM push_deliveries d JOIN push_events e ON e.id = d.event_id WHERE e.created_at >= $1 AND e.created_at < $2 ORDER BY d.created_at, d.attempt`,
    window,
  );
  const receipts = await db.query<{ event_id: string; device_id: string; state: string; reason: string | null; created_at: Date }>(
    `SELECT r.event_id::text AS event_id, r.device_id::text AS device_id, r.state, r.reason, r.created_at
       FROM push_receipts r JOIN push_events e ON e.id = r.event_id WHERE e.created_at >= $1 AND e.created_at < $2 ORDER BY r.created_at`,
    window,
  );
  return {
    events: events.rows.map((r) => ({ id: r.id, kind: r.kind, general: r.general, status: r.status, dropReason: r.drop_reason, attempts: r.attempts, createdAt: r.created_at, finishedAt: r.finished_at })),
    deliveries: deliveries.rows.map((r) => ({ eventId: r.event_id, deviceId: r.device_id, attempt: r.attempt, httpStatus: r.http_status, outcome: r.outcome, createdAt: r.created_at })),
    receipts: receipts.rows.map((r) => ({ eventId: r.event_id, deviceId: r.device_id, state: r.state, reason: r.reason, createdAt: r.created_at })),
  };
}

// ---------------------------------------------------------------------------------------------
// (2) Contas do funil
// ---------------------------------------------------------------------------------------------

/** Mediana e p95 (posto mais próximo) de segundos; `null` sem amostra. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 === 1 ? sorted[Math.floor(mid)]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
export function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1]!;
}

/** Contagens de um grupo de eventos (um tipo ou o total). Eventos, e não linhas: um evento com vários aparelhos conta uma vez em cada coluna do aparelho. */
export interface FunnelRow {
  created: number; dropped: number; sent: number; pending: number; stuck: number;
  deliveries: number; accepted: number; rejected: number; failed: number;
  acceptedEvents: number; received: number; shown: number; shownTimeout: number; suppressedInvalid: number; suppressedOwner: number; clicked: number; acceptedNotReceived: number;
  serverSeconds: number[]; receivedSeconds: number[];
}

const emptyRow = (): FunnelRow => ({
  created: 0, dropped: 0, sent: 0, pending: 0, stuck: 0, deliveries: 0, accepted: 0, rejected: 0, failed: 0,
  acceptedEvents: 0, received: 0, shown: 0, shownTimeout: 0, suppressedInvalid: 0, suppressedOwner: 0, clicked: 0, acceptedNotReceived: 0, serverSeconds: [], receivedSeconds: [],
});

export interface PushReport {
  byKind: Record<PushEventKind, FunnelRow>;
  total: FunnelRow;
  /** Descartes por motivo e tipo; `sem motivo` junta os descartados antes da migration 0053 que não tinham código. */
  drops: Map<string, Record<PushEventKind, number>>;
  http: Map<string, number>;
}

/** Junta as três tabelas no funil. Pura: o relógio entra por `now` (para o "preso"). */
export function buildPushReport({ events, deliveries, receipts }: PushFacts, now: Date): PushReport {
  const byKind = Object.fromEntries(PUSH_EVENT_KINDS.map((kind) => [kind, emptyRow()])) as Record<PushEventKind, FunnelRow>;
  const drops = new Map<string, Record<PushEventKind, number>>();
  const http = new Map<string, number>();
  const deliveriesOf = groupBy(deliveries, (d) => d.eventId);
  const receiptsOf = groupBy(receipts, (r) => r.eventId);

  for (const event of events) {
    const row = byKind[event.kind];
    row.created += 1;
    if (event.status === 'dropped') {
      row.dropped += 1;
      const reason = event.dropReason ?? 'sem motivo';
      const counts = drops.get(reason) ?? (Object.fromEntries(PUSH_EVENT_KINDS.map((k) => [k, 0])) as Record<PushEventKind, number>);
      counts[event.kind] += 1;
      drops.set(reason, counts);
    } else if (event.status === 'sent') {
      row.sent += 1;
      if (event.finishedAt) row.serverSeconds.push((event.finishedAt.getTime() - event.createdAt.getTime()) / 1000);
    } else {
      row.pending += 1;
      if (now.getTime() - event.createdAt.getTime() > STUCK_PENDING_MS) row.stuck += 1;
    }

    const mine = deliveriesOf.get(event.id) ?? [];
    for (const delivery of mine) {
      row.deliveries += 1;
      if (delivery.outcome === 'accepted') row.accepted += 1;
      else if (delivery.outcome === 'rejected_token') row.rejected += 1;
      else row.failed += 1;
      const status = delivery.httpStatus === null ? 'sem resposta' : String(delivery.httpStatus);
      http.set(status, (http.get(status) ?? 0) + 1);
    }

    const seen = receiptsOf.get(event.id) ?? [];
    const has = (state: string, reason?: string) => seen.some((r) => r.state === state && (reason === undefined || r.reason === reason));
    const wasAccepted = mine.some((d) => d.outcome === 'accepted');
    if (wasAccepted) row.acceptedEvents += 1;
    if (has('received')) {
      row.received += 1;
      const first = Math.min(...seen.filter((r) => r.state === 'received').map((r) => r.createdAt.getTime()));
      row.receivedSeconds.push((first - event.createdAt.getTime()) / 1000);
    } else if (wasAccepted) row.acceptedNotReceived += 1;
    if (has('shown')) row.shown += 1;
    if (has('shown', 'check_timeout')) row.shownTimeout += 1;
    if (has('suppressed', 'invalid')) row.suppressedInvalid += 1;
    if (has('suppressed', 'owner_looking')) row.suppressedOwner += 1;
    if (has('clicked')) row.clicked += 1;
  }

  const total = emptyRow();
  for (const row of Object.values(byKind)) {
    for (const key of Object.keys(total) as (keyof FunnelRow)[]) {
      if (key === 'serverSeconds' || key === 'receivedSeconds') total[key].push(...row[key]);
      else (total[key] as number) += row[key] as number;
    }
  }
  return { byKind, total, drops, http };
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return map;
}

// ---------------------------------------------------------------------------------------------
// (3) Formatação em Markdown
// ---------------------------------------------------------------------------------------------

const table = (header: string[], rows: (string | number)[][]): string =>
  [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n');
const seconds = (value: number | null): string => (value === null ? '-' : value.toFixed(1));

/** Instante no fuso pedido, `AAAA-MM-DD HH:MM:SS`. */
function stamp(date: Date, timeZone: string): string {
  return date.toLocaleString('sv-SE', { timeZone, hour12: false });
}
/** Mesmo instante sem o ano, para os registros do aparelho na listagem. */
const shortStamp = (date: Date, timeZone: string): string => stamp(date, timeZone).slice(5);

/** Linhas do funil por tipo e total, com `cells` escolhendo as colunas. */
function perKind(report: PushReport, cells: (row: FunnelRow) => (string | number)[]): (string | number)[][] {
  return [...PUSH_EVENT_KINDS.map((kind) => [kind, ...cells(report.byKind[kind])]), ['Total', ...cells(report.total)]];
}

/** Monta o relatório inteiro. `facts` entra só para a listagem por evento (as contas já estão em `report`). */
export function formatPushReport(report: PushReport, facts: PushFacts, { since, until, timeZone }: { since: Date; until: Date; timeZone: string }): string {
  const out: string[] = [];
  out.push('# Funil de push', '');
  out.push(`Período: ${stamp(since, timeZone)} a ${stamp(until, timeZone)} (${timeZone}), sobre a criação do evento. Só metadados: ids, tipos, estados, motivos e horários; nenhum título, texto, token, nome de bot nem rótulo de aparelho.`, '');
  out.push(`Eventos criados: ${report.total.created}`, '');

  out.push('## Eventos no servidor', '');
  out.push(table(['Tipo', 'Criados', 'Descartados', 'Enviados', 'Pendentes', 'Pendentes presos'], perKind(report, (r) => [r.created, r.dropped, r.sent, r.pending, r.stuck])));
  out.push('', `Enviado quer dizer que o FCM respondeu a cada aparelho alvo (aceitou ou recusou o token). Preso é pendente há mais de ${STUCK_PENDING_MS / 60_000} minutos.`, '');

  out.push('## Descartes por motivo', '');
  const reasons = [...PUSH_DROP_REASONS, 'sem motivo'].filter((reason) => report.drops.has(reason));
  out.push(reasons.length === 0
    ? 'Nenhum descarte no período.'
    : table(['Motivo', ...PUSH_EVENT_KINDS, 'Total'], reasons.map((reason) => {
      const counts = report.drops.get(reason)!;
      return [reason, ...PUSH_EVENT_KINDS.map((kind) => counts[kind]), PUSH_EVENT_KINDS.reduce((sum, kind) => sum + counts[kind], 0)];
    })));
  out.push('');

  out.push('## Entregas ao FCM (uma por tentativa e aparelho)', '');
  out.push(table(['Tipo', 'Entregas', 'Aceitas', 'Recusadas (token)', 'Falhas'], perKind(report, (r) => [r.deliveries, r.accepted, r.rejected, r.failed])));
  out.push('');
  out.push(report.http.size === 0
    ? 'Nenhuma entrega no período.'
    : table(['HTTP', 'Entregas'], [...report.http.entries()].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })).map(([status, count]) => [status, count])));
  out.push('');

  out.push('## O que o aparelho registrou (eventos, não aparelhos)', '');
  out.push(table(
    ['Tipo', 'Aceitos pelo FCM', 'Recebidos', 'Exibidos', 'Exibidos com check_timeout', 'Suprimidos (invalid)', 'Suprimidos (owner_looking)', 'Tocados', 'Aceitos sem recebido'],
    perKind(report, (r) => [r.acceptedEvents, r.received, r.shown, r.shownTimeout, r.suppressedInvalid, r.suppressedOwner, r.clicked, r.acceptedNotReceived]),
  ));
  out.push('', '"Aceitos sem recebido" é o aviso que o FCM aceitou e o service worker nunca registrou: o candidato a limite do Android ou do Chrome. Inclui o aviso recente ou de aparelho desligado, que ainda pode chegar (o FCM guarda por até 24 horas). "Exibidos com check_timeout" já está em "Exibidos".', '');

  out.push('## Latências (segundos)', '');
  out.push(table(
    ['Tipo', 'Enviados', 'Criação até fim no servidor (mediana)', '(p95)', 'Recebidos', 'Criação até recebido (mediana)', '(p95)'],
    perKind(report, (r) => [r.serverSeconds.length, seconds(median(r.serverSeconds)), seconds(p95(r.serverSeconds)), r.receivedSeconds.length, seconds(median(r.receivedSeconds)), seconds(p95(r.receivedSeconds))]),
  ));
  out.push('');

  out.push(`## Eventos (os ${LISTING_LIMIT} mais recentes)`, '');
  out.push('Origem: `bot` ou `chat_geral`. Entregas: aparelho (8 primeiros do id), tentativa e resultado/HTTP. Aparelho: o que o service worker registrou, com o horário.', '');
  const deliveriesOf = groupBy(facts.deliveries, (d) => d.eventId);
  const receiptsOf = groupBy(facts.receipts, (r) => r.eventId);
  const recent = [...facts.events].reverse().slice(0, LISTING_LIMIT);
  const rows = recent.map((event) => {
    const state = event.status === 'dropped' ? `dropped:${event.dropReason ?? 'sem motivo'}` : event.status;
    const sent = (deliveriesOf.get(event.id) ?? []).map((d) => `${d.deviceId.slice(0, 8)} #${d.attempt} ${d.outcome}/${d.httpStatus ?? '-'}`).join('; ');
    const byDevice = groupBy(receiptsOf.get(event.id) ?? [], (r) => r.deviceId);
    const seen = [...byDevice.entries()].map(([device, list]) => `${device.slice(0, 8)}: ${list.map((r) => `${r.state}${r.reason ? `(${r.reason})` : ''} ${shortStamp(r.createdAt, timeZone)}`).join('; ')}`).join(' / ');
    return [event.id, event.kind, event.general ? 'chat_geral' : 'bot', stamp(event.createdAt, timeZone), event.finishedAt ? stamp(event.finishedAt, timeZone) : '-', state, event.attempts, sent || '-', seen || '-'];
  });
  out.push(rows.length === 0 ? 'Nenhum evento no período.' : table(['Id', 'Tipo', 'Origem', 'Criado', 'Fim no servidor', 'Estado', 'Tentativas', 'Entregas', 'Aparelho'], rows));
  if (facts.events.length > LISTING_LIMIT) out.push('', `Há ${facts.events.length - LISTING_LIMIT} eventos mais antigos fora da listagem; as contas acima os incluem.`);
  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// (4) CLI
// ---------------------------------------------------------------------------------------------

/** Lê e valida os argumentos na borda: allowlist de opções, faixa de dias e fuso IANA. */
function parseOptions(argv: string[]): { days: number; timeZone: string } {
  const { values } = parseArgs({ args: argv, strict: true, options: { days: { type: 'string' }, tz: { type: 'string' } } });
  const days = values.days === undefined ? 7 : Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new UsageError('--days precisa ser um inteiro entre 1 e 3650.');
  const timeZone = values.tz ?? 'America/Sao_Paulo';
  try { new Intl.DateTimeFormat('en', { timeZone }); } catch { throw new UsageError('--tz precisa ser um fuso IANA válido.'); }
  return { days, timeZone };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const url = process.env.AION_REPORT_DATABASE_URL?.trim();
  if (!url) throw new UsageError('AION_REPORT_DATABASE_URL ausente (ambiente ou .env.report.local).');
  const until = new Date();
  const since = new Date(until.getTime() - options.days * 86_400_000);
  const pool = createPool(url, { applicationName: 'aion-report-push', max: 1 });
  const client = await pool.connect();
  try {
    // Somente leitura garantida pelo banco, não só pela intenção do script.
    await client.query('BEGIN TRANSACTION READ ONLY');
    const facts = await readPushFacts(client, since, until);
    await client.query('COMMIT');
    process.stdout.write(formatPushReport(buildPushReport(facts, until), facts, { since, until, timeZone: options.timeZone }));
  } finally {
    client.release();
    await pool.end();
  }
}

// Só roda como CLI; importar o módulo (para teste) não conecta em banco algum.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Envelope de erro da CLI, com código estável e mensagem segura; detalhes do banco nunca atravessam esta borda.
  main().catch((error: unknown) => {
    const message = error instanceof UsageError ? error.message : 'Não foi possível ler o funil do push. Confira AION_REPORT_DATABASE_URL e o acesso ao banco.';
    process.stderr.write(JSON.stringify({ code: 'PUSH_REPORT_FAILED', message, exitCode: 1 }) + '\n');
    process.exitCode = 1;
  });
}

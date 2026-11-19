// Regras do Google Calendar para a limpeza dos resultados de conector (CTX-12, phase 12, T4). Reconhece as ações pelo prefixo `GOOGLECALENDAR_` do slug.
//
// O que pesa num resultado do Calendar e o modelo não usa: o envelope de sincronização (`kind`, `etag`, `nextSyncToken`, `accessRole`, `defaultReminders`), a
// identidade interna de cada evento (`etag`, `iCalUID`, `sequence`, `created`, `updated`), o lembrete padrão, o tipo padrão do evento, as marcas `self` e `optional`
// falsas e o criador e o organizador que já aparecem como participantes. O que o modelo precisa fica: o `id` do evento (é com ele que se edita e se exclui), título,
// início, fim, status, descrição, local, participantes (nome, e-mail, resposta e se é o organizador), anexos, conferência e TODAS as URLs (`htmlLink`, `hangoutLink`,
// `conferenceData.entryPoints[].uri`, `fileUrl` e os links da descrição): URL nunca é tocada, e quem escreve o texto final é a camada genérica (`generic.ts`).
//
// Duas ações têm regra própria, ambas só sobre o JSON (função pura do slug e do JSON, sem relógio, rede nem estado):
//   - `GOOGLECALENDAR_EVENTS_LIST`: `cleanEventList`, o ruído da lista e de cada evento.
//   - `GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS`: a mesma limpeza nos eventos completos (`events`) e `groupByCalendar`, que junta o resumo (`summary_view`, uma linha por
//     evento com o id do calendário repetido em todas) com a lista de calendários consultados (`calendars_queried`): cada calendário aparece uma vez, com os eventos dele.
// Qualquer outra ação `GOOGLECALENDAR_` sem regra própria passa só pela camada genérica (o `shape` devolve o JSON como veio).
//
// Ponto de extensão: uma ação nova com regra própria entra em `ACTION_RULES`. Nada aqui lança nem cresce o resultado: formato inesperado devolve o JSON como veio.
import { isPlainObject } from './generic';
import type { ConnectorShaper } from './types';

/** Chaves de envelope da lista de eventos (raiz) sem uso para o modelo; `kind` é tratado à parte (`isKindTag`). */
const ROOT_NOISE_KEYS: ReadonlySet<string> = new Set(['etag', 'accessRole', 'defaultReminders', 'nextSyncToken', 'updated']);

/** Chaves de controle de cada evento sem uso para o modelo (identidade para sincronização e datas de criação e edição); `kind` é tratado à parte. */
const EVENT_NOISE_KEYS: ReadonlySet<string> = new Set(['etag', 'iCalUID', 'sequence', 'created', 'updated']);

/** `kind` só é ruído quando é a etiqueta de tipo do Google (`calendar#event`, `calendar#events`); outro valor com esse nome seria dado e fica. */
const isKindTag = (key: string, value: unknown): boolean => key === 'kind' && typeof value === 'string' && value.startsWith('calendar#');

/** Remove as marcas `self` e `optional` quando falsas (o padrão); verdadeiras ficam, porque dizem algo (o participante é o dono da agenda, a presença é opcional). */
function dropFalseFlags(person: unknown): unknown {
  if (!isPlainObject(person)) return person;
  return Object.fromEntries(Object.entries(person).filter(([key, value]) => !((key === 'self' || key === 'optional') && value === false)));
}

/** O criador ou organizador é um dos participantes do evento (mesmo e-mail, sem diferenciar caixa)? Então a lista de participantes já o representa. */
function isRepresentedAmongAttendees(person: unknown, attendeeEmails: ReadonlySet<string>): boolean {
  return isPlainObject(person) && typeof person.email === 'string' && attendeeEmails.has(person.email.trim().toLowerCase());
}

/**
 * Um evento sem o ruído de sincronização, sem o lembrete e o tipo padrão e sem criador e organizador já representados nos participantes; as marcas `self` e `optional`
 * falsas saem dos participantes e de quem ficou. Sem `attendees` (evento pessoal) o criador e o organizador ficam, porque nenhum participante os representa. Nunca
 * altera o objeto recebido. O que não é objeto volta como veio.
 */
function cleanEvent(event: unknown): unknown {
  if (!isPlainObject(event)) return event;
  const attendeeEmails = new Set(
    (Array.isArray(event.attendees) ? event.attendees : []).flatMap((attendee: unknown) => (isPlainObject(attendee) && typeof attendee.email === 'string' ? [attendee.email.trim().toLowerCase()] : [])),
  );
  const entries = Object.entries(event).flatMap(([key, value]): [string, unknown][] => {
    if (EVENT_NOISE_KEYS.has(key) || isKindTag(key, value)) return [];
    if (key === 'reminders' && isPlainObject(value) && value.useDefault === true) return [];
    if (key === 'eventType' && value === 'default') return [];
    if (key === 'creator' || key === 'organizer') return isRepresentedAmongAttendees(value, attendeeEmails) ? [] : [[key, dropFalseFlags(value)]];
    if (key === 'attendees' && Array.isArray(value)) return [[key, value.map(dropFalseFlags)]];
    return [[key, value]];
  });
  return Object.fromEntries(entries);
}

/**
 * A resposta de uma listagem de eventos sem o ruído do envelope e de cada evento. Os eventos ficam em `items` (`EVENTS_LIST`) ou em `events` (a versão completa de
 * `EVENTS_LIST_ALL_CALENDARS`); a resposta pode também ser a própria lista de eventos. Qualquer outro campo (próxima página, fuso, nome da agenda) fica.
 */
function cleanEventList(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(cleanEvent);
  if (!isPlainObject(data)) return data;
  const entries = Object.entries(data).flatMap(([key, value]): [string, unknown][] => {
    if (ROOT_NOISE_KEYS.has(key) || isKindTag(key, value)) return [];
    if ((key === 'items' || key === 'events') && Array.isArray(value)) return [[key, value.map(cleanEvent)]];
    return [[key, value]];
  });
  return Object.fromEntries(entries);
}

/** Linha do resumo de `EVENTS_LIST_ALL_CALENDARS` (`summary_view`): um objeto que diz de qual calendário o evento é, no campo `calendar`. */
const isSummaryRow = (row: unknown): row is Record<string, unknown> & { calendar: string } => isPlainObject(row) && typeof row.calendar === 'string' && row.calendar !== '';

/** Calendário consultado (`calendars_queried`): um objeto com `id` em texto e sem o campo que o agrupamento acrescenta. */
const isCalendarRef = (ref: unknown): ref is Record<string, unknown> & { id: string } => isPlainObject(ref) && typeof ref.id === 'string' && ref.id !== '' && !('summary_view' in ref);

/**
 * Junta `calendars_queried` e `summary_view` em `calendars`: cada calendário uma vez (`id`, `summary`) e, dentro dele, as linhas do resumo sem o campo `calendar`,
 * que repetia o id longo do calendário em toda linha. Calendários sem evento ficam na lista, sem `summary_view`, para o modelo saber que foram consultados. A lista
 * segue a ordem de `calendars_queried`; calendário que só aparece nas linhas entra no fim, com o `id` dele.
 * Formato diferente do esperado (linha sem `calendar` em texto, calendário sem `id`, id repetido, `calendars` já existente) ou resultado que não fica menor devolve o
 * JSON como veio: nada se perde nem cresce. Mede o tamanho do JSON compacto, uma aproximação do texto final que a camada genérica escreve.
 */
function groupByCalendar(data: unknown): unknown {
  if (!isPlainObject(data) || 'calendars' in data) return data;
  const rows = data.summary_view;
  if (!Array.isArray(rows) || rows.length === 0 || !rows.every(isSummaryRow)) return data;
  const queried = data.calendars_queried;
  if (queried !== undefined && !(Array.isArray(queried) && queried.every(isCalendarRef))) return data;
  const groups = new Map<string, { head: Record<string, unknown>; rows: unknown[] }>();
  for (const ref of queried ?? []) {
    if (groups.has(ref.id)) return data;
    groups.set(ref.id, { head: ref, rows: [] });
  }
  for (const row of rows) {
    const { calendar, ...rest } = row;
    let group = groups.get(calendar);
    if (group === undefined) {
      group = { head: { id: calendar }, rows: [] };
      groups.set(calendar, group);
    }
    group.rows.push(rest);
  }
  const calendars = [...groups.values()].map(({ head, rows: events }) => (events.length > 0 ? { ...head, summary_view: events } : head));
  const entries: [string, unknown][] = [];
  let placed = false;
  for (const [key, value] of Object.entries(data)) {
    if (key === 'calendars_queried' || key === 'summary_view') {
      if (!placed) entries.push(['calendars', calendars]);
      placed = true;
      continue;
    }
    entries.push([key, value]);
  }
  const grouped = Object.fromEntries(entries);
  return JSON.stringify(grouped).length < JSON.stringify(data).length ? grouped : data;
}

/** Regras por ação do Google Calendar (slug em maiúsculas); ação ausente daqui não tem regra própria e passa só pela camada genérica. */
const ACTION_RULES: ReadonlyMap<string, (data: unknown) => unknown> = new Map([
  ['GOOGLECALENDAR_EVENTS_LIST', cleanEventList],
  ['GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS', (data: unknown) => groupByCalendar(cleanEventList(data))],
]);

/** O Google Calendar no índice: reconhece as ações pelo prefixo `GOOGLECALENDAR_`; regra que falha devolve o JSON como veio (nunca lança, sem depender do índice). */
export const googleCalendarShaper: ConnectorShaper = {
  connector: 'google-calendar',
  actionPrefixes: ['GOOGLECALENDAR_'],
  shape(actionSlug, data) {
    const rule = ACTION_RULES.get(actionSlug);
    if (rule === undefined) return data;
    try {
      return rule(data);
    } catch {
      return data;
    }
  },
};

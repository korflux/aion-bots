// Regras do Gmail para a limpeza dos resultados de conector (CTX-12, phase 11, T4). Reconhece as ações pelo prefixo `GMAIL_` do slug.
//
// O que pesa num resultado do Gmail e o modelo não usa: a lista inteira de cabeçalhos do protocolo (Received, DKIM, ARC...), o corpo da mensagem repetido em
// base64 dentro de `payload` (o texto já vem pronto em `messageText`), a estrutura MIME e o assunto repetido (no `subject` de topo e em `preview.subject`, além
// do cabeçalho Subject). O que o modelo precisa fica: remetente, destinatários, assunto (uma vez só), data, o texto da mensagem, os rótulos e os dados para
// baixar anexos.
//
// Duas camadas, ambas sobre o JSON (quem escreve o texto final é `generic.ts`):
//   1. `slimMessage`, por ação (`ACTION_RULES`): o que depende de saber onde está a mensagem e do tipo de resultado (listagem ou mensagem completa).
//   2. `stripDeep`, em toda ação `GMAIL_`: só os cabeçalhos da lista `KEPT_HEADERS` e nenhum `body.data` em qualquer profundidade (blob base64 do corpo).
//
// Ações com regra (phase 15, passo 8b): `GMAIL_FETCH_EMAILS`, `GMAIL_LIST_MESSAGES` (a mesma regra de mensagens, em listagem), `GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID` (mensagem
// completa) e `GMAIL_BATCH_MODIFY_MESSAGES` (lista longa de ids devolvida resumida em contagem).
//
// Dois cortes da phase 15 sobre a mensagem, ambos só no que vai ao modelo (o original segue íntegro em `read_activity part=original`):
//   - `messageText` tem teto por mensagem (`MESSAGE_TEXT_LIMIT`): newsletter e cadeia de respostas passam de 6 mil caracteres e eram quase todo o peso do resultado. O corte
//     é numa palavra inteira e o aviso diz quanto foi mostrado, de quanto, e onde ler o resto.
//   - `to` de topo e `messageTimestamp` saem quando repetem o cabeçalho To e o cabeçalho Date, que a camada 2 mantém; sem o cabeçalho, o campo de topo é a única fonte e fica.
//
// Ponto de extensão: uma nova ação do Gmail com regra própria entra em `ACTION_RULES`; as demais já passam pela camada 2.
import { MAX_DEPTH, cleanString, isPlainObject } from './generic';
import type { ConnectorShaper } from './types';

/** Cabeçalhos mantidos (spec, decisão 11), pelo nome em minúsculas; o valor é o nome como o modelo o lê. Todos os outros saem. */
const KEPT_HEADERS: ReadonlyMap<string, string> = new Map(['From', 'To', 'Cc', 'Subject', 'Date', 'Reply-To'].map((name) => [name.toLowerCase(), name]));

/**
 * Teto de `messageText` por mensagem, em caracteres. 2.000 cobre o assunto real de quase todo e-mail pessoal ou de trabalho (o que o bot decide a partir da listagem); o que passa
 * disso é rodapé, histórico citado e oferta de newsletter. Quem precisa do texto inteiro lê `read_activity part=original`.
 * ponytail: limite fixo para toda ação de mensagem do Gmail, sem parâmetro por chamada; revisar se o bot passar a pedir o original com frequência para decidir sobre o e-mail.
 */
export const MESSAGE_TEXT_LIMIT = 2_000;

/** Quanto do fim do limite o corte pode recuar para terminar numa palavra inteira; sem espaço nessa faixa (um link ou um bloco sem quebra), o corte é seco. */
const WORD_BOUNDARY_WINDOW = 0.2;

/** Ids de mensagem devolvidos em lista: abaixo disto a lista fica como veio (a resposta já é curta). */
const ID_LIST_MIN = 6;

/** Chaves, em minúsculas, das listas de ids que o lote devolve de volta. */
const ID_LIST_KEYS: ReadonlySet<string> = new Set(['ids', 'messageids', 'message_ids']);

/** Profundidade máxima da árvore MIME (partes dentro de partes); mensagens reais ficam em 3 ou 4 níveis. */
const MAX_PART_DEPTH = 10;

interface AttachmentPart {
  filename: string;
  mimeType?: string;
  attachmentId: string;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Camada 2: cabeçalhos e blobs, em qualquer ação do Gmail
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** Lista de cabeçalhos do protocolo: todos os itens são `{ name, value }`. */
const isHeaderList = (list: readonly unknown[]): boolean => list.length > 0 && list.every((item) => isPlainObject(item) && typeof item.name === 'string' && 'value' in item);

/** Só os cabeçalhos mantidos, como `{ From: ..., Subject: ... }`; repetido vale o primeiro. */
function keepHeaders(list: readonly unknown[]): Record<string, string> {
  const kept = new Map<string, string>();
  for (const item of list) {
    if (!isPlainObject(item) || typeof item.name !== 'string' || typeof item.value !== 'string') continue;
    const name = KEPT_HEADERS.get(item.name.trim().toLowerCase());
    if (name !== undefined && !kept.has(name)) kept.set(name, item.value);
  }
  return Object.fromEntries(kept);
}

/** `body` de uma parte MIME sem `data` (o blob base64 do corpo) e sem o `size` que só descrevia o blob; o `attachmentId` fica, é com ele que se baixa o anexo. */
function stripBody(body: Record<string, unknown>, depth: number): unknown {
  const { data: _data, size: _size, ...rest } = body;
  return stripDeep(rest, depth);
}

/** Aplica a camada 2 em todo o valor: listas de cabeçalhos e `body.data` em qualquer profundidade. */
function stripDeep(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) return isHeaderList(value) ? keepHeaders(value) : value.map((item) => stripDeep(item, depth + 1));
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'body' && isPlainObject(item) ? stripBody(item, depth + 1) : stripDeep(item, depth + 1)]));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Camada 1: a mensagem
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** Valor do primeiro cabeçalho com esse nome (minúsculo) numa lista bruta de cabeçalhos. */
function headerValue(headers: unknown, name: string): string | undefined {
  if (!Array.isArray(headers)) return undefined;
  for (const item of headers) {
    if (isPlainObject(item) && typeof item.name === 'string' && typeof item.value === 'string' && item.name.trim().toLowerCase() === name) return item.value;
  }
  return undefined;
}

/** Os anexos da árvore MIME (parte com nome de arquivo e `attachmentId`), em lista plana: o que o bot precisa para pedir o anexo depois. */
function attachmentParts(node: unknown, depth = 0): AttachmentPart[] {
  if (!isPlainObject(node) || depth > MAX_PART_DEPTH) return [];
  const found: AttachmentPart[] = [];
  const body = isPlainObject(node.body) ? node.body : undefined;
  if (typeof node.filename === 'string' && node.filename !== '' && typeof body?.attachmentId === 'string') {
    found.push({ filename: node.filename, ...(typeof node.mimeType === 'string' ? { mimeType: node.mimeType } : {}), attachmentId: body.attachmentId });
  }
  if (Array.isArray(node.parts)) for (const part of node.parts) found.push(...attachmentParts(part, depth + 1));
  return found;
}

/** Texto da primeira parte MIME do tipo pedido, decodificado do base64 do corpo; `undefined` sem essa parte. Só decodifica texto, nada é executado. */
function decodedBodyText(node: unknown, mimeType: string, depth = 0): string | undefined {
  if (!isPlainObject(node) || depth > MAX_PART_DEPTH) return undefined;
  const body = node.body;
  if (node.mimeType === mimeType && isPlainObject(body) && typeof body.data === 'string' && body.data !== '') return Buffer.from(body.data, 'base64url').toString('utf8');
  if (Array.isArray(node.parts)) {
    for (const part of node.parts) {
      const text = decodedBodyText(part, mimeType, depth + 1);
      if (text !== undefined) return text;
    }
  }
  return undefined;
}

/**
 * `messageText` dentro do teto. Texto maior é limpo antes do corte (HTML vira texto, para não partir uma tag ao meio), cortado numa palavra inteira (nunca no meio de um par
 * substituto) e termina com o aviso do tamanho. Texto dentro do teto volta como veio.
 */
function limitMessageText(text: string): string {
  if (text.length <= MESSAGE_TEXT_LIMIT) return text;
  const clean = cleanString(text);
  if (clean.length <= MESSAGE_TEXT_LIMIT) return clean;
  let end = MESSAGE_TEXT_LIMIT;
  const last = clean.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  if (!/\s/.test(clean.charAt(end))) {
    const head = clean.slice(0, end);
    const boundary = Math.max(head.lastIndexOf(' '), head.lastIndexOf('\n'), head.lastIndexOf('\t'));
    if (boundary >= Math.floor(MESSAGE_TEXT_LIMIT * (1 - WORD_BOUNDARY_WINDOW))) end = boundary;
  }
  const shown = clean.slice(0, end).trimEnd();
  const thousands = (value: number): string => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${shown}\n[texto cortado: mostrando ${thousands(shown.length)} de ${thousands(clean.length)} caracteres; o texto completo está no resultado original (read_activity part=original)]`;
}

/** `payload` sem a estrutura MIME: só os cabeçalhos (a camada 2 os filtra) e, quando pedido, os anexos. */
function slimPayload(payload: Record<string, unknown>, keepAttachments: boolean): Record<string, unknown> {
  const attachments = keepAttachments ? attachmentParts(payload) : [];
  return { headers: payload.headers, ...(attachments.length > 0 ? { attachments } : {}) };
}

/**
 * Uma mensagem sem a estrutura MIME e sem repetição de assunto e de prévia: o campo `subject` de topo sai quando é igual ao cabeçalho Subject (que a camada 2 mantém,
 * então o assunto aparece uma vez só; sem cabeçalho Subject o campo fica, nunca se perde o assunto); `preview.subject` sai quando é igual ao `subject` da mensagem
 * ou ao cabeçalho, e `preview.body` quando já está dentro de `messageText`. `sender` fica (o modelo o lê sem abrir os cabeçalhos); `to` e `messageTimestamp` saem quando repetem os
 * cabeçalhos To e Date (sem o cabeçalho, ficam), e `messageText` respeita `MESSAGE_TEXT_LIMIT`. Se o resultado não traz
 * `messageText`, o texto do corpo é lido do base64 antes de ele ser descartado, para o texto da mensagem nunca se perder. `keepAttachments`: a mensagem completa mantém
 * os dados dos anexos; a listagem não (o `attachmentList` da própria mensagem já os traz).
 */
function slimMessage(message: unknown, keepAttachments: boolean): unknown {
  if (!isPlainObject(message)) return message;
  const payload = message.payload;
  const headerSubject = headerValue(isPlainObject(payload) ? payload.headers : undefined, 'subject')?.trim();
  const topSubject = typeof message.subject === 'string' ? message.subject.trim() : undefined;
  const subjects = [topSubject, headerSubject].filter((subject): subject is string => subject !== undefined);
  const topSubjectRepeatsHeader = topSubject !== undefined && topSubject === headerSubject;
  const messageText = typeof message.messageText === 'string' ? limitMessageText(message.messageText) : '';
  const headers = isPlainObject(payload) ? payload.headers : undefined;
  const headerTo = headerValue(headers, 'to')?.trim();
  const toRepeatsHeader = headerTo !== undefined && typeof message.to === 'string' && message.to.trim() === headerTo;
  const dateRepeatsHeader = (headerValue(headers, 'date')?.trim() ?? '') !== '';
  const entries = Object.entries(message).flatMap(([key, value]): [string, unknown][] => {
    if (key === 'subject' && topSubjectRepeatsHeader) return [];
    if (key === 'to' && toRepeatsHeader) return [];
    if (key === 'messageTimestamp' && dateRepeatsHeader) return [];
    if (key === 'messageText' && typeof value === 'string') return [[key, messageText]];
    if (key === 'preview' && isPlainObject(value)) {
      const { subject, body, ...rest } = value;
      const duplicatedSubject = typeof subject === 'string' && subjects.includes(subject.trim());
      const duplicatedBody = typeof body === 'string' && messageText.includes(body.trim());
      return [[key, { ...rest, ...(duplicatedSubject ? {} : { subject }), ...(duplicatedBody ? {} : { body }) }]];
    }
    if (key === 'payload' && isPlainObject(value)) return [[key, slimPayload(value, keepAttachments)]];
    return [[key, value]];
  });
  if (messageText.trim() === '' && isPlainObject(payload)) {
    // O HTML cai na camada genérica, que o converte em texto.
    const decoded = decodedBodyText(payload, 'text/plain') ?? decodedBodyText(payload, 'text/html');
    if (decoded !== undefined) entries.push(['messageText', limitMessageText(decoded)]);
  }
  return Object.fromEntries(entries);
}

/** Onde estão as mensagens no resultado: lista na raiz, `messages`, `message` ou a própria raiz. */
function mapMessages(data: unknown, slim: (message: unknown) => unknown): unknown {
  if (Array.isArray(data)) return data.map(slim);
  if (!isPlainObject(data)) return data;
  if (Array.isArray(data.messages)) return { ...data, messages: data.messages.map(slim) };
  if (isPlainObject(data.message)) return { ...data, message: slim(data.message) };
  return slim(data);
}

/**
 * `GMAIL_BATCH_MODIFY_MESSAGES`: a resposta devolve a lista de ids que o bot acabou de pedir (de 16 a dezenas por chamada) e o que importa é o resultado: rótulos, contagem,
 * status e falhas. Lista de ids com 6 ou mais itens (`ID_LIST_MIN`), toda de texto, vira só a contagem com o caminho do original; lista curta, de objetos (falhas por id) ou
 * qualquer outro campo fica como veio.
 */
function slimBatchModify(data: unknown): unknown {
  if (!isPlainObject(data)) return data;
  return Object.fromEntries(
    Object.entries(data).map(([key, value]): [string, unknown] =>
      ID_LIST_KEYS.has(key.toLowerCase()) && Array.isArray(value) && value.length >= ID_LIST_MIN && value.every((item) => typeof item === 'string')
        ? [key, `[${value.length} ids omitidos; a lista está no resultado original (read_activity part=original)]`]
        : [key, value],
    ),
  );
}

/** Regras por ação do Gmail (slug em maiúsculas): a listagem não leva anexos de MIME (vêm em `attachmentList`); a mensagem completa os mantém. */
const ACTION_RULES: ReadonlyMap<string, (data: unknown) => unknown> = new Map([
  ['GMAIL_FETCH_EMAILS', (data: unknown) => mapMessages(data, (message) => slimMessage(message, false))],
  ['GMAIL_LIST_MESSAGES', (data: unknown) => mapMessages(data, (message) => slimMessage(message, false))],
  ['GMAIL_BATCH_MODIFY_MESSAGES', slimBatchModify],
  ['GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', (data: unknown) => mapMessages(data, (message) => slimMessage(message, true))],
]);

/** O Gmail no índice: reconhece as ações pelo prefixo `GMAIL_`. */
export const gmailShaper: ConnectorShaper = {
  connector: 'gmail',
  actionPrefixes: ['GMAIL_'],
  shape(actionSlug, data) {
    const rule = ACTION_RULES.get(actionSlug);
    return stripDeep(rule ? rule(data) : data);
  },
};

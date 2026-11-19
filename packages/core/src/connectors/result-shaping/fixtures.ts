// Fixtures ANONIMIZADAS da limpeza de resultados de conector (CTX-12, phase 11, T4). Cada uma devolve o texto como o motor o grava (`JSON.stringify` do `data` que o
// Composio entrega), com a mesma estrutura e a mesma proporção de uma resposta real: cabeçalhos de protocolo longos, corpo repetido em base64, envelope de propriedades
// do Notion, evento de agenda com HTML, resumo de vários calendários. Nomes, endereços e textos são inventados (domínios `.test` e `example`); nenhum dado pessoal real entrou aqui.
//
// Cada fixture declara `mustContain` (o texto útil que a limpeza tem de preservar) e `urls` (as URLs que têm de sair intactas), que o teste confere em todas.
// Para adicionar um conector novo: uma função aqui com o texto gravado de uma ação dele, mais o caso em `result-shaping.test.ts`.

export interface ConnectorFixture {
  /** Slug da ação do Composio que gerou o texto. */
  slug: string;
  /** Texto gravado do resultado (`JSON.stringify` do `data`). */
  stored: string;
  /** Trechos do texto útil que precisam continuar no resultado limpo. */
  mustContain: string[];
  /** URLs que precisam continuar no resultado limpo, caractere por caractere. */
  urls: string[];
}

/** Sequência base64 determinística (gerador mulberry32), com a entropia de um blob real, para assinaturas e anexos sem depender de nada aleatório. */
export function pseudoBase64(length: number, seed: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let state = seed >>> 0;
  let out = '';
  for (let index = 0; index < length; index += 1) {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    out += alphabet.charAt(((mixed ^ (mixed >>> 14)) >>> 0) % 64);
  }
  return out;
}

/** Texto em base64 URL-safe, a codificação que o Gmail usa em `payload.body.data`; as fixtures repetem o corpo assim, como a resposta real. */
const base64Url = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------------------------------------------------------------------------

const TRACKING_URL = 'https://rastreio.lojaexemplo.test/entregas/BR123456789XX';
const HELP_URL = 'https://ajuda.lojaexemplo.test/pedidos?origem=email';

/** Texto simples da mensagem de pedido enviado (o `messageText` do Composio). */
const ORDER_TEXT = [
  'Olá, Ana!',
  '',
  'Seu pedido #48213 foi enviado e chega em até 3 dias úteis.',
  'Código de rastreio: BR123456789XX',
  `Acompanhe a entrega: ${TRACKING_URL}`,
  '',
  'Itens do pedido:',
  '- Caneca esmaltada azul (2 unidades), R$ 39,90 cada',
  '- Jogo de panos de prato listrado (1 unidade), R$ 54,00',
  '- Porta-temperos de bambu (1 unidade), R$ 72,50',
  '',
  'Endereço de entrega: Rua das Flores, 100, apartamento 12, Bairro Exemplo, 00000-000.',
  'Forma de pagamento: cartão final 0000, em 2 parcelas sem juros.',
  '',
  'Se algum item chegar com defeito, você tem 7 dias corridos para pedir a troca sem custo.',
  `Dúvidas? Responda este e-mail ou acesse ${HELP_URL}.`,
  '',
  'Obrigada por comprar na Loja Exemplo.',
  'Equipe de atendimento',
  '',
  'Para deixar de receber mensagens promocionais: https://lojaexemplo.test/preferencias?token=abc123',
].join('\n');

/** HTML de newsletter, com estilos em linha e links de rastreio: pesado como o de um e-mail de marketing real. */
function newsletterHtml(): string {
  const style = Array.from({ length: 40 }, (_, index) => `.coluna-${index}{padding:12px 0;margin:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#333333}`).join('\n');
  const rows = Array.from(
    { length: 30 },
    (_, index) =>
      `<tr><td class="coluna-${index}" style="padding:12px 0;border-bottom:1px solid #eeeeee;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#333333">` +
      `<a href="https://rastreio.lojaexemplo.test/c/${index}?utm_source=email&amp;utm_medium=pedido&amp;u=${pseudoBase64(60, index + 7)}" style="color:#0a58ca;text-decoration:none;font-weight:bold">Produto relacionado ${index}</a>` +
      `<br><span style="color:#666666;font-size:12px">Confira também esta sugestão para a sua casa, escolhida a partir do seu pedido recente.</span></td>` +
      `<td class="coluna-${index}" align="right" style="padding:12px 0;border-bottom:1px solid #eeeeee;font-size:14px;color:#333333">R$ ${10 + index},90</td></tr>`,
  ).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Pedido enviado</title><style>${style}</style></head><body style="margin:0;padding:0;background:#f4f4f4"><table width="600" align="center" cellpadding="0" cellspacing="0" style="background:#ffffff"><tr><td><p>Olá, Ana!</p><p>Seu pedido #48213 foi enviado.</p></td></tr>${rows}</table></body></html>`;
}

/** Cabeçalhos de protocolo de uma mensagem entregue pelo Gmail: os seis mantidos e os demais, longos, que a limpeza descarta. */
function mailHeaders(seed: number, subject: string): { name: string; value: string }[] {
  return [
    { name: 'Delivered-To', value: 'ana@example.test' },
    { name: 'Received', value: `by 2002:a05:6a20:${pseudoBase64(8, seed)} with SMTP id ${pseudoBase64(20, seed + 1)}; Mon, 12 Oct 2026 05:14:05 -0700 (PDT)` },
    { name: 'X-Google-Smtp-Source', value: pseudoBase64(110, seed + 2) },
    { name: 'X-Received', value: `by 2002:a17:90b:${pseudoBase64(8, seed + 3)} with SMTP id ${pseudoBase64(24, seed + 4)}; Mon, 12 Oct 2026 05:14:05 -0700 (PDT)` },
    { name: 'ARC-Seal', value: `i=1; a=rsa-sha256; t=1760271245; cv=none; d=google.com; s=arc-20240605; b=${pseudoBase64(340, seed + 5)}` },
    { name: 'ARC-Message-Signature', value: `i=1; a=rsa-sha256; c=relaxed/relaxed; d=google.com; s=arc-20240605; h=list-unsubscribe:mime-version:subject:message-id:to:from:date; bh=${pseudoBase64(44, seed + 6)}; b=${pseudoBase64(380, seed + 7)}` },
    { name: 'ARC-Authentication-Results', value: `i=1; mx.google.com; dkim=pass header.i=@lojaexemplo.test header.s=selector1 header.b=${pseudoBase64(8, seed + 8)}; spf=pass smtp.mailfrom=bounce@envios.lojaexemplo.test; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=lojaexemplo.test` },
    { name: 'Return-Path', value: '<bounce+ana=example.test@envios.lojaexemplo.test>' },
    { name: 'Received', value: `from envios.lojaexemplo.test (envios.lojaexemplo.test. [203.0.113.25]) by mx.google.com with ESMTPS id ${pseudoBase64(24, seed + 9)} for <ana@example.test> (version=TLS1_3 cipher=TLS_AES_256_GCM_SHA384 bits=256/256); Mon, 12 Oct 2026 05:14:05 -0700 (PDT)` },
    { name: 'Received-SPF', value: 'pass (google.com: domain of bounce@envios.lojaexemplo.test designates 203.0.113.25 as permitted sender) client-ip=203.0.113.25;' },
    { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.i=@lojaexemplo.test header.s=selector1; spf=pass smtp.mailfrom=bounce@envios.lojaexemplo.test; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=lojaexemplo.test' },
    { name: 'DKIM-Signature', value: `v=1; a=rsa-sha256; c=relaxed/relaxed; d=lojaexemplo.test; s=selector1; t=1760271244; h=From:To:Subject:Date:Message-ID:List-Unsubscribe; bh=${pseudoBase64(44, seed + 10)}; b=${pseudoBase64(344, seed + 11)}` },
    { name: 'Message-ID', value: `<${pseudoBase64(28, seed + 12)}@envios.lojaexemplo.test>` },
    { name: 'From', value: 'Loja Exemplo <novidades@lojaexemplo.test>' },
    { name: 'To', value: 'Ana Exemplo <ana@example.test>' },
    { name: 'Cc', value: 'Suporte Exemplo <suporte@lojaexemplo.test>' },
    { name: 'Reply-To', value: 'Atendimento <atendimento@lojaexemplo.test>' },
    { name: 'Subject', value: subject },
    { name: 'Date', value: 'Mon, 12 Oct 2026 09:14:03 -0300' },
    { name: 'MIME-Version', value: '1.0' },
    { name: 'Content-Type', value: 'multipart/alternative; boundary="000000000000a1b2c3d4e5f6"' },
    { name: 'List-Unsubscribe', value: '<https://lojaexemplo.test/descadastrar?t=abc123>, <mailto:descadastrar@lojaexemplo.test>' },
    { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
    { name: 'X-Mailer', value: 'EnviosExemplo 4.2' },
    { name: 'Feedback-ID', value: `pedido:48213:lojaexemplo:${pseudoBase64(12, seed + 13)}` },
    { name: 'X-Priority', value: '3' },
  ];
}

/** `GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID` de uma newsletter transacional: texto simples e HTML em base64, 25 cabeçalhos e prévia repetida. */
export function gmailMessageFixture(): ConnectorFixture {
  const subject = 'Seu pedido #48213 foi enviado';
  const data = {
    attachmentList: [],
    labelIds: ['CATEGORY_UPDATES', 'INBOX', 'UNREAD'],
    messageId: '19a2f4c8d1e0b537',
    messageText: ORDER_TEXT,
    messageTimestamp: '2026-10-12T12:14:03Z',
    payload: {
      filename: '',
      headers: mailHeaders(11, subject),
      mimeType: 'multipart/alternative',
      partId: '',
      parts: [
        { body: { data: base64Url(ORDER_TEXT), size: ORDER_TEXT.length }, filename: '', headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }, { name: 'Content-Transfer-Encoding', value: 'quoted-printable' }], mimeType: 'text/plain', partId: '0' },
        { body: { data: base64Url(newsletterHtml()), size: 20000 }, filename: '', headers: [{ name: 'Content-Type', value: 'text/html; charset="UTF-8"' }, { name: 'Content-Transfer-Encoding', value: 'quoted-printable' }], mimeType: 'text/html', partId: '1' },
      ],
    },
    preview: { body: ORDER_TEXT.slice(0, 260), subject },
    sender: 'Loja Exemplo <novidades@lojaexemplo.test>',
    sizeEstimate: 31524,
    subject,
    threadId: '19a2f4c8d1e0b537',
    to: 'Ana Exemplo <ana@example.test>',
  };
  return {
    slug: 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
    stored: JSON.stringify(data),
    mustContain: ['Seu pedido #48213 foi enviado e chega em até 3 dias úteis.', 'Código de rastreio: BR123456789XX', 'Caneca esmaltada azul (2 unidades)', 'Obrigada por comprar na Loja Exemplo.'],
    urls: [TRACKING_URL, HELP_URL],
  };
}

/**
 * Uma mensagem da listagem do Gmail como o Composio a entrega: texto pronto em `messageText`, o mesmo texto e um HTML em base64 dentro de `payload`, 25 cabeçalhos de protocolo,
 * prévia repetida e os campos de topo `to` e `messageTimestamp`, que repetem o cabeçalho To e o cabeçalho Date. `parts` acrescenta partes MIME (anexos).
 */
function gmailListedMessage(index: number, subject: string, text: string, extra: Record<string, unknown> = {}, parts: unknown[] = []) {
  return {
    attachmentList: [],
    labelIds: ['INBOX', 'UNREAD'],
    messageId: `19a30${index}b7c2d1e4f0`,
    messageText: text,
    messageTimestamp: `2026-10-1${index}T10:00:00Z`,
    payload: {
      headers: mailHeaders(30 + index * 20, subject),
      mimeType: 'multipart/mixed',
      parts: [
        { body: { data: base64Url(text), size: text.length }, filename: '', mimeType: 'text/plain', partId: '0' },
        { body: { data: pseudoBase64(9000, 100 + index), size: 6700 }, filename: '', mimeType: 'text/html', partId: '1' },
        ...parts,
      ],
    },
    preview: { body: text.slice(0, 220), subject },
    sender: 'Equipe Exemplo <equipe@projetoexemplo.test>',
    subject,
    threadId: `19a30${index}b7c2d1e4f0`,
    to: 'Ana Exemplo <ana@example.test>',
    ...extra,
  };
}

const REUNION_TEXT = 'Oi, Ana! Confirmando a reunião de planejamento do trimestre na quinta-feira às 14h, na sala azul. A pauta está em https://docs.projetoexemplo.test/planejamento-q4 e precisamos fechar três pontos: orçamento da campanha, prazo do lançamento e responsáveis por cada entrega. Se não puder comparecer, avise até quarta para remarcarmos. Abraço, Bruno.';
const INVOICE_TEXT = 'Segue a nota fiscal do serviço de outubro, no valor de R$ 1.250,00. O vencimento é dia 20 e o pagamento pode ser feito pelo link https://pagamentos.projetoexemplo.test/faturas/2026-10 ou por transferência. Qualquer dúvida sobre os itens da nota, é só responder este e-mail.';
const INVITE_TEXT = 'Você foi convidada para a retrospectiva da sprint 14, sexta-feira às 16h. Leve sugestões de melhoria para o processo de revisão e para a comunicação entre as equipes. O link da chamada está no convite do calendário.';
const INVOICE_ATTACHMENT = { attachmentList: [{ attachmentId: 'ANGjdJ8nota', filename: 'nota-fiscal-outubro.pdf', mimeType: 'application/pdf' }] };
const INVOICE_PART = [{ body: { attachmentId: 'ANGjdJ8nota', size: 48211 }, filename: 'nota-fiscal-outubro.pdf', mimeType: 'application/pdf', partId: '2' }];

/** `GMAIL_FETCH_EMAILS` com três mensagens (a última com um anexo PDF) e o token da próxima página. */
export function gmailListFixture(): ConnectorFixture {
  const data = {
    messages: [
      gmailListedMessage(1, 'Reunião de planejamento na quinta', REUNION_TEXT),
      gmailListedMessage(2, 'Nota fiscal de outubro', INVOICE_TEXT, INVOICE_ATTACHMENT, INVOICE_PART),
      gmailListedMessage(3, 'Convite: retrospectiva da sprint 14', INVITE_TEXT),
    ],
    nextPageToken: '09876543210123456789',
    resultSizeEstimate: 3,
  };
  return {
    slug: 'GMAIL_FETCH_EMAILS',
    stored: JSON.stringify(data),
    mustContain: ['Confirmando a reunião de planejamento do trimestre na quinta-feira às 14h', 'Segue a nota fiscal do serviço de outubro', 'retrospectiva da sprint 14', 'nota-fiscal-outubro.pdf', '09876543210123456789'],
    urls: ['https://docs.projetoexemplo.test/planejamento-q4', 'https://pagamentos.projetoexemplo.test/faturas/2026-10'],
  };
}

/** Marca do fim do texto longo da newsletter: fica depois do limite de `messageText` e por isso não pode chegar ao modelo. */
export const LONG_TEXT_TAIL = 'FIM-DO-TEXTO-LONGO-DA-NEWSLETTER';
/** Link logo no começo do texto longo: dentro do limite, sai intacto. */
export const LONG_TEXT_URL = 'https://boletim.lojaexemplo.test/edicao/42?utm_campaign=outubro';

/** Texto de newsletter de cerca de 6.000 caracteres: um link no começo, muitos parágrafos de oferta e a marca de fim. */
export function longNewsletterText(): string {
  const offers = Array.from({ length: 40 }, (_, index) => `Oferta ${index + 1}: o produto ${index + 1} da linha de outono está com desconto especial por tempo limitado, confira as cores e os tamanhos disponíveis.`);
  return ['Olá, Ana! A edição de outubro do nosso boletim já está no ar.', `Leia a edição completa: ${LONG_TEXT_URL}`, '', ...offers, '', LONG_TEXT_TAIL].join('\n');
}

/** `GMAIL_FETCH_EMAILS` com uma newsletter longa (o limite de `messageText` corta) e uma mensagem curta (passa inteira). */
export function gmailLongTextFixture(): ConnectorFixture {
  const data = {
    messages: [gmailListedMessage(4, 'Boletim de outubro', longNewsletterText()), gmailListedMessage(5, 'Convite: retrospectiva da sprint 14', INVITE_TEXT)],
    nextPageToken: '11223344556677889900',
    resultSizeEstimate: 2,
  };
  return {
    slug: 'GMAIL_FETCH_EMAILS',
    stored: JSON.stringify(data),
    mustContain: ['A edição de outubro do nosso boletim já está no ar.', 'Oferta 1:', INVITE_TEXT, '11223344556677889900'],
    urls: [LONG_TEXT_URL],
  };
}

/** `GMAIL_LIST_MESSAGES` (listagem por consulta, no formato detalhado do Composio): cinco mensagens, a segunda com texto longo e a quarta com um anexo, e o token da próxima página. */
export function gmailListMessagesFixture(): ConnectorFixture {
  const data = {
    messages: [
      gmailListedMessage(1, 'Reunião de planejamento na quinta', REUNION_TEXT),
      gmailListedMessage(4, 'Boletim de outubro', longNewsletterText()),
      gmailListedMessage(3, 'Convite: retrospectiva da sprint 14', INVITE_TEXT),
      gmailListedMessage(2, 'Nota fiscal de outubro', INVOICE_TEXT, INVOICE_ATTACHMENT, INVOICE_PART),
      gmailListedMessage(5, 'Re: reunião de planejamento na quinta', 'Perfeito, estarei lá. Levo o orçamento da campanha impresso. Abraço, Ana.'),
    ],
    nextPageToken: '55443322110099887766',
    resultSizeEstimate: 5,
  };
  return {
    slug: 'GMAIL_LIST_MESSAGES',
    stored: JSON.stringify(data),
    mustContain: ['Confirmando a reunião de planejamento do trimestre na quinta-feira às 14h', 'Segue a nota fiscal do serviço de outubro', 'Perfeito, estarei lá.', 'nota-fiscal-outubro.pdf', '55443322110099887766'],
    urls: ['https://docs.projetoexemplo.test/planejamento-q4', 'https://pagamentos.projetoexemplo.test/faturas/2026-10', LONG_TEXT_URL],
  };
}

/** Os ids de 24 mensagens da fixture do lote: o Composio devolve de volta o que o bot pediu. */
export const BATCH_MESSAGE_IDS: readonly string[] = Array.from({ length: 24 }, (_, index) => `19a31${String(index).padStart(2, '0')}c4d5e6f708`);

/** `GMAIL_BATCH_MODIFY_MESSAGES`: resposta curta que devolve a lista de ids pedida, os rótulos mexidos e a contagem (a forma exata da resposta real do Composio não está no repositório). */
export function gmailBatchModifyFixture(): ConnectorFixture {
  const data = { messageIds: [...BATCH_MESSAGE_IDS], addLabelIds: [], removeLabelIds: ['UNREAD', 'INBOX'], modifiedCount: BATCH_MESSAGE_IDS.length, status: 'success' };
  return {
    slug: 'GMAIL_BATCH_MODIFY_MESSAGES',
    stored: JSON.stringify(data),
    mustContain: ['UNREAD', 'INBOX', 'success', 'modifiedCount: 24'],
    urls: [],
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Notion
// ---------------------------------------------------------------------------------------------------------------------------------------------

const plainAnnotations = { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: 'default' };

/** Trecho de texto formatado do Notion, com as anotações de estilo que a limpeza descarta. */
const textRun = (content: string, link: string | null = null) => ({ type: 'text', text: { content, link: link === null ? null : { url: link } }, annotations: plainAnnotations, plain_text: content, href: link });

/** Usuário do Notion no envelope bruto (id, nome, avatar nulo e e-mail derivado do nome em domínio `.test`), como aparece em `people` e `created_by`. */
const user = (id: string, name: string) => ({ object: 'user', id, name, avatar_url: null, type: 'person', person: { email: `${name.toLowerCase().replace(/\W+/g, '.')}@example.test` } });

/** Uma linha do banco de tarefas, no envelope bruto do Notion. */
function notionPage(index: number, row: { title: string; status: string; priority: string | null; tags: string[]; owner: string | null; due: string | null; amount: number | null; done: boolean; link: string | null; note: string | null }) {
  const id = `3f2a9c1e-7b4d-4e0a-9d51-${String(index).padStart(12, '0')}`;
  return {
    object: 'page',
    id,
    created_time: '2026-09-01T12:00:00.000Z',
    last_edited_time: `2026-10-0${index}T15:30:00.000Z`,
    created_by: { object: 'user', id: '7d1e0a44-1c52-4b8e-9a63-000000000001' },
    last_edited_by: { object: 'user', id: '7d1e0a44-1c52-4b8e-9a63-000000000001' },
    cover: null,
    icon: { type: 'emoji', emoji: '📌' },
    parent: { type: 'database_id', database_id: 'b81c2e5f-3d7a-4f60-8e12-000000000abc' },
    archived: false,
    in_trash: false,
    properties: {
      'Concluída': { id: 'Mn%3Ac', type: 'checkbox', checkbox: row.done },
      'Criada em': { id: 'Pq%5Bd', type: 'created_time', created_time: '2026-09-01T12:00:00.000Z' },
      'Link': { id: 'Rs%3Ee', type: 'url', url: row.link },
      'Notas': { id: 'Tu%40f', type: 'rich_text', rich_text: row.note === null ? [] : [textRun(row.note)] },
      'Prazo': { id: 'Vw%3Fg', type: 'date', date: row.due === null ? null : { start: row.due, end: null, time_zone: null } },
      'Prioridade': { id: 'Xy%3Ah', type: 'select', select: row.priority === null ? null : { id: `sel-${row.priority}`, name: row.priority, color: 'red' } },
      'Projeto': { id: 'Za%3Bi', type: 'relation', relation: [{ id: 'c4d5e6f7-0a1b-4c2d-8e3f-000000000def' }], has_more: false },
      'Responsável': { id: 'Bc%3Cj', type: 'people', people: row.owner === null ? [] : [user('9a8b7c6d-5e4f-4a3b-8c2d-000000000111', row.owner)] },
      'Status': { id: 'Df%3Dk', type: 'status', status: { id: `st-${row.status}`, name: row.status, color: 'blue' } },
      'Tags': { id: 'Fg%3Fl', type: 'multi_select', multi_select: row.tags.map((tag, position) => ({ id: `tag-${position}`, name: tag, color: 'green' })) },
      'Tarefa': { id: 'title', type: 'title', title: [textRun(row.title)] },
      'Total': { id: 'Hi%3Fm', type: 'formula', formula: { type: 'number', number: row.amount === null ? null : row.amount * 2 } },
      'Valor': { id: 'Jk%3Fn', type: 'number', number: row.amount },
    },
    url: `https://www.notion.so/Tarefa-${index}-3f2a9c1e7b4d4e0a9d51${String(index).padStart(12, '0')}`,
    public_url: null,
  };
}

/** `NOTION_QUERY_DATABASE`: cinco tarefas de um banco, no envelope bruto (propriedades com id e tipo, estilo, autoria, pai e ícone). */
export function notionQueryFixture(): ConnectorFixture {
  const pages = [
    notionPage(1, { title: 'Revisar proposta do cliente Exemplo', status: 'Em andamento', priority: 'Alta', tags: ['comercial', 'contrato'], owner: 'Carla Exemplo', due: '2026-10-20', amount: 4500, done: false, link: 'https://docs.projetoexemplo.test/propostas/cliente-exemplo', note: 'Conferir cláusula de reajuste antes de enviar.' }),
    notionPage(2, { title: 'Publicar relatório mensal', status: 'A fazer', priority: 'Média', tags: ['relatório'], owner: 'Diego Exemplo', due: '2026-10-25', amount: 1200, done: false, link: null, note: null }),
    notionPage(3, { title: 'Atualizar tabela de preços', status: 'Concluído', priority: null, tags: ['comercial'], owner: 'Carla Exemplo', due: '2026-10-10', amount: null, done: true, link: 'https://docs.projetoexemplo.test/precos/2026-10', note: 'Publicada na intranet.' }),
    notionPage(4, { title: 'Agendar entrevista com fornecedor', status: 'A fazer', priority: 'Baixa', tags: [], owner: null, due: null, amount: 300, done: false, link: null, note: 'Aguardando retorno do e-mail.' }),
    notionPage(5, { title: 'Treinar equipe no novo fluxo', status: 'Em andamento', priority: 'Alta', tags: ['equipe', 'processo'], owner: 'Diego Exemplo', due: '2026-10-30', amount: 800, done: false, link: 'https://docs.projetoexemplo.test/treinamento/fluxo-novo', note: 'Primeira turma na terça.' }),
  ];
  const data = { object: 'list', results: pages, next_cursor: null, has_more: false, type: 'page_or_database', page_or_database: {}, request_id: 'a1b2c3d4-0000-4000-8000-000000000001' };
  return {
    slug: 'NOTION_QUERY_DATABASE',
    stored: JSON.stringify(data),
    mustContain: ['Revisar proposta do cliente Exemplo', 'Em andamento', 'Carla Exemplo', '2026-10-20', 'Conferir cláusula de reajuste antes de enviar.', 'Atualizar tabela de preços', 'comercial, contrato'],
    urls: [
      'https://docs.projetoexemplo.test/propostas/cliente-exemplo',
      'https://docs.projetoexemplo.test/precos/2026-10',
      'https://www.notion.so/Tarefa-1-3f2a9c1e7b4d4e0a9d51000000000001',
      'https://www.notion.so/Tarefa-5-3f2a9c1e7b4d4e0a9d51000000000005',
    ],
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Google Calendar
// ---------------------------------------------------------------------------------------------------------------------------------------------

/**
 * `GOOGLECALENDAR_EVENTS_LIST`: agenda com o ruído de sincronização de cada evento (`kind`, `etag`, `iCalUID`, `sequence`, datas de criação e edição, lembrete e tipo
 * padrão, criador e organizador que já são participantes, marcas falsas), HTML na descrição, lista uniforme de convidados, miniatura em base64, nulos e uma descrição
 * repetida entre ocorrências.
 */
export function calendarFixture(): ConnectorFixture {
  const recurring = '<div><p>Reunião <b>semanal</b> de acompanhamento do projeto.</p><p>Pauta fixa: andamento das entregas, bloqueios e próximos passos. Registrar as decisões na ata compartilhada, em <a href="https://docs.projetoexemplo.test/atas/semanal?visao=ultima&amp;ordem=data">ata semanal</a>, e avisar a equipe no canal do projeto ao final.</p><ul><li>Andamento</li><li>Bloqueios</li><li>Próximos passos</li></ul></div>';
  const event = (id: string, summary: string, start: string, description: string | null, extra: Record<string, unknown> = {}) => ({
    kind: 'calendar#event',
    etag: `"${pseudoBase64(18, id.length + 3)}"`,
    id,
    status: 'confirmed',
    htmlLink: `https://www.google.com/calendar/event?eid=${pseudoBase64(40, id.length + 9)}`,
    created: '2026-09-02T10:00:00.000Z',
    updated: '2026-09-02T10:00:00.000Z',
    summary,
    description,
    location: null,
    creator: { email: 'bruno@projetoexemplo.test', self: false },
    organizer: { email: 'bruno@projetoexemplo.test', self: false },
    start: { dateTime: `${start}T14:00:00-03:00`, timeZone: 'America/Sao_Paulo' },
    end: { dateTime: `${start}T15:00:00-03:00`, timeZone: 'America/Sao_Paulo' },
    iCalUID: `${id}@google.com`,
    sequence: 0,
    attendees: [
      { email: 'ana@example.test', responseStatus: 'accepted', self: true, displayName: null, optional: null },
      { email: 'bruno@projetoexemplo.test', responseStatus: 'accepted', organizer: true, displayName: 'Bruno Exemplo', optional: null },
      { email: 'carla@projetoexemplo.test', responseStatus: 'needsAction', displayName: 'Carla Exemplo', optional: true },
    ],
    reminders: { useDefault: true },
    eventType: 'default',
    ...extra,
  });
  const data = {
    kind: 'calendar#events',
    etag: `"${pseudoBase64(18, 1)}"`,
    summary: 'Agenda de Exemplo',
    description: '',
    updated: '2026-10-12T08:00:00.000Z',
    timeZone: 'America/Sao_Paulo',
    accessRole: 'owner',
    defaultReminders: [{ method: 'popup', minutes: 10 }],
    nextPageToken: null,
    nextSyncToken: null,
    items: [
      event('evt001', 'Acompanhamento semanal', '2026-10-13', recurring),
      event('evt002', 'Almoço com a equipe', '2026-10-14', null, { location: 'Restaurante Exemplo', conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.projetoexemplo.test/abc-defg-hij', label: 'meet.projetoexemplo.test/abc-defg-hij' }] } }),
      event('evt003', 'Acompanhamento semanal', '2026-10-20', recurring, { attachments: [{ fileUrl: 'https://drive.projetoexemplo.test/arquivos/ata-anterior', title: 'Ata anterior', mimeType: 'application/pdf', fileId: 'f-001' }, { fileUrl: 'https://drive.projetoexemplo.test/arquivos/pauta', title: 'Pauta', mimeType: 'text/plain', fileId: 'f-002' }] }),
      event('evt004', 'Revisão de orçamento', '2026-10-21', 'Rever o orçamento da campanha.', { thumbnail: `data:image/png;base64,${pseudoBase64(1500, 77)}` }),
    ],
  };
  return {
    slug: 'GOOGLECALENDAR_EVENTS_LIST',
    stored: JSON.stringify(data),
    mustContain: ['Acompanhamento semanal', 'Almoço com a equipe', 'Restaurante Exemplo', 'Revisão de orçamento', 'Rever o orçamento da campanha.', 'Pauta fixa: andamento das entregas, bloqueios e próximos passos.', 'Bruno Exemplo'],
    urls: ['https://docs.projetoexemplo.test/atas/semanal?visao=ultima&ordem=data', 'https://meet.projetoexemplo.test/abc-defg-hij', 'https://drive.projetoexemplo.test/arquivos/ata-anterior', 'https://drive.projetoexemplo.test/arquivos/pauta'],
  };
}

/** Linha do `summary_view` do Composio: o evento resumido com o id do calendário a que pertence, a URL do evento e o dia inteiro marcado (chaves em ordem alfabética, como na resposta). */
const summaryRow = (calendar: string, eventId: string, title: string, start: string, end: string) => ({
  calendar,
  display_url: `https://www.google.com/calendar/event?eid=${base64Url(`${eventId} ${calendar}`)}`,
  end,
  event_id: eventId,
  is_all_day: !start.includes('T'),
  start,
  title,
});

/**
 * `GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS` na forma que o Composio devolve (resposta mínima): a lista de calendários consultados, o aviso do próprio Composio, o mapa
 * de erros por calendário e a lista `events`, vazios, e o `summary_view` com uma linha por evento repetindo o id do calendário. Três calendários inventados (um pessoal,
 * um de grupo e um da família, os dois últimos com id longo de grupo) e nove eventos: a limpeza junta cada calendário com os eventos dele.
 */
export function calendarAllCalendarsFixture(): ConnectorFixture {
  const personal = 'ana@example.test';
  const team = 'e7a41c9d2b8f3560a1d94c7e2b0f8a35c6d17e9b3a2f4081c5d6e7f9a0b1c2d3@group.calendar.google.com';
  const family = 'family04817392650183746521@group.calendar.google.com';
  const rows = [
    summaryRow(personal, 'k3d8f1h2m5q7a9c0e4g6i8l2n4_20261020T120000Z', 'Consulta no dentista', '2026-10-20T09:00:00-03:00', '2026-10-20T10:00:00-03:00'),
    summaryRow(personal, 'b6e2j4n8p0r1t3v5a7c9d1f3h5_20261021T213000Z', 'Aula de yoga', '2026-10-21T18:30:00-03:00', '2026-10-21T19:30:00-03:00'),
    summaryRow(personal, 'q9s1u3w5y7a2c4e6g8i0k2m4o6_20261022', 'Aniversário de Júlia', '2026-10-22', '2026-10-23'),
    summaryRow(team, 'm1o3q5s7u9a0c2e4g6i8k0n3p5_20261020T170000Z', 'Reunião de planejamento do trimestre', '2026-10-20T14:00:00-03:00', '2026-10-20T15:00:00-03:00'),
    summaryRow(team, 'd4f6h8j0l2n4p6r8t0v1a3c5e7_20261021T130000Z', 'Revisão de orçamento da campanha', '2026-10-21T10:00:00-03:00', '2026-10-21T11:00:00-03:00'),
    summaryRow(team, 'g9i1k3m5o7q9s1u3v5a7c9e1g3_20261023', 'Recesso da equipe Exemplo', '2026-10-23', '2026-10-24'),
    summaryRow(team, 'h2j4l6n8p0r2t4v6a8c0e2g4i6_20261024T180000Z', 'Demonstração para o cliente Exemplo', '2026-10-24T15:00:00-03:00', '2026-10-24T16:00:00-03:00'),
    summaryRow(family, 'n5p7r9t1v3a5c7e9g1i3k5m7o9_20261022T113000Z', 'Consulta pediátrica', '2026-10-22T08:30:00-03:00', '2026-10-22T09:30:00-03:00'),
    summaryRow(family, 'r8t0v2a4c6e8g0i2k4m6o8q0s2_20261025T230000Z', 'Jantar na casa dos avós', '2026-10-25T20:00:00-03:00', '2026-10-25T22:00:00-03:00'),
  ];
  const data = {
    calendars_queried: [
      { id: personal, summary: personal },
      { id: team, summary: 'Equipe Projeto Exemplo' },
      { id: family, summary: 'Família' },
    ],
    composio_execution_message:
      "Minimal response: returning only summary_view (event titles, times, calendars). Full events array omitted. Use response_detail='full' to include complete event details with attendees, descriptions, and conference data.",
    errors_by_calendar: {},
    events: [],
    summary_view: rows,
  };
  return {
    slug: 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS',
    stored: JSON.stringify(data),
    mustContain: ['Consulta no dentista', 'Aniversário de Júlia', 'Reunião de planejamento do trimestre', 'Demonstração para o cliente Exemplo', 'Consulta pediátrica', 'Equipe Projeto Exemplo', 'Família', team, family, rows[3]!.event_id, rows[8]!.event_id, 'Minimal response'],
    urls: rows.map((row) => row.display_url),
  };
}

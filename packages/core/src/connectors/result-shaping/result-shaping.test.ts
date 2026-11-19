// Prova da limpeza dos resultados de conector (CTX-12, phases 11 e 12) sobre fixtures anonimizadas na forma real do Composio (`fixtures.ts`): Gmail, Notion e Google Calendar
// (duas ações com regra própria). Cobre o aceite (texto útil presente, tamanho menor, URLs intactas; Gmail abaixo de 10% e só com os cabeçalhos listados; Notion em tabela
// markdown; Calendar pelo menos 25% menor que a camada genérica e sem o ruído de sincronização; conector ou ação sem arquivo só pela camada genérica) e a garantia do
// contrato: a função nunca lança, nunca devolve mais que o texto gravado e dá sempre o mesmo texto.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BATCH_MESSAGE_IDS, LONG_TEXT_TAIL, LONG_TEXT_URL, calendarAllCalendarsFixture, calendarFixture, gmailBatchModifyFixture, gmailListFixture, gmailListMessagesFixture, gmailLongTextFixture, gmailMessageFixture, longNewsletterText, notionQueryFixture, pseudoBase64 } from './fixtures';
import type { ConnectorFixture } from './fixtures';
import { MESSAGE_TEXT_LIMIT, gmailShaper } from './gmail';
import { googleCalendarShaper } from './google-calendar';
import { shapeConnectorResult } from './index';

afterEach(() => vi.restoreAllMocks());

const fixtures: [string, () => ConnectorFixture][] = [
  ['Gmail, mensagem completa', gmailMessageFixture],
  ['Gmail, listagem', gmailListFixture],
  ['Gmail, listagem com texto longo', gmailLongTextFixture],
  ['Gmail, GMAIL_LIST_MESSAGES', gmailListMessagesFixture],
  ['Gmail, lote GMAIL_BATCH_MODIFY_MESSAGES', gmailBatchModifyFixture],
  ['Notion, consulta de banco', notionQueryFixture],
  ['Google Calendar, lista de eventos', calendarFixture],
  ['Google Calendar, todos os calendários', calendarAllCalendarsFixture],
];

/** `data` do resultado gravado, para variar uma fixture sem reescrevê-la. */
const dataOf = (fixture: ConnectorFixture): Record<string, unknown> => JSON.parse(fixture.stored) as Record<string, unknown>;

describe('todas as fixtures', () => {
  it.each(fixtures)('%s: texto útil presente, tamanho menor, URLs intactas e sempre a mesma forma', (_name, build) => {
    const fixture = build();
    const out = shapeConnectorResult(fixture.slug, fixture.stored);
    expect(out.length).toBeLessThan(fixture.stored.length);
    for (const text of fixture.mustContain) expect(out).toContain(text);
    for (const url of fixture.urls) expect(out).toContain(url);
    expect(shapeConnectorResult(fixture.slug, fixture.stored)).toBe(out);
    // Sem estado entre chamadas: limpar OUTROS resultados (em outra ordem) entre as duas chamadas não muda nenhum texto, e cada um deles também é estável.
    for (const [, other] of [...fixtures].reverse()) {
      const otherFixture = other();
      const first = shapeConnectorResult(otherFixture.slug, otherFixture.stored);
      expect(shapeConnectorResult(otherFixture.slug, otherFixture.stored)).toBe(first);
    }
    expect(shapeConnectorResult(fixture.slug, fixture.stored)).toBe(out);
  });
});

describe('Gmail', () => {
  const junkHeaders = ['Delivered-To', 'Received', 'X-Google-Smtp-Source', 'ARC-Seal', 'ARC-Message-Signature', 'Return-Path', 'Received-SPF', 'Authentication-Results', 'DKIM-Signature', 'Message-ID', 'MIME-Version', 'Content-Type', 'List-Unsubscribe', 'X-Mailer', 'Feedback-ID', 'X-Priority'];

  it('mensagem completa: abaixo de 10% do original, texto da mensagem presente, só os seis cabeçalhos, sem blobs nem assunto duplicado', () => {
    const fixture = gmailMessageFixture();
    const out = shapeConnectorResult(fixture.slug, fixture.stored);
    expect(out.length / fixture.stored.length).toBeLessThan(0.1);
    expect(out).toContain('Seu pedido #48213 foi enviado e chega em até 3 dias úteis.');
    for (const line of [
      'From: Loja Exemplo <novidades@lojaexemplo.test>',
      'To: Ana Exemplo <ana@example.test>',
      'Cc: Suporte Exemplo <suporte@lojaexemplo.test>',
      'Reply-To: Atendimento <atendimento@lojaexemplo.test>',
      'Subject: Seu pedido #48213 foi enviado',
      'Date: Mon, 12 Oct 2026 09:14:03 -0300',
    ]) {
      expect(out).toContain(line);
    }
    for (const name of junkHeaders) expect(out).not.toContain(name);
    // Os blobs base64 do corpo (texto e HTML) e a estrutura MIME não chegam ao modelo.
    const parts = (dataOf(fixture).payload as { parts: { body: { data: string } }[] }).parts;
    for (const part of parts) expect(out).not.toContain(part.body.data.slice(0, 60));
    expect(out).not.toMatch(/base64|partId|text\/html|mimeType/);
    // Prévia repetida (assunto igual ao da mensagem e corpo já dentro de `messageText`) sai por inteiro.
    expect(out).not.toContain('preview');
    // O assunto aparece uma vez só: o do cabeçalho Subject; o campo `subject` de topo (igual a ele) e `preview.subject` saem. O remetente de topo fica.
    expect(out.match(/^\s*subject:/gim)).toHaveLength(1);
    expect(out.split('Subject: Seu pedido #48213 foi enviado')).toHaveLength(2);
    expect(out).toMatch(/^sender: Loja Exemplo <novidades@lojaexemplo\.test>$/m);
    // A11: `to` de topo e `messageTimestamp` repetem os cabeçalhos To e Date, que ficam; os campos de topo saem.
    expect(out).not.toMatch(/^\s*to:/m);
    expect(out).not.toContain('messageTimestamp');
  });

  it('subject de topo: sai só quando é igual ao cabeçalho Subject; diferente ou sem o cabeçalho, fica (o assunto nunca se perde)', () => {
    const fixture = gmailMessageFixture();
    const data = dataOf(fixture) as { payload: { headers: { name: string; value: string }[] } };
    const subjectLines = (text: string) => text.match(/^\s*subject:/gim)?.length ?? 0;
    // Igual ao cabeçalho, mesmo com espaços nas pontas: sai.
    expect(subjectLines(shapeConnectorResult(fixture.slug, JSON.stringify({ ...data, subject: '  Seu pedido #48213 foi enviado ' })))).toBe(1);
    // Diferente do cabeçalho: os dois ficam, cada um com o seu texto.
    const different = shapeConnectorResult(fixture.slug, JSON.stringify({ ...data, subject: 'Assunto diferente do cabeçalho' }));
    expect(subjectLines(different)).toBe(2);
    expect(different).toContain('subject: Assunto diferente do cabeçalho');
    expect(different).toContain('Subject: Seu pedido #48213 foi enviado');
    // Sem cabeçalho Subject: o `subject` de topo é a única fonte do assunto e fica.
    const noHeader = { ...data, payload: { ...data.payload, headers: data.payload.headers.filter((header) => header.name !== 'Subject') } };
    const kept = shapeConnectorResult(fixture.slug, JSON.stringify(noHeader));
    expect(subjectLines(kept)).toBe(1);
    expect(kept).toContain('subject: Seu pedido #48213 foi enviado');
  });

  it('preview.subject diferente do assunto fica; igual ao assunto ou ao cabeçalho Subject sai', () => {
    const fixture = gmailMessageFixture();
    const data = dataOf(fixture);
    const different = shapeConnectorResult(fixture.slug, JSON.stringify({ ...data, preview: { subject: 'Outro assunto da prévia', body: 'x' } }));
    expect(different).toContain('Outro assunto da prévia');
    const headerOnly = shapeConnectorResult(fixture.slug, JSON.stringify({ ...data, subject: undefined, preview: { subject: 'Seu pedido #48213 foi enviado' } }));
    expect(headerOnly).not.toContain('preview');
  });

  it('listagem: todas as mensagens, token da próxima página, anexo só uma vez e sem a estrutura MIME', () => {
    const fixture = gmailListFixture();
    const out = shapeConnectorResult(fixture.slug, fixture.stored);
    // O assunto de cada mensagem sai uma vez só, pelo cabeçalho Subject (o `subject` de topo, igual a ele, não é repetido).
    for (const subject of ['Reunião de planejamento na quinta', 'Nota fiscal de outubro', 'Convite: retrospectiva da sprint 14']) expect(out.split(`Subject: ${subject}`)).toHaveLength(2);
    expect(out).not.toMatch(/^\s*subject:/m);
    expect(out).toContain('nextPageToken: 09876543210123456789');
    expect(out.split('ANGjdJ8nota')).toHaveLength(2);
    expect(out).not.toMatch(/partId|mimeType: text|payload:\n\s+mimeType|size:/);
    for (const name of junkHeaders) expect(out).not.toContain(name);
  });

  it('mensagem completa mantém os dados do anexo da estrutura MIME; a listagem não os repete', () => {
    const fixture = gmailMessageFixture();
    const data = dataOf(fixture) as { payload: { parts: unknown[] } };
    data.payload.parts.push({ body: { attachmentId: 'ANGjdJ8planilha', size: 9120 }, filename: 'planilha.xlsx', mimeType: 'application/vnd.ms-excel', partId: '2' });
    const full = shapeConnectorResult(fixture.slug, JSON.stringify(data));
    expect(full).toContain('attachmentId: ANGjdJ8planilha');
    expect(full).toContain('filename: planilha.xlsx');
    const listed = shapeConnectorResult('GMAIL_FETCH_EMAILS', JSON.stringify({ messages: [data] }));
    expect(listed).not.toContain('ANGjdJ8planilha');
  });

  it('sem messageText, o texto do corpo é lido do base64 antes de ser descartado (o texto da mensagem nunca se perde)', () => {
    const fixture = gmailMessageFixture();
    const data = dataOf(fixture);
    delete data.messageText;
    delete data.preview;
    const out = shapeConnectorResult(fixture.slug, JSON.stringify(data));
    expect(out).toContain('Seu pedido #48213 foi enviado e chega em até 3 dias úteis.');
    expect(out).toContain('Código de rastreio: BR123456789XX');
    // Só o HTML: vira texto pela camada genérica.
    const htmlOnly = { messageId: 'm1', payload: { mimeType: 'text/html', headers: [], body: { data: Buffer.from('<p>Olá <b>mundo</b></p><p>Segunda linha com <a href="https://exemplo.test/a?x=1&amp;y=2">link</a>.</p>').toString('base64url'), size: 10 } } };
    const text = shapeConnectorResult('GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', JSON.stringify(htmlOnly) + ' '.repeat(40));
    expect(text).toContain('Olá mundo');
    expect(text).toContain('link (https://exemplo.test/a?x=1&y=2)');
  });

  it('outras ações do Gmail passam pela camada 2: cabeçalhos filtrados e nenhum body.data, em qualquer profundidade', () => {
    const fixture = gmailMessageFixture();
    const data = dataOf(fixture);
    const out = shapeConnectorResult('GMAIL_FETCH_MESSAGE_BY_THREAD_ID', JSON.stringify({ messages: [data, data] }));
    for (const name of junkHeaders) expect(out).not.toContain(name);
    expect(out).toContain('Subject: Seu pedido #48213 foi enviado');
    // O blob some pela regra do Gmail (`body.data` e o `size` dele), não pelo marcador da camada genérica.
    const parts = (data.payload as { parts: { body: { data: string } }[] }).parts;
    for (const part of parts) expect(out).not.toContain(part.body.data.slice(0, 60));
    expect(out).not.toMatch(/base64|size:/);
  });

  /** Número como o marcador de corte o escreve: milhar com ponto, sem depender do ICU do Node. */
  const thousands = (value: number): string => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  /** Mensagem mínima com um cabeçalho de protocolo (para a limpeza encurtar o resultado) e o `messageText` pedido. */
  const junkHeader = { name: 'X-Junk', value: 'abc def '.repeat(300) };
  const mailWith = (messageText: string, headers: { name: string; value: string }[] = [{ name: 'Subject', value: 'Assunto' }], extra: Record<string, unknown> = {}) =>
    JSON.stringify({ messages: [{ messageId: 'm1', messageText, payload: { headers: [junkHeader, ...headers] }, ...extra }] });
  /** Tamanho em caracteres da limpeza anterior ao passo 8b, medido nas mesmas fixtures (o gravado, quando a limpeza não encurtava). */
  const BEFORE = { list: 2791, longText: 7233, message: 1438, listMessages: 11520, batch: 587 };

  it('A11: messageText acima do limite é cortado numa palavra inteira, com aviso do tamanho e do caminho para o resto (read_activity part=original); a mensagem curta passa inteira', () => {
    const fixture = gmailLongTextFixture();
    const out = shapeConnectorResult(fixture.slug, fixture.stored);
    expect(fixture.stored).toContain(LONG_TEXT_TAIL); // o gravado tem o fim; só o que vai ao modelo é cortado
    expect(out).not.toContain(LONG_TEXT_TAIL);
    expect(out).toContain(LONG_TEXT_URL); // o link está dentro do limite e sai intacto
    expect(out).toContain('Oferta 1:');
    expect(out).not.toContain('Oferta 30:');
    const total = longNewsletterText().length;
    expect(out).toContain(`de ${thousands(total)} caracteres; o texto completo está no resultado original (read_activity part=original)]`);
    expect(out.match(/texto cortado/g)).toHaveLength(1); // só a newsletter; o convite curto não leva aviso
    expect(out).toMatch(/[.,a-zé]\n\s*\[texto cortado/); // termina numa palavra inteira, o aviso vem na linha seguinte
  });

  it('A11: o limite é por mensagem: exatamente o limite passa inteiro, bem acima dele corta, e cada mensagem é cortada por conta própria', () => {
    const words = 'palavra '.repeat(1000);
    const exact = shapeConnectorResult('GMAIL_FETCH_EMAILS', mailWith(words.slice(0, MESSAGE_TEXT_LIMIT)));
    expect(exact).not.toContain('texto cortado');
    const over = shapeConnectorResult('GMAIL_FETCH_EMAILS', mailWith(words));
    expect(over).toContain('texto cortado');
    expect(over.length).toBeLessThan(MESSAGE_TEXT_LIMIT + 400);
    const two = shapeConnectorResult('GMAIL_FETCH_EMAILS', JSON.stringify({ messages: [{ messageId: 'a', messageText: words, payload: { headers: [junkHeader] } }, { messageId: 'b', messageText: words.replaceAll('palavra', 'vocábulo') }] }));
    expect(two.match(/texto cortado/g)).toHaveLength(2);
  });

  it('A11: o corte também vale para o texto lido do corpo em base64 e para a mensagem completa', () => {
    const words = 'palavra '.repeat(1000);
    const noText = JSON.stringify({ messageId: 'm1', payload: { mimeType: 'text/plain', headers: [junkHeader], body: { data: Buffer.from(words).toString('base64url'), size: words.length } } });
    expect(shapeConnectorResult('GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', noText)).toContain('texto cortado');
    expect(shapeConnectorResult('GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', mailWith(words))).toContain('texto cortado');
  });

  it('A11: `to` de topo e `messageTimestamp` só saem quando repetem o cabeçalho To e o cabeçalho Date; sem o cabeçalho (ou diferentes), ficam', () => {
    const headers = [{ name: 'To', value: 'Ana <ana@example.test>' }, { name: 'Date', value: 'Mon, 12 Oct 2026 09:14:03 -0300' }];
    const repeated = shapeConnectorResult('GMAIL_FETCH_EMAILS', mailWith('Texto da mensagem.', headers, { to: 'Ana <ana@example.test>', messageTimestamp: '2026-10-12T12:14:03Z' }));
    expect(repeated).not.toMatch(/^\s*to:/m);
    expect(repeated).not.toContain('messageTimestamp');
    expect(repeated).toContain('To: Ana <ana@example.test>');
    expect(repeated).toContain('Date: Mon, 12 Oct 2026 09:14:03 -0300');
    // Sem os cabeçalhos To e Date, o campo de topo é a única fonte e fica.
    const alone = shapeConnectorResult('GMAIL_FETCH_EMAILS', mailWith('Texto da mensagem.', undefined, { to: 'Ana <ana@example.test>', messageTimestamp: '2026-10-12T12:14:03Z' }));
    expect(alone).toContain('to: Ana <ana@example.test>');
    expect(alone).toContain('messageTimestamp: 2026-10-12T12:14:03Z');
    // `to` diferente do cabeçalho (outro destinatário): os dois ficam.
    const different = shapeConnectorResult('GMAIL_FETCH_EMAILS', mailWith('Texto da mensagem.', headers, { to: 'Bruno <bruno@example.test>' }));
    expect(different).toContain('to: Bruno <bruno@example.test>');
    expect(different).toContain('To: Ana <ana@example.test>');
  });

  it('A10: GMAIL_LIST_MESSAGES tem regra própria, a mesma da listagem de e-mails: sem MIME, cabeçalhos de protocolo, repetidos nem texto além do limite, e com URLs, anexo e token intactos', () => {
    const fixture = gmailListMessagesFixture();
    const out = shapeConnectorResult(fixture.slug, fixture.stored);
    expect(out).toBe(shapeConnectorResult('GMAIL_FETCH_EMAILS', fixture.stored));
    for (const name of junkHeaders) expect(out).not.toContain(name);
    expect(out).not.toMatch(/partId|mimeType: text|base64|size:|^\s*to:|messageTimestamp|preview/m);
    expect(out).not.toContain(LONG_TEXT_TAIL);
    expect(out.split('ANGjdJ8nota')).toHaveLength(2);
    expect(out).toContain('Subject: Nota fiscal de outubro');
  });

  it('A10: GMAIL_BATCH_MODIFY_MESSAGES tem regra própria: a lista longa de ids devolvida sai (fica a contagem), o resto da resposta fica e uma lista curta ou de falhas não é tocada', () => {
    const fixture = gmailBatchModifyFixture();
    const out = shapeConnectorResult(fixture.slug, fixture.stored);
    expect(out.length).toBeLessThan(fixture.stored.length * 0.5);
    expect(out).toContain('24 ids');
    expect(out).toContain('read_activity part=original');
    for (const id of BATCH_MESSAGE_IDS) expect(out).not.toContain(id);
    for (const text of fixture.mustContain) expect(out).toContain(text);
    // Cinco ids ou menos ficam como vieram; falhas por id nunca são resumidas.
    const short = shapeConnectorResult(fixture.slug, JSON.stringify({ messageIds: ['id1', 'id2', 'id3'], status: 'success', note: 'x'.repeat(40) }));
    expect(short).toContain('id2');
    const failed = shapeConnectorResult(fixture.slug, JSON.stringify({ messageIds: [...BATCH_MESSAGE_IDS], failed: [{ id: 'idFalhou', error: 'mensagem não encontrada' }], status: 'partial' }));
    expect(failed).toContain('idFalhou');
    expect(failed).toContain('mensagem não encontrada');
    expect(failed).not.toContain(BATCH_MESSAGE_IDS[7]!);
  });

  it('A11: redução em caracteres sobre a limpeza anterior, por ação com regra: nenhuma cresce e as que a regra nova alcança encolhem de verdade', () => {
    const size = (fixture: ConnectorFixture): number => shapeConnectorResult(fixture.slug, fixture.stored).length;
    expect(size(gmailListFixture())).toBeLessThan(BEFORE.list); // só os campos repetidos saem
    expect(size(gmailMessageFixture())).toBeLessThan(BEFORE.message);
    expect(size(gmailLongTextFixture())).toBeLessThan(BEFORE.longText * 0.75);
    expect(size(gmailListMessagesFixture())).toBeLessThan(BEFORE.listMessages * 0.6);
    expect(size(gmailBatchModifyFixture())).toBeLessThan(BEFORE.batch * 0.5);
  });

  it('o slug é reconhecido em qualquer caixa e sem espaços nas pontas', () => {
    const fixture = gmailMessageFixture();
    expect(shapeConnectorResult(' gmail_fetch_message_by_message_id ', fixture.stored)).toBe(shapeConnectorResult(fixture.slug, fixture.stored));
  });
});

describe('Notion', () => {
  it('as linhas do banco saem como tabela markdown, uma linha por página, com os valores simples das propriedades', () => {
    const fixture = notionQueryFixture();
    const out = shapeConnectorResult(fixture.slug, fixture.stored);
    const tableLines = out.split('\n').filter((line) => /^\s*\|/.test(line));
    expect(tableLines).toHaveLength(7); // cabeçalho, separador e 5 páginas
    expect(tableLines[0]).toMatch(/^\s*\| Tarefa \| /); // o título vem primeiro
    expect(tableLines[1]).toMatch(/^\s*\|(---\|)+$/);
    const [first, , third] = tableLines.slice(2);
    expect(first).toContain('| Revisar proposta do cliente Exemplo | false |');
    expect(first).toContain('| Alta |');
    expect(first).toContain('comercial, contrato'); // multi_select
    expect(first).toContain('| Em andamento |'); // status
    expect(first).toContain('| 9000 |'); // fórmula
    expect(first).toContain('c4d5e6f7-0a1b-4c2d-8e3f-000000000def'); // relação, pelo id
    expect(first).toContain('3f2a9c1e-7b4d-4e0a-9d51-000000000001'); // id da página, para agir sobre ela
    expect(third).toContain('| true |');
    for (const noise of ['color', 'annotations', 'created_by', 'last_edited_by', 'plain_text', 'database_id', 'emoji', 'avatar_url', 'request_id', 'archived']) expect(out).not.toContain(noise);
  });

  it('o esquema de um banco (propriedades sem lista de título) não vira linha e mantém as opções', () => {
    const schema = {
      object: 'database',
      id: 'b81c2e5f-3d7a-4f60-8e12-000000000abc',
      title: [{ plain_text: 'Tarefas do projeto', annotations: { bold: false } }],
      properties: {
        Nome: { id: 'title', name: 'Nome', type: 'title', title: {} },
        Status: { id: 'abc', name: 'Status', type: 'status', status: { options: [{ id: '1', name: 'A fazer', color: 'gray' }, { id: '2', name: 'Em andamento', color: 'blue' }, { id: '3', name: 'Concluído', color: 'green' }] } },
      },
    };
    const out = shapeConnectorResult('NOTION_FETCH_DATABASE', JSON.stringify(schema));
    for (const text of ['Tarefas do projeto', 'A fazer', 'Em andamento', 'Concluído', 'Nome', 'Status']) expect(out).toContain(text);
    expect(out).not.toContain('color');
  });

  it('blocos de texto: trechos formatados viram texto, o destino do link e as URLs ficam, o ruído sai', () => {
    const run = (content: string, href: string | null = null) => ({ type: 'text', text: { content }, annotations: { bold: true, color: 'default' }, plain_text: content, href });
    const blocks = {
      block_child_data: {
        results: [
          { object: 'block', id: 'b1', type: 'paragraph', has_children: false, archived: false, created_by: { id: 'u1' }, paragraph: { rich_text: [run('Veja o '), run('documento', 'https://docs.projetoexemplo.test/guia?secao=2'), run(' antes da reunião.')], color: 'default' } },
          { object: 'block', id: 'b2', type: 'to_do', has_children: true, to_do: { rich_text: [run('Enviar a ata')], checked: false } },
        ],
      },
    };
    const out = shapeConnectorResult('NOTION_FETCH_BLOCK_CONTENTS', JSON.stringify(blocks));
    expect(out).toContain('Veja o documento (https://docs.projetoexemplo.test/guia?secao=2) antes da reunião.');
    expect(out).toContain('Enviar a ata');
    expect(out).toContain('has_children: true');
    for (const noise of ['annotations', 'created_by', 'archived', 'color', 'plain_text']) expect(out).not.toContain(noise);
  });

  it('propriedade com o nome de uma coluna do sistema não perde o valor nem a coluna id', () => {
    const page = (n: number) => ({ object: 'page', id: `pg-${n}`, url: `https://www.notion.so/p${n}`, properties: { Nome: { type: 'title', title: [{ plain_text: `Página ${n}` }] }, id: { type: 'number', number: 100 + n }, url: { type: 'url', url: `https://exemplo.test/${n}` } } });
    const out = shapeConnectorResult('NOTION_QUERY_DATABASE', JSON.stringify({ results: [page(1), page(2)], note: 'x'.repeat(80) }));
    expect(out).toContain('| Nome | id | url | id (página) | url (página) |');
    expect(out).toContain('| Página 1 | 101 | https://exemplo.test/1 | pg-1 | https://www.notion.so/p1 |');
  });
});

describe('Google Calendar', () => {
  /** Tamanho do texto que o modelo lê com a limpeza do Calendar e só com a camada genérica (slug sem conector, o mesmo caminho que um conector sem arquivo segue). */
  const sizes = (fixture: ConnectorFixture) => ({ shaped: shapeConnectorResult(fixture.slug, fixture.stored).length, generic: shapeConnectorResult('', fixture.stored).length });

  /** Os campos de sincronização e de controle que a decisão 19 da spec manda tirar, como o nome que aparece no texto. */
  const syncNoise = ['kind', 'etag', 'iCalUID', 'sequence', 'created', 'updated', 'accessRole', 'defaultReminders', 'nextSyncToken', 'reminders', 'eventType'];

  /** Um evento no envelope bruto do Composio, para variar a regra sem reescrever a fixture. */
  const rawEvent = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ kind: 'calendar#event', etag: '"x"', id: 'evt-raw', status: 'confirmed', summary: 'Evento cru', ...extra });

  it('C1: EVENTS_LIST fica pelo menos 25% menor que só com a camada genérica', () => {
    const { shaped, generic } = sizes(calendarFixture());
    expect(shaped).toBeLessThanOrEqual(generic * 0.75);
  });

  it('EVENTS_LIST: o ruído sai e o id, título, início, fim, status, descrição, local, participantes, anexos e conferência ficam', () => {
    const fixture = calendarFixture();
    const out = shapeConnectorResult(fixture.slug, fixture.stored);
    for (const noise of [...syncNoise, 'creator']) expect(out).not.toContain(noise);
    // O organizador de topo sai (já é participante, com `organizer: true`); a coluna da tabela de participantes não é uma linha `organizer:`.
    expect(out).not.toMatch(/^\s+organizer:/m);
    // As marcas falsas saem; `self` e `optional` verdadeiras ficam, no participante que são.
    expect(out).toContain('| ana@example.test | accepted | true |  |  |  |');
    expect(out).toContain('| carla@projetoexemplo.test | needsAction |  |  | Carla Exemplo | true |');
    expect(out).toContain('| bruno@projetoexemplo.test | accepted |  | true | Bruno Exemplo |  |');
    for (const field of ['id: evt001', 'id: evt004', 'status: confirmed', 'summary: Revisão de orçamento', 'dateTime: 2026-10-13T14:00:00-03:00', 'dateTime: 2026-10-21T15:00:00-03:00', 'location: Restaurante Exemplo', 'description: Rever o orçamento da campanha.', 'entryPointType: video']) {
      expect(out).toContain(field);
    }
    // Anexos: a tabela traz URL, título, tipo e id do arquivo.
    expect(out).toContain('| https://drive.projetoexemplo.test/arquivos/ata-anterior | Ata anterior | application/pdf | f-001 |');
    expect(out).toContain('| https://drive.projetoexemplo.test/arquivos/pauta | Pauta | text/plain | f-002 |');
    // Todas as URLs, inclusive o `htmlLink` de cada evento.
    for (const url of fixture.urls) expect(out).toContain(url);
    const htmlLink = (JSON.parse(fixture.stored) as { items: { htmlLink: string }[] }).items[0]!.htmlLink;
    expect(out).toContain(htmlLink);
  });

  it('o que não é ruído fica: criador ou organizador que não são participantes, lembrete próprio, tipo de evento diferente do padrão, `self` verdadeiro e `kind` que não é do Google', () => {
    const data = {
      kind: 'calendar#events',
      timeZone: 'America/Sao_Paulo',
      items: [
        rawEvent({
          organizer: { email: 'sala-azul@projetoexemplo.test', displayName: 'Sala azul', self: false },
          creator: { email: 'bruno@projetoexemplo.test', self: true },
          attendees: [{ email: 'carla@projetoexemplo.test', responseStatus: 'accepted', self: false, optional: false }],
          reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] },
          eventType: 'outOfOffice',
          hangoutLink: 'https://meet.projetoexemplo.test/xyz-uvwx-rst',
          tipo: { kind: 'categoria-propria' },
        }),
        // Sem participantes, ninguém representa o criador e o organizador: ficam (só as marcas falsas saem).
        rawEvent({ id: 'evt-pessoal', creator: { email: 'ana@example.test', self: true }, organizer: { email: 'ana@example.test', self: true }, reminders: { useDefault: true } }),
      ],
    };
    // O blob base64 vizinho garante que a limpeza encurta o texto (o resultado só vale quando fica menor que o gravado).
    const out = shapeConnectorResult('GOOGLECALENDAR_EVENTS_LIST', JSON.stringify({ ...data, blob: pseudoBase64(600, 3) }));
    expect(out).toContain('email: sala-azul@projetoexemplo.test');
    expect(out).toContain('displayName: Sala azul');
    expect(out).toContain('email: bruno@projetoexemplo.test');
    expect(out).toContain('minutes: 30');
    expect(out).toContain('eventType: outOfOffice');
    expect(out).toContain('hangoutLink: https://meet.projetoexemplo.test/xyz-uvwx-rst');
    expect(out).toContain('kind: categoria-propria');
    expect(out).toMatch(/organizer:\n\s+email: ana@example\.test\n\s+self: true/);
    expect(out).not.toMatch(/self: false|optional: false|useDefault: true|calendar#/);
  });

  it('o criador e o organizador são reconhecidos como participantes mesmo com caixa e espaços diferentes no e-mail', () => {
    const data = { items: [rawEvent({ creator: { email: ' Bruno@ProjetoExemplo.test ' }, organizer: { email: 'BRUNO@projetoexemplo.test' }, attendees: [{ email: 'bruno@projetoexemplo.test', organizer: true, responseStatus: 'accepted' }, { email: 'carla@projetoexemplo.test', responseStatus: 'accepted' }] })] };
    const out = shapeConnectorResult('GOOGLECALENDAR_EVENTS_LIST', JSON.stringify({ ...data, blob: pseudoBase64(600, 3) }));
    expect(out).not.toMatch(/creator|^\s+organizer:/m);
    expect(out).toContain('| bruno@projetoexemplo.test | true | accepted |');
  });

  it('a limpeza não altera o objeto recebido', () => {
    const data = JSON.parse(calendarFixture().stored) as unknown;
    const before = structuredClone(data);
    googleCalendarShaper.shape('GOOGLECALENDAR_EVENTS_LIST', data);
    googleCalendarShaper.shape('GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS', data);
    expect(data).toEqual(before);
    const all = JSON.parse(calendarAllCalendarsFixture().stored) as unknown;
    const allBefore = structuredClone(all);
    googleCalendarShaper.shape('GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS', all);
    expect(all).toEqual(allBefore);
  });

  it('EVENTS_LIST_ALL_CALENDARS: cada calendário aparece uma vez com os eventos dele, sem o id repetido em toda linha, e fica menor que só com a camada genérica', () => {
    const fixture = calendarAllCalendarsFixture();
    const out = shapeConnectorResult(fixture.slug, fixture.stored);
    const { shaped, generic } = sizes(fixture);
    expect(shaped).toBeLessThan(generic);
    const data = JSON.parse(fixture.stored) as { calendars_queried: { id: string; summary: string }[]; summary_view: { calendar: string; title: string }[] };
    expect(out).toContain('calendars (3):');
    expect(out).not.toMatch(/calendars_queried|^\s*\| calendar \|/m);
    for (const calendar of data.calendars_queried) {
      // O id aparece uma vez como `id` (e mais uma quando o nome do calendário é o próprio id): o resumo o repetia em cada linha dos eventos dele.
      expect(out.split(`id: ${calendar.id}`)).toHaveLength(2);
      expect(out).toContain(`summary: ${calendar.summary}`);
      expect(out.split(calendar.id).length - 1).toBe(calendar.summary === calendar.id ? 2 : 1);
    }
    // Cada evento fica sob o calendário dele: o título aparece no bloco certo, na ordem de `calendars_queried`.
    const blocks = out.split(/^ {2}- id: /m).slice(1);
    expect(blocks).toHaveLength(3);
    data.calendars_queried.forEach((calendar, index) => {
      const titles = data.summary_view.filter((row) => row.calendar === calendar.id).map((row) => row.title);
      expect(titles.length).toBeGreaterThan(0);
      for (const title of titles) expect(blocks[index]).toContain(title);
      for (const title of data.summary_view.filter((row) => row.calendar !== calendar.id).map((row) => row.title)) expect(blocks[index]).not.toContain(title);
    });
    // O aviso do Composio (diz como pedir os detalhes que a resposta omitiu) e as URLs ficam.
    expect(out).toContain('composio_execution_message: Minimal response');
    for (const url of fixture.urls) expect(out).toContain(url);
    expect(out).not.toMatch(/errors_by_calendar|^events:/m);
  });

  it('EVENTS_LIST_ALL_CALENDARS: os eventos completos (`events`) passam pela mesma limpeza da lista, e calendário sem evento fica na lista', () => {
    const items = (JSON.parse(calendarFixture().stored) as { items: unknown[] }).items;
    const base = JSON.parse(calendarAllCalendarsFixture().stored) as Record<string, unknown>;
    const full = JSON.stringify({ ...base, events: items, summary_view: [] });
    const out = shapeConnectorResult('GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS', full);
    for (const noise of [...syncNoise, 'creator']) expect(out).not.toContain(noise);
    expect(out).toContain('id: evt003');
    expect(out).toContain('https://drive.projetoexemplo.test/arquivos/ata-anterior');
    expect(out.length).toBeLessThan(shapeConnectorResult('', full).length * 0.8);
    // Sem linhas no resumo nada é agrupado: a lista de calendários consultados segue como veio.
    expect(out).toContain('calendars_queried (3):');
    // Calendário consultado sem evento nenhum fica na lista, só com o id e o nome.
    const grouped = shapeConnectorResult('GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS', JSON.stringify({ ...base, summary_view: (base.summary_view as { calendar: string }[]).filter((row) => !row.calendar.startsWith('family')) }));
    expect(grouped).toContain('summary: Família');
    expect(grouped).not.toContain('Consulta pediátrica');
  });

  it('EVENTS_LIST_ALL_CALENDARS: o agrupamento por calendário só vale para o formato conhecido; calendário só nas linhas entra no fim e um formato diferente fica como veio', () => {
    const fixture = calendarAllCalendarsFixture();
    const base = JSON.parse(fixture.stored) as { calendars_queried: unknown[]; summary_view: Record<string, unknown>[] };
    const run = (data: unknown) => shapeConnectorResult(fixture.slug, JSON.stringify(data));
    // Calendário que só aparece nas linhas (não está em `calendars_queried`): entra no fim, com o id.
    const extra = run({ ...base, summary_view: [...base.summary_view, { ...base.summary_view[0]!, calendar: 'outro@example.test', title: 'Evento em outro calendário' }] });
    expect(extra).toContain('calendars (4):');
    expect(extra.indexOf('id: outro@example.test')).toBeGreaterThan(extra.indexOf('summary: Família'));
    // Linha sem `calendar` em texto, calendário sem `id`, id repetido ou `calendars` já existente: segue só pela limpeza dos eventos, com a estrutura original.
    const rowWithoutCalendar = run({ ...base, summary_view: [...base.summary_view, { title: 'Sem calendário' }] });
    const refWithoutId = run({ ...base, calendars_queried: [...base.calendars_queried, { summary: 'Sem id' }] });
    const repeatedId = run({ ...base, calendars_queried: [...base.calendars_queried, base.calendars_queried[0]] });
    const alreadyThere = run({ ...base, calendars: ['x'] });
    for (const out of [rowWithoutCalendar, refWithoutId, repeatedId, alreadyThere]) {
      expect(out).toContain('summary_view (');
      expect(out).not.toContain('calendars (');
    }
    expect(rowWithoutCalendar).toContain('Sem calendário');
    expect(refWithoutId).toContain('Sem id');
  });

  it('ação do Calendar sem regra própria passa só pela camada genérica, com o ruído que a camada genérica não conhece', () => {
    const fixture = calendarFixture();
    for (const slug of ['GOOGLECALENDAR_EVENTS_GET', 'GOOGLECALENDAR_CREATE_EVENT', 'GOOGLECALENDAR_LIST_CALENDARS']) {
      const out = shapeConnectorResult(slug, fixture.stored);
      expect(out).toBe(shapeConnectorResult('', fixture.stored));
      expect(out).toContain('iCalUID');
    }
    expect(shapeConnectorResult('GOOGLECALENDAR_EVENTS_LIST', fixture.stored)).not.toContain('iCalUID');
  });

  it('o slug é reconhecido em qualquer caixa e sem espaços nas pontas', () => {
    const fixture = calendarFixture();
    expect(shapeConnectorResult(' googlecalendar_events_list ', fixture.stored)).toBe(shapeConnectorResult(fixture.slug, fixture.stored));
  });

  it('formato inesperado nas duas ações: a limpeza devolve o JSON como veio, sem lançar nem crescer', () => {
    const weird: unknown[] = [
      null,
      7,
      'texto',
      [],
      [null, 1, 'x', { attendees: 5, organizer: 7, creator: null, reminders: [], eventType: {}, kind: 3 }],
      { items: 'x', events: { a: 1 }, kind: ['calendar#events'], summary_view: 'x', calendars_queried: 5 },
      { items: [null, [], { attendees: [null, 1, { email: 5 }], creator: { email: 7 }, organizer: [] }] },
      { summary_view: [1, null, { calendar: 3 }, { calendar: '' }], calendars_queried: [{ id: 5 }, null] },
      { summary_view: [{ calendar: 'a', title: 'x' }], calendars_queried: [{ id: 'a', summary_view: 'já existe' }] },
      { summary_view: [], calendars_queried: [] },
    ];
    for (const slug of ['GOOGLECALENDAR_EVENTS_LIST', 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS', 'GOOGLECALENDAR_OUTRA_ACAO']) {
      for (const data of weird) {
        const before = JSON.stringify(data);
        let shaped: unknown;
        expect(() => (shaped = googleCalendarShaper.shape(slug, data))).not.toThrow();
        expect(JSON.stringify(shaped ?? null).length).toBeLessThanOrEqual((before ?? 'null').length);
        expect(JSON.stringify(data)).toBe(before);
        const text = JSON.stringify(data) ?? 'null';
        const out = shapeConnectorResult(slug, text);
        expect(out.length).toBeLessThanOrEqual(text.length);
      }
    }
  });
});

describe('conector sem arquivo próprio: só a camada genérica', () => {
  it('é idêntico ao caminho sem conector e não aplica as regras do Gmail ou do Notion', () => {
    const fixture = calendarFixture();
    expect(shapeConnectorResult('ACME_LIST_EVENTS', fixture.stored)).toBe(shapeConnectorResult('', fixture.stored));
    const mail = gmailMessageFixture();
    expect(shapeConnectorResult('ACME_FETCH_MESSAGE', mail.stored)).toBe(shapeConnectorResult('', mail.stored));
    expect(shapeConnectorResult('ACME_FETCH_MESSAGE', mail.stored)).toContain('Received');
    expect(shapeConnectorResult(mail.slug, mail.stored)).not.toContain('Received');
  });

  it('nulos e vazios saem; HTML vira texto; base64 vira marcador com o tamanho; lista uniforme vira tabela; texto repetido some', () => {
    // Os dados de agenda com um slug sem conector: só a camada genérica os escreve (o `iCalUID` que a regra do Calendar tira continua aqui).
    const fixture = calendarFixture();
    const out = shapeConnectorResult('ACME_LIST_EVENTS', fixture.stored);
    expect(out).toContain('iCalUID');
    expect(out).not.toMatch(/null|nextPageToken|nextSyncToken|location: *$/m);
    expect(out).not.toMatch(/<\/?(div|p|b|ul|li|a)\b|&amp;|&nbsp;/);
    expect(out).toContain('- Andamento\n      - Bloqueios\n      - Próximos passos');
    expect(out).toContain('ata semanal (https://docs.projetoexemplo.test/atas/semanal?visao=ultima&ordem=data)');
    expect(out).toContain('data:image/png;base64,[base64 omitido: 1500 caracteres]');
    expect(out).toMatch(/\| email \| responseStatus \| self \| organizer \| displayName \| optional \|/);
    expect(out.split('Pauta fixa: andamento das entregas').length - 1).toBe(1);
    expect(out).toMatch(/description: \[texto repetido omitido: \d+ caracteres\]/);
  });

  it('tabela: célula com "|" é escapada; texto de várias linhas, lista esparsa, item único e colunas demais ficam em blocos', () => {
    // O blob base64 vizinho garante que a limpeza encurta o texto: a tabela só aparece quando o resultado final é menor que o gravado.
    const rows = (items: Record<string, unknown>[]) => shapeConnectorResult('ACME_LIST', JSON.stringify({ items, blob: pseudoBase64(600, 3) }));
    const escaped = rows([{ nome: 'a|b', valor: 1 }, { nome: 'c', valor: 2 }]);
    expect(escaped).toContain('| nome | valor |');
    expect(escaped).toContain('| a\\|b | 1 |');
    expect(rows([{ nome: 'linha 1\nlinha 2', valor: 1 }, { nome: 'c', valor: 2 }])).not.toContain('| nome |');
    expect(rows([{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }, { e: 5 }])).not.toContain('|---|');
    expect(rows([{ nome: 'único', valor: 1 }])).not.toContain('| nome |');
    const wide = Object.fromEntries(Array.from({ length: 26 }, (_, i) => [`c${i}`, i]));
    expect(rows([wide, wide])).not.toContain('|---|');
  });

  it('URLs saem intactas em todas as formas: campo, célula, link de HTML e base64 vizinho', () => {
    const urls = ['https://exemplo.test/a/b?c=1&d=2#trecho', 'https://exemplo.test/caminho%20com%20espaco/arquivo.pdf?token=AbC123_-', 'http://exemplo.test:8080/x'];
    const html = `<p>Veja <a href="${urls[0]!.replaceAll('&', '&amp;')}">aqui</a> e ${urls[1]}</p><p>Mais em <a href="${urls[2]}">${urls[2]}</a></p>`;
    const data = { campo: urls[0], tabela: [{ url: urls[1], n: 1 }, { url: urls[2], n: 2 }], html, blob: pseudoBase64(400, 5) };
    const out = shapeConnectorResult('ACME_LINKS', JSON.stringify(data) + ' '.repeat(10));
    for (const url of urls) expect(out).toContain(url);
    expect(out.split(urls[2]!).length - 1).toBe(2); // o rótulo que já é a URL não a repete: campo da tabela + link
  });

  it('HTML: remove script, estilo e comentário; decodifica entidades; ignora destino de link que não é http, mailto ou tel', () => {
    const html = '<html><head><style>.a{color:red}</style></head><body><!-- comentário --><script>alert(1)</script><p>Ol&aacute; &ccedil;&atilde;o &amp; mais &#233; &#x41;</p><p><a href="javascript:alert(1)">perigo</a> <a href="mailto:ana@example.test">escreva</a></p><img src="x.png" alt="Logotipo"></body></html>';
    const out = shapeConnectorResult('ACME_HTML', `${html}${' '.repeat(10)}`);
    expect(out).toBe('Olá ção & mais é A\n\nperigo escreva (mailto:ana@example.test)\n\nLogotipo');
  });

  it('entidades são decodificadas uma única vez: `&amp;amp;` vira `&amp;` no href, no alt e no texto comum, nunca `&copy;` nem `©`', () => {
    const html = '<p>Texto &amp;amp;copy; comum e &amp;lt;b&amp;gt;</p><p><a href="https://exemplo.test/a?a=1&amp;amp;copy;=2">aqui</a></p><img src="x.png" alt="Ajuste &amp;amp;copy; aqui">';
    const expected = 'Texto &amp;copy; comum e &lt;b&gt;\n\naqui (https://exemplo.test/a?a=1&amp;copy;=2)\n\nAjuste &amp;copy; aqui';
    const padding = ' '.repeat(80);
    // HTML solto (texto cru) e HTML dentro de um campo de JSON seguem o mesmo caminho de limpeza.
    expect(shapeConnectorResult('ACME_HTML', `${html}${padding}`)).toBe(expected);
    const inJson = shapeConnectorResult('ACME_HTML', JSON.stringify({ corpo: html, padding }));
    for (const line of expected.split('\n').filter((text) => text !== '')) expect(inJson).toContain(`  ${line}`);
    expect(inJson).not.toMatch(/©|&copy;/);
    // Uma decodificação só continua valendo para a entidade simples: `&amp;` em href, alt e texto vira `&`.
    expect(shapeConnectorResult('ACME_HTML', `<p>A &amp; B</p><p><a href="https://exemplo.test/a?x=1&amp;y=2">aqui</a></p><img src="x.png" alt="C &amp; D">${padding}`)).toBe('A & B\n\naqui (https://exemplo.test/a?x=1&y=2)\n\nC & D');
  });

  it('texto cru (não JSON): HTML, base64 inteiro e espaços sobrando passam só pela limpeza de texto', () => {
    expect(shapeConnectorResult('ACME_X', 'linha 1   \n\n\n\n\nlinha 2\u200b')).toBe('linha 1\n\nlinha 2');
    expect(shapeConnectorResult('ACME_X', '<div><p>Primeiro</p><p>Segundo</p></div>')).toBe('Primeiro\n\nSegundo');
    const blob = pseudoBase64(500, 9);
    expect(shapeConnectorResult('ACME_X', blob)).toBe('[base64 omitido: 500 caracteres]');
    expect(shapeConnectorResult('ACME_X', `${blob.slice(0, 250)}\n${blob.slice(250)}`)).toBe('[base64 omitido: 500 caracteres]');
    // Um texto corrido só com letras e espaços não é binário.
    const prose = 'palavra '.repeat(60);
    expect(shapeConnectorResult('ACME_X', `${prose}fim`)).toContain('palavra palavra');
  });

  it('inteiros de 16 dígitos ou mais mantêm todos os dígitos (um id não pode mudar na leitura do JSON)', () => {
    const out = shapeConnectorResult('ACME_IDS', `{"id":1234567890123456789,"outro":-9007199254740993,"pequeno":42,"nota":"${'texto '.repeat(30)}"}`);
    expect(out).toContain('id: 1234567890123456789');
    expect(out).toContain('outro: -9007199254740993');
    expect(out).toContain('pequeno: 42');
  });

  it('listas curtas de textos ficam numa linha e false e 0 são dados que ficam', () => {
    const out = shapeConnectorResult('ACME_X', JSON.stringify({ tags: ['a', 'b', 'c'], ativo: false, total: 0, vazio: '', nulo: null, lista: [], objeto: {}, preenchimento: 'x'.repeat(60) }));
    expect(out).toContain('tags: a, b, c');
    expect(out).toContain('ativo: false');
    expect(out).toContain('total: 0');
    expect(out).not.toMatch(/vazio|nulo|lista|objeto/);
  });
});

describe('contrato: nunca lança e nunca devolve mais que o texto gravado', () => {
  const huge = (size: number, fill: string): string => fill.repeat(size);
  const inputs: [string, string][] = [
    ['vazio', ''],
    ['só espaços', '   \n  '],
    ['null', 'null'],
    ['verdadeiro', 'true'],
    ['número', '0'],
    ['lista vazia', '[]'],
    ['objeto vazio', '{}'],
    ['só nulos', '{"a":null,"b":[],"c":{"d":""}}'],
    ['texto entre aspas', '"só um texto"'],
    ['objeto aberto', '{'],
    ['lista aberta', '[1,'],
    ['JSON truncado pela gravação', `{"messages":[{"messageText":"${'abc '.repeat(100)}`],
    ['texto livre', 'resultado em texto livre sem nenhuma estrutura'],
    ['caractere de controle', '\u0000\u0001'],
    ['aninhamento extremo', `${'['.repeat(50_000)}${']'.repeat(50_000)}`],
    ['aninhamento extremo de objetos', `${'{"a":'.repeat(20_000)}1${'}'.repeat(20_000)}`],
    ['chave __proto__', '{"__proto__":{"polluted":true},"texto":"' + 'y'.repeat(60) + '"}'],
    ['Gmail estranho', '{"messages":5,"message":{"payload":"x","preview":7},"headers":[null,1,{"name":5}]}'],
    ['Gmail lote estranho', '{"messageIds":[1,null,{"a":2},1,2,3,4,5],"ids":"x","message_ids":5,"messages":[null]}'],
    ['Gmail messageText estranho', `{"messages":[{"messageText":5,"to":7,"messageTimestamp":{},"payload":{"headers":[{"name":"To","value":9},{"name":"Date"}]}},{"messageText":"${'z '.repeat(5000)}"}]}`],
    ['Gmail com listas erradas', '{"messages":[null,1,"x",{"payload":{"headers":[{"name":1,"value":null}],"parts":"x"},"preview":{"subject":3,"body":[]}}]}'],
    ['Notion estranho', '{"results":[{"object":"page","properties":{"a":null,"b":{"type":"select","select":null},"c":{"type":"rollup","rollup":{"type":"array","array":[1,null,{"type":"title","title":[]}]}},"d":{"type":"title","title":[{"plain_text":"T"}]},"e":{"type":"coisa_nova","coisa_nova":{"x":1}}}}]}'],
    ['esquema de página sem propriedades', '{"results":[{"object":"page","properties":[1,2]},{"properties":{"x":{"type":"title","title":"não é lista"}}}]}'],
    ['Calendar estranho', '{"items":[null,1,"x",{"attendees":5,"organizer":7,"creator":null,"reminders":[],"eventType":{}}],"events":"x","kind":3}'],
    ['Calendar com listas erradas', '{"items":[[],{"attendees":[null,1,{"email":5}],"creator":{"email":7},"organizer":[]}],"summary_view":[1,null,{"calendar":3}],"calendars_queried":[{"id":5},null]}'],
  ];

  it.each(inputs)('entrada %s: texto de volta, sem exceção e sem crescer', (_name, text) => {
    for (const slug of ['GMAIL_FETCH_EMAILS', 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', 'GMAIL_LIST_MESSAGES', 'GMAIL_BATCH_MODIFY_MESSAGES', 'NOTION_QUERY_DATABASE', 'GOOGLECALENDAR_EVENTS_LIST', 'GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS', 'ACME_X', '']) {
      const out = shapeConnectorResult(slug, text);
      expect(typeof out).toBe('string');
      expect(out.length).toBeLessThanOrEqual(text.length);
    }
  });

  it('entradas que não são texto ou slugs que não são texto não lançam', () => {
    const weird = [undefined, null, 42, {}, []] as unknown as string[];
    for (const value of weird) {
      expect(() => shapeConnectorResult('GMAIL_FETCH_EMAILS', value as string)).not.toThrow();
      expect(() => shapeConnectorResult(value as string, '{"a":1}')).not.toThrow();
    }
    expect(shapeConnectorResult(undefined as unknown as string, calendarFixture().stored)).toBe(shapeConnectorResult('', calendarFixture().stored));
  });

  it('resultado só de nulos e vazios devolve o texto gravado, nunca um resultado em branco', () => {
    expect(shapeConnectorResult('ACME_X', '{"a":null,"b":[],"c":{"d":""}}')).toBe('{"a":null,"b":[],"c":{"d":""}}');
    expect(shapeConnectorResult('ACME_X', 'null')).toBe('null');
  });

  it('JSON que a limpeza não encurta volta como estava', () => {
    // Uma lista uniforme minúscula em tabela markdown ficaria maior que o JSON gravado.
    expect(shapeConnectorResult('ACME_X', '[{"a":1},{"a":2}]')).toBe('[{"a":1},{"a":2}]');
  });

  it('regra do conector que lança segue só pela camada genérica, sem perder o texto', () => {
    const fixture = gmailListFixture();
    const normal = shapeConnectorResult(fixture.slug, fixture.stored);
    vi.spyOn(gmailShaper, 'shape').mockImplementation(() => {
      throw new Error('formato inesperado');
    });
    const fallback = shapeConnectorResult(fixture.slug, fixture.stored);
    expect(fallback).toBe(shapeConnectorResult('', fixture.stored));
    expect(fallback.length).toBeGreaterThan(normal.length);
    expect(fallback).toContain('Confirmando a reunião de planejamento do trimestre na quinta-feira às 14h');
    expect(fallback.length).toBeLessThan(fixture.stored.length);
  });

  it('entradas enormes terminam rápido (sem retrocesso nem laço quadrático)', () => {
    const cases: string[] = [
      huge(300_000, ' '),
      huge(300_000, '\n'),
      `[${Array.from({ length: 20_000 }, (_, i) => `{"id":${i},"nome":"item ${i}","valor":${i * 3}}`).join(',')}]`,
      `{"html":"${'<a href=\\"https://x.test/\\">'.repeat(30_000)}fim${'</a>'.repeat(30_000)}"}`,
      `{"html":"${'<div>'.repeat(40_000)}texto"}`,
      `{"html":"<div>${'<style>'.repeat(40_000)}"}`,
      `{"t":"${'<!--'.repeat(40_000)}"}`,
      `{"lista":[${Array.from({ length: 400 }, (_, i) => `"${`texto longo número ${i} `.repeat(15)}"`).join(',')}]}`,
      `{"a":"${'&amp;'.repeat(50_000)}"}`,
    ];
    for (const text of cases) {
      const started = performance.now();
      const out = shapeConnectorResult('GMAIL_FETCH_EMAILS', text);
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(out.length).toBeLessThanOrEqual(text.length);
    }
  });
});

// @vitest-environment jsdom
// Prova da página do doc e dos componentes de doc (phase 14, passo 5; A8, A11, A15, A17, A18, A19, A20) com o DOM real (jsdom, o mesmo ambiente do editor do passo 1) e a
// API trocada por um servidor FALSO em memória na fronteira `fetch`: o `apiFetch` e o cliente `api.ts` rodam de verdade, então CSRF, `operationId`, o envelope de erro e os
// caminhos também são provados. O servidor falso aplica as mesmas regras dos schemas de `@aion/shared` e recusa escrita sem CSRF ou sem `operationId`.
//
// Cada caso sai do critério e observa o que o dono vê e o que o servidor guardou:
// - A19: na leitura HTML e imagem não são interpretados e o link abre com `noopener`.
// - A18 e A17: o editor mostra o GFM formatado, "Ver Markdown" mostra o texto cru, que o dono edita e salva; alternar SEM digitar não é alteração e Salvar não chama a API.
// - A11: o bot grava a versão 4 enquanto o dono edita na 3; ao salvar, a tela mostra o conflito, o texto digitado continua na tela e a versão 4 segue gravada.
// - A8: título vazio e de 121 caracteres e texto de 100.001 mostram a mensagem sem enviar nada; 120 e 100.000 gravam; a recusa do servidor também aparece.
// - A20: "Baixar .md" entrega o texto gravado; A15: restaurar cria uma versão nova com o texto da escolhida e mantém as posteriores.
// Compartilhar, Novo doc, Excluir e a nota da tela de regras fecham o que o passo entrega.
import { DOC_LIMITS, countChars, docCreateRequestSchema, docDeleteSchema, docRestoreSchema, docShareSchema, docUpdateSchema, type SessionInfo } from '@aion/shared';
import { StrictMode, act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InternalCategoryNote } from '@/components/approvals/rules-view';
import { SessionProvider } from '@/lib/session-context';
import { DocView } from './doc-view';
import { NewDocDialog } from './new-doc';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// O jsdom não mede layout. O cartão de bloco de código (`CodeBlock`) observa o tamanho do cabeçalho e o ProseMirror pede a posição do cursor ao rolar até ele depois de uma
// digitação: sem estes dois substitutos o ambiente, e não o código, derrubaria os casos. Eles só existem neste arquivo de teste.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
const EMPTY_RECT = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => EMPTY_RECT as DOMRect;

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/artefatos/docs/x' }));

const SESSION: SessionInfo = { owner: { email: 'dono@example.com' }, sessionId: '5b1f9c0e-3c1d-4f6e-8a7b-2d4e6f8a0b1c', csrfToken: 'csrf-token-de-teste' };
const DOC_ID = '2c9d1a3e-6f1b-4d5a-9a53-0a6f0a1b2c3d';
const BOT_ANA = { id: '11111111-1111-4111-8111-111111111111', name: 'Ana', color: '#60A5FA', archivedAt: null, runState: 'idle', unread: false, preview: 'Sem novidades' };
const BOT_BETO = { id: '22222222-2222-4222-8222-222222222222', name: 'Beto', color: '#4ADE80', archivedAt: null, runState: 'idle', unread: false, preview: 'Sem novidades' };
const BOT_OLD = { id: '33333333-3333-4333-8333-333333333333', name: 'Arquivado', color: '#9CA3AF', archivedAt: '2026-10-01T10:00:00.000Z', runState: 'idle', unread: false, preview: 'Sem novidades' };

/** Texto fora da forma canônica do editor (marcador `*`, linha `***`, tabela alinhada): só o atalho de "sem alteração" o devolve intacto. */
const NON_CANONICAL = ['# Plano', '', '* item um', '* item dois', '', '***', '', '| Nome | Idade |', '| ---- | ----- |', '| Ana  | 30    |', ''].join('\n');

/** Um elemento de cada tipo do conjunto GFM (decisão 6) para o editor visual mostrar formatado (A18). */
const GFM_TEXT = [
  '# Título',
  '',
  'Parágrafo com **negrito**, *itálico*, ~~tachado~~ e [um link](https://example.com).',
  '',
  '- item um',
  '- item dois',
  '',
  '1. primeiro',
  '2. segundo',
  '',
  '- [ ] tarefa aberta',
  '- [x] tarefa feita',
  '',
  '> citação',
  '',
  '```ts',
  'const a = 1;',
  '```',
  '',
  '| Nome | Idade |',
  '| - | - |',
  '| Ana | 30 |',
  '',
  '---',
  '',
].join('\n');

/** A19: HTML com `<script>` e `<img onerror>`, imagem em Markdown e link. */
const UNSAFE_TEXT = [
  'Texto com <script>alert(1)</script> embutido e **negrito**.',
  '',
  '<img src="https://evil.example/pixel.png" onerror="alert(1)">',
  '',
  '![imagem](https://evil.example/x.png "legenda")',
  '',
  '[link seguro](https://example.com)',
  '',
].join('\n');

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Servidor falso: a API de docs e a lista de bots, com as regras do contrato
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

interface StoredVersion {
  version: number;
  author: 'owner' | 'bot';
  content: string;
  createdAt: string;
  restoredFrom: number | null;
}

interface StoredDoc {
  id: string;
  title: string;
  content: string;
  version: number;
  accessVersion: number;
  botIds: string[];
  updatedBy: 'owner' | 'bot';
  versions: StoredVersion[];
  deleted: boolean;
}

interface Call {
  method: string;
  path: string;
  body: unknown;
  csrf: string | null;
}

/** O doc começa na versão 3 (dono), com a 2 do bot e a 1 do dono, para cobrir lista, restauração e conflito. */
function makeServer(content = NON_CANONICAL) {
  const doc: StoredDoc = {
    id: DOC_ID,
    title: 'Plano',
    content,
    version: 3,
    accessVersion: 2,
    botIds: [BOT_ANA.id],
    updatedBy: 'owner',
    deleted: false,
    versions: [
      { version: 1, author: 'owner', content: 'Primeira versão\n', createdAt: '2026-10-20T10:00:00.000Z', restoredFrom: null },
      { version: 2, author: 'bot', content: 'Segunda versão, do bot\n', createdAt: '2026-10-21T10:00:00.000Z', restoredFrom: null },
      { version: 3, author: 'owner', content, createdAt: '2026-10-22T10:00:00.000Z', restoredFrom: null },
    ],
  };
  const calls: Call[] = [];
  /** Docs que já existem para a criação (o 101.º é recusado). */
  const created = { count: 0, limit: DOC_LIMITS.docs };
  /** A próxima escrita responde esta recusa em vez de gravar (corrida com outra regra do servidor). */
  const refuse: { next: { status: number; code: string; message: string } | null } = { next: null };

  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fail = (status: number, code: string, message: string) => reply(status, { code, message });
  const summary = () => ({
    id: doc.id,
    title: doc.title,
    version: doc.version,
    accessVersion: doc.accessVersion,
    size: countChars(doc.content),
    botIds: doc.botIds,
    updatedBy: doc.updatedBy,
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-22T10:00:00.000Z',
  });
  const push = (author: 'owner' | 'bot', next: string, restoredFrom: number | null) => {
    doc.version += 1;
    doc.content = next;
    doc.updatedBy = author;
    doc.versions.push({ version: doc.version, author, content: next, createdAt: '2026-10-23T10:00:00.000Z', restoredFrom });
  };

  async function handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const csrf = headers['x-csrf-token'] ?? null;
    calls.push({ method, path: url.pathname, body, csrf });

    if (method !== 'GET') {
      // Toda escrita leva o CSRF da sessão e uma `operationId`; sem isso a API real recusaria.
      if (csrf !== SESSION.csrfToken) return fail(403, 'CSRF_TOKEN_INVALID', 'Token de segurança inválido. Recarregue a página.');
      if (refuse.next) {
        const { status, code, message } = refuse.next;
        refuse.next = null;
        return fail(status, code, message);
      }
    }
    if (url.pathname === '/api/bots') return reply(200, { bots: [BOT_ANA, BOT_BETO, BOT_OLD] });
    if (url.pathname === '/api/docs' && method === 'POST') {
      const parsed = docCreateRequestSchema.safeParse(body);
      if (!parsed.success) return fail(400, 'VALIDATION_FAILED', 'Dados inválidos.');
      if (created.count >= created.limit) return fail(409, 'DOC_LIMIT_EXCEEDED', 'O limite de 100 docs foi atingido.');
      created.count += 1;
      return reply(201, { ...summary(), id: '4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d', title: parsed.data.title, botIds: parsed.data.botIds, version: 1, size: 0 });
    }
    const match = /^\/api\/docs\/([^/]+)(?:\/(versions|restore|access)(?:\/(\d+))?)?$/.exec(url.pathname);
    if (!match || match[1] !== DOC_ID || doc.deleted) return fail(404, 'DOC_NOT_FOUND', 'Doc não encontrado.');
    const [, , sub, number] = match;

    if (method === 'GET' && !sub) return reply(200, { ...summary(), content: doc.content });
    if (method === 'GET' && sub === 'versions' && !number) {
      const versions = [...doc.versions].reverse().map(({ content: text, ...rest }) => ({ ...rest, size: countChars(text) }));
      return reply(200, { versions });
    }
    if (method === 'GET' && sub === 'versions' && number) {
      const found = doc.versions.find((item) => item.version === Number(number));
      return found ? reply(200, { ...found, size: countChars(found.content) }) : fail(404, 'DOC_VERSION_NOT_FOUND', 'Versão do doc não encontrada.');
    }
    if (method === 'PATCH' && !sub) {
      const parsed = docUpdateSchema.safeParse(body);
      if (!parsed.success) return fail(400, 'VALIDATION_FAILED', 'Dados inválidos.');
      const { expectedVersion, title, edit } = parsed.data;
      if (expectedVersion !== doc.version) return fail(409, 'DOC_CONFLICT', 'O doc mudou. Recarregue antes de salvar.');
      if (edit?.operation === 'rewrite' && countChars(edit.content) > DOC_LIMITS.contentChars) return fail(422, 'DOC_TOO_LARGE', 'O doc passou de 100.000 caracteres.');
      if (title !== undefined) doc.title = title;
      const changed = edit?.operation === 'rewrite' && edit.content !== doc.content;
      if (changed) push('owner', edit.content, null);
      return reply(200, { doc: summary(), changed });
    }
    if (method === 'POST' && sub === 'restore') {
      const parsed = docRestoreSchema.safeParse(body);
      if (!parsed.success) return fail(400, 'VALIDATION_FAILED', 'Dados inválidos.');
      if (parsed.data.expectedVersion !== doc.version) return fail(409, 'DOC_CONFLICT', 'O doc mudou. Recarregue antes de salvar.');
      const source = doc.versions.find((item) => item.version === parsed.data.version);
      if (!source) return fail(404, 'DOC_VERSION_NOT_FOUND', 'Versão do doc não encontrada.');
      const changed = source.content !== doc.content;
      if (changed) push('owner', source.content, source.version);
      return reply(200, { doc: summary(), changed });
    }
    if (method === 'PUT' && sub === 'access') {
      const parsed = docShareSchema.safeParse(body);
      if (!parsed.success) return fail(400, 'VALIDATION_FAILED', 'Dados inválidos.');
      if (parsed.data.expectedAccessVersion !== doc.accessVersion) return fail(409, 'DOC_CONFLICT', 'O doc mudou. Recarregue antes de salvar.');
      doc.botIds = parsed.data.botIds;
      doc.accessVersion += 1;
      return reply(200, summary());
    }
    if (method === 'DELETE' && !sub) {
      if (!docDeleteSchema.safeParse(body).success) return fail(400, 'VALIDATION_FAILED', 'Dados inválidos.');
      doc.deleted = true;
      return reply(200, { id: doc.id, deleted: true });
    }
    return fail(404, 'NOT_FOUND', 'Não encontrado.');
  }

  return {
    doc,
    calls,
    created,
    refuse,
    handle,
    /** O bot grava a próxima versão enquanto o dono edita (sem passar pelas chamadas do dono). */
    botWrites: (next: string) => push('bot', next, null),
    writes: () => calls.filter((call) => call.method !== 'GET'),
    patches: () => calls.filter((call) => call.method === 'PATCH'),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Montagem e gestos
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

const mounted: Array<{ root: ReturnType<typeof createRoot>; container: HTMLElement }> = [];

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  router.push.mockReset();
  router.replace.mockReset();
});

let server = makeServer();
beforeEach(() => {
  server = makeServer();
  vi.stubGlobal('fetch', vi.fn(server.handle));
});

/** Renderiza dentro da sessão (CSRF) e devolve o contêiner; o que abre em portal (drawer, modal) fica em `document.body`. */
async function mount(ui: ReactElement, { strict = false } = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const tree = <SessionProvider session={SESSION}>{ui}</SessionProvider>;
  await act(async () => root.render(strict ? <StrictMode>{tree}</StrictMode> : tree));
  return container;
}

/** Espera uma condição com a árvore em `act`, para os efeitos e as respostas da API assentarem. */
const eventually = (check: () => void) =>
  act(async () => {
    await vi.waitFor(check, { timeout: 4000, interval: 20 });
  });

const doNow = (action: () => void) => act(async () => action());

/** O botão pelo nome visível (ou o texto só para leitor de tela, nos botões de ícone). Procura no documento inteiro, inclusive em portais. */
function button(name: string, within: ParentNode = document.body): HTMLButtonElement {
  const found = [...within.querySelectorAll('button')].find((item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name);
  if (!found) throw new Error(`Botão "${name}" não encontrado. Botões: ${[...within.querySelectorAll('button')].map((item) => item.textContent?.trim()).join(' | ')}`);
  return found;
}

const click = (element: HTMLElement) => doNow(() => element.click());

/** Troca o valor de um campo controlado pelo React, como a digitação faz. */
function write(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  return doNow(() => element.dispatchEvent(new Event('input', { bubbles: true })));
}

const titleInput = () => document.body.querySelector<HTMLInputElement>('input[aria-label="Título do doc"]')!;
const markdownField = () => document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="Texto do doc em Markdown"]')!;
const alerts = () => [...document.body.querySelectorAll('[role="alert"]')].map((item) => item.textContent ?? '');

/** Abre a página do doc e espera o título carregado. */
async function openDoc(options?: { strict?: boolean }) {
  const container = await mount(<DocView docId={DOC_ID} />, options);
  await eventually(() => expect(container.querySelector('h1')?.textContent).toBe(server.doc.title));
  return container;
}

/** Entra no editor e espera o campo visual pronto. */
async function startEditing(container: HTMLElement) {
  await click(button('Editar'));
  await eventually(() => expect(container.querySelector('[data-ready="true"]')).not.toBeNull());
}

describe('A19: leitura formatada do doc', () => {
  it('HTML e imagem não são interpretados e o link abre com noopener, na leitura', async () => {
    server = makeServer(UNSAFE_TEXT);
    vi.stubGlobal('fetch', vi.fn(server.handle));
    const container = await openDoc();
    const article = container.querySelector('article')!;
    expect(article.querySelector('strong')?.textContent).toBe('negrito');
    expect(article.querySelector('script')).toBeNull();
    expect(article.querySelector('img')).toBeNull();
    for (const element of article.querySelectorAll('*')) {
      expect(element.hasAttribute('onerror'), element.outerHTML).toBe(false);
      expect(element.hasAttribute('src'), element.outerHTML).toBe(false);
    }
    const links = [...article.querySelectorAll('a')];
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('rel')).toContain('noopener');
    expect(links[0]?.getAttribute('target')).toBe('_blank');
  });

  it('um doc vazio mostra o convite a escrever, e Escrever abre o editor', async () => {
    server = makeServer('');
    vi.stubGlobal('fetch', vi.fn(server.handle));
    const container = await openDoc();
    expect(container.textContent).toContain('Este doc ainda está vazio.');
    await click(button('Escrever'));
    await eventually(() => expect(container.querySelector('[data-ready="true"]')).not.toBeNull());
    expect(button('Salvar').disabled).toBe(true);
  });

  it('doc inexistente mostra a mensagem e falha de rede oferece tentar de novo', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
    const container = await mount(<DocView docId={DOC_ID} />);
    await eventually(() => expect(container.textContent).toContain('Sem conexão com o servidor.'));
    vi.stubGlobal('fetch', vi.fn(server.handle));
    await click(button('Tentar novamente'));
    await eventually(() => expect(container.querySelector('h1')?.textContent).toBe('Plano'));

    server.doc.deleted = true;
    await mount(<DocView docId={DOC_ID} />);
    await eventually(() => expect(document.body.textContent).toContain('Doc não encontrado.'));
  });
});

describe('A18 e A17: editor visual e "Ver Markdown"', () => {
  it('o editor mostra cada elemento do GFM formatado e "Ver Markdown" mostra o texto cru, que o dono edita e salva', async () => {
    server = makeServer(GFM_TEXT);
    vi.stubGlobal('fetch', vi.fn(server.handle));
    const container = await openDoc();
    await startEditing(container);
    const field = container.querySelector('.ProseMirror')!;
    for (const selector of ['h1', 'strong', 'em', 'del', 'ul > li', 'ol > li', 'li[data-item-type="task"]', 'a', 'blockquote', 'pre', 'table', 'hr']) {
      expect(field.querySelector(selector), selector).not.toBeNull();
    }

    await click(button('Ver Markdown'));
    expect(markdownField().value).toBe(GFM_TEXT);
    expect(container.querySelector('.ProseMirror')).toBeNull();

    const edited = `${GFM_TEXT}\nAcrescentado no texto cru.\n`;
    await write(markdownField(), edited);
    expect(button('Salvar').disabled).toBe(false);
    await click(button('Salvar'));
    await eventually(() => expect(server.doc.content).toBe(edited));
    expect(server.patches()).toHaveLength(1);
    expect(server.patches()[0]?.body).toMatchObject({ expectedVersion: 3, edit: { operation: 'rewrite', content: edited } });
    expect(server.patches()[0]?.csrf).toBe(SESSION.csrfToken);
    await eventually(() => expect(container.querySelector('article')?.textContent).toContain('Acrescentado no texto cru.'));
  });

  it('alternar "Ver Markdown" e voltar sem digitar não conta como alteração: Salvar fica desabilitado, nada é enviado e Cancelar não pergunta', async () => {
    const container = await openDoc();
    await startEditing(container);
    expect(button('Salvar').disabled).toBe(true);

    await click(button('Ver Markdown'));
    expect(markdownField().value).toBe(NON_CANONICAL);
    expect(button('Salvar').disabled).toBe(true);

    await click(button('Ver Markdown'));
    await eventually(() => expect(container.querySelector('[data-ready="true"]')).not.toBeNull());
    expect(container.querySelector('.ProseMirror')).not.toBeNull();
    expect(button('Salvar').disabled).toBe(true);

    await click(button('Cancelar'));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('article')).not.toBeNull();
    expect(server.writes()).toHaveLength(0);
    expect(server.doc.content).toBe(NON_CANONICAL);
  });

  it('o texto cru editado e levado de volta ao editor visual segue alteração e é salvo exatamente como está (sem normalizar)', async () => {
    const container = await openDoc();
    await startEditing(container);
    await click(button('Ver Markdown'));
    const raw = `${NON_CANONICAL}* outro item com asterisco\n`;
    await write(markdownField(), raw);
    await click(button('Ver Markdown'));
    await eventually(() => expect(container.querySelector('[data-ready="true"]')).not.toBeNull());
    expect(button('Salvar').disabled).toBe(false);
    await click(button('Salvar'));
    await eventually(() => expect(server.doc.content).toBe(raw));
    expect(server.patches()).toHaveLength(1);
  });

  it('só o título muda: renomeia sem criar versão de texto', async () => {
    const container = await openDoc();
    await startEditing(container);
    await write(titleInput(), '  Plano de 2027 ');
    await click(button('Salvar'));
    await eventually(() => expect(container.querySelector('h1')?.textContent).toBe('Plano de 2027'));
    expect(server.patches()[0]?.body).toEqual({ expectedVersion: 3, title: 'Plano de 2027', operationId: expect.any(String) });
    expect(server.doc.version).toBe(3);
    expect(server.doc.content).toBe(NON_CANONICAL);
  });

  it('Cancelar com alteração pergunta antes de descartar; Continuar editando mantém o texto e Descartar volta à leitura sem gravar', async () => {
    const container = await openDoc();
    await startEditing(container);
    await click(button('Ver Markdown'));
    await write(markdownField(), 'Texto que o dono digitou\n');

    await click(button('Cancelar'));
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Descartar alterações?');
    await click(button('Continuar editando'));
    expect(markdownField().value).toBe('Texto que o dono digitou\n');

    await click(button('Cancelar'));
    await click(button('Descartar alterações'));
    await eventually(() => expect(container.querySelector('article')?.textContent).toContain('item um'));
    expect(server.writes()).toHaveLength(0);
  });

  it('o foco do teclado vai ao título ao começar a editar e volta ao botão Editar ao sair, sem se perder no corpo da página', async () => {
    const container = await openDoc();
    await startEditing(container);
    expect(document.activeElement).toBe(titleInput());
    await click(button('Cancelar'));
    expect(document.activeElement).toBe(button('Editar'));
  });

  it('monta o editor uma única vez em StrictMode', async () => {
    const container = await openDoc({ strict: true });
    await startEditing(container);
    expect(container.querySelectorAll('.ProseMirror')).toHaveLength(1);
  });
});

describe('A11: conflito de versão mantém o texto digitado', () => {
  it('o bot grava a versão 4 enquanto o dono edita a 3: ao salvar, a tela mostra o conflito, o texto continua e a versão 4 segue gravada', async () => {
    const container = await openDoc();
    await startEditing(container);
    await click(button('Ver Markdown'));
    const typed = 'Texto do dono, escrito sobre a versão 3\n';
    await write(markdownField(), typed);

    server.botWrites('Texto que o bot gravou na versão 4\n');
    await click(button('Salvar'));

    await eventually(() => expect(alerts().join(' ')).toContain('O doc mudou enquanto você editava'));
    expect(markdownField().value).toBe(typed);
    expect(server.patches()).toHaveLength(1);
    expect(server.patches()[0]?.body).toMatchObject({ expectedVersion: 3 });
    expect(server.doc.version).toBe(4);
    expect(server.doc.content).toBe('Texto que o bot gravou na versão 4\n');
    expect(server.doc.versions).toHaveLength(4);
    // Com o conflito aberto não dá para repetir a mesma gravação sobre a versão velha.
    expect(button('Salvar').disabled).toBe(true);
  });

  it('o mesmo vale no editor visual: o texto digitado continua no campo depois do conflito', async () => {
    const container = await openDoc();
    await startEditing(container);
    // A digitação do dono no ProseMirror: o nó de texto muda e o editor lê a mutação do DOM.
    const paragraph = container.querySelector('.ProseMirror li p, .ProseMirror p')!;
    const text = [...paragraph.childNodes].find((node): node is Text => node.nodeType === Node.TEXT_NODE)!;
    await doNow(() => {
      text.data = `${text.data} DIGITADO PELO DONO`;
      const range = document.createRange();
      range.setStart(text, text.data.length);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await eventually(() => expect(button('Salvar').disabled).toBe(false));

    server.botWrites('Versão do bot\n');
    await click(button('Salvar'));
    await eventually(() => expect(alerts().join(' ')).toContain('O doc mudou enquanto você editava'));
    expect(container.querySelector('.ProseMirror')?.textContent).toContain('DIGITADO PELO DONO');
    expect(server.doc.content).toBe('Versão do bot\n');
  });

  it('Copiar meu texto leva o texto digitado e Descartar e carregar a versão atual mostra a do bot, sem gravar nada', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const container = await openDoc();
    await startEditing(container);
    await click(button('Ver Markdown'));
    await write(markdownField(), 'Meu texto\n');
    server.botWrites('Versão do bot\n');
    await click(button('Salvar'));
    await eventually(() => expect(alerts().join(' ')).toContain('O doc mudou'));

    await click(button('Copiar meu texto'));
    expect(writeText).toHaveBeenCalledWith('Meu texto\n');

    await click(button('Descartar e carregar a versão atual'));
    await eventually(() => expect(container.querySelector('article')?.textContent).toContain('Versão do bot'));
    expect(server.doc.versions).toHaveLength(4);
    expect(alerts()).toEqual([]);
  });

  it('o doc excluído enquanto o dono editava avisa que sumiu e mantém o texto na tela', async () => {
    const container = await openDoc();
    await startEditing(container);
    await click(button('Ver Markdown'));
    await write(markdownField(), 'Meu texto\n');
    server.doc.deleted = true;
    await click(button('Salvar'));
    await eventually(() => expect(alerts().join(' ')).toContain('Este doc não existe mais'));
    expect(markdownField().value).toBe('Meu texto\n');
  });
});

describe('A8: recusa mostra a mensagem e nada é gravado; os limites gravam', () => {
  it.each([
    ['título vazio', '', 'Dê um título ao doc.'],
    ['título de 121 caracteres', 'a'.repeat(121), 'O título passou de 120 caracteres.'],
  ])('%s', async (_name, title, message) => {
    const container = await openDoc();
    await startEditing(container);
    await write(titleInput(), title);
    await click(button('Salvar'));
    expect(alerts()).toContain(message);
    expect(titleInput().getAttribute('aria-invalid')).toBe('true');
    expect(server.writes()).toHaveLength(0);
    expect(container.querySelector('[data-ready="true"]')).not.toBeNull();
  });

  it('texto de 100.001 caracteres mostra a mensagem junto do contador, desabilita Salvar e não envia nada', async () => {
    const container = await openDoc();
    await startEditing(container);
    await click(button('Ver Markdown'));
    await write(markdownField(), 'a'.repeat(DOC_LIMITS.contentChars + 1));
    expect(alerts().join(' ')).toContain('O texto passou de 100.000 caracteres (100.001).');
    expect(container.textContent).toContain('100.001 / 100.000');
    expect(button('Salvar').disabled).toBe(true);
    expect(server.writes()).toHaveLength(0);
    // Voltar ao limite libera o Salvar.
    await write(markdownField(), 'a'.repeat(DOC_LIMITS.contentChars));
    expect(alerts()).toEqual([]);
    expect(button('Salvar').disabled).toBe(false);
  });

  it('o texto de 100.001 caracteres levado ao editor visual também é recusado ao salvar, com a mensagem e sem enviar nada', async () => {
    const container = await openDoc();
    await startEditing(container);
    await click(button('Ver Markdown'));
    await write(markdownField(), 'a'.repeat(DOC_LIMITS.contentChars + 1));
    await click(button('Ver Markdown'));
    await eventually(() => expect(container.querySelector('[data-ready="true"]')).not.toBeNull());
    // No visual não há contador ao vivo: a recusa vem ao salvar.
    expect(alerts()).toEqual([]);
    await click(button('Salvar'));
    expect(alerts().join(' ')).toContain('O texto passou de 100.000 caracteres (100.001).');
    expect(server.writes()).toHaveLength(0);
  });

  it('título de 120 caracteres e texto de 100.000 são gravados', async () => {
    const container = await openDoc();
    await startEditing(container);
    await write(titleInput(), 'T'.repeat(120));
    await click(button('Ver Markdown'));
    await write(markdownField(), 'a'.repeat(DOC_LIMITS.contentChars));
    await click(button('Salvar'));
    await eventually(() => expect(server.doc.title).toBe('T'.repeat(120)));
    expect(countChars(server.doc.content)).toBe(DOC_LIMITS.contentChars);
    expect(alerts()).toEqual([]);
  });

  it('a recusa do servidor (o texto passou do limite por outro caminho) aparece e o texto continua na tela', async () => {
    const container = await openDoc();
    await startEditing(container);
    await click(button('Ver Markdown'));
    await write(markdownField(), 'Texto novo\n');
    server.refuse.next = { status: 422, code: 'DOC_TOO_LARGE', message: 'O doc passou de 100.000 caracteres.' };
    await click(button('Salvar'));
    await eventually(() => expect(alerts()).toContain('O doc passou de 100.000 caracteres.'));
    expect(markdownField().value).toBe('Texto novo\n');
    expect(server.doc.content).toBe(NON_CANONICAL);
  });

  it('a falha de rede mantém o texto e a repetição reaproveita a mesma operationId', async () => {
    const container = await openDoc();
    await startEditing(container);
    await click(button('Ver Markdown'));
    await write(markdownField(), 'Texto novo\n');
    const online = server.handle;
    const lost: Array<{ operationId: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        lost.push(JSON.parse(String(init?.body)) as { operationId: string });
        return Promise.reject(new TypeError('offline'));
      }),
    );
    await click(button('Salvar'));
    await eventually(() => expect(alerts()).toContain('Sem conexão com o servidor. Tente novamente.'));
    expect(markdownField().value).toBe('Texto novo\n');

    vi.stubGlobal('fetch', vi.fn(online));
    await click(button('Salvar'));
    await eventually(() => expect(server.doc.content).toBe('Texto novo\n'));
    // O servidor pode ter gravado antes de a rede cair: repetir com a MESMA operationId devolve o recibo em vez de gravar de novo.
    expect(server.patches()).toHaveLength(1);
    expect((server.patches()[0]?.body as { operationId: string }).operationId).toBe(lost[0]?.operationId);
  });
});

describe('A20: Baixar .md', () => {
  it('o arquivo baixado tem o texto gravado, byte a byte, e o nome do título', async () => {
    const container = await openDoc();
    const blobs: Blob[] = [];
    Object.assign(URL, {
      createObjectURL: vi.fn((blob: Blob) => {
        blobs.push(blob);
        return 'blob:doc-teste';
      }),
      revokeObjectURL: vi.fn(),
    });
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
    });

    await click(button('Baixar .md'));
    expect(blobs).toHaveLength(1);
    expect(await blobs[0]?.text()).toBe(NON_CANONICAL);
    expect(clicked).toHaveLength(1);
    expect(clicked[0]?.download).toBe('Plano.md');
    expect(clicked[0]?.href).toBe('blob:doc-teste');
    expect(container.querySelector('a[download]')).toBeNull();
  });
});

describe('A15: histórico e restauração', () => {
  it('lista as versões com autor, tamanho e data; restaurar a 2 cria uma versão nova com o texto dela e mantém as posteriores', async () => {
    const container = await openDoc();
    await click(button('Histórico'));
    await eventually(() => expect(document.body.textContent).toContain('Versão 3'));
    const list = document.body.textContent ?? '';
    expect(list).toContain('Versão 1');
    expect(list).toContain('Versão 2');
    expect(list).toContain('Bot');
    expect(list).toContain('Você');
    expect(list).toContain(`${countChars('Segunda versão, do bot\n')} caracteres`);
    expect(list).toContain('atual');

    await click([...document.body.querySelectorAll<HTMLButtonElement>('li button')].find((item) => item.textContent?.includes('Versão 2'))!);
    await eventually(() => expect(document.body.textContent).toContain('Segunda versão, do bot'));
    await click(button('Restaurar esta versão'));

    await eventually(() => expect(server.doc.version).toBe(4));
    expect(server.doc.content).toBe('Segunda versão, do bot\n');
    expect(server.doc.versions.map((item) => item.version)).toEqual([1, 2, 3, 4]);
    expect(server.doc.versions[3]).toMatchObject({ restoredFrom: 2, author: 'owner' });
    const restore = server.calls.find((call) => call.path.endsWith('/restore'));
    expect(restore?.body).toMatchObject({ version: 2, expectedVersion: 3, operationId: expect.any(String) });
    expect(restore?.csrf).toBe(SESSION.csrfToken);
    await eventually(() => expect(container.querySelector('article')?.textContent).toContain('Segunda versão, do bot'));
  });

  it('a versão atual não oferece restaurar', async () => {
    await openDoc();
    await click(button('Histórico'));
    await eventually(() => expect(document.body.textContent).toContain('Versão 3'));
    await click([...document.body.querySelectorAll<HTMLButtonElement>('li button')].find((item) => item.textContent?.includes('Versão 3'))!);
    await eventually(() => expect(document.body.textContent).toContain('Esta é a versão atual.'));
    expect([...document.body.querySelectorAll('button')].some((item) => item.textContent === 'Restaurar esta versão')).toBe(false);
  });

  it('restaurar com o doc já alterado pelo bot mostra o conflito e não grava', async () => {
    const container = await openDoc();
    await click(button('Histórico'));
    await eventually(() => expect(document.body.textContent).toContain('Versão 3'));
    await click([...document.body.querySelectorAll<HTMLButtonElement>('li button')].find((item) => item.textContent?.includes('Versão 1'))!);
    await eventually(() => expect(button('Restaurar esta versão')).toBeTruthy());
    server.botWrites('O bot escreveu antes\n');
    await click(button('Restaurar esta versão'));
    await eventually(() => expect(container.textContent).toContain('O doc mudou'));
    expect(server.doc.version).toBe(4);
    expect(server.doc.versions).toHaveLength(4);
  });

  it('o conteúdo de uma versão antiga também passa pela leitura segura (HTML e imagem não são interpretados)', async () => {
    server.doc.versions[0]!.content = UNSAFE_TEXT;
    await openDoc();
    await click(button('Histórico'));
    await eventually(() => expect(document.body.textContent).toContain('Versão 1'));
    await click([...document.body.querySelectorAll<HTMLButtonElement>('li button')].find((item) => item.textContent?.includes('Versão 1'))!);
    await eventually(() => expect(document.body.textContent).toContain('link seguro'));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('script')).toBeNull();
    expect(dialog.querySelector('img')).toBeNull();
  });
});

describe('Compartilhar', () => {
  it('lista os bots com os atuais marcados e grava a lista completa sobre a revisão de acesso lida', async () => {
    await openDoc();
    await click(button('Compartilhar'));
    await eventually(() => expect(document.body.textContent).toContain('Beto'));
    const boxes = [...document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes.map((box) => box.checked)).toEqual([true, false, false]);

    await click(boxes[1]!);
    await click(button('Salvar compartilhamento'));
    await eventually(() => expect(server.doc.botIds).toEqual([BOT_ANA.id, BOT_BETO.id]));
    const put = server.calls.find((call) => call.method === 'PUT');
    expect(put?.path).toBe(`/api/docs/${DOC_ID}/access`);
    expect(put?.body).toMatchObject({ botIds: [BOT_ANA.id, BOT_BETO.id], expectedAccessVersion: 2, operationId: expect.any(String) });
    expect(put?.csrf).toBe(SESSION.csrfToken);
  });

  it('com a revisão de acesso antiga mostra o conflito, preserva a seleção e oferece recarregar a revisão', async () => {
    await openDoc();
    await click(button('Compartilhar'));
    await eventually(() => expect(document.body.textContent).toContain('Beto'));
    server.doc.accessVersion = 5;
    const boxes = [...document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    await click(boxes[1]!);
    await click(button('Salvar compartilhamento'));
    await eventually(() => expect(alerts().join(' ')).toContain('O doc mudou'));
    expect(server.doc.botIds).toEqual([BOT_ANA.id]);
    expect(boxes[1]?.checked).toBe(true);

    await click(button('Recarregar revisão'));
    await eventually(() => expect(button('Salvar compartilhamento').disabled).toBe(false));
    await click(button('Salvar compartilhamento'));
    await eventually(() => expect(server.doc.botIds).toEqual([BOT_ANA.id, BOT_BETO.id]));
    expect(server.doc.accessVersion).toBe(6);
  });
});

describe('Excluir', () => {
  it('pede confirmação com o título e só exclui depois dela, com a operationId no corpo e o CSRF', async () => {
    await openDoc();
    await click(button('Excluir'));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Plano');
    expect(dialog.textContent).toContain('sem volta');
    expect(server.writes()).toHaveLength(0);

    await click(button('Cancelar', dialog));
    expect(server.writes()).toHaveLength(0);

    await click(button('Excluir'));
    await click(button('Excluir doc', document.body.querySelector('[role="dialog"]')!));
    await eventually(() => expect(router.replace).toHaveBeenCalledWith('/artefatos'));
    expect(server.doc.deleted).toBe(true);
    const deletion = server.calls.find((call) => call.method === 'DELETE');
    expect(deletion?.body).toEqual({ operationId: expect.any(String) });
    expect(deletion?.csrf).toBe(SESSION.csrfToken);
  });

  it('a recusa do servidor aparece no diálogo e o doc continua', async () => {
    await openDoc();
    await click(button('Excluir'));
    server.refuse.next = { status: 429, code: 'RATE_LIMITED', message: 'Muitas solicitações. Aguarde um instante e tente novamente.' };
    await click(button('Excluir doc', document.body.querySelector('[role="dialog"]')!));
    await eventually(() => expect(alerts()).toContain('Muitas solicitações. Aguarde um instante e tente novamente.'));
    expect(router.replace).not.toHaveBeenCalled();
    expect(server.doc.deleted).toBe(false);
  });
});

describe('Novo doc', () => {
  const field = () => document.body.querySelector<HTMLInputElement>('input#novo-doc-titulo')!;

  it('cria com o título e os bots escolhidos e abre o doc novo', async () => {
    const onClose = vi.fn();
    await mount(<NewDocDialog onClose={onClose} />);
    await eventually(() => expect(document.body.textContent).toContain('Ana'));
    // Bot arquivado não entra na escolha.
    expect(document.body.textContent).not.toContain('Arquivado');
    await write(field(), '  Plano semanal ');
    await click([...document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')][1]!);
    await click(button('Criar doc'));
    await eventually(() => expect(router.push).toHaveBeenCalledWith('/artefatos/docs/4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d'));
    const post = server.calls.find((call) => call.method === 'POST');
    expect(post?.path).toBe('/api/docs');
    expect(post?.body).toEqual({ title: 'Plano semanal', botIds: [BOT_BETO.id], content: '', operationId: expect.any(String) });
    expect(post?.csrf).toBe(SESSION.csrfToken);
  });

  it('sem bot é permitido e o título inválido mostra a mensagem sem enviar nada', async () => {
    await mount(<NewDocDialog onClose={vi.fn()} />);
    await eventually(() => expect(document.body.textContent).toContain('Ana'));
    await click(button('Criar doc'));
    expect(alerts()).toContain('Dê um título ao doc.');
    await write(field(), 'a'.repeat(121));
    await click(button('Criar doc'));
    expect(alerts()).toContain('O título passou de 120 caracteres.');
    expect(server.writes()).toHaveLength(0);

    await write(field(), 'a'.repeat(120));
    await click(button('Criar doc'));
    await eventually(() => expect(router.push).toHaveBeenCalled());
    expect(server.writes()[0]?.body).toMatchObject({ title: 'a'.repeat(120), botIds: [] });
  });

  it('o 101.º doc é recusado com a mensagem do servidor e nada é criado nem aberto', async () => {
    server.created.count = DOC_LIMITS.docs;
    await mount(<NewDocDialog onClose={vi.fn()} />);
    await eventually(() => expect(document.body.textContent).toContain('Ana'));
    await write(field(), 'Mais um');
    await click(button('Criar doc'));
    await eventually(() => expect(alerts()).toContain('O limite de 100 docs foi atingido.'));
    expect(router.push).not.toHaveBeenCalled();
    expect(button('Criar doc').disabled).toBe(false);
  });

  it('Cancelar fecha sem enviar', async () => {
    const onClose = vi.fn();
    await mount(<NewDocDialog onClose={onClose} />);
    await eventually(() => expect(document.body.textContent).toContain('Ana'));
    await click(button('Cancelar'));
    expect(onClose).toHaveBeenCalled();
    expect(server.writes()).toHaveLength(0);
  });
});

describe('Regras: categorias internas', () => {
  it('docs e tabelas ganham a nota de que permitir não compartilha nem amplia o acesso; outros apps não', () => {
    const docs = renderToStaticMarkup(<InternalCategoryNote appSlug="aion_docs" />);
    expect(docs).toContain('Categorias internas do Aion');
    expect(docs).toContain('permitir não compartilha docs nem amplia o acesso dos bots');
    const tables = renderToStaticMarkup(<InternalCategoryNote appSlug="aion_tables" />);
    expect(tables).toContain('permitir não compartilha tabelas nem amplia o acesso dos bots');
    expect(renderToStaticMarkup(<InternalCategoryNote appSlug="gmail" />)).toBe('');
  });
});

// @vitest-environment jsdom
// Prova da área Artefatos (phase 14, passo 6; A1, A2, A3, A31) com o DOM real (jsdom) e a API trocada por um servidor FALSO em memória na fronteira `fetch`: o `apiFetch` e os
// clientes `tables/api.ts` e `docs/api.ts` rodam de verdade, então CSRF, `operationId` e os caminhos também são provados.
//
// Cada caso sai do critério e observa o que o dono vê:
// - A1: a lista mostra tabelas e docs com tipo, título e bots; o filtro por tipo, o filtro por bot (com "Sem bot") e a busca pelo título reduzem a lista (e combinam).
// - A2: sem nenhum artefato, o estado vazio explica o que são artefatos.
// - A3: "Voltar" na área leva ao pai fixo (Início); as entradas antigas de Tabelas (cabeçalho da conversa e Configurações) deram lugar a Artefatos.
// - A29: "Sem bot", "Compartilhar" por item (tabelas e docs), "Nova tabela" e "Novo doc" e o teto de 100 continuam, sem perder o que as listas antigas faziam.
// - A31: o pai fixo das páginas de tabela e de doc e os redirects das listas antigas (308 em `next.config.ts`) são provados em `shell/mobile-nav.test.ts`, que roda em node (o config
//   não carrega no jsdom); o HTTP em si, com a query string, é do E2E.
import { DOC_LIMITS, TABLE_LIMITS, type DataTable, type DocSummary, type SessionInfo } from '@aion/shared';
import { StrictMode, act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ActivityAndFilesPage from '@/app/(app)/configuracoes/atividade-e-arquivos/page';
import { BotHeaderActions } from '@/components/conversation/conversation-view';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SessionProvider } from '@/lib/session-context';
import { ArtifactList, buildArtifacts, filterArtifacts, NO_FILTERS, type ArtifactFilters } from './artifact-list';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/artefatos' }));

const SESSION: SessionInfo = { owner: { email: 'dono@example.com' }, sessionId: '5b1f9c0e-3c1d-4f6e-8a7b-2d4e6f8a0b1c', csrfToken: 'csrf-token-de-teste' };
interface FakeBot {
  id: string;
  name: string;
  color: string;
  archivedAt: string | null;
  runState: string;
  unread: boolean;
  preview: string;
}
const BOT_ANA: FakeBot = { id: '11111111-1111-4111-8111-111111111111', name: 'Ana', color: '#60A5FA', archivedAt: null, runState: 'idle', unread: false, preview: 'Sem novidades' };
const BOT_BETO: FakeBot = { id: '22222222-2222-4222-8222-222222222222', name: 'Beto', color: '#4ADE80', archivedAt: null, runState: 'idle', unread: false, preview: 'Sem novidades' };
const BOT_OLD: FakeBot = { id: '33333333-3333-4333-8333-333333333333', name: 'Velho', color: '#9CA3AF', archivedAt: '2026-10-01T10:00:00.000Z', runState: 'idle', unread: false, preview: 'Sem novidades' };
const ALL_BOTS: FakeBot[] = [BOT_ANA, BOT_BETO, BOT_OLD];

const uuid = (n: number): string => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const table = (n: number, name: string, botIds: string[], description = ''): DataTable => ({ id: uuid(n), name, description, version: 1, schemaVersion: 1, columns: [], botIds });
const doc = (n: number, title: string, botIds: string[]): DocSummary => ({
  id: uuid(1000 + n),
  title,
  version: 1,
  accessVersion: 1,
  size: 10,
  botIds,
  updatedBy: 'owner',
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-22T10:00:00.000Z',
});

/** Seis artefatos: três tabelas e três docs, com bots variados e dois sem bot. */
const seed = () => ({
  tables: [table(1, 'Tarefas', [BOT_ANA.id], 'O que falta fazer'), table(2, 'Clientes', [BOT_ANA.id, BOT_BETO.id]), table(3, 'Pedidos fictícios', [])],
  docs: [doc(1, 'Plano', [BOT_ANA.id]), doc(2, 'Relatório de vendas', [BOT_BETO.id]), doc(3, 'Ata da reunião', [])],
});

interface Call {
  method: string;
  path: string;
  body: unknown;
  csrf: string | null;
}

/** O servidor falso: lista tabelas, docs e bots, cria tabela e troca o acesso com as mesmas regras de CSRF e `operationId` da API real. */
function makeServer(initial = seed()) {
  const state = { tables: [...initial.tables], docs: [...initial.docs], bots: [...ALL_BOTS] };
  const calls: Call[] = [];
  /** Quantas leituras seguintes falham (rede fora do ar) antes de a API voltar. */
  const outage = { docs: 0 };
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fail = (status: number, code: string, message: string) => reply(status, { code, message });

  async function handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const csrf = headers['x-csrf-token'] ?? null;
    calls.push({ method, path: url.pathname, body, csrf });
    if (method !== 'GET' && csrf !== SESSION.csrfToken) return fail(403, 'CSRF_TOKEN_INVALID', 'Token de segurança inválido. Recarregue a página.');

    if (url.pathname === '/api/bots') return reply(200, { bots: state.bots });
    if (url.pathname === '/api/tables' && method === 'GET') return reply(200, { tables: state.tables, nextCursor: null });
    if (url.pathname === '/api/docs' && method === 'GET') {
      if (outage.docs > 0) {
        outage.docs -= 1;
        throw new TypeError('offline');
      }
      return reply(200, { docs: state.docs });
    }
    const created = /^\/api\/bots\/([^/]+)\/tables$/.exec(url.pathname);
    if (created && method === 'POST') {
      const { name, description, operationId } = body as { name: string; description: string; operationId?: string };
      if (!operationId) return fail(400, 'VALIDATION_FAILED', 'Dados inválidos.');
      const next = table(500 + state.tables.length, name, [created[1]!], description);
      state.tables.push(next);
      return reply(201, next);
    }
    const tableAccess = /^\/api\/tables\/([^/]+)\/access$/.exec(url.pathname);
    if (tableAccess && method === 'PUT') {
      const found = state.tables.find((item) => item.id === tableAccess[1]);
      if (!found) return fail(404, 'TABLE_NOT_FOUND', 'Tabela não encontrada.');
      const input = body as { botIds: string[]; expectedVersion: number; operationId: string };
      if (input.expectedVersion !== found.version) return fail(409, 'TABLE_CONFLICT', 'A tabela mudou.');
      found.botIds = input.botIds;
      found.version += 1;
      return reply(200, found);
    }
    const docAccess = /^\/api\/docs\/([^/]+)\/access$/.exec(url.pathname);
    if (docAccess && method === 'PUT') {
      const found = state.docs.find((item) => item.id === docAccess[1]);
      if (!found) return fail(404, 'DOC_NOT_FOUND', 'Doc não encontrado.');
      const input = body as { botIds: string[]; expectedAccessVersion: number };
      if (input.expectedAccessVersion !== found.accessVersion) return fail(409, 'DOC_CONFLICT', 'O doc mudou.');
      found.botIds = input.botIds;
      found.accessVersion += 1;
      return reply(200, found);
    }
    return fail(404, 'NOT_FOUND', 'Não encontrado.');
  }

  return { state, calls, outage, handle, writes: () => calls.filter((call) => call.method !== 'GET') };
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
});

let server = makeServer();
beforeEach(() => {
  server = makeServer();
  vi.stubGlobal('fetch', vi.fn(server.handle));
});

/** Renderiza dentro da sessão (CSRF); o que abre em portal (drawer, modal) fica em `document.body`. */
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
const click = (element: HTMLElement) => doNow(() => element.click());

/** O botão pelo nome visível ou acessível. Procura no documento inteiro, inclusive em portais. */
function button(name: string, within: ParentNode = document.body): HTMLButtonElement {
  const found = [...within.querySelectorAll('button')].find((item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name);
  if (!found) throw new Error(`Botão "${name}" não encontrado. Botões: ${[...within.querySelectorAll('button')].map((item) => item.textContent?.trim() || item.getAttribute('aria-label')).join(' | ')}`);
  return found;
}

/** Troca o valor de um campo controlado pelo React, como a digitação faz. */
function write(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  return doNow(() => element.dispatchEvent(new Event('input', { bubbles: true })));
}

/** Escolhe uma opção de um `<select>` controlado pelo React, como o seletor nativo faz. */
function choose(element: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(element, value);
  return doNow(() => element.dispatchEvent(new Event('change', { bubbles: true })));
}

const typeFilter = (name: 'Todos' | 'Tabelas' | 'Docs') => button(name, document.body.querySelector('[role="group"][aria-label="Tipo de artefato"]')!);
const botFilter = () => document.body.querySelector<HTMLSelectElement>('select[aria-label="Filtrar por bot"]')!;
const searchField = () => document.body.querySelector<HTMLInputElement>('input[aria-label="Buscar pelo título"]')!;
const rows = () => [...document.body.querySelectorAll<HTMLLIElement>('ul[aria-label="Artefatos"] > li')];
const titles = () => rows().map((row) => row.querySelector('a')!.textContent);
const alerts = () => [...document.body.querySelectorAll('[role="alert"]')].map((item) => item.textContent ?? '');

/** Abre a área e espera a lista (ou o estado vazio) carregada. */
async function openArea(options?: { strict?: boolean }) {
  const container = await mount(<ArtifactList />, options);
  await eventually(() => expect(container.querySelector('[aria-busy="true"]')).toBeNull());
  return container;
}

describe('A1: a lista junta tabelas e docs', () => {
  it('mostra cada artefato com tipo, título e os bots com acesso, e "Sem bot" quando não há nenhum', async () => {
    await openArea();
    // Do título A a Z, os dois tipos juntos.
    expect(titles()).toEqual(['Ata da reunião', 'Clientes', 'Pedidos fictícios', 'Plano', 'Relatório de vendas', 'Tarefas']);
    const byTitle = (title: string) => rows().find((row) => row.querySelector('a')!.textContent === title)!;
    expect(byTitle('Plano').textContent).toContain('Doc');
    expect(byTitle('Plano').textContent).toContain('Ana');
    expect(byTitle('Tarefas').textContent).toContain('Tabela');
    expect(byTitle('Tarefas').textContent).toContain('O que falta fazer');
    expect(byTitle('Clientes').textContent).toContain('Ana');
    expect(byTitle('Clientes').textContent).toContain('Beto');
    expect(byTitle('Ata da reunião').textContent).toContain('Sem bot');
    expect(byTitle('Pedidos fictícios').textContent).toContain('Sem bot');
    expect(byTitle('Plano').textContent).not.toContain('Sem bot');
  });

  it('cada título leva à página própria do artefato (A7: o mesmo endereço aberto direto mostra o artefato)', async () => {
    await openArea();
    const links = Object.fromEntries(rows().map((row) => [row.querySelector('a')!.textContent, row.querySelector('a')!.getAttribute('href')]));
    expect(links['Plano']).toBe(`/artefatos/docs/${uuid(1001)}`);
    expect(links['Tarefas']).toBe(`/artefatos/tabelas/${uuid(1)}`);
  });

  it('o filtro por tipo mostra só tabelas ou só docs, e Todos devolve os dois', async () => {
    await openArea();
    await click(typeFilter('Tabelas'));
    expect(titles()).toEqual(['Clientes', 'Pedidos fictícios', 'Tarefas']);
    expect(typeFilter('Tabelas').getAttribute('aria-pressed')).toBe('true');
    await click(typeFilter('Docs'));
    expect(titles()).toEqual(['Ata da reunião', 'Plano', 'Relatório de vendas']);
    await click(typeFilter('Todos'));
    expect(titles()).toHaveLength(6);
  });

  it('o filtro por bot mostra os artefatos do bot escolhido e "Sem bot" os que ninguém acessa', async () => {
    await openArea();
    // As opções: todos, "Sem bot" e cada bot (o arquivado também, porque ele pode ter artefatos).
    expect([...botFilter().options].map((option) => option.textContent)).toEqual(['Todos os bots', 'Sem bot', 'Ana', 'Beto', 'Velho · Arquivado']);
    await choose(botFilter(), BOT_ANA.id);
    expect(titles()).toEqual(['Clientes', 'Plano', 'Tarefas']);
    await choose(botFilter(), BOT_BETO.id);
    expect(titles()).toEqual(['Clientes', 'Relatório de vendas']);
    await choose(botFilter(), 'none');
    expect(titles()).toEqual(['Ata da reunião', 'Pedidos fictícios']);
    await choose(botFilter(), 'all');
    expect(titles()).toHaveLength(6);
  });

  it('a busca pelo título ignora maiúsculas e acentos e só olha o título', async () => {
    await openArea();
    await write(searchField(), 'RELATORIO');
    expect(titles()).toEqual(['Relatório de vendas']);
    await write(searchField(), 'pla');
    expect(titles()).toEqual(['Plano']);
    // A descrição da tabela ("O que falta fazer") não é título.
    await write(searchField(), 'falta');
    expect(titles()).toEqual([]);
  });

  it('tipo, bot e busca combinam e "Limpar filtros" devolve a lista inteira', async () => {
    await openArea();
    await click(typeFilter('Docs'));
    await choose(botFilter(), BOT_ANA.id);
    expect(titles()).toEqual(['Plano']);
    await write(searchField(), 'relat');
    expect(titles()).toEqual([]);
    expect(document.body.textContent).toContain('Nenhum artefato com estes filtros.');
    await click(button('Limpar filtros'));
    expect(titles()).toHaveLength(6);
    expect(searchField().value).toBe('');
    expect(botFilter().value).toBe('all');
    expect(typeFilter('Todos').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('filtros (função pura)', () => {
  const items = buildArtifacts(seed().tables, seed().docs);
  const run = (filters: Partial<ArtifactFilters>) => filterArtifacts(items, { ...NO_FILTERS, ...filters }).map((item) => item.title);

  it('sem filtro devolve tudo; um bot que não existe devolve nada', () => {
    expect(run({})).toHaveLength(6);
    expect(run({ bot: uuid(9999) })).toEqual([]);
  });

  it('busca em branco ou só com espaços não filtra', () => {
    expect(run({ query: '   ' })).toHaveLength(6);
  });

  it('títulos iguais de tipos diferentes mantêm uma ordem estável: tabela antes do doc', () => {
    const same = buildArtifacts([table(1, 'Plano', [])], [doc(1, 'Plano', [])]);
    expect(same.map((item) => item.kind)).toEqual(['table', 'doc']);
  });
});

describe('A2: sem nenhum artefato', () => {
  it('mostra o estado vazio com a frase que explica o que são artefatos, sem filtros', async () => {
    server = makeServer({ tables: [], docs: [] });
    vi.stubGlobal('fetch', vi.fn(server.handle));
    const container = await openArea();
    expect(container.textContent).toContain('Artefatos são as tabelas e os docs que os bots criam e mantêm para você.');
    expect(rows()).toHaveLength(0);
    expect(searchField()).toBeNull();
    expect(botFilter()).toBeNull();
    // Criar continua ao alcance, sem repetir os botões no estado vazio.
    expect([...container.querySelectorAll('button')].filter((item) => item.textContent === 'Novo doc')).toHaveLength(1);
  });
});

describe('carregamento', () => {
  it('uma falha de leitura mostra a mensagem e "Tentar novamente" carrega a lista', async () => {
    server.outage.docs = 1;
    const container = await mount(<ArtifactList />);
    await eventually(() => expect(alerts().join(' ')).toContain('Sem conexão com o servidor'));
    expect(rows()).toHaveLength(0);
    await click(button('Tentar novamente'));
    await eventually(() => expect(rows()).toHaveLength(6));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('sob StrictMode (efeitos montados duas vezes) a lista carrega e mostra cada artefato uma vez', async () => {
    await openArea({ strict: true });
    expect(rows()).toHaveLength(6);
  });
});

describe('A3: pai fixo', () => {
  it('"Voltar" na área leva ao Início', async () => {
    await openArea();
    const back = document.body.querySelector('a[aria-label="Voltar"]');
    expect(back?.getAttribute('href')).toBe('/');
    expect(document.body.querySelector('h1')?.textContent).toBe('Artefatos');
  });
});

describe('A29: o que as listas antigas faziam continua', () => {
  const field = (id: string) => document.body.querySelector<HTMLInputElement>(`#${id}`)!;

  it('"Nova tabela" cria associada ao bot escolhido, com recibo e CSRF, e abre a tabela nova na rota canônica', async () => {
    await openArea();
    await click(button('Nova tabela'));
    await write(field('nova-tabela-nome'), '  Catálogo ');
    await write(document.body.querySelector<HTMLTextAreaElement>('#nova-tabela-descricao')!, 'Itens de teste');
    await choose(document.body.querySelector<HTMLSelectElement>('#nova-tabela-bot')!, BOT_BETO.id);
    await click(button('Criar tabela'));
    await eventually(() => expect(router.push).toHaveBeenCalledWith(expect.stringMatching(/^\/artefatos\/tabelas\//)));
    const post = server.calls.find((call) => call.method === 'POST');
    expect(post?.path).toBe(`/api/bots/${BOT_BETO.id}/tables`);
    expect(post?.body).toEqual({ name: 'Catálogo', description: 'Itens de teste', columns: [], operationId: expect.any(String) });
    expect(post?.csrf).toBe(SESSION.csrfToken);
  });

  it('"Nova tabela" sem nome ou sem bot não envia nada e só oferece bots ativos', async () => {
    await openArea();
    await click(button('Nova tabela'));
    const select = document.body.querySelector<HTMLSelectElement>('#nova-tabela-bot')!;
    // Bot arquivado não ganha tabela nova; sem bot escolhido (são dois ativos), o botão espera a escolha.
    expect([...select.options].map((option) => option.textContent)).toEqual(['Escolha um bot', 'Ana', 'Beto']);
    expect(button('Criar tabela').disabled).toBe(true);
    await write(field('nova-tabela-nome'), 'Sem bot ainda');
    expect(button('Criar tabela').disabled).toBe(true);
    await choose(select, BOT_ANA.id);
    expect(button('Criar tabela').disabled).toBe(false);
    expect(server.writes()).toHaveLength(0);
  });

  it('"Nova tabela" parte do bot do filtro', async () => {
    await openArea();
    await choose(botFilter(), BOT_BETO.id);
    await click(button('Nova tabela'));
    expect(document.body.querySelector<HTMLSelectElement>('#nova-tabela-bot')!.value).toBe(BOT_BETO.id);
  });

  it('com um único bot ativo, "Nova tabela" já parte dele', async () => {
    server.state.bots = [BOT_ANA, BOT_OLD];
    await openArea();
    await click(button('Nova tabela'));
    expect(document.body.querySelector<HTMLSelectElement>('#nova-tabela-bot')!.value).toBe(BOT_ANA.id);
  });

  it('sem nenhum bot ativo, "Nova tabela" explica que é preciso criar um bot e não deixa criar', async () => {
    server.state.bots = [BOT_OLD];
    await openArea();
    await click(button('Nova tabela'));
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Crie um bot');
    await write(field('nova-tabela-nome'), 'Sem dono');
    expect(button('Criar tabela').disabled).toBe(true);
    expect(server.writes()).toHaveLength(0);
  });

  it('"Novo doc" abre o diálogo de criação', async () => {
    await openArea();
    await click(button('Novo doc'));
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Novo doc');
    expect(document.body.querySelector('input#novo-doc-titulo')).not.toBeNull();
  });

  it(`com ${TABLE_LIMITS.tables} tabelas "Nova tabela" fica desabilitada e o limite é explicado`, async () => {
    const many = Array.from({ length: TABLE_LIMITS.tables }, (_, index) => table(index + 1, `Tabela ${index + 1}`, []));
    server = makeServer({ tables: many, docs: [] });
    vi.stubGlobal('fetch', vi.fn(server.handle));
    await openArea();
    expect(button('Nova tabela').disabled).toBe(true);
    expect(button('Novo doc').disabled).toBe(false);
    expect(document.body.textContent).toContain(`Limite de ${TABLE_LIMITS.tables} tabelas atingido`);
  });

  it(`com ${DOC_LIMITS.docs} docs "Novo doc" fica desabilitado e o limite é explicado`, async () => {
    const many = Array.from({ length: DOC_LIMITS.docs }, (_, index) => doc(index + 1, `Doc ${index + 1}`, []));
    server = makeServer({ tables: [], docs: many });
    vi.stubGlobal('fetch', vi.fn(server.handle));
    await openArea();
    expect(button('Novo doc').disabled).toBe(true);
    expect(button('Nova tabela').disabled).toBe(false);
    expect(document.body.textContent).toContain(`Limite de ${DOC_LIMITS.docs} docs atingido`);
  });

  it('"Compartilhar" no doc troca a lista de bots sobre a revisão de acesso lida e a linha passa a mostrar o bot novo', async () => {
    await openArea();
    await click(button('Compartilhar Plano'));
    await eventually(() => expect(document.body.textContent).toContain('Compartilhar · Plano'));
    await eventually(() => expect(document.body.querySelectorAll('input[type="checkbox"]')).toHaveLength(3));
    const boxes = [...document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes.map((box) => box.checked)).toEqual([true, false, false]);
    await click(boxes[1]!);
    await click(button('Salvar compartilhamento'));
    await eventually(() => expect(server.state.docs.find((item) => item.title === 'Plano')?.botIds).toEqual([BOT_ANA.id, BOT_BETO.id]));
    const put = server.calls.find((call) => call.method === 'PUT');
    expect(put?.path).toBe(`/api/docs/${uuid(1001)}/access`);
    expect(put?.csrf).toBe(SESSION.csrfToken);
    await eventually(() => expect(rows().find((row) => row.querySelector('a')!.textContent === 'Plano')?.textContent).toContain('Beto'));
  });

  it('"Compartilhar" na tabela devolve a tabela órfã ao "Sem bot" quando o último bot sai, e o filtro enxerga a mudança', async () => {
    await openArea();
    await click(button('Compartilhar Tarefas'));
    await eventually(() => expect(document.body.textContent).toContain('Compartilhar · Tarefas'));
    await eventually(() => expect(document.body.querySelectorAll('input[type="checkbox"]')).toHaveLength(3));
    const boxes = [...document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    await click(boxes[0]!);
    await click(button('Salvar compartilhamento'));
    await eventually(() => expect(server.state.tables.find((item) => item.name === 'Tarefas')?.botIds).toEqual([]));
    await choose(botFilter(), 'none');
    expect(titles()).toEqual(['Ata da reunião', 'Pedidos fictícios', 'Tarefas']);
    const put = server.calls.find((call) => call.method === 'PUT');
    expect(put?.path).toBe(`/api/tables/${uuid(1)}/access`);
  });
});

describe('A3: as entradas antigas de Tabelas deram lugar a Artefatos', () => {
  it('o cabeçalho da conversa do bot tem o atalho Artefatos e já não tem "Tabelas do bot"', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <BotHeaderActions botId={BOT_ANA.id} />
      </TooltipProvider>,
    );
    expect(html).toMatch(/<a[^>]*href="\/artefatos"[^>]*aria-label="Artefatos"|<a[^>]*aria-label="Artefatos"[^>]*href="\/artefatos"/);
    expect(html).not.toContain('Tabelas do bot');
    expect(html).not.toContain('/tabelas');
  });

  it('Configurações → Atividade e arquivos leva a Artefatos no lugar de Tabelas', () => {
    const html = renderToStaticMarkup(
      <SessionProvider session={SESSION}>
        <ActivityAndFilesPage />
      </SessionProvider>,
    );
    expect(html).toContain('href="/artefatos"');
    expect(html).not.toContain('/configuracoes/tabelas');
  });
});

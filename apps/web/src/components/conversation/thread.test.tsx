// Prova da Faísca na conversa (phase 5, A1 e A2; F1 e F7): o HTML que a `Thread` renderiza no servidor em cada situação do design, para o bot (Faísca na cor dele) e para o Chat
// geral (Faísca em `--faisca`, a cor do Aion). Conversa vazia (Faísca de 112 px com a entrada e sem olhar no HTML do servidor), ausência do indicador "Trabalhando…" na lista (a linha da Faísca é a `WorkingLine`, fora dela),
// respostas sem balão nem Faísca ao lado (phase 18), cada cartão com o estado certo (aprovação pendente aguardando, falha, limite e rotina
// com desfecho em erro ou concluído, parados) e os demais cartões com o ícone da legenda. Renderização no servidor, sem DOM; o movimento, o olhar acompanhando o cursor e o
// visual no navegador real são do E2E.
import type { ApprovalCard, ArtifactRef, Bot, CardView, ComplementView, ConversationAttachment, MessageView, RunView, SystemCard } from '@aion/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PARAM, artifactKey, artifactPageHref, parseArtifactKey } from '@/components/artifacts/artifact-card';
import { ArtifactPanel, useDiscardGuard } from '@/components/artifacts/artifact-panel';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SessionProvider } from '@/lib/session-context';
import type { ConversationState } from './conversation-state';
import { Thread, type VersionHandlers } from './thread';
import { artifactsOf, buildBlocks, generatedFilesOf } from './timeline';

// O cartão de proposta de rotina usa o roteador do Next, que só existe montado no app.
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }) }));

// Os perfis de modelo só chegam montados (efeito); aqui a entrada do modelo da Anthropic vem pronta, com o `display_name` que o seletor mostra, e o resto segue sem perfil.
vi.mock('@/components/models/use-models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/models/use-models')>()),
  useModelEntry: (model: string | null) => (model === 'anthropic/claude-haiku-5-5' ? { displayName: 'Claude Haiku 5.5' } : null),
}));

const NOW = '2026-10-04T12:00:00.000Z';
const BOT: Bot = {
  id: '7c1b0b9e-3b7a-4a4e-9a55-0d8f0f5a1e01',
  name: 'Financeiro',
  color: '#FBBF24',
  archivedAt: null,
  instructions: '',
  model: null,
  effort: null,
  stepLimit: 50, contextWindowTokens: null,
  createdAt: NOW,
  updatedAt: NOW,
};
const SESSION = { owner: { email: 'dono@example.com' }, sessionId: '0f3a9c1e-7a56-4d0b-8c0c-1d2e3f4a5b6c', csrfToken: 'csrf-de-teste' };
const BASE_STATE: ConversationState = { items: [], runs: [], hasMore: false, model: { model: null, effort: null }, providerConfigured: true, draft: null, rounds: null, rewound: null };

let nextId = 1;
const id = (): string => String(nextId++);

/** Mensagem do dono: dá à conversa algo além do vazio e abre a sequência de blocos. */
const userMessage = (content = 'Oi'): MessageView => ({ id: id(), runId: null, createdAt: NOW, kind: 'text', role: 'user', status: 'done', content });
/** Cartão de sistema com o conteúdo do tipo informado. */
const cardMessage = (card: SystemCard, content = ''): CardView => ({ id: id(), runId: null, createdAt: NOW, kind: 'card', status: 'done', content, card });
const run = (status: RunView['status']): RunView => ({ id: id(), status, input: null, routineName: null, toolCalls: 0, failureCode: null, createdAt: NOW, startedAt: NOW, finishedAt: null });

const SCHEDULE = { schedule: { type: 'daily' as const, times: ['07:00'] }, timezone: 'America/Sao_Paulo', startsAt: null, endsAt: null, maxRuns: null };
/** `accountLabel` é a conta do conector que o servidor grava no cartão (phase 13); ausente, como nos cartões gravados antes da phase. */
const approval = (status: 'pending' | 'approved', accountLabel?: string): SystemCard => ({
  type: 'approval',
  approvalId: id(),
  status,
  decision: status === 'approved' ? 'allow_once' : null,
  action: 'GMAIL_SEND_EMAIL',
  actionLabel: 'Send Email · Gmail',
  appName: 'Gmail',
  ...(accountLabel === undefined ? {} : { accountLabel }),
  params: [{ name: 'to', value: 'dono@example.com' }],
  omitted: { count: 0, names: [] },
  expiresAt: '2026-10-05T12:00:00.000Z',
});
const routineRun = (state: Extract<SystemCard, { type: 'routine_run' }>['state']): SystemCard => ({
  type: 'routine_run',
  routineId: null,
  routineName: 'Relatório do dia',
  scheduledFor: NOW,
  startedAt: NOW,
  manual: true,
  state,
  finishedAt: state === 'running' ? null : NOW,
  failureCode: state === 'failed' ? 'RUN_FAILED' : null,
});

/** O que o HTML guarda de cada Faísca da conversa (atributos do `<svg class="faisca">`), na ordem em que aparecem. */
function faiscas(html: string) {
  return [...html.matchAll(/<svg[^>]*class="faisca[^"]*"[^>]*>/g)].map((match) => {
    const tag = match[0];
    return {
      body: /--faisca-body:([^;"]+)/.exec(tag)?.[1],
      state: /data-state="(\w+)"/.exec(tag)?.[1],
      size: Number(/width="(\d+)"/.exec(tag)?.[1]),
      detail: /data-detail="(\w+)"/.exec(tag)?.[1],
      still: tag.includes('data-still'),
      enter: tag.includes('data-enter'),
      looking: tag.includes('data-look'),
      decorative: tag.includes('aria-hidden="true"') && !tag.includes('role='),
      className: /class="([^"]*)"/.exec(tag)?.[1],
    };
  });
}

/** O corpo da Faísca de cada dono: a cor do bot, ou o token de marca no Chat geral (sem bot). */
const BOT_BODY = '#FBBF24';
const AION_BODY = 'var(--faisca)';

/** O endereço do cartão de artefato, como `ConversationView` o monta: a própria conversa com `?artefato=<tipo>:<id>` (phase 14, passo 7). */
const artifactHref = (ref: Pick<ArtifactRef, 'type' | 'id'>): string => `/bots/${BOT.id}?artefato=${ref.type}:${ref.id}`;

/** A conversa renderizada como a tela a monta: com a sessão (cartões que chamam a API) e o provedor de dicas (menu do cartão de aprovação). `openArtifact` é o `?artefato=` da URL. */
function render(bot: Bot | null, state: Partial<ConversationState> = {}, versions: VersionHandlers | null = null, openArtifact: string | null = null): string {
  return renderToStaticMarkup(
    <SessionProvider session={SESSION}>
      <TooltipProvider>
        <Thread source={bot ? { kind: 'bot', id: bot.id } : { kind: 'session', id: SESSION.sessionId }} bot={bot} state={{ ...BASE_STATE, ...state }} onRetry={() => undefined} onCancelComplement={async () => undefined} loadOlder={async () => ({ ok: true, hasMore: false })} versions={versions} artifactLinks={{ hrefOf: artifactHref, openKey: openArtifact }} />
      </TooltipProvider>
    </SessionProvider>,
  );
}

/** A legenda do cartão que começa pelo ícone de 14 px (`lucide`): o cartão sem Faísca. Com a Faísca, a legenda é só o título. */
const LEGEND_ICON = /<p class="mb-1 flex items-center gap-1\.5 text-xs font-medium text-muted"><svg[^>]*class="lucide /;

/** A legenda da linha discreta (`SystemLine`, phase 18): o ícone de 16 px e o título, sem a moldura do cartão. */
const LINE_ICON = /<section aria-label="[^"]*" class="w-full text-sm text-muted"><div class="flex[^"]*"><p class="flex min-w-0 items-center gap-2 text-sm[^"]*"><svg[^>]*class="lucide /;

/** Moldura do cartão neutro (phase 18): a borda fina e o fundo de superfície, que nenhuma linha leva. */
const CARD_FRAME = /rounded-md border border-line bg-surface/;

/** O cartão (`<section aria-label>`) pelo nome acessível, do começo da seção ao fim dela. */
function cardHtml(html: string, label: string): string {
  const start = html.indexOf(`<section aria-label="${label}"`);
  expect(start, `cartão "${label}"`).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</section>', start));
}

describe('conversa vazia', () => {
  it('o bot mostra a Faísca de 112 px ociosa, com a entrada, na cor dele, e sem olhar no HTML do servidor (o olhar só começa depois de montar)', () => {
    const html = render(BOT);
    expect(faiscas(html)).toEqual([
      { body: BOT_BODY, state: 'idle', size: 112, detail: 'full', still: true, enter: true, looking: false, decorative: true, className: expect.stringContaining('max-md:size-24') },
    ]);
    expect(html).not.toContain('--lx'); // o vetor do olhar nunca vem do servidor
    expect(html).toContain('O que o <span');
    expect(html).not.toContain('lucide-message-square');
  });

  it('o bot arquivado também mostra a Faísca (a conversa é a mesma; o estado de sono é do cabeçalho)', () => {
    expect(faiscas(render({ ...BOT, archivedAt: NOW }))).toHaveLength(1);
  });

  it('o Chat geral (sem bot) mostra a Faísca de 112 px em `--faisca`, com a mesma entrada, e a pergunta de sempre, sem marcador de chat', () => {
    const html = render(null);
    expect(faiscas(html)).toEqual([
      { body: AION_BODY, state: 'idle', size: 112, detail: 'full', still: true, enter: true, looking: false, decorative: true, className: expect.stringContaining('max-md:size-24') },
    ]);
    expect(html).not.toContain('lucide-message-square');
    expect(html).toContain('No que posso ajudar?');
  });
});

describe('a lista não leva o indicador "Trabalhando…" (phase 18: a linha da Faísca é a WorkingLine, fixa acima do composer)', () => {
  it.each([
    ['o bot', BOT],
    ['o Chat geral', null],
  ] as const)('%s com execução rodando não desenha frase nem Faísca de trabalho entre as mensagens (A8)', (_name, bot) => {
    const html = render(bot, { items: [userMessage()], runs: [run('running')] });
    expect(html).not.toContain('Trabalhando…');
    expect(html).not.toContain('role="status" aria-live="polite" class="text-sm text-muted"');
    expect(faiscas(html)).toEqual([]);
    expect(html).not.toContain('lucide-message-square');
  });

  it('aguardando aprovação também não põe nada na lista (o bot está parado esperando o dono)', () => {
    const html = render(BOT, { items: [userMessage()], runs: [run('waiting_approval')] });
    expect(html).not.toContain('Trabalhando…');
    expect(faiscas(html)).toEqual([]);
  });
});

describe('cartões da conversa', () => {
  /** Um cartão sozinho numa conversa: a Faísca que ele mostra (nenhuma, se não mostra). */
  const faiscasOf = (card: SystemCard, bot: Bot | null = BOT) => faiscas(render(bot, { items: [cardMessage(card)] }));
  const parada = (state: string, body = BOT_BODY) => ({ body, state, size: 32, detail: 'small', still: true, enter: false, looking: false, decorative: true, className: 'faisca' });

  it('aprovação pendente: a Faísca aguardando, de 32 px e na cor do bot, é o ÚNICO dos cartões que se mexe, no lugar do ícone da legenda', () => {
    const html = render(BOT, { items: [cardMessage(approval('pending'))] });
    expect(faiscas(html)).toEqual([{ ...parada('waiting'), still: false }]);
    const card = cardHtml(html, 'Aprovação pendente');
    expect(card).toContain('class="faisca"');
    expect(card).not.toContain('lucide-shield-check');
    expect(card).toContain('Permitir uma vez'); // as ações e o texto continuam os mesmos
    expect(card).toContain('Send Email · Gmail');
  });

  it('aprovação: o cartão mostra a conta do conector ao lado da ação, pendente e respondido, e o cartão sem conta segue igual (A9)', () => {
    // Pendente com conta: o nome que o dono deu à conta, na legenda da ação.
    const pendingCard = cardHtml(render(BOT, { items: [cardMessage(approval('pending', 'Pessoal'))] }), 'Aprovação pendente');
    expect(pendingCard).toContain('Send Email · Gmail');
    expect(pendingCard).toContain('Conta: Pessoal');
    // Sem nome dado pelo dono, o servidor manda o rótulo automático pronto e a tela só o mostra.
    expect(cardHtml(render(BOT, { items: [cardMessage(approval('pending', 'Gmail · ca_…1a2b'))] }), 'Aprovação pendente')).toContain('Conta: Gmail · ca_…1a2b');
    // Respondido: a linha colapsada também diz em qual conta a ação foi decidida.
    expect(cardHtml(render(BOT, { items: [cardMessage(approval('approved', 'Profissional'))] }), 'Aprovação')).toContain('Conta: Profissional');
    // O Chat geral não tem conector, mas um cartão antigo dele com conta usa o mesmo componente.
    expect(cardHtml(render(null, { items: [cardMessage(approval('pending', 'Pessoal'))] }), 'Aprovação pendente')).toContain('Conta: Pessoal');
    // Cartão gravado antes da phase (e ação sem conta, como as categorias de tabelas): nenhuma linha de conta.
    expect(cardHtml(render(BOT, { items: [cardMessage(approval('pending'))] }), 'Aprovação pendente')).not.toContain('Conta:');
    expect(cardHtml(render(BOT, { items: [cardMessage(approval('approved'))] }), 'Aprovação')).not.toContain('Conta:');
  });

  // A35 (decisão 23, phase 14): o título do doc vem pronto no impacto do cartão (o servidor o lê depois da checagem de acesso); a tela só o mostra, ao lado da ação. O cartão de exclusão de tabela
  // segue com o nome da tabela e a contagem de registros, como antes.
  it('aprovação de exclusão de doc: o cartão mostra o título do doc ao lado da ação, pendente e respondido; a de tabela segue com o nome da tabela; sem impacto cai no cartão genérico (A35)', () => {
    const impactCard = (status: 'pending' | 'approved', action: { action: string; actionLabel: string; appName: string }, impact: ApprovalCard['impact']): SystemCard => ({ ...(approval(status) as ApprovalCard), ...action, params: [], ...(impact === undefined ? {} : { impact }) });
    const docAction = { action: 'aion_doc_delete', actionLabel: 'Excluir doc', appName: 'Docs do Aion' };
    const docImpact = (docTitle: string): ApprovalCard['impact'] => ({ kind: 'delete_doc', docId: '8f0c2f4e-5f5f-4f7a-9d7e-1f8a6a1d0002', docTitle });

    const pendingDoc = cardHtml(render(BOT, { items: [cardMessage(impactCard('pending', docAction, docImpact('Plano')))] }), 'Aprovação pendente');
    expect(pendingDoc).toContain('Excluir doc');
    expect(pendingDoc).toContain('Doc: Plano');
    expect(pendingDoc).toContain('Esta ação não pode ser desfeita.');
    expect(pendingDoc).toContain('Permitir uma vez');
    expect(pendingDoc).not.toContain('Tabela:');
    // A regra "sempre permitir" é da categoria de docs e não concede acesso (como a de tabelas).
    expect(pendingDoc).toContain('Não concede acesso a outros docs.');
    // O Chat geral não tem docs, mas um cartão dele usa o mesmo componente; sem bot não há regra permanente a explicar.
    expect(cardHtml(render(null, { items: [cardMessage(impactCard('pending', docAction, docImpact('Plano')))] }), 'Aprovação pendente')).not.toContain('Não concede acesso a outros docs.');
    expect(cardHtml(render(BOT, { items: [cardMessage(impactCard('approved', docAction, docImpact('Plano')))] }), 'Aprovação')).toContain('Doc: Plano');
    // O título é texto do doc: nunca interpretado como marcação.
    const hostile = cardHtml(render(BOT, { items: [cardMessage(impactCard('pending', docAction, docImpact('Plano <script>x</script> & cia')))] }), 'Aprovação pendente');
    expect(hostile).toContain('Doc: Plano &lt;script&gt;x&lt;/script&gt; &amp; cia');
    expect(hostile).not.toContain('<script>');

    // Exclusão de tabela: o nome da tabela e os registros afetados, como antes.
    const tableAction = { action: 'aion_table_delete', actionLabel: 'Excluir tabela', appName: 'Tabelas do Aion' };
    const tableImpact: ApprovalCard['impact'] = { kind: 'delete_table', tableId: '8f0c2f4e-5f5f-4f7a-9d7e-1f8a6a1d0001', tableName: 'Tarefas', expectedVersion: 1, recordCount: 3 };
    const pendingTable = cardHtml(render(BOT, { items: [cardMessage(impactCard('pending', tableAction, tableImpact))] }), 'Aprovação pendente');
    expect(pendingTable).toContain('Tabela: Tarefas');
    expect(pendingTable).toContain('3 registro(s) afetado(s). Esta ação não pode ser desfeita.');
    expect(pendingTable).not.toContain('Doc:');
    expect(cardHtml(render(BOT, { items: [cardMessage(impactCard('approved', tableAction, tableImpact))] }), 'Aprovação')).toContain('Tarefas · 3 registro(s) afetado(s)');

    // Cartão de doc gravado sem impacto: cai no cartão genérico (a categoria e os parâmetros), sem inventar título.
    const legacy = cardHtml(render(BOT, { items: [cardMessage(impactCard('pending', docAction, undefined))] }), 'Aprovação pendente');
    expect(legacy).toContain('aion_doc_delete');
    expect(legacy).not.toContain('Doc:');
  });

  it('falha e limite atingido: a Faísca em erro, parada', () => {
    expect(faiscasOf({ type: 'run_failed', code: 'RUN_FAILED' })).toEqual([parada('error')]);
    expect(faiscasOf({ type: 'run_limit', limit: 'steps', steps: ['Pesquisou no histórico: x'] })).toEqual([parada('error')]);
    const failed = cardHtml(render(BOT, { items: [cardMessage({ type: 'run_failed', code: 'RUN_FAILED' }, 'O provedor falhou.')] }), 'A execução falhou');
    expect(failed).not.toContain('lucide-triangle-alert');
    expect(failed).toContain('O provedor falhou.');
  });

  it('rotina: falhou, limite e expirou são cartão com a Faísca de erro, parada; concluída, iniciada e interrompida são linha com o ícone, sem Faísca nem moldura (A12 e A14)', () => {
    for (const state of ['failed', 'limit_reached', 'expired'] as const) {
      expect(faiscasOf(routineRun(state)), state).toEqual([parada('error')]);
      expect(render(BOT, { items: [cardMessage(routineRun(state))] }), state).toMatch(CARD_FRAME);
    }
    for (const state of ['completed', 'running', 'interrupted'] as const) {
      const html = render(BOT, { items: [cardMessage(routineRun(state))] });
      expect(faiscas(html), state).toEqual([]);
      expect(html, state).toContain('lucide-calendar-clock');
      expect(html, state).toMatch(LINE_ICON);
      expect(html, state).not.toMatch(CARD_FRAME);
    }
  });

  it('cartões que pedem o dono (aprovação respondida, proposta e alteração de rotina) ficam emoldurados, neutros e sem Faísca; os informativos viram linha sem moldura (A12 e A14)', () => {
    const framed: SystemCard[] = [
      approval('approved'),
      { type: 'routine_proposal', proposal: { ...SCHEDULE, name: 'Resumo', instruction: 'Resuma o dia.' }, summary: 'Todo dia às 07:00', nextRuns: [], status: 'pending', routineId: null },
      { type: 'routine_change', routineId: null, routineName: 'Resumo', change: { action: 'pause' }, status: 'pending' },
    ];
    const framedHtml = render(BOT, { items: framed.map((card) => cardMessage(card)) });
    expect(framedHtml.match(/<section aria-label=/g)).toHaveLength(framed.length);
    expect(faiscas(framedHtml)).toEqual([]);
    expect(framedHtml.match(new RegExp(LEGEND_ICON, 'g'))).toHaveLength(framed.length);
    expect(framedHtml.match(new RegExp(CARD_FRAME, 'g'))).toHaveLength(framed.length);
    expect(framedHtml).not.toMatch(/border-l-|grad-sheen/);

    const lines: SystemCard[] = [
      { type: 'run_interrupted', steps: [], maybeCompleted: [] },
      { type: 'model_without_tools', model: 'opencode/glm-5.1' },
      { type: 'memory_updated', version: 2, previousVersion: 1, status: 'applied', added: 1, removed: 0, size: 100, limit: 8000, preview: [] },
      { type: 'routine_missed', routineId: null, routineName: 'Relatório do dia', scheduledFor: NOW },
      { type: 'routine_refused', routineId: null, routineName: 'Resumo', action: 'create' },
      { type: 'routine_edited', routineId: null, routineName: 'Resumo' },
    ];
    const linesHtml = render(BOT, { items: lines.map((card) => cardMessage(card)) });
    expect(linesHtml.match(/<section aria-label=/g)).toHaveLength(lines.length);
    expect(faiscas(linesHtml)).toEqual([]);
    expect(linesHtml.match(new RegExp(LINE_ICON, 'g'))).toHaveLength(lines.length);
    expect(linesHtml).not.toMatch(CARD_FRAME);
  });

  it('cartão de rotina na fila ("Na fila") também fica com o ícone', () => {
    const queued: RunView = { ...run('queued'), routineName: 'Relatório do dia' };
    const html = render(BOT, { items: [userMessage()], runs: [queued] });
    expect(faiscas(html)).toEqual([]);
    expect(html).toContain('Na fila');
  });

  it('orçamento de movimento: numa conversa com todos os cartões, só a aprovação pendente se mexe (a Faísca que trabalha é a da linha fixa, fora da lista)', () => {
    const html = render(BOT, {
      items: [
        userMessage(),
        cardMessage(approval('pending')),
        cardMessage({ type: 'run_failed', code: 'RUN_FAILED' }),
        cardMessage({ type: 'run_limit', limit: 'time', steps: [] }),
        cardMessage(routineRun('completed')),
        cardMessage(routineRun('failed')),
      ],
      runs: [run('running')],
    });
    const found = faiscas(html);
    expect(found.map((faisca) => faisca.state)).toEqual(['waiting', 'error', 'error', 'error']);
    expect(found.filter((faisca) => !faisca.still).map((faisca) => faisca.state)).toEqual(['waiting']);
    expect(found.every((faisca) => faisca.decorative)).toBe(true);
  });
});

/** Resposta do bot (texto concluído). */
const answerMessage = (content: string): MessageView => ({ id: id(), runId: null, createdAt: NOW, kind: 'text', role: 'assistant', status: 'done', content });

describe('resposta do bot sem balão nem Faísca ao lado (phase 18, UI-07; A4 e A5)', () => {
  /** A resposta renderizada: o elemento `message-<id>` que guarda o texto, do começo dele até o fim do markdown. */
  const answerOf = (html: string): string => {
    const start = html.search(/<div id="message-\d+" class="w-full/);
    expect(start, 'resposta').toBeGreaterThan(-1);
    return html.slice(start, html.indexOf('</div>', start));
  };

  it.each([
    ['o bot', BOT],
    ['o Chat geral (sem bot)', null],
  ] as const)('%s: a resposta é texto direto na coluna, sem borda, sem fundo e sem Faísca, nem coluna de marcador, nem marcador de chat', (_name, bot) => {
    const html = render(bot, { items: [userMessage(), answerMessage('Um.'), answerMessage('Dois.'), userMessage('De novo'), answerMessage('Três.')] });
    expect(faiscas(html)).toEqual([]);
    expect(html).not.toContain('data-bot-marker');
    expect(html).not.toContain('lucide-message-square');
    const answer = answerOf(html);
    expect(answer).toContain('Um.');
    expect(answer).not.toMatch(/border|bg-panel|bg-surface|rounded-lg|px-4/);
  });

  it('a mensagem do dono continua em balão alinhado à direita (A5)', () => {
    const html = render(BOT, { items: [userMessage('Minha pergunta'), answerMessage('Resposta.')] });
    expect(html).toMatch(/message-group flex flex-col items-end/);
    expect(html).toMatch(/<div id="message-\d+" class="max-w-\[88%\][^"]*rounded-lg bg-surface[^"]*">Minha pergunta</);
  });
});

describe('linha de trabalho na conversa (phase 18, decisão 5 da spec; A10 e A11)', () => {
  const at = (seconds: number): string => new Date(Date.parse(NOW) + seconds * 1000).toISOString();
  const tool = (runId: string, seconds: number): MessageView => ({ id: id(), runId, createdAt: at(seconds), kind: 'activity', status: 'completed', step: 1, tool: 'table_write', label: 'Gravou', arguments: '{}', result: 'ok', detail: null, awaitingApproval: false });
  const owner = (runId: string, seconds: number): MessageView => ({ ...userMessage('Faça'), runId, createdAt: at(seconds) });
  const answer = (runId: string, seconds: number): MessageView => ({ ...answerMessage('Pronto.'), runId, createdAt: at(seconds) });

  it.each([
    ['o bot', BOT],
    ['o Chat geral', null],
  ] as const)('%s: a rodada concluída com ferramentas tem UMA linha "Trabalhou por N s · N ações", e a lista de ferramentas fica fechada', (_name, bot) => {
    const html = render(bot, { items: [owner('50', 0), tool('50', 4), tool('50', 9), answer('50', 12)] });
    expect(html.match(/Trabalhou por/g)).toHaveLength(1);
    expect(html).toContain('Trabalhou por 12 s · 2 ações');
    expect(html).not.toContain('ações executadas');
    expect(html).not.toContain('Gravou'); // nenhuma ferramenta no DOM antes de abrir a linha
    expect(faiscas(html).filter((faisca) => faisca.state === 'done')).toHaveLength(1);
  });

  it('com texto no meio da rodada a linha continua única, e uma ação só diz "1 ação"', () => {
    const html = render(BOT, { items: [owner('50', 0), tool('50', 2), { ...answerMessage('Achei.'), runId: '50', createdAt: at(3) }, tool('50', 5), answer('50', 8)] });
    expect(html.match(/Trabalhou por/g)).toHaveLength(1);
    expect(html).toContain('Trabalhou por 8 s · 2 ações');
    expect(render(BOT, { items: [owner('51', 0), tool('51', 3), answer('51', 4)] })).toContain('Trabalhou por 4 s · 1 ação');
  });

  it('a rodada sem ferramenta não tem linha de trabalho', () => {
    const html = render(BOT, { items: [owner('52', 0), answer('52', 2)] });
    expect(html).not.toContain('Trabalhou por');
    expect(html).not.toContain('aria-expanded');
  });

  it('com a execução aberta a linha diz "Executando" e não tem duração', () => {
    const html = render(BOT, { items: [owner('53', 0), tool('53', 2)], runs: [{ ...run('running'), id: '53' }] });
    expect(html).toContain('Executando 1 ação');
    expect(html).not.toContain('Trabalhou por');
  });
});

describe('Chat geral (conversa sem bot)', () => {
  it('os cartões que mostram estado levam a Faísca do Aion em `--faisca`; os informativos viram linha com ícone', () => {
    const cards: [string, SystemCard][] = [
      ['Aprovação pendente', approval('pending')],
      ['A execução falhou', { type: 'run_failed', code: 'RUN_FAILED' }],
      ['Limite atingido', { type: 'run_limit', limit: 'steps', steps: [] }],
    ];
    const html = render(null, { items: cards.map(([, card]) => cardMessage(card)) });
    expect(faiscas(html).map((faisca) => [faisca.state, faisca.body, faisca.size, faisca.still])).toEqual([
      ['waiting', AION_BODY, 32, false],
      ['error', AION_BODY, 32, true],
      ['error', AION_BODY, 32, true],
    ]);
    for (const [label] of cards) expect(cardHtml(html, label), label).not.toMatch(LEGEND_ICON);
    const interrupted = render(null, { items: [cardMessage({ type: 'run_interrupted', steps: [], maybeCompleted: [] })] });
    expect(faiscas(interrupted)).toEqual([]);
    expect(cardHtml(interrupted, 'Execução interrompida')).not.toMatch(LEGEND_ICON);
    expect(interrupted).toMatch(LINE_ICON); // informativa: linha, sem moldura
    // Sem bot não há onde gravar a regra permanente: o menu de "sempre" não existe.
    expect(html).not.toContain('Mais opções de resposta');
  });
});

describe('barra de ações das mensagens (phase 4, T1; F6 e F7)', () => {
  /** Resposta de uma execução, com o modelo que a view traz. */
  const runAnswer = (content: string, runId: string, model: string | null): MessageView => ({ ...answerMessage(content), runId, model } as MessageView);
  /** Cada barra renderizada: se está fixa (sempre visível) e o modelo mostrado. */
  const bars = (html: string) =>
    [...html.matchAll(/<div data-message-actions=""( data-pinned="")?[^>]*>(.*?)<span role="status"/g)].map((match) => ({
      pinned: match[1] !== undefined,
      model: /<span title="([^"]+)"/.exec(match[2] ?? '')?.[1] ?? null,
    }));

  it('cada mensagem do dono e só a última bolha de cada resposta levam a barra; a última resposta fica fixa e a resposta antiga não mostra modelo', () => {
    for (const bot of [BOT, null]) {
      const html = render(bot, {
        items: [
          userMessage('Primeira'),
          runAnswer('Vou pesquisar.', '900', null), // intermediária da execução antiga: sem barra
          runAnswer('Resposta antiga.', '900', null),
          userMessage('Segunda'),
          runAnswer('Resposta nova.', '901', 'opencode/glm-5.1'),
        ],
      });
      expect(bars(html), bot ? 'bot' : 'Chat geral').toEqual([
        { pinned: false, model: null },
        { pinned: false, model: null },
        { pinned: false, model: null },
        { pinned: true, model: 'opencode/glm-5.1' },
      ]);
      expect(html.match(/aria-label="Copiar"/g)).toHaveLength(4);
    }
  });
});
describe('nome do modelo no cartão e na barra de resposta (phase 18, registro de 14/11/2026)', () => {
  it('a barra de resposta mostra o nome completo do modelo (com o display_name da Anthropic), no texto e no title; sem perfil, o id local do OpenCode Go', () => {
    const html = render(BOT, { items: [userMessage('Oi'), { ...answerMessage('Pronto.'), runId: '900', model: 'anthropic/claude-haiku-5-5' } as MessageView] });
    expect(html).toContain('title="anthropic/Claude Haiku 5.5"');
    expect(html).toContain('>anthropic/Claude Haiku 5.5<');
    expect(html).not.toContain('claude-haiku-5-5');
    const plain = render(BOT, { items: [userMessage('Oi'), { ...answerMessage('Pronto.'), runId: '900', model: 'opencode/glm-5.1' } as MessageView] });
    expect(plain).toContain('>opencode/glm-5.1<');
  });

  it('o aviso "Modelo sem ferramentas" diz o nome completo do modelo, não o id da Anthropic', () => {
    const html = cardHtml(render(BOT, { items: [cardMessage({ type: 'model_without_tools', model: 'anthropic/claude-haiku-5-5' })] }), 'Modelo sem ferramentas');
    expect(html).toContain('anthropic/Claude Haiku 5.5');
    expect(html).not.toContain('claude-haiku-5-5');
  });
});

describe('barra de ações no celular (phase 18, A16)', () => {
  /** A classe de cada barra renderizada, na ordem da conversa. */
  const barClasses = (html: string) => [...html.matchAll(/<div data-message-actions=""[^>]*class="([^"]*)"/g)].map((match) => match[1] ?? '');

  it('só a última resposta mostra a barra no celular; a das respostas antigas some sem reservar espaço e a da mensagem do dono fica', () => {
    for (const bot of [BOT, null]) {
      const html = render(bot, { items: [userMessage('Primeira'), { ...answerMessage('Resposta antiga.'), runId: '900' } as MessageView, userMessage('Segunda'), { ...answerMessage('Resposta nova.'), runId: '901' } as MessageView] });
      const hidden = barClasses(html).map((className) => className.includes('pointer-coarse:hidden'));
      expect(hidden, bot ? 'bot' : 'Chat geral').toEqual([false, true, false, false]);
    }
  });
});

describe('complemento durante a execução (phase 4, T2; F5)', () => {
  const complement = (content: string): ComplementView => ({ id: id(), content, attachments: [], createdAt: NOW });

  it('o pendente aparece no fim com o selo "Complemento · aguardando" e "Cancelar", com a execução em curso; o lido leva a legenda "complemento"', () => {
    for (const bot of [BOT, null]) {
      const active = { ...run('running'), complements: [complement('E inclua março.')] };
      const html = render(bot, { items: [userMessage('Resuma'), { ...userMessage('Use a planilha nova'), complement: true } as MessageView], runs: [active] });
      expect(html).toContain('Complemento · aguardando');
      expect(html.match(/>Cancelar</g)).toHaveLength(1);
      // A legenda fica acima da bolha lida (só nela), e a mensagem comum não a leva.
      expect(html.match(/>complemento</g)).toHaveLength(1);
      expect(html.indexOf('>complemento<')).toBeLessThan(html.indexOf('Use a planilha nova'));
      expect(html.indexOf('Resuma')).toBeLessThan(html.indexOf('>complemento<'));
    }
  });

  it('sem execução ativa não há bolha de complemento', () => {
    expect(render(BOT, { items: [userMessage('Oi')], runs: [] })).not.toContain('Complemento · aguardando');
  });
});

describe('versões na sessão do Chat geral (phase 4, T4; F1 a F4)', () => {
  const VERSIONS: VersionHandlers = {
    edit: async () => ({ ok: true }),
    regenerate: async () => undefined,
    rewind: async () => true,
    restore: async () => undefined,
    choose: async () => true,
  };
  const user = (messageId: string, content: string): MessageView => ({ id: messageId, runId: null, createdAt: NOW, kind: 'text', role: 'user', status: 'done', content });
  const answer = (messageId: string, runId: string, content: string): MessageView => ({ id: messageId, runId, createdAt: NOW, kind: 'text', role: 'assistant', status: 'done', content, model: 'opencode/glm-5.1' });
  /** Rodada 1: segunda de duas versões da mensagem; rodada 2: primeira de duas versões da resposta. */
  const items = (): MessageView[] => [user('11', 'Pergunta editada'), answer('12', '100', 'Resposta um.'), user('13', 'Segunda pergunta'), answer('14', '200', 'Resposta dois.')];
  const rounds = [
    { messageId: '11', runId: '100', messageVersions: ['10', '11'], runVersions: ['100'] },
    { messageId: '13', runId: '200', messageVersions: ['13'], runVersions: ['200', '201'] },
  ];

  it('mensagem com seletor "2/2" e Editar; resposta com seletor "1/2" e "Mais ações"; as pontas do seletor ficam desabilitadas', () => {
    const html = render(null, { items: items(), rounds }, VERSIONS);
    expect(html).toContain('aria-label="Versão 2 de 2"');
    expect(html).toContain('aria-label="Versão 1 de 2"');
    expect(html.match(/aria-label="Editar"/g)).toHaveLength(2);
    expect(html.match(/aria-label="Mais ações"/g)).toHaveLength(2);
    // Mensagem na última versão: "Próxima versão" desabilitada; resposta na primeira: "Versão anterior" desabilitada.
    expect(html).toMatch(/aria-label="Próxima versão"[^>]*disabled=""/);
    expect(html).toMatch(/aria-label="Versão anterior"[^>]*disabled=""/);
    expect(html).not.toContain('aria-disabled="true"');
  });

  it('com execução aberta os controles ficam aria-disabled (focáveis) e Copiar não; o bot, linear, só tem Copiar', () => {
    const busy = render(null, { items: items(), rounds, runs: [run('running')] }, VERSIONS);
    expect(busy).toMatch(/aria-label="Editar" aria-disabled="true"/);
    expect(busy).not.toMatch(/aria-label="Copiar" aria-disabled/);
    const bot = render(BOT, { items: items() });
    expect(bot).not.toContain('aria-label="Editar"');
    expect(bot).not.toContain('Mais ações');
    expect(bot).not.toContain('Versão anterior');
  });

  it('depois de retroceder a linha "N rodadas retrocedidas · Restaurar" fecha a conversa; com uma mensagem nova na fila ela some', () => {
    expect(render(null, { items: items(), rounds, rewound: { runId: '200', rounds: 2 } }, VERSIONS)).toContain('2 rodadas retrocedidas');
    expect(render(null, { items: items(), rounds, rewound: { runId: '200', rounds: 1 } }, VERSIONS)).toContain('1 rodada retrocedida');
    expect(render(null, { items: items(), rounds, rewound: { runId: '200', rounds: 2 }, runs: [run('queued')] }, VERSIONS)).not.toContain('retrocedida');
  });

  it('a execução de uma versão nova, já no caminho, não aparece como "Na fila": a linha da Faísca cobre a espera', () => {
    const queued = { ...run('queued'), id: '201', input: 'Segunda pergunta' };
    const html = render(null, { items: items().slice(0, 3), rounds: [rounds[0]!, { ...rounds[1]!, runId: '201' }], runs: [queued] }, VERSIONS);
    expect(html).not.toContain('Na fila');
    expect(html.match(/Segunda pergunta/g)).toHaveLength(1);
  });
});

// O estado incompleto permanece visível e a continuação só é oferecida na fronteira sem execução ativa.
describe('continuação após limite de saída', () => {
  it('exibe a continuação automática ativa sem oferecer uma segunda continuação manual', () => {
    const automatic = cardMessage({ type: 'run_limit', limit: 'tokens', steps: [], continuation: { automatic: true, count: 1, consecutiveCuts: 1, confirmedTools: 0 } });
    const html = render(BOT, { items: [automatic], runs: [run('running')] });
    expect(html).toContain('Continuação automática 1/3');
    expect(html).not.toContain('>Continuar<');
  });
  it('marca texto incompleto e oferece Continuar apenas quando a conversa está parada', () => {
    const runId = id();
    const partial: MessageView = { id: id(), runId, createdAt: NOW, kind: 'text', role: 'assistant', status: 'done', content: 'Trecho parcial', incomplete: true };
    const limit: CardView = { ...cardMessage({ type: 'run_limit', limit: 'tokens', steps: ['Gravou lançamento'] }), runId };
    const html = render(BOT, { items: [partial, limit] });
    expect(html).toContain('Resposta incompleta: limite de saída atingido.');
    expect(html).toContain('Continuar');
    expect(render(BOT, { items: [partial, limit], runs: [run('queued')] })).not.toContain('>Continuar<');
    for (const cause of ['steps', 'time'] as const) {
      const latest: CardView = { ...cardMessage({ type: 'run_limit', limit: cause, steps: [] }), runId };
      expect(render(BOT, { items: [partial, limit, latest] })).not.toContain('>Continuar<');
    }

  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Artefatos da resposta (phase 14, passo 7; A4): o cartão de cada tabela ou doc que o bot criou ou alterou, derivado da atividade (`activity.artifacts`, passo 4), sem cartão de
// sistema. O painel (A5 e A6) e o endereço `?artefato=` são provados mais abaixo e o comportamento no navegador real é do E2E.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

const PLANO: ArtifactRef = { type: 'doc', id: '8f0c2f4e-5f5f-4f7a-9d7e-1f8a6a1d0003', title: 'Plano' };
const TAREFAS: ArtifactRef = { type: 'table', id: '8f0c2f4e-5f5f-4f7a-9d7e-1f8a6a1d0001', title: 'Tarefas' };

/** Chamada de ferramenta concluída de uma execução; `artifacts` só existe na que criou ou alterou tabela ou doc (passo 4), `files` são os anexos gerados pelo Python. */
const toolCall = (runId: string, tool: string, artifacts?: ArtifactRef[], files: ConversationAttachment[] = []): MessageView => ({
  id: id(),
  runId,
  createdAt: NOW,
  kind: 'activity',
  status: 'completed',
  step: 1,
  tool,
  label: `Executou ${tool}`,
  arguments: '{}',
  result: 'ok',
  detail: null,
  awaitingApproval: false,
  attachments: files,
  ...(artifacts === undefined ? {} : { artifacts }),
});

/** Resposta de texto de uma execução. */
const replyOf = (runId: string, content: string): MessageView => ({ ...answerMessage(content), runId });

/** Os cartões de artefato renderizados: o endereço do link, o texto que ele diz (tipo e título; o "Abrir" é só para leitor de tela) e se é o aberto no painel. */
function artifactCards(html: string) {
  const lists = [...html.matchAll(/<ul aria-label="Artefatos desta resposta"[^>]*>(.*?)<\/ul>/gs)];
  return lists.flatMap((list) =>
    [...(list[1] ?? '').matchAll(/<li[^>]*><a ([^>]*)>(.*?)<\/a><\/li>/gs)].map((item) => ({
      href: /href="([^"]*)"/.exec(item[1] ?? '')?.[1],
      text: (item[2] ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
      current: (item[1] ?? '').includes('aria-current="true"'),
    })),
  );
}

describe('cartões de artefato na resposta (phase 14, passo 7; A4)', () => {
  it('a resposta que cria o doc "Plano" e altera duas vezes a tabela "Tarefas" mostra exatamente dois cartões, um por artefato, com tipo, título e o link que o abre', () => {
    const runId = '700';
    const html = render(BOT, {
      items: [userMessage('Organize'), toolCall(runId, 'doc_create', [PLANO]), toolCall(runId, 'table_write', [TAREFAS]), toolCall(runId, 'table_write', [TAREFAS]), replyOf(runId, 'Pronto.')],
    });
    expect(artifactCards(html)).toEqual([
      { href: artifactHref(PLANO), text: 'Abrir Doc Plano', current: false },
      { href: artifactHref(TAREFAS), text: 'Abrir Tabela Tarefas', current: false },
    ]);
    // Os cartões ficam sob o texto da resposta, e a referência vem da atividade: nenhum cartão de sistema é desenhado por causa dela.
    expect(html.indexOf('Pronto.')).toBeLessThan(html.indexOf('Artefatos desta resposta'));
    expect(html).not.toContain('<section aria-label=');
    // A15: rodada com o dono, 3 ferramentas, resposta e doc criado não tem nenhum cartão emoldurado (só a lista de linhas de artefato).
    expect(html).not.toMatch(CARD_FRAME);
  });

  it('chamada que não cria nem altera artefato (leitura, busca) não gera cartão', () => {
    const runId = '701';
    const html = render(BOT, { items: [userMessage('Leia'), toolCall(runId, 'doc_read'), toolCall(runId, 'table_query', []), replyOf(runId, 'Li.')] });
    expect(artifactCards(html)).toEqual([]);
    expect(html).not.toContain('Artefatos desta resposta');
  });

  it('execução sem texto (falhou ou foi parada) mostra os cartões sob o último grupo de atividades, para nunca sumirem', () => {
    const runId = '702';
    const html = render(BOT, { items: [userMessage('Crie'), toolCall(runId, 'doc_create', [PLANO])] });
    expect(artifactCards(html).map((card) => card.text)).toEqual(['Abrir Doc Plano']);
  });

  it('um cartão por artefato por resposta: o mesmo artefato em duas respostas tem um cartão em cada, e o título é o do último fechamento da resposta', () => {
    const html = render(BOT, {
      items: [
        userMessage('Primeiro'),
        toolCall('710', 'table_write', [TAREFAS]),
        replyOf('710', 'Feito um.'),
        userMessage('Segundo'),
        toolCall('711', 'table_update', [TAREFAS]),
        toolCall('711', 'table_update', [{ ...TAREFAS, title: 'Tarefas 2026' }]),
        replyOf('711', 'Feito dois.'),
      ],
    });
    expect(artifactCards(html).map(({ href, text }) => ({ href, text }))).toEqual([
      { href: artifactHref(TAREFAS), text: 'Abrir Tabela Tarefas' },
      { href: artifactHref(TAREFAS), text: 'Abrir Tabela Tarefas 2026' },
    ]);
    // O cartão de cada resposta fica sob a bolha dela: o primeiro entre "Feito um." e a mensagem seguinte do dono, o segundo depois de "Feito dois.".
    const firstList = html.indexOf('Artefatos desta resposta');
    expect(html.indexOf('Feito um.')).toBeLessThan(firstList);
    expect(firstList).toBeLessThan(html.indexOf('Segundo'));
    expect(html.lastIndexOf('Artefatos desta resposta')).toBeGreaterThan(html.indexOf('Feito dois.'));
  });

  it('o título é texto do doc: nunca interpretado como marcação', () => {
    const hostile = { ...PLANO, title: 'Plano <script>x</script> & cia' };
    const html = render(BOT, { items: [userMessage('Crie'), toolCall('720', 'doc_create', [hostile]), replyOf('720', 'Pronto.')] });
    expect(html).toContain('Plano &lt;script&gt;x&lt;/script&gt; &amp; cia');
    expect(html).not.toContain('<script>');
  });

  it('o cartão do artefato aberto no painel é marcado como o atual (aria-current) e os outros não', () => {
    const items = [userMessage('Organize'), toolCall('730', 'doc_create', [PLANO]), toolCall('730', 'table_write', [TAREFAS]), replyOf('730', 'Pronto.')];
    expect(artifactCards(render(BOT, { items }, null, `doc:${PLANO.id}`)).map((card) => card.current)).toEqual([true, false]);
    expect(artifactCards(render(BOT, { items }, null, `table:${TAREFAS.id}`)).map((card) => card.current)).toEqual([false, true]);
    expect(artifactCards(render(BOT, { items }, null, null)).map((card) => card.current)).toEqual([false, false]);
  });
});

// Caracterização (phase 4, F10) do lugar dos arquivos gerados pelo Python, que o passo 7 compartilha com os cartões de artefato: roda verde antes e depois de a âncora virar uma só.
describe('onde ficam os arquivos gerados pelo Python (caracterização)', () => {
  const file = (name: string): ConversationAttachment => ({ id: id(), name, kind: 'generated', sizeBytes: 10, removed: false });

  it('ficam sob a última bolha de texto da execução e, sem texto, sob o último grupo de atividades dela', () => {
    const [a, b, c] = [file('a.csv'), file('b.csv'), file('c.csv')];
    const firstCall = toolCall('800', 'run_python', undefined, [a]);
    const secondCall = toolCall('800', 'run_python', undefined, [b]);
    const answer = replyOf('800', 'Feito.');
    const noText = toolCall('801', 'run_python', undefined, [c]);
    const blocks = buildBlocks([userMessage('Gere'), firstCall, replyOf('800', 'Vou salvar.'), secondCall, answer, userMessage('Outra'), noText]);
    expect(generatedFilesOf(blocks)).toEqual(
      new Map([
        [answer.id, [a, b]],
        [noText.id, [c]],
      ]),
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Onde cada cartão fica e o endereço do painel (phase 14, passo 7; A4, A5, A6, A7)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

describe('artifactsOf: de onde vêm os cartões de cada resposta', () => {
  it('agrupa por execução, tipo e id (ordem da primeira vez, título do último fechamento) e ancora sob a última bolha de texto ou, sem texto, o último grupo de atividades', () => {
    const createDoc = toolCall('900', 'doc_create', [PLANO]);
    const writeTable = toolCall('900', 'table_write', [TAREFAS]);
    const renameTable = toolCall('900', 'table_update', [{ ...TAREFAS, title: 'Tarefas 2026' }]);
    const answer = replyOf('900', 'Pronto.');
    const readOnly = toolCall('901', 'doc_read');
    const failedRun = toolCall('902', 'doc_update', [PLANO]);
    const blocks = buildBlocks([userMessage('Organize'), createDoc, writeTable, renameTable, answer, userMessage('Leia'), readOnly, userMessage('Edite'), failedRun]);
    expect(artifactsOf(blocks)).toEqual(
      new Map([
        [answer.id, [PLANO, { ...TAREFAS, title: 'Tarefas 2026' }]],
        [failedRun.id, [PLANO]],
      ]),
    );
  });
});

describe('o endereço do artefato aberto no painel (?artefato=<tipo>:<id>)', () => {
  it('ida e volta: o que o cartão escreve é o que a conversa lê, e cada tipo tem a página própria dele', () => {
    expect(ARTIFACT_PARAM).toBe('artefato');
    expect(artifactKey(PLANO)).toBe(`doc:${PLANO.id}`);
    expect(artifactKey(TAREFAS)).toBe(`table:${TAREFAS.id}`);
    expect(parseArtifactKey(artifactKey(PLANO))).toEqual({ type: 'doc', id: PLANO.id });
    expect(parseArtifactKey(artifactKey(TAREFAS))).toEqual({ type: 'table', id: TAREFAS.id });
    expect(artifactPageHref(PLANO)).toBe(`/artefatos/docs/${PLANO.id}`);
    expect(artifactPageHref(TAREFAS)).toBe(`/artefatos/tabelas/${TAREFAS.id}`);
  });

  // O valor vem da URL (digitada ou colada): só o formato exato chega a virar caminho de API; o resto fecha o painel em vez de abrir.
  it.each([
    ['ausente', null],
    ['vazio', ''],
    ['sem id', 'doc'],
    ['id vazio', 'doc:'],
    ['id que não é UUID', 'doc:plano'],
    ['tipo desconhecido', `sheet:${PLANO.id}`],
    ['tipo em maiúsculas', `DOC:${PLANO.id}`],
    ['caminho depois do id', `doc:${PLANO.id}/../x`],
    ['espaço depois do id', `doc:${PLANO.id} `],
    ['dois pares', `doc:${PLANO.id},table:${TAREFAS.id}`],
    ['marcação', '<script>alert(1)</script>'],
  ])('recusa o valor %s', (_name, value) => {
    expect(parseArtifactKey(value)).toBeNull();
  });
});

describe('painel do artefato (phase 14, passo 7; A5, A6, A7)', () => {
  /** O painel como a conversa o monta, sem navegador: a moldura (nome, Voltar, Fechar e o link da página própria) é o que o servidor desenha; o artefato carrega no cliente. */
  function Panel({ target }: { target: { type: 'doc' | 'table'; id: string } }) {
    const guard = useDiscardGuard();
    return <ArtifactPanel target={target} guard={guard} onClose={() => undefined} />;
  }
  const panel = (target: { type: 'doc' | 'table'; id: string }): string =>
    renderToStaticMarkup(
      <SessionProvider session={SESSION}>
        <TooltipProvider>
          <Panel target={target} />
        </TooltipProvider>
      </SessionProvider>,
    );
  /** A tag de abertura do botão ou link com o nome acessível dado. */
  const tagOf = (html: string, label: string): string => new RegExp(`<(?:button|a)[^>]*aria-label="${label}"[^>]*>`).exec(html)?.[0] ?? '';

  it('abre ao lado da conversa com nome acessível próprio de cada tipo, e o "Abrir em tela inteira" leva à página própria do artefato (A7)', () => {
    const doc = panel(PLANO);
    expect(doc).toContain('<aside aria-label="Painel do doc"');
    expect(doc).toMatch(new RegExp(`<a [^>]*href="/artefatos/docs/${PLANO.id}"[^>]*>(?:(?!</a>).)*Abrir em tela inteira`));
    const table = panel(TAREFAS);
    expect(table).toContain('<aside aria-label="Painel da tabela"');
    expect(table).toMatch(new RegExp(`<a [^>]*href="/artefatos/tabelas/${TAREFAS.id}"[^>]*>(?:(?!</a>).)*Abrir em tela inteira`));
  });

  it('no celular o painel é a tela cheia com "Voltar"; ao lado da conversa o mesmo controle é "Fechar painel" (um só aparece em cada largura, pela largura da conversa)', () => {
    const html = panel(PLANO);
    // Voltar: visível por padrão (conversa estreita) e some quando a conversa é larga o bastante para o painel caber ao lado.
    expect(tagOf(html, 'Voltar')).toContain('@4xl/conversation:hidden');
    // Fechar painel: escondido por padrão e visível só com a conversa larga.
    expect(tagOf(html, 'Fechar painel')).toMatch(/class="[^"]*\bhidden\b[^"]*@4xl\/conversation:inline-flex/);
    // Estreita, o painel cobre a conversa (absoluto sobre ela); larga, ocupa a própria coluna.
    expect(html).toMatch(/<aside[^>]*class="[^"]*\babsolute\b[^"]*@4xl\/conversation:static/);
  });
});

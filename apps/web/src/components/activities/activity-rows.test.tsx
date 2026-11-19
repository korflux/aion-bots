// Prova da Faísca nas linhas de Atividades (phase 5, A1 e A2): o avatar de 24 px de cada linha é a Faísca PARADA, na cor do bot (ou em `--faisca` no Chat geral), no estado
// que a função única `mascotStateOfRunStatus` dá ao status da execução, e é decorativa, com o estado dito em texto. Renderização no servidor, sem DOM; o visual (tamanho,
// contraste) é provado no navegador (E2E e captura).
import { RUN_STATUSES, RUN_STATUS_LABELS, mascotStateOfRunStatus, type PendingActivity, type RecentActivity, type RunStatus } from '@aion/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PendingRow, RecentRow } from './activity-rows';

const BOT = { id: '8f0c2f4e-5f5f-4f7a-9d7e-1f8a6a1d0001', name: 'Alfa', color: '#FB923C', archived: false };
const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const SESSION_ID = '0b6d4b8e-7d63-4a54-9f55-3a2a0c1e0002';

const recent = (status: RunStatus, owner: Pick<RecentActivity, 'bot' | 'sessionId'> = { bot: BOT, sessionId: null }): RecentActivity => ({
  runId: '7',
  ...owner,
  routineName: null,
  status,
  createdAt: '2026-10-04T11:58:00.000Z',
  messageId: '70',
});
const pending: PendingActivity = {
  approvalId: '3',
  runId: '7',
  bot: BOT,
  sessionId: null,
  actionLabel: 'Send Email · Gmail',
  expiresAt: '2026-10-05T12:00:00.000Z',
  messageId: '31',
};

const renderRecent = (item: RecentActivity): string => renderToStaticMarkup(<RecentRow item={item} now={NOW} stopping={false} onStop={() => undefined} />);

/** O que o HTML guarda de cada Faísca da linha (atributos do `<svg class="faisca">`). */
function faiscas(html: string) {
  return [...html.matchAll(/<svg[^>]*class="faisca[^"]*"[^>]*>/g)].map((match) => {
    const tag = match[0];
    return {
      state: /data-state="(\w+)"/.exec(tag)?.[1],
      detail: /data-detail="(\w+)"/.exec(tag)?.[1],
      size: Number(/width="(\d+)"/.exec(tag)?.[1]),
      body: /--faisca-body:([^;"]+)/.exec(tag)?.[1],
      still: tag.includes('data-still'),
      enter: tag.includes('data-enter'),
      looking: tag.includes('data-look'),
      decorative: tag.includes('aria-hidden="true"') && !tag.includes('role='),
    };
  });
}

describe('execuções recentes', () => {
  it('cada linha de bot tem a Faísca de 24 px parada, na cor do bot', () => {
    expect(faiscas(renderRecent(recent('completed')))).toEqual([
      { state: 'done', detail: 'small', size: 24, body: '#FB923C', still: true, enter: false, looking: false, decorative: true },
    ]);
  });

  it('o estado da Faísca vem do status da execução pela função única, em todos os status', () => {
    const expected: Record<RunStatus, string> = {
      queued: 'idle',
      running: 'working',
      waiting_approval: 'waiting',
      completed: 'done',
      failed: 'error',
      expired: 'error',
      limit_reached: 'error',
      interrupted: 'idle',
      cancelled: 'idle',
    };
    for (const status of RUN_STATUSES) {
      const [faisca] = faiscas(renderRecent(recent(status)));
      expect(faisca?.state, status).toBe(expected[status]);
      expect(faisca?.state, `${status} pela função única`).toBe(mascotStateOfRunStatus(status));
      expect(faisca?.still, `${status} parada`).toBe(true); // lista não anima: nem o trabalhando
    }
  });

  it('o estado continua dito em texto: o selo do status da execução, e a Faísca não leva nome próprio', () => {
    for (const status of RUN_STATUSES) {
      const html = renderRecent(recent(status));
      expect(html, status).toContain(`>${RUN_STATUS_LABELS[status]}</span>`);
      expect(html).not.toContain('role="img"');
    }
  });

  it('a execução do chat geral (sem bot) mostra a Faísca do Aion em `--faisca`, parada, e o nome "Chat geral", sem marcador de chat', () => {
    const html = renderRecent(recent('running', { bot: null, sessionId: SESSION_ID }));
    expect(faiscas(html)).toEqual([{ state: 'working', detail: 'small', size: 24, body: 'var(--faisca)', still: true, enter: false, looking: false, decorative: true }]);
    expect(html).not.toContain('lucide-message-square');
    expect(html).toContain('Chat geral');
  });
});

describe('aguardando você', () => {
  it('a pendência mostra a Faísca aguardando, parada, na cor do bot', () => {
    const html = renderToStaticMarkup(<PendingRow item={pending} now={NOW} />);
    expect(faiscas(html)).toEqual([{ state: 'waiting', detail: 'small', size: 24, body: '#FB923C', still: true, enter: false, looking: false, decorative: true }]);
    expect(html).toContain('Send Email · Gmail');
  });

  it('a pendência mostra a conta do conector da ação (nome do dono ou rótulo automático), e a sem conta fica como era (phase 13, A9)', () => {
    const named = renderToStaticMarkup(<PendingRow item={{ ...pending, accountLabel: 'Pessoal' }} now={NOW} />);
    expect(named).toContain('Send Email · Gmail');
    expect(named).toContain('Conta: Pessoal');
    expect(renderToStaticMarkup(<PendingRow item={{ ...pending, accountLabel: 'Gmail · ca_…1a2b' }} now={NOW} />)).toContain('Conta: Gmail · ca_…1a2b');
    // Pendência de ação sem conta (as categorias de tabelas) ou anterior à phase: nenhuma linha de conta.
    expect(renderToStaticMarkup(<PendingRow item={pending} now={NOW} />)).not.toContain('Conta:');
  });

  // A35 (decisão 23, phase 14): a linha pendente de uma exclusão de doc mostra o título do doc na linha abaixo da ação, como a conta da phase 13, vindo pronto do servidor; sem título (ação de conector, tabela, pendência antiga), nenhuma linha.
  it('a pendência de exclusão de doc mostra o título do doc na linha abaixo da ação, e as demais seguem como eram (A35)', () => {
    const doc: PendingActivity = { ...pending, actionLabel: 'Excluir doc', docTitle: 'Plano' };
    const html = renderToStaticMarkup(<PendingRow item={doc} now={NOW} />);
    expect(html).toContain('Excluir doc');
    expect(html).toContain('Doc: Plano');
    expect(html).not.toContain('Conta:');
    // O título é texto do doc: nunca interpretado como marcação.
    expect(renderToStaticMarkup(<PendingRow item={{ ...doc, docTitle: 'Plano <b>x</b>' }} now={NOW} />)).toContain('Doc: Plano &lt;b&gt;x&lt;/b&gt;');
    expect(renderToStaticMarkup(<PendingRow item={pending} now={NOW} />)).not.toContain('Doc:');
  });

  it('a pendência do chat geral mostra a Faísca do Aion aguardando, em `--faisca`', () => {
    const html = renderToStaticMarkup(<PendingRow item={{ ...pending, bot: null, sessionId: SESSION_ID }} now={NOW} />);
    expect(faiscas(html)).toEqual([{ state: 'waiting', detail: 'small', size: 24, body: 'var(--faisca)', still: true, enter: false, looking: false, decorative: true }]);
    expect(html).not.toContain('lucide-message-square');
  });
});

// Prova da prévia da última novidade do bot (phase 5, T5; spec F4, Suposição 12): funções puras, sem banco. A leitura da última novidade no SQL é provada
// em `bots.test.ts`, contra PostgreSQL real.
//
// Casos: a primeira linha com texto depois de tirar o Markdown (cada tipo de marcação), a linha só de marcação que é pulada, o corte em 120 caracteres
// (fronteira exata, emoji contando 1) e o título de cada tipo de cartão, inclusive o tipo desconhecido que não derruba a lista.
import { BOT_PREVIEW_EMPTY, BOT_PREVIEW_MAX, type SystemCard } from '@aion/shared';
import { describe, expect, it } from 'vitest';
import { cardTitleOf, clipPreview, firstPlainLine, previewOf } from './preview';

describe('primeira linha sem Markdown', () => {
  it('tira cada marcação e fica só com o texto', () => {
    const cases: [string, string][] = [
      ['# Relatório do dia', 'Relatório do dia'],
      ['### Subtítulo **forte**', 'Subtítulo forte'],
      ['> citação *em itálico*', 'citação em itálico'],
      ['- item de lista', 'item de lista'],
      ['* outro item', 'outro item'],
      ['12. passo numerado', 'passo numerado'],
      ['3) outro passo', 'outro passo'],
      ['- [x] tarefa feita', 'tarefa feita'],
      ['**Pronto**: veja o [relatório](https://exemplo.com/r?a=1) agora', 'Pronto: veja o relatório agora'],
      ['![gráfico de vendas](https://exemplo.com/g.png) abaixo', 'gráfico de vendas abaixo'],
      ['use `pnpm test` para rodar', 'use pnpm test para rodar'],
      ['~~antigo~~ novo __negrito__ _itálico_', 'antigo novo negrito itálico'],
      ['veja <https://exemplo.com/a> e <b>tag</b>', 'veja https://exemplo.com/a e tag'],
      ['a_b_c e snake_case_nome ficam', 'a_b_c e snake_case_nome ficam'],
      ['2 * 3 * 4 = 24', '2 * 3 * 4 = 24'],
      ['escapado \\*não\\* vira', 'escapado *não* vira'],
      ['  muito   espaço\t aqui  ', 'muito espaço aqui'],
      ['| Nome | Valor |', 'Nome Valor'],
    ];
    for (const [markdown, expected] of cases) expect(firstPlainLine(markdown), markdown).toBe(expected);
  });

  it('pula linhas vazias, cercas de código, réguas e separadores de tabela e usa a primeira linha que sobra com texto', () => {
    expect(firstPlainLine('\n\n   \nOlá, tudo bem?\nSegunda linha.')).toBe('Olá, tudo bem?');
    expect(firstPlainLine('```python\nprint(1)\n```')).toBe('print(1)');
    expect(firstPlainLine('~~~\ncódigo\n~~~')).toBe('código');
    expect(firstPlainLine('---\n***\n___\n- - -\nDepois da régua')).toBe('Depois da régua');
    expect(firstPlainLine('|---|:---:|\n| a | b |')).toBe('a b');
    expect(firstPlainLine('\r\n\r\nLinha com CRLF\r\nOutra')).toBe('Linha com CRLF');
    expect(firstPlainLine('')).toBe('');
    expect(firstPlainLine('---\n```\n  \n')).toBe('');
  });

  it('uma linha enorme é tratada só nos primeiros caracteres (o resto nunca aparece e não custa)', () => {
    const huge = `**${'a'.repeat(50_000)}`;
    const started = performance.now();
    expect(firstPlainLine(huge).length).toBeGreaterThan(100);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('corte em 120 caracteres', () => {
  it('deixa passar até o limite e corta acima dele com reticências, sem nunca passar de 120 (pontos de código)', () => {
    const exact = 'a'.repeat(BOT_PREVIEW_MAX);
    expect(clipPreview(exact)).toBe(exact);
    const over = clipPreview('a'.repeat(BOT_PREVIEW_MAX + 1));
    expect(Array.from(over)).toHaveLength(BOT_PREVIEW_MAX);
    expect(over.endsWith('…')).toBe(true);
    // Emoji (par substituto) conta 1 e o corte nunca o parte ao meio.
    const emoji = clipPreview('😀'.repeat(BOT_PREVIEW_MAX + 5));
    expect(Array.from(emoji)).toHaveLength(BOT_PREVIEW_MAX);
    expect(emoji).toBe(`${'😀'.repeat(BOT_PREVIEW_MAX - 1)}…`);
    // O espaço que sobraria antes das reticências sai: "palavra …" vira "palavra…".
    expect(clipPreview(`${'a'.repeat(BOT_PREVIEW_MAX - 2)} b c`)).toBe(`${'a'.repeat(BOT_PREVIEW_MAX - 2)}…`);
  });
});

/** Cartões de cada tipo com os campos mínimos que o título lê (o restante do contrato não importa aqui). */
const CARDS: [string, SystemCard][] = [
  ['Execução interrompida', { type: 'run_interrupted', steps: [], maybeCompleted: [] }],
  ['Limite atingido', { type: 'run_limit', limit: 'steps', steps: [] }],
  ['A execução falhou', { type: 'run_failed', code: 'PROVIDER_ERROR' }],
  ['Modelo sem ferramentas', { type: 'model_without_tools', model: 'deepseek-v4' }],
  [
    'Aprovação pendente',
    { type: 'approval', approvalId: '7', status: 'pending', decision: null, action: 'GMAIL_SEND_EMAIL', actionLabel: 'Send Email', appName: 'Gmail', params: [], omitted: [], expiresAt: '2026-10-10T12:00:00.000Z' } as unknown as SystemCard,
  ],
  [
    'Aprovação',
    { type: 'approval', approvalId: '7', status: 'approved', decision: 'once', action: 'GMAIL_SEND_EMAIL', actionLabel: 'Send Email', appName: 'Gmail', params: [], omitted: [], expiresAt: '2026-10-10T12:00:00.000Z' } as unknown as SystemCard,
  ],
  ['Memória atualizada', { type: 'memory_updated', version: 2, previousVersion: 1, status: 'applied', added: 1, removed: 0, size: 10, limit: 8000, preview: [] } as unknown as SystemCard],
  [
    'Rotina “Resumo diário” concluída',
    { type: 'routine_run', routineId: null, routineName: 'Resumo diário', scheduledFor: '2026-10-10T10:00:00.000Z', startedAt: '2026-10-10T10:00:01.000Z', manual: false, state: 'completed', finishedAt: null, failureCode: null },
  ],
  ['Rotina “Resumo diário” atingiu o limite', { type: 'routine_run', routineId: null, routineName: 'Resumo diário', scheduledFor: '2026-10-10T10:00:00.000Z', startedAt: '2026-10-10T10:00:01.000Z', manual: true, state: 'limit_reached', finishedAt: null, failureCode: null }],
  ['Rotina “Resumo diário” perdida', { type: 'routine_missed', routineId: null, routineName: 'Resumo diário', scheduledFor: '2026-10-10T10:00:00.000Z' }],
  ['Proposta de rotina', { type: 'routine_proposal', proposal: {}, summary: 'Todo dia às 7h', nextRuns: [], status: 'pending', routineId: null } as unknown as SystemCard],
  ['Pausar a rotina “Resumo diário”', { type: 'routine_change', routineId: null, routineName: 'Resumo diário', change: { action: 'pause' }, status: 'pending' }],
  // Phase 10: rotina e alteração que o bot aplicou na hora (estados applied, refused, edited e superseded) e os avisos de recusa e edição do dono.
  ['Rotina criada pelo bot', { type: 'routine_proposal', proposal: {}, summary: 'Todo dia às 7h', nextRuns: [], status: 'applied', routineId: null } as unknown as SystemCard],
  ['Rotina criada pelo bot', { type: 'routine_proposal', proposal: {}, summary: 'Todo dia às 7h', nextRuns: [], status: 'refused', routineId: null } as unknown as SystemCard],
  ['Rotina “Resumo diário” pausada pelo bot', { type: 'routine_change', routineId: null, routineName: 'Resumo diário', change: { action: 'pause' }, status: 'applied' }],
  ['Rotina “Resumo diário” retomada pelo bot', { type: 'routine_change', routineId: null, routineName: 'Resumo diário', change: { action: 'resume' }, status: 'superseded' }],
  ['Rotina “Resumo diário” excluída pelo bot', { type: 'routine_change', routineId: null, routineName: 'Resumo diário', change: { action: 'delete' }, status: 'refused' }],
  ['Rotina “Resumo diário” alterada pelo bot', { type: 'routine_change', routineId: null, routineName: 'Resumo diário', change: { action: 'update', before: {}, after: {}, changed: ['name'], nextRuns: [] }, status: 'edited' } as unknown as SystemCard],
  ['Rotina “Resumo diário” confirmada', { type: 'routine_confirmed', routineId: null, routineName: 'Resumo diário', action: 'create' }],
  ['Rotina “Resumo diário” recusada', { type: 'routine_refused', routineId: null, routineName: 'Resumo diário', action: 'delete' }],
  ['Rotina “Resumo diário” editada', { type: 'routine_edited', routineId: null, routineName: 'Resumo diário' }],
];

describe('título do cartão', () => {
  it.each(CARDS)('%s', (title, card) => {
    expect(cardTitleOf(card)).toBe(title);
  });

  it('um tipo de cartão desconhecido vira um título genérico (a lista de bots nunca cai por causa de um cartão)', () => {
    expect(cardTitleOf({ type: 'tipo_do_futuro' } as unknown as SystemCard)).toBe('Atualização do sistema');
  });
});

describe('prévia da linha do bot', () => {
  it('cartão vale o título; texto vale a primeira linha limpa; sem novidade, ou só marcação, é "Nenhuma mensagem ainda"', () => {
    expect(previewOf({ text: null, card: { type: 'run_failed', code: 'X' } })).toBe('A execução falhou');
    expect(previewOf({ text: '## Tudo certo\nDetalhes abaixo', card: null })).toBe('Tudo certo');
    expect(previewOf({ text: null, card: null })).toBe(BOT_PREVIEW_EMPTY);
    expect(previewOf({ text: '---\n```\n', card: null })).toBe(BOT_PREVIEW_EMPTY);
    expect(previewOf({ text: '', card: null })).toBe(BOT_PREVIEW_EMPTY);
  });

  it('o título de uma rotina com nome enorme também respeita o limite', () => {
    const name = 'n'.repeat(300);
    const preview = previewOf({ text: null, card: { type: 'routine_missed', routineId: null, routineName: name, scheduledFor: '2026-10-10T10:00:00.000Z' } });
    expect(Array.from(preview).length).toBeLessThanOrEqual(BOT_PREVIEW_MAX);
    expect(preview.endsWith('…')).toBe(true);
  });
});

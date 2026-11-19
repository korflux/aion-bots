// Prova da regra de estado ao vivo do bot (F10, A12): a conversão única de status de execução em estado do mascote e a precedência do estado do
// bot (execução ativa > arquivado > última execução terminal > rotinas todas pausadas > livre), com relógio simulado na janela de 60 s do `done`.
import { describe, expect, it } from 'vitest';
import { RUN_STATUSES, type RunStatus } from './conversation';
import { BOT_RUN_STATES, BUSY_RUN_STATES, RUN_DONE_WINDOW_MS, botRunStateOf, botRunStateSchema, mascotStateOfRunStatus, type BotRunFacts } from './live-state';

const NOW = new Date('2026-10-03T12:00:00.000Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

/** Um bot livre (sem execução, sem rotina, ativo); cada teste sobrepõe só o que quer provar. */
const facts = (overrides: Partial<BotRunFacts> = {}): BotRunFacts => ({
  archived: false,
  activeStatus: null,
  lastTerminal: null,
  routines: { total: 0, paused: 0 },
  ...overrides,
});
const finished = (status: RunStatus, ms: number | null): BotRunFacts['lastTerminal'] => ({ status, finishedAt: ms === null ? null : ago(ms) });

describe('mascotStateOfRunStatus: o status de uma execução vira o estado do mascote (função única, sem tempo)', () => {
  it('cobre TODO status de execução, com o estado de cada um', () => {
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
    // O gabarito é percorrido por RUN_STATUSES: um status novo no contrato reprova aqui até ganhar o estado dele.
    expect(Object.keys(expected).sort()).toEqual([...RUN_STATUSES].sort());
    for (const status of RUN_STATUSES) expect(mascotStateOfRunStatus(status), status).toBe(expected[status]);
  });

  it('só devolve estados que o mascote conhece, e os estados em movimento são os três do design', () => {
    for (const status of RUN_STATUSES) expect(BOT_RUN_STATES).toContain(mascotStateOfRunStatus(status));
    expect([...BUSY_RUN_STATES]).toEqual(['working', 'waiting', 'done']);
    expect(botRunStateSchema.safeParse('trabalhando').success).toBe(false);
  });
});

describe('botRunStateOf: a precedência do estado do bot', () => {
  it('bot sem nada é livre; a fila conta como livre', () => {
    expect(botRunStateOf(facts(), NOW)).toBe('idle');
    // Uma execução na fila não entra em nenhum dos campos: nem como ativa nem como terminal.
    expect(botRunStateOf(facts({ routines: { total: 2, paused: 1 } }), NOW)).toBe('idle');
  });

  it('execução ativa: running é trabalhando e waiting_approval é aguardando', () => {
    expect(botRunStateOf(facts({ activeStatus: 'running' }), NOW)).toBe('working');
    expect(botRunStateOf(facts({ activeStatus: 'waiting_approval' }), NOW)).toBe('waiting');
  });

  it('a execução ativa vale mais que arquivado, última falha, conclusão recente e rotinas pausadas', () => {
    const noisy = {
      archived: true,
      lastTerminal: finished('failed', 1_000),
      routines: { total: 1, paused: 1 },
    };
    expect(botRunStateOf(facts({ ...noisy, activeStatus: 'running' }), NOW)).toBe('working');
    expect(botRunStateOf(facts({ ...noisy, activeStatus: 'waiting_approval' }), NOW)).toBe('waiting');
    expect(botRunStateOf(facts({ lastTerminal: finished('completed', 1_000), activeStatus: 'running' }), NOW)).toBe('working');
  });

  it('bot arquivado dorme, mesmo com falha ou conclusão recente e sem execução ativa', () => {
    expect(botRunStateOf(facts({ archived: true }), NOW)).toBe('sleep');
    expect(botRunStateOf(facts({ archived: true, lastTerminal: finished('failed', 1_000) }), NOW)).toBe('sleep');
    expect(botRunStateOf(facts({ archived: true, lastTerminal: finished('completed', 1_000) }), NOW)).toBe('sleep');
  });

  it('concluída é done por 60 s desde finished_at, até o instante exato: aos 60 s já é livre', () => {
    expect(RUN_DONE_WINDOW_MS).toBe(60_000);
    expect(botRunStateOf(facts({ lastTerminal: finished('completed', 0) }), NOW)).toBe('done');
    expect(botRunStateOf(facts({ lastTerminal: finished('completed', 59_999) }), NOW)).toBe('done');
    expect(botRunStateOf(facts({ lastTerminal: finished('completed', 60_000) }), NOW)).toBe('idle');
    expect(botRunStateOf(facts({ lastTerminal: finished('completed', 3_600_000) }), NOW)).toBe('idle');
    // Relógio do banco um pouco adiante do da aplicação: conta como recém-concluída. Sem data de término não há como provar que é recente.
    expect(botRunStateOf(facts({ lastTerminal: finished('completed', -5_000) }), NOW)).toBe('done');
    expect(botRunStateOf(facts({ lastTerminal: finished('completed', null) }), NOW)).toBe('idle');
  });

  it('falha, expiração e limite atingido são error sem prazo (até a próxima execução começar)', () => {
    for (const status of ['failed', 'expired', 'limit_reached'] as const) {
      expect(botRunStateOf(facts({ lastTerminal: finished(status, 1_000) }), NOW), status).toBe('error');
      expect(botRunStateOf(facts({ lastTerminal: finished(status, 30 * 86_400_000) }), NOW), `${status} há um mês`).toBe('error');
    }
    // A próxima execução, ao começar, assume (regra 1) e ao terminar passa a ser a última: o erro antigo sai de cena sozinho.
    expect(botRunStateOf(facts({ lastTerminal: finished('failed', 5_000), activeStatus: 'running' }), NOW)).toBe('working');
    expect(botRunStateOf(facts({ lastTerminal: finished('completed', 1_000) }), NOW)).toBe('done');
  });

  it('interrompida e cancelada não marcam o bot: são livres', () => {
    for (const status of ['interrupted', 'cancelled'] as const) {
      expect(botRunStateOf(facts({ lastTerminal: finished(status, 1_000) }), NOW), status).toBe('idle');
    }
  });

  it('rotinas: dorme só quando existe ao menos uma e TODAS estão pausadas', () => {
    expect(botRunStateOf(facts({ routines: { total: 2, paused: 2 } }), NOW)).toBe('sleep');
    expect(botRunStateOf(facts({ routines: { total: 1, paused: 1 } }), NOW)).toBe('sleep');
    expect(botRunStateOf(facts({ routines: { total: 2, paused: 1 } }), NOW)).toBe('idle');
    expect(botRunStateOf(facts({ routines: { total: 2, paused: 0 } }), NOW)).toBe('idle');
    expect(botRunStateOf(facts({ routines: { total: 0, paused: 0 } }), NOW)).toBe('idle'); // sem rotina nenhuma, "todas pausadas" não vale
  });

  it('a regra da última execução vale mais que as rotinas pausadas, e "deixa de valer" cai nelas', () => {
    const paused = { total: 1, paused: 1 };
    expect(botRunStateOf(facts({ routines: paused, lastTerminal: finished('failed', 1_000) }), NOW)).toBe('error');
    expect(botRunStateOf(facts({ routines: paused, lastTerminal: finished('completed', 1_000) }), NOW)).toBe('done');
    // Concluída há mais de 60 s, interrompida e cancelada deixam de valer e o bot volta a dormir pelas rotinas.
    expect(botRunStateOf(facts({ routines: paused, lastTerminal: finished('completed', 61_000) }), NOW)).toBe('sleep');
    expect(botRunStateOf(facts({ routines: paused, lastTerminal: finished('interrupted', 1_000) }), NOW)).toBe('sleep');
    expect(botRunStateOf(facts({ routines: paused, lastTerminal: finished('cancelled', 1_000) }), NOW)).toBe('sleep');
  });
});

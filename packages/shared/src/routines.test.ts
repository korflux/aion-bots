// Prova dos contratos das rotinas: a entrada do calendário mensal (posição e campos estritos, sem configuração de feriados) e, desde a phase 10, os
// cartões da rotina que o bot aplica na hora (estados `applied`, `refused`, `edited` e `superseded`), os avisos `routine_refused` e `routine_edited` e a
// edição pelo cartão (`cardId`). Um estado ou tipo de cartão fora do contrato derrubaria a leitura da conversa inteira (o serializador da API os recusa),
// então a lista de estados e a união de cartões são afirmadas aqui.
import { describe, expect, it } from 'vitest';
import { systemCardSchema } from './conversation';
import {
  ROUTINE_CARD_STATUSES,
  routineChangeCardSchema,
  routineChangeParamsSchema,
  routineEditSchema,
  routineProposalCardSchema,
  routineScheduleSettingsSchema,
  scheduleDefinitionSchema,
} from './routines';

describe('routines agenda por dia útil', () => {
  it('aceita 1..20 ou last, com hora/fuso, e recusa limites, campos extras e tipos inconsistentes', () => {
    for (const position of [1, 20, 'last']) {
      const schedule = { type: 'monthly_business_day', position, time: '09:00' };
      expect(routineScheduleSettingsSchema.safeParse({ schedule, timezone: 'America/Sao_Paulo', startsAt: null, endsAt: null, maxRuns: null }).success).toBe(true);
    }
    for (const position of [0, 21, 1.5, '1', 'first', null]) expect(scheduleDefinitionSchema.safeParse({ type: 'monthly_business_day', position, time: '09:00' }).success).toBe(false);
    expect(scheduleDefinitionSchema.safeParse({ type: 'monthly_business_day', position: 1, time: '24:00' }).success).toBe(false);
    expect(scheduleDefinitionSchema.safeParse({ type: 'monthly_business_day', position: 1, time: '09:00', holidays: [] }).success).toBe(false);
  });
});

const SETTINGS = { schedule: { type: 'daily', times: ['07:30'] }, timezone: 'America/Sao_Paulo', startsAt: null, endsAt: null, maxRuns: null };
const ROUTINE_ID = '11111111-1111-4111-8111-111111111111';

describe('cartões de rotina aplicada pelo bot (phase 10)', () => {
  const proposal = { type: 'routine_proposal', proposal: { name: 'Resumo', instruction: 'Resuma', ...SETTINGS }, summary: 'Todos os dias às 07:30', nextRuns: [], routineId: ROUTINE_ID };
  const snapshot = { name: 'Resumo', instruction: 'Resuma', ...SETTINGS, summary: 'Todos os dias às 07:30' };
  const change = (status: string, action: unknown = { action: 'pause' }) => ({ type: 'routine_change', routineId: ROUTINE_ID, routineName: 'Resumo', change: action, status });

  it('os dois fluxos de vida coexistem: proposta antiga (pending, confirmed, stale) e aplicada (applied, refused, edited, superseded); estado fora da lista é recusado', () => {
    expect([...ROUTINE_CARD_STATUSES]).toEqual(['pending', 'confirmed', 'stale', 'applied', 'refused', 'edited', 'superseded']);
    for (const status of ROUTINE_CARD_STATUSES) {
      expect(routineProposalCardSchema.safeParse({ ...proposal, status }).success, `proposta ${status}`).toBe(true);
      expect(routineChangeCardSchema.safeParse(change(status)).success, `alteração ${status}`).toBe(true);
      expect(systemCardSchema.safeParse({ ...proposal, status }).success, `união ${status}`).toBe(true);
    }
    for (const status of ['done', 'applying', '']) expect(routineProposalCardSchema.safeParse({ ...proposal, status }).success).toBe(false);
    // A alteração aplicada guarda o antes e o depois; o instantâneo de restauração da exclusão NÃO faz parte do contrato (o serializador o remove).
    const applied = routineChangeCardSchema.parse({ ...change('applied', { action: 'update', before: snapshot, after: { ...snapshot, name: 'Novo' }, changed: ['name'], nextRuns: [] }), restore: { routine: { id: ROUTINE_ID } } });
    expect(applied.status).toBe('applied');
    expect(applied).not.toHaveProperty('restore');
    expect(routineChangeCardSchema.parse({ ...change('applied', { action: 'delete' }), routineId: null, restore: {} })).not.toHaveProperty('restore');
  });

  it('os avisos de recusa e de edição entram na união de cartões com o contrato curto (a agenda e a instrução finais vão só no texto do modelo)', () => {
    for (const action of ['create', 'update', 'pause', 'resume', 'delete']) {
      expect(systemCardSchema.parse({ type: 'routine_refused', routineId: null, routineName: 'Resumo', action })).toEqual({ type: 'routine_refused', routineId: null, routineName: 'Resumo', action });
    }
    expect(systemCardSchema.safeParse({ type: 'routine_refused', routineId: null, routineName: 'Resumo', action: 'apagar' }).success).toBe(false);
    expect(systemCardSchema.parse({ type: 'routine_edited', routineId: ROUTINE_ID, routineName: 'Resumo', instruction: 'não vai ao contrato' })).toEqual({ type: 'routine_edited', routineId: ROUTINE_ID, routineName: 'Resumo' });
  });

  it('a edição pelo cartão aceita só o cardId numérico além dos campos do editor; campo extra e id inválido são recusados', () => {
    const edit = { name: 'Resumo', botId: '22222222-2222-4222-8222-222222222222', instruction: 'Resuma', ...SETTINGS };
    expect(routineEditSchema.safeParse(edit).success).toBe(true);
    expect(routineEditSchema.safeParse({ ...edit, cardId: '123' }).success).toBe(true);
    for (const cardId of ['abc', '', '1'.repeat(19), 12]) expect(routineEditSchema.safeParse({ ...edit, cardId }).success, String(cardId)).toBe(false);
    expect(routineEditSchema.safeParse({ ...edit, cardId: '1', status: 'paused' }).success).toBe(false);
    // A recusa recebe só o id da mensagem do cartão.
    expect(routineChangeParamsSchema.safeParse({ messageId: '42' }).success).toBe(true);
    expect(routineChangeParamsSchema.safeParse({ messageId: '42', extra: 1 }).success).toBe(false);
  });
});

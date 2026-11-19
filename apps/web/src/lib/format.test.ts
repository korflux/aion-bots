// Prova do horário relativo mostrado em Conta → Sessões.
import { describe, expect, it } from 'vitest';
import { formatRelativeTime, formatDateTimeInZone, formatNextRun, formatTimeInZone } from './format';

describe('horário relativo', () => {
  it('descreve agora, minutos, horas e dias no passado em português', () => {
    const now = new Date('2026-03-10T12:00:00Z');
    const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

    expect(formatRelativeTime(ago(10_000), now)).toBe('agora');
    expect(formatRelativeTime(ago(5 * 60_000), now)).toMatch(/^há 5 min/);
    expect(formatRelativeTime(ago(2 * 3_600_000), now)).toMatch(/^há 2 h/);
    expect(formatRelativeTime(ago(24 * 3_600_000), now)).toBe('ontem');
    expect(formatRelativeTime(ago(3 * 86_400_000), now)).toMatch(/^há 3 d/);
  });
});

describe('formatação de rotinas no fuso da rotina', () => {
  const now = new Date('2026-10-01T15:00:00Z'); // 12:00 em Brasília, 11:00 em Nova York

  it('formata data e hora no fuso pedido, não no do navegador', () => {
    expect(formatDateTimeInZone('2026-10-05T10:00:00.000Z', 'America/Sao_Paulo')).toContain('07:00');
    expect(formatDateTimeInZone('2026-10-05T10:00:00.000Z', 'America/New_York')).toContain('06:00');
    expect(formatDateTimeInZone('2026-10-05T10:00:00.000Z', 'Marte/Olimpo')).toMatch(/\d{2}:\d{2}/); // fuso desconhecido não quebra
    expect(formatTimeInZone('2026-10-05T10:00:00.000Z', 'Asia/Tokyo')).toBe('19:00');
  });

  it('próxima execução: hoje, amanhã ou a data', () => {
    expect(formatNextRun('2026-10-01T22:00:00.000Z', 'America/Sao_Paulo', now)).toBe('hoje 19:00');
    expect(formatNextRun('2026-10-02T10:00:00.000Z', 'America/Sao_Paulo', now)).toBe('amanhã 07:00');
    expect(formatNextRun('2026-10-13T12:00:00.000Z', 'America/Sao_Paulo', now)).toBe('13/10 09:00');
    // O dia é o do fuso da rotina: 02:00Z do dia 2 ainda é dia 1 em Brasília (23:00).
    expect(formatNextRun('2026-10-02T02:00:00.000Z', 'America/Sao_Paulo', now)).toBe('hoje 23:00');
  });
});

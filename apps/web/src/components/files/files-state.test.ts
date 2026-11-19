// Seleção, deduplicação e quota nos limites que sustentam a gestão da lista.
import type { AttachmentPage } from '@aion/shared';
import { describe, expect, it } from 'vitest';
import { appendFiles, eligibleSelection, quotaState, type FileItem } from './files-state';
/** Metadados públicos suficientes para exercitar o estado, sem conteúdo binário. */
const file = (id: string, inUse = false): FileItem => ({ id, inUse, kind: 'document', name: 'nota.txt', originalBytes: 1000, storedBytes: 20, truncated: false, createdAt: '2026-10-06T12:00:00Z', removedAt: null, bot: null, sessionId: '8f0c2f4e-5f5f-4f7a-9d7e-1f8a6a1d0001', sessionTitle: 'Notas' });
describe('estado de arquivos', () => {
  it('pagina sem duplicar e retira seleções ausentes ou em uso após releitura', () => {
    const page: AttachmentPage = { items: [file('3'), file('2')], nextCursor: '2', usedBytes: 60, maxBytes: 100, count: 3 };
    const merged = appendFiles(page, { ...page, items: [file('2'), file('1', true)], nextCursor: null });
    expect(merged.items.map((item) => item.id)).toEqual(['3', '2', '1']);
    expect(eligibleSelection(merged.items, new Set(['2', '1', '0']))).toEqual(new Set(['2']));
    expect(merged.nextCursor).toBeNull();
  });
  it('quota distingue as três faixas e satura com limite zero ou ultrapassado', () => {
    expect(quotaState(79, 100)).toMatchObject({ color: 'bg-muted', text: 'Espaço disponível' });
    expect(quotaState(80, 100)).toMatchObject({ color: 'bg-warning', text: 'Espaço próximo do limite' });
    expect(quotaState(99, 100).color).toBe('bg-warning');
    expect(quotaState(100, 100)).toMatchObject({ percent: 100, color: 'bg-danger' });
    expect(quotaState(101, 100).percent).toBe(100); expect(quotaState(0, 0).percent).toBe(100);
  });
});

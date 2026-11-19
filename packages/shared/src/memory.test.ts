// Prova do diff de linhas e dos contratos da memória (T8): o diff é a base do cartão "Memória atualizada" e do histórico, então
// precisa devolver exatamente o que mudou, na ordem do texto, e não pode custar memória demais num texto grande.
import { describe, expect, it } from 'vitest';
import { countDiff, diffLines, memoryContentInputSchema, previewDiff, saveMemoryRequestSchema, type DiffLine } from './memory';

/** Diff em forma legível: "+ linha", "- linha" e "  linha". */
const show = (lines: DiffLine[]): string[] => lines.map((line) => `${{ add: '+', remove: '-', same: ' ' }[line.kind]} ${line.text}`);

describe('diff de linhas', () => {
  it('mostra só o que mudou, mantém a ordem do texto e conta adições e remoções', () => {
    expect(show(diffLines('a\nb\nc', 'a\nb\nc'))).toEqual(['  a', '  b', '  c']);
    expect(show(diffLines('', 'a\nb'))).toEqual(['+ a', '+ b']);
    expect(show(diffLines('a\nb', ''))).toEqual(['- a', '- b']);
    expect(diffLines('', '')).toEqual([]);
    // Troca no meio: o início e o fim iguais ficam como estão.
    expect(show(diffLines('um\ndois\ntrês', 'um\n2\ntrês'))).toEqual(['  um', '- dois', '+ 2', '  três']);
    // Inserção e remoção em pontos diferentes, com uma linha igual repetida (a maior subsequência comum decide).
    expect(show(diffLines('a\nb\nc\nb\nd', 'a\nc\nb\nx\nd'))).toEqual(['  a', '- b', '  c', '  b', '+ x', '  d']);

    const diff = diffLines('a\nb\nc', 'a\nB\nc\nd');
    expect(countDiff(diff)).toEqual({ added: 2, removed: 1 });
    // O cartão resume só as linhas que mudaram, até o máximo pedido.
    expect(show(previewDiff(diff))).toEqual(['- b', '+ B', '+ d']);
    expect(previewDiff(diff, 2)).toHaveLength(2);
  });

  it('um texto grande e sem nada em comum não estoura: o miolo vira troca total em vez de uma tabela gigante', () => {
    const before = Array.from({ length: 3000 }, (_, index) => `antes ${index}`).join('\n');
    const after = Array.from({ length: 3000 }, (_, index) => `depois ${index}`).join('\n');
    const started = Date.now();
    const diff = diffLines(before, after);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(countDiff(diff)).toEqual({ added: 3000, removed: 3000 });
    expect(diff.slice(0, 3000).every((line) => line.kind === 'remove')).toBe(true);
  });
});

describe('contratos da memória', () => {
  it('recusa caracteres de controle e campos extras, e deixa o limite de 8.000 para o core responder com MEMORY_TOO_LARGE', () => {
    expect(memoryContentInputSchema.safeParse('linha 1\n\tlinha 2').success).toBe(true);
    expect(memoryContentInputSchema.safeParse('com nulo\u0000').success).toBe(false);
    // 9.000 caracteres passam na borda (o core recusa com a mensagem do contrato); o teto de borda é bem maior.
    expect(memoryContentInputSchema.safeParse('x'.repeat(9000)).success).toBe(true);
    expect(memoryContentInputSchema.safeParse('x'.repeat(100_001)).success).toBe(false);

    expect(saveMemoryRequestSchema.safeParse({ content: 'ok', expectedVersion: 0 }).success).toBe(true);
    expect(saveMemoryRequestSchema.safeParse({ content: 'ok', expectedVersion: -1 }).success).toBe(false);
    expect(saveMemoryRequestSchema.safeParse({ content: 'ok', expectedVersion: 1.5 }).success).toBe(false);
    expect(saveMemoryRequestSchema.safeParse({ content: 'ok', expectedVersion: 0, scope: 'global' }).success).toBe(false);
  });
});

// Prova do desenho do diff da memória (T14, A11): o que o dono e o leitor de tela recebem de cada linha. A cor do fundo e a quebra de
// linha no navegador real são provadas no E2E (apps/web/e2e/memory.spec.ts); aqui fica o que o HTML garante: prefixo e rótulo por
// estado (a mudança não depende só de cor), fundo só nas linhas que mudaram, linha vazia que não some e texto não confiável escapado.
import { diffLines } from '@aion/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MemoryDiff } from './memory-diff';

/** Uma linha do HTML renderizado: o estado, as classes do item e o texto de cada parte (prefixo, rótulo para leitor de tela, texto). */
interface RenderedRow {
  kind: string;
  classes: string;
  prefix: string;
  srLabel: string;
  text: string;
}

/** Renderiza o diff e devolve as linhas do HTML, sem depender de DOM. */
function render(lines: Parameters<typeof MemoryDiff>[0]['lines']): { label: string | null; rows: RenderedRow[]; html: string } {
  const html = renderToStaticMarkup(<MemoryDiff lines={lines} label="Mudanças da versão 2" />);
  const rows = [...html.matchAll(/<li data-diff-kind="(\w+)" class="([^"]*)"><span aria-hidden="true" class="[^"]*">([^<]*)<\/span><span class="sr-only">([^<]*)<\/span><span class="[^"]*">([^<]*)<\/span><\/li>/g)].map(
    (match): RenderedRow => ({ kind: match[1]!, classes: match[2]!, prefix: match[3]!, srLabel: match[4]!, text: match[5]! }),
  );
  return { label: /<ul aria-label="([^"]*)"/.exec(html)?.[1] ?? null, rows, html };
}

describe('diff rico da memória', () => {
  it('cada estado tem prefixo visível, rótulo para leitor de tela e fundo próprio só onde mudou, sem depender só de cor', () => {
    const before = 'contexto\nlinha antiga\nlinha igual\n';
    const after = 'contexto\nlinha nova\nlinha igual\n\n';
    const { label, rows } = render(diffLines(before, after));

    expect(label).toBe('Mudanças da versão 2');
    const byKind = Object.fromEntries(rows.map((row) => [row.kind, row]));
    // O diff real traz as três naturezas de linha, e cada uma chegou ao HTML.
    expect(new Set(rows.map((row) => row.kind))).toEqual(new Set(['same', 'remove', 'add']));
    expect(byKind.add).toMatchObject({ prefix: '+', srLabel: 'Adicionada: ' });
    expect(byKind.remove).toMatchObject({ prefix: '−', srLabel: 'Removida: ' });
    expect(byKind.same).toMatchObject({ prefix: ' ', srLabel: '' });

    // Fundo de estado só nas linhas que mudaram, e um fundo diferente para cada estado (o contexto não ganha fundo).
    expect(byKind.add!.classes).toContain('bg-success-soft');
    expect(byKind.remove!.classes).toContain('bg-danger-soft');
    expect(byKind.same!.classes).not.toMatch(/\bbg-/);
    expect(byKind.add!.classes).not.toContain('bg-danger-soft');
    expect(byKind.remove!.classes).not.toContain('bg-success-soft');
  });

  it('linha vazia continua com o prefixo e altura (não some do bloco), linha longa mantém o texto inteiro e quebra em vez de rolar', () => {
    const long = `x${'y'.repeat(300)}`;
    const { rows, html } = render([
      { kind: 'add', text: '' },
      { kind: 'add', text: long },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: 'add', prefix: '+', text: ' ' });
    expect(rows[1]).toMatchObject({ kind: 'add', prefix: '+', text: long });
    // A quebra vale em qualquer ponto e preserva os espaços do texto; a caixa do texto pode encolher dentro da linha flex.
    expect(html).toContain('whitespace-pre-wrap');
    expect(html).toContain('[overflow-wrap:anywhere]');
    expect(html).toContain('min-w-0');
  });

  it('o texto da memória é não confiável: HTML dentro de uma linha aparece como texto, não vira elemento', () => {
    const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const { rows, html } = render([{ kind: 'remove', text: hostile }]);

    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(rows[0]!.text).toBe('&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;alert(2)&lt;/script&gt;');
  });
});

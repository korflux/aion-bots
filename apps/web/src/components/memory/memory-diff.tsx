// Desenho do diff de linhas da memória (cartão "Memória atualizada" e drawer de histórico; design: Memória → Drawer). Cada linha tem
// fundo do estado (adicionada `--success-soft`, removida `--danger-soft`, igual sem fundo) E prefixo visível (`+` adicionada, `−`
// removida), mais o rótulo para leitor de tela: a mudança nunca depende só de cor (acessibilidade, design: "Diff com prefixos
// além de cor"). O cálculo do diff é de @aion/shared (`diffLines`); aqui só mora o desenho, e os dois consumidores o compartilham.
import type { DiffLine } from '@aion/shared';

/**
 * Aparência de cada tipo de linha. `row` é o fundo e a cor do texto da linha inteira (o fundo cobre todas as linhas visuais de
 * uma linha que quebra); `mark` colore o prefixo; `srLabel` é o que o leitor de tela diz antes do texto (a linha igual não
 * precisa de aviso). Texto de linha alterada fica em `--text` e o contexto em `--text-subtle`, para o olho achar o que mudou.
 */
const LINE_STYLE: Record<DiffLine['kind'], { prefix: string; srLabel: string; row: string; mark: string }> = {
  add: { prefix: '+', srLabel: 'Adicionada: ', row: 'bg-success-soft text-fg', mark: 'text-success' },
  remove: { prefix: '−', srLabel: 'Removida: ', row: 'bg-danger-soft text-fg', mark: 'text-danger' },
  same: { prefix: ' ', srLabel: '', row: 'text-subtle', mark: 'text-muted' },
};

/**
 * Linhas do diff em fonte monoespaçada. Linhas longas quebram em qualquer ponto (`overflow-wrap:anywhere`, preservando os espaços
 * do texto) em vez de rolar, então 375 px não ganha rolagem horizontal; o prefixo fica na primeira linha visual e o fundo cobre a
 * linha inteira. Linhas seguidas do mesmo estado formam um bloco contínuo (sem espaço entre os itens). O texto vem do bot ou do
 * dono, é não confiável e é renderizado como texto (o React o escapa).
 */
export function MemoryDiff({ lines, label }: { lines: readonly DiffLine[]; label: string }) {
  return (
    <ul aria-label={label} className="overflow-hidden rounded-sm font-mono text-[13px]/5">
      {lines.map((line, index) => {
        const style = LINE_STYLE[line.kind];
        return (
          <li key={`${index}-${line.kind}`} data-diff-kind={line.kind} className={`flex gap-2 px-2 ${style.row}`}>
            <span aria-hidden className={`w-3 shrink-0 select-none ${style.mark}`}>
              {style.prefix}
            </span>
            <span className="sr-only">{style.srLabel}</span>
            <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{line.text === '' ? ' ' : line.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

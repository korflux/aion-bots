'use client';

// Controle compartilhado entre o seletor de modelo e o popover independente do composer.
import { EFFORT_LABELS, type EffortLevel } from '@aion/shared';
import { useId, type CSSProperties } from 'react';
import { cn } from '@/lib/cn';

/** Nome da etapa de effort: "Padrão" é a ausência de nível (o provedor decide). */
const effortLabel = (level: EffortLevel | null): string => (level === null ? 'Padrão' : EFFORT_LABELS[level]);

/**
 * Controle de effort: uma barra com etapas, como um controle de volume (T18). As etapas são "Padrão" e os níveis que o modelo aceitou no
 * teste, do menor ao maior; o nome da etapa escolhida aparece em cima, ao lado do rótulo, e a barra preenche até ela. É um
 * `<input type="range">` nativo, então teclado (setas, Home e End), toque e leitor de tela funcionam sem código extra: o nome da etapa
 * vai em `aria-valuetext` (o valor numérico da barra é só a posição). A trilha, o preenchimento e os pontos das etapas são desenho
 * (`globals.css`, `.effort-slider`) e ficam atrás do campo, que é transparente. Cada passo chama `onChange`, também ao arrastar: o
 * valor escolhido é do pai (`value`), então a barra segue o que ele guardou.
 */
export function EffortControl({ levels, value, onChange, divider = true }: { levels: EffortLevel[]; value: EffortLevel | null; onChange: (effort: EffortLevel | null) => void; divider?: boolean }) {
  const id = useId();
  const options: (EffortLevel | null)[] = [null, ...levels];
  const steps = options.length - 1;
  // Um effort que o modelo não aceita (ex.: guardado para outro modelo) cai na primeira etapa, "Padrão".
  const index = Math.max(0, options.indexOf(value));
  const current = effortLabel(options[index] ?? null);
  return (
    <div className={cn('px-3 py-3', divider && 'border-t border-line')}>
      <div className="mb-1 flex items-baseline gap-2">
        <label htmlFor={id} className="text-xs font-medium uppercase tracking-wide text-subtle">
          Effort
        </label>
        <span aria-hidden className="text-sm font-medium text-fg">
          {current}
        </span>
      </div>
      <div className="effort-slider" style={{ '--steps': steps, '--index': index } as CSSProperties}>
        <div aria-hidden className="effort-track">
          <span className="effort-fill" />
          {options.map((level, step) => (
            <span key={level ?? 'padrao'} className="effort-tick" style={{ '--step': step } as CSSProperties} />
          ))}
        </div>
        <input
          id={id}
          type="range"
          min={0}
          max={steps}
          step={1}
          value={index}
          aria-valuetext={current}
          onChange={(event) => onChange(options[Number(event.target.value)] ?? null)}
        />
      </div>
    </div>
  );
}

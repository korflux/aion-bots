'use client';

// Seletor de cor do bot (design: Editor do bot): 12 amostras pré-definidas e a 13ª, "Personalizada", que abre um
// campo hexadecimal. É um grupo de botões de opção nativos (navegação por setas e leitura como "Azul, 3 de 13"
// vêm do navegador), com a amostra escolhida marcada por anel E pelo ícone de confirmação, sem depender só de cor.
// Cor personalizada abaixo de 3:1 sobre o fundo mostra o aviso "Cor com pouco contraste", mas é aceita (design).
import { BOT_COLORS, hasLowBotContrast, isHexColor, readableTextOn } from '@aion/shared';
import { Check, Pipette, TriangleAlert } from 'lucide-react';
import type { CSSProperties } from 'react';
import { Input, Label } from '@/components/ui/input';
import { cn } from '@/lib/cn';

const swatchRing =
  'relative inline-flex size-7 items-center justify-center rounded-full ring-offset-2 ring-offset-app peer-checked:ring-2 peer-checked:ring-fg ' +
  'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-focus';

interface ColorPickerProps {
  /** Texto da cor como digitado (um `#RRGGBB` válido ou a digitação em andamento do campo personalizado). */
  value: string;
  /** "Personalizada" está escolhida (mesmo que o texto ainda coincida com uma pré-definida). */
  custom: boolean;
  onChange: (value: string, custom: boolean) => void;
  error?: string;
}

export function ColorPicker({ value, custom, onChange, error }: ColorPickerProps) {
  const valid = isHexColor(value);
  const lowContrast = valid && hasLowBotContrast(value);
  const describedBy = [error ? 'cor-erro' : null, lowContrast ? 'cor-aviso' : null].filter(Boolean).join(' ') || undefined;

  return (
    <fieldset role="radiogroup" aria-labelledby="cor-legenda" className="min-w-0">
      <legend id="cor-legenda" className="mb-1.5 text-sm font-medium text-fg">
        Cor
      </legend>
      <div className="flex flex-wrap gap-3 py-1">
        {BOT_COLORS.map((preset) => (
          <label key={preset.hex} className="cursor-pointer">
            <input
              type="radio"
              name="cor"
              value={preset.hex}
              aria-label={preset.name}
              checked={!custom && value.toUpperCase() === preset.hex}
              onChange={() => onChange(preset.hex, false)}
              className="peer sr-only"
            />
            <span style={{ '--bot': preset.hex, color: readableTextOn(preset.hex) } as CSSProperties} className={cn(swatchRing, 'bg-(--bot) [&>svg]:opacity-0 peer-checked:[&>svg]:opacity-100')}>
              <Check className="size-4" strokeWidth={2.5} aria-hidden />
            </span>
          </label>
        ))}
        <label className="cursor-pointer">
          <input
            type="radio"
            name="cor"
            value="personalizada"
            aria-label="Personalizada"
            checked={custom}
            onChange={() => onChange(value, true)}
            className="peer sr-only"
          />
          <span className={cn(swatchRing, 'border border-dashed border-line-strong text-muted')}>
            <Pipette className="size-3.5" strokeWidth={1.5} aria-hidden />
          </span>
        </label>
      </div>

      {custom ? (
        <div className="mt-3 max-w-56">
          <Label htmlFor="cor-hex" className="mb-1 text-xs font-normal text-muted">
            Cor personalizada (hexadecimal)
          </Label>
          <Input
            id="cor-hex"
            value={value}
            onChange={(event) => {
              const raw = event.target.value.trim();
              onChange(raw === '' || raw.startsWith('#') ? raw : `#${raw}`, true);
            }}
            maxLength={7}
            placeholder="#RRGGBB"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            className="font-mono"
          />
        </div>
      ) : null}

      {error ? (
        <p id="cor-erro" className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      ) : null}
      {lowContrast ? (
        <p id="cor-aviso" role="status" className="mt-2 flex items-start gap-1.5 text-xs text-warning">
          <TriangleAlert className="mt-px size-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
          <span>
            <strong className="font-medium">Cor com pouco contraste.</strong> Ela pode ficar difícil de ver sobre o fundo escuro, mas será aceita.
          </span>
        </p>
      ) : null}
    </fieldset>
  );
}

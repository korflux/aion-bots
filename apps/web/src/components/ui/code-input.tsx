'use client';

// Campo de código de 6 dígitos do kit (design "Login e TOTP": seis caixas com colagem suportada). Usado no segundo
// passo do login e nos modais de ativar e desativar o autenticador.
//
// Decisão: UM <input> real com as seis caixas desenhadas por cima (aria-hidden). O campo único mantém de graça o
// que seis inputs separados quebrariam: colar "123 456", autopreenchimento de SMS/OTP do celular
// (`autocomplete="one-time-code"`), teclado numérico, um único nome acessível para leitor de tela e Backspace
// natural. O input é transparente e cobre as caixas, então qualquer toque o foca. O foco visível é o anel na caixa
// que receberá o próximo dígito, feito só com CSS (`group-focus-within`): o contorno do próprio input ficaria
// invisível e um estado em JavaScript perderia o foco dado antes da hidratação (`autoFocus` no login).
import type { ChangeEvent, ComponentProps } from 'react';
import { TOTP_DIGITS } from '@aion/shared';
import { cn } from '@/lib/cn';

export interface CodeInputProps extends Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'type' | 'maxLength'> {
  /** Só dígitos, no máximo 6. */
  value: string;
  onChange: (value: string) => void;
  /** Disparado quando o sexto dígito entra (digitado ou colado): o segundo passo do login envia sozinho. */
  onComplete?: (value: string) => void;
  invalid?: boolean;
}

export function CodeInput({ value, onChange, onComplete, invalid, disabled, className, ...props }: CodeInputProps) {
  // Caixa que recebe o próximo dígito; com o código completo, a última.
  const active = Math.min(value.length, TOTP_DIGITS - 1);

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    // Aceita colagem com espaços, hífens ou texto em volta: fica só com os 6 primeiros dígitos.
    const digits = event.target.value.replace(/\D/g, '').slice(0, TOTP_DIGITS);
    onChange(digits);
    if (digits.length === TOTP_DIGITS) onComplete?.(digits);
  }

  return (
    <div className={cn('group relative', className)}>
      <div aria-hidden className="flex gap-2">
        {Array.from({ length: TOTP_DIGITS }, (_, index) => (
          <span
            key={index}
            className={cn(
              'grid h-12 min-w-0 flex-1 place-items-center rounded-md border border-line-strong bg-app font-mono text-xl text-fg',
              invalid && 'border-danger',
              disabled && 'opacity-50',
              index === active && 'group-focus-within:border-focus group-focus-within:ring-2 group-focus-within:ring-focus',
            )}
          >
            {value[index] ?? ''}
          </span>
        ))}
      </div>
      <input
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        spellCheck={false}
        value={value}
        disabled={disabled}
        aria-invalid={invalid ? true : undefined}
        onChange={handleChange}
        // Fonte de 16 px evita o zoom automático do iOS ao focar; a opacidade zero esconde texto e cursor.
        className="absolute inset-0 size-full cursor-text text-base opacity-0 disabled:cursor-not-allowed"
        {...props}
      />
    </div>
  );
}

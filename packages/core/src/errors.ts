// Exceção de domínio tipada do Aion.
//
// O núcleo (serviços, regras) só lança `DomainError` com um `ErrorCode` do registro compartilhado. Ele nunca
// conhece HTTP: a tradução para status + envelope `{ code, message }` é responsabilidade exclusiva do handler
// central da API (AGENTS.md: "Erros no Núcleo Interno"). Por isso a `message` interna é só o próprio código.
import type { ErrorCode, FieldError } from '@aion/shared';

export interface DomainErrorOptions {
  /** Quando o cliente deve tentar de novo (vira o cabeçalho Retry-After na borda HTTP). */
  retryAfterSeconds?: number;
  /** Campo e motivo, usado por VALIDATION_FAILED. */
  fields?: FieldError[];
  /** Causa original, preservada só para log interno (nunca chega à resposta). */
  cause?: unknown;
}

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly retryAfterSeconds: number | undefined;
  readonly fields: FieldError[] | undefined;

  constructor(code: ErrorCode, options: DomainErrorOptions = {}) {
    super(code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DomainError';
    this.code = code;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.fields = options.fields;
  }
}

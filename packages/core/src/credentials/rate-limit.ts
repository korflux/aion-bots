// Limitador de taxa por janela deslizante, em memória. Usado pela validação de chaves (10 por minuto, spec:
// "validação de chaves limitada a 10 por minuto"); T5 (10 testes de modelo por minuto) pode instanciar outro.
//
// ponytail: o contador vive na memória do processo, então o limite vale por instância da API. Com mais de uma
// instância, trocar por contador no banco (mesma interface).
import { DomainError } from '../errors';

export interface SlidingWindowLimiterOptions {
  /** Máximo de acessos permitidos dentro da janela. */
  max: number;
  windowMs: number;
  /** Relógio injetável: os testes avançam o tempo sem esperar. */
  now?: () => Date;
}

export class SlidingWindowLimiter {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => Date;
  /** Instantes (ms) dos acessos ainda dentro da janela, do mais antigo ao mais novo. */
  private readonly hits: number[] = [];

  constructor({ max, windowMs, now = () => new Date() }: SlidingWindowLimiterOptions) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Registra um acesso. Lança `RATE_LIMITED` (com `Retry-After`) se a janela já está cheia; o acesso recusado não conta. */
  consume(): void {
    const at = this.now().getTime();
    while (this.hits.length > 0 && this.hits[0]! <= at - this.windowMs) this.hits.shift();
    if (this.hits.length >= this.max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((this.hits[0]! + this.windowMs - at) / 1000));
      throw new DomainError('RATE_LIMITED', { retryAfterSeconds });
    }
    this.hits.push(at);
  }
}

/**
 * Um `SlidingWindowLimiter` por chave (ex.: por sessão de login), criado no primeiro acesso da chave. Base dos limites por sessão da presença
 * (T2), do push (abertura do app e conferência, T3) e dos controles por conversa. Cada acesso remove as chaves cuja última tentativa aceita
 * já saiu da janela, evitando acumular o histórico de sessões e conversas. A janela de uma chave ativa nunca é descartada.
 */
export class KeyedSlidingWindowLimiter {
  private readonly options: SlidingWindowLimiterOptions;
  private readonly limiters = new Map<string, { limiter: SlidingWindowLimiter; lastHit: number }>();

  constructor(options: SlidingWindowLimiterOptions) {
    this.options = options;
  }

  /** Registra um acesso da chave. Lança `RATE_LIMITED` (com `Retry-After`) se a janela dela já está cheia. */
  consume(key: string): void {
    const at = (this.options.now?.() ?? new Date()).getTime();
    for (const [idleKey, entry] of this.limiters) {
      if (entry.lastHit <= at - this.options.windowMs) this.limiters.delete(idleKey);
    }
    let entry = this.limiters.get(key);
    if (!entry) {
      entry = { limiter: new SlidingWindowLimiter(this.options), lastHit: at };
      this.limiters.set(key, entry);
    }
    entry.limiter.consume();
    entry.lastHit = at;
  }
}

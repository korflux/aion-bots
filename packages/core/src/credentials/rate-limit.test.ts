// Prova do descarte de janelas ociosas: novas sessões/conversas não acumulam chaves históricas, e a limpeza preserva o limite das ativas.
import { expect, it } from 'vitest';
import { KeyedSlidingWindowLimiter } from './rate-limit';

it('descarta chaves vencidas sem reiniciar a janela de uma chave ativa nem estendê-la por tentativas recusadas', () => {
  let at = 0;
  const limiter = new KeyedSlidingWindowLimiter({ max: 2, windowMs: 60_000, now: () => new Date(at) });
  for (let index = 0; index < 100; index += 1) limiter.consume(`ociosa:${index}`);
  at = 30_000;
  limiter.consume('ativa');
  limiter.consume('ativa');
  at = 59_999;
  expect(() => limiter.consume('ativa')).toThrow(expect.objectContaining({ code: 'RATE_LIMITED', retryAfterSeconds: 31 }));
  at = 60_000;
  limiter.consume('nova');

  // A retenção é parte da prova de memória: só as duas chaves dentro da janela permanecem no mapa privado.
  expect([...Reflect.get(limiter, 'limiters').keys()]).toEqual(['ativa', 'nova']);
  expect(() => limiter.consume('ativa')).toThrow(expect.objectContaining({ code: 'RATE_LIMITED', retryAfterSeconds: 30 }));
  at = 90_000;
  limiter.consume('outra');
  expect([...Reflect.get(limiter, 'limiters').keys()]).toEqual(['nova', 'outra']);
  expect(() => limiter.consume('ativa')).not.toThrow();
});

// Origem da requisição (IP e navegador) para a auditoria e o bloqueio por IP: a fonte única, usada por todas as rotas que registram quem
// fez a ação (E16). O IP já vem resolvido pelo proxy confiável (`request.ip`); o user agent é cortado na hora de gravar a auditoria.
import type { FastifyRequest } from 'fastify';

/** IP e navegador da requisição, gravados na auditoria de cada alteração e usados no bloqueio de login por IP. */
export const originOf = (request: FastifyRequest) => ({
  ip: request.ip,
  userAgent: request.headers['user-agent'] ?? '',
});

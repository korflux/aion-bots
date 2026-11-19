// GET /api/health: sonda de saúde pública (usada pelo Easypanel e pelo smoke de produção).
// Retorna só `{ status: "ok" }` para não revelar nada; 503 com envelope padrão se o banco não responder.
import { DomainError, type Pool } from '@aion/core';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

export const healthRoutes: FastifyPluginAsyncZod<{ pool: Pool }> = async (app, { pool }) => {
  app.get(
    '/health',
    {
      config: { public: true },
      schema: { response: { 200: z.object({ status: z.literal('ok') }) } },
    },
    async () => {
      try {
        await pool.query('SELECT 1');
      } catch (error) {
        throw new DomainError('SERVICE_UNAVAILABLE', { cause: error });
      }
      return { status: 'ok' as const };
    },
  );
};

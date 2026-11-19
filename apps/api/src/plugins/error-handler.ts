// Handler central de erros da API: ÚNICO lugar que traduz exceções em status HTTP + envelope `{ code, message }`.
//
// O núcleo lança `DomainError` tipado e não conhece HTTP. Qualquer outra falha (bug, banco, biblioteca) vira
// INTERNAL_ERROR com mensagem genérica: o detalhe (mensagem, stack, SQL) vai só para o log do servidor, em
// qualquer ambiente. Assim nenhuma resposta expõe estrutura interna, nem em produção nem em desenvolvimento.
import { DomainError } from '@aion/core';
import { ERROR_CODES, toErrorEnvelope, type ErrorCode, type FieldError } from '@aion/shared';
import type { FastifyError, FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';

/** Motivos em PT-BR por tipo de falha do Zod. Nunca ecoam o valor enviado nem os nomes de chaves extras. */
const REASONS: Record<string, string> = {
  invalid_type: 'Valor inválido.',
  invalid_value: 'Valor inválido.',
  invalid_format: 'Formato inválido.',
  too_small: 'Valor curto demais.',
  too_big: 'Valor longo demais.',
  unrecognized_keys: 'Campo não permitido.',
};

interface Mapped {
  code: ErrorCode;
  fields?: FieldError[];
  retryAfterSeconds?: number;
}

/** Erros do próprio Fastify (corpo grande, tipo de mídia, JSON quebrado) carregam `statusCode`. */
function mapByStatus(statusCode: number | undefined): ErrorCode {
  if (statusCode === 400) return 'BAD_REQUEST';
  if (statusCode === 404) return 'NOT_FOUND';
  if (statusCode === 413) return 'PAYLOAD_TOO_LARGE';
  if (statusCode === 415) return 'UNSUPPORTED_MEDIA_TYPE';
  return 'INTERNAL_ERROR';
}

function toMapped(error: unknown): Mapped {
  if (error instanceof DomainError) {
    const mapped: Mapped = { code: error.code };
    if (error.fields) mapped.fields = error.fields;
    if (error.retryAfterSeconds !== undefined) mapped.retryAfterSeconds = error.retryAfterSeconds;
    return mapped;
  }
  if (hasZodFastifySchemaValidationErrors(error)) {
    // Só a repetição de IDs no envio tem código de domínio; os demais erros continuam validação de borda.
    if (error.validation.length === 1 && error.validation[0]?.instancePath === '/attachmentIds' &&
      error.validation[0].keyword === 'custom' &&
      (error.validation[0].params.params as { domainCode?: unknown } | undefined)?.domainCode === 'ATTACHMENT_NOT_FOUND') {
      return { code: 'ATTACHMENT_NOT_FOUND' };
    }
    const seen = new Set<string>();
    const fields: FieldError[] = [];
    for (const issue of error.validation) {
      const field = issue.instancePath.replace(/^\//, '').replaceAll('/', '.') || 'corpo';
      const reason = REASONS[issue.keyword] ?? 'Valor inválido.';
      const key = `${field}:${reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fields.push({ field, reason });
    }
    return { code: 'VALIDATION_FAILED', fields };
  }
  if (isResponseSerializationError(error)) return { code: 'INTERNAL_ERROR' };
  const statusCode = (error as Partial<FastifyError> | null)?.statusCode;
  return { code: mapByStatus(typeof statusCode === 'number' ? statusCode : undefined) };
}

/** Registra o handler de erro e o de rota inexistente na instância raiz. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((_request, reply) => {
    void reply.status(ERROR_CODES.NOT_FOUND.status).send(toErrorEnvelope('NOT_FOUND'));
  });

  app.setErrorHandler((error, request, reply) => {
    const mapped = toMapped(error);
    if (request.routeOptions.config.attachmentUpload && mapped.code === 'PAYLOAD_TOO_LARGE') mapped.code = 'ATTACHMENT_TOO_LARGE';
    const { code, fields, retryAfterSeconds } = mapped;
    const status = ERROR_CODES[code].status;
    // Só falhas inesperadas (5xx) vão ao log com detalhe; recusas normais (4xx) já aparecem no log de requisição.
    if (status >= 500) request.log.error({ err: error }, 'erro inesperado ao atender a requisição');
    if (retryAfterSeconds !== undefined) void reply.header('Retry-After', String(retryAfterSeconds));
    void reply.status(status).send(toErrorEnvelope(code, fields));
  });
}

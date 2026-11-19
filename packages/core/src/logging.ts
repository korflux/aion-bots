// Logger estruturado (pino) compartilhado por api e worker, com redação de dados sensíveis.
//
// Regra do projeto: senhas, tokens, chaves e cookies nunca aparecem em log. A redação é a segunda barreira;
// a primeira é não passar esses valores ao logger em primeiro lugar.
import { pino, type DestinationStream, type Logger } from 'pino';

/** Caminhos (em objetos logados) cujo valor é substituído por `[REDACTED]`. */
export const LOG_REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'password',
  'token',
  'csrfToken',
  '*.password',
  '*.token',
  '*.csrfToken',
  '*.apiKey',
  // Chaves de terceiros (T3): a chave só entra no servidor no corpo de um POST, que não é logado; isto é a 2ª barreira.
  'apiKey',
  'key',
  '*.key',
  // Segundo fator: segredo TOTP e token de ativação nunca vão ao log (o código de 6 dígitos nem é passado ao logger).
  'secret',
  'enrollmentToken',
  '*.secret',
  '*.enrollmentToken',
];

export interface LoggerOptions {
  level: string;
  /** Nome do serviço, presente em toda linha (api, worker). */
  name: string;
  /** Destino alternativo (testes capturam o log aqui). Padrão: stdout. */
  destination?: DestinationStream;
}

/** Inicializa o logger dos serviços com redação defensiva e destino substituível pelas provas de segurança. */
export function createLogger({ level, name, destination }: LoggerOptions): Logger {
  return pino(
    {
      level,
      name,
      redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' },
    },
    destination,
  );
}

/**
 * Projeta erros do PostgreSQL/pg-boss para diagnóstico sem serializar mensagem, stack, causa ou propriedades do cliente.
 * Esses objetos podem carregar configuração, SQL, senha e chave de cancelamento; só o código padronizado é público no log.
 * O texto fixo do handler identifica a operação que falhou, mesmo quando o driver não fornece código.
 */
export function databaseErrorForLog(error: unknown): { type: string; code?: string } {
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const safeCode = typeof code === 'string' && (/^[0-9A-Z]{5}$/.test(code) || ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(code));
  return { type: 'DatabaseError', ...(safeCode ? { code } : {}) };
}

export type { Logger };
/** Destino de log aceito por `createLogger` (stdout por padrão; testes capturam num stream próprio). */
export type LogDestination = DestinationStream;

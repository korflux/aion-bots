// Cliente HTTP da web para a API (mesma origem, /api). Só roda no navegador.
//
// - Cookie de sessão vai automaticamente (mesma origem, HttpOnly: o JS nunca o vê).
// - Requisições que alteram estado levam o token CSRF da sessão em `X-CSRF-Token`; o `Origin` o navegador envia.
// - Erros da API chegam no envelope `{ code, message }` e viram `ApiError` tipado. Sessão vencida
//   (AUTH_SESSION_EXPIRED) redireciona ao login preservando o destino, exceto no próprio login.
import { CSRF_HEADER, isErrorEnvelope, type ErrorCode, type FieldError } from '@aion/shared';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode | 'NETWORK_ERROR' | 'UNKNOWN';
  readonly fields: FieldError[] | undefined;
  /** Segundos até poder tentar de novo (cabeçalho Retry-After), quando a API informa. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    status: number,
    code: ApiError['code'],
    message: string,
    extra: { fields?: FieldError[]; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = extra.fields;
    this.retryAfterSeconds = extra.retryAfterSeconds;
  }
}

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Token CSRF da sessão; obrigatório em toda chamada autenticada que altera estado. */
  csrfToken?: string;
  /** Falso no login: 401 ali é credencial errada, não sessão vencida. */
  redirectOnExpired?: boolean;
  /** Prazo da chamada em milissegundos (padrão `API_TIMEOUT_MS`); estourado, vira `NETWORK_ERROR`. */
  timeoutMs?: number;
  /** Mantém a requisição viva se a página for descarregada (término da presença ao fechar a aba); corpo pequeno, como exige o navegador. */
  keepalive?: boolean;
}

/**
 * Prazo padrão de uma chamada à API. Sem prazo, uma requisição que o servidor aceita e nunca responde (processo travado, proxy preso,
 * rede móvel que cai sem fechar a conexão) deixaria a tela em "Carregando" para sempre, sem erro e sem "Tentar de novo" (E26). 90 s
 * cobre a chamada mais longa da API (o teste de modelo tem prazo de 60 s no servidor) com folga.
 */
export const API_TIMEOUT_MS = 90_000;

const GENERIC_ERROR = 'Não foi possível concluir. Tente novamente.';
const NETWORK_ERROR = 'Sem conexão com o servidor. Tente novamente.';
/** Intenção da saída no documento atual: o logout sempre recarrega /login, que reinicializa este estado. */
let signingOut = false;

/** Marca a saída ANTES de revogar a sessão: respostas 401 de chamadas em voo não podem preservar um destino após "Sair". */
export function beginSignOut(): void {
  signingOut = true;
}

/** Leva o dono ao login com o caminho atual em `next` (a página de login valida o valor). */
export function redirectToLogin(): void {
  if (signingOut) return;
  const here = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/login?next=${encodeURIComponent(here)}`);
}

/** Chama a API e devolve o JSON (ou `undefined` em 204). Lança ApiError em qualquer falha. */
export async function apiFetch<T = undefined>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { method = 'GET', body, csrfToken, redirectOnExpired = true, timeoutMs = API_TIMEOUT_MS, keepalive = false } = options;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (csrfToken) headers[CSRF_HEADER] = csrfToken;

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
      keepalive,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Falha de rede e prazo estourado (TimeoutError) caem aqui: as telas já tratam `NETWORK_ERROR` com "Tentar novamente".
    throw new ApiError(0, 'NETWORK_ERROR', NETWORK_ERROR);
  }

  if (response.ok) {
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  const payload: unknown = await response.json().catch(() => null);
  const retryAfter = Number(response.headers.get('retry-after'));
  if (isErrorEnvelope(payload)) {
    if (payload.code === 'AUTH_SESSION_EXPIRED' && redirectOnExpired) redirectToLogin();
    throw new ApiError(response.status, payload.code as ApiError['code'], payload.message, {
      fields: payload.fields,
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    });
  }
  throw new ApiError(response.status, 'UNKNOWN', GENERIC_ERROR);
}

/** Mensagem segura para toast ou erro inline: os erros da API já chegam sem detalhe técnico. */
export function apiErrorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Não foi possível concluir.';
}

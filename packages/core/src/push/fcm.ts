// Cliente do FCM (Firebase Cloud Messaging, API HTTP v1) para enviar UM push a UM dispositivo. É o único ponto do servidor que fala com o
// FCM (spec: "o servidor só chama OpenCode Go, Composio e FCM"); o despachante (`dispatcher.ts`) decide a quem e quando enviar.
//
// Por que HTTP direto e não o `firebase-admin`: o admin traz dezenas de pacotes para duas chamadas (trocar a credencial por um token de
// acesso e enviar a mensagem), e o destino precisa ser trocável por um servidor falso nos testes, como o OpenCode Go e o Composio.
// Autenticação: a conta de serviço assina um JWT RS256 (`node:crypto`, sem criptografia própria) que o Google troca por um token de acesso
// de 1 hora, guardado em memória e renovado pouco antes de vencer. A chave privada nunca é logada nem sai deste módulo.
//
// Mensagem: só `data` (título, corpo, caminho de abertura, tag, tipo e id do evento). O service worker da web (`apps/web/public/sw.js`) monta a
// notificação a partir dela, então o conteúdo exibido é exatamente o que este módulo envia. Nada da conversa passa por aqui: quem monta
// a mensagem entrega só o nome do bot e o tipo do evento.
//
// Resultado por envio (a decisão de remover o dispositivo é do despachante):
//   sent           aceito pelo FCM;
//   invalid_token  o token nunca mais vai funcionar (app desinstalado, token expirado, token de outro projeto), então o dispositivo sai;
//   failed         erro transitório ou de configuração (rede, 5xx, 429, credencial recusada): não remove ninguém e pode ser repetido.
// Junto do resultado, `send` devolve o status HTTP da resposta (nulo quando não houve resposta: rede, prazo ou falha na troca de credencial), que o despachante grava em
// `push_deliveries` (phase 16) para o funil separar "o FCM recusou" de "o FCM nem respondeu". Nunca o corpo da resposta, que pode ecoar o token.
import { createSign } from 'node:crypto';
import type { PushEventKind } from '@aion/shared';
import type { FcmServiceAccount } from '../config';
import { UPSTREAM_TIMEOUT_MS, UpstreamUnreachable, upstreamPostForm, upstreamPostJson, type FetchLike, type UpstreamResponse } from '../credentials/upstream-http';
import type { Logger } from '../logging';

/** Mensagem de push: só o necessário para o aviso e para abrir o cartão. */
export interface PushMessage {
  /** Nome do bot. */
  title: string;
  /** Tipo do evento em texto. */
  body: string;
  /** Caminho relativo da própria web que o toque abre (ex.: `/bots/<id>?mensagem=<id>`). */
  url: string;
  /** Por conversa e categoria: repetir a mesma tag substitui a notificação anterior, então uma retentativa ou um aviso novo da mesma conversa não empilha. */
  tag: string;
  kind: PushEventKind;
  /** Id do evento em `push_events` (texto de dígitos): o service worker o confere no servidor na chegada (phase 3, T3/T4). */
  eventId: string;
}

export type FcmSendResult = 'sent' | 'invalid_token' | 'failed';

/** Desfecho de UM envio: a classificação mais o status HTTP do FCM (nulo sem resposta). */
export interface FcmSendOutcome {
  result: FcmSendResult;
  status: number | null;
}

/** Porta do FCM usada pelo despachante. */
export interface FcmClient {
  send(token: string, message: PushMessage): Promise<FcmSendOutcome>;
}

export interface FcmClientOptions {
  serviceAccount: FcmServiceAccount;
  /** Base da API de mensagens (`https://fcm.googleapis.com`). Fixa na configuração do servidor, sem barra final. */
  baseUrl: string;
  /** Endpoint OAuth2 que troca o JWT assinado por um token de acesso. Fixo na configuração do servidor. */
  tokenUrl: string;
  logger?: Logger;
  fetchImpl?: FetchLike;
  now?: () => Date;
}

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
/** Validade pedida do JWT de troca (o Google aceita até 1 hora). */
const JWT_LIFETIME_S = 3600;
/** O token de acesso é renovado quando falta menos que isto para vencer. */
const ACCESS_TOKEN_MARGIN_MS = 60_000;
/** Quanto tempo o FCM guarda a mensagem para um dispositivo desligado: uma aprovação pendente vale por 24 horas. */
const MESSAGE_TTL_S = 24 * 3600;

const base64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

/** JWT RS256 da conta de serviço, o "assertion" da troca OAuth2 (RFC 7523). */
function signServiceAccountJwt(account: FcmServiceAccount, audience: string, nowMs: number): string {
  const issuedAt = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({ iss: account.clientEmail, scope: FCM_SCOPE, aud: audience, iat: issuedAt, exp: issuedAt + JWT_LIFETIME_S }),
  );
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(account.privateKey);
  return `${header}.${claims}.${base64url(signature)}`;
}

/** Códigos de erro do FCM no corpo da resposta (`error.details[].errorCode`) e campos inválidos (`fieldViolations[].field`). */
function describeFcmError(json: unknown): { codes: string[]; invalidFields: string[] } {
  const details = (json as { error?: { details?: unknown } } | undefined)?.error?.details;
  const codes: string[] = [];
  const invalidFields: string[] = [];
  if (Array.isArray(details)) {
    for (const detail of details as { errorCode?: unknown; fieldViolations?: { field?: unknown }[] }[]) {
      if (typeof detail?.errorCode === 'string') codes.push(detail.errorCode);
      for (const violation of detail?.fieldViolations ?? []) if (typeof violation?.field === 'string') invalidFields.push(violation.field);
    }
  }
  return { codes, invalidFields };
}

/**
 * Só remove o dispositivo quando o FCM diz EXPLICITAMENTE que o token não serve: `UNREGISTERED` (404), token malformado (400 com a
 * violação em `message.token`) ou token de outro projeto (`SENDER_ID_MISMATCH`). Um 404 sem o código (projeto errado, por exemplo) ou
 * um 400 por outro campo é erro de configuração do servidor, e apagar os dispositivos por causa dele perderia todos os registros.
 */
export function classifySendResponse({ status, json }: UpstreamResponse): FcmSendResult {
  if (status >= 200 && status < 300) return 'sent';
  const { codes, invalidFields } = describeFcmError(json);
  if (status === 404 && codes.includes('UNREGISTERED')) return 'invalid_token';
  if (status === 400 && invalidFields.includes('message.token')) return 'invalid_token';
  if (status === 403 && codes.includes('SENDER_ID_MISMATCH')) return 'invalid_token';
  return 'failed';
}

/** Cria o cliente. O token de acesso é guardado em memória; chamadas simultâneas durante a renovação esperam a mesma troca. */
export function createFcmClient({ serviceAccount, baseUrl, tokenUrl, logger, fetchImpl = fetch, now = () => new Date() }: FcmClientOptions): FcmClient {
  let cached: { value: string; expiresAtMs: number } | null = null;
  let renewing: Promise<string> | null = null;

  /** Troca o JWT assinado por um token de acesso. Lança se a troca falhar (credencial recusada, rede). */
  async function exchange(): Promise<string> {
    const assertion = signServiceAccountJwt(serviceAccount, tokenUrl, now().getTime());
    const response = await upstreamPostForm({
      url: tokenUrl,
      headers: {},
      body: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion },
      timeoutMs: UPSTREAM_TIMEOUT_MS,
      fetchImpl,
    });
    const body = response.json as { access_token?: unknown; expires_in?: unknown } | undefined;
    if (response.status !== 200 || typeof body?.access_token !== 'string') {
      throw new Error(`troca de credencial recusada (status ${response.status})`);
    }
    const lifetimeS = typeof body.expires_in === 'number' ? body.expires_in : JWT_LIFETIME_S;
    cached = { value: body.access_token, expiresAtMs: now().getTime() + lifetimeS * 1000 };
    return cached.value;
  }

  function accessToken(): Promise<string> {
    if (cached && cached.expiresAtMs - now().getTime() > ACCESS_TOKEN_MARGIN_MS) return Promise.resolve(cached.value);
    renewing ??= exchange().finally(() => {
      renewing = null;
    });
    return renewing;
  }

  return {
    async send(token, message) {
      try {
        const response = await upstreamPostJson({
          url: `${baseUrl}/v1/projects/${encodeURIComponent(serviceAccount.projectId)}/messages:send`,
          headers: { authorization: `Bearer ${await accessToken()}` },
          body: {
            message: {
              token,
              data: { title: message.title, body: message.body, url: message.url, tag: message.tag, kind: message.kind, eventId: message.eventId },
              webpush: { headers: { TTL: String(MESSAGE_TTL_S), Urgency: 'high' } },
            },
          },
          timeoutMs: UPSTREAM_TIMEOUT_MS,
          fetchImpl,
        });
        const result = classifySendResponse(response);
        if (response.status === 401) cached = null; // credencial recusada: a próxima tentativa faz a troca de novo
        // O corpo de erro do FCM nunca é logado (pode ecoar o token); só o status e os códigos.
        if (result === 'failed') logger?.warn({ status: response.status, codes: describeFcmError(response.json).codes }, 'FCM recusou o envio do push');
        return { result, status: response.status };
      } catch (error) {
        // Rede, prazo ou falha na troca de credencial: transitório, o despachante tenta de novo. Sem `token` no log.
        logger?.warn({ err: error instanceof UpstreamUnreachable ? 'FCM inacessível' : error }, 'falha ao enviar o push pelo FCM');
        return { result: 'failed', status: null };
      }
    },
  };
}

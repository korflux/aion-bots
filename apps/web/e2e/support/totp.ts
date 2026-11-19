// Ajudantes do E2E do autenticador. O "app autenticador" do teste é um oráculo INDEPENDENTE do servidor: RFC 6238
// reimplementado aqui (poucas linhas), para o E2E conferir o comportamento real em vez de repetir o código de
// produção. Também não importa nada de packages/core: a imagem Docker da web compila `e2e/` no `next build` sem
// instalar o core. O estado do TOTP é GLOBAL (dono único): quem liga o autenticador precisa desligá-lo no fim.
import { createHmac } from 'node:crypto';
import { expect, type BrowserContext } from '@playwright/test';
import { E2E_ORIGIN } from '../../../../tests/support/e2e-env';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 (RFC 4648) em bytes; o segredo vem do modal em maiúsculas, sem preenchimento. */
function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of text) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Janela de 30 s que contém o instante dado. */
const totpStepAt = (at: Date): number => Math.floor(at.getTime() / 30_000);

/** Código de 6 dígitos da janela (HMAC-SHA1 e truncamento dinâmico, RFC 4226 e 6238). */
function totpCodeForStep(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Código que o app autenticador mostraria agora, deslocado em `windowsAhead` janelas de 30 s. */
export const codeNow = (secret: string, windowsAhead = 0): string => totpCodeForStep(secret, totpStepAt(new Date()) + windowsAhead);

/** Código de 6 dígitos que não vale em nenhuma janela próxima (palpite errado garantido). */
export function wrongCode(secret: string): string {
  const valid = new Set([-3, -2, -1, 0, 1, 2, 3].map((delta) => codeNow(secret, delta)));
  for (let candidate = 0; ; candidate += 1) {
    const text = String(candidate).padStart(6, '0');
    if (!valid.has(text)) return text;
  }
}

/**
 * Próximo código ainda não usado que o servidor aceita agora. O servidor não aceita o mesmo código (nem janela
 * mais antiga) duas vezes; a janela mais nova que ele tolera é a seguinte à atual, então, se a última usada já é
 * essa, a única saída é esperar o relógio andar (no máximo 30 s).
 */
export async function freshCode(secret: string, lastUsedStep: number): Promise<{ code: string; step: number }> {
  for (;;) {
    const current = totpStepAt(new Date());
    const step = Math.max(lastUsedStep + 1, current);
    if (step <= current + 1) return { code: totpCodeForStep(secret, step), step };
    await sleep(1000);
  }
}

/**
 * Cabeçalhos de uma chamada à API em nome da sessão do contexto. O cookie vai explícito porque o `request` do
 * Playwright não reenvia cookie `Secure` por http (o navegador envia, por tratar 127.0.0.1 como seguro), e a API
 * da pilha de E2E roda em modo produção. O Origin e, nas mutações, o token CSRF, como o navegador enviaria.
 */
async function apiHeaders(context: BrowserContext, csrfToken?: string): Promise<Record<string, string>> {
  const session = (await context.cookies()).find((cookie) => cookie.name === 'aion_session');
  expect(session, 'sessão do dono no contexto').toBeDefined();
  const headers: Record<string, string> = { origin: E2E_ORIGIN, cookie: `aion_session=${session?.value}` };
  if (csrfToken) headers['x-csrf-token'] = csrfToken;
  return headers;
}

async function csrfTokenOf(context: BrowserContext): Promise<string> {
  const response = await context.request.get(`${E2E_ORIGIN}/api/auth/session`, { headers: await apiHeaders(context) });
  expect(response.status(), 'sessão do dono para gerir o TOTP').toBe(200);
  return ((await response.json()) as { csrfToken: string }).csrfToken;
}

/** O autenticador está ativo no servidor? */
export async function totpEnabled(context: BrowserContext): Promise<boolean> {
  const response = await context.request.get(`${E2E_ORIGIN}/api/auth/totp`, { headers: await apiHeaders(context) });
  expect(response.status(), 'estado do autenticador').toBe(200);
  return ((await response.json()) as { enabled: boolean }).enabled;
}

export interface ActiveTotp {
  secret: string;
  /** Última janela aceita pelo servidor para esse segredo (a da ativação, até alguém usar outra). */
  lastUsedStep: number;
  csrfToken: string;
}

/** Liga o autenticador pela API no contexto logado (sem passar pela tela) e devolve o segredo de teste. */
export async function enableTotpViaApi(context: BrowserContext): Promise<ActiveTotp> {
  const csrfToken = await csrfTokenOf(context);
  const setup = await context.request.post(`${E2E_ORIGIN}/api/auth/totp/setup`, { headers: await apiHeaders(context, csrfToken) });
  expect(setup.status(), 'abrir a ativação').toBe(200);
  const { secret, enrollmentToken } = (await setup.json()) as { secret: string; enrollmentToken: string };
  const lastUsedStep = totpStepAt(new Date());
  const enable = await context.request.post(`${E2E_ORIGIN}/api/auth/totp/enable`, {
    headers: await apiHeaders(context, csrfToken),
    data: { enrollmentToken, code: codeNow(secret) },
  });
  expect(enable.status(), 'confirmar a ativação').toBe(204);
  return { secret, lastUsedStep, csrfToken };
}

/** Desliga o autenticador pela API (limpeza): usa o próximo código livre, esperando a janela se preciso. */
export async function disableTotpViaApi(context: BrowserContext, totp: ActiveTotp): Promise<void> {
  const { code } = await freshCode(totp.secret, totp.lastUsedStep);
  const response = await context.request.post(`${E2E_ORIGIN}/api/auth/totp/disable`, {
    headers: await apiHeaders(context, totp.csrfToken),
    data: { code },
  });
  expect(response.status(), 'desativar o autenticador').toBe(204);
}

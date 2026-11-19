// Leitura e validação da configuração por variáveis de ambiente, para api e worker.
//
// Contrato de segurança (AGENTS.md e aceite de T1): faltando ou inválida uma variável obrigatória, o serviço
// não inicia, e o erro cita só o NOME da variável e a dica de formato, nunca o valor recebido. A validação é
// feita numa função pura (`env` entra como parâmetro) para ser testável sem mexer em `process.env`.
import { firebaseWebConfigSchema, PublicOriginMissingError, resolvePublicOrigin, type PushConfig } from '@aion/shared';
import { z } from 'zod';
import { parseMasterKey } from './crypto/keys';

export interface ConfigIssue {
  variable: string;
  problem: string;
}

/** Falha de configuração; a mensagem lista apenas nomes de variáveis, nunca valores. */
export class ConfigError extends Error {
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    super(`Configuração inválida: ${issues.map((i) => `${i.variable} ${i.problem}`).join('; ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export type Env = Record<string, string | undefined>;

/** Dicas de formato exibidas quando uma variável está presente mas inválida. Nunca contêm valores. */
const HINTS: Record<string, string> = {
  NODE_ENV: 'development, test ou production',
  LOG_LEVEL: 'fatal, error, warn, info, debug, trace ou silent',
  PORT: 'inteiro de 1 a 65535',
  DATABASE_URL: 'URL postgres://...',
  AION_OWNER_EMAIL: 'e-mail com até 254 caracteres',
  AION_OWNER_PASSWORD: 'de 12 a 256 caracteres',
  AION_MASTER_KEY: '32 bytes em base64 ou hex, ex.: openssl rand -base64 32',
  AION_PUBLIC_ORIGIN: 'origin sem barra final, ex.: https://aion.exemplo.com',
  AION_TRUSTED_PROXIES: 'lista separada por vírgula de IP/CIDR ou loopback, linklocal, uniquelocal',
  AION_ALLOW_DESTRUCTIVE_MIGRATIONS: 'true ou false',
  AION_OPENCODE_GO_BASE_URL: 'URL https sem credenciais (http só em loopback), ex.: https://opencode.ai/zen/go/v1',
  AION_ANTHROPIC_BASE_URL: 'URL https sem credenciais (http só em loopback), ex.: https://api.anthropic.com/v1',
  AION_COMPOSIO_BASE_URL: 'URL https sem credenciais (http só em loopback), ex.: https://backend.composio.dev/api/v3',
  AION_PARALLEL_BASE_URL: 'URL https sem credenciais (http só em loopback), ex.: https://search.parallel.ai/mcp',
  AION_TOTP_RESET: 'true ou false',
  AION_ATTACHMENTS_MAX_TOTAL_MB: 'inteiro positivo em MB, até 1048576',
  AION_FCM_SERVICE_ACCOUNT: 'JSON da conta de serviço do Firebase (ou esse JSON em base64)',
  AION_FCM_BASE_URL: 'URL https sem credenciais (http só em loopback), ex.: https://fcm.googleapis.com',
  AION_FCM_TOKEN_URL: 'URL https sem credenciais (http só em loopback), ex.: https://oauth2.googleapis.com/token',
  AION_FCM_WEB_CONFIG: 'JSON do app web do Firebase com apiKey, projectId, messagingSenderId e appId (ou esse JSON em base64)',
  AION_FCM_VAPID_KEY: 'chave VAPID pública do Firebase (base64url)',
  AION_SANDBOX_URL: 'URL http(s) da rede interna sem credenciais, consulta nem caminho, ex.: http://aion_sandbox:8080',
  AION_SANDBOX_TOKEN: 'de 32 a 512 caracteres ASCII imprimíveis sem espaço, ex.: openssl rand -hex 32',
};

const emptyToUndefined = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);

function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'postgres:' || url.protocol === 'postgresql:';
  } catch {
    return false;
  }
}

function isOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

/** Hosts em que `http:` é aceito para um destino de saída (servidores falsos dos testes); fora deles, só https. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Destino de saída fixo (OpenCode Go, Anthropic, Composio, Parallel): URL https sem credenciais, consulta nem fragmento. Essas URLs só
 * vêm do ambiente do servidor; nenhuma entrada do usuário escolhe para onde a API faz requisição (anti-SSRF).
 */
function isUpstreamBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  } catch {
    return false;
  }
}

/** Endpoint MCP da Parallel usado quando `AION_PARALLEL_BASE_URL` não é informada (o endereço é o próprio endpoint, sem sufixo de caminho). */
const PARALLEL_DEFAULT_URL = 'https://search.parallel.ai/mcp';

/** Base da API da Anthropic usada quando `AION_ANTHROPIC_BASE_URL` não é informada (a versão `/v1` faz parte da base, como no OpenCode Go). */
const ANTHROPIC_DEFAULT_URL = 'https://api.anthropic.com/v1';

/** Schema de um destino de saída com valor padrão; a barra final é removida para montar caminhos sem `//`. */
const upstreamBaseUrl = (defaultUrl: string) =>
  z.preprocess(emptyToUndefined, z.string().trim().refine(isUpstreamBaseUrl).default(defaultUrl)).transform((value) =>
    String(value).replace(/\/+$/, ''),
  );

/** Conta de serviço do Firebase: só os três campos que o envio de push usa (o resto do JSON baixado é descartado). */
export interface FcmServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

const fcmServiceAccountSchema = z.object({
  project_id: z.string().min(1).max(128),
  client_email: z.string().min(3).max(254),
  private_key: z.string().max(8192).includes('PRIVATE KEY'),
});

/**
 * Lê um JSON de uma variável de ambiente: o texto direto ou o mesmo JSON em base64. O base64 existe porque alguns painéis (o Easypanel)
 * mexem nas aspas de um valor com JSON e o deixam inválido; em base64 não há aspas para estragar, e cola numa linha só.
 */
function parseJsonOrBase64(raw: string): unknown {
  const text = raw.trim();
  return JSON.parse(text.startsWith('{') ? text : Buffer.from(text, 'base64').toString('utf8'));
}

/**
 * Lê a conta de serviço do Firebase da variável: o JSON como o console o baixa, ou o mesmo JSON em base64. Nulo se não for nenhum dos
 * dois; o chamador cita só o NOME da variável, nunca o valor (que contém a chave privada).
 */
export function parseFcmServiceAccount(raw: string): FcmServiceAccount | null {
  try {
    const parsed = fcmServiceAccountSchema.safeParse(parseJsonOrBase64(raw));
    if (!parsed.success) return null;
    return { projectId: parsed.data.project_id, clientEmail: parsed.data.client_email, privateKey: parsed.data.private_key };
  } catch {
    return null;
  }
}

/** Configuração pública do app web do Firebase (JSON ou base64); campos além dos quatro usados são descartados. */
function parseFirebaseWebConfig(raw: string) {
  try {
    const parsed = firebaseWebConfigSchema.safeParse(parseJsonOrBase64(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Variável OPCIONAL: ausente ou em branco vale `undefined`; presente e inválida vale `undefined` TAMBÉM e entra em `issues`, em vez de
 * impedir a subida. É a regra do push (T10): um recurso opcional mal configurado não pode tirar do ar a API nem o worker (que executa
 * os bots); o dono vê o erro no log, que cita só o NOME da variável e a dica de formato, nunca o valor.
 */
function readOptional<T>(
  env: Env,
  variable: string,
  parse: (raw: string) => T | null,
  issues: ConfigIssue[],
  /** O que deixa de funcionar sem a variável, dito no aviso do log. */
  effect = 'o push fica desligado',
): T | undefined {
  const raw = env[variable]?.trim();
  if (!raw) return undefined;
  const value = parse(raw);
  if (value === null) {
    issues.push({ variable, problem: `inválida (${HINTS[variable] ?? 'formato incorreto'}); ${effect}` });
    return undefined;
  }
  return value;
}

/** Destino de saída opcional (padrão do Google quando ausente ou inválido), sem a barra final. */
const parseUpstreamUrl = (raw: string): string | null => (isUpstreamBaseUrl(raw) ? raw.replace(/\/+$/, '') : null);

/**
 * Endereço do serviço sandbox (phase 4, CODE-01): fica na rede interna do Easypanel (`http://aion_sandbox:8080`), então aceita `http` em qualquer
 * host, mas sem credenciais, consulta, fragmento nem caminho (o cliente monta `/run` e `/health`). Vem só do ambiente do servidor (anti-SSRF).
 */
function parseSandboxUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** Configuração do sandbox: endereço interno e token próprio (o mesmo do serviço). */
export interface SandboxConfig {
  url: string;
  token: string;
}

/**
 * Sandbox opcional (phase 4, F8 e F11, Suposição 22a): só existe com as DUAS variáveis válidas. Ausentes, o Python não é oferecido e nada mais muda;
 * inválida ou só uma delas, o aviso vai ao log (só o nome da variável) e o Python fica desligado, sem impedir a subida. Lido pela API (conferência de
 * saúde em Configurações) e pelo worker (a ferramenta `run_python`). O token tem pelo menos 32 caracteres, como o próprio sandbox exige.
 */
function readSandboxConfig(env: Env, warnings: ConfigIssue[]): SandboxConfig | null {
  const effect = 'o Python fica desligado';
  const before = warnings.length;
  const url = readOptional(env, 'AION_SANDBOX_URL', parseSandboxUrl, warnings, effect);
  const token = readOptional(env, 'AION_SANDBOX_TOKEN', (raw) => (/^[!-~]{32,512}$/.test(raw) ? raw : null), warnings, effect);
  if (url !== undefined && token !== undefined) return { url, token };
  if (warnings.length === before && (url !== undefined || token !== undefined)) {
    warnings.push({ variable: url === undefined ? 'AION_SANDBOX_URL' : 'AION_SANDBOX_TOKEN', problem: `ausente (as duas variáveis do sandbox andam juntas); ${effect}` });
  }
  return null;
}

/** Um item da lista de proxies confiáveis: palavra-chave do proxy-addr ou IP/CIDR (v4 ou v6). */
const TRUSTED_PROXY_ITEM = /^(loopback|linklocal|uniquelocal|[0-9a-fA-F:.]{2,45}(\/\d{1,3})?)$/;

function parseTrustedProxies(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

const nodeEnv = z.preprocess(emptyToUndefined, z.enum(['development', 'test', 'production']).default('development'));
const logLevel = z.preprocess(
  emptyToUndefined,
  z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
);
const databaseUrl = z.string().refine(isPostgresUrl);

/** Roda o schema e converte qualquer falha em ConfigError sem ecoar valores recebidos. */
function parseEnv<S extends z.ZodType>(schema: S, env: Env): z.output<S> {
  const result = schema.safeParse(env);
  if (result.success) return result.data;

  const seen = new Set<string>();
  const issues: ConfigIssue[] = [];
  for (const issue of result.error.issues) {
    const variable = String(issue.path[0] ?? 'desconhecida');
    if (seen.has(variable)) continue;
    seen.add(variable);
    const raw = env[variable];
    const missing = raw === undefined || raw.trim() === '';
    issues.push({ variable, problem: missing ? 'ausente' : `inválida (${HINTS[variable] ?? 'formato incorreto'})` });
  }
  throw new ConfigError(issues);
}

/** Em produção, debug/trace ficam desabilitados (spec: "debug desabilitado em produção"). */
function effectiveLogLevel(level: string, isProduction: boolean): string {
  return isProduction && (level === 'debug' || level === 'trace') ? 'info' : level;
}

const attachmentsQuota = z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(1048576).default(1024));

const apiEnvSchema = z.object({
  NODE_ENV: nodeEnv,
  LOG_LEVEL: logLevel,
  PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(65535).default(3001)),
  DATABASE_URL: databaseUrl,
  AION_ATTACHMENTS_MAX_TOTAL_MB: attachmentsQuota,
  AION_OWNER_EMAIL: z
    .string()
    .trim()
    .min(3)
    .max(254)
    .refine((v) => v.includes('@')),
  AION_OWNER_PASSWORD: z.string().min(12).max(256),
  AION_MASTER_KEY: z.string().refine((v) => parseMasterKey(v) !== null),
  AION_PUBLIC_ORIGIN: z.preprocess(emptyToUndefined, z.string().refine(isOrigin).optional()),
  AION_TRUSTED_PROXIES: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .refine((v) => parseTrustedProxies(v).every((item) => TRUSTED_PROXY_ITEM.test(item)))
      .optional(),
  ),
  AION_ALLOW_DESTRUCTIVE_MIGRATIONS: z.preprocess(emptyToUndefined, z.enum(['true', 'false']).default('false')),
  AION_OPENCODE_GO_BASE_URL: upstreamBaseUrl('https://opencode.ai/zen/go/v1'),
  AION_ANTHROPIC_BASE_URL: upstreamBaseUrl(ANTHROPIC_DEFAULT_URL),
  AION_COMPOSIO_BASE_URL: upstreamBaseUrl('https://backend.composio.dev/api/v3'),
  AION_PARALLEL_BASE_URL: upstreamBaseUrl(PARALLEL_DEFAULT_URL),
  AION_TOTP_RESET: z.preprocess(emptyToUndefined, z.enum(['true', 'false']).default('false')),
});

export interface ApiConfig {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  logLevel: string;
  port: number;
  databaseUrl: string;
  /** Teto global de bytes armazenados em anexos. */
  attachmentsMaxTotalBytes: number;
  ownerEmail: string;
  /** Senha do dono em texto: só entra no verificador na subida e não deve ser retida (AUTH-02). */
  ownerPassword: string;
  masterKey: Buffer;
  /** Origin exato que a web usa; base do CSRF (Origin igual) e de HSTS/CSP. */
  publicOrigin: string;
  /**
   * Proxies em que a API confia para ler o IP do cliente em X-Forwarded-For (IP/CIDR ou palavras-chave do
   * proxy-addr). Vazio = não confia em nenhum. Só o IP do *par* da conexão é validado contra a lista, então
   * um cliente que alcance a API direto não consegue forjar o próprio IP.
   */
  trustedProxies: string[];
  /** Só com pedido explícito do dono uma migration marcada como destrutiva roda no deploy. */
  allowDestructiveMigrations: boolean;
  /** Base da API do OpenCode Go (provedor de IA). Fixa no servidor, sem barra final. */
  opencodeGoBaseUrl: string;
  /** Base da API da Anthropic (segundo provedor de modelos, phase 17). Fixa no servidor, sem barra final; a chave entra pela tela de Configurações, nunca por variável. */
  anthropicBaseUrl: string;
  /** Base da API v3 do Composio (conector). Fixa no servidor, sem barra final. */
  composioBaseUrl: string;
  /** Endpoint MCP da Parallel (pesquisa na web). Fixo no servidor, sem barra final; a chave opcional entra pela tela de Configurações. */
  parallelBaseUrl: string;
  /** Recuperação: desativa o autenticador TOTP na inicialização (perda do celular). Remover após o uso. */
  totpReset: boolean;
  /** Web push (T10): o que a API entrega ao navegador para obter o token do FCM. `enabled: false` sem o Firebase configurado ou com ele inválido. */
  push: PushConfig;
  /** Sandbox do Python (phase 4, F11): só para a conferência de saúde de Configurações → Python; nulo sem a configuração. */
  sandbox: SandboxConfig | null;
  /** Variáveis opcionais inválidas que foram ignoradas (o push fica desligado); o bootstrap as registra no log, só com o nome da variável. */
  warnings: ConfigIssue[];
}

/**
 * Origin público pela fonte única (`resolvePublicOrigin`, também usada pelo proxy da web). Em produção sem a variável, a falha
 * vira `ConfigError` para a API não subir e o erro sair no mesmo formato das demais variáveis obrigatórias.
 */
function loadPublicOrigin(configured: string | undefined, nodeEnv: string): string {
  try {
    return resolvePublicOrigin(configured, nodeEnv);
  } catch (error) {
    if (error instanceof PublicOriginMissingError) throw new ConfigError([{ variable: 'AION_PUBLIC_ORIGIN', problem: 'ausente (obrigatória em produção)' }]);
    throw error;
  }
}

/** Configuração da API. Lança ConfigError (sem valores) se algo obrigatório faltar ou for inválido. */
export function loadApiConfig(env: Env): ApiConfig {
  const parsed = parseEnv(apiEnvSchema, env);
  const isProduction = parsed.NODE_ENV === 'production';
  // parseEnv já garantiu que a chave mestra é válida.
  const masterKey = parseMasterKey(parsed.AION_MASTER_KEY) as Buffer;
  const publicOrigin = loadPublicOrigin(parsed.AION_PUBLIC_ORIGIN, parsed.NODE_ENV);
  // Push (T10): opcional e NUNCA fatal. As duas variáveis andam juntas: uma sozinha deixaria o aviso de ativação aparecer sem poder funcionar.
  const warnings: ConfigIssue[] = [];
  const webConfig = readOptional(env, 'AION_FCM_WEB_CONFIG', parseFirebaseWebConfig, warnings);
  const vapidKey = readOptional(env, 'AION_FCM_VAPID_KEY', (raw) => (/^[A-Za-z0-9_-]{20,256}$/.test(raw) ? raw : null), warnings);
  const pushReady = webConfig !== undefined && vapidKey !== undefined;
  if (!pushReady && warnings.length === 0 && (webConfig !== undefined || vapidKey !== undefined)) {
    warnings.push({ variable: webConfig === undefined ? 'AION_FCM_WEB_CONFIG' : 'AION_FCM_VAPID_KEY', problem: 'ausente (as duas variáveis do push andam juntas); o push fica desligado' });
  }
  return {
    nodeEnv: parsed.NODE_ENV,
    isProduction,
    logLevel: effectiveLogLevel(parsed.LOG_LEVEL, isProduction),
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    attachmentsMaxTotalBytes: parsed.AION_ATTACHMENTS_MAX_TOTAL_MB * 1024 * 1024,
    ownerEmail: parsed.AION_OWNER_EMAIL,
    ownerPassword: parsed.AION_OWNER_PASSWORD,
    masterKey,
    publicOrigin,
    // Em produção a API só é alcançável pela rede interna do Easypanel (Traefik), então redes privadas são o par.
    trustedProxies: parseTrustedProxies(parsed.AION_TRUSTED_PROXIES ?? (isProduction ? 'loopback,uniquelocal' : '')),
    allowDestructiveMigrations: parsed.AION_ALLOW_DESTRUCTIVE_MIGRATIONS === 'true',
    opencodeGoBaseUrl: parsed.AION_OPENCODE_GO_BASE_URL,
    anthropicBaseUrl: parsed.AION_ANTHROPIC_BASE_URL,
    composioBaseUrl: parsed.AION_COMPOSIO_BASE_URL,
    parallelBaseUrl: parsed.AION_PARALLEL_BASE_URL,
    totpReset: parsed.AION_TOTP_RESET === 'true',
    push: pushReady ? { enabled: true, firebase: webConfig, vapidKey } : { enabled: false },
    sandbox: readSandboxConfig(env, warnings),
    warnings,
  };
}

const workerEnvSchema = z.object({
  NODE_ENV: nodeEnv,
  LOG_LEVEL: logLevel,
  DATABASE_URL: databaseUrl,
  AION_ATTACHMENTS_MAX_TOTAL_MB: attachmentsQuota,
  AION_MASTER_KEY: z.string().refine((v) => parseMasterKey(v) !== null),
  AION_OPENCODE_GO_BASE_URL: upstreamBaseUrl('https://opencode.ai/zen/go/v1'),
  AION_ANTHROPIC_BASE_URL: upstreamBaseUrl(ANTHROPIC_DEFAULT_URL),
  AION_COMPOSIO_BASE_URL: upstreamBaseUrl('https://backend.composio.dev/api/v3'),
  AION_PARALLEL_BASE_URL: upstreamBaseUrl(PARALLEL_DEFAULT_URL),
});

export interface WorkerConfig {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  logLevel: string;
  databaseUrl: string;
  /** Teto global de bytes armazenados em anexos. */
  attachmentsMaxTotalBytes: number;
  /** Decifra a chave do provedor (e, na T7, a do Composio) para chamar os serviços externos em nome do dono. */
  masterKey: Buffer;
  /** Destinos de saída fixos, os mesmos da API (nenhuma entrada do usuário os escolhe). */
  opencodeGoBaseUrl: string;
  anthropicBaseUrl: string;
  composioBaseUrl: string;
  parallelBaseUrl: string;
  /** Conta de serviço do Firebase que assina o envio de push; nula sem ela (os avisos pendentes são descartados com um aviso no log). */
  fcmServiceAccount: FcmServiceAccount | null;
  /** Destinos de saída fixos do FCM (API de mensagens e emissão do token de acesso). */
  fcmBaseUrl: string;
  fcmTokenUrl: string;
  /** Sandbox do Python (phase 4, F8): com ele o motor oferece `run_python`; nulo sem a configuração (a ferramenta não existe). */
  sandbox: SandboxConfig | null;
  /** Variáveis opcionais inválidas que foram ignoradas; o bootstrap as registra no log, só com o nome da variável. */
  warnings: ConfigIssue[];
}

/**
 * Configuração do worker: só o que ele precisa (menor privilégio, sem credencial do dono). Desde a T6 ele executa os
 * bots e por isso recebe a chave mestra, para decifrar a chave do provedor guardada no banco.
 */
export function loadWorkerConfig(env: Env): WorkerConfig {
  const parsed = parseEnv(workerEnvSchema, env);
  const isProduction = parsed.NODE_ENV === 'production';
  // Push (T10): opcional e NUNCA fatal (o worker executa os bots). Conta de serviço inválida desliga o envio; URL inválida volta ao padrão.
  const warnings: ConfigIssue[] = [];
  const fcmServiceAccount = readOptional(env, 'AION_FCM_SERVICE_ACCOUNT', parseFcmServiceAccount, warnings) ?? null;
  const fcmBaseUrl = readOptional(env, 'AION_FCM_BASE_URL', parseUpstreamUrl, warnings) ?? 'https://fcm.googleapis.com';
  const fcmTokenUrl = readOptional(env, 'AION_FCM_TOKEN_URL', parseUpstreamUrl, warnings) ?? 'https://oauth2.googleapis.com/token';
  return {
    nodeEnv: parsed.NODE_ENV,
    isProduction,
    logLevel: effectiveLogLevel(parsed.LOG_LEVEL, isProduction),
    databaseUrl: parsed.DATABASE_URL,
    attachmentsMaxTotalBytes: parsed.AION_ATTACHMENTS_MAX_TOTAL_MB * 1024 * 1024,
    masterKey: parseMasterKey(parsed.AION_MASTER_KEY) as Buffer,
    opencodeGoBaseUrl: parsed.AION_OPENCODE_GO_BASE_URL,
    anthropicBaseUrl: parsed.AION_ANTHROPIC_BASE_URL,
    composioBaseUrl: parsed.AION_COMPOSIO_BASE_URL,
    parallelBaseUrl: parsed.AION_PARALLEL_BASE_URL,
    fcmServiceAccount,
    fcmBaseUrl,
    fcmTokenUrl,
    sandbox: readSandboxConfig(env, warnings),
    warnings,
  };
}

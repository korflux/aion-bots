// Contratos das chaves de terceiros (F3 OpenCode Go, F4 Composio e, desde a phase 17, a da Anthropic) compartilhados entre a API e a web.
//
// Regra central (SEC-01 e C2): a chave atravessa o navegador uma única vez, no corpo do POST de salvar. Nada aqui
// descreve uma resposta que carregue a chave: o servidor devolve apenas o estado e a versão mascarada, e o
// serializador da API (schemas abaixo, que descartam campos desconhecidos) é a segunda barreira contra vazamento.
import { z } from 'zod';

/**
 * As credenciais guardadas: a do provedor de IA (OpenCode Go), a do conector de ferramentas (Composio), a chave OPCIONAL da pesquisa na web
 * (Parallel, `web_search`) e a do segundo provedor de modelos (Anthropic, `anthropic`, phase 17). As duas primeiras são obrigatórias para os bots
 * trabalharem; a Anthropic é opcional (sem ela só os modelos do OpenCode Go existem) mas aparece em `CredentialsOverview` como as duas primeiras;
 * a da pesquisa vale sem chave (nível anônimo) e seu estado é lido junto do interruptor, em `webSearchSettingsSchema` (settings.ts).
 */
export const CREDENTIAL_KINDS = ['provider', 'connector', 'web_search', 'anthropic'] as const;
export const credentialKindSchema = z.enum(CREDENTIAL_KINDS);
export type CredentialKind = z.infer<typeof credentialKindSchema>;

/**
 * Chave de API enviada para salvar: 1 a 512 caracteres (spec F3/F4), sem espaços nas pontas (removidos antes de
 * validar, porque colar com quebra de linha é o erro mais comum). Só ASCII imprimível e sem espaço interno:
 * a chave vira cabeçalho HTTP, e isso impede injeção de cabeçalho por quebra de linha.
 */
export const apiKeyInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^[\x21-\x7E]+$/);

export const saveCredentialRequestSchema = z.strictObject({ key: apiKeyInputSchema });
export type SaveCredentialRequest = z.infer<typeof saveCredentialRequestSchema>;

export const credentialKindParamsSchema = z.strictObject({ kind: credentialKindSchema });

/** Estado de uma credencial. `masked` é "••••" mais os últimos caracteres; a chave inteira nunca sai do servidor. */
export const credentialStatusSchema = z.object({
  kind: credentialKindSchema,
  configured: z.boolean(),
  masked: z.string().nullable(),
  updatedAt: z.iso.datetime().nullable(),
  /** Total de modelos vistos na última validação. Só os dois provedores de modelos (OpenCode Go e Anthropic) têm; `null` no conector e na pesquisa na web. */
  modelCount: z.number().int().nonnegative().nullable(),
});
export type CredentialStatus = z.infer<typeof credentialStatusSchema>;

export const credentialsOverviewSchema = z.object({
  provider: credentialStatusSchema,
  connector: credentialStatusSchema,
  anthropic: credentialStatusSchema,
});
export type CredentialsOverview = z.infer<typeof credentialsOverviewSchema>;

/**
 * Há algum provedor de modelos com chave salva? É o que "Configure um provedor" pergunta (envio, edição, rotina, composer e resumo de Conexões): um dono só com a chave da Anthropic já pode conversar, e
 * a chave do provedor do MODELO escolhido é conferida na execução (`PROVIDER_NOT_CONFIGURED` se faltar a dele). Fonte única da regra, no servidor e na tela.
 */
export const hasModelProvider = (overview: Pick<CredentialsOverview, 'provider' | 'anthropic'>): boolean => overview.provider.configured || overview.anthropic.configured;

/** Estado do selo de um app ou de uma conta do Composio (F4): ativo, pendente de autorização ou que requer atenção. É a base dos estados da conta (`connector-accounts.ts`). */
export const connectorAppStatusSchema = z.enum(['active', 'pending', 'attention']);
export type ConnectorAppStatus = z.infer<typeof connectorAppStatusSchema>;

/** Um app com conta conectada, como a porta do Composio o lê (`ConnectorClient.listConnectedApps`, que valida a chave ao salvá-la). Não há rota nem tela da lista de apps: a tela lista contas. */
export const connectorAppSchema = z.object({
  /** Identificador do app (toolkit) no Composio, ex.: `gmail`. */
  slug: z.string(),
  /** Nome legível do app. */
  name: z.string(),
  status: connectorAppStatusSchema,
});
export type ConnectorApp = z.infer<typeof connectorAppSchema>;

/** Texto do estado vazio `CONNECTOR_NO_APPS` (spec F4). */
export const CONNECTOR_NO_APPS_MESSAGE = 'Nenhum app conectado no Composio. Conecte apps no painel do Composio.';

/** Painel do Composio onde o dono conecta apps (link externo aberto pelo navegador, nunca buscado pelo servidor). */
export const COMPOSIO_DASHBOARD_URL = 'https://app.composio.dev';

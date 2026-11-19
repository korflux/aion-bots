// Contratos das contas do conector (Composio) liberadas por bot (phase 13, CONN-02), compartilhados entre a API, o core e a web.
//
// Vocabulário:
// - CONTA: uma conta conectada no painel do Composio (o Aion não faz OAuth), identificada pelo id que o Composio dá a ela. O dono pode conectar várias do mesmo app
//   (um Gmail pessoal e um profissional).
// - NOME: o que o dono chama a conta no Aion (1 a 40 caracteres, único dentro do mesmo app) e o valor do parâmetro de conta que o modelo usa. Sem nome, a conta tem um
//   RÓTULO automático ("Gmail · ca_…1a2b"): o nome do app e o sufixo do id. O servidor sempre devolve o `label` pronto, nunca a tela o monta.
// - LIBERAÇÃO: o dono escolhe os bots que podem usar cada conta (Configurações → Conexões). O servidor a confere no banco a cada execução; nada aqui é permissão por si só.
// - VERSÃO: contador da conta, que muda a cada renomeação e a cada troca dos bots liberados. Quem altera manda a versão que leu (`expectedVersion`) e uma versão antiga é
//   recusada com `CONNECTOR_ACCOUNT_CONFLICT`, como nas tabelas (`tableShareSchema`).
// Nada aqui descreve uma resposta que carregue a chave do Composio (SEC-01): os schemas de resposta descartam campos desconhecidos e são a segunda barreira contra vazamento.
import { z } from 'zod';
import { connectorAppStatusSchema } from './credentials';

/** Tamanho máximo do nome que o dono dá a uma conta (decisão 6 da spec). */
export const CONNECTOR_ACCOUNT_NAME_MAX = 40;
/** Máximo de bots numa liberação (o mesmo teto das tabelas). */
export const CONNECTOR_ACCOUNT_RELEASE_MAX = 100;

/**
 * Id da conta no Composio, vindo da URL: o alfabeto dos ids do Composio (nanoid, com o prefixo `ca_`), de 1 a 200 caracteres, conferido na borda para nada fora dele chegar
 * ao banco nem a uma consulta.
 */
export const connectorAccountIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);

/** Versão da conta (inteiro não negativo, como contador). */
export const connectorAccountVersionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * Nome dado pelo dono: sem espaços nas pontas, normalizado (NFC), de 1 a 40 caracteres e sem caracteres de controle. O vazio não é um nome: quem quer voltar ao rótulo
 * automático envia `null` (ver `renameConnectorAccountRequestSchema`). A unicidade dentro do app é do serviço (`CONNECTOR_ACCOUNT_NAME_TAKEN`), que enxerga as outras contas.
 */
export const connectorAccountNameSchema = z.string().trim().normalize('NFC').min(1).max(CONNECTOR_ACCOUNT_NAME_MAX).regex(/^[^\p{Cc}]*$/u);

/**
 * Estado da conta: os do selo do app (ativa, pendente de autorização, que requer atenção) mais `disconnected`, para a conta que o Composio não lista mais (removida lá ou
 * chave trocada). A conta desconectada mantém nome e liberações e a execução nela é recusada ao modelo como resultado de ferramenta (`AccountRefusal` com o motivo `account_disconnected`, em `runs/tools.ts`).
 * Só ela pode ser REMOVIDA pelo dono (`DELETE /api/connector/accounts/:id`, R8): como reconectar o app no Composio gera outro id, a conta antiga não volta; o servidor recusa a remoção de
 * qualquer conta que o Composio ainda liste (`CONNECTOR_ACCOUNT_CONFLICT`).
 */
export const CONNECTOR_ACCOUNT_STATUSES = [...connectorAppStatusSchema.options, 'disconnected'] as const;
export const connectorAccountStatusSchema = z.enum(CONNECTOR_ACCOUNT_STATUSES);
export type ConnectorAccountStatus = z.infer<typeof connectorAccountStatusSchema>;

/** Uma conta como a tela de Conexões a mostra: o app, o nome (ou o rótulo), o estado, os bots liberados e a versão. */
export const connectorAccountViewSchema = z.object({
  id: connectorAccountIdSchema,
  /** App (toolkit) da conta no Composio, ex.: `gmail`, e o nome legível dele. */
  appSlug: z.string(),
  appName: z.string(),
  /** Nome dado pelo dono, ou nulo enquanto a conta usa o rótulo automático. */
  name: z.string().nullable(),
  /** O que aparece na tela, no cartão de aprovação e na auditoria: o nome do dono, ou o rótulo automático quando não há nome. */
  label: z.string(),
  status: connectorAccountStatusSchema,
  /** Bots a que a conta está liberada (a tela mostra nome e avatar pela lista de bots que ela já tem). */
  botIds: z.array(z.uuid()),
  version: connectorAccountVersionSchema,
});
export type ConnectorAccountView = z.infer<typeof connectorAccountViewSchema>;

/** Todas as contas conhecidas, ativas e desconectadas, ordenadas pelo servidor (app e depois nome ou rótulo). Lista vazia: nenhuma conta conectada no Composio. */
export const connectorAccountsResponseSchema = z.object({ accounts: z.array(connectorAccountViewSchema) });
export type ConnectorAccountsResponse = z.infer<typeof connectorAccountsResponseSchema>;

export const connectorAccountParamsSchema = z.strictObject({ id: connectorAccountIdSchema });

/** Renomear: um nome de 1 a 40 caracteres, ou `null` para limpar o nome e voltar ao rótulo automático. */
export const renameConnectorAccountRequestSchema = z.strictObject({
  name: connectorAccountNameSchema.nullable(),
  expectedVersion: connectorAccountVersionSchema,
});
export type RenameConnectorAccountRequest = z.infer<typeof renameConnectorAccountRequestSchema>;

/**
 * Liberar: a lista COMPLETA dos bots que passam a usar a conta (sem repetição); quem sai da lista perde o acesso. A lista vazia revoga todos.
 * O id do bot é normalizado para minúsculas (a forma canônica dos UUID no banco) ANTES da checagem de repetição, na origem: o serviço compara a lista recebida com os vínculos gravados, e
 * um UUID válido em maiúsculas passaria como "outro" bot (vínculo apagado e refeito, versão e auditoria de uma mudança que não houve); o mesmo bot em maiúsculas e minúsculas é repetição.
 */
export const releaseConnectorAccountRequestSchema = z.strictObject({
  botIds: z
    .array(z.uuid().toLowerCase())
    .max(CONNECTOR_ACCOUNT_RELEASE_MAX)
    .refine((ids) => new Set(ids).size === ids.length),
  expectedVersion: connectorAccountVersionSchema,
});
export type ReleaseConnectorAccountRequest = z.infer<typeof releaseConnectorAccountRequestSchema>;

/**
 * As contas liberadas a UM bot, só para leitura (seção do editor do bot): a conta sem a lista de bots nem a versão, porque o editor não altera nada (decisão 7: a liberação
 * tem uma única tela de edição).
 * `configured` diz se o Composio tem chave. É o estado explícito do Composio ainda não conectado, que o editor trata como orientação e não como falha: a seção abre em toda visita
 * ao bot, então responder erro (409) ali sujaria o console e o monitor de respostas do navegador a cada abertura. `false` vem sempre com a lista vazia e sem leitura do Composio nem
 * gravação; `true` traz a liberação do bot (possivelmente vazia). A leitura da tela de Conexões (`connectorAccountsResponseSchema`) não muda e segue recusando sem chave.
 * As falhas de uma chave que existe (`CONNECTOR_KEY_INVALID`, `CONNECTOR_UNAVAILABLE`) continuam erro nas duas rotas.
 */
export const botConnectorAccountsSchema = z.object({
  configured: z.boolean(),
  accounts: z.array(connectorAccountViewSchema.omit({ botIds: true, version: true })),
});
export type BotConnectorAccounts = z.infer<typeof botConnectorAccountsSchema>;

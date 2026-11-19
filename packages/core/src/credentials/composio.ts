// Adaptador do Composio (conector de ferramentas): UM módulo pequeno que isola o formato da API do serviço.
// T3 usa a listagem de contas conectadas para validar a chave e mostrar os apps; T7 (ferramentas e ações)
// reutiliza este cliente e a mesma chave decifrada.
//
// O QUE É CONFIRMADO E O QUE É SUPOSTO (documentação pública do Composio, API v3, consultada ao implementar T3):
// - Confirmado: base `https://backend.composio.dev/api/v3`, autenticação por cabeçalho `x-api-key`,
//   `GET /connected_accounts` com os filtros `limit` e `cursor`, resposta `{ items: [...], next_cursor }`, cada
//   item com `id`, `status` (INITIALIZING, INITIATED, ACTIVE, ...) e `toolkit.slug`; chave inválida devolve 401.
// - Suposto: `toolkit.name` pode existir (usamos se vier; senão derivamos do slug); os demais valores de `status`
//   além dos três documentados (ex.: FAILED, EXPIRED) caem em "requer atenção".
// - Decisão: a validação usa a própria listagem de apps (uma chamada só), porque é o endpoint mais simples que
//   exige a chave e devolve o que a tela precisa. O SDK TypeScript do Composio não é usado aqui: um GET basta,
//   e evitamos uma dependência; T7 pode adotá-lo para ferramentas e ações.
// ponytail: lê só a primeira página de contas (100, sem seguir next_cursor); com mais de 100 contas no Composio a excedente aparece como desconectada em Conexões e a execução nela é recusada.
//   A leitura vem marcada `truncated` (há `next_cursor`) e a remoção de conta (`ConnectorAccountService.remove`) a recusa, para nunca apagar nome e liberações de uma conta ativa que só
//   ficou fora da página; seguir next_cursor e remover essa recusa se o dono passar de 100 contas.
//
// T7 acrescenta ferramentas e ações ao mesmo adaptador (documentação pública do Composio, API v3, consultada ao implementar T7):
// - Confirmado: `GET /tools?toolkit_slug=&important=&limit=` lista as ferramentas de um app (cada item com `slug`, `name`,
//   `description`, `input_parameters` em JSON Schema e `toolkit {slug, name}`); `POST /tools/execute/{slug}` com corpo
//   `{ connected_account_id, arguments }` executa e responde `{ data, error, successful, log_id }`; ambos aceitam `x-api-key`.
// - Decisão: executar pela CONTA CONECTADA (`connected_account_id`, que a listagem de contas já informa), levando junto o `user_id`
//   (entity id) dessa mesma conta, que a listagem também informa. Só o id da conta NÃO basta: em produção o Composio recusou a
//   execução com HTTP 400 `ActionExecute_ConnectedAccountEntityIdRequired` (T24), e a documentação diz que toda execução é
//   escopada a um usuário. O `user_id` vem sempre da listagem (o Aion não o inventa nem o configura); isso resolve a dúvida
//   registrada na T3 sobre qual usuário executa a ação.
// ponytail: o campo `user_id` da listagem de contas está marcado como deprecado pelo Composio (pode deixar de vir); sem ele a execução
//   segue sem `user_id` e volta a ser recusada com o motivo legível, e a saída é o dono informar o user_id da conta (ou usar o SDK).
// - Decisão: só as ferramentas "importantes" de cada app entram na lista oferecida ao modelo (`important=true`), para não
//   estourar a janela de contexto com centenas de definições. Exceção (T26): um app SEM nenhuma ação marcada como importante (caso dos apps
//   MCP, como o Notion, que o bot não enxergava) usa a lista geral dele, também limitada a TOOLS_PER_TOOLKIT.
// ponytail: a lista de ferramentas vem só da primeira página (até TOOLS_PER_TOOLKIT por app), as importantes ou, sem elas, as primeiras do app;
//   trocar por uma busca sob demanda de ações se o dono precisar de ações fora desse conjunto.
//
// Por níveis (T29): o bot não recebe uma ferramenta por ação, e sim DUAS (buscar e executar; ver `runs/composio-tools.ts`). Este adaptador
// ganha o que elas precisam, ambos na API v3 (documentação pública, consultada ao implementar o T29):
// - Confirmado: `GET /tools?toolkit_slug=&query=&limit=` busca por texto (`query`: nome, slug ou descrição; `search` é o nome deprecado; `limit`
//   até 1000) e `GET /tools/{slug}` devolve UMA ferramenta (mesmos campos do item da listagem) ou 404 estruturado se o slug não existe.
// - Decisão: a busca pede poucos resultados (cada um traz o esquema inteiro, e a resposta tem teto de tamanho); `getTool` é a verificação, NO
//   SERVIDOR, de que o slug que o modelo escreveu existe: o modelo nunca é a autoridade sobre qual ação executa.
//
// Versão do app (T30): a API v3 SEM versão usa a versão BASE de cada app (`00000000_00`), um retrato antigo que a documentação diz "poder
// devolver menos ações que a interface"; os apps novos, como o Notion MCP, chegam a vir SEM nenhuma ação nela (a busca do bot voltava vazia
// para `notion_mcp` enquanto o Gmail, que é antigo, funcionava). A v3.1 assume a versão mais recente sozinha, mas aqui seguimos na v3 (as contas
// conectadas e as chaves já vivem nela) e PEDIMOS a mais recente de forma explícita: `toolkit_versions=latest` nas rotas de leitura de ações
// e `version: latest` no corpo da execução, as duas formas documentadas. Busca e execução usam a MESMA versão, então o esquema que o bot lê
// é o que o Composio executa.
// ponytail: seguir a versão mais recente significa que o Composio pode mudar o esquema de uma ação sem aviso; fixar uma versão datada
//   (`toolkit_versions=AAAAMMDD_NN`) por app se uma mudança quebrar um fluxo do dono.
//
// Recusa de uma ação (T22): quando o Composio responde 4xx a uma execução (argumentos inválidos, conta em estado inválido, ação inexistente),
// o corpo traz o MOTIVO em formato estruturado (`{ error: { message, slug, request_id, suggested_fix, errors } }`, documentação pública da
// API v3). Esse motivo é o que o bot precisa para corrigir a chamada e o que o dono precisa para diagnosticar; sem ele, "HTTP 400" não diz
// nada a ninguém. `refusalReason` extrai SÓ esses campos, remove a chave de API caso o serviço a ecoe, junta espaços e corta o tamanho.
// O corpo bruto continua não sendo repassado nem logado, e o log também não recebe o texto do motivo (só status, ferramenta, slug e request_id).
//
// Contas (phase 13, CONN-02): o dono conecta várias contas do mesmo app no painel do Composio e libera cada uma só aos bots que escolher. `listAccounts` devolve TODAS as contas com o
// estado de cada uma, SEM juntar por app (`listConnectedApps` junta e serve ao selo de cada app; quem quer só as ativas filtra por `status`); quem decide qual conta cada bot pode
// usar é o serviço de contas (`credentials/accounts.ts`), não este adaptador.
import { z } from 'zod';
import type { ConnectorApp, ConnectorAppStatus } from '@aion/shared';
import { DomainError } from '../errors';
import { UPSTREAM_TIMEOUT_MS, UpstreamUnreachable, classifyStatus, upstreamGetJson, upstreamPostJson } from './upstream-http';
import type { UpstreamClientOptions } from './opencode-go';

/** Porta do Composio usada por T3 (validar chave, listar apps) e T7 (ferramentas). Erros vêm como `DomainError`. */
export interface ConnectorClient {
  /**
   * Apps com conta conectada no Composio (um por app, com o melhor estado entre as contas dele). Lança
   * `CONNECTOR_KEY_INVALID` ou `CONNECTOR_UNAVAILABLE`.
   */
  listConnectedApps(apiKey: string): Promise<ConnectorApp[]>;
  /**
   * TODAS as contas conectadas (uma por conta, nunca juntas por app), na ordem em que o Composio as lista, cada uma com o estado dela (ativa, pendente de autorização ou que requer
   * atenção) e o id que a execução de uma ação usa. Mesmos erros de `listConnectedApps`. É a fonte do serviço de contas (nomes, liberações e a semeadura inicial).
   * Lê só a primeira página (100): com mais contas no Composio a lista vem com `truncated` verdadeiro.
   */
  listAccounts(apiKey: string): Promise<ConnectorAccountListings>;
  /** Ferramentas importantes de um app (até `TOOLS_PER_TOOLKIT`). Mesmos erros de `listConnectedApps`. */
  listTools(apiKey: string, toolkitSlug: string): Promise<ConnectorTool[]>;
  /** Busca por texto nas ferramentas de UM app, as mais relevantes primeiro (até `limit`). Mesmos erros de `listConnectedApps`. */
  searchTools(apiKey: string, toolkitSlug: string, query: string, limit: number): Promise<ConnectorTool[]>;
  /** Uma ferramenta pelo slug, ou nulo se o Composio diz que ela não existe (404). Mesmos erros de `listConnectedApps`. */
  getTool(apiKey: string, slug: string): Promise<ConnectorTool | null>;
  /**
   * Executa UMA ação numa conta conectada. Falha da ação (o app recusou, argumentos inválidos) volta como `{ ok: false }` com
   * texto seguro; chave recusada vira `CONNECTOR_KEY_INVALID` e o limite de taxa (429, recusado antes de executar), `CONNECTOR_UNAVAILABLE`.
   * Sem resposta confiável DEPOIS do envio (rede, prazo, 408, 5xx ou corpo ilegível) a ação pode ter sido executada: volta como
   * `{ ok: false, outcomeUnknown: true }` e o bot é avisado para confirmar antes de repetir. O corpo de erro do serviço nunca é
   * repassado. `signal` interrompe a espera (parada do dono, worker encerrando).
   */
  executeAction(apiKey: string, request: ActionRequest, signal?: AbortSignal): Promise<ActionResult>;
}

/** Conta conectada e ativa de um app. */
export interface ConnectorAccount {
  id: string;
  /** `user_id` (entity id) da conta no Composio, que a execução de uma ação exige junto com o id; nulo se a listagem não o informou. */
  userId: string | null;
  toolkitSlug: string;
  toolkitName: string;
}

/** Conta conectada com o estado dela: a tela de Conexões e o serviço de contas veem também as pendentes e as que requerem atenção. */
export interface ConnectorAccountListing extends ConnectorAccount {
  status: ConnectorAppStatus;
}

/**
 * As contas de UMA leitura. `truncated` só existe (verdadeiro) quando o Composio informou mais páginas (`next_cursor`) e esta leitura trouxe só a primeira: o que não está na lista PODE existir.
 * É um array comum para quem só lista (nada muda para eles); quem decide pela AUSÊNCIA de uma conta (a remoção da desconectada, `ConnectorAccountService.remove`) confere o sinal e recusa.
 */
export interface ConnectorAccountListings extends Array<ConnectorAccountListing> {
  truncated?: true;
}

/** Ferramenta (ação) do Composio como o catálogo a descreve. */
export interface ConnectorTool {
  slug: string;
  name: string;
  description: string;
  toolkitSlug: string;
  toolkitName: string;
  /** JSON Schema dos argumentos (sempre um objeto). */
  inputSchema: Record<string, unknown>;
}

export interface ActionRequest {
  slug: string;
  arguments: Record<string, unknown>;
  connectedAccountId: string;
  /** `user_id` da conta (`ConnectorAccount.userId`); obrigatório no tipo para que quem monta a chamada decida, mesmo que seja nulo. */
  userId: string | null;
}

/**
 * Resultado de uma execução. `outcomeUnknown` marca a falha em que o Composio PODE ter executado a ação (a resposta não chegou
 * ou não é confiável): diferente de uma recusa clara, repetir a ação às cegas pode duplicar o efeito externo.
 */
export type ActionResult = { ok: true; data: unknown } | { ok: false; error: string; outcomeUnknown?: true };

/** Ferramentas pedidas por app e prazo de uma execução de ação (ações como enviar arquivo levam mais que uma consulta). */
export const TOOLS_PER_TOOLKIT = 40;
export const ACTION_TIMEOUT_MS = 60_000;
/** Versão dos apps que o adaptador pede ao Composio em toda leitura e execução de ação (ver "Versão do app (T30)" acima). */
export const TOOLKIT_VERSION = 'latest';
const VERSION_QUERY = `toolkit_versions=${TOOLKIT_VERSION}`;
/** Texto que o bot recebe quando não há como saber se a ação foi executada (orienta a confirmar antes de repetir). */
export const ACTION_OUTCOME_UNKNOWN = 'Não houve confirmação do Composio: a ação pode ter sido concluída. Confirme o efeito antes de repetir.';
const OUTCOME_UNKNOWN: ActionResult = { ok: false, error: ACTION_OUTCOME_UNKNOWN, outcomeUnknown: true };
/** Texto de erro de uma ação que o bot recebe: curto, sem o que o serviço ecoar. */
const ACTION_ERROR_MAX = 500;

const connectedAccountsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().min(1).max(200).nullish(),
      // Lido por conta própria (`.catch`): um `user_id` com tipo inesperado não pode derrubar a listagem inteira de contas.
      user_id: z.string().min(1).max(200).nullish().catch(undefined),
      status: z.string().nullish(),
      is_disabled: z.boolean().nullish(),
      toolkit: z.object({ slug: z.string().min(1).max(100), name: z.string().max(100).nullish() }).nullish(),
    }),
  ),
  // Cursor da página seguinte: qualquer valor não vazio quer dizer que há mais contas do que as lidas. O tipo não é conferido de propósito: um valor inesperado vale como "há mais" (recusar a
  // remoção é o lado seguro), e um tipo estranho aqui não pode derrubar a listagem inteira.
  next_cursor: z.unknown().optional(),
});

/** Uma ferramenta como o Composio a descreve (item da listagem e resposta de `GET /tools/{slug}`). */
const toolItemSchema = z.object({
  slug: z.string().min(1).max(200),
  name: z.string().max(200).nullish(),
  description: z.string().nullish(),
  input_parameters: z.record(z.string(), z.unknown()).nullish(),
  toolkit: z.object({ slug: z.string().min(1).max(100), name: z.string().max(100).nullish() }).nullish(),
});
const toolsSchema = z.object({ items: z.array(toolItemSchema) });

/** Resposta de uma execução: `successful` falso ou `error` preenchido é falha da AÇÃO (não do serviço). */
const executionSchema = z.object({
  data: z.unknown().optional(),
  error: z.string().nullish(),
  successful: z.boolean().nullish(),
});

/**
 * Corpo de erro estruturado do Composio. Cada campo é lido por conta própria (`.catch`): um campo com tipo inesperado (por exemplo
 * `errors` como lista de objetos, ou `request_id` numérico) descarta SÓ ele, e não o motivo inteiro, que é o que torna a recusa legível.
 * Um corpo de outro formato vira "sem motivo".
 */
const optionalText = z.string().nullish().catch(undefined);
const refusalSchema = z.object({
  error: z
    .object({
      message: optionalText,
      slug: optionalText,
      request_id: optionalText,
      suggested_fix: optionalText,
      errors: z.array(z.unknown()).nullish().catch(undefined),
    })
    .nullish()
    .catch(undefined),
});

/** Texto sem a chave de API, com os espaços e quebras juntos numa linha e no máximo `max` caracteres. */
const sanitize = (text: string, apiKey: string, max: number): string => text.split(apiKey).join('***').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * O motivo de uma recusa de ação lido do corpo de erro do Composio, para o bot e para o log: a mensagem, a sugestão de correção e os
 * erros por campo, nessa ordem. `reason` é vazio quando o corpo não tem o formato conhecido. `slug` e `requestId` identificam o erro e a
 * requisição (o `request_id` é o que o suporte do Composio pede).
 */
export function refusalReason(json: unknown, apiKey: string): { reason: string; slug: string | null; requestId: string | null } {
  const parsed = refusalSchema.safeParse(json);
  const error = parsed.success ? parsed.data.error : null;
  if (!error) return { reason: '', slug: null, requestId: null };
  const details = (error.errors ?? []).filter((entry): entry is string => typeof entry === 'string');
  const parts = [error.message, error.suggested_fix ? `Sugestão: ${error.suggested_fix}` : null, details.length > 0 ? `Detalhes: ${details.join('; ')}` : null];
  return {
    reason: sanitize(parts.filter((part): part is string => Boolean(part)).join(' '), apiKey, ACTION_ERROR_MAX),
    slug: error.slug ? sanitize(error.slug, apiKey, 100) : null,
    requestId: error.request_id ? sanitize(error.request_id, apiKey, 100) : null,
  };
}

const PAGE_LIMIT = 100;

/** Prioridade ao juntar contas do mesmo app: basta uma ativa para o app aparecer como ativo. */
const STATUS_RANK: Record<ConnectorAppStatus, number> = { active: 2, pending: 1, attention: 0 };

function toAppStatus(status: string | null | undefined, disabled: boolean | null | undefined): ConnectorAppStatus {
  if (disabled) return 'attention';
  if (status === 'ACTIVE') return 'active';
  if (status === 'INITIALIZING' || status === 'INITIATED') return 'pending';
  return 'attention';
}

/** `google_calendar` vira "Google Calendar" quando o Composio não informa o nome do app. */
function humanizeSlug(slug: string): string {
  return slug
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Item do Composio no formato do adaptador. `toolkitSlug` é o app de quem pediu, usado quando o item não informa o dele. */
function toConnectorTool(item: z.infer<typeof toolItemSchema>, toolkitSlug: string): ConnectorTool {
  return {
    slug: item.slug,
    name: item.name?.trim() || humanizeSlug(item.slug),
    description: item.description?.trim() ?? '',
    toolkitSlug: item.toolkit?.slug ?? toolkitSlug,
    toolkitName: item.toolkit?.name?.trim() || humanizeSlug(item.toolkit?.slug ?? toolkitSlug),
    // O modelo só aceita um objeto como esquema de argumentos; sem esquema (ou fora do formato), a ferramenta não tem parâmetros.
    inputSchema: item.input_parameters && item.input_parameters.type === 'object' ? item.input_parameters : { type: 'object', properties: {} },
  };
}

export function createComposioClient({
  baseUrl,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
  fetchImpl = fetch,
  logger,
}: UpstreamClientOptions): ConnectorClient {
  /** Falha de transporte (rede, prazo, redirect, corpo grande demais) vira "Composio indisponível", sempre com o mesmo log. */
  const unavailable = (error: unknown): never => {
    if (error instanceof UpstreamUnreachable) {
      logger?.warn({ service: 'composio' }, 'conector inacessível');
      throw new DomainError('CONNECTOR_UNAVAILABLE', { cause: error });
    }
    throw error;
  };

  /**
   * GET numa rota de leitura: chave recusada (401/403) e indisponibilidade (o resto) viram erros de domínio. Com `missingIsNull`, um 404 é a
   * resposta "não existe" (devolve nulo) e não uma falha do serviço.
   */
  async function readJson(path: string, apiKey: string, { missingIsNull = false } = {}): Promise<unknown> {
    let response;
    try {
      response = await upstreamGetJson({ url: `${baseUrl}${path}`, headers: { 'x-api-key': apiKey }, timeoutMs, fetchImpl });
    } catch (error) {
      return unavailable(error);
    }
    if (missingIsNull && response.status === 404) return null;
    const verdict = classifyStatus(response.status);
    if (verdict === 'key-invalid') throw new DomainError('CONNECTOR_KEY_INVALID');
    if (verdict === 'unavailable') {
      logger?.warn({ service: 'composio', status: response.status }, 'conector respondeu com erro');
      throw new DomainError('CONNECTOR_UNAVAILABLE');
    }
    return response.json;
  }

  /** Corpo fora do formato esperado: o serviço mudou ou algo no caminho trocou a resposta; trata como indisponível. */
  const malformed = (): never => {
    logger?.warn({ service: 'composio' }, 'conector respondeu fora do formato esperado');
    throw new DomainError('CONNECTOR_UNAVAILABLE');
  };

  /** A primeira página de contas e se há mais além dela (`next_cursor`): `truncated` é o que impede quem decide pela ausência de uma conta de confiar nesta leitura. */
  async function connectedAccounts(apiKey: string) {
    const parsed = connectedAccountsSchema.safeParse(await readJson(`/connected_accounts?limit=${PAGE_LIMIT}`, apiKey));
    if (!parsed.success) return malformed();
    const { items, next_cursor: cursor } = parsed.data;
    const truncated = cursor !== undefined && cursor !== null && cursor !== '';
    if (truncated) logger?.warn({ service: 'composio', limit: PAGE_LIMIT }, 'conector com mais contas do que a primeira página; leitura truncada');
    return { items, truncated };
  }

  /** Todas as contas, uma por item com id e app, na ordem do Composio. Item sem id ou sem app não tem como ser usado nem nomeado e fica de fora. */
  async function listAccounts(apiKey: string): Promise<ConnectorAccountListings> {
    const { items, truncated } = await connectedAccounts(apiKey);
    const accounts: ConnectorAccountListings = [];
    for (const item of items) {
      if (!item.toolkit || !item.id) continue;
      accounts.push({
        id: item.id,
        userId: item.user_id ?? null,
        toolkitSlug: item.toolkit.slug,
        toolkitName: item.toolkit.name?.trim() || humanizeSlug(item.toolkit.slug),
        status: toAppStatus(item.status, item.is_disabled),
      });
    }
    if (truncated) accounts.truncated = true;
    return accounts;
  }

  /** Ferramentas de um endereço de listagem, já no formato do adaptador (corpo fora do formato vira "indisponível"). */
  async function toolsAt(path: string, apiKey: string, toolkitSlug: string): Promise<ConnectorTool[]> {
    const parsed = toolsSchema.safeParse(await readJson(path, apiKey));
    if (!parsed.success) return malformed();
    return parsed.data.items.map((item) => toConnectorTool(item, toolkitSlug));
  }

  return {
    async listConnectedApps(apiKey) {
      const apps = new Map<string, ConnectorApp>();
      for (const item of (await connectedAccounts(apiKey)).items) {
        if (!item.toolkit) continue;
        const slug = item.toolkit.slug;
        const status = toAppStatus(item.status, item.is_disabled);
        const known = apps.get(slug);
        if (!known) apps.set(slug, { slug, name: item.toolkit.name?.trim() || humanizeSlug(slug), status });
        else if (STATUS_RANK[status] > STATUS_RANK[known.status]) known.status = status;
      }
      return [...apps.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    },

    listAccounts,

    async listTools(apiKey, toolkitSlug) {
      const base = `/tools?toolkit_slug=${encodeURIComponent(toolkitSlug)}&limit=${TOOLS_PER_TOOLKIT}&${VERSION_QUERY}`;
      const important = await toolsAt(`${base}&important=true`, apiKey, toolkitSlug);
      // "Importante" é uma curadoria que nem todo app tem: apps MCP (como o Notion) costumam vir sem nenhuma ação marcada, e com o filtro o
      // bot ficava sem ferramenta alguma do app. Sem nenhuma importante vale a lista geral do app, no mesmo teto por app.
      return important.length > 0 ? important : toolsAt(base, apiKey, toolkitSlug);
    },

    async searchTools(apiKey, toolkitSlug, query, limit) {
      return toolsAt(`/tools?toolkit_slug=${encodeURIComponent(toolkitSlug)}&query=${encodeURIComponent(query)}&limit=${limit}&${VERSION_QUERY}`, apiKey, toolkitSlug);
    },

    async getTool(apiKey, slug) {
      const json = await readJson(`/tools/${encodeURIComponent(slug)}?${VERSION_QUERY}`, apiKey, { missingIsNull: true });
      if (json === null) return null;
      const parsed = toolItemSchema.safeParse(json);
      // Sem o app no corpo, `toolkitSlug` fica vazio: quem usa não acha conta ativa para ele e recusa a ação.
      return parsed.success ? toConnectorTool(parsed.data, '') : malformed();
    },

    async executeAction(apiKey, { slug, arguments: args, connectedAccountId, userId }, signal) {
      let response;
      try {
        response = await upstreamPostJson({
          url: `${baseUrl}/tools/execute/${encodeURIComponent(slug)}`,
          headers: { 'x-api-key': apiKey },
          body: { connected_account_id: connectedAccountId, ...(userId ? { user_id: userId } : {}), version: TOOLKIT_VERSION, arguments: args },
          timeoutMs: ACTION_TIMEOUT_MS,
          signal,
          fetchImpl,
        });
      } catch (error) {
        // Parada do dono ou worker encerrando: quem chamou já sabe o que fazer (não é indisponibilidade do Composio).
        if (signal?.aborted) throw error;
        // O POST já saiu: o Composio pode ter executado a ação sem que a resposta voltasse (queda, prazo, corpo grande demais).
        // ponytail: toda falha de transporte vale como "resultado desconhecido", até a que nem chegou a enviar (ex.: DNS); o custo é o
        //   bot confirmar antes de repetir. Separar "não enviou" se isso gerar confirmações demais.
        logger?.warn({ service: 'composio' }, 'conector sem resposta ao executar a ação; resultado desconhecido');
        return OUTCOME_UNKNOWN;
      }
      if (response.status === 401 || response.status === 403) throw new DomainError('CONNECTOR_KEY_INVALID');
      // 429: o limite de taxa recusa ANTES de executar, então repetir mais tarde é seguro.
      if (response.status === 429) {
        logger?.warn({ service: 'composio', status: response.status }, 'conector limitou a taxa ao executar');
        throw new DomainError('CONNECTOR_UNAVAILABLE');
      }
      // 408 e 5xx (gateway, queda no meio) podem vir DEPOIS de a ação ter sido executada.
      if (response.status === 408 || response.status >= 500) {
        logger?.warn({ service: 'composio', status: response.status }, 'conector respondeu com erro ao executar; resultado desconhecido');
        return OUTCOME_UNKNOWN;
      }
      // Qualquer outro status que não seja sucesso é recusa desta requisição (ação ou conta inexistente, argumentos, conta em estado
      // inválido). O motivo vai ao bot (que pode corrigir a chamada) e ao log com o `request_id`; do corpo só sai o que `refusalReason` extrai.
      if (response.status < 200 || response.status >= 300) {
        const { reason, slug: errorSlug, requestId } = refusalReason(response.json, apiKey);
        // O log leva só o que identifica o erro (status, ferramenta, slug e request_id para o suporte do Composio). O texto livre do motivo vai
        // ao bot e ao resultado da atividade, mas não ao log: ele pode ecoar valores dos argumentos (e-mails, termos de busca).
        logger?.warn({ service: 'composio', status: response.status, tool: slug, errorSlug, requestId }, 'conector recusou a ação');
        const prefix = `O Composio recusou a ação (HTTP ${response.status})`;
        return { ok: false, error: reason === '' ? `${prefix}.` : `${prefix}: ${reason}` };
      }
      const parsed = executionSchema.safeParse(response.json);
      // 2xx com corpo ilegível (página de um proxy no caminho, formato novo): a ação provavelmente executou, mas não há prova.
      if (!parsed.success) {
        logger?.warn({ service: 'composio' }, 'conector respondeu fora do formato esperado ao executar; resultado desconhecido');
        return OUTCOME_UNKNOWN;
      }
      const { data, error, successful } = parsed.data;
      if (successful === false || (error !== undefined && error !== null && error !== '')) {
        // A mensagem da AÇÃO ("destinatário inválido") é útil ao bot; sai curta e sem a chave, por garantia.
        const text = (error ?? 'A ação falhou.').split(apiKey).join('***').slice(0, ACTION_ERROR_MAX);
        return { ok: false, error: text };
      }
      return { ok: true, data: data ?? null };
    },
  };
}

// Serviço de modelos (F8, T5): lista do provedor com favorito e resultado do teste, favoritar, testar e validar a
// escolha de modelo e effort de um bot. Fonte única dessas regras; a API só traduz HTTP <-> chamadas deste serviço.
//
// Decisões:
// - Curadoria (phase 17, A7 a A9): o dono oculta modelos em Conexões (`model_profiles.hidden_at`, `setHidden`). A lista traz TODOS com a marca `hidden` (modelo novo do provedor nasce visível, A8) e quem
//   monta as escolhas novas (o seletor) esconde os ocultos; o servidor continua aceitando um modelo oculto em qualquer gravação e execução, porque "oculto" é só gosto de tela. Cada entrada traz o nome
//   (`displayName` da Anthropic) e o preço (`models/prices.ts`), e a lista traz os 5 modelos usados mais recentemente (`recents`, de `runs.last_model`).
// - O catálogo vem de cada provedor com chave salva (`GET /models` do OpenCode Go e, desde a phase 17, o da Anthropic, com nome e capacidade por modelo), cada id como `provedor/modelo`
//   (`opencode/<modelo>`, `anthropic/<modelo>`), e é guardado só em memória por 60 s POR PROVEDOR: o seletor abre rápido, e "modelo presente na lista atual" (spec F8) continua valendo
//   com no máximo um minuto de defasagem. A chave de cada modelo é a do provedor dele (`modelCredentialKind`): um modelo `anthropic/` nunca usa a chave do OpenCode Go, nem o contrário. O que o Aion grava por
//   modelo (favorito, resultado do teste, níveis de effort, protocolo) fica em `model_profiles`.
// - Só modelos da lista atual entram em qualquer operação (allowlist): o id que o cliente manda nunca vira chamada ao
//   provedor nem linha no banco sem constar nela (`MODEL_UNAVAILABLE`).
// - Testar custa chamadas ao provedor e o limite é de 10 por minuto (spec). Duas solicitações simultâneas para o mesmo
//   modelo dividem UM teste (e contam uma vez). Teste que não conclui por chave recusada ou provedor fora do ar não é
//   gravado; o modelo continua "nunca testado".
// - O teste não decide se "é a primeira seleção": quem chama decide (a web só testa modelo sem resultado e em "testar
//   novamente"); o serviço sempre roda e sobrescreve o resultado anterior.
import {
  MODEL_RECENTS_LIMIT,
  MODEL_TESTS_PER_MINUTE,
  effortLevelSchema,
  MODEL_PROVIDERS,
  providerOfModel,
  qualifyModelId,
  type EffortLevel,
  type ModelEntry,
  type ModelTestReason,
  type ModelProvider,
  type ModelTestStatus,
} from '@aion/shared';
import type { AnthropicClient } from '../credentials/anthropic';
import type { CreditsState } from '../credentials/credits-state';
import type { CredentialService } from '../credentials/service';
import type { ProviderClient } from '../credentials/opencode-go';
import { SlidingWindowLimiter } from '../credentials/rate-limit';
import type { Pool } from '../db/pool';
import { DomainError } from '../errors';
import type { Logger } from '../logging';
import type { ChatProtocol } from './chat-protocols';
import { runImageTest, runModelTest } from './tester';
import { readModelContextCapacity, replaceCatalogCapacities } from './context-capacity';
import { listPrice } from './prices';


/** Quantas execuções, das mais novas, a lista de Recentes examina (ver `ModelService.recents`). */
export const RECENT_MODELS_SCAN_RUNS = 200;

/** Tempo de vida do catálogo em memória. */
export const CATALOG_TTL_MS = 60_000;
/** Prazo geral de um teste de modelo (soma de todas as chamadas dele). */
export const MODEL_TEST_DEADLINE_MS = 60_000;

/** Credencial que prova e usa cada provedor de modelos (`credentials.kind`). Fonte única da ligação entre o provedor de um id e a chave dele. */
const CREDENTIAL_OF_PROVIDER = { opencode: 'provider', anthropic: 'anthropic' } as const satisfies Record<ModelProvider, 'provider' | 'anthropic'>;

/** Credencial do provedor do modelo (`opencode/x` -> `provider`, `anthropic/x` -> `anthropic`); um id sem provedor conhecido cai no OpenCode Go, cujo catálogo o recusa como indisponível. */
export const modelCredentialKind = (model: string): 'provider' | 'anthropic' => CREDENTIAL_OF_PROVIDER[providerOfModel(model) ?? 'opencode'];

/**
 * Cliente de chat que escolhe o provedor pelo prefixo do modelo do pedido (`anthropic/...` vai à Anthropic; o resto, ao OpenCode Go). A chave NÃO é escolhida aqui: quem chama busca a do
 * provedor do modelo (`modelCredentialKind`). A listagem de modelos fica com o OpenCode Go (é só a prova da chave dele); o catálogo da Anthropic é lido por `ModelService`, com o cliente dela.
 * Com `creditsState`, as chamadas de chat da Anthropic mantêm o estado de saldo da chave salva (`credentials.credits_exhausted_at`, phase 17, A20 e A21): saldo esgotado marca, uma chamada que
 * passa limpa. Está aqui, e não no cliente, porque só o chat com a chave SALVA pode mexer nesse estado: a prova de uma chave candidata usa o cliente puro.
 */
export function createProviderRouter({ opencode, anthropic, creditsState }: { opencode: ProviderClient; anthropic: ProviderClient; creditsState?: CreditsState }): ProviderClient {
  const tracked = creditsState ? trackCredits(anthropic, creditsState) : anthropic;
  return {
    listModels: (apiKey) => opencode.listModels(apiKey),
    streamChat: (apiKey, protocol, request, signal) => (providerOfModel(request.model) === 'anthropic' ? tracked : opencode).streamChat(apiKey, protocol, request, signal),
  };
}

/**
 * Envolve o chat da Anthropic: `PROVIDER_CREDITS_EXHAUSTED` marca o estado de saldo antes de subir (a execução, o resumo e o teste do modelo recebem o mesmo erro), e o primeiro evento
 * de um stream (2xx e a resposta começou) o limpa. O erro nunca é engolido nem trocado.
 */
function trackCredits(client: ProviderClient, state: CreditsState): ProviderClient {
  return {
    listModels: (apiKey) => client.listModels(apiKey),
    async *streamChat(apiKey, protocol, request, signal) {
      let started = false;
      try {
        for await (const event of client.streamChat(apiKey, protocol, request, signal)) {
          if (!started) {
            started = true;
            await state.recovered();
          }
          yield event;
        }
      } catch (error) {
        if (error instanceof DomainError && error.code === 'PROVIDER_CREDITS_EXHAUSTED') await state.exhausted();
        throw error;
      }
    },
  };
}

export interface ModelServiceOptions {
  pool: Pool;
  credentials: Pick<CredentialService, 'requireKey'>;
  /** Cliente de chat (o roteador por provedor em produção) e, para o OpenCode Go, a listagem do catálogo. */
  provider: ProviderClient;
  /** Catálogo da Anthropic (nome e capacidade por modelo); ausente, só o OpenCode Go entra no catálogo. */
  anthropic?: AnthropicClient;
  logger: Logger;
  /** Relógio injetável: os testes avançam o tempo (cache e limite de taxa) sem esperar. */
  now?: () => Date;
  /** Prazo geral do teste; os testes encurtam para provar o estouro. */
  testDeadlineMs?: number;
}

interface ProfileRow {
  model_id: string;
  favorited_at: Date | null;
  test_status: ModelTestStatus | null;
  test_reason: ModelTestReason | null;
  test_protocol: ChatProtocol | null;
  effort_levels: string[];
  tested_at: Date | null;
  accepts_images: boolean | null;
  hidden_at: Date | null;
}

const PROFILE_COLUMNS = 'model_id, favorited_at, test_status, test_reason, test_protocol, effort_levels, tested_at, accepts_images, hidden_at';



/** Níveis gravados como texto no banco, filtrados pelo vocabulário conhecido (um valor estranho some, não quebra a tela). */
const toLevels = (levels: string[]): EffortLevel[] =>
  levels.flatMap((level) => {
    const parsed = effortLevelSchema.safeParse(level);
    return parsed.success ? [parsed.data] : [];
  });

/** Entrada da lista: o modelo do provedor com o que o Aion sabe dele (sem linha = nunca testado e não favorito). */
function toEntry(id: string, row: ProfileRow | undefined, unavailable: ModelEntry['unavailable'] = null, displayName: string | null = null): ModelEntry {
  const tested = row?.test_status != null && row.tested_at != null;
  return {
    id,
    unavailable,
    displayName,
    hidden: row?.hidden_at != null,
    price: listPrice(id),
    contextCapacity: readModelContextCapacity(id),
    acceptsImages: row?.accepts_images ?? null,
    favorite: row?.favorited_at != null,
    favoritedAt: row?.favorited_at?.toISOString() ?? null,
    test: tested
      ? { status: row.test_status as ModelTestStatus, reason: row.test_reason, effortLevels: toLevels(row.effort_levels), testedAt: (row.tested_at as Date).toISOString() }
      : null,
  };
}

export class ModelService {
  private readonly pool: Pool;
  private readonly credentials: Pick<CredentialService, 'requireKey'>;
  private readonly provider: ProviderClient;
  private readonly anthropic: AnthropicClient | undefined;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly testDeadlineMs: number;
  private readonly testLimiter: SlidingWindowLimiter;
  /** Catálogo em memória de cada provedor (ids do produto) e quando foi lido. */
  private readonly catalogs = new Map<ModelProvider, { ids: string[]; names: Map<string, string>; loadedAt: number }>();
  /** Uma sonda por modelo; o reteste aguarda seu fim antes de invalidar o resultado. */
  private readonly vision = new Map<string, Promise<ModelEntry>>();
  /** Testes normais em andamento: pedidos simultâneos dividem a mesma execução. */
  private readonly running = new Map<string, Promise<ModelEntry>>();

  constructor({ pool, credentials, provider, anthropic, logger, now = () => new Date(), testDeadlineMs = MODEL_TEST_DEADLINE_MS }: ModelServiceOptions) {
    this.pool = pool;
    this.credentials = credentials;
    this.provider = provider;
    this.anthropic = anthropic;
    this.logger = logger;
    this.now = now;
    this.testDeadlineMs = testDeadlineMs;
    this.testLimiter = new SlidingWindowLimiter({ max: MODEL_TESTS_PER_MINUTE, windowMs: 60_000, now });
  }

  // ---------------------------------------------------------------------------------------------
  // Catálogo
  // ---------------------------------------------------------------------------------------------

  /**
   * Ids (`provedor/modelo`) da lista atual do provedor, do cache quando tem menos de `CATALOG_TTL_MS`. Lança `PROVIDER_*`. A leitura da Anthropic também renova a capacidade confirmada
   * de cada modelo (`replaceCatalogCapacities`), que a janela de contexto e a reserva de saída leem de forma síncrona.
   * ponytail: um provedor fora do ar derruba a listagem inteira (`PROVIDER_UNAVAILABLE`), em vez de mostrar só o outro; degradar por provedor se a Anthropic ficar instável.
   */
  private async catalogIds(provider: ModelProvider, apiKey: string): Promise<string[]> {
    const at = this.now().getTime();
    const cached = this.catalogs.get(provider);
    if (cached && at - cached.loadedAt < CATALOG_TTL_MS) return cached.ids;
    let ids: string[];
    const names = new Map<string, string>();
    if (provider === 'anthropic') {
      if (!this.anthropic) throw new DomainError('PROVIDER_UNAVAILABLE');
      const models = await this.anthropic.listModels(apiKey);
      ids = [...new Set(models.map((model) => qualifyModelId('anthropic', model.id)))];
      for (const model of models) if (model.displayName !== null) names.set(qualifyModelId('anthropic', model.id), model.displayName);
      replaceCatalogCapacities('anthropic', models.map((model) => ({ model: qualifyModelId('anthropic', model.id), maxInputTokens: model.maxInputTokens, maxTokens: model.maxTokens })), this.now());
    } else {
      ids = [...new Set((await this.provider.listModels(apiKey)).map((model) => qualifyModelId('opencode', model.id)))];
    }
    this.catalogs.set(provider, { ids, names, loadedAt: at });
    return ids;
  }

  /**
   * A chave da Anthropic ficou sem saldo na última chamada (`credentials.credits_exhausted_at`, mantido por `createProviderRouter`, A21)? Os modelos dela saem das escolhas novas até uma chamada passar.
   */
  private async creditsExhausted(): Promise<boolean> {
    return (await this.pool.query("SELECT 1 FROM credentials WHERE kind = 'anthropic' AND credits_exhausted_at IS NOT NULL")).rowCount === 1;
  }

  /**
   * A MONTAGEM ÚNICA de uma entrada (lista, perfis, favoritar, ocultar, testar e verificar visão): o nome do catálogo em memória (o `display_name` da Anthropic; nulo no OpenCode Go ou quando o catálogo ainda
   * não foi lido), o oculto, o preço e o estado de saldo. Toda rota que devolve uma entrada passa por aqui, porque a tela troca a linha pelo que o servidor devolve: uma montagem que esquecesse um campo
   * apagaria o selo da linha (era o "Indisponível" que sumia ao favoritar).
   */
  private build(id: string, row: ProfileRow | undefined, exhausted: boolean): ModelEntry {
    const provider = providerOfModel(id);
    return toEntry(id, row, exhausted && provider === 'anthropic' ? 'credits_exhausted' : null, provider === null ? null : (this.catalogs.get(provider)?.names.get(id) ?? null));
  }

  /** A entrada de UM modelo (lê o estado de saldo só quando o modelo é da Anthropic). */
  private async entry(id: string, row: ProfileRow | undefined): Promise<ModelEntry> {
    return this.build(id, row, providerOfModel(id) === 'anthropic' && (await this.creditsExhausted()));
  }

  /** Chave do provedor, ou `null` se ele não tem chave salva (a Anthropic é opcional; o OpenCode Go sem chave só vira erro quando nenhum provedor tem). */
  private async keyOf(provider: ModelProvider): Promise<string | null> {
    try {
      return await this.credentials.requireKey(CREDENTIAL_OF_PROVIDER[provider]);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'PROVIDER_NOT_CONFIGURED') return null;
      throw error;
    }
  }

  /** Garante que o modelo consta na lista do provedor dele; devolve a chave DESSE provedor para o chamador seguir sem decifrar de novo. */
  private async requireListed(model: string): Promise<string> {
    const provider = providerOfModel(model) ?? 'opencode';
    const apiKey = await this.credentials.requireKey(CREDENTIAL_OF_PROVIDER[provider]);
    if (!(await this.catalogIds(provider, apiKey)).includes(model)) throw new DomainError('MODEL_UNAVAILABLE');
    return apiKey;
  }

  /**
   * Carrega (do cache de 60 s, ou do provedor) a capacidade confirmada dos modelos da Anthropic antes de a janela de contexto ser calculada; sem `model` (a subida do processo) ou com um
   * modelo da Anthropic. Para modelo de outro provedor, ou sem a chave, não faz nada. Nunca falha: a janela só perde o teto confirmado até a próxima leitura, e o log leva só o código do erro.
   */
  async warmCapacity(model: string | null = null): Promise<void> {
    if ((model !== null && providerOfModel(model) !== 'anthropic') || !this.anthropic) return;
    try {
      const apiKey = await this.keyOf('anthropic');
      if (apiKey !== null) await this.catalogIds('anthropic', apiKey);
    } catch (error) {
      this.logger.warn({ code: error instanceof DomainError ? error.code : 'INTERNAL_ERROR' }, 'capacidade dos modelos da Anthropic não carregada');
    }
  }

  /**
   * Modelos de cada provedor com chave salva (OpenCode Go primeiro, depois a Anthropic), cada grupo em ordem natural (glm-5.2 antes de glm-5.10), com favorito e último teste. Sem chave
   * de nenhum provedor, `PROVIDER_NOT_CONFIGURED`.
   */
  async list(): Promise<ModelEntry[]> {
    const ids: string[] = [];
    let configured = false;
    for (const provider of MODEL_PROVIDERS) {
      if (provider === 'anthropic' && !this.anthropic) continue;
      const apiKey = await this.keyOf(provider);
      if (apiKey === null) continue;
      configured = true;
      ids.push(...[...(await this.catalogIds(provider, apiKey))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })));
    }
    if (!configured) throw new DomainError('PROVIDER_NOT_CONFIGURED');
    const rows = await this.pool.query<ProfileRow>(`SELECT ${PROFILE_COLUMNS} FROM model_profiles WHERE model_id = ANY($1)`, [ids]);
    const byId = new Map(rows.rows.map((row) => [row.model_id, row]));
    const exhausted = await this.creditsExhausted();
    return ids.map((id) => this.build(id, byId.get(id), exhausted));
  }

  /** Metadados já conhecidos para preferências/contexto; não descobre modelos nem exige credencial/rede. */
  async profiles(): Promise<ModelEntry[]> {
    const rows = await this.pool.query<ProfileRow>(`SELECT ${PROFILE_COLUMNS} FROM model_profiles ORDER BY model_id`);
    const exhausted = await this.creditsExhausted();
    return rows.rows.map((row) => this.build(row.model_id, row, exhausted));
  }

  /**
   * Os `MODEL_RECENTS_LIMIT` modelos usados mais recentemente em alguma execução (do mais novo ao mais antigo), só entre os `listed` (um modelo que saiu do catálogo não aparece). A fonte é `runs.last_model`,
   * o id da última chamada de cada execução; uma consulta única, sem tabela própria. Olha só as `RECENT_MODELS_SCAN_RUNS` execuções mais novas (a chave primária, do fim para o começo, sem índice novo), e não a
   * tabela inteira a cada abertura do seletor.
   * ponytail: um modelo usado só antes dessas execuções não aparece em Recentes; subir a janela (ou indexar `runs (last_model, created_at)`, migration) se isso incomodar o dono.
   */
  async recents(listed: readonly string[]): Promise<string[]> {
    const found = await this.pool.query<{ last_model: string }>(
      `SELECT last_model FROM (SELECT last_model, created_at FROM runs WHERE last_model IS NOT NULL ORDER BY id DESC LIMIT $3) latest
       WHERE last_model = ANY($1) GROUP BY last_model ORDER BY max(created_at) DESC, last_model LIMIT $2`,
      [listed, MODEL_RECENTS_LIMIT, RECENT_MODELS_SCAN_RUNS],
    );
    return found.rows.map((row) => row.last_model);
  }

  // ---------------------------------------------------------------------------------------------
  // Favoritos
  // ---------------------------------------------------------------------------------------------

  /** Marca ou desmarca o favorito. Idempotente: favoritar de novo não muda a posição na lista de favoritos. */
  async setFavorite(model: string, favorite: boolean): Promise<ModelEntry> {
    await this.requireListed(model);
    const at = this.now();
    const row = await this.pool.query<ProfileRow>(
      `INSERT INTO model_profiles (model_id, favorited_at, created_at, updated_at)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (model_id) DO UPDATE SET
         favorited_at = CASE WHEN $2::timestamptz IS NULL THEN NULL ELSE COALESCE(model_profiles.favorited_at, $2::timestamptz) END,
         updated_at = $3
       RETURNING ${PROFILE_COLUMNS}`,
      [model, favorite ? at : null, at],
    );
    return await this.entry(model, row.rows[0]);
  }

  /**
   * Oculta ou reexibe o modelo em Conexões (A7). Idempotente: ocultar de novo mantém o primeiro instante. Só vale para modelo da lista atual (a mesma allowlist do favorito). Não mexe em bot, rotina,
   * conversa nem resumo que já usam o modelo (A9): eles seguem funcionando e a tela mostra "oculto".
   */
  async setHidden(model: string, hidden: boolean): Promise<ModelEntry> {
    await this.requireListed(model);
    const at = this.now();
    const row = await this.pool.query<ProfileRow>(
      `INSERT INTO model_profiles (model_id, hidden_at, created_at, updated_at)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (model_id) DO UPDATE SET
         hidden_at = CASE WHEN $2::timestamptz IS NULL THEN NULL ELSE COALESCE(model_profiles.hidden_at, $2::timestamptz) END,
         updated_at = $3
       RETURNING ${PROFILE_COLUMNS}`,
      [model, hidden ? at : null, at],
    );
    return await this.entry(model, row.rows[0]);
  }

  // ---------------------------------------------------------------------------------------------
  // Teste do modelo
  // ---------------------------------------------------------------------------------------------

  /**
   * Testa o modelo (protocolo, texto, streaming, ferramenta e effort) e grava o resultado por cima do anterior.
   * Lança `MODEL_UNAVAILABLE`, `RATE_LIMITED`, `PROVIDER_NOT_CONFIGURED`, `PROVIDER_KEY_INVALID` ou `PROVIDER_UNAVAILABLE`
   * (nestes dois últimos o teste normal anterior é preservado; a visão já foi invalidada pelo gesto).
   */
  async test(model: string): Promise<ModelEntry> {
    const apiKey = await this.requireListed(model);
    const running = this.running.get(model);
    if (running) return running;
    this.testLimiter.consume();

    // Aguarda a sonda antiga antes de limpar o cache, evitando que ela o repovoe após o reteste.
    const priorVision = this.vision.get(model);
    const execution = (async () => {
      await priorVision?.catch(() => undefined);
      // O gesto invalida a visão mesmo quando o novo teste falha; o teste normal anterior é preservado.
      await this.pool.query('UPDATE model_profiles SET accepts_images = NULL WHERE model_id = $1', [model]);
      return this.runAndStore(model, apiKey);
    })().finally(() => this.running.delete(model));
    this.running.set(model, execution);
    return execution;
  }

  /** Verifica visão uma vez por modelo. Cache não gasta orçamento; retestes e sondas compartilham a fila. */
  async verifyImage(model: string): Promise<ModelEntry> {
    const active = this.vision.get(model);
    if (active) return active;
    // Publicar a sonda antes da primeira espera impede que o reteste ultrapasse sua descoberta.
    // Capturar só o teste anterior evita dependência circular com um reteste que já espera esta sonda.
    const priorTest = this.running.get(model);
    const execution = (async () => {
      const apiKey = await this.requireListed(model);
      await priorTest;
      let row = (await this.pool.query<ProfileRow>(`SELECT ${PROFILE_COLUMNS} FROM model_profiles WHERE model_id = $1`, [model])).rows[0];
      if (row?.accepts_images != null) return await this.entry(model, row);
      this.testLimiter.consume();
      if (!row?.test_protocol) {
        await this.runAndStore(model, apiKey);
        row = (await this.pool.query<ProfileRow>(`SELECT ${PROFILE_COLUMNS} FROM model_profiles WHERE model_id = $1`, [model])).rows[0];
      }
      if (!row?.test_protocol) throw new DomainError('MODEL_IMAGE_CHECK_FAILED');
      const accepts = await runImageTest({ provider: this.provider, apiKey, model, protocol: row.test_protocol, signal: AbortSignal.timeout(this.testDeadlineMs) });
      const stored = await this.pool.query<ProfileRow>(`UPDATE model_profiles SET accepts_images = $2, updated_at = $3 WHERE model_id = $1 RETURNING ${PROFILE_COLUMNS}`, [model, accepts, this.now()]);
      return await this.entry(model, stored.rows[0]);
    })().catch((error: unknown) => {
      if (error instanceof DomainError && error.code === 'PROVIDER_UNAVAILABLE') throw new DomainError('MODEL_IMAGE_CHECK_FAILED');
      throw error;
    }).finally(() => this.vision.delete(model));
    this.vision.set(model, execution);
    return execution;
  }

  /** Persiste o teste normal preservando favoritos e invalidando qualquer resultado de visão. */
  private async runAndStore(model: string, apiKey: string): Promise<ModelEntry> {
    const outcome = await runModelTest({
      provider: this.provider,
      apiKey,
      model,
      signal: AbortSignal.timeout(this.testDeadlineMs),
    });
    const at = this.now();
    const row = await this.pool.query<ProfileRow>(
      `INSERT INTO model_profiles (model_id, test_status, test_reason, test_protocol, effort_levels, tested_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6)
       ON CONFLICT (model_id) DO UPDATE SET
         test_status = EXCLUDED.test_status,
         test_reason = EXCLUDED.test_reason,
         test_protocol = EXCLUDED.test_protocol,
         effort_levels = EXCLUDED.effort_levels,
         tested_at = EXCLUDED.tested_at,
         accepts_images = NULL,
         updated_at = EXCLUDED.updated_at
       RETURNING ${PROFILE_COLUMNS}`,
      [model, outcome.status, outcome.reason, outcome.protocol, outcome.effortLevels, at],
    );
    this.logger.info({ model, status: outcome.status, protocol: outcome.protocol, effortLevels: outcome.effortLevels }, 'modelo testado');
    return await this.entry(model, row.rows[0]);
  }

  // ---------------------------------------------------------------------------------------------
  // Escolha de modelo e effort de um bot (usada por BotService)
  // ---------------------------------------------------------------------------------------------

  /**
   * Confere a combinação que o dono escolheu: sem modelo não há effort; o modelo consta na lista atual; o effort é um
   * dos níveis gravados no teste dele (modelo nunca testado não tem nível algum). Lança `MODEL_UNAVAILABLE` ou
   * `VALIDATION_FAILED` (campo `effort`). Modelo e effort nulos dispensam a consulta ao provedor.
   */
  async validateSelection(model: string | null, effort: EffortLevel | null): Promise<void> {
    if (model === null) {
      if (effort !== null) throw new DomainError('VALIDATION_FAILED', { fields: [{ field: 'effort', reason: 'Escolha um modelo antes do effort.' }] });
      return;
    }
    await this.requireListed(model);
    if (effort === null) return;
    const row = await this.pool.query<Pick<ProfileRow, 'effort_levels'>>('SELECT effort_levels FROM model_profiles WHERE model_id = $1', [model]);
    if (!toLevels(row.rows[0]?.effort_levels ?? []).includes(effort)) {
      throw new DomainError('VALIDATION_FAILED', { fields: [{ field: 'effort', reason: 'O modelo não aceita este effort.' }] });
    }
  }
}

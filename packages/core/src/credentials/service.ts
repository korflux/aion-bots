// Serviço das chaves de terceiros (F3 OpenCode Go, F4 Composio, a chave da Anthropic (phase 17, SEC-08) e a chave OPCIONAL da Parallel, da pesquisa na web): salvar,
// substituir, desconectar, mostrar o estado mascarado e entregar a chave decifrada ao SERVIDOR (T5, T6 e T7). É a fonte única
// dessas regras; a API só traduz HTTP <-> chamadas deste serviço.
//
// Decisões e garantias:
// - A chave só é gravada depois de validada no serviço externo, e a troca é uma única transação: uma chave nova
//   recusada (ou o serviço fora do ar) deixa a anterior intacta e funcionando (spec F3 passo 2).
// - A chave do OpenCode Go é validada por uma SONDA DE CHAT (ver `key-probe.ts`), e não só pela listagem de modelos, que o
//   provedor responde sem exigir chave. A do Composio é validada pela listagem das contas conectadas, que exige a chave. A da Parallel
//   (`web_search`, opcional: sem ela a pesquisa usa o nível anônimo) é validada por uma pesquisa mínima (ver `parallel.ts`). A da Anthropic (`anthropic`) é validada pela listagem
//   de modelos (que a Anthropic só atende com chave válida) e por UMA chamada mínima ao `claude-haiku-5-5` pelo protocolo `messages` (ver `probeAnthropicKey`): recusada, ou com a prova
//   falhando, não grava e a anterior segue intacta. Nada devolvido, logado ou auditado carrega a chave; só a máscara.
// - Cifra: `sealSecret` (AES-256-GCM, chave derivada da AION_MASTER_KEY por finalidade). O banco guarda o texto
//   cifrado e a versão mascarada; a chave em claro só existe em memória durante a chamada.
// - Nada devolvido pelo serviço contém a chave: o estado traz apenas `masked`. `revealKey`/`requireKey` são de uso
//   EXCLUSIVO do servidor e nunca devem ser repassados a uma resposta HTTP.
// - Validar custa uma chamada externa, então salvar é limitado a 10 por minuto (spec). Só salvar conta, e o limite é UM SÓ para as chaves; remover tem limite próprio, bem maior (`KEY_REMOVALS_PER_MINUTE`).
// - Auditoria: toda troca, recusa e remoção registra o que aconteceu com a chave só mascarada.
import type { CredentialKind, CredentialStatus, CredentialsOverview } from '@aion/shared';
import { recordAudit } from '../audit';
import type { RequestOrigin } from '../auth/service';
import { openSecret, sealSecret } from '../crypto/secret-box';
import { withTransaction, type Pool } from '../db/pool';
import { DomainError } from '../errors';
import type { Logger } from '../logging';
import type { ConnectorAccountListings, ConnectorClient } from './composio';
import type { AnthropicClient } from './anthropic';
import { PROBE_DEADLINE_MS, probeAnthropicKey, probeProviderKey } from './key-probe';
import type { ProviderClient } from './opencode-go';
import type { ParallelClient } from './parallel';
import { SlidingWindowLimiter } from './rate-limit';

/** Finalidade da cifra de cada chave: entra na derivação da subchave e como dado autenticado (ver secret-box). */
const PURPOSES: Record<CredentialKind, string> = { provider: 'provider-key', connector: 'connector-key', web_search: 'web-search-key', anthropic: 'anthropic-key' };

/** As credenciais sem as quais um recurso não funciona: só estas têm o erro "não configurado" (`requireKey`). A da pesquisa na web é opcional. */
type RequiredCredentialKind = Exclude<CredentialKind, 'web_search'>;
const NOT_CONFIGURED = { provider: 'PROVIDER_NOT_CONFIGURED', connector: 'CONNECTOR_NOT_CONFIGURED', anthropic: 'PROVIDER_NOT_CONFIGURED' } as const satisfies Record<RequiredCredentialKind, string>;

/** Validações de chave por minuto (spec: "validação de chaves limitada a 10 por minuto"). */
export const KEY_VALIDATIONS_PER_MINUTE = 10;
/**
 * Remoções de chave por minuto (A5 da phase 17: remover, como salvar, recusa acima do limite e não altera nada). Remover não chama serviço externo nem custa nada, então o limite é
 * bem acima do de validar (que protege uma chamada paga); fica fora do limite de validações para que apagar chaves (a tela de Conexões e os testes de ponta a ponta apagam as quatro
 * de uma vez) nunca gaste o orçamento de salvar. Vale as quatro chaves juntas. Decisão operacional reversível (aceita pelo coordenador no checkpoint 1): 60, e não o limite compartilhado de 10.
 */
export const KEY_REMOVALS_PER_MINUTE = 60;

/**
 * Versão exibível da chave: "••••" mais os últimos 4 caracteres (spec F3). Em chaves curtas mostra menos
 * (no máximo um quarto do tamanho), para a versão mascarada nunca revelar uma chave de poucos caracteres.
 */
export function maskSecret(secret: string): string {
  const visible = Math.min(4, Math.floor(secret.length / 4));
  return `••••${secret.slice(secret.length - visible)}`;
}

export interface CredentialServiceOptions {
  pool: Pool;
  masterKey: Buffer;
  provider: ProviderClient;
  /** Anthropic (phase 17): valida a chave ao salvá-la. Sem o cliente (testes que não tocam nessa chave) salvar a chave da Anthropic falha como `PROVIDER_UNAVAILABLE`. */
  anthropic?: AnthropicClient;
  connector: ConnectorClient;
  /** Pesquisa na web (Parallel): valida a chave opcional ao salvá-la. */
  webSearch: ParallelClient;
  logger: Logger;
  /** Relógio injetável: os testes avançam o tempo sem esperar. */
  now?: () => Date;
}

interface StatusRow {
  kind: CredentialKind;
  masked: string;
  model_count: number | null;
  updated_at: Date;
}

const emptyStatus = (kind: CredentialKind): CredentialStatus => ({
  kind,
  configured: false,
  masked: null,
  updatedAt: null,
  modelCount: null,
});

const toStatus = (row: StatusRow): CredentialStatus => ({
  kind: row.kind,
  configured: true,
  masked: row.masked,
  updatedAt: row.updated_at.toISOString(),
  modelCount: row.model_count,
});

export class CredentialService {
  private readonly pool: Pool;
  private readonly masterKey: Buffer;
  private readonly provider: ProviderClient;
  private readonly anthropic: AnthropicClient | undefined;
  private readonly connector: ConnectorClient;
  private readonly webSearch: ParallelClient;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly validationLimiter: SlidingWindowLimiter;
  private readonly removalLimiter: SlidingWindowLimiter;

  constructor({ pool, masterKey, provider, anthropic, connector, webSearch, logger, now = () => new Date() }: CredentialServiceOptions) {
    this.pool = pool;
    this.masterKey = masterKey;
    this.provider = provider;
    this.anthropic = anthropic;
    this.connector = connector;
    this.webSearch = webSearch;
    this.logger = logger;
    this.now = now;
    this.validationLimiter = new SlidingWindowLimiter({ max: KEY_VALIDATIONS_PER_MINUTE, windowMs: 60_000, now });
    this.removalLimiter = new SlidingWindowLimiter({ max: KEY_REMOVALS_PER_MINUTE, windowMs: 60_000, now });
  }

  // ---------------------------------------------------------------------------------------------
  // Estado (nunca inclui a chave)
  // ---------------------------------------------------------------------------------------------

  /**
   * Estado das credenciais de provedor, conector e Anthropic. Não decifra nada e não chama serviço externo. A chave opcional da
   * pesquisa na web não entra aqui: seu estado vem de `statusOf`, junto do interruptor (rota de Pesquisa na web).
   */
  async overview(): Promise<CredentialsOverview> {
    const rows = await this.pool.query<StatusRow>('SELECT kind, masked, model_count, updated_at FROM credentials');
    const byKind = new Map(rows.rows.map((row) => [row.kind, toStatus(row)]));
    return {
      provider: byKind.get('provider') ?? emptyStatus('provider'),
      connector: byKind.get('connector') ?? emptyStatus('connector'),
      anthropic: byKind.get('anthropic') ?? emptyStatus('anthropic'),
    };
  }

  /** Estado de UMA credencial (configurada ou não, versão mascarada). Não decifra nada e não chama serviço externo. */
  async statusOf(kind: CredentialKind): Promise<CredentialStatus> {
    const row = await this.pool.query<StatusRow>('SELECT kind, masked, model_count, updated_at FROM credentials WHERE kind = $1', [kind]);
    const found = row.rows[0];
    return found ? toStatus(found) : emptyStatus(kind);
  }

  // ---------------------------------------------------------------------------------------------
  // Salvar e substituir
  // ---------------------------------------------------------------------------------------------

  /**
   * Valida a chave no serviço externo e, só se válida, grava (cifrada) no lugar da anterior, se houver.
   * Lança `RATE_LIMITED`, `PROVIDER_KEY_INVALID`/`CONNECTOR_KEY_INVALID`/`WEB_SEARCH_KEY_INVALID` ou `*_UNAVAILABLE`; em qualquer uma delas
   * a chave anterior continua como estava.
   */
  async save(kind: CredentialKind, apiKey: string, origin: RequestOrigin): Promise<CredentialStatus> {
    let modelCount: number | null;
    try {
      this.validationLimiter.consume();
      modelCount = await this.validateKey(kind, apiKey);
    } catch (error) {
      const code = error instanceof DomainError ? error.code : 'INTERNAL_ERROR';
      await recordAudit(
        this.pool,
        {
          action: 'credential.save',
          outcome: code === 'RATE_LIMITED' ? 'denied' : 'failure',
          actor: 'owner',
          ip: origin.ip,
          userAgent: origin.userAgent,
          target: kind,
          details: { code },
        },
        this.now(),
      );
      throw error;
    }

    const masked = maskSecret(apiKey);
    const sealed = sealSecret(this.masterKey, PURPOSES[kind], apiKey);
    const at = this.now();
    const saved = await withTransaction(this.pool, async (tx) => {
      // Trava a linha atual para o "anterior" da auditoria ser o que de fato foi trocado, mesmo com duas trocas juntas.
      const previous = await tx.query<{ masked: string }>('SELECT masked FROM credentials WHERE kind = $1 FOR UPDATE', [
        kind,
      ]);
      const row = await tx.query<StatusRow>(
        `INSERT INTO credentials (kind, secret_sealed, masked, model_count, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT (kind) DO UPDATE SET
           secret_sealed = EXCLUDED.secret_sealed,
           masked = EXCLUDED.masked,
           model_count = EXCLUDED.model_count,
           credits_exhausted_at = NULL,
           updated_at = EXCLUDED.updated_at
         RETURNING kind, masked, model_count, updated_at`,
        [kind, sealed, masked, modelCount, at],
      );
      const previousMasked = previous.rows[0]?.masked ?? null;
      await recordAudit(
        tx,
        {
          action: 'credential.save',
          outcome: 'success',
          actor: 'owner',
          ip: origin.ip,
          userAgent: origin.userAgent,
          target: kind,
          details: { masked, previousMasked, replaced: previousMasked !== null },
        },
        at,
      );
      return toStatus(row.rows[0] as StatusRow);
    });
    this.logger.info({ kind, masked }, 'chave de terceiro salva');
    return saved;
  }

  /**
   * Chama o serviço externo com a chave candidata. Devolve o total de modelos (provedores) ou `null` (conector e pesquisa na web). No OpenCode Go, a
   * listagem só alimenta o total e a escolha dos modelos da sonda; quem prova a chave é `probeProviderKey` (chat de ~1 token). Na Anthropic a listagem
   * já exige chave válida (401 recusa) e `probeAnthropicKey` fecha a prova com uma chamada mínima ao Haiku pelo `messages`.
   */
  private async validateKey(kind: CredentialKind, apiKey: string): Promise<number | null> {
    if (kind === 'provider') {
      const models = (await this.provider.listModels(apiKey)).map((model) => model.id);
      const probe = await probeProviderKey({ provider: this.provider, apiKey, models, signal: AbortSignal.timeout(PROBE_DEADLINE_MS) });
      // Sem prova possível (só motivos do modelo, ou lista vazia) a chave é aceita por decisão do dono; fica no log, sem a chave.
      if (probe === 'unverified') this.logger.warn({ kind, models: models.length }, 'chave aceita sem prova: a sonda de chat não obteve resposta decisiva');
      return models.length;
    }
    if (kind === 'anthropic') {
      if (!this.anthropic) throw new DomainError('PROVIDER_UNAVAILABLE');
      const models = await this.anthropic.listModels(apiKey);
      await probeAnthropicKey({ provider: this.anthropic, apiKey, signal: AbortSignal.timeout(PROBE_DEADLINE_MS) });
      return models.length;
    }
    if (kind === 'web_search') await this.webSearch.validateKey(apiKey);
    else await this.connector.listConnectedApps(apiKey);
    return null;
  }

  // ---------------------------------------------------------------------------------------------
  // Desconectar
  // ---------------------------------------------------------------------------------------------

  /**
   * Apaga a chave. Idempotente: desconectar o que já não existe não é erro e não gera auditoria de sucesso. Acima de `KEY_REMOVALS_PER_MINUTE` por minuto lança `RATE_LIMITED` ANTES de
   * tocar em qualquer linha (a recusa fica na auditoria como `denied`, só com o tipo da chave).
   */
  async disconnect(kind: CredentialKind, origin: RequestOrigin): Promise<void> {
    const at = this.now();
    try {
      this.removalLimiter.consume();
    } catch (error) {
      await recordAudit(this.pool, { action: 'credential.disconnect', outcome: 'denied', actor: 'owner', ip: origin.ip, userAgent: origin.userAgent, target: kind, details: { code: 'RATE_LIMITED' } }, at);
      throw error;
    }
    await withTransaction(this.pool, async (tx) => {
      const removed = await tx.query<{ masked: string }>('DELETE FROM credentials WHERE kind = $1 RETURNING masked', [kind]);
      const masked = removed.rows[0]?.masked;
      if (masked === undefined) return;
      await recordAudit(
        tx,
        {
          action: 'credential.disconnect',
          outcome: 'success',
          actor: 'owner',
          ip: origin.ip,
          userAgent: origin.userAgent,
          target: kind,
          details: { masked },
        },
        at,
      );
    });
    this.logger.info({ kind }, 'chave de terceiro removida');
  }

  // ---------------------------------------------------------------------------------------------
  // Uso pelo servidor (T5, T6, T7): chave decifrada. NUNCA repassar a uma resposta HTTP.
  // ---------------------------------------------------------------------------------------------

  /** Chave decifrada, ou `null` se não configurada. Falha de decifragem (ex.: chave mestra trocada) vira erro interno. */
  async revealKey(kind: CredentialKind): Promise<string | null> {
    const row = await this.pool.query<{ secret_sealed: string }>('SELECT secret_sealed FROM credentials WHERE kind = $1', [
      kind,
    ]);
    const sealed = row.rows[0]?.secret_sealed;
    if (sealed === undefined) return null;
    try {
      return openSecret(this.masterKey, PURPOSES[kind], sealed);
    } catch (cause) {
      // A mensagem do secret-box não contém o valor; ainda assim o detalhe fica só no log interno.
      throw new DomainError('INTERNAL_ERROR', { cause });
    }
  }

  /** Como `revealKey`, mas lança `PROVIDER_NOT_CONFIGURED` (OpenCode Go e Anthropic) ou `CONNECTOR_NOT_CONFIGURED` se não houver chave. A da pesquisa na web é opcional: use `revealKey`. */
  async requireKey(kind: RequiredCredentialKind): Promise<string> {
    const key = await this.revealKey(kind);
    if (key === null) throw new DomainError(NOT_CONFIGURED[kind]);
    return key;
  }

  // ---------------------------------------------------------------------------------------------
  // Contas do Composio (F4, phase 13)
  // ---------------------------------------------------------------------------------------------

  /**
   * TODAS as contas conectadas no Composio, uma por conta (os dois Gmail separados) e com o estado de cada uma, lidas ao vivo com a chave guardada (phase 13, CONN-02). É a fonte do
   * serviço de contas (`ConnectorAccountService`), que a cruza com os nomes e as liberações gravados. Lança `CONNECTOR_NOT_CONFIGURED`, `CONNECTOR_KEY_INVALID` ou `CONNECTOR_UNAVAILABLE`.
   * O resultado não carrega a chave: só o id, o `user_id`, o app e o estado de cada conta. Com mais contas do que a primeira página do Composio ele vem com `truncated` verdadeiro.
   */
  async listConnectorAccounts(): Promise<ConnectorAccountListings> {
    return this.connector.listAccounts(await this.requireKey('connector'));
  }
}

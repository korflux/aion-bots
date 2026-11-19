// Serviço de dispositivos de web push (F14, T10): registrar, listar e remover os navegadores e PWAs que recebem os avisos, mais a
// configuração pública que o navegador usa para obter o token do FCM. Também guarda a matriz de silenciar por bot e por tipo (T13,
// `push_mutes`), grava a abertura do app e responde à conferência do service worker (phase 3, T3). Usado pela API; o ENVIO, e a decisão de
// avisar no momento de enviar, são do `PushDispatcher` (worker), pela mesma regra de validade (`pushDropReasonOf`) que a conferência usa.
// Phase 16: guarda os interruptores "Mostrar conteúdo" (bots e Chat geral, `app_settings`) e, só quando o evento vale e a chave da origem está ligada, a conferência
// devolve também o título, o corpo e o id da aprovação (`pushContentOf`). É o único caminho do texto da conversa até o aparelho (SEC-07): o despachante não o usa.
//
// Segurança: o token de registro é o endereço do dispositivo no FCM. Ele entra só pelo registro, é único (registrar de novo só
// renova `last_seen_at`) e NUNCA volta ao navegador, nem aparece em log ou na auditoria (a auditoria guarda o id e o rótulo). Dono
// único: toda operação já passou pela sessão verificada na borda da API.
import {
  PUSH_APP_OPENS_PER_MINUTE,
  PUSH_CHECKS_PER_MINUTE,
  PUSH_DEVICES_MAX,
  PUSH_EVENT_KINDS,
  PUSH_RECEIPTS_PER_MINUTE,
  type PushConfig,
  type PushContentOrigin,
  type PushContentSettings,
  type PushDevice,
  type PushEventCheck,
  type PushEventKind,
  type PushMuteTarget,
  type PushPreferences,
  type PushReceiptCreate,
} from '@aion/shared';
import { recordAudit } from '../audit';
import { describeDevice } from '../auth/device';
import { KeyedSlidingWindowLimiter } from '../credentials/rate-limit';
import type { RequestOrigin } from '../auth/service';
import { withTransaction, type Pool } from '../db/pool';
import { DomainError } from '../errors';
import { pushContentOf } from './content';
import { GENERAL_CHAT_PUSH_TITLE } from './dispatcher';
import { loadPushEvents, pushDropReasonOf } from './validity';

export interface PushServiceOptions {
  pool: Pool;
  /** Configuração pública do Firebase (da variável de ambiente da API). */
  config: PushConfig;
  now?: () => Date;
}

interface DeviceRow {
  id: string;
  label: string;
  created_at: Date;
  last_seen_at: Date;
}

/** Os tipos dados, sempre na ordem fixa da allowlist (a resposta da matriz não depende da ordem das linhas no banco). */
const inKindOrder = (kinds: Iterable<PushEventKind>): PushEventKind[] => {
  const wanted = new Set(kinds);
  return PUSH_EVENT_KINDS.filter((kind) => wanted.has(kind));
};

/** Coluna de `app_settings` de cada interruptor "Mostrar conteúdo". Lista fechada: o nome da coluna nunca vem da entrada (entra no SQL só por esta tabela). */
const CONTENT_COLUMN = { bots: 'push_content_bots', general_chat: 'push_content_general_chat' } as const satisfies Record<PushContentOrigin, string>;

/** O dispositivo como a tela o lista: rótulo e datas em ISO, nunca o token. */
const toDevice = (row: DeviceRow): PushDevice => ({
  id: row.id,
  label: row.label,
  createdAt: row.created_at.toISOString(),
  lastSeenAt: row.last_seen_at.toISOString(),
});

export class PushService {
  private readonly pool: Pool;
  private readonly push: PushConfig;
  private readonly now: () => Date;
  /** Limites por sessão de login (Contratos da spec): abertura do app, 10 por minuto; conferência, 60 por minuto. */
  private readonly openLimiter: KeyedSlidingWindowLimiter;
  private readonly checkLimiter: KeyedSlidingWindowLimiter;
  private readonly receiptLimiter: KeyedSlidingWindowLimiter;

  constructor({ pool, config, now = () => new Date() }: PushServiceOptions) {
    this.pool = pool;
    this.push = config;
    this.now = now;
    this.openLimiter = new KeyedSlidingWindowLimiter({ max: PUSH_APP_OPENS_PER_MINUTE, windowMs: 60_000, now });
    this.checkLimiter = new KeyedSlidingWindowLimiter({ max: PUSH_CHECKS_PER_MINUTE, windowMs: 60_000, now });
    this.receiptLimiter = new KeyedSlidingWindowLimiter({ max: PUSH_RECEIPTS_PER_MINUTE, windowMs: 60_000, now });
  }

  /**
   * Abertura do app (Suposição 7; F3): grava o instante do SERVIDOR como a última abertura, e ele só avança (GREATEST: uma requisição atrasada
   * não o faz voltar). Os eventos criados antes passam a ser descartados no envio e dados como inválidos na conferência. Não marca conversa
   * nenhuma como lida. `sessionId` é a sessão do cookie, só para o limite (RATE_LIMITED antes de tocar o banco). Sem auditoria (Contratos).
   */
  async recordAppOpen(sessionId: string): Promise<void> {
    this.openLimiter.consume(sessionId);
    await this.pool.query(
      `INSERT INTO app_opened (singleton, opened_at) VALUES (true, $1)
       ON CONFLICT (singleton) DO UPDATE SET opened_at = GREATEST(app_opened.opened_at, EXCLUDED.opened_at)`,
      [this.now()],
    );
  }

  /**
   * Conferência do service worker (Suposição 8; F2): para cada id pedido (de `push_events`), se o aviso ainda vale AGORA, pela mesma regra do
   * envio (`pushDropReasonOf`, que inclui o vencimento de 24 horas). Id desconhecido (nunca existiu ou já foi apagado pela retenção) é
   * inválido. Responde `{ id, valid }` na ordem pedida, sem motivo. Phase 16 (NOTIF-02, SEC-07): o evento VÁLIDO cuja origem (bots ou Chat geral) tem "Mostrar conteúdo"
   * ligado leva também `title`, `body` e, no `approval_pending` ainda pendente, `approvalId` (`pushContentOf`); com a chave desligada, ou inválido, só `{ id, valid }`. Nada
   * disso é gravado nem registrado em log ou auditoria. RATE_LIMITED acima de 60 por minuto na sessão.
   */
  async checkEvents(sessionId: string, ids: readonly string[]): Promise<PushEventCheck> {
    this.checkLimiter.consume(sessionId);
    const at = this.now();
    const content = await this.contentSettings();
    const checked = new Map<string, PushEventCheck['events'][number]>();
    for (const event of await loadPushEvents(this.pool, [...new Set(ids)])) {
      if ((await pushDropReasonOf(this.pool, event, at)) !== null) continue;
      const shown = event.bot_id === null ? content.generalChat : content.bots;
      checked.set(event.id, { id: event.id, valid: true, ...(shown ? await pushContentOf(this.pool, event) : null) });
    }
    return { events: ids.map((id) => checked.get(id) ?? { id, valid: false }) };
  }

  /** Estado dos interruptores "Mostrar conteúdo" (ligados por padrão, migration 0054). */
  async contentSettings(): Promise<PushContentSettings> {
    const found = await this.pool.query<{ push_content_bots: boolean; push_content_general_chat: boolean }>('SELECT push_content_bots, push_content_general_chat FROM app_settings');
    const row = found.rows[0];
    return { bots: row?.push_content_bots ?? true, generalChat: row?.push_content_general_chat ?? true };
  }

  /**
   * Liga ou desliga "Mostrar conteúdo" de UMA origem. Idempotente: o corpo é o estado final, então repetir não erra nem audita. Só uma mudança real vai para a auditoria, e junto
   * da mudança (transação): `push.content_set`, com a origem como alvo e só o booleano nos detalhes (nenhum texto). Devolve o estado dos dois interruptores.
   */
  async setContent(target: PushContentOrigin, enabled: boolean, origin: RequestOrigin): Promise<PushContentSettings> {
    const at = this.now();
    const column = CONTENT_COLUMN[target];
    await withTransaction(this.pool, async (tx) => {
      const changed = await tx.query(`UPDATE app_settings SET ${column} = $1 WHERE ${column} IS DISTINCT FROM $1`, [enabled]);
      if ((changed.rowCount ?? 0) > 0) {
        await recordAudit(tx, { action: 'push.content_set', outcome: 'success', actor: 'owner', ip: origin.ip, userAgent: origin.userAgent, target, details: { enabled } }, at);
      }
    });
    return this.contentSettings();
  }

  /**
   * Registro do service worker (phase 16; A1, A9): o aparelho diz o que fez com o aviso (recebido, exibido, suprimido com motivo, tocado), gravado em
   * em `push_receipts` para o funil separar servidor, FCM e aparelho. IDEMPOTENTE por evento, dispositivo e estado: repetir responde sucesso sem duplicar
   * (o service worker pode reenviar). O dispositivo e o evento precisam existir, senão NOT_FOUND e nada é gravado; o evento some pela retenção de 30 dias ou
   * pela exclusão do bot, e o dispositivo pela remoção. Só ids e códigos fechados: o formato (allowlist e combinação estado e motivo) já foi validado na borda
   * por `pushReceiptCreateSchema`. RATE_LIMITED acima de 120 por minuto na sessão, antes de tocar o banco. Sem auditoria (telemetria, não decisão do dono).
   */
  async recordReceipt(sessionId: string, receipt: PushReceiptCreate): Promise<void> {
    this.receiptLimiter.consume(sessionId);
    const saved = await this.pool.query(
      `INSERT INTO push_receipts (event_id, device_id, state, reason, created_at)
       SELECT $1::bigint, $2::uuid, $3::text, $4::text, $5::timestamptz
       WHERE EXISTS (SELECT 1 FROM push_devices WHERE id = $2) AND EXISTS (SELECT 1 FROM push_events WHERE id = $1)
       ON CONFLICT (event_id, device_id, state) DO NOTHING`,
      [receipt.eventId, receipt.deviceId, receipt.state, receipt.reason ?? null, this.now()],
    );
    if ((saved.rowCount ?? 0) > 0) return;
    // Nada inserido: ou o registro já existia (repetição, sucesso) ou o dispositivo ou o evento não existe.
    const known = await this.pool.query<{ ok: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM push_devices WHERE id = $1) AND EXISTS (SELECT 1 FROM push_events WHERE id = $2) AS ok',
      [receipt.deviceId, receipt.eventId],
    );
    if (known.rows[0]?.ok !== true) throw new DomainError('NOT_FOUND');
  }

  /** O que o navegador precisa para pedir o token ao FCM; `enabled: false` quando o servidor não tem o Firebase configurado. */
  config(): PushConfig {
    return this.push;
  }

  /** Dispositivos registrados, do mais antigo ao mais novo. Sem o token. */
  async listDevices(): Promise<PushDevice[]> {
    const found = await this.pool.query<DeviceRow>('SELECT id, label, created_at, last_seen_at FROM push_devices ORDER BY created_at, id');
    return found.rows.map(toDevice);
  }

  /**
   * Registra o dispositivo. Idempotente por token: o navegador chama isto a cada carga em que o push já está ativo (o token pode girar),
   * e repetir só renova o último uso e o rótulo. Só o PRIMEIRO registro vai para a auditoria, para a sincronização silenciosa não
   * encher a trilha. Um dispositivo NOVO acima do teto (`PUSH_DEVICES_MAX`) é recusado com VALIDATION_FAILED: cada dispositivo
   * multiplica os envios ao FCM por evento, e uma sessão comprometida registraria tokens sem fim (R16). Renovar um já registrado passa.
   * ponytail: a conta e o INSERT são um comando só, mas dois registros novos simultâneos podem passar do teto por um; contar sob trava se isso importar.
   */
  async registerDevice(token: string, origin: RequestOrigin): Promise<PushDevice> {
    const at = this.now();
    const label = describeDevice(origin.userAgent);
    const saved = await this.pool.query<DeviceRow & { inserted: boolean }>(
      `INSERT INTO push_devices (token, label, created_at, last_seen_at)
       SELECT $1, $2, $3, $3
       WHERE EXISTS (SELECT 1 FROM push_devices WHERE token = $1) OR (SELECT count(*) FROM push_devices) < $4
       ON CONFLICT (token) DO UPDATE SET label = EXCLUDED.label, last_seen_at = EXCLUDED.last_seen_at
       RETURNING id, label, created_at, last_seen_at, (xmax = 0) AS inserted`,
      [token, label, at, PUSH_DEVICES_MAX],
    );
    const row = saved.rows[0];
    if (row === undefined) {
      throw new DomainError('VALIDATION_FAILED', {
        fields: [{ field: 'token', reason: `Já há ${PUSH_DEVICES_MAX} dispositivos registrados, o máximo. Remova um que você não usa mais.` }],
      });
    }
    if (row.inserted) {
      await recordAudit(
        this.pool,
        { action: 'push.device_register', outcome: 'success', actor: 'owner', ip: origin.ip, userAgent: origin.userAgent, target: row.id, details: { label } },
        at,
      );
    }
    return toDevice(row);
  }

  /**
   * A matriz de silenciar (F14 passo 4): um bot ativo por linha, em ordem alfabética, mais o Chat geral por último, cada um com os tipos
   * silenciados. Bot arquivado não aparece (não roda nada novo), mas o que foi silenciado nele volta com ele ao ser desarquivado.
   */
  async listPreferences(): Promise<PushPreferences> {
    const [bots, mutes] = await Promise.all([
      this.pool.query<{ id: string; name: string }>('SELECT id, name FROM bots WHERE archived_at IS NULL ORDER BY name_key, created_at, id'),
      this.pool.query<{ bot_id: string | null; kind: PushEventKind }>('SELECT bot_id, kind FROM push_mutes'),
    ]);
    const mutedBy = (botId: string | null): PushEventKind[] => inKindOrder(mutes.rows.filter((row) => row.bot_id === botId).map((row) => row.kind));
    return {
      targets: [
        ...bots.rows.map((bot) => ({ botId: bot.id, name: bot.name, muted: mutedBy(bot.id) })),
        { botId: null, name: GENERAL_CHAT_PUSH_TITLE, muted: mutedBy(null) },
      ],
    };
  }

  /**
   * Silencia (`muted: true`) ou volta a receber (`false`) UM tipo de aviso de um bot (`botId`) ou do Chat geral (`null`). Idempotente: o
   * corpo é o estado final, então repetir não erra. Só uma mudança real vai para a auditoria (silenciar "Aprovação pendente" decide o
   * que o dono deixa de ver no aparelho). Devolve a linha da matriz já atualizada. BOT_NOT_FOUND se o bot não existe.
   */
  async setMute(botId: string | null, kind: PushEventKind, muted: boolean, origin: RequestOrigin): Promise<PushMuteTarget> {
    const at = this.now();
    let name = GENERAL_CHAT_PUSH_TITLE;
    if (botId !== null) {
      const bot = await this.pool.query<{ name: string }>('SELECT name FROM bots WHERE id = $1', [botId]);
      if (!bot.rows[0]) throw new DomainError('BOT_NOT_FOUND');
      name = bot.rows[0].name;
    }

    // A mudança e a auditoria saem juntas: se a trilha falhar, o silêncio também não fica gravado sem rastro (R22).
    await withTransaction(this.pool, async (tx) => {
      const changed = muted
        ? await tx.query('INSERT INTO push_mutes (bot_id, kind, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [botId, kind, at])
        : await tx.query('DELETE FROM push_mutes WHERE kind = $1 AND bot_id IS NOT DISTINCT FROM $2::uuid', [kind, botId]);
      if ((changed.rowCount ?? 0) > 0) {
        await recordAudit(
          tx,
          { action: 'push.mute_set', outcome: 'success', actor: 'owner', ip: origin.ip, userAgent: origin.userAgent, target: botId ?? 'general_chat', details: { kind, muted } },
          at,
        );
      }
    });

    const now = await this.pool.query<{ kind: PushEventKind }>('SELECT kind FROM push_mutes WHERE bot_id IS NOT DISTINCT FROM $1::uuid', [botId]);
    return { botId, name, muted: inKindOrder(now.rows.map((row) => row.kind)) };
  }

  /** Remove o dispositivo: ele deixa de receber os avisos. NOT_FOUND se o id não existe (inclusive se já foi removido). */
  async removeDevice(id: string, origin: RequestOrigin): Promise<void> {
    const at = this.now();
    const removed = await this.pool.query<{ label: string }>('DELETE FROM push_devices WHERE id = $1 RETURNING label', [id]);
    const row = removed.rows[0];
    if (!row) throw new DomainError('NOT_FOUND');
    await recordAudit(
      this.pool,
      { action: 'push.device_remove', outcome: 'success', actor: 'owner', ip: origin.ip, userAgent: origin.userAgent, target: id, details: { label: row.label } },
      at,
    );
  }
}

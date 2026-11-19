// Despachante dos pushes (roda no worker; T10, F14): de tempos em tempos lê a caixa de saída (`push_events`, alimentada por
// `enqueuePushEvent`), envia cada aviso a todos os dispositivos registrados pelo FCM e marca o resultado. É a ÚNICA peça que monta a mensagem
// do push: título = nome do bot (ou "Chat geral", se a execução é de uma sessão), corpo = tipo do evento, abertura = o cartão. Nada da
// conversa chega aqui.
//
// Garantias:
// - Cada evento é enviado uma vez por dispositivo, mesmo com dois workers: a reivindicação usa `FOR UPDATE SKIP LOCKED` e uma posse
//   temporária (`claimed_at`). Uma queda depois de reivindicar e antes de marcar como enviado repete o evento quando a posse vence
//   (pelo menos uma vez); a `tag` (por aprovação nos eventos de aprovação, por conversa nos demais) faz o aparelho SUBSTITUIR a notificação em vez de mostrar duas.
// - A decisão de avisar é tomada AQUI, no momento do envio, e não ao gravar o evento (phase 3, T3; Suposição 6): a regra de validade
//   (`pushDropReasonOf`, a mesma da conferência do service worker) descarta o evento obsoleto (presença na conversa, abertura do app, conversa
//   já lida, aprovação resolvida, tipo silenciado, mais de 24 horas) como `dropped` com o motivo em `drop_reason`, sem tocar o FCM. Vale para
//   tudo o que ainda não saiu, inclusive as repetições de um evento com falha transitória.
// - O push leva o id do evento (`eventId`), que o service worker usa para conferir na chegada se o aviso ainda vale (T4).
// - Token recusado pelo FCM como inválido remove o dispositivo na hora (spec F14), sem afetar os demais.
// - Falha transitória (rede, 5xx, 429, credencial) não perde o aviso: o evento volta à fila (a posse vence e ele é reivindicado de novo) até
//   `maxAttempts`; depois é descartado (`attempts_exhausted`) com um aviso no log.
// - Sem credencial do FCM no worker (push não configurado) os avisos são descartados (`no_fcm_account`) com um aviso no log, em vez de acumular.
// - Todo desfecho que não envia é `dropped` com um `drop_reason` (phase 16): a regra de validade, `no_fcm_account`, `no_device` (nenhum dispositivo
//   no envio), `no_destination` (bot ou sessão do evento apagado) e `attempts_exhausted`. `sent` quer dizer que o FCM respondeu a cada dispositivo
//   alvo (aceitou ou recusou o token), e o que cada um respondeu fica em `push_deliveries`.
//
// Entrega por dispositivo (phase 16; `push_deliveries`, migration 0053): cada envio a um dispositivo grava uma linha com a tentativa do evento, o
// status HTTP do FCM e o resultado (aceito, token recusado, falha), SEM token nem conteúdo. A linha do dispositivo recusado fica depois que o
// dispositivo é removido (a tabela não tem chave para `push_devices`, de propósito). A repetição de um evento com falha transitória reenvia só
// aos dispositivos que ainda NÃO têm entrega aceita, então um aparelho que já recebeu não recebe de novo.
//
// ponytail: `maxAttempts` conta por EVENTO, não por dispositivo: um aparelho que falha sempre esgota as tentativas do evento (os já aceitos não são
// reenviados), contar por dispositivo se o FCM passar a falhar de forma seletiva.
import { PUSH_EVENT_LABELS, type PushDeliveryOutcome, type PushDropReason, type PushEventKind } from '@aion/shared';
import type { Pool } from '../db/pool';
import type { Logger } from '../logging';
import type { FcmClient, FcmSendResult, PushMessage } from './fcm';
import { loadPushEvents, pushDropReasonOf, type PushEventFacts } from './validity';

export interface PushDispatcherConfig {
  /** De quanto em quanto tempo o despachante procura eventos pendentes. */
  pollMs: number;
  /** Eventos tratados por ciclo (os demais ficam para o próximo). */
  batch: number;
  /** Quanto tempo um evento reivindicado fica reservado; é também o intervalo entre as tentativas de um evento com falha transitória. */
  claimTtlMs: number;
  /** Tentativas com falha transitória antes de desistir do evento. */
  maxAttempts: number;
  /** Eventos já tratados são apagados depois deste tempo, com as entregas e os registros do aparelho (a janela de medição do diagnóstico é de 7 dias). */
  retentionMs: number;
}

export const DEFAULT_PUSH_CONFIG: PushDispatcherConfig = {
  pollMs: 2_000,
  batch: 20,
  claimTtlMs: 30_000,
  maxAttempts: 4,
  retentionMs: 30 * 24 * 3600_000,
};

/** A limpeza dos eventos antigos roda no máximo uma vez por hora. */
const CLEANUP_EVERY_MS = 3600_000;

export interface PushDispatcherOptions {
  pool: Pool;
  /** Cliente do FCM; nulo quando o worker não tem a conta de serviço (os eventos são descartados). */
  fcm: FcmClient | null;
  logger: Logger;
  now?: () => Date;
  config?: Partial<PushDispatcherConfig>;
}

/** Evento reivindicado: os fatos da regra de validade mais as tentativas já feitas. */
interface ClaimedEvent extends PushEventFacts {
  attempts: number;
}

/** Resultado do cliente do FCM → resultado gravado em `push_deliveries.outcome`. */
const DELIVERY_OUTCOME: Record<FcmSendResult, PushDeliveryOutcome> = { sent: 'accepted', invalid_token: 'rejected_token', failed: 'failed' };

/** Título do push de uma execução do chat geral (spec decisão 18: "o nome do bot, ou Chat geral"). */
export const GENERAL_CHAT_PUSH_TITLE = 'Chat geral';

/**
 * Tag da notificação por conversa e categoria (phase 3, T3; A4): `aion-activity-<id>` para `run_*` e `aion-approval-<id>` para
 * `approval_*`, em que o id é o mesmo do caminho de abertura (o do bot, cuja conversa é única, ou o da sessão do Chat geral). Um aviso novo da
 * mesma conversa e categoria SUBSTITUI o anterior no aparelho, em vez de empilhar; atividade e aprovação continuam separadas.
 * Phase 16: vale como está para as RESPOSTAS e rotinas (uma notificação por conversa, com o contador das anteriores no aparelho). As aprovações usam a tag da
 * aprovação (`approvalTagOf`) e só caem aqui se a aprovação do evento não existe mais.
 */
export function pushTagOf(kind: PushEventKind, conversationKey: string): string {
  return `aion-${kind.startsWith('approval_') ? 'approval' : 'activity'}-${conversationKey}`;
}

/** Tag de UMA aprovação (phase 16, A10): `aion-approval-<id da aprovação>`. A web fecha a notificação dela ao decidir na tela por esta mesma forma (`close-notifications.ts`). */
export const approvalTagOf = (approvalId: string): string => `aion-approval-${approvalId}`;

export class PushDispatcher {
  private readonly pool: Pool;
  private readonly fcm: FcmClient | null;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly config: PushDispatcherConfig;
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private ticking: Promise<unknown> = Promise.resolve();
  private lastCleanupAtMs = 0;

  constructor({ pool, fcm, logger, now = () => new Date(), config = {} }: PushDispatcherOptions) {
    this.pool = pool;
    this.fcm = fcm;
    this.logger = logger;
    this.now = now;
    this.config = { ...DEFAULT_PUSH_CONFIG, ...config };
  }

  /** Começa a despachar a cada `pollMs`. Erro de um ciclo é logado e o laço continua. */
  start(): void {
    if (this.timer !== null || this.stopping) return;
    const tick = () => {
      this.ticking = this.tickOnce()
        .catch((error: unknown) => this.logger.error({ err: error }, 'falha ao despachar os pushes'))
        .finally(() => {
          if (!this.stopping) this.timer = setTimeout(tick, this.config.pollMs);
        });
    };
    this.timer = setTimeout(tick, 0);
  }

  /** Para de despachar e espera o ciclo em andamento terminar. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.ticking;
  }

  /** Um ciclo: reivindica os eventos pendentes e entrega cada um. Devolve quantos tratou. Exposto para os testes. */
  async tickOnce(): Promise<number> {
    await this.cleanup();
    const claimed = await this.claim();
    for (const event of claimed) {
      if (this.stopping) break;
      await this.deliver(event);
    }
    return claimed.length;
  }

  /** Reserva os pendentes (novos ou com a posse vencida), do mais antigo ao mais novo. Dois despachantes nunca pegam o mesmo evento. */
  private async claim(): Promise<ClaimedEvent[]> {
    const at = this.now();
    const expired = new Date(at.getTime() - this.config.claimTtlMs);
    const claimed = await this.pool.query<{ id: string; attempts: number }>(
      `UPDATE push_events SET claimed_at = $1
       WHERE id IN (
         SELECT id FROM push_events WHERE status = 'pending' AND (claimed_at IS NULL OR claimed_at <= $2)
         ORDER BY id LIMIT $3 FOR UPDATE SKIP LOCKED)
       RETURNING id::text AS id, attempts`,
      [at, expired, this.config.batch],
    );
    // Os fatos vêm da mesma leitura que a conferência usa (`loadPushEvents`, já em ordem de id), para envio e conferência não divergirem.
    const attempts = new Map(claimed.rows.map((row) => [row.id, row.attempts]));
    const facts = await loadPushEvents(this.pool, [...attempts.keys()]);
    return facts.map((event) => ({ ...event, attempts: attempts.get(event.id) ?? 0 }));
  }

  /** Entrega UM evento a todos os dispositivos e grava o desfecho. Nunca lança: um problema num evento não segura os outros. */
  private async deliver(event: ClaimedEvent): Promise<void> {
    try {
      const reason = await pushDropReasonOf(this.pool, event, this.now());
      if (reason !== null) {
        // Só o id, o tipo e o código do motivo: nada da conversa.
        this.logger.info({ eventId: event.id, kind: event.kind, reason }, 'push descartado: o aviso não vale mais');
        await this.finish(event.id, 'dropped', reason);
        return;
      }
      if (!this.fcm) {
        this.logger.warn({ eventId: event.id }, 'push descartado: o worker não tem a conta de serviço do FCM (AION_FCM_SERVICE_ACCOUNT)');
        await this.finish(event.id, 'dropped', 'no_fcm_account');
        return;
      }
      const devices = await this.pool.query<{ id: string; token: string }>('SELECT id, token FROM push_devices ORDER BY created_at, id');
      // Sem dispositivo (removido depois do evento) ou sem destino (bot inexistente, sessão já apagada) não há a quem avisar nem o que dizer: o
      // evento termina descartado com o motivo, e não mais como enviado (phase 16: o funil não pode contar como envio o que não saiu).
      if (devices.rows.length === 0) {
        await this.finish(event.id, 'dropped', 'no_device');
        return;
      }
      const destination = await this.destinationOf(event);
      if (destination === null) {
        await this.finish(event.id, 'dropped', 'no_destination');
        return;
      }

      // Numa repetição (falha transitória de outro dispositivo), quem já aceitou o aviso não o recebe de novo.
      const already = await this.pool.query<{ device_id: string }>(
        "SELECT DISTINCT device_id::text AS device_id FROM push_deliveries WHERE event_id = $1 AND outcome = 'accepted'",
        [event.id],
      );
      const accepted = new Set(already.rows.map((row) => row.device_id));
      const targets = devices.rows.filter((device) => !accepted.has(device.id));

      const message: PushMessage = {
        title: destination.title,
        body: PUSH_EVENT_LABELS[event.kind],
        url: `${destination.path}${event.message_id === null ? '' : `?mensagem=${event.message_id}`}`,
        tag: await this.tagOf(event, destination.key),
        kind: event.kind,
        eventId: event.id,
      };
      const fcm = this.fcm;
      const attempt = event.attempts + 1;
      // Cada resposta é gravada assim que chega, sem esperar os outros dispositivos: uma queda no meio perde o mínimo do rastro.
      const results = await Promise.all(
        targets.map(async (device) => {
          const sent = await fcm.send(device.token, message);
          await this.recordDelivery(event.id, device.id, attempt, sent.status, DELIVERY_OUTCOME[sent.result]);
          return { device, result: sent.result };
        }),
      );

      const invalid = results.filter((entry) => entry.result === 'invalid_token').map((entry) => entry.device.id);
      if (invalid.length > 0) {
        await this.pool.query('DELETE FROM push_devices WHERE id = ANY($1::uuid[])', [invalid]);
        this.logger.info({ eventId: event.id, removed: invalid.length }, 'dispositivos removidos: o FCM recusou o token');
      }
      if (results.some((entry) => entry.result === 'failed')) await this.retryOrDrop(event);
      else {
        // Um envio deixa rastro (R19): sem esta linha, "o push não chegou" não se distingue de "o worker nunca enviou". `devices` são os dispositivos
        // que o FCM ACEITOU (os desta tentativa mais os de tentativas anteriores do evento) e `rejected` os tokens recusados agora. Só ids, o tipo
        // e contagens: nunca o token do dispositivo nem o conteúdo.
        const acceptedTotal = accepted.size + results.filter((entry) => entry.result === 'sent').length;
        if (acceptedTotal > 0) this.logger.info({ eventId: event.id, kind: event.kind, devices: acceptedTotal, rejected: invalid.length }, 'push enviado');
        else this.logger.warn({ eventId: event.id, kind: event.kind, rejected: invalid.length }, 'push sem aceite: o FCM recusou o token de todos os dispositivos');
        await this.finish(event.id, 'sent');
      }
    } catch (error) {
      this.logger.error({ err: error, eventId: event.id }, 'falha ao entregar o push');
      await this.retryOrDrop(event).catch(() => undefined);
    }
  }

  /** Grava o que o FCM respondeu sobre UM dispositivo (`push_deliveries`): ids, tentativa, status HTTP e resultado; nunca o token nem o conteúdo. */
  private async recordDelivery(eventId: string, deviceId: string, attempt: number, httpStatus: number | null, outcome: PushDeliveryOutcome): Promise<void> {
    await this.pool.query('INSERT INTO push_deliveries (event_id, device_id, attempt, http_status, outcome, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [
      eventId,
      deviceId,
      attempt,
      httpStatus,
      outcome,
      this.now(),
    ]);
  }

  /**
   * A tag do aviso: uma por APROVAÇÃO nos eventos `approval_*` (duas aprovações seguidas são duas notificações, e a expirada substitui a pendente da mesma aprovação),
   * ou a da conversa e categoria (`pushTagOf`) nas respostas e rotinas, que o aparelho agrupa. A aprovação do evento é a do cartão dele ou, sem cartão, a mais recente da
   * execução (a mesma ligação de `validity.ts`); sem nenhuma (apagada), cai na tag por conversa.
   */
  private async tagOf(event: ClaimedEvent, conversationKey: string): Promise<string> {
    if (event.kind.startsWith('approval_')) {
      const found = await this.pool.query<{ id: string }>(
        `SELECT id::text AS id FROM approvals WHERE card_id = $1::bigint OR ($1::bigint IS NULL AND run_id = $2::bigint) ORDER BY id DESC LIMIT 1`,
        [event.message_id, event.run_id],
      );
      if (found.rows[0] !== undefined) return approvalTagOf(found.rows[0].id);
    }
    return pushTagOf(event.kind, conversationKey);
  }

  /**
   * Quem avisa e para onde o toque leva: o bot (nome e `/bots/:id`) ou o chat geral (`/chat/:sessão`); `key` é o id desse caminho, base da
   * tag por conversa. Nulo se o dono do evento não existe mais.
   */
  private async destinationOf(event: ClaimedEvent): Promise<{ title: string; path: string; key: string } | null> {
    if (event.bot_id === null) {
      const session = event.conversation_id;
      return session === null ? null : { title: GENERAL_CHAT_PUSH_TITLE, path: `/chat/${session}`, key: session };
    }
    const bot = await this.pool.query<{ name: string }>('SELECT name FROM bots WHERE id = $1', [event.bot_id]);
    const name = bot.rows[0]?.name;
    return name === undefined ? null : { title: name, path: `/bots/${event.bot_id}`, key: event.bot_id };
  }

  /** Falha transitória: conta a tentativa e deixa o evento voltar à fila quando a posse vencer, ou desiste ao esgotar as tentativas. */
  private async retryOrDrop(event: ClaimedEvent): Promise<void> {
    if (event.attempts + 1 >= this.config.maxAttempts) {
      this.logger.warn({ eventId: event.id, attempts: event.attempts + 1 }, 'push descartado: tentativas esgotadas');
      await this.pool.query("UPDATE push_events SET attempts = attempts + 1, status = 'dropped', drop_reason = 'attempts_exhausted', finished_at = $2 WHERE id = $1", [event.id, this.now()]);
      return;
    }
    await this.pool.query('UPDATE push_events SET attempts = attempts + 1, claimed_at = $2 WHERE id = $1', [event.id, this.now()]);
  }

  /** Encerra o evento da caixa de saída (`sent` ou `dropped`, este sempre com o motivo do descarte) e grava o instante. */
  private async finish(eventId: string, status: 'sent' | 'dropped', reason: PushDropReason | null = null): Promise<void> {
    await this.pool.query('UPDATE push_events SET status = $2, drop_reason = $3, finished_at = $4 WHERE id = $1', [eventId, status, reason, this.now()]);
  }

  /**
   * Apaga os eventos já tratados há mais que a retenção (30 dias, phase 16): a caixa de saída é uma fila, mas o diagnóstico precisa do descarte com
   * motivo na janela inteira de medição. As entregas e os registros do aparelho saem junto, por `ON DELETE CASCADE`. No máximo uma vez por hora.
   */
  private async cleanup(): Promise<void> {
    const nowMs = this.now().getTime();
    if (nowMs - this.lastCleanupAtMs < CLEANUP_EVERY_MS) return;
    this.lastCleanupAtMs = nowMs;
    await this.pool.query("DELETE FROM push_events WHERE status <> 'pending' AND finished_at < $1", [new Date(nowMs - this.config.retentionMs)]);
  }
}

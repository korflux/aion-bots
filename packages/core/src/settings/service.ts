// Preferências gerais do dono (T28): idioma das respostas dos bots e fuso horário, mais o interruptor da pesquisa na web (phase 1, T8) e "Como te
// chamar" (phase 5, T4). FONTE ÚNICA da leitura e da gravação (tabela `app_settings`, uma linha só, criada vazia de escolhas pela migration 0015 com o
// padrão anterior: português do Brasil e America/Sao_Paulo; a coluna `web_search_enabled` veio na 0017, ligada por padrão; `owner_name`, na 0029, vazia).
//
// O interruptor da pesquisa na web é lido e gravado À PARTE de idioma e fuso (`readWebSearchEnabled`, `setWebSearchEnabled`): é outra tela, outro
// contrato HTTP e outra auditoria, e `AppSettings` (o corpo do PUT de idioma e fuso) segue com os dois campos de sempre.
//
// Quem lê: o contexto do modelo (cabeçalho "Idioma" e "Agora"), a proposta de rotina do bot (fuso padrão) e o cartão da rotina que o modelo lê,
// todos por `readAppSettings`; a tela de Configurações, por `SettingsService.read`. Quem altera é só o dono, por `update`.
//
// O NOME do dono (`ownerName`) é só de apresentação (a saudação do Início): `readAppSettings` devolve `ContextSettings` (idioma e fuso), sem o nome, então
// nenhum consumidor de contexto o recebe; só `SettingsService.read` o junta (`readOwnerName`). A auditoria registra apenas SE o nome mudou, nunca o valor.
//
// O MODELO DO RESUMO (phase 9, T4; coluna `summary_model` da 0041) também vive aqui: é uma preferência do cartão Contexto, gravada À PARTE das janelas e do idioma
// (`updateContextPreference`, escopo `summary_model`) e lida pelo motor numa função única, `resolveSummaryModel`, que decide o modelo efetivo do resumo.
//
// Validação (na borda e aqui): o idioma é uma allowlist (`LANGUAGE_CODES`); o fuso precisa ter o formato IANA (schema compartilhado) E existir no
// banco de fusos do runtime (`isValidTimeZone`), porque um fuso desconhecido faria o "Agora" do contexto e as agendas falharem em runtime.
import { DEFAULT_APP_SETTINGS, appSettingsSchema, languageCodeSchema, type AppSettings, type ContextSettings, contextPreferenceUpdateSchema, type ContextPreferenceUpdate, type ContextPreferencesView } from '@aion/shared';
import { recordAudit } from '../audit';
import type { RequestOrigin } from '../auth/service';
import { withTransaction, type Pool, type Queryable } from '../db/pool';
import { DomainError } from '../errors';
import type { Logger } from '../logging';
import { readContextPreferences } from '../conversation/context-window';
import { isValidTimeZone } from '../routines/zoned-time';

/**
 * As preferências que o contexto do modelo e as rotinas usam (idioma e fuso; NUNCA o nome do dono). Lida com qualquer `Queryable` (pool ou
 * transação) porque quem monta o contexto e o cartão da rotina já tem uma conexão à mão. Sem a linha (migration não aplicada) ou com um valor que
 * a allowlist não conhece, vale o padrão anterior ao T28.
 */
export async function readAppSettings(db: Queryable): Promise<ContextSettings> {
  const found = await db.query<{ language: string; time_zone: string }>('SELECT language, time_zone FROM app_settings');
  const row = found.rows[0];
  const language = languageCodeSchema.safeParse(row?.language);
  return {
    language: language.success ? language.data : DEFAULT_APP_SETTINGS.language,
    timeZone: row !== undefined && isValidTimeZone(row.time_zone) ? row.time_zone : DEFAULT_APP_SETTINGS.timeZone,
  };
}

/** "Como te chamar": o nome do dono, ou vazio (sem a linha, sem a coluna ainda ou sem escolha). Só a tela o lê. */
export async function readOwnerName(db: Queryable): Promise<string> {
  const found = await db.query<{ owner_name: string }>('SELECT owner_name FROM app_settings');
  return found.rows[0]?.owner_name ?? DEFAULT_APP_SETTINGS.ownerName;
}

/**
 * O interruptor da pesquisa na web: ligado por padrão (spec, Suposição 17), inclusive sem a linha de `app_settings`. Lida com qualquer
 * `Queryable` porque o motor dos bots e do Chat geral (T9) a consulta no início de CADA execução, e é isso que faz a mudança valer "a partir
 * da próxima execução".
 */
export async function readWebSearchEnabled(db: Queryable): Promise<boolean> {
  const found = await db.query<{ web_search_enabled: boolean }>('SELECT web_search_enabled FROM app_settings');
  return found.rows[0]?.web_search_enabled ?? true;
}

/** O modelo do resumo que o dono escolheu em Preferências; nulo = "o modelo da conversa" (padrão, e o valor de quem nunca escolheu). */
export async function readSummaryModel(db: Queryable): Promise<string | null> {
  const found = await db.query<{ summary_model: string | null }>('SELECT summary_model FROM app_settings');
  return found.rows[0]?.summary_model ?? null;
}

/**
 * Critério único de "modelo validado" para o resumo: o teste do modelo achou um protocolo que funciona (`test_protocol` preenchido, seja `ok` ou
 * `no_tools`: o resumo não usa ferramentas). É a mesma exigência que a compactação manual e o executor já fazem para `summarize`, e que a lista da tela
 * (perfis testados, sem "Falhou") reproduz. Só o banco decide, sem consultar o provedor: roda no worker a cada resumo.
 * ponytail: não reconfere o catálogo atual do provedor, trocar por essa conferência se o provedor passar a retirar modelos e o resumo falhar por isso.
 */
export async function isValidatedModel(db: Queryable, model: string): Promise<boolean> {
  const found = await db.query('SELECT 1 FROM model_profiles WHERE model_id = $1 AND test_protocol IS NOT NULL', [model]);
  return (found.rowCount ?? 0) > 0;
}

/**
 * FUNÇÃO ÚNICA do modelo efetivo do resumo (spec Decisão 6 e A13): o modelo escolhido em Preferências, se ainda for validado NO USO; senão, o modelo da
 * conversa (`conversationModel`). Vazio e "igual ao da conversa" devolvem o da conversa sem consulta extra. Um modelo salvo que deixou de ser validado
 * (novo teste que falhou, perfil removido) cai no da conversa e registra no log só os dois ids, nunca texto de conversa. Quem chama o resumo (o motor,
 * T5) usa o que esta função devolve e nada mais: a escolha do dono nunca derruba uma compactação.
 */
export async function resolveSummaryModel(db: Queryable, conversationModel: string, logger: Pick<Logger, 'warn'>): Promise<string> {
  const saved = await readSummaryModel(db);
  if (saved === null || saved === conversationModel) return conversationModel;
  if (await isValidatedModel(db, saved)) return saved;
  logger.warn({ summaryModel: saved, conversationModel }, 'modelo do resumo não está mais validado; usando o modelo da conversa');
  return conversationModel;
}

export interface SettingsServiceOptions {
  pool: Pool;
  /** Relógio injetável: os testes fixam o tempo. */
  now?: () => Date;
}

export class SettingsService {
  private readonly pool: Pool;
  private readonly now: () => Date;

  constructor({ pool, now = () => new Date() }: SettingsServiceOptions) {
    this.pool = pool;
    this.now = now;
  }

  /** As preferências atuais, com o nome do dono (tela de Configurações e, depois, a saudação do Início). */
  async read(): Promise<AppSettings> {
    return { ...(await readAppSettings(this.pool)), ownerName: await readOwnerName(this.pool) };
  }

  /**
   * Grava idioma, fuso e nome (os três juntos) e audita quem, o quê e de onde. VALIDATION_FAILED com o campo se o fuso não existe ou o nome é
   * inválido. A auditoria diz SE o nome mudou (`ownerNameChanged`), nunca o valor.
   */
  async update(input: AppSettings, origin: RequestOrigin): Promise<AppSettings> {
    // A borda já validou o formato; aqui entra a autoridade sobre o conteúdo (idioma da allowlist e fuso que o runtime conhece).
    const checked = appSettingsSchema.safeParse(input);
    if (!checked.success) {
      throw new DomainError('VALIDATION_FAILED', { fields: checked.error.issues.map((issue) => ({ field: String(issue.path[0] ?? 'settings'), reason: 'Valor inválido.' })) });
    }
    const parsed = checked.data;
    if (!isValidTimeZone(parsed.timeZone)) {
      throw new DomainError('VALIDATION_FAILED', { fields: [{ field: 'timeZone', reason: 'Fuso horário desconhecido.' }] });
    }
    const at = this.now();
    await withTransaction(this.pool, async (tx) => {
      // O nome anterior (travado até o fim da transação) é o que permite auditar "mudou ou não" sem gravar o valor.
      const before = await tx.query<{ owner_name: string }>('SELECT owner_name FROM app_settings FOR UPDATE');
      await tx.query(
        `INSERT INTO app_settings (singleton, language, time_zone, owner_name, updated_at) VALUES (true, $1, $2, $3, $4)
         ON CONFLICT (singleton) DO UPDATE SET language = excluded.language, time_zone = excluded.time_zone, owner_name = excluded.owner_name,
           updated_at = excluded.updated_at`,
        [parsed.language, parsed.timeZone, parsed.ownerName, at],
      );
      const ownerNameChanged = (before.rows[0]?.owner_name ?? DEFAULT_APP_SETTINGS.ownerName) !== parsed.ownerName;
      await recordAudit(
        tx,
        {
          action: 'settings.updated',
          outcome: 'success',
          actor: 'owner',
          ip: origin.ip,
          userAgent: origin.userAgent,
          target: 'app_settings',
          details: { language: parsed.language, timeZone: parsed.timeZone, ownerNameChanged },
        },
        at,
      );
    });
    return this.read();
  }

  /** Leitura independente das escolhas de contexto (janelas e modelo do resumo), sem alterar o contrato das preferências anteriores. */
  async readContextPreferences(): Promise<ContextPreferencesView> {
    return { ...(await readContextPreferences(this.pool)), summaryModel: await readSummaryModel(this.pool) };
  }

  /**
   * Altera UMA preferência de contexto, validada: a janela de um escopo ou o modelo do resumo (duas sessões não sobrescrevem as outras nem idioma/fuso).
   * O modelo do resumo, quando não nulo, precisa ser um modelo validado (`isValidatedModel`), senão VALIDATION_FAILED no campo `summaryModel` e nada é
   * gravado; nulo volta ao modelo da conversa. A auditoria registra o escopo e o valor escolhido (id de modelo, nunca conteúdo).
   */
  async updateContextPreference(input: ContextPreferenceUpdate, origin: RequestOrigin): Promise<ContextPreferencesView> {
    const checked = contextPreferenceUpdateSchema.safeParse(input);
    if (!checked.success) throw new DomainError('VALIDATION_FAILED');
    const update = checked.data;
    const at = this.now();
    await withTransaction(this.pool, async (tx) => {
      if (update.scope === 'summary_model') {
        if (update.summaryModel !== null && !(await isValidatedModel(tx, update.summaryModel))) {
          throw new DomainError('VALIDATION_FAILED', { fields: [{ field: 'summaryModel', reason: 'Escolha um modelo validado.' }] });
        }
        await tx.query(`INSERT INTO app_settings (singleton, summary_model, updated_at) VALUES (true, $1, $2)
          ON CONFLICT (singleton) DO UPDATE SET summary_model = excluded.summary_model, updated_at = excluded.updated_at`, [update.summaryModel, at]);
        await recordAudit(tx, { action: 'settings.context', outcome: 'success', actor: 'owner', ip: origin.ip, userAgent: origin.userAgent, target: 'app_settings', details: { scope: update.scope, summaryModel: update.summaryModel } }, at);
        return;
      }
      const column = update.scope === 'bots' ? 'bot_context_window_tokens' : 'general_chat_context_window_tokens';
      await tx.query(`INSERT INTO app_settings (singleton, ${column}, updated_at) VALUES (true, $1, $2)
        ON CONFLICT (singleton) DO UPDATE SET ${column} = excluded.${column}, updated_at = excluded.updated_at`, [update.windowTokens, at]);
      await recordAudit(tx, { action: 'settings.context', outcome: 'success', actor: 'owner', ip: origin.ip, userAgent: origin.userAgent, target: 'app_settings', details: { scope: update.scope, windowTokens: update.windowTokens } }, at);
    });
    return this.readContextPreferences();
  }

  /** O interruptor da pesquisa na web (Configurações → Pesquisa na web). */
  async readWebSearchEnabled(): Promise<boolean> {
    return readWebSearchEnabled(this.pool);
  }

  /**
   * Liga ou desliga a pesquisa na web e audita quem, o quê e de onde (só o booleano; nunca a chave, que nem passa por aqui). Vale a partir da
   * próxima execução. Grava mesmo quando o valor não mudou: o dono confirmou a escolha, e a auditoria registra o gesto.
   */
  async setWebSearchEnabled(enabled: boolean, origin: RequestOrigin): Promise<boolean> {
    const at = this.now();
    await withTransaction(this.pool, async (tx) => {
      // Sem a linha (só se alguém a apagou à mão) o INSERT a recria com os padrões de idioma e fuso.
      await tx.query(
        `INSERT INTO app_settings (singleton, web_search_enabled, updated_at) VALUES (true, $1, $2)
         ON CONFLICT (singleton) DO UPDATE SET web_search_enabled = excluded.web_search_enabled, updated_at = excluded.updated_at`,
        [enabled, at],
      );
      await recordAudit(
        tx,
        { action: 'settings.web_search', outcome: 'success', actor: 'owner', ip: origin.ip, userAgent: origin.userAgent, target: 'app_settings', details: { enabled } },
        at,
      );
    });
    return enabled;
  }
}

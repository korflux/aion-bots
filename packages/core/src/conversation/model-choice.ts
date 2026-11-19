// Modelo e effort em uso numa conversa (spec decisão 14). Fonte única da regra, usada pela API (recusar o envio sem
// modelo e mostrar a escolha no composer) e pelo motor de execução (chamar o modelo a cada etapa).
//
// Precedência numa conversa de BOT: preferência da conversa (a troca feita no composer) > padrão do bot > primeiro favorito (o mais antigo) que NÃO esteja oculto (A7: oculto sai das escolhas novas; a
// preferência e o padrão do bot, que o dono já fez, valem mesmo ocultos, A9).
// A preferência da conversa vale INTEIRA, inclusive o effort: escolher um modelo e deixar o effort em "padrão" não
// herda o effort do bot. Sem nada disso, não há modelo (`model: null`) e o envio é recusado com MODEL_UNAVAILABLE.
// Numa SESSÃO do chat geral (T23): preferência da conversa > modelo padrão do Chat geral (obrigatório, definido em Configurações) > nenhum.
// O primeiro favorito NÃO vale para sessões: o chat geral só conversa com um padrão que o dono escolheu de propósito.
import { effortLevelSchema, type EffortLevel, type ModelChoiceView } from '@aion/shared';
import type { Queryable } from '../db/pool';
import { DomainError } from '../errors';

/** Normaliza o valor persistido ao contrato público de effort. */
const toEffort = (value: string | null): EffortLevel | null => {
  const parsed = effortLevelSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** Acrescenta os níveis conhecidos à escolha efetiva; nunca expõe um effort incompatível depois de um novo teste. */
async function withEffortLevels(db: Queryable, choice: ModelChoiceView): Promise<ModelChoiceView> {
  if (choice.model === null) return { ...choice, effortLevels: [] };
  const profile = await db.query<{ effort_levels: string[] }>('SELECT effort_levels FROM model_profiles WHERE model_id = $1', [choice.model]);
  const effortLevels = (profile.rows[0]?.effort_levels ?? []).flatMap((level) => {
    const parsed = effortLevelSchema.safeParse(level);
    return parsed.success ? [parsed.data] : [];
  });
  return { ...choice, effort: choice.effort !== null && effortLevels.includes(choice.effort) ? choice.effort : null, effortLevels };
}

/** O modelo e o effort padrão do Chat geral (T23); `model` nulo enquanto o dono não definiu. Fonte única, lida pela resolução e pela API. */
export async function readSessionDefault(db: Queryable): Promise<ModelChoiceView> {
  const found = await db.query<{ model: string; effort: string | null }>('SELECT model, effort FROM general_chat_settings');
  const row = found.rows[0];
  return withEffortLevels(db, row ? { model: row.model, effort: toEffort(row.effort) } : { model: null, effort: null });
}

/** Escolha resolvida da conversa (de um bot ou de uma sessão). Lança NOT_FOUND se a conversa não existe. */
export async function resolveModelChoice(db: Queryable, conversationId: string): Promise<ModelChoiceView> {
  const found = await db.query<{
    preferred_model: string | null;
    preferred_effort: string | null;
    is_session: boolean;
    model: string | null;
    effort: string | null;
  }>(
    `SELECT c.preferred_model, c.preferred_effort, c.bot_id IS NULL AS is_session, b.model, b.effort
     FROM conversations c LEFT JOIN bots b ON b.id = c.bot_id
     WHERE c.id = $1`,
    [conversationId],
  );
  const row = found.rows[0];
  if (!row) throw new DomainError('NOT_FOUND');
  if (row.preferred_model !== null) return withEffortLevels(db, { model: row.preferred_model, effort: toEffort(row.preferred_effort) });
  if (row.is_session) return readSessionDefault(db);
  if (row.model !== null) return withEffortLevels(db, { model: row.model, effort: toEffort(row.effort) });

  const favorite = await db.query<{ model_id: string }>(
    'SELECT model_id FROM model_profiles WHERE favorited_at IS NOT NULL AND hidden_at IS NULL ORDER BY favorited_at, model_id LIMIT 1',
  );
  return withEffortLevels(db, { model: favorite.rows[0]?.model_id ?? null, effort: null });
}

/** Escolha resolvida de um bot (a conversa única dele). Lança BOT_NOT_FOUND. Para quem só conhece o bot (ex.: "Executar agora" de uma rotina). */
export async function resolveBotModelChoice(db: Queryable, botId: string): Promise<ModelChoiceView> {
  const conversation = await db.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [botId]);
  const id = conversation.rows[0]?.id;
  if (id === undefined) throw new DomainError('BOT_NOT_FOUND');
  return resolveModelChoice(db, id);
}

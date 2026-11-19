// Fonte de preferências e resolução por conversa. Rotinas passam pela conversa única do bot.
import { DEFAULT_CONTEXT_WINDOW, resolveContextWindow, type ContextPreferences, type ContextWindowResolution, type ContextWindowTokens } from '@aion/shared';
import type { Queryable } from '../db/pool';
import { DomainError } from '../errors';
import { readModelContextCapacity } from '../models/context-capacity';
import { resolveModelChoice } from './model-choice';

/** Globais independentes; não carrega idioma, nome ou outros dados do dono para resolver orçamento. */
export async function readContextPreferences(db: Queryable): Promise<ContextPreferences> {
  const found = await db.query<{ bot_context_window_tokens: ContextWindowTokens; general_chat_context_window_tokens: ContextWindowTokens }>(
    'SELECT bot_context_window_tokens, general_chat_context_window_tokens FROM app_settings');
  return { bots: found.rows[0]?.bot_context_window_tokens ?? DEFAULT_CONTEXT_WINDOW, generalChat: found.rows[0]?.general_chat_context_window_tokens ?? DEFAULT_CONTEXT_WINDOW };
}

/** Relê preferência, herança e escolha efetiva em cada preparação; preserva a precedência de modelo existente. */
export async function resolveConversationContextWindow(db: Queryable, conversationId: string): Promise<ContextWindowResolution> {
  const found = await db.query<{ bot_id: string | null; context_window_tokens: ContextWindowTokens | null }>(
    'SELECT c.bot_id, b.context_window_tokens FROM conversations c LEFT JOIN bots b ON b.id = c.bot_id WHERE c.id = $1', [conversationId]);
  const row = found.rows[0];
  if (!row) throw new DomainError('NOT_FOUND');
  const preferences = await readContextPreferences(db);
  const choice = await resolveModelChoice(db, conversationId);
  const override = row.bot_id === null ? null : row.context_window_tokens;
  return resolveContextWindow(override ?? (row.bot_id === null ? preferences.generalChat : preferences.bots), override === null ? 'global' : 'bot', choice.model, readModelContextCapacity(choice.model));
}

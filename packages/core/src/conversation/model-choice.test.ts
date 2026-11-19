// Prova com PostgreSQL real da precedência, dos níveis conhecidos e da persistência de effort em bot e sessão.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createRunsWorld, ORIGIN, type RunsWorld } from '../runs/test-support';
import { resolveModelChoice } from './model-choice';

let world: RunsWorld;
beforeAll(async () => { world = await createRunsWorld(); });
afterAll(async () => { await world.cleanup(); });

it('A7: o favorito de reserva de um bot sem modelo pula o oculto, e a escolha que o dono já fez (padrão do bot, preferência da conversa) vale mesmo oculta', async () => {
  const { models, pool, conversations } = world;
  await models.setFavorite('opencode/glm-5.1', true);
  await pool.query("UPDATE model_profiles SET favorited_at = now() + interval '1 minute' WHERE model_id = 'opencode/glm-5.1'"); // o outro é o "primeiro" favorito
  await models.setFavorite('opencode/kimi-k2.7-code', true);
  await pool.query("UPDATE model_profiles SET favorited_at = now() WHERE model_id = 'opencode/kimi-k2.7-code'");
  try {
    const bot = await world.createBot({ model: null });
    const conversation = (await pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [bot.id])).rows[0]!.id;
    expect((await resolveModelChoice(pool, conversation)).model).toBe('opencode/kimi-k2.7-code');
    await models.setHidden('opencode/kimi-k2.7-code', true);
    expect((await resolveModelChoice(pool, conversation)).model).toBe('opencode/glm-5.1'); // pulou o oculto
    await models.setHidden('opencode/glm-5.1', true);
    expect((await resolveModelChoice(pool, conversation)).model).toBeNull(); // sem favorito visível não há reserva
    // O que o dono escolheu antes continua valendo e roda, mesmo oculto (A9).
    expect((await conversations.setPreference(bot.id, 'opencode/kimi-k2.7-code', null)).model).toBe('opencode/kimi-k2.7-code');
    const own = await world.createBot({ model: 'opencode/glm-5.1' });
    expect((await conversations.snapshot(own.id)).model.model).toBe('opencode/glm-5.1');
    await models.setHidden('opencode/kimi-k2.7-code', false);
    await models.setHidden('opencode/glm-5.1', false);
    expect((await resolveModelChoice(pool, (await pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [(await world.createBot({ model: null })).id])).rows[0]!.id)).model).toBe('opencode/kimi-k2.7-code');
  } finally {
    await pool.query('DELETE FROM model_profiles WHERE model_id IN ($1, $2)', ['opencode/glm-5.1', 'opencode/kimi-k2.7-code']);
  }
});

it('resolve os níveis do modelo efetivo, persiste só o effort e normaliza níveis retirados pelo reteste', async () => {
  const { models, pool, conversations } = world;
  await models.test('opencode/glm-5.1');
  const bot = await world.createBot({ effort: 'high' });
  const botConversation = (await pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [bot.id])).rows[0]!.id;
  expect(await resolveModelChoice(pool, botConversation)).toEqual({ model: 'opencode/glm-5.1', effort: 'high', effortLevels: ['low', 'medium', 'high'] });
  expect(await conversations.setPreference(bot.id, 'opencode/glm-5.1', 'low')).toEqual({ model: 'opencode/glm-5.1', effort: 'low', effortLevels: ['low', 'medium', 'high'] });
  expect((await world.bots.get(bot.id)).effort).toBe('high');

  await conversations.setSessionDefault('opencode/glm-5.1', 'medium', ORIGIN);
  const session = (await pool.query<{ id: string }>('INSERT INTO conversations (created_at) VALUES (now()) RETURNING id')).rows[0]!.id;
  expect((await resolveModelChoice(pool, session)).effort).toBe('medium');
  await conversations.setPreference({ sessionId: session }, 'opencode/glm-5.1', 'high');
  expect((await resolveModelChoice(pool, session)).effort).toBe('high');
  expect((await conversations.sessionDefault()).effort).toBe('medium');

  await pool.query('UPDATE model_profiles SET effort_levels = $2 WHERE model_id = $1', ['opencode/glm-5.1', ['low']]);
  expect(await resolveModelChoice(pool, session)).toEqual({ model: 'opencode/glm-5.1', effort: null, effortLevels: ['low'] });
  await expect(conversations.setPreference({ sessionId: session }, 'opencode/glm-5.1', 'high')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  await conversations.setPreference(bot.id, 'opencode/glm-5.3-flash', null);
  expect(await resolveModelChoice(pool, botConversation)).toEqual({ model: 'opencode/glm-5.3-flash', effort: null, effortLevels: [] });
});

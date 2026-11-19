// Jornada de configuração/resolução contra PostgreSQL real; nenhum teste chama o provedor real.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { resolveContextWindow } from '@aion/shared';
import { SettingsService } from '../settings/service';
import { readModelContextCapacity } from '../models/context-capacity';
import { createRunsWorld, ORIGIN, type RunsWorld } from '../runs/test-support';
import { resolveConversationContextWindow } from './context-window';
import { contextPreferencesMigration } from '../db/migrations/0033_context_preferences';
import { contextDefault64kMigration } from '../db/migrations/0040_context_default_64k';
import { contextWindow256kMigration } from '../db/migrations/0043_context_window_256k';
import { contextWindow512kMigration } from '../db/migrations/0046_context_window_512k';

let world: RunsWorld;
// 'product': este arquivo prova o padrão REAL do banco (256k, migration 0046); os demais mundos de teste partem de 64k.
beforeAll(async () => { world = await createRunsWorld({ contextWindow: 'product' }); });
afterAll(async () => { await world.cleanup(); });

it('persiste os presets independentes, override anulável e relê modelo/preferência sem apagar escolhas', async () => {
  const settings = new SettingsService({ pool: world.pool });
  // Padrão do dono: 256k nos dois escopos (migration 0046, decisão de 17/10/2026). A escolha abaixo foge dele para o persistir ser observável.
  expect(await settings.readContextPreferences()).toEqual({ bots: 262144, generalChat: 262144, summaryModel: null }); // o modelo do resumo (0041) nasce vazio: usa o da conversa
  await Promise.all([settings.updateContextPreference({ scope: 'bots', windowTokens: 65536 }, ORIGIN), settings.updateContextPreference({ scope: 'general_chat', windowTokens: 131072 }, ORIGIN)]);
  expect(await settings.readContextPreferences()).toEqual({ bots: 65536, generalChat: 131072, summaryModel: null });
  expect(await settings.read()).toMatchObject({ language: 'pt-BR', timeZone: 'America/Sao_Paulo', ownerName: '' });
  const bot = await world.createBot({ contextWindowTokens: null });
  const conversation = (await world.pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [bot.id])).rows[0]!.id;
  // Modelo sem capacidade confirmada: a janela efetiva é a escolhida pelo dono (64k aqui), sem teto provisório.
  const unconfirmed = await resolveConversationContextWindow(world.pool, conversation);
  expect(unconfirmed).toMatchObject({ preferredTokens: 65536, effectiveTokens: 65536, origin: 'global', capacity: null });
  expect(unconfirmed).not.toHaveProperty('provisional');
  await world.bots.update(bot.id, { contextWindowTokens: 131072 }, ORIGIN);
  expect(await resolveConversationContextWindow(world.pool, conversation)).toMatchObject({ preferredTokens: 131072, origin: 'bot' });
  // Sem sonda real: identidade conhecida sem alterar a precedência do composer.
  await world.pool.query('UPDATE conversations SET preferred_model = $2 WHERE id = $1', [conversation, 'opencode/deepseek-v4.1-flash']);
  expect(await resolveConversationContextWindow(world.pool, conversation)).toMatchObject({ preferredTokens: 131072, effectiveTokens: 131072, model: 'opencode/deepseek-v4.1-flash' });
  expect((await world.bots.get(bot.id)).contextModel).toMatchObject({ model: 'opencode/deepseek-v4.1-flash', fromConversation: true });
  await world.bots.update(bot.id, { contextWindowTokens: null }, ORIGIN);
  expect(await resolveConversationContextWindow(world.pool, conversation)).toMatchObject({ preferredTokens: 65536, origin: 'global' });
  const session = (await world.pool.query<{ id: string }>('INSERT INTO conversations (created_at) VALUES (now()) RETURNING id')).rows[0]!.id;
  expect(await resolveConversationContextWindow(world.pool, session)).toMatchObject({ preferredTokens: 131072, effectiveTokens: null, model: null });
  await world.pool.query('UPDATE conversations SET preferred_model = $2 WHERE id = $1', [session, 'opencode/deepseek-v4.1-flash']);
  expect(await resolveConversationContextWindow(world.pool, session)).toMatchObject({ preferredTokens: 131072, effectiveTokens: 131072, origin: 'global' });
  for (const windowTokens of [65536, 131072, 262144, 524288] as const) {
    await settings.updateContextPreference({ scope: 'bots', windowTokens }, ORIGIN);
    expect((await resolveConversationContextWindow(world.pool, conversation)).preferredTokens).toBe(windowTokens);
  }
});

it('o serviço recusa 32k (e qualquer valor fora das quatro opções) com VALIDATION_FAILED e não grava nada nem audita', async () => {
  const settings = new SettingsService({ pool: world.pool });
  await settings.updateContextPreference({ scope: 'general_chat', windowTokens: 524288 }, ORIGIN);
  const before = await settings.readContextPreferences();
  const audits = async () => Number((await world.pool.query("SELECT count(*) AS total FROM audit_log WHERE action = 'settings.context'")).rows[0]!.total);
  const auditsBefore = await audits();
  for (const windowTokens of [32768, 32000, 262145, 1048576, 0, -1, 131072.5, '262144', null]) {
    for (const scope of ['bots', 'general_chat'] as const) {
      await expect(settings.updateContextPreference({ scope, windowTokens } as never, ORIGIN), `${scope} ${String(windowTokens)}`).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  }
  expect(await settings.readContextPreferences()).toEqual(before);
  expect(await audits()).toBe(auditsBefore);
  // O banco é a segunda barreira: mesmo um SQL direto não grava 32k nem um valor fora da lista.
  await expect(world.pool.query('UPDATE app_settings SET bot_context_window_tokens = 32768')).rejects.toThrow(/bot_context_window_tokens/);
  await expect(world.pool.query('UPDATE bots SET context_window_tokens = 32768')).rejects.toThrow(/context_window_tokens/);
});

it('um bot aceita 512k como override e o banco, segunda barreira da borda (schema da rota), recusa 32k na criação e na edição sem alterar o que estava gravado', async () => {
  const bot = await world.createBot({ contextWindowTokens: 524288 });
  expect((await world.bots.get(bot.id)).contextWindowTokens).toBe(524288);
  // A allowlist da borda (botCreateSchema/botUpdateSchema) é provada em shared/bots.test.ts e no E2E; aqui o serviço, que confia no schema, bate no CHECK do banco.
  await expect(world.bots.update(bot.id, { contextWindowTokens: 32768 as never }, ORIGIN)).rejects.toThrow(/context_window_tokens/);
  expect((await world.bots.get(bot.id)).contextWindowTokens).toBe(524288);
  await expect(world.createBot({ contextWindowTokens: 32768 as never })).rejects.toThrow(/context_window_tokens/);
});

it('capacidade menor limita sem perder preferência e o registro não extrapola a outras identidades', () => {
  const known = readModelContextCapacity('opencode/deepseek-v4.1-flash')!;
  expect(resolveContextWindow(131072, 'bot', known.model, { ...known, contextTokens: 16000 })).toMatchObject({ preferredTokens: 131072, effectiveTokens: 16000 });
  expect(readModelContextCapacity(known.model, 'outro_provedor')).toBeNull();
  expect(readModelContextCapacity('deepseek-v4.1')).toBeNull();
  // Capacidade de outra identidade não vale para o modelo: sem teto confirmado, vale a escolha do dono em cada preset.
  for (const preferred of [65536, 131072, 262144, 524288] as const) {
    expect(resolveContextWindow(preferred, 'global', 'outro', known)).toMatchObject({ capacity: null, effectiveTokens: preferred });
    expect(resolveContextWindow(preferred, 'global', 'outro', null)).toMatchObject({ capacity: null, effectiveTokens: preferred });
  }
});

it('o MiMo V2.6 Pro está registrado (1M de contexto, 131k de saída, fonte e data) e limita só a si mesmo', () => {
  const mimo = readModelContextCapacity('opencode/mimo-v2.6-pro')!;
  expect(mimo).toMatchObject({ provider: 'opencode_go', model: 'opencode/mimo-v2.6-pro', contextTokens: 1000000, outputTokens: 131072, source: 'https://opencode.ai/data/xiaomi/mimo-v2-6-pro', checkedAt: '2026-10-17T00:00:00.000Z' });
  expect(readModelContextCapacity('opencode/mimo-v2.6-pro', 'outro_provedor')).toBeNull();
  expect(readModelContextCapacity('mimo-v2.6')).toBeNull();
  // Nenhuma das quatro opções passa de 1M: com o MiMo vale a escolhida; uma capacidade confirmada menor (simulada) limita sem apagar a preferência.
  for (const preferred of [65536, 131072, 262144, 524288] as const) {
    expect(resolveContextWindow(preferred, 'bot', mimo.model, mimo)).toMatchObject({ preferredTokens: preferred, effectiveTokens: preferred, capacity: mimo });
  }
  expect(resolveContextWindow(524288, 'bot', mimo.model, { ...mimo, contextTokens: 200000 })).toMatchObject({ preferredTokens: 524288, effectiveTokens: 200000 });
  // O registro devolve cópias: quem lê não consegue alterar o limite dos próximos.
  mimo.contextTokens = 1;
  expect(readModelContextCapacity('opencode/mimo-v2.6-pro')!.contextTokens).toBe(1000000);
});

it('a janela da conversa com o MiMo vem do registro: a escolhida do bot, limitada pela capacidade confirmada do modelo exato', async () => {
  const bot = await world.createBot({ contextWindowTokens: 524288 });
  const conversation = (await world.pool.query<{ id: string }>('SELECT id FROM conversations WHERE bot_id = $1', [bot.id])).rows[0]!.id;
  await world.pool.query('UPDATE conversations SET preferred_model = $2 WHERE id = $1', [conversation, 'opencode/mimo-v2.6-pro']);
  expect(await resolveConversationContextWindow(world.pool, conversation)).toMatchObject({ preferredTokens: 524288, effectiveTokens: 524288, origin: 'bot', model: 'opencode/mimo-v2.6-pro', capacity: { contextTokens: 1000000, outputTokens: 131072 } });
  // Modelo sem capacidade confirmada na mesma conversa: vale a escolhida, sem teto provisório e sem capacidade.
  await world.pool.query('UPDATE conversations SET preferred_model = $2 WHERE id = $1', [conversation, 'opencode/glm-5.1']);
  expect(await resolveConversationContextWindow(world.pool, conversation)).toMatchObject({ preferredTokens: 524288, effectiveTokens: 524288, capacity: null });
});

it('migration preserva dados antigos e recusa rollback destrutivo das escolhas', async () => {
  const before = await world.pool.query('SELECT id, name, model, instructions FROM bots ORDER BY id');
  await expect(world.pool.query(contextPreferencesMigration.rollback)).rejects.toThrow('Preserve preferências');
  expect((await world.pool.query('SELECT id, name, model, instructions FROM bots ORDER BY id')).rows).toEqual(before.rows);
  // Estado de quem nunca mexeu nas preferências (256k, o padrão atual): a cadeia desfaz na ordem inversa, 0046 e 0043 (voltam ao padrão da 0040), 0040 (volta ao
  // padrão antigo) e depois 0033, e sobe de novo na ordem. Os globais voltam a 64k antes da 0040 porque o rollback da 0046 devolve 128k ao dos bots, que a guarda da
  // 0033 trata como escolha do dono.
  await world.pool.query('UPDATE app_settings SET bot_context_window_tokens = 262144, general_chat_context_window_tokens = 262144');
  await world.pool.query('UPDATE bots SET context_window_tokens = NULL');
  await world.pool.query(contextWindow512kMigration.rollback);
  await world.pool.query(contextWindow256kMigration.rollback);
  await world.pool.query('UPDATE app_settings SET bot_context_window_tokens = 65536, general_chat_context_window_tokens = 65536');
  await world.pool.query(contextDefault64kMigration.rollback);
  await world.pool.query(contextPreferencesMigration.rollback);
  await world.pool.query(contextPreferencesMigration.up);
  await world.pool.query(contextDefault64kMigration.up);
  await world.pool.query(contextWindow256kMigration.up);
  await world.pool.query(contextWindow512kMigration.up);
  expect((await world.pool.query('SELECT id, name, model, instructions FROM bots ORDER BY id')).rows).toEqual(before.rows);
  expect(await new SettingsService({ pool: world.pool }).readContextPreferences()).toEqual({ bots: 262144, generalChat: 262144, summaryModel: null });
});

// Calibração do orçamento pelo usage real: a chamada grava a estimativa do corpo enviado e as próximas preparações a escalam pela razão observada.
// `calibrated` (existe amostra válida) é separado de `scale` (o fator): o executor decide o piso obrigatório pelo primeiro, não por `scale < 1`.
import { describe, expect, it, vi } from 'vitest';
import { createRunsWorld } from './test-support';
import { readContextAnchor } from './context-anchor';
import { MIN_PLAUSIBLE_RATIO, isPlausibleUsage, readTokenCalibration } from './token-calibration';

describe('regra única de plausibilidade do usage', () => {
  it('aceita a partir da razão mínima, recusa abaixo dela e não aceita sem estimativa de referência', () => {
    expect(isPlausibleUsage(120, 1000)).toBe(true);
    expect(isPlausibleUsage(119, 1000)).toBe(false);
    expect(isPlausibleUsage(5, 6000)).toBe(false);
    expect(isPlausibleUsage(6000, 6000)).toBe(true);
    expect(isPlausibleUsage(500, 0)).toBe(false);
    expect(MIN_PLAUSIBLE_RATIO).toBe(0.12);
  });
});

describe('calibração de tokens pelo usage informado', () => {
  it('grava a estimativa por chamada, calcula a escala conservadora e ignora amostras sem usage', async () => {
    const world = await createRunsWorld();
    try {
      const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
      let reportedInput = 0;
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* () {
        yield { type: 'text', text: 'Pronto' };
        // Usage relatado pelo provedor, proporcional ao pedido: aqui um terço da estimativa local por bytes.
        yield { type: 'usage', usage: { inputTokens: reportedInput, outputTokens: 3, cachedTokens: 0 } };
        yield { type: 'done', reason: 'stop' };
      });
      const calibration = (model: string) => readTokenCalibration(world.pool, model);
      expect(await calibration('opencode/glm-5.1')).toEqual({ scale: 1, calibrated: false });
      world.engine.start();
      // Primeira chamada sem usage de entrada: amostra inválida, escala continua 1 e o modelo segue sem calibração.
      reportedInput = 0;
      const first = await world.send(bot, 'Primeira'); await world.waitForStatus(first, 'completed');
      await world.pool.query('UPDATE model_call_usage SET input_tokens = NULL');
      expect(await calibration('opencode/glm-5.1')).toEqual({ scale: 1, calibrated: false });
      const estimate = Number((await world.pool.query<{ e: string }>('SELECT estimated_input_tokens AS e FROM model_call_usage ORDER BY created_at LIMIT 1')).rows[0]!.e);
      expect(estimate).toBeGreaterThan(0);
      // Usage implausível (1/100 da estimativa, como um valor fixo) é descartado em vez de encolher o orçamento.
      await world.pool.query('UPDATE model_call_usage SET input_tokens = $1', [Math.round(estimate / 100)]);
      expect(await calibration('opencode/glm-5.1')).toEqual({ scale: 1, calibrated: false });
      // A âncora da ocupação lê o MESMO registro com a mesma regra de plausibilidade: o que não calibra também não ancora. E a medição regravada ao fim da
      // chamada (`isPlausibleUsage`) decide igual a elas para esse mesmo par usage/estimativa.
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      expect(await readContextAnchor(world.pool, conversationId, 'opencode/glm-5.1')).toBeNull();
      expect(isPlausibleUsage(Math.round(estimate / 100), estimate)).toBe(false);
      // Amostra válida: razão 1/3 com folga de 20% vira escala 0,4; outro modelo não herda a calibração.
      expect(isPlausibleUsage(Math.round(estimate / 3), estimate)).toBe(true);
      await world.pool.query('UPDATE model_call_usage SET input_tokens = $1', [Math.round(estimate / 3)]);
      const calibrated = await calibration('opencode/glm-5.1');
      expect(calibrated.scale).toBeCloseTo(0.4, 2);
      expect(calibrated.calibrated).toBe(true);
      expect(await calibration('opencode/kimi-k2.7-code')).toEqual({ scale: 1, calibrated: false });
      // Mesma amostra, agora também a âncora do modelo (e só dele): usage real e estimativa crua gravada da mesma chamada.
      expect(await readContextAnchor(world.pool, conversationId, 'opencode/glm-5.1')).toEqual({ inputTokens: Math.round(estimate / 3), estimatedTokens: estimate });
      expect(await readContextAnchor(world.pool, conversationId, 'opencode/kimi-k2.7-code')).toBeNull();
      // A maior razão da amostra prevalece (conservador) e a escala nunca passa de 1, mas a amostra continua valendo: texto denso em tokens (razão x 1,2 >= 1)
      // deixa a escala em 1 e o modelo CALIBRADO, então o teto por bytes é medida real e não pode ser tratado como "ainda sem calibração".
      await world.pool.query('UPDATE model_call_usage SET input_tokens = $1', [estimate * 2]);
      expect(await calibration('opencode/glm-5.1')).toEqual({ scale: 1, calibrated: true });
    } finally { await world.cleanup(); }
  });
});

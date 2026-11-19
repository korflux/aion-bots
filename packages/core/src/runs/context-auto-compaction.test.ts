// Gatilho único da compactação automática (phase 9, CTX-07) e o aviso discreto do indicador: o pedido segue como foi gravado até a ocupação (a do indicador, entrada
// estimada ÷ orçamento de entrada) chegar a 90%; aí UMA compactação troca o histórico antigo por um checkpoint antes da chamada, no bot e no Chat geral, sem mensagem,
// cartão nem push. Não há mais elisão por etapa nem resumo a 85%: nenhum resultado vira referência, e o aviso só diz "resumo" (e "índice", se o colapso entrar).
// O motor, o PostgreSQL e o provedor falso são os reais; o histórico cresce em linhas gravadas e o modelo só responde texto.
import { describe, expect, it, vi } from 'vitest';
import type { ChatEvent, ChatRequest } from '../models/chat-protocols';
import { GeneralChatService } from '../general-chat/service';
import { COLD_COMPACTION_SHARE, COLD_OPENING_TOKENS, COLD_TRIGGER_TOKENS } from './cold-maintenance';
import { COMPACTION_SETTLE, COMPACTION_THRESHOLD, MAX_OUTPUT_TOKENS, TAIL_SHARE, contextEnvelope, estimateChatPayload } from './context-budget';
import { SUMMARY_SECTIONS } from './compaction';
import { createRunsWorld, type RunsWorld } from './test-support';

/** Janela fixada pelo teste (não depende do padrão do produto; 64k é a menor opção desde a phase 11): 65536 - saída 16384 (25% da janela, phase 12) - margem 2048 = 47.104. */
const WINDOW = 65536;
const BUDGET = contextEnvelope(WINDOW, MAX_OUTPUT_TOKENS).inputBudget;
const RESULT_CHARS = 600;

const estimated = (request: ChatRequest): number => estimateChatPayload(request, 'chat_completions').estimatedInputTokens;
const hasReferences = (request: ChatRequest): boolean => JSON.stringify(request.turns).includes('aionActivityReference');
const hasSummary = (request: ChatRequest): boolean => JSON.stringify(request.turns).includes('# Resumo derivado');
const isSummary = (request: ChatRequest): boolean => request.turns[0]?.role === 'system' && request.turns[0].text.startsWith('Você produz o checkpoint do histórico');
const checkpoint = SUMMARY_SECTIONS.map((title, index) => `## ${title}\n${index === 0 ? 'Checkpoint do histórico antigo; ids preservados.' : 'Nada.'}`).join('\n\n');

/** Acrescenta ao histórico, na rodada já concluída, uma linha que a mensagem seguinte encontrará em rodada anterior (resultado de ferramenta ou texto do bot). */
async function addRow(world: RunsWorld, conversationId: string, runId: string, step: number, kind: 'result' | 'text'): Promise<void> {
  const activity = kind === 'result';
  await world.pool.query(
    `INSERT INTO messages(conversation_id,run_id,role,kind,status,opens_round,step,content,data,tool_arguments,evidence_provenance,created_at)
     VALUES($1,$2,'assistant',$3,$4,false,$5,$6,$7,'{}','{"attachments":[],"tables":[]}',now())`,
    [conversationId, runId, activity ? 'activity' : 'text', activity ? 'completed' : 'done', step, `${kind} ${step} `.padEnd(RESULT_CHARS, 'x'),
      JSON.stringify(activity ? { callId: `synthetic-${step}`, tool: 'schema_search', label: 'Buscar esquemas', arguments: '{}', detail: null } : {})],
  );
}

describe('limiar único de compactação', () => {
  it('é 90% do orçamento de entrada, com trecho final menor e acomodação abaixo do limiar (valores aprovados pelo dono, mudar exige pedir antes)', () => {
    expect(COMPACTION_THRESHOLD).toBe(0.9);
    expect(TAIL_SHARE).toBe(0.25);
    expect(COMPACTION_SETTLE).toBeGreaterThan(TAIL_SHARE);
    expect(COMPACTION_SETTLE).toBeLessThan(COMPACTION_THRESHOLD);
  });
});

describe('limiar da compactação fria (phase 11, T8; phase 15, passo 8a)', () => {
  it('o teto é 50% do orçamento de entrada, abaixo do ponto de acomodação e do gatilho de sempre, que continua como rede de segurança durante a conversa; o gatilho absoluto de 40 mil tokens e a abertura de 30 mil são a decisão 2 e 13 da phase 15 (valores do dono, mudar exige pedir antes)', () => {
    expect(COLD_COMPACTION_SHARE).toBe(0.5);
    expect(COLD_COMPACTION_SHARE).toBeLessThan(COMPACTION_SETTLE);
    expect(COLD_COMPACTION_SHARE).toBeLessThan(COMPACTION_THRESHOLD);
    expect(COMPACTION_THRESHOLD).toBe(0.9);
    expect(COLD_TRIGGER_TOKENS).toBe(40_000);
    expect(COLD_OPENING_TOKENS).toBe(30_000);
    expect(COLD_OPENING_TOKENS).toBeLessThan(COLD_TRIGGER_TOKENS);
  });
});

describe.each(['bot', 'chat'] as const)('compactação automática (%s)', (kind) => {
  it('abaixo de 90% o pedido é o histórico inteiro, sem resumo nem referência; ao chegar a 90% a compactação roda UMA vez antes da chamada, sem mensagem, cartão nem push, e o indicador recebe o aviso', async () => {
    const world = await createRunsWorld({ contextWindow: WINDOW });
    try {
      await world.models.test('opencode/glm-5.1');
      const bot = await world.createBot();
      const ref = kind === 'bot' ? bot.id : { sessionId: (await new GeneralChatService({ pool: world.pool }).create()).id };
      if (kind === 'chat') await world.conversations.setPreference(ref, 'opencode/glm-5.1', null);
      const requests: ChatRequest[] = [], summaries: ChatRequest[] = [];
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request): AsyncGenerator<ChatEvent> {
        (isSummary(request) ? summaries : requests).push(request);
        yield { type: 'text', text: isSummary(request) ? checkpoint : 'Ok.' };
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 5 } };
        yield { type: 'done', reason: 'stop' };
      });
      world.engine.start();
      const first = (await world.conversations.send(ref, 'Início da conversa.')).id;
      await world.waitForStatus(first, 'completed');
      const conversationId = await world.conversations.conversationIdOf(ref);
      let step = 100, inserted = 0;
      /** Um passo do cenário: cresce o histórico, envia uma mensagem comum e devolve o que o modelo recebeu e o aviso gravado na medição. */
      const iterate = async (rowKind: 'result' | 'text') => {
        for (let index = 0; index < 2; index++) { await addRow(world, conversationId, first, step++, rowKind); inserted += 1; }
        const summariesBefore = summaries.length;
        const run = (await world.conversations.send(ref, `Mensagem ${step}.`)).id;
        await world.waitForStatus(run, 'completed');
        const request = requests.at(-1)!;
        const state = await world.conversations.contextState(ref);
        return { request, estimate: estimated(request), summarized: summaries.length > summariesBefore, compaction: state.measurement!.compaction };
      };
      /**
       * Crescimento de uma iteração DE TEXTO (duas linhas, mensagem, resposta e molduras): margem para provar que o gatilho não dispara cedo demais. Medido: cerca de 1.600 tokens (2 x 600 + 400), abaixo
       * de 2 x 600 + 600 = 1.800. A iteração com duas linhas de resultado de ferramenta cresce mais (cerca de 1.975, pela moldura da chamada e do resultado) e passaria dessa margem, então ela só entra nas
       * primeiras iterações (`kindOf`), longe do limiar; a aproximação dos 90% é só de texto, e o cruzamento cai sempre numa iteração de texto, qualquer que seja o tamanho do piso do pedido (turno de
       * sistema e ferramentas): o pedido anterior está a, no máximo, 1.600 do limiar, dentro da margem. Antes a fase do cruzamento dependia do piso, e uma linha nova no guia a deslocou para uma
       * iteração de resultado (1.975 abaixo do limiar, 30 tokens além da margem).
       */
      const growth = 2 * RESULT_CHARS + 600;
      /** Resultados de ferramenta e texto alternam nas primeiras iterações (o histórico mistura os dois e nenhum vira referência); dali até o limiar, só texto. */
      const MIXED_ITERATIONS = 6;
      const kindOf = (index: number): 'result' | 'text' => (index < MIXED_ITERATIONS && index % 2 === 1 ? 'result' : 'text');

      // O histórico (resultados de ferramenta e texto, alternados no começo) cresce sem mudar de forma até o pedido completo chegar a 90%.
      let previous = await iterate('result'), compacted: Awaited<ReturnType<typeof iterate>> | null = null;
      expect(previous.compaction).toEqual({ elision: false, summary: false, index: false });
      for (let index = 0; index < 60 && compacted === null; index++) {
        const current = await iterate(kindOf(index));
        if (current.summarized) compacted = current;
        else {
          // Pedido sem compactação é o pedido completo: abaixo do limiar, sem resumo, sem referência e com todas as linhas inseridas.
          expect(current.estimate).toBeLessThan(COMPACTION_THRESHOLD * BUDGET);
          expect(hasSummary(current.request)).toBe(false);
          expect(hasReferences(current.request)).toBe(false);
          expect(current.compaction).toEqual({ elision: false, summary: false, index: false });
          previous = current;
        }
      }
      expect(compacted).not.toBeNull();
      // Disparou ao cruzar 90%, não antes: o pedido completo anterior estava a uma iteração do limiar.
      expect(previous.estimate).toBeGreaterThan(COMPACTION_THRESHOLD * BUDGET - growth);
      expect(summaries).toHaveLength(1);
      expect(estimated(summaries[0]!)).toBeLessThanOrEqual(BUDGET);
      expect(hasSummary(compacted!.request)).toBe(true);
      expect(hasReferences(compacted!.request)).toBe(false);
      expect(compacted!.estimate).toBeLessThan(COMPACTION_THRESHOLD * BUDGET);
      expect(compacted!.compaction).toEqual({ elision: false, summary: true, index: false });

      // R6: o aviso é da compactação feita para ESTE pedido. O checkpoint segue no pedido seguinte, mas não foi feito para ele: sem nova compactação, não acende.
      const following = await iterate('text');
      expect(following.summarized).toBe(false);
      expect(hasSummary(following.request)).toBe(true);
      expect(following.compaction).toEqual({ elision: false, summary: false, index: false });

      // O aviso é só o estado do indicador: nenhuma mensagem de compactação, cartão ou notificação foi criado, e os originais seguem no banco.
      expect((await world.pool.query("SELECT count(*) AS total FROM messages WHERE kind='card'")).rows[0]!.total).toBe('0');
      expect((await world.pool.query("SELECT DISTINCT kind FROM push_events")).rows.every((row) => row.kind === 'run_completed')).toBe(true);
      expect((await world.pool.query("SELECT count(*) AS total, min(length(content)) AS shortest FROM messages WHERE kind IN ('activity','text') AND content ~ '^(result|text) [0-9]+ '")).rows[0]).toEqual({ total: String(inserted), shortest: RESULT_CHARS });
      expect((await world.pool.query("SELECT count(*) AS total FROM runs WHERE failure_code IS NOT NULL")).rows[0]!.total).toBe('0');
    } finally { await world.cleanup(); }
  }, 180_000);
});

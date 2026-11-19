// Estado público do contexto (phase 9). (1) Medição do indicador depois da resposta (F1 passo 4, A2): a medição gravada na preparação é do pedido antes da
// resposta, e a própria resposta muda a revisão. `settleMeasurementAfterResponse` fecha a medição com a entrada real do provedor sem marcar "Desatualizado" por causa da resposta;
// conteúdo que chega depois volta a marcar. O usage só vira medição se for plausível (a regra da âncora) e uma falha de banco ao fechar a medição não derruba a
// execução que já respondeu. (2) Elegibilidade de "Compactar agora" (F6 passo 2): desabilitado com motivo quando não há histórico a cobrir, pela mesma regra de corte
// da compactação. (3) Ocupação sobre a janela vigente (T11, A16): trocar a janela, global ou do bot, recalcula o orçamento da última medição sem chamar o modelo e sem
// marcar "Desatualizado"; qualquer outra mudança junto (mensagem, instruções) mantém a marca. (4) Reserva de saída (phase 12, A3): a reserva é função da janela (25% dela, até 32.768) e
// entra na revisão, então a medição gravada com a reserva antiga fica desatualizada, mostra o orçamento novo e é refeita na próxima preparação. O motor, o PostgreSQL e o provedor falso são os reais.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logging';
import type { ChatEvent, ChatRequest } from '../models/chat-protocols';
import { estimateChatPayload } from '../runs/context-budget';
import { ORIGIN, createRunsWorld } from '../runs/test-support';
import { loadManagedContext } from '../runs/context-checkpoint';
import { hasHistoryToCover, NO_HISTORY_TO_COVER_REASON, readContextRevision, settleMeasurementAfterResponse } from './context-state';
import { recordConversationEvent } from './events';
import { summarizeBlocker } from './run-queue';

/**
 * Teto base de saída que o envelope recebe, trocável só pelo teste da reserva antiga (A3): nulo deixa passar o valor do produto (motor e estado de contexto); 8.192 simula o teto de
 * antes da phase 12 para gravar uma medição "de antes do deploy" sem reescrever à mão a conta da reserva. Hoisted porque o `vi.mock` roda antes dos imports.
 */
const envelopeBase = vi.hoisted(() => ({ maxTokens: null as number | null }));
vi.mock('../runs/context-budget', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runs/context-budget')>();
  return { ...actual, contextEnvelope: (window: number, maxTokens: number, outputCapacity: number | null = null) => actual.contextEnvelope(window, envelopeBase.maxTokens ?? maxTokens, outputCapacity) };
});
afterEach(() => { envelopeBase.maxTokens = null; });

/** Janela fixada pelo teste (não depende do padrão do produto). 64k é a menor opção desde a phase 11 (32k saiu). */
const WINDOW = 65536;
/** Estimativa crua do que o provedor recebeu (a mesma função e o mesmo protocolo do motor), base de um usage plausível nos testes. */
const rawOf = (request: ChatRequest) => estimateChatPayload(request, 'chat_completions').textTokens;

describe('medição do contexto depois da resposta', () => {
  it('logo após a resposta mostra a entrada real e não está desatualizada; uma mensagem nova depois marca desatualizada', async () => {
    const world = await createRunsWorld({ contextWindow: WINDOW });
    try {
      const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      let estimatedBeforeCall = 0, reported = 0;
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request): AsyncGenerator<ChatEvent> {
        estimatedBeforeCall = (await world.pool.query<{ measurement: { inputTokens: number } }>('SELECT measurement FROM conversation_context WHERE conversation_id = $1', [conversationId])).rows[0]!.measurement.inputTokens;
        // Usage realista: 30% da estimativa crua do pedido, com parte lida do cache (o cache já está dentro da entrada).
        reported = Math.round(rawOf(request) * 0.3);
        yield { type: 'text', text: 'Pronto.' };
        yield { type: 'usage', usage: { inputTokens: reported, outputTokens: 7, cachedTokens: Math.floor(reported / 2) } };
        yield { type: 'done', reason: 'stop' };
      });
      world.engine.start();
      await world.waitForStatus(await world.send(bot, 'Primeira mensagem.'), 'completed');

      // A própria resposta (mensagem do bot) mudou a revisão depois da medição da preparação; o indicador não pode acusar isso.
      const settled = (await world.conversations.contextState(bot.id)).measurement!;
      expect(estimatedBeforeCall).not.toBe(reported);
      expect(settled).toMatchObject({ inputTokens: reported, stale: false });
      expect(settled.availableTokens).toBe(settled.inputBudget - reported);
      expect(settled.excessTokens).toBe(0);

      // Mensagem nova do dono depois da medição: volta a marcar. A linha é gravada como o motor grava ao reivindicar uma execução (mesmo INSERT e evento), sem
      // execução em andamento que remedisse antes da leitura.
      const runId = (await world.pool.query<{ id: string }>('SELECT id::text FROM runs WHERE conversation_id = $1 ORDER BY id LIMIT 1', [conversationId])).rows[0]!.id;
      const message = await world.pool.query<{ id: string }>("INSERT INTO messages (conversation_id, run_id, role, kind, status, opens_round, content, created_at) VALUES ($1, $2, 'user', 'text', 'done', true, 'Segunda mensagem.', now()) RETURNING id::text", [conversationId, runId]);
      await recordConversationEvent(world.pool, conversationId, 'message', message.rows[0]!.id, new Date());
      expect((await world.conversations.contextState(bot.id)).measurement).toMatchObject({ inputTokens: reported, stale: true });
    } finally { await world.cleanup(); }
  });

  it('sem usage de entrada, mantém a estimativa da preparação e só avança a revisão', async () => {
    const world = await createRunsWorld({ contextWindow: WINDOW });
    try {
      const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      let estimatedBeforeCall = 0;
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (): AsyncGenerator<ChatEvent> {
        estimatedBeforeCall = (await world.pool.query<{ measurement: { inputTokens: number } }>('SELECT measurement FROM conversation_context WHERE conversation_id = $1', [conversationId])).rows[0]!.measurement.inputTokens;
        yield { type: 'text', text: 'Pronto.' };
        yield { type: 'done', reason: 'stop' };
      });
      world.engine.start();
      await world.waitForStatus(await world.send(bot, 'Primeira mensagem.'), 'completed');
      expect((await world.conversations.contextState(bot.id)).measurement).toMatchObject({ inputTokens: estimatedBeforeCall, stale: false });
    } finally { await world.cleanup(); }
  });

  it('usage implausível (provedor que informa só parte da entrada) não vira a medição exibida: vale a estimativa da preparação, sem "Desatualizado"', async () => {
    const world = await createRunsWorld({ contextWindow: WINDOW });
    try {
      const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      let estimatedBeforeCall = 0;
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (): AsyncGenerator<ChatEvent> {
        estimatedBeforeCall = (await world.pool.query<{ measurement: { inputTokens: number } }>('SELECT measurement FROM conversation_context WHERE conversation_id = $1', [conversationId])).rows[0]!.measurement.inputTokens;
        yield { type: 'text', text: 'Pronto.' };
        // 5 tokens para um pedido de milhares: a âncora e a calibração descartam este mesmo registro, e o indicador também.
        yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 7 } };
        yield { type: 'done', reason: 'stop' };
      });
      world.engine.start();
      await world.waitForStatus(await world.send(bot, 'Primeira mensagem.'), 'completed');
      const settled = (await world.conversations.contextState(bot.id)).measurement!;
      expect(estimatedBeforeCall).toBeGreaterThan(1000);
      expect(settled).toMatchObject({ inputTokens: estimatedBeforeCall, stale: false });
      expect(settled.availableTokens).toBe(settled.inputBudget - estimatedBeforeCall);
      // O ledger guarda o valor informado como veio, mas a medição exibida não o adota.
      const stored = await world.pool.query<{ input: string }>("SELECT input_tokens::text AS input FROM model_call_usage WHERE purpose = 'main'");
      expect(stored.rows.map((row) => row.input)).toEqual(['5']);
    } finally { await world.cleanup(); }
  });

  it('falha de banco ao fechar a medição não vira INTERNAL_ERROR: a execução que respondeu conclui, o log leva só ids e a próxima mensagem mede de novo', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'warn', name: 'context-state-test', destination: { write: (line: string) => void lines.push(line) } });
    const world = await createRunsWorld({ contextWindow: WINDOW, logger });
    try {
      const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      let armed = false;
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (_key, _protocol, request): AsyncGenerator<ChatEvent> {
        // A medição da preparação já foi gravada. A partir daqui, escrever em `measurement` falha: é a regravação do fim da chamada e nada mais (a conclusão da
        // execução só mexe em `phase`, e o gatilho só dispara quando a coluna `measurement` está no SET).
        if (!armed) {
          armed = true;
          await world.pool.query(`
            CREATE FUNCTION falha_na_medicao() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'falha simulada'; END $$;
            CREATE TRIGGER falha_na_medicao BEFORE UPDATE OF measurement ON conversation_context FOR EACH ROW EXECUTE FUNCTION falha_na_medicao();`);
        }
        yield { type: 'text', text: 'Pronto.' };
        yield { type: 'usage', usage: { inputTokens: Math.round(rawOf(request) * 0.3), outputTokens: 7 } };
        yield { type: 'done', reason: 'stop' };
      });
      world.engine.start();
      const run = await world.send(bot, 'Primeira mensagem.');
      // `completed` (e não `failed` por INTERNAL_ERROR) é a asserção central: a falha simulada aconteceu depois de a resposta estar gravada.
      await world.waitForStatus(run, 'completed');
      // A resposta ficou gravada e o aviso carrega só identificadores e o código seguro do erro, nunca a mensagem nem conteúdo da conversa.
      const answers = await world.pool.query("SELECT 1 FROM messages WHERE run_id = $1 AND role = 'assistant' AND content = 'Pronto.'", [run]);
      expect(answers.rowCount).toBeGreaterThan(0);
      const warning = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((entry) => String(entry.msg).startsWith('medição do contexto não regravada'));
      expect(warning).toMatchObject({ runId: run, conversationId, step: 1 });
      expect(JSON.stringify(warning)).not.toContain('falha simulada');
      // Sem a falha, a próxima preparação mede e o fim da chamada regrava normalmente.
      await world.pool.query('DROP TRIGGER falha_na_medicao ON conversation_context; DROP FUNCTION falha_na_medicao();');
      await world.waitForStatus(await world.send(bot, 'Segunda mensagem.'), 'completed');
      expect((await world.conversations.contextState(bot.id)).measurement).toMatchObject({ stale: false });
    } finally { await world.cleanup(); }
  });

  it('settleMeasurementAfterResponse: recalcula folga e excesso pelo orçamento, ignora usage inutilizável e não faz nada sem medição', async () => {
    const world = await createRunsWorld({ contextWindow: WINDOW });
    try {
      const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      const at = new Date('2026-10-14T12:00:00.000Z');
      // Conversa ainda sem medição: nada a fechar.
      expect(await settleMeasurementAfterResponse(world.pool, conversationId, 500, 1000, at)).toBe(false);
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (): AsyncGenerator<ChatEvent> {
        yield { type: 'text', text: 'Pronto.' };
        yield { type: 'done', reason: 'stop' };
      });
      world.engine.start();
      await world.waitForStatus(await world.send(bot, 'Primeira mensagem.'), 'completed');
      const measured = (await world.conversations.contextState(bot.id)).measurement!;
      const read = async () => (await world.conversations.contextState(bot.id)).measurement!;

      // Acima do orçamento de entrada: nenhuma folga e o excesso exato. A estimativa de referência (crua) é o dobro do usage: razão 0,5, bem plausível.
      const reference = 2 * (measured.inputBudget + 100);
      expect(await settleMeasurementAfterResponse(world.pool, conversationId, measured.inputBudget + 100, reference, at)).toBe(true);
      expect(await read()).toMatchObject({ inputTokens: measured.inputBudget + 100, availableTokens: 0, excessTokens: 100, measuredAt: at.toISOString(), stale: false });
      // Usage ausente, zero, fracionário ou implausível (5 tokens contra milhares; razão de 0,05) e usage sem estimativa de referência não são entrada real:
      // a medição anterior fica. Já a razão exatamente mínima (0,12) é aceita, a mesma fronteira da calibração e da âncora.
      const later = new Date('2026-10-14T13:00:00.000Z');
      for (const [unusable, estimate] of [[undefined, reference], [0, reference], [12.5, reference], [5, reference], [Math.floor(reference * 0.05), reference], [500, undefined]] as const) {
        expect(await settleMeasurementAfterResponse(world.pool, conversationId, unusable, estimate, later)).toBe(true);
        expect(await read()).toMatchObject({ inputTokens: measured.inputBudget + 100, measuredAt: at.toISOString() });
      }
      expect(await settleMeasurementAfterResponse(world.pool, conversationId, 120, 1000, later)).toBe(true);
      expect(await read()).toMatchObject({ inputTokens: 120, measuredAt: later.toISOString() });
    } finally { await world.cleanup(); }
  });
});
// "Compactar agora" só vale quando há histórico a cobrir (phase 9, F6 passo 2): a elegibilidade usa a MESMA regra de corte da compactação (`cutHistory`), sobre
// as linhas ainda não cobertas por um checkpoint válido. O motor, o PostgreSQL e o provedor falso são os reais; o checkpoint é gravado direto (a compactação
// em si é de `compaction.test.ts`).
describe('elegibilidade de "Compactar agora" pelo histórico a cobrir', () => {
  it('conversa nova desabilita com motivo, sem afetar a elegibilidade geral; depois de uma troca há o que cobrir', async () => {
    const world = await createRunsWorld({ contextWindow: WINDOW });
    try {
      const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
      const eligibility = async () => (await world.conversations.contextState(bot.id)).eligibility;
      // Sem nenhuma linha de contexto o motor nunca preparou a conversa: nada a cobrir. `enabled` (manutenção em geral) segue verdadeiro.
      expect(await eligibility()).toMatchObject({ enabled: true, reason: null, summarizeEnabled: false, summarizeReason: NO_HISTORY_TO_COVER_REASON });
      vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (): AsyncGenerator<ChatEvent> {
        yield { type: 'text', text: 'Pronto.' };
        yield { type: 'done', reason: 'stop' };
      });
      world.engine.start();
      await world.waitForStatus(await world.send(bot, 'Primeira mensagem.'), 'completed');
      // Mensagem do dono e resposta são duas unidades: a mais recente nunca se cobre, mas a do dono sim.
      expect(await eligibility()).toMatchObject({ enabled: true, summarizeEnabled: true, summarizeReason: null });
    } finally { await world.cleanup(); }
  });

  it('desconta o que um checkpoint válido já cobre e volta a contar tudo quando ele deixa de valer', async () => {
    const world = await createRunsWorld({ contextWindow: WINDOW });
    try {
      const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      await loadManagedContext(world.pool, conversationId); // cria a linha de cobertura, como o motor faz na primeira preparação
      // Quatro mensagens do dono, cada uma sua própria unidade: com a conversa ociosa só a mais recente fica fora de qualquer lote.
      const ids: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        ids.push((await world.pool.query<{ id: string }>("INSERT INTO messages(conversation_id,role,kind,status,opens_round,content,created_at) VALUES($1,'user','text','done',true,$2,now()) RETURNING id::text", [conversationId, `Mensagem ${index}.`])).rows[0]!.id);
      }
      const cover = (covered: readonly string[], evidence: object = { attachments: [], tables: [] }) =>
        world.pool.query("UPDATE conversation_context SET summary='Resumo sintético.',covered_message_ids=$2::bigint[],coverage_fingerprint='sintetico',evidence_provenance=$3::jsonb WHERE conversation_id=$1", [conversationId, covered, JSON.stringify(evidence)]);
      const eligible = () => hasHistoryToCover(world.pool, conversationId, bot.id);

      expect(await eligible()).toBe(true); // sem checkpoint: as três primeiras são o lote
      await cover(ids.slice(0, 2));
      expect(await eligible()).toBe(true); // sobram a 3ª (lote) e a 4ª (a mais recente)
      await cover(ids.slice(0, 3));
      expect(await eligible()).toBe(false); // sobra só a mais recente: nada a cobrir
      expect(await world.conversations.contextState(bot.id)).toMatchObject({ eligibility: { summarizeEnabled: false, summarizeReason: NO_HISTORY_TO_COVER_REASON } });
      // Checkpoint que deixou de valer (linha coberta que não está mais no histórico, ou fonte de proveniência revogada): o histórico inteiro volta a contar.
      await cover([...ids.slice(0, 3), '999999999']);
      expect(await eligible()).toBe(true);
      await cover(ids.slice(0, 3), { attachments: ['999999999'], tables: [] });
      expect(await eligible()).toBe(true);
    } finally { await world.cleanup(); }
  });
});

// A medição guarda o envelope (reserva de saída, margem e orçamento de entrada) da janela em que foi feita. Trocar a janela não muda o conteúdo medido: o estado público passa a mostrar
// os mesmos tokens sobre o envelope da janela vigente (mesma conta de `contextEnvelope`; a reserva de saída é 25% da janela, até 32.768, phase 12), sem chamar o modelo e sem gravar nada.
// O que o servidor devolve é o que o GET, o snapshot e o SSE mostram.
describe('ocupação sobre a janela vigente depois de trocar a janela', () => {
  /**
   * Envelope esperado de uma janela, escrito pela regra da spec (reserva = menor entre 32.768 e 25% da janela; margem de 2.048) e não importado do motor: um teste que reusasse a função do
   * produto não reprovaria uma regra trocada. As provas literais de 64k e 128k estão nos testes; aqui o helper cobre as janelas que variam.
   */
  const envelopeOf = (window: number) => { const outputReserve = Math.min(32768, Math.floor(window / 4)); return { outputReserve, margin: 2048, inputBudget: window - outputReserve - 2048 }; };
  /** Provedor que só responde "Pronto." (sem usage), contando as chamadas: o teste prova que ler o estado depois de trocar a janela não chama o modelo. */
  const answering = (world: Awaited<ReturnType<typeof createRunsWorld>>) => {
    const calls = { total: 0 };
    vi.spyOn(world.provider, 'streamChat').mockImplementation(async function* (): AsyncGenerator<ChatEvent> {
      calls.total += 1;
      yield { type: 'text', text: 'Pronto.' };
      yield { type: 'done', reason: 'stop' };
    });
    return calls;
  };

  it('janela global de 64k para 128k: mesmos tokens sobre o orçamento novo, sem "Desatualizado" e sem chamada ao provedor; mensagem nova volta a marcar', async () => {
    const world = await createRunsWorld({ contextWindow: 65536 });
    try {
      const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      const providerCalls = answering(world);
      world.engine.start();
      await world.waitForStatus(await world.send(bot, 'Primeira mensagem.'), 'completed');
      const before = await world.conversations.contextState(bot.id);
      const measured = before.measurement!;
      // A1: em 64k a reserva é 16.384 (25% da janela) e a entrada 47.104.
      expect(measured).toMatchObject({ stale: false, outputReserve: 16384, inputBudget: 47104 });
      const calls = providerCalls.total, usageRows = (await world.pool.query('SELECT count(*)::int AS total FROM model_call_usage')).rows[0]!.total;

      await world.pool.query('UPDATE app_settings SET bot_context_window_tokens = 131072');
      const after = await world.conversations.contextState(bot.id);
      const expectedBudget = envelopeOf(131072).inputBudget;
      expect(expectedBudget).toBe(96256);
      // Os tokens medidos e o instante da medição são os mesmos; a reserva de saída (agora função da janela: 32.768 em 128k, não os 16.384 de 64k), o orçamento, a folga e o percentual passam a ser os da janela nova.
      expect(after.measurement).toMatchObject({ stale: false, measuredAt: measured.measuredAt, inputTokens: measured.inputTokens, inputBudget: expectedBudget, availableTokens: expectedBudget - measured.inputTokens, excessTokens: 0, outputReserve: 32768, margin: measured.margin });
      expect(after.window.effectiveTokens).toBe(131072);
      // A janela continua entrando na revisão: quem leu o estado antes da troca ainda enxerga o conflito ao pedir uma manutenção.
      expect(after.revision).not.toBe(before.revision);
      // Nada foi medido de novo nem gravado: nenhuma chamada ao provedor, nenhum uso novo, a medição persistida segue a da janela antiga.
      expect(providerCalls.total).toBe(calls);
      expect((await world.pool.query('SELECT count(*)::int AS total FROM model_call_usage')).rows[0]!.total).toBe(usageRows);
      expect((await world.pool.query<{ measurement: { inputBudget: number } }>('SELECT measurement FROM conversation_context WHERE conversation_id = $1', [conversationId])).rows[0]!.measurement.inputBudget).toBe(measured.inputBudget);

      // De volta a 64k, a conta reproduz o orçamento original.
      await world.pool.query('UPDATE app_settings SET bot_context_window_tokens = 65536');
      expect((await world.conversations.contextState(bot.id)).measurement).toMatchObject({ stale: false, inputBudget: measured.inputBudget });

      // Mensagem nova do dono depois da troca: o conteúdo também mudou, então volta a marcar "Desatualizado".
      await world.pool.query('UPDATE app_settings SET bot_context_window_tokens = 131072');
      const runId = (await world.pool.query<{ id: string }>('SELECT id::text FROM runs WHERE conversation_id = $1 ORDER BY id LIMIT 1', [conversationId])).rows[0]!.id;
      const message = await world.pool.query<{ id: string }>("INSERT INTO messages (conversation_id, run_id, role, kind, status, opens_round, content, created_at) VALUES ($1, $2, 'user', 'text', 'done', true, 'Segunda mensagem.', now()) RETURNING id::text", [conversationId, runId]);
      await recordConversationEvent(world.pool, conversationId, 'message', message.rows[0]!.id, new Date());
      expect((await world.conversations.contextState(bot.id)).measurement).toMatchObject({ stale: true, inputTokens: measured.inputTokens });
    } finally { await world.cleanup(); }
  });

  it('janela do bot (o carimbo do bot muda junto): recalcula, e com a janela menor o que passa do orçamento aparece como excesso sem folga', async () => {
    const world = await createRunsWorld({ contextWindow: 131072 });
    try {
      const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      answering(world);
      world.engine.start();
      await world.waitForStatus(await world.send(bot, 'Primeira mensagem.'), 'completed');
      const measured = (await world.conversations.contextState(bot.id)).measurement!;
      // Entrada medida grande o bastante para estourar o orçamento de 64k (47.104), a janela do bot abaixo: a estimativa por bytes dos mundos de teste é pequena demais para isso sozinha.
      const inputTokens = 70000;
      await world.pool.query("UPDATE conversation_context SET measurement = measurement || jsonb_build_object('inputTokens', $2::int, 'availableTokens', $3::int) WHERE conversation_id = $1", [conversationId, inputTokens, measured.inputBudget - inputTokens]);
      expect((await world.conversations.contextState(bot.id)).measurement).toMatchObject({ stale: false, inputTokens, availableTokens: measured.inputBudget - inputTokens, excessTokens: 0 });

      // A edição do serviço grava a janela do bot e `updated_at` juntos: só a janela mudou, e a medição continua sem "Desatualizado".
      await world.bots.update(bot.id, { contextWindowTokens: 65536 }, ORIGIN);
      const small = envelopeOf(65536).inputBudget;
      expect((await world.conversations.contextState(bot.id)).measurement).toMatchObject({ stale: false, inputTokens, inputBudget: small, availableTokens: 0, excessTokens: inputTokens - small });
      // Mesmo valor da janela global, agora como definição do bot (muda só a origem na resolução): orçamento igual ao original e sem marca.
      await world.bots.update(bot.id, { contextWindowTokens: 131072 }, ORIGIN);
      expect((await world.conversations.contextState(bot.id)).measurement).toMatchObject({ stale: false, inputBudget: measured.inputBudget, availableTokens: measured.inputBudget - inputTokens, excessTokens: 0 });
      // Voltar a herdar a global também é só troca de janela.
      await world.bots.update(bot.id, { contextWindowTokens: null }, ORIGIN);
      expect((await world.conversations.contextState(bot.id)).measurement).toMatchObject({ stale: false, inputBudget: measured.inputBudget });
    } finally { await world.cleanup(); }
  });

  it('outra mudança além da janela (instruções do bot) mantém a medição desatualizada, como foi medida', async () => {
    const world = await createRunsWorld({ contextWindow: 65536 });
    try {
      const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
      answering(world);
      world.engine.start();
      await world.waitForStatus(await world.send(bot, 'Primeira mensagem.'), 'completed');
      const measured = (await world.conversations.contextState(bot.id)).measurement!;

      // Instruções sozinhas: desatualizada, com o orçamento da janela em que foi medida.
      await world.bots.update(bot.id, { instructions: 'Responda sempre em uma frase.' }, ORIGIN);
      expect((await world.conversations.contextState(bot.id)).measurement).toMatchObject({ stale: true, inputBudget: measured.inputBudget });
      // Instruções e janela juntas: não dá para dizer que a janela foi a única mudança, então continua desatualizada.
      await world.bots.update(bot.id, { contextWindowTokens: 131072 }, ORIGIN);
      expect((await world.conversations.contextState(bot.id)).measurement).toMatchObject({ stale: true, inputTokens: measured.inputTokens });
    } finally { await world.cleanup(); }
  });

  // A3 (phase 12, F1): depois do deploy do teto de saída novo, a medição gravada com a reserva antiga (8.192, a janela de 64k tinha entrada de 55.296) não pode mandar no painel. A reserva entra
  // nos insumos da revisão (`revisionOf`), então a revisão gravada com a reserva antiga deixa de bater e a medição fica desatualizada, mas o painel já mostra o envelope de hoje com os mesmos
  // tokens medidos, e a próxima preparação a refaz. A medição antiga é montada reescrevendo a gravada: mesmos tokens, a reserva e o orçamento de antes e a revisão que o estado calcula com o
  // teto base de antes (`envelopeBase`); que essa revisão difira da atual é o que prova que a reserva entra na revisão.
  it('A3: medição gravada com a reserva antiga fica desatualizada e mostra o orçamento novo sem chamar o modelo; a próxima preparação a refaz', async () => {
    const world = await createRunsWorld({ contextWindow: 65536 });
    try {
      const bot = await world.createBot(); await world.models.test('opencode/glm-5.1');
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      const providerCalls = answering(world);
      world.engine.start();
      await world.waitForStatus(await world.send(bot, 'Primeira mensagem.'), 'completed');
      const fresh = (await world.conversations.contextState(bot.id)).measurement!;
      expect(fresh).toMatchObject({ stale: false, outputReserve: 16384, inputBudget: 47104 });

      const currentRevision = await readContextRevision(world.pool, conversationId);
      envelopeBase.maxTokens = 8192;
      const legacyRevision = await readContextRevision(world.pool, conversationId);
      envelopeBase.maxTokens = null;
      // A reserva está entre os insumos da revisão: só ela mudou (mesma conversa, mesma janela, mesmo conteúdo) e a revisão mudou.
      expect(legacyRevision).not.toBe(currentRevision);
      const legacyBudget = 65536 - 8192 - 2048;
      await world.pool.query(
        "UPDATE conversation_context SET measurement = measurement || jsonb_build_object('outputReserve', 8192, 'inputBudget', $2::int, 'availableTokens', $3::int), measurement_revision = $4 WHERE conversation_id = $1",
        [conversationId, legacyBudget, legacyBudget - fresh.inputTokens, legacyRevision]);
      const calls = providerCalls.total;
      const legacy = (await world.conversations.contextState(bot.id)).measurement!;
      // Desatualizada, mas com o envelope de hoje (16.384 e 47.104), os tokens medidos de antes e a folga recalculada sobre o orçamento novo.
      expect(legacy).toMatchObject({ stale: true, inputTokens: fresh.inputTokens, measuredAt: fresh.measuredAt, outputReserve: 16384, inputBudget: 47104, margin: 2048, availableTokens: 47104 - fresh.inputTokens, excessTokens: 0 });
      expect(providerCalls.total).toBe(calls);

      // A próxima mensagem mede de novo: a medição gravada já traz o envelope novo e a revisão atual, e o painel deixa de marcar.
      await world.waitForStatus(await world.send(bot, 'Segunda mensagem.'), 'completed');
      const renewed = (await world.conversations.contextState(bot.id)).measurement!;
      expect(renewed).toMatchObject({ stale: false, outputReserve: 16384, inputBudget: 47104 });
      expect((await world.pool.query<{ measurement: { outputReserve: number; inputBudget: number } }>('SELECT measurement FROM conversation_context WHERE conversation_id = $1', [conversationId])).rows[0]!.measurement).toMatchObject({ outputReserve: 16384, inputBudget: 47104 });
    } finally { await world.cleanup(); }
  });
});

describe('provedor do modelo da conversa (phase 17)', () => {
  it('a compactação por resumo exige a chave do provedor DO MODELO: um bot em anthropic/ sem a chave da Anthropic é recusado mesmo com a do OpenCode Go, e a fila usa a mesma regra', async () => {
    const world = await createRunsWorld({ contextWindow: WINDOW });
    try {
      await world.connectAnthropic();
      const bot = await world.createBot({ model: 'anthropic/claude-haiku-5-5' });
      await world.models.test('anthropic/claude-haiku-5-5');
      const conversationId = await world.conversations.conversationIdOf(bot.id);
      const summarizeReason = async () => (await world.conversations.contextState(bot.id)).eligibility.summarizeReason;
      const blocker = () => summarizeBlocker(world.pool, conversationId);
      // Com as duas chaves e o modelo validado, só falta histórico a cobrir.
      expect(await summarizeReason()).toBe(NO_HISTORY_TO_COVER_REASON);
      expect(await blocker()).toBeNull();

      // Sem a chave da Anthropic (a do OpenCode Go segue lá): o motivo é o da chave, e a fila recusa antes de qualquer custo.
      await world.credentials.disconnect('anthropic', ORIGIN);
      expect(await summarizeReason()).toBe('Configure a chave do provedor antes de compactar.');
      expect(await blocker()).toBe('PROVIDER_NOT_CONFIGURED');

      // O contrário vale igual: bot no OpenCode Go depende só da chave dele, não da Anthropic.
      const other = await world.createBot({ model: 'opencode/glm-5.1' });
      await world.models.test('opencode/glm-5.1');
      expect((await world.conversations.contextState(other.id)).eligibility.summarizeReason).toBe(NO_HISTORY_TO_COVER_REASON);
      expect(await summarizeBlocker(world.pool, await world.conversations.conversationIdOf(other.id))).toBeNull();
      await world.credentials.disconnect('provider', ORIGIN);
      expect((await world.conversations.contextState(other.id)).eligibility.summarizeReason).toBe('Configure a chave do provedor antes de compactar.');
    } finally { await world.cleanup(); }
  });
});

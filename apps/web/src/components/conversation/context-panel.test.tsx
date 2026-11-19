// Painel de contexto (phase 8 e phase 9, F6): o dropdown só abre no navegador (Radix usa portal), então o que dá para provar em ambiente sem DOM é (a) o nome acessível
// da bola, que carrega o aviso discreto da compactação automática (`measurement.compaction`: sem mensagem, cartão nem push), e (b) `describeContextState`, a
// fonte única da linha de status e do aviso dentro do painel. O gesto manual é só "Compactar agora"; operação antiga de elisão (modo extinto) continua legível sem erro.
import type { ContextState } from '@aion/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SessionProvider } from '@/lib/session-context';
import { ContextPanel, describeContextState } from './context-panel';

const SESSION = { owner: { email: 'dono@example.com' }, sessionId: '0b6d4b8e-7d63-4a54-9f55-3a2a0c1e0002', csrfToken: 'csrf' };
const USAGE = { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, coverage: 'complete' as const };
const REQUEST_ID = '8f0f7f43-6b53-4d0c-9d57-2f6bd1c4a001';
type Operation = NonNullable<ContextState['operation']>;
type Compaction = NonNullable<NonNullable<ContextState['measurement']>['compaction']>;

/** Operação manual concluída com o antes e o depois dados (em tokens; o orçamento de entrada do estado de teste é 47.104, a janela de 64k menos 16.384 de saída, 25% da janela na phase 12, e 2.048 de margem). */
const operation = (patch: Partial<Operation> = {}): Operation => ({ requestId: REQUEST_ID, mode: 'summarize', status: 'completed', cancelable: false, result: { changed: true, beforeInputTokens: 39500, afterInputTokens: 33900, summaryUsage: null }, errorCode: null, ...patch });
/** Operação de elisão gravada antes da phase 9 (o modo não pode mais ser pedido, só lido). */
const LEGACY_ELISION = operation({ mode: 'elision' });

/** Estado do servidor com 72% de ocupação; `compaction`, a operação e a fase são o que muda de um cenário para o outro. */
const state = (compaction: Compaction | undefined, current: ContextState['operation'] = null, phase: ContextState['phase'] = 'ready'): ContextState => ({
  revision: 1, model: 'opencode/glm-5.1',
  window: { preferredTokens: 65536, effectiveTokens: 65536, origin: 'global', model: 'opencode/glm-5.1', capacity: null },
  measurement: { measuredAt: '2026-10-12T20:00:00.000Z', method: 'utf8-body-upper-bound-v1', inputTokens: 33900, inputBudget: 47104, outputReserve: 16384, margin: 2048, availableTokens: 13204, excessTokens: 0, stale: false, ...(compaction ? { compaction } : {}) },
  phase, operation: current, eligibility: { enabled: true, reason: null, summarizeEnabled: true, summarizeReason: null },
  usage: { last: null, main: USAGE, summary: USAGE, total: USAGE, cost: null },
});

const render = (value: ContextState) => renderToStaticMarkup(<SessionProvider session={SESSION}><TooltipProvider><ContextPanel state={value} source={{ kind: 'bot', id: '64c4da7d-9c2b-455f-a270-8a2399d6f498' }} /></TooltipProvider></SessionProvider>);

describe('aviso da compactação automática no indicador', () => {
  it('diz "compactado" no nome acessível quando o último pedido foi resumido ou colapsado em índice', () => {
    for (const compaction of [{ elision: false, summary: true, index: false }, { elision: false, summary: false, index: true }, { elision: false, summary: true, index: true }]) {
      expect(render(state(compaction))).toContain('aria-label="Contexto: ≈ 72% · compactado"');
    }
  });

  it('não acrescenta nada quando nada foi compactado, nem em medições antigas sem o campo ou com o campo morto `elision`', () => {
    for (const compaction of [{ elision: false, summary: false, index: false }, undefined, { elision: true, summary: false, index: false }]) {
      const html = render(state(compaction));
      expect(html).toContain('aria-label="Contexto: ≈ 72%"');
      expect(html).not.toContain('compactado');
    }
  });

  it('logo depois de um "Compactar agora" concluído a medição vem zerada e o indicador não acusa compactação automática (R6)', () => {
    for (const compaction of [{ elision: false, summary: false, index: false }, undefined]) {
      const html = render(state(compaction, operation()));
      expect(html).toContain('aria-label="Contexto: ≈ 72%"');
      expect(html).not.toContain('compactado');
      expect(html).not.toContain('automaticamente');
    }
  });
});

describe('texto do aviso automático dentro do painel', () => {
  it('só fala de conversa resumida e de trecho em índice, nunca de resultados reduzidos', () => {
    expect(describeContextState(state({ elision: false, summary: true, index: false })).autoNote).toBe('Contexto compactado automaticamente: conversa antiga resumida.');
    expect(describeContextState(state({ elision: false, summary: false, index: true })).autoNote).toBe('Contexto compactado automaticamente: trecho mais antigo em índice.');
    expect(describeContextState(state({ elision: false, summary: true, index: true })).autoNote).toBe('Contexto compactado automaticamente: conversa antiga resumida, trecho mais antigo em índice.');
    // `elision` é campo morto: uma medição antiga com ele ligado não gera aviso e nunca diz "resultados antigos reduzidos".
    for (const compaction of [{ elision: true, summary: false, index: false }, { elision: false, summary: false, index: false }, undefined]) expect(describeContextState(state(compaction)).autoNote).toBe('');
    expect(describeContextState(state({ elision: true, summary: true, index: true })).autoNote).not.toMatch(/reduzid/i);
  });
});

describe('linha de status do painel', () => {
  it('"Compactando…" é o único rótulo de andamento: fase do servidor (resumo ou índice) ou operação na fila ou em execução', () => {
    const seen = new Set<string>();
    for (const [phase, current] of [['summarizing', null], ['reducing', null], ['ready', operation({ status: 'queued', cancelable: true, result: null })], ['ready', operation({ status: 'running', cancelable: true, result: null })], ['summarizing', LEGACY_ELISION]] as const) {
      const described = describeContextState(state(undefined, current, phase));
      expect(described.compacting).toBe(true);
      seen.add(described.status);
    }
    expect([...seen]).toEqual(['Compactando…']);
  });

  it('mostra o antes e o depois em percentual da janela, o resumo sem ganho de espaço e o "nada a compactar"', () => {
    expect(describeContextState(state(undefined, operation())).status).toBe('Compactado: 84% → 72% da janela.');
    // Um resumo maior que a origem é mudança aplicada com custo, sem alegar espaço liberado.
    expect(describeContextState(state(undefined, operation({ result: { changed: true, beforeInputTokens: 33900, afterInputTokens: 39500, summaryUsage: null } }))).status).toBe('Resumo salvo, sem redução de espaço.');
    expect(describeContextState(state(undefined, operation({ result: { changed: false, beforeInputTokens: 33900, afterInputTokens: 33900, summaryUsage: null } }))).status).toBe('Nada a compactar.');
    // Sem orçamento medido não há percentual para mostrar: o texto não inventa números.
    const unmeasured = { ...state(undefined, operation()), measurement: null };
    expect(describeContextState(unmeasured).status).toBe('Contexto compactado.');
  });

  it('cancelamento, falha com motivo seguro e resultado incerto têm texto próprio; sem operação a linha fica vazia', () => {
    expect(describeContextState(state(undefined, operation({ status: 'cancelled', result: null }))).status).toBe('Compactação cancelada.');
    expect(describeContextState(state(undefined, operation({ status: 'failed', errorCode: 'CONTEXT_COMPACTION_FAILED', result: null }))).status).toBe('O modelo não devolveu um resumo utilizável. Nada foi alterado; tente de novo.');
    expect(describeContextState(state(undefined, operation({ status: 'failed', errorCode: 'CODIGO_NOVO', result: null }))).status).toBe('Não foi possível compactar.');
    expect(describeContextState(state(undefined, operation({ status: 'unknown', result: null }))).status).toBe('Resultado incerto: confira antes de repetir.');
    expect(describeContextState(state(undefined, null))).toEqual({ compacting: false, status: '', autoNote: '' });
    expect(describeContextState(null)).toEqual({ compacting: false, status: '', autoNote: '' });
  });

  it('operação antiga de elisão é exibida pelo desfecho genérico, sem erro e sem falar de resumo', () => {
    expect(describeContextState(state(undefined, LEGACY_ELISION)).status).toBe('Compactado: 84% → 72% da janela.');
    expect(describeContextState(state(undefined, operation({ mode: 'elision', result: { changed: false, beforeInputTokens: null, afterInputTokens: null, summaryUsage: null } }))).status).toBe('Nada a compactar.');
    const failed = describeContextState(state(undefined, operation({ mode: 'elision', status: 'failed', errorCode: 'CONTEXT_COMPACTION_FAILED', result: null }))).status;
    expect(failed).toBe('Não foi possível compactar.');
    expect(failed).not.toMatch(/resumo|redução/i);
    // O painel inteiro renderiza com a operação antiga sem quebrar.
    expect(render(state(undefined, LEGACY_ELISION))).toContain('aria-label="Contexto: ≈ 72%"');
  });
});

describe('ocupação mostrada pelo indicador depois de trocar a janela (phase 9, T11)', () => {
  /**
   * O que o servidor devolve depois de a janela ir de 64k para 128k: os mesmos 33.900 tokens medidos, agora sobre o envelope de 128k (a reserva de saída passa a 32.768, 25% da janela até
   * esse teto, e o orçamento de entrada a 131.072 - 32.768 - 2.048 = 96.256).
   */
  const onWideWindow = (stale: boolean): ContextState => {
    const base = state(undefined);
    return { ...base, window: { ...base.window, preferredTokens: 131072, effectiveTokens: 131072 }, measurement: { ...base.measurement!, outputReserve: 32768, inputBudget: 96256, availableTokens: 62356, stale } };
  };

  it('o percentual vem do orçamento da medição entregue pelo servidor, não da janela antiga nem de conta no cliente', () => {
    // 33.900 ÷ 96.256 = 35%; sobre os 47.104 da janela antiga seriam 72%.
    const html = render(onWideWindow(false));
    expect(html).toContain('aria-label="Contexto: ≈ 35%"');
    expect(html).not.toContain('72%');
  });

  it('com conteúdo novo o servidor marca a medição desatualizada e o indicador diz "Desatualizado" em vez do percentual', () => {
    const html = render(onWideWindow(true));
    expect(html).toContain('aria-label="Contexto: Desatualizado"');
    expect(html).not.toContain('35%');
  });
});

// Contratos públicos da manutenção de contexto: motivo da linha de status (texto fixo por código estável, nunca o código nem detalhe interno) e a borda do
// "Compactar agora" (só `summarize` entra; operações antigas de `elision` continuam legíveis para exibição).
import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from './errors';
import { contextFailureMessage, contextMaintenanceRequestSchema, contextOperationSchema } from './context-status';

/** Os códigos que a manutenção grava em `errorCode` ao falhar (executor: `maintainContext`, `modelStep` e `failureOutcome`). */
const RECORDED_CODES = ['CONTEXT_COMPACTION_FAILED', 'CONTEXT_CONFIGURATION_CHANGED', 'CONTEXT_EVIDENCE_UNAVAILABLE', 'CONTEXT_TOO_LARGE', 'CONTEXT_ESTIMATE_UNAVAILABLE', 'CONTEXT_CONFLICT', 'PROVIDER_CREDITS_EXHAUSTED', 'MODEL_UNAVAILABLE', 'PROVIDER_NOT_CONFIGURED', 'PROVIDER_KEY_INVALID', 'PROVIDER_ERROR', 'INTERNAL_ERROR'] as const;
const GENERIC = 'Não foi possível compactar.';
const REQUEST = { requestId: '8f0f7f43-6b53-4d0c-9d57-2f6bd1c4a001', expectedRevision: 3 };

describe('contextFailureMessage', () => {
  it('cada código gravado tem um motivo próprio, curto, sem o código e sem detalhe interno', () => {
    const messages = RECORDED_CODES.map((code) => contextFailureMessage(code));
    expect(new Set(messages).size).toBe(RECORDED_CODES.length);
    for (const [index, message] of messages.entries()) {
      expect(message).not.toBe(GENERIC);
      expect(message).not.toContain(RECORDED_CODES[index]!);
      expect(message.length).toBeLessThanOrEqual(100);
      expect(message).toMatch(/\.$/);
    }
    // São códigos públicos reais: uma renomeação em `errors.ts` precisa chegar aqui.
    for (const code of RECORDED_CODES) expect(code in ERROR_CODES).toBe(true);
  });

  it('configuração alterada e evidência ausente (A15) têm motivo próprio e não falam de resumo: o texto do resumo é só do CONTEXT_COMPACTION_FAILED', () => {
    for (const code of ['CONTEXT_CONFIGURATION_CHANGED', 'CONTEXT_EVIDENCE_UNAVAILABLE'] as const) {
      expect(contextFailureMessage(code)).not.toBe(contextFailureMessage('CONTEXT_COMPACTION_FAILED'));
      expect(contextFailureMessage(code)).not.toMatch(/resumo/i);
      // A mensagem do cartão da execução (registro público) também não fala de resumo.
      expect(ERROR_CODES[code].message).not.toMatch(/resumo/i);
    }
  });

  it('o modo informado não muda o motivo de um código gravado por uma compactação (`summarize`)', () => {
    for (const code of RECORDED_CODES) expect(contextFailureMessage(code, 'summarize')).toBe(contextFailureMessage(code));
  });

  it('uma operação antiga de elisão (modo extinto) cai no genérico, sem falar de resumo, mesmo com código conhecido', () => {
    for (const code of RECORDED_CODES) expect(contextFailureMessage(code, 'elision')).toBe(GENERIC);
    expect(GENERIC).not.toMatch(/resumo/i);
  });

  it('sem código, com código de outra versão ou com texto estranho, cai no genérico sem repetir o valor', () => {
    for (const code of [null, undefined, '', 'CODIGO_NOVO', 'constructor', '__proto__', 'toString']) expect(contextFailureMessage(code)).toBe(GENERIC);
  });
});

describe('borda da manutenção de contexto', () => {
  it('aceita só `summarize`: `elision` e qualquer outro modo são recusados', () => {
    expect(contextMaintenanceRequestSchema.safeParse({ ...REQUEST, mode: 'summarize' }).success).toBe(true);
    for (const mode of ['elision', 'arbitrary', '', 'SUMMARIZE', null, 1]) expect(contextMaintenanceRequestSchema.safeParse({ ...REQUEST, mode }).success).toBe(false);
    // O corpo continua estrito: nada de modelo, janela ou prompt vindos do navegador.
    expect(contextMaintenanceRequestSchema.safeParse({ ...REQUEST, mode: 'summarize', model: 'outro' }).success).toBe(false);
  });

  it('continua lendo uma operação antiga de `elision` para exibi-la no histórico do painel', () => {
    const old = { requestId: REQUEST.requestId, mode: 'elision', status: 'completed', cancelable: false, result: { changed: true, beforeInputTokens: 19000, afterInputTokens: 16200, summaryUsage: null }, errorCode: null };
    expect(contextOperationSchema.parse(old).mode).toBe('elision');
    expect(contextOperationSchema.parse({ ...old, mode: 'summarize' }).mode).toBe('summarize');
    expect(contextOperationSchema.safeParse({ ...old, mode: 'arbitrary' }).success).toBe(false);
  });
});

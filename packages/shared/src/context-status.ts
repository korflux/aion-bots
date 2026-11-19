// Estado público de orçamento e manutenção: metadados autorizados, sem mensagens, resumos ou segredos.
import { z } from 'zod';
import { contextWindowResolutionSchema } from './context-window';

const count = z.number().int().nonnegative().safe();
/** Uso efetivamente informado; null nunca se converte em consumo zero e cache não é descontado da entrada. */
export const contextUsageCountsSchema = z.strictObject({
  calls: count, inputTokens: count.nullable(), outputTokens: count.nullable(), cachedTokens: count.nullable(),
  coverage: z.enum(['complete', 'partial', 'unknown']),
});
export type ContextUsageCounts = z.infer<typeof contextUsageCountsSchema>;

/** Estimativa do request serializado; é ocupação da janela, separada do usage cobrado pelo provedor. */
export const contextMeasurementSchema = z.strictObject({
  measuredAt: z.iso.datetime(), method: z.enum(['utf8-body-upper-bound-v1', 'utf8-body-calibrated-v1']),
  inputTokens: count, inputBudget: count, outputReserve: count, margin: count,
  availableTokens: count, excessTokens: count, stale: z.boolean(),
  /**
   * Como o pedido medido foi compactado antes da chamada (estado, não evento; ausente em medições anteriores a esta versão): conversa antiga resumida
   * (`summary`) ou índice recuperável de último recurso (`index`). Alimenta o aviso discreto do indicador; nunca vira mensagem, cartão nem notificação.
   * `elision` é campo morto: a elisão de resultados saiu na phase 9 e o servidor o grava sempre falso, mas medições já persistidas o trazem e o schema é
   * estrito, então o campo fica no contrato e ninguém o lê.
   * ponytail: campo `elision` mantido só pela leitura de medições antigas, remover junto com uma migration de dados quando o dono pedir a limpeza dos legados.
   */
  compaction: z.strictObject({ elision: z.boolean(), summary: z.boolean(), index: z.boolean() }).optional(),
});
export type ContextMeasurement = z.infer<typeof contextMeasurementSchema>;

/**
 * Uma operação durável na fila existente; resultado incerto só admite nova tentativa deliberada. `mode` continua lendo `elision` só para exibir operações
 * antigas já gravadas (a elisão manual saiu na phase 9); quem PEDE uma operação usa `contextMaintenanceRequestSchema`, que só aceita `summarize`.
 */
export const contextOperationSchema = z.strictObject({
  requestId: z.uuid(), mode: z.enum(['elision', 'summarize']),
  status: z.enum(['queued', 'running', 'completed', 'cancelled', 'failed', 'unknown']), cancelable: z.boolean(),
  result: z.strictObject({ changed: z.boolean(), beforeInputTokens: count.nullable(), afterInputTokens: count.nullable(), summaryUsage: contextUsageCountsSchema.nullable() }).nullable(),
  errorCode: z.string().max(64).nullable(),
});
export type ContextOperation = z.infer<typeof contextOperationSchema>;

/** Códigos que uma manutenção de contexto pode gravar em `errorCode` ao falhar (executor: `maintainContext`/`modelStep`/`failureOutcome`), com o motivo seguro e curto da tela (textos da compactação por resumo). */
const CONTEXT_FAILURE_MESSAGES: ReadonlyMap<string, string> = new Map([
  ['CONTEXT_COMPACTION_FAILED', 'O modelo não devolveu um resumo utilizável. Nada foi alterado; tente de novo.'],
  ['CONTEXT_CONFIGURATION_CHANGED', 'O modelo ou a configuração mudou durante a preparação. Tente de novo.'],
  ['CONTEXT_EVIDENCE_UNAVAILABLE', 'Não foi possível confirmar as fontes do contexto. Tente de novo.'],
  ['CONTEXT_TOO_LARGE', 'O contexto obrigatório não cabe na janela escolhida.'],
  ['CONTEXT_ESTIMATE_UNAVAILABLE', 'Sem estimativa segura do espaço das imagens da conversa.'],
  ['CONTEXT_CONFLICT', 'Conflito com outra alteração; tente de novo.'],
  ['MODEL_UNAVAILABLE', 'Modelo indisponível ou sem perfil confirmado; valide-o em Configurações.'],
  ['PROVIDER_NOT_CONFIGURED', 'Configure a chave do provedor para resumir.'],
  ['PROVIDER_KEY_INVALID', 'O provedor recusou a chave configurada.'],
  ['PROVIDER_ERROR', 'O provedor falhou ao resumir; tente de novo.'],
  ['PROVIDER_CREDITS_EXHAUSTED', 'Créditos da Anthropic esgotados.'],
  ['INTERNAL_ERROR', 'Erro interno ao compactar; tente de novo.'],
]);

/** Texto de uma falha sem motivo conhecido (código ausente, de outra versão ou de uma operação antiga). */
const GENERIC_FAILURE = 'Não foi possível compactar.';

/**
 * Motivo mostrado na linha de status quando a operação terminou em `failed`: fonte única, por código estável (padrão das mensagens públicas de `errors.ts`:
 * texto fixo, nunca o código nem detalhe interno). Código ausente ou desconhecido (operação de uma versão anterior, código novo) cai no texto genérico.
 * Uma operação antiga de `elision` (modo que não existe mais) também: os textos de `CONTEXT_FAILURE_MESSAGES` falam do resumo, e a elisão nunca chamou o modelo.
 */
export function contextFailureMessage(errorCode: string | null | undefined, mode?: ContextOperation['mode']): string {
  if (mode === 'elision') return GENERIC_FAILURE;
  return (errorCode ? CONTEXT_FAILURE_MESSAGES.get(errorCode) : undefined) ?? GENERIC_FAILURE;
}

/** Snapshot/SSE compartilham esta fonte única; custo indisponível até existir tarifa aplicável fundamentada. */
export const contextStateSchema = z.strictObject({
  revision: count, model: z.string().max(200).nullable(), window: contextWindowResolutionSchema,
  measurement: contextMeasurementSchema.nullable(), phase: z.enum(['not_measured', 'ready', 'reducing', 'summarizing', 'failed']),
  operation: contextOperationSchema.nullable(),
  /**
   * Elegibilidade das ações do painel, decidida só pelo servidor. `enabled`/`reason`: o que impede QUALQUER manutenção (arquivado, sem modelo, ocupado, aprovação
   * pendente). `summarizeEnabled`/`summarizeReason`: o mesmo mais o que "Compactar agora" exige (modelo validado, chave do provedor e histórico a cobrir). Os dois
   * últimos são opcionais só para ler estados de versões anteriores; sem eles o painel usa `enabled`/`reason`.
   */
  eligibility: z.strictObject({
    enabled: z.boolean(),
    reason: z.string().max(300).nullable(),
    summarizeEnabled: z.boolean().optional(),
    summarizeReason: z.string().max(300).nullable().optional(),
  }),
  usage: z.strictObject({
    last: z.strictObject({ runId: z.string().regex(/^\d+$/), main: contextUsageCountsSchema, summary: contextUsageCountsSchema, total: contextUsageCountsSchema, cost: z.null() }).nullable(),
    main: contextUsageCountsSchema, summary: contextUsageCountsSchema, total: contextUsageCountsSchema, cost: z.null(),
  }),
});
export type ContextState = z.infer<typeof contextStateSchema>;

/**
 * Borda estrita: o usuário escolhe a revisão esperada, nunca prompt, modelo, janela arbitrária ou conteúdo do resumo. `mode` é allowlist de um só valor
 * (`summarize`, o "Compactar agora"): a elisão manual saiu na phase 9 e `elision` é recusado aqui como erro de validação (`VALIDATION_FAILED` na borda HTTP).
 */
export const contextMaintenanceRequestSchema = z.strictObject({ requestId: z.uuid(), expectedRevision: count, mode: z.enum(['summarize']) });
export type ContextMaintenanceRequest = z.infer<typeof contextMaintenanceRequestSchema>;
export const contextMaintenanceParamsSchema = z.strictObject({ id: z.uuid(), requestId: z.uuid() });
export const contextMaintenanceCancelSchema = z.strictObject({});

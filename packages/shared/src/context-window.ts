// Preferência e resolução de janela (phase 8): contrato comum de servidor e apresentação.
// A capacidade confiável vem do servidor; esta função não autoriza metadados recebidos do browser.
import { z } from 'zod';

/**
 * Janelas que o dono pode escolher: 64k, 128k, 256k e 512k (phase 11, F8; substitui os presets de CTX-04). A de 32k saiu: com os resultados enxutos da
 * phase 11 ela só serviria para compactar cedo demais, e a migration 0046 leva qualquer bot em 32k para 64k. 256k entrou na phase 9 (migration 0043) e
 * 512k na phase 11 (migration 0046); os CHECKs do banco acompanham esta lista.
 */
export const CONTEXT_WINDOW_PRESETS = [65536, 131072, 262144, 524288] as const;
/**
 * Preferência inicial do dono: 256k (phase 11, decisão do dono em 17/10/2026; era 64k desde a 0040). Deve acompanhar o DEFAULT das colunas globais de
 * `app_settings` (migration 0046). É só o valor de partida da escolha, nunca um teto aplicado a modelos de capacidade desconhecida.
 */
export const DEFAULT_CONTEXT_WINDOW = 262144;
/** Allowlist da borda: só os quatro presets passam; 32k e qualquer outro número são `VALIDATION_FAILED` nas rotas de preferências e do bot. */
export const contextWindowTokensSchema = z.union([z.literal(65536), z.literal(131072), z.literal(262144), z.literal(524288)]);
export type ContextWindowTokens = z.infer<typeof contextWindowTokensSchema>;
export const contextScopeSchema = z.enum(['bots', 'general_chat']);
/** As janelas escolhidas por escopo: tudo o que o orçamento de contexto precisa (o core resolve a janela só com isto, sem tocar em outras preferências). */
export const contextPreferencesSchema = z.strictObject({ bots: contextWindowTokensSchema, generalChat: contextWindowTokensSchema });
export type ContextPreferences = z.infer<typeof contextPreferencesSchema>;

/**
 * Tamanho máximo do id de modelo gravado e aceito na borda (phase 17, DATA-02): o id local do provedor (até 200 caracteres) mais o prefixo `opencode/` (9). Fonte única: os CHECKs
 * de 209 da migration 0055 e todo schema de id (`modelIdSchema`, `summaryModelSchema`, a identidade da capacidade) leem este número. Mora aqui, e não em `models.ts`, porque
 * `models.ts` importa este arquivo e o id também é contrato da "Modelo do resumo".
 * ponytail: o prefixo `anthropic/` tem 10 caracteres, então um id local de 200 caracteres da Anthropic passaria de 209; os ids reais têm menos de 64, subir o número e os CHECKs se um dia isso mudar.
 */
export const MODEL_ID_MAX = 209;

/**
 * "Modelo do resumo" (phase 9, T4; spec Decisão 6): id (`provedor/modelo`) do modelo que compacta conversas longas, de 1 a `MODEL_ID_MAX` caracteres e sem controle (o mesmo formato de
 * `modelIdSchema`, repetido aqui porque `models.ts` importa este arquivo). Formato é só a borda: que o id seja um modelo VALIDADO é regra do servidor (`SettingsService`), na
 * gravação e de novo no uso.
 */
export const summaryModelSchema = z.string().min(1).max(MODEL_ID_MAX).regex(/^[^\p{Cc}]+$/u);
/**
 * A resposta de GET/PUT `/settings/context`: as janelas mais o modelo do resumo (nulo = o modelo de cada conversa, o padrão). É a visão da tela
 * Preferências; o motor lê as duas partes por funções próprias (janela em `readContextPreferences`, modelo em `resolveSummaryModel`).
 */
export const contextPreferencesViewSchema = contextPreferencesSchema.extend({ summaryModel: summaryModelSchema.nullable() });
export type ContextPreferencesView = z.infer<typeof contextPreferencesViewSchema>;

/**
 * Uma gravação altera UMA preferência por vez (duas sessões não sobrescrevem as outras): a janela de um escopo (`bots` ou `general_chat`) ou o modelo
 * do resumo (`summary_model`, com nulo para voltar ao modelo da conversa). Corpo estrito: campo extra, escopo desconhecido ou mistura das duas
 * formas é recusado na borda.
 */
export const contextPreferenceUpdateSchema = z.discriminatedUnion('scope', [
  z.strictObject({ scope: contextScopeSchema, windowTokens: contextWindowTokensSchema }),
  z.strictObject({ scope: z.literal('summary_model'), summaryModel: summaryModelSchema.nullable() }),
]);
export type ContextPreferenceUpdate = z.infer<typeof contextPreferenceUpdateSchema>;

/** Limites fundamentados para uma identidade exata, com proveniência pública e sem dados da conversa. */
export const modelContextCapacitySchema = z.strictObject({
  provider: z.string().min(1).max(80), model: z.string().min(1).max(MODEL_ID_MAX),
  contextTokens: z.number().int().positive().max(10000000),
  outputTokens: z.number().int().positive().max(10000000).nullable(),
  source: z.url().max(2048), checkedAt: z.iso.datetime(),
});
export type ModelContextCapacity = z.infer<typeof modelContextCapacitySchema>;

export const contextWindowResolutionSchema = z.object({
  preferredTokens: contextWindowTokensSchema,
  effectiveTokens: z.number().int().positive().nullable(),
  origin: z.enum(['global', 'bot']),
  model: z.string().nullable(),
  capacity: modelContextCapacitySchema.nullable(),
});
export type ContextWindowResolution = z.infer<typeof contextWindowResolutionSchema>;

/**
 * Resolve a janela efetiva: é a escolhida pelo dono (64k/128k/256k/512k), limitada apenas por um teto REAL confirmado
 * para a identidade exata do modelo. Capacidade desconhecida não impõe teto algum; ausência de modelo não simula
 * uma janela disponível. A preferência nunca é apagada.
 */
export function resolveContextWindow(preferredTokens: ContextWindowTokens, origin: 'global' | 'bot', model: string | null, capacity: ModelContextCapacity | null): ContextWindowResolution {
  const exact = capacity?.model === model ? capacity : null;
  return { preferredTokens, origin, model, capacity: exact,
    effectiveTokens: model === null ? null : Math.min(preferredTokens, exact?.contextTokens ?? preferredTokens) };
}

/** Rótulo dos presets sem arredondamento enganoso dos demais limites efetivos. */
export function contextWindowLabel(tokens: number): string {
  return CONTEXT_WINDOW_PRESETS.includes(tokens as ContextWindowTokens) ? `${tokens / 1024}k` : tokens.toLocaleString('pt-BR');
}

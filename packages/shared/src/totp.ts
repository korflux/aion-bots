// Contratos do autenticador TOTP (F1 segundo passo do login e F2 ativar/desativar em Conta), compartilhados entre
// a API (validação/serialização) e a web (tipos). Campos extras são recusados (`strictObject`).
//
// Parâmetros fixos do RFC 6238 definidos na spec: 6 dígitos, janela de 30 segundos, tolerância de uma janela.
import { z } from 'zod';

/** Dígitos do código. Spec F1: "código com exatamente 6 dígitos". */
export const TOTP_DIGITS = 6;
/** Duração de cada janela do código, em segundos (RFC 6238, padrão dos apps autenticadores). */
export const TOTP_PERIOD_SECONDS = 30;
/** Desafio do login: o código tem que chegar em até 5 minutos depois da senha (spec F1, `AUTH_TOTP_EXPIRED`). */
export const TOTP_CHALLENGE_TTL_SECONDS = 5 * 60;
/** Nome do cookie do desafio: HttpOnly, só circula em /api/auth e guarda um token assinado de curta duração. */
export const TOTP_CHALLENGE_COOKIE_NAME = 'aion_totp_challenge';

/** Código digitado pelo dono: exatamente 6 dígitos, sem espaços. */
export const totpCodeSchema = z.string().regex(/^\d{6}$/);

/** Segundo passo do login: o desafio vai no cookie, então o corpo leva só o código. */
export const totpVerifyRequestSchema = z.strictObject({ code: totpCodeSchema });

/** Desativar exige um código atual (F2 passo 3). */
export const totpDisableRequestSchema = z.strictObject({ code: totpCodeSchema });

/** Ativar: o segredo volta ao servidor dentro do token de ativação (cifrado); só é gravado após o código válido. */
export const totpEnableRequestSchema = z.strictObject({
  enrollmentToken: z.string().min(1).max(1024),
  code: totpCodeSchema,
});

/** Estado do autenticador em Conta. O segredo ativo nunca é devolvido. */
export const totpStatusSchema = z.object({ enabled: z.boolean() });
export type TotpStatus = z.infer<typeof totpStatusSchema>;

/**
 * Dados do modal de ativação. É o ÚNICO momento em que o segredo chega ao navegador: a spec F2 exige mostrá-lo
 * (QR e texto para cópia) antes da confirmação. Depois de ativo, nenhuma rota o devolve.
 */
export const totpSetupResponseSchema = z.object({
  /** Segredo em base32, para digitar no app quando não dá para ler o QR. */
  secret: z.string(),
  /** URI `otpauth://` que o navegador transforma em QR localmente (nenhum serviço externo recebe o segredo). */
  otpauthUri: z.string(),
  /** Token opaco (cifrado com a chave mestra) que a confirmação devolve; leva o segredo e a validade. */
  enrollmentToken: z.string(),
});
export type TotpSetupResponse = z.infer<typeof totpSetupResponseSchema>;

// Objetivo do bot: direção versionada, com evidência do dono e desfazer. Não é memória ou autorização.
import { z } from 'zod';

export const OBJECTIVE_MAX_CHARS = 2000;
/** ID bigint em texto: conserva precisão e recusa valor além do PostgreSQL antes do SQL. */
const objectiveEvidenceIdSchema = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .pipe(z.string().refine((id) => BigInt(id) <= 9223372036854775807n));
export const objectiveContentSchema = z.string().trim().refine((value) => Array.from(value).length >= 1 && Array.from(value).length <= OBJECTIVE_MAX_CHARS)
  .refine((value) => !/(?![\t\n\r])\p{Cc}/u.test(value));
export const objectiveUpdateSchema = z.strictObject({ content: objectiveContentSchema, expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sourceMessageIds: z.array(objectiveEvidenceIdSchema).min(1).max(10).refine((ids) => new Set(ids).size === ids.length) });
export type ObjectiveUpdate = z.infer<typeof objectiveUpdateSchema>;
export const objectiveUndoSchema = z.strictObject({ expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });
export const objectiveViewSchema = z.object({ content: z.string(), version: z.number().int().nonnegative(), invitationPresented: z.boolean(), updatedAt: z.iso.datetime().nullable() });
export type ObjectiveView = z.infer<typeof objectiveViewSchema>;
export const objectiveCardSchema = z.object({ type: z.literal('objective_updated'), version: z.number().int().positive(), previousVersion: z.number().int().nonnegative(),
  content: z.string(), status: z.enum(['applied', 'undone']), undoneVersion: z.number().int().positive().optional() });
export type ObjectiveCard = z.infer<typeof objectiveCardSchema>;

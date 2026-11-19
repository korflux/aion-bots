// Recibo destrutivo é metadado de efeito confirmado, independente das células da tabela que deixou de existir.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ERROR_CODES, tableConfirmSchema, tableIdSchema } from '@aion/shared';
import type { Queryable } from '../db/pool';
import { canonicalJSON } from './queries';
import { ToolFailure, type ToolOutcome } from '../runs/tools';
import { mergeEvidence } from '../runs/evidence-provenance';

const argumentsSchema = z.strictObject({ tableId: tableIdSchema, ...tableConfirmSchema.shape });
const resultSchema = z.strictObject({ removed: z.literal(true), tableId: tableIdSchema, kind: z.literal('delete_table') });

/** Leitura pura de recibo próprio e payload exato; nunca confirma aprovação nem executa a mutação novamente. */
export async function readTableRemovalReceipt(db: Queryable, botId: string | null, raw: string): Promise<ToolOutcome | null> {
  if (!botId) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  const parsed = argumentsSchema.safeParse(value);
  if (!parsed.success) return null;
  const { tableId, ...input } = parsed.data;
  const receipt = (await db.query<{ table_id: string; action: string; payload_hash: string; result: unknown }>(
    "SELECT table_id,action,payload_hash,result FROM table_mutation_receipts WHERE actor='bot:' || $1::text AND operation_id=$2", [botId, input.operationId])).rows[0];
  if (!receipt) return null;
  const expected = createHash('sha256').update(canonicalJSON({ tableId, input, extra: {} })).digest('hex');
  const result = resultSchema.safeParse(receipt.result);
  if (receipt.table_id.toLowerCase() !== tableId.toLowerCase() || receipt.action !== 'table.destructive' || receipt.payload_hash !== expected || !result.success || result.data.tableId.toLowerCase() !== tableId.toLowerCase()) throw new ToolFailure(JSON.stringify({ code: 'TABLE_CONFLICT', message: ERROR_CODES.TABLE_CONFLICT.message }));
  return { result: JSON.stringify(result.data), label: 'Excluiu tabela', evidence: mergeEvidence(), confirmedTableRemoval: { tableId: receipt.table_id, operationId: input.operationId } };
}

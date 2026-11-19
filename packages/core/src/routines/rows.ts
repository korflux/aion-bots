// Linhas de `routines` e o mapeamento delas para a visão pública. Único lugar que converte linha -> `RoutineView` e linha -> plano de
// agenda, usado por igual pelo serviço (telas e API) e pelo agendador (worker).
import type { RoutineStatus, RoutineView, ScheduleDefinition } from '@aion/shared';
import type { Queryable } from '../db/pool';
import { describeSchedule } from './describe';
import type { SchedulePlan } from './schedule';

/** Colunas lidas de `routines` com os dados do bot que a tela precisa (ordem e nomes que `RoutineRow` espelha). */
export const ROUTINE_SELECT = `r.id, r.bot_id, r.name, r.instruction, r.schedule, r.timezone, r.starts_local, r.ends_local, r.max_runs, r.anchor_at,
  r.status, r.run_count, r.next_run_at, r.created_at, r.updated_at, b.name AS bot_name, b.color AS bot_color,
  b.archived_at AS bot_archived_at`;

export interface RoutineRow {
  id: string;
  bot_id: string;
  name: string;
  instruction: string;
  /** jsonb já interpretado pelo driver. */
  schedule: ScheduleDefinition;
  timezone: string;
  starts_local: string | null;
  ends_local: string | null;
  max_runs: number | null;
  anchor_at: Date;
  status: RoutineStatus;
  run_count: number;
  next_run_at: Date | null;
  created_at: Date;
  updated_at: Date;
  bot_name: string;
  bot_color: string;
  bot_archived_at: Date | null;
}

/** O plano de agenda da rotina, a entrada do motor (`schedule.ts`). */
export const planOfRow = (row: RoutineRow): SchedulePlan => ({
  schedule: row.schedule,
  timezone: row.timezone,
  startsAt: row.starts_local,
  endsAt: row.ends_local,
  anchorAt: row.anchor_at,
});

/** A linha do banco como a rotina que a API e a tela leem: bot embutido, datas em ISO e o próximo horário. */
export function toRoutineView(row: RoutineRow): RoutineView {
  return {
    id: row.id,
    name: row.name,
    bot: { id: row.bot_id, name: row.bot_name, color: row.bot_color, archived: row.bot_archived_at !== null },
    instruction: row.instruction,
    schedule: row.schedule,
    timezone: row.timezone,
    startsAt: row.starts_local,
    endsAt: row.ends_local,
    maxRuns: row.max_runs,
    runCount: row.run_count,
    status: row.status,
    summary: describeSchedule(row.schedule),
    nextRunAt: row.next_run_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** As rotinas de UM bot (as ferramentas do bot nunca leem as de outro), por nome. */
export async function routinesOfBot(db: Queryable, botId: string): Promise<RoutineView[]> {
  const found = await db.query<RoutineRow>(
    `SELECT ${ROUTINE_SELECT} FROM routines r JOIN bots b ON b.id = r.bot_id WHERE r.bot_id = $1 ORDER BY lower(r.name), r.created_at`,
    [botId],
  );
  return found.rows.map(toRoutineView);
}

/** Uma rotina, só se for do bot dado: o id de uma rotina de outro bot é "não encontrada", sem revelar que existe (sem IDOR entre bots). */
export async function routineOfBot(db: Queryable, botId: string, id: string): Promise<RoutineView | null> {
  const found = await db.query<RoutineRow>(
    `SELECT ${ROUTINE_SELECT} FROM routines r JOIN bots b ON b.id = r.bot_id WHERE r.id = $1 AND r.bot_id = $2`,
    [id, botId],
  );
  const row = found.rows[0];
  return row ? toRoutineView(row) : null;
}

/** JSON com as chaves ordenadas, para comparar valores com o que o jsonb devolve (que reordena as chaves). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) =>
    nested !== null && typeof nested === 'object' && !Array.isArray(nested)
      ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a.localeCompare(b)))
      : nested,
  );
}

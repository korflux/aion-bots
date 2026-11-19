// Chamada da web à API da tela Atividades (F15). Único lugar que conhece o caminho /api/activities; parar uma execução reutiliza
// `stopRun` da conversa (a mesma rota de F7, só que com o `runId` da linha).
import type { ActivitiesPage } from '@aion/shared';
import { apiFetch } from '@/lib/api-client';

/** Uma página: sem cursor, a primeira (com as pendências); com cursor, as execuções seguintes. */
export const fetchActivities = (cursor: string | null): Promise<ActivitiesPage> =>
  apiFetch<ActivitiesPage>(`/api/activities${cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`}`);

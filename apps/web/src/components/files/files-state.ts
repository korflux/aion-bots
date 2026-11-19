// Regras locais da seleção e paginação; metadados seguem exclusivamente o contrato compartilhado.
import type { AttachmentPage } from '@aion/shared';
export type FileItem = AttachmentPage['items'][number];
/** Acrescenta cursores sem repetir itens recebidos por uma releitura. */
export function appendFiles(current: AttachmentPage, next: AttachmentPage): AttachmentPage {
  const known = new Set(current.items.map((item) => item.id));
  return { ...next, items: [...current.items, ...next.items.filter((item) => !known.has(item.id))] };
}
/** Mantém somente seleções carregadas e elegíveis após uma resposta autoritativa. */
export function eligibleSelection(items: readonly FileItem[], selected: ReadonlySet<string>): Set<string> {
  return new Set(items.filter((item) => !item.inUse && selected.has(item.id)).map((item) => item.id));
}
/** Cor e texto comunicam as três faixas mesmo sem distinguir cores. */
export function quotaState(used: number, max: number) {
  const percent = max === 0 ? 100 : Math.min(100, used / max * 100);
  return { percent, color: percent >= 100 ? 'bg-danger' : percent >= 80 ? 'bg-warning' : 'bg-muted', text: percent >= 100 ? 'Espaço esgotado' : percent >= 80 ? 'Espaço próximo do limite' : 'Espaço disponível' };
}

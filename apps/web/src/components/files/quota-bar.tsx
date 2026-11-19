// Barra de uso do armazenamento de arquivos (phase 5, T4): a MESMA barra da lista de arquivos (`FilesView`) e do cartão Armazenamento de Atividade e arquivos
// (`StorageCard`). A cor e o texto vêm das três faixas de `quotaState` (disponível, próximo do limite, esgotado): o estado nunca depende só da cor, porque `aria-valuetext`
// o diz. `className` só posiciona (margens).
import { cn } from '@/lib/cn';
import type { quotaState } from './files-state';

export function QuotaBar({ quota, className }: { quota: ReturnType<typeof quotaState>; className?: string }) {
  return (
    <div
      role="progressbar"
      aria-label="Espaço usado"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={quota.percent}
      aria-valuetext={quota.text}
      className={cn('h-1 overflow-hidden rounded-full bg-selected', className)}
    >
      <div className={`h-full ${quota.color}`} style={{ width: `${quota.percent}%` }} />
    </div>
  );
}

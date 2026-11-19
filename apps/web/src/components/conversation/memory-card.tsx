'use client';

// Linha "Memória atualizada" (F11 passos 1 e 2; phase 18, A12: linha discreta, sem moldura, de `SystemLine`): o bot editou a própria memória. Mostra o
// diff resumido (até 3 linhas que mudaram), o tamanho e o botão "Desfazer" (ghost, com texto). Desfazer restaura o texto de antes
// da edição como VERSÃO NOVA do dono; só vale enquanto a memória ainda está na versão que o bot gravou (depois disso o servidor
// responde MEMORY_CONFLICT e o dono usa o histórico). O estado "desfeito" chega pelo SSE (o servidor atualiza o cartão na mesma
// transação), mas o cartão já o mostra com a resposta da própria chamada.
import { MEMORY_MAX_CHARS, type MemoryCard } from '@aion/shared';
import { Brain } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { MemoryDiff } from '@/components/memory/memory-diff';
import { undoMemoryCard } from '@/components/memory/memory-api';
import { StatusBadge } from '@/components/settings/status-badge';
import { Button } from '@/components/ui/button';
import { ApiError, apiErrorMessage } from '@/lib/api-client';
import { useSession } from '@/lib/session-context';
import { SystemLine } from './card-frame';

export function MemoryCardView({ card, cardId, botId }: { card: MemoryCard; cardId: string; botId: string }) {
  const { csrfToken } = useSession();
  const [busy, setBusy] = useState(false);
  /** Desfeito pela resposta desta chamada, antes de o evento do SSE chegar. */
  const [undoneHere, setUndoneHere] = useState(false);
  const undone = card.status === 'undone' || undoneHere;

  async function undo() {
    if (busy) return;
    setBusy(true);
    try {
      await undoMemoryCard(botId, cardId, csrfToken);
      setUndoneHere(true);
      toast('Edição da memória desfeita');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'MEMORY_CONFLICT') {
        toast.error('A memória mudou depois desta edição. Abra o histórico para restaurar uma versão.', { duration: Infinity });
      } else {
        toast.error(apiErrorMessage(error), { duration: Infinity });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <SystemLine
      icon={Brain}
      title="Memória atualizada"
      actions={
        undone ? (
          <StatusBadge tone="neutral">Desfeita</StatusBadge>
        ) : (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void undo()}>
            Desfazer
          </Button>
        )
      }
    >
      {card.preview.length > 0 ? <MemoryDiff lines={card.preview} label="Mudanças na memória" /> : null}
      <p className="mt-1 text-xs text-subtle">
        +{card.added} −{card.removed} {card.added + card.removed === 1 ? 'linha' : 'linhas'} · {card.size.toLocaleString('pt-BR')} /{' '}
        {MEMORY_MAX_CHARS.toLocaleString('pt-BR')} caracteres ·{' '}
        <Link href={`/bots/${botId}/memoria`} className="underline underline-offset-4 hover:text-fg">
          Ver memória
        </Link>
      </p>
    </SystemLine>
  );
}

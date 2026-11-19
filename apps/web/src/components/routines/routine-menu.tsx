'use client';

// Menu de ações de uma rotina (design: Rotinas → menu do item `more-horizontal`): Executar agora, Pausar ou Retomar, Histórico e Excluir
// (em perigo, com modal de confirmação). Usado pelo item da lista no painel e pelo cabeçalho do editor, então as duas portas fazem
// exatamente o mesmo. O gatilho é icon-only (nome acessível), e os itens do menu têm texto.
import type { RoutineView } from '@aion/shared';
import { Ellipsis } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/settings/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import { apiErrorMessage } from '@/lib/api-client';
import { useSession } from '@/lib/session-context';
import { deleteRoutine, pauseRoutine, resumeRoutine, runRoutineNow } from './routines-api';

interface RoutineMenuProps {
  routine: RoutineView;
  /** Chamado depois de pausar ou retomar, com a rotina atualizada (o editor recarrega o que mostra). */
  onChanged?: (routine: RoutineView) => void;
  /** Chamado depois de excluir (quem estava com a rotina aberta volta à lista). */
  onDeleted?: () => void;
}

export function RoutineMenu({ routine, onChanged, onDeleted }: RoutineMenuProps) {
  const { csrfToken } = useSession();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function perform<T>(task: () => Promise<T>, success: (value: T) => void) {
    try {
      success(await task());
    } catch (error) {
      toast.error(apiErrorMessage(error), { duration: Infinity });
    }
  }

  const runNow = () =>
    perform(
      () => runRoutineNow(routine.id, csrfToken),
      () => toast('Execução enfileirada'),
    );
  const pause = () =>
    perform(
      () => pauseRoutine(routine.id, csrfToken),
      (updated) => {
        toast('Rotina pausada');
        onChanged?.(updated);
      },
    );
  const resume = () =>
    perform(
      () => resumeRoutine(routine.id, csrfToken),
      (updated) => {
        toast(updated.status === 'completed' ? 'A agenda desta rotina já terminou' : 'Rotina retomada');
        onChanged?.(updated);
      },
    );

  async function confirmDelete() {
    setBusy(true);
    try {
      await deleteRoutine(routine.id, csrfToken);
      toast('Rotina excluída');
      setConfirmOpen(false);
      onDeleted?.();
    } catch (error) {
      toast.error(apiErrorMessage(error), { duration: Infinity });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`Ações da rotina ${routine.name}`}>
            <Ellipsis className="size-4" strokeWidth={1.5} aria-hidden />
          </Button>
        </MenuTrigger>
        <MenuContent>
          <MenuItem onSelect={() => void runNow()}>Executar agora</MenuItem>
          {routine.status === 'active' ? <MenuItem onSelect={() => void pause()}>Pausar</MenuItem> : null}
          {routine.status === 'paused' ? <MenuItem onSelect={() => void resume()}>Retomar</MenuItem> : null}
          <MenuItem asChild>
            <Link href={`/rotinas/${routine.id}/historico`}>Histórico</Link>
          </MenuItem>
          <MenuItem className="text-danger data-[highlighted]:bg-danger-soft" onSelect={() => setConfirmOpen(true)}>
            Excluir
          </MenuItem>
        </MenuContent>
      </Menu>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Excluir a rotina “${routine.name}”?`}
        description="O histórico da rotina será apagado. As execuções que ainda não começaram saem da fila; os cartões que já estão na conversa permanecem."
        confirmLabel="Excluir rotina"
        pending={busy}
        onConfirm={() => void confirmDelete()}
      />
    </>
  );
}

'use client';

// Conteúdo de /rotinas (phase 5, T6; spec Suposição 20; design "Rotinas e histórico"): a LISTA de rotinas na própria página, com os filtros (Ativas, Pausadas, Concluídas) e os grupos por
// bot com a Faísca de 24 px, a aba "Rotinas" do celular. É o mesmo corpo do painel do desktop (`RoutinesPanel`, reaproveitado, então criar, pausar ou excluir atualiza as duas
// cópias pelo store compartilhado); no desktop ele ocupa o lugar do antigo texto de orientação. Sem nenhuma rotina, o estado vazio com o caminho para criar; com a leitura
// falha e nada para mostrar, "Tentar novamente". O botão de nova rotina fica no cabeçalho (celular) e no cabeçalho do painel (desktop).
import { CalendarClock, Plus } from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '@/components/page';
import { Button } from '@/components/ui/button';
import { RoutinesPanel } from './routines-panel';
import { refreshRoutines, useRoutines } from './routines-store';

export function RoutinesHome() {
  const { status, routines } = useRoutines();

  if (status === 'idle' || (status === 'loading' && routines.length === 0)) {
    return <div role="status" aria-busy="true" aria-label="Carregando rotinas" className="mx-auto mt-6 h-24 max-w-sm animate-pulse rounded-md bg-surface" />;
  }

  if (status === 'error' && routines.length === 0) {
    return (
      <EmptyState
        icon={CalendarClock}
        action={
          <Button variant="secondary" onClick={() => void refreshRoutines()}>
            Tentar novamente
          </Button>
        }
      >
        Não foi possível carregar as rotinas.
      </EmptyState>
    );
  }

  if (routines.length === 0) {
    return (
      <EmptyState
        icon={CalendarClock}
        action={
          <Button asChild variant="primary">
            <Link href="/rotinas/nova">
              <Plus className="size-4" strokeWidth={1.5} aria-hidden />
              Nova rotina
            </Link>
          </Button>
        }
      >
        Nenhuma rotina. Peça a um bot ou crie aqui.
      </EmptyState>
    );
  }

  return <RoutinesPanel />;
}

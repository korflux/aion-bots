// /rotinas: a seção Rotinas (phase 5, T6; spec Suposição 20). A página mostra a lista de rotinas (filtros e grupos por bot, com a Faísca de cada bot), a aba "Rotinas" da barra
// inferior do celular; no desktop o painel da seção continua com a mesma lista ao lado. O "+" do cabeçalho (só no celular) abre a criação.
import { Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeader } from '@/components/page';
import { RoutinesHome } from '@/components/routines/routines-home';
import { Button } from '@/components/ui/button';

export const metadata: Metadata = { title: 'Rotinas' };

export default function RoutinesPage() {
  return (
    <div className="mx-auto w-full max-w-[760px] px-4 pb-6 md:px-6">
      <PageHeader
        title="Rotinas"
        padded={false}
        mobileAction={
          <Button asChild variant="ghost" size="icon">
            <Link href="/rotinas/nova" aria-label="Nova rotina">
              <Plus className="size-[18px]" strokeWidth={1.5} aria-hidden />
            </Link>
          </Button>
        }
      />
      <RoutinesHome />
    </div>
  );
}

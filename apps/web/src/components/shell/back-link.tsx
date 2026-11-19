'use client';

// Botão "Voltar" dos cabeçalhos do celular (phase 5, T6; spec F3 passo 3 e Suposição 6): ícone de seta, nome acessível "Voltar", alvo de 40 px, que leva ao PAI FIXO da tela
// (`backHrefFor`, em `mobile-nav.ts`), não ao histórico do navegador, para funcionar igual com a tela aberta por push, atalho do ícone ou link. Só existe abaixo de 768 px (no
// desktop a navegação é a barra de ícones e o painel) e só nas telas que têm pai: nas abas e fora do mapa não desenha nada, então qualquer cabeçalho pode incluí-lo sem decidir.
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { backHrefFor } from './mobile-nav';

export function BackLink({ className }: { className?: string }) {
  const href = backHrefFor(usePathname());
  if (href === null) return null;
  return (
    <Button asChild variant="ghost" size="icon" className={cn('-ml-2 shrink-0 md:hidden', className)}>
      <Link href={href} aria-label="Voltar">
        <ArrowLeft className="size-[18px]" strokeWidth={1.5} aria-hidden />
      </Link>
    </Button>
  );
}

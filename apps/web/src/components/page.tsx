// Blocos de página compartilhados: cabeçalho com o único <h1> da tela, estado vazio do kit
// (ícone de 24 px em --text-subtle, frase e, quando existir, um CTA) e as telas cheias de erro (`ErrorScreen` e `NotFoundScreen`).
import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Faisca } from '@/components/mascot/faisca';
import type { FaiscaState } from '@/components/mascot/faisca-detail';
import { BackLink } from '@/components/shell/back-link';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

/**
 * Título da página (18/26 semibold). Toda tela autenticada tem exatamente um. Telas em coluna estreita
 * (Configurações) colocam o cabeçalho DENTRO da coluna e passam `padded={false}` para alinhar com o conteúdo.
 *
 * Cabeçalho do celular (phase 5, T6): no começo vai o "Voltar" para o pai fixo da tela (`BackLink`, que sozinho decide se há pai: as quatro abas e as telas fora do mapa não o
 * têm) e, no fim, a ação da aba (`mobileAction`, como o "+" de Chats e de Rotinas), que só aparece abaixo de 768 px porque no desktop essa ação já está no cabeçalho do painel.
 */
export function PageHeader({ title, padded = true, mobileAction }: { title: string; padded?: boolean; mobileAction?: ReactNode }) {
  return (
    <header className={cn('flex h-[52px] items-center gap-2', padded && 'px-4 md:px-6')}>
      <BackLink />
      <h1 className="min-w-0 flex-1 truncate text-[18px]/[26px] font-semibold text-fg">{title}</h1>
      {mobileAction ? <div className="-mr-2 flex shrink-0 items-center md:hidden">{mobileAction}</div> : null}
    </header>
  );
}

export function EmptyState({ icon: Icon, children, action }: { icon: LucideIcon; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <Icon className="size-6 text-subtle" strokeWidth={1.5} data-icon={Icon.displayName} aria-hidden />
      <p className="max-w-sm text-sm text-muted">{children}</p>
      {action}
    </div>
  );
}

/**
 * Tela cheia de erro ("Não encontrado", `NotFoundScreen`, e "Algo deu errado", `error.tsx` e `global-error.tsx`): a Faísca do Aion no estado dado (`waiting` na
 * página que não existe, `error` na falha), com halo, a entrada única, sem laço de movimento e com o rosto fixo (não segue o cursor), em 112 px, 96 px abaixo de
 * 768 px de largura e 72 px com a janela baixa (`.faisca-hero`), o título, o apoio e as ações (`children`), em largura total no celular e lado a lado a partir de
 * 768 px. A Faísca é decorativa: o texto é o que diz o estado. Não depende de sessão nem de dado: serve quando a própria API ou o layout autenticado falharam.
 *
 * Landmark: fora do shell (rota que não existe, `error.tsx`, `global-error.tsx`) a tela é o `<main>` da página; dentro do shell (`inShell`, o `notFound()` de uma
 * página do app, ver `(app)/not-found.tsx`) o `<main>` já é o do shell e a tela é um `<div>`, para a página ter um `main` só. `min-h-full` ocupa o contêiner de cada
 * caso (o `<main>` rolável do shell ou o `body`) sem criar rolagem.
 */
export function ErrorScreen({
  state,
  title,
  description,
  inShell = false,
  children,
}: {
  state: FaiscaState;
  title: string;
  description: string;
  inShell?: boolean;
  children: ReactNode;
}) {
  const Root = inShell ? 'div' : 'main';
  return (
    <Root className="grid min-h-full place-items-center px-4 py-8">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 text-center">
        <div className="faisca-halo w-fit">
          <Faisca state={state} size={112} enter still className="faisca-hero" />
        </div>
        <h1 className="text-[18px]/[26px] font-semibold">{title}</h1>
        <p className="text-sm text-muted">{description}</p>
        <div className="flex w-full flex-col gap-2 md:w-auto md:flex-row">{children}</div>
      </div>
    </Root>
  );
}

/**
 * Tela "Não encontrado": a Faísca aguardando, o texto do design e o caminho de volta ao Início (`/`). Uma só definição para as duas páginas do Next que a servem:
 * `not-found.tsx` da raiz (rota que não existe, fora do shell) e `(app)/not-found.tsx` (`notFound()` de uma página do app, dentro do shell, `inShell`).
 */
export function NotFoundScreen({ inShell = false }: { inShell?: boolean }) {
  return (
    <ErrorScreen state="waiting" title="Não encontrado" description="Esta página não existe ou foi removida." inShell={inShell}>
      <Button asChild variant="secondary">
        <Link href="/">Ir para o Início</Link>
      </Button>
    </ErrorScreen>
  );
}

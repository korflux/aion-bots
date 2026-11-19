'use client';

// Página /bots: ponto de entrada da seção. Com bots ativos, abre a conversa do último bot aberto neste navegador
// (ou do primeiro da lista), como o login pede em F1. Sem bots, mostra o estado vazio com a Faísca dormindo e o CTA "Criar bot"
// (F5: "lista vazia com CTA"; F10 passo 9: a Faísca). O painel da seção, à esquerda, sempre lista os bots.
import { Bot } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Faisca } from '@/components/mascot/faisca';
import { EmptyState, PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { BotLoading } from './bot-states';
import { activeBots, readLastBot, refreshBots, useBots } from './bots-store';

const createAction = (
  <Button asChild variant="primary">
    <Link href="/bots/novo">Criar bot</Link>
  </Button>
);

/**
 * Lista vazia (nenhum bot, nem arquivado): a Faísca dormindo de 96 px com a entrada única (uma vez; com movimento reduzido vira pose estática), o
 * convite e o botão, em coluna central sobre o fundo do app. Só esta tela mostra a Faísca; o do painel vazio continua o texto curto. A Faísca é decorativa:
 * o título e o apoio dizem tudo. Não é um bot (não tem cor escolhida): é o Aion, então vale a cor de marca `--faisca`. Em 375 px o botão ocupa a largura da coluna.
 */
function FirstBotEmpty() {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <Faisca state="sleep" size={96} enter />
      <h2 className="text-[18px]/[26px] font-semibold text-fg">Crie seu primeiro bot</h2>
      <p className="max-w-sm text-sm text-muted">Cada bot tem nome, instruções e memória próprios.</p>
      <Button asChild variant="primary" className="max-md:w-full">
        <Link href="/bots/novo">Criar bot</Link>
      </Button>
    </div>
  );
}

export function BotsIndex() {
  const { status, bots } = useBots();
  const router = useRouter();
  const hasActive = activeBots(bots).length > 0;

  // Lista pronta com bots ativos: vai para o último aberto, se ainda estiver ativo, senão para o primeiro.
  useEffect(() => {
    if (status !== 'ready') return;
    const active = activeBots(bots);
    const target = active.find((bot) => bot.id === readLastBot()) ?? active[0];
    if (target) router.replace(`/bots/${target.id}`);
  }, [status, bots, router]);

  return (
    <>
      <PageHeader title="Bots" />
      {status === 'error' && bots.length === 0 ? (
        <EmptyState
          icon={Bot}
          action={
            <Button variant="secondary" onClick={() => void refreshBots()}>
              Tentar novamente
            </Button>
          }
        >
          Não foi possível carregar os bots.
        </EmptyState>
      ) : status !== 'ready' || hasActive ? (
        // Carregando, ou a caminho da conversa do bot: esqueleto em vez de um estado vazio que piscaria.
        <BotLoading label="Carregando bots" />
      ) : bots.length === 0 ? (
        <FirstBotEmpty />
      ) : (
        <EmptyState icon={Bot} action={createAction}>
          Nenhum bot ativo. Crie um bot ou desarquive um em Arquivados.
        </EmptyState>
      )}
    </>
  );
}

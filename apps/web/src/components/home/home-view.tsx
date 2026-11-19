'use client';

// Início (`/`; phase 5, T5; phase 18, A19 a A21; spec F4, A7 a A9): a tela em que o app abre, em qualquer largura. No celular o cabeçalho com o logotipo e a engrenagem (abre
// o índice de Configurações; no desktop a marca é a estrela da barra de ícones, que abre esta tela). Depois, centrados na coluna, a Faísca do Aion, a saudação pelo fuso do dono
// (o `<h1>`), a pergunta "Como posso ajudar?" e o campo "Pergunte ao Aion" (`home-composer.tsx`, grande, no meio da tela e não mais fixo no rodapé). Abaixo do campo, linhas
// discretas: a aprovação que vence primeiro (só quando há pendência) e "Seus bots" com a prévia da última novidade de cada um. "Chats recentes" e o atalho de Artefatos saíram
// do Início (continuam no painel e no menu). Sem bots, a saudação e a lista dão lugar ao estado vazio com "Criar bot", ainda com o campo logo abaixo.
//
// Dados: tudo vem dos stores e das leituras que as outras telas já usam (nada novo no servidor além da prévia de `GET /api/bots`): `useLiveBots` (estado ao vivo, prévia
// e não lido), `usePendingActivities` (as pendências, na ordem em que vencem) e as preferências do shell (fuso e nome). Nenhuma seção inventa
// conteúdo enquanto carrega: uma lista só aparece com dados, e uma leitura que falha mantém o último valor ou fica de fora, sem bloquear o campo de mensagem.
//
// Saudação: depende da hora do navegador e do fuso configurado, então só é desenhada depois da hidratação e das preferências (senão o HTML do servidor traria a hora do
// servidor, ou a faixa do navegador piscaria para a do fuso do dono); a linha tem altura reservada, e o nome entra na mesma linha quando chega.
import { type BotSummary, type PendingActivity } from '@aion/shared';
import { Plus, Settings } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { PendingRow } from '@/components/activities/activity-rows';
import { usePendingActivities } from '@/components/activities/use-pending-activities';
import { BotAvatar } from '@/components/bots/bot-avatar';
import { liveStateLine } from '@/components/bots/bot-display';
import { activeBots, archivedBots, useLiveBots } from '@/components/bots/bots-store';
import { Logo } from '@/components/brand/logo';
import { useAppSettings } from '@/components/settings/settings-provider';
import { StatusBadge } from '@/components/settings/status-badge';
import { Button } from '@/components/ui/button';
import { UNREAD_LABEL, UnreadDot } from '@/components/ui/unread-dot';
import { browserTimeZone } from '@/lib/format';
import { useNow } from '@/lib/use-now';
import { HomeComposer } from './home-composer';
import { countWorking, greetingText, momentSummary, stateBadgeOf } from './home-state';

/** A hidratação já aconteceu? Falso no servidor e no primeiro quadro do navegador, verdadeiro depois: o que depende de hora ou de fuso só é desenhado então. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );
}

/**
 * A entrada animada da Faísca da saudação vale só na primeira pintura da sessão de página (design "Início", Motion): voltar ao Início não a repete. Vira verdadeiro
 * só no navegador, depois da primeira montagem (num efeito): no servidor ele nunca muda, então todo HTML sai com a entrada e a hidratação sempre concorda.
 */
let greetingEntered = false;

/** Cabeçalho do celular: o logotipo e a engrenagem de Configurações (abre o índice das 6 áreas). Fora do celular a marca é a estrela da barra de ícones. */
function HomeHeader() {
  return (
    <header className="flex h-[52px] shrink-0 items-center justify-between px-4 md:hidden">
      <Logo height={24} />
      <Button asChild variant="ghost" size="icon">
        <Link href="/configuracoes" aria-label="Configurações">
          <Settings className="size-[18px]" strokeWidth={1.5} aria-hidden />
        </Link>
      </Button>
    </header>
  );
}

/**
 * A saudação (Suposição 9), centrada: a Faísca do Aion (64 px, em `--faisca`, com o halo), "Bom dia/Boa tarde/Boa noite" no fuso do dono seguida de ", {nome}" quando ele preencheu
 * "Como te chamar", a pergunta "Como posso ajudar?" (A19) e o resumo do momento (Suposição 10), que só aparece com bots e pendências já lidos. É o `<h1>` da tela, em Fredoka (só aqui e no vazio).
 */
function Greeting({ summary }: { summary: string | null }) {
  const hydrated = useHydrated();
  const now = useNow(60_000);
  const { load } = useAppSettings();
  // `enter` fica fixo pelo valor da primeira montagem: as seguintes (voltar ao Início) já nascem sem a entrada.
  const [enter] = useState(() => !greetingEntered);
  useEffect(() => {
    greetingEntered = true;
  }, []);
  const zone = load.status === 'ready' ? load.saved.timeZone : (browserTimeZone() ?? 'UTC');
  const text = hydrated && load.status !== 'loading' ? greetingText(now, zone, load.status === 'ready' ? load.saved.ownerName : '') : '';
  return (
    <div className="flex flex-col items-center gap-3 pt-2 text-center">
      {/* O halo (`--grad-hero`) é menor aqui (160 % da Faísca, não os 260 % das telas de destaque): a coluna rola por dentro e cortaria um halo largo na borda esquerda e no topo. */}
      <div className="faisca-halo w-fit shrink-0 [&::before]:w-[160%]!">
        <BotAvatar owner={null} size={64} enter={enter} />
      </div>
      <div className="min-w-0">
        <h1 className="min-h-[30px] font-display text-display-sm text-fg">{text}</h1>
        <p className="mt-1 text-base text-muted">Como posso ajudar?</p>
        {summary === null ? null : <p className="mt-1 text-xs text-muted">{summary}</p>}
      </div>
    </div>
  );
}

/** Estado vazio (nenhum bot, nem arquivado): a Faísca dormindo de 112 px com o halo, o convite e "Criar bot". É o `<h1>` da tela, em Fredoka. */
function FirstBotEmpty() {
  return (
    <div className="flex flex-col items-center gap-3 px-2 pt-6 text-center">
      <div className="faisca-halo w-fit">
        <BotAvatar owner={null} size={112} state="sleep" enter />
      </div>
      <h1 className="font-display text-display-sm text-fg">Seus bots começam aqui</h1>
      <p className="max-w-[30ch] text-sm text-muted">Cada bot tem nome, instruções e memória próprios, e trabalha mesmo com o app fechado.</p>
      <Button asChild variant="primary" className="w-full md:w-auto">
        <Link href="/bots/novo">Criar bot</Link>
      </Button>
      <p className="text-xs text-subtle">Ou pergunte direto ao Aion no campo abaixo.</p>
    </div>
  );
}

/**
 * O cartão da aprovação que vence primeiro (Suposição 11): a mesma linha de Aprovações (`PendingRow`, link para a conversa já no cartão, onde a aprovação é respondida)
 * e, com mais de uma pendência, "Ver todas (N)" para Aprovações. Sem pendência, a seção não existe.
 */
function PendingCard({ pending, now }: { pending: readonly PendingActivity[]; now: number }) {
  const first = pending[0];
  if (first === undefined) return null;
  return (
    <section aria-label="Aguardando você" className="flex flex-col gap-2">
      <ul>
        <PendingRow item={first} now={now} />
      </ul>
      {pending.length > 1 ? (
        <Link href="/aprovacoes" className="self-end rounded-sm text-sm font-medium text-fg underline-offset-4 hover:underline">
          Ver todas ({pending.length})
        </Link>
      ) : null}
    </section>
  );
}

/**
 * Linha de um bot (Suposição 13): Faísca de 32 px no estado ao vivo (só a de um bot trabalhando ou aguardando se mexe), nome e prévia da última novidade (uma linha cada,
 * com reticências), o selo de estado (Trabalhando, Aguardando e Erro; os demais estados ficam sem selo e o texto deles vai para o leitor de tela) e a bolinha de não lido
 * (com "Novidades não lidas" para o leitor de tela). A linha inteira é o link da conversa do bot.
 */
function BotRow({ bot }: { bot: BotSummary }) {
  const badge = stateBadgeOf(bot.runState);
  return (
    <li>
      <Link
        href={`/bots/${bot.id}`}
        title={bot.name}
        className="flex min-h-12 items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-surface-hover active:bg-selected"
      >
        <BotAvatar owner={bot} size={32} state={bot.runState} className="shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm/5 font-medium text-fg">{bot.name}</span>
          <span className="truncate text-xs/4 text-muted">{bot.preview}</span>
        </span>
        {badge === null ? <span className="sr-only">{liveStateLine(bot).text}</span> : <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>}
        {bot.unread ? (
          <>
            <span className="sr-only">{UNREAD_LABEL}</span>
            <UnreadDot />
          </>
        ) : null}
      </Link>
    </li>
  );
}

/** "Seus bots": o título com "Novo bot", os bots ativos na ordem do painel do desktop e "Arquivados (N)" recolhido no fim (a bolinha de um arquivado só aparece dentro dele). */
function BotsSection({ bots }: { bots: readonly BotSummary[] }) {
  const [archivedOpen, setArchivedOpen] = useState(false);
  const active = activeBots(bots);
  const archived = archivedBots(bots);
  return (
    <section aria-labelledby="inicio-bots" className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <h2 id="inicio-bots" className="text-sm font-medium text-muted">
          Seus bots
        </h2>
        <Button asChild variant="ghost" size="sm">
          <Link href="/bots/novo">
            <Plus className="size-4" strokeWidth={1.5} aria-hidden />
            Novo bot
          </Link>
        </Button>
      </div>
      {active.length > 0 ? (
        <ul aria-labelledby="inicio-bots" className="flex flex-col">
          {active.map((bot) => (
            <BotRow key={bot.id} bot={bot} />
          ))}
        </ul>
      ) : (
        <p className="px-2 py-2 text-sm text-subtle">Nenhum bot ativo.</p>
      )}
      {archived.length > 0 ? (
        <div>
          <button
            type="button"
            aria-expanded={archivedOpen}
            aria-controls="inicio-arquivados"
            onClick={() => setArchivedOpen((open) => !open)}
            className="flex h-10 w-full items-center rounded-md px-2 text-sm font-medium text-muted transition-colors hover:bg-surface-hover"
          >
            Arquivados ({archived.length})
          </button>
          <ul id="inicio-arquivados" hidden={!archivedOpen} aria-label="Bots arquivados" className="flex flex-col">
            {archived.map((bot) => (
              <BotRow key={bot.id} bot={bot} />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/**
 * A tela do Início: junta as leituras (bots e pendências) e põe o campo "Pergunte ao Aion" no meio da coluna, entre a saudação e as linhas de pendência e de bots. A coluna rola por
 * dentro e tem a largura de leitura do resto do app, centrada. Enquanto os bots carregam, nenhuma seção de lista nem o vazio aparecem.
 */
export function HomeView() {
  const { status, bots } = useLiveBots();
  const { load: pendingLoad } = usePendingActivities();
  const now = useNow(30_000);
  const pending = pendingLoad.status === 'ready' ? pendingLoad.pending : null;
  // O vazio só vale com a lista lida e sem nenhum bot (nem arquivado): enquanto carrega, nenhuma seção de lista aparece (e nenhum vazio pisca).
  const empty = status === 'ready' && bots.length === 0;
  // O resumo precisa dos dois dados: sem as pendências ou com a lista de bots ainda por ler, ele não diz "Tudo em dia" por engano.
  const summary = status === 'ready' && pending !== null ? momentSummary({ working: countWorking(bots), approvals: pending.length }) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <HomeHeader />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-4 pb-6 md:px-6 md:pt-[12vh]">
          {empty ? <FirstBotEmpty /> : <Greeting summary={summary} />}
          {/* O campo é o `Composer` (uma fonte só, a mesma da conversa): grande, no meio, e a sessão só nasce ao enviar ou anexar (A21, `home-composer.tsx`). */}
          <div className="-mx-3 md:-mx-6">
            <HomeComposer large />
          </div>
          {empty || pending === null ? null : <PendingCard pending={pending} now={now} />}
          {bots.length > 0 ? <BotsSection bots={bots} /> : null}
        </div>
      </div>
    </div>
  );
}

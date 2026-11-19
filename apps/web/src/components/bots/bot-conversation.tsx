'use client';

// Conversa do bot em /bots/[id]: carrega o bot e entrega a conversa (mensagens, streaming e composer) a `ConversationView`.
// Bot arquivado troca o composer pela faixa "Bot arquivado" com o botão "Desarquivar" (design: estados da conversa).
import type { Bot } from '@aion/shared';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConversationView } from '@/components/conversation/conversation-view';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session-context';
import { BotLoadError, BotLoading, BotNotFound } from './bot-states';
import { unarchiveBot } from './bots-api';
import { rememberLastBot } from './bots-store';
import { useBot } from './use-bot';

/** Faixa de bot arquivado: explica o estado e oferece desarquivar; conflito de nome orienta a renomear. */
function ArchivedBanner({ bot, onRestored }: { bot: Bot; onRestored: (bot: Bot) => void }) {
  const { csrfToken } = useSession();
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);

  async function restore() {
    setBusy(true);
    setConflict(false);
    try {
      const restored = await unarchiveBot(bot.id, csrfToken);
      toast('Bot desarquivado');
      onRestored(restored);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'BOT_NAME_TAKEN') setConflict(true);
      else toast.error(error instanceof ApiError ? error.message : 'Não foi possível desarquivar.', { duration: Infinity });
      setBusy(false);
    }
  }

  return (
    <div className="px-3 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-6">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-2 rounded-lg border border-line bg-surface grad-sheen p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-medium text-fg">Bot arquivado</p>
          <Button variant="primary" size="sm" onClick={() => void restore()} disabled={busy}>
            Desarquivar
          </Button>
        </div>
        {conflict ? (
          <p className="text-sm text-danger">
            Já existe um bot ativo com esse nome.{' '}
            <Link href={`/bots/${bot.id}/editar`} className="font-medium underline underline-offset-4">
              Renomeie este bot
            </Link>{' '}
            para desarquivar.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Cabeçalho em esqueleto enquanto o bot carrega: o círculo de 32 px da Faísca e uma barra no lugar do nome, na mesma altura do cabeçalho real (52 px),
 * para a tela não pular quando o bot chega (design "Cabeçalho da conversa", estado "carregando"). Decorativo: o aviso de carregando fica no `BotLoading`.
 */
function HeaderSkeleton() {
  return (
    <div aria-hidden className="flex h-[52px] shrink-0 items-center gap-2 px-4 md:gap-3 md:px-6">
      <div className="-ml-2 size-10 shrink-0 md:hidden" />
      <div className="size-8 shrink-0 animate-pulse rounded-full bg-surface" />
      <div className="h-3.5 w-32 animate-pulse rounded-sm bg-surface" />
    </div>
  );
}

export function BotConversation({ id }: { id: string }) {
  const { load, retry, replace } = useBot(id);
  const ready = load.status === 'ready' ? load.bot : null;

  // Só bots ativos viram "o último aberto": abrir um arquivado não deve mandar /bots para ele.
  const isActive = ready !== null && ready.archivedAt === null;
  useEffect(() => {
    if (isActive) rememberLastBot(id);
  }, [id, isActive]);

  if (load.status === 'loading') {
    return (
      <>
        <HeaderSkeleton />
        <BotLoading />
      </>
    );
  }
  if (load.status === 'not-found') return <BotNotFound />;
  if (load.status === 'error') return <BotLoadError message={load.message} onRetry={retry} />;

  const { bot } = load;
  return <ConversationView owner={{ kind: 'bot', bot }} footer={bot.archivedAt ? <ArchivedBanner bot={bot} onRestored={replace} /> : null} />;
}

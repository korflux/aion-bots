'use client';
// Entrada contextual: carrega a identidade antes de montar a gestão, sem consulta global intermediária.
import { BotLoadError, BotLoading, BotNotFound } from '@/components/bots/bot-states';
import { useBot } from '@/components/bots/use-bot';
import { FilesView } from './files-view';

/** Usa os mesmos estados das demais páginas do bot e libera a lista apenas com contexto confirmado. */
export function BotFiles({ botId }: { botId: string }) {
  const { load, retry } = useBot(botId);
  if (load.status === 'loading') return <BotLoading label="Carregando bot" />;
  if (load.status === 'not-found') return <BotNotFound />;
  if (load.status === 'error') return <BotLoadError message={load.message} onRetry={retry} />;
  return <FilesView bot={load.bot} />;
}

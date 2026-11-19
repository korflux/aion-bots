// /bots/novo: editor em modo de criação (F5).
import type { Metadata } from 'next';
import { BotEditor } from '@/components/bots/bot-editor';

export const metadata: Metadata = { title: 'Novo bot' };

export default function NewBotPage() {
  return <BotEditor />;
}

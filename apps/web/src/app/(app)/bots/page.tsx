// Seção Bots: abre a conversa do último bot (ou o estado vazio com "Criar bot"). A lista fica no painel do shell.
import type { Metadata } from 'next';
import { BotsIndex } from '@/components/bots/bots-index';

export const metadata: Metadata = { title: 'Bots' };

export default function BotsPage() {
  return <BotsIndex />;
}

// Configurações → Atividade e arquivos (phase 5, T4; spec F9, Suposição 21): o armazenamento de arquivos com "Ver arquivos (N)", a porta para os Artefatos (a lista de tabelas e docs,
// phase 14, A3, no lugar da antiga Tabelas) e as execuções recentes de todos os bots e do Chat geral. A antiga Atividades redireciona para cá (`next.config.ts`); as pendências
// ("Aguardando você") saíram daqui e vivem no topo de Aprovações.
import type { Metadata } from 'next';
import { ActivitiesView } from '@/components/activities/activities-view';
import { StorageCard } from '@/components/files/storage-card';
import { SettingsArea } from '@/components/settings/settings-area';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Atividade e arquivos' };

export default function ActivityAndFilesPage() {
  return (
    <SettingsArea title="Atividade e arquivos">
      <StorageCard />
      <Link href="/artefatos" className="mx-4 block rounded-lg border border-line bg-panel p-4 focus-visible:outline-2 focus-visible:outline-focus md:mx-6"><span className="font-medium">Artefatos</span><span className="mt-1 block text-sm text-muted">Consultar, compartilhar e gerenciar as tabelas e os docs dos bots, inclusive os sem bot.</span></Link>
      <ActivitiesView />
    </SettingsArea>
  );
}

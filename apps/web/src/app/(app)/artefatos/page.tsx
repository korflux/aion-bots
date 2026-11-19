// /artefatos: a área Artefatos (phase 14, passo 6; ART-01, A1 e A2), a lista única de tabelas e docs do dono, com filtros por tipo e por bot e busca pelo título. Fica fora da barra
// inferior do celular (UI-01): alcança-se pelo ícone e pelo menu da conversa do bot, pelo atalho do Início e por Configurações → Atividade e arquivos, e "Voltar" leva ao Início.
// As listas antigas de tabelas (`/bots/:id/tabelas` e `/configuracoes/tabelas`) redirecionam para cá (`next.config.ts`).
import type { Metadata } from 'next';
import { ArtifactList } from '@/components/artifacts/artifact-list';

export const metadata: Metadata = { title: 'Artefatos' };

export default function ArtifactsPage() {
  return <ArtifactList />;
}

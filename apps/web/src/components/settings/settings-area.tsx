// Moldura das áreas de Configurações (phase 5, T4; spec F9): a coluna de 640 px (design `telas/06`) com o único `<h1>` da tela (o nome da área) e os cartões
// de cada bloco empilhados abaixo, com 16 px entre eles. Antes cada tela tinha a própria coluna e o próprio título; agora uma área reúne vários blocos
// (Conexões tem quatro), então a moldura vive aqui e os blocos (`ProviderSettings`, `ConnectorSettings` etc.) só desenham o cartão deles.
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/page';

export function SettingsArea({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4 px-4 pb-10 md:px-6">
      <PageHeader title={title} padded={false} />
      {children}
    </div>
  );
}

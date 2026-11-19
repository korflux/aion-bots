// Seção Aprovações (F10; phase 5, T4): no topo "Aguardando você" (as aprovações pendentes de todos os bots e do Chat geral, cada uma abrindo a conversa no cartão) e, abaixo, as
// regras globais por ação (permitir, perguntar, negar, neutro) das ações do Composio que o bot pode chamar (listadas antes do primeiro uso) e das já usadas, com os bots que
// têm regra própria. O badge de pendências fica na barra (shell). As duas partes são clientes: leem e alteram pela API, cada uma com a própria leitura e o próprio erro.
import type { Metadata } from 'next';
import { PendingSection } from '@/components/approvals/pending-section';
import { ApprovalRulesView } from '@/components/approvals/rules-view';
import { PageHeader } from '@/components/page';

export const metadata: Metadata = { title: 'Aprovações' };

export default function ApprovalsPage() {
  return (
    <>
      <div className="mx-auto w-full max-w-[760px] px-4 md:px-6">
        <PageHeader title="Aprovações" padded={false} />
      </div>
      <PendingSection />
      <ApprovalRulesView />
    </>
  );
}

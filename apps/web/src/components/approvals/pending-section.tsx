'use client';

// "Aguardando você" no topo de Aprovações (phase 5, T4; spec F8, Suposição 25 e decisão UI-03; design "Tela: Aprovações"): as aprovações pendentes de todos os bots e do
// chat geral, na ordem que a API dá (a que vence primeiro). Cada item é um LINK para a conversa do dono, já apontando para o cartão (`?mensagem=`): a aprovação NÃO é
// respondida aqui, para o dono ver o contexto antes de decidir. Reaproveita a linha (`PendingRow`) e a leitura (`usePendingActivities`) que viviam na tela Atividades.
// Sem pendências: "Nada aguardando você." em texto, sem Faísca (vazio de lista administrativa). Falha na primeira leitura mostra a mensagem e "Tentar novamente" só
// nesta seção: as regras globais, abaixo, continuam na tela.
//
// ponytail: a linha mostra a ação pelo nome legível (`actionLabel`, "Send Email · Gmail"); o slug do Composio que o design põe ao lado em `code` não está no contrato de
// atividades, trazê-lo pede um campo novo na API, quando o dono quiser ver o slug sem abrir a conversa.
import { PendingRow } from '@/components/activities/activity-rows';
import { usePendingActivities } from '@/components/activities/use-pending-activities';
import { Button } from '@/components/ui/button';
import { useNow } from '@/lib/use-now';

/** A seção: título, a dica de que abrir leva à conversa, as linhas das pendências (ou "Nada aguardando você.") e o estado de carga ou de erro da leitura. */
export function PendingSection() {
  const { load, retry } = usePendingActivities();
  const now = useNow(30_000);

  return (
    <section aria-labelledby="aprovacoes-aguardando" className="mx-auto w-full max-w-[760px] px-4 pb-6 md:px-6">
      <h2 id="aprovacoes-aguardando" className="text-sm font-medium text-fg">
        Aguardando você
      </h2>
      {load.status === 'loading' ? (
        <div role="status" aria-busy="true" aria-label="Carregando pendências" className="mt-2 h-11 animate-pulse rounded-md bg-surface" />
      ) : load.status === 'error' ? (
        <div className="mt-2 flex flex-col items-start gap-3">
          <p role="alert" className="text-sm text-danger">
            {load.message}
          </p>
          <Button variant="secondary" onClick={retry}>
            Tentar novamente
          </Button>
        </div>
      ) : load.pending.length === 0 ? (
        <p className="mt-1 text-sm text-muted">Nada aguardando você.</p>
      ) : (
        <>
          <p className="mb-2 mt-1 text-xs text-subtle">Abrir leva à conversa, onde a aprovação é respondida.</p>
          <ul className="flex flex-col gap-2">
            {load.pending.map((item) => (
              <PendingRow key={item.approvalId} item={item} now={now} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

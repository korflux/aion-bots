'use client';

// Tudo que o sistema conta na conversa fora da fala do bot (F6, F7, F9, F11, F12, F13), em DUAS formas (phase 18, A12 a A15; as molduras estão em `card-frame.tsx`):
//   - CARTÃO neutro (`SystemCard`), só para o que pede uma decisão ou uma retomada do dono: aprovação (`approval-card.tsx`), rotina criada ou alterada e a proposta antiga
//     (`routine-card.tsx`), falha, limite atingido e a execução de rotina que falhou, estourou o limite ou expirou;
//   - LINHA discreta (`SystemLine`), para o que só informa: execução interrompida, modelo sem ferramentas, memória e objetivo atualizados, rotina executada com sucesso (ou iniciada
//     ou interrompida), rotina perdida e os avisos de rotina confirmada, recusada ou editada. Desfazer e "Ver rotina" ficam na própria linha.
// Os próximos tipos entram como novos casos de `SystemCardMessage`, escolhendo uma das duas formas, sem criar outra moldura.
//
// Faísca nos cartões (F1 e F7 da phase 5): só falha e limite atingido (aqui, `error`), a aprovação pendente (`waiting`, em `approval-card.tsx`) e a rotina que falhou
// (o estado do desfecho, em `routine-card.tsx`) mostram a Faísca, do bot ou do Aion no Chat geral; as linhas nunca a mostram (mantêm o ícone). Cada
// cartão decide se mostra e com que estado; a moldura (`card-frame.tsx`) decide o movimento.
import type { Bot, CardView } from '@aion/shared';
import { Gauge, Square, TriangleAlert, Wrench } from 'lucide-react';
import { modelFullName } from '@/components/models/model-label';
import { useModelEntry } from '@/components/models/use-models';
import { Button } from '@/components/ui/button';
import { ApprovalCardView } from './approval-card';
import { SystemCard, SystemLine } from './card-frame';
import { ObjectiveCardView } from './objective';
import { MemoryCardView } from './memory-card';
import {
  RoutineChangeCardView,
  RoutineConfirmedCardView,
  RoutineEditedCardView,
  RoutineMissedCardView,
  RoutineProposalCardView,
  RoutineRefusedCardView,
  RoutineRunCardView,
} from './routine-card';

/** Lista curta de nomes de ações, no máximo 8 e o resto resumido. */
function StepList({ steps }: { steps: readonly string[] }) {
  const shown = steps.slice(0, 8);
  return (
    <ul className="list-disc pl-5 text-muted">
      {shown.map((step, index) => (
        <li key={`${index}-${step}`}>{step}</li>
      ))}
      {steps.length > shown.length ? <li>e mais {steps.length - shown.length}</li> : null}
    </ul>
  );
}

/** Relatório do que foi concluído antes de a execução parar. */
function CompletedSteps({ steps }: { steps: readonly string[] }) {
  if (steps.length === 0) return <p className="text-muted">Nenhuma etapa havia sido concluída.</p>;
  return (
    <>
      <p className="text-muted">Etapas concluídas:</p>
      <StepList steps={steps} />
    </>
  );
}

/** Aviso "Modelo sem ferramentas": o modelo aparece pelo nome completo (`modelFullName`, com o `display_name` dos perfis persistidos), como no seletor, e não pelo id gravado. */
function ModelWithoutToolsLine({ model }: { model: string }) {
  const name = modelFullName(model, useModelEntry(model));
  return (
    <SystemLine icon={Wrench} title="Modelo sem ferramentas" tone="warning">
      <p>
        O modelo <span className="font-mono text-[13px]">{name}</span> não chama ferramentas, então esta execução segue sem as ações do Composio.
      </p>
    </SystemLine>
  );
}

/**
 * Corpo do cartão conforme o tipo. `bot` é o dono da conversa (o id para o desfazer da memória e a rotina proposta; a cor para a Faísca dos cartões que a
 * mostram); nulo no chat geral, que não tem bot: lá a Faísca é a do Aion (`--faisca`), a aprovação só oferece "permitir uma vez" e "negar" e os cartões de
 * memória e de rotina nem são gerados. `onRetry` só vem para a última falha, quando a conversa está livre.
 */
export function SystemCardMessage({ message, bot, onRetry, objectiveVersion }: { message: CardView; bot: Bot | null; onRetry?: () => void; objectiveVersion?: number }) {
  const card = message.card;
  switch (card.type) {
    case 'run_interrupted':
      return (
        <SystemLine icon={Square} title="Execução interrompida">
          <CompletedSteps steps={card.steps} />
          {card.maybeCompleted.length > 0 ? (
            <div className="mt-2 text-warning">
              <p>Estas ações podem ter sido concluídas:</p>
              <StepList steps={card.maybeCompleted} />
            </div>
          ) : null}
        </SystemLine>
      );
    case 'run_limit':
      return (
        <SystemCard icon={Gauge} title={card.continuation?.automatic ? `Continuação automática ${card.continuation.count}/3` : "Limite atingido"} tone="warning" bot={bot} faiscaState="error" actions={card.limit === 'tokens' && !card.continuation?.automatic && onRetry ? <Button variant="secondary" size="sm" onClick={onRetry}>Continuar</Button> : null}>
          <p>{card.continuation?.automatic ? 'O Aion retomou esta etapa automaticamente. O trecho anterior ficou incompleto e as ações confirmadas foram preservadas.' : card.limit === 'steps' ? 'O limite de chamadas de ferramenta desta execução foi atingido.' : card.limit === 'tokens' ? 'A resposta atingiu o limite de saída do modelo e está incompleta. Continuar preserva as ações já concluídas.' : 'O limite de tempo ativo desta execução foi atingido.'}</p>
          <CompletedSteps steps={card.steps} />
        </SystemCard>
      );
    case 'approval':
      return <ApprovalCardView card={card} bot={bot} />;
    case 'objective_updated':
      return bot === null ? null : <ObjectiveCardView card={card} cardId={message.id} botId={bot.id} currentVersion={objectiveVersion} />;
    case 'memory_updated':
      return bot === null ? null : <MemoryCardView card={card} cardId={message.id} botId={bot.id} />;
    case 'routine_run':
      return <RoutineRunCardView card={card} bot={bot} />;
    case 'routine_missed':
      return <RoutineMissedCardView card={card} />;
    case 'routine_proposal':
      return bot === null ? null : <RoutineProposalCardView card={card} cardId={message.id} botId={bot.id} />;
    case 'routine_change':
      return bot === null ? null : <RoutineChangeCardView card={card} cardId={message.id} />;
    case 'routine_confirmed':
      return <RoutineConfirmedCardView card={card} />;
    // Avisos da phase 10 (o dono recusou ou editou, pelo cartão, o que o bot aplicou): uma linha, sem ações, como o "confirmada".
    case 'routine_refused':
      return <RoutineRefusedCardView card={card} />;
    case 'routine_edited':
      return <RoutineEditedCardView card={card} />;
    case 'model_without_tools':
      return <ModelWithoutToolsLine model={card.model} />;
    case 'run_failed':
      return (
        <SystemCard
          icon={TriangleAlert}
          title="A execução falhou"
          tone="danger"
          bot={bot}
          faiscaState="error"
          actions={
            onRetry ? (
              <Button variant="secondary" size="sm" onClick={onRetry}>
                Tentar novamente
              </Button>
            ) : null
          }
        >
          <p>{message.content}</p>
        </SystemCard>
      );
  }
}

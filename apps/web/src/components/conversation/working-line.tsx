'use client';

// Linha fixa da Faísca acima do composer (phase 18, ID-04): enquanto há execução, a Faísca trabalhando (ou aguardando, com aprovação pendente) e uma frase curta do que o bot
// faz agora. Substitui o indicador "Trabalhando…" que rolava junto com as mensagens: fica FORA da lista (que é o único contêiner que rola), então continua visível com a conversa
// rolada até o topo, no desktop e no celular. A frase vem de `workingPhrase` (fonte única em `timeline.ts`); aqui só entram o desenho e a busca do título do doc.
// O movimento é o da própria Faísca: ela só se mexe em `working` e `waiting` e para sozinha com movimento reduzido (regra global do CSS da Faísca); a frase continua mudando.
// A região é `polite` para o leitor de tela anunciar a troca sem interromper; a Faísca é decorativa.
import type { ActivityView, Bot } from '@aion/shared';
import { useEffect, useRef, useState } from 'react';
import { BotAvatar } from '@/components/bots/bot-avatar';
import { fetchDocs } from '@/components/docs/api';
import { isWaitingApproval, workingDocId, workingPhrase } from './timeline';

/**
 * Títulos dos docs, lidos da lista de docs da web (a mesma da área Artefatos) só quando a ferramenta em curso é `doc_read` e o doc ainda não é conhecido: no máximo uma leitura por
 * doc e nenhuma enquanto o bot faz outra coisa. Falha de rede ou doc fora da lista (sem acesso, excluído) deixa o título desconhecido, e a frase cai em "Trabalhando…".
 */
function useDocTitles(wanted: string | null): (docId: string) => string | null {
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(new Map());
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (wanted === null || titles.has(wanted) || asked.current.has(wanted)) return;
    asked.current.add(wanted);
    // Sem guarda de desmontagem: o React ignora o estado de um componente que saiu, e uma guarda por efeito perderia a resposta se o doc em curso mudasse antes dela chegar.
    void fetchDocs().then(
      (list) => setTitles(new Map(list.docs.map((doc) => [doc.id, doc.title]))),
      () => undefined,
    );
  }, [wanted, titles]);
  return (docId) => titles.get(docId) ?? null;
}

/** A linha da Faísca; quem a monta só a põe na tela enquanto a conversa trabalha. `activities` são as da execução ativa e `runStatus` o estado dela. */
export function WorkingLine({ bot, activities, runStatus }: { bot: Bot | null; activities: readonly ActivityView[]; runStatus: string | undefined }) {
  const docTitleOf = useDocTitles(workingDocId(activities));
  const waiting = isWaitingApproval(runStatus, activities);
  return (
    <div data-working-line="" className="shrink-0 px-3 md:px-6">
      <div className="mx-auto flex h-9 w-full max-w-[760px] items-center gap-2">
        <BotAvatar owner={bot} size={24} state={waiting ? 'waiting' : 'working'} />
        <p role="status" aria-live="polite" className="min-w-0 text-sm text-muted [overflow-wrap:anywhere]">
          {workingPhrase(activities, waiting, docTitleOf)}
        </p>
      </div>
    </div>
  );
}

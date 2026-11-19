'use client';

// Objetivo do bot na conversa: o convite de apresentação (não cria mensagem) e a linha "Objetivo atualizado" (phase 18, A12; desfazer segue a revisão, sem editor extra).
// O texto vigente do objetivo NÃO fica no cabeçalho nem no topo da conversa: ele só é lido nas configurações do bot (`bots/bot-editor.tsx`) e,
// a cada alteração, por inteiro no cartão da própria timeline.
import type { ObjectiveCard, ObjectiveView } from '@aion/shared';
import { Target } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiFetch, apiErrorMessage } from '@/lib/api-client';
import { useSession } from '@/lib/session-context';
import { SystemLine } from './card-frame';

/**
 * Convite "Qual é meu objetivo?" acima da conversa. Reivindicado uma única vez entre sessões; falha de registro mantém o composer e permite retry.
 * Some assim que o bot tem objetivo (o convite perde o sentido; o texto em si não é exibido aqui), é dispensado, o dono envia a primeira mensagem
 * ou o bot está arquivado.
 */
export function ObjectiveInvitation({ botId, objective, archived, sent }: { botId: string; objective: ObjectiveView; archived: boolean; sent: boolean }) {
  const { csrfToken } = useSession();
  const [showInvitation, setShowInvitation] = useState(!objective.invitationPresented && objective.content === '' && !archived);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!showInvitation || archived || sent || objective.content !== '') return;
    let cancelled = false;
    apiFetch<{ objective: ObjectiveView; presentedNow: boolean }>(`/api/bots/${botId}/objective/invitation`, { method: 'POST', body: {}, csrfToken }).then(
      (result) => { if (!cancelled) { setFailed(false); if (!result.presentedNow) setShowInvitation(false); } },
      () => { if (!cancelled) setFailed(true); },
    );
    return () => { cancelled = true; };
  }, [botId, csrfToken, showInvitation, archived, sent, objective.content, attempt]);
  if (objective.content !== '' || !showInvitation || archived || sent) return null;
  return <section aria-label="Objetivo do bot" className="mx-4 my-2 shrink-0 rounded-md border border-line bg-panel p-3 text-sm text-muted">
    <p>Qual é meu objetivo? Você pode me contar agora ou começar com um pedido.</p>
    <Button variant="ghost" size="sm" onClick={() => setShowInvitation(false)}>Dispensar</Button>
    {failed ? <div><p role="alert" className="text-xs text-danger">Não foi possível registrar a apresentação. Você pode continuar usando o bot.</p><Button variant="ghost" size="sm" onClick={() => setAttempt((value) => value + 1)}>Tentar novamente</Button></div> : null}
  </section>;
}

/** Linha sincronizada por mensagem e objetivo, com o texto integral da revisão (sem prévia nem disclosure); versão superada não oferece desfazer localmente. */
export function ObjectiveCardView({ card, cardId, botId, currentVersion }: { card: ObjectiveCard; cardId: string; botId: string; currentVersion?: number }) {
  const { csrfToken } = useSession();
  const [busy, setBusy] = useState(false);
  const [undoneHere, setUndoneHere] = useState(false);
  const undone = card.status === 'undone' || undoneHere;
  const superseded = currentVersion !== undefined && currentVersion !== card.version;
  /** A borda resolve texto anterior; a tela envia apenas a revisão que conhece. */
  async function undo() {
    if (busy) return;
    setBusy(true);
    try { await apiFetch<ObjectiveView>(`/api/bots/${botId}/objective/cards/${cardId}/undo`, { method: 'POST', body: { expectedVersion: card.version }, csrfToken }); setUndoneHere(true); }
    catch (error) { toast.error(apiErrorMessage(error), { duration: Infinity }); }
    finally { setBusy(false); }
  }
  return <SystemLine icon={Target} title="Objetivo atualizado" actions={undone ? <span className="text-xs text-muted">Alteração desfeita</span> : superseded ? <span className="text-xs text-muted">Atualização superada</span> : <Button variant="ghost" size="sm" disabled={busy} onClick={() => void undo()}>{busy ? 'Desfazendo…' : 'Desfazer'}</Button>}>
    <p className="whitespace-pre-wrap break-words">{card.content}</p>
  </SystemLine>;
}

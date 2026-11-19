'use client';

// Compartilhamento do doc (phase 14, passo 5; DOC-01): só o dono escolhe quais bots acessam o doc, no mesmo padrão do compartilhamento das tabelas (`sharing-editor.tsx`): um
// painel lateral com a lista de bots, a seleção que continua depois de um conflito e a revisão de acesso (`accessVersion`) como "versão esperada". Salvar troca a lista
// COMPLETA (`PUT /api/docs/:id/access`); se outra aba ou outra alteração mudou o acesso desde que a tela leu, o servidor responde `DOC_CONFLICT`, a seleção do dono é
// preservada e "Recarregar revisão" busca a revisão atual para ele salvar de novo sem refazer a escolha. Remover o último bot mantém o doc, em "Sem bot".
//
// O bot só chega ao doc pelas ferramentas `doc_*` e só se estiver na lista; revogar também tira do pedido o que ele leu do doc (proveniência, A33), regra do servidor.
import type { BotList, Doc, DocSummary } from '@aion/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { BotAvatar } from '@/components/bots/bot-avatar';
import { ConfigurationPanel } from '@/components/tables/configuration-panel';
import { Button } from '@/components/ui/button';
import { ApiError, apiErrorMessage } from '@/lib/api-client';
import { useSession } from '@/lib/session-context';
import { fetchBots, fetchDoc, shareDoc } from './api';
import { IntentLedger } from './doc-state';

interface DocSharingProps {
  doc: Pick<Doc, 'id' | 'title' | 'botIds' | 'accessVersion'>;
  onClose: () => void;
  /** O doc depois de compartilhar: a tela passa a usar a lista e a revisão novas. */
  onSaved: (doc: DocSummary) => void;
}

/** Mesma seleção, em qualquer ordem. */
const sameIds = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id) => b.includes(id));

export function DocSharing({ doc, onClose, onSaved }: DocSharingProps) {
  const { csrfToken } = useSession();
  const [selected, setSelected] = useState(doc.botIds);
  const [revision, setRevision] = useState(doc.accessVersion);
  const [bots, setBots] = useState<BotList['bots']>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  /** Aviso que não é falha (depois de recarregar a revisão). */
  const [info, setInfo] = useState('');
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Incrementar refaz a leitura dos bots (tentar de novo). */
  const [retry, setRetry] = useState(0);
  const [ledger] = useState(() => new IntentLedger());

  useEffect(() => {
    let cancelled = false;
    fetchBots().then(
      (list) => {
        if (cancelled) return;
        setBots(list.bots);
        // Um id que o servidor já não lista (bot removido numa corrida) nunca vai na gravação: o servidor o recusaria e o dono não saberia qual tirar.
        setSelected((ids) => ids.filter((id) => list.bots.some((bot) => bot.id === id)));
        setLoaded(true);
        setError('');
        setLoading(false);
      },
      (cause: unknown) => {
        if (cancelled) return;
        setError(apiErrorMessage(cause));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [retry]);

  /** Grava a seleção sobre a revisão lida. A mesma seleção e revisão reaproveitam a `operationId`: a rede perdida nunca duplica a gravação. */
  async function save() {
    if (saving) return;
    setSaving(true);
    setError('');
    setInfo('');
    try {
      const updated = await shareDoc(doc.id, ledger.stamp({ botIds: selected, expectedAccessVersion: revision }), csrfToken);
      ledger.clear();
      onSaved(updated);
      toast('Compartilhamento atualizado');
      onClose();
    } catch (cause) {
      setError(apiErrorMessage(cause));
      setConflict(cause instanceof ApiError && cause.code === 'DOC_CONFLICT');
    } finally {
      setSaving(false);
    }
  }

  /** Busca a revisão atual e os bots, preservando a seleção do dono, para ele salvar de novo sobre os acessos de agora. */
  async function reload() {
    setSaving(true);
    try {
      const [latest, list] = await Promise.all([fetchDoc(doc.id), fetchBots()]);
      setBots(list.bots);
      setSelected((ids) => ids.filter((id) => list.bots.some((bot) => bot.id === id)));
      setRevision(latest.accessVersion);
      setConflict(false);
      setError('');
      setInfo('Revise sua seleção e salve para aplicar sobre os acessos atuais.');
    } catch (cause) {
      setError(apiErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ConfigurationPanel
      title={`Compartilhar · ${doc.title}`}
      dirty={!sameIds(selected, doc.botIds)}
      busy={saving}
      onClose={onClose}
      footer={
        <Button disabled={loading || saving || conflict || !loaded} onClick={() => void save()}>
          {saving ? 'Salvando…' : 'Salvar compartilhamento'}
        </Button>
      }
    >
      <p className="text-sm">Os bots selecionados podem ler e editar este doc. A regra de aprovação continua valendo para excluí-lo.</p>
      <p className="text-sm text-muted">Remover o último bot mantém o doc em Artefatos, em Sem bot.</p>
      {loading ? (
        <p role="status">Carregando bots…</p>
      ) : (
        <ul className="space-y-3">
          {bots.map((bot) => (
            <li key={bot.id}>
              <label className="flex cursor-pointer items-start gap-3 rounded border border-line p-3">
                <input
                  type="checkbox"
                  className="mt-1 size-4 shrink-0 accent-faisca"
                  checked={selected.includes(bot.id)}
                  onChange={(event) => setSelected((ids) => (event.target.checked ? [...ids, bot.id] : ids.filter((id) => id !== bot.id)))}
                />
                <BotAvatar owner={bot} size={24} still />
                <span className="min-w-0 break-words text-sm">
                  {bot.name}
                  {bot.archivedAt ? ' · Arquivado' : ''}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {info ? (
        <p role="status" className="text-sm text-muted">
          {info}
        </p>
      ) : null}
      {conflict ? (
        <>
          <p className="text-sm">Sua seleção foi preservada. Confira a revisão atual antes de salvar novamente.</p>
          <Button variant="secondary" onClick={() => void reload()}>
            Recarregar revisão
          </Button>
        </>
      ) : null}
      {!loading && !loaded && error ? (
        <Button variant="secondary" onClick={() => setRetry((value) => value + 1)}>
          Tentar novamente
        </Button>
      ) : null}
    </ConfigurationPanel>
  );
}

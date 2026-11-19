'use client';

// "Novo doc" (phase 14, passo 5; DOC-01, A8): o dono cria um doc na área Artefatos escolhendo o título e os bots que o acessam (nenhum é permitido: o doc fica em "Sem bot" e o
// dono compartilha depois). O doc nasce vazio, com a versão 1, e a tela abre direto nele para escrever. Quem usa (a lista de Artefatos, passo 6) monta este diálogo quando o
// dono toca em "Novo doc" e o desmonta em `onClose`, como o diálogo de "Nova tabela".
//
// Título de 1 a 120 caracteres: a mensagem aparece antes de qualquer envio (`titleProblem`); o limite de 100 docs e as demais recusas vêm do servidor, que decide sob trava
// de banco, e a tela mostra a mensagem dele sem abrir nada. A `operationId` é a mesma enquanto o título e os bots não mudam: repetir depois de uma falha de rede devolve o doc já
// criado em vez de criar outro.
import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { BotList } from '@aion/shared';
import { BotAvatar } from '@/components/bots/bot-avatar';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Modal, ModalActions, ModalContent } from '@/components/ui/modal';
import { apiErrorMessage } from '@/lib/api-client';
import { useSession } from '@/lib/session-context';
import { createDoc, fetchBots } from './api';
import { IntentLedger, normalizeTitle, titleProblem } from './doc-state';

export function NewDocDialog({ onClose }: { onClose: () => void }) {
  const { csrfToken } = useSession();
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [bots, setBots] = useState<BotList['bots']>([]);
  const [loading, setLoading] = useState(true);
  const [botsError, setBotsError] = useState('');
  /** Incrementar refaz a leitura dos bots (tentar de novo). */
  const [retry, setRetry] = useState(0);
  const [problem, setProblem] = useState('');
  const [saving, setSaving] = useState(false);
  const [ledger] = useState(() => new IntentLedger());

  useEffect(() => {
    let cancelled = false;
    fetchBots().then(
      (list) => {
        if (cancelled) return;
        // Bot arquivado não ganha doc novo; os que o dono já tinha continuam nos docs existentes (Compartilhar).
        setBots(list.bots.filter((bot) => bot.archivedAt === null));
        setBotsError('');
        setLoading(false);
      },
      (cause: unknown) => {
        if (cancelled) return;
        setBotsError(apiErrorMessage(cause));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [retry]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    const message = titleProblem(title);
    if (message) {
      setProblem(message);
      return;
    }
    setProblem('');
    setSaving(true);
    try {
      const created = await createDoc(ledger.stamp({ title: normalizeTitle(title), botIds: selected }), csrfToken);
      ledger.clear();
      toast('Doc criado');
      // A navegação desmonta o diálogo; `saving` fica ligado até lá para o botão não criar um segundo doc.
      router.push(`/artefatos/docs/${created.id}`);
    } catch (cause) {
      setProblem(apiErrorMessage(cause));
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <ModalContent title="Novo doc" description="Um texto em Markdown que você e os bots escolhidos escrevem em conjunto.">
        <form onSubmit={(event) => void create(event)} className="mt-4 space-y-4">
          <div>
            <Label htmlFor="novo-doc-titulo">Título</Label>
            <Input
              id="novo-doc-titulo"
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                setProblem('');
              }}
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? 'novo-doc-erro' : undefined}
              autoComplete="off"
              disabled={saving}
            />
          </div>
          <fieldset disabled={saving} className="min-w-0 space-y-2">
            <legend className="mb-1.5 text-sm font-medium text-fg">Bots com acesso</legend>
            {loading ? (
              <p role="status" className="text-sm text-muted">
                Carregando bots…
              </p>
            ) : botsError ? (
              <div className="space-y-2">
                <p className="text-sm text-danger">{botsError}</p>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setLoading(true);
                    setRetry((value) => value + 1);
                  }}
                >
                  Tentar novamente
                </Button>
              </div>
            ) : (
              <ul className="max-h-56 space-y-2 overflow-y-auto">
                {bots.map((bot) => (
                  <li key={bot.id}>
                    <label className="flex cursor-pointer items-center gap-3 rounded border border-line p-2.5">
                      <input
                        type="checkbox"
                        className="size-4 shrink-0 accent-faisca"
                        checked={selected.includes(bot.id)}
                        onChange={(event) => setSelected((ids) => (event.target.checked ? [...ids, bot.id] : ids.filter((id) => id !== bot.id)))}
                      />
                      <BotAvatar owner={bot} size={24} still />
                      <span className="min-w-0 break-words text-sm">{bot.name}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-subtle">Sem nenhum bot, só você vê o doc. Você pode compartilhar depois.</p>
          </fieldset>
          {problem ? (
            <p id="novo-doc-erro" role="alert" className="text-sm text-danger">
              {problem}
            </p>
          ) : null}
          <ModalActions>
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              Cancelar
            </Button>
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? 'Criando…' : 'Criar doc'}
            </Button>
          </ModalActions>
        </form>
      </ModalContent>
    </Modal>
  );
}

'use client';

// Configurações → Conexões → Ferramentas (F4; phase 5, T4; phase 13, CONN-02): cartão "Composio" com o campo de chave mascarada e, com a chave salva, UMA LINHA POR CONTA
// conectada no painel do Composio (o Aion não faz OAuth): nome editável, estado (ativa, pendente, requer atenção ou desconectada) e a escolha dos bots que podem usar a conta.
// É a ÚNICA tela de edição da liberação (decisão 7 da spec): o editor do bot só a mostra, e o servidor a confere a cada execução, então nada aqui concede acesso por si só.
//
// Estados da lista: carregando, com contas, sem contas (nenhuma conta no Composio) e erro. A conta que o Composio deixou de listar continua na lista como DESCONECTADA, com o
// nome e os bots mantidos (A17), e SÓ nela aparece "Remover" (R8): reconectar o app no Composio gera outro id, então a conta antiga nunca volta e ficaria na lista para sempre. A remoção
// pede confirmação, apaga a conta e as liberações dela no servidor (que confere o estado ao vivo e recusa a conta que o Composio ainda lista) e tira a linha da lista. O nome é o valor
// que o modelo usa para escolher a conta; o campo vazio volta ao rótulo automático ("Gmail · ca_…1a2b"). A moldura e o título ficam na página.
import {
  COMPOSIO_DASHBOARD_URL,
  CONNECTOR_ACCOUNT_NAME_MAX,
  CONNECTOR_NO_APPS_MESSAGE,
  type BotSummary,
  type ConnectorAccountView,
} from '@aion/shared';
import { Blocks, ExternalLink, RefreshCw } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { BotAvatar } from '@/components/bots/bot-avatar';
import { refreshBots, useBots, type BotsState } from '@/components/bots/bots-store';
import { EmptyState } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSession } from '@/lib/session-context';
import { ConfirmDialog } from './confirm-dialog';
import {
  connectorAccountErrorMessage,
  credentialErrorMessage,
  fetchConnectorAccounts,
  isStaleAccountError,
  releaseConnectorAccount,
  removeConnectorAccount,
  renameConnectorAccount,
  useCredentialStatus,
} from './credentials-api';
import { SecretKeyField } from './secret-key-field';
import { ConnectorAccountStatusBadge } from './status-badge';

const NAME_INVALID_MESSAGE = `Nome inválido: use de 1 a ${CONNECTOR_ACCOUNT_NAME_MAX} caracteres, sem caracteres de controle.`;
const ACCESS_INVALID_MESSAGE = 'Não foi possível salvar a liberação. Recarregue as contas e tente de novo.';
const REMOVE_INVALID_MESSAGE = 'Não foi possível remover a conta. Recarregue as contas e tente de novo.';
/** A remoção recusada por a tela estar desatualizada (o Composio voltou a listar a conta, ou ela já foi removida): nada foi apagado e recarregar mostra o estado de verdade. */
const REMOVE_STALE_MESSAGE = 'Esta conta mudou desde que a lista foi carregada e não pode ser removida agora. Recarregue as contas.';

/** Link externo para o painel do Composio, aberto pelo navegador em nova aba (o servidor nunca o busca). */
function ManageAppsLink() {
  return (
    <a
      href={COMPOSIO_DASHBOARD_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 text-sm text-info underline-offset-2 hover:underline"
    >
      Gerenciar apps no Composio
      <ExternalLink className="size-4" strokeWidth={1.5} aria-hidden />
      <span className="sr-only">(abre em nova aba)</span>
    </a>
  );
}

/** Mesmos bots, independente da ordem: a liberação é um conjunto, e o botão "Salvar" só vale com uma mudança de verdade. */
const sameBotSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id) => b.includes(id));

type EditMode = 'idle' | 'name' | 'bots';
/** Para onde o foco vai quando o editor abre ou fecha (o elemento que o recebe só existe depois da troca de modo). */
type FocusTarget = 'name-input' | 'first-bot' | 'rename-button' | 'bots-button';

/**
 * Uma conta: nome (ou rótulo), app, estado e bots liberados, com dois editores em linha, um por vez: "Renomear" e "Escolher bots". A linha só mostra o que o servidor devolveu: uma gravação recusada
 * (nome em uso, nome inválido, versão antiga) mostra o erro no editor e deixa o nome e os bots como estavam. `onSaved` troca a conta pela resposta (com a versão nova) e `onStale` pede
 * a recarga das contas quando a tela ficou desatualizada, descartando os rascunhos.
 * A conta DESCONECTADA tem também "Remover" (R8), com confirmação: `onRemoved` tira a linha da lista depois que o servidor apagou a conta; uma remoção recusada mostra o erro na própria
 * linha (sem toast, que um modal aberto esconderia de leitores de tela) e, se a tela estava desatualizada, oferece recarregar as contas. Exportada só para o teste de renderização.
 */
export function AccountRow({
  account,
  bots,
  onSaved,
  onStale,
  onRemoved,
}: {
  account: ConnectorAccountView;
  bots: BotsState;
  onSaved: (account: ConnectorAccountView) => void;
  onStale: () => void;
  onRemoved: (id: string) => void;
}) {
  const { csrfToken } = useSession();
  const baseId = useId();
  const [mode, setMode] = useState<EditMode>('idle');
  const [draftName, setDraftName] = useState('');
  const [draftBots, setDraftBots] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<{ message: string; stale: boolean } | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const firstBotRef = useRef<HTMLInputElement>(null);
  const renameButtonRef = useRef<HTMLButtonElement>(null);
  const botsButtonRef = useRef<HTMLButtonElement>(null);
  const removeButtonRef = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<FocusTarget | null>(null);

  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (target === 'name-input') nameInputRef.current?.focus();
    else if (target === 'first-bot') firstBotRef.current?.focus();
    else if (target === 'rename-button') renameButtonRef.current?.focus();
    else if (target === 'bots-button') botsButtonRef.current?.focus();
  }, [mode]);

  const released = account.botIds.flatMap((id) => bots.bots.find((bot) => bot.id === id) ?? []);
  const botName = (bot: BotSummary) => (bot.archivedAt ? `${bot.name} · Arquivado` : bot.name);
  const draftNameValue = draftName.trim() === '' ? null : draftName.trim();

  function openEditor(next: 'name' | 'bots') {
    setError(null);
    setDraftName(account.name ?? '');
    setDraftBots(account.botIds);
    focusNext.current = next === 'name' ? 'name-input' : 'first-bot';
    setMode(next);
  }

  function closeEditor(returnTo: FocusTarget) {
    setError(null);
    focusNext.current = returnTo;
    setMode('idle');
  }

  /** Campo vazio vira `null` (volta ao rótulo automático); o resto vai como digitado, e o servidor valida tamanho, caracteres e unicidade dentro do app. */
  async function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || draftNameValue === account.name) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await renameConnectorAccount(account.id, { name: draftNameValue, expectedVersion: account.version }, csrfToken);
      onSaved(updated);
      toast('Nome da conta salvo');
      closeEditor('rename-button');
    } catch (caught) {
      setError({ message: connectorAccountErrorMessage(caught, NAME_INVALID_MESSAGE), stale: isStaleAccountError(caught) });
    } finally {
      setSaving(false);
    }
  }

  /** Envia a lista COMPLETA dos bots marcados (quem foi desmarcado perde o acesso). */
  async function saveBots(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || sameBotSet(draftBots, account.botIds)) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await releaseConnectorAccount(account.id, { botIds: draftBots, expectedVersion: account.version }, csrfToken);
      onSaved(updated);
      toast('Liberação da conta atualizada');
      closeEditor('bots-button');
    } catch (caught) {
      setError({ message: connectorAccountErrorMessage(caught, ACCESS_INVALID_MESSAGE), stale: isStaleAccountError(caught) });
    } finally {
      setSaving(false);
    }
  }

  /**
   * Remove a conta desconectada depois da confirmação. O modal fecha em qualquer desfecho (aberto, esconderia o aviso de erro de leitores de tela); no sucesso a linha deixa de existir
   * (`onRemoved`), na falha o foco volta ao botão "Remover" e o erro aparece na linha: tela desatualizada (409 ou 404) pede recarregar, o resto mostra a mensagem segura da API.
   */
  async function removeAccount() {
    if (removing) return;
    setRemoving(true);
    setError(null);
    try {
      await removeConnectorAccount(account.id, csrfToken);
      setConfirmingRemoval(false);
      onRemoved(account.id);
    } catch (caught) {
      setConfirmingRemoval(false);
      const stale = isStaleAccountError(caught);
      setError({ message: stale ? REMOVE_STALE_MESSAGE : connectorAccountErrorMessage(caught, REMOVE_INVALID_MESSAGE), stale });
    } finally {
      setRemoving(false);
    }
  }

  const errorId = `${baseId}-error`;
  const errorBlock = (
    <div className="flex flex-col items-start gap-2">
      <p id={errorId} role="alert" className="min-h-4 text-xs text-danger">
        {error?.message}
      </p>
      {error?.stale ? (
        <Button size="sm" onClick={onStale}>
          Recarregar contas
        </Button>
      ) : null}
    </div>
  );

  return (
    <li aria-labelledby={`${baseId}-label`} className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <p id={`${baseId}-label`} className="break-words text-sm font-medium text-fg">
            {account.label}
          </p>
          <p className="break-words text-xs text-subtle">{account.appName}</p>
        </div>
        <ConnectorAccountStatusBadge status={account.status} />
      </div>
      {account.status === 'disconnected' ? (
        <p className="mt-1 text-xs text-muted">
          O Composio não lista mais esta conta. O nome e os bots liberados ficam guardados, mas nenhum bot consegue usá-la. Reconectar o app no Composio cria outra conta, então esta pode ser removida.
        </p>
      ) : null}

      <div className="mt-2">
        <p className="text-xs font-medium text-muted">Bots liberados</p>
        {account.botIds.length === 0 ? (
          <p className="text-sm text-muted">Nenhum bot pode usar esta conta.</p>
        ) : bots.status === 'idle' || bots.status === 'loading' ? (
          <p role="status" className="text-sm text-muted">
            Carregando bots…
          </p>
        ) : (
          <>
            {released.length > 0 ? (
              <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1.5">
                {released.map((bot) => (
                  <li key={bot.id} className="flex min-w-0 items-center gap-1.5 text-sm text-fg">
                    <BotAvatar owner={bot} size={24} still />
                    <span className="min-w-0 break-words">{botName(bot)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {/* A lista de bots do navegador pode estar desatualizada ou ter falhado: o servidor é quem sabe quantos bots estão liberados. */}
            {released.length < account.botIds.length ? (
              <p className="text-sm text-muted">
                {bots.status === 'error' ? 'Não foi possível carregar os bots. Use Atualizar.' : 'Há bots liberados que a lista não mostra. Use Atualizar.'}
              </p>
            ) : null}
          </>
        )}
      </div>

      {mode === 'idle' ? (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button ref={renameButtonRef} aria-label={`Renomear ${account.label}`} onClick={() => openEditor('name')}>
              Renomear
            </Button>
            <Button ref={botsButtonRef} aria-label={`Escolher bots de ${account.label}`} onClick={() => openEditor('bots')}>
              Escolher bots
            </Button>
            {/* Só a conta que o Composio não lista mais: a que ele lista segue em uso e o servidor também recusaria a remoção. */}
            {account.status === 'disconnected' ? (
              <Button ref={removeButtonRef} variant="danger" aria-label={`Remover ${account.label}`} onClick={() => setConfirmingRemoval(true)}>
                Remover
              </Button>
            ) : null}
          </div>
          {error ? <div className="mt-2">{errorBlock}</div> : null}
        </>
      ) : null}
      {account.status === 'disconnected' ? (
        <ConfirmDialog
          open={confirmingRemoval}
          onOpenChange={setConfirmingRemoval}
          title={`Remover a conta “${account.label}”?`}
          description="O nome e a liberação aos bots serão apagados do Aion. Se você reconectar o app no Composio, a conta volta como uma conta nova, sem este nome nem estas liberações."
          confirmLabel="Remover conta"
          pending={removing}
          onConfirm={() => void removeAccount()}
          onCloseAutoFocus={(event) => {
            // Com a conta removida a linha (e o botão) já não existe e o foco é tratado por quem a tirou da lista; o padrão do Radix o levaria ao <body>, por isso é sempre impedido.
            event.preventDefault();
            removeButtonRef.current?.focus();
          }}
        />
      ) : null}

      {mode === 'name' ? (
        <form onSubmit={(event) => void saveName(event)} noValidate className="mt-3 flex flex-col gap-2">
          <div>
            <Label htmlFor={`${baseId}-name`}>Nome da conta</Label>
            <Input
              ref={nameInputRef}
              id={`${baseId}-name`}
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="bg-app"
              aria-invalid={error ? true : undefined}
              aria-describedby={`${baseId}-name-hint${error ? ` ${errorId}` : ''}`}
              readOnly={saving}
            />
            <p id={`${baseId}-name-hint`} className="mt-1 text-xs text-muted">
              Até {CONNECTOR_ACCOUNT_NAME_MAX} caracteres, único neste app. Vazio volta ao nome automático. É o nome que o bot usa para escolher a conta.
            </p>
          </div>
          {errorBlock}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={saving || draftNameValue === account.name}>
              Salvar nome
            </Button>
            <Button onClick={() => closeEditor('rename-button')} disabled={saving}>
              Cancelar
            </Button>
          </div>
        </form>
      ) : null}

      {mode === 'bots' ? (
        <form onSubmit={(event) => void saveBots(event)} noValidate className="mt-3 flex flex-col gap-2">
          <fieldset className="min-w-0">
            <legend className="mb-1.5 text-sm font-medium text-fg">Bots que podem usar esta conta</legend>
            {bots.bots.length === 0 ? (
              <p className="text-sm text-muted">{bots.status === 'error' ? 'Não foi possível carregar os bots. Use Atualizar.' : 'Nenhum bot criado ainda.'}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {bots.bots.map((bot, index) => (
                  <li key={bot.id}>
                    <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-line p-3">
                      <input
                        ref={index === 0 ? firstBotRef : undefined}
                        type="checkbox"
                        className="size-4 shrink-0 accent-faisca"
                        checked={draftBots.includes(bot.id)}
                        disabled={saving}
                        onChange={(event) => setDraftBots((ids) => (event.target.checked ? [...ids, bot.id] : ids.filter((id) => id !== bot.id)))}
                      />
                      <BotAvatar owner={bot} size={24} still />
                      <span className="min-w-0 break-words text-sm">{botName(bot)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
          {errorBlock}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={saving || sameBotSet(draftBots, account.botIds)}>
              Salvar liberação
            </Button>
            <Button onClick={() => closeEditor('bots-button')} disabled={saving}>
              Cancelar
            </Button>
          </div>
        </form>
      ) : null}
    </li>
  );
}

/** Lista de contas, lida ao vivo no Composio com a chave guardada. `savedAt` recarrega quando a chave é trocada. */
function ConnectedAccounts({ savedAt }: { savedAt: string | null }) {
  const bots = useBots();
  const [accounts, setAccounts] = useState<ConnectorAccountView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Incrementar força nova carga (botão "Atualizar", conflito de versão). Também entra na chave das linhas: uma recarga descarta os rascunhos abertos.
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const refreshButtonRef = useRef<HTMLButtonElement>(null);
  const focusRefreshNext = useRef(false);

  useEffect(() => {
    let cancelled = false;
    fetchConnectorAccounts().then(
      (data) => {
        if (cancelled) return;
        setAccounts(data.accounts);
        setError(null);
        setLoading(false);
      },
      (caught: unknown) => {
        if (cancelled) return;
        setAccounts(null);
        setError(credentialErrorMessage(caught));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reloadKey, savedAt]);

  function refresh() {
    setLoading(true);
    setReloadKey((key) => key + 1);
    // Os bots que a escolha oferece vêm da mesma lista do painel de Bots; recarregar as contas recarrega também essa lista.
    void refreshBots();
  }

  /** A resposta da gravação é a conta como o servidor a tem agora (versão nova incluída). A ordem da lista só muda na próxima leitura, para a linha não pular sob o cursor. */
  const replaceAccount = (updated: ConnectorAccountView) =>
    setAccounts((current) => current?.map((account) => (account.id === updated.id ? updated : account)) ?? current);

  /** O servidor já apagou a conta (204 sem corpo): a linha sai da lista e o foco vai ao "Atualizar", o controle estável mais próximo, porque a linha que o tinha deixa de existir. */
  const removeAccountFromList = (id: string) => {
    focusRefreshNext.current = true;
    setAccounts((current) => current?.filter((account) => account.id !== id) ?? current);
    toast('Conta removida');
  };

  // O foco só é movido depois da renderização (o modal de confirmação ainda prende o foco até a linha sair da árvore).
  useEffect(() => {
    if (!focusRefreshNext.current) return;
    focusRefreshNext.current = false;
    refreshButtonRef.current?.focus();
  }, [accounts]);

  const anyLive = accounts?.some((account) => account.status !== 'disconnected') ?? false;

  return (
    <div className="border-t border-line pt-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-subtle">Contas conectadas</h3>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button ref={refreshButtonRef} variant="ghost" size="icon" aria-label="Atualizar" onClick={refresh} disabled={loading}>
              <RefreshCw className={loading ? 'size-4 animate-spin' : 'size-4'} strokeWidth={1.5} aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Atualizar</TooltipContent>
        </Tooltip>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : accounts === null ? (
        <div aria-busy="true" aria-label="Carregando contas" className="flex flex-col gap-2">
          {[0, 1].map((row) => (
            <div key={row} className="h-11 animate-pulse rounded-md bg-app" />
          ))}
        </div>
      ) : accounts.length === 0 ? (
        <EmptyState icon={Blocks} action={<ManageAppsLink />}>
          {CONNECTOR_NO_APPS_MESSAGE}
        </EmptyState>
      ) : (
        <>
          {/* Só restam contas desconectadas (por exemplo, depois de trocar a chave por uma de outra conta do Composio): o aviso de sempre, antes das contas que ficaram guardadas. */}
          {anyLive ? null : <p className="mb-2 text-sm text-muted">{CONNECTOR_NO_APPS_MESSAGE}</p>}
          <ul className="divide-y divide-line border-y border-line">
            {accounts.map((account) => (
              <AccountRow key={`${reloadKey}:${account.id}`} account={account} bots={bots} onSaved={replaceAccount} onStale={refresh} onRemoved={removeAccountFromList} />
            ))}
          </ul>
          <div className="mt-3">
            <ManageAppsLink />
          </div>
        </>
      )}
    </div>
  );
}

export function ConnectorSettings() {
  const { status, error, setStatus, reload } = useCredentialStatus('connector');

  return (
    <section aria-labelledby="conector-composio" className="rounded-lg border border-line bg-surface grad-sheen p-4 md:p-5">
      <h2 id="conector-composio" className="text-sm font-semibold text-fg">
        Ferramentas · Composio
      </h2>
      <p className="mb-4 mt-1 text-sm text-muted">
        Dá aos bots as ferramentas das contas conectadas na sua conta do Composio. Cada conta só é usada pelos bots que você liberar, e um bot com mais de uma conta do mesmo app escolhe a
        conta pelo nome. O Chat geral não usa essas contas. A chave é validada no Composio, guardada cifrada no servidor e nunca volta para o navegador.
      </p>
      {error ? (
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
          <Button onClick={reload}>Tentar novamente</Button>
        </div>
      ) : status === null ? (
        <div aria-busy="true" aria-label="Carregando" className="h-24 animate-pulse rounded-md bg-app" />
      ) : (
        <div className="flex flex-col gap-4">
          <SecretKeyField
            kind="connector"
            serviceName="Composio"
            status={status}
            onStatusChange={setStatus}
            disconnectEffect="Nenhum bot recebe ferramentas do Composio a partir da próxima chamada."
          />
          {status.configured ? <ConnectedAccounts savedAt={status.updatedAt} /> : null}
        </div>
      )}
    </section>
  );
}

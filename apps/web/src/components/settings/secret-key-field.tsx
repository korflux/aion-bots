'use client';

// Campo de chave mascarada, compartilhado por Provedores (F3), Conectores (F4) e a chave opcional da Pesquisa na web, conforme o design:
//   não configurado: input de senha e "Salvar" (com spinner enquanto a API valida a chave);
//   erro: mensagem inline abaixo do campo, com o valor mantido para corrigir ou tentar de novo;
//   configurado: a versão mascarada em `mono`, o selo "Conectado" e os botões "Substituir" e "Desconectar";
//   substituindo: o campo volta vazio e a chave anterior continua valendo até a nova ser validada no servidor.
//
// Segurança: a chave digitada existe só no estado deste componente e é apagada ao salvar; a API nunca a devolve
// (só `masked`). O input é `type=password` com autocomplete desligado para gerenciadores de senha não a guardarem.
import type { CredentialKind, CredentialStatus } from '@aion/shared';
import { LoaderCircle } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { useSession } from '@/lib/session-context';
import { ConfirmDialog } from './confirm-dialog';
import {
  credentialErrorMessage,
  disconnectCredential,
  saveCredential,
  unconfiguredStatus,
} from './credentials-api';
import { StatusBadge } from './status-badge';

/** Textos que o padrão ("Chave do X salva", "X desconectado", "Desconectar X?") não acerta, como os de um serviço de gênero feminino ("a Parallel"). */
export interface SecretKeyMessages {
  saved?: string;
  disconnected?: string;
  disconnectTitle?: string;
}

export interface SecretKeyFieldProps {
  kind: CredentialKind;
  /** Nome do serviço nos textos ("OpenCode Go", "Composio"). */
  serviceName: string;
  status: CredentialStatus;
  onStatusChange: (status: CredentialStatus) => void;
  /** Efeito de desconectar, dito no modal de confirmação. */
  disconnectEffect: string;
  /** Troca os textos de salvar e desconectar (toast e título do modal); sem isso valem os padrões montados com `serviceName`. */
  messages?: SecretKeyMessages;
  /** Falso quando o cartão que hospeda o campo já mostra o selo de estado ("Conectada"); o padrão é mostrar "Conectado" ao lado da chave. */
  showBadge?: boolean;
}

export function SecretKeyField({ kind, serviceName, status, onStatusChange, disconnectEffect, messages, showBadge = true }: SecretKeyFieldProps) {
  const session = useSession();
  const fieldId = useId();
  const [value, setValue] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLButtonElement>(null);
  const disconnectRef = useRef<HTMLButtonElement>(null);
  // Para onde o foco vai quando a troca entre "formulário" e "configurado" acontece (o elemento antigo some).
  const focusNext = useRef<'input' | 'replace' | null>(null);

  const showForm = !status.configured || replacing;

  useEffect(() => {
    if (focusNext.current === 'input') inputRef.current?.focus();
    if (focusNext.current === 'replace') replaceRef.current?.focus();
    focusNext.current = null;
  }, [showForm]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || value.trim() === '') return;
    setPending(true);
    setError(null);
    try {
      const saved = await saveCredential(kind, value, session.csrfToken);
      // A chave sai da memória do componente assim que o servidor a aceita.
      setValue('');
      setReplacing(false);
      focusNext.current = 'replace';
      onStatusChange(saved);
      toast(messages?.saved ?? `Chave do ${serviceName} salva`);
    } catch (caught) {
      setError(credentialErrorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  function startReplacing() {
    setError(null);
    setValue('');
    focusNext.current = 'input';
    setReplacing(true);
  }

  function cancelReplacing() {
    setError(null);
    setValue('');
    focusNext.current = 'replace';
    setReplacing(false);
  }

  async function disconnect() {
    setDisconnecting(true);
    try {
      await disconnectCredential(kind, session.csrfToken);
      setConfirmOpen(false);
      setReplacing(false);
      setError(null);
      // O botão e o modal somem junto com a vista "configurado": o foco vai ao campo vazio que a substitui.
      focusNext.current = 'input';
      onStatusChange(unconfiguredStatus(kind));
      toast(messages?.disconnected ?? `${serviceName} desconectado`);
    } catch (caught) {
      toast.error(credentialErrorMessage(caught), { duration: Infinity });
    } finally {
      setDisconnecting(false);
    }
  }

  if (showForm) {
    const errorId = `${fieldId}-error`;
    return (
      <form onSubmit={submit} noValidate className="flex flex-col gap-3">
        <div>
          <Label htmlFor={fieldId}>Chave de API</Label>
          <Input
            ref={inputRef}
            id={fieldId}
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            className="bg-app"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            readOnly={pending}
          />
          <p id={errorId} role="alert" className="mt-1.5 min-h-4 text-xs text-danger">
            {error}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" disabled={pending || value.trim() === ''}>
            {pending ? <LoaderCircle data-icon="LoaderCircle" className="size-4 animate-spin" aria-hidden /> : null}
            Salvar
          </Button>
          {replacing ? (
            <Button variant="secondary" onClick={cancelReplacing} disabled={pending}>
              Cancelar
            </Button>
          ) : null}
          <span role="status" className="text-xs text-muted">
            {pending ? 'Validando a chave…' : ''}
          </span>
        </div>
      </form>
    );
  }

  // Só os últimos caracteres saem do servidor; "••••" não é lido bem por leitor de tela, então há texto equivalente.
  const suffix = (status.masked ?? '').replace(/^•+/, '');
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <span aria-hidden className="font-mono text-[13px]/5 text-fg">
          {status.masked}
        </span>
        <span className="sr-only">{suffix ? `Chave configurada, termina em ${suffix}` : 'Chave configurada'}</span>
        {showBadge ? <StatusBadge tone="success">Conectado</StatusBadge> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button ref={replaceRef} variant="secondary" onClick={startReplacing}>
          Substituir
        </Button>
        <Button ref={disconnectRef} variant="danger" onClick={() => setConfirmOpen(true)}>
          Desconectar
        </Button>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={messages?.disconnectTitle ?? `Desconectar ${serviceName}?`}
        description={`A chave será apagada do servidor. ${disconnectEffect}`}
        confirmLabel="Desconectar"
        pending={disconnecting}
        onConfirm={() => void disconnect()}
        onCloseAutoFocus={(event) => {
          // Cancelar devolve o foco ao botão que abriu o modal. Ao confirmar, o botão já não existe (ref nula) e o
          // foco é tratado por `focusNext`; o padrão do Radix o levaria ao <body>, por isso é sempre impedido.
          event.preventDefault();
          disconnectRef.current?.focus();
        }}
      />
    </div>
  );
}

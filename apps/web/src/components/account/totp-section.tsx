'use client';

// Configurações → Conta → Autenticador (F2): o estado (inativo ou ativo), o modal de ativação com QR e segredo, e a
// desativação confirmada com um código atual. A regra está toda na API (core): aqui só se coleta o código e se
// mostra o resultado. O segredo chega ao navegador uma única vez, no modal de ativação, e só é gravado como ativo
// pelo servidor depois do código válido; depois disso nenhuma resposta o devolve.
import { TOTP_DIGITS, type TotpSetupResponse, type TotpStatus } from '@aion/shared';
import { Check, Copy, LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { toast } from 'sonner';
import { QrCode } from '@/components/account/qr-code';
import { Button } from '@/components/ui/button';
import { CodeInput } from '@/components/ui/code-input';
import { Label } from '@/components/ui/input';
import { Modal, ModalActions, ModalContent } from '@/components/ui/modal';
import { apiErrorMessage, apiFetch } from '@/lib/api-client';
import { useSession } from '@/lib/session-context';

/** Segredo em grupos de 4 caracteres, para ler e digitar no app; o valor copiado continua sem espaços. */
const groupSecret = (secret: string) => secret.match(/.{1,4}/g)?.join(' ') ?? secret;

// ---------------------------------------------------------------------------------------------------------------
// Seção: estado atual e os dois modais
// ---------------------------------------------------------------------------------------------------------------

type Dialog = 'enable' | 'disable' | null;

export function TotpSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<TotpStatus>('/api/auth/totp').then(
      (status) => {
        if (!cancelled) setEnabled(status.enabled);
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(apiErrorMessage(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadError) {
    return (
      <p role="alert" className="text-sm text-danger">
        {loadError}
      </p>
    );
  }
  if (enabled === null) {
    return <div aria-busy="true" aria-label="Carregando autenticador" className="h-14 animate-pulse rounded-md bg-surface" />;
  }

  return (
    <>
      <div className="flex min-h-14 items-center justify-between gap-3 border-y border-line py-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
            Aplicativo autenticador
            {enabled ? <span className="rounded-sm bg-success-soft px-1.5 py-0.5 text-xs font-medium text-success">Ativo</span> : null}
          </p>
          <p className="text-xs text-muted">
            {enabled
              ? 'O login pede um código de 6 dígitos além da senha.'
              : 'Adicione uma segunda etapa ao login com um app como Google Authenticator ou 1Password.'}
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setDialog(enabled ? 'disable' : 'enable')}>
          {enabled ? 'Desativar' : 'Ativar'}
        </Button>
      </div>

      {/* Os conteúdos dos modais só existem enquanto abertos (Radix), então cada abertura começa do zero. */}
      <Modal open={dialog === 'enable'} onOpenChange={(open) => !open && setDialog(null)}>
        <EnableTotpDialog
          onEnabled={() => {
            setEnabled(true);
            setDialog(null);
          }}
          onCancel={() => setDialog(null)}
        />
      </Modal>
      <Modal open={dialog === 'disable'} onOpenChange={(open) => !open && setDialog(null)}>
        <DisableTotpDialog
          onDisabled={() => {
            setEnabled(false);
            setDialog(null);
          }}
          onCancel={() => setDialog(null)}
        />
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Modal de ativação: abre a ativação, mostra QR e segredo, confirma com o primeiro código
// ---------------------------------------------------------------------------------------------------------------

function EnableTotpDialog({ onEnabled, onCancel }: { onEnabled: () => void; onCancel: () => void }) {
  // Trocar a chave remonta o corpo, o que repete a abertura da ativação (botão "Tentar de novo").
  const [attempt, setAttempt] = useState(0);
  return (
    <ModalContent
      title="Ativar autenticador"
      description="Escaneie o QR code com o app autenticador e digite o código de 6 dígitos que ele mostrar."
    >
      <EnableTotpBody key={attempt} onEnabled={onEnabled} onCancel={onCancel} onRetry={() => setAttempt((value) => value + 1)} />
    </ModalContent>
  );
}

function EnableTotpBody({ onEnabled, onCancel, onRetry }: { onEnabled: () => void; onCancel: () => void; onRetry: () => void }) {
  const session = useSession();
  const [setup, setSetup] = useState<TotpSetupResponse | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const input = useRef<HTMLInputElement>(null);

  // O campo só existe depois que a ativação abre; então ele recebe o foco aqui. Não usar `autoFocus`: ver
  // DisableTotpDialog (o Radix perderia o botão de origem e o foco não voltaria a ele ao fechar).
  useEffect(() => {
    if (setup) input.current?.focus();
  }, [setup]);

  // Abre a ativação no servidor ao montar: gera segredo e token, sem gravar nada ainda.
  useEffect(() => {
    let cancelled = false;
    apiFetch<TotpSetupResponse>('/api/auth/totp/setup', { method: 'POST', csrfToken: session.csrfToken }).then(
      (data) => {
        if (!cancelled) setSetup(data);
      },
      (caught: unknown) => {
        if (!cancelled) setSetupError(apiErrorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [session.csrfToken]);

  async function copySecret() {
    if (!setup) return;
    try {
      await navigator.clipboard.writeText(setup.secret);
      setCopy('copied');
      setTimeout(() => setCopy('idle'), 2000);
    } catch {
      setCopy('failed');
    }
  }

  async function confirm(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!setup || pending || code.length !== TOTP_DIGITS) return;
    setPending(true);
    setError(null);
    try {
      await apiFetch('/api/auth/totp/enable', {
        method: 'POST',
        csrfToken: session.csrfToken,
        body: { enrollmentToken: setup.enrollmentToken, code },
      });
      toast('Autenticador ativado');
      onEnabled();
    } catch (caught) {
      setError(apiErrorMessage(caught));
      setCode('');
      setPending(false);
      input.current?.focus();
    }
  }

  if (setupError) {
    return (
      <>
        <p role="alert" className="mt-4 text-sm text-danger">
          {setupError}
        </p>
        <ModalActions>
          <Button variant="secondary" onClick={onCancel}>
            Fechar
          </Button>
          <Button variant="primary" onClick={onRetry}>
            Tentar de novo
          </Button>
        </ModalActions>
      </>
    );
  }
  if (!setup) {
    return (
      <div aria-busy="true" aria-label="Gerando o código" className="mt-4 flex flex-col gap-4">
        <div className="mx-auto size-[232px] animate-pulse rounded-md bg-surface-hover" />
        <div className="h-9 animate-pulse rounded-md bg-surface-hover" />
      </div>
    );
  }

  return (
    <form onSubmit={(event) => void confirm(event)} className="mt-4 flex flex-col gap-4">
      <QrCode value={setup.otpauthUri} label="QR code para adicionar o Aion ao app autenticador" />

      <div>
        <p className="mb-1.5 text-sm font-medium text-fg">Sem câmera? Digite este segredo no app</p>
        <div className="flex items-start gap-2">
          <code
            data-testid="totp-secret"
            className="min-w-0 flex-1 select-all break-words rounded-md border border-line bg-app px-3 py-1.5 font-mono text-[13px]/5 text-fg"
          >
            {groupSecret(setup.secret)}
          </code>
          <Button variant="secondary" size="sm" onClick={() => void copySecret()} className="h-9">
            {copy === 'copied' ? <Check className="size-4" strokeWidth={1.5} aria-hidden /> : <Copy className="size-4" strokeWidth={1.5} aria-hidden />}
            {copy === 'copied' ? 'Copiado' : 'Copiar'}
          </Button>
        </div>
        <span role="status" className="sr-only">
          {copy === 'copied' ? 'Segredo copiado' : ''}
        </span>
        {copy === 'failed' ? (
          <p role="alert" className="mt-1 text-xs text-danger">
            Não foi possível copiar. Selecione o texto e copie manualmente.
          </p>
        ) : null}
      </div>

      <div>
        <Label htmlFor="totp-code">Código do app</Label>
        <CodeInput
          id="totp-code"
          name="code"
          ref={input}
          value={code}
          onChange={setCode}
          readOnly={pending}
          invalid={Boolean(error)}
          aria-describedby="totp-enable-error"
        />
        <div id="totp-enable-error" role="alert" className="mt-2 min-h-5 text-sm text-danger">
          {error}
        </div>
      </div>

      <ModalActions className="mt-0">
        <Button variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" variant="primary" disabled={pending || code.length !== TOTP_DIGITS}>
          {pending ? <LoaderCircle data-icon="LoaderCircle" className="size-4 animate-spin" aria-hidden /> : null}
          Confirmar
        </Button>
      </ModalActions>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Modal de desativação: pede um código atual (F2 passo 3)
// ---------------------------------------------------------------------------------------------------------------

function DisableTotpDialog({ onDisabled, onCancel }: { onDisabled: () => void; onCancel: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <ModalContent
      title="Desativar autenticador"
      description="Digite um código atual do app para confirmar. O login voltará a pedir só e-mail e senha."
      // O foco vai ao campo pelo gancho do Radix, NÃO por `autoFocus`: com `autoFocus` o Radix tomaria o próprio
      // campo como "elemento focado antes" e, ao fechar, não saberia devolver o foco ao botão que abriu o modal.
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        input.current?.focus();
      }}
    >
      <DisableTotpBody inputRef={input} onDisabled={onDisabled} onCancel={onCancel} />
    </ModalContent>
  );
}

function DisableTotpBody({
  inputRef,
  onDisabled,
  onCancel,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  onDisabled: () => void;
  onCancel: () => void;
}) {
  const session = useSession();
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function disable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || code.length !== TOTP_DIGITS) return;
    setPending(true);
    setError(null);
    try {
      await apiFetch('/api/auth/totp/disable', { method: 'POST', csrfToken: session.csrfToken, body: { code } });
      toast('Autenticador desativado');
      onDisabled();
    } catch (caught) {
      setError(apiErrorMessage(caught));
      setCode('');
      setPending(false);
      inputRef.current?.focus();
    }
  }

  return (
    <form onSubmit={(event) => void disable(event)} className="mt-4">
      <Label htmlFor="totp-disable-code">Código do app</Label>
      <CodeInput
        id="totp-disable-code"
        name="code"
        ref={inputRef}
        value={code}
        onChange={setCode}
        readOnly={pending}
        invalid={Boolean(error)}
        aria-describedby="totp-disable-error"
      />
      <div id="totp-disable-error" role="alert" className="mt-2 min-h-5 text-sm text-danger">
        {error}
      </div>
      <ModalActions>
        <Button variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" variant="danger" disabled={pending || code.length !== TOTP_DIGITS}>
          {pending ? <LoaderCircle data-icon="LoaderCircle" className="size-4 animate-spin" aria-hidden /> : null}
          Desativar
        </Button>
      </ModalActions>
    </form>
  );
}

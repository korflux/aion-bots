'use client';

// Segundo passo do login com autenticador (design "Login e TOTP"): assinatura, card de 360 px com as seis caixas de
// dígito (colagem suportada, envio automático ao completar) e o link "Voltar". O desafio da senha correta está
// num cookie HttpOnly que o JavaScript não lê; aqui só vai o código.
//
// Estados: enviando (botão com spinner); código inválido (erro inline, campo limpo e com foco); bloqueado (AUTH-04:
// desabilita até o `Retry-After`); desafio expirado (volta ao login com aviso, sem perder o destino).
//
// Assinatura (F1 e F11 da phase 5): a Faísca do login em 72 px, parada, sem entrada e com halo (continuidade da tela), e o logotipo de 36 px como único
// título (`<h1>` com o nome acessível "Aion").
import type { LoginResponse } from '@aion/shared';
import { TOTP_DIGITS } from '@aion/shared';
import { LoaderCircle } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Logo } from '@/components/brand/logo';
import { Faisca } from '@/components/mascot/faisca';
import { Button } from '@/components/ui/button';
import { CodeInput } from '@/components/ui/code-input';
import { Label } from '@/components/ui/input';
import { ApiError, apiFetch } from '@/lib/api-client';
import { useLockout } from '@/lib/auth/use-lockout';

export function TotpForm({ next }: { next: string }) {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { locked, lockFor } = useLockout();
  const input = useRef<HTMLInputElement>(null);
  const loginHref = `/login?next=${encodeURIComponent(next)}`;

  async function submit(value: string) {
    if (pending || locked || value.length !== TOTP_DIGITS) return;
    setPending(true);
    setError(null);
    try {
      await apiFetch<LoginResponse>('/api/auth/totp/verify', { method: 'POST', body: { code: value }, redirectOnExpired: false });
      // Carga completa, como no login: o layout autenticado lê a sessão já com o cookie novo.
      window.location.assign(next);
    } catch (caught) {
      const failure = caught instanceof ApiError ? caught : null;
      if (failure?.code === 'AUTH_TOTP_EXPIRED') {
        // Senha e código não cabem mais no mesmo desafio: recomeça do login, avisando o motivo.
        toast(failure.message);
        router.replace(loginHref);
        return;
      }
      setError(failure?.message ?? 'Não foi possível verificar. Tente novamente.');
      setCode('');
      if (failure?.code === 'AUTH_LOCKED') lockFor(failure.retryAfterSeconds);
      setPending(false);
      input.current?.focus();
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit(code);
  }

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-8">
      <div className="w-full max-w-[360px]">
        {/* A mesma Faísca do login, menor (72 px), parada e sem nova entrada: é a continuidade da tela anterior, não uma tela de destaque nova. */}
        <div className="faisca-halo mx-auto mb-3 w-fit">
          <Faisca size={72} still />
        </div>
        <h1 className="mb-6 flex justify-center">
          <Logo height={36} />
        </h1>
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4 rounded-lg border border-line bg-surface grad-sheen p-6">
          <div>
            <Label htmlFor="totp-login-code">Código de verificação</Label>
            <p id="totp-login-hint" className="mb-3 text-sm text-muted">
              Digite o código de 6 dígitos do seu app autenticador.
            </p>
            <CodeInput
              id="totp-login-code"
              name="code"
              ref={input}
              autoFocus
              value={code}
              onChange={setCode}
              onComplete={(value) => void submit(value)}
              readOnly={pending}
              disabled={locked}
              invalid={Boolean(error)}
              aria-describedby="totp-login-hint"
            />
          </div>
          <Button type="submit" variant="primary" className="w-full" disabled={pending || locked || code.length !== TOTP_DIGITS}>
            {pending ? <LoaderCircle data-icon="LoaderCircle" className="size-4 animate-spin" aria-hidden /> : null}
            Verificar
          </Button>
          <Link href={loginHref} className="self-center rounded-sm px-1 text-sm text-muted underline-offset-4 hover:text-fg hover:underline">
            Voltar
          </Link>
        </form>
        <div role="alert" className="mt-3 min-h-5 text-center text-sm text-danger">
          {error}
        </div>
      </div>
    </main>
  );
}

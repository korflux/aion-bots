'use client';

// Formulário de login (design "Login e TOTP"): assinatura (Faísca e logotipo), card de 360 px, e-mail, senha com mostrar/ocultar e
// "Entrar". Erro aparece inline abaixo do card (região `alert`); bloqueio desabilita o botão até o
// `Retry-After` da API. A mensagem de credencial errada vem da API e é a mesma para e-mail ou senha.
// Com o autenticador (TOTP) ativo, a senha correta leva ao segundo passo em /login/totp (ver totp-form.tsx).
//
// Assinatura (F1 e F11 da phase 5): a Faísca do Aion (cor de marca, a tela não pertence a um bot) com halo, a entrada única e o olhar que segue o cursor
// (`LoginFaisca`), e abaixo o logotipo de 36 px, que é o único título da página (`<h1>` com o nome acessível "Aion"). Tamanho da Faísca por CSS
// (`.faisca-hero`): 112 px, 96 px no celular e 72 px com a janela baixa, para os campos caberem acima do teclado.
import type { LoginResponse } from '@aion/shared';
import { Eye, EyeOff, LoaderCircle } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { Logo } from '@/components/brand/logo';
import { Faisca } from '@/components/mascot/faisca';
import { useGaze } from '@/components/mascot/use-gaze';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { ApiError, apiFetch } from '@/lib/api-client';
import { useLockout } from '@/lib/auth/use-lockout';

/**
 * Faísca do login: ociosa, com a entrada única e o olhar que segue o cursor (`useGaze`; desligado com movimento reduzido e em toque, e sem cursor ela olha à
 * frente). O vetor do olhar sai do centro da própria Faísca, por isso o `ref` está no invólucro justo dela (`w-fit`), que também leva o halo (`faisca-halo`).
 * Decorativa: o logotipo "Aion" logo abaixo é o título da tela. Sem `color`, vale a cor de marca `--faisca`, pois o login não tem cor de bot.
 */
function LoginFaisca() {
  const faiscaRef = useRef<HTMLDivElement>(null);
  const gaze = useGaze(faiscaRef);
  return (
    <div ref={faiscaRef} className="faisca-halo mx-auto mb-3 w-fit">
      <Faisca state="idle" size={112} enter gaze={gaze} className="faisca-hero" />
    </div>
  );
}

export function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { locked, lockFor } = useLockout();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || locked) return;
    setPending(true);
    setError(null);
    try {
      const result = await apiFetch<LoginResponse>('/api/auth/login', {
        method: 'POST',
        body: { email, password },
        redirectOnExpired: false,
      });
      // Carga completa (não navegação do roteador): o layout autenticado consulta a sessão já com o cookie novo.
      // Com TOTP ativo ainda não há sessão: o desafio está no cookie e o código é pedido na tela seguinte.
      window.location.assign(result.status === 'totp_required' ? `/login/totp?next=${encodeURIComponent(next)}` : next);
    } catch (caught) {
      const failure = caught instanceof ApiError ? caught : null;
      setError(failure?.message ?? 'Não foi possível entrar. Tente novamente.');
      setPassword('');
      if (failure?.code === 'AUTH_LOCKED') lockFor(failure.retryAfterSeconds);
      setPending(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-8">
      <div className="w-full max-w-[360px]">
        <LoginFaisca />
        <h1 className="mb-6 flex justify-center">
          <Logo height={36} />
        </h1>
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4 rounded-lg border border-line bg-surface grad-sheen p-6">
          <div>
            <Label htmlFor="email">E-mail</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              className="bg-app"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={error ? true : undefined}
            />
          </div>
          <div>
            <Label htmlFor="password">Senha</Label>
            <div className="relative">
              <Input
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                required
                className="bg-app pr-11"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-invalid={error ? true : undefined}
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                aria-pressed={showPassword}
                onClick={() => setShowPassword((visible) => !visible)}
                className="absolute right-0.5 top-0.5 size-8 max-md:size-8"
              >
                {showPassword ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
              </Button>
            </div>
          </div>
          <Button type="submit" variant="primary" className="w-full" disabled={pending || locked}>
            {pending ? <LoaderCircle data-icon="LoaderCircle" className="size-4 animate-spin" aria-hidden /> : null}
            Entrar
          </Button>
        </form>
        <div role="alert" className="mt-3 min-h-5 text-center text-sm text-danger">
          {error}
        </div>
      </div>
    </main>
  );
}

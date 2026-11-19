// Segundo passo do login (F1): código do autenticador. Rota pública, fora do shell, como o login. O destino
// pós-login vem em `?next=` e é validado aqui no servidor (só caminhos internos), antes de chegar ao formulário.
// Sem desafio em cookie (vencido ou nunca emitido), o envio do código responde "expirou" e volta ao login.
import type { Metadata } from 'next';
import { TotpForm } from '@/components/auth/totp-form';
import { safeNextPath } from '@/lib/auth/next-path';

export const metadata: Metadata = { title: 'Código de verificação' };

export default async function TotpPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  return <TotpForm next={safeNextPath(typeof next === 'string' ? next : undefined)} />;
}

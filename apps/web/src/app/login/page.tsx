// Página de login (F1). Rota pública, fora do shell. O destino pós-login vem em `?next=` e é validado
// aqui no servidor (só caminhos internos), antes de chegar ao formulário.
import type { Metadata } from 'next';
import { LoginForm } from '@/components/auth/login-form';
import { safeNextPath } from '@/lib/auth/next-path';

export const metadata: Metadata = { title: 'Entrar' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  return <LoginForm next={safeNextPath(typeof next === 'string' ? next : undefined)} />;
}

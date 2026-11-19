// Configurações → Conta e segurança (F1; phase 5, T4): e-mail do dono, autenticador (TOTP), sessões por dispositivo e sair. A antiga Conta redireciona para cá (`next.config.ts`).
import type { Metadata } from 'next';
import { AccountPanel } from '@/components/account/account-panel';
import { SettingsArea } from '@/components/settings/settings-area';

export const metadata: Metadata = { title: 'Conta e segurança' };

export default function AccountPage() {
  return (
    <SettingsArea title="Conta e segurança">
      <AccountPanel />
    </SettingsArea>
  );
}

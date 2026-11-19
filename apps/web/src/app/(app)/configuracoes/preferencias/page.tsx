// Configurações → Preferências (phase 5, T4; spec F9, Suposições 21 e 22): Idioma das respostas, Fuso horário e o modelo padrão do Chat geral, cada um gravando ao mudar.
// Reúne as antigas Idioma e fuso e Chat geral, que redirecionam para cá (`next.config.ts`). "Como te chamar" mora em Personalização desde a T10.
import type { Metadata } from 'next';
import { PreferencesSettings } from '@/components/settings/preferences-settings';
import { SettingsArea } from '@/components/settings/settings-area';

export const metadata: Metadata = { title: 'Preferências' };

export default function PreferencesPage() {
  return (
    <SettingsArea title="Preferências">
      <PreferencesSettings />
    </SettingsArea>
  );
}

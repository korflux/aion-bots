// Configurações → Notificações (F14; phase 5, T4: dentro da moldura das áreas): ativar o push neste navegador, ver ou remover os dispositivos registrados e silenciar avisos por bot.
import type { Metadata } from 'next';
import { NotificationsPanel } from '@/components/push/notifications-panel';
import { SettingsArea } from '@/components/settings/settings-area';

export const metadata: Metadata = { title: 'Notificações' };

export default function NotificationsPage() {
  return (
    <SettingsArea title="Notificações">
      <NotificationsPanel />
    </SettingsArea>
  );
}

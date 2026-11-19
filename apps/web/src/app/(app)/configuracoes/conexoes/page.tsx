// Configurações → Conexões (phase 5, T4; spec F9, Suposição 21): as chaves e os serviços externos do Aion num lugar só, na ordem Provedores de IA (OpenCode Go e Anthropic, esta opcional), Ferramentas
// (Composio), Pesquisa na web (Parallel) e, por último, Python (serviço sandbox opcional, com estado). Reúne as antigas Provedores, Conectores, Pesquisa na web e Python,
// que redirecionam para cá (`next.config.ts`).
import type { Metadata } from 'next';
import { ConnectorSettings } from '@/components/settings/connector-settings';
import { AnthropicSettings, ProviderSettings } from '@/components/settings/provider-settings';
import { PythonSettings } from '@/components/settings/python-settings';
import { SettingsArea } from '@/components/settings/settings-area';
import { WebSearchSettings } from '@/components/settings/web-search-settings';

export const metadata: Metadata = { title: 'Conexões' };

export default function ConnectionsPage() {
  return (
    <SettingsArea title="Conexões">
      <ProviderSettings />
      <AnthropicSettings />
      <ConnectorSettings />
      <WebSearchSettings />
      <PythonSettings />
    </SettingsArea>
  );
}

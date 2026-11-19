// /configuracoes é o índice das 6 áreas de Configurações (phase 5, T4; spec F9): cada linha com a descrição e o estado atual da área. Antes redirecionava para Conta.
import type { Metadata } from 'next';
import { SettingsIndex } from '@/components/settings/settings-index';

export const metadata: Metadata = { title: 'Configurações' };

export default function SettingsIndexPage() {
  return <SettingsIndex />;
}

// Configurações → Personalização (phase 5, T4 e T10; spec F9, Suposição 21): "Como te chamar" (o nome da saudação do Início, que grava ao mudar) e as Regras globais (a antiga
// memória global), lidas por todos os bots e pelo Chat geral e editadas só pelo dono, com Histórico e Salvar. A antiga Regras globais redireciona para cá (`next.config.ts`).
// A tela é o próprio editor, que tem o título da página e as ações; o cartão do nome entra nele como `intro`.
import type { Metadata } from 'next';
import { GlobalMemory } from '@/components/memory/memory-editor';
import { OwnerNameSettings } from '@/components/settings/owner-name-settings';

export const metadata: Metadata = { title: 'Personalização' };

export default function PersonalizationPage() {
  return <GlobalMemory intro={<OwnerNameSettings />} />;
}

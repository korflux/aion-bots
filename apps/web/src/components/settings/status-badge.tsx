// Selo de estado do kit (design.md): pílula `caption` com fundo `-soft` e o texto na cor do estado. O tom `neutral` (fundo `--bg-surface-hover`, texto
// `--text-muted`) é o de um estado sem juízo, como "Uso anônimo" da Pesquisa na web.
import type { ConnectorAccountStatus } from '@aion/shared';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type BadgeTone = 'success' | 'warning' | 'danger' | 'neutral';

const TONES: Record<BadgeTone, string> = {
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  neutral: 'bg-surface-hover text-muted',
};

export function StatusBadge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return <span className={cn('rounded-sm px-1.5 py-0.5 text-xs font-medium', TONES[tone])}>{children}</span>;
}

/**
 * Texto e tom de cada um dos quatro estados de uma conta do conector (phase 13, CONN-02). É a fonte única: a tela de Conexões (`connector-settings.tsx`) e a seção só leitura do editor do bot
 * (`bot-connector-accounts.tsx`) mostram o mesmo selo pela mesma tabela, então mudar um texto ou um tom é uma edição só. O estado é sempre dito em texto, nunca só pela cor.
 */
const ACCOUNT_STATUS: Record<ConnectorAccountStatus, { label: string; tone: BadgeTone }> = {
  active: { label: 'Ativa', tone: 'success' },
  pending: { label: 'Pendente', tone: 'warning' },
  attention: { label: 'Requer atenção', tone: 'danger' },
  // Sem juízo de cor: não é uma falha da conta, é a conta que o Composio não lista mais (removida lá ou chave trocada). Ela mantém o nome e a liberação, mas a execução nela é recusada,
  // então o selo avisa em vez de esconder a conta; o texto da linha explica o efeito.
  disconnected: { label: 'Desconectada', tone: 'neutral' },
};

/** Selo do estado de uma conta do conector, com o texto e o tom da tabela única acima. */
export function ConnectorAccountStatusBadge({ status }: { status: ConnectorAccountStatus }) {
  const { label, tone } = ACCOUNT_STATUS[status];
  return <StatusBadge tone={tone}>{label}</StatusBadge>;
}

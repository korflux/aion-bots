// O estado de cada área de Configurações como o índice o mostra (phase 5, T4; spec F9 e Suposição 24), em funções PURAS sobre o que cada leitura devolveu.
// Cada função recebe `null` quando a leitura daquela área ainda não chegou ou falhou e devolve `null` nesse caso: a linha do índice aparece sem estado,
// sem bloquear as outras (Suposição 24). As frases são as do design (`telas/06`).
import { LANGUAGES, MEMORY_MAX_CHARS, countChars, hasModelProvider, type AppSettings, type CredentialsOverview } from '@aion/shared';
import { attachmentSize } from '@/components/conversation/attachment-list';

/** Conexões: o que falta ligar entre o provedor de IA e o Composio (a chave da pesquisa na web e o Python são opcionais e não entram). */
export function connectionsState(overview: CredentialsOverview | null): string | null {
  if (overview === null) return null;
  if (!hasModelProvider(overview)) return 'Provedor não configurado';
  if (!overview.connector.configured) return 'Composio não conectado';
  return 'Tudo conectado';
}

/** Preferências: "{idioma} · {modelo do Chat geral}" ou o aviso de que o modelo (obrigatório para o Chat geral) ainda não foi definido. */
export function preferencesState(settings: AppSettings | null, chatModel: { model: string | null } | null): string | null {
  if (settings === null || chatModel === null) return null;
  return chatModel.model === null ? 'Modelo do Chat geral não definido' : `${LANGUAGES[settings.language].label} · ${chatModel.model}`;
}

/**
 * Personalização: o tamanho das Regras globais contra o limite de caracteres, precedido do "Como te chamar" quando o dono o preencheu ("Marco · 1.024 / 8.000 caracteres"). O nome é
 * opcional na frase: sem ele (vazio) ou com as preferências ainda não lidas (`null`) fica só o tamanho das regras. Sem as regras lidas não há estado nenhum (o nome sozinho não
 * diria o que a área guarda).
 */
export function personalizationState(content: string | null, ownerName: string | null = null): string | null {
  if (content === null) return null;
  const size = `${countChars(content).toLocaleString('pt-BR')} / ${MEMORY_MAX_CHARS.toLocaleString('pt-BR')} caracteres`;
  return ownerName ? `${ownerName} · ${size}` : size;
}

/** Notificações: se ESTE aparelho recebe avisos (`PushStatus`: ainda lendo = sem estado; `active` e `syncing`, a renovação silenciosa do token, são ativas). */
export function notificationsState(status: string): string | null {
  if (status === 'loading') return null;
  return status === 'active' || status === 'syncing' ? 'Ativadas neste aparelho' : 'Desativadas neste aparelho';
}

/** Atividade e arquivos: o armazenamento usado contra o limite. */
export function storageState(page: { usedBytes: number; maxBytes: number } | null): string | null {
  return page === null ? null : `${attachmentSize(page.usedBytes, true)} de ${attachmentSize(page.maxBytes, true)}`;
}

/** Conta e segurança: o segundo fator. */
export function accountState(totpEnabled: boolean | null): string | null {
  if (totpEnabled === null) return null;
  return totpEnabled ? 'Autenticador ativo' : 'Autenticador desativado';
}

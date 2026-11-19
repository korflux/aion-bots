'use client';

// Índice de Configurações (`/configuracoes`; phase 5, T4; spec F9, Suposições 23 e 24; phase 18, A26): uma linha simples por área, na ordem de `SETTINGS_AREAS`, SEM cartão em volta:
// o nome e a descrição à esquerda e o VALOR atual da área à direita ("Tudo conectado", "Português (Brasil) · modelo", "1.024 / 8.000 caracteres"...; no celular o valor desce para
// baixo da descrição). A linha inteira é o link da área, separada das outras por um filete. Antes `/configuracoes` só redirecionava para Conta.
//
// O estado de cada área vem dos MESMOS endpoints que a área usa (nada novo no servidor), lidos em paralelo e cada um por conta própria: uma leitura que falha deixa só a
// linha daquela área sem estado e nunca bloqueia o índice nem as outras linhas (Suposição 24). As frases saem das funções puras de `settings-summary.ts`.
//
// ponytail: Personalização lê o texto inteiro das Regras globais (até 8.000 caracteres) e Atividade e arquivos a primeira página da lista de arquivos só para contar; trocar por
// leituras de totais se o índice ficar lento.
import type { CredentialsOverview, MemoryView, TotpStatus } from '@aion/shared';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { Fragment, useEffect, useState } from 'react';
import { fetchChatSettings } from '@/components/chat/chat-api';
import { fetchFiles } from '@/components/files/files-api';
import { fetchMemory } from '@/components/memory/memory-api';
import { usePush } from '@/components/push/push-provider';
import { PageHeader } from '@/components/page';
import { apiFetch } from '@/lib/api-client';
import { fetchCredentials } from './credentials-api';
import { SETTINGS_AREAS, type SettingsAreaId } from './settings-areas';
import { useAppSettings } from './settings-provider';
import { accountState, connectionsState, notificationsState, personalizationState, preferencesState, storageState } from './settings-summary';

/**
 * Uma leitura que pode falhar sem derrubar a tela: devolve o valor, ou `null` enquanto não chegou e se falhou (o índice não distingue os dois: a linha só fica sem
 * estado). A resposta de uma leitura que já foi desmontada é descartada.
 */
function useRead<T>(read: () => Promise<T>): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    let cancelled = false;
    read().then(
      (result) => {
        if (!cancelled) setValue(result);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [read]); // `read` é sempre uma função estável do módulo: lê-se uma vez, ao abrir o índice
  return value;
}

// As leituras de cada área, as mesmas que a área usa. Funções do módulo (estáveis): `useRead` as chama uma vez, ao abrir o índice.
const readTotp = (): Promise<TotpStatus> => apiFetch<TotpStatus>('/api/auth/totp');
const readCredentials = (): Promise<CredentialsOverview> => fetchCredentials();
const readGlobalMemory = (): Promise<MemoryView> => fetchMemory({ kind: 'global' });
const readStorage = () => fetchFiles({});

/** O estado de cada área, pelo id; `null` = sem estado (leitura em curso ou que falhou). */
function useAreaStates(): Record<SettingsAreaId, string | null> {
  const credentials = useRead(readCredentials);
  const chat = useRead(fetchChatSettings);
  const memory = useRead(readGlobalMemory);
  const storage = useRead(readStorage);
  const totp = useRead(readTotp);
  const { load } = useAppSettings();
  const { status: pushStatus } = usePush();
  return {
    conexoes: connectionsState(credentials),
    preferencias: preferencesState(load.status === 'ready' ? load.saved : null, chat),
    personalizacao: personalizationState(memory?.content ?? null, load.status === 'ready' ? load.saved.ownerName : null),
    notificacoes: notificationsState(pushStatus),
    'atividade-e-arquivos': storageState(storage),
    'conta-e-seguranca': accountState(totp?.enabled ?? null),
  };
}

/**
 * O valor da área com quebra só entre as partes separadas por " · ": cada parte é indivisível (`whitespace-nowrap`), então um id de modelo como "opencode/glm-5.1" nunca quebra no
 * hífen; o separador fica fora das partes, entre espaços comuns, que são os pontos de quebra.
 */
function AreaValue({ state }: { state: string }) {
  return state.split(' · ').map((part, index) => (
    <Fragment key={`${index}-${part}`}>
      {index > 0 ? ' · ' : null}
      <span className="whitespace-nowrap">{part}</span>
    </Fragment>
  ));
}

/** Uma linha do índice: o link da área com o nome, a descrição e o valor (sem valor quando a leitura da área falhou ou ainda não chegou). */
export function AreaRow({ area, state }: { area: (typeof SETTINGS_AREAS)[number]; state: string | null }) {
  return (
    <li className="border-b border-line last:border-b-0">
      <Link href={area.href} className="flex items-center gap-3 px-1 py-3 transition-colors hover:bg-surface-hover active:bg-selected md:px-2">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 md:flex-row md:items-baseline md:gap-4">
          <span className="min-w-0 md:flex-1">
            <span className="block text-sm font-medium text-fg">{area.label}</span>
            <span className="block text-xs text-muted">{area.description}</span>
          </span>
          {state === null ? null : <span className="min-w-0 text-xs text-fg md:max-w-[45%] md:text-right md:text-sm md:text-muted"><AreaValue state={state} /></span>}
        </span>
        <ChevronRight className="size-4 shrink-0 text-subtle" strokeWidth={1.5} aria-hidden />
      </Link>
    </li>
  );
}

/** O índice: a lista das 6 áreas em linhas de nome, descrição e valor, cada uma um link (sem valor quando a leitura da área falhou). */
export function SettingsIndex() {
  const states = useAreaStates();
  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4 px-4 pb-10 md:px-6">
      <PageHeader title="Configurações" padded={false} />
      <ul>
        {SETTINGS_AREAS.map((area) => (
          <AreaRow key={area.id} area={area} state={states[area.id]} />
        ))}
      </ul>
    </div>
  );
}

'use client';

// Gravação das preferências gerais (`AppSettings`: idioma, fuso e "Como te chamar") compartilhada pelas duas áreas que têm campos delas (phase 5, T4 e T10): Preferências
// (idioma e fuso) e Personalização ("Como te chamar"). É a FONTE ÚNICA de como um campo grava ao mudar: a fila de gravações, a leitura inicial com carregando e erro, o
// rótulo com o "Salvo" ao lado e a moldura de cartão. O retorno de cada campo (o "Salvo", o erro e "Tentar de novo") é do `field-feedback.tsx`.
//
// O servidor guarda as três preferências juntas (o PUT leva o objeto completo, `AppSettings`), então cada gravação monta o corpo com o ÚLTIMO estado confirmado
// mais o campo que mudou. As gravações vão UMA POR VEZ (fila de `useSettingsSaver`): duas em voo montariam o corpo do mesmo estado antigo e a segunda desfaria a
// primeira. O estado confirmado também vai para o provedor do shell (`useAppSettings`), de onde o ditado, a saudação do Início e a outra área o leem: mudar o nome em
// Personalização e abrir Preferências em seguida já parte do estado novo.
import type { AppSettings } from '@aion/shared';
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/input';
import { useSession } from '@/lib/session-context';
import { SavedMark, type FieldFeedback } from './field-feedback';
import { saveAppSettings } from './settings-api';
import { useAppSettings } from './settings-provider';

/** Moldura de cartão dos blocos de preferências (a mesma dos cartões das áreas de Configurações). */
export const settingsCardClass = 'rounded-lg border border-line bg-surface grad-sheen p-4 md:p-5';

/** Grava um campo das preferências gerais e devolve o estado que o servidor confirmou. */
export type SaveSettings = (patch: Partial<AppSettings>) => Promise<AppSettings>;

/**
 * Gravação das preferências gerais, uma por vez, para TODOS os campos de uma tela (um só `useSettingsSaver` por tela, repassado aos campos). `save({ campo })` envia o
 * último estado confirmado com o campo trocado e devolve o estado que o servidor confirmou (que também vai para o provedor do shell). Uma falha NÃO trava a fila: a
 * gravação seguinte parte do último estado confirmado, o que deixa de fora o campo que falhou (ele segue na tela, com o erro, até o dono tentar de novo).
 */
export function useSettingsSaver(saved: AppSettings): SaveSettings {
  const { csrfToken } = useSession();
  const { update } = useAppSettings();
  const confirmed = useRef(saved);
  useEffect(() => {
    confirmed.current = saved;
  }, [saved]);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  return useCallback(
    (patch) => {
      const run = async (): Promise<AppSettings> => {
        const result = await saveAppSettings({ ...confirmed.current, ...patch }, csrfToken);
        confirmed.current = result;
        update(result);
        return result;
      };
      const task = queue.current.then(run, run);
      queue.current = task.catch(() => undefined);
      return task;
    },
    [csrfToken, update],
  );
}

/** Rótulo do campo com o "Salvo" ao lado, na mesma linha. */
export function LabelRow({ htmlFor, children, feedback }: { htmlFor: string; children: string; feedback: FieldFeedback }) {
  return (
    <div className="mb-1.5 flex items-center justify-between gap-2">
      <Label htmlFor={htmlFor} className="mb-0">
        {children}
      </Label>
      <SavedMark feedback={feedback} />
    </div>
  );
}

/** Só existe com as preferências já lidas: cria a fila de gravação da tela e entrega o estado salvo e o `save` aos campos. */
function ReadySettings({ saved, children }: { saved: AppSettings; children: (saved: AppSettings, save: SaveSettings) => ReactNode }) {
  const save = useSettingsSaver(saved);
  return <>{children(saved, save)}</>;
}

/**
 * A leitura das preferências gerais, ou a leitura em curso / com falha e "Tentar novamente"; com elas lidas, entrega aos campos (`children`) o estado salvo e a fila de
 * gravação. Uma tela com campos de preferências gerais se escreve como `<AppSettingsGate>{(saved, save) => <campos />}</AppSettingsGate>`.
 */
export function AppSettingsGate({ children }: { children: (saved: AppSettings, save: SaveSettings) => ReactNode }) {
  const { load, retry } = useAppSettings();
  if (load.status === 'error') {
    return (
      <div className="flex flex-col items-start gap-3">
        <p role="alert" className="text-sm text-danger">
          {load.message}
        </p>
        <Button onClick={retry}>Tentar novamente</Button>
      </div>
    );
  }
  if (load.status === 'loading') return <div aria-busy="true" aria-label="Carregando" className="h-40 animate-pulse rounded-lg bg-surface" />;
  return <ReadySettings saved={load.saved}>{children}</ReadySettings>;
}

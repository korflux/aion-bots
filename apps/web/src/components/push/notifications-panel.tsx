'use client';

// Configurações → Notificações (F14; phase 5, T4: o título e a coluna são da moldura da área, `SettingsArea`; design "Tela: Configurações"): o estado do push neste navegador (ativar, negado, indisponível), com a faixa
// de instrução quando a permissão foi negada, a lista dos dispositivos registrados com "Remover", as chaves "Mostrar conteúdo nos avisos" (`ContentSwitches`, phase 16) e a
// matriz de silenciar por bot e por tipo (`MuteMatrix`, T13). O token de cada dispositivo nunca chega à tela: só o rótulo e as datas.
import { ERROR_CODES, type PushDevice } from '@aion/shared';
import { Bell, LoaderCircle, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { StatusBadge } from '@/components/settings/status-badge';
import { Button } from '@/components/ui/button';
import { apiErrorMessage } from '@/lib/api-client';
import { formatRelativeTime } from '@/lib/format';
import { ContentSwitches } from './content-switches';
import { MuteMatrix } from './mute-matrix';
import { fetchPushDevices } from './push-api';
import { usePush } from './push-provider';

const sectionTitle = 'mb-2 text-xs font-medium uppercase tracking-wide text-subtle';

/** Bloco "Este navegador": o estado do push e, quando cabe, o botão de ativar. */
function ThisBrowser() {
  const { status, enable } = usePush();
  const busy = status === 'enabling' || status === 'syncing';

  switch (status) {
    case 'loading':
      return <div aria-busy="true" aria-label="Carregando" className="h-9 w-48 animate-pulse rounded-md bg-surface" />;
    case 'unconfigured':
      return (
        <p className="text-sm text-muted">
          O servidor ainda não tem o Firebase configurado, então não há como ativar as notificações. As variáveis necessárias estão em docs/operacao.md, na seção de notificações.
        </p>
      );
    case 'unsupported':
      return (
        <p className="text-sm text-muted">
          Este navegador não oferece notificações push. No iPhone, instale o Aion na tela inicial (Compartilhar, Adicionar à Tela de Início) e abra por lá.
        </p>
      );
    case 'denied':
      // Faixa de aviso do design: a única saída é o dono liberar nas configurações do navegador, então o texto é a instrução.
      return (
        <div role="status" className="flex gap-3 rounded-md border border-warning/40 bg-warning-soft p-3">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" strokeWidth={1.5} aria-hidden />
          <p className="text-sm text-fg">{ERROR_CODES.PUSH_PERMISSION_DENIED.message}</p>
        </div>
      );
    case 'active':
      return (
        <p className="flex items-center gap-2 text-sm text-fg">
          <StatusBadge tone="success">Ativadas</StatusBadge>
          Este navegador recebe um aviso quando um bot terminar, falhar ou pedir a sua aprovação.
        </p>
      );
    default:
      return (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-muted">
            {status === 'error'
              ? 'Não foi possível ativar as notificações. Tente de novo.'
              : 'Receba um aviso quando um bot terminar, falhar ou pedir a sua aprovação. O aviso mostra o que aconteceu, ou só o nome do bot e o tipo do evento se você desligar o conteúdo abaixo.'}
          </p>
          <Button variant="primary" disabled={busy} onClick={() => void enable()}>
            {busy ? <LoaderCircle data-icon="LoaderCircle" className="size-4 animate-spin" aria-hidden /> : <Bell className="size-4" strokeWidth={1.5} aria-hidden />}
            Ativar notificações
          </Button>
        </div>
      );
  }
}

export function NotificationsPanel() {
  const { deviceId, removeDevice } = usePush();
  const [devices, setDevices] = useState<PushDevice[] | null>(null);
  // Instante da última carga: o horário relativo é calculado a partir dele, mantendo a renderização pura.
  const [loadedAt, setLoadedAt] = useState<Date>(() => new Date(0));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Incrementar força uma nova carga da lista (depois de remover um dispositivo).
  const [reloadKey, setReloadKey] = useState(0);

  // Recarrega quando este navegador acaba de se registrar (`deviceId` muda) ou depois de uma remoção.
  useEffect(() => {
    let cancelled = false;
    fetchPushDevices().then(
      (list) => {
        if (cancelled) return;
        setDevices(list);
        setLoadedAt(new Date());
        setLoadError(null);
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(apiErrorMessage(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [deviceId, reloadKey]);

  async function remove(device: PushDevice) {
    setBusyId(device.id);
    try {
      await removeDevice(device.id);
      toast('Dispositivo removido');
      setReloadKey((key) => key + 1);
    } catch (error) {
      toast.error(apiErrorMessage(error), { duration: Infinity });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="notificacoes-navegador">
        <h2 id="notificacoes-navegador" className={sectionTitle}>
          Este navegador
        </h2>
        <ThisBrowser />
      </section>

      <section aria-labelledby="notificacoes-dispositivos">
        <h2 id="notificacoes-dispositivos" className={sectionTitle}>
          Dispositivos
        </h2>
        {loadError ? (
          <p role="alert" className="text-sm text-danger">
            {loadError}
          </p>
        ) : devices === null ? (
          <div aria-busy="true" aria-label="Carregando dispositivos" className="flex flex-col gap-2">
            {[0, 1].map((row) => (
              <div key={row} className="h-11 animate-pulse rounded-md bg-surface" />
            ))}
          </div>
        ) : devices.length === 0 ? (
          <p className="text-sm text-muted">Nenhum dispositivo registrado. Ative as notificações em cada navegador ou celular que deve receber os avisos.</p>
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {devices.map((device) => (
              <li key={device.id} className="flex min-h-14 items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
                    <span className="truncate">{device.label}</span>
                    {device.id === deviceId ? <StatusBadge tone="neutral">Este navegador</StatusBadge> : null}
                  </p>
                  <p className="text-xs text-muted">Último uso: {formatRelativeTime(device.lastSeenAt, loadedAt)}</p>
                </div>
                <Button variant="secondary" size="sm" disabled={busyId === device.id} onClick={() => void remove(device)} aria-label={`Remover ${device.label}`}>
                  Remover
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ContentSwitches />

      <section aria-labelledby="notificacoes-silenciar">
        <h2 id="notificacoes-silenciar" className={sectionTitle}>
          Avisos por bot
        </h2>
        <p className="mb-3 text-sm text-muted">Desligue um tipo de aviso para silenciá-lo naquele bot. O que continua ligado segue chegando em todos os dispositivos.</p>
        <MuteMatrix />
      </section>
    </div>
  );
}

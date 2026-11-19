'use client';

// Configurações → Conexões → curadoria dos modelos de um provedor (phase 17, passo 10; UI-05, decisão 6; A7 e A8). Cada cartão de provedor com chave salva ganha uma seção "Modelos": a lista do
// que o provedor oferece, uma busca e, em cada modelo, um interruptor "Visível" ou "Oculto". Oculto sai das escolhas novas do seletor; bot, rotina, conversa e resumo que já usam o modelo seguem
// funcionando (A9). Modelo que o provedor passa a listar depois nasce visível (A8): a curadoria é só do que o dono quis esconder.
//
// `ProviderModelsView` é a parte de tela (recebe a lista já lida) e `ProviderModels` liga a lista ao servidor: lê o catálogo (o mesmo `GET /api/models` do seletor), aplica o interruptor na hora e o
// devolve se a gravação falhar. A seção começa recolhida (a lista tem até duas dezenas de linhas) e a busca só aparece aberta.
import { ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { localModelId, providerOfModel, type ModelEntry, type ModelProvider } from '@aion/shared';
import { modelName } from '@/components/models/model-label';
import { setModelHidden } from '@/components/models/models-api';
import { useModels } from '@/components/models/use-models';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { SwitchTrack } from '@/components/ui/switch-track';
import { apiErrorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/session-context';

/** Os modelos de um provedor que casam com a busca (nome, id local ou id completo, sem acento nem caixa), na ordem do servidor. Busca vazia devolve todos. */
export function providerModels(models: readonly ModelEntry[], provider: ModelProvider, query: string): ModelEntry[] {
  const needle = query.trim().toLowerCase();
  return models.filter((entry) => providerOfModel(entry.id) === provider && (needle === '' || `${modelName(entry)} ${entry.id}`.toLowerCase().includes(needle)));
}

export interface ProviderModelsViewProps {
  /** Nome do provedor nos textos ("OpenCode Go", "Anthropic"). */
  serviceName: string;
  /** Todos os modelos do provedor (sem filtro): o contador e o "ocultos" saem daqui. */
  models: readonly ModelEntry[];
  /** Os que casam com a busca (`providerModels`). */
  shown: readonly ModelEntry[];
  query: string;
  onQuery: (query: string) => void;
  open: boolean;
  onToggleOpen: () => void;
  /** Id do modelo cujo interruptor está gravando: os demais seguem livres, esse ignora cliques. */
  busyId: string | null;
  onToggle: (entry: ModelEntry) => void;
}

/** A seção de modelos de um provedor, só desenho: cabeçalho recolhível, busca e uma linha com interruptor por modelo. */
export function ProviderModelsView({ serviceName, models, shown, query, onQuery, open, onToggleOpen, busyId, onToggle }: ProviderModelsViewProps) {
  const baseId = useId();
  const hiddenCount = models.filter((entry) => entry.hidden === true).length;
  return (
    <div className="border-t border-line pt-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${baseId}-painel`}
        onClick={onToggleOpen}
        className="-mx-1 flex min-h-11 w-[calc(100%+0.5rem)] items-center justify-between gap-2 rounded-md px-1 text-left text-sm font-medium text-fg"
      >
        <span>
          Modelos ({models.length})
          {hiddenCount > 0 ? <span className="font-normal text-muted"> · {hiddenCount === 1 ? '1 oculto' : `${hiddenCount} ocultos`}</span> : null}
        </span>
        <ChevronDown aria-hidden className={cn('size-4 shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open ? (
        <div id={`${baseId}-painel`} className="mt-2 flex flex-col gap-2">
          <p className="text-xs text-muted">Oculte o que você não quer ver ao escolher um modelo. O que já usa um modelo oculto continua funcionando.</p>
          <div>
            <Label htmlFor={`${baseId}-busca`} className="sr-only">
              Buscar modelo de {serviceName}
            </Label>
            <Input id={`${baseId}-busca`} type="search" placeholder="Buscar modelo" autoComplete="off" value={query} onChange={(event) => onQuery(event.target.value)} />
          </div>
          {shown.length === 0 ? (
            <p className="py-2 text-sm text-muted">Nenhum modelo encontrado</p>
          ) : (
            <ul aria-label={`Modelos de ${serviceName}`} className="flex flex-col">
              {shown.map((entry) => {
                const visible = entry.hidden !== true;
                const name = modelName(entry);
                return (
                  <li key={entry.id} className="flex min-h-11 items-center justify-between gap-3 border-t border-line first:border-t-0">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-fg">{name}</p>
                      {entry.displayName ? <p className="truncate font-mono text-xs text-muted">{localModelId(entry.id)}</p> : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <span className="text-xs text-muted">{visible ? 'Visível' : 'Oculto'}</span>
                      {/* `aria-disabled` em vez de `disabled`: o botão desabilitado perderia o foco do teclado no meio de um uso por Espaço. */}
                      <button
                        type="button"
                        role="switch"
                        aria-checked={visible}
                        aria-label={`Mostrar ${name} ao escolher um modelo`}
                        aria-busy={busyId === entry.id || undefined}
                        aria-disabled={busyId === entry.id || undefined}
                        onClick={() => onToggle(entry)}
                        className="flex h-11 min-w-11 items-center justify-center rounded-md aria-disabled:opacity-60"
                      >
                        <SwitchTrack on={visible} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Liga a seção ao servidor: lê o catálogo, filtra o provedor, aplica o interruptor na hora e o devolve (com um aviso de erro) se a gravação falhar. */
export function ProviderModels({ provider, serviceName }: { provider: ModelProvider; serviceName: string }) {
  const session = useSession();
  const { state, upsert, reload } = useModels(true);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  if (state.status === 'error') {
    return (
      <div className="flex flex-col items-start gap-2 border-t border-line pt-3">
        <p role="alert" className="text-sm text-danger">
          Não foi possível carregar os modelos de {serviceName}.
        </p>
        <Button onClick={reload}>Tentar novamente</Button>
      </div>
    );
  }
  if (state.status === 'loading') return <div aria-busy="true" aria-label={`Carregando modelos de ${serviceName}`} className="h-11 animate-pulse rounded-md border-t border-line bg-app" />;

  async function toggle(entry: ModelEntry): Promise<void> {
    if (busyId !== null) return;
    const hidden = entry.hidden !== true;
    setBusyId(entry.id);
    upsert({ ...entry, hidden }); // o valor novo aparece já; se o servidor recusar, o anterior volta
    try {
      upsert(await setModelHidden(entry.id, hidden, session.csrfToken));
      toast(hidden ? `${modelName(entry)} oculto` : `${modelName(entry)} visível`);
    } catch (error) {
      upsert(entry);
      toast.error(apiErrorMessage(error), { duration: Infinity });
    } finally {
      setBusyId(null);
    }
  }

  const all = providerModels(state.models, provider, '');
  return (
    <ProviderModelsView
      serviceName={serviceName}
      models={all}
      shown={providerModels(state.models, provider, query)}
      query={query}
      onQuery={setQuery}
      open={open}
      onToggleOpen={() => setOpen((value) => !value)}
      busyId={busyId}
      onToggle={(entry) => void toggle(entry)}
    />
  );
}

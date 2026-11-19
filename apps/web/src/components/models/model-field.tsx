'use client';

// Campo "Modelo padrão" do editor do bot (F5) e da configuração do Chat geral (T23): o botão que mostra "<modelo> · <effort>" e abre o
// seletor de modelo (F8). No bot o modelo é opcional ("Sem modelo padrão" usa o primeiro favorito); com `required` (Chat geral) a opção
// de limpar não existe, porque o padrão é obrigatório.
// Enquanto o provedor não está configurado o campo fica desabilitado com a orientação "Configure um provedor" (não há
// lista de modelos para escolher); enquanto o estado do provedor carrega, fica desabilitado sem orientação.
// O estado do provedor vem do endpoint de credenciais (sem chamada externa); a lista de modelos só é buscada ao abrir. O nome do modelo no botão é o completo (`provedor/nome`, A28):
// o nome do provedor da Anthropic e a marca "oculto" vêm dos perfis persistidos (`useModelEntry`), que não consultam o provedor.
// ponytail: o perfil não guarda o nome da Anthropic, que vem do catálogo em memória da API. A API o aquece na subida (`void models.warmCapacity()`, `apps/api/src/bootstrap.ts:100`), então na maioria dos casos o
// nome já está lá; o botão só mostra o id local depois do prefixo se o aquecimento falhou (Anthropic fora do ar na subida) ou a chave foi salva depois, até o próximo catálogo lido (o seletor aberto ou o cache de 60 s
// vencido). Persistir `display_name` em `model_profiles` (migration aditiva) se o dono achar isso incômodo.
import { EFFORT_LABELS, hasModelProvider, type EffortLevel, type ModelEntry } from '@aion/shared';
import { ChevronDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import { fetchCredentials } from '@/components/settings/credentials-api';
import { cn } from '@/lib/cn';
import { modelFullName } from './model-label';
import { ModelSelector, type ModelChoice } from './model-selector';
import { useModelEntry } from './use-models';

type ProviderState = 'loading' | 'configured' | 'missing';

const triggerClass =
  'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-line-strong bg-surface px-3 text-sm disabled:opacity-100';

/**
 * Texto do botão: o modelo (nome completo `provedor/nome`, A28; o `entry` traz o nome do provedor da Anthropic e se o modelo está oculto, A9) com o effort quando há um, ou "Sem modelo padrão"
 * (opcional) / "Escolher modelo" (obrigatório). Sem a entrada (a lista ainda não chegou) o nome é o id local depois do prefixo.
 */
export const valueText = (model: string | null, effort: EffortLevel | null, required: boolean, entry?: Pick<ModelEntry, 'displayName' | 'hidden'> | null): string => {
  if (model === null) return required ? 'Escolher modelo' : 'Sem modelo padrão';
  const name = `${modelFullName(model, entry)}${entry?.hidden === true ? ' (oculto)' : ''}`;
  return effort === null ? name : `${name} · ${EFFORT_LABELS[effort]}`;
};

export interface ModelFieldProps extends ModelChoice {
  onChange: (choice: ModelChoice) => void;
  /** Erro de validação (servidor) do modelo ou do effort. */
  error?: string;
  /** O modelo é obrigatório: sem a opção de limpar. Padrão: opcional (o bot usa o primeiro favorito). */
  required?: boolean;
  /** Texto de ajuda sob o campo; o padrão é o do bot ("Sem modelo padrão, o bot usa o primeiro favorito."). */
  help?: string;
}

export function ModelField({ model, effort, onChange, error, required = false, help }: ModelFieldProps) {
  const [provider, setProvider] = useState<ProviderState>('loading');
  const entry = useModelEntry(model);

  useEffect(() => {
    let cancelled = false;
    fetchCredentials().then(
      (overview) => {
        if (!cancelled) setProvider(hasModelProvider(overview) ? 'configured' : 'missing');
      },
      // Sem conseguir ler o estado, deixa o seletor abrir: ele mostra o próprio erro e a saída "Tentar novamente".
      () => {
        if (!cancelled) setProvider('configured');
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const disabled = provider !== 'configured';
  const text = provider === 'missing' ? 'Configure um provedor' : provider === 'loading' ? 'Carregando…' : valueText(model, effort, required, entry);
  const helpText =
    help ??
    (provider === 'missing'
      ? 'O modelo e o effort padrão ficam disponíveis depois que o provedor estiver configurado. Sem modelo padrão, o bot usa o primeiro favorito.'
      : 'Sem modelo padrão, o bot usa o primeiro favorito.');

  // Rótulo e valor compõem o nome do botão ("Modelo padrão glm-5.1 · Alto"): um <label for> o reduziria ao rótulo.
  const trigger = (
    <button
      type="button"
      disabled={disabled}
      aria-labelledby="modelo-rotulo modelo-valor"
      aria-describedby={error ? 'modelo-ajuda modelo-erro' : 'modelo-ajuda'}
      className={cn(triggerClass, error && 'border-danger', disabled || model === null ? 'text-muted' : 'text-fg')}
    >
      <span id="modelo-valor" className="min-w-0 truncate">
        {text}
      </span>
      <ChevronDown className="size-4 shrink-0" strokeWidth={1.5} aria-hidden />
    </button>
  );

  return (
    <div>
      <span id="modelo-rotulo" className="mb-1.5 block text-sm font-medium text-fg">
        Modelo padrão
      </span>
      {disabled ? (
        trigger
      ) : (
        <ModelSelector value={{ model, effort }} onChange={onChange} noneLabel={required ? undefined : 'Sem modelo padrão'} side="bottom">
          {trigger}
        </ModelSelector>
      )}
      <p id="modelo-ajuda" className="mt-1.5 text-xs text-subtle">
        {helpText}
      </p>
      {error ? (
        <p id="modelo-erro" className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

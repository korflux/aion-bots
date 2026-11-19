'use client';

// Tela Aprovações (F10; design "Tela: Aprovações"): as ações do Composio que o bot pode chamar (o servidor as registra ao abrir a tela,
// então aparecem ANTES do primeiro uso) e as já usadas, agrupadas por app, cada uma com o controle segmentado da regra GLOBAL (Permitir,
// Perguntar, Negar, Neutro) e, abaixo, os bots que têm regra própria. A alteração vale na próxima chamada e é confirmada por toast. A
// regra do bot sempre prevalece sobre a global. Acima da busca, "Permitir tudo", "Perguntar tudo", "Negar tudo" e "Neutro tudo" aplicam a regra
// global a TODAS as ações conhecidas de uma vez (F12): o servidor decide o conjunto, então a busca não restringe o lote.
//
// O servidor é a fonte da verdade: cada alteração devolve a lista inteira e a tela passa a mostrá-la. Enquanto a chamada está
// em curso o controle já mostra a opção escolhida (feedback imediato) e volta ao valor anterior se o servidor recusar.
import { GLOBAL_RULE_VALUES, RULE_LABELS, type ActionRuleView, type ApprovalRules, type GlobalRule } from '@aion/shared';
import { SearchX, Search, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { BotAvatar } from '@/components/bots/bot-avatar';
import { EmptyState } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { apiErrorMessage } from '@/lib/api-client';
import { useSession } from '@/lib/session-context';
import { fetchApprovalRules, setAllGlobalRules, setGlobalRule } from './approvals-api';
import { BulkRuleButtons } from './bulk-rule-buttons';
import { filterActions, groupByApp } from './approvals-state';
import { SegmentedControl, type SegmentedOption } from './segmented-control';

const GLOBAL_OPTIONS: readonly SegmentedOption<GlobalRule>[] = GLOBAL_RULE_VALUES.map((value) => ({ value, label: RULE_LABELS[value] }));

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; rules: ApprovalRules };

/** O que cada categoria interna do Aion compartilha: o texto da nota depende do tipo de artefato (tabelas e docs, phase 14). */
const INTERNAL_CATEGORY_NOUN: Readonly<Record<string, string>> = { aion_tables: 'tabelas', aion_docs: 'docs' };

/**
 * Nota das categorias internas do Aion (as ações de tabelas, `aion_tables`, e de docs, `aion_docs`, não vêm do Composio): a regra global vale para os bots sem regra
 * própria, e permitir uma ação NÃO compartilha o artefato com o bot nem amplia o acesso dele (quem compartilha é o dono, em Artefatos). Outro app não leva nota.
 */
export function InternalCategoryNote({ appSlug }: { appSlug: string }) {
  const noun = INTERNAL_CATEGORY_NOUN[appSlug];
  if (!noun) return null;
  return (
    <p className="mt-2 text-xs text-muted">
      Categorias internas do Aion. A regra global vale para os bots sem regra própria; permitir não compartilha {noun} nem amplia o acesso dos bots.
    </p>
  );
}

/** "Regra própria em:" com a Faísca de cada bot a 24 px, parada (nome e regra no tooltip e no nome acessível). */
function BotRuleMarkers({ action }: { action: ActionRuleView }) {
  if (action.botRules.length === 0) return null;
  return (
    <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-subtle">
      Regra própria em:
      <span className="flex items-center gap-1.5">
        {action.botRules.map((rule) => {
          const text = `${rule.botName}: ${RULE_LABELS[rule.value]}`;
          return (
            <Tooltip key={rule.botId}>
              <TooltipTrigger asChild>
                <span role="img" aria-label={text} tabIndex={0} className="inline-flex rounded-full">
                  <BotAvatar owner={{ name: rule.botName, color: rule.botColor }} size={24} still />
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">{text}</TooltipContent>
            </Tooltip>
          );
        })}
      </span>
    </p>
  );
}

function ActionRow({ action, value, saving, onChange }: { action: ActionRuleView; value: GlobalRule; saving: boolean; onChange: (value: GlobalRule) => void }) {
  return (
    <li className="border-b border-line py-3 last:border-b-0">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between md:gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg [overflow-wrap:anywhere]">{action.label}</p>
          <p className="font-mono text-[13px]/5 text-subtle [overflow-wrap:anywhere]">{action.action}</p>
        </div>
        <SegmentedControl
          label={`Regra global de ${action.label}`}
          options={GLOBAL_OPTIONS}
          value={value}
          onChange={onChange}
          disabled={saving}
          className="w-full md:w-auto"
        />
      </div>
      <BotRuleMarkers action={action} />
    </li>
  );
}

export function ApprovalRulesView() {
  const { csrfToken } = useSession();
  const searchId = useId();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [query, setQuery] = useState('');
  /** Alterações em andamento: a opção já escolhida aparece enquanto o servidor responde. */
  const [saving, setSaving] = useState<Record<string, GlobalRule>>({});
  /** Um lote "tudo" em andamento (os botões e os controles de cada ação esperam o servidor). */
  const [bulk, setBulk] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchApprovalRules().then(
      (rules) => {
        if (!cancelled) setLoad({ status: 'ready', rules });
      },
      (error: unknown) => {
        if (!cancelled) setLoad({ status: 'error', message: apiErrorMessage(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const change = useCallback(
    async (action: ActionRuleView, value: GlobalRule) => {
      setSaving((current) => ({ ...current, [action.action]: value }));
      try {
        const rules = await setGlobalRule(action.action, value, csrfToken);
        setLoad({ status: 'ready', rules });
        toast(`Regra de ${action.label}: ${RULE_LABELS[value]}`);
      } catch (error) {
        toast.error(apiErrorMessage(error), { duration: Infinity });
      } finally {
        setSaving((current) => {
          const { [action.action]: _done, ...rest } = current;
          return rest;
        });
      }
    },
    [csrfToken],
  );

  /** "Permitir/Perguntar/Negar/Neutro tudo": uma chamada ao servidor, que aplica numa transação só e devolve a lista inteira. */
  const changeAll = useCallback(
    async (value: GlobalRule) => {
      setBulk(true);
      try {
        const rules = await setAllGlobalRules(value, csrfToken);
        setLoad({ status: 'ready', rules });
        toast(`Regra de todas as ${rules.actions.length} ações: ${RULE_LABELS[value]}`);
      } catch (error) {
        toast.error(apiErrorMessage(error), { duration: Infinity });
      } finally {
        setBulk(false);
      }
    },
    [csrfToken],
  );

  if (load.status === 'loading') {
    return (
      <div role="status" aria-busy="true" aria-label="Carregando regras" className="mx-auto flex w-full max-w-[760px] flex-col gap-3 px-4 py-4 md:px-6">
        {[0, 1, 2].map((row) => (
          <div key={row} className="h-11 animate-pulse rounded-md bg-surface" />
        ))}
      </div>
    );
  }
  if (load.status === 'error') {
    return (
      <EmptyState
        icon={SearchX}
        action={
          <Button
            variant="secondary"
            onClick={() => {
              setLoad({ status: 'loading' });
              setAttempt((value) => value + 1);
            }}
          >
            Tentar novamente
          </Button>
        }
      >
        {load.message}
      </EmptyState>
    );
  }

  const { actions } = load.rules;
  if (actions.length === 0) {
    return <EmptyState icon={ShieldCheck}>Nenhuma ação disponível ainda. Conecte o Composio e ao menos um app em Conectores para ver as ações aqui.</EmptyState>;
  }
  const visible = filterActions(actions, query);
  const groups = groupByApp(visible);

  return (
    <div className="mx-auto w-full max-w-[760px] px-4 pb-16 md:px-6">
      <h2 className="text-sm font-medium text-fg">Regras globais</h2>
      <p className="mt-1 text-xs text-subtle">A regra do bot sempre prevalece. Neutro deixa cada bot decidir.</p>

      <BulkRuleButtons
        label="Todas as ações"
        allowWarning={`As ${actions.length} ações conhecidas passam a ser permitidas sem pedir aprovação, não só as que a busca mostra, e a regra global de cada uma é substituída. Bots com regra própria continuam seguindo a deles.`}
        disabled={bulk}
        onApply={(value) => void changeAll(value)}
      />

      <div className="relative mt-4">
        <label htmlFor={searchId} className="sr-only">
          Buscar ação
        </label>
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" strokeWidth={1.5} aria-hidden />
        <Input id={searchId} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar ação ou app" autoComplete="off" className="pl-9" />
      </div>

      {groups.length === 0 ? <p className="mt-6 text-sm text-muted">Nenhuma ação encontrada para &ldquo;{query}&rdquo;.</p> : null}
      <div className="mt-4 flex flex-col gap-6">
        {groups.map((group) => (
          <section key={group.appSlug} aria-labelledby={`app-${group.appSlug}`}>
            <h3 id={`app-${group.appSlug}`} className="text-xs font-medium uppercase tracking-wide text-subtle">
              {group.appName}
            </h3>
            <InternalCategoryNote appSlug={group.appSlug} />
            <ul className="mt-1">
              {group.actions.map((action) => (
                <ActionRow
                  key={action.action}
                  action={action}
                  value={saving[action.action] ?? action.globalRule}
                  saving={bulk || action.action in saving}
                  onChange={(value) => void change(action, value)}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

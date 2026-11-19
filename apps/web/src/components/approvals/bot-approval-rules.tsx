'use client';

// Seção "Aprovações do bot" do editor (F10; design "Tela: Editor do bot"): as ações com regra PRÓPRIA do bot (nome e slug `mono`, app e
// controle segmentado Permitir, Perguntar, Negar) e o botão "Remover regra", que devolve a decisão à regra global. Sem regras:
// "Este bot segue as regras globais." As regras nascem no cartão da conversa ("Sempre permitir" e "Negar sempre") ou aqui já
// existem; mudar ou remover vale na próxima chamada do bot e é salvo na hora (não depende do botão Salvar do editor).
// Acima da lista, "Permitir tudo", "Perguntar tudo", "Negar tudo" e "Neutro tudo" (F12) valem para TODAS as ações conhecidas pelo servidor, mesmo as que a
// lista não mostra (ela só traz as regras próprias): os três primeiros gravam a regra do bot em cada ação e "Neutro tudo" remove todas as regras próprias.
import { BOT_RULE_VALUES, RULE_LABELS, type BotRule, type BotRules, type BotRuleView, type GlobalRule } from '@aion/shared';
import { X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { apiErrorMessage } from '@/lib/api-client';
import { useSession } from '@/lib/session-context';
import { fetchBotRules, removeAllBotRules, removeBotRule, setAllBotRules, setBotRule } from './approvals-api';
import { BulkRuleButtons } from './bulk-rule-buttons';
import { SegmentedControl, type SegmentedOption } from './segmented-control';

const BOT_OPTIONS: readonly SegmentedOption<BotRule>[] = BOT_RULE_VALUES.map((value) => ({ value, label: RULE_LABELS[value] }));

/** Valor de `busy` enquanto um lote "tudo" roda; um slug de ação nunca contém `*` (ver `actionSlugSchema`), então não colide com uma ação. */
const BULK = '*';

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; rules: BotRuleView[] };

export function BotApprovalRules({ botId }: { botId: string }) {
  const { csrfToken } = useSession();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  /** Ação cuja alteração ou remoção está em curso, ou `BULK` num lote "tudo" (os controles ficam desabilitados até o servidor responder). */
  const [busy, setBusy] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchBotRules(botId).then(
      (result: BotRules) => {
        if (!cancelled) setLoad({ status: 'ready', rules: result.rules });
      },
      (error: unknown) => {
        if (!cancelled) setLoad({ status: 'error', message: apiErrorMessage(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [botId, attempt]);

  /** Executa a alteração, mostra a lista devolvida pelo servidor e avisa o resultado (texto fixo, ou calculado a partir da lista nova). */
  const run = useCallback(async (action: string, work: () => Promise<BotRules>, message: string | ((result: BotRules) => string)) => {
    setBusy(action);
    try {
      const result = await work();
      setLoad({ status: 'ready', rules: result.rules });
      toast(typeof message === 'function' ? message(result) : message);
    } catch (error) {
      toast.error(apiErrorMessage(error), { duration: Infinity });
    } finally {
      setBusy(null);
    }
  }, []);

  if (load.status === 'loading') return <div role="status" aria-busy="true" aria-label="Carregando regras do bot" className="h-11 animate-pulse rounded-md bg-surface" />;
  if (load.status === 'error') {
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
        <p>{load.message}</p>
        <Button variant="secondary" size="sm" onClick={() => { setLoad({ status: 'loading' }); setAttempt((value) => value + 1); }}>
          Tentar novamente
        </Button>
      </div>
    );
  }

  /** "Permitir/Perguntar/Negar tudo" grava a regra do bot em todas as ações conhecidas; "Neutro tudo" remove as regras próprias (o bot não tem regra "neutra"). */
  const applyAll = (value: GlobalRule) => {
    if (value === 'neutral') {
      void run(BULK, () => removeAllBotRules(botId, csrfToken), 'Regras do bot removidas: vale a global');
      return;
    }
    void run(BULK, () => setAllBotRules(botId, value, csrfToken), (result) =>
      result.rules.length === 0 ? 'Nenhuma ação conhecida ainda. Conecte o Composio em Conectores.' : `Regra de todas as ações: ${RULE_LABELS[value]}`,
    );
  };

  return (
    <div>
      <BulkRuleButtons
        label="Todas as ações"
        allowWarning="Este bot passa a executar todas as ações conhecidas sem pedir aprovação, não só as que aparecem na lista abaixo, e as regras próprias que ele já tem são substituídas."
        disabled={busy !== null}
        onApply={applyAll}
      />
      {load.rules.length === 0 ? (
        <p className="mt-4 text-sm text-muted">Este bot segue as regras globais.</p>
      ) : (
        <ul className="mt-4 flex flex-col">
          {load.rules.map((rule) => (
            <li key={rule.action} className="flex flex-col gap-2 border-b border-line py-3 first:pt-0 last:border-b-0 md:flex-row md:items-center md:justify-between md:gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-fg [overflow-wrap:anywhere]">{rule.label}</p>
                <p className="font-mono text-[13px]/5 text-subtle [overflow-wrap:anywhere]">{rule.action}</p>
              </div>
              <div className="flex items-center gap-2">
                <SegmentedControl
                  label={`Regra do bot para ${rule.label}`}
                  options={BOT_OPTIONS}
                  value={rule.value}
                  onChange={(value) => void run(rule.action, () => setBotRule(botId, rule.action, value, csrfToken), `Regra de ${rule.label}: ${RULE_LABELS[value]}`)}
                  disabled={busy === rule.action || busy === BULK}
                  className="flex-1 md:flex-none"
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remover regra de ${rule.label}`}
                      disabled={busy === rule.action || busy === BULK}
                      onClick={() => void run(rule.action, () => removeBotRule(botId, rule.action, csrfToken), `Regra de ${rule.label} removida: vale a global`)}
                    >
                      <X className="size-4" strokeWidth={1.5} aria-hidden />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">Remover regra</TooltipContent>
                </Tooltip>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

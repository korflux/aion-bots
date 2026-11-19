// Resolução da regra de aprovação de uma ação do Composio (spec decisão 8): FONTE ÚNICA, função pura e sem acesso a banco.
// O motor de execução, os testes (tabela de casos de A8) e qualquer tela que precise "explicar" uma regra usam esta função e
// nenhuma outra, para a decisão nunca divergir entre quem executa e quem mostra.
//
//   1. o bot tem regra para a ação            -> vale a regra do bot (allow, deny ou ask);
//   2. senão, a regra global não é neutra     -> vale a global;
//   3. senão (global neutra ou ação sem regra) -> PERGUNTA.
// O chat geral (T12) não tem regra de bot: passa `null` e só o global conta.
import type { BotRule, GlobalRule, ResolvedRule } from '@aion/shared';

export function resolveRule(botRule: BotRule | null | undefined, globalRule: GlobalRule | null | undefined): ResolvedRule {
  if (botRule) return botRule;
  if (globalRule && globalRule !== 'neutral') return globalRule;
  return 'ask';
}

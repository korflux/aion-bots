// Funções puras da tela Aprovações e do cartão de aprovação (sem React): filtro e agrupamento das ações por app, e o texto do tempo
// restante. Separadas dos componentes para serem provadas por teste unitário e reutilizadas pela tela e pelo editor do bot.
import type { ActionRuleView } from '@aion/shared';

/** Ações de um mesmo app, na ordem em que o servidor as entrega (app e nome da ação). */
export interface AppGroup {
  appSlug: string;
  appName: string;
  actions: ActionRuleView[];
}

/** Texto sem acentos e em minúsculas, para a busca ignorar maiúsculas e acentuação ("e-mail" acha "E-MAIL"). */
const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Ações cujo nome legível, slug ou app contêm todas as palavras digitadas. Busca vazia devolve tudo. */
export function filterActions(actions: readonly ActionRuleView[], query: string): ActionRuleView[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...actions];
  return actions.filter((action) => {
    const haystack = fold(`${action.label} ${action.action} ${action.appName}`);
    return words.every((word) => haystack.includes(word));
  });
}

/** Agrupa por app preservando a ordem de chegada (o servidor já ordena por app e nome). */
export function groupByApp(actions: readonly ActionRuleView[]): AppGroup[] {
  const groups = new Map<string, AppGroup>();
  for (const action of actions) {
    const group = groups.get(action.appSlug) ?? { appSlug: action.appSlug, appName: action.appName, actions: [] };
    group.actions.push(action);
    groups.set(action.appSlug, group);
  }
  return [...groups.values()];
}

/** Tempo até a aprovação expirar, como o cartão mostra ("23 h", "45 min"); passado o prazo, "expirada". */
export function formatTimeLeft(expiresAt: string, nowMs: number): string {
  const remaining = new Date(expiresAt).getTime() - nowMs;
  if (!(remaining > 0)) return 'expirada';
  const minutes = Math.ceil(remaining / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours >= 1 ? `${hours} h` : `${Math.max(1, minutes)} min`;
}

/** Número do badge da barra: oculto em zero e "9+" acima de 9 (design). */
export function badgeText(count: number): string | null {
  if (count <= 0) return null;
  return count > 9 ? '9+' : String(count);
}

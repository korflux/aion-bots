'use client';

// Seletor de modelo (F8, design "Seletor de modelo"; phase 17, UI-05): popover de 340 px no desktop e drawer inferior de 70 dvh em 375 px, com busca, chips de provedor, Favoritos, Recentes, um grupo
// recolhível por provedor, selo do teste, preço, visão e effort de cada modelo e o controle de effort (barra com etapas) na base. É o mesmo componente no editor do bot (T5), na caixa de mensagem
// da conversa (T6) e no chat geral (T12): quem o usa entrega o gatilho (qualquer botão) como filho e recebe a escolha por `onChange`.
//
// O que a tela mostra (A25 a A29):
// - chips "Todos", "Anthropic" e "OpenCode Go" abaixo da busca (só com mais de um provedor na lista) que filtram tudo por provedor;
// - em "Todos": Favoritos, Recentes (5) e um grupo por provedor, recolhível, com o contador de modelos; Favoritos e Recentes mostram o nome completo ("anthropic/Claude Haiku 5.5") e os grupos,
//   o nome sem o prefixo. Cada linha tem o NOME numa linha só dele (quebra em vez de cortar, em 340 px e em 375 px) e, embaixo, o preço, os selos "Visão" e "Effort" e o selo do teste;
// - com texto na busca vem uma lista só, de todos os provedores, e cada resultado mostra o provedor;
// - modelo oculto em Conexões sai das escolhas novas e só aparece, com o selo "Oculto", quando é a escolha atual (A9); modelo da Anthropic com o saldo esgotado aparece "Indisponível" e não
//   se escolhe até uma chamada passar (A21).
// As regras de divisão da lista são funções puras de `model-label.ts`.
//
// Fluxo da escolha:
// - Modelo já testado: aplica direto, sem chamar o servidor.
// - Modelo nunca testado (primeira seleção): a linha mostra "Testando modelo…" enquanto o servidor roda o teste, o
//   resultado aparece no selo e o modelo é aplicado, inclusive com falha (o dono pode usar um modelo que falhou; a linha
//   continua avisando). Um erro de API (provedor fora do ar, limite de testes) NÃO aplica nada: o modelo segue sem teste.
// - "Testar novamente" (menu da linha) repete o teste e sobrescreve o resultado, sem mudar o modelo escolhido.
// - O popover fica aberto depois de escolher: o controle de effort do modelo recém-escolhido aparece na base.
//
// Teclado: a busca recebe o foco ao abrir; seta para baixo/cima percorre as linhas (um controle por vez no Tab, o da linha ativa: escolher, favoritar e menu), Enter escolhe; os chips e os cabeçalhos
// dos grupos são botões no Tab (Enter ou Espaço escolhe o chip ou recolhe o grupo) e Esc fecha. Todo controle só de ícone tem nome acessível.
import { MODEL_TEST_REASON_MESSAGES, localModelId, providerOfModel, type EffortLevel, type ModelEntry, type ModelProvider } from '@aion/shared';
import { Check, ChevronDown, LoaderCircle, MoreHorizontal, Star, X } from 'lucide-react';
import Link from 'next/link';
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { StatusBadge } from '@/components/settings/status-badge';
import { BottomSheet, BottomSheetClose, BottomSheetContent, BottomSheetTrigger } from '@/components/ui/bottom-sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { apiErrorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/session-context';
import { useMediaQuery } from '@/lib/use-media-query';
import { setModelFavorite, testModel } from './models-api';
import { EffortControl } from './effort-control';
import { GROUP_LIST_NAMES, PRICE_HINT, PROVIDER_LABELS, UNAVAILABLE_REASON, buildSections, chipProviders, hasEffort, hasVision, modelFullName, modelName, priceLabel, providerLabelOf } from './model-label';
import { useModels, type ModelsState } from './use-models';

/** Escolha do dono: modelo (nulo = sem modelo padrão) e effort (nulo = padrão do modelo). */
export interface ModelChoice {
  model: string | null;
  effort: EffortLevel | null;
}

const levelsOf = (entry: ModelEntry | undefined): EffortLevel[] => entry?.test?.effortLevels ?? [];

const NONE_KEY = 'none';

/** Uma linha navegável por setas: o modelo (`entry`) ou a opção "sem modelo" (`entry` nulo). `key` é único entre as seções (o mesmo modelo pode estar em Favoritos, Recentes e no grupo). */
interface Row {
  key: string;
  entry: ModelEntry | null;
}

// ---------------------------------------------------------------------------------------------
// Linha de modelo
// ---------------------------------------------------------------------------------------------

interface ModelRowProps {
  row: Row;
  /** Nome mostrado: sem prefixo nos grupos e na busca, completo em Favoritos e Recentes. */
  label: string;
  /** Provedor do resultado, só na lista de busca (A27). */
  provider?: string;
  /** Id do texto, na tela, com o motivo do modelo indisponível (dito uma vez no cabeçalho do grupo ou sob "Resultados"): a linha indisponível o liga por `aria-describedby`. */
  reasonId?: string;
  selected: boolean;
  /** Controles da linha entram no Tab só quando ela é a ativa (as demais se alcançam por seta). */
  tabbable: boolean;
  testing: boolean;
  /** Um teste (desta ou de outra linha) está em andamento: escolher fica bloqueado. */
  locked: boolean;
  apiError: string | null;
  buttonRef: (element: HTMLButtonElement | null) => void;
  /** Teclas e foco sobem dos botões até o item da lista: a linha inteira participa da navegação e marca a linha ativa. */
  onKeyDown: (event: KeyboardEvent) => void;
  onFocus: () => void;
  onPick: () => void;
  onToggleFavorite: () => void;
  onRetest: () => void;
}

/** Selo do último teste; nenhum selo quando o modelo nunca foi testado. O selo sempre tem texto (design). */
function TestBadge({ entry }: { entry: ModelEntry }) {
  if (!entry.test) return null;
  if (entry.test.status === 'ok') return <StatusBadge tone="success">Liberado</StatusBadge>;
  if (entry.test.status === 'no_tools') return <StatusBadge tone="warning">Sem ferramentas</StatusBadge>;
  return <StatusBadge tone="danger">Falhou</StatusBadge>;
}

function ModelRow({ row, label, provider, reasonId, selected, tabbable, testing, locked, apiError, buttonRef, onKeyDown, onFocus, onPick, onToggleFavorite, onRetest }: ModelRowProps) {
  const { entry } = row;
  const messageId = useId();
  // Mensagem da linha: testando, erro da última tentativa ou o motivo do último resultado que não foi "Liberado".
  const reason = entry?.test?.reason ? MODEL_TEST_REASON_MESSAGES[entry.test.reason] : null;
  const failed = entry?.test?.status === 'failed';
  const unavailable = entry?.unavailable === 'credits_exhausted';
  const message = testing ? null : apiError ?? (reason && (failed || entry?.test?.status === 'no_tools') ? reason : null);
  const hasMessage = testing || message !== null;
  // Modelo indisponível não é escolhido de novo (A21), mas a linha continua no Tab e dá o motivo: `aria-disabled` em vez de `disabled`.
  const refuse = unavailable && !selected;

  return (
    <li className="rounded-sm hover:bg-surface-hover" onKeyDown={onKeyDown} onFocus={onFocus}>
      <div className="flex items-center gap-0.5 pr-1">
        <button
          ref={buttonRef}
          type="button"
          tabIndex={tabbable ? 0 : -1}
          aria-current={selected ? 'true' : undefined}
          aria-busy={testing || undefined}
          aria-describedby={[hasMessage ? messageId : null, unavailable ? (reasonId ?? null) : null].filter(Boolean).join(' ') || undefined}
          aria-disabled={refuse || undefined}
          disabled={locked && !testing}
          onClick={refuse ? undefined : onPick}
          className={cn('flex min-h-10 min-w-0 flex-1 items-start gap-2 rounded-sm px-2 py-2 text-left text-sm text-fg disabled:opacity-50', refuse && 'opacity-60')}
        >
          <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center" aria-hidden>
            {selected ? <Check className="size-4" strokeWidth={2} /> : null}
          </span>
          {/* O NOME tem a linha só para ele e quebra em vez de cortar: ids longos ("opencode/deepseek-v4.1-flash") aparecem inteiros no popover de 340 px e no drawer de 375 px. */}
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span data-model-name className="break-words">
              {label}
            </span>
            {entry ? (
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {provider ? <span className="text-xs text-muted">{provider}</span> : null}
                <span className="text-xs tabular-nums text-muted" title={PRICE_HINT}>
                  {priceLabel(entry.price)}
                </span>
                {hasVision(entry) ? <span className="rounded-sm border border-line px-1 text-[11px] text-muted">Visão</span> : null}
                {hasEffort(entry) ? <span className="rounded-sm border border-line px-1 text-[11px] text-muted">Effort</span> : null}
                {entry.hidden === true ? <StatusBadge tone="neutral">Oculto</StatusBadge> : null}
                {unavailable ? <StatusBadge tone="warning">Indisponível</StatusBadge> : null}
                <TestBadge entry={entry} />
              </span>
            ) : null}
          </span>
        </button>
        {entry ? (
          <>
            <Button
              variant="ghost"
              size="icon"
              tabIndex={tabbable ? 0 : -1}
              aria-label={`Favoritar ${localModelId(entry.id)}`}
              aria-pressed={entry.favorite}
              title={entry.favorite ? 'Remover dos favoritos' : 'Favoritar'}
              onClick={onToggleFavorite}
            >
              <Star className={cn('size-4', entry.favorite ? 'fill-current text-warning' : '')} strokeWidth={1.5} aria-hidden />
            </Button>
            <Menu>
              <MenuTrigger asChild>
                <Button variant="ghost" size="icon" tabIndex={tabbable ? 0 : -1} aria-label={`Mais ações de ${localModelId(entry.id)}`} title="Mais ações" disabled={locked}>
                  <MoreHorizontal className="size-4" strokeWidth={1.5} aria-hidden />
                </Button>
              </MenuTrigger>
              <MenuContent>
                <MenuItem onSelect={onRetest}>Testar novamente</MenuItem>
              </MenuContent>
            </Menu>
          </>
        ) : null}
      </div>
      {testing ? (
        <p id={messageId} role="status" className="flex items-center gap-1.5 px-8 pb-2 text-xs text-muted">
          <LoaderCircle data-icon="LoaderCircle" className="size-3.5 animate-spin" strokeWidth={1.5} aria-hidden />
          Testando modelo…
        </p>
      ) : message !== null ? (
        <p id={messageId} role={apiError ? 'alert' : undefined} className={cn('px-8 pb-2 text-xs', failed || apiError ? 'text-danger' : 'text-warning')}>
          {failed && !apiError ? `Falhou: ${message}` : message}
        </p>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------
// Corpo do seletor (busca, chips, seções, effort)
// ---------------------------------------------------------------------------------------------

function ListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Carregando modelos" className="flex flex-col gap-2 p-3">
      {[0, 1, 2, 3].map((item) => (
        <div key={item} className="h-9 animate-pulse rounded-sm bg-app" />
      ))}
    </div>
  );
}

function ListError({ state, onRetry }: { state: Extract<ModelsState, { status: 'error' }>; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 p-4">
      <p role="alert" className="text-sm text-danger">
        {state.message}
      </p>
      {state.notConfigured ? (
        <Button asChild variant="secondary" size="sm">
          <Link href="/configuracoes/conexoes">Abrir Conexões</Link>
        </Button>
      ) : (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Tentar novamente
        </Button>
      )}
    </div>
  );
}

const SECTION_HEADING = 'px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-subtle';

export interface ModelSelectorProps {
  value: ModelChoice;
  onChange: (choice: ModelChoice) => void;
  /** Rótulo da opção que limpa o modelo (editor: "Sem modelo padrão"). Sem ele, o seletor sempre exige um modelo. */
  noneLabel?: string;
  /** Lado preferido do popover no desktop: acima da caixa de mensagem, abaixo no editor (o Radix inverte se não couber). */
  side?: 'top' | 'bottom';
  /** O gatilho: um único botão; o seletor o controla (abre, `aria-expanded`, devolve o foco ao fechar). */
  children: ReactNode;
}

export function ModelSelector({ value, onChange, noneLabel, side = 'bottom', children }: ModelSelectorProps) {
  const { csrfToken } = useSession();
  const mobile = useMediaQuery('(max-width: 767px)');
  const [open, setOpen] = useState(false);
  const { state, upsert, reload } = useModels(open);
  const [query, setQuery] = useState('');
  /** Chip escolhido (nulo = "Todos") e os grupos recolhidos; os dois voltam ao padrão ao fechar. */
  const [chip, setChip] = useState<ModelProvider | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<ModelProvider>>(new Set());
  /** Modelo em teste agora (um por vez). */
  const [testingId, setTestingId] = useState<string | null>(null);
  const [apiError, setApiError] = useState<{ id: string; message: string } | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const baseId = useId();

  const models = state.status === 'ready' ? state.models : [];
  const recentIds = state.status === 'ready' ? state.recents : [];
  const sections = buildSections(models, { query, provider: chip, recents: recentIds, current: value.model });
  const chips = chipProviders(models);

  // Linhas na ordem da tela (opção "sem modelo", favoritos, recentes, grupos abertos ou resultados): a navegação por setas anda nesta lista.
  const searching = sections.results !== null;
  const noneRow: Row[] = noneLabel && query.trim() === '' ? [{ key: NONE_KEY, entry: null }] : [];
  const favoriteRows: Row[] = sections.favorites.map((entry) => ({ key: `fav:${entry.id}`, entry }));
  const recentRows: Row[] = sections.recents.map((entry) => ({ key: `rec:${entry.id}`, entry }));
  const groupRows = (provider: ModelProvider, entries: readonly ModelEntry[]): Row[] => (collapsed.has(provider) ? [] : entries.map((entry) => ({ key: `all:${entry.id}`, entry })));
  const resultRows: Row[] = (sections.results ?? []).map((entry) => ({ key: `res:${entry.id}`, entry }));
  const rows = [...noneRow, ...favoriteRows, ...recentRows, ...sections.groups.flatMap((group) => groupRows(group.provider, group.entries)), ...resultRows];
  const currentKey = value.model === null ? NONE_KEY : searching ? `res:${value.model}` : `all:${value.model}`;
  const tabbableKey = rows.some((row) => row.key === activeKey) ? activeKey : rows.some((row) => row.key === currentKey) ? currentKey : (rows[0]?.key ?? null);
  const currentEntry = models.find((model) => model.id === value.model);
  const currentLevels = levelsOf(currentEntry);
  const anyTesting = testingId !== null;

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setQuery('');
      setChip(null);
      setCollapsed(new Set());
      setApiError(null);
    }
  }

  /** Aplica o modelo. O effort atual só sobrevive se o novo modelo também o aceita. */
  function choose(entry: ModelEntry | null) {
    if (entry === null) return onChange({ model: null, effort: null });
    onChange({ model: entry.id, effort: value.effort !== null && levelsOf(entry).includes(value.effort) ? value.effort : null });
  }

  /** Roda o teste no servidor. `apply`: escolher o modelo ao terminar (primeira seleção); "testar novamente" não escolhe. */
  async function runTest(entry: ModelEntry, apply: boolean) {
    setTestingId(entry.id);
    setApiError(null);
    try {
      const tested = await testModel(entry.id, csrfToken);
      upsert(tested);
      if (tested.test?.status === 'ok') toast('Modelo liberado');
      else if (tested.test?.status === 'no_tools') toast('Modelo sem suporte a ferramentas');
      if (apply) choose(tested);
      else if (value.model === tested.id && value.effort !== null && !levelsOf(tested).includes(value.effort)) onChange({ model: tested.id, effort: null });
    } catch (error) {
      setApiError({ id: entry.id, message: apiErrorMessage(error) });
    } finally {
      setTestingId(null);
    }
  }

  function pick(entry: ModelEntry | null) {
    if (anyTesting) return;
    if (entry === null || entry.test) choose(entry);
    else void runTest(entry, true);
  }

  async function toggleFavorite(entry: ModelEntry) {
    try {
      upsert(await setModelFavorite(entry.id, !entry.favorite, csrfToken));
    } catch (error) {
      toast.error(apiErrorMessage(error), { duration: Infinity });
    }
  }

  /** Seta para baixo/cima: foca a linha seguinte ou anterior (a busca fica acima da primeira). */
  function moveFocus(event: KeyboardEvent, from: string | 'search') {
    if (event.defaultPrevented || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
    event.preventDefault();
    const index = from === 'search' ? -1 : rows.findIndex((row) => row.key === from);
    const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
    if (next < 0) return searchRef.current?.focus();
    const target = rows[Math.min(next, rows.length - 1)];
    if (target) buttons.current.get(target.key)?.focus();
  }

  /** `mode`: `name` mostra o nome sem prefixo (grupos), `full` o nome completo (Favoritos e Recentes) e `result` o nome sem prefixo com a etiqueta do provedor (resultados da busca, A27). */
  const renderRow = (row: Row, mode: 'name' | 'full' | 'result') => (
    <ModelRow
      key={row.key}
      row={row}
      label={row.entry === null ? (noneLabel ?? '') : mode === 'full' ? modelFullName(row.entry.id, row.entry) : modelName(row.entry)}
      {...(mode === 'result' && row.entry ? { provider: providerLabelOf(row.entry.id) } : {})}
      {...(row.entry?.unavailable ? { reasonId: reasonIdOf(row.entry) } : {})}
      selected={row.entry === null ? value.model === null : value.model === row.entry.id}
      tabbable={row.key === tabbableKey}
      testing={row.entry !== null && testingId === row.entry.id}
      locked={anyTesting}
      apiError={row.entry !== null && apiError?.id === row.entry.id ? apiError.message : null}
      buttonRef={(element) => {
        if (element) buttons.current.set(row.key, element);
        else buttons.current.delete(row.key);
      }}
      onKeyDown={(event) => moveFocus(event, row.key)}
      onFocus={() => setActiveKey(row.key)}
      onPick={() => pick(row.entry)}
      onToggleFavorite={() => row.entry && void toggleFavorite(row.entry)}
      onRetest={() => row.entry && void runTest(row.entry, false)}
    />
  );

  const toggleGroup = (provider: ModelProvider) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
      return next;
    });

  // O motivo do indisponível aparece uma vez por provedor: no cabeçalho do grupo (fora da busca) ou sob "Resultados" (na busca). As linhas indisponíveis, também as de Favoritos e Recentes, o ligam por `aria-describedby`.
  const reasonIdOf = (entry: ModelEntry) => `${baseId}-motivo-${providerOfModel(entry.id) ?? 'opencode'}`;
  const resultsUnavailable = (sections.results ?? []).filter((entry) => entry.unavailable);

  const nothing = sections.favorites.length + sections.recents.length + sections.groups.length === 0;

  const body = (
    <>
      <div className="flex items-center gap-2 border-b border-line p-3">
        <Input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => moveFocus(event, 'search')}
          placeholder="Buscar modelo"
          aria-label="Buscar modelo"
          autoComplete="off"
          spellCheck={false}
        />
        {mobile ? (
          <BottomSheetClose asChild>
            <Button variant="ghost" size="icon" aria-label="Fechar" title="Fechar">
              <X className="size-4" strokeWidth={1.5} aria-hidden />
            </Button>
          </BottomSheetClose>
        ) : null}
      </div>
      {state.status === 'ready' && chips.length > 1 ? (
        <div role="group" aria-label="Filtrar por provedor" className="flex flex-wrap gap-1.5 border-b border-line px-3 py-2">
          {[null, ...chips].map((provider) => (
            <button
              key={provider ?? 'todos'}
              type="button"
              aria-pressed={chip === provider}
              onClick={() => setChip(provider)}
              className={cn(
                'h-8 rounded-full border px-3 text-xs font-medium max-md:h-9',
                chip === provider ? 'border-transparent bg-action text-action-fg' : 'border-line-strong bg-surface text-fg hover:bg-surface-hover',
              )}
            >
              {provider === null ? 'Todos' : PROVIDER_LABELS[provider]}
            </button>
          ))}
        </div>
      ) : null}

      <div className={cn('min-h-0 overflow-y-auto p-1', mobile ? 'flex-1' : 'max-h-[360px]')}>
        {state.status === 'loading' ? <ListSkeleton /> : null}
        {state.status === 'error' ? <ListError state={state} onRetry={reload} /> : null}
        {state.status === 'ready' ? (
          <>
            {noneRow.length > 0 ? <ul aria-label="Sem modelo">{noneRow.map((row) => renderRow(row, 'name'))}</ul> : null}
            {searching ? (
              <section aria-labelledby={`${baseId}-resultados`}>
                <h3 id={`${baseId}-resultados`} className={SECTION_HEADING}>
                  Resultados
                </h3>
                {[...new Set(resultsUnavailable.map(reasonIdOf))].map((id) => (
                  <p key={id} id={id} className="px-2 pb-1 text-xs text-warning">
                    {UNAVAILABLE_REASON}
                  </p>
                ))}
                {resultRows.length > 0 ? <ul aria-labelledby={`${baseId}-resultados`}>{resultRows.map((row) => renderRow(row, 'result'))}</ul> : <p className="px-2 py-6 text-center text-sm text-muted">Nenhum modelo encontrado</p>}
              </section>
            ) : (
              <>
                {favoriteRows.length > 0 ? (
                  <section aria-labelledby="modelos-favoritos" className="mb-1">
                    <h3 id="modelos-favoritos" className={SECTION_HEADING}>
                      Favoritos
                    </h3>
                    <ul aria-labelledby="modelos-favoritos">{favoriteRows.map((row) => renderRow(row, 'full'))}</ul>
                  </section>
                ) : null}
                {recentRows.length > 0 ? (
                  <section aria-labelledby="modelos-recentes" className="mb-1">
                    <h3 id="modelos-recentes" className={SECTION_HEADING}>
                      Recentes
                    </h3>
                    <ul aria-labelledby="modelos-recentes">{recentRows.map((row) => renderRow(row, 'full'))}</ul>
                  </section>
                ) : null}
                {sections.groups.map((group) => {
                  const isCollapsed = collapsed.has(group.provider);
                  return (
                    <section key={group.provider} aria-labelledby={`${baseId}-${group.provider}`}>
                      <h3 id={`${baseId}-${group.provider}`} className="px-1 pb-1 pt-1 text-xs font-medium uppercase tracking-wide text-subtle">
                        <button
                          type="button"
                          aria-expanded={!isCollapsed}
                          aria-controls={`${baseId}-${group.provider}-lista`}
                          onClick={() => toggleGroup(group.provider)}
                          className="flex min-h-9 w-full items-center justify-between gap-2 rounded-sm px-1 text-left uppercase hover:bg-surface-hover"
                        >
                          <span>
                            {PROVIDER_LABELS[group.provider]} <span className="normal-case">({group.entries.length})</span>
                          </span>
                          <ChevronDown aria-hidden className={cn('size-4 shrink-0 transition-transform', !isCollapsed && 'rotate-180')} />
                        </button>
                      </h3>
                      {group.entries.some((entry) => entry.unavailable) ? (
                        <p id={`${baseId}-motivo-${group.provider}`} className="px-2 pb-1 text-xs text-warning">
                          {UNAVAILABLE_REASON}
                        </p>
                      ) : null}
                      {isCollapsed ? null : (
                        <ul id={`${baseId}-${group.provider}-lista`} aria-label={GROUP_LIST_NAMES[group.provider]}>
                          {groupRows(group.provider, group.entries).map((row) => renderRow(row, 'name'))}
                        </ul>
                      )}
                    </section>
                  );
                })}
                {nothing ? <p className="px-2 py-6 text-center text-sm text-muted">Nenhum modelo encontrado</p> : null}
              </>
            )}
          </>
        ) : null}
      </div>

      {currentLevels.length > 0 ? <EffortControl levels={currentLevels} value={value.effort} onChange={(effort) => onChange({ model: value.model, effort })} /> : null}
    </>
  );

  if (mobile) {
    return (
      <BottomSheet open={open} onOpenChange={handleOpenChange}>
        <BottomSheetTrigger asChild>{children}</BottomSheetTrigger>
        <BottomSheetContent title="Selecionar modelo">{body}</BottomSheetContent>
      </BottomSheet>
    );
  }
  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent side={side} aria-label="Selecionar modelo" className="flex w-[340px] max-w-[calc(100vw-2rem)] flex-col">
        {body}
      </PopoverContent>
    </Popover>
  );
}

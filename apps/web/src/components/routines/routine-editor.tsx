'use client';

// Editor de rotina (F12) em /rotinas/nova e /rotinas/[id]: nome, bot e instrução (Básico), o construtor de agenda (Agenda), início, fim e
// limite de execuções (Limites) e a prévia das próximas 5 execuções. Uma só tela para criar e editar, porque os campos e as regras são
// os mesmos; só mudam o título, a chamada à API e as ações do cabeçalho.
//
// Fluxo de salvar: valida no cliente com o mesmo schema da API (`schedule-form.ts`), envia e, em caso de sucesso, mostra o toast e volta
// à lista. As regras com motivo legível (intervalo mínimo, cron, data no passado) voltam do servidor como SCHEDULE_INVALID e aparecem na
// seção Agenda, e o foco vai para o primeiro campo com erro.
//
// Vindo do botão "Editar" do cartão de proposta (antiga) de um bot, a tela abre preenchida com a proposta (guardada no `sessionStorage` só para
// esta passagem: se o navegador a perdeu, o formulário abre vazio no bot certo) e, ao salvar, confirma o cartão (`proposalMessageId`).
//
// Vindo do "Editar" do cartão de uma rotina que o bot JÁ criou ou alterou (phase 10, `/rotinas/<id>?cartao=<cardId>`), a rotina existe: a tela é a
// edição de sempre, só que a gravação leva o `cardId` (o servidor liga a edição ao cartão, que vira "Editada pelo dono", e avisa o bot) e, ao salvar, volta
// à conversa do bot com o toast "Rotina editada". Se a rotina mudou depois do cartão, o servidor responde ROUTINE_CHANGED e a mensagem dele aparece num toast.
import { useRouter } from 'next/navigation';
import { LoaderCircle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { RoutineProposal, RoutineView } from '@aion/shared';
import { DEFAULT_ROUTINE_TIMEZONE, ROUTINE_INSTRUCTION_MAX, countChars } from '@aion/shared';
import { activeBots, useBots } from '@/components/bots/bots-store';
import { BotLoadError, BotLoading } from '@/components/bots/bot-states';
import { BotAvatar } from '@/components/bots/bot-avatar';
import { BackLink } from '@/components/shell/back-link';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiErrorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/session-context';
import { fetchAppSettings } from '@/components/settings/settings-api';
import { RoutineMenu } from './routine-menu';
import { RoutineNotFound } from './routine-states';
import { RoutinePreview, usePreview } from './routine-preview';
import { createRoutine, fetchRoutine, replaceRoutine } from './routines-api';
import { ScheduleBuilder } from './schedule-builder';
import {
  emptyRoutineForm,
  errorsFromApi,
  formFromProposal,
  formFromRoutine,
  settingsOf,
  validateRoutineForm,
  type RoutineFormErrors,
  type RoutineFormValues,
} from './schedule-form';

const sectionTitle = 'text-xs font-medium uppercase tracking-wide text-subtle';
const fieldError = 'mt-1.5 text-xs text-danger';
const describedBy = (...ids: (string | false | undefined)[]): string | undefined => ids.filter(Boolean).join(' ') || undefined;

/** Chave do `sessionStorage` com a proposta que o botão "Editar" do cartão deixa para esta tela. */
export const PROPOSAL_STORAGE_KEY = 'aion:routine-proposal';

/** Lê a proposta guardada pelo cartão, se for a do cartão pedido. Falha de storage ou JSON estranho: sem proposta. */
function readStoredProposal(messageId: string): RoutineProposal | null {
  try {
    const raw = window.sessionStorage.getItem(PROPOSAL_STORAGE_KEY);
    if (raw === null) return null;
    const stored = JSON.parse(raw) as { messageId?: string; proposal?: RoutineProposal };
    return stored.messageId === messageId && stored.proposal ? stored.proposal : null;
  } catch {
    return null;
  }
}

interface RoutineFormProps {
  /** Ausente ao criar; ao editar, a rotina carregada. */
  routine?: RoutineView;
  /** Pausar ou retomar pelo menu do cabeçalho devolve a rotina atualizada (o formulário digitado não é refeito). */
  onRoutineChange?: (routine: RoutineView) => void;
  /** Cartão de proposta de origem (botão Editar do cartão), com o bot que a propôs. */
  proposal?: { messageId: string; botId: string };
  /** Cartão de rotina aplicada pelo bot de onde a edição partiu (só com `routine`): a gravação o liga a ele e a tela volta à conversa. */
  cardId?: string;
}

function RoutineForm({ routine, onRoutineChange, proposal, cardId }: RoutineFormProps) {
  const router = useRouter();
  const { csrfToken } = useSession();
  const { bots } = useBots();
  const formRef = useRef<HTMLFormElement>(null);

  const [values, setValues] = useState<RoutineFormValues>(() => {
    if (routine) return formFromRoutine(routine);
    const stored = proposal ? readStoredProposal(proposal.messageId) : null;
    return stored && proposal ? formFromProposal(stored, proposal.botId) : emptyRoutineForm(proposal?.botId ?? '');
  });
  // Rotina NOVA e sem proposta de origem: o fuso padrão é o do dono (Configurações → Idioma e fuso), e não uma constante. Só vale se o dono ainda
  // não mexeu no campo quando a resposta chega; sem resposta, o formulário segue com o fuso de sempre.
  const isNew = !routine && !proposal;
  useEffect(() => {
    if (!isNew) return;
    let cancelled = false;
    fetchAppSettings().then(
      (settings) => {
        if (!cancelled) setValues((current) => (current.timezone === DEFAULT_ROUTINE_TIMEZONE ? { ...current, timezone: settings.timeZone } : current));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [isNew]);
  const [errors, setErrors] = useState<RoutineFormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Incrementar leva o foco ao primeiro campo com erro, já depois de a tela mostrar `aria-invalid`.
  const [focusRequest, setFocusRequest] = useState(0);

  useEffect(() => {
    if (focusRequest > 0) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [focusRequest]);

  /** Altera campos e apaga os erros deles (o dono já está corrigindo). */
  function change(patch: Partial<RoutineFormValues>) {
    setValues((current) => ({ ...current, ...patch }));
    setErrors({});
    setFormError(null);
  }

  function showErrors(next: RoutineFormErrors) {
    setErrors(next);
    setFocusRequest((value) => value + 1);
  }

  const settings = useMemo(() => settingsOf(values), [values]);
  const preview = usePreview(settings);

  // Bots para escolher: os ativos e, ao editar, o da própria rotina (mesmo arquivado), para o campo mostrar o valor salvo. Cada opção leva a cor
  // do bot: o avatar ao lado do campo é a Faísca parada e ociosa do bot escolhido.
  const botOptions = useMemo(() => {
    const options = activeBots(bots).map((bot) => ({ id: bot.id, name: bot.name, color: bot.color }));
    if (routine && !options.some((bot) => bot.id === routine.bot.id)) {
      options.push({ id: routine.bot.id, name: `${routine.bot.name} (arquivado)`, color: routine.bot.color });
    }
    return options;
  }, [bots, routine]);
  const selectedBot = botOptions.find((bot) => bot.id === values.botId);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const result = validateRoutineForm(values);
    if (!result.draft) {
      showErrors(result.errors);
      return;
    }
    setErrors({});
    setFormError(null);
    setSaving(true);
    try {
      if (routine) await replaceRoutine(routine.id, result.draft, csrfToken, cardId);
      else await createRoutine(proposal ? { ...result.draft, proposalMessageId: proposal.messageId } : result.draft, csrfToken);
      // Aberto pelo cartão, a edição volta à conversa onde ele está (a do bot ORIGINAL da rotina: o seletor de bot do formulário pode ter mudado).
      toast(routine && cardId ? 'Rotina editada' : 'Rotina salva');
      // Mantém "salvando" até a navegação concluir, para um segundo clique não reenviar.
      router.push(routine && cardId ? `/bots/${routine.bot.id}` : '/rotinas');
    } catch (error) {
      setSaving(false);
      if (error instanceof ApiError && (error.code === 'SCHEDULE_INVALID' || error.code === 'SCHEDULE_IN_PAST')) {
        showErrors({ schedule: error.fields?.[0]?.reason ?? error.message });
      } else if (error instanceof ApiError && error.code === 'VALIDATION_FAILED') {
        showErrors(errorsFromApi(error.fields));
      } else if (error instanceof ApiError && (error.code === 'BOT_ARCHIVED' || error.code === 'BOT_NOT_FOUND')) {
        showErrors({ botId: error.code === 'BOT_ARCHIVED' ? 'Este bot está arquivado. Escolha outro.' : 'Este bot não existe mais.' });
      } else if (error instanceof ApiError && error.code === 'ROUTINE_NOT_FOUND') {
        setFormError('Esta rotina não existe mais.');
      } else {
        toast.error(apiErrorMessage(error), { duration: Infinity });
      }
    }
  }

  const instructionCount = countChars(values.instruction);
  const cronDescription = values.kind === 'cron' && preview.status === 'ready' ? preview.description : null;

  return (
    <form ref={formRef} onSubmit={(event) => void onSubmit(event)} noValidate className="mx-auto flex min-h-full w-full max-w-[920px] flex-col">
      <header className="flex h-[52px] shrink-0 items-center justify-between gap-3 px-4 md:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <BackLink />
          <h1 className="min-w-0 truncate text-[18px]/[26px] font-semibold text-fg">{routine ? routine.name : 'Nova rotina'}</h1>
        </div>
        {routine ? (
          <RoutineMenu routine={routine} onChanged={onRoutineChange} onDeleted={() => router.push('/rotinas')} />
        ) : null}
      </header>

      {formError ? (
        <p className="mx-4 mb-4 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger md:mx-6" data-testid="form-error">
          {formError}
        </p>
      ) : null}

      <div className="grid flex-1 content-start gap-x-8 gap-y-8 px-4 pb-10 pt-2 md:px-6 lg:grid-cols-[560px_280px]">

        <section aria-labelledby="sec-basico" className="flex flex-col gap-5 lg:col-start-1">
          <h2 id="sec-basico" className={sectionTitle}>
            Básico
          </h2>
          <div>
            <Label htmlFor="rotina-nome">Nome</Label>
            <Input
              id="rotina-nome"
              value={values.name}
              onChange={(event) => change({ name: event.target.value })}
              autoComplete="off"
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={describedBy(errors.name && 'rotina-nome-erro')}
            />
            {errors.name ? (
              <p id="rotina-nome-erro" className={fieldError}>
                {errors.name}
              </p>
            ) : null}
          </div>
          <div>
            <Label htmlFor="rotina-bot">Bot</Label>
            <div className="flex items-center gap-2">
              {selectedBot ? <BotAvatar owner={selectedBot} size={24} still /> : null}
              <Select
                id="rotina-bot"
                value={values.botId}
                onChange={(event) => change({ botId: event.target.value })}
                aria-invalid={errors.botId ? true : undefined}
                aria-describedby={describedBy(errors.botId && 'rotina-bot-erro')}
                className="max-w-80"
              >
                <option value="">Escolha um bot</option>
                {botOptions.map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    {bot.name}
                  </option>
                ))}
              </Select>
            </div>
            {errors.botId ? (
              <p id="rotina-bot-erro" className={fieldError}>
                {errors.botId}
              </p>
            ) : null}
          </div>
          <div>
            <Label htmlFor="rotina-instrucao">Instrução</Label>
            <Textarea
              id="rotina-instrucao"
              value={values.instruction}
              onChange={(event) => change({ instruction: event.target.value })}
              placeholder="O que o bot deve fazer a cada execução. Ele a executa sozinho, então escreva o suficiente."
              className="min-h-28"
              aria-invalid={errors.instruction ? true : undefined}
              aria-describedby={describedBy('rotina-instrucao-contador', errors.instruction && 'rotina-instrucao-erro')}
            />
            <div className="mt-1.5 flex items-start justify-between gap-3 text-xs">
              {errors.instruction ? (
                <p id="rotina-instrucao-erro" className="text-danger">
                  {errors.instruction}
                </p>
              ) : (
                <span />
              )}
              <p id="rotina-instrucao-contador" className={cn('shrink-0 tabular-nums', instructionCount > ROUTINE_INSTRUCTION_MAX ? 'text-danger' : 'text-subtle')}>
                {instructionCount.toLocaleString('pt-BR')} / {ROUTINE_INSTRUCTION_MAX.toLocaleString('pt-BR')}
              </p>
            </div>
          </div>
        </section>

        <section aria-labelledby="sec-agenda" className="flex flex-col gap-5 lg:col-start-1">
          <h2 id="sec-agenda" className={sectionTitle}>
            Agenda
          </h2>
          <ScheduleBuilder values={values} onChange={change} scheduleError={errors.schedule} timezoneError={errors.timezone} cronDescription={cronDescription} />
        </section>

        {/* A prévia fica logo depois da Agenda no celular e vira a coluna fixa à direita no desktop. */}
        <div className="lg:col-start-2 lg:row-span-3 lg:row-start-1 lg:self-start lg:sticky lg:top-4">
          <RoutinePreview state={preview} timezone={values.timezone.trim()} />
        </div>

        <section aria-labelledby="sec-limites" className="flex flex-col gap-5 lg:col-start-1">
          <h2 id="sec-limites" className={sectionTitle}>
            Limites
          </h2>
          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <Label htmlFor="rotina-inicio">Início (opcional)</Label>
              <Input
                id="rotina-inicio"
                type="datetime-local"
                value={values.startsAt}
                onChange={(event) => change({ startsAt: event.target.value })}
                aria-invalid={errors.startsAt ? true : undefined}
              />
              {errors.startsAt ? <p className={fieldError}>{errors.startsAt}</p> : null}
            </div>
            <div>
              <Label htmlFor="rotina-fim">Fim (opcional)</Label>
              <Input
                id="rotina-fim"
                type="datetime-local"
                value={values.endsAt}
                onChange={(event) => change({ endsAt: event.target.value })}
                aria-invalid={errors.endsAt ? true : undefined}
              />
              {errors.endsAt ? <p className={fieldError}>{errors.endsAt}</p> : null}
            </div>
          </div>
          <div>
            <Label htmlFor="rotina-limite">Parar após (opcional)</Label>
            <div className="flex items-center gap-2 text-sm text-muted">
              <Input
                id="rotina-limite"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={values.maxRunsText}
                onChange={(event) => change({ maxRunsText: event.target.value })}
                aria-invalid={errors.maxRuns ? true : undefined}
                aria-describedby={describedBy(errors.maxRuns && 'rotina-limite-erro')}
                className="w-28"
              />
              <span>execuções</span>
            </div>
            {errors.maxRuns ? (
              <p id="rotina-limite-erro" className={fieldError}>
                {errors.maxRuns}
              </p>
            ) : null}
          </div>
          <p className="text-xs text-subtle">Início e fim usam o horário do fuso escolhido na agenda.</p>
        </section>
      </div>

      <footer className="sticky bottom-0 z-10 mt-auto flex items-center justify-end gap-2 border-t border-line bg-app px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 md:px-6">
        <Button asChild variant="ghost">
          <Link href="/rotinas">Cancelar</Link>
        </Button>
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? <LoaderCircle data-icon="LoaderCircle" className="size-4 animate-spin" strokeWidth={1.5} aria-hidden /> : null}
          Salvar rotina
        </Button>
      </footer>
    </form>
  );
}

type RoutineLoad = { status: 'loading' } | { status: 'ready'; routine: RoutineView } | { status: 'not-found' } | { status: 'error'; message: string };

/** Carrega a rotina a editar e entrega o formulário preenchido (`key={id}` reinicia o carregamento ao trocar de rotina). */
function EditLoader({ id, cardId }: { id: string; cardId?: string }) {
  const [load, setLoad] = useState<RoutineLoad>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchRoutine(id).then(
      (routine) => {
        if (!cancelled) setLoad({ status: 'ready', routine });
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.code === 'ROUTINE_NOT_FOUND') setLoad({ status: 'not-found' });
        else setLoad({ status: 'error', message: error instanceof ApiError ? error.message : 'Não foi possível carregar a rotina.' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, attempt]);

  if (load.status === 'loading') return <BotLoading label="Carregando rotina" />;
  if (load.status === 'not-found') return <RoutineNotFound />;
  if (load.status === 'error') {
    return (
      <BotLoadError
        message={load.message}
        onRetry={() => {
          setLoad({ status: 'loading' });
          setAttempt((value) => value + 1);
        }}
      />
    );
  }
  return <RoutineForm routine={load.routine} cardId={cardId} onRoutineChange={(routine) => setLoad({ status: 'ready', routine })} />;
}

/**
 * Ponto de entrada: com `routineId` edita a rotina (com `cardId`, a partir do cartão do bot que a criou ou alterou); sem ele cria uma nova (opcionalmente a
 * partir da proposta de um bot).
 */
export function RoutineEditor({ routineId, cardId, proposal }: { routineId?: string; cardId?: string; proposal?: { messageId: string; botId: string } }) {
  return routineId ? <EditLoader key={`${routineId}:${cardId ?? ''}`} id={routineId} cardId={cardId} /> : <RoutineForm proposal={proposal} />;
}

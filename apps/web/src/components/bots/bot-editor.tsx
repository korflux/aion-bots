'use client';

// Editor do bot (F5) em /bots/novo e /bots/[id]/editar: nome com a prévia da Faísca na cor escolhida, cor,
// instruções, modelo e effort padrão (seletor da T5), limite de etapas e, ao editar, a zona de arquivamento (arquivar; para um bot
// arquivado, desarquivar e excluir definitivamente, esta última em `delete-bot-dialog.tsx`). Uma só tela para criar e editar, porque os
// campos e as regras são os mesmos; só mudam o título, a chamada à API e a zona de arquivar.
//
// Fluxo de salvar: valida no cliente com o mesmo schema da API (bot-form.ts), envia, e em caso de sucesso mostra o
// toast e leva à conversa do bot. Erros do servidor (nome em uso, campo inválido) aparecem no campo certo, e o foco
// vai para o primeiro campo com erro. Ao editar, a seção "Aprovações do bot" (F10, T7) lista as regras próprias do bot; ela salva
// na hora, por conta própria, e não depende do botão Salvar. A seção "Contas do conector" (phase 13) só LÊ as contas liberadas ao bot.
import {
  BOT_INSTRUCTIONS_MAX,
  CONTEXT_WINDOW_PRESETS, contextWindowLabel, type ContextPreferences,
  BOT_STEP_LIMIT_MAX,
  BOT_STEP_LIMIT_MIN,
  countChars,
  isHexColor,
  type Bot,
} from '@aion/shared';
import { LoaderCircle } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { BotApprovalRules } from '@/components/approvals/bot-approval-rules';
import { ModelField } from '@/components/models/model-field';
import { BackLink } from '@/components/shell/back-link';
import { Select } from '@/components/ui/select';
import { ContextWindowHelp } from '@/components/settings/context-preferences';
import { fetchContextPreferences } from '@/components/settings/settings-api';
import { useModels } from '@/components/models/use-models';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session-context';
import { cn } from '@/lib/cn';
import { ArchiveDialog } from './archive-dialog';
import { EMPTY_FORM, errorsFromApi, formFromBot, isPresetColor, validateBotForm, type BotFormErrors, type BotFormValues } from './bot-form';
import { BotAvatar } from './bot-avatar';
import { BotConnectorAccounts } from './bot-connector-accounts';
import { BotLoadError, BotLoading, BotNotFound } from './bot-states';
import { archiveBot, createBot, unarchiveBot, updateBot } from './bots-api';
import { ColorPicker } from './color-picker';
import { DeleteBotDialog } from './delete-bot-dialog';
import { useBot } from './use-bot';

const sectionTitle = 'text-xs font-medium uppercase tracking-wide text-subtle';
const fieldError = 'mt-1.5 text-xs text-danger';

/** Junta ids para `aria-describedby`, ignorando os ausentes (ajuda sempre presente, erro só quando existe). */
const describedBy = (...ids: (string | false | undefined)[]): string | undefined => ids.filter(Boolean).join(' ') || undefined;

/** Mensagem segura para toast; erros da API já vêm sem detalhe técnico. */
const messageOf = (error: unknown) => (error instanceof ApiError ? error.message : 'Não foi possível concluir.');

interface BotFormProps {
  /** Ausente ao criar; ao editar, o bot carregado. */
  bot?: Bot;
}

/** Formulário de criação/edição e atalhos para os dados da conversa; arquivos seguem o ciclo de vida do bot. */
function BotForm({ bot }: BotFormProps) {
  const router = useRouter();
  const { csrfToken } = useSession();
  const formRef = useRef<HTMLFormElement>(null);

  const [values, setValues] = useState<BotFormValues>(() => (bot ? formFromBot(bot) : EMPTY_FORM));
  // "Personalizada" vale para uma cor salva fora das 12 pré-definidas, ou quando o dono a escolhe.
  const [customColor, setCustomColor] = useState(() => (bot ? !isPresetColor(bot.color) : false));
  const [errors, setErrors] = useState<BotFormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [contextPreferences, setContextPreferences] = useState<ContextPreferences | null>(null);
  const [contextLoadError, setContextLoadError] = useState(false);
  const [contextAttempt, setContextAttempt] = useState(0);
  const models = useModels(true, 'profiles');
  useEffect(() => {
    let cancelled = false;
    fetchContextPreferences().then((saved) => { if (!cancelled) { setContextPreferences(saved); setContextLoadError(false); } }, () => { if (!cancelled) setContextLoadError(true); });
    return () => { cancelled = true; };
  }, [contextAttempt]);
  const favorite = models.state.status === 'ready' ? [...models.state.models].filter((entry) => entry.favorite).sort((a, b) => (a.favoritedAt ?? '').localeCompare(b.favoritedAt ?? '') || a.id.localeCompare(b.id))[0]?.id ?? null : null;
  const effectiveModel = bot?.contextModel?.fromConversation ? bot.contextModel.model : values.model ?? (bot?.model === null ? bot.contextModel?.model ?? favorite : favorite);
  // Incrementar leva o foco ao primeiro campo com erro, já depois de a tela mostrar `aria-invalid`.
  const [focusRequest, setFocusRequest] = useState(0);

  const [archivedAt, setArchivedAt] = useState(bot?.archivedAt ?? null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);

  useEffect(() => {
    if (focusRequest > 0) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [focusRequest]);

  /** Altera um campo e apaga o erro dele (o dono já está corrigindo). */
  function edit<K extends keyof BotFormValues>(field: K, value: BotFormValues[K]) {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setFormError(null);
  }

  function showErrors(next: BotFormErrors) {
    setErrors(next);
    setFocusRequest((value) => value + 1);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const result = validateBotForm(values);
    if (!result.draft) {
      showErrors(result.errors);
      return;
    }
    setErrors({});
    setFormError(null);
    setSaving(true);
    try {
      const saved = bot ? await updateBot(bot.id, result.draft, csrfToken) : await createBot(result.draft, csrfToken);
      toast(bot ? 'Bot salvo' : 'Bot criado');
      // Mantém "salvando" até a navegação concluir, para um segundo clique não reenviar.
      router.push(`/bots/${saved.id}`);
    } catch (error) {
      setSaving(false);
      if (error instanceof ApiError && error.code === 'BOT_NAME_TAKEN') {
        showErrors({ name: 'Já existe um bot ativo com esse nome.' });
      } else if (error instanceof ApiError && error.code === 'VALIDATION_FAILED') {
        showErrors(errorsFromApi(error.fields));
      } else if (error instanceof ApiError && error.code === 'BOT_NOT_FOUND') {
        setFormError('Este bot não existe mais.');
      } else {
        toast.error(messageOf(error), { duration: Infinity });
      }
    }
  }

  async function confirmArchive() {
    if (!bot) return;
    setArchiveBusy(true);
    try {
      await archiveBot(bot.id, csrfToken);
      toast('Bot arquivado');
      router.push(`/bots/${bot.id}`);
    } catch (error) {
      setArchiveBusy(false);
      setArchiveOpen(false);
      toast.error(messageOf(error), { duration: Infinity });
    }
  }

  async function restore() {
    if (!bot) return;
    setArchiveBusy(true);
    try {
      const restored = await unarchiveBot(bot.id, csrfToken);
      setArchivedAt(restored.archivedAt);
      toast('Bot desarquivado');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'BOT_NAME_TAKEN') {
        setFormError('Já existe um bot ativo com esse nome. Renomeie este bot e salve antes de desarquivar.');
      } else {
        toast.error(messageOf(error), { duration: Infinity });
      }
    } finally {
      setArchiveBusy(false);
    }
  }

  const previewColor = isHexColor(values.color) ? values.color : '#9CA3AF';
  const instructionsCount = countChars(values.instructions);
  const backHref = bot ? `/bots/${bot.id}` : '/bots';

  return (
    <form ref={formRef} onSubmit={(event) => void onSubmit(event)} noValidate className="mx-auto w-full max-w-[640px]">
      {/* Cabeçalho fixo no topo da rolagem, com Salvar sempre à mão (também no mobile). No celular o "Voltar" (pai fixo: Início) toma o lugar do "Cancelar".
          Como o conteúdo rola por baixo, ele precisa ser OPACO, e um `bg-app` liso ficaria como uma faixa escura sobre o degradê da página: por isso é uma barra de painel
          (`bg-panel` com `grad-panel` e o fio `border`), a mesma superfície do painel lateral e da barra inferior. */}
      <header className="sticky top-0 z-10 flex h-[52px] items-center justify-between gap-3 border-b border-line bg-panel grad-panel px-4 md:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <BackLink />
          <h1 className="min-w-0 truncate text-[18px]/[26px] font-semibold text-fg">{bot ? bot.name : 'Novo bot'}</h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button asChild variant="ghost" size="sm" className="max-md:hidden">
            <Link href={backHref}>Cancelar</Link>
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={saving}>
            {saving ? <LoaderCircle data-icon="LoaderCircle" className="size-4 animate-spin" strokeWidth={1.5} aria-hidden /> : null}
            Salvar
          </Button>
        </div>
      </header>

      <div className="flex flex-col gap-8 px-4 pb-16 pt-2 md:px-6">
        {formError ? (
          <p className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger" data-testid="form-error">
            {formError}
          </p>
        ) : null}

        <section aria-labelledby="sec-identidade" className="flex flex-col gap-5">
          <h2 id="sec-identidade" className={sectionTitle}>
            Identidade
          </h2>
          <div className="flex flex-col items-start gap-3 md:flex-row md:gap-4">
            {/* Prévia da Faísca na cor atual, ociosa e parada (design: 96 px à esquerda do Nome no desktop e acima dele no celular). A troca de cor é imediata. */}
            <BotAvatar owner={{ name: values.name, color: previewColor }} size={96} state="idle" still />
            <div className="min-w-0 w-full flex-1">
              <Label htmlFor="nome">Nome</Label>
              <Input
                id="nome"
                name="nome"
                value={values.name}
                onChange={(event) => edit('name', event.target.value)}
                autoComplete="off"
                aria-invalid={errors.name ? true : undefined}
                aria-describedby={describedBy(errors.name && 'nome-erro')}
              />
              {errors.name ? (
                <p id="nome-erro" className={fieldError}>
                  {errors.name}
                </p>
              ) : null}
            </div>
          </div>
          <ColorPicker
            value={values.color}
            custom={customColor}
            onChange={(color, custom) => {
              setCustomColor(custom);
              edit('color', color);
            }}
            error={errors.color}
          />
        </section>

        <section aria-labelledby="sec-comportamento" className="flex flex-col gap-5">
          <h2 id="sec-comportamento" className={sectionTitle}>
            Comportamento
          </h2>
          <div>
            <Label htmlFor="instrucoes">Instruções</Label>
            <Textarea
              id="instrucoes"
              name="instrucoes"
              value={values.instructions}
              onChange={(event) => edit('instructions', event.target.value)}
              placeholder="Como o bot deve se comportar, o que ele sabe e o que ele nunca deve fazer"
              aria-invalid={errors.instructions ? true : undefined}
              aria-describedby={describedBy('instrucoes-contador', errors.instructions && 'instrucoes-erro')}
            />
            <div className="mt-1.5 flex items-start justify-between gap-3 text-xs">
              {errors.instructions ? (
                <p id="instrucoes-erro" className="text-danger">
                  {errors.instructions}
                </p>
              ) : (
                <span />
              )}
              <p id="instrucoes-contador" className={cn('shrink-0 tabular-nums', instructionsCount > BOT_INSTRUCTIONS_MAX ? 'text-danger' : 'text-subtle')}>
                {instructionsCount.toLocaleString('pt-BR')} / {BOT_INSTRUCTIONS_MAX.toLocaleString('pt-BR')}
              </p>
            </div>
          </div>
          <ModelField
            model={values.model}
            effort={values.effort}
            onChange={({ model, effort }) => {
              setValues((current) => ({ ...current, model, effort }));
              setErrors((current) => ({ ...current, model: undefined, effort: undefined }));
              setFormError(null);
              models.reload();
            }}
            error={errors.model ?? errors.effort}
          />
        </section>

        <section aria-labelledby="sec-execucao" className="flex flex-col gap-5">
          <h2 id="sec-execucao" className={sectionTitle}>
            Execução
          </h2>
          <div>
            <Label htmlFor="contexto-bot">Contexto</Label>
            <Select id="contexto-bot" value={values.contextWindowTokens ?? 'global'} onChange={(event) => edit('contextWindowTokens', event.target.value === 'global' ? null : Number(event.target.value) as BotFormValues['contextWindowTokens'])}
              aria-invalid={errors.contextWindowTokens || contextLoadError ? true : undefined} aria-describedby="contexto-bot-ajuda">
              <option value="global">Usar global{contextPreferences ? ` (${contextWindowLabel(contextPreferences.bots)})` : ''}</option>
              {CONTEXT_WINDOW_PRESETS.map((tokens) => <option key={tokens} value={tokens}>{contextWindowLabel(tokens)}</option>)}
            </Select>
            <p id="contexto-bot-ajuda" className="mt-1.5 text-xs text-subtle">{values.contextWindowTokens === null ? `Global: ${contextPreferences ? contextWindowLabel(contextPreferences.bots) : 'carregando…'}` : `Este bot: ${contextWindowLabel(values.contextWindowTokens)}`}.</p>
            {contextPreferences ? <ContextWindowHelp preferred={values.contextWindowTokens ?? contextPreferences.bots} model={effectiveModel} capacity={bot?.contextModel?.model === effectiveModel ? bot.contextModel.capacity : models.state.status === 'ready' ? models.state.models.find((entry) => entry.id === effectiveModel)?.contextCapacity ?? null : null} /> : null}
            {errors.contextWindowTokens ? <p role="alert" className={fieldError}>{errors.contextWindowTokens}</p> : null}
            {contextLoadError ? <div><p role="alert" className={fieldError}>Não foi possível ler o contexto global.</p><Button onClick={() => setContextAttempt((value) => value + 1)}>Tentar novamente</Button></div> : null}
          </div>
          <div>
            <Label htmlFor="limite-etapas">Limite de etapas</Label>
            <Input
              id="limite-etapas"
              name="limite-etapas"
              type="number"
              inputMode="numeric"
              min={BOT_STEP_LIMIT_MIN}
              max={BOT_STEP_LIMIT_MAX}
              step={1}
              value={values.stepLimit}
              onChange={(event) => edit('stepLimit', event.target.value)}
              aria-invalid={errors.stepLimit ? true : undefined}
              aria-describedby={describedBy('limite-ajuda', errors.stepLimit && 'limite-erro')}
              className="max-w-56"
            />
            <p id="limite-ajuda" className="mt-1.5 text-xs text-subtle">
              Chamadas de ferramenta por execução
            </p>
            {errors.stepLimit ? (
              <p id="limite-erro" className={fieldError}>
                {errors.stepLimit}
              </p>
            ) : null}
          </div>
        </section>

        {bot ? (
          <section aria-labelledby="sec-objetivo" className="flex flex-col gap-3">
            <h2 id="sec-objetivo" className={sectionTitle}>Objetivo</h2>
            <p className="whitespace-pre-wrap break-words text-sm text-fg">{bot.objective?.content || 'O bot aprende seu objetivo durante a conversa.'}</p>
            <p className="text-sm text-muted">Para corrigir, oriente o bot na conversa. <Link href={`/bots/${bot.id}`} className="underline">Abrir conversa</Link></p>
          </section>
        ) : null}

        {bot ? (
          <section aria-labelledby="sec-memoria" className="flex flex-col gap-3">
            <h2 id="sec-memoria" className={sectionTitle}>
              Memória
            </h2>
            <p className="text-sm text-muted">Notas que o bot relê em toda execução. Você e o bot podem editar; cada alteração vira uma versão restaurável.</p>
            <div>
              <Button asChild variant="secondary">
                <Link href={`/bots/${bot.id}/memoria`}>Abrir memória do bot</Link>
              </Button>
            </div>
          </section>
        ) : null}

        {bot ? (
          <section aria-labelledby="sec-arquivos" className="flex flex-col gap-3">
            <h2 id="sec-arquivos" className={sectionTitle}>Arquivos</h2>
            <p className="text-sm text-muted">Arquivos anexados à conversa deste bot. Arquivar mantém os arquivos; excluir definitivamente o bot também os remove.</p>
            <div><Button asChild variant="secondary"><Link href={`/bots/${bot.id}/arquivos`}>Abrir arquivos do bot</Link></Button></div>
          </section>
        ) : null}

        {bot ? (
          <section aria-labelledby="sec-aprovacoes" className="flex flex-col gap-3">
            <h2 id="sec-aprovacoes" className={sectionTitle}>
              Aprovações do bot
            </h2>
            <BotApprovalRules botId={bot.id} />
          </section>
        ) : null}

        {/* Contas do Composio liberadas ao bot (phase 13): SÓ LEITURA. A liberação se edita em Configurações → Conexões, a única tela de edição (decisão 7). */}
        {bot ? (
          <section aria-labelledby="sec-contas" className="flex flex-col gap-3">
            <h2 id="sec-contas" className={sectionTitle}>
              Contas do conector
            </h2>
            <BotConnectorAccounts botId={bot.id} />
          </section>
        ) : null}

        {bot ? (
          <section aria-labelledby="sec-arquivamento" className="flex flex-col gap-3 border-t border-line pt-6">
            <h2 id="sec-arquivamento" className={sectionTitle}>
              Arquivamento
            </h2>
            {archivedAt ? (
              <>
                <p className="text-sm text-muted">Este bot está arquivado. Ele não aparece na lista principal e suas rotinas seguem pausadas.</p>
                {/* Lado a lado no desktop; no mobile empilham em largura total, com a ação de perigo por último (design). */}
                <div className="flex flex-col gap-2 md:flex-row">
                  <Button variant="secondary" onClick={() => void restore()} disabled={archiveBusy}>
                    Desarquivar
                  </Button>
                  <DeleteBotDialog botId={bot.id} botName={bot.name} color={bot.color} />
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-muted">O bot sai da lista principal e suas rotinas são pausadas. Conversa e memória são preservadas.</p>
                <div>
                  <ArchiveDialog
                    open={archiveOpen}
                    onOpenChange={setArchiveOpen}
                    botName={bot.name}
                    busy={archiveBusy}
                    onConfirm={() => void confirmArchive()}
                  >
                    <Button variant="danger" className="border border-danger/40">
                      Arquivar bot
                    </Button>
                  </ArchiveDialog>
                </div>
              </>
            )}
          </section>
        ) : null}
      </div>

    </form>
  );
}

/** Carrega o bot a editar e entrega o formulário já preenchido (`key={id}` reinicia o carregamento ao trocar de bot). */
function EditLoader({ id }: { id: string }) {
  const { load, retry } = useBot(id);
  if (load.status === 'loading') return <BotLoading />;
  if (load.status === 'not-found') return <BotNotFound />;
  if (load.status === 'error') return <BotLoadError message={load.message} onRetry={retry} />;
  return <BotForm bot={load.bot} />;
}

/** Ponto de entrada: sem `botId` cria um bot novo; com `botId` edita o bot existente. */
export function BotEditor({ botId }: { botId?: string }) {
  return botId ? <EditLoader key={botId} id={botId} /> : <BotForm />;
}

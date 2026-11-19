'use client';

// Caixa de mensagem da conversa (design: "Composer"): campo que cresce até 40 % da altura, seletor de modelo em texto ("<modelo>
// ▾") e o botão circular de enviar.
//
// Decisões:
// - Enter envia e Shift+Enter quebra a linha (sem enviar no meio de uma composição de IME).
// - Durante uma execução o botão circular vira "Parar execução" SE o campo está vazio; com texto digitado ele continua sendo
//   "Enviar", porque enviar com o bot ocupado COMPLEMENTA o pedido sem interromper nada (phase 4, CONV-03). O Enter envia nos dois casos.
// - Rascunho devolvido (phase 4, F5: parada ou "Cancelar" de um complemento): com o composer vazio (sem texto nem arquivos) ele entra no
//   campo e nos chips sozinho, com um aviso; com algo já digitado aparece a linha "Rascunho devolvido · Usar · Descartar", e "Usar" pede a
//   confirmação "Substituir o texto atual?". Só um aparelho o recebe (o servidor o entrega uma vez).
// - O texto só é apagado quando o envio deu certo: uma recusa (fila cheia, sem modelo, limite de mensagens) mostra o motivo
//   embaixo e mantém o que foi digitado.
// - O seletor de modelo é o mesmo componente do editor do bot (T5), sem a opção "sem modelo": trocar aqui grava a preferência
//   DESTA conversa e não altera o padrão do bot.
// - Forma (phase 18, A18): o campo é uma pílula arredondada, lisa (sem degradê nem brilho), com o texto em cima e UMA linha de controles embaixo: anexar à esquerda e, à direita, nesta
//   ordem, modelo, effort, contexto, ditado e enviar. O grupo da direita é o que encolhe (o modelo trunca, os outros não), então em 390 px nenhum controle some nem se sobrepõe.
//   A raiz segue subindo 20 px (`-mt-5 pt-5`, sem mover nada), herança do degradê de rodapé da phase 5 que saiu com o tema neutro.
// - Início (phase 5, T5): o MESMO composer serve ao campo "Pergunte ao Aion", que ainda não tem conversa. Para isso: `source` pode ser uma função que abre
//   a conversa sob demanda (só ao anexar ou enviar; ver `use-attachments.ts`), `prompt` troca o nome e o texto de ajuda do campo, `storageKey` guarda o texto
//   NÃO ENVIADO no `localStorage` do aparelho (volta depois de recarregar; sai quando o envio dá certo ou o campo é esvaziado) e as props de execução e de
//   rascunho devolvido são opcionais (sem execução, sem rascunho).
import { EFFORT_LABELS, LANGUAGES, type DraftView, type EffortLevel, type ModelChoiceView } from '@aion/shared';
import { ArrowUp, ChevronDown, LoaderCircle, Mic, Paperclip, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { EffortControl } from '@/components/models/effort-control';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { modelFullName } from '@/components/models/model-label';
import { ModelSelector } from '@/components/models/model-selector';
import { useModelEntry } from '@/components/models/use-models';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAppSettings } from '@/components/settings/settings-provider';
import { useDictation } from './use-dictation';
import { useAttachments } from './use-attachments';
import { FILE_PICKER_ACCEPT, type AttachmentSource } from './use-attachments';
import { AttachmentChips } from './attachment-chips';
import { useFileDrop } from './use-file-drop';
import type { ActionResult } from './use-conversation';

/** O que o composer faz com um pedido de rascunho devolvido quando a tela não tem nenhum (Início): nada a receber. */
const NO_DRAFT = async (): Promise<DraftView | null> => null;
const NO_STOP = (): void => undefined;

export interface ComposerProps {
  /** Faixa de contexto compartilhada por conversa e abertura; não participa do rascunho nem do envio. */
  contextPanel?: ReactNode;
  /** Não dá para conversar ainda (sem provedor, ou o Chat geral sem modelo padrão): o campo fica desabilitado e a faixa acima explica. */
  disabled: boolean;
  /** O que o campo desabilitado diz no lugar de "Escreva uma mensagem" (a mesma frase da faixa). */
  disabledReason: string;
  model: ModelChoiceView;
  onModelChange: (model: string, effort: EffortLevel | null) => void;
  /** Há execução ativa no bot (padrão: não; o Início nunca tem). */
  running?: boolean;
  /** A parada já foi pedida e a execução ainda não terminou. */
  stopping?: boolean;
  /** De quem são os arquivos anexados: a conversa, ou uma função que a abre sob demanda (Início). */
  source: AttachmentSource;
  onSend: (content: string, attachmentIds?: string[]) => Promise<ActionResult>;
  onStop?: () => void;
  /** Depois de um envio aceito (a tela rola até o fim). */
  onSent: () => void;
  /** Rascunho devolvido da conversa ainda não entregue, ou nulo (padrão: nenhum). */
  draft?: DraftView | null;
  /** Pede o rascunho para este composer; nulo quando outro aparelho já o recebeu ou a chamada falhou. */
  onTakeDraft?: (draftId: string) => Promise<DraftView | null>;
  /** Nome e texto de ajuda do campo (padrão: "Mensagem" e "Escreva uma mensagem"); o Início usa "Pergunte ao Aion". */
  prompt?: string;
  /** Chave do `localStorage` onde o texto não enviado fica guardado neste aparelho; sem ela o texto só vive na tela. */
  storageKey?: string;
  /** Campo grande (Início, phase 18): o texto começa com 3 linhas de altura em vez de uma. */
  large?: boolean;
}

/**
 * Linha do rascunho devolvido dentro da caixa do composer (design "Complemento", rascunho devolvido com texto já digitado): o início do texto (ou a
 * contagem de arquivos), "Usar" com a confirmação inline "Substituir o texto atual?" e "Descartar". Quebra em duas linhas no celular.
 */
function ReturnedDraftLine({ draft, busy, onUse, onDiscard }: { draft: DraftView; busy: boolean; onUse: () => void; onDiscard: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const files = draft.attachments.filter((file) => !file.removed).length;
  const preview = draft.content.trim() !== '' ? draft.content : `${files} ${files === 1 ? 'arquivo' : 'arquivos'}`;
  return (
    <div role="group" aria-label="Rascunho devolvido" className="flex flex-wrap items-center gap-2 rounded-md bg-surface-hover px-3 py-2 text-sm">
      {confirming ? (
        <>
          <span className="min-w-0 flex-1 text-fg">Substituir o texto atual?</span>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => { setConfirming(false); onUse(); }}>Substituir</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>Cancelar</Button>
        </>
      ) : (
        <>
          <span className="shrink-0 text-muted">Rascunho devolvido</span>
          <span className="min-w-0 flex-1 truncate text-fg" title={preview}>{preview}</span>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirming(true)}>Usar</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onDiscard}>Descartar</Button>
        </>
      )}
    </div>
  );
}

/**
 * Texto não enviado guardado no aparelho (`localStorage`): lê uma vez ao montar e, a partir daí, grava a cada mudança (texto vazio apaga a chave). A leitura é DEPOIS
 * da montagem (não no estado inicial) para a página do servidor e a do navegador começarem iguais, sem aviso de hidratação. `synced` é o último texto em que o campo e o
 * armazenamento concordam (nulo antes da leitura): o efeito de gravação só age quando o campo difere dele, então o campo vazio do primeiro quadro não apaga o texto
 * guardado antes de ele voltar. O efeito de gravação vem ANTES do de leitura de propósito: na primeira passada `synced` ainda é nulo e nada se escreve. Só texto, nada de
 * arquivo nem credencial. Armazenamento bloqueado (janela privada, dados limpos) ou cheio: o texto só vive na tela, sem erro. Sem `key`, não faz nada.
 */
function useStoredText(key: string | undefined, text: string, setText: (value: string) => void): void {
  const synced = useRef<string | null>(null);
  useEffect(() => {
    if (key === undefined || synced.current === null || text === synced.current) return;
    synced.current = text;
    try {
      if (text === '') window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, text);
    } catch {
      // Cheio ou bloqueado: o texto continua na tela.
    }
  }, [key, text]);
  useEffect(() => {
    if (key === undefined) return;
    let saved = '';
    try {
      saved = window.localStorage.getItem(key) ?? '';
    } catch {
      // Armazenamento indisponível: segue sem o rascunho do aparelho.
    }
    synced.current = saved;
    if (saved !== '') setText(saved);
  }, [key, setText]);
}

/** Campo e controles da conversa, com modelo e effort independentes usando a mesma preferência persistida. */
export function Composer({ disabled, disabledReason, model, onModelChange, running = false, stopping = false, onSend, onStop = NO_STOP, onSent, source, draft = null, onTakeDraft = NO_DRAFT, prompt, storageKey, contextPanel, large = false }: ComposerProps) {
  const attachments = useAttachments(source, model.model);
  // Gatilho do seletor: o nome completo `provedor/nome` (A28) e "(oculto)" quando o dono ocultou o modelo em Conexões (A9, o modelo segue funcionando).
  const modelEntry = useModelEntry(disabled ? null : model.model);
  const modelLabel = model.model === null ? 'Escolher modelo' : `${modelFullName(model.model, modelEntry)}${modelEntry?.hidden === true ? ' (oculto)' : ''}`;
  // Arrastar arquivos para a tela anexa pelo mesmo fluxo do botão (validação, limite de 5 e upload).
  const dragging = useFileDrop(!disabled, (files) => attachments.add(files));
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  useStoredText(storageKey, text, setText);
  const [effortOpen, setEffortOpen] = useState(false);
  const effortLabel = model.effort === null ? 'Padrão' : EFFORT_LABELS[model.effort];
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const { load: settings } = useAppSettings();
  const dictation = useDictation({ field: fieldRef, text, setText, locale: settings.status === 'ready' ? LANGUAGES[settings.saved.language].locale : null, enabled: !disabled && !sending });

  const hasText = text.trim() !== '';
  const showStop = running && !hasText;

  /** Pedido do rascunho em curso (o id): evita pedir o mesmo duas vezes enquanto a resposta não volta. */
  const [taking, setTaking] = useState<string | null>(null);
  /** Recebe o rascunho e o põe no campo (substituindo o texto) e nos chips; `announce` é o aviso do composer que estava vazio. */
  const takeDraft = useCallback(async (target: DraftView, announce: boolean) => {
    setTaking(target.id);
    const taken = await onTakeDraft(target.id);
    setTaking(null);
    if (!taken) return;
    setText(taken.content);
    attachments.restore(taken.attachments);
    if (announce) toast('Seu complemento voltou para o campo de mensagem.');
    fieldRef.current?.focus();
  }, [onTakeDraft, attachments]);
  /** "Descartar": recebe o rascunho (para nenhum outro aparelho o receber) e solta os arquivos dele. */
  const discardDraft = useCallback(async (target: DraftView) => {
    setTaking(target.id);
    const taken = await onTakeDraft(target.id);
    setTaking(null);
    if (taken) attachments.discard(taken.attachments.map((file) => file.id));
  }, [onTakeDraft, attachments]);
  // Composer vazio recebe o rascunho sozinho, uma vez por rascunho (com texto ou arquivos, a linha inline pede a decisão do dono).
  const empty = !hasText && attachments.items.length === 0 && !sending;
  const autoTaken = useRef<string | null>(null);
  useEffect(() => {
    if (!draft || !empty || taking !== null || autoTaken.current === draft.id) return;
    autoTaken.current = draft.id;
    void takeDraft(draft, true);
  }, [draft, empty, taking, takeDraft]);

  /** Envia preservando o rascunho quando o servidor recusa. */
  async function submit() {
    const content = text.trim();
    if (content === '' || sending || disabled) return;
    dictation.cancel();
    setSending(true);
    setError(null);
    let result: ActionResult;
    try { result = await onSend(content, await attachments.validate()); }
    catch (failure) { result = { ok: false, message: failure instanceof Error ? failure.message : 'Não foi possível anexar.' }; }
    setSending(false);
    if (result.ok) {
      attachments.sent();
      setText('');
      onSent();
    } else {
      setError(result.message);
    }
    fieldRef.current?.focus();
  }

  /** Intercepta o formulário para enfileirar pelo fluxo da conversa. */
  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void submit();
  }

  /** Enter envia; composição e Shift+Enter mantêm a edição do texto. */
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  const buttonLabel = stopping ? 'Parando execução' : showStop ? 'Parar execução' : 'Enviar mensagem';
  return (
    <div className="relative -mt-5 shrink-0 px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-5 md:px-6">
      {/* Aviso de soltar: decorativo e sem captura de eventos; o drop é tratado na janela por useFileDrop. */}
      {dragging ? <div aria-hidden className="pointer-events-none fixed inset-3 z-40 flex items-center justify-center rounded-xl border-2 border-dashed border-line-strong bg-app/80 text-base font-medium text-fg backdrop-blur-sm">Solte para anexar</div> : null}
      <div className="mx-auto w-full max-w-[760px]">
        {error ? (
          <p role="alert" className="mb-2 text-sm text-danger">
            {error}
          </p>
        ) : null}
        {dictation.error ? <p role={dictation.error.role} className={`mb-2 text-sm ${dictation.error.role === 'alert' ? 'text-danger' : 'text-muted'}`}>{dictation.error.message}</p> : null}
        <form onSubmit={handleSubmit} className="composer flex flex-col gap-2 rounded-[1.75rem] border border-line bg-surface px-4 py-3">
          {draft && !empty ? <ReturnedDraftLine key={draft.id} draft={draft} busy={taking !== null || sending} onUse={() => void takeDraft(draft, false)} onDiscard={() => void discardDraft(draft)} /> : null}
          <AttachmentChips attachments={attachments} busy={sending} />
          <textarea
            ref={fieldRef}
            value={text}
            onChange={(event) => { dictation.cancel(); setText(event.target.value); }}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            rows={1}
            aria-label={prompt ?? 'Mensagem'}
            placeholder={disabled ? disabledReason : (prompt ?? 'Escreva uma mensagem')}
            className={cn('composer-field field-sizing-content max-h-[40dvh] w-full', large ? 'min-h-[4.5rem]' : 'min-h-6', ' resize-none bg-transparent text-base/6 text-fg placeholder:text-subtle disabled:opacity-50 md:text-[15px]/6')}
          />
          {dictation.listening ? <p role="status" className="flex items-center gap-2 text-xs text-muted"><span aria-hidden className="size-2 shrink-0 animate-[pulse-dot_1.2s_linear_infinite] rounded-full bg-fg motion-reduce:animate-none" />Ouvindo… o áudio é processado pelo navegador.</p> : null}
          <div className="flex min-w-0 items-center gap-1 md:gap-2">
            <input ref={fileRef} type="file" multiple accept={FILE_PICKER_ACCEPT} className="hidden" aria-label="Escolher arquivos" onChange={(event) => { attachments.add(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
            {!disabled ? <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="shrink-0" aria-label="Anexar arquivo" disabled={sending} onClick={() => { if (attachments.items.length >= 5) attachments.atLimit(); else fileRef.current?.click(); }}><Paperclip className="size-4" strokeWidth={1.5} aria-hidden /></Button></TooltipTrigger><TooltipContent side="top">Anexar arquivo</TooltipContent></Tooltip> : null}
            <div className="ml-auto flex min-w-0 items-center justify-end gap-1 md:gap-2">
            {disabled ? null : (
              <ModelSelector value={model} onChange={(choice) => choice.model !== null && onModelChange(choice.model, choice.effort)} side="top">
                <button
                  type="button"
                  className="flex h-8 min-w-0 items-center gap-1 rounded-md px-2 text-sm text-muted hover:bg-surface-hover hover:text-fg md:max-w-[260px] max-md:h-10"
                >
                  <span className="min-w-0 truncate" title={modelLabel}>
                    {modelLabel}
                  </span>
                  <ChevronDown className="size-4 shrink-0" strokeWidth={1.5} aria-hidden />
                </button>
              </ModelSelector>
            )}
            {!disabled && model.model !== null && (model.effortLevels?.length ?? 0) > 0 ? (
              <Popover open={effortOpen} onOpenChange={setEffortOpen}>
                <PopoverTrigger asChild>
                  <button type="button" aria-label={`Effort: ${effortLabel}`} className="flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-sm text-muted hover:bg-surface-hover hover:text-fg max-md:h-10">
                    {effortLabel}
                    <ChevronDown className="hidden size-4 shrink-0 md:block" strokeWidth={1.5} aria-hidden />
                  </button>
                </PopoverTrigger>
                <PopoverContent side="top" align="end" collisionPadding={16} aria-label="Effort" className="w-[280px] max-w-[calc(100vw-2rem)]">
                  <EffortControl levels={model.effortLevels ?? []} value={model.effort} divider={false} onChange={(effort) => model.model !== null && onModelChange(model.model, effort)} />
                </PopoverContent>
              </Popover>
            ) : null}
            {/* Bola de contexto (phase 8) entre o effort e o ditado: só o ícone; o detalhe abre num dropdown. */}
            {contextPanel}
            {!disabled && dictation.supported ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label={dictation.listening ? 'Parar ditado' : 'Ditar'} aria-pressed={dictation.listening} disabled={sending || settings.status !== 'ready'} onClick={dictation.toggle} className={dictation.listening ? 'relative shrink-0 bg-selected text-fg hover:bg-selected hover:text-fg' : 'shrink-0'}>
                    {dictation.listening ? <span aria-hidden className="pointer-events-none absolute inset-0 animate-[pulse-dot_1.2s_linear_infinite] rounded-md border border-fg motion-reduce:animate-none" /> : null}
                    <Mic className="size-4" strokeWidth={1.5} aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">{dictation.listening ? 'Parar ditado' : 'Ditar (o áudio é processado pelo navegador)'}</TooltipContent>
              </Tooltip>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type={showStop ? 'button' : 'submit'}
                  variant="primary"
                  size="icon"
                  className="shrink-0 rounded-full"
                  aria-label={buttonLabel}
                  disabled={disabled || stopping || sending || (!showStop && (!hasText || !attachments.ready))}
                  onClick={showStop ? onStop : undefined}
                >
                  {stopping || sending ? (
                    <LoaderCircle data-icon="LoaderCircle" className="size-4 animate-spin" strokeWidth={1.5} aria-hidden />
                  ) : showStop ? (
                    <Square className="size-3.5 fill-current" strokeWidth={1.5} aria-hidden />
                  ) : (
                    <ArrowUp className="size-4" strokeWidth={2} aria-hidden />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">{buttonLabel}</TooltipContent>
            </Tooltip>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

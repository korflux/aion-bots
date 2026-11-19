'use client';

// Edição no lugar de uma mensagem do dono no Chat geral (phase 4, F1; design "Edição de mensagem"). Substitui a bolha, alinhada à direita, com a
// mesma linguagem da caixa do composer: os chips dos arquivos (o mesmo componente e o mesmo `useAttachments`), o campo com o texto da versão
// editada e a linha "anexar · Cancelar · Enviar".
//
// Anexos: os da versão editada voltam como chips prontos e LIGADOS (`restore(..., { linked: true })`): remover só os deixa fora da versão nova,
// sem apagar nada do servidor; os novos sobem como pendentes, com as validações do composer (tipo, tamanho, limite de 5 e visão do modelo, cuja
// recusa aparece aqui no campo). O servidor confere tudo de novo ao gravar a versão.
//
// Teclado: Enter envia, Shift+Enter quebra a linha, Esc cancela; ao abrir o foco vai para o fim do texto, e quem abriu devolve o foco ao botão
// Editar ao fechar (ver `UserBubble` em `thread.tsx`). Uma recusa mantém o texto e mostra o motivo acima das ações.
import type { TextMessageView } from '@aion/shared';
import { LoaderCircle, Paperclip } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { AttachmentChips } from './attachment-chips';
import type { ConversationSource } from './conversation-api';
import { FILE_PICKER_ACCEPT, useAttachments } from './use-attachments';
import type { ActionResult } from './use-conversation';

export interface EditMessageProps {
  message: TextMessageView;
  source: ConversationSource;
  /** Modelo efetivo da sessão: a visão dele decide se imagem pode entrar na versão nova. */
  model: string | null;
  /** Grava a versão nova; a falha volta como mensagem segura para o campo. */
  onSubmit: (content: string, attachmentIds: string[]) => Promise<ActionResult>;
  /** Fecha a edição sem mudar nada (Cancelar, Esc) ou depois de enviar. */
  onClose: () => void;
}

/** Caixa de edição da mensagem: texto e anexos da versão, recusas no próprio campo, envio pela rota de edição. */
export function EditMessage({ message, source, model, onSubmit, onClose }: EditMessageProps) {
  const attachments = useAttachments(source, model);
  const [text, setText] = useState(message.content);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Ao abrir: os anexos da versão viram chips (uma vez, mesmo com o efeito repetido do modo estrito) e o foco vai para o fim do texto.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    attachments.restore(message.attachments ?? [], { linked: true });
    const field = fieldRef.current;
    field?.focus();
    field?.setSelectionRange(field.value.length, field.value.length);
  }, [attachments, message.attachments]);

  /** Envia a versão nova; com sucesso os pendentes passam a ser dela (não podem ser apagados ao fechar) e a caixa fecha. */
  async function submit() {
    const content = text.trim();
    if (content === '' || sending) return;
    setSending(true);
    setError(null);
    let result: ActionResult;
    try {
      result = await onSubmit(content, await attachments.validate());
    } catch (failure) {
      result = { ok: false, message: failure instanceof Error ? failure.message : 'Não foi possível anexar.' };
    }
    setSending(false);
    if (result.ok) {
      attachments.sent();
      onClose();
      return;
    }
    setError(result.message);
    fieldRef.current?.focus();
  }

  /** Intercepta o formulário para enviar pela rota de edição. */
  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void submit();
  }

  /** Enter envia (fora de uma composição de IME) e Shift+Enter quebra a linha. */
  function handleFieldKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  /** Esc em qualquer ponto da caixa cancela (menos durante o envio). */
  function handleBoxKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === 'Escape' && !sending) {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      onKeyDown={handleBoxKeyDown}
      aria-label="Editar mensagem"
      className="ml-auto flex w-full flex-col gap-2 rounded-lg border border-line bg-surface grad-sheen p-3 md:max-w-[80%]"
    >
      <AttachmentChips attachments={attachments} busy={sending} />
      <textarea
        ref={fieldRef}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleFieldKeyDown}
        readOnly={sending}
        rows={1}
        aria-label="Mensagem editada"
        className="field-sizing-content max-h-[40dvh] min-h-6 w-full resize-none bg-transparent text-base/6 text-fg md:text-[15px]/6"
      />
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <input ref={fileRef} type="file" multiple accept={FILE_PICKER_ACCEPT} className="hidden" aria-label="Escolher arquivos para a versão" onChange={(event) => { attachments.add(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="mr-auto" aria-label="Anexar arquivo" disabled={sending} onClick={() => { if (attachments.items.length >= 5) attachments.atLimit(); else fileRef.current?.click(); }}>
              <Paperclip className="size-4" strokeWidth={1.5} aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Anexar arquivo</TooltipContent>
        </Tooltip>
        <Button variant="secondary" size="sm" disabled={sending} onClick={onClose}>
          Cancelar
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={sending || text.trim() === '' || !attachments.ready}>
          {sending ? <LoaderCircle data-icon="LoaderCircle" className="size-4 animate-spin motion-reduce:animate-none" strokeWidth={1.5} aria-hidden /> : null}
          Enviar
        </Button>
      </div>
    </form>
  );
}

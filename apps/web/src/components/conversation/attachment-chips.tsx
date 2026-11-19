'use client';

/* eslint-disable @next/next/no-img-element -- Conteúdo privado e previews locais usam cookies diretamente, sem proxy público do otimizador. */

// Chips dos arquivos de uma composição (design "Composer" e, na phase 4, "Edição de mensagem": "chips do composer, mesmo componente"). Fonte
// única da lista de arquivos anexados ao campo, usada pelo composer da conversa e pela caixa de edição de uma mensagem do Chat geral: miniatura da
// imagem ou cartão do documento, estado (lendo, pronto, erro com o motivo), o botão de remover e, abaixo, o aviso da recusa com "Tentar novamente".
// O estado é todo de `useAttachments`; este componente só desenha.
import { LoaderCircle, X } from 'lucide-react';
import { AttachmentIcon, attachmentSize, attachmentType } from './attachment-list';
import type { useAttachments } from './use-attachments';

export interface AttachmentChipsProps {
  attachments: ReturnType<typeof useAttachments>;
  /** Envio em curso: remover e tentar de novo ficam bloqueados até a resposta. */
  busy: boolean;
}

/** A lista de chips (só existe com arquivos) e a linha de aviso ou de progresso logo abaixo dela. */
export function AttachmentChips({ attachments, busy }: AttachmentChipsProps) {
  const loadingMessage = attachments.items.find((item) => item.status === 'loading')?.message;
  return (
    <>
      {attachments.items.length ? <div aria-label="Arquivos anexados" className="flex max-h-[136px] min-w-0 flex-wrap gap-2 overflow-y-auto">
        {attachments.items.map((item) => <div key={item.key} className={`relative flex shrink-0 items-center gap-2 rounded-md border bg-surface-hover ${item.status === 'error' ? 'border-danger' : 'border-line'} ${item.image ? 'size-14' : 'h-10 max-w-full px-2 max-md:w-full'}`}>
          {item.image ? <img src={item.preview} alt={item.file.name} className="size-full rounded-md object-cover" /> : <AttachmentIcon name={item.file.name} className="size-4 shrink-0 text-muted" />}
          {!item.image ? <span className="min-w-0"><span className="block max-w-[200px] truncate text-sm">{item.file.name}</span><span className={`block truncate text-xs ${item.status === 'error' ? 'text-danger' : 'text-muted'}`}>{item.status === 'loading' ? 'Lendo…' : item.message ?? `${attachmentType(item.file.name)} · ${attachmentSize(item.sizeBytes ?? item.file.size)}`}</span></span> : null}
          {item.status === 'loading' ? <span role="status" aria-label={`Preparando ${item.file.name}`} className={item.image ? 'absolute inset-0 flex items-center justify-center rounded-md bg-app/60' : ''}><LoaderCircle data-icon="LoaderCircle" className="size-4 animate-spin motion-reduce:animate-none" aria-hidden /></span> : null}
          {/* Alvo inteiro dentro da miniatura preserva 32px clicáveis mesmo no recorte rolável do lote. */}
          <button type="button" disabled={busy} aria-label={`Remover ${item.file.name}`} onClick={() => attachments.remove(item.key)} className={item.image ? 'absolute right-0 top-0 z-10 flex size-8 items-center justify-center rounded-full text-fg' : 'flex size-8 shrink-0 items-center justify-center rounded-md'}><X className={item.image ? 'size-5 rounded-full bg-app/80 p-1' : 'size-3'} aria-hidden /></button>
        </div>)}
      </div> : null}
      {attachments.notice ? <div className="text-xs text-danger"><p role="alert">{attachments.notice}</p>{attachments.items.filter((item) => item.status === 'error').map((item) => <button key={item.key} type="button" disabled={busy} aria-label={`Tentar novamente ${item.file.name}`} onClick={() => attachments.retry(item.key)} className="mr-2 rounded-sm py-1 text-xs underline">Tentar novamente</button>)}</div> : loadingMessage ? <p role="status" className="text-xs text-muted">{loadingMessage}</p> : null}
    </>
  );
}

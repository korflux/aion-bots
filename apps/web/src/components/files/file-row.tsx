'use client';
// Linha compacta: conteúdo privado compartilhado com a conversa, origem e ações independentes da seleção.
// Arquivo gerado pelo Python (phase 4, design "Arquivos (Configurações)"): a linha de origem ganha o ícone `Terminal` e "Gerado pelo Python · <origem>",
// o tipo da meta vem do formato (o PNG é "Imagem" e abre no visualizador, como as imagens anexadas) e o menu oferece "Baixar" o original.
import { MoreHorizontal, Terminal } from 'lucide-react';
import { useRef, useState } from 'react';
import { BotAvatar } from '@/components/bots/bot-avatar';
import { AttachmentIcon, ImageAttachment, attachmentSize, downloadLabel } from '@/components/conversation/attachment-list';
import { globalAttachmentContentUrl } from '@/components/conversation/attachments-api';
import { StatusBadge } from '@/components/settings/status-badge';
import { Button } from '@/components/ui/button';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import { formatRelativeTime } from '@/lib/format';
import type { FileItem } from './files-state';
/** Rótulo do tipo na linha (design phase 4): "Planilha" para `.xlsx`, além de "Imagem" e "Documento". */
const KIND_LABEL = { image: 'Imagem', document: 'Documento', spreadsheet: 'Planilha' } as const;

/** Tipo da linha: o do anexo, ou, no gerado pelo Python, o do formato (PNG é imagem, XLSX é planilha, os demais são documentos). */
const typeOf = (file: FileItem): keyof typeof KIND_LABEL =>
  file.kind !== 'generated' ? file.kind : file.format === 'png' ? 'image' : file.format === 'xlsx' ? 'spreadsheet' : 'document';

/** Cada linha preserva o visualizador único e usa o conteúdo autorizado na rota global; a planilha baixa o original ("Baixar"). */
export function FileRow({ file, selected, pending, now, onSelect, onDelete }: { file: FileItem; selected: boolean; pending: boolean; now: number; onSelect: () => void; onDelete: (opener: HTMLElement | null) => void }) {
  const [open, setOpen] = useState(false);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const menuOpenedImage = useRef(false);
  const url = globalAttachmentContentUrl(file.id);
  const type = typeOf(file);
  const origin = file.bot ? `${file.bot.name}${file.bot.archived ? ' (arquivado)' : ''}` : `Chat geral${file.sessionTitle ? ` · ${file.sessionTitle}` : ''}`;
  const nameClass = 'block w-full truncate text-left text-sm font-medium text-fg';
  return <li className="flex min-h-14 min-w-0 items-center gap-2 border-b border-line bg-surface py-2 pr-1 last:border-0">
    <label className="flex size-11 shrink-0 items-center justify-center" title={file.inUse ? 'Em uso por uma execução' : undefined}>
      <input type="checkbox" className="size-4 accent-action" aria-label={`Selecionar ${file.name}`} checked={selected} disabled={pending || file.inUse} onChange={onSelect} />
    </label>
    {type === 'image' ? <ImageAttachment file={file} url={url} compact open={open} onOpenChange={(value) => { if (value) menuOpenedImage.current = false; setOpen(value); }} onCloseAutoFocus={(event) => { if (menuOpenedImage.current) { event.preventDefault(); menuTrigger.current?.focus(); menuOpenedImage.current = false; } }} /> : <a href={url} download aria-label={downloadLabel(file)} className="flex size-10 shrink-0 items-center justify-center rounded-md bg-surface-hover"><AttachmentIcon name={file.name} className="size-5 text-muted" /></a>}
    <div className="min-w-0 flex-1">
      {type === 'image' ? <button type="button" className={nameClass} onClick={() => setOpen(true)}>{file.name}</button> : <a href={url} download className={nameClass}>{file.name}</a>}
      <div className="flex flex-wrap items-center gap-1 text-xs text-muted"><span>{KIND_LABEL[type]} · {attachmentSize(file.originalBytes)} · {formatRelativeTime(file.createdAt, new Date(now))}</span>{file.inUse ? <StatusBadge tone="neutral">Em uso</StatusBadge> : null}</div>
      <div className="mt-1 flex min-w-0 items-center gap-1 text-xs text-muted">{file.kind === 'generated' ? <Terminal className="size-4 shrink-0" strokeWidth={1.5} aria-hidden /> : <BotAvatar owner={file.bot} size={24} still />}<span className="truncate">{file.kind === 'generated' ? `Gerado pelo Python · ${origin}` : origin}</span></div>
    </div>
    <Menu><MenuTrigger asChild><Button ref={menuTrigger} variant="ghost" size="icon" className="size-10 shrink-0" aria-label={`Mais ações de ${file.name}`} disabled={pending}><MoreHorizontal className="size-4" aria-hidden /></Button></MenuTrigger><MenuContent>
      {type === 'image' ? <MenuItem onSelect={() => { menuOpenedImage.current = true; setOpen(true); }}>Abrir</MenuItem> : null}
      {type !== 'image' || file.kind === 'generated' ? <MenuItem asChild><a href={url} download>{file.kind === 'spreadsheet' || file.kind === 'generated' ? 'Baixar' : 'Baixar texto'}</a></MenuItem> : null}
      <MenuItem disabled={pending || file.inUse} className="text-danger" onSelect={() => onDelete(menuTrigger.current)}>Excluir</MenuItem>
    </MenuContent></Menu>
  </li>;
}

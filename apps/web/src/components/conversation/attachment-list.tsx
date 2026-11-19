'use client';

/* eslint-disable @next/next/no-img-element -- Conteúdo privado e previews locais usam cookies diretamente, sem proxy público do otimizador. */
// Conteúdo da bolha e visualizador compartilháveis com a tela Arquivos. Peças: o chip de documento (`DocumentChip`), a linha de arquivo removido
// (`RemovedAttachment`), a imagem com o visualizador em modal (`ImageAttachment`, em miniatura ou em prévia grande), a lista de anexos da bolha
// (`AttachmentList`) e os arquivos gerados pelo Python sob a resposta (`GeneratedFiles`, phase 4, F10).
import type { ConversationAttachment } from '@aion/shared';
import { FileImage, FileJson, FileSpreadsheet, FileText, FileX, ImageOff, LoaderCircle, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Modal, ModalContent } from '@/components/ui/modal';
import type { ConversationSource } from './conversation-api';
import { attachmentContentUrl } from './attachments-api';

/** Tamanho do arquivo original, sem confundir armazenamento com tamanho escolhido. */
export function attachmentSize(bytes: number, storage = false): string {
  if (storage && bytes === 0) return '0 KB';
  if (storage && bytes >= 1073741824) return `${(bytes / 1073741824).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} GB`;
  return bytes >= 1048576 ? `${(bytes / 1048576).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}
/** Extensão em minúsculas, usada para rótulo e ícone (o original do documento é descartado no servidor, então o nome é a referência). */
function extensionOf(name: string): string { return name.split('.').at(-1)?.toLowerCase() ?? ''; }
/** Tipo legível pelo nome: "Planilha" para `.xlsx` (design phase 4, F9) e a extensão em maiúsculas para os demais. */
export function attachmentType(name: string): string { const extension = extensionOf(name); return extension === 'xlsx' ? 'Planilha' : extension.toUpperCase() || 'Documento'; }
/**
 * Ícone do arquivo não imagem, fonte única dos chips do composer, da bolha, da atividade Python e da linha de Arquivos (iconografia do design da
 * phase 4): `FileSpreadsheet` para XLSX e CSV, `FileJson` para JSON, `FileImage` para o PNG gerado (na lista de arquivos da atividade) e `FileText`
 * para os demais documentos. `data-file-icon` (`spreadsheet`, `json`, `image` ou `text`) diz qual ícone saiu, para o E2E conferir o tipo sem depender da classe do desenho.
 */
export function AttachmentIcon({ name, className }: { name: string; className: string }) {
  const extension = extensionOf(name);
  const [Icon, kind] = extension === 'xlsx' || extension === 'csv' ? ([FileSpreadsheet, 'spreadsheet'] as const) : extension === 'json' ? ([FileJson, 'json'] as const) : extension === 'png' ? ([FileImage, 'image'] as const) : ([FileText, 'text'] as const);
  return <Icon className={className} data-file-icon={kind} aria-hidden />;
}
/** Rótulo acessível do download: a planilha e o arquivo gerado pelo Python baixam o original; os documentos baixam só o texto extraído. */
export function downloadLabel(file: Pick<ConversationAttachment, 'kind' | 'name'>): string { return file.kind === 'spreadsheet' || file.kind === 'generated' ? `Baixar ${file.name}` : `Baixar texto de ${file.name}`; }

/** O conteúdo monta novamente em cada abertura, permitindo repetir uma carga que falhou transitoriamente. */
function ImageContent({ url, name }: { url: string; name: string }) {
  const [loaded, setLoaded] = useState(false); const [failed, setFailed] = useState(false);
  return <div className="relative mt-3 flex min-h-24 items-center justify-center rounded-md bg-app">
    {!loaded && !failed ? <LoaderCircle data-icon="LoaderCircle" aria-label="Carregando imagem" className="absolute size-5 animate-spin motion-reduce:animate-none" /> : null}
    {failed ? <p role="status" className="p-6 text-sm text-muted">Imagem indisponível</p> : <img src={url} alt={name} onLoad={() => setLoaded(true)} onError={() => setFailed(true)} className="max-h-[75dvh] max-w-full object-contain" />}
  </div>;
}
/**
 * Imagem com o visualizador em modal. Três tamanhos: a miniatura da bolha (72/96 px), a `compact` da linha de Arquivos (40 px) e a `preview` do PNG
 * gerado pelo Python (design "Arquivos gerados na resposta": até 480 x 360 px, inteira com `object-contain`, para o gráfico ser legível sem abrir).
 * Caixa fixa antes da carga evita deslocamento do autoscroll.
 */
export function ImageAttachment({ file, url, compact = false, preview = false, open: controlledOpen, onOpenChange, onCloseAutoFocus }: { file: Pick<ConversationAttachment, 'id' | 'name'>; url: string; compact?: boolean; preview?: boolean; open?: boolean; onOpenChange?: (open: boolean) => void; onCloseAutoFocus?: (event: Event) => void }) {
  const [failed, setFailed] = useState(false);
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  /** O mesmo visualizador aceita a miniatura da bolha ou ações externas da lista. */
  const setOpen = onOpenChange ?? setLocalOpen;
  const box = preview ? 'min-h-24 w-full max-w-[480px]' : compact ? 'size-10' : 'size-[72px] md:size-24';
  return <>
    <button type="button" aria-label={`Abrir imagem ${file.name}`} onClick={() => setOpen(true)} className={`flex shrink-0 flex-col items-center justify-center overflow-hidden rounded-md border border-line bg-surface-hover ${box}`}>
      {failed ? <><ImageOff className="size-5" aria-hidden /><span className="text-xs text-muted">{preview ? 'Imagem indisponível' : 'Indisponível'}</span></> : <img src={url} alt={file.name} onError={() => setFailed(true)} className={preview ? 'max-h-[360px] w-full object-contain' : 'size-full object-cover'} />}
    </button>
    <Modal open={open} onOpenChange={setOpen}><ModalContent title={file.name} onCloseAutoFocus={onCloseAutoFocus} className="max-w-[960px] p-3 [&>h2]:pr-10 [&>h2]:truncate">
      <Button variant="ghost" size="icon" aria-label="Fechar" onClick={() => setOpen(false)} className="absolute right-2 top-2"><X className="size-4" aria-hidden /></Button>
      {open ? <ImageContent url={url} name={file.name} /> : null}
    </ModalContent></Modal>
  </>;
}
/** Arquivo removido: só o nome, com borda tracejada e sem ação (o conteúdo já não existe). */
function RemovedAttachment({ name }: { name: string }) {
  return <div className="flex h-10 w-full min-w-0 items-center gap-2 rounded-md border border-dashed border-line px-2 text-sm text-muted"><FileX className="size-4 shrink-0" aria-hidden /><span className="truncate" title={`Arquivo removido: ${name}`}>Arquivo removido: {name}</span></div>;
}
/** Chip de download de arquivo não imagem: ícone por tipo, nome truncado e "TIPO · tamanho". `className` ajusta a largura ao contexto. */
function DocumentChip({ file, url, className = 'w-full' }: { file: ConversationAttachment; url: string; className?: string }) {
  return <a href={url} download aria-label={downloadLabel(file)} className={`flex h-10 min-w-0 items-center gap-2 rounded-md border border-line bg-surface-hover px-2 ${className}`}><AttachmentIcon name={file.name} className="size-4 shrink-0 text-muted" /><span className="min-w-0"><span className="block truncate text-sm" title={file.name}>{file.name}</span><span className="block text-xs text-muted">{attachmentType(file.name)} · {attachmentSize(file.sizeBytes)}</span></span></a>;
}
/** Referências da mensagem, com estado removido sem ação; imagens primeiro, depois documentos (texto extraído) e planilhas (original). */
export function AttachmentList({ files, source }: { files: readonly ConversationAttachment[]; source: ConversationSource }) {
  if (!files.length) return null;
  return <div className="mb-2 flex min-w-0 flex-wrap gap-2 whitespace-normal">
    {[...files].sort((a, b) => Number(a.kind !== 'image') - Number(b.kind !== 'image')).map((file) => file.removed ? <RemovedAttachment key={file.id} name={file.name} /> : file.kind === 'image' ? <ImageAttachment key={file.id} file={file} url={attachmentContentUrl(source, file.id)} /> : <DocumentChip key={file.id} file={file} url={attachmentContentUrl(source, file.id)} />)}
  </div>;
}
/**
 * Arquivos gerados pelo Python logo abaixo da resposta (phase 4, F10; design "Arquivos gerados na resposta"): cada PNG em prévia grande que abre o
 * mesmo visualizador das imagens anexadas, e os demais formatos como chips de download do original (em largura total no celular e lado a lado a
 * partir de `sm`). O removido vira a linha "Arquivo removido". A ordem é a da gravação (a do `/out/`).
 */
export function GeneratedFiles({ files, source }: { files: readonly ConversationAttachment[]; source: ConversationSource }) {
  if (!files.length) return null;
  const images = files.filter((file) => !file.removed && file.format === 'png');
  const others = files.filter((file) => file.removed || file.format !== 'png');
  return <div className="mt-2 flex min-w-0 flex-col gap-2" data-generated-files="">
    {images.map((file) => <ImageAttachment key={file.id} file={file} url={attachmentContentUrl(source, file.id)} preview />)}
    {others.length ? <div className="flex min-w-0 flex-wrap gap-2">{others.map((file) => file.removed ? <RemovedAttachment key={file.id} name={file.name} /> : <DocumentChip key={file.id} file={file} url={attachmentContentUrl(source, file.id)} className="w-full sm:w-auto sm:max-w-[320px]" />)}</div> : null}
  </div>;
}

'use client';
// Rascunho dos arquivos: uploads independentes, cancelamento e remoção pertencem à composição.
// Origem sob demanda (phase 5, T5): o composer do Início ainda não tem conversa (abrir o Início não cria sessão), e o anexo pertence a uma conversa, então a origem pode ser
// uma FUNÇÃO que abre o rascunho invisível do Chat geral na primeira necessidade (o primeiro upload). Ela roda uma vez por composição e o resultado é reaproveitado; cada chip
// guarda a conversa onde o arquivo foi enviado (`where`) para removê-lo de lá.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, apiFetch, apiErrorMessage } from '@/lib/api-client';
import { useSession } from '@/lib/session-context';
import { fetchModels } from '@/components/models/models-api';
import { ATTACHMENT_PREPARATION_CONCURRENCY, ERROR_CODES, type AttachmentView, type ConversationAttachment, type ModelEntry } from '@aion/shared';
import type { ConversationSource } from './conversation-api';
import { attachmentContentUrl, removePendingAttachment, uploadAttachment } from './attachments-api';
import { convertImage } from './image-convert';

/** Extensões do seletor; o servidor confere o conteúdo real (JSON como texto e `.xlsx` como planilha entram na phase 4, ATT-01). */
export const FILE_ACCEPT = '.jpg,.jpeg,.png,.webp,.pdf,.docx,.xlsx,.txt,.md,.csv,.json';
/**
 * `accept` do seletor nativo: as mesmas extensões mais os tipos MIME equivalentes. Só com extensões o Android abre apenas "Arquivos"; com
 * tipos de imagem ele também oferece câmera e galeria. A validação continua por extensão em `prepare` (e no servidor), então nada além da
 * lista acima é enviado.
 */
export const FILE_PICKER_ACCEPT = [
  FILE_ACCEPT,
  'image/jpeg,image/png,image/webp',
  'application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain,text/markdown,text/csv,application/json',
].join(',');
/** De onde vêm os arquivos: a conversa já conhecida ou uma função que a abre sob demanda (ver o cabeçalho). */
export type AttachmentSource = ConversationSource | (() => Promise<ConversationSource>);

/**
 * Um chip do composer. `uploaded` é o arquivo já pendente no servidor (só o id interessa). `sizeBytes` existe no arquivo devolvido por um rascunho
 * (phase 4, F5), que não tem o `File` local: o chip mostra o tamanho original do servidor. `linked` marca o arquivo já ligado a uma versão da
 * mensagem (edição no Chat geral, phase 4 F1): tirá-lo do campo só o deixa fora da versão nova, nunca o apaga do servidor.
 */
export interface DraftAttachment { key: string; file: File; image: boolean; preview?: string; status: 'loading' | 'ready' | 'error'; message?: string; uploaded?: Pick<AttachmentView, 'id'>; where?: ConversationSource; sizeBytes?: number; controller: AbortController; linked?: boolean }
const NO_VISION = ERROR_CODES.MODEL_NO_IMAGE_SUPPORT.message;

/** Mantém cada resposta tardia isolada do chip removido e da conversa desmontada. */
export function useAttachments(source: AttachmentSource, model: string | null) {
  const { csrfToken } = useSession();
  const [items, setItems] = useState<DraftAttachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const drafts = useRef<DraftAttachment[]>([]);
  const currentModel = useRef(model);
  useLayoutEffect(() => { currentModel.current = model; }, [model]);
  const alive = useRef(true);
  const vision = useRef(new Map<string, Promise<boolean>>());
  const preparing = useRef(0);
  const waiting = useRef<DraftAttachment[]>([]);
  /** Origem sob demanda: a abertura em curso ou concluída (uma só por composição). Fica nula se a abertura falhou, para a próxima tentativa abrir de novo. */
  const opened = useRef<Promise<ConversationSource> | null>(null);
  /** A conversa dos arquivos: a origem fixa, ou a que a função abre na primeira necessidade. */
  function conversation(): Promise<ConversationSource> {
    if (typeof source !== 'function') return Promise.resolve(source);
    return (opened.current ??= source().catch((error: unknown) => { opened.current = null; throw error; }));
  }
  /** A conversa conhecida agora (origem fixa), ou nula enquanto a origem sob demanda não foi aberta. */
  const known = typeof source === 'function' ? null : source;

  /** Espelha o rascunho imediatamente, inclusive durante vários arquivos escolhidos no mesmo gesto. */
  function update(next: DraftAttachment[]) { drafts.current = next; if (alive.current) setItems(next); }
  /** Só o servidor decide a visão; falha transitória não entra no cache da composição. */
  function checkVision(id: string): Promise<boolean> {
    const known = vision.current.get(id); if (known) return known;
    const pending = fetchModels().then(async (models) => {
      const entry = models.find((candidate) => candidate.id === id);
      if (entry?.acceptsImages !== null && entry?.acceptsImages !== undefined) return entry.acceptsImages;
      const verified = await apiFetch<ModelEntry>('/api/models/verify-image', { method: 'POST', body: { model: id }, csrfToken });
      return verified.acceptsImages === true;
    }).catch((error) => { if (error instanceof ApiError && error.code !== 'MODEL_IMAGE_CHECK_FAILED' && error.code !== 'NETWORK_ERROR') throw error; throw new Error('Não consegui verificar o modelo agora. Tente de novo.'); }).finally(() => vision.current.delete(id));
    vision.current.set(id, pending); return pending;
  }
  /** Exclui o conteúdo de pendente conhecido; o prazo de retenção cobre um upload abortado antes da resposta. */
  function erase(item: DraftAttachment) { item.controller.abort(); if (item.preview) URL.revokeObjectURL(item.preview); const where = item.where ?? known; if (item.uploaded && !item.linked && where) void removePendingAttachment(where, item.uploaded.id, csrfToken).catch(() => undefined); }
  const kind = known?.kind; const id = known?.id;
  useEffect(() => { alive.current = true; return () => { alive.current = false; for (const item of drafts.current) { item.controller.abort(); if (item.preview) URL.revokeObjectURL(item.preview); const where = item.where ?? (kind && id ? { kind, id } : null); if (item.uploaded && !item.linked && where) void removePendingAttachment(where, item.uploaded.id, csrfToken).catch(() => undefined); } }; }, [kind, id, csrfToken]); // A composição é remontada quando a origem muda.
  /** Atualiza um chip que ainda pertence ao rascunho. */
  function patch(key: string, change: Partial<DraftAttachment>) { update(drafts.current.map((item) => item.key === key ? { ...item, ...change } : item)); }
  /** Valida, prepara e envia um arquivo, conservando o motivo legível da recusa. */
  async function prepare(item: DraftAttachment) {
    try {
      const extension = item.file.name.split('.').at(-1)?.toLowerCase() ?? '';
      if (!FILE_ACCEPT.split(',').includes(`.${extension}`)) throw new Error(ERROR_CODES.ATTACHMENT_TYPE_UNSUPPORTED.message);
      const max = item.image ? 10 : ['pdf', 'docx', 'xlsx'].includes(extension) ? 15 : 1;
      if (item.file.size > max * 1024 * 1024) throw new Error(ERROR_CODES.ATTACHMENT_TOO_LARGE.message);
      let body: Blob = item.file;
      if (item.image) {
        patch(item.key, { message: 'Verificando se o modelo aceita imagens…' });
        const selected = currentModel.current;
        if (!selected || !(await checkVision(selected))) throw new Error(NO_VISION);
        if (currentModel.current !== selected) throw new Error('O modelo mudou. Tente anexar novamente.');
        patch(item.key, { message: 'Preparando imagem…' });
        body = await convertImage(item.file);
        if (currentModel.current !== selected) throw new Error('O modelo mudou. Tente anexar novamente.');
      }
      if (item.controller.signal.aborted) return;
      patch(item.key, { message: 'Lendo…' });
      const where = await conversation();
      if (item.controller.signal.aborted) return;
      const uploaded = await uploadAttachment(where, body, item.file.name, csrfToken, item.controller.signal);
      if (!alive.current || !drafts.current.some((candidate) => candidate.key === item.key)) { void removePendingAttachment(where, uploaded.id, csrfToken).catch(() => undefined); return; }
      patch(item.key, { uploaded, where, status: 'ready', message: undefined });
    } catch (error) {
      if (item.controller.signal.aborted) return;
      const message = error instanceof Error && !(error.name === 'ApiError') ? error.message : apiErrorMessage(error);
      patch(item.key, { status: 'error', message }); setNotice(message);
    }
  }
  /** Respeita os dois extratores do servidor sem recusar um lote normal; itens removidos não iniciam upload. */
  function drain() {
    while (alive.current && preparing.current < ATTACHMENT_PREPARATION_CONCURRENCY && waiting.current.length) {
      const item = waiting.current.shift()!;
      if (item.controller.signal.aborted) continue;
      preparing.current++;
      void prepare(item).finally(() => { preparing.current--; drain(); });
    }
  }
  /** A fila pertence ao rascunho e conserva o cancelamento individual, inclusive antes da preparação. */
  function schedule(items: DraftAttachment[]) { waiting.current.push(...items); drain(); }
  /** Informa o teto pelo gesto do botão, sem criar arquivo artificial. */
  function atLimit() { setNotice(ERROR_CODES.ATTACHMENT_LIMIT_REACHED.message); }
  /** Reserva os cinco lugares antes de iniciar uploads, evitando ultrapassagem por gestos rápidos. */
  function add(files: File[]) {
    const room = 5 - drafts.current.length;
    if (files.length > room) setNotice(ERROR_CODES.ATTACHMENT_LIMIT_REACHED.message); else setNotice(null);
    const added = files.slice(0, room).map((file): DraftAttachment => { const image = /\.(jpe?g|png|webp)$/i.test(file.name); return { key: crypto.randomUUID(), file, image, preview: image ? URL.createObjectURL(file) : undefined, status: 'loading', controller: new AbortController() }; });
    update([...drafts.current, ...added]); schedule(added);
  }
  /** Remover permanece disponível também durante a carga. */
  function remove(key: string) { const item = drafts.current.find((candidate) => candidate.key === key); if (item) erase(item); update(drafts.current.filter((candidate) => candidate.key !== key)); setNotice(null); }
  /** Repetição explícita conserva o arquivo local e não usa resposta transitória como incompatibilidade. */
  function retry(key: string) { const item = drafts.current.find((candidate) => candidate.key === key); if (!item) return; const next = { ...item, status: 'loading' as const, message: undefined, controller: new AbortController() }; patch(key, next); setNotice(null); schedule([next]); }
  /** Reconfere o modelo atual no envio: trocar o seletor nunca permite burlar a visão. */
  async function validate(): Promise<string[]> { if (drafts.current.some((item) => item.status !== 'ready')) throw new Error('Espere os arquivos ficarem prontos ou remova os recusados.'); const selected = currentModel.current; if (drafts.current.some((item) => item.image) && (!selected || !(await checkVision(selected)))) throw new Error(NO_VISION); if (selected !== currentModel.current) throw new Error('O modelo mudou. Tente enviar novamente.'); return drafts.current.map((item) => item.uploaded!.id); }
  /**
   * Arquivos do rascunho devolvido (phase 4, F5), já pendentes no servidor: entram como chips prontos, sem novo upload, e saem pelo mesmo
   * remover/descartar dos demais. Imagem mostra o conteúdo privado da conversa como miniatura. Removidos não voltam (não podem ser enviados).
   * `linked` (edição no Chat geral, phase 4 F1): os arquivos já ligados à versão editada voltam como chips prontos que remover só tira do campo.
   */
  function restore(files: readonly ConversationAttachment[], { linked = false } = {}) {
    if (known === null) return; // rascunho devolvido e edição só existem numa conversa já aberta
    const restored = files.filter((file) => !file.removed).map((file): DraftAttachment => ({
      key: crypto.randomUUID(), file: new File([], file.name), image: file.kind === 'image', preview: file.kind === 'image' ? attachmentContentUrl(known, file.id) : undefined,
      status: 'ready', uploaded: { id: file.id }, sizeBytes: file.sizeBytes, controller: new AbortController(), linked,
    }));
    if (restored.length) update([...drafts.current, ...restored]);
  }
  /** Descarta arquivos pendentes que não viraram chip ("Descartar" do rascunho devolvido); falha só deixa o pendente para o vencimento de 24 h. */
  function discard(ids: readonly string[]) { if (known === null) return; for (const id of ids) void removePendingAttachment(known, id, csrfToken).catch(() => undefined); }
  /** Depois de vinculado à execução, só libera previews; não apaga arquivos enviados. */
  function sent() { for (const item of drafts.current) if (item.preview) URL.revokeObjectURL(item.preview); update([]); setNotice(null); }
  return { items, notice, atLimit, add, remove, retry, validate, sent, restore, discard, ready: items.every((item) => item.status === 'ready') };
}

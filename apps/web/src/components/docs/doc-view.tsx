'use client';

// Página do doc (phase 14, passo 5; DOC-02 a DOC-04, A8, A11, A15, A17 a A20): o dono LÊ o texto formatado, EDITA no editor visual (ou no "Ver Markdown", o texto cru) e SALVA
// sobre a versão que leu. É a tela de `/artefatos/docs/[docId]` e a que o painel ao lado da conversa mostra (variante `embedded`, abaixo).
//
// FLUXO
//   leitura    título, quem alterou por último e quando, e o texto formatado (`Markdown`, o leitor seguro do chat: sem HTML cru, sem imagem, links com noopener). Daqui saem
//              Editar, Histórico (restaurar versão), Compartilhar (bots com acesso), Baixar .md e Excluir.
//   edição     `EditSession` (doc-state.ts): editor visual (Milkdown, `doc-editor.tsx`) ou textarea cru, o título editável e Cancelar, Salvar e "Ver Markdown". Alternar entre os
//              dois, sem digitar, não é alteração (A17); Salvar sem alteração não chama a API e nenhuma versão nasce.
//   salvar     `PATCH /api/docs/:id` com a versão que a tela leu. Recusa de título ou de texto (A8) aparece como mensagem e NADA é enviado quando é o limite que a tela já conhece;
//              a recusa do servidor também aparece. Em todo erro o texto do dono continua no campo.
//   conflito   o bot (ou outra aba) gravou uma versão nova enquanto o dono editava (A11): o servidor responde `DOC_CONFLICT`, o aviso explica, o texto digitado CONTINUA na tela
//              (o editor não é remontado), nada foi gravado e a versão do outro fica. "Copiar meu texto" e "Descartar e carregar a versão atual" são as saídas do dono; salvar
//              por cima nunca acontece em silêncio.
//
// POR QUE O TEXTO NÃO MORA NO ESTADO DO REACT NO MODO VISUAL: o editor é um ProseMirror com estado próprio, e o texto só é serializado ao salvar (e só se o dono alterou algo,
// senão devolve o gravado byte a byte). A sessão guarda o texto de partida do campo; o texto atual é pedido ao editor por `ref` na hora de salvar, copiar ou alternar.
//
// DESENHO: tipografia de documento (coluna de 44 rem, o texto é o protagonista), cabeçalho fixo com as ações (ícone sozinho no celular, com nome acessível) e a mesma superfície
// da Faísca (tokens de `globals.css`). A área de rolagem é só o texto: o cabeçalho e o Salvar nunca saem da tela.
//
// VARIANTE EMBUTIDA (phase 14, passo 7; `embedded`): a mesma tela dentro do painel ao lado da conversa (`artifacts/artifact-panel.tsx`), sem lógica duplicada. O painel é dono do controle de
// sair (Voltar ou Fechar painel e "Abrir em tela inteira"), então aqui some o "Voltar" de página e o título vira `h2` (a conversa já tem o `h1`); a alteração não salva é avisada ao
// painel (`onDirtyChange`) para ele perguntar antes de fechar; excluir o doc fecha o painel (`onDeleted`) em vez de navegar; o erro de carga não leva o "Voltar" de página; e as ações do
// cabeçalho decidem rótulo e quebra de linha pela largura do painel e não pela da janela (`PANEL_ACTIONS`). O resto, inclusive o conflito que mantém o texto digitado, é igual.
import type { Doc } from '@aion/shared';
import { countChars, DOC_LIMITS } from '@aion/shared';
import { ArrowLeft, Code, Download, History, LoaderCircle, Pencil, SearchX, Share2, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { EmbeddedArtifact } from '@/components/artifacts/artifact-panel';
import { BotLoadError, BotLoading } from '@/components/bots/bot-states';
import { Markdown } from '@/components/conversation/markdown';
import { EmptyState } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal, ModalActions, ModalContent } from '@/components/ui/modal';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiErrorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { formatRelativeTime } from '@/lib/format';
import { useSession } from '@/lib/session-context';
import { deleteDoc, fetchDoc, updateDoc } from './api';
import { DocEditor, type DocEditorHandle } from './doc-editor';
import { DocHistory } from './doc-history';
import { DocSharing } from './doc-sharing';
import {
  IntentLedger,
  authorLabel,
  buildUpdate,
  contentProblem,
  currentText,
  draftProblem,
  failureOf,
  fallBackToMarkdown,
  hasChanges,
  markEditorDirty,
  markdownFile,
  renameDraft,
  showMarkdown,
  showVisual,
  sizeLabel,
  startEditing,
  typeMarkdown,
  type EditSession,
} from './doc-state';

type Load = { status: 'loading' } | { status: 'ready'; doc: Doc } | { status: 'not-found' } | { status: 'error'; message: string };

/** O aviso persistente do que mudou fora da tela do dono: o doc mudou (versão nova de outro autor) ou deixou de existir. */
type Notice = 'conflict' | 'gone';

/** O que a tela está confirmando antes de descartar a edição: o Cancelar do próprio doc ou sair para outra página. */
type Discard = { kind: 'cancel' } | { kind: 'leave'; href: string };

/** Uma mensagem de recusa ou falha, com o campo que ela marca (o título ganha `aria-invalid`). */
interface Problem {
  field: 'title' | 'content' | 'save';
  message: string;
}

/**
 * Réguas do cabeçalho de ações. A PÁGINA decide pela janela (`max-md:`, abaixo de 768 px). Embutido no painel, a janela não diz nada: um painel de 26 a 44 rem numa janela larga é estreito
 * demais para cinco ações com rótulo (passam da borda do painel, que corta o que sobra), então vale a largura DO PAINEL (container query `panel`, do corpo do painel) e o grupo quebra a
 * linha em vez de passar da borda (`flex-wrap`). Nos dois só o ícone aparece abaixo do limite e o rótulo continua como nome acessível (`sr-only`), com alvo de toque de 40 px. São
 * literais (e não montadas por prefixo) para o Tailwind enxergar cada classe.
 */
const PAGE_ACTIONS = { group: '', button: 'max-md:size-10 max-md:px-0', label: 'max-md:sr-only' } as const;
const PANEL_ACTIONS = { group: 'flex-wrap', button: '@max-2xl/panel:size-10 @max-2xl/panel:px-0', label: '@max-2xl/panel:sr-only' } as const;

/** Ação do cabeçalho: ícone e rótulo; onde só o ícone cabe (`rules`) o rótulo continua como nome acessível. */
function HeaderAction({ icon: Icon, label, rules, onClick }: { icon: typeof History; label: string; rules: typeof PAGE_ACTIONS | typeof PANEL_ACTIONS; onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" className={rules.button} onClick={onClick}>
      <Icon className="size-4" strokeWidth={1.5} aria-hidden />
      <span className={rules.label}>{label}</span>
    </Button>
  );
}

/** Contador "12.345 / 100.000" do texto cru: normal, e perigo acima do limite. */
function Counter({ size }: { size: number }) {
  return (
    <p id="doc-contador" className={cn('shrink-0 text-xs tabular-nums', size > DOC_LIMITS.contentChars ? 'text-danger' : 'text-subtle')}>
      {size.toLocaleString('pt-BR')} / {DOC_LIMITS.contentChars.toLocaleString('pt-BR')}
    </p>
  );
}

/**
 * O aviso do que mudou fora da tela. Com uma edição em andamento (`editing`) o texto do dono continua no campo e o aviso oferece copiá-lo antes de qualquer descarte; na leitura
 * (uma restauração recusada) só há a versão atual a carregar.
 */
function NoticeBanner({ notice, editing, onCopy, onReload }: { notice: Notice; editing: boolean; onCopy: () => void; onReload: () => void }) {
  const title = notice === 'gone' ? 'Este doc não existe mais' : editing ? 'O doc mudou enquanto você editava' : 'O doc mudou';
  const text =
    notice === 'gone'
      ? 'Ele foi excluído enquanto você editava. Seu texto continua na tela: copie-o se quiser guardá-lo.'
      : editing
        ? 'Outra alteração foi gravada depois que você abriu o doc, então nada do que você escreveu foi salvo. Seu texto continua na tela: copie-o antes de carregar a versão atual.'
        : 'Outra alteração foi gravada depois que você abriu o doc. Carregue a versão atual para continuar.';
  return (
    <section role="alert" className="mb-4 rounded-md border border-warning bg-warning-soft p-3">
      <h2 className="text-sm font-semibold text-fg">{title}</h2>
      <p className="mt-1 text-sm text-muted">{text}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {editing ? (
          <Button variant="secondary" size="sm" onClick={onCopy}>
            Copiar meu texto
          </Button>
        ) : null}
        {notice === 'gone' ? (
          <Button asChild variant="secondary" size="sm">
            <Link href="/artefatos" prefetch={false}>
              Ir para Artefatos
            </Link>
          </Button>
        ) : (
          <Button variant="primary" size="sm" onClick={onReload}>
            {editing ? 'Descartar e carregar a versão atual' : 'Carregar a versão atual'}
          </Button>
        )}
      </div>
    </section>
  );
}

export function DocView({ docId, embedded }: { docId: string; embedded?: EmbeddedArtifact }) {
  const { csrfToken } = useSession();
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  /** Incrementar relê o doc do servidor. */
  const [reloadKey, setReloadKey] = useState(0);
  /** A edição em andamento; `null` é a leitura. */
  const [session, setSession] = useState<EditSession | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [discard, setDiscard] = useState<Discard | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sharingOpen, setSharingOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const editorRef = useRef<DocEditorHandle>(null);
  /** O botão Editar some durante a edição: ao voltar à leitura, o foco do teclado volta a ele em vez de se perder no corpo da página. */
  const refocusEdit = useRef(false);
  const [saveLedger] = useState(() => new IntentLedger());
  const [deleteLedger] = useState(() => new IntentLedger());

  useEffect(() => {
    let cancelled = false;
    fetchDoc(docId).then(
      (doc) => {
        if (!cancelled) setLoad({ status: 'ready', doc });
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.code === 'DOC_NOT_FOUND') setLoad({ status: 'not-found' });
        else setLoad({ status: 'error', message: apiErrorMessage(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [docId, reloadKey]);

  const doc = load.status === 'ready' ? load.doc : null;
  const dirty = doc !== null && session !== null && hasChanges(doc, session);

  // Texto não salvo: o navegador pergunta antes de fechar a aba ou recarregar.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // Embutido no painel: avisa a alteração não salva (e que ela acabou quando a tela sai), para o painel perguntar antes de fechar ou trocar de artefato.
  const reportDirty = embedded?.onDirtyChange;
  useEffect(() => {
    reportDirty?.(dirty);
  }, [reportDirty, dirty]);
  useEffect(() => () => reportDirty?.(false), [reportDirty]);

  /** O problema do texto cru que a tela já enxerga enquanto o dono digita (acima de 100.000 caracteres): Salvar fica desabilitado e a mensagem aparece junto do contador. */
  const rawProblem = useMemo(() => (session?.mode === 'markdown' ? contentProblem(session.text) : null), [session]);
  const rawSize = useMemo(() => (session?.mode === 'markdown' ? countChars(session.text) : 0), [session]);

  /** O texto que a edição teria agora: o do editor visual (o gravado, byte a byte, sem alteração) ou o do campo cru. */
  function textNow(current: EditSession): string {
    return currentText(current, () => editorRef.current?.getMarkdown() ?? current.text);
  }

  function endEditing() {
    refocusEdit.current = true;
    setSession(null);
    setProblem(null);
    setNotice(null);
  }

  /** Relê o doc. `quiet` mantém a tela como está até a resposta chegar (a restauração); sem ele a tela volta ao carregando (descartar e carregar a versão atual). */
  function reload(quiet: boolean) {
    if (!quiet) {
      endEditing();
      setLoad({ status: 'loading' });
    }
    setReloadKey((value) => value + 1);
  }

  function startEdit() {
    if (!doc) return;
    setProblem(null);
    setSession(startEditing(doc));
  }

  function toggleMarkdown() {
    if (!session) return;
    setProblem(null);
    setSession(session.mode === 'visual' ? showMarkdown(session, textNow(session)) : showVisual(session));
  }

  function cancel() {
    if (dirty) setDiscard({ kind: 'cancel' });
    else endEditing();
  }

  async function copyMyText() {
    if (!session) return;
    try {
      await navigator.clipboard.writeText(textNow(session));
      toast('Texto copiado');
    } catch {
      toast.error('Não foi possível copiar. Selecione o texto no campo e copie.', { duration: Infinity });
    }
  }

  /**
   * Salva o rascunho sobre a versão lida. Ordem: (1) os limites que a tela conhece, com a mensagem e SEM enviar nada; (2) sem alteração, sai sem chamar a API; (3) grava com a
   * `operationId` da intenção (a repetição depois de uma falha de rede reaproveita o id). Em qualquer falha o texto fica no campo; só o sucesso volta à leitura.
   */
  async function save() {
    if (!session || !doc || saving) return;
    const text = textNow(session);
    const found = draftProblem(session.title, text);
    if (found) {
      setProblem(found);
      return;
    }
    const body = buildUpdate(doc, { title: session.title, content: text });
    if (!body) {
      endEditing();
      return;
    }
    setProblem(null);
    setSaving(true);
    try {
      const result = await updateDoc(doc.id, saveLedger.stamp(body), csrfToken);
      saveLedger.clear();
      // O servidor guarda o texto como foi enviado (nunca o normaliza): o texto salvo é o que a tela enviou.
      setLoad({ status: 'ready', doc: { ...result.doc, content: body.edit ? text : doc.content } });
      endEditing();
      toast('Doc salvo');
    } catch (error) {
      const failure = failureOf(error);
      if (failure.kind === 'message') setProblem({ field: 'save', message: failure.message });
      else setNotice(failure.kind);
    } finally {
      setSaving(false);
    }
  }

  /** Baixa o texto GRAVADO (não o rascunho) como `.md`, no navegador: nenhuma rota, e o arquivo é byte a byte o que o servidor guarda. */
  function download() {
    if (!doc) return;
    const file = markdownFile(doc);
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    document.body.append(link);
    link.click();
    link.remove();
    // Revogar na hora cancelaria o download em alguns navegadores.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function remove() {
    if (!doc || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError('');
    try {
      await deleteDoc(doc.id, deleteLedger.stamp({}), csrfToken);
      deleteLedger.clear();
      toast('Doc excluído');
      // O doc não existe mais: a tela sai dele (o botão fica travado até lá), fechando o painel quando embutida.
      if (embedded) embedded.onDeleted();
      else router.replace('/artefatos');
    } catch (error) {
      setDeleteError(apiErrorMessage(error));
      setDeleteBusy(false);
    }
  }

  function closeDelete() {
    if (deleteBusy) return;
    setDeleteOpen(false);
    setDeleteError('');
  }

  if (load.status === 'loading') return <BotLoading label="Carregando doc" />;
  if (load.status === 'error') {
    // O `BotLoadError` traz o "Voltar" de página (ao pai da conversa, no painel): embutida, a saída é o controle do painel, e a tela só oferece tentar de novo.
    return embedded ? (
      <EmptyState
        icon={SearchX}
        action={
          <Button variant="secondary" onClick={() => reload(false)}>
            Tentar novamente
          </Button>
        }
      >
        {load.message}
      </EmptyState>
    ) : (
      <BotLoadError message={load.message} onRetry={() => reload(false)} />
    );
  }
  if (load.status === 'not-found' || doc === null) {
    return (
      <EmptyState
        icon={SearchX}
        action={
          <Button asChild variant="secondary">
            <Link href="/artefatos" prefetch={false}>
              Ir para Artefatos
            </Link>
          </Button>
        }
      >
        Doc não encontrado. Ele não existe ou foi excluído.
      </EmptyState>
    );
  }

  const editing = session !== null;
  /** O título da tela é o `h1` da página; embutido no painel, a conversa já tem o `h1` e ele é um `h2`. */
  const Title = embedded ? 'h2' : 'h1';
  const actions = embedded ? PANEL_ACTIONS : PAGE_ACTIONS;
  const shownProblem = problem ?? (rawProblem ? ({ field: 'content', message: rawProblem } satisfies Problem) : null);
  const blocked = notice !== null || rawProblem !== null;

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-[44rem] flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 md:px-6">
        {embedded ? null : (
          <Button asChild variant="ghost" size="icon" className="-ml-2 shrink-0">
            <Link
              href="/artefatos"
              prefetch={false}
              aria-label="Voltar"
              onClick={(event) => {
                // A navegação do app não dispara `beforeunload`: com texto não salvo, a saída pede confirmação.
                if (dirty) {
                  event.preventDefault();
                  setDiscard({ kind: 'leave', href: '/artefatos' });
                }
              }}
            >
              <ArrowLeft className="size-[18px]" strokeWidth={1.5} aria-hidden />
            </Link>
          </Button>
        )}
        {/* Em 375 px o título desce para a segunda linha, inteiro, e o "Voltar" e as ações ficam juntos na primeira (como o cabeçalho da memória). */}
        <div className="min-w-0 flex-1 basis-56 max-md:order-last max-md:basis-full">
          {editing ? (
            <>
              <Title className="sr-only">{doc.title}</Title>
              <Input
                aria-label="Título do doc"
                aria-invalid={problem?.field === 'title' ? true : undefined}
                aria-describedby={problem?.field === 'title' ? 'doc-erro' : undefined}
                value={session.title}
                onChange={(event) => {
                  setProblem(null);
                  setSession(renameDraft(session, event.target.value));
                }}
                disabled={saving}
                autoComplete="off"
                // O botão Editar acabou de sumir: o foco vai ao primeiro campo da edição.
                autoFocus
                className="text-[18px]/[26px] font-semibold md:text-[18px]/[26px]"
              />
            </>
          ) : (
            <Title className="break-words text-[18px]/[26px] font-semibold text-fg">{doc.title}</Title>
          )}
        </div>
        <div className={cn('flex items-center gap-1 max-md:ml-auto', actions.group)}>
          {editing ? (
            <>
              <Button variant="secondary" size="sm" aria-pressed={session.mode === 'markdown'} disabled={saving} onClick={toggleMarkdown}>
                <Code className="size-4" strokeWidth={1.5} aria-hidden />
                Ver Markdown
              </Button>
              <Button variant="ghost" size="sm" disabled={saving} onClick={cancel}>
                Cancelar
              </Button>
              <Button variant="primary" size="sm" disabled={!dirty || saving || blocked} onClick={() => void save()}>
                {saving ? <LoaderCircle data-icon="LoaderCircle" className="size-4 animate-spin" strokeWidth={1.5} aria-hidden /> : null}
                Salvar
              </Button>
            </>
          ) : (
            <>
              <HeaderAction icon={History} label="Histórico" rules={actions} onClick={() => setHistoryOpen(true)} />
              <HeaderAction icon={Share2} label="Compartilhar" rules={actions} onClick={() => setSharingOpen(true)} />
              <HeaderAction icon={Download} label="Baixar .md" rules={actions} onClick={download} />
              <HeaderAction icon={Trash2} label="Excluir" rules={actions} onClick={() => setDeleteOpen(true)} />
              <Button
                variant="primary"
                size="sm"
                onClick={startEdit}
                ref={(node) => {
                  if (node && refocusEdit.current) {
                    refocusEdit.current = false;
                    node.focus();
                  }
                }}
              >
                <Pencil className="size-4" strokeWidth={1.5} aria-hidden />
                Editar
              </Button>
            </>
          )}
        </div>
      </header>

      <div
        className="min-h-0 flex-1 overflow-y-auto px-4 pb-16 md:px-6"
        // O texto longo rola dentro da área: ela precisa ser alcançável pelo teclado quando não há link nem campo dentro dela.
        {...(editing ? {} : { role: 'region', 'aria-label': 'Texto do doc', tabIndex: 0 })}
      >
        <p className="mb-4 text-xs text-subtle">
          Versão {doc.version} · alterado por {authorLabel(doc.updatedBy)} {formatRelativeTime(doc.updatedAt)} · {sizeLabel(doc.size)}
        </p>

        {notice ? (
          <NoticeBanner notice={notice} editing={editing} onCopy={() => void copyMyText()} onReload={() => reload(false)} />
        ) : null}

        {shownProblem ? (
          <p id="doc-erro" role="alert" className="mb-3 text-sm text-danger">
            {shownProblem.message}
          </p>
        ) : null}

        {editing ? (
          // Durante a gravação o campo não aceita digitação: o que fosse digitado agora se perderia ao voltar à leitura com o texto enviado.
          <div inert={saving} aria-busy={saving}>
            {session.mode === 'visual' ? (
              <>
                <div className="rounded-md border border-line-strong bg-surface p-4">
                  <DocEditor
                    key={session.fieldKey}
                    ref={editorRef}
                    markdown={session.text}
                    label="Texto do doc"
                    onDirtyChange={(isDirty) => setSession((current) => current && markEditorDirty(current, isDirty))}
                    onError={() => {
                      setSession((current) => current && fallBackToMarkdown(current));
                      setProblem({ field: 'save', message: 'O editor visual não abriu. Você continua no texto cru, sem perder nada.' });
                    }}
                  />
                </div>
                <p className="mt-2 text-xs text-subtle">Escreva em Markdown (# título, - lista, **negrito**) ou use Ver Markdown para ver e editar o texto cru.</p>
              </>
            ) : (
              <>
                <Textarea
                  aria-label="Texto do doc em Markdown"
                  aria-invalid={rawProblem ? true : undefined}
                  aria-describedby={rawProblem ? 'doc-contador doc-erro' : 'doc-contador'}
                  value={session.text}
                  onChange={(event) => {
                    setProblem(null);
                    setSession(typeMarkdown(session, event.target.value));
                  }}
                  spellCheck={false}
                  className="min-h-[50dvh] max-h-none font-mono text-[14px]/[22px] md:text-[14px]/[22px]"
                />
                <div className="mt-2 flex justify-end">
                  <Counter size={rawSize} />
                </div>
              </>
            )}
          </div>
        ) : doc.content.trim() === '' ? (
          <EmptyDoc onWrite={startEdit} />
        ) : (
          <article>
            <Markdown>{doc.content}</Markdown>
          </article>
        )}
      </div>

      <DocHistory
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        docId={doc.id}
        currentVersion={doc.version}
        onRestored={() => reload(true)}
        onConflict={() => setNotice('conflict')}
      />
      {sharingOpen ? (
        <DocSharing
          doc={doc}
          onClose={() => setSharingOpen(false)}
          onSaved={(summary) => setLoad((current) => (current.status === 'ready' ? { status: 'ready', doc: { ...current.doc, ...summary } } : current))}
        />
      ) : null}

      <Modal open={discard !== null} onOpenChange={(open) => !open && setDiscard(null)}>
        <ModalContent title="Descartar alterações?" description="O que você escreveu ainda não foi salvo.">
          <ModalActions>
            <Button variant="secondary" onClick={() => setDiscard(null)}>
              Continuar editando
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const target = discard;
                setDiscard(null);
                endEditing();
                if (target?.kind === 'leave') router.push(target.href);
              }}
            >
              Descartar alterações
            </Button>
          </ModalActions>
        </ModalContent>
      </Modal>

      <Modal open={deleteOpen} onOpenChange={(open) => !open && closeDelete()}>
        <ModalContent
          title="Excluir este doc?"
          description={`“${doc.title}” e todas as versões dele serão apagados, sem volta. Baixe o .md antes se quiser guardar uma cópia.`}
        >
          {deleteError ? (
            <p role="alert" className="mt-3 text-sm text-danger">
              {deleteError}
            </p>
          ) : null}
          <ModalActions>
            <Button variant="secondary" disabled={deleteBusy} onClick={closeDelete}>
              Cancelar
            </Button>
            <Button variant="danger" disabled={deleteBusy} onClick={() => void remove()}>
              {deleteBusy ? 'Excluindo…' : 'Excluir doc'}
            </Button>
          </ModalActions>
        </ModalContent>
      </Modal>
    </div>
  );
}

/** Doc sem texto: o convite a escrever (o bot também pode escrever nele pelas ferramentas). */
function EmptyDoc({ onWrite }: { onWrite: () => void }): ReactNode {
  return (
    <div className="flex flex-col items-start gap-3 py-10">
      <p className="text-sm text-muted">Este doc ainda está vazio.</p>
      <Button variant="secondary" size="sm" onClick={onWrite}>
        Escrever
      </Button>
    </div>
  );
}

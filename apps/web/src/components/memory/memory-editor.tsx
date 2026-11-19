'use client';

// Tela Memória (F11 passos 3 a 5; design: Tela Memória), uma só para a memória de um bot (/bots/[id]/memoria) e a global
// (/configuracoes/personalizacao, as "Regras globais", antes "Memória global"; na global o título da página é "Personalização" e o cartão "Como te chamar" entra acima do
// editor pelo `intro`, T10): cabeçalho (na do bot, com a Faísca parada dele de 32 px) com
// "Histórico" e "Salvar", editor de texto Markdown em fonte monoespaçada (sem
// pré-visualização: a memória é um bloco de notas), barra de status com o contador "3.214 / 8.000" e a última alteração, drawer de
// histórico e o modal de conflito.
//
// Salvar envia a VERSÃO ESPERADA (a que a tela carregou). Se a memória mudou nesse meio tempo (o bot também a edita), o servidor
// responde MEMORY_CONFLICT e o modal oferece "Copiar meu texto" e "Recarregar"; o texto digitado NUNCA é descartado sem o dono
// escolher recarregar. Acima de 8.000 caracteres o Salvar fica desabilitado e a mensagem aparece junto do contador (o servidor
// recusa do mesmo jeito, com MEMORY_TOO_LARGE). Com texto não salvo, o navegador avisa antes de fechar a aba.
import { MEMORY_MAX_CHARS, MEMORY_WARN_CHARS, countChars, type Bot, type MemoryAuthor, type MemoryView } from '@aion/shared';
import { ArrowLeft, Globe, History, LoaderCircle } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { readableNameColor } from '@/components/bots/bot-display';
import { BotAvatar } from '@/components/bots/bot-avatar';
import { BotLoadError, BotLoading, BotNotFound } from '@/components/bots/bot-states';
import { useBot } from '@/components/bots/use-bot';
import { BackLink } from '@/components/shell/back-link';
import { Button } from '@/components/ui/button';
import { Modal, ModalActions, ModalContent } from '@/components/ui/modal';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ApiError, apiErrorMessage } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { formatRelativeTime } from '@/lib/format';
import { useSession } from '@/lib/session-context';
import { fetchMemory, saveMemory, type MemoryScope } from './memory-api';
import { MemoryHistory } from './memory-history';

type Load = { status: 'loading' } | { status: 'ready'; memory: MemoryView } | { status: 'not-found' } | { status: 'error'; message: string };

/** Contador "3.214 / 8.000": normal, aviso acima de 7.200 e perigo acima do limite. */
function Counter({ size }: { size: number }) {
  const tone = size > MEMORY_MAX_CHARS ? 'text-danger' : size > MEMORY_WARN_CHARS ? 'text-warning' : 'text-subtle';
  return (
    <p id="memoria-contador" className={cn('shrink-0 text-xs tabular-nums', tone)}>
      {size.toLocaleString('pt-BR')} / {MEMORY_MAX_CHARS.toLocaleString('pt-BR')}
    </p>
  );
}

/** Modal de conflito (design): o texto digitado continua no editor; o dono copia e/ou recarrega a versão atual. */
function ConflictModal({ open, onOpenChange, text, onReload }: { open: boolean; onOpenChange: (open: boolean) => void; text: string; onReload: () => void }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      toast('Texto copiado');
    } catch {
      toast.error('Não foi possível copiar. Selecione o texto no editor e copie.', { duration: Infinity });
    }
  }
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent title="A memória mudou enquanto você editava" description="Recarregue para ver a versão atual. Seu texto continua no editor: copie-o antes de recarregar se quiser guardá-lo.">
        <ModalActions>
          <Button variant="secondary" onClick={() => void copy()}>
            Copiar meu texto
          </Button>
          <Button variant="primary" onClick={onReload}>
            Recarregar
          </Button>
        </ModalActions>
      </ModalContent>
    </Modal>
  );
}

interface MemoryScreenProps {
  scope: MemoryScope;
  /** O bot dono da memória (ausente na global): nome e cor do cabeçalho e o autor "bot" do histórico. */
  bot?: Bot;
  /** Conteúdo acima do editor, abaixo do cabeçalho (na global, o cartão "Como te chamar" de Personalização). Não participa de Salvar nem do texto não salvo. */
  intro?: ReactNode;
}

function MemoryScreen({ scope, bot, intro }: MemoryScreenProps) {
  const { csrfToken } = useSession();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** Incrementar recarrega a memória do servidor. */
  const [reloadKey, setReloadKey] = useState(0);
  const [relativeNow, setRelativeNow] = useState(() => new Date());

  useEffect(() => {
    let cancelled = false;
    fetchMemory(scope).then(
      (memory) => {
        if (cancelled) return;
        setText(memory.content);
        setLoad({ status: 'ready', memory });
      },
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.code === 'BOT_NOT_FOUND') setLoad({ status: 'not-found' });
        else setLoad({ status: 'error', message: apiErrorMessage(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [scope, reloadKey]);

  // "há 2 h" acompanha o tempo sem recarregar a tela.
  useEffect(() => {
    const timer = setInterval(() => setRelativeNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const saved = load.status === 'ready' ? load.memory : null;
  const dirty = saved !== null && text !== saved.content;

  // Texto não salvo: o navegador pergunta antes de fechar a aba ou recarregar.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const authorLabel = useCallback((author: MemoryAuthor) => (author === 'bot' ? (bot?.name ?? 'Bot') : 'Você'), [bot]);

  const reload = useCallback(() => {
    setConflict(false);
    setLoad({ status: 'loading' });
    setReloadKey((value) => value + 1);
  }, []);

  /**
   * Envia o texto da tela com a versão esperada. O texto enviado fica numa constante porque o dono pode seguir digitando enquanto a
   * requisição está em andamento: ao terminar, o texto da tela só é trocado pelo salvo se ainda for o que foi enviado. Se ele digitou
   * mais, o que está no editor permanece (e continua "não salvo", com o Salvar habilitado), em vez de ser sobrescrito em silêncio.
   */
  async function save() {
    if (saved === null || saving) return;
    const sent = text;
    setSaving(true);
    try {
      const view = await saveMemory(scope, sent, saved.version, csrfToken);
      setLoad({ status: 'ready', memory: view });
      setText((current) => (current === sent ? view.content : current));
      toast('Memória salva');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'MEMORY_CONFLICT') setConflict(true);
      else toast.error(apiErrorMessage(error), { duration: Infinity });
    } finally {
      setSaving(false);
    }
  }

  if (load.status === 'loading') return <BotLoading label="Carregando memória" />;
  if (load.status === 'not-found') return <BotNotFound />;
  if (load.status === 'error') return <BotLoadError message={load.message} onRetry={reload} />;

  const size = countChars(text);
  const over = size > MEMORY_MAX_CHARS;
  // O nome da região editável (o rótulo do campo de texto); na global a página se chama "Personalização" (área de Configurações) e o campo, "Regras globais".
  const title = bot ? `Memória de ${bot.name}` : 'Regras globais';
  const pageTitle = bot ? title : 'Personalização';
  const updatedBy = load.memory.updatedBy === null ? null : authorLabel(load.memory.updatedBy);

  return (
    <div className={cn('mx-auto flex w-full flex-col', bot ? 'h-full min-h-0 max-w-[760px]' : 'min-h-full max-w-[640px]')}>
      {/* Em 375 px o título desce para a segunda linha, inteiro (lado a lado o nome do bot ficava ilegível), e o "Voltar" e as ações ficam juntos na primeira: o toast do celular entra
          logo abaixo do cabeçalho de uma linha e cobriria os botões se eles ficassem na segunda (E25; o shell sem cabeçalho próprio, phase 5 T6, subiu esta linha 52 px). */}
      <header className="flex min-h-[52px] shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1 md:px-6">
        {bot ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button asChild variant="ghost" size="icon">
                <Link href={`/bots/${bot.id}`} aria-label="Voltar à conversa">
                  <ArrowLeft className="size-4" strokeWidth={1.5} aria-hidden />
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Voltar à conversa</TooltipContent>
          </Tooltip>
        ) : (
          // Personalização é uma área de Configurações: no celular o "Voltar" do pai fixo (o índice) abre o cabeçalho; a memória de um bot já tem o "Voltar à conversa" acima.
          <BackLink />
        )}
        <div className="flex min-w-0 flex-1 basis-56 items-center gap-3 max-md:order-last max-md:basis-full">
          {bot ? <BotAvatar owner={bot} size={32} still /> : <Globe className="size-5 shrink-0 text-muted" strokeWidth={1.5} aria-hidden />}
          <h1 style={bot ? { color: readableNameColor(bot.color) } : undefined} className="min-w-0 flex-1 truncate text-[18px]/[26px] font-semibold text-fg" title={pageTitle}>
            {pageTitle}
          </h1>
        </div>
        <div className="flex items-center justify-end gap-2 max-md:ml-auto">
          <Button variant="secondary" size="sm" onClick={() => setHistoryOpen(true)}>
            <History className="size-4" strokeWidth={1.5} aria-hidden />
            Histórico
          </Button>
          <Button variant="primary" size="sm" disabled={!dirty || over || saving} onClick={() => void save()}>
            {saving ? <LoaderCircle data-icon="LoaderCircle" className="size-4 animate-spin" strokeWidth={1.5} aria-hidden /> : null}
            Salvar
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 pb-6 md:px-6">
        {/* ponytail: o `intro` (cartão "Como te chamar") só aparece com as Regras globais já lidas, porque a tela devolve carregando e erro antes do corpo; se a leitura das regras falhar, o nome fica fora de alcance até o "Tentar novamente" dar certo. Levar o `intro` para esses estados se a falha da memória passar a ser frequente. */}
        {intro ? <div className="mb-2">{intro}</div> : null}
        {bot ? null : (
          <p className="text-sm text-muted">
            Regras que todos os bots e o Chat geral leem em toda execução, antes das regras de cada bot. Só você edita; cada salvamento vira uma versão restaurável.
          </p>
        )}
        <Textarea
          aria-label={title}
          aria-invalid={over ? true : undefined}
          aria-describedby={over ? 'memoria-contador memoria-erro' : 'memoria-contador'}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={bot ? 'Anotações que o bot deve lembrar' : 'Anotações que todos os bots devem lembrar'}
          spellCheck={false}
          className="min-h-[55dvh] max-h-none flex-1 font-mono text-[14px]/[22px] md:text-[14px]/[22px]"
        />
        <div className="flex items-start justify-between gap-3">
          <p className="min-w-0 text-xs text-subtle">
            {over ? (
              <span id="memoria-erro" role="alert" className="text-danger">
                A memória passou de {MEMORY_MAX_CHARS.toLocaleString('pt-BR')} caracteres. Reduza o texto para salvar.
              </span>
            ) : load.memory.updatedAt && updatedBy ? (
              <span>
                Última alteração por {updatedBy} {formatRelativeTime(load.memory.updatedAt, relativeNow)}
              </span>
            ) : (
              <span>Ainda sem alterações.</span>
            )}
          </p>
          <Counter size={size} />
        </div>
      </div>

      <MemoryHistory
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        scope={scope}
        currentVersion={load.memory.version}
        dirty={dirty}
        authorLabel={authorLabel}
        onRestored={(view) => {
          setLoad({ status: 'ready', memory: view });
          setText(view.content);
        }}
        onConflict={() => setConflict(true)}
      />
      <ConflictModal open={conflict} onOpenChange={setConflict} text={text} onReload={reload} />
    </div>
  );
}

/** /bots/[id]/memoria: carrega o bot (nome e cor do cabeçalho) e entrega a tela da memória dele. */
export function BotMemory({ botId }: { botId: string }) {
  const { load, retry } = useBot(botId);
  const scope = useMemo<MemoryScope>(() => ({ kind: 'bot', botId }), [botId]);
  if (load.status === 'loading') return <BotLoading label="Carregando memória" />;
  if (load.status === 'not-found') return <BotNotFound />;
  if (load.status === 'error') return <BotLoadError message={load.message} onRetry={retry} />;
  return <MemoryScreen scope={scope} bot={load.bot} />;
}

const GLOBAL_SCOPE: MemoryScope = { kind: 'global' };

/**
 * /configuracoes/personalizacao: as Regras globais (a antiga memória global), lidas por todos os bots e pelo Chat geral, editadas só pelo dono. `intro` é o que a página põe
 * acima do editor (o cartão "Como te chamar"); como a tela ganha altura além do campo de texto, a global rola como página (`min-h-full`) em vez de prender a altura do shell.
 */
export function GlobalMemory({ intro }: { intro?: ReactNode }) {
  return <MemoryScreen scope={GLOBAL_SCOPE} intro={intro} />;
}

'use client';

// Painel do artefato ao lado da conversa (phase 14, passo 7; UI-04, A5, A6 e A7): onde o doc ou a tabela abre quando o dono clica no cartão da resposta (`artifact-card.tsx`), com a
// conversa continuando à vista e utilizável. É a moldura; o artefato em si é a mesma tela da página própria (`DocView` e `TableEditor`, ambos com a variante `embedded`), então ler,
// editar, salvar, conflito, histórico e compartilhamento são os de sempre, sem lógica duplicada.
//
// LAYOUT (container query nomeada `conversation`, posta por `ConversationView` na raiz da conversa): a decisão ao lado x tela cheia é pela largura DA CONVERSA e não pela da janela,
// porque o painel de seções do shell (264 a 360 px) e a barra de ícones comem largura que o viewport não mostra.
//   - Conversa estreita (menos de 56 rem, e todo o celular): o painel cobre a conversa inteira (tela cheia na área do conteúdo, sem a barra inferior, que a conversa não tem) e o
//     controle é o "Voltar" para a conversa. A conversa fica escondida por baixo (`ConversationView` a deixa `invisible`: sai da ordem de foco e da árvore de acessibilidade sem
//     perder a posição da rolagem).
//   - Conversa larga (56 rem ou mais): o painel é a coluna da direita, com 44 % da largura (entre 26 e 44 rem), e o controle é "Fechar painel". Cada um dos dois controles existe
//     só na sua largura (o outro é `display: none`), então o leitor de tela ouve um só.
// Sem suporte a container query o padrão é a tela cheia, que serve em qualquer largura.
//
// O artefato aberto vive na URL da conversa (`?artefato=<tipo>:<id>`, ver `artifact-card.tsx`): Voltar do navegador fecha o painel e o link abre direto. Fechar é `router.replace` para a
// conversa sem o parâmetro (`useArtifactPanel`, no fim do arquivo, que também monta o endereço dos cartões e o painel para a conversa).
//
// TEXTO NÃO SALVO: o doc em edição e a célula da tabela em edição avisam o painel (`onDirtyChange`). Com alteração, fechar, "Abrir em tela inteira" e abrir outro cartão perguntam
// antes de descartar (`useDiscardGuard`, o mesmo texto da confirmação das telas). ponytail: o Voltar do navegador e os links de fora do painel (menu, barra de ícones) trocam de tela sem
// perguntar e descartam o rascunho, como já acontece na página própria do doc; guardar a navegação do app inteira se isso doer no uso.
//
// CARGA: o doc e a tabela trazem o editor visual (Milkdown) e a grade, pesados e usados só aqui, então carregam sob demanda (`next/dynamic`) e não pesam na conversa de quem não abre
// artefato.
import { ArrowLeft, Maximize2, X } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { BotLoading } from '@/components/bots/bot-states';
import { Button } from '@/components/ui/button';
import { Modal, ModalActions, ModalContent } from '@/components/ui/modal';
import { ARTIFACT_PARAM, artifactKey, artifactPageHref, KIND_LABEL, parseArtifactKey, type ArtifactLinks, type ArtifactTarget } from './artifact-card';

const DocView = dynamic(() => import('@/components/docs/doc-view').then((module) => module.DocView), { loading: () => <BotLoading label="Carregando doc" /> });
const TableEditor = dynamic(() => import('@/components/tables/table-editor').then((module) => module.TableEditor), { loading: () => <BotLoading label="Carregando tabela" /> });

/**
 * O que o painel dá ao artefato embutido (`DocView` e `TableEditor`, prop `embedded`): avisar que há texto não salvo e que o artefato foi excluído por ele. A presença desta prop é
 * também o que tira da tela o "Voltar" de página (o controle é o do painel) e rebaixa o título para `h2` (a conversa já tem o `h1`).
 */
export interface EmbeddedArtifact {
  /** Há (ou deixou de haver) alteração não salva no artefato: o painel pergunta antes de fechar ou sair. */
  onDirtyChange: (dirty: boolean) => void;
  /** O artefato foi excluído por esta tela: o painel fecha, sem perguntar, porque não há mais o que salvar. */
  onDeleted: () => void;
}

/**
 * Guarda de descarte do painel, compartilhada com a conversa (que abre outro cartão): `dirty` é o estado avisado pelo artefato e `ask(action)` pede a confirmação antes de rodar
 * `action`. `dialog` é o popup, que quem usa o hook desenha uma vez. Só pergunta quem chama `ask`: o chamador confere `dirty` antes.
 */
export function useDiscardGuard() {
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const ask = useCallback((action: () => void) => setPending(() => action), []);
  const dialog = (
    <Modal open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
      <ModalContent title="Descartar alterações?" description="O que você alterou ainda não foi salvo.">
        <ModalActions>
          <Button variant="secondary" onClick={() => setPending(null)}>
            Continuar editando
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              const action = pending;
              setPending(null);
              action?.();
            }}
          >
            Descartar alterações
          </Button>
        </ModalActions>
      </ModalContent>
    </Modal>
  );
  return { dirty, setDirty, ask, dialog };
}
export type DiscardGuard = ReturnType<typeof useDiscardGuard>;

/** Nome acessível da região do painel de cada tipo. */
const PANEL_LABEL: Record<ArtifactTarget['type'], string> = { table: 'Painel da tabela', doc: 'Painel do doc' };

/**
 * O painel do artefato `target`. `useArtifactPanel` o monta com `key` do artefato (outro artefato é outro painel, com estado novo), passa a guarda de descarte e o `onClose`, que tira
 * o `?artefato=` da URL.
 */
export function ArtifactPanel({ target, guard, onClose }: { target: ArtifactTarget; guard: DiscardGuard; onClose: () => void }): ReactNode {
  const router = useRouter();
  const panel = useRef<HTMLElement>(null);
  const { dirty, setDirty, ask } = guard;
  const fullHref = artifactPageHref(target);
  const embedded: EmbeddedArtifact = { onDirtyChange: setDirty, onDeleted: onClose };

  // O foco vai para o painel ao abrir (quem navega por teclado ou leitor de tela cai nele) e volta ao que o abriu, o cartão, ao fechar.
  useEffect(() => {
    const opener = document.activeElement;
    panel.current?.focus({ preventScroll: true });
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  function close() {
    if (dirty) ask(onClose);
    else onClose();
  }

  return (
    <aside
      ref={panel}
      aria-label={PANEL_LABEL[target.type]}
      tabIndex={-1}
      className="absolute inset-0 z-20 flex min-h-0 min-w-0 flex-col bg-panel grad-panel outline-none @4xl/conversation:static @4xl/conversation:inset-auto @4xl/conversation:z-auto @4xl/conversation:w-[44%] @4xl/conversation:max-w-[44rem] @4xl/conversation:min-w-[26rem] @4xl/conversation:shrink-0 @4xl/conversation:border-l @4xl/conversation:border-line"
    >
      <header className="flex h-[52px] shrink-0 items-center gap-1 border-b border-line px-3">
        <Button variant="ghost" size="icon" aria-label="Voltar" className="-ml-2 @4xl/conversation:hidden" onClick={close}>
          <ArrowLeft className="size-[18px]" strokeWidth={1.5} aria-hidden />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Fechar painel" className="-ml-2 hidden @4xl/conversation:inline-flex" onClick={close}>
          <X className="size-[18px]" strokeWidth={1.5} aria-hidden />
        </Button>
        <p className="min-w-0 flex-1 truncate px-1 text-sm font-medium text-muted">{KIND_LABEL[target.type]}</p>
        <Button asChild variant="ghost" size="sm">
          <Link
            href={fullHref}
            prefetch={false}
            onClick={(event) => {
              // A navegação do app não dispara `beforeunload`: com alteração não salva, a saída pede confirmação.
              if (dirty) {
                event.preventDefault();
                ask(() => router.push(fullHref));
              }
            }}
          >
            <Maximize2 className="size-4" strokeWidth={1.5} aria-hidden />
            Abrir em tela inteira
          </Link>
        </Button>
      </header>
      {/* O corpo é a container query `panel`: o editor de tabela decide grade x lista pela largura DO PAINEL (a grade usa breakpoints de viewport fora daqui). */}
      <div className="@container/panel min-h-0 flex-1 overflow-y-auto">
        {target.type === 'doc' ? <DocView docId={target.id} embedded={embedded} /> : <TableEditor tableId={target.id} parentHref="/artefatos" embedded={embedded} />}
      </div>
    </aside>
  );
}

/**
 * Tudo o que a conversa precisa do painel, num lugar só (e testável sem montar a conversa): lê o `?artefato=` da URL (única fonte de "o que está aberto"; valor fora do formato exato é
 * ignorado e o painel não abre), monta o endereço dos cartões e o que fazer ao clicar neles, e o `element` com o painel e o popup de descarte, que a conversa desenha ao lado da coluna.
 * `open` é o artefato aberto (a conversa esconde a própria coluna quando o painel é de tela cheia). Fechar é `router.replace` para a conversa sem o parâmetro: o painel aberto por clique
 * é um `push`, então o "Voltar" do navegador já o fecha, e fechar pelo botão não empilha outra volta.
 */
export function useArtifactPanel(): { open: ArtifactTarget | null; links: ArtifactLinks; element: ReactNode } {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const guard = useDiscardGuard();
  const open = parseArtifactKey(searchParams.get(ARTIFACT_PARAM));
  const openKey = open ? artifactKey(open) : null;
  const hrefOf = (ref: ArtifactTarget) => `${pathname}?${ARTIFACT_PARAM}=${artifactKey(ref)}`;
  const close = () => router.replace(pathname, { scroll: false });
  const links: ArtifactLinks = {
    hrefOf,
    openKey,
    // Abrir OUTRO artefato com texto não salvo no painel pergunta antes: trocar de painel descartaria o rascunho. O mesmo artefato não troca nada.
    onOpen: (event, ref) => {
      if (!guard.dirty || artifactKey(ref) === openKey) return;
      event.preventDefault();
      guard.ask(() => router.push(hrefOf(ref), { scroll: false }));
    },
  };
  const element = (
    <>
      {open ? <ArtifactPanel key={openKey} target={open} guard={guard} onClose={close} /> : null}
      {guard.dialog}
    </>
  );
  return { open, links, element };
}

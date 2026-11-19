'use client';

// Exclusão definitiva de um bot arquivado (F6, DATA-01; design: "Popup de exclusão do bot"). Este componente é a ação inteira: o botão
// "Excluir definitivamente" da zona de arquivamento do editor (perigo, ao lado de "Desarquivar") e o popup de confirmação que ele abre.
// Fica fora de `bot-editor.tsx` porque tem estado e regras próprios (texto digitado, erro, "excluindo") e o editor já é grande.
//
// Por que não o `ConfirmDialog` do kit: ele só confirma por clique; aqui o botão final fica desabilitado até o dono digitar o nome do bot
// exatamente, e o popup mostra o erro do servidor sem perder o texto digitado. A casca é o `Modal` do kit (foco preso, Esc e clique fora
// fecham, foco devolvido a quem abriu), a mesma dos outros popups com campo.
//
// Fluxo: digitar o nome (igualdade exata, sem aviso enquanto digita) -> "Excluir definitivamente" -> `DELETE /api/bots/:id` com o nome
// -> sucesso: fecha, toast "Bot excluído" e vai para a lista de bots; falha: a mensagem aparece acima das ações (role="alert") e o texto
// digitado fica. Durante a chamada nada fecha o popup (Esc, clique fora e "Cancelar" são ignorados), porque fechar no meio deixaria o
// dono sem saber se o bot foi apagado.
//
// Sem `<form>` de propósito: este componente é renderizado DENTRO do `<form>` do editor, e o React propaga eventos de portal pela
// árvore de componentes, então um `submit` daqui salvaria o bot por engano. Enter no campo não confirma: apagar exige o clique.
//
// O título leva, à esquerda, a Faísca do bot DORMINDO (48 px, o nível completo, parada e decorativa): dá peso a uma ação irreversível sem nenhuma
// animação. O nome do bot e o aviso seguem em texto, então a Faísca não carrega informação.
import { LoaderCircle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Modal, ModalActions, ModalContent } from '@/components/ui/modal';
import { ApiError } from '@/lib/api-client';
import { useSession } from '@/lib/session-context';
import { BotAvatar } from './bot-avatar';
import { deleteBot } from './bots-api';

/** O que o servidor apaga, na ordem do design (tudo o que pertence ao bot; Regras Globais, credenciais e outros bots ficam). */
const ERASED = [
  'A conversa e todas as mensagens',
  'As execuções e as aprovações',
  'A memória e o histórico de versões',
  'As rotinas e o histórico delas',
  'As regras de aprovação deste bot',
] as const;

/** Mensagem para qualquer falha sem texto próprio (inclui rede e prazo): a exclusão é uma transação, então nada ficou pela metade. */
const DELETE_FAILED = 'Não foi possível excluir o bot. Nada foi apagado.';

/**
 * Texto do popup para cada falha da exclusão. As recusas conhecidas já chegam do servidor com a frase segura do registro de erros
 * (bot não arquivado, execução em aberto, limite de taxa), então a tela só as repete; o nome que não confere vem como falha de
 * validação do campo `confirmName` e o motivo está em `fields` (o `message` do envelope é só "Dados inválidos."). O resto cai no texto genérico.
 *
 * ponytail: `BOT_NOT_FOUND` também cai no texto genérico (o design não tem frase própria), então se a resposta de uma exclusão se perder e o
 * dono tentar de novo, ele lê "Nada foi apagado" com o bot já apagado; tratar o 404 como sucesso se isso for relatado.
 */
function deleteErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return DELETE_FAILED;
  switch (error.code) {
    case 'BOT_NOT_ARCHIVED':
    case 'BOT_HAS_OPEN_RUN':
    case 'RATE_LIMITED':
      return error.message;
    case 'VALIDATION_FAILED':
      return error.fields?.find((field) => field.field === 'confirmName')?.reason ?? DELETE_FAILED;
    default:
      return DELETE_FAILED;
  }
}

interface DeleteBotDialogProps {
  botId: string;
  /** Nome GRAVADO do bot (não o que está sendo editado no formulário): é ele que o dono precisa digitar. */
  botName: string;
  /** Cor GRAVADA do bot, para a Faísca dormindo do título (não a do formulário em edição). */
  color: string;
}

/** Botão "Excluir definitivamente" e o popup de confirmação por nome digitado. Ao excluir, leva o dono à lista de bots (`/bots`). */
export function DeleteBotDialog({ botId, botName, color }: DeleteBotDialogProps) {
  const router = useRouter();
  const { csrfToken } = useSession();
  const ids = useId();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Comparação exata (maiúsculas, acentos e espaços contam): o servidor repete a conferência, mas só depois de o dono ter escolhido apagar.
  const matches = typed === botName;

  /** Esc, clique fora e "Cancelar" passam por aqui. Fechar zera o texto e o erro: a próxima abertura começa limpa. */
  function changeOpen(next: boolean) {
    if (busy) return;
    setOpen(next);
    if (!next) {
      setTyped('');
      setError(null);
    }
  }

  async function confirm() {
    if (busy || !matches) return;
    setBusy(true);
    setError(null);
    try {
      await deleteBot(botId, typed, csrfToken);
    } catch (caught) {
      setError(deleteErrorMessage(caught));
      setBusy(false);
      // Quem usa só o teclado volta ao campo (o botão que tinha o foco ficou desabilitado durante a chamada).
      input.current?.focus();
      return;
    }
    // Sucesso: `busy` fica ligado até a navegação desmontar o editor, para o botão não poder ser acionado de novo.
    setOpen(false);
    toast('Bot excluído');
    router.push('/bots');
  }

  return (
    <>
      <Button variant="danger" className="border border-danger/40" onClick={() => setOpen(true)} disabled={busy}>
        Excluir definitivamente
      </Button>
      <Modal open={open} onOpenChange={changeOpen}>
        <ModalContent
          title={`Excluir ${botName} definitivamente?`}
          leading={<BotAvatar owner={{ name: botName, color }} size={48} state="sleep" still />}
          // Foco inicial no campo pelo gancho do Radix, não por `autoFocus` (ver o comentário de `modal.tsx`: o foco precisa voltar ao botão que abriu).
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            input.current?.focus();
          }}
          // Nomes longos e sem espaço quebram em qualquer ponto em vez de criar rolagem horizontal; a entrada usa o `scale(0.97)` do design.
          className="[overflow-wrap:anywhere] data-[state=open]:animate-[tooltip-in_200ms_var(--ease-out)]"
        >
          <ul id={`${ids}-lista`} aria-label="O que será apagado" className="mt-3 list-disc space-y-1 pl-5 text-sm text-fg">
            {ERASED.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p id={`${ids}-aviso`} className="mt-3 text-xs text-danger">
            Não há como desfazer. O registro de auditoria permanece, sem o nome do bot.
          </p>
          <p className="mt-3 text-sm text-muted">As tabelas serão mantidas, e os docs também. Continuarão disponíveis em Artefatos.</p>

          <div className="mt-5">
            <Label htmlFor={`${ids}-nome`}>
              Digite o nome do bot para confirmar{' '}
              <span className="font-mono text-[13px]/5 font-normal whitespace-pre-wrap">{botName}</span>
            </Label>
            <Input
              ref={input}
              id={`${ids}-nome`}
              name="confirmar-nome"
              value={typed}
              onChange={(event) => {
                setTyped(event.target.value);
                setError(null); // o dono já está corrigindo: o erro da tentativa anterior sai
              }}
              readOnly={busy}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-describedby={`${ids}-lista ${ids}-aviso`}
            />
          </div>

          {error ? (
            <p role="alert" className="mt-3 text-sm text-danger">
              {error}
            </p>
          ) : null}

          <ModalActions className="max-md:flex-col">
            <Button variant="secondary" onClick={() => changeOpen(false)} disabled={busy}>
              Cancelar
            </Button>
            <Button variant="danger" className="border border-danger/40" onClick={() => void confirm()} disabled={!matches || busy}>
              {busy ? <LoaderCircle data-icon="LoaderCircle" className="size-4 animate-spin" strokeWidth={1.5} aria-hidden /> : null}
              {busy ? 'Excluindo…' : 'Excluir definitivamente'}
            </Button>
          </ModalActions>
        </ModalContent>
      </Modal>
    </>
  );
}

'use client';

// Barra de ações sob uma mensagem da conversa (phase 4, design "Barra de ações da mensagem"; F1 a F4, F6 e F7). Vale para a conversa do bot e
// para a sessão do Chat geral, abaixo da bolha do dono (alinhada à direita) e da última bolha de texto de cada resposta do assistente (à esquerda,
// na coluna de conteúdo).
//
// Ordem do design: seletor de versão "‹ k/n ›" (só com mais de uma versão), Copiar (o texto exato: a mensagem do dono como digitada, a resposta em
// Markdown bruto), Editar (mensagem do dono) ou o menu "Mais ações" (resposta: "Gerar outra resposta" e, se há rodadas depois dela, "Retroceder
// até aqui") e, no fim da linha, o nome do modelo da resposta (`modelFullName`). O bot é linear (CONV-02) e só recebe Copiar e o modelo: quem desenha a barra só passa
// `versions`, `onEdit` e `more` na sessão do Chat geral. Uma resposta sem texto (uma falha, por exemplo) leva a barra sem Copiar, só para o seletor
// e o menu continuarem ao alcance.
//
// Bloqueio (`blocked`, execução aberta ou complemento pendente; spec Suposição 8): seletor, Editar e os itens do menu ficam `aria-disabled` e
// continuam focáveis, com a dica "Pare a execução para editar." no tooltip, e o toque mostra o toast informativo com a mesma frase. Copiar nunca é
// bloqueado. As pontas do seletor (primeira e última versão) ficam `disabled` de verdade, como no design.
//
// Revelação: no desktop (regra em globals.css, `.message-actions`) ela aparece por opacidade ao passar o mouse ou com foco dentro da mensagem
// (`.message-group`), e `pinned` (a da última resposta) a mantém sempre visível; o espaço é reservado, então revelar não mexe no layout. No celular
// (phase 18, A16) a da mensagem do dono fica sempre visível e a da resposta só aparece se for a última (`pinned`) ou depois de o dono tocar nela (`open`,
// controlado por `thread.tsx`); a das outras respostas some sem reservar espaço.
import { ERROR_CODES } from '@aion/shared';
import { Check, ChevronLeft, ChevronRight, Copy, MoreHorizontal, Pencil, RefreshCw, Undo2 } from 'lucide-react';
import { useRef, type Ref } from 'react';
import { toast } from 'sonner';
import { modelFullName } from '@/components/models/model-label';
import { useModelEntry } from '@/components/models/use-models';
import { Button } from '@/components/ui/button';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';
import { useCopy } from './use-copy';

/** A dica e o toast dos controles bloqueados: a mesma frase do erro CONVERSATION_BUSY do servidor. */
export const BLOCKED_HINT = ERROR_CODES.CONVERSATION_BUSY.message;

/** Seletor de versão de uma mensagem ou resposta: posição (1..total), total e a troca para a vizinha. */
export interface VersionSelector {
  position: number;
  total: number;
  /** Troca para a versão anterior (-1) ou seguinte (+1). */
  onStep: (direction: -1 | 1) => void;
  /** Identifica o seletor entre as versões (a primeira versão do grupo): a tela devolve o foco a ele depois da troca. */
  group: string;
}

export interface MessageActionsProps {
  /** Texto que Copiar leva, exatamente como gravado (sem passar pelo DOM); ausente numa resposta sem texto (só seletor e menu). */
  text?: string;
  /** Lado da bolha: `end` para a mensagem do dono, `start` para a resposta do assistente. */
  align: 'start' | 'end';
  /** Id do modelo da resposta (a barra mostra o nome dele); nulo ou ausente não mostra nada (mensagem do dono ou resposta antiga). */
  model?: string | null;
  /** Sempre visível também no desktop (a barra da última resposta do assistente). */
  pinned?: boolean;
  /** Barra da resposta aberta por toque (celular): só a última resposta a mostra por padrão, e a dona do toque aparece (phase 18, A16). */
  open?: boolean;
  /** Seletor "‹ k/n ›" (Chat geral, com mais de uma versão). */
  versions?: VersionSelector | null;
  /** Editar a mensagem do dono (Chat geral). */
  onEdit?: () => void;
  /** Recebe o botão Editar, para a edição devolver o foco a ele ao fechar. */
  editRef?: Ref<HTMLButtonElement>;
  /** Menu "Mais ações" da resposta (Chat geral): gerar outra resposta e, quando há rodadas depois, retroceder até aqui. */
  more?: { onRegenerate: () => void; onRewind: (() => void) | null } | null;
  /** Execução aberta ou complemento pendente: os controles de versão ficam desabilitados com a dica. */
  blocked?: boolean;
}

/** Um botão só de ícone com nome acessível e tooltip; bloqueado, continua focável, mostra a dica e responde com o toast. */
function IconAction({ label, blocked, onClick, children, disabled, buttonRef, step }: { label: string; blocked: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean; buttonRef?: Ref<HTMLButtonElement>; step?: 'prev' | 'next' }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={buttonRef}
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-disabled={blocked || undefined}
          disabled={disabled}
          data-version-step={step}
          className={blocked ? 'opacity-50' : undefined}
          onClick={() => (blocked ? toast(BLOCKED_HINT) : onClick())}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{blocked ? BLOCKED_HINT : label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Menu "Mais ações" da resposta. A ação escolhida só roda quando o menu termina de fechar (`onCloseAutoFocus`, depois de o foco voltar ao
 * gatilho): assim o popup "Retroceder" registra o gatilho como quem o abriu e devolve o foco a ele ao fechar.
 */
function MoreActions({ more, blocked }: { more: NonNullable<MessageActionsProps['more']>; blocked: boolean }) {
  /** Ação escolhida no menu, executada no fechamento; bloqueado, o item só mostra o toast na hora. */
  const pending = useRef<(() => void) | null>(null);
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger asChild>
          <MenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Mais ações">
              <MoreHorizontal className="size-4" strokeWidth={1.5} aria-hidden />
            </Button>
          </MenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Mais ações</TooltipContent>
      </Tooltip>
      <MenuContent
        align="start"
        onCloseAutoFocus={() => {
          const action = pending.current;
          pending.current = null;
          action?.();
        }}
      >
        <MenuItem aria-disabled={blocked || undefined} title={blocked ? BLOCKED_HINT : undefined} className={cn(blocked && 'opacity-50')} onSelect={() => {
            if (blocked) toast(BLOCKED_HINT);
            else pending.current = more.onRegenerate;
          }}>
          <RefreshCw className="size-4" strokeWidth={1.5} aria-hidden />
          Gerar outra resposta
        </MenuItem>
        {more.onRewind ? (
          <MenuItem aria-disabled={blocked || undefined} title={blocked ? BLOCKED_HINT : undefined} className={cn(blocked && 'opacity-50')} onSelect={() => {
            if (blocked) toast(BLOCKED_HINT);
            else pending.current = more.onRewind;
          }}>
            <Undo2 className="size-4" strokeWidth={1.5} aria-hidden />
            Retroceder até aqui
          </MenuItem>
        ) : null}
      </MenuContent>
    </Menu>
  );
}

/**
 * O modelo da resposta no fim da barra: o nome completo `provedor/nome` (A28 da phase 17, `modelFullName`), com o `display_name` do provedor lido dos perfis persistidos (`useModelEntry`, sem consultar
 * o provedor). Até a entrada chegar, ou sem perfil, mostra o id local depois do prefixo, que é o próprio id gravado nos modelos do OpenCode Go.
 */
function ModelName({ model }: { model: string }) {
  const name = modelFullName(model, useModelEntry(model));
  return (
    <span title={name} className="min-w-0 max-w-[180px] truncate font-mono text-xs text-subtle">
      {name}
    </span>
  );
}

/** A linha de ações: seletor, Copiar, Editar ou o menu, e o modelo truncado, que encolhe até sumir antes dos botões. */
export function MessageActions({ text, align, model = null, pinned = false, open = false, versions = null, onEdit, editRef, more = null, blocked = false }: MessageActionsProps) {
  const { copied, copy } = useCopy();
  const label = copied ? 'Copiado' : 'Copiar';
  return (
    <div
      data-message-actions=""
      data-pinned={pinned ? '' : undefined}
      // Celular (`pointer-coarse`): a barra de uma resposta que não é a última some (`hidden`, sem reservar espaço) até o dono tocar nela; a da mensagem do dono (`end`) fica, porque leva Editar e as versões.
      // ponytail: no celular o leitor de tela só alcança a barra de uma resposta antiga depois de ativar a resposta, trocar por um botão "Ações" se isso pesar.
      className={cn('message-actions mt-1 flex min-w-0 items-center gap-1', align === 'end' ? 'justify-end' : 'justify-start', align === 'start' && !pinned && !open && 'pointer-coarse:hidden')}
    >
      {versions && versions.total > 1 ? (
        <div role="group" aria-label={`Versão ${versions.position} de ${versions.total}`} data-version-group={versions.group} className="flex shrink-0 items-center">
          <IconAction label="Versão anterior" step="prev" blocked={blocked} disabled={versions.position <= 1} onClick={() => versions.onStep(-1)}>
            <ChevronLeft className="size-4" strokeWidth={1.5} aria-hidden />
          </IconAction>
          <span aria-hidden className="text-xs tabular-nums text-muted">
            {versions.position}/{versions.total}
          </span>
          <IconAction label="Próxima versão" step="next" blocked={blocked} disabled={versions.position >= versions.total} onClick={() => versions.onStep(1)}>
            <ChevronRight className="size-4" strokeWidth={1.5} aria-hidden />
          </IconAction>
        </div>
      ) : null}
      {text !== undefined ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={label} onClick={() => void copy(text)}>
              {copied ? <Check className="size-4" strokeWidth={1.5} aria-hidden /> : <Copy className="size-4" strokeWidth={1.5} aria-hidden />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      ) : null}
      {onEdit ? (
        <IconAction label="Editar" blocked={blocked} onClick={onEdit} buttonRef={editRef}>
          <Pencil className="size-4" strokeWidth={1.5} aria-hidden />
        </IconAction>
      ) : null}
      {more ? <MoreActions more={more} blocked={blocked} /> : null}
      {model ? <ModelName model={model} /> : null}
      <span role="status" className="sr-only">
        {copied ? 'Mensagem copiada' : ''}
      </span>
    </div>
  );
}

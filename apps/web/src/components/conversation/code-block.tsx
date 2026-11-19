'use client';

// Cartão de um bloco cercado (```) na resposta do bot (phase 3, F8; A14 e A15). Renderizado pelo `Markdown` no lugar do `<pre>`.
//
// Dois tipos, pela linguagem da cerca (Suposição 26 da spec):
// - `text`: conteúdo para copiar (um e-mail, um texto pronto). Fonte do corpo da conversa, quebra visual sempre, nunca rola na horizontal.
// - qualquer outra linguagem, ou nenhuma: código. Mono, indentação preservada, rola por dentro (e por isso recebe foco de teclado) e tem
//   "Quebrar linhas", ligado só por bloco e só enquanto o cartão existe (não persiste).
// Todo bloco tem Copiar, que leva o `content` recebido: o texto original da cerca, já sem a quebra final (ver markdown.tsx). A cópia nunca
// lê o DOM, então a quebra visual nunca entra nela (Suposição 27). A lógica de copiar (área de transferência, "Copiado" por 2 s e toast na
// falha) é a fonte única `useCopy`, a mesma da barra de ações da mensagem (phase 4, F6).
//
// Modo compacto (só ícone, com `aria-label` e tooltip iguais ao texto) decidido pelo que CABE no cabeçalho do próprio cartão, não pela janela:
// os botões com texto mais um mínimo de rótulo (`MIN_LABEL_PX`) precisam caber; até lá o rótulo trunca primeiro. Decisão do dono no R1 da review
// da phase 3: em 375 px os textos ficam (o design manda, "Copiar" e "Quebrar linhas" são ambíguos sem rótulo); hoje o corte cai perto de 280 px
// de cartão de código (a resposta do bot ocupa a coluna inteira desde a phase 18), então só ele, em telas de cerca de 320 px, fica com ícone (o `text`, com um botão só, ainda cabe).
// Um limite fixo de largura erraria quando a fonte ou o texto do botão mudam.
// O cartão não usa `overflow: hidden`: quem rola é só o corpo do código, e o recorte cortaria o anel de foco dos botões do cabeçalho.
import { Check, Copy, WrapText } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';
import { useCopy } from './use-copy';

/**
 * Largura mínima que o rótulo (linguagem ou "Texto") mantém com os botões em texto; abaixo disso os botões viram só ícone. São 64 px desde a phase 18: a resposta do bot perdeu a
 * coluna de 24 px da Faísca e o espaço de 8 px dela (32 px), então o cartão ficou 32 px mais largo na mesma tela, e o mesmo corte (a decisão do R1 da phase 3: 375 px com texto,
 * cerca de 320 px só ícone) passou a cair 32 px acima no cartão.
 *
 * ponytail: o 64 é empírico (medido no E2E de 375 e 320 px, não derivado de uma métrica), rever quando a coluna da resposta, o cabeçalho do bloco ou os rótulos dos botões mudarem de largura.
 */
const MIN_LABEL_PX = 64;

export interface CodeBlockProps {
  /** Identificador da cerca como veio (ex.: `ts`, `text`), ou `null` sem identificador. */
  language: string | null;
  /** Conteúdo exato do bloco, sem a quebra final que a cerca acrescenta. */
  content: string;
}

/** Cartão do bloco: cabeçalho (rótulo à esquerda, ações à direita) e corpo de texto ou de código. */
export function CodeBlock({ language, content }: CodeBlockProps) {
  const isText = language === 'text';
  const [wrapped, setWrapped] = useState(false);
  const { copied, copy } = useCopy();
  const { headerRef, actionsRef, compact } = useCompactHeader(MIN_LABEL_PX);

  return (
    <div data-code-block={isText ? 'text' : 'code'} className="min-w-0 max-w-full rounded-md border border-line bg-surface grad-sheen">
      <div ref={headerRef} className="flex min-h-8 items-center gap-2 border-b border-line pl-3 pr-1">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">{isText ? 'Texto' : (language ?? 'Código')}</span>
        <div ref={actionsRef} className="flex shrink-0 items-center">
          {isText ? null : (
            <BlockAction
              compact={compact}
              label="Quebrar linhas"
              icon={<WrapText className="size-3.5" strokeWidth={1.5} aria-hidden />}
              aria-pressed={wrapped}
              onClick={() => setWrapped((value) => !value)}
            />
          )}
          <BlockAction
            compact={compact}
            label={copied ? 'Copiado' : 'Copiar'}
            icon={copied ? <Check className="size-3.5" strokeWidth={1.5} aria-hidden /> : <Copy className="size-3.5" strokeWidth={1.5} aria-hidden />}
            onClick={() => void copy(content)}
          />
        </div>
      </div>
      {isText ? (
        <div className="whitespace-pre-wrap px-4 py-3 font-sans text-[15px]/6 text-fg [overflow-wrap:anywhere]">{content}</div>
      ) : (
        // Rola por dentro enquanto não quebra (precisa de foco de teclado: axe scrollable-region-focusable); quebrado, não rola e sai da ordem de foco.
        <pre tabIndex={wrapped ? undefined : 0} className={cn('code-block-body px-4 py-3', wrapped ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'overflow-x-auto whitespace-pre')}>
          <code>{content}</code>
        </pre>
      )}
      <span role="status" className="sr-only">
        {copied ? 'Conteúdo copiado' : ''}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Ação do cabeçalho: texto visível normalmente; só ícone (com nome acessível e tooltip) no cartão estreito
// ---------------------------------------------------------------------------------------------------------------

interface BlockActionProps {
  compact: boolean;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  'aria-pressed'?: boolean;
}

/** Botão ghost do kit: 32 px de altura; só ícone usa o tamanho `icon` (32 px, 40 px no mobile) e ganha `aria-label` e tooltip. */
function BlockAction({ compact, label, icon, onClick, 'aria-pressed': pressed }: BlockActionProps) {
  const pressedStyle = 'aria-pressed:bg-selected aria-pressed:text-fg';
  if (!compact) {
    return (
      <Button variant="ghost" size="sm" aria-pressed={pressed} onClick={onClick} className={cn('gap-1.5 px-2', pressedStyle)}>
        {icon}
        {label}
      </Button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label} aria-pressed={pressed} onClick={onClick} className={pressedStyle}>
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Decide o modo compacto do cabeçalho pela medida real: os botões em texto (largura das ações medida enquanto mostram texto) mais o
 * espaçamento do cabeçalho e `minLabel` px de rótulo precisam caber na largura interna do cabeçalho. Começa `false` (o HTML do servidor sai
 * com os textos), então a primeira medida sempre acontece com os textos na tela.
 *
 * Guarda a MAIOR largura das ações vista em texto: "Copiado" é mais largo que "Copiar", e a fonte web pode chegar depois da primeira medida;
 * no modo compacto não há texto para medir, então a volta ao texto usa essa largura guardada (sem isso o cartão oscilaria entre os modos).
 * ponytail: se a fonte mudar enquanto o cartão está compacto, a largura guardada fica a da fonte anterior até o cartão voltar ao texto; medir
 * um clone oculto resolveria, só vale se aparecer cartão preso no modo errado.
 */
function useCompactHeader(minLabel: number) {
  const headerRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  // Espelho do estado para o callback do observer, que não é recriado a cada troca de modo.
  const compactRef = useRef(false);
  const textActionsWidth = useRef(0);
  useEffect(() => {
    const header = headerRef.current;
    const actions = actionsRef.current;
    if (!header || !actions) return;
    const measure = () => {
      if (!compactRef.current) textActionsWidth.current = Math.max(textActionsWidth.current, actions.offsetWidth);
      const style = getComputedStyle(header);
      const chrome = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.columnGap || '0');
      const next = header.clientWidth < chrome + textActionsWidth.current + minLabel;
      compactRef.current = next;
      setCompact(next);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    observer.observe(actions);
    return () => observer.disconnect();
  }, [minLabel]);
  return { headerRef, actionsRef, compact };
}

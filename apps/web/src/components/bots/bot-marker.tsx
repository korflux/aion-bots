// Marcador do bot: círculo preenchido com a cor do bot e a inicial do nome. É a forma do bot ABAIXO do piso da Faísca (24 px): em 16 e 20 px o rosto da
// Faísca vira mancha, então o `BotAvatar` cai para a inicial. Quem escolhe entre os dois é o `BotAvatar`, o único consumidor; as telas pedem o avatar e
// nunca o marcador direto. A cor do bot entra como `--bot` (definido em tempo de execução por bot) e só pinta este círculo; a inicial usa o texto, escuro
// ou claro, de maior contraste sobre a cor. É decorativo: o nome do bot sempre vem ao lado.
import { readableTextOn } from '@aion/shared';
import type { CSSProperties } from 'react';
import { cn } from '@/lib/cn';
import { initialOf } from './bot-display';

/** `size` é o lado em px; o design usa 16, 20, 24, 32 e 40 (o tipo aceita qualquer número para o `BotAvatar` poder repassar o tamanho que recebeu). */
export function BotMarker({ name, color, size = 24, className }: { name: string; color: string; size?: number; className?: string }) {
  const style = {
    '--bot': color,
    width: size,
    height: size,
    fontSize: Math.round(size * 0.5),
    color: readableTextOn(color),
  } as CSSProperties;
  return (
    <span
      aria-hidden
      style={style}
      className={cn('inline-flex shrink-0 select-none items-center justify-center rounded-full bg-(--bot) font-semibold leading-none', className)}
    >
      {initialOf(name)}
    </span>
  );
}

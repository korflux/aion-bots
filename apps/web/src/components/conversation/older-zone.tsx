// Faixa no topo da lista de mensagens (design: "Topo da conversa (carga por rodadas)"): onde o dono vê e comanda o carregamento do histórico.
// Fica sempre como primeiro item da lista, acima da mensagem mais antiga carregada, e tem quatro estados na mesma faixa de altura mínima
// fixa (40 px; 44 px no celular), para a carga não deslocar o que o dono está lendo:
// - há mais e nada em curso: botão "Carregar mensagens anteriores" (a rolagem já carrega sozinha; o botão é a alternativa para teclado e leitor de tela);
// - carregando: spinner de 14 px e "Carregando mensagens anteriores…" no lugar do botão;
// - sem mais: "Início da conversa" entre dois filetes;
// - erro: aviso e "Tentar novamente" (o que já está na tela continua nela).
// Acessibilidade: o texto de estado vive num `aria-live="polite"` que está SEMPRE no DOM (uma região inserida já com o texto quase nunca é lida);
// o botão de carregar fica fora dela para não ser anunciado a cada página que entra.
import { LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

/** O que a carga das rodadas anteriores está fazendo: nada, buscando ou falhou (a falha segura o carregamento automático até "Tentar novamente"). */
export type OlderPhase = 'idle' | 'loading' | 'error';

/** Botão ghost do estado "há mais" e do erro: no celular ocupa a largura da coluna com 44 px de altura e o texto quebra linha (design). */
const WIDE_ON_PHONE = 'max-md:h-11 max-md:w-full max-md:whitespace-normal';

export function OlderZone({ hasMore, phase, onLoad }: { hasMore: boolean; phase: OlderPhase; onLoad: () => void }) {
  const failed = phase === 'error';
  const loading = phase === 'loading';
  const atStart = !hasMore && !loading && !failed;
  return (
    <div className="flex min-h-10 shrink-0 items-center justify-center max-md:min-h-11">
      {hasMore && phase === 'idle' ? (
        <Button variant="ghost" size="sm" onClick={onLoad} className={WIDE_ON_PHONE}>
          Carregar mensagens anteriores
        </Button>
      ) : null}
      <div aria-live="polite" className={cn('flex items-center justify-center gap-2 text-xs', loading && 'text-muted', failed && 'flex-wrap text-danger', atStart && 'w-full gap-3 text-subtle')}>
        {loading ? (
          <>
            <LoaderCircle data-icon="LoaderCircle" className="size-3.5 animate-spin" strokeWidth={1.5} aria-hidden />
            Carregando mensagens anteriores…
          </>
        ) : null}
        {atStart ? (
          <>
            <span aria-hidden className="h-px flex-1 bg-line" />
            Início da conversa
            <span aria-hidden className="h-px flex-1 bg-line" />
          </>
        ) : null}
        {failed ? (
          <>
            Não foi possível carregar as mensagens anteriores.
            <Button variant="ghost" size="sm" onClick={onLoad} className={WIDE_ON_PHONE}>
              Tentar novamente
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

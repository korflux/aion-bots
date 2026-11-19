// Faixa que orienta o que falta configurar para conversar, com o link da tela que resolve: o provedor (F3, "Abrir Conexões") ou o modelo padrão do Chat geral
// (T23, "Abrir Preferências"). Fonte única da faixa e dos textos: a conversa (`conversation-view.tsx`) e o Início (`home/home-composer.tsx`) mostram a MESMA
// faixa acima do composer desabilitado, então a frase e o destino nunca divergem entre as duas telas.
import Link from 'next/link';
import { Button } from '@/components/ui/button';

/** Sem provedor configurado o composer fica desabilitado e diz isto (campo e faixa). */
export const PROVIDER_REASON = 'Configure um provedor para conversar.';
/** O Chat geral exige o modelo padrão (T23): sem ele o composer fica desabilitado e diz isto (campo e faixa). */
export const DEFAULT_MODEL_REASON = 'Defina o modelo padrão do Chat geral para conversar.';

/** A faixa: o texto e o botão que leva à tela certa (`href`, `action`), na largura da coluna do composer. */
export function SetupBanner({ text, href, action }: { text: string; href: string; action: string }) {
  return (
    <div className="px-3 pb-3 md:px-6">
      <div className="mx-auto flex w-full max-w-[760px] flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface grad-sheen p-3">
        <p className="text-sm text-fg">{text}</p>
        <Button asChild variant="secondary" size="sm">
          <Link href={href}>{action}</Link>
        </Button>
      </div>
    </div>
  );
}

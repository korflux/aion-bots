'use client';

// Fronteira de erro do app (design: Login, TOTP, não encontrada e erro; F11 passo 5, A18): cobre qualquer falha de renderização, inclusive a de falar com a API
// (fora do ar), sem expor detalhes técnicos. O erro real fica no log do servidor (`error` não é mostrado, nem o `digest`); aqui há só a mensagem segura, a Faísca em
// pose de erro com a entrada, "Tentar novamente" (primário, `retry` refaz a leitura do servidor E a renderização do segmento; só `reset` reexibiria a resposta que
// falhou) e o caminho de volta ao Início. Esta fronteira fica ACIMA do layout `(app)`, então a tela substitui o shell e é o `<main>` da página; o `global-error.tsx`
// a reutiliza para o erro do layout raiz.
import { ErrorScreen } from '@/components/page';
import { Button } from '@/components/ui/button';

export default function AppError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <ErrorScreen state="error" title="Algo deu errado" description="Não foi possível mostrar esta página. Tente de novo.">
      <Button variant="primary" onClick={retry}>
        Tentar novamente
      </Button>
      {/* Âncora comum de propósito (não `next/link`): carga completa, que também reinicia o layout raiz quando a falha é a dele (`global-error`), em vez de navegar
          dentro de um roteador que pode estar no estado do erro (e que nem navega quando a URL já é a de destino). */}
      <Button asChild variant="secondary">
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- carga completa de propósito, ver acima */}
        <a href="/">Ir para o Início</a>
      </Button>
    </ErrorScreen>
  );
}

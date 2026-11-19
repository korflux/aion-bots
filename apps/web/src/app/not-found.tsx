// Tela "Não encontrado" FORA do shell (design: Login, TOTP, não encontrada e erro; F11 passo 4): o Next a serve para a URL que não casa com nenhuma rota, e a
// tela é o `<main>` da página. Para o `notFound()` de uma página do app o Next usa `(app)/not-found.tsx`, que mantém o shell e não repete o `main`. Componente de
// servidor: a Faísca é pura e a entrada é só CSS; o texto, o estado da Faísca e o caminho de volta vivem em `NotFoundScreen` (components/page.tsx).
import { NotFoundScreen } from '@/components/page';

export default function NotFound() {
  return <NotFoundScreen />;
}

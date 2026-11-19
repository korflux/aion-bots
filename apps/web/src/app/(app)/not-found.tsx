// Tela "Não encontrado" DENTRO do shell (F11 passo 4): é o que o Next serve quando uma página do app chama `notFound()` (id que não é UUID, bot ou sessão que
// não existe). O shell continua à volta e já tem o `<main>` da página, então a tela entra sem outro `main` (`inShell`; antes o `<main>` da tela ficava dentro do do
// shell, .erros-encontrados/2026-10-04-nao-encontrada-por-notfound-renderiza-main-aninhado-no-shell.md). A URL que não casa com rota nenhuma cai no `not-found.tsx` da raiz.
import { NotFoundScreen } from '@/components/page';

export default function AppNotFound() {
  return <NotFoundScreen inShell />;
}

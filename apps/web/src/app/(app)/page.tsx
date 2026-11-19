// Raiz do app (`/`): o Início (phase 5, T5; antes redirecionava para /bots). Qualquer largura, mesma página; o que muda é o shell à volta. `/bots` continua abrindo o último bot.
import { HomeView } from '@/components/home/home-view';

export default function Home() {
  return <HomeView />;
}

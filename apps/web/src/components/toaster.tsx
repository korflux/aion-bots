'use client';

// Toasts do app (sonner) com os tokens do kit: canto inferior direito no desktop e topo no mobile.
// Somem em 4 s; erros devem ser emitidos com `duration: Infinity` para ficar até serem fechados.
//
// No mobile o toast entra ABAIXO do cabeçalho de 52 px (E25): no topo da tela ele cobria o cabeçalho dos drawers de tela cheia (o botão de
// fechar e o de voltar), e um toast de erro, que fica até ser fechado, deixaria esses controles inalcançáveis.
import { Toaster as Sonner } from 'sonner';
import { useMediaQuery } from '@/lib/use-media-query';

/** Distância do topo no mobile: a altura do cabeçalho (52 px) mais uma folga. */
const MOBILE_TOP_OFFSET = 60;

/** O contêiner dos toasts do app: posição por largura da tela, prazo, botão de fechar e cores do kit. */
export function Toaster() {
  const mobile = useMediaQuery('(max-width: 767px)');
  return (
    <Sonner
      theme="dark"
      position={mobile ? 'top-center' : 'bottom-right'}
      offset={mobile ? { top: MOBILE_TOP_OFFSET } : undefined}
      // O Sonner usa `mobileOffset` abaixo de 600 px e `offset` acima disso; o app trata como mobile até 767 px, então os dois.
      mobileOffset={{ top: MOBILE_TOP_OFFSET }}
      duration={4000}
      closeButton
      containerAriaLabel="Notificações"
      toastOptions={{
        style: {
          // Cor sólida do token mais a camada `grad-sheen` (o valor é o do token; o estilo em linha é o único que vence o `background` próprio do Sonner).
          backgroundColor: 'var(--bg-surface)',
          backgroundImage: 'var(--grad-sheen)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          fontSize: '14px',
        },
      }}
    />
  );
}

'use client';

// Teclado virtual aberto? (phase 5, T6; spec F3 passo 4 e Suposição 17): a barra inferior some enquanto o dono digita, para o composer ficar logo acima do teclado, e
// volta quando ele fecha. O navegador não avisa "teclado aberto"; o sinal é a COMBINAÇÃO de um campo de texto com foco e a viewport visual (`visualViewport`) bem menor
// que a de antes. Só a viewport menor não basta (zoom de pinça, barra de endereço que some) e só o foco também não (teclado físico, ou o teclado que já estava fechado).
//
// A altura "de antes" (`baseline`) é lida da própria viewport enquanto nenhum campo tem foco, então acompanha rotação e barra do navegador sem constante de aparelho. Tanto no
// modo em que o teclado só encolhe a viewport visual quanto no que encolhe também a de layout (`interactive-widget=resizes-content`, do `layout.tsx`), a altura visual cai.

import { useEffect, useState } from 'react';

/** Quanto a viewport visual precisa encolher, em px, para contar como teclado: acima do que a barra do navegador esconde e abaixo do menor teclado. */
export const KEYBOARD_MIN_SHRINK = 120;

/** O elemento aceita texto pelo teclado? Campos de texto, `textarea` e `contenteditable`; caixa de seleção, botão e `select` não abrem o teclado de texto. */
export function isTextEntry(element: Element | null): boolean {
  if (element === null) return false;
  if (element instanceof HTMLTextAreaElement) return !element.readOnly;
  if (element instanceof HTMLInputElement) {
    return !element.readOnly && !['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit'].includes(element.type);
  }
  return element instanceof HTMLElement && element.isContentEditable;
}

/** Decisão pura: há campo de texto com foco e a viewport visual encolheu pelo menos `KEYBOARD_MIN_SHRINK` px em relação à de antes. */
export function keyboardIsOpen({ baseline, height, editing }: { baseline: number; height: number; editing: boolean }): boolean {
  return editing && baseline - height >= KEYBOARD_MIN_SHRINK;
}

/**
 * Acompanha o teclado virtual. Reavalia a cada mudança da viewport visual e a cada foco que entra ou sai (esta última depois de um ciclo, quando `activeElement` já
 * assentou: de um campo para outro o foco passa por "nenhum" e a barra não pode piscar). A base só se atualiza com nenhum campo em foco ou quando a largura muda
 * (rotação); com zoom de pinça (`scale` diferente de 1) a viewport encolhe sem haver teclado, então nada se esconde. Sem `visualViewport`, o teclado é dado como fechado.
 */
export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let baseline = viewport.height;
    let width = viewport.width;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const evaluate = () => {
      const editing = isTextEntry(document.activeElement);
      if (viewport.width !== width || !editing) {
        width = viewport.width;
        baseline = viewport.height;
      }
      setOpen(viewport.scale === 1 && keyboardIsOpen({ baseline, height: viewport.height, editing }));
    };
    const evaluateSoon = () => {
      clearTimeout(timer);
      timer = setTimeout(evaluate, 0);
    };

    viewport.addEventListener('resize', evaluate);
    document.addEventListener('focusin', evaluateSoon);
    document.addEventListener('focusout', evaluateSoon);
    return () => {
      clearTimeout(timer);
      viewport.removeEventListener('resize', evaluate);
      document.removeEventListener('focusin', evaluateSoon);
      document.removeEventListener('focusout', evaluateSoon);
    };
  }, []);

  return open;
}

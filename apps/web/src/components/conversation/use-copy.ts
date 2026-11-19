'use client';

// Fonte única do "Copiar" da conversa (phase 3 F8 e phase 4 F6): usada pelo cartão de bloco cercado (`code-block.tsx`) e pela barra de ações da
// mensagem (`message-actions.tsx`). Quem chama entrega o texto exato (a cópia nunca lê o DOM); o hook põe na área de transferência, liga o
// estado "Copiado" por 2 s e, se o navegador negar, mostra o toast de erro persistente da phase 3 (a conversa não tem lugar fixo para o erro).
// O anúncio para leitor de tela fica com o componente, que sabe o que foi copiado ("Conteúdo copiado", "Mensagem copiada").
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

/** Tempo do estado "Copiado" no botão. */
const COPIED_MS = 2000;
/** Texto exato do toast de falha (phase 3 F8, passo 5; phase 4 F6, passo 2). */
const COPY_FAILED_MESSAGE = 'Não foi possível copiar. Selecione o texto e copie manualmente.';

/** Estado e ação de cópia de um botão: `copy(text)` grava o texto e liga `copied` por `COPIED_MS`; a falha vira o toast. */
export function useCopy(): { copied: boolean; copy: (text: string) => Promise<void> } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // O "Copiado" de uma cópia anterior não pode disparar depois que o botão sai da tela.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      toast.error(COPY_FAILED_MESSAGE, { duration: Infinity });
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  }, []);

  return { copied, copy };
}

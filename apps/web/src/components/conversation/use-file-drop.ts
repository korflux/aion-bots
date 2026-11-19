'use client';

// Arrastar e soltar arquivos na tela da conversa (bot, Chat geral e Início). Escuta a janela inteira, então o dono pode soltar em qualquer
// ponto do chat, não só sobre o campo. Só reage a arrastes que trazem arquivos (texto ou link arrastado seguem o comportamento normal) e
// entrega os arquivos ao mesmo fluxo do botão de anexar (`useAttachments().add`), com a mesma validação, limite e upload.
import { useEffect, useRef, useState } from 'react';

/** O arraste carrega arquivos do sistema (não texto selecionado nem um link da própria página). */
const hasFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer?.types ?? []).includes('Files');

/** `dragging` liga o aviso visual; desligado (`enabled` falso) não intercepta nada e o navegador mantém o padrão. */
export function useFileDrop(enabled: boolean, onFiles: (files: File[]) => void): boolean {
  const [dragging, setDragging] = useState(false);
  const handler = useRef(onFiles);
  useEffect(() => { handler.current = onFiles; });
  useEffect(() => {
    if (!enabled) return;
    // dragenter/dragleave disparam em cada elemento filho: o contador evita piscar o aviso ao passar por cima deles.
    let depth = 0;
    const enter = (event: DragEvent) => { if (!hasFiles(event)) return; depth += 1; setDragging(true); };
    const leave = (event: DragEvent) => { if (!hasFiles(event)) return; depth = Math.max(0, depth - 1); if (depth === 0) setDragging(false); };
    // Sem preventDefault no dragover o navegador abre o arquivo na aba em vez de entregá-lo à página.
    const over = (event: DragEvent) => { if (!hasFiles(event)) return; event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0; setDragging(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length) handler.current(files);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
      setDragging(false);
    };
  }, [enabled]);
  return dragging;
}

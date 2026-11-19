'use client';

// Assina uma media query do navegador. No servidor (e na hidratação) vale `false`, então o HTML inicial nunca
// diverge do cliente; por isso o layout estrutural (desktop x mobile) usa classes CSS responsivas e este hook
// só decide comportamento (posição do toast, painel recolhido por padrão em tablet).
import { useSyncExternalStore } from 'react';

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

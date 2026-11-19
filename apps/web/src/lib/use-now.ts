'use client';

// Relógio de tela: devolve o instante atual em milissegundos e o atualiza a cada `intervalMs`, para textos relativos ("há 5 min",
// "Expira em 23 h") acompanharem o tempo sem recarregar a página. Usado pelo cartão de aprovação e pela tela Atividades.
import { useEffect, useState } from 'react';

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

'use client';

// QR code desenhado LOCALMENTE, no navegador, a partir do texto recebido (a URI `otpauth://` com o segredo do
// autenticador). Nenhum serviço externo gera a imagem nem recebe o segredo, e nada é injetado como HTML: o SVG é
// montado pelo React com um único `<path>`, então a CSP (img-src 'self' data: blob:, sem fontes externas) não
// muda e não há superfície de XSS.
//
// Layout do design: 200 px de lado sobre fundo branco com 16 px de margem (a "zona silenciosa" que a câmera
// precisa para ler; por isso o fundo é branco fixo e não um token do tema escuro).
import { useMemo } from 'react';
import { encode } from 'uqr';

/** Caminho SVG com uma faixa por sequência contínua de módulos escuros de cada linha (`M x y h n v1 h-n z`). */
function modulesToPath(rows: boolean[][]): string {
  let path = '';
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      let end = x;
      while (end < row.length && row[end]) end += 1;
      path += `M${x} ${y}h${end - x}v1h-${end - x}z`;
      x = end;
    }
  });
  return path;
}

export function QrCode({ value, label }: { value: string; label: string }) {
  // Correção de erro M (15 %) cobre reflexo e impressão ruim de tela sem inflar demais o número de módulos.
  const { size, path } = useMemo(() => {
    const { data } = encode(value, { ecc: 'M', border: 0 });
    return { size: data.length, path: modulesToPath(data) };
  }, [value]);

  return (
    <div className="mx-auto w-fit rounded-md bg-white p-4">
      <svg role="img" aria-label={label} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" className="block size-[200px]">
        <path d={path} fill="#000" />
      </svg>
    </div>
  );
}

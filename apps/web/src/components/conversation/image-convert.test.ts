// Conta de redimensionamento independente do canvas; recodificação real pertence à prova Chromium.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { convertImage, imageSize } from './image-convert';
afterEach(() => vi.unstubAllGlobals());
describe('dimensões da imagem preparada', () => {
  it('limita o maior lado sem ampliar e conserva retratos, paisagens e quadrados', () => {
    expect(imageSize(4000, 3000)).toEqual({ width: 2000, height: 1500 });
    expect(imageSize(1000, 5000)).toEqual({ width: 400, height: 2000 });
    expect(imageSize(300, 300)).toEqual({ width: 300, height: 300 });
  });
  it('normaliza falhas nativas sem detalhe técnico e libera o bitmap', async () => {
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 200, height: 100, close }));
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => { throw new Error('DETALHE TÉCNICO DO CANVAS'); } }) });
    await expect(convertImage(new File(['imagem'], 'a.png'))).rejects.toThrow('Não consegui ler este arquivo.');
    expect(close).toHaveBeenCalledOnce();
  });
});

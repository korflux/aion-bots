// Verificação da composição de hipóteses: reconhecimento substitui só a seleção e preserva o texto em volta.
// O ciclo vivo (cursor, edição, parada, desmontagem e erros) é exercitado pelo fake no E2E.
import { describe, expect, it } from 'vitest';
import { dictationError, dictationText } from './use-dictation';

describe('texto do ditado', () => {
  it('preserva ambos os lados da seleção e posiciona o cursor antes do sufixo', () => {
    expect(dictationText('Olá', 'Marco', 'fim')).toEqual({ text: 'Olá Marco fim', cursor: 9 });
    expect(dictationText('Olá ', 'Marco', ' fim')).toEqual({ text: 'Olá Marco fim', cursor: 9 });
    expect(dictationText('', 'Bom dia', '')).toEqual({ text: 'Bom dia', cursor: 7 });
    expect(dictationText('Olá', '', 'fim')).toEqual({ text: 'Oláfim', cursor: 3 });
  });
  it('explica o silêncio sem alerta e não expõe erros internos desconhecidos', () => {
    expect(dictationError('no-speech')).toEqual({ message: 'Não ouvi nada. Tente de novo.', role: 'status' });
    expect(dictationError('detalhe técnico do navegador')).toEqual({ message: 'O ditado por voz não funciona neste modo. Use o ditado do teclado.', role: 'alert' });
  });
});

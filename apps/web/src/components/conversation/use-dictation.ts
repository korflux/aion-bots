'use client';

// Ditado exclusivamente no navegador: nenhum áudio, resultado parcial ou credencial passa por uma API do Aion.
// A instância vive por toque, termina no silêncio e é abortada ao editar, enviar ou desmontar o composer.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';

/** Subconjunto do Web Speech usado aqui; também permite injetar um reconhecimento falso no navegador dos testes. */
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type RecognitionConstructor = new () => SpeechRecognitionLike;
type SpeechWindow = Window & { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
/** A capacidade não muda durante a página; o snapshot de servidor evita divergência na hidratação. */
const subscribeSupport = () => () => {};
/** Descobre tanto a API padrão quanto o prefixo do Chrome. */
function speechSupported() { const speechWindow = window as SpeechWindow; return Boolean(speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition); }
/** O servidor não oferece reconhecimento de voz. */
const serverSupport = () => false;
/** Remove os callbacks antes de liberar o microfone, inclusive quando abort dispara eventos síncronos. */
function releaseRecognition(current: SpeechRecognitionLike | null) {
  if (!current) return;
  current.onresult = null; current.onerror = null; current.onend = null;
  current.abort();
}

/** Erros conhecidos do navegador viram instruções seguras; silêncio é informativo, sem alerta de falha. */
export function dictationError(code: string): { message: string; role: 'alert' | 'status' } {
  switch (code) {
    case 'not-allowed': return { message: 'Permita o microfone nas configurações do site para ditar.', role: 'alert' };
    case 'no-speech': return { message: 'Não ouvi nada. Tente de novo.', role: 'status' };
    case 'network': return { message: 'O ditado precisa de conexão com a internet.', role: 'alert' };
    case 'audio-capture': return { message: 'Não consegui acessar o microfone.', role: 'alert' };
    default: return { message: 'O ditado por voz não funciona neste modo. Use o ditado do teclado.', role: 'alert' };
  }
}

/** Insere cada hipótese na seleção inicial, substituindo só a hipótese anterior e preservando o restante do rascunho. */
export function dictationText(before: string, transcript: string, after: string) {
  const left = before !== '' && !/\s$/.test(before) && transcript !== '' ? ' ' : '';
  const right = after !== '' && !/^\s/.test(after) && transcript !== '' ? ' ' : '';
  return { text: `${before}${left}${transcript}${right}${after}`, cursor: before.length + left.length + transcript.length };
}

/** Um ditado por gesto. Editar manualmente encerra a hipótese corrente para que resultados tardios não sobrescrevam a edição. */
export function useDictation({ field, text, setText, locale, enabled }: {
  field: RefObject<HTMLTextAreaElement | null>; text: string; setText: (text: string) => void; locale: string | null; enabled: boolean;
}) {
  const supported = useSyncExternalStore(subscribeSupport, speechSupported, serverSupport);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<ReturnType<typeof dictationError> | null>(null);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const cursor = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      const current = recognition.current;
      recognition.current = null;
      releaseRecognition(current);
    };
  }, []);

  useLayoutEffect(() => {
    if (cursor.current === null) return;
    field.current?.setSelectionRange(cursor.current, cursor.current);
    cursor.current = null;
  }, [text, field]);

  /** Aborta sem apagar o texto reconhecido; resultados posteriores já não pertencem ao rascunho atual. */
  function cancel() {
    const current = recognition.current;
    recognition.current = null;
    releaseRecognition(current);
    setListening(false);
  }

  useEffect(() => {
    if (!enabled && recognition.current) {
      const current = recognition.current;
      recognition.current = null;
      releaseRecognition(current);
      setListening(false);
    }
  }, [enabled]);

  /** O primeiro toque cria a escuta no idioma confirmado; o segundo pede o resultado final e mantém o texto parcial. */
  function toggle() {
    if (recognition.current) { recognition.current.stop(); return; }
    if (!enabled || locale === null) return;
    const speechWindow = window as SpeechWindow;
    const Constructor = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!Constructor) return;
    const start = field.current?.selectionStart ?? text.length;
    const end = field.current?.selectionEnd ?? start;
    const before = text.slice(0, start);
    const after = text.slice(end);
    setError(null);
    try {
      const current = new Constructor();
      recognition.current = current;
      current.lang = locale;
      current.continuous = false;
      current.interimResults = true;
      current.onresult = (event) => {
        if (recognition.current !== current) return;
        const transcript = Array.from(event.results, (result) => result[0].transcript).join('');
        const next = dictationText(before, transcript, after);
        cursor.current = next.cursor;
        setText(next.text);
      };
      current.onerror = (event) => {
        if (recognition.current !== current) return;
        if (event.error !== 'aborted') setError(dictationError(event.error));
        cancel();
      };
      current.onend = () => {
        if (recognition.current !== current) return;
        recognition.current = null;
        setListening(false);
      };
      current.start();
      setListening(true);
    } catch (cause) {
      cancel();
      setError(dictationError(cause instanceof DOMException && cause.name === 'NotAllowedError' ? 'not-allowed' : 'service-not-allowed'));
    }
  }
  return { supported, listening, error, toggle, cancel };
}

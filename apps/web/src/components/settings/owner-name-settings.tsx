'use client';

// "Como te chamar" (phase 5, T10: antes em Preferências, agora em Personalização, junto das Regras globais, por pedido do dono): o cartão "Seu nome", o nome que a
// saudação do Início usa. Grava ao mudar, sem botão: "Salvo" ao lado do rótulo (região `aria-live`) e, se a gravação falha ou o nome não serve, o erro abaixo do campo com
// o valor MANTIDO na tela. A gravação, a leitura das preferências e o retorno do campo são os de `settings-save.tsx` e `field-feedback.tsx` (os mesmos de Preferências).
//
// O texto grava ao sair do campo ou ao apertar Enter. O nome nunca sai da tela do dono: o servidor o recusa se tiver mais de 40 caracteres ou caractere de controle (o
// schema compartilhado confere antes de enviar, então um nome inválido nem chega à rede). "Tentar de novo" só existe quando foi a GRAVAÇÃO que falhou: um nome inválido
// não tem o que reenviar.
import { OWNER_NAME_MAX_CHARS, ownerNameSchema, type AppSettings } from '@aion/shared';
import { useId, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/api-client';
import { FieldError, SAVE_FAILED_MESSAGE, useFieldFeedback } from './field-feedback';
import { AppSettingsGate, LabelRow, settingsCardClass, type SaveSettings } from './settings-save';

/** Mensagem do campo do nome quando o valor não serve (texto da spec, F9): vale tanto para a conferência local quanto para a recusa do servidor. */
const OWNER_NAME_INVALID_MESSAGE = `Use até ${OWNER_NAME_MAX_CHARS} caracteres, sem símbolos de controle.`;

/** "Como te chamar": texto livre de até 40 caracteres que a saudação do Início usa; vazio apaga o nome. Grava ao sair do campo ou no Enter. */
function OwnerNameField({ saved, save }: { saved: AppSettings; save: SaveSettings }) {
  const id = useId();
  const { feedback, saved: markSaved, failed, reset } = useFieldFeedback();
  const [text, setText] = useState(saved.ownerName);
  /** O último valor enviado (ou já salvo): Enter seguido do `blur` não envia duas vezes o mesmo texto. */
  const sent = useRef(saved.ownerName);

  function commit() {
    const parsed = ownerNameSchema.safeParse(text);
    if (!parsed.success) {
      failed(OWNER_NAME_INVALID_MESSAGE);
      return;
    }
    const value = parsed.data;
    setText(value); // mostra o texto como será guardado (sem os espaços das pontas)
    if (value === sent.current) return;
    const previous = sent.current;
    sent.current = value;
    reset();
    save({ ownerName: value }).then(markSaved, (error: unknown) => {
      sent.current = previous; // não gravou: o mesmo texto pode ser enviado de novo
      failed(error instanceof ApiError && error.code === 'VALIDATION_FAILED' ? OWNER_NAME_INVALID_MESSAGE : SAVE_FAILED_MESSAGE);
    });
  }

  return (
    <section aria-labelledby={`${id}-titulo`} className={settingsCardClass}>
      <h2 id={`${id}-titulo`} className="text-sm font-semibold text-fg">
        Seu nome
      </h2>
      <p className="mb-4 mt-1 text-sm text-muted">Só para a saudação: os bots e o Chat geral não recebem o seu nome.</p>
      <LabelRow htmlFor={`${id}-nome`} feedback={feedback}>
        Como te chamar
      </LabelRow>
      <Input
        id={`${id}-nome`}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          reset();
        }}
        onBlur={() => commit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
        }}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={feedback.kind === 'error' ? true : undefined}
        aria-describedby={feedback.kind === 'error' ? `${id}-dica ${id}-erro` : `${id}-dica`}
        className="max-w-80"
      />
      <p id={`${id}-dica`} className="mt-1.5 text-xs text-subtle">
        Aparece na saudação do Início.
      </p>
      <FieldError id={`${id}-erro`} feedback={feedback} onRetry={feedback.kind === 'error' && feedback.message === SAVE_FAILED_MESSAGE ? commit : undefined} />
    </section>
  );
}

/** O cartão "Seu nome" de Personalização, com a leitura das preferências (carregando, erro com "Tentar novamente") e a fila de gravação do `settings-save.tsx`. */
export function OwnerNameSettings() {
  return <AppSettingsGate>{(saved, save) => <OwnerNameField saved={saved} save={save} />}</AppSettingsGate>;
}

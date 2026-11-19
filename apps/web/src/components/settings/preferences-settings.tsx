'use client';

// Configurações → Preferências (phase 5, T4; spec F9 e Suposição 22; design "Tela: Áreas de Configurações"): os campos que descrevem COMO o Aion fala com o dono, em dois
// cartões: "Idioma e fuso" (idioma das respostas dos bots e fuso horário) e o modelo padrão do Chat geral (`ChatModelCard`, em `chat/chat-settings.tsx`). Substitui as telas
// antigas Idioma e fuso (que tinha o botão Salvar) e Chat geral. O "Como te chamar" morava aqui e foi para Personalização (T10, `owner-name-settings.tsx`).
//
// SALVA AO MUDAR, sem botão: cada campo grava sozinho e mostra "Salvo" ao lado do rótulo; se a gravação falha, a tela MANTÉM o valor escolhido e mostra o erro
// abaixo do campo, com "Tentar de novo" (um seletor cujo valor já é o escolhido não teria como reenviar). Seletores gravam ao escolher.
//
// A fila de gravação (as gravações vão UMA POR VEZ, com o último estado confirmado), a leitura das preferências e o rótulo com o "Salvo" são de `settings-save.tsx`, que a área
// Personalização usa do mesmo jeito.
import { LANGUAGES, LANGUAGE_CODES, type AppSettings, type LanguageCode } from '@aion/shared';
import { useId, useState } from 'react';
import { ChatModelCard } from '@/components/chat/chat-settings';
import { ContextPreferencesCard } from './context-preferences';
import { Select } from '@/components/ui/select';
import { describeNowIn, timeZoneOptions } from '@/lib/time-zones';
import { FieldError, SAVE_FAILED_MESSAGE, useFieldFeedback } from './field-feedback';
import { AppSettingsGate, LabelRow, settingsCardClass, type SaveSettings } from './settings-save';

/** Idioma das respostas dos bots: seletor que grava ao escolher. */
function LanguageField({ saved, save }: { saved: AppSettings; save: SaveSettings }) {
  const id = useId();
  const { feedback, saved: markSaved, failed, reset } = useFieldFeedback();
  const [language, setLanguage] = useState<LanguageCode>(saved.language);

  function send(value: LanguageCode) {
    reset();
    save({ language: value }).then(markSaved, () => failed(SAVE_FAILED_MESSAGE));
  }

  return (
    <div>
      <LabelRow htmlFor={`${id}-idioma`} feedback={feedback}>
        Idioma das respostas
      </LabelRow>
      <Select
        id={`${id}-idioma`}
        value={language}
        onChange={(event) => {
          const value = event.target.value as LanguageCode;
          setLanguage(value);
          send(value);
        }}
        aria-invalid={feedback.kind === 'error' ? true : undefined}
        aria-describedby={feedback.kind === 'error' ? `${id}-erro` : undefined}
      >
        {LANGUAGE_CODES.map((code) => (
          <option key={code} value={code}>
            {LANGUAGES[code].label}
          </option>
        ))}
      </Select>
      <FieldError id={`${id}-erro`} feedback={feedback} onRetry={() => send(language)} />
    </div>
  );
}

/** Fuso horário: seletor com os fusos do navegador (mais o salvo, se a lista não o trouxer, como `UTC`) que grava ao escolher; a dica mostra que horas são nele. */
function TimeZoneField({ saved, save }: { saved: AppSettings; save: SaveSettings }) {
  const id = useId();
  const { feedback, saved: markSaved, failed, reset } = useFieldFeedback();
  const [timeZone, setTimeZone] = useState(saved.timeZone);
  const zones = timeZoneOptions();
  const options = zones.includes(timeZone) ? zones : [timeZone, ...zones];

  function send(value: string) {
    reset();
    save({ timeZone: value }).then(markSaved, () => failed(SAVE_FAILED_MESSAGE));
  }

  return (
    <div>
      <LabelRow htmlFor={`${id}-fuso`} feedback={feedback}>
        Fuso horário
      </LabelRow>
      <Select
        id={`${id}-fuso`}
        value={timeZone}
        onChange={(event) => {
          setTimeZone(event.target.value);
          send(event.target.value);
        }}
        aria-invalid={feedback.kind === 'error' ? true : undefined}
        aria-describedby={feedback.kind === 'error' ? `${id}-dica ${id}-erro` : `${id}-dica`}
      >
        {options.map((zone) => (
          <option key={zone} value={zone}>
            {zone}
          </option>
        ))}
      </Select>
      <p id={`${id}-dica`} className="mt-1.5 text-xs text-subtle">
        Agora: {describeNowIn(timeZone, new Date())}.
      </p>
      <FieldError id={`${id}-erro`} feedback={feedback} onRetry={() => send(timeZone)} />
    </div>
  );
}

/** O cartão do idioma e do fuso, com a leitura das preferências (carregando, erro com "Tentar novamente") e a fila de gravação do `settings-save.tsx`. */
function GeneralPreferences() {
  return (
    <AppSettingsGate>
      {(saved, save) => (
        <section aria-labelledby="preferencias-idioma-fuso" className={settingsCardClass}>
          <h2 id="preferencias-idioma-fuso" className="text-sm font-semibold text-fg">
            Idioma e fuso
          </h2>
          <p className="mb-4 mt-1 text-sm text-muted">
            Os bots respondem neste idioma e enxergam a hora neste fuso, que também é o padrão das rotinas novas (cada rotina guarda o próprio). As telas do Aion continuam
            em português do Brasil.
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            <LanguageField saved={saved} save={save} />
            <TimeZoneField saved={saved} save={save} />
          </div>
        </section>
      )}
    </AppSettingsGate>
  );
}

/** O conteúdo da área Preferências (a moldura, com o título, é do `SettingsArea` da página). O modelo do Chat geral tem leitura e erro próprios. */
export function PreferencesSettings() {
  const [chatModel, setChatModel] = useState<string | null>(null);
  return (
    <>
      <GeneralPreferences />
      <ChatModelCard onModelChange={setChatModel} />
      <ContextPreferencesCard model={chatModel} />
    </>
  );
}

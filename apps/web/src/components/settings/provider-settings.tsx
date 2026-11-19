'use client';

// Configurações → Conexões → Provedores de IA (F3; phase 5, T4; phase 17, T5): um cartão por provedor de modelos, cada um com o campo de chave mascarada e o total de modelos
// disponíveis na última validação: "OpenCode Go" (o provedor padrão do Aion) e "Anthropic" (o segundo provedor, opcional: sem a chave só existem os modelos do OpenCode Go).
// Com a chave salva o cartão traz a curadoria dos modelos do provedor (`ProviderModels`, phase 17, passo 10): a lista, a busca e o interruptor Visível/Oculto de cada um.
// `ProviderCard` é a parte de tela (recebe o estado já lido) e `ProviderSettings`/`AnthropicSettings` só ligam cada cartão ao estado da própria chave. É um bloco da área Conexões:
// a moldura e o título ficam na página.
import type { CredentialKind, CredentialStatus, ModelProvider } from '@aion/shared';
import { Button } from '@/components/ui/button';
import { useCredentialStatus } from './credentials-api';
import { ProviderModels } from './provider-models';
import { SecretKeyField, type SecretKeyMessages } from './secret-key-field';

const pluralModels = (count: number) => `${count} ${count === 1 ? 'modelo disponível' : 'modelos disponíveis'}`;

/** O estado de uma chave como `useCredentialStatus` o entrega: sem `status` e sem `error` a leitura ainda está em curso. */
export interface CredentialState {
  status: CredentialStatus | null;
  error: string | null;
  setStatus: (status: CredentialStatus) => void;
  reload: () => void;
}

export interface ProviderCardProps {
  /** `id` do título, que nomeia a seção (`aria-labelledby`). */
  headingId: string;
  title: string;
  description: string;
  kind: CredentialKind;
  /** Nome do serviço nos textos do campo ("OpenCode Go", "Anthropic"). */
  serviceName: string;
  /** Efeito de desconectar, dito no modal de confirmação. */
  disconnectEffect: string;
  /** Textos que o padrão ("Chave do X salva") não acerta: a Anthropic é feminina ("Chave da Anthropic salva"). */
  messages?: SecretKeyMessages;
  state: CredentialState;
  /** Provedor de modelos do cartão: com ele e a chave salva, o cartão mostra a curadoria dos modelos. Sem ele (os testes de tela do cartão) a seção não existe. */
  modelProvider?: ModelProvider;
}

/** Cartão de um provedor de IA: título, texto, o campo da chave (só a versão mascarada) e, com a chave salva, o total de modelos. O erro vem das mensagens seguras da API. */
export function ProviderCard({ headingId, title, description, kind, serviceName, disconnectEffect, messages, state, modelProvider }: ProviderCardProps) {
  const { status, error, setStatus, reload } = state;
  return (
    <section aria-labelledby={headingId} className="rounded-lg border border-line bg-surface grad-sheen p-4 md:p-5">
      <h2 id={headingId} className="text-sm font-semibold text-fg">
        {title}
      </h2>
      <p className="mb-4 mt-1 text-sm text-muted">{description}</p>
      {error ? (
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
          <Button onClick={reload}>Tentar novamente</Button>
        </div>
      ) : status === null ? (
        <div aria-busy="true" aria-label="Carregando" className="h-24 animate-pulse rounded-md bg-app" />
      ) : (
        <div className="flex flex-col gap-4">
          <SecretKeyField kind={kind} serviceName={serviceName} status={status} onStatusChange={setStatus} disconnectEffect={disconnectEffect} {...(messages ? { messages } : {})} />
          {status.configured && status.modelCount !== null ? <p className="text-sm text-muted">{pluralModels(status.modelCount)}</p> : null}
          {/* `key` refaz a seção quando a chave é trocada: o catálogo do provedor pode ser outro. */}
          {status.configured && modelProvider ? <ProviderModels key={status.updatedAt ?? 'sem-data'} provider={modelProvider} serviceName={serviceName} /> : null}
        </div>
      )}
    </section>
  );
}

/** Provedor padrão do Aion (OpenCode Go). */
export function ProviderSettings() {
  const state = useCredentialStatus('provider');
  return (
    <ProviderCard
      headingId="provedor-opencode-go"
      title="Provedor de IA · OpenCode Go"
      description="Provedor de IA que executa os bots. A chave é validada no provedor, guardada cifrada no servidor e nunca volta para o navegador."
      kind="provider"
      serviceName="OpenCode Go"
      disconnectEffect='Conversas e rotinas passam a mostrar "Configure um provedor".'
      state={state}
      modelProvider="opencode"
    />
  );
}

/** A Anthropic é feminina nos textos do campo (toast e título do modal). */
const ANTHROPIC_MESSAGES: SecretKeyMessages = { saved: 'Chave da Anthropic salva', disconnected: 'Anthropic desconectada', disconnectTitle: 'Desconectar a Anthropic?' };

/** Segundo provedor (Anthropic, phase 17): opcional, libera os modelos Claude no seletor. A chave é provada com uma chamada mínima ao Claude Haiku 5.5 antes de ser gravada. */
export function AnthropicSettings() {
  const state = useCredentialStatus('anthropic');
  return (
    <ProviderCard
      headingId="provedor-anthropic"
      title="Provedor de IA · Anthropic"
      description="Opcional: libera os modelos Claude. A chave é provada com uma chamada mínima ao Claude Haiku 5.5, guardada cifrada no servidor e nunca volta para o navegador."
      kind="anthropic"
      serviceName="Anthropic"
      disconnectEffect="Os bots e conversas que usam modelos Claude deixam de rodar até a chave voltar; os modelos do OpenCode Go não mudam."
      messages={ANTHROPIC_MESSAGES}
      state={state}
      modelProvider="anthropic"
    />
  );
}

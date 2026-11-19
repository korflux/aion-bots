// Prova do estado de cada área no índice de Configurações (phase 5, T4; spec F9, Suposição 24): as frases do design a partir do que cada leitura devolveu, e, sobretudo, a
// regra de que uma leitura ausente ou com falha (`null`) deixa só a linha daquela área sem estado. Funções puras, sem DOM.
import type { AppSettings, CredentialStatus, CredentialsOverview } from '@aion/shared';
import { describe, expect, it } from 'vitest';
import { accountState, connectionsState, notificationsState, personalizationState, preferencesState, storageState } from './settings-summary';

const credential = (kind: CredentialStatus['kind'], configured: boolean): CredentialStatus => ({ kind, configured, masked: configured ? '••••1234' : null, updatedAt: null, modelCount: null });
const overview = (provider: boolean, connector: boolean): CredentialsOverview => ({ provider: credential('provider', provider), connector: credential('connector', connector), ...{ anthropic: credential('anthropic', false) } });
const settings: AppSettings = { language: 'pt-BR', timeZone: 'America/Sao_Paulo', ownerName: '' };

describe('estado das áreas do índice de Configurações', () => {
  it('Conexões diz o que falta: provedor primeiro, depois o Composio; tudo ligado é "Tudo conectado"', () => {
    expect(connectionsState(overview(false, false))).toBe('Provedor não configurado');
    expect(connectionsState(overview(false, true))).toBe('Provedor não configurado');
    expect(connectionsState(overview(true, false))).toBe('Composio não conectado');
    expect(connectionsState(overview(true, true))).toBe('Tudo conectado');
  });

  it('Conexões não cobra o OpenCode Go de quem só tem a chave da Anthropic: algum provedor de modelos basta', () => {
    const onlyAnthropic: CredentialsOverview = { ...overview(false, true), anthropic: credential('anthropic', true) };
    expect(connectionsState(onlyAnthropic)).toBe('Tudo conectado');
    expect(connectionsState({ ...onlyAnthropic, connector: credential('connector', false) })).toBe('Composio não conectado');
    expect(connectionsState(overview(false, true))).toBe('Provedor não configurado'); // nenhuma das duas chaves
  });

  it('Preferências junta o idioma e o modelo do Chat geral, ou avisa que o modelo não está definido', () => {
    expect(preferencesState(settings, { model: 'opencode/deepseek-v4.1-flash' })).toBe('Português (Brasil) · opencode/deepseek-v4.1-flash');
    expect(preferencesState({ ...settings, language: 'en' }, { model: 'opencode/glm-5.1' })).toBe('English · opencode/glm-5.1');
    expect(preferencesState(settings, { model: null })).toBe('Modelo do Chat geral não definido');
  });

  it('Personalização conta os caracteres das Regras globais contra o limite, com separador de milhar', () => {
    expect(personalizationState('')).toBe('0 / 8.000 caracteres');
    expect(personalizationState('a'.repeat(1024))).toBe('1.024 / 8.000 caracteres');
  });

  it('Personalização antepõe o "Como te chamar" ao tamanho das regras quando há nome; sem nome (vazio) ou com as preferências ainda não lidas (null) fica só o tamanho', () => {
    expect(personalizationState('a'.repeat(1024), 'Marco')).toBe('Marco · 1.024 / 8.000 caracteres');
    expect(personalizationState('', 'Ana Clara')).toBe('Ana Clara · 0 / 8.000 caracteres');
    expect(personalizationState('a'.repeat(1024), '')).toBe('1.024 / 8.000 caracteres');
    expect(personalizationState('a'.repeat(1024), null)).toBe('1.024 / 8.000 caracteres');
    expect(personalizationState(null, 'Marco')).toBeNull(); // sem as regras lidas a linha fica sem estado: o nome sozinho não diz o que a área guarda
  });

  it('Notificações: ativa (inclusive renovando o token) é "Ativadas"; qualquer outro estado é "Desativadas"; ainda lendo não diz nada', () => {
    expect(notificationsState('active')).toBe('Ativadas neste aparelho');
    expect(notificationsState('syncing')).toBe('Ativadas neste aparelho');
    for (const status of ['off', 'denied', 'unsupported', 'unconfigured', 'error', 'enabling']) expect(notificationsState(status), status).toBe('Desativadas neste aparelho');
    expect(notificationsState('loading')).toBeNull();
  });

  it('Atividade e arquivos mostra o armazenamento usado contra o limite', () => {
    expect(storageState({ usedBytes: 212 * 1048576, maxBytes: 1073741824 })).toBe('212 MB de 1 GB');
    expect(storageState({ usedBytes: 0, maxBytes: 1073741824 })).toBe('0 KB de 1 GB');
  });

  it('Conta e segurança diz se o autenticador está ativo', () => {
    expect(accountState(true)).toBe('Autenticador ativo');
    expect(accountState(false)).toBe('Autenticador desativado');
  });

  it('uma leitura que não chegou ou falhou (null) deixa a linha daquela área sem estado, nunca um texto inventado', () => {
    expect(connectionsState(null)).toBeNull();
    expect(preferencesState(null, { model: 'opencode/glm-5.1' })).toBeNull(); // sem as preferências gerais
    expect(preferencesState(settings, null)).toBeNull(); // sem o modelo do Chat geral
    expect(personalizationState(null)).toBeNull();
    expect(personalizationState(null, 'Marco')).toBeNull();
    expect(storageState(null)).toBeNull();
    expect(accountState(null)).toBeNull();
  });
});

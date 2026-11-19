// Ponto de entrada de @aion/shared: contratos usados por web, api e core.
// Primeiro: precisa rodar antes de qualquer schema ser criado.
import './zod-runtime';

export * from './activities';
export * from './approvals';
export * from './auth';
export * from './errors';
export * from './security-headers';
export * from './bots';
export * from './chat';
export * from './contrast';
export * from './conversation';
export * from './credentials';
export * from './docs';
export * from './connector-accounts';
export * from './live-state';
export * from './memory';
export * from './models';
export * from './push';
export * from './routines';
export * from './settings';
export * from './presence';
export * from './totp';
export * from './attachments';
export * from './tables';
export * from './table-import';

export * from './context-window';
export * from './context-status';
export * from './objectives';

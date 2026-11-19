// Prova do filtro do ruído do antivírus no console do E2E (E21): só o erro de CORS de um XHR a `*.kaspersky-labs.com` é ignorado; o mesmo
// erro vindo de outra origem (e qualquer outra mensagem) continua contando como problema. O módulo fica em `e2e/support` (é o `watchPage`
// que o usa) e o teste aqui em `src/lib` porque o Vitest do web só enxerga `src/**`.
import { describe, expect, it } from 'vitest';
import { isAntivirusNoise } from '../../e2e/support/console-noise';

/** Monta a mensagem de CORS que o Chromium registra quando o preflight de um XHR é recusado. */
const corsError = (url: string, origin = 'http://127.0.0.1:3100') =>
  `Access to XMLHttpRequest at '${url}' from origin '${origin}' has been blocked by CORS policy: Request header field x-e2e-client-ip is not allowed by Access-Control-Allow-Headers in preflight response.`;

describe('ruído do antivírus no console do E2E', () => {
  it('aceita o erro de CORS de um subdomínio de kaspersky-labs.com, em http ou https e com porta', () => {
    expect(isAntivirusNoise(corsError('http://gc.kis.v2.scr.kaspersky-labs.com/FD126C42-EBFA-4E12-B309-BB3FDD723AC1/main.js'))).toBe(true);
    expect(isAntivirusNoise(corsError('https://gc.kis.v2.scr.kaspersky-labs.com/x'))).toBe(true);
    expect(isAntivirusNoise(corsError('https://gc.kis.v2.scr.kaspersky-labs.com:8443/x'))).toBe(true);
  });

  it('reprova o erro de CORS de qualquer outra origem', () => {
    expect(isAntivirusNoise(corsError('https://fcmregistrations.googleapis.com/v1/projects/aion/registrations'))).toBe(false);
    expect(isAntivirusNoise(corsError('https://api.example.com/'))).toBe(false);
    // Domínio parecido, mas de outro dono.
    expect(isAntivirusNoise(corsError('https://gc.kis.v2.scr.kaspersky-labs.com.evil.example/x'))).toBe(false);
    expect(isAntivirusNoise(corsError('https://notkaspersky-labs.com/x'))).toBe(false);
    expect(isAntivirusNoise(corsError('https://kaspersky-labs.com/x'))).toBe(false);
  });

  it('não se deixa enganar por um host que carrega o domínio do antivírus na query, no fragmento ou no usuário da URL', () => {
    expect(isAntivirusNoise(corsError('https://evil.example?x=.kaspersky-labs.com/y'))).toBe(false);
    expect(isAntivirusNoise(corsError('https://evil.example#.kaspersky-labs.com/y'))).toBe(false);
    expect(isAntivirusNoise(corsError('https://gc.kaspersky-labs.com@evil.example/y'))).toBe(false);
    expect(isAntivirusNoise(corsError('https://evil.example/.kaspersky-labs.com/y'))).toBe(false);
  });

  it('só trata o CORS: outra mensagem, mesmo citando o domínio do antivírus, continua sendo problema', () => {
    expect(isAntivirusNoise("Access to fetch at 'https://gc.kis.v2.scr.kaspersky-labs.com/x' from origin 'http://127.0.0.1:3100' has been blocked by CORS policy")).toBe(false);
    expect(isAntivirusNoise('TypeError: Cannot read properties of undefined (reading gc.kis.v2.scr.kaspersky-labs.com)')).toBe(false);
    expect(isAntivirusNoise('')).toBe(false);
  });
});

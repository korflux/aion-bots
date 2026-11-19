// Prova do rótulo de dispositivo mostrado em Conta → Sessões.
import { describe, expect, it } from 'vitest';
import { describeDevice } from './device';

describe('rótulo do dispositivo', () => {
  it('distingue navegador e sistema, tratando os User-Agents que se disfarçam de Chrome/Safari', () => {
    const cases: [string, string][] = [
      ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36', 'Chrome no Windows'],
      ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 Edg/126.0', 'Edge no Windows'],
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0', 'Firefox no macOS'],
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15', 'Safari no macOS'],
      ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile Safari/604.1', 'Safari no iOS'],
      ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36', 'Chrome no Android'],
      ['curl/8.5.0', 'Dispositivo desconhecido'],
      ['', 'Dispositivo desconhecido'],
    ];
    for (const [userAgent, expected] of cases) expect(describeDevice(userAgent)).toBe(expected);
  });
});

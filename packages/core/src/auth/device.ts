// Rótulo legível do dispositivo (navegador + sistema) a partir do User-Agent, para a lista de sessões em Conta.
// Heurística simples de propósito: só precisa distinguir dispositivos para o dono, não identificar versões.

/** Ex.: "Chrome no Windows". Cai em "Dispositivo desconhecido" se nada for reconhecido. */
export function describeDevice(userAgent: string): string {
  const browser = detectBrowser(userAgent);
  const os = detectOs(userAgent);
  if (browser && os) return `${browser} no ${os}`;
  return browser ?? os ?? 'Dispositivo desconhecido';
}

// A ordem importa: Edge e Opera também dizem "Chrome"; o Chrome também diz "Safari".
function detectBrowser(ua: string): string | null {
  if (/Edg(e|A|iOS)?\//.test(ua)) return 'Edge';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'Firefox';
  if (/Chrome\/|CriOS\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return 'Safari';
  return null;
}

// iPhone/iPad também dizem "Mac OS X", então iOS vem antes de macOS.
function detectOs(ua: string): string | null {
  if (/Windows NT/.test(ua)) return 'Windows';
  if (/Android/.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
  if (/Linux|X11/.test(ua)) return 'Linux';
  return null;
}

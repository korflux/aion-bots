// Ajuste de runtime do Zod para o navegador. DEVE ser o primeiro import de @aion/shared (ver index.ts): os
// schemas são criados quando os módulos carregam, e é nesse momento que o Zod decide se usa JIT.
//
// O Zod 4 detecta se pode compilar validadores com `Function("")` dentro de um try/catch. Sob a nossa CSP
// (sem 'unsafe-eval', de propósito) a chamada é bloqueada e o navegador registra uma violação `script-src: eval`
// a cada carga, mesmo com o erro capturado. No navegador desligamos o JIT (validação um pouco mais lenta, sem
// impacto para os payloads pequenos da interface); no Node (api, worker, SSR) o JIT segue ligado.
import { z } from 'zod';

// `window` só existe no navegador (o pacote não carrega os tipos de DOM, por isso a leitura via globalThis).
if ('window' in globalThis) z.config({ jitless: true });

// Extensões de tipos do Fastify usadas pelos hooks de segurança da API.
import type { AuthContext } from '@aion/core';

declare module 'fastify' {
  interface FastifyRequest {
    /** Sessão autenticada da requisição; `null` em rotas públicas ou antes do hook de autenticação. */
    auth: AuthContext | null;
  }

  interface FastifyContextConfig {
    /** Categoria semântica das tabelas: POST também pode ser leitura; confirmação possui cota adicional. */
    tableRate?: 'read' | 'write' | 'destructive';
    /** Somente download autorizado de JPEG pode usar cache privado. */
    attachmentContent?: boolean;
    /** Mapeia limites de corpo da rota binária para o erro público de anexo. */
    attachmentUpload?: boolean;
    /**
     * Rotas são PROTEGIDAS POR PADRÃO (negação por padrão). Só login e saúde declaram `public: true`;
     * esquecer a marca significa exigir sessão, nunca abrir uma rota por engano.
     */
    public?: boolean;
  }
}

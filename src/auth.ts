import type { FastifyRequest } from 'fastify';

export interface AuthResult {
  authorized: boolean;
  clientId?: string;
  reason?: string;
}

export interface Authenticator {
  authenticate(req: FastifyRequest): Promise<AuthResult>;
}

/**
 * STUB authenticator — the interface is the point. It authorizes any request that
 * carries a non-empty `authorization` header. Replace with real token/credential
 * validation (introspection, signature check, etc.) without touching the server.
 */
export function createStubAuthenticator(): Authenticator {
  return {
    async authenticate(req) {
      const header = req.headers.authorization;
      if (typeof header === 'string' && header.trim() !== '') {
        return { authorized: true, clientId: 'stub-client' };
      }
      return { authorized: false, reason: 'missing_credentials' };
    },
  };
}

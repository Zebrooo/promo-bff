import { SERVICE_TICKET_HEADER, ServiceTicketError, verifyServiceTicket } from '@zebrooo/service-ticket';
import type { Authenticator } from './auth';

/**
 * Authenticator that validates an Ed25519 service ticket (TVM-style) from the
 * `X-Service-Ticket` header. The caller's service id (`src`) becomes the clientId.
 */
export function createTicketAuthenticator(opts: {
  publicKey: string;
  expectedDst: string;
  allowedSrc?: string[];
}): Authenticator {
  return {
    async authenticate(req) {
      const raw = req.headers[SERVICE_TICKET_HEADER];
      const ticket = Array.isArray(raw) ? raw[0] : raw;
      if (!ticket) return { authorized: false, reason: 'missing_service_ticket' };
      try {
        const payload = verifyServiceTicket(ticket, opts);
        return { authorized: true, clientId: payload.src };
      } catch (err) {
        return {
          authorized: false,
          reason: err instanceof ServiceTicketError ? err.message : 'invalid_service_ticket',
        };
      }
    },
  };
}

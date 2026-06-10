import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { generateKeyPair, issueServiceTicket } from '@zebrooo/service-ticket';
import { createTicketAuthenticator } from './auth-ticket';

const { publicKey, privateKey } = generateKeyPair();
const auth = createTicketAuthenticator({ publicKey, expectedDst: 'promo-bff', allowedSrc: ['abkhaz-auto'] });

const reqWith = (ticket?: string) =>
  ({ headers: ticket ? { 'x-service-ticket': ticket } : {} }) as unknown as FastifyRequest;

describe('ticket authenticator', () => {
  it('authorizes a valid ticket and exposes src as clientId', async () => {
    const t = issueServiceTicket({ src: 'abkhaz-auto', dst: 'promo-bff', privateKey });
    expect(await auth.authenticate(reqWith(t))).toMatchObject({ authorized: true, clientId: 'abkhaz-auto' });
  });

  it('rejects a missing ticket', async () => {
    expect(await auth.authenticate(reqWith())).toMatchObject({ authorized: false, reason: 'missing_service_ticket' });
  });

  it('rejects a ticket addressed to another service', async () => {
    const t = issueServiceTicket({ src: 'abkhaz-auto', dst: 'other', privateKey });
    expect(await auth.authenticate(reqWith(t))).toMatchObject({ authorized: false });
  });

  it('rejects a ticket from a disallowed src', async () => {
    const t = issueServiceTicket({ src: 'stranger', dst: 'promo-bff', privateKey });
    expect(await auth.authenticate(reqWith(t))).toMatchObject({ authorized: false });
  });
});

import { ProxyAgent, fetch as undiciFetch } from 'undici';

const proxyUrl = (process.env.OPENROUTER_PROXY ?? '').trim();

let proxyAgent: ProxyAgent | undefined;

function getProxyAgent(): ProxyAgent {
  proxyAgent ??= new ProxyAgent(proxyUrl);
  return proxyAgent;
}

/**
 * Dedicated OpenRouter transport. The npm undici fetch and ProxyAgent must be
 * used together; Node's bundled global fetch cannot accept this dispatcher.
 */
export const openrouterFetch: typeof fetch = (input, init) => {
  if (!proxyUrl) return fetch(input, init);

  return undiciFetch(input as Parameters<typeof undiciFetch>[0], {
    ...(init as Parameters<typeof undiciFetch>[1]),
    dispatcher: getProxyAgent(),
  }) as unknown as Promise<Response>;
};

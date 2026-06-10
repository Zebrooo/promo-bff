/**
 * Minimal OpenRouter chat-completions client. Wraps a single fetch call so the
 * BFF can ask any OpenRouter-routed model to rewrite a draft promo. Same shape
 * as the other src/services/* clients: factory captures config + an injectable
 * fetch (so tests don't hit the real API), one method returns text + token
 * counts + a RUB cost estimate.
 *
 * Pricing comes from config (USD per 1M tokens in/out + USD→RUB). The defaults
 * are placeholders; verify on openrouter.ai/<model> before relying on the cost
 * numbers stored in the log. Pricing mistakes never break code — only the
 * recorded RUB amount.
 */
import { config as appConfig, type OpenrouterConfig } from '../config';

export interface OpenrouterCallParams {
  /** System prompt — instructions / role for the model. */
  system: string;
  /** User prompt — the content to process. */
  user: string;
  /** Override the default model id (e.g. 'anthropic/claude-3-haiku'). */
  model?: string;
  /** Cap output tokens. */
  maxTokens?: number;
  /** Sampling temperature (0..1). */
  temperature?: number;
}

export interface OpenrouterCallResult {
  /** Assistant content from choices[0].message.content. */
  text: string;
  /** Prompt tokens (response.usage.prompt_tokens; 0 if absent). */
  tokensIn: number;
  /** Completion tokens (response.usage.completion_tokens; 0 if absent). */
  tokensOut: number;
  /** Estimated cost in RUB (decimal). Rounded to 4 dp. */
  costRub: number;
  /** Model id that actually served the call (response.model, or the request id). */
  model: string;
}

export interface OpenrouterClient {
  call(params: OpenrouterCallParams): Promise<OpenrouterCallResult>;
}

export interface OpenrouterClientOverrides {
  /** Override individual config fields (apiKey, model, prices, timeoutMs, …). */
  config?: Partial<OpenrouterConfig>;
  /** Injected fetch — tests pass a vi.fn(), prod gets the global. */
  fetchImpl?: typeof fetch;
  /** Optional HTTP-Referer header (OpenRouter shows it on leaderboards). */
  referer?: string;
  /** Optional X-Title header (app name on leaderboards). */
  appTitle?: string;
}

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export function createOpenrouterClient(overrides: OpenrouterClientOverrides = {}): OpenrouterClient {
  const cfg: OpenrouterConfig = { ...appConfig.openrouter, ...overrides.config };
  const fetchImpl = overrides.fetchImpl ?? fetch;
  const referer = overrides.referer;
  const appTitle = overrides.appTitle;

  return {
    async call(params) {
      if (!cfg.apiKey) {
        throw new Error('openrouter: OPENROUTER_API_KEY is not configured');
      }
      const model = params.model ?? cfg.defaultModel;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      };
      if (referer) headers['HTTP-Referer'] = referer;
      if (appTitle) headers['X-Title'] = appTitle;

      const body = JSON.stringify({
        model,
        messages: [
          { role: 'system', content: params.system },
          { role: 'user', content: params.user },
        ],
        ...(params.maxTokens !== undefined ? { max_tokens: params.maxTokens } : {}),
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      let resp: Response;
      try {
        resp = await fetchImpl(ENDPOINT, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        const name = (err as { name?: string } | null)?.name;
        if (name === 'AbortError') {
          throw new Error(`openrouter: timed out after ${cfg.timeoutMs}ms`);
        }
        throw err;
      }
      clearTimeout(timer);

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`openrouter: ${resp.status} ${resp.statusText}: ${text.slice(0, 200)}`);
      }

      const json = (await resp.json()) as {
        model?: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        choices?: Array<{ message?: { content?: string } }>;
      };

      const text = json.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || text.length === 0) {
        throw new Error('openrouter: empty response (no choices[0].message.content)');
      }
      const tokensIn = json.usage?.prompt_tokens ?? 0;
      const tokensOut = json.usage?.completion_tokens ?? 0;
      const usdCost =
        (tokensIn / 1_000_000) * cfg.pricePerMillionIn +
        (tokensOut / 1_000_000) * cfg.pricePerMillionOut;
      const costRub = usdCost * cfg.usdRub;

      return {
        text,
        tokensIn,
        tokensOut,
        // Round to 4dp — sub-kopeck precision, but still readable in the log.
        costRub: Math.round(costRub * 10000) / 10000,
        model: json.model ?? model,
      };
    },
  };
}

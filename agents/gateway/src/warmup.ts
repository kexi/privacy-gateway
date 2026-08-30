/**
 * Waking the GPU on purpose.
 *
 * `/v1/status` deliberately never touches Gemma, so there has to be one explicit
 * way to start it — a button the user presses knowing what it does, rather than
 * a side effect of looking at a badge.
 *
 * **This costs money.** A Cloud Run GPU instance is billed for as long as it
 * stays resident, which is roughly fifteen idle minutes after the last request.
 * Warming up before a demo saves the audience a two-minute wait; warming up and
 * walking away bills an idle L4. Nothing here shuts the instance down: min-scale
 * stays at zero and the instance idles out on its own.
 *
 * The request sent is the cheapest one that exists on the OpenAI-compatible
 * surface: `GET /models` lists the served model ids. Why not a one-token
 * completion, which would also warm the model weights: it spends inference
 * budget and can be refused by a model still loading, so a wake-up would report
 * failure while succeeding. Container start is the multi-minute part; a listing
 * is enough to trigger it.
 */

import { authorizedHeaders, gemmaAuthMode, type GemmaAuthMode } from '@privacy-gateway/common';

export interface WarmupOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly auth?: GemmaAuthMode | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  /**
   * How long to let the wake request run before dropping it.
   *
   * The caller is answered `{started: true}` immediately either way — this only
   * bounds how long the dangling request occupies a socket. It is deliberately
   * shorter than a cold start: the instance keeps booting after the client hangs
   * up, because Cloud Run started the container the moment the request arrived.
   */
  readonly timeoutMs?: number | undefined;
}

/**
 * Dispatch one authenticated wake request to Gemma.
 *
 * Resolves to whether the probe itself completed, which is *not* whether Gemma
 * is warm: a cold instance usually times out here while continuing to boot. The
 * caller does not wait on this — see the handler in `server.ts`.
 */
export async function wakeGemma(options: WarmupOptions): Promise<boolean> {
  const baseUrl = options.baseUrl.replace(/\/+$/u, '');
  const url = `${baseUrl}/models`;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const auth = gemmaAuthMode(baseUrl, options.auth);

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs ?? 30_000);
  timer.unref?.();

  try {
    // Cloud Run's Gemma service is IAM-protected, so the static key is not a
    // credential there: an ID token minted for the Gemma origin is. Same
    // derivation as the extractor and the judge use.
    const headers =
      auth === 'iam'
        ? await authorizedHeaders(url, { useIdToken: true })
        : { authorization: `Bearer ${options.apiKey}` };

    const response = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    // A timeout or transport failure is the expected outcome against a cold
    // instance, not an error worth surfacing: the container is starting either
    // way, which is the whole purpose of the call.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

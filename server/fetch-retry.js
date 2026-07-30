export const DEFAULT_RETRY_DELAYS_MS = [0, 500, 1500];

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function fetchWithRetry(url, options = {}, {
  fetchImpl = fetch,
  delays = DEFAULT_RETRY_DELAYS_MS,
  timeoutMs = 20_000,
  retryStatuses = [408, 425, 429, 500, 502, 503, 504],
} = {}) {
  let lastError;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) await wait(delays[attempt]);
    try {
      const response = await fetchImpl(url, {
        ...options,
        cache: options.cache || "no-store",
        signal: options.signal || AbortSignal.timeout(timeoutMs),
      });
      if (response.ok || !retryStatuses.includes(Number(response.status)) || attempt === delays.length - 1) return response;
      lastError = new Error(`Request failed (${response.status}).`);
    } catch (error) {
      lastError = error;
      if (attempt === delays.length - 1) throw error;
    }
  }
  throw lastError || new Error("Request failed.");
}

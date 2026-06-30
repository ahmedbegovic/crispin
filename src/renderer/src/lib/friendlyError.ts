/**
 * Map a raw engine/orchestrator error string to one plain, actionable sentence
 * for the chat error surfaces. The raw text is still kept in the store and the
 * main-process trace for debugging — this only changes what the user reads.
 * Already-friendly thrown messages (e.g. the RAM pre-flight warning) pass
 * through unchanged.
 */
export function friendlyError(raw: string): string {
  const e = raw.toLowerCase()
  if (/is not downloaded|not downloaded/.test(e))
    return "That model isn't downloaded yet — open the Models tab to download it."
  if (/econnrefused|fetch failed|connection refused|not running|no healthy|failed to spawn|enoent/.test(e))
    return "The model engine isn't running. Open the Models tab to start it."
  if (/did not become ready in time|failed to start|not registered/.test(e))
    return "The model engine couldn't start. Open the Models tab to check it (or view logs)."
  if (/out of memory|\boom\b|insufficient memory|cannot allocate/.test(e))
    return 'Ran out of memory for this model. Try a smaller model, or clear the KV cache and retry.'
  if (/timed out|timeout|inactivity|stalled/.test(e))
    return 'The model stopped responding (timed out). Try again.'
  if (/→\s*4\d\d|status 4\d\d/.test(e))
    return 'The engine rejected the request. Try again, or restart it from the Models tab.'
  if (/→\s*5\d\d|status 5\d\d|internal server error/.test(e))
    return 'The engine hit an error. Try again, or restart it from the Models tab.'
  return raw.length > 200 ? `${raw.slice(0, 199)}…` : raw
}

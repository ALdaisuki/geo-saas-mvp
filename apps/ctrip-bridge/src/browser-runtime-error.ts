export function isBrowserRuntimeUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = `${error.name}: ${error.message}`;
  return /Ctrip browser runtime unavailable|Ctrip account CDP operation (?:timed out after|did not respond within)|Ctrip account CDP connect(?: retry)? timed out after|Timed out after|timeout exceeded while waiting|Target page[^\n]*(?:closed|crashed)|(?:page|browser|context|frame)[^\n]*(?:closed|crashed|detached)|(?:browser|CDP|websocket|session)[^\n]*(?:disconnected|connection (?:closed|reset)|ended)|(?:ECONNRESET|ECONNREFUSED|ERR_CONNECTION_RESET|Target closed|Browser closed)/iu.test(
    message,
  );
}

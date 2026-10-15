export interface SseMessage {
  event: string | undefined;
  data: string;
}

/** Parses a text/event-stream body into discrete events. */
export async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseMessage> {
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];

  const dispatch = (): SseMessage | undefined => {
    const message = data.length ? { event, data: data.join("\n") } : undefined;
    event = undefined;
    data = [];
    return message;
  };

  const processLine = (line: string): SseMessage | undefined => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    return undefined;
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.search(/\r\n|\r|\n/)) !== -1) {
      if (buffer[newline] === "\r" && newline === buffer.length - 1) break;
      const line = buffer.slice(0, newline);
      const sepLength = buffer.startsWith("\r\n", newline) ? 2 : 1;
      buffer = buffer.slice(newline + sepLength);
      const message = processLine(line);
      if (message) yield message;
    }
  }
  buffer += decoder.decode();
  if (buffer) processLine(buffer);
  const last = dispatch();
  if (last) yield last;
}

export function formatSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

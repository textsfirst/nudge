/**
 * Minimal client for an OpenAI-compatible speech-to-text endpoint
 * (`POST {baseUrl}/audio/transcriptions`, multipart). Kept separate from the
 * reply model sources: the ChatGPT-subscription endpoint cannot transcribe,
 * so this is necessarily its own credential path.
 */
export interface TranscriptionOptions {
  apiKey: string;
  model: string;
  /** OpenAI-compatible API root; default https://api.openai.com/v1. */
  baseUrl?: string;
  timeoutMs?: number;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 30_000;

export class TranscriptionClient {
  readonly #options: TranscriptionOptions;

  constructor(options: TranscriptionOptions) {
    this.#options = options;
  }

  /** Returns the transcript text. Throws on transport or API errors. */
  async transcribe(audio: Buffer, input: { mimeType: string; name: string }): Promise<string> {
    const baseUrl = (this.#options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const doFetch = this.#options.fetchImpl ?? fetch;
    const form = new FormData();
    form.append("model", this.#options.model);
    form.append("file", new Blob([new Uint8Array(audio)], { type: input.mimeType }), input.name);
    form.append("response_format", "json");

    const response = await doFetch(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.#options.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 300);
      throw new Error(`Transcription failed (${response.status}): ${body}`);
    }
    const payload = (await response.json()) as { text?: unknown };
    if (typeof payload.text !== "string") {
      throw new Error("Transcription response had no text field");
    }
    return payload.text.trim();
  }
}

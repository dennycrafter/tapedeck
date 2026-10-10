/**
 * AI title cleanup (SPEC 8.4 step 2, 7.5) — the optional Anthropic pass on
 * top of the rule cleaner (8.4 step 1, lib/clean-title.ts).
 *
 * Contract rules this module implements exactly:
 *  - Request per SPEC 7.5: model `claude-haiku-5-5`, max_tokens 300,
 *    temperature 0, the 8.4 system prompt verbatim, and a user message that
 *    is the JSON of raw_title, raw_artist and the description excerpt.
 *  - The reply is a JSON object (SPEC 7.5: strip code fences before
 *    parsing); `parseAiReply` also unwraps a reply that arrives as a quoted
 *    JSON string, and accepts nothing else — the model never invents text
 *    into the library because every unusable reply yields null.
 *  - The confidence gate (8.4): the caller uses the AI title/artist only
 *    when `confidence >= 0.5` (AI_CONFIDENCE_GATE); a reply below the gate
 *    is discarded whole, `is_music` included.
 *  - Never fail an add because AI cleanup is unavailable (task rule): no
 *    key → null before any request; network, status, parse or validation
 *    failure → null after a logged warning. The caller keeps the rule result.
 */

import { cleanTitleRules } from './clean-title'
import type { TrackSource } from './parse-source-url'
import { httpJson } from './http'

export interface AiCleanupResult {
  title: string
  artist: string
  /** False for podcasts, interviews, tutorials — skips the cover lookup (8.4/8.5). */
  isMusic: boolean
  /** 0 to 1, how sure the model is that title and artist are correct. */
  confidence: number
}

/** SPEC 8.4: below this the rule result stays. */
export const AI_CONFIDENCE_GATE = 0.5

/** The 8.4 cleanup outcome stored with the track. */
export interface CleanOutcome {
  title: string
  artist: string
  /** True when the AI reply won; false for the rule cleaner. */
  aiCleaned: boolean
  aiConfidence: number | null
  /** The reply's is_music verdict; null when the AI was unavailable or unusable. */
  isMusic: boolean | null
}

/**
 * The 8.4 cleanup for one track: the AI reply's title and artist when it
 * says music with confidence at or above the gate, the rule cleaner
 * otherwise — the fallback also covers every AI failure mode (no key,
 * failed request, unusable reply), so an add never fails on cleanup.
 */
export async function cleanWithFallback(
  metadata: { rawTitle: string; rawArtist: string; description: string },
  key: string | undefined,
  source: TrackSource,
): Promise<CleanOutcome> {
  const reply = await aiCleanTitle(metadata, key)
  if (reply && reply.isMusic && reply.confidence >= AI_CONFIDENCE_GATE) {
    return { title: reply.title, artist: reply.artist, aiCleaned: true, aiConfidence: reply.confidence, isMusic: true }
  }
  const rules = cleanTitleRules(metadata.rawTitle, metadata.rawArtist, source)
  return {
    title: rules.title,
    artist: rules.artist,
    aiCleaned: false,
    aiConfidence: null,
    // A usable non-music verdict still gates the cover lookup even when the
    // confidence gate kept its title out.
    isMusic: reply ? reply.isMusic : null,
  }
}

/** SPEC 7.5 request constants. */
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_MODEL = 'claude-haiku-5-5'
const ANTHROPIC_MAX_TOKENS = 300
const ANTHROPIC_VERSION = '2023-06-01'

/** SPEC 8.4: "System prompt (use exactly)". */
const SYSTEM_PROMPT = `You clean music metadata for a personal music library. You get a raw video or track title, the uploader name and part of the description. Reply with only a JSON object, no other text:
{"title": string, "artist": string, "is_music": boolean, "confidence": number}
Rules:
- title is the song name only. Remove marketing words like Official Video, Official Audio, Lyrics, Visualizer, HD, 4K, MV.
- Keep real version info in the title in parentheses: (Remix), (X Remix), (Live), (Acoustic), (Sped Up), (Slowed), (Instrumental), (Extended Mix).
- Featured artists go at the end of the title as (feat. Name, Name).
- artist is the main artist or artists, joined with " & ". Uploader names ending in " - Topic" or "VEVO" are the artist without that suffix.
- If the uploader is a label or channel that is not the artist, take the artist from the title.
- is_music is false for podcasts, interviews, tutorials and anything that is not a song.
- confidence is 0 to 1: how sure you are that title and artist are correct.`

/** What the user message carries (SPEC 8.4 step 2: raw title, raw artist, first 300 chars of description). */
export interface AiCleanupInput {
  rawTitle: string
  rawArtist: string
  description: string
}

interface AnthropicMessagesResponse {
  content?: { type?: string; text?: string }[]
}

/**
 * Remove the ``` fences a model may wrap its JSON in (SPEC 7.5), plus any
 * prose around them. Code-fence lines are dropped wherever they appear;
 * other prose is left for the JSON scan below to cope with.
 */
export function stripCodeFences(text: string): string {
  const lines = text.split('\n').filter((line) => !/^\s*```/.test(line))
  return lines.join('\n').trim()
}

/** A trimmed non-empty string field. */
function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Parse and validate a model reply into an `AiCleanupResult`, or null when
 * the reply does not carry a fully-formed object. Validation is strict so a
 * half-answer (missing artist, empty title, non-numeric confidence) never
 * reaches the library: the caller falls back to the rule result instead.
 */
export function parseAiReply(text: string): AiCleanupResult | null {
  const cleaned = stripCodeFences(text)
  if (!cleaned) return null

  let candidate: unknown
  try {
    candidate = JSON.parse(cleaned)
  } catch {
    return null
  }
  // "no quotes": a reply wrapped one extra time as a JSON string unwraps once.
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate)
    } catch {
      return null
    }
  }
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return null
  const reply = candidate as Record<string, unknown>

  const title = cleanString(reply.title)
  const artist = cleanString(reply.artist)
  if (!title || !artist) return null
  if (typeof reply.is_music !== 'boolean') return null
  if (typeof reply.confidence !== 'number' || !Number.isFinite(reply.confidence)) return null
  const { confidence } = reply
  if (confidence < 0 || confidence > 1) return null

  return { title, artist, isMusic: reply.is_music, confidence }
}

/**
 * The 8.4 step-2 result, or null when AI cleanup is unavailable or its reply
 * is unusable. Resolves null — never throws — so the add pipeline can always
 * continue with the rule cleaner's result.
 */
export async function aiCleanTitle(
  input: AiCleanupInput,
  apiKey: string | undefined,
): Promise<AiCleanupResult | null> {
  if (!apiKey) return null

  let body: AnthropicMessagesResponse
  try {
    body = await httpJson<AnthropicMessagesResponse>(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: ANTHROPIC_MAX_TOKENS,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: JSON.stringify({
              raw_title: input.rawTitle,
              raw_artist: input.rawArtist,
              description: input.description,
            }),
          },
        ],
      }),
    })
  } catch (cause) {
    console.warn('[ai-clean] Anthropic request failed; keeping the rule-cleaner result:', cause)
    return null
  }

  const text = body.content?.find((part) => part.type === 'text')?.text
  if (!text) {
    console.warn('[ai-clean] Anthropic reply has no text content; keeping the rule-cleaner result')
    return null
  }
  const parsed = parseAiReply(text)
  if (!parsed) {
    console.warn('[ai-clean] Anthropic reply did not parse as a usable reply; keeping the rule-cleaner result')
  }
  return parsed
}

# WhatsApp Audio Summarizer Bot

Minimal Express server that listens to the WhatsApp Business Cloud API webhook, downloads forwarded voice notes, summarizes them with Google Gemini, and sends the recap back to the user.

## Prerequisites

1. WhatsApp Business Account (trial tier works for solo testing).
2. Meta Cloud API credentials:
   - Long-lived token (`META_WABA_TOKEN`)
   - Phone number ID (`META_PHONE_ID`)
   - Webhook verify token (`META_VERIFY_TOKEN`)
   - App secret (`META_APP_SECRET`)
3. Google Gemini API key (`AIzaSyDJGfsrKeGNKcUDAKdlmrOf_oRphjhvf84`).
4. Public HTTPS URL for webhook callbacks (ngrok, Cloud Run, etc.).
5. FFmpeg binary is bundled via `@ffmpeg-installer/ffmpeg`; no extra setup required.

## Quick Start

```bash
cd server
cp env.example .env    # fill in your secrets
npm install
npm run dev            # starts on http://localhost:3000
```

Expose the port via ngrok or similar and configure the callback URL inside the Meta App Dashboard (subscribe to `messages` events).

## Environment Variables

| Key | Description |
| --- | --- |
| `META_WABA_TOKEN` | Long-lived token for WhatsApp Business Cloud API calls. |
| `META_PHONE_ID` | Phone number ID from WhatsApp Manager. |
| `META_VERIFY_TOKEN` | Shared secret used during webhook verification. |
| `META_APP_SECRET` | App secret for signature validation (optional for now). |
| `META_GRAPH_VERSION` | Graph API version (defaults to `v19.0`). |
| `GEMINI_API_KEY` | Google Gemini API key. |
| `PORT` | Local port (defaults to `3000`). |
| `RATE_LIMIT_MS` | Minimum gap (ms) enforced between summaries per user (defaults to `15000`). |

## How It Works

1. **Webhook verification** — `GET /webhook` echoes Meta's challenge when the verify token matches.
2. **Message intake** — `POST /webhook` acknowledges immediately and processes messages in the background.
3. **Audio pipeline**:
   - Fetch the media metadata and download the voice note.
   - Convert OGG/Opus into mono 16 kHz MP3 via FFmpeg.
   - Summarize using Gemini 2.5 Flash (inline submission below 20 MB, Files API above).
4. **Reply** — Sends the summary back via Cloud API `/messages` endpoint with an opt-out notice.

## Compliance Helpers

- `/stop` opt-out persists the user to `data/opt-outs.json`.
- `/start` re-enables automation.
- `/human` alerts for manual follow-up (actual human routing to be completed on your side).
- Usage logs are appended to `data/usage.log` for audit trails.

## Production Checklist

- Publish an opt-in flow and privacy notice explaining that audio is sent to Google Gemini.
- Ensure you reply within Meta's 24-hour customer-care window or use approved templates.
- Monitor Gemini quota usage and catch failures gracefully (already returns a polite apology message).
- Adjust `RATE_LIMIT_MS` if you need a tighter/looser throttle window per user.
- Complete Facebook Business Verification once you want to lift the trial limits.

## Testing Notes

- Voice notes from the same account count against the trial quota, so limit unnecessary replays.
- For large audio clips (>20 MB) the Files API upload path is used automatically.
- If Gemini returns no text or errors, the user receives a fallback message and the incident is logged.


# Power Assistant - WhatsApp Audio Summarizer Bot

AI-powered WhatsApp bot that automatically summarizes voice notes using Google's Gemini API. Built for compliance with Meta's WhatsApp Business policies.

## 🎯 Overview

Power Assistant receives forwarded WhatsApp voice messages, processes them through Google Gemini 2.5 Flash, and returns concise text summaries. The bot operates within Meta's 24-hour customer care window and includes opt-in/opt-out functionality for GDPR compliance.

## 🏗️ Architecture

### Technology Stack

- **Runtime**: Node.js 22.x
- **Framework**: Express.js
- **Deployment**: Vercel (Serverless Functions)
- **AI Processing**: Google Gemini 2.5 Flash API
- **Messaging**: WhatsApp Business Cloud API (Graph API v19.0)
- **Audio Processing**: FFmpeg (via @ffmpeg-installer/ffmpeg)
- **Version Control**: GitHub

### Infrastructure

```
┌─────────────────┐
│   WhatsApp      │
│   User          │
└────────┬────────┘
         │ Voice Note
         ▼
┌─────────────────────────────────┐
│   Meta WhatsApp Cloud API       │
│   (Webhook Events)              │
└────────┬────────────────────────┘
         │ POST /webhook
         ▼
┌─────────────────────────────────┐
│   Vercel Serverless Function    │
│   - Express.js Server           │
│   - Webhook Handler             │
│   - Audio Pipeline              │
└────────┬────────────────────────┘
         │
         ├─────────────────┐
         │                 │
         ▼                 ▼
┌──────────────┐   ┌──────────────┐
│ Meta Graph   │   │ Google       │
│ API          │   │ Gemini API   │
│ (Download)   │   │ (Summarize)  │
└──────────────┘   └──────────────┘
```

### Data Flow

1. **Webhook Reception**: Meta sends audio message event to `/webhook`
2. **Media Retrieval**: Fetch audio file via Graph API media endpoint
3. **Audio Processing**: Convert OGG/Opus to mono 16kHz MP3 using FFmpeg
4. **AI Summarization**: 
   - Files <20MB: Inline base64 submission
   - Files >20MB: Resumable upload via Gemini Files API
5. **Response Delivery**: Send summary back via WhatsApp Cloud API

## 📁 Project Structure

```
power-assistant/
├── server/
│   ├── index.js           # Main Express server & webhook logic
│   ├── package.json       # Server dependencies
│   └── README.md          # Server-specific documentation
├── package.json           # Root package.json for Vercel
├── vercel.json            # Vercel deployment configuration
├── privacy.html           # Privacy policy (required by Meta)
├── .gitignore             # Git ignore rules
└── README.md              # This file
```

## 🚀 Deployment

### Vercel Configuration

The project uses Vercel's serverless functions with the following setup:

**vercel.json**:
```json
{
  "version": 2,
  "builds": [
    {
      "src": "server/index.js",
      "use": "@vercel/node"
    }
  ],
  "routes": [
    {
      "src": "/(.*)",
      "dest": "server/index.js"
    }
  ]
}
```

### Environment Variables

Required environment variables in Vercel:

| Variable | Description | Example |
|----------|-------------|---------|
| `META_WABA_TOKEN` | WhatsApp Business API long-lived token | `EAAx...` |
| `META_PHONE_ID` | WhatsApp phone number ID | `123456789` |
| `META_VERIFY_TOKEN` | Webhook verification token (you create this) | `my-secret-token` |
| `META_APP_SECRET` | Meta app secret from developer dashboard | `7b8ce...` |
| `META_APP_ID` | Meta app ID | `1749722...` |
| `GEMINI_API_KEY` | Google Gemini API key | `AIzaSy...` |
| `META_GRAPH_VERSION` | Graph API version | `v19.0` |
| `RATE_LIMIT_MS` | Rate limit window per user (ms) | `15000` |

### Deployment Process

1. **Push to GitHub**: Code pushed to `main` branch
2. **Auto-Deploy**: Vercel automatically builds and deploys
3. **Serverless Functions**: Express app runs as serverless function
4. **Environment Injection**: Vercel injects environment variables at runtime

## 🔧 Local Development

### Prerequisites

- Node.js 22.x or higher
- npm or yarn
- ngrok (for webhook testing)
- WhatsApp Business Account
- Google Gemini API key

### Setup

1. **Clone the repository**:
   ```bash
   git clone https://github.com/javierivero1337/power-assistant.git
   cd power-assistant
   ```

2. **Install dependencies**:
   ```bash
   cd server
   npm install
   ```

3. **Create `.env` file** (in `server/` directory):
   ```bash
   META_WABA_TOKEN=your_token_here
   META_PHONE_ID=your_phone_id
   META_VERIFY_TOKEN=your_verify_token
   META_APP_SECRET=your_app_secret
   META_APP_ID=your_app_id
   GEMINI_API_KEY=your_gemini_key
   META_GRAPH_VERSION=v19.0
   PORT=3000
   RATE_LIMIT_MS=15000
   ```

4. **Start the server**:
   ```bash
   npm run dev
   ```

5. **Expose with ngrok**:
   ```bash
   ngrok http 3000
   ```

6. **Configure webhook in Meta Dashboard**:
   - URL: `https://your-ngrok-url.ngrok-free.app/webhook`
   - Verify Token: (same as `META_VERIFY_TOKEN`)
   - Subscribe to: `messages`

## 📡 API Endpoints

### `GET /webhook`
Webhook verification endpoint for Meta.

**Query Parameters**:
- `hub.mode`: Should be "subscribe"
- `hub.verify_token`: Must match `META_VERIFY_TOKEN`
- `hub.challenge`: Echo this back to verify

### `POST /webhook`
Receives WhatsApp message events from Meta.

**Handles**:
- Audio messages (voice notes)
- Text commands: `START`, `STOP`, `HUMAN`

### `GET /health`
Health check endpoint.

**Response**: `{ "status": "ok" }`

## 🔐 Security & Compliance

### Meta WhatsApp Business Policies

- ✅ **Opt-in/Opt-out**: Users can send `STOP` to opt out, `START` to opt back in
- ✅ **24-hour window**: Only responds within customer care window
- ✅ **Human escalation**: `HUMAN` command for manual support
- ✅ **Privacy policy**: Published at `/privacy.html`
- ✅ **Data minimization**: Audio deleted immediately after processing
- ✅ **Audit logs**: Usage events logged to `data/usage.log`

### Data Handling

- **Audio files**: Stored temporarily during processing, deleted immediately after
- **Opt-out list**: Persisted to `data/opt-outs.json`
- **Usage logs**: Minimal metadata logged for compliance audits
- **No long-term storage**: Summaries not retained after delivery

### Rate Limiting

- Per-user rate limiting: 15 seconds between requests (configurable)
- In-memory tracking with automatic cleanup
- Prevents abuse and manages API costs

## 🤖 Bot Commands

| Command | Description |
|---------|-------------|
| `STOP` or `/stop` | Opt out of automated summaries |
| `START` or `/start` | Opt back in to automated summaries |
| `HUMAN` or `/human` | Request human support |

## 🧪 Testing

### Manual Testing Flow

1. Send a voice note to your WhatsApp Business number
2. Bot should respond with a summary within seconds
3. Test commands: `STOP`, `START`, `HUMAN`
4. Verify opt-out persists across messages

### Monitoring

- **Vercel Dashboard**: Monitor function invocations, errors, and logs
- **Meta Business Manager**: Track message volumes and API usage
- **Gemini API Console**: Monitor token usage and quotas

## 📊 Performance Considerations

### Gemini Token Usage

- **Audio tokenization**: ~32 tokens per second of audio
- **Example**: 1 minute audio = ~1,920 tokens
- **Max audio length**: 9.5 hours per request
- **Supported formats**: WAV, MP3, AIFF, AAC, OGG, FLAC

### Vercel Limits

- **Function timeout**: 10 seconds (Hobby), 60 seconds (Pro)
- **Function size**: 50 MB compressed
- **Concurrent executions**: Scales automatically
- **Cold starts**: ~1-2 seconds for first request

### Optimization

- Audio downsampled to 16 kHz mono for efficiency
- Files <20 MB sent inline (faster)
- Files >20 MB use resumable upload
- Temporary files cleaned up immediately

## 🐛 Troubleshooting

### Common Issues

**500 Error on Vercel**:
- Check environment variables are set in Vercel dashboard
- Verify all required variables are present
- Check function logs in Vercel dashboard

**Webhook verification fails**:
- Ensure `META_VERIFY_TOKEN` matches exactly
- Check server is running and accessible
- Verify ngrok URL is correct (for local dev)

**Audio processing fails**:
- FFmpeg is bundled, no manual install needed
- Check audio format is supported
- Verify file size is within limits

**Gemini API errors**:
- Check API key is valid
- Verify quota hasn't been exceeded
- Ensure audio format is supported

## 📝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit changes: `git commit -am 'Add new feature'`
4. Push to branch: `git push origin feature/my-feature`
5. Submit a pull request

## 📄 License

This project is private and proprietary.

## 👤 Contact

**Developer**: Javier Rivero  
**Email**: josejavier.re@gmail.com  
**Address**: Eva Briseño 792, Guadalajara, Jalisco, México

## 🔗 Resources

- [WhatsApp Business Cloud API Docs](https://developers.facebook.com/docs/whatsapp/cloud-api)
- [Google Gemini API Docs](https://ai.google.dev/gemini-api/docs)
- [Vercel Deployment Docs](https://vercel.com/docs)
- [Privacy Policy](https://power-assistant.vercel.app/privacy.html)

## 📈 Roadmap

- [ ] Add support for multiple languages
- [ ] Implement conversation context tracking
- [ ] Add custom prompt templates
- [ ] Support for video summarization
- [ ] Analytics dashboard
- [ ] Multi-agent support for team accounts

---

**Production URL**: https://power-assistant.vercel.app  
**Webhook URL**: https://power-assistant.vercel.app/webhook  
**GitHub**: https://github.com/javierivero1337/power-assistant


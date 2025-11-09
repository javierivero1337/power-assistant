"use strict";

const path = require("node:path");
const os = require("node:os");
const fs = require("fs-extra");
const express = require("express");
const morgan = require("morgan");
const axios = require("axios");
const dotenv = require("dotenv");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");

dotenv.config();
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const CONFIG = {
  port: Number(process.env.PORT) || 3000,
  graphVersion: process.env.META_GRAPH_VERSION || "v19.0",
  verifyToken: process.env.META_VERIFY_TOKEN,
  appSecret: process.env.META_APP_SECRET,
  wabaToken: process.env.META_WABA_TOKEN,
  phoneId: process.env.META_PHONE_ID,
  geminiKey: process.env.GEMINI_API_KEY,
  geminiModel: "gemini-2.5-flash"
};

const REQUIRED_CONFIG = [
  "verifyToken",
  "wabaToken",
  "phoneId",
  "geminiKey"
];

REQUIRED_CONFIG.forEach((key) => {
  if (!CONFIG[key]) {
    console.warn(`[config] Missing ${key}. Check your env configuration.`);
  }
});

const DATA_DIR = path.join(__dirname, "data");
const OPT_OUT_PATH = path.join(DATA_DIR, "opt-outs.json");
const USAGE_LOG_PATH = path.join(DATA_DIR, "usage.log");
const GEMINI_API_ROOT = "https://generativelanguage.googleapis.com";
const MAX_INLINE_BYTES = 20 * 1024 * 1024; // 20 MB
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_MS) || 15000;

const SUMMARY_PROMPT =
  "Summarize the key points from this WhatsApp voice message in two concise sentences. If the clip is not speech, describe any notable sounds.";

const app = express();
app.use(express.json());
app.use(morgan("combined"));

/**
 * Lazy in-memory opt-out store persisted to disk.
 */
class OptOutStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.items = new Set();
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    await fs.ensureDir(path.dirname(this.filePath));
    if (await fs.pathExists(this.filePath)) {
      try {
        const data = await fs.readJson(this.filePath);
        if (Array.isArray(data)) {
          data.forEach((item) => this.items.add(item));
        }
      } catch (err) {
        console.error("[optOut] Failed to read opt-out list:", err.message);
      }
    }
    this.initialized = true;
  }

  async save() {
    await fs.writeJson(this.filePath, Array.from(this.items), { spaces: 2 });
  }

  async add(phone) {
    await this.init();
    this.items.add(phone);
    await this.save();
  }

  async remove(phone) {
    await this.init();
    this.items.delete(phone);
    await this.save();
  }

  async has(phone) {
    await this.init();
    return this.items.has(phone);
  }
}

const optOutStore = new OptOutStore(OPT_OUT_PATH);
const recentRequests = new Map();

async function logUsage(event) {
  await fs.ensureDir(DATA_DIR);
  const payload = {
    timestamp: new Date().toISOString(),
    ...event
  };
  await fs.appendFile(USAGE_LOG_PATH, JSON.stringify(payload) + os.EOL);
}

function graphUrl(pathname) {
  return `https://graph.facebook.com/${CONFIG.graphVersion}/${pathname}`;
}

async function sendWhatsAppText(to, body) {
  const url = graphUrl(`${CONFIG.phoneId}/messages`);

  try {
    await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: {
          preview_url: false,
          body
        }
      },
      {
        headers: {
          Authorization: `Bearer ${CONFIG.wabaToken}`
        }
      }
    );
  } catch (err) {
    console.error("[whatsapp] Failed to send message:", extractError(err));
    throw err;
  }
}

async function fetchMediaMetadata(mediaId) {
  const url = graphUrl(`${mediaId}`);
  try {
    const response = await axios.get(url, {
      params: { fields: "id,mime_type,file_size,url" },
      headers: {
        Authorization: `Bearer ${CONFIG.wabaToken}`
      }
    });
    return response.data;
  } catch (err) {
    console.error("[whatsapp] Failed fetching media metadata:", extractError(err));
    throw err;
  }
}

async function downloadMediaFile(downloadUrl) {
  try {
    const response = await axios.get(downloadUrl, {
      responseType: "arraybuffer",
      headers: {
        Authorization: `Bearer ${CONFIG.wabaToken}`
      }
    });
    return Buffer.from(response.data);
  } catch (err) {
    console.error("[whatsapp] Failed downloading media file:", extractError(err));
    throw err;
  }
}

function normalizeMimeType(mime) {
  if (!mime) return null;
  return mime.split(";")[0].trim().toLowerCase();
}

function extensionFromMime(mime) {
  if (!mime) return ".bin";
  const map = {
    "audio/ogg": ".ogg",
    "audio/mp3": ".mp3",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav"
  };
  return map[mime] || ".bin";
}

async function convertToMp3IfNeeded(inputPath, mimeType) {
  if (mimeType === "audio/mpeg" || mimeType === "audio/mp3") {
    return { filePath: inputPath, mimeType };
  }

  const outputPath = `${inputPath}.mp3`;
  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioCodec("libmp3lame")
      .outputOptions(["-ac 1", "-ar 16000"])
      .format("mp3")
      .on("end", resolve)
      .on("error", reject)
      .save(outputPath);
  });

  return { filePath: outputPath, mimeType: "audio/mpeg" };
}

async function summarizeWithGemini(filePath, mimeType) {
  const stats = await fs.stat(filePath);
  const audioBuffer = await fs.readFile(filePath);
  const headers = {
    "Content-Type": "application/json",
    "x-goog-api-key": CONFIG.geminiKey
  };

  let contents;
  if (stats.size > MAX_INLINE_BYTES) {
    const uploadInfo = await startResumableUpload(audioBuffer, mimeType);
    contents = [
      {
        role: "user",
        parts: [
          { text: SUMMARY_PROMPT },
          {
            file_data: {
              mime_type: mimeType,
              file_uri: uploadInfo.fileUri
            }
          }
        ]
      }
    ];
  } else {
    const base64Data = audioBuffer.toString("base64");
    contents = [
      {
        role: "user",
        parts: [
          { text: SUMMARY_PROMPT },
          {
            inline_data: {
              mime_type: mimeType,
              data: base64Data
            }
          }
        ]
      }
    ];
  }

  try {
    const response = await axios.post(
      `${GEMINI_API_ROOT}/v1beta/models/${CONFIG.geminiModel}:generateContent`,
      { contents },
      { headers }
    );

    const text =
      response.data?.candidates?.[0]?.content?.parts
        ?.map((part) => part.text)
        .filter(Boolean)
        .join("\n")
        ?.trim() || null;

    return text;
  } catch (err) {
    console.error("[gemini] Summarization failed:", extractError(err));
    throw err;
  }
}

async function startResumableUpload(buffer, mimeType) {
  const initHeaders = {
    "x-goog-api-key": CONFIG.geminiKey,
    "X-Goog-Upload-Command": "start",
    "X-Goog-Upload-Protocol": "resumable",
    "X-Goog-Upload-Header-Content-Length": buffer.length.toString(),
    "X-Goog-Upload-Header-Content-Type": mimeType,
    "Content-Type": "application/json"
  };

  const startResponse = await axios.post(
    `${GEMINI_API_ROOT}/upload/v1beta/files`,
    { file: { display_name: `whatsapp-audio-${Date.now()}` } },
    { headers: initHeaders }
  );

  const uploadUrl = startResponse.headers["x-goog-upload-url"];
  if (!uploadUrl) {
    throw new Error("Gemini upload URL missing from response.");
  }

  const finishHeaders = {
    "x-goog-api-key": CONFIG.geminiKey,
    "Content-Length": buffer.length.toString(),
    "X-Goog-Upload-Offset": 0,
    "X-Goog-Upload-Command": "upload, finalize",
    "Content-Type": mimeType
  };

  const fileResponse = await axios.post(uploadUrl, buffer, {
    headers: finishHeaders
  });

  const fileUri = fileResponse.data?.file?.uri;
  if (!fileUri) {
    throw new Error("Gemini file URI missing after upload.");
  }

  return { fileUri };
}

async function handleAudioMessage(from, message) {
  if (await optOutStore.has(from)) {
    console.log(`[audio] Ignoring ${from} (opted out).`);
    return;
  }

  const mediaId = message.audio?.id;
  if (!mediaId) {
    console.warn("[audio] Missing media id on message");
    return;
  }

  const now = Date.now();
  const lastTime = recentRequests.get(from) || 0;
  if (now - lastTime < RATE_LIMIT_WINDOW_MS) {
    await sendWhatsAppText(
      from,
      "I’m still working on your previous request. Please wait a few seconds before sending another voice note."
    );
    await logUsage({ event: "rate_limited", from, mediaId });
    return;
  }

  recentRequests.set(from, now);

  let tempDir;

  try {
    await logUsage({ event: "audio_received", from, mediaId });

    const metadata = await fetchMediaMetadata(mediaId);
    if (!metadata?.url) {
      throw new Error("Media download URL not available.");
    }

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-audio-"));
    const normalizedMime = normalizeMimeType(metadata.mime_type);
    const inputPath = path.join(
      tempDir,
      `input${extensionFromMime(normalizedMime)}`
    );

    const audioBuffer = await downloadMediaFile(metadata.url);
    await fs.writeFile(inputPath, audioBuffer);

    const { filePath: mp3Path, mimeType } = await convertToMp3IfNeeded(
      inputPath,
      normalizedMime
    );

    const summary = await summarizeWithGemini(mp3Path, mimeType);

    const messageBody = summary
      ? `Here is the summary of that voice note:\n\n${summary}\n\nGenerated automatically with Google Gemini. Reply STOP to opt out.`
      : "I could not understand the voice note well enough to summarize it. Please try again or type HUMAN to reach support.";

    await sendWhatsAppText(from, messageBody);
    await logUsage({ event: "summary_sent", from, mediaId, success: !!summary });
  } catch (err) {
    console.error("[audio] Processing failed:", extractError(err));
    await sendWhatsAppText(
      from,
      "Sorry, I couldn’t summarize that audio clip. Please try again later or reply HUMAN for assistance."
    ).catch((sendErr) => {
      console.error("[audio] Failed sending error notification:", extractError(sendErr));
    });
    await logUsage({
      event: "summary_failed",
      from,
      mediaId,
      error: extractError(err)
    });
  } finally {
    if (tempDir) {
      await fs.remove(tempDir).catch(() => {});
    }
    const stamp = Date.now();
    recentRequests.set(from, stamp);
    setTimeout(() => {
      if (recentRequests.get(from) === stamp) {
        recentRequests.delete(from);
      }
    }, RATE_LIMIT_WINDOW_MS * 2);
  }
}

async function handleTextMessage(from, message) {
  const body = (message.text?.body || "").trim();
  const normalized = body.toLowerCase();

  if (!body) return;

  if (normalized === "stop" || normalized === "/stop") {
    await optOutStore.add(from);
    await sendWhatsAppText(
      from,
      "You have opted out of summaries. Reply START if you want to resume automated processing."
    );
    await logUsage({ event: "opt_out", from });
    return;
  }

  if (normalized === "start" || normalized === "/start") {
    await optOutStore.remove(from);
    await sendWhatsAppText(
      from,
      "You are back in! Forward a voice message and I’ll send a quick summary."
    );
    await logUsage({ event: "opt_in", from });
    return;
  }

  if (normalized === "human" || normalized === "/human") {
    await sendWhatsAppText(
      from,
      "Thanks for your message. A human teammate will follow up shortly."
    );
    await logUsage({ event: "human_requested", from });
    return;
  }

  await sendWhatsAppText(
    from,
    "Send me a WhatsApp voice note (or forward one) and I’ll reply with a short summary. Reply STOP to opt out."
  );
}

async function processWebhookPayload(payload) {
  if (!payload?.entry) return;

  for (const entry of payload.entry) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const messages = value.messages || [];

      for (const message of messages) {
        const from = message.from;
        if (!from) continue;

        if (message.type === "audio") {
          await handleAudioMessage(from, message);
        } else if (message.type === "text") {
          await handleTextMessage(from, message);
        }
      }
    }
  }
}

function extractError(err) {
  if (!err) return "unknown error";
  if (err.response) {
    const data = err.response.data;
    return JSON.stringify(
      {
        status: err.response.status,
        statusText: err.response.statusText,
        data
      },
      null,
      2
    );
  }
  return err.message || String(err);
}

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const verifyToken = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && verifyToken === CONFIG.verifyToken) {
    console.log("[webhook] Verification successful");
    return res.status(200).send(challenge);
  }

  console.warn("[webhook] Verification failed");
  return res.sendStatus(403);
});

app.post("/webhook", (req, res) => {
  res.sendStatus(200);

  setImmediate(() => {
    processWebhookPayload(req.body).catch((err) => {
      console.error("[webhook] Processing error:", extractError(err));
    });
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

async function bootstrap() {
  await fs.ensureDir(DATA_DIR);
  await optOutStore.init();
}

// Initialize on module load
bootstrap().catch((err) => {
  console.error("[server] Startup failed:", err);
});

// For local development
if (require.main === module) {
  app.listen(CONFIG.port, () => {
    console.log(`[server] Listening on port ${CONFIG.port}`);
  });
}

// Export for Vercel serverless
module.exports = app;


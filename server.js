import { createRequire } from "node:module";
import {
  mkdirSync
} from "node:fs";
import {
  dirname,
  resolve
} from "node:path";
import {
  fileURLToPath
} from "node:url";

const projectRoot = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(projectRoot, "node-backend/package.json"));
require("dotenv").config({
  path: resolve(projectRoot, ".env")
});

const express = require("express");
const cors = require("cors");
const { OAuth2Client } = require("google-auth-library");
const multer = require("multer");
const Database = require("better-sqlite3");
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";

const app = express();
const port = Number(process.env.PORT || 3000);
const bucketName = process.env.R2_BUCKET || "personal";
const maxFileSize = 90 * 1024 * 1024;
const allowedVideoTypes = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/ogg",
  "video/x-matroska"
]);
const allowedImageTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif"
]);

const databasePath = resolve(projectRoot, process.env.DATABASE_PATH || "../openframe-data/openframe.sqlite");
mkdirSync(dirname(databasePath), {
  recursive: true
});
const database = new Database(databasePath);
database.pragma("journal_mode = WAL");
database.pragma("foreign_keys = ON");
database.exec(`
  CREATE TABLE IF NOT EXISTS likes (
    media_id TEXT NOT NULL,
    visitor_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (media_id, visitor_id)
  );
  CREATE INDEX IF NOT EXISTS likes_media_id_idx ON likes (media_id);
`);

const googleClientId = process.env.GOOGLE_CLIENT_ID || "";
const googleAuthClient = googleClientId ? new OAuth2Client(googleClientId) : null;
if (!googleClientId) {
  console.warn("Google sign-in is disabled until GOOGLE_CLIENT_ID is configured.");
}

const requiredR2Environment = ["R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
const missingR2Environment = requiredR2Environment.filter((name) => !process.env[name]);
if (missingR2Environment.length) {
  console.warn(`R2 storage is disabled until these environment variables are set: ${missingR2Environment.join(", ")}`);
}

const r2 = missingR2Environment.length === 0 ?
  new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  }) :
  null;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxFileSize
  }
});

app.use(cors());
app.use(express.json({
  limit: "20kb"
}));
app.use(express.static(projectRoot));

function safeText(value, fallback, maxLength) {
  const text = String(value || "").trim().slice(0, maxLength);
  return text || fallback;
}

function extensionFor(type, name) {
  const fromName = String(name || "").match(/\.([a-z0-9]+)$/i);
  if (fromName) return fromName[1].toLowerCase();
  if (type === "image/jpeg") return "jpg";
  if (type === "video/quicktime") return "mov";
  return type.split("/")[1].replace("quicktime", "mov");
}

function requireR2(response) {
  if (r2) return true;
  response.status(503).json({
    error: "Cloudflare R2 storage is not configured on this server yet."
  });
  return false;
}

function validLikeInput(mediaId, visitorId) {
  return typeof mediaId === "string" && mediaId.trim().length > 0 && mediaId.length <= 220 &&
    typeof visitorId === "string" && /^[a-f0-9-]{36}$/i.test(visitorId);
}

const getLikeCount = database.prepare("SELECT COUNT(*) AS count FROM likes WHERE media_id = ?");
const hasVisitorLiked = database.prepare("SELECT 1 FROM likes WHERE media_id = ? AND visitor_id = ?");
const addLike = database.prepare("INSERT INTO likes (media_id, visitor_id) VALUES (?, ?)");
const removeLike = database.prepare("DELETE FROM likes WHERE media_id = ? AND visitor_id = ?");

app.get("/api/auth/config", (request, response) => {
  response.json({
    googleClientId: googleClientId || null
  });
});

app.post("/api/auth/google", async (request, response) => {
  if (!googleAuthClient) {
    return response.status(503).json({
      error: "Google sign-in is not configured yet."
    });
  }

  const credential = request.body?.credential;
  if (typeof credential !== "string" || !credential) {
    return response.status(400).json({
      error: "A Google sign-in credential is required."
    });
  }

  try {
    const ticket = await googleAuthClient.verifyIdToken({
      idToken: credential,
      audience: googleClientId
    });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email_verified) {
      return response.status(401).json({
        error: "Use a verified Google account to continue."
      });
    }

    response.json({
      name: payload.name || payload.email || "Google user",
      email: payload.email || "",
      picture: payload.picture || "" // FIXED: Ab backend profile picture bhi return karega
    });
  } catch (error) {
    response.status(401).json({
      error: "Google sign-in could not be verified. Please try again."
    });
  }
});

async function requireGoogleAuth(request, response, next) {
  if (!googleAuthClient) {
    return response.status(503).json({
      error: "Google sign-in is not configured on this server yet."
    });
  }

  const authorization = request.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return response.status(401).json({
      error: "Sign in with Google before uploading."
    });
  }

  try {
    const ticket = await googleAuthClient.verifyIdToken({
      idToken: match[1],
      audience: googleClientId
    });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email_verified) {
      return response.status(401).json({
        error: "Use a verified Google account before uploading."
      });
    }
    request.googleUser = payload;
    next();
  } catch (error) {
    response.status(401).json({
      error: "Your Google sign-in expired. Sign in again to upload."
    });
  }
}

app.get("/api/likes", (request, response) => {
  const {
    mediaId,
    visitorId
  } = request.query;
  if (!validLikeInput(mediaId, visitorId)) {
    return response.status(400).json({
      error: "A valid media ID and visitor ID are required."
    });
  }
  response.json({
    mediaId,
    count: getLikeCount.get(mediaId).count,
    liked: Boolean(hasVisitorLiked.get(mediaId, visitorId))
  });
});

app.post("/api/likes", (request, response) => {
  const {
    mediaId,
    visitorId
  } = request.body || {};
  if (!validLikeInput(mediaId, visitorId)) {
    return response.status(400).json({
      error: "A valid media ID and visitor ID are required."
    });
  }
  try {
    const toggleLike = database.transaction(() => {
      const alreadyLiked = Boolean(hasVisitorLiked.get(mediaId, visitorId));
      if (alreadyLiked) removeLike.run(mediaId, visitorId);
      else addLike.run(mediaId, visitorId);
      return !alreadyLiked;
    });
    const liked = toggleLike.immediate();
    response.json({
      mediaId,
      count: getLikeCount.get(mediaId).count,
      liked
    });
  } catch (error) {
    console.error("Could not update like:", error);
    response.status(500).json({
      error: "Could not update the like. Please try again."
    });
  }
});

async function listMedia(prefix) {
  const listed = await r2.send(new ListObjectsV2Command({
    Bucket: bucketName,
    Prefix: `${prefix}/`,
    MaxKeys: 1000
  }));
  return Promise.all((listed.Contents || []).map(async (object) => {
    let metadata = {};
    try {
      const stored = await r2.send(new HeadObjectCommand({
        Bucket: bucketName,
        Key: object.Key
      }));
      metadata = stored.Metadata || {};
    } catch (error) {
      console.warn(`Could not read metadata for ${object.Key}:`, error.message);
    }
    return {
      key: object.Key,
      type: metadata.kind || (prefix === "photos" ? "photo" : "video"),
      title: metadata.title || object.Key.split("/").pop(),
      creator: metadata.creator || "Anonymous creator",
      creatorEmail: metadata.creatoremail || "",
      creatorPic: metadata.creatorpic || "", // FIXED: Metadata se Profile Pic fetch karega
      uploadedAt: metadata.uploadedat || object.LastModified?.toISOString() || new Date().toISOString(),
      url: `/media/${encodeURIComponent(object.Key)}`
    };
  }));
}

app.get("/api/media", async (request, response) => {
  if (!requireR2(response)) return;
  try {
    const [videos, photos] = await Promise.all([listMedia("videos"), listMedia("photos")]);
    response.json([...videos, ...photos].sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)));
  } catch (error) {
    console.error("Could not list media:", error);
    response.status(500).json({
      error: "Could not load the public wall."
    });
  }
});

// Retain the original videos endpoint for older clients.
app.get("/api/videos", async (request, response) => {
  if (!requireR2(response)) return;
  try {
    response.json((await listMedia("videos")).sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)));
  } catch (error) {
    console.error("Could not list videos:", error);
    response.status(500).json({
      error: "Could not load videos."
    });
  }
});

app.post("/api/upload", requireGoogleAuth, upload.fields([{
    name: "media",
    maxCount: 1
  },
  {
    name: "video",
    maxCount: 1
  }
]), async (request, response) => {
  if (!requireR2(response)) return;
  try {
    const file = request.files?.media?.[0] || request.files?.video?.[0];
    if (!file) return response.status(400).json({
      error: "Choose a photo or video before publishing."
    });

    const isPhoto = allowedImageTypes.has(file.mimetype);
    const isVideo = allowedVideoTypes.has(file.mimetype);
    if (!isPhoto && !isVideo) {
      return response.status(415).json({
        error: "This photo or video format is not supported."
      });
    }

    const id = `${Date.now()}-${crypto.randomUUID()}`;
    const folder = isPhoto ? "photos" : "videos";
    const key = `${folder}/${id}.${extensionFor(file.mimetype, file.originalname)}`;
    const title = safeText(request.body.title, file.originalname.replace(/\.[^/.]+$/, ""), 120);
    const creator = safeText(request.body.creator, "Anonymous creator", 80);
    
    // FIXED: Frontend se email aur profile pic receive kar raha hai
    const creatorEmail = safeText(request.body.creatorEmail, "", 120);
    const creatorPic = safeText(request.body.creatorPic, "", 500);
    
    const uploadedAt = new Date().toISOString();

    await r2.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      Metadata: {
        kind: isPhoto ? "photo" : "video",
        title,
        creator,
        creatoremail: creatorEmail, // FIXED: Cloudflare R2 mein save kar raha hai
        creatorpic: creatorPic,     // FIXED: Cloudflare R2 mein save kar raha hai
        uploadedat: uploadedAt
      }
    }));

    response.status(201).json({
      key,
      type: isPhoto ? "photo" : "video",
      title,
      creator,
      creatorPic, // FIXED: Response mein wapas bhej raha hai
      uploadedAt,
      url: `/media/${encodeURIComponent(key)}`
    });
  } catch (error) {
    console.error("Media upload failed:", error);
    response.status(500).json({
      error: "Upload could not be completed. Please try again."
    });
  }
});

app.get("/media/:encodedKey", async (request, response) => {
  if (!requireR2(response)) return;
  const key = decodeURIComponent(request.params.encodedKey);
  if (!key.startsWith("videos/") && !key.startsWith("photos/")) {
    return response.status(404).send("Not found");
  }
  try {
    const object = await r2.send(new GetObjectCommand({
      Bucket: bucketName,
      Key: key
    }));
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    if (object.ContentType) response.setHeader("Content-Type", object.ContentType);
    object.Body.pipe(response);
  } catch (error) {
    console.error("Media request failed:", error);
    response.status(404).send("Not found");
  }
});

// If no real SAD.jpg has been added yet, keep the featured-image slot visible.
// A real SAD.jpg in the project root is served by express.static before this route.
app.get("/SAD.jpg", (request, response) => {
  response.type("image/svg+xml").send(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 1125">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#321329" />
          <stop offset=".52" stop-color="#a72e71" />
          <stop offset="1" stop-color="#f3a5ca" />
        </linearGradient>
        <linearGradient id="hill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#27151f" />
          <stop offset="1" stop-color="#100d12" />
        </linearGradient>
        <filter id="blur"><feGaussianBlur stdDeviation="36" /></filter>
      </defs>
      <rect width="900" height="1125" fill="url(#sky)" />
      <circle cx="664" cy="316" r="145" fill="#ffd8e9" opacity=".76" filter="url(#blur)" />
      <circle cx="664" cy="316" r="90" fill="#ffe9f2" opacity=".9" />
      <path d="M0 632 Q158 512 326 636 T667 594 T900 616 V1125 H0Z" fill="#541e43" opacity=".78" />
      <path d="M0 754 Q222 591 424 757 T900 701 V1125 H0Z" fill="url(#hill)" />
      <path d="M0 900 Q214 824 425 900 T900 870 V1125 H0Z" fill="#100d12" />
      <path d="M450 1125 Q485 1011 445 907 Q419 837 442 774" fill="none" stroke="#f7bdd9" stroke-width="5" opacity=".48" />
      <text x="64" y="1032" fill="#fff7fb" font-family="Arial, sans-serif" font-size="25" letter-spacing="8" opacity=".82">A MOMENT ON THE WALL</text>
    </svg>
  `);
});

app.use((error, request, response, next) => {
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    return response.status(413).json({
      error: "Photos and videos must be 90 MB or smaller."
    });
  }
  console.error("Unexpected server error:", error);
  response.status(500).json({
    error: "Unexpected server error."
  });
});

app.listen(port, () => {
  console.log(`Reels Book is running on port ${port}`);
  console.log(`Likes database: ${databasePath}`);
});

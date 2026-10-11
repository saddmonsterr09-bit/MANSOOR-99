import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
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
const allowedTypes = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/ogg",
  "video/x-matroska"
]);

const requiredEnvironment = [
  "R2_ENDPOINT",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY"
];

const missingEnvironment = requiredEnvironment.filter((name) => !process.env[name]);
if (missingEnvironment.length > 0) {
  console.warn(`Missing environment variables: ${missingEnvironment.join(", ")}`);
}

const r2 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "missing",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "missing"
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxFileSize
  }
});

app.use(cors());
app.use(express.static("."));

function safeText(value, fallback, maxLength) {
  const text = String(value || "").trim().slice(0, maxLength);
  return text || fallback;
}

function extensionFor(type, name) {
  const fromName = String(name || "").match(/\.([a-z0-9]+)$/i);
  if (fromName) return fromName[1].toLowerCase();
  return type.split("/")[1].replace("quicktime", "mov");
}

function publicVideo(object, metadata = {}) {
  return {
    key: object.Key,
    title: metadata.title || object.Key.split("/").pop(),
    creator: metadata.creator || "Anonymous creator",
    uploadedAt: metadata.uploadedAt || object.LastModified?.toISOString() || new Date().toISOString(),
    url: `/media/${encodeURIComponent(object.Key)}`
  };
}

app.get("/api/videos", async (request, response) => {
  try {
    const listed = await r2.send(new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: "videos/",
      MaxKeys: 1000
    }));

    const videos = await Promise.all((listed.Contents || []).map(async (object) => {
      try {
        const stored = await r2.send(new HeadObjectCommand({
          Bucket: bucketName,
          Key: object.Key
        }));
        return publicVideo(object, stored.Metadata);
      } catch {
        return publicVideo(object);
      }
    }));

    videos.sort((first, second) => new Date(second.uploadedAt) - new Date(first.uploadedAt));
    response.json(videos);
  } catch (error) {
    console.error("Could not list videos:", error);
    response.status(500).json({
      error: "Could not load the public wall."
    });
  }
});

app.post("/api/upload", upload.single("video"), async (request, response) => {
  try {
    const file = request.file;
    if (!file) {
      return response.status(400).json({
        error: "A video file is required."
      });
    }
    if (!allowedTypes.has(file.mimetype)) {
      return response.status(415).json({
        error: "This video format is not supported."
      });
    }

    const id = `${Date.now()}-${crypto.randomUUID()}`;
    const key = `videos/${id}.${extensionFor(file.mimetype, file.originalname)}`;
    const title = safeText(
      request.body.title,
      file.originalname.replace(/\.[^/.]+$/, ""),
      120
    );
    const creator = safeText(request.body.creator, "Anonymous creator", 80);
    const uploadedAt = new Date().toISOString();

    await r2.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      Metadata: {
        title,
        creator,
        uploadedAt
      }
    }));

    response.status(201).json({
      key,
      title,
      creator,
      uploadedAt,
      url: `/media/${encodeURIComponent(key)}`
    });
  } catch (error) {
    console.error("Upload failed:", error);
    response.status(500).json({
      error: "The upload could not be completed."
    });
  }
});

app.get("/media/:encodedKey", async (request, response) => {
  const key = decodeURIComponent(request.params.encodedKey);
  if (!key.startsWith("videos/")) {
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

app.use((error, request, response, next) => {
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    return response.status(413).json({
      error: "Videos must be 90 MB or smaller."
    });
  }
  console.error("Unexpected server error:", error);
  response.status(500).json({
    error: "Unexpected server error."
  });
});

app.listen(port, () => {
  console.log(`Openframe is running on port ${port}`);
});
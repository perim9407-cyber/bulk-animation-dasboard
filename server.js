
const express = require("express");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");

const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;

// Batas dashboard: 200 MiB.
const MAX_FILE_SIZE = 200 * 1024 * 1024;

// Batas resmi Roblox Assets API untuk upload konten.
const ROBLOX_MAX_FILE_SIZE = 20 * 1024 * 1024;

// Health check Railway.
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Proteksi dashboard dan seluruh endpoint selain health check.
app.use((req, res, next) => {
  if (!DASHBOARD_PASSWORD) {
    return res.status(503).send(
      "DASHBOARD_PASSWORD belum diatur di Railway Variables."
    );
  }

  res.setHeader("Cache-Control", "no-store");

  const header = req.headers.authorization || "";

  if (!header.startsWith("Basic ")) {
    res.setHeader(
      "WWW-Authenticate",
      'Basic realm="Bulk Animation Dashboard", charset="UTF-8"'
    );
    return res.status(401).send("Login diperlukan.");
  }

  let credentials;

  try {
    credentials = Buffer.from(
      header.slice(6),
      "base64"
    ).toString("utf8");
  } catch {
    return res.status(401).send("Login tidak valid.");
  }

  const separator = credentials.indexOf(":");
  const username =
    separator >= 0 ? credentials.slice(0, separator) : "";
  const password =
    separator >= 0 ? credentials.slice(separator + 1) : "";

  const expected = Buffer.from(DASHBOARD_PASSWORD);
  const supplied = Buffer.from(password);

  const validPassword =
    expected.length === supplied.length &&
    crypto.timingSafeEqual(expected, supplied);

  if (username !== "admin" || !validPassword) {
    res.setHeader(
      "WWW-Authenticate",
      'Basic realm="Bulk Animation Dashboard", charset="UTF-8"'
    );
    return res.status(401).send("Username atau password salah.");
  }

  next();
});

// Penyimpanan sementara di memori.
// Perhatian: upload 200 MB membutuhkan RAM yang cukup.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();

    if (ext !== ".rbxm" && ext !== ".rbxmx") {
      return cb(new Error("Gunakan file .rbxm atau .rbxmx."));
    }

    cb(null, true);
  }
});

// Dashboard frontend.
app.use(express.static(path.join(__dirname, "public")));

// Memindai ID animasi yang dapat ditemukan sebagai teks dalam file.
app.post("/api/scan-rbxm", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      error: "Pilih file RBXM atau RBXMX terlebih dahulu."
    });
  }

  const data = req.file.buffer.toString("latin1");
  const pattern = /rbxassetid:\/\/(\d{5,20})/gi;
  const ids = new Set();
  let match;

  while ((match = pattern.exec(data)) !== null) {
    ids.add(match[1]);
  }

  res.json({
    filename: req.file.originalname,
    sizeBytes: req.file.size,
    ids: [...ids],
    note: "Pemindaian teks saja; hasil mungkin tidak lengkap."
  });
});

// Mengunggah satu aset animasi baru ke Roblox.
app.post(
  "/api/upload-animation",
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          error: "Pilih file .rbxm atau .rbxmx."
        });
      }

      // Dashboard boleh menerima file 200 MB,
      // tetapi Roblox Assets API dibatasi 20 MB.
      if (req.file.size > ROBLOX_MAX_FILE_SIZE) {
        return res.status(413).json({
          error:
            "File diterima dashboard, tetapi tidak dikirim ke Roblox. " +
            "Batas Roblox Assets API adalah 20 MiB per upload.",
          fileSizeBytes: req.file.size,
          robloxMaxBytes: ROBLOX_MAX_FILE_SIZE
        });
      }

      if (!ROBLOX_API_KEY) {
        return res.status(503).json({
          error: "ROBLOX_API_KEY belum diatur di Railway."
        });
      }

      const displayName = String(
        req.body.displayName || ""
      ).trim();

      const description = String(
        req.body.description || ""
      ).trim();

      const creatorType = String(
        req.body.creatorType || "user"
      );

      if (!displayName || displayName.length > 50) {
        return res.status(400).json({
          error: "Nama wajib diisi dan maksimal 50 karakter."
        });
      }

      if (description.length > 1000) {
        return res.status(400).json({
          error: "Deskripsi maksimal 1000 karakter."
        });
      }

      const creator = {};

      if (creatorType === "user") {
        const userId = process.env.ROBLOX_USER_ID || "";

        if (!/^\d+$/.test(userId)) {
          return res.status(400).json({
            error: "ROBLOX_USER_ID belum benar di Railway."
          });
        }

        creator.userId = userId;
      } else if (creatorType === "group") {
        const groupId = process.env.ROBLOX_GROUP_ID || "";

        if (!/^\d+$/.test(groupId)) {
          return res.status(400).json({
            error: "ROBLOX_GROUP_ID belum benar di Railway."
          });
        }

        creator.groupId = groupId;
      } else {
        return res.status(400).json({
          error: "Creator harus user atau group."
        });
      }

      const requestData = {
        assetType: "Animation",
        displayName,
        description,
        creationContext: { creator }
      };

      const form = new FormData();

      form.append("request", JSON.stringify(requestData));

      const fileBlob = new Blob([req.file.buffer], {
        type: "model/x-rbxm"
      });

      form.append(
        "fileContent",
        fileBlob,
        path.basename(req.file.originalname)
      );

      const robloxResponse = await fetch(
        "https://apis.roblox.com/assets/v1/assets",
        {
          method: "POST",
          headers: {
            "x-api-key": ROBLOX_API_KEY
          },
          body: form
        }
      );

      const responseText = await robloxResponse.text();
      let result;

      try {
        result = JSON.parse(responseText);
      } catch {
        result = { message: responseText };
      }

      if (!robloxResponse.ok) {
        console.error(
          "Roblox upload error:",
          robloxResponse.status,
          JSON.stringify(result)
        );

        return res.status(
          robloxResponse.status >= 500 ? 502 : 400
        ).json({
          error:
            "Roblox menolak upload. Periksa izin API key, " +
            "creator, dan format file.",
          details: result
        });
      }

      const operationPath = result.path || "";
      const operationId = operationPath.split("/").pop();

      if (!operationId) {
        return res.status(202).json({
          message: "Permintaan diterima Roblox.",
          operation: result
        });
      }

      let operationResult = result;

      // Periksa status operasi maksimal 15 detik.
      for (let attempt = 0; attempt < 15; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000));

        const statusResponse = await fetch(
          "https://apis.roblox.com/assets/v1/operations/" +
            encodeURIComponent(operationId),
          {
            headers: {
              "x-api-key": ROBLOX_API_KEY
            }
          }
        );

        const statusText = await statusResponse.text();

        try {
          operationResult = JSON.parse(statusText);
        } catch {
          operationResult = { message: statusText };
        }

        if (!statusResponse.ok) break;
        if (operationResult.done === true) break;
      }

      const asset = operationResult.response || {};

      return res.status(200).json({
        message: operationResult.done
          ? "Proses upload selesai. Periksa status moderasi aset."
          : "Upload sedang diproses Roblox.",
        done: operationResult.done === true,
        assetId: asset.assetId || null,
        assetType: asset.assetType || null,
        moderationResult: asset.moderationResult || null,
        operation: operationResult
      });
    } catch (error) {
      console.error("Upload error:", error.message);

      return res.status(500).json({
        error: "Terjadi kesalahan saat memproses upload."
      });
    }
  }
);

// Penanganan error upload.
app.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      error: "Ukuran maksimum file dashboard adalah 200 MiB."
    });
  }

  console.error("Request error:", err.message);

  return res.status(400).json({
    error: err.message || "Permintaan gagal."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Dashboard berjalan pada port ${PORT}`);
});

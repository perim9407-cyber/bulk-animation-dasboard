
const express = require("express");
const multer = require("multer");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();

    if (ext !== ".rbxm" && ext !== ".rbxmx") {
      return cb(new Error("File harus berformat .rbxm atau .rbxmx"));
    }

    cb(null, true);
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/scan-rbxm", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      error: "Silakan pilih file RBXM atau RBXMX."
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
    ids: [...ids],
    note: "Pemindaian pola teks saja; hasil tidak dijamin lengkap."
  });
});

app.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      error: "Ukuran file maksimum 10 MB."
    });
  }

  res.status(400).json({
    error: err.message || "Permintaan gagal."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Dashboard berjalan pada port ${PORT}`);
});
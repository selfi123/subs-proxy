const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const Busboy = require('busboy');

const OPENSUBTITLES_API_KEY = 'qo2wQs1PXwIHJsXvIiWXu1ZbVjaboPh6';
const OPENSUBTITLES_BASE_URL = 'https://api.opensubtitles.com/api/v1';

// ===============================
// OpenSubtitles movie hash
// ===============================
function computeMovieHash(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const stats = fs.statSync(filePath);
  const fileSize = stats.size;

  const bufferSize = 65536; // 64 KB
  const buffer = Buffer.alloc(bufferSize * 2);

  fs.readSync(fd, buffer, 0, bufferSize, 0); // first 64KB
  fs.readSync(fd, buffer, bufferSize, bufferSize, fileSize - bufferSize); // last 64KB

  fs.closeSync(fd);

  let hash = BigInt(fileSize);
  for (let i = 0; i < buffer.length; i += 8) {
    hash += buffer.readBigUInt64LE(i);
  }

  return hash.toString(16).padStart(16, '0');
}

// ===============================
// HTTP helper
// ===============================
function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    https
      .request(url, options, (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () =>
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            json: () => JSON.parse(data),
            text: () => data
          })
        );
      })
      .on('error', reject)
      .end(options.body);
  });
}

// ===============================
// Vercel handler
// ===============================
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const busboy = Busboy({ headers: req.headers });
  let videoPath;

  busboy.on('file', (_, file, info) => {
    videoPath = `/tmp/${info.filename}`;
    file.pipe(fs.createWriteStream(videoPath));
  });

  busboy.on('finish', async () => {
    try {
      // 1️⃣ Compute movie hash
      const movieHash = computeMovieHash(videoPath);

      // 2️⃣ Search subtitles using movie hash
      const searchUrl =
        `${OPENSUBTITLES_BASE_URL}/subtitles?` +
        `moviehash=${movieHash}&` +
        `moviehash_match=only`;

      const response = await makeRequest(searchUrl, {
        headers: {
          'Api-Key': OPENSUBTITLES_API_KEY,
          'User-Agent': 'SubtitleSearchApp v1.0.0',
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        return res.status(500).json({ error: 'Subtitle search failed' });
      }

      const data = await response.json();

      res.json({
        moviehash: movieHash,
        total: data.data.length,
        subtitles: data.data
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      if (videoPath && fs.existsSync(videoPath)) {
        fs.unlinkSync(videoPath);
      }
    }
  });

  req.pipe(busboy);
};

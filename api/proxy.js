// ===============================
// OpenSubtitles + TMDB Proxy
// ===============================

const https = require('https');
const http = require('http');

// ===== CONFIG =====
const OPENSUBTITLES_API_KEY = 'qo2wQs1PXwIHJsXvIiWXu1ZbVjaboPh6';
const OPENSUBTITLES_BASE_URL = 'https://api.opensubtitles.com/api/v1';

const TMDB_API_KEY = '5dbb076a21a64be1dd6e0693a68091ab';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

// ===============================
// Generic HTTP request helper
// ===============================
function makeRequest(url, options = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error('Too many redirects'));
      return;
    }

    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? https : http;

    const req = protocol.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: options.method || 'GET',
        headers: options.headers || {}
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const nextUrl = res.headers.location.startsWith('http')
            ? res.headers.location
            : `${urlObj.protocol}//${urlObj.hostname}${res.headers.location}`;

          return makeRequest(nextUrl, options, redirectCount + 1)
            .then(resolve)
            .catch(reject);
        }

        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            text: async () => data,
            json: async () => JSON.parse(data)
          });
        });
      }
    );

    req.on('error', reject);

    if (options.body) req.write(options.body);
    req.end();
  });
}

// ===============================
// TMDB → IMDb resolver
// ===============================
async function resolveImdbId(title, year = null) {
  const params = new URLSearchParams({
    api_key: TMDB_API_KEY,
    query: title
  });

  if (year) params.append('year', year);

  const searchRes = await makeRequest(
    `${TMDB_BASE_URL}/search/movie?${params.toString()}`
  );
  if (!searchRes.ok) return null;

  const searchData = await searchRes.json();
  const movie = searchData.results?.[0];
  if (!movie) return null;

  const extRes = await makeRequest(
    `${TMDB_BASE_URL}/movie/${movie.id}/external_ids?api_key=${TMDB_API_KEY}`
  );
  if (!extRes.ok) return null;

  const extData = await extRes.json();
  return extData.imdb_id || null;
}

// ===============================
// Vercel handler
// ===============================
module.exports = async (req, res) => {
  // ---- CORS ----
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const path = req.url.split('?')[0];

    // ===============================
    // SEARCH SUBTITLES
    // ===============================
    if (path.includes('/subtitles')) {
      const { query, year, languages = 'en' } = req.query;

      if (!query) {
        return res.status(400).json({ error: 'query is required' });
      }

      // 🔑 Resolve IMDb automatically
      const imdbId = await resolveImdbId(query, year);

      const params = new URLSearchParams({
        languages,
        type: 'movie',
        order_by: 'downloads',
        order_direction: 'desc'
      });

      if (imdbId) {
        // OpenSubtitles wants IMDb WITHOUT "tt"
        params.append('imdb_id', imdbId.replace('tt', ''));
      } else {
        // fallback (rare)
        params.append('query', query);
      }

      const osUrl = `${OPENSUBTITLES_BASE_URL}/subtitles?${params.toString()}`;

      const response = await makeRequest(osUrl, {
        headers: {
          'Api-Key': OPENSUBTITLES_API_KEY,
          'Accept': 'application/json',
          'User-Agent': 'SubtitleSearchApp v1.0.0'
        }
      });

      if (!response.ok) {
        return res.status(response.status).json({
          error: 'OpenSubtitles search failed'
        });
      }

      const data = await response.json();
      return res.json({
        imdb_id: imdbId,
        total: data.data.length,
        data: data.data
      });
    }

    // ===============================
    // DOWNLOAD SUBTITLE
    // ===============================
    if (path.includes('/download')) {
      const { file_id } = req.body || {};

      if (!file_id) {
        return res.status(400).json({ error: 'file_id is required' });
      }

      const response = await makeRequest(
        `${OPENSUBTITLES_BASE_URL}/download`,
        {
          method: 'POST',
          headers: {
            'Api-Key': OPENSUBTITLES_API_KEY,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'SubtitleSearchApp v1.0.0'
          },
          body: JSON.stringify({ file_id })
        }
      );

      if (!response.ok) {
        return res.status(response.status).json({
          error: 'OpenSubtitles download failed'
        });
      }

      const data = await response.json();
      return res.json(data);
    }

    // ===============================
    // NOT FOUND
    // ===============================
    return res.status(404).json({ error: 'Endpoint not found' });
  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({ error: err.message });
  }
};

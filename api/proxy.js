// Vercel Serverless Function for OpenSubtitles API Proxy
// This handles the User-Agent header requirement that browsers can't set

const https = require('https');
const http = require('http');

const OPENTITLES_API_KEY = 'qo2wQs1PXwIHJsXvIiWXu1ZbVjaboPh6';
const OPENTITLES_BASE_URL = 'https://api.opensubtitles.com/api/v1';

// Helper function to make HTTP requests with redirect handling
function makeRequest(url, options = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    // Prevent infinite redirect loops
    if (redirectCount > 5) {
      reject(new Error('Too many redirects'));
      return;
    }

    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? https : http;
    
    const requestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const req = protocol.request(requestOptions, (res) => {
      // Handle redirects (301, 302, 307, 308)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location;
        console.log(`Following redirect ${res.statusCode} to: ${redirectUrl}`);
        
        // If redirect goes to HTML page (error), don't follow it
        if (redirectUrl.includes('.html') || redirectUrl.includes('/error')) {
          let errorData = '';
          res.on('data', (chunk) => { errorData += chunk; });
          res.on('end', () => {
            reject(new Error(`Redirect to error page: ${redirectUrl}. Response: ${errorData.substring(0, 200)}`));
          });
          return;
        }
        
        // Resolve relative URLs
        const newUrl = redirectUrl.startsWith('http') 
          ? redirectUrl 
          : `${urlObj.protocol}//${urlObj.hostname}${redirectUrl}`;
        
        // Preserve headers for redirect
        const redirectOptions = {
          ...options,
          headers: {
            ...options.headers
          }
        };
        
        // Recursively follow redirect
        return makeRequest(newUrl, redirectOptions, redirectCount + 1)
          .then(resolve)
          .catch(reject);
      }

      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        // Check if response is HTML (error page)
        const isHtml = data.trim().startsWith('<!DOCTYPE') || 
                       data.trim().startsWith('<html') || 
                       data.trim().startsWith('<meta') ||
                       data.includes('<html') ||
                       res.headers['content-type']?.includes('text/html');
        
        if (isHtml && res.statusCode >= 200 && res.statusCode < 300) {
          // API returned HTML instead of JSON - treat as error
          resolve({
            ok: false,
            status: 500,
            statusText: 'HTML Response',
            json: async () => {
              throw new Error(`API returned HTML instead of JSON: ${data.substring(0, 200)}`);
            },
            text: async () => data
          });
        } else {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            statusText: res.statusMessage,
            json: async () => {
              try {
                return JSON.parse(data);
              } catch (e) {
                throw new Error(`Invalid JSON response: ${data.substring(0, 200)}`);
              }
            },
            text: async () => data
          });
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    if (options.body) {
      req.write(options.body);
    }

    req.end();
  });
}

// Vercel serverless function handler
module.exports = async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const path = req.url.split('?')[0];
    
    if (path.includes('/subtitles')) {
      const {
        query,
        year,
        languages = 'en'
      } = req.query;
    
      if (!query) {
        return res.status(400).json({ error: 'query is required' });
      }
    
      const params = new URLSearchParams({
        query,
        type: 'movie',
        languages,
        order_by: 'moviehash_match',
        order_direction: 'desc',
        ...(year ? { year } : {})
      });
    
      const url = `${OPENTITLES_BASE_URL}/subtitles?${params.toString()}`;
    
      const response = await makeRequest(url, {
        method: 'GET',
        headers: {
          'Api-Key': OPENTITLES_API_KEY,
          'Accept': 'application/json',
          'User-Agent': 'SubtitleSearchApp v1.0.0'
        }
      });
    
      if (!response.ok) {
        return res.status(response.status).json({
          error: 'Subtitle search failed'
        });
      }
    
      const data = await response.json();
    
      // 🔐 FILTER WRONG MOVIES
      const safeResults = data.data.filter(sub => {
        const attr = sub.attributes;
        const titleMatch =
          attr.movie_name?.toLowerCase().includes(query.toLowerCase());
    
        const yearMatch =
          !year || Math.abs(attr.year - year) <= 1;
    
        return titleMatch && yearMatch;
      });
    
      return res.json({
        total: safeResults.length,
        data: safeResults
      });
    }
    
     else if (path.includes('/download')) {
      const { file_id } = req.body;
    
      if (!file_id) {
        return res.status(400).json({ error: 'file_id is required' });
      }
    
      const response = await makeRequest(
        `${OPENTITLES_BASE_URL}/download`,
        {
          method: 'POST',
          headers: {
            'Api-Key': OPENTITLES_API_KEY,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'SubtitleSearchApp v1.0.0'
          },
          body: JSON.stringify({ file_id })
        }
      );
    
      if (!response.ok) {
        return res.status(response.status).json({
          error: 'Subtitle download failed'
        });
      }
    
      const data = await response.json();
      return res.json(data);
    }
     else {
      return res.status(404).json({ error: 'Endpoint not found' });
    }
  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(500).json({ error: error.message });
  }
};

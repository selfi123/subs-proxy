
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
      // Search endpoint
      const queryParams = new URLSearchParams(req.query).toString();
      const url = `${OPENTITLES_BASE_URL}/subtitles?${queryParams}`;
      
      console.log('Proxying request to:', url);
      
      const response = await makeRequest(url, {
        method: 'GET',
        headers: {
          'Api-Key': OPENTITLES_API_KEY,
          'Accept': 'application/json',
          'User-Agent': 'SubtitleSearchApp v1.0.0'
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        return res.status(response.status).json({ 
          error: `API returned ${response.status}: ${response.statusText}`,
          details: errorText.substring(0, 200)
        });
      }

      const responseText = await response.text();
      
      // Check if response is HTML (error page) instead of JSON
      if (responseText.trim().startsWith('<!DOCTYPE') || 
          responseText.trim().startsWith('<html') || 
          responseText.trim().startsWith('<meta') ||
          responseText.includes('<html>')) {
        const titleMatch = responseText.match(/<title>(.*?)<\/title>/i);
        const errorTitle = titleMatch ? titleMatch[1] : 'Unknown error';
        
        return res.status(500).json({ 
          error: `API returned HTML error page: ${errorTitle}`,
          details: 'This usually means the language code is not supported or the request parameters are invalid.',
          suggestion: 'Try searching without a language filter, or use a different language code.'
        });
      }

      let data;
      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        return res.status(500).json({ 
          error: 'Invalid JSON response from API',
          details: parseError.message,
          responsePreview: responseText.substring(0, 300)
        });
      }

      return res.json(data);
      
    } else if (path.includes('/download')) {
      // Download endpoint
      const url = `${OPENTITLES_BASE_URL}/download`;
      
      const response = await makeRequest(url, {
        method: 'POST',
        headers: {
          'Api-Key': OPENTITLES_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'SubtitleSearchApp v1.0.0'
        },
        body: JSON.stringify(req.body)
      });

      if (!response.ok) {
        const errorText = await response.text();
        return res.status(response.status).json({ 
          error: `API returned ${response.status}: ${response.statusText}`,
          details: errorText.substring(0, 200)
        });
      }

      const responseText = await response.text();
      
      // Check if response is HTML
      if (responseText.trim().startsWith('<!DOCTYPE') || 
          responseText.trim().startsWith('<html') || 
          responseText.trim().startsWith('<meta')) {
        return res.status(500).json({ 
          error: 'API returned HTML error page instead of JSON'
        });
      }

      let data;
      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        return res.status(500).json({ 
          error: 'Invalid JSON response from API',
          details: parseError.message
        });
      }

      return res.json(data);
    } else {
      return res.status(404).json({ error: 'Endpoint not found' });
    }
  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(500).json({ error: error.message });
  }
};

const express = require('express');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const sanitize = require('sanitize-filename');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Allow at most 10 info lookups per IP per minute
const infoLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment before trying again.' },
});

// Allow at most 5 downloads per IP per minute
const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many download requests. Please wait a moment before trying again.',
});

// Validate that a string looks like a YouTube URL
function isValidYouTubeUrl(url) {
  try {
    const parsed = new URL(url);
    const validHosts = ['www.youtube.com', 'youtube.com', 'youtu.be', 'm.youtube.com'];
    return validHosts.includes(parsed.hostname);
  } catch {
    return false;
  }
}

// POST /api/info — fetch video title before download
app.post('/api/info', infoLimiter, (req, res) => {
  const { url } = req.body;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid URL.' });
  }

  if (!isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Only YouTube URLs are supported.' });
  }

  const infoArgs = [
    '--no-warnings',
    '--print', 'title',
    '--no-playlist',
    '--extractor-args', 'youtube:player_client=ios',
    url,
  ];

  execFile('yt-dlp', infoArgs, { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('yt-dlp info error:', stderr || err.message);
      return res.status(400).json({ error: 'Could not fetch video info. Please check the URL.' });
    }
    const title = stdout.trim();
    res.json({ title });
  });
});

// GET /api/download — stream the MP3 directly to the client
app.get('/api/download', downloadLimiter, (req, res) => {
  const { url } = req.query;

  if (!url || typeof url !== 'string') {
    return res.status(400).send('Missing or invalid URL.');
  }

  if (!isValidYouTubeUrl(url)) {
    return res.status(400).send('Only YouTube URLs are supported.');
  }

  // Create a unique temp directory for this request
  let tmpDir;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytmp3-'));
  } catch (mkdirErr) {
    console.error('Failed to create temp directory:', mkdirErr);
    return res.status(500).send('Server error: could not create temp directory.');
  }
  const outputTemplate = path.join(tmpDir, '%(title)s.%(ext)s');

  const ytDlpArgs = [
    '--no-warnings',
    '--no-playlist',
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', '0',
    '--extractor-args', 'youtube:player_client=ios',
    '-o', outputTemplate,
    '--print', 'after_move:filepath',
    url,
  ];

  execFile('yt-dlp', ytDlpArgs, { timeout: 120000 }, (err, stdout, stderr) => {
    if (err) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      console.error('yt-dlp error:', stderr);
      return res.status(500).send('Failed to download video. Please try again or check the URL.');
    }

    const filePath = stdout.trim();
    if (!filePath || !fs.existsSync(filePath)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return res.status(500).send('Download failed: output file not found.');
    }

    const rawTitle = path.basename(filePath, path.extname(filePath));
    const safeTitle = sanitize(rawTitle) || `audio-${Date.now()}`;
    const downloadName = `${safeTitle}.mp3`;

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);

    const readStream = fs.createReadStream(filePath);
    readStream.pipe(res);

    readStream.on('error', (streamErr) => {
      console.error('Stream error:', streamErr);
      if (!res.headersSent) {
        res.status(500).send('Error streaming file.');
      }
    });

    let cleaned = false;
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    res.on('finish', cleanup);
    res.on('close', cleanup);
  });
});

app.listen(PORT, () => {
  console.log(`YoutubeMP3 server running on port ${PORT}`);
});

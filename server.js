import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import multer from 'multer';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 10000;
const CLOUD_FREE_MODE = process.env.CLOUD_FREE_MODE === 'true';

const DATA_DIR = path.join('/tmp', 'voidsync_data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const CHAT_DIR = path.join(DATA_DIR, 'chat');
const HLS_DIR = path.join(DATA_DIR, 'hls');

[DATA_DIR, UPLOAD_DIR, CHAT_DIR, HLS_DIR].forEach(dir => {
    fs.mkdirSync(dir, { recursive: true });
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/hls', express.static(HLS_DIR));
app.use('/chat-files', express.static(CHAT_DIR));
app.use('/media-uploads', express.static(UPLOAD_DIR));

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

const maxMediaSize = CLOUD_FREE_MODE ? 150 * 1024 * 1024 : 5 * 1024 * 1024 * 1024;
const uploadMedia = multer({ dest: UPLOAD_DIR, limits: { fileSize: maxMediaSize } });
const uploadChat = multer({ dest: CHAT_DIR, limits: { fileSize: 100 * 1024 * 1024 } });

const mediaRegistry = new Map();
const rooms = new Map();

function uid(len = 8) {
    return crypto.randomBytes(len).toString('hex');
}

function getRoom(roomId) {
    if (!rooms.has(roomId)) {
        rooms.set(roomId, {
            id: roomId,
            hostId: null,
            clients: new Map(),
            media: {
                mode: 'idle',
                title: 'NO MEDIA LOADED',
                src: '',
                audioSrc: '',
                videoId: '',
                qualities: [],
                audioTracks: [],
                subtitles: [],
                isPlaying: false,
                baseTime: 0,
                updatedAt: Date.now(),
                playbackRate: 1.0,
                webrtcHostId: null,
                p2pHostId: null,
                p2pFile: null
            },
            queue: [],
            messages: [],
            bufferLock: false
        });
    }
    return rooms.get(roomId);
}

function broadcastRoom(room, payload, excludeId = null) {
    const raw = JSON.stringify(payload);
    for (const [cid, client] of room.clients.entries()) {
        if (cid !== excludeId && client.ws.readyState === 1) {
            client.ws.send(raw);
        }
    }
}

function getRoomUsersList(room) {
    const list = [];
    for (const [cid, c] of room.clients.entries()) {
        list.push({
            id: cid,
            nick: c.nick,
            isHost: room.hostId === cid,
            inVoice: c.inVoice,
            micMuted: c.micMuted,
            buffering: c.buffering
        });
    }
    return list;
}

function computeCurrentPosition(media) {
    if (!media.isPlaying) return media.baseTime;
    const elapsed = (Date.now() - media.updatedAt) / 1000;
    return Math.max(0, media.baseTime + elapsed * media.playbackRate);
}

function cleanupRoomIfEmpty(roomId) {
    const room = rooms.get(roomId);
    if (room && room.clients.size === 0) {
        rooms.delete(roomId);
    }
}

function registerMediaToken(url, headers = {}) {
    const token = uid(12);
    mediaRegistry.set(token, { url, headers, createdAt: Date.now() });
    if (mediaRegistry.size > 300) {
        const oldestKey = mediaRegistry.keys().next().value;
        mediaRegistry.delete(oldestKey);
    }
    return `/api/proxy/${token}`;
}

app.get('/api/proxy/:token', async (req, res) => {
    const entry = mediaRegistry.get(req.params.token);
    if (!entry) return res.status(404).end();

    try {
        const reqHeaders = { ...entry.headers };
        if (req.headers.range) reqHeaders['Range'] = req.headers.range;
        delete reqHeaders['host'];

        const upstream = await fetch(entry.url, { headers: reqHeaders });
        res.status(upstream.status);

        ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach(h => {
            const val = upstream.headers.get(h);
            if (val) res.setHeader(h, val);
        });
        res.setHeader('Access-Control-Allow-Origin', '*');

        if (!upstream.body) return res.end();
        const reader = upstream.body.getReader();
        req.on('close', () => reader.cancel().catch(() => {}));

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!res.write(value)) {
                await new Promise(resolve => res.once('drain', resolve));
            }
        }
        res.end();
    } catch {
        if (!res.headersSent) res.status(502).end();
        else res.end();
    }
});

function extractYouTubeId(url) {
    const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
}

async function searchYouTubeFast(query) {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const resp = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9'
        }
    });
    const html = await resp.text();
    const match = html.match(/var ytInitialData = (\{.*?\});<\/script>/);
    if (!match) return [];

    const data = JSON.parse(match[1]);
    const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
    const results = [];

    for (const section of contents) {
        const items = section?.itemSectionRenderer?.contents || [];
        for (const item of items) {
            const v = item.videoRenderer;
            if (!v || !v.videoId) continue;
            results.push({
                videoId: v.videoId,
                title: v.title?.runs?.map(r => r.text).join('') || 'YouTube Video',
                url: `https://www.youtube.com/watch?v=${v.videoId}`,
                duration: v.lengthText?.simpleText || 'LIVE',
                channel: v.ownerText?.runs?.[0]?.text || ''
            });
            if (results.length >= 15) return results;
        }
    }
    return results;
}

async function fetchYouTubePlaylistFast(listId) {
    const url = `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`;
    const resp = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9'
        }
    });
    const html = await resp.text();
    const match = html.match(/var ytInitialData = (\{.*?\});<\/script>/);
    if (!match) return [];
    const data = JSON.parse(match[1]);
    const tabs = data?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
    const contents = tabs[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer?.contents || [];
    const items = [];
    for (const c of contents) {
        const v = c.playlistVideoRenderer;
        if (v && v.videoId) {
            items.push({
                videoId: v.videoId,
                title: v.title?.runs?.map(r => r.text).join('') || v.videoId,
                url: `https://www.youtube.com/watch?v=${v.videoId}`
            });
        }
    }
    return items;
}

async function resolveSpotify(url) {
    const match = url.match(/open\.spotify\.com\/(track|playlist|album)\/([a-zA-Z0-9]+)/);
    if (!match) throw new Error('INVALID_SPOTIFY_URL');

    const [, kind, id] = match;
    const embedUrl = `https://open.spotify.com/embed/${kind}/${id}`;
    const resp = await fetch(embedUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36' }
    });
    const html = await resp.text();
    const jsonMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!jsonMatch) throw new Error('SPOTIFY_EXTRACT_FAILED');

    const data = JSON.parse(jsonMatch[1]);
    const entity = data?.props?.pageProps?.state?.data?.entity;
    if (!entity) throw new Error('SPOTIFY_ENTITY_EMPTY');

    let tracks = [];
    if (kind === 'track') {
        tracks.push({
            title: entity.name,
            artist: (entity.artists || []).map(a => a.name).join(', ')
        });
    } else if (Array.isArray(entity.trackList)) {
        tracks = entity.trackList.map(t => ({
            title: t.title,
            artist: t.subtitle || ''
        }));
    }

    if (tracks.length === 0) throw new Error('SPOTIFY_NO_TRACKS');
    return tracks;
}

async function extractWithYtDlp(targetUrl) {
    const { stdout } = await execFileAsync('yt-dlp', [
        '-J',
        '--no-playlist',
        '--no-warnings',
        targetUrl
    ], { maxBuffer: 15 * 1024 * 1024 });

    const info = JSON.parse(stdout);
    const title = info.title || 'External Media';
    const formats = info.formats || [];
    const reqHeaders = info.http_headers || {};

    const subList = [];
    if (info.subtitles) {
        for (const [lang, arr] of Object.entries(info.subtitles)) {
            const vtt = arr.find(s => s.ext === 'vtt');
            if (vtt) subList.push({ label: lang.toUpperCase(), url: registerMediaToken(vtt.url, reqHeaders) });
        }
    }

    const hlsFormats = formats.filter(f => f.protocol && f.protocol.includes('m3u8'));
    if (hlsFormats.length > 0 && !formats.some(f => f.vcodec !== 'none' && f.acodec === 'none' && f.height >= 1080)) {
        const bestHls = hlsFormats[hlsFormats.length - 1];
        return {
            mode: 'hls',
            title,
            src: registerMediaToken(bestHls.url, bestHls.http_headers || reqHeaders),
            audioSrc: '',
            qualities: [],
            audioTracks: [],
            subtitles: subList
        };
    }

    const combined = formats.filter(f => f.url && f.vcodec !== 'none' && f.acodec !== 'none');
    if (combined.length > 0) {
        combined.sort((a, b) => (b.height || 0) - (a.height || 0));
        const qualities = combined.map(c => ({
            label: `${c.height || 'Auto'}p`,
            url: registerMediaToken(c.url, c.http_headers || reqHeaders)
        }));
        return {
            mode: 'direct',
            title,
            src: qualities[0].url,
            audioSrc: '',
            qualities,
            audioTracks: [],
            subtitles: subList
        };
    }

    const videoOnly = formats.filter(f => f.url && f.vcodec !== 'none' && f.acodec === 'none' && !f.vcodec.startsWith('av01'));
    const audioOnly = formats.filter(f => f.url && f.vcodec === 'none' && f.acodec !== 'none');

    if (videoOnly.length > 0 && audioOnly.length > 0) {
        videoOnly.sort((a, b) => (b.height || 0) - (a.height || 0));
        audioOnly.sort((a, b) => (b.abr || 0) - (a.abr || 0));
        const qualities = videoOnly.slice(0, 6).map(v => ({
            label: `${v.height || 0}p`,
            url: registerMediaToken(v.url, v.http_headers || reqHeaders)
        }));
        const audioTracks = audioOnly.slice(0, 4).map((a, idx) => ({
            label: a.language || `Track ${idx + 1}`,
            url: registerMediaToken(a.url, a.http_headers || reqHeaders)
        }));
        return {
            mode: 'dual',
            title,
            src: qualities[0].url,
            audioSrc: audioTracks[0].url,
            qualities,
            audioTracks,
            subtitles: subList
        };
    }

    if (audioOnly.length > 0) {
        audioOnly.sort((a, b) => (b.abr || 0) - (a.abr || 0));
        return {
            mode: 'audio',
            title,
            src: registerMediaToken(audioOnly[0].url, audioOnly[0].http_headers || reqHeaders),
            audioSrc: '',
            qualities: [],
            audioTracks: [],
            subtitles: []
        };
    }

    throw new Error('NO_PLAYABLE_STREAMS');
}

async function probeMedia(inputPath) {
    try {
        const { stdout } = await execFileAsync('ffprobe', [
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_streams',
            inputPath
        ], { maxBuffer: 5 * 1024 * 1024 });
        return JSON.parse(stdout);
    } catch {
        return null;
    }
}

async function handleUploadedMedia(filePath, originalName) {
    const probe = await probeMedia(filePath);
    const streams = probe?.streams || [];
    const videoStreams = streams.filter(s => s.codec_type === 'video' && !['mjpeg', 'png', 'bmp'].includes(s.codec_name));
    const audioStreams = streams.filter(s => s.codec_type === 'audio');
    const subStreams = streams.filter(s => s.codec_type === 'subtitle' && ['subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'text'].includes(s.codec_name));

    if (videoStreams.length === 0 && audioStreams.length > 0) {
        return {
            mode: 'audio',
            title: originalName,
            src: `/media-uploads/${path.basename(filePath)}`,
            audioSrc: '',
            qualities: [],
            audioTracks: [],
            subtitles: []
        };
    }

    const ext = path.extname(originalName).toLowerCase();
    if ((ext === '.mp4' || ext === '.webm') && audioStreams.length <= 1 && subStreams.length === 0) {
        return {
            mode: 'direct',
            title: originalName,
            src: `/media-uploads/${path.basename(filePath)}`,
            audioSrc: '',
            qualities: [],
            audioTracks: [],
            subtitles: []
        };
    }

    const jobId = uid(8);
    const jobDir = path.join(HLS_DIR, jobId);
    fs.mkdirSync(jobDir, { recursive: true });

    const vCodec = (videoStreams[0]?.codec_name === 'h264') ? 'copy' : 'libx264';
    const args = ['-y', '-threads', '1', '-i', filePath];

    const subResults = [];
    for (let i = 0; i < subStreams.length; i++) {
        const subFile = `sub_${i}.vtt`;
        const label = subStreams[i].tags?.title || subStreams[i].tags?.language || `SUB ${i + 1}`;
        subResults.push({ label, url: `/hls/${jobId}/${subFile}` });
        args.push('-map', `0:${subStreams[i].index}`, '-c:s', 'webvtt', path.join(jobDir, subFile));
    }

    if (audioStreams.length <= 1) {
        args.push('-map', `0:${videoStreams[0].index}`);
        if (vCodec === 'copy') args.push('-c:v', 'copy');
        else args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '24', '-pix_fmt', 'yuv420p');
        if (audioStreams.length === 1) args.push('-map', `0:${audioStreams[0].index}`, '-c:a', 'aac', '-ac', '2', '-b:a', '128k');
        args.push(
            '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'event',
            '-hls_segment_filename', path.join(jobDir, 'seg_%05d.ts'), path.join(jobDir, 'master.m3u8')
        );
    } else {
        args.push('-map', `0:${videoStreams[0].index}`);
        if (vCodec === 'copy') args.push('-c:v', 'copy');
        else args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '24', '-pix_fmt', 'yuv420p');
        const varMap = ['v:0,agroup:aud'];
        for (let i = 0; i < audioStreams.length; i++) {
            const lang = (audioStreams[i].tags?.language || 'und').replace(/[^a-zA-Z0-9_-]/g, '');
            const tName = (audioStreams[i].tags?.title || `Track_${i + 1}`).replace(/[^a-zA-Z0-9_.-]/g, '_');
            args.push('-map', `0:${audioStreams[i].index}`, `-c:a:${i}`, 'aac', '-ac', '2', '-b:a', '128k');
            varMap.push(`a:${i},agroup:aud,language:${lang},name:${tName}${i === 0 ? ',default:yes' : ''}`);
        }
        args.push(
            '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'event',
            '-master_pl_name', 'master.m3u8', '-var_stream_map', varMap.join(' '),
            '-hls_segment_filename', path.join(jobDir, 'seg_%v_%05d.ts'), path.join(jobDir, 'stream_%v.m3u8')
        );
    }

    const ff = spawn('ffmpeg', args, { stdio: 'ignore' });
    const masterPath = path.join(jobDir, 'master.m3u8');
    await new Promise((resolve, reject) => {
        let elapsed = 0;
        const iv = setInterval(() => {
            elapsed += 200;
            if (fs.existsSync(masterPath) && fs.readdirSync(jobDir).some(f => f.endsWith('.ts'))) {
                clearInterval(iv);
                resolve();
            }
            if (elapsed > 30000) {
                clearInterval(iv);
                reject(new Error('PROCESSING_TIMEOUT'));
            }
        }, 200);
        ff.on('exit', code => {
            if (code !== 0 && !fs.existsSync(masterPath)) {
                clearInterval(iv);
                reject(new Error('PROCESSING_FAILED'));
            }
        });
    });

    return {
        mode: 'hls',
        title: originalName,
        src: `/hls/${jobId}/master.m3u8`,
        audioSrc: '',
        qualities: [],
        audioTracks: audioStreams.map((a, idx) => ({
            index: idx,
            label: a.tags?.title || a.tags?.language || `Audio ${idx + 1}`
        })),
        subtitles: subResults
    };
}

async function torboxAddAndGetFiles(torboxKey, magnet, fileBuffer, fileName) {
    const fd = new FormData();
    if (magnet) fd.append('magnet', magnet);
    if (fileBuffer) fd.append('file', new Blob([fileBuffer], { type: 'application/x-bittorrent' }), fileName || 'file.torrent');

    const createResp = await fetch('https://api.torbox.app/v1/api/torrents/createtorrent', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${torboxKey}` },
        body: fd
    });
    const createJson = await createResp.json();
    if (!createJson.success || !createJson.data?.torrent_id) {
        throw new Error(createJson.detail || 'TORBOX_CREATE_FAILED');
    }

    const torrentId = createJson.data.torrent_id;
    let torrentInfo = null;
    for (let i = 0; i < 20; i++) {
        const listResp = await fetch(`https://api.torbox.app/v1/api/torrents/mylist?id=${torrentId}`, {
            headers: { 'Authorization': `Bearer ${torboxKey}` }
        });
        const listJson = await listResp.json();
        if (listJson.success && listJson.data && Array.isArray(listJson.data.files) && listJson.data.files.length > 0) {
            torrentInfo = listJson.data;
            break;
        }
        await new Promise(r => setTimeout(r, 1500));
    }

    if (!torrentInfo) throw new Error('TORBOX_METADATA_PENDING');

    const files = torrentInfo.files
        .filter(f => /\.(mp4|mkv|webm|avi|mov|mp3|flac|m4a|wav)$/i.test(f.name))
        .map(f => ({
            id: f.id,
            name: f.short_name || f.name,
            size: f.size
        }));

    return {
        provider: 'torbox',
        torrentId,
        name: torrentInfo.name,
        downloadFinished: !!torrentInfo.download_finished,
        files
    };
}

app.get('/api/search', async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ results: [] });

    try {
        const results = await searchYouTubeFast(q);
        res.json({ results });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/resolve', async (req, res) => {
    const { url, torboxKey } = req.body;
    if (!url) return res.status(400).json({ error: 'MISSING_URL' });

    try {
        if (url.startsWith('magnet:?')) {
            if (torboxKey) {
                const tb = await torboxAddAndGetFiles(torboxKey, url, null, null);
                return res.json({ torbox: tb });
            }
            return res.json({ browserWebTorrent: { magnet: url } });
        }

        if (url.includes('open.spotify.com/')) {
            const tracks = await resolveSpotify(url);
            const first = tracks[0];
            const found = await searchYouTubeFast(`${first.artist} - ${first.title} audio`);
            if (found.length === 0) throw new Error('TRACK_NOT_FOUND');

            const playlistTracks = [];
            for (const tr of tracks.slice(1, 25)) {
                playlistTracks.push({
                    title: `${tr.artist} - ${tr.title}`,
                    spotifyQuery: `${tr.artist} - ${tr.title} audio`
                });
            }

            return res.json({
                media: {
                    mode: 'youtube',
                    title: `${first.artist} - ${first.title}`,
                    videoId: found[0].videoId,
                    src: `yt:${found[0].videoId}`,
                    audioSrc: '',
                    qualities: [],
                    audioTracks: [],
                    subtitles: []
                },
                playlistTracks
            });
        }

        const listMatch = url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
        const ytId = extractYouTubeId(url);

        if (listMatch && !ytId) {
            const items = await fetchYouTubePlaylistFast(listMatch[1]);
            if (items.length === 0) throw new Error('EMPTY_PLAYLIST');
            const first = items[0];
            return res.json({
                media: {
                    mode: 'youtube',
                    title: first.title,
                    videoId: first.videoId,
                    src: `yt:${first.videoId}`,
                    audioSrc: '',
                    qualities: [],
                    audioTracks: [],
                    subtitles: []
                },
                playlistTracks: items.slice(1, 50).map(it => ({
                    title: it.title,
                    url: it.url,
                    videoId: it.videoId
                }))
            });
        }

        if (ytId) {
            try {
                const ytDlpMedia = await extractWithYtDlp(url);
                return res.json({ media: ytDlpMedia });
            } catch {
                let title = 'YouTube Video';
                try {
                    const meta = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${ytId}&format=json`);
                    if (meta.ok) {
                        const j = await meta.json();
                        if (j.title) title = j.title;
                    }
                } catch {}

                return res.json({
                    media: {
                        mode: 'youtube',
                        title,
                        videoId: ytId,
                        src: `yt:${ytId}`,
                        audioSrc: '',
                        qualities: [],
                        audioTracks: [],
                        subtitles: []
                    }
                });
            }
        }

        if (/\.(mp4|webm|mp3|wav|ogg|m4a)(\?.*)?$/i.test(url)) {
            return res.json({
                media: {
                    mode: /\.(mp3|wav|ogg|m4a)/i.test(url) ? 'audio' : 'direct',
                    title: path.basename(url.split('?')[0]) || 'Direct Stream',
                    src: url,
                    fallbackProxy: registerMediaToken(url, {}),
                    audioSrc: '',
                    qualities: [],
                    audioTracks: [],
                    subtitles: []
                }
            });
        }

        if (/\.m3u8(\?.*)?$/i.test(url)) {
            return res.json({
                media: {
                    mode: 'hls',
                    title: 'HLS Stream',
                    src: url,
                    fallbackProxy: registerMediaToken(url, {}),
                    audioSrc: '',
                    qualities: [],
                    audioTracks: [],
                    subtitles: []
                }
            });
        }

        const media = await extractWithYtDlp(url);
        res.json({ media });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/torrent/upload', uploadMedia.single('torrent'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'NO_FILE' });
    const torboxKey = req.body?.torboxKey || '';
    try {
        const buf = fs.readFileSync(req.file.path);
        fs.unlinkSync(req.file.path);
        if (!torboxKey) {
            return res.json({ browserWebTorrentBase64: buf.toString('base64') });
        }
        const tb = await torboxAddAndGetFiles(torboxKey, null, buf, req.file.originalname);
        res.json({ torbox: tb });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/torrent/torbox-play', async (req, res) => {
    const { torboxKey, torrentId, fileId, title } = req.body;
    if (!torboxKey || !torrentId) return res.status(400).json({ error: 'MISSING_PARAMS' });
    try {
        const resp = await fetch(`https://api.torbox.app/v1/api/torrents/requestdl?token=${encodeURIComponent(torboxKey)}&torrent_id=${torrentId}&file_id=${fileId}`);
        const json = await resp.json();
        if (!json.success || !json.data) throw new Error(json.detail || 'TORBOX_LINK_FAILED');
        const directUrl = json.data;
        const isAudio = /\.(mp3|flac|wav|m4a|ogg)$/i.test(title);
        res.json({
            media: {
                mode: isAudio ? 'audio' : 'direct',
                title,
                src: directUrl,
                fallbackProxy: registerMediaToken(directUrl, {}),
                audioSrc: '',
                qualities: [{ label: 'SOURCE', url: directUrl }],
                audioTracks: [],
                subtitles: []
            }
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/upload-media', uploadMedia.single('media'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'NO_FILE' });
    try {
        const ext = path.extname(req.file.originalname);
        const newPath = req.file.path + ext;
        fs.renameSync(req.file.path, newPath);
        const media = await handleUploadedMedia(newPath, req.file.originalname);
        res.json({ media });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/chat/upload', uploadChat.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'NO_FILE' });
    const ext = path.extname(req.file.originalname);
    const finalName = `${path.basename(req.file.path)}${ext}`;
    const finalPath = path.join(CHAT_DIR, finalName);
    fs.renameSync(req.file.path, finalPath);
    res.json({
        url: `/chat-files/${finalName}`,
        originalName: req.file.originalname,
        mime: req.file.mimetype,
        size: req.file.size
    });
});

wss.on('connection', (ws) => {
    let clientId = uid(6);
    let currentRoom = null;

    ws.on('message', async (rawData) => {
        let msg;
        try { msg = JSON.parse(rawData); } catch { return; }

        if (msg.type === 'ping') {
            ws.send(JSON.stringify({
                type: 'pong',
                clientSendTime: msg.clientSendTime,
                serverTime: Date.now()
            }));
            return;
        }

        if (msg.type === 'join') {
            const roomId = (msg.roomId || 'DEFAULT').trim().toUpperCase();
            const nick = (msg.nick || 'USER').trim().slice(0, 24) || 'USER';
            currentRoom = getRoom(roomId);

            if (!currentRoom.hostId || !currentRoom.clients.has(currentRoom.hostId)) {
                currentRoom.hostId = clientId;
            }

            currentRoom.clients.set(clientId, {
                ws,
                nick,
                inVoice: false,
                micMuted: true,
                buffering: false
            });

            ws.send(JSON.stringify({
                type: 'init',
                clientId,
                roomId,
                hostId: currentRoom.hostId,
                media: currentRoom.media,
                queue: currentRoom.queue,
                messages: currentRoom.messages.slice(-100),
                users: getRoomUsersList(currentRoom),
                bufferLock: currentRoom.bufferLock,
                serverTime: Date.now()
            }));

            broadcastRoom(currentRoom, {
                type: 'users_update',
                hostId: currentRoom.hostId,
                users: getRoomUsersList(currentRoom)
            });
            return;
        }

        if (!currentRoom) return;
        const client = currentRoom.clients.get(clientId);
        if (!client) return;

        switch (msg.type) {
            case 'set_nick': {
                client.nick = (msg.nick || 'USER').trim().slice(0, 24) || 'USER';
                broadcastRoom(currentRoom, {
                    type: 'users_update',
                    hostId: currentRoom.hostId,
                    users: getRoomUsersList(currentRoom)
                });
                break;
            }

            case 'media_load': {
                currentRoom.media = {
                    ...msg.media,
                    isPlaying: msg.media.mode !== 'p2p_file',
                    baseTime: 0,
                    updatedAt: Date.now(),
                    playbackRate: 1.0
                };
                broadcastRoom(currentRoom, {
                    type: 'media_sync',
                    media: currentRoom.media,
                    serverTime: Date.now()
                });
                break;
            }

            case 'sub_share': {
                if (msg.vtt && msg.label) {
                    const subItem = { label: msg.label, vttText: msg.vtt };
                    currentRoom.media.subtitles = currentRoom.media.subtitles || [];
                    currentRoom.media.subtitles.push(subItem);
                    broadcastRoom(currentRoom, {
                        type: 'sub_added',
                        subtitle: subItem
                    });
                }
                break;
            }

            case 'media_control': {
                const m = currentRoom.media;
                if (msg.action === 'play') {
                    m.baseTime = typeof msg.time === 'number' ? msg.time : computeCurrentPosition(m);
                    m.isPlaying = true;
                    m.updatedAt = Date.now();
                } else if (msg.action === 'pause') {
                    m.baseTime = typeof msg.time === 'number' ? msg.time : computeCurrentPosition(m);
                    m.isPlaying = false;
                    m.updatedAt = Date.now();
                } else if (msg.action === 'seek') {
                    m.baseTime = Math.max(0, msg.time || 0);
                    m.updatedAt = Date.now();
                } else if (msg.action === 'rate') {
                    m.baseTime = computeCurrentPosition(m);
                    m.playbackRate = msg.rate || 1.0;
                    m.updatedAt = Date.now();
                }
                broadcastRoom(currentRoom, {
                    type: 'media_sync',
                    media: currentRoom.media,
                    serverTime: Date.now()
                });
                break;
            }

            case 'buffer_state': {
                client.buffering = !!msg.buffering;
                if (currentRoom.bufferLock && client.buffering && currentRoom.media.isPlaying) {
                    currentRoom.media.baseTime = computeCurrentPosition(currentRoom.media);
                    currentRoom.media.isPlaying = false;
                    currentRoom.media.updatedAt = Date.now();
                    broadcastRoom(currentRoom, {
                        type: 'media_sync',
                        media: currentRoom.media,
                        serverTime: Date.now()
                    });
                }
                broadcastRoom(currentRoom, {
                    type: 'users_update',
                    hostId: currentRoom.hostId,
                    users: getRoomUsersList(currentRoom)
                });
                break;
            }

            case 'toggle_buffer_lock': {
                currentRoom.bufferLock = !!msg.enabled;
                broadcastRoom(currentRoom, {
                    type: 'buffer_lock_state',
                    enabled: currentRoom.bufferLock
                });
                break;
            }

            case 'queue_add': {
                const item = { id: uid(5), ...msg.item, addedBy: client.nick };
                currentRoom.queue.push(item);
                broadcastRoom(currentRoom, { type: 'queue_update', queue: currentRoom.queue });
                break;
            }

            case 'queue_remove': {
                currentRoom.queue = currentRoom.queue.filter(q => q.id !== msg.id);
                broadcastRoom(currentRoom, { type: 'queue_update', queue: currentRoom.queue });
                break;
            }

            case 'queue_move': {
                const idx = currentRoom.queue.findIndex(q => q.id === msg.id);
                if (idx !== -1) {
                    const target = idx + msg.dir;
                    if (target >= 0 && target < currentRoom.queue.length) {
                        const tmp = currentRoom.queue[idx];
                        currentRoom.queue[idx] = currentRoom.queue[target];
                        currentRoom.queue[target] = tmp;
                        broadcastRoom(currentRoom, { type: 'queue_update', queue: currentRoom.queue });
                    }
                }
                break;
            }

            case 'queue_clear': {
                currentRoom.queue = [];
                broadcastRoom(currentRoom, { type: 'queue_update', queue: currentRoom.queue });
                break;
            }

            case 'queue_next': {
                if (currentRoom.queue.length === 0) break;
                const nextItem = msg.id
                    ? currentRoom.queue.find(q => q.id === msg.id)
                    : currentRoom.queue.shift();
                if (msg.id) {
                    currentRoom.queue = currentRoom.queue.filter(q => q.id !== msg.id);
                }
                broadcastRoom(currentRoom, { type: 'queue_update', queue: currentRoom.queue });
                if (!nextItem) break;

                try {
                    let media;
                    if (nextItem.media) {
                        media = nextItem.media;
                    } else if (nextItem.videoId) {
                        try {
                            media = await extractWithYtDlp(`https://www.youtube.com/watch?v=${nextItem.videoId}`);
                        } catch {
                            media = {
                                mode: 'youtube',
                                title: nextItem.title,
                                videoId: nextItem.videoId,
                                src: `yt:${nextItem.videoId}`,
                                audioSrc: '',
                                qualities: [],
                                audioTracks: [],
                                subtitles: []
                            };
                        }
                    } else if (nextItem.spotifyQuery) {
                        const found = await searchYouTubeFast(nextItem.spotifyQuery);
                        if (found[0]) {
                            media = {
                                mode: 'youtube',
                                title: nextItem.title,
                                videoId: found[0].videoId,
                                src: `yt:${found[0].videoId}`,
                                audioSrc: '',
                                qualities: [],
                                audioTracks: [],
                                subtitles: []
                            };
                        }
                    } else if (nextItem.url) {
                        const ytId = extractYouTubeId(nextItem.url);
                        if (ytId) {
                            try {
                                media = await extractWithYtDlp(nextItem.url);
                            } catch {
                                media = {
                                    mode: 'youtube',
                                    title: nextItem.title,
                                    videoId: ytId,
                                    src: `yt:${ytId}`,
                                    audioSrc: '',
                                    qualities: [],
                                    audioTracks: [],
                                    subtitles: []
                                };
                            }
                        } else {
                            media = await extractWithYtDlp(nextItem.url);
                        }
                    }
                    if (media) {
                        currentRoom.media = {
                            ...media,
                            isPlaying: true,
                            baseTime: 0,
                            updatedAt: Date.now(),
                            playbackRate: 1.0
                        };
                        broadcastRoom(currentRoom, {
                            type: 'media_sync',
                            media: currentRoom.media,
                            serverTime: Date.now()
                        });
                    }
                } catch {}
                break;
            }

            case 'chat_msg': {
                const chatEntry = {
                    id: uid(6),
                    userId: clientId,
                    nick: client.nick,
                    kind: msg.kind || 'text',
                    text: (msg.text || '').slice(0, 4000),
                    file: msg.file || null,
                    reactions: {},
                    time: Date.now()
                };
                currentRoom.messages.push(chatEntry);
                if (currentRoom.messages.length > 200) currentRoom.messages.shift();
                broadcastRoom(currentRoom, { type: 'chat_new', message: chatEntry });
                break;
            }

            case 'chat_react': {
                const target = currentRoom.messages.find(m => m.id === msg.messageId);
                if (target) {
                    if (!target.reactions[msg.emoji]) target.reactions[msg.emoji] = [];
                    const idx = target.reactions[msg.emoji].indexOf(clientId);
                    if (idx === -1) target.reactions[msg.emoji].push(clientId);
                    else target.reactions[msg.emoji].splice(idx, 1);
                    if (target.reactions[msg.emoji].length === 0) delete target.reactions[msg.emoji];
                    broadcastRoom(currentRoom, {
                        type: 'chat_react_update',
                        messageId: target.id,
                        reactions: target.reactions
                    });
                }
                break;
            }

            case 'voice_state': {
                client.inVoice = !!msg.inVoice;
                client.micMuted = !!msg.micMuted;
                broadcastRoom(currentRoom, {
                    type: 'users_update',
                    hostId: currentRoom.hostId,
                    users: getRoomUsersList(currentRoom)
                });
                break;
            }

            case 'screen_share_start': {
                currentRoom.media = {
                    mode: 'webrtc',
                    title: `LIVE SCREEN // ${client.nick}`,
                    src: '',
                    audioSrc: '',
                    videoId: '',
                    qualities: [],
                    audioTracks: [],
                    subtitles: [],
                    isPlaying: true,
                    baseTime: 0,
                    updatedAt: Date.now(),
                    playbackRate: 1.0,
                    webrtcHostId: clientId
                };
                broadcastRoom(currentRoom, {
                    type: 'media_sync',
                    media: currentRoom.media,
                    serverTime: Date.now()
                });
                break;
            }

            case 'rtc_signal': {
                const targetClient = currentRoom.clients.get(msg.targetId);
                if (targetClient && targetClient.ws.readyState === 1) {
                    targetClient.ws.send(JSON.stringify({
                        type: 'rtc_signal',
                        senderId: clientId,
                        channel: msg.channel,
                        data: msg.data
                    }));
                }
                break;
            }
        }
    });

    ws.on('close', () => {
        if (!currentRoom) return;
        currentRoom.clients.delete(clientId);
        if (currentRoom.hostId === clientId) {
            const nextKey = currentRoom.clients.keys().next().value;
            currentRoom.hostId = nextKey || null;
        }
        broadcastRoom(currentRoom, { type: 'peer_left', peerId: clientId });
        broadcastRoom(currentRoom, {
            type: 'users_update',
            hostId: currentRoom.hostId,
            users: getRoomUsersList(currentRoom)
        });
        cleanupRoomIfEmpty(currentRoom.id);
    });
});

setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
        if (room.clients.size > 0 && room.media.mode !== 'idle' && room.media.mode !== 'webrtc') {
            broadcastRoom(room, {
                type: 'sync_pulse',
                media: room.media,
                serverTime: now
            });
        }
    }
}, 2500);

setInterval(() => {
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    [UPLOAD_DIR, CHAT_DIR, HLS_DIR].forEach(dir => {
        try {
            for (const f of fs.readdirSync(dir)) {
                const fp = path.join(dir, f);
                const st = fs.statSync(fp);
                if (st.mtimeMs < cutoff) fs.rmSync(fp, { recursive: true, force: true });
            }
        } catch {}
    });
}, 30 * 60 * 1000);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`VOIDSYNC ONLINE ON PORT ${PORT}`);
});

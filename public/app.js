(() => {
    const $ = id => document.getElementById(id);

    const state = {
        ws: null,
        clientId: null,
        roomId: null,
        hostId: null,
        nick: localStorage.getItem('voidsync_nick') || '',
        torboxKey: localStorage.getItem('voidsync_torbox') || '',
        clockOffset: 0,
        rtt: 0,
        media: { mode: 'idle', isPlaying: false, baseTime: 0, updatedAt: Date.now(), playbackRate: 1.0 },
        hls: null,
        wtClient: null,
        ytPlayer: null,
        ytReady: false,
        suppressPlayerEvents: false,
        wakeLock: null,
        subOffset: 0,
        bufferLock: false,
        inVoice: false,
        micMuted: true,
        deafened: false,
        localVoiceStream: null,
        localScreenStream: null,
        localP2pFile: null,
        voicePeers: new Map(),
        screenPeers: new Map(),
        filePeers: new Map(),
        audioCtx: null,
        peerVolumes: {},
        recorder: null,
        recChunks: [],
        isRecording: false,
        recTimer: null,
        recSeconds: 0
    };

    const videoEl = $('video-player');
    const audioEl = $('audio-player');
    const vizCanvas = $('audio-viz');
    const ytContainer = $('yt-container');
    const playerWrapper = $('player-wrapper');
    const urlParams = new URLSearchParams(window.location.search);

    if (state.nick) $('gate-nick').value = state.nick;
    if (state.torboxKey) $('input-torbox-key').value = state.torboxKey;
    if (urlParams.get('room')) $('gate-room').value = urlParams.get('room').toUpperCase();

    function formatTime(sec) {
        if (!isFinite(sec) || sec < 0) return '00:00';
        const s = Math.floor(sec);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const r = s % 60;
        const pad = n => String(n).padStart(2, '0');
        return h > 0 ? `${pad(h)}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
    }

    function genRoomCode() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let out = '';
        for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
        return out;
    }

    function serverNow() {
        return Date.now() + state.clockOffset;
    }

    function getExpectedTime() {
        const m = state.media;
        if (!m || m.mode === 'idle' || m.mode === 'webrtc') return 0;
        if (!m.isPlaying) return m.baseTime;
        return Math.max(0, m.baseTime + ((serverNow() - m.updatedAt) / 1000) * m.playbackRate);
    }

    async function requestWakeLock() {
        if ('wakeLock' in navigator && !state.wakeLock) {
            try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch {}
        }
    }

    function unlockMediaContext() {
        if (!state.audioCtx) {
            state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (state.audioCtx.state === 'suspended') {
            state.audioCtx.resume().catch(() => {});
        }
    }

    function sendWs(payload) {
        if (state.ws && state.ws.readyState === 1) {
            state.ws.send(JSON.stringify(payload));
        }
    }

    function performClockSync() {
        for (let i = 0; i < 4; i++) {
            setTimeout(() => {
                sendWs({ type: 'ping', clientSendTime: Date.now() });
            }, i * 120);
        }
    }

    let rttSamples = [];
    function handlePong(msg) {
        const now = Date.now();
        const rtt = now - msg.clientSendTime;
        const offset = (msg.serverTime + rtt / 2) - now;
        rttSamples.push({ rtt, offset });
        if (rttSamples.length > 8) rttSamples.shift();
        const best = rttSamples.reduce((a, b) => a.rtt < b.rtt ? a : b);
        state.clockOffset = best.offset;
        state.rtt = best.rtt;
    }

    function connectRoom(roomId, nick) {
        state.roomId = roomId;
        state.nick = nick;
        localStorage.setItem('voidsync_nick', nick);
        $('inline-nick').value = nick;
        $('room-badge').textContent = `ROOM: ${roomId}`;

        const newUrl = `${window.location.pathname}?room=${roomId}`;
        window.history.replaceState({}, '', newUrl);

        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        state.ws = new WebSocket(`${proto}://${window.location.host}`);

        state.ws.onopen = () => {
            performClockSync();
            sendWs({ type: 'join', roomId, nick });
            setInterval(() => sendWs({ type: 'ping', clientSendTime: Date.now() }), 10000);
        };

        state.ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data);
            switch (msg.type) {
                case 'pong':
                    handlePong(msg);
                    break;
                case 'init':
                    state.clientId = msg.clientId;
                    state.hostId = msg.hostId;
                    state.bufferLock = msg.bufferLock;
                    updateBufferLockUI();
                    renderUsers(msg.users);
                    renderQueue(msg.queue);
                    $('chat-messages').innerHTML = '';
                    msg.messages.forEach(appendChatMessage);
                    loadRoomMedia(msg.media);
                    break;
                case 'users_update':
                    state.hostId = msg.hostId;
                    renderUsers(msg.users);
                    syncVoiceMesh(msg.users);
                    break;
                case 'media_sync':
                    if (msg.media.src !== state.media.src || msg.media.mode !== state.media.mode || msg.media.webrtcHostId !== state.media.webrtcHostId || msg.media.p2pHostId !== state.media.p2pHostId) {
                        loadRoomMedia(msg.media);
                    } else {
                        state.media = msg.media;
                        applySyncToPlayer(true);
                    }
                    break;
                case 'sync_pulse':
                    if (msg.media.mode === state.media.mode && msg.media.src === state.media.src) {
                        state.media = msg.media;
                        applySyncToPlayer(false);
                    }
                    break;
                case 'sub_added':
                    addTextSubtitleTrack(msg.subtitle.label, msg.subtitle.vttText);
                    break;
                case 'buffer_lock_state':
                    state.bufferLock = msg.enabled;
                    updateBufferLockUI();
                    break;
                case 'queue_update':
                    renderQueue(msg.queue);
                    break;
                case 'chat_new':
                    appendChatMessage(msg.message);
                    break;
                case 'chat_react_update':
                    updateMessageReactions(msg.messageId, msg.reactions);
                    break;
                case 'rtc_signal':
                    handleRtcSignal(msg);
                    break;
                case 'peer_left':
                    closePeer(msg.peerId);
                    break;
            }
        };

        state.ws.onclose = () => {
            setTimeout(() => {
                if (state.roomId) connectRoom(state.roomId, state.nick);
            }, 2500);
        };
    }

    function destroyCurrentMedia() {
        if (state.hls) {
            state.hls.destroy();
            state.hls = null;
        }
        if (state.ytPlayer) {
            try { state.ytPlayer.destroy(); } catch {}
            state.ytPlayer = null;
            state.ytReady = false;
            ytContainer.innerHTML = '<div id="yt-player"></div>';
        }
        ytContainer.classList.add('hidden');
        $('p2p-transfer-overlay').classList.add('hidden');
        videoEl.pause();
        audioEl.pause();
        videoEl.removeAttribute('src');
        videoEl.srcObject = null;
        audioEl.removeAttribute('src');
        audioEl.srcObject = null;
        videoEl.load();
        audioEl.load();
        Array.from(videoEl.querySelectorAll('track')).forEach(t => t.remove());
        vizCanvas.classList.add('hidden');
        videoEl.classList.remove('hidden');
        $('sel-quality').innerHTML = '<option value="-1">QUAL: AUTO</option>';
        $('sel-audio').innerHTML = '<option value="-1">AUD: DEFAULT</option>';
        $('sel-subs').innerHTML = '<option value="-1">SUB: OFF</option>';
    }

    function addTextSubtitleTrack(label, vttText) {
        const blob = new Blob([vttText], { type: 'text/vtt' });
        const url = URL.createObjectURL(blob);
        const track = document.createElement('track');
        track.kind = 'subtitles';
        track.label = label;
        track.src = url;
        videoEl.appendChild(track);
        const idx = videoEl.textTracks.length - 1;
        const opt = document.createElement('option');
        opt.value = String(idx);
        opt.textContent = `SUB: ${label}`;
        $('sel-subs').appendChild(opt);
        $('sel-subs').value = String(idx);
        for (let i = 0; i < videoEl.textTracks.length; i++) {
            videoEl.textTracks[i].mode = (i === idx) ? 'showing' : 'disabled';
        }
    }

    function loadRoomMedia(media) {
        state.media = media;
        $('media-title-overlay').textContent = media.title || 'NO MEDIA LOADED';
        destroyCurrentMedia();

        if (media.mode === 'idle') return;

        if (media.mode === 'youtube') {
            videoEl.classList.add('hidden');
            ytContainer.classList.remove('hidden');
            const initYt = () => {
                if (!window.YT || !window.YT.Player) return setTimeout(initYt, 200);
                state.ytPlayer = new YT.Player('yt-player', {
                    videoId: media.videoId,
                    playerVars: {
                        controls: 1,
                        rel: 0,
                        modestbranding: 1,
                        playsinline: 1,
                        origin: window.location.origin
                    },
                    events: {
                        onReady: () => {
                            state.ytReady = true;
                            applySyncToPlayer(true);
                        },
                        onStateChange: (ev) => {
                            if (state.suppressPlayerEvents) return;
                            if (ev.data === YT.PlayerState.PLAYING && !state.media.isPlaying) {
                                sendWs({ type: 'media_control', action: 'play', time: state.ytPlayer.getCurrentTime() });
                            } else if (ev.data === YT.PlayerState.PAUSED && state.media.isPlaying) {
                                sendWs({ type: 'media_control', action: 'pause', time: state.ytPlayer.getCurrentTime() });
                            } else if (ev.data === YT.PlayerState.ENDED && state.hostId === state.clientId) {
                                sendWs({ type: 'queue_next' });
                            }
                        }
                    }
                });
            };
            initYt();
            return;
        }

        if (media.mode === 'p2p_file') {
            if (media.p2pHostId === state.clientId && state.localP2pFile) {
                videoEl.src = URL.createObjectURL(state.localP2pFile);
                applySyncToPlayer(true);
            } else {
                $('p2p-transfer-overlay').classList.remove('hidden');
                $('p2p-transfer-overlay').textContent = 'CONNECTING TO P2P PEER...';
                sendWs({ type: 'rtc_signal', targetId: media.p2pHostId, channel: 'file', data: { requestFile: true } });
            }
            return;
        }

        if (media.mode === 'webrtc') {
            if (media.webrtcHostId === state.clientId && state.localScreenStream) {
                videoEl.srcObject = state.localScreenStream;
                videoEl.muted = true;
                videoEl.play().catch(() => {});
            } else {
                sendWs({ type: 'rtc_signal', targetId: media.webrtcHostId, channel: 'screen', data: { requestStream: true } });
            }
            return;
        }

        if (media.mode === 'audio') {
            videoEl.classList.add('hidden');
            vizCanvas.classList.remove('hidden');
            audioEl.src = media.src;
            setupAudioVisualizer();
            applySyncToPlayer(true);
            return;
        }

        if (media.mode === 'hls') {
            if (window.Hls && Hls.isSupported()) {
                const hls = new Hls({
                    startPosition: getExpectedTime(),
                    liveDurationInfinity: false,
                    enableWorker: true
                });
                state.hls = hls;
                hls.loadSource(media.src);
                hls.attachMedia(videoEl);
                hls.on(Hls.Events.MANIFEST_PARSED, () => {
                    populateHlsSelectors(hls);
                    applySyncToPlayer(true);
                });
                hls.on(Hls.Events.ERROR, (ev, data) => {
                    if (data.fatal && media.fallbackProxy && media.src !== media.fallbackProxy) {
                        media.src = media.fallbackProxy;
                        hls.loadSource(media.src);
                    }
                });
                hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => populateHlsSelectors(hls));
            } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
                videoEl.src = media.src;
                applySyncToPlayer(true);
            }
        } else if (media.mode === 'dual') {
            videoEl.src = media.src;
            videoEl.muted = true;
            audioEl.src = media.audioSrc;
            populateSelect('sel-quality', media.qualities, 'QUAL');
            populateSelect('sel-audio', media.audioTracks, 'AUD');
            applySyncToPlayer(true);
        } else if (media.mode === 'direct') {
            videoEl.src = media.src;
            videoEl.onerror = () => {
                if (media.fallbackProxy && videoEl.src !== window.location.origin + media.fallbackProxy) {
                    videoEl.src = media.fallbackProxy;
                    applySyncToPlayer(true);
                }
            };
            populateSelect('sel-quality', media.qualities, 'QUAL');
            applySyncToPlayer(true);
        }

        if (Array.isArray(media.subtitles)) {
            media.subtitles.forEach(s => {
                if (s.vttText) {
                    addTextSubtitleTrack(s.label, s.vttText);
                } else if (s.url) {
                    const track = document.createElement('track');
                    track.kind = 'subtitles';
                    track.label = s.label;
                    track.src = s.url;
                    videoEl.appendChild(track);
                    const opt = document.createElement('option');
                    opt.value = String(videoEl.textTracks.length - 1);
                    opt.textContent = `SUB: ${s.label}`;
                    $('sel-subs').appendChild(opt);
                }
            });
        }
    }

    function populateHlsSelectors(hls) {
        const qSel = $('sel-quality');
        qSel.innerHTML = '<option value="-1">QUAL: AUTO</option>';
        hls.levels.forEach((lvl, idx) => {
            const opt = document.createElement('option');
            opt.value = String(idx);
            opt.textContent = `QUAL: ${lvl.height || idx}p`;
            qSel.appendChild(opt);
        });

        const aSel = $('sel-audio');
        aSel.innerHTML = '';
        if (hls.audioTracks.length === 0) {
            aSel.innerHTML = '<option value="-1">AUD: DEFAULT</option>';
        } else {
            hls.audioTracks.forEach((tr, idx) => {
                const opt = document.createElement('option');
                opt.value = String(idx);
                opt.textContent = `AUD: ${tr.name || tr.lang || idx + 1}`;
                if (idx === hls.audioTrack) opt.selected = true;
                aSel.appendChild(opt);
            });
        }
    }

    function populateSelect(id, list, prefix) {
        const el = $(id);
        el.innerHTML = '';
        if (!list || list.length === 0) {
            el.innerHTML = `<option value="-1">${prefix}: DEFAULT</option>`;
            return;
        }
        list.forEach(item => {
            const opt = document.createElement('option');
            opt.value = item.url;
            opt.textContent = `${prefix}: ${item.label}`;
            el.appendChild(opt);
        });
    }

    function getActiveDriver() {
        return state.media.mode === 'audio' ? audioEl : videoEl;
    }

    function safePlay(el) {
        const p = el.play();
        if (p && p.catch) {
            p.catch(err => {
                if (err.name === 'NotAllowedError') {
                    el.muted = true;
                    el.play().catch(() => {});
                    $('btn-unmute-prompt').classList.remove('hidden');
                }
            });
        }
    }

    let lastYtTime = 0;
    function applySyncToPlayer(hard) {
        const m = state.media;
        if (!m || m.mode === 'idle' || m.mode === 'webrtc') return;

        const expected = getExpectedTime();
        state.suppressPlayerEvents = true;

        if (m.mode === 'youtube') {
            if (!state.ytReady || !state.ytPlayer) {
                state.suppressPlayerEvents = false;
                return;
            }
            const cur = state.ytPlayer.getCurrentTime ? state.ytPlayer.getCurrentTime() : 0;
            const yState = state.ytPlayer.getPlayerState ? state.ytPlayer.getPlayerState() : -1;
            const drift = expected - cur;
            $('sync-telemetry').textContent = `OFFSET: ${Math.round(state.clockOffset)}ms | DRIFT: ${Math.round(drift * 1000)}ms | RTT: ${state.rtt}ms`;

            if (m.isPlaying && yState !== 1 && yState !== 3) {
                state.ytPlayer.playVideo();
            } else if (!m.isPlaying && yState === 1) {
                state.ytPlayer.pauseVideo();
            }
            if (hard || Math.abs(drift) > 0.65) {
                if (Math.abs(drift) > 0.15) state.ytPlayer.seekTo(expected, true);
            }
            if (state.ytPlayer.getPlaybackRate && state.ytPlayer.getPlaybackRate() !== m.playbackRate) {
                state.ytPlayer.setPlaybackRate(m.playbackRate);
            }
            lastYtTime = expected;
            $('btn-play').textContent = m.isPlaying ? 'PAUSE' : 'PLAY';
            $('sel-speed').value = String(m.playbackRate);
            setTimeout(() => { state.suppressPlayerEvents = false; }, 180);
            return;
        }

        const driver = getActiveDriver();
        if (m.isPlaying) {
            if (driver.paused) safePlay(driver);
            if (m.mode === 'dual' && audioEl.paused) safePlay(audioEl);
        } else {
            if (!driver.paused) driver.pause();
            if (m.mode === 'dual' && !audioEl.paused) audioEl.pause();
        }

        const drift = expected - driver.currentTime;
        $('sync-telemetry').textContent = `OFFSET: ${Math.round(state.clockOffset)}ms | DRIFT: ${Math.round(drift * 1000)}ms | RTT: ${state.rtt}ms`;

        if (hard || Math.abs(drift) > 0.35 || !m.isPlaying) {
            if (Math.abs(drift) > 0.05 && isFinite(expected)) {
                driver.currentTime = expected;
                if (m.mode === 'dual') audioEl.currentTime = expected;
            }
            driver.playbackRate = m.playbackRate;
            if (m.mode === 'dual') audioEl.playbackRate = m.playbackRate;
        } else if (Math.abs(drift) > 0.04) {
            const adj = drift > 0 ? 1.03 : 0.97;
            driver.playbackRate = m.playbackRate * adj;
            if (m.mode === 'dual') audioEl.playbackRate = m.playbackRate * adj;
        } else {
            driver.playbackRate = m.playbackRate;
            if (m.mode === 'dual') audioEl.playbackRate = m.playbackRate;
        }

        if (m.mode === 'dual') {
            if (Math.abs(driver.currentTime - audioEl.currentTime) > 0.04) {
                audioEl.currentTime = driver.currentTime;
            }
        }

        $('btn-play').textContent = m.isPlaying ? 'PAUSE' : 'PLAY';
        $('sel-speed').value = String(m.playbackRate);
        setTimeout(() => { state.suppressPlayerEvents = false; }, 80);
    }

    setInterval(() => {
        const m = state.media;
        if (!m || m.mode === 'idle' || m.mode === 'webrtc') return;

        let cur = 0;
        let dur = 0;
        if (m.mode === 'youtube' && state.ytReady && state.ytPlayer?.getCurrentTime) {
            cur = state.ytPlayer.getCurrentTime();
            dur = state.ytPlayer.getDuration();
            if (!state.suppressPlayerEvents && Math.abs(cur - lastYtTime) > 2.2) {
                sendWs({ type: 'media_control', action: 'seek', time: cur });
            }
            lastYtTime = cur;
        } else {
            const driver = getActiveDriver();
            cur = driver.currentTime || 0;
            dur = driver.duration || 0;
        }

        if (m.isPlaying) applySyncToPlayer(false);

        $('time-display').textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
        if (dur > 0 && !$('seek-bar').matches(':active')) {
            $('seek-bar').value = (cur / dur) * 100;
        }
    }, 350);

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && state.ws) {
            performClockSync();
            applySyncToPlayer(true);
        }
    });

    window.addEventListener('focus', () => {
        if (state.ws) applySyncToPlayer(true);
    });

    [videoEl, audioEl].forEach(el => {
        el.addEventListener('waiting', () => sendWs({ type: 'buffer_state', buffering: true }));
        el.addEventListener('playing', () => sendWs({ type: 'buffer_state', buffering: false }));
        el.addEventListener('ended', () => {
            if (el === getActiveDriver() && state.hostId === state.clientId) sendWs({ type: 'queue_next' });
        });
    });

    playerWrapper.addEventListener('click', (e) => {
        if (e.target.closest('#controls-bar') || e.target.closest('button') || e.target.closest('input') || e.target.closest('select')) return;
        playerWrapper.classList.toggle('hud-hidden');
    });

    playerWrapper.addEventListener('dblclick', (e) => {
        if (e.target.closest('#controls-bar')) return;
        $('btn-fullscreen').click();
    });

    $('btn-hud-toggle').onclick = () => playerWrapper.classList.toggle('hud-hidden');

    document.addEventListener('keydown', (e) => {
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
        if (e.code === 'Space') { e.preventDefault(); $('btn-play').click(); }
        else if (e.key === 'f' || e.key === 'F') $('btn-fullscreen').click();
        else if (e.key === 'h' || e.key === 'H') playerWrapper.classList.toggle('hud-hidden');
        else if (e.key === 'm' || e.key === 'M') $('btn-mute').click();
        else if (e.key === 'ArrowRight') {
            const t = (state.media.mode === 'youtube' && state.ytReady) ? state.ytPlayer.getCurrentTime() : getActiveDriver().currentTime;
            sendWs({ type: 'media_control', action: 'seek', time: t + 5 });
        } else if (e.key === 'ArrowLeft') {
            const t = (state.media.mode === 'youtube' && state.ytReady) ? state.ytPlayer.getCurrentTime() : getActiveDriver().currentTime;
            sendWs({ type: 'media_control', action: 'seek', time: Math.max(0, t - 5) });
        }
    });

    $('btn-unmute-prompt').onclick = () => {
        const driver = getActiveDriver();
        if (state.media.mode === 'dual') audioEl.muted = false;
        else driver.muted = false;
        $('btn-unmute-prompt').classList.add('hidden');
        unlockMediaContext();
    };

    $('btn-play').onclick = () => {
        const m = state.media;
        if (m.mode === 'idle' || m.mode === 'webrtc') return;
        const t = (m.mode === 'youtube' && state.ytReady) ? state.ytPlayer.getCurrentTime() : getActiveDriver().currentTime;
        sendWs({ type: 'media_control', action: m.isPlaying ? 'pause' : 'play', time: t });
    };

    $('btn-sync-now').onclick = () => {
        performClockSync();
        applySyncToPlayer(true);
    };

    $('seek-bar').oninput = (e) => {
        const m = state.media;
        const dur = (m.mode === 'youtube' && state.ytReady) ? state.ytPlayer.getDuration() : (getActiveDriver().duration || 0);
        if (dur > 0) {
            const target = (parseFloat(e.target.value) / 100) * dur;
            sendWs({ type: 'media_control', action: 'seek', time: target });
        }
    };

    $('vol-slider').oninput = (e) => {
        const v = parseFloat(e.target.value);
        if (state.media.mode === 'youtube' && state.ytReady) {
            state.ytPlayer.setVolume(v * 100);
        } else if (state.media.mode === 'dual' || state.media.mode === 'audio') {
            audioEl.volume = v;
            audioEl.muted = v === 0;
        } else {
            videoEl.volume = v;
            videoEl.muted = v === 0;
        }
    };

    $('btn-mute').onclick = () => {
        if (state.media.mode === 'youtube' && state.ytReady) {
            if (state.ytPlayer.isMuted()) { state.ytPlayer.unMute(); $('btn-mute').textContent = 'VOL'; }
            else { state.ytPlayer.mute(); $('btn-mute').textContent = 'MUTED'; }
            return;
        }
        const target = (state.media.mode === 'dual' || state.media.mode === 'audio') ? audioEl : videoEl;
        target.muted = !target.muted;
        $('btn-mute').textContent = target.muted ? 'MUTED' : 'VOL';
    };

    $('sel-speed').onchange = (e) => {
        sendWs({ type: 'media_control', action: 'rate', rate: parseFloat(e.target.value) });
    };

    $('sel-quality').onchange = (e) => {
        const val = e.target.value;
        if (state.hls) {
            state.hls.currentLevel = parseInt(val, 10);
        } else if (val !== '-1') {
            const t = videoEl.currentTime;
            const wasPlaying = !videoEl.paused;
            videoEl.src = val;
            videoEl.currentTime = t;
            if (wasPlaying) safePlay(videoEl);
        }
    };

    $('sel-audio').onchange = (e) => {
        const val = e.target.value;
        if (state.hls) {
            state.hls.audioTrack = parseInt(val, 10);
        } else if (state.media.mode === 'dual' && val !== '-1') {
            const t = videoEl.currentTime;
            const wasPlaying = !audioEl.paused;
            audioEl.src = val;
            audioEl.currentTime = t;
            if (wasPlaying) safePlay(audioEl);
        }
    };

    $('sel-subs').onchange = (e) => {
        const idx = parseInt(e.target.value, 10);
        for (let i = 0; i < videoEl.textTracks.length; i++) {
            videoEl.textTracks[i].mode = (i === idx) ? 'showing' : 'disabled';
        }
    };

    function srtToVtt(srtText) {
        return 'WEBVTT\n\n' + srtText
            .replace(/\r+/g, '')
            .replace(/^\d+\s*$/gm, '')
            .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    }

    $('btn-sub-upload').onclick = () => $('input-sub-file').click();
    $('input-sub-file').onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        let text = await file.text();
        if (file.name.toLowerCase().endsWith('.srt')) text = srtToVtt(text);
        addTextSubtitleTrack(file.name, text);
        sendWs({ type: 'sub_share', label: file.name, vtt: text });
    };

    function shiftSubtitles(delta) {
        state.subOffset += delta;
        for (let i = 0; i < videoEl.textTracks.length; i++) {
            const tr = videoEl.textTracks[i];
            if (tr.mode === 'showing' && tr.cues) {
                for (let j = 0; j < tr.cues.length; j++) {
                    tr.cues[j].startTime = Math.max(0, tr.cues[j].startTime + delta);
                    tr.cues[j].endTime = Math.max(0, tr.cues[j].endTime + delta);
                }
            }
        }
    }

    $('btn-sub-minus').onclick = () => shiftSubtitles(-0.5);
    $('btn-sub-plus').onclick = () => shiftSubtitles(0.5);

    $('btn-pip').onclick = () => {
        if (document.pictureInPictureElement) document.exitPictureInPicture();
        else videoEl.requestPictureInPicture().catch(() => {});
    };

    $('btn-theater').onclick = () => {
        $('sidebar').classList.toggle('hidden');
        $('main-col').classList.toggle('theater-mode');
    };

    $('btn-toggle-sidebar').onclick = () => {
        $('sidebar').classList.toggle('hidden');
    };

    $('btn-fullscreen').onclick = () => {
        if (!document.fullscreenElement) playerWrapper.requestFullscreen().catch(() => {});
        else document.exitFullscreen();
    };

    function setupAudioVisualizer() {
        if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const ctx2d = vizCanvas.getContext('2d');
        try {
            if (!audioEl._vizConnected) {
                const src = state.audioCtx.createMediaElementSource(audioEl);
                const analyser = state.audioCtx.createAnalyser();
                analyser.fftSize = 64;
                src.connect(analyser);
                analyser.connect(state.audioCtx.destination);
                audioEl._analyser = analyser;
                audioEl._vizConnected = true;
            }
            const analyser = audioEl._analyser;
            const buf = new Uint8Array(analyser.frequencyBinCount);
            function drawViz() {
                if (state.media.mode !== 'audio') return;
                requestAnimationFrame(drawViz);
                vizCanvas.width = vizCanvas.clientWidth;
                vizCanvas.height = vizCanvas.clientHeight;
                ctx2d.fillStyle = '#000';
                ctx2d.fillRect(0, 0, vizCanvas.width, vizCanvas.height);
                analyser.getByteFrequencyData(buf);
                const barW = vizCanvas.width / buf.length;
                ctx2d.fillStyle = '#fff';
                for (let i = 0; i < buf.length; i++) {
                    const h = (buf[i] / 255) * vizCanvas.height * 0.75;
                    ctx2d.fillRect(i * barW + 2, vizCanvas.height - h - 50, barW - 4, h);
                }
            }
            drawViz();
        } catch {}
    }

    document.querySelectorAll('.dock-tab').forEach(tab => {
        tab.onclick = () => {
            document.querySelectorAll('.dock-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.dock-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            $(tab.dataset.tab).classList.add('active');
        };
    });

    $('btn-save-torbox').onclick = () => {
        state.torboxKey = $('input-torbox-key').value.trim();
        localStorage.setItem('voidsync_torbox', state.torboxKey);
        $('btn-save-torbox').textContent = 'SAVED';
        setTimeout(() => { $('btn-save-torbox').textContent = 'SAVE KEY'; }, 1500);
    };

    function runBrowserWebTorrent(source) {
        if (!window.WebTorrent) {
            $('upload-status').textContent = 'WEBTORRENT LIB LOADING';
            return;
        }
        if (!state.wtClient) state.wtClient = new window.WebTorrent();
        $('upload-status').textContent = 'FINDING WEBRTC PEERS...';
        state.wtClient.add(source, (torrent) => {
            const box = $('torrent-files-list');
            box.innerHTML = '';
            torrent.files.forEach(f => {
                if (!/\.(mp4|mkv|webm|mp3|wav|m4a)$/i.test(f.name)) return;
                const row = document.createElement('div');
                row.className = 'list-item';
                row.innerHTML = `<span class="list-item-title">${f.name} (${(f.length / 1048576).toFixed(1)} MB)</span>`;
                const btn = document.createElement('button');
                btn.className = 'btn-xs';
                btn.textContent = 'PLAY P2P';
                btn.onclick = () => {
                    f.getBlob((err, blob) => {
                        if (err || !blob) return;
                        state.localP2pFile = new File([blob], f.name, { type: 'video/mp4' });
                        sendWs({
                            type: 'media_load',
                            media: {
                                mode: 'p2p_file',
                                title: f.name,
                                src: `p2p:${f.name}:${f.length}`,
                                audioSrc: '',
                                qualities: [],
                                audioTracks: [],
                                subtitles: [],
                                p2pHostId: state.clientId,
                                p2pFile: { name: f.name, size: f.length, type: 'video/mp4' }
                            }
                        });
                    });
                };
                row.appendChild(btn);
                box.appendChild(row);
            });
            document.querySelector('[data-tab="tab-torrent"]').click();
            $('upload-status').textContent = '';
        });
    }

    function renderTorboxFiles(tb) {
        const box = $('torrent-files-list');
        box.innerHTML = '';
        tb.files.forEach(f => {
            const row = document.createElement('div');
            row.className = 'list-item';
            const mb = (f.size / 1048576).toFixed(1);
            row.innerHTML = `<span class="list-item-title">${f.name} (${mb} MB)</span>`;
            const btn = document.createElement('button');
            btn.className = 'btn-xs';
            btn.textContent = 'PLAY';
            btn.onclick = async () => {
                $('upload-status').textContent = 'FETCHING STREAM...';
                const resp = await fetch('/api/torrent/torbox-play', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ torboxKey: state.torboxKey, torrentId: tb.torrentId, fileId: f.id, title: f.name })
                });
                const data = await resp.json();
                if (data.media) sendWs({ type: 'media_load', media: data.media });
                else $('upload-status').textContent = `ERR: ${data.error}`;
                $('upload-status').textContent = '';
            };
            row.appendChild(btn);
            box.appendChild(row);
        });
        document.querySelector('[data-tab="tab-torrent"]').click();
    }

    async function resolveAndLoad(url, addToQueueOnly = false) {
        if (!url) return;
        $('upload-status').textContent = 'RESOLVING...';
        try {
            const resp = await fetch('/api/resolve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, torboxKey: state.torboxKey })
            });
            const data = await resp.json();
            if (data.error) throw new Error(data.error);

            if (data.torbox) {
                renderTorboxFiles(data.torbox);
                $('upload-status').textContent = '';
                return;
            }
            if (data.browserWebTorrent) {
                runBrowserWebTorrent(data.browserWebTorrent.magnet);
                return;
            }

            if (data.media) {
                if (addToQueueOnly) {
                    sendWs({ type: 'queue_add', item: { title: data.media.title, media: data.media } });
                } else {
                    sendWs({ type: 'media_load', media: data.media });
                }
                if (Array.isArray(data.playlistTracks)) {
                    data.playlistTracks.forEach(tr => {
                        sendWs({ type: 'queue_add', item: tr });
                    });
                }
                $('upload-status').textContent = '';
            }
        } catch (err) {
            $('upload-status').textContent = `ERR: ${err.message}`;
        }
    }

    $('btn-play-url').onclick = () => resolveAndLoad($('input-media-url').value.trim(), false);
    $('btn-queue-url').onclick = () => resolveAndLoad($('input-media-url').value.trim(), true);

    $('input-torrent-file').onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        $('upload-status').textContent = 'LOADING TORRENT...';
        const fd = new FormData();
        fd.append('torrent', file);
        fd.append('torboxKey', state.torboxKey);
        try {
            const resp = await fetch('/api/torrent/upload', { method: 'POST', body: fd });
            const data = await resp.json();
            if (data.error) throw new Error(data.error);
            if (data.torbox) {
                renderTorboxFiles(data.torbox);
                $('upload-status').textContent = '';
            } else if (data.browserWebTorrentBase64) {
                const bin = atob(data.browserWebTorrentBase64);
                const arr = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
                runBrowserWebTorrent(new Blob([arr]));
            }
        } catch (err) {
            $('upload-status').textContent = `ERR: ${err.message}`;
        }
    };

    $('input-p2p-media').onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        state.localP2pFile = file;
        sendWs({
            type: 'media_load',
            media: {
                mode: 'p2p_file',
                title: `P2P // ${file.name}`,
                src: `p2p:${file.name}:${file.size}`,
                audioSrc: '',
                qualities: [],
                audioTracks: [],
                subtitles: [],
                p2pHostId: state.clientId,
                p2pFile: { name: file.name, size: file.size, type: file.type }
            }
        });
    };

    $('input-local-media').onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        $('upload-status').textContent = 'UPLOADING...';
        const fd = new FormData();
        fd.append('media', file);
        try {
            const resp = await fetch('/api/upload-media', { method: 'POST', body: fd });
            const data = await resp.json();
            if (data.error) throw new Error(data.error);
            sendWs({ type: 'media_load', media: data.media });
            $('upload-status').textContent = '';
        } catch (err) {
            $('upload-status').textContent = `ERR: ${err.message}`;
        }
    };

    $('btn-search').onclick = async () => {
        const q = $('input-search').value.trim();
        if (!q) return;
        const box = $('search-results');
        box.innerHTML = '<div class="empty-hint">SEARCHING...</div>';
        try {
            const resp = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
            const data = await resp.json();
            box.innerHTML = '';
            (data.results || []).forEach(r => {
                const row = document.createElement('div');
                row.className = 'list-item';
                const title = document.createElement('span');
                title.className = 'list-item-title';
                title.textContent = `[${r.duration || '--:--'}] ${r.title} (${r.channel})`;
                const acts = document.createElement('div');
                acts.className = 'list-item-actions';

                const bPlay = document.createElement('button');
                bPlay.className = 'btn-xs';
                bPlay.textContent = 'PLAY';
                bPlay.onclick = () => resolveAndLoad(r.url, false);

                const bQueue = document.createElement('button');
                bQueue.className = 'btn-xs';
                bQueue.textContent = '+QUEUE';
                bQueue.onclick = () => sendWs({ type: 'queue_add', item: { title: r.title, videoId: r.videoId, url: r.url } });

                acts.append(bPlay, bQueue);
                row.append(title, acts);
                box.appendChild(row);
            });
        } catch {
            box.innerHTML = '<div class="empty-hint">SEARCH ERROR</div>';
        }
    };

    $('input-search').onkeydown = (e) => { if (e.key === 'Enter') $('btn-search').click(); };

    function renderQueue(queue) {
        const box = $('queue-list');
        box.innerHTML = '';
        queue.forEach(q => {
            const row = document.createElement('div');
            row.className = 'list-item';
            row.innerHTML = `<span class="list-item-title">${q.title} [${q.addedBy}]</span>`;
            const acts = document.createElement('div');
            acts.className = 'list-item-actions';

            const bPlay = document.createElement('button');
            bPlay.className = 'btn-xs';
            bPlay.textContent = 'PLAY';
            bPlay.onclick = () => sendWs({ type: 'queue_next', id: q.id });

            const bUp = document.createElement('button');
            bUp.className = 'btn-xs';
            bUp.textContent = '▲';
            bUp.onclick = () => sendWs({ type: 'queue_move', id: q.id, dir: -1 });

            const bDn = document.createElement('button');
            bDn.className = 'btn-xs';
            bDn.textContent = '▼';
            bDn.onclick = () => sendWs({ type: 'queue_move', id: q.id, dir: 1 });

            const bDel = document.createElement('button');
            bDel.className = 'btn-xs';
            bDel.textContent = 'X';
            bDel.onclick = () => sendWs({ type: 'queue_remove', id: q.id });

            acts.append(bPlay, bUp, bDn, bDel);
            row.appendChild(acts);
            box.appendChild(row);
        });
    }

    $('btn-play-next').onclick = () => sendWs({ type: 'queue_next' });
    $('btn-clear-queue').onclick = () => sendWs({ type: 'queue_clear' });

    function loadPlaylistsUI() {
        const box = $('playlists-list');
        box.innerHTML = '';
        const saved = JSON.parse(localStorage.getItem('voidsync_playlists') || '{}');
        Object.entries(saved).forEach(([name, items]) => {
            const row = document.createElement('div');
            row.className = 'list-item';
            row.innerHTML = `<span class="list-item-title">${name} (${items.length})</span>`;
            const acts = document.createElement('div');
            acts.className = 'list-item-actions';
            const bLoad = document.createElement('button');
            bLoad.className = 'btn-xs';
            bLoad.textContent = 'LOAD';
            bLoad.onclick = () => items.forEach(it => sendWs({ type: 'queue_add', item: it }));
            const bDel = document.createElement('button');
            bDel.className = 'btn-xs';
            bDel.textContent = 'X';
            bDel.onclick = () => {
                delete saved[name];
                localStorage.setItem('voidsync_playlists', JSON.stringify(saved));
                loadPlaylistsUI();
            };
            acts.append(bLoad, bDel);
            row.appendChild(acts);
            box.appendChild(row);
        });
    }

    $('btn-save-playlist').onclick = () => {
        const name = $('input-playlist-name').value.trim();
        if (!name) return;
        const rows = Array.from(document.querySelectorAll('#queue-list .list-item-title')).map(el => ({
            title: el.textContent,
            url: $('input-media-url').value.trim()
        }));
        const saved = JSON.parse(localStorage.getItem('voidsync_playlists') || '{}');
        saved[name] = rows;
        localStorage.setItem('voidsync_playlists', JSON.stringify(saved));
        $('input-playlist-name').value = '';
        loadPlaylistsUI();
    };
    loadPlaylistsUI();

    function renderUsers(users) {
        $('user-count').textContent = users.length;
        const box = $('users-list');
        box.innerHTML = '';
        users.forEach(u => {
            const row = document.createElement('div');
            row.className = 'user-row';
            const info = document.createElement('div');
            info.className = 'user-info';

            const dot = document.createElement('span');
            dot.id = `speak-dot-${u.id}`;
            dot.className = 'speaking-dot hidden';

            const label = document.createElement('span');
            const tags = [];
            if (u.isHost) tags.push('HOST');
            if (u.inVoice) tags.push(u.micMuted ? 'MUTED' : 'MIC');
            if (u.buffering) tags.push('BUF');
            label.textContent = `${u.nick}${u.id === state.clientId ? ' (YOU)' : ''} ${tags.length ? '[' + tags.join('/') + ']' : ''}`;

            info.append(dot, label);
            row.appendChild(info);

            if (u.inVoice && u.id !== state.clientId) {
                const vol = document.createElement('input');
                vol.type = 'range';
                vol.className = 'peer-vol';
                vol.min = '0';
                vol.max = '2';
                vol.step = '0.05';
                vol.value = String(state.peerVolumes[u.id] ?? 1);
                vol.oninput = (e) => {
                    const val = parseFloat(e.target.value);
                    state.peerVolumes[u.id] = val;
                    const peer = state.voicePeers.get(u.id);
                    if (peer && peer.gainNode) peer.gainNode.gain.value = state.deafened ? 0 : val;
                };
                row.appendChild(vol);
            }
            box.appendChild(row);
        });
    }

    const RTC_CONF = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };

    async function toggleJoinVoice() {
        unlockMediaContext();
        if (state.inVoice) {
            state.inVoice = false;
            state.micMuted = true;
            if (state.localVoiceStream) {
                state.localVoiceStream.getTracks().forEach(t => t.stop());
                state.localVoiceStream = null;
            }
            for (const [pid, p] of state.voicePeers.entries()) {
                p.pc.close();
                if (p.audioEl) p.audioEl.remove();
                state.voicePeers.delete(pid);
            }
            $('btn-voice-join').textContent = 'JOIN VOICE';
            $('btn-mic-toggle').classList.add('hidden');
            $('btn-deafen').classList.add('hidden');
            sendWs({ type: 'voice_state', inVoice: false, micMuted: true });
            return;
        }

        try {
            state.localVoiceStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            });
            state.inVoice = true;
            state.micMuted = false;
            $('btn-voice-join').textContent = 'LEAVE VOICE';
            $('btn-mic-toggle').classList.remove('hidden');
            $('btn-mic-toggle').textContent = 'MIC: ON';
            $('btn-mic-toggle').classList.add('active-state');
            $('btn-deafen').classList.remove('hidden');
            sendWs({ type: 'voice_state', inVoice: true, micMuted: false });
        } catch {
            alert('MICROPHONE ACCESS DENIED');
        }
    }

    $('btn-voice-join').onclick = toggleJoinVoice;

    $('btn-mic-toggle').onclick = () => {
        if (!state.localVoiceStream) return;
        state.micMuted = !state.micMuted;
        state.localVoiceStream.getAudioTracks().forEach(t => { t.enabled = !state.micMuted; });
        $('btn-mic-toggle').textContent = state.micMuted ? 'MIC: OFF' : 'MIC: ON';
        $('btn-mic-toggle').classList.toggle('active-state', !state.micMuted);
        sendWs({ type: 'voice_state', inVoice: true, micMuted: state.micMuted });
    };

    $('btn-deafen').onclick = () => {
        state.deafened = !state.deafened;
        $('btn-deafen').textContent = state.deafened ? 'AUDIO: OFF' : 'AUDIO: ON';
        for (const [pid, p] of state.voicePeers.entries()) {
            if (p.gainNode) p.gainNode.gain.value = state.deafened ? 0 : (state.peerVolumes[pid] ?? 1);
        }
    };

    async function syncVoiceMesh(users) {
        if (!state.inVoice) return;
        const activeIds = new Set(users.filter(u => u.inVoice && u.id !== state.clientId).map(u => u.id));
        for (const pid of state.voicePeers.keys()) {
            if (!activeIds.has(pid)) {
                const p = state.voicePeers.get(pid);
                p.pc.close();
                if (p.audioEl) p.audioEl.remove();
                state.voicePeers.delete(pid);
            }
        }
        for (const uid of activeIds) {
            if (!state.voicePeers.has(uid) && state.clientId < uid) {
                const p = createVoicePeer(uid);
                const offer = await p.pc.createOffer();
                await p.pc.setLocalDescription(offer);
                sendWs({ type: 'rtc_signal', targetId: uid, channel: 'voice', data: { sdp: offer } });
            }
        }
    }

    function createVoicePeer(peerId) {
        const pc = new RTCPeerConnection(RTC_CONF);
        const peerObj = { pc, audioEl: null, gainNode: null };
        state.voicePeers.set(peerId, peerObj);

        if (state.localVoiceStream) {
            state.localVoiceStream.getTracks().forEach(t => pc.addTrack(t, state.localVoiceStream));
        }

        pc.onicecandidate = (e) => {
            if (e.candidate) sendWs({ type: 'rtc_signal', targetId: peerId, channel: 'voice', data: { candidate: e.candidate } });
        };

        pc.ontrack = (e) => {
            const stream = e.streams[0];
            const audio = document.createElement('audio');
            audio.srcObject = stream;
            audio.autoplay = true;
            $('voice-audio-container').appendChild(audio);
            peerObj.audioEl = audio;

            if (state.audioCtx) {
                try {
                    const src = state.audioCtx.createMediaStreamSource(stream);
                    const gain = state.audioCtx.createGain();
                    const analyser = state.audioCtx.createAnalyser();
                    analyser.fftSize = 32;
                    gain.gain.value = state.deafened ? 0 : (state.peerVolumes[peerId] ?? 1);
                    src.connect(analyser);
                    analyser.connect(gain);
                    gain.connect(state.audioCtx.destination);
                    audio.muted = true;
                    peerObj.gainNode = gain;

                    const data = new Uint8Array(analyser.frequencyBinCount);
                    const checkSpeak = () => {
                        if (!state.voicePeers.has(peerId)) return;
                        analyser.getByteFrequencyData(data);
                        const avg = data.reduce((a, b) => a + b, 0) / data.length;
                        const dot = $(`speak-dot-${peerId}`);
                        if (dot) dot.classList.toggle('hidden', avg < 18);
                        requestAnimationFrame(checkSpeak);
                    };
                    checkSpeak();
                } catch {}
            }
        };
        return peerObj;
    }

    $('btn-share-screen').onclick = async () => {
        if (state.localScreenStream) {
            state.localScreenStream.getTracks().forEach(t => t.stop());
            state.localScreenStream = null;
            for (const pc of state.screenPeers.values()) pc.close();
            state.screenPeers.clear();
            $('btn-share-screen').textContent = 'SHARE SCREEN';
            sendWs({ type: 'media_load', media: { mode: 'idle', title: 'NO MEDIA LOADED', src: '' } });
            return;
        }
        try {
            state.localScreenStream = await navigator.mediaDevices.getDisplayMedia({
                video: { frameRate: { ideal: 60 } },
                audio: true
            });
            $('btn-share-screen').textContent = 'STOP SHARE';
            sendWs({ type: 'screen_share_start' });
            state.localScreenStream.getVideoTracks()[0].onended = () => {
                if (state.localScreenStream) $('btn-share-screen').click();
            };
        } catch {}
    };

    async function handleRtcSignal(msg) {
        const { senderId, channel, data } = msg;
        if (channel === 'voice') {
            let p = state.voicePeers.get(senderId);
            if (!p) p = createVoicePeer(senderId);
            if (data.sdp) {
                await p.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
                if (data.sdp.type === 'offer') {
                    const ans = await p.pc.createAnswer();
                    await p.pc.setLocalDescription(ans);
                    sendWs({ type: 'rtc_signal', targetId: senderId, channel: 'voice', data: { sdp: ans } });
                }
            } else if (data.candidate) {
                await p.pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
            }
        } else if (channel === 'screen') {
            if (data.requestStream && state.localScreenStream) {
                const pc = new RTCPeerConnection(RTC_CONF);
                state.screenPeers.set(senderId, pc);
                state.localScreenStream.getTracks().forEach(t => pc.addTrack(t, state.localScreenStream));
                pc.onicecandidate = e => {
                    if (e.candidate) sendWs({ type: 'rtc_signal', targetId: senderId, channel: 'screen', data: { candidate: e.candidate } });
                };
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                sendWs({ type: 'rtc_signal', targetId: senderId, channel: 'screen', data: { sdp: offer } });
            } else if (data.sdp) {
                let pc = state.screenPeers.get(senderId);
                if (!pc) {
                    pc = new RTCPeerConnection(RTC_CONF);
                    state.screenPeers.set(senderId, pc);
                    pc.onicecandidate = e => {
                        if (e.candidate) sendWs({ type: 'rtc_signal', targetId: senderId, channel: 'screen', data: { candidate: e.candidate } });
                    };
                    pc.ontrack = e => {
                        videoEl.srcObject = e.streams[0];
                        safePlay(videoEl);
                    };
                }
                await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
                if (data.sdp.type === 'offer') {
                    const ans = await pc.createAnswer();
                    await pc.setLocalDescription(ans);
                    sendWs({ type: 'rtc_signal', targetId: senderId, channel: 'screen', data: { sdp: ans } });
                }
            } else if (data.candidate) {
                const pc = state.screenPeers.get(senderId);
                if (pc) await pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
            }
        } else if (channel === 'file') {
            if (data.requestFile && state.localP2pFile) {
                const pc = new RTCPeerConnection(RTC_CONF);
                state.filePeers.set(senderId, pc);
                const dc = pc.createDataChannel('file');
                dc.bufferedAmountLowThreshold = 512 * 1024;
                pc.onicecandidate = e => {
                    if (e.candidate) sendWs({ type: 'rtc_signal', targetId: senderId, channel: 'file', data: { candidate: e.candidate } });
                };
                dc.onopen = async () => {
                    const file = state.localP2pFile;
                    const chunkSize = 65536;
                    let offset = 0;
                    const pump = async () => {
                        while (offset < file.size && dc.bufferedAmount < 4 * 1024 * 1024) {
                            const slice = file.slice(offset, offset + chunkSize);
                            const buf = await slice.arrayBuffer();
                            dc.send(buf);
                            offset += chunkSize;
                        }
                        if (offset >= file.size) {
                            dc.send('__EOF__');
                        }
                    };
                    dc.onbufferedamountlow = pump;
                    pump();
                };
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                sendWs({ type: 'rtc_signal', targetId: senderId, channel: 'file', data: { sdp: offer } });
            } else if (data.sdp) {
                let pc = state.filePeers.get(senderId);
                if (!pc) {
                    pc = new RTCPeerConnection(RTC_CONF);
                    state.filePeers.set(senderId, pc);
                    pc.onicecandidate = e => {
                        if (e.candidate) sendWs({ type: 'rtc_signal', targetId: senderId, channel: 'file', data: { candidate: e.candidate } });
                    };
                    pc.ondatachannel = (ev) => {
                        const dc = ev.channel;
                        const chunks = [];
                        let received = 0;
                        const total = state.media.p2pFile?.size || 1;
                        dc.onmessage = (m) => {
                            if (m.data === '__EOF__') {
                                const blob = new Blob(chunks, { type: state.media.p2pFile?.type || 'video/mp4' });
                                videoEl.src = URL.createObjectURL(blob);
                                $('p2p-transfer-overlay').classList.add('hidden');
                                applySyncToPlayer(true);
                                return;
                            }
                            chunks.push(m.data);
                            received += m.data.byteLength;
                            const pct = Math.min(100, Math.round((received / total) * 100));
                            $('p2p-transfer-overlay').textContent = `RECEIVING P2P FILE: ${pct}% (${(received / 1048576).toFixed(1)} MB)`;
                        };
                    };
                }
                await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
                if (data.sdp.type === 'offer') {
                    const ans = await pc.createAnswer();
                    await pc.setLocalDescription(ans);
                    sendWs({ type: 'rtc_signal', targetId: senderId, channel: 'file', data: { sdp: ans } });
                }
            } else if (data.candidate) {
                const pc = state.filePeers.get(senderId);
                if (pc) await pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
            }
        }
    }

    function closePeer(peerId) {
        if (state.voicePeers.has(peerId)) {
            const p = state.voicePeers.get(peerId);
            p.pc.close();
            if (p.audioEl) p.audioEl.remove();
            state.voicePeers.delete(peerId);
        }
        if (state.screenPeers.has(peerId)) {
            state.screenPeers.get(peerId).close();
            state.screenPeers.delete(peerId);
        }
        if (state.filePeers.has(peerId)) {
            state.filePeers.get(peerId).close();
            state.filePeers.delete(peerId);
        }
    }

    const REACTION_SET = ['♥', '🔥', '😂', '👍', '👎', '😮'];

    function appendChatMessage(msg) {
        const box = $('chat-messages');
        const card = document.createElement('div');
        card.className = 'msg-card';
        card.id = `msg-${msg.id}`;

        const meta = document.createElement('div');
        meta.className = 'msg-meta';
        const d = new Date(msg.time);
        meta.innerHTML = `<span class="msg-nick">${escapeHtml(msg.nick)}</span><span>${d.toTimeString().slice(0, 5)}</span>`;
        card.appendChild(meta);

        if (msg.text) {
            const txt = document.createElement('div');
            txt.className = 'msg-text';
            txt.textContent = msg.text;
            card.appendChild(txt);
        }

        if (msg.file) {
            const mediaBox = document.createElement('div');
            mediaBox.className = 'msg-media';
            const mime = msg.file.mime || '';
            if (mime.startsWith('image/')) {
                const img = document.createElement('img');
                img.src = msg.file.url;
                img.onclick = () => window.open(msg.file.url, '_blank');
                mediaBox.appendChild(img);
            } else if (mime.startsWith('video/')) {
                const vid = document.createElement('video');
                vid.src = msg.file.url;
                vid.controls = true;
                mediaBox.appendChild(vid);
            } else if (mime.startsWith('audio/')) {
                const aud = document.createElement('audio');
                aud.src = msg.file.url;
                aud.controls = true;
                mediaBox.appendChild(aud);
            } else {
                const a = document.createElement('a');
                a.href = msg.file.url;
                a.download = msg.file.originalName;
                a.className = 'msg-file-link';
                a.textContent = `FILE: ${msg.file.originalName} (${(msg.file.size / 1024).toFixed(1)} KB)`;
                mediaBox.appendChild(a);
            }
            card.appendChild(mediaBox);
        }

        const reactRow = document.createElement('div');
        reactRow.className = 'msg-reactions';
        reactRow.id = `reacts-${msg.id}`;

        const picker = document.createElement('div');
        picker.className = 'react-picker';
        REACTION_SET.forEach(em => {
            const b = document.createElement('button');
            b.className = 'react-btn';
            b.textContent = em;
            b.onclick = () => sendWs({ type: 'chat_react', messageId: msg.id, emoji: em });
            picker.appendChild(b);
        });

        card.append(reactRow, picker);
        box.appendChild(card);
        renderMessageReactions(reactRow, msg.id, msg.reactions || {});
        box.scrollTop = box.scrollHeight;
    }

    function updateMessageReactions(messageId, reactions) {
        const container = $(`reacts-${messageId}`);
        if (container) renderMessageReactions(container, messageId, reactions);
    }

    function renderMessageReactions(container, messageId, reactions) {
        container.innerHTML = '';
        Object.entries(reactions).forEach(([em, users]) => {
            const b = document.createElement('button');
            b.className = 'react-btn' + (users.includes(state.clientId) ? ' mine' : '');
            b.textContent = `${em} ${users.length}`;
            b.onclick = () => sendWs({ type: 'chat_react', messageId, emoji: em });
            container.appendChild(b);
        });
    }

    function escapeHtml(str) {
        return str.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
    }

    function sendChatText() {
        const inp = $('input-chat');
        const text = inp.value.trim();
        if (!text) return;
        sendWs({ type: 'chat_msg', kind: 'text', text });
        inp.value = '';
    }

    $('btn-chat-send').onclick = sendChatText;
    $('input-chat').onkeydown = (e) => { if (e.key === 'Enter') sendChatText(); };

    async function uploadChatFile(file) {
        if (!file) return;
        $('chat-upload-progress').textContent = 'UPLOADING...';
        const fd = new FormData();
        fd.append('file', file);
        try {
            const resp = await fetch('/api/chat/upload', { method: 'POST', body: fd });
            const info = await resp.json();
            if (info.url) sendWs({ type: 'chat_msg', kind: 'file', text: '', file: info });
        } finally {
            $('chat-upload-progress').textContent = '';
        }
    }

    $('input-chat-file').onchange = (e) => {
        if (e.target.files[0]) uploadChatFile(e.target.files[0]);
        e.target.value = '';
    };

    $('chat-drop-zone').ondragover = (e) => e.preventDefault();
    $('chat-drop-zone').ondrop = (e) => {
        e.preventDefault();
        if (e.dataTransfer.files[0]) uploadChatFile(e.dataTransfer.files[0]);
    };

    $('input-chat').onpaste = (e) => {
        const items = e.clipboardData?.items || [];
        for (const item of items) {
            if (item.kind === 'file') uploadChatFile(item.getAsFile());
        }
    };

    $('btn-voice-msg').onclick = async () => {
        if (state.isRecording && state.recorder) {
            state.recorder.stop();
            state.isRecording = false;
            clearInterval(state.recTimer);
            $('btn-voice-msg').textContent = 'REC';
            $('btn-voice-msg').classList.remove('active-state');
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            state.recChunks = [];
            state.recorder = new MediaRecorder(stream);
            state.recorder.ondataavailable = e => { if (e.data.size > 0) state.recChunks.push(e.data); };
            state.recorder.onstop = () => {
                stream.getTracks().forEach(t => t.stop());
                const blob = new Blob(state.recChunks, { type: 'audio/webm' });
                const file = new File([blob], `voice_${Date.now()}.webm`, { type: 'audio/webm' });
                uploadChatFile(file);
            };
            state.recorder.start();
            state.isRecording = true;
            state.recSeconds = 0;
            $('btn-voice-msg').textContent = '0:00';
            $('btn-voice-msg').classList.add('active-state');
            state.recTimer = setInterval(() => {
                state.recSeconds++;
                $('btn-voice-msg').textContent = formatTime(state.recSeconds);
            }, 1000);
        } catch {
            alert('MIC DENIED');
        }
    };

    function updateBufferLockUI() {
        $('btn-buffer-lock').textContent = `BUFFER LOCK: ${state.bufferLock ? 'ON' : 'OFF'}`;
        $('btn-buffer-lock').classList.toggle('active-state', state.bufferLock);
    }

    $('btn-buffer-lock').onclick = () => {
        sendWs({ type: 'toggle_buffer_lock', enabled: !state.bufferLock });
    };

    $('btn-copy-link').onclick = () => {
        navigator.clipboard.writeText(window.location.href).then(() => {
            $('btn-copy-link').textContent = 'COPIED';
            setTimeout(() => { $('btn-copy-link').textContent = 'COPY LINK'; }, 1500);
        });
    };

    $('btn-save-nick').onclick = () => {
        const nick = $('inline-nick').value.trim();
        if (!nick) return;
        state.nick = nick;
        localStorage.setItem('voidsync_nick', nick);
        sendWs({ type: 'set_nick', nick });
    };

    $('btn-enter').onclick = () => {
        const nick = $('gate-nick').value.trim() || 'USER_' + Math.floor(Math.random() * 999);
        const room = ($('gate-room').value.trim() || genRoomCode()).toUpperCase();
        unlockMediaContext();
        requestWakeLock();
        $('gate-overlay').classList.add('hidden');
        $('app').classList.remove('hidden');
        connectRoom(room, nick);
    };
})();

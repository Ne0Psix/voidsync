// ==UserScript==
// @name         VOID // SYNC DRM BRIDGE
// @version      1.0
// @match        *://*.netflix.com/*
// @match        *://*.kinopoisk.ru/*
// @match        *://*.crunchyroll.com/*
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';
    if (window.top !== window.self) return;

    const btn = document.createElement('button');
    btn.textContent = 'VOID SYNC';
    btn.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:999999;background:#000;color:#fff;border:1px solid #fff;padding:6px 10px;font-family:monospace;font-size:12px;cursor:pointer;';
    document.body.appendChild(btn);

    let ws = null;
    let clockOffset = 0;
    let ignoreEvents = false;

    btn.onclick = () => {
        if (ws) { ws.close(); ws = null; btn.textContent = 'VOID SYNC'; return; }
        const wsUrl = prompt('WS URL (e.g. wss://your-app.onrender.com):');
        const roomId = prompt('ROOM CODE:');
        const nick = prompt('NICKNAME:', 'BRIDGE');
        if (!wsUrl || !roomId) return;

        ws = new WebSocket(wsUrl);
        ws.onopen = () => {
            btn.textContent = 'SYNCED [' + roomId.toUpperCase() + ']';
            ws.send(JSON.stringify({ type: 'ping', clientSendTime: Date.now() }));
            ws.send(JSON.stringify({ type: 'join', roomId, nick }));
            bindVideo();
        };
        ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'pong') {
                const rtt = Date.now() - msg.clientSendTime;
                clockOffset = (msg.serverTime + rtt / 2) - Date.now();
            } else if (msg.type === 'media_sync' || msg.type === 'sync_pulse') {
                applySync(msg.media);
            }
        };
        ws.onclose = () => { btn.textContent = 'VOID SYNC'; ws = null; };
    };

    function getVideo() {
        return document.querySelector('video');
    }

    function applySync(media) {
        const v = getVideo();
        if (!v || !media) return;
        const serverNow = Date.now() + clockOffset;
        const expected = media.isPlaying
            ? media.baseTime + ((serverNow - media.updatedAt) / 1000) * media.playbackRate
            : media.baseTime;

        ignoreEvents = true;
        if (media.isPlaying && v.paused) v.play().catch(() => {});
        if (!media.isPlaying && !v.paused) v.pause();

        const diff = expected - v.currentTime;
        if (Math.abs(diff) > 0.4) {
            v.currentTime = expected;
        }
        if (v.playbackRate !== media.playbackRate) {
            v.playbackRate = media.playbackRate;
        }
        setTimeout(() => { ignoreEvents = false; }, 150);
    }

    function bindVideo() {
        const v = getVideo();
        if (!v) return setTimeout(bindVideo, 1000);
        const emit = (action) => {
            if (ignoreEvents || !ws || ws.readyState !== 1) return;
            ws.send(JSON.stringify({ type: 'media_control', action, time: v.currentTime }));
        };
        v.addEventListener('play', () => emit('play'));
        v.addEventListener('pause', () => emit('pause'));
        v.addEventListener('seeked', () => emit('seek'));
    }
})();

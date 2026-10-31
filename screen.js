(() => {
    'use strict';

    // Page rendue sur l'écran de la TV (DUI). Reçoit des messages de client/screen.lua :
    //   { action:'apply', platform, kind, embed, playing, position, volume, muted }
    //   { action:'volume', volume, muted }

    const stage = document.getElementById('stage');
    const overlay = document.getElementById('overlay');

    let cur = { key: null };
    let desired = null;
    let volume = 50;

    let yt = null, ytReady = false;
    let ttFrame = null, ttReady = false, ttTime = 0, ttDuration = 0;
    let kickFrame = null, kickMuted = false;

    const showMsg = (t) => { overlay.textContent = t; overlay.classList.remove('hidden'); };
    const hideMsg = () => overlay.classList.add('hidden');

    function clearStage() {
        stage.innerHTML = '';
        yt = null; ytReady = false;
        ttFrame = null; ttReady = false; ttTime = 0; ttDuration = 0;
        kickFrame = null;
        hideMsg();
    }

    const keyOf = (d) => d.platform + ':' + d.kind + ':' + d.embed;

    // =========================================================== YouTube
    let ytApiState = 0; // 0 = non chargée, 1 = en cours, 2 = prête
    const ytWaiters = [];

    function whenYT(cb) {
        if (ytApiState === 2) return cb();
        ytWaiters.push(cb);
        if (ytApiState === 1) return;
        ytApiState = 1;
        window.onYouTubeIframeAPIReady = () => {
            ytApiState = 2;
            while (ytWaiters.length) ytWaiters.shift()();
        };
        const s = document.createElement('script');
        s.src = 'https://www.youtube.com/iframe_api';
        s.onerror = () => showMsg('Impossible de joindre YouTube.');
        document.head.appendChild(s);
    }

    const YT_ERRORS = {
        2: 'Lien YouTube invalide.',
        5: 'Erreur du lecteur YouTube.',
        100: 'Vidéo introuvable ou privée.',
        101: "Lecture intégrée interdite par l'auteur de la vidéo.",
        150: "Lecture intégrée interdite par l'auteur de la vidéo.",
        153: "YouTube refuse la lecture : la page de l'écran doit être hébergée en HTTPS (Config.ScreenUrl, voir README.md).",
    };

    function buildYoutube(d, alt) {
        stage.innerHTML = '<div id="yt"></div>';
        const myKey = keyOf(d);
        whenYT(() => {
            if (cur.key !== myKey) return;
            const vars = {
                autoplay: 1, controls: 0, disablekb: 1, fs: 0, rel: 0, modestbranding: 1,
                iv_load_policy: 3, playsinline: 1, start: Math.max(0, Math.floor(d.position || 0)),
            };
            if (location.protocol.indexOf('http') === 0) {
                vars.origin = location.origin;
                vars.widget_referrer = location.href;
            }
            yt = new YT.Player('yt', {
                // 1re tentative : youtube-nocookie ; si erreur 153, 2e tentative sur youtube.com
                host: alt ? 'https://www.youtube.com' : 'https://www.youtube-nocookie.com',
                width: '100%', height: '100%', videoId: d.embed, playerVars: vars,
                events: {
                    onReady: () => { ytReady = true; try { yt.setVolume(volume); } catch (e) {} syncYoutube(desired); },
                    onError: (ev) => {
                        if (ev.data === 153 && !alt) {
                            yt = null; ytReady = false;
                            buildYoutube(d, true);
                            return;
                        }
                        let m = YT_ERRORS[ev.data] || ('Erreur YouTube (' + ev.data + ')');
                        // page réellement chargée, pour le diagnostic
                        if (ev.data === 153) m += ' [page : ' + location.href + ']';
                        showMsg(m);
                    },
                },
            });
        });
    }

    function syncYoutube(d) {
        if (!yt || !ytReady || !d) return;
        try {
            yt.setVolume(volume);
            const t = yt.getCurrentTime ? yt.getCurrentTime() : 0;
            const drift = Math.abs(t - d.position);
            if (d.playing) {
                if (drift > 2.5) yt.seekTo(d.position, true);
                yt.playVideo();
            } else {
                yt.pauseVideo();
                if (drift > 1) yt.seekTo(d.position, true);
            }
        } catch (e) { /* lecteur pas encore prêt */ }
    }

    // =========================================================== Kick
    // Le lecteur Kick n'a pas d'API : pause = on décharge l'iframe, muet = paramètre d'URL.
    function buildKick(d) {
        stage.innerHTML = '';
        kickFrame = null;
        kickMuted = !!d.muted;
        if (!d.playing) { showMsg('⏸ En pause'); return; }
        hideMsg();
        const base = d.kind === 'vod' ? 'https://player.kick.com/video/' : 'https://player.kick.com/';
        const f = document.createElement('iframe');
        f.src = base + encodeURIComponent(d.embed) + '?autoplay=true' + (kickMuted ? '&muted=true' : '');
        f.allow = 'autoplay; fullscreen; encrypted-media';
        f.setAttribute('scrolling', 'no');
        f.setAttribute('frameborder', '0');
        stage.appendChild(f);
        kickFrame = f;
    }

    function syncKick(d) {
        if (!!d.playing !== !!kickFrame || !!d.muted !== kickMuted) buildKick(d);
    }

    // =========================================================== TikTok
    function ttSend(type, value) {
        if (!ttFrame || !ttFrame.contentWindow) return;
        const m = { 'x-tiktok-player': true, type: type };
        if (value !== undefined) m.value = value;
        ttFrame.contentWindow.postMessage(m, '*');
    }

    function buildTikTok(d) {
        stage.innerHTML = '';
        ttReady = false;
        const f = document.createElement('iframe');
        const q = 'autoplay=1&loop=1&controls=0&music_info=0&description=0&rel=0&native_context_menu=0&closed_caption=0';
        f.src = 'https://www.tiktok.com/player/v1/' + encodeURIComponent(d.embed) + '?' + q;
        f.allow = 'autoplay; fullscreen; encrypted-media';
        f.setAttribute('scrolling', 'no');
        f.setAttribute('frameborder', '0');
        stage.appendChild(f);
        ttFrame = f;
        // Si TikTok ne répond jamais (vidéo non intégrable, lien invalide), on le dit au lieu de laisser un écran noir
        setTimeout(() => {
            if (ttFrame === f && !ttReady && cur.key === keyOf(d)) showMsg('TikTok ne répond pas : vidéo privée, supprimée ou intégration interdite.');
        }, 15000);
        // Filet de sécurité si l'événement onPlayerReady n'arrive pas
        f.addEventListener('load', () => setTimeout(() => {
            if (ttFrame === f && !ttReady) { ttReady = true; syncTikTok(desired); }
        }, 1500));
    }

    function syncTikTok(d) {
        if (!ttReady || !d) return;
        ttSend(d.muted || volume <= 0 ? 'mute' : 'unMute');
        let pos = d.position || 0;
        if (ttDuration > 0) pos = pos % ttDuration;   // la vidéo boucle
        if (d.playing) {
            if (Math.abs(ttTime - pos) > 3) ttSend('seekTo', pos);
            ttSend('play');
        } else {
            ttSend('pause');
        }
    }

    function onTikTok(m) {
        switch (m.type) {
            case 'onPlayerReady': ttReady = true; hideMsg(); syncTikTok(desired); break;
            case 'onCurrentTime': {
                const v = (m.value && typeof m.value === 'object') ? m.value : m;
                if (typeof v.currentTime === 'number') ttTime = v.currentTime;
                if (typeof v.duration === 'number' && v.duration > 0) ttDuration = v.duration;
                break;
            }
            case 'onPlayerError':
                showMsg('Vidéo TikTok indisponible.');
                break;
        }
    }

    // =========================================================== Orchestration
    function apply(d) {
        desired = d;
        volume = d.volume;
        const key = keyOf(d);
        if (key !== cur.key) {
            cur = { key: key };
            clearStage();
            if (d.platform === 'youtube') buildYoutube(d);
            else if (d.platform === 'kick') buildKick(d);
            else if (d.platform === 'tiktok') buildTikTok(d);
            return;
        }
        if (d.platform === 'youtube') syncYoutube(d);
        else if (d.platform === 'kick') syncKick(d);
        else if (d.platform === 'tiktok') syncTikTok(d);
    }

    function setVolume(d) {
        volume = d.volume;
        if (desired) { desired.volume = d.volume; desired.muted = d.muted; }
        if (!desired) return;
        if (desired.platform === 'youtube' && yt && ytReady) { try { yt.setVolume(volume); } catch (e) {} }
        else if (desired.platform === 'tiktok') syncTikTok(desired);
        // Kick : pas de contrôle du niveau, seul l'état muet (recharge uniquement si « muet » change)
        else if (desired.platform === 'kick') syncKick(desired);
    }

    window.addEventListener('message', (e) => {
        let d = e.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch (err) { return; } }
        if (!d || typeof d !== 'object') return;

        // Les iframes tierces ne peuvent pas piloter l'écran : seuls leurs événements TikTok sont lus.
        const fromFrame = e.source && e.source !== window &&
            Array.prototype.some.call(stage.querySelectorAll('iframe'), (f) => f.contentWindow === e.source);
        if (fromFrame) {
            if (d['x-tiktok-player']) onTikTok(d);
            return;
        }

        switch (d.action) {
            case 'apply': apply(d); break;
            case 'volume': setVolume(d); break;
            case 'stop': cur = { key: null }; desired = null; clearStage(); break;
        }
    });
})();

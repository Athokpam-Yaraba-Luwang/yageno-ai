// SPDX-FileCopyrightText: Copyright (C) 2026 Athokpam Yaraba Luwang
// SPDX-License-Identifier: AGPL-3.0-or-later

(() => {
    'use strict';

    const apiBase = (() => {
        try {
            const s = document.currentScript && document.currentScript.src;
            if (s) return new URL('../', s).pathname.replace(/\/$/, '');
        } catch (e) { }
        return window.location.pathname.replace(/\/$/, '');
    })();

    const $ = id => document.getElementById(id);
    const appEl = $('app'), navBtn = $('devices-btn');
    if (!appEl || !navBtn) return;

    const POLL_MS = 2000;
    const STALE_AFTER = 20;                         // keep equal to STALE_AFTER in app.py
    const FAILS_BEFORE_LOST = 3;                    // one slow request is not a lost connection
    const TEMP_LOW = 20, TEMP_HIGH = 32, HUM_LOW = 30, HUM_HIGH = 70;   // same numbers as the sketch
    const DURATIONS = [[5, '5 seconds'], [60, '1 minute'], [600, '10 minutes']];
    const POWER_NOTE = 'Dear judges, Mark 1 is powered from my MacBook, so I cannot keep it running 24/7. It is switched on every day from 5 pm to 6 pm (IST). Outside that hour it shows as offline and you see the last readings it sent. Everything here is live whenever it is on.';

    const ic = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
    const I = {
        cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
        close: '<path d="M6 6l12 12M18 6 6 18"/>',
        info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
        plus: '<path d="M12 5v14M5 12h14"/>',
        chev: '<path d="m9 6 6 6-6 6"/>',
        flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
        radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M12 12 19 5"/>',
        sound: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
        shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
        sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
        temp: '<path d="M14 14.8V4a2 2 0 0 0-4 0v10.8a4 4 0 1 0 4 0z"/>',
        drop: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
        sprout: '<path d="M7 20h10"/><path d="M10 20c5.5-2.5.8-6.4 3-10"/><path d="M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8z"/><path d="M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2z"/>',
        shower: '<path d="M4 13a8 8 0 0 1 16 0z"/><path d="M8 17v2M12 17v3M16 17v2"/>',
        valve: '<path d="M3 12h18"/><path d="M8 12V7h8v5"/><path d="M10 7V4h4v3"/>',
        stick: '<circle cx="12" cy="7" r="3"/><path d="M12 10v6"/><rect x="7" y="16" width="10" height="5" rx="2"/>',
        bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'
    };

    const fmtAgo = s => {
        s = Math.max(0, Math.round(s));
        if (s < 60) return `${s}s`;
        const m = Math.floor(s / 60);
        if (s < 3600) return `${m}m ${s % 60}s`;
        const h = Math.floor(s / 3600);
        if (s < 86400) return `${h}h ${m % 60}m`;
        return `${Math.floor(s / 86400)}d ${h % 24}h`;
    };
    const who = by => by === 'yageno' ? 'Yageno AI' : '@' + by;

    /* ---------- cards ----------
       fn(r, x) -> { v: big value, u: unit, t: status line, s: 'warn' | 'on' | '' }.  r = reading, x = {cmds, el}.
       Moisture, temperature, humidity, light and irrigation come from the ESP32; r.esp = 0 means that link is down. */
    const NO = { v: '--', u: '', t: 'No data from the ESP32', s: '' };
    const viaEsp = f => (r, x) => (r.esp ? f(r, x) : NO);
    const left = (c, x) => (c && c.action === 'on' && c.seconds) ? Math.max(0, Math.round(c.seconds - c.ageSec - x.el)) : 0;
    const starting = (c, x) => c && c.action === 'on' && c.ageSec + x.el < 5;   // sent, Mark 1 has not reported it yet

    const timed = (label, field) => (r, x) => {
        const c = x.cmds[label.toLowerCase()], l = left(c, x);
        if (r[field]) return { v: 'On', u: '', s: 'on', t: l ? `${c.action === 'on' ? 'Started by ' + who(c.by) : 'On'}, ${fmtAgo(l)} left` : `${label} running` };
        if (starting(c, x)) return { v: 'Starting', u: '', s: 'on', t: `Sent by ${who(c.by)}` };
        return { v: 'Off', u: '', s: '', t: label === 'Irrigation' ? 'Automatic: runs when the soil is dry' : 'Idle' };
    };

    const GROUPS = [
        {
            title: 'Environment', cards: [
                {
                    key: 'temp', label: 'Temperature', icon: 'temp', fn: viaEsp(r => ({
                        v: r.temp, u: '°C', s: r.temp > TEMP_HIGH ? 'warn' : '',
                        t: r.temp > TEMP_HIGH ? `Hot, above ${TEMP_HIGH}°C` : r.temp < TEMP_LOW ? `Cool, below ${TEMP_LOW}°C` : `Within ${TEMP_LOW} to ${TEMP_HIGH}°C`
                    }))
                },
                {
                    key: 'hum', label: 'Humidity', icon: 'drop', fn: viaEsp(r => ({
                        v: r.hum, u: '%', s: '',
                        t: r.hum > HUM_HIGH ? `Humid, above ${HUM_HIGH}%` : r.hum < HUM_LOW ? `Dry air, below ${HUM_LOW}%` : `Within ${HUM_LOW} to ${HUM_HIGH}%`
                    }))
                },
                { key: 'moist', label: 'Soil moisture', icon: 'sprout', fn: viaEsp(r => ({ v: r.moist, u: '%', s: r.moist <= 30 ? 'warn' : '', t: r.moist <= 30 ? 'Dry, irrigation needed' : 'Latest soil probe reading' })) },
                { key: 'day', label: 'Light', icon: 'sun', fn: viaEsp(r => ({ v: r.day ? 'Day' : 'Night', u: '', s: '', t: 'From the light sensor' })) }
            ]
        },
        {
            title: 'Safety sensors', cards: [
                { key: 'fire', label: 'Flame', icon: 'flame', fn: r => r.fire ? { v: 'Flame', u: '', s: 'warn', t: 'Flame detected' } : { v: 'Clear', u: '', s: '', t: 'No flame' } },
                { key: 'aerial', label: 'Aerial radar', icon: 'radar', fn: r => r.aerial ? { v: 'Detected', u: '', s: 'warn', t: 'Birds or something airborne' } : { v: 'Clear', u: '', s: '', t: 'Nothing in the air' } },
                { key: 'sound', label: 'Sound', icon: 'sound', fn: r => r.sound ? { v: 'Detected', u: '', s: 'warn', t: 'Bird sound heard' } : { v: 'Quiet', u: '', s: '', t: 'No bird sound' } },
                { key: 'security', label: 'Fence', icon: 'shield', fn: r => ({ v: r.security ? 'Breach' : 'Secure', u: '', s: r.security ? 'warn' : '', t: r.security ? 'Fence wire touched' : 'Fence intact' }) }
            ]
        },
        {
            title: 'Actuators', note: 'Tap a card to control it', cards: [
                { key: 'irrigation', label: 'Irrigation', icon: 'valve', act: 'irrigation', fn: viaEsp(timed('Irrigation', 'irrigate')) },
                { key: 'sprinkler', label: 'Sprinkler', icon: 'shower', act: 'sprinkler', fn: timed('Sprinkler', 'sprinkler') },
                {
                    key: 'servo', label: 'Control mode', icon: 'stick', act: 'servo',
                    fn: r => ({ v: ['Auto', 'Joystick', 'Web'][r.ctl] || 'Auto', u: '', s: r.ctl ? 'on' : '', t: `Servo at ${r.angle}°` })
                },
                {
                    key: 'alarm', label: 'Alarm', icon: 'bell', act: 'alarm', fn: (r, x) => r.alarm ? { v: 'On', u: '', s: 'on', t: 'Playing the Mario theme' }
                        : starting(x.cmds.alarm, x) ? { v: 'Starting', u: '', s: 'on', t: `Sent by ${who(x.cmds.alarm.by)}` }
                            : { v: 'Off', u: '', s: '', t: 'Silent' }
                }
            ]
        }
    ];
    const DEFS = {};
    GROUPS.forEach(g => g.cards.forEach(c => { DEFS[c.key] = c; }));

    /* ---------- panel ---------- */
    const panel = document.createElement('aside');
    panel.className = 'dev-panel';
    panel.id = 'dev-panel';
    panel.setAttribute('aria-hidden', 'true');
    panel.setAttribute('aria-label', 'Devices');
    panel.innerHTML = `
        <div class="dev-top">
            <h2 class="dev-title">Devices</h2>
            <button class="icon-btn" id="dev-temp" aria-label="Temporary chat" title="Temporary chat"></button>
            <button class="icon-btn" id="dev-new" aria-label="New chat" title="New chat"></button>
            <button class="icon-btn" id="dev-close" aria-label="Close devices" title="Close">${ic(I.close)}</button>
        </div>
        <div class="dev-body">
            <button class="dev-status" id="dev-status" type="button"><span class="dev-dot"></span><span id="dev-status-text">Connecting…</span><span class="dev-info">${ic(I.info)}</span></button>
            <div id="dev-groups"></div>
            <button class="dev-add" id="dev-add" type="button">
                <span class="dev-add-ic">${ic(I.plus)}</span>
                <span class="dev-add-text"><b>Add device</b><small>Connect any device through the API</small></span>
                <span class="dev-add-chev">${ic(I.chev)}</span>
            </button>
        </div>`;
    appEl.appendChild(panel);

    const tempSrc = $('temp-btn'), newSrc = $('new-chat-top');
    $('dev-temp').innerHTML = tempSrc ? tempSrc.innerHTML : '';
    $('dev-new').innerHTML = newSrc ? newSrc.innerHTML : '';
    navBtn.querySelector('svg').innerHTML = I.cpu;

    function makeCard(def) {
        const card = document.createElement('div');
        card.className = 'dev-card stale' + (def.act ? ' act' : '');
        if (def.act) { card.tabIndex = 0; card.setAttribute('role', 'button'); card.setAttribute('aria-label', `${def.label}: open controls`); }
        card.innerHTML = `<div class="dev-card-head"><span class="dev-ic"></span><span class="dev-label"></span></div>
            <div class="dev-val-row"><span class="dev-val">--</span><span class="dev-unit"></span></div>
            <div class="dev-text">Waiting for data</div>`;
        card.querySelector('.dev-ic').innerHTML = ic(I[def.icon]);
        card.querySelector('.dev-label').textContent = def.label;
        if (def.act) {
            const go = () => openControl(def.act);
            card.addEventListener('click', go);
            card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
        }
        return { def, card, last: '', val: card.querySelector('.dev-val'), unit: card.querySelector('.dev-unit'), text: card.querySelector('.dev-text') };
    }

    const refs = {};
    const groupsEl = $('dev-groups');
    GROUPS.forEach(g => {
        const sec = document.createElement('section');
        sec.className = 'dev-group';
        sec.innerHTML = '<p class="dev-group-title"><span></span><em></em></p><div class="dev-grid"></div>';
        sec.querySelector('.dev-group-title span').textContent = g.title;
        sec.querySelector('.dev-group-title em').textContent = g.note || '';
        const grid = sec.querySelector('.dev-grid');
        g.cards.forEach(c => { const r = makeCard(c); grid.appendChild(r.card); refs[c.key] = r; });
        groupsEl.appendChild(sec);
    });

    const chatCards = new Set();     // live cards shown inside chats

    /* ---------- state + polling ---------- */
    let dev = null, fetchedAt = 0, fails = 0, lastErr = '', inflight = false, tickN = 0;
    const elapsed = () => (performance.now() - fetchedAt) / 1000;
    const ageNow = () => dev && dev.ageSec != null ? dev.ageSec + elapsed() : null;
    const lost = () => fails >= FAILS_BEFORE_LOST;
    const isOnline = () => { const a = ageNow(); return !lost() && a != null && a <= STALE_AFTER; };
    const reading = () => (dev && dev.reading) || null;
    const isOpen = () => panel.classList.contains('show');
    const needed = () => {
        chatCards.forEach(r => { if (!r.card.isConnected) chatCards.delete(r); });
        return isOpen() || chatCards.size > 0 || !!pop;
    };

    function offlineText() {
        const a = ageNow();
        if (lost() && !dev) return `Cannot reach the server${lastErr ? ' (' + lastErr + ')' : ''}`;
        if (!dev || dev.ageSec == null) return 'Mark 1 has not sent any data yet';
        if (lost()) return `Connection problem${lastErr ? ' (' + lastErr + ')' : ''}, retrying… Last reading ${fmtAgo(a)} ago`;
        return `Mark 1 offline, last seen ${fmtAgo(a)} ago`;
    }

    function paintStatus() {
        const box = $('dev-status'), txt = $('dev-status-text');
        let kind = 'off', msg;
        if (!dev && !lost()) msg = 'Connecting…';
        else if (!isOnline()) msg = offlineText();
        else {
            kind = 'on';
            const n = Object.values(refs).filter(r => r.card.classList.contains('warn')).length;
            msg = `Mark 1 online, updated ${fmtAgo(ageNow())} ago` + (n ? ` · ${n} alert${n > 1 ? 's' : ''}` : '');
        }
        box.dataset.k = kind;
        txt.textContent = msg;
        const live = isOnline();
        Object.values(refs).forEach(r => r.card.classList.toggle('stale', !live));
        chatCards.forEach(r => r.card.classList.toggle('stale', !live));
        navBtn.classList.toggle('has-alert', live && Object.values(refs).some(r => r.card.classList.contains('warn')));
    }

    function paintCard(c, r, x, inChat) {
        const o = c.def.fn(r, x);
        const sig = [o.v, o.u, o.s].join('|');
        c.val.textContent = o.v; c.unit.textContent = o.u;
        c.text.textContent = inChat && !isOnline() ? offlineText() : o.t;
        c.card.classList.toggle('warn', o.s === 'warn');
        c.card.classList.toggle('on', o.s === 'on');
        if (c.last && c.last !== sig) { c.card.classList.remove('flash'); void c.card.offsetWidth; c.card.classList.add('flash'); }
        c.last = sig;
    }

    function render() {
        const r = reading();
        if (r) {
            const x = { cmds: (dev && dev.cmds) || {}, el: elapsed() };
            Object.values(refs).forEach(c => paintCard(c, r, x, false));
            chatCards.forEach(c => paintCard(c, r, x, true));
            if (dialUpdate) dialUpdate(r);
        } else {
            chatCards.forEach(c => { c.text.textContent = lost() || dev ? offlineText() : 'Connecting…'; });
        }
        paintStatus();
    }

    async function poll() {
        if (inflight) return;
        inflight = true;
        try {
            const res = await fetch(`${apiBase}/api/devices`, { cache: 'no-store' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            if (!(res.headers.get('content-type') || '').includes('json')) throw new Error('not JSON');
            const d = await res.json();
            dev = (d.devices || []).find(x => x.id === 'mark1') || null;
            fetchedAt = performance.now();
            fails = 0; lastErr = '';
        } catch (e) {
            fails++;
            lastErr = /HTTP|JSON/.test(e.message) ? e.message : 'network';
            console.warn('[devices] poll failed:', e.message);
        } finally {
            inflight = false;
            render();
        }
    }

    // one timer for everything: repaint every second, fetch every 2 s, only while something is on screen
    setInterval(() => {
        if (document.hidden || !needed()) return;
        tickN++;
        if (!dev || tickN % (POLL_MS / 1000) === 0) poll();
        else render();
    }, 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && needed()) poll(); });

    /* ---------- toast (reuses app.js's #toast element) ---------- */
    let toastT;
    function say(m) { const t = $('toast'); if (!t) return; t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600); }

    /* ---------- popups (on the page, so they also work from a chat) ---------- */
    let pop = null, dialUpdate = null;
    function closePop() { if (pop) { pop.remove(); pop = null; } dialUpdate = null; }
    function openPop(title, build) {
        closePop();
        const o = document.createElement('div');
        o.className = 'dev-pop';
        o.innerHTML = '<div class="dev-pop-card" role="dialog" aria-modal="true"><h3></h3><div class="dev-pop-body"></div><div class="dev-pop-actions"><button class="dev-btn" data-close type="button">Close</button></div></div>';
        o.querySelector('h3').textContent = title;
        build(o.querySelector('.dev-pop-body'));
        o.addEventListener('mousedown', e => { if (e.target === o) closePop(); });
        o.addEventListener('touchstart', e => { if (e.target === o) closePop(); }, { passive: true });
        ['touchstart', 'touchmove', 'touchend'].forEach(ev => o.addEventListener(ev, e => e.stopPropagation(), { passive: true }));
        o.querySelector('[data-close]').onclick = closePop;
        document.body.appendChild(o);
        pop = o;
    }
    const btn = (parent, label, fn, cls) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'dev-btn ' + (cls || ''); b.textContent = label; b.onclick = fn; parent.appendChild(b); return b; };
    const para = (parent, text, cls) => { const p = document.createElement('p'); p.className = 'dev-pop-text' + (cls ? ' ' + cls : ''); p.textContent = text; parent.appendChild(p); return p; };

    async function post(body) {
        const res = await fetch(`${apiBase}/api/devices/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: 'mark1', ...body }) });
        let d = {};
        try { d = await res.json(); } catch (e) { }
        if (res.status === 409) { say(d.message || 'Mark 1 is offline'); poll(); return false; }
        if (!res.ok) throw new Error(d.message || 'error ' + res.status);
        return true;
    }
    async function send(body, okMsg) {
        closePop();
        try {
            if (await post(body)) { say(okMsg + '. Mark 1 picks it up in about a second'); setTimeout(poll, 1200); setTimeout(poll, 2600); }
        } catch (e) { say('Could not send the command (' + e.message + ')'); }
    }

    function openInfo() {
        const a = ageNow(), off = !isOnline();
        openPop(off ? 'Why is Mark 1 offline?' : 'About Mark 1', body => {
            if (dev && dev.ageSec != null) para(body, off ? `Last seen ${fmtAgo(a)} ago.` : `Updated ${fmtAgo(a)} ago.`, 'strong');
            if (lost()) para(body, `The website cannot reach the server right now${lastErr ? ' (' + lastErr + ')' : ''}. It keeps retrying.`);
            para(body, POWER_NOTE);
        });
    }

    function openAdd() {
        openPop('Add a device', body => {
            para(body, 'Dear judges, Yageno is plug-in, plug-out: any sensor or actuator can join through one small API, whatever protocol it speaks. Wi-Fi boards call the API directly. MQTT, LoRa, Zigbee, BLE or serial devices join through a small gateway, the same way the ESP32 talks to the Uno Q over a serial wire in Mark 1.');
            para(body, 'Mark 1 is the working example, hard-coded for this demo. It does three things:');
            const ol = document.createElement('ol');
            ol.className = 'dev-steps';
            ['Sends its readings as JSON with its device key, every second or when something changes.',
                'Reads the commands that come back in the same reply and runs each one once.',
                'Appears on this page, and Yageno AI can read it, explain it and act on it.'].forEach(t => { const li = document.createElement('li'); li.textContent = t; ol.appendChild(li); });
            body.appendChild(ol);
            const pre = document.createElement('pre');
            pre.className = 'dev-code';
            pre.textContent = 'POST /api/device/ingest\nX-Device-Key: <secret>\n\n{ "deviceId": "mark1",\n  "state": { "temp": 30, "hum": 79, "fire": 0 } }\n\nreply: { "commands": [\n  { "id": "a1b2", "actuator": "irrigation",\n    "action": "on", "seconds": 60 } ] }';
            body.appendChild(pre);
            para(body, 'Registering new devices from this screen, with their own sensors, actuators and permissions, is next on the roadmap. Today only Mark 1 is registered.');
            para(body, 'Mark 1 is powered from my MacBook, so I cannot keep it on 24/7. It is switched on every day from 5 pm to 6 pm (IST).', 'note');
        });
    }

    function openControl(act) {
        const r = reading();
        if (!isOnline() || !r) { say(lost() ? 'Cannot reach the server right now' : 'Mark 1 is offline'); openInfo(); return; }
        if (act === 'irrigation' || act === 'sprinkler') {
            const label = act === 'irrigation' ? 'Irrigation' : 'Sprinkler';
            const on = act === 'irrigation' ? !!r.irrigate : !!r.sprinkler;
            if (act === 'irrigation' && !r.esp) { say('The ESP32 is not connected, so the pump cannot be reached'); return; }
            openPop(label, body => {
                para(body, on ? `${label} is on. Pick a new time, or turn it off.` : `Turn on ${label.toLowerCase()} for how long? It goes back to normal when the time is up.`);
                const opts = document.createElement('div'); opts.className = 'dev-opts'; body.appendChild(opts);
                DURATIONS.forEach(([s, name]) => btn(opts, name, () => send({ actuator: act, action: 'on', seconds: s }, `${label} on for ${name}`), 'solid'));
                if (on) btn(opts, 'Turn off now', () => send({ actuator: act, action: 'off' }, `${label} off`), 'danger');
            });
        } else if (act === 'alarm') {
            const on = !!r.alarm;
            openPop('Alarm', body => {
                para(body, on ? 'The alarm is playing the Mario theme.' : 'Play the Mario theme on the buzzer? It turns itself off when the song ends.');
                const opts = document.createElement('div'); opts.className = 'dev-opts'; body.appendChild(opts);
                btn(opts, on ? 'Stop alarm' : 'Play alarm', () => send({ actuator: 'alarm', action: on ? 'off' : 'on' }, on ? 'Alarm stopped' : 'Alarm started'), on ? 'danger' : 'solid');
            });
        } else if (act === 'servo') openDial();
    }

    /* ---------- 180 degree servo dial ---------- */
    const CX = 150, CY = 160, R = 120;
    const pt = (a, rad = R) => { const t = a * Math.PI / 180; return [CX - rad * Math.cos(t), CY - rad * Math.sin(t)]; };

    function openDial() {
        openPop('Control mode', body => {
            const note = para(body, '');
            body.insertAdjacentHTML('beforeend', `
                <svg class="dial" viewBox="0 0 300 195" aria-label="Servo angle, 0 to 180 degrees">
                    <path class="dial-track" d="M30 160 A120 120 0 0 1 270 160"/>
                    <path class="dial-fill" d="M30 160"/>
                    <line class="dial-needle" x1="150" y1="160" x2="30" y2="160"/>
                    <circle class="dial-hub" cx="150" cy="160" r="8"/>
                    <circle class="dial-handle" r="14" cx="30" cy="160"/>
                    <text x="30" y="186">0°</text><text x="150" y="28">90°</text><text x="270" y="186">180°</text>
                </svg>
                <div class="dial-read"><b class="dial-val">--</b><span>servo angle</span></div>`);
            const svg = body.querySelector('svg'), fill = body.querySelector('.dial-fill'), needle = body.querySelector('.dial-needle'),
                handle = body.querySelector('.dial-handle'), val = body.querySelector('.dial-val');
            let dragging = false, target = 0, lastSend = 0, sentTarget = -1, holdUntil = 0;

            const draw = (aHandle, aActual) => {
                const [hx, hy] = pt(aHandle), [nx, ny] = pt(aActual, R - 18);
                handle.setAttribute('cx', hx); handle.setAttribute('cy', hy);
                fill.setAttribute('d', `M30 160 A120 120 0 0 1 ${hx} ${hy}`);
                needle.setAttribute('x2', nx); needle.setAttribute('y2', ny);
                val.textContent = Math.round(aHandle) + '°';
            };
            const angleFrom = e => {
                const b = svg.getBoundingClientRect(), k = 300 / b.width;
                const dx = (e.clientX - b.left) * k - CX, dy = CY - (e.clientY - b.top) * k;
                const t = dy < 0 ? (dx < 0 ? Math.PI : 0) : Math.atan2(dy, dx);
                return Math.max(0, Math.min(180, Math.round(180 - t * 180 / Math.PI)));
            };
            // moves are throttled; the last position is always sent when you let go
            const push = async force => {
                const now = performance.now();
                if (target === sentTarget || (!force && now - lastSend < 450)) return;
                lastSend = now; sentTarget = target; holdUntil = now + 3000;
                try { await post({ actuator: 'servo', action: 'angle', angle: target }); }
                catch (e) { say('Could not move the servo (' + e.message + ')'); }
            };
            svg.addEventListener('pointerdown', e => { dragging = true; svg.setPointerCapture(e.pointerId); target = angleFrom(e); draw(target, (reading() || {}).angle || 0); });
            svg.addEventListener('pointermove', e => { if (!dragging) return; target = angleFrom(e); draw(target, (reading() || {}).angle || 0); push(false); });
            const end = () => { if (!dragging) return; dragging = false; push(true); };
            svg.addEventListener('pointerup', end);
            svg.addEventListener('pointercancel', end);

            const opts = document.createElement('div'); opts.className = 'dev-opts'; body.appendChild(opts);
            btn(opts, 'Give control back', () => send({ actuator: 'servo', action: 'release' }, 'Control given back'));

            dialUpdate = r => {
                const actual = r.angle || 0;
                // keep the handle where you put it for a moment, so it does not jump back before Mark 1 moves
                if (dragging || performance.now() < holdUntil) draw(target, actual); else { target = actual; draw(actual, actual); }
                note.textContent = !isOnline() ? 'Mark 1 is offline.'
                    : r.ctl === 1 ? 'The joystick is moving the servo right now. Web moves apply once you let go of it.'
                        : r.ctl === 2 ? 'You are driving the servo from the web. It returns to automatic about 8 seconds after the last move.'
                            : 'Drag the handle to move the sprinkler servo. The needle shows where the real servo is.';
            };
            dialUpdate(reading() || { angle: 0, ctl: 0 });
        });
    }

    /* ---------- open / close ---------- */
    function openPanel() {
        const gc = $('gc-panel');
        if (gc && gc.classList.contains('show')) $('gc-close') && $('gc-close').click();
        appEl.classList.remove('open');
        panel.classList.add('show');
        panel.setAttribute('aria-hidden', 'false');
        navBtn.setAttribute('aria-pressed', 'true');
        poll();
    }
    function closePanel() {
        closePop();
        panel.classList.remove('show');
        panel.setAttribute('aria-hidden', 'true');
        navBtn.setAttribute('aria-pressed', 'false');
    }

    navBtn.addEventListener('click', () => (isOpen() ? closePanel() : openPanel()));
    $('dev-close').addEventListener('click', closePanel);
    $('dev-new').addEventListener('click', () => { closePanel(); if (newSrc && !newSrc.disabled) newSrc.click(); });
    $('dev-temp').addEventListener('click', () => { closePanel(); if (tempSrc) tempSrc.click(); });
    $('dev-status').addEventListener('click', openInfo);
    $('dev-add').addEventListener('click', openAdd);

    $('sidebar').addEventListener('click', e => { if (isOpen() && e.target.closest('.chat-item, #new-chat')) closePanel(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (pop) closePop(); else if (isOpen()) closePanel(); } });
    ['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach(ev => panel.addEventListener(ev, e => e.stopPropagation(), { passive: true }));

    /* ---------- for chats ---------- */
    window.YagenoDevices = {
        card(act) {
            const def = DEFS[act];
            if (!def || !def.act) return null;
            const r = makeCard(def);
            r.card.classList.add('in-chat');
            chatCards.add(r);
            setTimeout(() => { if (needed()) (dev ? render() : poll()); }, 0);
            return r.card;
        },
        open(act) { if (!dev) poll().then(() => openControl(act)); else openControl(act); }
    };
})();
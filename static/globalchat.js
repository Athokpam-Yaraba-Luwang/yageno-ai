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
    const appEl = $('app'), navBtn = $('gc-btn');
    if (!appEl || !navBtn) return;

    const FAST_MS = 2000;      // panel open
    const SLOW_MS = 8000;      // panel closed (only to light the unread dot)
    const KICK_GAP = 2500;     // never ask the server to run the AI more often than this

    const ic = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
    const I = {
        chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z"/><path d="M8.5 11h7M8.5 14.5h4"/>',
        close: '<path d="M6 6l12 12M18 6 6 18"/>',
        send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
        spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 17l.7 1.8L21.5 19.5l-1.8.7L19 22l-.7-1.8-1.8-.7 1.8-.7z"/>',
        sparkOff: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M3 3l18 18"/>',
        clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
        bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
        down: '<path d="m6 9 6 6 6-6"/>',
        alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
        cmd: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
        wifi: '<path d="M5 12.6a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 8.8a15 15 0 0 1 20 0"/><path d="M12 20h.01"/>',
        ok: '<path d="M5 12.5 10 17.5 19 7.5"/>',
        no: '<path d="M6 6l12 12M18 6 6 18"/>'
    };
    const PILL_IC = { command: 'cmd', online: 'wifi', offline: 'wifi', esp: 'wifi' };

    const HAZ = { fire: 'Flame', aerial: 'Birds / airborne', sound: 'Bird sound' };

    /* ---------- nav button + panel ---------- */
    navBtn.querySelector('svg') && (navBtn.querySelector('svg').innerHTML = I.chat);

    const panel = document.createElement('aside');
    panel.className = 'gc-panel';
    panel.id = 'gc-panel';
    panel.setAttribute('aria-hidden', 'true');
    panel.setAttribute('aria-label', 'Farm chat');
    panel.innerHTML = `
        <div class="gc-top">
            <div class="gc-title"><h2>Farm chat</h2><small id="gc-sub">Shared with everyone in the project</small></div>
            <button class="icon-btn" id="gc-temp" aria-label="Temporary chat" title="Temporary chat"></button>
            <button class="icon-btn" id="gc-new" aria-label="New chat" title="New chat"></button>
            <button class="icon-btn" id="gc-close" aria-label="Close farm chat" title="Close">${ic(I.close)}</button>
        </div>
        <div class="gc-feed" id="gc-feed" aria-live="polite"></div>
        <button class="gc-jump" id="gc-jump" type="button" hidden>${ic(I.down)}<span>New messages</span></button>
        <div class="gc-foot">
            <div class="gc-composer" id="gc-composer">
                <button class="gc-ai-toggle" id="gc-ai" type="button" aria-pressed="true" aria-label="Yageno AI will reply to this message" title="Yageno AI will reply. Tap to send to the team only."></button>
                <textarea id="gc-input" rows="1" enterkeyhint="enter" placeholder="Message or ask Yageno AI…"></textarea>
                <button class="gc-send" id="gc-send" type="button" aria-label="Send">${ic(I.send)}</button>
            </div>
            <p class="gc-hint" id="gc-hint">Yageno AI will reply to this message.</p>
        </div>`;
    appEl.appendChild(panel);

    const tempSrc = $('temp-btn'), newSrc = $('new-chat-top');
    $('gc-temp').innerHTML = tempSrc ? tempSrc.innerHTML : '';
    $('gc-new').innerHTML = newSrc ? newSrc.innerHTML : '';

    const feedEl = $('gc-feed'), inputEl = $('gc-input'), aiBtn = $('gc-ai'), sendBtn = $('gc-send');
    const jumpBtn = $('gc-jump'), hintEl = $('gc-hint'), composerEl = $('gc-composer');

    /* ---------- state ---------- */
    let items = [];            // last feed from the server (plus my own optimistic sends)
    let me = '';
    let aiBusy = false;
    let pollT = null, polling = false, kickAt = 0, kicking = false;
    let seenTs = 0, loaded = false;
    let toAi = true;
    let stick = true;
    const cache = new Map();   // ts -> rendered node, so a poll only touches what changed

    const isOpen = () => panel.classList.contains('show');
    const youName = () => me || (window.YAGENO && window.YAGENO.user) || '';

    /* ---------- helpers ---------- */
    const timeOf = ts => {
        try { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; }
    };
    const dayOf = ts => {
        const d = new Date(ts), n = new Date();
        const same = (a, b) => a.toDateString() === b.toDateString();
        const y = new Date(n); y.setDate(n.getDate() - 1);
        if (same(d, n)) return 'Today';
        if (same(d, y)) return 'Yesterday';
        return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
    };
    const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

    // plain text with @mentions picked out (no innerHTML, so nothing a user types can run)
    function mentions(node, text) {
        String(text).split(/(@[A-Za-z0-9_.-]+)/g).forEach(part => {
            if (!part) return;
            if (part[0] === '@' && part.length > 1) node.appendChild(el('span', 'gc-at' + (part.slice(1).toLowerCase() === youName().toLowerCase() ? ' me' : ''), part));
            else node.appendChild(document.createTextNode(part));
        });
        return node;
    }

    // the AI answers in markdown. Render it, then strip anything active.
    function markdown(node, text) {
        if (!window.marked) { node.textContent = text; return node; }
        const t = document.createElement('template');
        t.innerHTML = marked.parse(text);
        t.content.querySelectorAll('script,style,iframe,object,embed,link,meta,form').forEach(n => n.remove());
        t.content.querySelectorAll('*').forEach(n => {
            [...n.attributes].forEach(a => {
                const k = a.name.toLowerCase(), v = a.value.trim().toLowerCase();
                if (k.startsWith('on') || ((k === 'href' || k === 'src') && v.startsWith('javascript:'))) n.removeAttribute(a.name);
            });
            if (n.tagName === 'A') { n.target = '_blank'; n.rel = 'noopener noreferrer'; }
        });
        node.innerHTML = '';
        node.appendChild(t.content);
        // mentions inside plain text nodes
        const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), list = [];
        while (w.nextNode()) if (!w.currentNode.parentElement.closest('code,pre,a') && /@[A-Za-z0-9_.-]+/.test(w.currentNode.nodeValue)) list.push(w.currentNode);
        list.forEach(n => { const s = document.createElement('span'); mentions(s, n.nodeValue); n.replaceWith(...s.childNodes); });
        return node;
    }

    function say(m) { const t = $('toast'); if (!t) return; t.textContent = m; t.classList.add('show'); clearTimeout(say.t); say.t = setTimeout(() => t.classList.remove('show'), 2400); }

    /* ---------- one item -> one node ---------- */
    function build(it) {
        const mine = it.kind === 'user' && it.user && it.user.toLowerCase() === youName().toLowerCase();

        if (it.kind === 'sys') {
            const alert = it.level === 'alert';
            const n = el('div', 'gc-row gc-sys' + (alert ? ' alert' : ''));
            const pill = el('div', 'gc-pill');
            pill.appendChild(el('span', 'gc-pill-ic')).innerHTML = ic(I[alert ? 'alert' : (PILL_IC[it.ntype] || 'bolt')]);
            const t = el('span', 'gc-pill-text'); mentions(t, it.text); pill.appendChild(t);
            pill.appendChild(el('time', null, timeOf(it.ts)));
            n.appendChild(pill);
            return n;
        }

        if (it.kind === 'auto') {
            const n = el('div', 'gc-row gc-autoRow');
            const card = el('div', 'gc-auto');
            const head = el('div', 'gc-auto-head');
            head.appendChild(el('span', 'gc-auto-tag', 'Automated decision'));
            head.appendChild(el('time', null, timeOf(it.ts)));
            card.appendChild(head);
            const chips = el('div', 'gc-chips');
            (it.hazards || []).forEach(h => chips.appendChild(el('span', 'gc-chip warn', HAZ[h] || h)));
            if (chips.childNodes.length) card.appendChild(chips);
            const dec = el('p', 'gc-auto-do'); dec.appendChild(el('b', null, 'Decision: '));
            dec.appendChild(document.createTextNode(it.decision ? it.decision.charAt(0).toUpperCase() + it.decision.slice(1) : 'No action'));
            card.appendChild(dec);
            if (it.reason) { const r = el('p', 'gc-auto-why'); r.appendChild(el('b', null, 'Reason: ')); r.appendChild(document.createTextNode(it.reason)); card.appendChild(r); }
            card.appendChild(el('div', 'gc-auto-src', it.source === 'rules' ? 'Safety rules (AI was unavailable)' : 'Decided by Yageno AI'));
            n.appendChild(card);
            return n;
        }

        if (it.kind === 'ai') {
            const n = el('div', 'gc-row gc-ai');
            const head = el('div', 'gc-who');
            head.appendChild(el('b', null, 'Yageno AI'));
            const src = it.replyTo && items.find(x => x.ts === it.replyTo);
            if (src) head.appendChild(el('span', null, 'to @' + src.user));
            head.appendChild(el('time', null, timeOf(it.ts)));
            n.appendChild(head);
            const body = el('div', 'gc-md md');
            markdown(body, it.text || '');
            n.appendChild(body);
            if (it.actions && it.actions.length) {
                const d = el('div', 'chat-done');
                it.actions.forEach(a => {
                    const s = el('span', a.ok ? '' : 'fail');
                    s.innerHTML = ic(I[a.ok ? 'ok' : 'no']);
                    s.appendChild(document.createTextNode(a.ok ? 'Sent to Mark 1: ' + a.text : a.text || 'Could not do that'));
                    d.appendChild(s);
                });
                n.appendChild(d);
            }
            const Y = window.YagenoDevices;
            if (it.cards && it.cards.length && Y) {
                const w = el('div', 'chat-cards');
                it.cards.forEach(a => { const c = Y.card(a); if (c) w.appendChild(c); });
                if (w.children.length) n.appendChild(w);
            }
            return n;
        }

        // a person
        const n = el('div', 'gc-row gc-user' + (mine ? ' mine' : ''));
        const head = el('div', 'gc-who');
        head.appendChild(el('b', null, '@' + (it.user || 'someone')));
        head.appendChild(el('time', null, timeOf(it.ts)));
        n.appendChild(head);
        const bub = el('div', 'gc-bubble');
        mentions(bub, it.text);
        n.appendChild(bub);

        const meta = el('div', 'gc-meta');
        if (it.ai === false) {
            const t = el('span', 'gc-state team'); t.innerHTML = ic(I.sparkOff) + '<i>Team only</i>'; meta.appendChild(t);
        } else if (it.status === 'pending') {
            const t = el('span', 'gc-state pend'); t.innerHTML = ic(I.clock) + '<i>Pending</i>'; meta.appendChild(t);
            if (mine) {
                const b = el('button', 'gc-retract', 'Retract'); b.type = 'button';
                b.addEventListener('click', () => retract(it.ts, b));
                meta.appendChild(b);
            }
        } else if (it.status === 'processing') {
            const t = el('span', 'gc-state work'); t.innerHTML = '<span class="gc-dots"><i></i><i></i><i></i></span><i>Yageno AI is reading</i>'; meta.appendChild(t);
        }
        if (meta.childNodes.length) n.appendChild(meta);
        return n;
    }

    function itemSig(it) {
        return [it.ts, it.kind, it.status, it.ai, it.text && it.text.length, it.user, it.level, (it.cards || []).join(',')].join('|');
    }

    function render() {
        const near = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 140;
        const live = new Set(items.map(i => i.ts));
        cache.forEach((v, k) => { if (!live.has(k)) { v.node.remove(); cache.delete(k); } });
        feedEl.querySelectorAll('.gc-day,.gc-empty').forEach(n => n.remove());

        if (!items.length) {
            feedEl.querySelectorAll('.gc-row').forEach(n => n.remove());
            const e = el('div', 'gc-empty');
            e.innerHTML = `<div class="gc-empty-ic">${ic(I.chat)}</div><h3>Nothing here yet</h3><p>Everyone in the Farm project sees this chat. Say hi to the team, or ask Yageno AI about the farm.</p>`;
            feedEl.appendChild(e);
            return;
        }

        // keyed reconcile: reuse nodes that did not change, keep the DOM in feed order
        let cursor = feedEl.firstChild;
        const place = n => { if (n === cursor) cursor = cursor.nextSibling; else feedEl.insertBefore(n, cursor); };

        let prevDay = '';
        items.forEach(it => {
            const s = itemSig(it);
            let c = cache.get(it.ts);
            if (!c || c.sig !== s) {
                const node = build(it);
                if (c && c.node.parentNode) { if (cursor === c.node) cursor = node; c.node.replaceWith(node); }
                c = { node, sig: s };
                cache.set(it.ts, c);
            }
            const d = dayOf(it.ts);
            if (d !== prevDay) { place(el('div', 'gc-day', d)); prevDay = d; }
            place(c.node);
        });

        // "Yageno AI is answering" row at the end
        let busy = feedEl.querySelector('.gc-busy');
        const waiting = aiBusy || items.some(i => i.kind === 'user' && i.status === 'processing');
        if (waiting) {
            if (!busy) {
                busy = el('div', 'gc-row gc-busy');
                busy.innerHTML = '<div class="gc-who"><b>Yageno AI</b></div><div class="thinking"><i></i><i></i><i></i></div>';
            }
            place(busy);
        } else if (busy) {
            if (busy === cursor) cursor = cursor.nextSibling;
            busy.remove();
        }
        while (cursor) { const n = cursor.nextSibling; cursor.remove(); cursor = n; }

        if (near || stick) { feedEl.scrollTop = feedEl.scrollHeight; jumpBtn.hidden = true; }
        else jumpBtn.hidden = false;
        stick = false;
    }

    feedEl.addEventListener('scroll', () => {
        if (feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 140) jumpBtn.hidden = true;
    }, { passive: true });
    jumpBtn.addEventListener('click', () => { feedEl.scrollTo({ top: feedEl.scrollHeight, behavior: 'smooth' }); jumpBtn.hidden = true; });

    /* ---------- network ---------- */
    async function poll() {
        if (polling || document.hidden && !isOpen()) return;
        polling = true;
        try {
            const r = await fetch(apiBase + '/api/global', { cache: 'no-store' });
            if (!r.ok) throw new Error(r.status);
            const d = await r.json();
            me = d.me || me;
            aiBusy = !!d.aiBusy;
            const incoming = d.items || [];
            // keep my optimistic sends until the server shows them
            const have = new Set(incoming.map(i => i.ts));
            const local = items.filter(i => i.local && !have.has(i.ts) && Date.now() - i.ts < 15000);
            items = incoming.concat(local);

            const top = incoming.length ? incoming[incoming.length - 1].ts : 0;
            if (!loaded) { loaded = true; if (!isOpen()) seenTs = Math.max(seenTs, top); }
            if (isOpen()) { seenTs = Math.max(seenTs, top); render(); }
            else {
                const fresh = incoming.some(i => i.ts > seenTs && (i.kind !== 'user' || (i.user || '').toLowerCase() !== youName().toLowerCase()));
                navBtn.classList.toggle('has-alert', fresh);
            }
            kickIfNeeded();
        } catch (e) { /* offline or signed out: try again next tick */ }
        polling = false;
    }

    // Any client can wake the AI. The server's lock makes sure only one of them actually runs it.
    function kickIfNeeded() {
        const waiting = items.some(i => i.kind === 'user' && i.ai !== false && (i.status === 'pending' || i.status === 'processing') && !i.local);
        if (!waiting || aiBusy || kicking || Date.now() - kickAt < KICK_GAP) return;
        kick();
    }
    async function kick() {
        kicking = true; kickAt = Date.now();
        try { await fetch(apiBase + '/api/global/process', { method: 'POST' }); } catch (e) { }
        kicking = false;
        poll();
    }

    function schedule() {
        clearTimeout(pollT);
        pollT = setTimeout(async () => { await poll(); schedule(); }, isOpen() ? FAST_MS : SLOW_MS);
    }

    async function send() {
        const text = inputEl.value.trim();
        if (!text) return;
        let mode = 'flash';
        try { if (localStorage.getItem('yageno-model') === 'thinking') mode = 'thinking'; } catch (e) { }
        sendBtn.disabled = true;
        inputEl.value = ''; autosize();
        try {
            const r = await fetch(apiBase + '/api/global/send', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, ai: toAi, mode })
            });
            if (!r.ok) throw new Error(r.status);
            const d = await r.json();
            items.push({ ts: d.ts, kind: 'user', user: youName(), text, ai: toAi, status: toAi ? 'pending' : 'done', local: true });
            stick = true;
            render();
            if (toAi) setTimeout(kick, 300);
            else poll();
        } catch (e) {
            inputEl.value = text; autosize();
            say('Could not send. Check your connection and try again.');
        }
        sendBtn.disabled = false;
        if (!matchMedia('(hover: none)').matches) inputEl.focus();
    }

    async function retract(ts, btn) {
        btn.disabled = true;
        try {
            const r = await fetch(apiBase + '/api/global/messages/' + ts, { method: 'DELETE' });
            if (r.ok) { items = items.filter(i => i.ts !== ts); render(); say('Message retracted'); }
            else if (r.status === 409) { say('Too late, Yageno AI already picked it up'); poll(); }
            else throw new Error(r.status);
        } catch (e) { btn.disabled = false; say('Could not retract. Try again.'); }
    }

    /* ---------- composer ---------- */
    function autosize() { inputEl.style.height = 'auto'; inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px'; }
    function setToAi(v) {
        toAi = v;
        aiBtn.setAttribute('aria-pressed', String(v));
        aiBtn.innerHTML = ic(v ? I.spark : I.sparkOff);
        composerEl.classList.toggle('team', !v);
        inputEl.placeholder = v ? 'Message or ask Yageno AI…' : 'Team only, no AI reply…';
        hintEl.textContent = v ? 'Yageno AI will reply to this message.' : 'Team only: Yageno AI will ignore this message.';
        aiBtn.title = v ? 'Yageno AI will reply. Tap to send to the team only.' : 'Team only. Tap to let Yageno AI reply.';
        aiBtn.setAttribute('aria-label', aiBtn.title);
    }
    setToAi(true);
    aiBtn.addEventListener('click', () => { setToAi(!toAi); inputEl.focus(); });
    sendBtn.addEventListener('click', send);
    inputEl.addEventListener('input', autosize);
    inputEl.addEventListener('keydown', e => {
        // phones: Enter makes a new line (like the main chat). Computers: Enter sends, Shift+Enter makes a new line.
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(hover: none)').matches) { e.preventDefault(); send(); }
    });

    /* ---------- open / close ---------- */
    function openPanel() {
        const devClose = $('dev-close'), devPanel = $('dev-panel');
        if (devPanel && devPanel.classList.contains('show') && devClose) devClose.click();
        appEl.classList.remove('open');
        panel.classList.add('show');
        panel.setAttribute('aria-hidden', 'false');
        navBtn.setAttribute('aria-pressed', 'true');
        navBtn.classList.remove('has-alert');
        stick = true;
        render();
        poll().then(() => { seenTs = items.reduce((m, i) => Math.max(m, i.ts), seenTs); });
        schedule();
    }
    function closePanel() {
        panel.classList.remove('show');
        panel.setAttribute('aria-hidden', 'true');
        navBtn.setAttribute('aria-pressed', 'false');
        schedule();
    }

    navBtn.addEventListener('click', () => (isOpen() ? closePanel() : openPanel()));
    $('gc-close').addEventListener('click', closePanel);
    $('gc-new').addEventListener('click', () => { closePanel(); if (newSrc && !newSrc.disabled) newSrc.click(); });
    $('gc-temp').addEventListener('click', () => { closePanel(); if (tempSrc) tempSrc.click(); });
    const devBtn = $('devices-btn');
    if (devBtn) devBtn.addEventListener('click', () => { if (isOpen()) closePanel(); });
    $('sidebar').addEventListener('click', e => { if (isOpen() && e.target.closest('.chat-item, #new-chat')) closePanel(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen()) closePanel(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
    ['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach(ev => panel.addEventListener(ev, e => e.stopPropagation(), { passive: true }));

    // start quietly once the user is known (the gate sets window.YAGENO.ready)
    const start = () => { poll(); schedule(); };
    if (window.YAGENO && window.YAGENO.ready && window.YAGENO.ready.then) window.YAGENO.ready.then(start); else start();
})();
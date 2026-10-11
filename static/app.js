// SPDX-FileCopyrightText: Copyright (C) 2026 Athokpam Yaraba Luwang
// SPDX-License-Identifier: AGPL-3.0-or-later

(() => {
    'use strict';
    const $ = id => document.getElementById(id);
    const app = $('app'), main = $('main'), wrap = $('composer-wrap'), chatList = $('chat-list'), settings = $('settings');
    const sidebar = $('sidebar'), backdrop = $('backdrop');
    const scroller = $('chat-scroll'), messages = $('messages'), empty = $('empty-chat-container');
    const input = $('user-input'), sendBtn = $('send-button'), newTop = $('new-chat-top'), moreBtn = $('more-btn');
    const errBanner = $('error-banner'), errMsg = $('error-message');

    /* ---------- icons ---------- */
    const P = {
        pin: '<path d="M12 17v5"/><path d="M9 3h6l-1 6 3 3H7l3-3z"/>',
        share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
        branch: '<circle cx="6" cy="5" r="2.5"/><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 7.5v9M18 10.5c0 4-12 2-12 6"/>',
        edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
        trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
        copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
        search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
        newchat: '<path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/>',
        more: '<circle cx="12" cy="5" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="19" r="1.7" fill="currentColor"/>',
        send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
        chev: '<path d="m6 9 6 6 6-6"/>',
        retry: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
        alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',
        temp: '<path d="M13.5 3.1c-.5 0-1-.1-1.5-.1s-1 .1-1.5.1"/><path d="M19.3 6.8a10.45 10.45 0 0 0-2.1-2.1"/><path d="M20.9 13.5c.1-.5.1-1 .1-1.5s-.1-1-.1-1.5"/><path d="M17.2 19.3a10.45 10.45 0 0 0 2.1-2.1"/><path d="M10.5 20.9c.5.1 1 .1 1.5.1s1-.1 1.5-.1"/><path d="M3.5 17.5 2 22l4.5-1.5"/><path d="M3.1 10.5c0 .5-.1 1-.1 1.5s.1 1 .1 1.5"/><path d="M6.8 4.7a10.45 10.45 0 0 0-2.1 2.1"/>'
    };
    const svg = n => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${P[n]}</svg>`;
    const STOP = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
    document.querySelectorAll('[data-ic]').forEach(el => { el.innerHTML = svg(el.dataset.ic); });

    const isDesktop = () => window.innerWidth >= 900;
    const isTouch = () => matchMedia('(hover: none) and (pointer: coarse)').matches;
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    /* ---------- API base path ----------
       Built from where THIS script was loaded, so it keeps any API Gateway prefix, e.g.
       /default/First_Fastapi_webapp/static/app.js  ->  /default/First_Fastapi_webapp
       The backend (app.py) strips that prefix again. */
    const apiBase = (() => {
        try {
            const s = document.currentScript && document.currentScript.src;
            if (s) return new URL('../', s).pathname.replace(/\/$/, '');
        } catch (e) { }
        return window.location.pathname.replace(/\/$/, '');
    })();
    const api = path => `${apiBase}/${path.replace(/^\//, '')}`;

    // fetch JSON, and fail clearly if the server sent HTML (wrong route) instead of JSON
    async function getJSON(res) {
        const type = res.headers.get('content-type') || '';
        if (!type.includes('json')) throw new Error('BAD_RESPONSE');
        return res.json();
    }

    /* ---------- state ---------- */
    let busy = false, ctrl = null, epoch = 0, userEl = null, follow = true;
    let currentSessionId = null;   // UUID of the active saved chat
    let currentLi = null;          // <li> of the active chat in the sidebar
    let temp = false;
    let tempHistory = [];          // in-memory history for temporary chats

    /* ---------- error / toast ---------- */
    const showError = m => { errMsg.textContent = m; errBanner.style.display = 'block'; };
    const hideError = () => { errBanner.style.display = 'none'; };
    let toastT;
    function toast(m) { const t = $('toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1800); }
    async function copyText(s) {
        try { await navigator.clipboard.writeText(s); }
        catch (e) { const a = document.createElement('textarea'); a.value = s; a.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(a); a.select(); try { document.execCommand('copy'); } catch (_) { } a.remove(); }
        toast('Copied');
    }

    /* ---------- smooth auto-scroll ---------- */
    let raf = 0, lastT = 0;
    function startFollow() { if (!raf) { lastT = performance.now(); raf = requestAnimationFrame(loop); } }
    function loop(t) {
        const dt = Math.min(t - lastT, 50); lastT = t;
        let diff = 0;
        if (follow && userEl) {
            const cap = scroller.scrollTop + userEl.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
            diff = Math.min(scroller.scrollHeight - scroller.clientHeight, cap) - scroller.scrollTop;
            if (diff > 0.5) scroller.scrollTop += Math.min(diff, Math.max(1, diff * (1 - Math.exp(-dt / 140))));
        }
        raf = (busy || diff > 1) ? requestAnimationFrame(loop) : 0;
    }
    ['wheel', 'touchmove'].forEach(ev => scroller.addEventListener(ev, () => { follow = false; }, { passive: true }));

    /* ---------- sidebar toggle / swipe ---------- */
    const setCollapsed = c => { app.classList.toggle('collapsed', c); closeRail(); };
    $('sidebar-open').onclick = () => app.classList.add('open');
    backdrop.onclick = () => app.classList.remove('open');
    $('sidebar-toggle').onclick = () => {
        if (isDesktop()) setCollapsed(!app.classList.contains('collapsed'));
        else app.classList.remove('open');
    };
    let sw = null;
    document.addEventListener('touchstart', e => {
        if (isDesktop() || e.touches.length !== 1) { sw = null; return; }
        const t = e.touches[0];
        sw = { x: t.clientX, y: t.clientY, state: 'pending', target: e.target, p: 0, v: 0, lx: t.clientX, lt: performance.now() };
    }, { passive: true });
    document.addEventListener('touchmove', e => {
        if (!sw) return;
        const t = e.touches[0], dx = t.clientX - sw.x, dy = t.clientY - sw.y, isOpen = app.classList.contains('open');
        if (sw.state === 'pending') {
            if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
            const wrongDir = isOpen ? dx > 0 : dx < 0;
            if (Math.abs(dy) > Math.abs(dx) * 0.8 || wrongDir || (!isOpen && sw.target.closest && sw.target.closest('pre, table, textarea, input'))) { sw = null; return; }
            sw.state = 'drag'; sw.W = sidebar.offsetWidth; sw.base = isOpen ? sw.W : 0;
            app.classList.add('dragging'); closeMenu();
        }
        const pos = Math.max(0, Math.min(sw.W, sw.base + dx)), now = performance.now();
        sw.p = pos / sw.W;
        sw.v = (t.clientX - sw.lx) / Math.max(1, now - sw.lt); sw.lx = t.clientX; sw.lt = now;
        sidebar.style.transform = `translateX(${pos - sw.W}px)`;
        backdrop.style.opacity = sw.p;
    }, { passive: true });
    const endSwipe = () => {
        if (sw && sw.state === 'drag') {
            const open = Math.abs(sw.v) > 0.35 ? sw.v > 0 : sw.p > 0.5;
            app.classList.remove('dragging');
            sidebar.style.transform = ''; backdrop.style.opacity = '';
            app.classList.toggle('open', open);
        }
        sw = null;
    };
    document.addEventListener('touchend', endSwipe, { passive: true });
    document.addEventListener('touchcancel', endSwipe, { passive: true });

    /* ---------- themes ---------- */
    const THEMES = [
        ['green', '#008184'], ['blue', '#2563eb'], ['pink', '#d6336c'], ['wood', '#8b5a2b'], ['grey', '#6b7280'], ['lavender', '#7c5cc4'],
        ['dark-green', '#4db6ac', '#121716'], ['dark-blue', '#1d9bf0', '#15202b'], ['dark-pink', '#e57fa3', '#1a1417'],
        ['dark-wood', '#c49a6c', '#1a1612'], ['dark-grey', '#a8afbb', '#1a1a1c'], ['dark-lavender', '#b4a7e8', '#17151e']
    ];
    const LEGACY = { yellow: 'wood', dark: 'dark-blue' };
    const swEl = $('swatches');
    THEMES.forEach(([id, accent, darkBg]) => {
        const b = document.createElement('button');
        b.className = 'swatch'; b.dataset.theme = id; b.setAttribute('aria-label', id.replace('-', ' '));
        b.style.background = darkBg || accent;
        if (darkBg) b.style.boxShadow = `inset 0 0 0 4px ${accent}`;
        b.onclick = () => applyTheme(id);
        swEl.appendChild(b);
    });
    function applyTheme(t) {
        t = LEGACY[t] || t;
        if (!THEMES.some(x => x[0] === t)) t = 'green';
        document.documentElement.dataset.theme = t;
        swEl.querySelectorAll('.swatch').forEach(s => s.setAttribute('aria-pressed', String(s.dataset.theme === t)));
        try { localStorage.setItem('yageno-theme', t); } catch (e) { }
    }
    applyTheme(document.documentElement.dataset.theme || 'green');
    $('settings-toggle').onclick = e => {
        if (isDesktop() && app.classList.contains('collapsed')) { setCollapsed(false); settings.hidden = false; }
        else settings.hidden = !settings.hidden;
        e.currentTarget.setAttribute('aria-expanded', String(!settings.hidden));
    };

    /* ---------- model picker ---------- */
    const mm = $('model-menu'), mBtns = [$('model-btn'), $('model-btn-top')];
    let model = 'flash';
    try { if (localStorage.getItem('yageno-model') === 'thinking') model = 'thinking'; } catch (e) { }
    function setModel(m) {
        model = m;
        const name = m === 'thinking' ? 'Thinking' : 'Flash';
        $('pill-label').textContent = name; $('top-label').textContent = name;
        mm.querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.m === m)));
        try { localStorage.setItem('yageno-model', m); } catch (e) { }
    }
    function closeModelMenu() { mm.classList.remove('show'); mBtns.forEach(b => b.setAttribute('aria-expanded', 'false')); }
    function openModelMenu(btn) {
        const r = btn.getBoundingClientRect(), up = btn.dataset.pos === 'up', W = Math.min(300, window.innerWidth - 16);
        mm.style.width = W + 'px';
        mm.style.left = Math.max(8, Math.min(up ? r.right - W : r.left, window.innerWidth - W - 8)) + 'px';
        if (up) { mm.style.top = 'auto'; mm.style.bottom = (window.innerHeight - r.top + 8) + 'px'; mm.style.transformOrigin = 'bottom right'; }
        else { mm.style.bottom = 'auto'; mm.style.top = (r.bottom + 8) + 'px'; mm.style.transformOrigin = 'top left'; }
        mm.classList.add('show'); btn.setAttribute('aria-expanded', 'true');
    }
    mBtns.forEach(b => b.addEventListener('click', e => {
        e.stopPropagation();
        const wasOpen = b.getAttribute('aria-expanded') === 'true';
        closeModelMenu();
        if (!wasOpen) openModelMenu(b);
    }));
    mm.addEventListener('click', e => { const b = e.target.closest('button'); if (b) { setModel(b.dataset.m); closeModelMenu(); } });
    setModel(model);

    /* ---------- modal dialog ---------- */
    const modal = $('modal'), mTitle = $('modal-title'), mText = $('modal-text'), mInput = $('modal-input'), mOk = $('modal-ok');
    let onOk = null;
    function openModal(o) {
        mTitle.textContent = o.title; mText.textContent = o.text || '';
        mInput.hidden = !o.input; mInput.value = o.value || '';
        mOk.textContent = o.ok; mOk.classList.toggle('danger', !!o.danger);
        onOk = o.onOk;
        const check = () => { mOk.disabled = !!o.input && (!mInput.value.trim() || mInput.value.trim() === o.value); };
        mInput.oninput = check; check();
        modal.classList.add('show'); modal.setAttribute('aria-hidden', 'false');
        setTimeout(() => { if (o.input) { mInput.focus(); mInput.select(); } else mOk.focus(); }, 60);
    }
    function closeModal() { modal.classList.remove('show'); modal.setAttribute('aria-hidden', 'true'); onOk = null; }
    function submitModal() { if (mOk.disabled || !onOk) return; const fn = onOk; fn(mInput.value.trim()); closeModal(); }
    mOk.onclick = submitModal;
    $('modal-cancel').onclick = closeModal;
    modal.addEventListener('mousedown', e => { if (e.target === modal) closeModal(); });
    mInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitModal(); } });

    /* ==========================================================
       SIDEBAR: real chats from DynamoDB via /api/chats
    ========================================================== */
    const searchEl = $('chat-search'), searchEmpty = $('search-empty');

    function filterChats() {
        const q = searchEl.value.trim().toLowerCase(); let n = 0;
        chatList.querySelectorAll('.chat-item').forEach(li => {
            const hit = li.querySelector('.chat-label').textContent.toLowerCase().includes(q);
            li.classList.toggle('hide', !hit); if (hit) n++;
        });
        searchEmpty.hidden = n > 0 || !q;
    }
    searchEl.addEventListener('input', filterChats);

    function showChatListEmpty() {
        if (!chatList.querySelector('.chat-item') && !chatList.querySelector('.chat-empty')) {
            const n = document.createElement('li'); n.className = 'chat-empty'; n.textContent = 'No chats yet'; chatList.appendChild(n);
        }
    }

    function buildChatLi(record) {
        const { sessionId, title, pinned } = record;
        const li = document.createElement('li');
        li.className = 'chat-item' + (String(pinned) === 'true' ? ' pinned' : '');
        li.dataset.sessionId = sessionId;
        li.innerHTML = `<span class="pin-ic">${svg('pin')}</span><span class="chat-label"></span><button class="dots" aria-label="Chat options">${svg('more')}</button>`;
        li.querySelector('.chat-label').textContent = title || 'Untitled';
        return li;
    }
    function placeTop(li) {
        const lp = [...chatList.querySelectorAll('.chat-item.pinned')].pop();
        lp ? lp.after(li) : chatList.prepend(li);
    }
    function addChatLi(record, prepend = false) {
        chatList.querySelector('.chat-empty')?.remove();
        const li = buildChatLi(record);
        li.addEventListener('click', e => {
            if (e.target.closest('.dots')) return;
            openChatById(li.dataset.sessionId, li);
        });
        if (prepend) placeTop(li); else chatList.appendChild(li);
        filterChats();
        return li;
    }

    async function loadSidebar() {
        try {
            const res = await fetch(api('api/chats'));
            if (!res.ok) throw new Error('status ' + res.status);
            const data = await getJSON(res);
            chatList.innerHTML = '';
            const chats = data.chats || [];
            chats.forEach(c => addChatLi(c));
            if (!chats.length) showChatListEmpty();
        } catch (e) {
            console.warn('Could not load sidebar:', e);
            showChatListEmpty();
        }
    }

    async function openChatById(sessionId, li) {
        if (currentSessionId === sessionId) { app.classList.remove('open'); return; }
        if (busy) { toast('Stop the current reply first'); return; }

        chatList.querySelectorAll('.chat-item').forEach(x => x.classList.remove('active'));
        li.classList.add('active');
        currentSessionId = sessionId;
        currentLi = li;
        tempHistory = [];
        setTemp(false, true);

        epoch++;
        if (ctrl) ctrl.abort();
        messages.innerHTML = '<div class="chat-loading">Loading…</div>';
        main.classList.remove('is-empty');
        setBusy(false); updateTop();
        app.classList.remove('open');

        try {
            const res = await fetch(api(`api/chats/${sessionId}`));
            if (!res.ok) throw new Error('status ' + res.status);
            const data = await getJSON(res);
            const history = data.messages || [];
            if (!history.length) { messages.innerHTML = ''; main.classList.add('is-empty'); return; }
            renderHistory(history);
        } catch (e) {
            messages.innerHTML = '';
            showError('Could not load this chat.');
        }
        setBusy(false); updateTop();
    }

    // Render a saved conversation instantly (no word-by-word fade)
    function renderHistory(history) {
        messages.innerHTML = '';
        history.forEach(msg => {
            if (msg.role === 'user') {
                const w = document.createElement('div');
                w.className = 'msg-user-wrap'; w._text = msg.content;
                w.innerHTML = `<div class="msg-user"></div><div class="u-actions"><button class="ia-btn" data-a="copy" aria-label="Copy" title="Copy">${svg('copy')}</button><button class="ia-btn" data-a="edit" aria-label="Edit" title="Edit">${svg('edit')}</button></div>`;
                w.querySelector('.msg-user').textContent = msg.content;
                messages.appendChild(w);
            } else {
                const d = document.createElement('div');
                d.className = 'msg-ai';
                const body = document.createElement('div');
                body.className = 'ai-body';
                const ans = document.createElement('div');
                ans.className = 'answer md';
                if (window.marked) ans.innerHTML = marked.parse(msg.content); else ans.textContent = msg.content;
                body.appendChild(ans);
                addDeviceExtras(body, msg.cards, msg.actions);
                d.appendChild(body);
                addActions(d, msg.content, true);
                messages.appendChild(d);
            }
        });
        scroller.scrollTop = scroller.scrollHeight;
    }

    /* ==========================================================
       CHAT ITEM ACTIONS: pin / rename / delete / branch
    ========================================================== */
    function togglePin(li) {
        const sid = li.dataset.sessionId;
        const pinned = !li.classList.contains('pinned');
        li.classList.toggle('pinned', pinned);
        if (pinned) chatList.prepend(li); else placeTop(li);
        toast(pinned ? 'Chat pinned' : 'Chat unpinned');
        fetch(api(`api/chats/${sid}`), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pinned })
        }).catch(e => console.warn('Pin update failed:', e));
    }

    async function branchChat(sourceSid) {
        if (!sourceSid) { toast('No chat to branch'); return; }
        try {
            const res = await fetch(api(`api/chats/${sourceSid}/branch`), { method: 'POST' });
            if (!res.ok) throw new Error('Branch failed');
            const data = await getJSON(res);
            const record = { sessionId: data.sessionId, title: data.title, pinned: 'false' };
            const li = addChatLi(record, true);
            openChatById(record.sessionId, li);
            toast('Branched into a new chat');
        } catch (e) {
            console.warn('Branch failed:', e);
            toast('Branch failed');
        }
    }

    function renameChat(li, newTitle) {
        const sid = li.dataset.sessionId;
        li.querySelector('.chat-label').textContent = newTitle;
        filterChats();
        fetch(api(`api/chats/${sid}`), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: newTitle })
        }).catch(e => console.warn('Rename failed:', e));
    }

    function removeChat(li) {
        const sid = li.dataset.sessionId;
        li.classList.add('removing');
        setTimeout(() => { li.remove(); showChatListEmpty(); }, 260);
        if (li === currentLi) resetChat();
        fetch(api(`api/chats/${sid}`), { method: 'DELETE' }).catch(e => console.warn('Delete failed:', e));
    }

    function chatItems(li) {
        const label = li.querySelector('.chat-label');
        const sid = li.dataset.sessionId;
        return [
            { l: li.classList.contains('pinned') ? 'Unpin' : 'Pin', i: 'pin', a: () => togglePin(li) },
            { l: 'Share', i: 'share', a: async () => { try { const res = await fetch(api(`api/chats/${sid}/share`), { method: 'POST' }); if (!res.ok) throw new Error('status ' + res.status); const d = await getJSON(res); await copyText(location.origin + location.pathname + '?share=' + encodeURIComponent(d.shareId)); toast('Share link copied'); } catch (e) { toast('Could not create share link'); } } },
            { l: 'Branch in new chat', i: 'branch', a: () => branchChat(sid) },
            'sep',
            { l: 'Rename', i: 'edit', a: () => openModal({ title: 'Rename this chat', input: true, value: label.textContent, ok: 'Rename', onOk: v => renameChat(li, v) }) },
            { l: 'Delete', i: 'trash', danger: true, a: () => openModal({ title: 'Delete chat?', text: `“${label.textContent}” will be removed from your recent chats.`, ok: 'Delete', danger: true, onOk: () => removeChat(li) }) }
        ];
    }

    /* ---------- context menus ---------- */
    let menuEl = null, menuAt = 0;
    function closeMenu() {
        if (menuEl) { menuEl.remove(); menuEl = null; }
        chatList.querySelectorAll('.menu-open').forEach(n => n.classList.remove('menu-open'));
    }
    function showMenu(items, x, y, li, key) {
        if (menuEl && menuEl._key === key) return;
        closeMenu(); closeRail(); menuAt = Date.now();
        if (li) li.classList.add('menu-open');
        menuEl = document.createElement('div');
        menuEl.className = 'menu'; menuEl._key = key;
        items.forEach(it => {
            if (it === 'sep') { const s = document.createElement('div'); s.className = 'sep'; menuEl.appendChild(s); return; }
            const b = document.createElement('button');
            if (it.danger) b.className = 'danger';
            b.innerHTML = svg(it.i) + `<span>${it.l}</span>`;
            b.onclick = () => { closeMenu(); it.a(); };
            menuEl.appendChild(b);
        });
        menuEl.style.left = Math.max(8, Math.min(x, window.innerWidth - 216)) + 'px';
        menuEl.style.top = Math.max(8, Math.min(y, window.innerHeight - items.length * 42 - 20)) + 'px';
        document.body.appendChild(menuEl);
    }
    chatList.addEventListener('click', e => {
        const btn = e.target.closest('.dots');
        if (!btn) return;
        const li = btn.closest('.chat-item'), r = btn.getBoundingClientRect();
        if (menuEl && menuEl._key === li) closeMenu(); else showMenu(chatItems(li), r.left, r.bottom + 4, li, li);
    });
    chatList.addEventListener('contextmenu', e => {
        const li = e.target.closest('.chat-item');
        if (li) { e.preventDefault(); showMenu(chatItems(li), e.clientX, e.clientY, li, li); }
    });
    let pressTimer = null;
    chatList.addEventListener('touchstart', e => {
        const li = e.target.closest('.chat-item');
        if (!li) return;
        const t = e.touches[0];
        pressTimer = setTimeout(() => { showMenu(chatItems(li), t.clientX, t.clientY, li, li); if (navigator.vibrate) navigator.vibrate(10); }, 450);
    }, { passive: true });
    ['touchend', 'touchmove', 'touchcancel'].forEach(ev => chatList.addEventListener(ev, () => clearTimeout(pressTimer), { passive: true }));

    // top-right "⋮" acts on the current conversation
    moreBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (!currentLi) return;
        if (menuEl && menuEl._key === 'top') { closeMenu(); return; }
        const r = moreBtn.getBoundingClientRect();
        showMenu(chatItems(currentLi), r.right - 208, r.bottom + 6, null, 'top');
    });

    /* ---------- collapsed-rail popovers ---------- */
    let railPop = null;
    function closeRail() { if (railPop) { railPop.remove(); railPop = null; } }
    function openRail(kind, btn) {
        if (railPop && railPop._k === kind) { closeRail(); return; }
        closeRail(); closeMenu();
        const r = btn.getBoundingClientRect(), d = document.createElement('div');
        d.className = 'rail-pop'; d._k = kind;
        d.style.left = (r.right + 14) + 'px'; d.style.top = r.top + 'px';
        d.innerHTML = kind === 'search' ? `<div class="search">${svg('search')}<input placeholder="Search chats" autocomplete="off"></div><ul></ul>` : '<p class="pop-title">Pinned</p><ul></ul>';
        const ul = d.querySelector('ul');
        const fill = q => {
            const label = li => li.querySelector('.chat-label').textContent;
            const list = [...chatList.querySelectorAll('.chat-item')]
                .filter(li => (kind === 'search' || li.classList.contains('pinned')) && label(li).toLowerCase().includes(q));
            ul.innerHTML = '';
            if (!list.length) {
                const li = document.createElement('li'); li.className = 'none';
                li.textContent = kind === 'pin' ? 'No pinned chats yet' : 'No chats found';
                ul.appendChild(li);
                return;
            }
            list.forEach(src => {
                const li = document.createElement('li');
                li.className = 'rp-item' + (src.dataset.sessionId === currentSessionId ? ' active' : '');
                li.textContent = label(src);
                li.onclick = () => { closeRail(); openChatById(src.dataset.sessionId, src); };
                ul.appendChild(li);
            });
        };
        fill('');
        const inp = d.querySelector('input');
        if (inp) { inp.oninput = () => fill(inp.value.trim().toLowerCase()); setTimeout(() => inp.focus(), 30); }
        document.body.appendChild(d); railPop = d;
    }
    $('rail-search').onclick = e => { e.stopPropagation(); openRail('search', e.currentTarget); };
    $('rail-pin').onclick = e => { e.stopPropagation(); openRail('pin', e.currentTarget); };

    document.addEventListener('click', e => {
        if (menuEl && Date.now() - menuAt > 500 && !menuEl.contains(e.target)) closeMenu();
        if (!mm.contains(e.target)) closeModelMenu();
        if (railPop && !railPop.contains(e.target)) closeRail();
    });
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        const anyOpen = menuEl || railPop || modal.classList.contains('show') || mm.classList.contains('show');
        if (anyOpen) { closeMenu(); closeModal(); closeModelMenu(); closeRail(); }
        else if (busy && ctrl) ctrl.abort();
    });

    /* ---------- empty <-> chat transition ---------- */
    function flip(change) {
        const first = wrap.getBoundingClientRect().top;
        change();
        const d = first - wrap.getBoundingClientRect().top;
        if (!d) return;
        wrap.style.transition = 'none';
        wrap.style.transform = `translateY(${d}px)`;
        wrap.getBoundingClientRect();
        wrap.style.transition = 'transform .55s cubic-bezier(.22,.8,.2,1)';
        wrap.style.transform = '';
    }
    function ghostGreeting() {
        const r = empty.getBoundingClientRect(), g = empty.cloneNode(true);
        Object.assign(g.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', margin: '0', animation: 'none', pointerEvents: 'none', zIndex: 5, transition: 'opacity .25s, transform .25s' });
        document.body.appendChild(g);
        requestAnimationFrame(() => { g.style.opacity = '0'; g.style.transform = 'translateY(-8px)'; });
        setTimeout(() => g.remove(), 320);
    }

    /* ==========================================================
       MESSAGES
    ========================================================== */
    function addUser(text) {
        const w = document.createElement('div');
        w.className = 'msg-user-wrap'; w._text = text;
        w.innerHTML = `<div class="msg-user"></div><div class="u-actions"><button class="ia-btn" data-a="copy" aria-label="Copy" title="Copy">${svg('copy')}</button><button class="ia-btn" data-a="edit" aria-label="Edit" title="Edit">${svg('edit')}</button></div>`;
        w.querySelector('.msg-user').textContent = text;
        messages.appendChild(w);
        userEl = w; follow = true; startFollow();
        return w;
    }

    function editUser(w) {
        if (busy) { toast('Stop the reply first'); return; }
        // each earlier exchange = 1 user + 1 assistant message in the saved history
        const editFromIndex = [...messages.querySelectorAll('.msg-user-wrap')].indexOf(w) * 2;

        const ed = document.createElement('div');
        ed.className = 'u-edit';
        ed.innerHTML = '<textarea rows="1"></textarea><div class="u-edit-actions"><button class="btn-ghost">Cancel</button><button class="btn-solid">Send</button></div>';
        const ta = ed.querySelector('textarea'), [cancel, send] = ed.querySelectorAll('button');
        const size = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 240) + 'px'; };
        ta.value = w._text; ta.oninput = size;
        cancel.onclick = () => { ed.remove(); w.classList.remove('editing'); };
        send.onclick = () => {
            const v = ta.value.trim(); if (!v) return;
            while (w.nextSibling) w.nextSibling.remove();
            w.remove();
            input.value = v;
            sendMessage(editFromIndex);
        };
        w.classList.add('editing'); w.after(ed); size(); ta.focus();
    }

    messages.addEventListener('click', e => {
        const b = e.target.closest('.u-actions button');
        if (!b) return;
        const w = b.closest('.msg-user-wrap');
        b.dataset.a === 'copy' ? copyText(w._text) : editUser(w);
    });
    let userPress = null;
    messages.addEventListener('touchstart', e => {
        const bub = e.target.closest('.msg-user');
        if (!bub) return;
        const w = bub.parentNode, t = e.touches[0];
        userPress = setTimeout(() => {
            showMenu([{ l: 'Copy', i: 'copy', a: () => copyText(w._text) }, { l: 'Edit', i: 'edit', a: () => editUser(w) }], t.clientX, t.clientY, null, w);
            if (navigator.vibrate) navigator.vibrate(10);
        }, 450);
    }, { passive: true });
    ['touchend', 'touchmove', 'touchcancel'].forEach(ev => messages.addEventListener(ev, () => clearTimeout(userPress), { passive: true }));
    messages.addEventListener('contextmenu', e => { if (e.target.closest('.msg-user') && matchMedia('(hover: none)').matches) e.preventDefault(); });

    function addAI(mode) {
        const d = document.createElement('div');
        d.className = 'msg-ai';
        d.innerHTML = '<div class="ai-body"><div class="thinking"><i></i><i></i><i></i>' + (mode === 'thinking' ? '<span class="shimmer">Thinking</span>' : '') + '</div></div>';
        messages.appendChild(d);
        return d;
    }
    function addActions(aiMsg, raw, canBranch) {
        const d = document.createElement('div');
        d.className = 'ai-actions';
        d.innerHTML = `<button class="ia-btn" data-a="copy" aria-label="Copy" title="Copy">${svg('copy')}</button><button class="ia-btn" data-a="branch" aria-label="Branch in new chat" title="Branch in new chat">${svg('branch')}</button>`;
        d.onclick = e => {
            const b = e.target.closest('button');
            if (!b) return;
            if (b.dataset.a === 'copy') copyText(raw); else branchChat(currentSessionId);
        };
        if (!canBranch) d.querySelector('[data-a="branch"]').remove();
        aiMsg.appendChild(d);
    }
    // Live actuator cards (same as the Devices page) and "done" chips for actions Yageno AI ran
    const OK_IC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5 10 17.5 19 7.5"/></svg>';
    const NO_IC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    function addDeviceExtras(body, cards, actions) {
        if (actions && actions.length) {
            const d = document.createElement('div');
            d.className = 'chat-done';
            actions.forEach(a => {
                const s = document.createElement('span');
                if (!a.ok) s.className = 'fail';
                s.innerHTML = a.ok ? OK_IC : NO_IC;
                s.appendChild(document.createTextNode(a.ok ? 'Sent to Mark 1: ' + a.text : a.text || 'Could not do that'));
                d.appendChild(s);
            });
            body.appendChild(d);
        }
        const Y = window.YagenoDevices;
        if (cards && cards.length && Y) {
            const w = document.createElement('div');
            w.className = 'chat-cards';
            cards.forEach(a => { const c = Y.card(a); if (c) w.appendChild(c); });
            if (w.children.length) body.appendChild(w);
        }
    }
    function buildThink() {
        const d = document.createElement('div');
        d.className = 'think open';
        d.innerHTML = `<button class="think-head" aria-expanded="true"><span class="think-label shimmer">Thinking…</span>${svg('chev')}</button><div class="think-body"><div class="think-inner"><div class="think-text md"></div></div></div>`;
        const head = d.querySelector('.think-head');
        head.onclick = () => head.setAttribute('aria-expanded', String(d.classList.toggle('open')));
        return d;
    }

    /* ---------- markdown word-reveal ---------- */
    const BLOCK = /^(LI|P|H[1-6]|PRE|BLOCKQUOTE|TR|TABLE|UL|OL)$/;
    function renderMarkdown(el, text) {
        if (window.marked) el.innerHTML = marked.parse(text); else el.textContent = text;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), nodes = [], spans = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        nodes.forEach(n => {
            const frag = document.createDocumentFragment();
            n.nodeValue.split(/(\s+)/).forEach(p => {
                if (!p) return;
                if (/^\s+$/.test(p)) { frag.appendChild(document.createTextNode(' ')); return; }
                const s = document.createElement('span');
                s.className = 'w'; s.textContent = p; s._a = [];
                for (let a = n.parentNode; a && a !== el; a = a.parentNode) {
                    if (BLOCK.test(a.nodeName)) { a.classList.add('pend'); s._a.push(a); }
                }
                frag.appendChild(s); spans.push(s);
            });
            n.replaceWith(frag);
        });
        return spans;
    }
    function reveal(spans, signal, msPerWord = 30, maxMs = 4000) {
        return new Promise(resolve => {
            const total = Math.min(Math.max(spans.length * msPerWord, 400), maxMs), start = performance.now();
            let shown = 0;
            (function tick(now) {
                if (signal.aborted) return resolve();
                const target = Math.min(spans.length, Math.ceil(((now - start) / total) * spans.length));
                for (; shown < target; shown++) { spans[shown].classList.add('in'); spans[shown]._a.forEach(n => n.classList.remove('pend')); }
                if (shown < spans.length) requestAnimationFrame(tick); else resolve();
            })(start);
        });
    }

    /* ---------- busy / top bar state ---------- */
    function setBusy(b) {
        busy = b;
        sendBtn.innerHTML = b ? STOP : svg('send').replace('stroke-width="2"', 'stroke-width="2.2"');
        sendBtn.setAttribute('aria-label', b ? 'Stop' : 'Send');
        updateSend();
    }
    function updateSend() { sendBtn.disabled = !busy && !input.value.trim(); }
    function updateTop() { newTop.disabled = messages.children.length === 0; moreBtn.disabled = !currentLi; }

    function resetChat() {
        epoch++;
        if (ctrl) ctrl.abort();
        currentSessionId = null; currentLi = null; userEl = null;
        tempHistory = [];
        setTemp(false, true);
        chatList.querySelectorAll('.chat-item').forEach(x => x.classList.remove('active'));
        if (!main.classList.contains('is-empty')) flip(() => { messages.innerHTML = ''; main.classList.add('is-empty'); });
        input.value = ''; input.style.height = 'auto';
        setBusy(false); updateTop();
        app.classList.remove('open');
    }

    /* ==========================================================
       CORE: sendMessage
    ========================================================== */
    async function sendMessage(editFromIndex = undefined) {
        hideError();
        const text = input.value.trim();
        if (!text || busy) return;
        input.value = ''; input.style.height = 'auto';

        if (main.classList.contains('is-empty')) { ghostGreeting(); flip(() => main.classList.remove('is-empty')); }

        const isTemp = temp;
        let sessionId = currentSessionId;

        if (!isTemp && !sessionId) {
            // brand-new saved chat: client creates the id, sidebar entry appears right away
            sessionId = crypto.randomUUID();
            currentSessionId = sessionId;
            const shortTitle = text.length > 34 ? text.slice(0, 34) + '…' : text;
            currentLi = addChatLi({ sessionId, title: shortTitle, pinned: 'false' }, true);
            chatList.querySelectorAll('.chat-item').forEach(x => x.classList.toggle('active', x === currentLi));
        }

        const mode = model, t0 = performance.now();
        const myEpoch = ++epoch;
        ctrl = new AbortController();
        const signal = ctrl.signal;

        // temporary chats keep their history in the browser and send it along
        if (isTemp && editFromIndex !== undefined) tempHistory = tempHistory.slice(0, editFromIndex);
        if (isTemp) tempHistory.push({ role: 'user', content: text });

        addUser(text);
        const aiMsg = addAI(mode), body = aiMsg.firstElementChild;
        setBusy(true); updateTop();

        let thinkSpans = [], spans = [], label = null, raw = '';

        const payload = {
            prompt: text,
            mode,
            temp: isTemp,
            sessionId: isTemp ? null : sessionId,
            history: isTemp ? tempHistory.slice(0, -1) : undefined,
            editFromIndex: editFromIndex !== undefined ? editFromIndex : undefined
        };

        try {
            const res = await fetch(api('api/chat'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal
            });
            if (!res.ok) throw new Error('HTTP error! status: ' + res.status);
            const data = await getJSON(res);
            if (myEpoch !== epoch) return;

            const secs = Math.max(1, Math.round((performance.now() - t0) / 1000));
            const reasoning = mode === 'thinking' ? String(data.reasoning ?? data.thinking ?? '').trim() : '';
            raw = String(data.text ?? '');
            if (!raw.trim() && !reasoning) throw new Error('empty');
            body.innerHTML = '';

            if (isTemp) tempHistory.push({ role: 'assistant', content: raw });

            // backend sends a short title for brand-new chats
            if (!isTemp && data.title && currentLi) {
                currentLi.querySelector('.chat-label').textContent = data.title;
                filterChats();
            }

            if (reasoning) {
                const think = buildThink();
                body.appendChild(think);
                label = think.querySelector('.think-label');
                thinkSpans = renderMarkdown(think.querySelector('.think-text'), reasoning);
                await reveal(thinkSpans, signal, 12, 3000);
                if (!signal.aborted) {
                    label.classList.remove('shimmer');
                    label.textContent = `Thought for ${secs}s`;
                    think.classList.remove('open');
                    think.querySelector('.think-head').setAttribute('aria-expanded', 'false');
                    await sleep(420);
                }
            }
            if (!signal.aborted) {
                const ans = document.createElement('div');
                ans.className = 'answer md';
                body.appendChild(ans);
                spans = renderMarkdown(ans, raw);
                await reveal(spans, signal);
                if (!signal.aborted) addDeviceExtras(body, data.cards, data.actions);
            }
        } catch (e) {
            if (myEpoch !== epoch) return;
            if (e.name !== 'AbortError') {
                if (isTemp && tempHistory.length) tempHistory.pop();   // failed: take the user message back out
                showFailure(aiMsg, body, e, text);
            }
        }
        if (myEpoch !== epoch) return;

        if (signal.aborted) {
            [...thinkSpans, ...spans].forEach(s => { if (!s.classList.contains('in')) s.remove(); });
            if (label && label.classList.contains('shimmer')) { label.classList.remove('shimmer'); label.textContent = 'Thought process'; }
            if (!thinkSpans.length && !spans.length) aiMsg.remove();
            const note = document.createElement('div');
            note.className = 'stop-note';
            note.textContent = 'This response was stopped';
            messages.appendChild(note);
        }
        if (aiMsg.isConnected && body.querySelector('.answer')) addActions(aiMsg, raw, !isTemp);
        ctrl = null;
        setBusy(false); updateTop();
    }

    /* ---------- inline error + retry ---------- */
    function showFailure(aiMsg, body, e, text) {
        const offline = navigator.onLine === false || /fetch|network|load failed/i.test(e.message);
        const status = /status: (\d+)/.exec(e.message);
        const msg = offline ? 'No connection. Check your internet and try again.'
            : e.message === 'BAD_RESPONSE' || e instanceof SyntaxError ? 'The server sent an unexpected response.'
                : status ? `Something went wrong (error ${status[1]}).` : 'Yageno AI didn\u2019t send a reply.';
        body.innerHTML = `<div class="msg-err"><span class="err-ic">${svg('alert')}</span><span class="err-text"></span><button class="retry-btn">${svg('retry')}<span>Retry</span></button></div>`;
        body.querySelector('.err-text').textContent = msg;
        body.querySelector('.retry-btn').onclick = () => {
            if (busy) return;
            const w = aiMsg.previousElementSibling;
            if (!w || !w.classList.contains('msg-user-wrap')) return;
            while (w.nextSibling) w.nextSibling.remove();
            w.remove();
            input.value = text; sendMessage();
        };
    }

    /* ---------- temporary chat ---------- */
    const tempBtn = $('temp-btn'), gH1 = empty.querySelector('h1'), gSub = empty.querySelector('.sub'), gTxt = [gH1.textContent, gSub.textContent];
    function setTemp(on, silent) {
        if (temp === on) return;
        temp = on;
        main.classList.toggle('temp', on);
        tempBtn.setAttribute('aria-pressed', String(on));
        gH1.textContent = on ? 'Temporary chat' : gTxt[0];
        gSub.textContent = on ? 'This chat won\u2019t be saved to your recent chats.' : gTxt[1];
        if (!silent) toast(on ? 'Temporary chat on' : 'Temporary chat off');
    }
    tempBtn.addEventListener('click', () => {
        const on = !temp;
        if (messages.children.length) resetChat();
        setTemp(on);
    });

    /* ---------- events ---------- */
    input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 200) + 'px';
        updateSend();
    });
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isTouch()) { e.preventDefault(); sendMessage(); }
    });
    sendBtn.addEventListener('click', () => { busy ? ctrl && ctrl.abort() : sendMessage(); });
    newTop.addEventListener('click', resetChat);
    $('new-chat').addEventListener('click', resetChat);
    document.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => { input.value = c.textContent; sendMessage(); }));

    /* ---------- keyboard shortcuts + hover hints (⌘ on Mac, Ctrl on Windows/Linux) ---------- */
    const IS_MAC = /mac|iphone|ipad/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent);
    const SC = {
        new: { label: 'New chat', code: 'KeyO', shift: true },
        sidebar: { label: 'Toggle sidebar', code: 'KeyB' },
        search: { label: 'Search chats', code: 'KeyK' },
        temp: { label: 'Temporary chat', code: 'KeyX', shift: true },
        model: { label: 'Switch model', code: 'KeyM', shift: true }
    };
    const keysText = s => IS_MAC ? '⌘' + (s.shift ? '⇧' : '') + s.code.slice(3)
        : ['Ctrl', s.shift && 'Shift', s.code.slice(3)].filter(Boolean).join('+');
    const ACTIONS = {
        new: () => { resetChat(); input.focus(); },
        sidebar: () => { if (isDesktop()) setCollapsed(!app.classList.contains('collapsed')); else app.classList.toggle('open'); },
        search: () => { if (isDesktop()) setCollapsed(false); else app.classList.add('open'); setTimeout(() => searchEl.focus(), 340); },
        temp: () => tempBtn.click(),
        model: () => { setModel(model === 'flash' ? 'thinking' : 'flash'); toast('Yageno ' + (model === 'thinking' ? 'Thinking' : 'Flash')); }
    };
    document.addEventListener('keydown', e => {
        if (e.isComposing || e.altKey) return;
        const mod = IS_MAC ? (e.metaKey && !e.ctrlKey) : (e.ctrlKey && !e.metaKey);
        if (mod) {
            for (const id in SC) {
                if (e.code === SC[id].code && e.shiftKey === !!SC[id].shift) { e.preventDefault(); ACTIONS[id](); return; }
            }
        } else if (e.key === '/' && !e.metaKey && !e.ctrlKey && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
            e.preventDefault(); input.focus();
        }
    });

    // small tooltip: label + dimmed shortcut (only on devices that can hover)
    const tip = document.createElement('div');
    tip.className = 'tip';
    document.body.appendChild(tip);
    let tipT = 0, tipEl = null;
    const hideTip = () => { clearTimeout(tipT); tip.classList.remove('show'); tipEl = null; };
    document.addEventListener('mouseover', e => {
        if (!matchMedia('(hover: hover)').matches) return;
        const el = e.target.closest && e.target.closest('[data-sc]');
        if (!el || el === tipEl || el.closest('.sb-body')) return; // open sidebar uses inline hints
        hideTip(); tipEl = el;
        tipT = setTimeout(() => {
            const s = SC[el.dataset.sc];
            tip.innerHTML = `<span>${s.label}</span><kbd>${keysText(s)}</kbd>`;
            const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
            if (el.closest('.sidebar')) {
                // sidebar items: tip goes to the right, never over neighbours
                tip.style.left = Math.min(r.right + 10, window.innerWidth - w - 8) + 'px';
                tip.style.top = Math.max(8, r.top + r.height / 2 - h / 2) + 'px';
            } else {
                let top = r.bottom + 8;
                if (top + h > window.innerHeight - 8) top = r.top - h - 8;
                tip.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8)) + 'px';
                tip.style.top = top + 'px';
            }
            tip.classList.add('show');
        }, 450);
    });
    document.addEventListener('mouseout', e => { if (tipEl && !tipEl.contains(e.relatedTarget)) hideTip(); });
    document.addEventListener('mousedown', hideTip);

    /* ---------- share links: open as a branch in the current user's account ---------- */
    async function importShared() {
        const sid = window.YAGENO && YAGENO.takeShare();
        if (!sid) return;
        try {
            const res = await fetch(api(`api/share/${encodeURIComponent(sid)}/import`), { method: 'POST' });
            if (!res.ok) throw new Error('status ' + res.status);
            const d = await getJSON(res);
            const li = chatList.querySelector(`[data-session-id="${d.sessionId}"]`) || addChatLi({ sessionId: d.sessionId, title: d.title, pinned: 'false' }, true);
            openChatById(d.sessionId, li);
            toast(d.own ? 'Opened your chat' : 'Shared chat added as a branch');
        } catch (e) {
            toast('This share link is not valid');
        }
    }

    /* ---------- init ---------- */
    document.querySelectorAll('[data-sck]').forEach(k => { k.textContent = keysText(SC[k.dataset.sck]); });
    setBusy(false);
    updateTop();
    (window.YAGENO ? YAGENO.ready : Promise.resolve()).then(async () => {
        if (window.YAGENO && YAGENO.user) {
            gTxt[0] = `Hi ${YAGENO.user}, Yageno AI is watching the farm.`;
            if (!temp) gH1.textContent = gTxt[0];
        }
        await loadSidebar();
        await importShared();
        if (isDesktop()) input.focus();
    });
})();
// SPDX-FileCopyrightText: Copyright (C) 2026 Athokpam Yaraba Luwang
// SPDX-License-Identifier: AGPL-3.0-or-later

(() => {
    'use strict';

    const K = { user: 'yageno-user', project: 'yageno-project', share: 'yageno-share', login: 'yageno-login-mode', onboard: 'yageno-onboard' };
    const lsGet = k => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
    const lsSet = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) { } };
    const ssGet = k => { try { return sessionStorage.getItem(k) || ''; } catch (e) { return ''; } };
    const ssSet = (k, v) => { try { v ? sessionStorage.setItem(k, v) : sessionStorage.removeItem(k); } catch (e) { } };

    /* Same base-path logic as app.js, so it works behind the API Gateway prefix */
    const apiBase = (() => {
        try {
            const s = document.currentScript && document.currentScript.src;
            if (s) return new URL('../', s).pathname.replace(/\/$/, '');
        } catch (e) { }
        return window.location.pathname.replace(/\/$/, '');
    })();
    const api = p => `${apiBase}/${p}`;

    /* A share link looks like  .../?share=<chatId>. Keep it until the person is signed in. */
    try {
        const sp = new URLSearchParams(location.search).get('share');
        if (sp) {
            ssSet(K.share, sp);
            history.replaceState(null, '', location.pathname + location.hash);
        }
    } catch (e) { }

    const Y = window.YAGENO = {
        user: lsGet(K.user),
        project: lsGet(K.project),
        takeShare() { const s = ssGet(K.share); ssSet(K.share, ''); return s; }
    };
    let resolveReady;
    Y.ready = new Promise(r => { resolveReady = r; });

    /* Add the identity headers to every call to our own API (app.js needs no changes for this) */
    const rawFetch = window.fetch.bind(window);
    window.fetch = (input, init = {}) => {
        if (typeof input === 'string' && input.startsWith(apiBase + '/api/')) {
            const h = new Headers(init.headers || {});
            if (Y.user) h.set('X-Username', Y.user);
            if (Y.project) h.set('X-Project', Y.project);
            init = { ...init, headers: h };
        }
        return rawFetch(input, init);
    };

    const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
    const root = document.documentElement;

    /* ---------- themes: names, picker state, and saving to the user's record ---------- */
    const THEMES = [
        { id: 'green', name: 'Alpine Green', accent: '#008184' },
        { id: 'blue', name: 'Sierra Blue', accent: '#2563eb' },
        { id: 'pink', name: 'Rose Gold', accent: '#d6336c' },
        { id: 'wood', name: 'Desert Titanium', accent: '#8b5a2b' },
        { id: 'grey', name: 'Natural Titanium', accent: '#6b7280' },
        { id: 'lavender', name: 'Lavender Mist', accent: '#7c5cc4' },
        { id: 'dark-green', name: 'Midnight Green', accent: '#4db6ac', bg: '#121716' },
        { id: 'dark-blue', name: 'Pacific Blue', accent: '#1d9bf0', bg: '#15202b' },
        { id: 'dark-pink', name: 'Rose Noir', accent: '#e57fa3', bg: '#1a1417' },
        { id: 'dark-wood', name: 'Bronze Night', accent: '#c49a6c', bg: '#1a1612' },
        { id: 'dark-grey', name: 'Space Gray', accent: '#a8afbb', bg: '#1a1a1c' },
        { id: 'dark-lavender', name: 'Deep Purple', accent: '#b4a7e8', bg: '#17151e' }
    ];
    const THEME_IDS = new Set(THEMES.map(t => t.id));
    let savedTheme = Y.user ? (root.dataset.theme || '') : '', themeTimer = 0;   // so page loads never overwrite the saved theme

    function pickTheme(id) {
        if (!THEME_IDS.has(id)) return;
        if (root.dataset.theme !== id) root.dataset.theme = id;
        lsSet('yageno-theme', id);
        document.querySelectorAll('.tchip, #swatches .swatch').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.theme === id)));
    }
    function saveTheme(id) {
        if (!Y.user || !THEME_IDS.has(id) || id === savedTheme) return;
        savedTheme = id;
        fetch(api('api/users/theme'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ theme: id })
        }).catch(() => { savedTheme = ''; });
    }
    /* Any theme change (gate chips or the sidebar Settings swatches) is saved to the signed-in user's record */
    new MutationObserver(() => {
        clearTimeout(themeTimer);
        themeTimer = setTimeout(() => saveTheme(root.dataset.theme), 500);
    }).observe(root, { attributes: true, attributeFilter: ['data-theme'] });

    /* ---------- user menu in the sidebar footer ---------- */
    const IC_SWITCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h11l-3-3M17 17H6l3 3"/></svg>';
    const IC_OUT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>';
    let userMenu = null;
    const closeUserMenu = () => { if (userMenu) { userMenu.remove(); userMenu = null; } };

    function mountUserChip() {
        const foot = document.querySelector('.sb-foot');
        if (!foot || document.getElementById('user-btn') || !Y.user) return;
        const b = el('button', 'nav-item');
        b.id = 'user-btn';
        b.setAttribute('aria-haspopup', 'true');
        b.innerHTML = '<span class="u-av"></span><span class="nav-text u-name"></span>';
        b.querySelector('.u-av').textContent = Y.user[0].toUpperCase();
        b.querySelector('.u-name').textContent = '@' + Y.user;
        foot.appendChild(b);

        b.addEventListener('click', e => {
            e.stopPropagation();
            if (userMenu) { closeUserMenu(); return; }
            const r = b.getBoundingClientRect();
            userMenu = el('div', 'menu');
            userMenu.style.left = Math.max(8, r.left) + 'px';
            userMenu.style.bottom = (window.innerHeight - r.top + 6) + 'px';
            const items = [
                [IC_SWITCH, 'Switch project', () => { lsSet(K.project, ''); location.reload(); }],
                [IC_OUT, 'Sign out', () => { lsSet(K.user, ''); lsSet(K.project, ''); ssSet(K.login, '1'); location.reload(); }]
            ];
            items.forEach(([ic, label, fn]) => {
                const mb = el('button', '', ic + '<span></span>');
                mb.querySelector('span').textContent = label;
                mb.onclick = () => { closeUserMenu(); fn(); };
                userMenu.appendChild(mb);
            });
            document.body.appendChild(userMenu);
        });
        document.addEventListener('click', e => { if (userMenu && !userMenu.contains(e.target)) closeUserMenu(); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape') closeUserMenu(); });
    }

    function finish(gate) {
        lsSet(K.user, Y.user);
        lsSet(K.project, Y.project);
        lsSet(K.onboard, '');
        root.classList.remove('gated');
        mountUserChip();
        if (gate) {
            gate.classList.add('out');
            setTimeout(() => gate.remove(), 450);
        }
        resolveReady();
    }

    /* ---------- already signed in on this browser: no gate ---------- */
    if (Y.user && Y.project) {
        finish(null);
        return;
    }

    /* ---------- icons and project list (edit the order here) ---------- */
    const ICONS = {
        farm: '<path d="M7 20h10"/><path d="M10 20c5.5-2.5.8-6.4 3-10"/><path d="M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8z"/><path d="M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2z"/>',
        fire: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
        water: '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/>',
        air: '<path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2"/><path d="M9.6 4.6A2 2 0 1 1 11 8H2"/><path d="M12.6 19.4A2 2 0 1 0 14 16H2"/>',
        traffic: '<rect x="8" y="2" width="8" height="20" rx="3"/><circle cx="12" cy="7" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="17" r="1.2"/>',
        plus: '<path d="M12 5v14M5 12h14"/>'
    };
    const icon = n => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;
    const SOON = [
        ['fire', 'Forest fire', 'Smoke, heat, and early fire alerts.'],
        ['water', 'Water network', 'Tanks, pipes, and leaks.'],
        ['air', 'Air quality', 'AQI on streets and in schools.'],
        ['traffic', 'Traffic signals', 'Signal timing and congestion.']
    ];

    /* ---------- the gate ---------- */
    let mode = ssGet(K.login) ? 'login' : 'new';
    const gate = el('div', 'gate');
    gate.id = 'gate';
    gate.setAttribute('role', 'dialog');
    gate.setAttribute('aria-modal', 'true');
    gate.setAttribute('aria-label', 'Sign in to Yageno AI');
    gate.innerHTML = `
        <svg class="gate-trace" viewBox="0 0 1200 120" preserveAspectRatio="none" aria-hidden="true">
            <path pathLength="1" d="M0 72 H330 l14 -40 l22 78 l16 -38 H700 l10 -22 l16 44 l10 -22 H1200"/>
        </svg>
        <main class="gate-card">
            <header class="gate-event">
                <div class="ev-logos">
                    <span class="ev-logo"><img src="https://www.wemakedevs.org/_next/static/immutable/media/logo.2qiklzeh_kmwi.svg" alt="Bharat Builds Tour" referrerpolicy="no-referrer" onerror="this.parentNode.hidden=true"></span>
                    <span class="ev-x" aria-hidden="true">×</span>
                    <span class="ev-logo"><img src="https://thumb.wikimedia.org/wikipedia/commons/thumb/9/93/Amazon_Web_Services_Logo.svg/960px-Amazon_Web_Services_Logo.svg.png?utm_source=commons.wikimedia.org&amp;utm_campaign=index&amp;utm_content=thumbnail&amp;_=20170912170050" alt="Amazon Web Services" referrerpolicy="no-referrer" onerror="this.parentNode.hidden=true"></span>
                </div>
                <p>Environmental Hacks, Track 02: Heat and Water</p>
            </header>
            <section class="gate-step" data-step="user" hidden>
                <img class="gate-logo" src="static/logo.webp" alt="" onerror="this.style.display='none'">
                <h1 id="g-title"></h1>
                <p class="gate-sub" id="g-sub"></p>
                <form id="g-form" novalidate>
                    <label class="gate-field">
                        <span class="at" aria-hidden="true">@</span>
                        <input id="g-name" maxlength="20" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="username" aria-label="Username">
                    </label>
                    <p class="gate-status" id="g-status" aria-live="polite"></p>
                    <button class="gate-btn" id="g-go" type="submit" disabled></button>
                </form>
                <button class="gate-link" id="g-toggle" type="button"></button>
            </section>

            <section class="gate-step" data-step="project" hidden>
                <h1 id="g-hi"></h1>
                <p class="gate-sub">Pick the system you want to talk to.</p>
                <div class="pgrid">
                    <button class="pfarm" data-p="farm" type="button">
                        <span class="pico">${icon('farm')}</span>
                        <span class="pbody">
                            <span class="pstate"><i></i>Connected</span>
                            <b>Farm</b>
                            <span class="pdesc">Heat, soil moisture, and water use on a live farm, running on Mark 1 hardware.</span>
                        </span>
                        <span class="pgo">Open</span>
                    </button>
                    ${SOON.map(([ic, name, desc]) => `
                    <button class="ptile" data-soon="${name}" type="button">
                        <span class="pico">${icon(ic)}</span>
                        <b>${name}</b>
                        <span class="pdesc">${desc}</span>
                        <span class="ptag">Soon</span>
                    </button>`).join('')}
                    <button class="ptile padd" data-add type="button">
                        <span class="pico">${icon('plus')}</span>
                        <span class="pbody"><b>Add project</b><span class="pdesc">Connect a new set of sensors and actuators.</span></span>
                    </button>
                </div>
                <button class="gate-link" id="g-change" type="button"></button>
            </section>

            <section class="gate-step" data-step="theme" hidden>
                <h1>Pick your look</h1>
                <p class="gate-sub">These colours stay with your account on every device. You can change them later in Settings.</p>
                <div class="tgroup">
                    <p class="tlabel">Light</p>
                    <div class="tgrid" id="g-t-light"></div>
                </div>
                <div class="tgroup">
                    <p class="tlabel">Dark</p>
                    <div class="tgrid" id="g-t-dark"></div>
                </div>
                <button class="gate-btn" id="g-t-go" type="button">Start</button>
            </section>
        </main>
        <p class="gate-foot">Runs on AWS: API Gateway, Lambda, Bedrock, DynamoDB, and S3</p>

        <div class="g-dialog" id="g-dialog" hidden>
            <div class="g-dialog-card" role="alertdialog" aria-labelledby="g-d-title">
                <h2 id="g-d-title">Dear judges</h2>
                <p>Yageno is a plug-in, plug-out platform. Sensors and actuators connect through one API, and the same AI reads them, explains them, and acts on them with your approval.</p>
                <p id="g-d-note"></p>
                <button class="gate-btn" id="g-d-ok" type="button">Back to projects</button>
            </div>
        </div>`;
    document.body.appendChild(gate);

    const $g = s => gate.querySelector(s);

    /* theme step: named chips, light row then dark row */
    THEMES.forEach(t => {
        const b = el('button', 'tchip');
        b.type = 'button'; b.dataset.theme = t.id;
        b.innerHTML = '<span class="tdot"></span><span class="tname"></span>';
        b.querySelector('.tname').textContent = t.name;
        b.onclick = () => pickTheme(t.id);
        $g(t.bg ? '#g-t-dark' : '#g-t-light').appendChild(b);
    });
    pickTheme(root.dataset.theme || 'green');
    $g('#g-t-go').onclick = () => { saveTheme(root.dataset.theme); finish(gate); };
    const stepUser = $g('[data-step="user"]'), stepProject = $g('[data-step="project"]'), stepTheme = $g('[data-step="theme"]');
    const isOnboarding = () => lsGet(K.onboard) === '1';
    const nameIn = $g('#g-name'), statusEl = $g('#g-status'), goBtn = $g('#g-go'), form = $g('#g-form');
    const dialog = $g('#g-dialog');

    const HINT = '3 to 20 characters. Letters, numbers, and underscores.';
    let seq = 0, timer = 0, okName = false;

    function setStatus(kind, text) { statusEl.dataset.k = kind; statusEl.textContent = text; }

    function paintMode() {
        $g('#g-title').textContent = mode === 'new' ? 'Choose a username' : 'Welcome back';
        $g('#g-sub').textContent = mode === 'new'
            ? 'This is your ID on Yageno. Your chats are saved under it, so pick one you will remember.'
            : 'Enter the username you chose earlier.';
        goBtn.textContent = mode === 'new' ? 'Continue' : 'Sign in';
        $g('#g-toggle').textContent = mode === 'new' ? 'Already have a username? Sign in' : 'New here? Choose a username';
        validate();
    }

    function validate() {
        const v = nameIn.value = nameIn.value.toLowerCase().replace(/[^a-z0-9_]/g, '');
        okName = false; goBtn.disabled = true; clearTimeout(timer);
        const my = ++seq;
        if (!v) { setStatus('', HINT); return; }
        if (v.length < 3) { setStatus('', HINT); return; }
        setStatus('wait', 'Checking…');
        timer = setTimeout(async () => {
            try {
                const r = await fetch(api('api/users/check?name=' + encodeURIComponent(v)));
                if (!r.ok) throw new Error('status ' + r.status);
                const d = await r.json();
                if (my !== seq) return;
                if (mode === 'new') {
                    okName = !!d.available;
                    setStatus(okName ? 'ok' : 'bad', okName ? `@${v} is available.` : `@${v} is taken. Try another.`);
                } else {
                    okName = !!d.valid && !d.available;
                    setStatus(okName ? 'ok' : 'bad', okName ? `Found @${v}.` : `No user named @${v}.`);
                }
                goBtn.disabled = !okName;
            } catch (e) {
                if (my === seq) setStatus('bad', 'Cannot reach the server. Check your connection and try again.');
            }
        }, 300);
    }

    nameIn.addEventListener('input', validate);
    $g('#g-toggle').onclick = () => { mode = mode === 'new' ? 'login' : 'new'; ssSet(K.login, mode === 'login' ? '1' : ''); paintMode(); nameIn.focus(); };

    form.addEventListener('submit', async e => {
        e.preventDefault();
        if (!okName) return;
        const v = nameIn.value;
        goBtn.disabled = true;
        setStatus('wait', mode === 'new' ? 'Creating your account…' : 'Signing in…');
        try {
            const r = await fetch(api(mode === 'new' ? 'api/users/claim' : 'api/users/login'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: v })
            });
            if (r.status === 409) { okName = false; setStatus('bad', `@${v} was just taken. Try another.`); return; }
            if (r.status === 404) { okName = false; setStatus('bad', `No user named @${v}.`); return; }
            if (!r.ok) throw new Error('status ' + r.status);
            let d = {};
            try { d = await r.json(); } catch (e2) { }
            Y.user = v;
            lsSet(K.user, v);
            ssSet(K.login, '');
            if (mode === 'new') {
                lsSet(K.onboard, '1');                 // new account: project, then theme
            } else {
                lsSet(K.onboard, '');                  // returning account: theme comes from the database
                if (d.theme && THEME_IDS.has(d.theme)) { savedTheme = d.theme; pickTheme(d.theme); }
                else saveTheme(root.dataset.theme);    // older account with no saved theme yet
            }
            showStep('project');
        } catch (err) {
            setStatus('bad', 'Something went wrong. Try again.');
        } finally {
            goBtn.disabled = !okName;
        }
    });

    /* project step */
    $g('.pfarm').addEventListener('click', () => { Y.project = 'farm'; if (isOnboarding()) showStep('theme'); else finish(gate); });
    const openNote = text => { $g('#g-d-note').textContent = text; dialog.hidden = false; $g('#g-d-ok').focus(); };
    gate.querySelectorAll('[data-soon]').forEach(c => c.addEventListener('click', () => openNote(`${c.dataset.soon} is next on the roadmap. The farm is the project running live today, on our Mark 1 hardware.`)));
    $g('[data-add]').addEventListener('click', () => openNote('Adding a project will mean registering a new set of sensors and actuators and choosing what the AI may do with them. That screen is on the roadmap. The farm is the only live project in this demo.'));
    const closeDialog = () => { dialog.hidden = true; const f = $g('.pfarm'); if (f) f.focus(); };
    $g('#g-d-ok').onclick = closeDialog;
    dialog.addEventListener('mousedown', e => { if (e.target === dialog) closeDialog(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !dialog.hidden) closeDialog(); });

    $g('#g-change').onclick = () => {
        Y.user = ''; lsSet(K.user, ''); lsSet(K.onboard, '');
        mode = 'login'; ssSet(K.login, '1');
        showStep('user');
    };

    function showStep(which) {
        gate.dataset.step = which;
        stepUser.hidden = which !== 'user';
        stepProject.hidden = which !== 'project';
        stepTheme.hidden = which !== 'theme';
        if (which === 'user') {
            nameIn.value = '';
            paintMode();
            setTimeout(() => nameIn.focus(), 60);
        } else if (which === 'project') {
            $g('#g-hi').textContent = 'Hi, @' + Y.user;
            $g('#g-change').textContent = `Not @${Y.user}? Use a different username`;
            setTimeout(() => { const f = $g('.pfarm'); if (f) f.focus(); }, 60);
        } else {
            setTimeout(() => { const f = $g('.tchip[aria-pressed="true"]') || $g('.tchip'); if (f) f.focus(); }, 60);
        }
    }

    showStep(Y.user ? 'project' : 'user');
})();
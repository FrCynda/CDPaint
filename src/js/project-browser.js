/*
 * pokeemerald project asset browser.
 * Hooks a `graphics/` folder, shows indexed PNG assets with lazy thumbnails,
 * groups sibling `.pal` files (normal.pal / shiny.pal / <basename>.pal) as
 * PAL badges, and opens/saves assets preserving the exact palette + indices.
 */
(function () {
    'use strict';

    var STORAGE_KEY = 'cdpaint.projectRoot';
    var SHARED_PALS = ['normal.pal', 'shiny.pal'];

    var panel = document.getElementById('project-panel');
    var treeEl = document.getElementById('project-tree');
    var statusEl = document.getElementById('project-status');
    var expandBtn = document.getElementById('project-expand');
    var hookBtn = document.getElementById('project-hook');
    var refreshBtn = document.getElementById('project-refresh');
    var auditBtn = document.getElementById('project-audit');
    var unhookBtn = document.getElementById('project-unhook');
    var collapseBtn = document.getElementById('project-collapse');
    var closeBtn = document.getElementById('project-close');

    var MAX_SCAN_DEPTH = 12;
    var DENYLIST = ['.git', 'node_modules', 'target', '.vscode', '.idea', 'dist'];
    var currentRoot = null;
    var lastTree = null;
    var auditing = false;

    /* What the project says about itself — see src/js/project-model.js and
       src/js/sprite-coords.js. Null until a hooked folder turns out to be a
       decomp; every reader below falls back to convention when it is, which is
       what keeps the panel useful on a bare folder of PNGs. */
    var model = null;
    var nodeByRel = null;   // repo-relative path → the scanned node

    /* The repo-relative path of the asset the panel last opened.
       The engine cannot supply this: opening through a file handle — which is
       every open in browser mode — leaves `state.projectFile` holding the bare
       filename, because there is no path to hold. The panel is the only place
       that knows which node was clicked, so it is the place that remembers. */
    var openedRel = null;

    function getApp() { return window.PaintApp; }

    function isTauriEnv() {
        return !!(window.PaintApp && window.PaintApp.getTauriInvokeFn && window.PaintApp.getTauriInvokeFn());
    }

    function tauriInvoke(cmd, payload) {
        var app = getApp();
        if (app && typeof app.tauriInvoke === 'function') return app.tauriInvoke(cmd, payload || {});
        var tauri = window.__TAURI__;
        if (tauri && tauri.core && typeof tauri.core.invoke === 'function') return tauri.core.invoke(cmd, payload || {});
        throw new Error('Tauri invoke API is unavailable');
    }

    function fileSrc(path) {
        var tauri = window.__TAURI__;
        var cvt = null;
        if (tauri && tauri.core && typeof tauri.core.convertFileSrc === 'function') cvt = tauri.core.convertFileSrc;
        else if (tauri && typeof tauri.convertFileSrc === 'function') cvt = tauri.convertFileSrc;
        return cvt ? cvt(path) : null;
    }

    function getRoot() {
        try { return localStorage.getItem(STORAGE_KEY) || ''; } catch (e) { return ''; }
    }
    function setRoot(v) {
        try {
            if (v) localStorage.setItem(STORAGE_KEY, v);
            else localStorage.removeItem(STORAGE_KEY);
        } catch (e) { /* ignore */ }
        if (refreshBtn) refreshBtn.disabled = !v;
        if (unhookBtn) unhookBtn.disabled = !v;
        if (auditBtn) auditBtn.disabled = !v;
    }

    function setStatus(msg) { if (statusEl) statusEl.textContent = msg || ''; }

    function setLoading(v) { if (panel) panel.classList.toggle('project-loading', !!v); }

    var thumbObserver = ('IntersectionObserver' in window)
        ? new IntersectionObserver(function (entries, obs) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) return;
                var img = entry.target;
                obs.unobserve(img);
                loadThumb(img);
            });
        }, { rootMargin: '200px' })
        : null;

    function loadThumb(img) {
        if (img.dataset.loaded === '1') return;
        img.dataset.loaded = '1';
        var node = img._node;
        if (node && node.handle) {
            ensureHandleThumb(img, node.handle);
            return;
        }
        var src = img.dataset.src;
        if (src) {
            img.src = src;
            img.addEventListener('error', function () {
                var fallbackPath = img.dataset.path;
                if (!fallbackPath) { img.classList.add('proj-thumb-missing'); return; }
                tauriInvoke('read_image_file', { path: fallbackPath }).then(function (data) {
                    var bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
                    img.src = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
                }).catch(function () { img.classList.add('proj-thumb-missing'); });
            });
            return;
        }
        var path = img.dataset.path;
        if (!path) return;
        tauriInvoke('read_image_file', { path: path }).then(function (data) {
            var bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
            var url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
            img.src = url;
        }).catch(function () { img.classList.add('proj-thumb-missing'); });
    }

    function ensureHandleThumb(img, handle) {
        var run = function () {
            if (handle instanceof File) return Promise.resolve(handle);
            if (handle.queryPermission) {
                return Promise.resolve(handle.queryPermission({ mode: 'read' })).then(function (perm) {
                    if (perm === 'prompt' && handle.requestPermission) return handle.requestPermission({ mode: 'read' });
                    return perm;
                }).then(function () { return handle.getFile(); });
            }
            return Promise.resolve(handle.getFile());
        };
        run().then(function (file) {
            img.src = URL.createObjectURL(file);
        }).catch(function () {
            img.classList.add('proj-thumb-missing');
        });
    }

    function makeThumb(node) {
        var img = document.createElement('img');
        img.className = 'proj-thumb';
        img.alt = '';
        img.loading = 'lazy';
        img._node = node;
        if (node && node.handle) {
            if (thumbObserver) thumbObserver.observe(img);
            else loadThumb(img);
            return img;
        }
        var path = node && node.path;
        var src = fileSrc(path);
        if (src) {
            img.dataset.src = src;
            img.dataset.path = path;
        } else {
            img.dataset.path = path;
        }
        if (thumbObserver) thumbObserver.observe(img);
        else loadThumb(img);
        return img;
    }

    function palBadge(palNode, label, why) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'proj-pal-badge';
        b.textContent = label || 'PAL';
        // The reason the resolver offered this one. "Which palette is this?" has
        // to be checkable rather than taken on trust — a wrong pairing is how
        // the shiny sprite silently changes when you save the normal one.
        b.title = why
            ? 'Load ' + palNode.name + ' — ' + why
            : 'Load palette: ' + palNode.name;
        b.addEventListener('click', function (ev) {
            ev.stopPropagation();
            loadPal(palNode);
        });
        return b;
    }

    function loadPal(node) {
        var load = function (text) {
            var app = getApp();
            if (app && typeof app.loadProjectPalette === 'function') app.loadProjectPalette(node.name, text);
            else showToast('Palette loaded', 'info');
        };
        if (node && node.handle) {
            var p = node.handle instanceof File
                ? node.handle.text()
                : Promise.resolve(node.handle.getFile()).then(function (f) { return f.text(); });
            p.then(load).catch(function (e) {
                showToast('Failed to read palette: ' + (e && e.message ? e.message : e), 'error');
            });
            return;
        }
        tauriInvoke('read_text_file', { path: node.path || '' }).then(load).catch(function (e) {
            showToast('Failed to read palette: ' + (e && e.message ? e.message : e), 'error');
        });
    }

    /* `offers` is [{node, why}] — the resolver's answers, best first. The engine
       wants the bare nodes, the badges want the reasons. */
    function fileRow(pngNode, offers) {
        var palNodes = (offers || []).map(function (o) { return o.node; });
        var row = document.createElement('div');
        row.className = 'proj-row proj-row-file';

        var thumbWrap = document.createElement('div');
        thumbWrap.className = 'proj-thumb-wrap';
        thumbWrap.appendChild(makeThumb(pngNode));
        row.appendChild(thumbWrap);

        var label = document.createElement('span');
        label.className = 'proj-name';
        label.textContent = pngNode.name;
        row.appendChild(label);

        if (offers && offers.length) {
            var badgeWrap = document.createElement('span');
            badgeWrap.className = 'proj-pal-badges';
            offers.forEach(function (o) {
                badgeWrap.appendChild(palBadge(o.node, labelForPal(o.node), o.why));
            });
            row.appendChild(badgeWrap);
        }

        row.addEventListener('click', function () {
            var app = getApp();
            if (!app || typeof app.openProjectImage !== 'function') {
                showToast('Image viewer is not ready', 'warning');
                return;
            }
            openedRel = relOf(pngNode);
            if (pngNode.handle) app.openProjectImageFromHandle(pngNode, palNodes);
            else app.openProjectImage(pngNode.path, palNodes);
        });
        return row;
    }

    /* Now that the resolver offers several palettes for one asset — sixteen for
       a tileset, six for an icon — the badge has to say which is which. The
       stem does that; 'PAL' on all of them would not. */
    function labelForPal(palNode) {
        var n = palNode.name.toLowerCase().replace(/\.pal$/, '');
        if (n === 'normal') return 'N';
        if (n === 'shiny') return 'S';
        return n.length > 8 ? n.slice(0, 7) + '…' : n;
    }

    function palOnlyRow(palNode) {
        var row = document.createElement('div');
        row.className = 'proj-row proj-row-pal';
        var sw = document.createElement('span');
        sw.className = 'proj-pal-dot';
        row.appendChild(sw);
        var label = document.createElement('span');
        label.className = 'proj-name';
        label.textContent = palNode.name;
        row.appendChild(label);
        row.appendChild(palBadge(palNode, 'PAL'));
        row.addEventListener('click', function () { loadPal(palNode); });
        return row;
    }

    function dirRow(node) {
        var wrap = document.createElement('div');
        wrap.className = 'proj-dir';

        var header = document.createElement('div');
        header.className = 'proj-dir-header';
        var toggle = document.createElement('span');
        toggle.className = 'proj-dir-toggle';
        toggle.textContent = '\u25B8';
        header.appendChild(toggle);
        var name = document.createElement('span');
        name.className = 'proj-dir-name';
        name.textContent = node.name;
        header.appendChild(name);
        wrap.appendChild(header);

        var children = document.createElement('div');
        children.className = 'proj-dir-children';
        children.style.display = 'none';
        children.dataset.collapsed = '1';
        renderChildren(node, children);
        wrap.appendChild(children);

        var collapsed = true;
        header.addEventListener('click', function () {
            collapsed = !collapsed;
            children.style.display = collapsed ? 'none' : '';
            children.dataset.collapsed = collapsed ? '1' : '0';
            toggle.textContent = collapsed ? '\u25B8' : '\u25BE';
        });
        return wrap;
    }

    /* Which palettes this PNG is actually drawn with.
       The project's own declarations when we have them — that is the whole
       point of the asset model, and the four real rules it encodes are the ones
       "same folder, same name" got wrong (F4). Sibling matching stays as the
       fallback for a folder that is not a decomp. */
    function palettesForNode(pngNode, siblingPals, sharedPals) {
        var rel = relOf(pngNode);
        if (model && rel && window.ProjectModel) {
            var found = window.ProjectModel.palettesFor(rel, {
                index: model.index,
                exists: function (p) { return nodeByRel.has(p); }
            }).map(function (c) {
                var n = nodeByRel.get(c.path);
                // Paired with the reason rather than stamped onto the node: one
                // palette is offered to many pictures, for a different reason
                // each time, and the node is shared between all of them.
                return n ? { node: n, why: c.why } : null;
            }).filter(Boolean);
            if (found.length) return found;
        }
        var base = pngNode.name.slice(0, -4).toLowerCase();
        return siblingPals.filter(function (pn) {
            return pn.name.slice(0, -4).toLowerCase() === base;
        }).concat(sharedPals).map(function (pn) { return { node: pn, why: null }; });
    }

    function renderChildren(node, container) {
        var pngByBase = {};
        var pals = [];
        var shared = [];
        (node.children || []).forEach(function (c) {
            if (c.kind !== 'file') return;
            var lower = (c.name || '').toLowerCase();
            if (lower.endsWith('.png')) {
                var base = c.name.slice(0, -4);
                pngByBase[base] = c;
            } else if (lower.endsWith('.pal')) {
                if (SHARED_PALS.indexOf(lower) >= 0) shared.push(c);
                else pals.push(c);
            }
        });

        // PNG rows with associated palette badges.
        Object.keys(pngByBase).sort(function (a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); }).forEach(function (base) {
            var png = pngByBase[base];
            container.appendChild(fileRow(png, palettesForNode(png, pals, shared)));
        });

        // Standalone pal files (no matching png, not normal/shiny).
        pals.forEach(function (pn) {
            var base = pn.name.slice(0, -4).toLowerCase();
            if (!pngByBase[base]) container.appendChild(palOnlyRow(pn));
        });

        // Subdirectories.
        (node.children || []).forEach(function (c) {
            if (c.kind === 'dir') container.appendChild(dirRow(c));
        });
    }

    function showHint() {
        treeEl.textContent = '';
        var hint = document.createElement('div');
        hint.className = 'proj-empty';
        hint.textContent = 'No project hooked. Click "Hook" to connect a pokeemerald graphics/ folder.';
        treeEl.appendChild(hint);
        setStatus('Not connected');
    }

    var currentQuery = '';

    function matchesRow(row, q) {
        var name = row.querySelector('.proj-name');
        return !!(name && name.textContent.toLowerCase().indexOf(q) >= 0);
    }

    function filterContainer(container, q, force) {
        var any = false;
        var kids = container.children;
        for (var i = 0; i < kids.length; i++) {
            var child = kids[i];
            if (child.classList.contains('proj-dir')) {
                var sub = child.querySelector('.proj-dir-children');
                var dirName = child.querySelector('.proj-dir-name');
                var dirMatch = !!(dirName && dirName.textContent.toLowerCase().indexOf(q) >= 0);
                var show = force || dirMatch;
                var subVisible = sub ? filterContainer(sub, q, force || dirMatch) : false;
                show = show || subVisible;
                child.style.display = show ? '' : 'none';
                if (sub) sub.style.display = show ? '' : (sub.dataset.collapsed === '1' ? 'none' : '');
                if (dirMatch) child.classList.add('match');
                else child.classList.remove('match');
                if (show) any = true;
            } else if (child.classList.contains('proj-row-file') || child.classList.contains('proj-row-pal')) {
                var rowMatch = force || matchesRow(child, q);
                child.style.display = rowMatch ? '' : 'none';
                if (rowMatch) any = true;
            }
        }
        return any;
    }

    function showAll() {
        var rows = treeEl.querySelectorAll('.proj-dir, .proj-row');
        Array.prototype.forEach.call(rows, function (r) { r.style.display = ''; });
        var subs = treeEl.querySelectorAll('.proj-dir-children');
        Array.prototype.forEach.call(subs, function (s) { s.style.display = s.dataset.collapsed === '1' ? 'none' : ''; });
        var matched = treeEl.querySelectorAll('.proj-dir.match');
        Array.prototype.forEach.call(matched, function (d) { d.classList.remove('match'); });
    }

    function applyFilter(value) {
        currentQuery = (value || '').toLowerCase().trim();
        if (!currentQuery) { showAll(); return; }
        filterContainer(treeEl, currentQuery, false);
    }

    function setupSearch() {
        if (document.getElementById('project-search')) return;
        var search = document.createElement('input');
        search.type = 'search';
        search.id = 'project-search';
        search.className = 'proj-search';
        search.placeholder = 'Search assets…';
        search.addEventListener('input', function () { applyFilter(search.value); });
        panel.insertBefore(search, treeEl);
    }

    /* ── The project model ──────────────────────────────────────────────────
       Reading `graphics/` tells you a file's name and its pixels. Everything
       else worth knowing — the depth the slot is built at, which palette binds
       to it, where the sprite sits in its frame — is declared in the project's
       C, two directories up. This loads that once per hook. */

    function normSlashes(p) { return String(p || '').replace(/\\/g, '/'); }

    /* A scanned node's path as the declarations spell it: relative to the repo
       root, forward slashes. Desktop nodes carry an absolute path; browser
       nodes are already relative to whatever was hooked. */
    function relOf(node) {
        var p = normSlashes(node && node.path);
        if (!p) return '';
        if (model && model.root) {
            var root = normSlashes(model.root).replace(/\/$/, '');
            if (p.toLowerCase().indexOf(root.toLowerCase() + '/') === 0) return p.slice(root.length + 1);
        }
        return p;
    }

    /* What the declarations call the asset the engine currently has open.
       Prefer what the panel remembered when the row was clicked, since that is
       the only source that survives a handle-based open; check the filename
       matches first, so a file opened some other way since does not inherit the
       last row's identity. */
    function rel(path) {
        var base = function (p) { return String(p || '').replace(/^.*[\\/]/, '').toLowerCase(); };
        if (openedRel && base(openedRel) === base(path)) return openedRel;
        return relOf({ path: path });
    }

    function indexNodes(tree) {
        var map = new Map();
        (function walk(n) {
            (n && n.children || []).forEach(function (c) {
                if (c.kind === 'dir') walk(c);
                else map.set(relOf(c), c);
            });
        })(tree);
        return map;
    }

    function buildModel(root, files, skipped) {
        var PM = window.ProjectModel, SC = window.SpriteCoords;
        if (!PM || !files || !files.length) return null;
        var index = PM.buildIndex(files);
        var coords = SC ? SC.parseSpeciesCoords(files) : [];
        return {
            root: root,
            index: index,
            coords: coords,
            coordsByPath: SC ? SC.coordsIndex(coords, index) : new Map(),
            sourceText: files.reduce(function (m, f) { m.set(f.path, f.text); return m; }, new Map()),
            skipped: skipped || 0
        };
    }

    /* Browser mode can only see what was hooked, so the model exists there only
       when the repo root itself was picked. That is a real limitation and not
       worth papering over: with no index every resolver falls back to
       convention, which is what the panel did before there was one. */
    var SOURCE_MARKERS = /INCBIN_U|INCGFX_U|SpriteFrameImage|ObjectEventGraphicsInfo|OBJ_EVENT_PAL_TAG_|PicYOffset|y_offset|#define P_/;

    async function readSourcesFsa(handle, rel, depth, out) {
        if (depth > MAX_SCAN_DEPTH || typeof handle.entries !== 'function') return out;
        for await (var pair of handle.entries()) {
            var name = pair[0], h = pair[1];
            var childRel = rel ? rel + '/' + name : name;
            if (h.kind === 'file') {
                if (!/\.(c|h|inc)$/i.test(name)) continue;
                var text = await (await h.getFile()).text();
                if (SOURCE_MARKERS.test(text)) out.push({ path: childRel, text: text });
            } else if (DENYLIST.indexOf(name) < 0 && name !== 'build') {
                await readSourcesFsa(h, childRel, depth + 1, out);
            }
        }
        return out;
    }

    function loadModel(root) {
        model = null;
        setStatus('Reading the project…');
        var got;
        if (isTauriEnv()) {
            got = tauriInvoke('read_project_sources', { path: root })
                .then(function (r) { return buildModel(r.root, r.files, r.skipped); });
        } else if (currentRoot && currentRoot.kind === 'fsa') {
            got = (async function () {
                var files = [];
                for (var sub of ['src', 'include', 'data']) {
                    var dir = null;
                    try { dir = await currentRoot.handle.getDirectoryHandle(sub); } catch (e) { continue; }
                    await readSourcesFsa(dir, sub, 0, files);
                }
                // Paths are already root-relative when the repo root was hooked.
                return buildModel('', files, 0);
            })();
        } else {
            return Promise.resolve(null);
        }
        return got.then(function (m) {
            model = m;
            return m;
        }).catch(function () {
            // Not a decomp, or unreadable. Conventions still work.
            model = null;
            return null;
        });
    }

    function modelSummary() {
        if (!model) return '';
        var s = model.index.stats;
        return '  ·  ' + s.depths + ' depths, ' + s.pairs + ' pairings, ' +
            model.coords.length + ' coordinates';
    }

    function renderTree(root) {
        // Keep the scanned tree: the audit walks it rather than hitting the disk
        // again, and the DOM is a filtered view of it, not the tree itself.
        lastTree = root;
        nodeByRel = indexNodes(root);
        treeEl.textContent = '';
        if (!root || !root.children || !root.children.length) {
            var empty = document.createElement('div');
            empty.className = 'proj-empty';
            empty.textContent = 'No .png / .pal assets found.';
            treeEl.appendChild(empty);
            return;
        }
        renderChildren(root, treeEl);
        if (currentQuery) applyFilter(currentQuery);
    }

    function scan(root) {
        setStatus('Scanning...');
        setLoading(true);
        return tauriInvoke('scan_project', { path: root }).then(function (tree) {
            // The model first: the palette a row offers comes out of it, so
            // rendering before it lands would show the fallback and then flip.
            return loadModel(root).then(function () {
                renderTree(tree);
                var count = countAssets(tree);
                setStatus(root + '  (' + count + ' assets)' + modelSummary());
                setRoot(root);
                setLoading(false);
            });
        }).catch(function (e) {
            setStatus('Scan failed: ' + (e && e.message ? e.message : e));
            showToast('Project scan failed: ' + (e && e.message ? e.message : e), 'error');
            setLoading(false);
        });
    }

    function isAssetName(name) {
        var lower = (name || '').toLowerCase();
        return lower.endsWith('.png') || lower.endsWith('.pal');
    }

    async function scanFsa(handle, relPath, depth) {
        var node = { name: handle.name, kind: 'dir', path: relPath, children: [] };
        if (depth > MAX_SCAN_DEPTH) return node;
        if (typeof handle.entries !== 'function') return node;
        var entries = [];
        for await (var pair of handle.entries()) entries.push(pair);
        for (var i = 0; i < entries.length; i++) {
            var name = entries[i][0], h = entries[i][1];
            var childRel = relPath ? relPath + '/' + name : name;
            if (h.kind === 'file') {
                if (isAssetName(name)) {
                    var lower = name.toLowerCase();
                    node.children.push({
                        name: name, kind: 'file', path: childRel,
                        ext: lower.split('.').pop(), handle: h
                    });
                }
            } else {
                if (DENYLIST.indexOf(name) >= 0) continue;
                var sub = await scanFsa(h, childRel, depth + 1);
                if (sub.children && sub.children.length) node.children.push(sub);
            }
        }
        return node;
    }

    function buildFileTree(files, rootName) {
        var root = { name: rootName || '', kind: 'dir', path: '', children: [] };
        var dirIndex = {};
        function getDir(relParts) {
            if (!relParts.length) return root;
            var cur = root;
            var acc = '';
            for (var i = 0; i < relParts.length; i++) {
                acc = acc ? acc + '/' + relParts[i] : relParts[i];
                var existing = dirIndex[acc];
                if (!existing) {
                    existing = { name: relParts[i], kind: 'dir', path: acc, children: [] };
                    dirIndex[acc] = existing;
                    cur.children.push(existing);
                }
                cur = existing;
            }
            return cur;
        }
        Array.prototype.forEach.call(files || [], function (f) {
            var rel = f.webkitRelativePath || f.name;
            var parts = rel.split('/');
            if (parts.length > 1) parts = parts.slice(1);
            if (parts.length - 1 > MAX_SCAN_DEPTH) return;
            var base = parts[parts.length - 1];
            if (!isAssetName(base)) return;
            for (var i = 0; i < parts.length - 1; i++) {
                if (DENYLIST.indexOf(parts[i]) >= 0) return;
            }
            var parent = getDir(parts.slice(0, parts.length - 1));
            var lower = base.toLowerCase();
            parent.children.push({
                name: base, kind: 'file', path: parts.join('/'),
                ext: lower.split('.').pop(), handle: f
            });
        });
        return root;
    }

    function scanBrowser(root) {
        setStatus('Scanning...');
        openPanel();
        setLoading(true);
        currentRoot = root;
        var promise;
        if (root.kind === 'fsa') promise = scanFsa(root.handle, '', 0);
        else promise = Promise.resolve(buildFileTree(root.files, root.name));
        return promise.then(function (tree) {
            tree.name = root.name;
            tree.path = root.name;
            return loadModel(root.name).then(function () {
                renderTree(tree);
                var count = countAssets(tree);
                setStatus(root.name + '  (' + count + ' assets)' + modelSummary());
                setRoot(root.name);
                setLoading(false);
            });
        }).catch(function (e) {
            setStatus('Scan failed: ' + (e && e.message ? e.message : e));
            showToast('Project scan failed: ' + (e && e.message ? e.message : e), 'error');
            setLoading(false);
        });
    }

    function pickFolderViaInput() {
        return new Promise(function (resolve, reject) {
            var input = document.createElement('input');
            input.type = 'file';
            input.multiple = true;
            input.webkitdirectory = true;
            input.style.position = 'fixed';
            input.style.left = '-9999px';
            input.addEventListener('change', function () {
                var files = Array.prototype.slice.call(input.files || []);
                if (!files.length) { reject(new Error('No folder selected')); cleanup(); return; }
                var firstName = files[0].webkitRelativePath || files[0].name;
                var name = firstName.indexOf('/') >= 0 ? firstName.split('/')[0] : firstName;
                resolve({ kind: 'files', files: files, name: name });
                cleanup();
            });
            var cleanup = function () {
                if (input.parentNode) input.parentNode.removeChild(input);
            };
            document.body.appendChild(input);
            input.click();
        });
    }

    function pickFolderBrowser() {
        return new Promise(function (resolve, reject) {
            if (typeof window.showDirectoryPicker === 'function') {
                window.showDirectoryPicker({ id: 'cdpaint-project', mode: 'read' })
                    .then(function (dirHandle) {
                        resolve({ kind: 'fsa', handle: dirHandle, name: dirHandle.name });
                    })
                    .catch(function (err) {
                        if (err && err.name === 'AbortError') { reject(err); return; }
                        pickFolderViaInput().then(resolve, reject);
                    });
            } else {
                pickFolderViaInput().then(resolve, reject);
            }
        });
    }

    function countAssets(node) {
        var n = 0;
        (node.children || []).forEach(function (c) {
            if (c.kind === 'dir') n += countAssets(c);
            else if ((c.name || '').toLowerCase().endsWith('.png')) n += 1;
        });
        return n;
    }

    function openPanel() {
        panel.classList.remove('project-collapsed', 'project-closed');
        document.body.classList.add('project-panel-open');
        document.body.classList.remove('project-panel-collapsed', 'project-panel-closed');
        notifyViewportShift();
    }
    function collapsePanel() {
        panel.classList.add('project-collapsed');
        panel.classList.remove('project-closed');
        document.body.classList.remove('project-panel-open', 'project-panel-closed');
        document.body.classList.add('project-panel-collapsed');
        notifyViewportShift();
    }
    function closePanel() {
        panel.classList.add('project-collapsed', 'project-closed');
        document.body.classList.remove('project-panel-open', 'project-panel-collapsed');
        document.body.classList.add('project-panel-closed');
        notifyViewportShift();
    }
    function notifyViewportShift() {
        var app = getApp();
        if (app && typeof app._updateSidebarViewportShift === 'function') {
            app._updateSidebarViewportShift(true);
        }
    }

    function hook() {
        if (isTauriEnv()) {
            tauriInvoke('pick_export_folder').then(function (path) {
                if (!path) return;
                openPanel();
                return scan(path);
            }).catch(function (e) {
                showToast('Hook failed: ' + (e && e.message ? e.message : e), 'error');
            });
            return;
        }
        openPanel();
        pickFolderBrowser().then(function (root) {
            return scanBrowser(root);
        }).catch(function (e) {
            if (e && e.name === 'AbortError') return;
            showToast('Hook failed: ' + (e && e.message ? e.message : e), 'error');
        });
    }

    function refresh() {
        if (isTauriEnv()) {
            var root = getRoot();
            if (!root) { showToast('No project hooked', 'warning'); return; }
            scan(root);
            return;
        }
        if (currentRoot) {
            scanBrowser(currentRoot);
        } else {
            var saved = getRoot();
            if (saved) {
                showToast('Reconnect the project folder to refresh', 'warning');
                hook();
            } else {
                showToast('No project hooked', 'warning');
            }
        }
    }

    function unhook() {
        setRoot('');
        currentRoot = null;
        lastTree = null;
        nodeByRel = null;
        model = null;
        openedRel = null;
        treeEl.textContent = '';
        setStatus('');
        setLoading(false);
        closePanel();
    }

    /* ── Audit ──────────────────────────────────────────────────────────────
       Every PNG in the hooked folder, checked against what gbagfx would accept
       and what the game expects, without running either. */

    function collectPngs(node, out) {
        (node && node.children || []).forEach(function (c) {
            if (c.kind === 'dir') collectPngs(c, out);
            else if ((c.name || '').toLowerCase().endsWith('.png')) out.push(c);
        });
        return out;
    }

    function readNodeBytes(node) {
        if (node.handle) {
            var file = node.handle instanceof File
                ? Promise.resolve(node.handle)
                : Promise.resolve(node.handle.getFile());
            return file.then(function (f) { return f.arrayBuffer(); })
                .then(function (b) { return new Uint8Array(b); });
        }
        return tauriInvoke('read_image_file', { path: node.path || '' })
            .then(function (data) { return data instanceof Uint8Array ? data : new Uint8Array(data); });
    }

    function auditRow(result) {
        var row = document.createElement('div');
        row.className = 'audit-row';
        var head = document.createElement('div');
        head.className = 'audit-path';
        head.textContent = result.path || result.name;
        head.title = 'Open this asset';
        head.onclick = function () { openAssetByPath(result); };
        row.appendChild(head);
        var info = result.info;
        if (info) {
            var meta = document.createElement('span');
            meta.className = 'audit-meta';
            meta.textContent = info.w + '×' + info.h + ' · ' + info.depth + 'bpp · ' + info.colors + ' colours';
            row.appendChild(meta);
        }
        result.problems.forEach(function (p) {
            var li = document.createElement('div');
            li.className = 'audit-problem audit-' + p.kind;
            li.textContent = (p.kind === 'build' ? 'won’t build — ' : 'wrong in game — ') + p.text;
            row.appendChild(li);
        });
        return row;
    }

    function openAssetByPath(result) {
        var app = window.PaintApp;
        if (!app || !lastTree) return;
        var found = collectPngs(lastTree, []).find(function (n) {
            return (n.path || n.name) === result.path;
        });
        if (!found) return;
        openedRel = relOf(found);
        if (found.handle) app.openProjectImageFromHandle(found, []);
        else app.openProjectImage(found.path, []);
    }

    function showAuditReport(report) {
        var overlay = document.createElement('div');
        overlay.id = 'audit-overlay';
        var box = document.createElement('div');
        box.id = 'audit-box';
        overlay.appendChild(box);

        var h = document.createElement('h3');
        h.textContent = 'Project audit';
        box.appendChild(h);
        var sub = document.createElement('div');
        sub.className = 'audit-sub';
        sub.textContent = report.total + ' assets · ' + report.clean + ' clean · ' +
            report.wontBuild.length + ' won’t build · ' + report.wrongInGame.length + ' wrong in game';
        box.appendChild(sub);

        var body = document.createElement('div');
        body.className = 'audit-body';
        if (!report.wontBuild.length && !report.wrongInGame.length) {
            var ok = document.createElement('div');
            ok.className = 'audit-clean';
            ok.textContent = 'Nothing to fix — every asset would build and land correctly.';
            body.appendChild(ok);
        }
        [['Won’t build', report.wontBuild], ['Wrong in game', report.wrongInGame]]
            .forEach(function (pair) {
                if (!pair[1].length) return;
                var group = document.createElement('h4');
                group.textContent = pair[0] + ' (' + pair[1].length + ')';
                body.appendChild(group);
                pair[1].forEach(function (r) { body.appendChild(auditRow(r)); });
            });
        box.appendChild(body);

        var actions = document.createElement('div');
        actions.className = 'audit-actions';
        var close = document.createElement('button');
        close.type = 'button';
        close.textContent = 'Close';
        var dismiss = function () { overlay.remove(); document.removeEventListener('keydown', onKey); };
        var onKey = function (e) { if (e.key === 'Escape') dismiss(); };
        close.onclick = dismiss;
        actions.appendChild(close);
        box.appendChild(actions);
        document.addEventListener('keydown', onKey);
        document.body.appendChild(overlay);
    }

    function audit() {
        var app = window.PaintApp;
        if (auditing || !app || !app.auditProjectAssets) return;
        var pngs = collectPngs(lastTree, []);
        if (!pngs.length) { showToast('Nothing to audit — hook a folder first', 'warning'); return; }
        auditing = true;
        if (auditBtn) auditBtn.disabled = true;
        setStatus('Auditing 0/' + pngs.length + '...');
        app.auditProjectAssets(pngs, readNodeBytes, function (done, total) {
            setStatus('Auditing ' + done + '/' + total + '...');
        }).then(function (report) {
            setStatus(getRoot() + '  (' + report.total + ' assets, ' +
                (report.wontBuild.length + report.wrongInGame.length) + ' to fix)');
            showAuditReport(report);
        }).catch(function (e) {
            showToast('Audit failed: ' + (e && e.message ? e.message : e), 'error');
            setStatus('Audit failed');
        }).then(function () {
            auditing = false;
            if (auditBtn) auditBtn.disabled = !getRoot();
        });
    }

    if (hookBtn) hookBtn.addEventListener('click', hook);
    if (auditBtn) auditBtn.addEventListener('click', audit);
    if (refreshBtn) refreshBtn.addEventListener('click', refresh);
    if (unhookBtn) unhookBtn.addEventListener('click', unhook);
    if (collapseBtn) collapseBtn.addEventListener('click', collapsePanel);
    if (closeBtn) closeBtn.addEventListener('click', closePanel);
    if (expandBtn) expandBtn.addEventListener('click', openPanel);
    setupSearch();

    /* ── Writing a coordinate back ──────────────────────────────────────────
       The one place CDPaint edits C. It replaces a single value in place: the
       byte range the parse recorded, the text expected to be there, and the
       correction. The Rust side refuses if the file has moved on since it was
       read, so a stale offset cannot eat somebody's species data. */
    function writeCoord(record, field, value) {
        var SC = window.SpriteCoords;
        if (!model || !SC) return Promise.reject(new Error('No project model loaded'));
        if (!isTauriEnv()) {
            return Promise.reject(new Error(
                'Browser mode has read-only access to the folder — open the project in the desktop app to write coordinates'));
        }
        var at = field === 'size' ? record.sizeAt : record.yAt;
        var text = model.sourceText.get(record.file);
        if (!at || typeof text !== 'string') return Promise.reject(new Error('Nothing to patch'));
        var raw = text.slice(at.start, at.end);
        // Keep the branch's own spacing: `A ? x : y` must not become `A ? x :y`.
        var lead = /^\s*/.exec(raw)[0], tail = /\s*$/.exec(raw)[0];
        var replacement = lead + value + tail;
        var abs = model.root ? model.root.replace(/[\\/]$/, '') + '/' + record.file : record.file;
        return tauriInvoke('patch_source_file', {
            path: abs, offset: at.start, expect: raw, replacement: replacement
        }).then(function () {
            // Re-read our own copy so the offsets stay true for the next edit.
            var next = text.slice(0, at.start) + replacement + text.slice(at.end);
            model.sourceText.set(record.file, next);
            model.coords = model.coords.filter(function (r) { return r.file !== record.file; })
                .concat(SC.parseSpeciesCoords([{ path: record.file, text: next }]));
            model.coordsByPath = SC.coordsIndex(model.coords, model.index);
            return true;
        });
    }

    window.PokeProject = {
        open: openPanel,
        close: closePanel,
        audit: audit,
        assets: function () { return collectPngs(lastTree, []); },
        model: function () { return model; },
        rel: rel,
        coordsFor: function (path) {
            if (!model) return [];
            return model.coordsByPath.get(rel(path)) || [];
        },
        writeCoord: writeCoord,
        toggle: function () {
            if (document.body.classList.contains('project-panel-open')) collapsePanel();
            else openPanel();
        }
    };

    var root = getRoot();
    if (root && isTauriEnv()) {
        scan(root);
    } else {
        showHint();
    }
})();

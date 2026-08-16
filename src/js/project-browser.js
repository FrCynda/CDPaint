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

    function palBadge(palNode, label) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'proj-pal-badge';
        b.textContent = label || 'PAL';
        b.title = 'Load palette: ' + palNode.name;
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

    function fileRow(pngNode, palNodes) {
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

        if (palNodes && palNodes.length) {
            var badgeWrap = document.createElement('span');
            badgeWrap.className = 'proj-pal-badges';
            palNodes.forEach(function (pn) { badgeWrap.appendChild(palBadge(pn, labelForPal(pn))); });
            row.appendChild(badgeWrap);
        }

        row.addEventListener('click', function () {
            var app = getApp();
            if (!app || typeof app.openProjectImage !== 'function') {
                showToast('Image viewer is not ready', 'warning');
                return;
            }
            if (pngNode.handle) app.openProjectImageFromHandle(pngNode, palNodes);
            else app.openProjectImage(pngNode.path, palNodes);
        });
        return row;
    }

    function labelForPal(palNode) {
        var n = palNode.name.toLowerCase();
        if (n === 'normal.pal') return 'N';
        if (n === 'shiny.pal') return 'S';
        return 'PAL';
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
            var assoc = [];
            pals.forEach(function (pn) {
                if (pn.name.slice(0, -4).toLowerCase() === base.toLowerCase()) assoc.push(pn);
            });
            shared.forEach(function (pn) { assoc.push(pn); });
            container.appendChild(fileRow(png, assoc));
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

    function renderTree(root) {
        // Keep the scanned tree: the audit walks it rather than hitting the disk
        // again, and the DOM is a filtered view of it, not the tree itself.
        lastTree = root;
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
            renderTree(tree);
            var count = countAssets(tree);
            setStatus(root + '  (' + count + ' assets)');
            setRoot(root);
            setLoading(false);
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
            renderTree(tree);
            var count = countAssets(tree);
            setStatus(root.name + '  (' + count + ' assets)');
            setRoot(root.name);
            setLoading(false);
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

    window.PokeProject = {
        open: openPanel,
        close: closePanel,
        audit: audit,
        assets: function () { return collectPngs(lastTree, []); },
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

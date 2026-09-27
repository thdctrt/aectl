// lib.jsx - After Effects scripting helpers (ExtendScript / ES3).
//   #include "/path/to/aectl/lib.jsx"   (not needed under `ae run`, which prepends it)
// Everything lives in the AE namespace. See README.md next to this file.
// Rules this file follows (and your scripts should too):
//   * never "str" + array  (the user's engine overloads + for arrays -> throws). Use AE.str(v).
//   * no ES5+: no let/const/=>/`template`, no [].indexOf/forEach/map, no "".trim, no Object.keys.
//   * reserved words are not allowed as bare keys: write o["in"], {"in": 1}, never o.in.
//   * never app.executeCommand(...).
var AE = (function () {
    var A = {};
    A.VERSION = "1.0";
    A.MAIN = null;                   // main comp name for tree (null: the active comp)

    // ------------------------------------------------------------------ state
    A._buf = [];                     // log lines of the current script
    A._depth = 0;                    // AE.run nesting
    A._undoOpen = false;
    A._runnerLog = null;             // set by the `ae` runner (AE._begin)
    A._userOffset = 0;               // combined-file line offset of the user script
    A._combined = false;
    A.scriptPath = null;             // original script path (set by runner)
    A.scriptDir = null;
    A.tmp = Folder.temp.fsName;      // scratch dir; the runner sets it to $TMPDIR/ae-tools (shell-readable;
                                     // AE's own Folder.temp is .../TemporaryItems, which the shell may not read)
    A.imported = [];                 // FootageItems imported by AE.footage during this script

    // ------------------------------------------------------------------ strings
    function pad(n, w) { var s = String(n); while (s.length < w) { s = "0" + s; } return s; }
    A.pad = pad;

    function num(v) {
        if (isNaN(v)) { return "NaN"; }
        var r = Math.round(v * 1000) / 1000;
        if (r === 0) { r = 0; }      // no "-0"
        return String(r);
    }

    function escText(s) {
        return String(s).replace(/\r\n|\r|\n|\u0003/g, "\\r");
    }

    // Safe stringify for anything (arrays, host objects, TextDocument, KeyframeEase, Shape...). Never throws.
    A.str = function (v, depth) {
        if (depth === undefined) { depth = 0; }
        try {
            if (v === null) { return "null"; }
            if (v === undefined) { return "undefined"; }
            var t = typeof v;
            if (t === "number") { return num(v); }
            if (t === "string") { return v; }
            if (t === "boolean") { return String(v); }
            if (t === "function") { return "[function]"; }
            if (v instanceof Array) {
                if (depth > 4) { return "[...]"; }
                var parts = [];
                for (var i = 0; i < v.length; i++) { parts.push(A.str(v[i], depth + 1)); }
                return "[" + parts.join(",") + "]";
            }
            if (typeof TextDocument !== "undefined" && v instanceof TextDocument) { return "'" + escText(v.text) + "'"; }
            if (typeof KeyframeEase !== "undefined" && v instanceof KeyframeEase) { return "ease(" + num(v.speed) + "," + num(v.influence) + ")"; }
            if (typeof Shape !== "undefined" && v instanceof Shape) { return "Shape(" + v.vertices.length + "v" + (v.closed ? ",closed" : "") + ")"; }
            if (typeof MarkerValue !== "undefined" && v instanceof MarkerValue) { return "Marker('" + escText(v.comment) + "')"; }
            if (typeof Property !== "undefined" && (v instanceof Property || v instanceof PropertyGroup)) { return "<prop " + v.name + " (" + v.matchName + ")>"; }
            if (typeof Layer !== "undefined" && v instanceof Layer) { return "<layer #" + v.index + " " + v.name + ">"; }
            if (typeof Item !== "undefined" && v instanceof Item) { return "<" + v.typeName + " " + v.name + " id=" + v.id + ">"; }
            if (t === "object") {
                if (depth > 3) { return "{...}"; }
                var kv = [];
                for (var k in v) {
                    if (!v.hasOwnProperty || v.hasOwnProperty(k)) {
                        var sv;
                        try { sv = A.str(v[k], depth + 1); } catch (e1) { sv = "?"; }
                        kv.push(k + ":" + sv);
                    }
                }
                return "{" + kv.join(", ") + "}";
            }
            return String(v);
        } catch (e) {
            try { return "<" + String(v) + ">"; } catch (e2) { return "<?>"; }
        }
    };

    // ------------------------------------------------------------------ logging
    // log(a, b, c) -> one line "a b c" (each arg through AE.str). Multi-line strings become multiple lines.
    A.log = function () {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) { parts.push(A.str(arguments[i])); }
        var lines = parts.join(" ").split(/\r\n|\r|\n/);
        for (var j = 0; j < lines.length; j++) { A._buf.push(lines[j]); }
    };
    A.warn = function () {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) { parts.push(A.str(arguments[i])); }
        A._buf.push("WARN " + parts.join(" "));
    };

    function baseName(p) { p = String(p); var i = p.lastIndexOf("/"); return i >= 0 ? p.substr(i + 1) : p; }

    // "where" an exception happened, mapped back to the original script when run through `ae run`.
    A._where = function (e) {
        var line = e.line;
        if (line === undefined || line === null) { return "?"; }
        if (A._combined) {
            if (line > A._userOffset) { return baseName(A.scriptPath || "script") + ":" + (line - A._userOffset); }
            return "lib.jsx:" + line;
        }
        return (e.fileName ? baseName(e.fileName) : "?") + ":" + line;
    };
    A.errText = function (e) {
        return (e && e.message !== undefined ? e.message : A.str(e)) + " @ " + A._where(e);
    };

    A._write = function (path, lines) {
        var f = new File(path);
        if (f.parent && !f.parent.exists) { f.parent.create(); }
        var tmp = new File(path + ".part");
        if (tmp.exists) { tmp.remove(); }
        tmp.encoding = "UTF-8";
        tmp.lineFeed = "Unix";        // default on macOS is CR -> "run-together" lines
        if (!tmp.open("w")) { throw new Error("cannot write log " + path); }
        tmp.write(lines.join("\n") + "\n");
        tmp.close();
        if (f.exists) { f.remove(); }
        if (!tmp.rename(baseName(path))) {   // atomic-ish: the log appears complete
            f.encoding = "UTF-8"; f.lineFeed = "Unix"; f.open("w"); f.write(lines.join("\n") + "\n"); f.close();
            tmp.remove();
        }
    };
    A.writeText = function (path, text) {
        var f = new File(path);
        if (f.parent && !f.parent.exists) { f.parent.create(); }
        f.encoding = "UTF-8"; f.lineFeed = "Unix";
        if (!f.open("w")) { throw new Error("cannot write " + path); }
        f.write(text); f.close();
        return f.fsName;
    };

    // ------------------------------------------------------------------ runner
    // AE.run(name, [logPath], fn, [opts]) - suppress dialogs + one undo group + try/catch + UTF-8 log.
    //   fn(log) receives AE.log.  Errors -> "ERR <message> @ file:line", then "FAILED name"; else "DONE name".
    //   opts.undo=false -> no undo group. Nested calls: own try/catch, but no second undo group
    //   (the outer one covers it) and no log write. Under `ae run` the runner writes the log;
    //   standalone without logPath -> AE.tmp/ae_run.log.
    A.run = function (name, logPath, fn, opts) {
        if (typeof logPath === "function") { opts = fn; fn = logPath; logPath = null; }
        opts = opts || {};
        var outer = A._depth === 0;
        var undo = opts.undo !== false && !A._undoOpen;
        var ret, t0 = new Date().getTime(), ok = true;
        A._depth++;
        if (outer) { app.beginSuppressDialogs(); }
        if (undo) { app.beginUndoGroup(String(name)); A._undoOpen = true; }
        try {
            ret = fn(A.log);
        } catch (e) {
            ok = false;
            A._buf.push("ERR " + A.errText(e));
        }
        if (undo) {
            try { app.endUndoGroup(); } catch (e2) { A._buf.push("ERR endUndoGroup " + e2.message); }
            A._undoOpen = false;
        }
        if (outer) { try { app.endSuppressDialogs(false); } catch (e3) { } }
        A._depth--;
        if (!opts.silent) { A._buf.push((ok ? "DONE " : "FAILED ") + name + " (" + (new Date().getTime() - t0) + " ms)"); }
        if (logPath) {
            A._write(logPath, A._buf);
        } else if (outer && !A._runnerLog) {
            A._write(A.tmp + "/ae_run.log", A._buf);
        }
        return ret;
    };
    // Read-only variant: same, but no undo group (does not clutter the user's Cmd+Z history).
    A.peek = function (name, logPath, fn) {
        if (typeof name === "function") { return A.run("peek", null, name, { undo: false }); }
        if (typeof logPath === "function") { return A.run(name, null, logPath, { undo: false }); }
        return A.run(name, logPath, fn, { undo: false });
    };

    // hooks used by the `ae` CLI wrapper
    A._begin = function (logPath, scriptPath, userOffset, tmp) {
        if (tmp) { A.tmp = tmp; }
        A._buf = []; A._depth = 0; A._undoOpen = false; A.imported = [];
        A._runnerLog = logPath; A._combined = true; A._userOffset = userOffset;
        A.scriptPath = scriptPath;
        A.scriptDir = scriptPath ? String(scriptPath).replace(/\/[^\/]*$/, "") : null;
    };
    A._fatal = function (e) {
        A._buf.push("ERR uncaught: " + A.errText(e));
        try { app.endSuppressDialogs(false); } catch (e2) { }
    };
    A._end = function () {
        if (A._runnerLog) { A._write(A._runnerLog, A._buf); }
    };

    // ------------------------------------------------------------------ lookup
    A.items = function (type) {
        var out = [];
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (!type || it instanceof type) { out.push(it); }
        }
        return out;
    };
    // all comps, optionally only those named `name`
    A.comps = function (name) {
        var all = A.items(CompItem), out = [];
        for (var i = 0; i < all.length; i++) { if (name === undefined || all[i].name === name) { out.push(all[i]); } }
        return out;
    };
    // comp by name (throws if missing or ambiguous) or by numeric id; CompItem passes through
    A.comp = function (name) {
        if (name instanceof CompItem) { return name; }
        if (typeof name === "number") {
            var byId = app.project.itemByID(name);
            if (!(byId instanceof CompItem)) { throw new Error("no comp with id " + name); }
            return byId;
        }
        var found = A.comps(String(name));
        if (found.length === 0) { throw new Error("comp not found: '" + name + "'"); }
        if (found.length > 1) {
            var ids = [];
            for (var i = 0; i < found.length; i++) { ids.push(found[i].id); }
            throw new Error(found.length + " comps named '" + name + "' (ids " + ids.join(",") + "); use AE.comp(id)");
        }
        return found[0];
    };
    // layer by 1-based index or exact name (throws if missing or ambiguous)
    A.layer = function (comp, nameOrIndex) {
        comp = A.comp(comp);
        if (typeof nameOrIndex === "number") {
            if (nameOrIndex < 1 || nameOrIndex > comp.numLayers) { throw new Error("layer index " + nameOrIndex + " out of range in '" + comp.name + "' (1.." + comp.numLayers + ")"); }
            return comp.layer(nameOrIndex);
        }
        var hits = [];
        for (var i = 1; i <= comp.numLayers; i++) { if (comp.layer(i).name === nameOrIndex) { hits.push(i); } }
        if (hits.length === 0) { throw new Error("layer not found: '" + nameOrIndex + "' in '" + comp.name + "'"); }
        if (hits.length > 1) { throw new Error("layer name '" + nameOrIndex + "' is ambiguous in '" + comp.name + "' (indexes " + hits.join(",") + ")"); }
        return comp.layer(hits[0]);
    };
    // layers matching a name, RegExp or function(layer)->bool
    A.layers = function (comp, test) {
        comp = A.comp(comp);
        var out = [];
        for (var i = 1; i <= comp.numLayers; i++) {
            var L = comp.layer(i);
            if (test === undefined ||
                (typeof test === "string" && L.name === test) ||
                (test instanceof RegExp && test.test(L.name)) ||
                (typeof test === "function" && test(L))) { out.push(L); }
        }
        return out;
    };
    // recursive property search by matchName (or display name)
    A.findProp = function (group, matchName) {
        for (var i = 1; i <= group.numProperties; i++) {
            var p = group.property(i);
            if (!p) { continue; }
            if (p.matchName === matchName || p.name === matchName) { return p; }
            if (p.propertyType !== PropertyType.PROPERTY) {
                var r = A.findProp(p, matchName);
                if (r) { return r; }
            }
        }
        return null;
    };
    A.findProps = function (group, matchName, out) {
        out = out || [];
        for (var i = 1; i <= group.numProperties; i++) {
            var p = group.property(i);
            if (!p) { continue; }
            if (p.matchName === matchName || p.name === matchName) { out.push(p); }
            if (p.propertyType !== PropertyType.PROPERTY) { A.findProps(p, matchName, out); }
        }
        return out;
    };
    var TF = {
        anchor: "ADBE Anchor Point", pos: "ADBE Position", position: "ADBE Position",
        x: "ADBE Position_0", y: "ADBE Position_1", z: "ADBE Position_2",
        scale: "ADBE Scale", rot: "ADBE Rotate Z", rotation: "ADBE Rotate Z", opacity: "ADBE Opacity",
        orientation: "ADBE Orientation", rotx: "ADBE Rotate X", roty: "ADBE Rotate Y"
    };
    // transform property: AE.tf(L, "pos"|"anchor"|"scale"|"rot"|"opacity"|"x"|"y"|matchName)
    A.tf = function (layer, key) {
        var mn = TF[key] || key;
        var p = layer.property("ADBE Transform Group").property(mn);
        if (!p) { throw new Error("no transform property '" + key + "' on " + layer.name); }
        return p;
    };
    // path in the project panel, e.g. "_DELIVERY/Comps"
    A.itemPath = function (item) {
        var parts = [], f = item.parentFolder;
        while (f && f !== app.project.rootFolder) { parts.unshift(f.name); f = f.parentFolder; }
        return parts.join("/");
    };
    // FolderItem by name (optionally inside parent); created if missing
    A.folder = function (name, parent) {
        if (name instanceof FolderItem) { return name; }
        var all = A.items(FolderItem);
        for (var i = 0; i < all.length; i++) {
            if (all[i].name === name && (!parent || all[i].parentFolder === parent)) { return all[i]; }
        }
        var f = app.project.items.addFolder(name);
        if (parent) { f.parentFolder = parent; }
        return f;
    };
    // FootageItem for a file path (matched by file.fsName); imported if missing (into folder if given)
    A.footage = function (path, folder) {
        var file = new File(path);
        if (!file.exists) { throw new Error("file not found: " + path); }
        var all = A.items(FootageItem);
        for (var i = 0; i < all.length; i++) {
            if (all[i].file && all[i].file.fsName === file.fsName) { A.lastImported = false; return all[i]; }
        }
        var it = app.project.importFile(new ImportOptions(file));
        if (folder) { it.parentFolder = A.folder(folder); }
        A.imported.push(it);
        A.lastImported = true;
        return it;
    };

    // ------------------------------------------------------------------ time
    // frame duration of a comp / layer / property / comp name
    A.fd = function (x) {
        if (x instanceof CompItem) { return x.frameDuration; }
        if (typeof x === "string" || typeof x === "number") { return A.comp(x).frameDuration; }
        if (x && x.containingComp) { return x.containingComp.frameDuration; }
        if (x && x.propertyDepth !== undefined) { return x.propertyGroup(x.propertyDepth).containingComp.frameDuration; }
        throw new Error("AE.fd: cannot get frame duration from " + A.str(x));
    };
    A.f = function (c, frames) { return frames * A.fd(c); };            // frames -> seconds
    A.toF = function (c, seconds) { return Math.round(seconds / A.fd(c) * 1000) / 1000; }; // seconds -> frames
    A.frames = A.toF;

    // Trim a layer to comp frames [inF, outF). null leaves a side unchanged. Retries 3x; WARN + false if it won't stick.
    A.trim = function (L, inF, outF) {
        var fd = A.fd(L), tol = fd / 4;
        var a = (inF === null || inF === undefined) ? null : inF * fd;
        var b = (outF === null || outF === undefined) ? null : outF * fd;
        for (var k = 0; k < 3; k++) {
            if (a !== null) {
                if (b !== null && a >= L.outPoint) { L.outPoint = b; }   // moving right past the old out point
                L.inPoint = a;
            }
            if (b !== null) { L.outPoint = b; }
            if ((a === null || Math.abs(L.inPoint - a) < tol) && (b === null || Math.abs(L.outPoint - b) < tol)) { return true; }
        }
        var msg = "trim '" + L.name + "' wanted in=" + A.str(inF) + " out=" + A.str(outF) +
            " got in=" + num(L.inPoint / fd) + " out=" + num(L.outPoint / fd) + " (startTime=" + num(L.startTime / fd) + "f";
        if (L.source && L.source.duration && !L.timeRemapEnabled && L.stretch) {
            msg += ", source spans " + num(L.startTime / fd) + ".." + num((L.startTime + L.source.duration / (L.stretch / 100)) / fd) + "f";
        }
        A.warn(msg + ")");
        return false;
    };
    // move a layer in time by dF comp frames (in/out move with it). Returns new startTime in frames.
    A.shift = function (L, dF) {
        L.startTime = L.startTime + dF * A.fd(L);
        return A.toF(L, L.startTime);
    };
    // "in=.. out=.. st=.." in frames
    A.span = function (L) {
        var fd = A.fd(L);
        return "in=" + num(L.inPoint / fd) + " out=" + num(L.outPoint / fd) + " st=" + num(L.startTime / fd);
    };

    // ------------------------------------------------------------------ colour
    // "#7143EC" / "7143EC" / "#abc" / "#7143ECff" -> [r,g,b] (or [r,g,b,a] with withAlpha). Arrays pass through.
    A.hex = function (h, withAlpha) {
        var c;
        if (h instanceof Array) {
            c = h.slice(0, 3);
            if (withAlpha) { c.push(h.length > 3 ? h[3] : 1); }
            return c;
        }
        var s = String(h).replace(/^#/, "");
        if (s.length === 3) { s = s.charAt(0) + s.charAt(0) + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2); }
        if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(s)) { throw new Error("bad hex colour: " + h); }
        c = [parseInt(s.substr(0, 2), 16) / 255, parseInt(s.substr(2, 2), 16) / 255, parseInt(s.substr(4, 2), 16) / 255];
        if (withAlpha) { c.push(s.length === 8 ? parseInt(s.substr(6, 2), 16) / 255 : 1); }
        return c;
    };
    A.toHex = function (rgb) {
        if (!(rgb instanceof Array)) { return A.str(rgb); }
        var s = "#";
        for (var i = 0; i < 3; i++) {
            var v = Math.max(0, Math.min(255, Math.round(rgb[i] * 255))).toString(16).toUpperCase();
            s += (v.length < 2 ? "0" : "") + v;
        }
        return s;
    };

    // ------------------------------------------------------------------ text
    A.textProp = function (L) {
        var g = L.property("ADBE Text Properties");
        if (!g) { throw new Error("'" + L.name + "' is not a text layer"); }
        return g.property("ADBE Text Document");
    };
    function hasExpr(p) {
        try { return p.canSetExpression && p.expressionEnabled && p.expression !== ""; } catch (e) { return false; }
    }
    A.hasExpr = hasExpr;
    // Raw (pre-expression) TextDocument at time t (or of key `key`).
    // AE 2026 IGNORES valueAtTime(t, true) and keyValue() for expression-driven Source Text: both return the
    // post-expression (half-typed) text. So when an expression is on, it is disabled for the read and
    // re-enabled right after (a net-zero, undoable change: use inside AE.run).
    A.textDoc = function (L, t, key) {
        var p = A.textProp(L), on = hasExpr(p), td;
        if (on) { p.expressionEnabled = false; }
        try {
            td = key ? p.keyValue(key) : p.valueAtTime(t === undefined ? 0 : t, false);
        } finally {
            if (on) { p.expressionEnabled = true; }
        }
        return td;
    };
    A.getText = function (L, t) { return A.textDoc(L, t).text; };
    // Expression-safe text/colour change. text=null keeps the text; hexColor optional.
    // Edits the raw source text (expression disabled during the edit, then restored); keeps font,
    // size and tracking. Keyed Source Text: applied to every key.
    A.setText = function (L, text, hexColor) {
        var p = A.textProp(L), on = hasExpr(p);
        function apply(td) {
            var font, size, trk;
            try { font = td.font; size = td.fontSize; trk = td.tracking; } catch (e0) { }
            if (text !== null && text !== undefined) { td.text = String(text); }
            try {
                if (font !== undefined && td.font !== font) { td.font = font; }
                if (size !== undefined && td.fontSize !== size) { td.fontSize = size; }
                if (trk !== undefined && td.tracking !== trk) { td.tracking = trk; }
            } catch (e1) { A.warn("setText style restore '" + L.name + "': " + e1.message); }
            if (hexColor) { td.applyFill = true; td.fillColor = A.hex(hexColor); }
            return td;
        }
        if (on) { p.expressionEnabled = false; }
        try {
            if (p.numKeys > 0) {
                for (var k = 1; k <= p.numKeys; k++) { p.setValueAtKey(k, apply(p.keyValue(k))); }
            } else {
                p.setValue(apply(p.value));
            }
            if (text !== null && text !== undefined) {
                var now = p.numKeys > 0 ? p.keyValue(1).text : p.value.text;
                if (String(now).replace(/\r\n|\n/g, "\r") !== String(text).replace(/\r\n|\n/g, "\r")) {
                    A.warn("setText '" + L.name + "': source text is now '" + escText(now) + "'");
                }
            }
        } finally {
            if (on) { p.expressionEnabled = true; }
        }
        return L;
    };

    // ------------------------------------------------------------------ keys
    var INTERP_NAMES = {};
    INTERP_NAMES[KeyframeInterpolationType.LINEAR] = "linear";
    INTERP_NAMES[KeyframeInterpolationType.BEZIER] = "bezier";
    INTERP_NAMES[KeyframeInterpolationType.HOLD] = "hold";
    A.interpName = function (t) { return INTERP_NAMES[t] || String(t); };
    function interpType(s) {
        if (typeof s === "number") { return s; }
        s = String(s).toLowerCase();
        if (s === "linear" || s === "lin") { return KeyframeInterpolationType.LINEAR; }
        if (s === "hold") { return KeyframeInterpolationType.HOLD; }
        if (s === "bezier" || s === "bez" || s === "ease") { return KeyframeInterpolationType.BEZIER; }
        throw new Error("unknown interpolation '" + s + "' (linear|bezier|hold)");
    }
    // KeyframeEase array of length n from a source array (repeats the first element when the source is shorter)
    function fitEase(arr, n) {
        var out = [];
        for (var i = 0; i < n; i++) {
            var e = arr[Math.min(i, arr.length - 1)];
            out.push(new KeyframeEase(e.speed, Math.max(0.1, Math.min(100, e.influence))));
        }
        return out;
    }
    function easeOf(influence, n, speed) {
        var out = [];
        for (var i = 0; i < n; i++) { out.push(new KeyframeEase(speed || 0, Math.max(0.1, Math.min(100, influence)))); }
        return out;
    }
    function isBez(t) { return t === KeyframeInterpolationType.BEZIER; }

    // Copy interpolation types + temporal ease from srcProp key srcK to prop key k.
    // Dimension mismatch (e.g. spatial Position <- Scale) is handled. k may be "all" (srcK then fixed,
    // or matching index when srcK is omitted).
    A.copyEase = function (prop, k, srcProp, srcK) {
        if (k === "all") {
            for (var i = 1; i <= prop.numKeys; i++) {
                A.copyEase(prop, i, srcProp, srcK === undefined ? Math.min(i, srcProp.numKeys) : srcK);
            }
            return;
        }
        var iIn = srcProp.keyInInterpolationType(srcK), iOut = srcProp.keyOutInterpolationType(srcK);
        prop.setInterpolationTypeAtKey(k, iIn, iOut);
        if (isBez(iIn) || isBez(iOut)) {
            try {
                var n = prop.keyInTemporalEase(k).length;
                prop.setTemporalEaseAtKey(k, fitEase(srcProp.keyInTemporalEase(srcK), n), fitEase(srcProp.keyOutTemporalEase(srcK), n));
            } catch (e) { A.warn("copyEase " + prop.name + " key " + k + ": " + e.message); }
        }
        try {
            prop.setTemporalContinuousAtKey(k, srcProp.keyTemporalContinuous(srcK));
            prop.setTemporalAutoBezierAtKey(k, srcProp.keyTemporalAutoBezier(srcK));
        } catch (e2) { }
    };

    // Set a key at comp frame `frame`. value: hex strings accepted for colour props.
    // opts: interp "linear"|"bezier"|"hold" or [in,out]; ease: influence% or [in%,out%] (speed 0);
    //       like: [srcProp, srcKeyIndex] to copy interpolation+ease. Returns the key index.
    A.key = function (prop, frame, value, opts) {
        opts = opts || {};
        if (typeof value === "string" && prop.propertyValueType === PropertyValueType.COLOR) { value = A.hex(value, true); }
        var t = frame * A.fd(prop);
        prop.setValueAtTime(t, value);
        var k = prop.nearestKeyIndex(t);
        if (opts.like) {
            A.copyEase(prop, k, opts.like[0], opts.like[1]);
        }
        if (opts.interp !== undefined) {
            var ii = opts.interp instanceof Array ? opts.interp : [opts.interp, opts.interp];
            prop.setInterpolationTypeAtKey(k, interpType(ii[0]), interpType(ii[1]));
        }
        if (opts.ease !== undefined) {
            var ee = opts.ease instanceof Array ? opts.ease : [opts.ease, opts.ease];
            try {
                var n = prop.keyInTemporalEase(k).length;
                if (opts.interp === undefined) { prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER); }
                prop.setTemporalEaseAtKey(k, easeOf(ee[0], n), easeOf(ee[1], n));
            } catch (e) { A.warn("key ease " + prop.name + " @" + frame + ": " + e.message); }
        }
        return k;
    };
    // all keys: [{frame, time, value, "in", "out", inEase, outEase}]   (read k["in"], not k.in)
    A.keys = function (prop) {
        var out = [], fd = A.fd(prop);
        for (var k = 1; k <= prop.numKeys; k++) {
            var o = { frame: Math.round(prop.keyTime(k) / fd * 1000) / 1000, time: prop.keyTime(k), index: k };
            try { o.value = prop.keyValue(k); } catch (e) { o.value = null; }
            o["in"] = A.interpName(prop.keyInInterpolationType(k));
            o["out"] = A.interpName(prop.keyOutInterpolationType(k));
            try { o.inEase = prop.keyInTemporalEase(k); o.outEase = prop.keyOutTemporalEase(k); } catch (e2) { }
            out.push(o);
        }
        return out;
    };

    // ------------------------------------------------------------------ footage placement
    // setValue that keeps extra dimensions (z) and gives a clear error when the prop is keyed
    A.set = function (prop, v) {
        if (prop.numKeys > 0) { throw new Error("'" + prop.name + "' has " + prop.numKeys + " keys; use AE.key()"); }
        var cur = prop.value;
        if (typeof v === "number" && cur instanceof Array && prop.matchName === "ADBE Scale") { v = [v, v]; }
        if (v instanceof Array && cur instanceof Array && v.length < cur.length) {
            v = v.slice(0);
            for (var i = v.length; i < cur.length; i++) { v.push(cur[i]); }
        }
        prop.setValue(v);
        return prop;
    };

    // Swap a layer's source to a file (or FootageItem), keeping transforms.
    // o: {folder, anchor:[x,y], scale:n|[x,y], pos:[x,y], start:frame (startTime), inF, outF,
    //     mute:true (audio off), name:"..."|true (true = item name), cover:true|{...AE.cover opts}}
    A.replaceFootage = function (L, pathOrItem, o) {
        o = o || {};
        var item = (typeof pathOrItem === "string") ? A.footage(pathOrItem, o.folder) : pathOrItem;
        L.replaceSource(item, false);
        if (o.name === true) { L.name = item.name; } else if (o.name) { L.name = o.name; }
        if (o.anchor) { A.set(A.tf(L, "anchor"), o.anchor); }
        if (o.scale !== undefined) { A.set(A.tf(L, "scale"), o.scale); }
        if (o.pos) { A.set(A.tf(L, "pos"), o.pos); }
        if (o.start !== undefined && o.start !== null) { L.startTime = o.start * A.fd(L); }
        if ((o.inF !== undefined && o.inF !== null) || (o.outF !== undefined && o.outF !== null)) { A.trim(L, o.inF, o.outF); }
        if (o.mute && L.hasAudio) { L.audioEnabled = false; }
        if (o.cover) { A.cover(L, o.cover === true ? {} : o.cover); }
        return L;
    };

    // Scale a layer to the minimum that fills the comp (x zoom) and clamp position so no edge shows.
    // o: {zoom:1, scale:minScale% (use max(this,min)), anchor:[x,y], pos:[x,y] desired position,
    //     focus:[sx,sy] source pixel to bring to comp centre, flipX:bool}. Keeps current scale signs (mirroring).
    // Assumes rotation 0. Returns {scale, min, pos}.
    A.cover = function (L, o) {
        o = o || {};
        var comp = L.containingComp, W = comp.width, H = comp.height;
        var src = L.source;
        if (!src || !src.width) { throw new Error("cover: '" + L.name + "' has no sized source"); }
        var par = (src.pixelAspect || 1) / (comp.pixelAspect || 1);
        var w = src.width * par, h = src.height;
        var rot = A.tf(L, "rot");
        if (rot.numKeys === 0 && Math.abs(rot.value) > 0.001) { A.warn("cover: '" + L.name + "' is rotated " + rot.value + "deg; result ignores rotation"); }
        var ap = A.tf(L, "anchor"), sp = A.tf(L, "scale"), pp = A.tf(L, "pos");
        if (o.anchor) { A.set(ap, o.anchor); }
        var anc = ap.value, ax = anc[0] * par, ay = anc[1];
        var cur = sp.value;
        var sgx = cur[0] < 0 ? -1 : 1, sgy = cur[1] < 0 ? -1 : 1;
        if (o.flipX) { sgx = -sgx; }
        var sMin = Math.max(W / w, H / h) * 100;
        var s = Math.max(sMin * (o.zoom || 1), o.scale || 0);
        var sv = [sgx * s, sgy * s];
        if (cur.length > 2) { sv.push(cur[2]); }
        A.set(sp, sv);
        var Sx = sgx * s / 100, Sy = sgy * s / 100;
        var p = pp.value, px = p[0], py = p[1];
        if (o.pos) { px = o.pos[0]; py = o.pos[1]; }
        if (o.focus) { px = W / 2 + (ax - o.focus[0] * par) * Sx; py = H / 2 + (ay - o.focus[1]) * Sy; }
        function clamp(v, anchor, size, S, C) {
            var e1 = -anchor * S, e2 = (size - anchor) * S;
            var lo = Math.min(e1, e2), hi = Math.max(e1, e2);
            return Math.max(C - hi, Math.min(-lo, v));   // v+lo <= 0 and v+hi >= C
        }
        px = clamp(px, ax, w, Sx, W);
        py = clamp(py, ay, h, Sy, H);
        var np = [px, py];
        if (p.length > 2) { np.push(p[2]); }
        A.set(pp, np);
        return { scale: s, min: sMin, pos: [px, py] };
    };

    // ------------------------------------------------------------------ dump
    function layerKind(L) {
        if (L instanceof TextLayer) { return "text"; }
        if (L instanceof ShapeLayer) { return "shape"; }
        if (L instanceof CameraLayer) { return "camera"; }
        if (L instanceof LightLayer) { return "light"; }
        if (L.nullLayer) { return "null"; }
        if (L.adjustmentLayer) { return "adjustment"; }
        var s = L.source;
        if (s instanceof CompItem) { return "comp"; }
        if (s && s.mainSource instanceof SolidSource) { return "solid"; }
        if (s && s.mainSource instanceof FileSource) { return "footage"; }
        return "layer";
    }
    function sourceText(L) {
        var s = L.source;
        if (!s) { return ""; }
        if (s instanceof CompItem) { return " src=comp:'" + s.name + "'"; }
        if (s.mainSource instanceof SolidSource) { return " src=solid:" + A.toHex(s.mainSource.color) + " " + s.width + "x" + s.height; }
        if (s.file) { return " src='" + s.name + "'" + (s.width ? " " + s.width + "x" + s.height : "") + (s.duration ? " dur=" + num(s.duration) + "s" : "") + " file=" + s.file.fsName; }
        return " src='" + s.name + "'";
    }
    var MATTES = null;
    function matteName(t) {
        if (!MATTES) {
            MATTES = {};
            var n = ["NO_TRACK_MATTE", "ALPHA", "ALPHA_INVERTED", "LUMA", "LUMA_INVERTED"];
            for (var i = 0; i < n.length; i++) { try { MATTES[TrackMatteType[n[i]]] = n[i].toLowerCase(); } catch (e) { } }
        }
        return MATTES[t] || String(t);
    }
    function keyText(p, k, fd) {
        var v;
        try { v = A.str(p.keyValue(k)); } catch (e) { v = "?"; }
        var t = num(p.keyTime(k) / fd);
        var ii = p.keyInInterpolationType(k), oo = p.keyOutInterpolationType(k);
        var ab = { linear: "L", bezier: "B", hold: "H" };
        var io = (ab[A.interpName(ii)] || "?") + (ab[A.interpName(oo)] || "?");
        if (isBez(ii) || isBez(oo)) {
            try {
                var ie = p.keyInTemporalEase(k)[0], oe = p.keyOutTemporalEase(k)[0];
                io += "(" + Math.round(ie.influence) + "," + Math.round(oe.influence) + ")";
            } catch (e2) { }
        }
        return t + ":" + v + " " + io;
    }
    function walkAnimated(g, path, fd, lines, ind, maxKeys) {
        for (var i = 1; i <= g.numProperties; i++) {
            var p;
            try { p = g.property(i); } catch (e) { continue; }
            if (!p) { continue; }
            var nm = path ? path + "/" + p.name : p.name;
            if (p.propertyType === PropertyType.PROPERTY) {
                var hasExpr = false;
                try { hasExpr = p.canSetExpression && p.expressionEnabled && p.expression !== ""; } catch (e1) { }
                var nk = 0;
                try { nk = p.numKeys; } catch (e2) { }
                if (nk > 0 || hasExpr) {
                    var s = ind + nm + " (" + p.matchName + ")";
                    if (nk > 0) {
                        var ks = [];
                        for (var k = 1; k <= nk && k <= maxKeys; k++) { ks.push(keyText(p, k, fd)); }
                        s += " keys[" + nk + "]: " + ks.join(" | ") + (nk > maxKeys ? " | ..." : "");
                    }
                    lines.push(s);
                    if (hasExpr) {
                        var ex = String(p.expression).replace(/\r\n|\r|\n/g, " ⏎ ");
                        if (ex.length > 400) { ex = ex.substr(0, 400) + "..."; }
                        lines.push(ind + "  expr: " + ex);
                    }
                }
            } else {
                walkAnimated(p, nm, fd, lines, ind, maxKeys);
            }
        }
    }
    // Text line for dump. Without an expression the stored text is exact. With an expression, the
    // post-expression text at the layer's last frame is shown (typewriters are complete there),
    // unless raw=true (toggles the expression off to read the source: a net-zero mutation).
    function textInfo(L, raw) {
        var p = A.textProp(L), fd = A.fd(L), td, s;
        if (hasExpr(p) && !raw) {
            var t = Math.max(L.inPoint, L.outPoint - fd);
            td = p.valueAtTime(t, false);
            s = "(expr, post@f" + num(t / fd) + ") '" + escText(td.text) + "'";
        } else {
            td = hasExpr(p) ? A.textDoc(L, 0) : p.valueAtTime(0, false);
            s = (hasExpr(p) ? "(raw) " : "") + "'" + escText(td.text) + "'";
        }
        try { s += " font=" + td.font + " size=" + num(td.fontSize) + " track=" + num(td.tracking); } catch (e) { }
        try { if (td.applyFill) { s += " fill=" + A.toHex(td.fillColor); } } catch (e2) { }
        try { if (td.applyStroke) { s += " stroke=" + A.toHex(td.strokeColor) + "/" + num(td.strokeWidth); } } catch (e3) { }
        return s;
    }
    // Readable tree of a comp. o: {depth:0 (precomp recursion), keys:true, maxKeys:30, filter:name|RegExp,
    //   rawText:false (true = read expression-driven Source Text raw; mutates, so run inside AE.run)}.
    // Transform values are post-expression at the comp current time; "*" = keyed, "~" = expression.
    A.dump = function (comp, o, _ind, _seen) {
        comp = A.comp(comp);
        o = o || {};
        var ind = _ind || "", lines = [], fd = comp.frameDuration;
        var maxKeys = o.maxKeys || 30;
        _seen = _seen || {};
        lines.push(ind + "COMP '" + comp.name + "' id=" + comp.id + " " + comp.width + "x" + comp.height + " " + num(comp.frameRate) + "fps dur=" +
            num(comp.duration / fd) + "f (" + num(comp.duration) + "s) layers=" + comp.numLayers + " folder='" + A.itemPath(comp) + "'" +
            (comp.workAreaStart ? " work=" + num(comp.workAreaStart / fd) + "+" + num(comp.workAreaDuration / fd) + "f" : ""));
        for (var i = 1; i <= comp.numLayers; i++) {
            var L = comp.layer(i);
            if (o.filter && !((typeof o.filter === "string" && L.name === o.filter) || (o.filter instanceof RegExp && o.filter.test(L.name)))) { continue; }
            var s = ind + "#" + i + " '" + L.name + "' [" + layerKind(L) + "]" + sourceText(L) + " " + A.span(L);
            try { if (L.stretch !== 100) { s += " stretch=" + num(L.stretch); } } catch (e0) { }
            if (L.parent) { s += " parent=#" + L.parent.index + "'" + L.parent.name + "'"; }
            try { if (L.trackMatteType !== TrackMatteType.NO_TRACK_MATTE) { s += " matte=" + matteName(L.trackMatteType) + (L.trackMatteLayer ? "<#" + L.trackMatteLayer.index + "'" + L.trackMatteLayer.name + "'" : ""); } } catch (e1) { }
            try { if (L.isTrackMatte) { s += " IS-MATTE"; } } catch (e2) { }
            s += L.enabled ? "" : " DISABLED";
            try { if (L.solo) { s += " SOLO"; } if (L.shy) { s += " shy"; } if (L.locked) { s += " locked"; } } catch (e3) { }
            try { if (L.threeDLayer) { s += " 3D"; } if (L.hasAudio) { s += L.audioEnabled ? " audio" : " audio-off"; } if (L.timeRemapEnabled) { s += " timeremap"; } if (L.motionBlur) { s += " mb"; } } catch (e4) { }
            try { if (L.blendingMode !== BlendingMode.NORMAL) { s += " blend=" + L.blendingMode; } } catch (e5) { }
            lines.push(s);
            // transform
            var tg = L.property("ADBE Transform Group"), tv = [];
            if (tg) {
                for (var j = 1; j <= tg.numProperties; j++) {
                    var tp = tg.property(j);
                    try {
                        if (!tp || tp.propertyType !== PropertyType.PROPERTY) { continue; }
                        if (tp.matchName.indexOf("ADBE Position_") === 0 && !tg.property("ADBE Position").dimensionsSeparated) { continue; }
                        if (tp.matchName === "ADBE Position" && tp.dimensionsSeparated) { continue; }
                        if (!L.threeDLayer && (tp.matchName === "ADBE Orientation" || tp.matchName === "ADBE Rotate X" || tp.matchName === "ADBE Rotate Y")) { continue; }
                        if (tp.matchName === "ADBE Envir Appear in Reflect") { continue; }
                        tv.push(tp.name.replace(/ /g, "") + "=" + A.str(tp.value) + (tp.numKeys ? "*" : "") + (tp.expressionEnabled && tp.expression !== "" ? "~" : ""));
                    } catch (e6) { }
                }
                lines.push(ind + "    tf " + tv.join(" "));
            }
            if (L instanceof TextLayer) {
                try { lines.push(ind + "    text " + textInfo(L, o.rawText)); } catch (e7) { lines.push(ind + "    text ?" + e7.message); }
            }
            // effects list
            var fx = L.property("ADBE Effect Parade");
            if (fx && fx.numProperties > 0) {
                var names = [];
                for (var fi = 1; fi <= fx.numProperties; fi++) { names.push(fx.property(fi).name + (fx.property(fi).enabled ? "" : "(off)")); }
                lines.push(ind + "    fx " + names.join(", "));
            }
            if (o.keys !== false) {
                walkAnimated(L, "", fd, lines, ind + "    ", maxKeys);
            }
            if (o.depth > 0 && L.source instanceof CompItem && !_seen[L.source.id]) {
                _seen[L.source.id] = true;
                var sub = {};
                for (var kk in o) { sub[kk] = o[kk]; }
                sub.depth = o.depth - 1; sub.filter = null;
                lines.push(A.dump(L.source, sub, ind + "        ", _seen));
                _seen[L.source.id] = false;
            }
        }
        return lines.join("\n");
    };

    // Short project overview: comps with folder/size/fps/duration, then the layers of mainName (default: the active comp).
    A.tree = function (mainName) {
        mainName = mainName || A.MAIN;
        var comps = A.comps(), rows = [];
        for (var i = 0; i < comps.length; i++) {
            var c = comps[i];
            rows.push({ k: (A.itemPath(c) + "/" + c.name).toLowerCase(), s: "  " + (A.itemPath(c) ? A.itemPath(c) + "/" : "") + c.name + "  " + c.width + "x" + c.height + " " + num(c.frameRate) + "fps " + num(c.duration / c.frameDuration) + "f (" + num(c.duration) + "s) layers=" + c.numLayers + " id=" + c.id });
        }
        rows.sort(function (a, b) { return a.k < b.k ? -1 : (a.k > b.k ? 1 : 0); });
        var out = ["PROJECT " + (app.project.file ? app.project.file.fsName : "(unsaved)") + " items=" + app.project.numItems + " comps=" + comps.length + " footage=" + A.items(FootageItem).length + (app.project.dirty ? " (unsaved changes)" : "")];
        out.push("COMPS (folder/name size fps duration):");
        for (var j = 0; j < rows.length; j++) { out.push(rows[j].s); }
        var main = mainName ? A.comps(mainName) : [];
        if (!mainName && app.project.activeItem instanceof CompItem) { main = [app.project.activeItem]; }
        if (main.length) {
            var m = main[0];
            out.push("MAIN '" + m.name + "' layers (in/out/start in frames):");
            for (var l = 1; l <= m.numLayers; l++) {
                var L = m.layer(l);
                out.push("  #" + l + " '" + L.name + "' " + A.span(L) + " [" + layerKind(L) + "]" + sourceText(L).replace(/ file=.*$/, "") + (L.enabled ? "" : " DISABLED"));
            }
        } else if (mainName) {
            out.push("(main comp '" + mainName + "' not found)");
        }
        return out.join("\n");
    };

    // ------------------------------------------------------------------ snapshots
    // Queue PNG renders of comp frames. ASYNC in AE 2026: files appear seconds after the script ends.
    // Logs "PNG <path>" per frame; `ae run` waits for those files. res: 1|2|3|4|"full"|"half"|[x,y]|null(keep).
    // File name: <outDir>/<prefix>_f<frame 4 digits>.png.  Returns the paths.
    A.snap = function (comp, frames, outDir, prefix, res) {
        comp = A.comp(comp);
        var dir = new Folder(outDir || (A.tmp + "/snap"));
        if (!dir.exists) { dir.create(); }
        prefix = prefix || comp.name.replace(/[^A-Za-z0-9_-]+/g, "_");
        var fd = comp.frameDuration, maxF = Math.round(comp.duration / fd);
        var orig = comp.resolutionFactor, paths = [];
        var rf = null;
        if (res === "full" || res === 1) { rf = [1, 1]; }
        else if (res === "half" || res === 2) { rf = [2, 2]; }
        else if (res === "third" || res === 3) { rf = [3, 3]; }
        else if (res === "quarter" || res === 4) { rf = [4, 4]; }
        else if (res instanceof Array) { rf = res; }
        try {
            if (rf) { comp.resolutionFactor = rf; }   // taken at call time, so restoring right after is fine
            for (var i = 0; i < frames.length; i++) {
                var fr = frames[i];
                if (fr < 0 || fr >= maxF) { throw new Error("snap: frame " + fr + " outside '" + comp.name + "' (0.." + (maxF - 1) + ")"); }
                var f = new File(dir.fsName + "/" + prefix + "_f" + pad(Math.round(fr), 4) + ".png");
                if (f.exists) { f.remove(); }
                comp.saveFrameToPng(fr * fd, f);
                paths.push(f.fsName);
                A._buf.push("PNG " + f.fsName);
            }
        } finally {
            if (rf) { comp.resolutionFactor = orig; }
        }
        return paths;
    };

    // ------------------------------------------------------------------ render
    // Output module templates to look for, best first, per kind of file.
    var RENDER_TEMPLATES = {
        master: [/ProRes 422 HQ/i, /^Lossless$/i, /Lossless/i],
        alpha: [/ProRes 4444.*Alpha/i, /Lossless with Alpha/i, /Alpha/i],
        h264: [/^H\.264/i, /H\.264/i]
    };
    // Render `comp` to `path` through the render queue without disturbing the user's queue: items already queued are
    // switched off for the duration and switched back on afterwards, and the added item is removed again.
    //   o.kind: "master" (ProRes 422 HQ or Lossless, default) | "alpha" (with alpha channel) | "h264"
    //   o.full: whole comp; o.from/o.to: comp frames, both inclusive; default: the work area
    //   o.ame: hand the item to Media Encoder (queueInAME) instead of rendering in AE; needs a saved project
    // render() blocks AE until the file is written. Logs "RENDERED <path>" (or "AME <path>"). Returns the path.
    A.render = function (comp, path, o) {
        comp = A.comp(comp);
        o = o || {};
        var kind = o.kind || "master", wanted = RENDER_TEMPLATES[kind];
        if (!wanted) { throw new Error("render: unknown kind '" + kind + "' (master, alpha, h264)"); }
        if (o.ame && !app.project.file) { throw new Error("render: Media Encoder reads the project from disk; save it first"); }
        if (o.ame && !app.project.renderQueue.canQueueInAME) { throw new Error("render: Media Encoder is not available"); }
        var fd = comp.frameDuration, start, dur;
        if (o.from !== undefined || o.to !== undefined) {
            var fromF = o.from !== undefined ? o.from : 0, toF = o.to !== undefined ? o.to : Math.round(comp.duration / fd) - 1;
            if (toF < fromF) { throw new Error("render: to (" + toF + ") is before from (" + fromF + ")"); }
            start = fromF * fd; dur = Math.min((toF - fromF + 1) * fd, comp.duration - start);
        } else if (o.full) {
            start = 0; dur = comp.duration;
        } else {
            start = comp.workAreaStart; dur = comp.workAreaDuration;
        }
        if (dur <= 0) { throw new Error("render: empty time span"); }

        var rq = app.project.renderQueue, paused = [], item = null, i, out;
        for (i = 1; i <= rq.numItems; i++) {
            if (rq.item(i).status === RQItemStatus.QUEUED) { paused.push(rq.item(i)); rq.item(i).render = false; }
        }
        try {
            item = rq.items.add(comp);
            item.timeSpanStart = start;
            item.timeSpanDuration = dur;
            for (i = 0; i < item.templates.length; i++) {
                if (item.templates[i] === "Best Settings") { item.applyTemplate("Best Settings"); break; }
            }
            var om = item.outputModule(1), names = om.templates, pick = null;
            for (var w = 0; w < wanted.length && pick === null; w++) {
                for (i = 0; i < names.length; i++) { if (wanted[w].test(names[i])) { pick = names[i]; break; } }
            }
            if (pick === null) { throw new Error("render: no output module template for '" + kind + "'; available: " + names.join(", ")); }
            om.applyTemplate(pick);
            A._buf.push("TEMPLATE " + pick);
            var f = new File(path);
            if (f.parent && !f.parent.exists) { f.parent.create(); }
            if (f.exists) { f.remove(); }
            om.file = f;
            out = om.file.fsName;   // AE may adjust the extension to the format
            if (o.ame) {
                rq.queueInAME(true);
                A._buf.push("AME " + out);
            } else {
                rq.render();
                A._buf.push("RENDERED " + out);
            }
        } finally {
            if (item) { try { item.remove(); } catch (e) { } }
            for (i = 0; i < paused.length; i++) { try { paused[i].render = true; } catch (e2) { } }
        }
        return out;
    };

    return A;
})();

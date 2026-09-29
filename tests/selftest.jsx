// Toolkit self-test. Creates the throwaway comp __aetools_test (+ __aetools_test_src, folder
// __aetools_test_folder, footage __aetools_clip.mp4), checks every mutating helper (and markers, expressions, bounds,
// health, effects, find), snaps 3 frames.
// Run:  ae selftest   (generates the test clip with ffmpeg, runs this, then tests/cleanup.jsx)
// Never touches existing comps/layers.
var CLIP = AE.tmp + "/__aetools_clip.mp4";   // any video of 5 s or more; `ae selftest` generates one
if (!new File(CLIP).exists) { throw new Error("no test clip at " + CLIP + ": run the self-test with `ae selftest`"); }
var fails = 0;
function check(name, cond, info) { if (!cond) { fails++; } log((cond ? "PASS " : "FAIL ") + name + (info !== undefined ? "  " + AE.str(info) : "")); }
function near(a, b, eps) { return Math.abs(a - b) <= (eps || 0.001); }
function ext(L) {
    var c = L.containingComp, a = AE.tf(L, "anchor").value, s = AE.tf(L, "scale").value, p = AE.tf(L, "pos").value, w = L.source.width, h = L.source.height;
    var x1 = p[0] - a[0] * s[0] / 100, x2 = p[0] + (w - a[0]) * s[0] / 100, y1 = p[1] - a[1] * s[1] / 100, y2 = p[1] + (h - a[1]) * s[1] / 100;
    var l = Math.min(x1, x2), r = Math.max(x1, x2), t = Math.min(y1, y2), b = Math.max(y1, y2);
    return { ok: l <= 0.01 && r >= c.width - 0.01 && t <= 0.01 && b >= c.height - 0.01, box: [l, t, r, b], tight: near(r - l, c.width, 0.01) || near(b - t, c.height, 0.01) };
}

AE.run("aetools test", function (log) {
    if (AE.comps("__aetools_test").length) { throw new Error("__aetools_test exists; run cleanup first"); }
    var c = app.project.items.addComp("__aetools_test", 1920, 1080, 1, 10, 25);
    var TF = AE.folder("__aetools_test_folder");
    c.parentFolder = TF;

    // ---- lookup / time / colour
    check("comp()", AE.comp("__aetools_test") === c);
    var threw = false; try { AE.comp("__nope__"); } catch (e) { threw = true; log("  expected:", e.message); } check("comp() throws on missing", threw);
    check("f()", near(AE.f(c, 25), 1) && near(AE.toF(c, 2), 50), [AE.f(c, 25), AE.toF(c, 2)]);
    check("hex", AE.str(AE.hex("#7143EC")) === "[0.443,0.263,0.925]" && AE.hex("7143EC", true).length === 4 && AE.toHex(AE.hex("#abc")) === "#AABBCC", AE.hex("#7143EC"));
    check("str(array) safe", AE.str([1, [2, 3], "x"]) === "[1,[2,3],x]");

    // ---- text with a typewriter expression (pitfall 6)
    var T = c.layers.addText("Grocery Shopping"); T.name = "__txt";
    var p = AE.textProp(T), td = p.value; td.fontSize = 60; td.tracking = 20; td.applyFill = true; td.fillColor = [1, 0, 0]; p.setValue(td);
    p.expression = 'var t=text.sourceText; var n=Math.floor(linear(time,0,2,0,t.length)); t.substr(0,n)+"|";';
    check("layer() by name/index", AE.layer(c, "__txt") === T && AE.layer(c, 1) === T);
    check("post-expression is half-typed before", p.valueAtTime(1, false).text === "Grocery |", p.valueAtTime(1, false).text);
    check("getText raw", AE.getText(T) === "Grocery Shopping", AE.getText(T));
    AE.setText(T, "Catch up with Mia", "#804714");
    var raw = AE.textDoc(T, 0);
    check("setText raw text", raw.text === "Catch up with Mia", raw.text);
    check("setText kept size/tracking", near(raw.fontSize, 60) && near(raw.tracking, 20), [raw.fontSize, raw.tracking]);
    check("setText fill", AE.toHex(raw.fillColor) === "#804714", AE.toHex(raw.fillColor));
    check("expression still on", p.expressionEnabled && p.expression.length > 0);
    check("post-expression mid-way truncated", p.valueAtTime(1, false).text === "Catch up|", p.valueAtTime(1, false).text);
    check("post-expression at end full", p.valueAtTime(5, false).text === "Catch up with Mia|", p.valueAtTime(5, false).text);
    AE.setText(T, null, "#7143EC");
    check("setText colour only", AE.getText(T) === "Catch up with Mia" && AE.toHex(AE.textDoc(T).fillColor) === "#7143EC");

    var K = c.layers.addText("Key A"); K.name = "__keyed";
    var kp = AE.textProp(K); kp.setValueAtTime(0, kp.value); kp.setValueAtTime(1, kp.value);
    kp.expression = 'text.sourceText + "|"';
    AE.setText(K, "Keyed New", "#0088FF");
    check("setText keyed Source Text (all keys)", AE.textDoc(K, 0, 1).text === "Keyed New" && AE.textDoc(K, 0, 2).text === "Keyed New" &&
        AE.toHex(AE.textDoc(K, 0, 2).fillColor) === "#0088FF" && kp.valueAtTime(0.5, false).text === "Keyed New|" && AE.hasExpr(kp), kp.valueAtTime(0.5, false).text);

    // ---- shape layer: trim / shift with negative startTime
    var S = c.layers.addShape(); S.name = "__shape";
    var grp = S.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
    grp.property("ADBE Vectors Group").addProperty("ADBE Vector Shape - Rect");
    grp.property("ADBE Vectors Group").addProperty("ADBE Vector Graphic - Fill");
    S.startTime = AE.f(c, -12);
    check("trim 10..100 (startTime -12)", AE.trim(S, 10, 100) && AE.span(S) === "in=10 out=100 st=-12", AE.span(S));
    check("trim 150..200 (in past old out)", AE.trim(S, 150, 200) && AE.span(S) === "in=150 out=200 st=-12", AE.span(S));
    check("trim out only", AE.trim(S, null, 180) && AE.span(S) === "in=150 out=180 st=-12", AE.span(S));
    AE.shift(S, 5);
    check("shift +5", AE.span(S) === "in=155 out=185 st=-7", AE.span(S));
    AE.trim(S, 0, 250);

    // ---- keys / ease
    var op = AE.tf(S, "opacity"), sc = AE.tf(S, "scale"), pos = AE.tf(S, "pos");
    AE.key(op, 10, 0, { ease: [33, 75] }); AE.key(op, 20, 100, { interp: "linear" }); AE.key(op, 30, 50, { interp: "hold" });
    var ko = AE.keys(op);
    check("keys() count/frames", ko.length === 3 && ko[0].frame === 10 && ko[2].frame === 30, ko.length);
    check("key ease", ko[0]["in"] === "bezier" && near(ko[0].inEase[0].influence, 33) && near(ko[0].outEase[0].influence, 75), [ko[0]["in"], ko[0].inEase, ko[0].outEase]);
    check("key interp", ko[1]["in"] === "linear" && ko[2]["out"] === "hold", [ko[1]["in"], ko[2]["out"]]);
    AE.key(sc, 10, [50, 50], { ease: [10, 90] }); AE.key(sc, 20, [100, 100]);
    check("key 2D value into 3D scale", AE.str(sc.keyValue(1)) === "[50,50,100]", sc.keyValue(1));
    AE.key(pos, 10, [100, 100]); AE.key(pos, 20, [500, 500]); AE.key(pos, 30, [900, 500]);
    AE.copyEase(pos, "all", sc, 1);            // spatial Position (ease len 1) <- Scale (len 3)
    var kp = AE.keys(pos);
    check("copyEase pos<-scale", kp[1]["in"] === "bezier" && kp[1].inEase.length === 1 && near(kp[1].inEase[0].influence, 10) && near(kp[2].outEase[0].influence, 90), [kp[1].inEase, kp[1].outEase]);
    AE.copyEase(sc, 2, op, 1);                 // Scale (3) <- Opacity (1)
    var ks = AE.keys(sc);
    check("copyEase scale<-opacity", ks[1].inEase.length === 3 && near(ks[1].inEase[2].influence, 33) && near(ks[1].outEase[1].influence, 75), [ks[1].inEase, ks[1].outEase]);
    var fc = AE.findProp(S, "ADBE Vector Fill Color");
    check("findProp recursive", fc !== null && fc.matchName === "ADBE Vector Fill Color");
    AE.key(fc, 0, "#7143EC"); AE.key(fc, 25, "#0088FF", { like: [op, 1] });
    check("key hex colour + like", AE.toHex(fc.keyValue(2)) === "#0088FF" && fc.keyInInterpolationType(2) === KeyframeInterpolationType.BEZIER && near(fc.keyInTemporalEase(2)[0].influence, 33), AE.toHex(fc.keyValue(2)));

    // ---- footage: import new file into folder, replaceFootage + cover
    var src = app.project.items.addComp("__aetools_test_src", 100, 100, 1, 10, 25); src.parentFolder = TF;
    var V1 = c.layers.add(src); V1.name = "__v1";
    var nBefore = app.project.numItems;
    AE.replaceFootage(V1, CLIP, { folder: "__aetools_test_folder", start: -10, inF: 0, outF: 100, mute: true, cover: true, name: true });
    check("footage imported into folder", AE.lastImported === true && V1.source.parentFolder === TF && app.project.numItems === nBefore + 1, V1.source.name);
    check("replaceFootage timing", AE.span(V1) === "in=0 out=100 st=-10", AE.span(V1));
    check("replaceFootage name", V1.name === "__aetools_clip.mp4", V1.name);
    var e1 = ext(V1), sw = V1.source.width, sh = V1.source.height, srcF = Math.round(V1.source.duration / c.frameDuration);
    check("cover fills comp (min scale)", e1.ok && e1.tight, [AE.tf(V1, "scale").value, e1.box]);
    check("cover min scale value", near(AE.tf(V1, "scale").value[0], Math.max(1920 / sw, 1080 / sh) * 100, 0.01), AE.tf(V1, "scale").value);
    check("trim past source end warns", srcF - 10 >= 240 || AE.trim(V1, 0, 240) === false, AE.span(V1));

    var V2 = c.layers.add(src); V2.name = "__v2";
    AE.replaceFootage(V2, CLIP, { anchor: [sw / 2, sh / 2], scale: [-240, 240], pos: [1078, 607] });
    check("existing footage reused", AE.lastImported === false && V2.source === V1.source, V2.source.id);
    check("replaceFootage transforms", AE.str(AE.tf(V2, "scale").value) === "[-240,240,100]" && AE.str(AE.tf(V2, "pos").value) === "[1078,607,0]", [AE.tf(V2, "scale").value, AE.tf(V2, "pos").value]);
    var r = AE.cover(V2, { focus: [100, 100], zoom: 1.2 });
    var e2 = ext(V2);
    check("cover keeps flip, zoom, clamps focus", e2.ok && AE.tf(V2, "scale").value[0] < 0 && near(r.scale, r.min * 1.2), [r, e2.box]);
    AE.cover(V2, { pos: [0, 0] });
    var e3 = ext(V2);
    check("cover clamps extreme pos", e3.ok && e3.tight, e3.box);

    check("folder() finds existing", AE.folder("__aetools_test_folder") === TF);
    log("--- dump of __aetools_test:");
    log(AE.dump(c, { depth: 1 }));
    var pngs = AE.snap(c, [0, 30, 60], AE.tmp + "/selftest", "selftest", "half");
    check("snap queued (ae run waits for the files)", pngs.length === 3, pngs[0]);

    // ---- building helpers: addComp/addText/addRect/control/addEffect/fx/key list/fade/clearKeys/rebuild
    var B = AE.addComp("__aetools_test_build", { like: c, dur: 50, folder: TF });
    check("addComp", B.width === 1920 && near(B.frameRate, 25) && Math.round(B.duration / B.frameDuration) === 50 && B.parentFolder === TF);
    var BL = c.layers.add(B); BL.name = "__build"; AE.trim(BL, 10, 40);
    var tx = AE.addText(B, "Hello", { size: 72, fill: "#FF0000", justify: "center", tracking: 20, leading: 90, pos: [960, 540], name: "__t" });
    var txd = AE.textDoc(tx);
    check("addText style", near(txd.fontSize, 72) && AE.toHex(txd.fillColor) === "#FF0000" && txd.justification === ParagraphJustification.CENTER_JUSTIFY &&
        near(txd.tracking, 20) && near(txd.leading, 90) && near(AE.tf(tx, "pos").value[0], 960), [txd.fontSize, AE.toHex(txd.fillColor), txd.tracking, txd.leading]);
    var R = AE.addRect(B, { size: [200, 100], pos: [960, 540], round: 10, fill: "#00FF00", stroke: "#0000FF", strokeWidth: 4, name: "Box" });
    AE.addRect(R, { size: [50, 50], name: "Box2", fill: "#000000" });
    var box = AE.findProp(R, "Box");
    check("addRect: layer at [0,0], two groups, sizes/colours", near(AE.tf(R, "pos").value[0], 0) && box !== null && AE.findProp(R, "Box2") !== null &&
        AE.str(AE.findProp(box, "ADBE Vector Rect Size").value) === "[200,100]" && AE.toHex(AE.findProp(box, "ADBE Vector Fill Color").value) === "#00FF00" &&
        near(AE.findProp(box, "ADBE Vector Stroke Width").value, 4), AE.findProp(box, "ADBE Vector Rect Size").value);
    AE.control(R, "slider", "Amount", 5);
    AE.addEffect(R, "ADBE Gaussian Blur 2", "Blur");
    AE.control(R, "color", "Tint", "#0088FF");
    check("control/addEffect/fx stay valid after more effects", near(AE.fx(R, "Amount", 1).value, 5) && AE.fx(R, "Blur").matchName === "ADBE Gaussian Blur 2" &&
        AE.toHex(AE.fx(R, "Tint", 1).value) === "#0088FF");
    var dR = "";
    try {
        AE.tf(R, "rot").expression = "nope_undefined + 1";
        dR = AE.dump(B, { filter: "Box", props: true, at: 5 });
        AE.tf(R, "rot").expression = "";
    } catch (eX) { dR = "threw: " + eX.message; }
    check("dump: effect values, static props, expression errors", dR.indexOf("{Slider=5}") >= 0 && dR.indexOf("(ADBE Vector Rect Size) = [200,100]") >= 0 &&
        (dR.indexOf("expr ERROR") >= 0 || dR.indexOf("expr (OFF)") >= 0), dR);
    var rop = AE.tf(R, "opacity");
    AE.key(rop, [[0, 0], [10, 100, { interp: "linear" }], [20, 50, [10, 90]]], { ease: 50 });
    var rk = AE.keys(rop);
    check("key list form", rk.length === 3 && rk[1]["in"] === "linear" && near(rk[2].inEase[0].influence, 10) && near(rk[2].outEase[0].influence, 90) &&
        near(rk[0].outEase[0].influence, 50), [rk.length, rk[1]["in"]]);
    AE.clearKeys(rop);
    AE.fade(R, 0, 5);
    rk = AE.keys(AE.tf(R, "opacity"));
    check("clearKeys + fade", rk.length === 2 && near(rk[0].value, 0) && near(rk[1].value, 100) && rk[1].frame === 5, rk.length);
    var TR = B.layers.add(AE.footage(CLIP)); TR.name = "__remap";
    TR.timeRemapEnabled = true;
    AE.key(TR.property("ADBE Time Remapping"), 10, 1);
    var trp = AE.clearKeys(TR.property("ADBE Time Remapping"));
    var trOk = true; try { AE.key(trp, 5, 2); } catch (eTR) { trOk = false; log("  ", eTR.message); }
    check("clearKeys on Time Remap leaves it usable", trOk && TR.timeRemapEnabled && trp.numKeys >= 2, trp.numKeys);
    var threwB = false;
    try {
        AE.rebuild("__aetools_test_build", function (nc) { AE.addComp("__aetools_test_build_pre", { like: nc }); throw new Error("boom"); });
    } catch (eB) { threwB = eB.message === "boom"; }
    check("failed rebuild removes what it added, the old comp stays", threwB && AE.comps("__aetools_test_build").length === 1 && AE.comps("__aetools_test_build (building)").length === 0 &&
        AE.comps("__aetools_test_build_pre").length === 0 && AE.layer(c, "__build").source === B);
    var B2 = AE.rebuild("__aetools_test_build", { dur: 60 }, function (nc) { AE.addText(nc, "New", { name: "__t2" }); });
    var BL2 = AE.layer(c, "__build");
    check("rebuild swaps every use and keeps the placement", BL2.source === B2 && B2.name === "__aetools_test_build" && AE.comps("__aetools_test_build").length === 1 &&
        B2.parentFolder === TF && Math.round(B2.duration / B2.frameDuration) === 60 && AE.span(BL2) === "in=10 out=40 st=0" && B2.layer("__t2") !== null, AE.span(BL2));

    // ---- copyLayer returns the copy (copyToComp's own index/reference behaviour, pitfall 11)
    var nL = c.numLayers, src = AE.layer(c, "__txt"), cp = AE.copyLayer(src, null, { name: "__txt copy" });
    src = AE.layer(c, "__txt");
    check("copyLayer returns the copy, above the source", cp.name === "__txt copy" && c.numLayers === nL + 1 && cp.index === src.index - 1 && AE.getText(cp) === AE.getText(src), [cp.index, src.index]);

    // ---- playhead, selection, markers
    T = AE.layer(c, "__txt");   // fresh after copyLayer (pitfall 11)
    AE.show(c, 50);
    check("show/cti move the playhead", AE.cti(c) === 50 && near(c.time, 2) && AE.cti(c, 40) === 40, c.time);
    AE.select([T]);
    check("select() only these", T.selected && c.selectedLayers.length === 1, c.selectedLayers.length);
    log("  sel:", AE.sel().split("\n")[0]);
    AE.marker(c, 25, "__note", { duration: 5, label: 3 });
    AE.marker(T, 30, "__layer note");
    var cm = AE.markers(c), lm = AE.markers(T);
    check("comp marker", cm.length === 1 && cm[0].frame === 25 && cm[0].comment === "__note" && cm[0].duration === 5 && cm[0].label === 3, cm);
    check("layer marker", lm.length === 1 && lm[0].frame === 30 && lm[0].comment === "__layer note", lm);
    check("markerReport", AE.markerReport([c]).indexOf("f25 comp '__note' dur=5f label=3") >= 0, AE.markerReport([c]));
    check("removeMarkers", AE.removeMarkers(T, "layer") === 1 && AE.markers(T).length === 0);

    // ---- property paths, layer kinds (pitfall 17)
    check("prop() by path/alias/name", AE.prop(S, "ADBE Transform Group/ADBE Opacity").matchName === "ADBE Opacity" && AE.prop(S, "opacity").matchName === "ADBE Opacity" &&
        AE.prop(S, "ADBE Vector Fill Color").matchName === "ADBE Vector Fill Color");
    check("propPath/layerOf", AE.propPath(op) === op.propertyGroup(1).name + "/" + op.name && AE.layerOf(fc).name === "__shape", AE.propPath(op));
    log("  instanceof AVLayer: text", T instanceof AVLayer, "shape", S instanceof AVLayer, "(pitfall 17)");
    check("isLayer for every kind", AE.isLayer(T) && AE.isLayer(S) && AE.isLayer(V1) && !AE.isLayer(c) && !AE.isLayer(op) && AE.str(T).indexOf("<layer #") === 0, AE.str(T));

    // ---- expressions (pitfall 16)
    var rotP = AE.tf(S, "rot"), why = "";
    AE.expr(rotP, "time * 10");
    check("expr() sets a good expression", near(rotP.valueAtTime(1, false), 10) && AE.exprError(rotP) === "", rotP.valueAtTime(1, false));
    threw = false;
    try { AE.expr(rotP, "thisComp.layer(\"__nope__\").transform.rotation"); } catch (eE) { threw = true; why = eE.message; }
    check("expr() throws on an error and restores", threw && rotP.expression === "time * 10" && rotP.expressionEnabled, why);
    rotP.expression = "";
    var anc = AE.tf(S, "anchor"), setThrew = false;
    try { anc.expression = "thisComp.layer(\"__nope__\").transform.anchorPoint"; } catch (eS) { setThrew = true; }
    var errs = AE.exprErrors(c);
    check("a broken expression does not throw; exprErrors finds it", !setThrew && errs.length === 1 && errs[0].indexOf(": line 1: ") > 0, [setThrew, errs]);
    anc.expression = "";
    check("exprErrors clean again", AE.exprErrors(c).length === 0, AE.exprErrors(c));

    // ---- bounds through a parent, health, effects by display name, find, diff snapshot, graph data
    var BX = AE.addRect(c, { size: [100, 100], pos: [300, 200], layer: "__box" });
    var bb = AE.bounds(BX, 0);
    check("bounds of a 100x100 rect", bb !== null && near(bb[0], 250) && near(bb[1], 150) && near(bb[2], 350) && near(bb[3], 250), bb);
    var PX = c.layers.addShape(); PX.name = "__parent";
    BX = AE.layer(c, "__box");
    BX.parent = PX;
    var bp = AE.bounds(BX, 0);
    check("bounds through a parent", bp !== null && near(bp[0], 250, 0.2) && near(bp[3], 250, 0.2), bp);
    var pp0 = AE.tf(PX, "pos").value;
    AE.set(AE.tf(PX, "pos"), [pp0[0] + 100, pp0[1]]);
    bp = AE.bounds(BX, 0);
    check("bounds follow the parent", bp !== null && near(bp[0], 350, 0.2) && near(bp[2], 450, 0.2), bp);
    AE.set(AE.tf(PX, "pos"), [9000, 9000]);
    var h = AE.health([c]);
    check("health: off screen", h.indexOf("'__box': outside the frame") > 0, h);
    var gdn = "";
    for (var ei = 0; ei < app.effects.length; ei++) { if (app.effects[ei].matchName === "ADBE Gaussian Blur 2") { gdn = app.effects[ei].displayName; } }
    AE.addEffect(BX, gdn.toUpperCase(), "Soft");
    AE.setProps(AE.fx(BX, "Soft"), { "1": 12 });
    check("addEffect by display name (any case), setProps by index", AE.fx(BX, "Soft").matchName === "ADBE Gaussian Blur 2" && near(AE.fx(BX, "Soft", 1).value, 12), gdn);
    threw = false;
    try { AE.addEffect(BX, "__no_such_effect__"); } catch (eF) { threw = true; why = eF.message; }
    check("addEffect refuses an unknown name", threw && why.indexOf("no effect '__no_such_effect__'") === 0, why);
    check("find() text", AE.find("Catch up", { comp: c }).indexOf("text   '__aetools_test' #") >= 0, AE.find("Catch up", { comp: c }));
    var fb = AE.find("__box", { comp: c, scopes: "name" }).split("\n");
    check("find() layer name in one scope", fb.length === 2 && fb[0].indexOf("layer  '__aetools_test' #") === 0 && fb[0].indexOf("'__box'") > 0, fb);
    check("snapshot has the comp and its layers", AE._snapshot().indexOf("@C " + c.id + " COMP '__aetools_test'") >= 0 && AE._snapshot().indexOf("'__box' [shape]") > 0);
    var gd = AE.graphData(op, null, null, 1).split("\n");
    check("graphData", gd[0].indexOf("(ADBE Opacity)") > 0 && gd[1] === "RANGE 5 35 1" && gd.length === 2 + 3 + 31, [gd[0], gd[1], gd.length]);

    // ---- render: 5 frames through the render queue; the user's queue must be left as it was
    var rq = app.project.renderQueue, rqBefore = rq.numItems;
    var rendered = AE.render(c, AE.tmp + "/selftest/render.mov", { from: 0, to: 4 });
    check("render wrote a file", new File(rendered).exists && new File(rendered).length > 0, rendered);
    check("render left the render queue as it was", rq.numItems === rqBefore, [rqBefore, rq.numItems]);
    log(fails === 0 ? "ALL PASS" : "ERR " + fails + " check(s) failed");
});

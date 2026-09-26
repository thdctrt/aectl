// Idempotent: removes everything tests/selftest.jsx creates (comps/folders named __aetools_test*,
// footage named __aetools*). Run it after the self-test has finished (ae run waits for its PNGs).
AE.run("aetools test cleanup", function (log) {
    var n = 0, all, i;
    all = AE.items(CompItem);
    for (i = 0; i < all.length; i++) { if (all[i].name.indexOf("__aetools_test") === 0) { log("remove comp", all[i].name, all[i].id); all[i].remove(); n++; } }
    all = AE.items(FootageItem);
    for (i = 0; i < all.length; i++) {
        var fp = all[i].file ? all[i].file.fsName : "";
        if (all[i].name.indexOf("__aetools") === 0 || fp.indexOf("/__aetools") >= 0) { log("remove footage", all[i].name, all[i].id); all[i].remove(); n++; }
    }
    all = AE.items(FolderItem);
    for (i = 0; i < all.length; i++) { if (all[i].name.indexOf("__aetools_test") === 0) { log("remove folder", all[i].name, all[i].id, "items", all[i].numItems); all[i].remove(); n++; } }
    log("removed", n);
});

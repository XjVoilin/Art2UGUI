// Native business-PSD regression. ART2UGUI_TEST_PSD can point to a saved PSD;
// otherwise use .tmp/ClippingBusiness.psd. The source is copied before opening.
// A flat reference PNG is rendered before any crop/resize and can be compared
// pixel-for-pixel with the production export under .tmp/photoshop-rendering-test/.
(function () {
    var project = new File($.fileName).parent.parent;
    var folder = new Folder(project.parent + "/.tmp/photoshop-rendering-test");
    if (!folder.exists) folder.create();
    var input = new File($.getenv("ART2UGUI_TEST_PSD") || project.parent + "/.tmp/ClippingBusiness.psd");
    var layerName = $.getenv("ART2UGUI_TEST_LAYER") || "img_Copy";
    var previous = app.documents.length ? app.activeDocument : null;
    var dialogs = app.displayDialogs;
    var source = null, temp = null, reference = null;
    var messages = [], dropdown;
    function assert(condition, message) { if (!condition) throw new Error(message); }
    function read(file) {
        file.encoding = "UTF-8"; assert(file.open("r"), "Cannot read " + file.fsName);
        try { return file.read(); } finally { file.close(); }
    }
    function control() { return { add: function (type) {
        if (type === "dropdownlist") { dropdown = {}; return dropdown; }
        return control();
    } }; }
    function Window() {
        var dialog = control();
        dialog.show = function () { dropdown.selection = {index:1}; return 1; };
        return dialog;
    }
    function alert(message) { messages.push(message); }
    function find(parent) {
        for (var i = 0; i < parent.layers.length; i++) {
            var layer = parent.layers[i];
            if (layer.name.indexOf(layerName) === 0) return layer;
            if (layer.typename === "LayerSet") { var found = find(layer); if (found) return found; }
        }
    }
    function hide(parent) {
        for (var i = 0; i < parent.layers.length; i++) {
            var layer = parent.layers[i];
            if (!layer.visible) continue;
            var group = layer.typename === "LayerSet";
            if ((!group && layer.kind === LayerKind.TEXT) || /^(btn_|img_|icon_|slider_|sliderfill_|bg_|mask_|tile_)/.test(layer.name)) layer.visible = false;
            else if (group && layer.name.charAt(0) !== "#") hide(layer);
        }
    }
    function save(doc, file) { var opts = new PNGSaveOptions(); opts.compression = 6; doc.saveAs(file, opts, true, Extension.LOWERCASE); }
    try {
        app.displayDialogs = DialogModes.NO;
        assert(input.exists, "Set ART2UGUI_TEST_PSD or supply .tmp/ClippingBusiness.psd");
        var fixture = new File(folder + "/RenderingCase.psd");
        assert(input.copy(fixture.fsName), "Cannot copy input PSD");
        source = app.open(fixture);
        var target = find(source); assert(target, "Layer not found: " + layerName);
        var scale = target.name.indexOf("^") >= 0 ? Number(target.name.substring(target.name.lastIndexOf("^") + 1)) : 1;
        var history = source.historyStates.length, selection = source.activeLayer.id;
        temp = app.documents.add(source.width, source.height, source.resolution, "RenderingReference", NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
        var blank = temp.activeLayer;
        app.activeDocument = source; var copy = target.duplicate(temp, ElementPlacement.PLACEATBEGINNING);
        app.activeDocument = temp; blank.remove(); copy.visible = true; copy.opacity = 100;
        // PNG encoding captures the actual compositor output, independent of the
        // production crop/resize implementation or live layer bounds.
        var before = new File(folder + "/reference-before-hide.png"); save(temp, before);
        reference = app.open(before);
        var b = reference.activeLayer.bounds;
        var bounds = [b[0].as("px"), b[1].as("px"), b[2].as("px"), b[3].as("px")];
        reference.close(SaveOptions.DONOTSAVECHANGES); reference = null;
        app.activeDocument = temp;
        if (copy.typename === "LayerSet") hide(copy);
        var full = new File(folder + "/reference-full.png"); save(temp, full);
        temp.close(SaveOptions.DONOTSAVECHANGES); temp = null;
        reference = app.open(full);
        reference.crop([new UnitValue(bounds[0],"px"),new UnitValue(bounds[1],"px"),new UnitValue(bounds[2],"px"),new UnitValue(bounds[3],"px")]);
        var width = Math.max(1, Math.round((bounds[2] - bounds[0]) * scale));
        var height = Math.max(1, Math.round((bounds[3] - bounds[1]) * scale));
        if (reference.width.as("px") !== width || reference.height.as("px") !== height)
            reference.resizeImage(new UnitValue(width,"px"),new UnitValue(height,"px"),undefined,ResampleMethod.BICUBIC);
        var padding = Math.max(1, Math.round(scale));
        reference.resizeCanvas(new UnitValue(width + padding * 2,"px"),new UnitValue(height + padding * 2,"px"),AnchorPosition.MIDDLECENTER);
        save(reference, new File(folder + "/expected.png"));
        reference.close(SaveOptions.DONOTSAVECHANGES); reference = null;
        app.activeDocument = source;
        var exporter = read(new File(project + "/PS2UGUI_Export.jsx"));
        exporter = exporter.replace("new Folder(outputDir).execute()", "true");
        eval(exporter);
        var filename = target.name.replace(/\^[^^]*$/, "").replace(/[$%@~]+$/, "");
        var actual = new File(folder + "/RenderingCase/" + filename + ".png");
        reference = app.open(actual);
        var alpha = reference.activeLayer.bounds;
        assert(alpha[0].as("px") >= padding && alpha[1].as("px") >= padding &&
            alpha[2].as("px") <= width + padding && alpha[3].as("px") <= height + padding,
            "Live effects repainted the transparent border / clipped the sprite");
        reference.close(SaveOptions.DONOTSAVECHANGES); reference = null;
        assert(source.historyStates.length === history && source.activeLayer.id === selection, "Source document changed");
        messages.push("PASS: transparent border preserved; expected.png must pixel-match RenderingCase/" + filename + ".png; source unchanged");
    } catch (error) { messages.push("FAIL: " + error.message + " (line " + error.line + ")"); }
    finally {
        if (reference) reference.close(SaveOptions.DONOTSAVECHANGES);
        if (temp) temp.close(SaveOptions.DONOTSAVECHANGES);
        if (source) source.close(SaveOptions.DONOTSAVECHANGES);
        if (previous) app.activeDocument = previous;
        app.displayDialogs = dialogs;
        var report = new File(folder + "/report.txt"); report.encoding = "UTF-8"; report.open("w"); report.write(messages.join("\n")); report.close();
    }
})();

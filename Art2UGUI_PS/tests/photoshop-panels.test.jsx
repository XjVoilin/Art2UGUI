// Native Photoshop selected-panel regression; fixtures and business PSD are copied/created under .tmp.
(function () {
    var project = new File($.fileName).parent.parent;
    var output = new Folder(project.parent + "/.tmp/photoshop-panels-test");
    if (!output.exists) output.create();
    var previous = app.documents.length ? app.activeDocument : null;
    var dialogs = app.displayDialogs, ruler = app.preferences.rulerUnits;
    var doc = null, messages = [], report = [], dropdown;
    function control() {
        return { add: function (type) { if (type === "dropdownlist") { dropdown = {}; return dropdown; } return control(); } };
    }
    function Window() {
        var dialog = control();
        dialog.show = function () { dropdown.selection = {index: 1}; return 2; };
        return dialog;
    }
    function alert(message) { messages.push(message); }
    function assert(condition, message) { if (!condition) throw new Error(message); }
    function read(file) {
        file.encoding = "UTF-8"; assert(file.open("r"), "Cannot read " + file.fsName);
        try { return file.read(); } finally { file.close(); }
    }
    function state(parent, values) {
        for (var i = 0; i < parent.layers.length; i++) {
            var layer = parent.layers[i]; values.push(layer.id + ":" + layer.name + ":" + layer.visible);
            if (layer.typename === "LayerSet") state(layer, values);
        }
        return values.join("|");
    }
    function exportGroup(group, expectedNames) {
        doc.activeLayer = group;
        var history = doc.activeHistoryState, snapshot = state(doc, []), documentCount = app.documents.length;
        messages = [];
        eval(exporter);
        assert(app.activeDocument === doc && doc.activeLayer.id === group.id, "Source selection changed");
        assert(doc.activeHistoryState === history && state(doc, []) === snapshot, "Source document changed");
        assert(app.documents.length === documentCount, "Temporary documents leaked");
        var folder = new Folder(doc.path + "/" + group.name);
        var data = eval("(" + read(new File(folder + "/" + group.name + "_ui_data.json")) + ")");
        assert(data.resourceScope === undefined, "Unexpected new JSON contract");
        assert(data.canvas.width === 1080 && data.canvas.height === 1920, "Canvas changed");
        if (expectedNames) {
            var actual = []; for (var k = 0; k < data.layers.length; k++) actual.push(data.layers[k].name);
            assert(actual.sort().join("|") === expectedNames.sort().join("|"), "Unexpected layers " + actual.join(","));
            for (var k = 0; k < data.layers.length; k++) {
                assert(data.layers[k].groupPath.indexOf(group.name) !== 0, "Panel container leaked into groupPath");
                if (data.layers[k].type === "image") assert(data.layers[k].x === 39 && data.layers[k].y === 79, "Original position lost");
            }
        }
        var images = 0, texts = 0;
        for (var i = 0; i < data.layers.length; i++) {
            if (data.layers[i].type === "text") texts++; else images++;
        }
        assert(messages.length && messages[messages.length - 1].indexOf("PS2UGUI: 导出完成！") === 0, "Export error: " + messages.join(" | "));
        report.push("PASS " + group.name + " | images=" + images + " texts=" + texts + " | source unchanged | " + folder.fsName);
        report.push(messages.join(" | "));
    }
    function makeGroup(name, visible) {
        var group = doc.layerSets.add(); group.name = name;
        var common = group.layerSets.add(); common.name = "Common";
        var image = common.artLayers.add(); image.name = "Common/img_frame";
        doc.activeLayer = image;
        doc.selection.select([[40,80],[140,80],[140,180],[40,180]]);
        var color = new SolidColor(); color.rgb.red = name === "PanelA" ? 255 : 0; color.rgb.green = 50; color.rgb.blue = 100;
        doc.selection.fill(color); doc.selection.deselect();
        var hidden = common.artLayers.add(); hidden.name = "img_hidden"; hidden.visible = false;
        var text = group.artLayers.add(); text.kind = LayerKind.TEXT; text.name = "Caption";
        text.textItem.contents = name; text.textItem.position = [200,300]; text.textItem.size = 24;
        group.visible = visible;
        return group;
    }
    try {
        app.displayDialogs = DialogModes.NO; app.preferences.rulerUnits = Units.PIXELS;
        var exporter = read(new File(project + "/PS2UGUI_Export.jsx")).replace("new Folder(outputDir).execute()", "true").replace("    ensureNamingWatch();", "    // Registration tested separately.");
        doc = app.documents.add(1080,1920,72,"PanelCases",NewDocumentMode.RGB,DocumentFill.TRANSPARENT);
        var a = makeGroup("PanelA",false), b = makeGroup("PanelB",true);
        doc.saveAs(new File(output + "/PanelCases.psd"),new PhotoshopSaveOptions(),false);
        exportGroup(a,["Common/img_frame","Caption"]);
        exportGroup(b,["Common/img_frame","Caption"]);
        doc.close(SaveOptions.DONOTSAVECHANGES); doc = null;
        var business = new File(project.parent + "/.tmp/MultiPanelInspection.psd");
        if (business.exists) {
            var copy = new File(output + "/BusinessPanels.psd"); assert(business.copy(copy), "Cannot copy business PSD");
            doc = app.open(copy);
            var names = ["\u5931\u8d25 2 \u62f7\u8d1d","\u80dc\u5229","\u69fd\u4f4d\u5df2\u6ee1","\u6ca1\u65f6\u95f4\u4e86"];
            for (var i = 0; i < names.length; i++) exportGroup(doc.layerSets.getByName(names[i]));
            doc.close(SaveOptions.DONOTSAVECHANGES); doc = null;
        }
    } catch (error) { report.push("FAIL " + error.message + " line " + error.line); }
    finally {
        if (doc) doc.close(SaveOptions.DONOTSAVECHANGES);
        if (previous) app.activeDocument = previous;
        app.displayDialogs = dialogs; app.preferences.rulerUnits = ruler;
        var file = new File(output + "/report.txt"); file.encoding = "UTF-8"; file.open("w"); file.write(report.join("\n")); file.close();
    }
})();

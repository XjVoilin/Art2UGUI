// Native host checks for diagnostic files. Injects an unsupported action to obtain
// a real Photoshop error; this does not reproduce a particular colleague's PSD issue.
(function () {
    var project = new File($.fileName).parent.parent;
    var output = new Folder(project.parent + "/.tmp/photoshop-diagnostics-test");
    if (!output.exists) output.create();
    var previous = app.documents.length ? app.activeDocument : null;
    var dialogs = app.displayDialogs;
    var fixture = null;
    var report = [];
    var alerts = [];
    var dropdown;
    function control() {
        return { add: function (type) {
            if (type === "dropdownlist") { dropdown = {}; return dropdown; }
            return control();
        } };
    }
    function Window() {
        var dialog = control();
        dialog.show = function () { dropdown.selection = { index: 1 }; return 2; };
        return dialog;
    }
    function alert(message) { alerts.push(message); }
    function assert(value, message) { if (!value) throw new Error(message); }
    function read(file) {
        file.encoding = "UTF-8";
        assert(file.open("r"), "Cannot read " + file.fsName);
        try { return file.read(); } finally { file.close(); }
    }
    function verifyLog(stage, layerPath) {
        var message = alerts[alerts.length - 1];
        var match = /\u65e5\u5fd7: ([^\r\n]+)/.exec(message);
        assert(match, "Missing diagnostic path in alert: " + message);
        var log = read(new File(match[1]));
        assert(log.indexOf(stage) >= 0, "Missing stage");
        assert(log.indexOf(layerPath) >= 0, "Missing full layer path");
        assert(log.indexOf(app.version) >= 0, "Missing Photoshop version");
        assert(/\u9519\u8bef\u7f16\u53f7: -?\d+/.test(log), "Missing native error number");
        assert(/\u811a\u672c\u884c\u53f7: \d+/.test(log), "Missing native line number");
        assert(log.indexOf(fixture.name) >= 0, "Missing PSD name");
        report.push("PASS: " + stage + "; log=" + match[1]);
    }
    try {
        app.displayDialogs = DialogModes.NO;
        var source = read(new File(project + "/PS2UGUI_Export.jsx"))
            .replace("    ensureNamingWatch();", "    // No notifier registration during export tests.")
            .replace("new Folder(outputDir).execute()", "true");
        fixture = app.documents.add(new UnitValue(64, "px"), new UnitValue(64, "px"), 72,
            "DiagnosticFixture", NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
        var panel = fixture.layerSets.add(); panel.name = "TestPanel";
        var label = panel.artLayers.add(); label.kind = LayerKind.TEXT; label.name = "Caption";
        label.textItem.contents = "Log"; label.textItem.size = new UnitValue(12, "pt");
        label.textItem.position = [new UnitValue(2, "px"), new UnitValue(20, "px")];
        fixture.saveAs(new File(output + "/DiagnosticFixture.psd"), new PhotoshopSaveOptions(), false);
        fixture.activeLayer = panel;
        var history = fixture.historyStates.length;
        var count = app.documents.length;
        var failAction = 'executeAction(charIDToTypeID("A2ER"), new ActionDescriptor(), DialogModes.NO);';
        eval(source.replace("data.fontName = textItem.font;", failAction));
        verifyLog("\u8bfb\u53d6\u6587\u5b57\u5b57\u4f53", "TestPanel/Caption");
        assert(fixture.historyStates.length === history, "Fatal export changed source history");

        panel.name = "img_Panel";
        var art = panel.artLayers.add(); art.name = "Decoration";
        fixture.selection.select([[2, 2], [20, 2], [20, 20], [2, 20]]);
        var color = new SolidColor(); color.rgb.red = 255;
        fixture.selection.fill(color); fixture.selection.deselect();
        // Whole-document export includes the prefixed panel as a PNG.
        source = source.replace("var exportOptions = selectExportOptions();", "var exportOptions = {group:null,padding:1};");
        history = fixture.historyStates.length;
        var active = fixture.activeLayer;
        eval(source.replace("tempDoc.saveAs(new File(outputPath), pngOpts, true, Extension.LOWERCASE);", failAction));
        verifyLog("\u4fdd\u5b58 PNG", "img_Panel");
        assert(alerts[alerts.length - 1].indexOf("\u5bfc\u51fa\u90e8\u5206\u5b8c\u6210") >= 0, "Partial export not reported");
        assert(fixture.historyStates.length === history, "Partial export changed source history");
        assert(fixture.activeLayer === active, "Partial export changed source selection");
        assert(app.documents.length === count, "Temporary export document leaked");
        report.push("PASS: Photoshop " + app.version + "; source preserved; temporary documents closed");
    } catch (error) {
        report.push("FAIL: " + error.message + " (line " + error.line + ")");
    } finally {
        if (fixture !== null) fixture.close(SaveOptions.DONOTSAVECHANGES);
        if (previous !== null) app.activeDocument = previous;
        app.displayDialogs = dialogs;
        var file = new File(output + "/report.txt"); file.encoding = "UTF-8";
        file.open("w"); file.write(report.join("\n")); file.close();
    }
    return report.join("\n");
})();

// Native regression using the open business PSD's UITimeoutReviveWindow/Common/img_ad_01.
// Only fixture PSDs under .tmp are exported; the source PSD is never edited or saved.
(function () {
    var project = new File($.fileName).parent.parent;
    var output = new Folder(project.parent + '/.tmp/photoshop-image-bounds-test');
    if (!output.exists) output.create();
    var source = app.activeDocument, sourceLayer = source.activeLayer.id, sourceHistory = source.activeHistoryState;
    var dialogs = app.displayDialogs, ruler = app.preferences.rulerUnits;
    var fixture = null, reference = null, opened = null, dropdown, messages = [], report = [];
    function assert(ok, message) { if (!ok) throw new Error(message); }
    function read(file, encoding) {
        file.encoding = encoding; assert(file.open('r'), 'Cannot read ' + file.fsName);
        try { return file.read(); } finally { file.close(); }
    }
    function state(parent, values) {
        for (var i = 0; i < parent.layers.length; i++) {
            var layer = parent.layers[i]; values.push(layer.id + ':' + layer.name + ':' + layer.visible + ':' + layer.opacity);
            if (layer.typename === 'LayerSet') state(layer, values);
        }
        return values.join('|');
    }
    function find(parent) {
        for (var i = 0; i < parent.layers.length; i++) {
            var layer = parent.layers[i];
            if (layer.name === 'Common/img_ad_01') return layer;
            if (layer.typename === 'LayerSet') { var child = find(layer); if (child) return child; }
        }
        return null;
    }
    function control() {
        return { add: function (type) { if (type === 'dropdownlist') { dropdown = {}; return dropdown; } return control(); } };
    }
    function Window() {
        var dialog = control(); dialog.show = function () { dropdown.selection = { index: 1 }; return 1; }; return dialog;
    }
    function alert(message) { messages.push(message); }
    function box(layer) { var b = layer.bounds; return [b[0].as('px'), b[1].as('px'), b[2].as('px'), b[3].as('px')]; }
    var original = state(source, []);
    try {
        app.displayDialogs = DialogModes.NO; app.preferences.rulerUnits = Units.PIXELS;
        var target = find(source.layerSets.getByName('UITimeoutReviveWindow'));
        assert(target && target.kind === LayerKind.SMARTOBJECT, 'Open the business PSD containing the padded ad smart object');
        assert(box(target).join(',') === '-33,0,1080,1920', 'Business fixture changed; inspect its bounds before adjusting expectations');
        var exporter = read(new File(project + '/PS2UGUI_Export.jsx'), 'UTF-8').replace('new Folder(outputDir).execute()', 'true');
        var cases = [
            { suffix: '', width: 110, height: 117, contentW: 108, contentH: 115, x: 350, y: 1501, logicalW: 110, logicalH: 117 },
            { suffix: '^0.5', width: 56, height: 60, contentW: 54, contentH: 58, x: 349, y: 1502 - 115 / 58, logicalW: 112, logicalH: 115 + 230 / 58 },
            { suffix: '[240x240]', width: 240, height: 240, contentW: 108, contentH: 115, x: 285, y: 1439.5, logicalW: 240, logicalH: 240 }
        ];
        for (var index = 0; index < cases.length; index++) {
            var c = cases[index], name = 'AdBoundsCase' + index;
            fixture = app.documents.add(source.width, source.height, source.resolution, name, NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
            var blank = fixture.activeLayer; app.activeDocument = source;
            var copy = target.duplicate(fixture, ElementPlacement.PLACEATBEGINNING);
            app.activeDocument = fixture; blank.remove(); copy.name = 'Common/img_ad_01' + c.suffix;
            fixture.saveAs(new File(output + '/' + name + '.psd'), new PhotoshopSaveOptions(), false);
            var history = fixture.activeHistoryState, active = fixture.activeLayer.id;
            // Independent full-composite reference, cropped using measured pixel bounds.
            reference = fixture.duplicate('AdBoundsReference', true);
            assert(box(reference.layers[0]).join(',') === '351,1502,459,1617', 'Rendered content changed');
            reference.crop([new UnitValue(351, 'px'), new UnitValue(1502, 'px'), new UnitValue(459, 'px'), new UnitValue(1617, 'px')]);
            if (index === 1) reference.resizeImage(new UnitValue(54, 'px'), new UnitValue(58, 'px'), undefined, ResampleMethod.BICUBIC);
            reference.resizeCanvas(new UnitValue(c.width, 'px'), new UnitValue(c.height, 'px'), AnchorPosition.MIDDLECENTER);
            reference.saveAs(new File(output + '/expected-' + name + '.png'), new PNGSaveOptions(), true, Extension.LOWERCASE);
            reference.close(SaveOptions.DONOTSAVECHANGES); reference = null; app.activeDocument = fixture;
            messages = []; eval(exporter);
            assert(messages.length && messages[messages.length - 1].indexOf('PS2UGUI: \u5bfc\u51fa\u5b8c\u6210\uff01') === 0, messages.join(' | '));
            var png = new File(output + '/' + name + '/Common/img_ad_01.png');
            opened = app.open(png);
            assert(opened.width.as('px') === c.width && opened.height.as('px') === c.height, 'Unexpected PNG size for ' + name);
            var content = box(opened.layers[0]);
            assert(content[2] - content[0] === c.contentW && content[3] - content[1] === c.contentH, 'Artwork size changed for ' + name);
            assert(Math.abs((content[0] + content[2]) / 2 - c.width / 2) <= 0.5 &&
                Math.abs((content[1] + content[3]) / 2 - c.height / 2) <= 0.5, 'Artwork not centered');
            opened.close(SaveOptions.DONOTSAVECHANGES); opened = null; app.activeDocument = fixture;
            var data = eval('(' + read(new File(output + '/' + name + '/' + name + '_ui_data.json'), 'UTF-8') + ')');
            var node = data.layers[0];
            assert(Math.abs(node.x - c.x) < 0.0001 && Math.abs(node.y - c.y) < 0.0001 &&
                Math.abs(node.width - c.logicalW) < 0.0001 && Math.abs(node.height - c.logicalH) < 0.0001, 'JSON position/size mismatch');
            assert(node.scaleX === 1 && node.scaleY === 1 && node.rotationZ === 0, 'Transforms applied twice');
            assert((node.fixedCanvas === true) === (index === 2), 'Fixed canvas flag mismatch');
            assert(fixture.activeHistoryState === history && fixture.activeLayer.id === active, 'Fixture changed during export');
            report.push('PASS ' + name + ' PNG=' + c.width + 'x' + c.height + ' JSON=' + node.x + ',' + node.y + ',' + node.width + ',' + node.height);
            fixture.close(SaveOptions.DONOTSAVECHANGES); fixture = null;
        }
        report.push('PASS Photoshop ' + app.version);
    } catch (error) { report.push('FAIL ' + error.message + ' line ' + error.line); }
    finally {
        if (opened) opened.close(SaveOptions.DONOTSAVECHANGES);
        if (reference) reference.close(SaveOptions.DONOTSAVECHANGES);
        if (fixture) fixture.close(SaveOptions.DONOTSAVECHANGES);
        app.activeDocument = source; app.displayDialogs = dialogs; app.preferences.rulerUnits = ruler;
        if (source.activeLayer.id !== sourceLayer || source.activeHistoryState !== sourceHistory || state(source, []) !== original) report.push('FAIL source changed');
        else report.push('PASS source unchanged');
        var file = new File(output + '/report.txt'); file.encoding = 'UTF-8'; file.open('w'); file.write(report.join('\n')); file.close();
    }
    return report.join('\n');
})();

// Native Photoshop regression: run via File > Scripts > Browse, or COM DoJavaScriptFile.
// Creates its own fixture PSDs under the repository's .tmp/photoshop-export-test directory.
(function () {
    var project = new File($.fileName).parent.parent;
    var output = new Folder(project.parent + "/.tmp/photoshop-export-test");
    if (!output.exists) output.create();
    var previous = app.documents.length ? app.activeDocument : null;
    var dialogs = app.displayDialogs;
    var fixture = null;
    var messages = [];
    var rasterScale = 1;
    var padding = 0;
    var origin = [21, 527];
    var layerOpacity = 100;
    var tint = false;
    var paddingDropdown = null;

    // Supply dialog choices without manual input. Export and image operations use the real host.
    function control() {
        return { add: function (type, bounds, items) {
            if (type === "dropdownlist") {
                var dropdown = {};
                paddingDropdown = dropdown;
                return dropdown;
            }
            return control();
        } };
    }
    function Window() {
        var dialog = control();
        dialog.show = function () {
            paddingDropdown.selection = { index: padding };
            return 1;
        };
        return dialog;
    }
    function alert(message) { messages.push(message); }
    function assert(condition, message) { if (!condition) throw new Error(message); }
    function readFile(file, encoding) {
        file.encoding = encoding;
        assert(file.open("r"), "Cannot read " + file.fsName);
        try { return file.read(); } finally { file.close(); }
    }
    function pngSize(file) {
        var data = readFile(file, "BINARY");
        function numberAt(offset) {
            var value = 0;
            for (var i = 0; i < 4; i++) value = value * 256 + data.charCodeAt(offset + i);
            return value;
        }
        return [numberAt(16), numberAt(20)];
    }
    function createFixture(name) {
        fixture = app.documents.add(new UnitValue(1080, "px"), new UnitValue(1920, "px"), 72,
            name, NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
        var blank = fixture.activeLayer;
        var group = fixture.layerSets.add(); group.name = "img_Copy" + (tint ? "~" : "") + (rasterScale === 1 ? "" : "^" + rasterScale);
        var pixels = group.artLayers.add(); pixels.name = "pixels";
        fixture.activeLayer = pixels;
        var color = new SolidColor(); color.rgb.red = 255; color.rgb.green = 0; color.rgb.blue = 0;
        fixture.selection.select([[origin[0], origin[1]], [origin[0] + 200, origin[1]],
            [origin[0] + 200, origin[1] + 200], [origin[0], origin[1] + 200]]);
        fixture.selection.fill(color); fixture.selection.deselect();
        var desc = new ActionDescriptor();
        var ref = new ActionReference(); ref.putClass(charIDToTypeID("AdjL"));
        desc.putReference(charIDToTypeID("null"), ref);
        var using = new ActionDescriptor(); var settings = new ActionDescriptor();
        settings.putInteger(charIDToTypeID("Brgh"), 0);
        settings.putInteger(charIDToTypeID("Cntr"), 0);
        using.putObject(charIDToTypeID("Type"), charIDToTypeID("BrgC"), settings);
        desc.putObject(charIDToTypeID("Usng"), charIDToTypeID("AdjL"), using);
        executeAction(charIDToTypeID("Mk  "), desc, DialogModes.NO);
        blank.remove();
        group.opacity = layerOpacity;
        if (tint) {
            var effects = new ActionDescriptor();
            var solid = new ActionDescriptor();
            solid.putBoolean(stringIDToTypeID("enabled"), true);
            solid.putEnumerated(charIDToTypeID("Md  "), charIDToTypeID("BlnM"), charIDToTypeID("Nrml"));
            solid.putUnitDouble(charIDToTypeID("Opct"), charIDToTypeID("#Prc"), 100);
            var rgb = new ActionDescriptor();
            rgb.putDouble(charIDToTypeID("Rd  "), 255); rgb.putDouble(charIDToTypeID("Grn "), 0); rgb.putDouble(charIDToTypeID("Bl  "), 0);
            solid.putObject(charIDToTypeID("Clr "), charIDToTypeID("RGBC"), rgb);
            effects.putObject(stringIDToTypeID("solidFill"), stringIDToTypeID("solidFill"), solid);
            var set = new ActionDescriptor(); var target = new ActionReference();
            target.putProperty(charIDToTypeID("Prpr"), charIDToTypeID("Lefx"));
            target.putIdentifier(charIDToTypeID("Lyr "), group.id);
            set.putReference(charIDToTypeID("null"), target);
            set.putObject(charIDToTypeID("T   "), charIDToTypeID("Lefx"), effects);
            executeAction(charIDToTypeID("setd"), set, DialogModes.NO);
        }
        fixture.saveAs(new File(output + "/" + name + ".psd"), new PhotoshopSaveOptions(), false);
        assert(group.bounds[2].as("px") === 1080 && group.bounds[3].as("px") === 1920,
            "Fixture must reproduce adjustment-layer full-canvas bounds");
        return group;
    }
    try {
        app.displayDialogs = DialogModes.NO;
        var exporter = readFile(new File(project + "/PS2UGUI_Export.jsx"), "UTF-8");
        // Suppress Explorer/Finder only; keep the production export path intact.
        exporter = exporter.replace("new Folder(outputDir).execute()", "true");
        var cases = [
            { rasterScale: 1, padding: 0, origin: [21, 527] },
            { rasterScale: 2, padding: 0, origin: [21, 527] },
            { rasterScale: 1, padding: 1, origin: [21, 527] },
            { rasterScale: 2, padding: 2, origin: [21, 527] },
            { rasterScale: 1, padding: 1, origin: [0, 0] },
            { rasterScale: 0.5, padding: 0, origin: [21, 527] },
            { rasterScale: 0.5, padding: 1, origin: [21, 527] },
            { rasterScale: 0.5, padding: 1, origin: [21, 527], opacity: 50 },
            { rasterScale: 0.5, padding: 1, origin: [21, 527], opacity: 50, tint: true }
        ];
        for (var index = 0; index < cases.length; index++) {
            padding = cases[index].padding; origin = cases[index].origin;
            rasterScale = cases[index].rasterScale;
            layerOpacity = cases[index].opacity === undefined ? 100 : cases[index].opacity;
            tint = cases[index].tint === true;
            var name = "BoundsCase" + index;
            var group = createFixture(name);
            var history = fixture.historyStates.length;
            var selection = fixture.activeLayer.id;
            eval(exporter);
            var png = new File(output + "/" + name + "/img_Copy.png");
            var size = pngSize(png);
            var contentSize = Math.max(1, Math.round(200 * rasterScale));
            var pixelPadding = padding > 0 ? Math.max(1, Math.round(padding * rasterScale)) : 0;
            var logicalPadding = pixelPadding * 200 / contentSize;
            var expectedSize = contentSize + pixelPadding * 2;
            assert(size[0] === expectedSize && size[1] === expectedSize,
                "PNG: expected " + expectedSize + "x" + expectedSize + ", got " + size);
            var rendered = app.open(png);
            try {
                var alpha = rendered.activeLayer.bounds;
                assert(alpha[0].as("px") === pixelPadding && alpha[1].as("px") === pixelPadding &&
                    alpha[2].as("px") === contentSize + pixelPadding &&
                    alpha[3].as("px") === contentSize + pixelPadding,
                    "PNG must have exactly the selected transparent border around unchanged pixels");
            } finally {
                rendered.close(SaveOptions.DONOTSAVECHANGES);
                app.activeDocument = fixture;
            }
            var json = readFile(new File(output + "/" + name + "/" + name + "_ui_data.json"), "UTF-8");
            var data = eval("(" + json + ")");
            var layer = data.layers[0];
            assert(data.schemaVersion === 2 && layer.opacity === layerOpacity, "Opacity belongs to JSON exactly once");
            assert(layer.rotationZ === 0 && layer.scaleX === 1 && layer.scaleY === 1, "Image transforms must be baked");
            assert(!tint || layer.fontColor === "#FF0000", "Tint color missing");
            assert(layer.x === origin[0] - logicalPadding && layer.y === origin[1] - logicalPadding &&
                layer.width === 200 + logicalPadding * 2 && layer.height === 200 + logicalPadding * 2,
                "JSON geometry must preserve visible placement after padding");
            assert(fixture.historyStates.length === history, "Source history changed");
            assert(fixture.activeLayer.id === selection, "Source active layer changed");
            assert(group.bounds[2].as("px") === 1080, "Source group changed");
            messages.push("PASS: node scale=" + rasterScale + ", padding=" + padding + ", PNG=" + size +
                "; transparent border=" + pixelPadding + "; JSON=" + layer.x + "," + layer.y +
                "," + layer.width + "," + layer.height + "; source unchanged");
            fixture.close(SaveOptions.DONOTSAVECHANGES); fixture = null;
        }
        padding = 1;
        fixture = app.documents.add(new UnitValue(256, "px"), new UnitValue(256, "px"), 72,
            "RotatedCase", NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
        var rectangle = fixture.activeLayer;
        var red = new SolidColor(); red.rgb.red = 255; red.rgb.green = 0; red.rgb.blue = 0;
        fixture.selection.select([[60, 80], [161, 80], [161, 131], [60, 131]]);
        fixture.selection.fill(red); fixture.selection.deselect();
        executeAction(stringIDToTypeID("newPlacedLayer"), undefined, DialogModes.NO);
        rectangle = fixture.activeLayer;
        rectangle.name = "img_Rotated^0.5";
        rectangle.rotate(30, AnchorPosition.MIDDLECENTER);
        rectangle.opacity = 50;
        fixture.saveAs(new File(output + "/RotatedCase.psd"), new PhotoshopSaveOptions(), false);
        var rectangleBounds = rectangle.bounds;
        var expectedWidth = Math.round(rectangleBounds[2].as("px") - rectangleBounds[0].as("px"));
        var expectedHeight = Math.round(rectangleBounds[3].as("px") - rectangleBounds[1].as("px"));
        var rotatedHistory = fixture.historyStates.length;
        eval(exporter);
        var rotatedData = eval("(" + readFile(new File(output + "/RotatedCase/RotatedCase_ui_data.json"), "UTF-8") + ")");
        var rotatedLayer = rotatedData.layers[0];
        var rotatedSize = pngSize(new File(output + "/RotatedCase/img_Rotated.png"));
        var coreWidth = Math.max(1, Math.round(expectedWidth * 0.5));
        var coreHeight = Math.max(1, Math.round(expectedHeight * 0.5));
        assert(rotatedLayer.rotationZ === 0 && rotatedLayer.scaleX === 1 && rotatedLayer.scaleY === 1,
            "Rotated smart object must not rotate or scale twice in Unity");
        assert(Math.abs(rotatedLayer.width - expectedWidth * (coreWidth + 2) / coreWidth) < 0.0001 &&
            Math.abs(rotatedLayer.height - expectedHeight * (coreHeight + 2) / coreHeight) < 0.0001,
            "Rotated image uses its rendered rectangle including fractional padding");
        assert(rotatedSize[0] === coreWidth + 2 && rotatedSize[1] === coreHeight + 2, "Wrong rotated PNG size");
        assert(fixture.historyStates.length === rotatedHistory, "Rotated source history changed");
        messages.push("PASS: rotated smart object; PNG=" + rotatedSize + "; JSON=" + rotatedLayer.width + "," +
            rotatedLayer.height + "; rotationZ=0; opacity=50; source unchanged");
        fixture.close(SaveOptions.DONOTSAVECHANGES); fixture = null;
        for (var textCase = 0; textCase < 2; textCase++) {
            var textResolution = textCase === 0 ? 72 : 144;
            var textName = "TextScaleCase" + textCase;
            fixture = app.documents.add(new UnitValue(800, "px"), new UnitValue(600, "px"), textResolution,
                textName, NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
            var blankText = fixture.activeLayer;
            var textLayer = fixture.artLayers.add(); textLayer.kind = LayerKind.TEXT;
            textLayer.name = "SHOP";
            textLayer.textItem.contents = "SHOP";
            textLayer.textItem.font = "ArialMT";
            textLayer.textItem.size = new UnitValue(50, "pt");
            textLayer.textItem.position = [new UnitValue(80, "px"), new UnitValue(200, "px")];
            textLayer.resize(210, 210, AnchorPosition.TOPLEFT);
            blankText.remove();
            fixture.saveAs(new File(output + "/" + textName + ".psd"), new PhotoshopSaveOptions(), false);
            var textHistory = fixture.historyStates.length;
            eval(exporter);
            var textData = eval("(" + readFile(new File(output + "/" + textName + "/" + textName + "_ui_data.json"), "UTF-8") + ")");
            var expectedFontSize = 105 * textResolution / 72;
            assert(Math.abs(textData.layers[0].fontSize - expectedFontSize) < 0.001,
                "Transformed text must export the rendered font size, expected " + expectedFontSize + ", got " + textData.layers[0].fontSize);
            assert(textData.layers[0].scaleY === 1 && fixture.historyStates.length === textHistory,
                "Text size must not apply scale twice or mutate the source");
            assert(textData.layers[0].wordWrap === false, "Point text must not automatically wrap in Unity");
            messages.push("PASS: transformed text; resolution=" + textResolution + "; rendered fontSize=" + textData.layers[0].fontSize + "; source unchanged");
            fixture.close(SaveOptions.DONOTSAVECHANGES); fixture = null;
        }
        var fixedCases = [
            { w:100, h:50, tw:240, th:240, scale:1, pad:1 },
            { w:480, h:240, tw:240, th:240, scale:1, pad:1 },
            { w:101, h:51, tw:240, th:240, scale:1, pad:0 },
            { w:480, h:240, tw:240, th:240, scale:0.5, pad:1 },
            { w:100, h:50, tw:320, th:240, scale:1, pad:2 },
            { w:100, h:50, tw:240, th:240, scale:0.5, pad:1 }
        ];
        for (var fixedIndex = 0; fixedIndex < fixedCases.length; fixedIndex++) {
            var c = fixedCases[fixedIndex]; padding = c.pad;
            var fixedName = "FixedCanvasCase" + fixedIndex;
            fixture = app.documents.add(new UnitValue(1024,"px"),new UnitValue(768,"px"),72,
                fixedName,NewDocumentMode.RGB,DocumentFill.TRANSPARENT);
            var prop = fixture.activeLayer;
            prop.name = "img_prop[" + c.tw + "x" + c.th + "]" + (c.scale === 1 ? "" : "^" + c.scale);
            fixture.selection.select([[21,27],[21+c.w,27],[21+c.w,27+c.h],[21,27+c.h]]);
            var propColor = new SolidColor(); propColor.rgb.red = 255; propColor.rgb.green = 0; propColor.rgb.blue = 0;
            fixture.selection.fill(propColor); fixture.selection.deselect();
            fixture.saveAs(new File(output + "/" + fixedName + ".psd"), new PhotoshopSaveOptions(), false);
            var fixedHistory = fixture.historyStates.length;
            eval(exporter);
            var fixedPng = new File(output + "/" + fixedName + "/img_prop.png");
            var fw = Math.max(1,Math.round(c.tw*c.scale)), fh = Math.max(1,Math.round(c.th*c.scale));
            var fp = c.pad > 0 ? Math.max(1,Math.round(c.pad*c.scale)) : 0;
            var fit = Math.min(1,(fw-fp*2)/(c.w*c.scale),(fh-fp*2)/(c.h*c.scale));
            var contentWidth = Math.max(1,Math.round(c.w*c.scale*fit)), contentHeight = Math.max(1,Math.round(c.h*c.scale*fit));
            var fixedSize = pngSize(fixedPng);
            assert(fixedSize[0] === fw && fixedSize[1] === fh, "Fixed canvas PNG size mismatch");
            var openedFixed = app.open(fixedPng);
            try {
                var fb = openedFixed.activeLayer.bounds;
                var left = fb[0].as("px"), top = fb[1].as("px"), right = fb[2].as("px"), bottom = fb[3].as("px");
                assert(right-left === contentWidth && bottom-top === contentHeight, "Fixed canvas changed small image size or aspect ratio");
                assert(left >= fp && top >= fp && right <= fw-fp && bottom <= fh-fp, "Fixed canvas lost its transparent border");
                assert(Math.abs((left+right)/2-fw/2) <= 0.5 && Math.abs((top+bottom)/2-fh/2) <= 0.5, "Fixed canvas content is not centered");
            } finally { openedFixed.close(SaveOptions.DONOTSAVECHANGES); app.activeDocument = fixture; }
            var fixedJson = eval("(" + readFile(new File(output + "/" + fixedName + "/" + fixedName + "_ui_data.json"), "UTF-8") + ")");
            var fixedLayer = fixedJson.layers[0];
            assert(fixedLayer.fixedCanvas === true && fixedLayer.width === c.tw && fixedLayer.height === c.th,
                "Fixed canvas JSON must retain its logical slot size");
            assert(fixedLayer.x === 21+c.w/2-c.tw/2 && fixedLayer.y === 27+c.h/2-c.th/2, "Fixed canvas changed its design center");
            assert(fixture.historyStates.length === fixedHistory, "Fixed canvas mutated source history");
            messages.push("PASS: fixed canvas " + c.tw + "x" + c.th + "; PNG=" + fixedSize + "; content=" + contentWidth + "x" + contentHeight + "; source unchanged");
            fixture.close(SaveOptions.DONOTSAVECHANGES); fixture = null;
        }
        messages.push("PASS: Photoshop " + app.version);
    } catch (error) {
        messages.push("FAIL: " + error.message + " (line " + error.line + ")");
    } finally {
        if (fixture !== null) fixture.close(SaveOptions.DONOTSAVECHANGES);
        if (previous !== null) app.activeDocument = previous;
        app.displayDialogs = dialogs;
        var report = new File(output + "/report.txt"); report.encoding = "UTF-8";
        report.open("w"); report.write(messages.join("\n")); report.close();
    }
    return messages.join("\n");
})();

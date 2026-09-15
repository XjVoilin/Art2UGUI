/**
 * PS2UGUI_Export.jsx
 * Photoshop ExtendScript - 导出 PSD 为 JSON + PNG（对齐 Art2UGUI Figma 插件）
 *
 * 使用方法：在 Photoshop 中 文件 → 脚本 → 浏览，选择此文件
 * 输出：在 PSD 同目录下生成 {名称}_ps_data.json 和对应 PNG 文件
 *
 * 命名规范（前缀）：
 *   btn_    按钮
 *   img_    图片
 *   icon_   图标
 *   slider_ 滑动条
 *   sliderfill_ 滑动条填充
 *   bg_     背景
 *   mask_   遮罩
 *   tile_   平铺
 *
 * 命名规范（后缀）：
 *   ~       Tint 模式（导出白色 PNG，原色存入 fontColor）
 *   $       使用原始尺寸 (NativeSize)
 *   %       九宫格切片 (Sliced)
 *   @       引用外部 Prefab
 *   *N      缩放比例（如 *0.5）
 *
 * 特殊规则：
 *   # 开头的图层/组 → 跳过
 *   文本图层 → 导出为 text 类型（不导出 PNG）
 *   有前缀的图层组 → 整体导出为一张 PNG
 *   无前缀的图层组 → 作为容器递归遍历
 */

// @target photoshop

(function () {
    if (app.documents.length === 0) {
        alert("PS2UGUI: 请先打开一个 PSD 文件。");
        return;
    }

    var doc = app.activeDocument;
    var canvasWidth = Math.round(doc.width.as("px"));
    var canvasHeight = Math.round(doc.height.as("px"));

    var layers = [];
    var idCounter = 0;
    var orderCounter = 0;
    var pngExportList = []; // {layer, fileName, isTint}
    var warnings = [];

    var VALID_PREFIXES = ["btn_", "img_", "icon_", "slider_", "sliderfill_", "bg_", "mask_", "tile_"];

    // ========== 工具函数 ==========

    function padHex(n) {
        var hex = n.toString(16).toUpperCase();
        return hex.length < 2 ? "0" + hex : hex;
    }

    function colorToHex(color) {
        var r = Math.round(color.rgb.red);
        var g = Math.round(color.rgb.green);
        var b = Math.round(color.rgb.blue);
        return "#" + padHex(r) + padHex(g) + padHex(b);
    }

    function hasTintSuffix(name) {
        var stripped = stripScaleSuffix(name);
        return stripped.charAt(stripped.length - 1) === "~";
    }

    function stripScaleSuffix(name) {
        var lastStar = name.lastIndexOf("*");
        var lastSlash = name.lastIndexOf("/");
        if (lastStar > 0 && lastStar > lastSlash) {
            return name.substring(0, lastStar);
        }
        return name;
    }

    function stripAllSuffixes(name) {
        var result = stripScaleSuffix(name);
        while (result.length > 0) {
            var last = result.charAt(result.length - 1);
            if (last === "~" || last === "$" || last === "%" || last === "@") {
                result = result.substring(0, result.length - 1);
            } else {
                break;
            }
        }
        return result;
    }

    function getSpriteFileName(layerName) {
        return stripAllSuffixes(layerName);
    }

    function hasValidPrefix(name) {
        var lastSlash = name.lastIndexOf("/");
        var baseName = lastSlash >= 0 ? name.substring(lastSlash + 1) : name;
        var stripped = stripAllSuffixes(baseName);
        for (var i = 0; i < VALID_PREFIXES.length; i++) {
            if (stripped.indexOf(VALID_PREFIXES[i]) === 0) return true;
        }
        return false;
    }

    function isGroupIgnored(groupPath) {
        if (groupPath === "") return false;
        var segments = groupPath.split("/");
        for (var i = 0; i < segments.length; i++) {
            if (segments[i].charAt(0) === "#") return true;
        }
        return false;
    }

    function parseScale(name) {
        var lastStar = name.lastIndexOf("*");
        var lastSlash = name.lastIndexOf("/");
        if (lastStar <= 0 || lastStar <= lastSlash) return 1.0;
        var scaleStr = name.substring(lastStar + 1);
        var val = parseFloat(scaleStr);
        if (isNaN(val) || val <= 0) return 1.0;
        return val;
    }

    // ========== ActionManager 辅助 ==========

    function getColorOverlay(layer) {
        try {
            app.activeDocument.activeLayer = layer;
            var ref = new ActionReference();
            ref.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
            var desc = executeActionGet(ref);
            if (!desc.hasKey(stringIDToTypeID("layerEffects"))) return null;
            var effects = desc.getObjectValue(stringIDToTypeID("layerEffects"));
            if (!effects.hasKey(stringIDToTypeID("solidFill"))) return null;
            var solidFill = effects.getObjectValue(stringIDToTypeID("solidFill"));
            if (solidFill.hasKey(stringIDToTypeID("enabled"))) {
                if (!solidFill.getBoolean(stringIDToTypeID("enabled"))) return null;
            }
            if (!solidFill.hasKey(stringIDToTypeID("color"))) return null;
            var colorDesc = solidFill.getObjectValue(stringIDToTypeID("color"));
            var r = Math.round(colorDesc.getDouble(stringIDToTypeID("red")));
            var g = Math.round(colorDesc.getDouble(stringIDToTypeID("grain")));
            var b = Math.round(colorDesc.getDouble(stringIDToTypeID("blue")));
            return "#" + padHex(r) + padHex(g) + padHex(b);
        } catch (e) {
            return null;
        }
    }

    function getStrokeColor(layer) {
        try {
            app.activeDocument.activeLayer = layer;
            var ref = new ActionReference();
            ref.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
            var desc = executeActionGet(ref);
            if (!desc.hasKey(stringIDToTypeID("layerEffects"))) return null;
            var effects = desc.getObjectValue(stringIDToTypeID("layerEffects"));
            if (!effects.hasKey(stringIDToTypeID("frameFX"))) return null;
            var frameFX = effects.getObjectValue(stringIDToTypeID("frameFX"));
            if (frameFX.hasKey(stringIDToTypeID("enabled"))) {
                if (!frameFX.getBoolean(stringIDToTypeID("enabled"))) return null;
            }
            if (!frameFX.hasKey(stringIDToTypeID("color"))) return null;
            var colorDesc = frameFX.getObjectValue(stringIDToTypeID("color"));
            var r = Math.round(colorDesc.getDouble(stringIDToTypeID("red")));
            var g = Math.round(colorDesc.getDouble(stringIDToTypeID("grain")));
            var b = Math.round(colorDesc.getDouble(stringIDToTypeID("blue")));
            return "#" + padHex(r) + padHex(g) + padHex(b);
        } catch (e) {
            return null;
        }
    }

    function getStrokeWidth(layer) {
        try {
            app.activeDocument.activeLayer = layer;
            var ref = new ActionReference();
            ref.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
            var desc = executeActionGet(ref);
            if (!desc.hasKey(stringIDToTypeID("layerEffects"))) return 0;
            var effects = desc.getObjectValue(stringIDToTypeID("layerEffects"));
            if (!effects.hasKey(stringIDToTypeID("frameFX"))) return 0;
            var frameFX = effects.getObjectValue(stringIDToTypeID("frameFX"));
            if (frameFX.hasKey(stringIDToTypeID("enabled"))) {
                if (!frameFX.getBoolean(stringIDToTypeID("enabled"))) return 0;
            }
            if (!frameFX.hasKey(stringIDToTypeID("size"))) return 0;
            return frameFX.getUnitDoubleValue(stringIDToTypeID("size"));
        } catch (e) {
            return 0;
        }
    }

    function getSmartObjectScale(layer) {
        try {
            app.activeDocument.activeLayer = layer;
            var ref = new ActionReference();
            ref.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
            var d = executeActionGet(ref);
            var obj = d.getObjectValue(stringIDToTypeID("smartObjectMore"));
            if (!obj.hasKey(stringIDToTypeID("transform"))) return null;
            var tList = obj.getList(stringIDToTypeID("transform"));
            var p = [];
            for (var i = 0; i < tList.count; i += 2) {
                p.push({ x: tList.getDouble(i), y: tList.getDouble(i + 1) });
            }
            if (!obj.hasKey(stringIDToTypeID("size"))) return null;
            var size = obj.getObjectValue(stringIDToTypeID("size"));
            var origW = size.getDouble(stringIDToTypeID("width"));
            var origH = size.getDouble(stringIDToTypeID("height"));
            if (origW === 0 || origH === 0) return null;
            var curW = Math.sqrt(Math.pow(p[1].x - p[0].x, 2) + Math.pow(p[1].y - p[0].y, 2));
            var curH = Math.sqrt(Math.pow(p[3].x - p[0].x, 2) + Math.pow(p[3].y - p[0].y, 2));
            return { x: curW / origW, y: curH / origH };
        } catch (e) {
            return null;
        }
    }

    function getSmartObjectRotation(layer) {
        try {
            app.activeDocument.activeLayer = layer;
            var ref = new ActionReference();
            ref.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
            var d = executeActionGet(ref);
            var obj = d.getObjectValue(stringIDToTypeID("smartObjectMore"));
            if (!obj.hasKey(stringIDToTypeID("transform"))) return 0;
            var tList = obj.getList(stringIDToTypeID("transform"));
            var p0x = tList.getDouble(0);
            var p0y = tList.getDouble(1);
            var p1x = tList.getDouble(2);
            var p1y = tList.getDouble(3);
            var angle = Math.atan2(p1y - p0y, p1x - p0x) * 180 / Math.PI;
            return Math.round(angle * 100) / 100;
        } catch (e) {
            return 0;
        }
    }

    // ========== 图层遍历 ==========

    function traverseLayers(parent, groupPath) {
        var children = [];

        for (var i = 0; i < parent.artLayers.length; i++) {
            children.push({ layer: parent.artLayers[i], isGroup: false });
        }
        for (var i = 0; i < parent.layerSets.length; i++) {
            children.push({ layer: parent.layerSets[i], isGroup: true });
        }

        children.sort(function (a, b) {
            return b.layer.itemIndex - a.layer.itemIndex;
        });

        for (var i = 0; i < children.length; i++) {
            var child = children[i];
            var name = child.layer.name;

            if (name.charAt(0) === "#") continue;

            if (child.isGroup) {
                if (hasValidPrefix(name)) {
                    // 有前缀的组 → 作为 sprite 边界整体导出
                    var layerData = extractSpriteLayerData(child.layer, groupPath, true);
                    if (layerData !== null) {
                        layers.push(layerData);
                        if (layerData.type !== "text") {
                            pngExportList.push({
                                layer: child.layer,
                                fileName: getSpriteFileName(name),
                                isTint: hasTintSuffix(name)
                            });
                        }
                    }
                } else {
                    // 无前缀的组 → 容器，递归
                    var newGroupPath = groupPath === "" ? name : groupPath + "/" + name;
                    traverseLayers(child.layer, newGroupPath);
                }
            } else {
                // 叶子图层
                var isText = false;
                try { isText = (child.layer.kind === LayerKind.TEXT); } catch (e) {}

                if (isText) {
                    var textData = extractTextLayerData(child.layer, groupPath);
                    if (textData !== null) layers.push(textData);
                } else if (hasValidPrefix(name)) {
                    var spriteData = extractSpriteLayerData(child.layer, groupPath, false);
                    if (spriteData !== null) {
                        layers.push(spriteData);
                        pngExportList.push({
                            layer: child.layer,
                            fileName: getSpriteFileName(name),
                            isTint: hasTintSuffix(name)
                        });
                    }
                }
                // 无前缀叶子 → 跳过（装饰，被父级合并渲染）
            }
        }
    }

    // ========== 图层数据提取 ==========

    function getLayerBounds(layer) {
        var bounds = layer.bounds;
        var left = bounds[0].as("px");
        var top = bounds[1].as("px");
        var right = bounds[2].as("px");
        var bottom = bounds[3].as("px");
        return {
            x: Math.round(left),
            y: Math.round(top),
            width: Math.round(right - left),
            height: Math.round(bottom - top)
        };
    }

    function extractSpriteLayerData(layer, groupPath, isGroup) {
        var name = layer.name;
        var bounds = getLayerBounds(layer);
        var data = {};

        data.id = idCounter++;
        data.name = name;
        data.groupPath = groupPath;
        data.type = "image";
        data.x = bounds.x;
        data.y = bounds.y;
        data.width = bounds.width;
        data.height = bounds.height;
        data.visible = layer.visible;
        data.order = orderCounter++;
        data.opacity = Math.round(layer.opacity);

        // Scale
        data.scaleX = 1.0;
        data.scaleY = 1.0;
        if (!isGroup) {
            try {
                if (layer.kind === LayerKind.SMARTOBJECT) {
                    var scale = getSmartObjectScale(layer);
                    if (scale !== null) {
                        data.scaleX = Math.round(scale.x * 10000) / 10000;
                        data.scaleY = Math.round(scale.y * 10000) / 10000;
                    }
                }
            } catch (e) {}
        }

        // Rotation
        data.rotationZ = 0;
        if (!isGroup) {
            try {
                if (layer.kind === LayerKind.SMARTOBJECT) {
                    data.rotationZ = getSmartObjectRotation(layer);
                }
            } catch (e) {}
        }

        // fontColor: from ~ tint or Color Overlay
        if (hasTintSuffix(name)) {
            var tintColor = getColorOverlay(layer);
            if (tintColor !== null) {
                data.fontColor = tintColor;
            } else {
                // 尝试从图层自身获取颜色（对于形状图层）
                try {
                    if (!isGroup && layer.kind === LayerKind.SOLIDFILL) {
                        var fillColor = layer.fillColor;
                        if (fillColor) data.fontColor = colorToHex(fillColor);
                    }
                } catch (e) {}
            }
        } else {
            var overlay = getColorOverlay(layer);
            if (overlay !== null) {
                data.fontColor = overlay;
            }
        }

        return data;
    }

    function extractTextLayerData(layer, groupPath) {
        var bounds = getLayerBounds(layer);
        var data = {};

        data.id = idCounter++;
        data.name = layer.name;
        data.groupPath = groupPath;
        data.type = "text";
        data.x = bounds.x;
        data.y = bounds.y;
        data.width = bounds.width;
        data.height = bounds.height;
        data.visible = layer.visible;
        data.order = orderCounter++;
        data.opacity = Math.round(layer.opacity);
        data.scaleX = 1.0;
        data.scaleY = 1.0;
        data.rotationZ = 0;

        try {
            var textItem = layer.textItem;
            data.text = textItem.contents;
            data.fontSize = parseFloat(textItem.size.as("px"));
            data.fontColor = colorToHex(textItem.color);
            data.fontName = textItem.font;
            data.textAlignment = "center";
        } catch (e) {
            data.text = layer.name;
            data.fontSize = 24;
            data.fontColor = "#000000";
            data.fontName = "";
            data.textAlignment = "center";
        }

        // Stroke
        var strokeColor = getStrokeColor(layer);
        if (strokeColor !== null) {
            data.strokeColor = strokeColor;
            data.strokeWidth = getStrokeWidth(layer);
        }

        // Color Overlay 覆盖文本颜色
        var overlay = getColorOverlay(layer);
        if (overlay !== null) {
            data.fontColor = overlay;
        }

        return data;
    }

    // ========== PNG 导出 ==========

    function ensureFolder(folderPath) {
        var folder = new Folder(folderPath);
        if (!folder.exists) folder.create();
        return folder;
    }

    function exportLayerPNG(layer, outputPath, isTint) {
        try {
            doc.activeLayer = layer;

            // 如果是 ~ tint，临时应用白色覆盖
            var hadOverlay = false;
            var originalOverlayColor = null;
            if (isTint) {
                originalOverlayColor = getColorOverlay(layer);
                applyWhiteColorOverlay(layer);
                hadOverlay = true;
            }

            // 复制图层到新文档
            var idDplc = charIDToTypeID("Dplc");
            var descDplc = new ActionDescriptor();
            var refDplc = new ActionReference();
            refDplc.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
            descDplc.putReference(charIDToTypeID("null"), refDplc);
            descDplc.putString(charIDToTypeID("Nm  "), "temp_export");
            var docRef = new ActionReference();
            docRef.putClass(charIDToTypeID("Dcmn"));
            descDplc.putReference(charIDToTypeID("T   "), docRef);
            executeAction(idDplc, descDplc, DialogModes.NO);

            var tempDoc = app.activeDocument;
            tempDoc.flatten();

            // Trim 透明区域
            try {
                tempDoc.trim(TrimType.TRANSPARENT);
            } catch (e) {
                // 如果图层完全透明，trim 会失败
            }

            var pngOpts = new PNGSaveOptions();
            pngOpts.compression = 6;
            pngOpts.interlaced = false;
            tempDoc.saveAs(new File(outputPath), pngOpts, true, Extension.LOWERCASE);
            tempDoc.close(SaveOptions.DONOTSAVECHANGES);

            app.activeDocument = doc;

            // 恢复原始 Color Overlay
            if (hadOverlay) {
                if (originalOverlayColor !== null) {
                    restoreColorOverlay(layer, originalOverlayColor);
                } else {
                    removeColorOverlay(layer);
                }
            }
        } catch (e) {
            app.activeDocument = doc;
            warnings.push("PNG 导出失败: " + layer.name + " - " + e.message);
        }
    }

    function applyWhiteColorOverlay(layer) {
        try {
            doc.activeLayer = layer;
            var desc = new ActionDescriptor();
            var ref = new ActionReference();
            ref.putProperty(charIDToTypeID("Prpr"), charIDToTypeID("Lefx"));
            ref.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
            desc.putReference(charIDToTypeID("null"), ref);

            var lfxDesc = new ActionDescriptor();

            var solidDesc = new ActionDescriptor();
            solidDesc.putBoolean(stringIDToTypeID("enabled"), true);
            solidDesc.putEnumerated(charIDToTypeID("Md  "), charIDToTypeID("BlnM"), charIDToTypeID("Nrml"));

            var colorDesc = new ActionDescriptor();
            colorDesc.putDouble(charIDToTypeID("Rd  "), 255);
            colorDesc.putDouble(charIDToTypeID("Grn "), 255);
            colorDesc.putDouble(charIDToTypeID("Bl  "), 255);
            solidDesc.putObject(charIDToTypeID("Clr "), charIDToTypeID("RGBC"), colorDesc);
            solidDesc.putUnitDouble(charIDToTypeID("Opct"), charIDToTypeID("#Prc"), 100);

            lfxDesc.putObject(stringIDToTypeID("solidFill"), stringIDToTypeID("solidFill"), solidDesc);
            desc.putObject(charIDToTypeID("T   "), charIDToTypeID("Lefx"), lfxDesc);
            executeAction(charIDToTypeID("setd"), desc, DialogModes.NO);
        } catch (e) {
            warnings.push("应用白色覆盖失败: " + layer.name);
        }
    }

    function removeColorOverlay(layer) {
        try {
            doc.activeLayer = layer;
            // 通过清除 solidFill 效果来移除
            var desc = new ActionDescriptor();
            var ref = new ActionReference();
            ref.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
            desc.putReference(charIDToTypeID("null"), ref);

            var lfxDesc = new ActionDescriptor();
            var solidDesc = new ActionDescriptor();
            solidDesc.putBoolean(stringIDToTypeID("enabled"), false);
            lfxDesc.putObject(stringIDToTypeID("solidFill"), stringIDToTypeID("solidFill"), solidDesc);
            desc.putObject(charIDToTypeID("T   "), charIDToTypeID("Lefx"), lfxDesc);
            executeAction(charIDToTypeID("setd"), desc, DialogModes.NO);
        } catch (e) {}
    }

    function restoreColorOverlay(layer, hexColor) {
        try {
            doc.activeLayer = layer;
            var r = parseInt(hexColor.substring(1, 3), 16);
            var g = parseInt(hexColor.substring(3, 5), 16);
            var b = parseInt(hexColor.substring(5, 7), 16);

            var desc = new ActionDescriptor();
            var ref = new ActionReference();
            ref.putProperty(charIDToTypeID("Prpr"), charIDToTypeID("Lefx"));
            ref.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
            desc.putReference(charIDToTypeID("null"), ref);

            var lfxDesc = new ActionDescriptor();
            var solidDesc = new ActionDescriptor();
            solidDesc.putBoolean(stringIDToTypeID("enabled"), true);
            solidDesc.putEnumerated(charIDToTypeID("Md  "), charIDToTypeID("BlnM"), charIDToTypeID("Nrml"));

            var colorDesc = new ActionDescriptor();
            colorDesc.putDouble(charIDToTypeID("Rd  "), r);
            colorDesc.putDouble(charIDToTypeID("Grn "), g);
            colorDesc.putDouble(charIDToTypeID("Bl  "), b);
            solidDesc.putObject(charIDToTypeID("Clr "), charIDToTypeID("RGBC"), colorDesc);
            solidDesc.putUnitDouble(charIDToTypeID("Opct"), charIDToTypeID("#Prc"), 100);

            lfxDesc.putObject(stringIDToTypeID("solidFill"), stringIDToTypeID("solidFill"), solidDesc);
            desc.putObject(charIDToTypeID("T   "), charIDToTypeID("Lefx"), lfxDesc);
            executeAction(charIDToTypeID("setd"), desc, DialogModes.NO);
        } catch (e) {}
    }

    // ========== JSON 序列化 ==========

    function toJSON(value, indent, currentIndent) {
        if (indent === undefined) indent = "  ";
        if (currentIndent === undefined) currentIndent = "";
        if (value === null || value === undefined) return "null";
        if (typeof value === "boolean") return value ? "true" : "false";
        if (typeof value === "number") {
            if (value !== value) return "null";
            return "" + value;
        }
        if (typeof value === "string") return escapeString(value);

        var nextIndent = currentIndent + indent;

        if (value instanceof Array) {
            if (value.length === 0) return "[]";
            var items = [];
            for (var i = 0; i < value.length; i++) {
                items.push(nextIndent + toJSON(value[i], indent, nextIndent));
            }
            return "[\n" + items.join(",\n") + "\n" + currentIndent + "]";
        }

        var keys = [];
        for (var k in value) {
            if (value.hasOwnProperty(k)) keys.push(k);
        }
        if (keys.length === 0) return "{}";

        var pairs = [];
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            var val = value[key];
            if (val === undefined) continue;
            pairs.push(nextIndent + escapeString(key) + ": " + toJSON(val, indent, nextIndent));
        }
        return "{\n" + pairs.join(",\n") + "\n" + currentIndent + "}";
    }

    function escapeString(str) {
        str = str.replace(/\\/g, "\\\\");
        str = str.replace(/"/g, '\\"');
        str = str.replace(/\n/g, "\\n");
        str = str.replace(/\r/g, "\\r");
        str = str.replace(/\t/g, "\\t");
        return '"' + str + '"';
    }

    // ========== 执行 ==========

    var startTime = new Date().getTime();

    traverseLayers(doc, "");

    // 输出路径
    var docPath = doc.path;
    var docName = doc.name.replace(/\.[^.]+$/, "");
    var outputDir = docPath + "/" + docName;
    ensureFolder(outputDir);

    // 导出 JSON
    var outputData = {
        canvas: { width: canvasWidth, height: canvasHeight },
        layers: layers
    };
    var jsonString = toJSON(outputData);
    var jsonFile = new File(outputDir + "/" + docName + "_ps_data.json");
    jsonFile.encoding = "UTF-8";
    jsonFile.open("w");
    jsonFile.write(jsonString);
    jsonFile.close();

    // 导出 PNGs
    var pngCount = 0;
    for (var i = 0; i < pngExportList.length; i++) {
        var item = pngExportList[i];
        var fileName = item.fileName;

        // 处理含 / 的路径（创建子目录）
        var slashIdx = fileName.lastIndexOf("/");
        if (slashIdx >= 0) {
            var subDir = outputDir + "/" + fileName.substring(0, slashIdx);
            ensureFolder(subDir);
        }

        var pngPath = outputDir + "/" + fileName + ".png";
        exportLayerPNG(item.layer, pngPath, item.isTint);
        pngCount++;
    }

    var elapsed = Math.round((new Date().getTime() - startTime) / 1000);
    var msg = "PS2UGUI: 导出完成！\n\n";
    msg += "输出目录: " + outputDir + "\n";
    msg += "图层数: " + layers.length + "\n";
    msg += "PNG 数: " + pngCount + "\n";
    msg += "耗时: " + elapsed + " 秒";
    if (warnings.length > 0) {
        msg += "\n\n⚠️ 警告 (" + warnings.length + "):\n";
        for (var w = 0; w < warnings.length && w < 10; w++) {
            msg += "- " + warnings[w] + "\n";
        }
    }
    alert(msg);
})();

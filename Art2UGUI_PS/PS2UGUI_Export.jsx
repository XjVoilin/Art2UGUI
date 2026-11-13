/**
 * PS2UGUI_Export.jsx
 * Photoshop ExtendScript - 导出 PSD 为 JSON + PNG（对齐 Art2UGUI Figma 插件）
 *
 * 使用方法：在 Photoshop 中 文件 → 脚本 → 浏览，选择此文件
 * 输出：在 PSD 同目录的 {PSD名或选中组名}/ 中生成同名 JSON 和对应 PNG 文件
 * 默认按 PSD 原像素尺寸导出，节点 ^N 仅改变 PNG 分辨率，布局尺寸不变
 * 透明留边：可选 0/1/2px（默认 1px），随最终倍率缩放且至少保留 1 个透明像素
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
 *   ^N      节点 PNG 倍率（如 ^0.5），布局尺寸不变
 *   [WxH]   固定画布（如 [240x240]），小图不放大，大图等比缩小，居中补透明
 *
 * 特殊规则：
 *   # 开头的图层/组 → 跳过
 *   文本图层 → 导出为 text 类型（不导出 PNG）
 *   有前缀的图层组 → 导出自身切图，继续提取内部文字和带前缀的图层
 *   无前缀的图层组 → 作为容器递归遍历
 *   隐藏图层/组 → 跳过整个子树
 */

// @target photoshop

(function () {
    if (app.documents.length === 0) {
        alert("PS2UGUI: 请先打开一个 PSD 文件。");
        return;
    }

    var doc = app.activeDocument;
    var docPath;
    try {
        docPath = doc.path;
    } catch (e) {
        alert("PS2UGUI: 请先保存 PSD 文件，再执行导出。");
        return;
    }

    var exportOptions = selectExportOptions();
    if (exportOptions === null) return;
    var exportPadding = exportOptions.padding;

    var canvasWidth = Math.round(doc.width.as("px"));
    var canvasHeight = Math.round(doc.height.as("px"));

    var layers = [];
    var idCounter = 0;
    var orderCounter = 0;
    var pngExportList = []; // {layer, data, fileName, bounds, rasterScale, fixedCanvas}
    var warnings = [];

    var VALID_PREFIXES = ["btn_", "img_", "icon_", "slider_", "sliderfill_", "bg_", "mask_", "tile_"];

    // ========== 工具函数 ==========

    function selectedGroupProblem(group) {
        if (!group || group.typename !== "LayerSet" || group.parent.typename !== "Document") {
            return "请在图层面板选中一个顶层组本身。";
        }
        var name = group.name;
        if (!name || name.charAt(0) === "#" || name === "." || name === ".." ||
            /[\\\/:*?"<>|\x00-\x1f]/.test(name) || /[. ]$/.test(name) ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(name)) {
            return "组名需要能作为独立文件夹名称，且不能以 # 开头。";
        }
        var count = 0;
        for (var i = 0; i < doc.layers.length; i++) {
            if (doc.layers[i].typename === "LayerSet" && doc.layers[i].name.toLowerCase() === name.toLowerCase()) count++;
        }
        if (count > 1) return "存在同名顶层组，请先为面板设置唯一名称。";
        var desc = getLayerDescriptor(group);
        if (desc.hasKey(stringIDToTypeID("artboardEnabled")) && desc.getBoolean(stringIDToTypeID("artboardEnabled"))) {
            return "当前选组导出用于共用 PSD 画布的普通组，暂不支持独立画板。";
        }
        return null;
    }

    function selectExportOptions() {
        var selectedGroup = doc.activeLayer;
        var groupProblem = selectedGroupProblem(selectedGroup);
        var dialog = new Window("dialog", "Art2UGUI 导出");
        dialog.orientation = "column";
        dialog.alignChildren = "fill";
        dialog.margins = 16;
        dialog.spacing = 12;
        addHelpText(dialog, "导出 JSON + PNG，在 PSD 所在目录生成 PSD 或选中组的同名文件夹。", 36);
        addNamingRules(dialog);
        var paddingRow = dialog.add("group");
        paddingRow.add("statictext", undefined, "透明留边：");
        var padding = paddingRow.add("dropdownlist", undefined, ["无", "1px", "2px"]);
        padding.selection = 1;
        addHelpText(dialog, "默认按原尺寸导出，用节点 ^0.5 单独缩图。\n留边随节点倍率缩放，至少保留 1 个透明像素。", 44);
        addHelpText(dialog, groupProblem ? "选中组导出不可用：" + groupProblem :
            "当前选中组：" + selectedGroup.name + (selectedGroup.visible ? "" : "（隐藏，可独立导出）"), 36);
        addHelpText(dialog, "选组导出沿用 PSD 画布和坐标，只包含组内内容。", 24);
        var buttons = dialog.add("group");
        buttons.alignment = "right";
        buttons.add("button", undefined, "取消", { name: "cancel" });
        var wholeButton = buttons.add("button", undefined, "导出整个 PSD", { name: "ok" });
        var groupButton = buttons.add("button", undefined, "导出选中组");
        wholeButton.onClick = function () { dialog.close(1); };
        groupButton.onClick = function () { dialog.close(2); };
        groupButton.enabled = groupProblem === null;
        var result = dialog.show();
        if (result !== 1 && result !== 2) return null;
        if (result === 2 && groupProblem !== null) {
            alert("PS2UGUI: " + groupProblem);
            return null;
        }
        return { padding: padding.selection.index, group: result === 2 ? selectedGroup : null };
    }

    function addHelpText(parent, text, height) {
        var label = parent.add("statictext", undefined, text, { multiline: true });
        label.preferredSize = [450, height];
    }

    function addNamingRules(dialog) {
        var panel = dialog.add("panel", undefined, "命名规则");
        panel.orientation = "column";
        panel.alignChildren = "fill";
        panel.margins = 12;
        panel.spacing = 8;

        addHelpText(panel, "前缀：btn_ 按钮    img_ 图片", 24);
        addHelpText(panel,
            "后缀：% 九宫格\n" +
            "~ Tint：白色 PNG + 原色\n" +
            "^ 节点 PNG 倍率：^0.5 宽高减半，布局大小不变。\n" +
            "[240x240] 固定画布：小图不放大，大图等比缩小，居中。", 88);
        addHelpText(panel,
            "# 开头：不生成独立导出项；隐藏图层跳过。\n" +
            "可见文字导出为文字数据，不生成 PNG。\n" +
            "无前缀组递归遍历；无前缀图形不单独导出。\n" +
            "前缀组继续提取内部文字和带前缀的图层。", 88);
        addHelpText(panel, "示例：btn_confirm%    img_star~    img_logo^0.5\n固定道具：img_prop[240x240]（留边包含在画布内）", 44);
    }

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
        var stripped = stripFixedCanvasSuffix(stripScaleSuffix(name));
        while (stripped.length > 0 && "$%@~".indexOf(stripped.charAt(stripped.length - 1)) >= 0) {
            if (stripped.charAt(stripped.length - 1) === "~") return true;
            stripped = stripped.substring(0, stripped.length - 1);
        }
        return false;
    }

    function stripScaleSuffix(name) {
        var lastCaret = name.lastIndexOf("^");
        return lastCaret < 0 ? name : name.substring(0, lastCaret);
    }

    function getRasterScale(name) {
        var lastCaret = name.lastIndexOf("^");
        if (lastCaret < 0) return 1;
        var suffix = name.substring(lastCaret + 1);
        var scale = Number(suffix);
        if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(suffix) || !isFinite(scale) || scale <= 0) {
            throw new Error("节点 PNG 倍率必须是正数，例如 img_logo^0.5: " + name);
        }
        return scale;
    }

    function stripFixedCanvasSuffix(name) {
        return name.replace(/\[\d+[xX×]\d+\](?=[$%@~]*$)/, "");
    }

    function getFixedCanvasSize(name) {
        var base = stripScaleSuffix(name);
        var leaf = base.substring(base.lastIndexOf("/") + 1);
        var match = /\[(\d+)[xX×](\d+)\](?=[$%@~]*$)/.exec(leaf);
        if (!match && !/\[[+-]?[\d.][^\[\]]*[xX×]/.test(leaf)) return null;
        if (!match || /\[\d+[xX×]\d+\]/.test(leaf.substring(0, match.index))) {
            throw new Error("固定画布必须写为 [宽x高]，例如 img_prop[240x240]: " + name);
        }
        var width = Number(match[1]);
        var height = Number(match[2]);
        if (!isFinite(width) || !isFinite(height) || width <= 0 || height <= 0) {
            throw new Error("固定画布宽高必须为正整数: " + name);
        }
        return { width: width, height: height };
    }

    function getFixedCanvasPixels(canvas, scale) {
        var pixels = { width: Math.max(1, Math.round(canvas.width * scale)),
            height: Math.max(1, Math.round(canvas.height * scale)),
            padding: exportPadding > 0 ? Math.max(1, Math.round(exportPadding * scale)) : 0 };
        if (!isFinite(pixels.width) || !isFinite(pixels.height) ||
            pixels.width <= pixels.padding * 2 || pixels.height <= pixels.padding * 2) {
            throw new Error("固定画布无法容纳透明留边，请增大尺寸或选择无留边。");
        }
        return pixels;
    }

    function stripAllSuffixes(name) {
        var result = stripFixedCanvasSuffix(stripScaleSuffix(name));
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
        var stripped = stripScaleSuffix(name);
        var lastSlash = stripped.lastIndexOf("/");
        var baseName = lastSlash >= 0 ? stripped.substring(lastSlash + 1) : stripped;
        for (var i = 0; i < VALID_PREFIXES.length; i++) {
            if (baseName.indexOf(VALID_PREFIXES[i]) === 0) return true;
        }
        return false;
    }

    // ========== ActionManager 辅助 ==========

    function getLayerDescriptor(layer) {
        var ref = new ActionReference();
        ref.putIdentifier(charIDToTypeID("Lyr "), layer.id);
        return executeActionGet(ref);
    }

    function descriptorColorToHex(color) {
        return "#" + padHex(Math.round(color.getDouble(stringIDToTypeID("red")))) +
            padHex(Math.round(color.getDouble(stringIDToTypeID("grain")))) +
            padHex(Math.round(color.getDouble(stringIDToTypeID("blue"))));
    }

    function getColorOverlay(layer) {
        try {
            var desc = getLayerDescriptor(layer);
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
            var desc = getLayerDescriptor(layer);
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
            var desc = getLayerDescriptor(layer);
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

    function getEffectiveOpacity(layer) {
        var opacity = layer.opacity / 100;
        var parent = layer.parent;
        while (parent && parent.typename === "LayerSet") {
            opacity *= parent.opacity / 100;
            parent = parent.parent;
        }
        return Math.round(opacity * 100);
    }

    // ========== 图层遍历 ==========

    function traverseLayers(parent, groupPath) {
        // PS 的 layers[0] 是最上层；Figma children 的最后一项是最上层。
        // Figma 实现反向遍历 children，因此 PS 正向遍历混合集合来保持同一视觉顺序。
        for (var i = 0; i < parent.layers.length; i++) {
            var child = parent.layers[i];
            var name = child.name;
            if (!child.visible || name.charAt(0) === "#") continue;
            var isGroup = child.typename === "LayerSet";

            if (!isGroup && child.kind === LayerKind.TEXT) {
                layers.push(extractTextLayerData(child, groupPath));
                continue;
            }
            if (hasValidPrefix(name)) {
                var rasterScale = getRasterScale(name);
                var fixedCanvas = getFixedCanvasSize(name);
                if (fixedCanvas !== null) getFixedCanvasPixels(fixedCanvas, rasterScale);
                var layerData = extractSpriteLayerData(child, groupPath, isGroup);
                if (fixedCanvas !== null) layerData.fixedCanvas = true;
                layers.push(layerData);
                pngExportList.push({ layer: child, data: layerData,
                    fileName: getSpriteFileName(name), bounds: getLayerBounds(child), rasterScale: rasterScale, fixedCanvas: fixedCanvas });
            }
            // 两种组都递归：前缀组自身是一张切图，其内部文字和前缀节点独立导出。
            if (isGroup) {
                var newPath = groupPath === "" ? name : groupPath + "/" + name;
                traverseLayers(child, newPath);
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
        data.opacity = getEffectiveOpacity(layer);

        data.scaleX = 1.0;
        data.scaleY = 1.0;
        data.rotationZ = 0;
        // Images contain baked rotation/scale; JSON describes their rendered rectangle.
        if (hasTintSuffix(name)) {
            var tintColor = getTintColor(layer);
            if (tintColor === null && isGroup) tintColor = findTintChildColor(layer);
            if (tintColor === null) warnings.push("Tint 无可读取的纯色色源，保留原图: " + name);
            else data.fontColor = tintColor;
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
        data.opacity = getEffectiveOpacity(layer);
        data.scaleX = 1.0;
        data.scaleY = 1.0;
        data.rotationZ = 0;

        var textItem = layer.textItem;
        data.text = textItem.contents;
        data.fontSize = getTextFontSize(layer);
        data.wordWrap = textItem.kind === TextType.PARAGRAPHTEXT;
        data.fontColor = colorToHex(textItem.color);
        data.fontName = textItem.font;
        data.textAlignment = getTextAlignment(textItem.justification);

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

    function getTextFontSize(layer) {
        var size = layer.textItem.size.as("pt") * doc.resolution / 72;
        // Photoshop keeps the editable base size after Free Transform. The
        // text matrix's Y axis contains the additional rendered font scale.
        var text = getLayerDescriptor(layer).getObjectValue(stringIDToTypeID("textKey"));
        if (text.hasKey(stringIDToTypeID("transform"))) {
            var transform = text.getObjectValue(stringIDToTypeID("transform"));
            var yx = transform.getDouble(stringIDToTypeID("yx"));
            var yy = transform.getDouble(stringIDToTypeID("yy"));
            size *= Math.sqrt(yx * yx + yy * yy);
        }
        return Math.round(size * 10000) / 10000;
    }

    function getTextAlignment(justification) {
        if (justification === Justification.CENTER || justification === Justification.CENTERJUSTIFIED) return "center";
        if (justification === Justification.RIGHT || justification === Justification.RIGHTJUSTIFIED) return "right";
        return "left";
    }

    function getTintColor(layer) {
        var overlay = getColorOverlay(layer);
        if (overlay !== null) return overlay;
        if (layer.typename === "LayerSet" || layer.kind !== LayerKind.SOLIDFILL) return null;
        // 形状图层没有 DOM fillColor 属性，从 adjustment 描述符读取纯色填充。
        try {
            var desc = getLayerDescriptor(layer);
            var adjustments = desc.getList(stringIDToTypeID("adjustment"));
            var fill = adjustments.getObjectValue(0);
            return descriptorColorToHex(fill.getObjectValue(stringIDToTypeID("color")));
        } catch (e) {
            warnings.push("无法读取形状填充颜色: " + layer.name + " - " + e.message);
            return null;
        }
    }

    function findTintChildColor(parent) {
        // Figma 按 children 正序选取第一个 Tint 颜色，即从视觉底层向上查找。
        for (var i = parent.layers.length - 1; i >= 0; i--) {
            var child = parent.layers[i];
            if (!child.visible) continue;
            if (hasTintSuffix(child.name)) return getTintColor(child);
            if (child.typename === "LayerSet" && !hasValidPrefix(child.name)) {
                var color = findTintChildColor(child);
                if (color !== null) return color;
            }
        }
        return null;
    }

    // ========== PNG 导出 ==========

    function ensureFolder(folderPath) {
        var folder = new Folder(folderPath);
        if (!folder.exists) {
            if (!folder.parent.exists) ensureFolder(folder.parent.fsName);
            if (!folder.create()) throw new Error("无法创建目录: " + folder.fsName + " - " + folder.error);
        }
        return folder;
    }

    function getRenderedGroupBounds(tempDoc) {
        // 调整层可让 LayerSet.bounds 变成整画布；合成副本的像素边界才是实际可见范围。
        // 在隐藏子组件前测量，保持文字和子图片分离后的坐标基准一致。
        var measurement = tempDoc.duplicate("Art2UGUI_bounds", true);
        try {
            return getLayerBounds(measurement.layers[0]);
        } finally {
            try {
                measurement.close(SaveOptions.DONOTSAVECHANGES);
            } finally {
                app.activeDocument = tempDoc;
            }
        }
    }

    function exportLayerPNG(item, outputPath) {
        var tempDoc = null;
        try {
            var bounds = item.bounds;
            if (bounds.width <= 0 || bounds.height <= 0) throw new Error("图层边界为空，无法生成 PNG");
            tempDoc = app.documents.add(doc.width, doc.height, doc.resolution, "Art2UGUI_temp",
                NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
            var emptyLayer = tempDoc.activeLayer;
            app.activeDocument = doc;
            var copy = item.layer.duplicate(tempDoc, ElementPlacement.PLACEATBEGINNING);
            app.activeDocument = tempDoc;
            emptyLayer.remove();
            copy.visible = true;
            copy.opacity = 100; // The effective opacity is applied once by Unity.

            if (copy.typename === "LayerSet") {
                bounds = getRenderedGroupBounds(tempDoc);
                item.data.x = bounds.x;
                item.data.y = bounds.y;
                item.data.width = bounds.width;
                item.data.height = bounds.height;
                if (bounds.width <= 0 || bounds.height <= 0) throw new Error("组内没有可见像素，无法生成 PNG");
            }
            if (copy.typename === "LayerSet") hideNestedExportables(copy);
            // Freeze the rendered pixels before crop/resizeCanvas. Live vector masks and
            // layer effects can re-render outside the measured rectangle after these operations.
            var rendered = tempDoc.duplicate("Art2UGUI_pixels", true);
            tempDoc.close(SaveOptions.DONOTSAVECHANGES);
            tempDoc = rendered;
            app.activeDocument = tempDoc;
            if (item.data.fontColor) {
                // Composite effects first, then whiten the complete alpha mask.
                // This also whitens shadows/strokes instead of multiplying their colors again.
                applyWhiteColorOverlay(tempDoc.layers[0]);
            }

            // 保留分离前的矩形，避免隐藏文字/子图片后 trim 改变切图原点。
            // 不 flatten：PNG 必须保留透明度。
            tempDoc.crop([new UnitValue(bounds.x, "px"), new UnitValue(bounds.y, "px"),
                new UnitValue(bounds.x + bounds.width, "px"), new UnitValue(bounds.y + bounds.height, "px")]);
            var pixelScale = item.rasterScale;
            var fixedPixels = item.fixedCanvas !== null ? getFixedCanvasPixels(item.fixedCanvas, pixelScale) : null;
            var fit = fixedPixels !== null ? Math.min(1,
                (fixedPixels.width - fixedPixels.padding * 2) / (bounds.width * pixelScale),
                (fixedPixels.height - fixedPixels.padding * 2) / (bounds.height * pixelScale)) : 1;
            var pixelWidth = Math.max(1, Math.round(bounds.width * pixelScale * fit));
            var pixelHeight = Math.max(1, Math.round(bounds.height * pixelScale * fit));
            if (pixelWidth !== bounds.width || pixelHeight !== bounds.height) {
                tempDoc.resizeImage(new UnitValue(pixelWidth, "px"),
                    new UnitValue(pixelHeight, "px"), undefined, ResampleMethod.BICUBIC);
            }
            if (fixedPixels !== null) {
                tempDoc.resizeCanvas(new UnitValue(fixedPixels.width, "px"),
                    new UnitValue(fixedPixels.height, "px"), AnchorPosition.MIDDLECENTER);
                item.data.x = bounds.x + bounds.width / 2 - item.fixedCanvas.width / 2;
                item.data.y = bounds.y + bounds.height / 2 - item.fixedCanvas.height / 2;
                item.data.width = item.fixedCanvas.width;
                item.data.height = item.fixedCanvas.height;
            } else if (exportPadding > 0) {
                // 缩放后再扩画布，避免插值将图案颜色扩散进新增的透明边。
                // 先裁切后居中扩展，也能正确处理贴着原画布边缘的图案。
                var pixelPadding = Math.max(1, Math.round(exportPadding * pixelScale));
                tempDoc.resizeCanvas(new UnitValue(pixelWidth + pixelPadding * 2, "px"),
                    new UnitValue(pixelHeight + pixelPadding * 2, "px"), AnchorPosition.MIDDLECENTER);
                // 缩小及像素取整后，按实际贴图比例换算留边，保持可见图案的布局大小和中心。
                var paddingX = pixelPadding * item.data.width / pixelWidth;
                var paddingY = pixelPadding * item.data.height / pixelHeight;
                item.data.x -= paddingX;
                item.data.y -= paddingY;
                item.data.width += paddingX * 2;
                item.data.height += paddingY * 2;
            }

            var pngOpts = new PNGSaveOptions();
            pngOpts.compression = 6;
            pngOpts.interlaced = false;
            tempDoc.saveAs(new File(outputPath), pngOpts, true, Extension.LOWERCASE);
            return true;
        } catch (e) {
            warnings.push("PNG 导出失败: " + item.layer.name + " - " + e.message);
            return false;
        } finally {
            try {
                if (tempDoc !== null) tempDoc.close(SaveOptions.DONOTSAVECHANGES);
            } finally {
                app.activeDocument = doc;
            }
        }
    }

    function hideNestedExportables(parent) {
        for (var i = 0; i < parent.layers.length; i++) {
            var child = parent.layers[i];
            if (!child.visible) continue;
            var isGroup = child.typename === "LayerSet";
            // All independently exported children are separated, including Tint images.
            if ((!isGroup && child.kind === LayerKind.TEXT) ||
                hasValidPrefix(child.name)) {
                child.visible = false;
            } else if (isGroup && !hasValidPrefix(child.name) && child.name.charAt(0) !== "#") {
                hideNestedExportables(child);
            }
        }
    }

    function applyWhiteColorOverlay(layer) {
        app.activeDocument.activeLayer = layer;
        var layerDesc = getLayerDescriptor(layer);
        var effectsKey = stringIDToTypeID("layerEffects");
        // 在副本上保留描边、阴影及其他效果，只替换颜色叠加。
        var effects = layerDesc.hasKey(effectsKey) ? layerDesc.getObjectValue(effectsKey) : new ActionDescriptor();
        var solid = new ActionDescriptor();
        solid.putBoolean(stringIDToTypeID("enabled"), true);
        solid.putEnumerated(charIDToTypeID("Md  "), charIDToTypeID("BlnM"), charIDToTypeID("Nrml"));
        solid.putUnitDouble(charIDToTypeID("Opct"), charIDToTypeID("#Prc"), 100);
        var color = new ActionDescriptor();
        color.putDouble(charIDToTypeID("Rd  "), 255);
        color.putDouble(charIDToTypeID("Grn "), 255);
        color.putDouble(charIDToTypeID("Bl  "), 255);
        solid.putObject(charIDToTypeID("Clr "), charIDToTypeID("RGBC"), color);
        effects.putObject(stringIDToTypeID("solidFill"), stringIDToTypeID("solidFill"), solid);

        var ref = new ActionReference();
        ref.putProperty(charIDToTypeID("Prpr"), charIDToTypeID("Lefx"));
        ref.putIdentifier(charIDToTypeID("Lyr "), layer.id);
        var desc = new ActionDescriptor();
        desc.putReference(charIDToTypeID("null"), ref);
        desc.putObject(charIDToTypeID("T   "), charIDToTypeID("Lefx"), effects);
        executeAction(charIDToTypeID("setd"), desc, DialogModes.NO);
    }

    // ========== JSON 序列化 ==========

    function toJSON(value, indent, currentIndent) {
        if (indent === undefined) indent = "  ";
        if (currentIndent === undefined) currentIndent = "";
        if (value === null || value === undefined) return "null";
        if (typeof value === "boolean") return value ? "true" : "false";
        if (typeof value === "number") {
            if (!isFinite(value)) throw new Error("导出数据包含无效数值");
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
        str = str.replace(/[\x00-\x1f]/g, function (character) {
            var hex = character.charCodeAt(0).toString(16);
            return "\\u" + ("0000" + hex).slice(-4);
        });
        return '"' + str + '"';
    }

    // ========== 执行 ==========

    function validateSpritePaths() {
        var seen = {};
        for (var i = 0; i < pngExportList.length; i++) {
            var fileName = pngExportList[i].fileName;
            var segments = fileName.split("/");
            for (var j = 0; j < segments.length; j++) {
                var segment = segments[j];
                if (segment === "" || segment === "." || segment === ".." ||
                    /[\\:*?"<>|\x00-\x1f]/.test(segment) || /[. ]$/.test(segment)) {
                    throw new Error("图层名称不能用作相对 PNG 路径: " + fileName);
                }
            }
            var key = "$" + fileName.toLowerCase();
            if (seen[key]) warnings.push("PNG 路径重复，后导出的图层将覆盖同名文件: " + fileName);
            seen[key] = true;
        }
    }

    function runExport() {
        var startTime = new Date().getTime();
        var panel = exportOptions.group;
        // The selected group is a panel container. Its hidden state is intentionally
        // ignored without mutating it; hidden descendants retain the normal rules.
        traverseLayers(panel || doc, "");
        if (panel && layers.length === 0) throw new Error("选中组没有符合命名规则的可导出图层。");
        if (panel && pngExportList.length === 0) warnings.push("本次仅导出文字，未发现带 img_/btn_ 等前缀的图片；如需切图，请先整理图片命名。");
        validateSpritePaths();
        var docName = doc.name.replace(/\.[^.]+$/, "");
        var exportName = panel ? panel.name : docName;
        var outputDir = docPath + "/" + exportName;
        var outputData = { schemaVersion: 2,
            canvas: { width: canvasWidth, height: canvasHeight }, layers: layers };
        ensureFolder(outputDir);

        var pngCount = 0;
        for (var i = 0; i < pngExportList.length; i++) {
            var item = pngExportList[i];
            var slashIdx = item.fileName.lastIndexOf("/");
            if (slashIdx >= 0) ensureFolder(outputDir + "/" + item.fileName.substring(0, slashIdx));
            if (exportLayerPNG(item, outputDir + "/" + item.fileName + ".png")) pngCount++;
        }

        // 组的真实可见边界在切图阶段测得，JSON 必须在边界回写后序列化。
        var jsonString = toJSON(outputData);
        var jsonFile = new File(outputDir + "/" + exportName + "_ui_data.json");
        jsonFile.encoding = "UTF-8";
        if (!jsonFile.open("w")) throw new Error("无法写入 JSON: " + jsonFile.error);
        try {
            if (!jsonFile.write(jsonString)) throw new Error("JSON 写入失败: " + jsonFile.error);
        } finally {
            jsonFile.close();
        }

        // 打开系统文件管理器失败不影响已经写出的导出文件。
        try {
            if (!new Folder(outputDir).execute()) {
                warnings.push("无法自动打开输出目录，请手动打开: " + outputDir);
            }
        } catch (e) {
            warnings.push("无法自动打开输出目录，请手动打开: " + outputDir + " - " + e.message);
        }

        var failed = pngExportList.length - pngCount;
        var msg = failed > 0 ? "PS2UGUI: 导出部分完成（有 PNG 失败）\n\n" : "PS2UGUI: 导出完成！\n\n";
        msg += "输出目录: " + outputDir + "\n";
        msg += "范围: " + (panel ? "选中组 " + panel.name : "整个 PSD") + "\n";
        msg += "JSON: " + exportName + "_ui_data.json\n";
        msg += "图层数: " + layers.length + "\n";
        msg += "PNG 成功/计划: " + pngCount + "/" + pngExportList.length + "\n";
        msg += "透明留边: " + exportPadding + "px（原尺寸基准）\n";
        msg += "耗时: " + Math.round((new Date().getTime() - startTime) / 1000) + " 秒";
        if (warnings.length > 0) {
            msg += "\n\n警告 (" + warnings.length + "):\n";
            for (var w = 0; w < warnings.length; w++) msg += "- " + warnings[w] + "\n";
        }
        alert(msg);
    }

    var originalDialogs = app.displayDialogs;
    try {
        app.displayDialogs = DialogModes.NO;
        runExport();
    } catch (e) {
        alert("PS2UGUI: 导出失败\n" + e.message);
    } finally {
        app.activeDocument = doc;
        app.displayDialogs = originalDialogs;
    }
})();

// ============================================================================
// Figma2UGUI Plugin Core — code.ts
// Traverses Figma layer tree using prefix-based recognition,
// exports JSON + PNGs as ZIP for Unity PS2UGUI pipeline.
// ============================================================================

// Polyfill: Figma sandbox lacks setImmediate which JSZip requires
const sandbox = globalThis as typeof globalThis & {
  setImmediate?: (fn: (...args: unknown[]) => void, ...args: unknown[]) => number;
};
if (typeof sandbox.setImmediate === "undefined") {
  sandbox.setImmediate = (fn, ...args) => setTimeout(() => fn(...args), 0);
}

import JSZip from "jszip";

// ---------------------------------------------------------------------------
// Part 1: Type definitions and constants
// ---------------------------------------------------------------------------

interface PSCanvas {
  width: number;
  height: number;
}

interface PSLayer {
  id: number;
  name: string;
  groupPath: string;
  type: "text" | "image";
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  order: number;
  opacity: number;
  scaleX: number;
  scaleY: number;
  rotationZ: number;
  text?: string;
  fontSize?: number;
  fontColor?: string;
  fontName?: string;
  textAlignment?: string;
  wordWrap?: boolean;
  strokeColor?: string;
  strokeWidth?: number;
}

interface PSData {
  schemaVersion: 2;
  canvas: PSCanvas;
  layers: PSLayer[];
}

interface SpriteNode {
  layer: PSLayer;
  figmaNode: SceneNode;
  rasterScale: number;
  nestedSprites: SpriteNode[];
}

interface ExportedPng {
  fileName: string;
  bytes: Uint8Array;
}

interface LayerGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  rotationZ: number;
}

const VALID_PREFIXES = [
  "btn_", "img_", "icon_", "slider_", "sliderfill_", "bg_", "mask_", "tile_",
];

// ---------------------------------------------------------------------------
// Part 2: Plugin entry and UI communication
// ---------------------------------------------------------------------------

figma.showUI(__html__, { width: 360, height: 600 });

type UiMessage =
  | { type: "export"; padding: number }
  | { type: "png-padded"; requestId: number; bytes: Uint8Array }
  | { type: "png-padding-error"; requestId: number; error: string };

let nextPngRequest = 0;
const pendingPngs = new Map<number, {
  resolve: (bytes: Uint8Array) => void;
  reject: (error: Error) => void;
}>();

figma.ui.onmessage = (msg: UiMessage) => {
  if (msg.type === "export") {
    void runExport(msg.padding).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log(`导出失败：${message}`, "error");
      figma.ui.postMessage({ type: "error" });
    });
  } else if (msg.type === "png-padded" || msg.type === "png-padding-error") {
    const pending = pendingPngs.get(msg.requestId);
    if (!pending) throw new Error(`未知 PNG 留边请求: ${msg.requestId}`);
    pendingPngs.delete(msg.requestId);
    if (msg.type === "png-padded") pending.resolve(new Uint8Array(msg.bytes));
    else pending.reject(new Error(msg.error));
  }
};

function log(text: string, level: "info" | "error" | "success" = "info"): void {
  figma.ui.postMessage({ type: "log", text, level });
}

// ---------------------------------------------------------------------------
// Part 3: Prefix detection utilities
// ---------------------------------------------------------------------------

function hasValidPrefix(name: string): boolean {
  const stripped = stripScaleSuffix(name);
  const lastSlash = stripped.lastIndexOf("/");
  const baseName = lastSlash >= 0 ? stripped.substring(lastSlash + 1) : stripped;
  return VALID_PREFIXES.some((p) => baseName.startsWith(p));
}

function hasTintSuffix(name: string): boolean {
  const stripped = stripScaleSuffix(name);
  return /[$%@~]*~[$%@~]*$/.test(stripped);
}

function stripScaleSuffix(rawName: string): string {
  if (rawName.length === 0) return "";
  const lastCaret = rawName.lastIndexOf("^");
  if (lastCaret === -1) return rawName;
  return rawName.substring(0, lastCaret);
}

function getRasterScale(name: string): number {
  const lastCaret = name.lastIndexOf("^");
  if (lastCaret < 0) return 1;
  const suffix = name.substring(lastCaret + 1);
  const scale = Number(suffix);
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(suffix) || !Number.isFinite(scale) || scale <= 0) {
    throw new Error(`节点 PNG 倍率必须是正数，例如 img_logo^0.5: ${name}`);
  }
  return scale;
}

function stripAllSuffixes(rawName: string): string {
  let name = stripScaleSuffix(rawName);
  while (name.length > 0 && (name.endsWith("$") || name.endsWith("%") || name.endsWith("@") || name.endsWith("~"))) {
    name = name.substring(0, name.length - 1);
  }
  return name;
}

// ---------------------------------------------------------------------------
// Part 4: Frame selection
// ---------------------------------------------------------------------------

function getSelectedFrame(): FrameNode | null {
  const selection = figma.currentPage.selection;
  if (selection.length !== 1) {
    log("请选中一个顶层 Frame 作为画布", "error");
    return null;
  }
  const node = selection[0];
  if (node.type !== "FRAME") {
    log("选中的不是 Frame，请选择顶层 Frame", "error");
    return null;
  }
  return node as FrameNode;
}

// ---------------------------------------------------------------------------
// Part 5: Layer traversal (prefix-based)
// ---------------------------------------------------------------------------

/**
 * Recursively traverse the Figma tree collecting layers and sprite nodes.
 *
 * Node classification:
 * - TEXT → always export as text layer
 * - #prefix → skip entire subtree
 * - Has valid prefix → export as image layer; recurse children for nested
 * - No prefix + has children → transparent container, recurse
 * - No prefix + no children → skip (decoration, merged into parent PNG)
 */
async function traverseFrame(
  frame: FrameNode,
): Promise<{ layers: PSLayer[]; spriteTree: SpriteNode[] }> {
  const layers: PSLayer[] = [];
  const spriteTree: SpriteNode[] = [];
  const counter = { id: 0, order: 0 };
  const canvasX = frame.absoluteTransform[0][2];
  const canvasY = frame.absoluteTransform[1][2];
  const warnings = new Set<string>();

  await traverseChildren(
    frame,
    "",
    canvasX,
    canvasY,
    layers,
    spriteTree,
    counter,
    warnings,
  );

  for (const warning of warnings) {
    log(`[提示] ${warning}`);
  }

  return { layers, spriteTree };
}

async function traverseChildren(
  parent: SceneNode & ChildrenMixin,
  groupPath: string,
  canvasX: number,
  canvasY: number,
  layers: PSLayer[],
  spriteTree: SpriteNode[],
  counter: { id: number; order: number },
  warnings: Set<string>,
): Promise<void> {
  const children = parent.children;
  // Figma children are back-to-front: visit the topmost child first.
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];

    // Skip invisible
    if (!child.visible) continue;

    // [E] # prefix → skip entire subtree
    if (child.name.startsWith("#")) continue;

    // [TEXT] always export
    if (child.type === "TEXT") {
      const layerData = await extractLayerData(child, groupPath, canvasX, canvasY, counter, warnings);
      if (layerData) layers.push(layerData);
      continue;
    }

    // [A/B] Has valid prefix → sprite boundary
    if (hasValidPrefix(child.name)) {
      const layerData = await extractLayerData(child, groupPath, canvasX, canvasY, counter, warnings);
      if (!layerData) continue;
      layers.push(layerData);

      const spriteNode: SpriteNode = {
        layer: layerData,
        figmaNode: child,
        rasterScale: getRasterScale(child.name),
        nestedSprites: [],
      };

      // If has children, recurse to find nested prefixed nodes and TEXT
      if ("children" in child) {
        const childFrame = child as SceneNode & ChildrenMixin;
        const nestedGroupPath = groupPath === "" ? child.name : groupPath + "/" + child.name;
        await collectNestedContent(
          childFrame,
          nestedGroupPath,
          canvasX,
          canvasY,
          layers,
          spriteNode,
          counter,
          warnings,
        );
      }

      spriteTree.push(spriteNode);
      continue;
    }

    // [C] No prefix + has children → transparent container, recurse
    if ("children" in child) {
      const newPath = groupPath === "" ? child.name : groupPath + "/" + child.name;
      await traverseChildren(
        child as SceneNode & ChildrenMixin,
        newPath,
        canvasX,
        canvasY,
        layers,
        spriteTree,
        counter,
        warnings,
      );
      continue;
    }

    // [D] No prefix + no children → skip
  }
}

/**
 * Recursively collect nested content inside a prefixed node.
 * TEXT nodes and nested prefixed nodes are extracted; everything else is ignored
 * (they'll be rendered as part of the parent's PNG).
 */
async function collectNestedContent(
  parent: SceneNode & ChildrenMixin,
  groupPath: string,
  canvasX: number,
  canvasY: number,
  layers: PSLayer[],
  parentSprite: SpriteNode,
  counter: { id: number; order: number },
  warnings: Set<string>,
): Promise<void> {
  const children = parent.children;
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (!child.visible) continue;
    if (child.name.startsWith("#")) continue;

    if (child.type === "TEXT") {
      const layerData = await extractLayerData(child, groupPath, canvasX, canvasY, counter, warnings);
      if (layerData) {
        layers.push(layerData);
      }
      continue;
    }

    if (hasValidPrefix(child.name)) {
      const layerData = await extractLayerData(child, groupPath, canvasX, canvasY, counter, warnings);
      if (!layerData) continue;
      layers.push(layerData);

      const nestedSprite: SpriteNode = {
        layer: layerData,
        figmaNode: child,
        rasterScale: getRasterScale(child.name),
        nestedSprites: [],
      };

      if ("children" in child) {
        const childFrame = child as SceneNode & ChildrenMixin;
        const nestedPath = groupPath === "" ? child.name : groupPath + "/" + child.name;
        await collectNestedContent(childFrame, nestedPath, canvasX, canvasY, layers, nestedSprite, counter, warnings);
      }

      parentSprite.nestedSprites.push(nestedSprite);
      continue;
    }

    // Non-prefixed container inside a prefixed node → recurse deeper
    if ("children" in child) {
      const newPath = groupPath === "" ? child.name : groupPath + "/" + child.name;
      await collectNestedContent(
        child as SceneNode & ChildrenMixin,
        newPath,
        canvasX,
        canvasY,
        layers,
        parentSprite,
        counter,
        warnings,
      );
    }
    // Non-prefixed leaf → part of parent PNG, skip
  }
}

// ---------------------------------------------------------------------------
// Part 6: Layer data extraction
// ---------------------------------------------------------------------------

async function extractLayerData(
  node: SceneNode,
  groupPath: string,
  canvasX: number,
  canvasY: number,
  counter: { id: number; order: number },
  warnings: Set<string>,
): Promise<PSLayer | null> {
  const isText = node.type === "TEXT";
  if (!isText) getSpriteFileName(node.name);
  const geometry = isText ? getLayerGeometry(node, canvasX, canvasY) : getRasterGeometry(node, canvasX, canvasY);
  const opacity = getEffectiveOpacity(node);

  const data: PSLayer = {
    id: counter.id++,
    name: node.name,
    groupPath: groupPath,
    type: isText ? "text" : "image",
    x: geometry.x,
    y: geometry.y,
    width: geometry.width,
    height: geometry.height,
    visible: node.visible,
    order: counter.order++,
    opacity: opacity,
    scaleX: 1.0,
    scaleY: 1.0,
    rotationZ: geometry.rotationZ,
  };

  if (isText && node.type === "TEXT") {
    const textNode = node as TextNode;
    data.text = textNode.characters;

    const fs = textNode.fontSize;
    if (typeof fs === "number") {
      data.fontSize = fs;
    } else {
      const rangeFs =
        textNode.characters.length > 0 ? textNode.getRangeFontSize(0, 1) : 24;
      data.fontSize = typeof rangeFs === "number" ? rangeFs : 24;
    }
    const textScale = getTransformScale(node.absoluteTransform);
    data.fontSize = Math.round(data.fontSize * textScale.y * 10000) / 10000;
    data.wordWrap = textNode.textAutoResize !== "WIDTH_AND_HEIGHT";

    data.fontColor = getTextFillColor(textNode) ?? "#000000";

    const fontName = textNode.fontName;
    if (typeof fontName === "object" && "family" in fontName) {
      data.fontName = (fontName as FontName).family;
    } else {
      const rangeFontName =
        textNode.characters.length > 0 ? textNode.getRangeFontName(0, 1) : null;
      data.fontName =
        typeof rangeFontName === "object" && rangeFontName !== null && "family" in rangeFontName
          ? (rangeFontName as FontName).family
          : "";
    }

    const align = textNode.textAlignHorizontal;
    if (align === "LEFT") data.textAlignment = "left";
    else if (align === "CENTER") data.textAlignment = "center";
    else if (align === "RIGHT") data.textAlignment = "right";
    else data.textAlignment = "left";

    data.strokeColor = getTextStrokeColor(textNode) ?? undefined;
    const sw = textNode.strokeWeight;
    if (typeof sw === "number" && sw > 0) {
      data.strokeWidth = sw * textScale.y;
    }
  }

  if (!isText && hasTintSuffix(node.name)) {
    const color = getSolidFillColor(node) ?? ("children" in node ? findTintChildColor(node) : null);
    if (color) data.fontColor = color;
    else warnings.add(`Tint 无可读取的纯色色源，保留原图: ${node.name}`);
  }

  return data;
}

function getEffectiveOpacity(node: BaseNode): number {
  let opacity = 1;
  let current: BaseNode | null = node;
  while (current) {
    if ("opacity" in current) opacity *= (current as SceneNode & { opacity: number }).opacity;
    current = current.parent;
  }
  return Math.round(opacity * 100);
}

function getRasterGeometry(node: SceneNode, canvasX: number, canvasY: number): LayerGeometry {
  const bounds = "absoluteRenderBounds" in node ? node.absoluteRenderBounds : null;
  if (!bounds || bounds.width <= 0 || bounds.height <= 0)
    throw new Error(`图片没有可导出的渲染边界: ${node.name}`);
  return { x: bounds.x - canvasX, y: bounds.y - canvasY,
    width: bounds.width, height: bounds.height, rotationZ: 0 };
}

function normalizeDegrees(degrees: number): number {
  let value = degrees % 360;
  if (value > 180) value -= 360;
  if (value <= -180) value += 360;
  return Math.round(value * 10000) / 10000;
}

function getLayerGeometry(node: SceneNode, canvasX: number, canvasY: number): LayerGeometry {
  const transform = node.absoluteTransform;
  const scale = getTransformScale(transform);
  const width = Math.round(node.width * scale.x);
  const height = Math.round(node.height * scale.y);
  const center = transformPoint(transform, node.width / 2, node.height / 2);
  const rotation = getNodeRotationDegrees(node);

  return {
    x: Math.round(center.x - canvasX - width / 2),
    y: Math.round(center.y - canvasY - height / 2),
    width,
    height,
    rotationZ: normalizeDegrees(-rotation),
  };
}

function getTransformScale(transform: Transform): { x: number; y: number } {
  return { x: Math.hypot(transform[0][0], transform[1][0]),
    y: Math.hypot(transform[0][1], transform[1][1]) };
}

function getNodeRotationDegrees(node: SceneNode): number {
  const absoluteRotation = getRotationFromTransform(node.absoluteTransform);
  if (absoluteRotation !== null && Math.abs(absoluteRotation) > 0.0001) {
    return absoluteRotation;
  }
  const accumulatedRotation = getAccumulatedNodeRotation(node);
  if (accumulatedRotation !== null) {
    return accumulatedRotation;
  }
  return absoluteRotation ?? 0;
}

function getRotationFromTransform(transform: Transform): number | null {
  if (!transform || transform.length < 2 || transform[0].length < 2 || transform[1].length < 2) {
    return null;
  }
  const rotation = Math.atan2(transform[1][0], transform[0][0]) * 180 / Math.PI;
  return Number.isFinite(rotation) ? normalizeDegrees(rotation) : null;
}

type RotatableNode = BaseNode & { rotation: number; parent: BaseNode | null };

function hasRotationProperty(node: BaseNode | null): node is RotatableNode {
  return node !== null && "rotation" in node && typeof (node as RotatableNode).rotation === "number";
}

function getAccumulatedNodeRotation(node: BaseNode | null): number | null {
  let current = node;
  let totalRotation = 0;
  let hasRotation = false;
  while (current !== null) {
    if (hasRotationProperty(current)) {
      totalRotation += current.rotation;
      hasRotation = true;
    }
    current = current.parent;
  }
  return hasRotation ? normalizeDegrees(totalRotation) : null;
}

function transformPoint(transform: Transform, x: number, y: number): { x: number; y: number } {
  return {
    x: transform[0][0] * x + transform[0][1] * y + transform[0][2],
    y: transform[1][0] * x + transform[1][1] * y + transform[1][2],
  };
}

// ---------------------------------------------------------------------------
// Part 7: PNG Export
// ---------------------------------------------------------------------------

async function exportAllSprites(spriteTree: SpriteNode[], padding: number): Promise<ExportedPng[]> {
  const results: ExportedPng[] = [];
  for (const sprite of spriteTree) {
    const pngs = await exportSpriteNode(sprite, padding);
    results.push(...pngs);
  }
  return results;
}

async function exportSpriteNode(sprite: SpriteNode, padding: number): Promise<ExportedPng[]> {
  const results: ExportedPng[] = [];
  const node = sprite.figmaNode;

  // Isolate rendering in a fixed-size frame: native export must not recrop the
  // PNG when separately exported children are hidden or rotation is baked.
  if (!("clone" in node) || !("absoluteRenderBounds" in node))
    throw new Error(`不支持的图片节点: ${node.name}`);
  const bounds = node.absoluteRenderBounds!;
  const frame = figma.createFrame();
  try {
    frame.fills = [];
    frame.clipsContent = true;
    frame.resize(bounds.width, bounds.height);
    frame.x = bounds.x;
    frame.y = bounds.y;
    const copy = node.clone();
    frame.appendChild(copy);
    const transform = node.absoluteTransform;
    copy.relativeTransform = [[transform[0][0], transform[0][1], transform[0][2] - bounds.x],
      [transform[1][0], transform[1][1], transform[1][2] - bounds.y]];
    if ("opacity" in copy) copy.opacity = 1;
    if ("children" in copy) hideNestedExportables(copy, []);
    let bytes = await frame.exportAsync({ format: "PNG", contentsOnly: true, useAbsoluteBounds: true,
      constraint: { type: "SCALE", value: sprite.rasterScale } });
    const pixels = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = pixels.getUint32(16);
    const height = pixels.getUint32(20);
    const pixelPadding = padding > 0 ? Math.max(1, Math.round(padding * sprite.rasterScale)) : 0;
    if (pixelPadding > 0 || sprite.layer.fontColor) bytes = await padPng(bytes, pixelPadding, !!sprite.layer.fontColor);
    const paddingX = pixelPadding * sprite.layer.width / width;
    const paddingY = pixelPadding * sprite.layer.height / height;
    sprite.layer.x -= paddingX;
    sprite.layer.y -= paddingY;
    sprite.layer.width += paddingX * 2;
    sprite.layer.height += paddingY * 2;
    results.push({ fileName: getSpriteFileName(sprite.layer.name) + ".png", bytes });
  } finally {
    frame.remove();
  }

  // Recursively export nested sprite children
  for (const child of sprite.nestedSprites) {
    results.push(...await exportSpriteNode(child, padding));
  }

  return results;
}

function padPng(bytes: Uint8Array, padding: number, tint: boolean): Promise<Uint8Array> {
  const requestId = nextPngRequest++;
  return new Promise((resolve, reject) => {
    pendingPngs.set(requestId, { resolve, reject });
    figma.ui.postMessage({ type: "pad-png", requestId, bytes, padding, tint });
  });
}

/**
 * Recursively hide TEXT nodes and prefixed nodes within a parent.
 * Only hides direct-level matches and recurses into non-prefixed containers.
 */
function hideNestedExportables(
  parent: SceneNode & ChildrenMixin,
  hidden: { node: SceneNode; was: boolean }[],
): void {
  for (const child of parent.children) {
    if (child.type === "TEXT" && child.visible) {
      hidden.push({ node: child, was: true });
      (child as SceneNode & { visible: boolean }).visible = false;
    } else if (hasValidPrefix(child.name) && child.visible) {
      hidden.push({ node: child, was: true });
      (child as SceneNode & { visible: boolean }).visible = false;
    } else if ("children" in child && !hasValidPrefix(child.name) && !child.name.startsWith("#")) {
      // Recurse into non-prefixed containers to find deeper TEXT/prefixed nodes
      hideNestedExportables(child as SceneNode & ChildrenMixin, hidden);
    }
  }
}

function getSpriteFileName(layerName: string): string {
  const path = stripAllSuffixes(layerName);
  if (/[\\:*?"<>|]/.test(path) || path.split("/").some(part => !part || part === "." || part === ".."))
    throw new Error(`不能用作相对 PNG 路径: ${layerName}`);
  return path;
}

// ---------------------------------------------------------------------------
// Part 8: Color helper functions
// ---------------------------------------------------------------------------

function rgbToHex(color: RGB): string {
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  return "#" + padHex(r) + padHex(g) + padHex(b);
}

function padHex(n: number): string {
  const hex = n.toString(16).toUpperCase();
  return hex.length < 2 ? "0" + hex : hex;
}

function getTextFillColor(node: TextNode): string | null {
  const fills = getPaints(node);
  return fills ? getFirstVisibleSolidColor(fills) : null;
}

function getTextStrokeColor(node: TextNode): string | null {
  const strokes = node.strokes;
  if (!Array.isArray(strokes)) return null;
  return getFirstVisibleSolidColor(strokes);
}

function getSolidFillColor(node: SceneNode): string | null {
  const fills = getPaints(node);
  return fills ? getFirstVisibleSolidColor(fills) : null;
}

function getPaints(node: SceneNode): ReadonlyArray<Paint> | null {
  if (!("fills" in node)) return null;
  const fills = (node as GeometryMixin).fills;
  if (Array.isArray(fills)) return fills;
  if (node.type === "TEXT" && node.characters.length > 0) {
    try {
      const rangeFills = node.getRangeFills(0, 1);
      if (Array.isArray(rangeFills)) return rangeFills;
    } catch (_) { /* fall through */ }
  }
  return null;
}

function getFirstVisibleSolidColor(paints: ReadonlyArray<Paint>): string | null {
  for (const paint of paints) {
    if (paint.type === "SOLID" && paint.visible !== false) {
      return rgbToHex(paint.color);
    }
  }
  return null;
}

/**
 * Scan children for the first ~ suffixed node and return its solid fill color.
 */
function findTintChildColor(parent: SceneNode & ChildrenMixin): string | null {
  for (const child of parent.children) {
    if (!child.visible) continue;
    if (hasTintSuffix(child.name)) {
      return getSolidFillColor(child);
    }
    if ("children" in child && !hasValidPrefix(child.name)) {
      const color = findTintChildColor(child as SceneNode & ChildrenMixin);
      if (color) return color;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Part 9: Export main function
// ---------------------------------------------------------------------------

async function runExport(padding: number): Promise<void> {
  if (padding !== 0 && padding !== 1 && padding !== 2) throw new Error("透明留边只能选择无、1px 或 2px");
  const frame = getSelectedFrame();
  if (!frame) {
    figma.ui.postMessage({ type: "error" });
    return;
  }

  log(`画布: ${frame.name} (${Math.round(frame.width)}x${Math.round(frame.height)})`);
  log(`透明留边: ${padding}px；图片默认原尺寸，节点 ^N 单独缩图`);

  const { layers, spriteTree } = await traverseFrame(frame);
  log(`共收集 ${layers.length} 个图层（${spriteTree.length} 个 sprite）`);

  // Export PNGs
  log("正在导出 PNG...");
  const pngs = await exportAllSprites(spriteTree, padding);
  log(`共导出 ${pngs.length} 张 PNG`);

  // Build JSON
  const outputData: PSData = {
    schemaVersion: 2,
    canvas: {
      width: Math.round(frame.width),
      height: Math.round(frame.height),
    },
    layers: layers,
  };
  const jsonString = JSON.stringify(outputData, null, 2);
  const jsonFileName = frame.name + "_ui_data.json";

  log("正在打包 ZIP...");
  const zip = new JSZip();
  zip.file(jsonFileName, jsonString);
  for (const png of pngs) {
    zip.file(png.fileName, png.bytes);
  }

  const zipBytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  const zipFileName = frame.name + ".zip";

  figma.ui.postMessage({
    type: "save-zip",
    bytes: zipBytes,
    fileName: zipFileName,
  });

  log(`\n导出成功！文件: ${zipFileName}`, "success");
  log(`JSON: ${jsonFileName} | PNG: ${pngs.length} 张`, "success");
  figma.ui.postMessage({ type: "done" });
}

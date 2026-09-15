// ============================================================================
// Figma2UGUI Plugin Core — code.ts
// Traverses Figma layer tree using prefix-based recognition,
// exports JSON + PNGs as ZIP for Unity PS2UGUI pipeline.
// ============================================================================

// Polyfill: Figma sandbox lacks setImmediate which JSZip requires
if (typeof setImmediate === "undefined") {
  (globalThis as any).setImmediate = (fn: (...args: any[]) => void, ...args: any[]) => setTimeout(fn, 0, ...args);
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
  strokeColor?: string;
  strokeWidth?: number;
}

interface PSData {
  canvas: PSCanvas;
  layers: PSLayer[];
}

interface SpriteNode {
  layer: PSLayer;
  figmaNode: SceneNode;
  nestedSprites: SpriteNode[];
  nestedTexts: SceneNode[];
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

interface ScaleResult {
  x: number;
  y: number;
  warning?: string;
}

const VALID_PREFIXES = [
  "btn_", "img_", "icon_", "slider_", "sliderfill_", "bg_", "mask_", "tile_",
];

// ---------------------------------------------------------------------------
// Part 2: Plugin entry and UI communication
// ---------------------------------------------------------------------------

figma.showUI(__html__, { width: 320, height: 480 });

figma.ui.onmessage = (msg: { type: string; scale?: number }) => {
  if (msg.type === "export") {
    const scale = msg.scale ?? 1;
    void runExport(scale).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log(`导出失败：${message}`, "error");
      figma.ui.postMessage({ type: "error" });
    });
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
  return stripped.endsWith("~");
}

function stripScaleSuffix(rawName: string): string {
  if (rawName.length === 0) return "";
  const lastStar = rawName.lastIndexOf("*");
  if (lastStar === -1) return rawName;
  return rawName.substring(0, lastStar);
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
  // Reverse iterate: last child (bottom-most in Figma visual stack) first
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
        nestedSprites: [],
        nestedTexts: [],
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
        parentSprite.nestedTexts.push(child);
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
        nestedSprites: [],
        nestedTexts: [],
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
  const geometry = getLayerGeometry(node, canvasX, canvasY);
  const opacity = Math.round(("opacity" in node ? (node.opacity as number) : 1) * 100);

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

  const scale = await getNodeScale(node);
  data.scaleX = scale.x;
  data.scaleY = scale.y;
  if (scale.warning) {
    warnings.add(scale.warning);
  }

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
      data.strokeWidth = sw;
    }
  }

  if (!isText) {
    if (hasTintSuffix(node.name) && "fills" in node) {
      // Node itself has ~ — use its own color as tint
      const color = getSolidFillColor(node);
      if (color) data.fontColor = color;
    } else {
      // Check children for ~ suffixed nodes
      const tintColor = "children" in node ? findTintChildColor(node as SceneNode & ChildrenMixin) : null;
      if (tintColor) {
        data.fontColor = tintColor;
      } else if ("fills" in node) {
        const color = getSolidFillColor(node);
        if (color) data.fontColor = color;
      }
    }
  }

  return data;
}

function getLayerGeometry(node: SceneNode, canvasX: number, canvasY: number): LayerGeometry {
  const transform = node.absoluteTransform;
  const width = Math.round(node.width);
  const height = Math.round(node.height);
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

async function exportAllSprites(spriteTree: SpriteNode[], scale: number): Promise<ExportedPng[]> {
  const results: ExportedPng[] = [];
  for (const sprite of spriteTree) {
    const pngs = await exportSpriteNode(sprite, scale);
    results.push(...pngs);
  }
  return results;
}

async function exportSpriteNode(sprite: SpriteNode, scale: number): Promise<ExportedPng[]> {
  const results: ExportedPng[] = [];
  const node = sprite.figmaNode;

  // Collect nodes to hide: nested prefixed sprites + TEXT children
  const hidden: { node: SceneNode; was: boolean }[] = [];
  if ("children" in node) {
    hideNestedExportables(node as SceneNode & ChildrenMixin, hidden);
  }

  // Tint: whiten ~ nodes before export
  const whitened: { node: SceneNode; originalFills: Paint[] }[] = [];
  if (hasTintSuffix(sprite.layer.name)) {
    whitenSolidFills(node, whitened);
  } else if ("children" in node) {
    findAndWhitenTintChildren(node as SceneNode & ChildrenMixin, whitened);
  }

  // Export current node
  if ("exportAsync" in node) {
    try {
      const bytes = await (node as ExportMixin).exportAsync({
        format: "PNG",
        contentsOnly: true,
        constraint: { type: "SCALE", value: scale },
      });
      const fileName = getSpriteFileName(sprite.layer.name) + ".png";
      results.push({ fileName, bytes });
    } catch (e) {
      log(`[警告] 导出 ${sprite.layer.name} 失败: ${e}`, "error");
    }
  }

  // Restore whitened fills
  for (const w of whitened) {
    if ("fills" in w.node) {
      (w.node as GeometryMixin).fills = w.originalFills;
    }
  }

  // Restore hidden nodes
  for (const h of hidden) {
    (h.node as SceneNode & { visible: boolean }).visible = h.was;
  }

  // Recursively export nested sprite children
  for (const child of sprite.nestedSprites) {
    results.push(...await exportSpriteNode(child, scale));
  }

  return results;
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
    } else if (hasValidPrefix(child.name) && child.visible && !hasTintSuffix(child.name)) {
      hidden.push({ node: child, was: true });
      (child as SceneNode & { visible: boolean }).visible = false;
    } else if ("children" in child && !hasValidPrefix(child.name) && !child.name.startsWith("#")) {
      // Recurse into non-prefixed containers to find deeper TEXT/prefixed nodes
      hideNestedExportables(child as SceneNode & ChildrenMixin, hidden);
    }
  }
}

function getSpriteFileName(layerName: string): string {
  return stripAllSuffixes(layerName);
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
 * Whiten SOLID fills of a single node.
 */
function whitenSolidFills(
  node: SceneNode,
  records: { node: SceneNode; originalFills: Paint[] }[],
): void {
  if (!("fills" in node)) return;
  const fills = (node as GeometryMixin).fills;
  if (!Array.isArray(fills)) return;
  const hasSolid = fills.some((p: Paint) => p.type === "SOLID" && p.visible !== false);
  if (!hasSolid) return;
  records.push({ node, originalFills: [...fills] });
  (node as GeometryMixin).fills = fills.map((p: Paint) => {
    if (p.type === "SOLID" && p.visible !== false) {
      return { ...p, color: { r: 1, g: 1, b: 1 } } as SolidPaint;
    }
    return p;
  });
}

/**
 * Scan children for ~ suffixed nodes and whiten their SOLID fills.
 */
function findAndWhitenTintChildren(
  parent: SceneNode & ChildrenMixin,
  records: { node: SceneNode; originalFills: Paint[] }[],
): void {
  for (const child of parent.children) {
    if (!child.visible) continue;
    if (hasTintSuffix(child.name) && "fills" in child) {
      const fills = (child as GeometryMixin).fills;
      if (Array.isArray(fills)) {
        const hasSolid = fills.some((p: Paint) => p.type === "SOLID" && p.visible !== false);
        if (hasSolid) {
          records.push({ node: child, originalFills: [...fills] });
          (child as GeometryMixin).fills = fills.map((p: Paint) => {
            if (p.type === "SOLID" && p.visible !== false) {
              return { ...p, color: { r: 1, g: 1, b: 1 } } as SolidPaint;
            }
            return p;
          });
        }
      }
    } else if ("children" in child && !hasValidPrefix(child.name)) {
      findAndWhitenTintChildren(child as SceneNode & ChildrenMixin, records);
    }
  }
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

function getFirstVisibleImageFill(node: SceneNode): ImagePaint | null {
  const fills = getPaints(node);
  if (!fills) return null;
  for (const paint of fills) {
    if (paint.type === "IMAGE" && paint.visible !== false && paint.imageHash) {
      return paint;
    }
  }
  return null;
}

async function getNodeScale(node: SceneNode): Promise<ScaleResult> {
  const instanceScale = await getInstanceScale(node);
  if (instanceScale !== null) return instanceScale;
  const imageFillScale = await getImageFillScale(node);
  if (imageFillScale !== null) return imageFillScale;
  return { x: 1.0, y: 1.0 };
}

async function getInstanceScale(node: SceneNode): Promise<ScaleResult | null> {
  if (node.type !== "INSTANCE") return null;
  const mainComponent = await node.getMainComponentAsync();
  if (!mainComponent || mainComponent.width === 0 || mainComponent.height === 0) {
    return { x: 1.0, y: 1.0, warning: "部分实例节点无法读取主组件尺寸，scaleX/scaleY 已回退为 1.0" };
  }
  return {
    x: roundScale(node.width / mainComponent.width),
    y: roundScale(node.height / mainComponent.height),
  };
}

async function getImageFillScale(node: SceneNode): Promise<ScaleResult | null> {
  const imageFill = getFirstVisibleImageFill(node);
  if (!imageFill || imageFill.imageHash === null) return null;
  const image = figma.getImageByHash(imageFill.imageHash);
  if (image === null) {
    return { x: 1.0, y: 1.0, warning: "部分图片填充节点无法读取原图尺寸，scaleX/scaleY 已回退为 1.0" };
  }
  const imageSize = await image.getSizeAsync();
  if (imageSize.width === 0 || imageSize.height === 0) {
    return { x: 1.0, y: 1.0, warning: "部分图片填充节点无法读取原图尺寸，scaleX/scaleY 已回退为 1.0" };
  }

  const widthRatio = node.width / imageSize.width;
  const heightRatio = node.height / imageSize.height;

  if (imageFill.scaleMode === "FILL") {
    const s = Math.max(widthRatio, heightRatio);
    return { x: roundScale(s), y: roundScale(s) };
  }
  if (imageFill.scaleMode === "FIT") {
    const s = Math.min(widthRatio, heightRatio);
    return { x: roundScale(s), y: roundScale(s) };
  }
  if (imageFill.scaleMode === "TILE") {
    const tileScale =
      typeof imageFill.scalingFactor === "number" && imageFill.scalingFactor > 0
        ? imageFill.scalingFactor : 1.0;
    return { x: roundScale(tileScale), y: roundScale(tileScale) };
  }
  if (imageFill.scaleMode === "CROP") {
    return getCropImageScale(node, imageSize, imageFill);
  }
  return { x: 1.0, y: 1.0 };
}

function getCropImageScale(
  node: SceneNode,
  imageSize: { width: number; height: number },
  imageFill: ImagePaint,
): ScaleResult {
  const transform = imageFill.imageTransform;
  if (!transform) {
    return { x: 1.0, y: 1.0, warning: "部分 CROP 图片填充缺少 imageTransform，scaleX/scaleY 已回退为 1.0" };
  }
  const normalizedScaleX = Math.hypot(transform[0][0], transform[1][0]);
  const normalizedScaleY = Math.hypot(transform[0][1], transform[1][1]);
  if (normalizedScaleX <= 0 || normalizedScaleY <= 0) {
    return { x: 1.0, y: 1.0, warning: "部分 CROP 图片填充缺少 imageTransform，scaleX/scaleY 已回退为 1.0" };
  }
  return {
    x: roundScale((node.width * normalizedScaleX) / imageSize.width),
    y: roundScale((node.height * normalizedScaleY) / imageSize.height),
    warning: "CROP 图片填充的 scaleX/scaleY 按 imageTransform 近似计算",
  };
}

function roundScale(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function normalizeDegrees(value: number): number {
  let normalized = value % 360;
  if (normalized > 180) normalized -= 360;
  if (normalized <= -180) normalized += 360;
  return Math.round(normalized * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Part 9: Export main function
// ---------------------------------------------------------------------------

async function runExport(exportScale: number): Promise<void> {
  const frame = getSelectedFrame();
  if (!frame) {
    figma.ui.postMessage({ type: "error" });
    return;
  }

  log(`画布: ${frame.name} (${Math.round(frame.width)}x${Math.round(frame.height)})`);
  log(`导出倍率: ${exportScale}x`);

  const { layers, spriteTree } = await traverseFrame(frame);
  log(`共收集 ${layers.length} 个图层（${spriteTree.length} 个 sprite）`);

  // Export PNGs
  log("正在导出 PNG...");
  const pngs = await exportAllSprites(spriteTree, exportScale);
  log(`共导出 ${pngs.length} 张 PNG`);

  // Build JSON
  const outputData: PSData = {
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
    bytes: Array.from(zipBytes),
    fileName: zipFileName,
  });

  log(`\n导出成功！文件: ${zipFileName}`, "success");
  log(`JSON: ${jsonFileName} | PNG: ${pngs.length} 张`, "success");
  figma.ui.postMessage({ type: "done" });
}

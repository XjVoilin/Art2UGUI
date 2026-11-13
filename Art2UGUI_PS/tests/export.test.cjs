// Photoshop host contract tests. No Photoshop rendering is simulated.
// Run from the repository root: node --test Art2UGUI_PS/tests/export.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../PS2UGUI_Export.jsx'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const unit = value => ({ as: () => value });
const rgb = (red, grain, blue) => ({ red, grain, blue });
let nextId = 1;
function image(name, extra = {}) {
  return { id: nextId++, name, typename: 'ArtLayer', kind: 'NORMAL', visible: true,
    opacity: 100, rect: [10, 20, 110, 70], descriptor: {}, ...extra };
}
function text(name, justification = 'LEFT', contents = '内容') {
  return image(name, { kind: 'TEXT', descriptor: { textKey: {} }, text: { kind: 'POINTTEXT', contents, justification, font: 'Inter',
    size: 12, color: { rgb: { red: 17, green: 34, blue: 51 } } } });
}
function group(name, children, extra = {}) {
  return image(name, { typename: 'LayerSet', children, ...extra });
}
function shape(name, color, extra = {}) {
  return image(name, { kind: 'SOLIDFILL', descriptor: { adjustment: [{ color }] }, ...extra });
}

test('ordinary colored PNG uses white Unity tint and applies layer opacity only through JSON', () => {
  const result = run([shape('img_gray', rgb(128, 128, 128), { opacity: 50 })]);
  assert.equal(result.data.layers[0].fontColor, undefined);
  assert.equal(result.data.layers[0].opacity, 50);
  assert.equal(result.pngs.get('/design/Screen/img_gray.png').layer.opacity, 100);
});

test('child JSON opacity includes ancestors while its own PNG is normalized', () => {
  const result = run([group('Container', [shape('img_gray', rgb(128, 128, 128), { opacity: 50 })], { opacity: 50 })]);
  assert.equal(result.data.layers[0].opacity, 25);
  assert.equal(result.pngs.get('/design/Screen/img_gray.png').layer.opacity, 100);
});

test('PNG is composited before cropping, resizing, and padding live layers', () => {
  const result = run([group('img_styled^0.5', [image('decoration')])], { padding: 1 });
  const rendered = result.pngs.get('/design/Screen/img_styled.png').layer;
  assert.equal(rendered.typename, 'ArtLayer', 'live group effects must be baked before geometry changes');
  assert.equal(rendered.kind, 'NORMAL');
});

test('fixed canvas centers a smaller image without enlarging it and keeps the design center', () => {
  const result = run([image('img_coin[240x240]'), text('Caption[240x240]')], { padding: 1 });
  const png = result.pngs.get('/design/Screen/img_coin.png');
  assert.deepEqual(png.size, [240, 240]);
  assert.deepEqual(png.contentSize, [100, 50]);
  const layer = result.data.layers[0];
  assert.deepEqual([layer.x, layer.y, layer.width, layer.height], [-60, -75, 240, 240]);
  assert.equal(layer.fixedCanvas, true);
  assert.equal(layer.name, 'img_coin[240x240]');
  assert.equal(result.data.layers[1].fixedCanvas, undefined);
});

test('fixed canvas shrinks oversized content proportionally and includes padding inside its dimensions', () => {
  const result = run([image('img_coin[240x240]', { rect: [10, 20, 490, 260] })], { padding: 1 });
  const png = result.pngs.get('/design/Screen/img_coin.png');
  assert.deepEqual(png.size, [240, 240]);
  assert.deepEqual(png.contentSize, [238, 119]);
  const layer = result.data.layers[0];
  assert.deepEqual([layer.x, layer.y, layer.width, layer.height], [130, 20, 240, 240]);
});

test('fixed canvas composes with tint, slicing and raster scale without changing the slot layout', () => {
  for (const name of ['UI/img_coin%~[240x240]^0.5', 'UI/img_coin[240x240]%~^0.5']) {
    const result = run([shape(name, rgb(20, 40, 60))], { padding: 2 });
    const png = result.pngs.get('/design/Screen/UI/img_coin.png');
    assert.deepEqual(png.size, [120, 120]);
    assert.deepEqual(png.contentSize, [50, 25]);
    assert.equal(result.data.layers[0].fontColor, '#14283C');
    assert.equal(result.data.layers[0].width, 240);
    assert.equal(result.data.layers[0].scaleX, 1);
  }
});

test('invalid fixed sizes fail before writing export files', () => {
  for (const suffix of ['[0x240]', '[2.5x240]', '[240x]', '[240x240][120x120]', '[1x1]']) {
    const result = run([image('img_coin' + suffix)], { padding: 1 });
    assert.equal(result.files.size, 0);
    assert.equal(result.temps.length, 0);
    assert.match(result.alerts.at(-1), /固定画布/);
  }
});

test('ordinary bracket labels remain in PNG names, including before a fixed-size suffix', () => {
  const literal = run([image('img_prop[rare]')]);
  assert.ok(literal.pngs.has('/design/Screen/img_prop[rare].png'));
  assert.equal(literal.data.layers[0].fixedCanvas, undefined);
  const fixed = run([image('img_prop[rare][240x240]')]);
  assert.deepEqual(fixed.pngs.get('/design/Screen/img_prop[rare].png').size, [240, 240]);
});

function run(children, options = {}) {
  // Existing Figma-parity checks explicitly select no padding.
  options = { padding: 0, ...options };
  const alerts = [], files = new Map(), pngs = new Map(), temps = [], openedFolders = [];
  const folders = new Set(['/', '/design']);
  const aliases = { 'Rd  ': 'red', 'Grn ': 'grain', 'Bl  ': 'blue', 'Clr ': 'color',
    'Lefx': 'layerEffects', 'Opct': 'opacity' };
  const key = name => aliases[name] || name;
  class Descriptor {
    constructor(data = {}) { this.data = data; }
    hasKey(name) { return Object.hasOwn(this.data, key(name)); }
    value(name) {
      if (!this.hasKey(name)) throw new Error('Missing descriptor: ' + name);
      return this.data[key(name)];
    }
    getObjectValue(name) { return new Descriptor(this.value(name)); }
    getList(name) {
      const values = this.value(name);
      return { count: values.length, getDouble: i => values[i], getObjectValue: i => new Descriptor(values[i]) };
    }
    getBoolean(name) { return this.value(name); }
    getDouble(name) { return this.value(name); }
    getUnitDoubleValue(name) { return this.value(name); }
    putObject(name, type, value) { this.data[key(name)] = value.data; }
    putBoolean(name, value) { this.data[key(name)] = value; }
    putDouble(name, value) { this.data[key(name)] = value; }
    putUnitDouble(name, type, value) { this.data[key(name)] = value; }
    putEnumerated(name, type, value) { this.data[key(name)] = value; }
    putReference(name, value) { this.data[key(name)] = value; }
  }
  class Reference {
    putIdentifier(type, id) { this.id = id; }
    putProperty() {}
  }
  function find(parent, id) {
    for (const layer of parent.layers) {
      if (layer.id === id) return layer;
      if (layer.layers) { const found = find(layer, id); if (found) return found; }
    }
  }
  function materialize(spec, owner, original) {
    const layer = { ...clone(spec), bounds: spec.rect.map(n => unit(n)) };
    if (spec.text) layer.textItem = { ...spec.text, size: unit(spec.text.size, 'pt') };
    if (spec.children) {
      layer.layers = spec.children.map(child => materialize(child, owner, original));
      for (const child of layer.layers) Object.defineProperty(child, 'parent', { value: layer });
    }
    layer.duplicate = target => {
      const copy = materialize(spec, target, false);
      target.layers.unshift(copy);
      target.activeLayer = copy;
      if (options.failDuplicate) throw new Error('duplicate failed');
      return copy;
    };
    layer.remove = () => {
      assert.equal(original, false, 'must not remove original layers');
      owner.layers.splice(owner.layers.indexOf(layer), 1);
    };
    if (original) {
      Object.defineProperty(layer, 'visible', { get: () => spec.visible,
        set: () => { throw new Error('mutated original visibility'); } });
    }
    return layer;
  }
  const doc = { name: 'Screen.psd', width: unit(options.canvasWidth || 800),
    height: unit(options.canvasHeight || 600), resolution: options.resolution || 72 };
  if (options.unsaved) Object.defineProperty(doc, 'path', { get() { throw new Error('not saved'); } });
  else doc.path = '/design';
  doc.layers = children.map(child => materialize(child, doc, true));
  doc.activeLayer = doc.layers[0];
  const initialSelection = doc.activeLayer;
  const app = { activeDocument: doc, documents: options.noDocument ? [] : [doc], displayDialogs: 'ALL' };
  function makeTemp(spec) {
    const temp = { layers: [], closed: false, crop(bounds) {
        assert.equal(this.layers[0].typename, 'ArtLayer', 'crop must operate on composited pixels');
        assert.equal(this.layers[0].kind, 'NORMAL');
        this.cropBounds = Array.from(bounds, x => x.value);
        this.size = [this.cropBounds[2] - this.cropBounds[0], this.cropBounds[3] - this.cropBounds[1]];
      },
      duplicate(name, mergedOnly) {
        assert.equal(mergedOnly, true, 'measurement must composite the temporary document');
        const layer = this.layers[0];
        const flattened = { ...clone(layer), typename: 'ArtLayer', kind: 'NORMAL',
          rect: layer.renderRect || layer.rect, descriptor: {}, bakedEffects: layer.descriptor.layerEffects,
          renderedLayers: layer.layers ? clone(layer.layers) : undefined };
        delete flattened.children; delete flattened.layers;
        const measurement = makeTemp(flattened);
        app.activeDocument = measurement;
        return measurement;
      },
      resizeImage(width, height) { this.size = [width.value, height.value]; },
      resizeCanvas(width, height, anchor) {
        assert.equal(anchor, 'MIDDLECENTER');
        this.contentSize = [...this.size];
        this.size = [width.value, height.value];
      },
      saveAs(file) {
        if (options.failSave) throw new Error('disk full');
        pngs.set(file.path, { layer: clone(this.layers[0]), crop: this.cropBounds, size: this.size, contentSize: this.contentSize });
      },
      close() { this.closed = true; app.documents.splice(app.documents.indexOf(this), 1); }
    };
    const blank = materialize(spec || image('blank'), temp, false);
    temp.layers.push(blank);
    temp.activeLayer = blank;
    temps.push(temp);
    app.documents.push(temp);
    app.activeDocument = temp;
    return temp;
  }
  app.documents.add = () => makeTemp();
  class Folder {
    constructor(folderPath) { this.fsName = String(folderPath); }
    get exists() { return folders.has(this.fsName); }
    get parent() { return new Folder(path.posix.dirname(this.fsName)); }
    create() { folders.add(this.fsName); return true; }
    execute() {
      assert.ok(files.has('/design/Screen/Screen_ui_data.json'), 'open output only after JSON is written');
      if (options.throwOpenFolder) throw new Error('file browser unavailable');
      if (options.failOpenFolder) return false;
      openedFolders.push(this.fsName);
      return true;
    }
    toString() { return this.fsName; }
  }
  class File {
    constructor(filePath) { this.path = filePath; this.error = 'write rejected'; }
    open() { return !options.failJsonOpen; }
    write(content) { if (options.failJsonWrite) return false; files.set(this.path, content); return true; }
    close() { this.closed = true; }
  }
  class Window {
    add(type, bounds, items) {
      if (type === 'dropdownlist') {
        let selected;
        return { set selection(value) { selected = value; }, get selection() {
          return { index: options.padding === undefined ? selected : options.padding };
        } };
      }
      return this;
    }
    show() { return options.cancel ? 0 : 1; }
  }
  const context = vm.createContext({ app, alert: message => alerts.push(message), File, Folder, Window,
    UnitValue: function(value) { this.value = value; },
    LayerKind: { TEXT: 'TEXT', SMARTOBJECT: 'SMARTOBJECT', SOLIDFILL: 'SOLIDFILL' },
    TextType: { POINTTEXT: 'POINTTEXT', PARAGRAPHTEXT: 'PARAGRAPHTEXT' },
    Justification: Object.fromEntries(['LEFT', 'LEFTJUSTIFIED', 'CENTER', 'CENTERJUSTIFIED', 'RIGHT',
      'RIGHTJUSTIFIED', 'FULLYJUSTIFIED'].map(x => [x, x])),
    NewDocumentMode: { RGB: 'RGB' }, DocumentFill: { TRANSPARENT: 'TRANSPARENT' },
    ElementPlacement: { PLACEATBEGINNING: 'PLACEATBEGINNING' }, ResampleMethod: { BICUBIC: 'BICUBIC' },
    SaveOptions: { DONOTSAVECHANGES: 'DONOTSAVECHANGES' }, Extension: { LOWERCASE: 'LOWERCASE' },
    AnchorPosition: { MIDDLECENTER: 'MIDDLECENTER' },
    DialogModes: { NO: 'NO' }, PNGSaveOptions: function() {},
    ActionReference: Reference, ActionDescriptor: Descriptor, charIDToTypeID: x => x, stringIDToTypeID: x => x,
    executeActionGet: ref => new Descriptor(clone(find(app.activeDocument, ref.id).descriptor)),
    executeAction(type, descriptor) {
      assert.notEqual(app.activeDocument, doc, 'effects must only change in a temporary document');
      if (options.failTint) throw new Error('tint failed');
      const target = find(app.activeDocument, descriptor.data.null.id);
      target.descriptor.layerEffects = clone(descriptor.data['T   ']);
    }
  });
  vm.runInContext(source, context);
  assert.equal(app.activeDocument, doc);
  assert.equal(doc.activeLayer, initialSelection);
  assert.equal(app.displayDialogs, 'ALL');
  assert.ok(temps.every(temp => temp.closed), 'all temporary documents must be closed');
  const json = files.get('/design/Screen/Screen_ui_data.json');
  return { data: json && JSON.parse(json), alerts, files, pngs, folders, doc, temps, openedFolders };
}

test('mixed stack traversal extracts nested sprites/text and skips hidden/ignored subtrees', () => {
  const result = run([
    text('Top'),
    group('btn_ok', [text('Caption'), group('Layout', [image('icons/icon_star~^0.5'), image('decoration')])]),
    group('Container', [image('img_bottom')]),
    group('Hidden', [text('Must not appear')], { visible: false }),
    group('#Ignore', [image('img_ignore')]),
    image('img_hidden', { visible: false })
  ]);
  assert.deepEqual(result.data.layers.map(x => [x.name, x.groupPath, x.id, x.order]), [
    ['Top', '', 0, 0], ['btn_ok', '', 1, 1], ['Caption', 'btn_ok', 2, 2],
    ['icons/icon_star~^0.5', 'btn_ok/Layout', 3, 3], ['img_bottom', 'Container', 4, 4]
  ]);
  assert.deepEqual([...result.pngs.keys()], ['/design/Screen/btn_ok.png',
    '/design/Screen/icons/icon_star.png', '/design/Screen/img_bottom.png']);
  assert.deepEqual(result.openedFolders, ['/design/Screen']);
});

test('parent PNG separates text and all nested sprites including tint nodes', () => {
  const result = run([group('btn_ok^3', [text('caption'), image('icon_child'),
    group('Layout', [text('deepText'), image('bg_child'), image('decoration')]),
    shape('img_tint~', rgb(12, 34, 56)), image('hiddenDecoration', { visible: false })])]);
  const png = result.pngs.get('/design/Screen/btn_ok.png');
  assert.deepEqual(png.crop, [10, 20, 110, 70]);
  assert.deepEqual(png.size, [300, 150]);
  const children = png.layer.renderedLayers;
  assert.equal(children[0].visible, false);
  assert.equal(children[1].visible, false);
  assert.deepEqual(children[2].layers.map(x => x.visible), [false, false, true]);
  assert.equal(children[3].visible, false);
  assert.equal(children[4].visible, false);
  assert.equal(result.data.layers[0].fontColor, undefined);
  assert.deepEqual(result.data.canvas, { width: 800, height: 600 });
});

test('tint whitening preserves other effects and never changes the source descriptor', () => {
  const spec = shape('img_tint~', rgb(20, 40, 60), { descriptor: {
    adjustment: [{ color: rgb(20, 40, 60) }],
    layerEffects: { dropShadow: { enabled: true, size: 8 }, frameFX: { enabled: true, size: 2 } }
  } });
  const result = run([spec]);
  const effects = result.pngs.get('/design/Screen/img_tint.png').layer.descriptor.layerEffects;
  const baked = result.pngs.get('/design/Screen/img_tint.png').layer.bakedEffects;
  assert.deepEqual(baked.dropShadow, { enabled: true, size: 8 });
  assert.deepEqual(baked.frameFX, { enabled: true, size: 2 });
  assert.deepEqual(effects.solidFill.color, rgb(255, 255, 255));
  assert.equal(result.data.layers[0].fontColor, '#14283C');
  assert.deepEqual(result.doc.layers[0].descriptor, spec.descriptor);
});

test('explicit parent tint can read the first nested tint color', () => {
  const result = run([group('img_parent~', [shape('top~', rgb(255, 0, 0)), shape('bottom~', rgb(0, 0, 255))])]);
  assert.equal(result.data.layers[0].fontColor, '#0000FF');
});

test('adjustment-layer group exports its rendered bounds instead of the 1080x1920 canvas', () => {
  const result = run([group('img_Copy', [
    image('Brightness', { kind: 'BRIGHTNESSCONTRAST', rect: [0, 0, 1080, 1920] }),
    image('Pixels', { rect: [21, 527, 221, 727] })
  ], { rect: [0, 0, 1080, 1920], renderRect: [21, 527, 221, 727] })],
    { canvasWidth: 1080, canvasHeight: 1920 });
  const layer = result.data.layers[0];
  assert.deepEqual([layer.x, layer.y, layer.width, layer.height], [21, 527, 200, 200]);
  assert.deepEqual(result.pngs.get('/design/Screen/img_Copy.png').size, [200, 200]);
  assert.deepEqual(result.data.canvas, { width: 1080, height: 1920 });
});

test('transparent padding expands image rectangles while preserving visible placement and text geometry', () => {
  for (const padding of [1, 2]) {
    const result = run([image('img_test^2'), text('Caption')], { padding });
    const layer = result.data.layers[0];
    assert.deepEqual([layer.x, layer.y, layer.width, layer.height],
      [10 - padding, 20 - padding, 100 + 2 * padding, 50 + 2 * padding]);
    assert.equal(layer.x + padding, 10);
    assert.equal(layer.y + padding, 20);
    assert.deepEqual(result.pngs.get('/design/Screen/img_test.png').size,
      [(100 + 2 * padding) * 2, (50 + 2 * padding) * 2]);
    const caption = result.data.layers[1];
    assert.deepEqual([caption.x, caption.y, caption.width, caption.height], [10, 20, 100, 50]);
  }
});

test('padding uses the corrected rendered group rectangle, including at the document edge', () => {
  const result = run([group('img_edge', [image('Pixels')], {
    rect: [0, 0, 1080, 1920], renderRect: [0, 0, 200, 200]
  })], { padding: 1 });
  const layer = result.data.layers[0];
  assert.deepEqual([layer.x, layer.y, layer.width, layer.height], [-1, -1, 202, 202]);
  assert.deepEqual(result.pngs.get('/design/Screen/img_edge.png').crop, [0, 0, 200, 200]);
  assert.deepEqual(result.pngs.get('/design/Screen/img_edge.png').size, [202, 202]);
});

test('smart object exports its rendered rectangle with baked rotation and scale', () => {
  const result = run([image('img_smart', { kind: 'SMARTOBJECT', rect: [80, 100, 100, 200], descriptor: {
    smartObjectMore: { transform: [100, 100, 100, 200, 80, 200, 80, 100], size: { width: 200, height: 40 } }
  } })]);
  const layer = result.data.layers[0];
  assert.deepEqual([layer.x, layer.y, layer.width, layer.height, layer.rotationZ, layer.scaleX, layer.scaleY],
    [80, 100, 20, 100, 0, 1, 1]);
});

test('text preserves alignment, content/control characters, color and resolution-adjusted size', () => {
  const result = run([text('Left', 'LEFT', 'a\n"b"\t\u0001\b\f'), text('Center', 'CENTERJUSTIFIED'),
    text('Right', 'RIGHTJUSTIFIED')], { resolution: 144 });
  assert.deepEqual(result.data.layers.map(x => x.textAlignment), ['left', 'center', 'right']);
  assert.equal(result.data.layers[0].text, 'a\n"b"\t\u0001\b\f');
  assert.equal(result.data.layers[0].fontSize, 24);
  assert.equal(result.data.layers[0].fontColor, '#112233');
  assert.equal(result.pngs.size, 0);
});

test('text font size includes the Photoshop text transform exactly once', () => {
  const shopping = text('购物喽');
  shopping.text.size = 50.0800704956055;
  shopping.descriptor = { textKey: { transform: { xx: 2.09667003505768, xy: 0, yx: 0, yy: 2.09664231989874 } } };
  const rotated = text('Rotated');
  rotated.descriptor = { textKey: { transform: { xx: 0, xy: 2, yx: -2, yy: 0 } } };
  const result = run([shopping, rotated]);
  assert.equal(result.data.layers[0].fontSize, 105);
  assert.equal(result.data.layers[0].wordWrap, false, 'Photoshop point text must stay on one line');
  assert.equal(result.data.layers[1].fontSize, 24, 'use the axis length, including when yy is zero');
  assert.equal(result.data.layers[0].scaleY, 1, 'baked font size must not apply the transform twice');
  assert.equal(shopping.text.size, 50.0800704956055, 'source text is unchanged');
  assert.equal(run([rotated], { resolution: 144 }).data.layers[0].fontSize, 48);
  const paragraph = text('Paragraph'); paragraph.text.kind = 'PARAGRAPHTEXT';
  assert.equal(run([paragraph]).data.layers[0].wordWrap, true);
});

for (const [name, option] of [['save', 'failSave'], ['duplicate', 'failDuplicate'], ['tint', 'failTint']]) {
  test(`${name} failure closes temporary documents and reports zero successful PNGs`, () => {
    const result = run([shape('img_test~', rgb(20, 40, 60))], { [option]: true });
    assert.equal(result.pngs.size, 0);
    assert.match(result.alerts.at(-1), /导出部分完成/);
    assert.match(result.alerts.at(-1), /PNG 成功\/计划: 0\/1/);
    assert.deepEqual(result.openedFolders, ['/design/Screen']);
  });
}

test('cancel, no document and unsaved document exit without filesystem writes', () => {
  for (const options of [{ cancel: true }, { noDocument: true }, { unsaved: true }]) {
    const result = run([], options);
    assert.equal(result.files.size, 0);
    assert.equal(result.temps.length, 0);
    assert.deepEqual(result.openedFolders, []);
  }
});

test('relative sprite paths cannot escape the export directory', () => {
  const result = run([image('../img_escape')]);
  assert.equal(result.files.size, 0);
  assert.equal(result.temps.length, 0);
  assert.match(result.alerts.at(-1), /不能用作相对 PNG 路径/);
});

test('recursive sprite folders and suffix stripping match the Figma naming contract', () => {
  const result = run([image('UI/Buttons/btn_ok$%@^0.5')]);
  assert.ok(result.folders.has('/design/Screen/UI/Buttons'));
  assert.ok(result.pngs.has('/design/Screen/UI/Buttons/btn_ok.png'));
  assert.equal(result.data.layers[0].name, 'UI/Buttons/btn_ok$%@^0.5');
  assert.equal(result.data.layers[0].scaleX, 1, 'raster reduction must not change the layout transform');
  assert.deepEqual(result.pngs.get('/design/Screen/UI/Buttons/btn_ok.png').size, [50, 25]);
});

test('node ^0.5 downsamples PNG while preserving JSON layout and source transform', () => {
  const result = run([image('img_logo^0.5'), text('Caption^0.5')]);
  const layer = result.data.layers[0];
  assert.deepEqual(result.pngs.get('/design/Screen/img_logo.png').size, [50, 25]);
  assert.deepEqual([layer.x, layer.y, layer.width, layer.height, layer.scaleX, layer.scaleY], [10, 20, 100, 50, 1, 1]);
  assert.equal(layer.name, 'img_logo^0.5');
  assert.equal(result.data.layers[1].fontSize, 12);
});

test('node raster scale applies only to the named sprite and does not inherit into children', () => {
  const result = run([group('img_parent^0.5', [image('img_child')])]);
  assert.deepEqual(result.pngs.get('/design/Screen/img_parent.png').size, [50, 25]);
  assert.deepEqual(result.pngs.get('/design/Screen/img_child.png').size, [100, 50]);
});

test('downsampling retains an integer transparent border and compensates JSON layout', () => {
  const result = run([image('img_logo~^0.5')], { padding: 1 });
  const layer = result.data.layers[0];
  assert.deepEqual(result.pngs.get('/design/Screen/img_logo.png').size, [52, 27]);
  assert.deepEqual([layer.x, layer.y, layer.width, layer.height], [8, 18, 104, 54]);
  assert.equal(layer.width * 50 / 52, 100);
  assert.equal(layer.height * 25 / 27, 50);
  const tiny = run([image('img_tiny^0.001')]);
  assert.deepEqual(tiny.pngs.get('/design/Screen/img_tiny.png').size, [1, 1]);
});

test('invalid node raster scales fail before any export file is created', () => {
  for (const suffix of ['0', '-0.5', '0.5junk', '', 'NaN']) {
    const result = run([image('img_bad^' + suffix)]);
    assert.equal(result.files.size, 0);
    assert.equal(result.pngs.size, 0);
    assert.match(result.alerts.at(-1), /节点 PNG 倍率必须是正数/);
  }
});

test('legacy star marker is no longer parsed as a PNG multiplier', () => {
  const result = run([image('img_legacy*0.5')]);
  assert.equal(result.files.size, 0);
  assert.match(result.alerts.at(-1), /不能用作相对 PNG 路径/);
});

test('JSON write failure is reported as failure', () => {
  for (const options of [{ failJsonOpen: true }, { failJsonWrite: true }]) {
    const result = run([text('Text')], options);
    assert.match(result.alerts.at(-1), /导出失败/);
    assert.equal(result.data, undefined);
    assert.deepEqual(result.openedFolders, []);
  }
});

test('file-browser failure preserves successful export and reports the output path', () => {
  for (const options of [{ failOpenFolder: true }, { throwOpenFolder: true }]) {
    const result = run([text('Text')], options);
    assert.ok(result.data);
    assert.match(result.alerts.at(-1), /导出完成！/);
    assert.match(result.alerts.at(-1), /无法自动打开输出目录，请手动打开: \/design\/Screen/);
  }
});

test('baked smart-object export does not depend on optional transform metadata', () => {
  const result = run([image('img_broken', { kind: 'SMARTOBJECT' })]);
  assert.equal(result.data.layers[0].scaleX, 1);
  assert.equal(result.data.layers[0].rotationZ, 0);
  assert.match(result.alerts.at(-1), /导出完成/);
});

test('same visual stack produces the same JSON as the actual Figma traversal', async () => {
  const esbuild = require('../../Art2UGUI_Figma/node_modules/esbuild');
  const ts = fs.readFileSync(path.join(__dirname, '../../Art2UGUI_Figma/src/code.ts'), 'utf8');
  const code = esbuild.transformSync(ts.replace('import JSZip from "jszip";', ''), { loader: 'ts' }).code;
  const specs = [text('Title', 'RIGHT'), group('btn_ok', [text('caption'),
    group('Layout', [shape('icon_star~^0.5', rgb(20, 40, 60)), image('decoration')])]),
    group('Container', [image('UI/img_footer')]), image('img_hidden', { visible: false }),
    group('#ignored', [text('ignored')])];
  function toFigma(spec, parent = null) {
    const [x, y, right, bottom] = spec.rect;
    const node = { name: spec.name, type: spec.children ? 'GROUP' : spec.kind === 'TEXT' ? 'TEXT' : 'RECTANGLE',
      visible: spec.visible, opacity: spec.opacity / 100, width: right - x, height: bottom - y,
      absoluteTransform: [[1, 0, x], [0, 1, y]], rotation: 0, parent, fills: [] };
    node.absoluteRenderBounds = { x, y, width: right - x, height: bottom - y };
    if (spec.kind === 'SOLIDFILL') {
      const color = spec.descriptor.adjustment[0].color;
      node.fills = [{ type: 'SOLID', color: { r: color.red / 255, g: color.grain / 255, b: color.blue / 255 } }];
    }
    if (spec.text) Object.assign(node, { characters: spec.text.contents, fontSize: spec.text.size,
      textAutoResize: spec.text.kind === 'POINTTEXT' ? 'WIDTH_AND_HEIGHT' : 'HEIGHT',
      fontName: { family: spec.text.font }, textAlignHorizontal: spec.text.justification,
      fills: [{ type: 'SOLID', color: { r: 17 / 255, g: 34 / 255, b: 51 / 255 } }], strokes: [], strokeWeight: 0 });
    if (spec.children) node.children = spec.children.toReversed().map(child => toFigma(child, node));
    node.clone = () => toFigma(spec, null);
    node.exportAsync = async settings => pngHeader(Math.max(1, Math.round(node.width * settings.constraint.value)),
      Math.max(1, Math.round(node.height * settings.constraint.value)));
    return node;
  }
  function pngHeader(width, height) {
    const bytes = new Uint8Array(24);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, width); view.setUint32(20, height);
    return bytes;
  }
  const frame = { absoluteTransform: [[1, 0, 0], [0, 1, 0]], children: specs.toReversed().map(x => toFigma(x)) };
  const figma = { showUI() {}, createFrame() {
    return { opacity: 1, parent: null, resize(width, height) { this.width = width; this.height = height; },
      appendChild(copy) { this.copy = copy; copy.parent = this; }, remove() {},
      exportAsync(settings) { return Promise.resolve(pngHeader(Math.max(1, Math.round(this.width * settings.constraint.value)),
        Math.max(1, Math.round(this.height * settings.constraint.value)))); } };
  }, ui: { postMessage(message) {
    if (message.type === 'pad-png') queueMicrotask(() => {
      const view = new DataView(message.bytes.buffer, message.bytes.byteOffset, message.bytes.byteLength);
      figma.ui.onmessage({ type: 'png-padded', requestId: message.requestId,
        bytes: pngHeader(view.getUint32(16) + message.padding * 2, view.getUint32(20) + message.padding * 2) });
    });
  } } };
  const context = vm.createContext({ figma, __html__: '', setImmediate });
  vm.runInContext(code, context);
  for (const padding of [0, 1, 2]) {
    const figmaResult = await context.traverseFrame(frame);
    await context.exportAllSprites(figmaResult.spriteTree, padding);
    assert.deepEqual(run(specs, { padding }).data.layers, JSON.parse(JSON.stringify(figmaResult.layers)));
  }
});

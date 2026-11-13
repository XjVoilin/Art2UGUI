const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { test } = require('node:test');
const esbuild = require('esbuild');
const JSZip = require('jszip');

const source = fs.readFileSync(path.join(__dirname, '../src/code.ts'), 'utf8');
const compiled = esbuild.transformSync(source.replace('import JSZip from "jszip";', ''), { loader: 'ts' }).code;

function png(width, height) {
  function chunk(type, data) {
    const bytes = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, bytes, checksum]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 4 + 1) + 1 + x * 4;
    pixels[offset] = 255; pixels[offset + 3] = 255;
  }
  return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'binary'), chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

function pngSize(bytes) {
  const buffer = Buffer.from(bytes);
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}

function node(name, extra = {}) {
  const result = { name, type: 'RECTANGLE', visible: true, opacity: 1, width: 200, height: 200,
    absoluteTransform: [[1, 0, 21], [0, 1, 527]], rotation: 0, parent: null, fills: [], calls: [], ...extra };
  result.absoluteRenderBounds ??= { x: result.absoluteTransform[0][2], y: result.absoluteTransform[1][2],
    width: result.width, height: result.height };
  result.clone = () => node(result.name, { ...result,
    ...(result.children ? { children: result.children.map(child => child.clone()) } : {}) });
  result.exportAsync = async settings => {
    result.calls.push({ settings, fills: JSON.parse(JSON.stringify(result.fills)),
      opacity: result.opacity, children: result.children?.map(child => [child.name, child.visible]) });
    if (result.failExport) throw new Error('native PNG export failed');
    return new Uint8Array(png(Math.max(1, Math.round((result.exportWidth ?? result.width) * settings.constraint.value)),
      Math.max(1, Math.round((result.exportHeight ?? result.height) * settings.constraint.value))));
  };
  for (const child of result.children || []) child.parent = result;
  return result;
}

function text(name) {
  return node(name, { type: 'TEXT', characters: name, fontSize: 24,
    textAutoResize: 'WIDTH_AND_HEIGHT',
    fontName: { family: 'Inter' }, textAlignHorizontal: 'LEFT', strokes: [], strokeWeight: 0 });
}

function load(children, options = {}) {
  const messages = [];
  const frame = node('Screen', { type: 'FRAME', width: 1080, height: 1920,
    absoluteTransform: [[1, 0, 0], [0, 1, 0]], children });
  const temporaryFrames = [];
  const figma = { showUI() {}, currentPage: { selection: [frame] }, createFrame() {
    const temp = { opacity: 1, parent: null,
      resize(width, height) { this.width = width; this.height = height; },
      appendChild(child) { this.child = child; child.parent = this; },
      async exportAsync(settings) {
        this.child.exportWidth = this.width; this.child.exportHeight = this.height;
        return this.child.exportAsync(settings);
      }, remove() { this.removed = true; } };
    temporaryFrames.push(temp);
    return temp;
  }, ui: {
    postMessage(message) {
      messages.push(message);
      if (message.type === 'pad-png') queueMicrotask(() => {
        if (options.failPadding) {
          figma.ui.onmessage({ type: 'png-padding-error', requestId: message.requestId, error: 'PNG decode failed' });
        } else {
          const [width, height] = pngSize(message.bytes);
          figma.ui.onmessage({ type: 'png-padded', requestId: message.requestId,
            bytes: new Uint8Array(png(width + 2 * message.padding, height + 2 * message.padding)) });
        }
      });
    }
  } };
  const context = vm.createContext({ figma, JSZip, __html__: '', setImmediate, Uint8Array, DataView });
  vm.runInContext(compiled, context);
  return { context, messages, frame, figma, temporaryFrames };
}

async function output(plugin, padding) {
  await plugin.context.runExport(padding);
  const message = plugin.messages.find(message => message.type === 'save-zip');
  const zip = await JSZip.loadAsync(Buffer.from(message.bytes));
  return { zip, data: JSON.parse(await zip.file('Screen_ui_data.json').async('string')) };
}

test('ZIP contains a half-resolution PNG and the original JSON layout', async () => {
  const image = node('UI/img_logo^0.5');
  const plugin = load([image]);
  const { zip, data } = await output(plugin, 0);
  assert.deepEqual(pngSize(await zip.file('UI/img_logo.png').async('uint8array')), [100, 100]);
  const layer = data.layers[0];
  assert.deepEqual([layer.x, layer.y, layer.width, layer.height, layer.scaleX, layer.scaleY], [21, 527, 200, 200, 1, 1]);
  assert.equal(layer.name, 'UI/img_logo^0.5');
  assert.equal(image.calls[0].settings.constraint.value, 0.5);
});

test('ordinary colored PNG does not export a second tint and baked rotation is not reapplied', async () => {
  const image = node('img_rotated', { rotation: 90,
    absoluteTransform: [[0, -1, 41], [1, 0, 527]], width: 100, height: 20,
    absoluteRenderBounds: { x: 21, y: 527, width: 20, height: 100 },
    fills: [{ type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } }] });
  const { data } = await output(load([image]), 0);
  const layer = data.layers[0];
  assert.equal(layer.fontColor, undefined);
  assert.deepEqual([layer.x, layer.y, layer.width, layer.height, layer.rotationZ], [21, 527, 20, 100, 0]);
});

test('scaled text exports visual font size and layout instead of the local base size', async () => {
  const caption = text('Caption');
  caption.absoluteTransform = [[0, -2, 500], [2, 0, 100]];
  const { data } = await output(load([caption]), 0);
  const layer = data.layers[0];
  assert.equal(layer.fontSize, 48);
  assert.equal(layer.wordWrap, false);
  assert.deepEqual([layer.width, layer.height, layer.rotationZ], [400, 400, -90]);
  assert.deepEqual([layer.scaleX, layer.scaleY], [1, 1]);
  assert.equal(caption.fontSize, 24);
});

test('opacity is normalized only in the temporary copy and inherited opacity is applied once', async () => {
  const image = node('img_gray', { opacity: 0.5 });
  const parent = node('Container', { type: 'GROUP', opacity: 0.5, children: [image] });
  const plugin = load([parent]);
  const { data } = await output(plugin, 0);
  assert.equal(data.schemaVersion, 2);
  assert.equal(data.layers[0].opacity, 25);
  assert.equal(image.calls[0].opacity, 1);
  assert.equal(image.opacity, 0.5);
  assert.ok(plugin.temporaryFrames.every(frame => frame.removed));
});

test('tint child is excluded from its parent PNG and only its own bitmap is whitened', async () => {
  const tint = node('img_star~%^0.5', { fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] });
  const parent = node('btn_parent', { type: 'GROUP', children: [tint] });
  const plugin = load([parent]);
  const { data } = await output(plugin, 0);
  assert.deepEqual(parent.calls[0].children, [['img_star~%^0.5', false]]);
  assert.equal(data.layers.find(layer => layer.name === 'btn_parent').fontColor, undefined);
  assert.equal(data.layers.find(layer => layer.name === tint.name).fontColor, '#FF0000');
  assert.equal(plugin.messages.find(message => message.type === 'pad-png').tint, true);
  assert.equal(tint.visible, true);
});

test('padding uses actual PNG dimensions and preserves visible placement after reduction', async () => {
  const plugin = load([node('img_logo^0.5')]);
  const { zip, data } = await output(plugin, 1);
  assert.deepEqual(pngSize(await zip.file('img_logo.png').async('uint8array')), [102, 102]);
  const layer = data.layers[0];
  assert.deepEqual([layer.x, layer.y, layer.width, layer.height], [19, 525, 204, 204]);
  assert.equal(layer.width * 100 / 102, 200);
  assert.equal(plugin.messages.filter(message => message.type === 'pad-png').length, 1);
});

test('each node owns its raster multiplier, text remains data, and source state is restored', async () => {
  const caption = text('Caption');
  const child = node('img_child');
  const parent = node('btn_parent^0.5', { type: 'GROUP', children: [child, caption] });
  const { zip, data } = await output(load([parent]), 0);
  assert.deepEqual(pngSize(await zip.file('btn_parent.png').async('uint8array')), [100, 100]);
  assert.deepEqual(pngSize(await zip.file('img_child.png').async('uint8array')), [200, 200]);
  assert.deepEqual(parent.calls[0].children.map(entry => entry[1]), [false, false]);
  assert.equal(caption.visible, true); assert.equal(child.visible, true);
  assert.equal(caption.calls.length, 0);
  assert.equal(data.layers.find(layer => layer.type === 'text').fontSize, 24);
});

test('unsupported node multipliers fail during traversal before PNG export', async () => {
  for (const suffix of ['0', '-0.5', '0.5junk', '', 'NaN']) {
    const image = node('img_bad^' + suffix);
    const plugin = load([image]);
    await assert.rejects(plugin.context.runExport(1), /节点 PNG 倍率必须是正数/);
    assert.equal(image.calls.length, 0);
    assert.equal(plugin.messages.some(message => message.type === 'save-zip'), false);
  }
});

test('invalid PNG paths fail before cloning or rendering', async () => {
  const image = node('../img_escape');
  const plugin = load([image]);
  await assert.rejects(plugin.context.runExport(0), /不能用作相对 PNG 路径/);
  assert.equal(image.calls.length, 0);
  assert.equal(plugin.temporaryFrames.length, 0);
});

test('legacy star suffix is no longer interpreted as a multiplier', async () => {
  const plugin = load([node('img_legacy*0.5')]);
  await assert.rejects(plugin.context.runExport(0), /不能用作相对 PNG 路径/);
  assert.equal(plugin.temporaryFrames.length, 0);
});

for (const failure of ['native', 'padding']) {
  test(`${failure} failure cleans temporary frames, preserves source, and produces no partial ZIP`, async () => {
    const caption = text('Caption');
    const fills = [{ type: 'SOLID', color: { r: 0.2, g: 0.4, b: 0.6 } }];
    const parent = node('img_parent~', { type: 'GROUP', children: [caption], fills,
      failExport: failure === 'native' });
    const plugin = load([parent], { failPadding: failure === 'padding' });
    await assert.rejects(plugin.context.runExport(1), /PNG/);
    assert.deepEqual(JSON.parse(JSON.stringify(parent.fills)), fills);
    assert.equal(caption.visible, true);
    assert.ok(plugin.temporaryFrames.every(frame => frame.removed));
    assert.equal(plugin.messages.some(message => message.type === 'save-zip'), false);
    assert.equal(plugin.messages.some(message => message.type === 'done'), false);
  });
}

test('entry reports export errors back to the panel so it can enable the export button', async () => {
  const plugin = load([node('img_bad^0')]);
  const finished = new Promise(resolve => {
    const original = plugin.figma.ui.postMessage;
    plugin.figma.ui.postMessage = message => {
      original(message);
      if (message.type === 'error') resolve();
    };
  });
  plugin.figma.ui.onmessage({ type: 'export', padding: 1 });
  await finished;
  assert.ok(plugin.messages.some(message => message.type === 'log' && message.level === 'error'));
});

test('padding configuration is validated before accessing or changing the selection', async () => {
  const plugin = load([node('img_logo')]);
  await assert.rejects(plugin.context.runExport(3), /透明留边/);
  assert.equal(plugin.messages.length, 0);
});

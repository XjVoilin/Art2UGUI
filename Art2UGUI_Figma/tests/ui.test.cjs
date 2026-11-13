const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');

const browser = [process.env.FIGMA_TEST_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome'].find(file => file && fs.existsSync(file));
const ui = fs.readFileSync(path.join(__dirname, '../src/ui.html'), 'utf8');

test('real browser pads PNG transparency and runs the simplified panel message flow',
  { skip: !browser && 'Set FIGMA_TEST_BROWSER to Chrome/Chromium/Edge', timeout: 30000 }, async () => {
    const testPage = `<!doctype html><meta charset="utf-8">
      <iframe id="plugin" src="/ui.html" style="width:360px;height:600px"></iframe>
      <script>
      const frame = document.getElementById('plugin');
      const requests = new Map(), exports = [];
      function check(condition, message) { if (!condition) throw new Error(message); }
      function send(message) { frame.contentWindow.postMessage({pluginMessage: message}, '*'); }
      function requestPng(bytes, padding, requestId, tint = false) {
        return new Promise((resolve, reject) => {
          requests.set(requestId, {resolve, reject});
          send({type:'pad-png', bytes, padding, requestId, tint});
        });
      }
      window.addEventListener('message', event => {
        if (event.source !== frame.contentWindow) return;
        const msg = event.data.pluginMessage;
        if (msg.type === 'export') exports.push(msg);
        if (msg.type === 'png-padded' || msg.type === 'png-padding-error') {
          const pending = requests.get(msg.requestId); requests.delete(msg.requestId);
          if (msg.type === 'png-padded') pending.resolve(msg.bytes);
          else pending.reject(new Error(msg.error));
        }
      });
      async function until(predicate) {
        const end = Date.now() + 3000;
        while (!predicate()) {
          check(Date.now() < end, 'Timed out waiting for panel state');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      frame.addEventListener('load', async () => {
        try {
          const doc = frame.contentDocument;
          check(!doc.getElementById('scaleSelect'), 'Global scale selector still exists');
          check(doc.body.textContent.includes('^0.5') && !doc.body.textContent.includes('*0.5'), 'Scale naming tips must use caret');
          check(doc.getElementById('paddingSelect').value === '1', 'Default padding must be 1px');
          check(doc.documentElement.scrollWidth <= 360, 'Panel overflows horizontally');
          const button = doc.getElementById('exportBtn');
          button.click(); await until(() => exports.length === 1);
          check(exports[0].padding === 1 && !('scale' in exports[0]), 'Export carries obsolete scale');
          check(button.disabled, 'Export button must disable while exporting');
          send({type:'error'}); await until(() => !button.disabled);
          doc.getElementById('paddingSelect').value = '0';
          button.click(); await until(() => exports.length === 2);
          check(exports[1].padding === 0, 'No-padding choice did not reach core');
          send({type:'done'}); await until(() => !button.disabled);

          const input = document.createElement('canvas'); input.width = 2; input.height = 1;
          const ctx = input.getContext('2d'); ctx.fillStyle = '#ff0000'; ctx.fillRect(0,0,1,1);
          const blob = await new Promise(resolve => input.toBlob(resolve, 'image/png'));
          const bytes = await requestPng(new Uint8Array(await blob.arrayBuffer()), 2, 1);
          const bitmap = await createImageBitmap(new Blob([bytes], {type:'image/png'}));
          check(bitmap.width === 6 && bitmap.height === 5, 'Wrong padded PNG dimensions');
          const output = document.createElement('canvas'); output.width=6; output.height=5;
          const out = output.getContext('2d'); out.drawImage(bitmap,0,0); bitmap.close();
          const pixels = out.getImageData(0,0,6,5).data;
          for (let y=0;y<5;y++) for (let x=0;x<6;x++) {
            const offset = (y*6+x)*4;
            check(pixels[offset+3] === (x===2 && y===2 ? 255 : 0), 'Transparent pixels changed');
          }
          check(pixels[(2*6+2)*4] === 255, 'Source red pixel changed');
          const whiteBytes = await requestPng(new Uint8Array(await blob.arrayBuffer()), 1, 3, true);
          const white = await createImageBitmap(new Blob([whiteBytes], {type:'image/png'}));
          out.clearRect(0,0,6,5); out.drawImage(white,0,0); white.close();
          const mask = out.getImageData(0,0,6,5).data;
          const colored = (1*6+1)*4;
          check(mask[colored]===255 && mask[colored+1]===255 && mask[colored+2]===255 && mask[colored+3]===255,
            'Tint PNG must be a white alpha mask');
          check(mask[(1*6+2)*4+3]===0 && mask[3]===0, 'Tint must preserve transparency and padding');
          let rejected = false;
          try { await requestPng(new Uint8Array([0,1,2]), 1, 2); } catch (_) { rejected = true; }
          check(rejected, 'Invalid PNG must send a padding error to the core');
          await fetch('/result', {method:'POST', body:JSON.stringify({ok:true})});
        } catch (error) {
          await fetch('/result', {method:'POST', body:JSON.stringify({ok:false, error:String(error)})});
        }
      });
      </script>`;
    let resolveResult, rejectResult;
    const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const server = http.createServer((request, response) => {
      if (request.url === '/result') {
        let body = '';
        request.on('data', bytes => { body += bytes; });
        request.on('end', () => {
          response.end('ok');
          try { resolveResult(JSON.parse(body)); } catch (error) { rejectResult(error); }
        });
      } else {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(request.url === '/ui.html' ? ui : testPage);
      }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const tempRoot = path.resolve(__dirname, '../../.tmp');
    fs.mkdirSync(tempRoot, {recursive:true});
    const profile = fs.mkdtempSync(path.join(tempRoot, 'figma-ui-'));
    const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run',
      '--no-default-browser-check', '--disable-background-networking', '--user-data-dir=' + profile,
      'http://127.0.0.1:' + server.address().port], {windowsHide:true, stdio:'ignore'});
    child.on('error', rejectResult);
    child.on('exit', code => rejectResult(new Error('Browser exited before result: ' + code)));
    const timer = setTimeout(() => rejectResult(new Error('Browser test timed out')), 20000);
    try {
      const report = await result;
      assert.equal(report.ok, true, report.error);
    } finally {
      clearTimeout(timer);
      const stopped = child.exitCode === null && child.pid ? once(child, 'exit') : Promise.resolve();
      child.kill(); await stopped;
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      // This directory was created by this test and must stay inside its dedicated temporary root.
      assert.ok(path.resolve(profile).startsWith(tempRoot + path.sep));
      fs.rmSync(profile, {recursive:true, force:true, maxRetries:5, retryDelay:100});
    }
  });

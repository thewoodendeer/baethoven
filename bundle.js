#!/usr/bin/env node
/*
 * bundle.js — regenerate web/index.html from source/.
 *
 * Reproduces the original DC bundler's output format (reverse-engineered from the
 * shipped web/index.html). NOTE: the format is NOT "gzip the whole HTML". It is:
 *
 *   <script type="__bundler/manifest">  { uuid: { mime, compressed, data } }   (assets)
 *   <script type="__bundler/ext_resources"> []
 *   <script type="__bundler/template">  JSON.stringify(appHTML)                (NOT compressed)
 *
 * Only external assets (here: support.js) are gzip+base64'd into the manifest, keyed by a
 * uuid. The app HTML becomes the template, with the support.js <script src> rewritten to that
 * uuid. At runtime the bootstrap gunzips each asset into a Blob URL and swaps the uuid in.
 *
 * We keep the head + bootstrap + ext_resources of web/index.html byte-identical and only
 * rewrite the manifest and template payloads.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'source', 'BAETHOVEN.dc.html');
const SUPPORT = path.join(ROOT, 'source', 'support.js');
const WEB = path.join(ROOT, 'web', 'index.html');

// Reuse the original asset uuid so the manifest key and the template's <script src> match.
const UUID = 'a6a3ed30-8e3f-4d5b-be40-979767d306fc';

// 1. read the editable source
let html = fs.readFileSync(SRC, 'utf8');
// 2. read support.js as raw bytes (gzip is byte-exact, lossless)
const support = fs.readFileSync(SUPPORT);

// 3a. drop the loader-only thumbnail <template> (it belongs to the wrapper, not the app DOM;
//     the original bundler strips it too). Exactly one such element exists in source.
const before = html;
html = html.replace(/<template id="__bundler_thumbnail"[\s\S]*?<\/template>/, '');
if (html === before) throw new Error('__bundler_thumbnail template not found in source');

// 3b. rewrite the external support.js reference to the asset uuid
if (!html.includes('./support.js')) throw new Error('"./support.js" reference not found in source');
html = html.replace('./support.js', UUID);

// 4/5. manifest: support.js -> gzip -> base64, keyed by uuid
const gz = zlib.gzipSync(support);
const manifest = {
  [UUID]: { mime: 'text/javascript', compressed: true, data: gz.toString('base64') }
};
const manifestJson = JSON.stringify(manifest);

// 6. template: JSON-stringify the app HTML, then escape every "</" as "</" so a literal
//    </script> inside the app code can't terminate the outer <script type="__bundler/template">.
//    (JSON.parse turns / back into "/" at runtime — lossless.)
const templateJson = JSON.stringify(html).replace(/<\//g, '<\\u002F');

// 7. reuse the existing bootstrap/wrapper from web/index.html; swap only the two payloads.
//    indexOf-based splice (not regex) avoids "$"-pattern issues in the replacement bodies.
let out = fs.readFileSync(WEB, 'utf8');
function replaceTagBody(doc, openTag, body) {
  const o = doc.indexOf(openTag);
  if (o < 0) throw new Error('open tag not found: ' + openTag);
  const bodyStart = o + openTag.length;
  const c = doc.indexOf('</' + 'script>', bodyStart);
  if (c < 0) throw new Error('closing </script> not found for: ' + openTag);
  return doc.slice(0, bodyStart) + body + doc.slice(c);
}
out = replaceTagBody(out, '<script type="__bundler/manifest">', '\n' + manifestJson + '\n  ');
out = replaceTagBody(out, '<script type="__bundler/template">', '\n' + templateJson + '\n  ');

fs.writeFileSync(WEB, out);

// --- self-check: simulate what the runtime loader does, fail loudly on mismatch ---
const reManifest = JSON.parse(out.match(/<script type="__bundler\/manifest">\n([\s\S]*?)\n  <\/script>/)[1]);
const reTemplate = JSON.parse(out.match(/<script type="__bundler\/template">\n([\s\S]*?)\n  <\/script>/)[1]);
const roundtrip = zlib.gunzipSync(Buffer.from(reManifest[UUID].data, 'base64'));
if (!roundtrip.equals(support)) throw new Error('SELF-CHECK FAILED: gunzip(manifest) != support.js');
if (!reTemplate.includes(UUID)) throw new Error('SELF-CHECK FAILED: template missing uuid src');
if (reTemplate.includes('./support.js')) throw new Error('SELF-CHECK FAILED: template still references ./support.js');
if (!reTemplate.includes('stopGroup')) throw new Error('SELF-CHECK FAILED: template missing choke code (stopGroup)');

console.log('OK wrote ' + WEB);
console.log('  support.js : ' + support.length + ' B -> gzip ' + gz.length + ' B -> base64 ' + reManifest[UUID].data.length + ' chars');
console.log('  template   : ' + templateJson.length + ' chars (JSON), un-escapes + gunzip verified');

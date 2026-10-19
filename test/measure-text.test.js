import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { UniversalSVGRenderer, FontLoader, generateTextPaths, extractAllTextContent, extractEmbeddedFont } from '../src/index.js';

// Satoshi, as embedded in the example card
const satoshi = extractEmbeddedFont(readFileSync(new URL('../examples/assets/tanrikulu.eth.svg', import.meta.url), 'utf8'));
const renderer = new UniversalSVGRenderer();
const TEXTS = ['tanrikulu.eth', '1111.eth', '你好.eth', '音乐lover.eth', '안녕하세요.eth', 'שלום.eth', 'مرحبا.eth',
  'hello مرحبا world', 'नमस्ते.eth', 'გამარჯობა.eth', 'γεια.eth', 'привет.eth', 'สวัสดี.eth', '🚀rocket.eth', '👨‍👩‍👧‍👦.eth',
  '🦊🧙🏻‍♂.eth', 'hi你好🚀.eth'];

// generateTextPaths shifts right-anchored text by its full width, so that shift is the width render() lays out.
async function renderedWidth(text, fontSize, features, primaryBuffer) {
  const primary = primaryBuffer ? await FontLoader.loadPrimaryFont(primaryBuffer) : null;
  const intl = await FontLoader.loadInternationalFonts(text);
  const fallback = primary ? null : await FontLoader.loadFallbackFont('Noto+Sans');
  const svg = await generateTextPaths(text, 0, 0, fontSize, '#000', primary, intl, fallback, { featureString: features.join(','), textAnchor: 'end' });
  return -Number(svg.match(/^<g transform="translate\(([-\d.e]+), 0\)">/)[1]);
}

test('measureText equals the width render() lays out, for every script', async () => {
  for (const text of TEXTS) {
    for (const features of [[], ['ss01', 'ss03', 'tnum']]) {
      const measured = await renderer.measureText(text, 60, { primaryFont: satoshi, features });
      const rendered = await renderedWidth(text, 60, features, satoshi);
      assert.ok(Math.abs(measured - rendered) < 1e-9, `${text} [${features}]: measured ${measured}, rendered ${rendered}`);
    }
  }
});

test('features change the width (tnum digits are wider in Satoshi)', async () => {
  const plain = await renderer.measureText('1111', 60, { primaryFont: satoshi });
  const tabular = await renderer.measureText('1111', 60, { primaryFont: satoshi, features: 'tnum' });
  assert.ok(tabular > plain + 10, `plain ${plain}, tabular ${tabular}`);
});

test('without a primary font, measureText uses the fallback font like render()', async () => {
  const measured = await renderer.measureText('hello.eth', 60);
  assert.ok(Math.abs(measured - await renderedWidth('hello.eth', 60, [], null)) < 1e-9);
});

test('measureText accepts an ArrayBuffer and scales with font size', async () => {
  const ab = satoshi.buffer.slice(satoshi.byteOffset, satoshi.byteOffset + satoshi.byteLength);
  const a = await renderer.measureText('tanrikulu.eth', 30, { primaryFont: ab });
  const b = await renderer.measureText('tanrikulu.eth', 60, { primaryFont: ab });
  assert.ok(Math.abs(b - 2 * a) < 1e-9);
});

test('multi-line text measures the widest line', async () => {
  const wide = await renderer.measureText('a much longer line', 60, { primaryFont: satoshi });
  assert.equal(await renderer.measureText('short\na much longer line', 60, { primaryFont: satoshi }), wide);
});

test('text content is entity-decoded before shaping', () => {
  const [entry] = extractAllTextContent('<svg><text x="0" y="0">a&amp;b &lt;c&gt; &#x41;&#66;</text></svg>');
  assert.equal(entry.textContent, 'a&b <c> AB');
});

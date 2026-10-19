/**
 * measureText on a createRasterizer instance: fonts come only from the bytes it was given
 * (as in a Worker loading them from R2), and the width matches what render() lays out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    createRasterizer, FontLoader, LOCAL_FONT_FILES, decompress,
    generateTextPaths, extractEmbeddedFont
} from '../src/index.js';

const bundled = async (file) => decompress(readFileSync(new URL(`../fonts/${file}`, import.meta.url)));

// Every bundled font except Hebrew, so a missing script font has to fall back like render() does
const fonts = await Promise.all(Object.entries(LOCAL_FONT_FILES)
    .filter(([name]) => name !== 'Noto+Sans+Hebrew')
    .map(async ([name, file]) => ({ name: name.replace(/\+/g, ' '), data: await bundled(file) })));
const rasterizer = await createRasterizer({ fonts, emojiData: await bundled('twemoji.json.br') });

// From here on, any filesystem font loading is a failure
for (const method of ['_loadLocalFont', 'loadFallbackFont', 'loadInternationalFonts']) {
    FontLoader[method] = () => { throw new Error(`filesystem font loading: FontLoader.${method}`); };
}

const satoshi = extractEmbeddedFont(readFileSync(new URL('../examples/assets/tanrikulu.eth.svg', import.meta.url), 'utf8'));

// The width render() lays out on this rasterizer: its registry fonts, with generateTextPaths shifting
// right-anchored text by exactly that width
async function renderedWidth(text, fontSize, features, primaryBuffer) {
    const primary = primaryBuffer ? await FontLoader.loadPrimaryFont(primaryBuffer) : null;
    const intl = FontLoader.getInternationalFontsFromRegistry(text, rasterizer._fontRegistry);
    const fallback = primary ? null : rasterizer._fallbackFontObj;
    const svg = await generateTextPaths(text, 0, 0, fontSize, '#000', primary, intl, fallback, { featureString: features.join(','), textAnchor: 'end' });
    return -Number(svg.match(/^<g transform="translate\(([-\d.e]+), 0\)">/)[1]);
}

const CASES = [
    ['tanrikulu.eth', 'Latin, Satoshi'],
    ['1111.eth', 'tabular digits'],
    ['مرحبا.eth', 'Arabic (RTL)'],
    ['你好.eth', 'CJK'],
    ['안녕하세요.eth', 'Korean'],
    ['שלום.eth', 'Hebrew, not in the registry'],
    ['👨‍👩‍👧‍👦🚀.eth', 'emoji with a ZWJ sequence'],
    ['🦊🧙🏻‍♂.eth', 'emoji whose twemoji key has FE0F the text lacks'],
    ['hi你好🚀.eth', 'mixed Latin, CJK and emoji'],
];

test('measureText on a createRasterizer instance equals the width render() lays out', async () => {
    for (const [text, label] of CASES) {
        for (const features of [[], ['ss01', 'ss03', 'tnum']]) {
            for (const primary of [satoshi, null]) {
                const measured = await rasterizer.measureText(text, 60, { primaryFont: primary, features });
                const rendered = await renderedWidth(text, 60, features, primary);
                assert.ok(measured > 0, `${label}: zero width`);
                assert.ok(Math.abs(measured - rendered) < 1e-9,
                    `${label} [${features}] ${primary ? 'Satoshi' : 'fallback'}: measured ${measured}, rendered ${rendered}`);
            }
        }
    }
});

test('the FE0F-less emoji is measured as an emoji, not a fallback glyph', async () => {
    // Emoji advance by exactly fontSize; '.eth' adds the rest
    const mage = await rasterizer.measureText('🧙🏻‍♂', 60, { primaryFont: satoshi });
    assert.equal(mage, 60);
});

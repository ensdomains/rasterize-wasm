/**
 * Text processing and path generation (harfbuzzjs backend)
 */
import { FontLoader, readBundledFile } from './font-loader.js';
import { decompress } from '../utils/decompress.js';
import bidiFactory from 'bidi-js';

const bidi = bidiFactory();

let _emojiMap;
let _emojiMapPromise;
// FE0F-free form -> twemoji key; ENS-normalized text (ENSIP-15) drops FE0F that keys keep
let _emojiKeyByBareForm = new Map();

function useEmojiMap(map) {
    _emojiMap = map;
    _emojiKeyByBareForm = new Map();
    for (const key of Object.keys(map)) {
        const bare = key.replace(/-fe0f/g, '');
        if (!_emojiKeyByBareForm.has(bare)) _emojiKeyByBareForm.set(bare, key);
    }
}

/**
 * Provide emoji data for environments without filesystem access (e.g. Workers).
 * Accepts either a pre-parsed map object or a Brotli-compressed buffer.
 */
export async function setEmojiData(data) {
    if (data && typeof data === 'object' && !ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer)) {
        // Already a parsed map object
        useEmojiMap(data);
    } else if (data) {
        // Brotli-compressed buffer — decompress and parse
        const raw = await decompress(data);
        useEmojiMap(JSON.parse(Buffer.from(raw).toString()));
    }
}

async function _getEmojiMap() {
    if (_emojiMap) return _emojiMap;
    if (_emojiMapPromise) return _emojiMapPromise;
    _emojiMapPromise = (async () => {
        try {
            const raw = await decompress(readBundledFile('twemoji.json.br'));
            useEmojiMap(JSON.parse(Buffer.from(raw).toString()));
        } catch {
            useEmojiMap({});
        }
        return _emojiMap;
    })();
    return _emojiMapPromise;
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });

export function segmentGraphemes(text) {
    return [...GRAPHEME_SEGMENTER.segment(text)].map(s => s.segment);
}

export function isEmoji(grapheme) {
    const cp = grapheme.codePointAt(0);
    // Regional indicator symbols (flags)
    if (cp >= 0x1F1E0 && cp <= 0x1F1FF) return true;
    // Common emoji ranges (emoticons, symbols, etc.)
    if (cp >= 0x1F000) return true;
    // Dingbats, misc symbols
    if (cp >= 0x2600 && cp <= 0x27BF) return true;
    // Misc technical (hourglass, watch, etc.)
    if (cp >= 0x2300 && cp <= 0x23FF) return true;
    // Supplemental arrows, misc symbols (⭐, ⬛, etc.)
    if (cp >= 0x2B00 && cp <= 0x2BFF) return true;
    // Arrows, math operators with emoji presentation
    if (cp >= 0x2190 && cp <= 0x21FF) return true;
    // Enclosed alphanumerics (Ⓜ, etc.)
    if (cp >= 0x24C2 && cp <= 0x24FF) return true;
    // Geometric shapes (▪, ▫, etc.)
    if (cp >= 0x25A0 && cp <= 0x25FF) return true;
    // Keycap sequences: digit/# /asterisk + VS16 + U+20E3
    if (grapheme.includes('\u20E3')) return true;
    // copyright ©, registered ®, trademark ™ with VS16
    if ((cp === 0x00A9 || cp === 0x00AE || cp === 0x2122) && grapheme.includes('\uFE0F')) return true;
    return false;
}

export async function loadEmojiSvg(grapheme) {
    // Build key with FE0F kept (jdecked/twemoji uses FE0F in filenames for ZWJ sequences)
    const codepoints = [...grapheme].map(c => c.codePointAt(0).toString(16));
    const bare = codepoints.filter(cp => cp !== 'fe0f').join('-');
    const map = await _getEmojiMap();
    // Exact key, then without FE0F (simple emoji), then the key that has FE0F where the text has none
    return map[codepoints.join('-')] || map[bare] || map[_emojiKeyByBareForm.get(bare)] || null;
}

function escapeXml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

export function applyRTLProcessing(text) {
    const chars = segmentGraphemes(text);
    const hasRTL = /[\u0600-\u06FF\u0750-\u077F\u0590-\u05FF]/.test(text);

    if (!hasRTL) return chars;

    let segments = [];
    let currentSegment = { chars: [], isRTL: false };

    for (const char of chars) {
        const isRTL = /[\u0600-\u06FF\u0750-\u077F\u0590-\u05FF]/.test(char);
        if (isRTL !== currentSegment.isRTL) {
            if (currentSegment.chars.length > 0) {
                segments.push(currentSegment);
            }
            currentSegment = { chars: [char], isRTL };
        } else {
            currentSegment.chars.push(char);
        }
    }

    if (currentSegment.chars.length > 0) {
        segments.push(currentSegment);
    }

    const processedChars = [];
    for (const segment of segments) {
        if (segment.isRTL) {
            processedChars.push(...segment.chars.reverse());
        } else {
            processedChars.push(...segment.chars);
        }
    }

    return processedChars;
}

function resolveInternationalFont(char, internationalFonts) {
    if (!internationalFonts) return null;
    if (!(internationalFonts instanceof Map)) return internationalFonts;

    const scriptEntry = FontLoader.getScriptFont(char);
    if (!scriptEntry) return null;
    return internationalFonts.get(scriptEntry) || null;
}

/**
 * Pre-fetch all emoji SVGs in parallel.
 */
async function prefetchEmoji(chars) {
    const emojiChars = chars.filter(c => c !== '\n' && c !== '\r' && isEmoji(c));
    if (emojiChars.length === 0) return new Map();

    const unique = [...new Set(emojiChars)];
    const results = await Promise.all(unique.map(char => loadEmojiSvg(char)));
    return new Map(unique.map((char, i) => [char, results[i]]));
}

/**
 * Split text into bidi direction runs using the Unicode Bidirectional Algorithm.
 * Returns array of { text, direction, start, end }.
 */
function getBidiRuns(text) {
    const result = bidi.getEmbeddingLevels(text, 'ltr');
    const levels = result.levels;
    const runs = [];
    let runStart = 0;

    for (let i = 1; i <= text.length; i++) {
        if (i === text.length || levels[i] !== levels[runStart]) {
            const level = levels[runStart];
            runs.push({
                text: text.slice(runStart, i),
                direction: level % 2 === 0 ? 'ltr' : 'rtl',
                start: runStart,
                end: i
            });
            runStart = i;
        }
    }
    return runs;
}

/**
 * Segment text into runs by font (emoji, international, primary, fallback).
 * Each run is { type: 'emoji'|'text'|'fallback', chars: string, font: fontObj|null, graphemes: [] }
 * When direction is 'rtl', neutral characters (spaces, punctuation) inherit the
 * font of the surrounding script run so HarfBuzz can shape the full RTL phrase.
 */
function segmentByFont(graphemes, primaryFont, internationalFonts, fallbackFont, emojiCache, enableEmoji, direction) {
    const runs = [];
    let currentRun = null;

    function pushRun() {
        if (currentRun && currentRun.chars.length > 0) {
            runs.push(currentRun);
        }
        currentRun = null;
    }

    for (const grapheme of graphemes) {
        if (grapheme === '\n' || grapheme === '\r') {
            pushRun();
            runs.push({ type: 'newline', chars: grapheme, font: null, graphemes: [grapheme] });
            continue;
        }

        // Check for emoji
        if (enableEmoji && isEmoji(grapheme) && emojiCache.has(grapheme) && emojiCache.get(grapheme)) {
            pushRun();
            runs.push({ type: 'emoji', chars: grapheme, font: null, graphemes: [grapheme], emojiSvg: emojiCache.get(grapheme) });
            continue;
        }

        // Determine which font to use
        const scriptFont = resolveInternationalFont(grapheme, internationalFonts);
        let font = scriptFont || primaryFont;
        if (!font && fallbackFont) font = fallbackFont;

        // In RTL bidi runs, neutral chars (spaces, punctuation) inherit the current
        // run's font so HarfBuzz shapes the full phrase with correct word reordering.
        if (direction === 'rtl' && !scriptFont && currentRun && currentRun.type === 'text') {
            const isNeutral = /^[\s\d\p{P}\p{S}]*$/u.test(grapheme);
            if (isNeutral) font = currentRun.font;
        }

        if (!font) {
            // No font available — use <text> fallback
            pushRun();
            runs.push({ type: 'fallback', chars: grapheme, font: null, graphemes: [grapheme] });
            continue;
        }

        // Continue current text run if same font
        if (currentRun && currentRun.type === 'text' && currentRun.font === font) {
            currentRun.chars += grapheme;
            currentRun.graphemes.push(grapheme);
        } else {
            pushRun();
            currentRun = { type: 'text', chars: grapheme, font, graphemes: [grapheme] };
        }
    }

    pushRun();
    return runs;
}

/**
 * Shape a text run with HarfBuzz and return SVG path fragments (none when withPaths is false).
 */
function shapeAndRender(hb, fontObj, text, x, y, fontSize, fill, featureString, direction, withPaths = true) {
    const { hbFont, upem } = fontObj;
    const scale = fontSize / upem;
    const parts = [];
    let currentX = x;

    const buffer = hb.createBuffer();
    try {
        buffer.addText(text);
        buffer.guessSegmentProperties();
        if (direction) buffer.setDirection(direction);

        if (featureString) {
            hb.shape(hbFont, buffer, featureString);
        } else {
            hb.shape(hbFont, buffer);
        }

        const glyphs = buffer.json();

        for (const glyph of glyphs) {
            const glyphId = glyph.g;
            const xAdvance = glyph.ax * scale;
            const xOffset = glyph.dx * scale;
            const yOffset = glyph.dy * scale;

            if (withPaths && glyphId !== 0) {
                const pathData = hbFont.glyphToPath(glyphId);
                if (pathData) {
                    // font.glyphToPath returns path in font units, Y-up.
                    // Apply transform: translate to position, scale to fontSize, flip Y.
                    const gx = currentX + xOffset;
                    const gy = y - yOffset;
                    parts.push(`<path d="${pathData}" transform="translate(${gx},${gy}) scale(${scale},${-scale})" fill="${fill}" />`);
                }
            }

            currentX += xAdvance;
        }
    } finally {
        buffer.destroy();
    }

    return { parts, advanceX: currentX - x };
}

/**
 * Lay text out exactly as it is drawn. Returns the SVG fragments (only when withPaths is true),
 * the advance of the last line (used for text-anchor) and the widest line's advance.
 */
async function layoutText(text, x, y, fontSize, fill, primaryFont, internationalFonts, fallbackFont, options, withPaths) {
    const { enableEmoji = true, fontWeight = 700, featureString = '' } = options;
    const hb = await FontLoader.getHb();
    const parts = [];
    let currentX = x;
    let currentY = y;
    let maxWidth = 0;
    const lineHeight = fontSize * 1.2;

    // Step 1: Run Unicode Bidirectional Algorithm on the full text
    const bidiRuns = getBidiRuns(text);

    // Batch-fetch all emoji SVGs upfront
    const allGraphemes = segmentGraphemes(text);
    const emojiCache = enableEmoji ? await prefetchEmoji(allGraphemes) : new Map();

    // Step 2: Process each bidi direction run
    for (const bidiRun of bidiRuns) {
        const graphemes = segmentGraphemes(bidiRun.text);

        // Step 3: Segment by font within this bidi run (neutral chars inherit font in RTL runs)
        const runs = segmentByFont(graphemes, primaryFont, internationalFonts, fallbackFont, emojiCache, enableEmoji, bidiRun.direction);

        for (const run of runs) {
            if (run.type === 'newline') {
                if (run.chars === '\n') {
                    maxWidth = Math.max(maxWidth, currentX - x);
                    currentX = x;
                    currentY += lineHeight;
                }
                continue;
            }

            if (run.type === 'emoji') {
                const emojiContent = run.emojiSvg.match(/<svg[^>]*>(.*)<\/svg>/s)?.[1];
                if (emojiContent) {
                    const emojiY = currentY - fontSize * 0.75;
                    if (withPaths) parts.push(`<g transform="translate(${currentX}, ${emojiY}) scale(${fontSize/36})">${emojiContent}</g>`);
                    currentX += fontSize;
                }
                continue;
            }

            if (run.type === 'fallback') {
                const char = run.chars;
                const fontFamilyAttr = FontLoader.getFontFamilyCSS(char);
                if (withPaths) parts.push(`<text x="${currentX}" y="${currentY}" font-family="${fontFamilyAttr}" font-size="${fontSize}" fill="${fill}" font-weight="${fontWeight}">${escapeXml(char)}</text>`);
                currentX += FontLoader.isCJK(char) ? fontSize : fontSize * 0.6;
                continue;
            }

            if (run.type === 'text') {
                // Shape with HarfBuzz — pass bidi direction explicitly
                const features = (run.font === primaryFont) ? featureString : '';
                const { parts: shapedParts, advanceX } = shapeAndRender(
                    hb, run.font, run.chars, currentX, currentY, fontSize, fill, features, bidiRun.direction, withPaths
                );
                parts.push(...shapedParts);
                currentX += advanceX;
                continue;
            }
        }
    }

    const lastLineWidth = currentX - x;
    return { parts, lastLineWidth, maxWidth: Math.max(maxWidth, lastLineWidth) };
}

export async function generateTextPaths(text, x, y, fontSize, fill, primaryFont, internationalFonts, fallbackFont, options = {}) {
    const { textAnchor = 'start' } = options;
    const { parts, lastLineWidth: totalWidth } = await layoutText(text, x, y, fontSize, fill, primaryFont, internationalFonts, fallbackFont, options, true);

    const content = parts.join('');
    if (textAnchor === 'start') return content;

    const offset = textAnchor === 'middle' ? -totalWidth / 2 : -totalWidth;
    return `<g transform="translate(${offset}, 0)">${content}</g>`;
}

/**
 * Advance width of text at fontSize, laid out exactly as generateTextPaths draws it
 * (same font selection, HarfBuzz shaping, emoji and fallback widths). For multi-line
 * text, the widest line.
 */
export async function measureTextWidth(text, fontSize, primaryFont, internationalFonts, fallbackFont, options = {}) {
    const { maxWidth } = await layoutText(text, 0, 0, fontSize, '', primaryFont, internationalFonts, fallbackFont, options, false);
    return maxWidth;
}

/**
 * Font loading and management (harfbuzzjs backend)
 */
import { createRequire } from 'module';
import createHarfBuzz from 'harfbuzzjs/hb.js';
import hbjs from 'harfbuzzjs/hbjs.js';
import { decompress } from '../utils/decompress.js';

let _require;
function getRequire() {
    if (!_require) _require = createRequire(import.meta.url);
    return _require;
}

/**
 * Read a file from the bundled fonts/ directory.
 * Returns null when missing or without filesystem access (Workers).
 */
export function readBundledFile(filename) {
    try {
        const require = getRequire();
        const { readFileSync } = require('fs');
        const { fileURLToPath } = require('url');
        return readFileSync(fileURLToPath(new URL(`../../fonts/${filename}`, import.meta.url)));
    } catch {
        return null;
    }
}

let _hb = null;
let _hbPromise = null;
let _hbWasmBinary = null;

// Pre-loaded font buffers for Workers (Brotli-compressed .ttf.br data)
const _fontData = new Map();

/**
 * Provide the harfbuzzjs WASM binary for environments without filesystem access.
 */
export function setHarfBuzzWasm(wasmBinary) {
    _hbWasmBinary = wasmBinary;
}

/**
 * Pre-load a font's Brotli-compressed buffer for Workers (where readFileSync is unavailable).
 * Call before rendering. fontFamily uses '+' separators (e.g. 'Noto+Sans').
 */
export function setFontData(fontFamily, brBuffer) {
    _fontData.set(fontFamily, brBuffer);
}

async function getHb() {
    if (_hb) return _hb;
    if (_hbPromise) return _hbPromise;
    _hbPromise = (async () => {
        let wasmBinary = _hbWasmBinary;
        if (!wasmBinary) {
            try {
                const require = getRequire();
                const { readFileSync } = require('fs');
                const hbWasmPath = require.resolve('harfbuzzjs/hb.wasm');
                wasmBinary = readFileSync(hbWasmPath);
            } catch {}
        }
        let moduleArgs;
        // Emscripten never settles if instantiateWasm fails, so surface that failure ourselves
        let failInstantiate;
        const instantiateFailed = new Promise((_, reject) => { failInstantiate = reject; });
        if (wasmBinary && typeof WebAssembly !== 'undefined' && wasmBinary instanceof WebAssembly.Module) {
            // Pre-compiled WebAssembly.Module (e.g. Cloudflare Workers CompiledWasm)
            moduleArgs = {
                instantiateWasm(info, receiveInstance) {
                    WebAssembly.instantiate(wasmBinary, info).then(receiveInstance, failInstantiate);
                    return {};
                }
            };
        } else {
            moduleArgs = wasmBinary ? { wasmBinary } : {};
        }
        const instance = await Promise.race([createHarfBuzz(moduleArgs), instantiateFailed]);
        _hb = hbjs(instance);
        return _hb;
    })().catch((error) => {
        // Don't cache the failure; a corrected setHarfBuzzWasm() can retry
        _hbPromise = null;
        throw error;
    });
    return _hbPromise;
}

/**
 * Create a harfbuzzjs font from an ArrayBuffer.
 * Returns { hbFont, hbFace, hbBlob, upem } or null on failure.
 */
export async function createHbFont(arrayBuffer) {
    const hb = await getHb();
    const blob = hb.createBlob(arrayBuffer);
    const face = hb.createFace(blob, 0);
    const font = hb.createFont(face);
    return { hbFont: font, hbFace: face, hbBlob: blob, upem: face.upem };
}

/** Free a createHbFont() result: its HarfBuzz heap copy and draw callbacks. */
export function destroyHbFont(fontObj) {
    if (!fontObj) return;
    fontObj.hbFont.destroy();
    fontObj.hbFace.destroy();
    fontObj.hbBlob.destroy();
}

/**
 * Map font family names to local gzipped TTF filenames in fonts/ directory.
 */
export const LOCAL_FONT_FILES = {
    'Noto+Sans':            'noto-sans-bold.ttf.br',
    'Noto+Naskh+Arabic':    'noto-naskh-arabic-bold.ttf.br',
    'Noto+Sans+Hebrew':     'noto-sans-hebrew-bold.ttf.br',
    'Noto+Sans+KR':         'noto-sans-kr-bold.ttf.br',
    'Noto+Sans+SC':         'noto-sans-sc-bold.ttf.br',
    'Noto+Sans+Devanagari': 'noto-sans-devanagari-bold.ttf.br',
    'Noto+Sans+Bengali':    'noto-sans-bengali-bold.ttf.br',
    'Noto+Sans+Gurmukhi':   'noto-sans-gurmukhi-bold.ttf.br',
    'Noto+Sans+Gujarati':   'noto-sans-gujarati-bold.ttf.br',
    'Noto+Sans+Tamil':      'noto-sans-tamil-bold.ttf.br',
    'Noto+Sans+Telugu':     'noto-sans-telugu-bold.ttf.br',
    'Noto+Sans+Kannada':    'noto-sans-kannada-bold.ttf.br',
    'Noto+Sans+Malayalam':  'noto-sans-malayalam-bold.ttf.br',
    'Noto+Sans+Thai':       'noto-sans-thai-bold.ttf.br',
    'Noto+Sans+Lao':        'noto-sans-lao-bold.ttf.br',
    'Noto+Sans+Myanmar':    'noto-sans-myanmar-bold.ttf.br',
    'Noto+Sans+Armenian':   'noto-sans-armenian-bold.ttf.br',
    'Noto+Sans+Georgian':   'noto-sans-georgian-bold.ttf.br',
};

export class FontLoader {
    static _fontCache = new Map();

    static _loadLocalFont(fontFamily) {
        // Cache the promise so concurrent cold renders share one load instead of leaking duplicates
        if (!this._fontCache.has(fontFamily)) {
            const pending = this._readLocalFont(fontFamily);
            this._fontCache.set(fontFamily, pending);
            // Don't cache failures, so a later setFontData() can still supply the font
            const forget = () => this._fontCache.delete(fontFamily);
            pending.then(font => { if (!font) forget(); }, forget);
        }
        return this._fontCache.get(fontFamily);
    }

    static async _readLocalFont(fontFamily) {
        const filename = LOCAL_FONT_FILES[fontFamily];
        if (!filename) return null;

        // Pre-loaded data first (Workers path), then the filesystem (Node.js path)
        const brBuf = _fontData.get(fontFamily) || readBundledFile(filename);
        if (!brBuf) return null;
        const fontBuffer = await decompress(brBuf);
        return createHbFont(fontBuffer.buffer.slice(fontBuffer.byteOffset, fontBuffer.byteOffset + fontBuffer.byteLength));
    }

    static async loadPrimaryFont(fontBuffer) {
        if (!fontBuffer) return null;

        try {
            return await createHbFont(fontBuffer.buffer.slice(fontBuffer.byteOffset, fontBuffer.byteOffset + fontBuffer.byteLength));
        } catch (error) {
            console.warn('Failed to load primary font:', error.message);
            return null;
        }
    }

    static async loadFallbackFont(fontFamily = 'Noto+Sans') {
        try {
            if (fontFamily.toLowerCase().includes('satoshi')) {
                fontFamily = 'Noto+Sans';
            }
            return await this._loadLocalFont(fontFamily);
        } catch (error) {
            console.warn('Failed to load fallback font:', error.message);
            return null;
        }
    }

    static SCRIPT_FONTS = [
        { regex: /[\u0600-\u06FF\u0750-\u077F]/, fonts: ['Noto+Naskh+Arabic'] },
        { regex: /[\u0590-\u05FF]/, fonts: ['Noto+Sans+Hebrew'] },
        { regex: /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/, fonts: ['Noto+Sans+KR'] },
        { regex: /[\u3400-\u4DBF\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]/, fonts: ['Noto+Sans+SC'] },
        { regex: /[\u0900-\u097F]/, fonts: ['Noto+Sans+Devanagari'] },
        { regex: /[\u0980-\u09FF]/, fonts: ['Noto+Sans+Bengali'] },
        { regex: /[\u0A00-\u0A7F]/, fonts: ['Noto+Sans+Gurmukhi'] },
        { regex: /[\u0A80-\u0AFF]/, fonts: ['Noto+Sans+Gujarati'] },
        { regex: /[\u0B80-\u0BFF]/, fonts: ['Noto+Sans+Tamil'] },
        { regex: /[\u0C00-\u0C7F]/, fonts: ['Noto+Sans+Telugu'] },
        { regex: /[\u0C80-\u0CFF]/, fonts: ['Noto+Sans+Kannada'] },
        { regex: /[\u0D00-\u0D7F]/, fonts: ['Noto+Sans+Malayalam'] },
        { regex: /[\u0E00-\u0E7F]/, fonts: ['Noto+Sans+Thai'] },
        { regex: /[\u0E80-\u0EFF]/, fonts: ['Noto+Sans+Lao'] },
        { regex: /[\u1000-\u109F]/, fonts: ['Noto+Sans+Myanmar'] },
        { regex: /[\u0530-\u058F]/, fonts: ['Noto+Sans+Armenian'] },
        { regex: /[\u10A0-\u10FF]/, fonts: ['Noto+Sans+Georgian'] },
        { regex: /[\u0400-\u04FF\u0370-\u03FF]/, fonts: ['Noto+Sans'] },
    ];

    static getScriptFont(char) {
        for (const entry of this.SCRIPT_FONTS) {
            if (entry.regex.test(char)) return entry;
        }
        return null;
    }

    static getFontFamilyCSS(char) {
        const entry = this.getScriptFont(char);
        if (!entry) return 'Arial, sans-serif';
        const name = entry.fonts[0].replace(/\+/g, ' ');
        return `'${name}', sans-serif`;
    }

    static CJK_REGEX = /[\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u30FF\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/;

    static isCJK(char) {
        return this.CJK_REGEX.test(char);
    }

    /**
     * Look up pre-loaded fonts from a registry Map (for createRasterizer path).
     * Returns the same Map<scriptEntry, fontObj> shape as loadInternationalFonts.
     */
    static getInternationalFontsFromRegistry(text, fontRegistry) {
        const pairs = this.SCRIPT_FONTS.filter(e => e.regex.test(text)).map(e => [e, fontRegistry.get(e.fonts[0])]);
        return new Map(pairs.filter(([, font]) => font));
    }

    static async loadInternationalFonts(text) {
        // Load the detected scripts' fonts in parallel
        const pairs = await Promise.all(this.SCRIPT_FONTS.filter(e => e.regex.test(text))
            .map(async e => [e, await this._loadLocalFont(e.fonts[0])]));
        return new Map(pairs.filter(([, font]) => font));
    }

    /**
     * Get the harfbuzzjs instance (for shaping in text-processor)
     */
    static async getHb() {
        return getHb();
    }

    /**
     * Force-initialize harfbuzzjs WASM.
     * Call at module level (top-level await) in Workers to ensure
     * all WASM compilation happens during the startup phase.
     */
    static async warmup() {
        return getHb();
    }
}

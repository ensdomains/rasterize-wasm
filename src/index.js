/**
 * Universal Unicode SVG Renderer
 * A powerful library for converting SVGs with international text to PNG
 */
import { detectAndConvert } from './adapters/input.js';
import { toBase64, toFile, toMultipleFormats } from './adapters/output.js';
import { extractAllTextContent, extractEmbeddedFont, extractFontFeatures, replaceTextElement, optimizeFilters } from './utils/svg-parser.js';
import { FontLoader, createHbFont, destroyHbFont, LOCAL_FONT_FILES } from './renderers/font-loader.js';
import { generateTextPaths, measureTextWidth, setEmojiData } from './renderers/text-processor.js';
import { SVGRenderer } from './renderers/svg-renderer.js';

// Frees measureText's cached primary fonts once their buffer is garbage collected
const primaryFontFinalizer = typeof FinalizationRegistry === 'undefined'
    ? null
    : new FinalizationRegistry(font => font.then(destroyHbFont));

export class UniversalSVGRenderer {
    constructor(options = {}) {
        const { _fontRegistry, _fallbackFontObj, ...publicOptions } = options;
        this.options = {
            enableInternationalFonts: true,
            enableEmoji: true,
            fallbackFont: 'Noto+Sans',
            ...publicOptions
        };
        this._fontRegistry = _fontRegistry || null;
        this._fallbackFontObj = _fallbackFontObj || null;
    }

    /**
     * Main rendering method - supports multiple input/output formats
     */
    async render(input, outputOptions = {}) {
        try {
            // Step 1: Convert input to SVG string
            const svgString = detectAndConvert(input);

            // Step 2: Parse SVG and extract all text elements
            const textEntries = extractAllTextContent(svgString);

            let processedSvg = svgString;

            // Only process text if there are text elements
            if (textEntries.length > 0) {
                // Step 3: Load fonts in parallel
                const embeddedFontBuffer = extractEmbeddedFont(svgString);
                const allText = textEntries.map(e => e.textContent).join('');

                const [primaryFont, [internationalFonts, fallbackFont]] = await Promise.all([
                    FontLoader.loadPrimaryFont(embeddedFontBuffer),
                    this._scriptFonts(allText)
                ]);

                // Use fallback only when no primary font
                const effectiveFallback = primaryFont ? null : fallbackFont;

                // Extract font-feature-settings as a HarfBuzz feature string (e.g. "ss01,ss03")
                const fontFeatures = extractFontFeatures(svgString);
                const featureString = fontFeatures.join(',');

                // Step 4: Generate text paths for all elements in parallel
                let pathResults;
                try {
                    pathResults = await Promise.all(
                        textEntries.map(({ textContent, attributes }) => {
                            const { fontSize, fill, fontWeight, textAnchor, x, y } = attributes;
                            return generateTextPaths(
                                textContent, x, y, fontSize, fill, primaryFont, internationalFonts, effectiveFallback,
                                { enableEmoji: this.options.enableEmoji, fontWeight, featureString, textAnchor }
                            );
                        })
                    );
                } finally {
                    // The embedded font is per-render
                    destroyHbFont(primaryFont);
                }

                // Step 5: Apply all replacements
                for (let i = 0; i < textEntries.length; i++) {
                    processedSvg = replaceTextElement(processedSvg, textEntries[i].textElement, pathResults[i]);
                }
            }

            // Step 6: Optimize filters for faster rendering
            processedSvg = optimizeFilters(processedSvg);

            // Step 7: Render SVG to PNG
            const pngBuffer = await SVGRenderer.renderSVGToPNG(processedSvg, {
                wasmBuffer: this.options.wasmBuffer
            });

            // Step 8: Return in requested format(s)
            return this._handleOutput(pngBuffer, outputOptions);

        } catch (error) {
            throw new Error(`Rendering failed: ${error.message}`);
        }
    }

    /**
     * Width of `text` at `fontSize` exactly as render() would draw it: same font selection,
     * HarfBuzz shaping, emoji and fallback widths. Use it to size layout around text before rendering.
     * @param {string} text - Unescaped text (what the <text> element displays)
     * @param {number} fontSize
     * @param {Object} [options]
     * @param {ArrayBuffer|Uint8Array} [options.primaryFont] - The font the SVG will embed with @font-face
     * @param {string|string[]} [options.features] - Features the SVG turns on with font-feature-settings, e.g. ['ss01', 'tnum']
     * @returns {Promise<number>} Advance width in user units (the widest line for multi-line text)
     */
    async measureText(text, fontSize, { primaryFont = null, features = [] } = {}) {
        const [primary, [internationalFonts, fallbackFont]] = await Promise.all([
            this._loadPrimaryFontCached(primaryFont),
            this._scriptFonts(text)
        ]);
        const featureString = Array.isArray(features) ? features.join(',') : features;
        // As in render(): the fallback font is only used when there is no primary font.
        return measureTextWidth(text, fontSize, primary, internationalFonts, primary ? null : fallbackFont, {
            enableEmoji: this.options.enableEmoji,
            featureString
        });
    }

    /**
     * Script fonts and fallback font for text, shared by render() and measureText() so they always agree:
     * from the registry for createRasterizer instances (never the filesystem), else the bundled files.
     * @returns {Promise<[Map, Object|null]>} [internationalFonts, fallbackFont]
     */
    async _scriptFonts(text) {
        const enabled = this.options.enableInternationalFonts;
        if (this._fontRegistry) {
            return [enabled ? FontLoader.getInternationalFontsFromRegistry(text, this._fontRegistry) : new Map(), this._fallbackFontObj];
        }
        return Promise.all([
            enabled ? FontLoader.loadInternationalFonts(text) : new Map(),
            FontLoader.loadFallbackFont(this.options.fallbackFont)
        ]);
    }

    // measureText is called repeatedly while searching for a font size; parse each primary font once.
    async _loadPrimaryFontCached(fontBuffer) {
        if (!fontBuffer) return null;
        this._primaryFonts ??= new WeakMap();
        if (!this._primaryFonts.has(fontBuffer)) {
            const bytes = fontBuffer instanceof ArrayBuffer ? new Uint8Array(fontBuffer) : fontBuffer;
            const font = FontLoader.loadPrimaryFont(bytes);
            this._primaryFonts.set(fontBuffer, font);
            // ponytail: freed only when the buffer is garbage collected; callers passing a new buffer
            // per call get a parse per call. Pass the same buffer, or add explicit disposal if that bites.
            primaryFontFinalizer?.register(fontBuffer, font);
        }
        return this._primaryFonts.get(fontBuffer);
    }

    _handleOutput(pngBuffer, outputOptions) {
        // If no specific output requested, return buffer
        if (!outputOptions || Object.keys(outputOptions).length === 0) {
            return pngBuffer;
        }

        // Handle single output format
        if (outputOptions.format) {
            switch (outputOptions.format) {
                case 'buffer':
                    return pngBuffer;
                case 'base64':
                    return toBase64(pngBuffer, outputOptions.dataURL);
                case 'file':
                    if (!outputOptions.path) {
                        throw new Error('File path required for file output');
                    }
                    return toFile(pngBuffer, outputOptions.path);
                default:
                    throw new Error(`Unsupported output format: ${outputOptions.format}`);
            }
        }

        // Handle multiple output formats
        return toMultipleFormats(pngBuffer, outputOptions);
    }
}

/**
 * Manifest of bundled font and data files.
 * Consumers (e.g. Workers fetching from R2) can use this to know which
 * assets to upload and provide at initialization time.
 */
export const FONT_MANIFEST = {
    fonts: { ...LOCAL_FONT_FILES },
    data: { twemoji: 'twemoji.json.br' },
};

/**
 * Create a rasterizer with pre-loaded fonts (no filesystem access needed).
 *
 * @param {Object} options
 * @param {Array<{name: string, weight?: number, data: Uint8Array}>} options.fonts
 *   Decompressed TTF font bytes. Names use spaces (e.g. 'Noto Sans SC').
 * @param {Uint8Array|Object} [options.emojiData]
 *   Decompressed twemoji.json content — Uint8Array of JSON, or pre-parsed object.
 * @param {boolean} [options.enableEmoji=true]
 * @param {boolean} [options.enableInternationalFonts=true]
 * @param {string} [options.fallbackFont='Noto+Sans']
 * @param {*} [options.wasmBuffer] resvg WASM buffer for Workers
 * @returns {Promise<UniversalSVGRenderer>}
 */
export async function createRasterizer(options = {}) {
    const {
        fonts = [],
        emojiData = null,
        ...rendererOptions
    } = options;

    // Create HarfBuzz font objects from provided decompressed TTF bytes
    const fontRegistry = new Map();
    for (const fontDef of fonts) {
        const normalizedName = fontDef.name.replace(/ /g, '+');
        const data = fontDef.data;
        const arrayBuffer = data.buffer
            ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
            : data;
        const fontObj = await createHbFont(arrayBuffer);
        fontRegistry.set(normalizedName, fontObj);
    }

    // Resolve fallback font from registry
    const fallbackName = (rendererOptions.fallbackFont || 'Noto+Sans').replace(/ /g, '+');
    const fallbackFontObj = fontRegistry.get(fallbackName) || null;

    // Set emoji data globally if provided
    if (emojiData) {
        let emojiMap;
        if (typeof emojiData === 'string') {
            emojiMap = JSON.parse(emojiData);
        } else if (emojiData instanceof Uint8Array || emojiData instanceof ArrayBuffer) {
            const bytes = emojiData instanceof ArrayBuffer ? new Uint8Array(emojiData) : emojiData;
            emojiMap = JSON.parse(new TextDecoder().decode(bytes));
        } else {
            emojiMap = emojiData;
        }
        await setEmojiData(emojiMap);
    }

    return new UniversalSVGRenderer({
        ...rendererOptions,
        _fontRegistry: fontRegistry,
        _fallbackFontObj: fallbackFontObj,
    });
}

// Export individual components for advanced usage
export { detectAndConvert, fromRawSVG, fromBase64, fromBuffer } from './adapters/input.js';
export { toBase64, toFile, toMultipleFormats } from './adapters/output.js';
export { extractAllTextContent, extractEmbeddedFont, extractFontFeatures, replaceTextElement, optimizeFilters } from './utils/svg-parser.js';
export { FontLoader, setHarfBuzzWasm, setFontData, createHbFont, LOCAL_FONT_FILES } from './renderers/font-loader.js';
export { setBrotliWasm, decompress } from './utils/decompress.js';
export { generateTextPaths, measureTextWidth, segmentGraphemes, isEmoji, loadEmojiSvg, applyRTLProcessing, setEmojiData } from './renderers/text-processor.js';
export { SVGRenderer } from './renderers/svg-renderer.js';

// Export default instance
export default new UniversalSVGRenderer();

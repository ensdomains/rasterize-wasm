/**
 * Rendering modules for Universal SVG Renderer
 */
export { FontLoader, setHarfBuzzWasm, setFontData, createHbFont, LOCAL_FONT_FILES } from './font-loader.js';
export { generateTextPaths, measureTextWidth, segmentGraphemes, isEmoji, loadEmojiSvg, applyRTLProcessing, setEmojiData } from './text-processor.js';
export { SVGRenderer } from './svg-renderer.js';

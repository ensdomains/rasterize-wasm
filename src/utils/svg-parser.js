/**
 * SVG parsing utilities
 */

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXmlEntities(text) {
    return text.replace(/&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/g, (entity, hex, dec, name) => {
        if (name) return XML_ENTITIES[name];
        const codePoint = hex ? parseInt(hex, 16) : Number(dec);
        return codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : entity;
    });
}

function stripInnerTags(content) {
    // Strip inner element tags (e.g. <tspan ...>...</tspan>) keeping only text, and decode
    // entities so "a&amp;b" is shaped as "a&b".
    // [^<>] keeps each match attempt bounded by the next '<' (no quadratic backtracking)
    return decodeXmlEntities(content.replace(/<[^<>]*>/g, '').trim());
}

function attr(str, name) {
    // Match both single- and double-quoted attribute values, with optional spaces around =.
    // Leading \s so 'x' doesn't match inside 'dx' (or 'fill' inside 'data-fill')
    const m = str.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']+)["']`));
    return m?.[1] ?? null;
}

function parseTranslate(str) {
    // Extract x, y from transform="translate(x, y)" or translate(x y)
    const m = str.match(/translate\(\s*([\d.+-]+)[\s,]+([\d.+-]+)\s*\)/);
    return m ? { tx: parseFloat(m[1]), ty: parseFloat(m[2]) } : null;
}

function normalizeFontWeight(raw) {
    if (!raw) return 400;
    const w = raw.trim().toLowerCase();
    const named = { thin: 100, extralight: 200, light: 300, normal: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800, black: 900 };
    return named[w] || parseInt(w, 10) || 400;
}

function parseTextElement(fullMatch, contentMatch) {
    const fontSizeRaw = attr(fullMatch, 'font-size');
    const fontSizeVal = fontSizeRaw ? parseFloat(fontSizeRaw) : 68;
    const fill = attr(fullMatch, 'fill') || 'white';
    const fontWeightRaw = attr(fullMatch, 'font-weight');
    let fontWeight = normalizeFontWeight(fontWeightRaw);
    const textAnchor = attr(fullMatch, 'text-anchor') || 'start';
    let x = parseFloat(attr(fullMatch, 'x') || '70');
    let y = parseFloat(attr(fullMatch, 'y') || '446');

    // Apply transform="translate(tx, ty)" offset
    const transform = attr(fullMatch, 'transform');
    if (transform) {
        const t = parseTranslate(transform);
        if (t) { x += t.tx; y += t.ty; }
    }

    // Also check CSS style attribute for overrides
    const styleMatch = fullMatch.match(/style=["']([^"']*)["']/);
    let styleFontSize, styleFill, styleFontWeight;
    if (styleMatch) {
        const style = styleMatch[1];
        const fsMat = style.match(/font-size:\s*(\d+\.?\d*)(?:px)?/);
        if (fsMat) styleFontSize = parseFloat(fsMat[1]);
        const fillMat = style.match(/(?:^|;)\s*fill:\s*([^;]+)/);
        if (fillMat) styleFill = fillMat[1].trim();
        const fwMat = style.match(/font-weight:\s*([^;]+)/);
        if (fwMat) styleFontWeight = normalizeFontWeight(fwMat[1]);
    }

    return {
        textElement: fullMatch,
        textContent: stripInnerTags(contentMatch),
        attributes: {
            fontSize: styleFontSize || fontSizeVal,
            fill: styleFill || fill,
            fontWeight: styleFontWeight || fontWeight,
            textAnchor,
            x,
            y
        }
    };
}

export function extractAllTextContent(svgString) {
    const regex = /<text\b[^<>]*>((?:(?!<text\b)[\s\S])*?)<\/text>/g;
    const results = [];
    let match;
    while ((match = regex.exec(svgString)) !== null) {
        results.push(parseTextElement(match[0], match[1]));
    }
    return results;
}

export function extractEmbeddedFont(svgString) {
    const fontDataMatch = svgString.match(/src:\s*url\(data:(?:font\/(?:truetype|woff2?|opentype)|application\/(?:x-font-ttf|font-woff2?|vnd\.ms-opentype))(?:;[^;)]+)*;base64,([^)]+)\)/);
    return fontDataMatch ? Buffer.from(fontDataMatch[1], 'base64') : null;
}

export function extractFontFeatures(svgString) {
    const features = [];
    // Extract each font-feature-settings value (up to the semicolon)
    const blockRegex = /font-feature-settings:\s*([^;}]+)/g;
    let block;
    while ((block = blockRegex.exec(svgString)) !== null) {
        const tagRegex = /"([a-z0-9]{4})"\s+on/g;
        let tag;
        while ((tag = tagRegex.exec(block[1])) !== null) {
            if (!features.includes(tag[1])) features.push(tag[1]);
        }
    }
    return features;
}

export function replaceTextElement(svgString, textElement, replacementContent) {
    // Function form: a string replacement would expand $&, $` and $' from SVG-controlled content
    return svgString.replace(textElement, () => replacementContent);
}

/**
 * Optimize SVG filters for faster resvg rendering.
 * Converts filterUnits="userSpaceOnUse" to "objectBoundingBox" which is
 * dramatically faster in resvg (~66x for feDropShadow) and removes absolute
 * dimension attributes that are invalid for objectBoundingBox coordinates.
 */
export function optimizeFilters(svgString) {
    // Match the whole tag first, then edit it; one combined regex backtracks quadratically
    const userSpace = /\sfilterUnits\s*=\s*["']userSpaceOnUse["']/;
    return svgString.replace(/<filter\b[^<>]*>/g, (tag) => {
        if (!userSpace.test(tag)) return tag;
        // Switch to objectBoundingBox and strip absolute x/y/width/height
        const attrs = tag.slice('<filter'.length, -1)
            .replace(userSpace, '')
            .replace(/\s(?:x|y|width|height)\s*=\s*["'][^"']*["']/g, '');
        return `<filter${attrs} filterUnits="objectBoundingBox">`;
    });
}

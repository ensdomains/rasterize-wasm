# rasterize-wasm

Universal SVG to PNG renderer that works with international text, emojis, and complex fonts.

## what it does

- Converts SVG to PNG using WASM (works in Cloudflare Workers)
- Handles CJK characters, Arabic, Hebrew, emojis, basically any Unicode
- All fonts bundled locally, no network requests
- Text shaping with harfbuzzjs (GSUB, ligatures, RTL)
- Fallback font system so text never disappears
- No server dependencies, no Canvas API

## install

```bash
yarn add rasterize-wasm
```

## basic usage

```javascript
import { UniversalSVGRenderer } from 'rasterize-wasm';

const renderer = new UniversalSVGRenderer();

// from SVG string
const pngBuffer = await renderer.render(svgString);

// to file
await renderer.render(svgString, { format: 'file', path: 'output.png' });

// to base64
const base64 = await renderer.render(svgString, { format: 'base64', dataURL: true });
```

## measuring text

`measureText` returns the width `render()` will give a piece of text: the same font per script, HarfBuzz shaping and emoji widths, without drawing anything. Use it to size things around text (a label, a box) before rendering.

```javascript
const width = await renderer.measureText('مرحبا.eth', 60, {
  primaryFont: satoshiBytes,   // the font the SVG embeds with @font-face
  features: ['ss01', 'tnum']   // what the SVG turns on with font-feature-settings
});
```

Pass the unescaped text (`a&b`, not `a&amp;b`). For multi-line text it returns the widest line. Text in `<text>` elements is entity-decoded before shaping, so `a&amp;b` renders as `a&b`.

## examples

| SVG Input | PNG Output |
|:---------:|:----------:|
| <img src="examples/assets/multi-script.svg" width="270" /> | <img src="examples/output/example2.png" width="270" /> |
| <img src="examples/assets/ens-japanese.svg" width="270" /> | <img src="examples/output/example5.png" width="270" /> |
| <img src="examples/assets/tanrikulu.eth.svg" width="270" /> | <img src="examples/output/example4-file.png" width="270" /> |

```javascript
// basic text
const svg = `<svg width="200" height="100">
  <text x="10" y="50" font-size="20">Hello 世界! 🌍</text>
</svg>`;

// custom fallback font
const renderer = new UniversalSVGRenderer({
  fallbackFont: 'Noto+Sans'
});

// multiple outputs at once
const results = await renderer.render(svg, {
  buffer: true,
  base64: true,
  file: 'output.png'
});
```

## how it works

1. extracts text from SVG
2. loads embedded fonts or bundled Noto Sans fallbacks
3. shapes text with harfbuzzjs (handles RTL, ligatures, GSUB features)
4. converts shaped glyphs to SVG paths
5. replaces original text elements with paths
6. renders final SVG to PNG with resvg-wasm

## why this exists

Every other solution either:
- doesn't handle international text
- requires system fonts
- needs Canvas API
- breaks on emojis, especially compound emojis (ZWJ sequences, flags, keycaps)
- doesn't work in Workers

This one actually works.

## cloudflare workers

WASM is bundled locally. For Workers, pass the WASM buffer:

```javascript
import wasmBuffer from './node_modules/rasterize-wasm/wasm/resvg.wasm';
import { UniversalSVGRenderer } from 'rasterize-wasm';

export default {
  async fetch(request, env) {
    const renderer = new UniversalSVGRenderer();
    const svg = await request.text();

    // Pass WASM buffer through render options
    const png = await renderer.render(svg, {
      buffer: true,
      wasmBuffer: wasmBuffer
    });

    return new Response(png, {
      headers: { 'Content-Type': 'image/png' }
    });
  }
}
```

Make sure your `wrangler.toml` has:
```toml
[build]
upload.format = "modules"
```

## run examples

```bash
yarn example
```

Check `examples/usage.js` for more patterns.

# WorldForge

A Svelte + TypeScript + Three.js foundation for a massive tiled heightmap editor.

The current v1 stores working worlds in OPFS as raw little-endian R16 tiles, builds lower-detail tile levels, renders a pooled terrain quadtree, and exports engine-facing 16-bit grayscale PNG tiles plus config JSON.

## Run

Install dependencies and start Vite:

```sh
npm install
npm run dev
```

## Checks

```sh
npm test
npm run build
```

Architecture notes for future edits live in [docs/architecture.md](docs/architecture.md).

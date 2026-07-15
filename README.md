# Keramos

An interactive pottery wheel in the browser.

A lump of clay spins on a wheel, drawn as white wireframe rings on black. Press and drag against the silhouette to shape it — push from the outside to neck the wall in, work from inside the bore to belly it out. Stroke upward to pull the wall thinner and taller, downward to gather it back thick. Press too hard and the clay tears and sprays. The spin continuously trues the wall as you work.

**Live:** [keramos.vercel.app](https://keramos.vercel.app)

## How it works

The clay is simulated as a stack of profile stations, each with a ring of material azimuth slots that carry per-slot radial deviation — so a gouge is a mark on the *clay*, and it rotates with the wheel. Azimuthal and vertical diffusion relax the material back toward a trued surface, and each band conserves its shell (radius × wall × length), so thinning a band lengthens the pot in place.

Rendering is a hand-rolled painter's algorithm on a 2D canvas: bands are projected with a pitched perspective camera, depth-sorted, filled opaque, and stroked as rings. No WebGL, no dependencies beyond React.

## Development

```sh
npm install
npm run dev      # start dev server
npm run build    # typecheck + production build
```

Built with React, TypeScript, and Vite.

## License

Copyright © 2026 Apostolos Christodoulou. All rights reserved.

The source is available to read, but no license is granted to use, copy, modify, or distribute it. See [LICENSE](LICENSE).

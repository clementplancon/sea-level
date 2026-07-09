/* =============================================================
   Sea-Level Visualiser — Application
   Data: AWS Open Data Terrain Tiles (SRTM/GEBCO, terrarium format)
   Map:  Leaflet.js + OpenTopoMap
   Encoding: elevation = R*256 + G + B/256 − 32768  (metres)
   ============================================================= */

'use strict';

// ── Constants ────────────────────────────────────────────────

const TERRAIN_URL =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

const TILE_SIZE = 256;

/** Scenario descriptions keyed by approximate sea-level value */
const SCENARIOS = [
  { at: -120, text: 'Maximum glaciaire (−20 000 ans) — le niveau était environ 120 m plus bas.' },
  { at: -60,  text: 'Niveau bas glaciaire — de vastes plateaux continentaux étaient à découvert.' },
  { at: -10,  text: 'Légère régression marine — quelques zones côtières émergent.' },
  { at:   0,  text: 'Niveau actuel des océans.' },
  { at:   1,  text: 'Projection 2100 (scénario bas) — élévation d\'environ +0,5 m attendue.' },
  { at:   3,  text: 'Élévation modérée — de nombreux deltas et atolls sont menacés.' },
  { at:   7,  text: 'Fonte totale des glaces du Groenland (+7 m) — côtes mondiales profondément remaniées.' },
  { at:  20,  text: 'Fonte partielle des calottes polaires — grandes villes côtières submergées.' },
  { at:  65,  text: 'Fonte de toutes les glaces terrestres (+65 m) — niveau maximal envisageable.' },
  { at: 200,  text: 'Scénario extrême théorique — pas de référence paléoclimatique directe.' },
];

// ── FloodLayer ───────────────────────────────────────────────

/**
 * Custom Leaflet GridLayer that:
 *  1. Fetches AWS terrarium terrain tiles.
 *  2. Decodes elevation per pixel.
 *  3. Paints a blue flood overlay for every pixel ≤ the chosen sea level.
 *  4. Caches decoded elevation data so changing the sea level is near-instant.
 */
const FloodLayer = L.GridLayer.extend({

  initialize(options) {
    L.setOptions(this, options);
    this._elevCache = new Map(); // "z/x/y" → Float32Array
  },

  createTile(coords, done) {
    const canvas = document.createElement('canvas');
    canvas.width  = TILE_SIZE;
    canvas.height = TILE_SIZE;

    const key = `${coords.z}/${coords.x}/${coords.y}`;

    if (this._elevCache.has(key)) {
      // Already decoded — just repaint
      requestAnimationFrame(() => {
        this._paint(canvas, this._elevCache.get(key));
        done(null, canvas);
      });
      return canvas;
    }

    const url = TERRAIN_URL
      .replace('{z}', coords.z)
      .replace('{x}', coords.x)
      .replace('{y}', coords.y);

    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.addEventListener('load', () => {
      const elev = this._decode(img);
      this._elevCache.set(key, elev);
      this._paint(canvas, elev);
      done(null, canvas);
    });

    img.addEventListener('error', () => {
      // Tile unavailable — deliver transparent canvas silently
      done(null, canvas);
    });

    img.src = url;
    return canvas;
  },

  // ── Private ────────────────────────────────────────────────

  /**
   * Decode terrarium-format PNG to a Float32Array of elevation values.
   * elevation = R*256 + G + B/256 − 32768  (metres, sub-metre precision)
   */
  _decode(img) {
    const off = Object.assign(document.createElement('canvas'),
      { width: TILE_SIZE, height: TILE_SIZE });
    const ctx = off.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
    const elev = new Float32Array(TILE_SIZE * TILE_SIZE);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      elev[j] = data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768;
    }
    return elev;
  },

  /**
   * Paint the canvas from cached elevation data + current sea level.
   *
   * Colour strategy:
   *   • Existing ocean (elev < 0, sea == 0) → deep navy → mid-blue gradient
   *   • Sea-level raised, originally dry land flooded → bright translucent aqua
   *   • Sea-level lowered below 0 → only truly deep areas remain blue
   *   • Above current sea level → fully transparent (basemap shows through)
   */
  _paint(canvas, elev) {
    const sea = this.options.seaLevel;
    const ctx = canvas.getContext('2d');
    const out = ctx.createImageData(TILE_SIZE, TILE_SIZE);
    const d   = out.data;

    for (let i = 0; i < elev.length; i++) {
      const e = elev[i];
      if (e > sea) continue; // above water → transparent (default alpha=0)

      const p = i << 2; // i * 4
      const depth = sea - e; // metres below sea surface

      if (e < 0) {
        // ── Natural ocean basin (bathymetry) ──────────────────
        // Deep = dark navy; shallow = medium blue
        const t = Math.min(-e / 4000, 1); // 0 = 0 m depth, 1 = 4000 m depth
        d[p]     = Math.round(  6 + t *  8);   // R   6–14
        d[p + 1] = Math.round( 42 - t * 22);   // G  42–20
        d[p + 2] = Math.round(130 + t * 80);   // B 130–210
        d[p + 3] = 185;
      } else {
        // ── Newly flooded land ────────────────────────────────
        // Bright translucent aqua; deeper = more saturated
        const t = Math.min(depth / 80, 1);     // 0 = just flooded, 1 = ≥80 m deep
        d[p]     = Math.round( 14 + t *  8);   // R  14–22
        d[p + 1] = Math.round(120 - t * 40);   // G 120–80
        d[p + 2] = Math.round(215 - t * 15);   // B 215–200
        d[p + 3] = Math.round(170 + t * 45);   // A 170–215
      }
    }

    ctx.putImageData(out, 0, 0);
  },

  // ── Public API ─────────────────────────────────────────────

  /**
   * Update the sea level and fast-repaint every loaded tile from cache.
   * No network requests are triggered.
   */
  setSeaLevel(level) {
    this.options.seaLevel = level;
    for (const key in this._tiles) {
      const { el: canvas, coords } = this._tiles[key];
      const cacheKey = `${coords.z}/${coords.x}/${coords.y}`;
      if (this._elevCache.has(cacheKey)) {
        this._paint(canvas, this._elevCache.get(cacheKey));
      }
    }
  },

  /**
   * Return the terrain elevation (metres) at a given LatLng + zoom level,
   * or null if that tile has not yet been loaded.
   */
  getElevationAt(latlng, zoom) {
    const z = Math.round(zoom);
    const scale = Math.pow(2, z);
    const sinLat = Math.sin(latlng.lat * Math.PI / 180);

    // Tile-fractional coordinates
    const fx = (latlng.lng + 180) / 360 * scale;
    const fy = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;

    const tx = Math.floor(fx);
    const ty = Math.floor(fy);
    const px = Math.floor((fx - tx) * TILE_SIZE);
    const py = Math.floor((fy - ty) * TILE_SIZE);

    const elev = this._elevCache.get(`${z}/${tx}/${ty}`);
    return elev ? elev[py * TILE_SIZE + px] : null;
  },
});

// ── Map initialisation ───────────────────────────────────────

const map = L.map('map', {
  center:   [30, 10],
  zoom:      3,
  minZoom:   2,
  maxZoom:  14,
  zoomSnap:  0.5,
});

// Basemap: OpenTopoMap — topographic relief, free, no API key
L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
  maxZoom: 17,
  attribution:
    '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> ' +
    '© <a href="https://opentopomap.org">OpenTopoMap</a> ' +
    '<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>',
}).addTo(map);

// Flood overlay
const floodLayer = new FloodLayer({ seaLevel: 0, opacity: 1, zIndex: 400 });
floodLayer.addTo(map);

// ── DOM references ───────────────────────────────────────────

const sliderEl   = document.getElementById('slider');
const valueEl    = document.getElementById('value');
const scenarioEl = document.getElementById('scenario-desc');
const cursorEl   = document.getElementById('cursor-elev');
const hintEl     = document.getElementById('hint');

// ── Scenario description helper ──────────────────────────────

function getScenarioText(level) {
  // Find the scenario whose 'at' value is closest to level
  let best = SCENARIOS[0];
  let bestDist = Infinity;
  for (const s of SCENARIOS) {
    const d = Math.abs(s.at - level);
    if (d < bestDist) { bestDist = d; best = s; }
  }
  return best.text;
}

// ── Core update function ─────────────────────────────────────

let rafId = null;

function applyLevel(raw, instant) {
  const level = Math.max(-100, Math.min(200, Math.round(+raw)));

  // Sync slider position without firing another event
  sliderEl.value = level;

  // Display value with sign
  const sign = level > 0 ? '+' : '';
  valueEl.textContent  = sign + level + '\u202fm'; // narrow no-break space
  valueEl.dataset.sign = level > 0 ? 'pos' : level < 0 ? 'neg' : 'zero';

  // Scenario text
  scenarioEl.textContent = getScenarioText(level);

  // Active preset highlight
  document.querySelectorAll('.preset').forEach(btn => {
    btn.classList.toggle('active', +btn.dataset.level === level);
  });

  // Flood repaint — use rAF to coalesce rapid slider drags
  if (instant) {
    floodLayer.setSeaLevel(level);
  } else {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => floodLayer.setSeaLevel(level));
  }
}

// ── Controls ─────────────────────────────────────────────────

sliderEl.addEventListener('input', () => applyLevel(sliderEl.value, false));

document.querySelectorAll('.preset').forEach(btn => {
  btn.addEventListener('click', () => applyLevel(+btn.dataset.level, true));
});

// Keyboard support on slider
sliderEl.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 10 : 1;
  let v = +sliderEl.value;
  if (e.key === 'ArrowUp' || e.key === 'ArrowRight')  v += step;
  if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') v -= step;
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) {
    e.preventDefault();
    applyLevel(v, false);
  }
});

// ── Cursor elevation readout ─────────────────────────────────

map.on('mousemove', (e) => {
  const elev = floodLayer.getElevationAt(e.latlng, map.getZoom());
  if (elev !== null) {
    const rounded = Math.round(elev);
    cursorEl.textContent = (rounded >= 0 ? '+' : '') + rounded + '\u202fm';
  } else {
    cursorEl.textContent = '—';
  }
});

map.on('mouseout', () => { cursorEl.textContent = '—'; });

// ── Hint auto-dismiss ────────────────────────────────────────

if (hintEl) {
  setTimeout(() => {
    hintEl.classList.add('fade-out');
    setTimeout(() => hintEl.remove(), 550);
  }, 4500);
}

// ── Init ─────────────────────────────────────────────────────

applyLevel(0, true);

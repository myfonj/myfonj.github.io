// Single visible canvas, painted directly. The picture is rendered by a pool
// of workers into a LAYER: an offscreen canvas holding a grid of tiles,
// addressed toroidally (tile (tx, ty) of the world lives in slot
// (tx mod nx, ty mod ny)), so panning never copies pixels - tiles that fall
// out of the area around the view are simply overwritten by tiles entering it.
// The visible canvas is a window onto the layer.
//
// What gets rendered next is decided continuously, not queued: whenever a
// worker is free it is handed the most valuable missing piece for the current
// camera - tiles in view that have nothing yet, then tiles around the view
// that have nothing yet, then in-view tiles that are only coarse, then the
// rest. Moving the camera therefore re-prioritises instantly, and finished
// tiles are kept (nothing is discarded or restarted).
//
// A zoom changes the scale, which invalidates every tile; the previous layer
// stays around, scaled (blurry), underneath until the new one covers the view.
// Anything not yet decided above the baseline shows as a darker "skeleton".

const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d', { alpha: false });
const hud = document.getElementById('hud');
const cusp = document.getElementById('cusp');
const cuspLabel = cusp.querySelector('.label');
const params = new URLSearchParams(location.search);
const debug = params.has('debug');
if (!debug) hud.style.display = 'none';

const BACKGROUND = 'dimgray'; // known-empty: below the baseline, left of x = 0
const SKELETON = '#363636'; // not decided yet: above the baseline, halfway between the two picture colours
const SS = Number(params.get('ss')) || 3; // fine pass: vertical sub-rows per device pixel (horizontal coverage is exact)
const HAIR = params.has('hair') ? Number(params.get('hair')) : 0.4; // min visible width (device px) of sub-pixel slivers
const TW = 64; // tile size in device pixels
const TH = 16;
const RUN_MAX = 16; // tiles per job along x
const MARGIN_X = 0.75; // area kept around the view, in viewport widths/heights
const MARGIN_Y = 0.4;
const NEW_LAYER_MIN_INTERVAL = 100; // ms; throttles layer creation while zooming
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

const camera = { cx: 4000, cy: 0, scale: 1 }; // scale: world units per device pixel
let dpr = 1;
let W = 1;
let H = 1;
let cameraInitialized = false;

const mod = (a, n) => ((a % n) + n) % n;

// --- Layers ---

let nextLayerId = 1;
let layer = null; // being rendered, drawn on top
let old = null; // previous scale, drawn underneath until `layer` covers the view
const layers = new Map(); // id -> layer, while workers may still deliver for it
const canvasPool = [];
let lastLayerAt = 0;

function createLayer() {
	const nx = Math.ceil((W * (1 + 2 * MARGIN_X)) / TW);
	const ny = Math.ceil((H * (1 + 2 * MARGIN_Y)) / TH);
	let el = canvasPool.pop();
	if (!el) el = document.createElement('canvas');
	if (el.width !== nx * TW || el.height !== ny * TH) {
		el.width = nx * TW;
		el.height = ny * TH;
	}
	const L = {
		id: nextLayerId++,
		scale: camera.scale,
		nx,
		ny,
		el,
		ctx: el.getContext('2d', { alpha: false }),
		ownerX: new Int32Array(nx * ny).fill(0x7fffffff),
		ownerY: new Int32Array(nx * ny).fill(0x7fffffff),
		quality: new Uint8Array(nx * ny), // 0 nothing, 1 coarse, 2 fine
		busy: new Uint8Array(nx * ny),
		inflight: 0,
		released: false,
		D: 0,
	};
	// Largest divisor drawn, like the original pen (even): follows the view
	// (number at the right edge of the area kept around it). Fixed per layer;
	// a layer is replaced once the view outgrows it.
	const nRight = (camera.cx + (W / 2) * (1 + 2 * MARGIN_X) * camera.scale) / 2;
	L.D = 2 * Math.ceil((Math.max(4, nRight) * 1.1) / 2);
	layers.set(L.id, L);
	return L;
}

function releaseLayer(L) {
	L.released = true;
	if (L.inflight === 0) {
		layers.delete(L.id);
		canvasPool.push(L.el);
	}
}

function newLayer() {
	if (layer) {
		if (old) releaseLayer(old);
		old = null;
		if (visibleCoverage(layer) > 0.5) old = layer;
		else releaseLayer(layer);
	}
	layer = createLayer();
	lastLayerAt = performance.now();
}

// --- Geometry of the view in a layer's pixel grid ---

// Pixel rect of the view in L's grid for the current camera; k = layer pixels
// to screen pixels.
function viewPixels(L) {
	const k = L.scale / camera.scale;
	const cxp = camera.cx / L.scale;
	const cyp = camera.cy / L.scale;
	if (Math.abs(k - 1) < 1e-9) {
		// same grid: snap to whole pixels so tiles blit 1:1
		return { k: 1, x0: Math.round(cxp - W / 2), y0: Math.round(cyp - H / 2), w: W, h: H };
	}
	const w = W / k;
	const h = H / k;
	return { k, x0: cxp - w / 2, y0: cyp - h / 2, w, h };
}

function tileRange(v) {
	return {
		tx0: Math.floor(v.x0 / TW),
		tx1: Math.floor((v.x0 + v.w - 1) / TW),
		ty0: Math.floor(v.y0 / TH),
		ty1: Math.floor((v.y0 + v.h - 1) / TH),
	};
}

function slotOf(L, tx, ty) {
	return mod(ty, L.ny) * L.nx + mod(tx, L.nx);
}

// below the baseline or left of x = 0: nothing is ever drawn there
function knownEmpty(L, tx, ty) {
	return ty >= 0 || (tx + 1) * TW * L.scale <= 0;
}

function tileQuality(L, tx, ty) {
	const s = slotOf(L, tx, ty);
	return L.ownerX[s] === tx && L.ownerY[s] === ty ? L.quality[s] : 0;
}

// fraction of the tiles visible now that hold at least a coarse picture
function visibleCoverage(L) {
	if (!L) return 0;
	const r = tileRange(viewPixels(L));
	let have = 0;
	let total = 0;
	for (let ty = r.ty0; ty <= r.ty1; ty++) {
		for (let tx = r.tx0; tx <= r.tx1; tx++) {
			total++;
			if (knownEmpty(L, tx, ty) || tileQuality(L, tx, ty) >= 1) have++;
		}
	}
	return have / total;
}

// --- Worker pool and scheduling ---

const POOL = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
const idle = [];
let jobsDone = 0;

for (let i = 0; i < POOL; i++) {
	const w = new Worker('worker.js');
	w.onmessage = (e) => {
		const { layerId, sx, sy, n, tier, buf } = e.data;
		idle.push(w);
		jobsDone++;
		const L = layers.get(layerId);
		if (L) {
			L.ctx.putImageData(new ImageData(new Uint8ClampedArray(buf.buffer), n * TW, TH), sx * TW, sy * TH);
			for (let k = 0; k < n; k++) {
				const s = sy * L.nx + sx + k;
				L.quality[s] = tier + 1;
				L.busy[s] = 0;
			}
			L.inflight--;
			if (L.released && L.inflight === 0) {
				layers.delete(L.id);
				canvasPool.push(L.el);
			}
			if (L === layer || L === old) scheduleDraw();
		}
		pump();
	};
	idle.push(w);
}

// The most valuable missing piece for the current camera, as a run of tiles
// along x in one tile row, or null when `layer` is complete.
function pickJob() {
	const L = layer;
	if (!L || Math.abs(camera.scale / L.scale - 1) > 1e-9) return null;
	const v = viewPixels(L);
	const vis = tileRange(v);
	const ccx = Math.floor((v.x0 + W / 2) / TW);
	const ccy = Math.floor((v.y0 + H / 2) / TH);
	const x0 = ccx - Math.floor(L.nx / 2);
	const y0 = ccy - Math.floor(L.ny / 2);
	let bestScore = Infinity;
	let bestTx = 0;
	let bestTy = 0;
	let bestQ = 0;
	let found = false;
	for (let ty = y0; ty < y0 + L.ny; ty++) {
		if (ty >= 0) continue; // rows at/below the baseline are known-empty, never rendered
		const dy = (ty + 0.5) * TH - (v.y0 + H / 2);
		const visY = ty >= vis.ty0 && ty <= vis.ty1;
		for (let tx = x0; tx < x0 + L.nx; tx++) {
			if (knownEmpty(L, tx, ty)) continue;
			const s = slotOf(L, tx, ty);
			if (L.busy[s]) continue;
			const q = L.ownerX[s] === tx && L.ownerY[s] === ty ? L.quality[s] : 0;
			if (q >= 2) continue;
			const visible = visY && tx >= vis.tx0 && tx <= vis.tx1;
			const dx = (tx + 0.5) * TW - (v.x0 + W / 2);
			const score = ((q === 0 ? 0 : 2) + (visible ? 0 : 1)) * 1e9 + dx * dx + dy * dy;
			if (score < bestScore) {
				bestScore = score;
				bestTx = tx;
				bestTy = ty;
				bestQ = q;
				found = true;
			}
		}
	}
	if (!found) return null;
	// extend along x over neighbouring tiles that need the same thing
	const sx = mod(bestTx, L.nx);
	const sy = mod(bestTy, L.ny);
	// zoomed far out a wide run leaves the fast path in geometry.js (window
	// divisors) and costs far more than its tiles separately - keep jobs short
	const runMax = Math.max(1, Math.min(RUN_MAX, Math.floor(L.D / (8 * L.scale * TW))));
	let n = 1;
	while (n < runMax && sx + n < L.nx && bestTx + n < x0 + L.nx) {
		const tx = bestTx + n;
		const s = sy * L.nx + sx + n;
		if (L.busy[s]) break;
		const q = L.ownerX[s] === tx && L.ownerY[s] === bestTy ? L.quality[s] : 0;
		if (q !== bestQ) break;
		n++;
	}
	return { L, tx: bestTx, ty: bestTy, sx, sy, n, q: bestQ };
}

function pump() {
	while (idle.length) {
		const p = pickJob();
		if (!p) break;
		const { L, tx, ty, sx, sy, n, q } = p;
		for (let k = 0; k < n; k++) {
			const s = sy * L.nx + sx + k;
			if (L.ownerX[s] !== tx + k || L.ownerY[s] !== ty) {
				L.ownerX[s] = tx + k;
				L.ownerY[s] = ty;
				L.quality[s] = 0;
			}
			L.busy[s] = 1;
		}
		L.inflight++;
		const coarse = q === 0;
		idle.pop().postMessage({
			layerId: L.id, sx, sy, n, tier: coarse ? 0 : 1,
			j0: ty * TH, rows: TH, i0: tx * TW, cols: n * TW,
			rowStep: coarse ? 2 : 1, ss: coarse ? 1 : SS, scale: L.scale, D: L.D, hair: HAIR,
		});
	}
	// once the new layer shows something everywhere, the old preview can go
	if (old && visibleCoverage(layer) >= 1) {
		releaseLayer(old);
		old = null;
	}
	updateHud();
}

// --- Compositing ---

// Blit the tiles of L that cover the view onto the canvas, scaled by k.
function drawLayer(L) {
	const v = viewPixels(L);
	const r = tileRange(v);
	ctx.imageSmoothingEnabled = Math.abs(v.k - 1) > 1e-9;
	for (let ty = r.ty0; ty <= r.ty1; ty++) {
		const sy = mod(ty, L.ny);
		let tx = r.tx0;
		while (tx <= r.tx1) {
			if (tileQuality(L, tx, ty) < 1) {
				tx++;
				continue;
			}
			// longest run of loaded tiles, contiguous in the layer canvas
			const sx = mod(tx, L.nx);
			let n = 1;
			while (tx + n <= r.tx1 && sx + n < L.nx && tileQuality(L, tx + n, ty) >= 1) n++;
			ctx.drawImage(
				L.el, sx * TW, sy * TH, n * TW, TH,
				(tx * TW - v.x0) * v.k, (ty * TH - v.y0) * v.k, n * TW * v.k, TH * v.k,
			);
			tx += n;
		}
	}
}

function draw() {
	ctx.fillStyle = BACKGROUND;
	ctx.fillRect(0, 0, W, H);
	// skeleton: the part of the view where the picture lives (above the
	// baseline, right of x = 0) and hasn't been drawn yet
	const baselineY = Math.min(H, Math.ceil(H / 2 - camera.cy / camera.scale));
	const originX = Math.max(0, Math.floor(W / 2 - camera.cx / camera.scale));
	if (baselineY > 0 && originX < W) {
		ctx.fillStyle = SKELETON;
		ctx.fillRect(originX, 0, W - originX, baselineY);
	}
	if (old) drawLayer(old);
	if (layer) drawLayer(layer);
}

let drawScheduled = false;
function scheduleDraw() {
	if (drawScheduled) return;
	drawScheduled = true;
	requestAnimationFrame(() => {
		drawScheduled = false;
		draw();
		updateCusp();
		updateHud();
	});
}

let retryTimer = null;
function cameraMoved() {
	scheduleDraw();
	const needsLayer =
		!layer ||
		Math.abs(camera.scale / layer.scale - 1) > 1e-9 ||
		(camera.cx + (W / 2) * camera.scale) / 2 > layer.D; // view has outgrown the layer's divisor limit
	if (needsLayer) {
		const wait = NEW_LAYER_MIN_INTERVAL - (performance.now() - lastLayerAt);
		if (wait > 0) {
			clearTimeout(retryTimer);
			retryTimer = setTimeout(cameraMoved, wait);
		} else {
			newLayer();
			pump();
		}
	} else {
		pump();
	}
}

// --- Cusp marker, HUD ---

function updateCusp() {
	const halfW = (W / 2) * camera.scale;
	const halfH = (H / 2) * camera.scale;
	const yMin = camera.cy - halfH;
	const yMax = camera.cy + halfH;
	const xMin = camera.cx - halfW;
	const cuspN = Math.round(camera.cx / 2);
	if (0 >= yMin && 0 <= yMax) {
		cusp.style.left = ((2 * cuspN - xMin) / (2 * halfW)) * (W / dpr) + 'px';
		cusp.style.top = ((0 - yMin) / (yMax - yMin)) * (H / dpr) + 'px';
		cusp.style.display = 'block';
		cuspLabel.textContent = number.format(cuspN);
	} else {
		cusp.style.display = 'none';
	}
}

function updateHud() {
	if (!debug) return;
	let fine = 0;
	let coarse = 0;
	let total = 0;
	if (layer && Math.abs(camera.scale / layer.scale - 1) < 1e-9) {
		const r = tileRange(viewPixels(layer));
		for (let ty = r.ty0; ty <= r.ty1; ty++) {
			for (let tx = r.tx0; tx <= r.tx1; tx++) {
				total++;
				const q = knownEmpty(layer, tx, ty) ? 2 : tileQuality(layer, tx, ty);
				if (q === 2) fine++;
				else if (q === 1) coarse++;
			}
		}
	}
	hud.textContent =
		`N ≈ ${number.format(camera.cx / 2)}\n${(1 / camera.scale).toFixed(3)} px/unit\n` +
		`${POOL} workers · view ${W}×${H} · layer ${layer ? layer.nx * TW + '×' + layer.ny * TH : '-'}\n` +
		`visible tiles: ${fine} fine · ${coarse} coarse · ${total - fine - coarse} missing\n` +
		`jobs done: ${jobsDone}${old ? ' · old layer underneath' : ''}\n` +
		`drag to pan · scroll to zoom`;
}

function resize() {
	dpr = window.devicePixelRatio || 1;
	W = Math.max(1, Math.round(window.innerWidth * dpr));
	H = Math.max(1, Math.round(window.innerHeight * dpr));
	canvas.width = W;
	canvas.height = H;
	if (!cameraInitialized) {
		camera.scale = 40 / W; // ~20 integers across the width
		camera.cx = 4000; // integer 2,000
		camera.cy = -(H * 0.2) * camera.scale; // baseline at 70% down, room for the cusp label
		cameraInitialized = true;
	}
	if (old) releaseLayer(old);
	if (layer) releaseLayer(layer);
	old = layer = null;
	newLayer();
	pump();
	scheduleDraw();
}

// --- Input ---

let dragging = false;
let lastX = 0;
let lastY = 0;
canvas.addEventListener('pointerdown', (e) => {
	dragging = true;
	lastX = e.clientX;
	lastY = e.clientY;
	canvas.classList.add('dragging');
	canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
	if (!dragging) return;
	camera.cx -= (e.clientX - lastX) * dpr * camera.scale;
	camera.cy -= (e.clientY - lastY) * dpr * camera.scale;
	lastX = e.clientX;
	lastY = e.clientY;
	cameraMoved();
});
function endDrag() {
	dragging = false;
	canvas.classList.remove('dragging');
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

canvas.addEventListener(
	'wheel',
	(e) => {
		e.preventDefault();
		const px = e.clientX * dpr;
		const py = e.clientY * dpr;
		const worldX = camera.cx + (px - W / 2) * camera.scale;
		const worldY = camera.cy + (py - H / 2) * camera.scale;
		camera.scale *= Math.exp(e.deltaY * 0.0015);
		camera.cx = worldX - (px - W / 2) * camera.scale;
		camera.cy = worldY - (py - H / 2) * camera.scale;
		cameraMoved();
	},
	{ passive: false },
);

window.addEventListener('resize', resize);
resize();

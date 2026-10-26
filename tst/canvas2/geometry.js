// Row renderer for the divisor-arc picture. Pure functions, no DOM.
//
// World space: x = 2 * integer-index, y-down, baseline at y = 0. Divisor d
// contributes half-disks of radius d centered at x = d, 3d, 5d, ... on the
// baseline; a point is black when an odd number of them cover it.
//
// Exact horizontal coverage: on a horizontal line at height a = |y| the
// half-disk between cusps k0 = 2*d*i and k1 = k0 + 2d is the interval
// (k0 + delta, k1 - delta), delta = d - sqrt(d^2 - a^2) (only for d > a).
// Every interval end is a "toggle" of the parity. Sorting the toggles that
// fall inside the view gives exact black/gray runs along the row, so a
// sub-pixel sliver - the thin fan of lines above a highly composite cusp -
// contributes its true fractional coverage to its pixel instead of being
// stepped over by point samples. (Vertical antialiasing is supersampled.)
//
// Intervals that cover the whole row (all large d) only flip the starting
// parity. For d > R = max over the row's ends of (x^2 + a^2) / 2x that is
// closed form (floor(R) mod 2 for an even limit D), so only d <= R is
// looped over.
//
// D is the largest divisor drawn (always even, so the picture doesn't invert
// as it changes). Outside the circle of radius D tangent to the y-axis
// nothing is drawn: the void in the top-left of the original pen, whose
// divisor limit also followed its viewport.

const BG_GRAY = 105; // dimgray; foreground is black, so a pixel's gray = BG_GRAY * (1 - coverage)

// Divisors that can have an interval end inside the window [xL, xR] when the
// end sits within 1 world unit of a cusp (true for d > a^2): every d with a
// cusp 2*d*i in [xL - 1, xR + 1], i.e. the divisors of the integers in
// [(xL - 1) / 2, (xR + 1) / 2]. All other large d simply cover the whole
// window, which is why per-row work doesn't have to visit every divisor.
// Returns a sorted, de-duplicated Float64Array, or null when it isn't worth it
// (window near x = 0, or so wide that the set is as big as D).
function windowDivisors(xL, xR, D) {
	if (!(xL - 1 > 0) || !isFinite(D)) return null;
	const nLo = Math.ceil((xL - 1) / 2);
	const nHi = Math.floor((xR + 1) / 2);
	if ((nHi - nLo + 1) * 16 > D) return null;
	const all = [];
	for (let n = nLo; n <= nHi; n++) {
		for (let p = 1; p * p <= n; p++) {
			if (n % p === 0) {
				if (p <= D) all.push(p);
				const q = n / p;
				if (q !== p && q <= D) all.push(q);
			}
		}
	}
	const arr = Float64Array.from(all).sort();
	let m = 0;
	for (let i = 0; i < arr.length; i++) if (i === 0 || arr[i] !== arr[i - 1]) arr[m++] = arr[i];
	return arr.subarray(0, m);
}

// Adds, to cov[0..W), the black length (in pixels) of the row at height a
// = -y > 0 over the world window [xL, xL + W*s]. `pos` is scratch, grown on
// demand; the (possibly reallocated) array is returned. `diff` is scratch of
// W + 2. `flag` is windowDivisors() or null. `hair` (pixels, 0 = off): a run
// that begins and ends inside one pixel is counted as at least this wide, so
// sub-pixel slivers stay visible instead of fading to nothing.
function rowCoverage(a, xL, s, W, D, flag, hair, cov, diff, pos) {
	const xR = xL + W * s;
	const a2 = a * a;
	let init = 0;
	let n = 0;

	const addDivisor = (d) => {
		const twoD = 2 * d;
		const delta = a2 / (d + Math.sqrt(d * d - a2));
		let i = Math.floor((xL + delta) / twoD);
		if (i < 0) i = 0;
		const iEnd = Math.ceil((xR - delta) / twoD) - 1;
		if (n + 2 * (iEnd - i + 1) > pos.length) {
			const bigger = new Float64Array(Math.max(pos.length * 2, n + 2 * (iEnd - i + 1) + 1024));
			bigger.set(pos.subarray(0, n));
			pos = bigger;
		}
		for (; i <= iEnd; i++) {
			const e1 = twoD * i + delta;
			const e2 = twoD * (i + 1) - delta;
			if (e1 < xL) init ^= 1;
			else if (e1 < xR) pos[n++] = e1;
			if (e2 < xL) init ^= 1;
			else if (e2 < xR) pos[n++] = e2;
		}
	};

	const dmin = Math.floor(a) + 1;
	if (flag) {
		// d > a^2: ends are within 1 unit of a cusp, so only flagged d matter;
		// every other d covers the whole window.
		const dB = Math.min(D, Math.ceil(a2) + 1);
		for (let d = dmin; d <= dB; d++) addDivisor(d);
		if (D > dB) {
			init ^= (D - dB) & 1;
			let lo = 0;
			let hi = flag.length;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (flag[mid] > dB) hi = mid;
				else lo = mid + 1;
			}
			for (let k = lo; k < flag.length; k++) {
				init ^= 1; // undo the "covers the whole window" assumption
				addDivisor(flag[k]);
			}
		}
	} else {
		let dMax = D;
		if (xL > 0) {
			// d > R covers the whole window; for an even D that's floor(R) mod 2
			const rm = Math.max((xL * xL + a2) / (2 * xL), (xR * xR + a2) / (2 * xR));
			const fl = Math.floor(rm);
			if (fl < D) {
				dMax = fl;
				init ^= fl % 2;
			}
		}
		for (let d = dmin; d <= dMax; d++) addDivisor(d);
	}

	const sorted = pos.subarray(0, n).sort();
	diff.fill(0, 0, W + 2);
	const inv = 1 / s;
	let state = init;
	let prev = xL;
	for (let k = 0; k <= n; k++) {
		const t = k < n ? sorted[k] : xR;
		const pu = (prev - xL) * inv;
		const pv = (t - xL) * inv;
		const iu = Math.floor(pu);
		const iv = Math.min(W - 1, Math.floor(pv));
		const bounded = k > 0 && k < n; // both ends are toggles
		if (iu === iv) {
			let len = pv - pu;
			if (bounded && hair > 0 && len < hair) len = hair;
			if (state) cov[iu] += len;
			else if (bounded && hair > 0) cov[iu] -= len - (pv - pu); // widen the gray run at black's expense
		} else if (state) {
			cov[iu] += iu + 1 - pu;
			cov[iv] += pv - iv;
			diff[iu + 1] += 1;
			diff[iv] -= 1;
		}
		prev = t;
		state ^= 1;
	}
	let run = 0;
	for (let c = 0; c < W; c++) {
		run += diff[c];
		cov[c] += run;
	}
	return pos;
}

// Renders pixel rows [j0, j1) and pixel columns [i0, i0 + cols) of the
// picture at `scale` world units per pixel into a row-major RGBA strip
// (cols wide). Pixel (i, j) spans world [i, i+1) * scale in x and
// [j, j+1) * scale in y, so the grid is anchored at the world origin and tiles
// rendered at different times line up exactly. Rows with j >= 0 are at or
// below the baseline.
//  - rowStep > 1: only every rowStep-th row is evaluated (at the centre of
//    its group) and replicated - the cheap preview pass.
//  - ss > 1: every pixel row is the average of ss sub-rows.
function renderRows(j0, j1, i0, cols, rowStep, ss, scale, D, hair) {
	const rh = j1 - j0;
	const buf = new Uint32Array(rh * cols);
	const cov = new Float64Array(cols);
	const diff = new Float64Array(cols + 2);
	let pos = new Float64Array(4096);
	const xL = i0 * scale;
	const flag = windowDivisors(xL, xL + cols * scale, D);
	const levels = 256;
	const lut = new Uint32Array(levels + 1);
	for (let n = 0; n <= levels; n++) {
		const v = Math.round(BG_GRAY * (1 - n / levels));
		lut[n] = 0xff000000 | (v << 16) | (v << 8) | v;
	}
	for (let g = 0; g < rh; g += rowStep) {
		const gh = Math.min(rowStep, rh - g);
		cov.fill(0);
		for (let sy = 0; sy < ss; sy++) {
			const y = (j0 + g + (gh * (sy + 0.5)) / ss) * scale;
			if (y < 0) pos = rowCoverage(-y, xL, scale, cols, D, flag, hair, cov, diff, pos);
		}
		const k = levels / ss;
		for (let c = 0; c < cols; c++) {
			const color = lut[Math.max(0, Math.min(levels, Math.round(cov[c] * k)))];
			for (let j = 0; j < gh; j++) buf[(g + j) * cols + c] = color;
		}
	}
	return buf;
}

if (typeof module !== 'undefined') module.exports = { rowCoverage, renderRows, windowDivisors };

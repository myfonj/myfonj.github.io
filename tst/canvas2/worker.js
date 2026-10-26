importScripts('geometry.js');

self.onmessage = (e) => {
	const job = e.data;
	const buf = renderRows(job.j0, job.j0 + job.rows, job.i0, job.cols, job.rowStep, job.ss, job.scale, job.D, job.hair);
	self.postMessage({ layerId: job.layerId, sx: job.sx, sy: job.sy, n: job.n, tier: job.tier, buf }, [buf.buffer]);
};

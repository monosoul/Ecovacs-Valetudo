/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampInt(value, min, max) {
    if (!Number.isFinite(value)) {
        return min;
    }

    return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * @param {any} transform
 * @param {number} worldXmm
 * @param {number} worldYmm
 * @param {number} pixelSizeCm
 * @returns {Array<number>|null}
 */
function worldMmToMapPointCm(transform, worldXmm, worldYmm, pixelSizeCm) {
    if (!Number.isFinite(worldXmm) || !Number.isFinite(worldYmm)) {
        return null;
    }
    const mapWidthPx = Number(transform.mapWidthPx);
    const mapHeightPx = Number(transform.mapHeightPx);
    const mmPerPixel = Number(transform.mmPerPixel);
    if (!Number.isFinite(mapWidthPx) || !Number.isFinite(mapHeightPx) || !Number.isFinite(mmPerPixel) || mmPerPixel <= 0) {
        return null;
    }
    const cx = mapWidthPx / 2.0;
    const cy = mapHeightPx / 2.0;
    const x = clampInt(Math.round(cx + (worldXmm / mmPerPixel)), 0, mapWidthPx - 1);
    const y = clampInt(Math.round(cy - (worldYmm / mmPerPixel)), 0, mapHeightPx - 1);

    return [x * pixelSizeCm, y * pixelSizeCm];
}

/**
 * @param {any} transform
 * @param {number} mapXcm
 * @param {number} mapYcm
 * @param {number} pixelSizeCm
 * @returns {{x:number,y:number}|null}
 */
function mapCmToWorldMm(transform, mapXcm, mapYcm, pixelSizeCm) {
    if (!Number.isFinite(mapXcm) || !Number.isFinite(mapYcm) || !Number.isFinite(pixelSizeCm) || pixelSizeCm <= 0) {
        return null;
    }
    const mapWidthPx = Number(transform.mapWidthPx);
    const mapHeightPx = Number(transform.mapHeightPx);
    const mmPerPixel = Number(transform.mmPerPixel);
    if (!Number.isFinite(mapWidthPx) || !Number.isFinite(mapHeightPx) || !Number.isFinite(mmPerPixel) || mmPerPixel <= 0) {
        return null;
    }
    const cx = mapWidthPx / 2.0;
    const cy = mapHeightPx / 2.0;
    const xPx = mapXcm / pixelSizeCm;
    const yPx = mapYcm / pixelSizeCm;

    return {
        x: Math.round((xPx - cx) * mmPerPixel),
        y: Math.round((cy - yPx) * mmPerPixel)
    };
}

module.exports = {
    clampInt: clampInt,
    mapCmToWorldMm: mapCmToWorldMm,
    worldMmToMapPointCm: worldMmToMapPointCm,
};

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

/**
 * @param {any} map
 * @returns {{transform: any, pixelSizeCm: number}}
 */
function getMapTransformParams(map) {
    const transform = map?.metaData?.ecovacsTransform;
    const pixelSizeCm = Number(map?.pixelSize ?? 0);
    if (!transform || !Number.isFinite(pixelSizeCm) || pixelSizeCm <= 0) {
        throw new Error("Map transform is not available");
    }

    return {transform: transform, pixelSizeCm: pixelSizeCm};
}

/**
 * @param {any} map
 * @param {import("../../../entities/core/ValetudoZone")} zone
 * @returns {[number,number,number,number]}
 */
function mapZoneToWorldRect(map, zone) {
    const {transform, pixelSizeCm} = getMapTransformParams(map);
    const points = [zone.points?.pA, zone.points?.pB, zone.points?.pC, zone.points?.pD]
        .filter(Boolean)
        .map(point => {
            return mapCmToWorldMm(transform, Number(point.x), Number(point.y), pixelSizeCm);
        })
        .filter(Boolean);
    if (points.length === 0) {
        throw new Error("Invalid zone points");
    }
    const xs = points.map(point => point.x);
    const ys = points.map(point => point.y);

    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * @param {any} map
 * @param {{x:number,y:number}} point
 * @returns {{x:number,y:number}}
 */
function mapPointToWorld(map, point) {
    const {transform, pixelSizeCm} = getMapTransformParams(map);
    const world = mapCmToWorldMm(transform, Number(point?.x), Number(point?.y), pixelSizeCm);
    if (!world) {
        throw new Error("Invalid map point");
    }

    return world;
}

/**
 * @param {any} map
 * @param {{x:number,y:number}} point
 * @returns {{x:number,y:number}|null}
 */
function worldPointToMap(map, point) {
    const transform = map?.metaData?.ecovacsTransform;
    const pixelSizeCm = Number(map?.pixelSize ?? 0);
    if (!transform || !Number.isFinite(pixelSizeCm) || pixelSizeCm <= 0) {
        return null;
    }
    const mapped = worldMmToMapPointCm(transform, Number(point?.x), Number(point?.y), pixelSizeCm);
    if (!mapped || mapped.length < 2) {
        return null;
    }

    return {
        x: mapped[0],
        y: mapped[1]
    };
}

module.exports = {
    clampInt: clampInt,
    mapCmToWorldMm: mapCmToWorldMm,
    mapPointToWorld: mapPointToWorld,
    mapZoneToWorldRect: mapZoneToWorldRect,
    worldMmToMapPointCm: worldMmToMapPointCm,
    worldPointToMap: worldPointToMap,
};

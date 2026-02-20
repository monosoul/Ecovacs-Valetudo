const mapEntities = require("../../../entities/map");

/**
 * @param {import("../../../entities/map/ValetudoMap")} map
 * @returns {number}
 */
function getTotalLayerPixelCount(map) {
    const layers = Array.isArray(map?.layers) ? map.layers : [];

    return layers.reduce((sum, layer) => {
        const px = Number(layer?.dimensions?.pixelCount ?? 0);

        return sum + (Number.isFinite(px) ? px : 0);
    }, 0);
}

/**
 * @param {import("../../../entities/map/ValetudoMap")} map
 * @param {string} layerType
 * @returns {number}
 */
function getLayerPixelCountByType(map, layerType) {
    const layers = Array.isArray(map?.layers) ? map.layers : [];

    return layers
        .filter(layer => layer?.type === layerType)
        .reduce((sum, layer) => {
            const px = Number(layer?.dimensions?.pixelCount ?? 0);

            return sum + (Number.isFinite(px) ? px : 0);
        }, 0);
}

/**
 * @param {import("../../../entities/map/ValetudoMap")} map
 * @returns {string}
 */
function formatMapStats(map) {
    const widthCm = Number(map?.size?.x ?? 0);
    const heightCm = Number(map?.size?.y ?? 0);
    const pixelSize = Number(map?.pixelSize ?? 0);
    const layers = Array.isArray(map?.layers) ? map.layers : [];
    const entitiesCount = Array.isArray(map?.entities) ? map.entities.length : 0;
    const totalPixels = getTotalLayerPixelCount(map);
    const layerSummary = layers.map(layer => {
        const px = Number(layer?.dimensions?.pixelCount ?? 0);
        const cpx = Array.isArray(layer?.compressedPixels) ? layer.compressedPixels.length : 0;

        return `${layer.type}:${Number.isFinite(px) ? px : 0}(rle=${cpx})`;
    }).join(",");
    const payloadBytes = estimateMapPayloadBytes(map);

    return `size_cm=${widthCm}x${heightCm} pixel_cm=${pixelSize} layers=${layers.length} entities=${entitiesCount} layer_pixels=${totalPixels} payload_bytes=${payloadBytes} [${layerSummary}]`;
}

/**
 * @param {import("../../../entities/map/ValetudoMap")} map
 * @returns {boolean}
 */
function hasRobotEntity(map) {
    return Array.isArray(map?.entities) && map.entities.some(entity => entity?.type === mapEntities.PointMapEntity.TYPE.ROBOT_POSITION);
}

/**
 * @param {import("../../../entities/map/ValetudoMap")} map
 * @returns {boolean}
 */
function hasChargerEntity(map) {
    return Array.isArray(map?.entities) && map.entities.some(entity => entity?.type === mapEntities.PointMapEntity.TYPE.CHARGER_LOCATION);
}

/**
 * @param {import("../../../entities/map/ValetudoMap")} map
 * @returns {number}
 */
function estimateMapPayloadBytes(map) {
    try {
        return Buffer.byteLength(JSON.stringify(map), "utf8");
    } catch (e) {
        return -1;
    }
}

module.exports = {
    estimateMapPayloadBytes: estimateMapPayloadBytes,
    formatMapStats: formatMapStats,
    getLayerPixelCountByType: getLayerPixelCountByType,
    getTotalLayerPixelCount: getTotalLayerPixelCount,
    hasChargerEntity: hasChargerEntity,
    hasRobotEntity: hasRobotEntity,
};

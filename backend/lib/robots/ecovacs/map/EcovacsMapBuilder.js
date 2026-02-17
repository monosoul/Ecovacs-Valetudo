const Logger = require("../../../Logger");
const mapEntities = require("../../../entities/map");
const {worldMmToMapPointCm} = require("./EcovacsMapTransforms");

const PIXEL_KEY_STRIDE = 65536;

/**
 * @param {Array<any>} rooms
 * @param {any} positions
 * @param {{x:number,y:number,angle:number}|null} robotPose
 * @param {object} [compressedMap]
 * @param {Array<{vwid:number,type:number,dots:Array<[number,number]>}>} [virtualWalls]
 * @param {{pixelSizeCm:number, cachedRoomCleaningPreferences:Object<string,{suction:number,water:number,times:number,sequence:number}>}} options
 * @returns {import("../../../entities/map/ValetudoMap")}
 */
function buildMapFromRooms(rooms, positions, robotPose, compressedMap, virtualWalls, options) {
    const pixelSizeCm = compressedMap?.resolutionCm ?? options.pixelSizeCm;
    const parsedRooms = rooms.map(room => {
        const polygon = Array.isArray(room.polygon) ? room.polygon : [];

        const cached = options.cachedRoomCleaningPreferences[String(room.index)] ?? {};

        return {
            index: String(room.index ?? "0"),
            labelName: room.label_name ?? `Room ${room.index ?? 0}`,
            preference_times: room.preference_times ?? cached.times,
            preference_water: room.preference_water ?? cached.water,
            preference_suction: room.preference_suction ?? cached.suction,
            preference_sequence: room.preference_sequence ?? cached.sequence ?? 0,
            polygonCm: polygon.map(point => {
                return {
                    x: Math.round(Number(point[0]) / 10),
                    y: Math.round(Number(point[1]) / 10)
                };
            })
        };
    }).filter(room => room.polygonCm.length >= 3);

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const room of parsedRooms) {
        for (const p of room.polygonCm) {
            if (p.x < minX) {
                minX = p.x;
            }
            if (p.x > maxX) {
                maxX = p.x;
            }
            if (p.y < minY) {
                minY = p.y;
            }
            if (p.y > maxY) {
                maxY = p.y;
            }
        }
    }
    const marginCm = pixelSizeCm * 4;
    const mapWidthPx = Math.ceil((maxX - minX + 2 * marginCm) / pixelSizeCm) + 1;
    const mapHeightPx = Math.ceil((maxY - minY + 2 * marginCm) / pixelSizeCm) + 1;

    const worldToGrid = (point) => {
        const shiftedX = point.x - minX + marginCm;
        const shiftedY = maxY - point.y + marginCm;

        return {
            x: Math.floor(shiftedX / pixelSizeCm),
            y: Math.floor(shiftedY / pixelSizeCm)
        };
    };

    const floorPixelSet = new Set();
    const segmentLayers = [];
    parsedRooms.forEach(room => {
        const gridPolygon = room.polygonCm.map(worldToGrid);
        const pixels = rasterizePolygon(gridPolygon);
        if (pixels.length === 0) {
            return;
        }

        pixels.forEach(pixel => {
            floorPixelSet.add(pixel[0] * PIXEL_KEY_STRIDE + pixel[1]);
        });

        segmentLayers.push(new mapEntities.MapLayer({
            type: mapEntities.MapLayer.TYPE.SEGMENT,
            pixels: pixels.sort(mapEntities.MapLayer.COORDINATE_TUPLE_SORT).flat(),
            metaData: buildSegmentMetaData(room.index, room.labelName, room, {})
        }));
    });

    let rasterFloorPixels = unpackPixelKeys(floorPixelSet);
    let rasterWallPixels = [];
    if (compressedMap) {
        try {
            const projected = projectCompressedMapToGrid(compressedMap, mapWidthPx, mapHeightPx, floorPixelSet);
            if (projected.floorPixels.length > 0) {
                rasterFloorPixels = projected.floorPixels;
            }
            rasterWallPixels = projected.wallPixels;
        } catch (e) {
            Logger.warn("Failed to project compressed Ecovacs raster into room grid", e);
        }
    }

    const layers = [];
    if (rasterFloorPixels.length > 0) {
        layers.push(new mapEntities.MapLayer({
            type: mapEntities.MapLayer.TYPE.FLOOR,
            pixels: rasterFloorPixels.sort(mapEntities.MapLayer.COORDINATE_TUPLE_SORT).flat()
        }));
    }
    if (rasterWallPixels.length > 0) {
        layers.push(new mapEntities.MapLayer({
            type: mapEntities.MapLayer.TYPE.WALL,
            pixels: rasterWallPixels.sort(mapEntities.MapLayer.COORDINATE_TUPLE_SORT).flat()
        }));
    }
    layers.push(...segmentLayers);

    const mapItems = [];
    const chargerPose = positions?.charger?.pose;
    if (chargerPose && typeof chargerPose.x === "number" && typeof chargerPose.y === "number") {
        const chargerGrid = worldToGrid({
            x: Math.round(chargerPose.x / 10),
            y: Math.round(chargerPose.y / 10)
        });
        mapItems.push(new mapEntities.PointMapEntity({
            type: mapEntities.PointMapEntity.TYPE.CHARGER_LOCATION,
            points: [
                chargerGrid.x * pixelSizeCm,
                chargerGrid.y * pixelSizeCm
            ]
        }));
    }
    if (robotPose) {
        const robotGrid = worldToGrid({
            x: Math.round(robotPose.x / 10),
            y: Math.round(robotPose.y / 10)
        });
        mapItems.push(new mapEntities.PointMapEntity({
            type: mapEntities.PointMapEntity.TYPE.ROBOT_POSITION,
            points: [
                robotGrid.x * pixelSizeCm,
                robotGrid.y * pixelSizeCm
            ],
            metaData: {
                angle: Number.isFinite(robotPose.angle) ? robotPose.angle : 0
            }
        }));
    }

    const mapWidthCm = mapWidthPx * pixelSizeCm;
    const mapHeightCm = mapHeightPx * pixelSizeCm;
    const transform = {
        type: "rooms",
        marginCm: marginCm,
        maxY: maxY,
        minX: minX,
        pixelSizeCm: pixelSizeCm
    };
    mapItems.push(...buildRestrictionEntities(transform, pixelSizeCm, virtualWalls));

    return new mapEntities.ValetudoMap({
        size: {
            x: mapWidthCm,
            y: mapHeightCm
        },
        pixelSize: pixelSizeCm,
        layers: layers,
        entities: mapItems,
        metaData: {
            ecovacsTransform: transform
        }
    });
}

/**
 * Build detailed raster and overlays with the same transforms used by
 * scripts/decode_map_dump.py + scripts/render_rooms_overlay.py.
 *
 * @param {Array<any>} rooms
 * @param {any} positions
 * @param {{x:number,y:number,angle:number}|null} robotPose
 * @param {{width:number,height:number,resolutionCm:number,floorPixels:Array<[number,number]>,wallPixels:Array<[number,number]>}} compressedMap
 * @param {Array<{vwid:number,type:number,dots:Array<[number,number]>}>} [virtualWalls]
 * @param {{rotationDegrees:number, worldMmPerPixel:number, cachedRoomCleaningPreferences:Object<string,{suction:number,water:number,times:number,sequence:number}>}} options
 * @returns {import("../../../entities/map/ValetudoMap")}
 */
function buildDetailedMapAlignedToSimplified(rooms, positions, robotPose, compressedMap, virtualWalls, options) {
    const pixelSizeCm = Number(compressedMap.resolutionCm);
    if (!Number.isFinite(pixelSizeCm) || pixelSizeCm <= 0) {
        throw new Error("Invalid compressed map pixel size");
    }
    const mapRotation = normalizeClockwiseRotation(options.rotationDegrees);
    const mmPerPixel = Number(options.worldMmPerPixel);
    if (!Number.isFinite(mmPerPixel) || mmPerPixel <= 0) {
        throw new Error("Invalid detailedMapWorldMmPerPixel");
    }

    const rotatedFloor = rotatePixelsClockwise(
        compressedMap.floorPixels,
        compressedMap.width,
        compressedMap.height,
        mapRotation
    );
    const rotatedWall = rotatePixelsClockwise(
        compressedMap.wallPixels,
        compressedMap.width,
        compressedMap.height,
        mapRotation
    );
    Logger.debug(
        `Ecovacs detailed map transform: rotation=${mapRotation}deg size=${rotatedFloor.width}x${rotatedFloor.height} mm_per_pixel=${mmPerPixel}`
    );

    const mapWidthPx = rotatedFloor.width;
    const mapHeightPx = rotatedFloor.height;
    const detailedLayers = [];

    if (rotatedFloor.pixels.length > 0) {
        detailedLayers.push(new mapEntities.MapLayer({
            type: mapEntities.MapLayer.TYPE.FLOOR,
            pixels: rotatedFloor.pixels.sort(mapEntities.MapLayer.COORDINATE_TUPLE_SORT).flat()
        }));
    }
    if (rotatedWall.pixels.length > 0) {
        detailedLayers.push(new mapEntities.MapLayer({
            type: mapEntities.MapLayer.TYPE.WALL,
            pixels: rotatedWall.pixels.sort(mapEntities.MapLayer.COORDINATE_TUPLE_SORT).flat()
        }));
    }

    for (const room of (Array.isArray(rooms) ? rooms : [])) {
        const polygon = Array.isArray(room?.polygon) ? room.polygon : [];
        const polygonGrid = polygon.map(point => {
            return worldToGridScriptCompatible(
                Number(point?.[0]),
                Number(point?.[1]),
                mapWidthPx,
                mapHeightPx,
                mmPerPixel
            );
        }).filter(Boolean).map(point => {
            return clampPointToBounds(point, mapWidthPx, mapHeightPx);
        });
        if (polygonGrid.length < 3) {
            continue;
        }
        const pixels = rasterizePolygon(polygonGrid);
        if (pixels.length === 0) {
            continue;
        }
        const cachedPrefs = options.cachedRoomCleaningPreferences[String(room.index)] ?? {};
        detailedLayers.push(new mapEntities.MapLayer({
            type: mapEntities.MapLayer.TYPE.SEGMENT,
            pixels: pixels.sort(mapEntities.MapLayer.COORDINATE_TUPLE_SORT).flat(),
            metaData: buildSegmentMetaData(
                String(room.index ?? "0"),
                room.label_name ?? `Room ${room.index ?? 0}`,
                room,
                cachedPrefs
            )
        }));
    }

    const detailedEntities = [];
    const chargerPose = positions?.charger?.pose;
    if (chargerPose && typeof chargerPose.x === "number" && typeof chargerPose.y === "number") {
        const chargerGrid = worldToGridScriptCompatible(
            Number(chargerPose.x),
            Number(chargerPose.y),
            mapWidthPx,
            mapHeightPx,
            mmPerPixel
        );
        if (chargerGrid) {
            detailedEntities.push(new mapEntities.PointMapEntity({
                type: mapEntities.PointMapEntity.TYPE.CHARGER_LOCATION,
                points: [
                    chargerGrid.x * pixelSizeCm,
                    chargerGrid.y * pixelSizeCm
                ]
            }));
        }
    }
    if (robotPose) {
        const robotGrid = worldToGridScriptCompatible(
            Number(robotPose.x),
            Number(robotPose.y),
            mapWidthPx,
            mapHeightPx,
            mmPerPixel
        );
        if (robotGrid) {
            detailedEntities.push(new mapEntities.PointMapEntity({
                type: mapEntities.PointMapEntity.TYPE.ROBOT_POSITION,
                points: [
                    robotGrid.x * pixelSizeCm,
                    robotGrid.y * pixelSizeCm
                ],
                metaData: {
                    angle: Number.isFinite(robotPose.angle) ? robotPose.angle : 0
                }
            }));
        }
    }
    const transform = {
        mapHeightPx: mapHeightPx,
        mapWidthPx: mapWidthPx,
        mmPerPixel: mmPerPixel,
        rotationDegrees: mapRotation,
        type: "script",
    };
    detailedEntities.push(...buildRestrictionEntities(transform, pixelSizeCm, virtualWalls));

    return new mapEntities.ValetudoMap({
        size: {
            x: mapWidthPx * pixelSizeCm,
            y: mapHeightPx * pixelSizeCm
        },
        pixelSize: pixelSizeCm,
        layers: detailedLayers,
        entities: detailedEntities,
        metaData: {
            ecovacsTransform: transform
        }
    });
}

/**
 * @param {import("../../../entities/map/ValetudoMap")} currentMap
 * @param {any} positions
 * @param {{x:number,y:number,angle:number}|null} robotPose
 * @param {Array<{x:number,y:number}>} [tracePathPointsMm]
 * @returns {import("../../../entities/map/ValetudoMap")|null}
 */
function rebuildEntitiesOnlyMap(currentMap, positions, robotPose, tracePathPointsMm) {
    const transform = currentMap?.metaData?.ecovacsTransform;
    if (!transform) {
        return null;
    }
    const pixelSizeCm = Number(currentMap?.pixelSize ?? 0);
    if (!Number.isFinite(pixelSizeCm) || pixelSizeCm <= 0) {
        return null;
    }

    const staticEntities = Array.isArray(currentMap.entities) ? currentMap.entities.filter(entity => {
        return entity?.type !== mapEntities.PointMapEntity.TYPE.CHARGER_LOCATION &&
            entity?.type !== mapEntities.PointMapEntity.TYPE.ROBOT_POSITION &&
            entity?.type !== mapEntities.PathMapEntity.TYPE.PATH;
    }) : [];
    const dynamicEntities = [];

    const chargerPose = positions?.charger?.pose;
    const chargerPoint = chargerPose ? worldMmToMapPointCm(transform, Number(chargerPose.x), Number(chargerPose.y), pixelSizeCm) : null;
    if (chargerPoint) {
        dynamicEntities.push(new mapEntities.PointMapEntity({
            type: mapEntities.PointMapEntity.TYPE.CHARGER_LOCATION,
            points: chargerPoint
        }));
    }

    if (robotPose) {
        const robotPoint = worldMmToMapPointCm(transform, Number(robotPose.x), Number(robotPose.y), pixelSizeCm);
        if (robotPoint) {
            dynamicEntities.push(new mapEntities.PointMapEntity({
                type: mapEntities.PointMapEntity.TYPE.ROBOT_POSITION,
                points: robotPoint,
                metaData: {
                    angle: Number.isFinite(robotPose.angle) ? robotPose.angle : 0
                }
            }));
        }
    }

    const pathPointsCm = [];
    for (const point of (Array.isArray(tracePathPointsMm) ? tracePathPointsMm : [])) {
        const mapped = worldMmToMapPointCm(transform, Number(point.x), Number(point.y), pixelSizeCm);
        if (!mapped) {
            continue;
        }
        pathPointsCm.push(mapped[0], mapped[1]);
    }
    if (pathPointsCm.length >= 4) {
        dynamicEntities.push(new mapEntities.PathMapEntity({
            type: mapEntities.PathMapEntity.TYPE.PATH,
            points: pathPointsCm
        }));
    }

    if (dynamicEntities.length === 0) {
        return null;
    }
    if (areDynamicEntitiesUnchanged(currentMap.entities, dynamicEntities)) {
        return null;
    }

    return new mapEntities.ValetudoMap({
        size: currentMap.size,
        pixelSize: currentMap.pixelSize,
        layers: currentMap.layers,
        entities: staticEntities.concat(dynamicEntities),
        metaData: currentMap.metaData
    });
}

// ---- Internal helpers ----

/**
 * @param {Array<{x:number,y:number}>} polygon
 * @returns {Array<[number, number]>}
 */
function rasterizePolygon(polygon) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of polygon) {
        if (p.x < minX) {
            minX = p.x;
        }
        if (p.x > maxX) {
            maxX = p.x;
        }
        if (p.y < minY) {
            minY = p.y;
        }
        if (p.y > maxY) {
            maxY = p.y;
        }
    }

    /** @type {Array<[number, number]>} */
    const pixels = [];
    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            if (pointInPolygon(x + 0.5, y + 0.5, polygon)) {
                pixels.push([x, y]);
            }
        }
    }

    return pixels;
}

/**
 * @param {number} x
 * @param {number} y
 * @param {Array<{x:number,y:number}>} polygon
 * @returns {boolean}
 */
function pointInPolygon(x, y, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i].x;
        const yi = polygon[i].y;
        const xj = polygon[j].x;
        const yj = polygon[j].y;

        const intersects = ((yi > y) !== (yj > y)) &&
            (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
        if (intersects) {
            inside = !inside;
        }
    }

    return inside;
}

/**
 * @param {{width:number,height:number,floorPixels:Array<[number,number]>,wallPixels:Array<[number,number]>}} compressedMap
 * @param {number} targetWidth
 * @param {number} targetHeight
 * @param {Set<number>} roomFloorSet  packed pixel keys (x * PIXEL_KEY_STRIDE + y)
 * @returns {{floorPixels:Array<[number,number]>,wallPixels:Array<[number,number]>}}
 */
function projectCompressedMapToGrid(compressedMap, targetWidth, targetHeight, roomFloorSet) {
    const projectionStartedAt = Date.now();
    const orientation = chooseBestProjectionOrientation(compressedMap, targetWidth, targetHeight, roomFloorSet);
    const floorSet = new Set();
    const wallSet = new Set();

    for (const [sx, sy] of compressedMap.floorPixels) {
        const p = projectSourcePointToTarget(sx, sy, compressedMap.width, compressedMap.height, targetWidth, targetHeight, orientation);
        if (p) {
            floorSet.add(p[0] * PIXEL_KEY_STRIDE + p[1]);
        }
    }
    for (const [sx, sy] of compressedMap.wallPixels) {
        const p = projectSourcePointToTarget(sx, sy, compressedMap.width, compressedMap.height, targetWidth, targetHeight, orientation);
        if (p) {
            wallSet.add(p[0] * PIXEL_KEY_STRIDE + p[1]);
        }
    }

    const floorPixels = unpackPixelKeys(floorSet);
    const wallPixels = unpackPixelKeys(wallSet);
    Logger.debug(
        `Ecovacs compressed map projection: orientation=${orientation}, floor=${floorPixels.length}, wall=${wallPixels.length}, took=${Date.now() - projectionStartedAt}ms`
    );

    return {
        floorPixels: floorPixels,
        wallPixels: wallPixels
    };
}

/**
 * @param {{width:number,height:number,floorPixels:Array<[number,number]>}} compressedMap
 * @param {number} targetWidth
 * @param {number} targetHeight
 * @param {Set<number>} roomFloorSet  packed pixel keys (x * PIXEL_KEY_STRIDE + y)
 * @returns {number}
 */
function chooseBestProjectionOrientation(compressedMap, targetWidth, targetHeight, roomFloorSet) {
    const maxSample = 4000;
    const step = Math.max(1, Math.floor(compressedMap.floorPixels.length / maxSample));

    let bestOrientation = 0;
    let bestScore = -1;
    for (let orientation = 0; orientation < 8; orientation++) {
        let score = 0;
        let checked = 0;
        for (let i = 0; i < compressedMap.floorPixels.length; i += step) {
            const [sx, sy] = compressedMap.floorPixels[i];
            const p = projectSourcePointToTarget(
                sx,
                sy,
                compressedMap.width,
                compressedMap.height,
                targetWidth,
                targetHeight,
                orientation
            );
            if (!p) {
                continue;
            }
            checked++;
            if (roomFloorSet.has(p[0] * PIXEL_KEY_STRIDE + p[1])) {
                score++;
            }
        }
        const normalized = checked > 0 ? (score / checked) : 0;
        if (normalized > bestScore) {
            bestScore = normalized;
            bestOrientation = orientation;
        }
    }

    return bestOrientation;
}

/**
 * @param {number} sx
 * @param {number} sy
 * @param {number} srcWidth
 * @param {number} srcHeight
 * @param {number} targetWidth
 * @param {number} targetHeight
 * @param {number} orientation
 * @returns {[number, number]|null}
 */
function projectSourcePointToTarget(sx, sy, srcWidth, srcHeight, targetWidth, targetHeight, orientation) {
    const transformed = orientPoint(sx, sy, srcWidth, srcHeight, orientation);
    if (!transformed) {
        return null;
    }
    const [ox, oy, ow, oh] = transformed;
    if (ow <= 1 || oh <= 1 || targetWidth <= 1 || targetHeight <= 1) {
        return null;
    }

    const tx = Math.round((ox / (ow - 1)) * (targetWidth - 1));
    const ty = Math.round((oy / (oh - 1)) * (targetHeight - 1));
    if (tx < 0 || ty < 0 || tx >= targetWidth || ty >= targetHeight) {
        return null;
    }

    return [tx, ty];
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @param {number} orientation
 * @returns {[number, number, number, number]|null}
 */
function orientPoint(x, y, width, height, orientation) {
    switch (orientation) {
        case 0:
            return [x, y, width, height];
        case 1:
            return [width - 1 - x, y, width, height];
        case 2:
            return [x, height - 1 - y, width, height];
        case 3:
            return [width - 1 - x, height - 1 - y, width, height];
        case 4:
            return [y, x, height, width];
        case 5:
            return [height - 1 - y, x, height, width];
        case 6:
            return [y, width - 1 - x, height, width];
        case 7:
            return [height - 1 - y, width - 1 - x, height, width];
        default:
            return null;
    }
}

/**
 * Unpack a Set of numeric pixel keys (x * PIXEL_KEY_STRIDE + y) into an array of [x, y] tuples.
 *
 * @param {Set<number>} set
 * @returns {Array<[number, number]>}
 */
function unpackPixelKeys(set) {
    const result = [];
    for (const key of set) {
        result.push([(key / PIXEL_KEY_STRIDE) | 0, key % PIXEL_KEY_STRIDE]);
    }

    return result;
}

/**
 * @param {number} rotation
 * @returns {number}
 */
function normalizeClockwiseRotation(rotation) {
    const raw = Number(rotation);
    if (!Number.isFinite(raw)) {
        return 270;
    }
    const normalized = ((Math.round(raw) % 360) + 360) % 360;
    if (normalized === 0 || normalized === 90 || normalized === 180 || normalized === 270) {
        return normalized;
    }

    return 270;
}

/**
 * Rotate pixel tuples by 0/90/180/270 degrees clockwise.
 *
 * @param {Array<[number,number]>} pixels
 * @param {number} width
 * @param {number} height
 * @param {number} rotation
 * @returns {{pixels:Array<[number,number]>,width:number,height:number}}
 */
function rotatePixelsClockwise(pixels, width, height, rotation) {
    const inPixels = Array.isArray(pixels) ? pixels : [];
    const out = [];
    if (rotation === 0) {
        for (const [x, y] of inPixels) {
            out.push([x, y]);
        }

        return {pixels: out, width: width, height: height};
    }
    if (rotation === 180) {
        for (const [x, y] of inPixels) {
            out.push([width - 1 - x, height - 1 - y]);
        }

        return {pixels: out, width: width, height: height};
    }
    if (rotation === 90) {
        for (const [x, y] of inPixels) {
            out.push([height - 1 - y, x]);
        }

        return {pixels: out, width: height, height: width};
    }
    if (rotation === 270) {
        for (const [x, y] of inPixels) {
            out.push([y, width - 1 - x]);
        }

        return {pixels: out, width: height, height: width};
    }

    return {pixels: out, width: width, height: height};
}

/**
 * Same center-based transform as scripts/render_rooms_overlay.py.
 *
 * @param {number} worldXmm
 * @param {number} worldYmm
 * @param {number} mapWidthPx
 * @param {number} mapHeightPx
 * @param {number} mmPerPixel
 * @returns {{x:number,y:number}|null}
 */
function worldToGridScriptCompatible(worldXmm, worldYmm, mapWidthPx, mapHeightPx, mmPerPixel) {
    if (!Number.isFinite(worldXmm) || !Number.isFinite(worldYmm)) {
        return null;
    }
    const cx = mapWidthPx / 2.0;
    const cy = mapHeightPx / 2.0;

    return {
        x: Math.round(cx + (worldXmm / mmPerPixel)),
        y: Math.round(cy - (worldYmm / mmPerPixel))
    };
}

/**
 * @param {{x:number,y:number}} point
 * @param {number} width
 * @param {number} height
 * @returns {{x:number,y:number}}
 */
function clampPointToBounds(point, width, height) {
    return {
        x: Math.max(0, Math.min(width - 1, Math.round(point.x))),
        y: Math.max(0, Math.min(height - 1, Math.round(point.y)))
    };
}

/**
 * Build segment layer metadata for a room, with cache fallback.
 *
 * @param {string} segmentId
 * @param {string} name
 * @param {{preference_times?:number, preference_water?:number, preference_suction?:number, preference_sequence?:number}} room
 * @param {{times?:number, water?:number, suction?:number, sequence?:number}} cachedPrefs
 * @returns {{segmentId:string, name:string, roomCleaningPreferences:{times:number, water:number, suction:number}, roomCleaningSequence:number}}
 */
function buildSegmentMetaData(segmentId, name, room, cachedPrefs) {
    return {
        segmentId: segmentId,
        name: name,
        roomCleaningPreferences: {
            times: room.preference_times ?? cachedPrefs.times,
            water: room.preference_water ?? cachedPrefs.water,
            suction: room.preference_suction ?? cachedPrefs.suction
        },
        roomCleaningSequence: room.preference_sequence ?? cachedPrefs.sequence ?? 0
    };
}

/**
 * @param {any} transform
 * @param {number} pixelSizeCm
 * @param {Array<{vwid:number,type:number,dots:Array<[number,number]>}>} [virtualWalls]
 * @returns {Array<any>}
 */
function buildRestrictionEntities(transform, pixelSizeCm, virtualWalls) {
    /** @type {Array<any>} */
    const entitiesOut = [];
    for (const wall of (Array.isArray(virtualWalls) ? virtualWalls : [])) {
        const pointsCm = (Array.isArray(wall.dots) ? wall.dots : []).map(dot => {
            return worldMmToMapPointCm(transform, Number(dot?.[0]), Number(dot?.[1]), pixelSizeCm);
        }).filter(Boolean);
        if (pointsCm.length < 2) {
            continue;
        }
        const flattened = pointsCm.flat();
        if (pointsCm.length >= 3) {
            const xs = pointsCm.map(point => point[0]);
            const ys = pointsCm.map(point => point[1]);
            const minX = Math.min(...xs);
            const maxX = Math.max(...xs);
            const minY = Math.min(...ys);
            const maxY = Math.max(...ys);
            if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) {
                continue;
            }
            const normalizedRect = [
                minX, minY,
                maxX, minY,
                maxX, maxY,
                minX, maxY
            ];
            entitiesOut.push(new mapEntities.PolygonMapEntity({
                type: wall.type === 1 ?
                    mapEntities.PolygonMapEntity.TYPE.NO_MOP_AREA :
                    mapEntities.PolygonMapEntity.TYPE.NO_GO_AREA,
                points: normalizedRect
            }));
        } else {
            entitiesOut.push(new mapEntities.LineMapEntity({
                type: mapEntities.LineMapEntity.TYPE.VIRTUAL_WALL,
                points: flattened
            }));
        }
    }

    return entitiesOut;
}

/**
 * Check whether the dynamic entities (robot, charger, path) in the current
 * map already match the newly computed ones by comparing points arrays
 * element-by-element. Avoids JSON.stringify on every live-position poll.
 *
 * @param {Array<any>} currentEntities
 * @param {Array<any>} newDynamic
 * @returns {boolean}
 */
function areDynamicEntitiesUnchanged(currentEntities, newDynamic) {
    const oldEntities = Array.isArray(currentEntities) ? currentEntities : [];
    for (const newEntity of newDynamic) {
        const match = oldEntities.find(e => e?.type === newEntity?.type);
        if (!match) {
            return false;
        }
        const oldPts = match.points;
        const newPts = newEntity.points;
        if (!Array.isArray(oldPts) || !Array.isArray(newPts) || oldPts.length !== newPts.length) {
            return false;
        }
        for (let i = 0; i < oldPts.length; i++) {
            if (oldPts[i] !== newPts[i]) {
                return false;
            }
        }
        // Compare angle metadata (robot position)
        if ((match.metaData?.angle ?? 0) !== (newEntity.metaData?.angle ?? 0)) {
            return false;
        }
    }

    return true;
}

module.exports = {
    buildDetailedMapAlignedToSimplified: buildDetailedMapAlignedToSimplified,
    buildMapFromRooms: buildMapFromRooms,
    rebuildEntitiesOnlyMap: rebuildEntitiesOnlyMap,
};

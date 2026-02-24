const fs = require("fs");
const Logger = require("../../../Logger");
const {decodeEcovacsLzmaPayload} = require("./EcovacsCompressedMapDecoder");

const CARPET_MAP_PATH = "/data/FILES/autosave/carpetMap.7z";
const CARPET_MAP_GRID_SIDE = 1200;
const CARPET_MAP_RESOLUTION_MM = 50;

/**
 * Read and decode the persisted carpet map from /data/FILES/autosave/carpetMap.7z.
 *
 * The file is LZMA-compressed (same custom header as compressed map submaps)
 * containing a 1200x1200 uint8 grid at 50mm/pixel, centered at world origin.
 * Non-zero pixels indicate carpet.
 *
 * @param {string} [filePath]
 * @returns {Array<Array<number>>} Array of carpet polygon point arrays [x1,y1,x2,y2,...] in world mm
 */
function readCarpetMap(filePath) {
    const path = filePath ?? CARPET_MAP_PATH;

    let raw;
    try {
        raw = fs.readFileSync(path);
    } catch (e) {
        Logger.debug(`Ecovacs carpet map: file not readable (${path}): ${e.message}`);
        return [];
    }

    if (raw.length < 10) {
        Logger.debug("Ecovacs carpet map: file too short");
        return [];
    }

    let grid;
    try {
        grid = decodeEcovacsLzmaPayload(raw);
    } catch (e) {
        Logger.warn(`Ecovacs carpet map: LZMA decompress failed: ${e.message}`);
        return [];
    }

    const expectedSize = CARPET_MAP_GRID_SIDE * CARPET_MAP_GRID_SIDE;
    if (grid.length !== expectedSize) {
        Logger.warn(`Ecovacs carpet map: unexpected grid size ${grid.length} (expected ${expectedSize})`);
        return [];
    }

    const carpetPixels = [];
    for (let y = 0; y < CARPET_MAP_GRID_SIDE; y++) {
        const rowOffset = y * CARPET_MAP_GRID_SIDE;
        for (let x = 0; x < CARPET_MAP_GRID_SIDE; x++) {
            if (grid[rowOffset + x] !== 0) {
                carpetPixels.push([x, y]);
            }
        }
    }

    if (carpetPixels.length === 0) {
        Logger.debug("Ecovacs carpet map: no carpet pixels found");
        return [];
    }

    Logger.debug(`Ecovacs carpet map: ${carpetPixels.length} carpet pixels`);

    const bounds = findComponentBounds(carpetPixels, CARPET_MAP_GRID_SIDE);
    const center = CARPET_MAP_GRID_SIDE / 2;
    const rectangles = [];

    for (const b of bounds) {
        // +1 to include the far edge of the last pixel
        const x0 = (b.minX - center) * CARPET_MAP_RESOLUTION_MM;
        const y0 = (center - b.minY) * CARPET_MAP_RESOLUTION_MM;
        const x1 = (b.maxX + 1 - center) * CARPET_MAP_RESOLUTION_MM;
        const y1 = (center - (b.maxY + 1)) * CARPET_MAP_RESOLUTION_MM;
        rectangles.push([x0, y0, x1, y0, x1, y1, x0, y1]);
    }

    Logger.debug(`Ecovacs carpet map: ${rectangles.length} carpet rectangle(s)`);
    return rectangles;
}

/**
 * Find bounding boxes of connected components using flood-fill (4-connectivity).
 *
 * @param {Array<[number,number]>} pixels
 * @param {number} gridSide
 * @returns {Array<{minX:number,maxX:number,minY:number,maxY:number}>}
 */
function findComponentBounds(pixels, gridSide) {
    const pixelSet = new Set(pixels.map(([x, y]) => y * gridSide + x));
    const visited = new Set();
    const results = [];

    for (const [x, y] of pixels) {
        const key = y * gridSide + x;
        if (visited.has(key)) {
            continue;
        }

        let minX = x, maxX = x, minY = y, maxY = y;
        const stack = [[x, y]];

        while (stack.length > 0) {
            const [cx, cy] = stack.pop();
            const ck = cy * gridSide + cx;

            if (visited.has(ck) || !pixelSet.has(ck)) {
                continue;
            }

            visited.add(ck);

            if (cx < minX) {
                minX = cx;
            }
            if (cx > maxX) {
                maxX = cx;
            }
            if (cy < minY) {
                minY = cy;
            }
            if (cy > maxY) {
                maxY = cy;
            }

            if (cx > 0) {
                stack.push([cx - 1, cy]);
            }
            if (cx < gridSide - 1) {
                stack.push([cx + 1, cy]);
            }
            if (cy > 0) {
                stack.push([cx, cy - 1]);
            }
            if (cy < gridSide - 1) {
                stack.push([cx, cy + 1]);
            }
        }

        results.push({minX: minX, maxX: maxX, minY: minY, maxY: maxY});
    }

    return results;
}

module.exports = {readCarpetMap: readCarpetMap};

const BinaryCursor = require("../ros/protocol/BinaryCursor");
const Logger = require("../../../Logger");
const lzma = require("lzma-purejs");
require("../lzmaPurejsPkgIncludes");

/**
 * @param {{mapid:number,info:{mapWidth:number,mapHeight:number,columns:number,rows:number,submapWidth:number,submapHeight:number,resolution:number},submaps:Array<{data:Buffer}>}} response
 * @returns {{width:number,height:number,columns:number,rows:number,submapWidth:number,submapHeight:number,resolutionCm:number,floorPixels:Array<[number,number]>,wallPixels:Array<[number,number]>}}
 */
function decodeCompressedMapResponse(response) {
    const decodeStartedAt = Date.now();
    const info = response.info;
    const expectedSubmaps = info.columns * info.rows;
    if (!Array.isArray(response.submaps) || response.submaps.length < expectedSubmaps) {
        throw new Error(`Compressed map response incomplete: expected ${expectedSubmaps}, got ${response.submaps?.length ?? 0}`);
    }

    /** @type {Array<[number, number]>} */
    const floorPixels = [];
    /** @type {Array<[number, number]>} */
    const wallPixels = [];

    for (let tileIndex = 0; tileIndex < response.submaps.length; tileIndex++) {
        const submap = response.submaps[tileIndex];
        const decoded = decodeEcovacsCompressedSubmap(submap.data);
        const expectedTileLen = info.submapWidth * info.submapHeight;
        if (decoded.length !== expectedTileLen) {
            throw new Error(`Tile length mismatch for submap ${tileIndex}: ${decoded.length} != ${expectedTileLen}`);
        }

        const tileRow = Math.floor(tileIndex / info.columns);
        const tileCol = tileIndex % info.columns;
        const baseX = tileCol * info.submapWidth;
        const baseY = tileRow * info.submapHeight;

        for (let y = 0; y < info.submapHeight; y++) {
            const srcOffset = y * info.submapWidth;
            for (let x = 0; x < info.submapWidth; x++) {
                const value = decoded[srcOffset + x];
                const mapX = baseX + x;
                const mapY = baseY + y;
                if (value === 1) {
                    floorPixels.push([mapX, mapY]);
                } else if (value === 2 || value === 255) {
                    wallPixels.push([mapX, mapY]);
                }
            }
        }
    }

    const result = {
        width: info.mapWidth,
        height: info.mapHeight,
        columns: info.columns,
        rows: info.rows,
        submapWidth: info.submapWidth,
        submapHeight: info.submapHeight,
        resolutionCm: inferCompressedMapPixelSizeCm(info.resolution),
        floorPixels: floorPixels,
        wallPixels: wallPixels
    };
    Logger.debug(
        `Ecovacs compressed map decode: ${response.submaps.length} submaps, floor=${floorPixels.length}, wall=${wallPixels.length}, took=${Date.now() - decodeStartedAt}ms`
    );

    return result;
}

/**
 * @param {Buffer} raw
 * @returns {Uint8Array}
 */
function decodeEcovacsCompressedSubmap(raw) {
    if (!Buffer.isBuffer(raw) || raw.length < 10) {
        throw new Error("Compressed submap payload is too short");
    }

    const cursor = new BinaryCursor(raw);
    const propsAndDict = cursor.readBuffer(5);
    const uncompressedSize = cursor.readUInt32LE();
    const lzmaPayload = cursor.readBuffer(cursor.remaining());

    const lzmaAloneHeader = Buffer.alloc(13);
    propsAndDict.copy(lzmaAloneHeader, 0, 0, 5);
    lzmaAloneHeader.writeUInt32LE(uncompressedSize, 5);
    lzmaAloneHeader.writeUInt32LE(0, 9);

    const combined = Buffer.concat([lzmaAloneHeader, lzmaPayload]);
    const decoded = lzma.decompressFile(combined);
    const out = decoded instanceof Uint8Array ? decoded : Uint8Array.from(decoded);
    if (out.length !== uncompressedSize) {
        throw new Error(`Decoded submap length mismatch: ${out.length} != ${uncompressedSize}`);
    }

    return out;
}

/**
 * Ecovacs `resolution` is observed as 50 for 5cm maps.
 * Treat values >= 20 as millimeters, otherwise centimeters.
 *
 * @param {number} raw
 * @returns {number}
 */
function inferCompressedMapPixelSizeCm(raw) {
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0) {
        return 5;
    }
    if (v >= 20) {
        return Math.max(1, Math.round(v / 10));
    }

    return Math.max(1, Math.round(v));
}

module.exports = {
    decodeCompressedMapResponse: decodeCompressedMapResponse,
    decodeEcovacsLzmaPayload: decodeEcovacsCompressedSubmap,
};

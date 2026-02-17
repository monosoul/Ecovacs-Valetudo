const lzma = require("lzma-purejs");
require("../lzmaPurejsPkgIncludes");

/**
 * Decode one ManipulateTrace raw hex chunk:
 * [5B props+dict][4B usize32 LE][LZMA stream], uncompressed records: <int16 x><int16 y><u8 flag>
 *
 * @param {string} rawHex
 * @param {number} unitMm
 * @returns {Array<{x:number,y:number,flag:number}>}
 */
function decodeTraceRawHexToWorldMmPoints(rawHex, unitMm) {
    const raw = Buffer.from(String(rawHex ?? ""), "hex");
    if (raw.length < 10) {
        return [];
    }

    const scale = Number(unitMm);
    if (!Number.isFinite(scale) || scale <= 0) {
        return [];
    }

    /** @type {Array<{x:number,y:number,flag:number}>} */
    const points = [];
    const decodedPrimary = tryDecodeSingleTraceChunk(raw);
    if (decodedPrimary !== null) {
        appendDecodedTracePoints(points, decodedPrimary, scale);
        return points;
    }

    // Fallback for concatenated tail payloads: split by observed chunk signature.
    const signature = Buffer.from([0x5d, 0x00, 0x00, 0x04, 0x00]);
    const starts = [];
    for (let i = 0; i <= raw.length - signature.length; i++) {
        let match = true;
        for (let j = 0; j < signature.length; j++) {
            if (raw[i + j] !== signature[j]) {
                match = false;
                break;
            }
        }
        if (match) {
            starts.push(i);
        }
    }
    if (starts.length === 0) {
        return [];
    }
    starts.push(raw.length);
    for (let i = 0; i + 1 < starts.length; i++) {
        const chunk = raw.subarray(starts[i], starts[i + 1]);
        const decoded = tryDecodeSingleTraceChunk(chunk);
        if (decoded !== null) {
            appendDecodedTracePoints(points, decoded, scale);
        }
    }

    return points;
}

/**
 * @param {Array<{x:number,y:number,flag:number}>} outPoints
 * @param {Buffer} decoded
 * @param {number} scale
 */
function appendDecodedTracePoints(outPoints, decoded, scale) {
    for (let off = 0; off + 4 < decoded.length; off += 5) {
        const x = decoded.readInt16LE(off);
        const y = decoded.readInt16LE(off + 2);
        const flag = decoded.readUInt8(off + 4);
        outPoints.push({
            x: x * scale,
            y: y * scale,
            flag: flag
        });
    }
}

/**
 * @param {Buffer} raw
 * @returns {Buffer|null}
 */
function tryDecodeSingleTraceChunk(raw) {
    if (!Buffer.isBuffer(raw) || raw.length < 10) {
        return null;
    }
    try {
        const propsDict = raw.subarray(0, 5);
        const usize32 = raw.readUInt32LE(5);
        const lzmaPayload = raw.subarray(9);
        const hdr = Buffer.alloc(13);
        propsDict.copy(hdr, 0, 0, 5);
        hdr.writeUInt32LE(usize32, 5);
        hdr.writeUInt32LE(0, 9);
        const outRaw = lzma.decompressFile(Buffer.concat([hdr, lzmaPayload]));
        const out = outRaw instanceof Uint8Array ? Buffer.from(outRaw) : Buffer.from(outRaw ?? []);
        if (out.length < 5) {
            return null;
        }

        return out;
    } catch (e) {
        return null;
    }
}

module.exports = {
    decodeTraceRawHexToWorldMmPoints: decodeTraceRawHexToWorldMmPoints,
};

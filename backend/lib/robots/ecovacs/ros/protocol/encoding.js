"use strict";

/**
 * @param {Array<number>} values
 * @returns {Buffer}
 */
function encodeUInt8Array(values) {
    const data = Buffer.from(values.map(v => v & 0xff));

    return Buffer.concat([encodeUInt32(data.length), data]);
}

/**
 * @param {number} value
 * @returns {Buffer}
 */
function encodeUInt32(value) {
    const out = Buffer.alloc(4);
    out.writeUInt32LE(value >>> 0, 0);

    return out;
}

/**
 * @param {number} value
 * @returns {Buffer}
 */
function encodeFloat32(value) {
    const out = Buffer.alloc(4);
    out.writeFloatLE(value, 0);

    return out;
}

module.exports = {
    encodeUInt8Array: encodeUInt8Array,
    encodeUInt32: encodeUInt32,
    encodeFloat32: encodeFloat32
};

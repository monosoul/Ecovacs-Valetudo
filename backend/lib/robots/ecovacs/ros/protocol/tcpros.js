"use strict";

const BinaryCursor = require("./BinaryCursor");

/**
 * @param {Array<[string,string]>} pairs
 * @returns {Buffer}
 */
function buildHandshakePacket(pairs) {
    const encoded = pairs.map(([k, v]) => {
        return Buffer.from(`${k}=${v}`, "utf8");
    });
    const bodyLength = encoded.reduce((sum, value) => {
        return sum + 4 + value.length;
    }, 0);
    const chunks = [Buffer.alloc(4)];
    chunks[0].writeUInt32LE(bodyLength, 0);

    for (const entry of encoded) {
        const len = Buffer.alloc(4);
        len.writeUInt32LE(entry.length, 0);
        chunks.push(len, entry);
    }

    return Buffer.concat(chunks);
}

/**
 * @param {import("./BufferedTcpSocket")} socket
 * @param {number} timeoutMs
 * @returns {Promise<Object<string,string>>}
 */
async function readHandshake(socket, timeoutMs) {
    const lenBuf = await socket.readExact(4, timeoutMs);
    const totalLength = lenBuf.readUInt32LE(0);
    const payload = await socket.readExact(totalLength, timeoutMs);
    const cursor = new BinaryCursor(payload);
    /** @type {Object<string,string>} */
    const out = {};

    while (cursor.remaining() > 0) {
        const fieldLen = cursor.readUInt32LE();
        const fieldRaw = cursor.readBuffer(fieldLen).toString("utf8");
        const splitIndex = fieldRaw.indexOf("=");
        if (splitIndex > 0) {
            const key = fieldRaw.slice(0, splitIndex);
            const value = fieldRaw.slice(splitIndex + 1);
            out[key] = value;
        }
    }

    return out;
}

module.exports = {
    buildHandshakePacket: buildHandshakePacket,
    readHandshake: readHandshake
};

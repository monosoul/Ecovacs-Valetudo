"use strict";

class BinaryCursor {
    /**
     * @param {Buffer} buffer
     */
    constructor(buffer) {
        this.buffer = buffer;
        this.offset = 0;
    }

    /**
     * @param {number} length
     * @returns {Buffer}
     */
    readBuffer(length) {
        if (this.offset + length > this.buffer.length) {
            throw new Error(`Short buffer: need ${length} bytes at ${this.offset}, have ${this.buffer.length}`);
        }
        const out = this.buffer.subarray(this.offset, this.offset + length);
        this.offset += length;

        return out;
    }

    /**
     * @returns {number}
     */
    readUInt8() {
        const out = this.readBuffer(1).readUInt8(0);

        return out;
    }

    /**
     * @returns {number}
     */
    readUInt16LE() {
        const out = this.readBuffer(2).readUInt16LE(0);

        return out;
    }

    /**
     * @returns {number}
     */
    readUInt32LE() {
        const out = this.readBuffer(4).readUInt32LE(0);

        return out;
    }

    /**
     * @returns {number}
     */
    readFloatLE() {
        const out = this.readBuffer(4).readFloatLE(0);

        return out;
    }

    /**
     * @returns {number}
     */
    remaining() {
        return this.buffer.length - this.offset;
    }
}

module.exports = BinaryCursor;

"use strict";

const Logger = require("../../../../Logger");
const net = require("net");

class BufferedTcpSocket {
    constructor() {
        /** @type {net.Socket|null} */
        this.socket = null;
        this.readBuffer = Buffer.alloc(0);
        this.pendingRead = null;
        this.closed = false;
    }

    /**
     * @param {string} host
     * @param {number} port
     * @param {number} timeoutMs
     * @returns {Promise<void>}
     */
    async connect(host, port, timeoutMs) {
        await this.close();
        this.closed = false;
        this.readBuffer = Buffer.alloc(0);

        await new Promise((resolve, reject) => {
            const socket = net.createConnection({host: host, port: port});
            this.socket = socket;

            const onConnect = () => {
                cleanup();
                socket.on("data", chunk => {
                    this.readBuffer = Buffer.concat([this.readBuffer, chunk]);
                    this.drainPendingRead();
                });
                socket.on("error", err => {
                    this.failPendingRead(err);
                });
                socket.on("close", () => {
                    this.closed = true;
                    this.failPendingRead(new Error("Socket closed"));
                });
                resolve();
            };
            const onError = err => {
                cleanup();
                socket.on("error", (e) => {
                    Logger.debug(`BufferedTcpSocket post-error destroy: ${e?.message ?? e}`);
                });
                socket.destroy();
                reject(err);
            };
            const onTimeout = () => {
                cleanup();
                socket.on("error", (e) => {
                    Logger.debug(`BufferedTcpSocket post-timeout destroy: ${e?.message ?? e}`);
                });
                socket.destroy();
                reject(new Error(`Connect timeout after ${timeoutMs}ms`));
            };
            const cleanup = () => {
                clearTimeout(timer);
                socket.off("connect", onConnect);
                socket.off("error", onError);
            };

            const timer = setTimeout(onTimeout, timeoutMs);
            socket.once("connect", onConnect);
            socket.once("error", onError);
        });
    }

    /**
     * @param {Buffer} data
     * @returns {Promise<void>}
     */
    async write(data) {
        if (!this.socket || this.closed) {
            throw new Error("Socket is not connected");
        }
        await new Promise((resolve, reject) => {
            this.socket.write(data, err => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * @param {number} length
     * @param {number} timeoutMs
     * @returns {Promise<Buffer>}
     */
    async readExact(length, timeoutMs) {
        if (length === 0) {
            return Buffer.alloc(0);
        }
        if (!this.socket || this.closed) {
            throw new Error("Socket is not connected");
        }
        if (this.pendingRead) {
            throw new Error("Concurrent readExact is not supported");
        }

        if (this.readBuffer.length >= length) {
            const out = this.readBuffer.subarray(0, length);
            this.readBuffer = this.readBuffer.subarray(length);

            return out;
        }

        return await new Promise((resolve, reject) => {
            const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs >= 0;
            const timer = hasTimeout ? setTimeout(() => {
                this.pendingRead = null;
                reject(new Error(`Read timeout after ${timeoutMs}ms`));
            }, timeoutMs) : null;

            this.pendingRead = {
                length: length,
                resolve: (buffer) => {
                    if (timer !== null) {
                        clearTimeout(timer);
                    }
                    resolve(buffer);
                },
                reject: (err) => {
                    if (timer !== null) {
                        clearTimeout(timer);
                    }
                    reject(err);
                }
            };
        });
    }

    drainPendingRead() {
        if (!this.pendingRead) {
            return;
        }
        if (this.readBuffer.length < this.pendingRead.length) {
            return;
        }

        const pending = this.pendingRead;
        this.pendingRead = null;

        const out = this.readBuffer.subarray(0, pending.length);
        this.readBuffer = this.readBuffer.subarray(pending.length);
        pending.resolve(out);
    }

    /**
     * @param {Error} err
     */
    failPendingRead(err) {
        if (!this.pendingRead) {
            return;
        }
        const pending = this.pendingRead;
        this.pendingRead = null;
        pending.reject(err);
    }

    /**
     * @returns {Promise<void>}
     */
    async close() {
        this.closed = true;
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.destroy();
            this.socket = null;
        }
        this.failPendingRead(new Error("Socket closed"));
    }
}

module.exports = BufferedTcpSocket;

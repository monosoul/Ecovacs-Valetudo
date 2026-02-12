"use strict";

const BufferedTcpSocket = require("../protocol/BufferedTcpSocket");
const Logger = require("../../../../Logger");
const {buildHandshakePacket, readHandshake} = require("../protocol/tcpros");

class PersistentServiceClient {
    /**
     * @param {object} options
     * @param {import("./RosMasterXmlRpcClient")} options.masterClient
     * @param {string} options.callerId
     * @param {Array<string>} options.serviceCandidates
     * @param {string} options.serviceMd5
     * @param {number} [options.connectTimeoutMs]
     * @param {number} [options.callTimeoutMs]
     * @param {boolean} [options.persistent]
     */
    constructor(options) {
        this.masterClient = options.masterClient;
        this.callerId = options.callerId;
        this.serviceCandidates = options.serviceCandidates;
        this.serviceMd5 = options.serviceMd5;
        this.connectTimeoutMs = options.connectTimeoutMs ?? 4000;
        this.callTimeoutMs = options.callTimeoutMs ?? 5000;
        this.persistent = options.persistent ?? true;
        this.debug = options.debug ?? false;

        this.serviceName = null;
        this.socket = null;
        this.lock = Promise.resolve();
    }

    /**
     * @param {Buffer} requestBody
     * @returns {Promise<Buffer>}
     */
    async call(requestBody) {
        this.lock = this.lock.then(() => {
            return this.callLocked(requestBody);
        });

        return await this.lock;
    }

    /**
     * @param {Buffer} requestBody
     * @returns {Promise<Buffer>}
     */
    async callLocked(requestBody) {
        if (this.debug) {
            Logger.debug(
                `Ecovacs ROS call: service=${this.serviceName ?? this.serviceCandidates[0]} ` +
                `persistent=${this.persistent} request_bytes=${requestBody.length}`
            );
        }
        if (!this.persistent) {
            return await this.callWithShortLivedSocket(requestBody);
        }

        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                await this.ensureConnected();
                const response = await this.doCallOnce(this.socket, requestBody);

                return response;
            } catch (e) {
                lastError = e;
                await this.resetConnection();
            }
        }

        throw lastError ?? new Error("Service call failed");
    }

    /**
     * @returns {Promise<void>}
     */
    async ensureConnected() {
        if (!this.persistent) {
            return;
        }
        if (this.socket) {
            return;
        }
        this.socket = await this.createConnectedSocket();
    }

    /**
     * @returns {Promise<BufferedTcpSocket>}
     */
    async createConnectedSocket() {
        const resolved = await this.masterClient.resolveService(this.callerId, this.serviceCandidates);
        if (!resolved) {
            throw new Error(`Service not found in candidates: ${this.serviceCandidates.join(", ")}`);
        }

        const socket = new BufferedTcpSocket();
        await socket.connect(resolved.host, resolved.port, this.connectTimeoutMs);
        if (this.debug) {
            Logger.debug(
                `Ecovacs ROS connected: service=${resolved.serviceName} endpoint=${resolved.host}:${resolved.port} ` +
                `persistent=${this.persistent}`
            );
        }
        const handshakePacket = buildHandshakePacket([
            ["callerid", `${this.callerId}'`],
            ["md5sum", this.serviceMd5],
            ["persistent", this.persistent ? "1" : "0"],
            ["service", resolved.serviceName]
        ]);
        await socket.write(handshakePacket);
        await readHandshake(socket, this.callTimeoutMs);

        this.serviceName = resolved.serviceName;

        return socket;
    }

    /**
     * @param {Buffer} requestBody
     * @returns {Promise<Buffer>}
     */
    async callWithShortLivedSocket(requestBody) {
        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            let socket = null;
            try {
                socket = await this.createConnectedSocket();
                const response = await this.doCallOnce(socket, requestBody);
                await socket.close();

                return response;
            } catch (e) {
                lastError = e;
                if (socket) {
                    await socket.close();
                }
            }
        }

        throw lastError ?? new Error("Service call failed");
    }

    /**
     * @param {import("../protocol/BufferedTcpSocket")} socket
     * @param {Buffer} requestBody
     * @returns {Promise<Buffer>}
     */
    async doCallOnce(socket, requestBody) {
        if (!socket) {
            throw new Error("Socket is not connected");
        }
        const requestLen = Buffer.alloc(4);
        requestLen.writeUInt32LE(requestBody.length, 0);
        await socket.write(Buffer.concat([requestLen, requestBody]));

        const ok = (await socket.readExact(1, this.callTimeoutMs)).readUInt8(0);
        const responseLen = (await socket.readExact(4, this.callTimeoutMs)).readUInt32LE(0);
        const responseBody = await socket.readExact(responseLen, this.callTimeoutMs);
        if (this.debug) {
            Logger.debug(
                `Ecovacs ROS response: service=${this.serviceName ?? this.serviceCandidates[0]} ` +
                `ok=${ok} response_bytes=${responseLen}`
            );
        }

        if (ok !== 1) {
            const errorText = responseBody.toString("utf8");
            Logger.warn(
                `Ecovacs ROS error response: service=${this.serviceName ?? this.serviceCandidates[0]} ` +
                `persistent=${this.persistent} error=${errorText}`
            );
            throw new Error(`Service error response: ${errorText}`);
        }

        return responseBody;
    }

    /**
     * @returns {Promise<void>}
     */
    async resetConnection() {
        if (this.socket) {
            await this.socket.close();
            this.socket = null;
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async shutdown() {
        await this.resetConnection();
    }
}

module.exports = PersistentServiceClient;

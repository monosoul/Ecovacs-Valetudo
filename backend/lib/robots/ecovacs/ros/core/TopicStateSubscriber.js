"use strict";

const BinaryCursor = require("../protocol/BinaryCursor");
const BufferedTcpSocket = require("../protocol/BufferedTcpSocket");
const {buildHandshakePacket, readHandshake} = require("../protocol/tcpros");

class TopicStateSubscriber {
    /**
     * @param {object} options
     * @param {import("./RosMasterXmlRpcClient")} options.masterClient
     * @param {string} options.callerId
     * @param {string} options.topic
     * @param {string} options.type
     * @param {string} options.md5
     * @param {(payload: Buffer) => any} options.decoder
     * @param {number} [options.connectTimeoutMs]
     * @param {number} [options.readTimeoutMs]
     * @param {number} [options.reconnectDelayMs]
     * @param {(msg: string, err?: any) => void} [options.onWarn]
     */
    constructor(options) {
        this.masterClient = options.masterClient;
        this.callerId = options.callerId;
        this.topic = options.topic;
        this.type = options.type;
        this.md5 = options.md5;
        this.decoder = options.decoder;
        this.connectTimeoutMs = options.connectTimeoutMs ?? 4000;
        this.readTimeoutMs = options.readTimeoutMs ?? 5000;
        this.reconnectDelayMs = options.reconnectDelayMs ?? 1500;
        this.onWarn = options.onWarn ?? (() => {});

        this.running = false;
        this.loopPromise = null;
        this.latestValue = null;
        this.latestAt = 0;
    }

    async start() {
        if (this.running) {
            return;
        }
        this.running = true;
        this.loopPromise = this.runLoop();
    }

    async shutdown() {
        this.running = false;
        try {
            await this.loopPromise;
        } catch (e) {
            // ignore shutdown race
        } finally {
            this.loopPromise = null;
        }
    }

    /**
     * @param {number} staleAfterMs
     * @returns {any|null}
     */
    getLatestValue(staleAfterMs) {
        if (this.latestValue === null) {
            return null;
        }
        if (Date.now() - this.latestAt > staleAfterMs) {
            return null;
        }

        return this.latestValue;
    }

    async runLoop() {
        while (this.running) {
            let socket = null;
            try {
                const endpoint = await this.masterClient.resolveTopicTcpEndpoint(
                    this.callerId,
                    this.topic,
                    this.type
                );
                if (!endpoint) {
                    await delay(this.reconnectDelayMs);
                    continue;
                }

                socket = new BufferedTcpSocket();
                await socket.connect(endpoint.host, endpoint.port, this.connectTimeoutMs);
                await socket.write(buildHandshakePacket([
                    ["callerid", `${this.callerId}'`],
                    ["topic", this.topic],
                    ["type", this.type],
                    ["md5sum", this.md5],
                    ["tcp_nodelay", "1"]
                ]));
                await readHandshake(socket, this.readTimeoutMs);

                while (this.running) {
                    const payloadLength = (await socket.readExact(4, this.readTimeoutMs)).readUInt32LE(0);
                    const payload = await socket.readExact(payloadLength, this.readTimeoutMs);
                    const parsed = this.decoder(payload);
                    if (parsed !== null && parsed !== undefined) {
                        this.latestValue = parsed;
                        this.latestAt = Date.now();
                    }
                }
            } catch (e) {
                if (this.running) {
                    this.onWarn(`Topic subscriber reconnecting for ${this.topic}`, e?.message ?? e);
                    await delay(this.reconnectDelayMs);
                }
            } finally {
                if (socket) {
                    await socket.close();
                }
            }
        }
    }
}

/**
 * @param {Buffer} payload
 * @returns {{battery:number,isLowVoltageToPowerOff:number}|null}
 */
function decodePowerBattery(payload) {
    if (!Buffer.isBuffer(payload) || payload.length < 2) {
        return null;
    }
    const cursor = new BinaryCursor(payload);

    return {
        battery: cursor.readUInt8(),
        isLowVoltageToPowerOff: cursor.readUInt8()
    };
}

/**
 * @param {Buffer} payload
 * @returns {{isOnCharger:number,chargeState:number}|null}
 */
function decodePowerChargeState(payload) {
    if (!Buffer.isBuffer(payload) || payload.length < 2) {
        return null;
    }
    const cursor = new BinaryCursor(payload);

    return {
        isOnCharger: cursor.readUInt8(),
        chargeState: cursor.readUInt8()
    };
}

/**
 * @param {Buffer} payload
 * @returns {{worktype:number,state:number,workcause:number}|null}
 */
function decodeTaskWorkState(payload) {
    if (!Buffer.isBuffer(payload) || payload.length < 3) {
        return null;
    }
    const cursor = new BinaryCursor(payload);
    try {
        const worktype = cursor.readUInt8();
        const state = cursor.readUInt8();

        skipUInt8Array(cursor); // cleanData.ids
        skipDotArray(cursor); // cleanData.customAreas
        skipUInt8Array(cursor); // cleanData.cycles
        skipUInt8Array(cursor); // cleanData.states
        skipUInt8Array(cursor); // extraWorkData.ids
        skipPoseArray(cursor); // extraWorkData.poses
        cursor.readBuffer(7); // RemoteMove
        skipUInt8Array(cursor); // extraWorkData.states

        if (cursor.remaining() < 1) {
            return null;
        }
        const workcause = cursor.readUInt8();

        return {
            worktype: worktype,
            state: state,
            workcause: workcause
        };
    } catch (e) {
        return null;
    }
}

/**
 * @param {BinaryCursor} cursor
 */
function skipUInt8Array(cursor) {
    const length = cursor.readUInt32LE();
    cursor.readBuffer(length);
}

/**
 * @param {BinaryCursor} cursor
 */
function skipDotArray(cursor) {
    const count = cursor.readUInt32LE();
    cursor.readBuffer(count * 8);
}

/**
 * @param {BinaryCursor} cursor
 */
function skipPoseArray(cursor) {
    const count = cursor.readUInt32LE();
    for (let i = 0; i < count; i++) {
        skipHeader(cursor);
        cursor.readBuffer(12); // x,y,theta
    }
}

/**
 * @param {BinaryCursor} cursor
 */
function skipHeader(cursor) {
    cursor.readBuffer(12); // seq + time
    const frameIdLength = cursor.readUInt32LE();
    cursor.readBuffer(frameIdLength);
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
    TopicStateSubscriber: TopicStateSubscriber,
    decodePowerBattery: decodePowerBattery,
    decodePowerChargeState: decodePowerChargeState,
    decodeTaskWorkState: decodeTaskWorkState
};

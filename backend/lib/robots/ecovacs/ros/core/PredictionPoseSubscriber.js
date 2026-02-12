"use strict";

const BinaryCursor = require("../protocol/BinaryCursor");
const BufferedTcpSocket = require("../protocol/BufferedTcpSocket");
const {buildHandshakePacket, readHandshake} = require("../protocol/tcpros");

class PredictionPoseSubscriber {
    /**
     * @param {object} options
     * @param {import("./RosMasterXmlRpcClient")} options.masterClient
     * @param {string} options.callerId
     * @param {number} [options.connectTimeoutMs]
     * @param {number} [options.readTimeoutMs]
     * @param {number} [options.reconnectDelayMs]
     * @param {(msg: string, err?: any) => void} [options.onWarn]
     */
    constructor(options) {
        this.masterClient = options.masterClient;
        this.callerId = options.callerId;
        this.connectTimeoutMs = options.connectTimeoutMs ?? 4000;
        this.readTimeoutMs = options.readTimeoutMs ?? 5000;
        this.reconnectDelayMs = options.reconnectDelayMs ?? 1500;
        this.onWarn = options.onWarn ?? (() => {});

        this.running = false;
        this.loopPromise = null;
        this.latestPose = null;
        this.latestPoseAt = 0;
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
     * @returns {{x:number,y:number,theta:number,source:string}|null}
     */
    getLatestPose(staleAfterMs) {
        if (!this.latestPose) {
            return null;
        }
        if (Date.now() - this.latestPoseAt > staleAfterMs) {
            return null;
        }

        return this.latestPose;
    }

    async runLoop() {
        while (this.running) {
            let socket = null;
            try {
                const selected = await this.resolveEndpoint();
                if (!selected) {
                    await delay(this.reconnectDelayMs);
                    continue;
                }

                socket = new BufferedTcpSocket();
                await socket.connect(selected.endpoint.host, selected.endpoint.port, this.connectTimeoutMs);
                await socket.write(buildHandshakePacket([
                    ["callerid", this.callerId],
                    ["topic", selected.topic],
                    ["type", selected.type],
                    ["md5sum", selected.md5],
                    ["tcp_nodelay", "1"]
                ]));
                await readHandshake(socket, this.readTimeoutMs);

                while (this.running) {
                    const payloadLen = (await socket.readExact(4, this.readTimeoutMs)).readUInt32LE(0);
                    const payload = await socket.readExact(payloadLen, this.readTimeoutMs);
                    const decoded = selected.decoder(payload);
                    if (decoded) {
                        this.latestPose = {
                            x: decoded.x,
                            y: decoded.y,
                            theta: decoded.theta,
                            source: `topic:${selected.topic}`
                        };
                        this.latestPoseAt = Date.now();
                    }
                }
            } catch (e) {
                if (this.running) {
                    this.onWarn("Prediction topic connection lost, reconnecting", e?.message ?? e);
                    await delay(this.reconnectDelayMs);
                }
            } finally {
                if (socket) {
                    await socket.close();
                }
            }
        }
    }

    /**
     * @returns {Promise<{topic:string,type:string,md5:string,decoder:(payload:Buffer)=>{x:number,y:number,theta:number}|null,endpoint:{host:string,port:number}}|null>}
     */
    async resolveEndpoint() {
        const candidates = [
            {
                topic: "/prediction/UpdatePose",
                type: "prediction/UpdatePose",
                md5: "fecf0dd688f5c70c9311410640ce79cd",
                decoder: decodeUpdatePose
            },
            {
                topic: "/prediction/PredictPose",
                type: "prediction/PredictPose",
                md5: "7b470216c350f9e55e9123b5b063d5d3",
                decoder: decodePredictPose
            },
            {
                topic: "/prediction/Pose",
                type: "prediction/Pose",
                md5: "4f56726d50ba8b23f7292bbcdc628375",
                decoder: decodePose
            }
        ];

        for (const candidate of candidates) {
            try {
                const endpoint = await this.masterClient.resolveTopicTcpEndpoint(
                    this.callerId,
                    candidate.topic,
                    candidate.type
                );
                if (endpoint) {
                    return {
                        topic: candidate.topic,
                        type: candidate.type,
                        md5: candidate.md5,
                        decoder: candidate.decoder,
                        endpoint: endpoint
                    };
                }
            } catch (e) {
                // try next candidate
            }
        }

        return null;
    }
}

/**
 * @param {Buffer} payload
 * @returns {{x:number,y:number,theta:number}|null}
 */
function decodePose(payload) {
    const cursor = new BinaryCursor(payload);
    skipHeader(cursor);
    if (cursor.remaining() < 12) {
        return null;
    }

    return {
        x: cursor.readFloatLE(),
        y: cursor.readFloatLE(),
        theta: cursor.readFloatLE()
    };
}

/**
 * @param {Buffer} payload
 * @returns {{x:number,y:number,theta:number}|null}
 */
function decodePredictPose(payload) {
    const cursor = new BinaryCursor(payload);
    skipPose(cursor); // predictPose
    const pose = readPose(cursor); // pose

    return pose;
}

/**
 * @param {Buffer} payload
 * @returns {{x:number,y:number,theta:number}|null}
 */
function decodeUpdatePose(payload) {
    const cursor = new BinaryCursor(payload);
    skipPose(cursor); // predictPose
    const pose = readPose(cursor); // pose
    if (cursor.remaining() < 1) {
        return null;
    }
    cursor.readUInt8(); // isToInterpolate

    return pose;
}

/**
 * @param {BinaryCursor} cursor
 */
function skipHeader(cursor) {
    if (cursor.remaining() < 12) {
        throw new Error("Short payload while reading header");
    }
    cursor.readUInt32LE(); // seq
    cursor.readUInt32LE(); // secs
    cursor.readUInt32LE(); // nsecs
    const frameLength = cursor.readUInt32LE();
    cursor.readBuffer(frameLength);
}

/**
 * @param {BinaryCursor} cursor
 */
function skipPose(cursor) {
    skipHeader(cursor);
    if (cursor.remaining() < 12) {
        throw new Error("Short payload while skipping pose");
    }
    cursor.readFloatLE();
    cursor.readFloatLE();
    cursor.readFloatLE();
}

/**
 * @param {BinaryCursor} cursor
 * @returns {{x:number,y:number,theta:number}|null}
 */
function readPose(cursor) {
    skipHeader(cursor);
    if (cursor.remaining() < 12) {
        return null;
    }

    return {
        x: cursor.readFloatLE(),
        y: cursor.readFloatLE(),
        theta: cursor.readFloatLE()
    };
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = PredictionPoseSubscriber;

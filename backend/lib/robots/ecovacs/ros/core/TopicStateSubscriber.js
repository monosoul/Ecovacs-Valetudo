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
     * @param {boolean} [options.safeResolve] - use resolveTopicTcpEndpointSafe (no registerSubscriber fallback)
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
        this.safeResolve = options.safeResolve ?? false;
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
        if (Number.isFinite(staleAfterMs) && staleAfterMs >= 0 && Date.now() - this.latestAt > staleAfterMs) {
            return null;
        }

        return this.latestValue;
    }

    async runLoop() {
        while (this.running) {
            let socket = null;
            try {
                const endpoint = this.safeResolve ?
                    await this.masterClient.resolveTopicTcpEndpointSafe(this.callerId, this.topic) :
                    await this.masterClient.resolveTopicTcpEndpoint(this.callerId, this.topic, this.type);
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
                    const payloadLength = (await socket.readExact(4)).readUInt32LE(0);
                    const payload = await socket.readExact(payloadLength);
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

/**
 * Decode worklog/WorkStatisticToWifi topic message.
 * Wire format: <B3IB2I> = 22 bytes
 *   worktype (u8), worktime (u32 seconds), workarea (u32 dm²),
 *   extraArea (u32 dm²), waterboxType (u8),
 *   startTime.secs (u32), startTime.nsecs (u32)
 *
 * @param {Buffer} payload
 * @returns {{worktype:number, worktime:number, workareaDm2:number, extraAreaDm2:number, waterboxType:number, startTimeSecs:number}|null}
 */
function decodeWorkStatisticToWifi(payload) {
    if (!Buffer.isBuffer(payload) || payload.length < 22) {
        return null;
    }
    const cursor = new BinaryCursor(payload);

    return {
        worktype: cursor.readUInt8(),
        worktime: cursor.readUInt32LE(),
        workareaDm2: cursor.readUInt32LE(),
        extraAreaDm2: cursor.readUInt32LE(),
        waterboxType: cursor.readUInt8(),
        startTimeSecs: cursor.readUInt32LE()
    };
}

/**
 * Alert type IDs from the robot's alert/AlertType message definition.
 * state: 0 = idle, 1 = triggered.
 *
 * @readonly
 * @enum {number}
 */
const ALERT_TYPE = Object.freeze({
    DIRT_BOX_STATE: 0,
    WATER_BOX_STATE: 1,
    FALL_ERROR: 2,
    BRUSH_CURRENT_STATE_ERROR: 3,
    SIDE_BRUSH_CURRENT_ERROR: 4,
    LEFT_WHEEL_CURRENT_ERROR: 5,
    RIGHT_WHEEL_CURRENT_ERROR: 6,
    DOWNIN_ERROR: 7,
    BRUSH_CURRENT_LARGE_CURRENT_WARNING: 8,
    SIDE_BRUSH_CURRENT_LARGE_CURRENT_WARNING: 9,
    LEFT_SIDE_BRUSH_CURRENT_LARGE_CURRENT_WARNING: 10,
    RIGHT_SIDE_BRUSH_CURRENT_LARGE_CURRENT_WARNING: 11,
    FALL_STATE_WARNING: 12,
    LEFT_WHEEL_CURRENT_LARGE_CURRENT_WARNING: 13,
    RIGHT_WHEEL_CURRENT_LARGE_CURRENT_WARNING: 14,
    LEFT_BUMP_REPEAT_TRIGE_WARNING: 15,
    RIGHT_BUMP_REPEAT_TRIGE_WARNING: 16,
    BUMP_LONG_TIMER_TRIGE_WARNING: 17,
    BUMP_LONG_TIMER_TRIGE_ERROR: 18,
    BUMP_LONG_TIMER_NO_TRIGE_ERROR: 19,
    DEGREE_NO_CHANGE_WARNING: 20,
    DEGREE_NO_CHANGE_ERROR: 21,
    LEFT_WHEEL_SPEED_ERROR: 22,
    RIGHT_WHEEL_SPEED_ERROR: 23,
    FAN_SPEED_ERROR: 24,
    POSE_NO_CHANGE_WARNING: 25,
    ROLL_GESTURE_SLOPE_WARNING: 26,
    PITCH_GESTURE_SLOPE_WARNING: 27,
    ROBOT_BEEN_MOVED_DURING_IDLE: 28,
    NO_RETURN_CHARGE_WARNING: 29,
    FAN_SPEED_STATE_CHANGED_WARNING: 30,
    ROBOT_STUCK_ERROR: 31,
    LDS_ERROR: 32,
    ULTRA_WATERBOX_WARNING: 33,
    ULTRA_WATERBOX_ERROR: 34,
});

/**
 * Decode alert/Alerts topic message.
 * Wire format: u32 count, then count * (u8 type, u8 state).
 *
 * Returns an array of triggered alerts (state === 1).
 *
 * @param {Buffer} payload
 * @returns {Array<{type: number, state: number}>|null}
 */
function decodeAlertAlerts(payload) {
    if (!Buffer.isBuffer(payload) || payload.length < 4) {
        return null;
    }
    const cursor = new BinaryCursor(payload);
    const count = cursor.readUInt32LE();

    if (payload.length < 4 + count * 2) {
        return null;
    }

    const triggered = [];
    for (let i = 0; i < count; i++) {
        const type = cursor.readUInt8();
        const state = cursor.readUInt8();
        if (state === 1) {
            triggered.push({type: type, state: state});
        }
    }

    return triggered;
}

/**
 * Decode prediction/UpdatePose: predictPose(Header+xyz) + pose(Header+xyz) + isToInterpolate(u8).
 * Returns the pose (second) field.
 *
 * @param {Buffer} payload
 * @returns {{x:number,y:number,theta:number}|null}
 */
function decodePredictionUpdatePose(payload) {
    if (!Buffer.isBuffer(payload) || payload.length < 2) {
        return null;
    }
    try {
        const cursor = new BinaryCursor(payload);
        skipRosHeader(cursor);
        cursor.readBuffer(12); // predictPose x,y,theta
        skipRosHeader(cursor);
        if (cursor.remaining() < 13) {
            return null;
        }

        return {
            x: cursor.readFloatLE(),
            y: cursor.readFloatLE(),
            theta: cursor.readFloatLE()
        };
    } catch (e) {
        return null;
    }
}

/**
 * Skip a ROS std_msgs/Header (seq u32, secs u32, nsecs u32, frame_id string).
 *
 * @param {BinaryCursor} cursor
 */
function skipRosHeader(cursor) {
    cursor.readUInt32LE(); // seq
    cursor.readUInt32LE(); // secs
    cursor.readUInt32LE(); // nsecs
    const frameLength = cursor.readUInt32LE();
    cursor.readBuffer(frameLength);
}

module.exports = {
    TopicStateSubscriber: TopicStateSubscriber,
    ALERT_TYPE: ALERT_TYPE,
    decodePowerBattery: decodePowerBattery,
    decodePowerChargeState: decodePowerChargeState,
    decodeTaskWorkState: decodeTaskWorkState,
    decodeWorkStatisticToWifi: decodeWorkStatisticToWifi,
    decodeAlertAlerts: decodeAlertAlerts,
    decodePredictionUpdatePose: decodePredictionUpdatePose
};

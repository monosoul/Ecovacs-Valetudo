"use strict";

const BinaryCursor = require("../protocol/BinaryCursor");
const PersistentServiceClient = require("../core/PersistentServiceClient");
const {TopicStateSubscriber, decodePredictionUpdatePose} = require("../core/TopicStateSubscriber");

const SERVICE = {
    md5: "9cde7b036866c35b41f8cc3957bbf01d",
    name: "/map/ManipulateCharger"
};

const TOPIC = {
    topic: "/prediction/UpdatePose",
    type: "prediction/UpdatePose",
    md5: "fecf0dd688f5c70c9311410640ce79cd",
    decoder: decodePredictionUpdatePose
};

class EcovacsPositionService {
    /**
     * @param {object} options
     * @param {import("../core/RosMasterXmlRpcClient")} options.masterClient
     * @param {string} options.callerId
     * @param {number} [options.connectTimeoutMs]
     * @param {number} [options.callTimeoutMs]
     * @param {boolean} [options.debug]
     * @param {(msg: string, err?: any) => void} [options.onWarn]
     */
    constructor(options) {
        this.chargerClient = new PersistentServiceClient({
            masterClient: options.masterClient,
            callerId: options.callerId,
            serviceName: SERVICE.name,
            serviceMd5: SERVICE.md5,
            connectTimeoutMs: options.connectTimeoutMs,
            callTimeoutMs: options.callTimeoutMs,
            debug: options.debug
        });
        this.poseSubscriber = new TopicStateSubscriber({
            masterClient: options.masterClient,
            callerId: options.callerId,
            connectTimeoutMs: options.connectTimeoutMs,
            readTimeoutMs: options.callTimeoutMs,
            onWarn: options.onWarn,
            ...TOPIC
        });
    }

    async startup() {
        await this.poseSubscriber.start();
    }

    async shutdown() {
        await Promise.all([
            this.poseSubscriber.shutdown(),
            this.chargerClient.shutdown()
        ]);
    }

    /**
     * @param {number} mapId
     * @param {number} stalePoseMs
     * @returns {Promise<any>}
     */
    async getPositions(mapId, stalePoseMs) {
        /** @type {{x:number,y:number,theta:number,source:string,docktype:number,result:number,valid?:number,error?:string}} */
        let chargerPose;
        try {
            const chargerReq = Buffer.alloc(5);
            chargerReq.writeUInt8(0, 0);
            chargerReq.writeUInt32LE(mapId >>> 0, 1);
            const chargerBody = await this.chargerClient.call(chargerReq);
            chargerPose = parseChargerResponse(chargerBody);
        } catch (e) {
            chargerPose = {
                source: "service:/map/ManipulateCharger",
                valid: 0,
                error: `charger pose unavailable: ${String(e?.message ?? e)}`,
                x: 0,
                y: 0,
                theta: 0,
                docktype: 0,
                result: 1
            };
        }
        const robotPose = this.poseSubscriber.getLatestValue(stalePoseMs);

        return {
            robot: {
                topic: "/prediction/UpdatePose",
                type: "prediction/UpdatePose",
                pose: robotPose ?? {
                    valid: 0,
                    error: "no fresh prediction pose available"
                }
            },
            charger: {
                topic: "service:/map/ManipulateCharger",
                type: "map/ManipulateCharger",
                pose: chargerPose
            }
        };
    }
}

/**
 * @param {Buffer} body
 * @returns {{x:number,y:number,theta:number,source:string,docktype:number,result:number}}
 */
function parseChargerResponse(body) {
    const cursor = new BinaryCursor(body);
    const isPoseValid = cursor.readUInt8();
    const docktype = cursor.readUInt8();
    const x = cursor.readFloatLE();
    const y = cursor.readFloatLE();
    const theta = cursor.readFloatLE();
    const result = cursor.readUInt8();
    if (isPoseValid !== 1) {
        throw new Error("charger pose is not valid");
    }

    return {
        x: x,
        y: y,
        theta: theta,
        source: "manipulate_charger_service",
        docktype: docktype,
        result: result
    };
}

module.exports = EcovacsPositionService;

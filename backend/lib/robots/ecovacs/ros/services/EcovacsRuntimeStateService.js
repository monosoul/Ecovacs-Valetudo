"use strict";

const {
    TopicStateSubscriber,
    decodePowerBattery,
    decodePowerChargeState,
    decodeTaskWorkState,
    decodeAlertAlerts
} = require("../core/TopicStateSubscriber");

const TOPICS = {
    battery: {
        topic: "/power/Battery",
        type: "power/Battery",
        md5: "1f868bac590fa9e653b61dc342b25421",
        decoder: decodePowerBattery
    },
    chargeState: {
        topic: "/power/ChargeState",
        type: "power/ChargeState",
        md5: "3f40efefe99d0b54d25afc2ed5523fc0",
        decoder: decodePowerChargeState
    },
    workState: {
        topic: "/task/WorkState",
        type: "task/WorkState",
        md5: "85234983b5d2c6828f53442a64052ae3",
        decoder: decodeTaskWorkState
    },
    alerts: {
        topic: "/alert/Alerts",
        type: "alert/Alerts",
        md5: "cc98b954dcec4eb014849fa8ae90fc33",
        decoder: decodeAlertAlerts
    }
};

class EcovacsRuntimeStateService {
    /**
     * @param {object} options
     * @param {import("../core/RosMasterXmlRpcClient")} options.masterClient
     * @param {string} options.callerId
     * @param {number} [options.connectTimeoutMs]
     * @param {number} [options.callTimeoutMs]
     * @param {(msg: string, err?: any) => void} [options.onWarn]
     */
    constructor(options) {
        const subscriberOpts = {
            masterClient: options.masterClient,
            callerId: options.callerId,
            connectTimeoutMs: options.connectTimeoutMs,
            readTimeoutMs: options.callTimeoutMs,
            onWarn: options.onWarn
        };

        this.batterySubscriber = new TopicStateSubscriber({...subscriberOpts, ...TOPICS.battery});
        this.chargeStateSubscriber = new TopicStateSubscriber({...subscriberOpts, ...TOPICS.chargeState});
        this.workStateSubscriber = new TopicStateSubscriber({...subscriberOpts, ...TOPICS.workState});
        this.alertSubscriber = new TopicStateSubscriber({...subscriberOpts, ...TOPICS.alerts});
    }

    async startup() {
        await Promise.all([
            this.batterySubscriber.start(),
            this.chargeStateSubscriber.start(),
            this.workStateSubscriber.start(),
            this.alertSubscriber.start()
        ]);
    }

    async shutdown() {
        await Promise.all([
            this.batterySubscriber.shutdown(),
            this.chargeStateSubscriber.shutdown(),
            this.workStateSubscriber.shutdown(),
            this.alertSubscriber.shutdown()
        ]);
    }

    /**
     * @param {number} staleMs
     * @returns {{battery:{battery:number,isLowVoltageToPowerOff:number}|null,chargeState:{isOnCharger:number,chargeState:number}|null}}
     */
    getPowerState(staleMs) {
        return {
            battery: this.batterySubscriber.getLatestValue(staleMs),
            chargeState: this.chargeStateSubscriber.getLatestValue(staleMs)
        };
    }

    /**
     * @param {number} staleMs
     * @returns {{battery:{battery:number,isLowVoltageToPowerOff:number}|null,chargeState:{isOnCharger:number,chargeState:number}|null,workState:{worktype:number,state:number,workcause:number}|null}}
     */
    getRuntimeState(staleMs) {
        return {
            battery: this.batterySubscriber.getLatestValue(staleMs),
            chargeState: this.chargeStateSubscriber.getLatestValue(staleMs),
            workState: this.workStateSubscriber.getLatestValue(staleMs)
        };
    }

    /**
     * Get the latest triggered alerts from the /alert/Alerts topic.
     * Returns an array of triggered alerts (state === 1), or null if stale/unavailable.
     *
     * @param {number} staleMs
     * @returns {Array<{type: number, state: number}>|null}
     */
    getTriggeredAlerts(staleMs) {
        return this.alertSubscriber.getLatestValue(staleMs);
    }
}

module.exports = EcovacsRuntimeStateService;

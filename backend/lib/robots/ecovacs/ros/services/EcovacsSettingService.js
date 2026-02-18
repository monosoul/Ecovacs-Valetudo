"use strict";

const BinaryCursor = require("../protocol/BinaryCursor");
const PersistentServiceClient = require("../core/PersistentServiceClient");
const {encodeUInt32} = require("../protocol/encoding");

const SERVICE = {
    md5: "9b750807a5def60e40619d50b06ae034",
    name: "/setting/SettingManage"
};

const SETTING_MANAGE_TYPE = Object.freeze({
    GET: 0,
    SET: 1
});

const SETTING_TYPE = Object.freeze({
    AUTO_COLLECT: 13,
    WATER_LEVEL: 6,
    FAN_LEVEL: 7,
    ROOM_PREFERENCES: 14,
    CLEANING_TIMES: 15,
    SUCTION_BOOST_ON_CARPET: 8
});

class EcovacsSettingService {
    /**
     * @param {object} options
     * @param {import("../core/RosMasterXmlRpcClient")} options.masterClient
     * @param {string} options.callerId
     * @param {number} [options.connectTimeoutMs]
     * @param {number} [options.callTimeoutMs]
     * @param {boolean} [options.debug]
     */
    constructor(options) {
        this.settingClient = new PersistentServiceClient({
            masterClient: options.masterClient,
            callerId: options.callerId,
            serviceName: SERVICE.name,
            serviceMd5: SERVICE.md5,
            connectTimeoutMs: options.connectTimeoutMs,
            callTimeoutMs: options.callTimeoutMs,
            debug: options.debug,
            persistent: false
        });
    }

    async shutdown() {
        await this.settingClient.shutdown();
    }

    /**
     * @returns {Promise<"on"|"off">}
     */
    async getSuctionBoostOnCarpet() {
        const request = serializeSettingManageRequest({
            manageType: SETTING_MANAGE_TYPE.GET,
            settingType: SETTING_TYPE.SUCTION_BOOST_ON_CARPET
        });
        const body = await this.settingClient.call(request);
        const parsed = parseSettingManageResponse(body);

        return parsed.customSettingVal === 1 ? "on" : "off";
    }

    /**
     * @returns {Promise<{mode:number,isSilent:number}>}
     */
    async getFanMode() {
        const request = serializeSettingManageRequest({
            manageType: SETTING_MANAGE_TYPE.GET,
            settingType: SETTING_TYPE.FAN_LEVEL
        });
        const body = await this.settingClient.call(request);
        const parsed = parseSettingManageResponse(body);

        return {
            mode: parsed.fanMode,
            isSilent: parsed.fanIsSilent
        };
    }

    /**
     * @returns {Promise<number>}
     */
    async getWaterLevel() {
        const request = serializeSettingManageRequest({
            manageType: SETTING_MANAGE_TYPE.GET,
            settingType: SETTING_TYPE.WATER_LEVEL
        });
        const body = await this.settingClient.call(request);
        const parsed = parseSettingManageResponse(body);

        return parsed.waterLevel;
    }

    /**
     * @returns {Promise<"on"|"off">}
     */
    async getRoomPreferencesEnabled() {
        const request = serializeSettingManageRequest({
            manageType: SETTING_MANAGE_TYPE.GET,
            settingType: SETTING_TYPE.ROOM_PREFERENCES
        });
        const body = await this.settingClient.call(request);
        const parsed = parseSettingManageResponse(body);

        return parsed.roomPreferences === 1 ? "on" : "off";
    }

    /**
     * @returns {Promise<number>}
     */
    async getCleaningTimesPasses() {
        const request = serializeSettingManageRequest({
            manageType: SETTING_MANAGE_TYPE.GET,
            settingType: SETTING_TYPE.CLEANING_TIMES
        });
        const body = await this.settingClient.call(request);
        const parsed = parseSettingManageResponse(body);

        return parsed.cleaningTimes;
    }

    /**
     * @returns {Promise<"on"|"off">}
     */
    async getAutoCollectEnabled() {
        const request = serializeSettingManageRequest({
            manageType: SETTING_MANAGE_TYPE.GET,
            settingType: SETTING_TYPE.AUTO_COLLECT
        });
        const body = await this.settingClient.call(request);
        const parsed = parseSettingManageResponse(body);

        return parsed.autoCollect === 1 ? "on" : "off";
    }

    /**
     * @param {"on"|"off"} value
     * @returns {Promise<number>}
     */
    async setSuctionBoostOnCarpet(value) {
        const request = serializeSettingManageRequest({
            manageType: SETTING_MANAGE_TYPE.SET,
            settingType: SETTING_TYPE.SUCTION_BOOST_ON_CARPET,
            customSettingType: SETTING_TYPE.SUCTION_BOOST_ON_CARPET,
            customSettingVal: value === "on" ? 1 : 0
        });
        const body = await this.settingClient.call(request);
        const parsed = parseSettingManageResponse(body);

        return parsed.response;
    }

    /**
     * @returns {Promise<number>}
     */
    async getFanLevel() {
        const fan = await this.getFanMode();

        return fan.mode;
    }

    /**
     * @param {number} level
     * @returns {Promise<number>}
     */
    async setFanLevel(level) {
        return await this.setFanMode(level, 0);
    }

    /**
     * @param {number} level
     * @param {number} [isSilent]
     * @returns {Promise<number>}
     */
    async setFanMode(level, isSilent = 0) {
        const request = serializeSettingManageRequest({
            manageType: SETTING_MANAGE_TYPE.SET,
            settingType: SETTING_TYPE.FAN_LEVEL,
            fanMode: level,
            fanIsSilent: isSilent
        });
        const body = await this.settingClient.call(request);
        const parsed = parseSettingManageResponse(body);

        return parsed.response;
    }

    /**
     * @param {number} level
     * @returns {Promise<number>}
     */
    async setWaterLevel(level) {
        const request = serializeSettingManageRequest({
            manageType: SETTING_MANAGE_TYPE.SET,
            settingType: SETTING_TYPE.WATER_LEVEL,
            waterLevel: level
        });
        const body = await this.settingClient.call(request);
        const parsed = parseSettingManageResponse(body);

        return parsed.response;
    }

    /**
     * @param {"on"|"off"} value
     * @returns {Promise<number>}
     */
    async setRoomPreferencesEnabled(value) {
        const request = serializeSettingManageRequest({
            manageType: SETTING_MANAGE_TYPE.SET,
            settingType: SETTING_TYPE.ROOM_PREFERENCES,
            roomPreferences: value === "on" ? 1 : 0
        });
        const body = await this.settingClient.call(request);
        const parsed = parseSettingManageResponse(body);

        return parsed.response;
    }

    /**
     * @param {"on"|"off"} value
     * @returns {Promise<number>}
     */
    async setAutoCollectEnabled(value) {
        const request = serializeSettingManageRequest({
            manageType: SETTING_MANAGE_TYPE.SET,
            settingType: SETTING_TYPE.AUTO_COLLECT,
            autoCollect: value === "on" ? 1 : 0
        });
        const body = await this.settingClient.call(request);
        const parsed = parseSettingManageResponse(body);

        return parsed.response;
    }

    /**
     * @param {number} passes
     * @returns {Promise<number>}
     */
    async setCleaningTimesPasses(passes) {
        const request = serializeSettingManageRequest({
            manageType: SETTING_MANAGE_TYPE.SET,
            settingType: SETTING_TYPE.CLEANING_TIMES,
            cleaningTimes: passes
        });
        const body = await this.settingClient.call(request);
        const parsed = parseSettingManageResponse(body);

        return parsed.response;
    }
}

/**
 * @param {object} options
 * @param {number} options.manageType
 * @param {number} options.settingType
 * @param {number} [options.customSettingType]
 * @param {number} [options.customSettingVal]
 * @param {number} [options.waterLevel]
 * @param {number} [options.fanMode]
 * @param {number} [options.fanIsSilent]
 * @param {number} [options.autoCollect]
 * @param {number} [options.roomPreferences]
 * @param {number} [options.cleaningTimes]
 * @returns {Buffer}
 */
function serializeSettingManageRequest(options) {
    const fixed = Buffer.alloc(24, 0);
    fixed.writeUInt8(options.manageType & 0xff, 0);
    fixed.writeUInt8(options.settingType & 0xff, 1);
    fixed.writeUInt8((options.customSettingType ?? 0) & 0xff, 2);
    fixed.writeUInt8((options.customSettingVal ?? 0) & 0xff, 3);
    fixed.writeUInt8((options.waterLevel ?? 0) & 0xff, 20);
    fixed.writeUInt8((options.fanMode ?? 0) & 0xff, 21);
    fixed.writeUInt8((options.fanIsSilent ?? 0) & 0xff, 22);

    const aiSettingVals = Buffer.alloc(5, 0);
    const aiLen = encodeUInt32(aiSettingVals.length);
    const tail = Buffer.alloc(10, 0);
    const padding = Buffer.from([0, 0]); // capture-validated
    const body = Buffer.concat([fixed, aiLen, aiSettingVals, tail, padding]);

    // Tail bytes (capture-validated fixed offsets from end of body):
    //   body.length - 3  →  autoCollect (u8)
    //   body.length - 2  →  roomPreferences (u8)
    //   body.length - 1  →  cleaningTimes (u8)
    if (Number.isInteger(options.autoCollect)) {
        body.writeUInt8(options.autoCollect & 0xff, body.length - 3);
    }
    if (Number.isInteger(options.roomPreferences)) {
        body.writeUInt8(options.roomPreferences & 0xff, body.length - 2);
    }
    if (Number.isInteger(options.cleaningTimes)) {
        body.writeUInt8(options.cleaningTimes & 0xff, body.length - 1);
    }

    return body;
}

/**
 * @param {Buffer} body
 * @returns {{response:number,settingType:number,customSettingVal:number,waterLevel:number,fanMode:number,fanIsSilent:number,autoCollect:number,roomPreferences:number,cleaningTimes:number}}
 */
function parseSettingManageResponse(body) {
    const cursor = new BinaryCursor(body);
    const response = cursor.readUInt8();
    const settingType = cursor.readUInt8();
    const customType = cursor.readUInt8();
    const customSettingVal = cursor.readUInt8();
    cursor.readBuffer(16); // blocktime + mop mode
    const waterLevel = cursor.readUInt8(); // waterLevel.level
    const fanMode = cursor.readUInt8(); // fanMode.mode
    const fanIsSilent = cursor.readUInt8(); // fanMode.isSilent
    cursor.readUInt8(); // aiSetting.isOn
    const aiSettingValsLength = cursor.readUInt32LE();
    cursor.readBuffer(aiSettingValsLength);
    cursor.readBuffer(8); // mop change + notice time
    cursor.readUInt8(); // StructLightOnOff
    const autoCollect = cursor.readUInt8();
    const roomPreferences = cursor.readUInt8();
    const cleaningTimes = cursor.readUInt8();

    return {
        response: response,
        settingType: settingType,
        customType: customType,
        customSettingVal: customSettingVal,
        waterLevel: waterLevel,
        fanMode: fanMode,
        fanIsSilent: fanIsSilent,
        autoCollect: autoCollect,
        roomPreferences: roomPreferences,
        cleaningTimes: cleaningTimes
    };
}

module.exports = EcovacsSettingService;

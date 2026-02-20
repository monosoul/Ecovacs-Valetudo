const fs = require("fs");
const Logger = require("../../Logger");
const {clampInt} = require("./map/EcovacsMapTransforms");

class EcovacsRuntimeStateCache {
    /**
     * @param {object} options
     * @param {string} options.cachePath
     * @param {number} options.writeMinIntervalMs
     */
    constructor(options) {
        this.cachePath = options.cachePath;
        this.writeMinIntervalMs = options.writeMinIntervalMs;
        this.data = this.loadCache();
        this.lastWriteAt = 0;
        this.writeTimer = null;
    }

    /**
     * @returns {{robotPose:{x:number,y:number,angle:number}|null,battery:{level:number,flag:string}|null,chargeState:{isOnCharger:number,chargeState:number}|null}}
     */
    loadCache() {
        try {
            if (!fs.existsSync(this.cachePath)) {
                return {
                    robotPose: null,
                    battery: null,
                    chargeState: null
                };
            }
            const parsed = JSON.parse(fs.readFileSync(this.cachePath, "utf8"));
            const cachedChargeState = parsed?.chargeState;
            const chargeState = (
                cachedChargeState &&
                Number.isFinite(Number(cachedChargeState.isOnCharger)) &&
                Number.isFinite(Number(cachedChargeState.chargeState))
            ) ? {
                    isOnCharger: Number(cachedChargeState.isOnCharger),
                    chargeState: Number(cachedChargeState.chargeState)
                } : null;

            return {
                robotPose: parsed?.robotPose ?? null,
                battery: parsed?.battery ?? null,
                chargeState: chargeState
            };
        } catch (e) {
            Logger.debug(`Failed to read Ecovacs runtime cache: ${e?.message ?? e}`);

            return {
                robotPose: null,
                battery: null,
                chargeState: null
            };
        }
    }

    /**
     * @param {{robotPose?:{x:number,y:number,angle:number},battery?:{level:number,flag:string},chargeState?:{isOnCharger:number,chargeState:number}}} patch
     */
    update(patch) {
        let changed = false;
        if (patch.robotPose) {
            const pose = {
                x: Number(patch.robotPose.x),
                y: Number(patch.robotPose.y),
                angle: Number(patch.robotPose.angle ?? 0)
            };
            if (
                !this.data.robotPose ||
                this.data.robotPose.x !== pose.x ||
                this.data.robotPose.y !== pose.y ||
                this.data.robotPose.angle !== pose.angle
            ) {
                this.data.robotPose = pose;
                changed = true;
            }
        }
        if (patch.battery) {
            const battery = {
                level: clampInt(Number(patch.battery.level), 0, 100),
                flag: String(patch.battery.flag)
            };
            if (
                !this.data.battery ||
                this.data.battery.level !== battery.level ||
                this.data.battery.flag !== battery.flag
            ) {
                this.data.battery = battery;
                changed = true;
            }
        }
        if (patch.chargeState) {
            const chargeState = {
                isOnCharger: Number(patch.chargeState.isOnCharger),
                chargeState: Number(patch.chargeState.chargeState)
            };
            if (
                Number.isFinite(chargeState.isOnCharger) &&
                Number.isFinite(chargeState.chargeState) &&
                (
                    !this.data.chargeState ||
                    this.data.chargeState.isOnCharger !== chargeState.isOnCharger ||
                    this.data.chargeState.chargeState !== chargeState.chargeState
                )
            ) {
                this.data.chargeState = chargeState;
                changed = true;
            }
        }
        if (changed) {
            this.scheduleWrite();
        }
    }

    scheduleWrite() {
        if (this.writeTimer) {
            return;
        }
        const elapsed = Date.now() - this.lastWriteAt;
        const delayMs = Math.max(0, this.writeMinIntervalMs - elapsed);
        this.writeTimer = setTimeout(() => {
            this.writeTimer = null;
            this.flush();
        }, delayMs);
    }

    flush() {
        try {
            fs.writeFileSync(
                this.cachePath,
                JSON.stringify(this.data),
                "utf8"
            );
            this.lastWriteAt = Date.now();
        } catch (e) {
            Logger.debug(`Failed to write Ecovacs runtime cache: ${e?.message ?? e}`);
        }
    }

    shutdown() {
        if (this.writeTimer) {
            clearTimeout(this.writeTimer);
            this.writeTimer = null;
        }
        this.flush();
    }
}

module.exports = EcovacsRuntimeStateCache;

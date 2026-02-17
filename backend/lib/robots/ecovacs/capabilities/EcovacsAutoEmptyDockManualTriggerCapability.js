const AutoEmptyDockManualTriggerCapability = require("../../../core/capabilities/AutoEmptyDockManualTriggerCapability");
const entities = require("../../../entities");

const stateAttrs = entities.state.attributes;
const AUTO_EMPTY_COOLDOWN_MS = 25_000;

/**
 * @extends AutoEmptyDockManualTriggerCapability<import("../EcovacsT8AiviValetudoRobot")>
 */
class EcovacsAutoEmptyDockManualTriggerCapability extends AutoEmptyDockManualTriggerCapability {
    constructor(options) {
        super(options);

        this.cooldownUntil = 0;
        this.cooldownTimer = null;
    }

    /**
     * @returns {Promise<void>}
     */
    async triggerAutoEmpty() {
        if (Date.now() < this.cooldownUntil) {
            const remaining = Math.ceil((this.cooldownUntil - Date.now()) / 1000);
            throw new Error(`autoCollectDirt cooldown active (${remaining}s remaining)`);
        }

        const result = await this.robot.workManageService.autoCollectDirt();
        if (Number(result) !== 0) {
            throw new Error(`autoCollectDirt failed with result=${result}`);
        }

        this.cooldownUntil = Date.now() + AUTO_EMPTY_COOLDOWN_MS;
        this.robot.state.upsertFirstMatchingAttribute(new stateAttrs.DockStatusStateAttribute({
            value: stateAttrs.DockStatusStateAttribute.VALUE.EMPTYING
        }));
        this.robot.emitStateAttributesUpdated();

        if (this.cooldownTimer) {
            clearTimeout(this.cooldownTimer);
        }
        this.cooldownTimer = setTimeout(() => {
            this.cooldownTimer = null;
            this.robot.refreshRuntimeState();
        }, AUTO_EMPTY_COOLDOWN_MS);
    }
}

module.exports = EcovacsAutoEmptyDockManualTriggerCapability;

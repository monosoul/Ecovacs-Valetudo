const AutoEmptyDockManualTriggerCapability = require("../../../core/capabilities/AutoEmptyDockManualTriggerCapability");

/**
 * @extends AutoEmptyDockManualTriggerCapability<import("../EcovacsT8AiviValetudoRobot")>
 */
class EcovacsAutoEmptyDockManualTriggerCapability extends AutoEmptyDockManualTriggerCapability {
    /**
     * @returns {Promise<void>}
     */
    async triggerAutoEmpty() {
        const result = await this.robot.rosFacade.autoCollectDirt();
        if (Number(result) !== 0) {
            throw new Error(`autoCollectDirt failed with result=${result}`);
        }
    }
}

module.exports = EcovacsAutoEmptyDockManualTriggerCapability;

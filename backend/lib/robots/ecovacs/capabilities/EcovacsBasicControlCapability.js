const BasicControlCapability = require("../../../core/capabilities/BasicControlCapability");
const entities = require("../../../entities");

const stateAttrs = entities.state.attributes;

/**
 * @extends BasicControlCapability<import("../EcovacsT8AiviValetudoRobot")>
 */
class EcovacsBasicControlCapability extends BasicControlCapability {
    async start() {
        const currentStatus = this.robot.state.getFirstMatchingAttributeByConstructor(stateAttrs.StatusStateAttribute);
        if (currentStatus?.value === stateAttrs.StatusStateAttribute.VALUE.PAUSED) {
            await this.robot.workManageService.resumeCleaning(this.robot.currentWorkType);
        } else {
            await this.robot.workManageService.startAutoClean();
        }
        this.robot.setStatus(stateAttrs.StatusStateAttribute.VALUE.CLEANING);
    }

    async stop() {
        await this.robot.workManageService.stopCleaning();
        this.robot.setStatus(stateAttrs.StatusStateAttribute.VALUE.IDLE);
    }

    async pause() {
        await this.robot.workManageService.pauseCleaning(this.robot.currentWorkType);
        this.robot.setStatus(stateAttrs.StatusStateAttribute.VALUE.PAUSED);
    }

    async home() {
        await this.robot.workManageService.returnToDock();
        this.robot.setStatus(stateAttrs.StatusStateAttribute.VALUE.RETURNING);
    }
}

module.exports = EcovacsBasicControlCapability;

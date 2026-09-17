const BasicControlCapability = require("../../../core/capabilities/BasicControlCapability");
const entities = require("../../../entities");
const {WORK_STATE} = require("../EcovacsStateMapping");

const stateAttrs = entities.state.attributes;

/**
 * @extends BasicControlCapability<import("../EcovacsT8AiviValetudoRobot")>
 */
class EcovacsBasicControlCapability extends BasicControlCapability {
    async start() {
        // Resume-vs-fresh-start must be decided from the robot's own workState rather
        // than Valetudo's StatusStateAttribute: an alert (e.g. the robot got stuck)
        // can put Valetudo into ERROR while the firmware still considers the job
        // paused and resumable. Falling through to startAutoClean() in that case
        // would discard an in-progress segment/zone job instead of continuing it.
        const workState = this.robot.runtimeStateService.getRuntimeState()?.workState;
        if (workState?.state === WORK_STATE.PAUSED) {
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

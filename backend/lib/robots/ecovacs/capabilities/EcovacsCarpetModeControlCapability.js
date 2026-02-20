const CarpetModeControlCapability = require("../../../core/capabilities/CarpetModeControlCapability");

/**
 * @extends CarpetModeControlCapability<import("../EcovacsT8AiviValetudoRobot")>
 */
class EcovacsCarpetModeControlCapability extends CarpetModeControlCapability {
    async isEnabled() {
        return (await this.robot.settingService.getSuctionBoostOnCarpet()) === "on";
    }

    async enable() {
        await this.robot.settingService.setSuctionBoostOnCarpet("on");
    }

    async disable() {
        await this.robot.settingService.setSuctionBoostOnCarpet("off");
    }
}

module.exports = EcovacsCarpetModeControlCapability;

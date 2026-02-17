const entities = require("../../../entities");
const ValetudoSelectionPreset = require("../../../entities/core/ValetudoSelectionPreset");
const WaterUsageControlCapability = require("../../../core/capabilities/WaterUsageControlCapability");
const stateAttrs = entities.state.attributes;

/**
 * @extends WaterUsageControlCapability<import("../EcovacsT8AiviValetudoRobot")>
 */
class EcovacsWaterUsageControlCapability extends WaterUsageControlCapability {
    constructor(options) {
        super({
            robot: options.robot,
            presets: [
                new ValetudoSelectionPreset({name: stateAttrs.PresetSelectionStateAttribute.INTENSITY.LOW, value: 0}),
                new ValetudoSelectionPreset({name: stateAttrs.PresetSelectionStateAttribute.INTENSITY.MEDIUM, value: 1}),
                new ValetudoSelectionPreset({name: stateAttrs.PresetSelectionStateAttribute.INTENSITY.HIGH, value: 2}),
                new ValetudoSelectionPreset({name: stateAttrs.PresetSelectionStateAttribute.INTENSITY.MAX, value: 3})
            ]
        });
    }

    /**
     * @param {string} preset
     * @returns {Promise<void>}
     */
    async selectPreset(preset) {
        const matchedPreset = this.presets.find(p => {
            return p.name === preset;
        });
        if (!matchedPreset) {
            throw new Error("Invalid preset");
        }

        const result = await this.robot.settingService.setWaterLevel(Number(matchedPreset.value));
        if (Number(result) !== 0) {
            throw new Error(`setWaterLevel failed with result=${result}`);
        }

        this.robot.state.upsertFirstMatchingAttribute(new stateAttrs.PresetSelectionStateAttribute({
            type: stateAttrs.PresetSelectionStateAttribute.TYPE.WATER_GRADE,
            value: matchedPreset.name
        }));
        this.robot.emitStateAttributesUpdated();
    }
}

module.exports = EcovacsWaterUsageControlCapability;

const entities = require("../../../entities");
const FanSpeedControlCapability = require("../../../core/capabilities/FanSpeedControlCapability");
const ValetudoSelectionPreset = require("../../../entities/core/ValetudoSelectionPreset");
const stateAttrs = entities.state.attributes;

/**
 * @extends FanSpeedControlCapability<import("../EcovacsT8AiviValetudoRobot")>
 */
class EcovacsFanSpeedControlCapability extends FanSpeedControlCapability {
    constructor(options) {
        super({
            robot: options.robot,
            presets: [
                new ValetudoSelectionPreset({name: stateAttrs.PresetSelectionStateAttribute.INTENSITY.OFF, value: 3}),
                new ValetudoSelectionPreset({name: stateAttrs.PresetSelectionStateAttribute.INTENSITY.LOW, value: 0}),
                new ValetudoSelectionPreset({name: stateAttrs.PresetSelectionStateAttribute.INTENSITY.HIGH, value: 1}),
                new ValetudoSelectionPreset({name: stateAttrs.PresetSelectionStateAttribute.INTENSITY.MAX, value: 2})
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

        const target = fanPresetToFirmware(matchedPreset.name);
        const result = await this.robot.rosFacade.setFanMode(target.mode, target.isSilent);
        if (Number(result) !== 0) {
            throw new Error(`setFanMode failed with result=${result}`);
        }

        this.robot.state.upsertFirstMatchingAttribute(new stateAttrs.PresetSelectionStateAttribute({
            type: stateAttrs.PresetSelectionStateAttribute.TYPE.FAN_SPEED,
            value: matchedPreset.name
        }));
        this.robot.emitStateAttributesUpdated();
    }
}

/**
 * @param {string} preset
 * @returns {{mode:number,isSilent:number}}
 */
function fanPresetToFirmware(preset) {
    switch (preset) {
        case stateAttrs.PresetSelectionStateAttribute.INTENSITY.LOW:
            return {mode: 0, isSilent: 0};
        case stateAttrs.PresetSelectionStateAttribute.INTENSITY.HIGH:
            return {mode: 1, isSilent: 0};
        case stateAttrs.PresetSelectionStateAttribute.INTENSITY.MAX:
            return {mode: 2, isSilent: 0};
        case stateAttrs.PresetSelectionStateAttribute.INTENSITY.OFF:
            return {mode: 2, isSilent: 1}; // capture-validated quiet mode
        default:
            throw new Error(`Unsupported fan preset: ${preset}`);
    }
}

module.exports = EcovacsFanSpeedControlCapability;

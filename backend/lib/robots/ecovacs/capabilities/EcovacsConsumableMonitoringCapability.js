const ConsumableMonitoringCapability = require("../../../core/capabilities/ConsumableMonitoringCapability");
const ValetudoConsumable = require("../../../entities/core/ValetudoConsumable");
const {LIFESPAN_PART} = require("../ros/services/EcovacsRosFacade");

/**
 * @extends ConsumableMonitoringCapability<import("../EcovacsT8AiviValetudoRobot")>
 */
class EcovacsConsumableMonitoringCapability extends ConsumableMonitoringCapability {
    async getConsumables() {
        const [mainBrush, sideBrush, hepa, allComponents] = await Promise.all([
            this.robot.rosFacade.getLifespan(LIFESPAN_PART.MAIN_BRUSH),
            this.robot.rosFacade.getLifespan(LIFESPAN_PART.SIDE_BRUSH),
            this.robot.rosFacade.getLifespan(LIFESPAN_PART.HEPA),
            this.robot.rosFacade.getLifespan(LIFESPAN_PART.ALL)
        ]);

        const consumables = [
            mapLifespanToConsumable(
                mainBrush,
                ValetudoConsumable.TYPE.BRUSH,
                ValetudoConsumable.SUB_TYPE.MAIN
            ),
            mapLifespanToConsumable(
                sideBrush,
                ValetudoConsumable.TYPE.BRUSH,
                ValetudoConsumable.SUB_TYPE.SECONDARY
            ),
            mapLifespanToConsumable(
                hepa,
                ValetudoConsumable.TYPE.FILTER,
                ValetudoConsumable.SUB_TYPE.MAIN
            ),
            mapLifespanToConsumable(
                allComponents,
                ValetudoConsumable.TYPE.CLEANING,
                ValetudoConsumable.SUB_TYPE.ALL
            )
        ];

        this.raiseEventIfRequired(consumables);

        return consumables;
    }

    /**
     * @param {string} type
     * @param {string} [subType]
     * @returns {Promise<void>}
     */
    async resetConsumable(type, subType) {
        const part = toLifespanPart(type, subType);
        const response = await this.robot.rosFacade.resetLifespan(part);
        if (Number(response?.result) !== 0) {
            throw new Error(`resetLifespan failed with result=${response?.result}`);
        }
        this.markEventsAsProcessed(type, subType);
    }

    getProperties() {
        return {
            availableConsumables: [
                {
                    type: ValetudoConsumable.TYPE.BRUSH,
                    subType: ValetudoConsumable.SUB_TYPE.MAIN,
                    unit: ValetudoConsumable.UNITS.PERCENT
                },
                {
                    type: ValetudoConsumable.TYPE.BRUSH,
                    subType: ValetudoConsumable.SUB_TYPE.SECONDARY,
                    unit: ValetudoConsumable.UNITS.PERCENT
                },
                {
                    type: ValetudoConsumable.TYPE.FILTER,
                    subType: ValetudoConsumable.SUB_TYPE.MAIN,
                    unit: ValetudoConsumable.UNITS.PERCENT
                },
                {
                    type: ValetudoConsumable.TYPE.CLEANING,
                    subType: ValetudoConsumable.SUB_TYPE.ALL,
                    unit: ValetudoConsumable.UNITS.PERCENT
                }
            ]
        };
    }
}

/**
 * @param {{result:number,life:Array<number>,total:Array<number>}} response
 * @param {string} type
 * @param {string} subType
 * @returns {import("../../../entities/core/ValetudoConsumable")}
 */
function mapLifespanToConsumable(response, type, subType) {
    const life = Number(response?.life?.[0] ?? 0);
    const total = Number(response?.total?.[0] ?? 0);
    const remaining = total > 0 ? Math.round(Math.max(0, (life * 100) / total)) : 0;

    return new ValetudoConsumable({
        type: type,
        subType: subType,
        remaining: {
            value: remaining,
            unit: ValetudoConsumable.UNITS.PERCENT
        }
    });
}

/**
 * @param {string} type
 * @param {string} [subType]
 * @returns {number}
 */
function toLifespanPart(type, subType) {
    if (type === ValetudoConsumable.TYPE.BRUSH) {
        if (subType === ValetudoConsumable.SUB_TYPE.MAIN) {
            return LIFESPAN_PART.MAIN_BRUSH;
        }
        if (subType === ValetudoConsumable.SUB_TYPE.SECONDARY || subType === ValetudoConsumable.SUB_TYPE.SIDE_RIGHT) {
            return LIFESPAN_PART.SIDE_BRUSH;
        }
    }
    if (type === ValetudoConsumable.TYPE.FILTER && subType === ValetudoConsumable.SUB_TYPE.MAIN) {
        return LIFESPAN_PART.HEPA;
    }
    if (type === ValetudoConsumable.TYPE.CLEANING && subType === ValetudoConsumable.SUB_TYPE.ALL) {
        return LIFESPAN_PART.ALL;
    }

    throw new Error("No such consumable");
}

module.exports = EcovacsConsumableMonitoringCapability;

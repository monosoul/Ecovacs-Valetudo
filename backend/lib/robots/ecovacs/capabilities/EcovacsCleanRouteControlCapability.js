const CleanRouteControlCapability = require("../../../core/capabilities/CleanRouteControlCapability");

/**
 * @extends CleanRouteControlCapability<import("../EcovacsT8AiviValetudoRobot")>
 */
class EcovacsCleanRouteControlCapability extends CleanRouteControlCapability {
    /**
     * @returns {Promise<import("../../../core/capabilities/CleanRouteControlCapability").CleanRouteControlCapabilityRoute>}
     */
    async getRoute() {
        const passes = Number(await this.robot.settingService.getCleaningTimesPasses());

        return passes >= 2 ?
            CleanRouteControlCapability.ROUTE.DEEP :
            CleanRouteControlCapability.ROUTE.NORMAL;
    }

    /**
     * @param {import("../../../core/capabilities/CleanRouteControlCapability").CleanRouteControlCapabilityRoute} newRoute
     * @returns {Promise<void>}
     */
    async setRoute(newRoute) {
        const passes = routeToPasses(newRoute);
        const result = await this.robot.settingService.setCleaningTimesPasses(passes);
        if (Number(result) !== 0) {
            throw new Error(`setCleaningTimesPasses failed with result=${result}`);
        }
    }

    /**
     * @returns {{supportedRoutes:Array<string>,mopOnly:Array<string>,oneTime:Array<string>}}
     */
    getProperties() {
        return {
            supportedRoutes: [
                CleanRouteControlCapability.ROUTE.NORMAL,
                CleanRouteControlCapability.ROUTE.DEEP
            ],
            mopOnly: [],
            oneTime: []
        };
    }
}

/**
 * @param {string} route
 * @returns {number}
 */
function routeToPasses(route) {
    if (route === CleanRouteControlCapability.ROUTE.NORMAL) {
        return 1;
    }
    if (route === CleanRouteControlCapability.ROUTE.DEEP) {
        return 2;
    }

    throw new Error(`Unsupported clean route for Ecovacs: ${route}`);
}

module.exports = EcovacsCleanRouteControlCapability;

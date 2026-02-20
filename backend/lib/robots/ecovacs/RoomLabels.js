"use strict";

const ROOM_LABEL_NAMES_BY_ID = Object.freeze({
    1: "living_room",
    2: "dining_room",
    3: "bedroom",
    4: "study",
    5: "kitchen",
    6: "bathroom",
    7: "laundry",
    8: "lounge",
    9: "storeroom",
    10: "kids_room",
    11: "sunroom",
    12: "corridor",
    13: "balcony",
    14: "gym"
});

const ROOM_LABEL_IDS_BY_NAME = Object.freeze(Object.fromEntries(
    Object.entries(ROOM_LABEL_NAMES_BY_ID).map(([id, name]) => [name, Number(id)])
));

/**
 * @param {number} labelId
 * @returns {string}
 */
function labelNameFromId(labelId) {
    return ROOM_LABEL_NAMES_BY_ID[labelId] ?? `label_${labelId}`;
}

/**
 * @param {string} value
 * @returns {number}
 */
function labelIdFromName(value) {
    const raw = String(value ?? "").trim();
    if (!raw) {
        throw new Error("Room label must not be empty");
    }

    const normalized = raw.toLowerCase().replace(/[-\s]+/g, "_");
    if (Object.prototype.hasOwnProperty.call(ROOM_LABEL_IDS_BY_NAME, normalized)) {
        return ROOM_LABEL_IDS_BY_NAME[normalized];
    }

    const numeric = Number.parseInt(raw, 10);
    if (Number.isInteger(numeric) && Object.prototype.hasOwnProperty.call(ROOM_LABEL_NAMES_BY_ID, String(numeric))) {
        return numeric;
    }

    throw new Error(
        `Unsupported room label "${raw}". Use one of: ${Object.keys(ROOM_LABEL_IDS_BY_NAME).join(", ")}, or numeric id 1-14.`
    );
}

module.exports = {
    ROOM_LABEL_NAMES_BY_ID: ROOM_LABEL_NAMES_BY_ID,
    ROOM_LABEL_IDS_BY_NAME: ROOM_LABEL_IDS_BY_NAME,
    labelNameFromId: labelNameFromId,
    labelIdFromName: labelIdFromName
};

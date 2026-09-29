const dotenv = require("dotenv");
const EasyPost = require("@easypost/api");

const api = new EasyPost(process.env.EASYPOST_API_KEY);

// Helper: Format location
const formatLocation = (location) => {
    if (!location) return "Unknown Location";
    const { city, state, country } = location;
    return [city, state, country].filter(Boolean).join(", ");
};

const getTrackingStatus = async (order) => {
    const fulfillment = order?.fulfillments?.[0];
    const trackingNumber = fulfillment?.tracking_number;
    const carrier = fulfillment?.tracking_company;

    if (!trackingNumber) {
        return {
            status: "Pending",
            message: "No tracking information available for this order.",
            events: [],
        };
    }

    return {
        trackingNumber,
        carrier,
        status: "Fulfilled",
        message: "Tracking is available via the carrier using the tracking number.",
        events: [],
    };
};

module.exports = { getTrackingStatus };
